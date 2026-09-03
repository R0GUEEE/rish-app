#import "AgentRuntimeCoordinator.h"

#import "AgentExecutionLedger.h"
#import "AgentNativeWAL.h"
#import "AgentPreparedAttemptStore.h"
#import "AgentProviderRoundService.h"
#import "AgentRoundJournal.h"
#import "AgentToolBatchService.h"
#import "AgentToolExecutionService.h"
#import "AgentTranscriptStore.h"

@interface DSHAgentProviderRoundService (DSHRuntimeAvailability)
@property(nonatomic, copy, readonly)
    DSHAgentProviderRoundCredentialProvider credentialProvider;
@property(nonatomic, copy, readonly)
    DSHAgentProviderRoundVisibleHistoryProvider visibleHistoryProvider;
@property(nonatomic, copy, readonly)
    DSHAgentProviderRoundContextReceiptProvider contextReceiptProvider;
@end

@interface DSHAgentToolExecutionService (DSHRuntimeAvailability)
@property(nonatomic, strong, readonly) DSHAgentNativeWAL *wal;
@property(nonatomic, strong, readonly) DSHAgentExecutionLedger *ledger;
@property(nonatomic, strong, readonly) DSHAgentPreparedAttemptStore *preparedStore;
@property(nonatomic, strong, readonly) DSHAgentTranscriptStore *transcripts;
@end

