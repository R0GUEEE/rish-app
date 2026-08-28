#import "ProjectContextService.h"

#import <CommonCrypto/CommonDigest.h>

#include <fcntl.h>
#include <git2.h>
#include <math.h>
#include <sys/stat.h>
#include <unistd.h>

NSErrorDomain const DSHProjectContextServiceErrorDomain =
    @"dev.zseven.rish.project-context-service";

static NSError *DSHServiceError(DSHProjectContextServiceErrorCode code) {
  NSString *message = @"Project context input is invalid.";
  switch (code) {
    case DSHProjectContextServiceErrorProjectUnavailable:
      message = @"Project context is unavailable.";
      break;
    case DSHProjectContextServiceErrorChanged:
      message = @"Project context changed.";
      break;
    case DSHProjectContextServiceErrorSecret:
      message = @"Project context contains restricted data.";
      break;
    case DSHProjectContextServiceErrorBudgetExceeded:
      message = @"Project context budget exceeded.";
      break;
    case DSHProjectContextServiceErrorStorage:
      message = @"Project context storage is unavailable.";
      break;
    case DSHProjectContextServiceErrorTimeout:
      message = @"Project context preparation timed out.";
      break;
    case DSHProjectContextServiceErrorConsent:
      message = @"Project context consent is invalid.";
      break;
    case DSHProjectContextServiceErrorIntegrity:
      message = @"Project context integrity validation failed.";
      break;
    case DSHProjectContextServiceErrorSnapshotMissing:
      message = @"Project context snapshot is missing.";
      break;
    case DSHProjectContextServiceErrorInvalidArgument:
      break;
  }
  return [NSError errorWithDomain:DSHProjectContextServiceErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

static void DSHSetServiceError(NSError **error,
                               DSHProjectContextServiceErrorCode code) {
  if (error != nil) *error = DSHServiceError(code);
}

static DSHProjectContextServiceErrorCode DSHServiceSnapshotStoreError(
    NSError *storeError) {
  if ([storeError.domain isEqual:DSHProjectContextStoreErrorDomain]) {
    if (storeError.code == DSHProjectContextStoreErrorNotFound) {
      return DSHProjectContextServiceErrorSnapshotMissing;
    }
    if (storeError.code == DSHProjectContextStoreErrorIntegrity) {
      return DSHProjectContextServiceErrorIntegrity;
    }
  }
  return DSHProjectContextServiceErrorStorage;
}

static NSString *DSHServiceSHA256(NSData *data) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex =
      [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

static NSString *DSHServiceOid(const git_oid *oid) {
  if (oid == nullptr || git_oid_is_zero(oid)) return nil;
  char output[GIT_OID_SHA1_HEXSIZE + 1] = {};
  git_oid_tostr(output, sizeof(output), oid);
  return [NSString stringWithUTF8String:output];
}

static NSData *DSHCanonicalJSON(id object) {
  if (![NSJSONSerialization isValidJSONObject:object]) return nil;
  return [NSJSONSerialization dataWithJSONObject:object
                                         options:NSJSONWritingSortedKeys
                                           error:nil];
}

static NSString *DSHServiceISO8601(NSDate *date) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  return [formatter stringFromDate:date];
}

static BOOL DSHServiceCanonicalIdentifier(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length != 36) return NO;
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:value];
  return uuid != nil &&
         [uuid.UUIDString.lowercaseString isEqualToString:value];
}

static BOOL DSHServiceExactKeys(NSDictionary *object,
                                NSArray<NSString *> *keys) {
  if (![object isKindOfClass:NSDictionary.class] || object.count != keys.count) {
    return NO;
  }
  NSSet *allowed = [NSSet setWithArray:keys];
  for (id key in object) {
    if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHServiceSameStat(const struct stat &left,
                               const struct stat &right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
         left.st_mode == right.st_mode && left.st_nlink == right.st_nlink &&
         left.st_size == right.st_size &&
         left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec &&
         left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec &&
         left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec &&
         left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec;
}

static NSDictionary *DSHServiceStatDescriptor(const struct stat &metadata) {
  return @{
    @"device" : @((unsigned long long)metadata.st_dev),
    @"inode" : @((unsigned long long)metadata.st_ino),
    @"mode" : @((unsigned long long)metadata.st_mode),
    @"links" : @((unsigned long long)metadata.st_nlink),
    @"size" : @((long long)metadata.st_size),
    @"mtime_seconds" : @((long long)metadata.st_mtimespec.tv_sec),
    @"mtime_nanoseconds" : @((long long)metadata.st_mtimespec.tv_nsec),
    @"ctime_seconds" : @((long long)metadata.st_ctimespec.tv_sec),
    @"ctime_nanoseconds" : @((long long)metadata.st_ctimespec.tv_nsec),
  };
}

static NSDictionary *DSHServiceObservation(const struct stat &metadata) {
  NSDictionary *descriptor = DSHServiceStatDescriptor(metadata);
  return @{
    @"metadata" : descriptor,
    @"observation_sha256" :
        DSHServiceSHA256(DSHCanonicalJSON(descriptor) ?: NSData.data),
  };
}

static NSString *DSHServiceDeltaPath(const git_diff_delta *delta,
                                     BOOL newSide) {
  if (delta == nullptr) return nil;
  const char *path = newSide ? delta->new_file.path : delta->old_file.path;
  if (path == nullptr) path = newSide ? delta->old_file.path : delta->new_file.path;
  return path == nullptr ? nil : [NSString stringWithUTF8String:path];
}

static NSString *DSHServiceGitState(BOOL staged,
                                    BOOL unstaged,
                                    BOOL conflicted) {
  if (conflicted) return @"conflicted";
  if (unstaged) return @"unstaged";
  if (staged) return @"staged";
  return @"unchanged";
}

@interface DSHProjectContextService ()
@property(nonatomic, strong) DSHLocalProjectAccess *projectAccess;
@property(nonatomic, strong) DSHProjectContextStore *store;
@property(nonatomic, strong) DSHProjectContextPolicy *policy;
@property(nonatomic, copy) DSHProjectContextClock clock;
@property(nonatomic, copy) DSHProjectContextIdentifierGenerator identifierGenerator;
@property(nonatomic, copy, nullable) DSHProjectContextServiceHook hook;
@end

@implementation DSHProjectContextService

- (instancetype)init {
  return [self initWithProjectAccess:DSHLocalProjectAccess.sharedAccess
                               store:[[DSHProjectContextStore alloc] init]
                              policy:[[DSHProjectContextPolicy alloc] init]
                               clock:^NSDate * {
                                 return NSDate.date;
                               }
                 identifierGenerator:^NSString * {
                   return NSUUID.UUID.UUIDString.lowercaseString;
                 }
                                hook:nil];
}

- (instancetype)initWithProjectAccess:(DSHLocalProjectAccess *)projectAccess
                                  store:(DSHProjectContextStore *)store
                                 policy:(DSHProjectContextPolicy *)policy
                                  clock:(DSHProjectContextClock)clock
                    identifierGenerator:
                        (DSHProjectContextIdentifierGenerator)identifierGenerator
                                   hook:(DSHProjectContextServiceHook)hook {
  self = [super init];
  if (self) {
    _projectAccess = projectAccess;
    _store = store;
    _policy = policy;
    _clock = [clock copy];
    _identifierGenerator = [identifierGenerator copy];
    _hook = [hook copy];
  }
  return self;
}

- (BOOL)deadlineFrom:(NSDate *)start error:(NSError **)error {
  NSTimeInterval elapsed = [self.clock() timeIntervalSinceDate:start];
  if (!isfinite(elapsed) || elapsed < 0 ||
      elapsed > DSHProjectContextDeadlineSeconds) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorTimeout);
    return NO;
  }
  return YES;
}

- (NSDictionary *)validatedSelection:(NSDictionary *)selection
                                error:(NSError **)error {
  NSArray *keys = @[
    @"schema_version", @"project_id", @"conversation_id", @"provider",
    @"model", @"policy", @"selected_paths"
  ];
  NSArray *models = @[
    @"deepseek-v4-flash", @"deepseek-v4-pro",
    @"deepseek-v4-flash-vision-exp"
  ];
  if (!DSHServiceExactKeys(selection, keys) ||
      ![selection[@"schema_version"] isEqual:@1] ||
      ![DSHLocalProjectAccess isCanonicalProjectId:selection[@"project_id"]] ||
      !DSHServiceCanonicalIdentifier(selection[@"conversation_id"]) ||
      ![selection[@"provider"] isEqual:@"deepseek"] ||
      ![models containsObject:selection[@"model"]] ||
      ![selection[@"policy"] isEqual:@"chat-read-v1"] ||
      ![selection[@"selected_paths"] isKindOfClass:NSArray.class] ||
      [selection[@"selected_paths"] count] > DSHProjectContextMaxEntries) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorInvalidArgument);
    return nil;
  }
  NSMutableArray<NSString *> *paths = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  for (id rawPath in selection[@"selected_paths"]) {
    if (![rawPath isKindOfClass:NSString.class]) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorInvalidArgument);
      return nil;
    }
    DSHProjectContextPathDecision *decision =
        [self.policy decisionForRelativePath:rawPath];
    NSString *normalized = decision.normalizedPath;
    if (normalized.length == 0 || [seen containsObject:normalized]) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorInvalidArgument);
      return nil;
    }
    [seen addObject:normalized];
    [paths addObject:normalized];
  }
  [paths sortUsingSelector:@selector(compare:)];
  NSMutableDictionary *validated = [selection mutableCopy];
  validated[@"selected_paths"] = paths;
  return validated;
}

