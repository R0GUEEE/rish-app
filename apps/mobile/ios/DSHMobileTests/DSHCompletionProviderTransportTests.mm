#import <XCTest/XCTest.h>

#import "../../../../modules/rish/ios/Sources/DSHCompletionProviderTransport.h"
#import "../../../../modules/rish/ios/Sources/DshProviderTransport.h"

typedef void (^DSHTransportURLProtocolHandler)(NSURLProtocol *protocol,
                                               NSURLRequest *request);

@interface DSHTransportURLProtocol : NSURLProtocol
+ (void)setHandler:(DSHTransportURLProtocolHandler)handler;
+ (void)reset;
+ (NSUInteger)requestCount;
@end

@implementation DSHTransportURLProtocol

static DSHTransportURLProtocolHandler DSHTransportHandler = nil;
static NSUInteger DSHTransportRequestCount = 0;

+ (void)setHandler:(DSHTransportURLProtocolHandler)handler {
  @synchronized (self) { DSHTransportHandler = [handler copy]; }
}

+ (void)reset {
  @synchronized (self) {
    DSHTransportHandler = nil;
    DSHTransportRequestCount = 0;
  }
}

+ (NSUInteger)requestCount {
  @synchronized (self) { return DSHTransportRequestCount; }
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  NSString *scheme = request.URL.scheme.lowercaseString;
  return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request {
  return request;
}

- (void)startLoading {
  DSHTransportURLProtocolHandler handler = nil;
  @synchronized (self.class) {
    DSHTransportRequestCount += 1;
    handler = [DSHTransportHandler copy];
  }
  if (handler != nil) {
    handler(self, self.request);
    return;
  }
  NSError *error = [NSError errorWithDomain:@"DSHCompletionTransportTests"
                                       code:1
                                   userInfo:nil];
  [self.client URLProtocol:self didFailWithError:error];
}

- (void)stopLoading {}

@end

@interface DSHTransportURLSessionDelegate : NSObject <NSURLSessionTaskDelegate>
@property(nonatomic, strong) DSHCompletionProviderTransport *transport;
@end

@implementation DSHTransportURLSessionDelegate

- (void)URLSession:(__unused NSURLSession *)session
              task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(__unused NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest * _Nullable))completionHandler {
  [self.transport handleHTTPRedirectionForTask:task
                                    newRequest:request
                             completionHandler:completionHandler];
}

@end

@interface DSHCompletionProviderTransportTests : XCTestCase
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) DSHTransportURLSessionDelegate *sessionDelegate;
@property(nonatomic, strong) DSHCompletionProviderTransport *transport;
@end

@implementation DSHCompletionProviderTransportTests

static NSString *const DSHTransportRoundId =
    @"33333333-3333-4333-8333-333333333333";
static NSString *const DSHTransportProviderRequestId =
    @"44444444-4444-4444-8444-444444444444";

- (void)setUp {
  [super setUp];
  [DSHTransportURLProtocol reset];
  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.protocolClasses = @[DSHTransportURLProtocol.class];
  self.sessionDelegate = [[DSHTransportURLSessionDelegate alloc] init];
  self.session = [NSURLSession sessionWithConfiguration:configuration
                                                delegate:self.sessionDelegate
                                           delegateQueue:nil];
  self.transport = [[DshProviderTransport alloc]
      initWithSession:self.session
      uuidGenerator:^NSString *{
        return DSHTransportProviderRequestId;
      }
      monotonicClock:^NSTimeInterval {
        return 10.25;
      }];
  self.sessionDelegate.transport = self.transport;
}

- (void)tearDown {
  [self.session invalidateAndCancel];
  self.sessionDelegate.transport = nil;
  self.transport = nil;
  self.session = nil;
  [DSHTransportURLProtocol reset];
  [super tearDown];
}

- (NSData *)bodyData {
  return [NSJSONSerialization dataWithJSONObject:@{
    @"model": @"deepseek-v4-flash",
    @"stream": @NO,
    @"messages": @[@{ @"role": @"user", @"content": @"hello" }],
  } options:NSJSONWritingSortedKeys error:nil];
}

