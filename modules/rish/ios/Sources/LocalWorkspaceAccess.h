#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const DSHLocalWorkspaceAccessErrorDomain;

typedef NS_ERROR_ENUM(DSHLocalWorkspaceAccessErrorDomain,
                      DSHLocalWorkspaceAccessErrorCode) {
  DSHLocalWorkspaceAccessErrorInvalid = 1,
  DSHLocalWorkspaceAccessErrorNotFound = 2,
  DSHLocalWorkspaceAccessErrorBusy = 3,
  DSHLocalWorkspaceAccessErrorRevisionStale = 4,
  DSHLocalWorkspaceAccessErrorRevisionOverflow = 5,
  DSHLocalWorkspaceAccessErrorUnavailable = 6,
  DSHLocalWorkspaceAccessErrorCapability = 7,
  DSHLocalWorkspaceAccessErrorConflict = 8,
  DSHLocalWorkspaceAccessErrorPersistence = 9,
  DSHLocalWorkspaceAccessErrorIO = 10,
};

typedef NSDate * _Nonnull (^DSHLocalWorkspaceClock)(void);
typedef NSString * _Nonnull (^DSHLocalWorkspaceUUIDGenerator)(void);
typedef BOOL (^DSHLocalWorkspaceLegacyResolver)(
    NSString *projectId,
    NSString * _Nullable * _Nullable rootIdentitySHA256,
    NSSet<NSString *> * _Nullable * _Nullable capabilities,
    NSError * _Nullable * _Nullable error);
typedef BOOL (^DSHLocalWorkspaceFaultHook)(NSString *stage);

/// Shared pure revision rule for future bounded authority mutations.
FOUNDATION_EXPORT BOOL DSHLocalWorkspaceValidateBindingRevisionAdvance(
    NSNumber *currentRevision,
    NSNumber *proposedRevision,
    NSError * _Nullable * _Nullable error);

/// Private native authority core. It owns no React bridge and therefore cannot
/// be used by JavaScript to submit arbitrary registry or authority records.
/// Later tasks expose only bounded, purpose-specific bridge operations.
@interface DSHLocalWorkspaceAccess : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithPrivateRootURL:(NSURL *)privateRootURL
                                  clock:(DSHLocalWorkspaceClock)clock
                          UUIDGenerator:(DSHLocalWorkspaceUUIDGenerator)UUIDGenerator
                         legacyResolver:(DSHLocalWorkspaceLegacyResolver)legacyResolver
                              faultHook:(nullable DSHLocalWorkspaceFaultHook)faultHook
    NS_DESIGNATED_INITIALIZER;

- (BOOL)ensurePrivateLayoutWithError:(NSError **)error;

/// Returns metadata-only WorkspaceDescriptorV2 dictionaries. No root URL,
/// bookmark, descriptor, inode, or native error is projected.
- (nullable NSArray<NSDictionary *> *)listWorkspaceMetadataWithError:
    (NSError **)error;

/// A nil revision is a metadata probe and always returns zero operational
/// capabilities. Operational resolution requires the exact current revision.
- (nullable NSDictionary *)resolveWorkspaceId:(NSString *)workspaceId
                       expectedBindingRevision:(nullable NSNumber *)revision
                          requiredCapabilities:(NSArray<NSString *> *)capabilities
                                         error:(NSError **)error;

- (nullable NSDictionary *)queryOperationId:(NSString *)operationId
                                        error:(NSError **)error;

/// A1's only purpose-specific authority mutation. The resolver is injected;
/// binding to the real LocalProjectAccess implementation remains a later task.
- (nullable NSDictionary *)bootstrapLegacyProjectId:(NSString *)projectId
                                         displayName:(NSString *)displayName
                                          operationId:(NSString *)operationId
                                                error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
