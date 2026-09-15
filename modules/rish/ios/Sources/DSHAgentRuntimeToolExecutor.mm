#import "DSHAgentRuntimeToolInternals.h"
#import "AgentWorkspaceToolExecutor.h"
#import "SessionWorkspaceCoordinator.h"
#import <objc/runtime.h>
#include "rish_agent_core.h"

@interface DSHAgentRuntimeToolExecutor ()
@property(nonatomic, strong) dispatch_source_t monitor;
@end
static char RuntimeExecutorAssociation;

static NSDictionary *Reject(NSString *code, NSString *reason) {
  return @{@"rejection":@{@"failure_code":code, @"reason":reason}};
}
static NSString *ArgumentsSHA(NSString *name, NSDictionary *arguments) {
  NSData *bytes = DSHAgentCanonicalJSON(arguments, nil);
  return bytes ? DSHAgentArgumentsSHA256(name, [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding], nil) : nil;
}
static NSString *Identity(NSString *name, NSDictionary *owner, NSDictionary *root, NSDictionary *precondition) {
  NSString *key = DSHAgentRuntimeKey(owner);
  return key ? DSHAgentHJ(@"runtime-native-identity", @{@"key":key, @"name":name,
      @"conversation_id":owner[@"conversation_id"] ?: NSNull.null, @"root":root, @"precondition":precondition}, nil) : nil;
}
static BOOL CancelRequestShape(NSDictionary *request) {
  NSData *bytes = DSHAgentCanonicalJSON(@{@"op":@"target_request", @"kind":@"cancel", @"request":request}, nil);
  if (!bytes) return NO;
  char *raw = rish_agent_runtime_reduce((const char *)bytes.bytes, bytes.length);
  if (!raw) return NO;
  NSUInteger count = strnlen(raw, 65537);
  id reply = count <= 65536 ? [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:raw length:count]
      options:0 error:nil] : nil;
  rish_agent_string_free(raw);
  return [reply isKindOfClass:NSDictionary.class] && [reply[@"ok"] isEqual:@YES];
}

