#import <XCTest/XCTest.h>

#import "../../../../modules/rish/ios/Sources/LocalProjectAccess.h"
#import "../../../../modules/rish/ios/Sources/LocalWorkspaceAccess.h"

#include <git2.h>
#include <sys/stat.h>
#include <unistd.h>

@interface LocalProjectsModule : NSObject
@end

@interface LocalProjectsModule (V2Testing)
- (nullable NSDictionary *)v2AttachWorkspaceProject:(NSDictionary *)request
                                               error:(NSError **)error;
- (BOOL)v2ReconcileAttachStagingForWorkspaceId:(NSString *)workspaceId
                                          error:(NSError **)error;
- (nullable NSDictionary *)v2ProjectForWorkspace:(NSDictionary *)root
                                             error:(NSError **)error;
- (DSHLocalProjectAccess *)v2LegacyProjectAccess;
- (instancetype)initWithSupportURL:(nullable NSURL *)support
                       projectAccess:(DSHLocalProjectAccess *)projectAccess;
@end

@interface DSHLocalWorkspaceAccess (V2CapabilityTesting)
- (NSSet<NSString *> *)operationalCapabilitiesForMetadataRecord:
    (NSDictionary *)record
                                                        authority:
    (NSDictionary *)authority
                                                           status:(NSString *)status;
@end

@interface LocalProjectsModuleV2Tests : XCTestCase
@property(nonatomic, strong) NSURL *privateRoot;
@property(nonatomic, strong) NSURL *documentsRoot;
@property(nonatomic, strong) DSHLocalWorkspaceAccess *workspaceAccess;
@property(nonatomic, strong) DSHLocalProjectAccess *projectAccess;
@property(nonatomic, strong) LocalProjectsModule *module;
@property(nonatomic, copy) NSDictionary *root;
@property(nonatomic, strong) NSURL *legacyBaseRoot;
@end

@implementation LocalProjectsModuleV2Tests

- (void)setUp {
  [super setUp];
  NSString *suffix = NSUUID.UUID.UUIDString.lowercaseString;
  self.privateRoot = [NSURL fileURLWithPath:
      [NSTemporaryDirectory() stringByAppendingPathComponent:
          [NSString stringWithFormat:@"rish-attach-private-%@", suffix]]
                                      isDirectory:YES];
  self.documentsRoot = [NSURL fileURLWithPath:
      [NSTemporaryDirectory() stringByAppendingPathComponent:
          [NSString stringWithFormat:@"rish-attach-documents-%@", suffix]]
                                        isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:self.privateRoot
                                      withIntermediateDirectories:YES
                                                       attributes:nil error:nil]);
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:self.documentsRoot
                                      withIntermediateDirectories:YES
                                                       attributes:nil error:nil]);
  NSString *workspaceId = @"11111111-1111-4111-8111-111111111111";
  self.workspaceAccess = [[DSHLocalWorkspaceAccess alloc]
      initWithPrivateRootURL:self.privateRoot
            documentsRootURL:self.documentsRoot
                         clock:^NSDate *{ return NSDate.date; }
                UUIDGenerator:^NSString *{ return workspaceId; }
                legacyResolver:^BOOL(__unused NSString *projectId,
                                     NSDictionary **evidence,
                                     NSError **error) {
                  if (evidence != nil) *evidence = nil;
                  if (error != nil) *error = [NSError errorWithDomain:@"test"
                                                                    code:1
                                                                userInfo:nil];
                  return NO;
                }
                      faultHook:nil];
  NSError *error = nil;
  XCTAssertTrue([self.workspaceAccess ensurePrivateLayoutWithError:&error], @"%@", error);
  NSDictionary *workspace = [self.workspaceAccess
      createRishOwnedWorkspaceWithDisplayName:@"Attach Fixture"
                                  operationId:@"22222222-2222-4222-8222-222222222222"
                                        error:&error];
  XCTAssertNotNil(workspace, @"%@", error);
  self.root = @{
    @"schema_version" : @1,
    @"workspace_id" : workspace[@"workspace_id"],
    @"binding_revision" : workspace[@"binding_revision"],
    @"project_id" : [NSNull null],
  };
  self.projectAccess = [[DSHLocalProjectAccess alloc]
      initWithWorkspaceAccess:self.workspaceAccess hook:nil];
  Class moduleClass = NSClassFromString(@"LocalProjectsModule");
  if (moduleClass == Nil) {
    XCTSkip(@"LocalProjectsModule is not linked into this XCTest target");
  }
  self.module = [[moduleClass alloc] init];
  [self.module setValue:self.workspaceAccess forKey:@"workspaceAccessV2"];
  [self.module setValue:self.projectAccess forKey:@"projectAccessV2"];
  [self.module setValue:nil forKey:@"v2AttachStartupError"];
}

