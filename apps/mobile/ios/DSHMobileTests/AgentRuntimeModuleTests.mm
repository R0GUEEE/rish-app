#import <XCTest/XCTest.h>
#import <React/RCTBridgeModule.h>

#import "../../../../modules/rish/ios/Sources/AgentNativeWAL.h"
#import "../../../../modules/rish/ios/Sources/AgentRuntimeCoordinator.h"
#import "../../../../modules/rish/ios/Sources/AgentExecutionLedger.h"
#import "../../../../modules/rish/ios/Sources/AgentGitToolExecutor.h"
#import "../../../../modules/rish/ios/Sources/AgentPreparedAttemptStore.h"
#import "../../../../modules/rish/ios/Sources/AgentProviderRoundService.h"
#import "../../../../modules/rish/ios/Sources/AgentRootResolver.h"
#import "../../../../modules/rish/ios/Sources/AgentRoundJournal.h"
#import "../../../../modules/rish/ios/Sources/AgentToolBatchService.h"
#import "../../../../modules/rish/ios/Sources/AgentToolExecutionService.h"
#import "../../../../modules/rish/ios/Sources/AgentTranscriptStore.h"
#import "../../../../modules/rish/ios/Sources/AgentWorkspaceToolExecutor.h"
#import "../../../../modules/rish/ios/Sources/DSHCompletionProviderTransport.h"
#import "../../../../modules/rish/ios/Sources/SessionSnapshotStore.h"

#import <objc/message.h>
#import <objc/runtime.h>

typedef void (^DSHRuntimeResolve)(id value);
typedef void (^DSHRuntimeReject)(NSString *code, NSString *message,
                                 NSError *error);

@interface NSObject (DSHRuntimeModuleContract)
+ (NSString *)moduleName;
- (instancetype)initWithCoordinator:(id<DSHAgentRuntimeCoordinating>)coordinator;
@end

@interface DSHRecordingRuntimeCoordinator : NSObject
    <DSHAgentRuntimeCoordinating>
@property(nonatomic, getter=isAvailable) BOOL available;
@property(nonatomic, copy) NSString *method;
@property(nonatomic, copy) NSDictionary *request;
@property(nonatomic, copy) NSDictionary *result;
@property(nonatomic, strong) NSError *error;
@property(nonatomic) NSUInteger callCount;
@end

@implementation DSHRecordingRuntimeCoordinator

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _available = YES;
    _result = @{ @"schema_version" : @2, @"status" : @"ok" };
  }
  return self;
}

- (NSDictionary *)record:(NSString *)method request:(NSDictionary *)request
                    error:(NSError **)error {
  self.method = method;
  self.request = request;
  self.callCount += 1;
  if (self.error != nil) {
    if (error != nullptr) *error = self.error;
    return nil;
  }
  return self.result;
}

#define DSH_RECORD(selector) \
  - (NSDictionary *)selector:(NSDictionary *)request error:(NSError **)error { \
    return [self record:@#selector request:request error:error]; \
  }

DSH_RECORD(prepareAgentAttempt)
DSH_RECORD(completeAgentRoundV2)
DSH_RECORD(prepareAgentToolBatch)
DSH_RECORD(bindAgentApproval)
DSH_RECORD(executeAgentTool)
DSH_RECORD(cancelAgentAttempt)
DSH_RECORD(queryAgentAttempt)
DSH_RECORD(queryAgentTool)
DSH_RECORD(recoverAgentAttempt)
DSH_RECORD(finalizeAgentAttempt)
DSH_RECORD(discardAgentAttempt)
DSH_RECORD(queryAgentCleanup)

#undef DSH_RECORD

@end

@interface DSHRecoveryWAL : DSHAgentNativeWAL
@property(nonatomic, copy) NSDictionary *recoveryState;
@end
@implementation DSHRecoveryWAL
- (NSDictionary *)snapshotWithError:(NSError **)error {
  if (error != nullptr) *error = nil;
  return self.recoveryState;
}
- (BOOL)performAtomicTransaction:(DSHAgentNativeWALMutation)mutation
                           error:(NSError **)error {
  NSMutableDictionary *candidate = [self.recoveryState mutableCopy];
  if (candidate[@"operations"] == nil) candidate[@"operations"] = @[];
  if (candidate[@"operation_results"] == nil) {
    candidate[@"operation_results"] = @[];
  }
  BOOL committed = mutation(candidate, error);
  if (committed) self.recoveryState = [candidate copy];
  return committed;
}
- (BOOL)reconcileOwnerLossWithError:(NSError **)error {
  if (error != nullptr) *error = nil;
  return YES;
}
@end

@interface DSHRecoveryPreparedStore : DSHAgentPreparedAttemptStore
@property(nonatomic, copy) NSDictionary *recoveryAuthority;
@property(nonatomic, copy) NSDictionary *preparedProjection;
@end
@implementation DSHRecoveryPreparedStore
- (NSDictionary *)nativeAuthorityForTaskId:(NSString *)taskId
                                  attemptId:(NSString *)attemptId
                                      error:(NSError **)error {
  (void)taskId; (void)attemptId;
  if (error != nullptr) *error = nil;
  return self.recoveryAuthority;
}
- (NSDictionary *)preparedAttemptForTaskId:(NSString *)taskId
                                  attemptId:(NSString *)attemptId
                                      error:(NSError **)error {
  (void)taskId; (void)attemptId;
  if (error != nullptr) *error = nil;
  return self.preparedProjection;
}
- (BOOL)validatePreparedRoot:(NSDictionary *)root taskId:(NSString *)taskId
                   attemptId:(NSString *)attemptId error:(NSError **)error {
  (void)root; (void)taskId; (void)attemptId;
  if (error != nullptr) *error = nil;
  return YES;
}
@end

@interface DSHRecoverySessionStore : DSHSessionSnapshotStore
@property(nonatomic, copy) NSDictionary *recoveryLoad;
@end
@implementation DSHRecoverySessionStore
- (NSDictionary *)loadSessionSnapshotWithError:(NSError **)error {
  if (error != nullptr) *error = nil;
  return self.recoveryLoad;
}
@end

@interface DSHRecordingRoundRecoveryService : DSHAgentProviderRoundService
@property(nonatomic, copy) NSDictionary *recoveryResult;
@property(nonatomic, copy) NSDictionary *receivedRecoveryRequest;
@property(nonatomic, copy) NSDictionary *retryResult;
@property(nonatomic, copy) NSDictionary *receivedRetryRequest;
@end
@implementation DSHRecordingRoundRecoveryService
- (NSDictionary *)recoverAgentRoundWithRequest:(NSDictionary *)request
                                          error:(NSError **)error {
  self.receivedRecoveryRequest = request;
  if (error != nullptr) *error = nil;
  return self.recoveryResult;
}
- (NSDictionary *)retryFailedAgentRoundV2WithRequest:(NSDictionary *)request
                                                error:(NSError **)error {
  self.receivedRetryRequest = request;
  if (error != nullptr) *error = nil;
  return self.retryResult;
}
@end

@interface DSHRecordingToolRecoveryService : DSHAgentToolExecutionService
@property(nonatomic, copy) NSDictionary *recoveryResult;
@property(nonatomic, copy) NSDictionary *receivedRecoveryRequest;
@end
@implementation DSHRecordingToolRecoveryService
- (NSDictionary *)recoverAgentToolWithRequest:(NSDictionary *)request
                                         error:(NSError **)error {
  self.receivedRecoveryRequest = request;
  if (error != nullptr) *error = nil;
  if ([@[@"completed", @"failed", @"denied", @"cancelled", @"ambiguous"]
          containsObject:self.recoveryResult[@"status"]]) {
    NSMutableDictionary *result = [self.recoveryResult mutableCopy];
    result[@"operation_id"] = request[@"operation_id"];
    result[@"result_execution_revision"] =
        request[@"expected_execution_revision"];
    return [result copy];
  }
  return self.recoveryResult;
}
@end

@interface DSHRecordingQueryLedger : DSHAgentExecutionLedger
@property(nonatomic, copy) NSDictionary *queryResult;
@property(nonatomic, copy) NSDictionary *receivedRootExpectation;
@end
@implementation DSHRecordingQueryLedger
- (NSDictionary *)queryAgentExecutionWithLocator:(NSDictionary *)locator
                                expectedTranscript:(NSDictionary *)transcript
                                               root:(NSDictionary *)root
                                             error:(NSError **)error {
  (void)locator; (void)transcript;
  self.receivedRootExpectation = root;
  if (error != nullptr) *error = nil;
  return self.queryResult;
}
@end

@interface DSHRecoveryRuntimeCoordinator : DSHAgentRuntimeCoordinator
@property(nonatomic, copy) NSDictionary *attemptQueryResult;
@end
@implementation DSHRecoveryRuntimeCoordinator
- (NSDictionary *)queryAgentAttempt:(NSDictionary *)request
                               error:(NSError **)error {
  (void)request;
  if (error != nullptr) *error = nil;
  return self.attemptQueryResult;
}
@end

@interface AgentRuntimeModuleTests : XCTestCase
@property(nonatomic, strong) NSURL *rootURL;
@end

@implementation AgentRuntimeModuleTests

- (void)setUp {
  [super setUp];
  self.rootURL = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString.lowercaseString]
                                isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:self.rootURL
      withIntermediateDirectories:YES attributes:nil error:nil]);
}

