#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#import "LocalProjectAccess.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Device acceptance hook for the container-anchor fix.
//
// Triggered only when the process is launched with DSH_ANCHOR_SELFCHECK=1
// (set DSH_ANCHOR_TRACE=1 alongside it for the per-open anchor trace).
// Performs the production projects-root walk through DSHLocalProjectAccess
// on the real device and logs the derived container root, then walks one
// existing project when present. The walk is exactly what normal project
// access performs: no injected roots, no mocks, no writes beyond the
// production bootstrap. Inert unless the environment variable is set.
//
// Registration happens in +load and the walk runs on
// UIApplicationDidFinishLaunchingNotification so the hook lives entirely
// inside this module: the app target needs no changes and the runtime cost
// is zero without the environment variable.

// Both os_log and stderr: stderr guarantees the line survives when the
// process is launched under a console capture (devicectl --console), while
// os_log keeps the line searchable in the device unified log.
static void DSHAnchorSelfCheckEmit(NSString *message) {
  NSLog(@"[anchor-selfcheck] %@", message);
  fprintf(stderr, "[anchor-selfcheck] %s\n", message.UTF8String);
}

static void DSHProjectAnchorSelfCheckRun(void) {
  DSHAnchorSelfCheckEmit(@"begin: walking the production projects root "
                         @"through DSHLocalProjectAccess");

  NSError *error = nil;
  NSURL *rootURL = [[DSHLocalProjectAccess sharedAccess]
      projectsRootURLCreatingIfNeeded:YES
                                error:&error];
  if (rootURL == nil) {
    DSHAnchorSelfCheckEmit([NSString stringWithFormat:
        @"FAIL: projects root walk refused: %@",
        error != nil ? error.localizedDescription : @"unknown error"]);
    DSHAnchorSelfCheckEmit(@"end: anchor verification FAILED (fail closed)");
    return;
  }
  DSHAnchorSelfCheckEmit([NSString stringWithFormat:
      @"ok: projects root resolved at %@", rootURL.path]);

  // When a canonical project directory already exists, walk it so the
  // strict container-relative tail is exercised beyond the bootstrap path.
  NSArray<NSString *> *entries =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:rootURL.path
                                                          error:nil] ?: @[];
  BOOL walkedProject = NO;
  for (NSString *entry in entries) {
    if (![DSHLocalProjectAccess isCanonicalProjectId:entry]) {
      continue;
    }
    NSError *projectError = nil;
    DSHLocalProjectLease *lease = [[DSHLocalProjectAccess sharedAccess]
        leaseProjectId:entry
                  mode:DSHLocalProjectAccessModeRead
        includeMetadata:YES
                 error:&projectError];
    if (lease != nil) {
      walkedProject = YES;
      DSHAnchorSelfCheckEmit([NSString stringWithFormat:
          @"ok: project %@ walked (repository %@)", entry,
          lease.repositoryURL.path]);
    } else {
      DSHAnchorSelfCheckEmit([NSString stringWithFormat:
          @"note: project %@ refused: %@", entry,
          projectError != nil ? projectError.localizedDescription
                              : @"unknown error"]);
    }
  }
  if (!walkedProject) {
    DSHAnchorSelfCheckEmit(
        @"note: no canonical project directories present; root walk only");
  }

  DSHAnchorSelfCheckEmit(@"end: anchor verification complete");
}

@interface DSHProjectAnchorSelfCheck : NSObject
@end

@implementation DSHProjectAnchorSelfCheck

+ (void)load {
  const char *requested = getenv("DSH_ANCHOR_SELFCHECK");
  if (requested == nullptr || strcmp(requested, "1") != 0) {
    return;
  }
  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                DSHProjectAnchorSelfCheckRun();
              }];
}

@end
