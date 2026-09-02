#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The one in-process executor shared by the session snapshot store and
/// workspace authority stores.  A process-global queue is intentional here:
/// session clearance and workspace registry mutations must never observe one
/// another half way through a transaction.
@interface DSHSessionWorkspaceCoordinator : NSObject

+ (instancetype)sharedCoordinator;

/// The queue is exposed so a future native workspace module can enqueue work
/// without introducing a second serialization domain.  Callers must not
/// dispatch synchronously to this queue themselves; use the methods below so
/// re-entrant calls made by an already-running transaction do not deadlock.
+ (dispatch_queue_t)sharedQueue;

- (instancetype)init NS_UNAVAILABLE;

/// Runs a synchronous, exclusive process-local transaction.  If the caller is
/// already on the coordinator queue, the block runs inline (the transaction
/// remains exclusive) to make composition safe.
- (void)performSync:(dispatch_block_t)block;

/// Error-returning form used by private stores.  Exceptions are converted to a
/// stable value-free storage error; native exception text never crosses the
/// bridge.
- (BOOL)performSyncWithError:(BOOL (^)(NSError **error))block
                         error:(NSError **)error;

/// Asynchronous convenience for native callers that do not need a return
/// value.  The block still executes on the same process-global queue.
- (void)performAsync:(dispatch_block_t)block;

/// True only while executing on the coordinator queue.
- (BOOL)isExecutingOnQueue;

@end

@compatibility_alias SessionWorkspaceCoordinator DSHSessionWorkspaceCoordinator;

FOUNDATION_EXPORT NSErrorDomain const DSHSessionWorkspaceCoordinatorErrorDomain;
FOUNDATION_EXPORT NSString *const DSHSessionWorkspaceCoordinatorErrorStorage;

/// C entry points make the shared serialization domain usable from existing
/// Objective-C++ workspace code without retaining the coordinator object.
FOUNDATION_EXPORT dispatch_queue_t DSHSessionWorkspaceSerialQueue(void);
FOUNDATION_EXPORT BOOL DSHPerformSessionWorkspaceTransaction(
    BOOL (^block)(NSError **error),
    NSError **error);

/// Naming aliases for workspace-native callers that use the operation verb
/// instead of the historical transaction spelling.
FOUNDATION_EXPORT void DSHSessionWorkspacePerformSync(dispatch_block_t block);
FOUNDATION_EXPORT BOOL DSHSessionWorkspacePerformSyncWithError(
    BOOL (^block)(NSError **error),
    NSError **error);

NS_ASSUME_NONNULL_END
