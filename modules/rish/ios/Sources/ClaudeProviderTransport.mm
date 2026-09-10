#import "ClaudeProviderTransport.h"

#import "DSHCompletionV2.h"
#import "RishHarnessCatalog.h"

// Anthropic Messages API dialect for the Claude Code Harness.
//
// Mapping table (see the openpencil-docs record for the full matrix):
//   thinking mode -> per-model thinking config
//     claude-haiku-4-5-*   : enabled + budget_tokens (pre-4.6 API); omitted
//                            on tool-continuation rounds because unsigned
//                            thinking blocks cannot be replayed
//     claude-sonnet-5/opus-5: off -> {type: disabled}; high/max -> adaptive +
//                            display summarized + output_config.effort
//     claude-fable-5-1     : thinking cannot be disabled; off -> default
//                            (omitted display) + effort low
//   transcript -> blocks: assistant text/tool_use, tool -> user tool_result
//                 (consecutive tool results merge into one user message);
//                 reasoning text is presentation-only and never replayed
//   stop_reason -> finish_reason: end_turn/stop_sequence/pause_turn -> stop,
//                 tool_use -> tool_calls, max_tokens -> length,
//                 refusal -> content_filter

static NSString * const ClaudeTransportErrorDomain = @"ClaudeTransportError";
static NSString * const ClaudeAnthropicVersion = @"2023-06-01";
static NSInteger const ClaudeStreamMaxLineBytes = 262144;
static NSInteger const ClaudeStreamMaxBufferedLines = 64;
static NSInteger const ClaudeMaxTokensPlain = 8192;
static NSInteger const ClaudeMaxTokensThinking = 16384;
static NSInteger const ClaudeHaikuBudgetHigh = 4096;
static NSInteger const ClaudeHaikuBudgetMax = 16000;

static NSError *ClaudeTransportError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:ClaudeTransportErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *ClaudeString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static NSArray *ClaudeArray(id value) {
  return [value isKindOfClass:NSArray.class] ? value : nil;
}

static NSDictionary *ClaudeDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

typedef NS_ENUM(NSInteger, ClaudeThinkingFamily) {
  ClaudeThinkingFamilyBudget,        // Haiku 4.5 and GLM: enabled + budget_tokens
  ClaudeThinkingFamilyAdaptive,      // Sonnet 5 / Opus 5: adaptive, may disable
  ClaudeThinkingFamilyAlwaysOn,      // Fable 5.1: adaptive, cannot disable
};

static ClaudeThinkingFamily ClaudeFamilyForModel(NSString *model) {
  if ([model hasPrefix:@"claude-haiku-4-5"]) return ClaudeThinkingFamilyBudget;
  // GLM over the Anthropic-compatible endpoint takes the classic
  // enabled + budget_tokens form and nothing when thinking is off; the
  // adaptive / output_config vocabulary is Anthropic-only.
  if ([model hasPrefix:@"GLM-"]) return ClaudeThinkingFamilyBudget;
  if ([model hasPrefix:@"claude-fable-"]) return ClaudeThinkingFamilyAlwaysOn;
  return ClaudeThinkingFamilyAdaptive;
}

/// Maps an Anthropic stop_reason to the closed canonical finish vocabulary.
static NSString *ClaudeFinishReasonForStopReason(NSString *stopReason) {
  if ([stopReason isEqualToString:@"end_turn"]) return @"stop";
  if ([stopReason isEqualToString:@"stop_sequence"]) return @"stop";
  if ([stopReason isEqualToString:@"pause_turn"]) return @"stop";
  if ([stopReason isEqualToString:@"tool_use"]) return @"tool_calls";
  if ([stopReason isEqualToString:@"max_tokens"]) return @"length";
  if ([stopReason isEqualToString:@"refusal"]) return @"content_filter";
  return nil;
}

