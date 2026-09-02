#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class DSHAgentRootResolver;

/// Native-only Git executor over the current LocalWorkspace/LocalProjects
/// authority services.  It never resolves a repository from project_id alone.
@interface DSHAgentGitToolExecutor : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithRootResolver:(DSHAgentRootResolver *)rootResolver
    NS_DESIGNATED_INITIALIZER;

- (nullable NSDictionary *)prepareToolNamed:(NSString *)name
                                  arguments:(NSDictionary *)arguments
                                       root:(NSDictionary *)root
                                      error:(NSError **)error;
- (nullable NSDictionary *)executeToolNamed:(NSString *)name
                                  arguments:(NSDictionary *)arguments
                                       root:(NSDictionary *)root
                               precondition:(NSDictionary *)precondition
                                      error:(NSError **)error;
- (nullable NSDictionary *)recoverToolNamed:(NSString *)name
                                  arguments:(NSDictionary *)arguments
                                       root:(NSDictionary *)root
                               precondition:(NSDictionary *)precondition
                                      error:(NSError **)error;

@property(nonatomic, strong, readonly) DSHAgentRootResolver *rootResolver;

@end

@compatibility_alias AgentGitToolExecutor DSHAgentGitToolExecutor;

NS_ASSUME_NONNULL_END
