#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>

#import "LocalProjectAccess.h"

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <git2.h>
#include <netinet/in.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *const LPCredentialService = @"dev.zseven.rish.git.https";
static NSString *const LPRemoteName = @"origin";
static NSUInteger const LPMaxProjectNameBytes = 120;
static NSUInteger const LPMaxStatusEntries = 10000;
static NSUInteger const LPMaxDiffFiles = 1000;
static NSUInteger const LPMaxDiffBytes = 1024 * 1024;
static NSUInteger const LPMaxCommitMessageBytes = 64 * 1024;
static NSUInteger const LPMaxCheckoutEntries = 100000;
static NSUInteger const LPMaxCheckoutDepth = 64;
// Cleanup begins one directory above the validated checkout, at the staging
// wrapper. Preserve the checkout limit while accounting for that wrapper.
static NSUInteger const LPMaxCleanupDepth = LPMaxCheckoutDepth + 1;
static NSUInteger const LPMaxOrphansPerReconcile = 128;
static NSUInteger const LPMaxOrphanCleanupEntriesPerPass = 128;
static NSUInteger const LPMaxStagingOwnerBytes = 1024;
static NSString *const LPStagingOwnerMarker = @".rish-staging-owner.json";

static NSError *LPError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"LocalProjects"
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *LPString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static NSDictionary *LPDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSString *LPNow(void) {
  static NSISO8601DateFormatter *formatter = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime
      | NSISO8601DateFormatWithFractionalSeconds;
  });
  return [formatter stringFromDate:NSDate.date];
}