- (void)tearDown {
  [NSFileManager.defaultManager removeItemAtURL:self.rootURL error:nil];
  [super tearDown];
}

- (Class)moduleClass {
  Class cls = NSClassFromString(@"AgentRuntimeModule");
  XCTAssertNotNil(cls);
  return cls;
}

- (id)moduleWithCoordinator:(DSHRecordingRuntimeCoordinator *)coordinator {
  return [[(id)[self moduleClass] alloc] initWithCoordinator:coordinator];
}

- (NSArray<NSString *> *)exportedJSNames {
  Class meta = object_getClass([self moduleClass]);
  unsigned int count = 0;
  Method *methods = class_copyMethodList(meta, &count);
  NSMutableArray *names = [NSMutableArray array];
  for (unsigned int index = 0; index < count; index += 1) {
    SEL selector = method_getName(methods[index]);
    NSString *name = NSStringFromSelector(selector);
    if (![name hasPrefix:@"__rct_export__"]) continue;
    IMP implementation = method_getImplementation(methods[index]);
    const RCTMethodInfo *(*function)(id, SEL) =
        reinterpret_cast<const RCTMethodInfo *(*)(id, SEL)>(implementation);
    const RCTMethodInfo *info = function([self moduleClass], selector);
    if (info != nullptr && info->jsName != nullptr) {
      [names addObject:[NSString stringWithUTF8String:info->jsName]];
    }
  }
  free(methods);
  return [names sortedArrayUsingSelector:@selector(compare:)];
}

- (void)invokeModule:(id)module selector:(SEL)selector request:(id)request
              resolve:(DSHRuntimeResolve)resolve reject:(DSHRuntimeReject)reject {
  using Function = void (*)(id, SEL, id, DSHRuntimeResolve, DSHRuntimeReject);
  Function function = reinterpret_cast<Function>(objc_msgSend);
  function(module, selector, request, resolve, reject);
}

- (void)testExportsExactlyTwelveHighLevelSelectorsAndNoLegacySurface {
  XCTAssertEqualObjects([[self moduleClass] moduleName], @"AgentRuntime");
  NSArray *expected = [@[
    @"bind_agent_approval", @"cancel_agent_attempt", @"complete_agent_round_v2",
    @"discard_agent_attempt", @"execute_agent_tool", @"finalize_agent_attempt",
    @"prepare_agent_attempt", @"prepare_agent_tool_batch",
    @"query_agent_attempt", @"query_agent_cleanup", @"query_agent_tool",
    @"recover_agent_attempt",
  ] sortedArrayUsingSelector:@selector(compare:)];
  XCTAssertEqualObjects([self exportedJSNames], expected);
  id module = [self moduleWithCoordinator:[[DSHRecordingRuntimeCoordinator alloc] init]];
  for (NSString *legacy in @[
    @"createAgentTranscriptRequest:resolver:rejecter:",
    @"validateAgentTranscriptRequest:resolver:rejecter:",
    @"createAgentRoundRequest:resolver:rejecter:",
    @"claimAgentRoundRequest:resolver:rejecter:",
    @"casAgentRoundRequest:resolver:rejecter:",
    @"claimAgentExecutionRequest:resolver:rejecter:",
    @"casAgentExecutionRequest:resolver:rejecter:",
    @"reserveWriteBytesRequest:resolver:rejecter:",
    @"openAgentWriteBatchEffectGateRequest:resolver:rejecter:",
    @"reconcileAgentExecutionRequest:resolver:rejecter:",
  ]) {
    XCTAssertFalse([module respondsToSelector:NSSelectorFromString(legacy)]);
  }
}

- (void)testAllSelectorsMapToOneCoordinatorAndSnapshotRequest {
  NSArray<NSArray<NSString *> *> *bindings = @[
    @[@"prepareAgentAttemptRequest:resolver:rejecter:", @"prepareAgentAttempt"],
    @[@"completeAgentRoundV2Request:resolver:rejecter:", @"completeAgentRoundV2"],
    @[@"prepareAgentToolBatchRequest:resolver:rejecter:", @"prepareAgentToolBatch"],
    @[@"bindAgentApprovalRequest:resolver:rejecter:", @"bindAgentApproval"],
    @[@"executeAgentToolRequest:resolver:rejecter:", @"executeAgentTool"],
    @[@"cancelAgentAttemptRequest:resolver:rejecter:", @"cancelAgentAttempt"],
    @[@"queryAgentAttemptRequest:resolver:rejecter:", @"queryAgentAttempt"],
    @[@"queryAgentToolRequest:resolver:rejecter:", @"queryAgentTool"],
    @[@"recoverAgentAttemptRequest:resolver:rejecter:", @"recoverAgentAttempt"],
    @[@"finalizeAgentAttemptRequest:resolver:rejecter:", @"finalizeAgentAttempt"],
    @[@"discardAgentAttemptRequest:resolver:rejecter:", @"discardAgentAttempt"],
    @[@"queryAgentCleanupRequest:resolver:rejecter:", @"queryAgentCleanup"],
  ];
  DSHRecordingRuntimeCoordinator *coordinator =
      [[DSHRecordingRuntimeCoordinator alloc] init];
  id module = [self moduleWithCoordinator:coordinator];
  for (NSArray<NSString *> *binding in bindings) {
    XCTestExpectation *done = [self expectationWithDescription:binding[1]];
    NSMutableDictionary *request = [@{ @"schema_version" : @2,
                                       @"marker" : binding[1] } mutableCopy];
    [self invokeModule:module selector:NSSelectorFromString(binding[0])
        request:request resolve:^(id value) {
          XCTAssertEqualObjects(value, coordinator.result);
          XCTAssertEqualObjects(coordinator.method, binding[1]);
          XCTAssertEqualObjects(coordinator.request[@"marker"], binding[1]);
          XCTAssertFalse(coordinator.request == request);
          [done fulfill];
        } reject:^(NSString *code, NSString *message, NSError *error) {
          XCTFail(@"unexpected rejection %@ %@ %@", code, message, error);
          [done fulfill];
        }];
    request[@"marker"] = @"mutated-after-call";
    [self waitForExpectations:@[done] timeout:2];
  }
  XCTAssertEqual(coordinator.callCount, 12U);
}

