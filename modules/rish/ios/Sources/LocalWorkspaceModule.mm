#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <CommonCrypto/CommonDigest.h>

#import "LocalProjectAccess.h"

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <time.h>
#include <unistd.h>

#include "rish.h"

static NSUInteger const LWMaxPathBytes = 1024;
static NSUInteger const LWMaxTextBytes = 1024 * 1024;
static NSUInteger const LWMaxListEntries = 1000;
static NSUInteger const LWMaxFoldResolutionEntries = 10000;
static NSUInteger const LWMaxTreeEntries = 10000;
static NSUInteger const LWMaxTreeDepth = 64;
static NSUInteger const LWMaxToolOutputBytes = 256 * 1024;
static NSUInteger const LWMaxToolResponseBytes = 8 * 1024 * 1024;

static NSError *LWError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"LocalWorkspace"
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSDictionary *LWDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSArray *LWArray(id value) {
  return [value isKindOfClass:NSArray.class] ? value : nil;
}

static NSString *LWString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static NSString *LWTimestamp(struct stat metadata) {
  NSTimeInterval seconds = metadata.st_mtimespec.tv_sec
    + metadata.st_mtimespec.tv_nsec / 1000000000.0;
  static NSISO8601DateFormatter *formatter = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime
      | NSISO8601DateFormatWithFractionalSeconds;
  });
  return [formatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:seconds]];
}

