#import "RishGuestCgiFeature.h"
#import "AgentRootResolver.h"

#import "AgentNativeWAL.h"

#include "rish_agent_core.h"

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

static NSError *DSHAgentRootError(DSHAgentNativeStoreErrorCode code) {
  return DSHAgentNativeStoreError(code);
}

static void DSHSetRootError(NSError **error,
                            DSHAgentNativeStoreErrorCode code) {
  if (error != nullptr) *error = DSHAgentRootError(code);
}

// Resolving a root is this class's job and stays here: only the host owns the
// workspace registry, the leases, the authority guard and libgit2.  Every
// judgement it makes on the way — what a resolver argument may look like, what
// projection a set of grants implies, how a workspace root is promoted to a
// project root, which capability an operation mode needs and whether a final
// proof asks for the leases it will use — is a rule, and the rules live in the
// shared core (modules/rish/core, `rish_agent_root_reduce`).  What stays here
// besides the host capability is the one build fact the core cannot know:
// whether this binary has the guest CGI tools compiled in, which decides
// whether a root can ever carry `guest_service`.
#if DSH_GUEST_CGI_AVAILABLE
static const BOOL DSHAgentRootGuestCGIAvailable = YES;
#else
static const BOOL DSHAgentRootGuestCGIAvailable = NO;
#endif

static NSDictionary *DSHAgentRootReduce(NSString *op,
                                        NSDictionary *fields,
                                        NSError **error) {
  NSMutableDictionary *envelope = [fields mutableCopy];
  envelope[@"op"] = op;
  envelope[@"guest_cgi"] = @(DSHAgentRootGuestCGIAvailable);
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:envelope options:0
                                                    error:nil];
  if (bytes == nil) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  char *raw = rish_agent_root_reduce((const char *)bytes.bytes, bytes.length);
  if (raw == NULL) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSData *replyBytes = [NSData dataWithBytes:raw length:strlen(raw)];
  rish_agent_string_free(raw);
  id reply = [NSJSONSerialization JSONObjectWithData:replyBytes options:0
                                                error:nil];
  if (![reply isKindOfClass:NSDictionary.class]) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  if (![reply[@"ok"] isEqual:@YES]) {
    NSInteger code = [reply[@"error"] isKindOfClass:NSNumber.class]
        ? [reply[@"error"] integerValue] : 0;
    if (code < DSHAgentNativeStoreErrorInvalidArgument ||
        code > DSHAgentNativeStoreErrorPersistence) {
      code = DSHAgentNativeStoreErrorCorrupt;
    }
    DSHSetRootError(error, (DSHAgentNativeStoreErrorCode)code);
    return nil;
  }
  if (error != nullptr) *error = nil;
  return reply;
}

static BOOL DSHAgentRootProjectionShape(NSDictionary *root,
                                         NSError **error) {
  // The immutability check is the one part that cannot travel: it is about
  // this process's object graph, not about the value.  Everything the value
  // itself must satisfy — the exact seven keys, the canonical identifiers, the
  // kind/project_id agreement and the capability list — is `schema::root_full`
  // in the core, the same rule stored roots in the journal and the ledger are
  // already validated with.
  if (!DSHAgentIsImmutableFoundationJSON(root)) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  return DSHAgentRootReduce(@"projection_shape", @{ @"value" : root },
                            error) != nil;
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

// The two enumerations are this platform's spelling of the modes the core
// names; they translate, they do not decide.
static NSString *DSHAgentRootOperationModeName(DSHAgentRootOperationMode mode) {
  switch (mode) {
    case DSHAgentRootOperationModeRead: return @"read";
    case DSHAgentRootOperationModeWrite: return @"write";
    case DSHAgentRootOperationModeGitRead: return @"git_read";
    case DSHAgentRootOperationModeGitWrite: return @"git_write";
    case DSHAgentRootOperationModeProjectContext: return @"project_context";
  }
  return @"";
}

static DSHLegacyBoundProjectRootOperationMode DSHLegacyBoundProjectMode(
    NSString *name) {
  if ([name isEqual:@"write"]) return DSHLegacyBoundProjectRootOperationModeWrite;
  if ([name isEqual:@"git_read"]) return DSHLegacyBoundProjectRootOperationModeGitRead;
  if ([name isEqual:@"git_write"]) return DSHLegacyBoundProjectRootOperationModeGitWrite;
  if ([name isEqual:@"project_context"]) {
    return DSHLegacyBoundProjectRootOperationModeProjectContext;
  }
  return DSHLegacyBoundProjectRootOperationModeRead;
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
  // value here, and the core refuses to put one in a workspace projection.
  NSArray *grants = [[available allObjects]
      filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:
          ^BOOL(id grant, __unused NSDictionary *bindings) {
            return [@[ @"read", @"write", @"git" ] containsObject:grant];
          }]];
  return DSHAgentRootReduce(@"workspace_projection", @{
    @"workspace_id" : workspaceId,
    @"binding_revision" : bindingRevision,
    @"root_fingerprint_sha256" : fingerprint,
    @"grants" : grants,
  }, error)[@"root"];
}

