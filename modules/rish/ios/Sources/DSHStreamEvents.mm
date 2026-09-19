#import "DSHStreamEvents.h"

#include <math.h>

#include "rish_agent_core.h"

NSString * const DSHStreamEventErrorDomain = @"DSHStreamEventError";

const NSInteger DSHStreamMaxLineBytes = 262144;        // 256 KiB per SSE line
const NSInteger DSHStreamMaxBufferedLines = 64;        // events held between feeds

NSString * const DSHStreamFailureReasonKey = @"DSHStreamFailureReason";

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
  NSError *error = named != nil
      ? DSHStreamError([named[0] integerValue], named[1])
      : DSHStreamError(2102, @"SSE event is not a JSON object");
  // The core's own word for what went wrong, carried along so a caller that
  // distinguishes more finely than these codes do can read it.
  NSMutableDictionary *info = [error.userInfo mutableCopy];
  info[DSHStreamFailureReasonKey] = reason;
  return [NSError errorWithDomain:error.domain code:error.code userInfo:[info copy]];
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

// Like the parser above, this keeps its interface and gives up its
// implementation. The accumulation and all three wire shapes live in
// crates/rish-agent-core/src/completion_stream.rs, where a reply assembled
// from a stream this core parses and one assembled from a dialect it does
// not are the same code. What a dialect chooses here is a name.

NSString * const DSHStreamAssemblerErrorDomain = @"DSHStreamAssemblerError";

static NSError *DSHAssemblerError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:DSHStreamAssemblerErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

@interface DSHStreamResponseAssembler ()
/// The core's state, opaque here; NSNull before the first delta.
@property(nonatomic, strong) id state;
@property(nonatomic, copy) NSString *thinkingMode;
@property(nonatomic) NSUInteger maximumBytes;
@property(nonatomic, copy, nullable) NSString *responseId;
@property(nonatomic, copy, nullable) NSString *model;
@end

@implementation DSHStreamResponseAssembler

- (instancetype)initWithThinkingMode:(NSString *)thinkingMode
                        maximumBytes:(NSUInteger)maximumBytes {
  self = [super init];
  if (self) {
    _state = NSNull.null;
    _thinkingMode = [thinkingMode copy] ?: @"off";
    _maximumBytes = maximumBytes;
  }
  return self;
}

/// The wire shape this assembler answers in. `chat-completions` unless a
/// dialect says otherwise; the names are the core's.
- (NSString *)dialect {
  return @"chat-completions";
}

- (void)noteResponseId:(NSString *)responseId model:(NSString *)model {
  if (self.responseId == nil && [responseId isKindOfClass:NSString.class] &&
      responseId.length > 0) self.responseId = responseId;
  if (self.model == nil && [model isKindOfClass:NSString.class] &&
      model.length > 0) self.model = model;
}

- (BOOL)appendDelta:(DSHStreamDelta *)delta error:(NSError **)error {
  if (error != nil) *error = nil;
  if (![delta isKindOfClass:NSDictionary.class]) return YES;
  NSMutableDictionary *envelope = [NSMutableDictionary dictionary];
  envelope[@"op"] = @"assemble_delta";
  envelope[@"state"] = self.state;
  envelope[@"delta"] = delta;
  if (self.responseId != nil) envelope[@"id"] = self.responseId;
  if (self.model != nil) envelope[@"model"] = self.model;
  envelope[@"maximum_bytes"] = @(self.maximumBytes);
  NSError *refused = nil;
  NSDictionary *answer = DSHStreamReduce(envelope, &refused);
  if (answer == nil) {
    if (error != nil) {
      // A budget refusal and an unusable fragment are different things to
      // the transport: one is a reply too large, the other a call that
      // cannot be run.
      *error = [refused.userInfo[DSHStreamFailureReasonKey] isEqual:@"over_budget"]
          ? DSHAssemblerError(2201, @"Streamed response exceeds the byte budget")
          : DSHAssemblerError(2202, @"Streamed tool fragment cannot be placed");
    }
    return NO;
  }
  self.state = answer[@"state"] ?: NSNull.null;
  return YES;
}

- (NSUInteger)accumulatedBytes {
  if (![self.state isKindOfClass:NSDictionary.class]) return 0;
  NSDictionary *state = self.state;
  NSUInteger bytes =
      [[state[@"text"] isKindOfClass:NSString.class] ? state[@"text"] : @""
          lengthOfBytesUsingEncoding:NSUTF8StringEncoding] +
      [[state[@"reasoning"] isKindOfClass:NSString.class] ? state[@"reasoning"] : @""
          lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  for (id call in ([state[@"calls"] isKindOfClass:NSArray.class] ? state[@"calls"] : @[])) {
    if (![call isKindOfClass:NSDictionary.class]) continue;
    NSString *arguments = [call[@"arguments"] isKindOfClass:NSString.class]
        ? call[@"arguments"] : @"";
    bytes += [arguments lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  }
  return bytes;
}

- (NSDictionary<NSString *, id> *)responseObject {
  NSDictionary *answer = DSHStreamReduce(@{
    @"op" : @"stream_finish",
    @"state" : self.state,
    @"thinking_mode" : self.thinkingMode,
    @"dialect" : [self dialect],
    // Missing identity or finish reason is left for the response parser to
    // reject, which is how it names what was missing.
    @"require_identity" : @NO,
  }, nil);
  NSDictionary *response = answer[@"response"];
  return [response isKindOfClass:NSDictionary.class] ? response : @{};
}

@end