- (void)tearDown {
  self.module = nil;
  [NSFileManager.defaultManager removeItemAtURL:self.privateRoot error:nil];
  [NSFileManager.defaultManager removeItemAtURL:self.documentsRoot error:nil];
  [NSFileManager.defaultManager removeItemAtURL:self.legacyBaseRoot error:nil];
  [super tearDown];
}

- (NSDictionary *)attachWithRoot:(NSDictionary *)root error:(NSError **)error {
  return [self.module v2AttachWorkspaceProject:@{
    @"schema_version" : @1,
    @"operation_id" : @"33333333-3333-4333-8333-333333333333",
    @"root" : root,
    @"mode" : @"init",
  } error:error];
}

- (NSURL *)workspaceGitRoot {
  return [[[self.privateRoot
      URLByAppendingPathComponent:@"workspace-gitdirs" isDirectory:YES]
      URLByAppendingPathComponent:self.root[@"workspace_id"] isDirectory:YES]
      URLByStandardizingPath];
}

- (NSArray<NSURL *> *)attachPendingEntries {
  NSError *error = nil;
  NSArray<NSURL *> *entries = [NSFileManager.defaultManager
      contentsOfDirectoryAtURL:self.workspaceGitRoot
      includingPropertiesForKeys:nil options:0 error:&error];
  if (entries == nil && [error.domain isEqual:NSCocoaErrorDomain] &&
      error.code == NSFileReadNoSuchFileError) return @[];
  XCTAssertNotNil(entries, @"%@", error);
  NSPredicate *pending = [NSPredicate predicateWithBlock:
      ^BOOL(NSURL *url, __unused NSDictionary *bindings) {
        return [url.lastPathComponent hasPrefix:@".rish-attach-"];
      }];
  return [entries filteredArrayUsingPredicate:pending];
}

- (LocalProjectsModule *)restartedModule {
  Class moduleClass = NSClassFromString(@"LocalProjectsModule");
  LocalProjectsModule *module = [[moduleClass alloc] init];
  [module setValue:self.workspaceAccess forKey:@"workspaceAccessV2"];
  [module setValue:self.projectAccess forKey:@"projectAccessV2"];
  [module setValue:nil forKey:@"v2AttachStartupError"];
  return module;
}

