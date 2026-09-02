#import "LegacyBoundProjectRootAccess.h"

#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <math.h>
#include <stdlib.h>

NSErrorDomain const DSHLegacyBoundProjectRootAccessErrorDomain =
    @"dev.dsh.rish.legacy-bound-project-root";

// Native composition over the existing authority core. These selectors do
// not expose authority material; calls are made only while holding the public
// mutation guard.
@interface DSHLocalWorkspaceAccess (DSHLegacyBoundProjectRootPrivate)
- (BOOL)ensurePrivateLayoutLocked:(NSError **)error;
- (nullable NSDictionary *)loadRegistry:(NSError **)error
                                  digest:(NSString *_Nullable *_Nullable)digest;
- (nullable NSDictionary *)recordInRegistry:(NSDictionary *)registry
                                  workspaceId:(NSString *)workspaceId;
- (nullable NSDictionary *)loadAuthorityForRecord:(NSDictionary *)record
                                             error:(NSError **)error;
- (nullable NSSet<NSString *> *)verifiedLegacyCapabilitiesForRecord:
    (NSDictionary *)record authority:(NSDictionary *)authority;
@end

@interface DSHLocalWorkspaceAuthorityMutationGuard
    (DSHLegacyBoundProjectRootPrivate)
@property(nonatomic, readonly) int descriptor;
@property(nonatomic, weak, readonly) DSHLocalWorkspaceAccess *owner;
@end

static const NSUInteger DSHLegacyBoundMaximumSafeInteger =
    9007199254740991ULL;
static const NSTimeInterval DSHLegacyBoundMaximumTimeout = 30.0;

static NSError *DSHLegacyBoundError(
    DSHLegacyBoundProjectRootAccessErrorCode code) {
  return [NSError errorWithDomain:DSHLegacyBoundProjectRootAccessErrorDomain
                             code:code
                         userInfo:nil];
}

static void DSHSetLegacyBoundError(
    NSError **error, DSHLegacyBoundProjectRootAccessErrorCode code) {
  if (error != nullptr) *error = DSHLegacyBoundError(code);
}

static BOOL DSHLegacyBoundExactKeys(NSDictionary *value, NSArray *keys) {
  return [value isKindOfClass:NSDictionary.class] &&
      [NSSet setWithArray:value.allKeys].count == keys.count &&
      [[NSSet setWithArray:value.allKeys] isEqual:[NSSet setWithArray:keys]];
}

static BOOL DSHLegacyBoundCanonicalUUID(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 36 ||
      ![value isEqual:[value lowercaseString]]) return NO;
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:value];
  return uuid != nil &&
      [uuid.UUIDString.lowercaseString isEqual:value];
}

static BOOL DSHLegacyBoundCanonicalDigest(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 64) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHLegacyBoundSafeInteger(id value) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number && number >= 1 &&
      number <= DSHLegacyBoundMaximumSafeInteger;
}

static BOOL DSHLegacyBoundCapabilities(id value, NSSet **capabilitiesOut) {
  if (![value isKindOfClass:NSArray.class] || [value count] > 5) return NO;
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push",
  ]];
  NSMutableSet *seen = [NSMutableSet set];
  for (id capability in value) {
    if (![capability isKindOfClass:NSString.class] ||
        ![allowed containsObject:capability] ||
        [seen containsObject:capability]) return NO;
    [seen addObject:capability];
  }
  if (capabilitiesOut != nullptr) *capabilitiesOut = [seen copy];
  return YES;
}

