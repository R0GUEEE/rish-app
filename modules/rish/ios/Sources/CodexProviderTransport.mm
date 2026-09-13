#import "CodexProviderTransport.h"

#import "DSHStreamEvents.h"

#include <math.h>

#import "DSHCompletionV2.h"
#import "RishHarnessCatalog.h"

// OpenAI Responses API dialect for the Codex Harness.
//
// Mapping table (see the openpencil-docs record for the full matrix):
//   thinking mode -> reasoning: off -> omitted; high -> {effort high,
//                    summary auto}; max -> {effort high, summary detailed}
//   transcript -> input items: user/assistant messages, function_call
//                 (call_id/name/arguments, no server item id), tool ->
//                 function_call_output; reasoning items are never replayed
//                 because the closed transcript has no item id or
//                 encrypted content, and requests run with store: false
//   status -> finish_reason: completed -> stop | tool_calls (function_call
//             present); incomplete(max_output_tokens) -> length;
//             incomplete(content_filter) -> content_filter; failed -> error

static NSString * const CodexTransportErrorDomain = @"CodexTransportError";
static NSInteger const CodexStreamMaxLineBytes = 262144;
static NSInteger const CodexStreamMaxBufferedLines = 64;
static NSInteger const CodexMaxOutputTokensPlain = 8192;
static NSInteger const CodexMaxOutputTokensReasoning = 16384;

static NSError *CodexTransportError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:CodexTransportErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *CodexString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static NSArray *CodexArray(id value) {
  return [value isKindOfClass:NSArray.class] ? value : nil;
}

static NSDictionary *CodexDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static BOOL CodexModelMatches(NSString *reported, NSString *requested) {
  if (reported == nil) return YES;
  return [reported isEqualToString:requested] ||
      [reported hasPrefix:[requested stringByAppendingString:@"-"]];
}

/// Maps a Responses API status (+ incomplete reason) to the closed canonical
/// finish vocabulary. Returns nil for statuses that are not terminal
/// results (failed, cancelled, queued, in_progress).
static NSString *CodexFinishReasonForResponse(NSDictionary *response,
                                              BOOL hasFunctionCall) {
  NSString *status = CodexString(response[@"status"]) ?: @"completed";
  if ([status isEqualToString:@"completed"]) {
    return hasFunctionCall ? @"tool_calls" : @"stop";
  }
  if ([status isEqualToString:@"incomplete"]) {
    NSString *reason = CodexString(
        CodexDictionary(response[@"incomplete_details"])[@"reason"]);
    return [reason isEqualToString:@"content_filter"] ? @"content_filter" : @"length";
  }
  return nil;
}

static BOOL CodexOutputHasFunctionCall(NSDictionary *response) {
  for (id rawItem in CodexArray(response[@"output"]) ?: @[]) {
    if ([CodexString(CodexDictionary(rawItem)[@"type"])
            isEqualToString:@"function_call"]) {
      return YES;
    }
  }
  return NO;
}

static BOOL CodexAppendItems(NSMutableArray *input, NSDictionary *message,
                             NSError **error) {
  NSString *role = CodexString(message[@"role"]);
  if ([role isEqualToString:@"assistant"]) {
    NSString *content = CodexString(message[@"content"]) ?: @"";
    if (content.length > 0) {
      [input addObject:@{@"type": @"message", @"role": @"assistant",
                         @"content": @[ @{@"type": @"output_text",
                                          @"text": content} ]}];
    }
    for (id rawCall in CodexArray(message[@"tool_calls"]) ?: @[]) {
      NSDictionary *call = CodexDictionary(rawCall);
      NSDictionary *function = CodexDictionary(call[@"function"]);
      NSString *callId = CodexString(call[@"id"]);
      NSString *name = CodexString(function[@"name"]);
      NSString *arguments = CodexString(function[@"arguments"]);
      if (callId == nil || name == nil || arguments == nil) {
        if (error != nil) *error = CodexTransportError(3202, @"E_COMPLETION_TRANSCRIPT");
        return NO;
      }
      [input addObject:@{@"type": @"function_call", @"call_id": callId,
                         @"name": name, @"arguments": arguments}];
    }
    return YES;
  }
  if ([role isEqualToString:@"tool"]) {
    NSString *callId = CodexString(message[@"tool_call_id"]);
    if (callId == nil) {
      if (error != nil) *error = CodexTransportError(3204, @"E_COMPLETION_TRANSCRIPT");
      return NO;
    }
    [input addObject:@{@"type": @"function_call_output", @"call_id": callId,
                       @"output": CodexString(message[@"content"]) ?: @""}];
    return YES;
  }
  if ([role isEqualToString:@"user"]) {
    [input addObject:@{@"type": @"message", @"role": @"user",
                       @"content": @[ @{@"type": @"input_text",
                                        @"text": CodexString(message[@"content"]) ?: @""} ]}];
    return YES;
  }
  if (error != nil) *error = CodexTransportError(3205, @"E_COMPLETION_TRANSCRIPT");
  return NO;
}

