#import "AgentTranscriptStore.h"

#import <TargetConditionals.h>

#include <math.h>
#include <sys/stat.h>

static NSArray<NSString *> *DSHAgentTranscriptReferenceKeys(void) {
  return @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ];
}

static NSArray<NSString *> *DSHAgentRootKeys(void) {
  return @[
    @"schema_version", @"kind", @"workspace_id",
    @"workspace_binding_revision", @"project_id",
    @"root_fingerprint_sha256", @"capabilities",
  ];
}

static BOOL DSHAgentReason(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  return [value isEqualToString:@"completed"] ||
      [value isEqualToString:@"cancelled"] ||
      [value isEqualToString:@"failed"] ||
      [value isEqualToString:@"conversation_deleted"];
}

static BOOL DSHAgentRoot(NSDictionary *root) {
  if (!DSHAgentExactDictionaryKeys(root, DSHAgentRootKeys()) ||
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
  if (![kind isKindOfClass:NSString.class] ||
      (![kind isEqualToString:@"project"] && ![kind isEqualToString:@"workspace"])) {
    return NO;
  }
  id project = root[@"project_id"];
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

static BOOL DSHAgentReference(NSDictionary *reference) {
  return DSHAgentExactDictionaryKeys(reference, DSHAgentTranscriptReferenceKeys()) &&
      DSHAgentSafeInteger(reference[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(reference[@"transcript_ref"]) &&
      DSHAgentSafeInteger(reference[@"generation"], 9007199254740991ULL, YES) &&
      DSHAgentCanonicalSHA256(reference[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(reference[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

static BOOL DSHAgentOpaqueCallID(NSString *value) {
  NSString *string = nil;
  if (!DSHAgentBoundedUTF8String(value, 128, NO, &string)) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  return [string rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHAgentToolName(NSString *value) {
  NSString *name = nil;
  if (!DSHAgentBoundedUTF8String(value, 64, NO, &name)) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" ]
      invertedSet];
  return [name rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHAgentArgumentsJSON(NSString *value) {
  NSError *argumentsError = nil;
  return DSHAgentParseArgumentsJSON(value, &argumentsError) != nil;
}

static BOOL DSHAgentCanonicalFeedbackString(NSString *value) {
  NSError *nativeFeedbackError = nil;
  if (!DSHAgentValidateNativeToolFeedbackString(value, &nativeFeedbackError)) return NO;
  NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
  if (bytes == nil || bytes.length > DSHAgentNativeWALMaxTranscriptBytes) return NO;
  NSError *decodeError = nil;
  id object = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:&decodeError];
  if (![object isKindOfClass:NSDictionary.class]) return NO;
  NSError *canonicalError = nil;
  NSData *canonical = DSHAgentCanonicalJSON(object, &canonicalError);
  if (canonical == nil || ![canonical isEqualToData:bytes]) return NO;
  NSDictionary *feedback = object;
  if (!DSHAgentExactDictionaryKeys(feedback, @[
        @"schema_version", @"name", @"outcome", @"payload",
      ]) || !DSHAgentSafeInteger(feedback[@"schema_version"], 1, NO) ||
      !DSHAgentBoundedUTF8String(feedback[@"name"], 64, NO, nullptr) ||
      ![feedback[@"payload"] isKindOfClass:NSDictionary.class]) return NO;
  NSString *name = feedback[@"name"];
  NSString *outcome = feedback[@"outcome"];
  if (![name isKindOfClass:NSString.class] ||
      ![outcome isKindOfClass:NSString.class]) return NO;
  if ([name isEqualToString:@"list_dir"] && bytes.length > 64 * 1024) return NO;
  NSDictionary *payload = feedback[@"payload"];
  if ([outcome isEqualToString:@"failed"] ||
      [outcome isEqualToString:@"denied"] ||
      [outcome isEqualToString:@"cancelled"] ||
      [outcome isEqualToString:@"ambiguous"]) {
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"failure_code",
           ]) && DSHAgentSafeInteger(payload[@"schema_version"], 1, NO) &&
        DSHAgentFailureCode(payload[@"failure_code"]);
  }
  if (![outcome isEqualToString:@"ok"] ||
      !DSHAgentSafeInteger(payload[@"schema_version"], 1, NO)) return NO;
  if ([name isEqualToString:@"list_dir"]) {
    if (!DSHAgentExactDictionaryKeys(payload, @[
          @"schema_version", @"entries", @"truncated",
        ]) || ![payload[@"entries"] isKindOfClass:NSArray.class] ||
        [(NSArray *)payload[@"entries"] count] > 1000 ||
        ![payload[@"truncated"] isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)payload[@"truncated"]) != CFBooleanGetTypeID()) {
      return NO;
    }
    for (NSDictionary *entry in payload[@"entries"]) {
      if (!DSHAgentExactDictionaryKeys(entry, @[
            @"schema_version", @"name", @"type", @"revision",
          ]) || !DSHAgentSafeInteger(entry[@"schema_version"], 1, NO) ||
          !DSHAgentBoundedUTF8String(entry[@"name"], 4096, NO, nullptr) ||
          (![entry[@"type"] isEqualToString:@"file"] &&
           ![entry[@"type"] isEqualToString:@"directory"]) ||
          !DSHAgentBoundedUTF8String(entry[@"revision"], 256, NO, nullptr)) {
        return NO;
      }
    }
    return YES;
  }
  if ([name isEqualToString:@"read_file"]) {
    if (bytes.length > 64 * 1024) return NO;
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"content", @"revision", @"truncated",
           ]) && DSHAgentBoundedUTF8String(payload[@"content"], 64 * 1024, YES,
                                           nullptr) &&
        DSHAgentBoundedUTF8String(payload[@"revision"], 256, NO, nullptr) &&
        [payload[@"truncated"] isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)payload[@"truncated"]) == CFBooleanGetTypeID();
  }
  if ([name isEqualToString:@"write_file"]) {
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"bytes", @"revision",
           ]) && DSHAgentSafeInteger(payload[@"bytes"], 32768, YES) &&
        DSHAgentBoundedUTF8String(payload[@"revision"], 256, NO, nullptr);
  }
  if ([name isEqualToString:@"git_status"]) {
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"branch", @"head_oid", @"clean",
             @"has_conflicts", @"entry_count",
           ]) &&
        (payload[@"branch"] == NSNull.null ||
         DSHAgentBoundedUTF8String(payload[@"branch"], 1024, NO, nullptr)) &&
        (payload[@"head_oid"] == NSNull.null ||
         DSHAgentBoundedUTF8String(payload[@"head_oid"], 128, NO, nullptr)) &&
        [payload[@"clean"] isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)payload[@"clean"]) == CFBooleanGetTypeID() &&
        [payload[@"has_conflicts"] isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)payload[@"has_conflicts"]) == CFBooleanGetTypeID() &&
        DSHAgentSafeInteger(payload[@"entry_count"], 1000000, YES);
  }
  if ([name isEqualToString:@"git_commit"]) {
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"commit_oid", @"tree_oid",
           ]) && DSHAgentBoundedUTF8String(payload[@"commit_oid"], 128, NO, nullptr) &&
        DSHAgentBoundedUTF8String(payload[@"tree_oid"], 128, NO, nullptr);
  }
  if ([name isEqualToString:@"git_push"]) {
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"remote", @"remote_ref", @"pushed_oid",
           ]) && [payload[@"remote"] isEqualToString:@"origin"] &&
        DSHAgentBoundedUTF8String(payload[@"remote_ref"], 256, NO, nullptr) &&
        DSHAgentBoundedUTF8String(payload[@"pushed_oid"], 128, NO, nullptr);
  }
  return NO;
}

