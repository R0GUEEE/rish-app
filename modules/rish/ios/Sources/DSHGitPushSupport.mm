#import "DSHGitPushSupport.h"

#import <Security/Security.h>
#import <arpa/inet.h>
#import <dispatch/dispatch.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <unistd.h>

#include <atomic>
#include <math.h>
#include <string.h>

NSString *const DSHGitPushCredentialService = @"dev.zseven.rish.git.https";

static NSError *DSHGitPushSupportError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"DSHGitPushSupport" code:code
      userInfo:@{ NSLocalizedDescriptionKey : message }];
}

// MARK: - Remote URL validation

static BOOL DSHGitPushHasControlCharacter(NSString *value) {
  for (NSUInteger index = 0; index < value.length; index += 1) {
    unichar character = [value characterAtIndex:index];
    if (character < 0x20 || character == 0x7F) return YES;
  }
  return NO;
}

static BOOL DSHGitPushIsPublicDNSName(NSString *host) {
  if (host.length == 0 || host.length > 253 || DSHGitPushHasControlCharacter(host)) return NO;
  NSArray<NSString *> *labels = [host componentsSeparatedByString:@"."];
  if (labels.count < 2) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
    @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
  for (NSString *label in labels) {
    if (label.length == 0 || label.length > 63 || [label hasPrefix:@"-"]
      || [label hasSuffix:@"-"]
      || [label rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return NO;
  }
  return YES;
}

/// Loopback, RFC1918, link-local, and site-local literals plus "localhost".
/// These are the only hosts a plain http:// test remote may use.
static BOOL DSHGitPushIsPrivateLiteral(NSString *host) {
  if ([host isEqualToString:@"localhost"]) return YES;
  const char *bytes = host.UTF8String;
  if (bytes == nullptr) return NO;
  struct in_addr v4 = {};
  if (inet_pton(AF_INET, bytes, &v4) == 1) {
    uint32_t ip = ntohl(v4.s_addr);
    if ((ip & 0xFF000000u) == 0x7F000000u) return YES;  // 127/8
    if ((ip & 0xFF000000u) == 0x0A000000u) return YES;  // 10/8
    if ((ip & 0xFFF00000u) == 0xAC100000u) return YES;  // 172.16/12
    if ((ip & 0xFFFF0000u) == 0xC0A80000u) return YES;  // 192.168/16
    if ((ip & 0xFFFF0000u) == 0xA9FE0000u) return YES;  // 169.254/16
    return NO;
  }
  struct in6_addr v6 = {};
  if (inet_pton(AF_INET6, bytes, &v6) == 1) {
    if (IN6_IS_ADDR_LOOPBACK(&v6) || IN6_IS_ADDR_LINKLOCAL(&v6)) return YES;
    return (v6.s6_addr[0] & 0xFE) == 0xFC;  // ULA fc00::/7
  }
  return NO;
}

NSURL *DSHGitValidatedRemoteURL(id value, NSError **error) {
  NSString *input = [value isKindOfClass:NSString.class] ? value : @"";
  NSString *trimmed = [input stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (input.length == 0 || input.length > 4096 || DSHGitPushHasControlCharacter(input)
    || [input containsString:@"\\"] || ![input isEqualToString:trimmed]) {
    if (error != nil) *error = DSHGitPushSupportError(3002, @"Remote URL is invalid");
    return nil;
  }
  NSURLComponents *components = [NSURLComponents componentsWithString:input];
  NSString *scheme = components.scheme.lowercaseString;
  NSString *host = components.host.lowercaseString;
  NSString *path = components.path;
  BOOL validPort = components.port == nil
      ? YES : (components.port.integerValue >= 1 && components.port.integerValue <= 65535);
  BOOL httpsValid = [scheme isEqualToString:@"https"] && DSHGitPushIsPublicDNSName(host)
      && (components.port == nil || components.port.integerValue == 443);
  BOOL httpValid = [scheme isEqualToString:@"http"] && DSHGitPushIsPrivateLiteral(host)
      && validPort;
  BOOL valid = (httpsValid || httpValid) && components.user == nil
    && components.password == nil && components.query == nil
    && components.fragment == nil && path.length > 1 && path.length <= 2048
    && !DSHGitPushHasControlCharacter(path);
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if ([component isEqualToString:@"."] || [component isEqualToString:@".."]) valid = NO;
  }
  if (!valid || components.URL == nil) {
    if (error != nil) *error = DSHGitPushSupportError(3002, @"Remote URL is invalid");
    return nil;
  }
  components.scheme = scheme;
  components.host = host;
  return components.URL;
}

// MARK: - Keychain credential store

static BOOL DSHGitPushValidUsername(NSString *username) {
  if (username.length == 0 || username.length > 255 || DSHGitPushHasControlCharacter(username)
    || [username rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location
      != NSNotFound) return NO;
  NSCharacterSet *forbidden = [NSCharacterSet characterSetWithCharactersInString:@":/@\\"];
  return [username rangeOfCharacterFromSet:forbidden].location == NSNotFound;
}

static BOOL DSHGitPushValidToken(NSString *token) {
  NSUInteger bytes = [token lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  return bytes >= 8 && bytes <= 4096 && !DSHGitPushHasControlCharacter(token)
    && [token rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location
      == NSNotFound;
}

NSString *DSHGitCredentialAccountForScope(NSString *workspaceId, NSString *host) {
  return [NSString stringWithFormat:@"workspace:%@|host:%@", workspaceId,
      host.lowercaseString];
}

static NSMutableDictionary *DSHGitPushKeychainQuery(NSString *account) {
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : DSHGitPushCredentialService,
    (__bridge id)kSecAttrAccount : account,
    (__bridge id)kSecAttrSynchronizable : @NO,
  } mutableCopy];
}

NSDictionary *DSHGitCredentialForScope(NSString *workspaceId, NSString *host,
                                       NSError **error) {
  if (workspaceId.length == 0 || host.length == 0) return nil;
  NSMutableDictionary *query = DSHGitPushKeychainQuery(
      DSHGitCredentialAccountForScope(workspaceId, host));
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status != errSecSuccess || result == nullptr) {
    if (result != nullptr) CFRelease(result);
    if (status != errSecSuccess && status != errSecItemNotFound && error != nil) {
      *error = DSHGitPushSupportError(3016, @"Git credential status is unavailable");
    }
    return nil;
  }
  NSData *data = CFBridgingRelease(result);
  if (data.length == 0 || data.length > 8192) return nil;
  NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![payload isKindOfClass:NSDictionary.class] ||
      ![payload[@"schema_version"] isEqual:@2]) return nil;
  NSString *username = [payload[@"username"] isKindOfClass:NSString.class]
      ? payload[@"username"] : nil;
  NSString *token = [payload[@"token"] isKindOfClass:NSString.class]
      ? payload[@"token"] : nil;
  NSNumber *expiresAt = [payload[@"expires_at"] isKindOfClass:NSNumber.class]
      ? payload[@"expires_at"] : nil;
  NSNumber *expirySeconds = [payload[@"expiry_seconds"] isKindOfClass:NSNumber.class]
      ? payload[@"expiry_seconds"] : nil;
  if (!DSHGitPushValidUsername(username) || !DSHGitPushValidToken(token) ||
      expiresAt == nil || expirySeconds == nil ||
      expiresAt.doubleValue <= 0 || expirySeconds.integerValue <= 0) return nil;
  if (expiresAt.doubleValue <= NSDate.date.timeIntervalSince1970) {
    (void)DSHGitDeleteCredentialForScope(workspaceId, host, nil);
    return nil;
  }
  return @{ @"username" : username, @"token" : token, @"expires_at" : expiresAt,
            @"expiry_seconds" : expirySeconds };
}

BOOL DSHGitStoreCredentialForScope(NSString *workspaceId, NSString *host,
                                   NSString *username, NSString *token,
                                   NSInteger expirySeconds, NSError **error) {
  if (!DSHGitPushValidUsername(username) || !DSHGitPushValidToken(token) ||
      (expirySeconds != DSHGitCredentialExpiryOneHour &&
       expirySeconds != DSHGitCredentialExpiryOneDay &&
       expirySeconds != DSHGitCredentialExpirySevenDays) ||
      workspaceId.length == 0 || host.length == 0) {
    if (error != nil) *error = DSHGitPushSupportError(3012, @"Git credential is invalid");
    return NO;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"schema_version" : @2,
    @"username" : username,
    @"token" : token,
    @"expires_at" : @(floor(NSDate.date.timeIntervalSince1970) + expirySeconds),
    @"expiry_seconds" : @(expirySeconds),
  } options:NSJSONWritingSortedKeys error:nil];
  if (data == nil || data.length > 8192) {
    if (error != nil) *error = DSHGitPushSupportError(3012, @"Git credential is invalid");
    return NO;
  }
  NSMutableDictionary *query = DSHGitPushKeychainQuery(
      DSHGitCredentialAccountForScope(workspaceId, host));
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query,
    (__bridge CFDictionaryRef)@{ (__bridge id)kSecValueData : data });
  if (status == errSecItemNotFound) {
    query[(__bridge id)kSecValueData] = data;
    query[(__bridge id)kSecAttrAccessible]
      = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
    status = SecItemAdd((__bridge CFDictionaryRef)query, nil);
  }
  if (status != errSecSuccess) {
    if (error != nil) *error = DSHGitPushSupportError(3013, @"Git credential cannot be saved");
    return NO;
  }
  return YES;
}