- (void)testInvalidBridgeValueAndUnavailableCoordinatorFailClosed {
  DSHRecordingRuntimeCoordinator *coordinator =
      [[DSHRecordingRuntimeCoordinator alloc] init];
  id module = [self moduleWithCoordinator:coordinator];
  XCTestExpectation *bad = [self expectationWithDescription:@"bad"];
  [self invokeModule:module
      selector:NSSelectorFromString(@"prepareAgentAttemptRequest:resolver:rejecter:")
      request:@[@1] resolve:^(__unused id value) { XCTFail(@"resolved"); }
      reject:^(NSString *code, __unused NSString *message,
               __unused NSError *error) {
        XCTAssertEqualObjects(code, @"E_AGENT_BAD_ARGUMENTS");
        [bad fulfill];
      }];
  [self waitForExpectations:@[bad] timeout:2];
  XCTAssertEqual(coordinator.callCount, 0U);

  coordinator.available = NO;
  XCTestExpectation *unavailable = [self expectationWithDescription:@"unavailable"];
  [self invokeModule:module
      selector:NSSelectorFromString(@"queryAgentCleanupRequest:resolver:rejecter:")
      request:@{ @"schema_version" : @2 }
      resolve:^(__unused id value) { XCTFail(@"resolved"); }
      reject:^(NSString *code, __unused NSString *message,
               __unused NSError *error) {
        XCTAssertEqualObjects(code, @"E_AGENT_NATIVE");
        [unavailable fulfill];
      }];
  [self waitForExpectations:@[unavailable] timeout:2];
}

- (void)testNativeErrorsMapToClosedCodeWithoutLeakingDescription {
  DSHRecordingRuntimeCoordinator *coordinator =
      [[DSHRecordingRuntimeCoordinator alloc] init];
  coordinator.error = DSHAgentNativeStoreError(
      DSHAgentNativeStoreErrorOwnerLost);
  id module = [self moduleWithCoordinator:coordinator];
  XCTestExpectation *done = [self expectationWithDescription:@"rejected"];
  [self invokeModule:module
      selector:NSSelectorFromString(@"executeAgentToolRequest:resolver:rejecter:")
      request:@{ @"schema_version" : @2 }
      resolve:^(__unused id value) { XCTFail(@"resolved"); }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTAssertEqualObjects(code, @"E_AGENT_EXECUTION_AMBIGUOUS");
        XCTAssertEqualObjects(message, code);
        XCTAssertNil(error);
        [done fulfill];
      }];
  [self waitForExpectations:@[done] timeout:2];
}

- (void)testCoordinatorRequiresOneWALDomainAndAllHighLevelServices {
  DSHAgentNativeWAL *wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:self.rootURL clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      } faultHook:nil];
  DSHAgentTranscriptStore *transcripts = [[DSHAgentTranscriptStore alloc]
      initWithWAL:wal];
  DSHAgentRoundJournal *rounds = [[DSHAgentRoundJournal alloc] initWithWAL:wal];
  DSHAgentExecutionLedger *ledger = [[DSHAgentExecutionLedger alloc]
      initWithWAL:wal];
  DSHAgentRootResolver *resolver = [[DSHAgentRootResolver alloc]
      initWithWorkspaceAccess:(DSHLocalWorkspaceAccess *)(id)NSNull.null
      projectAccess:nil];
  DSHSessionSnapshotStore *sessions = [[DSHSessionSnapshotStore alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"sessions"]];
  DSHAgentPreparedAttemptStore *prepared = [[DSHAgentPreparedAttemptStore alloc]
      initWithWAL:wal rootResolver:resolver sessionSnapshotStore:sessions
      transcriptStore:transcripts];
  NSURLSession *session = [NSURLSession sessionWithConfiguration:
      NSURLSessionConfiguration.ephemeralSessionConfiguration];
  DSHCompletionProviderTransport *transport =
      [[DSHCompletionProviderTransport alloc] initWithSession:session
          uuidGenerator:nil monotonicClock:nil];
  DSHAgentProviderRoundService *roundService = [[DSHAgentProviderRoundService alloc]
      initWithWAL:wal preparedStore:prepared transcripts:transcripts
      rounds:rounds transport:transport
      credentialProvider:^NSString *(NSUInteger *generation) {
        if (generation != nullptr) *generation = 1;
        return @"test-credential";
      }
      visibleHistoryProvider:^NSArray *(NSDictionary *authority,
                                        NSError **error) {
        (void)authority; (void)error;
        return @[];
      }
      contextReceiptProvider:^NSDictionary *(NSDictionary *authority,
                                              NSError **error) {
        (void)authority; (void)error;
        return @{ @"receipt" : @{}, @"messages" : @[] };
      }];
  DSHAgentWorkspaceToolExecutor *workspace = [[DSHAgentWorkspaceToolExecutor alloc]
      initWithRootResolver:resolver];
  DSHAgentGitToolExecutor *git = [[DSHAgentGitToolExecutor alloc]
      initWithRootResolver:resolver];
  DSHAgentToolBatchService *batch = [[DSHAgentToolBatchService alloc]
      initWithWAL:wal ledger:ledger preparedStore:prepared
      transcripts:transcripts workspaceExecutor:workspace gitExecutor:git];
  DSHAgentToolExecutionService *execution = [[DSHAgentToolExecutionService alloc]
      initWithWAL:wal ledger:ledger preparedStore:prepared
      transcripts:transcripts workspaceExecutor:workspace gitExecutor:git];
  DSHAgentRuntimeCoordinator *coordinator = [[DSHAgentRuntimeCoordinator alloc]
      initWithWAL:wal preparedStore:prepared roundService:roundService
      batchService:batch executionService:execution transcripts:transcripts
      rounds:rounds ledger:ledger];
  XCTAssertNotNil(coordinator);
  XCTAssertTrue(coordinator.isAvailable);

  NSURL *splitURL = [self.rootURL URLByAppendingPathComponent:@"split"];
  DSHAgentNativeWAL *splitWAL = [[DSHAgentNativeWAL alloc]
      initWithRootURL:splitURL clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      } faultHook:nil];
  DSHAgentExecutionLedger *splitLedger = [[DSHAgentExecutionLedger alloc]
      initWithWAL:splitWAL];
  XCTAssertNil([[DSHAgentRuntimeCoordinator alloc]
      initWithWAL:wal preparedStore:prepared roundService:roundService
      batchService:batch executionService:execution transcripts:transcripts
      rounds:rounds ledger:splitLedger]);
  [session invalidateAndCancel];
}

