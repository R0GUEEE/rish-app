#import "AgentWorkspaceToolExecutor.h"

#import "AgentNativeWAL.h"
#import "AgentRootResolver.h"
#import "LocalWorkspaceAccess.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <unistd.h>

static const NSUInteger DSHAgentWorkspaceMaxPathBytes = 512;
// Leave canonical-envelope headroom under the 64-KiB protected feedback cap.
static const NSUInteger DSHAgentWorkspaceMaxReadBytes = 60 * 1024;
static const NSUInteger DSHAgentWorkspaceMaxFeedbackBytes = 64 * 1024;
static const NSUInteger DSHAgentWorkspaceMaxEntries = 1000;

// Bounded native diff-preview limits.  The preview is computed from the
// prepared intent (validated arguments + current file state), never from
// unvalidated model text, and never exceeds these budgets.
static const NSUInteger DSHAgentApprovalMaxPriorReadBytes = 64 * 1024;
static const NSUInteger DSHAgentApprovalMaxDiffLines = 2000;
static const NSUInteger DSHAgentApprovalMaxHunkLines = 24;
static const NSUInteger DSHAgentApprovalMaxContextLines = 3;
static const NSUInteger DSHAgentApprovalMaxPreviewBytes = 4096;

static NSArray<NSString *> *DSHAgentWorkspacePathComponents(id value,
                                                             BOOL allowRoot) {
  if (![value isKindOfClass:NSString.class]) return nil;
  NSString *path = value;
  NSData *bytes = [path dataUsingEncoding:NSUTF8StringEncoding];
  if (bytes == nil || bytes.length > DSHAgentWorkspaceMaxPathBytes ||
      ![path isEqualToString:path.precomposedStringWithCanonicalMapping] ||
      [path hasPrefix:@"/"] || [path containsString:@"\\"] ||
      [path rangeOfString:@"\0"].location != NSNotFound) return nil;
  // The workspace root is the empty path.  A bare "." is accepted as the same
  // root for directory listings because models reach for it first; it never
  // names an entry, so nothing below can be confused with a "." component.
  if (path.length == 0 || (allowRoot && [path isEqualToString:@"."])) {
    return allowRoot ? @[] : nil;
  }
  NSMutableArray<NSString *> *components = [NSMutableArray array];
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    NSData *componentBytes = [component dataUsingEncoding:NSUTF8StringEncoding];
    if (componentBytes.length == 0 || componentBytes.length > NAME_MAX ||
        [component isEqualToString:@"."] || [component isEqualToString:@".."] ||
        [component isEqualToString:@".git"] ||
        [component isEqualToString:@".trash"] ||
        [component rangeOfCharacterFromSet:
            NSCharacterSet.controlCharacterSet].location != NSNotFound) return nil;
    [components addObject:component];
  }
  return components;
}