BOOL DSHGitDeleteCredentialForScope(NSString *workspaceId, NSString *host,
                                    NSError **error) {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)DSHGitPushKeychainQuery(
      DSHGitCredentialAccountForScope(workspaceId, host)));
  if (status != errSecSuccess && status != errSecItemNotFound) {
    if (error != nil) *error = DSHGitPushSupportError(3014, @"Git credential cannot be cleared");
    return NO;
  }
  return YES;
}

BOOL DSHGitDeleteLegacyHostCredential(NSString *host, NSError **error) {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)DSHGitPushKeychainQuery(
      host.lowercaseString));
  if (status != errSecSuccess && status != errSecItemNotFound) {
    if (error != nil) *error = DSHGitPushSupportError(3014, @"Git credential cannot be cleared");
    return NO;
  }
  return YES;
}

// MARK: - Bounded push runner

@implementation DSHGitPushCancelToken {
  std::atomic<bool> _cancelled;
}

- (instancetype)init {
  self = [super init];
  if (self) _cancelled = false;
  return self;
}

- (BOOL)cancelled {
  return _cancelled.load();
}

- (void)cancel {
  _cancelled.store(true);
}

@end

@implementation DSHGitPushRequest

- (instancetype)init {
  self = [super init];
  if (self) _timeout = 60.0;
  return self;
}

