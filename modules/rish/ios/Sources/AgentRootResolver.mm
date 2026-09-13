#import "RishGuestCgiFeature.h"
#import "AgentRootResolver.h"

#import "AgentNativeWAL.h"

#include <CoreFoundation/CoreFoundation.h>
#include <math.h>

// These selectors are intentionally private adapters over the existing
// workspace authority implementation.  They are used only while holding the
// public authority mutation guard; no private authority object is returned by
// this class and none of the selectors are bridge-visible.
@interface DSHLocalWorkspaceAccess (DSHAgentRootResolverPrivate)
- (BOOL)ensurePrivateLayoutLocked:(NSError **)error;
- (nullable NSDictionary *)loadRegistry:(NSError **)error
                                  digest:(NSString *_Nullable *_Nullable)digest;
- (nullable NSDictionary *)recordInRegistry:(NSDictionary *)registry
                                  workspaceId:(NSString *)workspaceId;
- (nullable NSDictionary *)loadAuthorityForRecord:(NSDictionary *)record
                                             error:(NSError **)error;
- (NSString *)metadataStatusForRecord:(NSDictionary *)record
                              authority:(NSDictionary *)authority;
- (NSSet<NSString *> *)operationalCapabilitiesForMetadataRecord:
    (NSDictionary *)record
    authority:(NSDictionary *)authority
    status:(NSString *)status;
@end

@interface DSHLocalWorkspaceLease (DSHAgentRootResolverPrivate)
/// `authorityGuard` is a private immutable snapshot owned by the existing
/// lease.  It is read only to obtain the already-verified root fingerprint.
@property(nonatomic, copy, readonly) NSDictionary *authorityGuard;
@end

@interface DSHLocalWorkspaceAuthorityMutationGuard (DSHAgentRootResolverPrivate)
@property(nonatomic, readonly) int descriptor;
@property(nonatomic, weak, readonly) DSHLocalWorkspaceAccess *owner;
@end

@interface DSHLocalProjectAccess (DSHAgentRootResolverPrivate)
- (nullable NSDictionary *)workspaceBindingForRootRef:(NSDictionary *)rootRef
                                  rootFingerprintSHA256:(NSString *)rootFingerprint
                                                 error:(NSError **)error;
@end

static const NSUInteger DSHAgentMaximumSafeInteger = 9007199254740991ULL;

static NSError *DSHAgentRootError(DSHAgentNativeStoreErrorCode code) {
  return DSHAgentNativeStoreError(code);
}

static void DSHSetRootError(NSError **error,
                            DSHAgentNativeStoreErrorCode code) {
  if (error != nullptr) *error = DSHAgentRootError(code);
}

static BOOL DSHAgentRootCapabilityArray(id value,
                                        BOOL project,
                                        NSSet<NSString *> **setOut) {
  if (![value isKindOfClass:NSArray.class] || [value count] > 6) return NO;
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push", @"guest_service",
  ]];
  NSMutableSet *seen = [NSMutableSet set];
  for (id item in (NSArray *)value) {
    if (![item isKindOfClass:NSString.class] || ![allowed containsObject:item] ||
        [seen containsObject:item] || (!project && [item hasPrefix:@"git_"])) {
      return NO;
    }
    [seen addObject:item];
  }
  if (setOut != nullptr) *setOut = [seen copy];
  return YES;
}