- (NSDictionary *)safeReadPath:(NSString *)relativePath
                          lease:(DSHLocalProjectLease *)lease
                          error:(NSError **)error {
  NSArray<NSString *> *components = [relativePath componentsSeparatedByString:@"/"];
  int current = dup(lease.repositoryDescriptor);
  if (current < 0) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorProjectUnavailable);
    return nil;
  }
  for (NSUInteger index = 0; index + 1 < components.count; index++) {
    NSString *component = components[index];
    struct stat before = {};
    if (fstatat(current, component.fileSystemRepresentation, &before,
                AT_SYMLINK_NOFOLLOW) != 0) {
      close(current);
      return @{
        @"reason" : DSHProjectContextOmissionReasonPolicy,
        @"observation_sha256" : DSHServiceSHA256(
            DSHCanonicalJSON(@{
              @"state" : @"missing_ancestor",
              @"component_index" : @(index),
            }) ?: NSData.data),
      };
    }
    if (!S_ISDIR(before.st_mode) ||
        before.st_dev != lease.repositoryDevice) {
      NSDictionary *ancestor = DSHServiceObservation(before);
      close(current);
      NSDictionary *boundObservation = @{
        @"state" : @"unsafe_ancestor",
        @"component_index" : @(index),
        @"metadata" : ancestor[@"metadata"],
      };
      return @{
        @"reason" : DSHProjectContextOmissionReasonPolicy,
        @"metadata" : ancestor[@"metadata"],
        @"observation_sha256" : DSHServiceSHA256(
            DSHCanonicalJSON(boundObservation) ?: NSData.data),
      };
    }
    int next = openat(current, component.fileSystemRepresentation,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened = {};
    BOOL valid = next >= 0 && fstat(next, &opened) == 0 &&
                 DSHServiceSameStat(before, opened);
    close(current);
    if (!valid) {
      if (next >= 0) close(next);
      DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
      return nil;
    }
    current = next;
  }
  NSString *filename = components.lastObject;
  struct stat before = {};
  if (fstatat(current, filename.fileSystemRepresentation, &before,
              AT_SYMLINK_NOFOLLOW) != 0) {
    close(current);
    return @{
      @"reason" : DSHProjectContextOmissionReasonPolicy,
      @"observation_sha256" : DSHServiceSHA256(
          DSHCanonicalJSON(@{@"state" : @"missing"}) ?: NSData.data),
    };
  }
  NSDictionary *observation = DSHServiceObservation(before);
  if (!S_ISREG(before.st_mode) || before.st_nlink != 1 ||
      before.st_dev != lease.repositoryDevice) {
    close(current);
    return @{
      @"reason" : DSHProjectContextOmissionReasonPolicy,
      @"metadata" : observation[@"metadata"],
      @"observation_sha256" : observation[@"observation_sha256"],
    };
  }
  if (before.st_size < 0 ||
      before.st_size > (off_t)DSHProjectContextMaxFileBytes) {
    close(current);
    return @{
      @"reason" : DSHProjectContextOmissionReasonBudgetExceeded,
      @"metadata" : observation[@"metadata"],
      @"observation_sha256" : observation[@"observation_sha256"],
    };
  }
  if (self.hook != nil) self.hook(@"before_file_open", relativePath);
  int descriptor = openat(current, filename.fileSystemRepresentation,
                          O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  close(current);
  if (descriptor < 0) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return nil;
  }
  if (self.hook != nil) self.hook(@"after_file_open", relativePath);
  struct stat opened = {};
  BOOL valid = fstat(descriptor, &opened) == 0 &&
               DSHServiceSameStat(before, opened);
  NSMutableData *data =
      valid ? [NSMutableData dataWithLength:(NSUInteger)opened.st_size] : nil;
  NSUInteger offset = 0;
  while (valid && offset < data.length) {
    ssize_t count = pread(descriptor,
                          static_cast<uint8_t *>(data.mutableBytes) + offset,
                          data.length - offset, (off_t)offset);
    if (count <= 0) {
      valid = NO;
      break;
    }
    offset += (NSUInteger)count;
  }
  if (self.hook != nil) self.hook(@"after_file_read", relativePath);
  struct stat after = {};
  valid = valid && fstat(descriptor, &after) == 0 &&
          DSHServiceSameStat(opened, after);
  close(descriptor);
  int directory = dup(lease.repositoryDescriptor);
  for (NSUInteger index = 0; valid && index + 1 < components.count; index++) {
    int next = openat(directory, components[index].fileSystemRepresentation,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close(directory);
    directory = next;
    valid = directory >= 0;
  }
  struct stat pathAfter = {};
  valid = valid && directory >= 0 &&
          fstatat(directory, filename.fileSystemRepresentation, &pathAfter,
                  AT_SYMLINK_NOFOLLOW) == 0 &&
          DSHServiceSameStat(after, pathAfter);
  if (directory >= 0) close(directory);
  if (!valid) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return nil;
  }
  DSHProjectContextContentDecision *content =
      [self.policy decisionForContentData:data];
  if (!content.eligible) return @{
    @"reason" : content.omissionReason,
    @"metadata" : DSHServiceStatDescriptor(after),
    @"observation_sha256" : DSHServiceSHA256(data),
  };
  DSHProjectContextSecretDecision *secret =
      [self.policy secretDecisionForData:data];
  if (secret.suspectedSecret) return @{
    @"reason" : secret.omissionReason,
    @"metadata" : DSHServiceStatDescriptor(after),
    @"observation_sha256" : DSHServiceSHA256(data),
  };
  return @{
    @"data" : data,
    @"sha256" : DSHServiceSHA256(data),
    @"metadata" : DSHServiceStatDescriptor(after),
  };
}

- (NSDictionary *)validatedBlob:(git_blob *)blob {
  if (blob == nullptr) return @{@"data" : NSData.data};
  git_object_size_t size = git_blob_rawsize(blob);
  if (size < 0 || size > DSHProjectContextMaxFileBytes) {
    return @{@"reason" : DSHProjectContextOmissionReasonBudgetExceeded};
  }
  NSData *data = [NSData dataWithBytes:git_blob_rawcontent(blob)
                                length:(NSUInteger)size];
  DSHProjectContextContentDecision *content =
      [self.policy decisionForContentData:data];
  if (!content.eligible) return @{@"reason" : content.omissionReason};
  DSHProjectContextSecretDecision *secret =
      [self.policy secretDecisionForData:data];
  return secret.suspectedSecret ? @{@"reason" : secret.omissionReason}
                                : @{@"data" : data};
}

static int DSHAppendSerializedPatchLine(__unused const git_diff_delta *delta,
                                        __unused const git_diff_hunk *hunk,
                                        const git_diff_line *line,
                                        void *payload) {
  if (line == nullptr || payload == nullptr ||
      (line->content_len > 0 && line->content == nullptr)) {
    return -1;
  }
  NSMutableData *expected = (__bridge NSMutableData *)payload;
  if (line->origin == GIT_DIFF_LINE_CONTEXT ||
      line->origin == GIT_DIFF_LINE_ADDITION ||
      line->origin == GIT_DIFF_LINE_DELETION) {
    [expected appendBytes:&line->origin length:1];
  }
  if (line->content_len > 0) {
    [expected appendBytes:line->content length:line->content_len];
  }
  return 0;
}

- (NSData *)serializedPatch:(git_patch *)patch {
  if (patch == nullptr) return nil;
  // git_patch_size intentionally omits some extended file-header bytes even
  // when include_file_headers is set. Build an independent complete expected
  // serialization through the checked print callback, then require the buffer
  // API to match it byte-for-byte.
  size_t accountedSize = git_patch_size(patch, 1, 1, 1);
  NSMutableData *expected = [NSMutableData data];
  int printResult = git_patch_print(
      patch, DSHAppendSerializedPatchLine, (__bridge void *)expected);
  git_buf buffer = GIT_BUF_INIT;
  int result = git_patch_to_buf(&buffer, patch);
  NSData *data = result == 0 && buffer.ptr != nullptr
                     ? [NSData dataWithBytes:buffer.ptr length:buffer.size]
                     : nil;
  git_buf_dispose(&buffer);
  if (printResult != 0 || result != 0 || accountedSize == 0 ||
      expected.length == 0 || data.length != expected.length ||
      accountedSize > expected.length || ![data isEqualToData:expected]) {
    return nil;
  }
  // The per-file content and secret gates already validated both complete
  // sides. A complete patch has its own 128 KiB budget and may legitimately
  // exceed the 64 KiB single-file gate, so validate encoding/framing here
  // without reapplying the smaller file limit.
  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  for (NSUInteger index = 0; index < data.length; index++) {
    uint8_t byte = bytes[index];
    if (byte == 0 || (byte < 0x20 && byte != '\n' && byte != '\r' &&
                      byte != '\t')) {
      return nil;
    }
  }
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
             .length > 0
             ? data
             : nil;
}

- (void)addOmissionPath:(NSString *)path
                  reason:(NSString *)reason
                 omitted:(NSMutableArray<NSDictionary *> *)omitted {
  for (NSDictionary *existing in omitted) {
    if ([existing[@"path"] isEqual:path] &&
        [existing[@"reason"] isEqual:reason]) {
      return;
    }
  }
  [omitted addObject:@{
    @"path" : path,
    @"reason" : reason ?: DSHProjectContextOmissionReasonPolicy,
  }];
}

