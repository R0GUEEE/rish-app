#import "AgentProviderRoundServiceInternals.h"
#import "RishHarnessCatalog.h"

#import "AgentToolRegistry.h"
#import "DSHCompletionV2.h"
#import "DSHWorkspaceCanonical.h"

#include <CoreFoundation/CoreFoundation.h>
#include <math.h>

static const NSUInteger DSHAgentProviderMaximumSafeInteger = 9007199254740991ULL;

void DSHSetProviderError(NSError **error,
                                DSHAgentNativeStoreErrorCode code) {
  if (error != nullptr) *error = DSHAgentNativeStoreError(code);
}

BOOL DSHProviderUUID(id value) { return DSHAgentCanonicalUUID(value); }
BOOL DSHProviderDigest(id value) { return DSHAgentCanonicalSHA256(value); }
BOOL DSHProviderNullableDigest(id value) {
  return value == NSNull.null || DSHProviderDigest(value);
}
BOOL DSHProviderSchema(id value, NSUInteger schema) {
  return DSHAgentSafeInteger(value, schema, NO) && [value isEqual:@(schema)];
}

NSString *DSHProviderJSONSHA256(id value, NSError **error) {
  if (value == nil || ![NSJSONSerialization isValidJSONObject:value]) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:value
                                                    options:NSJSONWritingSortedKeys
                                                      error:error];
  return bytes == nil ? nil : DSHWorkspaceSHA256Hex(bytes);
}