static BOOL DSHAgentRootProjectionShape(NSDictionary *root,
                                         NSError **error) {
  if (!DSHAgentIsImmutableFoundationJSON(root) ||
      !DSHAgentExactDictionaryKeys(root, @[
        @"schema_version", @"kind", @"workspace_id",
        @"workspace_binding_revision", @"project_id",
        @"root_fingerprint_sha256", @"capabilities",
      ]) ||
      !DSHAgentSafeInteger(root[@"schema_version"], 1, NO) ||
      ![root[@"schema_version"] isEqual:@1] ||
      !DSHAgentCanonicalUUID(root[@"workspace_id"]) ||
      !DSHAgentSafeInteger(root[@"workspace_binding_revision"],
                           DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"])) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSString *kind = root[@"kind"];
  if (![kind isKindOfClass:NSString.class] ||
      (![kind isEqualToString:@"project"] &&
       ![kind isEqualToString:@"workspace"])) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  id projectId = root[@"project_id"];
  BOOL project = [kind isEqualToString:@"project"];
  if ((project && !DSHAgentCanonicalUUID(projectId)) ||
      (!project && projectId != NSNull.null) ||
      (project && projectId == NSNull.null) ||
      !DSHAgentRootCapabilityArray(root[@"capabilities"], project, nullptr)) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  return YES;
}

static DSHAgentNativeStoreErrorCode DSHAgentMapWorkspaceError(NSError *error) {
  if (error == nil) return DSHAgentNativeStoreErrorUnavailable;
  switch ((DSHLocalWorkspaceAccessErrorCode)error.code) {
    case DSHLocalWorkspaceAccessErrorRevisionStale:
    case DSHLocalWorkspaceAccessErrorRootChanged:
    case DSHLocalWorkspaceAccessErrorStatusStale:
    case DSHLocalWorkspaceAccessErrorRevoked:
    case DSHLocalWorkspaceAccessErrorNotDownloaded:
      return DSHAgentNativeStoreErrorOwnerLost;
    case DSHLocalWorkspaceAccessErrorNotFound:
      return DSHAgentNativeStoreErrorNotFound;
    case DSHLocalWorkspaceAccessErrorInvalid:
      return DSHAgentNativeStoreErrorInvalidArgument;
    default:
      return DSHAgentNativeStoreErrorUnavailable;
  }
}

static DSHAgentNativeStoreErrorCode DSHAgentMapProjectError(NSError *error) {
  if (error == nil) return DSHAgentNativeStoreErrorUnavailable;
  switch ((DSHLocalProjectAccessErrorCode)error.code) {
    case DSHLocalProjectAccessErrorInvalidIdentifier:
      return DSHAgentNativeStoreErrorInvalidArgument;
    case DSHLocalProjectAccessErrorLockTimeout:
      return DSHAgentNativeStoreErrorUnavailable;
    case DSHLocalProjectAccessErrorRepositoryUnavailable:
    case DSHLocalProjectAccessErrorRootAbsent:
    case DSHLocalProjectAccessErrorStorageUnavailable:
    case DSHLocalProjectAccessErrorUnsafeStorage:
    case DSHLocalProjectAccessErrorMetadataInvalid:
    default:
      return DSHAgentNativeStoreErrorOwnerLost;
  }
}

static NSArray<NSString *> *DSHAgentCapabilitiesForWorkspace(
    NSSet<NSString *> *available,
    BOOL project) {
  NSMutableArray *capabilities = [NSMutableArray array];
  if ([available containsObject:@"read"]) [capabilities addObject:@"file_read"];
  if ([available containsObject:@"write"]) [capabilities addObject:@"file_write"];
  if (project && [available containsObject:@"git"]) {
    [capabilities addObjectsFromArray:@[
      @"git_status", @"git_commit", @"git_push",
    ]];
  }
#if DSH_GUEST_CGI_AVAILABLE
  if ([available containsObject:@"read"] && [available containsObject:@"write"]) [capabilities addObject:@"guest_service"];
#endif
  return [capabilities copy];
}

@interface DSHAgentRootResolver ()
@property(nonatomic, strong, readwrite) DSHLocalWorkspaceAccess *workspaceAccess;
@property(nonatomic, strong, readwrite, nullable) DSHLocalProjectAccess *projectAccess;
@property(nonatomic, strong, readwrite, nullable)
    DSHLegacyBoundProjectRootAccess *legacyBoundProjectAccess;
- (nullable NSDictionary *)workspaceAuthorityRootForWorkspaceId:
    (NSString *)workspaceId
    bindingRevision:(NSNumber *)bindingRevision
    authorityMutationGuard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
    error:(NSError **)error;
@end

@interface DSHAgentRootFinalProof : NSObject
@property(nonatomic, strong) DSHLocalWorkspaceLease *workspaceLease;
@property(nonatomic, strong) DSHLocalProjectLease *projectLease;
@property(nonatomic, strong)
    DSHLocalWorkspaceAuthorityMutationGuard *authorityGuard;
@property(nonatomic, strong)
    DSHLegacyBoundProjectRootProof *legacyProof;
@end

@implementation DSHAgentRootFinalProof
@end

@implementation DSHAgentRootResolver

- (instancetype)initWithWorkspaceAccess:(DSHLocalWorkspaceAccess *)workspaceAccess
                           projectAccess:(DSHLocalProjectAccess *)projectAccess {
  self = [super init];
  if (self != nil) {
    _workspaceAccess = workspaceAccess;
    _projectAccess = projectAccess;
    if (workspaceAccess != nil && projectAccess != nil &&
        (id)workspaceAccess != NSNull.null && (id)projectAccess != NSNull.null) {
      _legacyBoundProjectAccess = [[DSHLegacyBoundProjectRootAccess alloc]
          initWithWorkspaceAccess:workspaceAccess projectAccess:projectAccess];
    }
  }
  return self;
}

+ (BOOL)validateAgentRootProjection:(NSDictionary *)root error:(NSError **)error {
  return DSHAgentRootProjectionShape(root, error);
}

- (nullable NSDictionary *)workspaceAuthorityRootForWorkspaceId:
    (NSString *)workspaceId
    bindingRevision:(NSNumber *)bindingRevision
    error:(NSError **)error {
  NSError *workspaceError = nil;
  DSHLocalWorkspaceAuthorityMutationGuard *guard =
      [self.workspaceAccess acquireAuthorityMutationGuard:&workspaceError];
  NSDictionary *root = guard == nil ? nil :
      [self workspaceAuthorityRootForWorkspaceId:workspaceId
                                bindingRevision:bindingRevision
                         authorityMutationGuard:guard
                                           error:&workspaceError];
  if (root == nil) {
    if (error != nullptr) {
      *error = workspaceError ?: DSHAgentRootError(
          DSHAgentMapWorkspaceError(workspaceError));
    }
    return nil;
  }
  return root;
}

- (nullable NSDictionary *)workspaceAuthorityRootForWorkspaceId:
    (NSString *)workspaceId
    bindingRevision:(NSNumber *)bindingRevision
    authorityMutationGuard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
    error:(NSError **)error {
  if (guard == nil || guard.owner != self.workspaceAccess || guard.descriptor < 0) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *workspaceError = nil;
  if (![self.workspaceAccess ensurePrivateLayoutLocked:&workspaceError]) {
    if (error != nullptr) *error = workspaceError ?: DSHAgentRootError(
        DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  NSDictionary *registry = [self.workspaceAccess loadRegistry:&workspaceError
                                                         digest:nil];
  NSDictionary *record = registry == nil ? nil :
      [self.workspaceAccess recordInRegistry:registry workspaceId:workspaceId];
  if (record == nil) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorNotFound);
    return nil;
  }
  if (![record[@"binding_revision"] isEqual:bindingRevision]) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  NSDictionary *authority = [self.workspaceAccess
      loadAuthorityForRecord:record error:&workspaceError];
  if (authority == nil) {
    if (error != nullptr) {
      *error = workspaceError ?: DSHAgentRootError(
          DSHAgentNativeStoreErrorUnavailable);
    }
    return nil;
  }
  NSString *status = [self.workspaceAccess metadataStatusForRecord:record
                                                              authority:authority];
  if (![status isEqualToString:@"ok"]) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  NSString *fingerprint = authority[@"root_fingerprint_sha256"];
  if (!DSHAgentCanonicalSHA256(fingerprint)) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSSet *available = [self.workspaceAccess
      operationalCapabilitiesForMetadataRecord:record
                                     authority:authority
                                        status:status];
  // LocalWorkspaceAccess stores a workspace binding without a project_id.
  // Project identity is supplied only by the independently verified
  // LocalProjectAccess lease below; never infer it from a missing dictionary
  // value here.
  NSArray *capabilities = DSHAgentCapabilitiesForWorkspace(available, NO);
  return @{
    @"schema_version" : @1,
    @"kind" : @"workspace",
    @"workspace_id" : workspaceId,
    @"workspace_binding_revision" : bindingRevision,
    @"project_id" : NSNull.null,
    @"root_fingerprint_sha256" : fingerprint,
    @"capabilities" : capabilities,
  };
}

- (nullable NSDictionary *)resolveRootForWorkspaceId:(NSString *)workspaceId
                                           projectId:(NSString *)projectId
                                     bindingRevision:(NSNumber *)bindingRevision
                                               error:(NSError **)error {
  BOOL noRoot = workspaceId == nil && projectId == nil && bindingRevision == nil;
  if (noRoot) {
    if (error != nullptr) *error = nil;
    return nil;
  }
  if (![workspaceId isKindOfClass:NSString.class] ||
      !DSHAgentCanonicalUUID(workspaceId) ||
      ![bindingRevision isKindOfClass:NSNumber.class] ||
      !DSHAgentSafeInteger(bindingRevision, DSHAgentMaximumSafeInteger, NO) ||
      (projectId != nil && !DSHAgentCanonicalUUID(projectId))) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }

  NSDictionary *workspaceRoot = [self workspaceAuthorityRootForWorkspaceId:
      workspaceId bindingRevision:bindingRevision error:error];
  if (workspaceRoot == nil) return nil;
  BOOL project = projectId != nil;
  id authorityProject = workspaceRoot[@"project_id"];
  if (!project && authorityProject != NSNull.null) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  if (!project) return workspaceRoot;

  // Legacy app-owned projects cannot produce a split-git workspace lease.
  // Build only the fixed safe projection, then ask the adapter to prove it
  // against both current workspace evidence and the legacy project lease.
  NSMutableDictionary *legacyCandidate = [workspaceRoot mutableCopy];
  legacyCandidate[@"kind"] = @"project";
  legacyCandidate[@"project_id"] = projectId;
  NSMutableArray *legacyCapabilities =
      [legacyCandidate[@"capabilities"] mutableCopy];
  [legacyCapabilities addObjectsFromArray:@[
    @"git_status", @"git_commit", @"git_push",
  ]];
  legacyCandidate[@"capabilities"] = [legacyCapabilities copy];
  if (self.legacyBoundProjectAccess != nil) {
    NSError *legacyError = nil;
    DSHLegacyBoundProjectRootDisposition disposition =
        [self.legacyBoundProjectAccess
            performProjectHandleOperationForBoundRoot:legacyCandidate
            mode:DSHLegacyBoundProjectRootOperationModeGitRead timeout:5.0
            block:^BOOL(__unused int descriptor,
                        __unused git_repository *repository,
                        __unused NSError **blockError) { return YES; }
            error:&legacyError];
    if (disposition == DSHLegacyBoundProjectRootDispositionHandled) {
      if (error != nullptr) *error = nil;
      return [legacyCandidate copy];
    }
    if (disposition == DSHLegacyBoundProjectRootDispositionFailed) {
      DSHSetRootError(error,
          legacyError.code == DSHLegacyBoundProjectRootAccessErrorInvalid
              ? DSHAgentNativeStoreErrorInvalidArgument
              : DSHAgentNativeStoreErrorOwnerLost);
      return nil;
    }
  }

  // A project root must be verified through the native project binding.  The
  // project lease also supplies the authoritative fingerprint from the same
  // workspace authority and rejects legacy/path-only fallbacks.
  if (self.projectAccess == nil) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  NSDictionary *rootRef = @{
    @"schema_version" : @1,
    @"workspace_id" : workspaceId,
    @"binding_revision" : bindingRevision,
    @"project_id" : projectId,
  };
  NSError *workspaceLeaseError = nil;
  DSHLocalWorkspaceLease *workspaceLease = [self.workspaceAccess
      leaseWorkspaceId:workspaceId
      expectedBindingRevision:bindingRevision.unsignedIntegerValue
      requiredCapabilities:[NSSet setWithObject:@"git"]
      error:&workspaceLeaseError];
  if (workspaceLease == nil) {
    if (error != nullptr) {
      *error = DSHAgentRootError(DSHAgentMapWorkspaceError(workspaceLeaseError));
    }
    return nil;
  }
  NSError *projectError = nil;
  DSHLocalProjectLease *projectLease = [self.projectAccess
      leaseWorkspaceRootRef:rootRef
               workspaceLease:workspaceLease
                        mode:DSHLocalProjectAccessModeRead
             includeMetadata:NO
                       timeout:5.0
                         error:&projectError];
  if (projectLease == nil ||
      !DSHAgentCanonicalSHA256(projectLease.rootFingerprintSHA256) ||
      ![projectLease.rootFingerprintSHA256
          isEqual:workspaceRoot[@"root_fingerprint_sha256"]]) {
    if (error != nullptr) {
      *error = DSHAgentRootError(projectLease == nil
          ? DSHAgentMapProjectError(projectError)
          : DSHAgentNativeStoreErrorOwnerLost);
    }
    return nil;
  }
  NSMutableDictionary *result = [workspaceRoot mutableCopy];
  result[@"kind"] = @"project";
  result[@"project_id"] = projectId;
  result[@"root_fingerprint_sha256"] = projectLease.rootFingerprintSHA256;
  NSMutableArray *projectCapabilities = [result[@"capabilities"] mutableCopy];
  if (![projectCapabilities containsObject:@"git_status"]) {
    // LocalProjectAccess has already required and verified the native `git`
    // capability.  Expose exactly the three fixed Agent Git capabilities in
    // their canonical order; never expose the generic workspace capability.
    [projectCapabilities addObjectsFromArray:@[
      @"git_status", @"git_commit", @"git_push",
    ]];
  }
  result[@"capabilities"] = [projectCapabilities copy];
  return [result copy];
}

- (BOOL)validateFrozenRoot:(NSDictionary *)root error:(NSError **)error {
  if (!DSHAgentRootProjectionShape(root, error)) return NO;
  NSString *workspaceId = root[@"workspace_id"];
  NSString *projectId = root[@"project_id"] == NSNull.null
      ? nil : root[@"project_id"];
  NSDictionary *current = [self resolveRootForWorkspaceId:workspaceId
                                                projectId:projectId
                                          bindingRevision:root[@"workspace_binding_revision"]
                                                    error:error];
  if (current == nil || ![current isEqual:root]) {
    // Do not overwrite a more specific invalid argument error from the
    // re-resolution path; all other mismatches are root-stale conflicts.
    if (error == nullptr || *error == nil ||
        (*error).code == DSHAgentNativeStoreErrorNotFound ||
        (*error).code == DSHAgentNativeStoreErrorUnavailable ||
        (*error).code == DSHAgentNativeStoreErrorOwnerLost) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
    }
    return NO;
  }
  return YES;
}

