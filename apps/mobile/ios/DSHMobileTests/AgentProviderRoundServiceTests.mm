#import <XCTest/XCTest.h>

#import "../../../../modules/rish/ios/Sources/AgentProviderRoundService.h"
#import "../../../../modules/rish/ios/Sources/DshProviderTransport.h"
#import "../../../../modules/rish/ios/Sources/ClaudeProviderTransport.h"
#import "../../../../modules/rish/ios/Sources/CodexProviderTransport.h"
#import "../../../../modules/rish/ios/Sources/AgentProviderRoundServiceInternals.h"
#import "../../../../modules/rish/ios/Sources/DSHCompletionV2.h"
#import "../../../../modules/rish/ios/Sources/DSHWorkspaceCanonical.h"

typedef void (^DSHProviderURLProtocolHandler)(NSURLProtocol *protocol,
                                              NSURLRequest *request);

static NSData *DSHProviderCapturedRequestBody(NSURLRequest *request) {
  if (request.HTTPBody != nil) return request.HTTPBody;
  NSInputStream *stream = request.HTTPBodyStream;
  if (stream == nil) return nil;
  NSMutableData *data = [NSMutableData data];
  uint8_t buffer[4096];
  [stream open];
  while (YES) {
    NSInteger count = [stream read:buffer maxLength:sizeof(buffer)];
    if (count < 0) {
      [stream close];
      return nil;
    }
    if (count == 0) break;
    [data appendBytes:buffer length:(NSUInteger)count];
  }
  [stream close];
  return [data copy];
}

@interface DSHProviderURLProtocol : NSURLProtocol
+ (void)setHandler:(DSHProviderURLProtocolHandler)handler;
+ (void)reset;
+ (NSUInteger)requestCount;
@end

@implementation DSHProviderURLProtocol
static DSHProviderURLProtocolHandler DSHProviderHandler;
static NSUInteger DSHProviderRequestCount;
+ (void)setHandler:(DSHProviderURLProtocolHandler)handler {
  @synchronized(self) { DSHProviderHandler = [handler copy]; }
}
+ (void)reset {
  @synchronized(self) { DSHProviderHandler = nil; DSHProviderRequestCount = 0; }
}
+ (NSUInteger)requestCount {
  @synchronized(self) { return DSHProviderRequestCount; }
}
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return [request.URL.scheme.lowercaseString isEqualToString:@"https"];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  DSHProviderURLProtocolHandler handler = nil;
  @synchronized(self.class) {
    DSHProviderRequestCount += 1;
    handler = [DSHProviderHandler copy];
  }
  if (handler != nil) {
    handler(self, self.request);
  } else {
    [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"provider-smoke"
                                                                        code:1
                                                                    userInfo:nil]];
  }
}
- (void)stopLoading {}
@end

@interface DSHProviderURLSessionDelegate : NSObject <NSURLSessionTaskDelegate>
@property(nonatomic, weak) DSHCompletionProviderTransport *transport;
@end

@implementation DSHProviderURLSessionDelegate
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

static NSString *const DSHProviderSmokeTask =
    @"11111111-1111-4111-8111-111111111111";
static NSString *const DSHProviderSmokeConversation =
    @"22222222-2222-4222-8222-222222222222";
static NSString *const DSHProviderSmokeRound =
    @"33333333-3333-4333-8333-333333333333";
static NSString *const DSHProviderSmokeAttempt =
    @"44444444-4444-4444-8444-444444444444";
static NSString *const DSHProviderSmokeOperation =
    @"55555555-5555-4555-8555-555555555555";
static NSString *const DSHProviderSmokeRootDigest =
    @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static NSString *const DSHProviderSmokeTranscriptDigest =
    @"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static NSString *const DSHProviderSmokeSessionDigest =
    @"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
static NSString *const DSHProviderSmokeDigest =
    @"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

@interface DSHProviderSmokePreparedStore : DSHAgentPreparedAttemptStore
@property(nonatomic, copy) NSDictionary *authority;
@property(nonatomic, copy) NSDictionary *root;
@end

@implementation DSHProviderSmokePreparedStore
- (instancetype)initWithAuthority:(NSDictionary *)authority
                              root:(NSDictionary *)root
                               wal:(DSHAgentNativeWAL *)wal {
  self = [super initWithWAL:wal
               rootResolver:(DSHAgentRootResolver *)(id)NSNull.null
         sessionSnapshotStore:(DSHSessionSnapshotStore *)(id)NSNull.null
              transcriptStore:nil];
  if (self != nil) {
    _authority = [authority copy];
    _root = [root copy];
  }
  return self;
}
- (NSDictionary *)nativeAuthorityForTaskId:(NSString *)taskId
                                  attemptId:(NSString *)attemptId
                                      error:(NSError **)error {
  if (error != nullptr) *error = nil;
  return self.authority;
}
- (BOOL)validatePreparedRoot:(NSDictionary *)root
                      taskId:(NSString *)taskId
                   attemptId:(NSString *)attemptId
                        error:(NSError **)error {
  if (error != nullptr) *error = nil;
  return [root isEqual:self.root];
}
@end

@interface DSHProviderSmokeTranscriptStore : DSHAgentTranscriptStore
@property(nonatomic, copy) NSArray *messages;
@end

@implementation DSHProviderSmokeTranscriptStore
- (instancetype)initWithMessages:(NSArray *)messages wal:(DSHAgentNativeWAL *)wal {
  self = [super initWithWAL:wal];
  if (self != nil) _messages = [messages copy];
  return self;
}
- (NSArray *)nativeMessagesForTranscriptWithRequest:(NSDictionary *)request
                                               error:(NSError **)error {
  if (error != nullptr) *error = nil;
  return self.messages;
}
@end

@interface DSHProviderSmokeRoundJournal : DSHAgentRoundJournal
@property(nonatomic, copy) NSDictionary *row;
@property(nonatomic) NSUInteger createCount;
@property(nonatomic) NSUInteger dispatchCount;
@property(nonatomic) NSUInteger completeCount;
@property(nonatomic) NSUInteger reconcileCount;
@property(nonatomic, copy) NSDictionary *providerTranscript;
@property(nonatomic, copy) NSArray *completedMessages;
@property(nonatomic) BOOL reconcileToFailedRetryable;
@property(nonatomic) BOOL failNextWALTransactionAfterComplete;
@end

@interface DSHProviderCommitFailingWAL : DSHAgentNativeWAL
@property(nonatomic) BOOL failNextTransaction;
@end

@implementation DSHProviderCommitFailingWAL
- (BOOL)performAtomicTransaction:(DSHAgentNativeWALMutation)mutation
                           error:(NSError **)error {
  if (self.failNextTransaction) {
    self.failNextTransaction = NO;
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorPersistence);
    return NO;
  }
  return [super performAtomicTransaction:mutation error:error];
}
@end

@implementation DSHProviderSmokeRoundJournal
- (instancetype)initWithRow:(NSDictionary *)row wal:(DSHAgentNativeWAL *)wal {
  self = [super initWithWAL:wal];
  if (self != nil) _row = [row copy];
  return self;
}
- (NSDictionary *)createAgentRoundV3WithInsertCAS:(NSDictionary *)insertCAS
                                  exactRoundStart:(NSDictionary *)round
                                            error:(NSError **)error {
  if (error != nullptr) *error = nil;
  self.createCount += 1;
  self.row = [round copy];
  return @{ @"schema_version" : @3, @"status" : @"inserted", @"row" : self.row };
}
- (NSDictionary *)markAgentRoundV3DispatchedWithCAS:(NSDictionary *)cas
                                               error:(NSError **)error {
  if (error != nullptr) *error = nil;
  self.dispatchCount += 1;
  NSMutableDictionary *row = [self.row mutableCopy];
  row[@"row_revision"] = @2;
  self.row = row;
  return @{ @"schema_version" : @3, @"status" : @"dispatched", @"row" : self.row };
}
- (NSDictionary *)completeAgentRoundV3WithLocator:(NSDictionary *)locator
                                      expectedCAS:(NSDictionary *)cas
                                         messages:(NSArray *)messages
                                completionReceipt:(NSDictionary *)receipt
                                     terminalKind:(NSString *)terminalKind
                                           calls:(NSArray *)calls
                                            root:(NSDictionary *)root
                                            error:(NSError **)error {
  if (error != nullptr) *error = nil;
  self.completeCount += 1;
  self.completedMessages = [messages copy];
  NSMutableDictionary *row = [self.row mutableCopy];
  row[@"row_revision"] = @3;
  row[@"state"] = @"completed";
  row[@"owner"] = NSNull.null;
  row[@"completion_receipt"] = receipt;
  row[@"transcript_after"] = self.providerTranscript;
  row[@"terminal_kind"] = terminalKind;
  row[@"calls"] = calls;
  row[@"batch_class"] = calls.count == 0 ? NSNull.null : @"executable";
  row[@"executable_call_count"] = @(calls.count);
  row[@"denied_call_count"] = @0;
  row[@"failure_code"] = NSNull.null;
  self.row = row;
  if (self.failNextWALTransactionAfterComplete &&
      [self.wal isKindOfClass:DSHProviderCommitFailingWAL.class]) {
    ((DSHProviderCommitFailingWAL *)self.wal).failNextTransaction = YES;
    self.failNextWALTransactionAfterComplete = NO;
  }
  return @{ @"schema_version" : @3, @"status" : @"completed",
            @"row" : self.row, @"transcript" : self.providerTranscript };
}
- (NSDictionary *)queryAgentRoundV3WithLocator:(NSDictionary *)locator
                                          error:(NSError **)error {
  if (error != nullptr) *error = nil;
  return @{ @"schema_version" : @3, @"status" : self.row[@"state"] ?: @"in_flight",
            @"row" : self.row };
}
- (NSDictionary *)reconcileAgentRoundV3OwnerLossWithLocator:(NSDictionary *)locator
                                                  expectedCAS:(NSDictionary *)cas
                                                         error:(NSError **)error {
  if (error != nullptr) *error = nil;
  self.reconcileCount += 1;
  NSMutableDictionary *row = [self.row mutableCopy];
  row[@"row_revision"] = @3;
  row[@"state"] = self.reconcileToFailedRetryable
      ? @"failed_retryable" : @"ambiguous";
  row[@"owner"] = NSNull.null;
  row[@"failure_code"] = self.reconcileToFailedRetryable
      ? @"E_AGENT_PERSISTENCE" : @"E_AGENT_ROUND_AMBIGUOUS";
  row[@"completion_receipt"] = NSNull.null;
  row[@"transcript_after"] = NSNull.null;
  row[@"terminal_kind"] = NSNull.null;
  self.row = row;
  return @{ @"schema_version" : @3, @"status" : @"ambiguous", @"row" : self.row };
}
- (NSDictionary *)cancelAgentRoundV3WithCAS:(NSDictionary *)cas
                                       error:(NSError **)error {
  if (error != nullptr) *error = nil;
  NSMutableDictionary *row = [self.row mutableCopy];
  row[@"row_revision"] = @2;
  row[@"state"] = @"cancel_requested";
  self.row = row;
  return @{ @"schema_version" : @3, @"status" : @"cancel_requested", @"row" : self.row };
}
@end

@interface DSHProviderSmokeTransport : DshProviderTransport
@property(nonatomic, copy) NSDictionary *result;
@property(nonatomic, copy) void (^pendingCompletion)(NSDictionary *, NSString *);
@property(nonatomic) NSUInteger startCount;
@property(nonatomic, copy) NSData *lastBodyData;
@property(nonatomic, copy) NSArray *lastModelInput;
@property(nonatomic) BOOL holdResponse;
@property(nonatomic) BOOL rejectCredentialGeneration;
@end