/// Converts one DSH-shaped transcript/tool message into Anthropic blocks.
/// Tool results append to an open tool_result user message so every
/// tool_use of one assistant turn is answered in a single user turn.
static BOOL ClaudeAppendMessage(NSMutableArray *converted,
                                NSDictionary *message,
                                NSError **error) {
  NSString *role = ClaudeString(message[@"role"]);
  if ([role isEqualToString:@"assistant"]) {
    NSMutableArray *blocks = [NSMutableArray array];
    NSString *content = ClaudeString(message[@"content"]) ?: @"";
    if (content.length > 0) {
      [blocks addObject:@{@"type": @"text", @"text": content}];
    }
    NSArray *calls = ClaudeArray(message[@"tool_calls"]) ?: @[];
    for (id rawCall in calls) {
      NSDictionary *call = ClaudeDictionary(rawCall);
      NSDictionary *function = ClaudeDictionary(call[@"function"]);
      NSString *callId = ClaudeString(call[@"id"]);
      NSString *name = ClaudeString(function[@"name"]);
      NSString *arguments = ClaudeString(function[@"arguments"]);
      if (callId == nil || name == nil || arguments == nil) {
        if (error != nil) {
          *error = ClaudeTransportError(2202, @"E_COMPLETION_TRANSCRIPT");
        }
        return NO;
      }
      id input = [NSJSONSerialization JSONObjectWithData:
          [arguments dataUsingEncoding:NSUTF8StringEncoding]
          options:0 error:nil];
      if (![input isKindOfClass:NSDictionary.class]) {
        if (error != nil) {
          *error = ClaudeTransportError(2203, @"E_COMPLETION_TRANSCRIPT");
        }
        return NO;
      }
      [blocks addObject:@{
        @"type": @"tool_use", @"id": callId, @"name": name, @"input": input,
      }];
    }
    if (blocks.count == 0) {
      // An assistant turn that only carried reasoning still occupies its
      // slot in the alternation; Anthropic rejects an empty content array.
      [blocks addObject:@{@"type": @"text", @"text": @"(no visible output)"}];
    }
    [converted addObject:@{@"role": @"assistant", @"content": [blocks copy]}];
    return YES;
  }
  if ([role isEqualToString:@"tool"]) {
    NSString *toolCallId = ClaudeString(message[@"tool_call_id"]);
    NSString *content = ClaudeString(message[@"content"]) ?: @"";
    if (toolCallId == nil) {
      if (error != nil) {
        *error = ClaudeTransportError(2204, @"E_COMPLETION_TRANSCRIPT");
      }
      return NO;
    }
    NSDictionary *block = @{@"type": @"tool_result",
                            @"tool_use_id": toolCallId,
                            @"content": content};
    NSDictionary *previous = converted.lastObject;
    NSArray *previousBlocks = ClaudeArray(previous[@"content"]);
    if ([ClaudeString(previous[@"role"]) isEqualToString:@"user"] &&
        [ClaudeString(ClaudeDictionary(previousBlocks.firstObject)[@"type"])
            isEqualToString:@"tool_result"]) {
      [converted removeLastObject];
      [converted addObject:@{
        @"role": @"user",
        @"content": [previousBlocks arrayByAddingObject:block],
      }];
    } else {
      [converted addObject:@{@"role": @"user", @"content": @[block]}];
    }
    return YES;
  }
  if ([role isEqualToString:@"user"]) {
    [converted addObject:@{
      @"role": @"user",
      @"content": @[ @{@"type": @"text",
                       @"text": ClaudeString(message[@"content"]) ?: @""} ],
    }];
    return YES;
  }
  if (error != nil) {
    *error = ClaudeTransportError(2205, @"E_COMPLETION_TRANSCRIPT");
  }
  return NO;
}

static BOOL ClaudeLastAssistantUsesTools(NSArray *converted) {
  for (NSDictionary *message in converted.reverseObjectEnumerator) {
    if (![ClaudeString(message[@"role"]) isEqualToString:@"assistant"]) continue;
    for (NSDictionary *block in ClaudeArray(message[@"content"])) {
      if ([ClaudeString(block[@"type"]) isEqualToString:@"tool_use"]) return YES;
    }
    return NO;
  }
  return NO;
}