- (NSDictionary *)captureLease:(DSHLocalProjectLease *)lease
                  selectedPaths:(NSArray<NSString *> *)selectedPaths
                   includeBlocks:(BOOL)includeBlocks
                          start:(NSDate *)start
                          error:(NSError **)error {
  git_repository *repository = lease.repository;
  __block git_index *index = nullptr;
  __block git_tree *headTree = nullptr;
  __block git_reference *head = nullptr;
  __block git_diff *stagedDiff = nullptr;
  __block git_diff *worktreeDiff = nullptr;
  @try {
    int result = git_repository_index(&index, repository);
    if (result == 0) result = git_index_read(index, 1);
    if (result < 0 || index == nullptr) {
      DSHSetServiceError(error,
                         DSHProjectContextServiceErrorProjectUnavailable);
      return nil;
    }
    size_t rawEntryCount = git_index_entrycount(index);
    if (rawEntryCount > DSHProjectContextMaxEntries) {
      DSHSetServiceError(error,
                         DSHProjectContextServiceErrorBudgetExceeded);
      return nil;
    }

    NSString *branch = nil;
    NSString *headOid = nil;
    NSString *headTarget = nil;
    int headResult = git_repository_head(&head, repository);
    if (headResult == 0 && head != nullptr) {
      headOid = DSHServiceOid(git_reference_target(head));
      if (git_reference_is_branch(head)) {
        const char *name = git_reference_shorthand(head);
        branch = name == nullptr ? nil : [NSString stringWithUTF8String:name];
      }
      git_commit *commit = nullptr;
      int commitResult = git_commit_lookup(&commit, repository,
                                           git_reference_target(head));
      int treeResult = commitResult == 0
          ? git_commit_tree(&headTree, commit)
          : commitResult;
      if (commit != nullptr) git_commit_free(commit);
      if (commitResult != 0 || treeResult != 0 || headTree == nullptr) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
    } else if (headResult == GIT_EUNBORNBRANCH ||
               headResult == GIT_ENOTFOUND) {
      git_reference *symbolic = nullptr;
      if (git_reference_lookup(&symbolic, repository, "HEAD") == 0 &&
          symbolic != nullptr) {
        const char *target = git_reference_symbolic_target(symbolic);
        headTarget =
            target == nullptr ? nil : [NSString stringWithUTF8String:target];
        if ([headTarget hasPrefix:@"refs/heads/"]) {
          branch = [headTarget substringFromIndex:11];
        }
        git_reference_free(symbolic);
      }
    } else {
      DSHSetServiceError(error,
                         DSHProjectContextServiceErrorProjectUnavailable);
      return nil;
    }

    NSMutableDictionary<NSString *, NSMutableDictionary *> *candidateByPath =
        [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSString *> *rawByNormalized =
        [NSMutableDictionary dictionary];
    NSMutableArray<NSDictionary *> *indexRows = [NSMutableArray array];
    NSMutableSet<NSString *> *conflictPaths = [NSMutableSet set];
    for (size_t item = 0; item < rawEntryCount; item++) {
      const git_index_entry *entry = git_index_get_byindex(index, item);
      NSString *rawPath = entry == nullptr || entry->path == nullptr
                              ? nil
                              : [NSString stringWithUTF8String:entry->path];
      if (rawPath == nil) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
      DSHProjectContextPathDecision *pathDecision =
          [self.policy decisionForRelativePath:rawPath];
      NSString *path = pathDecision.normalizedPath;
      NSString *existingRaw = rawByNormalized[path];
      if (path.length == 0 || ![path isEqualToString:rawPath] ||
          (existingRaw != nil && ![existingRaw isEqualToString:rawPath])) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
      rawByNormalized[path] = rawPath;
      NSUInteger stage = git_index_entry_stage(entry);
      [indexRows addObject:@{
        @"path" : path,
        @"stage" : @(stage),
        @"mode" : @(entry->mode),
        @"size" : @(entry->file_size),
        @"oid" : DSHServiceOid(&entry->id) ?: @"",
      }];
      if (stage != 0) {
        [conflictPaths addObject:path];
        continue;
      }
      BOOL regularMode = entry->mode == GIT_FILEMODE_BLOB ||
                         entry->mode == GIT_FILEMODE_BLOB_EXECUTABLE;
      BOOL eligible = pathDecision.eligible && regularMode &&
                      entry->file_size <= DSHProjectContextMaxFileBytes;
      NSString *reason = pathDecision.omissionReason;
      if (pathDecision.eligible && !regularMode) {
        reason = DSHProjectContextOmissionReasonPolicy;
      } else if (pathDecision.eligible && regularMode &&
                 entry->file_size > DSHProjectContextMaxFileBytes) {
        reason = DSHProjectContextOmissionReasonBudgetExceeded;
      }
      candidateByPath[path] = [@{
        @"path" : path,
        @"size" : @(entry->file_size),
        @"revision" : DSHServiceOid(&entry->id) ?: @"",
        @"git_state" : @"unchanged",
        @"eligible" : @(eligible),
        @"omission_reason" :
            eligible ? NSNull.null
                     : (reason ?: DSHProjectContextOmissionReasonPolicy),
        @"staged" : @NO,
        @"unstaged" : @NO,
        @"conflicted" : @NO,
      } mutableCopy];
    }
    [indexRows sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                       NSDictionary *right) {
      NSComparisonResult pathResult = [left[@"path"] compare:right[@"path"]];
      return pathResult == NSOrderedSame
                 ? [left[@"stage"] compare:right[@"stage"]]
                 : pathResult;
    }];

    git_diff_options diffOptions = GIT_DIFF_OPTIONS_INIT;
    diffOptions.flags = GIT_DIFF_INCLUDE_TYPECHANGE |
                        GIT_DIFF_INCLUDE_TYPECHANGE_TREES |
                        GIT_DIFF_IGNORE_SUBMODULES |
                        GIT_DIFF_DISABLE_PATHSPEC_MATCH;
    diffOptions.context_lines = 3;
    diffOptions.interhunk_lines = 0;
    diffOptions.id_abbrev = GIT_OID_SHA1_HEXSIZE;
    diffOptions.max_size = DSHProjectContextMaxFileBytes + 1;
    diffOptions.old_prefix = "a";
    diffOptions.new_prefix = "b";
    result = git_diff_tree_to_index(&stagedDiff, repository, headTree, index,
                                    &diffOptions);
    if (result == 0) {
      result = git_diff_index_to_workdir(&worktreeDiff, repository, index,
                                         &diffOptions);
    }
    if (result < 0 || stagedDiff == nullptr || worktreeDiff == nullptr) {
      DSHSetServiceError(error,
                         DSHProjectContextServiceErrorProjectUnavailable);
      return nil;
    }
    git_diff_find_options findOptions = GIT_DIFF_FIND_OPTIONS_INIT;
    findOptions.flags = GIT_DIFF_FIND_RENAMES;
    findOptions.rename_limit = DSHProjectContextMaxChangedPaths;
    if (git_diff_find_similar(stagedDiff, &findOptions) != 0 ||
        git_diff_find_similar(worktreeDiff, &findOptions) != 0) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
      return nil;
    }

    NSMutableArray<NSDictionary *> *statusRows = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *disclosedStatusRows = [NSMutableArray array];
    NSMutableSet<NSString *> *changedPaths = [NSMutableSet set];
    for (NSUInteger kind = 0; kind < 2; kind++) {
      git_diff *diff = kind == 0 ? stagedDiff : worktreeDiff;
      size_t count = git_diff_num_deltas(diff);
      for (size_t item = 0; item < count; item++) {
        const git_diff_delta *delta = git_diff_get_delta(diff, item);
        NSString *oldPath = DSHServiceDeltaPath(delta, NO);
        NSString *newPath = DSHServiceDeltaPath(delta, YES);
        NSArray *rawPaths = @[ oldPath ?: @"", newPath ?: @"" ];
        for (NSString *raw in rawPaths) {
          if (raw.length == 0) continue;
          DSHProjectContextPathDecision *decision =
              [self.policy decisionForRelativePath:raw];
          if (decision.normalizedPath.length == 0 ||
              ![decision.normalizedPath isEqualToString:raw]) {
            DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
            return nil;
          }
          [changedPaths addObject:raw];
          NSMutableDictionary *candidate = candidateByPath[raw];
          if (candidate != nil) {
            candidate[kind == 0 ? @"staged" : @"unstaged"] = @YES;
          }
        }
        NSDictionary *statusRow = @{
          @"kind" : kind == 0 ? @"staged" : @"worktree",
          @"status" :
              @(delta == nullptr ? GIT_DELTA_UNMODIFIED : delta->status),
          @"old_path" : oldPath ?: @"",
          @"new_path" : newPath ?: @"",
          @"old_mode" : @(delta == nullptr ? 0 : delta->old_file.mode),
          @"new_mode" : @(delta == nullptr ? 0 : delta->new_file.mode),
          @"old_oid" :
              delta == nullptr ? @"" : (DSHServiceOid(&delta->old_file.id) ?: @""),
          @"new_oid" :
              delta == nullptr ? @"" : (DSHServiceOid(&delta->new_file.id) ?: @""),
        };
        [statusRows addObject:statusRow];
        DSHProjectContextPathDecision *oldDisclosure = oldPath.length == 0
            ? nil : [self.policy decisionForRelativePath:oldPath];
        DSHProjectContextPathDecision *newDisclosure = newPath.length == 0
            ? nil : [self.policy decisionForRelativePath:newPath];
        [disclosedStatusRows addObject:@{
          @"kind" : statusRow[@"kind"],
          @"status" : statusRow[@"status"],
          @"old_path" : oldDisclosure.eligible ? oldDisclosure.normalizedPath
                                                : NSNull.null,
          @"new_path" : newDisclosure.eligible ? newDisclosure.normalizedPath
                                                : NSNull.null,
          @"old_restricted" : @(oldDisclosure != nil && !oldDisclosure.eligible),
          @"new_restricted" : @(newDisclosure != nil && !newDisclosure.eligible),
        }];
      }
    }
    for (NSString *path in conflictPaths) {
      [changedPaths addObject:path];
      NSMutableDictionary *candidate = candidateByPath[path];
      if (candidate == nil) {
        NSMutableArray *conflictRows = [NSMutableArray array];
        for (NSDictionary *row in indexRows) {
          if ([row[@"path"] isEqual:path]) [conflictRows addObject:row];
        }
        candidate = [@{
          @"path" : path,
          @"size" : @0,
          @"revision" :
              DSHServiceSHA256(DSHCanonicalJSON(conflictRows) ?: NSData.data),
          @"git_state" : @"conflicted",
          @"eligible" : @NO,
          @"omission_reason" : DSHProjectContextOmissionReasonPolicy,
          @"staged" : @NO,
          @"unstaged" : @NO,
          @"conflicted" : @YES,
        } mutableCopy];
        candidateByPath[path] = candidate;
      } else {
        candidate[@"conflicted"] = @YES;
        candidate[@"eligible"] = @NO;
        candidate[@"omission_reason"] =
            DSHProjectContextOmissionReasonPolicy;
      }
    }
    if (changedPaths.count > DSHProjectContextMaxChangedPaths) {
      DSHSetServiceError(error,
                         DSHProjectContextServiceErrorBudgetExceeded);
      return nil;
    }
    [statusRows sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                        NSDictionary *right) {
      NSString *leftText = [[NSString alloc]
          initWithData:DSHCanonicalJSON(left)
              encoding:NSUTF8StringEncoding];
      NSString *rightText = [[NSString alloc]
          initWithData:DSHCanonicalJSON(right)
              encoding:NSUTF8StringEncoding];
      return [leftText compare:rightText];
    }];
    [disclosedStatusRows sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                                 NSDictionary *right) {
      NSString *leftText = [[NSString alloc]
          initWithData:DSHCanonicalJSON(left) encoding:NSUTF8StringEncoding];
      NSString *rightText = [[NSString alloc]
          initWithData:DSHCanonicalJSON(right) encoding:NSUTF8StringEncoding];
      return [leftText compare:rightText];
    }];

    NSMutableArray<NSDictionary *> *candidates = [NSMutableArray array];
    NSArray<NSString *> *candidatePaths =
        [candidateByPath.allKeys sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *path in candidatePaths) {
      NSMutableDictionary *candidate = candidateByPath[path];
      candidate[@"git_state"] = DSHServiceGitState(
          [candidate[@"staged"] boolValue],
          [candidate[@"unstaged"] boolValue],
          [candidate[@"conflicted"] boolValue]);
      [candidate removeObjectsForKeys:
                     @[@"staged", @"unstaged", @"conflicted"]];
      [candidates addObject:candidate];
    }

    NSMutableOrderedSet<NSString *> *effectiveSelection =
        [NSMutableOrderedSet orderedSet];
    for (NSString *selectionPath in selectedPaths) {
      if (candidateByPath[selectionPath] != nil) {
        [effectiveSelection addObject:selectionPath];
        continue;
      }
      NSString *prefix = [selectionPath stringByAppendingString:@"/"];
      BOOL expanded = NO;
      for (NSString *candidatePath in candidatePaths) {
        if ([candidatePath hasPrefix:prefix]) {
          [effectiveSelection addObject:candidatePath];
          expanded = YES;
        }
      }
      if (!expanded) [effectiveSelection addObject:selectionPath];
    }
    NSArray<NSString *> *effectiveSelectedPaths =
        [effectiveSelection.array sortedArrayUsingSelector:@selector(compare:)];

    NSMutableArray<NSDictionary *> *blocks = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *omitted = [NSMutableArray array];
    NSMutableDictionary<NSString *, NSDictionary *> *safeFiles =
        [NSMutableDictionary dictionary];
    NSMutableArray<NSDictionary *> *selectedStates = [NSMutableArray array];
    for (NSString *path in effectiveSelectedPaths) {
      NSDictionary *candidate = candidateByPath[path];
      if (candidate == nil) {
        [self addOmissionPath:path
                       reason:DSHProjectContextOmissionReasonNotTracked
                      omitted:omitted];
        [selectedStates addObject:@{@"path" : path, @"state" : @"not_tracked"}];
        continue;
      }
      NSString *revision = candidate[@"revision"];
      if (revision.length == GIT_OID_SHA1_HEXSIZE) {
        git_oid oid = {};
        git_blob *selectedBlob = nullptr;
        int oidResult = git_oid_fromstr(&oid, revision.UTF8String);
        int blobResult = oidResult == 0
            ? git_blob_lookup(&selectedBlob, repository, &oid)
            : oidResult;
        if (selectedBlob != nullptr) git_blob_free(selectedBlob);
        if (oidResult != 0 || blobResult != 0) {
          DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
          return nil;
        }
      }
      if (![candidate[@"eligible"] boolValue]) {
        NSString *reason = candidate[@"omission_reason"] == NSNull.null
                               ? DSHProjectContextOmissionReasonPolicy
                               : candidate[@"omission_reason"];
        [self addOmissionPath:path reason:reason omitted:omitted];
        [selectedStates addObject:@{
          @"path" : path,
          @"state" : @"omitted",
          @"reason" : reason,
          @"revision" : candidate[@"revision"],
        }];
        continue;
      }
      if (safeFiles.count >= DSHProjectContextMaxFiles) {
        [self addOmissionPath:path
                       reason:DSHProjectContextOmissionReasonBudgetExceeded
                      omitted:omitted];
        [selectedStates addObject:@{
          @"path" : path,
          @"state" : @"omitted",
          @"reason" : DSHProjectContextOmissionReasonBudgetExceeded,
          @"revision" : candidate[@"revision"],
        }];
        continue;
      }
      NSDictionary *safe = [self safeReadPath:path lease:lease error:error];
      if (safe == nil) return nil;
      if (safe[@"data"] == nil) {
        NSString *reason =
            safe[@"reason"] ?: DSHProjectContextOmissionReasonPolicy;
        [self addOmissionPath:path reason:reason omitted:omitted];
        NSMutableDictionary *state = [@{
          @"path" : path,
          @"state" : @"omitted",
          @"reason" : reason,
          @"revision" : candidate[@"revision"],
        } mutableCopy];
        if (safe[@"metadata"] != nil) state[@"metadata"] = safe[@"metadata"];
        if (safe[@"observation_sha256"] != nil) {
          state[@"observation_sha256"] = safe[@"observation_sha256"];
        }
        [selectedStates addObject:state];
        continue;
      }
      safeFiles[path] = safe;
      [selectedStates addObject:@{
        @"path" : path,
        @"state" : @"included",
        @"revision" : candidate[@"revision"],
        @"content_sha256" : safe[@"sha256"],
        @"metadata" : safe[@"metadata"],
      }];
      if (includeBlocks) {
        [blocks addObject:@{
          @"path" : path,
          @"source" : @"tracked_file",
          @"data" : safe[@"data"],
        }];
      }
    }
    if (![self deadlineFrom:start error:error]) return nil;

    if (includeBlocks) {
      for (NSUInteger kind = 0; kind < 2; kind++) {
        git_diff *diff = kind == 0 ? stagedDiff : worktreeDiff;
        size_t count = git_diff_num_deltas(diff);
        for (size_t item = 0; item < count; item++) {
          const git_diff_delta *delta = git_diff_get_delta(diff, item);
          NSString *oldPath = DSHServiceDeltaPath(delta, NO);
          NSString *newPath = DSHServiceDeltaPath(delta, YES);
          NSString *selectedPath = [effectiveSelectedPaths containsObject:newPath]
                                       ? newPath
                                       : ([effectiveSelectedPaths containsObject:oldPath]
                                              ? oldPath
                                              : nil);
          if (selectedPath == nil ||
              [conflictPaths containsObject:selectedPath]) {
            continue;
          }
          // A patch is disclosure too. If the selected worktree path did not
          // pass the descriptor-bound file read, no index/blob side may be
          // used as a fallback source of content.
          if (safeFiles[selectedPath] == nil) continue;
          DSHProjectContextPathDecision *oldDecision = oldPath.length == 0
              ? nil
              : [self.policy decisionForRelativePath:oldPath];
          DSHProjectContextPathDecision *newDecision = newPath.length == 0
              ? nil
              : [self.policy decisionForRelativePath:newPath];
          if ((oldDecision != nil && !oldDecision.eligible) ||
              (newDecision != nil && !newDecision.eligible)) {
            NSString *reason = oldDecision != nil && !oldDecision.eligible
                                   ? oldDecision.omissionReason
                                   : newDecision.omissionReason;
            [self addOmissionPath:selectedPath
                           reason:reason ?: DSHProjectContextOmissionReasonPolicy
                          omitted:omitted];
            continue;
          }
          git_blob *oldBlob = nullptr;
          git_blob *newBlob = nullptr;
          if (delta != nullptr && !git_oid_is_zero(&delta->old_file.id)) {
            if (git_blob_lookup(&oldBlob, repository, &delta->old_file.id) != 0 ||
                oldBlob == nullptr) {
              DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
              return nil;
            }
          }
          if (kind == 0 && delta != nullptr &&
              !git_oid_is_zero(&delta->new_file.id)) {
            if (git_blob_lookup(&newBlob, repository, &delta->new_file.id) != 0 ||
                newBlob == nullptr) {
              if (oldBlob != nullptr) git_blob_free(oldBlob);
              DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
              return nil;
            }
          }
          NSDictionary *oldValidation = [self validatedBlob:oldBlob];
          NSDictionary *newValidation = kind == 0
                                            ? [self validatedBlob:newBlob]
                                            : safeFiles[selectedPath];
          NSString *reason =
              oldValidation[@"reason"] ?: newValidation[@"reason"];
          BOOL deletion = delta != nullptr && delta->status == GIT_DELTA_DELETED;
          if (reason != nil ||
              (kind == 1 && newValidation == nil && !deletion)) {
            [self addOmissionPath:selectedPath
                           reason:reason ?: DSHProjectContextOmissionReasonPolicy
                          omitted:omitted];
            if (newBlob != nullptr) git_blob_free(newBlob);
            if (oldBlob != nullptr) git_blob_free(oldBlob);
            continue;
          }
          git_diff_options patchOptions = diffOptions;
          patchOptions.flags |= GIT_DIFF_FORCE_TEXT;
          git_patch *patch = nullptr;
          int patchResult = 0;
          if (kind == 0) {
            patchResult = git_patch_from_blobs(
                &patch, oldBlob, oldPath.UTF8String, newBlob,
                newPath.UTF8String, &patchOptions);
          } else {
            NSData *newData = newValidation[@"data"] ?: NSData.data;
            patchResult = git_patch_from_blob_and_buffer(
                &patch, oldBlob, oldPath.UTF8String, newData.bytes,
                newData.length, newPath.UTF8String, &patchOptions);
          }
          NSData *patchData =
              patchResult == 0 ? [self serializedPatch:patch] : nil;
          if (patch != nullptr) git_patch_free(patch);
          if (newBlob != nullptr) git_blob_free(newBlob);
          if (oldBlob != nullptr) git_blob_free(oldBlob);
          if (patchResult != 0 || patchData == nil) {
            DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
            return nil;
          }
          [blocks addObject:@{
            @"path" : selectedPath,
            @"source" : kind == 0 ? @"staged_diff" : @"worktree_diff",
            @"data" : patchData,
          }];
        }
      }
    }

    NSString *indexChecksum =
        DSHServiceOid(git_index_checksum(index)) ?: @"none";
    NSString *projectMetadataDigest =
        [self.projectAccess projectMetadataDigestFromLease:lease error:nil];
    if (projectMetadataDigest == nil) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
      return nil;
    }
    NSData *indexDigestData = DSHCanonicalJSON(indexRows) ?: NSData.data;
    NSData *statusDigestData = DSHCanonicalJSON(statusRows) ?: NSData.data;
    NSDictionary *fingerprintInput = @{
      @"policy_version" : DSHProjectContextPolicyVersion,
      @"project_id" : lease.projectId,
      @"projects_root_device" : @((unsigned long long)lease.projectsRootDevice),
      @"projects_root_inode" : @((unsigned long long)lease.projectsRootInode),
      @"project_device" : @((unsigned long long)lease.projectDevice),
      @"project_inode" : @((unsigned long long)lease.projectInode),
      @"repository_device" : @((unsigned long long)lease.repositoryDevice),
      @"repository_inode" : @((unsigned long long)lease.repositoryInode),
      @"git_device" : @((unsigned long long)lease.gitDevice),
      @"git_inode" : @((unsigned long long)lease.gitInode),
      @"objects_device" : @((unsigned long long)lease.objectsDevice),
      @"objects_inode" : @((unsigned long long)lease.objectsInode),
      @"project_metadata_sha256" : projectMetadataDigest,
      @"repository_state" : @(git_repository_state(repository)),
      @"branch" : branch ?: NSNull.null,
      @"head_oid" : headOid ?: NSNull.null,
      @"head_target" : headTarget ?: NSNull.null,
      @"index_checksum" : indexChecksum,
      @"index_digest" : DSHServiceSHA256(indexDigestData),
      @"status_digest" : DSHServiceSHA256(statusDigestData),
      @"selection_intent" : selectedPaths,
      @"selected_paths" : effectiveSelectedPaths,
      @"selected_states" : selectedStates,
    };
    NSString *fingerprint =
        DSHServiceSHA256(DSHCanonicalJSON(fingerprintInput) ?: NSData.data);
    return @{
      @"branch" : branch ?: NSNull.null,
      @"head_oid" : headOid ?: NSNull.null,
      @"clean" : @(changedPaths.count == 0),
      @"conflicted" : @(conflictPaths.count > 0 ||
                         git_repository_state(repository) !=
                             GIT_REPOSITORY_STATE_NONE),
      @"source_fingerprint" : fingerprint,
      @"candidates" : candidates,
      @"blocks" : blocks,
      @"omitted" : omitted,
      @"tracked_status" : disclosedStatusRows,
      @"expanded_paths" : effectiveSelectedPaths,
      @"fingerprint_input" : fingerprintInput,
      @"project_metadata_sha256" : projectMetadataDigest,
    };
  } @finally {
    if (worktreeDiff != nullptr) git_diff_free(worktreeDiff);
    if (stagedDiff != nullptr) git_diff_free(stagedDiff);
    if (head != nullptr) git_reference_free(head);
    if (headTree != nullptr) git_tree_free(headTree);
    if (index != nullptr) git_index_free(index);
  }
}