- (NSDictionary *)installLegacyLookupFixture {
  NSString *projectId = @"55555555-5555-4555-8555-555555555555";
  self.legacyBaseRoot = [NSURL fileURLWithPath:
      [NSTemporaryDirectory() stringByAppendingPathComponent:
          NSUUID.UUID.UUIDString.lowercaseString]
                                      isDirectory:YES];
  NSURL *projectsRoot = [self.legacyBaseRoot
      URLByAppendingPathComponent:@"projects" isDirectory:YES];
  NSURL *projectRoot = [projectsRoot
      URLByAppendingPathComponent:projectId isDirectory:YES];
  NSURL *repositoryRoot = [projectRoot
      URLByAppendingPathComponent:@"repo" isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager
      createDirectoryAtURL:repositoryRoot
      withIntermediateDirectories:YES
      attributes:@{NSFilePosixPermissions : @0700} error:nil]);
  NSDictionary *metadata = @{
    @"schema_version" : @1,
    @"name" : @"Legacy Lookup",
    @"created_at" : @"2026-09-01T00:00:00.000Z",
    @"updated_at" : @"2026-09-01T00:00:00.000Z",
    @"origin_url" : NSNull.null,
  };
  NSData *metadataData = [NSJSONSerialization dataWithJSONObject:metadata
                                                          options:0 error:nil];
  XCTAssertTrue([metadataData writeToURL:
      [projectRoot URLByAppendingPathComponent:@"project.json"]
                              atomically:YES]);
  XCTAssertGreaterThan(git_libgit2_init(), 0);
  git_repository *repository = nullptr;
  XCTAssertEqual(git_repository_init(&repository,
                                      repositoryRoot.fileSystemRepresentation,
                                      0), 0);
  if (repository != nullptr) git_repository_free(repository);

  DSHLocalProjectAccess *legacyAccess = [[DSHLocalProjectAccess alloc]
      initWithProjectsRootURL:projectsRoot hook:nil];
  LocalProjectsModule *module = [[LocalProjectsModule alloc]
      initWithSupportURL:self.privateRoot projectAccess:legacyAccess];
  DSHLocalWorkspaceAccess *legacyWorkspaceAccess =
      [module valueForKey:@"workspaceAccessV2"];
  NSError *error = nil;
  XCTAssertTrue([legacyWorkspaceAccess ensurePrivateLayoutWithError:&error],
                @"%@", error);
  NSDictionary *workspace = [legacyWorkspaceAccess
      bootstrapLegacyProjectId:projectId
                   operationId:@"77777777-7777-4777-8777-777777777777"
                         error:&error];
  XCTAssertNotNil(workspace, @"%@", error);
  self.workspaceAccess = legacyWorkspaceAccess;
  self.projectAccess = legacyAccess;
  self.module = module;
  self.root = @{
    @"schema_version" : @1,
    @"workspace_id" : workspace[@"workspace_id"],
    @"binding_revision" : workspace[@"binding_revision"],
    @"project_id" : NSNull.null,
  };
  return @{ @"project_id" : projectId, @"project_root" : projectRoot };
}

- (void)testProductionResolverUnavailableIsSanitized {
  NSURL *missingProjectsRoot = [self.privateRoot
      URLByAppendingPathComponent:@"missing-projects" isDirectory:YES];
  DSHLocalProjectAccess *missingAccess = [[DSHLocalProjectAccess alloc]
      initWithProjectsRootURL:missingProjectsRoot hook:nil];
  LocalProjectsModule *module = [[LocalProjectsModule alloc]
      initWithSupportURL:self.privateRoot projectAccess:missingAccess];
  DSHLocalWorkspaceAccess *workspaceAccess =
      [module valueForKey:@"workspaceAccessV2"];
  NSError *error = nil;
  XCTAssertNil([workspaceAccess
      bootstrapLegacyProjectId:@"88888888-8888-4888-8888-888888888888"
                   operationId:@"99999999-9999-4999-8999-999999999999"
                         error:&error]);
  XCTAssertEqualObjects(error.domain, DSHLocalWorkspaceAccessErrorDomain);
  XCTAssertEqual(error.code, DSHLocalWorkspaceAccessErrorUnavailable);
  XCTAssertFalse([error.localizedDescription containsString:self.privateRoot.path]);
}

- (void)testLegacyWorkspaceLookupReturnsSafeAttachedProjectWithoutLeak {
  NSDictionary *fixture = [self installLegacyLookupFixture];
  NSURL *splitRoot = [[self.privateRoot
      URLByAppendingPathComponent:@"workspace-gitdirs" isDirectory:YES]
      URLByAppendingPathComponent:self.root[@"workspace_id"] isDirectory:YES];
  XCTAssertFalse([NSFileManager.defaultManager fileExistsAtPath:splitRoot.path]);
  NSError *error = nil;
  NSDictionary *result = [self.module v2ProjectForWorkspace:self.root
                                                       error:&error];
  XCTAssertNotNil(result, @"%@", error);
  XCTAssertEqualObjects(result[@"status"], @"attached");
  NSDictionary *project = result[@"project"];
  NSSet *expectedProjectKeys = [NSSet setWithArray:@[
    @"schema_version", @"project_id", @"workspace_id",
    @"workspace_binding_revision", @"display_name", @"git_topology"
  ]];
  XCTAssertEqualObjects([NSSet setWithArray:project.allKeys],
                        expectedProjectKeys);
  XCTAssertEqualObjects(project[@"project_id"], fixture[@"project_id"]);
  XCTAssertEqualObjects(project[@"workspace_id"], self.root[@"workspace_id"]);
  XCTAssertEqualObjects(project[@"workspace_binding_revision"], @1);
  XCTAssertEqualObjects(project[@"display_name"], @"Legacy Lookup");
  XCTAssertEqualObjects(project[@"git_topology"], @"legacy_embedded");
  for (NSString *forbidden in @[@"path", @"url", @"metadata_sha256",
                                 @"descriptor", @"root_fingerprint_sha256"]) {
    XCTAssertNil(project[forbidden]);
  }
  XCTAssertFalse([NSFileManager.defaultManager fileExistsAtPath:splitRoot.path]);
}