@end

@implementation DSHGitPushResult
@end

typedef struct {
  __unsafe_unretained NSString *host;
  __unsafe_unretained NSString *username;
  __unsafe_unretained NSString *token;
  bool attempted;
} DSHGitPushCredentialPayload;

typedef struct {
  const char *targetRef;
  bool targetRejected;
  bool malformed;
} DSHGitPushUpdateState;

typedef struct {
  DSHGitPushCredentialPayload credential;
  DSHGitPushUpdateState update;
} DSHGitPushCallbacksPayload;

static int DSHGitPushCredentialCallback(git_credential **out,
                                         const char *url,
                                         const char *usernameFromURL,
                                         unsigned int allowedTypes,
                                         void *rawPayload) {
  (void)usernameFromURL;
  DSHGitPushCallbacksPayload *payload =
      static_cast<DSHGitPushCallbacksPayload *>(rawPayload);
  DSHGitPushCredentialPayload *credential = &payload->credential;
  NSString *urlString = url == nullptr ? nil : [NSString stringWithUTF8String:url];
  NSURL *validated = DSHGitValidatedRemoteURL(urlString, nil);
  if (validated == nil ||
      ![validated.host.lowercaseString isEqualToString:credential->host]) {
    return GIT_EAUTH;
  }
  if (allowedTypes & GIT_CREDENTIAL_USERPASS_PLAINTEXT) {
    if (credential->attempted) return GIT_EAUTH;
    credential->attempted = true;
    return git_credential_userpass_plaintext_new(
        out, credential->username.UTF8String, credential->token.UTF8String);
  }
  if (allowedTypes & GIT_CREDENTIAL_USERNAME) {
    return git_credential_username_new(out, credential->username.UTF8String);
  }
  return GIT_PASSTHROUGH;
}

static int DSHGitPushUpdateReference(const char *refname,
                                      const char *status,
                                      void *rawPayload) {
  DSHGitPushCallbacksPayload *payload =
      static_cast<DSHGitPushCallbacksPayload *>(rawPayload);
  DSHGitPushUpdateState *state = &payload->update;
  if (refname == nullptr) {
    state->malformed = true;
    return 0;
  }
  if (strcmp(refname, state->targetRef) == 0 && status != nullptr) {
    state->targetRejected = true;
  }
  return 0;
}