- (NSDictionary *)captureAndVerifyLease:(DSHLocalProjectLease *)lease
                           selectedPaths:(NSArray<NSString *> *)selectedPaths
                           includeBlocks:(BOOL)includeBlocks
                                   start:(NSDate *)start
                                   error:(NSError **)error {
  if (![self.projectAccess validateLeaseIdentity:lease error:nil]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return nil;
  }
  NSDictionary *capture = [self captureLease:lease
                                selectedPaths:selectedPaths
                                includeBlocks:includeBlocks
                                        start:start
                                        error:error];
  if (capture == nil) return nil;
  if (self.hook != nil) self.hook(@"before_fingerprint_recheck", nil);
  if (![self.projectAccess validateLeaseIdentity:lease error:nil]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return nil;
  }
  NSDictionary *verification = [self captureLease:lease
                                     selectedPaths:selectedPaths
                                     includeBlocks:NO
                                             start:start
                                             error:error];
  if (verification == nil) return nil;
  if (![self.projectAccess validateLeaseIdentity:lease error:nil]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return nil;
  }
  if (![capture[@"source_fingerprint"]
          isEqualToString:verification[@"source_fingerprint"]]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return nil;
  }
  return capture;
}

- (NSDictionary *)metadataObservationForPath:(NSString *)relativePath
                                         lease:(DSHLocalProjectLease *)lease {
  NSArray<NSString *> *components = [relativePath componentsSeparatedByString:@"/"];
  int directory = dup(lease.repositoryDescriptor);
  if (directory < 0) return nil;
  for (NSUInteger index = 0; index + 1 < components.count; index++) {
    struct stat before = {};
    NSString *component = components[index];
    if (fstatat(directory, component.fileSystemRepresentation, &before,
                AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(before.st_mode) ||
        before.st_dev != lease.repositoryDevice) {
      close(directory);
      return @{
        @"exists" : @NO,
        @"safe_regular" : @NO,
        @"size" : @0,
        @"observation_sha256" : DSHServiceSHA256(DSHCanonicalJSON(@{
          @"state" : @"unsafe_ancestor", @"component_index" : @(index),
        }) ?: NSData.data),
      };
    }
    int next = openat(directory, component.fileSystemRepresentation,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened = {};
    BOOL valid = next >= 0 && fstat(next, &opened) == 0 &&
                 DSHServiceSameStat(before, opened);
    close(directory);
    if (!valid) {
      if (next >= 0) close(next);
      return nil;
    }
    directory = next;
  }
  struct stat metadata = {};
  BOOL exists = fstatat(directory,
                        components.lastObject.fileSystemRepresentation,
                        &metadata, AT_SYMLINK_NOFOLLOW) == 0;
  close(directory);
  if (!exists) {
    return @{
      @"exists" : @NO,
      @"safe_regular" : @NO,
      @"size" : @0,
      @"observation_sha256" : DSHServiceSHA256(
          DSHCanonicalJSON(@{@"state" : @"missing"}) ?: NSData.data),
    };
  }
  NSDictionary *observation = DSHServiceObservation(metadata);
  return @{
    @"exists" : @YES,
    @"safe_regular" : @(S_ISREG(metadata.st_mode) && metadata.st_nlink == 1 &&
                           metadata.st_dev == lease.repositoryDevice),
    @"size" : metadata.st_size < 0 ? @0 : @((unsigned long long)metadata.st_size),
    @"mode" : @((unsigned long long)metadata.st_mode),
    @"metadata" : observation[@"metadata"],
    @"observation_sha256" : observation[@"observation_sha256"],
  };
}

- (NSDictionary *)metadataCandidateCaptureLease:(DSHLocalProjectLease *)lease
                                            start:(NSDate *)start
                                            error:(NSError **)error {
  if (![self.projectAccess validateLeaseIdentity:lease error:nil]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return nil;
  }
  git_index *index = nullptr;
  git_reference *head = nullptr;
  git_tree *headTree = nullptr;
  @try {
    if (git_repository_index(&index, lease.repository) != 0 || index == nullptr ||
        git_index_read(index, 1) != 0) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorProjectUnavailable);
      return nil;
    }
    size_t count = git_index_entrycount(index);
    if (count > DSHProjectContextMaxEntries) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorBudgetExceeded);
      return nil;
    }
    NSString *headOid = nil;
    NSString *branch = nil;
    NSString *headTarget = nil;
    int detachedResult = git_repository_head_detached(lease.repository);
    if (detachedResult < 0) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorProjectUnavailable);
      return nil;
    }
    int headResult = git_repository_head(&head, lease.repository);
    if (headResult == 0 && head != nullptr) {
      headOid = DSHServiceOid(git_reference_target(head));
      if (git_reference_is_branch(head)) {
        const char *name = git_reference_shorthand(head);
        branch = name == nullptr ? nil : [NSString stringWithUTF8String:name];
      }
      git_commit *commit = nullptr;
      int commitResult = git_commit_lookup(&commit, lease.repository,
                                           git_reference_target(head));
      int treeResult = commitResult == 0 ? git_commit_tree(&headTree, commit)
                                         : commitResult;
      if (commit != nullptr) git_commit_free(commit);
      if (commitResult != 0 || treeResult != 0 || headTree == nullptr) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
    } else if (headResult != GIT_EUNBORNBRANCH &&
               headResult != GIT_ENOTFOUND) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorProjectUnavailable);
      return nil;
    }
    git_reference *symbolicHead = nullptr;
    int symbolicResult = git_reference_lookup(&symbolicHead, lease.repository,
                                              "HEAD");
    if (symbolicResult == 0 && symbolicHead != nullptr) {
      const char *target = git_reference_symbolic_target(symbolicHead);
      headTarget = target == nullptr ? nil : [NSString stringWithUTF8String:target];
      git_reference_free(symbolicHead);
    } else if (symbolicResult != GIT_ENOTFOUND) {
      if (symbolicHead != nullptr) git_reference_free(symbolicHead);
      DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
      return nil;
    }

    NSMutableDictionary<NSString *, NSMutableArray<NSDictionary *> *> *rowsByPath =
        [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSValue *> *stageZeroEntries =
        [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSString *> *rawByNormalized =
        [NSMutableDictionary dictionary];
    for (size_t item = 0; item < count; item++) {
      const git_index_entry *entry = git_index_get_byindex(index, item);
      if (entry == nullptr || entry->path == nullptr) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
      NSString *rawPath = [NSString stringWithUTF8String:entry->path];
      if (rawPath == nil) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
      DSHProjectContextPathDecision *decision =
          [self.policy decisionForRelativePath:rawPath];
      NSString *path = decision.normalizedPath;
      if (path.length == 0 || ![rawPath isEqual:path]) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
      NSString *existing = rawByNormalized[path];
      if (existing != nil && ![existing isEqual:rawPath]) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
        return nil;
      }
      rawByNormalized[path] = rawPath;
      NSUInteger stage = git_index_entry_stage(entry);
      NSMutableArray *rows = rowsByPath[path] ?: [NSMutableArray array];
      rowsByPath[path] = rows;
      [rows addObject:@{
        @"stage" : @(stage), @"mode" : @(entry->mode),
        @"size" : @(entry->file_size),
        @"oid" : DSHServiceOid(&entry->id) ?: @"",
      }];
      if (stage == 0) {
        stageZeroEntries[path] = [NSValue valueWithPointer:entry];
      }
    }

    NSMutableArray<NSDictionary *> *candidates = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *fingerprintRows = [NSMutableArray array];
    NSArray<NSString *> *paths =
        [rowsByPath.allKeys sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *path in paths) {
      NSArray<NSDictionary *> *rows = rowsByPath[path];
      const git_index_entry *entry =
          (const git_index_entry *)stageZeroEntries[path].pointerValue;
      if (entry == nullptr) {
        [candidates addObject:@{
          @"path" : path, @"size" : @0,
          @"revision" : DSHServiceSHA256(DSHCanonicalJSON(rows) ?: NSData.data),
          @"git_state" : @"conflicted", @"eligible" : @NO,
          @"omission_reason" : DSHProjectContextOmissionReasonPolicy,
        }];
        [fingerprintRows addObject:@{@"path" : path, @"index" : rows,
                                     @"live" : @"conflicted"}];
        continue;
      }
      NSDictionary *live = [self metadataObservationForPath:path lease:lease];
      if (live == nil) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
        return nil;
      }
      DSHProjectContextPathDecision *decision =
          [self.policy decisionForRelativePath:path];
      BOOL indexRegular = entry->mode == GIT_FILEMODE_BLOB ||
                          entry->mode == GIT_FILEMODE_BLOB_EXECUTABLE;
      BOOL liveRegular = [live[@"safe_regular"] boolValue];
      unsigned long long liveSize = [live[@"size"] unsignedLongLongValue];
      BOOL eligible = decision.eligible && indexRegular && liveRegular &&
                      liveSize <= DSHProjectContextMaxFileBytes;
      NSString *reason = decision.omissionReason;
      if (decision.eligible && (!indexRegular || !liveRegular)) {
        reason = DSHProjectContextOmissionReasonPolicy;
      } else if (decision.eligible && indexRegular && liveRegular &&
                 liveSize > DSHProjectContextMaxFileBytes) {
        reason = DSHProjectContextOmissionReasonBudgetExceeded;
      }
      BOOL staged = headTree == nullptr;
      if (headTree != nullptr) {
        git_tree_entry *treeEntry = nullptr;
        int treeEntryResult = git_tree_entry_bypath(&treeEntry, headTree,
                                                    path.UTF8String);
        staged = treeEntryResult == GIT_ENOTFOUND ||
            (treeEntryResult == 0 &&
             (git_oid_cmp(git_tree_entry_id(treeEntry), &entry->id) != 0 ||
              git_tree_entry_filemode(treeEntry) != entry->mode));
        if (treeEntry != nullptr) git_tree_entry_free(treeEntry);
        if (treeEntryResult != 0 && treeEntryResult != GIT_ENOTFOUND) {
          DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
          return nil;
        }
      }
      NSDictionary *metadata = live[@"metadata"];
      uint32_t liveGitMode = ([metadata[@"mode"] unsignedLongLongValue] &
                              (S_IXUSR | S_IXGRP | S_IXOTH)) != 0
          ? GIT_FILEMODE_BLOB_EXECUTABLE : GIT_FILEMODE_BLOB;
      BOOL unstaged = ![live[@"exists"] boolValue] || !liveRegular ||
          entry->file_size != liveSize ||
          entry->mode != liveGitMode ||
          entry->dev != (uint32_t)[metadata[@"device"] unsignedLongLongValue] ||
          entry->ino != (uint32_t)[metadata[@"inode"] unsignedLongLongValue] ||
          entry->mtime.seconds != [metadata[@"mtime_seconds"] intValue] ||
          entry->mtime.nanoseconds != [metadata[@"mtime_nanoseconds"] unsignedIntValue] ||
          entry->ctime.seconds != [metadata[@"ctime_seconds"] intValue] ||
          entry->ctime.nanoseconds != [metadata[@"ctime_nanoseconds"] unsignedIntValue];
      [candidates addObject:@{
        @"path" : path, @"size" : @(liveSize),
        @"revision" : DSHServiceOid(&entry->id) ?: @"",
        @"git_state" : DSHServiceGitState(staged, unstaged, NO),
        @"eligible" : @(eligible),
        @"omission_reason" : eligible ? NSNull.null :
            (reason ?: DSHProjectContextOmissionReasonPolicy),
      }];
      [fingerprintRows addObject:@{
        @"path" : path, @"index" : rows,
        @"live_observation_sha256" : live[@"observation_sha256"],
      }];
    }
    if (![self.projectAccess validateLeaseIdentity:lease error:nil] ||
        ![self deadlineFrom:start error:error]) {
      if (error != nil && *error == nil) {
        DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
      }
      return nil;
    }
    NSDictionary *fingerprintInput = @{
      @"policy_version" : DSHProjectContextPolicyVersion,
      @"project_id" : lease.projectId,
      @"projects_root_device" : @((unsigned long long)lease.projectsRootDevice),
      @"projects_root_inode" : @((unsigned long long)lease.projectsRootInode),
      @"project_device" : @((unsigned long long)lease.projectDevice),
      @"project_inode" : @((unsigned long long)lease.projectInode),
      @"repository_device" : @((unsigned long long)lease.repositoryDevice),
      @"repository_inode" : @((unsigned long long)lease.repositoryInode),
      @"git_device" : @((unsigned long long)lease.gitDevice),
      @"git_inode" : @((unsigned long long)lease.gitInode),
      @"repository_state" : @(git_repository_state(lease.repository)),
      @"branch" : branch ?: NSNull.null,
      @"head_oid" : headOid ?: NSNull.null,
      @"head_target" : headTarget ?: NSNull.null,
      @"head_detached" : @(detachedResult == 1),
      @"index_checksum" : DSHServiceOid(git_index_checksum(index)) ?: @"none",
      @"rows" : fingerprintRows,
    };
    return @{
      @"candidates" : candidates,
      @"source_fingerprint" : DSHServiceSHA256(
          DSHCanonicalJSON(fingerprintInput) ?: NSData.data),
    };
  } @finally {
    if (headTree != nullptr) git_tree_free(headTree);
    if (head != nullptr) git_reference_free(head);
    if (index != nullptr) git_index_free(index);
  }
}