static NSString *LWRevision(struct stat metadata) {
  int64_t fields[] = {
    (int64_t)metadata.st_dev,
    (int64_t)metadata.st_ino,
    (int64_t)metadata.st_size,
    (int64_t)metadata.st_mtimespec.tv_sec,
    (int64_t)metadata.st_mtimespec.tv_nsec,
  };
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(fields, (CC_LONG)sizeof(fields), digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

static NSString *LWNow(void) {
  struct stat metadata = {};
  struct timespec now = {};
  clock_gettime(CLOCK_REALTIME, &now);
  metadata.st_mtimespec = now;
  return LWTimestamp(metadata);
}

static NSDictionary *LWFallbackMetadata(NSString *path, NSString *kind, NSUInteger size) {
  return @{
    @"path": path,
    @"name": path.lastPathComponent,
    @"kind": kind,
    @"size": @(size),
    @"modified_at": LWNow(),
  };
}

static BOOL LWWriteAll(int descriptor, NSData *data) {
  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  NSUInteger written = 0;
  while (written < data.length) {
    ssize_t amount = write(descriptor, bytes + written, data.length - written);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) return NO;
    written += (NSUInteger)amount;
  }
  return YES;
}

static NSData *LWDataFromByteArray(id value) {
  NSArray *values = LWArray(value);
  if (values == nil || values.count > LWMaxToolOutputBytes) return nil;
  NSMutableData *data = [NSMutableData dataWithCapacity:values.count];
  for (id item in values) {
    if (![item isKindOfClass:NSNumber.class]) return nil;
    NSInteger number = [item integerValue];
    if (number < 0 || number > UINT8_MAX) return nil;
    uint8_t byte = (uint8_t)number;
    [data appendBytes:&byte length:1];
  }
  return data;
}

static BOOL LWValidateDirectoryTree(int directoryDescriptor, NSUInteger depth, NSUInteger *count) {
  if (depth > LWMaxTreeDepth) return NO;
  int duplicate = openat(directoryDescriptor, ".",
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  DIR *directory = duplicate < 0 ? nullptr : fdopendir(duplicate);
  if (directory == nullptr) {
    if (duplicate >= 0) close(duplicate);
    return NO;
  }
  struct dirent *entry = nullptr;
  while (true) {
    errno = 0;
    entry = readdir(directory);
    if (entry == nullptr) break;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    *count += 1;
    if (*count > LWMaxTreeEntries) {
      closedir(directory);
      return NO;
    }
    struct stat metadata = {};
    if (fstatat(directoryDescriptor, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) != 0
      || S_ISLNK(metadata.st_mode) || (!S_ISREG(metadata.st_mode) && !S_ISDIR(metadata.st_mode))) {
      closedir(directory);
      return NO;
    }
    if (S_ISDIR(metadata.st_mode)) {
      int child = openat(directoryDescriptor, entry->d_name,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      BOOL valid = child >= 0 && LWValidateDirectoryTree(child, depth + 1, count);
      if (child >= 0) close(child);
      if (!valid) {
        closedir(directory);
        return NO;
      }
    }
  }
  BOOL valid = errno == 0;
  closedir(directory);
  return valid;
}

@interface LocalWorkspaceModule : NSObject <RCTBridgeModule>
@property(nonatomic, strong) dispatch_queue_t workspaceQueue;
@property(nonatomic, strong) DSHLocalProjectAccess *projectAccess;
@end

@implementation LocalWorkspaceModule

RCT_EXPORT_MODULE(LocalWorkspace)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _projectAccess = DSHLocalProjectAccess.sharedAccess;
    dispatch_queue_attr_t queueAttributes =
        dispatch_queue_attr_make_with_autorelease_frequency(
            DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM);
    _workspaceQueue = dispatch_queue_create(
      "dev.zseven.dsh.mobile.local-workspace",
      queueAttributes
    );
  }
  return self;
}

- (NSURL *)workspaceRoot:(NSError **)error {
  NSError *internalError = nil;
  NSURL *support = [[NSFileManager defaultManager]
    URLForDirectory:NSApplicationSupportDirectory
           inDomain:NSUserDomainMask
  appropriateForURL:nil
             create:YES
              error:&internalError];
  if (support == nil) {
    if (error != nil) *error = LWError(2001, @"Workspace storage is unavailable");
    return nil;
  }
  int supportDescriptor = open(support.fileSystemRepresentation,
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (supportDescriptor < 0) {
    if (error != nil) *error = LWError(2002, @"Workspace parent is unsafe");
    return nil;
  }

  NSURL *root = [support URLByAppendingPathComponent:@"workspace" isDirectory:YES];
  struct stat metadata = {};
  if (fstatat(supportDescriptor, "workspace", &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT || mkdirat(supportDescriptor, "workspace", 0700) != 0) {
      close(supportDescriptor);
      if (error != nil) *error = LWError(2003, @"Workspace cannot be created");
      return nil;
    }
    fsync(supportDescriptor);
  }
  int rootDescriptor = openat(supportDescriptor, "workspace",
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(supportDescriptor);
  if (rootDescriptor < 0) {
    if (error != nil) *error = LWError(2005, @"Workspace root is unsafe");
    return nil;
  }
  fchmod(rootDescriptor, 0700);
  close(rootDescriptor);
  return root;
}

- (NSArray<NSString *> *)componentsForPath:(id)value
                                  allowRoot:(BOOL)allowRoot
                                      error:(NSError **)error {
  NSString *path = LWString(value);
  if (path == nil || [path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > LWMaxPathBytes
    || [path hasPrefix:@"/"] || [path containsString:@"\\"]
    || [path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
    if (error != nil) *error = LWError(2006, @"Workspace path is invalid");
    return nil;
  }
  if (path.length == 0) {
    if (allowRoot) return @[];
    if (error != nil) *error = LWError(2007, @"Workspace root cannot be modified");
    return nil;
  }
  NSArray<NSString *> *components = [path componentsSeparatedByString:@"/"];
  for (NSString *component in components) {
    NSUInteger bytes = [component lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    NSString *folded = [DSHLocalProjectAccess filesystemFoldedComponent:component];
    if (bytes == 0 || bytes > NAME_MAX || [component isEqualToString:@"."]
      || [component isEqualToString:@".."] || [folded isEqualToString:@".trash"]
      || [folded isEqualToString:@".git"] || [folded hasPrefix:@".staging-"]) {
      if (error != nil) *error = LWError(2008, @"Workspace path contains a forbidden component");
      return nil;
    }
  }
  if (components.count > 0 &&
      [[DSHLocalProjectAccess filesystemFoldedComponent:components[0]]
          isEqual:@"projects"] &&
      ![components[0] isEqual:@"projects"]) {
    if (error != nil) *error = LWError(2008, @"Workspace path contains a forbidden alias");
    return nil;
  }
  if (components.count >= 3 && [components[0] isEqual:@"projects"] &&
      [DSHLocalProjectAccess isCanonicalProjectId:components[1]] &&
      ![components[2] isEqual:@"repo"]) {
    if (error != nil) *error = LWError(2008, @"Workspace project metadata is not a file workspace");
    return nil;
  }
  return components;
}

- (NSString *)resolvedOnDiskComponent:(NSString *)requested
                   directoryDescriptor:(int)directoryDescriptor
                           allowMissing:(BOOL)allowMissing
                                  error:(NSError **)error {
  const char *requestedBytes = requested.fileSystemRepresentation;
  if (directoryDescriptor < 0 || requestedBytes == nullptr) {
    if (error != nil) {
      *error = LWError(2044, @"Workspace directory path is unsafe");
    }
    return nil;
  }
  struct stat exactMetadata = {};
  if (fstatat(directoryDescriptor, requestedBytes, &exactMetadata,
              AT_SYMLINK_NOFOLLOW) == 0) {
    return requested;
  }
  if (errno != ENOENT) {
    if (error != nil) {
      *error = LWError(2044, @"Workspace directory path is unsafe");
    }
    return nil;
  }

  NSString *requestedFold =
      [DSHLocalProjectAccess filesystemFoldedComponent:requested];
  int duplicate = openat(directoryDescriptor, ".",
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  DIR *directory = duplicate < 0 ? nullptr : fdopendir(duplicate);
  if (directory == nullptr || requestedFold == nil) {
    if (duplicate >= 0 && directory == nullptr) close(duplicate);
    if (directory != nullptr) closedir(directory);
    if (error != nil) *error = LWError(2044, @"Workspace directory path is unsafe");
    return nil;
  }
  NSString *match = nil;
  NSUInteger entries = 0;
  struct dirent *entry = nullptr;
  int enumerationError = 0;
  while (YES) {
    errno = 0;
    entry = readdir(directory);
    if (entry == nullptr) {
      enumerationError = errno;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    entries += 1;
    if (entries > LWMaxFoldResolutionEntries) {
      closedir(directory);
      if (error != nil) *error = LWError(2044, @"Workspace directory path is unsafe");
      return nil;
    }
    NSString *candidate = [NSString stringWithUTF8String:entry->d_name];
    if (candidate == nil || ![[DSHLocalProjectAccess
        filesystemFoldedComponent:candidate] isEqual:requestedFold]) {
      continue;
    }
    if (match != nil && ![match isEqual:candidate]) {
      closedir(directory);
      if (error != nil) *error = LWError(2044, @"Workspace path is ambiguous");
      return nil;
    }
    match = candidate;
  }
  closedir(directory);
  if (enumerationError != 0) {
    if (error != nil) *error = LWError(2044, @"Workspace directory path is unsafe");
    return nil;
  }
  if (match != nil) return match;
  if (allowMissing) return requested;
  if (error != nil) *error = LWError(2044, @"Workspace directory path is unsafe");
  return nil;
}

- (int)openDirectoryComponents:(NSArray<NSString *> *)components
                       leaseSet:(DSHLocalProjectLeaseSet *)leaseSet
                          error:(NSError **)error {
  NSString *path = [components componentsJoinedByString:@"/"];
  NSString *projectId =
      [DSHLocalProjectAccess projectIdForWorkspacePath:path error:nil];
  DSHLocalProjectLease *lease = projectId == nil
      ? nil
      : [leaseSet leaseForProjectId:projectId];
  int descriptor = -1;
  NSUInteger startIndex = 0;
  if (projectId != nil) {
    if (lease == nil) {
      if (error != nil) *error = LWError(2043, @"Workspace project lease is unavailable");
      return -1;
    }
    if (![self.projectAccess validateLeaseIdentity:lease error:nil]) {
      if (error != nil) *error = LWError(2043, @"Workspace project changed during access");
      return -1;
    }
    if (components.count >= 3) {
      if (![components[2] isEqual:@"repo"]) {
        if (error != nil) *error = LWError(2043, @"Workspace project path is unavailable");
        return -1;
      }
      descriptor = dup(lease.repositoryDescriptor);
      startIndex = 3;
    } else {
      descriptor = dup(lease.projectDescriptor);
      startIndex = 2;
    }
  } else {
    NSURL *root = [self workspaceRoot:error];
    if (root == nil) return -1;
    descriptor = open(root.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  }
  if (descriptor < 0) {
    if (error != nil) *error = LWError(2043, @"Workspace root cannot be opened safely");
    return -1;
  }
  for (NSUInteger index = startIndex; index < components.count; index++) {
    NSString *component = [self resolvedOnDiskComponent:components[index]
                                     directoryDescriptor:descriptor
                                             allowMissing:NO
                                                    error:error];
    if (component == nil) {
      close(descriptor);
      return -1;
    }
    int next = openat(descriptor, component.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close(descriptor);
    if (next < 0) {
      if (error != nil) *error = LWError(2044, @"Workspace directory path is unsafe");
      return -1;
    }
    descriptor = next;
  }
  if (lease != nil &&
      ![self.projectAccess validateLeaseIdentity:lease error:nil]) {
    close(descriptor);
    if (error != nil) *error = LWError(2044, @"Workspace project changed during access");
    return -1;
  }
  return descriptor;
}

- (int)openParentDirectoryForPath:(id)value
                             name:(NSString **)name
                     relativePath:(NSString **)relativePath
                        leaseSet:(DSHLocalProjectLeaseSet *)leaseSet
                            error:(NSError **)error {
  NSArray<NSString *> *components = [self componentsForPath:value allowRoot:NO error:error];
  if (components == nil) return -1;
  if (components.count == 1 && [components[0] isEqual:@"projects"]) {
    if (error != nil) *error = LWError(2007, @"Workspace projects root cannot be modified");
    return -1;
  }
  NSString *path = [components componentsJoinedByString:@"/"];
  NSString *projectId = [DSHLocalProjectAccess projectIdForWorkspacePath:path
                                                                    error:nil];
  if (projectId != nil && components.count <= 3) {
    if (error != nil) *error = LWError(2007, @"Workspace project root cannot be modified");
    return -1;
  }
  NSArray<NSString *> *parents = [components subarrayWithRange:NSMakeRange(0, components.count - 1)];
  int descriptor = [self openDirectoryComponents:parents
                                         leaseSet:leaseSet
                                            error:error];
  if (descriptor < 0) return -1;
  NSString *resolvedName = [self resolvedOnDiskComponent:components.lastObject
                                      directoryDescriptor:descriptor
                                              allowMissing:YES
                                                     error:error];
  if (resolvedName == nil) {
    close(descriptor);
    return -1;
  }
  if (name != nil) *name = resolvedName;
  if (relativePath != nil) *relativePath = [components componentsJoinedByString:@"/"];
  return descriptor;
}

- (NSDictionary *)metadataForStat:(struct stat)metadata
                      relativePath:(NSString *)relativePath
                             error:(NSError **)error {
  NSString *kind = nil;
  if (S_ISREG(metadata.st_mode)) kind = @"file";
  if (S_ISDIR(metadata.st_mode)) kind = @"directory";
  if (kind == nil) {
    if (error != nil) *error = LWError(2014, @"Unsupported workspace entry type");
    return nil;
  }
  return @{
    @"path": relativePath,
    @"name": relativePath.length == 0 ? @"workspace" : relativePath.lastPathComponent,
    @"kind": kind,
    @"size": S_ISREG(metadata.st_mode) ? @(metadata.st_size) : @0,
    @"modified_at": LWTimestamp(metadata),
    @"revision": LWRevision(metadata),
  };
}

- (NSData *)readDataAtDirectoryDescriptor:(int)directoryDescriptor
                                      name:(NSString *)name
                              maximumBytes:(NSUInteger)maximum
                                  metadata:(struct stat *)metadataOut
                                     error:(NSError **)error {
  struct stat before = {};
  if (fstatat(directoryDescriptor, name.fileSystemRepresentation, &before, AT_SYMLINK_NOFOLLOW) != 0
    || !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode) || before.st_size < 0
    || (uint64_t)before.st_size > maximum) {
    if (error != nil) *error = LWError(2015, @"Workspace file is unavailable or too large");
    return nil;
  }
  int descriptor = openat(directoryDescriptor, name.fileSystemRepresentation,
    O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    if (error != nil) *error = LWError(2016, @"Workspace file cannot be opened safely");
    return nil;
  }
  struct stat opened = {};
  if (fstat(descriptor, &opened) != 0 || !S_ISREG(opened.st_mode)
    || opened.st_dev != before.st_dev || opened.st_ino != before.st_ino
    || opened.st_size != before.st_size || opened.st_size < 0
    || (uint64_t)opened.st_size > maximum) {
    close(descriptor);
    if (error != nil) *error = LWError(2017, @"Workspace file changed during validation");
    return nil;
  }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)opened.st_size];
  NSUInteger total = 0;
  while (total < data.length) {
    ssize_t amount = read(descriptor, static_cast<uint8_t *>(data.mutableBytes) + total, data.length - total);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) break;
    total += (NSUInteger)amount;
  }
  close(descriptor);
  if (total != data.length) {
    if (error != nil) *error = LWError(2018, @"Workspace file could not be read completely");
    return nil;
  }
  if (metadataOut != nullptr) *metadataOut = opened;
  return data;
}

- (BOOL)validateEntryTreeAtDirectoryDescriptor:(int)directoryDescriptor
                                           name:(NSString *)name
                                       metadata:(struct stat *)metadataOut
                                          error:(NSError **)error {
  struct stat metadata = {};
  if (fstatat(directoryDescriptor, name.fileSystemRepresentation,
      &metadata, AT_SYMLINK_NOFOLLOW) != 0 || S_ISLNK(metadata.st_mode)
    || (!S_ISREG(metadata.st_mode) && !S_ISDIR(metadata.st_mode))) {
    if (error != nil) *error = LWError(2022, @"Workspace tree contains an unsafe entry");
    return NO;
  }
  if (S_ISDIR(metadata.st_mode)) {
    int child = openat(directoryDescriptor, name.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    NSUInteger count = 0;
    BOOL valid = child >= 0 && LWValidateDirectoryTree(child, 0, &count);
    if (child >= 0) close(child);
    if (!valid) {
      if (error != nil) *error = LWError(2021, @"Workspace tree exceeds safety limits or is unsafe");
      return NO;
    }
  }
  if (metadataOut != nullptr) *metadataOut = metadata;
  return YES;
}

- (BOOL)atomicWriteData:(NSData *)data
     directoryDescriptor:(int)directoryDescriptor
                    name:(NSString *)name
              createOnly:(BOOL)createOnly
        expectedRevision:(NSString *)expectedRevision
                   error:(NSError **)error {
  struct stat existing = {};
  BOOL exists = fstatat(directoryDescriptor, name.fileSystemRepresentation,
    &existing, AT_SYMLINK_NOFOLLOW) == 0;
  if (exists && (S_ISLNK(existing.st_mode) || !S_ISREG(existing.st_mode))) {
    if (error != nil) *error = LWError(2023, @"Workspace write target is unsafe");
    return NO;
  }
  if (!exists && errno != ENOENT) {
    if (error != nil) *error = LWError(2024, @"Workspace write target cannot be checked");
    return NO;
  }
  if (createOnly && exists) {
    if (error != nil) *error = LWError(2025, @"Workspace file already exists");
    return NO;
  }
  if (exists && !createOnly) {
    if (expectedRevision.length != CC_SHA256_DIGEST_LENGTH * 2
      || ![LWRevision(existing) isEqualToString:expectedRevision]) {
      if (error != nil) *error = LWError(2040, @"Workspace file changed since it was read");
      return NO;
    }
  }
  NSString *temporaryName = [@".rish-write-" stringByAppendingString:NSUUID.UUID.UUIDString.lowercaseString];
  int descriptor = openat(directoryDescriptor, temporaryName.fileSystemRepresentation,
    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0) {
    if (error != nil) *error = LWError(2026, @"Workspace staging file cannot be created");
    return NO;
  }
  mode_t targetMode = exists ? (existing.st_mode & 0777) : 0600;
  BOOL written = fchmod(descriptor, targetMode) == 0
    && LWWriteAll(descriptor, data) && fsync(descriptor) == 0;
  close(descriptor);
  if (!written) {
    unlinkat(directoryDescriptor, temporaryName.fileSystemRepresentation, 0);
    if (error != nil) *error = LWError(2027, @"Workspace staging file could not be written");
    return NO;
  }
  int result = renameatx_np(directoryDescriptor, temporaryName.fileSystemRepresentation,
    directoryDescriptor, name.fileSystemRepresentation, createOnly ? RENAME_EXCL : 0);
  if (result != 0) {
    unlinkat(directoryDescriptor, temporaryName.fileSystemRepresentation, 0);
    if (error != nil) *error = LWError(2028, createOnly
      ? @"Workspace file was created concurrently"
      : @"Workspace file could not be replaced atomically");
    return NO;
  }
  fsync(directoryDescriptor);
  return YES;
}

- (int)openTrashDescriptor:(NSError **)error {
  NSURL *workspace = [self workspaceRoot:error];
  if (workspace == nil) return -1;
  int workspaceDescriptor = open(workspace.fileSystemRepresentation,
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (workspaceDescriptor < 0) {
    if (error != nil) *error = LWError(2029, @"Workspace trash cannot be opened");
    return -1;
  }
  struct stat metadata = {};
  if (fstatat(workspaceDescriptor, ".trash", &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT || mkdirat(workspaceDescriptor, ".trash", 0700) != 0) {
      close(workspaceDescriptor);
      if (error != nil) *error = LWError(2029, @"Workspace trash cannot be created");
      return -1;
    }
    fsync(workspaceDescriptor);
  }
  int trashDescriptor = openat(workspaceDescriptor, ".trash",
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(workspaceDescriptor);
  if (trashDescriptor < 0) {
    if (error != nil) *error = LWError(2030, @"Workspace trash is unsafe");
    return -1;
  }
  fchmod(trashDescriptor, 0700);
  return trashDescriptor;
}

- (NSDictionary *)trashReceiptAtRecordDescriptor:(int)recordDescriptor
                                          trashId:(NSString *)trashId
                                  payloadMetadata:(struct stat *)payloadMetadata
                                            error:(NSError **)error {
  NSData *metadataData = [self readDataAtDirectoryDescriptor:recordDescriptor
    name:@"metadata.json" maximumBytes:4096 metadata:nullptr error:error];
  NSDictionary *receipt = metadataData == nil ? nil : LWDictionary(
    [NSJSONSerialization JSONObjectWithData:metadataData options:0 error:nil]
  );
  NSString *originalPath = LWString(receipt[@"original_path"]);
  NSString *kind = LWString(receipt[@"kind"]);
  NSString *deletedAt = LWString(receipt[@"deleted_at"]);
  struct stat payload = {};
  BOOL validPayload = fstatat(recordDescriptor, "payload", &payload, AT_SYMLINK_NOFOLLOW) == 0
    && !S_ISLNK(payload.st_mode) && (S_ISREG(payload.st_mode) || S_ISDIR(payload.st_mode));
  BOOL validOriginal = [self componentsForPath:originalPath allowRoot:NO error:nil] != nil;
  BOOL validKind = [kind isEqualToString:@"file"] || [kind isEqualToString:@"directory"];
  BOOL kindMatchesPayload = ([kind isEqualToString:@"file"] && S_ISREG(payload.st_mode))
    || ([kind isEqualToString:@"directory"] && S_ISDIR(payload.st_mode));
  if (![receipt[@"schema_version"] isEqual:@1]
    || ![LWString(receipt[@"trash_id"]) isEqualToString:trashId]
    || !validOriginal || !validKind || !kindMatchesPayload
    || deletedAt.length == 0 || deletedAt.length > 64
    || !validPayload) {
    if (error != nil && *error == nil) *error = LWError(2042, @"Workspace trash receipt is invalid");
    return nil;
  }
  if (payloadMetadata != nullptr) *payloadMetadata = payload;
  return receipt;
}

- (NSArray<NSString *> *)argumentsForTool:(NSString *)tool
                                      path:(NSString *)path
                                   options:(id)value
                                     error:(NSError **)error {
  NSDictionary *options = value == nil || value == NSNull.null ? @{} : LWDictionary(value);
  if (options == nil) {
    if (error != nil) *error = LWError(2031, @"Portable tool options are invalid");
    return nil;
  }
  NSString *operand = [@"./" stringByAppendingString:path];
  if ([tool isEqualToString:@"cat"] || [tool isEqualToString:@"sha256sum"]) {
    if (options.count != 0) {
      if (error != nil) *error = LWError(2032, @"Portable tool options are unsupported");
      return nil;
    }
    return @[operand];
  }
  if ([tool isEqualToString:@"head"] || [tool isEqualToString:@"tail"]) {
    if (options.count > 1 || (options.count == 1 && options[@"lines"] == nil)) {
      if (error != nil) *error = LWError(2033, @"Portable line options are invalid");
      return nil;
    }
    NSNumber *lines = options[@"lines"] ?: @40;
    if (![lines isKindOfClass:NSNumber.class]) {
      if (error != nil) *error = LWError(2034, @"Portable line count is invalid");
      return nil;
    }
    NSInteger count = lines.integerValue;
    if (count < 1 || count > 1000
      || lines.doubleValue != count) {
      if (error != nil) *error = LWError(2034, @"Portable line count is invalid");
      return nil;
    }
    return @[@"-n", [NSString stringWithFormat:@"%ld", (long)count], operand];
  }
  if ([tool isEqualToString:@"wc"]) {
    if (options.count > 1 || (options.count == 1 && options[@"metric"] == nil)) {
      if (error != nil) *error = LWError(2035, @"Portable count options are invalid");
      return nil;
    }
    NSString *metric = options[@"metric"] == nil ? @"lines" : LWString(options[@"metric"]);
    NSDictionary *flags = @{@"lines": @"-l", @"words": @"-w", @"bytes": @"-c"};
    NSString *flag = flags[metric];
    if (flag == nil) {
      if (error != nil) *error = LWError(2036, @"Portable count metric is invalid");
      return nil;
    }
    return @[flag, operand];
  }
  if ([tool isEqualToString:@"grep"]) {
    NSSet *allowed = [NSSet setWithArray:@[@"pattern", @"case_insensitive"]];
    for (NSString *key in options) {
      if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
        if (error != nil) *error = LWError(2037, @"Portable search options are invalid");
        return nil;
      }
    }
    NSString *pattern = LWString(options[@"pattern"]);
    id insensitiveValue = options[@"case_insensitive"];
    if (pattern.length == 0 || [pattern lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 1024) {
      if (error != nil) *error = LWError(2038, @"Portable search pattern is invalid");
      return nil;
    }
    if (insensitiveValue != nil && ![insensitiveValue isKindOfClass:NSNumber.class]) {
      if (error != nil) *error = LWError(2037, @"Portable search options are invalid");
      return nil;
    }
    BOOL insensitive = [insensitiveValue boolValue];
    return insensitive
      ? @[@"-F", @"-i", @"-n", @"--", pattern, operand]
      : @[@"-F", @"-n", @"--", pattern, operand];
  }
  if (error != nil) *error = LWError(2039, @"Portable tool is not allowed");
  return nil;
}

RCT_REMAP_METHOD(capabilities,
                 capabilitiesWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    if ([self workspaceRoot:&error] == nil) {
      reject(@"workspace", error.localizedDescription, error);
      return;
    }
    resolve(@{
      @"schema_version": @1,
      @"root": @"workspace",
      @"max_text_bytes": @(LWMaxTextBytes),
      @"max_list_entries": @(LWMaxListEntries),
      @"max_tool_output_bytes": @(LWMaxToolOutputBytes),
      @"trash_recoverable": @YES,
      @"trash_listable": @YES,
      @"atomic_writes": @YES,
      @"symlinks_allowed": @NO,
      @"rish_protocol_version": @(rish_protocol_version()),
      @"portable_tools": @[@"cat", @"grep", @"head", @"tail", @"wc", @"sha256sum"],
    });
  });
}

RCT_REMAP_METHOD(listTrash,
                 listTrashWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    int trashDescriptor = [self openTrashDescriptor:&error];
    DIR *records = trashDescriptor < 0 ? nullptr : fdopendir(trashDescriptor);
    if (records == nullptr) {
      if (trashDescriptor >= 0 && records == nullptr) close(trashDescriptor);
      reject(@"workspace", error.localizedDescription ?: @"Workspace trash cannot be listed", error);
      return;
    }
    int activeTrashDescriptor = dirfd(records);
    if (activeTrashDescriptor < 0) {
      closedir(records);
      reject(@"workspace", @"Workspace trash cannot be listed", nil);
      return;
    }
    NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
    NSUInteger invalidCount = 0;
    NSUInteger count = 0;
    struct dirent *entry = nullptr;
    while (true) {
      errno = 0;
      entry = readdir(records);
      if (entry == nullptr) break;
      NSString *trashId = [NSString stringWithUTF8String:entry->d_name].lowercaseString;
      if ([trashId isEqualToString:@"."] || [trashId isEqualToString:@".."]) continue;
      count += 1;
      if (count > LWMaxListEntries) {
        closedir(records);
        reject(@"limit", @"Workspace trash contains too many records", nil);
        return;
      }
      NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:trashId];
      NSError *recordError = nil;
      int recordDescriptor = uuid == nil ? -1 : openat(activeTrashDescriptor, entry->d_name,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      NSDictionary *receipt = recordDescriptor < 0 ? nil
        : [self trashReceiptAtRecordDescriptor:recordDescriptor trashId:trashId
                               payloadMetadata:nullptr error:&recordError];
      if (receipt != nil && ![self validateEntryTreeAtDirectoryDescriptor:recordDescriptor
        name:@"payload" metadata:nullptr error:&recordError]) receipt = nil;
      if (recordDescriptor >= 0) close(recordDescriptor);
      if (receipt == nil) invalidCount += 1;
      else [entries addObject:receipt];
    }
    if (errno != 0) {
      closedir(records);
      reject(@"workspace", @"Workspace trash cannot be listed", nil);
      return;
    }
    closedir(records);
    [entries sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
      return [LWString(right[@"deleted_at"]) compare:LWString(left[@"deleted_at"])];
    }];
    resolve(@{@"entries": entries, @"invalid_record_count": @(invalidCount)});
  });
}

RCT_REMAP_METHOD(listDirectory,
                 listDirectoryPath:(NSString *)path
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    NSString *pathValue = LWString(path);
    NSArray<NSString *> *components = [self componentsForPath:pathValue allowRoot:YES error:&error];
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      components == nil ? nil : [self.projectAccess
        leaseWorkspaceReadPaths:@[pathValue ?: @""]
                      writePaths:@[] timeout:-1 error:&error];
    int directoryDescriptor = leases == nil ? -1
      : [self openDirectoryComponents:components leaseSet:leases error:&error];
    DIR *children = directoryDescriptor < 0 ? nullptr : fdopendir(directoryDescriptor);
    if (children == nullptr) {
      if (directoryDescriptor >= 0) close(directoryDescriptor);
      reject(@"workspace", @"Workspace directory cannot be listed", nil);
      return;
    }
    NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
    struct dirent *entry = nullptr;
    while (true) {
      errno = 0;
      entry = readdir(children);
      if (entry == nullptr) break;
      NSString *name = [NSString stringWithUTF8String:entry->d_name];
      if (name == nil || [name isEqualToString:@"."] || [name isEqualToString:@".."]) continue;
      if (pathValue.length == 0 && [name isEqualToString:@".trash"]) continue;
      if ([name isEqualToString:@".git"]) continue;
      NSString *listedProjectId =
        [DSHLocalProjectAccess projectIdForWorkspacePath:pathValue error:nil];
      if (listedProjectId != nil && components.count == 2 &&
          [name isEqualToString:@"project.json"]) continue;
      if (entries.count >= LWMaxListEntries) {
        closedir(children);
        reject(@"limit", @"Workspace directory contains too many entries", nil);
        return;
      }
      NSString *relative = pathValue.length == 0 ? name
        : [pathValue stringByAppendingFormat:@"/%@", name];
      struct stat metadataValue = {};
      BOOL safeName = [self componentsForPath:relative allowRoot:NO error:nil] != nil;
      BOOL safeEntry = fstatat(directoryDescriptor, name.fileSystemRepresentation,
        &metadataValue, AT_SYMLINK_NOFOLLOW) == 0 && !S_ISLNK(metadataValue.st_mode);
      NSDictionary *metadata = safeName && safeEntry
        ? [self metadataForStat:metadataValue relativePath:relative error:&error]
        : nil;
      if (metadata == nil) {
        closedir(children);
        reject(@"workspace", error.localizedDescription ?: @"Workspace directory contains an unsafe entry", error);
        return;
      }
      [entries addObject:metadata];
    }
    if (errno != 0) {
      closedir(children);
      reject(@"workspace", @"Workspace directory cannot be listed", nil);
      return;
    }
    closedir(children);
    [entries sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
      return [LWString(left[@"name"]) localizedStandardCompare:LWString(right[@"name"])];
    }];
    resolve(@{@"path": pathValue, @"entries": entries});
  });
}

RCT_REMAP_METHOD(readText,
                 readTextPath:(NSString *)path
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    NSString *pathValue = LWString(path);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      pathValue == nil ? nil : [self.projectAccess
        leaseWorkspaceReadPaths:@[pathValue]
                      writePaths:@[] timeout:-1 error:&error];
    NSString *name = nil;
    NSString *relative = nil;
    int parentDescriptor = leases == nil ? -1
      : [self openParentDirectoryForPath:path name:&name
                            relativePath:&relative leaseSet:leases error:&error];
    struct stat metadataValue = {};
    NSData *data = parentDescriptor < 0 ? nil : [self readDataAtDirectoryDescriptor:parentDescriptor
      name:name maximumBytes:LWMaxTextBytes metadata:&metadataValue error:&error];
    if (parentDescriptor >= 0) close(parentDescriptor);
    NSString *content = data == nil ? nil : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (content == nil) {
      reject(@"workspace", error.localizedDescription ?: @"Workspace file is not valid UTF-8 text", error);
      return;
    }
    NSDictionary *metadata = [self metadataForStat:metadataValue relativePath:relative error:&error];
    if (metadata == nil) {
      reject(@"workspace", error.localizedDescription, error);
      return;
    }
    resolve(@{@"file": metadata, @"content": content});
  });
}

