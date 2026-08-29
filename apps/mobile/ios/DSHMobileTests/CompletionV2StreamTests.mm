#import <XCTest/XCTest.h>
#import <Security/Security.h>

#import "../../../../modules/rish/ios/Sources/DSHCompletionV2.h"

// Reuses the URL-protocol mock defined by CompletionV2Tests (same test
// bundle): every request is intercepted so the tests below never touch the
// network.
typedef void (^DSHStreamProtocolHandler)(NSURLProtocol *protocol,
                                         NSURLRequest *request);

@interface DSHCompletionURLProtocol : NSURLProtocol
+ (void)setHandler:(DSHStreamProtocolHandler)handler;
+ (void)reset;
@end

// Production-private test seam, same pattern as CompletionV2Tests: the
// real class lives in the linked module sources; only the surface used by
// these tests is redeclared here.
@interface LocalRuntimeModule : NSObject
- (instancetype)initForCompletionV2TestingWithConfiguration:
    (NSURLSessionConfiguration *)configuration
    credential:(NSString *)credential
    uuidGenerator:(NSString *(^)(void))uuidGenerator
    monotonicClock:(NSTimeInterval (^)(void))monotonicClock;
- (void)completeV2StreamEnvelopeJSON:(NSString *)envelopeJSON
                            resolver:(void (^)(id result))resolve
                            rejecter:(void (^)(NSString *code, NSString *message,
                                               NSError *error))reject;
- (void)cancelCompletionRequestId:(NSString *)requestId
                         resolver:(void (^)(id result))resolve
                         rejecter:(void (^)(NSString *code, NSString *message,
                                            NSError *error))reject;
@end

// Private cancellation seam: credential rotation must settle an in-flight
// stream exactly like an explicit cancel does.
@interface LocalRuntimeModule (DSHStreamTesting)
- (void)credentialDidChange;
@end

@interface DSHStreamTestLocalRuntimeModule : LocalRuntimeModule
@end

@implementation DSHStreamTestLocalRuntimeModule

- (NSURL *)applicationSupportURL:(NSError **)error {
  NSURL *root = [[NSURL fileURLWithPath:NSTemporaryDirectory()
                            isDirectory:YES]
      URLByAppendingPathComponent:@"rish-stream-tests"
                       isDirectory:YES];
  if (![[NSFileManager defaultManager] createDirectoryAtURL:root
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:error]) {
    return nil;
  }
  return root;
}

- (OSStatus)credentialLookupStatus {
  return errSecItemNotFound;
}

@end

@interface CompletionV2StreamTests : XCTestCase
@end

@implementation CompletionV2StreamTests

static NSData *DSHSSEChunk(NSDictionary *chunk) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:chunk
                                                 options:0
                                                   error:nil];
  NSMutableData *out = [NSMutableData dataWithBytes:"data: " length:6];
  [out appendData:json];
  [out appendBytes:"\n\n" length:2];
  return out;
}

static NSDictionary *DSHContentDelta(NSString *content) {
  return @{@"choices": @[
    @{@"delta": @{@"content": content}},
  ]};
}

static NSDictionary *DSHDoneDelta(void) {
  return @{@"choices": @[
    @{@"delta": @{}, @"finish_reason": @"stop"},
  ]};
}

- (void)tearDown {
  [DSHCompletionURLProtocol reset];
  [super tearDown];
}

- (LocalRuntimeModule *)streamTestModule {
  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.protocolClasses = @[DSHCompletionURLProtocol.class];
  return [[DSHStreamTestLocalRuntimeModule alloc]
      initForCompletionV2TestingWithConfiguration:configuration
      credential:@"test-credential-not-a-secret"
      uuidGenerator:^NSString *{
        return @"44444444-4444-4444-8444-444444444444";
      }
      monotonicClock:^NSTimeInterval { return 10.0; }];
}

