#import <Foundation/Foundation.h>

#import "SessionWorkspaceCoordinator.h"

NS_ASSUME_NONNULL_BEGIN

@class DSHLocalWorkspaceAccess;
@class DSHLocalWorkspaceAuthorityMutationGuard;

FOUNDATION_EXPORT NSErrorDomain const DSHWorkspaceClearanceStoreErrorDomain;

typedef NS_ERROR_ENUM(DSHWorkspaceClearanceStoreErrorDomain,
                      DSHWorkspaceClearanceStoreErrorCode) {
  DSHWorkspaceClearanceStoreErrorInvalidArgument = 1,
  DSHWorkspaceClearanceStoreErrorCorrupt = 2,
  DSHWorkspaceClearanceStoreErrorStorage = 3,
  DSHWorkspaceClearanceStoreErrorConflict = 4,
  DSHWorkspaceClearanceStoreErrorNotFound = 5,
  DSHWorkspaceClearanceStoreErrorBusy = 6,
  DSHWorkspaceClearanceStoreErrorBounds = 7,
};

FOUNDATION_EXPORT NSString *const DSHWorkspaceClearanceStoreErrorInvalidCode;
FOUNDATION_EXPORT NSString *const DSHWorkspaceClearanceStoreErrorCorruptCode;
FOUNDATION_EXPORT NSString *const DSHWorkspaceClearanceStoreErrorStorageCode;
FOUNDATION_EXPORT NSString *const DSHWorkspaceClearanceStoreErrorConflictCode;
FOUNDATION_EXPORT NSString *const DSHWorkspaceClearanceStoreErrorNotFoundCode;
FOUNDATION_EXPORT NSString *const DSHWorkspaceClearanceStoreErrorBusyCode;
FOUNDATION_EXPORT NSString *const DSHWorkspaceClearanceStoreErrorBoundsCode;

typedef NSDate *_Nonnull (^DSHWorkspaceClearanceClock)(void);
typedef NSString *_Nonnull (^DSHWorkspaceClearanceIdentifierGenerator)(void);
/// Native-only project relation proof. The validator must inspect the
/// published project binding store and any in-flight detach checkpoint under
/// the same native authority boundary; returning NO is fail-closed.
typedef BOOL (^DSHWorkspaceClearanceProjectDetachValidator)(
    NSURL *privateRootURL,
    NSString *workspaceId,
    NSUInteger bindingRevision,
    NSError **error);

typedef NS_ENUM(NSInteger, DSHWorkspaceClearanceFaultPoint) {
  DSHWorkspaceClearanceFaultPointBeforeWrite = 1,
  DSHWorkspaceClearanceFaultPointAfterWriteBeforeRename = 2,
  DSHWorkspaceClearanceFaultPointAfterRename = 3,
  DSHWorkspaceClearanceFaultPointAfterRenameBeforeVerify = 4,
};

/// Test-only fault injection. Returning NO fails closed. The point names and
/// callback receive no path, bookmark, or receipt payload.
typedef BOOL (^DSHWorkspaceClearanceFaultHook)(
    DSHWorkspaceClearanceFaultPoint point);

/// Exact native receipt emitted after a schema-9 session commit. The receipt
/// file is private and is the only authority for accepting a later
/// forget/delete clearance token.
@interface DSHWorkspaceClearanceStore : NSObject

- (instancetype)init NS_UNAVAILABLE;

- (instancetype)initWithPrivateRootURL:(NSURL *)privateRootURL;

- (instancetype)initWithPrivateRootURL:(NSURL *)privateRootURL
                           coordinator:(nullable DSHSessionWorkspaceCoordinator *)coordinator
                                 clock:(nullable DSHWorkspaceClearanceClock)clock
                    identifierGenerator:(nullable DSHWorkspaceClearanceIdentifierGenerator)generator
                             faultHook:(nullable DSHWorkspaceClearanceFaultHook)faultHook;

- (instancetype)initWithPrivateRootURL:(NSURL *)privateRootURL
                           coordinator:(nullable DSHSessionWorkspaceCoordinator *)coordinator
                                 clock:(nullable DSHWorkspaceClearanceClock)clock
                    identifierGenerator:(nullable DSHWorkspaceClearanceIdentifierGenerator)generator
                             faultHook:(nullable DSHWorkspaceClearanceFaultHook)faultHook
                projectDetachValidator:(nullable DSHWorkspaceClearanceProjectDetachValidator)projectDetachValidator
    NS_DESIGNATED_INITIALIZER;

/// Uses a private `rootURL` and the shared session/workspace serial domain.
/// No URL or native identity is returned by any receipt/query method.
@property(nonatomic, strong, readonly) NSURL *privateRootURL;
@property(nonatomic, strong, readonly) NSURL *receiptURL;
@property(nonatomic, strong, readonly) DSHSessionWorkspaceCoordinator *coordinator;

/// Validates the exact schema-8/9 outbox operation used as the clearance
/// request. This is exported for the session store's pre-CAS validation.
FOUNDATION_EXPORT BOOL DSHWorkspaceClearanceValidateOperation(
    NSDictionary *operation,
    NSError **error);

/// Default native relation proof used by production session storage. It
/// scans the private published workspace-git binding relation and the shared
/// in-process detach-checkpoint registry; no path or relation is bridged.
FOUNDATION_EXPORT BOOL DSHWorkspaceClearanceValidateNativeProjectDetached(
    NSURL *privateRootURL,
    NSString *workspaceId,
    NSUInteger bindingRevision,
    NSError **error);