static NSDictionary<NSString *, id> * _Nullable ClaudeDecodeEvent(
    NSString *eventName, NSArray<NSString *> *dataLines, NSError **error) {
  if (dataLines.count == 0) return nil;
  NSString *data = [dataLines componentsJoinedByString:@"\n"];
  if ([data isEqualToString:@"[DONE]"]) return @{@"type": @"done"};
  if ([[data stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet] length] == 0) {
    return nil;
  }
  NSData *json = [data dataUsingEncoding:NSUTF8StringEncoding];
  if (json == nil) {
    if (error != nil) {
      *error = ClaudeTransportError(2301, @"SSE event is not valid UTF-8");
    }
    return nil;
  }
  NSDictionary *chunk = ClaudeDictionary(
      [NSJSONSerialization JSONObjectWithData:json options:0 error:nil]);
  if (chunk == nil) {
    if (error != nil) {
      *error = ClaudeTransportError(2302, @"SSE event is not a JSON object");
    }
    return nil;
  }
  // The SSE `event:` name and the payload `type` agree on the wire; the
  // payload is authoritative so a missing event line cannot hide an error.
  NSString *kind = ClaudeString(chunk[@"type"]) ?: eventName;
  if ([kind isEqualToString:@"error"]) {
    if (error != nil) {
      NSString *reason = ClaudeString(ClaudeDictionary(chunk[@"error"])[@"type"]) ?:
          @"stream_error";
      *error = ClaudeTransportError(2303,
          [@"Anthropic stream error: " stringByAppendingString:reason]);
    }
    return nil;
  }
  if ([kind isEqualToString:@"content_block_delta"]) {
    NSDictionary *delta = ClaudeDictionary(chunk[@"delta"]);
    NSString *deltaKind = ClaudeString(delta[@"type"]);
    if ([deltaKind isEqualToString:@"text_delta"]) {
      NSString *text = ClaudeString(delta[@"text"]);
      return text.length > 0 ? @{@"type": @"delta", @"content": text} : nil;
    }
    if ([deltaKind isEqualToString:@"thinking_delta"]) {
      NSString *thinking = ClaudeString(delta[@"thinking"]);
      return thinking.length > 0
          ? @{@"type": @"delta", @"reasoning": thinking} : nil;
    }
    // input_json_delta and signature_delta never enter the delta vocabulary:
    // tool arguments are assembled from the non-streaming round result.
    return nil;
  }
  if ([kind isEqualToString:@"message_delta"]) {
    NSString *stopReason = ClaudeString(ClaudeDictionary(chunk[@"delta"])[@"stop_reason"]);
    if (stopReason == nil) return nil;
    NSString *finish = ClaudeFinishReasonForStopReason(stopReason);
    if (finish == nil) {
      if (error != nil) {
        *error = ClaudeTransportError(2307, @"Unknown Anthropic stop_reason");
      }
      return nil;
    }
    return @{@"type": @"delta", @"finish_reason": finish};
  }
  if ([kind isEqualToString:@"message_stop"]) {
    return @{@"type": @"done"};
  }
  // message_start, content_block_start/stop, ping: no delta.
  return nil;
}

@implementation ClaudeStreamEventParser {
  NSMutableData *_pending;
  NSMutableArray<NSString *> *_dataLines;
  NSString *_eventName;
  BOOL _finished;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _pending = [NSMutableData data];
    _dataLines = [NSMutableArray array];
    _eventName = nil;
  }
  return self;
}

- (void)reset {
  _pending = [NSMutableData data];
  [_dataLines removeAllObjects];
  _eventName = nil;
  _finished = NO;
}

