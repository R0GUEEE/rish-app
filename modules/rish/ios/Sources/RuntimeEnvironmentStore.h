#import <Foundation/Foundation.h>
#import "RuntimeEnvironmentPackage.h"

NS_ASSUME_NONNULL_BEGIN
@interface DSHRuntimeEnvironmentLease : NSObject
@property(nonatomic, copy, readonly) NSString *environmentId;
@property(nonatomic, copy, readonly) NSDictionary *manifest;
@property(nonatomic, strong, readonly) NSURL *diskURL;
@end

typedef void (^DSHEnvironmentCompletion)(NSDictionary *_Nullable descriptor, NSError *_Nullable error);

@interface DSHRuntimeEnvironmentStore : NSObject
+ (instancetype)sharedStore;
// Native test injection only. rootURL must be an application-owned private directory.
- (instancetype)initWithRootURL:(NSURL *)rootURL catalog:(NSDictionary *)catalog
                  kernelSHA256:(NSString *)kernelSHA256;
- (nullable NSDictionary *)listEnvironmentsForWorkspaceId:(nullable NSString *)workspaceId
                                                   error:(NSError **)error;
- (BOOL)selectEnvironmentId:(NSString *)environmentId workspaceId:(NSString *)workspaceId
                     error:(NSError **)error;
- (BOOL)removeEnvironmentId:(NSString *)environmentId error:(NSError **)error;
- (void)installEnvironmentId:(NSString *)environmentId completion:(DSHEnvironmentCompletion)completion;
- (void)downloadURL:(NSString *)url completion:(DSHEnvironmentCompletion)completion;
// Caller holds any security-scoped access until completion.
- (void)importPackageURL:(NSURL *)url completion:(DSHEnvironmentCompletion)completion;
- (BOOL)cancelInstall;
- (nullable DSHRuntimeEnvironmentLease *)acquireLeaseForEnvironmentId:(NSString *)environmentId
                                                              error:(NSError **)error;
- (void)releaseLease:(DSHRuntimeEnvironmentLease *)lease;
@end
NS_ASSUME_NONNULL_END