static NSDictionary *DSHRuntimeRequest(id request, NSArray<NSString *> *keys,
                                       NSError **error) {
  NSDictionary *copy = DSHAgentImmutableJSONCopy(request, error);
  if (![copy isKindOfClass:NSDictionary.class] ||
      !DSHAgentExactDictionaryKeys(copy, keys) ||
      ![copy[@"schema_version"] isEqual:@2]) {
    DSHSetAgentNativeStoreError(error,
                                DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return copy;
}

static NSDictionary *DSHRuntimeTarget(NSDictionary *request) {
  id value = request[@"target"];
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSString *DSHRuntimeChildOperationID(NSString *operationId,
                                            NSString *purpose,
                                            NSError **error) {
  NSString *digest = DSHAgentHJ(@"agent-child-operation", @{
    @"operation_id" : operationId, @"purpose" : purpose,
  }, error);
  if (digest.length != 64) return nil;
  NSMutableString *hex = [[digest substringToIndex:32] mutableCopy];
  [hex replaceCharactersInRange:NSMakeRange(12, 1) withString:@"4"];
  unichar variant = [hex characterAtIndex:16];
  NSUInteger nibble = 0;
  if (variant >= '0' && variant <= '9') nibble = variant - '0';
  else nibble = 10 + variant - 'a';
  [hex replaceCharactersInRange:NSMakeRange(16, 1)
                      withString:[NSString stringWithFormat:@"%lx",
                                  (unsigned long)((nibble & 0x3) | 0x8)]];
  return [NSString stringWithFormat:@"%@-%@-%@-%@-%@",
      [hex substringWithRange:NSMakeRange(0, 8)],
      [hex substringWithRange:NSMakeRange(8, 4)],
      [hex substringWithRange:NSMakeRange(12, 4)],
      [hex substringWithRange:NSMakeRange(16, 4)],
      [hex substringWithRange:NSMakeRange(20, 12)]];
}

static NSDictionary *DSHRuntimeReferenceForRow(NSDictionary *row) {
  id after = row[@"transcript_after"];
  return after == NSNull.null || after == nil ? row[@"transcript_before"] : after;
}

static NSDictionary *DSHRuntimeExecutionCAS(NSDictionary *row) {
  NSDictionary *owner = row[@"owner"];
  BOOL owned = [owner isKindOfClass:NSDictionary.class];
  return @{
    @"schema_version" : @2,
    @"locator" : row[@"locator"],
    @"expected_row_revision" : row[@"row_revision"],
    @"expected_state" : row[@"state"],
    @"expected_owner_generation" : owned
        ? owner[@"owner_generation"] : NSNull.null,
    @"expected_launch_id" : owned ? owner[@"launch_id"] : NSNull.null,
    @"expected_native_task_id" : owned
        ? owner[@"native_task_id"] : NSNull.null,
    @"expected_transcript_generation" :
        row[@"transcript_before"][@"generation"],
    @"expected_transcript_sha256" :
        row[@"transcript_before"][@"transcript_sha256"],
    @"expected_root_fingerprint_sha256" :
        row[@"root_fingerprint_sha256"],
    @"expected_binding_revision" : row[@"binding_revision"],
  };
}

static NSString *DSHRuntimeToolStatus(NSDictionary *row) {
  NSString *state = row[@"state"];
  if (![state isEqualToString:@"settled"]) return state;
  NSString *outcome = row[@"receipt"][@"outcome"];
  return [outcome isEqualToString:@"ok"] ? @"completed" :
      ([outcome isEqualToString:@"denied"] ? @"denied" : @"failed");
}

static NSDictionary *DSHRuntimeToolProjection(NSDictionary *row) {
  NSDictionary *locator = row[@"locator"];
  return @{
    @"schema_version" : @2,
    @"task_id" : locator[@"task_id"],
    @"attempt_id" : locator[@"attempt_id"],
    @"round_id" : locator[@"round_id"],
    @"round_index" : locator[@"round_index"],
    @"call_index" : locator[@"call_index"],
    @"call_id" : locator[@"call_id"],
    @"name" : row[@"name"],
    @"arguments_sha256" : row[@"arguments_sha256"],
    @"idempotency_key" : locator[@"idempotency_key"],
    @"execution_revision" : row[@"row_revision"],
    @"status" : DSHRuntimeToolStatus(row),
    @"transcript" : DSHRuntimeReferenceForRow(row),
    @"receipt" : row[@"receipt"],
  };
}

static NSDictionary *DSHRuntimeFindAuthority(NSDictionary *state,
                                             NSString *taskId,
                                             NSString *attemptId) {
  for (NSDictionary *row in state[@"authorities"]) {
    if ([row[@"task_id"] isEqual:taskId] &&
        [row[@"attempt_id"] isEqual:attemptId]) return row;
  }
  return nil;
}

static NSDictionary *DSHRuntimeFindLedgerRow(NSDictionary *state,
                                             NSDictionary *locator) {
  for (NSDictionary *row in state[@"ledger"]) {
    if ([row[@"locator"] isEqual:locator]) return row;
  }
  return nil;
}

static NSDictionary *DSHRuntimeSessionProof(
    DSHAgentPreparedAttemptStore *preparedStore,
    NSString *conversationId,
    NSString *taskId,
    NSString *attemptId,
    NSNumber *expectedControllerGeneration,
    NSNumber *expectedJournalRevision,
    NSNumber *expectedSessionGeneration,
    NSString *expectedSessionSHA256,
    NSError **error) {
  NSDictionary *loaded = [preparedStore.sessionSnapshotStore
      loadSessionSnapshotWithError:error];
  if (![loaded[@"status"] isEqualToString:@"present"] ||
      ![loaded[@"snapshot"] isKindOfClass:NSDictionary.class] ||
      ![loaded[@"session_json"] isKindOfClass:NSString.class]) {
    if (error != nullptr && *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorPersistence);
    }
    return nil;
  }
  NSData *bytes = [loaded[@"session_json"] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *session = bytes == nil ? nil :
      [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  if (![session isKindOfClass:NSDictionary.class] ||
      ![session[@"schema_version"] isEqual:@9] ||
      ![session[@"conversations"] isKindOfClass:NSArray.class] ||
      ![session[@"session_events"] isKindOfClass:NSArray.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSDictionary *conversation = nil;
  NSDictionary *attempt = nil;
  for (NSDictionary *candidate in session[@"conversations"]) {
    if ([candidate[@"id"] isEqual:conversationId]) {
      conversation = candidate;
      break;
    }
  }
  for (NSDictionary *candidate in conversation[@"attempts"]) {
    if ([candidate[@"attempt_id"] isEqual:attemptId]) {
      attempt = candidate;
      break;
    }
  }
  NSNumber *actualController = attempt[@"agent"][@"controller_generation"];
  if (![attempt[@"turn_id"] isEqual:taskId] ||
      !DSHAgentSafeInteger(actualController, 9007199254740991ULL, YES) ||
      !DSHAgentSafeInteger(attempt[@"journal_revision"],
                           9007199254740991ULL, YES)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSNumber *actualGeneration = loaded[@"snapshot"][@"generation"];
  NSString *actualSHA = loaded[@"snapshot"][@"session_sha256"];
  NSNumber *actualJournal = attempt[@"journal_revision"];
  BOOL matches = [actualController isEqual:expectedControllerGeneration] &&
      [actualJournal isEqual:expectedJournalRevision] &&
      [actualGeneration isEqual:expectedSessionGeneration] &&
      [actualSHA isEqual:expectedSessionSHA256];
  return @{ @"matches" : @(matches),
            @"controller_generation" : actualController,
            @"journal_revision" : actualJournal,
            @"session_generation" : actualGeneration,
            @"session_sha256" : actualSHA,
            @"session" : session };
}

static BOOL DSHRuntimeCancelSourceProof(
    NSDictionary *session,
    NSDictionary *request,
    NSError **error) {
  NSDictionary *target = request[@"target"];
  NSDictionary *token = request[@"cancel_token"];
  BOOL tokenShape = DSHAgentExactDictionaryKeys(token, @[
    @"schema_version", @"issuer", @"source_event_id", @"token",
    @"task_id", @"attempt_id", @"expected_phase", @"reason_code",
  ]) && [token[@"schema_version"] isEqual:@2] &&
      [token[@"issuer"] isEqualToString:@"completion_controller"] &&
      DSHAgentCanonicalUUID(token[@"source_event_id"]) &&
      [token[@"token"] isEqual:token[@"source_event_id"]] &&
      DSHAgentCanonicalUUID(token[@"task_id"]) &&
      DSHAgentCanonicalUUID(token[@"attempt_id"]) &&
      [@[@"round_in_flight", @"approval_pending", @"execution_intent",
         @"tool_result_pending"] containsObject:token[@"expected_phase"]] &&
      [@[@"E_AGENT_CANCELLED", @"E_AGENT_ROOT_STALE",
         @"E_AGENT_PERSISTENCE"] containsObject:token[@"reason_code"]] &&
      [token[@"task_id"] isEqual:target[@"task_id"]] &&
      [token[@"attempt_id"] isEqual:target[@"attempt_id"]];
  if (![session[@"schema_version"] isEqual:@9] || !tokenShape) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSDictionary *conversation = nil;
  NSDictionary *attempt = nil;
  for (NSDictionary *candidate in session[@"conversations"]) {
    if ([candidate[@"id"] isEqual:request[@"controller_cas"][@"conversation_id"]]) {
      conversation = candidate;
      break;
    }
  }
  for (NSDictionary *candidate in conversation[@"attempts"]) {
    if ([candidate[@"attempt_id"] isEqual:target[@"attempt_id"]]) {
      attempt = candidate;
      break;
    }
  }
  if (![attempt[@"turn_id"] isEqual:target[@"task_id"]] ||
      ![attempt[@"agent"][@"phase"] isEqual:token[@"expected_phase"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSDictionary *matched = nil;
  for (NSDictionary *event in session[@"session_events"]) {
    if (![event[@"event_id"] isEqual:token[@"source_event_id"]]) continue;
    if (matched != nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    matched = event;
  }
  BOOL eventShape = DSHAgentExactDictionaryKeys(matched, @[
    @"schema_version", @"event_id", @"attempt_id", @"seq", @"kind",
    @"round_index", @"call_id", @"status", @"safe_summary_key",
    @"arguments_sha256", @"result_sha256", @"approval_reference",
    @"failure_code", @"created_at",
  ]) && [matched[@"schema_version"] isEqual:@2] &&
      [matched[@"kind"] isEqualToString:@"cancel"] &&
      DSHAgentCanonicalUUID(matched[@"event_id"]) &&
      DSHAgentCanonicalUUID(matched[@"attempt_id"]) &&
      DSHAgentSafeInteger(matched[@"seq"], 9007199254740991ULL, YES) &&
      matched[@"safe_summary_key"] == NSNull.null &&
      matched[@"result_sha256"] == NSNull.null &&
      [matched[@"approval_reference"] isEqual:matched[@"event_id"]] &&
      DSHAgentCanonicalTimestamp(matched[@"created_at"]);
  BOOL common = eventShape &&
      [matched[@"attempt_id"] isEqual:target[@"attempt_id"]] &&
      [matched[@"status"] isEqualToString:@"cancelled"] &&
      [matched[@"failure_code"] isEqual:token[@"reason_code"]];
  BOOL targetMatches = NO;
  if ([target[@"kind"] isEqualToString:@"attempt"]) {
    targetMatches = matched[@"round_index"] == NSNull.null &&
        matched[@"call_id"] == NSNull.null &&
        matched[@"arguments_sha256"] == NSNull.null;
  } else if ([target[@"kind"] isEqualToString:@"round"]) {
    targetMatches = [matched[@"round_index"] isEqual:target[@"round_index"]] &&
        matched[@"call_id"] == NSNull.null &&
        matched[@"arguments_sha256"] == NSNull.null;
  } else if ([target[@"kind"] isEqualToString:@"tool"]) {
    NSDictionary *journalCall = nil;
    for (NSDictionary *candidate in attempt[@"agent"][@"batch"]) {
      if (![candidate[@"call_id"] isEqual:target[@"call_id"]] ||
          ![candidate[@"call_index"] isEqual:target[@"call_index"]]) continue;
      if (journalCall != nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      journalCall = candidate;
    }
    targetMatches = [matched[@"round_index"] isEqual:target[@"round_index"]] &&
        [matched[@"call_id"] isEqual:target[@"call_id"]] &&
        DSHAgentCanonicalSHA256(matched[@"arguments_sha256"]) &&
        [attempt[@"agent"][@"round_index"] isEqual:target[@"round_index"]] &&
        [journalCall[@"arguments_sha256"] isEqual:matched[@"arguments_sha256"]];
  }
  if (!common || !targetMatches) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

static BOOL DSHRuntimeControllerMatchesCheckpoint(NSDictionary *controllerCAS,
                                                  NSDictionary *checkpoint) {
  return [controllerCAS isKindOfClass:NSDictionary.class] &&
      [checkpoint isKindOfClass:NSDictionary.class] &&
      [controllerCAS[@"expected_journal_revision"]
          isEqual:checkpoint[@"journal_revision"]] &&
      [controllerCAS[@"expected_session_generation"]
          isEqual:checkpoint[@"session_generation"]] &&
      [controllerCAS[@"expected_session_sha256"]
          isEqual:checkpoint[@"session_sha256"]];
}

static BOOL DSHRuntimeControllerMatchesIdentity(NSDictionary *controllerCAS,
                                                NSString *conversationId,
                                                NSString *taskId,
                                                NSString *attemptId) {
  return [controllerCAS isKindOfClass:NSDictionary.class] &&
      [controllerCAS[@"conversation_id"] isEqual:conversationId] &&
      [controllerCAS[@"task_id"] isEqual:taskId] &&
      [controllerCAS[@"attempt_id"] isEqual:attemptId];
}

static NSDictionary *DSHRuntimeFindCleanup(NSDictionary *state,
                                           NSString *cleanupId) {
  for (NSDictionary *row in state[@"cleanup"]) {
    if ([row[@"cleanup_id"] isEqual:cleanupId]) return row;
  }
  return nil;
}

static BOOL DSHRuntimeCleanupOutboxProof(
    DSHAgentPreparedAttemptStore *preparedStore,
    NSDictionary *request,
    NSError **error) {
  NSDictionary *loaded = [preparedStore.sessionSnapshotStore
      loadSessionSnapshotWithError:error];
  id sessionJSON = loaded[@"session_json"];
  if (![loaded[@"status"] isEqualToString:@"present"] ||
      ![sessionJSON isKindOfClass:NSString.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSData *bytes = [sessionJSON dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *session = bytes == nil ? nil :
      [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  if (![session isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSArray *outbox = session[@"agent_transcript_cleanup_outbox"];
  if (![session[@"schema_version"] isEqual:@9] ||
      ![outbox isKindOfClass:NSArray.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSDictionary *matched = nil;
  for (NSDictionary *candidate in outbox) {
    if (![candidate[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) continue;
    if (matched != nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    matched = candidate;
  }
  BOOL matches = DSHAgentExactDictionaryKeys(matched, @[
    @"schema_version", @"cleanup_id", @"conversation_id", @"task_id",
    @"attempt_id", @"transcript_ref", @"transcript_sha256", @"reason",
    @"created_at",
  ]) && [matched[@"schema_version"] isEqual:@1] &&
      [matched[@"conversation_id"] isEqual:request[@"conversation_id"]] &&
      [matched[@"task_id"] isEqual:request[@"task_id"]] &&
      [matched[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
      [matched[@"transcript_ref"] isEqual:request[@"transcript_ref"]] &&
      [matched[@"transcript_sha256"] isEqual:request[@"transcript_sha256"]] &&
      [@[@"completed", @"cancelled", @"failed", @"conversation_deleted"]
          containsObject:matched[@"reason"]] &&
      DSHAgentCanonicalTimestamp(matched[@"created_at"]);
  if (!matches) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
  }
  return matches;
}

static NSDictionary *DSHRuntimeLatestRound(NSDictionary *state,
                                           NSString *taskId,
                                           NSString *attemptId) {
  NSDictionary *latest = nil;
  for (NSDictionary *row in state[@"rounds"]) {
    NSDictionary *locator = row[@"locator"];
    if (![locator[@"task_id"] isEqual:taskId] ||
        ![locator[@"attempt_id"] isEqual:attemptId]) continue;
    if (latest == nil || [locator[@"round_index"] unsignedIntegerValue] >
            [latest[@"locator"][@"round_index"] unsignedIntegerValue]) {
      latest = row;
    }
  }
  return latest;
}

static NSDictionary *DSHRuntimeLatestBatch(NSDictionary *state,
                                           NSString *taskId,
                                           NSString *attemptId) {
  NSDictionary *latest = nil;
  for (NSDictionary *row in state[@"batches"]) {
    if (![row[@"task_id"] isEqual:taskId] ||
        ![row[@"attempt_id"] isEqual:attemptId]) continue;
    if (latest == nil || [row[@"round_index"] unsignedIntegerValue] >
            [latest[@"round_index"] unsignedIntegerValue] ||
        ([row[@"round_index"] isEqual:latest[@"round_index"]] &&
         [row[@"batch_revision"] unsignedIntegerValue] >
             [latest[@"batch_revision"] unsignedIntegerValue])) latest = row;
  }
  return latest;
}

/// A terminal provider round persists its assistant message and transcript row
/// in one transaction, but unlike a tool batch there is no subsequent ledger
/// transaction to advance the prepared authority. Finalization may bridge
/// exactly that one-generation gap only when the latest completed final/blocked
/// round is the immutable proof for the requested transcript transition.
static BOOL DSHRuntimeFinalRoundProvesTranscriptAdvance(
    NSDictionary *state,
    NSDictionary *authority,
    NSDictionary *request,
    NSNumber *expectedAuthorityRevision) {
  if (![authority[@"state"] isEqualToString:@"prepared"] ||
      ![authority[@"root"] isEqual:request[@"root"]] ||
      ![authority[@"authority_revision"] isEqual:expectedAuthorityRevision]) {
    return NO;
  }
  NSDictionary *before = authority[@"transcript"];
  NSDictionary *after = request[@"transcript"];
  if (![before[@"transcript_ref"] isEqual:after[@"transcript_ref"]] ||
      [after[@"generation"] unsignedIntegerValue] !=
          [before[@"generation"] unsignedIntegerValue] + 1) return NO;
  NSDictionary *latest = DSHRuntimeLatestRound(
      state, request[@"task_id"], request[@"attempt_id"]);
  NSUInteger proofCount = 0;
  NSDictionary *proof = nil;
  for (NSDictionary *round in state[@"rounds"]) {
    NSDictionary *locator = round[@"locator"];
    if (![locator[@"task_id"] isEqual:request[@"task_id"]] ||
        ![locator[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
        ![round[@"state"] isEqualToString:@"completed"] ||
        ![round[@"transcript_before"] isEqual:before] ||
        ![round[@"transcript_after"] isEqual:after]) continue;
    proofCount += 1;
    proof = round;
  }
  if (proofCount != 1 || ![proof isEqual:latest]) return NO;
  NSString *reason = request[@"terminal_reason"];
  NSString *terminalKind = proof[@"terminal_kind"];
  NSString *finishReason = proof[@"completion_receipt"][@"finish_reason"];
  if ([reason isEqualToString:@"completed"]) {
    return [terminalKind isEqualToString:@"final"] &&
        [finishReason isEqualToString:@"stop"];
  }
  if ([reason isEqualToString:@"failed"]) {
    return [terminalKind isEqualToString:@"blocked"] &&
        ([@[@"length", @"content_filter"] containsObject:finishReason]);
  }
  return NO;  // Cancellation never gains a transcript handoff exception.
}

static NSDictionary *DSHRuntimeCommitFinalizeConflict(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSDictionary *started,
    NSString *failureCode,
    NSError **error) {
  NSDictionary *result = @{ @"schema_version" : @2, @"status" : @"conflict",
    @"operation_id" : request[@"operation_id"],
    @"failure_code" : failureCode };
  NSDictionary *safe = @{ @"schema_version" : @2,
    @"result_kind" : @"finalize_agent_attempt", @"result" : result };
  NSDictionary *committed = DSHAgentNativeWALCommitOperation(
      wal, request[@"operation_id"], started[@"request_sha256"],
      request[@"task_id"], request[@"attempt_id"], @"conflict", @"conflict",
      @{ @"schema_version" : @2, @"kind" : @"none" }, nil, safe, error);
  return committed == nil ? nil : committed[@"result"][@"result"];
}

static NSDictionary *DSHRuntimeCommitCancelResult(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSDictionary *started,
    NSDictionary *result,
    NSError **error) {
  NSDictionary *target = request[@"target"];
  NSString *status = result[@"status"];
  NSString *terminalState = [status isEqualToString:@"conflict"]
      ? @"conflict" : (([status isEqualToString:@"unknown"] ||
                         [status isEqualToString:@"ambiguous"])
          ? status : @"committed");
  NSDictionary *resultRef = @{ @"schema_version" : @2, @"kind" : @"none" };
  id resultRevision = nil;
  if (![status isEqualToString:@"conflict"] &&
      ![status isEqualToString:@"unknown"] &&
      ![status isEqualToString:@"ambiguous"] &&
      [target[@"kind"] isEqualToString:@"attempt"]) {
    resultRevision = started[@"record"][@"authority_revision"];
    resultRef = @{ @"schema_version" : @2, @"kind" : @"authority",
      @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
      @"authority_revision" : resultRevision };
  } else if (![status isEqualToString:@"conflict"] &&
      result[@"result_execution_revision"] != NSNull.null) {
    resultRevision = result[@"result_execution_revision"];
    resultRef = @{ @"schema_version" : @2, @"kind" : @"tool",
      @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
      @"round_id" : target[@"round_id"], @"round_index" : target[@"round_index"],
      @"call_index" : target[@"call_index"], @"call_id" : target[@"call_id"],
      @"execution_revision" : resultRevision };
  } else if (![status isEqualToString:@"conflict"] &&
             result[@"result_round_revision"] != NSNull.null) {
    resultRevision = result[@"result_round_revision"];
    resultRef = @{ @"schema_version" : @2, @"kind" : @"round",
      @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
      @"round_id" : target[@"round_id"], @"round_index" : target[@"round_index"],
      @"round_revision" : resultRevision };
  }
  NSDictionary *safe = @{ @"schema_version" : @2,
    @"result_kind" : @"cancel_agent_attempt", @"result" : result };
  NSDictionary *committed = DSHAgentNativeWALCommitOperation(
      wal, request[@"operation_id"], started[@"request_sha256"],
      target[@"task_id"], target[@"attempt_id"], terminalState, status,
      resultRef, resultRevision, safe, error);
  return committed == nil ? nil : committed[@"result"][@"result"];
}

static NSDictionary *DSHRuntimeCommitRecoveryResult(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSDictionary *started,
    NSDictionary *result,
    NSError **error) {
  NSDictionary *target = request[@"target"];
  NSString *status = result[@"status"];
  NSString *terminalState = [status isEqualToString:@"conflict"]
      ? @"conflict" : @"committed";
  NSDictionary *resultRef = @{ @"schema_version" : @2, @"kind" : @"none" };
  id resultRevision = nil;
  if (![status isEqualToString:@"conflict"] &&
      [target[@"kind"] isEqualToString:@"attempt"]) {
    resultRevision = started[@"record"][@"authority_revision"];
    resultRef = @{ @"schema_version" : @2, @"kind" : @"authority",
      @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
      @"authority_revision" : resultRevision };
  } else if (![status isEqualToString:@"conflict"] &&
             [target[@"kind"] isEqualToString:@"round"]) {
    NSDictionary *completed = result[@"completed_round"];
    resultRevision = [completed isKindOfClass:NSDictionary.class]
        ? completed[@"result_round_revision"]
        : request[@"expected_round_revision"];
    NSDictionary *state = [wal snapshotWithError:error];
    if (state == nil) return nil;
    for (NSDictionary *row in state[@"rounds"]) {
      NSDictionary *locator = row[@"locator"];
      if ([locator[@"task_id"] isEqual:target[@"task_id"]] &&
          [locator[@"attempt_id"] isEqual:target[@"attempt_id"]] &&
          [locator[@"round_id"] isEqual:target[@"round_id"]] &&
          [locator[@"round_index"] isEqual:target[@"round_index"]]) {
        resultRevision = row[@"row_revision"];
        break;
      }
    }
    resultRef = @{ @"schema_version" : @2, @"kind" : @"round",
      @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
      @"round_id" : target[@"round_id"], @"round_index" : target[@"round_index"],
      @"round_revision" : resultRevision };
  } else if (![status isEqualToString:@"conflict"] &&
             [target[@"kind"] isEqualToString:@"tool"]) {
    NSDictionary *state = [wal snapshotWithError:error];
    if (state == nil) return nil;
    NSDictionary *locator = @{ @"schema_version" : @2,
      @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
      @"round_id" : target[@"round_id"], @"round_index" : target[@"round_index"],
      @"call_index" : target[@"call_index"], @"call_id" : target[@"call_id"],
      @"idempotency_key" : target[@"idempotency_key"] };
    resultRevision = DSHRuntimeFindLedgerRow(state, locator)[@"row_revision"];
    if (!DSHAgentSafeInteger(resultRevision, 9007199254740991ULL, NO)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return nil;
    }
    resultRef = @{ @"schema_version" : @2, @"kind" : @"tool",
      @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
      @"round_id" : target[@"round_id"], @"round_index" : target[@"round_index"],
      @"call_index" : target[@"call_index"], @"call_id" : target[@"call_id"],
      @"execution_revision" : resultRevision };
  }
  NSDictionary *safe = @{ @"schema_version" : @2,
    @"result_kind" : @"recover_agent_attempt", @"result" : result };
  NSDictionary *committed = DSHAgentNativeWALCommitOperation(
      wal, request[@"operation_id"], started[@"request_sha256"],
      target[@"task_id"], target[@"attempt_id"], terminalState, status,
      resultRef, resultRevision, safe, error);
  return committed == nil ? nil : committed[@"result"][@"result"];
}

static NSArray *DSHRuntimeLatestBatchCalls(NSDictionary *state,
                                          NSDictionary *batch) {
  if (batch == nil) return @[];
  for (NSDictionary *snapshot in [state[@"operation_results"] reverseObjectEnumerator]) {
    NSDictionary *wrapper = snapshot[@"result"];
    NSDictionary *result = wrapper[@"result"];
    NSDictionary *receipt = result[@"receipt"];
    if ([wrapper[@"result_kind"] isEqualToString:@"prepare_agent_tool_batch"] &&
        [receipt[@"task_id"] isEqual:batch[@"task_id"]] &&
        [receipt[@"attempt_id"] isEqual:batch[@"attempt_id"]] &&
        [receipt[@"round_id"] isEqual:batch[@"round_id"]] &&
        [receipt[@"batch_revision"] isEqual:batch[@"batch_revision"]]) {
      return receipt[@"calls"] ?: @[];
    }
  }
  return @[];
}

@interface DSHAgentRuntimeCoordinator ()
@property(nonatomic, readwrite, getter=isAvailable) BOOL available;
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@property(nonatomic, strong, readwrite) DSHAgentPreparedAttemptStore *preparedStore;
@property(nonatomic, strong, readwrite) DSHAgentProviderRoundService *roundService;
@property(nonatomic, strong, readwrite) DSHAgentToolBatchService *batchService;
@property(nonatomic, strong, readwrite) DSHAgentToolExecutionService *executionService;
@property(nonatomic, strong, readwrite) DSHAgentTranscriptStore *transcripts;
@property(nonatomic, strong, readwrite) DSHAgentRoundJournal *rounds;
@property(nonatomic, strong, readwrite) DSHAgentExecutionLedger *ledger;
@end

@implementation DSHAgentRuntimeCoordinator

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
               preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                roundService:(DSHAgentProviderRoundService *)roundService
                 batchService:(DSHAgentToolBatchService *)batchService
             executionService:(DSHAgentToolExecutionService *)executionService
                  transcripts:(DSHAgentTranscriptStore *)transcripts
                       rounds:(DSHAgentRoundJournal *)rounds
                       ledger:(DSHAgentExecutionLedger *)ledger {
  self = [super init];
  if (self != nil) {
    BOOL oneWAL = wal != nil && preparedStore.wal == wal &&
        roundService.wal == wal && batchService.wal == wal &&
        executionService.wal == wal && transcripts.wal == wal &&
        rounds.wal == wal && ledger.wal == wal &&
        roundService.preparedStore == preparedStore &&
        roundService.transcripts == transcripts && roundService.rounds == rounds &&
        batchService.preparedStore == preparedStore && batchService.ledger == ledger &&
        batchService.transcripts == transcripts &&
        executionService.preparedStore == preparedStore &&
        executionService.ledger == ledger &&
        executionService.transcripts == transcripts;
    BOOL providerReady = roundService.transport != nil &&
        roundService.credentialProvider != nil &&
        roundService.visibleHistoryProvider != nil &&
        roundService.contextReceiptProvider != nil;
    if (!oneWAL || !providerReady) return nil;
    _wal = wal;
    _preparedStore = preparedStore;
    _roundService = roundService;
    _batchService = batchService;
    _executionService = executionService;
    _transcripts = transcripts;
    _rounds = rounds;
    _ledger = ledger;
    _available = YES;
  }
  return self;
}

- (instancetype)initForRecoveryTestingWithWAL:(DSHAgentNativeWAL *)wal
                                  preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                                   roundService:(DSHAgentProviderRoundService *)roundService
                               executionService:(DSHAgentToolExecutionService *)executionService
                                    transcripts:(DSHAgentTranscriptStore *)transcripts
                                         ledger:(DSHAgentExecutionLedger *)ledger {
  self = [super init];
  if (self != nil) {
    if (wal == nil || preparedStore == nil || roundService == nil ||
        executionService == nil || transcripts.wal != wal || ledger.wal != wal) {
      return nil;
    }
    _wal = wal;
    _preparedStore = preparedStore;
    _roundService = roundService;
    _executionService = executionService;
    _transcripts = transcripts;
    _ledger = ledger;
    _available = YES;
  }
  return self;
}

- (NSDictionary *)prepareAgentAttempt:(NSDictionary *)request
                                  error:(NSError **)error {
  return [self.preparedStore prepareAgentAttemptWithRequest:request error:error];
}

- (NSDictionary *)completeAgentRoundV2:(NSDictionary *)request
                                    error:(NSError **)error {
  return [self.roundService completeAgentRoundV2WithRequest:request error:error];
}

- (NSDictionary *)prepareAgentToolBatch:(NSDictionary *)request
                                    error:(NSError **)error {
  return [self.batchService prepareAgentToolBatchWithRequest:request error:error];
}

- (NSDictionary *)bindAgentApproval:(NSDictionary *)request
                                error:(NSError **)error {
  return [self.batchService bindAgentApprovalWithRequest:request error:error];
}

- (NSDictionary *)executeAgentTool:(NSDictionary *)request
                               error:(NSError **)error {
  return [self.executionService executeAgentToolWithRequest:request error:error];
}

- (NSDictionary *)queryAgentTool:(NSDictionary *)rawRequest
                             error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest, @[
    @"schema_version", @"controller_cas", @"task_id", @"conversation_id",
    @"attempt_id", @"round_id", @"round_index", @"call_index",
    @"call_id", @"idempotency_key", @"expected_execution_revision",
    @"expected_transcript", @"expected_root_fingerprint_sha256",
    @"expected_workspace_binding_revision",
  ], error);
  if (request == nil || !DSHRuntimeControllerMatchesIdentity(
      request[@"controller_cas"], request[@"conversation_id"],
      request[@"task_id"], request[@"attempt_id"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *locator = @{
    @"schema_version" : @2, @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"], @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"], @"call_index" : request[@"call_index"],
    @"call_id" : request[@"call_id"], @"idempotency_key" : request[@"idempotency_key"],
  };
  NSDictionary *proof = DSHRuntimeSessionProof(
      self.preparedStore, request[@"conversation_id"], request[@"task_id"],
      request[@"attempt_id"],
      request[@"controller_cas"][@"expected_controller_generation"],
      request[@"controller_cas"][@"expected_journal_revision"],
      request[@"controller_cas"][@"expected_session_generation"],
      request[@"controller_cas"][@"expected_session_sha256"], error);
  if (proof == nil) return nil;
  if (![proof[@"matches"] boolValue]) {
    NSDictionary *state = [self.wal snapshotWithError:error];
    if (state == nil) return nil;
    NSNumber *actualRevision =
        DSHRuntimeFindLedgerRow(state, locator)[@"row_revision"] ?: @0;
    if (error != nullptr) *error = nil;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"failure_code" : @"E_AGENT_CONFLICT",
      @"expected_execution_revision" : request[@"expected_execution_revision"],
      @"actual_execution_revision" : actualRevision };
  }
  NSError *ledgerError = nil;
  NSDictionary *queried = [self.ledger queryAgentExecutionWithLocator:locator
      expectedTranscript:request[@"expected_transcript"] root:@{
        @"schema_version" : @1,
        @"root_fingerprint_sha256" : request[@"expected_root_fingerprint_sha256"],
        @"binding_revision" : request[@"expected_workspace_binding_revision"],
      } error:&ledgerError];
  if (queried == nil) {
    if (ledgerError.code != DSHAgentNativeStoreErrorConflict) {
      if (error != nullptr) *error = ledgerError;
      return nil;
    }
    NSDictionary *state = [self.wal snapshotWithError:error];
    if (state == nil) return nil;
    NSDictionary *actualRow = DSHRuntimeFindLedgerRow(state, locator);
    NSString *failureCode = @"E_AGENT_CONFLICT";
    if (actualRow != nil &&
        (![actualRow[@"root_fingerprint_sha256"]
            isEqual:request[@"expected_root_fingerprint_sha256"]] ||
         ![actualRow[@"binding_revision"]
            isEqual:request[@"expected_workspace_binding_revision"]])) {
      failureCode = @"E_AGENT_ROOT_STALE";
    } else if (actualRow != nil &&
               ![actualRow[@"transcript_before"]
                   isEqual:request[@"expected_transcript"]]) {
      failureCode = @"E_AGENT_TRANSCRIPT";
    }
    if (error != nullptr) *error = nil;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"failure_code" : failureCode,
      @"expected_execution_revision" : request[@"expected_execution_revision"],
      @"actual_execution_revision" : actualRow[@"row_revision"] ?: @0 };
  }
  if ([queried[@"status"] isEqualToString:@"not_started"]) {
    if ([request[@"expected_execution_revision"] isEqual:@0]) return queried;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"failure_code" : @"E_AGENT_CONFLICT",
      @"expected_execution_revision" : request[@"expected_execution_revision"],
      @"actual_execution_revision" : @0 };
  }
  NSDictionary *row = queried[@"row"];
  if (![row[@"row_revision"] isEqual:request[@"expected_execution_revision"]]) {
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"failure_code" : @"E_AGENT_CONFLICT",
      @"expected_execution_revision" : request[@"expected_execution_revision"],
      @"actual_execution_revision" : row[@"row_revision"] };
  }
  NSDictionary *tool = DSHRuntimeToolProjection(row);
  return @{ @"schema_version" : @2, @"status" : tool[@"status"],
            @"tool" : tool };
}

- (NSDictionary *)queryAgentAttempt:(NSDictionary *)rawRequest
                                error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest, @[
    @"schema_version", @"controller_cas", @"task_id", @"conversation_id",
    @"attempt_id", @"expected_journal_revision", @"expected_session_generation",
    @"expected_session_sha256", @"expected_transcript",
    @"expected_root_fingerprint_sha256", @"expected_workspace_binding_revision",
  ], error);
  if (request == nil || !DSHRuntimeControllerMatchesIdentity(
      request[@"controller_cas"], request[@"conversation_id"],
      request[@"task_id"], request[@"attempt_id"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *proof = DSHRuntimeSessionProof(
      self.preparedStore, request[@"conversation_id"], request[@"task_id"],
      request[@"attempt_id"],
      request[@"controller_cas"][@"expected_controller_generation"],
      request[@"controller_cas"][@"expected_journal_revision"],
      request[@"controller_cas"][@"expected_session_generation"],
      request[@"controller_cas"][@"expected_session_sha256"], error);
  if (proof == nil) return nil;
  BOOL requestCheckpointMatches =
      [proof[@"journal_revision"] isEqual:request[@"expected_journal_revision"]] &&
      [proof[@"session_generation"] isEqual:request[@"expected_session_generation"]] &&
      [proof[@"session_sha256"] isEqual:request[@"expected_session_sha256"]];
  if (![proof[@"matches"] boolValue] || !requestCheckpointMatches) {
    if (error != nullptr) *error = nil;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"failure_code" : @"E_AGENT_CONFLICT",
      @"expected_journal_revision" : request[@"expected_journal_revision"],
      @"actual_journal_revision" : proof[@"journal_revision"],
      @"expected_session_generation" : request[@"expected_session_generation"],
      @"actual_session_generation" : proof[@"session_generation"] };
  }
  NSError *authorityError = nil;
  NSDictionary *base = [self.preparedStore preparedAttemptForTaskId:request[@"task_id"]
      attemptId:request[@"attempt_id"] error:&authorityError];
  if (base == nil) {
    if (authorityError.code == DSHAgentNativeStoreErrorNotFound) {
      if (error != nullptr) *error = nil;
      return @{ @"schema_version" : @2, @"status" : @"not_found",
                @"failure_code" : @"E_AGENT_NOT_FOUND" };
    }
    if (error != nullptr) *error = authorityError;
    return nil;
  }
  if (![base[@"conversation_id"] isEqual:request[@"conversation_id"]] ||
      ![base[@"transcript"] isEqual:request[@"expected_transcript"]] ||
      ![base[@"root"][@"root_fingerprint_sha256"]
          isEqual:request[@"expected_root_fingerprint_sha256"]] ||
      ![base[@"root"][@"workspace_binding_revision"]
          isEqual:request[@"expected_workspace_binding_revision"]]) {
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"failure_code" : @"E_AGENT_ROOT_STALE",
      @"expected_journal_revision" : request[@"expected_journal_revision"],
      @"actual_journal_revision" : proof[@"journal_revision"],
      @"expected_session_generation" : request[@"expected_session_generation"],
      @"actual_session_generation" : proof[@"session_generation"] };
  }
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  NSMutableDictionary *attempt = [base mutableCopy];
  attempt[@"controller_generation"] = proof[@"controller_generation"];
  attempt[@"journal_revision"] = proof[@"journal_revision"];
  NSDictionary *round = DSHRuntimeLatestRound(state, request[@"task_id"],
                                               request[@"attempt_id"]);
  NSDictionary *batch = DSHRuntimeLatestBatch(state, request[@"task_id"],
                                               request[@"attempt_id"]);
  if (round != nil) {
    NSString *roundState = round[@"state"];
    attempt[@"round_id"] = round[@"locator"][@"round_id"];
    attempt[@"round_index"] = round[@"locator"][@"round_index"];
    attempt[@"round_revision"] = round[@"row_revision"];
    attempt[@"round_status"] = [roundState isEqualToString:@"in_flight"]
        ? @"active" : roundState;
    if ([roundState isEqualToString:@"in_flight"] ||
        [roundState isEqualToString:@"cancel_requested"]) {
      attempt[@"phase"] = @"round_in_flight";
    } else if ([roundState isEqualToString:@"cancelled"]) {
      attempt[@"phase"] = @"cancelled";
    } else if ([roundState isEqualToString:@"unknown"] ||
               [roundState isEqualToString:@"ambiguous"]) {
      attempt[@"phase"] = roundState;
    }
  }
  if (batch != nil) {
    NSArray *calls = DSHRuntimeLatestBatchCalls(state, batch);
    attempt[@"batch_kind"] = batch[@"kind"];
    attempt[@"batch_revision"] = batch[@"batch_revision"];
    attempt[@"manifest_sha256"] = batch[@"manifest_sha256"];
    attempt[@"batch"] = calls;
    attempt[@"phase"] = [calls filteredArrayUsingPredicate:
        [NSPredicate predicateWithBlock:^BOOL(NSDictionary *call,
                                               NSDictionary *bindings) {
          (void)bindings;
          return [call[@"approval_state"] isEqualToString:@"pending"];
        }]].count > 0 ? @"approval_pending" : @"batch_frozen";
  }
  NSString *status = [@[@"terminal", @"cleanup_pending"]
      containsObject:DSHRuntimeFindAuthority(state, request[@"task_id"],
                                             request[@"attempt_id"])[@"state"]]
      ? @"terminal" : @"active";
  return @{ @"schema_version" : @2, @"status" : status,
            @"attempt" : [attempt copy] };
}

- (NSDictionary *)cancelAgentAttempt:(NSDictionary *)rawRequest
                                 error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest, @[
    @"schema_version", @"operation_id", @"controller_cas",
    @"committed_checkpoint", @"target", @"cancel_token",
    @"expected_round_revision", @"expected_execution_revision",
    @"expected_transcript", @"root",
  ], error);
  NSDictionary *target = DSHRuntimeTarget(request);
  if (request == nil || target == nil ||
      !DSHRuntimeControllerMatchesCheckpoint(request[@"controller_cas"],
                                             request[@"committed_checkpoint"]) ||
      ![request[@"controller_cas"][@"task_id"] isEqual:target[@"task_id"]] ||
      ![request[@"controller_cas"][@"attempt_id"] isEqual:target[@"attempt_id"]] ||
      ![request[@"cancel_token"][@"task_id"] isEqual:target[@"task_id"]] ||
      ![request[@"cancel_token"][@"attempt_id"] isEqual:target[@"attempt_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"cancel_agent_attempt", @"request" : request,
  }, error);
  NSDictionary *operationQuery = requestSHA == nil ? nil :
      DSHAgentNativeWALQueryOperation(self.wal, request[@"operation_id"],
          requestSHA, target[@"task_id"], target[@"attempt_id"], error);
  if (operationQuery == nil) return nil;
  if ([operationQuery[@"status"] isEqualToString:@"found"] &&
      ![operationQuery[@"record"][@"state"] isEqualToString:@"started"]) {
    NSDictionary *replay = DSHAgentNativeWALStartTargetOperation(
        self.wal, @"cancel_agent_attempt", request, target,
        target[@"task_id"], target[@"attempt_id"],
        operationQuery[@"record"][@"authority_revision"], error);
    return [replay[@"status"] isEqualToString:@"replayed"]
        ? replay[@"result"][@"result"] : nil;
  }
  NSDictionary *sourceProof = DSHRuntimeSessionProof(
      self.preparedStore, request[@"controller_cas"][@"conversation_id"],
      target[@"task_id"], target[@"attempt_id"],
      request[@"controller_cas"][@"expected_controller_generation"],
      request[@"controller_cas"][@"expected_journal_revision"],
      request[@"committed_checkpoint"][@"session_generation"],
      request[@"committed_checkpoint"][@"session_sha256"], error);
  if (sourceProof == nil) return nil;
  if (![sourceProof[@"matches"] boolValue]) {
    if (error != nullptr) *error = nil;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"], @"target" : target,
      @"failure_code" : @"E_AGENT_CONFLICT",
      @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
      @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
      @"actual_controller_generation" : sourceProof[@"controller_generation"],
      @"actual_journal_revision" : sourceProof[@"journal_revision"] };
  }
  if (!DSHRuntimeCancelSourceProof(sourceProof[@"session"], request, error)) {
    if (error != nullptr) *error = nil;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"], @"target" : target,
      @"failure_code" : @"E_AGENT_CANCELLED",
      @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
      @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
      @"actual_controller_generation" : sourceProof[@"controller_generation"],
      @"actual_journal_revision" : sourceProof[@"journal_revision"] };
  }
  if (![self.preparedStore validatePreparedRoot:request[@"root"]
      taskId:target[@"task_id"] attemptId:target[@"attempt_id"] error:error]) {
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"], @"target" : target,
      @"failure_code" : @"E_AGENT_ROOT_STALE",
      @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
      @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
      @"actual_controller_generation" : sourceProof[@"controller_generation"],
      @"actual_journal_revision" : sourceProof[@"journal_revision"] };
  }
  NSDictionary *authority = [self.preparedStore
      nativeAuthorityForTaskId:target[@"task_id"]
                     attemptId:target[@"attempt_id"] error:error];
  if (authority == nil) return nil;
  NSNumber *operationAuthorityRevision =
      [operationQuery[@"status"] isEqualToString:@"found"]
      ? operationQuery[@"record"][@"authority_revision"]
      : authority[@"authority_revision"];
  NSDictionary *started = DSHAgentNativeWALStartTargetOperation(
      self.wal, @"cancel_agent_attempt", request, target,
      target[@"task_id"], target[@"attempt_id"], operationAuthorityRevision,
      error);
  if ([started[@"status"] isEqualToString:@"replayed"]) {
    return started[@"result"][@"result"];
  }
  if (started == nil) return nil;
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  NSDictionary *row = nil;
  NSString *kind = target[@"kind"];
  if ([kind isEqualToString:@"tool"]) {
    for (NSDictionary *candidate in state[@"ledger"]) {
      NSDictionary *locator = candidate[@"locator"];
      if ([locator[@"task_id"] isEqual:target[@"task_id"]] &&
          [locator[@"attempt_id"] isEqual:target[@"attempt_id"]] &&
          [locator[@"round_id"] isEqual:target[@"round_id"]] &&
          [locator[@"call_index"] isEqual:target[@"call_index"]] &&
          [locator[@"call_id"] isEqual:target[@"call_id"]] &&
          [locator[@"idempotency_key"] isEqual:target[@"idempotency_key"]]) {
        row = candidate;
        break;
      }
    }
  }
  if ([kind isEqualToString:@"round"] ||
      ([kind isEqualToString:@"attempt"] && row == nil)) {
    NSDictionary *round = [kind isEqualToString:@"round"] ? nil :
        DSHRuntimeLatestRound(state, target[@"task_id"], target[@"attempt_id"]);
    NSDictionary *roundTarget = [kind isEqualToString:@"round"] ? target : round[@"locator"];
    id revision = [kind isEqualToString:@"round"]
        ? request[@"expected_round_revision"] : round[@"row_revision"];
    if (roundTarget != nil && revision != NSNull.null) {
      NSDictionary *cancelled = [self.roundService cancelAgentRoundWithRequest:@{
        @"schema_version" : @2, @"task_id" : target[@"task_id"],
        @"attempt_id" : target[@"attempt_id"], @"round_id" : roundTarget[@"round_id"],
        @"round_index" : roundTarget[@"round_index"],
        @"expected_round_revision" : revision,
        @"transcript" : request[@"expected_transcript"], @"root" : request[@"root"],
        @"cancel_token" : request[@"cancel_token"][@"token"],
      } error:error];
      if (cancelled == nil) return nil;
      if ([cancelled[@"status"] isEqualToString:@"conflict"]) {
        NSDictionary *conflict = @{ @"schema_version" : @2,
          @"status" : @"conflict", @"operation_id" : request[@"operation_id"],
          @"target" : target,
          @"failure_code" : cancelled[@"failure_code"] ?: @"E_AGENT_CONFLICT",
          @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
          @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
          @"actual_controller_generation" : sourceProof[@"controller_generation"],
          @"actual_journal_revision" : sourceProof[@"journal_revision"] };
        return DSHRuntimeCommitCancelResult(self.wal, request, started,
                                            conflict, error);
      }
      NSDictionary *result = @{ @"schema_version" : @2,
        @"status" : [cancelled[@"status"] isEqualToString:@"cancelled"]
            ? @"cancelled" : @"cancel_requested",
        @"operation_id" : request[@"operation_id"], @"target" : target,
        @"result_round_revision" : cancelled[@"result_round_revision"],
        @"result_execution_revision" : NSNull.null,
        @"transcript" : cancelled[@"transcript"], @"receipt" : NSNull.null,
        @"effect_may_have_occurred" : @NO,
        @"observed_checkpoint" : request[@"committed_checkpoint"] };
      return DSHRuntimeCommitCancelResult(self.wal, request, started, result,
                                          error);
    }
  }
  if (row == nil) {
    NSDictionary *result = @{ @"schema_version" : @2, @"status" : @"unknown",
      @"operation_id" : request[@"operation_id"], @"target" : target,
      @"result_round_revision" : NSNull.null,
      @"result_execution_revision" : NSNull.null,
      @"transcript" : request[@"expected_transcript"], @"receipt" : NSNull.null,
      @"effect_may_have_occurred" : @NO,
      @"failure_code" : @"E_AGENT_NOT_FOUND",
      @"observed_checkpoint" : request[@"committed_checkpoint"] };
    return DSHRuntimeCommitCancelResult(self.wal, request, started, result,
                                        error);
  }
  NSString *rowState = row[@"state"];
  NSDictionary *updated = nil;
  if ([rowState isEqualToString:@"intent"] ||
      [rowState isEqualToString:@"cancel_requested"]) {
    updated = [self.ledger cancelAgentExecutionWithCAS:DSHRuntimeExecutionCAS(row)
        patch:@{ @"state" : @"cancelled" } error:error][@"row"];
  } else if ([rowState isEqualToString:@"running"]) {
    updated = [self.ledger casAgentExecutionWithCAS:DSHRuntimeExecutionCAS(row)
        patch:@{ @"state" : @"cancel_requested" } error:error][@"row"];
  } else {
    NSDictionary *conflict = @{ @"schema_version" : @2,
      @"status" : @"conflict", @"operation_id" : request[@"operation_id"],
      @"target" : target, @"failure_code" : @"E_AGENT_CANCELLED",
      @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
      @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
      @"actual_controller_generation" : sourceProof[@"controller_generation"],
      @"actual_journal_revision" : sourceProof[@"journal_revision"] };
    return DSHRuntimeCommitCancelResult(self.wal, request, started, conflict,
                                        error);
  }
  if (updated == nil) return nil;
  NSString *status = [updated[@"state"] isEqualToString:@"cancelled"]
      ? @"cancelled" : ([updated[@"state"] isEqualToString:@"cancel_requested"]
          ? @"cancel_requested" : @"settled");
  NSMutableDictionary *result = [@{ @"schema_version" : @2, @"status" : status,
    @"operation_id" : request[@"operation_id"], @"target" : target,
    @"result_round_revision" : NSNull.null,
    @"result_execution_revision" : updated[@"row_revision"],
    @"transcript" : DSHRuntimeReferenceForRow(updated),
    @"receipt" : updated[@"receipt"],
    @"effect_may_have_occurred" :
        @([[self.wal dispatchStateForKind:@"execution" locator:updated[@"locator"]
                                    error:nil] isEqualToString:@"dispatched"]),
    @"observed_checkpoint" : request[@"committed_checkpoint"] } mutableCopy];
  return DSHRuntimeCommitCancelResult(self.wal, request, started,
                                      [result copy], error);
}

- (NSDictionary *)recoverAgentAttempt:(NSDictionary *)rawRequest
                                  error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest, @[
    @"schema_version", @"operation_id", @"controller_cas",
    @"committed_checkpoint", @"target", @"action",
    @"expected_round_revision", @"expected_execution_revision",
    @"expected_transcript", @"root",
  ], error);
  NSDictionary *target = DSHRuntimeTarget(request);
  if (request == nil || target == nil ||
      !DSHRuntimeControllerMatchesCheckpoint(request[@"controller_cas"],
                                             request[@"committed_checkpoint"]) ||
      ![request[@"controller_cas"][@"task_id"] isEqual:target[@"task_id"]] ||
      ![request[@"controller_cas"][@"attempt_id"] isEqual:target[@"attempt_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"recover_agent_attempt", @"request" : request,
  }, error);
  NSDictionary *operationQuery = requestSHA == nil ? nil :
      DSHAgentNativeWALQueryOperation(self.wal, request[@"operation_id"],
          requestSHA, target[@"task_id"], target[@"attempt_id"], error);
  if (operationQuery == nil) return nil;
  if ([operationQuery[@"status"] isEqualToString:@"found"] &&
      ![operationQuery[@"record"][@"state"] isEqualToString:@"started"]) {
    NSDictionary *replay = DSHAgentNativeWALStartTargetOperation(
        self.wal, @"recover_agent_attempt", request, target,
        target[@"task_id"], target[@"attempt_id"],
        operationQuery[@"record"][@"authority_revision"], error);
    return [replay[@"status"] isEqualToString:@"replayed"]
        ? replay[@"result"][@"result"] : nil;
  }
  NSDictionary *sourceProof = DSHRuntimeSessionProof(
      self.preparedStore, request[@"controller_cas"][@"conversation_id"],
      target[@"task_id"], target[@"attempt_id"],
      request[@"controller_cas"][@"expected_controller_generation"],
      request[@"controller_cas"][@"expected_journal_revision"],
      request[@"committed_checkpoint"][@"session_generation"],
      request[@"committed_checkpoint"][@"session_sha256"], error);
  if (sourceProof == nil) return nil;
  if (![sourceProof[@"matches"] boolValue]) {
    if (error != nullptr) *error = nil;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"],
      @"failure_code" : @"E_AGENT_CONFLICT",
      @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
      @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
      @"actual_controller_generation" : sourceProof[@"controller_generation"],
      @"actual_journal_revision" : sourceProof[@"journal_revision"] };
  }
  NSDictionary *(^queryAttempt)(NSError **) = ^NSDictionary *(NSError **queryError) {
    return [self queryAgentAttempt:@{
      @"schema_version" : @2, @"controller_cas" : request[@"controller_cas"],
      @"task_id" : target[@"task_id"],
      @"conversation_id" : request[@"controller_cas"][@"conversation_id"],
      @"attempt_id" : target[@"attempt_id"],
      @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
      @"expected_session_generation" : request[@"committed_checkpoint"][@"session_generation"],
      @"expected_session_sha256" : request[@"committed_checkpoint"][@"session_sha256"],
      @"expected_transcript" : request[@"expected_transcript"],
      @"expected_root_fingerprint_sha256" : request[@"root"][@"root_fingerprint_sha256"],
      @"expected_workspace_binding_revision" : request[@"root"][@"workspace_binding_revision"],
    } error:queryError];
  };
  NSDictionary *attemptQuery = queryAttempt(error);
  if (attemptQuery == nil) return nil;
  if ([attemptQuery[@"status"] isEqualToString:@"conflict"]) {
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"],
      @"failure_code" : attemptQuery[@"failure_code"],
      @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
      @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
      @"actual_controller_generation" : sourceProof[@"controller_generation"],
      @"actual_journal_revision" : attemptQuery[@"actual_journal_revision"] };
  }
  NSDictionary *authority = [self.preparedStore
      nativeAuthorityForTaskId:target[@"task_id"]
                     attemptId:target[@"attempt_id"] error:error];
  if (authority == nil) return nil;
  NSNumber *operationAuthorityRevision =
      [operationQuery[@"status"] isEqualToString:@"found"]
      ? operationQuery[@"record"][@"authority_revision"]
      : authority[@"authority_revision"];
  NSDictionary *started = DSHAgentNativeWALStartTargetOperation(
      self.wal, @"recover_agent_attempt", request, target,
      target[@"task_id"], target[@"attempt_id"], operationAuthorityRevision,
      error);
  if ([started[@"status"] isEqualToString:@"replayed"]) {
    return started[@"result"][@"result"];
  }
  if (started == nil) return nil;
  NSDictionary *completedRound = nil;
  NSString *status = [attemptQuery[@"status"] isEqualToString:@"terminal"]
      ? @"terminal" : @"resumed";
  NSString *next = @"none";
  if ([target[@"kind"] isEqualToString:@"round"]) {
    NSDictionary *roundRecovery = [self.roundService recoverAgentRoundWithRequest:@{
      @"schema_version" : @2, @"task_id" : target[@"task_id"],
      @"attempt_id" : target[@"attempt_id"], @"round_id" : target[@"round_id"],
      @"round_index" : target[@"round_index"],
      @"expected_round_revision" : request[@"expected_round_revision"],
      @"transcript" : request[@"expected_transcript"], @"root" : request[@"root"],
    } error:error];
    if (roundRecovery == nil) return nil;
    if ([roundRecovery[@"status"] isEqualToString:@"conflict"]) {
      NSDictionary *conflict = @{ @"schema_version" : @2, @"status" : @"conflict",
        @"operation_id" : request[@"operation_id"],
        @"failure_code" : roundRecovery[@"failure_code"] ?: @"E_AGENT_CONFLICT",
        @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
        @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
        @"actual_controller_generation" : sourceProof[@"controller_generation"],
        @"actual_journal_revision" : sourceProof[@"journal_revision"] };
      return DSHRuntimeCommitRecoveryResult(self.wal, request, started,
                                            conflict, error);
    }
    NSString *roundStatus = roundRecovery[@"status"];
    if ([request[@"action"] isEqualToString:@"retry_failed_round"]) {
      if (![roundStatus isEqualToString:@"failed_retryable"] ||
          ![roundRecovery[@"result_round_revision"]
              isEqual:request[@"expected_round_revision"]]) {
        NSDictionary *conflict = @{ @"schema_version" : @2, @"status" : @"conflict",
          @"operation_id" : request[@"operation_id"],
          @"failure_code" : @"E_AGENT_CONFLICT",
          @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
          @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
          @"actual_controller_generation" : sourceProof[@"controller_generation"],
          @"actual_journal_revision" : sourceProof[@"journal_revision"] };
        return DSHRuntimeCommitRecoveryResult(self.wal, request, started,
                                              conflict, error);
      }
      NSDictionary *state = [self.wal snapshotWithError:error];
      NSDictionary *roundRow = nil;
      for (NSDictionary *candidate in state[@"rounds"]) {
        NSDictionary *locator = candidate[@"locator"];
        if ([locator[@"task_id"] isEqual:target[@"task_id"]] &&
            [locator[@"attempt_id"] isEqual:target[@"attempt_id"]] &&
            [locator[@"round_id"] isEqual:target[@"round_id"]] &&
            [locator[@"round_index"] isEqual:target[@"round_index"]]) {
          roundRow = candidate;
          break;
        }
      }
      NSUInteger launchAttempt = [roundRow[@"launch_attempt"] unsignedIntegerValue];
      if (![roundRow[@"state"] isEqualToString:@"failed_retryable"] ||
          ![roundRow[@"row_revision"] isEqual:request[@"expected_round_revision"]] ||
          launchAttempt == 0 || launchAttempt >= 8) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return nil;
      }
      NSString *childOperation = DSHRuntimeChildOperationID(
          request[@"operation_id"], @"retry-round", error);
      if (childOperation == nil) return nil;
      NSDictionary *retried = [self.roundService retryFailedAgentRoundV2WithRequest:@{
        @"schema_version" : @2, @"operation_id" : childOperation,
        @"controller_cas" : request[@"controller_cas"],
        @"committed_checkpoint" : request[@"committed_checkpoint"],
        @"task_id" : target[@"task_id"],
        @"conversation_id" : request[@"controller_cas"][@"conversation_id"],
        @"attempt_id" : target[@"attempt_id"], @"round_id" : target[@"round_id"],
        @"round_index" : target[@"round_index"],
        @"launch_attempt" : @(launchAttempt + 1),
        @"expected_round_revision" : request[@"expected_round_revision"],
        @"transport_schema_version" : authority[@"transport_schema_version"],
        @"model" : authority[@"model"], @"thinking_mode" : authority[@"thinking_mode"],
        @"visible_history_sha256" : authority[@"visible_history_sha256"],
        @"visible_message_count" : authority[@"visible_message_count"],
        @"project_context_sha256" : authority[@"project_context_sha256"],
        @"transcript" : request[@"expected_transcript"], @"root" : request[@"root"],
        @"registry_version" : @1,
        @"toolset_sha256" : authority[@"registry"][@"toolset_sha256"],
      } error:error];
      if (retried == nil) return nil;
      NSString *retryStatus = retried[@"status"];
      if ([retryStatus isEqualToString:@"conflict"]) {
        NSDictionary *conflict = @{ @"schema_version" : @2,
          @"status" : @"conflict", @"operation_id" : request[@"operation_id"],
          @"failure_code" : retried[@"failure_code"] ?: @"E_AGENT_CONFLICT",
          @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
          @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
          @"actual_controller_generation" : sourceProof[@"controller_generation"],
          @"actual_journal_revision" : sourceProof[@"journal_revision"] };
        return DSHRuntimeCommitRecoveryResult(self.wal, request, started,
                                              conflict, error);
      } else if ([retryStatus isEqualToString:@"completed"]) {
        NSDictionary *afterRetry = [self.roundService recoverAgentRoundWithRequest:@{
          @"schema_version" : @2, @"task_id" : target[@"task_id"],
          @"attempt_id" : target[@"attempt_id"], @"round_id" : target[@"round_id"],
          @"round_index" : target[@"round_index"],
          @"expected_round_revision" : retried[@"result_round_revision"],
          @"transcript" : request[@"expected_transcript"], @"root" : request[@"root"],
        } error:error];
        completedRound = afterRetry[@"completed_round"];
        if (![completedRound isKindOfClass:NSDictionary.class]) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
          return nil;
        }
        status = @"resumed";
        next = [completedRound[@"kind"] isEqualToString:@"final"]
            ? @"persist_final" : ([completedRound[@"kind"] isEqualToString:@"tool_batch"]
                ? @"persist_batch" : @"persist_round");
      } else if ([retryStatus isEqualToString:@"failed_retryable"] ||
                 [retryStatus isEqualToString:@"in_flight"]) {
        status = @"retryable";
        next = @"retry_same_round";
      } else {
        status = @"manual_reconciliation";
        next = @"inspect_native_state";
      }
    } else if ([roundStatus isEqualToString:@"completed"]) {
      completedRound = roundRecovery[@"completed_round"];
      if (![completedRound isKindOfClass:NSDictionary.class]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return nil;
      }
      status = @"resumed";
      next = [completedRound[@"kind"] isEqualToString:@"final"]
          ? @"persist_final" : ([completedRound[@"kind"] isEqualToString:@"tool_batch"]
              ? @"persist_batch" : @"persist_round");
    } else if ([roundStatus isEqualToString:@"unknown"] ||
               [roundStatus isEqualToString:@"ambiguous"]) {
      status = @"manual_reconciliation";
      next = @"inspect_native_state";
    } else if ([roundStatus isEqualToString:@"failed_retryable"]) {
      status = @"retryable";
      next = @"retry_same_round";
    } else if ([roundStatus isEqualToString:@"cancelled"]) {
      status = @"terminal";
      next = @"none";
    }
  } else if ([target[@"kind"] isEqualToString:@"tool"]) {
    NSDictionary *state = [self.wal snapshotWithError:error];
    if (state == nil) return nil;
    NSDictionary *row = nil;
    for (NSDictionary *candidate in state[@"ledger"]) {
      NSDictionary *locator = candidate[@"locator"];
      if ([locator[@"task_id"] isEqual:target[@"task_id"]] &&
          [locator[@"attempt_id"] isEqual:target[@"attempt_id"]] &&
          [locator[@"round_id"] isEqual:target[@"round_id"]] &&
          [locator[@"round_index"] isEqual:target[@"round_index"]] &&
          [locator[@"call_index"] isEqual:target[@"call_index"]] &&
          [locator[@"call_id"] isEqual:target[@"call_id"]] &&
          [locator[@"idempotency_key"] isEqual:target[@"idempotency_key"]]) {
        row = candidate;
        break;
      }
    }
    if (row == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
      return nil;
    }
    NSDictionary *batch = nil;
    for (NSDictionary *candidate in state[@"batches"]) {
      if ([candidate[@"task_id"] isEqual:target[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:target[@"attempt_id"]] &&
          [candidate[@"round_id"] isEqual:target[@"round_id"]] &&
          [candidate[@"round_index"] isEqual:target[@"round_index"]]) {
        batch = candidate;
        break;
      }
    }
    NSArray *calls = DSHRuntimeLatestBatchCalls(state, batch);
    NSDictionary *call = nil;
    for (NSDictionary *candidate in calls) {
      if ([candidate[@"call_index"] isEqual:target[@"call_index"]] &&
          [candidate[@"call_id"] isEqual:target[@"call_id"]]) {
        call = candidate;
        break;
      }
    }
    if (batch == nil || call == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return nil;
    }
    NSString *toolOperationId = DSHRuntimeChildOperationID(
        request[@"operation_id"], @"recover-tool", error);
    if (toolOperationId == nil) return nil;
    NSDictionary *toolRequest = @{
      @"schema_version" : @2, @"operation_id" : toolOperationId,
      @"controller_cas" : request[@"controller_cas"],
      @"committed_checkpoint" : request[@"committed_checkpoint"],
      @"task_id" : target[@"task_id"],
      @"conversation_id" : request[@"controller_cas"][@"conversation_id"],
      @"attempt_id" : target[@"attempt_id"], @"round_id" : target[@"round_id"],
      @"round_index" : target[@"round_index"], @"batch_kind" : batch[@"kind"],
      @"manifest_sha256" : batch[@"manifest_sha256"],
      @"expected_batch_revision" : batch[@"batch_revision"],
      @"call_index" : target[@"call_index"], @"call_id" : target[@"call_id"],
      @"name" : row[@"name"], @"arguments_sha256" : row[@"arguments_sha256"],
      @"idempotency_key" : target[@"idempotency_key"],
      @"expected_execution_revision" : request[@"expected_execution_revision"],
      @"transcript" : request[@"expected_transcript"], @"root" : request[@"root"],
      @"approval_reference" : call[@"approval_reference"] ?: NSNull.null,
    };
    NSNumber *toolAuthorityRevision = authority[@"authority_revision"];
    for (NSDictionary *operation in state[@"operations"]) {
      if ([operation[@"operation_id"] isEqual:toolOperationId]) {
        toolAuthorityRevision = operation[@"authority_revision"];
        break;
      }
    }
    NSDictionary *toolStarted = DSHAgentNativeWALStartOperation(
        self.wal, @"execute_agent_tool", toolRequest, target[@"task_id"],
        target[@"attempt_id"], toolAuthorityRevision, error);
    if (toolStarted == nil) return nil;
    NSDictionary *toolRecovery = [self.executionService
        recoverAgentToolWithRequest:toolRequest error:error];
    if (toolRecovery == nil) return nil;
    NSString *toolRecoveryStatus = toolRecovery[@"status"];
    if ([@[@"completed", @"failed", @"denied", @"cancelled", @"ambiguous"]
            containsObject:toolRecoveryStatus]) {
      NSNumber *resultRevision = toolRecovery[@"result_execution_revision"];
      if (![toolRecovery[@"operation_id"] isEqual:toolOperationId] ||
          !DSHAgentSafeInteger(resultRevision, 9007199254740991ULL, NO)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return nil;
      }
      NSDictionary *toolQuery = DSHAgentNativeWALQueryOperation(
          self.wal, toolOperationId, toolStarted[@"request_sha256"],
          target[@"task_id"], target[@"attempt_id"], error);
      if (toolQuery == nil) return nil;
      if ([toolQuery[@"record"][@"state"] isEqualToString:@"started"]) {
        NSDictionary *committedTool = DSHAgentNativeWALCommitOperation(
            self.wal, toolOperationId, toolStarted[@"request_sha256"],
            target[@"task_id"], target[@"attempt_id"],
            [toolRecoveryStatus isEqualToString:@"ambiguous"]
                ? @"ambiguous" : @"committed",
            toolRecoveryStatus, @{ @"schema_version" : @2, @"kind" : @"tool",
              @"task_id" : target[@"task_id"], @"attempt_id" : target[@"attempt_id"],
              @"round_id" : target[@"round_id"], @"round_index" : target[@"round_index"],
              @"call_index" : target[@"call_index"], @"call_id" : target[@"call_id"],
              @"execution_revision" : resultRevision }, resultRevision,
            @{ @"schema_version" : @2, @"result_kind" : @"execute_agent_tool",
               @"result" : toolRecovery }, error);
        if (committedTool == nil) return nil;
        toolRecovery = committedTool[@"result"][@"result"];
      } else {
        NSDictionary *replayedTool = DSHAgentNativeWALStartOperation(
            self.wal, @"execute_agent_tool", toolRequest, target[@"task_id"],
            target[@"attempt_id"], toolQuery[@"record"][@"authority_revision"],
            error);
        NSDictionary *historicalTool = replayedTool[@"result"][@"result"];
        if (![replayedTool[@"status"] isEqualToString:@"replayed"] ||
            ![historicalTool isEqual:toolRecovery]) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
          return nil;
        }
        toolRecovery = historicalTool;
      }
    }
    if ([toolRecovery[@"status"] isEqualToString:@"conflict"]) {
      NSDictionary *conflict = @{ @"schema_version" : @2, @"status" : @"conflict",
        @"operation_id" : request[@"operation_id"],
        @"failure_code" : toolRecovery[@"failure_code"] ?: @"E_AGENT_CONFLICT",
        @"expected_controller_generation" : request[@"controller_cas"][@"expected_controller_generation"],
        @"expected_journal_revision" : request[@"controller_cas"][@"expected_journal_revision"],
        @"actual_controller_generation" : sourceProof[@"controller_generation"],
        @"actual_journal_revision" : sourceProof[@"journal_revision"] };
      return DSHRuntimeCommitRecoveryResult(self.wal, request, started,
                                            conflict, error);
    }
    NSString *toolStatus = toolRecovery[@"status"];
    if ([@[@"completed", @"failed", @"denied", @"cancelled", @"ambiguous"]
            containsObject:toolStatus]) {
      status = @"resumed";
      next = @"persist_tool_result";
    } else if ([toolStatus isEqualToString:@"not_started"] ||
               [toolStatus isEqualToString:@"intent"]) {
      status = @"resumed";
      next = @"persist_approval";
    } else {
      status = @"manual_reconciliation";
      next = @"inspect_native_state";
    }
  }
  attemptQuery = queryAttempt(error);
  if (attemptQuery == nil || ![attemptQuery[@"attempt"] isKindOfClass:NSDictionary.class]) {
    return nil;
  }
  NSDictionary *result = @{ @"schema_version" : @2, @"status" : status,
    @"operation_id" : request[@"operation_id"], @"next_action" : next,
    @"attempt" : attemptQuery[@"attempt"],
    @"completed_round" : completedRound ?: NSNull.null };
  return DSHRuntimeCommitRecoveryResult(self.wal, request, started, result,
                                        error);
}

- (NSDictionary *)finalizeAgentAttempt:(NSDictionary *)rawRequest
                                   error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest, @[
    @"schema_version", @"operation_id", @"controller_cas",
    @"committed_checkpoint", @"task_id", @"conversation_id", @"attempt_id",
    @"terminal_reason", @"cleanup_id", @"transcript", @"root",
  ], error);
  if (request == nil ||
      !DSHRuntimeControllerMatchesCheckpoint(request[@"controller_cas"],
                                             request[@"committed_checkpoint"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"finalize_agent_attempt", @"request" : request,
  }, error);
  NSDictionary *operationQuery = requestSHA == nil ? nil :
      DSHAgentNativeWALQueryOperation(self.wal, request[@"operation_id"],
          requestSHA, request[@"task_id"], request[@"attempt_id"], error);
  if (operationQuery == nil) return nil;
  if ([operationQuery[@"status"] isEqualToString:@"found"] &&
      ![operationQuery[@"record"][@"state"] isEqualToString:@"started"]) {
    NSDictionary *replay = DSHAgentNativeWALStartOperation(
        self.wal, @"finalize_agent_attempt", request, request[@"task_id"],
        request[@"attempt_id"],
        operationQuery[@"record"][@"authority_revision"], error);
    return [replay[@"status"] isEqualToString:@"replayed"]
        ? replay[@"result"][@"result"] : nil;
  }
  NSDictionary *sourceProof = DSHRuntimeSessionProof(
      self.preparedStore, request[@"conversation_id"], request[@"task_id"],
      request[@"attempt_id"],
      request[@"controller_cas"][@"expected_controller_generation"],
      request[@"controller_cas"][@"expected_journal_revision"],
      request[@"committed_checkpoint"][@"session_generation"],
      request[@"committed_checkpoint"][@"session_sha256"], error);
  if (sourceProof == nil) return nil;
  if (![sourceProof[@"matches"] boolValue]) {
    if ([operationQuery[@"status"] isEqualToString:@"found"]) {
      NSDictionary *queriedStarted = @{
        @"request_sha256" : operationQuery[@"record"][@"request_sha256"]
      };
      if (error != nullptr) *error = nil;
      return DSHRuntimeCommitFinalizeConflict(
          self.wal, request, queriedStarted, @"E_AGENT_CONFLICT", error);
    }
    if (error != nullptr) *error = nil;
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"],
      @"failure_code" : @"E_AGENT_CONFLICT" };
  }
  if (![self.preparedStore validatePreparedRoot:request[@"root"]
      taskId:request[@"task_id"] attemptId:request[@"attempt_id"] error:error]) {
    if ([operationQuery[@"status"] isEqualToString:@"found"]) {
      NSDictionary *queriedStarted = @{
        @"request_sha256" : operationQuery[@"record"][@"request_sha256"]
      };
      if (error != nullptr) *error = nil;
      return DSHRuntimeCommitFinalizeConflict(
          self.wal, request, queriedStarted, @"E_AGENT_ROOT_STALE", error);
    }
    return @{ @"schema_version" : @2, @"status" : @"conflict",
      @"operation_id" : request[@"operation_id"],
      @"failure_code" : @"E_AGENT_ROOT_STALE" };
  }
  NSDictionary *authority = [self.preparedStore
      nativeAuthorityForTaskId:request[@"task_id"]
                     attemptId:request[@"attempt_id"] error:error];
  if (authority == nil) return nil;
  NSNumber *operationAuthorityRevision =
      [operationQuery[@"status"] isEqualToString:@"found"]
      ? operationQuery[@"record"][@"authority_revision"]
      : authority[@"authority_revision"];
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      self.wal, @"finalize_agent_attempt", request, request[@"task_id"],
      request[@"attempt_id"], operationAuthorityRevision, error);
  if ([started[@"status"] isEqualToString:@"replayed"]) {
    return started[@"result"][@"result"];
  }
  if (started == nil) return nil;
  __block NSDictionary *output = nil;
  NSError *transactionError = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *authorities = [state[@"authorities"] mutableCopy];
    NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
    NSMutableArray *cleanup = [state[@"cleanup"] mutableCopy];
    NSUInteger authorityIndex = NSNotFound;
    NSUInteger transcriptIndex = NSNotFound;
    NSMutableDictionary *currentAuthority = nil;
    NSMutableDictionary *currentTranscript = nil;
    for (NSUInteger index = 0; index < authorities.count; index += 1) {
      NSDictionary *candidate = authorities[index];
      if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        authorityIndex = index;
        currentAuthority = [candidate mutableCopy];
        break;
      }
    }
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSDictionary *candidate = transcripts[index];
      if ([candidate[@"transcript_ref"]
              isEqual:request[@"transcript"][@"transcript_ref"]]) {
        transcriptIndex = index;
        currentTranscript = [candidate mutableCopy];
        break;
      }
    }
    BOOL finalRoundAdvance =
        currentAuthority != nil &&
        DSHRuntimeFinalRoundProvesTranscriptAdvance(state, currentAuthority,
            request, started[@"record"][@"authority_revision"]);
    BOOL authorityCurrent =
        [currentAuthority[@"conversation_id"]
            isEqual:request[@"conversation_id"]] &&
        [currentAuthority[@"root"] isEqual:request[@"root"]] &&
        ([currentAuthority[@"transcript"] isEqual:request[@"transcript"]] ||
         finalRoundAdvance) &&
        [currentAuthority[@"authority_revision"]
            isEqual:started[@"record"][@"authority_revision"]] &&
        ([currentAuthority[@"state"] isEqualToString:@"prepared"] ||
         ([currentAuthority[@"state"] isEqualToString:@"cleanup_pending"] &&
          [currentAuthority[@"cleanup_id"] isEqual:request[@"cleanup_id"]]));
    BOOL transcriptCurrent = [currentTranscript[@"attempt_id"]
            isEqual:request[@"attempt_id"]] &&
        [currentTranscript[@"transcript_sha256"]
            isEqual:request[@"transcript"][@"transcript_sha256"]] &&
        ([currentTranscript[@"state"] isEqualToString:@"open"] ||
         [currentTranscript[@"state"] isEqualToString:@"terminal"]);
    if (authorityIndex == NSNotFound || transcriptIndex == NSNotFound ||
        !authorityCurrent || !transcriptCurrent) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    BOOL cleanupFound = NO;
    for (NSDictionary *entry in cleanup) {
      if (![entry[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) continue;
      cleanupFound = YES;
      if (![entry[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
          ![entry[@"transcript_ref"] isEqual:request[@"transcript"][@"transcript_ref"]] ||
          ![entry[@"transcript_sha256"] isEqual:request[@"transcript"][@"transcript_sha256"]] ||
          ![entry[@"cleanup_owner"] isEqual:request[@"task_id"]] ||
          ![entry[@"reason"] isEqual:request[@"terminal_reason"]]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
    }
    NSString *timestamp = [self.wal currentTimestamp];
    if (!cleanupFound) {
      [cleanup addObject:@{ @"schema_version" : @1,
        @"cleanup_id" : request[@"cleanup_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"transcript_ref" : request[@"transcript"][@"transcript_ref"],
        @"transcript_sha256" : request[@"transcript"][@"transcript_sha256"],
        @"cleanup_owner" : request[@"task_id"],
        @"reason" : request[@"terminal_reason"], @"created_at" : timestamp,
        @"status" : @"pending" }];
    }
    NSUInteger revision = [currentAuthority[@"authority_revision"]
        unsignedIntegerValue];
    BOOL alreadyTerminal = [currentAuthority[@"state"]
            isEqualToString:@"cleanup_pending"] && cleanupFound &&
        [currentTranscript[@"state"] isEqualToString:@"terminal"];
    NSUInteger resultRevision = alreadyTerminal ? revision : revision + 1;
    if (!alreadyTerminal) {
      currentTranscript[@"state"] = @"terminal";
      currentTranscript[@"retention_until"] =
          [self.wal currentTimestampAddingInterval:7 * 24 * 60 * 60];
      currentTranscript[@"updated_at"] = timestamp;
      currentAuthority[@"state"] = @"cleanup_pending";
      currentAuthority[@"cleanup_id"] = request[@"cleanup_id"];
      currentAuthority[@"transcript"] = request[@"transcript"];
      currentAuthority[@"authority_revision"] = @(resultRevision);
      currentAuthority[@"updated_at"] = timestamp;
    }
    authorities[authorityIndex] = currentAuthority;
    transcripts[transcriptIndex] = currentTranscript;
    state[@"authorities"] = authorities;
    state[@"transcripts"] = transcripts;
    state[@"cleanup"] = cleanup;
    NSDictionary *result = @{ @"schema_version" : @2,
      @"status" : alreadyTerminal ? @"already_terminal" : @"terminal",
      @"operation_id" : request[@"operation_id"],
      @"cleanup_id" : request[@"cleanup_id"],
      @"transcript" : request[@"transcript"] };
    NSDictionary *safe = @{ @"schema_version" : @2,
      @"result_kind" : @"finalize_agent_attempt", @"result" : result };
    NSDictionary *operation = DSHAgentNativeWALCommitOperationInState(
        state, self.wal, request[@"operation_id"], started[@"request_sha256"],
        request[@"task_id"], request[@"attempt_id"], @"committed",
        result[@"status"], @{ @"schema_version" : @2, @"kind" : @"authority",
          @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
          @"authority_revision" : @(resultRevision) }, @(resultRevision), safe,
        mutationError);
    if (operation == nil) return NO;
    output = result;
    return YES;
  } error:&transactionError];
  if (committed) {
    if (error != nullptr) *error = nil;
    return output;
  }
  if (transactionError.code == DSHAgentNativeStoreErrorConflict) {
    NSError *commitError = nil;
    NSDictionary *conflict = DSHRuntimeCommitFinalizeConflict(
        self.wal, request, started, @"E_AGENT_CONFLICT", &commitError);
    if (conflict != nil) {
      if (error != nullptr) *error = nil;
      return conflict;
    }
    if (error != nullptr) *error = commitError ?: transactionError;
    return nil;
  }
  if (error != nullptr) *error = transactionError;
  return nil;
}

typedef NS_OPTIONS(NSUInteger, DSHRuntimeResidueDiscardOptions) {
  DSHRuntimeResidueDiscardStrict = 0,
  /// Drop ledger intent rows whose execution was never dispatched.  A
  /// dispatched intent may have executed and is never silently deleted.
  DSHRuntimeResidueDiscardUndispatchedIntents = 1 << 0,
  /// Create the cleanup row when the attempt never went through finalize
  /// (interruption of a dead writer's still-prepared authority).
  DSHRuntimeResidueDiscardCreateCleanupRow = 1 << 1,
};

/// Fail-closed discard of every WAL row owned by one attempt: authority,
/// transcript, rounds, ledger, reservations, batches, denied calls, dispatch
/// rows, and the attempt's settled operations.  Shared by discard (after a
/// committed finalize) and interrupt (a dead writer's prepared authority).
/// The caller has already proven the authority and started the operation;
/// this helper validates the cleanup row, refuses while any round outcome or
/// executed effect is unprovable, and commits the operation into the same
/// transaction.  Returns the public result, or nil with the mutation error
/// set and the state untouched.
static NSDictionary *DSHRuntimeDiscardAttemptResidue(
    NSMutableDictionary *state,
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSString *operationKind,
    NSString *requestSHA,
    DSHRuntimeResidueDiscardOptions options,
    NSError **mutationError) {
  NSString *attemptId = request[@"attempt_id"];
  NSMutableArray *cleanup = [state[@"cleanup"] mutableCopy];
  NSMutableDictionary *cleanupRow = nil;
  NSUInteger cleanupIndex = NSNotFound;
  for (NSUInteger index = 0; index < cleanup.count; index += 1) {
    NSDictionary *candidate = cleanup[index];
    if ([candidate[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) {
      cleanupIndex = index;
      cleanupRow = [candidate mutableCopy];
      break;
    }
  }
  if (cleanupRow == nil &&
      (options & DSHRuntimeResidueDiscardCreateCleanupRow) != 0) {
    cleanupRow = [@{
      @"schema_version" : @1,
      @"cleanup_id" : request[@"cleanup_id"],
      @"attempt_id" : attemptId,
      @"transcript_ref" : request[@"transcript_ref"],
      @"transcript_sha256" : request[@"transcript_sha256"],
      @"cleanup_owner" : request[@"task_id"],
      @"reason" : request[@"reason"],
      @"created_at" : [wal currentTimestamp],
      @"status" : @"pending",
    } mutableCopy];
    [cleanup addObject:cleanupRow];
    cleanupIndex = cleanup.count - 1;
  }
  if (cleanupRow == nil ||
      ![cleanupRow[@"attempt_id"] isEqual:attemptId] ||
      ![cleanupRow[@"transcript_ref"] isEqual:request[@"transcript_ref"]] ||
      ![cleanupRow[@"transcript_sha256"] isEqual:request[@"transcript_sha256"]] ||
      ![cleanupRow[@"cleanup_owner"] isEqual:request[@"task_id"]] ||
      ![cleanupRow[@"status"] isEqualToString:@"pending"]) {
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  for (NSDictionary *round in state[@"rounds"]) {
    if (![round[@"locator"][@"attempt_id"] isEqual:attemptId]) continue;
    if ([@[@"in_flight", @"cancel_requested", @"unknown", @"ambiguous"]
            containsObject:round[@"state"]]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return nil;
    }
  }
  for (NSDictionary *row in state[@"ledger"]) {
    if (![row[@"locator"][@"attempt_id"] isEqual:attemptId]) continue;
    NSString *rowState = row[@"state"];
    if ([@[@"running", @"cancel_requested", @"unknown", @"ambiguous"]
            containsObject:rowState]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    if (![rowState isEqualToString:@"intent"]) continue;
    if ((options & DSHRuntimeResidueDiscardUndispatchedIntents) == 0) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    NSDictionary *locator = row[@"locator"];
    for (NSDictionary *dispatch in state[@"dispatch"]) {
      if (![dispatch[@"kind"] isEqualToString:@"execution"] ||
          ![dispatch[@"locator"] isEqual:locator]) continue;
      if ([dispatch[@"dispatch_state"] isEqualToString:@"dispatched"]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return nil;
      }
    }
  }
  NSPredicate *keepAttempt = [NSPredicate predicateWithBlock:
      ^BOOL(NSDictionary *row, NSDictionary *bindings) {
    (void)bindings;
    NSString *candidate = row[@"attempt_id"] ?: row[@"locator"][@"attempt_id"];
    return ![candidate isEqual:attemptId];
  }];
  NSMutableArray *keptOperations = [NSMutableArray array];
  NSMutableSet *removedOperationIds = [NSMutableSet set];
  for (NSDictionary *operation in state[@"operations"]) {
    if ([operation[@"attempt_id"] isEqual:attemptId] &&
        ![operation[@"operation_id"] isEqual:request[@"operation_id"]]) {
      NSString *operationState = operation[@"state"];
      if ([operationState isEqualToString:@"started"] ||
          [operationState isEqualToString:@"unknown"] ||
          [operationState isEqualToString:@"ambiguous"]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return nil;
      }
      if (![operationState isEqualToString:@"committed"] &&
          ![operationState isEqualToString:@"rejected"] &&
          ![operationState isEqualToString:@"conflict"]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorCorrupt);
        return nil;
      }
      [removedOperationIds addObject:operation[@"operation_id"]];
    } else {
      [keptOperations addObject:operation];
    }
  }
  NSMutableArray *keptResults = [NSMutableArray array];
  for (NSDictionary *result in state[@"operation_results"]) {
    if (![removedOperationIds containsObject:result[@"operation_id"]]) {
      [keptResults addObject:result];
    }
  }
  NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
  NSIndexSet *transcriptIndexes = [transcripts indexesOfObjectsPassingTest:
      ^BOOL(NSDictionary *row, NSUInteger index, BOOL *stop) {
    (void)index; (void)stop;
    return [row[@"attempt_id"] isEqual:attemptId];
  }];
  [transcripts removeObjectsAtIndexes:transcriptIndexes];
  cleanupRow[@"status"] = @"discarded";
  cleanup[cleanupIndex] = cleanupRow;
  state[@"authorities"] = [state[@"authorities"] filteredArrayUsingPredicate:keepAttempt];
  state[@"rounds"] = [state[@"rounds"] filteredArrayUsingPredicate:keepAttempt];
  state[@"ledger"] = [state[@"ledger"] filteredArrayUsingPredicate:keepAttempt];
  state[@"reservations"] = [state[@"reservations"] filteredArrayUsingPredicate:keepAttempt];
  state[@"batches"] = [state[@"batches"] filteredArrayUsingPredicate:keepAttempt];
  state[@"denied_calls"] = [state[@"denied_calls"] filteredArrayUsingPredicate:keepAttempt];
  state[@"dispatch"] = [state[@"dispatch"] filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSDictionary *row,
                                             NSDictionary *bindings) {
    (void)bindings;
    return ![row[@"locator"][@"attempt_id"] isEqual:attemptId];
  }]];
  state[@"transcripts"] = transcripts;
  state[@"cleanup"] = cleanup;
  state[@"operations"] = keptOperations;
  state[@"operation_results"] = keptResults;
  NSDictionary *result = @{ @"schema_version" : @2,
    @"status" : @"discarded", @"operation_id" : request[@"operation_id"],
    @"cleanup_id" : request[@"cleanup_id"] };
  NSDictionary *safe = @{ @"schema_version" : @2,
    @"result_kind" : operationKind, @"result" : result };
  NSDictionary *operation = DSHAgentNativeWALCommitOperationInState(
      state, wal, request[@"operation_id"], requestSHA,
      request[@"task_id"], attemptId, @"committed",
      @"discarded", @{ @"schema_version" : @2, @"kind" : @"cleanup",
        @"cleanup_id" : request[@"cleanup_id"] }, @1, safe, mutationError);
  return operation == nil ? nil : result;
}

/// Closes an operation whose durable residue is already gone.  Only a
/// discarded cleanup row that still proves this exact transcript ownership
/// may close it; the result is committed as already_missing.
static NSDictionary *DSHRuntimeCommitAlreadyMissing(
    DSHAgentNativeWAL *wal,
    NSDictionary *request,
    NSString *operationKind,
    NSDictionary *operationQuery,
    NSError **error) {
  NSNumber *operationAuthorityRevision =
      [operationQuery[@"status"] isEqualToString:@"found"]
      ? operationQuery[@"record"][@"authority_revision"] : @0;
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      wal, operationKind, request, request[@"task_id"],
      request[@"attempt_id"], operationAuthorityRevision, error);
  if ([started[@"status"] isEqualToString:@"replayed"]) {
    return started[@"result"][@"result"];
  }
  if (started == nil) return nil;
  NSDictionary *result = @{ @"schema_version" : @2,
    @"status" : @"already_missing", @"operation_id" : request[@"operation_id"],
    @"cleanup_id" : request[@"cleanup_id"] };
  NSDictionary *safe = @{ @"schema_version" : @2,
    @"result_kind" : operationKind, @"result" : result };
  NSDictionary *committed = DSHAgentNativeWALCommitOperation(
      wal, request[@"operation_id"], started[@"request_sha256"],
      request[@"task_id"], request[@"attempt_id"], @"committed",
      @"already_missing", @{ @"schema_version" : @2, @"kind" : @"cleanup",
        @"cleanup_id" : request[@"cleanup_id"] }, @1, safe, error);
  return committed == nil ? nil : committed[@"result"][@"result"];
}

static BOOL DSHRuntimeExactDiscardedCleanup(NSDictionary *cleanupRow,
                                            NSDictionary *request) {
  return [cleanupRow[@"status"] isEqualToString:@"discarded"] &&
      [cleanupRow[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
      [cleanupRow[@"transcript_ref"] isEqual:request[@"transcript_ref"]] &&
      [cleanupRow[@"transcript_sha256"]
          isEqual:request[@"transcript_sha256"]] &&
      [cleanupRow[@"cleanup_owner"] isEqual:request[@"task_id"]];
}

- (NSDictionary *)discardAgentAttempt:(NSDictionary *)rawRequest
                                  error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest, @[
    @"schema_version", @"operation_id", @"cleanup_id", @"task_id",
    @"conversation_id", @"attempt_id", @"transcript_ref", @"transcript_sha256",
  ], error);
  if (request == nil) return nil;
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"discard_agent_attempt", @"request" : request,
  }, error);
  NSDictionary *operationQuery = requestSHA == nil ? nil :
      DSHAgentNativeWALQueryOperation(self.wal, request[@"operation_id"],
          requestSHA, request[@"task_id"], request[@"attempt_id"], error);
  if (operationQuery == nil) return nil;
  if ([operationQuery[@"status"] isEqualToString:@"found"] &&
      ![operationQuery[@"record"][@"state"] isEqualToString:@"started"]) {
    NSDictionary *replay = DSHAgentNativeWALStartOperation(
        self.wal, @"discard_agent_attempt", request, request[@"task_id"],
        request[@"attempt_id"],
        operationQuery[@"record"][@"authority_revision"], error);
    return [replay[@"status"] isEqualToString:@"replayed"]
        ? replay[@"result"][@"result"] : nil;
  }
  NSDictionary *stateBefore = [self.wal snapshotWithError:error];
  if (stateBefore == nil) return nil;
  NSDictionary *authority = DSHRuntimeFindAuthority(
      stateBefore, request[@"task_id"], request[@"attempt_id"]);
  if (authority == nil) {
    NSDictionary *cleanupRow = DSHRuntimeFindCleanup(stateBefore,
                                                      request[@"cleanup_id"]);
    if (!DSHRuntimeExactDiscardedCleanup(cleanupRow, request) ||
        !DSHRuntimeCleanupOutboxProof(self.preparedStore, request, error)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    return DSHRuntimeCommitAlreadyMissing(self.wal, request,
                                          @"discard_agent_attempt",
                                          operationQuery, error);
  }
  if (![authority[@"conversation_id"] isEqual:request[@"conversation_id"]] ||
      ![authority[@"state"] isEqualToString:@"cleanup_pending"] ||
      ![authority[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSNumber *operationAuthorityRevision =
      [operationQuery[@"status"] isEqualToString:@"found"]
      ? operationQuery[@"record"][@"authority_revision"]
      : authority[@"authority_revision"];
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      self.wal, @"discard_agent_attempt", request, request[@"task_id"],
      request[@"attempt_id"], operationAuthorityRevision, error);
  if (started == nil) return nil;
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSDictionary *currentAuthority = DSHRuntimeFindAuthority(
        state, request[@"task_id"], request[@"attempt_id"]);
    if (![currentAuthority[@"conversation_id"] isEqual:request[@"conversation_id"]] ||
        ![currentAuthority[@"state"] isEqualToString:@"cleanup_pending"] ||
        ![currentAuthority[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    output = DSHRuntimeDiscardAttemptResidue(
        state, self.wal, request, @"discard_agent_attempt",
        started[@"request_sha256"], DSHRuntimeResidueDiscardStrict,
        mutationError);
    return output != nil;
  } error:error];
  return committed ? output : nil;
}

/// Interruption proof: the persisted session must record the attempt as
/// terminal (failed with E_ATTEMPT_INTERRUPTED, or completed/cancelled/failed
/// with a journal whose transcript matches the request), and the cleanup
/// outbox must carry the exact matching entry for the request's cleanup
/// identity.  The snapshot generation/sha must equal the caller's committed
/// checkpoint, so only the controller that durably recorded the interruption
/// can discard the native residue.
static BOOL DSHRuntimeInterruptionProof(
    DSHAgentPreparedAttemptStore *preparedStore,
    NSDictionary *request,
    NSError **error) {
  NSDictionary *loaded = [preparedStore.sessionSnapshotStore
      loadSessionSnapshotWithError:error];
  NSDictionary *snapshot = loaded[@"snapshot"];
  id sessionJSON = loaded[@"session_json"];
  if (![loaded[@"status"] isEqualToString:@"present"] ||
      ![snapshot isKindOfClass:NSDictionary.class] ||
      ![sessionJSON isKindOfClass:NSString.class] ||
      ![snapshot[@"generation"]
          isEqual:request[@"expected_session_generation"]] ||
      ![snapshot[@"session_sha256"]
          isEqual:request[@"expected_session_sha256"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSData *bytes = [sessionJSON dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *session = bytes == nil ? nil :
      [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  if (![session isKindOfClass:NSDictionary.class] ||
      ![session[@"schema_version"] isEqual:@9]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSArray *outbox = session[@"agent_transcript_cleanup_outbox"];
  if (![outbox isKindOfClass:NSArray.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSDictionary *matched = nil;
  for (NSDictionary *candidate in outbox) {
    if (![candidate[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) continue;
    if (matched != nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    matched = candidate;
  }
  BOOL matches = DSHAgentExactDictionaryKeys(matched, @[
    @"schema_version", @"cleanup_id", @"conversation_id", @"task_id",
    @"attempt_id", @"transcript_ref", @"transcript_sha256", @"reason",
    @"created_at",
  ]) && [matched[@"schema_version"] isEqual:@1] &&
      [matched[@"conversation_id"] isEqual:request[@"conversation_id"]] &&
      [matched[@"task_id"] isEqual:request[@"task_id"]] &&
      [matched[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
      [matched[@"transcript_ref"] isEqual:request[@"transcript_ref"]] &&
      [matched[@"transcript_sha256"] isEqual:request[@"transcript_sha256"]] &&
      [matched[@"reason"] isEqual:request[@"reason"]] &&
      DSHAgentCanonicalTimestamp(matched[@"created_at"]);
  if (!matches) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSDictionary *conversation = nil;
  for (NSDictionary *candidate in session[@"conversations"]) {
    if ([candidate[@"id"] isEqual:request[@"conversation_id"]]) {
      conversation = candidate;
      break;
    }
  }
  NSDictionary *attempt = nil;
  for (NSDictionary *candidate in conversation[@"attempts"]) {
    if ([candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
      attempt = candidate;
      break;
    }
  }
  if (attempt == nil || ![attempt[@"turn_id"] isEqual:request[@"task_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSString *status = attempt[@"status"];
  BOOL interrupted =
      [status isEqualToString:@"failed"] &&
      [attempt[@"failure_code"] isEqual:@"E_ATTEMPT_INTERRUPTED"] &&
      [matched[@"reason"] isEqual:@"failed"];
  BOOL journalTerminal = NO;
  if (attempt[@"agent"] != NSNull.null) {
    NSDictionary *transcript = attempt[@"agent"][@"transcript"];
    journalTerminal =
        ([status isEqualToString:@"completed"] ||
         [status isEqualToString:@"cancelled"] ||
         [status isEqualToString:@"failed"]) &&
        [transcript[@"transcript_ref"] isEqual:request[@"transcript_ref"]] &&
        [transcript[@"transcript_sha256"]
            isEqual:request[@"transcript_sha256"]];
  }
  if (!(interrupted && attempt[@"agent"] == NSNull.null) && !journalTerminal) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

- (NSDictionary *)interruptAgentAttempt:(NSDictionary *)rawRequest
                                   error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest, @[
    @"schema_version", @"operation_id", @"cleanup_id", @"task_id",
    @"conversation_id", @"attempt_id", @"transcript_ref", @"transcript_sha256",
    @"reason", @"expected_session_generation", @"expected_session_sha256",
  ], error);
  if (request == nil) return nil;
  if (![@[@"completed", @"cancelled", @"failed"]
          containsObject:request[@"reason"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if (!DSHRuntimeInterruptionProof(self.preparedStore, request, error)) {
    return nil;
  }
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"interrupt_agent_attempt", @"request" : request,
  }, error);
  NSDictionary *operationQuery = requestSHA == nil ? nil :
      DSHAgentNativeWALQueryOperation(self.wal, request[@"operation_id"],
          requestSHA, request[@"task_id"], request[@"attempt_id"], error);
  if (operationQuery == nil) return nil;
  if ([operationQuery[@"status"] isEqualToString:@"found"] &&
      ![operationQuery[@"record"][@"state"] isEqualToString:@"started"]) {
    NSDictionary *replay = DSHAgentNativeWALStartOperation(
        self.wal, @"interrupt_agent_attempt", request, request[@"task_id"],
        request[@"attempt_id"],
        operationQuery[@"record"][@"authority_revision"], error);
    return [replay[@"status"] isEqualToString:@"replayed"]
        ? replay[@"result"][@"result"] : nil;
  }
  NSDictionary *stateBefore = [self.wal snapshotWithError:error];
  if (stateBefore == nil) return nil;
  NSDictionary *authority = DSHRuntimeFindAuthority(
      stateBefore, request[@"task_id"], request[@"attempt_id"]);
  if (authority == nil) {
    NSDictionary *cleanupRow = DSHRuntimeFindCleanup(stateBefore,
                                                      request[@"cleanup_id"]);
    if (!DSHRuntimeExactDiscardedCleanup(cleanupRow, request)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    return DSHRuntimeCommitAlreadyMissing(self.wal, request,
                                          @"interrupt_agent_attempt",
                                          operationQuery, error);
  }
  BOOL (^authorityInterruptible)(NSDictionary *) = ^BOOL(NSDictionary *row) {
    return [row[@"conversation_id"] isEqual:request[@"conversation_id"]] &&
        ([row[@"state"] isEqualToString:@"prepared"] ||
         ([row[@"state"] isEqualToString:@"cleanup_pending"] &&
          [row[@"cleanup_id"] isEqual:request[@"cleanup_id"]]));
  };
  if (!authorityInterruptible(authority)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSNumber *operationAuthorityRevision =
      [operationQuery[@"status"] isEqualToString:@"found"]
      ? operationQuery[@"record"][@"authority_revision"]
      : authority[@"authority_revision"];
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      self.wal, @"interrupt_agent_attempt", request, request[@"task_id"],
      request[@"attempt_id"], operationAuthorityRevision, error);
  if (started == nil) return nil;
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSDictionary *currentAuthority = DSHRuntimeFindAuthority(
        state, request[@"task_id"], request[@"attempt_id"]);
    if (!authorityInterruptible(currentAuthority)) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    output = DSHRuntimeDiscardAttemptResidue(
        state, self.wal, request, @"interrupt_agent_attempt",
        started[@"request_sha256"],
        DSHRuntimeResidueDiscardUndispatchedIntents |
            DSHRuntimeResidueDiscardCreateCleanupRow,
        mutationError);
    return output != nil;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)queryAgentCleanup:(NSDictionary *)rawRequest
                                error:(NSError **)error {
  NSDictionary *request = DSHRuntimeRequest(rawRequest,
      @[@"schema_version", @"cleanup_id"], error);
  if (request == nil) return nil;
  NSDictionary *result = [self.transcripts queryAgentTranscriptCleanupWithRequest:@{
    @"schema_version" : @1, @"cleanup_id" : request[@"cleanup_id"],
  } error:error];
  return result == nil ? nil : @{ @"schema_version" : @2,
    @"status" : result[@"status"], @"cleanup_id" : request[@"cleanup_id"] };
}

@end