RCT_REMAP_METHOD(writeText,
                 writeTextPath:(NSString *)path
                 content:(NSString *)content
                 createOnly:(BOOL)createOnly
                 expectedRevision:(id)expectedRevisionValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    if (![content isKindOfClass:NSString.class]) {
      reject(@"workspace", @"Workspace content must be text", nil);
      return;
    }
    NSData *data = [content dataUsingEncoding:NSUTF8StringEncoding];
    if (data == nil || data.length > LWMaxTextBytes) {
      reject(@"limit", @"Workspace text exceeds the size limit", nil);
      return;
    }
    NSString *pathValue = LWString(path);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      pathValue == nil ? nil : [self.projectAccess
        leaseWorkspaceReadPaths:@[] writePaths:@[pathValue]
                         timeout:-1 error:&error];
    NSString *name = nil;
    NSString *relative = nil;
    int parentDescriptor = leases == nil ? -1
      : [self openParentDirectoryForPath:path name:&name
                            relativePath:&relative leaseSet:leases error:&error];
    struct stat prior = {};
    BOOL existed = parentDescriptor >= 0 && fstatat(parentDescriptor, name.fileSystemRepresentation,
      &prior, AT_SYMLINK_NOFOLLOW) == 0;
    NSString *expectedRevision = expectedRevisionValue == nil
      || expectedRevisionValue == NSNull.null ? nil : LWString(expectedRevisionValue);
    if (expectedRevisionValue != nil && expectedRevisionValue != NSNull.null
      && expectedRevision == nil) {
      reject(@"workspace", @"Workspace revision is invalid", nil);
      if (parentDescriptor >= 0) close(parentDescriptor);
      return;
    }
    if (parentDescriptor < 0
      || ![self atomicWriteData:data directoryDescriptor:parentDescriptor name:name createOnly:createOnly
               expectedRevision:expectedRevision error:&error]) {
      reject(@"workspace", error.localizedDescription, error);
      if (parentDescriptor >= 0) close(parentDescriptor);
      return;
    }
    struct stat writtenMetadata = {};
    NSDictionary *metadata = fstatat(parentDescriptor, name.fileSystemRepresentation,
      &writtenMetadata, AT_SYMLINK_NOFOLLOW) == 0
      ? [self metadataForStat:writtenMetadata relativePath:relative error:&error]
      : nil;
    close(parentDescriptor);
    if (metadata == nil) metadata = LWFallbackMetadata(relative, @"file", data.length);
    resolve(@{@"file": metadata, @"created": @(!existed)});
  });
}

