#import "LocalProjectAccess.h"
#import "LocalProjectAccessInternals.h"

#import <CommonCrypto/CommonDigest.h>

#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <shared_mutex>

NSErrorDomain const DSHLocalProjectAccessErrorDomain =
    @"dev.zseven.rish.local-project-access";

static const NSUInteger DSHProjectMetadataMaxBytes = 64 * 1024;

static NSError *DSHAccessError(DSHLocalProjectAccessErrorCode code) {
  NSString *message = @"Project storage is unavailable.";
  switch (code) {
    case DSHLocalProjectAccessErrorInvalidIdentifier:
      message = @"Project identifier is invalid.";
      break;
    case DSHLocalProjectAccessErrorUnsafeStorage:
      message = @"Project storage is unsafe.";
      break;
    case DSHLocalProjectAccessErrorRepositoryUnavailable:
      message = @"Repository cannot be opened.";
      break;
    case DSHLocalProjectAccessErrorMetadataInvalid:
      message = @"Project metadata is invalid.";
      break;
    case DSHLocalProjectAccessErrorLockTimeout:
      message = @"Project access timed out.";
      break;
    case DSHLocalProjectAccessErrorRootAbsent:
    case DSHLocalProjectAccessErrorStorageUnavailable:
      break;
  }
  return [NSError errorWithDomain:DSHLocalProjectAccessErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

static void DSHSetAccessError(NSError **error,
                              DSHLocalProjectAccessErrorCode code) {
  if (error != nil) *error = DSHAccessError(code);
}

static BOOL DSHHasControlCharacter(NSString *value) {
  return [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet]
             .location != NSNotFound;
}

static BOOL DSHDictionaryHasExactKeys(NSDictionary *object,
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

static BOOL DSHSameNode(const struct stat &left, const struct stat &right);
static NSString *DSHFileSystemString(const char *path);

// Canonicalizes the trusted system symlink aliases (/var -> /private/var,
// /tmp -> /private/tmp, /etc -> /private/etc) so paths can be compared
// against the canonical container root.
static NSString *DSHApplyTrustedSystemAliases(NSString *path) {
  NSDictionary<NSString *, NSString *> *trustedSystemAliases = @{
    @"/var" : @"/private/var",
    @"/tmp" : @"/private/tmp",
    @"/etc" : @"/private/etc",
  };
  for (NSString *alias in trustedSystemAliases) {
    if ([path isEqual:alias] ||
        [path hasPrefix:[alias stringByAppendingString:@"/"]]) {
      return [trustedSystemAliases[alias]
          stringByAppendingString:[path substringFromIndex:alias.length]];
    }
  }
  return path;
}

static BOOL DSHIsCanonicalUUIDText(NSString *component) {
  if (component.length != 36) return NO;
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:component];
  return uuid != nil &&
      [uuid.UUIDString.lowercaseString isEqualToString:component.lowercaseString];
}

// True when components[index-3..index] read Containers/Data/Application/
// <UUID> — the shared tail of both container layouts:
//   device:    /private/var/mobile/Containers/Data/Application/<UUID>/...
//   simulator: <...>/CoreSimulator/Devices/<uuid>/data/Containers/Data/
//              Application/<uuid>/...
static BOOL DSHComponentsEndWithAppContainer(NSArray<NSString *> *components,
                                             NSUInteger index) {
  return index >= 3 && [components[index - 3] isEqual:@"Containers"] &&
      [components[index - 2] isEqual:@"Data"] &&
      [components[index - 1] isEqual:@"Application"] &&
      DSHIsCanonicalUUIDText(components[index]);
}

static NSUInteger DSHLastAppContainerComponentIndex(
    NSArray<NSString *> *components) {
  for (NSUInteger index = components.count; index > 0; index--) {
    NSUInteger candidate = index - 1;
    if (DSHComponentsEndWithAppContainer(components, candidate)) {
      return candidate;
    }
  }
  return NSNotFound;
}

static BOOL DSHComponentsHavePrefix(NSArray<NSString *> *components,
                                    NSArray<NSString *> *prefix) {
  if (prefix.count > components.count) return NO;
  for (NSUInteger index = 0; index < prefix.count; index++) {
    if (![components[index] isEqual:prefix[index]]) return NO;
  }
  return YES;
}

// Traversal components anywhere in the path are refused at derivation time
// (the strict walk also refuses them, but failing early keeps the anchor
// itself from ever being derived from a traversal-shaped path).
static BOOL DSHComponentsContainTraversal(NSArray<NSString *> *components) {
  for (NSString *component in components) {
    if ([component isEqual:@"."] || [component isEqual:@".."]) return YES;
  }
  return NO;
}

NSUInteger DSHContainerAnchorSegmentCountForPaths(NSString *targetPath,
                                                  NSString *containerRootPath) {
  if (![targetPath isKindOfClass:NSString.class] ||
      ![containerRootPath isKindOfClass:NSString.class]) {
    return NSNotFound;
  }
  NSArray<NSString *> *components = targetPath.pathComponents;
  NSArray<NSString *> *containerComponents = containerRootPath.pathComponents;
  NSUInteger rootIndex = DSHLastAppContainerComponentIndex(containerComponents);
  if (DSHComponentsContainTraversal(components) ||
      DSHComponentsContainTraversal(containerComponents) ||
      rootIndex == NSNotFound || rootIndex + 1 != containerComponents.count ||
      !DSHComponentsHavePrefix(components, containerComponents)) {
    return NSNotFound;
  }
  return rootIndex;
}

NSUInteger DSHContainerRootScanSegmentCount(NSString *path) {
  if (![path isKindOfClass:NSString.class]) return NSNotFound;
  NSArray<NSString *> *components = path.pathComponents;
  if (DSHComponentsContainTraversal(components)) return NSNotFound;
  return DSHLastAppContainerComponentIndex(components);
}

static int DSHOpenAnchoredAbsoluteDirectory(
    NSURL *url, DSHLocalProjectAccessHook hook, NSError **error) {
  if (![url isFileURL] || ![url.path hasPrefix:@"/"]) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return -1;
  }
  NSString *physicalPath = url.path;
  if (getenv("DSH_ANCHOR_TRACE") != nullptr) {
    NSLog(@"[anchor-trace] walking %@ (incoming error: %@)",
        physicalPath, error != nil && *error != nil
            ? (*error).localizedDescription : nil);
  }
  physicalPath = DSHApplyTrustedSystemAliases(physicalPath);
  NSArray<NSString *> *components = physicalPath.pathComponents;
  // Real-device sandboxes forbid openat() descent from "/" (EPERM outside
  // the container), so anchoring must start at the application container.
  // Everything up to and including the container root is opened through
  // realpath-verified absolute opens; only the container-relative tail is
  // strict-walked with O_NOFOLLOW.
  //
  // The container root is derived from the system API first:
  // NSHomeDirectory() names the app data container for both the device
  // layout /private/var/mobile/Containers/Data/Application/<UUID>/... and
  // the simulator layout <...>/CoreSimulator/Devices/<uuid>/data/
  // Containers/Data/Application/<uuid>/... . realpath() canonicalizes the
  // root where the sandbox permits it; on a real device realpath() fails on
  // the sandbox-external prefix, so the alias-rewritten home string is used
  // instead with the container shape as validation. Matching the container
  // shape inside the target itself is only a last-resort fallback for when
  // no root can be derived. A target outside the derived container is
  // refused outright: fail closed, no cross-container access.
  NSString *containerRootPath = nil;
  NSString *homePath = NSHomeDirectory();
  if (homePath.length > 0) {
    char resolvedHome[PATH_MAX] = {};
    if (realpath(homePath.fileSystemRepresentation, resolvedHome) != nullptr) {
      containerRootPath = DSHFileSystemString(resolvedHome);
    } else {
      NSString *physicalHome = DSHApplyTrustedSystemAliases(homePath);
      NSArray<NSString *> *homeComponents = physicalHome.pathComponents;
      NSUInteger homeRootIndex =
          DSHLastAppContainerComponentIndex(homeComponents);
      if (homeRootIndex != NSNotFound &&
          homeRootIndex + 1 == homeComponents.count) {
        containerRootPath = physicalHome;
      }
    }
  }
  NSUInteger containerSegments = NSNotFound;
  if (containerRootPath != nil) {
    containerSegments =
        DSHContainerAnchorSegmentCountForPaths(physicalPath, containerRootPath);
    if (containerSegments == NSNotFound) {
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
      return -1;
    }
  } else {
    containerSegments = DSHContainerRootScanSegmentCount(physicalPath);
    if (containerSegments == NSNotFound) {
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
      return -1;
    }
  }
  if (getenv("DSH_ANCHOR_TRACE") != nullptr) {
    NSLog(@"[anchor-trace] container root %@, anchoring after component %lu",
        containerRootPath ?: @"(derived from target)",
        (unsigned long)containerSegments);
  }

  // Phase 1: open the trusted prefix with one absolute open (no descent
  // from "/"), then verify it is the directory the path names.
  NSMutableArray<NSString *> *prefix =
      [NSMutableArray arrayWithObject:@"/"];
  [prefix addObjectsFromArray:
      [components subarrayWithRange:NSMakeRange(1, containerSegments)]];
  NSString *prefixPath = [NSString pathWithComponents:prefix];
  struct stat prefixStat = {};
  if (lstat(prefixPath.fileSystemRepresentation, &prefixStat) != 0 ||
      !S_ISDIR(prefixStat.st_mode)) {
    DSHSetAccessError(error, stat(prefixPath.fileSystemRepresentation,
        &prefixStat) != 0 && errno == ENOENT
        ? DSHLocalProjectAccessErrorRootAbsent
        : DSHLocalProjectAccessErrorUnsafeStorage);
    return -1;
  }
  int descriptor = open(prefixPath.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (descriptor < 0) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorStorageUnavailable);
    return -1;
  }
  struct stat prefixVerify = {};
  if (fstat(descriptor, &prefixVerify) != 0 ||
      prefixVerify.st_dev != prefixStat.st_dev ||
      prefixVerify.st_ino != prefixStat.st_ino) {
    close(descriptor);
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return -1;
  }

  // Phase 2: strict no-follow walk of the remaining tail.
  for (NSUInteger index = containerSegments + 1;
      index < components.count; index++) {
    NSString *component = components[index];
    if (component.length == 0 || [component isEqual:@"/"] ||
        [component isEqual:@"."] || [component isEqual:@".."]) {
      close(descriptor);
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
      return -1;
    }
    if (index + 1 == components.count && hook != nil) {
      hook(@"before_projects_root_final_open");
    }
    struct stat before = {};
    errno = 0;
    int statResult = fstatat(descriptor, component.fileSystemRepresentation,
                             &before, AT_SYMLINK_NOFOLLOW);
    int failure = statResult == 0 ? 0 : errno;
    int next = statResult == 0 && S_ISDIR(before.st_mode)
        ? openat(descriptor, component.fileSystemRepresentation,
                 O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        : -1;
    if (next < 0 && failure == 0 && statResult == 0 && S_ISDIR(before.st_mode)) {
      failure = errno;
    }
    struct stat opened = {};
    BOOL valid = next >= 0 && fstat(next, &opened) == 0 &&
                 DSHSameNode(before, opened);
    close(descriptor);
    if (!valid) {
      if (next >= 0) close(next);
      if (getenv("DSH_ANCHOR_TRACE") != nullptr) {
        NSLog(@"[anchor-trace] component '%@' FAILED stat=%d failure=%d "
              @"next=%d isdir=%d",
            component, statResult, failure, next, S_ISDIR(before.st_mode));
      }
      DSHSetAccessError(error, statResult != 0 && failure == ENOENT
          ? DSHLocalProjectAccessErrorRootAbsent
          : DSHLocalProjectAccessErrorUnsafeStorage);
      return -1;
    }
    descriptor = next;
  }
  return descriptor;
}

static int DSHOpenPrivateChildDirectory(int parentDescriptor,
                                        const char *name,
                                        BOOL create,
                                        NSError **error) {
  struct stat before = {};
  if (fstatat(parentDescriptor, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
    int statFailure = errno;
    if (!create || statFailure != ENOENT ||
        mkdirat(parentDescriptor, name, 0700) != 0 ||
        fsync(parentDescriptor) != 0 ||
        fstatat(parentDescriptor, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
      DSHSetAccessError(error, !create && statFailure == ENOENT
          ? DSHLocalProjectAccessErrorRootAbsent
          : (!create ? DSHLocalProjectAccessErrorUnsafeStorage
                     : DSHLocalProjectAccessErrorStorageUnavailable));
      return -1;
    }
  }
  if (!S_ISDIR(before.st_mode)) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return -1;
  }
  int child = openat(parentDescriptor, name,
                     O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat opened = {};
  BOOL valid = child >= 0 && fstat(child, &opened) == 0 &&
               DSHSameNode(before, opened);
  if (!valid) {
    if (child >= 0) close(child);
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return -1;
  }
  if (create && fchmod(child, 0700) != 0) {
    close(child);
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return -1;
  }
  return child;
}

static BOOL DSHSameNode(const struct stat &left, const struct stat &right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
         left.st_mode == right.st_mode;
}

static BOOL DSHForbiddenGitIndirectionAbsent(int gitDescriptor,
                                             int objectsDescriptor) {
  struct stat metadata = {};
  errno = 0;
  if (fstatat(gitDescriptor, "commondir", &metadata,
              AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    return NO;
  }
  int info = openat(objectsDescriptor, "info",
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (info < 0) return errno == ENOENT;
  BOOL safe = YES;
  const char *names[] = {"alternates", "http-alternates"};
  for (const char *name : names) {
    errno = 0;
    if (fstatat(info, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 ||
        errno != ENOENT) {
      safe = NO;
      break;
    }
  }
  close(info);
  return safe;
}

static void DSHEnsureLibgit2Lifetime(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    // Deliberately process-lifetime. Per-module init/shutdown pairs can race
    // while another native service still owns repository objects.
    git_libgit2_init();
  });
}

@interface DSHProjectRWLock : NSObject {
  std::shared_timed_mutex _lock;
}
- (BOOL)lockForMode:(DSHLocalProjectAccessMode)mode
             timeout:(NSTimeInterval)timeout;
- (void)unlockForMode:(DSHLocalProjectAccessMode)mode;
@end

@implementation DSHProjectRWLock
- (BOOL)lockForMode:(DSHLocalProjectAccessMode)mode
             timeout:(NSTimeInterval)timeout {
  if (timeout < 0) {
    if (mode == DSHLocalProjectAccessModeWrite) {
      _lock.lock();
    } else {
      _lock.lock_shared();
    }
    return YES;
  }
  std::chrono::duration<double> duration(timeout);
  if (mode == DSHLocalProjectAccessModeWrite) {
    return _lock.try_lock_for(duration);
  } else {
    return _lock.try_lock_shared_for(duration);
  }
}
- (void)unlockForMode:(DSHLocalProjectAccessMode)mode {
  if (mode == DSHLocalProjectAccessModeWrite) {
    _lock.unlock();
  } else {
    _lock.unlock_shared();
  }
}
@end

@interface DSHLocalProjectLockToken ()
@property(nonatomic, strong) DSHProjectRWLock *projectLock;
@property(nonatomic, copy) NSString *projectId;
@property(nonatomic) DSHLocalProjectAccessMode mode;
@property(nonatomic) BOOL acquired;
- (instancetype)initWithLock:(DSHProjectRWLock *)projectLock
                    projectId:(NSString *)projectId
                         mode:(DSHLocalProjectAccessMode)mode
                      timeout:(NSTimeInterval)timeout;
@end

@implementation DSHLocalProjectLockToken
- (instancetype)initWithLock:(DSHProjectRWLock *)projectLock
                    projectId:(NSString *)projectId
                         mode:(DSHLocalProjectAccessMode)mode
                      timeout:(NSTimeInterval)timeout {
  self = [super init];
  if (self) {
    _projectLock = projectLock;
    _projectId = [projectId copy];
    _mode = mode;
    _acquired = [_projectLock lockForMode:mode timeout:timeout];
  }
  return self;
}
- (void)dealloc {
  if (_acquired) {
    [_projectLock unlockForMode:_mode];
  }
}
@end

@interface DSHLocalProjectsRootLease ()
@property(nonatomic, strong, readwrite) NSURL *rootURL;
@property(nonatomic, readwrite) int descriptor;
@property(nonatomic, readwrite) dev_t device;
@property(nonatomic, readwrite) ino_t inode;
@end

@implementation DSHLocalProjectsRootLease
- (instancetype)init {
  self = [super init];
  if (self) _descriptor = -1;
  return self;
}
- (void)dealloc {
  if (_descriptor >= 0) close(_descriptor);
}
@end

@interface DSHLocalProjectLease ()
@property(nonatomic, copy, readwrite) NSString *projectId;
@property(nonatomic, strong, readwrite) NSURL *projectDirectoryURL;
@property(nonatomic, strong, readwrite) NSURL *repositoryURL;
@property(nonatomic, copy, readwrite, nullable) NSDictionary *metadata;
@property(nonatomic, readwrite) int projectsRootDescriptor;
@property(nonatomic, readwrite) int projectDescriptor;
@property(nonatomic, readwrite) int repositoryDescriptor;
@property(nonatomic, readwrite) int gitDescriptor;
@property(nonatomic, readwrite) int objectsDescriptor;
@property(nonatomic, readwrite) dev_t projectsRootDevice;
@property(nonatomic, readwrite) ino_t projectsRootInode;
@property(nonatomic, readwrite) dev_t projectDevice;
@property(nonatomic, readwrite) ino_t projectInode;
@property(nonatomic, readwrite) dev_t repositoryDevice;
@property(nonatomic, readwrite) ino_t repositoryInode;
@property(nonatomic, readwrite) dev_t gitDevice;
@property(nonatomic, readwrite) ino_t gitInode;
@property(nonatomic, readwrite) dev_t objectsDevice;
@property(nonatomic, readwrite) ino_t objectsInode;
@property(nonatomic, readwrite) git_repository *repository;
@property(nonatomic, readwrite) DSHLocalProjectAccessMode accessMode;
@property(nonatomic, strong) DSHLocalProjectLockToken *lockToken;
@end

@implementation DSHLocalProjectLease
- (instancetype)init {
  self = [super init];
  if (self) {
    _projectsRootDescriptor = -1;
    _projectDescriptor = -1;
    _repositoryDescriptor = -1;
    _gitDescriptor = -1;
    _objectsDescriptor = -1;
    _repository = nullptr;
  }
  return self;
}
- (void)dealloc {
  if (_repository != nullptr) git_repository_free(_repository);
  if (_objectsDescriptor >= 0) close(_objectsDescriptor);
  if (_gitDescriptor >= 0) close(_gitDescriptor);
  if (_repositoryDescriptor >= 0) close(_repositoryDescriptor);
  if (_projectDescriptor >= 0) close(_projectDescriptor);
  if (_projectsRootDescriptor >= 0) close(_projectsRootDescriptor);
  _lockToken = nil;
}
@end

@interface DSHLocalProjectLeaseSet ()
@property(nonatomic, copy) NSDictionary<NSString *, DSHLocalProjectLease *> *leases;
@end

@implementation DSHLocalProjectLeaseSet
- (DSHLocalProjectLease *)leaseForProjectId:(NSString *)projectId {
  return self.leases[projectId];
}
@end

@interface DSHLocalProjectAccess ()
@property(nonatomic, strong, nullable) NSURL *injectedProjectsRootURL;
@property(nonatomic, copy, nullable) DSHLocalProjectAccessHook hook;
- (nullable NSURL *)resolvedProjectsRootCreatingIfNeeded:(BOOL)create
                                               descriptor:(nullable int *)descriptorOut
                                                    error:(NSError **)error;
@end

@implementation DSHLocalProjectAccess

+ (instancetype)sharedAccess {
  static DSHLocalProjectAccess *access;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    access = [[DSHLocalProjectAccess alloc] initWithProjectsRootURL:nil];
  });
  return access;
}

+ (BOOL)isCanonicalProjectId:(NSString *)projectId {
  if (![projectId isKindOfClass:NSString.class] || projectId.length != 36 ||
      DSHHasControlCharacter(projectId)) {
    return NO;
  }
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:projectId];
  return uuid != nil &&
         [uuid.UUIDString.lowercaseString isEqualToString:projectId];
}

+ (NSString *)filesystemFoldedComponent:(NSString *)component {
  if (![component isKindOfClass:NSString.class] || component.length == 0) {
    return nil;
  }
  NSString *nfc = component.precomposedStringWithCanonicalMapping;
  NSMutableString *folded = [nfc mutableCopy];
  CFStringFold((__bridge CFMutableStringRef)folded,
               kCFCompareCaseInsensitive | kCFCompareWidthInsensitive,
               NULL);
  return folded.precomposedStringWithCanonicalMapping;
}

+ (NSString *)projectIdForWorkspacePath:(NSString *)path
                                   error:(NSError **)error {
  if (![path isKindOfClass:NSString.class] || path.length > 4096 ||
      [path hasPrefix:@"/"] || [path containsString:@"\\"] ||
      DSHHasControlCharacter(path)) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  NSArray<NSString *> *components = [path componentsSeparatedByString:@"/"];
  NSString *rootComponent = components.firstObject;
  NSString *foldedRoot = [self filesystemFoldedComponent:rootComponent];
  if ([foldedRoot isEqual:@"projects"] &&
      ![rootComponent isEqual:@"projects"]) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  if (components.count == 0 || ![rootComponent isEqual:@"projects"] ||
      components.count == 1) {
    return nil;
  }
  NSString *projectId = components[1];
  if (![self isCanonicalProjectId:projectId]) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  return projectId;
}

- (instancetype)init {
  return [self initWithProjectsRootURL:nil hook:nil];
}

- (instancetype)initWithProjectsRootURL:(NSURL *)projectsRootURL {
  return [self initWithProjectsRootURL:projectsRootURL hook:nil];
}

- (instancetype)initWithProjectsRootURL:(NSURL *)projectsRootURL
                                   hook:(DSHLocalProjectAccessHook)hook {
  self = [super init];
  if (self) {
    DSHEnsureLibgit2Lifetime();
    _injectedProjectsRootURL = [projectsRootURL copy];
    _hook = [hook copy];
  }
  return self;
}

static DSHProjectRWLock *DSHLockForProjectId(NSString *projectId) {
  static NSMutableDictionary<NSString *, DSHProjectRWLock *> *locks;
  static NSLock *guard;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    locks = [NSMutableDictionary dictionary];
    guard = [[NSLock alloc] init];
  });
  [guard lock];
  DSHProjectRWLock *lock = locks[projectId];
  if (lock == nil) {
    lock = [[DSHProjectRWLock alloc] init];
    locks[projectId] = lock;
  }
  [guard unlock];
  return lock;
}