- (NSDictionary *)recoveryControllerCAS {
  return @{ @"schema_version" : @1,
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"expected_controller_generation" : @1,
    @"expected_journal_revision" : @1,
    @"expected_session_generation" : @1,
    @"expected_session_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
}

- (NSDictionary *)recoveryCheckpoint {
  return @{ @"schema_version" : @1, @"journal_revision" : @1,
    @"session_generation" : @1, @"session_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
}

- (NSDictionary *)recoveryTranscript {
  return @{ @"schema_version" : @1,
    @"transcript_ref" : @"44444444-4444-4444-8444-444444444444",
    @"generation" : @1, @"transcript_sha256" :
        @"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    @"transcript_bytes" : @128 };
}

- (NSDictionary *)recoveryRoot {
  return @{ @"schema_version" : @1, @"kind" : @"workspace",
    @"workspace_id" : @"55555555-5555-4555-8555-555555555555",
    @"workspace_binding_revision" : @1, @"project_id" : NSNull.null,
    @"root_fingerprint_sha256" :
        @"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    @"capabilities" : @[@"file_read"] };
}

- (NSDictionary *)recoveryCancelRequestWithOperationId:(NSString *)operationId {
  return @{ @"schema_version" : @2, @"operation_id" : operationId,
    @"controller_cas" : [self recoveryControllerCAS],
    @"committed_checkpoint" : [self recoveryCheckpoint],
    @"target" : @{ @"schema_version" : @2, @"kind" : @"attempt",
      @"task_id" : @"22222222-2222-4222-8222-222222222222",
      @"attempt_id" : @"33333333-3333-4333-8333-333333333333" },
    @"cancel_token" : @{ @"schema_version" : @2,
      @"issuer" : @"completion_controller",
      @"source_event_id" : @"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      @"token" : @"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      @"task_id" : @"22222222-2222-4222-8222-222222222222",
      @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
      @"expected_phase" : @"round_in_flight",
      @"reason_code" : @"E_AGENT_CANCELLED" },
    @"expected_round_revision" : NSNull.null,
    @"expected_execution_revision" : NSNull.null,
    @"expected_transcript" : [self recoveryTranscript],
    @"root" : [self recoveryRoot] };
}

- (NSDictionary *)recoveryToolLocator {
  return @{ @"schema_version" : @2,
    @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"round_id" : @"77777777-7777-4777-8777-777777777777",
    @"round_index" : @0, @"call_index" : @0, @"call_id" : @"call-0",
    @"idempotency_key" :
        @"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" };
}

- (NSDictionary *)recoveryQueryToolRequestWithRevision:(NSNumber *)revision {
  NSDictionary *locator = [self recoveryToolLocator];
  return @{ @"schema_version" : @2,
    @"controller_cas" : [self recoveryControllerCAS],
    @"task_id" : locator[@"task_id"],
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : locator[@"attempt_id"], @"round_id" : locator[@"round_id"],
    @"round_index" : locator[@"round_index"],
    @"call_index" : locator[@"call_index"], @"call_id" : locator[@"call_id"],
    @"idempotency_key" : locator[@"idempotency_key"],
    @"expected_execution_revision" : revision,
    @"expected_transcript" : [self recoveryTranscript],
    @"expected_root_fingerprint_sha256" :
        [self recoveryRoot][@"root_fingerprint_sha256"],
    @"expected_workspace_binding_revision" : @1 };
}

- (NSDictionary *)recoveryQueryAttemptRequest {
  return @{ @"schema_version" : @2,
    @"controller_cas" : [self recoveryControllerCAS],
    @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"expected_journal_revision" : @1, @"expected_session_generation" : @1,
    @"expected_session_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    @"expected_transcript" : [self recoveryTranscript],
    @"expected_root_fingerprint_sha256" :
        [self recoveryRoot][@"root_fingerprint_sha256"],
    @"expected_workspace_binding_revision" : @1 };
}

- (DSHRecoveryRuntimeCoordinator *)recoveryCoordinatorWithWAL:
    (DSHRecoveryWAL *)wal
    roundService:(DSHRecordingRoundRecoveryService **)roundOut
    executionService:(DSHRecordingToolRecoveryService **)executionOut {
  DSHAgentTranscriptStore *transcripts = [[DSHAgentTranscriptStore alloc]
      initWithWAL:wal];
  DSHAgentExecutionLedger *ledger = [[DSHAgentExecutionLedger alloc]
      initWithWAL:wal];
  DSHRecoverySessionStore *sessionStore = [[DSHRecoverySessionStore alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"recovery-session"]];
  NSDictionary *session = @{ @"schema_version" : @9,
    @"agent_transcript_cleanup_outbox" : @[@{
      @"schema_version" : @1,
      @"cleanup_id" : @"13131313-1313-4313-8313-131313131313",
      @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
      @"task_id" : @"22222222-2222-4222-8222-222222222222",
      @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
      @"transcript_ref" : @"44444444-4444-4444-8444-444444444444",
      @"transcript_sha256" :
          @"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      @"reason" : @"completed", @"created_at" : @"2026-08-31T00:00:00.000Z"
    }],
    @"conversations" : @[@{
    @"id" : @"11111111-1111-4111-8111-111111111111",
    @"attempts" : @[@{ @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
      @"turn_id" : @"22222222-2222-4222-8222-222222222222",
      @"journal_revision" : @1,
      @"agent" : @{ @"controller_generation" : @1,
                      @"phase" : @"round_in_flight" } }] }],
    @"session_events" : @[@{ @"schema_version" : @2,
      @"event_id" : @"dddddddd-dddd-4ddd-8ddd-dddddddddddd", @"seq" : @0,
      @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
      @"kind" : @"cancel", @"status" : @"cancelled",
      @"safe_summary_key" : NSNull.null,
      @"arguments_sha256" : NSNull.null, @"result_sha256" : NSNull.null,
      @"approval_reference" : @"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      @"failure_code" : @"E_AGENT_CANCELLED",
      @"round_index" : NSNull.null, @"call_id" : NSNull.null,
      @"created_at" : @"2026-08-31T00:00:00.000Z" }] };
  NSData *sessionBytes = [NSJSONSerialization dataWithJSONObject:session
      options:NSJSONWritingSortedKeys error:nil];
  sessionStore.recoveryLoad = @{ @"status" : @"present",
    @"snapshot" : @{ @"generation" : @1, @"session_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    @"session_json" : [[NSString alloc] initWithData:sessionBytes
                                               encoding:NSUTF8StringEncoding] };
  DSHRecoveryPreparedStore *prepared = [[DSHRecoveryPreparedStore alloc]
      initWithWAL:wal
      rootResolver:(DSHAgentRootResolver *)(id)NSNull.null
      sessionSnapshotStore:sessionStore
      transcriptStore:transcripts];
  prepared.recoveryAuthority = @{ @"authority_revision" : @1,
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"state" : @"prepared", @"cleanup_id" : NSNull.null,
    @"root" : [self recoveryRoot], @"transcript" : [self recoveryTranscript],
    @"transport_schema_version" : @2, @"model" : @"deepseek-v4-flash",
    @"thinking_mode" : @"off", @"visible_history_sha256" :
        @"abababababababababababababababababababababababababababababababab",
    @"visible_message_count" : @0, @"project_context_sha256" : NSNull.null,
    @"registry" : @{ @"toolset_sha256" :
        @"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" } };
  prepared.preparedProjection = @{ @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"transcript" : [self recoveryTranscript], @"root" : [self recoveryRoot],
    @"journal_revision" : @1 };
  DSHAgentRoundJournal *rounds = [[DSHAgentRoundJournal alloc] initWithWAL:wal];
  DSHRecordingRoundRecoveryService *round =
      [[DSHRecordingRoundRecoveryService alloc]
          initWithWAL:wal preparedStore:prepared
          transcripts:transcripts rounds:rounds
          transport:(DSHCompletionProviderTransport *)(id)NSNull.null
          credentialProvider:nil visibleHistoryProvider:nil
          contextReceiptProvider:nil];
  DSHRecordingToolRecoveryService *execution =
      [[DSHRecordingToolRecoveryService alloc]
          initWithWAL:wal ledger:ledger
          preparedStore:prepared
          transcripts:transcripts
          workspaceExecutor:(DSHAgentWorkspaceToolExecutor *)(id)NSNull.null
          gitExecutor:(DSHAgentGitToolExecutor *)(id)NSNull.null];
  DSHRecoveryRuntimeCoordinator *coordinator =
      [[DSHRecoveryRuntimeCoordinator alloc]
          initForRecoveryTestingWithWAL:wal
          preparedStore:prepared
          roundService:round executionService:execution
          transcripts:transcripts ledger:ledger];
  coordinator.attemptQueryResult = @{ @"schema_version" : @2,
    @"status" : @"active", @"attempt" : @{
      @"task_id" : @"22222222-2222-4222-8222-222222222222",
      @"attempt_id" : @"33333333-3333-4333-8333-333333333333" } };
  if (roundOut != nullptr) *roundOut = round;
  if (executionOut != nullptr) *executionOut = execution;
  return coordinator;
}

- (void)testRoundRecoveryUsesNativeStateAndReturnsCompletedProjection {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"round-recovery"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"66666666-6666-4666-8666-666666666666";
      } faultHook:nil];
  wal.recoveryState = @{ @"ledger" : @[], @"batches" : @[],
                         @"operation_results" : @[] };
  DSHRecordingRoundRecoveryService *round = nil;
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:&round
          executionService:nullptr];
  NSDictionary *completed = @{ @"schema_version" : @2, @"kind" : @"final",
    @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"round_id" : @"77777777-7777-4777-8777-777777777777",
    @"round_index" : @0, @"result_round_revision" : @4 };
  round.recoveryResult = @{ @"schema_version" : @2, @"status" : @"completed",
    @"result_round_revision" : @4, @"completed_round" : completed };
  NSError *error = nil;
  NSDictionary *result = [coordinator recoverAgentAttempt:@{
    @"schema_version" : @2,
    @"operation_id" : @"88888888-8888-4888-8888-888888888888",
    @"controller_cas" : [self recoveryControllerCAS],
    @"committed_checkpoint" : [self recoveryCheckpoint],
    @"target" : @{ @"schema_version" : @2, @"kind" : @"round",
      @"task_id" : @"22222222-2222-4222-8222-222222222222",
      @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
      @"round_id" : @"77777777-7777-4777-8777-777777777777",
      @"round_index" : @0 },
    @"action" : @"reconcile", @"expected_round_revision" : @4,
    @"expected_execution_revision" : NSNull.null,
    @"expected_transcript" : [self recoveryTranscript],
    @"root" : [self recoveryRoot] } error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(round.receivedRecoveryRequest[@"expected_round_revision"], @4);
  XCTAssertEqualObjects(result[@"status"], @"resumed");
  XCTAssertEqualObjects(result[@"next_action"], @"persist_final");
  XCTAssertEqualObjects(result[@"completed_round"], completed);
}

- (void)testRetryFailedRoundUsesSameLineageAndLaunchAttemptPlusOne {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"round-retry"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"16161616-1616-4616-8616-161616161616";
      } faultHook:nil];
  NSDictionary *locator = @{ @"schema_version" : @2,
    @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"round_id" : @"77777777-7777-4777-8777-777777777777",
    @"round_index" : @0 };
  wal.recoveryState = @{ @"ledger" : @[], @"batches" : @[],
    @"operations" : @[], @"operation_results" : @[],
    @"rounds" : @[@{ @"locator" : locator, @"state" : @"failed_retryable",
                       @"row_revision" : @4, @"launch_attempt" : @1 }] };
  DSHRecordingRoundRecoveryService *round = nil;
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:&round
          executionService:nullptr];
  round.recoveryResult = @{ @"schema_version" : @2,
    @"status" : @"failed_retryable", @"result_round_revision" : @4 };
  round.retryResult = @{ @"schema_version" : @2,
    @"status" : @"failed_retryable", @"result_round_revision" : @5 };
  NSError *error = nil;
  NSDictionary *result = [coordinator recoverAgentAttempt:@{
    @"schema_version" : @2,
    @"operation_id" : @"17171717-1717-4717-8717-171717171717",
    @"controller_cas" : [self recoveryControllerCAS],
    @"committed_checkpoint" : [self recoveryCheckpoint],
    @"target" : @{ @"schema_version" : @2, @"kind" : @"round",
      @"task_id" : locator[@"task_id"], @"attempt_id" : locator[@"attempt_id"],
      @"round_id" : locator[@"round_id"], @"round_index" : @0 },
    @"action" : @"retry_failed_round", @"expected_round_revision" : @4,
    @"expected_execution_revision" : NSNull.null,
    @"expected_transcript" : [self recoveryTranscript],
    @"root" : [self recoveryRoot] } error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(round.receivedRetryRequest[@"round_id"],
                        locator[@"round_id"]);
  XCTAssertEqualObjects(round.receivedRetryRequest[@"launch_attempt"], @2);
  XCTAssertEqualObjects(round.receivedRetryRequest[@"expected_round_revision"], @4);
  XCTAssertEqualObjects(result[@"status"], @"retryable");
  XCTAssertEqualObjects(result[@"next_action"], @"retry_same_round");
}