- (NSArray *)visibleHistory {
  return @[@{ @"role": @"user", @"content": @"hello" }];
}

- (NSDictionary *)successPayload {
  return @{
    @"id": @"response-123",
    @"model": @"deepseek-v4-flash",
    @"choices": @[@{
      @"finish_reason": @"stop",
      @"message": @{
        @"role": @"assistant",
        @"content": @"done",
        @"reasoning_content": @"reasoning",
      },
    }],
  };
}

- (void)respondFromProtocol:(NSURLProtocol *)protocol
                    request:(NSURLRequest *)request
                       data:(NSData *)data
                     status:(NSInteger)status {
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
      initWithURL:request.URL
       statusCode:status
      HTTPVersion:@"HTTP/1.1"
     headerFields:@{ @"Content-Type": @"application/json" }];
  [protocol.client URLProtocol:protocol
            didReceiveResponse:response
            cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  if (data.length > 0) {
    [protocol.client URLProtocol:protocol didLoadData:data];
  }
  [protocol.client URLProtocolDidFinishLoading:protocol];
}

- (void)respondJSONFromProtocol:(NSURLProtocol *)protocol
                         request:(NSURLRequest *)request
                          payload:(id)payload
                           status:(NSInteger)status {
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload
                                                  options:0 error:nil];
  [self respondFromProtocol:protocol request:request data:data status:status];
}

- (NSURLSessionDataTask *)startWithSchemaVersion:(NSInteger)schemaVersion
                                            body:(NSData *)body
                                      providerId:(NSString *)providerId
                                        bindTask:(DSHCompletionProviderTransportBindTaskBlock)bindTask
                                      claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                             generationIsCurrent:(DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock)generationOK
                                      completion:(DSHCompletionProviderTransportCompletionBlock)completion {
  return [self.transport
      startRequestWithSchemaVersion:schemaVersion
      roundId:DSHTransportRoundId
      generation:1
      credentialGeneration:7
      providerRequestId:providerId
      credential:@"test-credential"
      requestedModel:@"deepseek-v4-flash"
      thinkingMode:@"high"
      credentialGenerationIsCurrent:generationOK
      startedAt:10.0
      bodyData:body
      visibleHistory:[self visibleHistory]
      modelInput:[self visibleHistory]
      bindTask:bindTask
      claimRound:claimRound
      markRedirected:nil
      redirectDecision:nil
      completion:completion];
}

- (NSURLSessionDataTask *)startWithBody:(NSData *)body
                             providerId:(NSString *)providerId
                              bindTask:(DSHCompletionProviderTransportBindTaskBlock)bindTask
                            claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                   generationIsCurrent:(DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock)generationOK
                              completion:(DSHCompletionProviderTransportCompletionBlock)completion {
  return [self startWithSchemaVersion:2
                                 body:body
                           providerId:providerId
                             bindTask:bindTask
                           claimRound:claimRound
                  generationIsCurrent:generationOK
                             completion:completion];
}

- (void)testRejectsInvalidProviderIdWithoutStartingOrRegisteringContext {
  __block NSUInteger claims = 0;
  __block NSString *errorCode = nil;
  __block BOOL bound = NO;
  NSURLSessionDataTask *task = [self startWithBody:[self bodyData]
                                         providerId:@"provider-id-sentinel"
                                          bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
    bound = YES;
    return YES;
  }
                                        claimRound:^BOOL(__unused BOOL *redirected) {
    claims += 1;
    return YES;
  }
                             generationIsCurrent:^BOOL(__unused NSUInteger generation) {
    return YES;
  }
                                        completion:^(__unused NSDictionary *result,
                                                     NSString *value) {
    errorCode = [value copy];
  }];
  XCTAssertNil(task);
  XCTAssertFalse(bound);
  XCTAssertEqual(claims, 1u);
  XCTAssertEqualObjects(errorCode, @"E_COMPLETION_PROVIDER_REQUEST_ID");
  XCTAssertEqual([DSHTransportURLProtocol requestCount], 0u);
}