static BOOL DSHLegacyBoundRootShape(NSDictionary *root,
                                    NSSet **capabilitiesOut) {
  return DSHLegacyBoundExactKeys(root, @[
    @"schema_version", @"kind", @"workspace_id",
    @"workspace_binding_revision", @"project_id",
    @"root_fingerprint_sha256", @"capabilities",
  ]) && [root[@"schema_version"] isEqual:@1] &&
      [root[@"kind"] isEqual:@"project"] &&
      DSHLegacyBoundCanonicalUUID(root[@"workspace_id"]) &&
      DSHLegacyBoundCanonicalUUID(root[@"project_id"]) &&
      DSHLegacyBoundSafeInteger(root[@"workspace_binding_revision"]) &&
      DSHLegacyBoundCanonicalDigest(root[@"root_fingerprint_sha256"]) &&
      DSHLegacyBoundCapabilities(root[@"capabilities"], capabilitiesOut);
}

static BOOL DSHLegacyBoundMode(
    DSHLegacyBoundProjectRootOperationMode mode,
    NSSet *rootCapabilities,
    NSString **authorityCapabilityOut,
    DSHLocalProjectAccessMode *projectModeOut) {
  NSString *rootCapability = nil;
  NSString *authorityCapability = nil;
  DSHLocalProjectAccessMode projectMode = DSHLocalProjectAccessModeRead;
  switch (mode) {
    case DSHLegacyBoundProjectRootOperationModeRead:
      rootCapability = @"file_read";
      authorityCapability = @"read";
      break;
    case DSHLegacyBoundProjectRootOperationModeWrite:
      rootCapability = @"file_write";
      authorityCapability = @"write";
      projectMode = DSHLocalProjectAccessModeWrite;
      break;
    case DSHLegacyBoundProjectRootOperationModeGitRead:
      rootCapability = @"git_status";
      authorityCapability = @"git";
      break;
    case DSHLegacyBoundProjectRootOperationModeGitWrite:
      rootCapability = @"git_commit";
      authorityCapability = @"git";
      projectMode = DSHLocalProjectAccessModeWrite;
      break;
    case DSHLegacyBoundProjectRootOperationModeProjectContext:
      rootCapability = @"file_read";
      authorityCapability = @"project_context";
      break;
    default:
      return NO;
  }
  if (![rootCapabilities containsObject:rootCapability]) return NO;
  if (authorityCapabilityOut != nullptr) {
    *authorityCapabilityOut = authorityCapability;
  }
  if (projectModeOut != nullptr) *projectModeOut = projectMode;
  return YES;
}

static BOOL DSHLegacyBoundIdentityValue(id value,
                                        unsigned long long actual) {
  if (![value isKindOfClass:NSString.class] || [value length] == 0) return NO;
  const char *bytes = [value UTF8String];
  char *end = nullptr;
  errno = 0;
  unsigned long long expected = strtoull(bytes, &end, 10);
  return errno == 0 && end != bytes && *end == '\0' && expected == actual;
}

static BOOL DSHLegacyBoundLeaseMatchesAuthority(
    DSHLocalProjectLease *lease, NSDictionary *authority) {
  return DSHLegacyBoundIdentityValue(authority[@"projects_root_device_id"],
                                      (unsigned long long)lease.projectsRootDevice) &&
      DSHLegacyBoundIdentityValue(authority[@"projects_root_inode_id"],
                                  (unsigned long long)lease.projectsRootInode) &&
      DSHLegacyBoundIdentityValue(authority[@"repository_device_id"],
                                  (unsigned long long)lease.repositoryDevice) &&
      DSHLegacyBoundIdentityValue(authority[@"repository_inode_id"],
                                  (unsigned long long)lease.repositoryInode) &&
      DSHLegacyBoundIdentityValue(authority[@"git_device_id"],
                                  (unsigned long long)lease.gitDevice) &&
      DSHLegacyBoundIdentityValue(authority[@"git_inode_id"],
                                  (unsigned long long)lease.gitInode);
}

@interface DSHLegacyBoundProjectRootAccess ()
@property(nonatomic, strong) DSHLocalWorkspaceAccess *workspaceAccess;
@property(nonatomic, strong) DSHLocalProjectAccess *projectAccess;
@end

