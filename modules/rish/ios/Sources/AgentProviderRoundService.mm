#import "AgentProviderRoundService.h"
#import "AgentProviderRoundServiceInternals.h"
#import "AgentToolRegistry.h"
#import "DSHCompletionV2.h"
#import "DSHWorkspaceCanonical.h"
#import "RishHarnessCatalog.h"

@interface DSHAgentProviderRoundService ()
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@property(nonatomic, strong, readwrite) DSHAgentPreparedAttemptStore *preparedStore;
@property(nonatomic, strong, readwrite) DSHAgentTranscriptStore *transcripts;
@property(nonatomic, strong, readwrite) DSHAgentRoundJournal *rounds;
@property(nonatomic, strong, readwrite) DSHCompletionProviderTransport *transport;
@property(nonatomic, strong, readwrite) DSHCompletionProviderTransport *claudeTransport;
@property(nonatomic, strong, readwrite) DSHCompletionProviderTransport *codexTransport;
@property(nonatomic, strong, readwrite) DSHCompletionProviderTransport *glmTransport;
@property(nonatomic, copy) DSHAgentProviderRoundCredentialProvider credentialProvider;
@property(nonatomic, copy) DSHAgentProviderRoundVisibleHistoryProvider visibleHistoryProvider;
@property(nonatomic, copy) DSHAgentProviderRoundContextReceiptProvider contextReceiptProvider;
@property(nonatomic, strong) NSMutableDictionary<NSString *, DSHAgentProviderRoundContext *> *contexts;
- (nullable NSDictionary *)commitStartedOperationForRequest:(NSDictionary *)request
                                                 requestSHA:(NSString *)requestSHA
                                                       row:(nullable NSDictionary *)row
                                                     status:(NSString *)status
                                              failureCode:(NSString *)failureCode
                                                     error:(NSError **)error;
- (nullable NSDictionary *)roundProjectionForCompletedRow:(NSDictionary *)row
                                                   request:(NSDictionary *)request
                                                    error:(NSError **)error;
- (nullable NSDictionary *)publicResultForCompletedRow:(NSDictionary *)row
                                                request:(NSDictionary *)request
                                                 error:(NSError **)error;
- (nullable NSDictionary *)completeAgentRoundV2WithRequest:(NSDictionary *)rawRequest
                                                     error:(NSError **)error
                                         retryFailedRound:(BOOL)retryFailedRound;
@end
@implementation DSHAgentProviderRoundService
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
               preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                  transcripts:(DSHAgentTranscriptStore *)transcripts
                       rounds:(DSHAgentRoundJournal *)rounds
                    transport:(DSHCompletionProviderTransport *)transport {
  return [self initWithWAL:wal
              preparedStore:preparedStore
                 transcripts:transcripts
                      rounds:rounds
                   transport:transport
            claudeTransport:nil
             codexTransport:nil
        credentialProvider:nil
     visibleHistoryProvider:nil
      contextReceiptProvider:nil];
}
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                   transcripts:(DSHAgentTranscriptStore *)transcripts
                        rounds:(DSHAgentRoundJournal *)rounds
                     transport:(DSHCompletionProviderTransport *)transport
          credentialProvider:(DSHAgentProviderRoundCredentialProvider)credentialProvider
       visibleHistoryProvider:(DSHAgentProviderRoundVisibleHistoryProvider)visibleHistoryProvider {
  return [self initWithWAL:wal
              preparedStore:preparedStore
                 transcripts:transcripts
                      rounds:rounds
                   transport:transport
            claudeTransport:nil
             codexTransport:nil
        credentialProvider:credentialProvider
     visibleHistoryProvider:visibleHistoryProvider
      contextReceiptProvider:nil];
}
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                   transcripts:(DSHAgentTranscriptStore *)transcripts
                        rounds:(DSHAgentRoundJournal *)rounds
                     transport:(DSHCompletionProviderTransport *)transport
          credentialProvider:(DSHAgentProviderRoundCredentialProvider)credentialProvider
       visibleHistoryProvider:(DSHAgentProviderRoundVisibleHistoryProvider)visibleHistoryProvider
       contextReceiptProvider:(DSHAgentProviderRoundContextReceiptProvider)contextReceiptProvider {
  return [self initWithWAL:wal
              preparedStore:preparedStore
                 transcripts:transcripts
                      rounds:rounds
                   transport:transport
            claudeTransport:nil
             codexTransport:nil
        credentialProvider:credentialProvider
     visibleHistoryProvider:visibleHistoryProvider
      contextReceiptProvider:contextReceiptProvider];
}

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                   transcripts:(DSHAgentTranscriptStore *)transcripts
                        rounds:(DSHAgentRoundJournal *)rounds
                     transport:(DSHCompletionProviderTransport *)transport
              claudeTransport:(DSHCompletionProviderTransport *)claudeTransport
               codexTransport:(DSHCompletionProviderTransport *)codexTransport
          credentialProvider:(DSHAgentProviderRoundCredentialProvider)credentialProvider
       visibleHistoryProvider:(DSHAgentProviderRoundVisibleHistoryProvider)visibleHistoryProvider
       contextReceiptProvider:(DSHAgentProviderRoundContextReceiptProvider)contextReceiptProvider {
  return [self initWithWAL:wal
              preparedStore:preparedStore
                 transcripts:transcripts
                      rounds:rounds
                   transport:transport
            claudeTransport:claudeTransport
             codexTransport:codexTransport
               glmTransport:nil
        credentialProvider:credentialProvider
     visibleHistoryProvider:visibleHistoryProvider
      contextReceiptProvider:contextReceiptProvider];
}

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                   transcripts:(DSHAgentTranscriptStore *)transcripts
                        rounds:(DSHAgentRoundJournal *)rounds
                     transport:(DSHCompletionProviderTransport *)transport
              claudeTransport:(DSHCompletionProviderTransport *)claudeTransport
               codexTransport:(DSHCompletionProviderTransport *)codexTransport
                 glmTransport:(DSHCompletionProviderTransport *)glmTransport
          credentialProvider:(DSHAgentProviderRoundCredentialProvider)credentialProvider
       visibleHistoryProvider:(DSHAgentProviderRoundVisibleHistoryProvider)visibleHistoryProvider
       contextReceiptProvider:(DSHAgentProviderRoundContextReceiptProvider)contextReceiptProvider {
  self = [super init];
  if (self != nil) {
    _wal = wal;
    _preparedStore = preparedStore;
    _transcripts = transcripts;
    _rounds = rounds;
    _transport = transport;
    _claudeTransport = claudeTransport;
    _codexTransport = codexTransport;
    _glmTransport = glmTransport;
    _credentialProvider = [credentialProvider copy];
    _visibleHistoryProvider = [visibleHistoryProvider copy];
    _contextReceiptProvider = [contextReceiptProvider copy];
    _contexts = [NSMutableDictionary dictionary];
  }
  return self;
}

- (nullable DSHCompletionProviderTransport *)transportForRequest:(NSDictionary *)request {
  id rawHarness = request[@"harness_id"];
  if (rawHarness != nil && ![rawHarness isKindOfClass:NSString.class]) return nil;
  NSString *harnessId = rawHarness ?: @"dsh";
  if (![DSHHarnessIdForModel(request[@"model"]) isEqual:harnessId]) return nil;
  DSHCompletionProviderTransport *selected = nil;
  if ([harnessId isEqualToString:@"dsh"]) selected = self.transport;
  else if ([harnessId isEqualToString:@"claude-code"]) selected = self.claudeTransport;
  else if ([harnessId isEqualToString:@"codex"]) selected = self.codexTransport;
  else if ([harnessId isEqualToString:@"glm"]) selected = self.glmTransport;
  if (selected == nil ||
      ![[selected providerHarnessId] isEqual:harnessId] ||
      ![selected providerSupportsModel:request[@"model"]]) return nil;
  return selected;
}

