#import "AgentTranscriptStore.h"

#import <TargetConditionals.h>
#import "DSHWorkspaceCanonical.h"
#include <fcntl.h>
#include <unistd.h>

#include <math.h>
#include <sys/stat.h>

static NSUInteger const DSHPresentationMaxFile = 2 * 1024 * 1024;
static NSUInteger const DSHPresentationMaxTotal = 64 * 1024 * 1024;
static NSString *DSHPresentationDigest(NSString *text) {
  return DSHWorkspaceSHA256Hex([text dataUsingEncoding:NSUTF8StringEncoding]);
}
static BOOL DSHPresentationRoundValid(NSDictionary *value) {
  return DSHAgentExactDictionaryKeys(value, @[@"round_id", @"round_index", @"kind", @"text", @"reasoning", @"assistant_text_sha256", @"reasoning_text_sha256"]) &&
      DSHAgentCanonicalUUID(value[@"round_id"]) && DSHAgentSafeInteger(value[@"round_index"], 7, YES) &&
      [@[@"tool_batch", @"final", @"blocked"] containsObject:value[@"kind"]] &&
      DSHAgentBoundedUTF8String(value[@"text"], DSHPresentationMaxFile, YES, nullptr) &&
      DSHAgentBoundedUTF8String(value[@"reasoning"], DSHPresentationMaxFile, YES, nullptr) &&
      [DSHPresentationDigest(value[@"text"]) isEqual:value[@"assistant_text_sha256"]] &&
      [DSHPresentationDigest(value[@"reasoning"]) isEqual:value[@"reasoning_text_sha256"]];
}
static NSDictionary *DSHPresentationRound(NSString *roundId, NSNumber *index, NSString *kind, NSDictionary *message) {
  NSString *text = message[@"content"], *reasoning = message[@"reasoning_content"];
  if (![text isKindOfClass:NSString.class] || ![reasoning isKindOfClass:NSString.class]) return nil;
  NSDictionary *value = @{ @"round_id": roundId, @"round_index": index, @"kind": kind, @"text": text, @"reasoning": reasoning, @"assistant_text_sha256": DSHPresentationDigest(text), @"reasoning_text_sha256": DSHPresentationDigest(reasoning) };
  return DSHPresentationRoundValid(value) ? value : nil;
}
static NSURL *DSHPresentationDirectory(NSURL *walRoot) {
  return [walRoot URLByAppendingPathComponent:@"round-presentations-v1" isDirectory:YES];
}
static NSDictionary *DSHPresentationRead(NSURL *url) {
  int fd = open(url.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return nil;
  struct stat metadata = {};
  if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_size < 0 || metadata.st_size > DSHPresentationMaxFile) { close(fd); return nil; }
  NSFileHandle *handle = [[NSFileHandle alloc] initWithFileDescriptor:fd closeOnDealloc:YES];
  NSData *bytes = [handle readDataToEndOfFile];
  [handle closeFile];
  id value = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
  if (!DSHAgentExactDictionaryKeys(value, @[@"schema_version", @"conversation_id", @"attempt_id", @"rounds"]) || ![value[@"schema_version"] isEqual:@1] || !DSHAgentCanonicalUUID(value[@"conversation_id"]) || !DSHAgentCanonicalUUID(value[@"attempt_id"]) || ![value[@"rounds"] isKindOfClass:NSArray.class] || [value[@"rounds"] count] > 8) return nil;
  NSMutableSet *ids = [NSMutableSet set], *indices = [NSMutableSet set];
  for (NSDictionary *round in value[@"rounds"]) {
    if (!DSHPresentationRoundValid(round) || [ids containsObject:round[@"round_id"]] || [indices containsObject:round[@"round_index"]]) return nil;
    [ids addObject:round[@"round_id"]]; [indices addObject:round[@"round_index"]];
  }
  return value;
}
// Invoked after a committed session deletion as well as display reads. It
// never changes session/WAL authority. Capacity eviction affects display only.
void DSHAgentPruneRoundPresentationCache(NSURL *walRoot, NSSet<NSString *> *conversationIds) {
  @synchronized(DSHAgentTranscriptStore.class) {
    NSURL *directory = DSHPresentationDirectory(walRoot);
    NSArray<NSURL *> *files = [NSFileManager.defaultManager contentsOfDirectoryAtURL:directory includingPropertiesForKeys:@[NSURLFileSizeKey, NSURLContentModificationDateKey] options:0 error:nil];
    NSMutableArray<NSDictionary *> *retained = [NSMutableArray array]; NSUInteger total = 0;
    for (NSURL *file in files) {
      NSString *name = file.lastPathComponent;
      NSArray *parts = [[name stringByDeletingPathExtension] componentsSeparatedByString:@"_"];
      if (parts.count != 2 || !DSHAgentCanonicalUUID(parts[0]) || !DSHAgentCanonicalUUID(parts[1]) || ![file.pathExtension isEqual:@"json"]) continue;
      if (conversationIds && ![conversationIds containsObject:parts[0]]) { [NSFileManager.defaultManager removeItemAtURL:file error:nil]; continue; }
      NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:file.path error:nil];
      NSUInteger size = [attributes[NSFileSize] unsignedIntegerValue];
      if (![attributes[NSFileType] isEqual:NSFileTypeRegular] || size > DSHPresentationMaxFile) { [NSFileManager.defaultManager removeItemAtURL:file error:nil]; continue; }
      total += size;
      [retained addObject:@{ @"url": file, @"bytes": @(size), @"date": attributes[NSFileModificationDate] ?: NSDate.distantPast }];
    }
    [retained sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) { return [left[@"date"] compare:right[@"date"]]; }];
    NSUInteger count = retained.count;
    for (NSDictionary *entry in retained) {
      if (total <= DSHPresentationMaxTotal && count <= 256) break;
      [NSFileManager.defaultManager removeItemAtURL:entry[@"url"] error:nil]; total -= [entry[@"bytes"] unsignedIntegerValue]; count--;
    }
  }
}

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
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push", @"guest_service",
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
  // The WAL validator is the single exact feedback contract. Duplicating the
  // per-tool payload schemas here caused accepted CGI/hash feedback to be
  // rejected when the protected transcript was reopened.
  return DSHAgentValidateNativeToolFeedbackString(value, nullptr);
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