- (void)testToolRecoveryCallsExecutionServiceWithFrozenBatchFacts {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"tool-recovery"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"99999999-9999-4999-8999-999999999999";
      } faultHook:nil];
  NSString *key = @"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  NSDictionary *locator = @{ @"schema_version" : @2,
    @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"round_id" : @"77777777-7777-4777-8777-777777777777",
    @"round_index" : @0, @"call_index" : @0, @"call_id" : @"call-0",
    @"idempotency_key" : key };
  NSDictionary *batch = @{ @"task_id" : locator[@"task_id"],
    @"attempt_id" : locator[@"attempt_id"], @"round_id" : locator[@"round_id"],
    @"round_index" : @0, @"kind" : @"read_only_batch", @"batch_revision" : @1,
    @"manifest_sha256" : NSNull.null };
  wal.recoveryState = @{ @"ledger" : @[@{ @"locator" : locator,
      @"row_revision" : @2,
      @"name" : @"read_file", @"arguments_sha256" :
          @"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
    @"batches" : @[batch], @"operation_results" : @[@{
      @"result" : @{ @"result_kind" : @"prepare_agent_tool_batch",
        @"result" : @{ @"receipt" : @{
        @"task_id" : locator[@"task_id"], @"attempt_id" : locator[@"attempt_id"],
        @"round_id" : locator[@"round_id"], @"batch_revision" : @1,
        @"calls" : @[@{ @"call_index" : @0, @"call_id" : @"call-0",
                          @"approval_reference" : NSNull.null }] } } } } ] };
  DSHRecordingToolRecoveryService *execution = nil;
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:&execution];
  execution.recoveryResult = @{ @"schema_version" : @2,
                                 @"status" : @"completed" };
  NSString *recoverOperationId = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  NSError *error = nil;
  NSDictionary *result = [coordinator recoverAgentAttempt:@{
    @"schema_version" : @2,
    @"operation_id" : recoverOperationId,
    @"controller_cas" : [self recoveryControllerCAS],
    @"committed_checkpoint" : [self recoveryCheckpoint],
    @"target" : @{ @"schema_version" : @2, @"kind" : @"tool",
      @"task_id" : locator[@"task_id"], @"attempt_id" : locator[@"attempt_id"],
      @"round_id" : locator[@"round_id"], @"round_index" : @0,
      @"call_index" : @0, @"call_id" : @"call-0", @"idempotency_key" : key },
    @"action" : @"reconcile", @"expected_round_revision" : NSNull.null,
    @"expected_execution_revision" : @2,
    @"expected_transcript" : [self recoveryTranscript],
    @"root" : [self recoveryRoot] } error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(execution.receivedRecoveryRequest[@"name"], @"read_file");
  XCTAssertEqualObjects(execution.receivedRecoveryRequest[@"batch_kind"],
                        @"read_only_batch");
  XCTAssertEqualObjects(execution.receivedRecoveryRequest
      [@"expected_execution_revision"], @2);
  XCTAssertNotEqualObjects(execution.receivedRecoveryRequest[@"operation_id"],
                           recoverOperationId);
  XCTAssertEqualObjects(result[@"status"], @"resumed");
  XCTAssertEqualObjects(result[@"next_action"], @"persist_tool_result");
  XCTAssertEqualObjects(result[@"completed_round"], NSNull.null);
  NSPredicate *toolOperations = [NSPredicate predicateWithBlock:
      ^BOOL(NSDictionary *operation, NSDictionary *bindings) {
    (void)bindings;
    return [operation[@"operation_kind"] isEqualToString:@"execute_agent_tool"];
  }];
  NSArray *children = [wal.recoveryState[@"operations"]
      filteredArrayUsingPredicate:toolOperations];
  XCTAssertEqual(children.count, 1U);
  XCTAssertEqualObjects(children[0][@"state"], @"committed");
}

- (void)testCancelAttemptCommitsAndReplaysOneImmutableOperation {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"cancel-replay"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      } faultHook:nil];
  wal.recoveryState = @{ @"ledger" : @[], @"rounds" : @[], @"batches" : @[],
    @"operations" : @[], @"operation_results" : @[] };
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  NSDictionary *request = [self recoveryCancelRequestWithOperationId:
      @"cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
  NSError *error = nil;
  NSDictionary *first = [coordinator cancelAgentAttempt:request error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(first[@"status"], @"unknown");
  DSHRecoverySessionStore *sessionStore =
      (DSHRecoverySessionStore *)coordinator.preparedStore.sessionSnapshotStore;
  sessionStore.recoveryLoad = @{ @"status" : @"missing" };
  NSDictionary *replay = [coordinator cancelAgentAttempt:request error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(replay, first);
  XCTAssertEqual([wal.recoveryState[@"operations"] count], 1U);
  XCTAssertEqual([wal.recoveryState[@"operation_results"] count], 1U);
}

- (void)testCancelAttemptRejectsUnboundSchemaNineSourceProofs {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"cancel-source-proof"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"23232323-2323-4323-8323-232323232323";
      } faultHook:nil];
  wal.recoveryState = @{ @"ledger" : @[], @"rounds" : @[], @"batches" : @[],
    @"operations" : @[], @"operation_results" : @[] };
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  NSArray<NSString *> *operationIds = @[
    @"24242424-2424-4424-8424-242424242424",
    @"25252525-2525-4525-8525-252525252525",
    @"26262626-2626-4626-8626-262626262626",
    @"27272727-2727-4727-8727-272727272727",
  ];
  for (NSUInteger index = 0; index < operationIds.count; index += 1) {
    NSMutableDictionary *request = [[self
        recoveryCancelRequestWithOperationId:operationIds[index]] mutableCopy];
    NSMutableDictionary *token = [request[@"cancel_token"] mutableCopy];
    if (index == 0) {
      token[@"source_event_id"] = @"28282828-2828-4828-8828-282828282828";
      token[@"token"] = token[@"source_event_id"];
    } else if (index == 1) {
      token[@"expected_phase"] = @"approval_pending";
    } else if (index == 2) {
      token[@"reason_code"] = @"E_AGENT_ROOT_STALE";
    } else {
      request[@"target"] = @{ @"schema_version" : @2, @"kind" : @"round",
        @"task_id" : token[@"task_id"], @"attempt_id" : token[@"attempt_id"],
        @"round_id" : @"77777777-7777-4777-8777-777777777777",
        @"round_index" : @0 };
      request[@"expected_round_revision"] = @1;
    }
    request[@"cancel_token"] = [token copy];
    NSError *error = nil;
    NSDictionary *result = [coordinator cancelAgentAttempt:[request copy]
                                                       error:&error];
    XCTAssertNil(error);
    XCTAssertEqualObjects(result[@"status"], @"conflict");
    XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_CANCELLED");
    XCTAssertEqual([wal.recoveryState[@"operations"] count], 0U);
  }
}

