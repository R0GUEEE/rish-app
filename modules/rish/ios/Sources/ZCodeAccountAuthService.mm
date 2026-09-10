#import "ZCodeAccountAuthService.h"
#import <Security/Security.h>
#include <math.h>

static NSString *const RishZCodeKeychainService = @"dev.zseven.rish.zcode-account.v1";
static NSError *ZCodeError(NSString *code) { return [NSError errorWithDomain:@"RishZCodeAccount" code:1 userInfo:@{NSLocalizedDescriptionKey: code}]; }
static BOOL ZCodeString(id value, NSUInteger limit) {
  return [value isKindOfClass:NSString.class] && [value length] > 0 && [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= limit && [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound;
}
static NSMutableDictionary *ZCodeKeychainQuery(NSString *provider) {
  return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword, (__bridge id)kSecAttrService:RishZCodeKeychainService, (__bridge id)kSecAttrAccount:provider, (__bridge id)kSecAttrSynchronizable:@NO} mutableCopy];
}
@interface RishZCodeNoRedirect : NSObject <NSURLSessionTaskDelegate>
@end
@implementation RishZCodeNoRedirect
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler { completionHandler(nil); }
@end

@interface RishZCodeAccountAuthService ()
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, copy) RishZCodeRequest request;
@property(nonatomic, copy) RishZCodeRead read;
@property(nonatomic, copy) RishZCodeWrite write;
@property(nonatomic, copy) NSTimeInterval (^clock)(void);
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *flows;
@property(nonatomic) NSUInteger generation;
@end

