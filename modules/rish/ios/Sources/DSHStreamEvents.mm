#import "DSHStreamEvents.h"

#include <math.h>

#include "rish_agent_core.h"

NSString * const DSHStreamEventErrorDomain = @"DSHStreamEventError";

const NSInteger DSHStreamMaxLineBytes = 262144;        // 256 KiB per SSE line
const NSInteger DSHStreamMaxBufferedLines = 64;        // events held between feeds

static NSError *DSHStreamError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:DSHStreamEventErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

// The parsing itself lives in the shared core
// (crates/rish-agent-core/src/completion_stream.rs), which Android reads the
// same stream through. What stays here is the vocabulary: this class keeps
// the interface and the error codes it always had, and translates. The core
// carries the state between calls, so a chunk boundary may fall anywhere --
// inside a line, inside a token, inside a character -- which is the part
// neither host could test while each had its own reader.

/// The core's reason for refusing, in this file's error codes.
static NSError *DSHStreamFailure(NSDictionary *answer) {
  NSString *reason = [answer[@"reason"] isKindOfClass:NSString.class]
      ? answer[@"reason"] : @"";
  NSDictionary *codes = @{
    @"not_utf8" : @[ @2101, @"SSE event is not valid UTF-8" ],
    @"not_json" : @[ @2102, @"SSE event is not a JSON object" ],
    @"not_an_object" : @[ @2102, @"SSE event is not a JSON object" ],
    @"bad_request" : @[ @2102, @"SSE event is not a JSON object" ],
    @"line_too_long" : @[ @2104, @"SSE line exceeds the size limit" ],
    @"stream_too_long" : @[ @2104, @"SSE line exceeds the size limit" ],
    @"too_many_lines" : @[ @2105, @"SSE event has too many lines" ],
    @"tool_fragment" : @[ @2106, @"SSE tool_calls fragment is not usable" ],
  };
  NSArray *named = codes[reason];
  return named != nil
      ? DSHStreamError([named[0] integerValue], named[1])
      : DSHStreamError(2102, @"SSE event is not a JSON object");
}

/// One call into the core's stream reducer.
static NSDictionary * _Nullable DSHStreamReduce(NSDictionary *envelope,
                                                NSError **error) {
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:envelope
                                                  options:0
                                                    error:nil];
  char *raw = bytes == nil ? NULL
      : rish_agent_completion_response_reduce((const char *)bytes.bytes,
                                              bytes.length);
  if (raw == NULL) {
    if (error != nil) *error = DSHStreamError(2102, @"SSE event is not a JSON object");
    return nil;
  }
  NSData *reply = [NSData dataWithBytes:raw length:strlen(raw)];
  rish_agent_string_free(raw);
  id parsed = [NSJSONSerialization JSONObjectWithData:reply options:0 error:nil];
  if (![parsed isKindOfClass:NSDictionary.class]) {
    if (error != nil) *error = DSHStreamError(2102, @"SSE event is not a JSON object");
    return nil;
  }
  if (![parsed[@"ok"] isEqual:@YES]) {
    if (error != nil) *error = DSHStreamFailure(parsed);
    return nil;
  }
  return parsed;
}

@interface DSHStreamEventParser ()
/// The core's state, opaque here; NSNull before the first chunk.
@property(nonatomic, strong) id state;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, assign) BOOL sawTerminator;
@property(nonatomic, copy, readwrite, nullable) NSString *streamedResponseId;
@property(nonatomic, copy, readwrite, nullable) NSString *streamedModel;
@end

@implementation DSHStreamEventParser

- (instancetype)init {
  self = [super init];
  if (self) {
    _state = NSNull.null;
  }
  return self;
}

- (void)reset {
  self.state = NSNull.null;
  self.finished = NO;
  self.sawTerminator = NO;
  self.streamedResponseId = nil;
  self.streamedModel = nil;
}

/// The core's preview vocabulary in this file's delta vocabulary.
static DSHStreamDelta *DSHDeltaFromPreview(NSDictionary *preview) {
  NSMutableDictionary *delta = [NSMutableDictionary dictionary];
  delta[@"type"] = @"delta";
  if ([preview[@"text"] isKindOfClass:NSString.class]) {
    delta[@"content"] = preview[@"text"];
  }
  if ([preview[@"reasoning"] isKindOfClass:NSString.class]) {
    delta[@"reasoning"] = preview[@"reasoning"];
  }
  if ([preview[@"tool_calls"] isKindOfClass:NSArray.class]) {
    delta[@"tool_calls"] = preview[@"tool_calls"];
  }
  if ([preview[@"finish_reason"] isKindOfClass:NSString.class]) {
    delta[@"finish_reason"] = preview[@"finish_reason"];
  }
  return delta;
}