- (NSArray<NSDictionary<NSString *, id> *> *)appendBytes:(const uint8_t *)bytes
                                                      length:(NSUInteger)length
                                                        error:(NSError **)error {
  if (_finished) {
    if (error != nil) {
      *error = ClaudeTransportError(2304, @"Stream already finished");
    }
    return nil;
  }
  if (length == 0) return @[];
  [_pending appendBytes:bytes length:length];
  NSMutableArray<NSDictionary<NSString *, id> *> *deltas = [NSMutableArray array];
  while (YES) {
    const void *base = _pending.bytes;
    NSUInteger total = _pending.length;
    const uint8_t *nl = static_cast<const uint8_t *>(memchr(base, '\n', total));
    if (nl == nullptr) {
      if (total > (NSUInteger)ClaudeStreamMaxLineBytes) {
        if (error != nil) {
          *error = ClaudeTransportError(2305, @"SSE line exceeds the size limit");
        }
        return nil;
      }
      break;
    }
    NSUInteger lineLength = static_cast<NSUInteger>(
        reinterpret_cast<const uint8_t *>(nl) - static_cast<const uint8_t *>(base));
    if (lineLength > (NSUInteger)ClaudeStreamMaxLineBytes) {
      if (error != nil) {
        *error = ClaudeTransportError(2305, @"SSE line exceeds the size limit");
      }
      return nil;
    }
    NSData *lineData = [NSData dataWithBytes:base length:lineLength];
    NSString *line = [[NSString alloc] initWithData:lineData
                                           encoding:NSUTF8StringEncoding];
    if (line == nil) {
      if (error != nil) {
        *error = ClaudeTransportError(2301, @"SSE line is not valid UTF-8");
      }
      return nil;
    }
    if ([line hasSuffix:@"\r"]) {
      line = [line substringToIndex:line.length - 1];
    }
    [_pending replaceBytesInRange:NSMakeRange(0, lineLength + 1)
                        withBytes:nullptr length:0];
    if (line.length == 0) {
      if (_dataLines.count > 0) {
        if (_dataLines.count > (NSUInteger)ClaudeStreamMaxBufferedLines) {
          if (error != nil) {
            *error = ClaudeTransportError(2306, @"SSE event has too many lines");
          }
          return nil;
        }
        NSDictionary<NSString *, id> *delta = ClaudeDecodeEvent(
            _eventName, _dataLines, error);
        [_dataLines removeAllObjects];
        _eventName = nil;
        if (delta != nil) [deltas addObject:delta];
        else if (error != nil && *error != nil) return nil;
      }
      continue;
    }
    if ([line hasPrefix:@":"]) continue;
    if ([line hasPrefix:@"event:"]) {
      NSString *name = [line substringFromIndex:6];
      if ([name hasPrefix:@" "]) name = [name substringFromIndex:1];
      _eventName = [name copy];
      continue;
    }
    if ([line hasPrefix:@"data:"]) {
      if (_dataLines.count >= (NSUInteger)ClaudeStreamMaxBufferedLines) {
        if (error != nil) {
          *error = ClaudeTransportError(2306, @"SSE event has too many lines");
        }
        return nil;
      }
      NSString *payload = [line substringFromIndex:5];
      if ([payload hasPrefix:@" "]) payload = [payload substringFromIndex:1];
      [_dataLines addObject:payload];
    }
  }
  return deltas.count > 0 ? deltas : @[];
}

- (NSArray<NSDictionary<NSString *, id> *> *)finish:(NSError **)error {
  if (_finished) {
    if (error != nil) {
      *error = ClaudeTransportError(2304, @"Stream already finished");
    }
    return nil;
  }
  _finished = YES;
  NSMutableArray<NSDictionary<NSString *, id> *> *deltas = [NSMutableArray array];
  if (_pending.length > 0) {
    NSString *line = [[NSString alloc] initWithData:_pending
                                           encoding:NSUTF8StringEncoding];
    if (line == nil) {
      if (error != nil) {
        *error = ClaudeTransportError(2301, @"SSE trailing bytes are not valid UTF-8");
      }
      return nil;
    }
    if ([line hasSuffix:@"\r"]) line = [line substringToIndex:line.length - 1];
    if ([line hasPrefix:@"data:"]) {
      NSString *payload = [line substringFromIndex:5];
      if ([payload hasPrefix:@" "]) payload = [payload substringFromIndex:1];
      [_dataLines addObject:payload];
    }
    _pending = [NSMutableData data];
  }
  if (_dataLines.count > 0) {
    NSDictionary<NSString *, id> *delta = ClaudeDecodeEvent(
        _eventName, _dataLines, error);
    [_dataLines removeAllObjects];
    if (delta != nil) [deltas addObject:delta];
    else if (error != nil && *error != nil) return nil;
  }
  return deltas;
}

@end

@implementation ClaudeProviderTransport

- (BOOL)providerReportedModel:(NSString *)reportedModel
        matchesRequestedModel:(NSString *)requestedModel {
  if (reportedModel == nil) return YES;
  return [reportedModel isEqualToString:requestedModel] ||
      [reportedModel hasPrefix:[requestedModel stringByAppendingString:@"-"]];
}