- (NSURL *)projectsRootURLWithError:(NSError **)error {
  return [self resolvedProjectsRootCreatingIfNeeded:NO
                                         descriptor:nil error:error];
}

- (NSURL *)projectsRootURLCreatingIfNeeded:(BOOL)create
                                      error:(NSError **)error {
  return [self resolvedProjectsRootCreatingIfNeeded:create
                                         descriptor:nil error:error];
}

- (DSHLocalProjectsRootLease *)
    leaseProjectsRootCreatingIfNeeded:(BOOL)create
                                 error:(NSError **)error {
  int descriptor = -1;
  NSURL *rootURL = [self resolvedProjectsRootCreatingIfNeeded:create
                                                    descriptor:&descriptor
                                                         error:error];
  struct stat metadata = {};
  if (rootURL == nil || descriptor < 0 || fstat(descriptor, &metadata) != 0 ||
      !S_ISDIR(metadata.st_mode)) {
    if (descriptor >= 0) close(descriptor);
    if (error != nil && *error == nil) {
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    }
    return nil;
  }
  DSHLocalProjectsRootLease *lease =
      [[DSHLocalProjectsRootLease alloc] init];
  lease.rootURL = rootURL;
  lease.descriptor = descriptor;
  lease.device = metadata.st_dev;
  lease.inode = metadata.st_ino;
  return lease;
}

