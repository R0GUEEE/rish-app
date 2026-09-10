#import "ZCodePlanResolver.h"

#import "ZCodeAccountAuthService.h"
#import <Security/Security.h>
#import <os/log.h>

#include <math.h>

static NSString *const ZCodePlanErrorDomain = @"RishZCodePlan";
static NSString *const ZCodeBigModel = @"bigmodel";
static NSString *const ZCodeZai = @"zai";
static NSString *const ZCodeBigModelBase = @"https://bigmodel.cn";
static NSString *const ZCodeZaiBase = @"https://api.z.ai";
static NSString *const ZCodeTrialBase = @"https://zcode.z.ai";

static NSError *ZCodePlanError(NSString *code) {
  return [NSError errorWithDomain:ZCodePlanErrorDomain code:1
                          userInfo:@{NSLocalizedDescriptionKey : code}];
}

static BOOL ZCodePlanProvider(NSString *provider) {
  return [provider isEqual:ZCodeBigModel] || [provider isEqual:ZCodeZai];
}
static BOOL ZCodeTrialSource(NSString *source) {
  return [source isEqual:@"bigmodel_trial"] || [source isEqual:@"zai_trial"];
}
static NSString *ZCodeTrialProvider(NSString *source) {
  if ([source isEqual:@"bigmodel_trial"]) return ZCodeBigModel;
  if ([source isEqual:@"zai_trial"]) return ZCodeZai;
  return nil;
}

static NSDictionary *ZCodePlanEnvelope(NSHTTPURLResponse *response, NSData *data, NSError *error) {
  if (error || response.statusCode != 200 || !data || data.length > 128 * 1024) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class]) return nil;
  id code = value[@"code"];
  if (![code isEqual:@0] && ![code isEqual:@200]) return nil;
  if ([value[@"success"] isEqual:@NO]) return nil;
  return value;
}