- (void)testQueriesUseActualSessionControllerAndExactRootExpectation {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"query-proof"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"ffffffff-ffff-4fff-8fff-ffffffffffff";
      } faultHook:nil];
  wal.recoveryState = @{ @"rounds" : @[], @"batches" : @[],
    @"authorities" : @[], @"ledger" : @[], @"operations" : @[],
    @"operation_results" : @[] };
  DSHRecoveryRuntimeCoordinator *fixture =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  DSHRecordingQueryLedger *queryLedger = [[DSHRecordingQueryLedger alloc]
      initWithWAL:wal];
  NSDictionary *locator = [self recoveryToolLocator];
  queryLedger.queryResult = @{ @"status" : @"intent", @"row" : @{
    @"locator" : locator, @"row_revision" : @2, @"name" : @"read_file",
    @"arguments_sha256" :
        @"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    @"state" : @"intent", @"transcript_before" : [self recoveryTranscript],
    @"transcript_after" : NSNull.null, @"receipt" : NSNull.null } };
  DSHAgentRuntimeCoordinator *coordinator = [[DSHAgentRuntimeCoordinator alloc]
      initForRecoveryTestingWithWAL:wal preparedStore:fixture.preparedStore
      roundService:fixture.roundService executionService:fixture.executionService
      transcripts:fixture.transcripts ledger:queryLedger];
  NSError *error = nil;
  NSDictionary *attemptResult = [coordinator queryAgentAttempt:@{
    @"schema_version" : @2, @"controller_cas" : [self recoveryControllerCAS],
    @"task_id" : locator[@"task_id"],
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : locator[@"attempt_id"], @"expected_journal_revision" : @1,
    @"expected_session_generation" : @1, @"expected_session_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    @"expected_transcript" : [self recoveryTranscript],
    @"expected_root_fingerprint_sha256" : [self recoveryRoot][@"root_fingerprint_sha256"],
    @"expected_workspace_binding_revision" : @1 } error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(attemptResult[@"attempt"][@"controller_generation"], @1);

  NSDictionary *toolResult = [coordinator queryAgentTool:@{
    @"schema_version" : @2, @"controller_cas" : [self recoveryControllerCAS],
    @"task_id" : locator[@"task_id"],
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : locator[@"attempt_id"], @"round_id" : locator[@"round_id"],
    @"round_index" : @0, @"call_index" : @0, @"call_id" : @"call-0",
    @"idempotency_key" : locator[@"idempotency_key"],
    @"expected_execution_revision" : @2,
    @"expected_transcript" : [self recoveryTranscript],
    @"expected_root_fingerprint_sha256" : [self recoveryRoot][@"root_fingerprint_sha256"],
    @"expected_workspace_binding_revision" : @1 } error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(toolResult[@"status"], @"intent");
  XCTAssertEqualObjects(queryLedger.receivedRootExpectation, (@{
    @"schema_version" : @1,
    @"root_fingerprint_sha256" : [self recoveryRoot][@"root_fingerprint_sha256"],
    @"binding_revision" : @1 }));

  DSHRecoverySessionStore *sessionStore =
      (DSHRecoverySessionStore *)fixture.preparedStore.sessionSnapshotStore;
  NSMutableDictionary *load = [sessionStore.recoveryLoad mutableCopy];
  NSDictionary *changedSession = @{ @"schema_version" : @9,
    @"conversations" : @[@{
    @"id" : @"11111111-1111-4111-8111-111111111111",
    @"attempts" : @[@{ @"attempt_id" : locator[@"attempt_id"],
      @"turn_id" : locator[@"task_id"], @"journal_revision" : @1,
      @"agent" : @{ @"controller_generation" : @2 } }] }],
    @"session_events" : @[] };
  load[@"session_json"] = [[NSString alloc] initWithData:
      [NSJSONSerialization dataWithJSONObject:changedSession
          options:NSJSONWritingSortedKeys error:nil]
      encoding:NSUTF8StringEncoding];
  sessionStore.recoveryLoad = load;
  NSDictionary *conflict = [coordinator queryAgentAttempt:@{
    @"schema_version" : @2, @"controller_cas" : [self recoveryControllerCAS],
    @"task_id" : locator[@"task_id"],
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : locator[@"attempt_id"], @"expected_journal_revision" : @1,
    @"expected_session_generation" : @1, @"expected_session_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    @"expected_transcript" : [self recoveryTranscript],
    @"expected_root_fingerprint_sha256" : [self recoveryRoot][@"root_fingerprint_sha256"],
    @"expected_workspace_binding_revision" : @1 } error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(conflict[@"status"], @"conflict");
}

- (void)testQueryToolPositiveRevisionAbsentReturnsClosedConflict {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"query-absent"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"29292929-2929-4929-8929-292929292929";
      } faultHook:nil];
  wal.recoveryState = @{ @"rounds" : @[], @"batches" : @[],
    @"authorities" : @[], @"ledger" : @[], @"operations" : @[],
    @"operation_results" : @[] };
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  NSError *error = nil;
  NSDictionary *positive = [coordinator queryAgentTool:
      [self recoveryQueryToolRequestWithRevision:@2] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(positive[@"status"], @"conflict");
  XCTAssertEqualObjects(positive[@"failure_code"], @"E_AGENT_CONFLICT");
  XCTAssertEqualObjects(positive[@"expected_execution_revision"], @2);
  XCTAssertEqualObjects(positive[@"actual_execution_revision"], @0);

  NSDictionary *zero = [coordinator queryAgentTool:
      [self recoveryQueryToolRequestWithRevision:@0] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(zero, (@{ @"schema_version" : @2,
                                  @"status" : @"not_started" }));
}

- (void)testQueryToolLedgerCASMismatchReturnsClosedConflict {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"query-cas"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"30303030-3030-4030-8030-303030303030";
      } faultHook:nil];
  NSDictionary *locator = [self recoveryToolLocator];
  wal.recoveryState = @{ @"rounds" : @[], @"batches" : @[],
    @"authorities" : @[], @"operations" : @[], @"operation_results" : @[],
    @"ledger" : @[@{ @"locator" : locator, @"row_revision" : @3,
      @"root_fingerprint_sha256" :
          @"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      @"binding_revision" : @1,
      @"transcript_before" : [self recoveryTranscript] }] };
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  NSError *error = nil;
  NSDictionary *rootConflict = [coordinator queryAgentTool:
      [self recoveryQueryToolRequestWithRevision:@3] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(rootConflict[@"status"], @"conflict");
  XCTAssertEqualObjects(rootConflict[@"failure_code"], @"E_AGENT_ROOT_STALE");
  XCTAssertEqualObjects(rootConflict[@"actual_execution_revision"], @3);

  NSMutableDictionary *wrongTranscript = [[self recoveryTranscript] mutableCopy];
  wrongTranscript[@"transcript_sha256"] =
      @"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  NSMutableDictionary *state = [wal.recoveryState mutableCopy];
  state[@"ledger"] = @[@{ @"locator" : locator, @"row_revision" : @4,
    @"root_fingerprint_sha256" : [self recoveryRoot][@"root_fingerprint_sha256"],
    @"binding_revision" : @1,
    @"transcript_before" : [wrongTranscript copy] }];
  wal.recoveryState = [state copy];
  NSDictionary *transcriptConflict = [coordinator queryAgentTool:
      [self recoveryQueryToolRequestWithRevision:@4] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(transcriptConflict[@"status"], @"conflict");
  XCTAssertEqualObjects(transcriptConflict[@"failure_code"],
                        @"E_AGENT_TRANSCRIPT");
  XCTAssertEqualObjects(transcriptConflict[@"actual_execution_revision"], @4);
}

- (void)testQueryAttemptRootConflictUsesActualSessionRevision {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"query-attempt-root"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      } faultHook:nil];
  wal.recoveryState = @{ @"rounds" : @[], @"batches" : @[],
    @"authorities" : @[], @"ledger" : @[], @"operations" : @[],
    @"operation_results" : @[] };
  DSHRecoveryRuntimeCoordinator *fixture =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  DSHAgentRuntimeCoordinator *coordinator = [[DSHAgentRuntimeCoordinator alloc]
      initForRecoveryTestingWithWAL:wal preparedStore:fixture.preparedStore
      roundService:fixture.roundService executionService:fixture.executionService
      transcripts:fixture.transcripts ledger:fixture.ledger];
  DSHRecoveryPreparedStore *prepared =
      (DSHRecoveryPreparedStore *)coordinator.preparedStore;
  NSMutableDictionary *projection = [prepared.preparedProjection mutableCopy];
  NSMutableDictionary *wrongRoot = [[self recoveryRoot] mutableCopy];
  wrongRoot[@"root_fingerprint_sha256"] =
      @"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  projection[@"root"] = [wrongRoot copy];
  projection[@"journal_revision"] = @99;
  prepared.preparedProjection = [projection copy];

  NSError *error = nil;
  NSDictionary *result = [coordinator queryAgentAttempt:
      [self recoveryQueryAttemptRequest] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"conflict");
  XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_ROOT_STALE");
  XCTAssertEqualObjects(result[@"expected_journal_revision"], @1);
  XCTAssertEqualObjects(result[@"actual_journal_revision"], @1);
  XCTAssertEqualObjects(result[@"actual_session_generation"], @1);
}