static BOOL DSHAgentTranscriptMessage(NSDictionary *message) {
  if (![message isKindOfClass:NSDictionary.class] ||
      !DSHAgentSafeInteger(message[@"schema_version"], 1, NO) ||
      !DSHAgentSafeInteger(message[@"round_index"], 7, YES)) {
    return NO;
  }
  NSString *role = message[@"role"];
  if (![role isKindOfClass:NSString.class]) return NO;
  if ([role isEqualToString:@"assistant"]) {
    if (!DSHAgentExactDictionaryKeys(message, @[
          @"schema_version", @"role", @"round_index", @"content",
          @"reasoning_content", @"tool_calls",
        ]) ||
        !DSHAgentBoundedUTF8String(message[@"content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        !DSHAgentBoundedUTF8String(message[@"reasoning_content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        ![message[@"tool_calls"] isKindOfClass:NSArray.class] ||
        [(NSArray *)message[@"tool_calls"] count] > 16) {
      return NO;
    }
    for (NSDictionary *call in message[@"tool_calls"]) {
      if (!DSHAgentExactDictionaryKeys(call, @[
            @"schema_version", @"call_id", @"name", @"arguments_json",
          ]) ||
          !DSHAgentSafeInteger(call[@"schema_version"], 1, NO) ||
          !DSHAgentOpaqueCallID(call[@"call_id"] ) ||
          !DSHAgentToolName(call[@"name"]) ||
          !DSHAgentArgumentsJSON(call[@"arguments_json"])) {
        return NO;
      }
    }
    return YES;
  }
  if ([role isEqualToString:@"tool"]) {
    return DSHAgentExactDictionaryKeys(message, @[
             @"schema_version", @"role", @"round_index", @"call_id",
             @"content", @"truncated",
           ]) &&
        DSHAgentOpaqueCallID(message[@"call_id"]) &&
        DSHAgentBoundedUTF8String(message[@"content"],
                                  DSHAgentNativeWALMaxTranscriptBytes, YES,
                                  nullptr) &&
        DSHAgentCanonicalFeedbackString(message[@"content"]) &&
        [message[@"truncated"] isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)message[@"truncated"]) ==
            CFBooleanGetTypeID();
  }
  return NO;
}

static NSString *DSHAgentTranscriptDigest(NSString *ref,
                                          NSString *attemptId,
                                          NSString *rootDigest,
                                          NSUInteger generation,
                                          NSArray *messages,
                                          NSData **canonicalBytes,
                                          NSError **error) {
  NSDictionary *input = @{
    @"schema_version" : @1,
    @"transcript_ref" : ref,
    @"attempt_id" : attemptId,
    @"root_fingerprint_sha256" : rootDigest,
    @"generation" : @(generation),
    @"messages" : messages,
  };
  NSError *canonicalError = nil;
  NSData *bytes = DSHAgentCanonicalJSON(input, &canonicalError);
  if (bytes == nil) {
    if (error != nullptr) *error = canonicalError;
    return nil;
  }
  if (canonicalBytes != nullptr) *canonicalBytes = bytes;
  return DSHAgentHJ(@"agent-transcript", input, error);
}

static NSDictionary *DSHAgentReferenceForRow(NSDictionary *row) {
  return @{
    @"schema_version" : @1,
    @"transcript_ref" : row[@"transcript_ref"],
    @"generation" : row[@"generation"],
    @"transcript_sha256" : row[@"transcript_sha256"],
    @"transcript_bytes" : row[@"transcript_bytes"],
  };
}

static BOOL DSHAgentExpectedReferenceMatches(NSDictionary *row,
                                             NSDictionary *expected,
                                             NSString *attemptId,
                                             NSDictionary *root,
                                             NSError **error) {
  if (!DSHAgentReference(expected) ||
      ![row[@"attempt_id"] isEqual:attemptId] ||
      ![row[@"root_fingerprint_sha256"] isEqual:root[@"root_fingerprint_sha256"]] ||
      ![row[@"transcript_ref"] isEqual:expected[@"transcript_ref"]] ||
      ![row[@"generation"] isEqual:expected[@"generation"]] ||
      ![row[@"transcript_sha256"] isEqual:expected[@"transcript_sha256"]] ||
      ![row[@"transcript_bytes"] isEqual:expected[@"transcript_bytes"]]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

static NSMutableDictionary *DSHAgentMutableDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] ? [value mutableCopy] : nil;
}

static NSMutableArray *DSHAgentMutableArray(id value) {
  return [value isKindOfClass:NSArray.class] ? [value mutableCopy] : nil;
}

@interface DSHAgentTranscriptStore ()
@property(nonatomic, strong, readwrite) DSHAgentNativeWAL *wal;
@end

@implementation DSHAgentTranscriptStore

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal {
  self = [super init];
  if (self) _wal = wal;
  return self;
}

- (NSDictionary *)createAgentTranscriptWithRequest:(NSDictionary *)request
                                              error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"attempt_id", @"root",
      ]) ||
      !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentRoot(request[@"root"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *attemptId = request[@"attempt_id"];
  NSDictionary *root = request[@"root"];
  __block NSDictionary *created = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *transcripts = DSHAgentMutableArray(state[@"transcripts"]);
    if (transcripts == nil) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    for (NSDictionary *existing in transcripts) {
      if (![existing[@"attempt_id"] isEqual:attemptId]) continue;
      if (![existing[@"root_fingerprint_sha256"]
               isEqual:root[@"root_fingerprint_sha256"]]) {
        // An attempt is permanently bound to one root.  Treating a second
        // root as a new transcript would permit stale/rebound work to append
        // to a valid attempt lineage.
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      created = DSHAgentReferenceForRow(existing);
      return NO;
    }
    if (transcripts.count >= DSHAgentNativeWALMaxTranscriptCount) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    NSString *ref = NSUUID.UUID.UUIDString.lowercaseString;
    NSString *timestamp = [self.wal currentTimestamp];
    NSData *digestInput = nil;
    NSString *digest = DSHAgentTranscriptDigest(
        ref, attemptId, root[@"root_fingerprint_sha256"], 0, @[], &digestInput,
        mutationError);
    if (digest == nil || digestInput.length > DSHAgentNativeWALMaxTranscriptBytes) {
      if (digest == nil) return NO;
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    NSMutableDictionary *row = [@{
      @"schema_version" : @1,
      @"transcript_ref" : ref,
      @"attempt_id" : attemptId,
      @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
      @"generation" : @0,
      @"messages" : @[],
      @"transcript_sha256" : digest,
      @"transcript_bytes" : @(digestInput.length),
      @"state" : @"open",
      @"retention_until" : NSNull.null,
      @"created_at" : timestamp,
      @"updated_at" : timestamp,
    } mutableCopy];
    [transcripts addObject:row];
    state[@"transcripts"] = transcripts;
    created = DSHAgentReferenceForRow(row);
    return YES;
  } error:error];
  return committed ? created : nil;
}

- (NSDictionary *)validateAgentTranscriptWithRequest:(NSDictionary *)request
                                                error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"attempt_id", @"root", @"transcript",
      ]) ||
      !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentRoot(request[@"root"]) ||
      !DSHAgentReference(request[@"transcript"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *snapshotError = nil;
  NSDictionary *state = [self.wal snapshotWithError:&snapshotError];
  if (state == nil) {
    if (error != nullptr) *error = snapshotError;
    return nil;
  }
  for (NSDictionary *row in state[@"transcripts"]) {
    if (![row[@"transcript_ref"] isEqual:request[@"transcript"][@"transcript_ref"]]) {
      continue;
    }
    if (DSHAgentExpectedReferenceMatches(row, request[@"transcript"],
                                         request[@"attempt_id"], request[@"root"],
                                         error)) {
      NSData *digestBytes = nil;
      NSString *digest = DSHAgentTranscriptDigest(
          row[@"transcript_ref"], row[@"attempt_id"],
          row[@"root_fingerprint_sha256"],
          [row[@"generation"] unsignedIntegerValue], row[@"messages"],
          &digestBytes, error);
      if (digest == nil || ![digest isEqual:row[@"transcript_sha256"]] ||
          digestBytes.length != [row[@"transcript_bytes"] unsignedIntegerValue] ||
          digestBytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return nil;
      }
      return @{ @"schema_version" : @1, @"status" : @"valid" };
    }
    return nil;
  }
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
  return nil;
}

- (NSArray<NSDictionary *> *)nativeMessagesForTranscriptWithRequest:
    (NSDictionary *)request
                                                                  error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"attempt_id", @"root", @"transcript",
      ]) ||
      !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentRoot(request[@"root"]) ||
      !DSHAgentReference(request[@"transcript"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  for (NSDictionary *row in state[@"transcripts"]) {
    if (![row[@"transcript_ref"] isEqual:request[@"transcript"][@"transcript_ref"]]) {
      continue;
    }
    if (!DSHAgentExpectedReferenceMatches(row, request[@"transcript"],
                                          request[@"attempt_id"], request[@"root"],
                                          error)) {
      return nil;
    }
    if (![row[@"state"] isEqualToString:@"open"] &&
        ![row[@"state"] isEqualToString:@"terminal"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
    NSData *digestBytes = nil;
    NSString *digest = DSHAgentTranscriptDigest(
        row[@"transcript_ref"], row[@"attempt_id"],
        row[@"root_fingerprint_sha256"],
        [row[@"generation"] unsignedIntegerValue], row[@"messages"],
        &digestBytes, error);
    if (digest == nil || ![digest isEqual:row[@"transcript_sha256"]] ||
        digestBytes.length != [row[@"transcript_bytes"] unsignedIntegerValue]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return nil;
    }
    return [row[@"messages"] copy];
  }
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
  return nil;
}

- (NSDictionary *)appendMessage:(NSDictionary *)message
             expectedTranscript:(NSDictionary *)expectedTranscript
                           root:(NSDictionary *)root
                       attemptId:(NSString *)attemptId
                           error:(NSError **)error {
  if (!DSHAgentTranscriptMessage(message) || !DSHAgentReference(expectedTranscript) ||
      !DSHAgentRoot(root) || !DSHAgentCanonicalUUID(attemptId)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *immutableMessageError = nil;
  NSDictionary *immutableMessage = DSHAgentImmutableJSONCopy(
      message, &immutableMessageError);
  if (![immutableMessage isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  message = immutableMessage;
  __block NSDictionary *result = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *transcripts = DSHAgentMutableArray(state[@"transcripts"]);
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSMutableDictionary *row = DSHAgentMutableDictionary(transcripts[index]);
      if (![row[@"transcript_ref"] isEqual:expectedTranscript[@"transcript_ref"]]) {
        continue;
      }
      if (!DSHAgentExpectedReferenceMatches(row, expectedTranscript, attemptId,
                                            root, mutationError)) {
        return NO;
      }
      if (![row[@"state"] isEqualToString:@"open"]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSMutableArray *messages = DSHAgentMutableArray(row[@"messages"]);
      if (messages == nil || messages.count >= 1024) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      [messages addObject:[message copy]];
      NSUInteger generation = [row[@"generation"] unsignedIntegerValue];
      if (generation == 9007199254740991ULL) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      generation += 1;
      NSData *digestInput = nil;
      NSString *digest = DSHAgentTranscriptDigest(
          row[@"transcript_ref"], attemptId, row[@"root_fingerprint_sha256"],
          generation, messages, &digestInput, mutationError);
      if (digest == nil || digestInput.length > DSHAgentNativeWALMaxTranscriptBytes) {
        if (digest == nil) return NO;
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"messages"] = messages;
      row[@"generation"] = @(generation);
      row[@"transcript_sha256"] = digest;
      row[@"transcript_bytes"] = @(digestInput.length);
      row[@"updated_at"] = [self.wal currentTimestamp];
      transcripts[index] = row;
      state[@"transcripts"] = transcripts;
      result = DSHAgentReferenceForRow(row);
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed ? result : nil;
}

- (NSDictionary *)appendAssistantMessage:(NSDictionary *)message
                    expectedTranscript:(NSDictionary *)expectedTranscript
                                   root:(NSDictionary *)root
                               attemptId:(NSString *)attemptId
                                   error:(NSError **)error {
  return [self appendMessage:message
           expectedTranscript:expectedTranscript
                         root:root
                     attemptId:attemptId
                         error:error];
}

- (NSDictionary *)appendToolMessage:(NSDictionary *)message
                 expectedTranscript:(NSDictionary *)expectedTranscript
                               root:(NSDictionary *)root
                           attemptId:(NSString *)attemptId
                               error:(NSError **)error {
  return [self appendMessage:message
           expectedTranscript:expectedTranscript
                         root:root
                     attemptId:attemptId
                         error:error];
}

- (NSDictionary *)markAgentTranscriptTerminalWithRequest:(NSDictionary *)request
                                                    error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"attempt_id", @"root", @"transcript", @"reason",
        @"cleanup_id", @"cleanup_owner",
      ]) ||
      !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentRoot(request[@"root"]) || !DSHAgentReference(request[@"transcript"]) ||
      !DSHAgentReason(request[@"reason"]) ||
      !DSHAgentCanonicalUUID(request[@"cleanup_id"]) ||
      !DSHAgentCanonicalUUID(request[@"cleanup_owner"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *transcripts = DSHAgentMutableArray(state[@"transcripts"]);
    NSMutableArray *cleanup = DSHAgentMutableArray(state[@"cleanup"]);
    for (NSMutableDictionary *row in transcripts) {
      if (![row[@"transcript_ref"] isEqual:request[@"transcript"][@"transcript_ref"]]) {
        continue;
      }
      if (!DSHAgentExpectedReferenceMatches(row, request[@"transcript"],
                                            request[@"attempt_id"], request[@"root"],
                                            mutationError)) {
        return NO;
      }
      if ([row[@"state"] isEqualToString:@"terminal"] ||
          [row[@"state"] isEqualToString:@"cleanup_pending"]) {
        BOOL existingCleanup = NO;
        for (NSDictionary *entry in cleanup) {
          if (![entry[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) continue;
          existingCleanup = YES;
          if (![entry[@"cleanup_owner"] isEqual:request[@"cleanup_owner"]] ||
              ![entry[@"reason"] isEqual:request[@"reason"]] ||
              ![entry[@"transcript_ref"] isEqual:row[@"transcript_ref"]] ||
              ![entry[@"transcript_sha256"] isEqual:row[@"transcript_sha256"]]) {
            DSHSetAgentNativeStoreError(mutationError,
                                        DSHAgentNativeStoreErrorConflict);
            return NO;
          }
          break;
        }
        if (!existingCleanup) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorConflict);
          return NO;
        }
        output = @{
          @"schema_version" : @1,
          @"status" : @"already_terminal",
          @"transcript" : DSHAgentReferenceForRow(row),
        };
        return NO;
      }
      if (![row[@"state"] isEqualToString:@"open"]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      row[@"state"] = @"terminal";
      row[@"retention_until"] = [self.wal currentTimestampAddingInterval:7 * 24 * 60 * 60];
      row[@"updated_at"] = [self.wal currentTimestamp];
      BOOL cleanupExists = NO;
      for (NSDictionary *entry in cleanup) {
        if ([entry[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) {
          cleanupExists = YES;
          if (![entry[@"transcript_ref"] isEqual:row[@"transcript_ref"]] ||
              ![entry[@"transcript_sha256"] isEqual:row[@"transcript_sha256"]] ||
              ![entry[@"cleanup_owner"] isEqual:request[@"cleanup_owner"]] ||
              ![entry[@"reason"] isEqual:request[@"reason"]]) {
            DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
            return NO;
          }
        }
      }
      if (!cleanupExists) {
        [cleanup addObject:@{
          @"schema_version" : @1,
          @"cleanup_id" : request[@"cleanup_id"],
          @"attempt_id" : request[@"attempt_id"],
          @"transcript_ref" : row[@"transcript_ref"],
          @"transcript_sha256" : row[@"transcript_sha256"],
          @"cleanup_owner" : request[@"cleanup_owner"],
          @"reason" : request[@"reason"],
          @"created_at" : [self.wal currentTimestamp],
          @"status" : @"pending",
        }];
      }
      state[@"transcripts"] = transcripts;
      state[@"cleanup"] = cleanup;
      output = @{
        @"schema_version" : @1,
        @"status" : @"terminal",
        @"transcript" : DSHAgentReferenceForRow(row),
      };
      return YES;
    }
    DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
    return NO;
  } error:error];
  return committed ? output : nil;
}

- (NSDictionary *)discardAgentTranscriptWithRequest:(NSDictionary *)request
                                               error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"attempt_id", @"transcript_ref",
        @"transcript_sha256", @"cleanup_id", @"cleanup_owner",
      ]) ||
      !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(request[@"transcript_ref"]) ||
      !DSHAgentCanonicalSHA256(request[@"transcript_sha256"]) ||
      !DSHAgentCanonicalUUID(request[@"cleanup_id"]) ||
      !DSHAgentCanonicalUUID(request[@"cleanup_owner"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSString *status = nil;
  BOOL committed = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *transcripts = DSHAgentMutableArray(state[@"transcripts"]);
    NSMutableArray *cleanup = DSHAgentMutableArray(state[@"cleanup"]);
    NSUInteger transcriptIndex = NSNotFound;
    NSMutableDictionary *row = nil;
    for (NSUInteger index = 0; index < transcripts.count; index += 1) {
      NSMutableDictionary *candidate = DSHAgentMutableDictionary(transcripts[index]);
      if ([candidate[@"transcript_ref"] isEqual:request[@"transcript_ref"]]) {
        transcriptIndex = index;
        row = candidate;
        break;
      }
    }
    if (row == nil) {
      for (NSDictionary *entry in cleanup) {
        if ([entry[@"cleanup_id"] isEqual:request[@"cleanup_id"]] &&
            [entry[@"status"] isEqualToString:@"discarded"]) {
          if (![entry[@"cleanup_owner"] isEqual:request[@"cleanup_owner"]] ||
              ![entry[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
              ![entry[@"transcript_ref"] isEqual:request[@"transcript_ref"]] ||
              ![entry[@"transcript_sha256"] isEqual:request[@"transcript_sha256"]]) {
            DSHSetAgentNativeStoreError(mutationError,
                                        DSHAgentNativeStoreErrorConflict);
            return NO;
          }
          status = @"already_missing";
          return NO;
        }
      }
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorNotFound);
      return NO;
    }
    if (![row[@"attempt_id"] isEqual:request[@"attempt_id"]] ||
        ![row[@"transcript_sha256"] isEqual:request[@"transcript_sha256"]] ||
        ![row[@"state"] isEqualToString:@"terminal"]) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    BOOL cleanupMatched = NO;
    for (NSDictionary *entry in cleanup) {
      if (![entry[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) continue;
      cleanupMatched = YES;
      if (![entry[@"cleanup_owner"] isEqual:request[@"cleanup_owner"]] ||
          ![entry[@"transcript_ref"] isEqual:request[@"transcript_ref"]] ||
          ![entry[@"transcript_sha256"] isEqual:request[@"transcript_sha256"]]) {
        DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      break;
    }
    if (!cleanupMatched) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    for (NSDictionary *round in state[@"rounds"]) {
      NSString *roundState = round[@"state"];
      if ([roundState isEqualToString:@"in_flight"] ||
          [roundState isEqualToString:@"cancel_requested"] ||
          [roundState isEqualToString:@"unknown"] ||
          [roundState isEqualToString:@"ambiguous"]) {
        NSDictionary *before = round[@"transcript_before"];
        NSDictionary *after = round[@"transcript_after"];
        if ([before[@"transcript_ref"] isEqual:request[@"transcript_ref"]] ||
            ((id)after != NSNull.null &&
             [after[@"transcript_ref"] isEqual:request[@"transcript_ref"]])) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorConflict);
          return NO;
        }
      }
    }
    for (NSDictionary *ledger in state[@"ledger"]) {
      NSString *ledgerState = ledger[@"state"];
      if ([ledgerState isEqualToString:@"intent"] ||
          [ledgerState isEqualToString:@"running"] ||
          [ledgerState isEqualToString:@"cancel_requested"] ||
          [ledgerState isEqualToString:@"unknown"] ||
          [ledgerState isEqualToString:@"ambiguous"]) {
        NSDictionary *before = ledger[@"transcript_before"];
        NSDictionary *after = ledger[@"transcript_after"];
        if ([before[@"transcript_ref"] isEqual:request[@"transcript_ref"]] ||
            ((id)after != NSNull.null &&
             [after[@"transcript_ref"] isEqual:request[@"transcript_ref"]])) {
          DSHSetAgentNativeStoreError(mutationError,
                                      DSHAgentNativeStoreErrorConflict);
          return NO;
        }
      }
    }
    [transcripts removeObjectAtIndex:transcriptIndex];
    for (NSMutableDictionary *entry in cleanup) {
      if ([entry[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) {
        entry[@"status"] = @"discarded";
      }
    }
    state[@"transcripts"] = transcripts;
    state[@"cleanup"] = cleanup;
    status = @"discarded";
    return YES;
  } error:error];
  return committed ? @{ @"schema_version" : @1, @"status" : status ?: @"discarded" } : nil;
}

- (NSDictionary *)queryAgentTranscriptCleanupWithRequest:(NSDictionary *)request
                                                    error:(NSError **)error {
  if (!DSHAgentExactDictionaryKeys(request, @[
        @"schema_version", @"cleanup_id",
      ]) ||
      !DSHAgentSafeInteger(request[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(request[@"cleanup_id"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (state == nil) return nil;
  for (NSDictionary *entry in state[@"cleanup"]) {
    if ([entry[@"cleanup_id"] isEqual:request[@"cleanup_id"]]) {
      return @{ @"schema_version" : @1, @"status" : entry[@"status"] };
    }
  }
  return @{ @"schema_version" : @1, @"status" : @"unknown" };
}

- (BOOL)performAtomicTransaction:(DSHAgentNativeWALMutation)mutation
                           error:(NSError **)error {
  return [self.wal performAtomicTransaction:mutation error:error];
}

@end