BOOL DSHProviderReference(NSDictionary *reference) {
  return DSHAgentExactDictionaryKeys(reference, @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ]) && DSHProviderSchema(reference[@"schema_version"], 1) &&
      DSHProviderUUID(reference[@"transcript_ref"]) &&
      DSHAgentSafeInteger(reference[@"generation"],
                          DSHAgentProviderMaximumSafeInteger, YES) &&
      DSHProviderDigest(reference[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(reference[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

BOOL DSHProviderOpaqueId(id value) {
  if (!DSHAgentBoundedUTF8String(value, 128, NO, nullptr)) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

BOOL DSHProviderResultShape(NSDictionary *result) {
  if (!DSHAgentExactDictionaryKeysWithOptional(result, @[
        @"provider_request_id", @"provider_response_id", @"requested_model",
        @"model", @"thinking_mode", @"text", @"reasoning", @"tool_calls",
        @"finish_reason", @"latency_ms", @"visible_history_sha256",
        @"model_input_sha256", @"request_body_sha256",
      ], @[@"harness_id"]) || !DSHProviderOpaqueId(result[@"provider_request_id"]) ||
      !DSHProviderOpaqueId(result[@"provider_response_id"]) ||
      !DSHAgentBoundedUTF8String(result[@"requested_model"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(result[@"model"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(result[@"thinking_mode"], 32, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(result[@"text"], DSHAgentNativeWALMaxTranscriptBytes,
                                 YES, nullptr) ||
      !DSHAgentBoundedUTF8String(result[@"reasoning"],
                                 DSHAgentNativeWALMaxTranscriptBytes, YES, nullptr) ||
      ![result[@"tool_calls"] isKindOfClass:NSArray.class] ||
      [result[@"tool_calls"] count] > 16 ||
      !DSHAgentBoundedUTF8String(result[@"finish_reason"], 32, NO, nullptr) ||
      !DSHAgentSafeInteger(result[@"latency_ms"], 24 * 60 * 60 * 1000, YES) ||
      !DSHProviderDigest(result[@"visible_history_sha256"]) ||
      !DSHProviderDigest(result[@"model_input_sha256"]) ||
      !DSHProviderDigest(result[@"request_body_sha256"])) return NO;
  if (![result[@"finish_reason"] isEqualToString:@"stop"] &&
      ![result[@"finish_reason"] isEqualToString:@"tool_calls"] &&
      ![result[@"finish_reason"] isEqualToString:@"length"] &&
      ![result[@"finish_reason"] isEqualToString:@"content_filter"]) return NO;
  NSSet *models = DSHHarnessSupportedModels();
  if (result[@"harness_id"] != nil &&
      ![DSHHarnessIdForModel(result[@"model"]) isEqual:result[@"harness_id"]]) {
    return NO;
  }
  return [models containsObject:result[@"requested_model"]] &&
      [models containsObject:result[@"model"]] &&
      [result[@"requested_model"] isEqual:result[@"model"]] &&
      ([result[@"finish_reason"] isEqualToString:@"tool_calls"]
      ? [result[@"tool_calls"] count] > 0
      : [result[@"tool_calls"] count] == 0);
}

BOOL DSHProviderResultMatchesRequest(NSDictionary *result,
                                     NSDictionary *request,
                                     NSString *providerRequestId) {
  return DSHProviderResultShape(result) &&
      [result[@"provider_request_id"] isEqual:providerRequestId] &&
      [result[@"requested_model"] isEqual:request[@"model"]] &&
      [result[@"model"] isEqual:request[@"model"]] &&
      [result[@"thinking_mode"] isEqual:request[@"thinking_mode"]];
}

BOOL DSHProviderControllerCAS(NSDictionary *cas,
                                     NSString *conversationId,
                                     NSString *taskId,
                                     NSString *attemptId) {
  return DSHAgentExactDictionaryKeys(cas, @[
    @"schema_version", @"conversation_id", @"task_id", @"attempt_id",
    @"expected_controller_generation", @"expected_journal_revision",
    @"expected_session_generation", @"expected_session_sha256",
  ]) && DSHProviderSchema(cas[@"schema_version"], 1) &&
      DSHProviderUUID(cas[@"conversation_id"]) &&
      DSHProviderUUID(cas[@"task_id"]) && DSHProviderUUID(cas[@"attempt_id"]) &&
      [cas[@"conversation_id"] isEqual:conversationId] &&
      [cas[@"task_id"] isEqual:taskId] && [cas[@"attempt_id"] isEqual:attemptId] &&
      DSHAgentSafeInteger(cas[@"expected_controller_generation"],
                          DSHAgentProviderMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_journal_revision"],
                          DSHAgentProviderMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(cas[@"expected_session_generation"],
                          DSHAgentProviderMaximumSafeInteger, YES) &&
      DSHProviderDigest(cas[@"expected_session_sha256"]);
}

BOOL DSHProviderCheckpoint(NSDictionary *checkpoint) {
  return DSHAgentExactDictionaryKeys(checkpoint, @[
    @"schema_version", @"journal_revision", @"session_generation",
    @"session_sha256",
  ]) && DSHProviderSchema(checkpoint[@"schema_version"], 1) &&
      DSHAgentSafeInteger(checkpoint[@"journal_revision"],
                          DSHAgentProviderMaximumSafeInteger, YES) &&
      DSHAgentSafeInteger(checkpoint[@"session_generation"],
                          DSHAgentProviderMaximumSafeInteger, YES) &&
      DSHProviderDigest(checkpoint[@"session_sha256"]);
}

NSDictionary *DSHProviderConflictResult(NSString *operationId,
                                               NSString *failureCode,
                                               NSDictionary *request,
                                               NSNumber *actualRoundRevision,
                                               NSString *actualRoundStatus,
                                               NSDictionary *actualTranscript) {
  return @{
    @"schema_version" : @2,
    @"status" : @"conflict",
    @"operation_id" : operationId,
    @"failure_code" : failureCode,
    @"expected_round_revision" : request[@"expected_round_revision"],
    @"actual_round_revision" : actualRoundRevision ?: @0,
    @"actual_round_status" : actualRoundStatus ?: @"in_flight",
    @"actual_transcript" : actualTranscript ?: request[@"transcript"],
  };
}

NSDictionary *DSHProviderRoundRequestCopy(NSDictionary *request,
                                                 NSError **error) {
  NSArray *keys = @[
    @"schema_version", @"operation_id", @"controller_cas",
    @"committed_checkpoint", @"task_id", @"conversation_id", @"attempt_id",
    @"round_id", @"round_index", @"launch_attempt", @"expected_round_revision",
    @"transport_schema_version", @"model", @"thinking_mode",
    @"visible_history_sha256", @"visible_message_count",
    @"project_context_sha256", @"transcript", @"root", @"registry_version",
    @"toolset_sha256",
  ];
  NSError *copyError = nil;
  NSDictionary *copy = DSHAgentImmutableJSONCopy(request, &copyError);
  // harness_id names the built-in Harness that owns the round; it must
  // catalog the requested model. Pre-split callers omit it (DSH).
  if (!DSHAgentExactDictionaryKeysWithOptional(copy, keys, @[ @"harness_id" ]) ||
      (copy[@"harness_id"] != nil &&
       ![DSHHarnessIdForModel(copy[@"model"]) isEqual:copy[@"harness_id"]]) ||
      !DSHProviderSchema(copy[@"schema_version"], 2) ||
      !DSHProviderUUID(copy[@"operation_id"]) ||
      !DSHProviderUUID(copy[@"task_id"]) || !DSHProviderUUID(copy[@"conversation_id"]) ||
      !DSHProviderUUID(copy[@"attempt_id"]) || !DSHProviderUUID(copy[@"round_id"]) ||
      !DSHProviderControllerCAS(copy[@"controller_cas"], copy[@"conversation_id"],
                                copy[@"task_id"], copy[@"attempt_id"]) ||
      !DSHProviderCheckpoint(copy[@"committed_checkpoint"]) ||
      ![copy[@"controller_cas"][@"expected_journal_revision"]
          isEqual:copy[@"committed_checkpoint"][@"journal_revision"]] ||
      ![copy[@"controller_cas"][@"expected_session_generation"]
          isEqual:copy[@"committed_checkpoint"][@"session_generation"]] ||
      ![copy[@"controller_cas"][@"expected_session_sha256"]
          isEqual:copy[@"committed_checkpoint"][@"session_sha256"]] ||
      !DSHProviderUUID(copy[@"round_id"]) ||
      !DSHAgentSafeInteger(copy[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(copy[@"launch_attempt"], 8, NO) ||
      !DSHAgentSafeInteger(copy[@"expected_round_revision"],
                          DSHAgentProviderMaximumSafeInteger, YES) ||
      (![copy[@"transport_schema_version"] isEqual:@2] &&
       ![copy[@"transport_schema_version"] isEqual:@3]) ||
      !DSHAgentBoundedUTF8String(copy[@"model"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(copy[@"thinking_mode"], 32, NO, nullptr) ||
      !DSHProviderDigest(copy[@"visible_history_sha256"]) ||
      !DSHAgentSafeInteger(copy[@"visible_message_count"], 96, YES) ||
      !DSHProviderNullableDigest(copy[@"project_context_sha256"]) ||
      ([copy[@"transport_schema_version"] isEqual:@3] &&
       copy[@"project_context_sha256"] == NSNull.null) ||
      ([copy[@"transport_schema_version"] isEqual:@2] &&
       copy[@"project_context_sha256"] != NSNull.null) ||
      !DSHProviderReference(copy[@"transcript"]) ||
      ![copy[@"root"] isKindOfClass:NSDictionary.class] ||
      ![DSHAgentRootResolver validateAgentRootProjection:copy[@"root"]
                                                   error:&copyError] ||
      ![copy[@"registry_version"] isEqual:@1] ||
      !DSHProviderDigest(copy[@"toolset_sha256"])) {
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return copy;
}

NSDictionary *DSHProviderRoundLocator(NSDictionary *request) {
  return @{
    @"schema_version" : @1,
    @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
  };
}

NSDictionary *DSHProviderOwner(DSHAgentNativeWAL *wal,
                                      NSString *taskId,
                                      NSString *nativeTaskId) {
  return @{
    @"schema_version" : @1,
    @"task_id" : taskId,
    @"launch_id" : wal.launchId,
    @"native_task_id" : nativeTaskId,
    @"owner_generation" : @1,
    @"heartbeat_at" : wal.currentTimestamp,
  };
}

NSDictionary *DSHProviderRoundCASForRow(NSDictionary *row) {
  NSDictionary *locator = row[@"locator"];
  NSDictionary *owner = row[@"owner"];
  return @{
    @"schema_version" : @2,
    @"locator" : locator,
    @"expected_row_revision" : row[@"row_revision"],
    @"expected_state" : row[@"state"],
    @"expected_owner_generation" : (id)owner == NSNull.null
        ? NSNull.null : owner[@"owner_generation"],
    @"expected_launch_id" : (id)owner == NSNull.null
        ? NSNull.null : owner[@"launch_id"],
    @"expected_native_task_id" : (id)owner == NSNull.null
        ? NSNull.null : owner[@"native_task_id"],
    @"expected_transcript_generation" : row[@"transcript_before"][@"generation"],
    @"expected_transcript_sha256" : row[@"transcript_before"][@"transcript_sha256"],
    @"expected_root_fingerprint_sha256" : row[@"root_fingerprint_sha256"],
    @"expected_binding_revision" : row[@"binding_revision"],
  };
}

NSDictionary *DSHProviderNativeToCompletionMessage(NSDictionary *message,
                                                          NSError **error) {
  if (![message isKindOfClass:NSDictionary.class] ||
      ![message[@"role"] isEqualToString:@"assistant"] ||
      ![message[@"content"] isKindOfClass:NSString.class] ||
      ![message[@"reasoning_content"] isKindOfClass:NSString.class] ||
      ![message[@"tool_calls"] isKindOfClass:NSArray.class]) return nil;
  NSMutableArray *calls = [NSMutableArray array];
  for (NSDictionary *call in message[@"tool_calls"]) {
    if (!DSHAgentBoundedUTF8String(call[@"call_id"], 128, NO, nullptr) ||
        !DSHAgentBoundedUTF8String(call[@"name"], 64, NO, nullptr) ||
        !DSHAgentBoundedUTF8String(call[@"arguments"],
                                   DSHCompletionV2MaxArgumentsBytes, NO, nullptr) ||
        DSHAgentParseArgumentsJSON(call[@"arguments"], error) == nil) return nil;
    [calls addObject:@{
      @"schema_version" : @1,
      @"call_id" : call[@"call_id"],
      @"name" : call[@"name"],
      @"arguments_json" : call[@"arguments"],
    }];
  }
  return @{
    @"schema_version" : @1,
    @"role" : @"assistant",
    @"round_index" : message[@"round_index"],
    @"content" : message[@"content"],
    @"reasoning_content" : message[@"reasoning_content"],
    @"tool_calls" : [calls copy],
  };
}

NSDictionary *DSHProviderPublicReceipt(NSDictionary *provider,
                                              NSDictionary *request,
                                              NSString *providerRequestId,
                                              NSDictionary *contextReceipt) {
  return @{
    @"schema_version" : @2,
    @"transport_schema_version" : request[@"transport_schema_version"],
    @"turn_id" : request[@"task_id"],
    @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"provider_request_id" : providerRequestId,
    @"provider_response_id" : provider[@"provider_response_id"],
    @"harness_id" : [provider[@"harness_id"] isKindOfClass:NSString.class]
        ? provider[@"harness_id"]
        : ([request[@"harness_id"] isKindOfClass:NSString.class]
            ? request[@"harness_id"] : @"dsh"),
    @"requested_model" : request[@"model"],
    @"model" : request[@"model"],
    @"thinking_mode" : request[@"thinking_mode"],
    @"finish_reason" : provider[@"finish_reason"],
    @"latency_ms" : provider[@"latency_ms"],
    @"visible_history_sha256" : provider[@"visible_history_sha256"],
    @"model_input_sha256" : provider[@"model_input_sha256"],
    @"request_body_sha256" : provider[@"request_body_sha256"],
    @"project_context_receipt" : contextReceipt ?: NSNull.null,
  };
}

NSDictionary *DSHProviderRecoveredRoundProjection(NSDictionary *row,
                                                    NSDictionary *request,
                                                    NSArray *nativeMessages,
                                                    NSError **error) {
  if (![row isKindOfClass:NSDictionary.class] ||
      ![request isKindOfClass:NSDictionary.class] ||
      ![nativeMessages isKindOfClass:NSArray.class] ||
      ![row[@"state"] isEqualToString:@"completed"] ||
      ![row[@"locator"][@"task_id"] isEqual:request[@"task_id"]] ||
      ![row[@"locator"][@"attempt_id"] isEqual:request[@"attempt_id"]] ||
      ![row[@"locator"][@"round_id"] isEqual:request[@"round_id"]] ||
      ![row[@"locator"][@"round_index"] isEqual:request[@"round_index"]] ||
      ![row[@"transcript_after"] isKindOfClass:NSDictionary.class] ||
      ![row[@"completion_receipt"] isKindOfClass:NSDictionary.class]) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *assistant = nil;
  for (NSDictionary *message in nativeMessages) {
    if (![message isKindOfClass:NSDictionary.class] ||
        ![message[@"role"] isEqualToString:@"assistant"] ||
        ![message[@"round_index"] isEqual:request[@"round_index"]]) continue;
    assistant = message;
  }
  if (![assistant isKindOfClass:NSDictionary.class] ||
      !DSHAgentBoundedUTF8String(assistant[@"content"],
                                 DSHAgentNativeWALMaxTranscriptBytes, YES,
                                 nullptr) ||
      !DSHAgentBoundedUTF8String(assistant[@"reasoning_content"],
                                 DSHAgentNativeWALMaxTranscriptBytes, YES,
                                 nullptr) ||
      ![assistant[@"tool_calls"] isKindOfClass:NSArray.class]) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *nativeReceipt = row[@"completion_receipt"];
  // Selector/recovery requests intentionally carry only the round locator,
  // root, and transcript handle.  Bind optional receipt fields to the
  // persisted native receipt when those selectors omit them; a full
  // complete-agent-round request still supplies and is checked against the
  // same values below.
  NSMutableDictionary *receiptRequest = [request mutableCopy];
  if (receiptRequest[@"transport_schema_version"] == nil) {
    receiptRequest[@"transport_schema_version"] =
        nativeReceipt[@"transport_schema_version"];
  }
  if (receiptRequest[@"model"] == nil) {
    receiptRequest[@"model"] = nativeReceipt[@"model"];
  }
  if (receiptRequest[@"thinking_mode"] == nil) {
    receiptRequest[@"thinking_mode"] = nativeReceipt[@"thinking_mode"];
  }
  NSNumber *expectedTransportSchema = receiptRequest[@"transport_schema_version"];
  NSString *expectedModel = receiptRequest[@"model"];
  NSString *expectedThinkingMode = receiptRequest[@"thinking_mode"];
  NSString *providerRequestId = nativeReceipt[@"provider_request_id"];
  if (!DSHProviderOpaqueId(providerRequestId) ||
      ![nativeReceipt[@"transport_schema_version"]
          isEqual:expectedTransportSchema] ||
      ![nativeReceipt[@"requested_model"] isEqual:expectedModel] ||
      ![nativeReceipt[@"model"] isEqual:expectedModel] ||
      ![nativeReceipt[@"thinking_mode"] isEqual:expectedThinkingMode]) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *contextReceipt = nativeReceipt[@"project_context_receipt"];
  if ((id)contextReceipt == NSNull.null) contextReceipt = nil;
  if (([expectedTransportSchema isEqual:@3] &&
       contextReceipt == nil) ||
      ([expectedTransportSchema isEqual:@2] &&
       contextReceipt != nil)) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *publicReceipt = DSHProviderPublicReceipt(
      nativeReceipt, receiptRequest, providerRequestId, contextReceipt);
  NSString *finishReason = nativeReceipt[@"finish_reason"];
  if (![finishReason isEqualToString:@"stop"] &&
      ![finishReason isEqualToString:@"tool_calls"] &&
      ![finishReason isEqualToString:@"length"] &&
      ![finishReason isEqualToString:@"content_filter"]) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSData *textBytes = [assistant[@"content"]
      dataUsingEncoding:NSUTF8StringEncoding];
  NSData *reasoningBytes = [assistant[@"reasoning_content"]
      dataUsingEncoding:NSUTF8StringEncoding];
  NSString *assistantTextSHA = DSHWorkspaceSHA256Hex(textBytes);
  NSString *reasoningTextSHA = DSHWorkspaceSHA256Hex(reasoningBytes);
  if (assistantTextSHA == nil || reasoningTextSHA == nil) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSMutableDictionary *projection = [@{
    @"schema_version" : @2,
    @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"launch_attempt" : row[@"launch_attempt"],
    @"result_round_revision" : row[@"row_revision"],
    @"transcript" : row[@"transcript_after"],
    @"completion_receipt" : publicReceipt,
    @"text" : assistant[@"content"],
    @"reasoning" : assistant[@"reasoning_content"],
    @"assistant_text_sha256" : assistantTextSHA,
    @"reasoning_text_sha256" : reasoningTextSHA,
  } mutableCopy];
  if ([finishReason isEqualToString:@"stop"]) {
    if ([assistant[@"tool_calls"] count] != 0) {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    projection[@"kind"] = @"final";
    projection[@"finish_reason"] = @"stop";
    projection[@"text"] = assistant[@"content"];
    projection[@"reasoning"] = assistant[@"reasoning_content"];
  } else if ([finishReason isEqualToString:@"tool_calls"]) {
    if (![row[@"calls"] isKindOfClass:NSArray.class] ||
        [row[@"calls"] count] == 0 ||
        ![row[@"batch_class"] isKindOfClass:NSString.class] ||
        [assistant[@"tool_calls"] count] != [row[@"calls"] count]) {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    projection[@"kind"] = @"tool_batch";
    projection[@"finish_reason"] = @"tool_calls";
    projection[@"calls"] = row[@"calls"];
    projection[@"batch_class"] = row[@"batch_class"];
    projection[@"executable_call_count"] = row[@"executable_call_count"];
    projection[@"denied_call_count"] = row[@"denied_call_count"];
    projection[@"reasoning"] = assistant[@"reasoning_content"];
  } else {
    if ([assistant[@"tool_calls"] count] != 0) {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    projection[@"kind"] = @"blocked";
    projection[@"finish_reason"] = finishReason;
    projection[@"failure_code"] = [finishReason isEqualToString:@"length"]
        ? @"E_COMPLETION_LENGTH" : @"E_COMPLETION_CONTENT_FILTER";
  }
  return [projection copy];
}

BOOL DSHProviderContextReceipt(NSDictionary *receipt) {
  return DSHAgentExactDictionaryKeys(receipt, @[
    @"schema_version", @"snapshot_id", @"snapshot_sha256",
    @"source_fingerprint", @"context_bytes", @"verified_at",
  ]) && DSHProviderSchema(receipt[@"schema_version"], 1) &&
      DSHProviderUUID(receipt[@"snapshot_id"]) &&
      DSHProviderDigest(receipt[@"snapshot_sha256"]) &&
      DSHProviderDigest(receipt[@"source_fingerprint"]) &&
      DSHAgentSafeInteger(receipt[@"context_bytes"], 32 * 1024 * 1024, YES) &&
      DSHAgentCanonicalTimestamp(receipt[@"verified_at"]);
}

BOOL DSHProviderContextBundle(NSDictionary *bundle,
                                     NSString *expectedContextDigest,
                                     NSDictionary **receiptOut,
                                     NSArray **messagesOut,
                                     NSError **error) {
  if (bundle == nil && error != nullptr && *error != nil) return NO;
  if (!DSHAgentExactDictionaryKeys(bundle, @[
        @"project_context_sha256", @"receipt", @"messages",
      ]) ||
      !DSHProviderDigest(bundle[@"project_context_sha256"]) ||
      !DSHProviderContextReceipt(bundle[@"receipt"]) ||
      ![bundle[@"messages"] isKindOfClass:NSArray.class] ||
      [bundle[@"messages"] count] == 0 ||
      [bundle[@"messages"] count] > 32) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if (![bundle[@"project_context_sha256"] isEqual:expectedContextDigest]) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSMutableArray *messages = [NSMutableArray array];
  NSUInteger contextBytes = 0;
  for (NSDictionary *message in bundle[@"messages"]) {
    if (!DSHAgentExactDictionaryKeys(message, @[
          @"role", @"content", @"attachments",
        ]) || ![message[@"role"] isEqualToString:@"system"] ||
        !DSHAgentBoundedUTF8String(message[@"content"], 256 * 1024, NO, nullptr) ||
        ![message[@"attachments"] isKindOfClass:NSArray.class] ||
        [message[@"attachments"] count] != 0) {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSUInteger messageBytes = [message[@"content"]
        lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if (messageBytes > 256 * 1024 - contextBytes) {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    contextBytes += messageBytes;
    [messages addObject:[message copy]];
  }
  if (![bundle[@"receipt"][@"context_bytes"] isEqual:@(contextBytes)]) {
    DSHSetProviderError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  if (receiptOut != nullptr) *receiptOut = bundle[@"receipt"];
  if (messagesOut != nullptr) *messagesOut = [messages copy];
  return YES;
}

NSDictionary *DSHProviderUnknownResult(NSDictionary *request,
                                              NSString *status,
                                              NSUInteger revision,
                                              NSString *failureCode) {
  return @{
    @"schema_version" : @2,
    @"status" : status,
    @"operation_id" : request[@"operation_id"],
    @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"launch_attempt" : request[@"launch_attempt"],
    @"result_round_revision" : @(revision),
    @"transcript" : request[@"transcript"],
    @"failure_code" : failureCode,
  };
}

NSString *DSHProviderFailureCode(NSString *providerErrorCode,
                                 BOOL digestMismatch) {
  if (digestMismatch) return @"E_AGENT_TRANSCRIPT";
  if ([providerErrorCode isEqualToString:@"E_AGENT_CANCELLED"]) {
    return @"E_AGENT_CANCELLED";
  }
  if ([providerErrorCode isEqualToString:@"E_COMPLETION_REDIRECT"]) {
    return @"E_AGENT_CONFLICT";
  }
  if ([providerErrorCode isEqualToString:@"E_COMPLETION_HTTP_STATUS"] ||
      [providerErrorCode isEqualToString:@"E_COMPLETION_HTTP_429"]) {
    return @"E_AGENT_TOOL_FAILED";
  }
  if ([providerErrorCode isEqualToString:@"E_COMPLETION_RESPONSE_JSON"] ||
      [providerErrorCode isEqualToString:@"E_COMPLETION_EMPTY_RESPONSE"] ||
      [providerErrorCode isEqualToString:@"E_COMPLETION_TOOL_CALL_INVALID"] ||
      [providerErrorCode isEqualToString:@"E_COMPLETION_FINISH_RELATION"]) {
    return @"E_AGENT_TRANSCRIPT";
  }
  if ([providerErrorCode isEqualToString:@"E_COMPLETION_CREDENTIAL_CHANGED"]) {
    return @"E_AGENT_PERSISTENCE";
  }
  return @"E_AGENT_ROUND_AMBIGUOUS";
}

NSDictionary *DSHProviderOperationSafeResult(NSDictionary *result) {
  return @{
    @"schema_version" : @2,
    @"result_kind" : @"complete_agent_round_v2",
    @"result" : result,
  };
}

NSArray *DSHProviderToolsForAuthority(
    NSDictionary *authority,
    DSHAgentToolRegistry *registry,
    NSError **error) {
  NSMutableArray *raw = [NSMutableArray array];
  for (NSDictionary *safeTool in authority[@"registry"][@"tools"]) {
    NSDictionary *native = [registry nativeDescriptorForToolName:safeTool[@"name"]
                                                                error:error];
    if (native == nil) return nil;
    [raw addObject:@{
      @"type" : @"function",
      @"name" : native[@"name"],
      @"description" : native[@"safe_summary_key"],
      @"parameters" : native[@"parameters"],
    }];
  }
  return DSHCompletionToolsV2FromArray(raw, error);
}

NSArray *DSHProviderTranscriptForBody(NSArray *nativeMessages,
                                             NSUInteger roundIndex,
                                             NSString *thinkingMode,
                                             NSError **error) {
  NSMutableArray *provider = [NSMutableArray array];
  for (NSDictionary *message in nativeMessages) {
    if ([message[@"role"] isEqualToString:@"assistant"]) {
      NSMutableArray *calls = [NSMutableArray array];
      for (NSDictionary *call in message[@"tool_calls"]) {
        [calls addObject:@{
          @"id" : call[@"call_id"],
          @"type" : @"function",
          @"function" : @{
            @"name" : call[@"name"],
            @"arguments" : call[@"arguments_json"],
          },
        }];
      }
      [provider addObject:@{
        @"role" : @"assistant",
        @"content" : message[@"content"],
        @"reasoning_content" : message[@"reasoning_content"],
        @"tool_calls" : [calls copy],
      }];
    } else if ([message[@"role"] isEqualToString:@"tool"]) {
      [provider addObject:@{
        @"role" : @"tool",
        @"tool_call_id" : message[@"call_id"],
        @"content" : message[@"content"],
      }];
    } else {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorCorrupt);
      return nil;
    }
  }
  return DSHCompletionRoundTranscriptSchema2FromArray(provider,
                                                       (NSInteger)roundIndex,
                                                       thinkingMode,
                                                       error);
}


@implementation DSHAgentProviderRoundContext
@end

NSString *DSHProviderLocatorKey(NSDictionary *locator) {
  NSError *error = nil;
  NSData *bytes = DSHAgentCanonicalJSON(locator, &error);
  return bytes == nil ? nil : [[NSString alloc] initWithData:bytes
                                                      encoding:NSUTF8StringEncoding];
}

NSDictionary *DSHProviderRoundResultForRow(NSDictionary *request,
                                                  NSDictionary *row,
                                                  NSString *status,
                                                  NSString *failureCode) {
  NSMutableDictionary *result = [DSHProviderUnknownResult(
      request, status, [row[@"row_revision"] unsignedIntegerValue],
      failureCode) mutableCopy];
  result[@"transcript"] = (id)row[@"transcript_after"] == NSNull.null
      ? row[@"transcript_before"] : row[@"transcript_after"];
  return [result copy];
}

NSDictionary *DSHProviderQueryResultForRow(NSDictionary *request,
                                                  NSDictionary *row,
                                                  NSString *status,
                                                  NSString *failureCode) {
  NSMutableDictionary *result = [@{
    @"schema_version" : @2,
    @"status" : status,
    @"task_id" : request[@"task_id"],
    @"attempt_id" : request[@"attempt_id"],
    @"round_id" : request[@"round_id"],
    @"round_index" : request[@"round_index"],
    @"result_round_revision" : row[@"row_revision"] ?: @0,
    @"transcript" : (id)row[@"transcript_after"] == NSNull.null
        ? row[@"transcript_before"] : row[@"transcript_after"],
  } mutableCopy];
  if (failureCode != nil) result[@"failure_code"] = failureCode;
  return [result copy];
}

NSDictionary *DSHProviderSelectorConflict(NSDictionary *request,
                                                 NSDictionary *row,
                                                 NSString *failureCode) {
  NSMutableDictionary *result = [@{
    @"schema_version" : @2,
    @"status" : @"conflict",
    @"failure_code" : failureCode,
    @"expected_round_revision" : request[@"expected_round_revision"],
    @"actual_round_revision" : row[@"row_revision"] ?: @0,
    @"actual_round_status" : row[@"state"] ?: @"unknown",
    @"actual_transcript" : (id)row[@"transcript_after"] == NSNull.null
        ? row[@"transcript_before"] : row[@"transcript_after"],
  } mutableCopy];
  return [result copy];
}

BOOL DSHProviderSelectorRequest(NSDictionary *request,
                                       BOOL cancellation,
                                       BOOL allowZeroRevision,
                                       NSError **error) {
  NSMutableArray *keys = [NSMutableArray arrayWithArray:@[
    @"schema_version", @"task_id", @"attempt_id", @"round_id", @"round_index",
    @"expected_round_revision", @"transcript", @"root",
  ]];
  if (cancellation) [keys addObject:@"cancel_token"];
  if (!DSHAgentExactDictionaryKeys(request, keys) ||
      !DSHProviderSchema(request[@"schema_version"], 2) ||
      !DSHProviderUUID(request[@"task_id"]) || !DSHProviderUUID(request[@"attempt_id"]) ||
      !DSHProviderUUID(request[@"round_id"]) ||
      !DSHAgentSafeInteger(request[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(request[@"expected_round_revision"],
                           DSHAgentProviderMaximumSafeInteger,
                           allowZeroRevision) ||
      !DSHProviderReference(request[@"transcript"]) ||
      ![request[@"root"] isKindOfClass:NSDictionary.class] ||
      ![DSHAgentRootResolver validateAgentRootProjection:request[@"root"]
                                                   error:error] ||
      (cancellation && !DSHProviderUUID(request[@"cancel_token"]))) {
    if (error != nullptr && *error == nil) {
      DSHSetProviderError(error, DSHAgentNativeStoreErrorInvalidArgument);
    }
    return NO;
  }
  return YES;
}

BOOL DSHProviderSelectorMatchesRow(NSDictionary *request,
                                          NSDictionary *row) {
  return [row[@"row_revision"] isEqual:request[@"expected_round_revision"]] &&
      [row[@"root_fingerprint_sha256"]
          isEqual:request[@"root"][@"root_fingerprint_sha256"]] &&
      [row[@"binding_revision"]
          isEqual:request[@"root"][@"workspace_binding_revision"]] &&
      [row[@"transcript_before"] isEqual:request[@"transcript"]];
}

void DSHProviderFinishContext(DSHAgentProviderRoundContext *context,
                                     NSDictionary *result,
                                     NSString *errorCode) {
  if (context == nil) return;
  BOOL signal = NO;
  @synchronized (context) {
    if (!context.finished) {
      context.finished = YES;
      context.providerResult = [result copy];
      context.providerErrorCode = [errorCode copy];
      signal = YES;
    }
  }
  if (signal && context.semaphore != nil) {
    dispatch_semaphore_signal(context.semaphore);
  }
}
