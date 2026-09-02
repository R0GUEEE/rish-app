#import "SessionWorkspaceCoordinator.h"

#import <objc/runtime.h>

NSErrorDomain const DSHSessionWorkspaceCoordinatorErrorDomain =
    @"dev.zseven.rish.session-workspace-coordinator";
NSString *const DSHSessionWorkspaceCoordinatorErrorStorage =
    @"E_SESSION_STORAGE";

static const void *DSHSessionWorkspaceQueueKey =
    &DSHSessionWorkspaceQueueKey;

static NSError *DSHSessionWorkspaceError(void) {
  return [NSError errorWithDomain:DSHSessionWorkspaceCoordinatorErrorDomain
                             code:1
                         userInfo:@{
                           @"code" : DSHSessionWorkspaceCoordinatorErrorStorage,
                           NSLocalizedDescriptionKey :
                               DSHSessionWorkspaceCoordinatorErrorStorage,
                         }];
}

@interface DSHSessionWorkspaceCoordinator ()
@property(nonatomic, strong) dispatch_queue_t queue;
@end

@implementation DSHSessionWorkspaceCoordinator

+ (instancetype)sharedCoordinator {
  static DSHSessionWorkspaceCoordinator *coordinator = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    coordinator = [[self alloc] initPrivate];
  });
  return coordinator;
}

+ (dispatch_queue_t)sharedQueue {
  return [self sharedCoordinator].queue;
}

- (instancetype)initPrivate {
  self = [super init];
  if (self != nil) {
    _queue = dispatch_queue_create(
        "dev.zseven.rish.session-workspace-transaction", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(_queue, DSHSessionWorkspaceQueueKey,
                                (__bridge void *)self, NULL);
  }
  return self;
}

- (BOOL)isExecutingOnQueue {
  return dispatch_get_specific(DSHSessionWorkspaceQueueKey) != NULL;
}

- (void)performSync:(dispatch_block_t)block {
  if (block == nil) return;
  if ([self isExecutingOnQueue]) {
    block();
    return;
  }
  dispatch_sync(self.queue, block);
}

- (BOOL)performSyncWithError:(BOOL (^)(NSError **error))block
                         error:(NSError **)error {
  if (block == nil) {
    if (error != nil) *error = DSHSessionWorkspaceError();
    return NO;
  }

  __block BOOL result = NO;
  __block NSError *blockError = nil;
  dispatch_block_t run = ^{
    @try {
      result = block(&blockError);
    } @catch (__unused NSException *exception) {
      result = NO;
      blockError = DSHSessionWorkspaceError();
    }
  };
  if ([self isExecutingOnQueue]) {
    run();
  } else {
    dispatch_sync(self.queue, run);
  }
  if (!result && error != nil) {
    *error = blockError ?: DSHSessionWorkspaceError();
  }
  return result;
}

- (void)performAsync:(dispatch_block_t)block {
  if (block == nil) return;
  dispatch_async(self.queue, ^{
    @try {
      block();
    } @catch (__unused NSException *exception) {
      // An asynchronous coordinator block has no error channel.  Keep
      // exceptions contained so they cannot terminate the process.
    }
  });
}

@end

dispatch_queue_t DSHSessionWorkspaceSerialQueue(void) {
  return [DSHSessionWorkspaceCoordinator sharedQueue];
}

BOOL DSHPerformSessionWorkspaceTransaction(BOOL (^block)(NSError **error),
                                            NSError **error) {
  return [[DSHSessionWorkspaceCoordinator sharedCoordinator]
      performSyncWithError:block error:error];
}

void DSHSessionWorkspacePerformSync(dispatch_block_t block) {
  [[DSHSessionWorkspaceCoordinator sharedCoordinator] performSync:block];
}

BOOL DSHSessionWorkspacePerformSyncWithError(BOOL (^block)(NSError **error),
                                              NSError **error) {
  return [[DSHSessionWorkspaceCoordinator sharedCoordinator]
      performSyncWithError:block error:error];
}
