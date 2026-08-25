#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

static NSUInteger const LDMaxPathBytes = 1024;
static NSUInteger const LDMaxEntries = 2000;
static uint64_t const LDMaxFileBytes = 64ULL * 1024 * 1024;
static uint64_t const LDMaxTotalBytes = 256ULL * 1024 * 1024;
static NSUInteger const LDMaxDepth = 64;

typedef NS_ENUM(NSInteger, LDPickerMode) {
  LDPickerModeNone = 0,
  LDPickerModeImport = 1,
  LDPickerModeExport = 2,
};

static NSError *LDError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"LocalDocuments"
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *LDString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static BOOL LDHasControlCharacter(NSString *value) {
  return [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location
    != NSNotFound;
}

static BOOL LDIsReservedComponent(NSString *component) {
  if (component == nil) return NO;
  return [component caseInsensitiveCompare:@".git"] == NSOrderedSame
    || [component caseInsensitiveCompare:@".gitmodules"] == NSOrderedSame
    || [component caseInsensitiveCompare:@".trash"] == NSOrderedSame;
}

static BOOL LDValidComponent(NSString *component) {
  NSUInteger bytes = [component lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  return bytes > 0 && bytes <= NAME_MAX && !LDHasControlCharacter(component)
    && ![component isEqualToString:@"."] && ![component isEqualToString:@".."]
    && !LDIsReservedComponent(component);
}

static NSArray<NSString *> *LDComponents(id value, BOOL allowRoot, NSError **error) {
  NSString *path = LDString(value);
  if (path == nil || [path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > LDMaxPathBytes
    || [path hasPrefix:@"/"] || [path containsString:@"\\"] || LDHasControlCharacter(path)) {
    if (error != nil) *error = LDError(4001, @"Workspace path is invalid");
    return nil;
  }
  if (path.length == 0) {
    if (allowRoot) return @[];
    if (error != nil) *error = LDError(4002, @"Workspace root is not an item");
    return nil;
  }
  NSArray<NSString *> *components = [path componentsSeparatedByString:@"/"];
  for (NSString *component in components) {
    if (!LDValidComponent(component)) {
      if (error != nil) *error = LDError(4003, @"Workspace path is reserved or unsafe");
      return nil;
    }
  }
  return components;
}

@interface LocalDocumentsModule : NSObject <RCTBridgeModule, UIDocumentPickerDelegate>
@property(nonatomic, strong) dispatch_queue_t documentQueue;
@property(nonatomic, copy) RCTPromiseResolveBlock pendingResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock pendingReject;
@property(nonatomic) LDPickerMode pendingMode;
@property(nonatomic, copy) NSString *pendingDestinationRoot;
@property(nonatomic, strong) NSURL *pendingExportStaging;
@end

@implementation LocalDocumentsModule

RCT_EXPORT_MODULE(LocalDocuments)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _documentQueue = dispatch_queue_create(
      "dev.zseven.rish.local-documents", DISPATCH_QUEUE_SERIAL);
    _pendingMode = LDPickerModeNone;
  }
  return self;
}

- (NSURL *)applicationSupportURL:(NSError **)error {
  NSURL *support = [[NSFileManager defaultManager]
    URLForDirectory:NSApplicationSupportDirectory
           inDomain:NSUserDomainMask
  appropriateForURL:nil
             create:YES
              error:error];
  if (support != nil) {
    [[NSFileManager defaultManager] setAttributes:@{
      NSFilePosixPermissions: @0700,
      NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication,
    } ofItemAtPath:support.path error:nil];
  }
  return support;
}

- (NSURL *)workspaceURLForRelativePath:(id)value
                           requireItem:(BOOL)requireItem
                                 error:(NSError **)error {
  NSArray<NSString *> *components = LDComponents(value, !requireItem, error);
  if (components == nil) return nil;
  NSURL *support = [self applicationSupportURL:error];
  if (support == nil) return nil;
  NSURL *workspace = [support URLByAppendingPathComponent:@"workspace" isDirectory:YES];
  struct stat metadata = {};
  if (lstat(workspace.fileSystemRepresentation, &metadata) != 0
    || !S_ISDIR(metadata.st_mode) || S_ISLNK(metadata.st_mode)) {
    if (error != nil) *error = LDError(4004, @"Workspace is unavailable");
    return nil;
  }
  NSURL *current = workspace;
  for (NSString *component in components) {
    current = [current URLByAppendingPathComponent:component];
    if (lstat(current.fileSystemRepresentation, &metadata) != 0
      || S_ISLNK(metadata.st_mode)
      || (!S_ISREG(metadata.st_mode) && !S_ISDIR(metadata.st_mode))) {
      if (error != nil) *error = LDError(4005, @"Workspace item is unavailable or unsafe");
      return nil;
    }
  }
  if (!requireItem && (lstat(current.fileSystemRepresentation, &metadata) != 0
    || !S_ISDIR(metadata.st_mode))) {
    if (error != nil) *error = LDError(4006, @"Import destination is not a directory");
    return nil;
  }
  return current;
}

- (NSURL *)newStagingDirectory:(NSString *)prefix error:(NSError **)error {
  NSURL *support = [self applicationSupportURL:error];
  if (support == nil) return nil;
  NSURL *root = [support URLByAppendingPathComponent:@"document-staging" isDirectory:YES];
  struct stat metadata = {};
  if (lstat(root.fileSystemRepresentation, &metadata) != 0) {
    if (errno != ENOENT || mkdir(root.fileSystemRepresentation, 0700) != 0) {
      if (error != nil) *error = LDError(4007, @"Document staging is unavailable");
      return nil;
    }
  } else if (!S_ISDIR(metadata.st_mode) || S_ISLNK(metadata.st_mode)) {
    if (error != nil) *error = LDError(4007, @"Document staging is unsafe");
    return nil;
  }
  chmod(root.fileSystemRepresentation, 0700);
  [root setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  NSURL *staging = [root URLByAppendingPathComponent:
    [NSString stringWithFormat:@"%@-%@", prefix, NSUUID.UUID.UUIDString.lowercaseString]
    isDirectory:YES];
  if (mkdir(staging.fileSystemRepresentation, 0700) != 0) {
    if (error != nil) *error = LDError(4008, @"Document staging cannot be created");
    return nil;
  }
  return staging;
}

- (BOOL)copySafeItem:(NSURL *)source
                  to:(NSURL *)destination
               depth:(NSUInteger)depth
               count:(NSUInteger *)count
          totalBytes:(uint64_t *)totalBytes
             skipGit:(BOOL)skipGit
               error:(NSError **)error {
  if (depth > LDMaxDepth || *count >= LDMaxEntries) {
    if (error != nil) *error = LDError(4009, @"Selected content exceeds the import limits");
    return NO;
  }
  NSNumber *symbolic = nil;
  NSNumber *directory = nil;
  NSNumber *regular = nil;
  NSNumber *size = nil;
  NSError *resourceError = nil;
  BOOL read = [source getResourceValue:&symbolic forKey:NSURLIsSymbolicLinkKey error:&resourceError]
    && [source getResourceValue:&directory forKey:NSURLIsDirectoryKey error:&resourceError]
    && [source getResourceValue:&regular forKey:NSURLIsRegularFileKey error:&resourceError];
  NSString *name = source.lastPathComponent;
  if (!read || symbolic.boolValue || !LDValidComponent(name)) {
    if (skipGit && LDIsReservedComponent(name)) {
      return YES;
    }
    if (error != nil) *error = LDError(4010, @"Selected content contains an unsupported item");
    return NO;
  }
  *count += 1;
  if (directory.boolValue) {
    if (mkdir(destination.fileSystemRepresentation, 0700) != 0) {
      if (error != nil) *error = LDError(4011, @"A selected directory cannot be staged");
      return NO;
    }
    NSArray<NSURL *> *children = [[NSFileManager defaultManager]
      contentsOfDirectoryAtURL:source
    includingPropertiesForKeys:@[
      NSURLIsSymbolicLinkKey,
      NSURLIsDirectoryKey,
      NSURLIsRegularFileKey,
      NSURLFileSizeKey,
    ]
                       options:0
                         error:&resourceError];
    if (children == nil) {
      if (error != nil) *error = LDError(4012, @"A selected directory cannot be read");
      return NO;
    }
    for (NSURL *child in children) {
      NSString *childName = child.lastPathComponent;
      if (skipGit && LDIsReservedComponent(childName)) continue;
      NSURL *target = [destination URLByAppendingPathComponent:childName];
      if (![self copySafeItem:child to:target depth:depth + 1 count:count
                   totalBytes:totalBytes skipGit:skipGit error:error]) return NO;
    }
    return YES;
  }
  if (!regular.boolValue
    || ![source getResourceValue:&size forKey:NSURLFileSizeKey error:&resourceError]) {
    if (error != nil) *error = LDError(4010, @"Selected content contains an unsupported item");
    return NO;
  }
  uint64_t bytes = size.unsignedLongLongValue;
  if (bytes > LDMaxFileBytes || bytes > LDMaxTotalBytes - *totalBytes) {
    if (error != nil) *error = LDError(4013, @"Selected files exceed the size limit");
    return NO;
  }
  *totalBytes += bytes;
  if (![[NSFileManager defaultManager] copyItemAtURL:source toURL:destination error:&resourceError]) {
    if (error != nil) *error = LDError(4014, @"A selected file cannot be copied");
    return NO;
  }
  chmod(destination.fileSystemRepresentation, 0600);
  return YES;
}

- (void)finishWithResult:(NSDictionary *)result
                   error:(NSError *)error
              exportTemp:(NSURL *)exportTemp {
  dispatch_async(dispatch_get_main_queue(), ^{
    RCTPromiseResolveBlock resolve = self.pendingResolve;
    RCTPromiseRejectBlock reject = self.pendingReject;
    self.pendingResolve = nil;
    self.pendingReject = nil;
    self.pendingDestinationRoot = nil;
    self.pendingExportStaging = nil;
    self.pendingMode = LDPickerModeNone;
    if (exportTemp != nil) {
      [[NSFileManager defaultManager] removeItemAtURL:exportTemp error:nil];
    }
    if (error != nil) reject(@"documents", error.localizedDescription, error);
    else resolve(result);
  });
}

- (BOOL)beginPickerMode:(LDPickerMode)mode
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  NSAssert(NSThread.isMainThread, @"picker state must stay on main");
  if (self.pendingMode != LDPickerModeNone) {
    reject(@"busy", @"Another Files operation is already active", nil);
    return NO;
  }
  UIViewController *presenter = RCTPresentedViewController();
  if (presenter == nil || [presenter isKindOfClass:UIAlertController.class]) {
    reject(@"presentation", @"The iOS Files picker cannot be presented right now", nil);
    return NO;
  }
  self.pendingMode = mode;
  self.pendingResolve = resolve;
  self.pendingReject = reject;
  return YES;
}

RCT_REMAP_METHOD(presentImportPicker,
                 presentImportPickerAtRoot:(id)destinationRootValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.documentQueue, ^{
    NSError *error = nil;
    NSString *destinationRoot = LDString(destinationRootValue);
    if ([self workspaceURLForRelativePath:destinationRoot
                             requireItem:NO error:&error] == nil) {
      reject(@"validation", error.localizedDescription, error);
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![self beginPickerMode:LDPickerModeImport resolve:resolve reject:reject]) return;
      self.pendingDestinationRoot = destinationRoot;
      UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
        initForOpeningContentTypes:@[UTTypeItem, UTTypeFolder] asCopy:YES];
      picker.allowsMultipleSelection = YES;
      picker.delegate = self;
      [RCTPresentedViewController() presentViewController:picker animated:YES completion:nil];
    });
  });
}

