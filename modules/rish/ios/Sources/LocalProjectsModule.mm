#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <git2.h>
#include <netinet/in.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *const LPCredentialService = @"dev.zseven.rish.git.https";
static NSString *const LPMetadataFilename = @"project.json";
static NSString *const LPRemoteName = @"origin";
static NSUInteger const LPMaxMetadataBytes = 64 * 1024;
static NSUInteger const LPMaxProjectNameBytes = 120;
static NSUInteger const LPMaxStatusEntries = 10000;
static NSUInteger const LPMaxDiffFiles = 1000;
static NSUInteger const LPMaxDiffBytes = 1024 * 1024;
static NSUInteger const LPMaxCommitMessageBytes = 64 * 1024;
static NSUInteger const LPMaxCheckoutEntries = 100000;
static NSUInteger const LPMaxCheckoutDepth = 64;

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

static BOOL LPIsCanonicalProjectId(NSString *value) {
  if (value.length != 36 || LPHasControlCharacter(value)) return NO;
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:value];
  return uuid != nil && [uuid.UUIDString.lowercaseString isEqualToString:value];
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

static BOOL LPEnsurePrivateDirectory(NSURL *url, NSError **error) {
  struct stat metadata = {};
  if (lstat(url.fileSystemRepresentation, &metadata) == 0) {
    if (!S_ISDIR(metadata.st_mode) || S_ISLNK(metadata.st_mode)) {
      if (error != nil) *error = LPError(3003, @"Project storage is unsafe");
      return NO;
    }
  } else if (errno == ENOENT) {
    if (mkdir(url.fileSystemRepresentation, 0700) != 0) {
      if (error != nil) *error = LPError(3004, @"Project storage cannot be created");
      return NO;
    }
  } else {
    if (error != nil) *error = LPError(3004, @"Project storage is unavailable");
    return NO;
  }
  chmod(url.fileSystemRepresentation, 0700);
  return YES;
}

