#import "AgentPolicyService.h"

#import "AgentNativeWAL.h"
#import "AgentRootResolver.h"
#import "AgentToolRegistry.h"
#import "SessionWorkspaceCoordinator.h"

NSErrorDomain const DSHAgentPolicyErrorDomain = @"tech.zseven.rish.agent-policy";
static const NSUInteger DSHPolicyMaximumSafeInteger = 9007199254740991ULL;

static NSError *DSHPolicyError(NSString *code) {
  NSDictionary *messages = @{
    @"E_AGENT_BAD_ARGUMENTS": @"Agent policy request is invalid.",
    @"E_AGENT_ROOT_STALE": @"The workspace binding is no longer current.",
    @"E_AGENT_NATIVE": @"Agent policy is unavailable.",
  };
  if (![code isKindOfClass:NSString.class] || messages[code] == nil) code = @"E_AGENT_NATIVE";
  return [NSError errorWithDomain:DSHAgentPolicyErrorDomain code:1 userInfo:@{
    @"code": code, NSLocalizedDescriptionKey: messages[code],
  }];
}

static NSError *DSHPolicyMapRootError(NSError *error) {
  if ([error.domain isEqual:DSHAgentNativeStoreErrorDomain]) {
    if (error.code == DSHAgentNativeStoreErrorOwnerLost ||
        error.code == DSHAgentNativeStoreErrorNotFound ||
        error.code == DSHAgentNativeStoreErrorConflict) {
      return DSHPolicyError(@"E_AGENT_ROOT_STALE");
    }
  } else if ([error.domain isEqual:DSHLocalWorkspaceAccessErrorDomain]) {
    switch ((DSHLocalWorkspaceAccessErrorCode)error.code) {
      case DSHLocalWorkspaceAccessErrorNotFound:
      case DSHLocalWorkspaceAccessErrorRevisionStale:
      case DSHLocalWorkspaceAccessErrorRootChanged:
      case DSHLocalWorkspaceAccessErrorStatusStale:
      case DSHLocalWorkspaceAccessErrorRevoked:
      case DSHLocalWorkspaceAccessErrorNotDownloaded:
        return DSHPolicyError(@"E_AGENT_ROOT_STALE");
      default: break;
    }
  }
  return DSHPolicyError(@"E_AGENT_NATIVE");
}

static BOOL DSHPolicyValidRequest(id request) {
  return DSHAgentExactDictionaryKeys(request, @[
      @"schema_version", @"workspace_id", @"workspace_binding_revision", @"project_id",
    ]) &&
    DSHAgentSafeInteger(request[@"schema_version"], 1, NO) &&
    [request[@"schema_version"] isEqual:@1] &&
    DSHAgentCanonicalUUID(request[@"workspace_id"]) &&
    DSHAgentSafeInteger(request[@"workspace_binding_revision"],
                         DSHPolicyMaximumSafeInteger, NO) &&
    (request[@"project_id"] == NSNull.null ||
      DSHAgentCanonicalUUID(request[@"project_id"]));
}

static BOOL DSHPolicyValidBudget(NSDictionary *policy) {
  return DSHAgentExactDictionaryKeys(policy, @[
      @"schema_version", @"policy_version", @"max_single_write_bytes",
      @"max_batch_write_bytes", @"max_attempt_write_bytes",
    ]) &&
    DSHAgentSafeInteger(policy[@"schema_version"], 1, NO) &&
    [policy[@"policy_version"] isEqual:@"agent-v1"] &&
    DSHAgentSafeInteger(policy[@"max_single_write_bytes"], DSHPolicyMaximumSafeInteger, NO) &&
    DSHAgentSafeInteger(policy[@"max_batch_write_bytes"], DSHPolicyMaximumSafeInteger, NO) &&
    DSHAgentSafeInteger(policy[@"max_attempt_write_bytes"], DSHPolicyMaximumSafeInteger, NO) &&
    [policy[@"max_single_write_bytes"] unsignedLongLongValue] <=
      [policy[@"max_batch_write_bytes"] unsignedLongLongValue] &&
    [policy[@"max_batch_write_bytes"] unsignedLongLongValue] <=
      [policy[@"max_attempt_write_bytes"] unsignedLongLongValue];
}

@interface DSHAgentPolicyService ()
@property(nonatomic, strong) DSHAgentRootResolver *rootResolver;
@property(nonatomic, strong) DSHAgentToolRegistry *registry;
@property(nonatomic, strong) DSHSessionWorkspaceCoordinator *coordinator;
@end