static BOOL ZCodePlanIdentifier(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length == 0 || value.length > 256 ||
      [value isEqual:@"."] || [value isEqual:@".."]) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-."] invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static NSString *ZCodePlanString(id value, NSUInteger maxBytes) {
  NSString *string = [value isKindOfClass:NSString.class] ? value : nil;
  if (string.length == 0 || [string lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > maxBytes ||
      [string rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return nil;
  return string;
}
static double ZCodeFiniteNumber(id value) {
  double number = -1;
  if ([value isKindOfClass:NSNumber.class]) {
    if (CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return -1;
    number = [value doubleValue];
  } else if ([value isKindOfClass:NSString.class]) {
    NSScanner *scanner = [NSScanner scannerWithString:value];
    if (![scanner scanDouble:&number] || !scanner.isAtEnd) return -1;
  }
  return isfinite(number) ? number : -1;
}

static NSTimeInterval ZCodePlanExplicitExpiry(NSDictionary *plan) {
  id value = plan[@"expires_at"] ?: plan[@"expireAt"] ?: plan[@"endTime"];
  if (!value || value == (id)NSNull.null) return 0;
  if ([value isKindOfClass:NSNumber.class]) {
    double seconds = [value doubleValue];
    if (!isfinite(seconds) || seconds <= 0) return -1;
    return seconds > 1e11 ? seconds / 1000 : seconds;
  }
  NSString *string = [value isKindOfClass:NSString.class] ? value : nil;
  if (string.length == 0) return -1;
  NSScanner *scanner = [NSScanner scannerWithString:string];
  double seconds = 0;
  if ([scanner scanDouble:&seconds] && scanner.isAtEnd)
    return !isfinite(seconds) || seconds <= 0 ? -1 : seconds > 1e11 ? seconds / 1000 : seconds;
  NSDate *date = [[NSISO8601DateFormatter new] dateFromString:string];
  return date ? date.timeIntervalSince1970 : -1;
}

@interface RishZCodePlanResolver ()
@property(nonatomic, strong) RishZCodeAccountAuthService *accountAuth;
@property(nonatomic, copy) RishZCodePlanRequest request;
@property(nonatomic, copy) NSTimeInterval (^clock)(void);
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *safeStatuses;
@end

@implementation RishGlmCredentialSelection
- (NSMutableDictionary *)query {
  return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:@"dev.zseven.rish.glm-selection.v1",
    (__bridge id)kSecAttrAccount:@"selection", (__bridge id)kSecAttrSynchronizable:@NO} mutableCopy];
}
- (NSDictionary *)read {
  NSMutableDictionary *query = [self query];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef raw = nil;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
  if (status == errSecItemNotFound) return @{@"schema_version":@1, @"source":@"api_key"};
  if (status != errSecSuccess || !raw) return nil;
  NSData *data = CFBridgingRelease(raw);
  if (data.length > 65536) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class] || ![value[@"schema_version"] isEqual:@1] ||
      ![@[@"api_key", @"bigmodel", @"zai", @"bigmodel_trial", @"zai_trial"] containsObject:value[@"source"]]) return nil;
  return value;
}
- (BOOL)write:(NSDictionary *)value error:(NSError **)error {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:error];
  if (!data || data.length > 65536) return NO;
  NSMutableDictionary *query = [self query];
  NSDictionary *attributes = @{(__bridge id)kSecValueData:data,
    (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
  OSStatus result = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
  if (result == errSecItemNotFound) { [query addEntriesFromDictionary:attributes]; result = SecItemAdd((__bridge CFDictionaryRef)query, nil); }
  if (result != errSecSuccess && error) *error = ZCodePlanError(@"E_ZCODE_PLAN_STORAGE");
  return result == errSecSuccess;
}
- (NSString *)source { return [self read][@"source"]; }
- (NSArray<NSString *> *)allowedModels {
  id models = [self read][@"allowed_models"];
  return [models isKindOfClass:NSArray.class] ? models : nil;
}
- (NSString *)credentialWithAccountAuth:(RishZCodeAccountAuthService *)auth {
  NSDictionary *value = [self read];
  NSString *source = value[@"source"];
  NSString *provider = ZCodePlanProvider(source) ? source : ZCodeTrialProvider(source);
  if (!provider) return nil;
  NSDictionary *account = [auth nativeCredentialForProvider:provider error:nil];
  if (![value[@"account_id"] isEqual:account[@"user_id"]] ||
      ![value[@"verified_until"] isKindOfClass:NSNumber.class] ||
      [value[@"verified_until"] doubleValue] <= NSDate.date.timeIntervalSince1970) return nil;
  return ZCodePlanString(value[@"credential"], 16384);
}
- (BOOL)selectAPIKey:(NSError **)error {
  return [self write:@{@"schema_version":@1, @"source":@"api_key"} error:error];
}
- (BOOL)selectProviderPending:(NSString *)provider error:(NSError **)error {
  return ZCodePlanProvider(provider) &&
    [self write:@{@"schema_version":@1, @"source":provider} error:error];
}
- (BOOL)selectTrialPending:(NSString *)provider error:(NSError **)error {
  if (!ZCodePlanProvider(provider)) return NO;
  return [self write:@{@"schema_version":@1, @"source":[provider stringByAppendingString:@"_trial"]} error:error];
}
- (BOOL)selectPlan:(NSDictionary *)plan account:(NSDictionary *)account error:(NSError **)error {
  NSString *provider = plan[@"provider"];
  BOOL trial = [plan[@"credential_source"] isEqual:@"trial"];
  NSString *source = trial && ZCodePlanProvider(provider) ? [provider stringByAppendingString:@"_trial"] : provider;
  NSString *credential = ZCodePlanString(plan[@"credential"], 16384);
  NSString *accountID = ZCodePlanString(account[@"user_id"], 256);
  if ((!ZCodePlanProvider(source) && !ZCodeTrialSource(source)) || ![provider isEqual:account[@"provider"]] || !credential || !accountID) return NO;
  NSTimeInterval until = NSDate.date.timeIntervalSince1970 + 900;
  if ([plan[@"expires_at"] isKindOfClass:NSNumber.class] && [plan[@"expires_at"] doubleValue] > 0)
    until = MIN(until, [plan[@"expires_at"] doubleValue]);
  NSMutableDictionary *value = [@{@"schema_version":@1, @"source":source, @"credential":credential,
    @"account_id":accountID, @"verified_until":@(until)} mutableCopy];
  if ([plan[@"allowed_models"] isKindOfClass:NSArray.class]) value[@"allowed_models"] = plan[@"allowed_models"];
  return [self write:value error:error];
}
- (void)clearCredentialForProvider:(NSString *)provider {
  NSString *source = [self source];
  if ([source isEqual:provider] || [source isEqual:[provider stringByAppendingString:@"_trial"]])
    [self write:@{@"schema_version":@1, @"source":source} error:nil];
}
@end

@implementation RishZCodePlanResolver

- (instancetype)initWithAccountAuth:(RishZCodeAccountAuthService *)accountAuth
                             request:(RishZCodePlanRequest)request
                               clock:(NSTimeInterval (^)(void))clock {
  if ((self = [super init])) {
    _accountAuth = accountAuth;
    _request = [request copy];
    _clock = [clock copy];
    _queue = dispatch_queue_create("dev.zseven.rish.zcode-plan", DISPATCH_QUEUE_SERIAL);
    _safeStatuses = [NSMutableDictionary dictionary];
  }
  return self;
}

- (NSDictionary *)statusForProvider:(NSString *)provider {
  __block NSDictionary *status = nil;
  dispatch_sync(self.queue, ^{
    status = self.safeStatuses[provider] ?: @{
      @"schema_version" : @1, @"provider" : provider ?: NSNull.null,
      @"status" : @"unavailable", @"credential_source" : NSNull.null,
      @"account_label" : NSNull.null, @"organization_id" : NSNull.null,
      @"project_id" : NSNull.null, @"expires_at" : NSNull.null,
    };
  });
  return status;
}

- (void)resolveCodingPlanForProvider:(NSString *)provider
                          completion:(void (^)(NSDictionary *_Nullable, NSError *_Nullable))completion {
  dispatch_async(self.queue, ^{
    if (!ZCodePlanProvider(provider) || self.request == nil) { completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_PROVIDER")); return; }
    [self.safeStatuses removeObjectForKey:provider];
    NSError *credentialError = nil;
    NSDictionary *account = [self.accountAuth nativeCredentialForProvider:provider error:&credentialError];
    NSString *businessToken = ZCodePlanString(account[@"zcode_token"], 16384);
    NSString *oauthAccess = ZCodePlanString(account[@"provider_access_token"], 16384);
    if (businessToken == nil || oauthAccess == nil) { completion(nil, credentialError ?: ZCodePlanError(@"E_ZCODE_PLAN_ACCOUNT_UNAVAILABLE")); return; }
    NSString *base = [provider isEqual:ZCodeZai] ? ZCodeZaiBase : ZCodeBigModelBase;
    [self exchangeAccess:oauthAccess provider:provider base:base completion:^(NSString *business, NSError *exchangeError) {
      if (exchangeError != nil) { completion(nil, exchangeError); return; }
      [self customerInfoWithBusinessToken:business provider:provider base:base completion:^(NSDictionary *org, NSDictionary *project, NSError *customerError) {
        if (customerError != nil) { completion(nil, customerError); return; }
        NSString *orgID = org[@"organizationId"] ?: org[@"id"];
        NSString *projectID = project[@"projectId"] ?: project[@"id"];
        [self existingAPIKeyWithBusinessToken:business provider:provider base:base organization:orgID project:projectID completion:^(NSString *secret, NSError *keyError) {
          if (keyError != nil) { completion(nil, keyError); return; }
          [self verifyCodingPlanWithAPIKey:secret provider:provider base:base completion:^(NSDictionary *plan, NSError *planError) {
            if (planError != nil) { completion(nil, planError); return; }
            if (![[self.accountAuth nativeCredentialForProvider:provider error:nil] isEqual:account]) {
              completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_ACCOUNT_CHANGED")); return;
            }
            NSMutableDictionary *result = [@{
              @"schema_version" : @1, @"provider" : provider,
              @"credential" : secret, @"credential_source" : @"coding_plan",
              @"endpoint_url" : [provider isEqual:ZCodeZai] ? @"https://api.z.ai/api/anthropic/v1/messages" : @"https://open.bigmodel.cn/api/anthropic/v1/messages",
              @"organization_id" : orgID, @"project_id" : projectID,
            } mutableCopy];
            NSTimeInterval expiry = ZCodePlanExplicitExpiry(plan);
            if (expiry > 0) result[@"expires_at"] = @(expiry);
            self.safeStatuses[provider] = @{
              @"schema_version" : @1, @"provider" : provider, @"status" : @"active",
              @"credential_source" : @"coding_plan",
              @"account_label" : account[@"account_label"] ?: NSNull.null,
              @"organization_id" : orgID, @"project_id" : projectID,
              @"expires_at" : result[@"expires_at"] ?: NSNull.null,
            };
            completion([result copy], nil);
          }];
        }];
      }];
    }];
  });
}

- (void)resolveTrialForProvider:(NSString *)provider
                     completion:(void (^)(NSDictionary *, NSError *))completion {
  dispatch_async(self.queue, ^{
    if (!ZCodePlanProvider(provider) || self.request == nil) { completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_PROVIDER")); return; }
    NSDictionary *account = [self.accountAuth nativeCredentialForProvider:provider error:nil];
    NSString *jwt = ZCodePlanString(account[@"zcode_token"], 16384);
    NSString *accountID = ZCodePlanString(account[@"user_id"], 256);
    if (!jwt || !accountID) { completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_ACCOUNT_UNAVAILABLE")); return; }
    NSURL *url = [NSURL URLWithString:[ZCodeTrialBase stringByAppendingString:@"/api/v1/zcode-plan/billing/balance"]];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"GET";
    [request setValue:@"Rish/0.0.1 (iOS)" forHTTPHeaderField:@"User-Agent"];
    [request setValue:[@"Bearer " stringByAppendingString:jwt] forHTTPHeaderField:@"Authorization"];
    self.request(request, ^(NSHTTPURLResponse *response, NSData *data, NSError *error) {
      dispatch_async(self.queue, ^{
        if (response.statusCode != 200) {
          id failure = data.length <= 128 * 1024 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          NSString *hint = @"unknown";
          if ([failure isKindOfClass:NSDictionary.class]) {
            NSString *message = ZCodePlanString(failure[@"msg"] ?: failure[@"message"] ?: failure[@"detail"], 4096).lowercaseString;
            if ([message containsString:@"version"] || [message containsString:@"版本"]) hint = @"version";
            else if ([message containsString:@"token"] || [message containsString:@"auth"]) hint = @"authorization";
            else if ([message containsString:@"quota"] || [message containsString:@"balance"]) hint = @"allowance";
          }
          os_log(OS_LOG_DEFAULT, "zcode_trial_validation failure_http=%{public}ld bytes=%{public}lu reason=%{public}@",
            (long)response.statusCode, (unsigned long)data.length, hint);
        }
        NSDictionary *json = ZCodePlanEnvelope(response, data, error);
        if (!json) { completion(nil, ZCodePlanError(@"E_ZCODE_TRIAL_QUERY_FAILED")); return; }
        NSDictionary *value = [json[@"data"] isKindOfClass:NSDictionary.class] ? json[@"data"] : nil;
        NSArray *plans = [value[@"plans"] isKindOfClass:NSArray.class] ? value[@"plans"] : @[];
        NSArray *balances = [value[@"balances"] isKindOfClass:NSArray.class] ? value[@"balances"] : @[];
        NSMutableDictionary<NSString *, NSNumber *> *activePlans = [NSMutableDictionary dictionary];
        for (NSDictionary *plan in plans) {
          if (![plan isKindOfClass:NSDictionary.class]) continue;
          NSString *status = ZCodePlanString(plan[@"status"], 64);
          NSString *candidateID = ZCodePlanString(plan[@"plan_id"] ?: plan[@"planId"], 256);
          NSString *name = ZCodePlanString(plan[@"name"] ?: plan[@"plan_name"], 256);
          NSString *identity = [[NSString stringWithFormat:@"%@ %@", candidateID ?: @"", name ?: @""] lowercaseString];
          NSTimeInterval until = ZCodePlanExplicitExpiry(plan);
          if ([status.lowercaseString isEqual:@"active"] && candidateID && until >= 0 &&
              (until == 0 || until > self.clock()) &&
              ([identity containsString:@"start-plan"] || [identity containsString:@"start plan"]))
            activePlans[candidateID] = @(until);
        }
        NSMutableOrderedSet<NSString *> *models = [NSMutableOrderedSet orderedSet];
        NSTimeInterval expiry = 0;
        for (NSDictionary *balance in balances) {
          if (![balance isKindOfClass:NSDictionary.class]) continue;
          NSString *balanceID = ZCodePlanString(balance[@"plan_id"] ?: balance[@"planId"], 256);
          NSTimeInterval balanceExpiry = ZCodePlanExplicitExpiry(balance);
          NSNumber *planExpiry = balanceID ? activePlans[balanceID] : nil;
          if (!planExpiry || ZCodeFiniteNumber(balance[@"remaining_units"]) <= 0 || balanceExpiry < 0 ||
              (balanceExpiry > 0 && balanceExpiry <= self.clock())) continue;
          BOOL usable = NO;
          for (id capability in ([balance[@"capabilities"] isKindOfClass:NSArray.class] ? balance[@"capabilities"] : @[])) {
            NSString *safe = ZCodePlanString(capability, 256);
            if (![safe.lowercaseString hasPrefix:@"model:"]) continue;
            NSString *model = [[safe substringFromIndex:6] lowercaseString];
            if (![@[@"glm-5.3", @"glm-5.3-flash"] containsObject:model]) continue;
            [models addObject:model]; usable = YES;
          }
          if (!usable) continue;
          for (NSNumber *limit in @[@(balanceExpiry), planExpiry])
            if (limit.doubleValue > 0 && (expiry == 0 || limit.doubleValue < expiry)) expiry = limit.doubleValue;
        }
        os_log(OS_LOG_DEFAULT, "zcode_trial_validation http=%{public}ld envelope_valid=%{public}d plans=%{public}lu balances=%{public}lu models=%{public}lu",
          (long)response.statusCode, json != nil, (unsigned long)plans.count,
          (unsigned long)balances.count, (unsigned long)models.count);
        if (!json || models.count == 0) {
          completion(nil, ZCodePlanError(@"E_ZCODE_TRIAL_UNAVAILABLE")); return;
        }
        if (![[self.accountAuth nativeCredentialForProvider:provider error:nil] isEqual:account]) {
          completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_ACCOUNT_CHANGED")); return;
        }
        NSMutableDictionary *result = [@{@"schema_version":@1, @"provider":provider,
          @"credential":jwt, @"credential_source":@"trial",
          @"endpoint_url":@"https://zcode.z.ai/api/v1/zcode-plan/anthropic",
          @"allowed_models":models.array} mutableCopy];
        if (expiry > 0) result[@"expires_at"] = @(expiry);
        self.safeStatuses[provider] = @{@"schema_version":@1, @"provider":provider,
          @"status":@"active", @"credential_source":@"trial",
          @"account_label":account[@"account_label"] ?: NSNull.null,
          @"expires_at":result[@"expires_at"] ?: NSNull.null};
        completion([result copy], nil);
      });
    });
  });
}

- (void)exchangeAccess:(NSString *)oauthAccess provider:(NSString *)provider base:(NSString *)base completion:(void (^)(NSString *, NSError *))completion {
  if ([provider isEqual:ZCodeBigModel]) { completion(oauthAccess, nil); return; }
  NSURL *url = [NSURL URLWithString:[base stringByAppendingString:@"/api/auth/z/login"]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST"; [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{ @"token" : oauthAccess } options:0 error:nil];
  self.request(request, ^(NSHTTPURLResponse *response, NSData *data, NSError *error) {
    dispatch_async(self.queue, ^{
      NSDictionary *json = ZCodePlanEnvelope(response, data, error);
      NSDictionary *value = [json[@"data"] isKindOfClass:NSDictionary.class] ? json[@"data"] : nil;
      NSString *token = ZCodePlanString(value[@"access_token"] ?: value[@"accessToken"], 16384);
      NSNumber *expires = [value[@"expires_in"] isKindOfClass:NSNumber.class] ? value[@"expires_in"] : nil;
      if (error || response.statusCode != 200 || token == nil || expires == nil || expires.doubleValue <= 0 || !isfinite(expires.doubleValue)) { completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_AUTH_UNAVAILABLE")); return; }
      completion(token, nil);
    });
  });
}

- (void)customerInfoWithBusinessToken:(NSString *)token provider:(NSString *)provider base:(NSString *)base completion:(void (^)(NSDictionary *, NSDictionary *, NSError *))completion {
  NSURL *url = [NSURL URLWithString:[base stringByAppendingString:@"/api/biz/customer/getCustomerInfo"]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"GET";
  [request setValue:[provider isEqual:ZCodeZai] ? [@"Bearer " stringByAppendingString:token] : token forHTTPHeaderField:@"Authorization"];
  self.request(request, ^(NSHTTPURLResponse *response, NSData *data, NSError *error) {
    dispatch_async(self.queue, ^{
      NSDictionary *json = ZCodePlanEnvelope(response, data, error);
      NSDictionary *customer = [json[@"data"] isKindOfClass:NSDictionary.class] ? json[@"data"] : nil;
      NSArray *organizations = [customer[@"organizations"] isKindOfClass:NSArray.class] ? customer[@"organizations"] : nil;
      NSDictionary *org = nil;
      for (NSDictionary *candidate in organizations) if ([candidate isKindOfClass:NSDictionary.class] && ([candidate[@"isDefault"] boolValue] || [candidate[@"default"] boolValue])) { org = candidate; break; }
      if (org == nil) for (NSDictionary *candidate in organizations) if ([candidate isKindOfClass:NSDictionary.class]) { org = candidate; break; }
      NSArray *projects = [org[@"projects"] isKindOfClass:NSArray.class] ? org[@"projects"] : nil;
      NSDictionary *project = nil;
      for (NSDictionary *candidate in projects) if ([candidate isKindOfClass:NSDictionary.class] && !([candidate[@"projectType"] isEqual:@"2"] || [candidate[@"projectType"] isEqual:@2]) && ([candidate[@"isDefault"] boolValue] || [candidate[@"default"] boolValue])) { project = candidate; break; }
      if (project == nil) for (NSDictionary *candidate in projects) if ([candidate isKindOfClass:NSDictionary.class] && !([candidate[@"projectType"] isEqual:@"2"] || [candidate[@"projectType"] isEqual:@2])) { project = candidate; break; }
      NSString *orgID = org[@"organizationId"] ?: org[@"id"]; NSString *projectID = project[@"projectId"] ?: project[@"id"];
      if (error || response.statusCode != 200 || !ZCodePlanIdentifier(orgID) || !ZCodePlanIdentifier(projectID)) { completion(nil, nil, ZCodePlanError(@"E_ZCODE_PLAN_PROJECT_UNAVAILABLE")); return; }
      completion(org, project, nil);
    });
  });
}

- (void)existingAPIKeyWithBusinessToken:(NSString *)token provider:(NSString *)provider base:(NSString *)base organization:(NSString *)orgID project:(NSString *)projectID completion:(void (^)(NSString *, NSError *))completion {
  NSString *path = [NSString stringWithFormat:@"/api/biz/v1/organization/%@/projects/%@/api_keys", orgID, projectID];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[base stringByAppendingString:path]]];
  request.HTTPMethod = @"GET"; [request setValue:[provider isEqual:ZCodeZai] ? [@"Bearer " stringByAppendingString:token] : token forHTTPHeaderField:@"Authorization"];
  self.request(request, ^(NSHTTPURLResponse *response, NSData *data, NSError *error) {
    dispatch_async(self.queue, ^{
      NSDictionary *json = ZCodePlanEnvelope(response, data, error);
      NSArray *keys = [json[@"data"] isKindOfClass:NSArray.class] ? json[@"data"] : nil; NSString *apiKey = nil;
      for (NSDictionary *entry in keys) if ([entry isKindOfClass:NSDictionary.class] && [entry[@"name"] isEqual:@"zcode-api-key"] && ZCodePlanIdentifier(entry[@"apiKey"])) { apiKey = entry[@"apiKey"]; break; }
      if (error || response.statusCode != 200 || apiKey == nil) { completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_KEY_UNAVAILABLE")); return; }
      NSString *copyPath = [NSString stringWithFormat:@"/api/biz/v1/organization/%@/projects/%@/api_keys/copy/%@", orgID, projectID, apiKey];
      NSMutableURLRequest *copy = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[base stringByAppendingString:copyPath]]]; copy.HTTPMethod = @"GET"; [copy setValue:[provider isEqual:ZCodeZai] ? [@"Bearer " stringByAppendingString:token] : token forHTTPHeaderField:@"Authorization"];
      self.request(copy, ^(NSHTTPURLResponse *copyResponse, NSData *copyData, NSError *copyError) {
        dispatch_async(self.queue, ^{
          NSDictionary *copyJSON = ZCodePlanEnvelope(copyResponse, copyData, copyError);
          NSDictionary *value = [copyJSON[@"data"] isKindOfClass:NSDictionary.class] ? copyJSON[@"data"] : nil;
          NSString *secret = ZCodePlanString(value[@"secretKey"], 16384);
          NSString *credential = secret ? ZCodePlanString([NSString stringWithFormat:@"%@.%@", apiKey, secret], 16384) : nil;
          completion(credential, credential ? nil : ZCodePlanError(@"E_ZCODE_PLAN_KEY_UNAVAILABLE"));
        });
      });
    });
  });
}

- (void)verifyCodingPlanWithAPIKey:(NSString *)apiKey provider:(NSString *)provider base:(NSString *)base completion:(void (^)(NSDictionary *, NSError *))completion {
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[base stringByAppendingString:@"/api/biz/subscription/list"]]];
  request.HTTPMethod = @"GET"; [request setValue:apiKey forHTTPHeaderField:@"Authorization"];
  self.request(request, ^(NSHTTPURLResponse *response, NSData *data, NSError *error) {
    dispatch_async(self.queue, ^{
      NSDictionary *json = ZCodePlanEnvelope(response, data, error);
      NSArray *plans = [json[@"data"] isKindOfClass:NSArray.class] ? json[@"data"] : nil;
      NSDictionary *active = nil;
      NSUInteger codingCount = 0, currentCount = 0, invalidExpiryCount = 0, expiredCount = 0;
      for (NSDictionary *plan in plans) {
        if (![plan isKindOfClass:NSDictionary.class]) continue;
        NSString *name = [plan[@"productName"] isKindOfClass:NSString.class] ? plan[@"productName"] : @""; NSString *product = [plan[@"productId"] isKindOfClass:NSString.class] ? plan[@"productId"] : @"";
        BOOL coding = [name.lowercaseString containsString:@"coding"] || [product.lowercaseString containsString:@"coding"];
        BOOL current = [plan[@"inCurrentPeriod"] boolValue] || [plan[@"status"] isEqual:@"VALID"];
        NSTimeInterval expiry = ZCodePlanExplicitExpiry(plan);
        if (coding) codingCount++;
        if (coding && current) currentCount++;
        if (coding && current && expiry < 0) invalidExpiryCount++;
        if (coding && current && expiry > 0 && expiry <= self.clock()) expiredCount++;
        if (coding && current && (expiry == 0 || expiry > self.clock())) { active = plan; break; }
      }
      os_log(OS_LOG_DEFAULT, "zcode_plan_validation http=%{public}ld envelope_valid=%{public}d list_valid=%{public}d entries=%{public}lu coding=%{public}lu current=%{public}lu invalid_expiry=%{public}lu expired=%{public}lu",
        (long)response.statusCode, json != nil, plans != nil, (unsigned long)plans.count,
        (unsigned long)codingCount, (unsigned long)currentCount, (unsigned long)invalidExpiryCount, (unsigned long)expiredCount);
      if (!json || active == nil) { completion(nil, ZCodePlanError(@"E_ZCODE_PLAN_UNAVAILABLE")); return; }
      completion(active, nil);
    });
  });
}

@end
