#import "AgentPreparedAttemptStore.h"

#import "DSHWorkspaceCanonical.h"

#include <CoreFoundation/CoreFoundation.h>
#include <math.h>

static const NSUInteger DSHAgentPreparedMaximumSafeInteger = 9007199254740991ULL;
static const NSUInteger DSHAgentPreparedMaximumAuthorities = 128;
static const NSUInteger DSHAgentPreparedMaximumOperations = 2048;
static const NSUInteger DSHAgentPreparedMaximumOperationsPerAttempt = 256;

static NSArray<NSString *> *DSHAgentPreparedRequestKeys(void) {
  return @[
    @"schema_version", @"operation_id", @"controller_cas",
    @"committed_checkpoint", @"task_id", @"conversation_id", @"attempt_id",
    @"workspace_id", @"project_id", @"workspace_binding_revision",
    @"transport_schema_version", @"model", @"thinking_mode",
    @"visible_message_ids", @"visible_history_sha256", @"visible_message_count",
    @"project_context_sha256", @"registry_version", @"expected_policy_version",
    @"expected_transcript",
  ];
}

static NSArray<NSString *> *DSHAgentPreparedControllerCASKeys(void) {
  return @[
    @"schema_version", @"conversation_id", @"task_id", @"attempt_id",
    @"expected_controller_generation", @"expected_journal_revision",
    @"expected_session_generation", @"expected_session_sha256",
  ];
}

static NSArray<NSString *> *DSHAgentPreparedCheckpointKeys(void) {
  return @[
    @"schema_version", @"journal_revision", @"session_generation",
    @"session_sha256",
  ];
}

static NSArray<NSString *> *DSHAgentPreparedTranscriptKeys(void) {
  return @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ];
}

static void DSHSetPreparedError(NSError **error,
                                DSHAgentNativeStoreErrorCode code) {
  if (error != nullptr) *error = DSHAgentNativeStoreError(code);
}

static BOOL DSHPreparedSchema(id value, NSUInteger expected) {
  return DSHAgentSafeInteger(value, expected, NO) && [value isEqual:@(expected)];
}

static BOOL DSHPreparedNullableUUID(id value) {
  return value == NSNull.null || DSHAgentCanonicalUUID(value);
}

static BOOL DSHPreparedNullableDigest(id value) {
  return value == NSNull.null || DSHAgentCanonicalSHA256(value);
}

