#import <Foundation/Foundation.h>

#include <git2.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const DSHLocalProjectAccessErrorDomain;

typedef NS_ERROR_ENUM(DSHLocalProjectAccessErrorDomain,
                      DSHLocalProjectAccessErrorCode) {
  DSHLocalProjectAccessErrorInvalidIdentifier = 1,
  DSHLocalProjectAccessErrorStorageUnavailable = 2,
  DSHLocalProjectAccessErrorUnsafeStorage = 3,
  DSHLocalProjectAccessErrorRepositoryUnavailable = 4,
  DSHLocalProjectAccessErrorMetadataInvalid = 5,
  DSHLocalProjectAccessErrorLockTimeout = 6,
  DSHLocalProjectAccessErrorRootAbsent = 7,
};

typedef NS_ENUM(NSInteger, DSHLocalProjectAccessMode) {
  DSHLocalProjectAccessModeRead = 0,
  DSHLocalProjectAccessModeWrite = 1,
};

typedef void (^DSHLocalProjectAccessHook)(NSString *stage);

/// A process-wide per-project lock token. Release the token before presenting
/// credential UI or invoking unrelated asynchronous work.
@interface DSHLocalProjectLockToken : NSObject
@end

@interface DSHLocalProjectsRootLease : NSObject
@property(nonatomic, strong, readonly) NSURL *rootURL;
@property(nonatomic, readonly) int descriptor;
@property(nonatomic, readonly) dev_t device;
@property(nonatomic, readonly) ino_t inode;
@end

/// Owns the per-project lock, stable root-relative descriptors, and libgit2
/// repository handle. All resources remain valid until the lease is released.
@interface DSHLocalProjectLease : NSObject
@property(nonatomic, copy, readonly) NSString *projectId;
@property(nonatomic, strong, readonly) NSURL *projectDirectoryURL;
@property(nonatomic, strong, readonly) NSURL *repositoryURL;
@property(nonatomic, copy, readonly, nullable) NSDictionary *metadata;
@property(nonatomic, readonly) int projectsRootDescriptor;
@property(nonatomic, readonly) int projectDescriptor;
@property(nonatomic, readonly) int repositoryDescriptor;
@property(nonatomic, readonly) int gitDescriptor;
@property(nonatomic, readonly) int objectsDescriptor;
@property(nonatomic, readonly) dev_t projectsRootDevice;
@property(nonatomic, readonly) ino_t projectsRootInode;
@property(nonatomic, readonly) dev_t projectDevice;
@property(nonatomic, readonly) ino_t projectInode;
@property(nonatomic, readonly) dev_t repositoryDevice;
@property(nonatomic, readonly) ino_t repositoryInode;
@property(nonatomic, readonly) dev_t gitDevice;
@property(nonatomic, readonly) ino_t gitInode;
@property(nonatomic, readonly) dev_t objectsDevice;
@property(nonatomic, readonly) ino_t objectsInode;
@property(nonatomic, readonly) git_repository *repository;
@property(nonatomic, readonly) DSHLocalProjectAccessMode accessMode;
@end

@interface DSHLocalProjectLeaseSet : NSObject
- (nullable DSHLocalProjectLease *)leaseForProjectId:(NSString *)projectId;
@end

/// Canonical resolver shared by LocalProjects and project-context capture.
/// The default root is Application Support/workspace/projects. Tests inject a
/// temporary projects root and never touch user projects.
@interface DSHLocalProjectAccess : NSObject

+ (instancetype)sharedAccess;
+ (BOOL)isCanonicalProjectId:(NSString *)projectId;
+ (nullable NSString *)filesystemFoldedComponent:(NSString *)component;
+ (nullable NSString *)projectIdForWorkspacePath:(NSString *)path
                                           error:(NSError **)error;

- (instancetype)init;
- (instancetype)initWithProjectsRootURL:(nullable NSURL *)projectsRootURL;
- (instancetype)initWithProjectsRootURL:(nullable NSURL *)projectsRootURL
                                   hook:(nullable DSHLocalProjectAccessHook)hook
    NS_DESIGNATED_INITIALIZER;

- (nullable NSURL *)projectsRootURLWithError:(NSError **)error;
- (nullable NSURL *)projectsRootURLCreatingIfNeeded:(BOOL)create
                                               error:(NSError **)error;
- (nullable DSHLocalProjectsRootLease *)
    leaseProjectsRootCreatingIfNeeded:(BOOL)create
                                 error:(NSError **)error NS_RETURNS_RETAINED;
- (BOOL)validateProjectsRootLease:(DSHLocalProjectsRootLease *)lease
                             error:(NSError **)error;
- (nullable NSURL *)projectDirectoryURLForId:(NSString *)projectId
                                       error:(NSError **)error;

- (nullable DSHLocalProjectLockToken *)lockProjectId:(NSString *)projectId
                                                mode:(DSHLocalProjectAccessMode)mode
                                               error:(NSError **)error
    NS_RETURNS_RETAINED;
- (nullable DSHLocalProjectLockToken *)tryLockProjectIdForWrite:
    (NSString *)projectId error:(NSError **)error NS_RETURNS_RETAINED;

- (nullable DSHLocalProjectLease *)leaseProjectId:(NSString *)projectId
                                              mode:(DSHLocalProjectAccessMode)mode
                                   includeMetadata:(BOOL)includeMetadata
                                             error:(NSError **)error
    NS_RETURNS_RETAINED;

- (nullable DSHLocalProjectLeaseSet *)
    leaseWorkspaceReadPaths:(NSArray<NSString *> *)readPaths
                  writePaths:(NSArray<NSString *> *)writePaths
                     timeout:(NSTimeInterval)timeout
                       error:(NSError **)error NS_RETURNS_RETAINED;

- (BOOL)validateLeaseIdentity:(DSHLocalProjectLease *)lease
                         error:(NSError **)error;
- (nullable NSDictionary *)readProjectMetadataFromLease:(DSHLocalProjectLease *)lease
                                                   error:(NSError **)error;
- (nullable NSString *)projectMetadataDigestFromLease:(DSHLocalProjectLease *)lease
                                                 error:(NSError **)error;
- (BOOL)writeProjectMetadataRecord:(NSDictionary *)record
                              lease:(DSHLocalProjectLease *)lease
                              error:(NSError **)error;
- (BOOL)writeInitialProjectMetadataRecord:(NSDictionary *)record
                                  projectId:(NSString *)projectId
                          projectDescriptor:(int)projectDescriptor
                                 writeToken:(DSHLocalProjectLockToken *)writeToken
                                      error:(NSError **)error;

- (nullable DSHLocalProjectLease *)leaseProjectId:(NSString *)projectId
                                              mode:(DSHLocalProjectAccessMode)mode
                                   includeMetadata:(BOOL)includeMetadata
                                           timeout:(NSTimeInterval)timeout
                                             error:(NSError **)error
    NS_RETURNS_RETAINED;

@end

NS_ASSUME_NONNULL_END