- (void)testProviderRequestIdGeneratorIsValidatedAndValueFree {
  DSHCompletionProviderTransport *invalid = [[DshProviderTransport alloc]
      initWithSession:self.session
      uuidGenerator:^NSString *{
        return @"provider-request-id-sentinel";
      }
      monotonicClock:^NSTimeInterval { return 10.0; }];
  NSString *errorCode = nil;
  XCTAssertNil([invalid nextProviderRequestId:&errorCode]);
  XCTAssertEqualObjects(errorCode, @"E_COMPLETION_PROVIDER_REQUEST_ID");

  DSHCompletionProviderTransport *throwing = [[DshProviderTransport alloc]
      initWithSession:self.session
      uuidGenerator:^NSString *{
        @throw [NSException exceptionWithName:@"transport-test"
                                       reason:@"secret"
                                     userInfo:nil];
      }
      monotonicClock:^NSTimeInterval { return 10.0; }];
  errorCode = nil;
  XCTAssertNil([throwing nextProviderRequestId:&errorCode]);
  XCTAssertEqualObjects(errorCode, @"E_COMPLETION_PROVIDER_REQUEST_ID");
}

- (void)testContextRegistersBeforeBindAndCleansAfterSuccessWithExactSanitizedResult {
  XCTestExpectation *finished = [self expectationWithDescription:@"success"];
  __block NSURLSessionDataTask *boundTask = nil;
  __block BOOL visibleDuringBind = NO;
  __block NSDictionary *result = nil;
  [DSHTransportURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    XCTAssertEqualObjects(request.HTTPMethod, @"POST");
    XCTAssertEqualObjects(request.URL.absoluteString,
                          @"https://api.deepseek.com/chat/completions");
    XCTAssertEqualObjects([request valueForHTTPHeaderField:@"Authorization"],
                          @"Bearer test-credential");
    XCTAssertEqualObjects([request valueForHTTPHeaderField:@"Content-Type"],
                          @"application/json");
    [self respondJSONFromProtocol:protocol request:request
                           payload:[self successPayload] status:200];
  }];
  NSURLSessionDataTask *task = [self startWithBody:[self bodyData]
                                         providerId:DSHTransportProviderRequestId
                                          bindTask:^BOOL(NSURLSessionDataTask *value) {
    boundTask = value;
    visibleDuringBind = [self.transport handlesTask:value];
    return YES;
  }
                                        claimRound:^BOOL(__unused BOOL *redirected) {
    return YES;
  }
                             generationIsCurrent:^BOOL(__unused NSUInteger generation) {
    return YES;
  }
                                        completion:^(NSDictionary *value,
                                                     NSString *errorCode) {
    XCTAssertNil(errorCode);
    result = value;
    [finished fulfill];
  }];
  XCTAssertNotNil(task);
  [self waitForExpectations:@[finished] timeout:3];
  XCTAssertEqual(task, boundTask);
  XCTAssertTrue(visibleDuringBind);
  XCTAssertFalse([self.transport handlesTask:task]);
  XCTAssertEqualObjects([NSSet setWithArray:result.allKeys],
      ([NSSet setWithArray:@[
        @"provider_request_id", @"provider_response_id", @"harness_id", @"requested_model",
        @"model", @"thinking_mode", @"text", @"reasoning", @"tool_calls",
        @"finish_reason", @"latency_ms", @"visible_history_sha256",
        @"model_input_sha256", @"request_body_sha256",
      ]]));
  XCTAssertEqualObjects(result[@"provider_request_id"],
                        DSHTransportProviderRequestId);
  XCTAssertEqualObjects(result[@"provider_response_id"], @"response-123");
  XCTAssertEqualObjects(result[@"text"], @"done");
  XCTAssertEqualObjects(result[@"latency_ms"], @250);
  XCTAssertFalse([result.allKeys containsObject:@"credential"]);
}