- (BOOL)validateProjectsRootLease:(DSHLocalProjectsRootLease *)lease
                             error:(NSError **)error {
  if (lease == nil || lease.descriptor < 0) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return NO;
  }
  struct stat retained = {};
  int currentDescriptor = -1;
  NSURL *currentURL = [self resolvedProjectsRootCreatingIfNeeded:NO
                                                       descriptor:&currentDescriptor
                                                            error:error];
  struct stat current = {};
  BOOL valid = currentURL != nil && currentDescriptor >= 0 &&
      fstat(lease.descriptor, &retained) == 0 &&
      fstat(currentDescriptor, &current) == 0 &&
      retained.st_dev == lease.device && retained.st_ino == lease.inode &&
      DSHSameNode(retained, current) && S_ISDIR(retained.st_mode);
  if (currentDescriptor >= 0) close(currentDescriptor);
  if (!valid) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
  }
  return valid;
}

- (NSURL *)resolvedProjectsRootCreatingIfNeeded:(BOOL)create
                                      descriptor:(int *)descriptorOut
                                           error:(NSError **)error {
  if (descriptorOut != nullptr) *descriptorOut = -1;
  NSURL *projects = self.injectedProjectsRootURL;
  int projectsDescriptor = -1;
  if (projects != nil) {
    // Injected roots are test/application-owned existing roots. Bootstrap is
    // deliberately unavailable because no trusted parent capability was
    // supplied with the URL.
    projectsDescriptor = DSHOpenAnchoredAbsoluteDirectory(
        projects, self.hook, error);
  } else {
    NSError *internalError = nil;
    NSURL *support = [[NSFileManager defaultManager]
        URLForDirectory:NSApplicationSupportDirectory
               inDomain:NSUserDomainMask
      appropriateForURL:nil
                 create:NO
                  error:&internalError];
    NSError *supportAccessError = nil;
    int supportDescriptor = support == nil ? -1 :
        DSHOpenAnchoredAbsoluteDirectory(support, nil, &supportAccessError);
    if (supportDescriptor < 0 && create) {
      NSURL *home = [NSURL fileURLWithPath:NSHomeDirectory()
                                isDirectory:YES];
      int homeDescriptor = DSHOpenAnchoredAbsoluteDirectory(home, nil, nil);
      int libraryDescriptor = homeDescriptor < 0 ? -1 :
          DSHOpenPrivateChildDirectory(homeDescriptor, "Library", YES, nil);
      supportDescriptor = libraryDescriptor < 0 ? -1 :
          DSHOpenPrivateChildDirectory(libraryDescriptor,
                                       "Application Support", YES, nil);
      if (libraryDescriptor >= 0) close(libraryDescriptor);
      if (homeDescriptor >= 0) close(homeDescriptor);
      support = [[home URLByAppendingPathComponent:@"Library" isDirectory:YES]
          URLByAppendingPathComponent:@"Application Support" isDirectory:YES];
    }
    if (supportDescriptor < 0) {
      if (error != nil && *error == nil) {
        *error = supportAccessError ?: DSHAccessError(
            DSHLocalProjectAccessErrorStorageUnavailable);
      }
      return nil;
    }
    int workspaceDescriptor = DSHOpenPrivateChildDirectory(
        supportDescriptor, "workspace", create, error);
    if (workspaceDescriptor >= 0 && self.hook != nil) {
      self.hook(@"before_projects_root_final_open");
    }
    projectsDescriptor = workspaceDescriptor < 0 ? -1 :
        DSHOpenPrivateChildDirectory(workspaceDescriptor, "projects", create,
                                     error);
    if (workspaceDescriptor >= 0) close(workspaceDescriptor);
    close(supportDescriptor);
    projects = [[support URLByAppendingPathComponent:@"workspace" isDirectory:YES]
        URLByAppendingPathComponent:@"projects" isDirectory:YES];
  }
  if (projectsDescriptor < 0) return nil;
  if (create) {
    struct stat retainedBefore = {};
    int visibleBeforeDescriptor = DSHOpenAnchoredAbsoluteDirectory(
        projects, nil, nil);
    struct stat visibleBefore = {};
    BOOL visibleBeforeBound = fstat(projectsDescriptor, &retainedBefore) == 0 &&
        visibleBeforeDescriptor >= 0 &&
        fstat(visibleBeforeDescriptor, &visibleBefore) == 0 &&
        DSHSameNode(retainedBefore, visibleBefore);
    if (visibleBeforeDescriptor >= 0) close(visibleBeforeDescriptor);
    if (!visibleBeforeBound) {
      close(projectsDescriptor);
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
      return nil;
    }
    NSError *attributeError = nil;
    BOOL backupExcluded = [projects setResourceValue:@YES
                                               forKey:NSURLIsExcludedFromBackupKey
                                                error:&attributeError];
    BOOL attributesApplied = [[NSFileManager defaultManager]
        setAttributes:@{
          NSFilePosixPermissions : @0700,
          NSFileProtectionKey :
              NSFileProtectionCompleteUntilFirstUserAuthentication,
        }
         ofItemAtPath:projects.path
                error:&attributeError];
    if (!backupExcluded || !attributesApplied) {
      close(projectsDescriptor);
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
      return nil;
    }
    int visibleAfterDescriptor = DSHOpenAnchoredAbsoluteDirectory(
        projects, nil, nil);
    struct stat retainedAfter = {};
    struct stat visibleAfter = {};
    BOOL visibleAfterBound = fstat(projectsDescriptor, &retainedAfter) == 0 &&
        visibleAfterDescriptor >= 0 &&
        fstat(visibleAfterDescriptor, &visibleAfter) == 0 &&
        DSHSameNode(retainedBefore, retainedAfter) &&
        DSHSameNode(retainedAfter, visibleAfter);
    if (visibleAfterDescriptor >= 0) close(visibleAfterDescriptor);
    if (!visibleAfterBound) {
      close(projectsDescriptor);
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
      return nil;
    }
  }
  if (descriptorOut != nullptr) {
    *descriptorOut = projectsDescriptor;
  } else {
    close(projectsDescriptor);
  }
  return projects;
}

