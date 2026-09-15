#import "RuntimeEnvironmentStore.h"
#import "RuntimeEnvironmentDownload.h"
#import "LocalGuestModule.h"
#include <copyfile.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/clonefile.h>
#include <unistd.h>

@interface DSHRuntimeEnvironmentLease ()
@property(nonatomic, copy, readwrite) NSString *environmentId;
@property(nonatomic, copy, readwrite) NSDictionary *manifest;
@property(nonatomic, strong, readwrite) NSURL *diskURL;
@property(nonatomic, copy) NSString *leaseId;
@end
@implementation DSHRuntimeEnvironmentLease
@end

@interface DSHRuntimeEnvironmentStore ()
@property(nonatomic, strong) NSURL *rootURL;
@property(nonatomic, strong) NSURL *installedURL;
@property(nonatomic, strong) NSURL *stagingURL;
@property(nonatomic, strong) NSURL *leasesURL;
@property(nonatomic, copy) NSString *kernelSHA256;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *catalog;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *installed;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *selections;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *states;
@property(nonatomic, strong) NSMutableDictionary<NSString *, DSHRuntimeEnvironmentLease *> *leases;
@property(nonatomic, strong) DSHRuntimeEnvironmentDownload *download;
@property(nonatomic, strong) NSFileCoordinator *importCoordinator;
@property(nonatomic, copy) NSString *activeToken;
@property(nonatomic, copy) NSString *activeEnvironmentId;
@property(nonatomic) BOOL activeCancelled;
@property(nonatomic) BOOL available;
@property(nonatomic, strong) dispatch_queue_t worker;
@end

static BOOL RegularFile(NSURL *url, uint64_t expected) {
  struct stat stat = {};
  return lstat(url.fileSystemRepresentation, &stat) == 0 && S_ISREG(stat.st_mode)
      && !S_ISLNK(stat.st_mode) && stat.st_size >= 0 && (uint64_t)stat.st_size == expected;
}
static BOOL Directory(NSURL *url) {
  struct stat stat = {};
  return lstat(url.fileSystemRepresentation, &stat) == 0 && S_ISDIR(stat.st_mode) && !S_ISLNK(stat.st_mode);
}
static BOOL SyncDirectory(NSURL *url) {
  int fd = open(url.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return NO;
  BOOL ok = fsync(fd) == 0; close(fd); return ok;
}
static BOOL WriteJSON(NSDictionary *value, NSURL *url) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  if (!data || data.length > 1024 * 1024) return NO;
  NSURL *temporary = [url.URLByDeletingLastPathComponent URLByAppendingPathComponent:NSUUID.UUID.UUIDString.lowercaseString];
  int fd = open(temporary.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return NO;
  size_t written = 0;
  while (written < data.length) {
    ssize_t count = write(fd, (const uint8_t *)data.bytes + written, data.length - written);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    written += count;
  }
  BOOL ok = written == data.length && DSHEnvironmentProtectFile(temporary) && fsync(fd) == 0;
  close(fd);
  if (ok) ok = rename(temporary.fileSystemRepresentation, url.fileSystemRepresentation) == 0;
  if (ok) ok = SyncDirectory(url.URLByDeletingLastPathComponent);
  if (!ok) unlink(temporary.fileSystemRepresentation);
  return ok;
}
static BOOL CatalogRecord(id record, NSString *kernel) {
  if (![record isKindOfClass:NSDictionary.class] || ![[NSSet setWithArray:[record allKeys]]
      isEqual:[NSSet setWithArray:@[@"manifest",@"url",@"package_sha256",@"package_bytes"]]]) return NO;
  id size = record[@"package_bytes"], digest = record[@"package_sha256"];
  return DSHEnvironmentValidateManifest(record[@"manifest"], kernel) && DSHEnvironmentValidHTTPSURL(record[@"url"])
      && [digest isKindOfClass:NSString.class] && [digest length] == 64
      && [digest rangeOfString:@"^[0-9a-f]{64}$" options:NSRegularExpressionSearch].location != NSNotFound
      && [size isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)size) != CFBooleanGetTypeID()
      && [size doubleValue] == (double)[size unsignedLongLongValue]
      && [size unsignedLongLongValue] > 0 && [size unsignedLongLongValue] <= 768ULL * 1024 * 1024;
}

