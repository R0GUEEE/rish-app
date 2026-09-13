#import "RishGuestCgiFeature.h"
#import "AgentToolExecutionService.h"

#import "AgentExecutionLedger.h"
#import "AgentGitToolExecutor.h"
#import "AgentNativeWAL.h"
#import "AgentPreparedAttemptStore.h"
#import "AgentTranscriptStore.h"
#import "AgentWorkspaceToolExecutor.h"
#import "DSHAgentGuestCgiToolExecutor.h"
#import "DSHGitPushSupport.h"

static const unsigned long long DSHAgentExecutionMaximumSafeInteger =
    9007199254740991ULL;

/// Stable in-memory key for the cancellation token of one execution row.
static NSString *DSHAgentExecutionLocatorKey(NSDictionary *locator) {
  if (![locator isKindOfClass:NSDictionary.class]) return @"";
  return [NSString stringWithFormat:@"%@|%@|%@|%@|%@|%@",
      locator[@"task_id"], locator[@"attempt_id"], locator[@"round_id"],
      locator[@"round_index"], locator[@"call_index"], locator[@"call_id"]];
}

static BOOL DSHAgentExecutionRoot(NSDictionary *root) {
  return DSHAgentExactDictionaryKeys(root, @[
    @"schema_version", @"kind", @"workspace_id",
    @"workspace_binding_revision", @"project_id",
    @"root_fingerprint_sha256", @"capabilities",
  ]) && [root[@"schema_version"] isEqual:@1] &&
      DSHAgentCanonicalUUID(root[@"workspace_id"]) &&
      DSHAgentSafeInteger(root[@"workspace_binding_revision"],
                          DSHAgentExecutionMaximumSafeInteger, NO) &&
      DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) &&
      [root[@"capabilities"] isKindOfClass:NSArray.class];
}

