#import "AgentExecutionLedger.h"

#include <math.h>

static const unsigned long long DSHAgentMaximumSafeInteger = 9007199254740991ULL;

static NSArray<NSString *> *DSHAgentLedgerLocatorKeys(void) {
  return @[
    @"schema_version", @"task_id", @"attempt_id", @"round_id",
    @"round_index", @"call_index", @"call_id", @"idempotency_key",
  ];
}

static NSArray<NSString *> *DSHAgentLedgerKeys(void) {
  return @[
    @"schema_version", @"locator", @"row_revision",
    @"root_fingerprint_sha256", @"binding_revision", @"transcript_before",
    @"name", @"arguments_sha256", @"precondition", @"reserved_write_bytes",
    @"state", @"owner", @"settled_facts", @"transcript_after", @"receipt",
    @"created_at", @"updated_at",
  ];
}

static NSArray<NSString *> *DSHAgentLedgerCASKeys(void) {
  return @[
    @"schema_version", @"locator", @"expected_row_revision",
    @"expected_state", @"expected_owner_generation", @"expected_launch_id",
    @"expected_native_task_id", @"expected_transcript_generation",
    @"expected_transcript_sha256", @"expected_root_fingerprint_sha256",
    @"expected_binding_revision",
  ];
}

static NSArray<NSString *> *DSHAgentLedgerReferenceKeys(void) {
  return @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ];
}

static NSString *DSHAgentLedgerDispatchState(NSArray *dispatchRows,
                                             NSDictionary *locator) {
  for (NSDictionary *entry in dispatchRows) {
    if ([entry[@"kind"] isEqualToString:@"execution"] &&
        [entry[@"locator"] isEqual:locator]) {
      return entry[@"dispatch_state"];
    }
  }
  return nil;
}

static NSData *DSHAgentCanonicalIdentityKey(id value) {
  NSError *canonicalError = nil;
  return DSHAgentCanonicalJSON(value, &canonicalError);
}