@implementation DSHRuntimeEnvironmentStore
+ (instancetype)sharedStore {
  static DSHRuntimeEnvironmentStore *store;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURL *support = [NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory
        inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:nil];
    NSURL *root = [support URLByAppendingPathComponent:@"runtime-environments" isDirectory:YES];
    NSURL *catalogURL = [NSBundle.mainBundle URLForResource:@"RuntimeEnvironmentCatalog" withExtension:@"json"];
    NSData *data = catalogURL ? DSHEnvironmentReadSmallFile(catalogURL, 256 * 1024) : nil;
    NSDictionary *catalog = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    store = [[self alloc] initWithRootURL:root catalog:catalog ?: @{} kernelSHA256:DSHGuestKernelSha256];
  });
  return store;
}
- (instancetype)initWithRootURL:(NSURL *)rootURL catalog:(NSDictionary *)catalog kernelSHA256:(NSString *)kernelSHA256 {
  self = [super init];
  if (!self) return nil;
  _rootURL = rootURL; _kernelSHA256 = [kernelSHA256 copy];
  _installedURL = [rootURL URLByAppendingPathComponent:@"installed" isDirectory:YES];
  _stagingURL = [rootURL URLByAppendingPathComponent:@"staging" isDirectory:YES];
  _leasesURL = [rootURL URLByAppendingPathComponent:@"leases" isDirectory:YES];
  _catalog = [NSMutableDictionary dictionary]; _installed = [NSMutableDictionary dictionary];
  _selections = [NSMutableDictionary dictionary]; _states = [NSMutableDictionary dictionary];
  _leases = [NSMutableDictionary dictionary];
  _worker = dispatch_queue_create("tech.zseven.rish.environments", DISPATCH_QUEUE_SERIAL);
  _available = rootURL && Directory(rootURL.URLByDeletingLastPathComponent) && DSHEnvironmentEnsureDirectory(rootURL)
      && DSHEnvironmentEnsureDirectory(_installedURL) && DSHEnvironmentEnsureDirectory(_stagingURL)
      && DSHEnvironmentEnsureDirectory(_leasesURL);
  if (!_available) return self;
  if ([catalog isKindOfClass:NSDictionary.class] && [catalog[@"schema_version"] isEqual:@1]
      && [catalog[@"environments"] isKindOfClass:NSArray.class] && [catalog[@"environments"] count] <= 128) {
    for (id record in catalog[@"environments"]) {
      if (CatalogRecord(record, kernelSHA256)) _catalog[record[@"manifest"][@"environment_id"]] = record;
    }
  }
  // No unfinished download or old run disk is ever eligible for selection after a restart.
  for (NSURL *directory in @[_stagingURL, _leasesURL]) {
    NSArray *items = [NSFileManager.defaultManager contentsOfDirectoryAtURL:directory includingPropertiesForKeys:nil options:0 error:nil];
    for (NSURL *item in items) [NSFileManager.defaultManager removeItemAtURL:item error:nil];
  }
  NSArray *items = [NSFileManager.defaultManager contentsOfDirectoryAtURL:_installedURL includingPropertiesForKeys:nil options:0 error:nil];
  for (NSURL *item in items) {
    if (_installed.count >= 32) break;
    if (!DSHEnvironmentValidId(item.lastPathComponent) || !Directory(item)) continue;
    NSData *data = DSHEnvironmentReadSmallFile([item URLByAppendingPathComponent:@"manifest.json"], 16384);
    NSDictionary *manifest = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (DSHEnvironmentValidateManifest(manifest, kernelSHA256)
        && [manifest[@"environment_id"] isEqual:item.lastPathComponent]
        && RegularFile([item URLByAppendingPathComponent:@"disk.ext4"], [manifest[@"disk_bytes"] unsignedLongLongValue]))
      _installed[item.lastPathComponent] = manifest;
  }
  NSData *data = DSHEnvironmentReadSmallFile([rootURL URLByAppendingPathComponent:@"selections.json"], 1024 * 1024);
  NSDictionary *saved = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if ([saved isKindOfClass:NSDictionary.class] && saved.count <= 1024) {
    [saved enumerateKeysAndObjectsUsingBlock:^(id workspace, id env, BOOL *stop) {
      if (DSHEnvironmentValidWorkspaceId(workspace) && DSHEnvironmentValidId(env)
          && (self.catalog[env] || self.installed[env])) self.selections[workspace] = env;
    }];
  }
  return self;
}
- (NSDictionary *)descriptor:(NSString *)environmentId {
  NSDictionary *manifest = self.installed[environmentId] ?: self.catalog[environmentId][@"manifest"];
  if (!manifest) return nil;
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  for (NSString *key in @[@"schema_version",@"environment_id",@"family",@"display_name",@"version",@"architecture",@"disk_bytes",@"minimum_memory_mib"])
    result[key] = manifest[key];
  NSDictionary *state = self.states[environmentId];
  result[@"state"] = state[@"state"] ?: (self.installed[environmentId] ? @"installed" : @"not_installed");
  result[@"downloaded_bytes"] = state[@"downloaded_bytes"] ?: @0;
  result[@"total_bytes"] = state[@"total_bytes"] ?: self.catalog[environmentId][@"package_bytes"] ?: NSNull.null;
  result[@"error_code"] = state[@"error_code"] ?: NSNull.null;
  return result;
}
- (NSDictionary *)listEnvironmentsForWorkspaceId:(NSString *)workspaceId error:(NSError **)error {
  @synchronized(self) {
    if (!self.available || (workspaceId && !DSHEnvironmentValidWorkspaceId(workspaceId))) {
      if (error) *error = DSHEnvironmentError(self.available ? @"E_ENV_BAD_ARGUMENTS" : @"E_ENV_STORAGE"); return nil;
    }
    NSMutableSet *ids = [NSMutableSet setWithArray:self.catalog.allKeys]; [ids addObjectsFromArray:self.installed.allKeys];
    NSMutableArray *environments = [NSMutableArray array];
    for (NSString *env in [ids.allObjects sortedArrayUsingSelector:@selector(compare:)]) [environments addObject:[self descriptor:env]];
    return @{@"schema_version":@1,@"environments":environments,
        @"selected_environment_id":workspaceId ? self.selections[workspaceId] ?: NSNull.null : NSNull.null};
  }
}
- (BOOL)selectEnvironmentId:(NSString *)environmentId workspaceId:(NSString *)workspaceId error:(NSError **)error {
  @synchronized(self) {
    NSString *code = nil;
    if (!DSHEnvironmentValidId(environmentId) || !DSHEnvironmentValidWorkspaceId(workspaceId)) code = @"E_ENV_BAD_ARGUMENTS";
    else if (!self.available) code = @"E_ENV_STORAGE";
    else if (!self.catalog[environmentId] && !self.installed[environmentId]) code = @"E_ENV_NOT_FOUND";
    else if (!self.selections[workspaceId] && self.selections.count >= 1024) code = @"E_ENV_LIMIT";
    if (code) { if (error) *error = DSHEnvironmentError(code); return NO; }
    NSMutableDictionary *next = [self.selections mutableCopy]; next[workspaceId] = environmentId;
    if (!WriteJSON(next, [self.rootURL URLByAppendingPathComponent:@"selections.json"])) {
      if (error) *error = DSHEnvironmentError(@"E_ENV_STORAGE"); return NO;
    }
    self.selections = next; return YES;
  }
}
- (BOOL)removeEnvironmentId:(NSString *)environmentId error:(NSError **)error {
  @synchronized(self) {
    NSString *code = nil;
    if (!DSHEnvironmentValidId(environmentId)) code = @"E_ENV_BAD_ARGUMENTS";
    else if (!self.installed[environmentId]) code = @"E_ENV_NOT_FOUND";
    else if ([self.activeEnvironmentId isEqual:environmentId]) code = @"E_ENV_BUSY";
    for (DSHRuntimeEnvironmentLease *lease in self.leases.allValues) {
      if ([lease.environmentId isEqual:environmentId]) code = @"E_ENV_IN_USE";
    }
    if (code) { if (error) *error = DSHEnvironmentError(code); return NO; }
    NSURL *source = [self.installedURL URLByAppendingPathComponent:environmentId];
    NSURL *trash = [self.stagingURL URLByAppendingPathComponent:NSUUID.UUID.UUIDString.lowercaseString];
    if (rename(source.fileSystemRepresentation, trash.fileSystemRepresentation) != 0) {
      if (error) *error = DSHEnvironmentError(@"E_ENV_STORAGE"); return NO;
    }
    [self.installed removeObjectForKey:environmentId]; [self.states removeObjectForKey:environmentId];
    // A catalog selection remains useful: the next explicit Run can reinstall this one package.
    if (!self.catalog[environmentId]) {
      for (NSString *workspace in [self.selections.allKeys copy]) {
        if ([self.selections[workspace] isEqual:environmentId]) [self.selections removeObjectForKey:workspace];
      }
      WriteJSON(self.selections, [self.rootURL URLByAppendingPathComponent:@"selections.json"]);
    }
    SyncDirectory(self.installedURL);
    [NSFileManager.defaultManager removeItemAtURL:trash error:nil]; return YES;
  }
}
- (NSString *)beginEnvironment:(NSString *)environmentId completion:(DSHEnvironmentCompletion)completion {
  @synchronized(self) {
    if (!self.available) { completion(nil, DSHEnvironmentError(@"E_ENV_STORAGE")); return nil; }
    if (environmentId && self.installed[environmentId]) { completion([self descriptor:environmentId], nil); return nil; }
    if (self.activeToken) { completion(nil, DSHEnvironmentError(@"E_ENV_BUSY")); return nil; }
    if (self.installed.count >= 32) { completion(nil, DSHEnvironmentError(@"E_ENV_LIMIT")); return nil; }
    self.activeToken = NSUUID.UUID.UUIDString.lowercaseString;
    self.activeEnvironmentId = environmentId; self.activeCancelled = NO;
    if (environmentId) self.states[environmentId] = @{@"state":@"downloading",@"downloaded_bytes":@0};
    return self.activeToken;
  }
}
- (BOOL)cancelled:(NSString *)token { @synchronized(self) { return self.activeCancelled || ![self.activeToken isEqual:token]; } }
- (BOOL)cancelInstall {
  @synchronized(self) {
    if (!self.activeToken) return NO;
    self.activeCancelled = YES; [self.download cancel]; [self.importCoordinator cancel]; return YES;
  }
}
- (BOOL)cancelInstallToken:(NSString *)token {
  @synchronized(self) {
    if (![token isKindOfClass:NSString.class] || ![self.activeToken isEqual:token]) return NO;
    return [self cancelInstall];
  }
}
- (NSDictionary *)copyManifestForEnvironmentId:(NSString *)environmentId catalogOnly:(BOOL)catalogOnly {
  @synchronized(self) {
    if (!DSHEnvironmentValidId(environmentId)) return nil;
    NSDictionary *manifest = (!catalogOnly ? self.installed[environmentId] : nil)
        ?: self.catalog[environmentId][@"manifest"];
    if (!manifest) return nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:manifest options:0 error:nil];
    return json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:nil] : nil;
  }
}
- (NSDictionary *)manifestForEnvironmentId:(NSString *)environmentId {
  return [self copyManifestForEnvironmentId:environmentId catalogOnly:NO];
}
- (NSDictionary *)catalogManifestForEnvironmentId:(NSString *)environmentId {
  return [self copyManifestForEnvironmentId:environmentId catalogOnly:YES];
}
- (void)finishToken:(NSString *)token descriptor:(NSDictionary *)descriptor error:(NSError *)error
         directory:(NSURL *)directory completion:(DSHEnvironmentCompletion)completion {
  @synchronized(self) {
    if ([self.activeToken isEqual:token]) {
      if (error && self.activeEnvironmentId && !self.installed[self.activeEnvironmentId]) {
        NSString *code = error.userInfo[@"code"] ?: @"E_ENV_STORAGE";
        self.states[self.activeEnvironmentId] = @{@"state":@"failed",@"error_code":code,@"downloaded_bytes":@0};
      }
      self.activeToken = nil; self.activeEnvironmentId = nil; self.download = nil; self.importCoordinator = nil;
    }
  }
  [NSFileManager.defaultManager removeItemAtURL:directory error:nil];
  completion(descriptor, error);
}
- (void)unpack:(NSURL *)packageURL record:(NSDictionary *)record token:(NSString *)token
     directory:(NSURL *)directory completion:(DSHEnvironmentCompletion)completion {
  NSError *error = nil; NSDictionary *descriptor = nil;
  @synchronized(self) {
    if (self.activeEnvironmentId) self.states[self.activeEnvironmentId] = @{@"state":@"installing",@"downloaded_bytes":record[@"package_bytes"] ?: @0};
  }
  NSURL *staged = [directory URLByAppendingPathComponent:@"environment" isDirectory:YES];
  NSDictionary *manifest = nil;
  if (DSHEnvironmentEnsureDirectory(staged)) {
    manifest = [DSHRuntimeEnvironmentPackage unpackURL:packageURL diskURL:[staged URLByAppendingPathComponent:@"disk.ext4"]
        kernelSHA256:self.kernelSHA256 expectedRecord:record cancelled:^BOOL { return [self cancelled:token]; } error:&error];
  } else error = DSHEnvironmentError(@"E_ENV_STORAGE");
  if (manifest) {
    @synchronized(self) {
      NSString *env = manifest[@"environment_id"];
      uint64_t total = [manifest[@"disk_bytes"] unsignedLongLongValue];
      for (NSDictionary *existing in self.installed.allValues) total += [existing[@"disk_bytes"] unsignedLongLongValue];
      if ([self cancelled:token]) error = DSHEnvironmentError(@"E_ENV_CANCELLED");
      else if (self.catalog[env] && ![self.catalog[env][@"manifest"] isEqual:manifest]) error = DSHEnvironmentError(@"E_ENV_CONFLICT");
      else if (self.installed[env]) {
        if ([self.installed[env] isEqual:manifest]) descriptor = [self descriptor:env];
        else error = DSHEnvironmentError(@"E_ENV_CONFLICT");
      } else if (total > 8ULL * 1024 * 1024 * 1024) error = DSHEnvironmentError(@"E_ENV_LIMIT");
      else if (!WriteJSON(manifest, [staged URLByAppendingPathComponent:@"manifest.json"])) error = DSHEnvironmentError(@"E_ENV_STORAGE");
      else {
        NSURL *target = [self.installedURL URLByAppendingPathComponent:env isDirectory:YES];
        if (renameatx_np(AT_FDCWD, staged.fileSystemRepresentation, AT_FDCWD, target.fileSystemRepresentation, RENAME_EXCL) != 0)
          error = DSHEnvironmentError(@"E_ENV_STORAGE");
        else {
          self.installed[env] = manifest; [self.states removeObjectForKey:env];
          if (SyncDirectory(self.installedURL)) descriptor = [self descriptor:env];
          else error = DSHEnvironmentError(@"E_ENV_STORAGE");
        }
      }
    }
  }
  [self finishToken:token descriptor:descriptor error:error ?: (descriptor ? nil : DSHEnvironmentError(@"E_ENV_STORAGE"))
      directory:directory completion:completion];
}
- (NSString *)startDownload:(NSString *)url record:(NSDictionary *)record environmentId:(NSString *)environmentId
          completion:(DSHEnvironmentCompletion)completion {
  NSString *token = [self beginEnvironment:environmentId completion:completion]; if (!token) return nil;
  NSURL *directory = [self.stagingURL URLByAppendingPathComponent:token isDirectory:YES];
  if (!DSHEnvironmentEnsureDirectory(directory)) {
    [self finishToken:token descriptor:nil error:DSHEnvironmentError(@"E_ENV_STORAGE") directory:directory completion:completion]; return nil;
  }
  NSURL *packageURL = [directory URLByAppendingPathComponent:@"package.rishenv"];
  DSHRuntimeEnvironmentDownload *download = [[DSHRuntimeEnvironmentDownload alloc] init];
  @synchronized(self) { self.download = download; if (self.activeCancelled) [download cancel]; }
  [download startURL:url destination:packageURL expectedBytes:record[@"package_bytes"]
      progress:^(uint64_t bytes, NSNumber *total) {
        @synchronized(self) {
          if (environmentId && [self.activeToken isEqual:token]) self.states[environmentId] =
              @{@"state":@"downloading",@"downloaded_bytes":@(bytes),@"total_bytes":total ?: NSNull.null};
        }
      } completion:^(NSError *error) {
        dispatch_async(self.worker, ^{
          if (error) [self finishToken:token descriptor:nil error:error directory:directory completion:completion];
          else [self unpack:packageURL record:record token:token directory:directory completion:completion];
        });
      }];
  return token;
}
- (void)installEnvironmentId:(NSString *)environmentId completion:(DSHEnvironmentCompletion)completion {
  [self beginInstallEnvironmentId:environmentId completion:completion];
}
- (NSString *)beginInstallEnvironmentId:(NSString *)environmentId completion:(DSHEnvironmentCompletion)completion {
  NSDictionary *record = nil;
  @synchronized(self) { if (DSHEnvironmentValidId(environmentId)) record = self.catalog[environmentId]; }
  if (!record) { completion(nil, DSHEnvironmentError(@"E_ENV_NOT_FOUND")); return nil; }
  return [self startDownload:record[@"url"] record:record environmentId:environmentId completion:completion];
}
- (void)downloadURL:(NSString *)url completion:(DSHEnvironmentCompletion)completion {
  if (!DSHEnvironmentValidHTTPSURL(url)) { completion(nil, DSHEnvironmentError(@"E_ENV_BAD_ARGUMENTS")); return; }
  [self startDownload:url record:nil environmentId:nil completion:completion];
}
- (void)importPackageURL:(NSURL *)url completion:(DSHEnvironmentCompletion)completion {
  NSString *token = [self beginEnvironment:nil completion:completion]; if (!token) return;
  NSURL *directory = [self.stagingURL URLByAppendingPathComponent:token isDirectory:YES];
  dispatch_async(self.worker, ^{
    if (!url.isFileURL || !DSHEnvironmentEnsureDirectory(directory)) {
      [self finishToken:token descriptor:nil error:DSHEnvironmentError(@"E_ENV_STORAGE") directory:directory completion:completion]; return;
    }
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    @synchronized(self) { self.importCoordinator = coordinator; if (self.activeCancelled) [coordinator cancel]; }
    __block BOOL accessed = NO; NSError *coordinationError = nil;
    [coordinator coordinateReadingItemAtURL:url options:0 error:&coordinationError byAccessor:^(NSURL *readURL) {
      accessed = YES;
      [self unpack:readURL record:nil token:token directory:directory completion:completion];
    }];
    if (!accessed) [self finishToken:token descriptor:nil
        error:DSHEnvironmentError([self cancelled:token] ? @"E_ENV_CANCELLED" : @"E_ENV_STORAGE")
        directory:directory completion:completion];
  });
}
- (DSHRuntimeEnvironmentLease *)acquireLeaseForEnvironmentId:(NSString *)environmentId error:(NSError **)error {
  @synchronized(self) {
    NSDictionary *manifest = DSHEnvironmentValidId(environmentId) ? self.installed[environmentId] : nil;
    NSString *code = nil;
    if (!manifest) code = @"E_ENV_NOT_INSTALLED";
    else if (self.leases.count >= 1) code = @"E_ENV_IN_USE";
    else if (!DSHEnvironmentHasCapacity(self.leasesURL, [manifest[@"disk_bytes"] unsignedLongLongValue])) code = @"E_ENV_DISK_SPACE";
    if (code) { if (error) *error = DSHEnvironmentError(code); return nil; }
    NSURL *source = [[self.installedURL URLByAppendingPathComponent:environmentId] URLByAppendingPathComponent:@"disk.ext4"];
    NSString *digest = DSHEnvironmentHashFile(source, [manifest[@"disk_bytes"] unsignedLongLongValue], nil);
    if (![digest isEqual:manifest[@"disk_sha256"]]) { if (error) *error = DSHEnvironmentError(@"E_ENV_INTEGRITY"); return nil; }
    DSHRuntimeEnvironmentLease *lease = [[DSHRuntimeEnvironmentLease alloc] init];
    lease.leaseId = NSUUID.UUID.UUIDString.lowercaseString;
    NSURL *directory = [self.leasesURL URLByAppendingPathComponent:lease.leaseId isDirectory:YES];
    NSURL *disk = [directory URLByAppendingPathComponent:@"disk.ext4"];
    BOOL copied = NO;
    if (DSHEnvironmentEnsureDirectory(directory)) {
      copied = clonefile(source.fileSystemRepresentation, disk.fileSystemRepresentation, CLONE_NOFOLLOW) == 0;
      if (!copied) copied = copyfile(source.fileSystemRepresentation, disk.fileSystemRepresentation, NULL,
          COPYFILE_DATA | COPYFILE_EXCL | COPYFILE_NOFOLLOW_SRC | COPYFILE_NOFOLLOW_DST) == 0;
    }
    if (!copied || chmod(disk.fileSystemRepresentation, 0600) != 0 || !DSHEnvironmentProtectFile(disk)
        || !RegularFile(disk, [manifest[@"disk_bytes"] unsignedLongLongValue])) {
      [NSFileManager.defaultManager removeItemAtURL:directory error:nil];
      if (error) *error = DSHEnvironmentError(@"E_ENV_STORAGE"); return nil;
    }
    lease.environmentId = environmentId; lease.manifest = manifest; lease.diskURL = disk;
    self.leases[lease.leaseId] = lease; return lease;
  }
}
- (void)releaseLease:(DSHRuntimeEnvironmentLease *)lease {
  @synchronized(self) {
    if (!lease || self.leases[lease.leaseId] != lease) return;
    [NSFileManager.defaultManager removeItemAtURL:lease.diskURL.URLByDeletingLastPathComponent error:nil];
    [self.leases removeObjectForKey:lease.leaseId];
  }
}
@end