@interface DSHLegacyBoundProjectRootProof : NSObject
@property(nonatomic, strong) DSHLocalProjectLease *lease;
@end

@implementation DSHLegacyBoundProjectRootProof
@end

@implementation DSHLegacyBoundProjectRootAccess

- (instancetype)initWithWorkspaceAccess:(DSHLocalWorkspaceAccess *)workspaceAccess
                           projectAccess:(DSHLocalProjectAccess *)projectAccess {
  self = [super init];
  if (self != nil) {
    _workspaceAccess = workspaceAccess;
    _projectAccess = projectAccess;
  }
  return self;
}

- (nullable NSDictionary *)legacyAuthorityForBoundRoot:(NSDictionary *)root
                                  requiredCapability:(NSString *)capability
                                               guard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
                                         disposition:(DSHLegacyBoundProjectRootDisposition *)disposition
                                               error:(NSError **)error {
  if (guard == nil || guard.owner != self.workspaceAccess ||
      guard.descriptor < 0 ||
      ![self.workspaceAccess ensurePrivateLayoutLocked:error]) {
    if (error != nullptr && *error == nil) {
      DSHSetLegacyBoundError(error,
                             DSHLegacyBoundProjectRootAccessErrorUnavailable);
    }
    return nil;
  }
  NSDictionary *registry = [self.workspaceAccess loadRegistry:error digest:nil];
  NSDictionary *record = registry == nil ? nil :
      [self.workspaceAccess recordInRegistry:registry
                                  workspaceId:root[@"workspace_id"]];
  if (record == nil) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorConflict);
    return nil;
  }
  if (![record[@"binding_revision"]
          isEqual:root[@"workspace_binding_revision"]]) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorRootChanged);
    return nil;
  }
  NSString *locator = record[@"root_locator_kind"];
  NSString *origin = record[@"origin"];
  if ([locator isEqual:@"documents_owned"] &&
      ([origin isEqual:@"rish_created"] || [origin isEqual:@"imported"])) {
    if (disposition != nullptr) {
      *disposition = DSHLegacyBoundProjectRootDispositionNotHandled;
    }
    return nil;
  }
  if (![locator isEqual:@"legacy_app_owned"] ||
      ![origin isEqual:@"legacy_app_owned"] ||
      ![record[@"legacy_project_id"] isEqual:root[@"project_id"]]) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorConflict);
    return nil;
  }
  NSDictionary *authority =
      [self.workspaceAccess loadAuthorityForRecord:record error:error];
  if (authority == nil) return nil;
  if (![authority[@"legacy_project_id"] isEqual:root[@"project_id"]]) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorConflict);
    return nil;
  }
  if (![authority[@"root_fingerprint_sha256"]
          isEqual:root[@"root_fingerprint_sha256"]]) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorRootChanged);
    return nil;
  }
  NSSet *available = [self.workspaceAccess
      verifiedLegacyCapabilitiesForRecord:record authority:authority];
  if (available == nil) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorRootChanged);
    return nil;
  }
  if (![available containsObject:capability]) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorConflict);
    return nil;
  }
  return authority;
}

- (DSHLegacyBoundProjectRootDisposition)
    performRepositoryRootOperationForBoundRoot:(NSDictionary *)boundRoot
                                           mode:(DSHLegacyBoundProjectRootOperationMode)mode
                                        timeout:(NSTimeInterval)timeout
                                          block:(DSHLegacyBoundProjectRootOperation)block
                                          error:(NSError **)error {
  if (block == nil) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorInvalid);
    return DSHLegacyBoundProjectRootDispositionFailed;
  }
  return [self performProjectHandleOperationForBoundRoot:boundRoot
      mode:mode timeout:timeout
      block:^BOOL(int descriptor, __unused git_repository *repository,
                  NSError **blockError) {
        return block(descriptor, blockError);
      } error:error];
}

