#import "DSHAgentRuntimeToolInternals.h"

static NSDictionary *Failure(DSHAgentRuntimeRecord *record, NSString *reason) {
  return DSHAgentRuntimeFailure(record, @"E_AGENT_TOOL_FAILED", reason, nil);
}
static NSDictionary *Cancelled(DSHAgentRuntimeRecord *record) {
  return DSHAgentRuntimeFailure(record, @"E_AGENT_CANCELLED", @"runtime_cancelled", nil);
}

@implementation DSHAgentRuntimeToolExecutor (Effects)
- (NSDictionary *)listForRecord:(DSHAgentRuntimeRecord *)record {
  NSDictionary *listed = [self.store listEnvironmentsForWorkspaceId:record.root[@"workspace_id"] error:nil];
  if (!listed) return Failure(record, @"environment_storage_unavailable");
  NSMutableArray *entries = [NSMutableArray array]; BOOL truncated = NO;
  for (NSDictionary *descriptor in listed[@"environments"]) {
    if (entries.count >= 128) { truncated = YES; break; }
    NSString *identifier = descriptor[@"environment_id"];
    BOOL available = [self.store catalogManifestForEnvironmentId:identifier] != nil;
    [entries addObject:@{@"environment_id":identifier, @"family":descriptor[@"family"],
      @"version":descriptor[@"version"], @"installed":@([descriptor[@"state"] isEqual:@"installed"]),
      @"available":@(available), @"package_bytes":available ? descriptor[@"total_bytes"] : NSNull.null}];
  }
  return DSHAgentRuntimeEffect(record.name, @"ok", @{@"schema_version":@1,
      @"environments":entries, @"truncated":@(truncated)}, record.precondition, NO);
}
- (NSDictionary *)installForRecord:(DSHAgentRuntimeRecord *)record {
  NSString *identifier = record.arguments[@"environment_id"];
  NSDictionary *catalog = [self.store catalogManifestForEnvironmentId:identifier];
  if (!catalog || ![catalog[@"disk_sha256"] isEqual:record.precondition[@"environment_sha256"]])
    return Failure(record, @"environment_catalog_changed");
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSDictionary *installed = nil; __block NSError *failure = nil;
  NSObject *lock = [[NSObject alloc] init];
  if (record.cancelled) return Cancelled(record);
  NSString *token = [self.store beginInstallEnvironmentId:identifier completion:^(NSDictionary *descriptor, NSError *error) {
    @synchronized (lock) { installed = descriptor; failure = error; }
    dispatch_semaphore_signal(done);
  }];
  BOOL cancelled;
  @synchronized (record) { record.installToken = token; record.effectStarted = token != nil; cancelled = record.cancelled; }
  if (cancelled && token) [self.store cancelInstallToken:token];
  BOOL timedOut = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 1200LL * NSEC_PER_SEC)) != 0;
  if (timedOut) {
    if (token) [self.store cancelInstallToken:token];
    return DSHAgentRuntimeEffect(record.name, @"ambiguous", @{@"schema_version":@1,
        @"failure_code":@"E_AGENT_EXECUTION_AMBIGUOUS"}, record.precondition, record.effectStarted);
  }
  @synchronized (record) { record.installToken = nil; cancelled = record.cancelled; }
  @synchronized (lock) {
    if ([failure.userInfo[@"code"] isEqual:@"E_ENV_CANCELLED"]) {
      record.cancelled = YES; cancelled = YES;
    }
  }
  if (cancelled) return Cancelled(record);
  NSDictionary *manifest = [self.store manifestForEnvironmentId:identifier];
  @synchronized (lock) {
    if (!installed || failure || ![manifest[@"disk_sha256"] isEqual:record.precondition[@"environment_sha256"]])
      return Failure(record, [failure.userInfo[@"code"] isEqual:@"E_ENV_BUSY"] ? @"environment_install_busy" : @"environment_install_failed");
  }
  if (![self recordCurrent:record execution:YES]) { [self cancelRecord:record]; return Cancelled(record); }
  return DSHAgentRuntimeEffect(record.name, @"ok", @{@"schema_version":@1,
      @"environment_id":identifier, @"status":@"installed"}, record.precondition, record.effectStarted);
}
- (NSDictionary *)performRecord:(DSHAgentRuntimeRecord *)record {
  if (![self recordCurrent:record execution:YES]) { [self cancelRecord:record]; return Cancelled(record); }
  if ([record.name isEqual:@"list_runtime_environments"]) return [self listForRecord:record];
  if ([record.name isEqual:@"install_runtime_environment"]) return [self installForRecord:record];
  if ([record.name isEqual:@"stop_runtime_service"]) return [self performServiceStop:record];
  NSDictionary *arguments = record.arguments;
  if (![[self descriptorForId:arguments[@"environment_id"]][@"state"] isEqual:@"installed"])
    return Failure(record, @"environment_not_installed");
  NSDictionary *manifest = [self.store manifestForEnvironmentId:arguments[@"environment_id"]];
  if (![manifest[@"disk_sha256"] isEqual:record.precondition[@"environment_sha256"]])
    return Failure(record, @"installed_environment_changed");
  NSError *error = nil;
  DSHRuntimeWorkspaceSnapshot *snapshot = [self snapshotForArguments:arguments root:record.root error:&error];
  if (!snapshot || ![DSHAgentRuntimeSnapshotSHA(snapshot) isEqual:record.precondition[@"snapshot_sha256"]])
    return Failure(record, @"workspace_snapshot_changed");
  DSHRuntimeEnvironmentLease *lease = [self.store acquireLeaseForEnvironmentId:arguments[@"environment_id"] error:&error];
  if (!lease) return Failure(record, [error.userInfo[@"code"] isEqual:@"E_ENV_IN_USE"] ? @"runtime_busy" : @"environment_lease_unavailable");
  if (![lease.manifest[@"disk_sha256"] isEqual:record.precondition[@"environment_sha256"]] ||
      ![self recordCurrent:record execution:YES]) {
    [self.store releaseLease:lease]; [self cancelRecord:record]; return Cancelled(record);
  }
  if ([record.name isEqual:@"start_runtime_service"]) {
    // Lifecycle worker retains and releases the lease after its VM actually ends.
    return [self performServiceStart:record snapshot:snapshot lease:lease];
  }
  NSNumber *exitCode = nil;
  @try {
    DSHRuntimeProgramVM *vm = self.programFactory();
    @synchronized (record) { record.vm = vm; if (record.cancelled) [vm cancel]; record.effectStarted = !record.cancelled; }
    if (!record.cancelled) exitCode = [vm executeLease:lease snapshot:snapshot entryPath:arguments[@"entry_path"]
        args:arguments[@"args"] started:^{} output:^(NSString *channel, NSData *bytes) {
      [self captureOutput:bytes channel:channel record:record];
    } error:&error];
  } @finally {
    [self.store releaseLease:lease]; @synchronized (record) { record.vm = nil; }
  }
  if (record.cancelled || ![self recordCurrent:record execution:YES]) return Cancelled(record);
  if (exitCode == nil || exitCode.integerValue != 0) return DSHAgentRuntimeFailure(record, @"E_AGENT_TOOL_FAILED",
      exitCode ? @"program_exited_nonzero" : ([error.userInfo[@"code"] isEqual:@"E_PROGRAM_TIMEOUT"] ? @"program_timed_out" : @"program_execution_failed"), exitCode);
  NSMutableDictionary *payload = [DSHAgentRuntimeOutput(record) mutableCopy];
  [payload addEntriesFromDictionary:@{@"schema_version":@1, @"environment_id":arguments[@"environment_id"], @"exit_code":@0}];
  return DSHAgentRuntimeEffect(record.name, @"ok", payload, record.precondition, record.effectStarted);
}
@end
