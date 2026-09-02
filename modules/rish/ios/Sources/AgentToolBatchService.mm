#import "AgentToolBatchService.h"

#import "AgentExecutionLedger.h"
#import "AgentGitToolExecutor.h"
#import "AgentNativeWAL.h"
#import "AgentPreparedAttemptStore.h"
#import "AgentTranscriptStore.h"
#import "AgentWorkspaceToolExecutor.h"

static const unsigned long long DSHAgentBatchMaximumSafeInteger =
    9007199254740991ULL;

static BOOL DSHAgentBatchControllerCAS(NSDictionary *cas) {
  return DSHAgentExactDictionaryKeys(cas, @[
    @"schema_version", @"conversation_id", @"task_id", @"attempt_id",
    @"expected_controller_generation", @"expected_journal_revision",
    @"expected_session_generation", @"expected_session_sha256",
  ]) && [cas[@"schema_version"] isEqual:@1] &&
      DSHAgentCanonicalUUID(cas[@"conversation_id"]) &&
      DSHAgentCanonicalUUID(cas[@"task_id"]) &&
      DSHAgentCanonicalUUID(cas[@"attempt_id"]) &&
      DSHAgentSafeInteger(cas[@"expected_controller_generation"],
                          DSHAgentBatchMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_journal_revision"],
                          DSHAgentBatchMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_session_generation"],
                          DSHAgentBatchMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(cas[@"expected_session_sha256"]);
}

static BOOL DSHAgentBatchCheckpoint(NSDictionary *checkpoint) {
  return DSHAgentExactDictionaryKeys(checkpoint, @[
    @"schema_version", @"journal_revision", @"session_generation",
    @"session_sha256",
  ]) && [checkpoint[@"schema_version"] isEqual:@1] &&
      DSHAgentSafeInteger(checkpoint[@"journal_revision"],
                          DSHAgentBatchMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(checkpoint[@"session_generation"],
                          DSHAgentBatchMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(checkpoint[@"session_sha256"]);
}

static BOOL DSHAgentBatchRoot(NSDictionary *root) {
  if (!DSHAgentExactDictionaryKeys(root, @[
        @"schema_version", @"kind", @"workspace_id",
        @"workspace_binding_revision", @"project_id",
        @"root_fingerprint_sha256", @"capabilities",
      ]) || ![root[@"schema_version"] isEqual:@1] ||
      !DSHAgentCanonicalUUID(root[@"workspace_id"]) ||
      !DSHAgentSafeInteger(root[@"workspace_binding_revision"],
                          DSHAgentBatchMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) ||
      ![root[@"capabilities"] isKindOfClass:NSArray.class]) return NO;
  if ([root[@"kind"] isEqualToString:@"workspace"]) {
    return root[@"project_id"] == NSNull.null;
  }
  return [root[@"kind"] isEqualToString:@"project"] &&
      DSHAgentCanonicalUUID(root[@"project_id"]);
}

static BOOL DSHAgentBatchTranscript(NSDictionary *transcript) {
  return DSHAgentExactDictionaryKeys(transcript, @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ]) && [transcript[@"schema_version"] isEqual:@1] &&
      DSHAgentCanonicalUUID(transcript[@"transcript_ref"]) &&
      DSHAgentSafeInteger(transcript[@"generation"],
                          DSHAgentBatchMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(transcript[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(transcript[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

static BOOL DSHAgentBatchTranscriptCanAdvance(NSDictionary *authorityTranscript,
                                              NSDictionary *requestTranscript) {
  if (!DSHAgentBatchTranscript(authorityTranscript) ||
      !DSHAgentBatchTranscript(requestTranscript) ||
      ![authorityTranscript[@"transcript_ref"]
          isEqual:requestTranscript[@"transcript_ref"]]) return NO;
  NSUInteger authorityGeneration =
      [authorityTranscript[@"generation"] unsignedIntegerValue];
  NSUInteger requestGeneration =
      [requestTranscript[@"generation"] unsignedIntegerValue];
  if (requestGeneration < authorityGeneration) return NO;
  if (requestGeneration > authorityGeneration) {
    // The completed round is separately required to bind transcript_after
    // exactly to requestTranscript; authority may legitimately lag that append.
    return YES;
  }
  return [authorityTranscript[@"transcript_sha256"]
              isEqual:requestTranscript[@"transcript_sha256"]] &&
      [authorityTranscript[@"transcript_bytes"]
          isEqual:requestTranscript[@"transcript_bytes"]];
}

static NSDictionary *DSHAgentBatchRound(NSDictionary *state,
                                         NSDictionary *request) {
  for (NSDictionary *round in state[@"rounds"]) {
    NSDictionary *locator = round[@"locator"];
    if ([locator[@"task_id"] isEqual:request[@"task_id"]] &&
        [locator[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
        [locator[@"round_id"] isEqual:request[@"round_id"]] &&
        [locator[@"round_index"] isEqual:request[@"round_index"]]) {
      return round;
    }
  }
  return nil;
}

static NSDictionary *DSHAgentBatchRegistryTool(NSDictionary *authority,
                                                NSString *name) {
  for (NSDictionary *tool in authority[@"registry"][@"tools"]) {
    if ([tool[@"name"] isEqual:name]) return tool;
  }
  return nil;
}

static NSDictionary *DSHAgentBatchRawAssistant(NSArray *messages,
                                                NSNumber *roundIndex) {
  NSDictionary *found = nil;
  for (NSDictionary *message in messages) {
    if ([message[@"role"] isEqualToString:@"assistant"] &&
        [message[@"round_index"] isEqual:roundIndex] &&
        [message[@"tool_calls"] isKindOfClass:NSArray.class] &&
        [(NSArray *)message[@"tool_calls"] count] > 0) found = message;
  }
  return found;
}

static BOOL DSHAgentBatchArgumentsContainBadPath(NSString *name,
                                                 NSString *argumentsJSON) {
  if (![name isEqualToString:@"list_dir"] &&
      ![name isEqualToString:@"read_file"] &&
      ![name isEqualToString:@"write_file"]) return NO;
  NSData *bytes = [argumentsJSON dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *arguments = bytes == nil ? nil
      : [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  NSString *path = arguments[@"path"];
  BOOL allowRoot = [name isEqualToString:@"list_dir"];
  if (path == nil && allowRoot && arguments.count == 0) return NO;
  if (![path isKindOfClass:NSString.class] ||
      (path.length == 0 && !allowRoot) || [path hasPrefix:@"/"] ||
      [path containsString:@"\\"] ||
      ![path isEqualToString:path.precomposedStringWithCanonicalMapping] ||
      [path rangeOfCharacterFromSet:
          NSCharacterSet.controlCharacterSet].location != NSNotFound) return YES;
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if (component.length == 0 || [component isEqualToString:@"."] ||
        [component isEqualToString:@".."] ||
        [component isEqualToString:@".git"] ||
        [component isEqualToString:@".trash"]) return YES;
  }
  return NO;
}

static NSDictionary *DSHAgentBatchSafeResult(NSString *kind,
                                              NSDictionary *result) {
  return @{ @"schema_version" : @2, @"result_kind" : kind,
            @"result" : result };
}

static NSDictionary *DSHAgentBatchCommitRejected(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSDictionary *started,
    NSString *failureCode,
    BOOL mutationBatch,
    NSString *retryAdvice,
    NSError **error) {
  NSDictionary *rejected = @{
    @"schema_version" : @2, @"status" : @"rejected",
    @"operation_id" : request[@"operation_id"], @"failure_code" : failureCode,
    @"expected_batch_revision" : request[@"expected_batch_revision"],
    @"expected_reserved_write_bytes" : request[@"expected_reserved_write_bytes"],
    @"result_reserved_write_bytes" : request[@"expected_reserved_write_bytes"],
    @"effect_gate" : mutationBatch ? @"closed" : @"not_applicable",
    @"reservation_status" : @"unchanged", @"effect_dispatched" : @NO,
    @"retry_advice" : retryAdvice,
  };
  if (error != nullptr) *error = nil;
  NSDictionary *commit = DSHAgentNativeWALCommitOperation(
      wal, request[@"operation_id"], started[@"request_sha256"],
      request[@"task_id"], request[@"attempt_id"], @"rejected", @"rejected",
      @{ @"schema_version" : @2, @"kind" : @"none" }, nil,
      DSHAgentBatchSafeResult(@"prepare_agent_tool_batch", rejected), error);
  return commit == nil ? nil : commit[@"result"][@"result"];
}

static NSDictionary *DSHAgentBatchCommitApprovalConflict(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSDictionary *started,
    NSNumber *actualBatchRevision,
    NSString *actualDecision,
    NSError **error) {
  NSDictionary *conflict = @{
    @"schema_version" : @2, @"status" : @"conflict",
    @"operation_id" : request[@"operation_id"],
    @"failure_code" : @"E_AGENT_APPROVAL",
    @"expected_batch_revision" : request[@"batch_revision"],
    @"actual_batch_revision" : actualBatchRevision ?: @0,
    @"actual_decision" : actualDecision ?: @"pending",
    @"observed_checkpoint" : request[@"committed_checkpoint"],
  };
  if (error != nullptr) *error = nil;
  NSDictionary *commit = DSHAgentNativeWALCommitOperation(
      wal, request[@"operation_id"], started[@"request_sha256"],
      request[@"task_id"], request[@"attempt_id"], @"conflict", @"conflict",
      @{ @"schema_version" : @2, @"kind" : @"none" }, nil,
      DSHAgentBatchSafeResult(@"bind_agent_approval", conflict), error);
  return commit == nil ? nil : commit[@"result"][@"result"];
}

static NSDictionary *DSHAgentBatchHistoricalOperationResult(
    DSHAgentNativeWAL *wal,
    NSString *kind,
    NSDictionary *request,
    BOOL *terminalOut,
    NSError **error) {
  if (terminalOut != nullptr) *terminalOut = NO;
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : kind, @"request" : request,
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
        [snapshot[@"operation_kind"] isEqual:kind]) {
      if (terminalOut != nullptr) *terminalOut = YES;
      return snapshot[@"result"][@"result"];
    }
  }
  if (terminalOut != nullptr) *terminalOut = YES;
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
  return nil;
}

static NSDictionary *DSHAgentBatchCommittedSession(
    DSHAgentPreparedAttemptStore *preparedStore,
    NSDictionary *request,
    NSError **error) {
  NSDictionary *loaded = [preparedStore.sessionSnapshotStore
      loadSessionSnapshotWithError:error];
  NSDictionary *expected = request[@"committed_checkpoint"];
  if (![loaded[@"status"] isEqualToString:@"present"] ||
      ![loaded[@"snapshot"][@"generation"]
          isEqual:expected[@"session_generation"]] ||
      ![loaded[@"snapshot"][@"session_sha256"]
          isEqual:expected[@"session_sha256"]] ||
      ![loaded[@"session_json"] isKindOfClass:NSString.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSData *bytes = [loaded[@"session_json"] dataUsingEncoding:NSUTF8StringEncoding];
  id session = bytes == nil ? nil
      : [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  if (![session isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return session;
}

static NSDictionary *DSHAgentBatchPersistedApprovalCall(
    NSDictionary *session,
    NSDictionary *request,
    NSDictionary **conversationOut) {
  for (NSDictionary *conversation in session[@"conversations"]) {
    if (![(conversation[@"id"] ?: conversation[@"conversation_id"])
            isEqual:request[@"conversation_id"]]) continue;
    for (NSDictionary *attempt in conversation[@"attempts"]) {
      if (![attempt[@"attempt_id"] isEqual:request[@"attempt_id"]]) continue;
      if (![attempt[@"journal_revision"]
              isEqual:request[@"committed_checkpoint"][@"journal_revision"]]) {
        return nil;
      }
      NSDictionary *agent = attempt[@"agent"];
      if (![agent isKindOfClass:NSDictionary.class] ||
          ![agent[@"round_lineage"][@"round_id"] isEqual:request[@"round_id"]] ||
          ![agent[@"round_lineage"][@"round_index"]
              isEqual:request[@"round_index"]]) return nil;
      for (NSDictionary *call in agent[@"batch"]) {
        if ([call[@"call_index"] isEqual:request[@"call_index"]] &&
            [call[@"call_id"] isEqual:request[@"call_id"]]) {
          if (conversationOut != nullptr) *conversationOut = conversation;
          return call;
        }
      }
    }
  }
  return nil;
}

static BOOL DSHAgentBatchApprovalEventMatches(
    NSDictionary *session,
    NSDictionary *request,
    NSDictionary *call) {
  NSUInteger matches = 0;
  for (NSDictionary *event in session[@"session_events"]) {
    if ([event[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
        [event[@"kind"] isEqualToString:@"approval"] &&
        [event[@"round_index"] isEqual:request[@"round_index"]] &&
        [event[@"call_id"] isEqual:request[@"call_id"]] &&
        [event[@"status"] isEqualToString:@"approval"] &&
        [event[@"arguments_sha256"] isEqual:call[@"arguments_sha256"]] &&
        [event[@"safe_summary_key"] isEqual:call[@"safe_summary_key"]] &&
        [event[@"approval_reference"]
            isEqual:call[@"approval_reference"]] &&
        event[@"result_sha256"] == NSNull.null) {
      if (call[@"approval_reference"] != NSNull.null &&
          ![event[@"event_id"] isEqual:call[@"approval_reference"]]) return NO;
      matches += 1;
    }
  }
  return matches == 1;
}

static NSDictionary *DSHAgentBatchConversationGrant(
    NSDictionary *session,
    NSString *conversationId,
    NSDictionary *root,
    NSString *name) {
  NSString *family = [name isEqualToString:@"write_file"] ? @"file_write" :
      ([name isEqualToString:@"git_commit"] ? @"git_commit" : nil);
  if (family == nil) return nil;
  for (NSDictionary *conversation in session[@"conversations"]) {
    if (![(conversation[@"id"] ?: conversation[@"conversation_id"])
            isEqual:conversationId]) continue;
    for (NSDictionary *grant in conversation[@"agent_grants"]) {
      if ([grant[@"conversation_id"] isEqual:conversationId] &&
          [grant[@"workspace_id"] isEqual:root[@"workspace_id"]] &&
          [grant[@"project_id"] isEqual:root[@"project_id"]] &&
          [grant[@"binding_revision"]
              isEqual:root[@"workspace_binding_revision"]] &&
          [grant[@"root_fingerprint_sha256"]
              isEqual:root[@"root_fingerprint_sha256"]] &&
          [grant[@"tool_family"] isEqual:family] &&
          [grant[@"registry_version"] isEqual:@1] &&
          [grant[@"policy_version"] isEqualToString:@"agent-v1"] &&
          DSHAgentCanonicalUUID(grant[@"grant_id"])) return grant;
    }
  }
  return nil;
}

@interface DSHAgentToolBatchService ()
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@property(nonatomic, strong, readwrite) DSHAgentExecutionLedger *ledger;
@property(nonatomic, strong, readwrite) DSHAgentPreparedAttemptStore *preparedStore;
@property(nonatomic, strong, readwrite) DSHAgentTranscriptStore *transcripts;
@property(nonatomic, strong) DSHAgentWorkspaceToolExecutor *workspaceExecutor;
@property(nonatomic, strong) DSHAgentGitToolExecutor *gitExecutor;
- (nullable NSDictionary *)prepareAgentToolBatchLockedWithRequest:
    (NSDictionary *)request error:(NSError **)error;
@end

@implementation DSHAgentToolBatchService

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
  }
  return self;
}

- (BOOL)validatePrepareRequest:(NSDictionary *)request error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"operation_id", @"controller_cas",
        @"committed_checkpoint", @"task_id", @"conversation_id",
        @"attempt_id", @"round_id", @"round_index",
        @"expected_round_revision", @"transcript", @"root",
        @"registry_version", @"toolset_sha256", @"policy_version",
        @"expected_batch_revision", @"expected_reserved_write_bytes",
      ]) || ![request[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(request[@"operation_id"]) ||
      !DSHAgentBatchControllerCAS(request[@"controller_cas"]) ||
      !DSHAgentBatchCheckpoint(request[@"committed_checkpoint"]) ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"conversation_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(request[@"round_id"]) ||
      !DSHAgentSafeInteger(request[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(request[@"expected_round_revision"],
                          DSHAgentBatchMaximumSafeInteger, NO) ||
      !DSHAgentBatchTranscript(request[@"transcript"]) ||
      !DSHAgentBatchRoot(request[@"root"]) ||
      ![request[@"registry_version"] isEqual:@1] ||
      !DSHAgentCanonicalSHA256(request[@"toolset_sha256"]) ||
      ![request[@"policy_version"] isEqualToString:@"agent-v1"] ||
      !DSHAgentSafeInteger(request[@"expected_batch_revision"],
                          DSHAgentBatchMaximumSafeInteger, YES) ||
      !DSHAgentSafeInteger(request[@"expected_reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES)) {
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

- (NSDictionary *)prepareAgentToolBatchWithRequest:(NSDictionary *)request
                                              error:(NSError **)error {
  __block NSDictionary *result = nil;
  BOOL completed = [self.preparedStore.sessionSnapshotStore.coordinator
      performSyncWithError:^BOOL(NSError **transactionError) {
        result = [self prepareAgentToolBatchLockedWithRequest:request
                                                       error:transactionError];
        return result != nil;
      }
      error:error];
  return completed ? result : nil;
}

- (NSDictionary *)prepareAgentToolBatchLockedWithRequest:(NSDictionary *)request
                                                    error:(NSError **)error {
  if (![self validatePrepareRequest:request error:error]) return nil;
  BOOL historicalTerminal = NO;
  NSDictionary *historical = DSHAgentBatchHistoricalOperationResult(
      self.wal, @"prepare_agent_tool_batch", request, &historicalTerminal, error);
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
  NSDictionary *round = DSHAgentBatchRound(state, request);
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      self.wal, @"prepare_agent_tool_batch", request,
      request[@"task_id"], request[@"attempt_id"],
      authority[@"authority_revision"] ?: @0, error);
  if (started == nil) return nil;
  if ([started[@"status"] isEqualToString:@"replayed"] &&
      started[@"result"] != NSNull.null) return started[@"result"][@"result"];
  NSDictionary *committedSession = DSHAgentBatchCommittedSession(
      self.preparedStore, request, error);
  if (committedSession == nil ||
      ![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:error]) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started, @"E_AGENT_ROOT_STALE", NO,
        @"requery", error);
  }
  if (authority == nil || round == nil ||
      ![authority[@"state"] isEqualToString:@"prepared"] ||
      ![authority[@"root"] isEqual:request[@"root"]] ||
      ![authority[@"policy"][@"policy_version"] isEqual:request[@"policy_version"]] ||
      ![authority[@"registry"][@"toolset_sha256"] isEqual:request[@"toolset_sha256"]] ||
      ![authority[@"reserved_write_bytes"]
          isEqual:request[@"expected_reserved_write_bytes"]] ||
      ![round[@"state"] isEqualToString:@"completed"] ||
      ![round[@"row_revision"] isEqual:request[@"expected_round_revision"]] ||
      ![round[@"transcript_after"] isEqual:request[@"transcript"]] ||
      ![round[@"terminal_kind"] isEqualToString:@"tool_batch"]) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started,
        authority == nil ? @"E_AGENT_ROOT_STALE" : @"E_AGENT_CONFLICT",
        NO, @"requery", error);
  }
  if ([request[@"round_index"] unsignedIntegerValue] >= 7) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started, @"E_AGENT_ROUND_LIMIT", NO, @"none", error);
  }

  NSArray *messages = [self.transcripts nativeMessagesForTranscriptWithRequest:@{
    @"schema_version" : @1, @"attempt_id" : request[@"attempt_id"],
    @"root" : request[@"root"], @"transcript" : request[@"transcript"],
  } error:error];
  NSDictionary *assistant = messages == nil ? nil
      : DSHAgentBatchRawAssistant(messages, request[@"round_index"]);
  NSArray *rawCalls = assistant[@"tool_calls"];
  if (![rawCalls isKindOfClass:NSArray.class] || rawCalls.count == 0 ||
      rawCalls.count > 16 || rawCalls.count != [(NSArray *)round[@"calls"] count]) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started, @"E_AGENT_LEDGER", NO,
        @"wait_for_reconciliation", error);
  }
  NSMutableArray *preparedCalls = [NSMutableArray arrayWithCapacity:rawCalls.count];
  BOOL mutationBatch = NO;
  for (NSUInteger index = 0; index < rawCalls.count; index += 1) {
    NSDictionary *raw = rawCalls[index];
    NSDictionary *presentation = round[@"calls"][index];
    NSString *argumentsSHA = DSHAgentArgumentsSHA256(
        raw[@"name"], raw[@"arguments_json"], error);
    BOOL mutation = [raw[@"name"] isEqualToString:@"write_file"] ||
        [raw[@"name"] isEqualToString:@"git_commit"] ||
        [raw[@"name"] isEqualToString:@"git_push"];
    mutationBatch = mutationBatch || mutation;
    if (argumentsSHA == nil || ![raw[@"call_id"] isEqual:presentation[@"call_id"]] ||
        ![raw[@"name"] isEqual:presentation[@"name"]] ||
        ![argumentsSHA isEqual:presentation[@"arguments_sha256"]] ||
        ![presentation[@"call_index"] isEqual:@(index)]) {
      NSString *failure = DSHAgentBatchArgumentsContainBadPath(
          raw[@"name"], raw[@"arguments_json"])
          ? @"E_AGENT_BAD_PATH" : @"E_AGENT_BAD_ARGUMENTS";
      return DSHAgentBatchCommitRejected(
          self.wal, request, started, failure, mutationBatch,
          @"none", error);
    }
    NSDictionary *registryTool = DSHAgentBatchRegistryTool(authority, raw[@"name"]);
    NSString *access = registryTool == nil ? @"durable_deny" : registryTool[@"access"];
    NSDictionary *grant = [access isEqualToString:@"conversation_confirm"]
        ? DSHAgentBatchConversationGrant(
            committedSession, request[@"conversation_id"], request[@"root"],
            raw[@"name"])
        : nil;
    NSDictionary *prepared = nil;
    if (![access isEqualToString:@"durable_deny"]) {
      NSDictionary *arguments = DSHAgentParseArgumentsJSON(raw[@"arguments_json"], error);
      if (arguments == nil) {
        return DSHAgentBatchCommitRejected(
            self.wal, request, started, @"E_AGENT_BAD_ARGUMENTS", mutationBatch,
            @"none", error);
      }
      if ([raw[@"name"] isEqualToString:@"list_dir"] ||
          [raw[@"name"] isEqualToString:@"read_file"] ||
          [raw[@"name"] isEqualToString:@"write_file"]) {
        prepared = [self.workspaceExecutor prepareToolNamed:raw[@"name"]
                                                   arguments:arguments
                                                        root:request[@"root"]
                                                       error:error];
      } else {
        prepared = [self.gitExecutor prepareToolNamed:raw[@"name"]
                                             arguments:arguments
                                                  root:request[@"root"]
                                                 error:error];
      }
      if (prepared == nil) {
        NSInteger code = (error != nullptr && *error != nil) ? (*error).code : 0;
        NSString *failure = code == DSHAgentNativeStoreErrorInvalidArgument
            ? (([raw[@"name"] isEqualToString:@"list_dir"] ||
                [raw[@"name"] isEqualToString:@"read_file"] ||
                [raw[@"name"] isEqualToString:@"write_file"])
                ? @"E_AGENT_BAD_PATH" : @"E_AGENT_BAD_ARGUMENTS")
            : (code == DSHAgentNativeStoreErrorOwnerLost
                ? @"E_AGENT_ROOT_STALE" : @"E_AGENT_CAPABILITY");
        return DSHAgentBatchCommitRejected(
            self.wal, request, started, failure, mutationBatch,
            [failure isEqualToString:@"E_AGENT_ROOT_STALE"]
                ? @"requery" : @"none", error);
      }
    }
    [preparedCalls addObject:@{
      @"call_index" : @(index), @"call_id" : raw[@"call_id"],
      @"name" : raw[@"name"], @"arguments_json" : raw[@"arguments_json"],
      @"arguments_sha256" : argumentsSHA,
      @"safe_summary_key" : registryTool == nil
          ? @"agent.unknown" : registryTool[@"safe_summary_key"],
      @"access" : access,
      @"precondition" : prepared == nil ? NSNull.null : prepared[@"precondition"],
      @"reserved_write_bytes" : prepared == nil
          ? @0 : prepared[@"reserved_write_bytes"],
      @"grant_reference" : grant == nil ? NSNull.null : grant[@"grant_id"],
    }];
  }
  if (DSHAgentBatchCommittedSession(self.preparedStore, request, error) == nil) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started, @"E_AGENT_CONFLICT", mutationBatch,
        @"requery", error);
  }
  if (![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:error]) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started, @"E_AGENT_ROOT_STALE", mutationBatch,
        @"requery", error);
  }
  NSMutableSet<NSString *> *finalCapabilities = [NSMutableSet set];
  BOOL needsProjectWriteLease = NO;
  BOOL needsProjectLease = NO;
  for (NSDictionary *call in preparedCalls) {
    NSString *name = call[@"name"];
    if ([name isEqualToString:@"list_dir"] || [name isEqualToString:@"read_file"]) {
      [finalCapabilities addObject:@"file_read"];
    } else if ([name isEqualToString:@"write_file"]) {
      [finalCapabilities addObject:@"file_write"];
    } else if ([name hasPrefix:@"git_"]) {
      [finalCapabilities addObject:name];
      needsProjectLease = YES;
      if ([name isEqualToString:@"git_commit"] ||
          [name isEqualToString:@"git_push"]) needsProjectWriteLease = YES;
    }
  }
  __attribute__((objc_precise_lifetime)) DSHAgentRootFinalProof *finalProof =
      [self.preparedStore.rootResolver
          acquireFinalProofForFrozenRoot:request[@"root"]
          requiredCapabilities:finalCapabilities
          needsProjectLease:needsProjectLease
          projectWriteAccess:needsProjectWriteLease error:error];
  if (finalProof == nil) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started, @"E_AGENT_ROOT_STALE", mutationBatch,
        @"requery", error);
  }
  NSDictionary *finalAuthority = [self.preparedStore
      nativeAuthorityForTaskId:request[@"task_id"]
                     attemptId:request[@"attempt_id"] error:error];
  if (finalAuthority == nil ||
      ![finalAuthority[@"state"] isEqualToString:@"prepared"] ||
      ![finalAuthority[@"root"] isEqual:request[@"root"]] ||
      !DSHAgentBatchTranscriptCanAdvance(finalAuthority[@"transcript"],
                                         request[@"transcript"]) ||
      ![finalAuthority[@"reserved_write_bytes"]
          isEqual:request[@"expected_reserved_write_bytes"]] ||
      ![finalAuthority[@"authority_revision"]
          isEqual:started[@"record"][@"authority_revision"]] ||
      ![finalAuthority[@"policy"] isEqual:authority[@"policy"]] ||
      ![finalAuthority[@"registry"] isEqual:authority[@"registry"]]) {
    return DSHAgentBatchCommitRejected(
        self.wal, request, started, @"E_AGENT_CONFLICT", mutationBatch,
        @"requery", error);
  }
  NSDictionary *internal = @{
    @"schema_version" : @2, @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"], @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"round_revision" : request[@"expected_round_revision"],
    @"root" : request[@"root"], @"transcript" : request[@"transcript"],
    @"policy" : finalAuthority[@"policy"],
    @"expected_batch_revision" : request[@"expected_batch_revision"],
    @"expected_reserved_write_bytes" : request[@"expected_reserved_write_bytes"],
    @"calls" : preparedCalls, @"operation_id" : request[@"operation_id"],
    @"operation_request_sha256" : started[@"request_sha256"],
    @"conversation_id" : request[@"conversation_id"],
    @"controller_cas" : request[@"controller_cas"],
    @"observed_checkpoint" : request[@"committed_checkpoint"],
  };
  NSDictionary *prepared = [self.ledger prepareAgentToolBatchWithRequest:internal
                                                                    error:error];
  if (prepared == nil) {
    NSInteger nativeCode = (error != nullptr && *error != nil)
        ? (*error).code : DSHAgentNativeStoreErrorUnavailable;
    NSString *failureCode = nativeCode == DSHAgentNativeStoreErrorCapacity
        ? @"E_AGENT_CAPACITY"
        : (nativeCode == DSHAgentNativeStoreErrorConflict
            ? @"E_AGENT_CONFLICT"
            : (nativeCode == DSHAgentNativeStoreErrorInvalidArgument
                ? @"E_AGENT_BAD_ARGUMENTS"
                : (nativeCode == DSHAgentNativeStoreErrorOwnerLost
                    ? @"E_AGENT_ROOT_STALE" : @"E_AGENT_LEDGER")));
    BOOL hasMutation = NO;
    for (NSDictionary *call in preparedCalls) {
      if (([call[@"name"] isEqualToString:@"write_file"] ||
           [call[@"name"] isEqualToString:@"git_commit"] ||
           [call[@"name"] isEqualToString:@"git_push"]) &&
          ![call[@"access"] isEqualToString:@"durable_deny"]) {
        hasMutation = YES;
      }
    }
    NSDictionary *rejected = @{
      @"schema_version" : @2, @"status" : @"rejected",
      @"operation_id" : request[@"operation_id"], @"failure_code" : failureCode,
      @"expected_batch_revision" : request[@"expected_batch_revision"],
      @"expected_reserved_write_bytes" : request[@"expected_reserved_write_bytes"],
      @"result_reserved_write_bytes" : request[@"expected_reserved_write_bytes"],
      @"effect_gate" : hasMutation ? @"closed" : @"not_applicable",
      @"reservation_status" : @"unchanged", @"effect_dispatched" : @NO,
      @"retry_advice" : nativeCode == DSHAgentNativeStoreErrorCapacity
          ? @"wait_for_reconciliation"
          : ((nativeCode == DSHAgentNativeStoreErrorConflict ||
              nativeCode == DSHAgentNativeStoreErrorOwnerLost)
              ? @"requery"
              : (nativeCode == DSHAgentNativeStoreErrorInvalidArgument
                  ? @"none" : @"wait_for_reconciliation")),
    };
    if (error != nullptr) *error = nil;
    NSDictionary *commitRejected = DSHAgentNativeWALCommitOperation(
        self.wal, request[@"operation_id"], started[@"request_sha256"],
        request[@"task_id"], request[@"attempt_id"], @"rejected", @"rejected",
        @{ @"schema_version" : @2, @"kind" : @"none" }, nil,
        DSHAgentBatchSafeResult(@"prepare_agent_tool_batch", rejected), error);
    return commitRejected == nil ? nil : commitRejected[@"result"][@"result"];
  }
  NSDictionary *operationResult = prepared[@"operation_result"];
  if (![operationResult isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return operationResult;
}

static BOOL DSHAgentApprovalToken(NSDictionary *token) {
  if (!(DSHAgentExactDictionaryKeys(token, @[
    @"schema_version", @"token", @"controller_cas", @"task_id", @"attempt_id",
    @"round_id", @"round_index", @"batch_call_ids", @"batch_arguments_sha256",
    @"batch_revision", @"manifest_sha256", @"call_index", @"call_id", @"name",
    @"arguments_sha256", @"idempotency_key", @"root_fingerprint_sha256",
    @"binding_revision", @"policy_version", @"registry_version", @"access",
    @"allowed_decisions",
  ]) && [token[@"schema_version"] isEqual:@2] &&
      DSHAgentCanonicalUUID(token[@"token"]) &&
      DSHAgentBatchControllerCAS(token[@"controller_cas"]) &&
      DSHAgentCanonicalUUID(token[@"task_id"]) &&
      DSHAgentCanonicalUUID(token[@"attempt_id"]) &&
      DSHAgentCanonicalUUID(token[@"round_id"]) &&
      DSHAgentSafeInteger(token[@"round_index"], 7, YES) &&
      [token[@"batch_call_ids"] isKindOfClass:NSArray.class] &&
      [token[@"batch_arguments_sha256"] isKindOfClass:NSArray.class] &&
      [(NSArray *)token[@"batch_call_ids"] count] ==
          [(NSArray *)token[@"batch_arguments_sha256"] count] &&
      DSHAgentSafeInteger(token[@"batch_revision"],
                          DSHAgentBatchMaximumSafeInteger, NO) &&
      DSHAgentCanonicalSHA256(token[@"manifest_sha256"]) &&
      DSHAgentSafeInteger(token[@"call_index"], 15, YES) &&
      DSHAgentBoundedUTF8String(token[@"call_id"], 128, NO, nullptr) &&
      DSHAgentBoundedUTF8String(token[@"name"], 64, NO, nullptr) &&
      DSHAgentCanonicalSHA256(token[@"arguments_sha256"]) &&
      DSHAgentCanonicalSHA256(token[@"idempotency_key"]) &&
      DSHAgentCanonicalSHA256(token[@"root_fingerprint_sha256"]) &&
      DSHAgentSafeInteger(token[@"binding_revision"],
                          DSHAgentBatchMaximumSafeInteger, NO) &&
      [token[@"policy_version"] isEqualToString:@"agent-v1"] &&
      [token[@"registry_version"] isEqual:@1] &&
      ([token[@"access"] isEqualToString:@"conversation_confirm"] ||
       [token[@"access"] isEqualToString:@"confirm_once"]) &&
      [token[@"allowed_decisions"] isKindOfClass:NSArray.class])) return NO;
  NSArray *callIDs = token[@"batch_call_ids"];
  NSArray *digests = token[@"batch_arguments_sha256"];
  NSUInteger callIndex = [token[@"call_index"] unsignedIntegerValue];
  if (callIDs.count == 0 || callIDs.count > 16 || callIndex >= callIDs.count ||
      ![callIDs[callIndex] isEqual:token[@"call_id"]] ||
      ![digests[callIndex] isEqual:token[@"arguments_sha256"]] ||
      ![token[@"controller_cas"][@"task_id"] isEqual:token[@"task_id"]] ||
      ![token[@"controller_cas"][@"attempt_id"]
          isEqual:token[@"attempt_id"]]) return NO;
  NSMutableSet *seenCalls = [NSMutableSet set];
  for (NSUInteger index = 0; index < callIDs.count; index += 1) {
    if (!DSHAgentBoundedUTF8String(callIDs[index], 128, NO, nullptr) ||
        !DSHAgentCanonicalSHA256(digests[index]) ||
        [seenCalls containsObject:callIDs[index]]) return NO;
    [seenCalls addObject:callIDs[index]];
  }
  if ([token[@"access"] isEqualToString:@"confirm_once"]) {
    return [token[@"name"] isEqualToString:@"git_push"] &&
        [token[@"allowed_decisions"] isEqual:@[
          @"denied", @"allow_once", @"cancelled",
        ]];
  }
  return ([token[@"name"] isEqualToString:@"write_file"] ||
          [token[@"name"] isEqualToString:@"git_commit"]) &&
      [token[@"allowed_decisions"] isEqual:@[
        @"denied", @"allow_once", @"allow_conversation", @"cancelled",
      ]];
}

static NSDictionary *DSHAgentBatchNativeApprovalEnvelope(
    NSDictionary *state,
    NSString *tokenId,
    NSError **error) {
  NSDictionary *found = nil;
  for (NSDictionary *snapshot in state[@"operation_results"]) {
    NSDictionary *wrapper = snapshot[@"result"];
    if (![wrapper[@"result_kind"]
            isEqualToString:@"prepare_agent_tool_batch"]) continue;
    for (NSDictionary *call in wrapper[@"result"][@"receipt"][@"calls"]) {
      NSDictionary *candidate = call[@"approval_token"];
      if (![candidate isKindOfClass:NSDictionary.class] ||
          ![candidate[@"token"] isEqual:tokenId]) continue;
      if (found != nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return nil;
      }
      found = candidate;
    }
  }
  if (found == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
  }
  return found;
}

static BOOL DSHAgentBatchCanonicalEqual(id left, id right) {
  NSError *error = nil;
  NSData *leftBytes = DSHAgentCanonicalJSON(left, &error);
  NSData *rightBytes = DSHAgentCanonicalJSON(right, &error);
  return leftBytes != nil && rightBytes != nil &&
      [leftBytes isEqual:rightBytes];
}

- (NSDictionary *)bindAgentApprovalWithRequest:(NSDictionary *)request
                                           error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"operation_id", @"controller_cas",
        @"committed_checkpoint", @"task_id", @"conversation_id", @"attempt_id",
        @"round_id", @"round_index", @"manifest_sha256", @"batch_revision",
        @"call_index", @"call_id", @"token", @"decision",
      ]) || ![request[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(request[@"operation_id"]) ||
      !DSHAgentBatchControllerCAS(request[@"controller_cas"]) ||
      !DSHAgentBatchCheckpoint(request[@"committed_checkpoint"]) ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"conversation_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(request[@"round_id"]) ||
      !DSHAgentSafeInteger(request[@"round_index"], 7, YES) ||
      !DSHAgentCanonicalSHA256(request[@"manifest_sha256"]) ||
      !DSHAgentSafeInteger(request[@"batch_revision"],
                          DSHAgentBatchMaximumSafeInteger, NO) ||
      !DSHAgentSafeInteger(request[@"call_index"], 15, YES) ||
      !DSHAgentBoundedUTF8String(request[@"call_id"], 128, NO, nullptr) ||
      !DSHAgentApprovalToken(request[@"token"]) ||
      ![request[@"decision"] isKindOfClass:NSString.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *token = request[@"token"];
  BOOL tokenRelationValid = [token[@"task_id"] isEqual:request[@"task_id"]] &&
      [token[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
      [token[@"round_id"] isEqual:request[@"round_id"]] &&
      [token[@"round_index"] isEqual:request[@"round_index"]] &&
      [token[@"batch_revision"] isEqual:request[@"batch_revision"]] &&
      [token[@"manifest_sha256"] isEqual:request[@"manifest_sha256"]] &&
      [token[@"call_index"] isEqual:request[@"call_index"]] &&
      [token[@"call_id"] isEqual:request[@"call_id"]] &&
      [token[@"allowed_decisions"] containsObject:request[@"decision"]] &&
      !([request[@"decision"] isEqualToString:@"allow_conversation"] &&
        [token[@"access"] isEqualToString:@"confirm_once"]);
  /* Exact relationship failures are committed below after the native
     operation relation is started, so they replay as immutable conflicts. */
  BOOL historicalTerminal = NO;
  NSDictionary *historical = DSHAgentBatchHistoricalOperationResult(
      self.wal, @"bind_agent_approval", request, &historicalTerminal, error);
  if (historicalTerminal) return historical;
  NSDictionary *state = [self.wal snapshotWithError:error];
  NSDictionary *authority = nil;
  for (NSDictionary *candidate in state[@"authorities"]) {
    if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
        [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
      authority = candidate;
      break;
    }
  }
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      self.wal, @"bind_agent_approval", request, request[@"task_id"],
      request[@"attempt_id"], authority[@"authority_revision"] ?: @0, error);
  if (started == nil) return nil;
  if ([started[@"status"] isEqualToString:@"replayed"] &&
      started[@"result"] != NSNull.null) return started[@"result"][@"result"];
  if (!tokenRelationValid) {
    return DSHAgentBatchCommitApprovalConflict(
        self.wal, request, started, request[@"batch_revision"], @"pending",
        error);
  }
  NSDictionary *session = DSHAgentBatchCommittedSession(
      self.preparedStore, request, error);
  NSDictionary *persistedConversation = nil;
  NSDictionary *persistedCall = session == nil ? nil
      : DSHAgentBatchPersistedApprovalCall(session, request,
                                           &persistedConversation);
  id persistedToken = persistedCall[@"approval_token"];
  id persistedReference = persistedCall[@"approval_reference"];
  BOOL persistedAllowed = [request[@"decision"] hasPrefix:@"allow_"];
  if (persistedCall == nil ||
      ![persistedCall[@"approval_decision"] isEqual:request[@"decision"]] ||
      (persistedAllowed && ![persistedToken isEqual:token[@"token"]]) ||
      (!persistedAllowed && persistedToken != NSNull.null) ||
      (persistedAllowed &&
       !DSHAgentCanonicalUUID(persistedReference)) ||
      (!persistedAllowed &&
       persistedReference != NSNull.null) ||
      !DSHAgentBatchApprovalEventMatches(session, request, persistedCall)) {
    return DSHAgentBatchCommitApprovalConflict(
        self.wal, request, started, request[@"batch_revision"], @"pending",
        error);
  }
  NSDictionary *nativeToken = state == nil ? nil
      : DSHAgentBatchNativeApprovalEnvelope(state, token[@"token"], error);
  if (nativeToken == nil ||
      !DSHAgentBatchCanonicalEqual(nativeToken, token)) {
    return DSHAgentBatchCommitApprovalConflict(
        self.wal, request, started, request[@"batch_revision"], @"pending",
        error);
  }
  if (authority == nil ||
      ![self.preparedStore validatePreparedRoot:authority[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:error]) {
    return DSHAgentBatchCommitApprovalConflict(
        self.wal, request, started, request[@"batch_revision"], @"pending",
        error);
  }
  NSDictionary *batch = nil;
  for (NSDictionary *candidate in state[@"batches"]) {
    if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
        [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
        [candidate[@"round_id"] isEqual:request[@"round_id"]] &&
        [candidate[@"round_index"] isEqual:request[@"round_index"]] &&
        [candidate[@"batch_revision"] isEqual:request[@"batch_revision"]]) {
      batch = candidate;
    }
  }
  if (authority == nil || batch == nil ||
      ![authority[@"root"][@"root_fingerprint_sha256"]
          isEqual:token[@"root_fingerprint_sha256"]] ||
      ![authority[@"root"][@"workspace_binding_revision"]
          isEqual:token[@"binding_revision"]]) {
    return DSHAgentBatchCommitApprovalConflict(
        self.wal, request, started, batch[@"batch_revision"], @"pending",
        error);
  }
  NSDictionary *manifestCall = nil;
  NSDictionary *intentRow = nil;
  for (NSDictionary *candidate in batch[@"manifest_calls"]) {
    NSDictionary *locator = candidate[@"locator"];
    if ([locator[@"call_index"] isEqual:request[@"call_index"]] &&
        [locator[@"call_id"] isEqual:request[@"call_id"]] &&
        [locator[@"idempotency_key"] isEqual:token[@"idempotency_key"]]) {
      manifestCall = candidate;
      break;
    }
  }
  for (NSDictionary *candidate in state[@"ledger"]) {
    if ([candidate[@"locator"] isEqual:manifestCall[@"locator"]]) {
      intentRow = candidate;
      break;
    }
  }
  NSString *preconditionSHA = intentRow == nil ? nil
      : DSHAgentHJ(@"tool-precondition", @{
          @"schema_version" : @1, @"name" : intentRow[@"name"],
          @"precondition" : intentRow[@"precondition"],
        }, error);
  if (manifestCall == nil || intentRow == nil ||
      ![intentRow[@"state"] isEqualToString:@"intent"] ||
      ![intentRow[@"name"] isEqual:token[@"name"]] ||
      ![intentRow[@"arguments_sha256"]
          isEqual:token[@"arguments_sha256"]] ||
      ![manifestCall[@"precondition_sha256"] isEqual:preconditionSHA]) {
    return DSHAgentBatchCommitApprovalConflict(
        self.wal, request, started, batch[@"batch_revision"], @"pending",
        error);
  }
  if (DSHAgentBatchCommittedSession(self.preparedStore, request, error) == nil) {
    return DSHAgentBatchCommitApprovalConflict(
        self.wal, request, started, batch[@"batch_revision"], @"pending",
        error);
  }
  NSDictionary *priorBinding = nil;
  for (NSDictionary *snapshot in state[@"operation_results"]) {
    NSDictionary *candidate = snapshot[@"result"][@"result"];
    if (([candidate[@"status"] isEqualToString:@"bound"] ||
         [candidate[@"status"] isEqualToString:@"already_bound"]) &&
        [candidate[@"task_id"] isEqual:request[@"task_id"]] &&
        [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
        [candidate[@"round_id"] isEqual:request[@"round_id"]] &&
        [candidate[@"call_index"] isEqual:request[@"call_index"]] &&
        [candidate[@"call_id"] isEqual:request[@"call_id"]]) {
      priorBinding = candidate;
      break;
    }
  }
  if (priorBinding != nil &&
      ![priorBinding[@"decision"] isEqual:request[@"decision"]]) {
    NSDictionary *conflict = @{
      @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"],
      @"failure_code" : @"E_AGENT_APPROVAL",
      @"expected_batch_revision" : request[@"batch_revision"],
      @"actual_batch_revision" : priorBinding[@"result_batch_revision"],
      @"actual_decision" : priorBinding[@"decision"],
      @"observed_checkpoint" : request[@"committed_checkpoint"],
    };
    NSDictionary *committedConflict = DSHAgentNativeWALCommitOperation(
        self.wal, request[@"operation_id"], started[@"request_sha256"],
        request[@"task_id"], request[@"attempt_id"], @"conflict", @"conflict",
        @{ @"schema_version" : @2, @"kind" : @"none" }, nil,
        DSHAgentBatchSafeResult(@"bind_agent_approval", conflict), error);
    return committedConflict == nil ? nil : committedConflict[@"result"][@"result"];
  }
  BOOL allowed = [request[@"decision"] hasPrefix:@"allow_"];
  NSString *approvalReference = priorBinding == nil
      ? (allowed ? persistedReference : nil)
      : (priorBinding[@"approval_reference"] == NSNull.null
          ? nil : priorBinding[@"approval_reference"]);
  NSDictionary *grant = nil;
  if (priorBinding[@"grant"] != nil && priorBinding[@"grant"] != NSNull.null) {
    grant = priorBinding[@"grant"];
  } else if ([request[@"decision"] isEqualToString:@"allow_conversation"]) {
    NSString *family = [token[@"name"] isEqualToString:@"git_commit"]
        ? @"git_commit" : @"file_write";
    for (NSDictionary *candidate in persistedConversation[@"agent_grants"]) {
      if ([candidate[@"conversation_id"] isEqual:request[@"conversation_id"]] &&
          [candidate[@"workspace_id"] isEqual:authority[@"root"][@"workspace_id"]] &&
          [candidate[@"project_id"] isEqual:authority[@"root"][@"project_id"]] &&
          [candidate[@"binding_revision"]
              isEqual:authority[@"root"][@"workspace_binding_revision"]] &&
          [candidate[@"root_fingerprint_sha256"]
              isEqual:authority[@"root"][@"root_fingerprint_sha256"]] &&
          [candidate[@"tool_family"] isEqual:family] &&
          [candidate[@"registry_version"] isEqual:@1] &&
          [candidate[@"policy_version"] isEqualToString:@"agent-v1"]) {
        grant = candidate;
        break;
      }
    }
    if (grant == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
  }
  NSDictionary *result = @{
    @"schema_version" : @2,
    @"status" : priorBinding == nil ? @"bound" : @"already_bound",
    @"operation_id" : request[@"operation_id"],
    @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"], @"call_index" : request[@"call_index"],
    @"call_id" : request[@"call_id"], @"decision" : request[@"decision"],
    @"approval_reference" : approvalReference ?: NSNull.null,
    @"grant" : grant ?: NSNull.null,
    @"result_batch_revision" : request[@"batch_revision"],
    @"observed_checkpoint" : request[@"committed_checkpoint"],
  };
  NSDictionary *resultRef = @{
    @"schema_version" : @2, @"kind" : @"approval",
    @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
    @"call_index" : request[@"call_index"], @"call_id" : request[@"call_id"],
    @"batch_revision" : request[@"batch_revision"],
  };
  NSDictionary *commit = DSHAgentNativeWALCommitOperation(
      self.wal, request[@"operation_id"], started[@"request_sha256"],
      request[@"task_id"], request[@"attempt_id"], @"committed", result[@"status"],
      resultRef, request[@"batch_revision"],
      DSHAgentBatchSafeResult(@"bind_agent_approval", result), error);
  return commit == nil ? nil : commit[@"result"][@"result"];
}

@end