static dispatch_queue_t DSHGitPushWorkerQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("dev.zseven.rish.git-push", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

static NSString *DSHGitPushAdvertisedOID(git_repository *repository,
                                          NSString *remoteName,
                                          NSString *fullReference,
                                          int *codeOut) {
  git_remote *remote = nullptr;
  git_remote_callbacks callbacks = {};
  git_proxy_options proxy = {};
  callbacks.version = GIT_REMOTE_CALLBACKS_VERSION;
  proxy.version = GIT_PROXY_OPTIONS_VERSION;
  proxy.type = GIT_PROXY_NONE;
  int code = git_remote_lookup(&remote, repository, remoteName.UTF8String);
  if (code == 0) {
    code = git_remote_connect(remote, GIT_DIRECTION_FETCH, &callbacks, &proxy,
                              nullptr);
  }
  const git_remote_head **heads = nullptr;
  size_t count = 0;
  if (code == 0) code = git_remote_ls(&heads, &count, remote);
  NSString *resolved = nil;
  if (code == 0) {
    for (size_t index = 0; index < count; index += 1) {
      if (heads[index] != nullptr && heads[index]->name != nullptr &&
          strcmp(heads[index]->name, fullReference.UTF8String) == 0) {
        char buffer[GIT_OID_SHA1_HEXSIZE + 1] = {};
        git_oid_tostr(buffer, sizeof(buffer), &heads[index]->oid);
        resolved = [NSString stringWithUTF8String:buffer];
        break;
      }
    }
  }
  if (remote != nullptr) {
    git_remote_disconnect(remote);
    git_remote_free(remote);
  }
  if (codeOut != nullptr) *codeOut = code;
  return resolved;
}

DSHGitPushResult *DSHGitPushRun(DSHGitPushRequest *request) {
  DSHGitPushResult *result = [[DSHGitPushResult alloc] init];
  result.outcome = DSHGitPushOutcomeFailed;
  if (request == nil || request.repository == nullptr ||
      request.remoteName.length == 0 || request.remoteURL.length == 0 ||
      request.fullReference.length == 0) {
    return result;
  }
  NSTimeInterval timeout = request.timeout > 0 ? request.timeout : 60.0;
  __block DSHGitPushOutcome settledOutcome = DSHGitPushOutcomeFailed;
  __block NSString *settledOID = nil;
  __block BOOL settled = NO;
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  dispatch_async(DSHGitPushWorkerQueue(), ^{
    @autoreleasepool {
      DSHGitPushOutcome outcome = DSHGitPushOutcomeFailed;
      NSString *remoteOID = nil;
      DSHGitPushCallbacksPayload callbacksPayload = {
        { request.host, request.username, request.token, false },
        { request.fullReference.UTF8String, false, false },
      };
      git_remote *remote = nullptr;
      int resultCode = git_remote_lookup(&remote, request.repository,
                                         request.remoteName.UTF8String);
      if (resultCode == 0) {
        resultCode = git_remote_set_instance_url(remote,
            request.remoteURL.UTF8String);
      }
      if (resultCode == 0) {
        resultCode = git_remote_set_instance_pushurl(remote,
            request.remoteURL.UTF8String);
      }
      git_push_options pushOptions = {};
      if (resultCode == 0) {
        resultCode = git_push_options_init(&pushOptions, GIT_PUSH_OPTIONS_VERSION);
      }
      if (resultCode == 0) {
        pushOptions.follow_redirects = GIT_REMOTE_REDIRECT_NONE;
        pushOptions.proxy_opts.type = request.proxyURL.length > 0
            ? GIT_PROXY_SPECIFIED : GIT_PROXY_NONE;
        pushOptions.proxy_opts.url = request.proxyURL.UTF8String;
        if (request.token.length > 0) {
          pushOptions.callbacks.credentials = DSHGitPushCredentialCallback;
        }
        pushOptions.callbacks.push_update_reference = DSHGitPushUpdateReference;
        pushOptions.callbacks.payload = &callbacksPayload;
      }
      NSString *refspecValue = [NSString stringWithFormat:@"%@:%@",
          request.fullReference, request.fullReference];
      char *rawRefspec = const_cast<char *>(refspecValue.UTF8String);
      git_strarray refspecs = { &rawRefspec, 1 };
      if (resultCode == 0) {
        resultCode = git_remote_upload(remote, &refspecs, &pushOptions);
      }
      if (remote != nullptr) {
        git_remote_disconnect(remote);
        git_remote_free(remote);
      }
      if (resultCode == GIT_ENONFASTFORWARD) {
        outcome = DSHGitPushOutcomeNonFastForward;
      } else if (resultCode == GIT_EAUTH) {
        outcome = DSHGitPushOutcomeAuthFailure;
      } else if (resultCode != 0) {
        outcome = callbacksPayload.update.targetRejected
            ? DSHGitPushOutcomeRejected : DSHGitPushOutcomeFailed;
      } else if (callbacksPayload.update.targetRejected ||
                 callbacksPayload.update.malformed) {
        outcome = DSHGitPushOutcomeRejected;
      } else {
        int verifyCode = 0;
        remoteOID = DSHGitPushAdvertisedOID(request.repository,
            request.remoteName, request.fullReference, &verifyCode);
        if (verifyCode == 0 && remoteOID.length > 0 &&
            [remoteOID isEqualToString:request.localOID]) {
          outcome = DSHGitPushOutcomeSuccess;
        }
      }
      settledOutcome = outcome;
      settledOID = remoteOID;
      settled = YES;
      dispatch_semaphore_signal(semaphore);
      if (request.completion != nil) request.completion(outcome, remoteOID);
    }
  });
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!settled) {
    if (request.cancelToken != nil && request.cancelToken.cancelled) {
      result.outcome = DSHGitPushOutcomeCancelled;
      return result;
    }
    if ([NSDate.date compare:deadline] != NSOrderedAscending) {
      result.outcome = DSHGitPushOutcomeTimedOut;
      return result;
    }
    dispatch_time_t step = dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC);
    if (dispatch_semaphore_wait(semaphore, step) == 0) break;
  }
  result.outcome = settledOutcome;
  result.remoteOID = settledOID;
  return result;
}