- (NSURL *)projectDirectoryURLForId:(NSString *)projectId
                               error:(NSError **)error {
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId]) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  DSHLocalProjectsRootLease *rootLease =
      [self leaseProjectsRootCreatingIfNeeded:NO error:error];
  if (rootLease == nil) return nil;
  struct stat before = {};
  int descriptor = fstatat(rootLease.descriptor, projectId.UTF8String, &before,
                           AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(before.st_mode)
      ? openat(rootLease.descriptor, projectId.UTF8String,
               O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      : -1;
  struct stat opened = {};
  BOOL valid = descriptor >= 0 && fstat(descriptor, &opened) == 0 &&
               DSHSameNode(before, opened);
  if (descriptor >= 0) close(descriptor);
  if (!valid) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorStorageUnavailable);
    return nil;
  }
  return [rootLease.rootURL URLByAppendingPathComponent:projectId
                                             isDirectory:YES];
}

- (DSHLocalProjectLockToken *)lockProjectId:(NSString *)projectId
                                       mode:(DSHLocalProjectAccessMode)mode
                                      error:(NSError **)error {
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId] ||
      (mode != DSHLocalProjectAccessModeRead &&
       mode != DSHLocalProjectAccessModeWrite)) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  return [[DSHLocalProjectLockToken alloc]
      initWithLock:DSHLockForProjectId(projectId)
         projectId:projectId
              mode:mode
           timeout:-1];
}

