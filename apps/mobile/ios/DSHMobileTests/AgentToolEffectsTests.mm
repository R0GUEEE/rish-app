#import <XCTest/XCTest.h>

#import "../../../../modules/rish/ios/Sources/AgentExecutionLedger.h"
#import "../../../../modules/rish/ios/Sources/AgentGitToolExecutor.h"
#import "../../../../modules/rish/ios/Sources/AgentNativeWAL.h"
#import "../../../../modules/rish/ios/Sources/AgentPreparedAttemptStore.h"
#import "../../../../modules/rish/ios/Sources/AgentRootResolver.h"
#import "../../../../modules/rish/ios/Sources/AgentToolBatchService.h"
#import "../../../../modules/rish/ios/Sources/AgentToolExecutionService.h"
#import "../../../../modules/rish/ios/Sources/AgentToolRegistry.h"
#import "../../../../modules/rish/ios/Sources/AgentTranscriptStore.h"
#import "../../../../modules/rish/ios/Sources/AgentWorkspaceToolExecutor.h"
#import "../../../../modules/rish/ios/Sources/LocalProjectAccess.h"
#import "../../../../modules/rish/ios/Sources/LocalWorkspaceAccess.h"

#include <git2.h>

@interface AgentEffectsAuthorityGuard : DSHLocalWorkspaceAuthorityMutationGuard
@property(nonatomic, copy) dispatch_block_t onRelease;
@end
@implementation AgentEffectsAuthorityGuard
- (void)dealloc {
  if (self.onRelease != nil) self.onRelease();
}
@end

@interface AgentEffectsRootResolver : DSHAgentRootResolver
@property(nonatomic, copy) NSDictionary *frozenRoot;
@property(nonatomic) BOOL rejectRoot;
@property(nonatomic) BOOL guardAlive;
@property(nonatomic) NSUInteger guardValidationCount;
@end

/// Real executor tests use the production legacy project lease implementation
/// over temporary repositories.  Only root routing is substituted; Git
/// preparation, commit, push, callback handling, and recovery remain the
/// concrete DSHAgentGitToolExecutor implementation.
@interface AgentEffectsProjectLeaseResolver : DSHAgentRootResolver
@property(nonatomic, strong) DSHLocalProjectAccess *fixtureProjectAccess;
@property(nonatomic, copy) NSDictionary *fixtureRoot;
@property(nonatomic, copy) NSString *fixtureProjectID;
- (instancetype)initWithProjectAccess:(DSHLocalProjectAccess *)projectAccess
                                  root:(NSDictionary *)root;
@end

@implementation AgentEffectsProjectLeaseResolver
- (instancetype)initWithProjectAccess:(DSHLocalProjectAccess *)projectAccess
                                  root:(NSDictionary *)root {
  self = [super initWithWorkspaceAccess:
      (DSHLocalWorkspaceAccess *)(id)NSNull.null projectAccess:projectAccess];
  if (self != nil) {
    _fixtureProjectAccess = projectAccess;
    _fixtureRoot = [root copy];
    _fixtureProjectID = [root[@"project_id"] copy];
  }
  return self;
}
- (BOOL)validateFrozenRoot:(NSDictionary *)root error:(NSError **)error {
  if ([root isEqual:self.fixtureRoot]) return YES;
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorOwnerLost);
  return NO;
}
- (DSHLocalProjectLease *)projectLeaseForFrozenRoot:(NSDictionary *)root
                                               mode:(DSHLocalProjectAccessMode)mode
                                            timeout:(NSTimeInterval)timeout
                                              error:(NSError **)error {
  if (![self validateFrozenRoot:root error:error]) return nil;
  return [self.fixtureProjectAccess leaseProjectId:self.fixtureProjectID
                                              mode:mode
                                   includeMetadata:NO
                                           timeout:timeout
                                             error:error];
}
@end

@implementation AgentEffectsRootResolver
- (instancetype)initWithRoot:(NSDictionary *)root {
  self = [super initWithWorkspaceAccess:(DSHLocalWorkspaceAccess *)(id)NSNull.null
                           projectAccess:nil];
  if (self != nil) _frozenRoot = [root copy];
  return self;
}
- (BOOL)validateFrozenRoot:(NSDictionary *)root error:(NSError **)error {
  BOOL valid = !self.rejectRoot && [root isEqual:self.frozenRoot];
  if (!valid && error != nullptr) {
    *error = DSHAgentNativeStoreError(DSHAgentNativeStoreErrorOwnerLost);
  }
  return valid;
}
- (DSHLocalWorkspaceAuthorityMutationGuard *)
    acquireAuthorityMutationGuardForFrozenRoot:(NSDictionary *)root
                                         error:(NSError **)error {
  if (![self validateFrozenRoot:root error:error]) return nil;
  if (self.guardAlive) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  self.guardAlive = YES;
  AgentEffectsAuthorityGuard *guard = [[AgentEffectsAuthorityGuard alloc] init];
  __weak AgentEffectsRootResolver *weakSelf = self;
  guard.onRelease = ^{
    weakSelf.guardAlive = NO;
  };
  return guard;
}
- (BOOL)validateFrozenRoot:(NSDictionary *)root
     authorityMutationGuard:(DSHLocalWorkspaceAuthorityMutationGuard *)guard
                      error:(NSError **)error {
  if (![guard isKindOfClass:AgentEffectsAuthorityGuard.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if (!self.guardAlive) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorOwnerLost);
    return NO;
  }
  self.guardValidationCount += 1;
  return [self validateFrozenRoot:root error:error];
}
- (DSHLocalWorkspaceLease *)workspaceLeaseForFrozenRoot:(NSDictionary *)root
                           requiredWorkspaceCapabilities:(NSSet<NSString *> *)capabilities
                                                    error:(NSError **)error {
  (void)capabilities;
  return [self validateFrozenRoot:root error:error]
      ? (DSHLocalWorkspaceLease *)(id)NSNull.null : nil;
}
- (DSHLocalProjectLease *)projectLeaseForFrozenRoot:(NSDictionary *)root
                                               mode:(DSHLocalProjectAccessMode)mode
                                            timeout:(NSTimeInterval)timeout
                                              error:(NSError **)error {
  (void)mode; (void)timeout;
  return [self validateFrozenRoot:root error:error]
      ? (DSHLocalProjectLease *)(id)NSNull.null : nil;
}
@end

@interface AgentEffectsSessionStore : DSHSessionSnapshotStore
@property(nonatomic, copy) NSDictionary *fakeLoadResult;
@end

@implementation AgentEffectsSessionStore
- (instancetype)initWithLoadResult:(NSDictionary *)loadResult {
  NSURL *root = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:NSUUID.UUID.UUIDString.lowercaseString]];
  self = [super initWithRootURL:root];
  if (self != nil) _fakeLoadResult = [loadResult copy];
  return self;
}
- (NSDictionary *)loadSessionSnapshotWithError:(NSError **)error {
  if (error != nullptr) *error = nil;
  return self.fakeLoadResult;
}
@end

@interface AgentEffectsPreparedStore : DSHAgentPreparedAttemptStore
@property(nonatomic, copy) NSDictionary *authorityOverride;
@end

@implementation AgentEffectsPreparedStore
- (NSDictionary *)nativeAuthorityForTaskId:(NSString *)taskId
                                  attemptId:(NSString *)attemptId
                                      error:(NSError **)error {
  if (self.authorityOverride != nil) {
    if (error != nullptr) *error = nil;
    return self.authorityOverride;
  }
  return [super nativeAuthorityForTaskId:taskId attemptId:attemptId error:error];
}
@end

@interface AgentEffectsWorkspaceExecutor : DSHAgentWorkspaceToolExecutor
@property(nonatomic) NSUInteger effectCount;
@property(nonatomic) DSHAgentNativeStoreErrorCode prepareFailureCode;
@end

@implementation AgentEffectsWorkspaceExecutor
- (NSDictionary *)prepareToolNamed:(NSString *)name arguments:(NSDictionary *)arguments
                               root:(NSDictionary *)root error:(NSError **)error {
  (void)root;
  if (self.prepareFailureCode != 0) {
    DSHSetAgentNativeStoreError(error, self.prepareFailureCode);
    return nil;
  }
  if ([name isEqualToString:@"write_file"]) {
    NSData *path = [arguments[@"path"] dataUsingEncoding:NSUTF8StringEncoding];
    NSData *content = [arguments[@"content"] dataUsingEncoding:NSUTF8StringEncoding];
    return @{
      @"schema_version" : @1,
      @"precondition" : @{
        @"schema_version" : @2, @"kind" : @"write_file",
        @"relative_path_sha256" : DSHAgentHB(@"relative-path", path, error),
        @"prior" : arguments[@"expected_prior"] ?: @{
          @"schema_version" : @1, @"kind" : @"absent",
        },
        @"content_sha256" : DSHAgentHB(@"file-content", content, error),
        @"content_bytes" : @(content.length),
      },
      @"reserved_write_bytes" : @(content.length),
    };
  }
  if ([name isEqualToString:@"read_file"]) {
    return @{ @"schema_version" : @1,
              @"precondition" : @{ @"schema_version" : @1,
                                    @"kind" : @"read_file",
                                    @"source_revision" : @"r1" },
              @"reserved_write_bytes" : @0 };
  }
  return @{ @"schema_version" : @1,
            @"precondition" : @{ @"schema_version" : @1,
                                  @"kind" : @"list_dir",
                                  @"directory_fingerprint_sha256" :
                                      @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
            @"reserved_write_bytes" : @0 };
}
@end

@interface AgentEffectsGitExecutor : DSHAgentGitToolExecutor
@property(nonatomic) NSUInteger effectCount;
@property(nonatomic, copy) dispatch_block_t onPrepare;
@end

@implementation AgentEffectsGitExecutor
- (NSDictionary *)prepareToolNamed:(NSString *)name arguments:(NSDictionary *)arguments
                               root:(NSDictionary *)root error:(NSError **)error {
  (void)root;
  if (self.onPrepare != nil) self.onPrepare();
  if ([name isEqualToString:@"git_push"]) {
    return @{ @"schema_version" : @1,
              @"precondition" : @{ @"schema_version" : @1,
                @"kind" : @"git_push", @"remote" : @"origin",
                @"remote_ref" : @"refs/heads/main",
                @"pre_remote_oid" : NSNull.null,
                @"target_oid" : @"cccccccccccccccccccccccccccccccccccccccc" },
              @"reserved_write_bytes" : @0 };
  }
  NSData *message = [arguments[@"message"] dataUsingEncoding:NSUTF8StringEncoding];
  NSString *messageSHA = DSHAgentHB(@"commit-message", message, error);
  NSDictionary *identity = @{ @"schema_version" : @1,
    @"name" : @"Rish Agent", @"email" : @"agent@rish.local",
    @"timestamp_seconds" : @1, @"timezone_offset" : @"+0000" };
  return @{ @"schema_version" : @1,
            @"precondition" : @{ @"schema_version" : @2,
              @"kind" : @"git_commit", @"object_format" : @"sha1",
              @"pre_head_oid" : NSNull.null, @"ordered_parent_oids" : @[],
              @"staged_index_sha256" :
                  @"1111111111111111111111111111111111111111111111111111111111111111",
              @"tree_oid" : @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              @"author" : identity, @"committer" : identity,
              @"message_blob_ref" : messageSHA, @"message_sha256" : messageSHA,
              @"message_bytes" : @(message.length), @"encoding_header" : @"UTF-8",
              @"signature_policy" : @"unsigned", @"extra_headers" : @[],
              @"stage_all" : @YES, @"commit_payload_sha256" :
                  @"2222222222222222222222222222222222222222222222222222222222222222",
              @"expected_commit_oid" : @"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
            @"reserved_write_bytes" : @0 };
}
- (NSDictionary *)executeToolNamed:(NSString *)name arguments:(NSDictionary *)arguments
                               root:(NSDictionary *)root
                       precondition:(NSDictionary *)precondition
                              error:(NSError **)error {
  (void)arguments; (void)root; (void)error;
  self.effectCount += 1;
  NSDictionary *payload = [name isEqualToString:@"git_push"]
      ? @{ @"schema_version" : @1, @"remote" : @"origin",
           @"remote_ref" : precondition[@"remote_ref"],
           @"pushed_oid" : precondition[@"target_oid"] }
      : @{ @"schema_version" : @1,
           @"commit_oid" : precondition[@"expected_commit_oid"],
           @"tree_oid" : precondition[@"tree_oid"] };
  NSDictionary *feedback = @{ @"schema_version" : @1, @"name" : name,
                               @"outcome" : @"ok", @"payload" : payload };
  NSData *bytes = DSHAgentCanonicalJSON(feedback, nil);
  NSString *string = [[NSString alloc] initWithData:bytes
                                           encoding:NSUTF8StringEncoding];
  NSDictionary *facts = [name isEqualToString:@"git_push"]
      ? @{ @"schema_version" : @1, @"kind" : @"git_push",
           @"actual_remote_oid" : precondition[@"target_oid"] }
      : @{ @"schema_version" : @1, @"kind" : @"git_commit",
           @"actual_commit_oid" : precondition[@"expected_commit_oid"] };
  return @{ @"schema_version" : @1, @"status" : @"ok",
            @"feedback" : string, @"settled_facts" : facts,
            @"truncated" : @NO, @"effect_may_have_occurred" : @YES };
}
- (NSDictionary *)recoverToolNamed:(NSString *)name arguments:(NSDictionary *)arguments
                               root:(NSDictionary *)root
                       precondition:(NSDictionary *)precondition
                              error:(NSError **)error {
  (void)arguments; (void)root; (void)error;
  if ([name isEqualToString:@"git_push"]) {
    return @{ @"schema_version" : @1, @"status" : @"settled",
              @"actual_remote_oid" : precondition[@"target_oid"] };
  }
  return @{ @"schema_version" : @1, @"status" : @"settled",
            @"actual_commit_oid" : precondition[@"expected_commit_oid"] };
}
@end

@interface AgentToolEffectsTests : XCTestCase
@property(nonatomic, strong) NSURL *rootURL;
@property(nonatomic, strong) DSHAgentNativeWAL *wal;
@property(nonatomic, strong) DSHAgentTranscriptStore *transcripts;
@property(nonatomic, strong) DSHAgentExecutionLedger *ledger;
@end

@implementation AgentToolEffectsTests

- (void)setUp {
  [super setUp];
  self.rootURL = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:[@"rish-agent-effects-"
          stringByAppendingString:NSUUID.UUID.UUIDString.lowercaseString]]
                                isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:self.rootURL
                                         withIntermediateDirectories:YES
                                                          attributes:nil
                                                               error:nil]);
  self.wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:self.rootURL
      clock:^NSDate * { return [NSDate dateWithTimeIntervalSince1970:1788134400]; }
      identifierGenerator:^NSString * {
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      faultHook:nil];
  self.transcripts = [[DSHAgentTranscriptStore alloc] initWithWAL:self.wal];
  self.ledger = [[DSHAgentExecutionLedger alloc] initWithWAL:self.wal];
}

