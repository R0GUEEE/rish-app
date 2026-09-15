#import "AgentNativeWAL.h"

NS_INLINE BOOL DSHAgentWriteParentPlan(id value) {
  if (!DSHAgentExactDictionaryKeys(value, @[
      @"schema_version", @"ancestor_depth", @"ancestor_identity_sha256",
      @"missing_parent_path_sha256"])) return NO;
  NSDictionary *plan = value;
  id paths = plan[@"missing_parent_path_sha256"];
  if (!DSHAgentSafeInteger(plan[@"schema_version"], 1, NO) ||
      !DSHAgentSafeInteger(plan[@"ancestor_depth"], 255, YES) ||
      !DSHAgentCanonicalSHA256(plan[@"ancestor_identity_sha256"]) ||
      ![paths isKindOfClass:NSArray.class] || [paths count] < 1 || [paths count] > 32 ||
      [plan[@"ancestor_depth"] unsignedIntegerValue] + [paths count] > 255) return NO;
  NSMutableSet *seen = [NSMutableSet set];
  for (id path in paths) {
    if (!DSHAgentCanonicalSHA256(path) || [seen containsObject:path]) return NO;
    [seen addObject:path];
  }
  return YES;
}

NS_INLINE BOOL DSHAgentWriteFilePrecondition(NSDictionary *condition, BOOL validPrior) {
  NSMutableArray *keys = [@[@"schema_version", @"kind", @"relative_path_sha256",
      @"prior", @"content_sha256", @"content_bytes"] mutableCopy];
  BOOL schema3 = [condition[@"schema_version"] isEqual:@3];
  if (schema3) [keys addObject:@"parent_plan"];
  return DSHAgentExactDictionaryKeys(condition, keys) && validPrior &&
      ([condition[@"schema_version"] isEqual:@2] ||
       (schema3 && DSHAgentWriteParentPlan(condition[@"parent_plan"]) &&
        [condition[@"prior"][@"kind"] isEqual:@"absent"])) &&
      DSHAgentCanonicalSHA256(condition[@"relative_path_sha256"]) &&
      DSHAgentCanonicalSHA256(condition[@"content_sha256"]) &&
      DSHAgentSafeInteger(condition[@"content_bytes"],
          DSHAgentNativeWALMaxSingleWriteBytes, YES);
}
