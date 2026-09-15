#import "RuntimeHTTPResponse.h"

static const NSUInteger HeaderLimit = 16 * 1024;
static const NSUInteger ResponseLimit = 1024 * 1024;

BOOL DSHRuntimeHTTPToken(NSString *value) {
  if (value.length == 0) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  return [value rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

BOOL DSHRuntimeHTTPHeaderLine(NSString *line, NSString **name, NSString **value) {
  NSRange colon = [line rangeOfString:@":"];
  if (colon.location == NSNotFound || colon.location == 0) return NO;
  NSString *key = [line substringToIndex:colon.location];
  if (!DSHRuntimeHTTPToken(key)) return NO;
  NSString *raw = [line substringFromIndex:colon.location + 1];
  for (NSUInteger i = 0; i < raw.length; i++) {
    unichar c = [raw characterAtIndex:i];
    if ((c < 32 && c != '\t') || c == 127) return NO;
  }
  if (name) *name = key.lowercaseString;
  if (value) *value = [raw stringByTrimmingCharactersInSet:
      [NSCharacterSet characterSetWithCharactersInString:@" \t"]];
  return YES;
}

NSUInteger DSHRuntimeHTTPHeaderEnd(NSData *data) {
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  for (NSUInteger i = 3; i < MIN(data.length, HeaderLimit); i++) {
    if (bytes[i-3] == '\r' && bytes[i-2] == '\n' && bytes[i-1] == '\r' && bytes[i] == '\n') return i + 1;
  }
  return NSNotFound;
}

static BOOL Decimal(NSString *value, uint64_t *output) {
  if (value.length == 0) return NO;
  uint64_t n = 0;
  for (NSUInteger i = 0; i < value.length; i++) {
    unichar c = [value characterAtIndex:i];
    if (c < '0' || c > '9' || n > (UINT64_MAX - (c - '0')) / 10) return NO;
    n = n * 10 + c - '0';
  }
  *output = n; return YES;
}

static BOOL TokenByte(uint8_t c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') ||
      (c >= 'a' && c <= 'z') || (c && strchr("!#$%&'*+-.^_`|~", c));
}

static BOOL ChunkExtensions(const uint8_t *bytes, NSUInteger begin, NSUInteger end) {
  NSUInteger i = begin;
  while (i < end) {
    if (bytes[i++] != ';') return NO;
    while (i < end && (bytes[i] == ' ' || bytes[i] == '\t')) i++;
    NSUInteger start = i;
    while (i < end && TokenByte(bytes[i])) i++;
    if (i == start) return NO;
    while (i < end && (bytes[i] == ' ' || bytes[i] == '\t')) i++;
    if (i < end && bytes[i] == '=') {
      i++;
      while (i < end && (bytes[i] == ' ' || bytes[i] == '\t')) i++;
      if (i < end && bytes[i] == '"') {
        i++; BOOL closed = NO;
        while (i < end) {
          uint8_t c = bytes[i++];
          if (c == '"') { closed = YES; break; }
          if (c == '\\') { if (i == end) return NO; c = bytes[i++]; }
          if ((c < 32 && c != '\t') || c > 126) return NO;
        }
        if (!closed) return NO;
      } else {
        start = i; while (i < end && TokenByte(bytes[i])) i++;
        if (i == start) return NO;
      }
      while (i < end && (bytes[i] == ' ' || bytes[i] == '\t')) i++;
    }
  }
  return YES;
}

static BOOL Chunked(NSData *data, NSUInteger offset) {
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger chunks = 0;
  while (offset < data.length && ++chunks <= 8192) {
    NSUInteger end = offset;
    while (end + 1 < data.length && end - offset < 1024 &&
        !(bytes[end] == '\r' && bytes[end+1] == '\n')) end++;
    if (end + 1 >= data.length || end - offset >= 1024) return NO;
    uint64_t count = 0; NSUInteger hexEnd = offset;
    while (hexEnd < end && bytes[hexEnd] != ';') {
      uint8_t c = bytes[hexEnd++];
      unsigned int digit = c >= '0' && c <= '9' ? c - '0' :
          c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 16;
      if (digit == 16 || count > (ResponseLimit - digit) / 16) return NO;
      count = count * 16 + digit;
    }
    if (hexEnd == offset) return NO;
    if (!ChunkExtensions(bytes, hexEnd, end)) return NO;
    offset = end + 2;
    if (count == 0) {
      NSUInteger trailerStart = offset;
      while (offset + 1 < data.length && offset - trailerStart <= HeaderLimit) {
        end = offset;
        while (end + 1 < data.length && end - trailerStart <= HeaderLimit &&
            !(bytes[end] == '\r' && bytes[end+1] == '\n')) end++;
        if (end + 1 >= data.length || end - trailerStart > HeaderLimit) return NO;
        if (end == offset) return end + 2 == data.length;
        NSString *line = [[NSString alloc] initWithBytes:bytes + offset length:end - offset
            encoding:NSISOLatin1StringEncoding];
        NSString *name = nil;
        if (!DSHRuntimeHTTPHeaderLine(line, &name, nil) ||
            [@[@"content-length", @"transfer-encoding", @"connection", @"host", @"upgrade",
               @"trailer", @"set-cookie"] containsObject:name]) return NO;
        offset = end + 2;
      }
      return NO;
    }
    if (count > data.length - offset || data.length - offset - count < 2) return NO;
    offset += (NSUInteger)count;
    if (bytes[offset] != '\r' || bytes[offset+1] != '\n') return NO;
    offset += 2;
  }
  return NO;
}

NSData *DSHRuntimeValidateHTTPResponse(NSData *response, NSString *method, NSError **error) {
  if (error) *error = nil;
  auto fail = [&]() -> NSData * {
    if (error) *error = [NSError errorWithDomain:@"DSHRuntimeHTTP" code:1
        userInfo:@{NSLocalizedDescriptionKey:@"E_RUNTIME_HTTP_RESPONSE"}];
    return nil;
  };
  if (![response isKindOfClass:NSData.class] || response.length > ResponseLimit ||
      !DSHRuntimeHTTPToken(method)) return fail();
  NSUInteger offset = DSHRuntimeHTTPHeaderEnd(response);
  if (offset == NSNotFound) return fail();
  NSString *head = [[NSString alloc] initWithBytes:response.bytes length:offset
      encoding:NSISOLatin1StringEncoding];
  NSArray<NSString *> *lines = [head componentsSeparatedByString:@"\r\n"];
  NSString *status = lines.firstObject;
  if (status.length < 12 || !([status hasPrefix:@"HTTP/1.1 "] || [status hasPrefix:@"HTTP/1.0 "])) return fail();
  for (NSUInteger i = 0; i < status.length; i++) {
    unichar c = [status characterAtIndex:i]; if (c < 32 || c > 126) return fail();
  }
  if ([status characterAtIndex:9] < '2' || [status characterAtIndex:9] > '5' ||
      [status characterAtIndex:10] < '0' || [status characterAtIndex:10] > '9' ||
      [status characterAtIndex:11] < '0' || [status characterAtIndex:11] > '9' ||
      (status.length > 12 && [status characterAtIndex:12] != ' ')) return fail();
  NSInteger code = [[status substringWithRange:NSMakeRange(9, 3)] integerValue];
  NSString *lengthValue = nil; NSString *encoding = nil;
  NSMutableArray *preserved = [NSMutableArray arrayWithObject:status];
  NSMutableSet *connectionNames = [NSMutableSet setWithArray:@[@"connection", @"keep-alive", @"proxy-connection"]];
  for (NSUInteger i = 1; i + 2 < lines.count; i++) {
    NSString *name = nil; NSString *value = nil;
    if (!DSHRuntimeHTTPHeaderLine(lines[i], &name, &value)) return fail();
    if ([name isEqual:@"upgrade"]) return fail();
    if ([name isEqual:@"content-length"]) { if (lengthValue) return fail(); lengthValue = value; }
    if ([name isEqual:@"transfer-encoding"]) { if (encoding) return fail(); encoding = value.lowercaseString; }
    if ([name isEqual:@"connection"]) {
      for (NSString *part in [value componentsSeparatedByString:@","]) {
        NSString *token = [part stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString;
        if (!DSHRuntimeHTTPToken(token) || [@[@"content-length", @"transfer-encoding", @"set-cookie", @"upgrade"] containsObject:token]) return fail();
        [connectionNames addObject:token];
      }
    }
  }
  uint64_t length = 0;
  if ((lengthValue && !Decimal(lengthValue, &length)) ||
      (encoding && (![encoding isEqual:@"chunked"] || lengthValue))) return fail();
  NSUInteger bodyLength = response.length - offset;
  BOOL noBody = [method isEqual:@"HEAD"] || code == 204 || code == 304;
  if (noBody) {
    if (bodyLength != 0 || (code == 204 && (encoding || lengthValue))) return fail();
  } else if (encoding) {
    if (!Chunked(response, offset)) return fail();
  } else if (lengthValue && length != bodyLength) return fail();
  if (code == 205 && bodyLength != 0) return fail();
  for (NSUInteger i = 1; i + 2 < lines.count; i++) {
    NSString *name = nil; DSHRuntimeHTTPHeaderLine(lines[i], &name, nil);
    if (![connectionNames containsObject:name]) [preserved addObject:lines[i]];
  }
  [preserved addObject:@"Connection: close"];
  NSString *updated = [[preserved componentsJoinedByString:@"\r\n"] stringByAppendingString:@"\r\n\r\n"];
  NSMutableData *output = [[updated dataUsingEncoding:NSISOLatin1StringEncoding] mutableCopy];
  [output appendBytes:(const uint8_t *)response.bytes + offset length:bodyLength];
  if (output.length > ResponseLimit) return fail();
  return output;
}
