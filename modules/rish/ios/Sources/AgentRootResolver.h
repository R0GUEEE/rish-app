#import <Foundation/Foundation.h>

#import "LocalProjectAccess.h"
#import "LocalWorkspaceAccess.h"
#import "LegacyBoundProjectRootAccess.h"

NS_ASSUME_NONNULL_BEGIN

@class DSHAgentRootFinalProof;

typedef NS_ENUM(NSInteger, DSHAgentRootOperationMode) {
  DSHAgentRootOperationModeRead = 0,
  DSHAgentRootOperationModeWrite = 1,
  DSHAgentRootOperationModeGitRead = 2,
  DSHAgentRootOperationModeGitWrite = 3,
  DSHAgentRootOperationModeProjectContext = 4,
};

/// Both arguments are borrowed native handles and must not escape the block.
/// `repository` is non-null only for Git modes.
typedef BOOL (^DSHAgentRootOperation)(int rootDescriptor,
                                      git_repository *_Nullable repository,
                                      NSError **error);

/// Native-only resolver for the opaque root authority used by an Agent
/// attempt.  This type intentionally exposes no URL, bookmark, descriptor,
/// inode, or provider payload on its result.  A returned dictionary is the
/// exact safe `AgentRuntimeRootV1` projection from the approved Agent Runtime
/// contract and is suitable for persistence in the native WAL only.
@interface DSHAgentRootResolver : NSObject

- (instancetype)init NS_UNAVAILABLE;

- (instancetype)initWithWorkspaceAccess:(DSHLocalWorkspaceAccess *)workspaceAccess
                           projectAccess:(nullable DSHLocalProjectAccess *)projectAccess
    NS_DESIGNATED_INITIALIZER;

/// Resolves one opaque workspace binding and, when present, its native
/// verified project binding.  A nil workspace/project/revision triple means
/// that no Agent root is resolved and returns nil without an error.  Partial
/// nil identity is invalid and fails closed.
- (nullable NSDictionary *)resolveRootForWorkspaceId:(nullable NSString *)workspaceId
                                           projectId:(nullable NSString *)projectId
                                     bindingRevision:(nullable NSNumber *)bindingRevision
                                               error:(NSError **)error;

/// Re-resolves and compares every field of a frozen root.  This is the only
/// root check a native tool executor should use before opening a workspace or
/// repository.  A mismatch is a stable conflict/root-stale failure and never
/// produces a replacement root.
- (BOOL)validateFrozenRoot:(NSDictionary *)root error:(NSError **)error;

/// Acquires the existing workspace authority lock for a frozen root.  The
/// caller must retain this native-only guard across the final proof and the
/// complete WAL transaction; no bridge object can provide or serialize it.
- (nullable DSHLocalWorkspaceAuthorityMutationGuard *)
    acquireAuthorityMutationGuardForFrozenRoot:(NSDictionary *)root
                                         error:(NSError **)error
    NS_RETURNS_RETAINED;

/// Exact root proof performed while the caller already owns the guard above.
/// It never reacquires the authority lock, so the workspace cannot be
/// rebound between this proof and the caller's durable commit.
- (BOOL)validateFrozenRoot:(NSDictionary *)root
     authorityMutationGuard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
                      error:(NSError **)error;

/// Returns a retained native workspace lease after revalidating the frozen
/// root and requested workspace capability set.  The lease is native-only.
- (nullable DSHLocalWorkspaceLease *)workspaceLeaseForFrozenRoot:
    (NSDictionary *)root
    requiredWorkspaceCapabilities:(NSSet<NSString *> *)capabilities
                             error:(NSError **)error NS_RETURNS_RETAINED;

/// Returns a retained native project lease after revalidating the frozen
/// project root.  No project-id-only or path fallback is permitted.
- (nullable DSHLocalProjectLease *)projectLeaseForFrozenRoot:(NSDictionary *)root
                                                        mode:(DSHLocalProjectAccessMode)mode
                                                     timeout:(NSTimeInterval)timeout
                                                       error:(NSError **)error
    NS_RETURNS_RETAINED;

/// Runs one operation against the exact frozen authority. Legacy project
/// bindings are attempted through the compatibility adapter first;
/// Documents-owned bindings fall through to the existing split-git leases.
/// Both routes revalidate authority and physical identity after the block.
- (BOOL)performOperationForFrozenRoot:(NSDictionary *)root
                                 mode:(DSHAgentRootOperationMode)mode
                              timeout:(NSTimeInterval)timeout
                                block:(DSHAgentRootOperation)block
                                error:(NSError **)error;

/// Acquires the final authority proof retained across a native WAL
/// transaction. The opaque token owns all required leases and the workspace
/// mutation guard; it exposes no descriptors or repository handles.
- (nullable DSHAgentRootFinalProof *)
    acquireFinalProofForFrozenRoot:(NSDictionary *)root
              requiredCapabilities:(NSSet<NSString *> *)capabilities
                 needsProjectLease:(BOOL)needsProjectLease
               projectWriteAccess:(BOOL)projectWriteAccess
                             error:(NSError **)error NS_RETURNS_RETAINED;

/// Exact safe projection validation shared by the prepared-authority store
/// and native executors.  It never resolves a caller-supplied path.
+ (BOOL)validateAgentRootProjection:(NSDictionary *)root error:(NSError **)error;

@property(nonatomic, strong, readonly) DSHLocalWorkspaceAccess *workspaceAccess;
@property(nonatomic, strong, readonly, nullable) DSHLocalProjectAccess *projectAccess;
@property(nonatomic, strong, readonly, nullable)
    DSHLegacyBoundProjectRootAccess *legacyBoundProjectAccess;

@end

@compatibility_alias AgentRootResolver DSHAgentRootResolver;

NS_ASSUME_NONNULL_END