- (nullable DSHLocalWorkspaceAuthorityMutationGuard *)
    acquireAuthorityMutationGuardForFrozenRoot:(NSDictionary *)root
                                         error:(NSError **)error {
  if (!DSHAgentRootProjectionShape(root, error)) return nil;
  NSError *workspaceError = nil;
  DSHLocalWorkspaceAuthorityMutationGuard *guard =
      [self.workspaceAccess acquireAuthorityMutationGuard:&workspaceError];
  if (guard == nil) {
    if (error != nullptr) *error = workspaceError ?: DSHAgentRootError(
        DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  if (error != nullptr) *error = nil;
  return guard;
}

- (BOOL)validateFrozenRoot:(NSDictionary *)root
     authorityMutationGuard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
                      error:(NSError **)error {
  if (!DSHAgentRootProjectionShape(root, error)) return NO;
  if (guard == nil || guard.owner != self.workspaceAccess || guard.descriptor < 0) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if ([root[@"kind"] isEqualToString:@"project"] &&
      self.legacyBoundProjectAccess != nil) {
    NSError *legacyError = nil;
    DSHLegacyBoundProjectRootDisposition disposition =
        [self.legacyBoundProjectAccess validateBoundRoot:root
            mode:DSHLegacyBoundProjectRootOperationModeGitRead timeout:5.0
            authorityMutationGuard:guard error:&legacyError];
    if (disposition == DSHLegacyBoundProjectRootDispositionHandled) {
      if (error != nullptr) *error = nil;
      return YES;
    }
    if (disposition == DSHLegacyBoundProjectRootDispositionFailed) {
      DSHSetRootError(error,
          legacyError.code == DSHLegacyBoundProjectRootAccessErrorInvalid
              ? DSHAgentNativeStoreErrorInvalidArgument
              : DSHAgentNativeStoreErrorOwnerLost);
      return NO;
    }
  }
  NSDictionary *base = [self workspaceAuthorityRootForWorkspaceId:
      root[@"workspace_id"]
                 bindingRevision:root[@"workspace_binding_revision"]
          authorityMutationGuard:guard
                            error:error];
  if (base == nil) return NO;
  NSMutableDictionary *expected = [base mutableCopy];
  if ([root[@"kind"] isEqualToString:@"project"]) {
    if (self.projectAccess == nil) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorUnavailable);
      return NO;
    }
    NSDictionary *rootRef = @{
      @"schema_version" : @1,
      @"workspace_id" : root[@"workspace_id"],
      @"binding_revision" : root[@"workspace_binding_revision"],
      @"project_id" : root[@"project_id"],
    };
    NSError *bindingError = nil;
    NSDictionary *binding = [self.projectAccess
        workspaceBindingForRootRef:rootRef
             rootFingerprintSHA256:base[@"root_fingerprint_sha256"]
                            error:&bindingError];
    if (binding == nil) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
      return NO;
    }
    expected[@"kind"] = @"project";
    expected[@"project_id"] = root[@"project_id"];
    NSMutableArray *capabilities = [expected[@"capabilities"] mutableCopy];
    [capabilities addObjectsFromArray:@[
      @"git_status", @"git_commit", @"git_push",
    ]];
    expected[@"capabilities"] = [capabilities copy];
  }
  if (![expected isEqual:root]) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
    return NO;
  }
  if (error != nullptr) *error = nil;
  return YES;
}