RCT_REMAP_METHOD(createDirectory,
                 createDirectoryPath:(NSString *)path
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    NSString *pathValue = LWString(path);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      pathValue == nil ? nil : [self.projectAccess
        leaseWorkspaceReadPaths:@[] writePaths:@[pathValue]
                         timeout:-1 error:&error];
    NSString *name = nil;
    NSString *relative = nil;
    int parentDescriptor = leases == nil ? -1
      : [self openParentDirectoryForPath:path name:&name
                            relativePath:&relative leaseSet:leases error:&error];
    if (parentDescriptor < 0 || mkdirat(parentDescriptor, name.fileSystemRepresentation, 0700) != 0) {
      reject(@"workspace", error.localizedDescription ?: @"Workspace directory cannot be created", error);
      if (parentDescriptor >= 0) close(parentDescriptor);
      return;
    }
    fsync(parentDescriptor);
    struct stat createdMetadata = {};
    NSDictionary *metadata = fstatat(parentDescriptor, name.fileSystemRepresentation,
      &createdMetadata, AT_SYMLINK_NOFOLLOW) == 0
      ? [self metadataForStat:createdMetadata relativePath:relative error:&error]
      : nil;
    close(parentDescriptor);
    if (metadata == nil) metadata = LWFallbackMetadata(relative, @"directory", 0);
    resolve(@{@"directory": metadata});
  });
}