- (DSHLegacyBoundProjectRootDisposition)
    validateBoundRoot:(NSDictionary *)boundRoot
                 mode:(DSHLegacyBoundProjectRootOperationMode)mode
              timeout:(NSTimeInterval)timeout
    authorityMutationGuard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
                error:(NSError **)error {
  DSHLegacyBoundProjectRootDisposition disposition =
      DSHLegacyBoundProjectRootDispositionFailed;
  DSHLegacyBoundProjectRootProof *proof = [self acquireProofForBoundRoot:boundRoot
      mode:mode timeout:timeout authorityMutationGuard:guard
      disposition:&disposition error:error];
  return proof == nil ? disposition : DSHLegacyBoundProjectRootDispositionHandled;
}

- (DSHLegacyBoundProjectRootProof *)
    acquireProofForBoundRoot:(NSDictionary *)boundRoot
                        mode:(DSHLegacyBoundProjectRootOperationMode)mode
                     timeout:(NSTimeInterval)timeout
      authorityMutationGuard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
                 disposition:(DSHLegacyBoundProjectRootDisposition *)dispositionOut
                       error:(NSError **)error {
  NSSet *rootCapabilities = nil;
  NSString *authorityCapability = nil;
  DSHLocalProjectAccessMode projectMode = DSHLocalProjectAccessModeRead;
  if (!DSHLegacyBoundRootShape(boundRoot, &rootCapabilities) || guard == nil ||
      !isfinite(timeout) || timeout < 0 ||
      timeout > DSHLegacyBoundMaximumTimeout ||
      !DSHLegacyBoundMode(mode, rootCapabilities, &authorityCapability,
                          &projectMode)) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorInvalid);
    if (dispositionOut != nullptr) {
      *dispositionOut = DSHLegacyBoundProjectRootDispositionFailed;
    }
    return nil;
  }
  DSHLegacyBoundProjectRootDisposition disposition =
      DSHLegacyBoundProjectRootDispositionFailed;
  NSError *proofError = nil;
  NSDictionary *authority = [self legacyAuthorityForBoundRoot:boundRoot
      requiredCapability:authorityCapability guard:guard
      disposition:&disposition error:&proofError];
  if (authority == nil) {
    if (disposition == DSHLegacyBoundProjectRootDispositionNotHandled) {
      if (dispositionOut != nullptr) *dispositionOut = disposition;
      if (error != nullptr) *error = nil;
      return nil;
    }
    if (error != nullptr) *error = proofError ?: DSHLegacyBoundError(
        DSHLegacyBoundProjectRootAccessErrorConflict);
    if (dispositionOut != nullptr) *dispositionOut = disposition;
    return nil;
  }
  DSHLocalProjectLease *lease = [self.projectAccess
      leaseProjectId:boundRoot[@"project_id"] mode:projectMode
      includeMetadata:NO timeout:timeout error:&proofError];
  if (lease == nil ||
      ![self.projectAccess validateLeaseIdentity:lease error:&proofError] ||
      !DSHLegacyBoundLeaseMatchesAuthority(lease, authority)) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorRootChanged);
    if (dispositionOut != nullptr) *dispositionOut = disposition;
    return nil;
  }
  DSHLegacyBoundProjectRootProof *proof =
      [[DSHLegacyBoundProjectRootProof alloc] init];
  proof.lease = lease;
  if (dispositionOut != nullptr) {
    *dispositionOut = DSHLegacyBoundProjectRootDispositionHandled;
  }
  if (error != nullptr) *error = nil;
  return proof;
}