- (NSURL *)providerBaseURL {
  return [NSURL URLWithString:@"https://api.anthropic.com/v1/messages"];
}

- (NSDictionary<NSString *, NSString *> *)providerHeadersWithCredential:(NSString *)credential {
  return @{
    @"Content-Type": @"application/json",
    @"x-api-key": credential,
    @"anthropic-version": ClaudeAnthropicVersion,
  };
}

- (NSDictionary<NSString *, id> *)providerRequestBodyForModel:(NSString *)model
                                                 thinkingMode:(NSString *)thinkingMode
                                                     messages:(NSArray<NSDictionary<NSString *, id> *> *)messages
                                                        tools:(NSArray<NSDictionary<NSString *, id> *> *)tools
                                                    streaming:(BOOL)streaming
                                                        error:(NSError **)error {
  if (error != nil) *error = nil;
  if (![self providerSupportsModel:model]) {
    if (error != nil) *error = ClaudeTransportError(2201, @"E_COMPLETION_MODEL");
    return nil;
  }
  NSMutableArray *systemBlocks = [NSMutableArray array];
  NSMutableArray *converted = [NSMutableArray array];
  for (NSDictionary *message in messages) {
    NSString *role = ClaudeString(message[@"role"]);
    if ([role isEqualToString:@"system"]) {
      NSString *text = ClaudeString(message[@"content"]) ?: @"";
      if (text.length > 0) {
        [systemBlocks addObject:@{@"type": @"text", @"text": text}];
      }
      continue;
    }
    if (!ClaudeAppendMessage(converted, message, error)) return nil;
  }
  NSMutableArray *claudeTools = [NSMutableArray array];
  for (id rawTool in tools) {
    NSDictionary *tool = ClaudeDictionary(rawTool);
    NSDictionary *function = ClaudeDictionary(tool[@"function"]);
    NSString *name = ClaudeString(function[@"name"]);
    NSString *description = ClaudeString(function[@"description"]);
    NSDictionary *parameters = ClaudeDictionary(function[@"parameters"]);
    if (name == nil || parameters == nil) {
      if (error != nil) *error = ClaudeTransportError(2210, @"E_COMPLETION_TOOLS");
      return nil;
    }
    NSMutableDictionary *entry = [@{@"name": name, @"input_schema": parameters}
        mutableCopy];
    if (description != nil) entry[@"description"] = description;
    [claudeTools addObject:[entry copy]];
  }
  BOOL thinking = ![thinkingMode isEqualToString:@"off"];
  BOOL maximal = [thinkingMode isEqualToString:@"max"];
  NSString *effort = maximal ? @"max" : @"high";
  NSInteger maxTokens = ClaudeMaxTokensPlain;
  NSMutableDictionary *body = [@{
    @"model": model,
    @"stream": @(streaming),
    @"messages": [converted copy],
  } mutableCopy];
  switch (ClaudeFamilyForModel(model)) {
    case ClaudeThinkingFamilyBudget: {
      // Continuation rounds replay tool_use turns whose thinking blocks
      // (and signatures) are not in the closed transcript; the budget API
      // rejects such a turn with thinking enabled, so it runs unthinking.
      if (thinking && !ClaudeLastAssistantUsesTools(converted)) {
        NSInteger budget = maximal ? ClaudeHaikuBudgetMax : ClaudeHaikuBudgetHigh;
        body[@"thinking"] = @{@"type": @"enabled", @"budget_tokens": @(budget)};
        maxTokens = budget + ClaudeMaxTokensPlain;
      }
      break;
    }
    case ClaudeThinkingFamilyAdaptive: {
      if (thinking) {
        body[@"thinking"] = @{@"type": @"adaptive", @"display": @"summarized"};
        body[@"output_config"] = @{@"effort": effort};
        maxTokens = ClaudeMaxTokensThinking;
      } else {
        body[@"thinking"] = @{@"type": @"disabled"};
      }
      break;
    }
    case ClaudeThinkingFamilyAlwaysOn: {
      if (thinking) {
        body[@"thinking"] = @{@"type": @"adaptive", @"display": @"summarized"};
        body[@"output_config"] = @{@"effort": effort};
        maxTokens = ClaudeMaxTokensThinking;
      } else {
        // Thinking cannot be disabled on this family; the default omitted
        // display keeps the reasoning presentation empty and low effort
        // keeps the round short.
        body[@"output_config"] = @{@"effort": @"low"};
      }
      break;
    }
  }
  body[@"max_tokens"] = @(maxTokens);
  if (systemBlocks.count > 0) body[@"system"] = [systemBlocks copy];
  if (claudeTools.count > 0) body[@"tools"] = [claudeTools copy];
  return [body copy];
}