static BOOL DSHPreparedExactReference(NSDictionary *reference) {
  return DSHAgentExactDictionaryKeys(reference, DSHAgentPreparedTranscriptKeys()) &&
      DSHPreparedSchema(reference[@"schema_version"], 1) &&
      DSHAgentCanonicalUUID(reference[@"transcript_ref"]) &&
      DSHAgentSafeInteger(reference[@"generation"],
                          DSHAgentPreparedMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(reference[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(reference[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

static BOOL DSHPreparedControllerCAS(NSDictionary *cas,
                                     NSString *conversationId,
                                     NSString *taskId,
                                     NSString *attemptId) {
  return DSHAgentExactDictionaryKeys(cas, DSHAgentPreparedControllerCASKeys()) &&
      DSHPreparedSchema(cas[@"schema_version"], 1) &&
      DSHAgentCanonicalUUID(cas[@"conversation_id"]) &&
      DSHAgentCanonicalUUID(cas[@"task_id"]) &&
      DSHAgentCanonicalUUID(cas[@"attempt_id"]) &&
      [cas[@"conversation_id"] isEqual:conversationId] &&
      [cas[@"task_id"] isEqual:taskId] &&
      [cas[@"attempt_id"] isEqual:attemptId] &&
      DSHAgentSafeInteger(cas[@"expected_controller_generation"],
                          DSHAgentPreparedMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_journal_revision"],
                          DSHAgentPreparedMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_session_generation"],
                          DSHAgentPreparedMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(cas[@"expected_session_sha256"]);
}

static BOOL DSHPreparedControllerCheckpointRelation(NSDictionary *request) {
  NSDictionary *cas = request[@"controller_cas"];
  NSDictionary *checkpoint = request[@"committed_checkpoint"];
  return [cas[@"expected_journal_revision"]
             isEqual:checkpoint[@"journal_revision"]] &&
      [cas[@"expected_session_generation"]
             isEqual:checkpoint[@"session_generation"]] &&
      [cas[@"expected_session_sha256"]
             isEqual:checkpoint[@"session_sha256"]];
}

static BOOL DSHPreparedRequestShape(NSDictionary *request) {
  if (!DSHAgentIsImmutableFoundationJSON(request) ||
      !DSHAgentExactDictionaryKeys(request, DSHAgentPreparedRequestKeys()) ||
      !DSHPreparedSchema(request[@"schema_version"], 2) ||
      !DSHAgentCanonicalUUID(request[@"operation_id"]) ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"conversation_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHPreparedControllerCAS(request[@"controller_cas"],
                                request[@"conversation_id"],
                                request[@"task_id"],
                                request[@"attempt_id"]) ||
      !DSHAgentExactDictionaryKeys(request[@"committed_checkpoint"],
                                   DSHAgentPreparedCheckpointKeys()) ||
      !DSHPreparedSchema(request[@"committed_checkpoint"][@"schema_version"], 1) ||
      !DSHAgentSafeInteger(request[@"committed_checkpoint"][@"journal_revision"],
                           DSHAgentPreparedMaximumSafeInteger, YES) ||
      !DSHAgentSafeInteger(request[@"committed_checkpoint"][@"session_generation"],
                           DSHAgentPreparedMaximumSafeInteger, YES) ||
      !DSHAgentCanonicalSHA256(request[@"committed_checkpoint"][@"session_sha256"]) ||
      !DSHPreparedNullableUUID(request[@"workspace_id"]) ||
      !DSHPreparedNullableUUID(request[@"project_id"]) ||
      !(request[@"workspace_binding_revision"] == NSNull.null ||
        DSHAgentSafeInteger(request[@"workspace_binding_revision"],
                            DSHAgentPreparedMaximumSafeInteger, NO)) ||
      ![request[@"transport_schema_version"] isEqual:@2] &&
          ![request[@"transport_schema_version"] isEqual:@3] ||
      !DSHAgentBoundedUTF8String(request[@"model"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(request[@"thinking_mode"], 32, NO, nullptr) ||
      ![request[@"visible_message_ids"] isKindOfClass:NSArray.class] ||
      [request[@"visible_message_ids"] count] > 96 ||
      !DSHAgentCanonicalSHA256(request[@"visible_history_sha256"]) ||
      !DSHAgentSafeInteger(request[@"visible_message_count"], 96, YES) ||
      [request[@"visible_message_ids"] count] !=
          [request[@"visible_message_count"] unsignedIntegerValue] ||
      !DSHAgentCanonicalSHA256(request[@"visible_history_sha256"]) ||
      !DSHPreparedNullableDigest(request[@"project_context_sha256"]) ||
      ![request[@"registry_version"] isEqual:@1] ||
      !(request[@"expected_policy_version"] == NSNull.null ||
        ([request[@"expected_policy_version"] isKindOfClass:NSString.class] &&
         [request[@"expected_policy_version"] isEqualToString:@"agent-v1"])) ||
      !(request[@"expected_transcript"] == NSNull.null ||
        DSHPreparedExactReference(request[@"expected_transcript"]))) {
    return NO;
  }
  NSSet *models = [NSSet setWithArray:@[
    @"deepseek-v4-flash", @"deepseek-v4-pro", @"deepseek-v4-flash-vision-exp",
  ]];
  NSSet *thinkingModes = [NSSet setWithArray:@[@"off", @"high", @"max"]];
  if (![models containsObject:request[@"model"]] ||
      ![thinkingModes containsObject:request[@"thinking_mode"]]) return NO;
  NSMutableSet *visibleIds = [NSMutableSet set];
  for (id value in request[@"visible_message_ids"]) {
    if (!DSHAgentCanonicalUUID(value) || [visibleIds containsObject:value]) return NO;
    [visibleIds addObject:value];
  }
  BOOL hasWorkspace = request[@"workspace_id"] != NSNull.null;
  BOOL hasProject = request[@"project_id"] != NSNull.null;
  BOOL hasRevision = request[@"workspace_binding_revision"] != NSNull.null;
  if (hasWorkspace != hasRevision || (hasProject && !hasWorkspace) ||
      (request[@"transport_schema_version"] == nil)) return NO;
  BOOL schema3 = [request[@"transport_schema_version"] isEqual:@3];
  BOOL hasContext = request[@"project_context_sha256"] != NSNull.null;
  if (schema3 != (hasContext && hasProject)) return NO;
  if (schema3 && !hasProject) return NO;
  return YES;
}

static NSDictionary *DSHPreparedTranscriptReference(NSDictionary *row) {
  return @{
    @"schema_version" : @1,
    @"transcript_ref" : row[@"transcript_ref"],
    @"generation" : row[@"generation"],
    @"transcript_sha256" : row[@"transcript_sha256"],
    @"transcript_bytes" : row[@"transcript_bytes"],
  };
}

static NSDictionary *DSHPreparedTranscriptRow(NSString *attemptId,
                                              NSString *rootFingerprint,
                                              DSHAgentNativeWAL *wal,
                                              NSArray *existing,
                                              NSError **error) {
  NSString *ref = nil;
  for (NSUInteger index = 0; index < 16 && ref == nil; index += 1) {
    NSString *candidate = NSUUID.UUID.UUIDString.lowercaseString;
    BOOL used = NO;
    for (NSDictionary *row in existing) {
      if ([row[@"transcript_ref"] isEqual:candidate]) {
        used = YES;
        break;
      }
    }
    if (!used) ref = candidate;
  }
  if (ref == nil) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorCapacity);
    return nil;
  }
  NSDictionary *digestInput = @{
    @"schema_version" : @1,
    @"transcript_ref" : ref,
    @"attempt_id" : attemptId,
    @"root_fingerprint_sha256" : rootFingerprint,
    @"generation" : @0,
    @"messages" : @[],
  };
  NSError *digestError = nil;
  NSData *digestBytes = DSHAgentCanonicalJSON(digestInput, &digestError);
  NSString *digest = DSHAgentHJ(@"agent-transcript", digestInput, &digestError);
  if (digestBytes == nil || digest == nil ||
      digestBytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *timestamp = [wal currentTimestamp];
  return @{
    @"schema_version" : @1,
    @"transcript_ref" : ref,
    @"attempt_id" : attemptId,
    @"root_fingerprint_sha256" : rootFingerprint,
    @"generation" : @0,
    @"messages" : @[],
    @"transcript_sha256" : digest,
    @"transcript_bytes" : @(digestBytes.length),
    @"state" : @"open",
    @"retention_until" : NSNull.null,
    @"created_at" : timestamp,
    @"updated_at" : timestamp,
  };
}

static NSDictionary *DSHPreparedEmptyRegistry(DSHAgentToolRegistry *registry) {
  return @{
    @"schema_version" : @2,
    @"registry_version" : @1,
    @"toolset_sha256" : registry.toolsetSHA256,
    @"tools" : @[],
  };
}

static NSString *DSHPreparedPhaseForAuthority(NSDictionary *authority) {
  NSString *state = authority[@"state"];
  if ([state isEqualToString:@"prepared"]) return @"ready_for_round";
  if ([state isEqualToString:@"cleanup_pending"]) return @"failed";
  return @"final_response";
}

static NSDictionary *DSHPreparedProjectionForAuthority(
    NSDictionary *authority,
    NSNumber *controllerGeneration,
    NSNumber *journalRevision) {
  return @{
    @"schema_version" : @2,
    @"task_id" : authority[@"task_id"],
    @"conversation_id" : authority[@"conversation_id"],
    @"attempt_id" : authority[@"attempt_id"],
    @"phase" : DSHPreparedPhaseForAuthority(authority),
    @"controller_generation" : controllerGeneration ?: @0,
    @"journal_revision" : journalRevision ?: @0,
    @"authority_revision" : authority[@"authority_revision"],
    @"root" : authority[@"root"],
    @"policy" : authority[@"policy"],
    @"registry" : authority[@"registry"],
    @"transcript" : authority[@"transcript"],
    @"round_index" : @0,
    @"round_id" : NSNull.null,
    @"round_revision" : NSNull.null,
    @"round_status" : NSNull.null,
    @"batch_kind" : NSNull.null,
    @"batch_revision" : NSNull.null,
    @"manifest_sha256" : NSNull.null,
    @"call_index" : NSNull.null,
    @"batch" : @[],
    @"frozen_grant_ids" : @[],
    @"reserved_write_bytes" : authority[@"reserved_write_bytes"],
    @"cancel_source_event_id" : NSNull.null,
    @"cleanup_id" : authority[@"cleanup_id"],
  };
}

static NSDictionary *DSHPreparedNotAgentProjection(NSString *taskId,
                                                   NSString *conversationId,
                                                   NSString *attemptId,
                                                   NSNumber *controllerGeneration,
                                                   NSNumber *journalRevision,
                                                   DSHAgentToolRegistry *registry) {
  return @{
    @"schema_version" : @2,
    @"task_id" : taskId,
    @"conversation_id" : conversationId,
    @"attempt_id" : attemptId,
    @"phase" : @"not_agent",
    @"controller_generation" : controllerGeneration,
    @"journal_revision" : journalRevision,
    @"authority_revision" : @0,
    @"root" : NSNull.null,
    @"policy" : NSNull.null,
    @"registry" : DSHPreparedEmptyRegistry(registry),
    @"transcript" : NSNull.null,
    @"round_index" : @0,
    @"round_id" : NSNull.null,
    @"round_revision" : NSNull.null,
    @"round_status" : NSNull.null,
    @"batch_kind" : NSNull.null,
    @"batch_revision" : NSNull.null,
    @"manifest_sha256" : NSNull.null,
    @"call_index" : NSNull.null,
    @"batch" : @[],
    @"frozen_grant_ids" : @[],
    @"reserved_write_bytes" : @0,
    @"cancel_source_event_id" : NSNull.null,
    @"cleanup_id" : NSNull.null,
  };
}

static NSDictionary *DSHPreparedPublicResult(NSString *status,
                                             NSString *operationId,
                                             NSDictionary *attempt,
                                             NSDictionary *checkpoint,
                                             NSString *failureCode) {
  NSMutableDictionary *result = [@{
    @"schema_version" : @2,
    @"status" : status,
    @"operation_id" : operationId,
    @"attempt" : attempt,
    @"observed_checkpoint" : checkpoint,
  } mutableCopy];
  if (failureCode != nil) result[@"failure_code"] = failureCode;
  return [result copy];
}

static NSDictionary *DSHPreparedFindConversation(NSDictionary *session,
                                                 NSString *conversationId);
static NSDictionary *DSHPreparedFindAttempt(NSDictionary *conversation,
                                            NSString *attemptId);

static NSDictionary *DSHPreparedSafeResult(NSString *operationId,
                                           NSString *status,
                                           NSDictionary *publicResult) {
  return @{
    @"schema_version" : @2,
    @"result_kind" : @"prepare_agent_attempt",
    @"result" : publicResult,
  };
}

static NSDictionary *DSHPreparedOperationSnapshot(NSString *operationId,
                                                  NSString *status,
                                                  NSDictionary *safeResult,
                                                  NSString *timestamp,
                                                  NSError **error) {
  NSError *digestError = nil;
  NSData *resultBytes = DSHAgentCanonicalJSON(safeResult, &digestError);
  NSString *resultSHA = DSHAgentHJ(@"agent-operation-result", @{
    @"operation_kind" : @"prepare_agent_attempt",
    @"result_status" : status,
    @"result" : safeResult,
  }, &digestError);
  if (resultBytes == nil || resultBytes.length == 0 ||
      resultBytes.length > 768 * 1024 || resultSHA == nil) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorCapacity);
    return nil;
  }
  return @{
    @"schema_version" : @2,
    @"operation_id" : operationId,
    @"operation_kind" : @"prepare_agent_attempt",
    @"result_status" : status,
    @"result_sha256" : resultSHA,
    @"result_bytes" : @(resultBytes.length),
    @"result" : safeResult,
    @"created_at" : timestamp,
  };
}

static NSDictionary *DSHPreparedConflictResult(NSString *operationId,
                                               NSString *failureCode,
                                               NSDictionary *request,
                                               NSNumber *actualControllerGeneration,
                                               NSNumber *actualJournalRevision,
                                               NSNumber *actualSessionGeneration,
                                               NSString *actualSessionSHA256) {
  NSDictionary *cas = request[@"controller_cas"];
  NSDictionary *checkpoint = request[@"committed_checkpoint"];
  return @{
    @"schema_version" : @2,
    @"status" : @"conflict",
    @"operation_id" : operationId,
    @"failure_code" : failureCode,
    @"expected_controller_generation" : cas[@"expected_controller_generation"],
    @"expected_journal_revision" : cas[@"expected_journal_revision"],
    @"expected_session_generation" : checkpoint[@"session_generation"],
    @"expected_session_sha256" : checkpoint[@"session_sha256"],
    @"actual_controller_generation" : actualControllerGeneration ?: @0,
    @"actual_journal_revision" : actualJournalRevision ?: @0,
    @"actual_session_generation" : actualSessionGeneration ?: @0,
    @"actual_session_sha256" : actualSessionSHA256 ?: checkpoint[@"session_sha256"],
  };
}

static NSDictionary *DSHPreparedObservedSafeValues(NSDictionary *load,
                                                   NSDictionary *session,
                                                   NSDictionary *request) {
  NSDictionary *checkpoint = request[@"committed_checkpoint"];
  NSNumber *actualSessionGeneration =
      [load[@"snapshot"] isKindOfClass:NSDictionary.class]
          ? load[@"snapshot"][@"generation"] : checkpoint[@"session_generation"];
  NSString *actualSessionSHA256 =
      [load[@"snapshot"] isKindOfClass:NSDictionary.class]
          ? load[@"snapshot"][@"session_sha256"] : checkpoint[@"session_sha256"];
  NSNumber *actualControllerGeneration = @0;
  NSNumber *actualJournalRevision = @0;
  NSDictionary *conversation = DSHPreparedFindConversation(
      session, request[@"conversation_id"]);
  NSDictionary *attempt = conversation == nil ? nil :
      DSHPreparedFindAttempt(conversation, request[@"attempt_id"]);
  if ([attempt[@"journal_revision"] isKindOfClass:NSNumber.class]) {
    actualJournalRevision = attempt[@"journal_revision"];
  }
  NSDictionary *agent = [attempt[@"agent"] isKindOfClass:NSDictionary.class]
      ? attempt[@"agent"] : nil;
  if ([agent[@"controller_generation"] isKindOfClass:NSNumber.class]) {
    actualControllerGeneration = agent[@"controller_generation"];
  }
  return @{
    @"controller_generation" : actualControllerGeneration,
    @"journal_revision" : actualJournalRevision,
    @"session_generation" : actualSessionGeneration ?: @0,
    @"session_sha256" : actualSessionSHA256 ?: checkpoint[@"session_sha256"],
  };
}

static NSDictionary *DSHPreparedParseSessionJSON(NSDictionary *load,
                                                NSError **error) {
  if (![load isKindOfClass:NSDictionary.class] ||
      ![load[@"status"] isEqualToString:@"present"] ||
      ![load[@"session_json"] isKindOfClass:NSString.class]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSData *jsonBytes = [load[@"session_json"] dataUsingEncoding:NSUTF8StringEncoding];
  if (jsonBytes == nil || jsonBytes.length == 0) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSError *decodeError = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:jsonBytes
                                               options:0
                                                 error:&decodeError];
  if (![parsed isKindOfClass:NSDictionary.class] ||
      ![parsed[@"schema_version"] isEqual:@9]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSError *canonicalError = nil;
  NSData *canonical = DSHAgentCanonicalJSON(parsed, &canonicalError);
  if (canonical == nil || ![canonical isEqualToData:jsonBytes]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return parsed;
}

static NSDictionary *DSHPreparedSessionFromLoad(NSDictionary *load,
                                                NSDictionary *request,
                                                NSError **error) {
  if (![load[@"snapshot"] isKindOfClass:NSDictionary.class]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *snapshot = load[@"snapshot"];
  NSDictionary *checkpoint = request[@"committed_checkpoint"];
  if (![snapshot[@"schema_version"] isEqual:@1] ||
      ![snapshot[@"generation"] isEqual:checkpoint[@"session_generation"]] ||
      ![snapshot[@"session_sha256"] isEqual:checkpoint[@"session_sha256"]]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  return DSHPreparedParseSessionJSON(load, error);
}

static NSDictionary *DSHPreparedFindConversation(NSDictionary *session,
                                                 NSString *conversationId) {
  for (NSDictionary *conversation in session[@"conversations"]) {
    if ([conversation[@"id"] isEqual:conversationId]) return conversation;
  }
  return nil;
}

static NSDictionary *DSHPreparedFindAttempt(NSDictionary *conversation,
                                            NSString *attemptId) {
  for (NSDictionary *attempt in conversation[@"attempts"]) {
    if ([attempt[@"attempt_id"] isEqual:attemptId]) return attempt;
  }
  return nil;
}

static NSArray *DSHPreparedVisibleHistory(NSDictionary *conversation,
                                          NSArray *messageIds) {
  NSMutableDictionary *messagesById = [NSMutableDictionary dictionary];
  for (NSDictionary *message in conversation[@"messages"]) {
    if ([message[@"id"] isKindOfClass:NSString.class]) {
      messagesById[message[@"id"]] = message;
    }
  }
  NSMutableArray *visible = [NSMutableArray array];
  for (NSString *messageId in messageIds) {
    NSDictionary *message = messagesById[messageId];
    if (![message isKindOfClass:NSDictionary.class]) return nil;
    NSMutableArray *attachments = [NSMutableArray array];
    for (NSDictionary *attachment in message[@"attachments"] ?: @[]) {
      if (![attachment isKindOfClass:NSDictionary.class]) return nil;
      [attachments addObject:@{
        @"schema_version" : attachment[@"schema_version"],
        @"id" : attachment[@"id"],
        @"kind" : attachment[@"kind"],
        @"name" : attachment[@"name"],
        @"mime_type" : attachment[@"mime_type"],
        @"size" : attachment[@"size"],
      }];
    }
    [visible addObject:@{
      @"role" : message[@"role"],
      @"content" : message[@"text"],
      @"attachments" : [attachments copy],
    }];
  }
  return [visible copy];
}

static BOOL DSHPreparedSessionAttemptMatches(NSDictionary *session,
                                             NSDictionary *request,
                                             NSError **error) {
  NSDictionary *conversation = DSHPreparedFindConversation(
      session, request[@"conversation_id"]);
  NSDictionary *attempt = conversation == nil ? nil :
      DSHPreparedFindAttempt(conversation, request[@"attempt_id"]);
  if (conversation == nil || attempt == nil ||
      ![attempt[@"turn_id"] isEqual:request[@"task_id"]] ||
      ![attempt[@"model_id"] isEqual:request[@"model"]] ||
      ![attempt[@"thinking_mode"] isEqual:request[@"thinking_mode"]]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  id requestedWorkspace = request[@"workspace_id"];
  id requestedProject = request[@"project_id"];
  id requestedRevision = request[@"workspace_binding_revision"];
  id storedWorkspace = attempt[@"workspace_id"] ?: NSNull.null;
  id storedProject = attempt[@"context_project_id"] ?: NSNull.null;
  id storedRevision = attempt[@"workspace_binding_revision"] ?: NSNull.null;
  if (![storedWorkspace isEqual:requestedWorkspace] ||
      ![storedProject isEqual:requestedProject] ||
      ![storedRevision isEqual:requestedRevision] ||
      ![conversation[@"id"] isEqual:request[@"conversation_id"]] ||
      ![(conversation[@"workspace_id"] ?: NSNull.null)
          isEqual:requestedWorkspace] ||
      ![(conversation[@"project_id"] ?: NSNull.null)
          isEqual:requestedProject]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSArray *storedVisibleMessageIds = [attempt[@"visible_message_ids"]
      isKindOfClass:NSArray.class] ? attempt[@"visible_message_ids"] : nil;
  if (![storedVisibleMessageIds isEqual:request[@"visible_message_ids"]] ||
      storedVisibleMessageIds.count !=
          [request[@"visible_message_count"] unsignedIntegerValue]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSArray *visible = DSHPreparedVisibleHistory(
      conversation, storedVisibleMessageIds);
  NSError *digestError = nil;
  NSString *visibleDigest = visible == nil ? nil :
      DSHAgentHJ(@"visible-history", @{ @"messages" : visible }, &digestError);
  if (visibleDigest == nil || ![visibleDigest isEqual:request[@"visible_history_sha256"]] ||
      (attempt[@"visible_history_sha256"] != NSNull.null &&
       ![attempt[@"visible_history_sha256"] isEqual:visibleDigest])) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSString *disposition = attempt[@"context_disposition"];
  BOOL schema3 = [request[@"transport_schema_version"] isEqual:@3];
  BOOL hasProject = requestedProject != NSNull.null;
  if (schema3) {
    NSDictionary *context = attempt[@"project_context"];
    NSString *contextDigest = [context isKindOfClass:NSDictionary.class]
        ? context[@"snapshot_sha256"] : nil;
    if (![disposition isEqualToString:@"verified"] ||
        !DSHAgentCanonicalSHA256(contextDigest) ||
        ![contextDigest isEqual:request[@"project_context_sha256"]] || !hasProject) {
      DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
  } else if (![request[@"project_context_sha256"] isEqual:NSNull.null] ||
             (hasProject && ![disposition isEqualToString:@"explicit_without_context"]) ||
             (!hasProject && ![disposition isEqualToString:@"unbound"])) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

static BOOL DSHPreparedAuthorityMatchesRequest(NSDictionary *authority,
                                               NSDictionary *request,
                                               NSDictionary *root,
                                               NSDictionary *policy,
                                               NSDictionary *registry) {
  if (![authority[@"task_id"] isEqual:request[@"task_id"]] ||
      ![authority[@"conversation_id"] isEqual:request[@"conversation_id"]] ||
      ![authority[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
      ![authority[@"root"] isEqual:root] ||
      ![authority[@"policy"] isEqual:policy] ||
      ![authority[@"registry"] isEqual:registry] ||
      ![authority[@"transport_schema_version"]
          isEqual:request[@"transport_schema_version"]] ||
      ![authority[@"model"] isEqual:request[@"model"]] ||
      ![authority[@"thinking_mode"] isEqual:request[@"thinking_mode"]] ||
      ![authority[@"visible_message_ids"] isEqual:request[@"visible_message_ids"]] ||
      ![authority[@"visible_history_sha256"]
          isEqual:request[@"visible_history_sha256"]] ||
      ![authority[@"visible_message_count"]
          isEqual:request[@"visible_message_count"]] ||
      ![authority[@"project_context_sha256"]
          isEqual:request[@"project_context_sha256"]]) {
    return NO;
  }
  id expectedTranscript = request[@"expected_transcript"];
  return expectedTranscript != NSNull.null &&
      [authority[@"transcript"] isEqual:expectedTranscript];
}

@interface DSHAgentPreparedAttemptStore ()
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@property(nonatomic, strong, readwrite) DSHAgentRootResolver *rootResolver;
@property(nonatomic, strong, readwrite) DSHAgentToolRegistry *toolRegistry;
@property(nonatomic, strong, readwrite) DSHSessionSnapshotStore *sessionSnapshotStore;
@property(nonatomic, strong, readwrite) DSHAgentTranscriptStore *transcriptStore;
@end

@implementation DSHAgentPreparedAttemptStore

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
              rootResolver:(DSHAgentRootResolver *)rootResolver
        sessionSnapshotStore:(DSHSessionSnapshotStore *)sessionSnapshotStore
             transcriptStore:(DSHAgentTranscriptStore *)transcriptStore {
  self = [super init];
  if (self != nil) {
    _wal = wal;
    _rootResolver = rootResolver;
    _toolRegistry = [[DSHAgentToolRegistry alloc] init];
    _sessionSnapshotStore = sessionSnapshotStore;
    _transcriptStore = transcriptStore ?: [[DSHAgentTranscriptStore alloc]
        initWithWAL:wal];
  }
  return self;
}

- (nullable NSDictionary *)prepareAgentAttemptWithRequest:(NSDictionary *)request
                                                    error:(NSError **)error {
  if (!DSHPreparedRequestShape(request)) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *checkpoint = request[@"committed_checkpoint"];
  if (!DSHPreparedControllerCheckpointRelation(request)) {
    // The controller CAS is a complete assertion over the Store checkpoint;
    // treating a disagreement as a normal malformed request would make it
    // impossible for a caller to recover with the closed conflict union.
    NSError *casLoadError = nil;
    NSDictionary *casLoad = [self.sessionSnapshotStore
        loadSessionSnapshotWithError:&casLoadError];
    NSDictionary *casSession = DSHPreparedParseSessionJSON(casLoad, nullptr);
    NSDictionary *casObserved = DSHPreparedObservedSafeValues(
        casLoad, casSession, request);
    if (error != nullptr) *error = nil;
    return DSHPreparedConflictResult(
        request[@"operation_id"], @"E_AGENT_CONFLICT", request,
        casObserved[@"controller_generation"], casObserved[@"journal_revision"],
        casObserved[@"session_generation"], casObserved[@"session_sha256"]);
  }
  NSError *sessionError = nil;
  NSDictionary *load = [self.sessionSnapshotStore loadSessionSnapshotWithError:
      &sessionError];
  if (![load[@"status"] isEqualToString:@"present"] ||
      ![load[@"snapshot"] isKindOfClass:NSDictionary.class]) {
    // Missing, legacy, or protected storage is not an observed checkpoint
    // mismatch; it remains a stable transcript/native failure.
    if (error != nullptr) *error = sessionError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSDictionary *loadedSnapshot = load[@"snapshot"];
  if (![loadedSnapshot[@"generation"] isEqual:checkpoint[@"session_generation"]] ||
      ![loadedSnapshot[@"session_sha256"] isEqual:checkpoint[@"session_sha256"]]) {
    NSDictionary *observedSession = DSHPreparedParseSessionJSON(load, nullptr);
    NSDictionary *observed = DSHPreparedObservedSafeValues(
        load, observedSession, request);
    if (error != nullptr) *error = nil;
    return DSHPreparedConflictResult(
        request[@"operation_id"], @"E_AGENT_CONFLICT", request,
        observed[@"controller_generation"], observed[@"journal_revision"],
        observed[@"session_generation"], observed[@"session_sha256"]);
  }
  NSDictionary *session = DSHPreparedSessionFromLoad(load, request, &sessionError);
  if (session == nil) {
    if (error != nullptr) *error = sessionError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSError *attemptError = nil;
  if (!DSHPreparedSessionAttemptMatches(session, request, &attemptError)) {
    NSDictionary *observed = DSHPreparedObservedSafeValues(load, session, request);
    if (error != nullptr) *error = nil;
    return DSHPreparedConflictResult(
        request[@"operation_id"], @"E_AGENT_CONFLICT", request,
        observed[@"controller_generation"], observed[@"journal_revision"],
        observed[@"session_generation"], observed[@"session_sha256"]);
  }
  NSString *workspaceId = request[@"workspace_id"] == NSNull.null
      ? nil : request[@"workspace_id"];
  NSString *projectId = request[@"project_id"] == NSNull.null
      ? nil : request[@"project_id"];
  NSNumber *revision = request[@"workspace_binding_revision"] == NSNull.null
      ? nil : request[@"workspace_binding_revision"];
  NSDictionary *observed = DSHPreparedObservedSafeValues(load, session, request);

  NSError *rootError = nil;
  NSDictionary *root = [self.rootResolver resolveRootForWorkspaceId:workspaceId
                                                            projectId:projectId
                                                      bindingRevision:revision
                                                                error:&rootError];
  NSNumber *controllerGeneration = request[@"controller_cas"][@"expected_controller_generation"];
  NSNumber *journalRevision = checkpoint[@"journal_revision"];
  if (root == nil && (workspaceId != nil || projectId != nil || revision != nil)) {
    if (error != nullptr) *error = nil;
    return DSHPreparedConflictResult(
        request[@"operation_id"], @"E_AGENT_ROOT_STALE", request,
        observed[@"controller_generation"], observed[@"journal_revision"],
        observed[@"session_generation"], observed[@"session_sha256"]);
  }

  NSError *registryError = nil;
  NSDictionary *registry = root == nil
      ? DSHPreparedEmptyRegistry(self.toolRegistry)
      : [self.toolRegistry registryForRoot:root error:&registryError];
  NSDictionary *policy = root == nil
      ? nil : [self.toolRegistry policyForRoot:root error:&registryError];
  if ((root != nil && (registry == nil || policy == nil)) ||
      !DSHAgentCanonicalSHA256(registry[@"toolset_sha256"])) {
    if (error != nullptr) *error = nil;
    return DSHPreparedConflictResult(
        request[@"operation_id"], @"E_AGENT_CONFLICT", request,
        observed[@"controller_generation"], observed[@"journal_revision"],
        observed[@"session_generation"], observed[@"session_sha256"]);
  }
  NSString *operationId = request[@"operation_id"];
  NSError *requestError = nil;
  NSString *requestSHA = DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : @"prepare_agent_attempt",
    @"request" : request,
  }, &requestError);
  if (requestSHA == nil) {
    if (error != nullptr) *error = requestError;
    return nil;
  }

  // Hold the existing workspace authority lock for the final proof and for
  // the entire WAL transaction.  The WAL lock alone cannot exclude a
  // concurrent workspace rebind; this guard is deliberately kept alive with
  // precise ARC lifetime until after performAtomicTransaction returns.
  __attribute__((objc_precise_lifetime))
  DSHLocalWorkspaceAuthorityMutationGuard *authorityGuard = nil;
  if (root != nil) {
    NSError *authorityGuardError = nil;
    authorityGuard = [self.rootResolver
        acquireAuthorityMutationGuardForFrozenRoot:root
                                             error:&authorityGuardError];
    if (authorityGuard == nil ||
        ![self.rootResolver validateFrozenRoot:root
                         authorityMutationGuard:authorityGuard
                                          error:&authorityGuardError]) {
      if (error != nullptr) *error = nil;
      return DSHPreparedConflictResult(
          request[@"operation_id"], @"E_AGENT_ROOT_STALE", request,
          observed[@"controller_generation"], observed[@"journal_revision"],
          observed[@"session_generation"], observed[@"session_sha256"]);
    }
  }

  __block NSDictionary *safeEnvelope = nil;
  __block BOOL replay = NO;
  __block NSString *transactionConflictCode = nil;
  NSError *transactionError = nil;
  BOOL transaction = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *operations = [state[@"operations"] mutableCopy];
    NSMutableArray *operationResults = [state[@"operation_results"] mutableCopy];
    NSMutableArray *authorities = [state[@"authorities"] mutableCopy];
    NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
    if (operations == nil || operationResults == nil || authorities == nil ||
        transcripts == nil) {
      DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSDictionary *existingOperation = nil;
    for (NSDictionary *operation in operations) {
      if ([operation[@"operation_id"] isEqual:operationId]) {
        existingOperation = operation;
        break;
      }
    }
    if (existingOperation != nil) {
      if (![existingOperation[@"operation_kind"]
              isEqualToString:@"prepare_agent_attempt"] ||
          ![existingOperation[@"request_sha256"] isEqual:requestSHA] ||
          ![existingOperation[@"task_id"] isEqual:request[@"task_id"]] ||
          ![existingOperation[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        transactionConflictCode = @"E_AGENT_CONFLICT";
        DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      for (NSDictionary *snapshot in operationResults) {
        if ([snapshot[@"operation_id"] isEqual:operationId]) {
          safeEnvelope = snapshot[@"result"];
          replay = YES;
          return NO;
        }
      }
      DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorPersistence);
      return NO;
    }

    NSDictionary *existingAuthority = nil;
    for (NSDictionary *candidate in authorities) {
      if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        existingAuthority = candidate;
        break;
      }
    }
    NSDictionary *authority = existingAuthority;
    NSString *status = nil;
    NSDictionary *resultAttempt = nil;
    if (root == nil) {
      if (existingAuthority != nil) {
        transactionConflictCode = @"E_AGENT_CONFLICT";
        DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      status = @"not_agent";
      resultAttempt = DSHPreparedNotAgentProjection(
          request[@"task_id"], request[@"conversation_id"], request[@"attempt_id"],
          controllerGeneration, journalRevision, self.toolRegistry);
    } else if (existingAuthority != nil) {
      if (!DSHPreparedAuthorityMatchesRequest(existingAuthority, request, root,
                                              policy, registry)) {
        transactionConflictCode = @"E_AGENT_CONFLICT";
        DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      status = @"already_prepared";
      resultAttempt = DSHPreparedProjectionForAuthority(
          existingAuthority, controllerGeneration, journalRevision);
    } else {
      if (authorities.count >= DSHAgentPreparedMaximumAuthorities) {
        DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      NSDictionary *existingTranscript = nil;
      for (NSDictionary *candidate in transcripts) {
        if ([candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
          existingTranscript = candidate;
          break;
        }
      }
      NSDictionary *transcript = existingTranscript;
      if (transcript != nil) {
        if (![transcript[@"root_fingerprint_sha256"]
                isEqual:root[@"root_fingerprint_sha256"]] ||
            (request[@"expected_transcript"] == NSNull.null) ||
            (request[@"expected_transcript"] != NSNull.null &&
             ![DSHPreparedTranscriptReference(transcript)
                 isEqual:request[@"expected_transcript"]])) {
          DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorConflict);
          return NO;
        }
      } else {
        transcript = DSHPreparedTranscriptRow(
            request[@"attempt_id"], root[@"root_fingerprint_sha256"], self.wal,
            transcripts, mutationError);
        if (transcript == nil) return NO;
        [transcripts addObject:transcript];
      }
      if (existingTranscript == nil && request[@"expected_transcript"] != NSNull.null) {
        DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSDictionary *transcriptReference = DSHPreparedTranscriptReference(transcript);
      authority = @{
        @"schema_version" : @2,
        @"task_id" : request[@"task_id"],
        @"conversation_id" : request[@"conversation_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"root" : root,
        @"policy" : policy,
        @"registry" : registry,
        @"transport_schema_version" : request[@"transport_schema_version"],
        @"model" : request[@"model"],
        @"thinking_mode" : request[@"thinking_mode"],
        @"visible_message_ids" : request[@"visible_message_ids"],
        @"visible_history_sha256" : request[@"visible_history_sha256"],
        @"visible_message_count" : request[@"visible_message_count"],
        @"project_context_sha256" : request[@"project_context_sha256"],
        @"transcript" : transcriptReference,
        @"reserved_write_bytes" : @0,
        @"authority_revision" : @1,
        @"state" : @"prepared",
        @"cleanup_id" : NSNull.null,
        @"created_at" : [self.wal currentTimestamp],
        @"updated_at" : [self.wal currentTimestamp],
      };
      [authorities addObject:authority];
      status = @"prepared";
      resultAttempt = DSHPreparedProjectionForAuthority(
          authority, controllerGeneration, journalRevision);
    }
    NSDictionary *publicResult = DSHPreparedPublicResult(
        status, operationId, resultAttempt, checkpoint,
        [status isEqualToString:@"not_agent"] ? @"E_AGENT_NO_ROOT" : nil);
    NSDictionary *safeResult = DSHPreparedSafeResult(operationId, status, publicResult);
    NSDictionary *snapshot = DSHPreparedOperationSnapshot(
        operationId, status, safeResult, [self.wal currentTimestamp], mutationError);
    if (snapshot == nil) return NO;
    NSUInteger attemptOperationCount = 0;
    for (NSDictionary *candidate in operations) {
      if ([candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        attemptOperationCount += 1;
      }
    }
    if (attemptOperationCount >= DSHAgentPreparedMaximumOperationsPerAttempt ||
        operations.count >= DSHAgentPreparedMaximumOperations ||
        operationResults.count >= DSHAgentPreparedMaximumOperations) {
      DSHSetPreparedError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    BOOL hasAuthority = authority != nil;
    NSDictionary *resultRef = hasAuthority
        ? @{
            @"schema_version" : @2,
            @"kind" : @"authority",
            @"task_id" : request[@"task_id"],
            @"attempt_id" : request[@"attempt_id"],
            @"authority_revision" : authority[@"authority_revision"],
          }
        : @{ @"schema_version" : @2, @"kind" : @"none" };
    NSString *operationState = hasAuthority ? @"committed" : @"rejected";
    NSNumber *resultRevision = hasAuthority ? authority[@"authority_revision"] : NSNull.null;
    NSDictionary *operation = @{
      @"schema_version" : @2,
      @"operation_id" : operationId,
      @"operation_kind" : @"prepare_agent_attempt",
      @"request_sha256" : requestSHA,
      @"task_id" : request[@"task_id"],
      @"attempt_id" : request[@"attempt_id"],
      @"result_ref" : resultRef,
      @"state" : operationState,
      @"result_status" : status,
      @"result_revision" : resultRevision,
      @"result_snapshot_ref" : @{
        @"schema_version" : @2,
        @"operation_id" : operationId,
        @"result_sha256" : snapshot[@"result_sha256"],
        @"result_bytes" : snapshot[@"result_bytes"],
      },
      @"authority_revision" : hasAuthority ? authority[@"authority_revision"] : @0,
      @"created_at" : snapshot[@"created_at"],
      @"updated_at" : snapshot[@"created_at"],
    };
    [operations addObject:operation];
    [operationResults addObject:snapshot];
    state[@"operations"] = operations;
    state[@"operation_results"] = operationResults;
    state[@"authorities"] = authorities;
    state[@"transcripts"] = transcripts;
    safeEnvelope = safeResult;
    return YES;
  } error:&transactionError];
  // Keep the precise-lifetime guard live through result publication as well;
  // this statement also documents that the WAL transaction ran under it.
  (void)authorityGuard;
  if (!transaction || safeEnvelope == nil) {
    if (transactionConflictCode != nil ||
        transactionError.code == DSHAgentNativeStoreErrorConflict) {
      if (error != nullptr) *error = nil;
      return DSHPreparedConflictResult(
          request[@"operation_id"], transactionConflictCode ?: @"E_AGENT_CONFLICT",
          request, observed[@"controller_generation"], observed[@"journal_revision"],
          observed[@"session_generation"], observed[@"session_sha256"]);
    }
    if (error != nullptr) *error = transactionError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorPersistence);
    return nil;
  }
  NSDictionary *publicResult = safeEnvelope[@"result"];
  if (replay && [publicResult[@"status"] isEqualToString:@"prepared"]) {
    NSMutableDictionary *replayed = [publicResult mutableCopy];
    replayed[@"status"] = @"already_prepared";
    publicResult = [replayed copy];
  }
  return publicResult;
}

- (nullable NSDictionary *)nativeAuthorityForTaskId:(NSString *)taskId
                                          attemptId:(NSString *)attemptId
                                              error:(NSError **)error {
  if (!DSHAgentCanonicalUUID(taskId) || !DSHAgentCanonicalUUID(attemptId)) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  for (NSDictionary *authority in state[@"authorities"]) {
    if ([authority[@"task_id"] isEqual:taskId] &&
        [authority[@"attempt_id"] isEqual:attemptId]) return authority;
  }
  DSHSetPreparedError(error, DSHAgentNativeStoreErrorNotFound);
  return nil;
}

- (nullable NSDictionary *)preparedAttemptForTaskId:(NSString *)taskId
                                          attemptId:(NSString *)attemptId
                                              error:(NSError **)error {
  NSDictionary *authority = [self nativeAuthorityForTaskId:taskId
                                                   attemptId:attemptId
                                                       error:error];
  if (authority == nil) return nil;
  return DSHPreparedProjectionForAuthority(authority, @0, @0);
}

- (BOOL)validatePreparedRoot:(NSDictionary *)root
                      taskId:(NSString *)taskId
                   attemptId:(NSString *)attemptId
                        error:(NSError **)error {
  if (!DSHAgentCanonicalUUID(taskId) || !DSHAgentCanonicalUUID(attemptId)) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSDictionary *authority = [self nativeAuthorityForTaskId:taskId
                                                   attemptId:attemptId
                                                       error:error];
  if (authority == nil) return NO;
  if (![authority[@"root"] isEqual:root] ||
      ![self.rootResolver validateFrozenRoot:root error:error]) {
    DSHSetPreparedError(error, DSHAgentNativeStoreErrorOwnerLost);
    return NO;
  }
  return YES;
}

@end
