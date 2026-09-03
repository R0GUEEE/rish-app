#import "AgentRoundJournal.h"
#import "RishHarnessCatalog.h"

#import "AgentTranscriptStore.h"

static NSArray<NSString *> *DSHAgentRoundLocatorKeys(void) {
  return @[
    @"schema_version", @"task_id", @"attempt_id", @"round_id",
    @"round_index",
  ];
}

static NSString *DSHAgentRoundDispatchState(NSArray *dispatchRows,
                                             NSDictionary *locator) {
  for (NSDictionary *entry in dispatchRows) {
    if ([entry[@"kind"] isEqualToString:@"round"] &&
        [entry[@"locator"] isEqual:locator]) {
      return entry[@"dispatch_state"];
    }
  }
  return nil;
}

static NSArray<NSString *> *DSHAgentRoundKeys(void) {
  return @[
    @"schema_version", @"locator", @"row_revision",
    @"root_fingerprint_sha256", @"binding_revision", @"request_sha256",
    @"transcript_before", @"launch_attempt", @"state", @"owner",
    @"failure_code", @"completion_receipt", @"transcript_after", @"calls",
    @"terminal_kind", @"created_at", @"updated_at",
  ];
}

static NSArray<NSString *> *DSHAgentReferenceKeysForRound(void) {
  return @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ];
}

static BOOL DSHAgentRoundRoot(NSDictionary *root) {
  NSArray *keys = @[
    @"schema_version", @"kind", @"workspace_id",
    @"workspace_binding_revision", @"project_id",
    @"root_fingerprint_sha256", @"capabilities",
  ];
  if (!DSHAgentExactDictionaryKeys(root, keys) ||
      !DSHAgentSafeInteger(root[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(root[@"workspace_id"]) ||
      !DSHAgentSafeInteger(root[@"workspace_binding_revision"],
                          9007199254740991ULL, NO) ||
      !DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) ||
      ![root[@"capabilities"] isKindOfClass:NSArray.class] ||
      [(NSArray *)root[@"capabilities"] count] > 6) {
    return NO;
  }
  NSString *kind = root[@"kind"];
  if (![kind isKindOfClass:NSString.class]) return NO;
  id project = root[@"project_id"];
  if (![kind isEqualToString:@"project"] && ![kind isEqualToString:@"workspace"]) {
    return NO;
  }
  if (project != NSNull.null && !DSHAgentCanonicalUUID(project)) return NO;
  if ([kind isEqualToString:@"project"] && project == NSNull.null) return NO;
  if ([kind isEqualToString:@"workspace"] && project != NSNull.null) return NO;
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push",
  ]];
  NSMutableSet *seen = [NSMutableSet set];
  for (id capability in root[@"capabilities"]) {
    if (![capability isKindOfClass:NSString.class] ||
        ![allowed containsObject:capability] || [seen containsObject:capability]) {
      return NO;
    }
    if ([kind isEqualToString:@"workspace"] &&
        [capability hasPrefix:@"git_"]) return NO;
    [seen addObject:capability];
  }
  return YES;
}