- (nullable DSHLocalWorkspaceLease *)workspaceLeaseForFrozenRoot:
    (NSDictionary *)root
    requiredWorkspaceCapabilities:(NSSet<NSString *> *)capabilities
                             error:(NSError **)error {
  if (![self validateFrozenRoot:root error:error] ||
      ![capabilities isKindOfClass:NSSet.class]) {
    if (error != nullptr && *error == nil) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    }
    return nil;
  }
  NSMutableSet *workspaceCapabilities = [NSMutableSet set];
  for (NSString *capability in capabilities) {
    if ([capability isEqualToString:@"file_read"]) {
      [workspaceCapabilities addObject:@"read"];
    } else if ([capability isEqualToString:@"file_write"]) {
      [workspaceCapabilities addObject:@"write"];
    } else if ([capability isEqualToString:@"guest_service"]) {
      [workspaceCapabilities addObject:@"read"];
      [workspaceCapabilities addObject:@"write"];
    } else if ([capability hasPrefix:@"git_"]) {
      [workspaceCapabilities addObject:@"git"];
    } else {
      DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
  }
  NSError *workspaceError = nil;
  DSHLocalWorkspaceLease *lease = [self.workspaceAccess
      leaseWorkspaceId:root[@"workspace_id"]
      expectedBindingRevision:[root[@"workspace_binding_revision"] unsignedIntegerValue]
      requiredCapabilities:workspaceCapabilities
      error:&workspaceError];
  if (lease == nil && error != nullptr) {
    *error = DSHAgentRootError(DSHAgentMapWorkspaceError(workspaceError));
  }
  return lease;
}