- (void)tearDown {
  [NSFileManager.defaultManager removeItemAtURL:self.rootURL error:nil];
  [super tearDown];
}

- (void)resetStoresWithFaultHook:(DSHAgentNativeWALFaultHook)faultHook
                              name:(NSString *)name {
  NSURL *root = [self.rootURL URLByAppendingPathComponent:name isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:root
                                         withIntermediateDirectories:YES
                                                          attributes:@{NSFilePosixPermissions : @0700}
                                                               error:nil]);
  self.wal = [[DSHAgentNativeWAL alloc]
      initWithRootURL:root
      clock:^NSDate * { return [NSDate dateWithTimeIntervalSince1970:1788134400]; }
      identifierGenerator:^NSString * {
        return @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      }
      faultHook:faultHook];
  self.transcripts = [[DSHAgentTranscriptStore alloc] initWithWAL:self.wal];
  self.ledger = [[DSHAgentExecutionLedger alloc] initWithWAL:self.wal];
}

- (NSDictionary *)rootWithCapabilities:(NSArray<NSString *> *)capabilities {
  return @{
    @"schema_version" : @1, @"kind" : @"workspace",
    @"workspace_id" : @"11111111-1111-4111-8111-111111111111",
    @"workspace_binding_revision" : @1, @"project_id" : NSNull.null,
    @"root_fingerprint_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    @"capabilities" : capabilities,
  };
}

- (NSDictionary *)projectRootWithCapabilities:(NSArray<NSString *> *)capabilities {
  NSMutableDictionary *root = [[self rootWithCapabilities:capabilities] mutableCopy];
  root[@"kind"] = @"project";
  root[@"project_id"] = @"99999999-9999-4999-8999-999999999999";
  return root;
}

- (BOOL)writeFixtureFileNamed:(NSString *)name
                       content:(NSString *)content
                 repositoryURL:(NSURL *)repositoryURL {
  NSError *error = nil;
  BOOL wrote = [[content dataUsingEncoding:NSUTF8StringEncoding]
      writeToURL:[repositoryURL URLByAppendingPathComponent:name]
         options:NSDataWritingAtomic
           error:&error];
  XCTAssertTrue(wrote, @"fixture write failed: %@", error);
  return wrote;
}

- (NSString *)createFixtureCommitInRepository:(git_repository *)repository
                                        parent:(NSString *)parent
                                       message:(NSString *)message
                               updateMainBranch:(BOOL)updateMainBranch
                              timestampSeconds:(git_time_t)timestampSeconds {
  git_index *index = nullptr;
  git_tree *tree = nullptr;
  git_commit *parentCommit = nullptr;
  git_signature *signature = nullptr;
  git_oid treeOID = {};
  git_oid parentOID = {};
  git_oid commitOID = {};
  int resultCode = git_repository_index(&index, repository);
  if (resultCode == 0) resultCode = git_index_read(index, 1);
  if (resultCode == 0) {
    resultCode = git_index_add_all(index, nullptr, GIT_INDEX_ADD_DEFAULT,
                                   nullptr, nullptr);
  }
  if (resultCode == 0) {
    resultCode = git_index_update_all(index, nullptr, nullptr, nullptr);
  }
  if (resultCode == 0) resultCode = git_index_write(index);
  if (resultCode == 0) {
    resultCode = git_index_write_tree_to(&treeOID, index, repository);
  }
  if (resultCode == 0) resultCode = git_tree_lookup(&tree, repository, &treeOID);
  if (resultCode == 0 && parent != nil) {
    resultCode = git_oid_fromstr(&parentOID, parent.UTF8String);
    if (resultCode == 0) {
      resultCode = git_commit_lookup(&parentCommit, repository, &parentOID);
    }
  }
  if (resultCode == 0) {
    resultCode = git_signature_new(&signature, "Fixture", "fixture@rish.local",
                                   timestampSeconds, 0);
  }
  const git_commit *parents[] = { parentCommit };
  if (resultCode == 0) {
    resultCode = git_commit_create(
        &commitOID, repository,
        updateMainBranch ? "refs/heads/main" : nullptr,
        signature, signature, "UTF-8", message.UTF8String, tree,
        parentCommit == nullptr ? 0 : 1,
        parentCommit == nullptr ? nullptr : parents);
  }
  if (signature != nullptr) git_signature_free(signature);
  if (parentCommit != nullptr) git_commit_free(parentCommit);
  if (tree != nullptr) git_tree_free(tree);
  if (index != nullptr) git_index_free(index);
  XCTAssertEqual(resultCode, 0, @"fixture commit failed: %d", resultCode);
  if (resultCode != 0) return nil;
  char oid[41] = {};
  git_oid_tostr(oid, sizeof(oid), &commitOID);
  return [NSString stringWithUTF8String:oid];
}

- (NSString *)referenceOIDNamed:(NSString *)referenceName
                 repositoryURL:(NSURL *)repositoryURL {
  git_repository *repository = nullptr;
  git_oid oid = {};
  int resultCode = git_repository_open(&repository,
                                        repositoryURL.fileSystemRepresentation);
  if (resultCode == 0) {
    resultCode = git_reference_name_to_id(&oid, repository,
                                          referenceName.UTF8String);
  }
  if (repository != nullptr) git_repository_free(repository);
  if (resultCode != 0) return nil;
  char value[41] = {};
  git_oid_tostr(value, sizeof(value), &oid);
  return [NSString stringWithUTF8String:value];
}

- (NSDictionary *)realGitExecutorFixtureNamed:(NSString *)name
                                      projectID:(NSString *)projectID {
  NSURL *fixtureRoot = [self.rootURL URLByAppendingPathComponent:name
                                                      isDirectory:YES];
  NSURL *projectsURL = [fixtureRoot URLByAppendingPathComponent:@"projects"
                                                     isDirectory:YES];
  NSURL *projectURL = [projectsURL URLByAppendingPathComponent:projectID
                                                   isDirectory:YES];
  NSURL *repositoryURL = [projectURL URLByAppendingPathComponent:@"repo"
                                                      isDirectory:YES];
  NSURL *originURL = [fixtureRoot URLByAppendingPathComponent:@"origin.git"
                                                    isDirectory:YES];
  NSError *error = nil;
  XCTAssertTrue([NSFileManager.defaultManager
      createDirectoryAtURL:repositoryURL
      withIntermediateDirectories:YES
      attributes:@{ NSFilePosixPermissions : @0700 }
      error:&error]);
  XCTAssertNil(error);
  DSHLocalProjectAccess *projectAccess = [[DSHLocalProjectAccess alloc]
      initWithProjectsRootURL:projectsURL];
  git_repository *repository = nullptr;
  git_repository *origin = nullptr;
  XCTAssertEqual(git_repository_init(&repository,
                                     repositoryURL.fileSystemRepresentation, 0),
                 0);
  XCTAssertNotEqual(repository, nullptr);
  XCTAssertEqual(git_repository_init(&origin,
                                     originURL.fileSystemRepresentation, 1),
                 0);
  XCTAssertNotEqual(origin, nullptr);
  if (repository == nullptr || origin == nullptr) {
    if (repository != nullptr) git_repository_free(repository);
    if (origin != nullptr) git_repository_free(origin);
    return nil;
  }
  XCTAssertEqual(git_repository_set_head(repository, "refs/heads/main"), 0);
  XCTAssertTrue([self writeFixtureFileNamed:@"README.md" content:@"base\n"
                              repositoryURL:repositoryURL]);
  NSString *baseOID = [self createFixtureCommitInRepository:repository
                                                     parent:nil
                                                    message:@"base"
                                            updateMainBranch:YES
                                           timestampSeconds:1];
  git_remote *remote = nullptr;
  int resultCode = git_remote_create(&remote, repository, "origin",
                                     originURL.fileSystemRepresentation);
  git_push_options seedOptions = {};
  if (resultCode == 0) {
    resultCode = git_push_options_init(&seedOptions, GIT_PUSH_OPTIONS_VERSION);
  }
  seedOptions.proxy_opts.type = GIT_PROXY_NONE;
  seedOptions.follow_redirects = GIT_REMOTE_REDIRECT_NONE;
  char seedRefspec[] = "refs/heads/main:refs/heads/main";
  char *seedValues[] = { seedRefspec };
  git_strarray seedRefs = { seedValues, 1 };
  if (resultCode == 0) {
    resultCode = git_remote_push(remote, &seedRefs, &seedOptions);
  }
  XCTAssertEqual(resultCode, 0, @"origin seed failed: %d", resultCode);
  if (remote != nullptr) git_remote_free(remote);
  git_repository_free(origin);
  git_repository_free(repository);
  if (baseOID == nil || resultCode != 0) return nil;

  NSDictionary *root = @{
    @"schema_version" : @1, @"kind" : @"project",
    @"workspace_id" : @"11111111-1111-4111-8111-111111111111",
    @"workspace_binding_revision" : @1, @"project_id" : projectID,
    @"root_fingerprint_sha256" :
        @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    @"capabilities" : @[@"git_status", @"git_commit", @"git_push"],
  };
  AgentEffectsProjectLeaseResolver *resolver =
      [[AgentEffectsProjectLeaseResolver alloc]
          initWithProjectAccess:projectAccess root:root];
  DSHAgentGitToolExecutor *executor = [[DSHAgentGitToolExecutor alloc]
      initWithRootResolver:resolver];
  return @{ @"executor" : executor, @"resolver" : resolver,
            @"root" : root, @"repository_url" : repositoryURL,
            @"origin_url" : originURL, @"base_oid" : baseOID };
}