@implementation RishZCodeAccountAuthService
+ (BOOL)isProvider:(id)provider { return [provider isKindOfClass:NSString.class] && [@[@"bigmodel", @"zai"] containsObject:provider]; }
+ (BOOL)isSafeAuthorizeURL:(NSString *)value provider:(NSString *)provider {
  if (![self isProvider:provider] || !ZCodeString(value, 4096)) return NO;
  NSURLComponents *url = [NSURLComponents componentsWithString:value];
  BOOL bigmodel = [provider isEqual:@"bigmodel"];
  if (![url.scheme isEqual:@"https"] || ![url.host.lowercaseString isEqual:bigmodel ? @"bigmodel.cn" : @"chat.z.ai"] || ![url.path isEqual:bigmodel ? @"/login" : @"/api/oauth/authorize"] || url.port || url.user || url.password || url.fragment) return NO;
  NSSet *keys = [NSSet setWithArray:bigmodel ? @[@"appId", @"redirect", @"state"] : @[@"client_id", @"redirect_uri", @"response_type", @"state"]];
  NSMutableDictionary *items = [NSMutableDictionary dictionary];
  for (NSURLQueryItem *item in url.queryItems) {
    if (![keys containsObject:item.name] || items[item.name] || !ZCodeString(item.value, 4096)) return NO;
    items[item.name] = item.value;
  }
  if (items.count != keys.count || !ZCodeString(items[@"state"], 1024) || (!bigmodel && ![items[@"response_type"] isEqual:@"code"])) return NO;
  NSURLComponents *redirect = [NSURLComponents componentsWithString:items[bigmodel ? @"redirect" : @"redirect_uri"]];
  return [redirect.scheme isEqual:@"https"] && [redirect.host.lowercaseString isEqual:@"zcode.z.ai"] && [redirect.path isEqual:[@"/api/v1/oauth/cli/callback/" stringByAppendingString:provider]] && !redirect.port && !redirect.user && !redirect.password && !redirect.query && !redirect.fragment;
}
- (instancetype)init {
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.URLCache = nil; configuration.HTTPCookieStorage = nil; configuration.HTTPShouldSetCookies = NO;
  configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 25;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:[RishZCodeNoRedirect new] delegateQueue:nil];
  return [self initWithRequest:^NSURLSessionDataTask *(NSURLRequest *request, void (^done)(NSHTTPURLResponse *, NSData *, NSError *)) {
    NSURLSessionDataTask *task = [session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) { done([response isKindOfClass:NSHTTPURLResponse.class] ? (id)response : nil, data, error); }];
    [task resume]; return task;
  } read:^NSData *(NSString *provider, NSError **error) {
    NSMutableDictionary *query = ZCodeKeychainQuery(provider); query[(__bridge id)kSecReturnData] = @YES; query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef result = nil; OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status != errSecSuccess && status != errSecItemNotFound && error) *error = ZCodeError(@"E_ZCODE_AUTH_STORAGE");
    return status == errSecSuccess && result ? CFBridgingRelease(result) : nil;
  } write:^BOOL(NSString *provider, NSData *data, NSError **error) {
    NSMutableDictionary *query = ZCodeKeychainQuery(provider);
    OSStatus status;
    if (!data) { status = SecItemDelete((__bridge CFDictionaryRef)query); if (status == errSecItemNotFound) status = errSecSuccess; }
    else {
      NSDictionary *attributes = @{(__bridge id)kSecValueData:data, (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
      status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
      if (status == errSecItemNotFound) { [query addEntriesFromDictionary:attributes]; status = SecItemAdd((__bridge CFDictionaryRef)query, nil); }
    }
    if (status != errSecSuccess && error) *error = ZCodeError(@"E_ZCODE_AUTH_STORAGE");
    return status == errSecSuccess;
  } clock:^NSTimeInterval { return NSDate.date.timeIntervalSince1970; }];
}
- (instancetype)initWithRequest:(RishZCodeRequest)request read:(RishZCodeRead)read write:(RishZCodeWrite)write clock:(NSTimeInterval (^)(void))clock {
  if ((self = [super init])) { _request = [request copy]; _read = [read copy]; _write = [write copy]; _clock = [clock copy]; _queue = dispatch_queue_create("dev.zseven.rish.zcode-account", DISPATCH_QUEUE_SERIAL); _flows = [NSMutableDictionary dictionary]; }
  return self;
}
- (NSDictionary *)nativeCredentialForProvider:(NSString *)provider error:(NSError **)error {
  if (![self.class isProvider:provider]) { if (error) *error = ZCodeError(@"E_ZCODE_AUTH_PROVIDER"); return nil; }
  NSData *data = self.read(provider, error);
  if (!data) return nil;
  if (data.length > 65536) { if (error) *error = ZCodeError(@"E_ZCODE_AUTH_STORAGE"); return nil; }
  NSDictionary *value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class] || ![value[@"schema_version"] isEqual:@1] || ![value[@"provider"] isEqual:provider] || !ZCodeString(value[@"zcode_token"], 16384) || !ZCodeString(value[@"provider_access_token"], 16384) || !ZCodeString(value[@"account_label"], 120)) { if (error) *error = ZCodeError(@"E_ZCODE_AUTH_STORAGE"); return nil; }
  return value;
}
- (NSDictionary *)safeStatus:(NSString *)provider {
  NSError *error = nil;
  NSDictionary *credential = [self nativeCredentialForProvider:provider error:&error];
  NSMutableDictionary *flow = self.flows[provider];
  if ([flow[@"status"] isEqual:@"pending"] && self.clock() >= [flow[@"expires_at"] doubleValue]) {
    [flow[@"task"] cancel]; [self fail:flow provider:provider code:@"E_ZCODE_AUTH_EXPIRED"];
  }
  NSString *state = flow[@"status"] ?: (credential ? @"signed_in" : error ? @"failed" : @"signed_out");
  BOOL signedIn = [state isEqual:@"signed_in"] && credential != nil;
  return @{ @"schema_version": @1, @"provider": provider, @"status": state, @"mode": signedIn ? @"account_only" : (id)NSNull.null, @"account_label": signedIn ? credential[@"account_label"] : (id)NSNull.null, @"authorize_url": [state isEqual:@"pending"] ? (flow[@"authorize_url"] ?: NSNull.null) : NSNull.null, @"expires_at": [state isEqual:@"pending"] ? (flow[@"expires_at"] ?: NSNull.null) : NSNull.null, @"error_code": flow[@"error_code"] ?: (error ? @"E_ZCODE_AUTH_STORAGE" : (id)NSNull.null) };
}
- (NSDictionary *)statusForProvider:(NSString *)provider {
  __block NSDictionary *result; dispatch_sync(self.queue, ^{ result = [self safeStatus:provider]; }); return result;
}
- (BOOL)isCurrent:(NSMutableDictionary *)flow provider:(NSString *)provider { return self.flows[provider] == flow; }
- (void)fail:(NSMutableDictionary *)flow provider:(NSString *)provider code:(NSString *)code {
  if (![self isCurrent:flow provider:provider]) return;
  [flow removeObjectForKey:@"bearer"]; [flow removeObjectForKey:@"flow_id"]; [flow removeObjectForKey:@"task"];
  flow[@"status"] = [code isEqual:@"E_ZCODE_AUTH_EXPIRED"] ? @"expired" : @"failed"; flow[@"error_code"] = code;
}
- (NSDictionary *)decoded:(NSHTTPURLResponse *)response data:(NSData *)data error:(NSError *)error {
  if (error || response.statusCode != 200 || !data || data.length > 128 * 1024) return nil;
  NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [json isKindOfClass:NSDictionary.class] && [json[@"code"] isEqual:@0] && [json[@"data"] isKindOfClass:NSDictionary.class] ? json[@"data"] : nil;
}
- (void)startForProvider:(NSString *)provider completion:(void (^)(NSDictionary *))completion {
  dispatch_async(self.queue, ^{
    if (![self.class isProvider:provider]) { completion(@{ @"error_code": @"E_ZCODE_AUTH_PROVIDER" }); return; }
    // One explicit login at a time; invalidate all previous callbacks.
    for (NSMutableDictionary *old in self.flows.allValues) [old[@"task"] cancel];
    [self.flows removeAllObjects]; NSUInteger generation = ++self.generation;
    unsigned char random[32];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof(random), random) != errSecSuccess) { self.flows[provider] = [@{ @"status": @"failed", @"error_code": @"E_ZCODE_AUTH_RANDOM" } mutableCopy]; completion([self safeStatus:provider]); return; }
    NSMutableString *bearer = [NSMutableString stringWithCapacity:64]; for (NSUInteger i = 0; i < sizeof(random); i++) [bearer appendFormat:@"%02x", random[i]];
    NSMutableDictionary *flow = [@{ @"generation": @(generation), @"status": @"starting", @"bearer": bearer } mutableCopy]; self.flows[provider] = flow;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://zcode.z.ai/api/v1/oauth/cli/init"]]; request.HTTPMethod = @"POST";
    [request setValue:[@"Bearer " stringByAppendingString:bearer] forHTTPHeaderField:@"Authorization"]; [request setValue:@"Rish/1.0 account-login" forHTTPHeaderField:@"User-Agent"]; [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{ @"provider": provider } options:0 error:nil];
    NSURLSessionDataTask *task = self.request(request, ^(NSHTTPURLResponse *response, NSData *data, NSError *error) {
      dispatch_async(self.queue, ^{
        if (![self isCurrent:flow provider:provider]) { completion([self safeStatus:provider]); return; }
        NSDictionary *value = [self decoded:response data:data error:error];
        NSString *identifier = value[@"flow_id"], *url = value[@"authorize_url"];
        NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet];
        double expiry = [value[@"expires_at"] isKindOfClass:NSNumber.class] ? [value[@"expires_at"] doubleValue] : 0;
        if (!ZCodeString(identifier, 256) || [identifier rangeOfCharacterFromSet:invalid].location != NSNotFound || ![self.class isSafeAuthorizeURL:url provider:provider] || !isfinite(expiry) || expiry <= self.clock() || expiry > self.clock() + 3600 || (value[@"poll_token"] && ![value[@"poll_token"] isEqual:bearer])) {
          [self fail:flow provider:provider code:@"E_ZCODE_AUTH_RESPONSE"]; completion([self safeStatus:provider]); return;
        }
        flow[@"flow_id"] = identifier; flow[@"authorize_url"] = url; flow[@"expires_at"] = @(expiry); flow[@"status"] = @"pending";
        double interval = [value[@"poll_interval_sec"] isKindOfClass:NSNumber.class] ? [value[@"poll_interval_sec"] doubleValue] : 3;
        flow[@"interval"] = @(isfinite(interval) ? MIN(30.0, MAX(1.0, interval)) : 3.0);
        completion([self safeStatus:provider]); [self schedulePoll:flow provider:provider];
      });
    });
    if (task) flow[@"task"] = task;
  });
}
- (void)schedulePoll:(NSMutableDictionary *)flow provider:(NSString *)provider {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)([flow[@"interval"] doubleValue] * NSEC_PER_SEC)), self.queue, ^{ [self poll:flow provider:provider]; });
}
- (void)poll:(NSMutableDictionary *)flow provider:(NSString *)provider {
  if (![self isCurrent:flow provider:provider] || ![flow[@"status"] isEqual:@"pending"]) return;
  if (self.clock() >= [flow[@"expires_at"] doubleValue]) { [self fail:flow provider:provider code:@"E_ZCODE_AUTH_EXPIRED"]; return; }
  NSString *url = [@"https://zcode.z.ai/api/v1/oauth/cli/poll/" stringByAppendingString:flow[@"flow_id"]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]];
  [request setValue:[@"Bearer " stringByAppendingString:flow[@"bearer"]] forHTTPHeaderField:@"Authorization"]; [request setValue:@"Rish/1.0 account-login" forHTTPHeaderField:@"User-Agent"];
  NSURLSessionDataTask *task = self.request(request, ^(NSHTTPURLResponse *response, NSData *data, NSError *error) {
    dispatch_async(self.queue, ^{
      if (![self isCurrent:flow provider:provider]) return;
      if (self.clock() >= [flow[@"expires_at"] doubleValue]) { [self fail:flow provider:provider code:@"E_ZCODE_AUTH_EXPIRED"]; return; }
      if (error || response.statusCode == 429 || (response.statusCode >= 500 && response.statusCode < 600)) {
        flow[@"interval"] = @(MIN(30.0, [flow[@"interval"] doubleValue] * 2.0));
        [self schedulePoll:flow provider:provider]; return;
      }
      NSDictionary *value = [self decoded:response data:data error:error];
      NSString *state = value[@"status"] ?: value[@"state"];
      if ([state isEqual:@"pending"]) { [self schedulePoll:flow provider:provider]; return; }
      if (![state isEqual:@"ready"]) { [self fail:flow provider:provider code:@"E_ZCODE_AUTH_POLL"]; return; }
      NSDictionary *user = [value[@"user"] isKindOfClass:NSDictionary.class] ? value[@"user"] : nil;
      NSDictionary *account = [value[provider] isKindOfClass:NSDictionary.class] ? value[provider] : nil;
      NSString *access = account[@"access_token"] ?: account[@"accessToken"];
      NSString *refresh = account[@"refresh_token"] ?: account[@"refreshToken"];
      NSString *label = ZCodeString(user[@"name"], 120) ? user[@"name"] : (ZCodeString(user[@"email"], 120) ? user[@"email"] : @"ZCode account");
      if (!ZCodeString(value[@"token"], 16384) || !ZCodeString(access, 16384) || !ZCodeString(user[@"user_id"], 256) || (refresh && refresh != (id)NSNull.null && !ZCodeString(refresh, 16384))) { [self fail:flow provider:provider code:@"E_ZCODE_AUTH_RESPONSE"]; return; }
      NSDictionary *credential = @{ @"schema_version": @1, @"provider": provider, @"zcode_token": value[@"token"], @"provider_access_token": access, @"provider_refresh_token": refresh ?: NSNull.null, @"user_id": user[@"user_id"], @"account_label": label };
      NSData *encoded = [NSJSONSerialization dataWithJSONObject:credential options:0 error:nil];
      if (!encoded || encoded.length > 65536) { [self fail:flow provider:provider code:@"E_ZCODE_AUTH_RESPONSE"]; return; }
      if (!self.write(provider, encoded, nil)) { [self fail:flow provider:provider code:@"E_ZCODE_AUTH_STORAGE"]; return; }
      [self.flows removeObjectForKey:provider];
      if (self.onAccountConnected) self.onAccountConnected(provider);
    });
  });
  if (task) flow[@"task"] = task;
}
- (void)cancelForProvider:(NSString *)provider completion:(void (^)(NSDictionary *))completion {
  dispatch_async(self.queue, ^{ ++self.generation; [self.flows[provider][@"task"] cancel]; [self.flows removeObjectForKey:provider]; completion([self safeStatus:provider]); });
}
- (void)logoutForProvider:(NSString *)provider completion:(void (^)(NSDictionary *))completion {
  dispatch_async(self.queue, ^{ ++self.generation; [self.flows[provider][@"task"] cancel]; [self.flows removeObjectForKey:provider]; NSError *error = nil; if (!self.write(provider, nil, &error)) self.flows[provider] = [@{ @"status": @"failed", @"error_code": @"E_ZCODE_AUTH_STORAGE" } mutableCopy]; completion([self safeStatus:provider]); });
}
@end