- (nullable DSHLocalProjectLease *)projectLeaseForFrozenRoot:(NSDictionary *)root
                                                        mode:(DSHLocalProjectAccessMode)mode
                                                     timeout:(NSTimeInterval)timeout
                                                       error:(NSError **)error {
  if (![self validateFrozenRoot:root error:error] ||
      ![root[@"kind"] isEqualToString:@"project"] ||
      self.projectAccess == nil || !isfinite(timeout) || timeout < 0) {
    if (error != nullptr && *error == nil) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    }
    return nil;
  }
  NSDictionary *rootRef = @{
    @"schema_version" : @1,
    @"workspace_id" : root[@"workspace_id"],
    @"binding_revision" : root[@"workspace_binding_revision"],
    @"project_id" : root[@"project_id"],
  };
  NSError *workspaceError = nil;
  DSHLocalWorkspaceLease *workspaceLease = [self.workspaceAccess
      leaseWorkspaceId:root[@"workspace_id"]
      expectedBindingRevision:[root[@"workspace_binding_revision"] unsignedIntegerValue]
      requiredCapabilities:[NSSet setWithObject:@"git"]
      error:&workspaceError];
  if (workspaceLease == nil) {
    if (error != nullptr) {
      *error = DSHAgentRootError(DSHAgentMapWorkspaceError(workspaceError));
    }
    return nil;
  }
  NSError *projectError = nil;
  DSHLocalProjectLease *lease = [self.projectAccess
      leaseWorkspaceRootRef:rootRef
               workspaceLease:workspaceLease
                        mode:mode
             includeMetadata:NO
                       timeout:timeout
                         error:&projectError];
  if (lease == nil && error != nullptr) {
    *error = DSHAgentRootError(DSHAgentMapProjectError(projectError));
  }
  if (lease != nil &&
      ![lease.rootFingerprintSHA256 isEqual:root[@"root_fingerprint_sha256"]]) {
    if (error != nullptr) *error = DSHAgentRootError(
        DSHAgentNativeStoreErrorOwnerLost);
    return nil;
  }
  return lease;
}