@implementation DSHProviderSmokeTransport
- (instancetype)initWithResult:(NSDictionary *)result {
  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
  self = [super initWithSession:session
                  uuidGenerator:^NSString *{
                    return @"66666666-6666-4666-8666-666666666666";
                  }
                   monotonicClock:^NSTimeInterval {
                     return 2.0;
                   }];
  if (self != nil) _result = [result copy];
  return self;
}
- (NSURLSessionDataTask *)startRequestWithSchemaVersion:(NSInteger)schemaVersion
                                                 roundId:(NSString *)roundId
                                               generation:(NSUInteger)generation
                                     credentialGeneration:(NSUInteger)credentialGeneration
                                              providerRequestId:(NSString *)providerRequestId
                                                    credential:(NSString *)credential
                                                requestedModel:(NSString *)requestedModel
                                                 thinkingMode:(NSString *)thinkingMode
                                  credentialGenerationIsCurrent:(DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock)generationCheck
                                                     startedAt:(NSTimeInterval)startedAt
                                                      bodyData:(NSData *)bodyData
                                                  visibleHistory:(NSArray *)visibleHistory
                                                      modelInput:(NSArray *)modelInput
                                                        bindTask:(DSHCompletionProviderTransportBindTaskBlock)bindTask
                                                      claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                                                   markRedirected:(DSHCompletionProviderTransportMarkRedirectedBlock)markRedirected
                                                redirectDecision:(DSHCompletionProviderTransportRedirectDecisionBlock)redirectDecision
                                                      completion:(DSHCompletionProviderTransportCompletionBlock)completion {
  (void)schemaVersion; (void)roundId; (void)generation; (void)credentialGeneration;
  (void)providerRequestId; (void)credential; (void)requestedModel;
  (void)thinkingMode; (void)startedAt; (void)visibleHistory; (void)bindTask;
  (void)claimRound; (void)markRedirected; (void)redirectDecision;
  self.startCount += 1;
  self.lastBodyData = bodyData;
  self.lastModelInput = [modelInput copy];
  if (self.rejectCredentialGeneration ||
      (generationCheck != nil && !generationCheck(7))) {
    completion(nil, @"E_COMPLETION_CREDENTIAL_CHANGED");
  } else if (self.holdResponse) {
    self.pendingCompletion = [completion copy];
  } else {
    NSError *digestError = nil;
    NSData *visibleBytes = [NSJSONSerialization dataWithJSONObject:visibleHistory
                                                               options:NSJSONWritingSortedKeys
                                                                 error:&digestError];
    NSData *modelBytes = [NSJSONSerialization dataWithJSONObject:modelInput
                                                             options:NSJSONWritingSortedKeys
                                                               error:&digestError];
    NSMutableDictionary *result = [self.result mutableCopy];
    result[@"visible_history_sha256"] = DSHWorkspaceSHA256Hex(visibleBytes);
    result[@"model_input_sha256"] = DSHWorkspaceSHA256Hex(modelBytes);
    result[@"request_body_sha256"] = DSHWorkspaceSHA256Hex(bodyData);
    completion([result copy], nil);
  }
  return nil;
}
@end

static NSDictionary *DSHProviderSmokeRoot(void) {
  return @{
    @"schema_version" : @1,
    @"kind" : @"workspace",
    @"workspace_id" : @"77777777-7777-4777-8777-777777777777",
    @"workspace_binding_revision" : @7,
    @"project_id" : NSNull.null,
    @"root_fingerprint_sha256" : DSHProviderSmokeRootDigest,
    @"capabilities" : @[ @"file_read", @"file_write" ],
  };
}

static NSDictionary *DSHProviderSmokeTranscript(void) {
  return @{
    @"schema_version" : @1,
    @"transcript_ref" : @"88888888-8888-4888-8888-888888888888",
    @"generation" : @0,
    @"transcript_sha256" : DSHProviderSmokeTranscriptDigest,
    @"transcript_bytes" : @1,
  };
}

static NSString *DSHProviderSmokeVisibleDigest(void) {
  return DSHAgentHJ(@"visible-history", @{
    @"messages" : @[ @{ @"role" : @"user", @"content" : @"hello" } ],
  }, nil);
}

static NSDictionary *DSHProviderSmokeAuthority(NSDictionary *root,
                                               NSDictionary *transcript,
                                               NSDictionary *registry) {
  return @{
    @"task_id" : DSHProviderSmokeTask,
    @"conversation_id" : DSHProviderSmokeConversation,
    @"attempt_id" : DSHProviderSmokeAttempt,
    @"root" : root,
    @"transcript" : transcript,
    @"registry" : registry,
    @"transport_schema_version" : @2,
    @"authority_revision" : @1,
    @"model" : @"deepseek-v4-flash",
    @"thinking_mode" : @"off",
    @"visible_history_sha256" : DSHProviderSmokeVisibleDigest(),
    @"visible_message_count" : @1,
    @"project_context_sha256" : NSNull.null,
  };
}

static NSDictionary *DSHProviderSmokeRequest(NSDictionary *root,
                                             NSDictionary *transcript,
                                             NSString *toolsetSHA256,
                                             NSString *operationId) {
  NSDictionary *checkpoint = @{
    @"schema_version" : @1,
    @"journal_revision" : @0,
    @"session_generation" : @3,
    @"session_sha256" : DSHProviderSmokeSessionDigest,
  };
  return @{
    @"schema_version" : @2,
    @"operation_id" : operationId,
    @"controller_cas" : @{
      @"schema_version" : @1,
      @"conversation_id" : DSHProviderSmokeConversation,
      @"task_id" : DSHProviderSmokeTask,
      @"attempt_id" : DSHProviderSmokeAttempt,
      @"expected_controller_generation" : @2,
      @"expected_journal_revision" : @0,
      @"expected_session_generation" : @3,
      @"expected_session_sha256" : DSHProviderSmokeSessionDigest,
    },
    @"committed_checkpoint" : checkpoint,
    @"task_id" : DSHProviderSmokeTask,
    @"conversation_id" : DSHProviderSmokeConversation,
    @"attempt_id" : DSHProviderSmokeAttempt,
    @"round_id" : DSHProviderSmokeRound,
    @"round_index" : @0,
    @"launch_attempt" : @1,
    @"expected_round_revision" : @0,
    @"transport_schema_version" : @2,
    @"model" : @"deepseek-v4-flash",
    @"thinking_mode" : @"off",
    @"visible_history_sha256" : DSHProviderSmokeVisibleDigest(),
    @"visible_message_count" : @1,
    @"project_context_sha256" : NSNull.null,
    @"transcript" : transcript,
    @"root" : root,
    @"registry_version" : @1,
    @"toolset_sha256" : toolsetSHA256,
  };
}

static NSDictionary *DSHProviderSmokeQueryRequest(NSDictionary *root,
                                                  NSDictionary *transcript,
                                                  NSUInteger revision,
                                                  BOOL cancellation) {
  NSMutableDictionary *request = [@{
    @"schema_version" : @2,
    @"task_id" : DSHProviderSmokeTask,
    @"attempt_id" : DSHProviderSmokeAttempt,
    @"round_id" : DSHProviderSmokeRound,
    @"round_index" : @0,
    @"expected_round_revision" : @(revision),
    @"transcript" : transcript,
    @"root" : root,
  } mutableCopy];
  if (cancellation) request[@"cancel_token"] = @"99999999-9999-4999-8999-999999999999";
  return [request copy];
}

@interface DSHProviderSmokeFixture : NSObject
@property(nonatomic, strong) DSHAgentNativeWAL *wal;
@property(nonatomic, strong) DSHProviderSmokePreparedStore *prepared;
@property(nonatomic, strong) DSHProviderSmokeTranscriptStore *transcripts;
@property(nonatomic, strong) DSHProviderSmokeRoundJournal *rounds;
@property(nonatomic, strong) DSHProviderSmokeTransport *transport;
@property(nonatomic, strong) DSHAgentProviderRoundService *service;
@property(nonatomic, copy) NSDictionary *root;
@property(nonatomic, copy) NSDictionary *transcript;
@property(nonatomic, copy) NSDictionary *request;
@property(nonatomic, strong) NSURL *walRoot;
@property(nonatomic) BOOL historyAvailable;
@property(nonatomic) BOOL credentialAvailable;
@property(nonatomic) NSUInteger historyCalls;
@property(nonatomic) NSUInteger credentialCalls;
- (instancetype)initWithFaultingCommit:(BOOL)faultingCommit;
@end