- (void)testLegacyWorkspaceLookupWrongRevisionIsStableConflict {
  [self installLegacyLookupFixture];
  NSMutableDictionary *wrongRevision = [self.root mutableCopy];
  wrongRevision[@"binding_revision"] = @2;
  NSError *error = nil;
  XCTAssertNil([self.module v2ProjectForWorkspace:wrongRevision error:&error]);
  XCTAssertEqualObjects(error.domain, @"LocalProjects");
  XCTAssertEqual(error.code, 3110);
}

- (void)testLegacyWorkspaceLookupIdentityDriftIsStableConflict {
  NSDictionary *fixture = [self installLegacyLookupFixture];
  NSURL *metadataURL = [fixture[@"project_root"]
      URLByAppendingPathComponent:@"project.json"];
  NSMutableDictionary *metadata = [[NSJSONSerialization JSONObjectWithData:
      [NSData dataWithContentsOfURL:metadataURL] options:0 error:nil]
      mutableCopy];
  metadata[@"name"] = @"Drifted Legacy Lookup";
  XCTAssertTrue([[NSJSONSerialization dataWithJSONObject:metadata options:0
                                                   error:nil]
      writeToURL:metadataURL atomically:YES]);
  NSError *error = nil;
  XCTAssertNil([self.module v2ProjectForWorkspace:self.root error:&error]);
  XCTAssertEqualObjects(error.domain, @"LocalProjects");
  XCTAssertEqual(error.code, 3110);
}

- (void)testOrdinaryWorkspaceWithoutSplitBindingRemainsNone {
  NSError *error = nil;
  NSDictionary *result = [self.module v2ProjectForWorkspace:self.root
                                                       error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result,
      (@{ @"schema_version" : @1, @"status" : @"none" }));
}

- (void)testRealAttachPublishesOnlyAfterProductionProjectLeaseVerification {
  NSError *error = nil;
  NSDictionary *result = [self attachWithRoot:self.root error:&error];
  XCTAssertNotNil(result, @"%@", error);
  XCTAssertEqualObjects(result[@"status"], @"attached");
  NSString *projectId = result[@"project"][@"project_id"];
  XCTAssertTrue([DSHLocalProjectAccess isCanonicalProjectId:projectId]);
  NSDictionary *projectRoot = @{
    @"schema_version" : @1,
    @"workspace_id" : self.root[@"workspace_id"],
    @"binding_revision" : self.root[@"binding_revision"],
    @"project_id" : projectId,
  };
  DSHLocalProjectLease *lease = [self.projectAccess
      leaseWorkspaceRootRef:projectRoot
                       mode:DSHLocalProjectAccessModeRead
            includeMetadata:YES
                    timeout:1
                      error:&error];
  XCTAssertNotNil(lease, @"%@", error);
  XCTAssertTrue([self.projectAccess validateWorkspaceLeaseIdentity:lease
                                                           rootRef:projectRoot
                                                             error:&error], @"%@", error);
}