- (void)testRedirectIsRejectedWithoutFollowingDestinationAndCleansContext {
  XCTestExpectation *rejected = [self expectationWithDescription:@"redirect"];
  __block NSUInteger destinationHits = 0;
  __block BOOL redirectDecision = NO;
  __block BOOL redirectedFlag = NO;
  __block NSURLSessionDataTask *task = nil;
  [DSHTransportURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    if ([request.URL.path isEqualToString:@"/redirect-target"]) {
      destinationHits += 1;
      return;
    }
    NSURL *destination = [NSURL URLWithString:
        @"https://api.deepseek.com/redirect-target"];
    NSMutableURLRequest *redirectRequest =
        [NSMutableURLRequest requestWithURL:destination];
    NSHTTPURLResponse *redirectResponse = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL statusCode:302 HTTPVersion:@"HTTP/1.1"
        headerFields:@{ @"Location": destination.absoluteString }];
    [protocol.client URLProtocol:protocol
        wasRedirectedToRequest:redirectRequest
              redirectResponse:redirectResponse];
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];
  task = [self.transport
      startRequestWithSchemaVersion:2
      roundId:DSHTransportRoundId generation:1 credentialGeneration:7
      providerRequestId:DSHTransportProviderRequestId credential:@"test-credential"
      requestedModel:@"deepseek-v4-flash" thinkingMode:@"high"
      credentialGenerationIsCurrent:^BOOL(__unused NSUInteger value) { return YES; }
      startedAt:10.0 bodyData:[self bodyData]
      visibleHistory:[self visibleHistory] modelInput:[self visibleHistory]
      bindTask:^BOOL(__unused NSURLSessionDataTask *value) { return YES; }
      claimRound:^BOOL(BOOL *redirected) {
        if (redirected != nil) *redirected = redirectedFlag;
        return YES;
      }
      markRedirected:^(__unused NSURLSessionDataTask *value) {
        redirectedFlag = YES;
      }
      redirectDecision:^(BOOL rejectedValue) {
        redirectDecision = rejectedValue;
      }
      completion:^(__unused NSDictionary *result, NSString *errorCode) {
        XCTAssertEqualObjects(errorCode, @"E_COMPLETION_REDIRECT");
        [rejected fulfill];
      }];
  XCTAssertNotNil(task);
  [self waitForExpectations:@[rejected] timeout:3];
  XCTAssertTrue(redirectDecision);
  XCTAssertEqual(destinationHits, 0u);
  XCTAssertFalse([self.transport handlesTask:task]);
}

- (void)testSchema2AndSchema3ShareProviderParserAndDigestResult {
  XCTestExpectation *schema2Finished =
      [self expectationWithDescription:@"schema2 parity"];
  XCTestExpectation *schema3Finished =
      [self expectationWithDescription:@"schema3 parity"];
  __block NSDictionary *schema2Result = nil;
  __block NSDictionary *schema3Result = nil;
  [DSHTransportURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    [self respondJSONFromProtocol:protocol request:request
                           payload:[self successPayload] status:200];
  }];
  NSURLSessionDataTask *schema2 = [self startWithSchemaVersion:2
                                                         body:[self bodyData]
                                                   providerId:DSHTransportProviderRequestId
                                                     bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
    return YES;
  }
                                                   claimRound:^BOOL(__unused BOOL *redirected) {
    return YES;
  }
                                          generationIsCurrent:^BOOL(__unused NSUInteger value) {
    return YES;
  }
                                                     completion:^(NSDictionary *value,
                                                                  NSString *errorCode) {
    XCTAssertNil(errorCode);
    schema2Result = value;
    [schema2Finished fulfill];
  }];
  XCTAssertNotNil(schema2);
  [self waitForExpectations:@[schema2Finished] timeout:3];

  NSURLSessionDataTask *schema3 = [self startWithSchemaVersion:3
                                                         body:[self bodyData]
                                                   providerId:DSHTransportProviderRequestId
                                                     bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
    return YES;
  }
                                                   claimRound:^BOOL(__unused BOOL *redirected) {
    return YES;
  }
                                          generationIsCurrent:^BOOL(__unused NSUInteger value) {
    return YES;
  }
                                                     completion:^(NSDictionary *value,
                                                                  NSString *errorCode) {
    XCTAssertNil(errorCode);
    schema3Result = value;
    [schema3Finished fulfill];
  }];
  XCTAssertNotNil(schema3);
  [self waitForExpectations:@[schema3Finished] timeout:3];
  XCTAssertEqualObjects(schema2Result, schema3Result);
}