@implementation DSHProviderSmokeFixture
- (instancetype)initWithFaultingCommit:(BOOL)faultingCommit {
  self = [super init];
  if (self != nil) {
    _root = DSHProviderSmokeRoot();
    _transcript = DSHProviderSmokeTranscript();
    _historyAvailable = YES;
    _credentialAvailable = YES;
    NSError *registryError = nil;
    DSHAgentToolRegistry *registry = [[DSHAgentToolRegistry alloc] init];
    NSDictionary *registryProjection = [registry registryForRoot:_root
                                                             error:&registryError];
    NSURL *walRoot = [NSURL fileURLWithPath:[NSTemporaryDirectory()
        stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
    _walRoot = walRoot;
    Class walClass = faultingCommit ? DSHProviderCommitFailingWAL.class
                                    : DSHAgentNativeWAL.class;
    _wal = [[walClass alloc]
        initWithRootURL:walRoot
        clock:^NSDate *{
          return [NSDate dateWithTimeIntervalSince1970:1700000000];
        }
        identifierGenerator:^NSString *{
          return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        }
        faultHook:nil];
    NSDictionary *authority = DSHProviderSmokeAuthority(_root, _transcript,
                                                        registryProjection);
    _prepared = [[DSHProviderSmokePreparedStore alloc]
        initWithAuthority:authority root:_root wal:_wal];
    _transcripts = [[DSHProviderSmokeTranscriptStore alloc]
        initWithMessages:@[] wal:_wal];
    _rounds = [[DSHProviderSmokeRoundJournal alloc] initWithRow:@{} wal:_wal];
    _rounds.providerTranscript = _transcript;
    _transport = [[DSHProviderSmokeTransport alloc]
        initWithResult:@{
          @"provider_request_id" : @"66666666-6666-4666-8666-666666666666",
          @"provider_response_id" : @"response-1",
          @"requested_model" : @"deepseek-v4-flash",
          @"model" : @"deepseek-v4-flash",
          @"thinking_mode" : @"off",
          @"text" : @"done",
          @"reasoning" : @"",
          @"tool_calls" : @[],
          @"finish_reason" : @"stop",
          @"latency_ms" : @1,
          @"visible_history_sha256" : DSHProviderSmokeDigest,
          @"model_input_sha256" : DSHProviderSmokeDigest,
          @"request_body_sha256" : DSHProviderSmokeDigest,
        }];
    _request = DSHProviderSmokeRequest(
        _root, _transcript, registryProjection[@"toolset_sha256"],
        DSHProviderSmokeOperation);
    __weak DSHProviderSmokeFixture *weakSelf = self;
    _service = [[DSHAgentProviderRoundService alloc]
        initWithWAL:_wal
        preparedStore:_prepared
        transcripts:_transcripts
        rounds:_rounds
        transport:_transport
        credentialProvider:^NSString *(NSString *harnessId, NSUInteger *generation) {
          weakSelf.credentialCalls += 1;
          if (!weakSelf.credentialAvailable) return nil;
          if (generation != nullptr) *generation = 7;
          return @"credential";
        }
        visibleHistoryProvider:^NSArray *(NSDictionary *authority, NSError **error) {
          (void)authority; if (error != nullptr) *error = nil;
          weakSelf.historyCalls += 1;
          if (!weakSelf.historyAvailable) return nil;
          return @[ @{ @"role" : @"user", @"content" : @"hello" } ];
        }];
  }
  return self;
}
- (instancetype)init {
  return [self initWithFaultingCommit:NO];
}
- (void)dealloc {
  [NSFileManager.defaultManager removeItemAtURL:_walRoot error:nil];
}
@end

@interface AgentProviderRoundServiceTests : XCTestCase
@end

@implementation AgentProviderRoundServiceTests

- (void)testProviderRoundServiceRejectsMalformedOpenRequestBeforeDependencies {
  // The malformed request is rejected before any native dependency is read;
  // opaque sentinels therefore cannot be dereferenced by this contract test.
  DSHAgentProviderRoundService *service =
      [[DSHAgentProviderRoundService alloc]
          initWithWAL:(DSHAgentNativeWAL *)(id)NSNull.null
          preparedStore:(DSHAgentPreparedAttemptStore *)(id)NSNull.null
          transcripts:(DSHAgentTranscriptStore *)(id)NSNull.null
          rounds:(DSHAgentRoundJournal *)(id)NSNull.null
          transport:(DSHCompletionProviderTransport *)(id)NSNull.null];
  NSError *error = nil;
  NSDictionary *result = [service completeAgentRoundV2WithRequest:@{}
                                                              error:&error];
  XCTAssertNil(result);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorInvalidArgument);
}

- (void)testFourHarnessToolRoundsKeepCredentialEndpointBodyAndReceiptIdentity {
  NSArray *cases = @[
    @[ @"dsh", @"deepseek-v4-flash", @"api.deepseek.com", @"/chat/completions" ],
    @[ @"claude-code", @"claude-sonnet-5", @"api.anthropic.com", @"/v1/messages" ],
    @[ @"codex", @"gpt-5.6", @"api.openai.com", @"/v1/responses" ],
    @[ @"glm", @"GLM-5.3", @"open.bigmodel.cn", @"/api/anthropic/v1/messages" ],
  ];
  for (NSArray *entry in cases) {
    [DSHProviderURLProtocol reset];
    NSString *harnessId = entry[0];
    NSString *model = entry[1];
    NSString *credential = [@"synthetic-credential-" stringByAppendingString:harnessId];
    BOOL anthropicDialect = [harnessId isEqual:@"claude-code"] || [harnessId isEqual:@"glm"];
    DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
    NSMutableDictionary *authority = [fixture.prepared.authority mutableCopy];
    authority[@"model"] = model;
    fixture.prepared.authority = authority;
    NSMutableDictionary *request = [fixture.request mutableCopy];
    request[@"model"] = model;
    request[@"harness_id"] = harnessId;
    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.protocolClasses = @[ DSHProviderURLProtocol.class ];
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
    NSString *(^uuid)(void) = ^NSString *{ return @"66666666-6666-4666-8666-666666666666"; };
    NSTimeInterval (^clock)(void) = ^NSTimeInterval { return 3.0; };
    DshProviderTransport *dsh = [[DshProviderTransport alloc]
        initWithSession:session uuidGenerator:uuid monotonicClock:clock];
    ClaudeProviderTransport *claude = [[ClaudeProviderTransport alloc]
        initWithSession:session uuidGenerator:uuid monotonicClock:clock];
    CodexProviderTransport *codex = [[CodexProviderTransport alloc]
        initWithSession:session uuidGenerator:uuid monotonicClock:clock];
    GlmProviderTransport *glm = [[GlmProviderTransport alloc]
        initWithSession:session uuidGenerator:uuid monotonicClock:clock];
    __block NSUInteger credentialCalls = 0;
    DSHAgentProviderRoundService *service = [[DSHAgentProviderRoundService alloc]
        initWithWAL:fixture.wal preparedStore:fixture.prepared
        transcripts:fixture.transcripts rounds:fixture.rounds
        transport:dsh claudeTransport:claude codexTransport:codex glmTransport:glm
        credentialProvider:^NSString *(NSString *requestedHarness, NSUInteger *generation) {
          credentialCalls += 1;
          XCTAssertEqualObjects(requestedHarness, harnessId);
          if (generation != nullptr) *generation = 7;
          return credential;
        }
        visibleHistoryProvider:^NSArray *(NSDictionary *nativeAuthority, NSError **error) {
          if (error != nullptr) *error = nil;
          return @[ @{ @"role" : @"user", @"content" : @"hello" } ];
        }
        contextReceiptProvider:nil];
    [DSHProviderURLProtocol setHandler:^(NSURLProtocol *protocol, NSURLRequest *httpRequest) {
      XCTAssertEqualObjects(httpRequest.URL.host, entry[2]);
      XCTAssertEqualObjects(httpRequest.URL.path, entry[3]);
      XCTAssertEqualObjects(httpRequest.HTTPMethod, @"POST");
      NSDictionary *body = [NSJSONSerialization JSONObjectWithData:
          DSHProviderCapturedRequestBody(httpRequest) options:0 error:nil];
      XCTAssertEqualObjects(body[@"model"], model);
      XCTAssertEqualObjects(body[@"stream"], @NO);
      NSDictionary *readTool = nil;
      for (NSDictionary *tool in body[@"tools"]) {
        NSString *name = tool[@"name"] ?: tool[@"function"][@"name"];
        if ([name isEqual:@"read_file"]) readTool = tool;
      }
      XCTAssertNotNil(readTool);
      NSDictionary *payload = nil;
      if (anthropicDialect) {
        XCTAssertEqualObjects([httpRequest valueForHTTPHeaderField:@"x-api-key"], credential);
        XCTAssertNil([httpRequest valueForHTTPHeaderField:@"Authorization"]);
        XCTAssertEqualObjects([httpRequest valueForHTTPHeaderField:@"anthropic-version"], @"2023-06-01");
        XCTAssertEqualObjects(body[@"messages"][0][@"content"][0][@"type"], @"text");
        XCTAssertNotNil(readTool[@"input_schema"]);
        XCTAssertNil(readTool[@"function"]);
        payload = @{
          @"id" : @"fixture-response", @"type" : @"message", @"role" : @"assistant",
          @"model" : [harnessId isEqual:@"glm"] ? model.lowercaseString : model,
          @"content" : @[ @{ @"type" : @"tool_use", @"id" : @"call_fixture",
                            @"name" : @"read_file", @"input" : @{ @"path" : @"README.md" } } ],
          @"stop_reason" : @"tool_use", @"stop_sequence" : NSNull.null,
        };
      } else {
        XCTAssertEqualObjects([httpRequest valueForHTTPHeaderField:@"Authorization"],
                              [@"Bearer " stringByAppendingString:credential]);
        XCTAssertNil([httpRequest valueForHTTPHeaderField:@"x-api-key"]);
        if ([harnessId isEqual:@"codex"]) {
          XCTAssertEqualObjects(body[@"store"], @NO);
          XCTAssertNotNil(body[@"input"]);
          XCTAssertNil(body[@"messages"]);
          XCTAssertNotNil(readTool[@"parameters"]);
          payload = @{ @"id" : @"fixture-response", @"object" : @"response",
            @"status" : @"completed", @"model" : model,
            @"output" : @[ @{ @"type" : @"function_call", @"id" : @"fc_fixture",
              @"call_id" : @"call_fixture", @"name" : @"read_file",
              @"arguments" : @"{\"path\":\"README.md\"}" } ] };
        } else {
          XCTAssertEqualObjects(body[@"messages"][0][@"content"], @"hello");
          XCTAssertNotNil(readTool[@"function"][@"parameters"]);
          payload = @{ @"id" : @"fixture-response", @"model" : model,
            @"choices" : @[ @{ @"finish_reason" : @"tool_calls", @"message" : @{
              @"role" : @"assistant", @"content" : @"", @"reasoning_content" : @"",
              @"tool_calls" : @[ @{ @"id" : @"call_fixture", @"type" : @"function",
                @"function" : @{ @"name" : @"read_file",
                  @"arguments" : @"{\"path\":\"README.md\"}" } } ] } } ] };
        }
      }
      NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
      NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
          initWithURL:httpRequest.URL statusCode:200 HTTPVersion:@"HTTP/1.1"
          headerFields:@{ @"Content-Type" : @"application/json" }];
      [protocol.client URLProtocol:protocol didReceiveResponse:response
               cacheStoragePolicy:NSURLCacheStorageNotAllowed];
      [protocol.client URLProtocol:protocol didLoadData:data];
      [protocol.client URLProtocolDidFinishLoading:protocol];
    }];
    NSError *error = nil;
    NSDictionary *result = [service completeAgentRoundV2WithRequest:request error:&error];
    XCTAssertNil(error, @"%@", harnessId);
    XCTAssertEqualObjects(result[@"status"], @"completed", @"%@", harnessId);
    XCTAssertEqualObjects(result[@"outcome"][@"kind"], @"tool_batch");
    XCTAssertEqualObjects(result[@"outcome"][@"calls"][0][@"name"], @"read_file");
    NSDictionary *receipt = result[@"outcome"][@"completion_receipt"];
    XCTAssertEqualObjects(receipt[@"harness_id"], harnessId);
    XCTAssertEqualObjects(receipt[@"model"], model);
    XCTAssertEqualObjects(receipt[@"requested_model"], model);
    XCTAssertTrue(credentialCalls > 0);
    XCTAssertEqual([DSHProviderURLProtocol requestCount], (NSUInteger)1);
    XCTAssertEqual(fixture.rounds.completeCount, (NSUInteger)1);
    [session invalidateAndCancel];
    [DSHProviderURLProtocol reset];
  }
}

- (void)testInvalidOrUnwiredHarnessNeverReadsCredentialsOrDispatches {
  NSArray *cases = @[
    @{ @"harness" : @"future-provider", @"model" : @"deepseek-v4-flash" },
    @{ @"harness" : NSNull.null, @"model" : @"deepseek-v4-flash" },
    @{ @"harness" : @"dsh", @"model" : @"GLM-5.3" },
    @{ @"harness" : @"glm", @"model" : @"deepseek-v4-flash" },
    @{ @"harness" : @"glm", @"model" : @"GLM-5.3" },
    @{ @"harness" : @"glm", @"model" : @"GLM-5.3", @"wrong_transport" : @YES },
    @{ @"model" : @"GLM-5.3" },
  ];
  for (NSDictionary *entry in cases) {
    DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
    NSMutableDictionary *request = [fixture.request mutableCopy];
    request[@"model"] = entry[@"model"];
    if (entry[@"harness"] != nil) request[@"harness_id"] = entry[@"harness"];
    NSMutableDictionary *authority = [fixture.prepared.authority mutableCopy];
    authority[@"model"] = entry[@"model"];
    fixture.prepared.authority = authority;
    __block NSUInteger credentialCalls = 0;
    __block NSUInteger historyCalls = 0;
    DSHAgentProviderRoundService *service = [[DSHAgentProviderRoundService alloc]
        initWithWAL:fixture.wal preparedStore:fixture.prepared
        transcripts:fixture.transcripts rounds:fixture.rounds
        transport:fixture.transport claudeTransport:nil codexTransport:nil
        glmTransport:[entry[@"wrong_transport"] boolValue] ? fixture.transport : nil
        credentialProvider:^NSString *(NSString *harness, NSUInteger *generation) {
          credentialCalls += 1;
          return @"synthetic-must-not-be-read";
        }
        visibleHistoryProvider:^NSArray *(NSDictionary *nativeAuthority, NSError **error) {
          historyCalls += 1;
          return @[];
        }
        contextReceiptProvider:nil];
    XCTAssertNil([service transportForRequest:request]);
    NSError *error = nil;
    XCTAssertNil([service completeAgentRoundV2WithRequest:request error:&error]);
    XCTAssertNotNil(error);
    XCTAssertEqual(credentialCalls, (NSUInteger)0);
    XCTAssertEqual(historyCalls, (NSUInteger)0);
    XCTAssertEqual(fixture.transport.startCount, (NSUInteger)0);
    XCTAssertEqual(fixture.rounds.createCount, (NSUInteger)0);
    XCTAssertEqual(fixture.rounds.dispatchCount, (NSUInteger)0);
  }
}