- (void)testAttachRejectsWrongRevisionAndRelationWithoutPublication {
  NSError *error = nil;
  NSDictionary *wrongRevision = @{
    @"schema_version" : @1,
    @"workspace_id" : self.root[@"workspace_id"],
    @"binding_revision" : @2,
    @"project_id" : [NSNull null],
  };
  XCTAssertNil([self attachWithRoot:wrongRevision error:&error]);
  XCTAssertNotNil(error);
  error = nil;
  NSDictionary *wrongRelation = @{
    @"schema_version" : @1,
    @"workspace_id" : @"44444444-4444-4444-8444-444444444444",
    @"binding_revision" : @1,
    @"project_id" : [NSNull null],
  };
  XCTAssertNil([self attachWithRoot:wrongRelation error:&error]);
  XCTAssertNotNil(error);
}

- (void)testDocumentsRootPublishesAllNativeCapabilities {
  NSError *error = nil;
  NSDictionary *resolved = [self.workspaceAccess
      resolveWorkspaceId:self.root[@"workspace_id"]
      expectedBindingRevision:self.root[@"binding_revision"]
      requiredCapabilities:@[] error:&error];
  XCTAssertNotNil(resolved, @"%@", error);
  NSDictionary *capabilities = resolved[@"workspace"][@"capabilities"];
  XCTAssertEqualObjects(capabilities[@"read"], @YES);
  XCTAssertEqualObjects(capabilities[@"write"], @YES);
  XCTAssertEqualObjects(capabilities[@"git"], @YES);
  XCTAssertEqualObjects(capabilities[@"project_context"], @YES);
}

- (void)testSecurityScopedCapabilitiesStayReadWriteOnly {
  NSSet<NSString *> *securityScoped = [self.workspaceAccess
      operationalCapabilitiesForMetadataRecord:@{
        @"root_locator_kind" : @"security_scoped"
      }
                                    authority:@{}
                                       status:@"ok"];
  NSSet<NSString *> *expectedSecurityScoped =
      [NSSet setWithObjects:@"read", @"write", nil];
  XCTAssertEqualObjects(securityScoped, expectedSecurityScoped);
  NSSet<NSString *> *documents = [self.workspaceAccess
      operationalCapabilitiesForMetadataRecord:@{
        @"root_locator_kind" : @"documents_owned"
      }
                                    authority:@{}
                                       status:@"ok"];
  NSSet<NSString *> *expectedDocuments = [NSSet setWithObjects:
      @"read", @"write", @"git", @"project_context", nil];
  XCTAssertEqualObjects(documents, expectedDocuments);
}

- (void)testAttachFaultMatrixCleansEveryOwnedPhaseAndCanRetry {
  for (NSString *faultStage in @[
    @"after_attach_journal", @"after_attach_staging",
    @"after_attach_preflight", @"after_attach_publish",
    @"after_attach_terminal_validation"
  ]) {
    [self.module setValue:^BOOL(NSString *stage) {
      return [stage isEqualToString:faultStage];
    } forKey:@"v2AttachFaultHook"];
    NSError *error = nil;
    XCTAssertNil([self attachWithRoot:self.root error:&error], @"%@", faultStage);
    XCTAssertNotNil(error, @"%@", faultStage);
    [self.module setValue:nil forKey:@"v2AttachFaultHook"];
    error = nil;
    XCTAssertTrue([self.module
        v2ReconcileAttachStagingForWorkspaceId:self.root[@"workspace_id"]
                                          error:&error], @"%@ %@", faultStage, error);
    XCTAssertEqual(self.attachPendingEntries.count, (NSUInteger)0,
                   @"%@", faultStage);
  }
  NSError *error = nil;
  XCTAssertNotNil([self attachWithRoot:self.root error:&error], @"%@", error);
}

- (void)testStagingCreateFailureDurablyRemovesPreparedJournal {
  [self.module setValue:^BOOL(NSString *stage) {
    return [stage isEqualToString:@"attach_staging_create"];
  } forKey:@"v2AttachFaultHook"];
  NSError *error = nil;
  XCTAssertNil([self attachWithRoot:self.root error:&error]);
  XCTAssertNotNil(error);
  XCTAssertEqual(self.attachPendingEntries.count, (NSUInteger)0);
}