- (NSDictionary *)listCandidatesForProjectId:(NSString *)projectId
                                         query:(NSString *)query
                                        cursor:(NSString *)cursor
                                         error:(NSError **)error {
  NSDate *start = self.clock();
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId] ||
      ![query isKindOfClass:NSString.class] ||
      (cursor != nil && ![cursor isKindOfClass:NSString.class])) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorInvalidArgument);
    return nil;
  }
  NSError *accessError = nil;
  DSHLocalProjectLease *lease = [self.projectAccess
      leaseProjectId:projectId
                mode:DSHLocalProjectAccessModeRead
     includeMetadata:NO
             timeout:DSHProjectContextDeadlineSeconds
               error:&accessError];
  if (lease == nil) {
    DSHSetServiceError(
        error,
        [accessError.domain isEqual:DSHLocalProjectAccessErrorDomain] &&
                accessError.code == DSHLocalProjectAccessErrorLockTimeout
            ? DSHProjectContextServiceErrorTimeout
            : DSHProjectContextServiceErrorProjectUnavailable);
    return nil;
  }
  NSDictionary *capture = [self metadataCandidateCaptureLease:lease
                                                         start:start
                                                         error:error];
  if (capture == nil) return nil;
  NSError *policyError = nil;
  NSDictionary *page = [self.policy
      candidatePageForCandidates:capture[@"candidates"]
                           query:query
               sourceFingerprint:capture[@"source_fingerprint"]
                          cursor:cursor
                           limit:DSHProjectContextMaxCandidatePageSize
                           error:&policyError];
  if (page == nil) {
    DSHProjectContextServiceErrorCode serviceCode =
        DSHProjectContextServiceErrorInvalidArgument;
    if (policyError.code == DSHProjectContextPolicyErrorBudgetExceeded) {
      serviceCode = DSHProjectContextServiceErrorBudgetExceeded;
    } else if (policyError.code == DSHProjectContextPolicyErrorStaleCursor) {
      serviceCode = DSHProjectContextServiceErrorChanged;
    }
    DSHSetServiceError(error, serviceCode);
    return nil;
  }
  return @{
    @"schema_version" : @1,
    @"project_id" : projectId,
    @"candidates" : page[@"candidates"],
    @"next_cursor" : page[@"next_cursor"],
  };
}

