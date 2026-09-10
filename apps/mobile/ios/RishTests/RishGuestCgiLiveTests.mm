#import <XCTest/XCTest.h>

#import <CommonCrypto/CommonDigest.h>
#import <arpa/inet.h>
#import <netinet/in.h>
#import <string.h>
#import <sys/socket.h>
#import <unistd.h>

#import "RishGuestCgiService.h"

static NSData *RishCGISHA256(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableData *result = [NSMutableData dataWithLength:CC_SHA256_DIGEST_LENGTH];
  memcpy(result.mutableBytes, digest, CC_SHA256_DIGEST_LENGTH);
  return result;
}

static NSString *RishCGIHex(NSData *data) {
  const unsigned char *bytes = (const unsigned char *)data.bytes;
  NSMutableString *hex = [NSMutableString stringWithCapacity:data.length * 2];
  for (NSUInteger i = 0; i < data.length; i++) [hex appendFormat:@"%02x", bytes[i]];
  return hex;
}

static BOOL RishCGISendAll(int fd, const uint8_t *bytes, NSUInteger length) {
  NSUInteger offset = 0;
  while (offset < length) {
    ssize_t sent = send(fd, bytes + offset, length - offset, 0);
    if (sent <= 0) return NO;
    offset += (NSUInteger)sent;
  }
  return YES;
}

static NSData *RishCGIHTTP(int port, NSString *host, NSString *origin,
                           NSString *cookie, NSString *method, NSString *path,
                           NSData *body, NSInteger *statusOut,
                           NSDictionary<NSString *, NSString *> **headersOut) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return nil;
  struct timeval timeout = { .tv_sec = 10, .tv_usec = 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
#ifdef SO_NOSIGPIPE
  int noSigPipe = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, sizeof(noSigPipe));