- (void)testMapsTransportNonHTTPStatusSizeAndJSONFailuresToStableCodes {
  NSArray<NSDictionary *> *cases = @[
    @{ @"name": @"transport", @"error": @"E_COMPLETION_TRANSPORT" },
    @{ @"name": @"non-http", @"error": @"E_COMPLETION_TRANSPORT" },
    @{ @"name": @"status", @"error": @"E_COMPLETION_HTTP_STATUS" },
    @{ @"name": @"rate-limit", @"error": @"E_COMPLETION_HTTP_429" },
    @{ @"name": @"unauthorized", @"error": @"E_COMPLETION_CREDENTIAL_UNAVAILABLE" },
    @{ @"name": @"size", @"error": @"E_COMPLETION_RESPONSE_SIZE" },
    @{ @"name": @"json", @"error": @"E_COMPLETION_RESPONSE_JSON" },
  ];
  for (NSDictionary *entry in cases) {
    XCTestExpectation *finished = [self
        expectationWithDescription:entry[@"name"]];
    NSString *name = entry[@"name"];
    [DSHTransportURLProtocol setHandler:^(NSURLProtocol *protocol,
                                           NSURLRequest *request) {
      if ([name isEqualToString:@"transport"]) {
        NSError *error = [NSError errorWithDomain:@"sentinel" code:9 userInfo:nil];
        [protocol.client URLProtocol:protocol didFailWithError:error];
      } else if ([name isEqualToString:@"non-http"]) {
        NSURLResponse *response = [[NSURLResponse alloc]
            initWithURL:request.URL MIMEType:@"application/json"
            expectedContentLength:2 textEncodingName:@"utf-8"];
        [protocol.client URLProtocol:protocol didReceiveResponse:response
                  cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        [protocol.client URLProtocol:protocol didLoadData:[@"{}"
            dataUsingEncoding:NSUTF8StringEncoding]];
        [protocol.client URLProtocolDidFinishLoading:protocol];
      } else if ([name isEqualToString:@"status"] ||
                 [name isEqualToString:@"rate-limit"] ||
                 [name isEqualToString:@"unauthorized"]) {
        NSInteger status = [name isEqualToString:@"status"] ? 500
            : ([name isEqualToString:@"rate-limit"] ? 429 : 401);
        [self respondJSONFromProtocol:protocol request:request
                               payload:@{ @"error": @{ @"message": @"secret" } }
                                status:status];
      } else if ([name isEqualToString:@"size"]) {
        NSMutableData *data = [NSMutableData dataWithLength:8 * 1024 * 1024 + 1];
        [self respondFromProtocol:protocol request:request data:data status:200];
      } else {
        [self respondFromProtocol:protocol request:request
                              data:[@"not-json" dataUsingEncoding:NSUTF8StringEncoding]
                            status:200];
      }
    }];
    __block NSString *errorCode = nil;
    NSURLSessionDataTask *task = [self startWithBody:[self bodyData]
                                           providerId:DSHTransportProviderRequestId
                                            bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
      return YES;
    }
                                          claimRound:^BOOL(__unused BOOL *redirected) {
      return YES;
    }
                               generationIsCurrent:^BOOL(__unused NSUInteger generation) {
      return YES;
    }
                                          completion:^(__unused NSDictionary *result,
                                                       NSString *value) {
      errorCode = [value copy];
      [finished fulfill];
    }];
    XCTAssertNotNil(task);
    [self waitForExpectations:@[finished] timeout:5];
    XCTAssertEqualObjects(errorCode, entry[@"error"]);
    XCTAssertFalse([self.transport handlesTask:task]);
  }
}