- (NSData *)framedEnvelopeMetadata:(NSDictionary *)metadata
                             blocks:(NSArray<NSDictionary *> *)blocks
                           included:(NSMutableArray<NSDictionary *> *)included
                            omitted:(NSMutableArray<NSDictionary *> *)omitted
                              error:(NSError **)error {
  NSData *metadataData = DSHCanonicalJSON(metadata);
  if (metadataData == nil) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
    return nil;
  }
  NSMutableData *envelope = [NSMutableData data];
  [envelope appendData:[@"RISH-PROJECT-CONTEXT/1\n"
                           dataUsingEncoding:NSUTF8StringEncoding]];
  [envelope appendData:[[NSString
      stringWithFormat:@"META %lu\n", (unsigned long)metadataData.length]
                           dataUsingEncoding:NSUTF8StringEncoding]];
  [envelope appendData:metadataData];
  [envelope appendBytes:"\n" length:1];
  NSArray<NSDictionary *> *sorted = [blocks
      sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                     NSDictionary *right) {
        NSComparisonResult pathResult =
            [left[@"path"] compare:right[@"path"]];
        return pathResult == NSOrderedSame
                   ? [left[@"source"] compare:right[@"source"]]
                   : pathResult;
      }];
  NSUInteger diffBytes = 0;
  for (NSDictionary *block in sorted) {
    NSData *data = block[@"data"];
    NSString *path = block[@"path"];
    NSString *source = block[@"source"];
    NSString *digest = DSHServiceSHA256(data);
    NSDictionary *header = @{
      @"path" : path,
      @"source" : source,
      @"sha256" : digest,
      @"length" : @(data.length),
    };
    NSData *headerData = DSHCanonicalJSON(header);
    NSData *prefix = [[NSString
        stringWithFormat:@"BLOCK %lu %lu\n", (unsigned long)headerData.length,
                         (unsigned long)data.length]
        dataUsingEncoding:NSUTF8StringEncoding];
    NSUInteger frameBytes =
        prefix.length + headerData.length + 1 + data.length + 1;
    BOOL diff = ![source isEqual:@"tracked_file"];
    BOOL diffBudget =
        diff && diffBytes + data.length > DSHProjectContextMaxDiffBytes;
    BOOL contextBudget = envelope.length + frameBytes + 4 >
                         DSHProjectContextMaxContextBytes;
    if (diffBudget || contextBudget) {
      [self addOmissionPath:path
                     reason:DSHProjectContextOmissionReasonBudgetExceeded
                    omitted:omitted];
      continue;
    }
    [envelope appendData:prefix];
    [envelope appendData:headerData];
    [envelope appendBytes:"\n" length:1];
    [envelope appendData:data];
    [envelope appendBytes:"\n" length:1];
    if (diff) diffBytes += data.length;
    [included addObject:@{
      @"path" : path,
      @"source" : source,
      @"bytes" : @(data.length),
      @"sha256" : digest,
    }];
  }
  [envelope appendData:[@"END\n" dataUsingEncoding:NSUTF8StringEncoding]];
  if (envelope.length > DSHProjectContextMaxContextBytes) {
    DSHSetServiceError(error,
                       DSHProjectContextServiceErrorBudgetExceeded);
    return nil;
  }
  return envelope;
}