static BOOL DSHAgentRoundRootExpectation(NSDictionary *root) {
  return DSHAgentExactDictionaryKeys(root, @[
    @"schema_version", @"root_fingerprint_sha256", @"binding_revision",
  ]) && DSHAgentSafeInteger(root[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) &&
      DSHAgentSafeInteger(root[@"binding_revision"], 9007199254740991ULL, NO);
}

static BOOL DSHAgentRoundRootOrExpectation(NSDictionary *root) {
  return DSHAgentRoundRoot(root) || DSHAgentRoundRootExpectation(root);
}

static BOOL DSHAgentRoundLocator(NSDictionary *locator) {
  return DSHAgentExactDictionaryKeys(locator, DSHAgentRoundLocatorKeys()) &&
      DSHAgentSafeInteger(locator[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(locator[@"task_id"]) &&
      DSHAgentCanonicalUUID(locator[@"attempt_id"]) &&
      DSHAgentCanonicalUUID(locator[@"round_id"]) &&
      DSHAgentSafeInteger(locator[@"round_index"], 7, YES);
}

static BOOL DSHAgentRoundReference(NSDictionary *reference) {
  if (![reference isKindOfClass:NSDictionary.class]) return NO;
  return DSHAgentExactDictionaryKeys(reference, DSHAgentReferenceKeysForRound()) &&
      DSHAgentSafeInteger(reference[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(reference[@"transcript_ref"]) &&
      DSHAgentSafeInteger(reference[@"generation"], 9007199254740991ULL, YES) &&
      DSHAgentCanonicalSHA256(reference[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(reference[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

static BOOL DSHAgentRoundOwner(NSDictionary *owner) {
  return DSHAgentExactDictionaryKeys(owner, @[
    @"schema_version", @"task_id", @"launch_id", @"native_task_id",
    @"owner_generation", @"heartbeat_at",
  ]) && DSHAgentSafeInteger(owner[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(owner[@"task_id"]) &&
      DSHAgentCanonicalUUID(owner[@"launch_id"]) &&
      DSHAgentCanonicalUUID(owner[@"native_task_id"]) &&
      DSHAgentSafeInteger(owner[@"owner_generation"],
                          9007199254740991ULL, NO) &&
      DSHAgentCanonicalTimestamp(owner[@"heartbeat_at"]);
}

static BOOL DSHAgentOwnerMatches(NSDictionary *rowOwner,
                                 id expectedGeneration,
                                 id expectedLaunch,
                                 id expectedNative) {
  if (expectedGeneration == NSNull.null || expectedGeneration == nil) {
    return rowOwner == nil || (id)rowOwner == NSNull.null;
  }
  return DSHAgentRoundOwner(rowOwner) &&
      [rowOwner[@"owner_generation"] isEqual:expectedGeneration] &&
      [rowOwner[@"launch_id"] isEqual:expectedLaunch] &&
      [rowOwner[@"native_task_id"] isEqual:expectedNative];
}

static BOOL DSHAgentRoundCallPresentation(NSDictionary *call) {
  if (![call isKindOfClass:NSDictionary.class]) return NO;
  NSString *callId = call[@"call_id"];
  NSString *name = call[@"name"];
  if (![call[@"access"] isKindOfClass:NSString.class]) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  return DSHAgentExactDictionaryKeys(call, @[
    @"schema_version", @"call_id", @"name", @"arguments_sha256",
    @"safe_summary_key", @"access",
  ]) && DSHAgentSafeInteger(call[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalSHA256(call[@"arguments_sha256"]) &&
      DSHAgentBoundedUTF8String(callId, 128, NO, nullptr) &&
      [callId rangeOfCharacterFromSet:invalid].location == NSNotFound &&
      DSHAgentBoundedUTF8String(name, 64, NO, nullptr) &&
      [name rangeOfCharacterFromSet:[[NSCharacterSet
          characterSetWithCharactersInString:
              @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
          invertedSet]].location == NSNotFound &&
      DSHAgentBoundedUTF8String(call[@"safe_summary_key"], 128, NO, nullptr) &&
      ([call[@"access"] isEqualToString:@"auto"] ||
       [call[@"access"] isEqualToString:@"conversation_confirm"] ||
       [call[@"access"] isEqualToString:@"confirm_once"]);
}

static BOOL DSHAgentOpaqueIdentifier(NSString *value) {
  if (!DSHAgentBoundedUTF8String(value, 128, NO, nullptr)) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHAgentRoundMessagesMatchCalls(NSArray *messages,
                                            NSArray *calls,
                                            NSUInteger roundIndex,
                                            NSError **error) {
  NSUInteger callIndex = 0;
  for (NSDictionary *message in messages) {
    if (![message isKindOfClass:NSDictionary.class] ||
        ![message[@"role"] isKindOfClass:NSString.class] ||
        !DSHAgentExactDictionaryKeys(message, @[
          @"schema_version", @"role", @"round_index", @"content",
          @"reasoning_content", @"tool_calls",
        ]) || !DSHAgentSafeInteger(message[@"schema_version"], 1, NO) ||
        ![message[@"role"] isEqualToString:@"assistant"] ||
        !DSHAgentSafeInteger(message[@"round_index"], 7, YES) ||
        [message[@"round_index"] unsignedIntegerValue] != roundIndex ||
        !DSHAgentBoundedUTF8String(message[@"content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        !DSHAgentBoundedUTF8String(message[@"reasoning_content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        ![message[@"tool_calls"] isKindOfClass:NSArray.class] ||
        [(NSArray *)message[@"tool_calls"] count] > 16) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    for (NSDictionary *toolCall in message[@"tool_calls"]) {
      if (!DSHAgentExactDictionaryKeys(toolCall, @[
            @"schema_version", @"call_id", @"name", @"arguments_json",
          ]) || !DSHAgentSafeInteger(toolCall[@"schema_version"], 1, NO) ||
          !DSHAgentBoundedUTF8String(toolCall[@"call_id"], 128, NO, nullptr) ||
          !DSHAgentBoundedUTF8String(toolCall[@"name"], 64, NO, nullptr) ||
          !DSHAgentParseArgumentsJSON(toolCall[@"arguments_json"], error)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      NSString *callId = toolCall[@"call_id"];
      NSCharacterSet *invalid = [[NSCharacterSet
          characterSetWithCharactersInString:
              @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
          invertedSet];
      if ([callId rangeOfCharacterFromSet:invalid].location != NSNotFound ||
          callIndex >= calls.count) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSDictionary *presentation = calls[callIndex];
      NSError *digestError = nil;
      NSString *argumentsDigest = DSHAgentArgumentsSHA256(
          toolCall[@"name"], toolCall[@"arguments_json"], &digestError);
      if (!DSHAgentRoundCallPresentation(presentation) ||
          ![presentation[@"call_id"] isEqual:callId] ||
          ![presentation[@"name"] isEqual:toolCall[@"name"]] ||
          ![presentation[@"arguments_sha256"] isEqual:argumentsDigest]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      callIndex += 1;
    }
  }
  if (callIndex != calls.count) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

static BOOL DSHAgentCompletionReceipt(NSDictionary *receipt,
                                      NSDictionary *locator) {
  if (!DSHAgentExactDictionaryKeysWithOptional(receipt, @[
        @"schema_version", @"transport_schema_version", @"turn_id",
        @"attempt_id", @"round_id", @"round_index", @"provider_request_id",
        @"provider_response_id", @"requested_model", @"model", @"thinking_mode",
        @"finish_reason", @"latency_ms", @"visible_history_sha256",
        @"model_input_sha256", @"request_body_sha256", @"project_context_receipt",
      ], @[@"harness_id"]) || !DSHAgentSafeInteger(receipt[@"schema_version"], 1, NO) ||
      (![receipt[@"transport_schema_version"] isEqual:@2] &&
       ![receipt[@"transport_schema_version"] isEqual:@3]) ||
      !DSHAgentCanonicalUUID(receipt[@"turn_id"]) ||
      !DSHAgentCanonicalUUID(receipt[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(receipt[@"round_id"]) ||
      ![receipt[@"turn_id"] isEqual:locator[@"task_id"]] ||
      ![receipt[@"attempt_id"] isEqual:locator[@"attempt_id"]] ||
      ![receipt[@"round_id"] isEqual:locator[@"round_id"]] ||
      !DSHAgentSafeInteger(receipt[@"round_index"], 7, YES) ||
      ![receipt[@"round_index"] isEqual:locator[@"round_index"]] ||
      !DSHAgentOpaqueIdentifier(receipt[@"provider_request_id"]) ||
      !DSHAgentOpaqueIdentifier(receipt[@"provider_response_id"]) ||
      !DSHAgentBoundedUTF8String(receipt[@"requested_model"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(receipt[@"model"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(receipt[@"thinking_mode"], 32, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(receipt[@"finish_reason"], 32, NO, nullptr) ||
      !DSHAgentSafeInteger(receipt[@"latency_ms"], 24 * 60 * 60 * 1000, YES) ||
      !DSHAgentCanonicalSHA256(receipt[@"visible_history_sha256"]) ||
      !DSHAgentCanonicalSHA256(receipt[@"model_input_sha256"]) ||
      !DSHAgentCanonicalSHA256(receipt[@"request_body_sha256"])) {
    return NO;
  }
  NSSet *models = DSHHarnessSupportedModels();
  if (receipt[@"harness_id"] != nil &&
      ![DSHHarnessIdForModel(receipt[@"model"]) isEqual:receipt[@"harness_id"]]) {
    return NO;
  }
  if (![models containsObject:receipt[@"requested_model"]] ||
      ![models containsObject:receipt[@"model"]] ||
      ![receipt[@"requested_model"] isEqual:receipt[@"model"]] ||
      (![receipt[@"thinking_mode"] isEqualToString:@"off"] &&
       ![receipt[@"thinking_mode"] isEqualToString:@"high"] &&
       ![receipt[@"thinking_mode"] isEqualToString:@"max"])) return NO;
  NSString *finishReason = receipt[@"finish_reason"];
  if (![finishReason isEqualToString:@"stop"] &&
      ![finishReason isEqualToString:@"tool_calls"] &&
      ![finishReason isEqualToString:@"length"] &&
      ![finishReason isEqualToString:@"content_filter"]) return NO;
  id context = receipt[@"project_context_receipt"];
  if (context == NSNull.null) return YES;
  return DSHAgentExactDictionaryKeys(context, @[
           @"schema_version", @"snapshot_id", @"snapshot_sha256",
           @"source_fingerprint", @"context_bytes", @"verified_at",
         ]) && DSHAgentSafeInteger(context[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(context[@"snapshot_id"]) &&
      DSHAgentCanonicalSHA256(context[@"snapshot_sha256"]) &&
      DSHAgentCanonicalSHA256(context[@"source_fingerprint"]) &&
      DSHAgentSafeInteger(context[@"context_bytes"], 32 * 1024 * 1024, YES) &&
      DSHAgentCanonicalTimestamp(context[@"verified_at"]);
}

static BOOL DSHAgentRoundRow(NSDictionary *row) {
  if (!DSHAgentExactDictionaryKeys(row, DSHAgentRoundKeys()) ||
      ![row[@"schema_version"] isEqual:@2] ||
      !DSHAgentRoundLocator(row[@"locator"]) ||
      !DSHAgentSafeInteger(row[@"row_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentCanonicalSHA256(row[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(row[@"binding_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentCanonicalSHA256(row[@"request_sha256"]) ||
      !DSHAgentRoundReference(row[@"transcript_before"]) ||
      !DSHAgentSafeInteger(row[@"launch_attempt"], 8, NO) ||
      ![row[@"calls"] isKindOfClass:NSArray.class] ||
      [(NSArray *)row[@"calls"] count] > 16 ||
      !DSHAgentCanonicalTimestamp(row[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(row[@"updated_at"])) {
    return NO;
  }
  NSString *state = row[@"state"];
  if (![state isKindOfClass:NSString.class]) return NO;
  NSSet *states = [NSSet setWithArray:@[
    @"in_flight", @"failed_retryable", @"completed", @"cancel_requested",
    @"cancelled", @"unknown", @"ambiguous",
  ]];
  if (![states containsObject:state]) return NO;
  id owner = row[@"owner"];
  if (owner != NSNull.null && !DSHAgentRoundOwner(owner)) return NO;
  if (owner != NSNull.null &&
      ![owner[@"task_id"] isEqual:row[@"locator"][@"task_id"]]) return NO;
  id failure = row[@"failure_code"];
  if (failure != NSNull.null && !DSHAgentFailureCode(failure)) {
    return NO;
  }
  id receipt = row[@"completion_receipt"];
  if (receipt != NSNull.null &&
      (!DSHAgentCompletionReceipt(receipt, row[@"locator"]))) return NO;
  id after = row[@"transcript_after"];
  if (after != NSNull.null && !DSHAgentRoundReference(after)) return NO;
  id terminal = row[@"terminal_kind"];
  if (terminal != NSNull.null && ![terminal isKindOfClass:NSString.class]) return NO;
  if (terminal != NSNull.null && (![terminal isEqualToString:@"final"] &&
                                  ![terminal isEqualToString:@"tool_batch"] &&
                                  ![terminal isEqualToString:@"blocked"])) {
    return NO;
  }
  for (NSDictionary *call in row[@"calls"]) {
    if (!DSHAgentRoundCallPresentation(call)) return NO;
  }
  if ([state isEqualToString:@"completed"] && receipt != NSNull.null) {
    NSString *finishReason = receipt[@"finish_reason"];
    if ([finishReason isEqualToString:@"tool_calls"] &&
        (![terminal isEqualToString:@"tool_batch"] ||
         [(NSArray *)row[@"calls"] count] == 0)) return NO;
    if ([finishReason isEqualToString:@"stop"] &&
        (![terminal isEqualToString:@"final"] ||
         [(NSArray *)row[@"calls"] count] != 0)) return NO;
    if (([finishReason isEqualToString:@"length"] ||
         [finishReason isEqualToString:@"content_filter"]) &&
        (![terminal isEqualToString:@"blocked"] ||
         [(NSArray *)row[@"calls"] count] != 0)) return NO;
  }
  if ([state isEqualToString:@"in_flight"] ||
      [state isEqualToString:@"cancel_requested"]) {
    if (owner == NSNull.null || receipt != NSNull.null) return NO;
  } else if ([state isEqualToString:@"completed"]) {
    if (owner != NSNull.null || receipt == NSNull.null || after == NSNull.null ||
        terminal == NSNull.null || failure != NSNull.null) {
      return NO;
    }
  } else if ([state isEqualToString:@"cancelled"]) {
    if (owner != NSNull.null || receipt != NSNull.null || after == NSNull.null ||
        ![terminal isEqualToString:@"blocked"] ||
        ![failure isEqualToString:@"E_AGENT_CANCELLED"]) {
      return NO;
    }
    if (![after isEqual:row[@"transcript_before"]]) return NO;
  } else if ([state isEqualToString:@"failed_retryable"]) {
    if (owner != NSNull.null || receipt != NSNull.null || after != NSNull.null ||
        terminal != NSNull.null || failure == NSNull.null) {
      return NO;
    }
  } else if ([state isEqualToString:@"unknown"] ||
             [state isEqualToString:@"ambiguous"]) {
    if (owner != NSNull.null || receipt != NSNull.null || terminal != NSNull.null ||
        failure == NSNull.null) {
      return NO;
    }
    if ([state isEqualToString:@"ambiguous"] &&
        ![failure isEqualToString:@"E_AGENT_ROUND_AMBIGUOUS"]) return NO;
    if ([state isEqualToString:@"unknown"] &&
        ![failure isEqualToString:@"E_AGENT_PERSISTENCE"]) return NO;
  }
  return YES;
}

BOOL DSHAgentValidateRoundNativeEntryV2(NSDictionary *row, NSError **error) {
  if (DSHAgentRoundRow(row)) return YES;
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
  return NO;
}

static BOOL DSHAgentRoundTranscriptBound(NSDictionary *state,
                                         NSDictionary *row,
                                         NSError **error) {
  NSDictionary *before = row[@"transcript_before"];
  NSDictionary *locator = row[@"locator"];
  for (NSDictionary *transcript in state[@"transcripts"]) {
    if (![transcript[@"transcript_ref"] isEqual:before[@"transcript_ref"]]) continue;
    if (![transcript[@"attempt_id"] isEqual:locator[@"attempt_id"]] ||
        ![transcript[@"root_fingerprint_sha256"]
             isEqual:row[@"root_fingerprint_sha256"]] ||
        ![transcript[@"generation"] isEqual:before[@"generation"]] ||
        ![transcript[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] ||
        ![transcript[@"transcript_bytes"] isEqual:before[@"transcript_bytes"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    return YES;
  }
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
  return NO;
}

static BOOL DSHAgentRoundInsertCAS(NSDictionary *cas) {
  return DSHAgentExactDictionaryKeys(cas, @[
    @"schema_version", @"locator", @"expected_absent",
    @"expected_transcript_generation", @"expected_transcript_sha256",
    @"expected_root_fingerprint_sha256", @"expected_binding_revision",
  ]) && DSHAgentSafeInteger(cas[@"schema_version"], 1, NO) &&
      DSHAgentRoundLocator(cas[@"locator"]) &&
      [cas[@"expected_absent"] isKindOfClass:NSNumber.class] &&
      CFGetTypeID((__bridge CFTypeRef)cas[@"expected_absent"]) ==
          CFBooleanGetTypeID() && [cas[@"expected_absent"] boolValue] &&
      DSHAgentSafeInteger(cas[@"expected_transcript_generation"],
                          9007199254740991ULL, YES) &&
      DSHAgentCanonicalSHA256(cas[@"expected_transcript_sha256"]) &&
      DSHAgentCanonicalSHA256(cas[@"expected_root_fingerprint_sha256"]) &&
      DSHAgentSafeInteger(cas[@"expected_binding_revision"],
                          9007199254740991ULL, NO);
}

static BOOL DSHAgentRoundCAS(NSDictionary *cas) {
  return DSHAgentExactDictionaryKeys(cas, @[
    @"schema_version", @"locator", @"expected_row_revision",
    @"expected_state", @"expected_owner_generation", @"expected_launch_id",
    @"expected_native_task_id", @"expected_transcript_generation",
    @"expected_transcript_sha256", @"expected_root_fingerprint_sha256",
    @"expected_binding_revision",
  ]) && [cas[@"schema_version"] isEqual:@2] &&
      DSHAgentRoundLocator(cas[@"locator"]) &&
      DSHAgentSafeInteger(cas[@"expected_row_revision"],
                          9007199254740991ULL, NO) &&
      DSHAgentBoundedUTF8String(cas[@"expected_state"], 32, NO, nullptr) &&
      ((cas[@"expected_owner_generation"] == NSNull.null) ||
       DSHAgentSafeInteger(cas[@"expected_owner_generation"],
                           9007199254740991ULL, NO)) &&
      ((cas[@"expected_launch_id"] == NSNull.null) ||
       DSHAgentCanonicalUUID(cas[@"expected_launch_id"])) &&
      ((cas[@"expected_native_task_id"] == NSNull.null) ||
       DSHAgentCanonicalUUID(cas[@"expected_native_task_id"])) &&
      DSHAgentSafeInteger(cas[@"expected_transcript_generation"],
                          9007199254740991ULL, YES) &&
      DSHAgentCanonicalSHA256(cas[@"expected_transcript_sha256"]) &&
      DSHAgentCanonicalSHA256(cas[@"expected_root_fingerprint_sha256"]) &&
      DSHAgentSafeInteger(cas[@"expected_binding_revision"],
                          9007199254740991ULL, NO);
}

static BOOL DSHAgentRoundCASMatchesRow(NSDictionary *row,
                                       NSDictionary *cas,
                                       NSError **error) {
  if (!DSHAgentRoundCAS(cas) || ![row[@"locator"] isEqual:cas[@"locator"]] ||
      ![row[@"row_revision"] isEqual:cas[@"expected_row_revision"]] ||
      ![row[@"state"] isEqual:cas[@"expected_state"]] ||
      !DSHAgentOwnerMatches(row[@"owner"], cas[@"expected_owner_generation"],
                            cas[@"expected_launch_id"], cas[@"expected_native_task_id"]) ||
      ![row[@"transcript_before"] isEqual:@{
        @"schema_version" : @1,
        @"transcript_ref" : row[@"transcript_before"][@"transcript_ref"],
        @"generation" : cas[@"expected_transcript_generation"],
        @"transcript_sha256" : cas[@"expected_transcript_sha256"],
        @"transcript_bytes" : row[@"transcript_before"][@"transcript_bytes"],
      }] ||
      ![row[@"root_fingerprint_sha256"] isEqual:cas[@"expected_root_fingerprint_sha256"]] ||
      ![row[@"binding_revision"] isEqual:cas[@"expected_binding_revision"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

static BOOL DSHAgentRoundTransitionAllowed(NSString *from,
                                           NSString *to,
                                           BOOL allowReconcile) {
  if (![from isKindOfClass:NSString.class] || ![to isKindOfClass:NSString.class]) {
    return NO;
  }
  if ([from isEqualToString:to]) return YES;
  if ([from isEqualToString:@"in_flight"]) {
    if (allowReconcile &&
        ([to isEqualToString:@"failed_retryable"] ||
         [to isEqualToString:@"unknown"] || [to isEqualToString:@"ambiguous"])) {
      return YES;
    }
    return [to isEqualToString:@"completed"] ||
        [to isEqualToString:@"cancel_requested"];
  }
  if ([from isEqualToString:@"cancel_requested"]) {
    if (allowReconcile &&
        ([to isEqualToString:@"failed_retryable"] ||
         [to isEqualToString:@"unknown"] || [to isEqualToString:@"ambiguous"])) {
      return YES;
    }
    return [to isEqualToString:@"completed"] || [to isEqualToString:@"cancelled"];
  }
  if ([from isEqualToString:@"failed_retryable"]) {
    return [to isEqualToString:@"in_flight"] ||
        (allowReconcile && [to isEqualToString:@"cancelled"]);
  }
  return allowReconcile &&
      ([from isEqualToString:@"cancelled"] || [from isEqualToString:@"unknown"] ||
       [from isEqualToString:@"ambiguous"]) &&
      ([to isEqualToString:@"cancelled"] || [to isEqualToString:@"unknown"] ||
       [to isEqualToString:@"ambiguous"]);
}

static BOOL DSHAgentRoundPatchKeysAllowed(NSDictionary *patch,
                                          NSError **error) {
  if (![patch isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSSet *mutableKeys = [NSSet setWithArray:@[
    @"state", @"owner", @"failure_code", @"completion_receipt",
    @"transcript_after", @"calls", @"terminal_kind",
  ]];
  for (id key in patch) {
    if (![key isKindOfClass:NSString.class] || ![mutableKeys containsObject:key]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
  }
  return YES;
}

static NSDictionary *DSHAgentRoundResultForRow(NSDictionary *row,
                                               NSDictionary *state) {
  NSString *kind = [row[@"terminal_kind"] isEqualToString:@"final"] ? @"final" :
      ([row[@"terminal_kind"] isEqualToString:@"tool_batch"] ? @"tool_batch" : @"blocked");
  NSMutableDictionary *result = [@{
    @"schema_version" : @1,
    @"kind" : kind,
    @"finish_reason" : row[@"completion_receipt"][@"finish_reason"] ?: NSNull.null,
    @"completion_receipt" : row[@"completion_receipt"] ?: NSNull.null,
    @"transcript" : row[@"transcript_after"] ?: row[@"transcript_before"],
  } mutableCopy];
  if ([kind isEqualToString:@"tool_batch"]) {
    result[@"calls"] = row[@"calls"] ?: @[];
  }
  if ([kind isEqualToString:@"blocked"]) {
    result[@"failure_code"] = row[@"failure_code"] ?: NSNull.null;
  }
  NSDictionary *after = row[@"transcript_after"];
  for (NSDictionary *transcript in state[@"transcripts"]) {
    if (![transcript[@"transcript_ref"] isEqual:after[@"transcript_ref"]] ||
        ![transcript[@"generation"] isEqual:after[@"generation"]]) continue;
    NSArray *messages = transcript[@"messages"];
    NSDictionary *assistant = nil;
    for (NSDictionary *message in messages.reverseObjectEnumerator) {
      if ([message[@"role"] isEqualToString:@"assistant"]) {
        assistant = message;
        break;
      }
    }
    if (assistant != nil) {
      if ([kind isEqualToString:@"final"] || [kind isEqualToString:@"tool_batch"]) {
        result[@"reasoning"] = assistant[@"reasoning_content"] ?: @"";
      }
      if ([kind isEqualToString:@"final"]) {
        result[@"text"] = assistant[@"content"] ?: @"";
      }
    }
    break;
  }
  return result;
}

@interface DSHAgentRoundJournal ()
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@end

@implementation DSHAgentRoundJournal

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal {
  self = [super init];
  if (self) _wal = wal;
  return self;
}

- (NSDictionary *)createAgentRoundWithInsertCAS:(NSDictionary *)insertCAS
                                 exactRoundStart:(NSDictionary *)round
                                           error:(NSError **)error {
  if (!DSHAgentRoundInsertCAS(insertCAS) || !DSHAgentRoundRow(round) ||
      ![round[@"locator"] isEqual:insertCAS[@"locator"]] ||
      ![round[@"transcript_before"][@"generation"]
          isEqual:insertCAS[@"expected_transcript_generation"]] ||
      ![round[@"transcript_before"][@"transcript_sha256"]
          isEqual:insertCAS[@"expected_transcript_sha256"]] ||
      ![round[@"root_fingerprint_sha256"]
          isEqual:insertCAS[@"expected_root_fingerprint_sha256"]] ||
      ![round[@"binding_revision"] isEqual:insertCAS[@"expected_binding_revision"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *immutableRoundError = nil;
  NSDictionary *immutableRound = DSHAgentImmutableJSONCopy(round,
                                                           &immutableRoundError);
  if (![immutableRound isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  round = immutableRound;
  NSDictionary *startOwner = round[@"owner"];
  if ((id)startOwner == NSNull.null ||
      ![startOwner[@"launch_id"] isEqual:self.wal.launchId] ||
      ![self.wal isNativeTaskAlive:startOwner[@"native_task_id"]
                           launchId:startOwner[@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  NSDictionary *snapshot = [self.wal snapshotWithError:error];
  if (snapshot == nil) return nil;
  for (NSDictionary *candidate in snapshot[@"rounds"]) {
    if (![candidate[@"locator"] isEqual:insertCAS[@"locator"]]) continue;
    NSError *existingDataError = nil;
    NSData *left = DSHAgentCanonicalJSON(candidate, &existingDataError);
    NSData *right = DSHAgentCanonicalJSON(round, &existingDataError);
    if (left != nil && right != nil && [left isEqualToData:right]) {
      return @{ @"schema_version" : @1,
                @"status" : @"existing_identical", @"row" : candidate };
    }
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  __block NSDictionary *inserted = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    for (NSDictionary *candidate in rounds) {
      if ([candidate[@"locator"] isEqual:insertCAS[@"locator"]]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
    }
    if (rounds.count >= DSHAgentNativeWALMaxTranscriptCount *
                            DSHAgentNativeWALMaxRoundRowsPerAttempt) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    NSUInteger attemptRoundCount = 0;
    for (NSDictionary *candidate in rounds) {
      if ([candidate[@"locator"][@"attempt_id"]
              isEqual:round[@"locator"][@"attempt_id"]]) {
        attemptRoundCount += 1;
      }
    }
    if (attemptRoundCount >= DSHAgentNativeWALMaxRoundRowsPerAttempt) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    if (!DSHAgentRoundTranscriptBound(state, round, mutationError)) return NO;
    [rounds addObject:round];
    state[@"rounds"] = rounds;
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    [dispatch addObject:@{
      @"schema_version" : @1,
      @"kind" : @"round",
      @"locator" : round[@"locator"],
      @"dispatch_state" : @"not_dispatched",
    }];
    state[@"dispatch"] = dispatch;
    inserted = [round copy];
    return YES;
  } error:error];
  return committed ? @{ @"schema_version" : @1,
                        @"status" : @"inserted", @"row" : inserted } : nil;
}

- (NSDictionary *)claimAgentRoundWithLocator:(NSDictionary *)locator
                         expectedRowRevision:(NSNumber *)revision
                          expectedOwnerNull:(BOOL)expectedOwnerNull
                                      owner:(NSDictionary *)owner
                                      error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator) ||
      !DSHAgentSafeInteger(revision, 9007199254740991ULL, NO) ||
      !DSHAgentRoundOwner(owner) || !expectedOwnerNull ||
      ![owner[@"task_id"] isEqual:locator[@"task_id"]] ||
      ![owner[@"launch_id"] isEqual:self.wal.launchId] ||
      ![self.wal isNativeTaskAlive:owner[@"native_task_id"]
                           launchId:owner[@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *immutableOwnerError = nil;
  NSDictionary *immutableOwner = DSHAgentImmutableJSONCopy(owner,
                                                           &immutableOwnerError);
  if (![immutableOwner isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  owner = immutableOwner;
  __block NSDictionary *claimed = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *row = [rounds[index] mutableCopy];
      if (![row[@"locator"] isEqual:locator]) continue;
      NSString *dispatchState = [self.wal dispatchStateForKind:@"round"
                                                     locator:locator
                                                       error:mutationError];
      if (![row[@"row_revision"] isEqual:revision] ||
          row[@"owner"] != NSNull.null ||
          ![row[@"state"] isEqualToString:@"failed_retryable"] ||
          ![dispatchState isEqualToString:@"not_dispatched"]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSUInteger rowRevision = [row[@"row_revision"] unsignedIntegerValue];
      if (rowRevision == 9007199254740991ULL) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"owner"] = [owner copy];
      row[@"state"] = @"in_flight";
      row[@"failure_code"] = NSNull.null;
      row[@"row_revision"] = @(rowRevision + 1);
      row[@"updated_at"] = [self.wal currentTimestamp];
      if (!DSHAgentRoundRow(row)) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      rounds[index] = row;
      state[@"rounds"] = rounds;
      claimed = [row copy];
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed ? @{ @"schema_version" : @1,
                        @"status" : @"claimed", @"row" : claimed } : nil;
}

- (NSDictionary *)casAgentRoundWithCAS:(NSDictionary *)cas
                                  patch:(NSDictionary *)patch
                                  error:(NSError **)error {
  return [self casAgentRoundWithCAS:cas
                               patch:patch
                       allowReconcile:NO
                               error:error];
}

- (NSDictionary *)casAgentRoundWithCAS:(NSDictionary *)cas
                                  patch:(NSDictionary *)patch
                          allowReconcile:(BOOL)allowReconcile
                                  error:(NSError **)error {
  NSError *patchError = nil;
  if (!DSHAgentRoundCAS(cas) || !DSHAgentRoundPatchKeysAllowed(patch, &patchError)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *immutablePatchError = nil;
  NSDictionary *immutablePatch = DSHAgentImmutableJSONCopy(
      patch, &immutablePatchError);
  if (![immutablePatch isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  patch = immutablePatch;
  if ((patch[@"state"] != nil &&
       ![patch[@"state"] isKindOfClass:NSString.class])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if (!allowReconcile &&
      ([patch[@"state"] isEqualToString:@"completed"] ||
       [patch[@"state"] isEqualToString:@"cancelled"])) {
    // Terminal rows are created only by complete/cancel's specialized
    // atomic paths. The generic CAS is intentionally non-terminal.
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *row = [rounds[index] mutableCopy];
      if (![row[@"locator"] isEqual:cas[@"locator"]]) continue;
      if (!DSHAgentRoundCASMatchesRow(row, cas, mutationError)) return NO;
      if (!allowReconcile &&
          ([row[@"state"] isEqualToString:@"completed"] ||
           [row[@"state"] isEqualToString:@"cancelled"])) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      if (!DSHAgentRoundTranscriptBound(state, row, mutationError)) return NO;
      NSMutableDictionary *updated = [row mutableCopy];
      [patch enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
        (void)stop;
        updated[key] = value;
      }];
      if ((id)updated[@"owner"] != NSNull.null &&
          (![updated[@"owner"] isKindOfClass:NSDictionary.class] ||
           ![updated[@"owner"][@"task_id"] isEqual:updated[@"locator"][@"task_id"]] ||
           ![updated[@"owner"][@"launch_id"] isEqual:self.wal.launchId] ||
           ![self.wal isNativeTaskAlive:updated[@"owner"][@"native_task_id"]
                                launchId:updated[@"owner"][@"launch_id"]])) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorOwnerLost);
        return NO;
      }
      NSString *nextState = updated[@"state"];
      if (![nextState isKindOfClass:NSString.class]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      if ([nextState isEqualToString:@"failed_retryable"] ||
          [nextState isEqualToString:@"cancelled"]) {
        NSString *dispatchState = [self.wal dispatchStateForKind:@"round"
                                                         locator:row[@"locator"]
                                                           error:mutationError];
        if (![dispatchState isEqualToString:@"not_dispatched"]) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorConflict);
          return NO;
        }
      }
      if (([nextState isEqualToString:@"unknown"] ||
           [nextState isEqualToString:@"ambiguous"]) && !allowReconcile) {
        // Unknown/ambiguous are native recovery outcomes, never a caller
        // supplied reason or an ordinary mutable CAS patch.
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      if (!DSHAgentRoundTransitionAllowed(row[@"state"], updated[@"state"],
                                          allowReconcile)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSUInteger rowRevision = [row[@"row_revision"] unsignedIntegerValue];
      if (rowRevision == 9007199254740991ULL || !DSHAgentRoundRow(updated)) {
        DSHSetAgentNativeStoreError(mutationError,
                                    rowRevision == 9007199254740991ULL
                                        ? DSHAgentNativeStoreErrorCapacity
                                        : DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      updated[@"row_revision"] = @(rowRevision + 1);
      updated[@"updated_at"] = [self.wal currentTimestamp];
      if (!DSHAgentRoundRow(updated)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      rounds[index] = updated;
      state[@"rounds"] = rounds;
      output = @{ @"ok" : @YES, @"row" : [updated copy] };
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
    return NO;
  } error:error];
  if (committed) return output;
  // CAS conflicts must return the current row without applying a partial
  // patch. The WAL error remains stable; expose a conflict envelope when the
  // row still exists so callers can retry with fresh tokens.
  if (error != nullptr && *error != nil &&
      (*error).code == DSHAgentNativeStoreErrorConflict) {
    NSDictionary *state = [self.wal snapshotWithError:nil];
    for (NSDictionary *row in state[@"rounds"]) {
      if ([row[@"locator"] isEqual:cas[@"locator"]]) {
        if (error != nullptr) *error = nil;
        return @{ @"ok" : @NO, @"conflict" : @YES, @"row" : row };
      }
    }
  }
  return nil;
}

- (NSDictionary *)queryAgentRoundWithLocator:(NSDictionary *)locator
                           expectedTranscript:(NSDictionary *)transcript
                                          root:(NSDictionary *)root
                                        error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator) || !DSHAgentRoundReference(transcript) ||
      !DSHAgentRoundRootOrExpectation(root)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if (![self.wal reconcileOwnerLossWithError:error]) return nil;
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  NSDictionary *row = nil;
  for (NSDictionary *candidate in state[@"rounds"]) {
    if ([candidate[@"locator"] isEqual:locator]) {
      row = candidate;
      break;
    }
  }
  if (row == nil) return @{ @"schema_version" : @1, @"status" : @"not_started" };
  if (![row[@"root_fingerprint_sha256"] isEqual:root[@"root_fingerprint_sha256"]] ||
      ![row[@"binding_revision"] isEqual:
          (root[@"binding_revision"] ?: root[@"workspace_binding_revision"])] ||
      ![row[@"transcript_before"] isEqual:transcript]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSString *status = row[@"state"];
  if (([status isEqualToString:@"in_flight"] ||
       [status isEqualToString:@"cancel_requested"]) &&
      row[@"owner"] != NSNull.null &&
      [self.wal isNativeTaskAlive:row[@"owner"][@"native_task_id"]
                          launchId:row[@"owner"][@"launch_id"]]) {
    return @{
      @"schema_version" : @1,
      @"status" : @"in_flight",
      @"launch_id" : row[@"owner"][@"launch_id"],
      @"native_task_id" : row[@"owner"][@"native_task_id"],
    };
  }
  if ([status isEqualToString:@"completed"]) {
    return @{
      @"schema_version" : @1,
      @"status" : @"completed",
      @"result" : DSHAgentRoundResultForRow(row, state),
      @"transcript_before" : row[@"transcript_before"],
      @"transcript_after" : row[@"transcript_after"],
    };
  }
  NSMutableDictionary *result = [@{
    @"schema_version" : @1,
    @"status" : status,
  } mutableCopy];
  if (row[@"failure_code"] != NSNull.null) result[@"failure_code"] = row[@"failure_code"];
  return result;
}

- (NSDictionary *)heartbeatAgentRoundWithCAS:(NSDictionary *)cas
                                        owner:(NSDictionary *)owner
                                        error:(NSError **)error {
  if (!DSHAgentRoundCAS(cas) || !DSHAgentRoundOwner(owner) ||
      ![owner[@"task_id"] isEqual:cas[@"locator"][@"task_id"]] ||
      ![owner[@"launch_id"] isEqual:self.wal.launchId] ||
      ![self.wal isNativeTaskAlive:owner[@"native_task_id"]
                           launchId:owner[@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  return [self casAgentRoundWithCAS:cas patch:@{ @"owner" : owner }
                               error:error];
}

- (NSDictionary *)markAgentRoundDispatchedWithCAS:(NSDictionary *)cas
                                              error:(NSError **)error {
  if (!DSHAgentRoundCAS(cas)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    NSUInteger rowIndex = NSNotFound;
    NSMutableDictionary *row = nil;
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *candidate = [rounds[index] mutableCopy];
      if ([candidate[@"locator"] isEqual:cas[@"locator"]]) {
        row = candidate;
        rowIndex = index;
        break;
      }
    }
    if (row == nil || !DSHAgentRoundCASMatchesRow(row, cas, mutationError) ||
        (![row[@"state"] isEqualToString:@"in_flight"] &&
         ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
        (id)row[@"owner"] == NSNull.null ||
        ![self.wal isNativeTaskAlive:row[@"owner"][@"native_task_id"]
                             launchId:row[@"owner"][@"launch_id"]]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (!DSHAgentRoundTranscriptBound(state, row, mutationError)) return NO;
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    BOOL found = NO;
    for (NSMutableDictionary *entry in dispatch) {
      if (![entry[@"kind"] isEqualToString:@"round"] ||
          ![entry[@"locator"] isEqual:row[@"locator"]]) continue;
      found = YES;
      if ([entry[@"dispatch_state"] isEqualToString:@"dispatched"]) {
        output = @{ @"schema_version" : @1,
                    @"status" : @"already_dispatched",
                    @"row" : [row copy] };
        return NO;
      }
      entry[@"dispatch_state"] = @"dispatched";
      break;
    }
    if (!found) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
    if (revision == 9007199254740991ULL) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    row[@"row_revision"] = @(revision + 1);
    row[@"updated_at"] = [self.wal currentTimestamp];
    if (!DSHAgentRoundRow(row)) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    rounds[rowIndex] = row;
    state[@"rounds"] = rounds;
    state[@"dispatch"] = dispatch;
    output = @{ @"schema_version" : @1,
                @"status" : @"dispatched",
                @"row" : [row copy] };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)completeAgentRoundWithLocator:(NSDictionary *)locator
                                     expectedCAS:(NSDictionary *)cas
                                        messages:(NSArray *)messages
                                completionReceipt:(NSDictionary *)receipt
                                    terminalKind:(NSString *)terminalKind
                                            calls:(NSArray *)calls
                                             root:(NSDictionary *)root
                                            error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator) || !DSHAgentRoundCAS(cas) ||
      ![cas[@"locator"] isEqual:locator] || !DSHAgentRoundRoot(root) ||
      ![messages isKindOfClass:NSArray.class] || messages.count == 0 || messages.count > 16 ||
      !DSHAgentCompletionReceipt(receipt, locator) ||
      (![terminalKind isEqualToString:@"final"] &&
       ![terminalKind isEqualToString:@"tool_batch"] &&
       ![terminalKind isEqualToString:@"blocked"]) ||
      ![calls isKindOfClass:NSArray.class] || calls.count > 16 ||
      ([terminalKind isEqualToString:@"tool_batch"] && calls.count == 0) ||
      (![terminalKind isEqualToString:@"tool_batch"] && calls.count != 0)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *immutableMessagesError = nil;
  NSArray *immutableMessages = DSHAgentImmutableJSONCopy(messages,
                                                         &immutableMessagesError);
  NSArray *immutableCalls = DSHAgentImmutableJSONCopy(calls,
                                                      &immutableMessagesError);
  NSDictionary *immutableReceipt = DSHAgentImmutableJSONCopy(receipt,
                                                              &immutableMessagesError);
  if (![immutableMessages isKindOfClass:NSArray.class] ||
      ![immutableCalls isKindOfClass:NSArray.class] ||
      ![immutableReceipt isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  messages = immutableMessages;
  calls = immutableCalls;
  receipt = immutableReceipt;
  for (NSDictionary *message in messages) {
    if (![message isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
  }
  for (NSDictionary *call in calls) {
    if (!DSHAgentRoundCallPresentation(call)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
  }
  NSError *messageError = nil;
  if (!DSHAgentRoundMessagesMatchCalls(messages, calls,
                                       [locator[@"round_index"] unsignedIntegerValue],
                                       &messageError)) {
    if (error != nullptr) *error = messageError;
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
    NSMutableDictionary *row = nil;
    NSUInteger roundIndex = NSNotFound;
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *candidate = [rounds[index] mutableCopy];
      if ([candidate[@"locator"] isEqual:locator]) {
        row = candidate;
        roundIndex = index;
        break;
      }
    }
    if (row == nil || !DSHAgentRoundCASMatchesRow(row, cas, mutationError) ||
        (![row[@"state"] isEqualToString:@"in_flight"] &&
         ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
        ![DSHAgentRoundDispatchState(state[@"dispatch"], row[@"locator"])
            isEqualToString:@"dispatched"]) {
      if (mutationError != nullptr && *mutationError == nil) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
      }
      return NO;
    }
    if (!DSHAgentRoundTranscriptBound(state, row, mutationError)) return NO;
    NSMutableDictionary *transcriptRow = nil;
    NSUInteger transcriptIndex = NSNotFound;
    NSDictionary *expected = row[@"transcript_before"];
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSMutableDictionary *candidate = [transcripts[index] mutableCopy];
      if ([candidate[@"transcript_ref"] isEqual:expected[@"transcript_ref"]]) {
        transcriptRow = candidate;
        transcriptIndex = index;
        break;
      }
    }
    if (transcriptRow == nil || ![transcriptRow[@"generation"] isEqual:expected[@"generation"]] ||
        ![transcriptRow[@"transcript_sha256"] isEqual:expected[@"transcript_sha256"]]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSMutableArray *messageRows = [transcriptRow[@"messages"] mutableCopy];
    NSUInteger generation = [transcriptRow[@"generation"] unsignedIntegerValue];
    if (generation == 9007199254740991ULL) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    for (NSDictionary *message in messages) [messageRows addObject:[message copy]];
    generation += messages.count;
    NSDictionary *digestInputObject = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcriptRow[@"transcript_ref"],
      @"attempt_id" : transcriptRow[@"attempt_id"],
      @"root_fingerprint_sha256" : transcriptRow[@"root_fingerprint_sha256"],
      @"generation" : @(generation),
      @"messages" : messageRows,
    };
    NSError *digestError = nil;
    NSData *digestInput = DSHAgentCanonicalJSON(digestInputObject, &digestError);
    NSString *digest = DSHAgentHJ(@"agent-transcript", digestInputObject, &digestError);
    if (digest == nil || digestInput.length > DSHAgentNativeWALMaxTranscriptBytes) {
      if (digest == nil) {
        if (mutationError != nullptr) *mutationError = digestError;
      }
      else DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    transcriptRow[@"messages"] = messageRows;
    transcriptRow[@"generation"] = @(generation);
    transcriptRow[@"transcript_sha256"] = digest;
    transcriptRow[@"transcript_bytes"] = @(digestInput.length);
    transcriptRow[@"updated_at"] = [self.wal currentTimestamp];
    NSDictionary *after = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcriptRow[@"transcript_ref"],
      @"generation" : @(generation),
      @"transcript_sha256" : digest,
      @"transcript_bytes" : @(digestInput.length),
    };
    NSUInteger rowRevision = [row[@"row_revision"] unsignedIntegerValue];
    if (rowRevision == 9007199254740991ULL) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    row[@"state"] = @"completed";
    row[@"owner"] = NSNull.null;
    row[@"failure_code"] = NSNull.null;
    row[@"completion_receipt"] = [receipt copy];
    row[@"transcript_after"] = after;
    row[@"terminal_kind"] = terminalKind;
    row[@"calls"] = [calls copy];
    row[@"row_revision"] = @(rowRevision + 1);
    row[@"updated_at"] = [self.wal currentTimestamp];
    if (!DSHAgentRoundRow(row)) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    transcripts[transcriptIndex] = transcriptRow;
    rounds[roundIndex] = row;
    state[@"transcripts"] = transcripts;
    state[@"rounds"] = rounds;
    output = @{
      @"schema_version" : @1,
      @"row" : [row copy],
      @"transcript" : after,
    };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)markAgentRoundFailedRetryableWithCAS:(NSDictionary *)cas
                                           failureCode:(NSString *)failureCode
                                                 error:(NSError **)error {
  if (!DSHAgentRoundCAS(cas) || !DSHAgentFailureCode(failureCode)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *dispatchState = [self.wal dispatchStateForKind:@"round"
                                                    locator:cas[@"locator"]
                                                      error:error];
  if (dispatchState == nil) {
    if (error == nullptr || *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    }
    return nil;
  }
  if (![dispatchState isEqualToString:@"not_dispatched"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  return [self casAgentRoundWithCAS:cas
                               patch:@{
                                 @"state" : @"failed_retryable",
                                 @"owner" : NSNull.null,
                                 @"failure_code" : failureCode,
                                 @"completion_receipt" : NSNull.null,
                                 @"transcript_after" : NSNull.null,
                                 @"terminal_kind" : NSNull.null,
                               }
                       allowReconcile:YES
                               error:error];
}

- (NSDictionary *)cancelAgentRoundWithCAS:(NSDictionary *)cas
                                     error:(NSError **)error {
  if (!DSHAgentRoundCAS(cas)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *dispatchState = [self.wal dispatchStateForKind:@"round"
                                                    locator:cas[@"locator"]
                                                      error:error];
  if (dispatchState == nil) {
    if (error == nullptr || *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    }
    return nil;
  }
  // A live/in-flight round is first moved to cancel_requested.  It can only
  // become cancelled after the persisted dispatch proof says no request was
  // sent; this prevents the forbidden in_flight -> cancelled shortcut.
  if ([cas[@"expected_state"] isEqualToString:@"in_flight"]) {
    return [self casAgentRoundWithCAS:cas
                                 patch:@{ @"state" : @"cancel_requested" }
                                 error:error];
  }
  if (![cas[@"expected_state"] isEqualToString:@"cancel_requested"] &&
      ![cas[@"expected_state"] isEqualToString:@"failed_retryable"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if (![dispatchState isEqualToString:@"not_dispatched"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  NSDictionary *before = nil;
  for (NSDictionary *row in state[@"rounds"]) {
    if ([row[@"locator"] isEqual:cas[@"locator"]]) {
      before = row[@"transcript_before"];
      break;
    }
  }
  if (!DSHAgentRoundReference(before)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
    return nil;
  }
  return [self casAgentRoundWithCAS:cas
                               patch:@{
                                 @"state" : @"cancelled",
                                 @"owner" : NSNull.null,
                                 @"failure_code" : @"E_AGENT_CANCELLED",
                                 @"completion_receipt" : NSNull.null,
                                 @"transcript_after" : before,
                                 @"terminal_kind" : @"blocked",
                               }
                       allowReconcile:YES
                               error:error];
}

- (NSDictionary *)reconcileAgentRoundOwnerLossWithLocator:(NSDictionary *)locator
                                               expectedCAS:(NSDictionary *)cas
                                                    state:(NSString *)state
                                                     error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator) || !DSHAgentRoundCAS(cas) ||
      ![locator isEqual:cas[@"locator"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *snapshot = [self.wal snapshotWithError:error];
  if (snapshot == nil) return nil;
  for (NSDictionary *row in snapshot[@"rounds"]) {
    if (![row[@"locator"] isEqual:locator]) continue;
    NSDictionary *owner = row[@"owner"];
    if ((![row[@"state"] isEqualToString:@"in_flight"] &&
         ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
        (id)owner == NSNull.null || !DSHAgentRoundOwner(owner) ||
        [self.wal isNativeTaskAlive:owner[@"native_task_id"]
                           launchId:owner[@"launch_id"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    // The caller's reason is intentionally ignored. Only the persisted
    // dispatch marker can prove that no provider request was sent.
    (void)state;
    NSError *dispatchError = nil;
    NSString *persistedDispatchState = [self.wal dispatchStateForKind:@"round"
                                                             locator:locator
                                                               error:&dispatchError];
    if (dispatchError != nil) {
      if (error != nullptr) *error = dispatchError;
      return nil;
    }
    NSString *nextState = [persistedDispatchState isEqualToString:@"not_dispatched"]
        ? @"failed_retryable" : @"ambiguous";
    return [self casAgentRoundWithCAS:cas
                                 patch:@{
                                   @"state" : nextState,
                                   @"owner" : NSNull.null,
                                   @"failure_code" : [nextState isEqualToString:@"failed_retryable"]
                                       ? @"E_AGENT_PERSISTENCE"
                                       : @"E_AGENT_ROUND_AMBIGUOUS",
                                   @"completion_receipt" : NSNull.null,
                                   @"transcript_after" : NSNull.null,
                                   @"terminal_kind" : NSNull.null,
                                 }
                         allowReconcile:YES
                                 error:error];
  }
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
  return nil;
}

#pragma mark - Native schema-v3 round composition

// The high-level Agent Runtime accepts only V3 round presentations.  The
// older methods above intentionally remain unchanged for the low-level
// compatibility tests; these helpers keep all V3 rows on the same WAL and
// transcript CAS domain without exposing a second storage file.

static BOOL DSHAgentRoundV3Call(NSDictionary *call, NSUInteger expectedIndex) {
  if (!DSHAgentExactDictionaryKeys(call, @[
        @"schema_version", @"call_index", @"call_id", @"name",
        @"arguments_sha256", @"safe_summary_key", @"access",
        @"approval_state",
      ]) || ![call[@"schema_version"] isEqual:@3] ||
      ![call[@"call_index"] isEqual:@(expectedIndex)] ||
      !DSHAgentOpaqueIdentifier(call[@"call_id"]) ||
      !DSHAgentBoundedUTF8String(call[@"name"], 64, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(call[@"arguments_sha256"]) ||
      !DSHAgentBoundedUTF8String(call[@"safe_summary_key"], 128, NO, nullptr)) {
    return NO;
  }
  NSString *access = call[@"access"];
  NSString *approval = call[@"approval_state"];
  BOOL durable = [access isEqualToString:@"durable_deny"];
  if (durable) {
    return [approval isEqualToString:@"durable_denied"] &&
        [call[@"safe_summary_key"] isEqualToString:@"agent.unknown"];
  }
  NSString *expectedSummary = [NSString stringWithFormat:@"agent.%@", call[@"name"]];
  return ([access isEqualToString:@"auto"] ||
          [access isEqualToString:@"conversation_confirm"] ||
          [access isEqualToString:@"confirm_once"]) &&
      [approval isEqualToString:@"deferred"] &&
      [call[@"safe_summary_key"] isEqual:expectedSummary];
}

static BOOL DSHAgentRoundV3Row(NSDictionary *row) {
  if (!DSHAgentExactDictionaryKeys(row, @[
        @"schema_version", @"locator", @"row_revision",
        @"root_fingerprint_sha256", @"binding_revision", @"request_sha256",
        @"transcript_before", @"launch_attempt", @"state", @"owner",
        @"failure_code", @"completion_receipt", @"transcript_after",
        @"calls", @"batch_class", @"executable_call_count",
        @"denied_call_count", @"terminal_kind", @"created_at", @"updated_at",
      ]) || ![row[@"schema_version"] isEqual:@3] ||
      !DSHAgentRoundLocator(row[@"locator"]) ||
      !DSHAgentSafeInteger(row[@"row_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentCanonicalSHA256(row[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(row[@"binding_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentCanonicalSHA256(row[@"request_sha256"]) ||
      !DSHAgentRoundReference(row[@"transcript_before"]) ||
      !DSHAgentSafeInteger(row[@"launch_attempt"], 8, NO) ||
      ![row[@"calls"] isKindOfClass:NSArray.class] ||
      [row[@"calls"] count] > 16 ||
      !DSHAgentSafeInteger(row[@"executable_call_count"], 16, YES) ||
      !DSHAgentSafeInteger(row[@"denied_call_count"], 16, YES) ||
      !DSHAgentCanonicalTimestamp(row[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(row[@"updated_at"])) return NO;
  NSString *state = row[@"state"];
  NSSet *states = [NSSet setWithArray:@[
    @"in_flight", @"failed_retryable", @"completed", @"cancel_requested",
    @"cancelled", @"unknown", @"ambiguous",
  ]];
  if (![states containsObject:state]) return NO;
  id owner = row[@"owner"];
  if (owner != NSNull.null &&
      (!DSHAgentRoundOwner(owner) ||
       ![owner[@"task_id"] isEqual:row[@"locator"][@"task_id"]])) return NO;
  id failure = row[@"failure_code"];
  if (failure != NSNull.null && !DSHAgentFailureCode(failure)) return NO;
  id receipt = row[@"completion_receipt"];
  if (receipt != NSNull.null && !DSHAgentCompletionReceipt(receipt, row[@"locator"])) return NO;
  id after = row[@"transcript_after"];
  if (after != NSNull.null && !DSHAgentRoundReference(after)) return NO;
  id batchClass = row[@"batch_class"];
  if (batchClass != NSNull.null &&
      ![@[ @"executable", @"mixed", @"denied_only" ] containsObject:batchClass]) return NO;
  NSUInteger executable = 0;
  NSUInteger denied = 0;
  for (NSUInteger index = 0; index < [row[@"calls"] count]; index += 1) {
    NSDictionary *call = row[@"calls"][index];
    if (!DSHAgentRoundV3Call(call, index)) return NO;
    [call[@"access"] isEqualToString:@"durable_deny"] ? denied += 1 : executable += 1;
  }
  if (executable != [row[@"executable_call_count"] unsignedIntegerValue] ||
      denied != [row[@"denied_call_count"] unsignedIntegerValue]) return NO;
  if (batchClass == NSNull.null) {
    if ([(NSArray *)row[@"calls"] count] != 0 || executable != 0 || denied != 0) return NO;
  } else if ([batchClass isEqualToString:@"executable"] &&
             (executable == 0 || denied != 0)) return NO;
  else if ([batchClass isEqualToString:@"mixed"] &&
           (executable == 0 || denied == 0)) return NO;
  else if ([batchClass isEqualToString:@"denied_only"] &&
           (executable != 0 || denied == 0)) return NO;
  id terminal = row[@"terminal_kind"];
  if (terminal != NSNull.null &&
      ![@[ @"final", @"tool_batch", @"blocked" ] containsObject:terminal]) return NO;
  if ([state isEqualToString:@"in_flight"] ||
      [state isEqualToString:@"cancel_requested"]) {
    if (owner == NSNull.null || receipt != NSNull.null || terminal != NSNull.null) return NO;
  } else if ([state isEqualToString:@"completed"]) {
    if (owner != NSNull.null || receipt == NSNull.null || after == NSNull.null ||
        terminal == NSNull.null || failure != NSNull.null) return NO;
    NSString *finish = receipt[@"finish_reason"];
    if ([finish isEqualToString:@"stop"] &&
        (![terminal isEqualToString:@"final"] || [(NSArray *)row[@"calls"] count] != 0)) return NO;
    if ([finish isEqualToString:@"tool_calls"] &&
        (![terminal isEqualToString:@"tool_batch"] || [(NSArray *)row[@"calls"] count] == 0)) return NO;
    if (([finish isEqualToString:@"length"] ||
         [finish isEqualToString:@"content_filter"]) &&
        (![terminal isEqualToString:@"blocked"] || [(NSArray *)row[@"calls"] count] != 0)) return NO;
  } else if ([state isEqualToString:@"cancelled"]) {
    if (owner != NSNull.null || receipt != NSNull.null || after == NSNull.null ||
        ![terminal isEqualToString:@"blocked"] ||
        ![failure isEqualToString:@"E_AGENT_CANCELLED"] ||
        ![after isEqual:row[@"transcript_before"]]) return NO;
  } else if ([state isEqualToString:@"failed_retryable"]) {
    if (owner != NSNull.null || receipt != NSNull.null || after != NSNull.null ||
        terminal != NSNull.null || failure == NSNull.null) return NO;
  } else if ([state isEqualToString:@"unknown"] ||
             [state isEqualToString:@"ambiguous"]) {
    if (owner != NSNull.null || receipt != NSNull.null || terminal != NSNull.null ||
        failure == NSNull.null) return NO;
    if ([state isEqualToString:@"unknown"] &&
        ![failure isEqualToString:@"E_AGENT_PERSISTENCE"]) return NO;
    if ([state isEqualToString:@"ambiguous"] &&
        ![failure isEqualToString:@"E_AGENT_ROUND_AMBIGUOUS"]) return NO;
  }
  return YES;
}

static BOOL DSHAgentRoundV3CAS(NSDictionary *cas) {
  return DSHAgentExactDictionaryKeys(cas, @[
    @"schema_version", @"locator", @"expected_row_revision", @"expected_state",
    @"expected_owner_generation", @"expected_launch_id", @"expected_native_task_id",
    @"expected_transcript_generation", @"expected_transcript_sha256",
    @"expected_root_fingerprint_sha256", @"expected_binding_revision",
  ]) && [cas[@"schema_version"] isEqual:@2] &&
      DSHAgentRoundLocator(cas[@"locator"]) &&
      DSHAgentSafeInteger(cas[@"expected_row_revision"], 9007199254740991ULL, NO) &&
      [@[ @"in_flight", @"cancel_requested", @"failed_retryable",
          @"completed", @"cancelled", @"unknown", @"ambiguous" ]
          containsObject:cas[@"expected_state"]] &&
      (cas[@"expected_owner_generation"] == NSNull.null ||
       DSHAgentSafeInteger(cas[@"expected_owner_generation"],
                           9007199254740991ULL, NO)) &&
      (cas[@"expected_launch_id"] == NSNull.null ||
       DSHAgentCanonicalUUID(cas[@"expected_launch_id"] )) &&
      (cas[@"expected_native_task_id"] == NSNull.null ||
       DSHAgentCanonicalUUID(cas[@"expected_native_task_id"] )) &&
      DSHAgentSafeInteger(cas[@"expected_transcript_generation"],
                          9007199254740991ULL, YES) &&
      DSHAgentCanonicalSHA256(cas[@"expected_transcript_sha256"]) &&
      DSHAgentCanonicalSHA256(cas[@"expected_root_fingerprint_sha256"]) &&
      DSHAgentSafeInteger(cas[@"expected_binding_revision"],
                          9007199254740991ULL, NO);
}

static BOOL DSHAgentRoundV3CASMatchesRow(NSDictionary *row, NSDictionary *cas) {
  if (!DSHAgentRoundV3CAS(cas) || ![row[@"locator"] isEqual:cas[@"locator"]] ||
      ![row[@"row_revision"] isEqual:cas[@"expected_row_revision"]] ||
      ![row[@"state"] isEqual:cas[@"expected_state"]] ||
      ![row[@"transcript_before"][@"generation"]
          isEqual:cas[@"expected_transcript_generation"]] ||
      ![row[@"transcript_before"][@"transcript_sha256"]
          isEqual:cas[@"expected_transcript_sha256"]] ||
      ![row[@"root_fingerprint_sha256"]
          isEqual:cas[@"expected_root_fingerprint_sha256"]] ||
      ![row[@"binding_revision"] isEqual:cas[@"expected_binding_revision"]]) return NO;
  id expectedOwnerGeneration = cas[@"expected_owner_generation"];
  id owner = row[@"owner"];
  if (expectedOwnerGeneration == NSNull.null) return owner == NSNull.null;
  return DSHAgentRoundOwner(owner) &&
      [owner[@"owner_generation"] isEqual:expectedOwnerGeneration] &&
      [owner[@"launch_id"] isEqual:cas[@"expected_launch_id"]] &&
      [owner[@"native_task_id"] isEqual:cas[@"expected_native_task_id"]];
}

static NSDictionary *DSHAgentRoundV3Output(NSDictionary *row,
                                           NSString *status) {
  return @{
    @"schema_version" : @3,
    @"status" : status,
    @"row" : [row copy],
  };
}

- (NSDictionary *)createAgentRoundV3WithInsertCAS:(NSDictionary *)insertCAS
                                  exactRoundStart:(NSDictionary *)round
                                             error:(NSError **)error {
  if (!DSHAgentRoundInsertCAS(insertCAS) || !DSHAgentRoundV3Row(round) ||
      ![round[@"locator"] isEqual:insertCAS[@"locator"]] ||
      ![round[@"transcript_before"][@"generation"]
          isEqual:insertCAS[@"expected_transcript_generation"]] ||
      ![round[@"transcript_before"][@"transcript_sha256"]
          isEqual:insertCAS[@"expected_transcript_sha256"]] ||
      ![round[@"root_fingerprint_sha256"]
          isEqual:insertCAS[@"expected_root_fingerprint_sha256"]] ||
      ![round[@"binding_revision"] isEqual:insertCAS[@"expected_binding_revision"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *initialOwner = round[@"owner"];
  if ((id)initialOwner == NSNull.null ||
      ![initialOwner[@"launch_id"] isEqual:self.wal.launchId] ||
      ![self.wal isNativeTaskAlive:initialOwner[@"native_task_id"]
                            launchId:initialOwner[@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    for (NSDictionary *candidate in rounds) {
      if (![candidate[@"locator"] isEqual:round[@"locator"]]) continue;
      if (![candidate isEqual:round]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      output = DSHAgentRoundV3Output(candidate, @"already_present");
      return NO;
    }
    if (rounds.count >= 128 * 8) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    [rounds addObject:[round copy]];
    [dispatch addObject:@{
      @"schema_version" : @1,
      @"kind" : @"round",
      @"locator" : round[@"locator"],
      @"dispatch_state" : @"not_dispatched",
    }];
    state[@"rounds"] = rounds;
    state[@"dispatch"] = dispatch;
    output = DSHAgentRoundV3Output(round, @"inserted");
    return YES;
  } error:error];
  return committed || output != nil ? output : nil;
}

- (NSDictionary *)claimAgentRoundV3WithLocator:(NSDictionary *)locator
                              expectedRowRevision:(NSNumber *)revision
                                             owner:(NSDictionary *)owner
                                             error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator) ||
      !DSHAgentSafeInteger(revision, 9007199254740991ULL, NO) ||
      !DSHAgentRoundOwner(owner) ||
      ![owner[@"task_id"] isEqual:locator[@"task_id"]] ||
      ![owner[@"launch_id"] isEqual:self.wal.launchId] ||
      ![self.wal isNativeTaskAlive:owner[@"native_task_id"]
                            launchId:owner[@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *row = [rounds[index] mutableCopy];
      if (![row[@"locator"] isEqual:locator]) continue;
      if (!DSHAgentRoundV3Row(row) ||
          ![row[@"row_revision"] isEqual:revision] ||
          ![row[@"state"] isEqualToString:@"failed_retryable"] ||
          row[@"owner"] != NSNull.null) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      if (![DSHAgentRoundDispatchState(state[@"dispatch"], locator)
              isEqualToString:@"not_dispatched"]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      row[@"owner"] = owner;
      row[@"state"] = @"in_flight";
      NSUInteger launchAttempt = [row[@"launch_attempt"] unsignedIntegerValue];
      if (launchAttempt >= 8) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"launch_attempt"] = @(launchAttempt + 1);
      row[@"failure_code"] = NSNull.null;
      row[@"calls"] = @[];
      row[@"batch_class"] = NSNull.null;
      row[@"executable_call_count"] = @0;
      row[@"denied_call_count"] = @0;
      row[@"terminal_kind"] = NSNull.null;
      NSUInteger rowRevision = [row[@"row_revision"] unsignedIntegerValue];
      if (rowRevision >= 9007199254740991ULL) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"row_revision"] = @(rowRevision + 1);
      row[@"updated_at"] = [self.wal currentTimestamp];
      if (!DSHAgentRoundV3Row(row)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      rounds[index] = row;
      state[@"rounds"] = rounds;
      output = DSHAgentRoundV3Output(row, @"claimed");
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)markAgentRoundV3DispatchedWithCAS:(NSDictionary *)cas
                                               error:(NSError **)error {
  if (!DSHAgentRoundV3CAS(cas)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *row = [rounds[index] mutableCopy];
      if (![row[@"locator"] isEqual:cas[@"locator"]]) continue;
      if (!DSHAgentRoundV3CASMatchesRow(row, cas) ||
          (![row[@"state"] isEqualToString:@"in_flight"] &&
           ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
          row[@"owner"] == NSNull.null ||
          ![self.wal isNativeTaskAlive:row[@"owner"][@"native_task_id"]
                                launchId:row[@"owner"][@"launch_id"]]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSMutableDictionary *marker = nil;
      NSUInteger markerIndex = NSNotFound;
      for (NSUInteger markerCursor = 0; markerCursor < dispatch.count;
           markerCursor += 1) {
        NSDictionary *candidate = dispatch[markerCursor];
        if ([candidate[@"kind"] isEqualToString:@"round"] &&
            [candidate[@"locator"] isEqual:row[@"locator"]]) {
          marker = [candidate mutableCopy];
          markerIndex = markerCursor;
          break;
        }
      }
      if (marker == nil) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      if ([marker[@"dispatch_state"] isEqualToString:@"dispatched"]) {
        output = DSHAgentRoundV3Output(row, @"already_dispatched");
        return NO;
      }
      if (![marker[@"dispatch_state"] isEqualToString:@"not_dispatched"]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      marker[@"dispatch_state"] = @"dispatched";
      NSUInteger rowRevision = [row[@"row_revision"] unsignedIntegerValue];
      if (rowRevision >= 9007199254740991ULL) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"row_revision"] = @(rowRevision + 1);
      row[@"updated_at"] = [self.wal currentTimestamp];
      dispatch[markerIndex] = marker;
      rounds[index] = row;
      if (!DSHAgentRoundV3Row(row)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      state[@"rounds"] = rounds;
      state[@"dispatch"] = dispatch;
      output = DSHAgentRoundV3Output(row, @"dispatched");
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed || output != nil ? output : nil;
}

static BOOL DSHAgentRoundV3MessagesMatchCalls(NSArray *messages,
                                              NSArray *calls,
                                              NSUInteger roundIndex,
                                              NSError **error) {
  if (![messages isKindOfClass:NSArray.class] || messages.count == 0 ||
      messages.count > 16 || ![calls isKindOfClass:NSArray.class] ||
      calls.count > 16) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSUInteger callIndex = 0;
  for (NSDictionary *message in messages) {
    if (!DSHAgentExactDictionaryKeys(message, @[
          @"schema_version", @"role", @"round_index", @"content",
          @"reasoning_content", @"tool_calls",
        ]) || ![message[@"schema_version"] isEqual:@1] ||
        ![message[@"role"] isEqualToString:@"assistant"] ||
        ![message[@"round_index"] isEqual:@(roundIndex)] ||
        !DSHAgentBoundedUTF8String(message[@"content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        !DSHAgentBoundedUTF8String(message[@"reasoning_content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        ![message[@"tool_calls"] isKindOfClass:NSArray.class] ||
        [message[@"tool_calls"] count] > 16) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    for (NSDictionary *toolCall in message[@"tool_calls"]) {
      if (!DSHAgentExactDictionaryKeys(toolCall, @[
            @"schema_version", @"call_id", @"name", @"arguments_json",
          ]) || ![toolCall[@"schema_version"] isEqual:@1] ||
          !DSHAgentOpaqueIdentifier(toolCall[@"call_id"]) ||
          !DSHAgentBoundedUTF8String(toolCall[@"name"], 64, NO, nullptr) ||
          DSHAgentParseArgumentsJSON(toolCall[@"arguments_json"], error) == nil ||
          callIndex >= calls.count) {
        if (error == nullptr || *error == nil) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
        }
        return NO;
      }
      NSDictionary *call = calls[callIndex];
      NSString *argumentsDigest = DSHAgentArgumentsSHA256(
          toolCall[@"name"], toolCall[@"arguments_json"], error);
      if (!DSHAgentRoundV3Call(call, callIndex) ||
          ![call[@"call_id"] isEqual:toolCall[@"call_id"]] ||
          ![call[@"name"] isEqual:toolCall[@"name"]] ||
          ![call[@"arguments_sha256"] isEqual:argumentsDigest]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      callIndex += 1;
    }
  }
  if (callIndex != calls.count) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

- (NSDictionary *)completeAgentRoundV3WithLocator:(NSDictionary *)locator
                                      expectedCAS:(NSDictionary *)cas
                                         messages:(NSArray *)messages
                                completionReceipt:(NSDictionary *)receipt
                                     terminalKind:(NSString *)terminalKind
                                           calls:(NSArray *)calls
                                            root:(NSDictionary *)root
                                            error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator) || !DSHAgentRoundV3CAS(cas) ||
      ![cas[@"locator"] isEqual:locator] || !DSHAgentRoundRoot(root) ||
      !DSHAgentCompletionReceipt(receipt, locator) ||
      ![@[ @"final", @"tool_batch", @"blocked" ] containsObject:terminalKind] ||
      !DSHAgentRoundV3MessagesMatchCalls(messages, calls,
                                          [locator[@"round_index"] unsignedIntegerValue],
                                          error) ||
      ([terminalKind isEqualToString:@"tool_batch"] && calls.count == 0) ||
      (![terminalKind isEqualToString:@"tool_batch"] && calls.count != 0)) {
    if (error == nullptr || *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    }
    return nil;
  }
  NSArray *immutableMessages = DSHAgentImmutableJSONCopy(messages, error);
  NSArray *immutableCalls = DSHAgentImmutableJSONCopy(calls, error);
  NSDictionary *immutableReceipt = DSHAgentImmutableJSONCopy(receipt, error);
  if (![immutableMessages isKindOfClass:NSArray.class] ||
      ![immutableCalls isKindOfClass:NSArray.class] ||
      ![immutableReceipt isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
    NSMutableDictionary *row = nil;
    NSUInteger rowIndex = NSNotFound;
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *candidate = [rounds[index] mutableCopy];
      if ([candidate[@"locator"] isEqual:locator]) {
        row = candidate;
        rowIndex = index;
        break;
      }
    }
    if (row == nil || !DSHAgentRoundV3CASMatchesRow(row, cas) ||
        (![row[@"state"] isEqualToString:@"in_flight"] &&
         ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
        ![DSHAgentRoundDispatchState(state[@"dispatch"], locator)
            isEqualToString:@"dispatched"]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSDictionary *before = row[@"transcript_before"];
    NSMutableDictionary *transcriptRow = nil;
    NSUInteger transcriptIndex = NSNotFound;
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSMutableDictionary *candidate = [transcripts[index] mutableCopy];
      if ([candidate[@"transcript_ref"] isEqual:before[@"transcript_ref"]]) {
        transcriptRow = candidate;
        transcriptIndex = index;
        break;
      }
    }
    if (transcriptRow == nil ||
        ![transcriptRow[@"state"] isEqualToString:@"open"] ||
        ![transcriptRow[@"generation"] isEqual:before[@"generation"]] ||
        ![transcriptRow[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] ||
        ![transcriptRow[@"transcript_bytes"] isEqual:before[@"transcript_bytes"]] ||
        ![transcriptRow[@"root_fingerprint_sha256"]
            isEqual:row[@"root_fingerprint_sha256"]]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSMutableArray *messageRows = [transcriptRow[@"messages"] mutableCopy];
    NSUInteger generation = [transcriptRow[@"generation"] unsignedIntegerValue];
    if (generation > 9007199254740991ULL - immutableMessages.count ||
        messageRows.count + immutableMessages.count > 1024) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    [messageRows addObjectsFromArray:immutableMessages];
    generation += immutableMessages.count;
    NSDictionary *digestInput = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcriptRow[@"transcript_ref"],
      @"attempt_id" : transcriptRow[@"attempt_id"],
      @"root_fingerprint_sha256" : transcriptRow[@"root_fingerprint_sha256"],
      @"generation" : @(generation),
      @"messages" : messageRows,
    };
    NSError *digestError = nil;
    NSData *digestBytes = DSHAgentCanonicalJSON(digestInput, &digestError);
    NSString *digest = DSHAgentHJ(@"agent-transcript", digestInput, &digestError);
    if (digestBytes == nil || digest == nil ||
        digestBytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
      DSHSetAgentNativeStoreError(mutationError,
          digestBytes != nil ? DSHAgentNativeStoreErrorCapacity
                             : DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    transcriptRow[@"messages"] = messageRows;
    transcriptRow[@"generation"] = @(generation);
    transcriptRow[@"transcript_sha256"] = digest;
    transcriptRow[@"transcript_bytes"] = @(digestBytes.length);
    transcriptRow[@"updated_at"] = [self.wal currentTimestamp];
    NSMutableDictionary *after = [@{
      @"schema_version" : @1,
      @"transcript_ref" : transcriptRow[@"transcript_ref"],
      @"generation" : @(generation),
      @"transcript_sha256" : digest,
      @"transcript_bytes" : @(digestBytes.length),
    } mutableCopy];
    NSUInteger rowRevision = [row[@"row_revision"] unsignedIntegerValue];
    if (rowRevision >= 9007199254740991ULL) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    row[@"state"] = @"completed";
    row[@"owner"] = NSNull.null;
    row[@"failure_code"] = NSNull.null;
    row[@"completion_receipt"] = immutableReceipt;
    row[@"transcript_after"] = after;
    row[@"terminal_kind"] = terminalKind;
    row[@"calls"] = immutableCalls;
    row[@"batch_class"] = calls.count == 0 ? NSNull.null :
        ([calls filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:
            ^BOOL(NSDictionary *call, NSDictionary *_) {
              return [call[@"access"] isEqualToString:@"durable_deny"];
            }]].count == 0 ? @"executable" :
         ([calls filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:
             ^BOOL(NSDictionary *call, NSDictionary *_) {
               return ![call[@"access"] isEqualToString:@"durable_deny"];
             }]].count == 0 ? @"denied_only" : @"mixed"));
    row[@"executable_call_count"] = @([[immutableCalls filteredArrayUsingPredicate:
        [NSPredicate predicateWithBlock:^BOOL(NSDictionary *call, NSDictionary *_) {
          return ![call[@"access"] isEqualToString:@"durable_deny"];
        }]] count]);
    row[@"denied_call_count"] = @([[immutableCalls filteredArrayUsingPredicate:
        [NSPredicate predicateWithBlock:^BOOL(NSDictionary *call, NSDictionary *_) {
          return [call[@"access"] isEqualToString:@"durable_deny"];
        }]] count]);
    row[@"row_revision"] = @(rowRevision + 1);
    row[@"updated_at"] = [self.wal currentTimestamp];
    if (!DSHAgentRoundV3Row(row)) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    transcripts[transcriptIndex] = transcriptRow;
    rounds[rowIndex] = row;
    state[@"transcripts"] = transcripts;
    state[@"rounds"] = rounds;
    output = @{
      @"schema_version" : @3,
      @"status" : @"completed",
      @"row" : [row copy],
      @"transcript" : [after copy],
    };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)cancelAgentRoundV3WithCAS:(NSDictionary *)cas
                                        error:(NSError **)error {
  if (!DSHAgentRoundV3CAS(cas)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *row = [rounds[index] mutableCopy];
      if (![row[@"locator"] isEqual:cas[@"locator"]]) continue;
      if (!DSHAgentRoundV3CASMatchesRow(row, cas)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSString *dispatchState = DSHAgentRoundDispatchState(
          state[@"dispatch"], row[@"locator"]);
      if (dispatchState == nil) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      if ([row[@"state"] isEqualToString:@"in_flight"]) {
        row[@"state"] = @"cancel_requested";
        row[@"updated_at"] = [self.wal currentTimestamp];
      } else if ([row[@"state"] isEqualToString:@"cancel_requested"] &&
                 [dispatchState isEqualToString:@"not_dispatched"]) {
        row[@"state"] = @"cancelled";
        row[@"owner"] = NSNull.null;
        row[@"failure_code"] = @"E_AGENT_CANCELLED";
        row[@"completion_receipt"] = NSNull.null;
        row[@"transcript_after"] = row[@"transcript_before"];
        row[@"terminal_kind"] = @"blocked";
        row[@"calls"] = @[];
        row[@"batch_class"] = NSNull.null;
        row[@"executable_call_count"] = @0;
        row[@"denied_call_count"] = @0;
        row[@"updated_at"] = [self.wal currentTimestamp];
      } else {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
      if (revision >= 9007199254740991ULL) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"row_revision"] = @(revision + 1);
      if (!DSHAgentRoundV3Row(row)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      rounds[index] = row;
      state[@"rounds"] = rounds;
      output = DSHAgentRoundV3Output(row,
          [row[@"state"] isEqualToString:@"cancelled"] ? @"cancelled" :
                                                           @"cancel_requested");
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)reconcileAgentRoundV3OwnerLossWithLocator:(NSDictionary *)locator
                                                 expectedCAS:(NSDictionary *)cas
                                                        error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator) || !DSHAgentRoundV3CAS(cas) ||
      ![locator isEqual:cas[@"locator"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    for (NSUInteger index = 0; index < rounds.count; index += 1) {
      NSMutableDictionary *row = [rounds[index] mutableCopy];
      if (![row[@"locator"] isEqual:locator]) continue;
      if (!DSHAgentRoundV3CASMatchesRow(row, cas) ||
          (![row[@"state"] isEqualToString:@"in_flight"] &&
           ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
          row[@"owner"] == NSNull.null ||
          [self.wal isNativeTaskAlive:row[@"owner"][@"native_task_id"]
                                launchId:row[@"owner"][@"launch_id"]]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSString *dispatchState = DSHAgentRoundDispatchState(
          state[@"dispatch"], locator);
      if (dispatchState == nil) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      BOOL cancelBeforeDispatch =
          [row[@"state"] isEqualToString:@"cancel_requested"] &&
          [dispatchState isEqualToString:@"not_dispatched"];
      row[@"state"] = cancelBeforeDispatch ? @"cancelled" :
          ([dispatchState isEqualToString:@"not_dispatched"]
               ? @"failed_retryable" : @"ambiguous");
      row[@"owner"] = NSNull.null;
      row[@"failure_code"] = cancelBeforeDispatch
          ? @"E_AGENT_CANCELLED"
          : ([dispatchState isEqualToString:@"not_dispatched"]
                 ? @"E_AGENT_PERSISTENCE" : @"E_AGENT_ROUND_AMBIGUOUS");
      row[@"completion_receipt"] = NSNull.null;
      row[@"transcript_after"] = cancelBeforeDispatch
          ? row[@"transcript_before"] : NSNull.null;
      row[@"terminal_kind"] = cancelBeforeDispatch ? @"blocked" : NSNull.null;
      if (cancelBeforeDispatch) {
        row[@"calls"] = @[];
        row[@"batch_class"] = NSNull.null;
        row[@"executable_call_count"] = @0;
        row[@"denied_call_count"] = @0;
      }
      NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
      if (revision >= 9007199254740991ULL) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"row_revision"] = @(revision + 1);
      row[@"updated_at"] = [self.wal currentTimestamp];
      if (!DSHAgentRoundV3Row(row)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      rounds[index] = row;
      state[@"rounds"] = rounds;
      output = DSHAgentRoundV3Output(row, row[@"state"]);
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)queryAgentRoundV3WithLocator:(NSDictionary *)locator
                                          error:(NSError **)error {
  if (!DSHAgentRoundLocator(locator)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  for (NSDictionary *row in state[@"rounds"]) {
    if ([row[@"locator"] isEqual:locator]) {
      return DSHAgentRoundV3Output(row, row[@"state"]);
    }
  }
  return @{ @"schema_version" : @3, @"status" : @"not_started" };
}

@end