- (void)testURLProtocolBodyAndDigestEvidenceArriveAfterBoundTransportContext {
  [DSHProviderURLProtocol reset];
  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.protocolClasses = @[ DSHProviderURLProtocol.class ];
  DSHProviderURLSessionDelegate *delegate =
      [[DSHProviderURLSessionDelegate alloc] init];
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration
                                                          delegate:delegate
                                                     delegateQueue:nil];
  DSHCompletionProviderTransport *transport =
      [[DshProviderTransport alloc]
          initWithSession:session
          uuidGenerator:^NSString *{
            return @"66666666-6666-4666-8666-666666666666";
          }
          monotonicClock:^NSTimeInterval {
            return 3.0;
          }];
  delegate.transport = transport;
  NSArray *messages = @[ @{ @"role" : @"user", @"content" : @"hello" } ];
  NSDictionary *body = @{
    @"model" : @"deepseek-v4-flash",
    @"stream" : @NO,
    @"thinking" : @{ @"type" : @"disabled" },
    @"max_tokens" : @1024,
    @"messages" : messages,
  };
  NSData *bodyData = [NSJSONSerialization dataWithJSONObject:body
                                                       options:NSJSONWritingSortedKeys
                                                         error:nil];
  NSString *visibleDigest = DSHWorkspaceSHA256Hex(
      [NSJSONSerialization dataWithJSONObject:messages
                                       options:NSJSONWritingSortedKeys
                                         error:nil]);
  XCTestExpectation *finished = [self expectationWithDescription:@"provider URLProtocol"];
  [DSHProviderURLProtocol setHandler:^(NSURLProtocol *protocol,
                                        NSURLRequest *request) {
    XCTAssertEqualObjects(request.HTTPMethod, @"POST");
    XCTAssertEqualObjects([request valueForHTTPHeaderField:@"Authorization"],
                          @"Bearer credential");
    NSData *capturedBody = DSHProviderCapturedRequestBody(request);
    XCTAssertEqualObjects(capturedBody, bodyData);
    XCTAssertTrue([[[NSString alloc] initWithData:capturedBody
                                            encoding:NSUTF8StringEncoding]
                   hasPrefix:@"{\"max_tokens\""]);
    NSDictionary *payload = @{
      @"id" : @"response-1",
      @"model" : @"deepseek-v4-flash",
      @"choices" : @[@{
        @"finish_reason" : @"stop",
        @"message" : @{
          @"role" : @"assistant",
          @"content" : @"done",
          @"reasoning_content" : @"",
        },
      }],
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload
                                                     options:0
                                                       error:nil];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL statusCode:200 HTTPVersion:@"HTTP/1.1"
        headerFields:@{ @"Content-Type" : @"application/json" }];
    [protocol.client URLProtocol:protocol didReceiveResponse:response
             cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [protocol.client URLProtocol:protocol didLoadData:data];
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];
  NSURLSessionDataTask *task = [transport
      startRequestWithSchemaVersion:2
                              roundId:DSHProviderSmokeRound
                            generation:1
                  credentialGeneration:7
                   providerRequestId:@"66666666-6666-4666-8666-666666666666"
                         credential:@"credential"
                     requestedModel:@"deepseek-v4-flash"
                      thinkingMode:@"off"
       credentialGenerationIsCurrent:^BOOL(NSUInteger generation) {
         return generation == 7;
       }
                            startedAt:2.0
                           bodyData:bodyData
                       visibleHistory:messages
                           modelInput:messages
                             bindTask:^BOOL(NSURLSessionDataTask *candidate) {
                               return [transport handlesTask:candidate];
                             }
                           claimRound:^BOOL(__unused BOOL *redirected) {
                             return YES;
                           }
                        markRedirected:nil
                     redirectDecision:nil
                          completion:^(NSDictionary *result, NSString *errorCode) {
                            XCTAssertNil(errorCode);
                            XCTAssertEqualObjects(result[@"visible_history_sha256"], visibleDigest);
                            XCTAssertEqualObjects(result[@"model_input_sha256"], visibleDigest);
                            XCTAssertEqualObjects(result[@"request_body_sha256"],
                                                  DSHWorkspaceSHA256Hex(bodyData));
                            [finished fulfill];
                          }];
  XCTAssertNotNil(task);
  [self waitForExpectations:@[ finished ] timeout:3.0];
  XCTAssertEqual([DSHProviderURLProtocol requestCount], (NSUInteger)1);
  [session invalidateAndCancel];
  [DSHProviderURLProtocol reset];
}

- (void)testProviderServiceAndJournalExposeOnlyNativeRoundCompositionSelectors {
  XCTAssertTrue([DSHAgentProviderRoundService
      instancesRespondToSelector:@selector(completeAgentRoundV2WithRequest:error:)]);
  XCTAssertTrue([DSHAgentProviderRoundService
      instancesRespondToSelector:@selector(retryFailedAgentRoundV2WithRequest:error:)]);
  XCTAssertTrue([DSHAgentProviderRoundService
      instancesRespondToSelector:@selector(queryAgentRoundWithRequest:error:)]);
  XCTAssertTrue([DSHAgentProviderRoundService
      instancesRespondToSelector:@selector(recoverAgentRoundWithRequest:error:)]);
  XCTAssertTrue([DSHAgentProviderRoundService
      instancesRespondToSelector:@selector(cancelAgentRoundWithRequest:error:)]);
  XCTAssertTrue([DSHAgentRoundJournal
      instancesRespondToSelector:@selector(createAgentRoundV3WithInsertCAS:
                                          exactRoundStart:error:)]);
  XCTAssertTrue([DSHAgentRoundJournal
      instancesRespondToSelector:@selector(markAgentRoundV3DispatchedWithCAS:
                                          error:)]);
  XCTAssertTrue([DSHAgentRoundJournal
      instancesRespondToSelector:@selector(completeAgentRoundV3WithLocator:
                                          expectedCAS:messages:
                                          completionReceipt:terminalKind:calls:root:error:)]);
  XCTAssertTrue([DSHAgentRoundJournal
      instancesRespondToSelector:@selector(cancelAgentRoundV3WithCAS:error:)]);
  XCTAssertTrue([DSHAgentRoundJournal
      instancesRespondToSelector:@selector(queryAgentRoundV3WithLocator:error:)]);
  XCTAssertTrue([DSHAgentRoundJournal
      instancesRespondToSelector:@selector(reconcileAgentRoundV3OwnerLossWithLocator:
                                          expectedCAS:error:)]);
}

- (void)testNativeRoundServiceResultVocabularyDoesNotNameRawPayloadFields {
  NSArray<NSString *> *forbidden = @[
    @"arguments_json", @"raw_arguments", @"raw_result", @"tool_feedback",
    @"messages", @"native_envelope", @"precondition", @"settled_facts",
    @"patch", @"owner", @"path", @"content",
  ];
  NSArray<NSString *> *safeResultKeys = @[
    @"schema_version", @"status", @"operation_id", @"task_id",
    @"attempt_id", @"round_id", @"round_index", @"launch_attempt",
    @"result_round_revision", @"transcript", @"outcome",
  ];
  for (NSString *key in safeResultKeys) {
    XCTAssertFalse([forbidden containsObject:key]);
  }
}