@implementation DSHAgentRuntimeToolExecutor
+ (instancetype)executorForWorkspaceExecutor:(DSHAgentWorkspaceToolExecutor *)workspace {
  @synchronized (workspace) {
    DSHAgentRuntimeToolExecutor *executor = objc_getAssociatedObject(workspace, &RuntimeExecutorAssociation);
    if (!executor) {
      executor = [[self alloc] initWithResolver:workspace.rootResolver store:DSHRuntimeEnvironmentStore.sharedStore];
      objc_setAssociatedObject(workspace, &RuntimeExecutorAssociation, executor, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return executor;
  }
}
+ (instancetype)existingExecutorForWorkspaceExecutor:(DSHAgentWorkspaceToolExecutor *)workspace {
  @synchronized (workspace) { return objc_getAssociatedObject(workspace, &RuntimeExecutorAssociation); }
}
- (instancetype)initWithResolver:(DSHAgentRootResolver *)resolver store:(DSHRuntimeEnvironmentStore *)store {
  self = [super init];
  if (self) {
    _resolver = resolver; _store = store; _records = [NSMutableDictionary dictionary];
    _services = [NSMutableDictionary dictionary];
    _programFactory = ^{ return [[DSHRuntimeProgramVM alloc] initWithBundle:NSBundle.mainBundle]; };
    _serviceFactory = ^{ return [[DSHRuntimeServiceVM alloc] initWithBundle:NSBundle.mainBundle]; };
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(background)
        name:@"UIApplicationDidEnterBackgroundNotification" object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(foreground)
        name:@"UIApplicationWillEnterForegroundNotification" object:nil];
    _monitor = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(_monitor, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
        NSEC_PER_SEC, NSEC_PER_SEC / 5);
    __weak DSHAgentRuntimeToolExecutor *weak = self;
    dispatch_source_set_event_handler(_monitor, ^{ [weak auditOwners]; });
    dispatch_resume(_monitor);
  }
  return self;
}
- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  if (_monitor) dispatch_source_cancel(_monitor);
}
- (void)foreground { @synchronized (self) { self.backgrounded = NO; } }
- (void)background {
  @synchronized (self) { self.backgrounded = YES; }
  [self cancelAll];
}
- (void)cancelAll {
  NSArray *records;
  @synchronized (self) { records = self.records.allValues; }
  for (DSHAgentRuntimeRecord *record in records) [self cancelRecord:record];
}
- (void)acknowledgeSettlementOwner:(NSDictionary *)owner {
  NSString *key = DSHAgentRuntimeKey(owner);
  @synchronized (self) {
    DSHAgentRuntimeRecord *record = key ? self.records[key] : nil;
    if (!record || !record.effect) return;
    record.durable = YES;
    if (record.serviceReady && !record.serviceFinished) return;
    record.validator = nil;
    [self.records removeObjectForKey:key];
    // Finished service tombstones permit an idempotent owned Stop. Only
    // durable finished starts may be evicted; unconfirmed receipts stay live.
    if (self.services.count > 128) {
      for (NSString *serviceId in [self.services.allKeys copy]) {
        DSHAgentRuntimeRecord *service = self.services[serviceId];
        if (service.durable && service.serviceFinished) [self.services removeObjectForKey:serviceId];
        if (self.services.count <= 128) break;
      }
    }
  }
}
- (void)auditOwners {
  NSArray *records;
  @synchronized (self) { records = self.records.allValues; }
  for (DSHAgentRuntimeRecord *record in records) {
    BOOL active, service;
    @synchronized (record) { service = record.serviceReady && !record.serviceFinished;
      active = record.dispatched && !record.effect && !record.cancelled; }
    if ((active || service) && ![self recordCurrent:record execution:active && !service]) [self cancelRecord:record];
  }
}
- (BOOL)recordCurrent:(DSHAgentRuntimeRecord *)record execution:(BOOL)execution {
  @synchronized (self) { if (self.backgrounded) return NO; }
  DSHAgentRuntimeOwnerValidator validator;
  @synchronized (record) { if (record.cancelled) return NO; validator = record.validator; }
  return [self.resolver validateFrozenRoot:record.root error:nil] && (!validator || validator(execution));
}
- (void)cancelRecord:(DSHAgentRuntimeRecord *)record {
  DSHRuntimeProgramVM *vm; DSHRuntimeHTTPServer *http; NSString *token;
  @synchronized (record) { record.cancelled = YES; vm = record.vm; http = record.http; token = record.installToken; }
  // No WAL, coordinator or VM-worker wait occurs on this path.
  [http stop]; [vm cancel];
  if (token) [self.store cancelInstallToken:token];
}
- (void)cancelLocator:(NSDictionary *)locator {
  NSString *key = DSHAgentRuntimeKey(locator);
  DSHAgentRuntimeRecord *record;
  @synchronized (self) { record = key ? self.records[key] : nil; }
  if (record) [self cancelRecord:record];
}
- (void)cancelAttempt:(NSString *)attemptId {
  NSArray *records;
  @synchronized (self) { records = self.records.allValues; }
  for (DSHAgentRuntimeRecord *record in records)
    if ([record.owner[@"attempt_id"] isEqual:attemptId]) [self cancelRecord:record];
}
- (void)signalCancelRequest:(NSDictionary *)request {
  if (![request isKindOfClass:NSDictionary.class] || !CancelRequestShape(request)) return;
  NSDictionary *target = request[@"target"], *cas = request[@"controller_cas"], *token = request[@"cancel_token"];
  if (![request[@"schema_version"] isEqual:@2] || ![target isKindOfClass:NSDictionary.class] ||
      ![target[@"kind"] isEqual:@"tool"] || ![cas isKindOfClass:NSDictionary.class] ||
      ![token isKindOfClass:NSDictionary.class] || ![token[@"issuer"] isEqual:@"completion_controller"]) return;
  NSString *key = DSHAgentRuntimeKey(target);
  DSHAgentRuntimeRecord *record;
  @synchronized (self) { record = key ? self.records[key] : nil; }
  if (!record || ![record.root isEqual:request[@"root"]] ||
      ![record.owner[@"conversation_id"] isEqual:cas[@"conversation_id"]]) return;
  for (NSString *field in @[@"task_id", @"attempt_id"]) {
    if (![record.owner[field] isEqual:target[field]] || ![record.owner[field] isEqual:cas[field]] ||
        ![record.owner[field] isEqual:token[field]]) return;
  }
  for (NSString *field in @[@"round_id", @"round_index", @"call_index", @"call_id", @"idempotency_key"])
    if (![record.owner[field] isEqual:target[field]]) return;
  [self cancelRecord:record];
}
- (NSDictionary *)descriptorForId:(NSString *)environmentId {
  NSDictionary *list = [self.store listEnvironmentsForWorkspaceId:nil error:nil];
  for (NSDictionary *descriptor in list[@"environments"])
    if ([descriptor[@"environment_id"] isEqual:environmentId]) return descriptor;
  return nil;
}
- (DSHRuntimeWorkspaceSnapshot *)snapshotForArguments:(NSDictionary *)arguments root:(NSDictionary *)root error:(NSError **)error {
  NSDictionary *ref = @{@"schema_version":@1, @"workspace_id":root[@"workspace_id"],
      @"binding_revision":root[@"workspace_binding_revision"], @"project_id":root[@"project_id"]};
  return [DSHRuntimeWorkspaceSnapshot captureRoot:ref entryPath:arguments[@"entry_path"] resolver:self.resolver error:error];
}
- (NSDictionary *)prepareToolNamed:(NSString *)name arguments:(NSDictionary *)arguments root:(NSDictionary *)root {
  if (![DSHAgentRuntimeContract(@"runtime_arguments", arguments, name)[@"valid"] isEqual:@YES])
    return Reject(@"E_AGENT_BAD_ARGUMENTS", @"arguments_do_not_match_tool_schema");
  NSString *capability = [name isEqual:@"list_runtime_environments"] ? @"file_read" : @"guest_service";
  if (![root[@"capabilities"] containsObject:capability] || ![self.resolver validateFrozenRoot:root error:nil])
    return Reject(@"E_AGENT_CAPABILITY", @"runtime_root_unavailable");
  NSString *argumentsSHA = ArgumentsSHA(name, arguments), *snapshotSHA = nil, *environmentSHA = nil;
  if (!argumentsSHA) return Reject(@"E_AGENT_BAD_ARGUMENTS", @"arguments_do_not_match_tool_schema");
  if ([name isEqual:@"install_runtime_environment"]) {
    NSDictionary *catalog = [self.store catalogManifestForEnvironmentId:arguments[@"environment_id"]];
    if (!catalog) return Reject(@"E_AGENT_CAPABILITY", @"environment_not_in_catalog");
    environmentSHA = catalog[@"disk_sha256"];
  } else if ([name isEqual:@"run_program"] || [name isEqual:@"start_runtime_service"]) {
    if (![[self descriptorForId:arguments[@"environment_id"]][@"state"] isEqual:@"installed"])
      return Reject(@"E_AGENT_CAPABILITY", @"environment_not_installed");
    NSDictionary *manifest = [self.store manifestForEnvironmentId:arguments[@"environment_id"]];
    environmentSHA = manifest[@"disk_sha256"];
    NSError *error = nil;
    @autoreleasepool {
      DSHRuntimeWorkspaceSnapshot *snapshot = [self snapshotForArguments:arguments root:root error:&error];
      if (snapshot) snapshotSHA = DSHAgentRuntimeSnapshotSHA(snapshot);
    }
    if (!snapshotSHA) return Reject(@"E_AGENT_TOOL_FAILED",
        [error.userInfo[@"code"] isEqual:@"E_PROGRAM_NOT_FOUND"] ? @"entry_not_found" : @"workspace_snapshot_unavailable");
  }
  NSDictionary *condition = @{@"schema_version":@1, @"kind":name, @"arguments_sha256":argumentsSHA,
      @"snapshot_sha256":snapshotSHA ?: NSNull.null, @"environment_sha256":environmentSHA ?: NSNull.null};
  if (!DSHAgentRuntimeContractValid(@"runtime_precondition", condition))
    return Reject(@"E_AGENT_TOOL_FAILED", @"runtime_precondition_unavailable");
  return @{@"precondition":condition, @"reserved_write_bytes":@0};
}
- (BOOL)registerToolNamed:(NSString *)name arguments:(NSDictionary *)arguments root:(NSDictionary *)root
                    owner:(NSDictionary *)owner precondition:(NSDictionary *)precondition validator:(DSHAgentRuntimeOwnerValidator)validator {
  NSString *key = DSHAgentRuntimeKey(owner), *identity = Identity(name, owner, root, precondition);
  if (!key || !identity || !DSHAgentRuntimeContractValid(@"runtime_precondition", precondition) ||
      ![precondition[@"kind"] isEqual:name] ||
      ![ArgumentsSHA(name, arguments) isEqual:precondition[@"arguments_sha256"]] ||
      (owner[@"arguments_sha256"] && ![owner[@"arguments_sha256"] isEqual:precondition[@"arguments_sha256"]])) return NO;
  @synchronized (self) {
    DSHAgentRuntimeRecord *existing = self.records[key];
    if (existing) return [existing.identity isEqual:identity];
    if (self.records.count >= 512) {
      DSHAgentRuntimeRecord *service = [name isEqual:@"stop_runtime_service"] ? self.services[arguments[@"service_id"]] : nil;
      BOOL emergencyStop = [name isEqual:@"stop_runtime_service"] && self.records.count == 512 &&
          service && !service.serviceFinished && [service.root isEqual:root] &&
          [service.owner[@"conversation_id"] isEqual:owner[@"conversation_id"]];
      if (!emergencyStop) return NO;
    }
    DSHAgentRuntimeRecord *record = [[DSHAgentRuntimeRecord alloc] init];
    record.key = key; record.identity = identity; record.name = name;
    record.owner = DSHAgentImmutableJSONCopy(owner, nil); record.root = DSHAgentImmutableJSONCopy(root, nil);
    record.arguments = DSHAgentImmutableJSONCopy(arguments, nil);
    record.precondition = DSHAgentImmutableJSONCopy(precondition, nil); record.validator = validator;
    record.stdoutData = [NSMutableData data]; record.stderrData = [NSMutableData data]; record.cancelled = self.backgrounded;
    self.records[key] = record;
    return YES;
  }
}
- (NSDictionary *)executeToolNamed:(NSString *)name arguments:(NSDictionary *)arguments root:(NSDictionary *)root
                             owner:(NSDictionary *)owner precondition:(NSDictionary *)precondition {
  DSHAgentRuntimeRecord *record;
  @synchronized (self) { record = self.records[DSHAgentRuntimeKey(owner)]; }
  if (!record || ![record.identity isEqual:Identity(name, owner, root, precondition)]) return nil;
  @synchronized (record) {
    if (record.effect) return record.effect;
    if (record.dispatched) return DSHAgentRuntimeEffect(name, @"ambiguous",
        @{@"schema_version":@1, @"failure_code":@"E_AGENT_EXECUTION_AMBIGUOUS"}, precondition, YES);
    record.dispatched = YES;
  }
  NSDictionary *effect;
  @try { effect = [self performRecord:record]; }
  @catch (__unused NSException *exception) { [self cancelRecord:record];
    effect = DSHAgentRuntimeFailure(record, @"E_AGENT_TOOL_FAILED", @"runtime_native_failure", nil); }
  if (!effect) effect = DSHAgentRuntimeFailure(record, @"E_AGENT_TOOL_FAILED", @"runtime_feedback_unavailable", nil);
  @synchronized (record) {
    record.effect = effect;
    if (!record.serviceReady || record.serviceFinished) {
      [record.stdoutData setLength:0]; [record.stderrData setLength:0];
      record.validator = nil;
    }
  }
  return effect;
}
- (NSDictionary *)recoverToolNamed:(NSString *)name arguments:(NSDictionary *)arguments root:(NSDictionary *)root
                             owner:(NSDictionary *)owner precondition:(NSDictionary *)precondition {
  if (![precondition[@"kind"] isEqual:name] || ![ArgumentsSHA(name, arguments) isEqual:precondition[@"arguments_sha256"]] ||
      ![self.resolver validateFrozenRoot:root error:nil]) return @{@"schema_version":@1, @"status":@"ambiguous"};
  DSHAgentRuntimeRecord *record;
  @synchronized (self) { record = self.records[DSHAgentRuntimeKey(owner)]; }
  if (record && [record.identity isEqual:Identity(name, owner, root, precondition)]) {
    @synchronized (record) {
      if (record.effect) return @{@"schema_version":@1, @"status":@"settled", @"effect":record.effect};
    }
  }
  if ([name isEqual:@"install_runtime_environment"] &&
      [[self descriptorForId:arguments[@"environment_id"]][@"state"] isEqual:@"installed"] &&
      [[[self.store manifestForEnvironmentId:arguments[@"environment_id"]] objectForKey:@"disk_sha256"]
          isEqual:precondition[@"environment_sha256"]]) {
    NSDictionary *payload = @{@"schema_version":@1, @"environment_id":arguments[@"environment_id"], @"status":@"installed"};
    NSDictionary *effect = DSHAgentRuntimeEffect(name, @"ok", payload, precondition, YES);
    if (effect) return @{@"schema_version":@1, @"status":@"settled", @"effect":effect};
  }
  return @{@"schema_version":@1, @"status":@"ambiguous"};
}
@end