static BOOL LPValidateCheckoutTree(int directoryDescriptor,
                                   NSUInteger depth,
                                   NSUInteger *entryCount) {
  if (depth > LPMaxCheckoutDepth) return NO;
  int duplicate = dup(directoryDescriptor);
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
@end

@implementation LocalProjectsModule

RCT_EXPORT_MODULE(LocalProjects)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    git_libgit2_init();
    _projectQueue = dispatch_queue_create(
      "dev.zseven.rish.local-projects", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)dealloc {
  git_libgit2_shutdown();
}

- (NSURL *)projectsRoot:(NSError **)error {
  NSError *internalError = nil;
  NSURL *support = [[NSFileManager defaultManager]
    URLForDirectory:NSApplicationSupportDirectory
           inDomain:NSUserDomainMask
  appropriateForURL:nil
             create:YES
              error:&internalError];
  if (support == nil || !LPDirectoryIsSafe(support)) {
    if (error != nil) *error = LPError(3005, @"Project storage is unavailable");
    return nil;
  }
  NSURL *workspace = [support URLByAppendingPathComponent:@"workspace" isDirectory:YES];
  NSURL *projects = [workspace URLByAppendingPathComponent:@"projects" isDirectory:YES];
  if (!LPEnsurePrivateDirectory(workspace, error)
    || !LPEnsurePrivateDirectory(projects, error)) return nil;
  [projects setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  [[NSFileManager defaultManager] setAttributes:@{
    NSFilePosixPermissions: @0700,
    NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication,
  } ofItemAtPath:projects.path error:nil];
  return projects;
}

- (NSURL *)projectDirectoryForId:(NSString *)projectId error:(NSError **)error {
  if (!LPIsCanonicalProjectId(projectId)) {
    if (error != nil) *error = LPError(3006, @"Project identifier is invalid");
    return nil;
  }
  NSURL *root = [self projectsRoot:error];
  if (root == nil) return nil;
  NSURL *project = [root URLByAppendingPathComponent:projectId isDirectory:YES];
  if (!LPDirectoryIsSafe(project)) {
    if (error != nil) *error = LPError(3007, @"Project is unavailable");
    return nil;
  }
  return project;
}

- (git_repository *)openRepositoryForId:(NSString *)projectId
                               metadata:(NSDictionary **)metadata
                                  error:(NSError **)error {
  NSURL *project = [self projectDirectoryForId:projectId error:error];
  if (project == nil) return nullptr;
  NSURL *repoURL = [project URLByAppendingPathComponent:@"repo" isDirectory:YES];
  NSURL *gitURL = [repoURL URLByAppendingPathComponent:@".git" isDirectory:YES];
  if (!LPDirectoryIsSafe(repoURL) || !LPDirectoryIsSafe(gitURL)) {
    if (error != nil) *error = LPError(3008, @"Repository storage is unsafe");
    return nullptr;
  }
  git_repository *repository = nullptr;
  int result = git_repository_open_ext(
    &repository, repoURL.fileSystemRepresentation, GIT_REPOSITORY_OPEN_NO_SEARCH, nullptr);
  if (result < 0 || repository == nullptr || git_repository_is_bare(repository)) {
    if (repository != nullptr) git_repository_free(repository);
    if (error != nil) *error = LPError(3009, @"Repository cannot be opened");
    return nullptr;
  }
  const char *workdir = git_repository_workdir(repository);
  NSString *actual = workdir == nullptr ? nil
    : [[NSFileManager defaultManager] stringWithFileSystemRepresentation:workdir
                                                                 length:strlen(workdir)];
  NSString *expected = [repoURL.path stringByStandardizingPath];
  if (actual == nil || ![[actual stringByStandardizingPath] isEqualToString:expected]) {
    git_repository_free(repository);
    if (error != nil) *error = LPError(3008, @"Repository storage is unsafe");
    return nullptr;
  }
  if (metadata != nullptr) {
    *metadata = [self readMetadataAtProjectDirectory:project projectId:projectId error:error];
    if (*metadata == nil) {
      git_repository_free(repository);
      return nullptr;
    }
  }
  return repository;
}

- (NSDictionary *)readMetadataAtProjectDirectory:(NSURL *)project
                                        projectId:(NSString *)projectId
                                            error:(NSError **)error {
  NSURL *url = [project URLByAppendingPathComponent:LPMetadataFilename];
  struct stat metadata = {};
  if (lstat(url.fileSystemRepresentation, &metadata) != 0 || !S_ISREG(metadata.st_mode)
    || S_ISLNK(metadata.st_mode) || metadata.st_size < 2
    || metadata.st_size > (off_t)LPMaxMetadataBytes) {
    if (error != nil) *error = LPError(3010, @"Project metadata is invalid");
    return nil;
  }
  NSData *data = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:nil];
  NSDictionary *object = LPDictionary(data == nil ? nil
    : [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]);
  NSString *name = LPValidatedProjectName(object[@"name"], nil);
  NSString *createdAt = LPString(object[@"created_at"]);
  NSString *updatedAt = LPString(object[@"updated_at"]);
  id originValue = object[@"origin_url"];
  NSString *origin = originValue == NSNull.null ? nil : LPString(originValue);
  if (object == nil || name == nil || createdAt.length < 20 || createdAt.length > 64
    || updatedAt.length < 20 || updatedAt.length > 64
    || LPHasControlCharacter(createdAt) || LPHasControlCharacter(updatedAt)
    || (origin != nil && LPValidatedHTTPSURL(origin, nil) == nil)) {
    if (error != nil) *error = LPError(3010, @"Project metadata is invalid");
    return nil;
  }
  return @{
    @"schema_version": @1,
    @"id": projectId,
    @"name": name,
    @"workspace_path": [NSString stringWithFormat:@"projects/%@/repo", projectId],
    @"created_at": createdAt,
    @"updated_at": updatedAt,
    @"origin_url": origin ?: NSNull.null,
  };
}

- (BOOL)writeMetadata:(NSDictionary *)metadata
    atProjectDirectory:(NSURL *)project
                 error:(NSError **)error {
  NSData *data = [NSJSONSerialization dataWithJSONObject:metadata
                                                  options:NSJSONWritingSortedKeys
                                                    error:nil];
  if (data == nil || data.length > LPMaxMetadataBytes) {
    if (error != nil) *error = LPError(3011, @"Project metadata cannot be saved");
    return NO;
  }
  NSURL *url = [project URLByAppendingPathComponent:LPMetadataFilename];
  if (![data writeToURL:url options:NSDataWritingAtomic error:nil]) {
    if (error != nil) *error = LPError(3011, @"Project metadata cannot be saved");
    return NO;
  }
  chmod(url.fileSystemRepresentation, 0600);
  return YES;
}

- (NSDictionary *)updatedMetadata:(NSDictionary *)metadata
                         originURL:(NSString *)origin
                  projectDirectory:(NSURL *)project
                             error:(NSError **)error {
  NSDictionary *stored = @{
    @"schema_version": @1,
    @"name": metadata[@"name"],
    @"created_at": metadata[@"created_at"],
    @"updated_at": LPNow(),
    @"origin_url": origin ?: NSNull.null,
  };
  if (![self writeMetadata:stored atProjectDirectory:project error:error]) return nil;
  return [self readMetadataAtProjectDirectory:project projectId:metadata[@"id"] error:error];
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
  NSURL *staging = [root URLByAppendingPathComponent:
    [@".staging-" stringByAppendingString:projectId] isDirectory:YES];
  if (mkdir(staging.fileSystemRepresentation, 0700) != 0) {
    if (error != nil) *error = LPError(3017, @"Project staging cannot be created");
    return nil;
  }
  return staging;
}

- (BOOL)publishStagingDirectory:(NSURL *)staging
                         atRoot:(NSURL *)root
                      projectId:(NSString *)projectId
                          error:(NSError **)error {
  NSURL *destination = [root URLByAppendingPathComponent:projectId isDirectory:YES];
  struct stat metadata = {};
  if (lstat(destination.fileSystemRepresentation, &metadata) == 0 || errno != ENOENT
    || rename(staging.fileSystemRepresentation, destination.fileSystemRepresentation) != 0) {
    if (error != nil) *error = LPError(3018, @"Project cannot be published");
    return NO;
  }
  int rootDescriptor = open(root.fileSystemRepresentation,
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (rootDescriptor >= 0) {
    fsync(rootDescriptor);
    close(rootDescriptor);
  }
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
    NSURL *root = [self projectsRoot:&error];
    if (root == nil) {
      reject(@"storage", error.localizedDescription, nil);
      return;
    }
    NSArray<NSURL *> *children = [[NSFileManager defaultManager]
      contentsOfDirectoryAtURL:root
    includingPropertiesForKeys:nil
                       options:NSDirectoryEnumerationSkipsHiddenFiles
                         error:nil];
    NSMutableArray<NSDictionary *> *projects = [NSMutableArray array];
    for (NSURL *child in children) {
      NSString *projectId = child.lastPathComponent.lowercaseString;
      if (!LPIsCanonicalProjectId(projectId)) continue;
      NSDictionary *metadata = nil;
      git_repository *repository = [self openRepositoryForId:projectId
                                                    metadata:&metadata
                                                       error:nil];
      if (repository == nullptr || metadata == nil) continue;
      git_repository_free(repository);
      [projects addObject:metadata];
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
    NSURL *root = [self projectsRoot:&error];
    if (name == nil || root == nil) {
      reject(@"validation", error.localizedDescription, nil);
      return;
    }
    NSString *projectId = NSUUID.UUID.UUIDString.lowercaseString;
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
    int result = git_repository_init_ext(&repository, repoURL.fileSystemRepresentation, &options);
    NSString *now = LPNow();
    NSDictionary *stored = @{
      @"schema_version": @1,
      @"name": name,
      @"created_at": now,
      @"updated_at": now,
      @"origin_url": NSNull.null,
    };
    BOOL success = result == 0 && repository != nullptr
      && LPDirectoryIsSafe(repoURL)
      && LPDirectoryIsSafe([repoURL URLByAppendingPathComponent:@".git" isDirectory:YES])
      && [self writeMetadata:stored atProjectDirectory:staging error:&error]
      && [self publishStagingDirectory:staging atRoot:root projectId:projectId error:&error];
    if (repository != nullptr) git_repository_free(repository);
    if (!success) {
      [[NSFileManager defaultManager] removeItemAtURL:staging error:nil];
      reject(@"git", error.localizedDescription ?: @"Project cannot be created", nil);
      return;
    }
    NSURL *project = [root URLByAppendingPathComponent:projectId isDirectory:YES];
    NSDictionary *metadata = [self readMetadataAtProjectDirectory:project
                                                        projectId:projectId
                                                            error:&error];
    if (metadata == nil) {
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
    NSURL *root = [self projectsRoot:&error];
    if (remoteURL == nil || name == nil || root == nil) {
      reject(@"validation", error.localizedDescription, nil);
      return;
    }
    NSString *projectId = NSUUID.UUID.UUIDString.lowercaseString;
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
    int result = git_clone(&repository, remoteURL.absoluteString.UTF8String,
      repoURL.fileSystemRepresentation, &options);
    NSString *cloneFailure = result < 0
      ? LPSanitizedGitFailure(@"Public clone transport", result) : nil;
    BOOL checkoutSafe = NO;
    if (result == 0 && repository != nullptr && LPDirectoryIsSafe(repoURL)
      && LPDirectoryIsSafe([repoURL URLByAppendingPathComponent:@".git" isDirectory:YES])
      && ![self repositoryContainsGitlink:repository]) {
      int repoDescriptor = open(repoURL.fileSystemRepresentation,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      NSUInteger entryCount = 0;
      checkoutSafe = repoDescriptor >= 0
        && LPValidateCheckoutTree(repoDescriptor, 0, &entryCount);
      if (repoDescriptor >= 0) close(repoDescriptor);
      if (!checkoutSafe) cloneFailure = @"Public clone validation failed (code 1, class checkout/20)";
    } else if (result == 0 && repository != nullptr
      && [self repositoryContainsGitlink:repository]) {
      cloneFailure = @"Public clone validation failed (code 2, class submodule/17)";
    }
    NSString *storedOrigin = repository == nullptr ? nil
      : [self originURLForRepository:repository error:nil];
    if (result == 0 && repository != nullptr
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
      && [self writeMetadata:stored atProjectDirectory:staging error:&error]
      && [self publishStagingDirectory:staging atRoot:root projectId:projectId error:&error];
    if (repository != nullptr) git_repository_free(repository);
    if (!success) {
      [[NSFileManager defaultManager] removeItemAtURL:staging error:nil];
      reject(@"git", error.localizedDescription ?: cloneFailure
        ?: @"Public repository cannot be cloned", nil);
      return;
    }
    NSURL *project = [root URLByAppendingPathComponent:projectId isDirectory:YES];
    NSDictionary *metadata = [self readMetadataAtProjectDirectory:project
                                                        projectId:projectId
                                                            error:&error];
    if (metadata == nil) {
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
    git_repository *repository = [self openRepositoryForId:projectId metadata:nil error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    NSDictionary *status = [self statusForRepository:repository projectId:projectId error:&error];
    git_repository_free(repository);
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
    git_repository *repository = [self openRepositoryForId:projectId metadata:nil error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    NSDictionary *diff = [self diffForRepository:repository
                                       projectId:projectId
                                          staged:staged
                                    contextLines:(NSUInteger)rawContext
                                           error:&error];
    git_repository_free(repository);
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
    git_repository *repository = [self openRepositoryForId:projectId metadata:nil error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
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
    git_repository_free(repository);
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
    git_repository *repository = [self openRepositoryForId:projectId
                                                  metadata:&metadata
                                                     error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
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
      git_repository_free(repository);
      NSString *reason = result == GIT_EUNCHANGED ? @"There are no staged changes"
        : result == GIT_EUNMERGED ? @"Repository has unresolved conflicts"
        : @"Commit cannot be created";
      reject(@"git", reason, nil);
      return;
    }
    git_repository_free(repository);
    NSURL *project = [self projectDirectoryForId:projectId error:nil];
    [self updatedMetadata:metadata
                originURL:(metadata[@"origin_url"] == NSNull.null ? nil : metadata[@"origin_url"])
         projectDirectory:project
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
    git_repository *repository = [self openRepositoryForId:projectId
                                                  metadata:&metadata
                                                     error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
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
    git_repository_free(repository);
    if (result < 0 || ![storedURL isEqualToString:remoteURL.absoluteString]) {
      reject(@"git", @"Origin remote cannot be updated", nil);
      return;
    }
    NSURL *project = [self projectDirectoryForId:projectId error:&error];
    NSDictionary *updated = [self updatedMetadata:metadata
                                        originURL:remoteURL.absoluteString
                                 projectDirectory:project
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
    git_repository *repository = [self openRepositoryForId:projectId metadata:nil error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    NSDictionary *status = [self credentialStatusForId:projectId
                                             repository:repository
                                                  error:&error];
    git_repository_free(repository);
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
    git_repository *repository = [self openRepositoryForId:projectId metadata:nil error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    NSString *origin = [self originURLForRepository:repository error:&error];
    git_repository_free(repository);
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
            if (![self storeCredentialForHost:host
                                      username:username
                                         token:token
                                         error:&storeError]) {
              reject(@"credential", storeError.localizedDescription, nil);
              return;
            }
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
    git_repository *repository = [self openRepositoryForId:projectId metadata:nil error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    NSString *origin = [self originURLForRepository:repository error:&error];
    git_repository_free(repository);
    if (origin == nil) {
      reject(@"remote", error.localizedDescription, nil);
      return;
    }
    NSString *host = [NSURLComponents componentsWithString:origin].host.lowercaseString;
    if (![self deleteCredentialForHost:host error:&error]) {
      reject(@"keychain", error.localizedDescription, nil);
      return;
    }
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
    git_repository *repository = [self openRepositoryForId:projectId
                                                  metadata:&metadata
                                                     error:&error];
    if (repository == nullptr) {
      reject(@"project", error.localizedDescription, nil);
      return;
    }
    NSString *origin = [self originURLForRepository:repository error:&error];
    NSString *host = [NSURLComponents componentsWithString:origin].host.lowercaseString;
    OSStatus keychainStatus = errSecSuccess;
    NSDictionary *credential = origin == nil ? nil
      : [self credentialForHost:host status:&keychainStatus];
    if (origin == nil || credential == nil) {
      git_repository_free(repository);
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
      git_repository_free(repository);
      reject(@"git", @"A local branch with at least one commit is required", nil);
      return;
    }
    NSString *fullReference = [NSString stringWithUTF8String:fullRef];
    NSString *refspecValue = [NSString stringWithFormat:@"%@:%@", fullReference, fullReference];
    if ([refspecValue hasPrefix:@"+"]) {
      git_reference_free(head);
      git_repository_free(repository);
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
    git_repository_free(repository);
    if (result < 0) {
      reject(@"git", @"Repository cannot be pushed", nil);
      return;
    }
    NSURL *project = [self projectDirectoryForId:projectId error:nil];
    [self updatedMetadata:metadata
                originURL:origin
         projectDirectory:project
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