- (BOOL)performOperationForFrozenRoot:(NSDictionary *)root
                                 mode:(DSHAgentRootOperationMode)mode
                              timeout:(NSTimeInterval)timeout
                                block:(DSHAgentRootOperation)block
                                error:(NSError **)error {
  if (!DSHAgentRootProjectionShape(root, error) || block == nil ||
      !isfinite(timeout) || timeout < 0 || timeout > 30.0) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  DSHLegacyBoundProjectRootOperationMode legacyMode;
  NSString *capability = nil;
  switch (mode) {
    case DSHAgentRootOperationModeRead:
      legacyMode = DSHLegacyBoundProjectRootOperationModeRead;
      capability = @"file_read";
      break;
    case DSHAgentRootOperationModeWrite:
      legacyMode = DSHLegacyBoundProjectRootOperationModeWrite;
      capability = @"file_write";
      break;
    case DSHAgentRootOperationModeGitRead:
      legacyMode = DSHLegacyBoundProjectRootOperationModeGitRead;
      capability = @"git_status";
      break;
    case DSHAgentRootOperationModeGitWrite:
      legacyMode = DSHLegacyBoundProjectRootOperationModeGitWrite;
      capability = @"git_commit";
      break;
    case DSHAgentRootOperationModeProjectContext:
      legacyMode = DSHLegacyBoundProjectRootOperationModeProjectContext;
      capability = @"file_read";
      break;
    default:
      DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
  }
  if (![root[@"capabilities"] containsObject:capability]) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }

  if ([root[@"kind"] isEqualToString:@"project"] &&
      self.legacyBoundProjectAccess != nil) {
    NSError *legacyError = nil;
    DSHLegacyBoundProjectRootDisposition disposition =
        [self.legacyBoundProjectAccess
            performProjectHandleOperationForBoundRoot:root mode:legacyMode
            timeout:timeout block:block error:&legacyError];
    if (disposition == DSHLegacyBoundProjectRootDispositionHandled) {
      if (error != nullptr) *error = nil;
      return YES;
    }
    if (disposition == DSHLegacyBoundProjectRootDispositionFailed) {
      // The adapter revalidates root identity after the callback. Its own
      // failures describe the root; an Agent-domain failure belongs to the
      // tool callback (for example a file revision conflict) and must survive.
      if ([legacyError.domain isEqual:DSHAgentNativeStoreErrorDomain]) {
        if (error != nullptr) *error = legacyError;
        return NO;
      }
      DSHSetRootError(error,
          legacyError.code == DSHLegacyBoundProjectRootAccessErrorInvalid
              ? DSHAgentNativeStoreErrorInvalidArgument
              : DSHAgentNativeStoreErrorOwnerLost);
      return NO;
    }
  }

  NSError *operationError = nil;
  BOOL succeeded = NO;
  BOOL physicalStillValid = YES;
  if (mode == DSHAgentRootOperationModeGitRead ||
      mode == DSHAgentRootOperationModeGitWrite) {
    DSHLocalProjectAccessMode accessMode =
        mode == DSHAgentRootOperationModeGitWrite
            ? DSHLocalProjectAccessModeWrite : DSHLocalProjectAccessModeRead;
    __attribute__((objc_precise_lifetime)) DSHLocalProjectLease *lease =
        [self projectLeaseForFrozenRoot:root mode:accessMode timeout:timeout
                                  error:&operationError];
    if (lease == nil) {
      if (error != nullptr) *error = operationError;
      return NO;
    }
    succeeded = block(lease.repositoryDescriptor, lease.repository,
                      &operationError);
    physicalStillValid = [self.projectAccess validateLeaseIdentity:lease
                                                              error:nil];
    lease = nil;
  } else {
    __attribute__((objc_precise_lifetime)) DSHLocalWorkspaceLease *lease =
        [self workspaceLeaseForFrozenRoot:root
            requiredWorkspaceCapabilities:[NSSet setWithObject:capability]
                                   error:&operationError];
    if (lease == nil) {
      if (error != nullptr) *error = operationError;
      return NO;
    }
    succeeded = block(lease.rootDescriptor, nullptr, &operationError);
    lease = nil;
  }
  NSError *postError = nil;
  BOOL authorityStillValid = [self validateFrozenRoot:root error:&postError];
  if (!physicalStillValid || !authorityStillValid) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
    return NO;
  }
  if (!succeeded) {
    if (error != nullptr) *error = operationError ?: DSHAgentRootError(
        DSHAgentNativeStoreErrorUnavailable);
    return NO;
  }
  if (error != nullptr) *error = nil;
  return YES;
}

