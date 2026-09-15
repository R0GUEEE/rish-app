#import "DSHAgentRuntimeToolInternals.h"

@implementation DSHAgentRuntimeRecord
@end

NSString *DSHAgentRuntimeKey(NSDictionary *owner) {
  NSMutableDictionary *key = [NSMutableDictionary dictionary];
  for (NSString *field in @[@"task_id", @"attempt_id", @"round_id", @"round_index", @"call_index", @"call_id", @"idempotency_key"])
    key[field] = owner[field] ?: NSNull.null;
  return DSHAgentHJ(@"runtime-native-call", key, nil);
}

NSString *DSHAgentRuntimeSnapshotSHA(DSHRuntimeWorkspaceSnapshot *snapshot) {
  NSMutableArray *entries = [NSMutableArray array];
  for (NSDictionary *entry in snapshot.entries) {
    BOOL directory = [entry[@"directory"] boolValue];
    NSString *digest = directory ? nil : DSHAgentHB(@"file-content", entry[@"data"], nil);
    if (!directory && !digest) return nil;
    [entries addObject:@{@"path":entry[@"path"], @"mode":entry[@"mode"], @"directory":@(directory),
        @"data_sha256":digest ?: NSNull.null}];
  }
  return DSHAgentHJ(@"runtime-workspace-snapshot", @{@"schema_version":@1, @"entries":entries}, nil);
}

static NSString *OutputText(NSData *data, NSUInteger limit, BOOL *truncated) {
  NSString *text = [[NSString alloc] initWithData:data ?: NSData.data encoding:NSUTF8StringEncoding];
  if (!text) text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding] ?: @"";
  NSData *encoded = [text dataUsingEncoding:NSUTF8StringEncoding];
  if (encoded.length <= limit) return text;
  *truncated = YES;
  for (NSUInteger length = limit; length > 0; length--) {
    NSString *prefix = [[NSString alloc] initWithBytes:encoded.bytes length:length encoding:NSUTF8StringEncoding];
    if (prefix) return prefix;
  }
  return @"";
}

NSDictionary *DSHAgentRuntimeEffect(NSString *name, NSString *outcome, NSDictionary *payload,
    NSDictionary *precondition, BOOL mayHaveOccurred) {
  NSMutableDictionary *bounded = [payload mutableCopy];
  NSString *feedback = nil;
  for (NSUInteger attempt = 0; attempt < 8; attempt++) {
    NSData *json = DSHAgentCanonicalJSON(@{@"schema_version":@1, @"name":name, @"outcome":outcome, @"payload":bounded}, nil);
    if (json.length <= 65536) { feedback = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]; break; }
    if (!bounded[@"stdout"]) break;
    BOOL truncated = YES;
    for (NSString *channel in @[@"stdout", @"stderr"]) {
      NSData *bytes = [bounded[channel] dataUsingEncoding:NSUTF8StringEncoding];
      bounded[channel] = OutputText(bytes, bytes.length / 2, &truncated);
    }
    bounded[@"truncated"] = @YES;
  }
  if (!feedback || !DSHAgentRuntimeContractValid(@"runtime_feedback", feedback)) return nil;
  NSDictionary *facts = nil;
  if ([outcome isEqual:@"ok"]) {
    NSString *digest = DSHAgentHJ(@"runtime-tool-payload", bounded, nil);
    if (!digest) return nil;
    facts = @{@"schema_version":@1, @"kind":name, @"arguments_sha256":precondition[@"arguments_sha256"],
        @"payload_sha256":digest};
    if (!DSHAgentRuntimeContractValid(@"runtime_facts", facts)) return nil;
  }
  return @{@"schema_version":@1, @"status":outcome, @"feedback":feedback,
      @"settled_facts":facts ?: NSNull.null, @"truncated":bounded[@"truncated"] ?: @NO,
      @"effect_may_have_occurred":@(mayHaveOccurred)};
}

NSDictionary *DSHAgentRuntimeFailure(DSHAgentRuntimeRecord *record, NSString *code,
    NSString *reason, NSNumber *exitCode) {
  BOOL cancelled = [code isEqual:@"E_AGENT_CANCELLED"];
  NSMutableDictionary *payload = [@{@"schema_version":@1, @"failure_code":code, @"reason":reason} mutableCopy];
  if (!cancelled && ( [record.name isEqual:@"run_program"] || [record.name isEqual:@"start_runtime_service"])) {
    BOOL truncated = NO;
    @synchronized (record) {
      truncated = record.outputTruncated;
      payload[@"stdout"] = OutputText(record.stdoutData, 16384, &truncated);
      payload[@"stderr"] = OutputText(record.stderrData, 8192, &truncated);
    }
    payload[@"truncated"] = @(truncated);
    payload[@"exit_code"] = exitCode && exitCode.integerValue >= 0 && exitCode.integerValue <= 255 ? exitCode : NSNull.null;
  }
  return DSHAgentRuntimeEffect(record.name, cancelled ? @"cancelled" : @"failed", payload,
      record.precondition, record.effectStarted);
}

NSDictionary *DSHAgentRuntimeOutput(DSHAgentRuntimeRecord *record) {
  @synchronized (record) {
    BOOL truncated = record.outputTruncated;
    NSString *out = OutputText(record.stdoutData, 16384, &truncated);
    NSString *err = OutputText(record.stderrData, 8192, &truncated);
    return @{@"stdout":out, @"stderr":err, @"truncated":@(truncated)};
  }
}

@implementation DSHAgentRuntimeToolExecutor (Feedback)
- (void)captureOutput:(NSData *)bytes channel:(NSString *)channel record:(DSHAgentRuntimeRecord *)record {
  @synchronized (record) {
    NSMutableData *data = [channel isEqual:@"stdout"] ? record.stdoutData : record.stderrData;
    NSUInteger remaining = 262144 - data.length;
    [data appendBytes:bytes.bytes length:MIN(remaining, bytes.length)];
    record.outputTruncated |= bytes.length > remaining;
  }
}
@end