- (NSDictionary *)feedbackObject:(NSDictionary *)effect {
  NSError *error = nil;
  NSData *data = [effect[@"feedback"] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *feedback = data == nil ? nil :
      [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  XCTAssertNotNil(feedback);
  XCTAssertNil(error);
  return feedback;
}

- (NSDictionary *)policyWithBatch:(NSUInteger)batch attempt:(NSUInteger)attempt {
  return @{
    @"schema_version" : @1, @"policy_version" : @"agent-v1",
    @"max_single_write_bytes" : @32768,
    @"max_batch_write_bytes" : @(batch),
    @"max_attempt_write_bytes" : @(attempt),
  };
}

- (NSDictionary *)loadResultForSession:(NSDictionary *)session
                              generation:(NSNumber *)generation
                                  digest:(NSString *)digest {
  NSData *bytes = DSHAgentCanonicalJSON(session, nil);
  return @{ @"schema_version" : @1, @"status" : @"present",
            @"snapshot" : @{ @"schema_version" : @1,
                              @"generation" : generation,
                              @"session_sha256" : digest },
            @"session_json" : [[NSString alloc] initWithData:bytes
                                                     encoding:NSUTF8StringEncoding] };
}

- (NSDictionary *)serviceFixtureForRawCalls:(NSArray<NSDictionary *> *)rawCalls {
  NSString *task = @"10101010-1010-4010-8010-101010101010";
  NSString *attempt = @"20202020-2020-4020-8020-202020202020";
  NSString *conversation = @"30303030-3030-4030-8030-303030303030";
  NSString *roundID = @"40404040-4040-4040-8040-404040404040";
  NSString *authorityOperation = @"50505050-5050-4050-8050-505050505050";
  NSString *sessionDigest =
      @"abababababababababababababababababababababababababababababababab";
  NSMutableSet *capabilities = [NSMutableSet set];
  for (NSDictionary *call in rawCalls) {
    NSString *name = call[@"name"];
    if ([name isEqualToString:@"write_file"]) [capabilities addObject:@"file_write"];
    if ([name isEqualToString:@"read_file"] || [name isEqualToString:@"list_dir"])
      [capabilities addObject:@"file_read"];
    if ([name hasPrefix:@"git_"]) [capabilities addObject:name];
  }
  NSDictionary *root = [self projectRootWithCapabilities:
      [[capabilities allObjects] sortedArrayUsingSelector:@selector(compare:)]];
  NSError *error = nil;
  NSDictionary *before = [self.transcripts createAgentTranscriptWithRequest:@{
    @"schema_version" : @1, @"attempt_id" : attempt, @"root" : root,
  } error:&error];
  XCTAssertNotNil(before);
  NSMutableArray *assistantCalls = [NSMutableArray arrayWithCapacity:rawCalls.count];
  for (NSDictionary *raw in rawCalls) {
    [assistantCalls addObject:@{ @"schema_version" : @1,
      @"call_id" : raw[@"call_id"], @"name" : raw[@"name"],
      @"arguments_json" : raw[@"arguments_json"] }];
  }
  NSDictionary *after = [self.transcripts appendAssistantMessage:@{
    @"schema_version" : @1, @"role" : @"assistant", @"round_index" : @0,
    @"content" : @"", @"reasoning_content" : @"", @"tool_calls" : assistantCalls,
  } expectedTranscript:before root:root attemptId:attempt error:&error];
  XCTAssertNotNil(after);
  DSHAgentToolRegistry *toolRegistry = [[DSHAgentToolRegistry alloc] init];
  NSDictionary *registry = [toolRegistry registryForRoot:root error:&error];
  NSDictionary *policy = [toolRegistry policyForRoot:root error:&error];
  NSString *now = [self.wal currentTimestamp];
  NSDictionary *authority = @{
    @"schema_version" : @2, @"task_id" : task,
    @"conversation_id" : conversation, @"attempt_id" : attempt,
    @"root" : root, @"policy" : policy, @"registry" : registry,
    @"transport_schema_version" : @2, @"model" : @"deepseek-v4-flash",
    @"thinking_mode" : @"off", @"visible_message_ids" : @[],
    @"visible_history_sha256" :
        @"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    @"visible_message_count" : @0, @"project_context_sha256" : NSNull.null,
    @"transcript" : after, @"reserved_write_bytes" : @0,
    @"authority_revision" : @1, @"state" : @"prepared",
    @"cleanup_id" : NSNull.null, @"created_at" : now, @"updated_at" : now,
  };
  NSDictionary *authorityRequest = @{
    @"schema_version" : @2, @"operation_id" : authorityOperation,
    @"task_id" : task, @"conversation_id" : conversation,
    @"attempt_id" : attempt,
  };
  NSDictionary *authoritySafe = @{
    @"schema_version" : @2, @"result_kind" : @"prepare_agent_attempt",
    @"result" : @{ @"schema_version" : @2, @"status" : @"prepared",
                    @"operation_id" : authorityOperation },
  };
  XCTAssertNotNil(DSHAgentNativeWALPrepareAuthorityOperation(
      self.wal, authority, authorityRequest, authoritySafe, &error));

  NSMutableArray *presentations = [NSMutableArray array];
  for (NSUInteger index = 0; index < rawCalls.count; index += 1) {
    NSDictionary *raw = rawCalls[index];
    NSDictionary *descriptor = [toolRegistry descriptorForToolName:raw[@"name"]
                                                               root:root error:&error];
    [presentations addObject:@{
      @"schema_version" : @3, @"call_index" : @(index),
      @"call_id" : raw[@"call_id"], @"name" : raw[@"name"],
      @"arguments_sha256" : raw[@"arguments_sha256"] ?:
          DSHAgentArgumentsSHA256(raw[@"name"], raw[@"arguments_json"], &error),
      @"safe_summary_key" : descriptor[@"safe_summary_key"],
      @"access" : descriptor[@"access"], @"approval_state" : @"deferred",
    }];
  }
  NSDictionary *roundLocator = @{
    @"schema_version" : @1, @"task_id" : task, @"attempt_id" : attempt,
    @"round_id" : roundID, @"round_index" : @0,
  };
  NSDictionary *completionReceipt = @{
    @"schema_version" : @1, @"transport_schema_version" : @2,
    @"turn_id" : task, @"attempt_id" : attempt, @"round_id" : roundID,
    @"round_index" : @0, @"provider_request_id" : @"req-1",
    @"provider_response_id" : @"res-1",
    @"requested_model" : @"deepseek-v4-flash",
    @"model" : @"deepseek-v4-flash", @"thinking_mode" : @"off",
    @"finish_reason" : @"tool_calls", @"latency_ms" : @1,
    @"visible_history_sha256" : authority[@"visible_history_sha256"],
    @"model_input_sha256" :
        @"dededededededededededededededededededededededededededededededede",
    @"request_body_sha256" :
        @"efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    @"project_context_receipt" : NSNull.null,
  };
  NSDictionary *round = @{
    @"schema_version" : @3, @"locator" : roundLocator, @"row_revision" : @1,
    @"root_fingerprint_sha256" : root[@"root_fingerprint_sha256"],
    @"binding_revision" : root[@"workspace_binding_revision"],
    @"request_sha256" :
        @"1212121212121212121212121212121212121212121212121212121212121212",
    @"transcript_before" : before, @"launch_attempt" : @1,
    @"state" : @"completed", @"owner" : NSNull.null,
    @"failure_code" : NSNull.null, @"completion_receipt" : completionReceipt,
    @"transcript_after" : after, @"calls" : presentations,
    @"batch_class" : @"executable",
    @"executable_call_count" : @(rawCalls.count), @"denied_call_count" : @0,
    @"terminal_kind" : @"tool_batch", @"created_at" : now, @"updated_at" : now,
  };
  BOOL roundCommitted = [self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    (void)mutationError;
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    [rounds addObject:round];
    NSMutableArray *dispatch = [state[@"dispatch"] mutableCopy];
    [dispatch addObject:@{ @"schema_version" : @1, @"kind" : @"round",
                           @"locator" : roundLocator,
                           @"dispatch_state" : @"dispatched" }];
    state[@"rounds"] = rounds;
    state[@"dispatch"] = dispatch;
    return YES;
  } error:&error];
  XCTAssertTrue(roundCommitted);

  NSDictionary *baseSession = @{
    @"schema_version" : @9,
    @"conversations" : @[@{ @"id" : conversation, @"agent_grants" : @[],
      @"attempts" : @[@{ @"attempt_id" : attempt, @"journal_revision" : @1,
                          @"agent" : NSNull.null }] }],
    @"session_events" : @[],
  };
  AgentEffectsSessionStore *sessionStore = [[AgentEffectsSessionStore alloc]
      initWithLoadResult:[self loadResultForSession:baseSession generation:@3
                                             digest:sessionDigest]];
  AgentEffectsRootResolver *resolver = [[AgentEffectsRootResolver alloc]
      initWithRoot:root];
  AgentEffectsPreparedStore *preparedStore = [[AgentEffectsPreparedStore alloc]
      initWithWAL:self.wal rootResolver:resolver sessionSnapshotStore:sessionStore
      transcriptStore:self.transcripts];
  AgentEffectsWorkspaceExecutor *workspace = [[AgentEffectsWorkspaceExecutor alloc]
      initWithRootResolver:resolver];
  AgentEffectsGitExecutor *git = [[AgentEffectsGitExecutor alloc]
      initWithRootResolver:resolver];
  DSHAgentToolBatchService *batchService = [[DSHAgentToolBatchService alloc]
      initWithWAL:self.wal ledger:self.ledger preparedStore:preparedStore
      transcripts:self.transcripts workspaceExecutor:workspace gitExecutor:git];
  NSDictionary *checkpoint = @{ @"schema_version" : @1, @"journal_revision" : @1,
    @"session_generation" : @3, @"session_sha256" : sessionDigest };
  NSDictionary *controller = @{ @"schema_version" : @1,
    @"conversation_id" : conversation, @"task_id" : task,
    @"attempt_id" : attempt, @"expected_controller_generation" : @1,
    @"expected_journal_revision" : @1, @"expected_session_generation" : @3,
    @"expected_session_sha256" : sessionDigest };
  NSDictionary *batchRequest = @{ @"schema_version" : @2,
    @"operation_id" : @"60606060-6060-4060-8060-606060606060",
    @"controller_cas" : controller, @"committed_checkpoint" : checkpoint,
    @"task_id" : task, @"conversation_id" : conversation,
    @"attempt_id" : attempt, @"round_id" : roundID, @"round_index" : @0,
    @"expected_round_revision" : @1, @"transcript" : after, @"root" : root,
    @"registry_version" : @1, @"toolset_sha256" : registry[@"toolset_sha256"],
    @"policy_version" : @"agent-v1", @"expected_batch_revision" : @0,
    @"expected_reserved_write_bytes" : @0 };
  return @{ @"root" : root, @"task" : task, @"attempt" : attempt,
            @"conversation" : conversation, @"round_id" : roundID,
            @"transcript" : after, @"transcript_before" : before,
            @"registry" : registry,
            @"session_store" : sessionStore, @"prepared_store" : preparedStore,
            @"resolver" : resolver, @"workspace_executor" : workspace,
            @"git_executor" : git, @"batch_service" : batchService,
            @"batch_request" : batchRequest, @"controller" : controller,
            @"checkpoint" : checkpoint };
}

- (NSDictionary *)transcriptForRoot:(NSDictionary *)root {
  NSError *error = nil;
  NSDictionary *transcript = [self.transcripts createAgentTranscriptWithRequest:@{
    @"schema_version" : @1,
    @"attempt_id" : @"22222222-2222-4222-8222-222222222222",
    @"root" : root,
  } error:&error];
  XCTAssertNotNil(transcript);
  XCTAssertNil(error);
  return transcript;
}

- (NSDictionary *)batchRequestWithRoot:(NSDictionary *)root
                              transcript:(NSDictionary *)transcript
                                   calls:(NSArray<NSDictionary *> *)calls
                                  policy:(NSDictionary *)policy
                              roundIndex:(NSUInteger)roundIndex {
  return @{
    @"schema_version" : @2,
    @"task_id" : @"33333333-3333-4333-8333-333333333333",
    @"attempt_id" : @"22222222-2222-4222-8222-222222222222",
    @"round_id" : @"44444444-4444-4444-8444-444444444444",
    @"round_index" : @(roundIndex), @"round_revision" : @1,
    @"root" : root, @"transcript" : transcript, @"policy" : policy,
    @"expected_batch_revision" : @0,
    @"expected_reserved_write_bytes" : @0, @"calls" : calls,
  };
}

- (NSDictionary *)readCallAtIndex:(NSUInteger)index
                              name:(NSString *)name
                         arguments:(NSString *)arguments
                      precondition:(NSDictionary *)precondition {
  NSError *error = nil;
  NSString *digest = DSHAgentArgumentsSHA256(name, arguments, &error);
  XCTAssertNotNil(digest);
  XCTAssertNil(error);
  return @{
    @"call_index" : @(index),
    @"call_id" : [NSString stringWithFormat:@"call_%lu", (unsigned long)index],
    @"name" : name, @"arguments_json" : arguments,
    @"arguments_sha256" : digest,
    @"safe_summary_key" : [@"agent." stringByAppendingString:name],
    @"access" : @"auto", @"precondition" : precondition,
    @"reserved_write_bytes" : @0,
  };
}

- (void)testWholeReadOnlyBatchCreatesOrderedIntentsWithoutWriteReservation {
  NSDictionary *root = [self rootWithCapabilities:@[@"file_read"]];
  NSDictionary *transcript = [self transcriptForRoot:root];
  NSArray *calls = @[
    [self readCallAtIndex:0 name:@"list_dir" arguments:@"{}"
             precondition:@{
               @"schema_version" : @1, @"kind" : @"list_dir",
               @"directory_fingerprint_sha256" :
                   @"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
             }],
    [self readCallAtIndex:1 name:@"read_file"
                arguments:@"{\"path\":\"README.md\"}"
             precondition:@{
               @"schema_version" : @1, @"kind" : @"read_file",
               @"source_revision" : @"1:2:3:4:5",
             }],
  ];
  NSError *error = nil;
  NSDictionary *result = [self.ledger prepareAgentToolBatchWithRequest:
      [self batchRequestWithRoot:root transcript:transcript calls:calls
                           policy:[self policyWithBatch:32768 attempt:65536]
                       roundIndex:0] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"prepared");
  XCTAssertEqualObjects(result[@"batch_kind"], @"read_only_batch");
  XCTAssertEqualObjects(result[@"manifest_sha256"], NSNull.null);
  XCTAssertEqualObjects(result[@"effect_gate"], @"not_applicable");
  XCTAssertEqualObjects(result[@"reserved_write_bytes"], @0);
  XCTAssertEqual([result[@"calls"] count], 2U);

  NSDictionary *snapshot = [self.wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqual([snapshot[@"ledger"] count], 2U);
  XCTAssertEqual([snapshot[@"batches"] count], 1U);
  XCTAssertEqual([snapshot[@"reservations"] count], 0U);
  XCTAssertEqualObjects(snapshot[@"batches"][0][@"schema_version"], @2);
  XCTAssertEqualObjects(snapshot[@"batches"][0][@"kind"], @"read_only_batch");
}

- (void)testBatchAuthorityFollowsLatestCommittedBatchWithoutAssumingMonotonicity {
  NSDictionary *root = [self projectRootWithCapabilities:@[
    @"file_read", @"file_write",
  ]];
  NSDictionary *transcript = [self transcriptForRoot:root];
  NSDictionary *policy = [self policyWithBatch:32768 attempt:65536];
  NSError *error = nil;

  NSMutableDictionary *first = [[self batchRequestWithRoot:root
      transcript:transcript
      calls:@[[self writeCallAtIndex:0 path:@"first.txt" content:@"hello"]]
      policy:policy roundIndex:0] mutableCopy];
  NSDictionary *firstResult = [self.ledger
      prepareAgentToolBatchWithRequest:first error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(firstResult[@"status"], @"prepared");
  XCTAssertEqualObjects(firstResult[@"batch_kind"], @"write_batch");
  XCTAssertEqualObjects(firstResult[@"batch_revision"], @1);
  XCTAssertEqualObjects(firstResult[@"reserved_write_bytes"], @5);

  NSDictionary *readCall = [self readCallAtIndex:0 name:@"read_file"
      arguments:@"{\"path\":\"first.txt\"}"
      precondition:@{ @"schema_version" : @1, @"kind" : @"read_file",
                      @"source_revision" : @"r1" }];
  NSMutableDictionary *second = [[self batchRequestWithRoot:root
      transcript:transcript calls:@[readCall] policy:policy roundIndex:1]
      mutableCopy];
  second[@"round_id"] = @"55555555-5555-4555-8555-555555555555";
  second[@"round_revision"] = @7;
  second[@"expected_reserved_write_bytes"] = @5;

  NSMutableDictionary *stale = [second mutableCopy];
  stale[@"expected_batch_revision"] = @0;
  XCTAssertNil([self.ledger prepareAgentToolBatchWithRequest:stale error:&error]);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorConflict);
  NSDictionary *afterStale = [self.wal snapshotWithError:nil];
  XCTAssertEqual([afterStale[@"batches"] count], 1U);
  XCTAssertEqual([afterStale[@"ledger"] count], 1U);

  error = nil;
  NSMutableDictionary *wrong = [second mutableCopy];
  wrong[@"expected_batch_revision"] = @2;
  XCTAssertNil([self.ledger prepareAgentToolBatchWithRequest:wrong error:&error]);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorConflict);
  NSDictionary *afterWrong = [self.wal snapshotWithError:nil];
  XCTAssertEqual([afterWrong[@"batches"] count], 1U);
  XCTAssertEqual([afterWrong[@"ledger"] count], 1U);

  error = nil;
  second[@"expected_batch_revision"] = @1;
  NSDictionary *secondResult = [self.ledger
      prepareAgentToolBatchWithRequest:second error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(secondResult[@"status"], @"prepared");
  XCTAssertEqualObjects(secondResult[@"batch_kind"], @"read_only_batch");
  XCTAssertEqualObjects(secondResult[@"batch_revision"], @7);
  XCTAssertEqualObjects(secondResult[@"reserved_write_bytes"], @5);

  // The next mutation consumes the latest opaque authority (7), but its own
  // reservation revision is 2. This intentionally demonstrates why max() or
  // an increment assumption would reject a valid later round.
  NSMutableDictionary *third = [[self batchRequestWithRoot:root
      transcript:transcript
      calls:@[[self writeCallAtIndex:0 path:@"second.txt" content:@"world"]]
      policy:policy roundIndex:2] mutableCopy];
  third[@"round_id"] = @"66666666-6666-4666-8666-666666666666";
  third[@"expected_batch_revision"] = @7;
  third[@"expected_reserved_write_bytes"] = @5;
  NSDictionary *thirdResult = [self.ledger
      prepareAgentToolBatchWithRequest:third error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(thirdResult[@"status"], @"prepared");
  XCTAssertEqualObjects(thirdResult[@"batch_kind"], @"write_batch");
  XCTAssertEqualObjects(thirdResult[@"batch_revision"], @2);
  XCTAssertEqualObjects(thirdResult[@"reserved_write_bytes"], @10);
}

- (NSDictionary *)writeCallAtIndex:(NSUInteger)index
                               path:(NSString *)path
                            content:(NSString *)content {
  NSDictionary *argumentsObject = @{
    @"path" : path, @"content" : content,
    @"expected_prior" : @{ @"schema_version" : @1, @"kind" : @"absent" },
  };
  NSError *error = nil;
  NSData *argumentsBytes = DSHAgentCanonicalJSON(argumentsObject, &error);
  NSString *arguments = [[NSString alloc] initWithData:argumentsBytes
                                               encoding:NSUTF8StringEncoding];
  NSData *pathBytes = [path dataUsingEncoding:NSUTF8StringEncoding];
  NSData *contentBytes = [content dataUsingEncoding:NSUTF8StringEncoding];
  NSString *pathDigest = DSHAgentHB(@"relative-path", pathBytes, &error);
  NSString *contentDigest = DSHAgentHB(@"file-content", contentBytes, &error);
  NSString *argumentsDigest = DSHAgentArgumentsSHA256(@"write_file", arguments,
                                                       &error);
  XCTAssertNil(error);
  return @{
    @"call_index" : @(index),
    @"call_id" : [NSString stringWithFormat:@"write_%lu", (unsigned long)index],
    @"name" : @"write_file", @"arguments_json" : arguments,
    @"arguments_sha256" : argumentsDigest,
    @"safe_summary_key" : @"agent.write_file",
    @"access" : @"conversation_confirm",
    @"precondition" : @{
      @"schema_version" : @2, @"kind" : @"write_file",
      @"relative_path_sha256" : pathDigest,
      @"prior" : argumentsObject[@"expected_prior"],
      @"content_sha256" : contentDigest,
      @"content_bytes" : @(contentBytes.length),
    },
    @"reserved_write_bytes" : @(contentBytes.length),
  };
}

- (NSDictionary *)gitCommitCallAtIndex:(NSUInteger)index {
  NSError *error = nil;
  NSString *arguments = @"{\"message\":\"m\"}";
  NSData *message = [@"m" dataUsingEncoding:NSUTF8StringEncoding];
  NSString *messageSHA = DSHAgentHB(@"commit-message", message, &error);
  NSDictionary *identity = @{
    @"schema_version" : @1, @"name" : @"Rish Agent",
    @"email" : @"agent@rish.local", @"timestamp_seconds" : @1,
    @"timezone_offset" : @"+0000",
  };
  return @{
    @"call_index" : @(index),
    @"call_id" : [NSString stringWithFormat:@"commit_%lu", (unsigned long)index],
    @"name" : @"git_commit", @"arguments_json" : arguments,
    @"arguments_sha256" : DSHAgentArgumentsSHA256(@"git_commit", arguments, &error),
    @"safe_summary_key" : @"agent.git_commit",
    @"access" : @"conversation_confirm",
    @"precondition" : @{
      @"schema_version" : @2, @"kind" : @"git_commit",
      @"object_format" : @"sha1", @"pre_head_oid" : NSNull.null,
      @"ordered_parent_oids" : @[],
      @"staged_index_sha256" :
          @"1111111111111111111111111111111111111111111111111111111111111111",
      @"tree_oid" : @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      @"author" : identity, @"committer" : identity,
      @"message_blob_ref" : messageSHA, @"message_sha256" : messageSHA,
      @"message_bytes" : @1, @"encoding_header" : @"UTF-8",
      @"signature_policy" : @"unsigned", @"extra_headers" : @[],
      @"stage_all" : @YES,
      @"commit_payload_sha256" :
          @"2222222222222222222222222222222222222222222222222222222222222222",
      @"expected_commit_oid" : @"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    @"reserved_write_bytes" : @0,
  };
}

- (NSDictionary *)gitPushCallAtIndex:(NSUInteger)index {
  NSError *error = nil;
  return @{
    @"call_index" : @(index),
    @"call_id" : [NSString stringWithFormat:@"push_%lu", (unsigned long)index],
    @"name" : @"git_push", @"arguments_json" : @"{}",
    @"arguments_sha256" : DSHAgentArgumentsSHA256(@"git_push", @"{}", &error),
    @"safe_summary_key" : @"agent.git_push", @"access" : @"confirm_once",
    @"precondition" : @{
      @"schema_version" : @1, @"kind" : @"git_push", @"remote" : @"origin",
      @"remote_ref" : @"refs/heads/main", @"pre_remote_oid" : NSNull.null,
      @"target_oid" : @"cccccccccccccccccccccccccccccccccccccccc",
    },
    @"reserved_write_bytes" : @0,
  };
}

- (void)testGitOnlyAndMixedMutationBatchesUseOneClosedGate {
  NSDictionary *root = [self projectRootWithCapabilities:@[
    @"file_read", @"file_write", @"git_commit", @"git_push",
  ]];
  NSDictionary *transcript = [self transcriptForRoot:root];
  NSError *error = nil;
  NSDictionary *gitOnly = [self.ledger prepareAgentToolBatchWithRequest:
      [self batchRequestWithRoot:root transcript:transcript
                           calls:@[[self gitCommitCallAtIndex:0]]
                          policy:[self policyWithBatch:32768 attempt:65536]
                      roundIndex:0] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(gitOnly[@"batch_kind"], @"write_batch");
  XCTAssertEqualObjects(gitOnly[@"batch_new_write_bytes"], @0);
  XCTAssertEqualObjects(gitOnly[@"reserved_write_bytes"], @0);
  XCTAssertEqualObjects(gitOnly[@"batch_revision"], @1);
  XCTAssertEqualObjects(gitOnly[@"effect_gate"], @"closed");
  NSDictionary *snapshot = [self.wal snapshotWithError:&error];
  NSDictionary *gitBatch = snapshot[@"batches"][0];
  XCTAssertEqualObjects(gitBatch[@"manifest_calls"][0][@"mutation_kind"],
                        @"git_commit");
  XCTAssertEqualObjects(gitBatch[@"manifest_calls"][0][@"content_bytes"], @0);
  XCTAssertNotNil(gitBatch[@"manifest_calls"][0][@"precondition_sha256"]);
  XCTAssertEqualObjects(snapshot[@"reservations"][0][@"reservation_version"], @1);
  XCTAssertEqual([snapshot[@"reservations"][0][@"keys"] count], 0U);

  // A fresh attempt exercises original call order: read, Git mutation, file mutation.
  NSDictionary *root2 = [self projectRootWithCapabilities:@[
    @"file_read", @"file_write", @"git_push",
  ]];
  NSMutableDictionary *root2Mutable = [root2 mutableCopy];
  root2Mutable[@"root_fingerprint_sha256"] =
      @"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  NSDictionary *transcript2 = [self.transcripts createAgentTranscriptWithRequest:@{
    @"schema_version" : @1,
    @"attempt_id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"root" : root2Mutable,
  } error:&error];
  NSArray *mixedCalls = @[
    [self readCallAtIndex:0 name:@"read_file"
                arguments:@"{\"path\":\"README.md\"}"
             precondition:@{ @"schema_version" : @1, @"kind" : @"read_file",
                              @"source_revision" : @"r1" }],
    [self gitPushCallAtIndex:1],
    [self writeCallAtIndex:2 path:@"a.txt" content:@"hello"],
  ];
  NSMutableDictionary *mixedRequest = [[self batchRequestWithRoot:root2Mutable
      transcript:transcript2 calls:mixedCalls
      policy:[self policyWithBatch:32768 attempt:65536] roundIndex:1] mutableCopy];
  mixedRequest[@"attempt_id"] = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  mixedRequest[@"task_id"] = @"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  mixedRequest[@"round_id"] = @"ffffffff-ffff-4fff-8fff-ffffffffffff";
  NSDictionary *mixed = [self.ledger prepareAgentToolBatchWithRequest:mixedRequest
                                                                 error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(mixed[@"batch_kind"], @"write_batch");
  snapshot = [self.wal snapshotWithError:&error];
  NSDictionary *mixedBatch = snapshot[@"batches"][1];
  XCTAssertEqualObjects([mixedBatch[@"manifest_calls"] valueForKey:@"mutation_kind"],
                        (@[@"git_push", @"file_write"]));
  XCTAssertEqualObjects(
      [mixedBatch[@"manifest_calls"] valueForKeyPath:@"locator.call_index"],
      (@[@1, @2]));
  XCTAssertEqualObjects(mixedBatch[@"reservation_delta_bytes"], @5);
  XCTAssertEqualObjects(mixedBatch[@"effect_gate"], @"closed");
}

- (void)testAuthorityAdvanceRejectsFullRootWithUnboundCapabilityBits {
  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  NSError *error = nil;
  NSDictionary *before = [self.wal snapshotWithError:&error];
  XCTAssertNil(error);
  NSDictionary *authority = before[@"authorities"][0];
  XCTAssertEqualObjects(authority[@"authority_revision"], @1);

  // Preserve the fingerprint and binding revision while changing one full-root
  // authority bit.  A full root is an exact projection; it must not fall back
  // to the two-field private root expectation accepted by ledger row CAS.
  NSMutableDictionary *tamperedRoot = [fixture[@"root"] mutableCopy];
  tamperedRoot[@"capabilities"] = @[@"file_read", @"git_commit"];
  NSDictionary *request = @{
    @"schema_version" : @2,
    @"task_id" : fixture[@"task"],
    @"attempt_id" : fixture[@"attempt"],
    @"round_id" : fixture[@"round_id"],
    @"round_index" : @0,
    @"round_revision" : @1,
    @"root" : tamperedRoot,
    @"transcript" : fixture[@"transcript"],
    @"policy" : authority[@"policy"],
    @"expected_batch_revision" : @0,
    @"expected_reserved_write_bytes" : @0,
    @"calls" : @[[self gitCommitCallAtIndex:0]],
  };
  NSDictionary *result = [self.ledger prepareAgentToolBatchWithRequest:request
                                                                  error:&error];
  XCTAssertNil(result);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorConflict);
  NSDictionary *after = [self.wal snapshotWithError:nil];
  XCTAssertEqual([after[@"batches"] count], 0U);
  XCTAssertEqual([after[@"ledger"] count], 0U);
  XCTAssertEqualObjects(after[@"authorities"][0][@"authority_revision"], @1);
  XCTAssertEqualObjects(after[@"authorities"][0][@"root"], fixture[@"root"]);
}

- (void)testStartedBatchReplayHoldsFinalGuardAndAdvancesExactAuthorityFieldsOnce {
  __block BOOL captureGuardStages = NO;
  __block BOOL sawResultCommitWithGuard = NO;
  __block BOOL sawWALPrepareWithGuard = NO;
  __block AgentEffectsRootResolver *observedResolver = nil;
  [self resetStoresWithFaultHook:^BOOL(NSString *stage) {
    if (captureGuardStages && observedResolver.guardAlive) {
      if ([stage isEqualToString:@"wal.operation.before_result_commit"]) {
        sawResultCommitWithGuard = YES;
      }
      if ([stage isEqualToString:@"wal.before_prepare"]) {
        sawWALPrepareWithGuard = YES;
      }
    }
    return YES;
  } name:@"authority-guard-runtime"];

  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  observedResolver = fixture[@"resolver"];
  NSDictionary *before = [self.wal snapshotWithError:nil];
  NSDictionary *beforeAuthority = before[@"authorities"][0];
  NSDictionary *request = fixture[@"batch_request"];
  NSError *error = nil;
  NSDictionary *started = DSHAgentNativeWALStartOperation(
      self.wal, @"prepare_agent_tool_batch", request, fixture[@"task"],
      fixture[@"attempt"], beforeAuthority[@"authority_revision"], &error);
  XCTAssertNil(error);
  XCTAssertEqualObjects(started[@"status"], @"started");

  captureGuardStages = YES;
  NSDictionary *prepared = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:request error:&error];
  captureGuardStages = NO;
  XCTAssertNil(error);
  XCTAssertEqualObjects(prepared[@"status"], @"prepared");
  XCTAssertTrue(sawResultCommitWithGuard);
  XCTAssertTrue(sawWALPrepareWithGuard);
  XCTAssertGreaterThan(observedResolver.guardValidationCount, 0U);
  XCTAssertFalse(observedResolver.guardAlive);

  NSDictionary *after = [self.wal snapshotWithError:&error];
  XCTAssertNil(error);
  NSDictionary *afterAuthority = after[@"authorities"][0];
  XCTAssertEqualObjects(afterAuthority[@"authority_revision"], @2);
  XCTAssertEqualObjects(afterAuthority[@"root"], beforeAuthority[@"root"]);
  XCTAssertEqualObjects(afterAuthority[@"policy"], beforeAuthority[@"policy"]);
  XCTAssertEqualObjects(afterAuthority[@"registry"], beforeAuthority[@"registry"]);
  XCTAssertEqualObjects(afterAuthority[@"reserved_write_bytes"], @0);
  XCTAssertEqualObjects(afterAuthority[@"transcript"], prepared[@"receipt"][@"transcript"]);
  NSDictionary *operation = [after[@"operations"] filteredArrayUsingPredicate:
      [NSPredicate predicateWithFormat:@"operation_id == %@", request[@"operation_id"]]]
      .firstObject;
  XCTAssertEqualObjects(operation[@"state"], @"committed");
  XCTAssertEqualObjects(operation[@"authority_revision"], @1);

  NSUInteger guardValidations = observedResolver.guardValidationCount;
  observedResolver.rejectRoot = YES;
  NSDictionary *replayed = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:request error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(replayed, prepared);
  XCTAssertEqual(observedResolver.guardValidationCount, guardValidations);
  NSDictionary *replayState = [self.wal snapshotWithError:nil];
  XCTAssertEqualObjects(replayState[@"authorities"][0], afterAuthority);
  XCTAssertEqual([replayState[@"batches"] count], 1U);
  XCTAssertEqual([replayState[@"ledger"] count], 1U);
}

- (void)testBatchFinalAuthorityAcceptsSameTranscriptRefAdvancingGeneration {
  NSDictionary *rawRead = @{ @"schema_version" : @1,
    @"call_id" : @"read-call", @"name" : @"read_file",
    @"arguments_json" : @"{\"path\":\"README.md\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawRead]];
  AgentEffectsPreparedStore *preparedStore = fixture[@"prepared_store"];
  NSMutableDictionary *authority =
      [[self.wal snapshotWithError:nil][@"authorities"][0] mutableCopy];
  authority[@"transcript"] = fixture[@"transcript_before"];
  NSError *error = nil;
  XCTAssertTrue([self.wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    (void)mutationError;
    NSMutableArray *authorities = [state[@"authorities"] mutableCopy];
    authorities[0] = [authority copy];
    state[@"authorities"] = authorities;
    return YES;
  } error:&error]);
  XCTAssertNil(error);
  preparedStore.authorityOverride = [authority copy];
  NSDictionary *result = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"prepared");
  NSDictionary *afterAuthority =
      [self.wal snapshotWithError:nil][@"authorities"][0];
  XCTAssertEqualObjects(afterAuthority[@"transcript"], fixture[@"transcript"]);
  XCTAssertEqualObjects(afterAuthority[@"authority_revision"], @2);
}

- (void)testBatchFinalAuthorityRejectsInvalidTranscriptRelations {
  NSArray<NSString *> *cases = @[
    @"different-ref", @"downgrade", @"same-generation-sha",
    @"same-generation-bytes",
  ];
  for (NSUInteger index = 0; index < cases.count; index += 1) {
    [self resetStoresWithFaultHook:nil
                             name:[@"transcript-relation-"
                                 stringByAppendingString:cases[index]]];
    NSDictionary *rawRead = @{ @"schema_version" : @1,
      @"call_id" : @"read-call", @"name" : @"read_file",
      @"arguments_json" : @"{\"path\":\"README.md\"}" };
    NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawRead]];
    AgentEffectsPreparedStore *preparedStore = fixture[@"prepared_store"];
    NSMutableDictionary *authority =
        [[self.wal snapshotWithError:nil][@"authorities"][0] mutableCopy];
    NSMutableDictionary *transcript = [fixture[@"transcript"] mutableCopy];
    if ([cases[index] isEqualToString:@"different-ref"]) {
      transcript[@"transcript_ref"] =
          @"99999999-9999-4999-8999-999999999999";
    } else if ([cases[index] isEqualToString:@"downgrade"]) {
      transcript[@"generation"] =
          @([fixture[@"transcript"][@"generation"] unsignedIntegerValue] + 1);
    } else if ([cases[index] isEqualToString:@"same-generation-sha"]) {
      transcript[@"transcript_sha256"] =
          @"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    } else {
      transcript[@"transcript_bytes"] =
          @([fixture[@"transcript"][@"transcript_bytes"] unsignedIntegerValue] + 1);
    }
    authority[@"transcript"] = [transcript copy];
    preparedStore.authorityOverride = [authority copy];
    NSError *error = nil;
    NSDictionary *result = [fixture[@"batch_service"]
        prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
    XCTAssertNil(error, @"case=%@", cases[index]);
    XCTAssertEqualObjects(result[@"status"], @"rejected", @"case=%@", cases[index]);
    XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_CONFLICT",
                          @"case=%@", cases[index]);
  }
}