- (void)cacheRoundPresentationForRequest:(NSDictionary *)request message:(NSDictionary *)message kind:(NSString *)kind {
  if (!DSHAgentCanonicalUUID(request[@"conversation_id"]) || !DSHAgentCanonicalUUID(request[@"attempt_id"])) return;
  NSDictionary *round = DSHPresentationRound(request[@"round_id"], request[@"round_index"], kind, message);
  if (!round) return;
  @synchronized(DSHAgentTranscriptStore.class) {
    NSURL *directory = DSHPresentationDirectory(self.wal.rootURL);
    struct stat metadata = {};
    if (lstat(directory.fileSystemRepresentation, &metadata) == 0 && !S_ISDIR(metadata.st_mode)) return;
    if (![NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700, NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication} error:nil]) return;
    [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
    NSString *name = [NSString stringWithFormat:@"%@_%@.json", request[@"conversation_id"], request[@"attempt_id"]];
    NSURL *file = [directory URLByAppendingPathComponent:name];
    NSDictionary *prior = DSHPresentationRead(file);
    NSMutableDictionary *byIndex = [NSMutableDictionary dictionary];
    if ([prior[@"conversation_id"] isEqual:request[@"conversation_id"]] && [prior[@"attempt_id"] isEqual:request[@"attempt_id"]]) {
      for (NSDictionary *old in prior[@"rounds"]) byIndex[old[@"round_index"]] = old;
    }
    byIndex[round[@"round_index"]] = round;
    NSArray *keys = [byIndex.allKeys sortedArrayUsingSelector:@selector(compare:)];
    NSMutableArray *rounds = [NSMutableArray array];
    for (NSNumber *key in keys) [rounds addObject:byIndex[key]];
    NSDictionary *projection = @{ @"schema_version": @1, @"conversation_id": request[@"conversation_id"], @"attempt_id": request[@"attempt_id"], @"rounds": rounds };
    NSData *data = DSHAgentCanonicalJSON(projection, nil);
    if (!data || data.length > DSHPresentationMaxFile) return;
    if (![data writeToURL:file options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil]) return;
    [NSFileManager.defaultManager setAttributes:@{ NSFilePosixPermissions: @0600 } ofItemAtPath:file.path error:nil];
    DSHAgentPruneRoundPresentationCache(self.wal.rootURL, nil);
  }
}

- (NSDictionary *)roundPresentationsForConversation:(NSString *)conversationId attempt:(NSString *)attemptId error:(NSError **)error {
  if (!DSHAgentCanonicalUUID(conversationId) || !DSHAgentCanonicalUUID(attemptId)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument); return nil;
  }
  // snapshotWithError verifies the immutable WAL and transcript hashes. This
  // query never reconciles/replays/advances an authority or provider round.
  NSDictionary *state = [self.wal snapshotWithError:error];
  if (!state) return nil;
  NSMutableDictionary *byIndex = [NSMutableDictionary dictionary];
  @synchronized(DSHAgentTranscriptStore.class) {
    NSURL *file = [DSHPresentationDirectory(self.wal.rootURL) URLByAppendingPathComponent:[NSString stringWithFormat:@"%@_%@.json", conversationId, attemptId]];
    NSDictionary *cached = DSHPresentationRead(file);
    if ([cached[@"conversation_id"] isEqual:conversationId] && [cached[@"attempt_id"] isEqual:attemptId]) {
      for (NSDictionary *round in cached[@"rounds"]) byIndex[round[@"round_index"]] = round;
    }
  }
  for (NSDictionary *row in state[@"rounds"]) {
    NSDictionary *locator = row[@"locator"];
    if (![locator[@"attempt_id"] isEqual:attemptId] || ![row[@"state"] isEqual:@"completed"]) continue;
    NSString *kind = row[@"terminal_kind"];
    if (![@[@"tool_batch", @"final", @"blocked"] containsObject:kind]) continue;
    NSDictionary *reference = row[@"transcript_after"];
    for (NSDictionary *transcript in state[@"transcripts"]) {
      if (![transcript[@"attempt_id"] isEqual:attemptId] || ![transcript[@"transcript_ref"] isEqual:reference[@"transcript_ref"]] || [transcript[@"generation"] unsignedLongLongValue] < [reference[@"generation"] unsignedLongLongValue]) continue;
      for (NSDictionary *message in [transcript[@"messages"] reverseObjectEnumerator]) {
        if (![message[@"role"] isEqual:@"assistant"] || ![message[@"round_index"] isEqual:locator[@"round_index"]]) continue;
        NSDictionary *round = DSHPresentationRound(locator[@"round_id"], locator[@"round_index"], kind, message);
        if (round) byIndex[round[@"round_index"]] = round;
        break;
      }
    }
  }
  if (byIndex.count > 8) { DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt); return nil; }
  NSMutableArray *rounds = [NSMutableArray array];
  for (NSNumber *index in [byIndex.allKeys sortedArrayUsingSelector:@selector(compare:)]) [rounds addObject:byIndex[index]];
  return @{ @"schema_version": @1, @"conversation_id": conversationId, @"attempt_id": attemptId, @"rounds": rounds };
}



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