@implementation DSHAgentPolicyService

- (instancetype)initWithRootResolver:(DSHAgentRootResolver *)rootResolver
                            registry:(DSHAgentToolRegistry *)registry
                         coordinator:(DSHSessionWorkspaceCoordinator *)coordinator {
  self = [super init];
  if (self) {
    _rootResolver = rootResolver;
    _registry = registry;
    _coordinator = coordinator;
  }
  return self;
}

- (NSDictionary *)describeRequest:(id)request error:(NSError **)error {
  if (error != nullptr) *error = nil;
  if (self.rootResolver == nil || self.registry == nil || self.coordinator == nil) {
    if (error != nullptr) *error = DSHPolicyError(@"E_AGENT_NATIVE");
    return nil;
  }
  __block NSDictionary *result = nil;
  NSError *transactionError = nil;
  BOOL completed = [self.coordinator performSyncWithError:^BOOL(NSError **inner) {
    if (!DSHPolicyValidRequest(request)) {
      *inner = DSHPolicyError(@"E_AGENT_BAD_ARGUMENTS");
      return NO;
    }
    NSDictionary *identity = DSHAgentImmutableJSONCopy(request, nil);
    if (identity == nil) {
      *inner = DSHPolicyError(@"E_AGENT_BAD_ARGUMENTS");
      return NO;
    }
    NSError *nativeError = nil;
    NSDictionary *root = [self.rootResolver
        resolveRootForWorkspaceId:identity[@"workspace_id"]
        projectId:identity[@"project_id"] == NSNull.null ? nil : identity[@"project_id"]
        bindingRevision:identity[@"workspace_binding_revision"] error:&nativeError];
    if (root == nil) {
      *inner = DSHPolicyMapRootError(nativeError);
      return NO;
    }
    if (![DSHAgentRootResolver validateAgentRootProjection:root error:nil] ||
        ![root[@"workspace_id"] isEqual:identity[@"workspace_id"]] ||
        ![root[@"workspace_binding_revision"] isEqual:identity[@"workspace_binding_revision"]] ||
        ![root[@"project_id"] isEqual:identity[@"project_id"]]) {
      *inner = DSHPolicyError(@"E_AGENT_ROOT_STALE");
      return NO;
    }
    NSDictionary *registry = [self.registry registryForRoot:root error:&nativeError];
    NSDictionary *policy = [self.registry policyForRoot:root error:&nativeError];
    if (![DSHAgentToolRegistry validateRegistryProjection:registry root:root error:nil] ||
        !DSHPolicyValidBudget(policy)) {
      *inner = DSHPolicyError(@"E_AGENT_NATIVE");
      return NO;
    }
    if (![self.rootResolver validateFrozenRoot:root error:&nativeError]) {
      *inner = DSHPolicyMapRootError(nativeError);
      return NO;
    }
    NSMutableArray *tools = [NSMutableArray array];
    for (NSDictionary *tool in registry[@"tools"]) {
      [tools addObject:@{@"name": tool[@"name"], @"access": tool[@"access"]}];
    }
    // Enumerate output keys explicitly: never return paths, native descriptor
    // tables, arguments or authority handles. The root digest lets UI reject
    // stale grant displays; it grants no execution authority.
    result = @{
      @"schema_version": @1,
      @"workspace_id": identity[@"workspace_id"],
      @"workspace_binding_revision": identity[@"workspace_binding_revision"],
      @"project_id": identity[@"project_id"],
      @"registry_version": registry[@"registry_version"],
      @"root_fingerprint_sha256": root[@"root_fingerprint_sha256"],
      @"policy_version": policy[@"policy_version"],
      @"capabilities": [root[@"capabilities"] copy],
      @"tools": [tools copy],
      @"budget": @{
        @"max_single_write_bytes": policy[@"max_single_write_bytes"],
        @"max_batch_write_bytes": policy[@"max_batch_write_bytes"],
        @"max_attempt_write_bytes": policy[@"max_attempt_write_bytes"],
      },
    };
    return YES;
  } error:&transactionError];
  if (!completed || result == nil) {
    if (error != nullptr) {
      // The coordinator also contains native exceptions. Its NSError and any
      // underlying paths/exception text are intentionally discarded here.
      *error = [transactionError.domain isEqual:DSHAgentPolicyErrorDomain]
          ? DSHPolicyError(transactionError.userInfo[@"code"])
          : DSHPolicyError(@"E_AGENT_NATIVE");
    }
    return nil;
  }
  return result;
}

@end