- (void)testEnumerationFailureStopsAttachBeforeMutation {
  [self.module setValue:^BOOL(NSString *stage) {
    return [stage isEqualToString:@"attach_reconcile_enumeration"];
  } forKey:@"v2AttachFaultHook"];
  NSError *error = nil;
  XCTAssertNil([self attachWithRoot:self.root error:&error]);
  XCTAssertNotNil(error);
  [self.module setValue:nil forKey:@"v2AttachFaultHook"];
  XCTAssertEqual(self.attachPendingEntries.count, (NSUInteger)0);
}

- (void)testCleanupFailureIsRecoveredByRestartBeforeRetry {
  [self.module setValue:^BOOL(NSString *stage) {
    return [stage isEqualToString:@"after_attach_journal"] ||
        [stage isEqualToString:@"attach_cleanup"];
  } forKey:@"v2AttachFaultHook"];
  NSError *error = nil;
  XCTAssertNil([self attachWithRoot:self.root error:&error]);
  XCTAssertNotNil(error);
  XCTAssertGreaterThan(self.attachPendingEntries.count, (NSUInteger)0);
  [self.module setValue:nil forKey:@"v2AttachFaultHook"];
  LocalProjectsModule *restarted = [self restartedModule];
  error = nil;
  XCTAssertTrue([restarted
      v2ReconcileAttachStagingForWorkspaceId:self.root[@"workspace_id"]
                                        error:&error], @"%@", error);
  XCTAssertEqual(self.attachPendingEntries.count, (NSUInteger)0);
  self.module = restarted;
  XCTAssertNotNil([self attachWithRoot:self.root error:&error], @"%@", error);
}

- (void)testPublishedCleanupFailureRestartPreservesVerifiedAttachment {
  [self.module setValue:^BOOL(NSString *stage) {
    return [stage isEqualToString:@"after_attach_publish"] ||
        [stage isEqualToString:@"attach_cleanup"];
  } forKey:@"v2AttachFaultHook"];
  NSError *error = nil;
  XCTAssertNil([self attachWithRoot:self.root error:&error]);
  XCTAssertNotNil(error);
  XCTAssertGreaterThan(self.attachPendingEntries.count, (NSUInteger)0);
  [self.module setValue:nil forKey:@"v2AttachFaultHook"];
  LocalProjectsModule *restarted = [self restartedModule];
  error = nil;
  XCTAssertTrue([restarted
      v2ReconcileAttachStagingForWorkspaceId:self.root[@"workspace_id"]
                                        error:&error], @"%@", error);
  XCTAssertEqual(self.attachPendingEntries.count, (NSUInteger)0);
  self.module = restarted;
  NSDictionary *result = [self attachWithRoot:self.root error:&error];
  XCTAssertNotNil(result, @"%@", error);
  XCTAssertEqualObjects(result[@"status"], @"already_attached");
}

- (void)testMalformedRestartJournalFailsClosed {
  XCTAssertTrue([NSFileManager.defaultManager
      createDirectoryAtURL:self.workspaceGitRoot
      withIntermediateDirectories:YES attributes:nil error:nil]);
  NSURL *journal = [self.workspaceGitRoot URLByAppendingPathComponent:
      @".rish-attach-78787878-7878-4787-8787-787878787878.journal"];
  XCTAssertTrue([[NSData dataWithBytes:"{}" length:2]
      writeToURL:journal options:NSDataWritingAtomic error:nil]);
  LocalProjectsModule *restarted = [self restartedModule];
  NSError *error = nil;
  XCTAssertFalse([restarted
      v2ReconcileAttachStagingForWorkspaceId:self.root[@"workspace_id"]
                                        error:&error]);
  XCTAssertNotNil(error);
  XCTAssertTrue([NSFileManager.defaultManager fileExistsAtPath:journal.path]);
}