// MARK: - Receipt journal

static NSString *const DSHGitPushReceiptFilename = @"git-push-receipts.json";
static NSString *const DSHGitPushReceiptTempFilename = @"git-push-receipts.json.tmp";
static NSUInteger const DSHGitPushMaxReceipts = 25;
static NSUInteger const DSHGitPushMaxReceiptJournalBytes = 262144;

static BOOL DSHGitPushValidOID(NSString *oid) {
  if (oid.length != 40) return NO;
  NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:
      @"0123456789abcdef"];
  return [oid rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

static BOOL DSHGitPushValidReceipt(NSDictionary *receipt) {
  if (![receipt isKindOfClass:NSDictionary.class] ||
      ![receipt[@"schema_version"] isEqual:@1] ||
      ![receipt[@"remote"] isEqual:@"origin"] ||
      ![receipt[@"host"] isKindOfClass:NSString.class] ||
      ((NSString *)receipt[@"host"]).length == 0 ||
      ((NSString *)receipt[@"host"]).length > 253 ||
      DSHGitPushHasControlCharacter(receipt[@"host"]) ||
      ![receipt[@"branch"] isKindOfClass:NSString.class] ||
      ((NSString *)receipt[@"branch"]).length == 0 ||
      ((NSString *)receipt[@"branch"]).length > 1024 ||
      DSHGitPushHasControlCharacter(receipt[@"branch"]) ||
      [((NSString *)receipt[@"branch"]) containsString:@".."] ||
      ![DSHGitPushValidOID(receipt[@"local_oid"])] ||
      ![DSHGitPushValidOID(receipt[@"remote_oid"])] ||
      ![receipt[@"pushed_at"] isKindOfClass:NSString.class] ||
      ((NSString *)receipt[@"pushed_at"]).length == 0 ||
      ((NSString *)receipt[@"pushed_at"]).length > 64 ||
      DSHGitPushHasControlCharacter(receipt[@"pushed_at"])) {
    return NO;
  }
  return YES;
}

static NSArray<NSDictionary *> *DSHGitPushLoadReceiptsInternal(
    int projectDescriptor, NSString *projectId, BOOL allowMissing,
    NSError **error) {
  if (projectDescriptor < 0 || projectId.length == 0) {
    if (error != nil) *error = DSHGitPushSupportError(3020, @"Receipt storage is unavailable");
    return nil;
  }
  int descriptor = openat(projectDescriptor, DSHGitPushReceiptFilename.UTF8String,
      O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    if (errno == ENOENT && allowMissing) return @[];
    if (error != nil) *error = DSHGitPushSupportError(3020, @"Receipt storage is unavailable");
    return nil;
  }
  struct stat identity = {};
  BOOL safe = fstat(descriptor, &identity) == 0 && S_ISREG(identity.st_mode) &&
      identity.st_size >= 0 && identity.st_size <= (off_t)DSHGitPushMaxReceiptJournalBytes;
  NSData *data = nil;
  if (safe) {
    NSFileHandle *handle = [[NSFileHandle alloc] initWithFileDescriptor:descriptor
                                                          closeOnDealloc:YES];
    data = handle == nil ? nil : [handle readDataToEndOfFile];
    [handle closeFile];
    if (data.length > DSHGitPushMaxReceiptJournalBytes) data = nil;
  } else {
    close(descriptor);
  }
  NSDictionary *journal = data == nil ? nil
      : [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  NSArray *receipts = [journal isKindOfClass:NSDictionary.class] ?
      journal[@"receipts"] : nil;
  if (![journal isKindOfClass:NSDictionary.class] ||
      ![journal[@"schema_version"] isEqual:@1] ||
      ![journal[@"project_id"] isEqual:projectId] ||
      ![receipts isKindOfClass:NSArray.class] ||
      receipts.count > DSHGitPushMaxReceipts) {
    if (error != nil) *error = DSHGitPushSupportError(3021, @"Receipt journal is invalid");
    return nil;
  }
  for (NSDictionary *receipt in receipts) {
    if (!DSHGitPushValidReceipt(receipt)) {
      if (error != nil) *error = DSHGitPushSupportError(3021, @"Receipt journal is invalid");
      return nil;
    }
  }
  return receipts;
}

static BOOL DSHGitPushWriteAll(int descriptor, const void *bytes, size_t length) {
  const uint8_t *cursor = static_cast<const uint8_t *>(bytes);
  size_t remaining = length;
  while (remaining > 0) {
    ssize_t written = write(descriptor, cursor, remaining);
    if (written < 0) {
      if (errno == EINTR) continue;
      return NO;
    }
    cursor += written;
    remaining -= (size_t)written;
  }
  return YES;
}

BOOL DSHGitPushRecordReceipt(int projectDescriptor, NSString *projectId,
                             NSDictionary *receipt, NSError **error) {
  if (!DSHGitPushValidReceipt(receipt)) {
    if (error != nil) *error = DSHGitPushSupportError(3021, @"Receipt journal is invalid");
    return NO;
  }
  NSError *loadError = nil;
  NSArray<NSDictionary *> *existing = DSHGitPushLoadReceiptsInternal(
      projectDescriptor, projectId, YES, &loadError);
  if (existing == nil) {
    if (error != nil) *error = loadError ?: DSHGitPushSupportError(3020,
        @"Receipt storage is unavailable");
    return NO;
  }
  NSArray *receipts = [existing arrayByAddingObject:receipt];
  if (receipts.count > DSHGitPushMaxReceipts) {
    receipts = [receipts subarrayWithRange:
        NSMakeRange(receipts.count - DSHGitPushMaxReceipts, DSHGitPushMaxReceipts)];
  }
  NSDictionary *journal = @{
    @"schema_version" : @1,
    @"project_id" : projectId,
    @"receipts" : receipts,
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:journal
      options:NSJSONWritingSortedKeys error:nil];
  if (data == nil || data.length > DSHGitPushMaxReceiptJournalBytes) {
    if (error != nil) *error = DSHGitPushSupportError(3021, @"Receipt journal is invalid");
    return NO;
  }
  int descriptor = openat(projectDescriptor,
      DSHGitPushReceiptTempFilename.UTF8String,
      O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0 || !DSHGitPushWriteAll(descriptor, data.bytes, data.length) ||
      fsync(descriptor) != 0 || close(descriptor) != 0) {
    if (descriptor >= 0) close(descriptor);
    unlinkat(projectDescriptor, DSHGitPushReceiptTempFilename.UTF8String, 0);
    if (error != nil) *error = DSHGitPushSupportError(3020, @"Receipt storage is unavailable");
    return NO;
  }
  if (renameat(projectDescriptor, DSHGitPushReceiptTempFilename.UTF8String,
               projectDescriptor, DSHGitPushReceiptFilename.UTF8String) != 0 ||
      fsync(projectDescriptor) != 0) {
    unlinkat(projectDescriptor, DSHGitPushReceiptTempFilename.UTF8String, 0);
    if (error != nil) *error = DSHGitPushSupportError(3020, @"Receipt storage is unavailable");
    return NO;
  }
  return YES;
}

NSArray<NSDictionary *> *DSHGitPushLoadReceipts(int projectDescriptor,
                                                NSString *projectId,
                                                NSError **error) {
  NSArray<NSDictionary *> *receipts = DSHGitPushLoadReceiptsInternal(
      projectDescriptor, projectId, NO, error);
  return receipts == nil ? nil : receipts;
}