/// LocalProjects registers an in-flight native detach checkpoint here so a
/// clearance write cannot race a relation that has not finished detaching.
FOUNDATION_EXPORT void DSHWorkspaceClearanceRegisterProjectDetachCheckpoint(
    NSString *workspaceId,
    NSUInteger bindingRevision);
FOUNDATION_EXPORT void DSHWorkspaceClearanceMarkProjectDetachCheckpointDetached(
    NSString *workspaceId,
    NSUInteger bindingRevision);
FOUNDATION_EXPORT void DSHWorkspaceClearanceUnregisterProjectDetachCheckpoint(
    NSString *workspaceId,
    NSUInteger bindingRevision);

/// Proves that native project relations and detach checkpoints for this
/// workspace/revision are absent. This is a read-only guard and must run
/// before a clearance receipt can be issued.
- (BOOL)validateProjectDetachedForOperation:(NSDictionary *)operation
                                      error:(NSError **)error;

/// Non-reentrant form for the session store's outer sessions-lock →
/// authority-lock composition. Default validation first proves the exact
/// workspace registry/revision/origin through `workspaceAccess`, then checks
/// the split relation while `guard` remains held.
- (BOOL)validateProjectDetachedForOperation:(NSDictionary *)operation
                            workspaceAccess:(DSHLocalWorkspaceAccess *)workspaceAccess
                     authorityMutationGuard:
                         (DSHLocalWorkspaceAuthorityMutationGuard *)guard
                                      error:(NSError **)error;

/// Writes one native receipt for a committed session generation/hash. The
/// operation must contain the exact snake-case WorkspaceAuthorityOutboxV1,
/// including its native-issued clearance_receipt_id. Replaying the exact
/// operation is idempotent; conflicting replay fails closed.
- (nullable NSDictionary *)issueReceiptForOperation:(NSDictionary *)operation
                          committedSessionGeneration:(NSUInteger)generation
                                  committedSessionSHA256:(NSString *)sessionSHA256
                                                  error:(NSError **)error;

- (nullable NSDictionary *)issueReceiptForOperation:(NSDictionary *)operation
                          committedSessionGeneration:(NSUInteger)generation
                                  committedSessionSHA256:(NSString *)sessionSHA256
                                       lockDescriptor:(int)lockDescriptor
                                      workspaceAccess:(DSHLocalWorkspaceAccess *)workspaceAccess
                               authorityMutationGuard:
                                   (DSHLocalWorkspaceAuthorityMutationGuard *)guard
                                                  error:(NSError **)error;

/// Naming-compatible alias used by session-store composition.
- (nullable NSDictionary *)storeReceiptForOperation:(NSDictionary *)operation
                           committedSessionGeneration:(NSUInteger)generation
                                   committedSessionSHA256:(NSString *)sessionSHA256
                                                   error:(NSError **)error;

/// Locked composition form. The caller must already hold the shared
/// `.sessions.cas-lock` descriptor and run on the shared coordinator queue;
/// this method never releases or reacquires that lock.
- (nullable NSDictionary *)issueReceiptForOperation:(NSDictionary *)operation
                          committedSessionGeneration:(NSUInteger)generation
                                  committedSessionSHA256:(NSString *)sessionSHA256
                                       lockDescriptor:(int)lockDescriptor
                                                  error:(NSError **)error;

/// Returns `{schema_version:1,status:'not_started'|'unknown'}` when no
/// currently valid receipt is provable, or `{schema_version:1,status:'committed',receipt:...}`
/// when the persisted receipt matches the current native session generation
/// and digest. Stale receipts are never returned.
- (nullable NSDictionary *)queryReceiptForOperationId:(NSString *)operationId
                             currentSessionGeneration:(NSUInteger)generation
                                     currentSessionSHA256:(nullable NSString *)sessionSHA256
                                                  error:(NSError **)error;

/// Operation-id spelling used by native workspace callers.
- (nullable NSDictionary *)queryClearanceForOperationId:(NSString *)operationId
                               currentSessionGeneration:(NSUInteger)generation
                                       currentSessionSHA256:(nullable NSString *)sessionSHA256
                                                    error:(NSError **)error;

/// A write id is the durable operation id; this alias keeps recovery callers
/// from accidentally introducing a second identifier namespace.
- (nullable NSDictionary *)queryReceiptForWriteId:(NSString *)writeId
                          currentSessionGeneration:(NSUInteger)generation
                                  currentSessionSHA256:(nullable NSString *)sessionSHA256
                                               error:(NSError **)error;

/// Locked query form for the session store's uninterrupted CAS + receipt
/// transaction. The caller owns the shared lock for the whole call.
- (nullable NSDictionary *)queryReceiptForOperationId:(NSString *)operationId
                             currentSessionGeneration:(NSUInteger)generation
                                     currentSessionSHA256:(nullable NSString *)sessionSHA256
                                         lockDescriptor:(int)lockDescriptor
                                                  error:(NSError **)error;

/// Revalidates a receipt against the private store, exact workspace/revision,
/// and the current session generation/hash. Forged, stale, unknown, or
/// mismatched receipts return NO and perform no mutation.
- (BOOL)validateReceipt:(NSDictionary *)receipt
            operationId:(NSString *)operationId
            workspaceId:(NSString *)workspaceId
      bindingRevision:(NSUInteger)bindingRevision
currentSessionGeneration:(NSUInteger)generation
    currentSessionSHA256:(NSString *)sessionSHA256
                  error:(NSError **)error;

@end

@compatibility_alias WorkspaceClearanceStore DSHWorkspaceClearanceStore;

NS_ASSUME_NONNULL_END
