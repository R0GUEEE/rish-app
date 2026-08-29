#import "DSHStreamEvents.h"

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
@end

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
}

/// Decodes one complete SSE event (its accumulated data lines) into a
/// delta dictionary, or nil for keep-alives/comments/blank data.
static DSHStreamDelta * _Nullable DSHDecodeEventLines(
    NSArray<NSString *> *lines, NSError **error) {
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
  if ((content == nil || content.length == 0) &&
      (reasoning == nil || reasoning.length == 0) && finish == nil) {
    return nil;
  }
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  out[@"type"] = @"delta";
  if (content != nil && content.length > 0) out[@"content"] = content;
  if (reasoning != nil && reasoning.length > 0) out[@"reasoning"] = reasoning;
  if (finish != nil && finish.length > 0) out[@"finish_reason"] = finish;
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
        DSHStreamDelta *delta = DSHDecodeEventLines(self.eventLines, error);
        [self.eventLines removeAllObjects];
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
    DSHStreamDelta *delta = DSHDecodeEventLines(self.eventLines, error);
    [self.eventLines removeAllObjects];
    if (delta != nil) [deltas addObject:delta];
  }
  return deltas;
}

@end