- (void)testProviderParserErrorsRemainStableAndValueFree {
  NSArray<NSDictionary *> *cases = @[
    @{ @"name": @"id", @"error": @"E_COMPLETION_PROVIDER_RESPONSE_ID" },
    @{ @"name": @"model", @"error": @"E_COMPLETION_RESPONSE_MODEL" },
    @{ @"name": @"mismatch", @"error": @"E_COMPLETION_MODEL_MISMATCH" },
    @{ @"name": @"empty", @"error": @"E_COMPLETION_EMPTY_RESPONSE" },
    @{ @"name": @"tool", @"error": @"E_COMPLETION_TOOL_CALL_INVALID" },
    @{ @"name": @"finish", @"error": @"E_COMPLETION_FINISH_RELATION" },
  ];
  for (NSDictionary *entry in cases) {
    XCTestExpectation *finished = [self
        expectationWithDescription:entry[@"name"]];
    NSString *name = entry[@"name"];
    [DSHTransportURLProtocol setHandler:^(NSURLProtocol *protocol,
                                           NSURLRequest *request) {
      NSMutableDictionary *payload = [[self successPayload] mutableCopy];
      if ([name isEqualToString:@"id"]) {
        [payload removeObjectForKey:@"id"];
      } else if ([name isEqualToString:@"model"]) {
        [payload removeObjectForKey:@"model"];
      } else if ([name isEqualToString:@"mismatch"]) {
        payload[@"model"] = @"deepseek-v4-pro";
      } else if ([name isEqualToString:@"empty"]) {
        payload[@"choices"] = @[];
      } else if ([name isEqualToString:@"tool"]) {
        NSMutableDictionary *choice = [payload[@"choices"][0] mutableCopy];
        NSMutableDictionary *message = [choice[@"message"] mutableCopy];
        message[@"tool_calls"] = @[@{ @"id": @"bad", @"type": @"function" }];
        choice[@"message"] = message;
        payload[@"choices"] = @[choice];
      } else {
        NSMutableDictionary *choice = [payload[@"choices"][0] mutableCopy];
        choice[@"finish_reason"] = @"tool_calls";
        payload[@"choices"] = @[choice];
      }
      [self respondJSONFromProtocol:protocol request:request payload:payload status:200];
    }];
    __block NSString *errorCode = nil;
    __block NSString *description = nil;
    NSURLSessionDataTask *task = [self startWithBody:[self bodyData]
                                           providerId:DSHTransportProviderRequestId
                                            bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
      return YES;
    }
                                          claimRound:^BOOL(__unused BOOL *redirected) {
      return YES;
    }
                               generationIsCurrent:^BOOL(__unused NSUInteger generation) {
      return YES;
    }
                                          completion:^(__unused NSDictionary *result,
                                                       NSString *value) {
      errorCode = [value copy];
      description = [NSString stringWithFormat:@"%@", value];
      [finished fulfill];
    }];
    XCTAssertNotNil(task);
    [self waitForExpectations:@[finished] timeout:3];
    XCTAssertEqualObjects(errorCode, entry[@"error"]);
    XCTAssertFalse([description containsString:@"sentinel"]);
    XCTAssertFalse([self.transport handlesTask:task]);
  }
}

