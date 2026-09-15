#import "RuntimeHTTPServer.h"
#import "RuntimeHTTPResponse.h"
#import "RishGuestCgiHTTP.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

static void *QueueKey = &QueueKey;
static const NSUInteger ClientLimit = 8;
static const NSUInteger RequestLimit = 80 * 1024;
static NSTimeInterval Now(void) { return NSProcessInfo.processInfo.systemUptime; }

@interface DSHRuntimeHTTPClient : NSObject
@property(nonatomic) int fd;
@property(nonatomic) BOOL dispatched;
@property(nonatomic) NSTimeInterval deadline;
@property(nonatomic, strong) dispatch_source_t reader;
@property(nonatomic, strong) dispatch_source_t writer;
@property(nonatomic, strong) NSMutableData *input;
@property(nonatomic, copy) NSData *output;
@property(nonatomic) NSUInteger sent;
@end
@implementation DSHRuntimeHTTPClient
@end

@interface DSHRuntimeHTTPServer ()
@property(nonatomic, copy) DSHRuntimeHTTPRequestHandler handler;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) dispatch_source_t listener;
@property(nonatomic, strong) dispatch_source_t timer;
@property(nonatomic, strong) NSMutableSet<DSHRuntimeHTTPClient *> *clients;
@property(nonatomic) int listenerFD;
@property(nonatomic, copy) NSURL *publishedURL;
@property(nonatomic, copy) NSString *cookieName;
@property(nonatomic, copy) NSString *cookieValue;
@end

@implementation DSHRuntimeHTTPServer

- (instancetype)initWithRequestHandler:(DSHRuntimeHTTPRequestHandler)handler {
  self = [super init];
  if (self) {
    _handler = [handler copy]; _listenerFD = -1;
    _clients = [NSMutableSet set];
    _queue = dispatch_queue_create("tech.zseven.rish.runtime-http", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(_queue, QueueKey, (__bridge void *)self, NULL);
  }
  return self;
}
- (void)onQueue:(dispatch_block_t)block {
  if (dispatch_get_specific(QueueKey) == (__bridge void *)self) block();
  else dispatch_sync(self.queue, block);
}
- (NSURL *)url {
  __block NSURL *value = nil; [self onQueue:^{ value = self.publishedURL; }]; return value;
}
- (BOOL)startWithError:(NSError **)error {
  if (error) *error = nil;
  __block BOOL success = NO;
  [self onQueue:^{
    if (self.listenerFD >= 0) { success = YES; return; }
    if (!self.handler) return;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return;
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    if (fcntl(fd, F_SETFL, O_NONBLOCK) != 0) { close(fd); return; }
    struct sockaddr_in address = {};
    address.sin_len = sizeof(address); address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = 0;
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(fd, ClientLimit) != 0) {
      close(fd); return;
    }
    socklen_t count = sizeof(address);
    if (getsockname(fd, (struct sockaddr *)&address, &count) != 0) { close(fd); return; }
    self.listenerFD = fd;
    self.publishedURL = [NSURL URLWithString:[NSString stringWithFormat:
        @"http://127.0.0.1:%u/", ntohs(address.sin_port)]];
    self.cookieName = [@"rish_runtime_" stringByAppendingString:
        [NSUUID.UUID.UUIDString.lowercaseString stringByReplacingOccurrencesOfString:@"-" withString:@""]];
    self.cookieValue = NSUUID.UUID.UUIDString.lowercaseString;
    self.listener = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, fd, 0, self.queue);
    __weak DSHRuntimeHTTPServer *weakSelf = self;
    dispatch_source_set_event_handler(self.listener, ^{ [weakSelf acceptClients]; });
    dispatch_resume(self.listener);
    self.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self.queue);
    dispatch_source_set_timer(self.timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
        NSEC_PER_SEC, 100 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(self.timer, ^{
      DSHRuntimeHTTPServer *owner = weakSelf;
      for (DSHRuntimeHTTPClient *client in owner.clients.allObjects) {
        if (Now() >= client.deadline) {
          if (!client.output) [owner failClient:client status:client.dispatched ? 504 : 408];
          else [owner closeClient:client];
        }
      }
    });
    dispatch_resume(self.timer); success = YES;
  }];
  if (!success && error) *error = [NSError errorWithDomain:@"DSHRuntimeHTTP" code:2
      userInfo:@{NSLocalizedDescriptionKey:@"E_RUNTIME_HTTP_LISTENER"}];
  return success;
}
- (void)stop {
  [self onQueue:^{
    if (self.listener) { dispatch_source_cancel(self.listener); self.listener = nil; }
    if (self.timer) { dispatch_source_cancel(self.timer); self.timer = nil; }
    if (self.listenerFD >= 0) { close(self.listenerFD); self.listenerFD = -1; }
    self.publishedURL = nil; self.cookieValue = nil; self.cookieName = nil;
    for (DSHRuntimeHTTPClient *client in self.clients.allObjects) [self closeClient:client];
  }];
}
- (void)dealloc { [self stop]; }