- (void)testBatchApprovalTamperAndExecutionReplayAreClosed {
  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  DSHAgentToolBatchService *batchService = fixture[@"batch_service"];
  NSError *error = nil;
  NSDictionary *prepared = [batchService
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(prepared[@"status"], @"prepared", @"%@", prepared);
  if (![prepared[@"status"] isEqualToString:@"prepared"]) return;
  NSDictionary *receipt = prepared[@"receipt"];
  XCTAssertEqualObjects(receipt[@"batch_kind"], @"write_batch");
  XCTAssertEqualObjects(receipt[@"batch_new_write_bytes"], @0);
  XCTAssertEqualObjects(receipt[@"effect_gate"], @"closed");
  NSDictionary *call = receipt[@"calls"][0];
  NSDictionary *token = call[@"approval_token"];
  XCTAssertNotNil(token);
  NSDictionary *state = [self.wal snapshotWithError:&error];
  XCTAssertEqual([state[@"batches"] count], 1U);
  XCTAssertEqual([state[@"operation_results"] count], 2U); // authority + batch

  NSString *approvalReference = @"71717171-7171-4171-8171-717171717171";
  NSMutableDictionary *persistedCall = [@{
    @"schema_version" : @3, @"call_id" : call[@"call_id"],
    @"call_index" : call[@"call_index"], @"name" : call[@"name"],
    @"arguments_sha256" : call[@"arguments_sha256"],
    @"safe_summary_key" : call[@"safe_summary_key"], @"access" : call[@"access"],
    @"approval_token" : token[@"token"], @"approval_decision" : @"allow_once",
    @"approval_reference" : approvalReference,
    @"idempotency_key" : call[@"idempotency_key"],
    @"native_row_revision" : call[@"native_row_revision"],
    @"receipt" : NSNull.null,
  } mutableCopy];
  NSDictionary *agent = @{ @"schema_version" : @3,
    @"phase" : @"execution_intent", @"root" : fixture[@"root"],
    @"transcript" : receipt[@"transcript"],
    @"round_lineage" : @{ @"round_id" : fixture[@"round_id"],
                           @"round_index" : @0 },
    @"batch" : @[persistedCall] };
  NSDictionary *session = @{ @"schema_version" : @9,
    @"conversations" : @[@{ @"id" : fixture[@"conversation"],
      @"agent_grants" : @[],
      @"attempts" : @[@{ @"attempt_id" : fixture[@"attempt"],
        @"journal_revision" : @1, @"agent" : agent }] }],
    @"session_events" : @[@{
      @"schema_version" : @2, @"event_id" : approvalReference,
      @"attempt_id" : fixture[@"attempt"], @"seq" : @1,
      @"kind" : @"approval", @"round_index" : @0,
      @"call_id" : call[@"call_id"], @"status" : @"approval",
      @"safe_summary_key" : call[@"safe_summary_key"],
      @"arguments_sha256" : call[@"arguments_sha256"],
      @"result_sha256" : NSNull.null,
      @"approval_reference" : approvalReference,
      @"failure_code" : NSNull.null,
      @"created_at" : @"2026-08-31T00:00:00.000Z",
    }],
  };
  AgentEffectsSessionStore *sessionStore = fixture[@"session_store"];
  sessionStore.fakeLoadResult = [self loadResultForSession:session generation:@3
      digest:fixture[@"checkpoint"][@"session_sha256"]];
  NSDictionary *baseBind = @{ @"schema_version" : @2,
    @"operation_id" : @"72727272-7272-4272-8272-727272727272",
    @"controller_cas" : fixture[@"controller"],
    @"committed_checkpoint" : fixture[@"checkpoint"],
    @"task_id" : fixture[@"task"], @"conversation_id" : fixture[@"conversation"],
    @"attempt_id" : fixture[@"attempt"], @"round_id" : fixture[@"round_id"],
    @"round_index" : @0, @"manifest_sha256" : receipt[@"manifest_sha256"],
    @"batch_revision" : receipt[@"batch_revision"], @"call_index" : @0,
    @"call_id" : call[@"call_id"], @"token" : token,
    @"decision" : @"allow_once" };
  NSArray<NSDictionary *> *tamperedTokens = @[
    ({ NSMutableDictionary *v = [token mutableCopy];
       v[@"token"] = @"91919191-9191-4191-8191-919191919191"; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy];
       v[@"root_fingerprint_sha256"] =
         @"9090909090909090909090909090909090909090909090909090909090909090"; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"binding_revision"] = @999; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy];
       v[@"round_id"] = @"92929292-9292-4292-8292-929292929292"; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"round_index"] = @1; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"batch_revision"] = @999; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"call_id"] = @"other-call";
       v[@"batch_call_ids"] = @[@"other-call"]; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"arguments_sha256"] =
         @"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
       v[@"batch_arguments_sha256"] = @[
         @"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"manifest_sha256"] =
         @"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"idempotency_key"] =
         @"1212121212121212121212121212121212121212121212121212121212121212"; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"name"] = @"write_file"; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy]; v[@"name"] = @"git_push";
       v[@"access"] = @"confirm_once";
       v[@"allowed_decisions"] = @[@"denied", @"allow_once", @"cancelled"]; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy];
       NSString *other = @"93939393-9393-4393-8393-939393939393";
       v[@"task_id"] = other;
       NSMutableDictionary *cas = [v[@"controller_cas"] mutableCopy];
       cas[@"task_id"] = other; v[@"controller_cas"] = cas; v; }),
    ({ NSMutableDictionary *v = [token mutableCopy];
       NSMutableDictionary *cas = [v[@"controller_cas"] mutableCopy];
       cas[@"expected_controller_generation"] = @999; v[@"controller_cas"] = cas; v; }),
  ];
  for (NSUInteger index = 0; index < tamperedTokens.count; index += 1) {
    NSMutableDictionary *request = [baseBind mutableCopy];
    request[@"operation_id"] = [NSString stringWithFormat:
        @"73737373-7373-4373-8373-%012lu", (unsigned long)(index + 1)];
    request[@"token"] = tamperedTokens[index];
    error = nil;
    NSDictionary *conflict = [batchService bindAgentApprovalWithRequest:request
                                                                   error:&error];
    XCTAssertNil(error);
    XCTAssertEqualObjects(conflict[@"status"], @"conflict");
    XCTAssertEqualObjects(conflict[@"failure_code"], @"E_AGENT_APPROVAL");
  }
  error = nil;
  NSDictionary *bound = [batchService bindAgentApprovalWithRequest:baseBind
                                                              error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(bound[@"status"], @"bound");
  XCTAssertEqualObjects(bound[@"approval_reference"], approvalReference);

  AgentEffectsGitExecutor *git = fixture[@"git_executor"];
  DSHAgentToolExecutionService *execution = [[DSHAgentToolExecutionService alloc]
      initWithWAL:self.wal ledger:self.ledger
      preparedStore:fixture[@"prepared_store"] transcripts:self.transcripts
      workspaceExecutor:fixture[@"workspace_executor"] gitExecutor:git];
  NSDictionary *executeRequest = @{ @"schema_version" : @2,
    @"operation_id" : @"74747474-7474-4474-8474-747474747474",
    @"controller_cas" : fixture[@"controller"],
    @"committed_checkpoint" : fixture[@"checkpoint"],
    @"task_id" : fixture[@"task"], @"conversation_id" : fixture[@"conversation"],
    @"attempt_id" : fixture[@"attempt"], @"round_id" : fixture[@"round_id"],
    @"round_index" : @0, @"batch_kind" : @"write_batch",
    @"manifest_sha256" : receipt[@"manifest_sha256"],
    @"expected_batch_revision" : receipt[@"batch_revision"],
    @"call_index" : @0, @"call_id" : call[@"call_id"],
    @"name" : call[@"name"], @"arguments_sha256" : call[@"arguments_sha256"],
    @"idempotency_key" : call[@"idempotency_key"],
    @"expected_execution_revision" : call[@"native_row_revision"],
    @"transcript" : receipt[@"transcript"], @"root" : fixture[@"root"],
    @"approval_reference" : approvalReference };
  NSDictionary *executed = [execution executeAgentToolWithRequest:executeRequest
                                                             error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(executed[@"status"], @"completed");
  XCTAssertEqual(git.effectCount, 1U);
  NSDictionary *replayed = [execution executeAgentToolWithRequest:executeRequest
                                                             error:&error];
  XCTAssertEqualObjects(replayed, executed);
  XCTAssertEqual(git.effectCount, 1U);
}

- (void)testBatchOperationResultFaultRollsBackWholeMutationBatch {
  __block BOOL failCompoundCommit = NO;
  [self resetStoresWithFaultHook:^BOOL(NSString *stage) {
    return !(failCompoundCommit &&
             [stage isEqualToString:@"wal.operation.before_result_commit"]);
  } name:@"batch-fault"];
  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  failCompoundCommit = YES;
  NSError *error = nil;
  NSDictionary *result = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"rejected");
  XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_LEDGER");
  NSDictionary *state = [self.wal snapshotWithError:&error];
  XCTAssertEqual([state[@"batches"] count], 0U);
  XCTAssertEqual([state[@"ledger"] count], 0U);
  XCTAssertEqual([state[@"denied_calls"] count], 0U);
  XCTAssertEqualObjects(state[@"authorities"][0][@"authority_revision"], @1);
  NSDictionary *operation = [state[@"operations"] filteredArrayUsingPredicate:
      [NSPredicate predicateWithFormat:@"operation_kind == %@",
       @"prepare_agent_tool_batch"]].firstObject;
  XCTAssertEqualObjects(operation[@"state"], @"rejected");
}