- (NSDictionary<NSString *, id> *)providerParseResponseData:(NSData *)data
                                              requestedModel:(NSString *)requestedModel
                                                thinkingMode:(NSString *)thinkingMode
                                                      error:(NSError **)error {
  if (error != nil) *error = nil;
  NSDictionary *decoded = ClaudeDictionary([NSJSONSerialization
      JSONObjectWithData:data options:0 error:nil]);
  if (decoded == nil || [ClaudeString(decoded[@"type"]) isEqualToString:@"error"]) {
    if (error != nil) *error = ClaudeTransportError(2401, @"E_COMPLETION_RESPONSE_JSON");
    return nil;
  }
  NSString *responseId = ClaudeString(decoded[@"id"]);
  if (responseId.length == 0) {
    if (error != nil) *error = ClaudeTransportError(2403, @"E_COMPLETION_PROVIDER_RESPONSE_ID");
    return nil;
  }
  if (![self providerReportedModel:ClaudeString(decoded[@"model"])
            matchesRequestedModel:requestedModel]) {
    if (error != nil) *error = ClaudeTransportError(2404, @"E_COMPLETION_MODEL_MISMATCH");
    return nil;
  }
  NSMutableString *text = [NSMutableString string];
  NSMutableString *reasoning = [NSMutableString string];
  NSMutableArray *toolCalls = [NSMutableArray array];
  for (id rawBlock in ClaudeArray(decoded[@"content"]) ?: @[]) {
    NSDictionary *block = ClaudeDictionary(rawBlock);
    NSString *kind = ClaudeString(block[@"type"]);
    if ([kind isEqualToString:@"text"]) {
      [text appendString:ClaudeString(block[@"text"]) ?: @""];
    } else if ([kind isEqualToString:@"thinking"]) {
      [reasoning appendString:ClaudeString(block[@"thinking"]) ?: @""];
    } else if ([kind isEqualToString:@"tool_use"]) {
      NSString *callId = ClaudeString(block[@"id"]);
      NSString *name = ClaudeString(block[@"name"]);
      NSDictionary *input = ClaudeDictionary(block[@"input"]);
      NSData *arguments = input == nil ? nil :
          [NSJSONSerialization dataWithJSONObject:input options:0 error:nil];
      if (callId == nil || name == nil || arguments == nil) {
        if (error != nil) *error = ClaudeTransportError(2405, @"E_COMPLETION_TOOL_CALL_INVALID");
        return nil;
      }
      [toolCalls addObject:@{
        @"id": callId,
        @"name": name,
        @"arguments": [[NSString alloc] initWithData:arguments
                                            encoding:NSUTF8StringEncoding],
      }];
    }
    // redacted_thinking and unknown block kinds carry nothing presentable.
  }
  if (toolCalls.count > (NSUInteger)DSHCompletionV2MaxToolCalls) {
    if (error != nil) *error = ClaudeTransportError(2406, @"E_COMPLETION_TOOL_CALL_INVALID");
    return nil;
  }
  NSString *finish = ClaudeFinishReasonForStopReason(
      ClaudeString(decoded[@"stop_reason"]) ?: @"end_turn");
  if (finish == nil) {
    // Unknown future stop_reason: fail closed instead of mislabeling.
    if (error != nil) *error = ClaudeTransportError(2407, @"E_COMPLETION_FINISH_RELATION");
    return nil;
  }
  if ([finish isEqualToString:@"tool_calls"] != (toolCalls.count > 0)) {
    if (error != nil) *error = ClaudeTransportError(2408, @"E_COMPLETION_FINISH_RELATION");
    return nil;
  }
  if (text.length == 0 && reasoning.length == 0 && toolCalls.count == 0 &&
      ![finish isEqualToString:@"content_filter"]) {
    if (error != nil) *error = ClaudeTransportError(2409, @"E_COMPLETION_EMPTY_RESPONSE");
    return nil;
  }
  return @{
    @"provider_response_id": responseId,
    @"model": requestedModel,
    @"text": [text copy],
    @"reasoning": [reasoning copy],
    @"tool_calls": [toolCalls copy],
    @"finish_reason": finish,
  };
}