/// Responses output index as the tool-call fragment index (0..15).
static NSNumber * _Nullable CodexStreamOutputIndex(id value) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return nil;
  double position = [value doubleValue];
  if (position != floor(position) || position < 0 || position > 15) return nil;
  return @((NSInteger)position);
}

static NSDictionary<NSString *, id> * _Nullable CodexDecodeEvent(
    NSString *eventName, NSArray<NSString *> *dataLines,
    NSDictionary * _Nullable * _Nullable chunkOut, NSError **error) {
  if (chunkOut != nil) *chunkOut = nil;
  if (dataLines.count == 0) return nil;
  NSString *data = [dataLines componentsJoinedByString:@"\n"];
  if ([data isEqualToString:@"[DONE]"]) return @{@"type": @"done"};
  if ([[data stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet] length] == 0) {
    return nil;
  }
  NSData *json = [data dataUsingEncoding:NSUTF8StringEncoding];
  if (json == nil) {
    if (error != nil) *error = CodexTransportError(3301, @"SSE event is not valid UTF-8");
    return nil;
  }
  NSDictionary *chunk = CodexDictionary(
      [NSJSONSerialization JSONObjectWithData:json options:0 error:nil]);
  if (chunk == nil) {
    if (error != nil) *error = CodexTransportError(3302, @"SSE event is not a JSON object");
    return nil;
  }
  if (chunkOut != nil) *chunkOut = chunk;
  NSString *kind = CodexString(chunk[@"type"]) ?: eventName;
  if ([kind isEqualToString:@"response.failed"] || [kind isEqualToString:@"error"]) {
    if (error != nil) {
      NSDictionary *response = CodexDictionary(chunk[@"response"]);
      NSString *reason = CodexString(CodexDictionary(response[@"error"])[@"code"]) ?:
          CodexString(chunk[@"code"]) ?: @"failed";
      *error = CodexTransportError(3303,
          [@"OpenAI stream error: " stringByAppendingString:reason]);
    }
    return nil;
  }
  if ([kind isEqualToString:@"response.output_text.delta"]) {
    NSString *text = CodexString(chunk[@"delta"]);
    return text.length > 0 ? @{@"type": @"delta", @"content": text} : nil;
  }
  if ([kind isEqualToString:@"response.reasoning_summary_text.delta"]) {
    NSString *text = CodexString(chunk[@"delta"]);
    return text.length > 0 ? @{@"type": @"delta", @"reasoning": text} : nil;
  }
  if ([kind isEqualToString:@"response.completed"] ||
      [kind isEqualToString:@"response.incomplete"]) {
    NSDictionary *response = CodexDictionary(chunk[@"response"]);
    if (response == nil) return @{@"type": @"done"};
    NSString *finish = CodexFinishReasonForResponse(
        response, CodexOutputHasFunctionCall(response));
    if (finish == nil) {
      if (error != nil) *error = CodexTransportError(3307, @"Unknown Responses status");
      return nil;
    }
    return @{@"type": @"delta", @"finish_reason": finish};
  }
  if ([kind isEqualToString:@"response.output_item.added"]) {
    NSDictionary *item = CodexDictionary(chunk[@"item"]);
    if (![CodexString(item[@"type"]) isEqualToString:@"function_call"]) return nil;
    NSNumber *index = CodexStreamOutputIndex(chunk[@"output_index"]);
    NSString *callId = CodexString(item[@"call_id"]);
    NSString *name = CodexString(item[@"name"]);
    if (index == nil || callId.length == 0 || name.length == 0) {
      if (error != nil) *error = CodexTransportError(3308, @"Responses function_call item is not usable");
      return nil;
    }
    return @{@"type": @"delta",
             @"tool_calls": @[ @{@"index": index, @"id": callId, @"name": name} ]};
  }
  if ([kind isEqualToString:@"response.function_call_arguments.delta"]) {
    NSNumber *index = CodexStreamOutputIndex(chunk[@"output_index"]);
    NSString *fragment = CodexString(chunk[@"delta"]);
    if (index == nil) {
      if (error != nil) *error = CodexTransportError(3308, @"Responses arguments delta has no output index");
      return nil;
    }
    return fragment.length > 0
        ? @{@"type": @"delta", @"tool_calls": @[ @{@"index": index, @"arguments": fragment} ]}
        : nil;
  }
  // response.created/in_progress, content_part.*, function_call_arguments.done
  // and reasoning_summary_part.* carry no presentable delta.
  return nil;
}