- (void)testMidPreflightRebindRejectsWithoutManifestOrIntent {
  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  AgentEffectsRootResolver *resolver = fixture[@"resolver"];
  AgentEffectsGitExecutor *git = fixture[@"git_executor"];
  git.onPrepare = ^{ resolver.rejectRoot = YES; };
  NSError *error = nil;
  NSDictionary *result = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"rejected");
  XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_ROOT_STALE");
  NSDictionary *state = [self.wal snapshotWithError:&error];
  XCTAssertEqual([state[@"batches"] count], 0U);
  XCTAssertEqual([state[@"ledger"] count], 0U);
  XCTAssertEqualObjects(state[@"authorities"][0][@"authority_revision"], @1);
}

- (void)testBatchPreflightHoldsSessionWorkspaceCoordinatorUntilCommit {
  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  DSHSessionWorkspaceCoordinator *coordinator =
      [fixture[@"session_store"] coordinator];
  AgentEffectsGitExecutor *git = fixture[@"git_executor"];
  dispatch_semaphore_t contenderStarted = dispatch_semaphore_create(0);
  dispatch_semaphore_t contenderFinished = dispatch_semaphore_create(0);
  __block BOOL contenderRan = NO;
  git.onPrepare = ^{
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      dispatch_semaphore_signal(contenderStarted);
      [coordinator performSync:^{ contenderRan = YES; }];
      dispatch_semaphore_signal(contenderFinished);
    });
    XCTAssertEqual(dispatch_semaphore_wait(
        contenderStarted, dispatch_time(DISPATCH_TIME_NOW,
                                        (int64_t)(NSEC_PER_SEC))), 0L);
    XCTAssertNotEqual(dispatch_semaphore_wait(
        contenderFinished, dispatch_time(DISPATCH_TIME_NOW,
                                         (int64_t)(50 * NSEC_PER_MSEC))), 0L);
  };

  NSError *error = nil;
  NSDictionary *result = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"prepared", @"%@", result);
  XCTAssertEqual(dispatch_semaphore_wait(
      contenderFinished, dispatch_time(DISPATCH_TIME_NOW,
                                       (int64_t)(NSEC_PER_SEC))), 0L);
  XCTAssertTrue(contenderRan);
}