static int DSHAgentWorkspaceOpenDirectory(int rootDescriptor,
                                           NSArray<NSString *> *components) {
  int current = dup(rootDescriptor);
  if (current < 0) return -1;
  for (NSString *component in components) {
    int next = openat(current, component.fileSystemRepresentation,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close(current);
    if (next < 0) return -1;
    current = next;
  }
  return current;
}

static int DSHAgentWorkspaceOpenParent(int rootDescriptor,
                                       NSArray<NSString *> *components,
                                       NSString **name) {
  if (components.count == 0) return -1;
  int parent = DSHAgentWorkspaceOpenDirectory(
      rootDescriptor,
      [components subarrayWithRange:NSMakeRange(0, components.count - 1)]);
  if (parent >= 0 && name != nullptr) *name = components.lastObject;
  return parent;
}

static NSArray<NSString *> *DSHAgentApprovalLines(NSString *text) {
  if (text.length == 0) return @[];
  return [text componentsSeparatedByString:@"\n"];
}

static BOOL DSHAgentApprovalLooksBinary(NSString *text) {
  if (text == nil) return YES;
  return [text rangeOfString:@"\0"].location != NSNotFound;
}

/// Anchored prefix/suffix line diff with a strict byte budget.  `truncatedOut`
/// is set when the prior content, the hunk, or the final preview exceeded its
/// bound, so the UI can mark the preview as incomplete.  Returns nil for
/// binary content (a preview would leak bytes, not text).
static NSString *DSHAgentApprovalUnifiedDiff(NSString *prior,
                                              NSString *next,
                                              BOOL *truncatedOut) {
  if (truncatedOut != nullptr) *truncatedOut = NO;
  if (DSHAgentApprovalLooksBinary(prior) ||
      DSHAgentApprovalLooksBinary(next)) return nil;
  NSArray<NSString *> *priorLines = DSHAgentApprovalLines(prior);
  NSArray<NSString *> *nextLines = DSHAgentApprovalLines(next);
  if (priorLines.count > DSHAgentApprovalMaxDiffLines ||
      nextLines.count > DSHAgentApprovalMaxDiffLines) {
    if (truncatedOut != nullptr) *truncatedOut = YES;
    priorLines = [priorLines subarrayWithRange:
        NSMakeRange(0, MIN(priorLines.count, DSHAgentApprovalMaxDiffLines))];
    nextLines = [nextLines subarrayWithRange:
        NSMakeRange(0, MIN(nextLines.count, DSHAgentApprovalMaxDiffLines))];
  }
  NSUInteger prefix = 0;
  while (prefix < priorLines.count && prefix < nextLines.count &&
         [priorLines[prefix] isEqual:nextLines[prefix]]) prefix += 1;
  NSUInteger priorSuffix = 0;
  NSUInteger nextSuffix = 0;
  while (priorSuffix < priorLines.count - prefix &&
         nextSuffix < nextLines.count - prefix &&
         [priorLines[priorLines.count - 1 - priorSuffix]
             isEqual:nextLines[nextLines.count - 1 - nextSuffix]]) {
    priorSuffix += 1;
    nextSuffix += 1;
  }
  NSUInteger removedCount = priorLines.count - prefix - priorSuffix;
  NSUInteger addedCount = nextLines.count - prefix - nextSuffix;
  if (removedCount == 0 && addedCount == 0) return @"";
  NSMutableString *preview = [NSMutableString string];
  [preview appendFormat:@"@@ -%lu,%lu +%lu,%lu @@",
      (unsigned long)(prefix + 1), (unsigned long)removedCount,
      (unsigned long)(prefix + 1), (unsigned long)addedCount];
  NSUInteger contextStart = prefix >= DSHAgentApprovalMaxContextLines
      ? prefix - DSHAgentApprovalMaxContextLines : 0;
  for (NSUInteger index = contextStart; index < prefix; index += 1) {
    [preview appendFormat:@"\n %@", priorLines[index]];
  }
  BOOL hunkTruncated = removedCount > DSHAgentApprovalMaxHunkLines ||
      addedCount > DSHAgentApprovalMaxHunkLines;
  NSUInteger shownRemoved = MIN(removedCount, DSHAgentApprovalMaxHunkLines);
  NSUInteger shownAdded = MIN(addedCount, DSHAgentApprovalMaxHunkLines);
  for (NSUInteger index = 0; index < shownRemoved; index += 1) {
    [preview appendFormat:@"\n-%@", priorLines[prefix + index]];
  }
  for (NSUInteger index = 0; index < shownAdded; index += 1) {
    [preview appendFormat:@"\n+%@", nextLines[prefix + index]];
  }
  if (hunkTruncated) [preview appendString:@"\n…"];
  NSUInteger suffixStart = prefix + removedCount;
  NSUInteger contextEnd = MIN(priorLines.count,
      suffixStart + DSHAgentApprovalMaxContextLines);
  for (NSUInteger index = suffixStart; index < contextEnd; index += 1) {
    [preview appendFormat:@"\n %@", priorLines[index]];
  }
  NSData *previewBytes = [preview dataUsingEncoding:NSUTF8StringEncoding];
  if (previewBytes.length > DSHAgentApprovalMaxPreviewBytes) {
    if (truncatedOut != nullptr) *truncatedOut = YES;
    NSString *clipped = [preview substringToIndex:
        DSHAgentApprovalMaxPreviewBytes / 2];
    return [clipped stringByAppendingString:@"\n…"];
  }
  if (truncatedOut != nullptr) *truncatedOut = hunkTruncated;
  return preview;
}

static NSString *DSHAgentWorkspaceRevision(struct stat metadata) {
  // Revisions are opaque bounded metadata, not a new protocol digest.
  return [NSString stringWithFormat:@"%llx:%llx:%llx:%llx:%llx",
      (unsigned long long)metadata.st_dev,
      (unsigned long long)metadata.st_ino,
      (unsigned long long)metadata.st_size,
      (unsigned long long)metadata.st_mtimespec.tv_sec,
      (unsigned long long)metadata.st_mtimespec.tv_nsec];
}

static BOOL DSHAgentWorkspaceSameFileState(struct stat left,
                                           struct stat right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
      left.st_mode == right.st_mode && left.st_size == right.st_size &&
      left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec &&
      left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec;
}

static BOOL DSHAgentWorkspaceStatMatches(int parent,
                                         NSString *name,
                                         struct stat expected,
                                         struct stat *actualOut) {
  struct stat actual = {};
  if (fstatat(parent, name.fileSystemRepresentation, &actual,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !DSHAgentWorkspaceSameFileState(actual, expected) ||
      (S_ISREG(actual.st_mode) && actual.st_nlink != 1)) return NO;
  if (actualOut != nullptr) *actualOut = actual;
  return YES;
}

static BOOL DSHAgentWorkspaceWriteAll(int descriptor, NSData *data) {
  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  NSUInteger offset = 0;
  while (offset < data.length) {
    ssize_t count = write(descriptor, bytes + offset, data.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return NO;
    offset += (NSUInteger)count;
  }
  return YES;
}

static NSString *DSHAgentWorkspaceFeedback(NSDictionary *feedback,
                                            NSError **error) {
  NSData *bytes = DSHAgentCanonicalJSON(feedback, error);
  if (bytes == nil || bytes.length > DSHAgentWorkspaceMaxFeedbackBytes) {
    if (bytes != nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
    }
    return nil;
  }
  NSString *result = [[NSString alloc] initWithData:bytes
                                           encoding:NSUTF8StringEncoding];
  if (result == nil || !DSHAgentValidateNativeToolFeedbackString(result, error)) {
    return nil;
  }
  return result;
}

static NSDictionary *DSHAgentWorkspaceFailure(NSString *name,
                                               NSString *failureCode,
                                               BOOL ambiguous,
                                               NSError **error) {
  NSDictionary *feedbackObject = @{
    @"schema_version" : @1,
    @"name" : name,
    @"outcome" : ambiguous ? @"ambiguous" : @"failed",
    @"payload" : @{
      @"schema_version" : @1,
      @"failure_code" : failureCode,
    },
  };
  NSString *feedback = DSHAgentWorkspaceFeedback(feedbackObject, error);
  if (feedback == nil) return nil;
  return @{
    @"schema_version" : @1,
    @"status" : ambiguous ? @"ambiguous" : @"failed",
    @"feedback" : feedback,
    @"settled_facts" : NSNull.null,
    @"truncated" : @NO,
    @"effect_may_have_occurred" : @(ambiguous),
  };
}

static BOOL DSHAgentWorkspaceEntryList(int directoryDescriptor,
                                       NSArray **entriesOut,
                                       NSString **fingerprintOut,
                                       NSError **error) {
  int duplicate = dup(directoryDescriptor);
  DIR *directory = duplicate < 0 ? nullptr : fdopendir(duplicate);
  if (directory == nullptr) {
    if (duplicate >= 0) close(duplicate);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return NO;
  }
  NSMutableArray<NSDictionary *> *privateEntries = [NSMutableArray array];
  struct dirent *entry = nullptr;
  errno = 0;
  while ((entry = readdir(directory)) != nullptr) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    NSData *nameBytes = [NSData dataWithBytes:entry->d_name
                                       length:strlen(entry->d_name)];
    NSString *name = [[NSString alloc] initWithData:nameBytes
                                           encoding:NSUTF8StringEncoding];
    if (name == nil) {
      closedir(directory);
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    // Hide the same reserved names the local-workspace path validator
    // (LWPathName) hides, case-folded: native metadata is never a tool
    // result.  Ordinary dotfiles such as .gitignore stay visible.
    NSString *foldedName = name.lowercaseString;
    if ([foldedName isEqual:@".git"] || [foldedName isEqual:@".trash"] ||
        [foldedName hasPrefix:@".staging-"] ||
        [foldedName hasPrefix:@".rish-write-"]) {
      continue;
    }
    if (privateEntries.count >= DSHAgentWorkspaceMaxEntries) {
      closedir(directory);
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    struct stat metadata = {};
    if (fstatat(directoryDescriptor, entry->d_name, &metadata,
                AT_SYMLINK_NOFOLLOW) != 0 || S_ISLNK(metadata.st_mode) ||
        (!S_ISREG(metadata.st_mode) && !S_ISDIR(metadata.st_mode)) ||
        (S_ISREG(metadata.st_mode) && metadata.st_nlink != 1)) {
      closedir(directory);
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (![name isEqualToString:name.precomposedStringWithCanonicalMapping]) {
      closedir(directory);
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSError *digestError = nil;
    NSString *nameDigest = DSHAgentHB(@"directory-name", nameBytes, &digestError);
    if (nameDigest == nil) {
      closedir(directory);
      if (error != nullptr) *error = digestError;
      return NO;
    }
    [privateEntries addObject:@{
      @"name_bytes" : nameBytes,
      @"public" : @{
        @"schema_version" : @1,
        @"name" : name,
        @"type" : S_ISDIR(metadata.st_mode) ? @"directory" : @"file",
        @"revision" : DSHAgentWorkspaceRevision(metadata),
      },
      @"fingerprint" : @{
        @"name_sha256" : nameDigest,
        @"type" : S_ISDIR(metadata.st_mode) ? @"directory" : @"file",
        @"revision" : DSHAgentWorkspaceRevision(metadata),
      },
    }];
  }
  int readError = errno;
  closedir(directory);
  if (readError != 0) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return NO;
  }
  [privateEntries sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                           NSDictionary *right) {
    NSData *leftBytes = left[@"name_bytes"];
    NSData *rightBytes = right[@"name_bytes"];
    NSUInteger common = MIN(leftBytes.length, rightBytes.length);
    int ordering = memcmp(leftBytes.bytes, rightBytes.bytes, common);
    if (ordering < 0) return NSOrderedAscending;
    if (ordering > 0) return NSOrderedDescending;
    if (leftBytes.length < rightBytes.length) return NSOrderedAscending;
    if (leftBytes.length > rightBytes.length) return NSOrderedDescending;
    return NSOrderedSame;
  }];
  NSMutableArray *publicEntries = [NSMutableArray arrayWithCapacity:privateEntries.count];
  NSMutableArray *fingerprintEntries = [NSMutableArray arrayWithCapacity:privateEntries.count];
  for (NSDictionary *value in privateEntries) {
    [publicEntries addObject:value[@"public"]];
    [fingerprintEntries addObject:value[@"fingerprint"]];
  }
  NSString *fingerprint = DSHAgentHJ(@"directory", @{
    @"entries" : fingerprintEntries,
  }, error);
  if (fingerprint == nil) return NO;
  if (entriesOut != nullptr) *entriesOut = publicEntries;
  if (fingerprintOut != nullptr) *fingerprintOut = fingerprint;
  return YES;
}

@interface DSHAgentWorkspaceToolExecutor ()
@property(nonatomic, strong, readwrite) DSHAgentRootResolver *rootResolver;
@end

@implementation DSHAgentWorkspaceToolExecutor

- (instancetype)initWithRootResolver:(DSHAgentRootResolver *)rootResolver {
  self = [super init];
  if (self) _rootResolver = rootResolver;
  return self;
}

- (NSDictionary *)prepareToolNamed:(NSString *)name
                          arguments:(NSDictionary *)arguments
                               root:(NSDictionary *)root
                              error:(NSError **)error {
  if (![DSHAgentRootResolver validateAgentRootProjection:root error:error] ||
      ![arguments isKindOfClass:NSDictionary.class] ||
      (![name isEqualToString:@"list_dir"] &&
       ![name isEqualToString:@"read_file"] &&
       ![name isEqualToString:@"write_file"])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  BOOL write = [name isEqualToString:@"write_file"];
  NSString *agentCapability = write ? @"file_write" : @"file_read";
  if (![root[@"capabilities"] containsObject:agentCapability]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSString *path = [name isEqualToString:@"list_dir"] && arguments.count == 0
      ? @"" : arguments[@"path"];
  NSArray *components = DSHAgentWorkspacePathComponents(
      path, [name isEqualToString:@"list_dir"]);
  if (components == nil ||
      (([name isEqualToString:@"read_file"] || write) &&
       ![arguments[@"path"] isKindOfClass:NSString.class])) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if (([name isEqualToString:@"read_file"] &&
       !DSHAgentExactDictionaryKeys(arguments, @[@"path"])) ||
      ([name isEqualToString:@"list_dir"] && arguments.count != 0 &&
       !DSHAgentExactDictionaryKeys(arguments, @[@"path"]))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *precondition = nil;
  __block NSDictionary *approvalPreview = nil;
  BOOL succeeded = [self.rootResolver performOperationForFrozenRoot:root
      mode:write ? DSHAgentRootOperationModeWrite
                 : DSHAgentRootOperationModeRead
      timeout:5.0
      block:^BOOL(int rootDescriptor, __unused git_repository *repository,
                  NSError **blockError) {
    (void)blockError;
    if ([name isEqualToString:@"list_dir"]) {
      int directory = DSHAgentWorkspaceOpenDirectory(rootDescriptor, components);
      NSString *fingerprint = nil;
      BOOL ok = directory >= 0 && DSHAgentWorkspaceEntryList(
          directory, nullptr, &fingerprint, blockError);
      if (directory >= 0) close(directory);
      if (!ok) return NO;
      precondition = @{
        @"schema_version" : @1,
        @"kind" : @"list_dir",
        @"directory_fingerprint_sha256" : fingerprint,
      };
      // The ledger and the Store both require every preview path to be a
      // non-empty relative path, so the workspace root is previewed as no
      // path at all rather than as "".
      approvalPreview = @{
        @"schema_version" : @1, @"kind" : @"list_dir",
        @"paths" : components.count == 0 ? @[] : @[path],
        @"content_bytes" : NSNull.null,
        @"prior" : NSNull.null, @"diff_preview" : NSNull.null,
        @"diff_truncated" : @NO,
      };
      return YES;
    }
    NSString *leaf = nil;
    int parent = DSHAgentWorkspaceOpenParent(rootDescriptor, components, &leaf);
    if (parent < 0) {
      DSHSetAgentNativeStoreError(blockError, DSHAgentNativeStoreErrorUnavailable);
      return NO;
    }
    struct stat metadata = {};
    int statResult = fstatat(parent, leaf.fileSystemRepresentation, &metadata,
                             AT_SYMLINK_NOFOLLOW);
    if ([name isEqualToString:@"read_file"]) {
      if (statResult != 0 || !S_ISREG(metadata.st_mode) ||
          S_ISLNK(metadata.st_mode) || metadata.st_nlink != 1) {
        close(parent);
        DSHSetAgentNativeStoreError(blockError, DSHAgentNativeStoreErrorNotFound);
        return NO;
      }
      precondition = @{
        @"schema_version" : @1,
        @"kind" : @"read_file",
        @"source_revision" : DSHAgentWorkspaceRevision(metadata),
      };
      approvalPreview = @{
        @"schema_version" : @1, @"kind" : @"read_file",
        @"paths" : @[path], @"content_bytes" : NSNull.null,
        @"prior" : NSNull.null, @"diff_preview" : NSNull.null,
        @"diff_truncated" : @NO,
      };
      close(parent);
      return YES;
    }
    BOOL exactWrite = DSHAgentExactDictionaryKeys(
        arguments, @[@"path", @"content", @"expected_prior"]) ||
        DSHAgentExactDictionaryKeys(
            arguments, @[@"path", @"content", @"expected_revision"]) ||
        DSHAgentExactDictionaryKeys(arguments, @[@"path", @"content"]);
    NSData *content = [arguments[@"content"] isKindOfClass:NSString.class]
        ? [arguments[@"content"] dataUsingEncoding:NSUTF8StringEncoding] : nil;
    if (!exactWrite || content == nil ||
        content.length > DSHAgentNativeWALMaxSingleWriteBytes ||
        (statResult == 0 && (!S_ISREG(metadata.st_mode) ||
                            S_ISLNK(metadata.st_mode) || metadata.st_nlink != 1)) ||
        (statResult != 0 && errno != ENOENT)) {
      close(parent);
      DSHSetAgentNativeStoreError(blockError, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSDictionary *actualPrior = statResult == 0
        ? @{ @"schema_version" : @1, @"kind" : @"known",
             @"revision" : DSHAgentWorkspaceRevision(metadata) }
        : @{ @"schema_version" : @1, @"kind" : @"absent" };
    NSDictionary *expectedPrior = arguments[@"expected_prior"];
    if (expectedPrior == nil) {
      id revision = arguments[@"expected_revision"];
      expectedPrior = revision == nil || revision == NSNull.null
          ? @{ @"schema_version" : @1, @"kind" : @"absent" }
          : @{ @"schema_version" : @1, @"kind" : @"known",
               @"revision" : revision ?: @"" };
    }
    if (![expectedPrior isEqual:actualPrior]) {
      close(parent);
      DSHSetAgentNativeStoreError(blockError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSData *pathBytes = [path dataUsingEncoding:NSUTF8StringEncoding];
    NSString *pathDigest = DSHAgentHB(@"relative-path", pathBytes, blockError);
    NSString *contentDigest = DSHAgentHB(@"file-content", content, blockError);
    if (pathDigest == nil || contentDigest == nil) {
      close(parent);
      return NO;
    }
    // Bounded prior-content read for the diff preview.  The precondition
    // remains authoritative for the write; the preview is display-only.
    NSData *priorContent = nil;
    BOOL priorTruncated = NO;
    if (statResult == 0) {
      int file = openat(parent, leaf.fileSystemRepresentation,
                        O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      if (file >= 0) {
        NSMutableData *data = [NSMutableData dataWithCapacity:
            MIN((NSUInteger)metadata.st_size,
                DSHAgentApprovalMaxPriorReadBytes)];
        uint8_t buffer[8192];
        ssize_t got;
        while ((got = read(file, buffer, sizeof(buffer))) > 0) {
          if (data.length + (NSUInteger)got > DSHAgentApprovalMaxPriorReadBytes) {
            priorTruncated = YES;
            break;
          }
          [data appendBytes:buffer length:(NSUInteger)got];
        }
        close(file);
        priorContent = data;
      }
    }
    precondition = @{
      @"schema_version" : @2,
      @"kind" : @"write_file",
      @"relative_path_sha256" : pathDigest,
      @"prior" : actualPrior,
      @"content_sha256" : contentDigest,
      @"content_bytes" : @(content.length),
    };
    close(parent);
    NSString *priorText = priorContent == nil ? nil
        : [[NSString alloc] initWithData:priorContent
                                encoding:NSUTF8StringEncoding];
    BOOL diffTruncated = priorTruncated;
    NSString *diffPreview = priorContent == nil ? nil
        : DSHAgentApprovalUnifiedDiff(priorText, arguments[@"content"],
                                      &diffTruncated);
    approvalPreview = @{
      @"schema_version" : @1,
      @"kind" : @"write_file",
      @"paths" : @[path],
      @"content_bytes" : @(content.length),
      // The preview prior always carries `bytes` (null when nothing was
      // read); the ledger and the Store validate that exact shape and reject
      // a new-file write whose prior omits the key.
      @"prior" : statResult == 0
          ? @{ @"schema_version" : @1, @"kind" : @"known",
               @"bytes" : priorContent == nil ? NSNull.null
                   : @(priorContent.length) }
          : @{ @"schema_version" : @1, @"kind" : @"absent",
               @"bytes" : NSNull.null },
      @"diff_preview" : diffPreview ?: NSNull.null,
      @"diff_truncated" : @(diffTruncated),
    };
    return YES;
  } error:error];
  if (!succeeded || precondition == nil) return nil;
  return @{
    @"schema_version" : @1,
    @"precondition" : precondition,
    @"reserved_write_bytes" : write
        ? precondition[@"content_bytes"] : @0,
    @"approval_preview" : approvalPreview ?: NSNull.null,
  };
}

- (NSDictionary *)executeToolNamed:(NSString *)name
                          arguments:(NSDictionary *)arguments
                               root:(NSDictionary *)root
                       precondition:(NSDictionary *)precondition
                              error:(NSError **)error {
  if (![DSHAgentRootResolver validateAgentRootProjection:root error:error] ||
      ![arguments isKindOfClass:NSDictionary.class] ||
      ![precondition isKindOfClass:NSDictionary.class] ||
      ![precondition[@"kind"] isEqual:name]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  if (([name isEqualToString:@"write_file"] &&
       (!DSHAgentCanonicalSHA256(precondition[@"relative_path_sha256"]) ||
        !DSHAgentCanonicalSHA256(precondition[@"content_sha256"]) ||
        !DSHAgentSafeInteger(precondition[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
        ![precondition[@"prior"] isKindOfClass:NSDictionary.class])) ||
      ([name isEqualToString:@"read_file"] &&
       !DSHAgentBoundedUTF8String(precondition[@"source_revision"], 256, NO,
                                 nullptr)) ||
      ([name isEqualToString:@"list_dir"] &&
       !DSHAgentCanonicalSHA256(
           precondition[@"directory_fingerprint_sha256"]))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *path = [name isEqualToString:@"list_dir"] && arguments.count == 0
      ? @"" : arguments[@"path"];
  NSArray *components = DSHAgentWorkspacePathComponents(
      path, [name isEqualToString:@"list_dir"]);
  if (components == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  BOOL write = [name isEqualToString:@"write_file"];
  NSString *agentCapability = write ? @"file_write" : @"file_read";
  if (![root[@"capabilities"] containsObject:agentCapability]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if (write) {
    NSData *pathBytes = [path dataUsingEncoding:NSUTF8StringEncoding];
    NSData *contentBytes = [arguments[@"content"]
        dataUsingEncoding:NSUTF8StringEncoding];
    NSString *pathSHA = pathBytes == nil ? nil
        : DSHAgentHB(@"relative-path", pathBytes, error);
    NSString *contentSHA = contentBytes == nil ? nil
        : DSHAgentHB(@"file-content", contentBytes, error);
    if (![pathSHA isEqual:precondition[@"relative_path_sha256"]] ||
        ![contentSHA isEqual:precondition[@"content_sha256"]] ||
        ![@(contentBytes.length) isEqual:precondition[@"content_bytes"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return nil;
    }
  }
  __block NSDictionary *result = nil;
  BOOL succeeded = [self.rootResolver performOperationForFrozenRoot:root
      mode:write ? DSHAgentRootOperationModeWrite
                 : DSHAgentRootOperationModeRead
      timeout:5.0
      block:^BOOL(int rootDescriptor, __unused git_repository *repository,
                  NSError **blockError) {
    if ([name isEqualToString:@"list_dir"]) {
      int directory = DSHAgentWorkspaceOpenDirectory(rootDescriptor, components);
      NSArray *entries = nil;
      NSString *fingerprint = nil;
      BOOL ok = directory >= 0 && DSHAgentWorkspaceEntryList(
          directory, &entries, &fingerprint, blockError);
      if (directory >= 0) close(directory);
      if (!ok) return NO;
      if (![fingerprint isEqual:precondition[@"directory_fingerprint_sha256"]]) {
        result = DSHAgentWorkspaceFailure(name, @"E_AGENT_CONFLICT", NO,
                                          blockError);
        return result != nil;
      }
      NSMutableArray *visible = [entries mutableCopy];
      BOOL truncated = NO;
      NSString *feedback = nil;
      while (true) {
        NSDictionary *object = @{
          @"schema_version" : @1, @"name" : name, @"outcome" : @"ok",
          @"payload" : @{
            @"schema_version" : @1, @"entries" : visible,
            @"truncated" : @(truncated),
          },
        };
        feedback = DSHAgentWorkspaceFeedback(object, nil);
        if (feedback != nil || visible.count == 0) break;
        [visible removeLastObject];
        truncated = YES;
      }
      if (feedback == nil) {
        DSHSetAgentNativeStoreError(blockError, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      result = @{
        @"schema_version" : @1, @"status" : @"ok",
        @"feedback" : feedback,
        @"settled_facts" : @{
          @"schema_version" : @1, @"kind" : @"list_dir",
          @"directory_fingerprint_sha256" : fingerprint,
        },
        @"truncated" : @(truncated), @"effect_may_have_occurred" : @NO,
      };
      return YES;
    }
    NSString *leaf = nil;
    int parent = DSHAgentWorkspaceOpenParent(rootDescriptor, components, &leaf);
    if (parent < 0) {
      DSHSetAgentNativeStoreError(blockError, DSHAgentNativeStoreErrorUnavailable);
      return NO;
    }
    if ([name isEqualToString:@"read_file"]) {
      int descriptor = openat(parent, leaf.fileSystemRepresentation,
                              O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      struct stat before = {};
      if (descriptor < 0 || fstat(descriptor, &before) != 0 ||
          !S_ISREG(before.st_mode) || before.st_nlink != 1 ||
          ![DSHAgentWorkspaceRevision(before)
              isEqual:precondition[@"source_revision"]]) {
        if (descriptor >= 0) close(descriptor);
        close(parent);
        result = DSHAgentWorkspaceFailure(name, @"E_AGENT_CONFLICT", NO,
                                          blockError);
        return result != nil;
      }
      NSUInteger wanted = MIN((NSUInteger)MAX((off_t)0, before.st_size),
                              DSHAgentWorkspaceMaxReadBytes);
      NSMutableData *data = [NSMutableData dataWithLength:wanted];
      NSUInteger offset = 0;
      while (offset < wanted) {
        ssize_t count = pread(descriptor,
                              static_cast<uint8_t *>(data.mutableBytes) + offset,
                              wanted - offset, (off_t)offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        offset += (NSUInteger)count;
      }
      [data setLength:offset];
      struct stat after = {};
      BOOL stable = fstat(descriptor, &after) == 0 &&
          [DSHAgentWorkspaceRevision(after)
              isEqual:precondition[@"source_revision"]];
      close(descriptor);
      close(parent);
      NSString *content = stable
          ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
      if (!stable || content == nil) {
        result = DSHAgentWorkspaceFailure(
            name, stable ? @"E_AGENT_TOOL_FAILED" : @"E_AGENT_CONFLICT", NO,
            blockError);
        return result != nil;
      }
      BOOL truncated = before.st_size > (off_t)offset;
      NSDictionary *object = @{
        @"schema_version" : @1, @"name" : name, @"outcome" : @"ok",
        @"payload" : @{
          @"schema_version" : @1, @"content" : content,
          @"revision" : precondition[@"source_revision"],
          @"truncated" : @(truncated),
        },
      };
      NSString *feedback = DSHAgentWorkspaceFeedback(object, blockError);
      if (feedback == nil) return NO;
      result = @{
        @"schema_version" : @1, @"status" : @"ok", @"feedback" : feedback,
        @"settled_facts" : @{
          @"schema_version" : @1, @"kind" : @"read_file",
          @"source_revision" : precondition[@"source_revision"],
        },
        @"truncated" : @(truncated), @"effect_may_have_occurred" : @NO,
      };
      return YES;
    }
    NSData *content = [arguments[@"content"] dataUsingEncoding:NSUTF8StringEncoding];
    struct stat before = {};
    int statResult = fstatat(parent, leaf.fileSystemRepresentation, &before,
                             AT_SYMLINK_NOFOLLOW);
    NSDictionary *actualPrior = statResult == 0
        ? @{ @"schema_version" : @1, @"kind" : @"known",
             @"revision" : DSHAgentWorkspaceRevision(before) }
        : @{ @"schema_version" : @1, @"kind" : @"absent" };
    if (content == nil || ![actualPrior isEqual:precondition[@"prior"]] ||
        (statResult == 0 && (!S_ISREG(before.st_mode) || S_ISLNK(before.st_mode))) ||
        (statResult != 0 && errno != ENOENT)) {
      close(parent);
      result = DSHAgentWorkspaceFailure(name, @"E_AGENT_CONFLICT", NO,
                                        blockError);
      return result != nil;
    }
    int existingDescriptor = -1;
    if (statResult == 0) {
      existingDescriptor = openat(parent, leaf.fileSystemRepresentation,
                                  O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      struct stat opened = {};
      if (existingDescriptor < 0 || fstat(existingDescriptor, &opened) != 0 ||
          before.st_nlink != 1 ||
          !DSHAgentWorkspaceSameFileState(before, opened) ||
          !DSHAgentWorkspaceStatMatches(parent, leaf, before, nullptr)) {
        if (existingDescriptor >= 0) close(existingDescriptor);
        close(parent);
        result = DSHAgentWorkspaceFailure(name, @"E_AGENT_CONFLICT", NO,
                                          blockError);
        return result != nil;
      }
    }
    NSString *temporaryName = [NSString stringWithFormat:@".rish-agent-%@-%@.tmp",
        [precondition[@"relative_path_sha256"] substringToIndex:16],
        [precondition[@"content_sha256"] substringToIndex:16]];
    int temporary = openat(parent, temporaryName.fileSystemRepresentation,
                           O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                           0600);
    BOOL durable = temporary >= 0 && DSHAgentWorkspaceWriteAll(temporary, content) &&
        fsync(temporary) == 0 && fchmod(temporary, 0600) == 0;
    if (temporary >= 0 && close(temporary) != 0) durable = NO;
    if (!durable) {
      unlinkat(parent, temporaryName.fileSystemRepresentation, 0);
      if (existingDescriptor >= 0) close(existingDescriptor);
      close(parent);
      result = DSHAgentWorkspaceFailure(name, @"E_AGENT_TOOL_FAILED", NO,
                                        blockError);
      return result != nil;
    }
    BOOL createOnly = [precondition[@"prior"][@"kind"]
        isEqualToString:@"absent"];
    BOOL installed = NO;
    if (createOnly) {
      installed = renameatx_np(parent, temporaryName.fileSystemRepresentation,
                               parent, leaf.fileSystemRepresentation,
                               RENAME_EXCL) == 0;
      if (!installed) {
        int renameError = errno;
        unlinkat(parent, temporaryName.fileSystemRepresentation, 0);
        if (existingDescriptor >= 0) close(existingDescriptor);
        close(parent);
        result = DSHAgentWorkspaceFailure(
            name, renameError == EEXIST ? @"E_AGENT_CONFLICT" : @"E_AGENT_TOOL_FAILED",
            NO, blockError);
        return result != nil;
      }
      durable = fsync(parent) == 0;
    } else {
      int replacementDescriptor = openat(
          parent, temporaryName.fileSystemRepresentation,
          O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      struct stat replacement = {};
      struct stat held = {};
      BOOL replacementValid = replacementDescriptor >= 0 &&
          fstat(replacementDescriptor, &replacement) == 0 &&
          S_ISREG(replacement.st_mode) && replacement.st_nlink == 1;
      BOOL preconditionStillHolds = replacementValid &&
          fstat(existingDescriptor, &held) == 0 &&
          DSHAgentWorkspaceSameFileState(before, held) &&
          DSHAgentWorkspaceStatMatches(parent, leaf, before, nullptr);
      installed = preconditionStillHolds &&
          renameatx_np(parent, temporaryName.fileSystemRepresentation,
                       parent, leaf.fileSystemRepresentation, RENAME_SWAP) == 0;
      struct stat installedState = {};
      struct stat backupState = {};
      BOOL verified = installed &&
          DSHAgentWorkspaceStatMatches(parent, leaf, replacement,
                                       &installedState) &&
          DSHAgentWorkspaceStatMatches(parent, temporaryName, before,
                                       &backupState);
      if (!installed || !verified) {
        if (!installed) unlinkat(parent, temporaryName.fileSystemRepresentation, 0);
        if (replacementDescriptor >= 0) close(replacementDescriptor);
        close(existingDescriptor);
        close(parent);
        result = DSHAgentWorkspaceFailure(
            name, preconditionStillHolds ? @"E_AGENT_TOOL_FAILED" : @"E_AGENT_CONFLICT",
            installed, blockError);
        return result != nil;
      }
      durable = fsync(parent) == 0;
      if (durable &&
          DSHAgentWorkspaceStatMatches(parent, temporaryName, before, nullptr)) {
        if (unlinkat(parent, temporaryName.fileSystemRepresentation, 0) != 0 ||
            fsync(parent) != 0) durable = NO;
      } else {
        durable = NO;
      }
      if (replacementDescriptor >= 0) close(replacementDescriptor);
    }
    if (existingDescriptor >= 0) close(existingDescriptor);
    struct stat after = {};
    BOOL observed = fstatat(parent, leaf.fileSystemRepresentation, &after,
                            AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(after.st_mode);
    close(parent);
    if (!durable || !observed) {
      result = DSHAgentWorkspaceFailure(
          name, @"E_AGENT_EXECUTION_AMBIGUOUS", YES, blockError);
      return result != nil;
    }
    NSString *revision = DSHAgentWorkspaceRevision(after);
    NSDictionary *object = @{
      @"schema_version" : @1, @"name" : name, @"outcome" : @"ok",
      @"payload" : @{
        @"schema_version" : @1, @"bytes" : @(content.length),
        @"revision" : revision,
      },
    };
    NSString *feedback = DSHAgentWorkspaceFeedback(object, blockError);
    if (feedback == nil) return NO;
    result = @{
      @"schema_version" : @1, @"status" : @"ok", @"feedback" : feedback,
      @"settled_facts" : @{
        @"schema_version" : @1, @"kind" : @"write_file",
        @"actual_revision" : revision,
        @"content_sha256" : precondition[@"content_sha256"],
      },
      @"truncated" : @NO, @"effect_may_have_occurred" : @YES,
    };
    return YES;
  } error:error];
  return succeeded ? result : nil;
}

- (NSDictionary *)recoverToolNamed:(NSString *)name
                          arguments:(NSDictionary *)arguments
                               root:(NSDictionary *)root
                       precondition:(NSDictionary *)precondition
                              error:(NSError **)error {
  if (![name isEqualToString:@"write_file"]) {
    // Read/list are safe to reproduce only after a fresh preflight proves the
    // exact same source revision/fingerprint.
    NSDictionary *fresh = [self prepareToolNamed:name arguments:arguments
                                             root:root error:error];
    if (fresh == nil) return nil;
    return @{
      @"schema_version" : @1,
      @"status" : [fresh[@"precondition"] isEqual:precondition]
          ? @"not_dispatched" : @"ambiguous",
    };
  }
  NSString *path = arguments[@"path"];
  NSArray *components = DSHAgentWorkspacePathComponents(path, NO);
  NSData *content = [arguments[@"content"] dataUsingEncoding:NSUTF8StringEncoding];
  if (components == nil || content == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *result = nil;
  if (![DSHAgentRootResolver validateAgentRootProjection:root error:error]) return nil;
  BOOL succeeded = [self.rootResolver performOperationForFrozenRoot:root
      mode:DSHAgentRootOperationModeWrite timeout:5.0
      block:^BOOL(int rootDescriptor, __unused git_repository *repository,
                  NSError **blockError) {
    (void)blockError;
    NSString *leaf = nil;
    int parent = DSHAgentWorkspaceOpenParent(rootDescriptor, components, &leaf);
    struct stat metadata = {};
    int statResult = parent < 0 ? -1 : fstatat(
        parent, leaf.fileSystemRepresentation, &metadata, AT_SYMLINK_NOFOLLOW);
    int lookupError = errno;
    if (statResult != 0 && lookupError == ENOENT &&
        [precondition[@"prior"][@"kind"] isEqualToString:@"absent"]) {
      struct stat recheck = {};
      BOOL stillAbsent = parent >= 0 &&
          fstatat(parent, leaf.fileSystemRepresentation, &recheck,
                  AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
      if (parent >= 0) close(parent);
      result = @{ @"schema_version" : @1,
                  @"status" : stillAbsent ? @"not_dispatched" : @"ambiguous" };
      return YES;
    }
    if (statResult != 0 || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
      if (parent >= 0) close(parent);
      result = @{ @"schema_version" : @1, @"status" : @"ambiguous" };
      return YES;
    }
    NSString *revision = DSHAgentWorkspaceRevision(metadata);
    if ([precondition[@"prior"][@"kind"] isEqualToString:@"known"] &&
        [precondition[@"prior"][@"revision"] isEqual:revision]) {
      int held = openat(parent, leaf.fileSystemRepresentation,
                        O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      struct stat opened = {};
      BOOL stable = held >= 0 && fstat(held, &opened) == 0 &&
          DSHAgentWorkspaceSameFileState(metadata, opened) &&
          opened.st_nlink == 1 &&
          DSHAgentWorkspaceStatMatches(parent, leaf, metadata, nullptr);
      if (held >= 0) close(held);
      close(parent);
      result = @{ @"schema_version" : @1,
                  @"status" : stable ? @"not_dispatched" : @"ambiguous" };
      return YES;
    }
    // Recovery reads at most the exact single-write bound and proves the same
    // inode/revision before and after. Oversized or unstable state is ambiguous.
    if (metadata.st_size < 0 ||
        metadata.st_size > (off_t)DSHAgentNativeWALMaxSingleWriteBytes ||
        (NSUInteger)metadata.st_size != content.length) {
      close(parent);
      result = @{ @"schema_version" : @1, @"status" : @"ambiguous" };
      return YES;
    }
    int descriptor = openat(parent, leaf.fileSystemRepresentation,
                            O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened = {};
    BOOL openedStable = descriptor >= 0 && fstat(descriptor, &opened) == 0 &&
        DSHAgentWorkspaceSameFileState(metadata, opened) && opened.st_nlink == 1 &&
        DSHAgentWorkspaceStatMatches(parent, leaf, metadata, nullptr);
    NSMutableData *actual = openedStable
        ? [NSMutableData dataWithLength:(NSUInteger)metadata.st_size] : nil;
    NSUInteger offset = 0;
    while (actual != nil && offset < actual.length) {
      ssize_t count = pread(descriptor,
          static_cast<uint8_t *>(actual.mutableBytes) + offset,
          actual.length - offset, (off_t)offset);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) break;
      offset += (NSUInteger)count;
    }
    struct stat after = {};
    BOOL finalStable = actual != nil && offset == actual.length &&
        fstat(descriptor, &after) == 0 &&
        DSHAgentWorkspaceSameFileState(opened, after) && after.st_nlink == 1 &&
        DSHAgentWorkspaceStatMatches(parent, leaf, metadata, nullptr);
    if (descriptor >= 0) close(descriptor);
    close(parent);
    NSString *actualSHA = finalStable
        ? DSHAgentHB(@"file-content", actual, blockError) : nil;
    result = @{ @"schema_version" : @1,
                @"status" : finalStable &&
                    [actualSHA isEqual:precondition[@"content_sha256"]]
                    ? @"settled" : @"ambiguous",
                @"actual_revision" : revision };
    return YES;
  } error:error];
  return succeeded ? result : nil;
}

@end