RCT_REMAP_METHOD(presentExportPicker,
                 presentExportPickerForPaths:(id)sourcePathsValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSArray *sourcePaths = [sourcePathsValue isKindOfClass:NSArray.class]
    ? sourcePathsValue : nil;
  if (sourcePaths.count == 0 || sourcePaths.count > 100) {
    reject(@"validation", @"Export requires between 1 and 100 workspace items", nil);
    return;
  }
  dispatch_async(self.documentQueue, ^{
    NSError *error = nil;
    NSURL *staging = [self newStagingDirectory:@"export" error:&error];
    NSMutableArray<NSURL *> *stagedURLs = [NSMutableArray array];
    NSMutableSet<NSString *> *names = [NSMutableSet set];
    NSUInteger count = 0;
    uint64_t totalBytes = 0;
    for (id pathValue in sourcePaths) {
      NSURL *source = [self workspaceURLForRelativePath:pathValue requireItem:YES error:&error];
      NSString *name = source.lastPathComponent;
      if (source == nil || !LDValidComponent(name) || [names containsObject:name]) {
        error = error ?: LDError(4015, @"Export items are invalid or have duplicate names");
        break;
      }
      [names addObject:name];
      NSURL *destination = [staging URLByAppendingPathComponent:name];
      if (![self copySafeItem:source to:destination depth:0 count:&count
                   totalBytes:&totalBytes skipGit:YES error:&error]) break;
      [stagedURLs addObject:destination];
    }
    if (error != nil || stagedURLs.count != sourcePaths.count) {
      [[NSFileManager defaultManager] removeItemAtURL:staging error:nil];
      reject(@"documents", error.localizedDescription ?: @"Export could not be prepared", error);
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![self beginPickerMode:LDPickerModeExport resolve:resolve reject:reject]) {
        [[NSFileManager defaultManager] removeItemAtURL:staging error:nil];
        return;
      }
      self.pendingExportStaging = staging;
      UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
        initForExportingURLs:stagedURLs asCopy:YES];
      picker.delegate = self;
      [RCTPresentedViewController() presentViewController:picker animated:YES completion:nil];
    });
  });
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  (void)controller;
  NSDictionary *result = self.pendingMode == LDPickerModeImport
    ? @{@"schema_version": @1, @"status": @"cancelled",
        @"destination_root": self.pendingDestinationRoot ?: @"", @"entries": @[]}
    : @{@"schema_version": @1, @"status": @"cancelled", @"item_count": @0};
  [self finishWithResult:result error:nil exportTemp:self.pendingExportStaging];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  (void)controller;
  if (self.pendingMode == LDPickerModeExport) {
    NSDictionary *result = @{
      @"schema_version": @1,
      @"status": @"exported",
      @"item_count": @(urls.count),
    };
    [self finishWithResult:result error:nil exportTemp:self.pendingExportStaging];
    return;
  }
  if (self.pendingMode != LDPickerModeImport || urls.count == 0
    || urls.count > 100) {
    [self finishWithResult:nil error:LDError(4016, @"Files selection is invalid")
                exportTemp:nil];
    return;
  }
  NSString *destinationRoot = self.pendingDestinationRoot;
  dispatch_async(self.documentQueue, ^{
    NSError *error = nil;
    NSURL *destinationRootURL = [self workspaceURLForRelativePath:destinationRoot
                                                     requireItem:NO error:&error];
    NSURL *staging = [self newStagingDirectory:@"import" error:&error];
    NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
    NSMutableSet<NSString *> *names = [NSMutableSet set];
    __block NSUInteger count = 0;
    __block uint64_t totalBytes = 0;
    for (NSURL *source in urls) {
      NSString *name = source.lastPathComponent;
      if (!LDValidComponent(name) || [names containsObject:name]) {
        error = LDError(4017, @"Selected items have invalid or duplicate names");
        break;
      }
      [names addObject:name];
      NSURL *destination = [staging URLByAppendingPathComponent:name];
      BOOL scoped = [source startAccessingSecurityScopedResource];
      NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
      __block BOOL copied = NO;
      __block NSError *copyError = nil;
      [coordinator coordinateReadingItemAtURL:source
                                     options:NSFileCoordinatorReadingWithoutChanges
                                       error:&copyError
                                  byAccessor:^(NSURL *coordinatedURL) {
        copied = [self copySafeItem:coordinatedURL to:destination depth:0
          count:&count totalBytes:&totalBytes skipGit:NO error:&copyError];
      }];
      if (scoped) [source stopAccessingSecurityScopedResource];
      if (!copied) {
        error = copyError ?: LDError(4018, @"A selected item could not be imported");
        break;
      }
    }
    int destinationDescriptor = destinationRootURL == nil ? -1
      : open(destinationRootURL.fileSystemRepresentation,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int stagingDescriptor = staging == nil ? -1
      : open(staging.fileSystemRepresentation,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (error == nil && (destinationDescriptor < 0 || stagingDescriptor < 0)) {
      error = LDError(4019, @"Import destination is unavailable");
    }
    if (error == nil) {
      for (NSString *name in names) {
        struct stat existing = {};
        if (fstatat(destinationDescriptor, name.fileSystemRepresentation,
          &existing, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
          error = LDError(4020, @"An item with the selected name already exists");
          break;
        }
      }
    }
    NSMutableArray<NSString *> *published = [NSMutableArray array];
    if (error == nil) {
      for (NSString *name in names) {
        if (renameatx_np(stagingDescriptor, name.fileSystemRepresentation,
          destinationDescriptor, name.fileSystemRepresentation, RENAME_EXCL) != 0) {
          error = LDError(4021, @"Imported items could not be published atomically");
          break;
        }
        [published addObject:name];
        NSString *relative = destinationRoot.length == 0 ? name
          : [destinationRoot stringByAppendingFormat:@"/%@", name];
        struct stat metadata = {};
        fstatat(destinationDescriptor, name.fileSystemRepresentation,
          &metadata, AT_SYMLINK_NOFOLLOW);
        [entries addObject:@{
          @"path": relative,
          @"kind": S_ISDIR(metadata.st_mode) ? @"directory" : @"file",
          @"size": S_ISREG(metadata.st_mode) ? @(metadata.st_size) : @0,
        }];
      }
    }
    if (error != nil && destinationDescriptor >= 0 && stagingDescriptor >= 0) {
      for (NSString *name in published.reverseObjectEnumerator) {
        renameatx_np(destinationDescriptor, name.fileSystemRepresentation,
          stagingDescriptor, name.fileSystemRepresentation, RENAME_EXCL);
      }
      [entries removeAllObjects];
    }
    if (destinationDescriptor >= 0) {
      fsync(destinationDescriptor);
      close(destinationDescriptor);
    }
    if (stagingDescriptor >= 0) close(stagingDescriptor);
    if (staging != nil) [[NSFileManager defaultManager] removeItemAtURL:staging error:nil];
    NSDictionary *result = error == nil ? @{
      @"schema_version": @1,
      @"status": @"imported",
      @"destination_root": destinationRoot ?: @"",
      @"entries": entries,
    } : nil;
    [self finishWithResult:result error:error exportTemp:nil];
  });
}

@end