/// Takes what one reduce answered: the new state, the identity it has seen,
/// and the deltas to emit.
- (NSArray<DSHStreamDelta *> *)acceptAnswer:(NSDictionary *)answer {
  NSDictionary *state = [answer[@"state"] isKindOfClass:NSDictionary.class]
      ? answer[@"state"] : nil;
  if (state != nil) {
    self.state = state;
    if (self.streamedResponseId == nil &&
        [state[@"id"] isKindOfClass:NSString.class]) {
      self.streamedResponseId = state[@"id"];
    }
    if (self.streamedModel == nil &&
        [state[@"model"] isKindOfClass:NSString.class]) {
      self.streamedModel = state[@"model"];
    }
  }
  NSMutableArray<DSHStreamDelta *> *deltas = [NSMutableArray array];
  NSArray *previews = [answer[@"previews"] isKindOfClass:NSArray.class]
      ? answer[@"previews"] : @[];
  for (id preview in previews) {
    if ([preview isKindOfClass:NSDictionary.class]) {
      [deltas addObject:DSHDeltaFromPreview(preview)];
    }
  }
  // `[DONE]` shows nothing, so the core does not preview it; nothing can
  // follow it either, so saying it here says it in the right place.
  if (!self.sawTerminator && [answer[@"done"] isEqual:@YES]) {
    self.sawTerminator = YES;
    [deltas addObject:@{@"type" : @"done"}];
  }
  return deltas;
}

- (NSArray<DSHStreamDelta *> *)appendBytes:(const uint8_t *)bytes
                                    length:(NSUInteger)length
                                      error:(NSError **)error {
  if (self.finished) {
    if (error != nil) {
      *error = DSHStreamError(2103, @"Stream already finished");
    }
    return nil;
  }
  if (length == 0) return @[];
  NSString *encoded = [[NSData dataWithBytes:bytes length:length]
      base64EncodedStringWithOptions:0];
  NSDictionary *answer = DSHStreamReduce(@{
    @"op" : @"stream_chunk",
    @"state" : self.state,
    @"chunk_base64" : encoded,
  }, error);
  return answer == nil ? nil : [self acceptAnswer:answer];
}

- (NSArray<DSHStreamDelta *> *)finish:(NSError **)error {
  if (self.finished) {
    if (error != nil) {
      *error = DSHStreamError(2103, @"Stream already finished");
    }
    return nil;
  }
  self.finished = YES;
  // Whatever is still carried is a final line the socket never terminated,
  // and a final event nothing closed. Both are read rather than dropped.
  NSDictionary *answer = DSHStreamReduce(@{
    @"op" : @"stream_flush",
    @"state" : self.state,
  }, error);
  return answer == nil ? nil : [self acceptAnswer:answer];
}

@end

#pragma mark - Response assembler

NSString * const DSHStreamAssemblerErrorDomain = @"DSHStreamAssemblerError";

static NSError *DSHAssemblerError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:DSHStreamAssemblerErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

@interface DSHStreamResponseAssembler ()
@property(nonatomic, copy) NSString *thinkingMode;
@property(nonatomic) NSUInteger maximumBytes;
@property(nonatomic, readwrite) NSUInteger accumulatedBytes;
@property(nonatomic, strong) NSMutableString *text;
@property(nonatomic, strong) NSMutableString *reasoning;
@property(nonatomic) BOOL sawReasoning;
@property(nonatomic, copy, nullable) NSString *finishReason;
@property(nonatomic, copy, nullable) NSString *responseId;
@property(nonatomic, copy, nullable) NSString *model;
/// index -> {id, name, arguments(NSMutableString)}
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, NSMutableDictionary *> *calls;
@end

@implementation DSHStreamResponseAssembler