- (NSDictionary *)prepareSelection:(NSDictionary *)selection
                              error:(NSError **)error {
  NSDate *start = self.clock();
  NSDictionary *validated = [self validatedSelection:selection error:error];
  if (validated == nil || self.projectAccess == nil || self.store == nil ||
      self.policy == nil || self.clock == nil ||
      self.identifierGenerator == nil) {
    if (validated != nil) {
      DSHSetServiceError(error,
                         DSHProjectContextServiceErrorInvalidArgument);
    }
    return nil;
  }
  NSError *accessError = nil;
  DSHLocalProjectLease *lease = [self.projectAccess
      leaseProjectId:validated[@"project_id"]
                mode:DSHLocalProjectAccessModeRead
     includeMetadata:YES
             timeout:DSHProjectContextDeadlineSeconds
               error:&accessError];
  if (lease == nil) {
    DSHSetServiceError(
        error,
        [accessError.domain isEqual:DSHLocalProjectAccessErrorDomain] &&
                accessError.code == DSHLocalProjectAccessErrorLockTimeout
            ? DSHProjectContextServiceErrorTimeout
            : DSHProjectContextServiceErrorProjectUnavailable);
    return nil;
  }
  NSDictionary *capture = [self captureAndVerifyLease:lease
                                         selectedPaths:validated[@"selected_paths"]
                                         includeBlocks:YES
                                                 start:start
                                                 error:error];
  if (capture == nil) return nil;
  NSString *snapshotId = self.identifierGenerator();
  if (!DSHServiceCanonicalIdentifier(snapshotId)) {
    DSHSetServiceError(error,
                       DSHProjectContextServiceErrorInvalidArgument);
    return nil;
  }
  NSString *capturedAt = DSHServiceISO8601(self.clock());
  NSDictionary *envelopeMetadata = @{
    @"schema_version" : @1,
    @"snapshot_id" : snapshotId,
    @"project_id" : validated[@"project_id"],
    @"project_name" : lease.metadata[@"name"],
    @"conversation_id" : validated[@"conversation_id"],
    @"provider" : validated[@"provider"],
    @"model" : validated[@"model"],
    @"policy" : validated[@"policy"],
    @"policy_version" : DSHProjectContextPolicyVersion,
    @"branch" : capture[@"branch"],
    @"head_oid" : capture[@"head_oid"],
    @"clean" : capture[@"clean"],
    @"conflicted" : capture[@"conflicted"],
    @"captured_at" : capturedAt,
    @"source_fingerprint" : capture[@"source_fingerprint"],
    @"selected_paths" : capture[@"expanded_paths"],
    @"tracked_status" : capture[@"tracked_status"],
  };
  NSMutableArray *included = [NSMutableArray array];
  NSMutableArray *omitted = [capture[@"omitted"] mutableCopy];
  NSData *envelope = [self framedEnvelopeMetadata:envelopeMetadata
                                           blocks:capture[@"blocks"]
                                         included:included
                                          omitted:omitted
                                            error:error];
  if (envelope == nil || ![self deadlineFrom:start error:error]) return nil;
  NSString *snapshotDigest = DSHServiceSHA256(envelope);
  NSDictionary *manifest = @{
    @"schema_version" : @1,
    @"snapshot_id" : snapshotId,
    @"project_id" : validated[@"project_id"],
    @"project_name" : lease.metadata[@"name"],
    @"branch" : capture[@"branch"],
    @"head_oid" : capture[@"head_oid"],
    @"clean" : capture[@"clean"],
    @"conflicted" : capture[@"conflicted"],
    @"captured_at" : capturedAt,
    @"policy_version" : DSHProjectContextPolicyVersion,
    @"provider_host" : @"api.deepseek.com",
    @"model" : validated[@"model"],
    @"included" : included,
    @"omitted" : omitted,
    @"context_bytes" : @(envelope.length),
    @"estimated_tokens" : @((envelope.length + 3) / 4),
    @"snapshot_sha256" : snapshotDigest,
    @"source_fingerprint" : capture[@"source_fingerprint"],
  };
  NSDictionary *sourceDescriptor = @{
    @"schema_version" : @1,
    @"project_id" : validated[@"project_id"],
    @"conversation_id" : validated[@"conversation_id"],
    @"provider" : validated[@"provider"],
    @"model" : validated[@"model"],
    @"policy" : validated[@"policy"],
    @"selected_paths" : validated[@"selected_paths"],
    @"source_fingerprint" : capture[@"source_fingerprint"],
    @"projects_root_device" : @((unsigned long long)lease.projectsRootDevice),
    @"projects_root_inode" : @((unsigned long long)lease.projectsRootInode),
    @"project_device" : @((unsigned long long)lease.projectDevice),
    @"project_inode" : @((unsigned long long)lease.projectInode),
    @"repository_device" : @((unsigned long long)lease.repositoryDevice),
    @"repository_inode" : @((unsigned long long)lease.repositoryInode),
    @"git_device" : @((unsigned long long)lease.gitDevice),
    @"git_inode" : @((unsigned long long)lease.gitInode),
    @"objects_device" : @((unsigned long long)lease.objectsDevice),
    @"objects_inode" : @((unsigned long long)lease.objectsInode),
    @"project_metadata_sha256" : capture[@"project_metadata_sha256"],
  };
  NSString *activeReferenceKey = [@"active:" stringByAppendingString:
      validated[@"conversation_id"]];
  if (![self.store beginPrepareTransactionWithEnvelope:envelope
                                               manifest:manifest
                                        sourceDescriptor:sourceDescriptor
                                             snapshotId:snapshotId
                                      activeReferenceKey:activeReferenceKey
                                                  error:nil]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorStorage);
    return nil;
  }
  if (![self deadlineFrom:start error:error]) {
    NSError *abortError = nil;
    if (![self.store abortPrepareTransactionForSnapshotId:snapshotId
                                        activeReferenceKey:activeReferenceKey
                                                     error:&abortError]) {
      DSHSetServiceError(error, DSHProjectContextServiceErrorStorage);
    }
    return nil;
  }
  return manifest;
}

- (BOOL)verifyLiveSnapshot:(NSDictionary *)snapshot
              retainedLease:(DSHLocalProjectLease *__strong *)retainedLease
                      error:(NSError **)error {
  if (retainedLease != nil) *retainedLease = nil;
  NSDictionary *descriptor = snapshot[@"source_descriptor"];
  NSString *projectId = descriptor[@"project_id"];
  NSArray *paths = descriptor[@"selected_paths"];
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId] ||
      ![paths isKindOfClass:NSArray.class]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorIntegrity);
    return NO;
  }
  NSDate *start = self.clock();
  NSError *accessError = nil;
  DSHLocalProjectLease *lease = [self.projectAccess
      leaseProjectId:projectId
                mode:DSHLocalProjectAccessModeRead
     includeMetadata:NO
             timeout:DSHProjectContextDeadlineSeconds
               error:&accessError];
  if (lease == nil ||
      [descriptor[@"projects_root_device"] unsignedLongLongValue] !=
          (unsigned long long)lease.projectsRootDevice ||
      [descriptor[@"projects_root_inode"] unsignedLongLongValue] !=
          (unsigned long long)lease.projectsRootInode ||
      [descriptor[@"project_device"] unsignedLongLongValue] !=
          (unsigned long long)lease.projectDevice ||
      [descriptor[@"project_inode"] unsignedLongLongValue] !=
          (unsigned long long)lease.projectInode ||
      [descriptor[@"repository_device"] unsignedLongLongValue] !=
          (unsigned long long)lease.repositoryDevice ||
      [descriptor[@"repository_inode"] unsignedLongLongValue] !=
          (unsigned long long)lease.repositoryInode ||
      [descriptor[@"git_device"] unsignedLongLongValue] !=
          (unsigned long long)lease.gitDevice ||
      [descriptor[@"git_inode"] unsignedLongLongValue] !=
          (unsigned long long)lease.gitInode ||
      [descriptor[@"objects_device"] unsignedLongLongValue] !=
          (unsigned long long)lease.objectsDevice ||
      [descriptor[@"objects_inode"] unsignedLongLongValue] !=
          (unsigned long long)lease.objectsInode) {
    DSHSetServiceError(
        error,
        lease == nil &&
                [accessError.domain isEqual:DSHLocalProjectAccessErrorDomain] &&
                accessError.code == DSHLocalProjectAccessErrorLockTimeout
            ? DSHProjectContextServiceErrorTimeout
            : DSHProjectContextServiceErrorChanged);
    return NO;
  }
  NSDictionary *capture = [self captureAndVerifyLease:lease
                                         selectedPaths:paths
                                         includeBlocks:NO
                                                 start:start
                                                 error:error];
  if (capture == nil) return NO;
  if (![capture[@"source_fingerprint"]
          isEqualToString:descriptor[@"source_fingerprint"]]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorChanged);
    return NO;
  }
  if (retainedLease != nil) *retainedLease = lease;
  return YES;
}