- (id<DSHProviderStreamEventParsing>)providerNewStreamEventParser {
  return [[ClaudeStreamEventParser alloc] init];
}

- (BOOL)providerSupportsModel:(NSString *)model {
  return [DSHHarnessIdForModel(model) isEqualToString:@"claude-code"];
}

- (NSString *)providerHarnessId {
  return @"claude-code";
}

@end

@implementation GlmProviderTransport

+ (NSURL *)endpointForZCodeProvider:(NSString *)provider {
  if ([provider isEqualToString:@"bigmodel"]) {
    return [NSURL URLWithString:@"https://open.bigmodel.cn/api/anthropic/v1/messages"];
  }
  if ([provider isEqualToString:@"zai"]) {
    return [NSURL URLWithString:@"https://api.z.ai/api/anthropic/v1/messages"];
  }
  if ([provider isEqualToString:@"bigmodel_trial"] || [provider isEqualToString:@"zai_trial"]) {
    return [NSURL URLWithString:@"https://zcode.z.ai/api/v1/zcode-plan/anthropic"];
  }
  return nil;
}

+ (NSDictionary<NSString *, NSString *> *)headersForZCodeCredential:(NSString *)credential {
  if (![credential isKindOfClass:NSString.class] || credential.length == 0) return @{};
  return @{
    @"Content-Type" : @"application/json",
    @"x-api-key" : credential,
    @"anthropic-version" : ClaudeAnthropicVersion,
  };
}

- (NSDictionary<NSString *, NSString *> *)providerHeadersWithCredential:(NSString *)credential {
  if ([self.accountProvider hasSuffix:@"_trial"]) {
    if (![credential isKindOfClass:NSString.class] || credential.length == 0) return @{};
    return @{@"Content-Type": @"application/json", @"Authorization": [@"Bearer " stringByAppendingString:credential],
      @"anthropic-version": ClaudeAnthropicVersion};
  }
  return [GlmProviderTransport headersForZCodeCredential:credential];
}

- (BOOL)providerReportedModel:(NSString *)reportedModel
        matchesRequestedModel:(NSString *)requestedModel {
  if (reportedModel.length == 0 ||
      reportedModel.length != requestedModel.length ||
      ![self providerSupportsModel:requestedModel]) {
    return NO;
  }
  // Zhipu echoes canonical GLM model IDs in lowercase. Fold ASCII letters
  // explicitly: locale/Unicode case folding must not admit lookalike IDs.
  for (NSUInteger index = 0; index < requestedModel.length; index++) {
    unichar reported = [reportedModel characterAtIndex:index];
    unichar requested = [requestedModel characterAtIndex:index];
    if (reported > 0x7f || requested > 0x7f) return NO;
    if (reported >= 'A' && reported <= 'Z') reported += 'a' - 'A';
    if (requested >= 'A' && requested <= 'Z') requested += 'a' - 'A';
    if (reported != requested) return NO;
  }
  return YES;
}

- (NSURL *)providerBaseURL {
  return [GlmProviderTransport endpointForZCodeProvider:self.accountProvider ?: @"bigmodel"];
}

- (BOOL)providerSupportsModel:(NSString *)model {
  if (![DSHHarnessIdForModel(model) isEqualToString:@"glm"]) return NO;
  if ([self.accountProvider hasSuffix:@"_trial"]) {
    for (NSString *allowed in self.trialAllowedModels)
      if ([allowed isKindOfClass:NSString.class] && [allowed caseInsensitiveCompare:model] == NSOrderedSame) return YES;
    return NO;
  }
  return YES;
}

- (NSString *)providerHarnessId {
  return @"glm";
}

@end