RCT_REMAP_METHOD(renameEntry,
                 renameEntrySource:(NSString *)sourcePath
                 destination:(NSString *)destinationPath
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    NSString *sourceValue = LWString(sourcePath);
    NSString *destinationValue = LWString(destinationPath);
    if (sourceValue == nil || destinationValue == nil) {
      reject(@"workspace", @"Workspace rename paths are invalid", nil);
      return;
    }
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      [self.projectAccess leaseWorkspaceReadPaths:@[]
                                       writePaths:@[sourceValue, destinationValue]
                                          timeout:-1 error:&error];
    NSString *sourceName = nil;
    int sourceParentDescriptor = leases == nil ? -1
      : [self openParentDirectoryForPath:sourcePath name:&sourceName
                            relativePath:nil leaseSet:leases error:&error];
    NSString *destinationName = nil;
    NSString *destinationRelative = nil;
    int destinationParentDescriptor = leases == nil ? -1
      : [self openParentDirectoryForPath:destinationPath
        name:&destinationName relativePath:&destinationRelative
        leaseSet:leases error:&error];
    BOOL destinationInsideSource = [destinationValue hasPrefix:[sourceValue stringByAppendingString:@"/"]];
    struct stat sourceMetadata = {};
    BOOL sourceValid = sourceParentDescriptor >= 0
      && [self validateEntryTreeAtDirectoryDescriptor:sourceParentDescriptor
        name:sourceName metadata:&sourceMetadata error:&error];
    if (!sourceValid || destinationParentDescriptor < 0 || destinationInsideSource) {
      reject(@"workspace", error.localizedDescription ?: @"Workspace rename is invalid", error);
      if (sourceParentDescriptor >= 0) close(sourceParentDescriptor);
      if (destinationParentDescriptor >= 0) close(destinationParentDescriptor);
      return;
    }
    NSDictionary *metadata = [self metadataForStat:sourceMetadata
                                       relativePath:destinationRelative error:&error];
    if (metadata == nil) {
      reject(@"workspace", error.localizedDescription, error);
      close(sourceParentDescriptor);
      close(destinationParentDescriptor);
      return;
    }
    if (renameatx_np(sourceParentDescriptor, sourceName.fileSystemRepresentation,
      destinationParentDescriptor, destinationName.fileSystemRepresentation, RENAME_EXCL) != 0) {
      reject(@"workspace", @"Workspace destination already exists or cannot be renamed", nil);
      close(sourceParentDescriptor);
      close(destinationParentDescriptor);
      return;
    }
    fsync(sourceParentDescriptor);
    if (destinationParentDescriptor != sourceParentDescriptor) fsync(destinationParentDescriptor);
    close(sourceParentDescriptor);
    close(destinationParentDescriptor);
    resolve(@{@"entry": metadata, @"from": sourcePath});
  });
}

