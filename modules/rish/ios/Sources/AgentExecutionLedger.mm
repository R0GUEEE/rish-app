#import "AgentExecutionLedger.h"

#include <math.h>
#include "rish_agent_core.h"

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

static NSArray<NSString *> *DSHAgentLedgerReferenceKeys(void) {
  return @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ];
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

static NSDictionary *DSHAgentWriteManifestCallForIntent(NSDictionary *intent);

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

@interface DSHAgentExecutionLedger ()
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@end

@implementation DSHAgentExecutionLedger

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal {
  self = [super init];
  if (self) _wal = wal;
  return self;
}

#pragma mark - Shared-core facade (row-level operations)

// The row-level selectors below are a facade over the Rust reducer in
// modules/rish/core (`rish_agent_ledger_reduce`). This side owns the WAL
// transaction (or the caller's candidate for the in-state helpers): it
// collects the ledger row, the attempt's execution dispatch markers, the bound
// transcript row, the attempt's reservation and batch records, the
// task/attempt authorities and the liveness answers into a view, hands the
// operation to the reducer, and applies the returned changes verbatim. For
// settlement the reducer also returns the operation commit, which this side
// performs through DSHAgentNativeWALCommitOperationInState on the same
// candidate. Row policy lives in crates/rish-agent-core/src/ledger_ops.rs.
// The batch-level methods further down are still the Objective-C
// implementation and keep their validators.

typedef NS_ENUM(NSInteger, DSHAgentLedgerRunMode) {
  DSHAgentLedgerRunModeTransaction,
  DSHAgentLedgerRunModeSnapshot,
  DSHAgentLedgerRunModeInState,
};