#endif
  struct sockaddr_in address = {};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)port);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { close(fd); return nil; }
  NSMutableString *request = [NSMutableString stringWithFormat:
      @"%@ %@ HTTP/1.1\r\nHost: %@\r\nConnection: close\r\n", method, path, host];
  if (origin) [request appendFormat:@"Origin: %@\r\n", origin];
  if (cookie) [request appendFormat:@"Cookie: %@\r\n", cookie];
  [request appendFormat:@"Content-Length: %lu\r\n\r\n", (unsigned long)body.length];
  NSData *head = [request dataUsingEncoding:NSUTF8StringEncoding];
  BOOL sent = RishCGISendAll(fd, (const uint8_t *)head.bytes, head.length) &&
      RishCGISendAll(fd, (const uint8_t *)body.bytes, body.length);
  if (!sent) { close(fd); return nil; }
  NSMutableData *response = [NSMutableData data];
  uint8_t buffer[4096];
  ssize_t count = 0;
  while ((count = recv(fd, buffer, sizeof(buffer), 0)) > 0) [response appendBytes:buffer length:(NSUInteger)count];
  close(fd);
  const uint8_t *bytes = (const uint8_t *)response.bytes;
  NSUInteger end = NSNotFound;
  for (NSUInteger i = 3; i < response.length; i++) {
    if (bytes[i - 3] == '\r' && bytes[i - 2] == '\n' && bytes[i - 1] == '\r' && bytes[i] == '\n') { end = i + 1; break; }
  }
  if (end == NSNotFound) return nil;
  NSString *headString = [[NSString alloc] initWithBytes:bytes length:end encoding:NSUTF8StringEncoding];
  NSArray<NSString *> *lines = [headString componentsSeparatedByString:@"\r\n"];
  NSArray<NSString *> *statusParts = [lines.firstObject componentsSeparatedByString:@" "];
  if (statusParts.count < 2 || statusOut == NULL) return nil;
  *statusOut = statusParts[1].integerValue;
  NSMutableDictionary *headers = [NSMutableDictionary dictionary];
  for (NSUInteger i = 1; i + 2 < lines.count; i++) {
    NSRange colon = [lines[i] rangeOfString:@":"];
    if (colon.location != NSNotFound) headers[[lines[i] substringToIndex:colon.location].lowercaseString] =
        [[lines[i] substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  }
  if (headersOut) *headersOut = [headers copy];
  NSUInteger contentLength = [headers[@"content-length"] integerValue];
  if (response.length != end + contentLength) return nil;
  return [response subdataWithRange:NSMakeRange(end, contentLength)];
}

static BOOL RishCGIWait(BOOL (^predicate)(void), NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!predicate() && [deadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  return predicate();
}

@interface RishGuestCgiLiveTests : XCTestCase
@end

@implementation RishGuestCgiLiveTests

- (void)testOptInRealGuestCgiCounterOverLoopback {
  NSDictionary *environment = NSProcessInfo.processInfo.environment;
  if (![environment[@"RISH_GUEST_CGI_LIVE"] isEqualToString:@"1"]) {
    XCTSkip(@"Set RISH_GUEST_CGI_LIVE=1 and stage the simulator Documents fixture to run the bounded real guest test.");
  }
  NSString *directory = [NSHomeDirectory() stringByAppendingPathComponent:@"Documents/RishGuestCgiLiveFixture"];
  NSArray<NSString *> *names = @[@"index.html", @"backend.sh", @"initial.json"];
  NSData *sumsData = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"SHA256SUMS"]];
  if (sumsData == nil) XCTSkip(@"No staged RishGuestCgiLiveFixture in the simulator app Documents directory.");
  NSString *sums = [[NSString alloc] initWithData:sumsData encoding:NSUTF8StringEncoding];
  NSMutableDictionary *expected = [NSMutableDictionary dictionary];
  for (NSString *line in [sums componentsSeparatedByString:@"\n"]) {
    NSArray *parts = [line componentsSeparatedByString:@"  "];
    if (parts.count == 2) expected[parts[1]] = parts[0];
  }
  NSMutableDictionary *contents = [NSMutableDictionary dictionary];
  for (NSString *name in names) {
    NSData *data = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:name]];
    XCTAssertNotNil(data, @"fixture file present");
    XCTAssertEqualObjects(RishCGIHex(RishCGISHA256(data)), expected[name], @"fixture digest matches SHA256SUMS");
    contents[name] = data;
  }
  if (!contents[@"index.html"] || !contents[@"backend.sh"] || !contents[@"initial.json"]) return;
  NSData *indexData = contents[@"index.html"];
  NSData *backendData = contents[@"backend.sh"];
  NSData *initialData = contents[@"initial.json"];
  XCTAssertLessThanOrEqual(indexData.length, (NSUInteger)32 * 1024);
  XCTAssertLessThanOrEqual(backendData.length, (NSUInteger)8 * 1024);
  XCTAssertLessThanOrEqual(initialData.length, (NSUInteger)4 * 1024);
  NSString *html = [[NSString alloc] initWithData:indexData encoding:NSUTF8StringEncoding];
  NSString *backend = [[NSString alloc] initWithData:backendData encoding:NSUTF8StringEncoding];
  NSDictionary *initial = [NSJSONSerialization JSONObjectWithData:initialData options:0 error:nil];
  XCTAssertNotNil(html); XCTAssertNotNil(backend); XCTAssertTrue([NSJSONSerialization isValidJSONObject:initial]);
  if (!html || !backend || ![NSJSONSerialization isValidJSONObject:initial]) return;

  RishGuestCgiService *service = [[RishGuestCgiService alloc] init];
  __block NSDictionary *started = nil; __block NSString *startCode = nil;
  XCTestExpectation *startExpectation = [self expectationWithDescription:@"real guest CGI start"];
  [service start:@{ @"indexHtml": html, @"backendScript": backend, @"initialData": initial }
      resolve:^(NSDictionary *result) { started = result; [startExpectation fulfill]; }
       reject:^(NSString *code, NSString *message) { (void)message; startCode = code; [startExpectation fulfill]; }];
  [self waitForExpectations:@[startExpectation] timeout:180.0];
  if (!started || ![started[@"state"] isEqualToString:@"running"]) {
    NSString *pendingServiceID = service.status[@"service_id"];
    if (pendingServiceID.length > 0) {
      XCTestExpectation *cleanup = [self expectationWithDescription:@"cleanup failed real guest CGI start"];
      [service stop:pendingServiceID resolve:^(NSDictionary *result) { (void)result; [cleanup fulfill]; }
           reject:^(NSString *code, NSString *message) { (void)code; (void)message; [cleanup fulfill]; }];
      [self waitForExpectations:@[cleanup] timeout:30.0];
    }
    XCTFail(@"real guest CGI start failed: %@", startCode ?: @"timeout");
    return;
  }
  XCTAssertNil(startCode, @"real guest CGI start succeeds");
  XCTAssertEqualObjects(started[@"state"], @"running");
  NSString *url = started[@"url"];
  NSURLComponents *components = [NSURLComponents componentsWithString:url];
  NSInteger port = components.port.integerValue;
  NSString *host = [NSString stringWithFormat:@"127.0.0.1:%ld", (long)port];
  NSString *origin = [NSString stringWithFormat:@"http://%@", host];
  NSInteger status = 0; NSDictionary *responseHeaders = nil;
  NSData *page = RishCGIHTTP((int)port, host, nil, nil, @"GET", @"/", [NSData data], &status, &responseHeaders);
  XCTAssertEqual(status, (NSInteger)200); XCTAssertEqualObjects(page, [html dataUsingEncoding:NSUTF8StringEncoding]);
  NSString *setCookie = responseHeaders[@"set-cookie"];
  NSString *cookie = [setCookie componentsSeparatedByString:@";"].firstObject;
  XCTAssertTrue(cookie.length > 0);
  NSData *readBody = [@"{\"action\":\"read\"}" dataUsingEncoding:NSUTF8StringEncoding];
  NSData *incBody = [@"{\"action\":\"inc\"}" dataUsingEncoding:NSUTF8StringEncoding];
  NSData *read0 = RishCGIHTTP((int)port, host, origin, cookie, @"POST", @"/api", readBody, &status, NULL);
  XCTAssertEqual(status, (NSInteger)200); XCTAssertEqualObjects(read0, [@"{\"count\":0}\n" dataUsingEncoding:NSUTF8StringEncoding]);
  NSData *inc = RishCGIHTTP((int)port, host, origin, cookie, @"POST", @"/api", incBody, &status, NULL);
  XCTAssertEqual(status, (NSInteger)200); XCTAssertEqualObjects(inc, [@"{\"count\":1}\n" dataUsingEncoding:NSUTF8StringEncoding]);
  NSData *read1 = RishCGIHTTP((int)port, host, origin, cookie, @"POST", @"/api", readBody, &status, NULL);
  XCTAssertEqual(status, (NSInteger)200); XCTAssertEqualObjects(read1, [@"{\"count\":1}\n" dataUsingEncoding:NSUTF8StringEncoding]);

  XCTestExpectation *stopExpectation = [self expectationWithDescription:@"real guest CGI stop"];
  [service stop:started[@"service_id"] resolve:^(NSDictionary *result) { (void)result; [stopExpectation fulfill]; }
       reject:^(NSString *code, NSString *message) { (void)code; (void)message; [stopExpectation fulfill]; }];
  [self waitForExpectations:@[stopExpectation] timeout:30.0];
  XCTAssertTrue(RishCGIWait(^{ int probe = socket(AF_INET, SOCK_STREAM, 0); if (probe < 0) return YES; struct sockaddr_in address = {}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons((uint16_t)port); int result = connect(probe, (struct sockaddr *)&address, sizeof(address)); close(probe); return result != 0; }, 10.0));
}

@end