- (DSHLegacyBoundProjectRootDisposition)
    performProjectHandleOperationForBoundRoot:(NSDictionary *)boundRoot
                                          mode:(DSHLegacyBoundProjectRootOperationMode)mode
                                       timeout:(NSTimeInterval)timeout
                                         block:(DSHLegacyBoundProjectHandleOperation)block
                                         error:(NSError **)error {
  NSSet *rootCapabilities = nil;
  NSString *authorityCapability = nil;
  DSHLocalProjectAccessMode projectMode = DSHLocalProjectAccessModeRead;
  if (!DSHLegacyBoundRootShape(boundRoot, &rootCapabilities) || block == nil ||
      !isfinite(timeout) || timeout < 0 ||
      timeout > DSHLegacyBoundMaximumTimeout ||
      !DSHLegacyBoundMode(mode, rootCapabilities, &authorityCapability,
                          &projectMode)) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorInvalid);
    return DSHLegacyBoundProjectRootDispositionFailed;
  }

  NSError *proofError = nil;
  __attribute__((objc_precise_lifetime))
  DSHLocalWorkspaceAuthorityMutationGuard *guard =
      [self.workspaceAccess acquireAuthorityMutationGuard:&proofError];
  if (guard == nil) {
    if (error != nullptr) *error = proofError ?: DSHLegacyBoundError(
        DSHLegacyBoundProjectRootAccessErrorUnavailable);
    return DSHLegacyBoundProjectRootDispositionFailed;
  }
  DSHLegacyBoundProjectRootDisposition disposition =
      DSHLegacyBoundProjectRootDispositionFailed;
  NSDictionary *authority = [self legacyAuthorityForBoundRoot:boundRoot
                                           requiredCapability:authorityCapability
                                                        guard:guard
                                                  disposition:&disposition
                                                        error:&proofError];
  if (authority == nil) {
    if (disposition == DSHLegacyBoundProjectRootDispositionNotHandled) {
      if (error != nullptr) *error = nil;
      return disposition;
    }
    if (error != nullptr) *error = proofError ?: DSHLegacyBoundError(
        DSHLegacyBoundProjectRootAccessErrorConflict);
    return DSHLegacyBoundProjectRootDispositionFailed;
  }

  DSHLocalProjectLease *lease = [self.projectAccess
      leaseProjectId:boundRoot[@"project_id"]
                mode:projectMode
     includeMetadata:NO
             timeout:timeout
               error:&proofError];
  if (lease == nil ||
      ![self.projectAccess validateLeaseIdentity:lease error:&proofError] ||
      !DSHLegacyBoundLeaseMatchesAuthority(lease, authority)) {
    DSHSetLegacyBoundError(&proofError,
                           DSHLegacyBoundProjectRootAccessErrorRootChanged);
    if (error != nullptr) *error = proofError;
    return DSHLegacyBoundProjectRootDispositionFailed;
  }

  NSError *blockError = nil;
  BOOL blockSucceeded = block(lease.repositoryDescriptor, lease.repository,
                              &blockError);
  BOOL projectStillValid =
      [self.projectAccess validateLeaseIdentity:lease error:nil] &&
      DSHLegacyBoundLeaseMatchesAuthority(lease, authority);
  // Release the per-project lease before the resolver-based workspace proof;
  // the resolver acquires its own project read lease.
  lease = nil;

  NSError *postProofError = nil;
  NSDictionary *postAuthority = [self legacyAuthorityForBoundRoot:boundRoot
                                                requiredCapability:authorityCapability
                                                             guard:guard
                                                       disposition:&disposition
                                                             error:&postProofError];
  if (!projectStillValid || postAuthority == nil ||
      ![postAuthority isEqual:authority]) {
    DSHSetLegacyBoundError(error,
                           DSHLegacyBoundProjectRootAccessErrorRootChanged);
    return DSHLegacyBoundProjectRootDispositionFailed;
  }
  if (!blockSucceeded) {
    if (error != nullptr) *error = blockError ?: DSHLegacyBoundError(
        DSHLegacyBoundProjectRootAccessErrorUnavailable);
    return DSHLegacyBoundProjectRootDispositionFailed;
  }
  if (error != nullptr) *error = nil;
  return DSHLegacyBoundProjectRootDispositionHandled;
}

@end