- (nullable NSDictionary *)commitStartedOperationForRequest:(NSDictionary *)request
                                                 requestSHA:(NSString *)requestSHA
                                                       row:(nullable NSDictionary *)row
                                                     status:(NSString *)status
                                              failureCode:(NSString *)failureCode
                                                     error:(NSError **)error {
  NSDictionary *result = nil;
  NSDictionary *resultRef = nil;
  NSNumber *resultRevision = (id)NSNull.null;
  if ([status isEqualToString:@"conflict"]) {
    NSDictionary *actualTranscript = [row isKindOfClass:NSDictionary.class]
        ? ((id)row[@"transcript_after"] == NSNull.null
            ? row[@"transcript_before"] : row[@"transcript_after"])
        : request[@"transcript"];
    result = DSHProviderConflictResult(
        request[@"operation_id"], failureCode ?: @"E_AGENT_CONFLICT", request,
        [row isKindOfClass:NSDictionary.class]
            ? (row[@"row_revision"] ?: @0)
            : request[@"expected_round_revision"],
        [row isKindOfClass:NSDictionary.class]
            ? (row[@"state"] ?: @"unknown")
            : @"in_flight",
        actualTranscript);
    resultRef = @{ @"schema_version" : @2, @"kind" : @"none" };
  } else if ([row isKindOfClass:NSDictionary.class]) {
    result = DSHProviderRoundResultForRow(request, row, status, failureCode);
    resultRef = @{
      @"schema_version" : @2, @"kind" : @"round",
      @"task_id" : request[@"task_id"],
      @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"],
      @"round_index" : request[@"round_index"],
      @"round_revision" : row[@"row_revision"] ?: @0,
    };
    resultRevision = row[@"row_revision"] ?: @0;
  } else if ([status isEqualToString:@"conflict"]) {
    result = DSHProviderConflictResult(
        request[@"operation_id"], failureCode, request,
        request[@"expected_round_revision"], @"in_flight",
        request[@"transcript"]);
    resultRef = @{ @"schema_version" : @2, @"kind" : @"none" };
  } else {
    result = DSHProviderUnknownResult(
        request, status, [request[@"expected_round_revision"] unsignedIntegerValue],
        failureCode);
    resultRef = @{ @"schema_version" : @2, @"kind" : @"none" };
  }
  NSDictionary *safeResult = DSHProviderOperationSafeResult(result);
  return DSHAgentNativeWALCommitOperation(
      self.wal, request[@"operation_id"], requestSHA,
      request[@"task_id"], request[@"attempt_id"], status, status,
      resultRef, resultRevision, safeResult, error);
}

- (nullable NSDictionary *)publicResultForCompletedRow:(NSDictionary *)row
                                                request:(NSDictionary *)request
                                                 error:(NSError **)error {
  NSDictionary *after = row[@"transcript_after"];
  NSDictionary *round = [self roundProjectionForCompletedRow:row
                                                       request:request
                                                        error:error];
  if (round == nil) return nil;
  NSString *kind = round[@"kind"];
  NSDictionary *outcome = nil;
  if ([kind isEqualToString:@"final"]) {
    outcome = @{
      @"schema_version" : @3,
      @"kind" : @"final",
      @"finish_reason" : @"stop",
      @"completion_receipt" : round[@"completion_receipt"],
      @"transcript" : round[@"transcript"],
      @"text" : round[@"text"],
      @"reasoning" : round[@"reasoning"],
    };
  } else if ([kind isEqualToString:@"tool_batch"]) {
    outcome = @{
      @"schema_version" : @3,
      @"kind" : @"tool_batch",
      @"finish_reason" : @"tool_calls",
      @"completion_receipt" : round[@"completion_receipt"],
      @"transcript" : round[@"transcript"],
      @"calls" : round[@"calls"],
      @"batch_class" : round[@"batch_class"],
      @"executable_call_count" : round[@"executable_call_count"],
      @"denied_call_count" : round[@"denied_call_count"],
      @"reasoning" : round[@"reasoning"],
    };
  } else {
    outcome = @{
      @"schema_version" : @3,
      @"kind" : @"blocked",
      @"finish_reason" : round[@"finish_reason"],
      @"completion_receipt" : round[@"completion_receipt"],
      @"transcript" : round[@"transcript"],
      @"failure_code" : round[@"failure_code"],
    };
  }
  return @{
    @"schema_version" : @2,
    @"status" : @"completed",
    @"operation_id" : request[@"operation_id"],
    @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"launch_attempt" : row[@"launch_attempt"],
    @"result_round_revision" : row[@"row_revision"],
    @"transcript" : after,
    @"outcome" : outcome,
  };
}

- (nullable NSDictionary *)roundProjectionForCompletedRow:(NSDictionary *)row
                                                   request:(NSDictionary *)request
                                                    error:(NSError **)error {
  NSDictionary *after = row[@"transcript_after"];
  if (![after isKindOfClass:NSDictionary.class] || self.transcripts == nil) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSArray *messages = [self.transcripts
      nativeMessagesForTranscriptWithRequest:@{
        @"schema_version" : @1,
        @"attempt_id" : request[@"attempt_id"],
        @"root" : request[@"root"],
        @"transcript" : after,
      }
      error:error];
  if (messages == nil) return nil;
  return DSHProviderRecoveredRoundProjection(row, request, messages, error);
}

- (nullable NSDictionary *)completeAgentRoundV2WithRequest:(NSDictionary *)rawRequest
                                                     error:(NSError **)error {
  return [self completeAgentRoundV2WithRequest:rawRequest
                                          error:error
                              retryFailedRound:NO];
}

- (nullable NSDictionary *)retryFailedAgentRoundV2WithRequest:(NSDictionary *)rawRequest
                                                         error:(NSError **)error {
  return [self completeAgentRoundV2WithRequest:rawRequest
                                          error:error
                              retryFailedRound:YES];
}