- (DSHLocalProjectLockToken *)tryLockProjectIdForWrite:(NSString *)projectId
                                                  error:(NSError **)error {
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId]) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  DSHLocalProjectLockToken *token = [[DSHLocalProjectLockToken alloc]
      initWithLock:DSHLockForProjectId(projectId)
         projectId:projectId
              mode:DSHLocalProjectAccessModeWrite
           timeout:0];
  if (!token.acquired) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorLockTimeout);
    return nil;
  }
  return token;
}

static NSDictionary *DSHReadMetadata(int projectDescriptor,
                                     dev_t projectDevice,
                                     NSString *projectId,
                                     NSString **digestOut,
                                     NSError **error) {
  int descriptor = openat(projectDescriptor, "project.json",
                          O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorMetadataInvalid);
    return nil;
  }
  struct stat metadata = {};
  BOOL valid = fstat(descriptor, &metadata) == 0 &&
               S_ISREG(metadata.st_mode) && metadata.st_nlink == 1 &&
               metadata.st_dev == projectDevice &&
               metadata.st_size >= 2 &&
               metadata.st_size <= (off_t)DSHProjectMetadataMaxBytes;
  NSMutableData *data = valid
                            ? [NSMutableData dataWithLength:(NSUInteger)metadata.st_size]
                            : nil;
  ssize_t offset = 0;
  while (valid && offset < metadata.st_size) {
    ssize_t count = pread(descriptor,
                          static_cast<uint8_t *>(data.mutableBytes) + offset,
                          (size_t)(metadata.st_size - offset), offset);
    if (count <= 0) {
      valid = NO;
      break;
    }
    offset += count;
  }
  struct stat after = {};
  valid = valid && fstat(descriptor, &after) == 0 &&
          metadata.st_dev == after.st_dev && metadata.st_ino == after.st_ino &&
          metadata.st_mode == after.st_mode &&
          metadata.st_size == after.st_size && metadata.st_nlink == after.st_nlink &&
          metadata.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
          metadata.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
          metadata.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec &&
          metadata.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
  struct stat pathAfter = {};
  valid = valid &&
          fstatat(projectDescriptor, "project.json", &pathAfter,
                  AT_SYMLINK_NOFOLLOW) == 0 &&
          metadata.st_dev == pathAfter.st_dev &&
          metadata.st_ino == pathAfter.st_ino &&
          metadata.st_mode == pathAfter.st_mode &&
          metadata.st_size == pathAfter.st_size &&
          metadata.st_nlink == pathAfter.st_nlink &&
          metadata.st_mtimespec.tv_sec == pathAfter.st_mtimespec.tv_sec &&
          metadata.st_mtimespec.tv_nsec == pathAfter.st_mtimespec.tv_nsec &&
          metadata.st_ctimespec.tv_sec == pathAfter.st_ctimespec.tv_sec &&
          metadata.st_ctimespec.tv_nsec == pathAfter.st_ctimespec.tv_nsec;
  close(descriptor);
  NSDictionary *object = valid
                             ? [NSJSONSerialization JSONObjectWithData:data
                                                               options:0
                                                                 error:nil]
                             : nil;
  if (![object isKindOfClass:NSDictionary.class]) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorMetadataInvalid);
    return nil;
  }
  NSString *name = [object[@"name"] isKindOfClass:NSString.class]
                       ? object[@"name"]
                       : nil;
  NSString *created = [object[@"created_at"] isKindOfClass:NSString.class]
                          ? object[@"created_at"]
                          : nil;
  NSString *updated = [object[@"updated_at"] isKindOfClass:NSString.class]
                          ? object[@"updated_at"]
                          : nil;
  id origin = object[@"origin_url"];
  BOOL originValid = origin == nil || origin == NSNull.null ||
                     [origin isKindOfClass:NSString.class];
  NSUInteger nameBytes = [name lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  if (!DSHDictionaryHasExactKeys(object, @[
        @"schema_version", @"name", @"created_at", @"updated_at",
        @"origin_url"
      ]) ||
      ![object[@"schema_version"] isEqual:@1] || nameBytes == 0 ||
      nameBytes > 120 || DSHHasControlCharacter(name) ||
      [name containsString:@"/"] || [name containsString:@"\\"] ||
      created.length < 20 || created.length > 64 || updated.length < 20 ||
      updated.length > 64 || DSHHasControlCharacter(created) ||
      DSHHasControlCharacter(updated) || !originValid) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorMetadataInvalid);
    return nil;
  }
  if (digestOut != nullptr) {
    uint8_t digest[CC_SHA256_DIGEST_LENGTH] = {};
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString
        stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
      [hex appendFormat:@"%02x", digest[index]];
    }
    *digestOut = hex;
  }
  return @{
    @"schema_version" : @1,
    @"id" : projectId,
    @"name" : name,
    @"workspace_path" :
        [NSString stringWithFormat:@"projects/%@/repo", projectId],
    @"created_at" : created,
    @"updated_at" : updated,
    @"origin_url" : origin ?: NSNull.null,
  };
}