- (DSHAgentRootFinalProof *)
    acquireFinalProofForFrozenRoot:(NSDictionary *)root
              requiredCapabilities:(NSSet<NSString *> *)capabilities
                 needsProjectLease:(BOOL)needsProjectLease
               projectWriteAccess:(BOOL)projectWriteAccess
                             error:(NSError **)error {
  if (!DSHAgentRootProjectionShape(root, error) ||
      ![capabilities isKindOfClass:NSSet.class]) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  BOOL hasFileWrite = [capabilities containsObject:@"file_write"];
  BOOL hasGitWrite = [capabilities containsObject:@"git_commit"];
  BOOL hasGitRead = [capabilities containsObject:@"git_status"];
  BOOL hasGitPush = [capabilities containsObject:@"git_push"];
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push", @"guest_service",
  ]];
  BOOL anyGit = hasGitRead || hasGitWrite || hasGitPush;
  if (![capabilities isSubsetOfSet:allowed] ||
      needsProjectLease != anyGit ||
      projectWriteAccess != (hasGitWrite || hasGitPush)) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  DSHLegacyBoundProjectRootOperationMode legacyMode = hasGitWrite
      ? DSHLegacyBoundProjectRootOperationModeGitWrite
      : (hasFileWrite ? DSHLegacyBoundProjectRootOperationModeWrite
                      : (hasGitRead
                            ? DSHLegacyBoundProjectRootOperationModeGitRead
                            : DSHLegacyBoundProjectRootOperationModeRead));

  if (!hasGitPush && [root[@"kind"] isEqualToString:@"project"] &&
      self.legacyBoundProjectAccess != nil) {
    NSError *probeError = nil;
    DSHLegacyBoundProjectRootDisposition disposition =
        [self.legacyBoundProjectAccess
            performProjectHandleOperationForBoundRoot:root mode:legacyMode
            timeout:5.0
            block:^BOOL(__unused int descriptor,
                        __unused git_repository *repository,
                        __unused NSError **blockError) { return YES; }
            error:&probeError];
    if (disposition == DSHLegacyBoundProjectRootDispositionHandled) {
      DSHLocalWorkspaceAuthorityMutationGuard *guard =
          [self acquireAuthorityMutationGuardForFrozenRoot:root error:error];
      if (guard == nil) return nil;
      DSHLegacyBoundProjectRootDisposition proofDisposition =
          DSHLegacyBoundProjectRootDispositionFailed;
      DSHLegacyBoundProjectRootProof *legacyProof =
          [self.legacyBoundProjectAccess acquireProofForBoundRoot:root
              mode:legacyMode timeout:5.0 authorityMutationGuard:guard
              disposition:&proofDisposition error:&probeError];
      if (legacyProof == nil ||
          proofDisposition != DSHLegacyBoundProjectRootDispositionHandled) {
        DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
        return nil;
      }
      DSHAgentRootFinalProof *proof = [[DSHAgentRootFinalProof alloc] init];
      proof.authorityGuard = guard;
      proof.legacyProof = legacyProof;
      if (error != nullptr) *error = nil;
      return proof;
    }
    if (disposition == DSHLegacyBoundProjectRootDispositionFailed) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
      return nil;
    }
  }

  DSHLocalWorkspaceLease *workspaceLease = [self
      workspaceLeaseForFrozenRoot:root
      requiredWorkspaceCapabilities:capabilities error:error];
  if (workspaceLease == nil) return nil;
  DSHLocalProjectLease *projectLease = nil;
  if (needsProjectLease) {
    projectLease = [self projectLeaseForFrozenRoot:root
        mode:projectWriteAccess ? DSHLocalProjectAccessModeWrite
                                : DSHLocalProjectAccessModeRead
        timeout:5.0 error:error];
    if (projectLease == nil) return nil;
  }
  DSHLocalWorkspaceAuthorityMutationGuard *guard =
      [self acquireAuthorityMutationGuardForFrozenRoot:root error:error];
  if (guard == nil ||
      ![self validateFrozenRoot:root authorityMutationGuard:guard error:error]) {
    return nil;
  }
  DSHAgentRootFinalProof *proof = [[DSHAgentRootFinalProof alloc] init];
  proof.workspaceLease = workspaceLease;
  proof.projectLease = projectLease;
  proof.authorityGuard = guard;
  if (error != nullptr) *error = nil;
  return proof;
}

@end