- (void)testBatchPreparationIsReentrantOnSessionWorkspaceCoordinator {
  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  DSHSessionWorkspaceCoordinator *coordinator =
      [fixture[@"session_store"] coordinator];
  __block NSError *error = nil;
  __block NSDictionary *result = nil;
  [coordinator performSync:^{
    result = [fixture[@"batch_service"]
        prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  }];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"prepared", @"%@", result);
}

- (void)testBadPathPreflightReturnsImmutableClosedRejection {
  NSDictionary *rawRead = @{ @"schema_version" : @1,
    @"call_id" : @"read-call", @"name" : @"read_file",
    @"arguments_json" : @"{\"path\":\"../secret\"}",
    @"arguments_sha256" :
        @"3434343434343434343434343434343434343434343434343434343434343434" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawRead]];
  NSError *error = nil;
  NSDictionary *result = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"rejected");
  XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_BAD_PATH");
  XCTAssertEqualObjects(result[@"effect_dispatched"], @NO);
  NSDictionary *state = [self.wal snapshotWithError:&error];
  XCTAssertEqual([state[@"batches"] count], 0U);
  XCTAssertEqual([state[@"ledger"] count], 0U);
  NSDictionary *operation = [state[@"operations"] filteredArrayUsingPredicate:
      [NSPredicate predicateWithFormat:@"operation_kind == %@",
       @"prepare_agent_tool_batch"]].firstObject;
  XCTAssertEqualObjects(operation[@"state"], @"rejected");
}

- (void)testExistingFileWithAbsentWritePreconditionIsARequeryableConflict {
  NSDictionary *rawWrite = @{
    @"schema_version" : @1,
    @"call_id" : @"write-existing-call",
    @"name" : @"write_file",
    @"arguments_json" :
        @"{\"content\":\"provider smoke 0903\",\"expected_revision\":null,\"path\":\"SMOKE-1.md\"}",
  };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawWrite]];
  AgentEffectsWorkspaceExecutor *workspace = fixture[@"workspace_executor"];
  // The concrete workspace executor returns Conflict for this exact shape
  // when SMOKE-1.md already exists. Exercise the batch-service translation
  // without weakening any of its authority or transcript checks.
  workspace.prepareFailureCode = DSHAgentNativeStoreErrorConflict;

  NSError *error = nil;
  NSDictionary *result = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];

  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"rejected");
  XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_CONFLICT");
  XCTAssertEqualObjects(result[@"retry_advice"], @"requery");
  XCTAssertEqualObjects(result[@"effect_gate"], @"closed");
  XCTAssertEqualObjects(result[@"effect_dispatched"], @NO);
  NSDictionary *state = [self.wal snapshotWithError:&error];
  XCTAssertNil(error);
  XCTAssertEqual([state[@"batches"] count], 0U);
  XCTAssertEqual([state[@"ledger"] count], 0U);
}

- (void)testWorkspaceUnavailablePreflightRetainsCapabilityRejection {
  NSDictionary *rawRead = @{
    @"schema_version" : @1,
    @"call_id" : @"read-unavailable-call",
    @"name" : @"read_file",
    @"arguments_json" : @"{\"path\":\"README.md\"}",
  };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawRead]];
  AgentEffectsWorkspaceExecutor *workspace = fixture[@"workspace_executor"];
  workspace.prepareFailureCode = DSHAgentNativeStoreErrorUnavailable;

  NSError *error = nil;
  NSDictionary *result = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];

  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"status"], @"rejected");
  XCTAssertEqualObjects(result[@"failure_code"], @"E_AGENT_CAPABILITY");
  XCTAssertEqualObjects(result[@"retry_advice"], @"none");
  XCTAssertEqualObjects(result[@"effect_gate"], @"not_applicable");
  XCTAssertEqualObjects(result[@"effect_dispatched"], @NO);
}