static BOOL DSHValidStoredMetadataRecord(NSDictionary *record) {
  if (!DSHDictionaryHasExactKeys(record, @[
        @"schema_version", @"name", @"created_at", @"updated_at",
        @"origin_url"
      ]) || ![record[@"schema_version"] isEqual:@1]) {
    return NO;
  }
  NSString *name = [record[@"name"] isKindOfClass:NSString.class]
      ? record[@"name"] : nil;
  NSString *created = [record[@"created_at"] isKindOfClass:NSString.class]
      ? record[@"created_at"] : nil;
  NSString *updated = [record[@"updated_at"] isKindOfClass:NSString.class]
      ? record[@"updated_at"] : nil;
  id origin = record[@"origin_url"];
  NSUInteger nameBytes = [name lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  return nameBytes > 0 && nameBytes <= 120 && !DSHHasControlCharacter(name) &&
         ![name containsString:@"/"] && ![name containsString:@"\\"] &&
         created.length >= 20 && created.length <= 64 &&
         updated.length >= 20 && updated.length <= 64 &&
         !DSHHasControlCharacter(created) && !DSHHasControlCharacter(updated) &&
         (origin == NSNull.null ||
          ([origin isKindOfClass:NSString.class] && [origin length] <= 4096 &&
           !DSHHasControlCharacter(origin)));
}

static BOOL DSHWriteAllBytes(int descriptor, NSData *data) {
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

static BOOL DSHWriteProjectMetadataRecord(NSDictionary *record,
                                          int projectDescriptor,
                                          NSError **error);

- (DSHLocalProjectLease *)leaseProjectId:(NSString *)projectId
                                     mode:(DSHLocalProjectAccessMode)mode
                          includeMetadata:(BOOL)includeMetadata
                                    error:(NSError **)error {
  return [self leaseProjectId:projectId
                         mode:mode
              includeMetadata:includeMetadata
                      timeout:-1
                        error:error];
}

- (DSHLocalProjectLease *)leaseProjectId:(NSString *)projectId
                                     mode:(DSHLocalProjectAccessMode)mode
                          includeMetadata:(BOOL)includeMetadata
                                  timeout:(NSTimeInterval)timeout
                                    error:(NSError **)error {
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId] ||
      (mode != DSHLocalProjectAccessModeRead &&
       mode != DSHLocalProjectAccessModeWrite) ||
      !isfinite(timeout)) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  DSHLocalProjectLockToken *token = [[DSHLocalProjectLockToken alloc]
      initWithLock:DSHLockForProjectId(projectId)
         projectId:projectId
              mode:mode
           timeout:timeout];
  if (!token.acquired) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorLockTimeout);
    return nil;
  }
  if (token == nil) return nil;
  int rootDescriptor = -1;
  NSURL *rootURL = [self resolvedProjectsRootCreatingIfNeeded:NO
                                                   descriptor:&rootDescriptor
                                                        error:error];
  if (rootURL == nil) return nil;
  if (self.hook != nil) self.hook(@"after_root_open");
  int projectDescriptor = rootDescriptor < 0
                              ? -1
                              : openat(rootDescriptor, projectId.UTF8String,
                                       O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                           O_NOFOLLOW);
  if (self.hook != nil) self.hook(@"after_project_open");
  int repositoryDescriptor = projectDescriptor < 0
                                 ? -1
                                 : openat(projectDescriptor, "repo",
                                          O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                              O_NOFOLLOW);
  if (self.hook != nil) self.hook(@"after_repo_open");
  int gitDescriptor = repositoryDescriptor < 0
                          ? -1
                          : openat(repositoryDescriptor, ".git",
                                   O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                       O_NOFOLLOW);
  if (self.hook != nil) self.hook(@"after_git_open");
  int objectsDescriptor = gitDescriptor < 0
                              ? -1
                              : openat(gitDescriptor, "objects",
                                       O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                           O_NOFOLLOW);
  struct stat rootMetadata = {};
  struct stat projectMetadata = {};
  struct stat repositoryMetadata = {};
  struct stat gitMetadata = {};
  struct stat objectsMetadata = {};
  BOOL safe = rootDescriptor >= 0 && projectDescriptor >= 0 &&
              repositoryDescriptor >= 0 && gitDescriptor >= 0 &&
              objectsDescriptor >= 0 &&
              fstat(rootDescriptor, &rootMetadata) == 0 &&
              fstat(projectDescriptor, &projectMetadata) == 0 &&
              fstat(repositoryDescriptor, &repositoryMetadata) == 0 &&
              fstat(gitDescriptor, &gitMetadata) == 0 &&
              fstat(objectsDescriptor, &objectsMetadata) == 0 &&
              S_ISDIR(rootMetadata.st_mode) &&
              S_ISDIR(projectMetadata.st_mode) &&
              S_ISDIR(repositoryMetadata.st_mode) &&
              S_ISDIR(gitMetadata.st_mode) &&
              S_ISDIR(objectsMetadata.st_mode) &&
              rootMetadata.st_dev == projectMetadata.st_dev &&
              rootMetadata.st_dev == repositoryMetadata.st_dev &&
              rootMetadata.st_dev == gitMetadata.st_dev &&
              rootMetadata.st_dev == objectsMetadata.st_dev &&
              DSHForbiddenGitIndirectionAbsent(gitDescriptor,
                                               objectsDescriptor);
  if (!safe) {
    if (objectsDescriptor >= 0) close(objectsDescriptor);
    if (gitDescriptor >= 0) close(gitDescriptor);
    if (repositoryDescriptor >= 0) close(repositoryDescriptor);
    if (projectDescriptor >= 0) close(projectDescriptor);
    if (rootDescriptor >= 0) close(rootDescriptor);
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return nil;
  }
  NSURL *projectURL =
      [rootURL URLByAppendingPathComponent:projectId isDirectory:YES];
  NSURL *repositoryURL =
      [projectURL URLByAppendingPathComponent:@"repo" isDirectory:YES];
  if (self.hook != nil) self.hook(@"before_libgit_open");
  git_repository *repository = nullptr;
  int result = git_repository_open_ext(&repository,
                                       repositoryURL.fileSystemRepresentation,
                                       GIT_REPOSITORY_OPEN_NO_SEARCH, nullptr);
  if (self.hook != nil) self.hook(@"after_libgit_open");
  const char *workdir = repository == nullptr ? nullptr
                                               : git_repository_workdir(repository);
  NSString *actual = workdir == nullptr
                         ? nil
                         : [[NSFileManager defaultManager]
                               stringWithFileSystemRepresentation:workdir
                                                            length:strlen(workdir)];
  NSString *expected = repositoryURL.path.stringByStandardizingPath;
  struct stat projectAfter = {};
  struct stat repositoryAfter = {};
  BOOL descriptorsStillCanonical =
      fstatat(rootDescriptor, projectId.UTF8String, &projectAfter,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      fstatat(projectDescriptor, "repo", &repositoryAfter,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      projectMetadata.st_dev == projectAfter.st_dev &&
      projectMetadata.st_ino == projectAfter.st_ino &&
      projectMetadata.st_mode == projectAfter.st_mode &&
      repositoryMetadata.st_dev == repositoryAfter.st_dev &&
      repositoryMetadata.st_ino == repositoryAfter.st_ino &&
      repositoryMetadata.st_mode == repositoryAfter.st_mode;
  if (result < 0 || repository == nullptr || git_repository_is_bare(repository) ||
      actual == nil ||
      ![actual.stringByStandardizingPath isEqualToString:expected] ||
      !descriptorsStillCanonical) {
    if (repository != nullptr) git_repository_free(repository);
    close(objectsDescriptor);
    close(gitDescriptor);
    close(repositoryDescriptor);
    close(projectDescriptor);
    close(rootDescriptor);
    DSHSetAccessError(error,
                      DSHLocalProjectAccessErrorRepositoryUnavailable);
    return nil;
  }
  NSDictionary *metadata = includeMetadata
                               ? DSHReadMetadata(projectDescriptor,
                                                 projectMetadata.st_dev,
                                                 projectId, nil, error)
                               : nil;
  if (includeMetadata && metadata == nil) {
    git_repository_free(repository);
    close(objectsDescriptor);
    close(gitDescriptor);
    close(repositoryDescriptor);
    close(projectDescriptor);
    close(rootDescriptor);
    return nil;
  }
  DSHLocalProjectLease *lease = [[DSHLocalProjectLease alloc] init];
  lease.projectId = projectId;
  lease.projectDirectoryURL = projectURL;
  lease.repositoryURL = repositoryURL;
  lease.metadata = metadata;
  lease.projectsRootDescriptor = rootDescriptor;
  lease.projectDescriptor = projectDescriptor;
  lease.repositoryDescriptor = repositoryDescriptor;
  lease.gitDescriptor = gitDescriptor;
  lease.objectsDescriptor = objectsDescriptor;
  lease.projectsRootDevice = rootMetadata.st_dev;
  lease.projectsRootInode = rootMetadata.st_ino;
  lease.projectDevice = projectMetadata.st_dev;
  lease.projectInode = projectMetadata.st_ino;
  lease.repositoryDevice = repositoryMetadata.st_dev;
  lease.repositoryInode = repositoryMetadata.st_ino;
  lease.gitDevice = gitMetadata.st_dev;
  lease.gitInode = gitMetadata.st_ino;
  lease.objectsDevice = objectsMetadata.st_dev;
  lease.objectsInode = objectsMetadata.st_ino;
  lease.repository = repository;
  lease.accessMode = mode;
  lease.lockToken = token;
  if (![self validateLeaseIdentity:lease error:error]) return nil;
  return lease;
}

static NSString *DSHFileSystemString(const char *path) {
  if (path == nullptr) return nil;
  return [[NSFileManager defaultManager]
      stringWithFileSystemRepresentation:path length:strlen(path)];
}

static BOOL DSHPathsEqual(NSString *left, NSString *right) {
  return left != nil && right != nil &&
         [left.stringByStandardizingPath
             isEqual:right.stringByStandardizingPath];
}

- (BOOL)validateLeaseIdentity:(DSHLocalProjectLease *)lease
                         error:(NSError **)error {
  if (lease == nil || lease.repository == nullptr ||
      lease.projectsRootDescriptor < 0 || lease.projectDescriptor < 0 ||
      lease.repositoryDescriptor < 0 || lease.gitDescriptor < 0 ||
      lease.objectsDescriptor < 0) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return NO;
  }
  if (self.hook != nil) self.hook(@"before_identity_recheck");
  struct stat rootFD = {};
  struct stat projectFD = {};
  struct stat repoFD = {};
  struct stat gitFD = {};
  struct stat objectsFD = {};
  struct stat rootPath = {};
  struct stat projectPath = {};
  struct stat repoPath = {};
  struct stat gitPath = {};
  struct stat objectsPath = {};
  NSURL *rootURL = lease.projectDirectoryURL.URLByDeletingLastPathComponent;
  BOOL topology =
      fstat(lease.projectsRootDescriptor, &rootFD) == 0 &&
      fstat(lease.projectDescriptor, &projectFD) == 0 &&
      fstat(lease.repositoryDescriptor, &repoFD) == 0 &&
      fstat(lease.gitDescriptor, &gitFD) == 0 &&
      fstat(lease.objectsDescriptor, &objectsFD) == 0 &&
      lstat(rootURL.fileSystemRepresentation, &rootPath) == 0 &&
      fstatat(lease.projectsRootDescriptor, lease.projectId.UTF8String,
              &projectPath, AT_SYMLINK_NOFOLLOW) == 0 &&
      fstatat(lease.projectDescriptor, "repo", &repoPath,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      fstatat(lease.repositoryDescriptor, ".git", &gitPath,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      fstatat(lease.gitDescriptor, "objects", &objectsPath,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISDIR(rootPath.st_mode) && S_ISDIR(projectPath.st_mode) &&
      S_ISDIR(repoPath.st_mode) && S_ISDIR(gitPath.st_mode) &&
      S_ISDIR(objectsPath.st_mode) && DSHSameNode(rootFD, rootPath) &&
      DSHSameNode(projectFD, projectPath) && DSHSameNode(repoFD, repoPath) &&
      DSHSameNode(gitFD, gitPath) && DSHSameNode(objectsFD, objectsPath) &&
      rootFD.st_dev == projectFD.st_dev && rootFD.st_dev == repoFD.st_dev &&
      rootFD.st_dev == gitFD.st_dev && rootFD.st_dev == objectsFD.st_dev &&
      DSHForbiddenGitIndirectionAbsent(lease.gitDescriptor,
                                       lease.objectsDescriptor);
  if (!topology) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return NO;
  }

  NSURL *gitURL = [lease.repositoryURL URLByAppendingPathComponent:@".git"
                                                        isDirectory:YES];
  NSURL *objectsURL = [gitURL URLByAppendingPathComponent:@"objects"
                                               isDirectory:YES];
  NSString *repoPathString = lease.repositoryURL.path;
  NSString *gitPathString = gitURL.path;
  NSString *objectsPathString = objectsURL.path;
  BOOL libgitPaths =
      DSHPathsEqual(DSHFileSystemString(git_repository_workdir(lease.repository)),
                    repoPathString) &&
      DSHPathsEqual(DSHFileSystemString(git_repository_path(lease.repository)),
                    gitPathString) &&
      DSHPathsEqual(DSHFileSystemString(git_repository_commondir(lease.repository)),
                    gitPathString);
  for (git_repository_item_t item : {
         GIT_REPOSITORY_ITEM_GITDIR, GIT_REPOSITORY_ITEM_COMMONDIR,
         GIT_REPOSITORY_ITEM_OBJECTS, GIT_REPOSITORY_ITEM_WORKDIR
       }) {
    git_buf value = GIT_BUF_INIT;
    int result = git_repository_item_path(&value, lease.repository, item);
    NSString *expected = item == GIT_REPOSITORY_ITEM_OBJECTS
        ? objectsPathString
        : (item == GIT_REPOSITORY_ITEM_WORKDIR ? repoPathString
                                               : gitPathString);
    NSString *actual = result == 0 && value.ptr != nullptr
        ? DSHFileSystemString(value.ptr)
        : nil;
    libgitPaths = libgitPaths && result == 0 && DSHPathsEqual(actual, expected);
    git_buf_dispose(&value);
  }
  if (!libgitPaths) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return NO;
  }
  return YES;
}

- (NSDictionary *)readProjectMetadataFromLease:(DSHLocalProjectLease *)lease
                                          error:(NSError **)error {
  if (![self validateLeaseIdentity:lease error:error]) return nil;
  NSDictionary *metadata = DSHReadMetadata(lease.projectDescriptor,
                                           lease.projectDevice,
                                           lease.projectId, nil, error);
  if (metadata == nil || ![self validateLeaseIdentity:lease error:error]) {
    return nil;
  }
  return metadata;
}

- (NSString *)projectMetadataDigestFromLease:(DSHLocalProjectLease *)lease
                                        error:(NSError **)error {
  if (![self validateLeaseIdentity:lease error:error]) return nil;
  NSString *digest = nil;
  NSDictionary *metadata = DSHReadMetadata(lease.projectDescriptor,
                                           lease.projectDevice,
                                           lease.projectId, &digest, error);
  if (metadata == nil || digest == nil ||
      ![self validateLeaseIdentity:lease error:error]) {
    return nil;
  }
  return digest;
}

- (BOOL)writeProjectMetadataRecord:(NSDictionary *)record
                             lease:(DSHLocalProjectLease *)lease
                             error:(NSError **)error {
  if (lease.accessMode != DSHLocalProjectAccessModeWrite ||
      ![self validateLeaseIdentity:lease error:error]) {
    if (lease.accessMode != DSHLocalProjectAccessModeWrite) {
      DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    }
    return NO;
  }
  if (!DSHWriteProjectMetadataRecord(record, lease.projectDescriptor, error)) {
    return NO;
  }
  return [self validateLeaseIdentity:lease error:error];
}

- (BOOL)writeInitialProjectMetadataRecord:(NSDictionary *)record
                                 projectId:(NSString *)projectId
                         projectDescriptor:(int)projectDescriptor
                                writeToken:(DSHLocalProjectLockToken *)writeToken
                                     error:(NSError **)error {
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId] ||
      writeToken == nil || !writeToken.acquired ||
      writeToken.mode != DSHLocalProjectAccessModeWrite ||
      ![writeToken.projectId isEqual:projectId] || projectDescriptor < 0) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return NO;
  }
  int rootDescriptor = -1;
  BOOL rootResolved = [self resolvedProjectsRootCreatingIfNeeded:NO
                                                     descriptor:&rootDescriptor
                                                          error:error] != nil;
  NSString *stagingName = [@".staging-" stringByAppendingString:projectId];
  struct stat rootProject = {};
  struct stat suppliedProject = {};
  BOOL bound = rootResolved && rootDescriptor >= 0 &&
      fstatat(rootDescriptor, stagingName.fileSystemRepresentation,
              &rootProject, AT_SYMLINK_NOFOLLOW) == 0 &&
      fstat(projectDescriptor, &suppliedProject) == 0 &&
      S_ISDIR(rootProject.st_mode) &&
      DSHSameNode(rootProject, suppliedProject);
  if (rootDescriptor >= 0) close(rootDescriptor);
  if (!bound) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return NO;
  }
  return DSHWriteProjectMetadataRecord(record, projectDescriptor, error);
}

