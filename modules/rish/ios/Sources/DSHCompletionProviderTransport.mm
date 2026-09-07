#import "DSHCompletionProviderTransport.h"

#import "DSHCompletionV2.h"

#import <CommonCrypto/CommonDigest.h>

#include <math.h>

static NSUInteger const DSHCompletionTransportMaximumRequestBytes = 40 * 1024 * 1024;
static NSUInteger const DSHCompletionTransportMaximumResponseBytes = 8 * 1024 * 1024;

static NSString *DSHCompletionTransportSHA256(NSData *data) {
  if (![data isKindOfClass:NSData.class]) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString
      stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

static NSString *DSHCompletionTransportJSONSHA256(id value) {
  if (value == nil || ![NSJSONSerialization isValidJSONObject:value]) {
    return nil;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                  options:NSJSONWritingSortedKeys
                                                    error:nil];
  return DSHCompletionTransportSHA256(data);
}

static BOOL DSHCompletionTransportValidRequestId(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length != 36) return NO;
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:value];
  return uuid != nil && [uuid.UUIDString.lowercaseString isEqualToString:value];
}

static NSString *DSHCompletionTransportParserErrorCode(NSError *error) {
  // DSHParseCompletionResponseSchema2 intentionally uses stable schema
  // codes, but keep this seam fail-closed if a future parser adds a verbose
  // diagnostic or a third-party NSError.
  NSString *candidate = error.localizedDescription;
  static NSSet<NSString *> *allowed = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowed = [NSSet setWithArray:@[
      @"E_COMPLETION_RESPONSE_JSON",
      @"E_COMPLETION_PROVIDER_RESPONSE_ID",
      @"E_COMPLETION_RESPONSE_MODEL",
      @"E_COMPLETION_MODEL_MISMATCH",
      @"E_COMPLETION_EMPTY_RESPONSE",
      @"E_COMPLETION_TOOL_CALL_INVALID",
      @"E_COMPLETION_FINISH_RELATION",
    ]];
  });
  return [allowed containsObject:candidate] ? candidate :
      @"E_COMPLETION_EMPTY_RESPONSE";
}

@interface DSHCompletionProviderTransportContext : NSObject
@property(nonatomic) NSInteger schemaVersion;
@property(nonatomic, copy) NSString *roundId;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) NSUInteger credentialGeneration;
@property(nonatomic, copy) DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock credentialGenerationIsCurrent;
@property(nonatomic, copy) DSHCompletionProviderTransportClaimRoundBlock claimRound;
@property(nonatomic, copy) DSHCompletionProviderTransportMarkRedirectedBlock markRedirected;
@property(nonatomic, copy) DSHCompletionProviderTransportRedirectDecisionBlock redirectDecision;
@property(nonatomic, copy) DSHCompletionProviderTransportCompletionBlock completion;
@end

@implementation DSHCompletionProviderTransportContext
@end

@interface DSHCompletionProviderTransport ()
@property(nonatomic, weak) NSURLSession *session;
@property(nonatomic, copy) NSString *(^uuidGenerator)(void);
@property(nonatomic, copy) NSTimeInterval (^monotonicClock)(void);
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, DSHCompletionProviderTransportContext *> *contexts;
@end

@implementation DSHCompletionProviderTransport

- (instancetype)initWithSession:(NSURLSession *)session
                   uuidGenerator:(NSString *(^)(void))uuidGenerator
                  monotonicClock:(NSTimeInterval (^)(void))monotonicClock {
  self = [super init];
  if (self != nil) {
    _session = session;
    _uuidGenerator = [uuidGenerator copy] ?: [^NSString *{
      return NSUUID.UUID.UUIDString.lowercaseString;
    } copy];
    _monotonicClock = [monotonicClock copy] ?: [^NSTimeInterval {
      return NSProcessInfo.processInfo.systemUptime;
    } copy];
    _contexts = [NSMutableDictionary dictionary];
  }
  return self;
}

- (NSString *)nextProviderRequestId:(NSString **)errorCode {
  NSString *value = nil;
  @try {
    value = self.uuidGenerator();
  } @catch (__unused NSException *exception) {
    value = nil;
  }
  if (!DSHCompletionTransportValidRequestId(value)) {
    if (errorCode != nil) *errorCode = @"E_COMPLETION_PROVIDER_REQUEST_ID";
    return nil;
  }
  if (errorCode != nil) *errorCode = nil;
  return value;
}

- (DSHCompletionProviderTransportContext *)contextForTaskIdentifier:(NSUInteger)taskIdentifier {
  @synchronized (self) {
    return self.contexts[@(taskIdentifier)];
  }
}

- (void)removeContextForTaskIdentifier:(NSUInteger)taskIdentifier {
  @synchronized (self) {
    [self.contexts removeObjectForKey:@(taskIdentifier)];
  }
}