- (NSDictionary *)confirmSnapshotId:(NSString *)snapshotId
                               error:(NSError **)error {
  NSError *authorizationError = nil;
  DSHProjectContextAuthorizationLease *authorization = [self.store
      beginAuthorizationForSnapshotId:snapshotId
                   activeReferenceKey:nil error:&authorizationError];
  if (authorization == nil) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorConsent);
    return nil;
  }
  NSDictionary *snapshot = authorization.snapshot;
  NSString *activeKey = [@"active:" stringByAppendingString:
      snapshot[@"source_descriptor"][@"conversation_id"] ?: @""];
  for (NSDictionary *omission in snapshot[@"manifest"][@"omitted"]) {
    if ([omission[@"reason"]
            isEqual:DSHProjectContextOmissionReasonBudgetExceeded]) {
      [self.store cancelAuthorizationLease:authorization];
      DSHSetServiceError(error,
                         DSHProjectContextServiceErrorBudgetExceeded);
      return nil;
    }
  }
  __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *liveLease = nil;
  if (![self verifyLiveSnapshot:snapshot retainedLease:&liveLease error:error]) {
    [self.store cancelAuthorizationLease:authorization];
    return nil;
  }
  if (self.hook != nil) self.hook(@"before_authorization_complete", nil);
  authorizationError = nil;
  NSDictionary *receipt = [self.store
      completeAuthorizationLease:authorization
             activeReferenceKey:activeKey
                      operation:^id(NSDictionary *current, NSError **storeError) {
                        return [self.store
                            commitPrepareTransactionForSnapshotId:snapshotId
                              activeReferenceKey:activeKey
                                  snapshotDigest:current[@"manifest"]
                                                        [@"snapshot_sha256"]
                                           error:storeError];
                      }
                          error:&authorizationError];
  if (receipt == nil) {
    DSHSetServiceError(
        error,
        authorizationError.code == DSHProjectContextStoreErrorNotFound
            ? DSHProjectContextServiceErrorConsent
            : DSHProjectContextServiceErrorStorage);
  }
  return receipt;
}

- (NSDictionary *)inspectSnapshotId:(NSString *)snapshotId
                               error:(NSError **)error {
  NSError *storeError = nil;
  NSDictionary *snapshot = [self.store loadSnapshotId:snapshotId
                                                 error:&storeError];
  if (snapshot == nil) {
    DSHSetServiceError(error, DSHServiceSnapshotStoreError(storeError));
    return nil;
  }
  NSError *verificationError = nil;
  BOOL live = [self verifyLiveSnapshot:snapshot retainedLease:nil
                                  error:&verificationError];
  NSMutableDictionary *inspection = [snapshot[@"manifest"] mutableCopy];
  NSString *conversationId = snapshot[@"manifest"][@"conversation_id"];
  NSString *transactionKey = [conversationId isKindOfClass:NSString.class]
      ? [@"txn:prepare:" stringByAppendingString:conversationId] : nil;
  NSString *inspectionActiveKey = [conversationId isKindOfClass:NSString.class]
      ? [@"active:" stringByAppendingString:conversationId] : nil;
  BOOL prepared = transactionKey != nil && inspectionActiveKey != nil &&
      [self.store snapshotIdForReferenceKey:transactionKey error:nil] != nil &&
      [[self.store snapshotIdForReferenceKey:inspectionActiveKey error:nil]
          isEqual:snapshotId];
  BOOL confirmed = NO;
  if (live && !prepared) {
    NSArray<NSURL *> *files =
        [self.store fileURLsForSnapshotId:snapshotId error:nil];
    for (NSURL *url in files) {
      if (![url.URLByDeletingLastPathComponent.lastPathComponent
              isEqual:@"consents"]) {
        continue;
      }
      NSString *receiptId = url.lastPathComponent.stringByDeletingPathExtension;
      NSDictionary *consent =
          [self.store loadConsentReceiptId:receiptId error:nil];
      if ([consent[@"snapshot_id"] isEqual:snapshotId] &&
          [consent[@"snapshot_sha256"]
              isEqual:snapshot[@"manifest"][@"snapshot_sha256"]]) {
        confirmed = YES;
        break;
      }
    }
  }
  inspection[@"state"] = live ? (confirmed ? @"confirmed" : @"prepared")
                                 : @"stale";
  return inspection;
}

- (BOOL)discardSnapshotId:(NSString *)snapshotId error:(NSError **)error {
  NSError *storeError = nil;
  if ([self.store loadSnapshotId:snapshotId error:&storeError] == nil) {
    DSHSetServiceError(error, DSHServiceSnapshotStoreError(storeError));
    return NO;
  }
  storeError = nil;
  if (![self.store discardSnapshotId:snapshotId error:&storeError]) {
    DSHSetServiceError(error, DSHServiceSnapshotStoreError(storeError));
    return NO;
  }
  return YES;
}

- (NSData *)verifiedEnvelopeForSnapshotId:(NSString *)snapshotId
                          consentReceiptId:(NSString *)consentReceiptId
                               requestBind:(NSDictionary *)requestBind
                                   receipt:(NSDictionary **)receipt
                                     error:(NSError **)error {
  NSArray *keys = @[
    @"schema_version", @"conversation_id", @"project_id", @"provider",
    @"model", @"policy"
  ];
  if (!DSHServiceExactKeys(requestBind, keys) ||
      ![requestBind[@"schema_version"] isEqual:@1] ||
      ![requestBind[@"conversation_id"] isKindOfClass:NSString.class]) {
    DSHSetServiceError(error,
                       DSHProjectContextServiceErrorInvalidArgument);
    return nil;
  }
  NSString *transactionKey = [@"txn:prepare:" stringByAppendingString:
      requestBind[@"conversation_id"] ?: @""];
  NSString *requestActiveKey = [@"active:" stringByAppendingString:
      requestBind[@"conversation_id"]];
  if ([self.store snapshotIdForReferenceKey:transactionKey error:nil] != nil &&
      [[self.store snapshotIdForReferenceKey:requestActiveKey error:nil]
          isEqual:snapshotId]) {
    DSHSetServiceError(error, DSHProjectContextServiceErrorConsent);
    return nil;
  }
  NSError *authorizationError = nil;
  DSHProjectContextAuthorizationLease *authorization = [self.store
      beginAuthorizationForSnapshotId:snapshotId
                   activeReferenceKey:nil error:&authorizationError];
  if (authorization == nil) {
    DSHSetServiceError(error, DSHServiceSnapshotStoreError(authorizationError));
    return nil;
  }
  NSDictionary *snapshot = authorization.snapshot;
  NSDictionary *consent =
      [self.store loadConsentReceiptId:consentReceiptId error:nil];
  NSDictionary *descriptor = snapshot[@"source_descriptor"];
  if (snapshot == nil || consent == nil ||
      ![consent[@"snapshot_id"] isEqual:snapshotId] ||
      ![consent[@"snapshot_sha256"]
          isEqual:snapshot[@"manifest"][@"snapshot_sha256"]] ||
      ![requestBind[@"conversation_id"]
          isEqual:descriptor[@"conversation_id"]] ||
      ![requestBind[@"project_id"] isEqual:descriptor[@"project_id"]] ||
      ![requestBind[@"provider"] isEqual:descriptor[@"provider"]] ||
      ![requestBind[@"model"] isEqual:descriptor[@"model"]] ||
      ![requestBind[@"policy"] isEqual:descriptor[@"policy"]]) {
    [self.store cancelAuthorizationLease:authorization];
    DSHSetServiceError(error, DSHProjectContextServiceErrorConsent);
    return nil;
  }
  NSString *activeKey = [@"active:" stringByAppendingString:
      descriptor[@"conversation_id"] ?: @""];
  __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *liveLease = nil;
  if (![self verifyLiveSnapshot:snapshot retainedLease:&liveLease error:error]) {
    [self.store cancelAuthorizationLease:authorization];
    return nil;
  }
  if (self.hook != nil) self.hook(@"before_authorization_complete", nil);
  __block NSDictionary *verifiedReceipt = nil;
  authorizationError = nil;
  NSData *verified = [self.store
      completeAuthorizationLease:authorization
             activeReferenceKey:activeKey
                      operation:^id(NSDictionary *current,
                                    NSError **storeError) {
                        if ([self.store snapshotIdForReferenceKey:transactionKey
                                                           error:nil] != nil &&
                            [[self.store snapshotIdForReferenceKey:activeKey
                                                             error:nil]
                                isEqual:snapshotId]) {
                          if (storeError != nil) {
                            *storeError = [NSError
                                errorWithDomain:DSHProjectContextStoreErrorDomain
                                           code:DSHProjectContextStoreErrorIntegrity
                                       userInfo:@{}];
                          }
                          return nil;
                        }
                        NSDictionary *finalConsent = [self.store
                            loadConsentReceiptId:consentReceiptId
                                           error:storeError];
                        if (finalConsent == nil ||
                            ![finalConsent[@"snapshot_id"] isEqual:snapshotId] ||
                            ![finalConsent[@"snapshot_sha256"]
                                isEqual:current[@"manifest"][@"snapshot_sha256"]]) {
                          if (storeError != nil && *storeError == nil) {
                            *storeError = [NSError
                                errorWithDomain:DSHProjectContextStoreErrorDomain
                                           code:DSHProjectContextStoreErrorIntegrity
                                       userInfo:@{}];
                          }
                          return nil;
                        }
                        verifiedReceipt = @{
                          @"schema_version" : @1,
                          @"snapshot_id" : snapshotId,
                          @"snapshot_sha256" :
                              current[@"manifest"][@"snapshot_sha256"],
                          @"source_fingerprint" :
                              current[@"manifest"][@"source_fingerprint"],
                          @"context_bytes" :
                              current[@"manifest"][@"context_bytes"],
                          @"verified_at" : DSHServiceISO8601(self.clock()),
                        };
                        return [current[@"envelope"] copy];
                      }
                          error:&authorizationError];
  if (verified == nil) {
    DSHSetServiceError(
        error,
        (authorizationError.code == DSHProjectContextStoreErrorNotFound ||
         authorizationError.code == DSHProjectContextStoreErrorIntegrity)
            ? DSHProjectContextServiceErrorConsent
            : DSHProjectContextServiceErrorStorage);
    return nil;
  }
  if (receipt != nil) *receipt = verifiedReceipt;
  return verified;
}

@end

DSHProjectContextService *DSHSharedProjectContextService(void) {
  static DSHProjectContextService *shared = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    shared = [[DSHProjectContextService alloc]
        initWithProjectAccess:DSHLocalProjectAccess.sharedAccess
                       store:[[DSHProjectContextStore alloc] init]
                      policy:[[DSHProjectContextPolicy alloc] init]
                       clock:^NSDate * {
                         return NSDate.date;
                       }
         identifierGenerator:^NSString * {
           return NSUUID.UUID.UUIDString.lowercaseString;
         }
                        hook:nil];
  });
  return shared;
}