static BOOL LPHasControlCharacter(NSString *value) {
  return [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location
    != NSNotFound;
}

static NSString *LPValidatedProjectName(id value, NSError **error) {
  NSString *name = [LPString(value) stringByTrimmingCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSUInteger bytes = [name lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  if (name == nil || bytes == 0 || bytes > LPMaxProjectNameBytes
    || LPHasControlCharacter(name) || [name containsString:@"/"]
    || [name containsString:@"\\"] || [name isEqualToString:@"."]
    || [name isEqualToString:@".."]) {
    if (error != nil) *error = LPError(3001, @"Project name is invalid");
    return nil;
  }
  return name;
}

static BOOL LPIsSafeRepositoryPath(NSString *path) {
  if (path.length == 0 || [path hasPrefix:@"/"] || [path containsString:@"\\"]
    || LPHasControlCharacter(path)) return NO;
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if (component.length == 0 || [component isEqualToString:@"."]
      || [component isEqualToString:@".."]
      || [component isEqualToString:@".git"]) return NO;
  }
  return YES;
}

static BOOL LPIsIPAddress(NSString *host) {
  NSString *candidate = host;
  if ([candidate hasPrefix:@"["] && [candidate hasSuffix:@"]"] && candidate.length > 2) {
    candidate = [candidate substringWithRange:NSMakeRange(1, candidate.length - 2)];
  }
  struct in_addr ipv4 = {};
  struct in6_addr ipv6 = {};
  return inet_pton(AF_INET, candidate.UTF8String, &ipv4) == 1
    || inet_pton(AF_INET6, candidate.UTF8String, &ipv6) == 1;
}

static BOOL LPIsPublicDNSName(NSString *host) {
  if (host.length == 0 || host.length > 253 || [host hasSuffix:@"."]
    || [host caseInsensitiveCompare:@"localhost"] == NSOrderedSame
    || [host.lowercaseString hasSuffix:@".local"]
    || [host.lowercaseString hasSuffix:@".internal"] || LPIsIPAddress(host)) return NO;
  NSArray<NSString *> *labels = [host componentsSeparatedByString:@"."];
  if (labels.count < 2) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
    @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
  for (NSString *label in labels) {
    if (label.length == 0 || label.length > 63 || [label hasPrefix:@"-"]
      || [label hasSuffix:@"-"]
      || [label rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return NO;
  }
  return YES;
}

static NSURL *LPValidatedHTTPSURL(id value, NSError **error) {
  NSString *input = LPString(value);
  if (input.length == 0 || input.length > 4096 || LPHasControlCharacter(input)
    || [input containsString:@"\\"]
    || ![input isEqualToString:[input stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet]]) {
    if (error != nil) *error = LPError(3002, @"Remote URL is invalid");
    return nil;
  }
  NSURLComponents *components = [NSURLComponents componentsWithString:input];
  NSString *host = components.host.lowercaseString;
  NSString *path = components.path;
  BOOL validPort = components.port == nil || components.port.integerValue == 443;
  BOOL valid = [components.scheme.lowercaseString isEqualToString:@"https"]
    && LPIsPublicDNSName(host) && validPort
    && components.user == nil && components.password == nil
    && components.query == nil && components.fragment == nil
    && path.length > 1 && path.length <= 2048 && !LPHasControlCharacter(path);
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if ([component isEqualToString:@"."] || [component isEqualToString:@".."]) valid = NO;
  }
  if (!valid || components.URL == nil) {
    if (error != nil) *error = LPError(3002, @"Remote URL is invalid");
    return nil;
  }
  components.scheme = @"https";
  components.host = host;
  return components.URL;
}

static NSString *LPOidString(const git_oid *oid) {
  if (oid == nullptr) return nil;
  char buffer[GIT_OID_SHA1_HEXSIZE + 1] = {};
  git_oid_tostr(buffer, sizeof(buffer), oid);
  return [NSString stringWithUTF8String:buffer];
}

static NSString *LPStatusName(unsigned int status, BOOL index) {
  if (status & GIT_STATUS_CONFLICTED) return @"modified";
  if (index) {
    if (status & GIT_STATUS_INDEX_NEW) return @"added";
    if (status & GIT_STATUS_INDEX_MODIFIED) return @"modified";
    if (status & GIT_STATUS_INDEX_DELETED) return @"deleted";
    if (status & GIT_STATUS_INDEX_RENAMED) return @"renamed";
    if (status & GIT_STATUS_INDEX_TYPECHANGE) return @"typechange";
  } else {
    if (status & GIT_STATUS_WT_NEW) return @"added";
    if (status & GIT_STATUS_WT_MODIFIED) return @"modified";
    if (status & GIT_STATUS_WT_DELETED) return @"deleted";
    if (status & GIT_STATUS_WT_RENAMED) return @"renamed";
    if (status & GIT_STATUS_WT_TYPECHANGE) return @"typechange";
    if (status & GIT_STATUS_WT_UNREADABLE) return @"unreadable";
  }
  return @"unmodified";
}

static NSString *LPDiffStatusName(git_delta_t status) {
  switch (status) {
    case GIT_DELTA_ADDED:
    case GIT_DELTA_UNTRACKED:
      return @"added";
    case GIT_DELTA_DELETED:
      return @"deleted";
    case GIT_DELTA_RENAMED:
    case GIT_DELTA_COPIED:
      return @"renamed";
    case GIT_DELTA_TYPECHANGE:
      return @"typechange";
    case GIT_DELTA_UNREADABLE:
      return @"unreadable";
    case GIT_DELTA_UNMODIFIED:
      return @"unmodified";
    default:
      return @"modified";
  }
}

static NSString *LPGitErrorClassName(int errorClass) {
  switch (errorClass) {
    case GIT_ERROR_OS: return @"os";
    case GIT_ERROR_NET: return @"network";
    case GIT_ERROR_SSL: return @"tls";
    case GIT_ERROR_HTTP: return @"http";
    case GIT_ERROR_CALLBACK: return @"callback";
    case GIT_ERROR_CHECKOUT: return @"checkout";
    case GIT_ERROR_REPOSITORY: return @"repository";
    case GIT_ERROR_CONFIG: return @"config";
    case GIT_ERROR_INDEXER: return @"indexer";
    case GIT_ERROR_FILESYSTEM: return @"filesystem";
    default: return @"git";
  }
}

static NSString *LPSanitizedGitFailure(NSString *operation, int result) {
  const git_error *last = git_error_last();
  int errorClass = last == nullptr ? GIT_ERROR_NONE : last->klass;
  return [NSString stringWithFormat:@"%@ failed (code %d, class %@/%d)",
    operation, result, LPGitErrorClassName(errorClass), errorClass];
}

static NSString *LPPathForStatusEntry(const git_status_entry *entry) {
  const char *path = nullptr;
  if (entry->index_to_workdir != nullptr) {
    path = entry->index_to_workdir->new_file.path ?: entry->index_to_workdir->old_file.path;
  }
  if (path == nullptr && entry->head_to_index != nullptr) {
    path = entry->head_to_index->new_file.path ?: entry->head_to_index->old_file.path;
  }
  return path == nullptr ? nil : [NSString stringWithUTF8String:path];
}

static int LPHeadTree(git_tree **tree, git_repository *repository) {
  git_reference *head = nullptr;
  git_commit *commit = nullptr;
  int result = git_repository_head(&head, repository);
  if (result == 0) {
    const git_oid *oid = git_reference_target(head);
    result = oid == nullptr ? GIT_ENOTFOUND : git_commit_lookup(&commit, repository, oid);
  }
  if (result == 0) result = git_commit_tree(tree, commit);
  if (commit != nullptr) git_commit_free(commit);
  if (head != nullptr) git_reference_free(head);
  return result;
}

static BOOL LPDirectoryIsSafe(NSURL *url) {
  struct stat metadata = {};
  return lstat(url.fileSystemRepresentation, &metadata) == 0
    && S_ISDIR(metadata.st_mode) && !S_ISLNK(metadata.st_mode);
}

static BOOL LPSameNode(const struct stat &left, const struct stat &right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
      left.st_mode == right.st_mode;
}

static BOOL LPWriteAll(int descriptor, NSData *data) {
  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  size_t offset = 0;
  while (offset < data.length) {
    ssize_t written = write(descriptor, bytes + offset, data.length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return NO;
    offset += static_cast<size_t>(written);
  }
  return YES;
}

static BOOL LPRemoveTreeContents(int directoryDescriptor,
                                 dev_t expectedDevice,
                                 NSUInteger depth,
                                 NSUInteger *entryCount,
                                 NSUInteger maxEntries) {
  if (depth > LPMaxCleanupDepth) return NO;
  int duplicate = openat(directoryDescriptor, ".",
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  DIR *directory = duplicate < 0 ? nullptr : fdopendir(duplicate);
  if (directory == nullptr) {
    if (duplicate >= 0) close(duplicate);
    return NO;
  }
  BOOL ownerMarkerPresent = NO;
  NSMutableArray<NSData *> *names = [NSMutableArray array];
  BOOL valid = YES;
  BOOL fullyEnumerated = YES;
  while (valid) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == nullptr) {
      valid = errno == 0;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 ||
        strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    if (strcmp(entry->d_name, LPStagingOwnerMarker.UTF8String) == 0) {
      ownerMarkerPresent = YES;
      continue;
    }
    if (*entryCount >= maxEntries ||
        names.count >= maxEntries - *entryCount) {
      fullyEnumerated = NO;
      break;
    }
    [names addObject:[NSData dataWithBytes:entry->d_name
                                    length:strlen(entry->d_name) + 1]];
  }
  closedir(directory);
  if (!valid) return NO;
  for (NSData *nameData in names) {
    if (*entryCount >= maxEntries) return NO;
    *entryCount += 1;
    const char *name = static_cast<const char *>(nameData.bytes);
    struct stat before = {};
    if (fstatat(directoryDescriptor, name, &before,
                AT_SYMLINK_NOFOLLOW) != 0 ||
        before.st_dev != expectedDevice ||
        (!S_ISDIR(before.st_mode) && !S_ISREG(before.st_mode) &&
         !S_ISLNK(before.st_mode))) {
      valid = NO;
      break;
    }
    if (S_ISDIR(before.st_mode)) {
      int child = openat(directoryDescriptor, name,
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat opened = {};
      valid = child >= 0 && fstat(child, &opened) == 0 &&
          LPSameNode(before, opened) &&
          LPRemoveTreeContents(child, expectedDevice, depth + 1, entryCount,
                               maxEntries);
      if (child >= 0) close(child);
      struct stat after = {};
      valid = valid &&
          fstatat(directoryDescriptor, name, &after,
                  AT_SYMLINK_NOFOLLOW) == 0 &&
          LPSameNode(before, after) &&
          unlinkat(directoryDescriptor, name, AT_REMOVEDIR) == 0;
    } else {
      struct stat after = {};
      valid = fstatat(directoryDescriptor, name, &after,
                      AT_SYMLINK_NOFOLLOW) == 0 &&
          LPSameNode(before, after) &&
          unlinkat(directoryDescriptor, name, 0) == 0;
    }
    if (!valid) return NO;
  }
  if (!valid) return NO;
  if (!fullyEnumerated) return NO;
  if (ownerMarkerPresent) {
    struct stat marker = {};
    if (fstatat(directoryDescriptor, LPStagingOwnerMarker.UTF8String, &marker,
                AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(marker.st_mode) ||
        marker.st_dev != expectedDevice ||
        unlinkat(directoryDescriptor, LPStagingOwnerMarker.UTF8String, 0) != 0) {
      return NO;
    }
  }
  return fsync(directoryDescriptor) == 0;
}

static NSDictionary *LPReadStagingOwner(int directoryDescriptor,
                                         dev_t expectedDevice) {
  int markerDescriptor = openat(directoryDescriptor,
      LPStagingOwnerMarker.UTF8String, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat before = {};
  BOOL safe = markerDescriptor >= 0 && fstat(markerDescriptor, &before) == 0 &&
      S_ISREG(before.st_mode) && before.st_dev == expectedDevice &&
      before.st_nlink == 1 && (before.st_mode & 0777) == 0600 &&
      before.st_size > 0 && before.st_size <= LPMaxStagingOwnerBytes;
  NSMutableData *data = safe
      ? [NSMutableData dataWithLength:static_cast<NSUInteger>(before.st_size)]
      : nil;
  size_t offset = 0;
  while (safe && offset < data.length) {
    ssize_t count = read(markerDescriptor,
                         static_cast<uint8_t *>(data.mutableBytes) + offset,
                         data.length - offset);
    if (count <= 0) {
      safe = NO;
      break;
    }
    offset += static_cast<size_t>(count);
  }
  struct stat after = {};
  safe = safe && fstat(markerDescriptor, &after) == 0 &&
      LPSameNode(before, after) && before.st_size == after.st_size &&
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
      before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
      before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec &&
      before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
  if (markerDescriptor >= 0) close(markerDescriptor);
  if (!safe) return nil;
  NSDictionary *marker = LPDictionary(
      [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]);
  NSSet *expectedKeys = [NSSet setWithArray:
      @[@"schema_version", @"project_id", @"cleanup_token"]];
  if (marker.count != expectedKeys.count ||
      ![[NSSet setWithArray:marker.allKeys] isEqual:expectedKeys] ||
      ![marker[@"schema_version"] isEqual:@1] ||
      ![DSHLocalProjectAccess isCanonicalProjectId:LPString(marker[@"project_id"])] ||
      ![DSHLocalProjectAccess isCanonicalProjectId:LPString(marker[@"cleanup_token"])]) {
    return nil;
  }
  return marker;
}

static BOOL LPRemoveOwnedDirectoryAtRoot(int rootDescriptor,
                                          NSString *name,
                                          const struct stat *expectedIdentity,
                                          NSString *expectedToken,
                                          NSUInteger *entryCount,
                                          NSUInteger maxEntries) {
  struct stat before = {};
  if (rootDescriptor < 0 || name.length == 0 ||
      fstatat(rootDescriptor, name.fileSystemRepresentation, &before,
              AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(before.st_mode) ||
      (expectedIdentity != nullptr &&
       !LPSameNode(*expectedIdentity, before))) {
    return NO;
  }
  int directoryDescriptor = openat(rootDescriptor, name.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat opened = {};
  BOOL bound = directoryDescriptor >= 0 &&
      fstat(directoryDescriptor, &opened) == 0 && LPSameNode(before, opened);
  NSDictionary *marker = bound
      ? LPReadStagingOwner(directoryDescriptor, before.st_dev) : nil;
  bound = bound && marker != nil &&
      [marker[@"cleanup_token"] isEqual:expectedToken];
  BOOL emptied = bound && LPRemoveTreeContents(directoryDescriptor,
      before.st_dev, 0, entryCount, maxEntries);
  if (directoryDescriptor >= 0) close(directoryDescriptor);
  struct stat after = {};
  BOOL removed = emptied &&
      fstatat(rootDescriptor, name.fileSystemRepresentation, &after,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      LPSameNode(before, after) &&
      unlinkat(rootDescriptor, name.fileSystemRepresentation,
               AT_REMOVEDIR) == 0 &&
      fsync(rootDescriptor) == 0;
  return removed;
}

static BOOL LPValidateCheckoutTree(int directoryDescriptor,
                                   NSUInteger depth,
                                   NSUInteger *entryCount) {
  if (depth > LPMaxCheckoutDepth) return NO;
  int duplicate = openat(directoryDescriptor, ".",
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  DIR *directory = duplicate < 0 ? nullptr : fdopendir(duplicate);
  if (directory == nullptr) {
    if (duplicate >= 0) close(duplicate);
    return NO;
  }
  struct dirent *entry = nullptr;
  errno = 0;
  while ((entry = readdir(directory)) != nullptr) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (depth == 0 && strcmp(entry->d_name, ".git") == 0) continue;
    if (strcmp(entry->d_name, ".git") == 0 || strcmp(entry->d_name, ".gitmodules") == 0) {
      closedir(directory);
      return NO;
    }
    *entryCount += 1;
    if (*entryCount > LPMaxCheckoutEntries) {
      closedir(directory);
      return NO;
    }
    struct stat metadata = {};
    if (fstatat(directoryDescriptor, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) != 0
      || S_ISLNK(metadata.st_mode)
      || (!S_ISDIR(metadata.st_mode) && !S_ISREG(metadata.st_mode))) {
      closedir(directory);
      return NO;
    }
    if (S_ISDIR(metadata.st_mode)) {
      int child = openat(directoryDescriptor, entry->d_name,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      BOOL valid = child >= 0 && LPValidateCheckoutTree(child, depth + 1, entryCount);
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

static BOOL LPValidCredentialUsername(NSString *username) {
  if (username.length == 0 || username.length > 255 || LPHasControlCharacter(username)
    || [username rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location
      != NSNotFound) return NO;
  NSCharacterSet *forbidden = [NSCharacterSet characterSetWithCharactersInString:@":/@\\"];
  return [username rangeOfCharacterFromSet:forbidden].location == NSNotFound;
}

static BOOL LPValidCredentialToken(NSString *token) {
  NSUInteger bytes = [token lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  return bytes >= 8 && bytes <= 4096 && !LPHasControlCharacter(token)
    && [token rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location
      == NSNotFound;
}

typedef struct {
  __unsafe_unretained NSString *host;
  __unsafe_unretained NSString *username;
  __unsafe_unretained NSString *token;
  bool attempted;
} LPCredentialPayload;

static int LPPublicCloneCredentialCallback(git_credential **out,
                                            const char *url,
                                            const char *username,
                                            unsigned int allowedTypes,
                                            void *payload) {
  (void)out;
  (void)url;
  (void)username;
  (void)allowedTypes;
  (void)payload;
  return GIT_EAUTH;
}

static int LPKeychainCredentialCallback(git_credential **out,
                                         const char *url,
                                         const char *usernameFromURL,
                                         unsigned int allowedTypes,
                                         void *rawPayload) {
  (void)usernameFromURL;
  LPCredentialPayload *payload = static_cast<LPCredentialPayload *>(rawPayload);
  NSString *urlString = url == nullptr ? nil : [NSString stringWithUTF8String:url];
  NSURL *validated = LPValidatedHTTPSURL(urlString, nil);
  if (validated == nil || ![validated.host.lowercaseString isEqualToString:payload->host]) {
    return GIT_EAUTH;
  }
  if (allowedTypes & GIT_CREDENTIAL_USERPASS_PLAINTEXT) {
    if (payload->attempted) return GIT_EAUTH;
    payload->attempted = true;
    return git_credential_userpass_plaintext_new(
      out, payload->username.UTF8String, payload->token.UTF8String);
  }
  if (allowedTypes & GIT_CREDENTIAL_USERNAME) {
    return git_credential_username_new(out, payload->username.UTF8String);
  }
  return GIT_PASSTHROUGH;
}

@interface LocalProjectsModule : NSObject <RCTBridgeModule>
@property(nonatomic, strong) dispatch_queue_t projectQueue;
@property(nonatomic, strong) DSHLocalProjectAccess *projectAccess;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSValue *> *stagingIdentities;
@property(nonatomic, strong) NSMutableDictionary<NSString *, DSHLocalProjectsRootLease *> *stagingRootLeases;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *stagingCleanupTokens;
@property(nonatomic, strong, nullable) DSHLocalProjectsRootLease *pendingRootLease;
- (BOOL)stagingEntryIsExactForProjectId:(NSString *)projectId
                                  error:(NSError **)error;
- (void)removeVisibleStagingDirectory:(NSURL *)staging
                            projectId:(NSString *)projectId;
- (BOOL)reconcileOwnedOrphansInRootLease:(DSHLocalProjectsRootLease *)rootLease;
- (BOOL)removePublishedOwnerMarkerAtDescriptor:(int)descriptor;
- (BOOL)syncPublishedRootDescriptor:(int)descriptor;
@end

@implementation LocalProjectsModule

RCT_EXPORT_MODULE(LocalProjects)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _projectAccess = DSHLocalProjectAccess.sharedAccess;
    _stagingIdentities = [NSMutableDictionary dictionary];
    _stagingRootLeases = [NSMutableDictionary dictionary];
    _stagingCleanupTokens = [NSMutableDictionary dictionary];
    _projectQueue = dispatch_queue_create(
      "dev.zseven.rish.local-projects", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (NSURL *)projectsRootCreatingIfNeeded:(BOOL)create error:(NSError **)error {
  NSError *accessError = nil;
  DSHLocalProjectsRootLease *rootLease = [self.projectAccess
      leaseProjectsRootCreatingIfNeeded:create error:&accessError];
  self.pendingRootLease = rootLease;
  if (rootLease == nil) {
    if (error != nil) {
      *error = accessError ?: LPError(3005, @"Project storage is unavailable");
    }
    return nil;
  }
  return rootLease.rootURL;
}

- (BOOL)removePublishedOwnerMarkerAtDescriptor:(int)descriptor {
  return descriptor >= 0 &&
      unlinkat(descriptor, LPStagingOwnerMarker.UTF8String, 0) == 0 &&
      fsync(descriptor) == 0;
}

- (BOOL)syncPublishedRootDescriptor:(int)descriptor {
  return descriptor >= 0 && fsync(descriptor) == 0;
}

- (NSURL *)projectDirectoryForId:(NSString *)projectId error:(NSError **)error {
  if (![DSHLocalProjectAccess isCanonicalProjectId:projectId]) {
    if (error != nil) *error = LPError(3006, @"Project identifier is invalid");
    return nil;
  }
  NSURL *project = [self.projectAccess projectDirectoryURLForId:projectId error:nil];
  if (project == nil) {
    if (error != nil) *error = LPError(3007, @"Project is unavailable");
    return nil;
  }
  return project;
}

- (DSHLocalProjectLease *)leaseRepositoryForId:(NSString *)projectId
                                          mode:(DSHLocalProjectAccessMode)mode
                                      metadata:(NSDictionary **)metadata
                                         error:(NSError **)error {
  NSError *accessError = nil;
  DSHLocalProjectLease *lease = [self.projectAccess
    leaseProjectId:projectId
              mode:mode
   includeMetadata:NO
             error:&accessError];
  if (lease == nil) {
    if (error != nil) {
      if (accessError.code == DSHLocalProjectAccessErrorInvalidIdentifier) {
        *error = LPError(3006, @"Project identifier is invalid");
      } else if (accessError.code == DSHLocalProjectAccessErrorStorageUnavailable) {
        *error = LPError(3007, @"Project is unavailable");
      } else if (accessError.code == DSHLocalProjectAccessErrorUnsafeStorage) {
        *error = LPError(3008, @"Repository storage is unsafe");
      } else {
        *error = LPError(3009, @"Repository cannot be opened");
      }
    }
    return nil;
  }
  if (metadata != nullptr) {
    *metadata = [self.projectAccess readProjectMetadataFromLease:lease
                                                          error:nil];
    NSString *origin = (*metadata)[@"origin_url"] == NSNull.null
      ? nil : LPString((*metadata)[@"origin_url"]);
    if (*metadata != nil && origin != nil &&
        LPValidatedHTTPSURL(origin, nil) == nil) {
      *metadata = nil;
    }
    if (*metadata == nil) {
      if (error != nil) *error = LPError(3010, @"Project metadata is invalid");
      return nil;
    }
  }
  return lease;
}

- (BOOL)writeMetadata:(NSDictionary *)metadata
    atProjectDirectory:(NSURL *)project
             projectId:(NSString *)projectId
            writeToken:(DSHLocalProjectLockToken *)writeToken
                 error:(NSError **)error {
  DSHLocalProjectsRootLease *rootLease = self.stagingRootLeases[projectId];
  NSString *stagingName = [@".staging-" stringByAppendingString:projectId];
  BOOL stagingBound = [self stagingEntryIsExactForProjectId:projectId
                                                       error:nil];
  int descriptor = !stagingBound || rootLease == nil ? -1 : openat(
      rootLease.descriptor, stagingName.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  BOOL correctURL = [project.lastPathComponent isEqual:stagingName] &&
      [project.URLByDeletingLastPathComponent.path.stringByStandardizingPath
          isEqual:rootLease.rootURL.path.stringByStandardizingPath];
  BOOL success = descriptor >= 0 && correctURL && [self.projectAccess
      writeInitialProjectMetadataRecord:metadata
                       projectId:projectId
               projectDescriptor:descriptor
                      writeToken:writeToken
                           error:nil];
  struct stat identity = {};
  success = success && fstat(descriptor, &identity) == 0 &&
            S_ISDIR(identity.st_mode);
  if (success) {
    self.stagingIdentities[projectId] =
        [NSValue value:&identity withObjCType:@encode(struct stat)];
  }
  if (descriptor >= 0) close(descriptor);
  if (!success) {
    if (error != nil) *error = LPError(3011, @"Project metadata cannot be saved");
    return NO;
  }
  return YES;
}

- (NSDictionary *)updatedMetadata:(NSDictionary *)metadata
                         originURL:(NSString *)origin
                             lease:(DSHLocalProjectLease *)lease
                             error:(NSError **)error {
  NSDictionary *stored = @{
    @"schema_version": @1,
    @"name": metadata[@"name"],
    @"created_at": metadata[@"created_at"],
    @"updated_at": LPNow(),
    @"origin_url": origin ?: NSNull.null,
  };
  if (![self.projectAccess writeProjectMetadataRecord:stored
                                                lease:lease error:nil]) {
    if (error != nil) *error = LPError(3011, @"Project metadata cannot be saved");
    return nil;
  }
  NSDictionary *updated = [self.projectAccess readProjectMetadataFromLease:lease
                                                                      error:nil];
  if (updated == nil) {
    if (error != nil) *error = LPError(3010, @"Project metadata is invalid");
  }
  return updated;
}

- (NSMutableDictionary *)keychainQueryForHost:(NSString *)host {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: LPCredentialService,
    (__bridge id)kSecAttrAccount: host.lowercaseString,
    (__bridge id)kSecAttrSynchronizable: @NO,
  } mutableCopy];
}

- (NSDictionary *)credentialForHost:(NSString *)host status:(OSStatus *)statusOut {
  NSMutableDictionary *query = [self keychainQueryForHost:host];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (statusOut != nullptr) *statusOut = status;
  if (status != errSecSuccess || result == nullptr) {
    if (result != nullptr) CFRelease(result);
    return nil;
  }
  NSData *data = CFBridgingRelease(result);
  if (data.length == 0 || data.length > 8192) return nil;
  NSDictionary *credential = LPDictionary(
    [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]);
  NSString *username = LPString(credential[@"username"]);
  NSString *token = LPString(credential[@"token"]);
  if (!LPValidCredentialUsername(username) || !LPValidCredentialToken(token)) return nil;
  return @{ @"username": username, @"token": token };
}

- (BOOL)storeCredentialForHost:(NSString *)host
                       username:(NSString *)username
                          token:(NSString *)token
                          error:(NSError **)error {
  if (!LPValidCredentialUsername(username) || !LPValidCredentialToken(token)) {
    if (error != nil) *error = LPError(3012, @"Git credential is invalid");
    return NO;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"username": username,
    @"token": token,
  } options:NSJSONWritingSortedKeys error:nil];
  NSMutableDictionary *query = [self keychainQueryForHost:host];
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query,
    (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: data});
  if (status == errSecItemNotFound) {
    query[(__bridge id)kSecValueData] = data;
    query[(__bridge id)kSecAttrAccessible]
      = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
    status = SecItemAdd((__bridge CFDictionaryRef)query, nil);
  }
  if (status != errSecSuccess) {
    if (error != nil) *error = LPError(3013, @"Git credential cannot be saved");
    return NO;
  }
  return YES;
}

- (BOOL)deleteCredentialForHost:(NSString *)host error:(NSError **)error {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)
    [self keychainQueryForHost:host]);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    if (error != nil) *error = LPError(3014, @"Git credential cannot be cleared");
    return NO;
  }
  return YES;
}

- (NSString *)originURLForRepository:(git_repository *)repository error:(NSError **)error {
  git_config *config = nullptr;
  git_buf value = GIT_BUF_INIT;
  int result = git_repository_config(&config, repository);
  if (result == 0) result = git_config_get_string_buf(&value, config, "remote.origin.url");
  NSString *raw = result == 0 && value.ptr != nullptr
    ? [NSString stringWithUTF8String:value.ptr] : nil;
  git_buf_dispose(&value);
  if (config != nullptr) git_config_free(config);
  NSURL *validated = LPValidatedHTTPSURL(raw, nil);
  if (validated == nil) {
    if (error != nil) *error = LPError(3015, @"Origin remote is unavailable or unsafe");
    return nil;
  }
  return validated.absoluteString;
}

- (NSDictionary *)credentialStatusForId:(NSString *)projectId
                              repository:(git_repository *)repository
                                   error:(NSError **)error {
  NSString *origin = [self originURLForRepository:repository error:error];
  if (origin == nil) return nil;
  NSString *host = [NSURLComponents componentsWithString:origin].host.lowercaseString;
  OSStatus status = errSecSuccess;
  NSDictionary *credential = [self credentialForHost:host status:&status];
  if (status != errSecSuccess && status != errSecItemNotFound) {
    if (error != nil) *error = LPError(3016, @"Git credential status is unavailable");
    return nil;
  }
  return @{
    @"schema_version": @1,
    @"project_id": projectId,
    @"host": host,
    @"configured": @(credential != nil),
  };
}

- (NSURL *)createStagingDirectoryAtRoot:(NSURL *)root
                              projectId:(NSString *)projectId
                                   error:(NSError **)error {
  DSHLocalProjectsRootLease *rootLease = self.pendingRootLease;
  self.pendingRootLease = nil;
  if (rootLease == nil ||
      ![rootLease.rootURL.path.stringByStandardizingPath
          isEqual:root.path.stringByStandardizingPath]) {
    rootLease = [self.projectAccess leaseProjectsRootCreatingIfNeeded:NO
                                                                error:nil];
  }
  NSURL *staging = [root URLByAppendingPathComponent:
    [@".staging-" stringByAppendingString:projectId] isDirectory:YES];
  NSString *stagingName = [@".staging-" stringByAppendingString:projectId];
  if (rootLease == nil ||
      mkdirat(rootLease.descriptor, stagingName.fileSystemRepresentation,
              0700) != 0) {
    if (error != nil) *error = LPError(3017, @"Project staging cannot be created");
    return nil;
  }
  self.stagingRootLeases[projectId] = rootLease;
  struct stat identity = {};
  int stagingDescriptor = openat(rootLease.descriptor,
      stagingName.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat openedIdentity = {};
  BOOL openedValid = stagingDescriptor >= 0 &&
      fstat(stagingDescriptor, &openedIdentity) == 0 &&
      S_ISDIR(openedIdentity.st_mode);
  BOOL pathValid =
      fstatat(rootLease.descriptor, stagingName.fileSystemRepresentation,
              &identity, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(identity.st_mode);
  BOOL stagingBound = openedValid && pathValid &&
      LPSameNode(identity, openedIdentity);
  if (!stagingBound) {
    if (stagingDescriptor >= 0) close(stagingDescriptor);
    struct stat finalIdentity = {};
    if (openedValid && pathValid &&
        fstatat(rootLease.descriptor, stagingName.fileSystemRepresentation,
                &finalIdentity, AT_SYMLINK_NOFOLLOW) == 0 &&
        LPSameNode(openedIdentity, finalIdentity) &&
        unlinkat(rootLease.descriptor, stagingName.fileSystemRepresentation,
                 AT_REMOVEDIR) == 0) {
      (void)fsync(rootLease.descriptor);
    }
    [self.stagingRootLeases removeObjectForKey:projectId];
    if (error != nil) *error = LPError(3017, @"Project staging cannot be created");
    return nil;
  }
  self.stagingIdentities[projectId] =
      [NSValue value:&identity withObjCType:@encode(struct stat)];
  NSString *cleanupToken = NSUUID.UUID.UUIDString.lowercaseString;
  NSDictionary *owner = @{
    @"schema_version" : @1,
    @"project_id" : projectId,
    @"cleanup_token" : cleanupToken,
  };
  NSData *ownerData = [NSJSONSerialization dataWithJSONObject:owner
      options:NSJSONWritingSortedKeys error:nil];
  int markerDescriptor = stagingDescriptor < 0 ? -1 : openat(
      stagingDescriptor, LPStagingOwnerMarker.UTF8String,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  BOOL markerSaved = markerDescriptor >= 0 && ownerData.length > 0 &&
      ownerData.length <= LPMaxStagingOwnerBytes &&
      fchmod(markerDescriptor, 0600) == 0 &&
      LPWriteAll(markerDescriptor, ownerData) && fsync(markerDescriptor) == 0 &&
      fsync(stagingDescriptor) == 0;
  if (markerDescriptor >= 0) close(markerDescriptor);
  if (stagingDescriptor >= 0) close(stagingDescriptor);
  if (!markerSaved) {
    struct stat current = {};
    if (fstatat(rootLease.descriptor, stagingName.fileSystemRepresentation,
                &current, AT_SYMLINK_NOFOLLOW) == 0 &&
        LPSameNode(identity, current)) {
      int cleanupDescriptor = openat(rootLease.descriptor,
          stagingName.fileSystemRepresentation,
          O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (cleanupDescriptor >= 0) {
        errno = 0;
        if (unlinkat(cleanupDescriptor, LPStagingOwnerMarker.UTF8String, 0) == 0 ||
            errno == ENOENT) {
          (void)fsync(cleanupDescriptor);
        }
        close(cleanupDescriptor);
      }
      struct stat finalIdentity = {};
      if (fstatat(rootLease.descriptor, stagingName.fileSystemRepresentation,
                  &finalIdentity, AT_SYMLINK_NOFOLLOW) == 0 &&
          LPSameNode(identity, finalIdentity) &&
          unlinkat(rootLease.descriptor, stagingName.fileSystemRepresentation,
                   AT_REMOVEDIR) == 0) {
        (void)fsync(rootLease.descriptor);
      }
    }
    [self.stagingIdentities removeObjectForKey:projectId];
    [self.stagingRootLeases removeObjectForKey:projectId];
    if (error != nil) *error = LPError(3017, @"Project staging cannot be created");
    return nil;
  }
  self.stagingCleanupTokens[projectId] = cleanupToken;
  if (fsync(rootLease.descriptor) != 0) {
    [self removeVisibleStagingDirectory:staging projectId:projectId];
    if (error != nil) *error = LPError(3017, @"Project staging cannot be created");
    return nil;
  }
  return staging;
}

- (BOOL)stagingEntryIsExactForProjectId:(NSString *)projectId
                                  error:(NSError **)error {
  DSHLocalProjectsRootLease *rootLease = self.stagingRootLeases[projectId];
  NSValue *identityValue = self.stagingIdentities[projectId];
  if (rootLease == nil || identityValue == nil ||
      ![self.projectAccess validateProjectsRootLease:rootLease error:nil]) {
    if (error != nil) *error = LPError(3018, @"Project cannot be published");
    return NO;
  }
  NSString *expectedName = [@".staging-" stringByAppendingString:projectId];
  NSString *expectedFold =
      [DSHLocalProjectAccess filesystemFoldedComponent:expectedName];
  struct stat expected = {};
  [identityValue getValue:&expected size:sizeof(expected)];
  int duplicate = openat(rootLease.descriptor, ".",
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  DIR *directory = duplicate < 0 ? nullptr : fdopendir(duplicate);
  if (directory == nullptr) {
    if (duplicate >= 0) close(duplicate);
    if (error != nil) *error = LPError(3018, @"Project cannot be published");
    return NO;
  }
  NSUInteger entries = 0;
  NSUInteger foldedMatches = 0;
  BOOL exactBound = NO;
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
    if (entries > LPMaxStatusEntries) break;
    NSString *candidate = [NSString stringWithUTF8String:entry->d_name];
    if (candidate == nil || ![[DSHLocalProjectAccess
        filesystemFoldedComponent:candidate] isEqual:expectedFold]) {
      continue;
    }
    foldedMatches += 1;
    if ([candidate isEqual:expectedName]) {
      struct stat observed = {};
      exactBound = fstatat(rootLease.descriptor, entry->d_name, &observed,
                           AT_SYMLINK_NOFOLLOW) == 0 &&
          expected.st_dev == observed.st_dev &&
          expected.st_ino == observed.st_ino &&
          expected.st_mode == observed.st_mode;
    }
  }
  closedir(directory);
  BOOL valid = enumerationError == 0 && entries <= LPMaxStatusEntries &&
      foldedMatches == 1 && exactBound;
  if (!valid && error != nil) {
    *error = LPError(3018, @"Project cannot be published");
  }
  return valid;
}

- (void)removeVisibleStagingDirectory:(NSURL *)staging
                            projectId:(NSString *)projectId {
  BOOL safeToRemove = [self stagingEntryIsExactForProjectId:projectId
                                                       error:nil];
  DSHLocalProjectsRootLease *rootLease = self.stagingRootLeases[projectId];
  NSString *cleanupToken = self.stagingCleanupTokens[projectId];
  NSValue *identityValue = self.stagingIdentities[projectId];
  struct stat expected = {};
  if (identityValue != nil) {
    [identityValue getValue:&expected size:sizeof(expected)];
  }
  BOOL rootValid = rootLease != nil &&
      [self.projectAccess validateProjectsRootLease:rootLease error:nil];
  NSString *stagingName = [@".staging-" stringByAppendingString:projectId];
  NSString *sourceName = safeToRemove ? stagingName : nil;
  if (sourceName == nil && rootValid && identityValue != nil) {
    struct stat published = {};
    if (fstatat(rootLease.descriptor, projectId.fileSystemRepresentation,
                &published, AT_SYMLINK_NOFOLLOW) == 0 &&
        LPSameNode(expected, published) && S_ISDIR(published.st_mode)) {
      sourceName = projectId;
    }
  }
  if (sourceName != nil && rootValid && cleanupToken != nil &&
      identityValue != nil) {
    int stagingDescriptor = openat(rootLease.descriptor,
        sourceName.fileSystemRepresentation,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    NSDictionary *owner = stagingDescriptor < 0 ? nil :
        LPReadStagingOwner(stagingDescriptor, expected.st_dev);
    if (stagingDescriptor >= 0) close(stagingDescriptor);
    BOOL owned = [owner[@"project_id"] isEqual:projectId] &&
        [owner[@"cleanup_token"] isEqual:cleanupToken];
    NSString *quarantineName = [@".orphan-"
        stringByAppendingString:cleanupToken];
    BOOL renamed = owned && renameatx_np(
        rootLease.descriptor, sourceName.fileSystemRepresentation,
        rootLease.descriptor, quarantineName.fileSystemRepresentation,
        RENAME_EXCL) == 0;
    if (renamed) {
      (void)fsync(rootLease.descriptor);
      NSUInteger cleanupEntries = 0;
      (void)LPRemoveOwnedDirectoryAtRoot(rootLease.descriptor,
          quarantineName, &expected, cleanupToken, &cleanupEntries,
          LPMaxOrphanCleanupEntriesPerPass);
    }
  }
  [self.stagingIdentities removeObjectForKey:projectId];
  [self.stagingRootLeases removeObjectForKey:projectId];
  [self.stagingCleanupTokens removeObjectForKey:projectId];
  (void)staging;
}

- (BOOL)reconcileOwnedOrphansInRootLease:(DSHLocalProjectsRootLease *)rootLease {
  if (rootLease == nil ||
      ![self.projectAccess validateProjectsRootLease:rootLease error:nil]) {
    return NO;
  }
  int duplicate = openat(rootLease.descriptor, ".",
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  DIR *directory = duplicate < 0 ? nullptr : fdopendir(duplicate);
  if (directory == nullptr) {
    if (duplicate >= 0) close(duplicate);
    return NO;
  }
  NSMutableArray<NSString *> *candidates = [NSMutableArray array];
  NSUInteger entries = 0;
  int enumerationError = 0;
  while (YES) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == nullptr) {
      enumerationError = errno;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 ||
        strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    entries += 1;
    if (entries > LPMaxStatusEntries) break;
    NSString *name = [NSString stringWithUTF8String:entry->d_name];
    BOOL orphan = [name hasPrefix:@".orphan-"] &&
        [DSHLocalProjectAccess isCanonicalProjectId:
            [name substringFromIndex:@".orphan-".length]];
    BOOL staging = [name hasPrefix:@".staging-"] &&
        [DSHLocalProjectAccess isCanonicalProjectId:
            [name substringFromIndex:@".staging-".length]];
    if (orphan || staging ||
        [DSHLocalProjectAccess isCanonicalProjectId:name]) {
      [candidates addObject:name];
    }
  }
  closedir(directory);
  if (enumerationError != 0 || entries > LPMaxStatusEntries) return NO;
  NSUInteger removedCount = 0;
  NSUInteger cleanupEntries = 0;
  for (NSString *name in candidates) {
    BOOL orphan = [name hasPrefix:@".orphan-"];
    BOOL staging = [name hasPrefix:@".staging-"];
    NSString *nameIdentity = orphan
        ? [name substringFromIndex:@".orphan-".length]
        : (staging ? [name substringFromIndex:@".staging-".length] : name);
    struct stat before = {};
    if (fstatat(rootLease.descriptor, name.fileSystemRepresentation, &before,
                AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(before.st_mode) ||
        before.st_dev != rootLease.device) {
      continue;
    }
    int orphanDescriptor = openat(rootLease.descriptor,
        name.fileSystemRepresentation,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened = {};
    BOOL bound = orphanDescriptor >= 0 &&
        fstat(orphanDescriptor, &opened) == 0 && LPSameNode(before, opened);
    NSDictionary *owner = bound
        ? LPReadStagingOwner(orphanDescriptor, rootLease.device) : nil;
    if (orphanDescriptor >= 0) close(orphanDescriptor);
    if (owner == nil) continue;
    NSString *projectId = LPString(owner[@"project_id"]);
    NSString *cleanupToken = LPString(owner[@"cleanup_token"]);
    BOOL bindingValid = [DSHLocalProjectAccess
        isCanonicalProjectId:projectId] &&
        [DSHLocalProjectAccess isCanonicalProjectId:cleanupToken] &&
        (orphan ? [cleanupToken isEqual:nameIdentity]
                : [projectId isEqual:nameIdentity]);
    if (!bindingValid) {
      continue;
    }
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLockToken *cleanupLock =
        [self.projectAccess tryLockProjectIdForWrite:projectId error:nil];
    if (cleanupLock == nil) continue;
    if (!orphan && !staging) {
      int projectDescriptor = openat(rootLease.descriptor,
          name.fileSystemRepresentation,
          O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat openedProject = {};
      BOOL boundProject = projectDescriptor >= 0 &&
          fstat(projectDescriptor, &openedProject) == 0 &&
          LPSameNode(before, openedProject);
      BOOL cleaned = boundProject &&
          [self removePublishedOwnerMarkerAtDescriptor:projectDescriptor];
      if (projectDescriptor >= 0) close(projectDescriptor);
      if (cleaned) (void)fsync(rootLease.descriptor);
      continue;
    }
    if (removedCount >= LPMaxOrphansPerReconcile) break;
    if (!LPRemoveOwnedDirectoryAtRoot(rootLease.descriptor, name,
                                      &before, cleanupToken, &cleanupEntries,
                                      LPMaxOrphanCleanupEntriesPerPass)) {
      if (cleanupEntries >= LPMaxOrphanCleanupEntriesPerPass) break;
      continue;
    }
    removedCount += 1;
  }
  return [self.projectAccess validateProjectsRootLease:rootLease error:nil];
}

- (BOOL)publishStagingDirectory:(NSURL *)staging
                         atRoot:(NSURL *)root
                      projectId:(NSString *)projectId
                          error:(NSError **)error {
  NSString *stagingName = [@".staging-" stringByAppendingString:projectId];
  NSValue *identityValue = self.stagingIdentities[projectId];
  DSHLocalProjectsRootLease *rootLease = self.stagingRootLeases[projectId];
  if (![staging.lastPathComponent isEqual:stagingName] ||
      ![staging.URLByDeletingLastPathComponent.path.stringByStandardizingPath
          isEqual:root.path.stringByStandardizingPath] || identityValue == nil ||
      rootLease == nil ||
      ![rootLease.rootURL.path.stringByStandardizingPath
          isEqual:root.path.stringByStandardizingPath] ||
      ![self stagingEntryIsExactForProjectId:projectId error:nil]) {
    if (error != nil) *error = LPError(3018, @"Project cannot be published");
    return NO;
  }
  int rootDescriptor = dup(rootLease.descriptor);
  int stagingDescriptor = rootDescriptor < 0 ? -1 : openat(
    rootDescriptor, stagingName.fileSystemRepresentation,
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat expected = {};
  struct stat opened = {};
  struct stat pathBefore = {};
  struct stat destinationBefore = {};
  [identityValue getValue:&expected size:sizeof(expected)];
  NSString *cleanupToken = self.stagingCleanupTokens[projectId];
  NSDictionary *owner = stagingDescriptor < 0 ? nil :
      LPReadStagingOwner(stagingDescriptor, expected.st_dev);
  errno = 0;
  BOOL destinationAbsent = rootDescriptor >= 0 &&
    fstatat(rootDescriptor, projectId.fileSystemRepresentation,
            &destinationBefore, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
  BOOL bound = stagingDescriptor >= 0 && fstat(stagingDescriptor, &opened) == 0 &&
    fstatat(rootDescriptor, stagingName.fileSystemRepresentation,
            &pathBefore, AT_SYMLINK_NOFOLLOW) == 0 &&
    expected.st_dev == opened.st_dev && expected.st_ino == opened.st_ino &&
    expected.st_mode == opened.st_mode &&
    opened.st_dev == pathBefore.st_dev && opened.st_ino == pathBefore.st_ino &&
    opened.st_mode == pathBefore.st_mode && destinationAbsent &&
    cleanupToken != nil && [owner[@"project_id"] isEqual:projectId] &&
    [owner[@"cleanup_token"] isEqual:cleanupToken];
  BOOL renamed = bound && renameatx_np(
    rootDescriptor, stagingName.fileSystemRepresentation,
    rootDescriptor, projectId.fileSystemRepresentation, RENAME_EXCL) == 0;
  struct stat published = {};
  BOOL publishedBound = renamed &&
    fstatat(rootDescriptor, projectId.fileSystemRepresentation,
            &published, AT_SYMLINK_NOFOLLOW) == 0 &&
    expected.st_dev == published.st_dev && expected.st_ino == published.st_ino &&
    expected.st_mode == published.st_mode;
  BOOL rootSynced = publishedBound &&
      [self syncPublishedRootDescriptor:rootDescriptor];
  BOOL durable = publishedBound && rootSynced;
  if (renamed && !durable) {
    if (renameatx_np(rootDescriptor, projectId.fileSystemRepresentation,
                     rootDescriptor, stagingName.fileSystemRepresentation,
                     RENAME_EXCL) == 0) {
      (void)fsync(rootDescriptor);
    }
  }
  if (durable) {
    // The root rename is the commit point. Marker removal is recoverable
    // housekeeping; list reconciliation retries it after a crash or I/O error.
    (void)[self removePublishedOwnerMarkerAtDescriptor:stagingDescriptor];
  }
  if (stagingDescriptor >= 0) close(stagingDescriptor);
  if (rootDescriptor >= 0) close(rootDescriptor);
  if (!durable) {
    if (error != nil) *error = LPError(3018, @"Project cannot be published");
    return NO;
  }
  [self.stagingIdentities removeObjectForKey:projectId];
  [self.stagingRootLeases removeObjectForKey:projectId];
  [self.stagingCleanupTokens removeObjectForKey:projectId];
  return YES;
}

- (NSDictionary *)statusForRepository:(git_repository *)repository
                             projectId:(NSString *)projectId
                                  error:(NSError **)error {
  git_status_options options = GIT_STATUS_OPTIONS_INIT;
  options.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
  options.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED
    | GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS
    | GIT_STATUS_OPT_RENAMES_HEAD_TO_INDEX
    | GIT_STATUS_OPT_RENAMES_INDEX_TO_WORKDIR
    | GIT_STATUS_OPT_SORT_CASE_SENSITIVELY;
  git_status_list *statusList = nullptr;
  if (git_status_list_new(&statusList, repository, &options) < 0) {
    if (error != nil) *error = LPError(3019, @"Repository status is unavailable");
    return nil;
  }
  size_t count = git_status_list_entrycount(statusList);
  if (count > LPMaxStatusEntries) {
    git_status_list_free(statusList);
    if (error != nil) *error = LPError(3020, @"Repository has too many changed files");
    return nil;
  }
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray arrayWithCapacity:count];
  BOOL hasConflicts = NO;
  for (size_t index = 0; index < count; index += 1) {
    const git_status_entry *entry = git_status_byindex(statusList, index);
    NSString *path = entry == nullptr ? nil : LPPathForStatusEntry(entry);
    if (path == nil || !LPIsSafeRepositoryPath(path)) {
      git_status_list_free(statusList);
      if (error != nil) *error = LPError(3021, @"Repository contains an unsafe path");
      return nil;
    }
    BOOL conflicted = (entry->status & GIT_STATUS_CONFLICTED) != 0;
    hasConflicts = hasConflicts || conflicted;
    [entries addObject:@{
      @"path": path,
      @"index_status": LPStatusName(entry->status, YES),
      @"worktree_status": LPStatusName(entry->status, NO),
      @"conflicted": @(conflicted),
    }];
  }
  git_status_list_free(statusList);

  NSString *branch = nil;
  NSString *headOid = nil;
  size_t ahead = 0;
  size_t behind = 0;
  git_reference *head = nullptr;
  int headResult = git_repository_head(&head, repository);
  if (headResult == 0 && head != nullptr) {
    const git_oid *target = git_reference_target(head);
    headOid = LPOidString(target);
    if (git_reference_is_branch(head)) {
      const char *shorthand = git_reference_shorthand(head);
      branch = shorthand == nullptr ? nil : [NSString stringWithUTF8String:shorthand];
      git_reference *upstream = nullptr;
      if (git_branch_upstream(&upstream, head) == 0 && upstream != nullptr) {
        const git_oid *upstreamTarget = git_reference_target(upstream);
        if (target != nullptr && upstreamTarget != nullptr) {
          git_graph_ahead_behind(&ahead, &behind, repository, target, upstreamTarget);
        }
        git_reference_free(upstream);
      }
    }
  } else if (headResult == GIT_EUNBORNBRANCH) {
    git_reference *headReference = nullptr;
    if (git_reference_lookup(&headReference, repository, "HEAD") == 0
      && headReference != nullptr) {
      const char *symbolic = git_reference_symbolic_target(headReference);
      if (symbolic != nullptr && strncmp(symbolic, "refs/heads/", 11) == 0) {
        branch = [NSString stringWithUTF8String:symbolic + 11];
      }
      git_reference_free(headReference);
    }
  }
  if (head != nullptr) git_reference_free(head);
  if (branch != nil && (!LPIsSafeRepositoryPath(branch) || [branch containsString:@".."]
    || [branch containsString:@" "])) {
    if (error != nil) *error = LPError(3022, @"Repository branch name is unsafe");
    return nil;
  }
  return @{
    @"schema_version": @1,
    @"project_id": projectId,
    @"branch": branch ?: NSNull.null,
    @"head_oid": headOid ?: NSNull.null,
    @"clean": @(entries.count == 0),
    @"has_conflicts": @(hasConflicts),
    @"ahead": @(ahead),
    @"behind": @(behind),
    @"entries": entries,
  };
}

- (BOOL)repositoryContainsGitlink:(git_repository *)repository {
  git_index *index = nullptr;
  if (git_repository_index(&index, repository) < 0 || index == nullptr) return YES;
  BOOL contains = NO;
  size_t count = git_index_entrycount(index);
  for (size_t item = 0; item < count; item += 1) {
    const git_index_entry *entry = git_index_get_byindex(index, item);
    if (entry != nullptr && entry->mode == GIT_FILEMODE_COMMIT) {
      contains = YES;
      break;
    }
  }
  git_index_free(index);
  return contains;
}

RCT_REMAP_METHOD(list,
                 listWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSURL *root = [self projectsRootCreatingIfNeeded:NO error:&error];
    if (root == nil) {
      if ([error.domain isEqual:DSHLocalProjectAccessErrorDomain] &&
          error.code == DSHLocalProjectAccessErrorRootAbsent) {
        resolve(@{ @"schema_version": @1, @"projects": @[] });
        return;
      }
      reject(@"storage", error.localizedDescription, nil);
      return;
    }
    __attribute__((objc_precise_lifetime)) DSHLocalProjectsRootLease *rootLease =
      self.pendingRootLease;
    self.pendingRootLease = nil;
    if (![self reconcileOwnedOrphansInRootLease:rootLease]) {
      reject(@"storage", @"Project storage is unavailable", nil);
      return;
    }
    int duplicate = rootLease == nil ? -1 : openat(rootLease.descriptor, ".",
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    DIR *children = duplicate < 0 ? nullptr : fdopendir(duplicate);
    if (children == nullptr) {
      if (duplicate >= 0) close(duplicate);
      reject(@"storage", @"Project storage is unavailable", nil);
      return;
    }
    NSMutableArray<NSDictionary *> *projects = [NSMutableArray array];
    BOOL rootChanged = NO;
    struct dirent *entry = nullptr;
    while ((entry = readdir(children)) != nullptr) {
      NSString *projectId = [NSString stringWithUTF8String:entry->d_name];
      if (projectId == nil || [projectId hasPrefix:@"."]) continue;
      if (![DSHLocalProjectAccess isCanonicalProjectId:projectId]) continue;
      if (![self.projectAccess validateProjectsRootLease:rootLease error:nil]) {
        rootChanged = YES;
        break;
      }
      NSDictionary *metadata = nil;
      __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                          mode:DSHLocalProjectAccessModeRead
                                                      metadata:&metadata
                                                         error:nil];
      if (![self.projectAccess validateProjectsRootLease:rootLease error:nil]) {
        rootChanged = YES;
        break;
      }
      if (lease == nil || metadata == nil) continue;
      [projects addObject:metadata];
    }
    closedir(children);
    if (rootChanged) {
      reject(@"storage", @"Project storage changed during listing", nil);
      return;
    }
    [projects sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
      NSComparisonResult date = [right[@"updated_at"] compare:left[@"updated_at"]];
      return date == NSOrderedSame ? [left[@"name"] compare:right[@"name"]] : date;
    }];
    resolve(@{ @"schema_version": @1, @"projects": projects });
  });
}

RCT_REMAP_METHOD(create,
                 createProjectWithName:(id)nameValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *name = LPValidatedProjectName(nameValue, &error);
    NSURL *root = [self projectsRootCreatingIfNeeded:YES error:&error];
    if (name == nil || root == nil) {
      reject(@"validation", error.localizedDescription, nil);
      return;
    }
    NSString *projectId = NSUUID.UUID.UUIDString.lowercaseString;
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLockToken *projectLock = [self.projectAccess
      lockProjectId:projectId
               mode:DSHLocalProjectAccessModeWrite
              error:nil];
    if (projectLock == nil) {
      reject(@"storage", @"Project storage is unavailable", nil);
      return;
    }
    NSURL *staging = [self createStagingDirectoryAtRoot:root projectId:projectId error:&error];
    if (staging == nil) {
      reject(@"storage", error.localizedDescription, nil);
      return;
    }
    NSURL *repoURL = [staging URLByAppendingPathComponent:@"repo" isDirectory:YES];
    git_repository_init_options options = GIT_REPOSITORY_INIT_OPTIONS_INIT;
    options.flags = GIT_REPOSITORY_INIT_NO_REINIT | GIT_REPOSITORY_INIT_MKDIR;
    options.mode = 0700;
    options.initial_head = "main";
    git_repository *repository = nullptr;
    BOOL stagingBoundBefore = [self stagingEntryIsExactForProjectId:projectId
                                                               error:&error];
    int result = stagingBoundBefore
      ? git_repository_init_ext(&repository, repoURL.fileSystemRepresentation,
                                &options)
      : -1;
    BOOL stagingBoundAfter = result == 0 &&
      [self stagingEntryIsExactForProjectId:projectId error:&error];
    NSString *now = LPNow();
    NSDictionary *stored = @{
      @"schema_version": @1,
      @"name": name,
      @"created_at": now,
      @"updated_at": now,
      @"origin_url": NSNull.null,
    };
    BOOL success = stagingBoundAfter && repository != nullptr
      && LPDirectoryIsSafe(repoURL)
      && LPDirectoryIsSafe([repoURL URLByAppendingPathComponent:@".git" isDirectory:YES])
      && [self writeMetadata:stored atProjectDirectory:staging
                   projectId:projectId writeToken:projectLock error:&error]
      && [self publishStagingDirectory:staging atRoot:root projectId:projectId error:&error];
    if (repository != nullptr) git_repository_free(repository);
    if (!success) {
      [self removeVisibleStagingDirectory:staging projectId:projectId];
      reject(@"git", error.localizedDescription ?: @"Project cannot be created", nil);
      return;
    }
    projectLock = nil;
    NSDictionary *metadata = nil;
    DSHLocalProjectLease *publishedLease = [self leaseRepositoryForId:projectId
                                                                 mode:DSHLocalProjectAccessModeRead
                                                             metadata:&metadata
                                                                error:&error];
    if (publishedLease == nil || metadata == nil) {
      reject(@"storage", error.localizedDescription, nil);
      return;
    }
    resolve(metadata);
  });
}

RCT_REMAP_METHOD(clone,
                 clonePublicRepository:(id)urlValue
                 name:(id)nameValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSURL *remoteURL = LPValidatedHTTPSURL(urlValue, &error);
    NSString *name = nil;
    if (nameValue == nil || nameValue == NSNull.null) {
      NSString *derived = remoteURL.path.lastPathComponent.stringByRemovingPercentEncoding;
      if ([derived.lowercaseString hasSuffix:@".git"] && derived.length > 4) {
        derived = [derived substringToIndex:derived.length - 4];
      }
      name = LPValidatedProjectName(derived, nil) ?: @"Repository";
    } else {
      name = LPValidatedProjectName(nameValue, &error);
    }
    NSURL *root = [self projectsRootCreatingIfNeeded:YES error:&error];
    if (remoteURL == nil || name == nil || root == nil) {
      reject(@"validation", error.localizedDescription, nil);
      return;
    }
    NSString *projectId = NSUUID.UUID.UUIDString.lowercaseString;
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLockToken *projectLock = [self.projectAccess
      lockProjectId:projectId
               mode:DSHLocalProjectAccessModeWrite
              error:nil];
    if (projectLock == nil) {
      reject(@"storage", @"Project storage is unavailable", nil);
      return;
    }
    NSURL *staging = [self createStagingDirectoryAtRoot:root projectId:projectId error:&error];
    if (staging == nil) {
      reject(@"storage", error.localizedDescription, nil);
      return;
    }
    NSURL *repoURL = [staging URLByAppendingPathComponent:@"repo" isDirectory:YES];
    git_clone_options options = GIT_CLONE_OPTIONS_INIT;
    options.checkout_opts.checkout_strategy = GIT_CHECKOUT_SAFE;
    options.fetch_opts.follow_redirects = GIT_REMOTE_REDIRECT_NONE;
    options.fetch_opts.proxy_opts.type = GIT_PROXY_NONE;
    options.fetch_opts.callbacks.credentials = LPPublicCloneCredentialCallback;
    git_repository *repository = nullptr;
    BOOL stagingBoundBefore = [self stagingEntryIsExactForProjectId:projectId
                                                               error:&error];
    int result = stagingBoundBefore
      ? git_clone(&repository, remoteURL.absoluteString.UTF8String,
                  repoURL.fileSystemRepresentation, &options)
      : -1;
    BOOL stagingBoundAfter = result == 0 &&
      [self stagingEntryIsExactForProjectId:projectId error:&error];
    NSString *cloneFailure = result < 0
      ? LPSanitizedGitFailure(@"Public clone transport", result) : nil;
    BOOL checkoutSafe = NO;
    if (stagingBoundAfter && repository != nullptr && LPDirectoryIsSafe(repoURL)
      && LPDirectoryIsSafe([repoURL URLByAppendingPathComponent:@".git" isDirectory:YES])
      && ![self repositoryContainsGitlink:repository]) {
      int repoDescriptor = open(repoURL.fileSystemRepresentation,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      NSUInteger entryCount = 0;
      checkoutSafe = repoDescriptor >= 0
        && LPValidateCheckoutTree(repoDescriptor, 0, &entryCount);
      if (repoDescriptor >= 0) close(repoDescriptor);
      if (!checkoutSafe) cloneFailure = @"Public clone validation failed (code 1, class checkout/20)";
    } else if (stagingBoundAfter && repository != nullptr
      && [self repositoryContainsGitlink:repository]) {
      cloneFailure = @"Public clone validation failed (code 2, class submodule/17)";
    }
    NSString *storedOrigin = !stagingBoundAfter || repository == nullptr ? nil
      : [self originURLForRepository:repository error:nil];
    if (stagingBoundAfter && repository != nullptr
      && ![storedOrigin isEqualToString:remoteURL.absoluteString]) {
      checkoutSafe = NO;
      cloneFailure = @"Public clone validation failed (code 3, class config/7)";
    }
    NSString *now = LPNow();
    NSDictionary *stored = @{
      @"schema_version": @1,
      @"name": name,
      @"created_at": now,
      @"updated_at": now,
      @"origin_url": remoteURL.absoluteString,
    };
    BOOL success = checkoutSafe
      && [self writeMetadata:stored atProjectDirectory:staging
                   projectId:projectId writeToken:projectLock error:&error]
      && [self publishStagingDirectory:staging atRoot:root projectId:projectId error:&error];
    if (repository != nullptr) git_repository_free(repository);
    if (!success) {
      [self removeVisibleStagingDirectory:staging projectId:projectId];
      reject(@"git", error.localizedDescription ?: cloneFailure
        ?: @"Public repository cannot be cloned", nil);
      return;
    }
    projectLock = nil;
    NSDictionary *metadata = nil;
    DSHLocalProjectLease *publishedLease = [self leaseRepositoryForId:projectId
                                                                 mode:DSHLocalProjectAccessModeRead
                                                             metadata:&metadata
                                                                error:&error];
    if (publishedLease == nil || metadata == nil) {
      reject(@"storage", error.localizedDescription, nil);
      return;
    }
    resolve(metadata);
  });
}

RCT_REMAP_METHOD(status,
                 statusForProject:(id)projectIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeRead
                                                    metadata:nil
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    NSDictionary *status = [self statusForRepository:repository projectId:projectId error:&error];
    if (status == nil) {
      reject(@"git", error.localizedDescription, nil);
      return;
    }
    resolve(status);
  });
}

- (NSDictionary *)diffForRepository:(git_repository *)repository
                           projectId:(NSString *)projectId
                              staged:(BOOL)staged
                        contextLines:(NSUInteger)contextLines
                               error:(NSError **)error {
  git_diff_options options = GIT_DIFF_OPTIONS_INIT;
  options.context_lines = (uint32_t)contextLines;
  options.max_size = 4 * 1024 * 1024;
  options.flags = GIT_DIFF_INCLUDE_TYPECHANGE | GIT_DIFF_INCLUDE_TYPECHANGE_TREES;
  if (!staged) {
    options.flags |= GIT_DIFF_INCLUDE_UNTRACKED
      | GIT_DIFF_RECURSE_UNTRACKED_DIRS
      | GIT_DIFF_SHOW_UNTRACKED_CONTENT;
  }
  git_index *index = nullptr;
  if (git_repository_index(&index, repository) < 0 || index == nullptr) {
    if (error != nil) *error = LPError(3023, @"Repository index is unavailable");
    return nil;
  }
  git_tree *headTree = nullptr;
  int headTreeResult = LPHeadTree(&headTree, repository);
  if (headTreeResult != 0 && headTreeResult != GIT_EUNBORNBRANCH
    && headTreeResult != GIT_ENOTFOUND) {
    git_index_free(index);
    if (error != nil) *error = LPError(3024, @"Repository history is unavailable");
    return nil;
  }
  git_diff *diff = nullptr;
  int result = staged
    ? git_diff_tree_to_index(&diff, repository, headTree, index, &options)
    : git_diff_index_to_workdir(&diff, repository, index, &options);
  if (headTree != nullptr) git_tree_free(headTree);
  git_index_free(index);
  if (result < 0 || diff == nullptr) {
    if (diff != nullptr) git_diff_free(diff);
    if (error != nil) *error = LPError(3025, @"Repository diff is unavailable");
    return nil;
  }
  size_t count = git_diff_num_deltas(diff);
  if (count > LPMaxDiffFiles) {
    git_diff_free(diff);
    if (error != nil) *error = LPError(3026, @"Repository diff contains too many files");
    return nil;
  }
  NSMutableArray<NSDictionary *> *files = [NSMutableArray arrayWithCapacity:count];
  NSMutableString *patchText = [NSMutableString string];
  NSUInteger usedBytes = 0;
  BOOL truncated = NO;
  for (size_t item = 0; item < count; item += 1) {
    const git_diff_delta *delta = git_diff_get_delta(diff, item);
    const char *rawPath = delta == nullptr ? nullptr
      : (delta->new_file.path ?: delta->old_file.path);
    NSString *path = rawPath == nullptr ? nil : [NSString stringWithUTF8String:rawPath];
    if (delta == nullptr || path == nil || !LPIsSafeRepositoryPath(path)) {
      git_diff_free(diff);
      if (error != nil) *error = LPError(3021, @"Repository contains an unsafe path");
      return nil;
    }
    git_patch *patch = nullptr;
    size_t context = 0;
    size_t additions = 0;
    size_t deletions = 0;
    if (git_patch_from_diff(&patch, diff, item) == 0 && patch != nullptr) {
      git_patch_line_stats(&context, &additions, &deletions, patch);
    }
    [files addObject:@{
      @"path": path,
      @"status": LPDiffStatusName(delta->status),
      @"additions": @(additions),
      @"deletions": @(deletions),
    }];
    if (patch != nullptr && !truncated) {
      git_buf buffer = GIT_BUF_INIT;
      if (git_patch_to_buf(&buffer, patch) == 0 && buffer.ptr != nullptr && buffer.size > 0) {
        NSString *text = [[NSString alloc] initWithBytes:buffer.ptr
                                                  length:buffer.size
                                                encoding:NSUTF8StringEncoding];
        if (text == nil) {
          text = [NSString stringWithFormat:@"Binary or non-UTF-8 diff omitted: %@\n", path];
        }
        NSData *encoded = [text dataUsingEncoding:NSUTF8StringEncoding];
        NSUInteger remaining = LPMaxDiffBytes - usedBytes;
        if (encoded.length <= remaining) {
          [patchText appendString:text];
          usedBytes += encoded.length;
        } else {
          NSUInteger take = remaining;
          NSString *clipped = nil;
          while (take > 0 && clipped == nil) {
            NSData *prefix = [encoded subdataWithRange:NSMakeRange(0, take)];
            clipped = [[NSString alloc] initWithData:prefix encoding:NSUTF8StringEncoding];
            if (clipped == nil) take -= 1;
          }
          if (clipped != nil) [patchText appendString:clipped];
          usedBytes = LPMaxDiffBytes;
          truncated = YES;
        }
      }
      git_buf_dispose(&buffer);
    }
    if (patch != nullptr) git_patch_free(patch);
  }
  git_diff_free(diff);
  return @{
    @"schema_version": @1,
    @"project_id": projectId,
    @"staged": @(staged),
    @"truncated": @(truncated),
    @"patch": patchText,
    @"files": files,
  };
}

RCT_REMAP_METHOD(diff,
                 diffForProject:(id)projectIdValue
                 staged:(BOOL)staged
                 contextLines:(nonnull NSNumber *)contextLinesValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    NSInteger rawContext = contextLinesValue.integerValue;
    if (rawContext < 0 || rawContext > 20) {
      reject(@"validation", @"Diff context is invalid", nil);
      return;
    }
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeRead
                                                    metadata:nil
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    NSDictionary *diff = [self diffForRepository:repository
                                       projectId:projectId
                                          staged:staged
                                    contextLines:(NSUInteger)rawContext
                                           error:&error];
    if (diff == nil) {
      reject(@"git", error.localizedDescription, nil);
      return;
    }
    resolve(diff);
  });
}

RCT_REMAP_METHOD(stageAll,
                 stageAllForProject:(id)projectIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeWrite
                                                    metadata:nil
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    git_index *index = nullptr;
    int result = git_repository_index(&index, repository);
    char wildcard[] = "*";
    char *patterns[] = { wildcard };
    git_strarray pathspec = { patterns, 1 };
    if (result == 0) {
      result = git_index_add_all(index, &pathspec, GIT_INDEX_ADD_DEFAULT, nullptr, nullptr);
    }
    if (result == 0) result = git_index_write(index);
    if (index != nullptr) git_index_free(index);
    NSDictionary *status = result == 0
      ? [self statusForRepository:repository projectId:projectId error:&error] : nil;
    if (result < 0 || status == nil) {
      reject(@"git", error.localizedDescription ?: @"Repository changes cannot be staged", nil);
      return;
    }
    resolve(status);
  });
}

static NSString *LPValidatedCommitMessage(id value, NSError **error) {
  NSString *message = LPString(value);
  NSString *trimmed = [message stringByTrimmingCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSUInteger bytes = [message lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  const char *utf8 = message.UTF8String;
  if (message == nil || trimmed.length == 0 || bytes > LPMaxCommitMessageBytes
    || utf8 == nullptr || strlen(utf8) != bytes) {
    if (error != nil) *error = LPError(3027, @"Commit message is invalid");
    return nil;
  }
  return message;
}

static NSString *LPValidatedAuthorName(id value, NSError **error) {
  NSString *name = [LPString(value) stringByTrimmingCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSUInteger bytes = [name lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  if (name == nil || bytes == 0 || bytes > 255 || LPHasControlCharacter(name)
    || [name containsString:@"<"] || [name containsString:@">"]) {
    if (error != nil) *error = LPError(3028, @"Commit author is invalid");
    return nil;
  }
  return name;
}

static NSString *LPValidatedAuthorEmail(id value, NSError **error) {
  NSString *email = [LPString(value) stringByTrimmingCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSArray<NSString *> *parts = [email componentsSeparatedByString:@"@"];
  NSUInteger bytes = [email lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  if (email == nil || bytes < 3 || bytes > 320 || parts.count != 2
    || [parts[0] length] == 0 || [parts[1] length] == 0
    || LPHasControlCharacter(email)
    || [email rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location
      != NSNotFound || [email containsString:@"<"] || [email containsString:@">"]) {
    if (error != nil) *error = LPError(3029, @"Commit email is invalid");
    return nil;
  }
  return email;
}

RCT_REMAP_METHOD(commit,
                 commitProject:(id)projectIdValue
                 message:(id)messageValue
                 authorName:(id)authorNameValue
                 authorEmail:(id)authorEmailValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    NSString *message = LPValidatedCommitMessage(messageValue, &error);
    NSString *authorName = LPValidatedAuthorName(authorNameValue, &error);
    NSString *authorEmail = LPValidatedAuthorEmail(authorEmailValue, &error);
    if (message == nil || authorName == nil || authorEmail == nil) {
      reject(@"validation", error.localizedDescription, nil);
      return;
    }
    NSDictionary *metadata = nil;
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeWrite
                                                    metadata:&metadata
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    git_index *index = nullptr;
    git_tree *tree = nullptr;
    git_commit *parent = nullptr;
    git_signature *signature = nullptr;
    git_oid treeOid = {};
    git_oid commitOid = {};
    int result = git_repository_index(&index, repository);
    if (result == 0 && git_index_has_conflicts(index)) result = GIT_EUNMERGED;
    if (result == 0) result = git_index_write_tree(&treeOid, index);
    if (result == 0) result = git_tree_lookup(&tree, repository, &treeOid);
    git_reference *head = nullptr;
    int headResult = result == 0 ? git_repository_head(&head, repository) : result;
    if (headResult == 0 && head != nullptr) {
      const git_oid *parentOid = git_reference_target(head);
      if (parentOid == nullptr || git_commit_lookup(&parent, repository, parentOid) < 0) {
        result = -1;
      } else if (git_oid_equal(&treeOid, git_commit_tree_id(parent))) {
        result = GIT_EUNCHANGED;
      }
    } else if (headResult == GIT_EUNBORNBRANCH || headResult == GIT_ENOTFOUND) {
      if (git_index_entrycount(index) == 0) result = GIT_EUNCHANGED;
      else result = 0;
    } else if (headResult < 0) {
      result = headResult;
    }
    if (head != nullptr) git_reference_free(head);
    if (result == 0) result = git_signature_now(
      &signature, authorName.UTF8String, authorEmail.UTF8String);
    const git_commit *parents[] = { parent };
    if (result == 0) {
      result = git_commit_create(&commitOid, repository, "HEAD", signature, signature,
        "UTF-8", message.UTF8String, tree, parent == nullptr ? 0 : 1, parents);
    }
    if (signature != nullptr) git_signature_free(signature);
    if (parent != nullptr) git_commit_free(parent);
    if (tree != nullptr) git_tree_free(tree);
    if (index != nullptr) git_index_free(index);
    if (result != 0) {
      NSString *reason = result == GIT_EUNCHANGED ? @"There are no staged changes"
        : result == GIT_EUNMERGED ? @"Repository has unresolved conflicts"
        : @"Commit cannot be created";
      reject(@"git", reason, nil);
      return;
    }
    [self updatedMetadata:metadata
                originURL:(metadata[@"origin_url"] == NSNull.null ? nil : metadata[@"origin_url"])
                    lease:lease
                    error:nil];
    NSString *summary = [[message componentsSeparatedByCharactersInSet:
      NSCharacterSet.newlineCharacterSet] firstObject];
    resolve(@{
      @"schema_version": @1,
      @"project_id": projectId,
      @"oid": LPOidString(&commitOid),
      @"summary": summary ?: @"",
      @"committed_at": LPNow(),
    });
  });
}

RCT_REMAP_METHOD(setRemote,
                 setRemoteForProject:(id)projectIdValue
                 url:(id)urlValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    NSURL *remoteURL = LPValidatedHTTPSURL(urlValue, &error);
    if (remoteURL == nil) {
      reject(@"validation", error.localizedDescription, nil);
      return;
    }
    NSDictionary *metadata = nil;
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeWrite
                                                    metadata:&metadata
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    git_remote *remote = nullptr;
    int result = git_remote_lookup(&remote, repository, LPRemoteName.UTF8String);
    if (result == GIT_ENOTFOUND) {
      result = git_remote_create(&remote, repository, LPRemoteName.UTF8String,
        remoteURL.absoluteString.UTF8String);
    } else if (result == 0) {
      git_remote_free(remote);
      remote = nullptr;
      result = git_remote_set_url(repository, LPRemoteName.UTF8String,
        remoteURL.absoluteString.UTF8String);
    }
    if (result == 0) {
      int clearPushURL = git_remote_set_pushurl(repository, LPRemoteName.UTF8String, nullptr);
      if (clearPushURL != 0 && clearPushURL != GIT_ENOTFOUND) result = clearPushURL;
    }
    if (remote != nullptr) git_remote_free(remote);
    NSString *storedURL = result == 0
      ? [self originURLForRepository:repository error:&error] : nil;
    if (result < 0 || ![storedURL isEqualToString:remoteURL.absoluteString]) {
      reject(@"git", @"Origin remote cannot be updated", nil);
      return;
    }
    NSDictionary *updated = [self updatedMetadata:metadata
                                        originURL:remoteURL.absoluteString
                                           lease:lease
                                            error:&error];
    if (updated == nil) {
      reject(@"storage", error.localizedDescription, nil);
      return;
    }
    resolve(@{
      @"schema_version": @1,
      @"project_id": projectId,
      @"name": LPRemoteName,
      @"url": remoteURL.absoluteString,
    });
  });
}

RCT_REMAP_METHOD(credentialStatus,
                 credentialStatusForProject:(id)projectIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeRead
                                                    metadata:nil
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    NSDictionary *status = [self credentialStatusForId:projectId
                                             repository:repository
                                                  error:&error];
    if (status == nil) {
      reject(@"keychain", error.localizedDescription, nil);
      return;
    }
    resolve(status);
  });
}

RCT_REMAP_METHOD(presentCredentialPrompt,
                 presentCredentialPromptForProject:(id)projectIdValue
                 locale:(id)localeValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *projectId = LPString(projectIdValue);
  NSString *locale = LPString(localeValue);
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeRead
                                                    metadata:nil
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    NSString *origin = [self originURLForRepository:repository error:&error];
    lease = nil;
    if (origin == nil) {
      reject(@"remote", error.localizedDescription, nil);
      return;
    }
    NSString *host = [NSURLComponents componentsWithString:origin].host.lowercaseString;
    BOOL chinese = [locale isEqualToString:@"zh-CN"];
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *presenter = RCTPresentedViewController();
      if (presenter == nil || [presenter isKindOfClass:UIAlertController.class]) {
        reject(@"presentation", @"Git credential prompt cannot be presented right now", nil);
        return;
      }
      NSString *title = chinese ? @"Git HTTPS 凭据" : @"Git HTTPS credential";
      NSString *message = chinese
        ? [NSString stringWithFormat:@"用于 %@ 的推送。PAT 仅保存在本机 Keychain，永不传回 React Native。", host]
        : [NSString stringWithFormat:@"Used to push to %@. The PAT stays in this device's Keychain and is never returned to React Native.", host];
      UIAlertController *alert = [UIAlertController alertControllerWithTitle:title
        message:message preferredStyle:UIAlertControllerStyleAlert];
      [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = chinese ? @"用户名" : @"Username";
        field.autocorrectionType = UITextAutocorrectionTypeNo;
        field.autocapitalizationType = UITextAutocapitalizationTypeNone;
        field.textContentType = UITextContentTypeUsername;
      }];
      [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
        field.placeholder = @"Personal access token";
        field.secureTextEntry = YES;
        field.autocorrectionType = UITextAutocorrectionTypeNo;
        field.autocapitalizationType = UITextAutocapitalizationTypeNone;
        field.textContentType = UITextContentTypePassword;
      }];
      [alert addAction:[UIAlertAction actionWithTitle:(chinese ? @"取消" : @"Cancel")
        style:UIAlertActionStyleCancel handler:^(__unused UIAlertAction *action) {
          for (UITextField *field in alert.textFields) field.text = @"";
          reject(@"cancelled", @"Git credential prompt was cancelled", nil);
        }]];
      [alert addAction:[UIAlertAction actionWithTitle:(chinese ? @"保存" : @"Save")
        style:UIAlertActionStyleDefault handler:^(__unused UIAlertAction *action) {
          NSString *username = alert.textFields.firstObject.text ?: @"";
          NSString *token = alert.textFields.lastObject.text ?: @"";
          for (UITextField *field in alert.textFields) field.text = @"";
          dispatch_async(self.projectQueue, ^{
            NSError *storeError = nil;
            __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *currentLease = [self leaseRepositoryForId:projectId
                                                                       mode:DSHLocalProjectAccessModeRead
                                                                   metadata:nil
                                                                      error:&storeError];
            NSString *currentOrigin = currentLease == nil ? nil
              : [self originURLForRepository:currentLease.repository error:&storeError];
            NSString *currentHost = [NSURLComponents
              componentsWithString:currentOrigin].host.lowercaseString;
            if (currentOrigin == nil || ![currentHost isEqualToString:host]) {
              currentLease = nil;
              reject(@"remote", @"Origin remote changed before credential save", nil);
              return;
            }
            if (![self storeCredentialForHost:host
                                      username:username
                                         token:token
                                         error:&storeError]) {
              reject(@"credential", storeError.localizedDescription, nil);
              return;
            }
            currentLease = nil;
            resolve(@{
              @"schema_version": @1,
              @"project_id": projectId,
              @"host": host,
              @"configured": @YES,
            });
          });
        }]];
      [presenter presentViewController:alert animated:YES completion:nil];
    });
  });
}

RCT_REMAP_METHOD(clearCredential,
                 clearCredentialForProject:(id)projectIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeRead
                                                    metadata:nil
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    NSString *origin = [self originURLForRepository:repository error:&error];
    if (origin == nil) {
      lease = nil;
      reject(@"remote", error.localizedDescription, nil);
      return;
    }
    NSString *host = [NSURLComponents componentsWithString:origin].host.lowercaseString;
    if (![self deleteCredentialForHost:host error:&error]) {
      lease = nil;
      reject(@"keychain", error.localizedDescription, nil);
      return;
    }
    lease = nil;
    resolve(@{
      @"schema_version": @1,
      @"project_id": projectId,
      @"host": host,
      @"configured": @NO,
    });
  });
}

RCT_REMAP_METHOD(push,
                 pushProject:(id)projectIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.projectQueue, ^{
    NSError *error = nil;
    NSString *projectId = LPString(projectIdValue);
    NSDictionary *metadata = nil;
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease = [self leaseRepositoryForId:projectId
                                                        mode:DSHLocalProjectAccessModeWrite
                                                    metadata:&metadata
                                                       error:&error];
    if (lease == nil) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    git_repository *repository = lease.repository;
    NSString *origin = [self originURLForRepository:repository error:&error];
    NSString *host = [NSURLComponents componentsWithString:origin].host.lowercaseString;
    OSStatus keychainStatus = errSecSuccess;
    NSDictionary *credential = origin == nil ? nil
      : [self credentialForHost:host status:&keychainStatus];
    if (origin == nil || credential == nil) {
      reject(@"credential", @"Git credential is not configured for this host", nil);
      return;
    }
    git_reference *head = nullptr;
    int result = git_repository_head(&head, repository);
    const char *fullRef = result == 0 && head != nullptr ? git_reference_name(head) : nullptr;
    const git_oid *headTarget = head == nullptr ? nullptr : git_reference_target(head);
    BOOL localBranch = fullRef != nullptr && headTarget != nullptr
      && git_reference_is_branch(head) && strncmp(fullRef, "refs/heads/", 11) == 0;
    NSString *branch = localBranch ? [NSString stringWithUTF8String:fullRef + 11] : nil;
    if (!localBranch || branch.length == 0 || !LPIsSafeRepositoryPath(branch)
      || [branch containsString:@".."] || [branch containsString:@" "]) {
      if (head != nullptr) git_reference_free(head);
      reject(@"git", @"A local branch with at least one commit is required", nil);
      return;
    }
    NSString *fullReference = [NSString stringWithUTF8String:fullRef];
    NSString *refspecValue = [NSString stringWithFormat:@"%@:%@", fullReference, fullReference];
    if ([refspecValue hasPrefix:@"+"]) {
      git_reference_free(head);
      reject(@"git", @"Force push is not supported", nil);
      return;
    }
    git_remote *remote = nullptr;
    result = git_remote_lookup(&remote, repository, LPRemoteName.UTF8String);
    if (result == 0) result = git_remote_set_instance_url(remote, origin.UTF8String);
    if (result == 0) result = git_remote_set_instance_pushurl(remote, origin.UTF8String);
    LPCredentialPayload payload = {
      host,
      credential[@"username"],
      credential[@"token"],
      false,
    };
    git_push_options options = GIT_PUSH_OPTIONS_INIT;
    options.follow_redirects = GIT_REMOTE_REDIRECT_NONE;
    options.proxy_opts.type = GIT_PROXY_NONE;
    options.callbacks.credentials = LPKeychainCredentialCallback;
    options.callbacks.payload = &payload;
    char *rawRefspec = const_cast<char *>(refspecValue.UTF8String);
    git_strarray refspecs = { &rawRefspec, 1 };
    if (result == 0) result = git_remote_push(remote, &refspecs, &options);
    NSString *oid = LPOidString(headTarget);
    if (result == 0) {
      NSString *trackingName = [NSString stringWithFormat:@"refs/remotes/origin/%@", branch];
      git_reference *tracking = nullptr;
      if (git_reference_create(&tracking, repository, trackingName.UTF8String,
        headTarget, 1, "rish push") == 0) {
        git_branch_set_upstream(head,
          [[NSString stringWithFormat:@"origin/%@", branch] UTF8String]);
      }
      if (tracking != nullptr) git_reference_free(tracking);
    }
    if (remote != nullptr) git_remote_free(remote);
    git_reference_free(head);
    if (result < 0) {
      reject(@"git", @"Repository cannot be pushed", nil);
      return;
    }
    [self updatedMetadata:metadata
                originURL:origin
                    lease:lease
                    error:nil];
    resolve(@{
      @"schema_version": @1,
      @"project_id": projectId,
      @"remote": LPRemoteName,
      @"branch": branch,
      @"oid": oid,
      @"pushed_at": LPNow(),
    });
  });
}

@end