RCT_REMAP_METHOD(trashEntry,
                 trashEntryPath:(NSString *)path
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    NSString *pathValue = LWString(path);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      pathValue == nil ? nil : [self.projectAccess
        leaseWorkspaceReadPaths:@[] writePaths:@[pathValue]
                         timeout:-1 error:&error];
    NSString *sourceName = nil;
    NSString *sourceRelative = nil;
    int sourceParentDescriptor = leases == nil ? -1
      : [self openParentDirectoryForPath:path name:&sourceName
                            relativePath:&sourceRelative leaseSet:leases error:&error];
    struct stat sourceStat = {};
    BOOL sourceSafe = sourceParentDescriptor >= 0
      && [self validateEntryTreeAtDirectoryDescriptor:sourceParentDescriptor
        name:sourceName metadata:&sourceStat error:&error];
    NSDictionary *sourceMetadata = sourceSafe
      ? [self metadataForStat:sourceStat relativePath:sourceRelative error:&error]
      : nil;
    if (sourceMetadata == nil) {
      reject(@"workspace", error.localizedDescription, error);
      if (sourceParentDescriptor >= 0) close(sourceParentDescriptor);
      return;
    }
    int trashDescriptor = [self openTrashDescriptor:&error];
    NSString *trashId = NSUUID.UUID.UUIDString.lowercaseString;
    BOOL recordCreated = trashDescriptor >= 0
      && mkdirat(trashDescriptor, trashId.fileSystemRepresentation, 0700) == 0;
    int recordDescriptor = !recordCreated ? -1 : openat(trashDescriptor,
      trashId.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (recordDescriptor < 0) {
      reject(@"workspace", @"Workspace trash record cannot be created", nil);
      if (recordCreated) unlinkat(trashDescriptor, trashId.fileSystemRepresentation, AT_REMOVEDIR);
      if (trashDescriptor >= 0) close(trashDescriptor);
      close(sourceParentDescriptor);
      return;
    }
    NSString *deletedAt = LWNow();
    NSDictionary *receipt = @{
      @"schema_version": @1,
      @"trash_id": trashId,
      @"original_path": sourceRelative,
      @"kind": sourceMetadata[@"kind"],
      @"deleted_at": deletedAt,
    };
    NSData *receiptData = [NSJSONSerialization dataWithJSONObject:receipt
                                                          options:NSJSONWritingSortedKeys
                                                            error:nil];
    BOOL metadataWritten = [self atomicWriteData:receiptData
      directoryDescriptor:recordDescriptor name:@"metadata.json"
      createOnly:YES expectedRevision:nil error:&error];
    BOOL moved = metadataWritten && renameatx_np(sourceParentDescriptor,
      sourceName.fileSystemRepresentation, recordDescriptor, "payload", RENAME_EXCL) == 0;
    if (!moved) {
      unlinkat(recordDescriptor, "metadata.json", 0);
      close(recordDescriptor);
      unlinkat(trashDescriptor, trashId.fileSystemRepresentation, AT_REMOVEDIR);
      close(trashDescriptor);
      close(sourceParentDescriptor);
      reject(@"workspace", error.localizedDescription ?: @"Workspace entry could not be moved to trash", error);
      return;
    }
    fsync(sourceParentDescriptor);
    fsync(recordDescriptor);
    fsync(trashDescriptor);
    close(recordDescriptor);
    close(trashDescriptor);
    close(sourceParentDescriptor);
    resolve(receipt);
  });
}

