#import "RuntimeEnvironmentDownload.h"
#import "RuntimeEnvironmentPackage.h"
#include <fcntl.h>
#include <unistd.h>

@interface DSHRuntimeEnvironmentDownload () <NSURLSessionDataDelegate, NSURLSessionTaskDelegate>
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionConfiguration *configuration;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, strong) NSURL *destination;
@property(nonatomic, strong) NSNumber *expectedBytes;
@property(nonatomic, strong) NSNumber *totalBytes;
@property(nonatomic, copy) void (^progress)(uint64_t, NSNumber *);
@property(nonatomic, copy) void (^completion)(NSError *);
@property(nonatomic, strong) NSError *failure;
@property(nonatomic) uint64_t downloaded;
@property(nonatomic) int descriptor;
@property(nonatomic) NSUInteger redirects;
@property(nonatomic) BOOL createdDestination;
@property(atomic) BOOL cancelled;
@end

@implementation DSHRuntimeEnvironmentDownload
- (instancetype)init { self = [super init]; if (self) _descriptor = -1; return self; }
- (instancetype)initWithConfiguration:(NSURLSessionConfiguration *)configuration {
  self = [self init]; if (self) _configuration = [configuration copy]; return self;
}
- (void)startURL:(NSString *)url destination:(NSURL *)destination expectedBytes:(NSNumber *)expectedBytes
       progress:(void (^)(uint64_t, NSNumber *))progress completion:(void (^)(NSError *))completion {
  self.destination = destination; self.expectedBytes = expectedBytes;
  self.progress = progress; self.completion = completion;
  if (!DSHEnvironmentValidHTTPSURL(url)) { [self finish:DSHEnvironmentError(@"E_ENV_BAD_ARGUMENTS")]; return; }
  uint64_t required = expectedBytes ? expectedBytes.unsignedLongLongValue : 768ULL * 1024 * 1024;
  if (!DSHEnvironmentHasCapacity(destination.URLByDeletingLastPathComponent, required)) {
    [self finish:DSHEnvironmentError(@"E_ENV_DISK_SPACE")]; return;
  }
  self.descriptor = open(destination.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (self.descriptor < 0) { [self finish:DSHEnvironmentError(@"E_ENV_STORAGE")]; return; }
  self.createdDestination = YES;
  if (!DSHEnvironmentProtectFile(destination)) { [self finish:DSHEnvironmentError(@"E_ENV_STORAGE")]; return; }
  NSURLSessionConfiguration *configuration = self.configuration ?: NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.URLCache = nil; configuration.HTTPCookieStorage = nil;
  configuration.URLCredentialStorage = nil; configuration.HTTPShouldSetCookies = NO;
  configuration.timeoutIntervalForRequest = 60; configuration.timeoutIntervalForResource = 20 * 60;
  NSOperationQueue *queue = [[NSOperationQueue alloc] init]; queue.maxConcurrentOperationCount = 1;
  self.session = [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:queue];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]
      cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:60];
  [request setValue:@"identity" forHTTPHeaderField:@"Accept-Encoding"];
  self.task = [self.session dataTaskWithRequest:request];
  if (self.cancelled) [self.task cancel];
  [self.task resume];
}
- (void)cancel { self.cancelled = YES; [self.task cancel]; }
- (void)finish:(NSError *)error {
  if (self.descriptor >= 0) {
    if (!error && fsync(self.descriptor) != 0) error = DSHEnvironmentError(@"E_ENV_STORAGE");
    close(self.descriptor); self.descriptor = -1;
  }
  if (error && self.createdDestination) unlink(self.destination.fileSystemRepresentation);
  void (^completion)(NSError *) = self.completion;
  self.completion = nil; self.progress = nil;
  [self.session finishTasksAndInvalidate]; self.session = nil; self.task = nil;
  if (completion) completion(error);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  NSHTTPURLResponse *http = [response isKindOfClass:NSHTTPURLResponse.class] ? (id)response : nil;
  int64_t length = response.expectedContentLength;
  NSString *encoding = [http valueForHTTPHeaderField:@"Content-Encoding"];
  if (http.statusCode != 200 || !DSHEnvironmentValidHTTPSURL(response.URL.absoluteString)
      || (encoding.length && ![encoding.lowercaseString isEqual:@"identity"])
      || length > (int64_t)(768ULL * 1024 * 1024)
      || (self.expectedBytes && length >= 0 && (uint64_t)length != self.expectedBytes.unsignedLongLongValue)) {
    self.failure = DSHEnvironmentError(@"E_ENV_DOWNLOAD");
    completionHandler(NSURLSessionResponseCancel); return;
  }
  self.totalBytes = length >= 0 ? @(length) : self.expectedBytes;
  completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  uint64_t limit = self.expectedBytes ? self.expectedBytes.unsignedLongLongValue : 768ULL * 1024 * 1024;
  if (self.cancelled || self.failure) { [task cancel]; return; }
  if (data.length > limit - self.downloaded) {
    self.failure = DSHEnvironmentError(@"E_ENV_PACKAGE_TOO_LARGE"); [task cancel]; return;
  }
  size_t done = 0;
  while (done < data.length) {
    ssize_t count = write(self.descriptor, (const uint8_t *)data.bytes + done, data.length - done);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { self.failure = DSHEnvironmentError(@"E_ENV_STORAGE"); [task cancel]; return; }
    done += count;
  }
  self.downloaded += data.length;
  if (self.progress) self.progress(self.downloaded, self.totalBytes);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
    completionHandler:(void (^)(NSURLRequest *_Nullable))completionHandler {
  self.redirects += 1;
  if (self.redirects > 5 || !DSHEnvironmentValidHTTPSURL(request.URL.absoluteString)) {
    self.failure = DSHEnvironmentError(@"E_ENV_DOWNLOAD"); completionHandler(nil); [task cancel]; return;
  }
  NSMutableURLRequest *safe = [request mutableCopy];
  [safe setValue:nil forHTTPHeaderField:@"Authorization"];
  [safe setValue:@"identity" forHTTPHeaderField:@"Accept-Encoding"];
  completionHandler(safe);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  NSError *failure = self.cancelled ? DSHEnvironmentError(@"E_ENV_CANCELLED") : self.failure;
  if (!failure && (error || self.downloaded == 0 || (self.expectedBytes
      && self.downloaded != self.expectedBytes.unsignedLongLongValue)
      || (self.totalBytes && self.downloaded != self.totalBytes.unsignedLongLongValue)))
    failure = DSHEnvironmentError(@"E_ENV_DOWNLOAD");
  [self finish:failure];
}
@end