- (void)acceptClients {
  if (self.listenerFD < 0) return;
  // Each source event does bounded work even under a connection flood.
  for (NSUInteger i = 0; i < ClientLimit * 2; i++) {
    int fd = accept(self.listenerFD, NULL, NULL);
    if (fd < 0) return;
    int yes = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    if (fcntl(fd, F_SETFL, O_NONBLOCK) != 0 || self.clients.count >= ClientLimit) { close(fd); continue; }
    DSHRuntimeHTTPClient *client = [DSHRuntimeHTTPClient new];
    client.fd = fd; client.deadline = Now() + 5; client.input = [NSMutableData data];
    [self.clients addObject:client];
    client.reader = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, fd, 0, self.queue);
    __weak DSHRuntimeHTTPServer *weakSelf = self;
    __weak DSHRuntimeHTTPClient *weakClient = client;
    dispatch_source_set_event_handler(client.reader, ^{ [weakSelf readClient:weakClient]; });
    dispatch_resume(client.reader);
  }
}
- (BOOL)ownsClient:(DSHRuntimeHTTPClient *)client {
  return client && client.fd >= 0 && [self.clients containsObject:client];
}
- (void)closeClient:(DSHRuntimeHTTPClient *)client {
  if (![self ownsClient:client]) return;
  if (client.reader) { dispatch_source_cancel(client.reader); client.reader = nil; }
  if (client.writer) { dispatch_source_cancel(client.writer); client.writer = nil; }
  int fd = client.fd; client.fd = -1;
  [self.clients removeObject:client];
  close(fd); client.input = nil; client.output = nil;
}
- (void)reply:(NSData *)response toClient:(DSHRuntimeHTTPClient *)client {
  if (![self ownsClient:client] || client.output) return;
  client.output = response; client.deadline = Now() + 5;
  if (client.reader) { dispatch_source_cancel(client.reader); client.reader = nil; }
  client.writer = dispatch_source_create(DISPATCH_SOURCE_TYPE_WRITE, client.fd, 0, self.queue);
  __weak DSHRuntimeHTTPServer *weakSelf = self;
  __weak DSHRuntimeHTTPClient *weakClient = client;
  dispatch_source_set_event_handler(client.writer, ^{ [weakSelf writeClient:weakClient]; });
  dispatch_resume(client.writer);
}
- (void)failClient:(DSHRuntimeHTTPClient *)client status:(NSInteger)status {
  NSDictionary *reasons = @{@400:@"Bad Request", @403:@"Forbidden", @408:@"Request Timeout",
      @413:@"Content Too Large", @502:@"Bad Gateway", @504:@"Gateway Timeout"};
  NSString *body = reasons[@(status)] ?: @"Bad Request";
  NSString *http = [NSString stringWithFormat:
      @"HTTP/1.1 %ld %@\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %lu\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n%@",
      (long)status, body, (unsigned long)[body lengthOfBytesUsingEncoding:NSUTF8StringEncoding], body];
  [self reply:[http dataUsingEncoding:NSUTF8StringEncoding] toClient:client];
}
- (void)writeClient:(DSHRuntimeHTTPClient *)client {
  if (![self ownsClient:client] || !client.output) return;
  NSUInteger budget = 64 * 1024;
  while (budget && client.sent < client.output.length) {
    NSUInteger count = MIN(budget, client.output.length - client.sent);
    ssize_t sent = send(client.fd, (const uint8_t *)client.output.bytes + client.sent, count, 0);
    if (sent < 0 && errno == EINTR) continue;
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    if (sent <= 0) { [self closeClient:client]; return; }
    client.sent += (NSUInteger)sent; budget -= (NSUInteger)sent;
  }
  if (client.sent == client.output.length) [self closeClient:client];
}
- (BOOL)cookieMatches:(NSString *)header {
  NSUInteger count = 0; BOOL matches = NO;
  for (NSString *part in [header componentsSeparatedByString:@";"]) {
    NSString *pair = [part stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    NSRange equal = [pair rangeOfString:@"="];
    if (equal.location == NSNotFound) continue;
    if ([[pair substringToIndex:equal.location] isEqual:self.cookieName]) {
      count++; matches = [[pair substringFromIndex:equal.location + 1] isEqual:self.cookieValue];
    }
  }
  return count == 1 && matches;
}
- (void)readClient:(DSHRuntimeHTTPClient *)client {
  if (![self ownsClient:client]) return;
  uint8_t buffer[8192]; NSUInteger budget = RequestLimit + 1; BOOL ended = NO;
  while (budget) {
    ssize_t count = recv(client.fd, buffer, MIN(sizeof(buffer), budget), 0);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
    if (count < 0) { [self closeClient:client]; return; }
    if (count == 0) {
      if (client.reader) { dispatch_source_cancel(client.reader); client.reader = nil; }
      if (client.dispatched) return;
      ended = YES; break;
    }
    if (client.dispatched) { [self closeClient:client]; return; }
    if ((NSUInteger)count > RequestLimit - client.input.length) { [self failClient:client status:413]; return; }
    [client.input appendBytes:buffer length:(NSUInteger)count]; budget -= (NSUInteger)count;
  }
  if (client.dispatched) return;
  RishGuestHttpRequest *request = nil; NSString *failure = nil;
  if (!RishParseGuestHttpRequest(client.input, &request, &failure)) {
    if (!ended && ([failure isEqual:@"incomplete headers"] || [failure isEqual:@"incomplete body"])) return;
    [self failClient:client status:[failure containsString:@"too large"] ? 413 : 400]; return;
  }
  NSUInteger headerEnd = DSHRuntimeHTTPHeaderEnd(client.input);
  NSString *head = [[NSString alloc] initWithBytes:client.input.bytes length:headerEnd encoding:NSUTF8StringEncoding];
  NSArray<NSString *> *lines = [head componentsSeparatedByString:@"\r\n"];
  for (NSUInteger i = 1; i + 2 < lines.count; i++) {
    if (!DSHRuntimeHTTPHeaderLine(lines[i], nil, nil)) { [self failClient:client status:400]; return; }
  }
  if (!DSHRuntimeHTTPToken(request.method) || [request.method isEqual:@"CONNECT"] ||
      ![request.path hasPrefix:@"/"] || [request.path hasPrefix:@"//"] ||
      [request.path containsString:@"#"] || request.headers[@"upgrade"] ||
      request.headers[@"expect"] || request.headers[@"trailer"]) {
    [self failClient:client status:400]; return;
  }
  for (NSUInteger i = 0; i < request.path.length; i++) {
    unichar c = [request.path characterAtIndex:i];
    if (c < 33 || c > 126 || c == '\\') { [self failClient:client status:400]; return; }
  }
  for (NSString *part in [request.headers[@"connection"] componentsSeparatedByString:@","]) {
    NSString *token = [part stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString;
    if (![@[@"close", @"keep-alive"] containsObject:token]) { [self failClient:client status:400]; return; }
  }
  NSString *authority = [NSString stringWithFormat:@"127.0.0.1:%@", self.publishedURL.port];
  NSString *origin = [@"http://" stringByAppendingString:authority];
  BOOL safeMethod = [@[@"GET", @"HEAD", @"OPTIONS"] containsObject:request.method];
  BOOL sameOrigin = [request.headers[@"origin"] isEqual:origin];
  if (![request.headers[@"host"] isEqual:authority] ||
      (request.headers[@"origin"] && !sameOrigin) ||
      (!safeMethod && (!sameOrigin || ![self cookieMatches:request.headers[@"cookie"]]))) {
    [self failClient:client status:403]; return;
  }
  NSMutableArray *forwardedLines = [NSMutableArray arrayWithObject:lines[0]];
  for (NSUInteger i = 1; i + 2 < lines.count; i++) {
    NSString *name = nil; DSHRuntimeHTTPHeaderLine(lines[i], &name, nil);
    if (![@[@"connection", @"proxy-connection", @"keep-alive"] containsObject:name]) [forwardedLines addObject:lines[i]];
  }
  [forwardedLines addObject:@"Connection: close"];
  NSMutableData *forwarded = [[[[forwardedLines componentsJoinedByString:@"\r\n"]
      stringByAppendingString:@"\r\n\r\n"] dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  [forwarded appendData:request.body];
  if (forwarded.length > RequestLimit) { [self failClient:client status:413]; return; }
  client.dispatched = YES; client.deadline = Now() + 40; client.input = nil;
  NSString *cookie = safeMethod ? [NSString stringWithFormat:
      @"Set-Cookie: %@=%@; Path=/; HttpOnly; SameSite=Strict\r\n", self.cookieName, self.cookieValue] : nil;
  DSHRuntimeHTTPRequestHandler handler = self.handler;
  __weak DSHRuntimeHTTPServer *weakSelf = self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    handler(forwarded, ^(NSData *response, NSError *error) {
      DSHRuntimeHTTPServer *owner = weakSelf;
      if (!owner) return;
      dispatch_async(owner.queue, ^{
        // Identity, not an integer descriptor, owns the response. A stopped
        // client can never target another socket that reused its old fd.
        if (![owner ownsClient:client] || client.output) return;
        if (Now() >= client.deadline) { [owner failClient:client status:504]; return; }
        NSData *valid = error ? nil : [DSHRuntimeHTTPServer validateResponse:response requestMethod:request.method error:nil];
        if (!valid) { [owner failClient:client status:502]; return; }
        if (cookie) {
          NSUInteger end = DSHRuntimeHTTPHeaderEnd(valid);
          NSMutableData *withCookie = [[valid subdataWithRange:NSMakeRange(0, end - 2)] mutableCopy];
          [withCookie appendData:[cookie dataUsingEncoding:NSUTF8StringEncoding]];
          [withCookie appendData:[@"\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
          [withCookie appendBytes:(const uint8_t *)valid.bytes + end length:valid.length - end];
          valid = [DSHRuntimeHTTPServer validateResponse:withCookie requestMethod:request.method error:nil];
          if (!valid) { [owner failClient:client status:502]; return; }
        }
        [owner reply:valid toClient:client];
      });
    });
  });
}
+ (NSData *)validateResponse:(NSData *)response requestMethod:(NSString *)method error:(NSError **)error {
  return DSHRuntimeValidateHTTPResponse(response, method, error);
}
@end