static BOOL DSHAgentExecutionTranscript(NSDictionary *value) {
  return DSHAgentExactDictionaryKeys(value, @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ]) && [value[@"schema_version"] isEqual:@1] &&
      DSHAgentCanonicalUUID(value[@"transcript_ref"]) &&
      DSHAgentSafeInteger(value[@"generation"],
                          DSHAgentExecutionMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(value[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(value[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

static BOOL DSHAgentExecutionControllerCAS(NSDictionary *cas) {
  return DSHAgentExactDictionaryKeys(cas, @[
    @"schema_version", @"conversation_id", @"task_id", @"attempt_id",
    @"expected_controller_generation", @"expected_journal_revision",
    @"expected_session_generation", @"expected_session_sha256",
  ]) && [cas[@"schema_version"] isEqual:@1] &&
      DSHAgentCanonicalUUID(cas[@"conversation_id"]) &&
      DSHAgentCanonicalUUID(cas[@"task_id"]) &&
      DSHAgentCanonicalUUID(cas[@"attempt_id"]) &&
      DSHAgentSafeInteger(cas[@"expected_controller_generation"],
                          DSHAgentExecutionMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_journal_revision"],
                          DSHAgentExecutionMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_session_generation"],
                          DSHAgentExecutionMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(cas[@"expected_session_sha256"]);
}

static BOOL DSHAgentExecutionCheckpoint(NSDictionary *checkpoint) {
  return DSHAgentExactDictionaryKeys(checkpoint, @[
    @"schema_version", @"journal_revision", @"session_generation",
    @"session_sha256",
  ]) && [checkpoint[@"schema_version"] isEqual:@1] &&
      DSHAgentSafeInteger(checkpoint[@"journal_revision"],
                          DSHAgentExecutionMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(checkpoint[@"session_generation"],
                          DSHAgentExecutionMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(checkpoint[@"session_sha256"]);
}

static BOOL DSHAgentExecutionValidateCommittedSession(
    DSHAgentPreparedAttemptStore *preparedStore,
    NSDictionary *request,
    BOOL requireExecutionIntent,
    NSError **error) {
  NSDictionary *loaded = [preparedStore.sessionSnapshotStore
      loadSessionSnapshotWithError:error];
  NSDictionary *expected = request[@"committed_checkpoint"];
  if (![loaded[@"status"] isEqualToString:@"present"] ||
      ![loaded[@"snapshot"][@"generation"]
          isEqual:expected[@"session_generation"]] ||
      ![loaded[@"snapshot"][@"session_sha256"]
          isEqual:expected[@"session_sha256"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSData *bytes = [loaded[@"session_json"] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *session = bytes == nil ? nil
      : [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  NSDictionary *persistedCall = nil;
  NSDictionary *persistedAgent = nil;
  for (NSDictionary *conversation in session[@"conversations"]) {
    if (![(conversation[@"id"] ?: conversation[@"conversation_id"])
            isEqual:request[@"conversation_id"]]) continue;
    for (NSDictionary *attempt in conversation[@"attempts"]) {
      if (![attempt[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
          ![attempt[@"journal_revision"]
              isEqual:expected[@"journal_revision"]]) continue;
      NSDictionary *agent = attempt[@"agent"];
      if (![agent[@"round_lineage"][@"round_id"] isEqual:request[@"round_id"]] ||
          ![agent[@"round_lineage"][@"round_index"]
              isEqual:request[@"round_index"]] ||
          ![agent[@"root"] isEqual:request[@"root"]] ||
          ![agent[@"transcript"] isEqual:request[@"transcript"]]) continue;
      for (NSDictionary *call in agent[@"batch"]) {
        if ([call[@"call_index"] isEqual:request[@"call_index"]] &&
            [call[@"call_id"] isEqual:request[@"call_id"]]) {
          persistedCall = call;
          persistedAgent = agent;
          break;
        }
      }
    }
  }
  if (persistedCall == nil ||
      (requireExecutionIntent &&
       ![persistedAgent[@"phase"] isEqualToString:@"execution_intent"]) ||
      ![persistedCall[@"name"] isEqual:request[@"name"]] ||
      ![persistedCall[@"arguments_sha256"]
          isEqual:request[@"arguments_sha256"]] ||
      ![persistedCall[@"idempotency_key"]
          isEqual:request[@"idempotency_key"]] ||
      ![persistedCall[@"native_row_revision"]
          isEqual:request[@"expected_execution_revision"]] ||
      ![persistedCall[@"approval_reference"]
          isEqual:request[@"approval_reference"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

static NSDictionary *DSHAgentExecutionBatch(NSDictionary *state,
                                             NSDictionary *request) {
  for (NSDictionary *batch in state[@"batches"]) {
    if ([batch[@"task_id"] isEqual:request[@"task_id"]] &&
        [batch[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
        [batch[@"round_id"] isEqual:request[@"round_id"]] &&
        [batch[@"round_index"] isEqual:request[@"round_index"]] &&
        [batch[@"batch_revision"] isEqual:request[@"expected_batch_revision"]]) {
      return batch;
    }
  }
  return nil;
}

static NSDictionary *DSHAgentExecutionRow(NSDictionary *state,
                                           NSDictionary *request) {
  for (NSDictionary *row in state[@"ledger"]) {
    NSDictionary *locator = row[@"locator"];
    if ([locator[@"task_id"] isEqual:request[@"task_id"]] &&
        [locator[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
        [locator[@"round_id"] isEqual:request[@"round_id"]] &&
        [locator[@"round_index"] isEqual:request[@"round_index"]] &&
        [locator[@"call_index"] isEqual:request[@"call_index"]] &&
        [locator[@"call_id"] isEqual:request[@"call_id"]] &&
        [locator[@"idempotency_key"] isEqual:request[@"idempotency_key"]]) {
      return row;
    }
  }
  return nil;
}

static NSDictionary *DSHAgentExecutionRawCall(NSArray *messages,
                                               NSDictionary *request) {
  for (NSDictionary *message in messages) {
    if (![message[@"role"] isEqualToString:@"assistant"] ||
        ![message[@"round_index"] isEqual:request[@"round_index"]]) continue;
    for (NSDictionary *call in message[@"tool_calls"]) {
      if ([call[@"call_id"] isEqual:request[@"call_id"]] &&
          [call[@"name"] isEqual:request[@"name"]]) return call;
    }
  }
  return nil;
}

static NSDictionary *DSHAgentExecutionPreparedProjection(NSDictionary *state,
                                                          NSDictionary *request) {
  for (NSDictionary *snapshot in state[@"operation_results"]) {
    // Results are a tagged union. In particular, an allowed approval carries
    // receipt:NSNull; scanning a later batch must not treat it as a batch
    // receipt (or depend on finding this batch before that approval row).
    NSDictionary *wrapper = snapshot[@"result"];
    if (![snapshot[@"operation_kind"] isEqualToString:@"prepare_agent_tool_batch"] ||
        ![wrapper[@"result_kind"] isEqualToString:@"prepare_agent_tool_batch"]) continue;
    NSDictionary *result = wrapper[@"result"];
    if (![result[@"status"] isEqualToString:@"prepared"]) continue;
    NSDictionary *receipt = result[@"receipt"];
    if (![receipt isKindOfClass:NSDictionary.class]) continue;
    if (![receipt[@"task_id"] isEqual:request[@"task_id"]] ||
        ![receipt[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
        ![receipt[@"round_id"] isEqual:request[@"round_id"]] ||
        ![receipt[@"round_index"] isEqual:request[@"round_index"]] ||
        ![receipt[@"batch_revision"] isEqual:request[@"expected_batch_revision"]]) {
      continue;
    }
    for (NSDictionary *call in receipt[@"calls"]) {
      if ([call[@"call_index"] isEqual:request[@"call_index"]] &&
          [call[@"call_id"] isEqual:request[@"call_id"]] &&
          [call[@"idempotency_key"] isEqual:request[@"idempotency_key"]]) {
        return call;
      }
    }
  }
  return nil;
}

static BOOL DSHAgentExecutionApprovalBound(NSDictionary *state,
                                           NSDictionary *request) {
  if (request[@"approval_reference"] == NSNull.null) return NO;
  for (NSDictionary *snapshot in state[@"operation_results"]) {
    NSDictionary *result = snapshot[@"result"][@"result"];
    if (![result[@"status"] isEqualToString:@"bound"] ||
        ![result[@"task_id"] isEqual:request[@"task_id"]] ||
        ![result[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
        ![result[@"round_id"] isEqual:request[@"round_id"]] ||
        ![result[@"call_index"] isEqual:request[@"call_index"]] ||
        ![result[@"call_id"] isEqual:request[@"call_id"]] ||
        ![result[@"approval_reference"] isEqual:request[@"approval_reference"]]) {
      continue;
    }
    return [result[@"decision"] isEqualToString:@"allow_once"] ||
        [result[@"decision"] isEqualToString:@"allow_conversation"];
  }
  return NO;
}

static BOOL DSHAgentExecutionConversationGrantBound(
    DSHAgentPreparedAttemptStore *preparedStore,
    NSDictionary *request) {
  NSString *family = [request[@"name"] isEqualToString:@"write_file"]
      ? @"file_write" : ([request[@"name"] isEqualToString:@"git_commit"]
          ? @"git_commit" : ([request[@"name"] isEqualToString:@"git_push"]
              ? @"git_push" : ([request[@"name"] hasSuffix:@"_guest_cgi"] ? @"guest_service" : nil)));
  if (family == nil || request[@"approval_reference"] == NSNull.null) return NO;
  NSDictionary *loaded = [preparedStore.sessionSnapshotStore
      loadSessionSnapshotWithError:nil];
  NSDictionary *checkpoint = request[@"committed_checkpoint"];
  if (![loaded[@"status"] isEqualToString:@"present"] ||
      ![loaded[@"snapshot"][@"generation"]
          isEqual:checkpoint[@"session_generation"]] ||
      ![loaded[@"snapshot"][@"session_sha256"]
          isEqual:checkpoint[@"session_sha256"]]) return NO;
  NSData *bytes = [loaded[@"session_json"] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *session = bytes == nil ? nil
      : [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  NSDictionary *root = request[@"root"];
  for (NSDictionary *conversation in session[@"conversations"]) {
    if (![(conversation[@"id"] ?: conversation[@"conversation_id"])
            isEqual:request[@"conversation_id"]]) continue;
    for (NSDictionary *grant in conversation[@"agent_grants"]) {
      if ([grant[@"grant_id"] isEqual:request[@"approval_reference"]] &&
          [grant[@"conversation_id"] isEqual:request[@"conversation_id"]] &&
          [grant[@"workspace_id"] isEqual:root[@"workspace_id"]] &&
          [grant[@"project_id"] isEqual:root[@"project_id"]] &&
          [grant[@"binding_revision"]
              isEqual:root[@"workspace_binding_revision"]] &&
          [grant[@"root_fingerprint_sha256"]
              isEqual:root[@"root_fingerprint_sha256"]] &&
          [grant[@"tool_family"] isEqual:family] &&
          ([grant[@"registry_version"] isEqual:@1] || [grant[@"registry_version"] isEqual:@2]) &&
          (![family isEqual:@"guest_service"] || [grant[@"registry_version"] isEqual:@2]) &&
          [grant[@"policy_version"] isEqualToString:@"agent-v1"]) return YES;
    }
  }
  return NO;
}

static NSDictionary *DSHAgentExecutionCAS(NSDictionary *row,
                                           NSString *state) {
  id owner = row[@"owner"];
  return @{
    @"schema_version" : @2, @"locator" : row[@"locator"],
    @"expected_row_revision" : row[@"row_revision"], @"expected_state" : state,
    @"expected_owner_generation" : owner == NSNull.null
        ? NSNull.null : owner[@"owner_generation"],
    @"expected_launch_id" : owner == NSNull.null
        ? NSNull.null : owner[@"launch_id"],
    @"expected_native_task_id" : owner == NSNull.null
        ? NSNull.null : owner[@"native_task_id"],
    @"expected_transcript_generation" : row[@"transcript_before"][@"generation"],
    @"expected_transcript_sha256" : row[@"transcript_before"][@"transcript_sha256"],
    @"expected_root_fingerprint_sha256" : row[@"root_fingerprint_sha256"],
    @"expected_binding_revision" : row[@"binding_revision"],
  };
}

static NSString *DSHAgentExecutionFeedback(NSDictionary *feedback,
                                            NSError **error) {
  NSData *bytes = DSHAgentCanonicalJSON(feedback, error);
  NSString *value = bytes == nil ? nil
      : [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
  if (value == nil || !DSHAgentValidateNativeToolFeedbackString(value, error)) {
    return nil;
  }
  return value;
}

static NSDictionary *DSHAgentExecutionGenericFailure(NSString *name,
                                                      NSError **error) {
  NSString *feedback = DSHAgentExecutionFeedback(@{
    @"schema_version" : @1, @"name" : name, @"outcome" : @"failed",
    @"payload" : @{ @"schema_version" : @1,
                     @"failure_code" : @"E_AGENT_TOOL_FAILED" },
  }, error);
  return feedback == nil ? nil : @{
    @"schema_version" : @1, @"status" : @"failed", @"feedback" : feedback,
    @"settled_facts" : NSNull.null, @"truncated" : @NO,
    @"effect_may_have_occurred" : @NO,
  };
}

static NSString *DSHAgentExecutionPublicStatus(NSDictionary *receipt) {
  NSString *outcome = receipt[@"outcome"];
  if ([outcome isEqualToString:@"ok"]) return @"completed";
  if ([outcome isEqualToString:@"denied"]) return @"denied";
  if ([outcome isEqualToString:@"cancelled"]) return @"cancelled";
  if ([outcome isEqualToString:@"ambiguous"]) return @"ambiguous";
  return @"failed";
}

static NSDictionary *DSHAgentExecutionSafeResult(NSDictionary *request,
                                                  NSDictionary *row,
                                                  BOOL effectMayHaveOccurred) {
  NSDictionary *receipt = row[@"receipt"];
  return @{
    @"schema_version" : @2,
    @"status" : DSHAgentExecutionPublicStatus(receipt),
    @"operation_id" : request[@"operation_id"],
    @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
    @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
    @"name" : request[@"name"], @"idempotency_key" : request[@"idempotency_key"],
    @"result_execution_revision" : row[@"row_revision"],
    @"transcript" : row[@"transcript_after"], @"receipt" : receipt,
    @"effect_may_have_occurred" : @(effectMayHaveOccurred),
  };
}

static NSDictionary *DSHAgentExecutionWrappedResult(NSDictionary *result) {
  return @{ @"schema_version" : @2, @"result_kind" : @"execute_agent_tool",
            @"result" : result };
}

static NSDictionary *DSHAgentExecutionCommitConflict(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSDictionary *started,
    NSDictionary *row,
    NSString *failureCode,
    NSError **error) {
  NSString *actualState = [row[@"state"] isKindOfClass:NSString.class]
      ? row[@"state"] : @"intent";
  NSDictionary *result = @{
    @"schema_version" : @2, @"status" : @"conflict",
    @"operation_id" : request[@"operation_id"], @"failure_code" : failureCode,
    @"expected_execution_revision" : request[@"expected_execution_revision"],
    @"actual_execution_revision" : row[@"row_revision"] ?: @0,
    @"actual_status" : actualState,
  };
  if (error != nullptr) *error = nil;
  NSDictionary *commit = DSHAgentNativeWALCommitOperation(
      wal, request[@"operation_id"], started[@"request_sha256"],
      request[@"task_id"], request[@"attempt_id"], @"conflict", @"conflict",
      @{ @"schema_version" : @2, @"kind" : @"none" }, nil,
      DSHAgentExecutionWrappedResult(result), error);
  return commit == nil ? nil : commit[@"result"][@"result"];
}

static NSDictionary *DSHAgentExecutionActiveResult(
    NSDictionary *request,
    NSDictionary *row,
    NSString *status,
    BOOL effectMayHaveOccurred) {
  return @{
    @"schema_version" : @2, @"status" : status,
    @"operation_id" : request[@"operation_id"],
    @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
    @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
    @"name" : request[@"name"], @"idempotency_key" : request[@"idempotency_key"],
    @"result_execution_revision" : row[@"row_revision"],
    @"transcript" : request[@"transcript"], @"receipt" : NSNull.null,
    @"effect_may_have_occurred" : @(effectMayHaveOccurred),
  };
}

static NSDictionary *DSHAgentExecutionAmbiguousResult(
    NSDictionary *request,
    NSDictionary *row,
    NSError **error) {
  NSDictionary *feedback = @{
    @"schema_version" : @1, @"name" : request[@"name"],
    @"outcome" : @"ambiguous",
    @"payload" : @{
      @"schema_version" : @1,
      @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
    },
  };
  NSData *bytes = DSHAgentCanonicalJSON(feedback, error);
  NSString *digest = bytes == nil ? nil
      : DSHAgentHB(@"tool-result", bytes, error);
  if (digest == nil) return nil;
  NSDictionary *receipt = @{
    @"schema_version" : @1, @"call_id" : request[@"call_id"],
    @"name" : request[@"name"],
    @"arguments_sha256" : request[@"arguments_sha256"],
    @"result_sha256" : digest, @"result_bytes" : @(bytes.length),
    @"truncated" : @NO, @"duration_ms" : @0,
    @"outcome" : @"ambiguous",
    @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
    @"approval_reference" : request[@"approval_reference"],
  };
  return @{
    @"schema_version" : @2, @"status" : @"ambiguous",
    @"operation_id" : request[@"operation_id"],
    @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
    @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
    @"name" : request[@"name"], @"idempotency_key" : request[@"idempotency_key"],
    @"result_execution_revision" : row[@"row_revision"] ?: @1,
    @"transcript" : request[@"transcript"], @"receipt" : receipt,
    @"effect_may_have_occurred" : @YES,
    @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
  };
}

static NSDictionary *DSHAgentExecutionHistoricalResult(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    BOOL *terminalOut,
    NSError **error) {
  if (terminalOut != nullptr) *terminalOut = NO;
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"execute_agent_tool", @"request" : request,
  }, error);
  if (requestSHA == nil) return nil;
  NSDictionary *query = DSHAgentNativeWALQueryOperation(
      wal, request[@"operation_id"], requestSHA, request[@"task_id"],
      request[@"attempt_id"], error);
  if ([query[@"status"] isEqualToString:@"not_started"] ||
      ([query[@"status"] isEqualToString:@"found"] &&
       [query[@"record"][@"state"] isEqualToString:@"started"])) return nil;
  if (![query[@"status"] isEqualToString:@"found"]) {
    if (terminalOut != nullptr) *terminalOut = YES;
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *state = [wal snapshotWithError:error];
  for (NSDictionary *snapshot in state[@"operation_results"]) {
    if ([snapshot[@"operation_id"] isEqual:request[@"operation_id"]] &&
        [snapshot[@"operation_kind"] isEqualToString:@"execute_agent_tool"]) {
      if (terminalOut != nullptr) *terminalOut = YES;
      return snapshot[@"result"][@"result"];
    }
  }
  if (terminalOut != nullptr) *terminalOut = YES;
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
  return nil;
}

@interface DSHAgentToolExecutionService ()
@property(nonatomic, strong) DSHAgentNativeWAL *wal;
@property(nonatomic, strong) DSHAgentExecutionLedger *ledger;
@property(nonatomic, strong) DSHAgentPreparedAttemptStore *preparedStore;
@property(nonatomic, strong) DSHAgentTranscriptStore *transcripts;
@property(nonatomic, strong) DSHAgentWorkspaceToolExecutor *workspaceExecutor;
@property(nonatomic, strong) DSHAgentGitToolExecutor *gitExecutor;
@property(nonatomic, strong) NSMutableDictionary<NSString *, DSHGitPushCancelToken *> *pushCancelTokens;
@end

@implementation DSHAgentToolExecutionService

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                      ledger:(DSHAgentExecutionLedger *)ledger
               preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                 transcripts:(DSHAgentTranscriptStore *)transcripts
           workspaceExecutor:(DSHAgentWorkspaceToolExecutor *)workspaceExecutor
                 gitExecutor:(DSHAgentGitToolExecutor *)gitExecutor {
  self = [super init];
  if (self) {
    _wal = wal;
    _ledger = ledger;
    _preparedStore = preparedStore;
    _transcripts = transcripts;
    _workspaceExecutor = workspaceExecutor;
    _gitExecutor = gitExecutor;
    _pushCancelTokens = [NSMutableDictionary dictionary];
  }
  return self;
}

- (BOOL)validateExecuteRequest:(NSDictionary *)request error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"operation_id", @"controller_cas",
        @"committed_checkpoint", @"task_id", @"conversation_id", @"attempt_id",
        @"round_id", @"round_index", @"batch_kind", @"manifest_sha256",
        @"expected_batch_revision", @"call_index", @"call_id", @"name",
        @"arguments_sha256", @"idempotency_key", @"expected_execution_revision",
        @"transcript", @"root", @"approval_reference",
      ]) || ![request[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(request[@"operation_id"]) ||
      !DSHAgentExecutionControllerCAS(request[@"controller_cas"]) ||
      !DSHAgentExecutionCheckpoint(request[@"committed_checkpoint"]) ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"conversation_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(request[@"round_id"]) ||
      !DSHAgentSafeInteger(request[@"round_index"], 7, YES) ||
      (![request[@"batch_kind"] isEqualToString:@"write_batch"] &&
       ![request[@"batch_kind"] isEqualToString:@"read_only_batch"]) ||
      !(request[@"manifest_sha256"] == NSNull.null ||
        DSHAgentCanonicalSHA256(request[@"manifest_sha256"])) ||
      !DSHAgentSafeInteger(request[@"expected_batch_revision"],
                          DSHAgentExecutionMaximumSafeInteger, NO) ||
      !DSHAgentSafeInteger(request[@"call_index"], 15, YES) ||
      !DSHAgentBoundedUTF8String(request[@"call_id"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(request[@"name"], 64, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(request[@"arguments_sha256"]) ||
      !DSHAgentCanonicalSHA256(request[@"idempotency_key"]) ||
      !DSHAgentSafeInteger(request[@"expected_execution_revision"],
                          DSHAgentExecutionMaximumSafeInteger, NO) ||
      !DSHAgentExecutionTranscript(request[@"transcript"]) ||
      !DSHAgentExecutionRoot(request[@"root"]) ||
      !(request[@"approval_reference"] == NSNull.null ||
        DSHAgentCanonicalUUID(request[@"approval_reference"]))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSDictionary *cas = request[@"controller_cas"];
  NSDictionary *checkpoint = request[@"committed_checkpoint"];
  if (![cas[@"task_id"] isEqual:request[@"task_id"]] ||
      ![cas[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
      ![cas[@"conversation_id"] isEqual:request[@"conversation_id"]] ||
      ![cas[@"expected_journal_revision"] isEqual:checkpoint[@"journal_revision"]] ||
      ![cas[@"expected_session_generation"] isEqual:checkpoint[@"session_generation"]] ||
      ![cas[@"expected_session_sha256"] isEqual:checkpoint[@"session_sha256"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

- (NSDictionary *)executeAgentToolWithRequest:(NSDictionary *)request
                                         error:(NSError **)error {
  if (![self validateExecuteRequest:request error:error]) return nil;
  BOOL historicalTerminal = NO;
  NSDictionary *historical = DSHAgentExecutionHistoricalResult(
      self.wal, request, &historicalTerminal, error);
  if (historicalTerminal) return historical;
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  NSDictionary *authority = nil;
  for (NSDictionary *candidate in state[@"authorities"]) {
    if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
        [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
      authority = candidate;
      break;
    }
  }
  NSDictionary *batch = DSHAgentExecutionBatch(state, request);
  NSDictionary *row = DSHAgentExecutionRow(state, request);
  NSDictionary *projection = DSHAgentExecutionPreparedProjection(state, request);
  // A same-operation replay must use the authority revision frozen on the
  // durable operation record. The first execution may legitimately advance
  // the live authority while claiming its native owner; using that newer
  // revision here would make an exact lost-response replay conflict with its
  // own started record. StartOperation still verifies the complete request
  // digest, task, attempt, kind, and stored revision.
  NSNumber *operationAuthorityRevision = authority[@"authority_revision"] ?: @0;
  for (NSDictionary *operation in state[@"operations"]) {
    if ([operation[@"operation_id"] isEqual:request[@"operation_id"]]) {
      operationAuthorityRevision = operation[@"authority_revision"];
      break;
    }
  }
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      self.wal, @"execute_agent_tool", request, request[@"task_id"],
      request[@"attempt_id"], operationAuthorityRevision, error);
  if (started == nil) return nil;
  if ([started[@"status"] isEqualToString:@"replayed"] &&
      started[@"result"] != NSNull.null) return started[@"result"][@"result"];
  if (!DSHAgentExecutionValidateCommittedSession(
          self.preparedStore, request, YES, error) ||
      ![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:error]) {
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_ROOT_STALE", error);
  }
  if (authority == nil || batch == nil || row == nil || projection == nil ||
      ![authority[@"state"] isEqualToString:@"prepared"] ||
      ![authority[@"root"] isEqual:request[@"root"]] ||
      ![batch[@"kind"] isEqual:request[@"batch_kind"]] ||
      ![batch[@"manifest_sha256"] isEqual:request[@"manifest_sha256"]] ||
      ![row[@"name"] isEqual:request[@"name"]] ||
      ![row[@"arguments_sha256"] isEqual:request[@"arguments_sha256"]]) {
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_CONFLICT", error);
  }
  // A later call cannot overtake an earlier executable call in the same round.
  for (NSDictionary *candidate in state[@"ledger"]) {
    NSDictionary *locator = candidate[@"locator"];
    if ([locator[@"task_id"] isEqual:request[@"task_id"]] &&
        [locator[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
        [locator[@"round_id"] isEqual:request[@"round_id"]] &&
        [locator[@"round_index"] isEqual:request[@"round_index"]] &&
        [locator[@"call_index"] unsignedIntegerValue] <
            [request[@"call_index"] unsignedIntegerValue] &&
        ![candidate[@"state"] isEqualToString:@"settled"] &&
        ![candidate[@"state"] isEqualToString:@"cancelled"]) {
      return DSHAgentExecutionCommitConflict(
          self.wal, request, started, row, @"E_AGENT_CONFLICT", error);
    }
  }
  BOOL automatic = [projection[@"access"] isEqualToString:@"auto"];
  if ((automatic && request[@"approval_reference"] != NSNull.null) ||
      (!automatic && !DSHAgentExecutionApprovalBound(state, request) &&
       !DSHAgentExecutionConversationGrantBound(self.preparedStore, request))) {
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_APPROVAL", error);
  }
  if ([row[@"state"] isEqualToString:@"settled"] ||
      [row[@"state"] isEqualToString:@"cancelled"] ||
      [row[@"state"] isEqualToString:@"ambiguous"]) {
    NSDictionary *result = DSHAgentExecutionSafeResult(
        request, row, ![row[@"receipt"][@"outcome"] isEqualToString:@"cancelled"]);
    NSDictionary *resultRef = @{
      @"schema_version" : @2, @"kind" : @"tool",
      @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
      @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
      @"execution_revision" : row[@"row_revision"],
    };
    NSDictionary *commit = DSHAgentNativeWALCommitOperation(
        self.wal, request[@"operation_id"], started[@"request_sha256"],
        request[@"task_id"], request[@"attempt_id"], @"committed",
        result[@"status"], resultRef, row[@"row_revision"],
        DSHAgentExecutionWrappedResult(result), error);
    return commit == nil ? nil : commit[@"result"][@"result"];
  }
  if ([row[@"state"] isEqualToString:@"running"] ||
      [row[@"state"] isEqualToString:@"cancel_requested"]) {
    NSString *dispatch = [self.wal dispatchStateForKind:@"execution"
                                                 locator:row[@"locator"] error:nil];
    NSDictionary *owner = row[@"owner"];
    BOOL ownerAlive = [owner isKindOfClass:NSDictionary.class] &&
        [self.wal isNativeTaskAlive:owner[@"native_task_id"]
                            launchId:owner[@"launch_id"]];
    if (!ownerAlive && [dispatch isEqualToString:@"dispatched"]) {
      return DSHAgentExecutionAmbiguousResult(request, row, error);
    }
    if (!ownerAlive) {
      return @{
        @"schema_version" : @2, @"status" : @"unknown",
        @"operation_id" : request[@"operation_id"],
        @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"round_id" : request[@"round_id"],
        @"round_index" : request[@"round_index"],
        @"call_index" : request[@"call_index"],
        @"call_id" : request[@"call_id"], @"name" : request[@"name"],
        @"idempotency_key" : request[@"idempotency_key"],
        @"result_execution_revision" : row[@"row_revision"],
        @"transcript" : request[@"transcript"], @"receipt" : NSNull.null,
        @"effect_may_have_occurred" : @NO,
        @"failure_code" : @"E_AGENT_LEDGER",
      };
    }
    return DSHAgentExecutionActiveResult(
        request, row, row[@"state"], [dispatch isEqualToString:@"dispatched"]);
  }
  if ([row[@"state"] isEqualToString:@"unknown"]) {
    return @{
      @"schema_version" : @2, @"status" : @"unknown",
      @"operation_id" : request[@"operation_id"],
      @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
      @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
      @"name" : request[@"name"],
      @"idempotency_key" : request[@"idempotency_key"],
      @"result_execution_revision" : row[@"row_revision"],
      @"transcript" : request[@"transcript"], @"receipt" : NSNull.null,
      @"effect_may_have_occurred" : @NO,
      @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
    };
  }
  if (![row[@"state"] isEqualToString:@"intent"] ||
      ![row[@"row_revision"] isEqual:request[@"expected_execution_revision"]]) {
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_CONFLICT", error);
  }
  NSArray *messages = [self.transcripts nativeMessagesForTranscriptWithRequest:@{
    @"schema_version" : @1, @"attempt_id" : request[@"attempt_id"],
    @"root" : request[@"root"], @"transcript" : request[@"transcript"],
  } error:error];
  NSDictionary *raw = messages == nil ? nil
      : DSHAgentExecutionRawCall(messages, request);
  NSString *argumentsSHA = raw == nil ? nil : DSHAgentArgumentsSHA256(
      request[@"name"], raw[@"arguments_json"], error);
  NSDictionary *arguments = argumentsSHA == nil ? nil
      : DSHAgentParseArgumentsJSON(raw[@"arguments_json"], error);
  if (arguments == nil || ![argumentsSHA isEqual:request[@"arguments_sha256"]]) {
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_TRANSCRIPT", error);
  }
  if (!DSHAgentExecutionValidateCommittedSession(
          self.preparedStore, request, YES, error)) {
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_CONFLICT", error);
  }
  BOOL mutation = [request[@"name"] isEqualToString:@"write_file"] ||
      [request[@"name"] isEqualToString:@"git_commit"] ||
      [request[@"name"] isEqualToString:@"git_push"] || [request[@"name"] hasSuffix:@"_guest_cgi"];
  if ([request[@"batch_kind"] isEqualToString:@"write_batch"] && mutation) {
    NSDictionary *gate = [self.ledger openAgentWriteBatchEffectGateWithRequest:@{
      @"schema_version" : @2, @"task_id" : request[@"task_id"],
      @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"],
      @"round_index" : request[@"round_index"],
      @"expected_batch_revision" : request[@"expected_batch_revision"],
      @"manifest_sha256" : request[@"manifest_sha256"],
      @"expected_effect_gate" : @"closed",
    } error:error];
    if (gate == nil) {
      return DSHAgentExecutionCommitConflict(
          self.wal, request, started, row, @"E_AGENT_APPROVAL", error);
    }
  }
  NSString *nativeTaskID = NSUUID.UUID.UUIDString.lowercaseString;
  if (![self.wal registerNativeTaskId:nativeTaskID error:error]) return nil;
  NSDictionary *owner = @{
    @"schema_version" : @1, @"task_id" : request[@"task_id"],
    @"launch_id" : self.wal.launchId,
    @"native_task_id" : nativeTaskID, @"owner_generation" : @1,
    @"heartbeat_at" : [self.wal currentTimestamp],
  };
  NSDictionary *claimed = [self.ledger
      claimAgentExecutionWithLocator:row[@"locator"]
      expectedRowRevision:request[@"expected_execution_revision"]
      owner:owner error:error];
  row = claimed[@"row"];
  if (![claimed[@"ok"] boolValue] || row == nil ||
      ![row[@"state"] isEqualToString:@"running"] ||
      ![row[@"owner"] isEqual:owner]) {
    [self.wal unregisterNativeTaskId:nativeTaskID error:nil];
    if ([row[@"state"] isEqualToString:@"running"] ||
        [row[@"state"] isEqualToString:@"cancel_requested"]) {
      NSString *dispatch = [self.wal dispatchStateForKind:@"execution"
                                                   locator:row[@"locator"] error:nil];
      return DSHAgentExecutionActiveResult(
          request, row, row[@"state"], [dispatch isEqualToString:@"dispatched"]);
    }
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_CONFLICT", error);
  }
  NSDictionary *dispatched = [self.ledger markAgentExecutionDispatchedWithCAS:
      DSHAgentExecutionCAS(row, @"running") error:error];
  row = dispatched[@"row"];
  if (![dispatched[@"status"] isEqualToString:@"dispatched"] || row == nil) {
    [self.wal unregisterNativeTaskId:nativeTaskID error:nil];
    if (row != nil &&
        [[self.wal dispatchStateForKind:@"execution" locator:row[@"locator"]
                                  error:nil] isEqualToString:@"dispatched"]) {
      return DSHAgentExecutionActiveResult(request, row, row[@"state"], YES);
    }
    return DSHAgentExecutionCommitConflict(
        self.wal, request, started, row, @"E_AGENT_CONFLICT", error);
  }
  NSDate *began = NSDate.date;
  NSDictionary *effect = nil;
  if ([request[@"name"] isEqualToString:@"list_dir"] ||
      [request[@"name"] isEqualToString:@"read_file"] ||
      [request[@"name"] isEqualToString:@"write_file"]) {
    effect = [self.workspaceExecutor executeToolNamed:request[@"name"]
                                             arguments:arguments
                                                  root:request[@"root"]
                                          precondition:row[@"precondition"]
                                                 error:error];
  } else if ([request[@"name"] hasSuffix:@"_guest_cgi"]) {
#if DSH_GUEST_CGI_AVAILABLE
    effect = [[DSHAgentGuestCgiToolExecutor executorForWorkspaceExecutor:self.workspaceExecutor] executeSynchronouslyToolNamed:request[@"name"] arguments:arguments root:request[@"root"] owner:request precondition:row[@"precondition"]];
#endif
  } else {
    // git_push registers a cancellation token under the same locator identity
    // as the ledger row, so the coordinator's cancel path can interrupt the
    // bounded network phase cooperatively.
    DSHGitPushCancelToken *cancelToken = nil;
    NSString *locatorKey = nil;
    if ([request[@"name"] isEqualToString:@"git_push"]) {
      cancelToken = [[DSHGitPushCancelToken alloc] init];
      locatorKey = DSHAgentExecutionLocatorKey(row[@"locator"]);
      @synchronized (self) {
        self.pushCancelTokens[locatorKey] = cancelToken;
      }
    }
    effect = [self.gitExecutor executeToolNamed:request[@"name"]
                                      arguments:arguments
                                           root:request[@"root"]
                                   precondition:row[@"precondition"]
                                    cancelToken:cancelToken
                                           error:error];
    if (locatorKey != nil) {
      @synchronized (self) {
        if (self.pushCancelTokens[locatorKey] == cancelToken) {
          [self.pushCancelTokens removeObjectForKey:locatorKey];
        }
      }
    }
  }
  if ([request[@"name"] hasSuffix:@"_guest_cgi"] &&
      !DSHAgentExecutionValidateCommittedSession(self.preparedStore, request, YES, nil)) {
    [[DSHAgentGuestCgiToolExecutor executorForWorkspaceExecutor:self.workspaceExecutor] cancelAttempt:request[@"attempt_id"]];
    NSString *feedback = DSHAgentExecutionFeedback(@{ @"schema_version": @1, @"name": request[@"name"], @"outcome": @"ambiguous", @"payload": @{ @"schema_version": @1, @"failure_code": @"E_AGENT_EXECUTION_AMBIGUOUS" } }, nil);
    effect = @{ @"schema_version": @1, @"status": @"ambiguous", @"feedback": feedback, @"settled_facts": NSNull.null, @"truncated": @NO, @"effect_may_have_occurred": @YES };
  }
  if (effect == nil) {
    if (error != nullptr) *error = nil;
    effect = DSHAgentExecutionGenericFailure(request[@"name"], error);
  }
  if (effect == nil) {
    [self.wal unregisterNativeTaskId:nativeTaskID error:nil];
    return nil;
  }
  NSData *feedbackBytes = [effect[@"feedback"] dataUsingEncoding:NSUTF8StringEncoding];
  NSString *resultSHA = DSHAgentHB(@"tool-result", feedbackBytes, error);
  NSDictionary *feedback = resultSHA == nil ? nil
      : [NSJSONSerialization JSONObjectWithData:feedbackBytes options:0 error:error];
  if (resultSHA == nil || ![feedback isKindOfClass:NSDictionary.class]) {
    [self.wal unregisterNativeTaskId:nativeTaskID error:nil];
    return nil;
  }
  NSString *outcome = feedback[@"outcome"];
  NSString *failureCode = [outcome isEqualToString:@"ok"]
      ? nil : feedback[@"payload"][@"failure_code"];
  NSUInteger duration = MIN((NSUInteger)(-1000.0 * [began timeIntervalSinceNow]),
                            (NSUInteger)24 * 60 * 60 * 1000);
  NSDictionary *receipt = @{
    @"schema_version" : @1, @"call_id" : request[@"call_id"],
    @"name" : request[@"name"],
    @"arguments_sha256" : request[@"arguments_sha256"],
    @"result_sha256" : resultSHA, @"result_bytes" : @(feedbackBytes.length),
    @"truncated" : effect[@"truncated"], @"duration_ms" : @(duration),
    @"outcome" : outcome, @"failure_code" : failureCode ?: NSNull.null,
    @"approval_reference" : request[@"approval_reference"],
  };
  NSDictionary *message = @{
    @"schema_version" : @1, @"role" : @"tool",
    @"round_index" : request[@"round_index"], @"call_id" : request[@"call_id"],
    @"content" : effect[@"feedback"], @"truncated" : effect[@"truncated"],
  };
  BOOL ambiguous = [outcome isEqualToString:@"ambiguous"];
  NSDictionary *settled = [self.ledger settleAgentExecutionWithCAS:
      DSHAgentExecutionCAS(row, @"running")
      patch:@{
        @"state" : ambiguous ? @"ambiguous" : @"settled",
        @"settled_facts" : effect[@"settled_facts"], @"receipt" : receipt,
      }
      message:message
      operation:@{
        @"operation_id" : request[@"operation_id"],
        @"request_sha256" : started[@"request_sha256"],
        @"effect_may_have_occurred" : effect[@"effect_may_have_occurred"],
      }
      error:error];
  [self.wal unregisterNativeTaskId:nativeTaskID error:nil];
  NSDictionary *settledRow = settled[@"row"];
  if (settledRow == nil) {
    BOOL mayHaveOccurred = [effect[@"effect_may_have_occurred"] boolValue];
    if (mayHaveOccurred) {
      NSMutableDictionary *ambiguousReceipt = [receipt mutableCopy];
      ambiguousReceipt[@"outcome"] = @"ambiguous";
      ambiguousReceipt[@"failure_code"] = @"E_AGENT_EXECUTION_AMBIGUOUS";
      return @{
        @"schema_version" : @2, @"status" : @"ambiguous",
        @"operation_id" : request[@"operation_id"],
        @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"round_id" : request[@"round_id"],
        @"round_index" : request[@"round_index"],
        @"call_index" : request[@"call_index"],
        @"call_id" : request[@"call_id"], @"name" : request[@"name"],
        @"idempotency_key" : request[@"idempotency_key"],
        @"result_execution_revision" : row[@"row_revision"],
        @"transcript" : request[@"transcript"],
        @"receipt" : ambiguousReceipt, @"effect_may_have_occurred" : @YES,
        @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
      };
    }
    return @{
      @"schema_version" : @2, @"status" : @"unknown",
      @"operation_id" : request[@"operation_id"],
      @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
      @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
      @"name" : request[@"name"],
      @"idempotency_key" : request[@"idempotency_key"],
      @"result_execution_revision" : row[@"row_revision"],
      @"transcript" : request[@"transcript"], @"receipt" : NSNull.null,
      @"effect_may_have_occurred" : @NO, @"failure_code" : @"E_AGENT_LEDGER",
    };
  }
  NSDictionary *operationResult = settled[@"operation_result"];
  if (![operationResult isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return operationResult;
}

- (NSDictionary *)recoverAgentToolWithRequest:(NSDictionary *)request
                                         error:(NSError **)error {
  if (![self validateExecuteRequest:request error:error]) return nil;
  BOOL historicalTerminal = NO;
  NSDictionary *historical = DSHAgentExecutionHistoricalResult(
      self.wal, request, &historicalTerminal, error);
  if (historicalTerminal) return historical;
  if (!DSHAgentExecutionValidateCommittedSession(
          self.preparedStore, request, NO, error)) return nil;
  if (![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:error]) return nil;
  NSDictionary *state = [self.wal snapshotWithError:error];
  NSDictionary *row = state == nil ? nil : DSHAgentExecutionRow(state, request);
  if (row == nil) return @{ @"schema_version" : @2, @"status" : @"not_started" };
  if ([row[@"state"] isEqualToString:@"settled"] ||
      [row[@"state"] isEqualToString:@"cancelled"] ||
      [row[@"state"] isEqualToString:@"ambiguous"]) {
    return DSHAgentExecutionSafeResult(request, row,
        ![row[@"receipt"][@"outcome"] isEqualToString:@"cancelled"]);
  }
  NSArray *messages = [self.transcripts nativeMessagesForTranscriptWithRequest:@{
    @"schema_version" : @1, @"attempt_id" : request[@"attempt_id"],
    @"root" : request[@"root"], @"transcript" : request[@"transcript"],
  } error:error];
  NSDictionary *raw = messages == nil ? nil
      : DSHAgentExecutionRawCall(messages, request);
  NSDictionary *arguments = raw == nil ? nil
      : DSHAgentParseArgumentsJSON(raw[@"arguments_json"], error);
  if (arguments == nil) return nil;
  NSDictionary *recovered = nil;
  if ([request[@"name"] isEqualToString:@"list_dir"] ||
      [request[@"name"] isEqualToString:@"read_file"] ||
      [request[@"name"] isEqualToString:@"write_file"]) {
    recovered = [self.workspaceExecutor recoverToolNamed:request[@"name"]
                                                 arguments:arguments
                                                      root:request[@"root"]
                                              precondition:row[@"precondition"]
                                                     error:error];
  } else if ([request[@"name"] hasSuffix:@"_guest_cgi"]) {
    // Process-owned services are never replayed during recovery.
    recovered = @{ @"schema_version": @1, @"status": @"ambiguous" };
  } else {
    recovered = [self.gitExecutor recoverToolNamed:request[@"name"]
                                           arguments:arguments
                                                root:request[@"root"]
                                        precondition:row[@"precondition"]
                                               error:error];
  }
  if (recovered == nil) return nil;
  if ([recovered[@"status"] isEqualToString:@"settled"] &&
      ([row[@"state"] isEqualToString:@"running"] ||
       [row[@"state"] isEqualToString:@"cancel_requested"])) {
    NSDictionary *payload = nil;
    NSDictionary *facts = nil;
    if ([request[@"name"] isEqualToString:@"write_file"] &&
        DSHAgentBoundedUTF8String(recovered[@"actual_revision"], 256, NO,
                                  nullptr)) {
      payload = @{
        @"schema_version" : @1,
        @"bytes" : row[@"precondition"][@"content_bytes"],
        @"revision" : recovered[@"actual_revision"],
      };
      facts = @{
        @"schema_version" : @1, @"kind" : @"write_file",
        @"actual_revision" : recovered[@"actual_revision"],
        @"content_sha256" : row[@"precondition"][@"content_sha256"],
      };
    } else if ([request[@"name"] isEqualToString:@"git_commit"] &&
               [recovered[@"actual_commit_oid"]
                   isEqual:row[@"precondition"][@"expected_commit_oid"]]) {
      payload = @{
        @"schema_version" : @1,
        @"commit_oid" : recovered[@"actual_commit_oid"],
        @"tree_oid" : row[@"precondition"][@"tree_oid"],
      };
      facts = @{
        @"schema_version" : @1, @"kind" : @"git_commit",
        @"actual_commit_oid" : recovered[@"actual_commit_oid"],
      };
    } else if ([request[@"name"] isEqualToString:@"git_push"] &&
               [recovered[@"actual_remote_oid"]
                   isEqual:row[@"precondition"][@"target_oid"]]) {
      payload = @{
        @"schema_version" : @1, @"remote" : @"origin",
        @"remote_ref" : row[@"precondition"][@"remote_ref"],
        @"pushed_oid" : recovered[@"actual_remote_oid"],
      };
      facts = @{
        @"schema_version" : @1, @"kind" : @"git_push",
        @"actual_remote_oid" : recovered[@"actual_remote_oid"],
      };
    }
    if (payload != nil && facts != nil) {
      NSString *feedbackString = DSHAgentExecutionFeedback(@{
        @"schema_version" : @1, @"name" : request[@"name"],
        @"outcome" : @"ok", @"payload" : payload,
      }, error);
      NSData *feedbackBytes = [feedbackString dataUsingEncoding:NSUTF8StringEncoding];
      NSString *resultSHA = feedbackString == nil ? nil
          : DSHAgentHB(@"tool-result", feedbackBytes, error);
      if (resultSHA == nil) return nil;
      NSDictionary *receipt = @{
        @"schema_version" : @1, @"call_id" : request[@"call_id"],
        @"name" : request[@"name"],
        @"arguments_sha256" : request[@"arguments_sha256"],
        @"result_sha256" : resultSHA,
        @"result_bytes" : @(feedbackBytes.length), @"truncated" : @NO,
        @"duration_ms" : @0, @"outcome" : @"ok",
        @"failure_code" : NSNull.null,
        @"approval_reference" : request[@"approval_reference"],
      };
      NSString *recoveryRequestSHA = DSHAgentHJ(
          @"agent-operation-request", @{
            @"operation_kind" : @"execute_agent_tool", @"request" : request,
          }, error);
      if (recoveryRequestSHA == nil) return nil;
      NSDictionary *settled = [self.ledger settleAgentExecutionWithCAS:
          DSHAgentExecutionCAS(row, row[@"state"])
          patch:@{ @"state" : @"settled", @"settled_facts" : facts,
                   @"receipt" : receipt }
          message:@{
            @"schema_version" : @1, @"role" : @"tool",
            @"round_index" : request[@"round_index"],
            @"call_id" : request[@"call_id"], @"content" : feedbackString,
            @"truncated" : @NO,
          }
          operation:@{
            @"operation_id" : request[@"operation_id"],
            @"request_sha256" : recoveryRequestSHA,
            @"effect_may_have_occurred" : @YES,
          }
          error:error];
      if (settled[@"row"] == nil) return nil;
      return settled[@"operation_result"];
    }
  }
  return @{
    @"schema_version" : @2,
    @"status" : [recovered[@"status"] isEqualToString:@"settled"]
        ? @"manual_reconciliation" : recovered[@"status"],
    @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
    @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
    @"idempotency_key" : request[@"idempotency_key"],
    @"execution_revision" : row[@"row_revision"],
    @"effect_may_have_occurred" :
        @(![recovered[@"status"] isEqualToString:@"not_dispatched"]),
  };
}

- (void)requestCancelForExecutionLocator:(NSDictionary *)locator {
  if (![locator isKindOfClass:NSDictionary.class]) return;
  NSString *locatorKey = DSHAgentExecutionLocatorKey(locator);
  DSHGitPushCancelToken *token = nil;
  @synchronized (self) {
    token = self.pushCancelTokens[locatorKey];
  }
  [token cancel];
  [[DSHAgentGuestCgiToolExecutor executorForWorkspaceExecutor:self.workspaceExecutor] cancelAttempt:locator[@"attempt_id"]];
}

@end