- (void)testSettlementFaultOwnerLossReplayAndRecoveryNeverDuplicateGitEffect {
  __block BOOL failCompoundCommit = NO;
  [self resetStoresWithFaultHook:^BOOL(NSString *stage) {
    return !(failCompoundCommit &&
             [stage isEqualToString:@"wal.operation.before_result_commit"]);
  } name:@"settlement-fault"];
  NSDictionary *rawCommit = @{ @"schema_version" : @1,
    @"call_id" : @"commit-call", @"name" : @"git_commit",
    @"arguments_json" : @"{\"message\":\"m\"}" };
  NSDictionary *fixture = [self serviceFixtureForRawCalls:@[rawCommit]];
  NSString *grantID = @"81818181-8181-4181-8181-818181818181";
  NSDictionary *grant = @{ @"schema_version" : @2, @"grant_id" : grantID,
    @"conversation_id" : fixture[@"conversation"],
    @"workspace_id" : fixture[@"root"][@"workspace_id"],
    @"project_id" : fixture[@"root"][@"project_id"],
    @"binding_revision" : fixture[@"root"][@"workspace_binding_revision"],
    @"root_fingerprint_sha256" : fixture[@"root"][@"root_fingerprint_sha256"],
    @"tool_family" : @"git_commit", @"registry_version" : @1,
    @"policy_version" : @"agent-v1",
    @"issued_for" : @{ @"schema_version" : @1,
                        @"task_id" : fixture[@"task"],
                        @"attempt_id" : fixture[@"attempt"] },
    @"created_at" : @"2026-08-31T00:00:00.000Z" };
  NSDictionary *grantSession = @{ @"schema_version" : @9,
    @"conversations" : @[@{ @"id" : fixture[@"conversation"],
      @"agent_grants" : @[grant],
      @"attempts" : @[@{ @"attempt_id" : fixture[@"attempt"],
        @"journal_revision" : @1, @"agent" : NSNull.null }] }],
    @"session_events" : @[] };
  AgentEffectsSessionStore *sessionStore = fixture[@"session_store"];
  sessionStore.fakeLoadResult = [self loadResultForSession:grantSession generation:@3
      digest:fixture[@"checkpoint"][@"session_sha256"]];
  NSError *error = nil;
  NSDictionary *prepared = [fixture[@"batch_service"]
      prepareAgentToolBatchWithRequest:fixture[@"batch_request"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(prepared[@"status"], @"prepared", @"%@", prepared);
  if (![prepared[@"status"] isEqualToString:@"prepared"]) return;
  NSDictionary *receipt = prepared[@"receipt"];
  NSDictionary *call = receipt[@"calls"][0];
  XCTAssertEqualObjects(call[@"approval_state"], @"bound");
  XCTAssertEqualObjects(call[@"approval_reference"], grantID);
  NSDictionary *journalCall = @{ @"schema_version" : @3,
    @"call_id" : call[@"call_id"], @"call_index" : @0, @"name" : call[@"name"],
    @"arguments_sha256" : call[@"arguments_sha256"],
    @"safe_summary_key" : call[@"safe_summary_key"], @"access" : call[@"access"],
    @"approval_token" : NSNull.null, @"approval_decision" : @"allow_conversation",
    @"approval_reference" : grantID, @"idempotency_key" : call[@"idempotency_key"],
    @"native_row_revision" : call[@"native_row_revision"], @"receipt" : NSNull.null };
  NSDictionary *executionSession = @{ @"schema_version" : @9,
    @"conversations" : @[@{ @"id" : fixture[@"conversation"],
      @"agent_grants" : @[grant],
      @"attempts" : @[@{ @"attempt_id" : fixture[@"attempt"],
        @"journal_revision" : @1,
        @"agent" : @{ @"phase" : @"execution_intent",
          @"root" : fixture[@"root"], @"transcript" : receipt[@"transcript"],
          @"round_lineage" : @{ @"round_id" : fixture[@"round_id"],
                                 @"round_index" : @0 },
          @"batch" : @[journalCall] } }] }], @"session_events" : @[] };
  sessionStore.fakeLoadResult = [self loadResultForSession:executionSession generation:@3
      digest:fixture[@"checkpoint"][@"session_sha256"]];
  AgentEffectsGitExecutor *git = fixture[@"git_executor"];
  DSHAgentToolExecutionService *execution = [[DSHAgentToolExecutionService alloc]
      initWithWAL:self.wal ledger:self.ledger
      preparedStore:fixture[@"prepared_store"] transcripts:self.transcripts
      workspaceExecutor:fixture[@"workspace_executor"] gitExecutor:git];
  NSDictionary *request = @{ @"schema_version" : @2,
    @"operation_id" : @"82828282-8282-4282-8282-828282828282",
    @"controller_cas" : fixture[@"controller"],
    @"committed_checkpoint" : fixture[@"checkpoint"],
    @"task_id" : fixture[@"task"], @"conversation_id" : fixture[@"conversation"],
    @"attempt_id" : fixture[@"attempt"], @"round_id" : fixture[@"round_id"],
    @"round_index" : @0, @"batch_kind" : @"write_batch",
    @"manifest_sha256" : receipt[@"manifest_sha256"],
    @"expected_batch_revision" : receipt[@"batch_revision"],
    @"call_index" : @0, @"call_id" : call[@"call_id"], @"name" : call[@"name"],
    @"arguments_sha256" : call[@"arguments_sha256"],
    @"idempotency_key" : call[@"idempotency_key"],
    @"expected_execution_revision" : call[@"native_row_revision"],
    @"transcript" : receipt[@"transcript"], @"root" : fixture[@"root"],
    @"approval_reference" : grantID };
  failCompoundCommit = YES;
  NSDictionary *lost = [execution executeAgentToolWithRequest:request error:&error];
  XCTAssertEqualObjects(lost[@"status"], @"ambiguous");
  XCTAssertEqual(git.effectCount, 1U);
  NSDictionary *lostState = [self.wal snapshotWithError:&error];
  NSDictionary *lostOperation = [lostState[@"operations"]
      filteredArrayUsingPredicate:[NSPredicate
          predicateWithFormat:@"operation_id == %@", request[@"operation_id"]]]
      .firstObject;
  NSDictionary *lostRow = [lostState[@"ledger"]
      filteredArrayUsingPredicate:[NSPredicate
          predicateWithFormat:@"locator.call_id == %@", request[@"call_id"]]]
      .firstObject;
  XCTAssertEqualObjects(lostOperation[@"state"], @"started");
  XCTAssertEqualObjects(lostRow[@"state"], @"running");
  XCTAssertEqualObjects([self.wal dispatchStateForKind:@"execution"
                                               locator:lostRow[@"locator"]
                                                 error:&error], @"dispatched");
  XCTAssertFalse([self.wal isNativeTaskAlive:lostRow[@"owner"][@"native_task_id"]
                                      launchId:lostRow[@"owner"][@"launch_id"]]);
  error = nil;
  NSDictionary *replay = [execution executeAgentToolWithRequest:request error:&error];
  XCTAssertEqualObjects(replay[@"status"], @"ambiguous", @"%@", error);
  XCTAssertEqual(git.effectCount, 1U);
  failCompoundCommit = NO;
  NSDictionary *recovered = [execution recoverAgentToolWithRequest:request error:&error];
  XCTAssertEqualObjects(recovered[@"status"], @"completed");
  XCTAssertEqual(git.effectCount, 1U);
  NSDictionary *finalReplay = [execution executeAgentToolWithRequest:request error:&error];
  XCTAssertEqualObjects(finalReplay, recovered);
  XCTAssertEqual(git.effectCount, 1U);
}

- (void)testWriteBatchCapacityFailureIsAtomicAndExactReplayIsIdempotent {
  NSDictionary *root = [self rootWithCapabilities:@[@"file_write"]];
  NSDictionary *transcript = [self transcriptForRoot:root];
  NSString *large = [@"x" stringByPaddingToLength:20000
                                        withString:@"x" startingAtIndex:0];
  NSArray *over = @[
    [self writeCallAtIndex:0 path:@"a.txt" content:large],
    [self writeCallAtIndex:1 path:@"b.txt" content:large],
  ];
  NSError *error = nil;
  XCTAssertNil([self.ledger prepareAgentToolBatchWithRequest:
      [self batchRequestWithRoot:root transcript:transcript calls:over
                           policy:[self policyWithBatch:32768 attempt:65536]
                       roundIndex:0] error:&error]);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorCapacity);
  NSDictionary *snapshot = [self.wal snapshotWithError:nil];
  XCTAssertEqual([snapshot[@"ledger"] count], 0U);
  XCTAssertEqual([snapshot[@"batches"] count], 0U);
  XCTAssertEqual([snapshot[@"reservations"] count], 0U);

  error = nil;
  NSArray *one = @[[self writeCallAtIndex:0 path:@"a.txt" content:@"hello"]];
  NSDictionary *request = [self batchRequestWithRoot:root transcript:transcript
                                                calls:one
                                               policy:[self policyWithBatch:32768
                                                                      attempt:65536]
                                           roundIndex:0];
  NSDictionary *first = [self.ledger prepareAgentToolBatchWithRequest:request
                                                                 error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(first[@"status"], @"prepared");
  XCTAssertEqualObjects(first[@"batch_kind"], @"write_batch");
  XCTAssertEqualObjects(first[@"batch_new_write_bytes"], @5);
  NSDictionary *replay = [self.ledger prepareAgentToolBatchWithRequest:request
                                                                  error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(replay[@"status"], @"already_prepared");
  snapshot = [self.wal snapshotWithError:nil];
  XCTAssertEqual([snapshot[@"ledger"] count], 1U);
  XCTAssertEqual([snapshot[@"batches"] count], 1U);
  XCTAssertEqualObjects(snapshot[@"reservations"][0][@"reserved_write_bytes"], @5);
}

- (void)testDurableDeniedOnlyBatchHasNoExecutionRowOrIdempotencyKey {
  NSDictionary *root = [self rootWithCapabilities:@[@"file_read"]];
  NSDictionary *transcript = [self transcriptForRoot:root];
  NSError *error = nil;
  NSString *argumentsSHA = DSHAgentArgumentsSHA256(@"unknown_tool", @"{}",
                                                    &error);
  NSDictionary *call = @{
    @"call_index" : @0, @"call_id" : @"denied_0",
    @"name" : @"unknown_tool", @"arguments_json" : @"{}",
    @"arguments_sha256" : argumentsSHA,
    @"safe_summary_key" : @"agent.unknown", @"access" : @"durable_deny",
    @"precondition" : NSNull.null, @"reserved_write_bytes" : @0,
  };
  NSDictionary *result = [self.ledger prepareAgentToolBatchWithRequest:
      [self batchRequestWithRoot:root transcript:transcript calls:@[call]
                           policy:[self policyWithBatch:32768 attempt:65536]
                       roundIndex:0] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"batch_kind"], @"read_only_batch");
  XCTAssertEqualObjects(result[@"calls"][0][@"execution_status"], @"denied");
  XCTAssertEqualObjects(result[@"calls"][0][@"idempotency_key"], NSNull.null);
  XCTAssertEqualObjects(result[@"calls"][0][@"receipt"][@"outcome"], @"denied");
  XCTAssertEqualObjects(result[@"calls"][0][@"receipt"][@"failure_code"],
                        @"E_AGENT_UNKNOWN_TOOL");
  NSDictionary *snapshot = [self.wal snapshotWithError:nil];
  XCTAssertEqual([snapshot[@"ledger"] count], 0U);
  XCTAssertEqual([snapshot[@"dispatch"] count], 0U);
  XCTAssertEqual([snapshot[@"denied_calls"] count], 1U);
  XCTAssertEqualObjects(snapshot[@"transcripts"][0][@"generation"], @1);
}

- (void)testRealGitExecutorPushesToBareOriginOnlyAfterOneAcceptedRefStatus {
  NSDictionary *fixture = [self realGitExecutorFixtureNamed:@"push-success"
      projectID:@"91919191-9191-4191-8191-919191919191"];
  XCTAssertNotNil(fixture);
  if (fixture == nil) return;
  git_repository *repository = nullptr;
  XCTAssertEqual(git_repository_open(&repository,
      [fixture[@"repository_url"] fileSystemRepresentation]), 0);
  XCTAssertNotEqual(repository, nullptr);
  if (repository == nullptr) return;
  XCTAssertTrue([self writeFixtureFileNamed:@"success.txt" content:@"ok\n"
                              repositoryURL:fixture[@"repository_url"]]);
  NSString *targetOID = [self createFixtureCommitInRepository:repository
      parent:fixture[@"base_oid"] message:@"success"
      updateMainBranch:YES timestampSeconds:2];
  git_repository_free(repository);
  XCTAssertNotNil(targetOID);

  DSHAgentGitToolExecutor *executor = fixture[@"executor"];
  NSError *error = nil;
  NSDictionary *prepared = [executor prepareToolNamed:@"git_push"
      arguments:@{} root:fixture[@"root"] error:&error];
  XCTAssertNotNil(prepared);
  XCTAssertNil(error);
  XCTAssertEqualObjects(prepared[@"precondition"][@"pre_remote_oid"],
                        fixture[@"base_oid"]);
  XCTAssertEqualObjects(prepared[@"precondition"][@"target_oid"], targetOID);
  NSDictionary *effect = [executor executeToolNamed:@"git_push"
      arguments:@{} root:fixture[@"root"]
      precondition:prepared[@"precondition"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(effect[@"status"], @"ok");
  XCTAssertEqualObjects([self feedbackObject:effect][@"outcome"], @"ok");
  XCTAssertEqualObjects([self referenceOIDNamed:@"refs/heads/main"
      repositoryURL:fixture[@"origin_url"]], targetOID);
  XCTAssertEqualObjects([self referenceOIDNamed:@"refs/remotes/origin/main"
      repositoryURL:fixture[@"repository_url"]], targetOID);
}

- (void)testRealGitExecutorTreatsBareOriginRefRejectionAsSanitizedFailure {
  NSDictionary *fixture = [self realGitExecutorFixtureNamed:@"push-rejected"
      projectID:@"92929292-9292-4292-8292-929292929292"];
  XCTAssertNotNil(fixture);
  if (fixture == nil) return;
  git_repository *repository = nullptr;
  XCTAssertEqual(git_repository_open(&repository,
      [fixture[@"repository_url"] fileSystemRepresentation]), 0);
  XCTAssertNotEqual(repository, nullptr);
  if (repository == nullptr) return;
  XCTAssertTrue([self writeFixtureFileNamed:@"rejected.txt" content:@"reject\n"
                              repositoryURL:fixture[@"repository_url"]]);
  NSString *targetOID = [self createFixtureCommitInRepository:repository
      parent:fixture[@"base_oid"] message:@"rejected"
      updateMainBranch:YES timestampSeconds:2];
  git_repository_free(repository);
  XCTAssertNotNil(targetOID);

  DSHAgentGitToolExecutor *executor = fixture[@"executor"];
  NSError *error = nil;
  NSDictionary *prepared = [executor prepareToolNamed:@"git_push"
      arguments:@{} root:fixture[@"root"] error:&error];
  XCTAssertNotNil(prepared);
  XCTAssertNil(error);
  NSURL *lockURL = [fixture[@"origin_url"]
      URLByAppendingPathComponent:@"refs/heads/main.lock"];
  XCTAssertTrue([[@"held" dataUsingEncoding:NSUTF8StringEncoding]
      writeToURL:lockURL options:0 error:&error]);
  XCTAssertNil(error);
  NSDictionary *effect = [executor executeToolNamed:@"git_push"
      arguments:@{} root:fixture[@"root"]
      precondition:prepared[@"precondition"] error:&error];
  [NSFileManager.defaultManager removeItemAtURL:lockURL error:nil];
  XCTAssertNil(error);
  XCTAssertEqualObjects(effect[@"status"], @"failed");
  XCTAssertEqualObjects(effect[@"effect_may_have_occurred"], @NO);
  NSDictionary *feedback = [self feedbackObject:effect];
  XCTAssertEqualObjects(feedback, (@{
    @"schema_version" : @1, @"name" : @"git_push", @"outcome" : @"failed",
    @"payload" : @{ @"schema_version" : @1,
                       @"failure_code" : @"E_AGENT_TOOL_FAILED" },
  }));
  XCTAssertFalse([effect[@"feedback"] containsString:@"lock"]);
  XCTAssertFalse([effect[@"feedback"] containsString:
      [fixture[@"origin_url"] path]]);
  XCTAssertEqualObjects([self referenceOIDNamed:@"refs/heads/main"
      repositoryURL:fixture[@"origin_url"]], fixture[@"base_oid"]);
  XCTAssertNotEqualObjects([self referenceOIDNamed:@"refs/remotes/origin/main"
      repositoryURL:fixture[@"repository_url"]], targetOID);
}

- (void)testRealGitExecutorCommitUsesExpectedOldOIDReferenceCAS {
  NSDictionary *fixture = [self realGitExecutorFixtureNamed:@"commit-cas"
      projectID:@"93939393-9393-4393-8393-939393939393"];
  XCTAssertNotNil(fixture);
  if (fixture == nil) return;
  XCTAssertTrue([self writeFixtureFileNamed:@"agent.txt" content:@"agent\n"
                              repositoryURL:fixture[@"repository_url"]]);
  DSHAgentGitToolExecutor *executor = fixture[@"executor"];
  NSDictionary *arguments = @{ @"message" : @"agent commit" };
  NSError *error = nil;
  NSDictionary *prepared = [executor prepareToolNamed:@"git_commit"
      arguments:arguments root:fixture[@"root"] error:&error];
  XCTAssertNotNil(prepared);
  XCTAssertNil(error);
  XCTAssertEqualObjects(prepared[@"precondition"][@"pre_head_oid"],
                        fixture[@"base_oid"]);

  // Preserve the prepared index/tree while moving the branch to a competing
  // commit.  Execution can create its deterministic object, but the final
  // expected-old-OID transaction must not overwrite this concurrent ref.
  git_repository *repository = nullptr;
  XCTAssertEqual(git_repository_open(&repository,
      [fixture[@"repository_url"] fileSystemRepresentation]), 0);
  XCTAssertNotEqual(repository, nullptr);
  if (repository == nullptr) return;
  NSString *concurrentOID = [self createFixtureCommitInRepository:repository
      parent:fixture[@"base_oid"] message:@"concurrent"
      updateMainBranch:YES timestampSeconds:3];
  git_repository_free(repository);
  XCTAssertNotNil(concurrentOID);
  NSDictionary *effect = [executor executeToolNamed:@"git_commit"
      arguments:arguments root:fixture[@"root"]
      precondition:prepared[@"precondition"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(effect[@"status"], @"failed");
  XCTAssertEqualObjects(effect[@"effect_may_have_occurred"], @NO);
  XCTAssertEqualObjects([self feedbackObject:effect][@"payload"]
                        [@"failure_code"], @"E_AGENT_CONFLICT");
  XCTAssertEqualObjects([self referenceOIDNamed:@"refs/heads/main"
      repositoryURL:fixture[@"repository_url"]], concurrentOID);
  XCTAssertNotEqualObjects(concurrentOID,
                           prepared[@"precondition"][@"expected_commit_oid"]);
}

- (void)testRealGitExecutorSuccessfulCommitPublishesTheCommittedIndex {
  NSDictionary *fixture = [self realGitExecutorFixtureNamed:@"commit-clean-index"
      projectID:@"94949494-9494-4494-8494-949494949494"];
  XCTAssertNotNil(fixture);
  if (fixture == nil) return;
  XCTAssertTrue([self writeFixtureFileNamed:@"agent.txt" content:@"agent\n"
                              repositoryURL:fixture[@"repository_url"]]);
  DSHAgentGitToolExecutor *executor = fixture[@"executor"];
  NSDictionary *arguments = @{ @"message" : @"agent commit" };
  NSError *error = nil;
  NSDictionary *prepared = [executor prepareToolNamed:@"git_commit"
      arguments:arguments root:fixture[@"root"] error:&error];
  XCTAssertNotNil(prepared);
  XCTAssertNil(error);
  NSDictionary *effect = [executor executeToolNamed:@"git_commit"
      arguments:arguments root:fixture[@"root"]
      precondition:prepared[@"precondition"] error:&error];
  XCTAssertNil(error);
  XCTAssertEqualObjects(effect[@"status"], @"ok");
  XCTAssertEqualObjects([self referenceOIDNamed:@"refs/heads/main"
      repositoryURL:fixture[@"repository_url"]],
      prepared[@"precondition"][@"expected_commit_oid"]);

  NSDictionary *statusPrepared = [executor prepareToolNamed:@"git_status"
      arguments:@{} root:fixture[@"root"] error:&error];
  XCTAssertNotNil(statusPrepared);
  NSDictionary *statusEffect = [executor executeToolNamed:@"git_status"
      arguments:@{} root:fixture[@"root"]
      precondition:statusPrepared[@"precondition"] error:&error];
  XCTAssertNil(error);
  NSDictionary *payload = [self feedbackObject:statusEffect][@"payload"];
  XCTAssertEqualObjects(payload[@"clean"], @YES);
  XCTAssertEqualObjects(payload[@"entry_count"], @0);
}

- (void)testWorkspaceExecutorUsesFrozenRootLeaseAndRecoversWriteByBytes {
  NSURL *privateRoot = [self.rootURL URLByAppendingPathComponent:@"workspace-private"
                                                     isDirectory:YES];
  NSURL *documents = [self.rootURL URLByAppendingPathComponent:@"Documents"
                                                   isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:privateRoot
                                         withIntermediateDirectories:YES
                                                          attributes:@{NSFilePosixPermissions : @0700}
                                                               error:nil]);
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:documents
                                         withIntermediateDirectories:YES
                                                          attributes:nil
                                                               error:nil]);
  DSHLocalWorkspaceAccess *access = [[DSHLocalWorkspaceAccess alloc]
      initWithPrivateRootURL:privateRoot
      documentsRootURL:documents
      clock:^NSDate * { return [NSDate dateWithTimeIntervalSince1970:1788134400]; }
      UUIDGenerator:^NSString * {
        return @"55555555-5555-4555-8555-555555555555";
      }
      legacyResolver:^BOOL(NSString *projectId, NSDictionary **evidence,
                           NSError **error) {
        (void)projectId;
        if (evidence != nil) *evidence = nil;
        (void)error;
        return NO;
      }
      faultHook:nil];
  NSError *error = nil;
  XCTAssertTrue([access ensurePrivateLayoutWithError:&error]);
  XCTAssertNil(error);
  NSDictionary *created = [access createRishOwnedWorkspaceWithDisplayName:@"Agent"
      operationId:@"66666666-6666-4666-8666-666666666666" error:&error];
  XCTAssertNotNil(created);
  XCTAssertNil(error);
  DSHAgentRootResolver *resolver = [[DSHAgentRootResolver alloc]
      initWithWorkspaceAccess:access projectAccess:nil];
  DSHAgentWorkspaceToolExecutor *executor =
      [[DSHAgentWorkspaceToolExecutor alloc] initWithRootResolver:resolver];
  NSDictionary *writeRoot = [resolver resolveRootForWorkspaceId:created[@"workspace_id"]
      projectId:nil bindingRevision:created[@"binding_revision"] error:&error];
  XCTAssertNotNil(writeRoot);
  XCTAssertNil(error);
  NSDictionary *arguments = @{
    @"path" : @"proof.txt", @"content" : @"proof",
    @"expected_prior" : @{ @"schema_version" : @1, @"kind" : @"absent" },
  };
  NSDictionary *prepared = [executor prepareToolNamed:@"write_file"
                                             arguments:arguments root:writeRoot
                                                  error:&error];
  XCTAssertNotNil(prepared);
  XCTAssertNil(error);
  NSDictionary *effect = [executor executeToolNamed:@"write_file"
                                          arguments:arguments root:writeRoot
                                       precondition:prepared[@"precondition"]
                                               error:&error];
  XCTAssertEqualObjects(effect[@"status"], @"ok");
  XCTAssertNil(error);
  NSDictionary *conflictingPrepare = [executor prepareToolNamed:@"write_file"
      arguments:arguments root:writeRoot error:&error];
  XCTAssertNil(conflictingPrepare);
  XCTAssertEqual(error.code, DSHAgentNativeStoreErrorConflict);
  error = nil;
  NSDictionary *recovered = [executor recoverToolNamed:@"write_file"
                                             arguments:arguments root:writeRoot
                                          precondition:prepared[@"precondition"]
                                                  error:&error];
  XCTAssertEqualObjects(recovered[@"status"], @"settled");

  NSDictionary *readPrepared = [executor prepareToolNamed:@"read_file"
      arguments:@{ @"path" : @"proof.txt" } root:writeRoot error:&error];
  NSDictionary *read = [executor executeToolNamed:@"read_file"
      arguments:@{ @"path" : @"proof.txt" } root:writeRoot
      precondition:readPrepared[@"precondition"] error:&error];
  NSData *feedbackBytes = [read[@"feedback"] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *feedback = [NSJSONSerialization JSONObjectWithData:feedbackBytes
                                                            options:0 error:&error];
  XCTAssertEqualObjects(feedback[@"payload"][@"content"], @"proof");
  XCTAssertNil(error);
}

@end