- (void)settleStartFailure:(NSString *)errorCode
                 claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                completion:(DSHCompletionProviderTransportCompletionBlock)completion {
  BOOL current = NO;
  @try {
    current = claimRound != nil && claimRound(nil);
  } @catch (__unused NSException *exception) {
    current = NO;
  }
  if (current && completion != nil) completion(nil, errorCode);
}

- (NSURLSessionDataTask *)startRequestWithSchemaVersion:(NSInteger)schemaVersion
                                                 roundId:(NSString *)roundId
                                                generation:(NSUInteger)generation
                                      credentialGeneration:(NSUInteger)credentialGeneration
                                       providerRequestId:(NSString *)providerRequestId
                                             credential:(NSString *)credential
                                         requestedModel:(NSString *)requestedModel
                                          thinkingMode:(NSString *)thinkingMode
                           credentialGenerationIsCurrent:(DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock)credentialGenerationIsCurrent
                                              startedAt:(NSTimeInterval)startedAt
                                              bodyData:(NSData *)bodyData
                                        visibleHistory:(NSArray *)visibleHistory
                                            modelInput:(NSArray *)modelInput
                                             bindTask:(DSHCompletionProviderTransportBindTaskBlock)bindTask
                                           claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                                      markRedirected:(DSHCompletionProviderTransportMarkRedirectedBlock)markRedirected
                                    redirectDecision:(DSHCompletionProviderTransportRedirectDecisionBlock)redirectDecision
                                           completion:(DSHCompletionProviderTransportCompletionBlock)completion {
  if ((schemaVersion != 2 && schemaVersion != 3) ||
      !DSHCompletionTransportValidRequestId(roundId)) {
    [self settleStartFailure:@"E_COMPLETION_SCHEMA"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  if (!DSHCompletionTransportValidRequestId(providerRequestId)) {
    [self settleStartFailure:@"E_COMPLETION_PROVIDER_REQUEST_ID"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  if (![credential isKindOfClass:NSString.class] || credential.length == 0) {
    [self settleStartFailure:@"E_COMPLETION_CREDENTIAL_UNAVAILABLE"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  if (![requestedModel isKindOfClass:NSString.class] || requestedModel.length == 0 ||
      ![thinkingMode isKindOfClass:NSString.class] || thinkingMode.length == 0 ||
      ![bodyData isKindOfClass:NSData.class] || bodyData.length == 0) {
    [self settleStartFailure:@"E_COMPLETION_BODY_INVALID"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  BOOL generationCurrent = YES;
  @try {
    generationCurrent = credentialGenerationIsCurrent == nil ||
        credentialGenerationIsCurrent(credentialGeneration);
  } @catch (__unused NSException *exception) {
    generationCurrent = NO;
  }
  if (!generationCurrent) {
    [self settleStartFailure:@"E_COMPLETION_CREDENTIAL_CHANGED"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  if (bodyData.length > DSHCompletionTransportMaximumRequestBytes) {
    [self settleStartFailure:@"E_COMPLETION_BODY_TOO_LARGE"
                   claimRound:claimRound completion:completion];
    return nil;
  }

  NSString *visibleDigest = DSHCompletionTransportJSONSHA256(visibleHistory);
  NSString *modelInputDigest = DSHCompletionTransportJSONSHA256(modelInput);
  NSString *bodyDigest = DSHCompletionTransportSHA256(bodyData);
  if (visibleDigest == nil || modelInputDigest == nil || bodyDigest == nil) {
    [self settleStartFailure:@"E_COMPLETION_BODY_INVALID"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  NSURLSession *session = self.session;
  if (session == nil) {
    [self settleStartFailure:@"E_COMPLETION_TRANSPORT"
                   claimRound:claimRound completion:completion];
    return nil;
  }

  NSDictionary *providerConfiguration = [self providerConfigurationForModel:requestedModel];
  NSURL *url = [self providerBaseURL];
  if (url == nil || [self providerHarnessId].length == 0) {
    [self settleStartFailure:@"E_COMPLETION_TRANSPORT"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST";
  request.HTTPShouldHandleCookies = NO;
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  request.timeoutInterval = [self providerTimeoutIntervalForStreaming:NO];
  NSDictionary<NSString *, NSString *> *headers =
      [self providerHeadersWithCredential:credential];
  for (NSString *field in headers) {
    [request setValue:headers[field] forHTTPHeaderField:field];
  }
  request.HTTPBody = bodyData;

  DSHCompletionProviderTransportContext *context =
      [[DSHCompletionProviderTransportContext alloc] init];
  context.schemaVersion = schemaVersion;
  context.roundId = [roundId copy];
  context.generation = generation;
  context.credentialGeneration = credentialGeneration;
  context.credentialGenerationIsCurrent = [credentialGenerationIsCurrent copy];
  context.claimRound = [claimRound copy];
  context.markRedirected = [markRedirected copy];
  context.redirectDecision = [redirectDecision copy];
  context.completion = [completion copy];

  __block NSUInteger taskIdentifier = NSUIntegerMax;
  NSURLSessionDataTask *task = nil;
  @try {
    task = [session dataTaskWithRequest:request
                      completionHandler:^(NSData *data,
                                          NSURLResponse *response,
                                          NSError *transportError) {
      DSHCompletionProviderTransportContext *owned =
          [self contextForTaskIdentifier:taskIdentifier];
      if (owned == nil) return;
      [self removeContextForTaskIdentifier:taskIdentifier];

      BOOL redirected = NO;
      BOOL current = NO;
      @try {
        current = owned.claimRound != nil && owned.claimRound(&redirected);
      } @catch (__unused NSException *exception) {
        current = NO;
      }
      if (!current) return;
      BOOL generationCurrent = YES;
      @try {
        generationCurrent = owned.credentialGenerationIsCurrent == nil ||
            owned.credentialGenerationIsCurrent(owned.credentialGeneration);
      } @catch (__unused NSException *exception) {
        generationCurrent = NO;
      }
      NSDictionary *currentConfiguration = [self providerConfigurationForModel:requestedModel];
      BOOL configurationCurrent = (currentConfiguration == nil && providerConfiguration == nil) ||
          [currentConfiguration isEqual:providerConfiguration];
      if (!generationCurrent || !configurationCurrent) {
        if (owned.completion != nil) {
          owned.completion(nil, @"E_COMPLETION_CREDENTIAL_CHANGED");
        }
        return;
      }
      if (redirected) {
        if (owned.completion != nil) {
          owned.completion(nil, @"E_COMPLETION_REDIRECT");
        }
        return;
      }
      if (transportError != nil ||
          ![response isKindOfClass:NSHTTPURLResponse.class]) {
        if (owned.completion != nil) {
          owned.completion(nil, @"E_COMPLETION_TRANSPORT");
        }
        return;
      }
      NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
      if (http.statusCode < 200 || http.statusCode >= 300) {
        if (owned.completion != nil) {
          owned.completion(nil, [self providerErrorCodeForHTTPStatus:http.statusCode
                                                                 data:data]);
        }
        return;
      }
      if (data.length == 0 || data.length > DSHCompletionTransportMaximumResponseBytes) {
        if (owned.completion != nil) {
          owned.completion(nil, @"E_COMPLETION_RESPONSE_SIZE");
        }
        return;
      }
      NSError *parseError = nil;
      NSDictionary *parsed = [self providerParseResponseData:data
                                              requestedModel:requestedModel
                                                thinkingMode:thinkingMode
                                                      error:&parseError];
      if (parsed == nil) {
        if (owned.completion != nil) {
          owned.completion(nil, DSHCompletionTransportParserErrorCode(parseError));
        }
        return;
      }
      NSTimeInterval finished = startedAt;
      @try {
        finished = self.monotonicClock();
      } @catch (__unused NSException *exception) {
        finished = startedAt;
      }
      NSInteger latencyMs = (NSInteger)floor(MAX(0, finished - startedAt) *
          1000.0 + 0.000001);
      NSDictionary *result = @{
        @"provider_request_id": providerRequestId,
        @"provider_response_id": parsed[@"provider_response_id"],
        @"harness_id": [self providerHarnessId],
        @"requested_model": requestedModel,
        @"model": parsed[@"model"],
        @"thinking_mode": thinkingMode,
        @"text": parsed[@"text"],
        @"reasoning": parsed[@"reasoning"],
        @"tool_calls": DSHCompletionNormalizeToolCalls(parsed[@"tool_calls"]),
        @"finish_reason": parsed[@"finish_reason"],
        @"latency_ms": @(latencyMs),
        @"visible_history_sha256": visibleDigest,
        @"model_input_sha256": modelInputDigest,
        @"request_body_sha256": bodyDigest,
      };
      if (providerConfiguration != nil) {
        NSMutableDictionary *bound = [result mutableCopy];
        bound[@"provider_configuration"] = providerConfiguration;
        result = bound;
      }
      if (owned.completion != nil) owned.completion(result, nil);
    }];
  } @catch (__unused NSException *exception) {
    [self settleStartFailure:@"E_COMPLETION_TRANSPORT"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  if (task == nil) {
    [self settleStartFailure:@"E_COMPLETION_TRANSPORT"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  taskIdentifier = task.taskIdentifier;
  @synchronized (self) {
    self.contexts[@(taskIdentifier)] = context;
  }
  BOOL bound = NO;
  @try {
    bound = bindTask != nil && bindTask(task);
  } @catch (__unused NSException *exception) {
    bound = NO;
  }
  if (!bound) {
    [self removeContextForTaskIdentifier:taskIdentifier];
    [task cancel];
    [self settleStartFailure:@"E_COMPLETION_TRANSPORT"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  @try {
    generationCurrent = context.credentialGenerationIsCurrent == nil ||
        context.credentialGenerationIsCurrent(credentialGeneration);
  } @catch (__unused NSException *exception) {
    generationCurrent = NO;
  }
  if (!generationCurrent) {
    [self removeContextForTaskIdentifier:taskIdentifier];
    [task cancel];
    [self settleStartFailure:@"E_COMPLETION_CREDENTIAL_CHANGED"
                   claimRound:claimRound completion:completion];
    return nil;
  }
  [task resume];
  return task;
}

- (BOOL)handlesTask:(NSURLSessionTask *)task {
  if (task == nil) return NO;
  @synchronized (self) {
    return self.contexts[@(task.taskIdentifier)] != nil;
  }
}

- (void)cancelTask:(NSURLSessionDataTask *)task {
  if (task == nil) return;
  [task cancel];
  [self removeContextForTaskIdentifier:task.taskIdentifier];
}

- (void)handleHTTPRedirectionForTask:(NSURLSessionTask *)task
                          newRequest:(NSURLRequest *)request
                   completionHandler:(void (^)(NSURLRequest * _Nullable))completionHandler {
  if (completionHandler == nil) return;
  DSHCompletionProviderTransportContext *context =
      [self contextForTaskIdentifier:task.taskIdentifier];
  if (context == nil) {
    completionHandler(request);
    return;
  }
  @try {
    if (context.markRedirected != nil) {
      context.markRedirected((NSURLSessionDataTask *)task);
    }
  } @catch (__unused NSException *exception) {
  }
  @try {
    if (context.redirectDecision != nil) context.redirectDecision(YES);
  } @catch (__unused NSException *exception) {
  }
  completionHandler(nil);
}

#pragma mark Provider hooks (abstract)

/// The base class owns the generic completion-slot, digest, cancellation,
/// and redirect orchestration only. Every provider dialect lives in a
/// subclass (DshProviderTransport, ClaudeProviderTransport,
/// CodexProviderTransport); an unimplemented hook fails closed.

- (BOOL)hasActiveRequests { @synchronized(self) { return self.contexts.count > 0; } }

- (NSDictionary *)providerConfigurationForModel:(NSString *)model { return nil; }

- (NSURL *)providerBaseURL {
  return nil;
}

- (NSDictionary<NSString *, NSString *> *)providerHeadersWithCredential:(NSString *)credential {
  return @{};
}

- (NSDictionary<NSString *, id> *)providerRequestBodyForModel:(NSString *)model
                                                 thinkingMode:(NSString *)thinkingMode
                                                     messages:(NSArray<NSDictionary<NSString *, id> *> *)messages
                                                        tools:(NSArray<NSDictionary<NSString *, id> *> *)tools
                                                    streaming:(BOOL)streaming
                                                        error:(NSError **)error {
  if (error != nil) {
    *error = [NSError errorWithDomain:@"DSHCompletionTransportError"
                                 code:2001
                             userInfo:@{NSLocalizedDescriptionKey:
                                 @"E_COMPLETION_BODY_INVALID"}];
  }
  return nil;
}

- (NSDictionary<NSString *, id> *)providerParseResponseData:(NSData *)data
                                              requestedModel:(NSString *)requestedModel
                                                thinkingMode:(NSString *)thinkingMode
                                                      error:(NSError **)error {
  if (error != nil) {
    *error = [NSError errorWithDomain:@"DSHCompletionTransportError"
                                 code:2002
                             userInfo:@{NSLocalizedDescriptionKey:
                                 @"E_COMPLETION_RESPONSE_JSON"}];
  }
  return nil;
}

- (NSString *)providerErrorCodeForHTTPStatus:(NSInteger)statusCode
                                         data:(NSData *)data {
  // Shared mapping: an unauthenticated or forbidden call means the stored
  // credential is unusable; a rate limit or provider overload is reported
  // as its own stable code so the caller can back off instead of retrying
  // as a generic transport-status failure.
  if (statusCode == 401 || statusCode == 403) {
    return @"E_COMPLETION_CREDENTIAL_UNAVAILABLE";
  }
  if (statusCode == 429 || statusCode == 529) {
    return @"E_COMPLETION_HTTP_429";
  }
  return @"E_COMPLETION_HTTP_STATUS";
}

- (id<DSHProviderStreamEventParsing>)providerNewStreamEventParser {
  return nil;
}

- (BOOL)providerSupportsModel:(NSString *)model {
  return NO;
}

- (NSTimeInterval)providerTimeoutIntervalForStreaming:(BOOL)streaming {
  return streaming ? 120 : 90;
}

- (NSString *)providerHarnessId {
  return nil;
}

@end