static NSDictionary *DSHAgentLedgerReduce(NSDictionary *envelope, NSError **error) {
  NSData *bytes = DSHAgentCanonicalJSON(envelope, nil);
  if (bytes == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  char *raw = rish_agent_ledger_reduce((const char *)bytes.bytes, bytes.length);
  if (raw == NULL) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSData *reply = [NSData dataWithBytes:raw length:strlen(raw)];
  rish_agent_string_free(raw);
  id parsed = [NSJSONSerialization JSONObjectWithData:reply options:0 error:nil];
  if (![parsed isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  if (![parsed[@"ok"] isEqual:@YES]) {
    NSInteger code = [parsed[@"error"] isKindOfClass:NSNumber.class]
        ? [parsed[@"error"] integerValue] : 0;
    if (code < DSHAgentNativeStoreErrorInvalidArgument ||
        code > DSHAgentNativeStoreErrorPersistence) {
      code = DSHAgentNativeStoreErrorCorrupt;
    }
    DSHSetAgentNativeStoreError(error, (DSHAgentNativeStoreErrorCode)code);
    return nil;
  }
  return parsed;
}

static id DSHAgentLedgerArgument(id value) {
  return value ?: NSNull.null;
}

static id DSHAgentLedgerLocatorOf(id container) {
  return [container isKindOfClass:NSDictionary.class] ? container[@"locator"] : nil;
}

static id DSHAgentLedgerField(id container, NSString *key) {
  return [container isKindOfClass:NSDictionary.class] ? container[key] : nil;
}

static NSArray *DSHAgentLedgerSlotted(NSArray *table, BOOL (^matches)(NSDictionary *record)) {
  NSMutableArray *slotted = [NSMutableArray array];
  for (NSUInteger index = 0; index < table.count; index += 1) {
    NSDictionary *record = table[index];
    if ([record isKindOfClass:NSDictionary.class] && matches(record)) {
      [slotted addObject:@{ @"slot" : @(index), @"record" : record }];
    }
  }
  return slotted;
}

static NSUInteger DSHAgentLedgerIndexOfTranscript(NSArray *transcripts, id transcriptRef) {
  if (transcriptRef == nil || transcriptRef == NSNull.null) return NSNotFound;
  for (NSUInteger index = 0; index < transcripts.count; index += 1) {
    if ([transcripts[index][@"transcript_ref"] isEqual:transcriptRef]) return index;
  }
  return NSNotFound;
}

- (BOOL)applyLedgerChanges:(NSArray *)changes
                   toState:(NSMutableDictionary *)state
                  rowIndex:(NSUInteger)rowIndex
                     error:(NSError **)error {
  for (NSDictionary *change in changes) {
    NSString *kind = DSHAgentLedgerField(change, @"kind");
    if ([kind isEqualToString:@"insert_ledger_row"]) {
      NSMutableArray *rows = [state[@"ledger"] mutableCopy];
      [rows addObject:change[@"row"]];
      state[@"ledger"] = rows;
    } else if ([kind isEqualToString:@"replace_ledger_row"]) {
      NSMutableArray *rows = [state[@"ledger"] mutableCopy];
      if (rowIndex == NSNotFound || rowIndex >= rows.count) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      rows[rowIndex] = change[@"row"];
      state[@"ledger"] = rows;
    } else if ([kind isEqualToString:@"insert_dispatch_marker"]) {
      NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
      [dispatch addObject:change[@"marker"]];
      state[@"dispatch"] = dispatch;
    } else if ([kind isEqualToString:@"mark_dispatched"]) {
      NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
      NSUInteger markerIndex = NSNotFound;
      for (NSUInteger index = 0; index < dispatch.count; index += 1) {
        NSDictionary *candidate = dispatch[index];
        if ([candidate[@"kind"] isEqualToString:@"execution"] &&
            [candidate[@"locator"] isEqual:change[@"locator"]]) {
          markerIndex = index;
          break;
        }
      }
      if (markerIndex == NSNotFound) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      NSMutableDictionary *marker = [dispatch[markerIndex] mutableCopy];
      marker[@"dispatch_state"] = @"dispatched";
      dispatch[markerIndex] = [marker copy];
      state[@"dispatch"] = dispatch;
    } else if ([kind isEqualToString:@"replace_transcript"]) {
      NSMutableArray *transcripts = [state[@"transcripts"] mutableCopy];
      NSUInteger index = DSHAgentLedgerIndexOfTranscript(transcripts, change[@"row"][@"transcript_ref"]);
      if (index == NSNotFound) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      transcripts[index] = change[@"row"];
      state[@"transcripts"] = transcripts;
    } else if ([kind isEqualToString:@"replace_reservation"] ||
               [kind isEqualToString:@"replace_batch"] ||
               [kind isEqualToString:@"replace_authority"]) {
      NSString *table = [kind isEqualToString:@"replace_reservation"] ? @"reservations"
          : ([kind isEqualToString:@"replace_batch"] ? @"batches" : @"authorities");
      NSMutableArray *records = [state[table] mutableCopy];
      NSUInteger slot = [change[@"slot"] isKindOfClass:NSNumber.class]
          ? [change[@"slot"] unsignedIntegerValue] : NSNotFound;
      if (records == nil || slot >= records.count) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      records[slot] = change[@"record"];
      state[table] = records;
    } else {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
  }
  return YES;
}

/// Runs one reducer operation. `locator` selects the ledger row, `taskId` /
/// `attemptId` scope the dispatch, reservation, batch and authority views,
/// `expectedTranscript` names the transcript row the in-state helpers bind
/// to, and `argOwner` is the owner an argument carries (for liveness).
- (NSDictionary *)runLedgerOperation:(NSString *)op
                                args:(NSDictionary *)args
                             locator:(id)locator
                              taskId:(id)taskId
                           attemptId:(id)attemptId
                  expectedTranscript:(id)expectedTranscript
                            argOwner:(id)argOwner
                                mode:(DSHAgentLedgerRunMode)mode
                          inState:(NSMutableDictionary *)callerState
                               error:(NSError **)error {
  NSString *launchId = self.wal.launchId;
  NSString *now = [self.wal currentTimestamp];
  __block NSDictionary *output = nil;
  DSHAgentNativeWALMutation run = ^BOOL(NSMutableDictionary *state, NSError **mutationError) {
    NSArray *rows = state[@"ledger"];
    NSDictionary *row = nil;
    NSUInteger rowIndex = NSNotFound;
    NSUInteger attemptRowCount = 0;
    for (NSUInteger index = 0; index < rows.count; index += 1) {
      NSDictionary *candidate = rows[index];
      if (row == nil && locator != nil && [candidate[@"locator"] isEqual:locator]) {
        row = candidate;
        rowIndex = index;
      }
      if (attemptId != nil && [candidate[@"locator"][@"attempt_id"] isEqual:attemptId]) {
        attemptRowCount += 1;
      }
    }
    NSMutableArray *dispatch = [NSMutableArray array];
    for (NSDictionary *entry in state[@"dispatch"]) {
      if ([entry[@"kind"] isEqualToString:@"execution"] &&
          attemptId != nil && [entry[@"locator"][@"attempt_id"] isEqual:attemptId]) {
        [dispatch addObject:entry];
      }
    }
    NSArray *transcripts = state[@"transcripts"];
    // The bound transcript is the one the row names; an insert has no row
    // yet, so the intent argument names it instead.
    id boundReference = row != nil ? row[@"transcript_before"]
        : DSHAgentLedgerField(args[@"intent"], @"transcript_before");
    NSUInteger transcriptIndex = DSHAgentLedgerIndexOfTranscript(
        transcripts, DSHAgentLedgerField(boundReference, @"transcript_ref"));
    NSUInteger expectedIndex = DSHAgentLedgerIndexOfTranscript(
        transcripts, DSHAgentLedgerField(expectedTranscript, @"transcript_ref"));
    NSArray *reservations = DSHAgentLedgerSlotted(state[@"reservations"], ^BOOL(NSDictionary *record) {
      return attemptId != nil && [record[@"attempt_id"] isEqual:attemptId];
    });
    NSArray *batches = DSHAgentLedgerSlotted(state[@"batches"], ^BOOL(NSDictionary *record) {
      return attemptId != nil && [record[@"attempt_id"] isEqual:attemptId];
    });
    NSArray *authorityTable = state[@"authorities"];
    id authorities = NSNull.null;
    if ([authorityTable isKindOfClass:NSArray.class] && authorityTable.count > 0) {
      authorities = DSHAgentLedgerSlotted(authorityTable, ^BOOL(NSDictionary *record) {
        return taskId != nil && attemptId != nil &&
            [record[@"task_id"] isEqual:taskId] && [record[@"attempt_id"] isEqual:attemptId];
      });
    }
    BOOL argOwnerAlive = [argOwner isKindOfClass:NSDictionary.class] &&
        [self.wal isNativeTaskAlive:argOwner[@"native_task_id"] launchId:argOwner[@"launch_id"]];
    id rowOwner = row[@"owner"];
    BOOL rowOwnerAlive = [rowOwner isKindOfClass:NSDictionary.class] &&
        [self.wal isNativeTaskAlive:rowOwner[@"native_task_id"] launchId:rowOwner[@"launch_id"]];
    NSDictionary *envelope = @{
      @"op" : op,
      @"args" : args,
      @"env" : @{ @"launch_id" : launchId, @"now" : now, @"attempt_row_count" : @(attemptRowCount) },
      @"view" : @{
        @"row" : row ?: NSNull.null,
        @"dispatch" : dispatch,
        @"transcript" : transcriptIndex == NSNotFound ? NSNull.null : transcripts[transcriptIndex],
        @"expected_transcript" : expectedIndex == NSNotFound ? NSNull.null : transcripts[expectedIndex],
        @"reservations" : reservations,
        @"batches" : batches,
        @"authorities" : authorities,
        @"arg_owner_alive" : argOwnerAlive ? @YES : @NO,
        @"row_owner_alive" : rowOwnerAlive ? @YES : @NO,
      },
    };
    NSDictionary *result = DSHAgentLedgerReduce(envelope, mutationError);
    if (result == nil) return NO;
    id reduced = result[@"output"];
    if (![reduced isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    output = reduced;
    if (mode == DSHAgentLedgerRunModeSnapshot || ![result[@"commit"] isEqual:@YES]) return NO;
    NSArray *changes = [result[@"changes"] isKindOfClass:NSArray.class] ? result[@"changes"] : @[];
    if (![self applyLedgerChanges:changes toState:state rowIndex:rowIndex error:mutationError]) {
      return NO;
    }
    NSDictionary *operation = result[@"commit_operation"];
    if ([operation isKindOfClass:NSDictionary.class]) {
      NSDictionary *committed = DSHAgentNativeWALCommitOperationInState(
          state, self.wal, operation[@"operation_id"], operation[@"request_sha256"],
          operation[@"task_id"], operation[@"attempt_id"], operation[@"terminal_state"],
          operation[@"result_status"], operation[@"result_ref"], operation[@"result_revision"],
          operation[@"safe_result"], mutationError);
      if (committed == nil) return NO;
      NSMutableDictionary *withOperation = [output mutableCopy];
      withOperation[@"operation_result"] = committed[@"result"][@"result"] ?: NSNull.null;
      output = [withOperation copy];
    }
    return YES;
  };
  if (mode == DSHAgentLedgerRunModeInState) {
    NSError *runError = nil;
    BOOL applied = run(callerState, &runError);
    if (!applied) {
      if (error != nullptr) *error = runError ?: DSHAgentNativeStoreError(DSHAgentNativeStoreErrorCorrupt);
      return nil;
    }
    return output;
  }
  if (mode == DSHAgentLedgerRunModeSnapshot) {
    NSDictionary *snapshot = [self.wal snapshotWithError:error];
    if (snapshot == nil) return nil;
    NSError *runError = nil;
    (void)run([snapshot mutableCopy], &runError);
    if (runError != nil) {
      if (error != nullptr) *error = runError;
      return nil;
    }
    return output;
  }
  BOOL committed = [self.wal performAtomicTransaction:run error:error];
  return committed ? output : nil;
}

- (NSDictionary *)insertAgentExecutionIntentWithInsertCAS:(NSDictionary *)insertCAS
                                            argumentsJSON:(NSString *)argumentsJSON
                                             exactIntent:(NSDictionary *)intent
                                                   error:(NSError **)error {
  id locator = DSHAgentLedgerLocatorOf(insertCAS);
  return [self runLedgerOperation:@"insert"
                             args:@{
                               @"insert_cas" : DSHAgentLedgerArgument(insertCAS),
                               @"arguments_json" : DSHAgentLedgerArgument(argumentsJSON),
                               @"intent" : DSHAgentLedgerArgument(intent),
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:nil
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
}

- (NSDictionary *)casAgentExecutionWithCAS:(NSDictionary *)cas
                                      patch:(NSDictionary *)patch
                              allowReconcile:(BOOL)allowReconcile
                                      error:(NSError **)error {
  id locator = DSHAgentLedgerLocatorOf(cas);
  return [self runLedgerOperation:@"cas"
                             args:@{
                               @"cas" : DSHAgentLedgerArgument(cas),
                               @"patch" : DSHAgentLedgerArgument(patch),
                               @"allow_reconcile" : allowReconcile ? @YES : @NO,
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:DSHAgentLedgerField(patch, @"owner")
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
}

- (NSDictionary *)casAgentExecutionWithCAS:(NSDictionary *)cas
                                      patch:(NSDictionary *)patch
                                      error:(NSError **)error {
  return [self casAgentExecutionWithCAS:cas patch:patch allowReconcile:NO error:error];
}

- (NSDictionary *)claimAgentExecutionWithLocator:(NSDictionary *)locator
                              expectedRowRevision:(NSNumber *)revision
                                             owner:(NSDictionary *)owner
                                             error:(NSError **)error {
  return [self runLedgerOperation:@"claim"
                             args:@{
                               @"locator" : DSHAgentLedgerArgument(locator),
                               @"expected_row_revision" : DSHAgentLedgerArgument(revision),
                               @"owner" : DSHAgentLedgerArgument(owner),
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:owner
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
}

- (NSDictionary *)heartbeatAgentExecutionWithCAS:(NSDictionary *)cas
                                            owner:(NSDictionary *)owner
                                            error:(NSError **)error {
  id locator = DSHAgentLedgerLocatorOf(cas);
  return [self runLedgerOperation:@"heartbeat"
                             args:@{
                               @"cas" : DSHAgentLedgerArgument(cas),
                               @"owner" : DSHAgentLedgerArgument(owner),
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:owner
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
}

- (NSDictionary *)markAgentExecutionDispatchedWithCAS:(NSDictionary *)cas
                                                  error:(NSError **)error {
  id locator = DSHAgentLedgerLocatorOf(cas);
  return [self runLedgerOperation:@"mark_dispatched"
                             args:@{ @"cas" : DSHAgentLedgerArgument(cas) }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:nil
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
}

- (NSDictionary *)queryAgentExecutionWithLocator:(NSDictionary *)locator
                                expectedTranscript:(NSDictionary *)transcript
                                               root:(NSDictionary *)root
                                             error:(NSError **)error {
  NSDictionary *args = @{
    @"locator" : DSHAgentLedgerArgument(locator),
    @"expected_transcript" : DSHAgentLedgerArgument(transcript),
    @"root" : DSHAgentLedgerArgument(root),
  };
  // The reducer validates the arguments before it looks at any row, so a
  // dry run over an empty view reproduces the ObjC preflight: invalid
  // arguments never trigger owner-loss reconciliation.
  NSError *preflightError = nil;
  NSDictionary *preflight = DSHAgentLedgerReduce(@{
    @"op" : @"query", @"args" : args,
    @"env" : @{ @"launch_id" : self.wal.launchId, @"now" : [self.wal currentTimestamp], @"attempt_row_count" : @0 },
    @"view" : @{},
  }, &preflightError);
  if (preflight == nil) {
    if (error != nullptr) *error = preflightError;
    return nil;
  }
  if (![self.wal reconcileOwnerLossWithError:error]) return nil;
  return [self runLedgerOperation:@"query"
                             args:args
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:nil
                             mode:DSHAgentLedgerRunModeSnapshot
                          inState:nil
                            error:error];
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

#pragma mark - Shared-core facade (batch-level operations)

// prepareAgentToolBatch and openAgentWriteBatchEffectGate are facades over
// the batch reducer in modules/rish/core (`rish_agent_ledger_batch_reduce`).
// The view is wider than the row facade's: the frozen round, the attempt's
// batches, reservations, ledger rows and dispatch markers, the request's
// transcript row plus message-free summaries of every transcript, the round's
// denied calls, the task/attempt authorities and operation results. Approval
// tokens are generated here (NSUUID) and handed to the reducer.

static NSDictionary *DSHAgentLedgerBatchReduce(NSDictionary *envelope, NSError **error) {
  NSData *bytes = DSHAgentCanonicalJSON(envelope, nil);
  if (bytes == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  char *raw = rish_agent_ledger_batch_reduce((const char *)bytes.bytes, bytes.length);
  if (raw == NULL) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSData *reply = [NSData dataWithBytes:raw length:strlen(raw)];
  rish_agent_string_free(raw);
  id parsed = [NSJSONSerialization JSONObjectWithData:reply options:0 error:nil];
  if (![parsed isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  if (![parsed[@"ok"] isEqual:@YES]) {
    NSInteger code = [parsed[@"error"] isKindOfClass:NSNumber.class]
        ? [parsed[@"error"] integerValue] : 0;
    if (code < DSHAgentNativeStoreErrorInvalidArgument ||
        code > DSHAgentNativeStoreErrorPersistence) {
      code = DSHAgentNativeStoreErrorCorrupt;
    }
    DSHSetAgentNativeStoreError(error, (DSHAgentNativeStoreErrorCode)code);
    return nil;
  }
  return parsed;
}

static NSDictionary *DSHAgentLedgerTranscriptSummary(NSDictionary *transcript) {
  NSMutableDictionary *summary = [transcript mutableCopy];
  [summary removeObjectForKey:@"messages"];
  return [summary copy];
}

- (NSDictionary *)runLedgerBatchOperation:(NSString *)op
                                  request:(NSDictionary *)request
                                    error:(NSError **)error {
  id taskId = DSHAgentLedgerField(request, @"task_id");
  id attemptId = DSHAgentLedgerField(request, @"attempt_id");
  id roundId = DSHAgentLedgerField(request, @"round_id");
  id roundIndex = DSHAgentLedgerField(request, @"round_index");
  id transcriptRef = DSHAgentLedgerField(DSHAgentLedgerField(request, @"transcript"), @"transcript_ref");
  NSUInteger callCount = [request[@"calls"] isKindOfClass:NSArray.class]
      ? [request[@"calls"] count] : 0;
  NSMutableArray *tokens = [NSMutableArray arrayWithCapacity:callCount];
  for (NSUInteger index = 0; index < callCount && index < 16; index += 1) {
    [tokens addObject:NSUUID.UUID.UUIDString.lowercaseString];
  }
  NSString *now = [self.wal currentTimestamp];
  NSString *launchId = self.wal.launchId;
  BOOL (^quadruple)(NSDictionary *) = ^BOOL(NSDictionary *record) {
    return taskId != nil && [record[@"task_id"] isEqual:taskId] &&
        [record[@"attempt_id"] isEqual:attemptId] &&
        [record[@"round_id"] isEqual:roundId] &&
        [record[@"round_index"] isEqual:roundIndex];
  };
  __block NSDictionary *output = nil;
  DSHAgentNativeWALMutation run = ^BOOL(NSMutableDictionary *state, NSError **mutationError) {
    NSArray *ledger = state[@"ledger"];
    NSArray *dispatchTable = state[@"dispatch"];
    NSArray *batchTable = state[@"batches"];
    NSArray *reservationTable = state[@"reservations"];
    NSArray *transcripts = state[@"transcripts"];
    NSArray *deniedTable = state[@"denied_calls"];
    BOOL tablesPresent = [ledger isKindOfClass:NSArray.class] &&
        [dispatchTable isKindOfClass:NSArray.class] &&
        [batchTable isKindOfClass:NSArray.class] &&
        [reservationTable isKindOfClass:NSArray.class] &&
        [transcripts isKindOfClass:NSArray.class] &&
        [deniedTable isKindOfClass:NSArray.class];
    NSMutableArray *rounds = [NSMutableArray array];
    for (NSDictionary *round in state[@"rounds"]) {
      if ([round[@"locator"] isKindOfClass:NSDictionary.class] && quadruple(round[@"locator"])) {
        [rounds addObject:round];
      }
    }
    NSArray *batches = DSHAgentLedgerSlotted(batchTable, ^BOOL(NSDictionary *record) {
      return attemptId != nil && [record[@"attempt_id"] isEqual:attemptId];
    });
    NSArray *reservations = DSHAgentLedgerSlotted(reservationTable, ^BOOL(NSDictionary *record) {
      return taskId != nil && [record[@"task_id"] isEqual:taskId] &&
          [record[@"attempt_id"] isEqual:attemptId];
    });
    NSUInteger transcriptIndex = DSHAgentLedgerIndexOfTranscript(transcripts, transcriptRef);
    NSMutableArray *summaries = [NSMutableArray arrayWithCapacity:transcripts.count];
    for (NSDictionary *transcript in transcripts) {
      if ([transcript isKindOfClass:NSDictionary.class]) {
        [summaries addObject:DSHAgentLedgerTranscriptSummary(transcript)];
      }
    }
    NSMutableArray *ledgerRows = [NSMutableArray array];
    for (NSDictionary *row in ledger) {
      if (attemptId != nil && [row[@"locator"][@"attempt_id"] isEqual:attemptId]) {
        [ledgerRows addObject:row];
      }
    }
    NSMutableArray *dispatch = [NSMutableArray array];
    for (NSDictionary *entry in dispatchTable) {
      if ([entry[@"kind"] isEqualToString:@"execution"] &&
          attemptId != nil && [entry[@"locator"][@"attempt_id"] isEqual:attemptId]) {
        [dispatch addObject:entry];
      }
    }
    NSMutableArray *deniedCalls = [NSMutableArray array];
    NSUInteger deniedAttempt = 0;
    for (NSDictionary *denial in deniedTable) {
      if (attemptId != nil && [denial[@"attempt_id"] isEqual:attemptId]) deniedAttempt += 1;
      if (quadruple(denial)) [deniedCalls addObject:denial];
    }
    NSArray *authorityTable = state[@"authorities"];
    id authorities = NSNull.null;
    if ([authorityTable isKindOfClass:NSArray.class] && authorityTable.count > 0) {
      authorities = DSHAgentLedgerSlotted(authorityTable, ^BOOL(NSDictionary *record) {
        return taskId != nil && [record[@"task_id"] isEqual:taskId] &&
            [record[@"attempt_id"] isEqual:attemptId];
      });
    }
    NSMutableArray *operationResults = [NSMutableArray array];
    for (NSDictionary *snapshot in state[@"operation_results"]) {
      NSDictionary *result = DSHAgentLedgerField(DSHAgentLedgerField(snapshot, @"result"), @"result");
      // An allowed approval's result carries receipt:NSNull; only a batch
      // receipt dictionary can name the task/attempt.
      NSDictionary *receipt = DSHAgentLedgerField(result, @"receipt");
      BOOL direct = [DSHAgentLedgerField(result, @"task_id") isEqual:taskId] &&
          [DSHAgentLedgerField(result, @"attempt_id") isEqual:attemptId];
      BOOL viaReceipt = [DSHAgentLedgerField(receipt, @"task_id") isEqual:taskId] &&
          [DSHAgentLedgerField(receipt, @"attempt_id") isEqual:attemptId];
      if (taskId != nil && (direct || viaReceipt)) [operationResults addObject:snapshot];
    }
    NSDictionary *envelope = @{
      @"op" : op,
      @"request" : request ?: NSNull.null,
      @"env" : @{ @"launch_id" : launchId, @"now" : now, @"approval_tokens" : tokens },
      @"view" : @{
        @"tables_present" : tablesPresent ? @YES : @NO,
        @"rounds" : rounds,
        @"batches" : batches,
        @"reservations" : reservations,
        @"transcript" : transcriptIndex == NSNotFound ? NSNull.null : transcripts[transcriptIndex],
        @"transcript_summaries" : summaries,
        @"ledger_rows" : ledgerRows,
        @"dispatch" : dispatch,
        @"denied_calls" : deniedCalls,
        @"denied_attempt_count" : @(deniedAttempt),
        @"denied_total_count" : @(deniedTable.count),
        @"authorities" : authorities,
        @"authorities_present" : [(NSArray *)state[@"authorities"] count] > 0 ? @YES : @NO,
        @"operations_present" : [(NSArray *)state[@"operations"] count] > 0 ? @YES : @NO,
        @"operation_results" : operationResults,
      },
    };
    NSDictionary *result = DSHAgentLedgerBatchReduce(envelope, mutationError);
    if (result == nil) return NO;
    id reduced = result[@"output"];
    if (![reduced isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    output = reduced;
    if (![result[@"commit"] isEqual:@YES]) return NO;
    NSArray *changes = [result[@"changes"] isKindOfClass:NSArray.class] ? result[@"changes"] : @[];
    for (NSDictionary *change in changes) {
      NSString *kind = DSHAgentLedgerField(change, @"kind");
      if ([kind isEqualToString:@"insert_reservation"] ||
          [kind isEqualToString:@"insert_batch"] ||
          [kind isEqualToString:@"insert_denied_call"]) {
        NSString *table = [kind isEqualToString:@"insert_reservation"] ? @"reservations"
            : ([kind isEqualToString:@"insert_batch"] ? @"batches" : @"denied_calls");
        NSMutableArray *records = [state[table] mutableCopy] ?: [NSMutableArray array];
        [records addObject:change[@"record"]];
        state[table] = records;
      } else if (![self applyLedgerChanges:@[ change ] toState:state rowIndex:NSNotFound
                                     error:mutationError]) {
        return NO;
      }
    }
    NSDictionary *operation = result[@"commit_operation"];
    if ([operation isKindOfClass:NSDictionary.class]) {
      NSDictionary *committed = DSHAgentNativeWALCommitOperationInState(
          state, self.wal, operation[@"operation_id"], operation[@"request_sha256"],
          operation[@"task_id"], operation[@"attempt_id"], operation[@"terminal_state"],
          operation[@"result_status"], operation[@"result_ref"], operation[@"result_revision"],
          operation[@"safe_result"], mutationError);
      if (committed == nil) return NO;
      NSMutableDictionary *withOperation = [output mutableCopy];
      withOperation[@"operation_result"] = committed[@"result"][@"result"] ?: NSNull.null;
      output = [withOperation copy];
    }
    return YES;
  };
  BOOL committed = [self.wal performAtomicTransaction:run error:error];
  return committed ? output : nil;
}

- (NSDictionary *)prepareAgentToolBatchWithRequest:(NSDictionary *)request
                                               error:(NSError **)error {
  return [self runLedgerBatchOperation:@"prepare_tool_batch" request:request error:error];
}

- (NSDictionary *)openAgentWriteBatchEffectGateWithRequest:(NSDictionary *)request
                                                       error:(NSError **)error {
  return [self runLedgerBatchOperation:@"open_effect_gate" request:request error:error];
}

- (NSDictionary *)releaseWriteReservationWithCAS:(NSDictionary *)cas
                                            error:(NSError **)error {
  id locator = DSHAgentLedgerLocatorOf(cas);
  return [self runLedgerOperation:@"release"
                             args:@{ @"cas" : DSHAgentLedgerArgument(cas) }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:nil
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
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
  id locator = DSHAgentLedgerLocatorOf(cas);
  return [self runLedgerOperation:@"settle"
                             args:@{
                               @"cas" : DSHAgentLedgerArgument(cas),
                               @"patch" : DSHAgentLedgerArgument(patch),
                               @"message" : DSHAgentLedgerArgument(message),
                               @"operation" : DSHAgentLedgerArgument(operation),
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:DSHAgentLedgerField(patch, @"owner")
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
}

- (NSDictionary *)cancelAgentExecutionWithCAS:(NSDictionary *)cas
                                         patch:(NSDictionary *)patch
                                         error:(NSError **)error {
  id locator = DSHAgentLedgerLocatorOf(cas);
  return [self runLedgerOperation:@"cancel"
                             args:@{
                               @"cas" : DSHAgentLedgerArgument(cas),
                               @"patch" : DSHAgentLedgerArgument(patch),
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:nil
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
                            error:error];
}

- (NSDictionary *)reconcileAgentExecutionWithCAS:(NSDictionary *)cas
                                            patch:(NSDictionary *)patch
                                            error:(NSError **)error {
  id locator = DSHAgentLedgerLocatorOf(cas);
  return [self runLedgerOperation:@"reconcile"
                             args:@{
                               @"cas" : DSHAgentLedgerArgument(cas),
                               @"patch" : DSHAgentLedgerArgument(patch),
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:nil
                         argOwner:DSHAgentLedgerField(patch, @"owner")
                             mode:DSHAgentLedgerRunModeTransaction
                          inState:nil
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
  if (![state isKindOfClass:NSMutableDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return [self runLedgerOperation:@"append_denial_feedback"
                             args:@{
                               @"task_id" : DSHAgentLedgerArgument(taskId),
                               @"attempt_id" : DSHAgentLedgerArgument(attemptId),
                               @"root" : DSHAgentLedgerArgument(root),
                               @"expected_transcript" : DSHAgentLedgerArgument(expectedTranscript),
                               @"policy" : DSHAgentLedgerArgument(policy),
                               @"expected_reserved_write_bytes" : DSHAgentLedgerArgument(expectedReservedWriteBytes),
                               @"call_id" : DSHAgentLedgerArgument(callId),
                               @"round_index" : DSHAgentLedgerArgument(roundIndex),
                               @"feedback_json" : DSHAgentLedgerArgument(feedbackJSON),
                               @"timestamp" : DSHAgentLedgerArgument(timestamp),
                             }
                          locator:nil
                           taskId:taskId
                        attemptId:attemptId
               expectedTranscript:expectedTranscript
                         argOwner:nil
                             mode:DSHAgentLedgerRunModeInState
                          inState:state
                            error:error];
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
  if (![state isKindOfClass:NSMutableDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return [self runLedgerOperation:@"settle_denied_approval"
                             args:@{
                               @"locator" : DSHAgentLedgerArgument(locator),
                               @"root" : DSHAgentLedgerArgument(root),
                               @"expected_transcript" : DSHAgentLedgerArgument(expectedTranscript),
                               @"policy" : DSHAgentLedgerArgument(policy),
                               @"expected_reserved_write_bytes" : DSHAgentLedgerArgument(expectedReservedWriteBytes),
                               @"feedback_json" : DSHAgentLedgerArgument(feedbackJSON),
                               @"timestamp" : DSHAgentLedgerArgument(timestamp),
                             }
                          locator:locator
                           taskId:DSHAgentLedgerField(locator, @"task_id")
                        attemptId:DSHAgentLedgerField(locator, @"attempt_id")
               expectedTranscript:expectedTranscript
                         argOwner:nil
                             mode:DSHAgentLedgerRunModeInState
                          inState:state
                            error:error];
}

@end
