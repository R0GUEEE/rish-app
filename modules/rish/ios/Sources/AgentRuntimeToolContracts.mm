#import "AgentRuntimeToolContracts.h"
#import "AgentNativeWAL.h"
#include "rish_agent_core.h"

BOOL DSHAgentIsRuntimeTool(id name) {
  return [name isKindOfClass:NSString.class] && [@[@"list_runtime_environments",
      @"install_runtime_environment", @"run_program", @"start_runtime_service",
      @"stop_runtime_service"] containsObject:name];
}

NSDictionary *DSHAgentRuntimeContract(NSString *operation, id value, NSString *name) {
  NSMutableDictionary *request = [@{@"op":operation, @"value":value ?: NSNull.null} mutableCopy];
  if (name) request[@"name"] = name;
  NSData *json = DSHAgentCanonicalJSON(request, nil);
  if (!json) return nil;
  char *raw = rish_agent_wal_state_reduce((const char *)json.bytes, json.length);
  if (!raw) return nil;
  size_t length = strnlen(raw, 1024 * 1024 + 1);
  NSData *data = length <= 1024 * 1024 ? [NSData dataWithBytes:raw length:length] : nil;
  rish_agent_string_free(raw);
  id reply = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [reply isKindOfClass:NSDictionary.class] && [reply[@"ok"] isEqual:@YES] ? reply : nil;
}

BOOL DSHAgentRuntimeContractValid(NSString *operation, id value) {
  return [DSHAgentRuntimeContract(operation, value, nil)[@"valid"] isEqual:@YES];
}

NSArray<NSDictionary *> *DSHAgentRuntimeToolDescriptors(void) {
  // The shared table is the sole descriptor source. This compatibility helper
  // only selects runtime entries; it cannot diverge from registry v3 hashes.
  NSData *request = DSHAgentCanonicalJSON(@{@"op":@"descriptors", @"registry_version":@3}, nil);
  if (!request) return @[];
  char *raw = rish_agent_tool_registry_reduce((const char *)request.bytes, request.length);
  if (!raw) return @[];
  size_t length = strnlen(raw, 1024 * 1024 + 1);
  NSData *data = length <= 1024 * 1024 ? [NSData dataWithBytes:raw length:length] : nil;
  rish_agent_string_free(raw);
  id reply = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![reply isKindOfClass:NSDictionary.class] || ![reply[@"ok"] isEqual:@YES] ||
      ![reply[@"descriptors"] isKindOfClass:NSArray.class]) return @[];
  NSMutableArray *runtime = [NSMutableArray array];
  for (NSDictionary *descriptor in reply[@"descriptors"])
    if (DSHAgentIsRuntimeTool(descriptor[@"name"])) [runtime addObject:descriptor];
  return [runtime copy];
}
