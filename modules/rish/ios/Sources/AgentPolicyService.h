#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class DSHAgentRootResolver;
@class DSHAgentToolRegistry;
@class DSHSessionWorkspaceCoordinator;

FOUNDATION_EXPORT NSErrorDomain const DSHAgentPolicyErrorDomain;

/// Display-only policy for the current native workspace/project binding.
/// This service never creates an attempt, writes a WAL, or grants execution
/// authority. Native tools still perform their normal approval/root checks.
@interface DSHAgentPolicyService : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithRootResolver:(DSHAgentRootResolver *)rootResolver
                            registry:(DSHAgentToolRegistry *)registry
                         coordinator:(DSHSessionWorkspaceCoordinator *)coordinator
    NS_DESIGNATED_INITIALIZER;

/// Exact request: schema_version=1, workspace_id, workspace_binding_revision,
/// project_id (canonical UUID or NSNull). Only safe policy metadata is returned.
- (nullable NSDictionary *)describeRequest:(id)request error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
