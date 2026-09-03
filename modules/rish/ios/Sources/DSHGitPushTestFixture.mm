#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#import "DSHGitPushSupport.h"
#import "LocalProjectAccess.h"

/// Native-only launch hook for the automated G2 drive. It is inert unless the
/// app process environment carries DSH_GIT_TEST_FIXTURE — which only the
/// UITest launch environment sets. It clones the configured test remote
/// through the exact production clone path and writes one fixture file into
/// the fresh worktree, so the UI drive can stage, commit, and push without a
/// document picker. The same hook works on device for the G3 task.
@interface LocalProjectsModule (DSHGitPushTestFixtureAccess)
- (nullable NSDictionary *)clonePublicRepositoryAtURL:(NSURL *)remoteURL
                                                name:(NSString *)name
                                            proxyURL:(nullable NSString *)proxyURL
                                               error:(NSError **)error;
@end

@interface DSHGitPushTestFixture : NSObject
@end

@implementation DSHGitPushTestFixture

+ (void)load {
  const char *mode = getenv("DSH_GIT_TEST_FIXTURE");
  if (mode == nullptr || strcmp(mode, "clone+write") != 0) return;
  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(__unused NSNotification *note) {
                DSHGitPushTestFixtureRun();
              }];
}

static void DSHGitPushTestFixtureRun(void) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      const char *urlBytes = getenv("DSH_GIT_TEST_URL");
      const char *nameBytes = getenv("DSH_GIT_TEST_PROJECT");
      const char *pathBytes = getenv("DSH_GIT_TEST_FILE_PATH");
      const char *contentBytes = getenv("DSH_GIT_TEST_FILE_BASE64");
      if (urlBytes == nullptr || nameBytes == nullptr ||
          pathBytes == nullptr || contentBytes == nullptr) return;
      NSString *urlString = [NSString stringWithUTF8String:urlBytes];
      NSString *projectName = [NSString stringWithUTF8String:nameBytes];
      NSString *filePath = [NSString stringWithUTF8String:pathBytes];
      NSString *contentBase64 = [NSString stringWithUTF8String:contentBytes];
      NSData *content = [[NSData alloc]
          initWithBase64EncodedString:contentBase64 options:0];
      if (content.length == 0 || content.length > 32768 ||
          filePath.length == 0 || filePath.length > 1024 ||
          [filePath hasPrefix:@"/"] || [filePath containsString:@".."] ||
          [filePath containsString:@".git"] ||
          projectName.length == 0 || projectName.length > 120) return;
      NSError *error = nil;
      NSURL *remoteURL = DSHGitValidatedRemoteURL(urlString, &error);
      if (remoteURL == nil) return;
      LocalProjectsModule *module = [[LocalProjectsModule alloc] init];
      NSDictionary *metadata = [module clonePublicRepositoryAtURL:remoteURL
                                                              name:projectName
                                                          proxyURL:nil
                                                             error:&error];
      NSString *projectId = metadata[@"id"];
      if (projectId.length == 0) return;
      DSHLocalProjectAccess *access = [DSHLocalProjectAccess sharedAccess];
      DSHLocalProjectLease *lease = [access leaseProjectId:projectId
                                                      mode:DSHLocalProjectAccessModeWrite
                                           includeMetadata:NO
                                                     error:nil];
      if (lease == nil) return;
      NSURL *destination = [lease.repositoryURL
          URLByAppendingPathComponent:filePath isDirectory:NO];
      BOOL written = [content writeToURL:destination
                                 options:NSDataWritingAtomic error:nil];
      // A zero-byte write is a failure; atomic writes cannot be partial.
      (void)written;
    }
  });
}

@end
