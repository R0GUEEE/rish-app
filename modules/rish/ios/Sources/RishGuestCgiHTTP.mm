#import "RishGuestCgiHTTP.h"

NSUInteger const RishGuestHttpMaxHeaderBytes = 16 * 1024;
NSUInteger const RishGuestHttpMaxBodyBytes = 64 * 1024;

@implementation RishGuestHttpRequest
@end

static BOOL RishHttpToken(NSString *value) {
  if (value.length == 0) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  return [value rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

static void RishHttpFail(NSString **errorMessage, NSString *message) {
  if (errorMessage) *errorMessage = message;
}

BOOL RishParseGuestHttpRequest(NSData *data,
                               RishGuestHttpRequest **request,
                               NSString **errorMessage) {
  if (request) *request = nil;
  if (errorMessage) *errorMessage = nil;
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger length = data.length;
  NSUInteger headerEnd = NSNotFound;
  NSUInteger searchLimit = MIN(length, RishGuestHttpMaxHeaderBytes);
  for (NSUInteger i = 3; i < searchLimit; i++) {
    if (bytes[i - 3] == '\r' && bytes[i - 2] == '\n' && bytes[i - 1] == '\r' && bytes[i] == '\n') {
      headerEnd = i + 1;
      break;
    }
  }
  if (headerEnd == NSNotFound) {
    RishHttpFail(errorMessage, length > RishGuestHttpMaxHeaderBytes ? @"headers too large" : @"incomplete headers");
    return NO;
  }
  NSString *head = [[NSString alloc] initWithBytes:bytes length:headerEnd encoding:NSUTF8StringEncoding];
  if (!head || [head rangeOfString:@"\0"].location != NSNotFound) {
    RishHttpFail(errorMessage, @"headers are not UTF-8");
    return NO;
  }
  NSArray<NSString *> *lines = [head componentsSeparatedByString:@"\r\n"];
  if (lines.count < 2) { RishHttpFail(errorMessage, @"missing request line"); return NO; }
  NSArray<NSString *> *first = [lines[0] componentsSeparatedByString:@" "];
  if (first.count != 3 || ![first[2] isEqualToString:@"HTTP/1.1"] ||
      first[0].length == 0 || first[1].length == 0) {
    RishHttpFail(errorMessage, @"malformed request line");
    return NO;
  }
  NSMutableDictionary<NSString *, NSString *> *headers = [NSMutableDictionary dictionary];
  NSUInteger contentLength = 0;
  BOOL sawContentLength = NO;
  for (NSUInteger i = 1; i + 2 < lines.count; i++) {
    NSString *line = lines[i];
    NSRange colon = [line rangeOfString:@":"];
    if (colon.location == NSNotFound || colon.location == 0) {
      RishHttpFail(errorMessage, @"malformed header"); return NO;
    }
    NSString *name = [line substringToIndex:colon.location];
    NSString *lowerName = name.lowercaseString;
    if (!RishHttpToken(name)) { RishHttpFail(errorMessage, @"invalid header name"); return NO; }
    NSString *value = [[line substringFromIndex:colon.location + 1]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    if ([lowerName isEqualToString:@"transfer-encoding"]) {
      RishHttpFail(errorMessage, @"transfer encoding is not supported"); return NO;
    }
    if ([lowerName isEqualToString:@"content-length"]) {
      if (sawContentLength || value.length == 0) {
        RishHttpFail(errorMessage, @"duplicate or empty Content-Length"); return NO;
      }
      sawContentLength = YES;
      unsigned long long parsed = 0;
      for (NSUInteger j = 0; j < value.length; j++) {
        unichar c = [value characterAtIndex:j];
        if (c < '0' || c > '9' || parsed > (UINT64_MAX - (c - '0')) / 10) {
          RishHttpFail(errorMessage, @"invalid Content-Length"); return NO;
        }
        parsed = parsed * 10 + (c - '0');
      }
      if (parsed > RishGuestHttpMaxBodyBytes) {
        RishHttpFail(errorMessage, @"body too large"); return NO;
      }
      contentLength = (NSUInteger)parsed;
    }
    if (headers[lowerName]) {
      RishHttpFail(errorMessage, @"duplicate header"); return NO;
    }
    headers[lowerName] = value;
  }
  if (length != headerEnd + contentLength) {
    RishHttpFail(errorMessage, length < headerEnd + contentLength ? @"incomplete body" : @"trailing request bytes");
    return NO;
  }
  RishGuestHttpRequest *parsed = [RishGuestHttpRequest new];
  parsed.method = first[0];
  parsed.path = first[1];
  parsed.headers = [headers copy];
  parsed.body = [data subdataWithRange:NSMakeRange(headerEnd, contentLength)];
  if (request) *request = parsed;
  return YES;
}