- (void)testExclusivePublishDoesNotOverwriteRenameCollision {
  __block NSURL *collision = nil;
  __block NSURL *marker = nil;
  NSString *operationId = @"33333333-3333-4333-8333-333333333333";
  NSURL *workspaceGitRoot = self.workspaceGitRoot;
  [self.module setValue:^BOOL(NSString *stage) {
    if (![stage isEqualToString:@"after_attach_preflight"] || collision != nil) {
      return NO;
    }
    NSURL *journalURL = [workspaceGitRoot URLByAppendingPathComponent:
        [NSString stringWithFormat:@".rish-attach-%@.journal", operationId]];
    NSDictionary *journal = [NSJSONSerialization JSONObjectWithData:
        [NSData dataWithContentsOfURL:journalURL] options:0 error:nil];
    collision = [workspaceGitRoot
        URLByAppendingPathComponent:journal[@"final_name"] isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:collision
        withIntermediateDirectories:NO attributes:nil error:nil];
    marker = [collision URLByAppendingPathComponent:@"collision-marker"];
    [[NSData dataWithBytes:"keep" length:4] writeToURL:marker atomically:YES];
    return NO;
  } forKey:@"v2AttachFaultHook"];
  NSError *error = nil;
  XCTAssertNil([self attachWithRoot:self.root error:&error]);
  XCTAssertNotNil(error);
  XCTAssertTrue([NSFileManager.defaultManager fileExistsAtPath:marker.path]);
  XCTAssertEqual(self.attachPendingEntries.count, (NSUInteger)0);
}

- (NSDictionary *)attachProjectRoot:(NSError **)error {
  NSDictionary *result = [self attachWithRoot:self.root error:error];
  NSString *projectId = result[@"project"][@"project_id"];
  return projectId == nil ? nil : @{
    @"schema_version" : @1,
    @"workspace_id" : self.root[@"workspace_id"],
    @"binding_revision" : self.root[@"binding_revision"],
    @"project_id" : projectId,
  };
}

- (void)testRootBindingAndGitDirectoryReplacementFailClosed {
  NSError *error = nil;
  NSDictionary *projectRoot = [self attachProjectRoot:&error];
  XCTAssertNotNil(projectRoot, @"%@", error);
  NSString *projectId = projectRoot[@"project_id"];
  NSURL *gitURL = [[[[self.privateRoot
      URLByAppendingPathComponent:@"workspace-gitdirs" isDirectory:YES]
      URLByAppendingPathComponent:self.root[@"workspace_id"] isDirectory:YES]
      URLByAppendingPathComponent:projectId isDirectory:YES] URLByStandardizingPath];
  NSURL *bindingURL = [gitURL URLByAppendingPathComponent:@"binding-v2.json"];
  NSMutableDictionary *binding = [[NSJSONSerialization
      JSONObjectWithData:[NSData dataWithContentsOfURL:bindingURL]
                 options:0 error:nil] mutableCopy];
  binding[@"project_id"] = @"44444444-4444-4444-8444-444444444444";
  XCTAssertTrue([[NSJSONSerialization dataWithJSONObject:binding options:0 error:nil]
      writeToURL:bindingURL atomically:YES]);
  XCTAssertNil([self.projectAccess leaseWorkspaceRootRef:projectRoot
                                                    mode:DSHLocalProjectAccessModeRead
                                         includeMetadata:YES timeout:1 error:&error]);
  XCTAssertNotNil(error);
}

- (void)testAlreadyAttachedRevalidatesTheProductionProjectLease {
  NSError *error = nil;
  NSDictionary *first = [self attachWithRoot:self.root error:&error];
  XCTAssertNotNil(first, @"%@", error);
  NSURL *workspaceRoot = [[self.documentsRoot
      URLByAppendingPathComponent:@"Rish Workspaces" isDirectory:YES]
      URLByAppendingPathComponent:@"Attach Fixture" isDirectory:YES];
  NSURL *replacement = [workspaceRoot.URLByDeletingLastPathComponent
      URLByAppendingPathComponent:@"Attach Fixture.old" isDirectory:YES];
  XCTAssertTrue(rename(workspaceRoot.fileSystemRepresentation,
                       replacement.fileSystemRepresentation) == 0);
  XCTAssertTrue(mkdir(workspaceRoot.fileSystemRepresentation, 0700) == 0);
  error = nil;
  XCTAssertNil([self attachWithRoot:self.root error:&error]);
  XCTAssertNotNil(error);
}

@end