static BOOL DSHWriteProjectMetadataRecord(NSDictionary *record,
                                          int projectDescriptor,
                                          NSError **error) {
  if (!DSHValidStoredMetadataRecord(record) || projectDescriptor < 0) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorMetadataInvalid);
    return NO;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:record
                                                  options:NSJSONWritingSortedKeys
                                                    error:nil];
  if (data == nil || data.length > DSHProjectMetadataMaxBytes) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorMetadataInvalid);
    return NO;
  }
  struct stat projectMetadata = {};
  struct stat existing = {};
  BOOL projectSafe = fstat(projectDescriptor, &projectMetadata) == 0 &&
                     S_ISDIR(projectMetadata.st_mode);
  errno = 0;
  BOOL exists = fstatat(projectDescriptor, "project.json", &existing,
                        AT_SYMLINK_NOFOLLOW) == 0;
  BOOL existingSafe = !exists
      ? errno == ENOENT
      : S_ISREG(existing.st_mode) && existing.st_nlink == 1 &&
            existing.st_dev == projectMetadata.st_dev;
  if (!projectSafe || !existingSafe) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
    return NO;
  }
  NSString *temporaryName = [@".project-json-"
      stringByAppendingString:NSUUID.UUID.UUIDString.lowercaseString];
  int descriptor = openat(projectDescriptor, temporaryName.fileSystemRepresentation,
                          O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC |
                              O_NOFOLLOW,
                          0600);
  BOOL success = descriptor >= 0 && DSHWriteAllBytes(descriptor, data) &&
                 fchmod(descriptor, 0600) == 0 && fsync(descriptor) == 0;
  if (descriptor >= 0) close(descriptor);
  if (success) {
    success = renameat(projectDescriptor, temporaryName.fileSystemRepresentation,
                       projectDescriptor, "project.json") == 0 &&
              fsync(projectDescriptor) == 0;
  }
  if (!success) {
    unlinkat(projectDescriptor, temporaryName.fileSystemRepresentation, 0);
    DSHSetAccessError(error, DSHLocalProjectAccessErrorStorageUnavailable);
    return NO;
  }
  struct stat published = {};
  success = fstatat(projectDescriptor, "project.json", &published,
                    AT_SYMLINK_NOFOLLOW) == 0 &&
            S_ISREG(published.st_mode) && published.st_nlink == 1 &&
            published.st_dev == projectMetadata.st_dev &&
            published.st_size == (off_t)data.length &&
            (published.st_mode & 0777) == 0600;
  if (!success) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorUnsafeStorage);
  }
  return success;
}