- (void)testFinalizeAndDiscardAtomicallyTransitionAndPreserveReplayEvidence {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"finalize-discard"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"12121212-1212-4212-8212-121212121212";
      } faultHook:nil];
  NSDictionary *authority = @{ @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"root" : [self recoveryRoot], @"transcript" : [self recoveryTranscript],
    @"state" : @"prepared", @"cleanup_id" : NSNull.null,
    @"authority_revision" : @1, @"updated_at" : @"2026-08-31T00:00:00.000Z" };
  NSDictionary *transcriptRow = @{
    @"transcript_ref" : [self recoveryTranscript][@"transcript_ref"],
    @"attempt_id" : authority[@"attempt_id"],
    @"transcript_sha256" : [self recoveryTranscript][@"transcript_sha256"],
    @"state" : @"open", @"retention_until" : NSNull.null,
    @"updated_at" : @"2026-08-31T00:00:00.000Z" };
  wal.recoveryState = @{ @"authorities" : @[authority],
    @"transcripts" : @[transcriptRow], @"cleanup" : @[], @"rounds" : @[],
    @"ledger" : @[], @"reservations" : @[], @"batches" : @[],
    @"denied_calls" : @[], @"dispatch" : @[], @"operations" : @[],
    @"operation_results" : @[] };
  DSHRecoveryRuntimeCoordinator *fixture =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  DSHAgentRuntimeCoordinator *coordinator = [[DSHAgentRuntimeCoordinator alloc]
      initForRecoveryTestingWithWAL:wal preparedStore:fixture.preparedStore
      roundService:fixture.roundService executionService:fixture.executionService
      transcripts:fixture.transcripts ledger:fixture.ledger];
  NSString *cleanupId = @"13131313-1313-4313-8313-131313131313";
  NSDictionary *finalizeRequest = @{ @"schema_version" : @2,
    @"operation_id" : @"14141414-1414-4414-8414-141414141414",
    @"controller_cas" : [self recoveryControllerCAS],
    @"committed_checkpoint" : [self recoveryCheckpoint],
    @"task_id" : authority[@"task_id"],
    @"conversation_id" : authority[@"conversation_id"],
    @"attempt_id" : authority[@"attempt_id"], @"terminal_reason" : @"completed",
    @"cleanup_id" : cleanupId, @"transcript" : [self recoveryTranscript],
    @"root" : [self recoveryRoot] };
  NSError *error = nil;
  NSDictionary *finalized = [coordinator finalizeAgentAttempt:finalizeRequest
                                                          error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(finalized[@"status"], @"terminal");
  XCTAssertEqualObjects(wal.recoveryState[@"authorities"][0][@"state"],
                        @"cleanup_pending");
  XCTAssertEqualObjects(wal.recoveryState[@"cleanup"][0][@"status"], @"pending");
  XCTAssertEqual([wal.recoveryState[@"operations"] count], 1U);
  NSNumber *terminalRevision =
      wal.recoveryState[@"authorities"][0][@"authority_revision"];
  DSHRecoveryPreparedStore *prepared =
      (DSHRecoveryPreparedStore *)fixture.preparedStore;
  prepared.recoveryAuthority = wal.recoveryState[@"authorities"][0];
  NSMutableDictionary *secondFinalizeRequest = [finalizeRequest mutableCopy];
  secondFinalizeRequest[@"operation_id"] =
      @"18181818-1818-4818-8818-181818181818";
  NSDictionary *alreadyTerminal = [coordinator
      finalizeAgentAttempt:[secondFinalizeRequest copy] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(alreadyTerminal[@"status"], @"already_terminal");
  XCTAssertEqualObjects(
      wal.recoveryState[@"authorities"][0][@"authority_revision"],
      terminalRevision);
  XCTAssertEqual([wal.recoveryState[@"operations"] count], 2U);

  NSDictionary *discardRequest = @{ @"schema_version" : @2,
    @"operation_id" : @"15151515-1515-4515-8515-151515151515",
    @"cleanup_id" : cleanupId, @"task_id" : authority[@"task_id"],
    @"conversation_id" : authority[@"conversation_id"],
    @"attempt_id" : authority[@"attempt_id"],
    @"transcript_ref" : [self recoveryTranscript][@"transcript_ref"],
    @"transcript_sha256" : [self recoveryTranscript][@"transcript_sha256"] };
  NSDictionary *discarded = [coordinator discardAgentAttempt:discardRequest
                                                        error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(discarded[@"status"], @"discarded");
  XCTAssertEqual([wal.recoveryState[@"authorities"] count], 0U);
  XCTAssertEqual([wal.recoveryState[@"transcripts"] count], 0U);
  XCTAssertEqualObjects(wal.recoveryState[@"cleanup"][0][@"status"],
                        @"discarded");
  XCTAssertEqual([wal.recoveryState[@"operations"] count], 1U);
  XCTAssertEqualObjects(wal.recoveryState[@"operations"][0][@"operation_id"],
                        discardRequest[@"operation_id"]);
  NSDictionary *replay = [coordinator discardAgentAttempt:discardRequest
                                                     error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(replay, discarded);

  NSMutableDictionary *missingRequest = [discardRequest mutableCopy];
  missingRequest[@"operation_id"] =
      @"19191919-1919-4919-8919-191919191919";
  NSDictionary *alreadyMissing = [coordinator
      discardAgentAttempt:[missingRequest copy] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(alreadyMissing[@"status"], @"already_missing");
  XCTAssertEqual([wal.recoveryState[@"operations"] count], 2U);
  NSDictionary *missingReplay = [coordinator
      discardAgentAttempt:[missingRequest copy] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(missingReplay, alreadyMissing);
}

- (void)testDiscardAlreadyMissingWithMissingSessionFailsClosedWithoutException {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"discard-missing-session"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"31313131-3131-4131-8131-313131313131";
      } faultHook:nil];
  NSDictionary *cleanup = @{ @"schema_version" : @1,
    @"cleanup_id" : @"13131313-1313-4313-8313-131313131313",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"transcript_ref" : [self recoveryTranscript][@"transcript_ref"],
    @"transcript_sha256" : [self recoveryTranscript][@"transcript_sha256"],
    @"cleanup_owner" : @"22222222-2222-4222-8222-222222222222",
    @"reason" : @"completed", @"created_at" : @"2026-08-31T00:00:00.000Z",
    @"status" : @"discarded" };
  wal.recoveryState = @{ @"authorities" : @[], @"cleanup" : @[cleanup],
    @"transcripts" : @[], @"rounds" : @[], @"ledger" : @[],
    @"reservations" : @[], @"batches" : @[], @"denied_calls" : @[],
    @"dispatch" : @[], @"operations" : @[], @"operation_results" : @[] };
  DSHRecoveryRuntimeCoordinator *coordinator =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  DSHRecoverySessionStore *sessionStore =
      (DSHRecoverySessionStore *)coordinator.preparedStore.sessionSnapshotStore;
  sessionStore.recoveryLoad = @{ @"status" : @"missing",
                                 @"session_json" : NSNull.null };
  NSError *error = nil;
  NSDictionary *result = [coordinator discardAgentAttempt:@{
    @"schema_version" : @2,
    @"operation_id" : @"32323232-3232-4232-8232-323232323232",
    @"cleanup_id" : cleanup[@"cleanup_id"],
    @"task_id" : cleanup[@"cleanup_owner"],
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : cleanup[@"attempt_id"],
    @"transcript_ref" : cleanup[@"transcript_ref"],
    @"transcript_sha256" : cleanup[@"transcript_sha256"]
  } error:&error];
  XCTAssertNil(result);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorConflict);
  XCTAssertEqual([wal.recoveryState[@"operations"] count], 0U);
}

- (void)testDiscardRejectsAndPreservesUnresolvedOperationEvidence {
  DSHRecoveryWAL *wal = [[DSHRecoveryWAL alloc]
      initWithRootURL:[self.rootURL URLByAppendingPathComponent:@"discard-unresolved"]
      clock:^NSDate * { return NSDate.date; }
      identifierGenerator:^NSString * {
        return @"20202020-2020-4020-8020-202020202020";
      } faultHook:nil];
  NSDictionary *authority = @{ @"task_id" : @"22222222-2222-4222-8222-222222222222",
    @"conversation_id" : @"11111111-1111-4111-8111-111111111111",
    @"attempt_id" : @"33333333-3333-4333-8333-333333333333",
    @"root" : [self recoveryRoot], @"transcript" : [self recoveryTranscript],
    @"state" : @"cleanup_pending",
    @"cleanup_id" : @"13131313-1313-4313-8313-131313131313",
    @"authority_revision" : @2 };
  NSDictionary *cleanup = @{ @"schema_version" : @1,
    @"cleanup_id" : authority[@"cleanup_id"],
    @"attempt_id" : authority[@"attempt_id"],
    @"transcript_ref" : [self recoveryTranscript][@"transcript_ref"],
    @"transcript_sha256" : [self recoveryTranscript][@"transcript_sha256"],
    @"cleanup_owner" : authority[@"task_id"], @"reason" : @"completed",
    @"created_at" : @"2026-08-31T00:00:00.000Z", @"status" : @"pending" };
  NSString *unresolvedId = @"21212121-2121-4121-8121-212121212121";
  wal.recoveryState = @{ @"authorities" : @[authority], @"cleanup" : @[cleanup],
    @"transcripts" : @[@{ @"attempt_id" : authority[@"attempt_id"],
      @"transcript_ref" : [self recoveryTranscript][@"transcript_ref"],
      @"transcript_sha256" : [self recoveryTranscript][@"transcript_sha256"],
      @"state" : @"terminal" }],
    @"rounds" : @[], @"ledger" : @[], @"reservations" : @[], @"batches" : @[],
    @"denied_calls" : @[], @"dispatch" : @[],
    @"operations" : @[@{ @"operation_id" : unresolvedId,
      @"attempt_id" : authority[@"attempt_id"], @"state" : @"unknown" }],
    @"operation_results" : @[@{ @"operation_id" : unresolvedId,
      @"marker" : @"must-survive" }] };
  DSHRecoveryRuntimeCoordinator *fixture =
      [self recoveryCoordinatorWithWAL:wal roundService:nullptr
          executionService:nullptr];
  NSError *error = nil;
  NSDictionary *result = [fixture discardAgentAttempt:@{
    @"schema_version" : @2,
    @"operation_id" : @"22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"cleanup_id" : authority[@"cleanup_id"], @"task_id" : authority[@"task_id"],
    @"conversation_id" : authority[@"conversation_id"],
    @"attempt_id" : authority[@"attempt_id"],
    @"transcript_ref" : [self recoveryTranscript][@"transcript_ref"],
    @"transcript_sha256" : [self recoveryTranscript][@"transcript_sha256"]
  } error:&error];
  XCTAssertNil(result);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorConflict);
  NSPredicate *unresolved = [NSPredicate predicateWithBlock:
      ^BOOL(NSDictionary *operation, NSDictionary *bindings) {
    (void)bindings;
    return [operation[@"operation_id"] isEqual:unresolvedId];
  }];
  XCTAssertEqual([wal.recoveryState[@"operations"]
      filteredArrayUsingPredicate:unresolved].count, 1U);
  XCTAssertEqualObjects(wal.recoveryState[@"operation_results"][0][@"marker"],
                        @"must-survive");
  XCTAssertEqual([wal.recoveryState[@"authorities"] count], 1U);
}

@end
