#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#import "AgentPolicyService.h"
#import "AgentRootResolver.h"
#import "AgentToolRegistry.h"
#import "ProjectContextService.h"
#import "SessionWorkspaceCoordinator.h"

@interface DSHProjectContextService (DSHAgentPolicyComposition)
@property(nonatomic, strong, readonly) DSHLocalProjectAccess *projectAccess;
@property(nonatomic, strong, readonly) DSHLocalWorkspaceAccess *workspaceAccess;
@end

@interface AgentPolicyModule : NSObject <RCTBridgeModule>
@property(nonatomic, strong) DSHAgentPolicyService *policyService;
@end

@implementation AgentPolicyModule

RCT_EXPORT_MODULE(AgentPolicy)

+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return DSHSessionWorkspaceCoordinator.sharedQueue; }

// Application-owned injection for native bridge tests; not exposed to JS.
- (instancetype)initWithPolicyService:(DSHAgentPolicyService *)service {
  self = [super init];
  if (self) _policyService = service;
  return self;
}

- (DSHAgentPolicyService *)resolvedPolicyService {
  if (self.policyService == nil) {
    DSHProjectContextService *context = DSHSharedProjectContextService();
    if (context.workspaceAccess == nil || context.projectAccess == nil) return nil;
    DSHAgentRootResolver *resolver = [[DSHAgentRootResolver alloc]
        initWithWorkspaceAccess:context.workspaceAccess projectAccess:context.projectAccess];
    self.policyService = [[DSHAgentPolicyService alloc]
        initWithRootResolver:resolver registry:[[DSHAgentToolRegistry alloc] init]
        coordinator:DSHSessionWorkspaceCoordinator.sharedCoordinator];
  }
  return self.policyService;
}

RCT_REMAP_METHOD(describe,
                 describeRequest:(id)request
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [DSHSessionWorkspaceCoordinator.sharedCoordinator performAsync:^{
    NSError *error = nil;
    NSDictionary *result = nil;
    @try {
      result = [[self resolvedPolicyService] describeRequest:request error:&error];
    } @catch (__unused NSException *exception) {
      result = nil;
    }
    if (result != nil) {
      resolve(result);
      return;
    }
    NSDictionary *messages = @{
      @"E_AGENT_BAD_ARGUMENTS": @"Agent policy request is invalid.",
      @"E_AGENT_ROOT_STALE": @"The workspace binding is no longer current.",
      @"E_AGENT_NATIVE": @"Agent policy is unavailable.",
    };
    NSString *code = [error.domain isEqual:DSHAgentPolicyErrorDomain]
        ? error.userInfo[@"code"] : nil;
    if (![code isKindOfClass:NSString.class] || messages[code] == nil) code = @"E_AGENT_NATIVE";
    reject(code, messages[code], nil);
  }];
}

@end