- (DSHLocalProjectLeaseSet *)
    leaseWorkspaceReadPaths:(NSArray<NSString *> *)readPaths
                  writePaths:(NSArray<NSString *> *)writePaths
                     timeout:(NSTimeInterval)timeout
                       error:(NSError **)error {
  if (![readPaths isKindOfClass:NSArray.class] ||
      ![writePaths isKindOfClass:NSArray.class] || !isfinite(timeout)) {
    DSHSetAccessError(error, DSHLocalProjectAccessErrorInvalidIdentifier);
    return nil;
  }
  NSMutableDictionary<NSString *, NSNumber *> *modes =
      [NSMutableDictionary dictionary];
  for (NSUInteger kind = 0; kind < 2; kind++) {
    NSArray<NSString *> *paths = kind == 0 ? readPaths : writePaths;
    for (id path in paths) {
      NSError *pathError = nil;
      NSString *projectId =
          [DSHLocalProjectAccess projectIdForWorkspacePath:path error:&pathError];
      if (projectId == nil && pathError != nil) {
        if (error != nil) *error = pathError;
        return nil;
      }
      if (projectId != nil) {
        DSHLocalProjectAccessMode mode = kind == 0
            ? DSHLocalProjectAccessModeRead
            : DSHLocalProjectAccessModeWrite;
        if (modes[projectId] == nil || mode == DSHLocalProjectAccessModeWrite) {
          modes[projectId] = @(mode);
        }
      }
    }
  }
  NSArray<NSString *> *projectIds =
      [modes.allKeys sortedArrayUsingSelector:@selector(compare:)];
  NSMutableDictionary<NSString *, DSHLocalProjectLease *> *leases =
      [NSMutableDictionary dictionary];
  CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
  for (NSString *projectId in projectIds) {
    NSTimeInterval remaining = timeout;
    if (timeout >= 0) {
      remaining = MAX(0, timeout - (CFAbsoluteTimeGetCurrent() - started));
    }
    DSHLocalProjectLease *lease = [self
        leaseProjectId:projectId
                  mode:(DSHLocalProjectAccessMode)modes[projectId].integerValue
       includeMetadata:NO
               timeout:remaining
                 error:error];
    if (lease == nil) return nil;
    leases[projectId] = lease;
  }
  DSHLocalProjectLeaseSet *set = [[DSHLocalProjectLeaseSet alloc] init];
  set.leases = leases;
  return set;
}

@end
