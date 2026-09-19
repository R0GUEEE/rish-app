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



@implementation CodexStreamEventParser

// The framing, the limits and the reading of a OpenAI event are all the
// shared core's (crates/rish-agent-core/src/completion_stream.rs). What is
// left here is this wire's name and this transport's error codes, because a
// caller that switched on 3301..3308 still has to see them.

- (NSString *)wire {
  return @"responses";
}

- (NSError *)alreadyFinished {
  return CodexTransportError(3304, @"Stream already finished");
}

- (NSError *)refusalForReason:(NSString *)reason fallback:(NSError *)failure {
  if ([reason isEqualToString:@"not_utf8"]) {
    return CodexTransportError(3301, @"SSE line is not valid UTF-8");
  }
  if ([reason isEqualToString:@"stream_error"]) {
    return CodexTransportError(3303, @"OpenAI stream error");
  }
  if ([reason isEqualToString:@"line_too_long"] ||
      [reason isEqualToString:@"stream_too_long"]) {
    return CodexTransportError(3305, @"SSE line exceeds the size limit");
  }
  if ([reason isEqualToString:@"too_many_lines"]) {
    return CodexTransportError(3306, @"SSE event has too many lines");
  }
  if ([reason isEqualToString:@"unknown_status"]) {
    return CodexTransportError(3307, @"Unknown terminal status");
  }
  if ([reason isEqualToString:@"unusable_item"] ||
      [reason isEqualToString:@"tool_fragment"]) {
    return CodexTransportError(3308, @"Streamed tool item is not usable");
  }
  return CodexTransportError(3302, @"SSE event is not a JSON object");
}

@end

/// Responses-API shape for a streamed OpenAI round. A stream without a
/// terminal `response.completed`/`response.incomplete` keeps status
/// `in_progress`, which `providerParseResponseData:` rejects.
@interface CodexStreamResponseAssembler : DSHStreamResponseAssembler
@end

@implementation CodexStreamResponseAssembler

// The accumulation and this wire shape are the shared core's; all that is
// left of this dialect is its name.
- (NSString *)dialect {
  return @"responses";
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
  // Flat input items, `store`, and the summary that carries the thinking
  // mode all live in the shared core now.
  NSString *failure = nil;
  NSDictionary *body = DSHCompletionTransportRequestBody(
      @"responses", model, thinkingMode, messages, tools, streaming, &failure);
  if (body == nil && error != nil) {
    *error = [failure isEqualToString:@"E_COMPLETION_TOOLS"]
        ? CodexTransportError(3210, failure)
        : CodexTransportError(3202, failure);
  }
  return body;
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