RCT_REMAP_METHOD(restoreFromTrash,
                 restoreTrashId:(NSString *)trashId
                 destination:(id)destinationValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    NSString *trashIdValue = LWString(trashId);
    NSUUID *uuid = trashIdValue == nil ? nil : [[NSUUID alloc] initWithUUIDString:trashIdValue];
    if (uuid == nil || ![uuid.UUIDString.lowercaseString isEqualToString:trashIdValue]) {
      reject(@"workspace", @"Workspace trash ID is invalid", nil);
      return;
    }
    int trashDescriptor = [self openTrashDescriptor:&error];
    if (trashDescriptor < 0) {
      reject(@"workspace", error.localizedDescription, error);
      return;
    }
    int recordDescriptor = openat(trashDescriptor, trashIdValue.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat payloadStat = {};
    NSDictionary *receipt = recordDescriptor < 0 ? nil
      : [self trashReceiptAtRecordDescriptor:recordDescriptor trashId:trashIdValue
                             payloadMetadata:&payloadStat error:&error];
    NSString *originalPath = LWString(receipt[@"original_path"]);
    NSString *destinationPath = destinationValue == nil || destinationValue == NSNull.null
      ? originalPath
      : LWString(destinationValue);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      destinationPath == nil ? nil : [self.projectAccess
        leaseWorkspaceReadPaths:@[] writePaths:@[destinationPath]
                         timeout:-1 error:&error];
    NSString *destinationName = nil;
    NSString *destinationRelative = nil;
    int destinationParentDescriptor = receipt == nil || leases == nil ? -1
      : [self openParentDirectoryForPath:destinationPath name:&destinationName
                            relativePath:&destinationRelative leaseSet:leases error:&error];
    BOOL payloadTreeValid = receipt != nil
      && [self validateEntryTreeAtDirectoryDescriptor:recordDescriptor
        name:@"payload" metadata:&payloadStat error:&error];
    if (!payloadTreeValid || destinationParentDescriptor < 0) {
      reject(@"workspace", error.localizedDescription ?: @"Workspace trash record is invalid", error);
      if (destinationParentDescriptor >= 0) close(destinationParentDescriptor);
      if (recordDescriptor >= 0) close(recordDescriptor);
      close(trashDescriptor);
      return;
    }
    NSDictionary *metadata = [self metadataForStat:payloadStat
                                       relativePath:destinationRelative error:&error];
    if (metadata == nil) {
      reject(@"workspace", error.localizedDescription, error);
      close(destinationParentDescriptor);
      close(recordDescriptor);
      close(trashDescriptor);
      return;
    }
    if (renameatx_np(recordDescriptor, "payload", destinationParentDescriptor,
      destinationName.fileSystemRepresentation, RENAME_EXCL) != 0) {
      reject(@"workspace", @"Workspace restore destination already exists", nil);
      close(destinationParentDescriptor);
      close(recordDescriptor);
      close(trashDescriptor);
      return;
    }
    fsync(destinationParentDescriptor);
    unlinkat(recordDescriptor, "metadata.json", 0);
    fsync(recordDescriptor);
    close(destinationParentDescriptor);
    close(recordDescriptor);
    unlinkat(trashDescriptor, trashIdValue.fileSystemRepresentation, AT_REMOVEDIR);
    fsync(trashDescriptor);
    close(trashDescriptor);
    resolve(@{@"entry": metadata, @"trash_id": trashId, @"original_path": originalPath});
  });
}