- (nullable NSDictionary *)resolveRootForWorkspaceId:(NSString *)workspaceId
                                           projectId:(NSString *)projectId
                                     bindingRevision:(NSNumber *)bindingRevision
                                               error:(NSError **)error {
  // Three absent arguments are "no root", which is not an error: an attempt may
  // legitimately have none.  Anything else is a root request, and the core says
  // whether it is a well-formed one.
  NSDictionary *request = DSHAgentRootReduce(@"resolve_request", @{
    @"workspace_id" : workspaceId ?: NSNull.null,
    @"project_id" : projectId ?: NSNull.null,
    @"binding_revision" : bindingRevision ?: NSNull.null,
  }, error);
  if (request == nil) return nil;
  if ([request[@"outcome"] isEqual:@"none"]) {
    if (error != nullptr) *error = nil;
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
  NSDictionary *legacyCandidate = DSHAgentRootReduce(@"project_projection", @{
    @"base" : workspaceRoot, @"project_id" : projectId,
  }, error)[@"root"];
  if (legacyCandidate == nil) return nil;
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
      return legacyCandidate;
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
  // The same reference the legacy probe above was built from, derived from the
  // same projection rather than assembled a second time from the arguments.
  NSDictionary *rootRefReply = DSHAgentRootReduce(@"root_ref",
      @{ @"root" : legacyCandidate }, error);
  if (rootRefReply == nil) return nil;
  NSDictionary *rootRef = rootRefReply[@"root_ref"];
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
  // LocalProjectAccess has already required and verified the native `git`
  // capability, and the lease's fingerprint is the authoritative one.  The
  // core appends exactly the three fixed Agent Git capabilities in their
  // canonical order, once; the generic workspace capability is never exposed.
  return DSHAgentRootReduce(@"project_projection", @{
    @"base" : workspaceRoot, @"project_id" : projectId,
    @"root_fingerprint_sha256" : projectLease.rootFingerprintSHA256,
  }, error)[@"root"];
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
  NSDictionary *expected = base;
  if ([root[@"kind"] isEqualToString:@"project"]) {
    if (self.projectAccess == nil) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorUnavailable);
      return NO;
    }
    NSDictionary *rootRef = DSHAgentRootReduce(@"root_ref",
                                               @{ @"root" : root }, error);
    if (rootRef == nil) return NO;
    NSError *bindingError = nil;
    NSDictionary *binding = [self.projectAccess
        workspaceBindingForRootRef:rootRef[@"root_ref"]
             rootFingerprintSHA256:base[@"root_fingerprint_sha256"]
                            error:&bindingError];
    if (binding == nil) {
      DSHSetRootError(error, DSHAgentNativeStoreErrorOwnerLost);
      return NO;
    }
    expected = DSHAgentRootReduce(@"project_projection", @{
      @"base" : base, @"project_id" : root[@"project_id"],
    }, error)[@"root"];
    if (expected == nil) return NO;
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
  // The inverse of the derivation that built this root's capabilities, and the
  // core holds both directions so they cannot drift apart: a capability whose
  // grant went missing here would be exercised under a lease never taken for
  // it.
  NSDictionary *grants = DSHAgentRootReduce(@"grants", @{
    @"capabilities" : [capabilities allObjects],
  }, error);
  if (grants == nil) return nil;
  NSSet *workspaceCapabilities =
      [NSSet setWithArray:grants[@"grants"]];
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
  NSDictionary *rootRefReply = DSHAgentRootReduce(@"root_ref",
                                                 @{ @"root" : root }, error);
  if (rootRefReply == nil) return nil;
  NSDictionary *rootRef = rootRefReply[@"root_ref"];
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
  if (block == nil) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  // The core names the capability this mode needs, bounds the timeout, and
  // separates the two refusals: a root that cannot serve the mode is a
  // conflict, an unknown mode or an out-of-range timeout a bad request.
  NSDictionary *decision = DSHAgentRootReduce(@"operation_mode", @{
    @"root" : root ?: NSNull.null,
    @"mode" : DSHAgentRootOperationModeName(mode),
    @"timeout" : @(timeout),
  }, error);
  if (decision == nil) return NO;
  DSHLegacyBoundProjectRootOperationMode legacyMode =
      DSHLegacyBoundProjectMode(decision[@"legacy_mode"]);
  NSString *capability = decision[@"capability"];

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
  if (![capabilities isKindOfClass:NSSet.class]) {
    DSHSetRootError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  // A proof has to describe itself consistently: the leases it says it needs
  // must be exactly the ones its capabilities imply, or it would be taken over
  // something other than what the caller will then do with it.
  NSDictionary *decision = DSHAgentRootReduce(@"final_proof_request", @{
    @"root" : root ?: NSNull.null,
    @"capabilities" : [capabilities allObjects],
    @"needs_project_lease" : @(needsProjectLease),
    @"project_write_access" : @(projectWriteAccess),
  }, error);
  if (decision == nil) return nil;
  DSHLegacyBoundProjectRootOperationMode legacyMode =
      DSHLegacyBoundProjectMode(decision[@"legacy_mode"]);

  if ([decision[@"probe_legacy"] isEqual:@YES] &&
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