@implementation CodexStreamEventParser {
  NSMutableData *_pending;
  NSMutableArray<NSString *> *_dataLines;
  NSString *_eventName;
  BOOL _finished;
}

@synthesize streamedResponseId = _streamedResponseId;
@synthesize streamedModel = _streamedModel;

- (void)noteChunkIdentity:(NSDictionary *)chunk {
  NSString *kind = CodexString(chunk[@"type"]);
  if (![kind isEqualToString:@"response.created"] &&
      ![kind isEqualToString:@"response.completed"] &&
      ![kind isEqualToString:@"response.incomplete"]) return;
  NSDictionary *response = CodexDictionary(chunk[@"response"]);
  if (_streamedResponseId == nil && CodexString(response[@"id"]).length > 0) {
    _streamedResponseId = [response[@"id"] copy];
  }
  if (_streamedModel == nil && CodexString(response[@"model"]).length > 0) {
    _streamedModel = [response[@"model"] copy];
  }
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
  _streamedResponseId = nil;
  _streamedModel = nil;
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
      *error = CodexTransportError(3304, @"Stream already finished");
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
      if (total > (NSUInteger)CodexStreamMaxLineBytes) {
        if (error != nil) {
          *error = CodexTransportError(3305, @"SSE line exceeds the size limit");
        }
        return nil;
      }
      break;
    }
    NSUInteger lineLength = static_cast<NSUInteger>(
        reinterpret_cast<const uint8_t *>(nl) - static_cast<const uint8_t *>(base));
    if (lineLength > (NSUInteger)CodexStreamMaxLineBytes) {
      if (error != nil) {
        *error = CodexTransportError(3305, @"SSE line exceeds the size limit");
      }
      return nil;
    }
    NSData *lineData = [NSData dataWithBytes:base length:lineLength];
    NSString *line = [[NSString alloc] initWithData:lineData
                                           encoding:NSUTF8StringEncoding];
    if (line == nil) {
      if (error != nil) {
        *error = CodexTransportError(3301, @"SSE line is not valid UTF-8");
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
        if (_dataLines.count > (NSUInteger)CodexStreamMaxBufferedLines) {
          if (error != nil) {
            *error = CodexTransportError(3306, @"SSE event has too many lines");
          }
          return nil;
        }
        NSDictionary *chunk = nil;
        NSDictionary<NSString *, id> *delta = CodexDecodeEvent(
            _eventName, _dataLines, &chunk, error);
        [_dataLines removeAllObjects];
        _eventName = nil;
        if (chunk != nil) [self noteChunkIdentity:chunk];
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
      if (_dataLines.count >= (NSUInteger)CodexStreamMaxBufferedLines) {
        if (error != nil) {
          *error = CodexTransportError(3306, @"SSE event has too many lines");
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
      *error = CodexTransportError(3304, @"Stream already finished");
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
        *error = CodexTransportError(3301, @"SSE trailing bytes are not valid UTF-8");
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
    NSDictionary *chunk = nil;
    NSDictionary<NSString *, id> *delta = CodexDecodeEvent(
        _eventName, _dataLines, &chunk, error);
    [_dataLines removeAllObjects];
    if (chunk != nil) [self noteChunkIdentity:chunk];
    if (delta != nil) [deltas addObject:delta];
    else if (error != nil && *error != nil) return nil;
  }
  return deltas;
}

@end

/// Responses-API shape for a streamed OpenAI round. A stream without a
/// terminal `response.completed`/`response.incomplete` keeps status
/// `in_progress`, which `providerParseResponseData:` rejects.
@interface CodexStreamResponseAssembler : DSHStreamResponseAssembler
@end

@implementation CodexStreamResponseAssembler

- (NSDictionary<NSString *, id> *)responseObject {
  NSMutableArray *output = [NSMutableArray array];
  if (self.assembledSawReasoning) {
    [output addObject:@{@"type": @"reasoning",
                        @"summary": @[ @{@"type": @"summary_text", @"text": self.assembledReasoning} ]}];
  }
  if (self.assembledText.length > 0) {
    [output addObject:@{@"type": @"message", @"role": @"assistant",
                        @"content": @[ @{@"type": @"output_text", @"text": self.assembledText} ]}];
  }
  for (NSDictionary *call in self.assembledToolCalls) {
    NSMutableDictionary *item = [NSMutableDictionary dictionary];
    item[@"type"] = @"function_call";
    if (call[@"id"] != nil) item[@"call_id"] = call[@"id"];
    if (call[@"name"] != nil) item[@"name"] = call[@"name"];
    item[@"arguments"] = call[@"arguments"];
    [output addObject:[item copy]];
  }
  NSString *finish = self.assembledFinishReason;
  NSMutableDictionary *object = [NSMutableDictionary dictionary];
  object[@"object"] = @"response";
  if (self.assembledResponseId != nil) object[@"id"] = self.assembledResponseId;
  if (self.assembledModel != nil) object[@"model"] = self.assembledModel;
  object[@"output"] = [output copy];
  if ([finish isEqualToString:@"stop"] || [finish isEqualToString:@"tool_calls"]) {
    object[@"status"] = @"completed";
  } else if ([finish isEqualToString:@"length"] || [finish isEqualToString:@"content_filter"]) {
    object[@"status"] = @"incomplete";
    object[@"incomplete_details"] = @{@"reason": [finish isEqualToString:@"length"]
        ? @"max_output_tokens" : @"content_filter"};
  } else {
    object[@"status"] = @"in_progress";
  }
  return [object copy];
}

@end

@implementation CodexProviderTransport

- (NSURL *)providerBaseURL {
  return [NSURL URLWithString:@"https://api.openai.com/v1/responses"];
}

- (NSDictionary<NSString *, NSString *> *)providerHeadersWithCredential:(NSString *)credential {
  return @{
    @"Content-Type": @"application/json",
    @"Authorization": [@"Bearer " stringByAppendingString:credential],
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
    if (error != nil) *error = CodexTransportError(3201, @"E_COMPLETION_MODEL");
    return nil;
  }
  NSMutableArray *instructions = [NSMutableArray array];
  NSMutableArray *input = [NSMutableArray array];
  for (NSDictionary *message in messages) {
    NSString *role = CodexString(message[@"role"]);
    if ([role isEqualToString:@"system"]) {
      NSString *text = CodexString(message[@"content"]) ?: @"";
      if (text.length > 0) [instructions addObject:text];
      continue;
    }
    if (!CodexAppendItems(input, message, error)) return nil;
  }
  NSMutableArray *codexTools = [NSMutableArray array];
  for (id rawTool in tools) {
    NSDictionary *tool = CodexDictionary(rawTool);
    NSDictionary *function = CodexDictionary(tool[@"function"]);
    NSString *name = CodexString(function[@"name"]);
    NSString *description = CodexString(function[@"description"]);
    NSDictionary *parameters = CodexDictionary(function[@"parameters"]);
    if (name == nil || parameters == nil) {
      if (error != nil) *error = CodexTransportError(3210, @"E_COMPLETION_TOOLS");
      return nil;
    }
    // The registry schemas keep optional parameters, so strict mode (which
    // demands every property be required) is off explicitly.
    NSMutableDictionary *entry = [@{
      @"type": @"function", @"name": name, @"parameters": parameters,
      @"strict": @NO,
    } mutableCopy];
    if (description != nil) entry[@"description"] = description;
    [codexTools addObject:[entry copy]];
  }
  BOOL thinking = ![thinkingMode isEqualToString:@"off"];
  BOOL maximal = [thinkingMode isEqualToString:@"max"];
  NSMutableDictionary *body = [@{
    @"model": model,
    @"stream": @(streaming),
    @"store": @NO,
    @"max_output_tokens": @(thinking ? CodexMaxOutputTokensReasoning
                                     : CodexMaxOutputTokensPlain),
    @"input": [input copy],
  } mutableCopy];
  if (instructions.count > 0) {
    body[@"instructions"] = [instructions componentsJoinedByString:@"\n\n"];
  }
  if (codexTools.count > 0) body[@"tools"] = [codexTools copy];
  if (thinking) {
    body[@"reasoning"] = @{@"effort": @"high",
                           @"summary": maximal ? @"detailed" : @"auto"};
  }
  return [body copy];
}

- (NSDictionary<NSString *, id> *)providerParseResponseData:(NSData *)data
                                              requestedModel:(NSString *)requestedModel
                                                thinkingMode:(NSString *)thinkingMode
                                                      error:(NSError **)error {
  if (error != nil) *error = nil;
  NSDictionary *decoded = CodexDictionary([NSJSONSerialization
      JSONObjectWithData:data options:0 error:nil]);
  id providerError = decoded[@"error"];
  if (decoded == nil || (providerError != nil && providerError != NSNull.null) ||
      ![CodexString(decoded[@"object"]) ?: @"response" isEqualToString:@"response"]) {
    if (error != nil) *error = CodexTransportError(3401, @"E_COMPLETION_RESPONSE_JSON");
    return nil;
  }
  NSString *responseId = CodexString(decoded[@"id"]);
  if (responseId.length == 0) {
    if (error != nil) *error = CodexTransportError(3403, @"E_COMPLETION_PROVIDER_RESPONSE_ID");
    return nil;
  }
  if (!CodexModelMatches(CodexString(decoded[@"model"]), requestedModel)) {
    if (error != nil) *error = CodexTransportError(3404, @"E_COMPLETION_MODEL_MISMATCH");
    return nil;
  }
  NSMutableString *text = [NSMutableString string];
  NSMutableString *reasoning = [NSMutableString string];
  NSMutableArray *toolCalls = [NSMutableArray array];
  for (id rawItem in CodexArray(decoded[@"output"]) ?: @[]) {
    NSDictionary *item = CodexDictionary(rawItem);
    NSString *kind = CodexString(item[@"type"]);
    if ([kind isEqualToString:@"message"]) {
      for (id rawContent in CodexArray(item[@"content"]) ?: @[]) {
        NSDictionary *content = CodexDictionary(rawContent);
        if ([CodexString(content[@"type"]) isEqualToString:@"output_text"]) {
          [text appendString:CodexString(content[@"text"]) ?: @""];
        } else if ([CodexString(content[@"type"]) isEqualToString:@"refusal"]) {
          [text appendString:CodexString(content[@"refusal"]) ?: @""];
        }
      }
    } else if ([kind isEqualToString:@"reasoning"]) {
      for (id rawSummary in CodexArray(item[@"summary"]) ?: @[]) {
        NSDictionary *summary = CodexDictionary(rawSummary);
        if ([CodexString(summary[@"type"]) isEqualToString:@"summary_text"]) {
          if (reasoning.length > 0) [reasoning appendString:@"\n\n"];
          [reasoning appendString:CodexString(summary[@"text"]) ?: @""];
        }
      }
    } else if ([kind isEqualToString:@"function_call"]) {
      NSString *callId = CodexString(item[@"call_id"]);
      NSString *name = CodexString(item[@"name"]);
      NSString *arguments = CodexString(item[@"arguments"]);
      if (callId == nil || name == nil || arguments == nil) {
        if (error != nil) *error = CodexTransportError(3405, @"E_COMPLETION_TOOL_CALL_INVALID");
        return nil;
      }
      [toolCalls addObject:@{@"id": callId, @"name": name, @"arguments": arguments}];
    }
  }
  if (toolCalls.count > (NSUInteger)DSHCompletionV2MaxToolCalls) {
    if (error != nil) *error = CodexTransportError(3406, @"E_COMPLETION_TOOL_CALL_INVALID");
    return nil;
  }
  NSString *finish = CodexFinishReasonForResponse(decoded, toolCalls.count > 0);
  if (finish == nil) {
    if (error != nil) *error = CodexTransportError(3407, @"E_COMPLETION_FINISH_RELATION");
    return nil;
  }
  if ([finish isEqualToString:@"tool_calls"] != (toolCalls.count > 0)) {
    if (error != nil) *error = CodexTransportError(3408, @"E_COMPLETION_FINISH_RELATION");
    return nil;
  }
  if (text.length == 0 && reasoning.length == 0 && toolCalls.count == 0 &&
      ![finish isEqualToString:@"content_filter"]) {
    if (error != nil) *error = CodexTransportError(3409, @"E_COMPLETION_EMPTY_RESPONSE");
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
  return [[CodexStreamEventParser alloc] init];
}

- (BOOL)providerSupportsStreamingRounds {
  return YES;
}

- (id<DSHProviderStreamResponseAssembling>)providerNewStreamResponseAssemblerWithThinkingMode:(NSString *)thinkingMode
                                                                                  maximumBytes:(NSUInteger)maximumBytes {
  return [[CodexStreamResponseAssembler alloc] initWithThinkingMode:thinkingMode
                                                       maximumBytes:maximumBytes];
}

- (BOOL)providerSupportsModel:(NSString *)model {
  return [DSHHarnessIdForModel(model) isEqualToString:@"codex"];
}

- (NSString *)providerHarnessId {
  return @"codex";
}

@end
