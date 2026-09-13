#import "DSHStreamEvents.h"

#include <math.h>

NSString * const DSHStreamEventErrorDomain = @"DSHStreamEventError";

const NSInteger DSHStreamMaxLineBytes = 262144;        // 256 KiB per SSE line
const NSInteger DSHStreamMaxBufferedLines = 64;        // events held between feeds

static NSError *DSHStreamError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:DSHStreamEventErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

@interface DSHStreamEventParser ()
@property(nonatomic, strong) NSMutableData *pending;
@property(nonatomic, strong) NSMutableArray<NSString *> *eventLines;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, copy, readwrite, nullable) NSString *streamedResponseId;
@property(nonatomic, copy, readwrite, nullable) NSString *streamedModel;
@end

/// Sanitizes one OpenAI-style streamed `tool_calls` fragment into
/// {index, id?, name?, arguments?}. Returns nil for an unusable shape.
static NSDictionary * _Nullable DSHDecodeToolCallFragment(id raw) {
  if (![raw isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *fragment = raw;
  id index = fragment[@"index"];
  if (![index isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)index) == CFBooleanGetTypeID()) return nil;
  double position = [index doubleValue];
  if (position != floor(position) || position < 0 || position > 15) return nil;
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  out[@"index"] = @((NSInteger)position);
  if ([fragment[@"id"] isKindOfClass:NSString.class] &&
      [fragment[@"id"] length] > 0) out[@"id"] = fragment[@"id"];
  NSDictionary *function = [fragment[@"function"] isKindOfClass:NSDictionary.class]
      ? fragment[@"function"] : @{};
  if ([function[@"name"] isKindOfClass:NSString.class] &&
      [function[@"name"] length] > 0) out[@"name"] = function[@"name"];
  if ([function[@"arguments"] isKindOfClass:NSString.class] &&
      [function[@"arguments"] length] > 0) out[@"arguments"] = function[@"arguments"];
  return out;
}

@implementation DSHStreamEventParser

- (instancetype)init {
  self = [super init];
  if (self) {
    _pending = [NSMutableData data];
    _eventLines = [NSMutableArray array];
  }
  return self;
}

- (void)reset {
  self.pending = [NSMutableData data];
  [self.eventLines removeAllObjects];
  self.finished = NO;
  self.streamedResponseId = nil;
  self.streamedModel = nil;
}

- (void)noteChunkIdentity:(NSDictionary *)chunk {
  if (self.streamedResponseId == nil &&
      [chunk[@"id"] isKindOfClass:NSString.class] && [chunk[@"id"] length] > 0) {
    self.streamedResponseId = chunk[@"id"];
  }
  if (self.streamedModel == nil &&
      [chunk[@"model"] isKindOfClass:NSString.class] && [chunk[@"model"] length] > 0) {
    self.streamedModel = chunk[@"model"];
  }
}

/// Decodes one complete SSE event (its accumulated data lines) into a
/// delta dictionary, or nil for keep-alives/comments/blank data.
static DSHStreamDelta * _Nullable DSHDecodeEventLines(
    NSArray<NSString *> *lines, NSDictionary * _Nullable * _Nullable chunkOut,
    NSError **error) {
  if (chunkOut != nil) *chunkOut = nil;
  if (lines.count == 0) return nil;
  NSString *data = [lines componentsJoinedByString:@"\n"];
  if ([data isEqualToString:@"[DONE]"]) {
    return @{@"type": @"done"};
  }
  // Blank data (e.g. a bare "data: " keep-alive) is a legal SSE no-op,
  // not a JSON decode failure.
  if ([[data stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet] length] == 0) {
    return nil;
  }
  NSData *json = [data dataUsingEncoding:NSUTF8StringEncoding];
  if (json == nil) {
    if (error != nil) {
      *error = DSHStreamError(2101, @"SSE event is not valid UTF-8");
    }
    return nil;
  }
  NSError *decodeError = nil;
  NSDictionary *chunk = [NSJSONSerialization JSONObjectWithData:json
      options:0 error:&decodeError];
  if (![chunk isKindOfClass:NSDictionary.class]) {
    if (error != nil) {
      *error = DSHStreamError(2102, @"SSE event is not a JSON object");
    }
    return nil;
  }
  if (chunkOut != nil) *chunkOut = chunk;
  NSArray *choices = [chunk[@"choices"] isKindOfClass:NSArray.class]
      ? chunk[@"choices"] : @[];
  NSDictionary *choice = choices.count > 0 &&
      [choices.firstObject isKindOfClass:NSDictionary.class]
      ? choices.firstObject : nil;
  if (choice == nil) {
    // Rate-limit/style chunks without choices are tolerated as no-ops.
    return nil;
  }
  NSDictionary *delta = [choice[@"delta"] isKindOfClass:NSDictionary.class]
      ? choice[@"delta"] : @{};
  NSString *content = [delta[@"content"] isKindOfClass:NSString.class]
      ? delta[@"content"] : nil;
  NSString *reasoning = [delta[@"reasoning_content"] isKindOfClass:NSString.class]
      ? delta[@"reasoning_content"] : nil;
  NSString *finish = [choice[@"finish_reason"] isKindOfClass:NSString.class]
      ? choice[@"finish_reason"] : nil;
  NSMutableArray *toolCalls = nil;
  if (delta[@"tool_calls"] != nil && delta[@"tool_calls"] != NSNull.null) {
    if (![delta[@"tool_calls"] isKindOfClass:NSArray.class] ||
        [delta[@"tool_calls"] count] > 16) {
      if (error != nil) {
        *error = DSHStreamError(2106, @"SSE tool_calls fragment is not usable");
      }
      return nil;
    }
    toolCalls = [NSMutableArray array];
    for (id raw in delta[@"tool_calls"]) {
      NSDictionary *fragment = DSHDecodeToolCallFragment(raw);
      if (fragment == nil) {
        if (error != nil) {
          *error = DSHStreamError(2106, @"SSE tool_calls fragment is not usable");
        }
        return nil;
      }
      [toolCalls addObject:fragment];
    }
  }
  if ((content == nil || content.length == 0) &&
      (reasoning == nil || reasoning.length == 0) && finish == nil &&
      toolCalls.count == 0) {
    return nil;
  }
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  out[@"type"] = @"delta";
  if (content != nil && content.length > 0) out[@"content"] = content;
  if (reasoning != nil && reasoning.length > 0) out[@"reasoning"] = reasoning;
  if (finish != nil && finish.length > 0) out[@"finish_reason"] = finish;
  if (toolCalls.count > 0) out[@"tool_calls"] = [toolCalls copy];
  return out;
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

  [self.pending appendBytes:bytes length:length];

  NSMutableArray<DSHStreamDelta *> *deltas = [NSMutableArray array];
  while (YES) {
    // Find the next newline in pending.
    const void *base = self.pending.bytes;
    NSUInteger total = self.pending.length;
    const uint8_t *nl = static_cast<const uint8_t *>(
        memchr(base, '\n', total));
    if (nl == nullptr) {
      if (total > (NSUInteger)DSHStreamMaxLineBytes) {
        if (error != nil) {
          *error = DSHStreamError(2104, @"SSE line exceeds the size limit");
        }
        return nil;
      }
      break;
    }
    NSUInteger lineLength = static_cast<NSUInteger>(
        reinterpret_cast<const uint8_t *>(nl) -
        static_cast<const uint8_t *>(base));
    if (lineLength > (NSUInteger)DSHStreamMaxLineBytes) {
      if (error != nil) {
        *error = DSHStreamError(2104, @"SSE line exceeds the size limit");
      }
      return nil;
    }
    NSData *lineData = [NSData dataWithBytes:base length:lineLength];
    NSString *line = [[NSString alloc] initWithData:lineData
                                           encoding:NSUTF8StringEncoding];
    if (line == nil) {
      // Fail closed: an undecodable line must never be mistaken for a
      // blank line (nil.length == 0) or silently dropped.
      if (error != nil) {
        *error = DSHStreamError(2101, @"SSE line is not valid UTF-8");
      }
      return nil;
    }
    // Strip a trailing CR from CRLF transports.
    if ([line hasSuffix:@"\r"]) {
      line = [line substringToIndex:line.length - 1];
    }
    [self.pending replaceBytesInRange:NSMakeRange(0, lineLength + 1)
                            withBytes:nullptr length:0];

    if (line.length == 0) {
      // Blank line: the accumulated event is complete.
      if (self.eventLines.count > 0) {
        if (self.eventLines.count > (NSUInteger)DSHStreamMaxBufferedLines) {
          if (error != nil) {
            *error = DSHStreamError(2105, @"SSE event has too many lines");
          }
          return nil;
        }
        NSDictionary *chunk = nil;
        DSHStreamDelta *delta = DSHDecodeEventLines(self.eventLines, &chunk, error);
        [self.eventLines removeAllObjects];
        if (chunk != nil) [self noteChunkIdentity:chunk];
        if (delta != nil) [deltas addObject:delta];
        else if (error != nil && *error != nil) return nil;
      }
      continue;
    }
    if ([line hasPrefix:@":"]) {
      // SSE comment / keep-alive.
      continue;
    }
    if ([line hasPrefix:@"data:"]) {
      // Enforce the buffered-line cap as lines accumulate, not only when
      // the terminating blank line finally arrives: an unterminated event
      // must not grow the line buffer without bound.
      if (self.eventLines.count >= (NSUInteger)DSHStreamMaxBufferedLines) {
        if (error != nil) {
          *error = DSHStreamError(2105, @"SSE event has too many lines");
        }
        return nil;
      }
      NSString *payload = [line substringFromIndex:5];
      if ([payload hasPrefix:@" "]) payload = [payload substringFromIndex:1];
      [self.eventLines addObject:payload];
      continue;
    }
    // Other field names (event:, id:, retry:) are ignored per SSE spec.
  }
  return deltas.count > 0 ? deltas : @[];
}

- (NSArray<DSHStreamDelta *> *)finish:(NSError **)error {
  if (self.finished) {
    if (error != nil) {
      *error = DSHStreamError(2103, @"Stream already finished");
    }
    return nil;
  }
  self.finished = YES;
  NSMutableArray<DSHStreamDelta *> *deltas = [NSMutableArray array];
  if (self.pending.length > 0) {
    // Tolerate one unterminated final line — but never silently drop
    // bytes that are not valid UTF-8: fail closed instead.
    NSString *line = [[NSString alloc] initWithData:self.pending
                                           encoding:NSUTF8StringEncoding];
    if (line == nil) {
      if (error != nil) {
        *error = DSHStreamError(2101, @"SSE trailing bytes are not valid UTF-8");
      }
      return nil;
    }
    if ([line hasSuffix:@"\r"]) line = [line substringToIndex:line.length - 1];
    if ([line hasPrefix:@"data:"]) {
      NSString *payload = [line substringFromIndex:5];
      if ([payload hasPrefix:@" "]) payload = [payload substringFromIndex:1];
      [self.eventLines addObject:payload];
    }
    self.pending = [NSMutableData data];
  }
  if (self.eventLines.count > 0) {
    NSDictionary *chunk = nil;
    DSHStreamDelta *delta = DSHDecodeEventLines(self.eventLines, &chunk, error);
    [self.eventLines removeAllObjects];
    if (chunk != nil) [self noteChunkIdentity:chunk];
    if (delta != nil) [deltas addObject:delta];
    else if (error != nil && *error != nil) return nil;
  }
  return deltas;
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