RCT_REMAP_METHOD(executePortableTool,
                 executePortableToolName:(NSString *)tool
                 path:(NSString *)path
                 options:(id)options
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    NSString *pathValue = LWString(path);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLeaseSet *leases =
      pathValue == nil ? nil : [self.projectAccess
        leaseWorkspaceReadPaths:@[pathValue]
                      writePaths:@[] timeout:-1 error:&error];
    NSString *name = nil;
    NSString *relative = nil;
    int parentDescriptor = leases == nil ? -1
      : [self openParentDirectoryForPath:path name:&name
                            relativePath:&relative leaseSet:leases error:&error];
    NSData *textData = parentDescriptor < 0 ? nil : [self readDataAtDirectoryDescriptor:parentDescriptor
      name:name maximumBytes:LWMaxTextBytes metadata:nullptr error:&error];
    if (parentDescriptor >= 0) close(parentDescriptor);
    NSString *text = textData == nil ? nil : [[NSString alloc] initWithData:textData encoding:NSUTF8StringEncoding];
    NSArray<NSString *> *arguments = text == nil
      ? nil
      : [self argumentsForTool:tool path:relative options:options error:&error];
    NSURL *workspace = arguments == nil ? nil : [self workspaceRoot:&error];
    if (workspace == nil) {
      reject(@"workspace", error.localizedDescription ?: @"Portable tool input is invalid", error);
      return;
    }
    NSDictionary *request = @{
      @"protocol_version": @1,
      @"sandbox_root": workspace.path,
      @"read_only": @YES,
      @"user": @"rish-mobile",
      @"hostname": @"ios-workspace",
      @"limits": @{
        @"max_input_bytes": @(LWMaxTextBytes),
        @"max_output_bytes": @(LWMaxToolOutputBytes),
        @"max_filesystem_entries": @(LWMaxListEntries),
        @"max_recursion_depth": @16,
      },
      @"command": @{
        @"program": tool,
        @"args": arguments,
        @"env": @{},
        @"cwd": @"/",
        @"stdin": @[],
      },
    };
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:request options:0 error:nil];
    char *raw = rish_execute_applet_json(static_cast<const char *>(encoded.bytes), encoded.length);
    if (raw == nullptr) {
      reject(@"rish", @"Portable tool returned no receipt", nil);
      return;
    }
    size_t rawLength = strnlen(raw, LWMaxToolResponseBytes + 1);
    NSData *responseData = rawLength > LWMaxToolResponseBytes
      ? nil
      : [NSData dataWithBytes:raw length:rawLength];
    rish_string_free(raw);
    NSDictionary *response = responseData == nil ? nil : LWDictionary(
      [NSJSONSerialization JSONObjectWithData:responseData options:0 error:nil]
    );
    NSDictionary *outcome = LWDictionary(response[@"outcome"]);
    NSDictionary *executionPath = LWDictionary(outcome[@"path"]);
    NSData *stdoutData = LWDataFromByteArray(outcome[@"stdout"]);
    NSData *stderrData = LWDataFromByteArray(outcome[@"stderr"]);
    NSString *stdoutText = stdoutData == nil ? nil
      : [[NSString alloc] initWithData:stdoutData encoding:NSUTF8StringEncoding];
    NSString *stderrText = stderrData == nil ? nil
      : [[NSString alloc] initWithData:stderrData encoding:NSUTF8StringEncoding];
    NSNumber *okValue = [response[@"ok"] isKindOfClass:NSNumber.class] ? response[@"ok"] : nil;
    NSNumber *protocolValue = [response[@"protocol_version"] isKindOfClass:NSNumber.class]
      ? response[@"protocol_version"] : nil;
    NSNumber *exitValue = [outcome[@"exit_code"] isKindOfClass:NSNumber.class]
      ? outcome[@"exit_code"] : nil;
    NSString *pathKind = LWString(executionPath[@"kind"]);
    NSString *pathName = LWString(executionPath[@"name"]);
    NSInteger exitCode = exitValue.integerValue;
    BOOL expectedExit = exitCode == 0 || ([tool isEqualToString:@"grep"] && exitCode == 1);
    BOOL valid = okValue.boolValue
      && protocolValue.unsignedIntegerValue == rish_protocol_version()
      && [pathKind isEqualToString:@"portable_applet"]
      && [pathName isEqualToString:tool]
      && stdoutText != nil && stderrText != nil && expectedExit;
    if (!valid) {
      reject(@"rish", @"Portable tool receipt is invalid or execution failed", nil);
      return;
    }
    resolve(@{
      @"tool": tool,
      @"path": relative,
      @"exit_code": @(exitCode),
      @"stdout": stdoutText,
      @"stderr": stderrText,
      @"protocol_version": protocolValue,
      @"path_kind": pathKind,
    });
  });
}

@end