static BOOL DSHAgentLedgerReference(NSDictionary *reference) {
  if (![reference isKindOfClass:NSDictionary.class]) return NO;
  return DSHAgentExactDictionaryKeys(reference, DSHAgentLedgerReferenceKeys()) &&
      DSHAgentSafeInteger(reference[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(reference[@"transcript_ref"]) &&
      DSHAgentSafeInteger(reference[@"generation"], 9007199254740991ULL, YES) &&
      DSHAgentCanonicalSHA256(reference[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(reference[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

static BOOL DSHAgentLedgerRootExpectation(NSDictionary *root) {
  return DSHAgentExactDictionaryKeys(root, @[
    @"schema_version", @"root_fingerprint_sha256", @"binding_revision",
  ]) && DSHAgentSafeInteger(root[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) &&
      DSHAgentSafeInteger(root[@"binding_revision"], 9007199254740991ULL, NO);
}

static BOOL DSHAgentLedgerRootFull(NSDictionary *root) {
  if (!DSHAgentExactDictionaryKeys(root, @[
        @"schema_version", @"kind", @"workspace_id",
        @"workspace_binding_revision", @"project_id",
        @"root_fingerprint_sha256", @"capabilities",
      ]) || !DSHAgentSafeInteger(root[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(root[@"workspace_id"]) ||
      !DSHAgentSafeInteger(root[@"workspace_binding_revision"],
                          9007199254740991ULL, NO) ||
      !DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) ||
      ![root[@"capabilities"] isKindOfClass:NSArray.class] ||
      [(NSArray *)root[@"capabilities"] count] > 6) return NO;
  NSString *kind = root[@"kind"];
  if (![kind isKindOfClass:NSString.class]) return NO;
  id project = root[@"project_id"];
  if (![kind isEqualToString:@"project"] && ![kind isEqualToString:@"workspace"]) return NO;
  if (project != NSNull.null && !DSHAgentCanonicalUUID(project)) return NO;
  if ([kind isEqualToString:@"project"] && project == NSNull.null) return NO;
  if ([kind isEqualToString:@"workspace"] && project != NSNull.null) return NO;
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push", @"guest_service",
  ]];
  NSMutableSet *seen = [NSMutableSet set];
  for (id capability in root[@"capabilities"]) {
    if (![capability isKindOfClass:NSString.class] ||
        ![allowed containsObject:capability] || [seen containsObject:capability]) return NO;
    if ([kind isEqualToString:@"workspace"] && [capability hasPrefix:@"git_"]) return NO;
    [seen addObject:capability];
  }
  return YES;
}

static BOOL DSHAgentLedgerLocator(NSDictionary *locator) {
  if (!DSHAgentExactDictionaryKeys(locator, DSHAgentLedgerLocatorKeys()) ||
      ![locator[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(locator[@"task_id"]) ||
      !DSHAgentCanonicalUUID(locator[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(locator[@"round_id"]) ||
      !DSHAgentSafeInteger(locator[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(locator[@"call_index"], 15, YES) ||
      !DSHAgentBoundedUTF8String(locator[@"call_id"], 128, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(locator[@"idempotency_key"])) {
    return NO;
  }
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  return [locator[@"call_id"] rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHAgentToolName(NSString *name) {
  if (!DSHAgentBoundedUTF8String(name, 64, NO, nullptr)) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
      invertedSet];
  return [name rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHAgentLedgerOwner(NSDictionary *owner) {
  return DSHAgentExactDictionaryKeys(owner, @[
    @"schema_version", @"task_id", @"launch_id", @"native_task_id",
    @"owner_generation", @"heartbeat_at",
  ]) && DSHAgentSafeInteger(owner[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(owner[@"task_id"]) &&
      DSHAgentCanonicalUUID(owner[@"launch_id"]) &&
      DSHAgentCanonicalUUID(owner[@"native_task_id"]) &&
      DSHAgentSafeInteger(owner[@"owner_generation"], 9007199254740991ULL, NO) &&
      DSHAgentCanonicalTimestamp(owner[@"heartbeat_at"]);
}

static BOOL DSHAgentLedgerCAS(NSDictionary *cas) {
  return DSHAgentExactDictionaryKeys(cas, DSHAgentLedgerCASKeys()) &&
      [cas[@"schema_version"] isEqual:@2] &&
      DSHAgentLedgerLocator(cas[@"locator"]) &&
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

static BOOL DSHAgentLedgerInsertCAS(NSDictionary *cas) {
  return DSHAgentExactDictionaryKeys(cas, @[
    @"schema_version", @"locator", @"expected_absent",
    @"expected_transcript_generation", @"expected_transcript_sha256",
    @"expected_root_fingerprint_sha256", @"expected_binding_revision",
  ]) && DSHAgentSafeInteger(cas[@"schema_version"], 1, NO) &&
      DSHAgentLedgerLocator(cas[@"locator"]) &&
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

static BOOL DSHAgentReceipt(NSDictionary *receipt) {
  if (!DSHAgentExactDictionaryKeys(receipt, @[
        @"schema_version", @"call_id", @"name", @"arguments_sha256",
        @"result_sha256", @"result_bytes", @"truncated", @"duration_ms",
        @"outcome", @"failure_code", @"approval_reference",
      ]) ||
      !DSHAgentSafeInteger(receipt[@"schema_version"], 1, NO) ||
      !DSHAgentBoundedUTF8String(receipt[@"call_id"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(receipt[@"name"], 64, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(receipt[@"arguments_sha256"]) ||
      !DSHAgentCanonicalSHA256(receipt[@"result_sha256"]) ||
      !DSHAgentSafeInteger(receipt[@"result_bytes"], 32 * 1024 * 1024, YES) ||
      !DSHAgentSafeInteger(receipt[@"duration_ms"], 24 * 60 * 60 * 1000, YES) ||
      ![receipt[@"truncated"] isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)receipt[@"truncated"]) != CFBooleanGetTypeID()) {
    return NO;
  }
  NSString *outcome = receipt[@"outcome"];
  if (![outcome isKindOfClass:NSString.class]) return NO;
  if (![outcome isEqualToString:@"ok"] && ![outcome isEqualToString:@"failed"] &&
      ![outcome isEqualToString:@"denied"] &&
      ![outcome isEqualToString:@"cancelled"] &&
      ![outcome isEqualToString:@"ambiguous"]) {
    return NO;
  }
  id failure = receipt[@"failure_code"];
  id approval = receipt[@"approval_reference"];
  if (!(failure == NSNull.null || DSHAgentFailureCode(failure)) ||
      !(approval == NSNull.null ||
        DSHAgentBoundedUTF8String(approval, 256, NO, nullptr))) return NO;
  if ([outcome isEqualToString:@"ok"] && failure != NSNull.null) return NO;
  if (![outcome isEqualToString:@"ok"] && failure == NSNull.null) return NO;
  return YES;
}

static NSData *DSHAgentCanonicalFeedbackBytes(NSDictionary *message) {
  if (!DSHAgentExactDictionaryKeys(message, @[
        @"schema_version", @"role", @"round_index", @"call_id",
        @"content", @"truncated",
      ]) || !DSHAgentSafeInteger(message[@"schema_version"], 1, NO) ||
      ![message[@"role"] isKindOfClass:NSString.class] ||
      ![message[@"role"] isEqualToString:@"tool"] ||
      !DSHAgentSafeInteger(message[@"round_index"], 7, YES) ||
      !DSHAgentBoundedUTF8String(message[@"call_id"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(message[@"content"],
                                DSHAgentNativeWALMaxTranscriptBytes, YES,
                                nullptr) ||
      ![message[@"truncated"] isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)message[@"truncated"]) != CFBooleanGetTypeID()) {
    return nil;
  }
  NSData *bytes = [message[@"content"] dataUsingEncoding:NSUTF8StringEncoding];
  NSError *decodeError = nil;
  id object = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:&decodeError];
  NSData *canonical = DSHAgentCanonicalJSON(object, &decodeError);
  return canonical != nil && [canonical isEqualToData:bytes] ? bytes : nil;
}

static BOOL DSHAgentWritePrior(id prior) {
  if (![prior isKindOfClass:NSDictionary.class]) return NO;
  NSString *kind = prior[@"kind"];
  if (![kind isKindOfClass:NSString.class]) return NO;
  if ([kind isEqualToString:@"absent"]) {
    return DSHAgentExactDictionaryKeys(prior, @[@"schema_version", @"kind"]) &&
        DSHAgentSafeInteger(prior[@"schema_version"], 1, NO);
  }
  if ([kind isEqualToString:@"known"]) {
    return DSHAgentExactDictionaryKeys(prior, @[
      @"schema_version", @"kind", @"revision",
    ]) && DSHAgentSafeInteger(prior[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(prior[@"revision"], 256, NO, nullptr);
  }
  if ([kind isEqualToString:@"unknown"]) {
    return DSHAgentExactDictionaryKeys(prior, @[
      @"schema_version", @"kind", @"failure_code",
    ]) && DSHAgentSafeInteger(prior[@"schema_version"], 1, NO) &&
        DSHAgentFailureCode(prior[@"failure_code"]);
  }
  return NO;
}

static BOOL DSHAgentRelativePathArgument(NSString *path,
                                         BOOL allowEmpty,
                                         NSData **pathBytes) {
  if (!DSHAgentBoundedUTF8String(path, 512, allowEmpty, nullptr)) return NO;
  if ([path hasPrefix:@"/"] || [path containsString:@"\\"] ||
      [path rangeOfString:@"\0"].location != NSNotFound ||
      ![path isEqualToString:path.precomposedStringWithCanonicalMapping]) return NO;
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if ([component isEqualToString:@".."] ||
        (component.length == 0 && !(allowEmpty && path.length == 0))) return NO;
  }
  NSData *bytes = [path dataUsingEncoding:NSUTF8StringEncoding];
  if (bytes == nil) return NO;
  if (pathBytes != nullptr) *pathBytes = bytes;
  return YES;
}

/// Recomputes operation-specific bytes from the native-only raw arguments.
/// The row carries only digests, so this check is the last place where write
/// content/message bytes are admitted; React Native never receives them.
static BOOL DSHAgentRawArgumentsBindIntent(NSString *argumentsJSON,
                                           NSDictionary *intent,
                                           NSError **error) {
  if (![intent isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSDictionary *arguments = DSHAgentParseArgumentsJSON(argumentsJSON, error);
  if (arguments == nil) return NO;
  NSString *name = intent[@"name"];
  NSDictionary *precondition = intent[@"precondition"];
  if (![name isKindOfClass:NSString.class] ||
      ![precondition isKindOfClass:NSDictionary.class] ||
      ![precondition[@"kind"] isKindOfClass:NSString.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if ([name isEqualToString:@"write_file"]) {
    if ((!DSHAgentExactDictionaryKeys(arguments,
                                      @[@"path", @"content", @"expected_revision"]) &&
         !DSHAgentExactDictionaryKeys(arguments,
                                      @[@"path", @"content", @"expected_prior"])) ||
        ![precondition[@"kind"] isEqualToString:@"write_file"] ||
        ![arguments[@"content"] isKindOfClass:NSString.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSData *pathBytes = nil;
    NSData *contentBytes = [arguments[@"content"]
        dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *argumentPrior = nil;
    if (arguments[@"expected_revision"] != nil) {
      id revision = arguments[@"expected_revision"];
      if (revision == NSNull.null) {
        argumentPrior = @{@"schema_version": @1, @"kind": @"absent"};
      } else if (DSHAgentBoundedUTF8String(revision, 256, NO, nullptr)) {
        argumentPrior = @{@"schema_version": @1, @"kind": @"known",
                          @"revision": revision};
      } else {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
    } else {
      argumentPrior = arguments[@"expected_prior"];
      if (!DSHAgentWritePrior(argumentPrior)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
    }
    if (!DSHAgentRelativePathArgument(arguments[@"path"], NO, &pathBytes) ||
        contentBytes == nil || contentBytes.length > DSHAgentNativeWALMaxSingleWriteBytes) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSError *digestError = nil;
    NSString *pathDigest = DSHAgentHB(@"relative-path", pathBytes, &digestError);
    NSString *contentDigest = DSHAgentHB(@"file-content", contentBytes, &digestError);
    if (pathDigest == nil || contentDigest == nil ||
        ![pathDigest isEqual:precondition[@"relative_path_sha256"]] ||
        ![contentDigest isEqual:precondition[@"content_sha256"]] ||
        ![precondition[@"content_bytes"] isEqual:@(contentBytes.length)] ||
        ![argumentPrior isEqual:precondition[@"prior"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    return YES;
  }
  if ([name isEqualToString:@"start_guest_cgi"] || [name isEqualToString:@"stop_guest_cgi"]) {
    NSMutableDictionary *expected = [arguments mutableCopy];
    expected[@"schema_version"] = @1; expected[@"kind"] = name;
    if (![expected isEqual:precondition]) { DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict); return NO; }
    return YES;
  }
  if ([name isEqualToString:@"git_commit"]) {
    if (!DSHAgentExactDictionaryKeys(arguments, @[@"message"]) ||
        ![precondition[@"kind"] isEqualToString:@"git_commit"] ||
        ![arguments[@"message"] isKindOfClass:NSString.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSData *messageBytes = [arguments[@"message"]
        dataUsingEncoding:NSUTF8StringEncoding];
    if (messageBytes == nil || messageBytes.length == 0 || messageBytes.length > 500) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSError *digestError = nil;
    NSString *messageDigest = DSHAgentHB(@"commit-message", messageBytes,
                                         &digestError);
    if (messageDigest == nil ||
        ![messageDigest isEqual:precondition[@"message_sha256"]] ||
        ![precondition[@"message_bytes"] isEqual:@(messageBytes.length)]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    return YES;
  }
  if ([name isEqualToString:@"read_file"]) {
    if (!DSHAgentExactDictionaryKeys(arguments, @[@"path"]) ||
        !DSHAgentRelativePathArgument(arguments[@"path"], NO, nullptr)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
  } else if ([name isEqualToString:@"list_dir"]) {
    NSString *path = arguments.count == 0 ? @"" : arguments[@"path"];
    if ((arguments.count != 0 &&
         !DSHAgentExactDictionaryKeys(arguments, @[@"path"])) ||
        !DSHAgentRelativePathArgument(path, YES, nullptr)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
  } else if ([name isEqualToString:@"git_push"]) {
    if (arguments.count != 0 ||
        ![precondition[@"kind"] isEqualToString:@"git_push"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
  } else if ([name isEqualToString:@"git_status"]) {
    if (arguments.count != 0 ||
        ![precondition[@"kind"] isEqualToString:@"git_status"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
  }
  return YES;
}

static BOOL DSHAgentGitIdentity(NSDictionary *identity) {
  return DSHAgentExactDictionaryKeys(identity, @[
    @"schema_version", @"name", @"email", @"timestamp_seconds",
    @"timezone_offset",
  ]) && DSHAgentSafeInteger(identity[@"schema_version"], 1, NO) &&
      [identity[@"name"] isEqualToString:@"Rish Agent"] &&
      [identity[@"email"] isEqualToString:@"agent@rish.local"] &&
      DSHAgentSafeInteger(identity[@"timestamp_seconds"],
                          9007199254740991ULL, YES) &&
      DSHAgentBoundedUTF8String(identity[@"timezone_offset"], 5, NO, nullptr) &&
      [identity[@"timezone_offset"] rangeOfString:
          @"^[+-][0-9]{4}$" options:NSRegularExpressionSearch].location != NSNotFound;
}

static BOOL DSHAgentHexObjectId(id value, NSUInteger length) {
  if (![value isKindOfClass:NSString.class] || ((NSString *)value).length != length) {
    return NO;
  }
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  return [((NSString *)value) rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHAgentPrecondition(NSDictionary *precondition) {
  if (![precondition isKindOfClass:NSDictionary.class]) return NO;
  NSString *kind = precondition[@"kind"];
  if (![kind isKindOfClass:NSString.class]) return NO;
  if ([kind isEqualToString:@"read_file"]) {
    return DSHAgentExactDictionaryKeys(precondition, @[
      @"schema_version", @"kind", @"source_revision",
    ]) && DSHAgentSafeInteger(precondition[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(precondition[@"source_revision"], 256, NO, nullptr);
  }
  if ([kind isEqualToString:@"list_dir"]) {
    return DSHAgentExactDictionaryKeys(precondition, @[
      @"schema_version", @"kind", @"directory_fingerprint_sha256",
    ]) && DSHAgentSafeInteger(precondition[@"schema_version"], 1, NO) &&
        DSHAgentCanonicalSHA256(precondition[@"directory_fingerprint_sha256"]);
  }
  if ([kind isEqualToString:@"write_file"]) {
    return DSHAgentExactDictionaryKeys(precondition, @[
      @"schema_version", @"kind", @"relative_path_sha256", @"prior",
      @"content_sha256", @"content_bytes",
    ]) && [precondition[@"schema_version"] isEqual:@2] &&
        DSHAgentCanonicalSHA256(precondition[@"relative_path_sha256"]) &&
        DSHAgentWritePrior(precondition[@"prior"]) &&
        DSHAgentCanonicalSHA256(precondition[@"content_sha256"]) &&
        DSHAgentSafeInteger(precondition[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES);
  }
  if ([kind isEqualToString:@"git_commit"]) {
    NSArray *keys = @[
      @"schema_version", @"kind", @"object_format", @"pre_head_oid",
      @"ordered_parent_oids", @"staged_index_sha256", @"tree_oid", @"author",
      @"committer", @"message_blob_ref", @"message_sha256", @"message_bytes",
      @"encoding_header", @"signature_policy", @"extra_headers", @"stage_all",
      @"commit_payload_sha256", @"expected_commit_oid",
    ];
    if (!DSHAgentExactDictionaryKeys(precondition, keys) ||
        ![precondition[@"schema_version"] isEqual:@2] ||
        (![precondition[@"object_format"] isEqualToString:@"sha1"] &&
         ![precondition[@"object_format"] isEqualToString:@"sha256"]) ||
        !(precondition[@"pre_head_oid"] == NSNull.null ||
          DSHAgentBoundedUTF8String(precondition[@"pre_head_oid"], 128, NO, nullptr)) ||
        ![precondition[@"ordered_parent_oids"] isKindOfClass:NSArray.class] ||
        [(NSArray *)precondition[@"ordered_parent_oids"] count] > 1 ||
        !DSHAgentCanonicalSHA256(precondition[@"staged_index_sha256"]) ||
        ![precondition[@"author"] isKindOfClass:NSDictionary.class] ||
        ![precondition[@"committer"] isKindOfClass:NSDictionary.class] ||
        !DSHAgentGitIdentity(precondition[@"author"]) ||
        !DSHAgentGitIdentity(precondition[@"committer"]) ||
        !DSHAgentBoundedUTF8String(precondition[@"message_blob_ref"], 256, NO, nullptr) ||
        !DSHAgentCanonicalSHA256(precondition[@"message_sha256"]) ||
        !DSHAgentSafeInteger(precondition[@"message_bytes"], 500, NO) ||
        !(precondition[@"encoding_header"] == NSNull.null ||
          [precondition[@"encoding_header"] isEqualToString:@"UTF-8"]) ||
        ![precondition[@"signature_policy"] isEqualToString:@"unsigned"] ||
        ![precondition[@"extra_headers"] isKindOfClass:NSArray.class] ||
        [(NSArray *)precondition[@"extra_headers"] count] != 0 ||
        ![precondition[@"stage_all"] isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)precondition[@"stage_all"]) != CFBooleanGetTypeID() ||
        ![precondition[@"stage_all"] boolValue] ||
        !DSHAgentCanonicalSHA256(precondition[@"commit_payload_sha256"]) ||
        !DSHAgentBoundedUTF8String(precondition[@"expected_commit_oid"], 128, NO, nullptr)) {
      return NO;
    }
    NSUInteger oidLength = [precondition[@"object_format"] isEqualToString:@"sha1"] ? 40 : 64;
    NSArray *parents = precondition[@"ordered_parent_oids"];
    for (id parent in parents) {
      if (!DSHAgentHexObjectId(parent, oidLength)) return NO;
    }
    id preHead = precondition[@"pre_head_oid"];
    if (preHead == NSNull.null) {
      if (parents.count != 0) return NO;
    } else if (!DSHAgentHexObjectId(preHead, oidLength) ||
               parents.count != 1 || ![parents[0] isEqual:preHead]) {
      return NO;
    }
    return DSHAgentHexObjectId(precondition[@"tree_oid"], oidLength) &&
        DSHAgentHexObjectId(precondition[@"expected_commit_oid"], oidLength);
  }
  if ([kind isEqualToString:@"git_push"]) {
    return DSHAgentExactDictionaryKeys(precondition, @[
      @"schema_version", @"kind", @"remote", @"remote_ref",
      @"pre_remote_oid", @"target_oid",
    ]) && DSHAgentSafeInteger(precondition[@"schema_version"], 1, NO) &&
        [precondition[@"remote"] isEqualToString:@"origin"] &&
        DSHAgentBoundedUTF8String(precondition[@"remote_ref"], 256, NO, nullptr) &&
        (precondition[@"pre_remote_oid"] == NSNull.null ||
         DSHAgentBoundedUTF8String(precondition[@"pre_remote_oid"], 128, NO, nullptr)) &&
        DSHAgentBoundedUTF8String(precondition[@"target_oid"], 128, NO, nullptr);
  }
  if ([kind isEqualToString:@"git_status"]) {
    return DSHAgentExactDictionaryKeys(precondition, @[
      @"schema_version", @"kind", @"head_oid",
    ]) && DSHAgentSafeInteger(precondition[@"schema_version"], 1, NO) &&
        (precondition[@"head_oid"] == NSNull.null ||
         DSHAgentBoundedUTF8String(precondition[@"head_oid"], 128, NO, nullptr));
  }
  if ([kind isEqualToString:@"start_guest_cgi"]) {
    NSArray *keys = @[@"schema_version", @"kind", @"index_path", @"index_sha256", @"backend_path", @"backend_sha256", @"initial_data_path", @"initial_data_sha256"];
    return DSHAgentExactDictionaryKeys(precondition, keys) && [precondition[@"schema_version"] isEqual:@1] &&
      DSHAgentBoundedUTF8String(precondition[@"index_path"], 1024, NO, nullptr) && DSHAgentCanonicalSHA256(precondition[@"index_sha256"]) &&
      DSHAgentBoundedUTF8String(precondition[@"backend_path"], 1024, NO, nullptr) && DSHAgentCanonicalSHA256(precondition[@"backend_sha256"]) &&
      ((precondition[@"initial_data_path"] == NSNull.null && precondition[@"initial_data_sha256"] == NSNull.null) ||
       (DSHAgentBoundedUTF8String(precondition[@"initial_data_path"], 1024, NO, nullptr) && DSHAgentCanonicalSHA256(precondition[@"initial_data_sha256"])));
  }
  if ([kind isEqualToString:@"stop_guest_cgi"]) {
    return DSHAgentExactDictionaryKeys(precondition, @[@"schema_version", @"kind", @"service_id"]) && [precondition[@"schema_version"] isEqual:@1] && DSHAgentCanonicalUUID(precondition[@"service_id"]);
  }
  return NO;
}

static BOOL DSHAgentSettledFacts(NSDictionary *facts) {
  if (![facts isKindOfClass:NSDictionary.class]) return NO;
  NSString *kind = facts[@"kind"];
  if (![kind isKindOfClass:NSString.class]) return NO;
  if ([kind isEqualToString:@"start_guest_cgi"] || [kind isEqualToString:@"stop_guest_cgi"]) {
    return DSHAgentExactDictionaryKeys(facts, @[@"schema_version", @"kind", @"service_id", @"status"]) && [facts[@"schema_version"] isEqual:@1] && DSHAgentCanonicalUUID(facts[@"service_id"]) && [facts[@"status"] isEqual:([kind isEqual:@"start_guest_cgi"] ? @"running" : @"stopped")];
  }
  if ([kind isEqualToString:@"read_file"]) {
    return DSHAgentExactDictionaryKeys(facts, @[
      @"schema_version", @"kind", @"source_revision",
    ]) && DSHAgentSafeInteger(facts[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(facts[@"source_revision"], 256, NO, nullptr);
  }
  if ([kind isEqualToString:@"list_dir"]) {
    return DSHAgentExactDictionaryKeys(facts, @[
      @"schema_version", @"kind", @"directory_fingerprint_sha256",
    ]) && DSHAgentSafeInteger(facts[@"schema_version"], 1, NO) &&
        DSHAgentCanonicalSHA256(facts[@"directory_fingerprint_sha256"]);
  }
  if ([kind isEqualToString:@"write_file"]) {
    return DSHAgentExactDictionaryKeys(facts, @[
      @"schema_version", @"kind", @"actual_revision", @"content_sha256",
    ]) && DSHAgentSafeInteger(facts[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(facts[@"actual_revision"], 256, NO, nullptr) &&
        DSHAgentCanonicalSHA256(facts[@"content_sha256"]);
  }
  if ([kind isEqualToString:@"git_commit"]) {
    return DSHAgentExactDictionaryKeys(facts, @[
      @"schema_version", @"kind", @"actual_commit_oid",
    ]) && DSHAgentSafeInteger(facts[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(facts[@"actual_commit_oid"], 128, NO, nullptr);
  }
  if ([kind isEqualToString:@"git_push"]) {
    return DSHAgentExactDictionaryKeys(facts, @[
      @"schema_version", @"kind", @"actual_remote_oid",
    ]) && DSHAgentSafeInteger(facts[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(facts[@"actual_remote_oid"], 128, NO, nullptr);
  }
  if ([kind isEqualToString:@"git_status"]) {
    return DSHAgentExactDictionaryKeys(facts, @[
      @"schema_version", @"kind", @"head_oid",
    ]) && DSHAgentSafeInteger(facts[@"schema_version"], 1, NO) &&
        (facts[@"head_oid"] == NSNull.null ||
         DSHAgentBoundedUTF8String(facts[@"head_oid"], 128, NO, nullptr));
  }
  return NO;
}

static BOOL DSHAgentSettledFactsMatchFeedback(NSDictionary *row,
                                              NSDictionary *feedback,
                                              NSDictionary *facts) {
  NSString *outcome = feedback[@"outcome"];
  if (![outcome isEqualToString:@"ok"]) return (id)facts == NSNull.null;
  if ((id)facts == NSNull.null) return NO;
  NSDictionary *payload = feedback[@"payload"];
  NSString *kind = row[@"precondition"][@"kind"];
  if ([kind isEqualToString:@"read_file"] &&
      [row[@"name"] isEqualToString:@"read_file"]) {
    return [facts[@"source_revision"] isEqual:payload[@"revision"]];
  }
  if ([kind isEqualToString:@"write_file"] &&
      [row[@"name"] isEqualToString:@"write_file"]) {
    return [facts[@"actual_revision"] isEqual:payload[@"revision"]] &&
        [payload[@"bytes"] isEqual:row[@"precondition"][@"content_bytes"]];
  }
  if ([kind isEqualToString:@"git_commit"] &&
      [row[@"name"] isEqualToString:@"git_commit"]) {
    return [facts[@"actual_commit_oid"] isEqual:payload[@"commit_oid"]] &&
        [payload[@"tree_oid"] isEqual:row[@"precondition"][@"tree_oid"]];
  }
  if ([kind isEqualToString:@"git_push"] &&
      [row[@"name"] isEqualToString:@"git_push"]) {
    return [facts[@"actual_remote_oid"] isEqual:payload[@"pushed_oid"]] &&
        [payload[@"remote_ref"] isEqual:row[@"precondition"][@"remote_ref"]];
  }
  if ([kind isEqualToString:@"git_status"] &&
      [row[@"name"] isEqualToString:@"git_status"]) {
    return [facts[@"head_oid"] isEqual:payload[@"head_oid"]];
  }
  if ([kind isEqualToString:@"start_guest_cgi"] || [kind isEqualToString:@"stop_guest_cgi"]) {
    return [facts[@"service_id"] isEqual:payload[@"service_id"]] && [facts[@"status"] isEqual:payload[@"status"]];
  }
  // list_dir's feedback intentionally carries bounded entries rather than a
  // second directory fingerprint.  Its exact precondition/facts relation is
  // enforced by DSHAgentLedgerRow above.
  return YES;
}

/// Exact safe approval-preview shape carried by the public batch call
/// projection.  Paths are workspace-relative, validated strings (never
/// absolute, never content); the diff preview is a bounded text blob computed
/// natively from the prepared intent.
static BOOL DSHAgentApprovalPreview(NSDictionary *preview) {
  if (!(DSHAgentExactDictionaryKeys(preview, @[
        @"schema_version", @"kind", @"paths", @"content_bytes", @"prior",
        @"diff_preview", @"diff_truncated",
      ]) && [preview[@"schema_version"] isEqual:@1] &&
      [@[ @"list_dir", @"read_file", @"write_file", @"git_commit",
          @"git_push", @"start_guest_cgi", @"stop_guest_cgi" ] containsObject:preview[@"kind"]] &&
      [preview[@"paths"] isKindOfClass:NSArray.class] &&
      [(NSArray *)preview[@"paths"] count] <= 8 &&
      [preview[@"diff_truncated"] isKindOfClass:NSNumber.class] &&
      CFGetTypeID((__bridge CFTypeRef)preview[@"diff_truncated"]) ==
          CFBooleanGetTypeID())) return NO;
  for (NSString *path in preview[@"paths"]) {
    NSData *bytes = [path dataUsingEncoding:NSUTF8StringEncoding];
    if (![path isKindOfClass:NSString.class] || bytes == nil ||
        bytes.length == 0 || bytes.length > 512 || [path hasPrefix:@"/"] ||
        [path containsString:@"\\"] ||
        [path rangeOfString:@"\0"].location != NSNotFound ||
        [path rangeOfCharacterFromSet:
            NSCharacterSet.controlCharacterSet].location != NSNotFound) return NO;
  }
  if (!(preview[@"content_bytes"] == NSNull.null ||
        DSHAgentSafeInteger(preview[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES))) return NO;
  if (!(preview[@"prior"] == NSNull.null ||
        ([preview[@"prior"] isKindOfClass:NSDictionary.class] &&
         DSHAgentExactDictionaryKeys(preview[@"prior"], @[
           @"schema_version", @"kind", @"bytes",
         ]) && [preview[@"prior"][@"schema_version"] isEqual:@1] &&
         ([preview[@"prior"][@"kind"] isEqualToString:@"absent"] ||
          [preview[@"prior"][@"kind"] isEqualToString:@"known"]) &&
         (preview[@"prior"][@"bytes"] == NSNull.null ||
          DSHAgentSafeInteger(preview[@"prior"][@"bytes"],
                              DSHAgentNativeWALMaxSingleWriteBytes * 2, YES))))) return NO;
  if (!(preview[@"diff_preview"] == NSNull.null ||
        DSHAgentBoundedUTF8String(preview[@"diff_preview"], 4096, YES,
                                  nullptr))) return NO;
  NSString *kind = preview[@"kind"];
  if ([kind isEqualToString:@"write_file"]) {
    return [(NSArray *)preview[@"paths"] count] == 1 &&
        preview[@"content_bytes"] != NSNull.null &&
        preview[@"prior"] != NSNull.null;
  }
  if ([kind isEqualToString:@"start_guest_cgi"]) {
    NSUInteger count = [preview[@"paths"] count];
    // Empty previews were durably emitted by the first v2 build. Preserve
    // loading/reconciliation while new preparation always names its sources.
    return (count == 0 || count == 2 || count == 3) && preview[@"content_bytes"] == NSNull.null && preview[@"prior"] == NSNull.null && preview[@"diff_preview"] == NSNull.null;
  }
  if ([kind isEqualToString:@"git_commit"] ||
      [kind isEqualToString:@"git_push"] ||
      [kind isEqualToString:@"stop_guest_cgi"]) {
    return [(NSArray *)preview[@"paths"] count] == 0 &&
        preview[@"content_bytes"] == NSNull.null &&
        preview[@"prior"] == NSNull.null &&
        preview[@"diff_preview"] == NSNull.null;
  }
  return preview[@"content_bytes"] == NSNull.null &&
      preview[@"prior"] == NSNull.null &&
      preview[@"diff_preview"] == NSNull.null;
}

/// {failure_code, reason}: an argument-class refusal with a value-free
/// reason token (lowercase and underscores, at most 64 bytes).
static BOOL DSHAgentLedgerRejection(NSDictionary *rejection) {
  if (!DSHAgentExactDictionaryKeys(rejection, @[ @"failure_code", @"reason" ])) return NO;
  NSString *code = rejection[@"failure_code"];
  if (![code isKindOfClass:NSString.class] ||
      (![code isEqualToString:@"E_AGENT_BAD_ARGUMENTS"] &&
       ![code isEqualToString:@"E_AGENT_BAD_PATH"])) return NO;
  NSString *reason = rejection[@"reason"];
  if (!DSHAgentBoundedUTF8String(reason, 64, NO, nullptr) || reason.length == 0) return NO;
  NSCharacterSet *alphabet = [[NSCharacterSet
      characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz_"] invertedSet];
  return [reason rangeOfCharacterFromSet:alphabet].location == NSNotFound;
}

static BOOL DSHAgentLedgerRow(NSDictionary *row) {
  if (!DSHAgentExactDictionaryKeys(row, DSHAgentLedgerKeys()) ||
      ![row[@"schema_version"] isEqual:@2] ||
      !DSHAgentLedgerLocator(row[@"locator"]) ||
      !DSHAgentSafeInteger(row[@"row_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentCanonicalSHA256(row[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(row[@"binding_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentLedgerReference(row[@"transcript_before"]) ||
      !DSHAgentToolName(row[@"name"]) ||
      !DSHAgentCanonicalSHA256(row[@"arguments_sha256"]) ||
      !DSHAgentPrecondition(row[@"precondition"]) ||
      ![row[@"name"] isEqual:row[@"precondition"][@"kind"]] ||
      !DSHAgentSafeInteger(row[@"reserved_write_bytes"],
                          DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
      !DSHAgentCanonicalTimestamp(row[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(row[@"updated_at"])) {
    return NO;
  }
  NSError *idempotencyError = nil;
  NSString *expectedIdempotency = DSHAgentIdempotencyKeyForLocator(
      row[@"locator"], row[@"root_fingerprint_sha256"],
      row[@"arguments_sha256"], &idempotencyError);
  if (expectedIdempotency == nil ||
      ![expectedIdempotency isEqual:row[@"locator"][@"idempotency_key"]]) {
    return NO;
  }
  if ([row[@"precondition"][@"kind"] isEqualToString:@"write_file"] &&
      ![row[@"reserved_write_bytes"] isEqual:row[@"precondition"][@"content_bytes"]] &&
      !(([row[@"state"] isEqualToString:@"intent"] ||
         [row[@"state"] isEqualToString:@"cancelled"]) &&
        [row[@"reserved_write_bytes"] isEqual:@0])) {
    return NO;
  }
  if (![row[@"precondition"][@"kind"] isEqualToString:@"write_file"] &&
      ![row[@"reserved_write_bytes"] isEqual:@0]) {
    return NO;
  }
  NSString *state = row[@"state"];
  if (![state isKindOfClass:NSString.class]) return NO;
  NSSet *states = [NSSet setWithArray:@[
    @"intent", @"running", @"cancel_requested", @"settled", @"cancelled",
    @"unknown", @"ambiguous",
  ]];
  if (![states containsObject:state]) return NO;
  if ([row[@"precondition"][@"kind"] isEqualToString:@"write_file"] &&
      [row[@"precondition"][@"prior"][@"kind"] isEqualToString:@"unknown"] &&
      ![state isEqualToString:@"intent"] &&
      ![state isEqualToString:@"cancelled"] &&
      ![state isEqualToString:@"unknown"]) {
    // An unknown prior can be recorded as an intent for recovery evidence,
    // but it can never become executable or appear as a terminal success.
    return NO;
  }
  id owner = row[@"owner"];
  id facts = row[@"settled_facts"];
  id after = row[@"transcript_after"];
  id receipt = row[@"receipt"];
  if (owner != NSNull.null && !DSHAgentLedgerOwner(owner)) return NO;
  if (owner != NSNull.null &&
      ![owner[@"task_id"] isEqual:row[@"locator"][@"task_id"]]) return NO;
  if (facts != NSNull.null && !DSHAgentSettledFacts(facts)) return NO;
  if (after != NSNull.null && !DSHAgentLedgerReference(after)) return NO;
  if (receipt != NSNull.null && !DSHAgentReceipt(receipt)) return NO;
  if ([state isEqualToString:@"intent"]) {
    return owner == NSNull.null && facts == NSNull.null && after == NSNull.null &&
        receipt == NSNull.null;
  }
  if ([state isEqualToString:@"running"] ||
      [state isEqualToString:@"cancel_requested"]) {
    return owner != NSNull.null && facts == NSNull.null && after == NSNull.null &&
        receipt == NSNull.null;
  }
  if ([state isEqualToString:@"settled"]) {
    if (owner != NSNull.null || after == NSNull.null || receipt == NSNull.null) return NO;
    if (![receipt[@"call_id"] isEqual:row[@"locator"][@"call_id"]] ||
        ![receipt[@"name"] isEqual:row[@"name"]] ||
        ![receipt[@"arguments_sha256"] isEqual:row[@"arguments_sha256"]]) return NO;
    NSString *outcome = receipt[@"outcome"];
    if (![outcome isEqualToString:@"ok"] && ![outcome isEqualToString:@"failed"] &&
        ![outcome isEqualToString:@"denied"]) return NO;
    if ([outcome isEqualToString:@"ok"]) {
      if (facts == NSNull.null ||
          ![facts[@"kind"] isEqual:row[@"precondition"][@"kind"]]) return NO;
      NSString *kind = row[@"precondition"][@"kind"];
      if ([kind isEqualToString:@"write_file"]) {
        return [facts[@"content_sha256"] isEqual:row[@"precondition"][@"content_sha256"]] &&
            DSHAgentBoundedUTF8String(facts[@"actual_revision"], 256, NO, nullptr);
      }
      if ([kind isEqualToString:@"git_commit"]) {
        return [facts[@"actual_commit_oid"]
            isEqual:row[@"precondition"][@"expected_commit_oid"]];
      }
      if ([kind isEqualToString:@"git_push"]) {
        return [facts[@"actual_remote_oid"] isEqual:row[@"precondition"][@"target_oid"]];
      }
      if ([kind isEqualToString:@"stop_guest_cgi"]) return [facts[@"service_id"] isEqual:row[@"precondition"][@"service_id"]];
      if ([kind isEqualToString:@"read_file"]) {
        return [facts[@"source_revision"] isEqual:row[@"precondition"][@"source_revision"]];
      }
      if ([kind isEqualToString:@"list_dir"]) {
        return [facts[@"directory_fingerprint_sha256"]
            isEqual:row[@"precondition"][@"directory_fingerprint_sha256"]];
      }
      return YES;
    }
    return facts == NSNull.null;
  }
  if ([state isEqualToString:@"cancelled"]) {
    return owner == NSNull.null && facts == NSNull.null && after != NSNull.null &&
        receipt != NSNull.null && [receipt[@"outcome"] isEqualToString:@"cancelled"] &&
        [receipt[@"call_id"] isEqual:row[@"locator"][@"call_id"]] &&
        [receipt[@"name"] isEqual:row[@"name"]] &&
        [receipt[@"arguments_sha256"] isEqual:row[@"arguments_sha256"]] &&
        [receipt[@"failure_code"] isEqualToString:@"E_AGENT_CANCELLED"];
  }
  if ([state isEqualToString:@"unknown"]) {
    return owner == NSNull.null && facts == NSNull.null && receipt == NSNull.null;
  }
  return owner == NSNull.null && facts == NSNull.null && after != NSNull.null &&
      receipt != NSNull.null && [receipt[@"outcome"] isEqualToString:@"ambiguous"] &&
      [receipt[@"call_id"] isEqual:row[@"locator"][@"call_id"]] &&
      [receipt[@"name"] isEqual:row[@"name"]] &&
      [receipt[@"arguments_sha256"] isEqual:row[@"arguments_sha256"]] &&
      [receipt[@"failure_code"] isEqualToString:@"E_AGENT_EXECUTION_AMBIGUOUS"];
}

BOOL DSHAgentValidateExecutionLedgerEntryV2(NSDictionary *row, NSError **error) {
  if (DSHAgentLedgerRow(row)) return YES;
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
  return NO;
}

static BOOL DSHAgentLedgerTranscriptBound(NSDictionary *state,
                                          NSDictionary *row,
                                          NSError **error) {
  NSDictionary *before = row[@"transcript_before"];
  NSDictionary *locator = row[@"locator"];
  for (NSDictionary *transcript in state[@"transcripts"]) {
    if (![transcript[@"transcript_ref"] isEqual:before[@"transcript_ref"]]) continue;
    if (![transcript[@"attempt_id"] isEqual:locator[@"attempt_id"]] ||
        ![transcript[@"root_fingerprint_sha256"]
             isEqual:row[@"root_fingerprint_sha256"]] ||
        [transcript[@"generation"] unsignedIntegerValue] <
            [before[@"generation"] unsignedIntegerValue] ||
        ([transcript[@"generation"] isEqual:before[@"generation"]] &&
         (![transcript[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] ||
          ![transcript[@"transcript_bytes"] isEqual:before[@"transcript_bytes"]]))) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    return YES;
  }
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
  return NO;
}

static BOOL DSHAgentLedgerRowExecutable(NSDictionary *row) {
  if ([row[@"precondition"][@"kind"] isEqualToString:@"write_file"] &&
      [row[@"precondition"][@"prior"][@"kind"] isEqualToString:@"unknown"]) {
    return NO;
  }
  if ([row[@"precondition"][@"kind"] isEqualToString:@"write_file"] &&
      ![row[@"reserved_write_bytes"] isEqual:row[@"precondition"][@"content_bytes"]]) {
    return NO;
  }
  return YES;
}

static NSDictionary *DSHAgentWriteManifestCallForIntent(NSDictionary *intent);

static BOOL DSHAgentWriteBatchEffectGateOpen(NSDictionary *state,
                                             NSDictionary *row) {
  NSString *name = row[@"name"];
  if (![name isEqualToString:@"write_file"] &&
      ![name isEqualToString:@"git_commit"] &&
      ![name isEqualToString:@"git_push"] && ![name isEqualToString:@"start_guest_cgi"] && ![name isEqualToString:@"stop_guest_cgi"]) return YES;
  NSString *attemptId = row[@"locator"][@"attempt_id"];
  NSString *idempotencyKey = row[@"locator"][@"idempotency_key"];
  for (NSDictionary *batch in state[@"batches"]) {
    if ([batch[@"attempt_id"] isEqual:attemptId] &&
        [batch[@"write_keys"] containsObject:idempotencyKey]) {
      if (![batch[@"effect_gate"] isEqualToString:@"open"] ||
          ![batch[@"task_id"] isEqual:row[@"locator"][@"task_id"]] ||
          ![batch[@"round_id"] isEqual:row[@"locator"][@"round_id"]] ||
          ![batch[@"round_index"] isEqual:row[@"locator"][@"round_index"]]) {
        return NO;
      }
      NSDictionary *expectedManifestCall =
          DSHAgentWriteManifestCallForIntent(row);
      for (NSDictionary *manifestCall in batch[@"manifest_calls"]) {
        if ([manifestCall[@"locator"] isEqual:row[@"locator"]]) {
          return expectedManifestCall != nil &&
              [manifestCall isEqual:expectedManifestCall];
        }
      }
      return NO;
    }
  }
  return NO;
}

static BOOL DSHAgentMutationBatchProvesNoDispatch(NSDictionary *state,
                                                   NSDictionary *batch) {
  if (![batch[@"manifest_calls"] isKindOfClass:NSArray.class] ||
      [(NSArray *)batch[@"manifest_calls"] count] == 0) return NO;
  for (NSDictionary *call in batch[@"manifest_calls"]) {
    if (![DSHAgentLedgerDispatchState(state[@"dispatch"], call[@"locator"])
            isEqualToString:@"not_dispatched"]) return NO;
  }
  return YES;
}

static BOOL DSHAgentCASOwnerMatches(NSDictionary *row, NSDictionary *cas) {
  id expectedGeneration = cas[@"expected_owner_generation"];
  if (expectedGeneration == NSNull.null) return row[@"owner"] == NSNull.null;
  NSDictionary *owner = row[@"owner"];
  return DSHAgentLedgerOwner(owner) &&
      [owner[@"owner_generation"] isEqual:expectedGeneration] &&
      [owner[@"launch_id"] isEqual:cas[@"expected_launch_id"]] &&
      [owner[@"native_task_id"] isEqual:cas[@"expected_native_task_id"]];
}

static BOOL DSHAgentCASMatchesRow(NSDictionary *row,
                                  NSDictionary *cas,
                                  NSError **error) {
  NSDictionary *before = row[@"transcript_before"];
  if (!DSHAgentLedgerCAS(cas) || ![row[@"locator"] isEqual:cas[@"locator"]] ||
      ![row[@"row_revision"] isEqual:cas[@"expected_row_revision"]] ||
      ![row[@"state"] isEqual:cas[@"expected_state"]] ||
      !DSHAgentCASOwnerMatches(row, cas) ||
      ![before[@"generation"] isEqual:cas[@"expected_transcript_generation"]] ||
      ![before[@"transcript_sha256"] isEqual:cas[@"expected_transcript_sha256"]] ||
      ![row[@"root_fingerprint_sha256"] isEqual:cas[@"expected_root_fingerprint_sha256"]] ||
      ![row[@"binding_revision"] isEqual:cas[@"expected_binding_revision"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

static BOOL DSHAgentLedgerTransitionAllowed(NSString *from,
                                            NSString *to,
                                            BOOL allowReconcile) {
  if (![from isKindOfClass:NSString.class] || ![to isKindOfClass:NSString.class]) {
    return NO;
  }
  if ([from isEqualToString:to]) return YES;  // owner heartbeat/metadata CAS.
  if ([from isEqualToString:@"intent"]) {
    return [to isEqualToString:@"running"] || [to isEqualToString:@"cancelled"];
  }
  if ([from isEqualToString:@"running"]) {
    if (allowReconcile &&
        ([to isEqualToString:@"unknown"] || [to isEqualToString:@"ambiguous"])) {
      return YES;
    }
    return [to isEqualToString:@"cancel_requested"] ||
        [to isEqualToString:@"settled"];
  }
  if ([from isEqualToString:@"cancel_requested"]) {
    if (allowReconcile &&
        ([to isEqualToString:@"unknown"] || [to isEqualToString:@"ambiguous"])) {
      return YES;
    }
    return [to isEqualToString:@"settled"] || [to isEqualToString:@"cancelled"];
  }
  return allowReconcile &&
      ([from isEqualToString:@"settled"] || [from isEqualToString:@"cancelled"] ||
       [from isEqualToString:@"unknown"] || [from isEqualToString:@"ambiguous"]) &&
      ([to isEqualToString:@"settled"] || [to isEqualToString:@"cancelled"] ||
       [to isEqualToString:@"unknown"] || [to isEqualToString:@"ambiguous"]);
}

static BOOL DSHAgentLedgerPatchKeysAllowed(NSDictionary *patch,
                                           NSError **error) {
  if (![patch isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSSet *mutableKeys = [NSSet setWithArray:@[
    @"state", @"owner", @"settled_facts", @"transcript_after", @"receipt",
  ]];
  for (id key in patch) {
    if (![key isKindOfClass:NSString.class] || ![mutableKeys containsObject:key]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
  }
  return YES;
}

static BOOL DSHAgentWriteReservationPolicy(NSDictionary *policy) {
  return DSHAgentExactDictionaryKeys(policy, @[
    @"schema_version", @"policy_version", @"max_single_write_bytes",
    @"max_batch_write_bytes", @"max_attempt_write_bytes",
  ]) && DSHAgentSafeInteger(policy[@"schema_version"], 1, NO) &&
      DSHAgentBoundedUTF8String(policy[@"policy_version"], 128, NO, nullptr) &&
      [policy[@"max_single_write_bytes"] unsignedIntegerValue] ==
          DSHAgentNativeWALMaxSingleWriteBytes &&
      DSHAgentSafeInteger(policy[@"max_single_write_bytes"],
                          DSHAgentNativeWALMaxSingleWriteBytes, NO) &&
      DSHAgentSafeInteger(policy[@"max_batch_write_bytes"],
                          DSHAgentNativeWALMaxBatchWriteBytes, NO) &&
      [policy[@"max_batch_write_bytes"] unsignedIntegerValue] >=
          DSHAgentNativeWALMaxSingleWriteBytes &&
      DSHAgentSafeInteger(policy[@"max_attempt_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, NO) &&
      [policy[@"max_attempt_write_bytes"] unsignedIntegerValue] >=
          [policy[@"max_batch_write_bytes"] unsignedIntegerValue];
}

static BOOL DSHAgentWriteBatchRequestShape(NSDictionary *request,
                                           NSError **error) {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"task_id", @"attempt_id",
        @"root_fingerprint_sha256", @"binding_revision", @"policy",
        @"expected_reserved_write_bytes", @"writes", @"intents",
        @"arguments_json",
      ]) || !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalSHA256(request[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(request[@"binding_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentWriteReservationPolicy(request[@"policy"]) ||
      !DSHAgentSafeInteger(request[@"expected_reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      ![request[@"writes"] isKindOfClass:NSArray.class] ||
      ![request[@"intents"] isKindOfClass:NSArray.class] ||
      [(NSArray *)request[@"writes"] count] == 0 ||
      [(NSArray *)request[@"writes"] count] != [(NSArray *)request[@"intents"] count] ||
      [(NSArray *)request[@"writes"] count] > 16) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if (![request[@"arguments_json"] isKindOfClass:NSArray.class] ||
      [(NSArray *)request[@"arguments_json"] count] !=
          [(NSArray *)request[@"intents"] count] ||
      [(NSArray *)request[@"arguments_json"] count] > 16) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSMutableSet *keys = [NSMutableSet set];
  NSMutableSet *paths = [NSMutableSet set];
  for (NSDictionary *write in request[@"writes"]) {
    if (!DSHAgentExactDictionaryKeys(write, @[
          @"idempotency_key", @"relative_path_sha256", @"content_sha256",
          @"content_bytes",
        ]) || !DSHAgentCanonicalSHA256(write[@"idempotency_key"]) ||
        !DSHAgentCanonicalSHA256(write[@"relative_path_sha256"]) ||
        !DSHAgentCanonicalSHA256(write[@"content_sha256"]) ||
        !DSHAgentSafeInteger(write[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
        [keys containsObject:write[@"idempotency_key"]] ||
        [paths containsObject:write[@"relative_path_sha256"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    [keys addObject:write[@"idempotency_key"]];
    [paths addObject:write[@"relative_path_sha256"]];
  }
  NSNumber *previousCallIndex = nil;
  NSString *batchRoundId = nil;
  NSNumber *batchRoundIndex = nil;
  for (NSUInteger index = 0; index < [(NSArray *)request[@"intents"] count]; index += 1) {
    NSDictionary *intent = request[@"intents"][index];
    if (![intent isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSDictionary *write = request[@"writes"][index];
    NSString *argumentsJSON = request[@"arguments_json"][index];
    NSError *argumentsError = nil;
    if (!DSHAgentRawArgumentsBindIntent(argumentsJSON, intent, &argumentsError)) {
      if (error != nullptr) *error = argumentsError ?: DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSString *argumentsDigest = DSHAgentArgumentsSHA256(intent[@"name"],
                                                         argumentsJSON,
                                                         &argumentsError);
    NSNumber *callIndex = intent[@"locator"][@"call_index"];
    if ((previousCallIndex != nil &&
         callIndex.unsignedIntegerValue <= previousCallIndex.unsignedIntegerValue) ||
        (batchRoundId != nil && ![batchRoundId isEqual:intent[@"locator"][@"round_id"]]) ||
        (batchRoundIndex != nil &&
         ![batchRoundIndex isEqual:intent[@"locator"][@"round_index"]])) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    previousCallIndex = callIndex;
    batchRoundId = intent[@"locator"][@"round_id"];
    batchRoundIndex = intent[@"locator"][@"round_index"];
    if (!DSHAgentLedgerRow(intent) || ![intent[@"state"] isEqualToString:@"intent"] ||
        argumentsDigest == nil ||
        ![argumentsDigest isEqual:intent[@"arguments_sha256"]] ||
        ![intent[@"locator"][@"task_id"] isEqual:request[@"task_id"]] ||
        ![intent[@"locator"][@"attempt_id"] isEqual:request[@"attempt_id"]] ||
        ![intent[@"root_fingerprint_sha256"] isEqual:request[@"root_fingerprint_sha256"]] ||
        ![intent[@"binding_revision"] isEqual:request[@"binding_revision"]] ||
        ![intent[@"locator"][@"idempotency_key"] isEqual:write[@"idempotency_key"]] ||
        ![intent[@"precondition"][@"relative_path_sha256"]
             isEqual:write[@"relative_path_sha256"]] ||
        ![intent[@"precondition"][@"content_sha256"] isEqual:write[@"content_sha256"]] ||
        ![intent[@"precondition"][@"content_bytes"] isEqual:write[@"content_bytes"]] ||
        ![intent[@"reserved_write_bytes"] isEqual:write[@"content_bytes"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
  }
  return YES;
}

static NSDictionary *DSHAgentWriteManifestCallForIntent(NSDictionary *intent) {
  NSDictionary *precondition = intent[@"precondition"];
  NSString *name = intent[@"name"];
  NSError *digestError = nil;
  NSString *preconditionSHA = DSHAgentHJ(@"tool-precondition", @{
    @"schema_version" : @1, @"name" : name, @"precondition" : precondition,
  }, &digestError);
  if (preconditionSHA == nil) return nil;
  if ([name isEqualToString:@"write_file"]) {
    return @{
      @"schema_version" : @2, @"mutation_kind" : @"file_write",
      @"locator" : intent[@"locator"],
      @"precondition_sha256" : preconditionSHA,
      @"relative_path_sha256" : precondition[@"relative_path_sha256"],
      @"prior" : precondition[@"prior"],
      @"content_sha256" : precondition[@"content_sha256"],
      @"content_bytes" : precondition[@"content_bytes"],
    };
  }
  if ([name isEqualToString:@"git_commit"] ||
      [name isEqualToString:@"git_push"] || [name isEqualToString:@"start_guest_cgi"] || [name isEqualToString:@"stop_guest_cgi"]) {
    return @{
      @"schema_version" : @2, @"mutation_kind" : name,
      @"locator" : intent[@"locator"],
      @"precondition_sha256" : preconditionSHA, @"content_bytes" : @0,
    };
  }
  return nil;
}

static BOOL DSHAgentWriteManifestCallShape(NSDictionary *call) {
  NSDictionary *locator = call[@"locator"];
  if (![call[@"schema_version"] isEqual:@2] ||
      !DSHAgentLedgerLocator(locator) ||
      !DSHAgentCanonicalSHA256(call[@"precondition_sha256"])) return NO;
  if ([call[@"mutation_kind"] isEqualToString:@"file_write"]) {
    return DSHAgentExactDictionaryKeys(call, @[
      @"schema_version", @"mutation_kind", @"locator",
      @"precondition_sha256", @"relative_path_sha256", @"prior",
      @"content_sha256", @"content_bytes",
    ]) && DSHAgentCanonicalSHA256(call[@"relative_path_sha256"]) &&
        DSHAgentWritePrior(call[@"prior"]) &&
        DSHAgentCanonicalSHA256(call[@"content_sha256"]) &&
        DSHAgentSafeInteger(call[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES);
  }
  return ([call[@"mutation_kind"] isEqualToString:@"git_commit"] ||
          [call[@"mutation_kind"] isEqualToString:@"git_push"] || [call[@"mutation_kind"] isEqualToString:@"start_guest_cgi"] || [call[@"mutation_kind"] isEqualToString:@"stop_guest_cgi"]) &&
      DSHAgentExactDictionaryKeys(call, @[
        @"schema_version", @"mutation_kind", @"locator",
        @"precondition_sha256", @"content_bytes",
      ]) && [call[@"content_bytes"] isEqual:@0];
}

static BOOL DSHAgentBatchEffectGateRevalidated(NSDictionary *state,
                                                NSDictionary *batch,
                                                NSError **error) {
  NSArray *manifestCalls = batch[@"manifest_calls"];
  NSArray *writeKeys = batch[@"write_keys"];
  if (![manifestCalls isKindOfClass:NSArray.class] ||
      ![writeKeys isKindOfClass:NSArray.class] ||
      manifestCalls.count == 0 || manifestCalls.count != writeKeys.count) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return NO;
  }
  NSError *manifestError = nil;
  NSString *manifest = DSHAgentHJ(@"write-manifest", @{
    @"calls" : manifestCalls,
  }, &manifestError);
  if (manifest == nil || ![manifest isEqual:batch[@"manifest_sha256"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return NO;
  }
  NSMutableSet *locatorKeys = [NSMutableSet set];
  NSMutableSet *paths = [NSMutableSet set];
  NSDictionary *reservation = nil;
  for (NSDictionary *candidate in state[@"reservations"]) {
    if ([candidate[@"task_id"] isEqual:batch[@"task_id"]] &&
        [candidate[@"attempt_id"] isEqual:batch[@"attempt_id"]]) {
      if (reservation != nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      reservation = candidate;
    }
  }
  if (reservation == nil ||
      ![reservation[@"root_fingerprint_sha256"]
          isEqual:batch[@"root_fingerprint_sha256"]] ||
      ![reservation[@"binding_revision"] isEqual:batch[@"binding_revision"]] ||
      !DSHAgentWriteReservationPolicy(reservation[@"policy"]) ||
      [batch[@"reserved_write_bytes"] unsignedIntegerValue] >
          [reservation[@"reserved_write_bytes"] unsignedIntegerValue] ||
      ![batch[@"batch_revision"] isEqual:reservation[@"reservation_version"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  for (NSUInteger index = 0; index < manifestCalls.count; index += 1) {
    NSDictionary *call = manifestCalls[index];
    if (!DSHAgentWriteManifestCallShape(call) ||
        ![writeKeys[index] isEqual:call[@"locator"][@"idempotency_key"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    BOOL fileMutation = [call[@"mutation_kind"] isEqualToString:@"file_write"];
    if (fileMutation &&
        ([call[@"prior"][@"kind"] isEqualToString:@"unknown"] ||
         [paths containsObject:call[@"relative_path_sha256"]])) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (fileMutation) [paths addObject:call[@"relative_path_sha256"]];
    NSData *locatorKey = DSHAgentCanonicalIdentityKey(call[@"locator"]);
    if (locatorKey == nil || [locatorKeys containsObject:locatorKey]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [locatorKeys addObject:locatorKey];
    NSDictionary *row = nil;
    for (NSDictionary *candidate in state[@"ledger"]) {
      if ([candidate[@"locator"] isEqual:call[@"locator"]]) {
        if (row != nil) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        row = candidate;
      }
    }
    NSDictionary *precondition = row[@"precondition"];
    NSString *expectedName = fileMutation ? @"write_file" : call[@"mutation_kind"];
    NSString *preconditionSHA = row == nil ? nil : DSHAgentHJ(
        @"tool-precondition", @{
          @"schema_version" : @1, @"name" : row[@"name"],
          @"precondition" : precondition,
        }, error);
    // Every manifest row must still be its never-dispatched intent, except a
    // call the user denied: native settled that row in the bind transaction
    // (denied receipt, no dispatch, no effect) and it can never run.
    NSDictionary *rowReceipt = [row[@"receipt"] isKindOfClass:NSDictionary.class]
        ? row[@"receipt"] : nil;
    BOOL userDeniedRow = [row[@"state"] isEqualToString:@"settled"] &&
        rowReceipt != nil &&
        [rowReceipt[@"outcome"] isEqualToString:@"denied"] &&
        [rowReceipt[@"failure_code"] isEqualToString:@"E_AGENT_DENIED_BY_USER"] &&
        rowReceipt[@"approval_reference"] == NSNull.null &&
        row[@"settled_facts"] == NSNull.null;
    if (row == nil || !DSHAgentLedgerRow(row) ||
        (![row[@"state"] isEqualToString:@"intent"] && !userDeniedRow) ||
        ![row[@"locator"][@"task_id"] isEqual:batch[@"task_id"]] ||
        ![row[@"locator"][@"attempt_id"] isEqual:batch[@"attempt_id"]] ||
        ![row[@"root_fingerprint_sha256"]
            isEqual:batch[@"root_fingerprint_sha256"]] ||
        ![row[@"binding_revision"] isEqual:batch[@"binding_revision"]] ||
        ![row[@"name"] isEqual:expectedName] || preconditionSHA == nil ||
        ![preconditionSHA isEqual:call[@"precondition_sha256"]] ||
        !DSHAgentLedgerTranscriptBound(state, row, error) ||
        ![DSHAgentLedgerDispatchState(state[@"dispatch"], row[@"locator"])
            isEqualToString:@"not_dispatched"]) {
      if (error == nullptr || *error == nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      }
      return NO;
    }
    if (!fileMutation) {
      if (![row[@"reserved_write_bytes"] isEqual:@0]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      continue;
    }
    if (![precondition[@"relative_path_sha256"]
            isEqual:call[@"relative_path_sha256"]] ||
        ![precondition[@"prior"] isEqual:call[@"prior"]] ||
        ![precondition[@"content_sha256"] isEqual:call[@"content_sha256"]] ||
        ![precondition[@"content_bytes"] isEqual:call[@"content_bytes"]] ||
        ![row[@"reserved_write_bytes"] isEqual:call[@"content_bytes"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    BOOL reservationFound = NO;
    for (NSDictionary *key in reservation[@"keys"]) {
      if (![key[@"idempotency_key"] isEqual:call[@"locator"][@"idempotency_key"]]) {
        continue;
      }
      if (![key[@"state"] isEqualToString:@"active"] ||
          ![key[@"relative_path_sha256"] isEqual:call[@"relative_path_sha256"]] ||
          ![key[@"content_sha256"] isEqual:call[@"content_sha256"]] ||
          ![key[@"content_bytes"] isEqual:call[@"content_bytes"]]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      reservationFound = YES;
    }
    if (!reservationFound) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
  }
  return YES;
}

static BOOL DSHAgentMutationBatchApprovalsBound(NSDictionary *state,
                                                NSDictionary *batch,
                                                NSError **error) {
  if ([(NSArray *)state[@"authorities"] count] == 0 &&
      [(NSArray *)state[@"operations"] count] == 0) return YES;
  NSDictionary *receipt = nil;
  for (NSDictionary *snapshot in state[@"operation_results"]) {
    NSDictionary *wrapper = snapshot[@"result"];
    NSDictionary *candidate = wrapper[@"result"][@"receipt"];
    if ([wrapper[@"result_kind"]
            isEqualToString:@"prepare_agent_tool_batch"] &&
        [candidate[@"task_id"] isEqual:batch[@"task_id"]] &&
        [candidate[@"attempt_id"] isEqual:batch[@"attempt_id"]] &&
        [candidate[@"round_id"] isEqual:batch[@"round_id"]] &&
        [candidate[@"round_index"] isEqual:batch[@"round_index"]] &&
        [candidate[@"batch_revision"] isEqual:batch[@"batch_revision"]] &&
        [candidate[@"manifest_sha256"] isEqual:batch[@"manifest_sha256"]]) {
      if (receipt != nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      receipt = candidate;
    }
  }
  if (receipt == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  for (NSDictionary *manifestCall in batch[@"manifest_calls"]) {
    NSDictionary *safeCall = nil;
    for (NSDictionary *candidate in receipt[@"calls"]) {
      if ([candidate[@"call_index"]
              isEqual:manifestCall[@"locator"][@"call_index"]] &&
          [candidate[@"call_id"]
              isEqual:manifestCall[@"locator"][@"call_id"]] &&
          [candidate[@"idempotency_key"]
              isEqual:manifestCall[@"locator"][@"idempotency_key"]]) {
        safeCall = candidate;
        break;
      }
    }
    if (safeCall == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if ([safeCall[@"approval_state"] isEqualToString:@"bound"] &&
        safeCall[@"approval_reference"] != NSNull.null) continue;
    BOOL bound = NO;
    BOOL deniedSettled = NO;
    for (NSDictionary *snapshot in state[@"operation_results"]) {
      NSDictionary *result = snapshot[@"result"][@"result"];
      if (!([result[@"status"] isEqualToString:@"bound"] ||
            [result[@"status"] isEqualToString:@"already_bound"]) ||
          ![result[@"task_id"] isEqual:batch[@"task_id"]] ||
          ![result[@"attempt_id"] isEqual:batch[@"attempt_id"]] ||
          ![result[@"round_id"] isEqual:batch[@"round_id"]] ||
          ![result[@"call_index"] isEqual:safeCall[@"call_index"]] ||
          ![result[@"call_id"] isEqual:safeCall[@"call_id"]] ||
          ![result[@"result_batch_revision"] isEqual:batch[@"batch_revision"]]) continue;
      if (([result[@"decision"] isEqualToString:@"allow_once"] ||
           [result[@"decision"] isEqualToString:@"allow_conversation"]) &&
          result[@"approval_reference"] != NSNull.null) {
        bound = YES;
        break;
      }
      if ([result[@"decision"] isEqualToString:@"denied"] &&
          result[@"approval_reference"] == NSNull.null &&
          [result[@"receipt"] isKindOfClass:NSDictionary.class] &&
          [result[@"receipt"][@"outcome"] isEqualToString:@"denied"]) {
        // A persisted user denial settled the call natively (denied receipt,
        // never dispatched): it can never open its own gate, but it no
        // longer blocks the remaining allowed mutations.  Every mutation
        // still revalidates its own immutable binding at execution time, so
        // the denied call stays impossible to run.  A cancelled decision
        // keeps the gate closed.
        deniedSettled = YES;
        break;
      }
    }
    if (!bound && !deniedSettled) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
  }
  return YES;
}

static NSMutableDictionary *DSHAgentLedgerMutable(id value) {
  return [value isKindOfClass:NSDictionary.class] ? [value mutableCopy] : nil;
}

static BOOL DSHAgentLedgerAuthorityRootMatches(NSDictionary *authorityRoot,
                                               NSDictionary *candidateRoot) {
  if (![authorityRoot isKindOfClass:NSDictionary.class] ||
      ![candidateRoot isKindOfClass:NSDictionary.class]) return NO;
  if (DSHAgentLedgerRootFull(candidateRoot)) {
    // A caller that supplies the complete frozen projection must match every
    // authority bit.  It may not fall back to the narrower ledger-row
    // expectation merely because its fingerprint/revision were copied.
    return [authorityRoot isEqual:candidateRoot];
  }
  if (!DSHAgentLedgerRootExpectation(candidateRoot)) return NO;
  return [candidateRoot[@"root_fingerprint_sha256"]
              isEqual:authorityRoot[@"root_fingerprint_sha256"]] &&
      [candidateRoot[@"binding_revision"]
              isEqual:authorityRoot[@"workspace_binding_revision"]];
}

/// Advances the optional schema-v2 prepared authority in the same WAL
/// transaction as a batch/denial/settlement.  Empty authorities are retained
/// as a native unit-test seam; once an authority exists, absence or any root,
/// transcript, policy, or reservation drift fails closed.
static BOOL DSHAgentLedgerAdvanceAuthority(
    NSMutableDictionary *state,
    NSString *taskId,
    NSString *attemptId,
    NSDictionary *root,
    NSDictionary *expectedTranscript,
    NSDictionary *nextTranscript,
    NSDictionary * _Nullable policy,
    NSNumber * _Nullable expectedReservedWriteBytes,
    NSNumber * _Nullable nextReservedWriteBytes,
    BOOL allowExpectedTranscriptAdvance,
    NSString *timestamp,
    NSError **error) {
  NSMutableArray *authorities = [state[@"authorities"] mutableCopy];
  if (authorities == nil) return YES;  // schema-v1 bootstrap/test seam.
  if (authorities.count == 0) return YES;
  NSUInteger matchIndex = NSNotFound;
  NSMutableDictionary *authority = nil;
  for (NSUInteger index = 0; index < authorities.count; index += 1) {
    NSDictionary *candidate = authorities[index];
    if ([candidate[@"task_id"] isEqual:taskId] &&
        [candidate[@"attempt_id"] isEqual:attemptId]) {
      if (authority != nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      authority = [candidate mutableCopy];
      matchIndex = index;
    }
  }
  BOOL rootMatches = DSHAgentLedgerAuthorityRootMatches(authority[@"root"], root);
  NSDictionary *authorityTranscript = authority[@"transcript"];
  BOOL transcriptMatches = [authorityTranscript isEqual:expectedTranscript];
  if (!transcriptMatches && allowExpectedTranscriptAdvance &&
      [authorityTranscript[@"transcript_ref"]
          isEqual:expectedTranscript[@"transcript_ref"]] &&
      [expectedTranscript[@"generation"] unsignedIntegerValue] >
          [authorityTranscript[@"generation"] unsignedIntegerValue]) {
    // Batch preparation separately binds expectedTranscript to the exact
    // completed round and current open transcript row. The prepared authority
    // legitimately still names transcript_before until this atomic commit.
    transcriptMatches = YES;
  }
  if (authority == nil || ![authority[@"state"] isEqualToString:@"prepared"] ||
      !rootMatches ||
      !transcriptMatches ||
      (policy != nil && ![authority[@"policy"] isEqual:policy]) ||
      (expectedReservedWriteBytes != nil &&
       ![authority[@"reserved_write_bytes"]
          isEqual:expectedReservedWriteBytes])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSUInteger revision = [authority[@"authority_revision"] unsignedIntegerValue];
  if (revision == DSHAgentMaximumSafeInteger) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
    return NO;
  }
  authority[@"transcript"] = nextTranscript;
  if (nextReservedWriteBytes != nil) {
    authority[@"reserved_write_bytes"] = nextReservedWriteBytes;
  }
  authority[@"authority_revision"] = @(revision + 1);
  authority[@"updated_at"] = timestamp;
  authorities[matchIndex] = authority;
  state[@"authorities"] = authorities;
  return YES;
}

@interface DSHAgentExecutionLedger ()
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@end

@implementation DSHAgentExecutionLedger

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal {
  self = [super init];
  if (self) _wal = wal;
  return self;
}

- (NSDictionary *)insertValidatedAgentExecutionIntentWithInsertCAS:(NSDictionary *)insertCAS
                                                       argumentsJSON:(NSString *)argumentsJSON
                                                        exactIntent:(NSDictionary *)intent
                                                              error:(NSError **)error {
  NSError *bindingError = nil;
  if (!DSHAgentRawArgumentsBindIntent(argumentsJSON, intent, &bindingError)) {
    if (error != nullptr) *error = bindingError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if (!DSHAgentLedgerInsertCAS(insertCAS) || !DSHAgentLedgerRow(intent) ||
      ![intent[@"locator"] isEqual:insertCAS[@"locator"]] ||
      ![intent[@"transcript_before"][@"generation"]
          isEqual:insertCAS[@"expected_transcript_generation"]] ||
      ![intent[@"transcript_before"][@"transcript_sha256"]
          isEqual:insertCAS[@"expected_transcript_sha256"]] ||
      ![intent[@"root_fingerprint_sha256"]
          isEqual:insertCAS[@"expected_root_fingerprint_sha256"]] ||
      ![intent[@"binding_revision"] isEqual:insertCAS[@"expected_binding_revision"]] ||
      ![intent[@"state"] isEqualToString:@"intent"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *immutableIntentError = nil;
  NSDictionary *immutableIntent = DSHAgentImmutableJSONCopy(intent,
                                                            &immutableIntentError);
  if (![immutableIntent isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  intent = immutableIntent;
  NSDictionary *snapshot = [self.wal snapshotWithError:error];
  if (snapshot == nil) return nil;
  for (NSDictionary *candidate in snapshot[@"ledger"]) {
    if (![candidate[@"locator"] isEqual:insertCAS[@"locator"]]) continue;
    NSError *bytesError = nil;
    NSData *left = DSHAgentCanonicalJSON(candidate, &bytesError);
    NSData *right = DSHAgentCanonicalJSON(intent, &bytesError);
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
    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    NSMutableArray *attemptRows = [NSMutableArray array];
    for (NSDictionary *candidate in rows) {
      if ([candidate[@"locator"] isEqual:insertCAS[@"locator"]]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      if ([candidate[@"locator"][@"attempt_id"]
              isEqual:intent[@"locator"][@"attempt_id"]]) {
        [attemptRows addObject:candidate];
      }
    }
    if (attemptRows.count >= DSHAgentNativeWALMaxLedgerRowsPerAttempt) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    if (!DSHAgentLedgerTranscriptBound(state, intent, mutationError)) return NO;
    NSUInteger reservedBytes = [intent[@"reserved_write_bytes"] unsignedIntegerValue];
    NSUInteger contentBytes = [intent[@"precondition"][@"content_bytes"] unsignedIntegerValue];
    if (contentBytes > 0 || reservedBytes > 0) {
      BOOL reservationFound = NO;
      NSString *attemptId = intent[@"locator"][@"attempt_id"];
      NSString *idempotencyKey = intent[@"locator"][@"idempotency_key"];
      for (NSDictionary *reservation in state[@"reservations"]) {
        if (![reservation[@"attempt_id"] isEqual:attemptId]) continue;
        for (NSDictionary *key in reservation[@"keys"]) {
          if ([key[@"idempotency_key"] isEqual:idempotencyKey] &&
              [key[@"state"] isEqualToString:@"active"] &&
              [key[@"content_bytes"] isEqual:@(contentBytes)] &&
              reservedBytes == contentBytes &&
              [key[@"content_sha256"] isEqual:intent[@"precondition"][@"content_sha256"]] &&
              [key[@"relative_path_sha256"] isEqual:intent[@"precondition"][@"relative_path_sha256"]]) {
            reservationFound = YES;
            break;
          }
        }
      }
      if (!reservationFound) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
    }
    [rows addObject:[intent copy]];
    state[@"ledger"] = rows;
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    [dispatch addObject:@{
      @"schema_version" : @1,
      @"kind" : @"execution",
      @"locator" : [intent[@"locator"] copy],
      @"dispatch_state" : @"not_dispatched",
    }];
    state[@"dispatch"] = dispatch;
    inserted = [intent copy];
    return YES;
  } error:error];
  return committed ? @{ @"schema_version" : @1,
                        @"status" : @"inserted", @"row" : inserted } : nil;
}

- (NSDictionary *)insertAgentExecutionIntentWithInsertCAS:(NSDictionary *)insertCAS
                                            argumentsJSON:(NSString *)argumentsJSON
                                             exactIntent:(NSDictionary *)intent
                                                   error:(NSError **)error {
  if (![intent isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *name = intent[@"name"];
  NSError *bindingError = nil;
  if (!DSHAgentRawArgumentsBindIntent(argumentsJSON, intent, &bindingError)) {
    if (error != nullptr) *error = bindingError ?: DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSError *argumentsError = nil;
  NSString *argumentsDigest = DSHAgentArgumentsSHA256(name, argumentsJSON,
                                                      &argumentsError);
  if (argumentsDigest == nil ||
      ![argumentsDigest isEqual:intent[@"arguments_sha256"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  return [self insertValidatedAgentExecutionIntentWithInsertCAS:insertCAS
                                                  argumentsJSON:argumentsJSON
                                                       exactIntent:intent
                                                             error:error];
}

- (NSDictionary *)casAgentExecutionWithCAS:(NSDictionary *)cas
                                      patch:(NSDictionary *)patch
                              allowReconcile:(BOOL)allowReconcile
                                      error:(NSError **)error {
  NSError *patchError = nil;
  if (!DSHAgentLedgerCAS(cas) || !DSHAgentLedgerPatchKeysAllowed(patch, &patchError)) {
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
      ([patch[@"state"] isEqualToString:@"settled"] ||
       [patch[@"state"] isEqualToString:@"cancelled"])) {
    // Terminal ledger rows are created only by settle/cancel's specialized
    // atomic paths. Generic CAS remains a non-terminal mutation surface.
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    for (NSUInteger index = 0; index < rows.count; index += 1) {
      NSMutableDictionary *row = DSHAgentLedgerMutable(rows[index]);
      if (![row[@"locator"] isEqual:cas[@"locator"]]) continue;
      if (!DSHAgentCASMatchesRow(row, cas, mutationError)) return NO;
      if (!allowReconcile &&
          ([row[@"state"] isEqualToString:@"settled"] ||
           [row[@"state"] isEqualToString:@"cancelled"])) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      if (!DSHAgentLedgerTranscriptBound(state, row, mutationError)) return NO;
      if ([row[@"state"] isEqualToString:@"intent"] &&
          [patch[@"state"] isEqualToString:@"running"] &&
          !DSHAgentLedgerRowExecutable(row)) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSMutableDictionary *updated = [row mutableCopy];
      [patch enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
        (void)stop;
        updated[key] = value;
      }];
      NSString *nextState = updated[@"state"];
      if (![nextState isKindOfClass:NSString.class]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      if ([nextState isEqualToString:@"cancelled"] ||
          [nextState isEqualToString:@"unknown"] ||
          [nextState isEqualToString:@"ambiguous"]) {
        NSString *dispatchState = DSHAgentLedgerDispatchState(
            state[@"dispatch"], row[@"locator"]);
        if ([nextState isEqualToString:@"cancelled"] &&
            ![dispatchState isEqualToString:@"not_dispatched"]) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorConflict);
          return NO;
        }
        if (([nextState isEqualToString:@"unknown"] ||
             [nextState isEqualToString:@"ambiguous"]) && !allowReconcile) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorConflict);
          return NO;
        }
      }
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
      if (!DSHAgentLedgerTransitionAllowed(row[@"state"], updated[@"state"],
                                           allowReconcile)) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
      if (revision == 9007199254740991ULL || !DSHAgentLedgerRow(updated)) {
        DSHSetAgentNativeStoreError(mutationError,
                                    revision == 9007199254740991ULL
                                        ? DSHAgentNativeStoreErrorCapacity
                                        : DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      updated[@"row_revision"] = @(revision + 1);
      updated[@"updated_at"] = [self.wal currentTimestamp];
      if (!DSHAgentLedgerRow(updated)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      NSDictionary *currentTranscript = nil;
      for (NSDictionary *candidate in state[@"transcripts"]) {
        if ([candidate[@"transcript_ref"]
                isEqual:row[@"transcript_before"][@"transcript_ref"]]) {
          currentTranscript = @{
            @"schema_version" : @1,
            @"transcript_ref" : candidate[@"transcript_ref"],
            @"generation" : candidate[@"generation"],
            @"transcript_sha256" : candidate[@"transcript_sha256"],
            @"transcript_bytes" : candidate[@"transcript_bytes"],
          };
          break;
        }
      }
      if (currentTranscript == nil || !DSHAgentLedgerAdvanceAuthority(
              state, row[@"locator"][@"task_id"],
              row[@"locator"][@"attempt_id"],
              @{ @"schema_version" : @1,
                 @"root_fingerprint_sha256" : row[@"root_fingerprint_sha256"],
                 @"binding_revision" : row[@"binding_revision"] },
              currentTranscript, currentTranscript, nil, nil, nil, NO,
              [self.wal currentTimestamp], mutationError)) return NO;
      rows[index] = updated;
      state[@"ledger"] = rows;
      output = @{ @"ok" : @YES, @"row" : [updated copy] };
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
    return NO;
  } error:error];
  if (committed) return output;
  if (error != nullptr && *error != nil &&
      (*error).code == DSHAgentNativeStoreErrorConflict) {
    NSDictionary *state = [self.wal snapshotWithError:nil];
    for (NSDictionary *row in state[@"ledger"]) {
      if ([row[@"locator"] isEqual:cas[@"locator"]]) {
        if (error != nullptr) *error = nil;
        return @{ @"ok" : @NO, @"conflict" : @YES, @"row" : row };
      }
    }
  }
  return nil;
}

- (NSDictionary *)casAgentExecutionWithCAS:(NSDictionary *)cas
                                      patch:(NSDictionary *)patch
                                      error:(NSError **)error {
  return [self casAgentExecutionWithCAS:cas
                                  patch:patch
                          allowReconcile:NO
                                  error:error];
}

- (NSDictionary *)claimAgentExecutionWithLocator:(NSDictionary *)locator
                              expectedRowRevision:(NSNumber *)revision
                                             owner:(NSDictionary *)owner
                                             error:(NSError **)error {
  if (!DSHAgentLedgerLocator(locator) ||
      !DSHAgentSafeInteger(revision, 9007199254740991ULL, NO) ||
      !DSHAgentLedgerOwner(owner) ||
      ![owner[@"task_id"] isEqual:locator[@"task_id"]] ||
      ![owner[@"launch_id"] isEqual:self.wal.launchId] ||
      ![self.wal isNativeTaskAlive:owner[@"native_task_id"]
                           launchId:owner[@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  for (NSDictionary *row in state[@"ledger"]) {
    if (![row[@"locator"] isEqual:locator]) continue;
    NSDictionary *cas = @{
      @"schema_version" : @2,
      @"locator" : locator,
      @"expected_row_revision" : revision,
      @"expected_state" : @"intent",
      @"expected_owner_generation" : NSNull.null,
      @"expected_launch_id" : NSNull.null,
      @"expected_native_task_id" : NSNull.null,
      @"expected_transcript_generation" : row[@"transcript_before"][@"generation"],
      @"expected_transcript_sha256" : row[@"transcript_before"][@"transcript_sha256"],
      @"expected_root_fingerprint_sha256" : row[@"root_fingerprint_sha256"],
      @"expected_binding_revision" : row[@"binding_revision"],
    };
    return [self casAgentExecutionWithCAS:cas
                                     patch:@{
                                       @"state" : @"running",
                                       @"owner" : owner,
                                     }
                              allowReconcile:NO
                                     error:error];
  }
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
  return nil;
}

- (NSDictionary *)heartbeatAgentExecutionWithCAS:(NSDictionary *)cas
                                            owner:(NSDictionary *)owner
                                            error:(NSError **)error {
  if (!DSHAgentLedgerCAS(cas) || !DSHAgentLedgerOwner(owner) ||
      ![owner[@"task_id"] isEqual:cas[@"locator"][@"task_id"]] ||
      ![owner[@"launch_id"] isEqual:self.wal.launchId] ||
      ![self.wal isNativeTaskAlive:owner[@"native_task_id"]
                           launchId:owner[@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  return [self casAgentExecutionWithCAS:cas
                                  patch:@{ @"owner" : owner }
                                  error:error];
}

- (NSDictionary *)markAgentExecutionDispatchedWithCAS:(NSDictionary *)cas
                                                  error:(NSError **)error {
  if (!DSHAgentLedgerCAS(cas)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    NSUInteger rowIndex = NSNotFound;
    NSMutableDictionary *row = nil;
    for (NSUInteger index = 0; index < rows.count; index += 1) {
      NSMutableDictionary *candidate = DSHAgentLedgerMutable(rows[index]);
      if ([candidate[@"locator"] isEqual:cas[@"locator"]]) {
        row = candidate;
        rowIndex = index;
        break;
      }
    }
    if (row == nil || !DSHAgentCASMatchesRow(row, cas, mutationError) ||
        (![row[@"state"] isEqualToString:@"running"] &&
         ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
        (id)row[@"owner"] == NSNull.null ||
        ![self.wal isNativeTaskAlive:row[@"owner"][@"native_task_id"]
                             launchId:row[@"owner"][@"launch_id"]]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (!DSHAgentLedgerTranscriptBound(state, row, mutationError)) return NO;
    if ([row[@"precondition"][@"kind"] isEqualToString:@"write_file"] &&
        [row[@"precondition"][@"prior"][@"kind"] isEqualToString:@"unknown"]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (!DSHAgentWriteBatchEffectGateOpen(state, row)) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    BOOL found = NO;
    for (NSMutableDictionary *entry in dispatch) {
      if (![entry[@"kind"] isEqualToString:@"execution"] ||
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
    if (!DSHAgentLedgerRow(row)) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSDictionary *currentTranscript = nil;
    for (NSDictionary *candidate in state[@"transcripts"]) {
      if ([candidate[@"transcript_ref"]
              isEqual:row[@"transcript_before"][@"transcript_ref"]]) {
        currentTranscript = @{
          @"schema_version" : @1,
          @"transcript_ref" : candidate[@"transcript_ref"],
          @"generation" : candidate[@"generation"],
          @"transcript_sha256" : candidate[@"transcript_sha256"],
          @"transcript_bytes" : candidate[@"transcript_bytes"],
        };
        break;
      }
    }
    if (currentTranscript == nil || !DSHAgentLedgerAdvanceAuthority(
            state, row[@"locator"][@"task_id"],
            row[@"locator"][@"attempt_id"],
            @{ @"schema_version" : @1,
               @"root_fingerprint_sha256" : row[@"root_fingerprint_sha256"],
               @"binding_revision" : row[@"binding_revision"] },
            currentTranscript, currentTranscript, nil, nil, nil, NO,
            [self.wal currentTimestamp], mutationError)) return NO;
    rows[rowIndex] = row;
    state[@"ledger"] = rows;
    state[@"dispatch"] = dispatch;
    output = @{ @"schema_version" : @1,
                @"status" : @"dispatched",
                @"row" : [row copy] };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)queryAgentExecutionWithLocator:(NSDictionary *)locator
                                expectedTranscript:(NSDictionary *)transcript
                                               root:(NSDictionary *)root
                                             error:(NSError **)error {
  if (!DSHAgentLedgerLocator(locator) || !DSHAgentLedgerReference(transcript) ||
      !([root isKindOfClass:NSDictionary.class] &&
        (DSHAgentLedgerRootExpectation(root) || DSHAgentLedgerRootFull(root))) ||
      !DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(root[@"binding_revision"] ?: root[@"workspace_binding_revision"],
                           9007199254740991ULL, NO)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if (![self.wal reconcileOwnerLossWithError:error]) return nil;
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  for (NSDictionary *row in state[@"ledger"]) {
    if (![row[@"locator"] isEqual:locator]) continue;
    if (![row[@"root_fingerprint_sha256"] isEqual:root[@"root_fingerprint_sha256"]] ||
        ![row[@"binding_revision"] isEqual:
            (root[@"binding_revision"] ?: root[@"workspace_binding_revision"])] ||
        ![row[@"transcript_before"] isEqual:transcript]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    NSString *status = row[@"state"];
    if ([status isEqualToString:@"settled"]) {
      NSString *outcome = row[@"receipt"][@"outcome"];
      NSString *mapped = [outcome isEqualToString:@"ok"] ? @"completed" :
          ([outcome isEqualToString:@"denied"] ? @"denied" : @"failed");
      return @{ @"schema_version" : @2, @"status" : mapped, @"row" : row };
    }
    return @{ @"schema_version" : @2, @"status" : status, @"row" : row };
  }
  return @{ @"schema_version" : @2, @"status" : @"not_started" };
}

- (NSDictionary *)reserveWriteBytesForAttemptWithRequest:(NSDictionary *)request
                                                     error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"task_id", @"attempt_id", @"root_fingerprint_sha256",
        @"binding_revision", @"policy", @"expected_reserved_write_bytes", @"writes",
      ]) || !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalSHA256(request[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(request[@"binding_revision"], 9007199254740991ULL, NO) ||
      !DSHAgentWriteReservationPolicy(request[@"policy"]) ||
      !DSHAgentSafeInteger(request[@"expected_reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      ![request[@"writes"] isKindOfClass:NSArray.class] ||
      [(NSArray *)request[@"writes"] count] > 16) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSMutableSet *batchKeys = [NSMutableSet set];
  NSMutableSet *batchPaths = [NSMutableSet set];
  for (NSDictionary *write in request[@"writes"]) {
    if (!DSHAgentExactDictionaryKeys(write, @[
          @"idempotency_key", @"relative_path_sha256", @"content_sha256",
          @"content_bytes",
        ]) || !DSHAgentCanonicalSHA256(write[@"idempotency_key"]) ||
        !DSHAgentCanonicalSHA256(write[@"relative_path_sha256"]) ||
        !DSHAgentCanonicalSHA256(write[@"content_sha256"]) ||
        !DSHAgentSafeInteger(write[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
        [batchKeys containsObject:write[@"idempotency_key"]] ||
        [batchPaths containsObject:write[@"relative_path_sha256"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    [batchKeys addObject:write[@"idempotency_key"]];
    [batchPaths addObject:write[@"relative_path_sha256"]];
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *reservations = [state[@"reservations"] mutableCopy];
    NSMutableDictionary *record = nil;
    NSUInteger recordIndex = NSNotFound;
    for (NSUInteger index = 0; index < reservations.count; index += 1) {
      NSMutableDictionary *candidate = [reservations[index] mutableCopy];
      if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        record = candidate;
        recordIndex = index;
        break;
      }
    }
    if (record == nil) {
      record = [@{
        @"schema_version" : @1,
        @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"root_fingerprint_sha256" : request[@"root_fingerprint_sha256"],
        @"binding_revision" : request[@"binding_revision"],
        @"policy" : request[@"policy"],
        @"reserved_write_bytes" : @0,
        @"reservation_version" : @0,
        @"keys" : @[],
      } mutableCopy];
    } else if (![record[@"root_fingerprint_sha256"]
                   isEqual:request[@"root_fingerprint_sha256"]] ||
               ![record[@"binding_revision"] isEqual:request[@"binding_revision"]] ||
               ![record[@"policy"] isEqual:request[@"policy"]]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSMutableArray *keys = [record[@"keys"] mutableCopy];
    NSUInteger originalKeyCount = keys.count;
    NSMutableSet *existing = [NSMutableSet set];
    NSUInteger batchNew = 0;
    NSUInteger reserved = [record[@"reserved_write_bytes"] unsignedIntegerValue];
    if (reserved != [request[@"expected_reserved_write_bytes"] unsignedIntegerValue]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    for (NSDictionary *key in keys) {
      if ([key[@"state"] isEqualToString:@"active"]) {
        [existing addObject:key[@"idempotency_key"]];
      }
    }
    for (NSDictionary *write in request[@"writes"]) {
      if ([existing containsObject:write[@"idempotency_key"]]) {
        for (NSDictionary *prior in keys) {
          if (![prior[@"idempotency_key"] isEqual:write[@"idempotency_key"]]) continue;
          if (![prior[@"state"] isEqualToString:@"active"] ||
              ![prior[@"relative_path_sha256"] isEqual:write[@"relative_path_sha256"]] ||
              ![prior[@"content_sha256"] isEqual:write[@"content_sha256"]] ||
              ![prior[@"content_bytes"] isEqual:write[@"content_bytes"]]) {
            DSHSetAgentNativeStoreError(mutationError,
                                        DSHAgentNativeStoreErrorCorrupt);
            return NO;
          }
        }
      } else {
        NSUInteger priorIndex = NSNotFound;
        for (NSUInteger index = 0; index < keys.count; index += 1) {
          if ([keys[index][@"idempotency_key"] isEqual:write[@"idempotency_key"]]) {
            priorIndex = index;
            break;
          }
        }
        if (priorIndex != NSNotFound &&
            (![keys[priorIndex][@"relative_path_sha256"] isEqual:write[@"relative_path_sha256"]] ||
             ![keys[priorIndex][@"content_sha256"] isEqual:write[@"content_sha256"]] ||
             ![keys[priorIndex][@"content_bytes"] isEqual:write[@"content_bytes"]])) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        if (priorIndex != NSNotFound) {
          if ([keys[priorIndex][@"state"] isEqualToString:@"released"]) {
            batchNew += [write[@"content_bytes"] unsignedIntegerValue];
          }
          keys[priorIndex] = @{
            @"idempotency_key" : write[@"idempotency_key"],
            @"relative_path_sha256" : write[@"relative_path_sha256"],
            @"content_sha256" : write[@"content_sha256"],
            @"content_bytes" : write[@"content_bytes"],
            @"state" : @"active",
          };
        } else {
          batchNew += [write[@"content_bytes"] unsignedIntegerValue];
          [keys addObject:@{
            @"idempotency_key" : write[@"idempotency_key"],
            @"relative_path_sha256" : write[@"relative_path_sha256"],
            @"content_sha256" : write[@"content_sha256"],
            @"content_bytes" : write[@"content_bytes"],
            @"state" : @"active",
          }];
          [existing addObject:write[@"idempotency_key"]];
        }
      }
    }
    NSUInteger maxBatch = [request[@"policy"][@"max_batch_write_bytes"] unsignedIntegerValue];
    NSUInteger maxAttempt = [request[@"policy"][@"max_attempt_write_bytes"] unsignedIntegerValue];
    if (batchNew > maxBatch || reserved > maxAttempt || batchNew > maxAttempt - reserved) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    reserved += batchNew;
    BOOL changed = batchNew != 0 || keys.count != originalKeyCount;
    if (changed) {
      NSUInteger version = [record[@"reservation_version"] unsignedIntegerValue];
      if (version == DSHAgentMaximumSafeInteger) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      record[@"reservation_version"] = @(version + 1);
    }
    record[@"reserved_write_bytes"] = @(reserved);
    record[@"keys"] = keys;
    if (recordIndex == NSNotFound) [reservations addObject:record];
    else reservations[recordIndex] = record;
    state[@"reservations"] = reservations;
    output = @{
      @"schema_version" : @1,
      @"status" : @"reserved",
      @"reserved_write_bytes" : @(reserved),
      @"batch_new" : @(batchNew),
    };
    return changed;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)prepareAgentWriteBatchWithRequest:(NSDictionary *)request
                                               error:(NSError **)error {
  if (!DSHAgentWriteBatchRequestShape(request, error)) return nil;
  NSMutableArray *manifestCalls = [NSMutableArray arrayWithCapacity:
      [(NSArray *)request[@"intents"] count]];
  for (NSDictionary *intent in request[@"intents"]) {
    NSDictionary *manifestCall = DSHAgentWriteManifestCallForIntent(intent);
    if (!DSHAgentWriteManifestCallShape(manifestCall)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    NSError *immutableManifestError = nil;
    NSDictionary *immutableManifestCall = DSHAgentImmutableJSONCopy(
        manifestCall, &immutableManifestError);
    if (![immutableManifestCall isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    [manifestCalls addObject:immutableManifestCall];
  }
  NSError *manifestError = nil;
  NSString *manifest = DSHAgentHJ(@"write-manifest", @{
    @"calls" : manifestCalls,
  }, &manifestError);
  if (manifest == nil) {
    if (error != nullptr) *error = manifestError;
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *batches = [state[@"batches"] mutableCopy];
    for (NSDictionary *existingBatch in batches) {
      if (![existingBatch[@"task_id"] isEqual:request[@"task_id"]] ||
          ![existingBatch[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
          ![existingBatch[@"manifest_sha256"] isEqual:manifest]) continue;
      NSArray *existingKeys = existingBatch[@"write_keys"];
      NSMutableArray *requestedKeys = [NSMutableArray array];
      for (NSDictionary *write in request[@"writes"]) {
        [requestedKeys addObject:write[@"idempotency_key"]];
      }
      if (![existingKeys isEqual:requestedKeys] ||
          ![existingBatch[@"manifest_calls"] isEqual:manifestCalls]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      // A matching digest is not enough: replay must compare each immutable
      // intent row against the exact locator/path/prior/content tuple that
      // produced the original manifest.
      for (NSDictionary *manifestCall in manifestCalls) {
        NSDictionary *matchingRow = nil;
        for (NSDictionary *candidate in state[@"ledger"]) {
          if ([candidate[@"locator"] isEqual:manifestCall[@"locator"]]) {
            if (matchingRow != nil ||
                ![DSHAgentWriteManifestCallForIntent(candidate)
                    isEqual:manifestCall]) {
              DSHSetAgentNativeStoreError(mutationError,
                                          DSHAgentNativeStoreErrorCorrupt);
              return NO;
            }
            matchingRow = candidate;
          }
        }
        if (matchingRow == nil) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
      }
      for (NSDictionary *requestedIntent in request[@"intents"]) {
        NSDictionary *matchingRow = nil;
        for (NSDictionary *candidate in state[@"ledger"]) {
          if (![candidate[@"locator"] isEqual:requestedIntent[@"locator"]]) continue;
          if (matchingRow != nil ||
              ![candidate isEqual:requestedIntent]) {
            DSHSetAgentNativeStoreError(mutationError,
                                        DSHAgentNativeStoreErrorCorrupt);
            return NO;
          }
          matchingRow = candidate;
        }
        if (matchingRow == nil) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
      }
      output = @{ @"schema_version" : @1,
                  @"status" : @"existing_identical",
                  @"manifest_sha256" : manifest,
                  @"reserved_write_bytes" :
                      existingBatch[@"reserved_write_bytes"] ?: @0,
                  @"reservation_delta_bytes" :
                      existingBatch[@"reservation_delta_bytes"] ?: @0,
                  @"attempt_reserved_write_bytes" :
                      existingBatch[@"attempt_reserved_write_bytes"] ?: @0,
                  @"reservation_version" :
                      existingBatch[@"reservation_version"] ?: @0,
                  @"effect_gate" : existingBatch[@"effect_gate"] };
      return NO;
    }
    NSMutableArray *reservations = [state[@"reservations"] mutableCopy];
    NSMutableDictionary *reservation = nil;
    NSUInteger reservationIndex = NSNotFound;
    for (NSUInteger index = 0; index < reservations.count; index += 1) {
      NSMutableDictionary *candidate = [reservations[index] mutableCopy];
      if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        reservation = candidate;
        reservationIndex = index;
        break;
      }
    }
    if (reservation == nil) {
      reservation = [@{
        @"schema_version" : @1,
        @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"root_fingerprint_sha256" : request[@"root_fingerprint_sha256"],
        @"binding_revision" : request[@"binding_revision"],
        @"policy" : request[@"policy"],
        @"reserved_write_bytes" : @0,
        @"reservation_version" : @0,
        @"keys" : @[],
      } mutableCopy];
    } else if (![reservation[@"root_fingerprint_sha256"]
                   isEqual:request[@"root_fingerprint_sha256"]] ||
               ![reservation[@"binding_revision"] isEqual:request[@"binding_revision"]] ||
               ![reservation[@"policy"] isEqual:request[@"policy"]]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSUInteger reserved = [reservation[@"reserved_write_bytes"] unsignedIntegerValue];
    if (reserved != [request[@"expected_reserved_write_bytes"] unsignedIntegerValue]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSMutableArray *reservationKeys = [reservation[@"keys"] mutableCopy];
    NSUInteger batchNew = 0;
    for (NSDictionary *write in request[@"writes"]) {
      NSUInteger priorIndex = NSNotFound;
      for (NSUInteger index = 0; index < reservationKeys.count; index += 1) {
        if ([reservationKeys[index][@"idempotency_key"]
                isEqual:write[@"idempotency_key"]]) {
          priorIndex = index;
          break;
        }
      }
      if (priorIndex != NSNotFound) {
        NSDictionary *prior = reservationKeys[priorIndex];
        if (![prior[@"relative_path_sha256"] isEqual:write[@"relative_path_sha256"]] ||
            ![prior[@"content_sha256"] isEqual:write[@"content_sha256"]] ||
            ![prior[@"content_bytes"] isEqual:write[@"content_bytes"]]) {
          DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        if ([prior[@"state"] isEqualToString:@"released"]) {
          batchNew += [write[@"content_bytes"] unsignedIntegerValue];
        }
        reservationKeys[priorIndex] = @{
          @"idempotency_key" : write[@"idempotency_key"],
          @"relative_path_sha256" : write[@"relative_path_sha256"],
          @"content_sha256" : write[@"content_sha256"],
          @"content_bytes" : write[@"content_bytes"],
          @"state" : @"active",
        };
      } else {
        batchNew += [write[@"content_bytes"] unsignedIntegerValue];
        [reservationKeys addObject:@{
          @"idempotency_key" : write[@"idempotency_key"],
          @"relative_path_sha256" : write[@"relative_path_sha256"],
          @"content_sha256" : write[@"content_sha256"],
          @"content_bytes" : write[@"content_bytes"],
          @"state" : @"active",
        }];
      }
    }
    NSUInteger maxBatch = [request[@"policy"][@"max_batch_write_bytes"] unsignedIntegerValue];
    NSUInteger maxAttempt = [request[@"policy"][@"max_attempt_write_bytes"] unsignedIntegerValue];
    if (batchNew > maxBatch || reserved > maxAttempt ||
        batchNew > maxAttempt - reserved) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    reserved += batchNew;
    NSUInteger reservationVersion = [reservation[@"reservation_version"] unsignedIntegerValue];
    if (reservationVersion == DSHAgentMaximumSafeInteger) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    reservationVersion += 1;
    reservation[@"reserved_write_bytes"] = @(reserved);
    reservation[@"reservation_version"] = @(reservationVersion);
    reservation[@"keys"] = reservationKeys;
    if (reservationIndex == NSNotFound) [reservations addObject:reservation];
    else reservations[reservationIndex] = reservation;

    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    NSMutableArray *intentResults = [NSMutableArray array];
    for (NSDictionary *intent in request[@"intents"]) {
      NSUInteger existingIndex = NSNotFound;
      for (NSUInteger index = 0; index < rows.count; index += 1) {
        if ([rows[index][@"locator"] isEqual:intent[@"locator"]]) {
          existingIndex = index;
          break;
        }
      }
      if (existingIndex != NSNotFound) {
        NSError *leftError = nil;
        NSData *left = DSHAgentCanonicalJSON(rows[existingIndex], &leftError);
        NSData *right = DSHAgentCanonicalJSON(intent, &leftError);
        if (left == nil || right == nil || ![left isEqualToData:right]) {
          DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        [intentResults addObject:rows[existingIndex]];
        continue;
      }
      if (!DSHAgentLedgerTranscriptBound(state, intent, mutationError)) return NO;
      NSError *immutableIntentError = nil;
      NSDictionary *immutableIntent = DSHAgentImmutableJSONCopy(
          intent, &immutableIntentError);
      if (![immutableIntent isKindOfClass:NSDictionary.class]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      [rows addObject:immutableIntent];
      [dispatch addObject:@{
        @"schema_version" : @1,
        @"kind" : @"execution",
        @"locator" : [intent[@"locator"] copy],
        @"dispatch_state" : @"not_dispatched",
      }];
      [intentResults addObject:immutableIntent];
    }
    NSDictionary *firstLocator = [request[@"intents"] firstObject][@"locator"];
    [batches addObject:@{
      @"schema_version" : @2,
      @"kind" : @"write_batch",
      @"task_id" : request[@"task_id"],
      @"attempt_id" : request[@"attempt_id"],
      @"round_id" : firstLocator[@"round_id"],
      @"round_index" : firstLocator[@"round_index"],
      @"batch_revision" : @(reservationVersion),
      @"root_fingerprint_sha256" : request[@"root_fingerprint_sha256"],
      @"binding_revision" : request[@"binding_revision"],
      @"manifest_sha256" : manifest,
      @"manifest_calls" : [manifestCalls copy],
      @"write_keys" : [request[@"writes"] valueForKey:@"idempotency_key"],
      @"reserved_write_bytes" : @(reserved),
      @"reservation_delta_bytes" : @(batchNew),
      @"attempt_reserved_write_bytes" : @(reserved),
      @"effect_gate" : @"closed",
      @"created_at" : [self.wal currentTimestamp],
      @"updated_at" : [self.wal currentTimestamp],
    }];
    state[@"reservations"] = reservations;
    state[@"ledger"] = rows;
    state[@"dispatch"] = dispatch;
    state[@"batches"] = batches;
    output = @{ @"schema_version" : @1,
                @"status" : @"prepared",
                @"manifest_sha256" : manifest,
                @"reserved_write_bytes" : @(reserved),
                @"reservation_delta_bytes" : @(batchNew),
                @"attempt_reserved_write_bytes" : @(reserved),
                @"reservation_version" : @(reservationVersion),
                @"effect_gate" : @"closed",
                @"intents" : intentResults };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)prepareAgentToolBatchWithRequest:(NSDictionary *)request
                                               error:(NSError **)error {
  NSArray *baseKeys = @[
        @"schema_version", @"task_id", @"attempt_id", @"round_id",
        @"round_index", @"round_revision", @"root", @"transcript",
        @"policy", @"expected_batch_revision",
        @"expected_reserved_write_bytes", @"calls",
      ];
  BOOL compoundOperation = request[@"operation_id"] != nil;
  NSMutableArray *requestKeys = [baseKeys mutableCopy];
  if (compoundOperation) {
    [requestKeys addObjectsFromArray:@[
      @"operation_id", @"operation_request_sha256", @"conversation_id",
      @"controller_cas", @"observed_checkpoint",
    ]];
  }
  if (!DSHAgentExactDictionaryKeys(request, requestKeys) ||
      ![request[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(request[@"round_id"]) ||
      !DSHAgentSafeInteger(request[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(request[@"round_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentLedgerRootFull(request[@"root"]) ||
      !DSHAgentLedgerReference(request[@"transcript"]) ||
      !DSHAgentWriteReservationPolicy(request[@"policy"]) ||
      !DSHAgentSafeInteger(request[@"expected_batch_revision"],
                          DSHAgentMaximumSafeInteger, YES) ||
      !DSHAgentSafeInteger(request[@"expected_reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      ![request[@"calls"] isKindOfClass:NSArray.class] ||
      [(NSArray *)request[@"calls"] count] == 0 ||
      [(NSArray *)request[@"calls"] count] > 16 ||
      (compoundOperation &&
       (!DSHAgentCanonicalUUID(request[@"operation_id"]) ||
        !DSHAgentCanonicalSHA256(request[@"operation_request_sha256"]) ||
        !DSHAgentCanonicalUUID(request[@"conversation_id"]) ||
        ![request[@"controller_cas"] isKindOfClass:NSDictionary.class] ||
        ![request[@"observed_checkpoint"] isKindOfClass:NSDictionary.class]))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }

  NSString *timestamp = [self.wal currentTimestamp];
  NSMutableArray<NSDictionary *> *intents = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *projections = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *deniedCandidates = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *manifestCalls = [NSMutableArray array];
  NSMutableArray<NSString *> *writeKeys = [NSMutableArray array];
  NSMutableSet<NSString *> *callIDs = [NSMutableSet set];
  NSMutableSet<NSString *> *writePaths = [NSMutableSet set];
  NSDictionary *root = request[@"root"];
  NSDictionary *transcript = request[@"transcript"];

  for (NSUInteger index = 0; index < [(NSArray *)request[@"calls"] count];
       index += 1) {
    NSDictionary *suppliedCall = request[@"calls"][index];
    // A refused call arrives with a `rejection` the batch service attached;
    // it is validated here and never becomes an executable intent.
    NSDictionary *rejection = nil;
    NSDictionary *call = suppliedCall;
    if (suppliedCall[@"rejection"] != nil) {
      NSMutableDictionary *withoutRejection = [suppliedCall mutableCopy];
      [withoutRejection removeObjectForKey:@"rejection"];
      call = [withoutRejection copy];
      if (suppliedCall[@"rejection"] != NSNull.null) {
        rejection = suppliedCall[@"rejection"];
        if (!DSHAgentLedgerRejection(rejection)) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
          return nil;
        }
      }
    }
    NSMutableArray *callKeys = [@[
          @"call_index", @"call_id", @"name", @"arguments_json",
          @"arguments_sha256", @"safe_summary_key", @"access",
          @"precondition", @"reserved_write_bytes",
        ] mutableCopy];
    if (compoundOperation) [callKeys addObject:@"grant_reference"];
    // The display preview is optional on the prepared call: the batch
    // service always supplies it (null for calls without one), while direct
    // ledger callers may omit it.
    NSMutableArray *callKeysWithPreview = [callKeys mutableCopy];
    [callKeysWithPreview addObject:@"approval_preview"];
    id approvalPreview = call[@"approval_preview"] ?: NSNull.null;
    if (!(DSHAgentExactDictionaryKeys(call, callKeys) ||
          DSHAgentExactDictionaryKeys(call, callKeysWithPreview)) ||
        ![call[@"call_index"] isEqual:@(index)] ||
        !DSHAgentBoundedUTF8String(call[@"call_id"], 128, NO, nullptr) ||
        !DSHAgentToolName(call[@"name"]) ||
        !DSHAgentBoundedUTF8String(call[@"arguments_json"],
                                  256 * 1024, NO, nullptr) ||
        !DSHAgentCanonicalSHA256(call[@"arguments_sha256"]) ||
        !DSHAgentBoundedUTF8String(call[@"safe_summary_key"], 128, NO,
                                  nullptr) ||
        ![call[@"access"] isKindOfClass:NSString.class] ||
        !DSHAgentSafeInteger(call[@"reserved_write_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
        (approvalPreview != NSNull.null &&
         !DSHAgentApprovalPreview(approvalPreview)) ||
        (compoundOperation &&
         !(call[@"grant_reference"] == NSNull.null ||
           DSHAgentCanonicalUUID(call[@"grant_reference"]))) ||
        [callIDs containsObject:call[@"call_id"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    [callIDs addObject:call[@"call_id"]];
    NSString *access = call[@"access"];
    BOOL durableDeny = [access isEqualToString:@"durable_deny"];
    if (!durableDeny && ![access isEqualToString:@"auto"] &&
        ![access isEqualToString:@"conversation_confirm"] &&
        ![access isEqualToString:@"confirm_once"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    if (durableDeny) {
      if (call[@"precondition"] != NSNull.null ||
          ![call[@"reserved_write_bytes"] isEqual:@0]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return nil;
      }
      NSMutableDictionary *deniedProjection = [@{
        @"schema_version" : @2,
        @"call_index" : call[@"call_index"], @"call_id" : call[@"call_id"],
        @"name" : call[@"name"],
        @"arguments_sha256" : call[@"arguments_sha256"],
        @"idempotency_key" : NSNull.null,
        @"safe_summary_key" : @"agent.unknown",
        @"access" : @"durable_deny",
        @"approval_state" : @"denied",
        @"approval_token" : NSNull.null,
        @"approval_reference" : NSNull.null,
        @"execution_status" : @"denied",
        @"execution_revision" : NSNull.null,
        @"native_row_revision" : NSNull.null,
        @"receipt" : NSNull.null,
        @"approval_preview" : NSNull.null,
      } mutableCopy];
      [projections addObject:deniedProjection];
      [deniedCandidates addObject:@{
        @"call" : call,
        @"projection" : deniedProjection,
        @"failure_code" : [@[
          @"list_dir", @"read_file", @"write_file", @"git_status",
          @"git_commit", @"git_push", @"start_guest_cgi", @"stop_guest_cgi",
        ] containsObject:call[@"name"]]
            ? @"E_AGENT_CAPABILITY" : @"E_AGENT_UNKNOWN_TOOL",
      }];
      continue;
    }
    if (rejection != nil) {
      if (call[@"precondition"] != NSNull.null ||
          ![call[@"reserved_write_bytes"] isEqual:@0]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return nil;
      }
      NSError *rejectedArgumentsError = nil;
      NSString *rejectedSHA = DSHAgentArgumentsSHA256(
          call[@"name"], call[@"arguments_json"], &rejectedArgumentsError);
      if (rejectedSHA == nil || ![rejectedSHA isEqual:call[@"arguments_sha256"]]) {
        if (error != nullptr) *error = rejectedArgumentsError ?:
            DSHAgentNativeStoreError(DSHAgentNativeStoreErrorConflict);
        return nil;
      }
      NSMutableDictionary *rejectedLocator = [@{
        @"schema_version" : @2,
        @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"round_id" : request[@"round_id"],
        @"round_index" : request[@"round_index"],
        @"call_index" : call[@"call_index"],
        @"call_id" : call[@"call_id"],
        @"idempotency_key" :
            @"0000000000000000000000000000000000000000000000000000000000000000",
      } mutableCopy];
      NSString *rejectedKey = DSHAgentIdempotencyKeyForLocator(
          rejectedLocator, root[@"root_fingerprint_sha256"], rejectedSHA, error);
      if (rejectedKey == nil) return nil;
      NSMutableDictionary *rejectedProjection = [@{
        @"schema_version" : @2,
        @"call_index" : call[@"call_index"], @"call_id" : call[@"call_id"],
        @"name" : call[@"name"], @"arguments_sha256" : rejectedSHA,
        @"idempotency_key" : rejectedKey,
        @"safe_summary_key" : call[@"safe_summary_key"], @"access" : access,
        // No approval is ever issued for a refused call: a gated one settles
        // with its approval cancelled and no token, never pending.
        @"approval_state" : [access isEqualToString:@"auto"]
            ? @"not_required" : @"cancelled",
        @"approval_token" : NSNull.null,
        @"approval_reference" : NSNull.null,
        @"execution_status" : @"failed", @"execution_revision" : @1,
        @"native_row_revision" : NSNull.null, @"receipt" : NSNull.null,
        @"approval_preview" : NSNull.null,
      } mutableCopy];
      [projections addObject:rejectedProjection];
      [deniedCandidates addObject:@{
        @"call" : call,
        @"projection" : rejectedProjection,
        @"outcome" : @"failed",
        @"failure_code" : rejection[@"failure_code"],
        @"reason" : rejection[@"reason"],
      }];
      continue;
    }
    NSDictionary *precondition = call[@"precondition"];
    if (!DSHAgentPrecondition(precondition) ||
        ![precondition[@"kind"] isEqual:call[@"name"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
    NSError *argumentsError = nil;
    NSString *argumentsSHA = DSHAgentArgumentsSHA256(
        call[@"name"], call[@"arguments_json"], &argumentsError);
    if (argumentsSHA == nil || ![argumentsSHA isEqual:call[@"arguments_sha256"]]) {
      if (error != nullptr) *error = argumentsError ?:
          DSHAgentNativeStoreError(DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    NSMutableDictionary *locator = [@{
      @"schema_version" : @2,
      @"task_id" : request[@"task_id"],
      @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"],
      @"round_index" : request[@"round_index"],
      @"call_index" : call[@"call_index"],
      @"call_id" : call[@"call_id"],
      @"idempotency_key" :
          @"0000000000000000000000000000000000000000000000000000000000000000",
    } mutableCopy];
    NSString *key = DSHAgentIdempotencyKeyForLocator(
        locator, root[@"root_fingerprint_sha256"], argumentsSHA, error);
    if (key == nil) return nil;
    locator[@"idempotency_key"] = key;
    NSDictionary *intent = @{
      @"schema_version" : @2, @"locator" : locator, @"row_revision" : @1,
      @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
      @"binding_revision" : root[@"workspace_binding_revision"],
      @"transcript_before" : transcript, @"name" : call[@"name"],
      @"arguments_sha256" : argumentsSHA, @"precondition" : precondition,
      @"reserved_write_bytes" : call[@"reserved_write_bytes"],
      @"state" : @"intent", @"owner" : NSNull.null,
      @"settled_facts" : NSNull.null, @"transcript_after" : NSNull.null,
      @"receipt" : NSNull.null, @"created_at" : timestamp,
      @"updated_at" : timestamp,
    };
    NSError *bindingError = nil;
    if (!DSHAgentLedgerRow(intent) ||
        !DSHAgentRawArgumentsBindIntent(call[@"arguments_json"], intent,
                                        &bindingError)) {
      if (error != nullptr) *error = bindingError ?:
          DSHAgentNativeStoreError(DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    [intents addObject:intent];
    BOOL fileMutation = [call[@"name"] isEqualToString:@"write_file"];
    BOOL gitMutation = [call[@"name"] isEqualToString:@"git_commit"] ||
        [call[@"name"] isEqualToString:@"git_push"] || [call[@"name"] isEqualToString:@"start_guest_cgi"] || [call[@"name"] isEqualToString:@"stop_guest_cgi"];
    if (fileMutation || gitMutation) {
      if (fileMutation) {
        NSString *pathDigest = precondition[@"relative_path_sha256"];
        if ([writePaths containsObject:pathDigest] ||
            ![call[@"reserved_write_bytes"]
                isEqual:precondition[@"content_bytes"]] ||
            [precondition[@"prior"][@"kind"] isEqualToString:@"unknown"]) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
          return nil;
        }
        [writePaths addObject:pathDigest];
      } else if (![call[@"reserved_write_bytes"] isEqual:@0]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
        return nil;
      }
      NSDictionary *manifestCall = DSHAgentWriteManifestCallForIntent(intent);
      if (!DSHAgentWriteManifestCallShape(manifestCall)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
        return nil;
      }
      [manifestCalls addObject:manifestCall];
      [writeKeys addObject:key];
    } else if (![call[@"reserved_write_bytes"] isEqual:@0]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    [projections addObject:[@{
      @"schema_version" : @2,
      @"call_index" : call[@"call_index"], @"call_id" : call[@"call_id"],
      @"name" : call[@"name"], @"arguments_sha256" : argumentsSHA,
      @"idempotency_key" : key,
      @"safe_summary_key" : call[@"safe_summary_key"], @"access" : access,
      @"approval_state" : [access isEqualToString:@"auto"]
          ? @"not_required" : @"pending",
      @"approval_token" : NSNull.null,
      @"approval_reference" : NSNull.null,
      @"execution_status" : @"intent", @"execution_revision" : @1,
      @"native_row_revision" : @1, @"receipt" : NSNull.null,
      @"approval_preview" : call[@"approval_preview"] ?: NSNull.null,
    } mutableCopy]];
  }

  NSDictionary *snapshot = [self.wal snapshotWithError:error];
  if (snapshot == nil) return nil;
  for (NSDictionary *existingBatch in snapshot[@"batches"]) {
    if (![existingBatch[@"task_id"] isEqual:request[@"task_id"]] ||
        ![existingBatch[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
        ![existingBatch[@"round_id"] isEqual:request[@"round_id"]] ||
        ![existingBatch[@"round_index"] isEqual:request[@"round_index"]]) {
      continue;
    }
    BOOL sameManifest = manifestCalls.count == 0
        ? existingBatch[@"manifest_sha256"] == NSNull.null
        : [existingBatch[@"manifest_calls"] isEqual:manifestCalls];
    if (!sameManifest) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    NSDictionary *replayTranscript = transcript;
    for (NSDictionary *denial in snapshot[@"denied_calls"]) {
      if (![denial[@"task_id"] isEqual:request[@"task_id"]] ||
          ![denial[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
          ![denial[@"round_id"] isEqual:request[@"round_id"]] ||
          ![denial[@"round_index"] isEqual:request[@"round_index"]]) continue;
      for (NSMutableDictionary *projection in projections) {
        if ([projection[@"call_index"] isEqual:denial[@"call_index"]] &&
            [projection[@"call_id"] isEqual:denial[@"call_id"]] &&
            [projection[@"arguments_sha256"]
                isEqual:denial[@"arguments_sha256"]]) {
          projection[@"native_row_revision"] = denial[@"row_revision"];
          projection[@"receipt"] = denial[@"receipt"];
          if ([denial[@"transcript_after"][@"generation"] unsignedIntegerValue] >
              [replayTranscript[@"generation"] unsignedIntegerValue]) {
            replayTranscript = denial[@"transcript_after"];
          }
        }
      }
    }
    return @{
      @"schema_version" : @2, @"status" : @"already_prepared",
      @"batch_kind" : existingBatch[@"kind"],
      @"batch_revision" : existingBatch[@"batch_revision"],
      @"manifest_sha256" : existingBatch[@"manifest_sha256"],
      @"batch_new_write_bytes" : existingBatch[@"reservation_delta_bytes"],
      @"reserved_write_bytes" : existingBatch[@"attempt_reserved_write_bytes"],
      @"effect_gate" : existingBatch[@"effect_gate"], @"calls" : projections,
      @"transcript" : replayTranscript,
    };
  }

  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    NSMutableArray *batches = [state[@"batches"] mutableCopy];
    NSMutableArray *reservations = [state[@"reservations"] mutableCopy];
    NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
    NSMutableArray *deniedRows = [state[@"denied_calls"] mutableCopy];
    if (rows == nil || dispatch == nil || batches == nil || reservations == nil ||
        transcripts == nil || deniedRows == nil) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSDictionary *frozenRound = nil;
    for (NSDictionary *candidate in state[@"rounds"]) {
      NSDictionary *locator = candidate[@"locator"];
      if ([locator[@"task_id"] isEqual:request[@"task_id"]] &&
          [locator[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
          [locator[@"round_id"] isEqual:request[@"round_id"]] &&
          [locator[@"round_index"] isEqual:request[@"round_index"]]) {
        if (frozenRound != nil) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        frozenRound = candidate;
      }
    }
    if (compoundOperation &&
        (frozenRound == nil ||
         ![frozenRound[@"state"] isEqualToString:@"completed"] ||
         ![frozenRound[@"row_revision"] isEqual:request[@"round_revision"]] ||
         ![frozenRound[@"transcript_after"] isEqual:transcript] ||
         ![frozenRound[@"terminal_kind"] isEqualToString:@"tool_batch"])) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    for (NSDictionary *batch in batches) {
      if ([batch[@"task_id"] isEqual:request[@"task_id"]] &&
          [batch[@"attempt_id"] isEqual:request[@"attempt_id"]] &&
          [batch[@"round_id"] isEqual:request[@"round_id"]] &&
          [batch[@"round_index"] isEqual:request[@"round_index"]]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
    }
    // Batch revisions are opaque authorities, not counters. A read-only
    // batch uses its round revision while a mutation batch uses the write
    // reservation version, so the numeric value may stay flat or decrease.
    // Validate against the most recently committed batch for this attempt in
    // WAL order while holding the atomic transaction. With no prior batch,
    // the only valid authority is the initial revision zero.
    NSDictionary *latestAttemptBatch = nil;
    for (NSDictionary *batch in batches) {
      if ([batch[@"task_id"] isEqual:request[@"task_id"]] &&
          [batch[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        latestAttemptBatch = batch;
      }
    }
    NSNumber *expectedPriorBatchRevision = latestAttemptBatch == nil
        ? @0 : latestAttemptBatch[@"batch_revision"];
    if (![request[@"expected_batch_revision"]
            isEqual:expectedPriorBatchRevision]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSUInteger existingAttemptRows = 0;
    for (NSDictionary *row in rows) {
      if ([row[@"locator"][@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        existingAttemptRows += 1;
      }
      for (NSDictionary *intent in intents) {
        if ([row[@"locator"] isEqual:intent[@"locator"]]) {
          DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
          return NO;
        }
      }
    }
    if (existingAttemptRows + intents.count >
        DSHAgentNativeWALMaxLedgerRowsPerAttempt) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    for (NSDictionary *intent in intents) {
      if (!DSHAgentLedgerTranscriptBound(state, intent, mutationError)) return NO;
    }

    NSMutableDictionary *transcriptRow = nil;
    NSUInteger transcriptIndex = NSNotFound;
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSDictionary *candidate = transcripts[index];
      if ([candidate[@"transcript_ref"] isEqual:transcript[@"transcript_ref"]]) {
        transcriptRow = [candidate mutableCopy];
        transcriptIndex = index;
        break;
      }
    }
    if (transcriptRow == nil ||
        ![transcriptRow[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
        ![transcriptRow[@"root_fingerprint_sha256"]
            isEqual:root[@"root_fingerprint_sha256"]] ||
        ![transcriptRow[@"generation"] isEqual:transcript[@"generation"]] ||
        ![transcriptRow[@"transcript_sha256"]
            isEqual:transcript[@"transcript_sha256"]] ||
        ![transcriptRow[@"transcript_bytes"]
            isEqual:transcript[@"transcript_bytes"]] ||
        ![transcriptRow[@"state"] isEqualToString:@"open"]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }

    NSMutableDictionary *reservation = nil;
    NSUInteger reservationIndex = NSNotFound;
    for (NSUInteger index = 0; index < reservations.count; index += 1) {
      NSDictionary *candidate = reservations[index];
      if ([candidate[@"task_id"] isEqual:request[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
        reservation = [candidate mutableCopy];
        reservationIndex = index;
        break;
      }
    }
    BOOL reservationWasAbsent = reservation == nil;
    if (reservation == nil) {
      reservation = [@{
        @"schema_version" : @1, @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
        @"binding_revision" : root[@"workspace_binding_revision"],
        @"policy" : request[@"policy"], @"reserved_write_bytes" : @0,
        @"reservation_version" : @0, @"keys" : @[],
      } mutableCopy];
    } else if (![reservation[@"root_fingerprint_sha256"]
                    isEqual:root[@"root_fingerprint_sha256"]] ||
               ![reservation[@"binding_revision"]
                    isEqual:root[@"workspace_binding_revision"]] ||
               ![reservation[@"policy"] isEqual:request[@"policy"]]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSUInteger reserved = [reservation[@"reserved_write_bytes"] unsignedIntegerValue];
    if (reserved != [request[@"expected_reserved_write_bytes"] unsignedIntegerValue]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSMutableArray *keys = [reservation[@"keys"] mutableCopy];
    NSUInteger batchNew = 0;
    for (NSDictionary *manifestCall in manifestCalls) {
      if (![manifestCall[@"mutation_kind"] isEqualToString:@"file_write"]) {
        continue;
      }
      NSString *idempotencyKey = manifestCall[@"locator"][@"idempotency_key"];
      NSDictionary *existingKey = nil;
      for (NSDictionary *candidate in keys) {
        if ([candidate[@"idempotency_key"] isEqual:idempotencyKey]) {
          existingKey = candidate;
          break;
        }
      }
      NSDictionary *candidate = @{
        @"idempotency_key" : idempotencyKey,
        @"relative_path_sha256" : manifestCall[@"relative_path_sha256"],
        @"content_sha256" : manifestCall[@"content_sha256"],
        @"content_bytes" : manifestCall[@"content_bytes"], @"state" : @"active",
      };
      if (existingKey != nil) {
        if (![existingKey isEqual:candidate]) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
      } else {
        [keys addObject:candidate];
        batchNew += [manifestCall[@"content_bytes"] unsignedIntegerValue];
      }
    }
    NSUInteger maxBatch = [request[@"policy"][@"max_batch_write_bytes"]
        unsignedIntegerValue];
    NSUInteger maxAttempt = [request[@"policy"][@"max_attempt_write_bytes"]
        unsignedIntegerValue];
    if (batchNew > maxBatch || reserved > maxAttempt ||
        batchNew > maxAttempt - reserved) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    reserved += batchNew;
    NSUInteger reservationVersion = [reservation[@"reservation_version"]
        unsignedIntegerValue];
    if (manifestCalls.count > 0) {
      if (reservationVersion == DSHAgentMaximumSafeInteger) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      reservationVersion += 1;
    }
    NSUInteger batchRevision = manifestCalls.count > 0
        ? reservationVersion : [request[@"round_revision"] unsignedIntegerValue];
    if (manifestCalls.count > 0) {
      reservation[@"reserved_write_bytes"] = @(reserved);
      reservation[@"reservation_version"] = @(reservationVersion);
      reservation[@"keys"] = keys;
      if (reservationIndex == NSNotFound) [reservations addObject:reservation];
      else reservations[reservationIndex] = reservation;
    } else if (reservationWasAbsent && reserved != 0) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }

    for (NSDictionary *intent in intents) {
      [rows addObject:intent];
      [dispatch addObject:@{
        @"schema_version" : @1, @"kind" : @"execution",
        @"locator" : intent[@"locator"], @"dispatch_state" : @"not_dispatched",
      }];
    }
    if (deniedCandidates.count > 0) {
      NSUInteger attemptDenials = 0;
      for (NSDictionary *existing in deniedRows) {
        if ([existing[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
          attemptDenials += 1;
        }
      }
      if (attemptDenials + deniedCandidates.count >
              DSHAgentNativeWALMaxDeniedCallsPerAttempt ||
          deniedRows.count + deniedCandidates.count >
              DSHAgentNativeWALMaxDeniedCalls) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      NSMutableArray *messages = [transcriptRow[@"messages"] mutableCopy];
      NSDictionary *currentReference = [transcript copy];
      for (NSDictionary *candidate in deniedCandidates) {
        NSDictionary *call = candidate[@"call"];
        NSString *candidateOutcome = candidate[@"outcome"] ?: @"denied";
        NSMutableDictionary *feedbackPayload = [@{
          @"schema_version" : @1,
          @"failure_code" : candidate[@"failure_code"],
        } mutableCopy];
        if (candidate[@"reason"] != nil) feedbackPayload[@"reason"] = candidate[@"reason"];
        NSDictionary *feedback = @{
          @"schema_version" : @1, @"name" : call[@"name"],
          @"outcome" : candidateOutcome,
          @"payload" : [feedbackPayload copy],
        };
        NSError *feedbackError = nil;
        NSData *feedbackBytes = DSHAgentCanonicalJSON(feedback, &feedbackError);
        NSString *feedbackString = feedbackBytes == nil ? nil
            : [[NSString alloc] initWithData:feedbackBytes
                                     encoding:NSUTF8StringEncoding];
        NSString *feedbackSHA = feedbackBytes == nil ? nil
            : DSHAgentHB(@"tool-result", feedbackBytes, &feedbackError);
        if (feedbackString == nil || feedbackSHA == nil ||
            feedbackBytes.length > 8 * 1024 ||
            !DSHAgentValidateNativeToolFeedbackString(feedbackString,
                                                       &feedbackError)) {
          if (mutationError != nullptr) *mutationError = feedbackError ?:
              DSHAgentNativeStoreError(DSHAgentNativeStoreErrorInvalidArgument);
          return NO;
        }
        NSDictionary *message = @{
          @"schema_version" : @1, @"role" : @"tool",
          @"round_index" : request[@"round_index"],
          @"call_id" : call[@"call_id"], @"content" : feedbackString,
          @"truncated" : @NO,
        };
        [messages addObject:message];
        NSUInteger generation = [transcriptRow[@"generation"] unsignedIntegerValue];
        if (generation == DSHAgentMaximumSafeInteger) {
          DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
          return NO;
        }
        generation += 1;
        NSDictionary *digestInput = @{
          @"schema_version" : @1,
          @"transcript_ref" : transcriptRow[@"transcript_ref"],
          @"attempt_id" : transcriptRow[@"attempt_id"],
          @"root_fingerprint_sha256" : transcriptRow[@"root_fingerprint_sha256"],
          @"generation" : @(generation), @"messages" : messages,
        };
        NSError *digestError = nil;
        NSData *transcriptBytes = DSHAgentCanonicalJSON(digestInput, &digestError);
        NSString *transcriptSHA = DSHAgentHJ(@"agent-transcript", digestInput,
                                             &digestError);
        if (transcriptSHA == nil || transcriptBytes.length >
                DSHAgentNativeWALMaxTranscriptBytes) {
          if (mutationError != nullptr) *mutationError = digestError ?:
              DSHAgentNativeStoreError(DSHAgentNativeStoreErrorCapacity);
          return NO;
        }
        transcriptRow[@"messages"] = [messages copy];
        transcriptRow[@"generation"] = @(generation);
        transcriptRow[@"transcript_sha256"] = transcriptSHA;
        transcriptRow[@"transcript_bytes"] = @(transcriptBytes.length);
        transcriptRow[@"updated_at"] = [self.wal currentTimestamp];
        NSDictionary *after = @{
          @"schema_version" : @1,
          @"transcript_ref" : transcriptRow[@"transcript_ref"],
          @"generation" : @(generation),
          @"transcript_sha256" : transcriptSHA,
          @"transcript_bytes" : @(transcriptBytes.length),
        };
        NSDictionary *receipt = @{
          @"schema_version" : @1, @"call_id" : call[@"call_id"],
          @"name" : call[@"name"],
          @"arguments_sha256" : call[@"arguments_sha256"],
          @"result_sha256" : feedbackSHA,
          @"result_bytes" : @(feedbackBytes.length), @"truncated" : @NO,
          @"duration_ms" : @0, @"outcome" : candidateOutcome,
          @"failure_code" : candidate[@"failure_code"],
          @"approval_reference" : NSNull.null,
        };
        NSDictionary *deniedRow = @{
          @"schema_version" : @1, @"task_id" : request[@"task_id"],
          @"attempt_id" : request[@"attempt_id"],
          @"round_id" : request[@"round_id"],
          @"round_index" : request[@"round_index"],
          @"call_index" : call[@"call_index"], @"call_id" : call[@"call_id"],
          @"name" : call[@"name"],
          @"arguments_sha256" : call[@"arguments_sha256"],
          @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
          @"binding_revision" : root[@"workspace_binding_revision"],
          @"transcript_before" : currentReference,
          @"state" : [candidateOutcome isEqualToString:@"failed"] ? @"rejected" : @"denied",
          @"row_revision" : @1, @"feedback" : feedback,
          @"transcript_after" : after, @"receipt" : receipt,
          @"created_at" : timestamp, @"updated_at" : timestamp,
        };
        [deniedRows addObject:deniedRow];
        NSMutableDictionary *projection = candidate[@"projection"];
        projection[@"native_row_revision"] = @1;
        projection[@"receipt"] = receipt;
        currentReference = after;
      }
    }
    NSError *manifestError = nil;
    NSString *manifest = manifestCalls.count == 0 ? nil
        : DSHAgentHJ(@"write-manifest", @{ @"calls" : manifestCalls },
                     &manifestError);
    if (manifestCalls.count > 0 && manifest == nil) {
      if (mutationError != nullptr) *mutationError = manifestError;
      return NO;
    }
    NSDictionary *batch = manifestCalls.count == 0 ? @{
      @"schema_version" : @2, @"kind" : @"read_only_batch",
      @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
      @"batch_revision" : @(batchRevision), @"manifest_sha256" : NSNull.null,
      @"reservation_delta_bytes" : @0, @"reserved_write_bytes" : @0,
      @"attempt_reserved_write_bytes" : @(reserved),
      @"effect_gate" : @"not_applicable", @"created_at" : timestamp,
      @"updated_at" : timestamp,
    } : @{
      @"schema_version" : @2, @"kind" : @"write_batch",
      @"task_id" : request[@"task_id"], @"attempt_id" : request[@"attempt_id"],
      @"round_id" : request[@"round_id"], @"round_index" : request[@"round_index"],
      @"batch_revision" : @(batchRevision),
      @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
      @"binding_revision" : root[@"workspace_binding_revision"],
      @"manifest_sha256" : manifest, @"manifest_calls" : manifestCalls,
      @"write_keys" : writeKeys, @"reservation_delta_bytes" : @(batchNew),
      @"reserved_write_bytes" : @(reserved),
      @"attempt_reserved_write_bytes" : @(reserved), @"effect_gate" : @"closed",
      @"created_at" : timestamp, @"updated_at" : timestamp,
    };
    [batches addObject:batch];
    NSDictionary *resultTranscript = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcriptRow[@"transcript_ref"],
      @"generation" : transcriptRow[@"generation"],
      @"transcript_sha256" : transcriptRow[@"transcript_sha256"],
      @"transcript_bytes" : transcriptRow[@"transcript_bytes"],
    };
    if (!DSHAgentLedgerAdvanceAuthority(
            state, request[@"task_id"], request[@"attempt_id"], root,
            transcript, resultTranscript, request[@"policy"],
            request[@"expected_reserved_write_bytes"], @(reserved), YES,
            timestamp, mutationError)) return NO;
    NSNumber *approvalRegistryVersion = [root[@"capabilities"] containsObject:@"guest_service"] ? @2 : @1;
    for (NSDictionary *authority in state[@"authorities"]) {
      if ([authority[@"task_id"] isEqual:request[@"task_id"]] && [authority[@"attempt_id"] isEqual:request[@"attempt_id"]]) approvalRegistryVersion = authority[@"registry"][@"registry_version"];
    }
    state[@"ledger"] = rows;
    state[@"dispatch"] = dispatch;
    state[@"reservations"] = reservations;
    state[@"batches"] = batches;
    if (deniedCandidates.count > 0) {
      transcripts[transcriptIndex] = transcriptRow;
      state[@"transcripts"] = transcripts;
      state[@"denied_calls"] = deniedRows;
    }
    NSDictionary *operationResult = nil;
    if (compoundOperation) {
      NSMutableArray *callIDs = [NSMutableArray arrayWithCapacity:projections.count];
      NSMutableArray *argumentDigests =
          [NSMutableArray arrayWithCapacity:projections.count];
      for (NSDictionary *projection in projections) {
        [callIDs addObject:projection[@"call_id"]];
        [argumentDigests addObject:projection[@"arguments_sha256"]];
      }
      for (NSMutableDictionary *projection in projections) {
        if (![projection[@"approval_state"] isEqualToString:@"pending"]) continue;
        // A call settled at preparation never gets a usable token or grant.
        if (projection[@"receipt"] != NSNull.null) continue;
        NSDictionary *sourceCall = request[@"calls"]
            [[projection[@"call_index"] unsignedIntegerValue]];
        id grantReference = sourceCall[@"grant_reference"];
        if (grantReference != NSNull.null) {
          projection[@"approval_state"] = @"bound";
          projection[@"approval_reference"] = grantReference;
          continue;
        }
        if (manifest == nil) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorConflict);
          return NO;
        }
        BOOL once = [projection[@"access"] isEqualToString:@"confirm_once"];
        projection[@"approval_token"] = @{
          @"schema_version" : @2,
          @"token" : NSUUID.UUID.UUIDString.lowercaseString,
          @"controller_cas" : request[@"controller_cas"],
          @"task_id" : request[@"task_id"],
          @"attempt_id" : request[@"attempt_id"],
          @"round_id" : request[@"round_id"],
          @"round_index" : request[@"round_index"],
          @"batch_call_ids" : callIDs,
          @"batch_arguments_sha256" : argumentDigests,
          @"batch_revision" : @(batchRevision),
          @"manifest_sha256" : manifest,
          @"call_index" : projection[@"call_index"],
          @"call_id" : projection[@"call_id"],
          @"name" : projection[@"name"],
          @"arguments_sha256" : projection[@"arguments_sha256"],
          @"idempotency_key" : projection[@"idempotency_key"],
          @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
          @"binding_revision" : root[@"workspace_binding_revision"],
          @"policy_version" : @"agent-v1", @"registry_version" : approvalRegistryVersion,
          @"access" : projection[@"access"],
          @"allowed_decisions" : once
              ? @[@"denied", @"allow_once", @"cancelled"]
              : @[@"denied", @"allow_once", @"allow_conversation",
                  @"cancelled"],
        };
      }
      NSDictionary *receipt = @{
        @"schema_version" : @2, @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"round_id" : request[@"round_id"],
        @"round_index" : request[@"round_index"],
        @"batch_kind" : batch[@"kind"],
        @"batch_revision" : @(batchRevision),
        @"manifest_sha256" : batch[@"manifest_sha256"],
        @"transcript" : resultTranscript, @"calls" : projections,
        @"batch_new_write_bytes" : @(batchNew),
        @"reserved_write_bytes" : @(reserved),
        @"effect_gate" : batch[@"effect_gate"],
      };
      NSDictionary *result = @{
        @"schema_version" : @2, @"status" : @"prepared",
        @"operation_id" : request[@"operation_id"], @"receipt" : receipt,
        @"observed_checkpoint" : request[@"observed_checkpoint"],
      };
      NSDictionary *safeResult = @{
        @"schema_version" : @2,
        @"result_kind" : @"prepare_agent_tool_batch", @"result" : result,
      };
      NSDictionary *resultRef = @{
        @"schema_version" : @2, @"kind" : @"batch",
        @"task_id" : request[@"task_id"],
        @"attempt_id" : request[@"attempt_id"],
        @"round_id" : request[@"round_id"],
        @"round_index" : request[@"round_index"],
        @"batch_revision" : @(batchRevision),
      };
      NSDictionary *committedOperation =
          DSHAgentNativeWALCommitOperationInState(
              state, self.wal, request[@"operation_id"],
              request[@"operation_request_sha256"], request[@"task_id"],
              request[@"attempt_id"], @"committed", @"prepared", resultRef,
              @(batchRevision), safeResult, mutationError);
      if (committedOperation == nil) return NO;
      operationResult = committedOperation[@"result"][@"result"];
    }
    output = @{
      @"schema_version" : @2, @"status" : @"prepared",
      @"batch_kind" : batch[@"kind"], @"batch_revision" : @(batchRevision),
      @"manifest_sha256" : batch[@"manifest_sha256"],
      @"batch_new_write_bytes" : @(batchNew),
      @"reserved_write_bytes" : @(reserved), @"effect_gate" : batch[@"effect_gate"],
      @"calls" : projections,
      @"transcript" : resultTranscript,
      @"operation_result" : operationResult ?: NSNull.null,
    };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)openAgentWriteBatchEffectGateWithRequest:(NSDictionary *)request
                                                       error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"task_id", @"attempt_id", @"round_id",
        @"round_index", @"expected_batch_revision", @"manifest_sha256",
        @"expected_effect_gate",
      ]) || ![request[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(request[@"task_id"]) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(request[@"round_id"]) ||
      !DSHAgentSafeInteger(request[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(request[@"expected_batch_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalSHA256(request[@"manifest_sha256"]) ||
      ![request[@"expected_effect_gate"] isEqualToString:@"closed"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *batches = [state[@"batches"] mutableCopy];
    for (NSUInteger index = 0; index < batches.count; index += 1) {
      NSMutableDictionary *batch = [batches[index] mutableCopy];
      if (![batch[@"task_id"] isEqual:request[@"task_id"]] ||
          ![batch[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
          ![batch[@"round_id"] isEqual:request[@"round_id"]] ||
          ![batch[@"round_index"] isEqual:request[@"round_index"]] ||
          ![batch[@"batch_revision"]
              isEqual:request[@"expected_batch_revision"]] ||
          ![batch[@"manifest_sha256"] isEqual:request[@"manifest_sha256"]]) continue;
      if ([batch[@"effect_gate"] isEqualToString:@"open"]) {
        output = @{ @"schema_version" : @1,
                    @"status" : @"already_open",
                    @"manifest_sha256" : batch[@"manifest_sha256"],
                    @"effect_gate" : @"open" };
        return NO;
      }
      if (![batch[@"effect_gate"] isEqualToString:@"closed"]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      // Revalidate the complete frozen manifest, every intent row, every
      // dispatch marker, and every active reservation in this same
      // transaction immediately before the effect gate opens.
      if (!DSHAgentMutationBatchApprovalsBound(state, batch, mutationError) ||
          !DSHAgentBatchEffectGateRevalidated(state, batch, mutationError)) {
        return NO;
      }
      batch[@"effect_gate"] = @"open";
      batch[@"updated_at"] = [self.wal currentTimestamp];
      batches[index] = batch;
      state[@"batches"] = batches;
      output = @{ @"schema_version" : @1,
                  @"status" : @"open",
                  @"manifest_sha256" : batch[@"manifest_sha256"],
                  @"effect_gate" : @"open" };
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  if (!committed && output != nil && (error == nullptr || *error == nil)) {
    return output;
  }
  return committed ? output : nil;
}

- (NSDictionary *)releaseWriteReservationWithCAS:(NSDictionary *)cas
                                            error:(NSError **)error {
  if (!DSHAgentLedgerCAS(cas)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    NSMutableDictionary *target = nil;
    NSUInteger targetIndex = NSNotFound;
    for (NSUInteger index = 0; index < rows.count; index += 1) {
      NSDictionary *row = rows[index];
      if ([row[@"locator"] isEqual:cas[@"locator"]]) {
        target = DSHAgentLedgerMutable(row);
        targetIndex = index;
        break;
      }
    }
    if (target == nil || !DSHAgentCASMatchesRow(target, cas, mutationError) ||
        ![target[@"state"] isEqualToString:@"intent"] ||
        [target[@"reserved_write_bytes"] unsignedIntegerValue] == 0 ||
        ![DSHAgentLedgerDispatchState(state[@"dispatch"], target[@"locator"])
            isEqualToString:@"not_dispatched"]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (!DSHAgentLedgerTranscriptBound(state, target, mutationError)) return NO;
    NSMutableArray *reservations = [state[@"reservations"] mutableCopy];
    for (NSMutableDictionary *record in reservations) {
      if (![record[@"attempt_id"] isEqual:target[@"locator"][@"attempt_id"]]) continue;
      NSUInteger reserved = [record[@"reserved_write_bytes"] unsignedIntegerValue];
      NSUInteger amount = [target[@"reserved_write_bytes"] unsignedIntegerValue];
      NSMutableArray *keys = [record[@"keys"] mutableCopy];
      NSString *idempotency = target[@"locator"][@"idempotency_key"];
      BOOL didReleaseKey = NO;
      for (NSUInteger index = 0; index < keys.count; index += 1) {
        if ([keys[index][@"idempotency_key"] isEqual:idempotency]) {
          NSMutableDictionary *releasedKey = [keys[index] mutableCopy];
          if (![releasedKey[@"state"] isEqualToString:@"active"] ||
              ![releasedKey[@"content_bytes"] isEqual:@(amount)]) {
            DSHSetAgentNativeStoreError(mutationError,
                                        DSHAgentNativeStoreErrorConflict);
            return NO;
          }
          releasedKey[@"state"] = @"released";
          keys[index] = releasedKey;
          didReleaseKey = YES;
          break;
        }
      }
      if (!didReleaseKey) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      if ([record[@"reservation_version"] unsignedIntegerValue] == DSHAgentMaximumSafeInteger) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      record[@"reservation_version"] = @([record[@"reservation_version"] unsignedIntegerValue] + 1);
      record[@"reserved_write_bytes"] = @(reserved >= amount ? reserved - amount : 0);
      record[@"keys"] = keys;
      NSUInteger rowRevision = [target[@"row_revision"] unsignedIntegerValue];
      if (rowRevision == 9007199254740991ULL) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      target[@"reserved_write_bytes"] = @0;
      target[@"row_revision"] = @(rowRevision + 1);
      target[@"updated_at"] = [self.wal currentTimestamp];
      if (!DSHAgentLedgerRow(target)) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
      rows[targetIndex] = target;
      state[@"reservations"] = reservations;
      state[@"ledger"] = rows;
      NSMutableArray *batches = [state[@"batches"] mutableCopy];
      NSString *attemptId = target[@"locator"][@"attempt_id"];
      NSString *releasedKeyId = target[@"locator"][@"idempotency_key"];
      for (NSUInteger batchIndex = 0; batchIndex < batches.count; batchIndex += 1) {
        NSMutableDictionary *batch = [batches[batchIndex] mutableCopy];
        if (![batch[@"attempt_id"] isEqual:attemptId] ||
            ![batch[@"write_keys"] containsObject:releasedKeyId]) continue;
        NSUInteger batchReserved = [batch[@"reserved_write_bytes"] unsignedIntegerValue];
        batch[@"reserved_write_bytes"] = @(batchReserved >= amount
                                             ? batchReserved - amount : 0);
        if ([batch[@"effect_gate"] isEqualToString:@"closed"] &&
            DSHAgentMutationBatchProvesNoDispatch(state, batch)) {
          batch[@"effect_gate"] = @"released";
        }
        batch[@"updated_at"] = [self.wal currentTimestamp];
        batches[batchIndex] = batch;
      }
      state[@"batches"] = batches;
      output = @{ @"schema_version" : @1,
                  @"status" : @"released",
                  @"reserved_write_bytes" : record[@"reserved_write_bytes"],
                  @"row" : [target copy] };
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)settleAgentExecutionWithCAS:(NSDictionary *)cas
                                          patch:(NSDictionary *)patch
                                         message:(NSDictionary *)message
                                           error:(NSError **)error {
  return [self settleAgentExecutionWithCAS:cas patch:patch message:message
                                  operation:nil error:error];
}

- (NSDictionary *)settleAgentExecutionWithCAS:(NSDictionary *)cas
                                          patch:(NSDictionary *)patch
                                        message:(NSDictionary *)message
                                      operation:(nullable NSDictionary *)operation
                                          error:(NSError **)error {
  NSError *patchError = nil;
  if (!DSHAgentLedgerCAS(cas) ||
      !DSHAgentLedgerPatchKeysAllowed(patch, &patchError) ||
      ![message isKindOfClass:NSDictionary.class] ||
      ![message[@"role"] isKindOfClass:NSString.class] ||
      ![message[@"role"] isEqualToString:@"tool"] ||
      !DSHAgentReceipt(patch[@"receipt"]) ||
      ![patch[@"state"] isKindOfClass:NSString.class] ||
      (![patch[@"state"] isEqualToString:@"settled"] &&
       ![patch[@"state"] isEqualToString:@"ambiguous"]) ||
      (operation != nil &&
       (!DSHAgentExactDictionaryKeys(operation, @[
          @"operation_id", @"request_sha256", @"effect_may_have_occurred",
        ]) || !DSHAgentCanonicalUUID(operation[@"operation_id"]) ||
        !DSHAgentCanonicalSHA256(operation[@"request_sha256"]) ||
        ![operation[@"effect_may_have_occurred"] isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)operation[@"effect_may_have_occurred"]) !=
            CFBooleanGetTypeID()))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSData *feedbackBytes = DSHAgentCanonicalFeedbackBytes(message);
  if (feedbackBytes == nil ||
      !DSHAgentValidateNativeToolFeedbackString(message[@"content"], nullptr)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *feedbackDigestError = nil;
  NSString *feedbackDigest = DSHAgentHB(@"tool-result", feedbackBytes,
                                        &feedbackDigestError);
  if (feedbackDigest == nil ||
      ![patch[@"receipt"][@"result_sha256"] isEqual:feedbackDigest] ||
      ![patch[@"receipt"][@"result_bytes"] isEqual:@(feedbackBytes.length)] ||
      ![patch[@"receipt"][@"truncated"] isEqual:message[@"truncated"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSError *feedbackDecodeError = nil;
  NSDictionary *feedback = [NSJSONSerialization JSONObjectWithData:feedbackBytes
                                                               options:0
                                                                 error:&feedbackDecodeError];
  if (![feedback isKindOfClass:NSDictionary.class] ||
      ![feedback[@"name"] isEqualToString:patch[@"receipt"][@"name"]] ||
      ![feedback[@"outcome"] isEqualToString:patch[@"receipt"][@"outcome"]] ||
      ![message[@"call_id"] isEqual:patch[@"receipt"][@"call_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *feedbackPayload = feedback[@"payload"];
  NSString *feedbackOutcome = feedback[@"outcome"];
  if (![feedbackPayload isKindOfClass:NSDictionary.class] ||
      ([feedbackOutcome isEqualToString:@"ok"] &&
       patch[@"receipt"][@"failure_code"] != NSNull.null) ||
      (![feedbackOutcome isEqualToString:@"ok"] &&
       ![feedbackPayload[@"failure_code"] isEqual:patch[@"receipt"][@"failure_code"]])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if ([feedbackOutcome isEqualToString:@"ok"] &&
      ([feedback[@"name"] isEqualToString:@"read_file"] ||
       [feedback[@"name"] isEqualToString:@"list_dir"]) &&
      ![feedbackPayload[@"truncated"] isEqual:message[@"truncated"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSError *immutableSettlementError = nil;
  NSDictionary *immutableMessage = DSHAgentImmutableJSONCopy(
      message, &immutableSettlementError);
  NSDictionary *immutablePatch = DSHAgentImmutableJSONCopy(
      patch, &immutableSettlementError);
  if (![immutableMessage isKindOfClass:NSDictionary.class] ||
      ![immutablePatch isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  message = immutableMessage;
  patch = immutablePatch;
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
    NSUInteger rowIndex = NSNotFound;
    NSMutableDictionary *row = nil;
    for (NSUInteger index = 0; index < rows.count; index += 1) {
      NSMutableDictionary *candidate = DSHAgentLedgerMutable(rows[index]);
      if ([candidate[@"locator"] isEqual:cas[@"locator"]]) {
        row = candidate;
        rowIndex = index;
        break;
      }
    }
    if (row == nil || !DSHAgentCASMatchesRow(row, cas, mutationError) ||
        (![row[@"state"] isEqualToString:@"running"] &&
         ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
        ![message[@"round_index"] isEqual:row[@"locator"][@"round_index"]] ||
        ![message[@"call_id"] isEqual:row[@"locator"][@"call_id"]] ||
        ![patch[@"receipt"][@"call_id"] isEqual:row[@"locator"][@"call_id"]] ||
        ![patch[@"receipt"][@"name"] isEqual:row[@"name"]] ||
        ![patch[@"receipt"][@"arguments_sha256"] isEqual:row[@"arguments_sha256"]] ||
        ![patch[@"receipt"][@"outcome"] isEqual:feedbackOutcome] ||
        ![DSHAgentLedgerDispatchState(state[@"dispatch"], row[@"locator"])
            isEqualToString:@"dispatched"]) {
      if (mutationError != nullptr && *mutationError == nil) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
      }
      return NO;
    }
    if (!DSHAgentSettledFactsMatchFeedback(row, feedback,
                                           patch[@"settled_facts"])) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (!DSHAgentLedgerTranscriptBound(state, row, mutationError)) return NO;
    NSDictionary *before = row[@"transcript_before"];
    NSMutableDictionary *transcript = nil;
    NSUInteger transcriptIndex = NSNotFound;
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSMutableDictionary *candidate = [transcripts[index] mutableCopy];
      if ([candidate[@"transcript_ref"] isEqual:before[@"transcript_ref"]]) {
        transcript = candidate;
        transcriptIndex = index;
        break;
      }
    }
    NSUInteger currentGeneration = [transcript[@"generation"] unsignedIntegerValue];
    NSUInteger beforeGeneration = [before[@"generation"] unsignedIntegerValue];
    if (transcript == nil || currentGeneration < beforeGeneration ||
        (currentGeneration == beforeGeneration &&
         (![transcript[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] ||
          ![transcript[@"transcript_bytes"] isEqual:before[@"transcript_bytes"]])) ||
        ![transcript[@"state"] isEqualToString:@"open"]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSDictionary *authorityTranscriptBefore = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcript[@"transcript_ref"],
      @"generation" : transcript[@"generation"],
      @"transcript_sha256" : transcript[@"transcript_sha256"],
      @"transcript_bytes" : transcript[@"transcript_bytes"],
    };
    NSMutableArray *messages = [transcript[@"messages"] mutableCopy];
    [messages addObject:[message copy]];
    NSUInteger generation = currentGeneration + 1;
    NSDictionary *input = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcript[@"transcript_ref"],
      @"attempt_id" : transcript[@"attempt_id"],
      @"root_fingerprint_sha256" : transcript[@"root_fingerprint_sha256"],
      @"generation" : @(generation),
      @"messages" : messages,
    };
    NSError *digestError = nil;
    NSData *bytes = DSHAgentCanonicalJSON(input, &digestError);
    NSString *digest = DSHAgentHJ(@"agent-transcript", input, &digestError);
    if (digest == nil || bytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
      if (digest == nil) {
        if (mutationError != nullptr) *mutationError = digestError;
      }
      else DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    transcript[@"messages"] = messages;
    transcript[@"generation"] = @(generation);
    transcript[@"transcript_sha256"] = digest;
    transcript[@"transcript_bytes"] = @(bytes.length);
    transcript[@"updated_at"] = [self.wal currentTimestamp];
    NSDictionary *after = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcript[@"transcript_ref"],
      @"generation" : @(generation),
      @"transcript_sha256" : digest,
      @"transcript_bytes" : @(bytes.length),
    };
    NSMutableDictionary *updated = [row mutableCopy];
    [patch enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
      (void)stop;
      updated[key] = value;
    }];
    updated[@"owner"] = NSNull.null;
    updated[@"transcript_after"] = after;
    NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
    if (revision == 9007199254740991ULL) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    updated[@"row_revision"] = @(revision + 1);
    updated[@"updated_at"] = [self.wal currentTimestamp];
    if (!DSHAgentLedgerRow(updated)) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    if (!DSHAgentLedgerAdvanceAuthority(
            state, row[@"locator"][@"task_id"],
            row[@"locator"][@"attempt_id"],
            @{ @"schema_version" : @1,
               @"root_fingerprint_sha256" : row[@"root_fingerprint_sha256"],
               @"binding_revision" : row[@"binding_revision"] },
            authorityTranscriptBefore, after, nil, nil, nil, NO,
            [self.wal currentTimestamp], mutationError)) return NO;
    rows[rowIndex] = updated;
    transcripts[transcriptIndex] = transcript;
    state[@"ledger"] = rows;
    state[@"transcripts"] = transcripts;
    NSDictionary *safeOperationResult = nil;
    if (operation != nil) {
      NSString *receiptOutcome = updated[@"receipt"][@"outcome"];
      NSString *publicStatus = [receiptOutcome isEqualToString:@"ok"]
          ? @"completed" : receiptOutcome;
      NSDictionary *result = @{
        @"schema_version" : @2, @"status" : publicStatus,
        @"operation_id" : operation[@"operation_id"],
        @"task_id" : updated[@"locator"][@"task_id"],
        @"attempt_id" : updated[@"locator"][@"attempt_id"],
        @"round_id" : updated[@"locator"][@"round_id"],
        @"round_index" : updated[@"locator"][@"round_index"],
        @"call_index" : updated[@"locator"][@"call_index"],
        @"call_id" : updated[@"locator"][@"call_id"],
        @"name" : updated[@"name"],
        @"idempotency_key" : updated[@"locator"][@"idempotency_key"],
        @"result_execution_revision" : updated[@"row_revision"],
        @"transcript" : after, @"receipt" : updated[@"receipt"],
        @"effect_may_have_occurred" : operation[@"effect_may_have_occurred"],
      };
      NSDictionary *safeResult = @{
        @"schema_version" : @2, @"result_kind" : @"execute_agent_tool",
        @"result" : result,
      };
      NSDictionary *resultRef = @{
        @"schema_version" : @2, @"kind" : @"tool",
        @"task_id" : updated[@"locator"][@"task_id"],
        @"attempt_id" : updated[@"locator"][@"attempt_id"],
        @"round_id" : updated[@"locator"][@"round_id"],
        @"round_index" : updated[@"locator"][@"round_index"],
        @"call_index" : updated[@"locator"][@"call_index"],
        @"call_id" : updated[@"locator"][@"call_id"],
        @"execution_revision" : updated[@"row_revision"],
      };
      NSString *terminalState = [publicStatus isEqualToString:@"ambiguous"]
          ? @"ambiguous" : @"committed";
      NSDictionary *committedOperation =
          DSHAgentNativeWALCommitOperationInState(
              state, self.wal, operation[@"operation_id"],
              operation[@"request_sha256"], updated[@"locator"][@"task_id"],
              updated[@"locator"][@"attempt_id"], terminalState, publicStatus,
              resultRef, updated[@"row_revision"], safeResult, mutationError);
      if (committedOperation == nil) return NO;
      safeOperationResult = committedOperation[@"result"][@"result"];
    }
    output = @{ @"schema_version" : @1,
                @"row" : [updated copy], @"transcript" : after,
                @"operation_result" : safeOperationResult ?: NSNull.null };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)cancelAgentExecutionWithCAS:(NSDictionary *)cas
                                         patch:(NSDictionary *)patch
                                         error:(NSError **)error {
  if (!DSHAgentLedgerCAS(cas) ||
      !DSHAgentExactDictionaryKeys(patch, @[@"state"]) ||
      ![patch[@"state"] isKindOfClass:NSString.class] ||
      ![patch[@"state"] isEqualToString:@"cancelled"] ||
      (![cas[@"expected_state"] isEqualToString:@"intent"] &&
       ![cas[@"expected_state"] isEqualToString:@"cancel_requested"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *dispatchState = [self.wal dispatchStateForKind:@"execution"
                                                    locator:cas[@"locator"]
                                                      error:error];
  if (![dispatchState isEqualToString:@"not_dispatched"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *rows = [state[@"ledger"] mutableCopy];
    NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
    NSUInteger rowIndex = NSNotFound;
    NSMutableDictionary *row = nil;
    for (NSUInteger index = 0; index < rows.count; index += 1) {
      NSMutableDictionary *candidate = DSHAgentLedgerMutable(rows[index]);
      if ([candidate[@"locator"] isEqual:cas[@"locator"]]) {
        row = candidate;
        rowIndex = index;
        break;
      }
    }
    if (row == nil || !DSHAgentCASMatchesRow(row, cas, mutationError) ||
        ![row[@"state"] isEqual:cas[@"expected_state"]] ||
        !DSHAgentLedgerTranscriptBound(state, row, mutationError)) {
      if (mutationError != nullptr && *mutationError == nil) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
      }
      return NO;
    }
    if ([row[@"state"] isEqualToString:@"intent"] &&
        row[@"owner"] != NSNull.null) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSDictionary *before = row[@"transcript_before"];
    NSMutableDictionary *transcript = nil;
    NSUInteger transcriptIndex = NSNotFound;
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSMutableDictionary *candidate = DSHAgentLedgerMutable(transcripts[index]);
      if ([candidate[@"transcript_ref"] isEqual:before[@"transcript_ref"]]) {
        transcript = candidate;
        transcriptIndex = index;
        break;
      }
    }
    NSUInteger currentGeneration = [transcript[@"generation"] unsignedIntegerValue];
    NSUInteger beforeGeneration = [before[@"generation"] unsignedIntegerValue];
    if (transcript == nil || currentGeneration < beforeGeneration ||
        (currentGeneration == beforeGeneration &&
         (![transcript[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] ||
          ![transcript[@"transcript_bytes"] isEqual:before[@"transcript_bytes"]])) ||
        ![transcript[@"state"] isEqualToString:@"open"]) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSDictionary *authorityTranscriptBefore = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcript[@"transcript_ref"],
      @"generation" : transcript[@"generation"],
      @"transcript_sha256" : transcript[@"transcript_sha256"],
      @"transcript_bytes" : transcript[@"transcript_bytes"],
    };
    NSDictionary *feedback = @{
      @"schema_version" : @1,
      @"name" : row[@"name"],
      @"outcome" : @"cancelled",
      @"payload" : @{
        @"schema_version" : @1,
        @"failure_code" : @"E_AGENT_CANCELLED",
      },
    };
    NSError *feedbackError = nil;
    NSData *feedbackBytes = DSHAgentCanonicalJSON(feedback, &feedbackError);
    NSString *feedbackString = [[NSString alloc] initWithData:feedbackBytes
                                                      encoding:NSUTF8StringEncoding];
    if (feedbackBytes == nil || feedbackString == nil ||
        !DSHAgentValidateNativeToolFeedbackString(feedbackString, &feedbackError)) {
      if (mutationError != nullptr) *mutationError = feedbackError ?:
          DSHAgentNativeStoreError(DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSMutableArray *messages = [transcript[@"messages"] mutableCopy];
    NSUInteger generation = currentGeneration;
    if (messages == nil || messages.count >= 1024 ||
        generation == DSHAgentMaximumSafeInteger) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    [messages addObject:@{
      @"schema_version" : @1,
      @"role" : @"tool",
      @"round_index" : row[@"locator"][@"round_index"],
      @"call_id" : row[@"locator"][@"call_id"],
      @"content" : feedbackString,
      @"truncated" : @NO,
    }];
    generation += 1;
    NSDictionary *transcriptInput = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcript[@"transcript_ref"],
      @"attempt_id" : transcript[@"attempt_id"],
      @"root_fingerprint_sha256" : transcript[@"root_fingerprint_sha256"],
      @"generation" : @(generation),
      @"messages" : messages,
    };
    NSData *transcriptBytes = DSHAgentCanonicalJSON(transcriptInput, &feedbackError);
    NSString *transcriptDigest = DSHAgentHJ(@"agent-transcript", transcriptInput,
                                            &feedbackError);
    NSString *resultDigest = DSHAgentHB(@"tool-result", feedbackBytes,
                                       &feedbackError);
    if (transcriptBytes == nil || transcriptDigest == nil || resultDigest == nil ||
        transcriptBytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
      if (mutationError != nullptr) *mutationError = feedbackError ?:
          DSHAgentNativeStoreError(DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    transcript[@"messages"] = messages;
    transcript[@"generation"] = @(generation);
    transcript[@"transcript_sha256"] = transcriptDigest;
    transcript[@"transcript_bytes"] = @(transcriptBytes.length);
    transcript[@"updated_at"] = [self.wal currentTimestamp];
    NSDictionary *after = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcript[@"transcript_ref"],
      @"generation" : @(generation),
      @"transcript_sha256" : transcriptDigest,
      @"transcript_bytes" : @(transcriptBytes.length),
    };
    NSMutableDictionary *updated = [row mutableCopy];
    updated[@"state"] = @"cancelled";
    updated[@"owner"] = NSNull.null;
    updated[@"settled_facts"] = NSNull.null;
    updated[@"transcript_after"] = after;
    updated[@"receipt"] = @{
      @"schema_version" : @1,
      @"call_id" : row[@"locator"][@"call_id"],
      @"name" : row[@"name"],
      @"arguments_sha256" : row[@"arguments_sha256"],
      @"result_sha256" : resultDigest,
      @"result_bytes" : @(feedbackBytes.length),
      @"truncated" : @NO,
      @"duration_ms" : @0,
      @"outcome" : @"cancelled",
      @"failure_code" : @"E_AGENT_CANCELLED",
      @"approval_reference" : NSNull.null,
    };
    NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
    if (revision == DSHAgentMaximumSafeInteger) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    // Cancellation proves no dispatch and releases a write reservation in the
    // same WAL transaction. The immutable manifest remains as historical
    // evidence, while the key and row both become released/zero-count.
    NSUInteger amount = [updated[@"reserved_write_bytes"] unsignedIntegerValue];
    NSNumber *authorityReservedBefore = nil;
    NSNumber *authorityReservedAfter = nil;
    if (amount > 0) {
      BOOL released = NO;
      NSMutableArray *reservations = [state[@"reservations"] mutableCopy];
      for (NSUInteger reservationIndex = 0;
           reservationIndex < reservations.count; reservationIndex += 1) {
        NSMutableDictionary *record = DSHAgentLedgerMutable(
            reservations[reservationIndex]);
        if (![record[@"attempt_id"] isEqual:row[@"locator"][@"attempt_id"]]) continue;
        NSUInteger reserved = [record[@"reserved_write_bytes"] unsignedIntegerValue];
        NSMutableArray *keys = [record[@"keys"] mutableCopy];
        for (NSUInteger keyIndex = 0; keyIndex < keys.count; keyIndex += 1) {
          if (![keys[keyIndex][@"idempotency_key"]
                  isEqual:row[@"locator"][@"idempotency_key"]]) continue;
          NSMutableDictionary *key = [keys[keyIndex] mutableCopy];
          if (![key[@"state"] isEqualToString:@"active"] ||
              ![key[@"content_bytes"] isEqual:@(amount)]) {
            DSHSetAgentNativeStoreError(mutationError,
                                        DSHAgentNativeStoreErrorConflict);
            return NO;
          }
          key[@"state"] = @"released";
          keys[keyIndex] = key;
          NSUInteger reservationVersion = [record[@"reservation_version"] unsignedIntegerValue];
          if (reservationVersion == DSHAgentMaximumSafeInteger) {
            DSHSetAgentNativeStoreError(mutationError,
                                        DSHAgentNativeStoreErrorCapacity);
            return NO;
          }
          record[@"reservation_version"] = @(reservationVersion + 1);
          record[@"reserved_write_bytes"] = @(reserved >= amount ? reserved - amount : 0);
          authorityReservedBefore = @(reserved);
          authorityReservedAfter = record[@"reserved_write_bytes"];
          record[@"keys"] = keys;
          reservations[reservationIndex] = record;
          released = YES;
          break;
        }
        if (released) break;
      }
      if (!released) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      state[@"reservations"] = reservations;
      NSMutableArray *batches = [state[@"batches"] mutableCopy];
      for (NSUInteger batchIndex = 0; batchIndex < batches.count; batchIndex += 1) {
        NSMutableDictionary *batch = DSHAgentLedgerMutable(batches[batchIndex]);
        if (![batch[@"attempt_id"] isEqual:row[@"locator"][@"attempt_id"]] ||
            ![batch[@"write_keys"] containsObject:row[@"locator"][@"idempotency_key"]]) continue;
        NSUInteger batchReserved = [batch[@"reserved_write_bytes"] unsignedIntegerValue];
        batch[@"reserved_write_bytes"] = @(batchReserved >= amount ? batchReserved - amount : 0);
        batch[@"updated_at"] = [self.wal currentTimestamp];
        batches[batchIndex] = batch;
        break;
      }
      state[@"batches"] = batches;
      updated[@"reserved_write_bytes"] = @0;
    }
    NSMutableArray *gateBatches = [state[@"batches"] mutableCopy];
    for (NSUInteger batchIndex = 0; batchIndex < gateBatches.count; batchIndex += 1) {
      NSMutableDictionary *batch = DSHAgentLedgerMutable(gateBatches[batchIndex]);
      if (![batch[@"attempt_id"] isEqual:row[@"locator"][@"attempt_id"]] ||
          ![batch[@"write_keys"]
              containsObject:row[@"locator"][@"idempotency_key"]]) continue;
      if ([batch[@"effect_gate"] isEqualToString:@"closed"] &&
          DSHAgentMutationBatchProvesNoDispatch(state, batch)) {
        batch[@"effect_gate"] = @"released";
        batch[@"updated_at"] = [self.wal currentTimestamp];
        gateBatches[batchIndex] = batch;
      }
      break;
    }
    state[@"batches"] = gateBatches;
    updated[@"row_revision"] = @(revision + 1);
    updated[@"updated_at"] = [self.wal currentTimestamp];
    if (!DSHAgentLedgerRow(updated)) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    if (!DSHAgentLedgerAdvanceAuthority(
            state, row[@"locator"][@"task_id"],
            row[@"locator"][@"attempt_id"],
            @{ @"schema_version" : @1,
               @"root_fingerprint_sha256" : row[@"root_fingerprint_sha256"],
               @"binding_revision" : row[@"binding_revision"] },
            authorityTranscriptBefore, after, nil,
            authorityReservedBefore, authorityReservedAfter, NO,
            [self.wal currentTimestamp], mutationError)) return NO;
    rows[rowIndex] = updated;
    transcripts[transcriptIndex] = transcript;
    state[@"ledger"] = rows;
    state[@"transcripts"] = transcripts;
    output = @{ @"ok" : @YES, @"row" : [updated copy] };
    return YES;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)reconcileAgentExecutionWithCAS:(NSDictionary *)cas
                                            patch:(NSDictionary *)patch
                                            error:(NSError **)error {
  if (!DSHAgentLedgerCAS(cas) || ![patch isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *state = patch[@"state"];
  if (![state isKindOfClass:NSString.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if (![state isEqualToString:@"unknown"] && ![state isEqualToString:@"cancelled"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if ([state isEqualToString:@"cancelled"]) {
    if ((![cas[@"expected_state"] isEqualToString:@"intent"] &&
         ![cas[@"expected_state"] isEqualToString:@"cancel_requested"]) ||
        ![[self.wal dispatchStateForKind:@"execution"
                                locator:cas[@"locator"]
                                  error:error] isEqualToString:@"not_dispatched"]) {
      if (error == nullptr || *error == nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      }
      return nil;
    }
    return [self cancelAgentExecutionWithCAS:cas
                                       patch:@{ @"state" : @"cancelled" }
                                       error:error];
  }
  // Unknown is only a native owner-loss result.  Derive it from the persisted
  // dispatch marker and a dead persisted owner; a caller's reason string or
  // requested state never supplies this proof.  Ambiguous settlement must use
  // settleAgentExecutionWithCAS so native can append and hash the protected
  // feedback in the same transaction.
  NSDictionary *snapshot = [self.wal snapshotWithError:error];
  if (snapshot == nil) return nil;
  NSDictionary *row = nil;
  for (NSDictionary *candidate in snapshot[@"ledger"]) {
    if ([candidate[@"locator"] isEqual:cas[@"locator"]]) {
      row = candidate;
      break;
    }
  }
  if (row == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
    return nil;
  }
  if ((! [row[@"state"] isEqualToString:@"running"] &&
       ![row[@"state"] isEqualToString:@"cancel_requested"]) ||
      row[@"owner"] == NSNull.null ||
      !DSHAgentLedgerOwner(row[@"owner"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if ([self.wal isNativeTaskAlive:row[@"owner"][@"native_task_id"]
                           launchId:row[@"owner"][@"launch_id"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if (![DSHAgentLedgerDispatchState(snapshot[@"dispatch"], row[@"locator"])
      isEqualToString:@"not_dispatched"] ||
      ![patch[@"state"] isEqualToString:@"unknown"] ||
      patch[@"owner"] != NSNull.null ||
      patch[@"settled_facts"] != NSNull.null ||
      patch[@"transcript_after"] != NSNull.null ||
      patch[@"receipt"] != NSNull.null) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  return [self casAgentExecutionWithCAS:cas
                                  patch:patch
                          allowReconcile:YES
                                  error:error];
}

- (NSDictionary *)appendDenialFeedbackInState:
    (NSMutableDictionary *)state
                                          taskId:(NSString *)taskId
                                       attemptId:(NSString *)attemptId
                                            root:(NSDictionary *)root
                              expectedTranscript:(NSDictionary *)expectedTranscript
                                          policy:(NSDictionary *)policy
                          expectedReservedWriteBytes:(NSNumber *)expectedReservedWriteBytes
                                           callId:(NSString *)callId
                                      roundIndex:(NSNumber *)roundIndex
                                     feedbackJSON:(NSString *)feedbackJSON
                                       timestamp:(NSString *)timestamp
                                           error:(NSError **)error {
  if (![state isKindOfClass:NSMutableDictionary.class] ||
      !DSHAgentCanonicalUUID(taskId) || !DSHAgentCanonicalUUID(attemptId) ||
      ![root isKindOfClass:NSDictionary.class] ||
      !DSHAgentLedgerReference(expectedTranscript) ||
      ![policy isKindOfClass:NSDictionary.class] ||
      !DSHAgentSafeInteger(expectedReservedWriteBytes,
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      !DSHAgentBoundedUTF8String(callId, 128, NO, nullptr) ||
      !DSHAgentSafeInteger(roundIndex, 7, YES) ||
      !DSHAgentBoundedUTF8String(feedbackJSON, 8 * 1024, NO, nullptr) ||
      !DSHAgentValidateNativeToolFeedbackString(feedbackJSON, error) ||
      !DSHAgentCanonicalTimestamp(timestamp)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
  NSMutableDictionary *transcript = nil;
  NSUInteger transcriptIndex = NSNotFound;
  for (NSUInteger index = 0; index < transcripts.count; index += 1) {
    NSMutableDictionary *candidate = [transcripts[index] mutableCopy];
    if ([candidate[@"transcript_ref"]
            isEqual:expectedTranscript[@"transcript_ref"]]) {
      transcript = candidate;
      transcriptIndex = index;
      break;
    }
  }
  if (transcript == nil ||
      ![transcript[@"generation"] isEqual:expectedTranscript[@"generation"]] ||
      ![transcript[@"transcript_sha256"]
          isEqual:expectedTranscript[@"transcript_sha256"]] ||
      ![transcript[@"transcript_bytes"]
          isEqual:expectedTranscript[@"transcript_bytes"]] ||
      ![transcript[@"state"] isEqualToString:@"open"]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSMutableArray *messages = [transcript[@"messages"] mutableCopy];
  [messages addObject:@{
    @"schema_version" : @1, @"role" : @"tool",
    @"round_index" : roundIndex, @"call_id" : callId,
    @"content" : feedbackJSON, @"truncated" : @NO,
  }];
  NSUInteger generation = [transcript[@"generation"] unsignedIntegerValue];
  if (generation == DSHAgentMaximumSafeInteger) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
    return nil;
  }
  generation += 1;
  NSDictionary *input = @{
    @"schema_version" : @1,
    @"transcript_ref" : transcript[@"transcript_ref"],
    @"attempt_id" : transcript[@"attempt_id"],
    @"root_fingerprint_sha256" : transcript[@"root_fingerprint_sha256"],
    @"generation" : @(generation), @"messages" : messages,
  };
  NSError *digestError = nil;
  NSData *bytes = DSHAgentCanonicalJSON(input, &digestError);
  NSString *digest = DSHAgentHJ(@"agent-transcript", input, &digestError);
  if (digest == nil || bytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
    if (digest == nil) {
      if (error != nullptr) *error = digestError;
    } else {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
    }
    return nil;
  }
  transcript[@"messages"] = messages;
  transcript[@"generation"] = @(generation);
  transcript[@"transcript_sha256"] = digest;
  transcript[@"transcript_bytes"] = @(bytes.length);
  transcript[@"updated_at"] = timestamp;
  NSDictionary *after = @{
    @"schema_version" : @1,
    @"transcript_ref" : transcript[@"transcript_ref"],
    @"generation" : @(generation),
    @"transcript_sha256" : digest,
    @"transcript_bytes" : @(bytes.length),
  };
  transcripts[transcriptIndex] = transcript;
  state[@"transcripts"] = transcripts;
  if (!DSHAgentLedgerAdvanceAuthority(
          state, taskId, attemptId, root, expectedTranscript, after, policy,
          expectedReservedWriteBytes, expectedReservedWriteBytes, NO,
          timestamp, error)) {
    return nil;
  }
  return after;
}

- (NSDictionary *)settleDeniedApprovalInState:
    (NSMutableDictionary *)state
                                          locator:(NSDictionary *)locator
                                             root:(NSDictionary *)root
                              expectedTranscript:(NSDictionary *)expectedTranscript
                                          policy:(NSDictionary *)policy
                          expectedReservedWriteBytes:(NSNumber *)expectedReservedWriteBytes
                                     feedbackJSON:(NSString *)feedbackJSON
                                       timestamp:(NSString *)timestamp
                                           error:(NSError **)error {
  if (![state isKindOfClass:NSMutableDictionary.class] ||
      !DSHAgentLedgerLocator(locator) || !DSHAgentLedgerRootFull(root) ||
      !DSHAgentLedgerReference(expectedTranscript) ||
      ![policy isKindOfClass:NSDictionary.class] ||
      !DSHAgentSafeInteger(expectedReservedWriteBytes,
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      !DSHAgentBoundedUTF8String(feedbackJSON, 8 * 1024, NO, nullptr) ||
      !DSHAgentValidateNativeToolFeedbackString(feedbackJSON, error) ||
      !DSHAgentCanonicalTimestamp(timestamp)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  // The feedback must be the exact user-denial union; parse it before any
  // row change so a malformed payload can never settle or append anything.
  NSData *feedbackBytes = [feedbackJSON dataUsingEncoding:NSUTF8StringEncoding];
  NSError *parseError = nil;
  NSDictionary *feedback = feedbackBytes == nil ? nil
      : [NSJSONSerialization JSONObjectWithData:feedbackBytes options:0
                                          error:&parseError];
  if (![feedback isKindOfClass:NSDictionary.class] ||
      ![feedback[@"outcome"] isEqualToString:@"denied"] ||
      ![feedback[@"payload"][@"failure_code"]
          isEqualToString:@"E_AGENT_DENIED_BY_USER"] ||
      !DSHAgentBoundedUTF8String(feedback[@"name"], 64, NO, nullptr)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSMutableArray *rows = [state[@"ledger"] mutableCopy];
  NSMutableDictionary *row = nil;
  NSUInteger rowIndex = NSNotFound;
  for (NSUInteger index = 0; index < rows.count; index += 1) {
    NSMutableDictionary *candidate = DSHAgentLedgerMutable(rows[index]);
    if ([candidate[@"locator"] isEqual:locator]) {
      row = candidate;
      rowIndex = index;
      break;
    }
  }
  if (row == nil || ![row[@"state"] isEqualToString:@"intent"] ||
      ![row[@"row_revision"] isEqual:@1] ||
      row[@"owner"] != NSNull.null ||
      row[@"settled_facts"] != NSNull.null ||
      row[@"transcript_after"] != NSNull.null ||
      row[@"receipt"] != NSNull.null ||
      ![row[@"name"] isEqual:feedback[@"name"]] ||
      ![DSHAgentLedgerDispatchState(state[@"dispatch"], locator)
          isEqualToString:@"not_dispatched"] ||
      !DSHAgentLedgerTranscriptBound(state, row, error)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSString *callId = row[@"locator"][@"call_id"];
  NSNumber *roundIndex = row[@"locator"][@"round_index"];
  NSDictionary *after = [self appendDenialFeedbackInState:state
      taskId:locator[@"task_id"] attemptId:locator[@"attempt_id"]
      root:root expectedTranscript:expectedTranscript policy:policy
      expectedReservedWriteBytes:expectedReservedWriteBytes callId:callId
      roundIndex:roundIndex feedbackJSON:feedbackJSON timestamp:timestamp
      error:error];
  if (after == nil) return nil;
  NSError *digestError = nil;
  NSString *resultSHA = DSHAgentHB(@"tool-result", feedbackBytes, &digestError);
  if (resultSHA == nil) {
    if (error != nullptr) *error = digestError;
    return nil;
  }
  NSDictionary *receipt = @{
    @"schema_version" : @1, @"call_id" : callId, @"name" : row[@"name"],
    @"arguments_sha256" : row[@"arguments_sha256"],
    @"result_sha256" : resultSHA, @"result_bytes" : @(feedbackBytes.length),
    @"truncated" : @NO, @"duration_ms" : @0, @"outcome" : @"denied",
    @"failure_code" : @"E_AGENT_DENIED_BY_USER",
    @"approval_reference" : NSNull.null,
  };
  row[@"row_revision"] = @2;
  row[@"state"] = @"settled";
  row[@"settled_facts"] = NSNull.null;
  row[@"transcript_after"] = after;
  row[@"receipt"] = receipt;
  row[@"updated_at"] = timestamp;
  if (!DSHAgentLedgerRow(row)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  rows[rowIndex] = row;
  state[@"ledger"] = rows;
  return @{ @"receipt" : receipt, @"transcript" : after };
}

@end