- (void)testRuntimeRoundWritesBeforeTransportAndExactReplaySkipsDependencies {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  NSError *error = nil;
  NSDictionary *first = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                     error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(first[@"status"], @"completed");
  XCTAssertEqual(fixture.rounds.createCount, (NSUInteger)1);
  XCTAssertEqual(fixture.rounds.dispatchCount, (NSUInteger)1);
  XCTAssertEqual(fixture.rounds.completeCount, (NSUInteger)1);
  XCTAssertEqual(fixture.transport.startCount, (NSUInteger)1);
  XCTAssertTrue(fixture.historyCalls > 0);
  NSDictionary *body = [NSJSONSerialization JSONObjectWithData:fixture.transport.lastBodyData
                                                        options:0
                                                          error:&error];
  XCTAssertNil(error);
  XCTAssertTrue([fixture.transport.lastBodyData length] > 0);
  XCTAssertTrue([[[NSString alloc] initWithData:fixture.transport.lastBodyData
                                        encoding:NSUTF8StringEncoding]
      hasPrefix:@"{\"max_tokens\""]);
  NSDictionary *bodyTool = body[@"tools"][0];
  XCTAssertEqualObjects(bodyTool[@"type"], @"function");
  XCTAssertTrue([bodyTool[@"function"] isKindOfClass:NSDictionary.class]);
  XCTAssertEqualObjects(bodyTool[@"function"][@"name"], @"list_dir");
  XCTAssertEqualObjects(fixture.transport.lastModelInput,
                        (@[ @{ @"role" : @"user", @"content" : @"hello" } ]));
  XCTAssertEqualObjects(first[@"outcome"][@"completion_receipt"][@"task_id"],
                        DSHProviderSmokeTask);

  fixture.historyAvailable = NO;
  fixture.credentialAvailable = NO;
  NSDictionary *replay = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                      error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(replay[@"status"], @"completed");
  XCTAssertEqual(fixture.transport.startCount, (NSUInteger)1);
  XCTAssertEqual(fixture.rounds.completeCount, (NSUInteger)1);
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testCancelSignalsPendingCallbackAndStaleSelectorConflicts {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  fixture.transport.holdResponse = YES;
  dispatch_semaphore_t completed = dispatch_semaphore_create(0);
  __block NSDictionary *roundResult = nil;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
    NSError *error = nil;
    roundResult = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                              error:&error];
    XCTAssertNil(error);
    dispatch_semaphore_signal(completed);
  });
  NSDate *waitUntil = [NSDate dateWithTimeIntervalSinceNow:2.0];
  while (fixture.transport.startCount == 0 &&
         [waitUntil timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runUntilDate:
        [NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  XCTAssertEqual(fixture.transport.startCount, (NSUInteger)1);
  NSDictionary *cancelRequest = DSHProviderSmokeQueryRequest(
      fixture.root, fixture.transcript, 2, YES);
  NSTimeInterval started = CFAbsoluteTimeGetCurrent();
  NSError *cancelError = nil;
  NSDictionary *cancel = [fixture.service cancelAgentRoundWithRequest:cancelRequest
                                                                 error:&cancelError];
  XCTAssertNil(cancelError);
  XCTAssertLessThan(CFAbsoluteTimeGetCurrent() - started, 2.0);
  XCTAssertEqualObjects(cancel[@"status"], @"cancel_requested");
  XCTAssertEqual(dispatch_semaphore_wait(completed,
                                         dispatch_time(DISPATCH_TIME_NOW,
                                                       2 * NSEC_PER_SEC)), 0);
  XCTAssertEqualObjects(roundResult[@"status"], @"ambiguous");
  void (^lateCompletion)(NSDictionary *, NSString *) = fixture.transport.pendingCompletion;
  if (lateCompletion != nil) {
    lateCompletion(@{ @"late" : @YES }, @"E_COMPLETION_TRANSPORT");
  }
  XCTAssertEqualObjects(roundResult[@"status"], @"ambiguous");

  NSDictionary *stale = DSHProviderSmokeQueryRequest(
      fixture.root, fixture.transcript, 1, NO);
  NSDictionary *staleResult = [fixture.service queryAgentRoundWithRequest:stale
                                                                      error:&cancelError];
  XCTAssertNil(cancelError);
  XCTAssertEqualObjects(staleResult[@"status"], @"conflict");
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testProviderErrorMatrixKeepsStableClosedCodes {
  XCTAssertEqualObjects(DSHProviderFailureCode(@"E_AGENT_CANCELLED", NO),
                        @"E_AGENT_CANCELLED");
  XCTAssertEqualObjects(DSHProviderFailureCode(@"E_COMPLETION_REDIRECT", NO),
                        @"E_AGENT_CONFLICT");
  XCTAssertEqualObjects(DSHProviderFailureCode(@"E_COMPLETION_HTTP_STATUS", NO),
                        @"E_AGENT_TOOL_FAILED");
  XCTAssertEqualObjects(DSHProviderFailureCode(@"E_COMPLETION_RESPONSE_JSON", NO),
                        @"E_AGENT_TRANSCRIPT");
  XCTAssertEqualObjects(DSHProviderFailureCode(@"E_COMPLETION_TRANSPORT", NO),
                        @"E_AGENT_ROUND_AMBIGUOUS");
  XCTAssertEqualObjects(DSHProviderFailureCode(nil, YES), @"E_AGENT_TRANSCRIPT");
}

- (void)testCompatWriteDefaultsCreateOnlyRevisionAndCompletesToolBatch {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  NSString *encoded = @"{\"name\":\"write_file\",\"arguments\":{\"path\":\"RISH_HARNESS_PROOF_20260901.md\",\"content\":\"Rish real-device harness proof.\"}}";
  NSError *error = nil;
  NSDictionary *parsed = DSHParseCompletionResponseSchema2(@{
    @"id" : @"response-compat",
    @"model" : @"deepseek-v4-flash",
    @"choices" : @[@{
      @"finish_reason" : @"stop",
      @"message" : @{ @"role" : @"assistant", @"content" : encoded },
    }],
  }, @"deepseek-v4-flash", @"off", &error);
  XCTAssertNotNil(parsed, @"%@", error);
  XCTAssertNil(error);
  XCTAssertEqualObjects(parsed[@"finish_reason"], @"tool_calls");
  NSDictionary *call = parsed[@"tool_calls"][0];
  XCTAssertTrue(DSHProviderOpaqueId(call[@"id"]));
  XCTAssertNotNil([fixture.prepared.toolRegistry
      descriptorForToolName:call[@"name"] root:fixture.root error:&error]);
  XCTAssertNil(error);
  XCTAssertEqualObjects(call[@"arguments"],
      @"{\"content\":\"Rish real-device harness proof.\",\"expected_revision\":null,\"path\":\"RISH_HARNESS_PROOF_20260901.md\"}");
  XCTAssertNotNil(DSHAgentArgumentsSHA256(call[@"name"], call[@"arguments"],
                                          &error));
  XCTAssertNil(error);

  NSMutableDictionary *provider = [parsed mutableCopy];
  provider[@"provider_request_id"] =
      @"66666666-6666-4666-8666-666666666666";
  provider[@"requested_model"] = @"deepseek-v4-flash";
  provider[@"thinking_mode"] = @"off";
  provider[@"latency_ms"] = @1;
  provider[@"visible_history_sha256"] = DSHProviderSmokeDigest;
  provider[@"model_input_sha256"] = DSHProviderSmokeDigest;
  provider[@"request_body_sha256"] = DSHProviderSmokeDigest;
  fixture.transport.result = [provider copy];
  error = nil;
  NSDictionary *result = [fixture.service
      completeAgentRoundV2WithRequest:fixture.request error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"completed");
  XCTAssertEqualObjects(result[@"outcome"][@"kind"], @"tool_batch");
  XCTAssertEqual(fixture.rounds.completeCount, (NSUInteger)1);
  XCTAssertEqualObjects(fixture.rounds.completedMessages[0][@"tool_calls"][0]
                             [@"arguments_json"],
                        call[@"arguments"]);
  NSDictionary *body = [NSJSONSerialization
      JSONObjectWithData:fixture.transport.lastBodyData options:0 error:&error];
  XCTAssertNil(error);
  NSDictionary *writeFunction = nil;
  for (NSDictionary *tool in body[@"tools"]) {
    if ([tool[@"function"][@"name"] isEqualToString:@"write_file"]) {
      writeFunction = tool[@"function"];
      break;
    }
  }
  XCTAssertNotNil(writeFunction);
  XCTAssertEqualObjects(writeFunction[@"parameters"][@"properties"]
                             [@"expected_revision"][@"type"],
                        (@[ @"string", @"null" ]));
  XCTAssertTrue([writeFunction[@"parameters"][@"required"]
      containsObject:@"expected_revision"]);
  NSDictionary *state = [fixture.wal snapshotWithError:nil];
  XCTAssertEqualObjects(state[@"operations"][0][@"state"], @"committed");
}

- (void)testProviderReceiptCorrelationMustMatchTheReservedRequest {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  NSMutableDictionary *result = [fixture.transport.result mutableCopy];
  result[@"provider_request_id"] = @"77777777-7777-4777-8777-777777777777";
  result[@"requested_model"] = @"deepseek-v4-pro";
  result[@"model"] = @"deepseek-v4-pro";
  result[@"thinking_mode"] = @"max";
  fixture.transport.result = [result copy];
  NSError *error = nil;
  NSDictionary *output = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                       error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(output[@"status"], @"ambiguous");
  XCTAssertEqualObjects(output[@"failure_code"], @"E_AGENT_TRANSCRIPT");
  XCTAssertEqual(fixture.rounds.completeCount, (NSUInteger)0);
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testCredentialGenerationChangeSettlesWithoutWaitingForTimeout {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  fixture.transport.rejectCredentialGeneration = YES;
  NSTimeInterval started = CFAbsoluteTimeGetCurrent();
  NSError *error = nil;
  NSDictionary *result = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                      error:&error];
  XCTAssertNil(error);
  XCTAssertLessThan(CFAbsoluteTimeGetCurrent() - started, 2.0);
  XCTAssertEqualObjects(result[@"status"], @"ambiguous");
  XCTAssertEqual(fixture.transport.startCount, (NSUInteger)1);
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testCredentialUnavailableAfterRoundStartCommitsSafeAmbiguousOperation {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  fixture.credentialAvailable = NO;
  NSError *error = nil;
  NSDictionary *result = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                     error:&error];
  XCTAssertNil(result);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorUnavailable);
  error = nil;
  NSDictionary *state = [fixture.wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(state[@"operations"][0][@"state"], @"ambiguous");
  fixture.credentialAvailable = YES;
  NSDictionary *replay = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                      error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(replay[@"status"], @"ambiguous");
  XCTAssertEqual(fixture.transport.startCount, (NSUInteger)0);
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testOwnerLossPreservesRetryableAndAmbiguousOutcomes {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  NSDictionary *locator = @{
    @"schema_version" : @1,
    @"task_id" : DSHProviderSmokeTask,
    @"attempt_id" : DSHProviderSmokeAttempt,
    @"round_id" : DSHProviderSmokeRound,
    @"round_index" : @0,
  };
  NSDictionary *owner = @{
    @"schema_version" : @1,
    @"task_id" : DSHProviderSmokeTask,
    @"launch_id" : @"99999999-9999-4999-8999-999999999999",
    @"native_task_id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"owner_generation" : @1,
    @"heartbeat_at" : @"2023-11-14T22:13:20.000Z",
  };
  fixture.rounds.row = @{
    @"schema_version" : @3,
    @"locator" : locator,
    @"row_revision" : @1,
    @"root_fingerprint_sha256" : DSHProviderSmokeRootDigest,
    @"binding_revision" : @7,
    @"request_sha256" : DSHProviderSmokeDigest,
    @"transcript_before" : fixture.transcript,
    @"launch_attempt" : @1,
    @"state" : @"in_flight",
    @"owner" : owner,
    @"failure_code" : NSNull.null,
    @"completion_receipt" : NSNull.null,
    @"transcript_after" : NSNull.null,
    @"calls" : @[],
    @"batch_class" : NSNull.null,
    @"executable_call_count" : @0,
    @"denied_call_count" : @0,
    @"terminal_kind" : NSNull.null,
    @"created_at" : @"2023-11-14T22:13:20.000Z",
    @"updated_at" : @"2023-11-14T22:13:20.000Z",
  };
  fixture.rounds.reconcileToFailedRetryable = YES;
  NSError *error = nil;
  NSDictionary *request = DSHProviderSmokeQueryRequest(
      fixture.root, fixture.transcript, 1, NO);
  NSDictionary *retryable = [fixture.service recoverAgentRoundWithRequest:request
                                                                        error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(retryable[@"status"], @"failed_retryable");
  XCTAssertEqual(fixture.rounds.reconcileCount, (NSUInteger)1);
  XCTAssertEqualObjects(retryable[@"failure_code"], @"E_AGENT_PERSISTENCE");
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testRecoverCompletedRoundReturnsExactRedactedProjection {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  NSError *error = nil;
  NSDictionary *completed = [fixture.service
      completeAgentRoundV2WithRequest:fixture.request error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(completed[@"status"], @"completed");
  fixture.transcripts.messages = @[
    @{
      @"schema_version" : @1,
      @"role" : @"assistant",
      @"round_index" : @0,
      @"content" : @"done",
      @"reasoning_content" : @"",
      @"tool_calls" : @[],
    },
  ];
  NSDictionary *selector = DSHProviderSmokeQueryRequest(
      fixture.root, fixture.transcript, 3, NO);
  NSDictionary *recovered = [fixture.service recoverAgentRoundWithRequest:selector
                                                                       error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(recovered[@"status"], @"completed");
  NSDictionary *round = recovered[@"completed_round"];
  XCTAssertEqualObjects(round[@"text"], @"done");
  XCTAssertEqualObjects(round[@"schema_version"], @2);
  XCTAssertEqual([round[@"assistant_text_sha256"] length], (NSUInteger)64);
  XCTAssertEqual([round[@"reasoning_text_sha256"] length], (NSUInteger)64);
  XCTAssertEqualObjects(round[@"transcript"], fixture.transcript);
  XCTAssertNil(round[@"content"]);
  XCTAssertNil(round[@"arguments_json"]);
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testSchema3ContextIsOrderedBeforeUserAndReceiptIsRedacted {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  NSDictionary *projectRoot = @{
    @"schema_version" : @1,
    @"kind" : @"project",
    @"workspace_id" : @"77777777-7777-4777-8777-777777777777",
    @"workspace_binding_revision" : @7,
    @"project_id" : @"99999999-9999-4999-8999-999999999999",
    @"root_fingerprint_sha256" : DSHProviderSmokeRootDigest,
    @"capabilities" : @[ @"file_read", @"file_write", @"git_status",
                          @"git_commit", @"git_push" ],
  };
  DSHAgentToolRegistry *registry = [[DSHAgentToolRegistry alloc] init];
  NSError *registryError = nil;
  NSDictionary *projectRegistry = [registry registryForRoot:projectRoot
                                                       error:&registryError];
  XCTAssertNil(registryError);
  fixture.root = projectRoot;
  fixture.prepared.root = projectRoot;
  NSMutableDictionary *authority = [fixture.prepared.authority mutableCopy];
  authority[@"root"] = projectRoot;
  authority[@"registry"] = projectRegistry;
  NSString *contextDigest = DSHAgentHJ(@"project-context", @{
    @"schema_version" : @1,
    @"project_id" : projectRoot[@"project_id"],
    @"context_bytes" : @16,
  }, nil);
  authority[@"transport_schema_version"] = @3;
  authority[@"project_context_sha256"] = contextDigest;
  fixture.prepared.authority = authority;
  NSMutableDictionary *request = [fixture.request mutableCopy];
  request[@"operation_id"] = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  request[@"transport_schema_version"] = @3;
  request[@"project_context_sha256"] = contextDigest;
  request[@"root"] = projectRoot;
  fixture.request = [request copy];
  NSDictionary *contextReceipt = @{
    @"schema_version" : @1,
    @"snapshot_id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"snapshot_sha256" : DSHProviderSmokeSessionDigest,
    @"source_fingerprint" : DSHProviderSmokeRootDigest,
    @"context_bytes" : @16,
    @"verified_at" : @"2023-11-14T22:13:20.000Z",
  };
  fixture.service = [[DSHAgentProviderRoundService alloc]
      initWithWAL:fixture.wal
      preparedStore:fixture.prepared
      transcripts:fixture.transcripts
      rounds:fixture.rounds
      transport:fixture.transport
      credentialProvider:^NSString *(NSString *harnessId, NSUInteger *generation) {
        if (generation != nullptr) *generation = 7;
        return @"credential";
      }
      visibleHistoryProvider:^NSArray *(NSDictionary *nativeAuthority, NSError **error) {
        (void)nativeAuthority;
        if (error != nullptr) *error = nil;
        return @[ @{ @"role" : @"user", @"content" : @"hello" } ];
      }
      contextReceiptProvider:^NSDictionary *(NSDictionary *nativeAuthority, NSError **error) {
        (void)nativeAuthority;
        if (error != nullptr) *error = nil;
        return @{
          @"project_context_sha256" : contextDigest,
          @"receipt" : contextReceipt,
          @"messages" : @[
            @{ @"role" : @"system", @"content" : @"verified context",
               @"attachments" : @[] },
          ],
        };
      }];
  NSError *error = nil;
  NSDictionary *result = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                      error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"completed");
  NSDictionary *body = [NSJSONSerialization JSONObjectWithData:fixture.transport.lastBodyData
                                                        options:0
                                                          error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(body[@"messages"][0][@"role"], @"system");
  XCTAssertEqualObjects(body[@"messages"][1][@"role"], @"user");
  XCTAssertEqualObjects(result[@"outcome"][@"completion_receipt"][@"project_context_receipt"],
                        contextReceipt);
  XCTAssertEqualObjects(result[@"outcome"][@"completion_receipt"][@"task_id"],
                        DSHProviderSmokeTask);
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testSchema3CannotCrossAnExplicitWithoutContextAuthority {
  DSHProviderSmokeFixture *fixture = [[DSHProviderSmokeFixture alloc] init];
  NSDictionary *contextReceipt = @{
    @"schema_version" : @1,
    @"snapshot_id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"snapshot_sha256" : DSHProviderSmokeSessionDigest,
    @"source_fingerprint" : DSHProviderSmokeRootDigest,
    @"context_bytes" : @7,
    @"verified_at" : @"2023-11-14T22:13:20.000Z",
  };
  NSMutableDictionary *request = [fixture.request mutableCopy];
  request[@"transport_schema_version"] = @3;
  request[@"project_context_sha256"] = DSHProviderSmokeDigest;
  fixture.service = [[DSHAgentProviderRoundService alloc]
      initWithWAL:fixture.wal
      preparedStore:fixture.prepared
      transcripts:fixture.transcripts
      rounds:fixture.rounds
      transport:fixture.transport
      credentialProvider:^NSString *(NSString *harnessId, NSUInteger *generation) {
        if (generation != nullptr) *generation = 7;
        return @"credential";
      }
      visibleHistoryProvider:^NSArray *(NSDictionary *authority, NSError **error) {
        if (error != nullptr) *error = nil;
        return @[ @{ @"role" : @"user", @"content" : @"hello" } ];
      }
      contextReceiptProvider:^NSDictionary *(NSDictionary *authority, NSError **error) {
        if (error != nullptr) *error = nil;
        return @{
          @"project_context_sha256" : DSHProviderSmokeDigest,
          @"receipt" : contextReceipt,
          @"messages" : @[
            @{ @"role" : @"system", @"content" : @"context",
               @"attachments" : @[] },
          ],
        };
      }];
  NSError *error = nil;
  NSDictionary *result = [fixture.service completeAgentRoundV2WithRequest:[request copy]
                                                                      error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"conflict");
  XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_CONFLICT");
  XCTAssertEqual(fixture.transport.startCount, (NSUInteger)0);
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testMissingContextBundlePreservesStorageFailure {
  NSError *original = [NSError errorWithDomain:@"dev.zseven.rish.project-context-service" code:6 userInfo:nil];
  NSError *error = original;
  NSDictionary *receipt = nil;
  NSArray *messages = nil;
  XCTAssertFalse(DSHProviderContextBundle(nil, DSHProviderSmokeDigest, &receipt, &messages, &error));
  XCTAssertEqual(error, original);
  XCTAssertNil(receipt);
  XCTAssertNil(messages);
}

- (void)testSchema3ContextBundleDigestMustMatchFrozenRequest {
  NSDictionary *receipt = @{
    @"schema_version" : @1,
    @"snapshot_id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"snapshot_sha256" : DSHProviderSmokeSessionDigest,
    @"source_fingerprint" : DSHProviderSmokeRootDigest,
    @"context_bytes" : @7,
    @"verified_at" : @"2023-11-14T22:13:20.000Z",
  };
  NSDictionary *bundle = @{
    @"project_context_sha256" : DSHProviderSmokeDigest,
    @"receipt" : receipt,
    @"messages" : @[
      @{ @"role" : @"system", @"content" : @"context",
         @"attachments" : @[] },
    ],
  };
  NSDictionary *ignoredReceipt = nil;
  NSArray *ignoredMessages = nil;
  NSError *error = nil;
  XCTAssertFalse(DSHProviderContextBundle(
      bundle, @"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      &ignoredReceipt, &ignoredMessages, &error));
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorConflict);
  XCTAssertNil(ignoredReceipt);
  XCTAssertNil(ignoredMessages);
}

- (void)testStartedOperationRecoversCompletedRoundWithoutAnotherHTTPRequest {
  DSHProviderSmokeFixture *fixture =
      [[DSHProviderSmokeFixture alloc] initWithFaultingCommit:YES];
  fixture.rounds.failNextWALTransactionAfterComplete = YES;
  NSError *error = nil;
  NSDictionary *first = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                     error:&error];
  XCTAssertNil(first);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorPersistence);
  error = nil;
  NSDictionary *state = [fixture.wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(state[@"operations"][0][@"state"], @"started");
  XCTAssertEqualObjects(fixture.rounds.row[@"state"], @"completed");

  fixture.transcripts.messages = @[
    @{
      @"schema_version" : @1,
      @"role" : @"assistant",
      @"round_index" : @0,
      @"content" : @"done",
      @"reasoning_content" : @"",
      @"tool_calls" : @[],
    },
  ];
  fixture.historyAvailable = NO;
  fixture.credentialAvailable = NO;
  NSDictionary *recovered = [fixture.service completeAgentRoundV2WithRequest:fixture.request
                                                                         error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(recovered[@"status"], @"completed");
  XCTAssertEqualObjects(recovered[@"outcome"][ @"text"], @"done");
  XCTAssertEqual(fixture.transport.startCount, (NSUInteger)1);
  state = [fixture.wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(state[@"operations"][0][@"state"], @"committed");
  [NSFileManager.defaultManager removeItemAtURL:fixture.walRoot error:nil];
}

- (void)testRealWALJournalTransportAndTranscriptComposeOneRoundEndToEnd {
  [DSHProviderURLProtocol reset];
  NSURL *walRoot = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
  DSHAgentNativeWAL *wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:walRoot
      clock:^NSDate *{
        return [NSDate dateWithTimeIntervalSince1970:1700000000];
      }
      identifierGenerator:^NSString *{
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      faultHook:nil];
  NSError *error = nil;
  NSDictionary *root = DSHProviderSmokeRoot();
  DSHAgentTranscriptStore *transcripts = [[DSHAgentTranscriptStore alloc]
      initWithWAL:wal];
  NSDictionary *transcript = [transcripts
      createAgentTranscriptWithRequest:@{
        @"schema_version" : @1,
        @"attempt_id" : DSHProviderSmokeAttempt,
        @"root" : root,
      }
      error:&error];
  XCTAssertNotNil(transcript);
  XCTAssertNil(error);
  DSHAgentToolRegistry *registry = [[DSHAgentToolRegistry alloc] init];
  NSDictionary *registryProjection = [registry registryForRoot:root error:&error];
  XCTAssertNotNil(registryProjection);
  XCTAssertNil(error);
  NSDictionary *authority = DSHProviderSmokeAuthority(root, transcript,
                                                      registryProjection);
  DSHProviderSmokePreparedStore *prepared =
      [[DSHProviderSmokePreparedStore alloc] initWithAuthority:authority
                                                           root:root
                                                            wal:wal];
  DSHAgentRoundJournal *rounds = [[DSHAgentRoundJournal alloc] initWithWAL:wal];
  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.protocolClasses = @[ DSHProviderURLProtocol.class ];
  DSHProviderURLSessionDelegate *delegate =
      [[DSHProviderURLSessionDelegate alloc] init];
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration
                                                          delegate:delegate
                                                     delegateQueue:nil];
  DSHCompletionProviderTransport *transport =
      [[DshProviderTransport alloc]
          initWithSession:session
          uuidGenerator:^NSString *{
            return @"66666666-6666-4666-8666-666666666666";
          }
          monotonicClock:^NSTimeInterval {
            return 3.0;
          }];
  delegate.transport = transport;
  [DSHProviderURLProtocol setHandler:^(NSURLProtocol *protocol,
                                        NSURLRequest *request) {
    XCTAssertEqualObjects(request.HTTPMethod, @"POST");
    XCTAssertEqualObjects([request valueForHTTPHeaderField:@"Authorization"],
                          @"Bearer credential");
    NSDictionary *requestBody = [NSJSONSerialization
        JSONObjectWithData:DSHProviderCapturedRequestBody(request)
                   options:0
                     error:nil];
    XCTAssertEqualObjects(requestBody[@"model"], @"deepseek-v4-flash");
    XCTAssertEqualObjects(requestBody[@"messages"][0][@"role"], @"user");
    XCTAssertTrue([requestBody[@"tools"] isKindOfClass:NSArray.class]);
    NSDictionary *payload = @{
      @"id" : @"response-1",
      @"model" : @"deepseek-v4-flash",
      @"choices" : @[@{
        @"finish_reason" : @"stop",
        @"message" : @{
          @"role" : @"assistant",
          @"content" : @"done",
          @"reasoning_content" : @"",
        },
      }],
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload
                                                     options:0
                                                       error:nil];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL statusCode:200 HTTPVersion:@"HTTP/1.1"
        headerFields:@{ @"Content-Type" : @"application/json" }];
    [protocol.client URLProtocol:protocol didReceiveResponse:response
             cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [protocol.client URLProtocol:protocol didLoadData:data];
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];
  DSHAgentProviderRoundService *service =
      [[DSHAgentProviderRoundService alloc]
          initWithWAL:wal
          preparedStore:prepared
          transcripts:transcripts
          rounds:rounds
          transport:transport
          credentialProvider:^NSString *(NSString *harnessId, NSUInteger *generation) {
            if (generation != nullptr) *generation = 7;
            return @"credential";
          }
          visibleHistoryProvider:^NSArray *(NSDictionary *nativeAuthority,
                                             NSError **historyError) {
            if (historyError != nullptr) *historyError = nil;
            return @[ @{ @"role" : @"user", @"content" : @"hello" } ];
          }];
  NSDictionary *request = DSHProviderSmokeRequest(
      root, transcript, registryProjection[@"toolset_sha256"],
      DSHProviderSmokeOperation);
  NSDictionary *result = [service completeAgentRoundV2WithRequest:request
                                                             error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"completed");
  XCTAssertEqual([DSHProviderURLProtocol requestCount], (NSUInteger)1);
  NSDictionary *state = [wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(state[@"operations"][0][@"state"], @"committed");
  XCTAssertEqualObjects(state[@"rounds"][0][@"state"], @"completed");
  XCTAssertEqual([(NSArray *)state[@"transcripts"][0][@"messages"] count],
                 (NSUInteger)1);

  DSHAgentProviderRoundService *replayService =
      [[DSHAgentProviderRoundService alloc]
          initWithWAL:wal
          preparedStore:prepared
          transcripts:transcripts
          rounds:rounds
          transport:transport];
  NSDictionary *replay = [replayService completeAgentRoundV2WithRequest:request
                                                                     error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(replay, result);
  XCTAssertEqual([DSHProviderURLProtocol requestCount], (NSUInteger)1);
  [session invalidateAndCancel];
  [NSFileManager.defaultManager removeItemAtURL:walRoot error:nil];
  [DSHProviderURLProtocol reset];
}

- (void)testClaudeCodeToolRoundComposesThroughTheProviderAgnosticService {
  [DSHProviderURLProtocol reset];
  NSURL *walRoot = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
  DSHAgentNativeWAL *wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:walRoot
      clock:^NSDate *{
        return [NSDate dateWithTimeIntervalSince1970:1700000000];
      }
      identifierGenerator:^NSString *{
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      faultHook:nil];
  NSError *error = nil;
  NSDictionary *root = DSHProviderSmokeRoot();
  DSHAgentTranscriptStore *transcripts = [[DSHAgentTranscriptStore alloc]
      initWithWAL:wal];
  NSDictionary *transcript = [transcripts
      createAgentTranscriptWithRequest:@{
        @"schema_version" : @1,
        @"attempt_id" : DSHProviderSmokeAttempt,
        @"root" : root,
      }
      error:&error];
  XCTAssertNotNil(transcript);
  DSHAgentToolRegistry *registry = [[DSHAgentToolRegistry alloc] init];
  NSDictionary *registryProjection = [registry registryForRoot:root error:&error];
  XCTAssertNotNil(registryProjection);
  NSMutableDictionary *authority = [DSHProviderSmokeAuthority(
      root, transcript, registryProjection) mutableCopy];
  authority[@"model"] = @"claude-sonnet-5";
  DSHProviderSmokePreparedStore *prepared =
      [[DSHProviderSmokePreparedStore alloc] initWithAuthority:authority
                                                           root:root
                                                            wal:wal];
  DSHAgentRoundJournal *rounds = [[DSHAgentRoundJournal alloc] initWithWAL:wal];
  NSURLSessionConfiguration *configuration =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.protocolClasses = @[ DSHProviderURLProtocol.class ];
  DSHProviderURLSessionDelegate *delegate =
      [[DSHProviderURLSessionDelegate alloc] init];
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration
                                                          delegate:delegate
                                                     delegateQueue:nil];
  NSString *(^uuid)(void) = ^NSString *{
    return @"66666666-6666-4666-8666-666666666666";
  };
  NSTimeInterval (^clock)(void) = ^NSTimeInterval { return 3.0; };
  DshProviderTransport *dsh = [[DshProviderTransport alloc]
      initWithSession:session uuidGenerator:uuid monotonicClock:clock];
  ClaudeProviderTransport *claude = [[ClaudeProviderTransport alloc]
      initWithSession:session uuidGenerator:uuid monotonicClock:clock];
  delegate.transport = claude;
  __block NSDictionary *requestBody = nil;
  __block NSDictionary *requestHeaders = nil;
  __block NSURL *requestURL = nil;
  [DSHProviderURLProtocol setHandler:^(NSURLProtocol *protocol,
                                        NSURLRequest *request) {
    requestURL = request.URL;
    requestHeaders = request.allHTTPHeaderFields;
    requestBody = [NSJSONSerialization
        JSONObjectWithData:DSHProviderCapturedRequestBody(request)
                   options:0
                     error:nil];
    NSDictionary *payload = @{
      @"id" : @"msg_claude_round",
      @"type" : @"message",
      @"role" : @"assistant",
      @"model" : @"claude-sonnet-5",
      @"content" : @[
        @{ @"type" : @"text", @"text" : @"Writing the proof." },
        @{ @"type" : @"tool_use", @"id" : @"toolu_01", @"name" : @"write_file",
           @"input" : @{ @"path" : @"RISH_HARNESS_PROOF_20260901.md",
                         @"content" : @"Rish real-device harness proof." } },
      ],
      @"stop_reason" : @"tool_use",
      @"stop_sequence" : NSNull.null,
      @"usage" : @{ @"input_tokens" : @20, @"output_tokens" : @30 },
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload
                                                     options:0
                                                       error:nil];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc]
        initWithURL:request.URL statusCode:200 HTTPVersion:@"HTTP/1.1"
        headerFields:@{ @"Content-Type" : @"application/json" }];
    [protocol.client URLProtocol:protocol didReceiveResponse:response
             cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [protocol.client URLProtocol:protocol didLoadData:data];
    [protocol.client URLProtocolDidFinishLoading:protocol];
  }];
  __block NSString *credentialHarness = nil;
  DSHAgentProviderRoundService *service =
      [[DSHAgentProviderRoundService alloc]
          initWithWAL:wal
          preparedStore:prepared
          transcripts:transcripts
          rounds:rounds
          transport:dsh
          claudeTransport:claude
          codexTransport:nil
          credentialProvider:^NSString *(NSString *harnessId, NSUInteger *generation) {
            credentialHarness = harnessId;
            if (generation != nullptr) *generation = 7;
            return @"sk-ant-credential";
          }
          visibleHistoryProvider:^NSArray *(NSDictionary *nativeAuthority,
                                             NSError **historyError) {
            if (historyError != nullptr) *historyError = nil;
            return @[ @{ @"role" : @"user", @"content" : @"hello" } ];
          }
          contextReceiptProvider:nil];
  NSMutableDictionary *request = [DSHProviderSmokeRequest(
      root, transcript, registryProjection[@"toolset_sha256"],
      DSHProviderSmokeOperation) mutableCopy];
  request[@"model"] = @"claude-sonnet-5";
  request[@"harness_id"] = @"claude-code";
  NSDictionary *result = [service completeAgentRoundV2WithRequest:request
                                                             error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"completed");
  XCTAssertEqual([DSHProviderURLProtocol requestCount], (NSUInteger)1);
  // The Anthropic dialect went over the wire with the shared tool registry.
  XCTAssertEqualObjects(credentialHarness, @"claude-code");
  XCTAssertEqualObjects(requestURL.host, @"api.anthropic.com");
  XCTAssertEqualObjects(requestHeaders[@"x-api-key"], @"sk-ant-credential");
  XCTAssertEqualObjects(requestHeaders[@"anthropic-version"], @"2023-06-01");
  XCTAssertNil(requestHeaders[@"Authorization"]);
  XCTAssertEqualObjects(requestBody[@"model"], @"claude-sonnet-5");
  XCTAssertEqualObjects(requestBody[@"thinking"], @{ @"type" : @"disabled" });
  XCTAssertEqualObjects(requestBody[@"messages"][0][@"role"], @"user");
  XCTAssertEqualObjects(requestBody[@"messages"][0][@"content"][0][@"type"], @"text");
  NSDictionary *writeTool = nil;
  for (NSDictionary *tool in requestBody[@"tools"]) {
    if ([tool[@"name"] isEqualToString:@"write_file"]) writeTool = tool;
  }
  XCTAssertNotNil(writeTool);
  XCTAssertNotNil(writeTool[@"input_schema"][@"properties"][@"expected_revision"]);
  XCTAssertNil(writeTool[@"function"], @"Anthropic tools are flat, not OpenAI-wrapped");
  // The round result is the same provider-agnostic tool batch DSH produces.
  NSDictionary *outcome = result[@"outcome"];
  XCTAssertEqualObjects(outcome[@"kind"], @"tool_batch");
  XCTAssertEqualObjects(outcome[@"finish_reason"], @"tool_calls");
  XCTAssertEqualObjects(outcome[@"calls"][0][@"name"], @"write_file");
  XCTAssertEqualObjects(outcome[@"calls"][0][@"call_id"], @"toolu_01");
  NSDictionary *receipt = outcome[@"completion_receipt"];
  XCTAssertEqualObjects(receipt[@"harness_id"], @"claude-code");
  XCTAssertEqualObjects(receipt[@"model"], @"claude-sonnet-5");
  XCTAssertEqualObjects(receipt[@"requested_model"], @"claude-sonnet-5");
  XCTAssertEqualObjects(receipt[@"provider_response_id"], @"msg_claude_round");
  NSDictionary *state = [wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(state[@"operations"][0][@"state"], @"committed");
  XCTAssertEqualObjects(state[@"rounds"][0][@"state"], @"completed");
  NSArray *messages = state[@"transcripts"][0][@"messages"];
  XCTAssertEqual(messages.count, (NSUInteger)1);
  XCTAssertEqualObjects(messages[0][@"tool_calls"][0][@"name"], @"write_file");
  XCTAssertEqualObjects(messages[0][@"tool_calls"][0][@"arguments_json"],
      @"{\"content\":\"Rish real-device harness proof.\",\"expected_revision\":null,\"path\":\"RISH_HARNESS_PROOF_20260901.md\"}");
  [session invalidateAndCancel];
  [NSFileManager.defaultManager removeItemAtURL:walRoot error:nil];
  [DSHProviderURLProtocol reset];
}

- (void)testRetryFailedRoundClaimsExistingRowAndNeverCreatesAnotherRound {
  NSURL *walRoot = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
  DSHAgentNativeWAL *wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:walRoot
      clock:^NSDate *{
        return [NSDate dateWithTimeIntervalSince1970:1700000000];
      }
      identifierGenerator:^NSString *{
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      faultHook:nil];
  NSError *error = nil;
  NSDictionary *root = DSHProviderSmokeRoot();
  DSHAgentTranscriptStore *transcripts = [[DSHAgentTranscriptStore alloc]
      initWithWAL:wal];
  NSDictionary *transcript = [transcripts
      createAgentTranscriptWithRequest:@{
        @"schema_version" : @1,
        @"attempt_id" : DSHProviderSmokeAttempt,
        @"root" : root,
      }
      error:&error];
  XCTAssertNotNil(transcript);
  XCTAssertNil(error);
  DSHAgentToolRegistry *registry = [[DSHAgentToolRegistry alloc] init];
  NSDictionary *registryProjection = [registry registryForRoot:root error:&error];
  XCTAssertNotNil(registryProjection);
  XCTAssertNil(error);
  NSDictionary *authority = DSHProviderSmokeAuthority(root, transcript,
                                                      registryProjection);
  DSHProviderSmokePreparedStore *prepared =
      [[DSHProviderSmokePreparedStore alloc] initWithAuthority:authority
                                                           root:root
                                                            wal:wal];
  DSHAgentRoundJournal *rounds = [[DSHAgentRoundJournal alloc] initWithWAL:wal];
  DSHProviderSmokeTransport *transport = [[DSHProviderSmokeTransport alloc]
      initWithResult:@{
        @"provider_request_id" : @"66666666-6666-4666-8666-666666666666",
        @"provider_response_id" : @"response-retry",
        @"requested_model" : @"deepseek-v4-flash",
        @"model" : @"deepseek-v4-flash",
        @"thinking_mode" : @"off",
        @"text" : @"retried",
        @"reasoning" : @"",
        @"tool_calls" : @[],
        @"finish_reason" : @"stop",
        @"latency_ms" : @1,
        @"visible_history_sha256" : DSHProviderSmokeDigest,
        @"model_input_sha256" : DSHProviderSmokeDigest,
        @"request_body_sha256" : DSHProviderSmokeDigest,
      }];
  DSHAgentProviderRoundService *service =
      [[DSHAgentProviderRoundService alloc]
          initWithWAL:wal
          preparedStore:prepared
          transcripts:transcripts
          rounds:rounds
          transport:transport
          credentialProvider:^NSString *(NSString *harnessId, NSUInteger *generation) {
            if (generation != nullptr) *generation = 7;
            return @"credential";
          }
          visibleHistoryProvider:^NSArray *(NSDictionary *nativeAuthority,
                                             NSError **historyError) {
            if (historyError != nullptr) *historyError = nil;
            return @[ @{ @"role" : @"user", @"content" : @"hello" } ];
          }];
  NSMutableDictionary *request = [DSHProviderSmokeRequest(
      root, transcript, registryProjection[@"toolset_sha256"],
      @"99999999-9999-4999-8999-999999999999") mutableCopy];
  request[@"expected_round_revision"] = @1;
  request[@"launch_attempt"] = @2;
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"complete_agent_round_v2",
    @"request" : request,
  }, &error);
  XCTAssertNotNil(requestSHA);
  XCTAssertNil(error);
  NSDictionary *locator = DSHProviderRoundLocator(request);
  NSDictionary *failed = @{
    @"schema_version" : @3,
    @"locator" : locator,
    @"row_revision" : @1,
    @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
    @"binding_revision" : @7,
    @"request_sha256" : requestSHA,
    @"transcript_before" : transcript,
    @"launch_attempt" : @1,
    @"state" : @"failed_retryable",
    @"owner" : NSNull.null,
    @"failure_code" : @"E_AGENT_PERSISTENCE",
    @"completion_receipt" : NSNull.null,
    @"transcript_after" : NSNull.null,
    @"calls" : @[],
    @"batch_class" : NSNull.null,
    @"executable_call_count" : @0,
    @"denied_call_count" : @0,
    @"terminal_kind" : NSNull.null,
    @"created_at" : wal.currentTimestamp,
    @"updated_at" : wal.currentTimestamp,
  };
  BOOL inserted = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *roundRows = [state[@"rounds"] mutableCopy];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    [roundRows addObject:failed];
    [dispatch addObject:@{
      @"schema_version" : @1,
      @"kind" : @"round",
      @"locator" : locator,
      @"dispatch_state" : @"not_dispatched",
    }];
    state[@"rounds"] = roundRows;
    state[@"dispatch"] = dispatch;
    return YES;
  } error:&error];
  XCTAssertTrue(inserted);
  XCTAssertNil(error);

  NSDictionary *result = [service retryFailedAgentRoundV2WithRequest:request
                                                                  error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"completed");
  XCTAssertEqual(transport.startCount, (NSUInteger)1);
  NSDictionary *state = [wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqual([(NSArray *)state[@"rounds"] count], (NSUInteger)1);
  NSDictionary *round = state[@"rounds"][0];
  XCTAssertEqualObjects(round[@"state"], @"completed");
  XCTAssertEqualObjects(round[@"launch_attempt"], @2);
  XCTAssertEqualObjects(round[@"row_revision"], @4);
  XCTAssertEqualObjects(state[@"dispatch"][0][@"dispatch_state"], @"dispatched");
  [NSFileManager.defaultManager removeItemAtURL:walRoot error:nil];
}

- (void)testRoundV3ClaimAdvancesRevisionAndRequiresRetryableState {
  NSURL *walRoot = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
  DSHAgentNativeWAL *wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:walRoot
      clock:^NSDate *{
        return [NSDate dateWithTimeIntervalSince1970:1700000000];
      }
      identifierGenerator:^NSString *{
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      faultHook:nil];
  NSError *error = nil;
  NSDictionary *root = DSHProviderSmokeRoot();
  DSHAgentTranscriptStore *transcripts = [[DSHAgentTranscriptStore alloc]
      initWithWAL:wal];
  NSDictionary *transcript = [transcripts
      createAgentTranscriptWithRequest:@{
        @"schema_version" : @1,
        @"attempt_id" : DSHProviderSmokeAttempt,
        @"root" : root,
      }
      error:&error];
  XCTAssertNotNil(transcript);
  NSDictionary *locator = @{
    @"schema_version" : @1,
    @"task_id" : DSHProviderSmokeTask,
    @"attempt_id" : DSHProviderSmokeAttempt,
    @"round_id" : DSHProviderSmokeRound,
    @"round_index" : @0,
  };
  NSDictionary *row = @{
    @"schema_version" : @3,
    @"locator" : locator,
    @"row_revision" : @1,
    @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
    @"binding_revision" : @7,
    @"request_sha256" : DSHProviderSmokeDigest,
    @"transcript_before" : transcript,
    @"launch_attempt" : @1,
    @"state" : @"failed_retryable",
    @"owner" : NSNull.null,
    @"failure_code" : @"E_AGENT_PERSISTENCE",
    @"completion_receipt" : NSNull.null,
    @"transcript_after" : NSNull.null,
    @"calls" : @[],
    @"batch_class" : NSNull.null,
    @"executable_call_count" : @0,
    @"denied_call_count" : @0,
    @"terminal_kind" : NSNull.null,
    @"created_at" : wal.currentTimestamp,
    @"updated_at" : wal.currentTimestamp,
  };
  BOOL inserted = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *roundRows = [state[@"rounds"] mutableCopy];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    [roundRows addObject:row];
    [dispatch addObject:@{
      @"schema_version" : @1,
      @"kind" : @"round",
      @"locator" : locator,
      @"dispatch_state" : @"not_dispatched",
    }];
    state[@"rounds"] = roundRows;
    state[@"dispatch"] = dispatch;
    return YES;
  } error:&error];
  XCTAssertTrue(inserted);
  XCTAssertNil(error);
  NSString *nativeTaskId = @"99999999-9999-4999-8999-999999999999";
  XCTAssertTrue([wal registerNativeTaskId:nativeTaskId error:&error]);
  NSDictionary *owner = @{
    @"schema_version" : @1,
    @"task_id" : DSHProviderSmokeTask,
    @"launch_id" : wal.launchId,
    @"native_task_id" : nativeTaskId,
    @"owner_generation" : @1,
    @"heartbeat_at" : wal.currentTimestamp,
  };
  DSHAgentRoundJournal *journal = [[DSHAgentRoundJournal alloc] initWithWAL:wal];
  NSDictionary *claimed = [journal claimAgentRoundV3WithLocator:locator
                                               expectedRowRevision:@1
                                                              owner:owner
                                                              error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(claimed[@"row"][@"row_revision"], @2);
  XCTAssertEqualObjects(claimed[@"row"][@"state"], @"in_flight");
  XCTAssertEqualObjects(claimed[@"row"][@"launch_attempt"], @2);
  XCTAssertEqualObjects(claimed[@"row"][@"owner"], owner);
  XCTAssertTrue([wal unregisterNativeTaskId:nativeTaskId error:&error]);
  [NSFileManager.defaultManager removeItemAtURL:walRoot error:nil];
}

- (void)testRoundV3CancelBeforeDispatchCannotBecomeRetryable {
  NSURL *walRoot = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
  DSHAgentNativeWAL *wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:walRoot
      clock:^NSDate *{
        return [NSDate dateWithTimeIntervalSince1970:1700000000];
      }
      identifierGenerator:^NSString *{
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      faultHook:nil];
  NSError *error = nil;
  NSDictionary *root = DSHProviderSmokeRoot();
  DSHAgentTranscriptStore *transcripts = [[DSHAgentTranscriptStore alloc]
      initWithWAL:wal];
  NSDictionary *transcript = [transcripts
      createAgentTranscriptWithRequest:@{
        @"schema_version" : @1,
        @"attempt_id" : DSHProviderSmokeAttempt,
        @"root" : root,
      }
      error:&error];
  NSDictionary *locator = @{
    @"schema_version" : @1,
    @"task_id" : DSHProviderSmokeTask,
    @"attempt_id" : DSHProviderSmokeAttempt,
    @"round_id" : DSHProviderSmokeRound,
    @"round_index" : @0,
  };
  NSDictionary *deadOwner = @{
    @"schema_version" : @1,
    @"task_id" : DSHProviderSmokeTask,
    @"launch_id" : wal.launchId,
    @"native_task_id" : @"99999999-9999-4999-8999-999999999999",
    @"owner_generation" : @1,
    @"heartbeat_at" : wal.currentTimestamp,
  };
  NSDictionary *row = @{
    @"schema_version" : @3,
    @"locator" : locator,
    @"row_revision" : @1,
    @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
    @"binding_revision" : @7,
    @"request_sha256" : DSHProviderSmokeDigest,
    @"transcript_before" : transcript,
    @"launch_attempt" : @1,
    @"state" : @"cancel_requested",
    @"owner" : deadOwner,
    @"failure_code" : NSNull.null,
    @"completion_receipt" : NSNull.null,
    @"transcript_after" : NSNull.null,
    @"calls" : @[],
    @"batch_class" : NSNull.null,
    @"executable_call_count" : @0,
    @"denied_call_count" : @0,
    @"terminal_kind" : NSNull.null,
    @"created_at" : wal.currentTimestamp,
    @"updated_at" : wal.currentTimestamp,
  };
  BOOL inserted = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *roundRows = [state[@"rounds"] mutableCopy];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    [roundRows addObject:row];
    [dispatch addObject:@{
      @"schema_version" : @1,
      @"kind" : @"round",
      @"locator" : locator,
      @"dispatch_state" : @"not_dispatched",
    }];
    state[@"rounds"] = roundRows;
    state[@"dispatch"] = dispatch;
    return YES;
  } error:&error];
  XCTAssertTrue(inserted);
  XCTAssertNil(error);
  DSHAgentRoundJournal *journal = [[DSHAgentRoundJournal alloc] initWithWAL:wal];
  NSDictionary *cas = DSHProviderRoundCASForRow(row);
  NSDictionary *reconciled = [journal
      reconcileAgentRoundV3OwnerLossWithLocator:locator
                                      expectedCAS:cas
                                             error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(reconciled[@"row"][@"state"], @"cancelled");
  XCTAssertEqualObjects(reconciled[@"row"][@"failure_code"],
                        @"E_AGENT_CANCELLED");
  [NSFileManager.defaultManager removeItemAtURL:walRoot error:nil];
}

@end