- (instancetype)initWithThinkingMode:(NSString *)thinkingMode
                        maximumBytes:(NSUInteger)maximumBytes {
  self = [super init];
  if (self) {
    _thinkingMode = [thinkingMode copy] ?: @"off";
    _maximumBytes = maximumBytes;
    _text = [NSMutableString string];
    _reasoning = [NSMutableString string];
    _calls = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)noteResponseId:(NSString *)responseId model:(NSString *)model {
  if (self.responseId == nil && [responseId isKindOfClass:NSString.class] &&
      responseId.length > 0) self.responseId = responseId;
  if (self.model == nil && [model isKindOfClass:NSString.class] &&
      model.length > 0) self.model = model;
}

- (BOOL)appendDelta:(DSHStreamDelta *)delta error:(NSError **)error {
  if (error != nil) *error = nil;
  if (![delta isKindOfClass:NSDictionary.class] ||
      ![delta[@"type"] isEqual:@"delta"]) return YES;
  NSString *content = [delta[@"content"] isKindOfClass:NSString.class]
      ? delta[@"content"] : nil;
  NSString *reasoning = [delta[@"reasoning"] isKindOfClass:NSString.class]
      ? delta[@"reasoning"] : nil;
  NSUInteger bytes = [content lengthOfBytesUsingEncoding:NSUTF8StringEncoding] +
      [reasoning lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  NSArray *fragments = [delta[@"tool_calls"] isKindOfClass:NSArray.class]
      ? delta[@"tool_calls"] : @[];
  for (NSDictionary *fragment in fragments) {
    bytes += [[fragment[@"arguments"] isKindOfClass:NSString.class]
        ? fragment[@"arguments"] : @"" lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  }
  if (bytes > self.maximumBytes - MIN(self.accumulatedBytes, self.maximumBytes)) {
    if (error != nil) {
      *error = DSHAssemblerError(2201, @"Streamed response exceeds the byte budget");
    }
    return NO;
  }
  self.accumulatedBytes += bytes;
  if (content != nil) [self.text appendString:content];
  if (reasoning != nil) {
    self.sawReasoning = YES;
    [self.reasoning appendString:reasoning];
  }
  for (NSDictionary *fragment in fragments) {
    NSNumber *index = fragment[@"index"];
    if (![index isKindOfClass:NSNumber.class]) {
      if (error != nil) {
        *error = DSHAssemblerError(2202, @"Streamed tool fragment cannot be placed");
      }
      return NO;
    }
    NSMutableDictionary *call = self.calls[index];
    if (call == nil) {
      if (self.calls.count >= 16) {
        if (error != nil) {
          *error = DSHAssemblerError(2202, @"Streamed tool fragment cannot be placed");
        }
        return NO;
      }
      call = [@{ @"arguments" : [NSMutableString string] } mutableCopy];
      self.calls[index] = call;
    }
    if (fragment[@"id"] != nil && call[@"id"] == nil) call[@"id"] = fragment[@"id"];
    if (fragment[@"name"] != nil && call[@"name"] == nil) call[@"name"] = fragment[@"name"];
    if (fragment[@"arguments"] != nil) {
      [(NSMutableString *)call[@"arguments"] appendString:fragment[@"arguments"]];
    }
  }
  if ([delta[@"finish_reason"] isKindOfClass:NSString.class] &&
      [delta[@"finish_reason"] length] > 0) {
    self.finishReason = delta[@"finish_reason"];
  }
  return YES;
}

- (NSString *)assembledText { return [self.text copy]; }
- (NSString *)assembledReasoning { return [self.reasoning copy]; }
- (BOOL)assembledSawReasoning { return self.sawReasoning; }
- (NSString *)assembledFinishReason { return self.finishReason; }
- (NSString *)assembledResponseId { return self.responseId; }
- (NSString *)assembledModel { return self.model; }
- (NSString *)assembledThinkingMode { return self.thinkingMode; }

- (NSArray<DSHStreamAssembledCall *> *)assembledToolCalls {
  NSArray<NSNumber *> *indexes = [self.calls.allKeys
      sortedArrayUsingSelector:@selector(compare:)];
  NSMutableArray *calls = [NSMutableArray arrayWithCapacity:indexes.count];
  for (NSNumber *index in indexes) {
    NSDictionary *call = self.calls[index];
    NSMutableDictionary *entry = [NSMutableDictionary dictionary];
    entry[@"index"] = index;
    if (call[@"id"] != nil) entry[@"id"] = call[@"id"];
    if (call[@"name"] != nil) entry[@"name"] = call[@"name"];
    entry[@"arguments"] = [call[@"arguments"] copy];
    [calls addObject:[entry copy]];
  }
  return [calls copy];
}

- (NSDictionary<NSString *, id> *)responseObject {
  NSMutableDictionary *message = [NSMutableDictionary dictionary];
  message[@"role"] = @"assistant";
  NSArray<NSNumber *> *indexes = [self.calls.allKeys
      sortedArrayUsingSelector:@selector(compare:)];
  NSMutableArray *toolCalls = [NSMutableArray arrayWithCapacity:indexes.count];
  for (NSNumber *index in indexes) {
    NSDictionary *call = self.calls[index];
    // Absent id/name stay absent so the response parser rejects the call
    // the same way it rejects a malformed single-shot call.
    NSMutableDictionary *function = [NSMutableDictionary dictionary];
    if (call[@"name"] != nil) function[@"name"] = call[@"name"];
    function[@"arguments"] = [call[@"arguments"] copy];
    NSMutableDictionary *entry = [NSMutableDictionary dictionary];
    if (call[@"id"] != nil) entry[@"id"] = call[@"id"];
    entry[@"type"] = @"function";
    entry[@"function"] = function;
    [toolCalls addObject:entry];
  }
  // DeepSeek's single-shot shape carries null content for a tool-only turn.
  message[@"content"] = self.text.length == 0 && toolCalls.count > 0
      ? (id)NSNull.null : [self.text copy];
  if (self.sawReasoning || ![self.thinkingMode isEqualToString:@"off"]) {
    message[@"reasoning_content"] = [self.reasoning copy];
  }
  if (toolCalls.count > 0) message[@"tool_calls"] = toolCalls;
  return @{
    @"id" : self.responseId ?: (id)NSNull.null,
    @"object" : @"chat.completion",
    @"model" : self.model ?: (id)NSNull.null,
    @"choices" : @[ @{
      @"index" : @0,
      @"message" : message,
      @"finish_reason" : self.finishReason ?: (id)NSNull.null,
    } ],
  };
}

@end