- (NSString *)validStreamEnvelopeJSON {
  NSDictionary *envelope = @{
    @"schema_version": @1,
    @"model": @"deepseek-v4-flash",
    @"request_id": @"11111111-1111-4111-8111-111111111111",
    @"thinking_mode": @"high",
    @"history": @[ @{@"role": @"user", @"content": @"hello"} ],
    @"tools": @[],
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:envelope
                                                 options:0
                                                   error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

- (void)testStreamResolvesAssembledContentAcrossChunkBoundaries {
  LocalRuntimeModule *module = [self streamTestModule];
  [DSHCompletionURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL
         statusCode:200
        HTTPVersion:@"HTTP/1.1"
       headerFields:@{@"Content-Type": @"text/event-stream"}];
    [protocol.client URLProtocol:protocol
              didReceiveResponse:response
              cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    NSData *reasoning = DSHSSEChunk(@{@"choices": @[
      @{@"delta": @{@"reasoning_content": @"thinking "}},
    ]});
    [protocol.client URLProtocol:protocol didLoadData:reasoning];
    // One content event split across two raw deliveries.
    NSData *content = DSHSSEChunk(DSHContentDelta(@"Hello"));
    [protocol.client URLProtocol:protocol
          didLoadData:[content subdataWithRange:NSMakeRange(0, 13)]];
    [protocol.client URLProtocol:protocol
          didLoadData:[content subdataWithRange:NSMakeRange(13,
              content.length - 13)]];
    [protocol.client URLProtocol:protocol didLoadData:DSHSSEChunk(DSHDoneDelta())];
    [protocol.client URLProtocol:protocol
          didLoadData:[@"data: [DONE]\n\n"
              dataUsingEncoding:NSUTF8StringEncoding]];
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];

  XCTestExpectation *resolved = [self expectationWithDescription:@"resolved"];
  __block NSDictionary *result = nil;
  __block NSString *rejection = nil;
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) {
        result = value;
        [resolved fulfill];
      }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        rejection = code;
        [resolved fulfill];
      }];
  [self waitForExpectations:@[resolved] timeout:5];

  XCTAssertNil(rejection);
  XCTAssertNotNil(result);
  XCTAssertEqualObjects(result[@"text"], @"Hello");
  XCTAssertEqualObjects(result[@"reasoning"], @"thinking ");
  XCTAssertEqualObjects(result[@"finish_reason"], @"stop");
  XCTAssertEqualObjects(result[@"request_id"],
                        @"11111111-1111-4111-8111-111111111111");
}

- (void)testStreamParseErrorFailsClosedWithTransportRejection {
  LocalRuntimeModule *module = [self streamTestModule];
  [DSHCompletionURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL
         statusCode:200
        HTTPVersion:@"HTTP/1.1"
       headerFields:@{@"Content-Type": @"text/event-stream"}];
    [protocol.client URLProtocol:protocol
              didReceiveResponse:response
              cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [protocol.client URLProtocol:protocol
          didLoadData:[@"data: this-is-not-json\n\n"
              dataUsingEncoding:NSUTF8StringEncoding]];
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];

  XCTestExpectation *settled = [self expectationWithDescription:@"settled"];
  __block NSString *rejection = nil;
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) { [settled fulfill]; }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        rejection = code;
        [settled fulfill];
      }];
  [self waitForExpectations:@[settled] timeout:5];
  XCTAssertEqualObjects(rejection, @"transport");
}

- (void)testStreamResponseSizeCapFailsClosed {
  // The non-streaming transport rejects responses over 8 MiB; a stream
  // that keeps producing content must not accumulate without bound.
  // 70 x 128 KiB payloads cross the cap well inside the per-line limit.
  LocalRuntimeModule *module = [self streamTestModule];
  [DSHCompletionURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL
         statusCode:200
        HTTPVersion:@"HTTP/1.1"
       headerFields:@{@"Content-Type": @"text/event-stream"}];
    [protocol.client URLProtocol:protocol
              didReceiveResponse:response
              cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    NSUInteger chunkBytes = 128 * 1024;
    NSString *chunk = [@"" stringByPaddingToLength:chunkBytes
                                        withString:@"a"
                                   startingAtIndex:0];
    for (NSInteger index = 0; index < 70; index += 1) {
      [protocol.client URLProtocol:protocol
            didLoadData:DSHSSEChunk(DSHContentDelta(chunk))];
    }
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];

  XCTestExpectation *settled = [self expectationWithDescription:@"settled"];
  __block NSString *rejection = nil;
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) { [settled fulfill]; }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        rejection = code;
        [settled fulfill];
      }];
  [self waitForExpectations:@[settled] timeout:10];
  XCTAssertEqualObjects(rejection, @"transport");
}

- (void)testSecondStreamRejectsBusyWhileFirstIsInFlight {
  LocalRuntimeModule *module = [self streamTestModule];
  // First request never completes: it holds the active slot.
  [DSHCompletionURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
  }];

  XCTestExpectation *busyRejected = [self expectationWithDescription:@"busy"];
  __block NSString *firstCode = nil;
  __block NSString *secondCode = nil;
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) {
        XCTFail(@"held first stream must not resolve");
      }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        firstCode = code;
      }];
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) {
        XCTFail(@"second stream must be rejected busy");
      }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        secondCode = code;
        [busyRejected fulfill];
      }];
  [self waitForExpectations:@[busyRejected] timeout:5];
  XCTAssertEqualObjects(secondCode, @"E_COMPLETION_BUSY");
  XCTAssertNil(firstCode);
}