- (nullable NSDictionary *)completeAgentRoundV2WithRequest:(NSDictionary *)rawRequest
                                                     error:(NSError **)error
                                         retryFailedRound:(BOOL)retryFailedRound {
  NSError *requestError = nil;
  NSDictionary *request = DSHProviderRoundRequestCopy(rawRequest, &requestError);
  if (request == nil || ![DSHAgentRootResolver
                             validateAgentRootProjection:request[@"root"]
                                                    error:&requestError]) {
    if (error != nullptr) *error = requestError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  // Operation replay is deliberately resolved before touching the injected
  // history provider, protected transcript, credential provider, or body
  // builder. A started record may be promoted only when the journal and
  // protected transcript prove a completed round; otherwise it remains an
  // unknown recovery case and is never treated as provider success.
  NSError *operationError = nil;
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"complete_agent_round_v2",
    @"request" : request,
  }, &operationError);
  if (requestSHA == nil) {
    if (error != nullptr) *error = operationError;
    return nil;
  }
  NSDictionary *operationQuery = DSHAgentNativeWALQueryOperation(
      self.wal, request[@"operation_id"], requestSHA, request[@"task_id"],
      request[@"attempt_id"], &operationError);
  if (operationQuery == nil) {
    if (error != nullptr) *error = operationError;
    return nil;
  }
  if ([operationQuery[@"status"] isEqualToString:@"conflict"]) {
    if (error != nullptr) *error = nil;
    return DSHProviderConflictResult(
        request[@"operation_id"], @"E_AGENT_CONFLICT", request,
        request[@"expected_round_revision"], @"in_flight", request[@"transcript"]);
  }
  if ([operationQuery[@"status"] isEqualToString:@"found"] &&
      [operationQuery[@"record"][@"state"] isEqualToString:@"started"]) {
    NSDictionary *roundQuery = self.rounds == nil ? nil :
        [self.rounds queryAgentRoundV3WithLocator:DSHProviderRoundLocator(request)
                                             error:nil];
    NSDictionary *roundRow = roundQuery[@"row"];
    if ([roundRow[@"state"] isEqualToString:@"completed"]) {
      NSError *recoveryError = nil;
      NSDictionary *recovered = [self publicResultForCompletedRow:roundRow
                                                           request:request
                                                              error:&recoveryError];
      if (recovered != nil) {
        NSDictionary *safeResult = DSHProviderOperationSafeResult(recovered);
        NSDictionary *resultRef = @{
          @"schema_version" : @2, @"kind" : @"round",
          @"task_id" : request[@"task_id"],
          @"attempt_id" : request[@"attempt_id"],
          @"round_id" : request[@"round_id"],
          @"round_index" : request[@"round_index"],
          @"round_revision" : roundRow[@"row_revision"],
        };
        NSDictionary *committed = DSHAgentNativeWALCommitOperation(
            self.wal, request[@"operation_id"], requestSHA,
            request[@"task_id"], request[@"attempt_id"], @"committed",
            @"completed", resultRef, roundRow[@"row_revision"], safeResult,
            &recoveryError);
        if (committed != nil) {
          if (error != nullptr) *error = nil;
          return recovered;
        }
      }
    }
    BOOL ownerAlive = [roundRow[@"owner"] isKindOfClass:NSDictionary.class] &&
        [self.wal isNativeTaskAlive:roundRow[@"owner"][@"native_task_id"]
                             launchId:roundRow[@"owner"][@"launch_id"]];
    BOOL knownTerminalRow = [roundRow[@"state"] isEqualToString:@"failed_retryable"] ||
        [roundRow[@"state"] isEqualToString:@"cancelled"] ||
        [roundRow[@"state"] isEqualToString:@"unknown"] ||
        [roundRow[@"state"] isEqualToString:@"ambiguous"] ||
        ([roundRow[@"state"] isEqualToString:@"completed"] && !ownerAlive);
    if (knownTerminalRow) {
      NSString *operationStatus = [roundRow[@"state"] isEqualToString:@"ambiguous"]
          ? @"ambiguous" : @"unknown";
      NSString *failureCode = [roundRow[@"state"] isEqualToString:@"cancelled"]
          ? @"E_AGENT_CANCELLED"
          : ([roundRow[@"state"] isEqualToString:@"failed_retryable"] ||
             [roundRow[@"state"] isEqualToString:@"unknown"]
                 ? @"E_AGENT_PERSISTENCE" : @"E_AGENT_ROUND_AMBIGUOUS");
      NSError *commitError = nil;
      NSDictionary *committed = [self
          commitStartedOperationForRequest:request
                               requestSHA:requestSHA
                                     row:roundRow
                                   status:operationStatus
                            failureCode:failureCode
                                   error:&commitError];
      if (committed != nil) {
        if (error != nullptr) *error = nil;
        return DSHProviderRoundResultForRow(
            request, roundRow, operationStatus, failureCode);
      }
    }
    if (error != nullptr) *error = nil;
    return DSHProviderUnknownResult(
        request, @"unknown", [request[@"expected_round_revision"] unsignedIntegerValue],
        @"E_AGENT_ROUND_AMBIGUOUS");
  }
  if ([operationQuery[@"status"] isEqualToString:@"found"]) {
    NSError *replayError = nil;
    NSDictionary *replayEnvelope = DSHAgentNativeWALStartOperation(
        self.wal, @"complete_agent_round_v2", request, request[@"task_id"],
        request[@"attempt_id"], operationQuery[@"record"][@"authority_revision"],
        &replayError);
    NSDictionary *safeEnvelope = replayEnvelope[@"result"];
    NSDictionary *replayed = [safeEnvelope isKindOfClass:NSDictionary.class]
        ? safeEnvelope[@"result"] : nil;
    if ([replayEnvelope[@"status"] isEqualToString:@"replayed"] &&
        [replayed isKindOfClass:NSDictionary.class]) {
      if (error != nullptr) *error = nil;
      return replayed;
    }
    if (error != nullptr) *error = replayError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorPersistence);
    return nil;
  }
  NSError *authorityError = nil;
  NSDictionary *authority = [self.preparedStore nativeAuthorityForTaskId:
      request[@"task_id"] attemptId:request[@"attempt_id"] error:&authorityError];
  if (authority == nil ||
      ![authority[@"task_id"] isEqual:request[@"task_id"]] ||
      ![authority[@"conversation_id"] isEqual:request[@"conversation_id"]] ||
      ![authority[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
      ![authority[@"root"] isEqual:request[@"root"]] ||
      ![authority[@"transcript"] isEqual:request[@"transcript"]] ||
      ![authority[@"transport_schema_version"]
          isEqual:request[@"transport_schema_version"]] ||
      ![authority[@"project_context_sha256"]
          isEqual:request[@"project_context_sha256"]] ||
      ![authority[@"registry"][@"toolset_sha256"]
          isEqual:request[@"toolset_sha256"]] ||
      ![authority[@"model"] isEqual:request[@"model"]] ||
      ![authority[@"thinking_mode"] isEqual:request[@"thinking_mode"]] ||
      ![authority[@"visible_history_sha256"]
          isEqual:request[@"visible_history_sha256"]] ||
      ![authority[@"visible_message_count"]
          isEqual:request[@"visible_message_count"]]) {
    if (error != nullptr) *error = nil;
    return DSHProviderConflictResult(
        request[@"operation_id"], @"E_AGENT_CONFLICT", request,
        request[@"expected_round_revision"], @"in_flight", request[@"transcript"]);
  }
  NSError *rootError = nil;
  if (![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:&rootError]) {
    if (error != nullptr) *error = nil;
    return DSHProviderConflictResult(
        request[@"operation_id"], @"E_AGENT_ROOT_STALE", request,
        request[@"expected_round_revision"], @"in_flight", request[@"transcript"]);
  }
  NSDictionary *contextReceipt = nil;
  NSArray *contextMessages = @[];
  if ([request[@"transport_schema_version"] isEqual:@3]) {
    NSError *contextError = nil;
    NSDictionary *contextBundle = nil;
    @try {
      contextBundle = self.contextReceiptProvider == nil
          ? nil : self.contextReceiptProvider(authority, &contextError);
    } @catch (__unused NSException *exception) {
      contextReceipt = nil;
    }
    if (!DSHProviderContextBundle(contextBundle,
                                  request[@"project_context_sha256"],
                                  &contextReceipt, &contextMessages,
                                  &contextError)) {
      if (error != nullptr) *error = contextError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorConflict);
      return nil;
    }
  }
  NSDictionary *operationStart = DSHAgentNativeWALStartOperation(
      self.wal, @"complete_agent_round_v2", request, request[@"task_id"],
      request[@"attempt_id"], authority[@"authority_revision"], &operationError);
  if (operationStart == nil) {
    if (error != nullptr) *error = operationError;
    return nil;
  }
  if ([operationStart[@"status"] isEqualToString:@"replayed"]) {
    NSDictionary *safeEnvelope = operationStart[@"result"];
    NSDictionary *replayed = [safeEnvelope isKindOfClass:NSDictionary.class]
        ? safeEnvelope[@"result"] : nil;
    if ([replayed isKindOfClass:NSDictionary.class]) {
      if (error != nullptr) *error = nil;
      return replayed;
    }
    DSHSetProviderError(error, DSHAgentNativeStoreErrorPersistence);
    return nil;
  }
  NSString *harnessId = [request[@"harness_id"] isKindOfClass:NSString.class]
      ? request[@"harness_id"] : @"dsh";
  DSHCompletionProviderTransport *providerTransport =
      [self transportForRequest:request];
  if (self.visibleHistoryProvider == nil || providerTransport == nil ||
      self.rounds == nil || self.transcripts == nil) {
    NSError *commitError = nil;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:nil
                                         status:@"ambiguous"
                                  failureCode:@"E_AGENT_PERSISTENCE"
                                         error:&commitError] == nil) {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    DSHSetProviderError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  NSError *historyError = nil;
  NSArray *visibleHistory = nil;
  @try {
    visibleHistory = self.visibleHistoryProvider(authority, &historyError);
  } @catch (__unused NSException *exception) {
    visibleHistory = nil;
  }
  if (![visibleHistory isKindOfClass:NSArray.class]) {
    NSError *commitError = nil;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:nil
                                         status:@"ambiguous"
                                  failureCode:@"E_AGENT_PERSISTENCE"
                                         error:&commitError] == nil) {
      if (error != nullptr) *error = commitError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    if (error != nullptr) *error = historyError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSError *visibleDigestError = nil;
  NSString *visibleHistoryDigest = DSHAgentHJ(
      @"visible-history", @{ @"messages" : visibleHistory }, &visibleDigestError);
  if (visibleHistoryDigest == nil ||
      ![visibleHistoryDigest isEqual:request[@"visible_history_sha256"]] ||
      ![visibleHistoryDigest isEqual:authority[@"visible_history_sha256"]]) {
    NSError *commitError = nil;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:nil
                                         status:@"conflict"
                                  failureCode:@"E_AGENT_CONFLICT"
                                         error:&commitError] == nil) {
      if (error != nullptr) *error = commitError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    if (error != nullptr) *error = nil;
    return DSHProviderConflictResult(
        request[@"operation_id"], @"E_AGENT_CONFLICT", request,
        request[@"expected_round_revision"], @"in_flight", request[@"transcript"]);
  }
  NSError *transcriptError = nil;
  NSArray *nativeMessages = [self.transcripts
      nativeMessagesForTranscriptWithRequest:@{
        @"schema_version" : @1,
        @"attempt_id" : request[@"attempt_id"],
        @"root" : request[@"root"],
        @"transcript" : request[@"transcript"],
      }
      error:&transcriptError];
  if (nativeMessages == nil) {
    NSError *commitError = nil;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:nil
                                         status:@"ambiguous"
                                  failureCode:@"E_AGENT_TRANSCRIPT"
                                         error:&commitError] == nil) {
      if (error != nullptr) *error = commitError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    if (error != nullptr) *error = transcriptError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSArray *priorTranscript = DSHProviderTranscriptForBody(
      nativeMessages, [request[@"round_index"] unsignedIntegerValue],
      request[@"thinking_mode"], &transcriptError);
  if (priorTranscript == nil) {
    NSError *commitError = nil;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:nil
                                         status:@"ambiguous"
                                  failureCode:@"E_AGENT_TRANSCRIPT"
                                         error:&commitError] == nil) {
      if (error != nullptr) *error = commitError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    if (error != nullptr) *error = transcriptError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSMutableArray *messages = [NSMutableArray arrayWithArray:contextMessages];
  [messages addObjectsFromArray:visibleHistory];
  [messages addObjectsFromArray:priorTranscript];
  NSError *toolsError = nil;
  NSArray *tools = DSHProviderToolsForAuthority(
      authority, self.preparedStore.toolRegistry, &toolsError);
  NSError *bodyBuildError = nil;
  NSDictionary *body = tools == nil ? nil : [providerTransport
      providerRequestBodyForModel:request[@"model"]
                     thinkingMode:request[@"thinking_mode"]
                         messages:messages
                            tools:tools
                        streaming:NO
                            error:&bodyBuildError];
  if (body == nil && bodyBuildError != nil) toolsError = bodyBuildError;
  NSData *bodyData = body == nil ? nil : [NSJSONSerialization
      dataWithJSONObject:body options:NSJSONWritingSortedKeys error:&toolsError];
  if (bodyData == nil || bodyData.length == 0 || bodyData.length > 40 * 1024 * 1024) {
    NSError *commitError = nil;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:nil
                                         status:@"ambiguous"
                                  failureCode:@"E_AGENT_TRANSCRIPT"
                                         error:&commitError] == nil) {
      if (error != nullptr) *error = commitError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    if (error != nullptr) *error = toolsError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  // The provider transport hashes the model-input array it receives.  Pass
  // the actual provider messages (visible history plus protected prior tool
  // rounds), never a metadata-only surrogate.
  NSArray *modelInput = [messages copy];
  NSString *actualVisibleTransportDigest = DSHProviderJSONSHA256(
      visibleHistory, &toolsError);
  NSString *actualModelInputDigest = DSHProviderJSONSHA256(modelInput, &toolsError);
  NSString *actualBodyDigest = DSHWorkspaceSHA256Hex(bodyData);
  if (!DSHProviderDigest(actualVisibleTransportDigest) ||
      !DSHProviderDigest(actualModelInputDigest) ||
      !DSHProviderDigest(actualBodyDigest)) {
    NSError *commitError = nil;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:nil
                                         status:@"ambiguous"
                                  failureCode:@"E_AGENT_TRANSCRIPT"
                                         error:&commitError] == nil) {
      if (error != nullptr) *error = commitError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    if (error != nullptr) *error = toolsError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *locator = DSHProviderRoundLocator(request);
  NSDictionary *retryRow = nil;
  if (retryFailedRound) {
    NSDictionary *retryQuery = [self.rounds
        queryAgentRoundV3WithLocator:locator error:&operationError];
    retryRow = retryQuery[@"row"];
    NSUInteger previousLaunchAttempt = [retryRow[@"launch_attempt"] unsignedIntegerValue];
    BOOL retryShape = [retryRow isKindOfClass:NSDictionary.class] &&
        [retryRow[@"state"] isEqualToString:@"failed_retryable"] &&
        [retryRow[@"row_revision"] isEqual:request[@"expected_round_revision"]] &&
        previousLaunchAttempt < 8 &&
        [request[@"launch_attempt"] unsignedIntegerValue] ==
            previousLaunchAttempt + 1;
    if (!retryShape) {
      NSDictionary *conflict = DSHProviderConflictResult(
          request[@"operation_id"], @"E_AGENT_CONFLICT", request,
          retryRow[@"row_revision"] ?: @0,
          retryRow[@"state"] ?: @"unknown",
          (id)retryRow[@"transcript_after"] == NSNull.null
              ? retryRow[@"transcript_before"] : retryRow[@"transcript_after"]);
      NSError *commitError = nil;
      if ([self commitStartedOperationForRequest:request
                                       requestSHA:requestSHA
                                             row:retryRow
                                           status:@"conflict"
                                    failureCode:@"E_AGENT_CONFLICT"
                                           error:&commitError] == nil) {
        if (error != nullptr) *error = commitError ?: DSHAgentNativeStoreError(
            DSHAgentNativeStoreErrorPersistence);
        return nil;
      }
      if (error != nullptr) *error = nil;
      return conflict;
    }
  }
  NSString *nativeTaskId = NSUUID.UUID.UUIDString.lowercaseString;
  if (![self.wal registerNativeTaskId:nativeTaskId error:&operationError]) {
    NSError *commitError = nil;
    (void)[self commitStartedOperationForRequest:request
                                        requestSHA:requestSHA
                                              row:nil
                                            status:@"ambiguous"
                                     failureCode:@"E_AGENT_PERSISTENCE"
                                            error:&commitError];
    if (error != nullptr) *error = operationError;
    return nil;
  }
  NSDictionary *owner = DSHProviderOwner(self.wal, request[@"task_id"], nativeTaskId);
  NSDictionary *persistedRow = nil;
  if (retryFailedRound) {
    NSDictionary *claimed = [self.rounds
        claimAgentRoundV3WithLocator:locator
                 expectedRowRevision:retryRow[@"row_revision"]
                                owner:owner
                                error:&operationError];
    if (claimed == nil) {
      NSError *commitError = nil;
      NSString *status = operationError.code == DSHAgentNativeStoreErrorConflict
          ? @"conflict" : @"ambiguous";
      NSString *failure = [status isEqualToString:@"conflict"]
          ? @"E_AGENT_CONFLICT" : @"E_AGENT_PERSISTENCE";
      (void)[self commitStartedOperationForRequest:request
                                          requestSHA:requestSHA
                                                row:[status isEqualToString:@"conflict"]
                                                    ? retryRow : nil
                                              status:status
                                       failureCode:failure
                                              error:&commitError];
      [self.wal unregisterNativeTaskId:nativeTaskId error:nil];
      if ([status isEqualToString:@"conflict"]) {
        if (error != nullptr) *error = nil;
        return DSHProviderConflictResult(
            request[@"operation_id"], failure, request,
            retryRow[@"row_revision"] ?: @0,
            retryRow[@"state"] ?: @"unknown",
            (id)retryRow[@"transcript_after"] == NSNull.null
                ? retryRow[@"transcript_before"] : retryRow[@"transcript_after"]);
      }
      if (error != nullptr) *error = operationError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    persistedRow = claimed[@"row"];
  } else {
    NSString *now = self.wal.currentTimestamp;
    NSDictionary *round = @{
      @"schema_version" : @3,
      @"locator" : locator,
      @"row_revision" : @1,
      @"root_fingerprint_sha256" : request[@"root"][@"root_fingerprint_sha256"],
      @"binding_revision" : request[@"root"][@"workspace_binding_revision"],
      @"request_sha256" : requestSHA,
      @"transcript_before" : request[@"transcript"],
      @"launch_attempt" : request[@"launch_attempt"],
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
      @"created_at" : now,
      @"updated_at" : now,
    };
    NSDictionary *insertCAS = @{
      @"schema_version" : @1,
      @"locator" : locator,
      @"expected_absent" : @YES,
      @"expected_transcript_generation" : request[@"transcript"][@"generation"],
      @"expected_transcript_sha256" : request[@"transcript"][@"transcript_sha256"],
      @"expected_root_fingerprint_sha256" : request[@"root"][@"root_fingerprint_sha256"],
      @"expected_binding_revision" : request[@"root"][@"workspace_binding_revision"],
    };
    NSDictionary *created = [self.rounds createAgentRoundV3WithInsertCAS:insertCAS
                                                            exactRoundStart:round
                                                                      error:&operationError];
    if (created == nil) {
      NSError *commitError = nil;
      (void)[self commitStartedOperationForRequest:request
                                          requestSHA:requestSHA
                                                row:nil
                                              status:@"ambiguous"
                                       failureCode:@"E_AGENT_PERSISTENCE"
                                              error:&commitError];
      [self.wal unregisterNativeTaskId:nativeTaskId error:nil];
      if (error != nullptr) *error = operationError;
      return nil;
    }
    persistedRow = created[@"row"];
  }
  NSDictionary *dispatchCAS = DSHProviderRoundCASForRow(persistedRow);
  NSError *credentialError = nil;
  NSUInteger credentialGeneration = 0;
  NSString *credential = nil;
  @try {
    credential = self.credentialProvider == nil
        ? nil : self.credentialProvider(harnessId, &credentialGeneration);
  } @catch (__unused NSException *exception) {
    credential = nil;
  }
  if (![credential isKindOfClass:NSString.class] || credential.length == 0) {
    // No provider request was dispatched; proof-gated cancellation is safe.
    NSDictionary *cancelled = [self.rounds cancelAgentRoundV3WithCAS:dispatchCAS
                                                                  error:&credentialError];
    NSError *commitError = nil;
    NSDictionary *row = cancelled[@"row"] ?: persistedRow;
    if ([self commitStartedOperationForRequest:request
                                     requestSHA:requestSHA
                                           row:row
                                         status:@"ambiguous"
                                  failureCode:@"E_AGENT_PERSISTENCE"
                                         error:&commitError] == nil &&
        credentialError == nil) {
      credentialError = commitError;
    }
    [self.wal unregisterNativeTaskId:nativeTaskId error:nil];
    if (error != nullptr) *error = credentialError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  NSString *providerRequestErrorCode = nil;
  NSString *providerRequestId = [providerTransport nextProviderRequestId:
      &providerRequestErrorCode];
  if (providerRequestId == nil) {
    NSError *commitError = nil;
    (void)[self commitStartedOperationForRequest:request
                                        requestSHA:requestSHA
                                              row:persistedRow
                                            status:@"ambiguous"
                                     failureCode:@"E_AGENT_PERSISTENCE"
                                            error:&commitError];
    [self.wal unregisterNativeTaskId:nativeTaskId error:nil];
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorPersistence);
    return nil;
  }
  NSDictionary *dispatched = [self.rounds markAgentRoundV3DispatchedWithCAS:
      dispatchCAS error:&operationError];
  if (dispatched == nil) {
    NSError *commitError = nil;
    (void)[self commitStartedOperationForRequest:request
                                        requestSHA:requestSHA
                                              row:persistedRow
                                            status:@"ambiguous"
                                     failureCode:@"E_AGENT_PERSISTENCE"
                                            error:&commitError];
    [self.wal unregisterNativeTaskId:nativeTaskId error:nil];
    if (error != nullptr) *error = operationError;
    return nil;
  }
  NSDictionary *activeCAS = DSHProviderRoundCASForRow(dispatched[@"row"]);
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  NSString *contextKey = DSHProviderLocatorKey(locator);
  DSHAgentProviderRoundContext *context = [[DSHAgentProviderRoundContext alloc] init];
  context.nativeTaskId = nativeTaskId;
  context.locator = locator;
  context.cas = activeCAS;
  context.semaphore = semaphore;
  if (contextKey != nil) @synchronized (self) { self.contexts[contextKey] = context; }
  __block BOOL redirected = NO;
  NSURLSessionDataTask *task = [providerTransport
      startRequestWithSchemaVersion:[request[@"transport_schema_version"] integerValue]
                              roundId:request[@"round_id"]
                            generation:1
                  credentialGeneration:credentialGeneration
                   providerRequestId:providerRequestId
                         credential:credential
                     requestedModel:request[@"model"]
                      thinkingMode:request[@"thinking_mode"]
       credentialGenerationIsCurrent:^BOOL(NSUInteger expectedGeneration) {
         NSUInteger currentGeneration = 0;
         NSString *currentCredential = nil;
         @try {
           currentCredential = self.credentialProvider == nil
               ? nil : self.credentialProvider(harnessId, &currentGeneration);
         } @catch (__unused NSException *exception) {
           currentCredential = nil;
         }
         return currentCredential.length > 0 && currentGeneration == expectedGeneration;
       }
                            startedAt:NSProcessInfo.processInfo.systemUptime
                           bodyData:bodyData
                       visibleHistory:visibleHistory
                           modelInput:modelInput
                             bindTask:^BOOL(NSURLSessionDataTask *candidate) {
                               return candidate != nil;
                             }
                           claimRound:^BOOL(BOOL *redirectedOut) {
                             NSDictionary *roundQuery = [self.rounds
                                 queryAgentRoundV3WithLocator:locator error:nil];
                             NSDictionary *currentRow = roundQuery[@"row"];
                             NSDictionary *currentOwner = currentRow[@"owner"];
                             BOOL ownerMatches = [currentOwner isKindOfClass:NSDictionary.class] &&
                                 [currentOwner[@"task_id"] isEqual:request[@"task_id"]] &&
                                 [currentOwner[@"launch_id"] isEqual:self.wal.launchId] &&
                                 [currentOwner[@"native_task_id"] isEqual:nativeTaskId] &&
                                 [currentOwner[@"owner_generation"] isEqual:@1] &&
                                 [self.wal isNativeTaskAlive:nativeTaskId
                                                     launchId:self.wal.launchId];
                             BOOL stateCurrent = [currentRow[@"state"] isEqualToString:@"in_flight"] ||
                                 [currentRow[@"state"] isEqualToString:@"cancel_requested"];
                             BOOL revisionCurrent = [currentRow[@"row_revision"]
                                 isEqual:activeCAS[@"expected_row_revision"]];
                             if (redirectedOut != nullptr) *redirectedOut = redirected;
                             return currentRow != nil && ownerMatches && stateCurrent &&
                                 revisionCurrent;
                           }
                        markRedirected:^(NSURLSessionDataTask * __unused candidate) {
                          redirected = YES;
                          @synchronized (context) { context.redirected = YES; }
                        }
                     redirectDecision:^(BOOL rejected) {
                       @synchronized (context) { context.redirectRejected = rejected; }
                     }
                          completion:^(NSDictionary *result, NSString *errorCode) {
                            DSHProviderFinishContext(context, result, errorCode);
                          }];
  @synchronized (context) { context.task = task; }
  if (context.finished && task != nil) [providerTransport cancelTask:task];
  dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, 120LL * NSEC_PER_SEC);
  BOOL signaled = dispatch_semaphore_wait(semaphore, deadline) == 0;
  if (!signaled && task != nil) [providerTransport cancelTask:task];
  if (contextKey != nil) @synchronized (self) { [self.contexts removeObjectForKey:contextKey]; }
  [self.wal unregisterNativeTaskId:nativeTaskId error:nil];
  NSDictionary *providerResult = nil;
  NSString *providerErrorCode = nil;
  @synchronized (context) {
    providerResult = [context.providerResult copy];
    providerErrorCode = [context.providerErrorCode copy];
  }
  NSDictionary *latestRoundQuery = [self.rounds queryAgentRoundV3WithLocator:
      locator error:nil];
  NSDictionary *latestRow = latestRoundQuery[@"row"];
  NSDictionary *effectiveCAS = [latestRow isKindOfClass:NSDictionary.class]
      ? DSHProviderRoundCASForRow(latestRow) : activeCAS;
  BOOL providerCorrelationMatches = providerResult != nil &&
      [(providerResult[@"harness_id"] ?: @"dsh") isEqual:harnessId] &&
      DSHProviderResultMatchesRequest(providerResult, request, providerRequestId);
  BOOL providerDigestsMatch = providerResult != nil &&
      [providerResult[@"visible_history_sha256"] isEqual:actualVisibleTransportDigest] &&
      [providerResult[@"model_input_sha256"] isEqual:actualModelInputDigest] &&
      [providerResult[@"request_body_sha256"] isEqual:actualBodyDigest];
  if (!signaled || providerResult == nil || providerErrorCode != nil ||
      !providerCorrelationMatches || !providerDigestsMatch) {
    NSDictionary *reconciled = [self.rounds reconcileAgentRoundV3OwnerLossWithLocator:
        locator expectedCAS:effectiveCAS error:&operationError];
    NSDictionary *row = reconciled[@"row"] ?: persistedRow;
    BOOL digestMismatch = providerResult != nil &&
        (!providerDigestsMatch || !providerCorrelationMatches);
    NSDictionary *unknown = DSHProviderRoundResultForRow(
        request, row, @"ambiguous",
        DSHProviderFailureCode(providerErrorCode, digestMismatch));
    NSDictionary *safeResult = DSHProviderOperationSafeResult(unknown);
    NSDictionary *resultRef = @{
      @"schema_version" : @2, @"kind" : @"round",
      @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
      @"round_revision" : row[@"row_revision"] ?: @1,
    };
    NSDictionary *operationCommit = DSHAgentNativeWALCommitOperation(
        self.wal, request[@"operation_id"], requestSHA,
        request[@"task_id"], request[@"attempt_id"], @"ambiguous", @"ambiguous",
        resultRef, row[@"row_revision"] ?: @1, safeResult, &operationError);
    if (operationCommit == nil) {
      if (error != nullptr) *error = operationError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorPersistence);
      return nil;
    }
    if (error != nullptr) *error = nil;
    return unknown;
  }
  NSString *finishReason = providerResult[@"finish_reason"];
  NSArray *providerCalls = [providerResult[@"tool_calls"] isKindOfClass:NSArray.class]
      ? providerResult[@"tool_calls"] : @[];
  NSMutableArray *nativeCalls = [NSMutableArray array];
  NSMutableArray *presentations = [NSMutableArray array];
  for (NSUInteger index = 0; index < providerCalls.count; index += 1) {
    if (![providerCalls[index] isKindOfClass:NSDictionary.class]) {
      NSError *commitError = nil;
      NSDictionary *row = [self.rounds
          queryAgentRoundV3WithLocator:locator error:nil][@"row"];
      (void)[self commitStartedOperationForRequest:request
                                          requestSHA:requestSHA
                                                row:row
                                              status:@"ambiguous"
                                       failureCode:@"E_AGENT_TRANSCRIPT"
                                              error:&commitError];
      DSHSetProviderError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    NSDictionary *call = providerCalls[index];
    NSString *name = call[@"name"];
    NSString *arguments = call[@"arguments"];
    if (!DSHProviderOpaqueId(call[@"id"]) ||
        !DSHAgentBoundedUTF8String(name, 64, NO, nullptr) ||
        !DSHAgentBoundedUTF8String(arguments, DSHCompletionV2MaxArgumentsBytes,
                                   NO, nullptr)) {
      NSError *commitError = nil;
      NSDictionary *row = [self.rounds
          queryAgentRoundV3WithLocator:locator error:nil][@"row"];
      (void)[self commitStartedOperationForRequest:request
                                          requestSHA:requestSHA
                                                row:row
                                              status:@"ambiguous"
                                       failureCode:@"E_AGENT_TRANSCRIPT"
                                              error:&commitError];
      DSHSetProviderError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    NSError *argumentError = nil;
    NSString *argumentsSHA = DSHAgentArgumentsSHA256(name, arguments, &argumentError);
    NSDictionary *presentation = [self.preparedStore.toolRegistry
        descriptorForToolName:name root:request[@"root"] error:&argumentError];
    if (argumentsSHA == nil || presentation == nil) {
      NSError *commitError = nil;
      NSDictionary *row = [self.rounds
          queryAgentRoundV3WithLocator:locator error:nil][@"row"];
      (void)[self commitStartedOperationForRequest:request
                                          requestSHA:requestSHA
                                                row:row
                                              status:@"ambiguous"
                                       failureCode:@"E_AGENT_TRANSCRIPT"
                                              error:&commitError];
      DSHSetProviderError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    [nativeCalls addObject:@{
      @"schema_version" : @3,
      @"call_index" : @(index),
      @"call_id" : call[@"id"],
      @"name" : name,
      @"arguments_sha256" : argumentsSHA,
      @"safe_summary_key" : presentation[@"safe_summary_key"],
      @"access" : presentation[@"access"],
      @"approval_state" : [presentation[@"access"] isEqualToString:@"durable_deny"]
          ? @"durable_denied" : @"deferred",
    }];
    [presentations addObject:@{
      @"call_id" : call[@"id"],
      @"name" : name,
      @"arguments" : arguments,
    }];
  }
  NSDictionary *providerMessage = @{
    @"schema_version" : @1,
    @"role" : @"assistant",
    @"round_index" : request[@"round_index"],
    @"content" : providerResult[@"text"] ?: @"",
    @"reasoning_content" : providerResult[@"reasoning"] ?: @"",
    @"tool_calls" : [presentations copy],
  };
  NSError *messageError = nil;
  NSDictionary *nativeMessage = DSHProviderNativeToCompletionMessage(
      providerMessage, &messageError);
  if (nativeMessage == nil) {
    NSError *commitError = nil;
    NSDictionary *row = [self.rounds
        queryAgentRoundV3WithLocator:locator error:nil][@"row"];
    (void)[self commitStartedOperationForRequest:request
                                        requestSHA:requestSHA
                                              row:row
                                            status:@"ambiguous"
                                     failureCode:@"E_AGENT_TRANSCRIPT"
                                            error:&commitError];
    if (error != nullptr) *error = messageError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *nativeReceipt = @{
    @"schema_version" : @1,
    @"transport_schema_version" : request[@"transport_schema_version"],
    @"turn_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"harness_id" : [providerResult[@"harness_id"] isKindOfClass:NSString.class]
        ? providerResult[@"harness_id"]
        : ([request[@"harness_id"] isKindOfClass:NSString.class]
            ? request[@"harness_id"] : @"dsh"),
    @"provider_request_id" : providerRequestId,
    @"provider_response_id" : providerResult[@"provider_response_id"],
    @"requested_model" : request[@"model"],
    @"model" : request[@"model"],
    @"thinking_mode" : request[@"thinking_mode"],
    @"finish_reason" : finishReason,
    @"latency_ms" : providerResult[@"latency_ms"] ?: @0,
    @"visible_history_sha256" : providerResult[@"visible_history_sha256"] ?: request[@"visible_history_sha256"],
    @"model_input_sha256" : providerResult[@"model_input_sha256"],
    @"request_body_sha256" : providerResult[@"request_body_sha256"],
    @"project_context_receipt" : contextReceipt ?: NSNull.null,
  };
  if (providerResult[@"provider_configuration"] != nil) {
    NSMutableDictionary *boundReceipt = [nativeReceipt mutableCopy];
    boundReceipt[@"provider_configuration"] = providerResult[@"provider_configuration"];
    nativeReceipt = boundReceipt;
  }
  NSString *terminalKind = [finishReason isEqualToString:@"stop"] ? @"final" :
      ([finishReason isEqualToString:@"tool_calls"] ? @"tool_batch" : @"blocked");
  NSDictionary *completed = [self.rounds completeAgentRoundV3WithLocator:locator
                                                                expectedCAS:effectiveCAS
                                                                   messages:@[ nativeMessage ]
                                                          completionReceipt:nativeReceipt
                                                               terminalKind:terminalKind
                                                                     calls:nativeCalls
                                                                      root:request[@"root"]
                                                                      error:&operationError];
  if (completed == nil) {
    NSError *commitError = nil;
    NSDictionary *row = [self.rounds
        queryAgentRoundV3WithLocator:locator error:nil][@"row"];
    (void)[self commitStartedOperationForRequest:request
                                        requestSHA:requestSHA
                                              row:row
                                            status:@"ambiguous"
                                     failureCode:@"E_AGENT_PERSISTENCE"
                                            error:&commitError];
    if (error != nullptr) *error = operationError;
    return nil;
  }
  NSDictionary *after = completed[@"transcript"];
  NSDictionary *publicReceipt = DSHProviderPublicReceipt(providerResult, request,
                                                          providerRequestId,
                                                          contextReceipt);
  NSDictionary *outcome = nil;
  if ([finishReason isEqualToString:@"stop"]) {
    outcome = @{
      @"schema_version" : @3, @"kind" : @"final", @"finish_reason" : @"stop",
      @"completion_receipt" : publicReceipt, @"transcript" : after,
      @"text" : providerResult[@"text"] ?: @"", @"reasoning" : providerResult[@"reasoning"] ?: @"",
    };
  } else if ([finishReason isEqualToString:@"tool_calls"]) {
    NSUInteger denied = 0;
    for (NSDictionary *call in nativeCalls) {
      if ([call[@"access"] isEqualToString:@"durable_deny"]) denied += 1;
    }
    outcome = @{
      @"schema_version" : @3, @"kind" : @"tool_batch", @"finish_reason" : @"tool_calls",
      @"completion_receipt" : publicReceipt, @"transcript" : after,
      @"calls" : [nativeCalls copy],
      @"batch_class" : denied == 0 ? @"executable" : denied == nativeCalls.count ? @"denied_only" : @"mixed",
      @"executable_call_count" : @(nativeCalls.count - denied),
      @"denied_call_count" : @(denied),
      @"reasoning" : providerResult[@"reasoning"] ?: @"",
    };
  } else {
    NSString *failure = [finishReason isEqualToString:@"length"]
        ? @"E_COMPLETION_LENGTH" : @"E_COMPLETION_CONTENT_FILTER";
    outcome = @{
      @"schema_version" : @3, @"kind" : @"blocked", @"finish_reason" : finishReason,
      @"completion_receipt" : publicReceipt, @"transcript" : after,
      @"failure_code" : failure,
    };
  }
  NSDictionary *publicResult = @{
    @"schema_version" : @2,
    @"status" : @"completed",
    @"operation_id" : request[@"operation_id"],
    @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"launch_attempt" : request[@"launch_attempt"],
    @"result_round_revision" : completed[@"row"][@"row_revision"],
    @"transcript" : after,
    @"outcome" : outcome,
  };
  NSDictionary *safeResult = DSHProviderOperationSafeResult(publicResult);
  NSDictionary *resultRef = @{
    @"schema_version" : @2, @"kind" : @"round",
    @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
    @"round_revision" : completed[@"row"][@"row_revision"],
  };
  NSDictionary *committed = DSHAgentNativeWALCommitOperation(
      self.wal, request[@"operation_id"], requestSHA, request[@"task_id"],
      request[@"attempt_id"], @"committed", @"completed", resultRef,
      completed[@"row"][@"row_revision"], safeResult, &operationError);
  if (committed == nil) {
    if (error != nullptr) *error = operationError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorPersistence);
    return nil;
  }
  if (error != nullptr) *error = nil;
  return publicResult;
}
- (nullable NSDictionary *)queryAgentRoundWithRequest:(NSDictionary *)request
                                                error:(NSError **)error {
  NSError *requestError = nil;
  if (!DSHProviderSelectorRequest(request, NO, YES, &requestError)) {
    if (error != nullptr) *error = requestError;
    return nil;
  }
  NSError *rootError = nil;
  if (self.preparedStore == nil ||
      ![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:&rootError]) {
    if (error != nullptr) *error = nil;
    return DSHProviderSelectorConflict(request, @{
      @"row_revision" : request[@"expected_round_revision"],
      @"state" : @"unknown",
      @"transcript_before" : request[@"transcript"],
    }, @"E_AGENT_ROOT_STALE");
  }
  NSDictionary *locator = DSHProviderRoundLocator(request);
  NSDictionary *result = [self.rounds queryAgentRoundV3WithLocator:locator error:error];
  if (result == nil) return nil;
  NSDictionary *row = result[@"row"];
  if (![row isKindOfClass:NSDictionary.class]) {
    if (![request[@"expected_round_revision"] isEqual:@0]) {
      if (error != nullptr) *error = nil;
      return DSHProviderSelectorConflict(request, @{
        @"row_revision" : @0, @"state" : @"unknown",
        @"transcript_before" : request[@"transcript"],
      }, @"E_AGENT_CONFLICT");
    }
    return @{ @"schema_version" : @2, @"status" : @"not_started" };
  }
  if (!DSHProviderSelectorMatchesRow(request, row)) {
    if (error != nullptr) *error = nil;
    return DSHProviderSelectorConflict(request, row, @"E_AGENT_CONFLICT");
  }
  NSString *status = row[@"state"];
  if ([status isEqualToString:@"completed"]) {
    NSMutableDictionary *queryResult = [DSHProviderQueryResultForRow(
        request, row, @"completed", nil) mutableCopy];
    NSDictionary *projection = [self roundProjectionForCompletedRow:row
                                                            request:request
                                                             error:nil];
    if (projection != nil) queryResult[@"completed_round"] = projection;
    return [queryResult copy];
  }
  return DSHProviderQueryResultForRow(request, row, status,
      [status isEqualToString:@"ambiguous"] ? @"E_AGENT_ROUND_AMBIGUOUS" :
      ([status isEqualToString:@"unknown"] ? @"E_AGENT_PERSISTENCE" : nil));
}
- (nullable NSDictionary *)recoverAgentRoundWithRequest:(NSDictionary *)request
                                                   error:(NSError **)error {
  NSError *requestError = nil;
  if (!DSHProviderSelectorRequest(request, NO, NO, &requestError)) {
    if (error != nullptr) *error = requestError;
    return nil;
  }
  NSError *rootError = nil;
  if (self.preparedStore == nil ||
      ![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:&rootError]) {
    if (error != nullptr) *error = nil;
    return DSHProviderSelectorConflict(request, @{
      @"row_revision" : request[@"expected_round_revision"],
      @"state" : @"unknown",
      @"transcript_before" : request[@"transcript"],
    }, @"E_AGENT_ROOT_STALE");
  }
  NSDictionary *locator = DSHProviderRoundLocator(request);
  NSDictionary *query = [self.rounds queryAgentRoundV3WithLocator:locator error:error];
  NSDictionary *row = query[@"row"];
  if (![row isKindOfClass:NSDictionary.class]) return query;
  if (!DSHProviderSelectorMatchesRow(request, row)) {
    if (error != nullptr) *error = nil;
    return DSHProviderSelectorConflict(request, row, @"E_AGENT_CONFLICT");
  }
  NSDictionary *owner = row[@"owner"];
  if ((id)owner == NSNull.null) {
    NSString *state = row[@"state"];
    if ([state isEqualToString:@"completed"] ||
        [state isEqualToString:@"cancelled"] ||
        [state isEqualToString:@"failed_retryable"] ||
        [state isEqualToString:@"unknown"] ||
        [state isEqualToString:@"ambiguous"]) {
      NSString *failure = [state isEqualToString:@"cancelled"]
          ? @"E_AGENT_CANCELLED"
          : ([state isEqualToString:@"ambiguous"]
                 ? @"E_AGENT_ROUND_AMBIGUOUS"
                 : ([state isEqualToString:@"unknown"] ||
                    [state isEqualToString:@"failed_retryable"]
                        ? @"E_AGENT_PERSISTENCE" : nil));
      NSMutableDictionary *result = [DSHProviderQueryResultForRow(
          request, row, state, failure) mutableCopy];
      if ([state isEqualToString:@"completed"]) {
        NSDictionary *projection = [self roundProjectionForCompletedRow:row
                                                                request:request
                                                                 error:nil];
        if (projection != nil) result[@"completed_round"] = projection;
      }
      return [result copy];
    }
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if ([self.wal isNativeTaskAlive:owner[@"native_task_id"]
                          launchId:owner[@"launch_id"]]) {
    return DSHProviderQueryResultForRow(request, row, @"in_flight", nil);
  }
  NSDictionary *cas = DSHProviderRoundCASForRow(row);
  NSDictionary *reconciled = [self.rounds
      reconcileAgentRoundV3OwnerLossWithLocator:locator expectedCAS:cas error:error];
  NSDictionary *reconciledRow = reconciled[@"row"] ?: row;
  NSString *status = reconciledRow[@"state"];
  return DSHProviderQueryResultForRow(
      request, reconciledRow, status,
      [status isEqualToString:@"failed_retryable"] ? @"E_AGENT_PERSISTENCE" :
      @"E_AGENT_ROUND_AMBIGUOUS");
}
- (nullable NSDictionary *)cancelAgentRoundWithRequest:(NSDictionary *)request
                                                  error:(NSError **)error {
  NSError *requestError = nil;
  if (!DSHProviderSelectorRequest(request, YES, NO, &requestError)) {
    if (error != nullptr) *error = requestError;
    return nil;
  }
  NSError *rootError = nil;
  if (self.preparedStore == nil ||
      ![self.preparedStore validatePreparedRoot:request[@"root"]
                                         taskId:request[@"task_id"]
                                      attemptId:request[@"attempt_id"]
                                           error:&rootError]) {
    if (error != nullptr) *error = nil;
    return DSHProviderSelectorConflict(request, @{
      @"row_revision" : request[@"expected_round_revision"],
      @"state" : @"unknown",
      @"transcript_before" : request[@"transcript"],
    }, @"E_AGENT_ROOT_STALE");
  }
  NSDictionary *locator = DSHProviderRoundLocator(request);
  NSDictionary *query = [self.rounds queryAgentRoundV3WithLocator:locator error:error];
  NSDictionary *row = query[@"row"];
  if (![row isKindOfClass:NSDictionary.class]) return query;
  if (!DSHProviderSelectorMatchesRow(request, row)) {
    if (error != nullptr) *error = nil;
    return DSHProviderSelectorConflict(request, row, @"E_AGENT_CONFLICT");
  }
  NSDictionary *cas = DSHProviderRoundCASForRow(row);
  NSString *key = DSHProviderLocatorKey(locator);
  DSHAgentProviderRoundContext *context = nil;
  if (key != nil) @synchronized (self) { context = self.contexts[key]; }
  if (context != nil) {
    if (context.task != nil) {
      [self.transport cancelTask:context.task];
      [self.claudeTransport cancelTask:context.task];
      [self.codexTransport cancelTask:context.task];
      [self.glmTransport cancelTask:context.task];
    }
    BOOL signal = NO;
    @synchronized (context) {
      if (!context.finished) {
        context.finished = YES;
        context.providerErrorCode = @"E_AGENT_CANCELLED";
        signal = YES;
      }
    }
    if (signal && context.semaphore != nil) dispatch_semaphore_signal(context.semaphore);
  }
  NSDictionary *cancelled = [self.rounds cancelAgentRoundV3WithCAS:cas error:error];
  NSDictionary *cancelledRow = cancelled[@"row"] ?: row;
  NSString *status = cancelledRow[@"state"];
  return DSHProviderQueryResultForRow(
      request, cancelledRow, status,
      [status isEqualToString:@"cancelled"] ? @"E_AGENT_CANCELLED" : nil);
}
@end