- (void)testCredentialGenerationFailsBeforeBindAfterBindAndBeforeResolve {
  __block NSUInteger prebindCalls = 0;
  __block NSString *prebindError = nil;
  NSURLSessionDataTask *prebindTask = [self startWithBody:[self bodyData]
                                               providerId:DSHTransportProviderRequestId
                                                bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
    XCTFail(@"credential mismatch must fail before bind");
    return YES;
  }
                                              claimRound:^BOOL(__unused BOOL *redirected) {
    return YES;
  }
                                       generationIsCurrent:^BOOL(__unused NSUInteger value) {
    prebindCalls += 1;
    return NO;
  }
                                              completion:^(__unused NSDictionary *result,
                                                           NSString *value) {
    prebindError = [value copy];
  }];
  XCTAssertNil(prebindTask);
  XCTAssertEqual(prebindCalls, 1u);
  XCTAssertEqualObjects(prebindError, @"E_COMPLETION_CREDENTIAL_CHANGED");

  __block NSUInteger postbindCalls = 0;
  __block NSString *postbindError = nil;
  NSURLSessionDataTask *postbindTask = [self startWithBody:[self bodyData]
                                                providerId:DSHTransportProviderRequestId
                                                 bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
    return YES;
  }
                                               claimRound:^BOOL(__unused BOOL *redirected) {
    return YES;
  }
                                        generationIsCurrent:^BOOL(__unused NSUInteger value) {
    postbindCalls += 1;
    return postbindCalls == 1;
  }
                                               completion:^(__unused NSDictionary *result,
                                                            NSString *value) {
    postbindError = [value copy];
  }];
  XCTAssertNil(postbindTask);
  XCTAssertEqual(postbindCalls, 2u);
  XCTAssertEqualObjects(postbindError, @"E_COMPLETION_CREDENTIAL_CHANGED");
  XCTAssertEqual([DSHTransportURLProtocol requestCount], 0u);

  XCTestExpectation *presolveFinished =
      [self expectationWithDescription:@"presolve"];
  __block NSUInteger presolveCalls = 0;
  __block NSString *presolveError = nil;
  [DSHTransportURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    [self respondJSONFromProtocol:protocol request:request
                           payload:[self successPayload] status:200];
  }];
  NSURLSessionDataTask *presolveTask = [self startWithBody:[self bodyData]
                                                  providerId:DSHTransportProviderRequestId
                                                   bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
    return YES;
  }
                                                 claimRound:^BOOL(__unused BOOL *redirected) {
    return YES;
  }
                                          generationIsCurrent:^BOOL(__unused NSUInteger value) {
    presolveCalls += 1;
    return presolveCalls < 3;
  }
                                                 completion:^(__unused NSDictionary *result,
                                                              NSString *value) {
    presolveError = [value copy];
    [presolveFinished fulfill];
  }];
  XCTAssertNotNil(presolveTask);
  [self waitForExpectations:@[presolveFinished] timeout:3];
  XCTAssertEqual(presolveCalls, 3u);
  XCTAssertEqualObjects(presolveError, @"E_COMPLETION_CREDENTIAL_CHANGED");
}

- (void)testCancelledResponseRaceNeverSettlesAfterOwnerLosesClaim {
  XCTestExpectation *requestStarted =
      [self expectationWithDescription:@"request started"];
  XCTestExpectation *unexpectedSettlement =
      [self expectationWithDescription:@"unexpected settlement"];
  unexpectedSettlement.inverted = YES;
  dispatch_semaphore_t responseGate = dispatch_semaphore_create(0);
  __block NSUInteger settlements = 0;
  [DSHTransportURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    [requestStarted fulfill];
    dispatch_semaphore_wait(responseGate, DISPATCH_TIME_FOREVER);
    [self respondJSONFromProtocol:protocol request:request
                           payload:[self successPayload] status:200];
  }];
  NSURLSessionDataTask *task = [self startWithBody:[self bodyData]
                                         providerId:DSHTransportProviderRequestId
                                          bindTask:^BOOL(__unused NSURLSessionDataTask *value) {
    return YES;
  }
                                        claimRound:^BOOL(__unused BOOL *redirected) {
    return NO;
  }
                                 generationIsCurrent:^BOOL(__unused NSUInteger value) {
    return YES;
  }
                                        completion:^(__unused NSDictionary *result,
                                                     __unused NSString *errorCode) {
    settlements += 1;
    [unexpectedSettlement fulfill];
  }];
  XCTAssertNotNil(task);
  [self waitForExpectations:@[requestStarted] timeout:3];
  [self.transport cancelTask:task];
  dispatch_semaphore_signal(responseGate);
  [self waitForExpectations:@[unexpectedSettlement] timeout:0.3];
  XCTAssertEqual(settlements, 0u);
  XCTAssertFalse([self.transport handlesTask:task]);
}

@end