- (void)testCancelThenRestartSettlesBothStreamsInIsolation {
  LocalRuntimeModule *module = [self streamTestModule];
  __block NSURLProtocol *firstProtocol = nil;
  __block BOOL firstStarted = NO;
  [DSHCompletionURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
    if (!firstStarted) {
      firstStarted = YES;
      firstProtocol = protocol;
      // Deliver one partial delta, then hold: the first stream stays open
      // until it is explicitly cancelled.
      NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
          initWithURL:request.URL
           statusCode:200
          HTTPVersion:@"HTTP/1.1"
         headerFields:@{@"Content-Type": @"text/event-stream"}];
      [protocol.client URLProtocol:protocol
                didReceiveResponse:response
                cacheStoragePolicy:NSURLCacheStorageNotAllowed];
      [protocol.client URLProtocol:protocol
            didLoadData:DSHSSEChunk(DSHContentDelta(@"first-"))];
      return;
    }
    // Second stream completes immediately with its own content.
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL
         statusCode:200
        HTTPVersion:@"HTTP/1.1"
       headerFields:@{@"Content-Type": @"text/event-stream"}];
    [protocol.client URLProtocol:protocol
              didReceiveResponse:response
              cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [protocol.client URLProtocol:protocol
          didLoadData:DSHSSEChunk(DSHContentDelta(@"second"))];
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];

  XCTestExpectation *firstSettled = [self expectationWithDescription:@"first"];
  __block NSString *firstRejection = nil;
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) {
        XCTFail(@"cancelled stream must not resolve");
      }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        firstRejection = code;
        [firstSettled fulfill];
      }];

  XCTestExpectation *secondSettled = [self expectationWithDescription:@"second"];
  __block NSDictionary *secondResult = nil;
  __block NSString *secondRejection = nil;
  __block BOOL secondInvoked = NO;

  // Cancel the first stream, then start the second without waiting for the
  // cancellation callback: the first promise must still settle, and the
  // second must resolve with only its own content.
  [module cancelCompletionRequestId:@"11111111-1111-4111-8111-111111111111"
      resolver:^(id value) {}
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        XCTFail(@"cancelCompletion must not reject");
      }];
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) {
        if (!secondInvoked) {
          secondInvoked = YES;
          secondResult = value;
          [secondSettled fulfill];
        }
      }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        if (!secondInvoked) {
          secondInvoked = YES;
          secondRejection = code;
          [secondSettled fulfill];
        }
      }];

  [self waitForExpectations:@[firstSettled, secondSettled] timeout:5];
  XCTAssertEqualObjects(firstRejection, @"cancelled");
  XCTAssertNil(secondRejection);
  XCTAssertNotNil(secondResult);
  XCTAssertEqualObjects(secondResult[@"text"], @"second");
  (void)firstProtocol;
}

- (void)testCredentialRotationSettlesAnInFlightStream {
  LocalRuntimeModule *module = [self streamTestModule];
  [DSHCompletionURLProtocol setHandler:^(NSURLProtocol *protocol,
                                         NSURLRequest *request) {
  }];

  XCTestExpectation *settled = [self expectationWithDescription:@"settled"];
  __block NSString *rejection = nil;
  [module completeV2StreamEnvelopeJSON:[self validStreamEnvelopeJSON]
      resolver:^(id value) {
        XCTFail(@"rotated stream must not resolve");
      }
      rejecter:^(NSString *code, NSString *message, NSError *error) {
        rejection = code;
        [settled fulfill];
      }];
  [module credentialDidChange];
  [self waitForExpectations:@[settled] timeout:5];
  XCTAssertEqualObjects(rejection, @"cancelled");
}

- (void)testStreamEnvelopeValidationFailsClosed {
  LocalRuntimeModule *module = [self streamTestModule];
  NSString *(^invoke)(id) = ^NSString *(id raw) {
    __block NSString *code = nil;
    @try {
      [module completeV2StreamEnvelopeJSON:(NSString *)raw
          resolver:^(id value) {
            XCTFail(@"must not resolve");
          }
          rejecter:^(NSString *value, NSString *message, NSError *error) {
            code = value;
          }];
    } @catch (NSException *exception) {
      XCTFail(@"must fail closed, not throw: %@", exception.name);
    }
    return code;
  };
  XCTAssertEqualObjects(invoke(nil), @"request");
  XCTAssertEqualObjects(invoke(NSNull.null), @"request");
  XCTAssertEqualObjects(invoke(@""), @"request");

  @autoreleasepool {
    NSUInteger cap = 40 * 1024 * 1024;
    NSString *atCap = [@"" stringByPaddingToLength:cap
                                        withString:@" "
                                   startingAtIndex:0];
    XCTAssertEqualObjects(invoke(atCap), @"request");
    NSString *overCap = [atCap stringByAppendingString:@" "];
    XCTAssertEqualObjects(invoke(overCap), @"request");
  }
}

@end
