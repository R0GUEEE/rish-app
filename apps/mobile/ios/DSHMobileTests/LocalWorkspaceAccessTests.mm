#import <XCTest/XCTest.h>

#import <CommonCrypto/CommonDigest.h>
#import <TargetConditionals.h>

#import "../../../../modules/rish/ios/Sources/LocalWorkspaceAccess.h"

#include <math.h>
#include <sys/stat.h>

@interface LocalWorkspaceAccessTests : XCTestCase
@property(nonatomic, strong) NSURL *rootURL;
@property(nonatomic, strong) NSDate *now;
@property(nonatomic) NSUInteger resolverCalls;
@property(nonatomic) BOOL resolverThrows;
@property(nonatomic, copy) NSString *resolverIdentity;
@property(nonatomic, copy) NSSet<NSString *> *resolverCapabilities;
@end

@implementation LocalWorkspaceAccessTests

static NSString *const DSHWorkspaceA =
    @"11111111-1111-4111-8111-111111111111";
static NSString *const DSHWorkspaceB =
    @"22222222-2222-4222-8222-222222222222";
static NSString *const DSHWorkspaceC =
    @"33333333-3333-4333-8333-333333333333";
static NSString *const DSHWorkspaceD =
    @"44444444-4444-4444-8444-444444444444";
static NSString *const DSHProjectA =
    @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
static NSString *const DSHProjectWide =
    @"dddddddd-dddd-7ddd-cddd-dddddddddddd";
static NSString *const DSHOperationA =
    @"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
static NSString *const DSHOperationB =
    @"cccccccc-cccc-4ccc-8ccc-cccccccccccc";
static NSString *const DSHTimestamp = @"2026-08-29T00:00:00.000Z";
static NSString *const DSHDigestA =
    @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static NSString *const DSHDigestB =
    @"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

- (void)setUp {
  [super setUp];
  NSString *name = [NSString stringWithFormat:@"rish-workspace-a1-%@",
                    NSUUID.UUID.UUIDString.lowercaseString];
  self.rootURL = [NSURL fileURLWithPath:
      [NSTemporaryDirectory() stringByAppendingPathComponent:name]
                              isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:self.rootURL
                                       withIntermediateDirectories:YES
                                                        attributes:nil
                                                             error:nil]);
  self.now = [NSDate dateWithTimeIntervalSince1970:1787961600];
  self.resolverCalls = 0;
  self.resolverThrows = NO;
  self.resolverIdentity = DSHDigestA;
  self.resolverCapabilities = [NSSet setWithArray:
      @[@"read", @"write", @"git", @"project_context"]];
}

- (void)tearDown {
  [NSFileManager.defaultManager removeItemAtURL:self.rootURL error:nil];
  [super tearDown];
}

- (DSHLocalWorkspaceAccess *)accessWithRoot:(NSURL *)root
                                       fault:(nullable DSHLocalWorkspaceFaultHook)fault {
  return [self accessWithRoot:root fault:fault workspaceId:DSHWorkspaceA];
}

- (DSHLocalWorkspaceAccess *)accessWithRoot:(NSURL *)root
                                       fault:(nullable DSHLocalWorkspaceFaultHook)fault
                                 workspaceId:(NSString *)workspaceId {
  return [self accessWithRoot:root fault:fault UUIDGenerator:^NSString *{
    return workspaceId;
  }];
}

- (DSHLocalWorkspaceAccess *)accessWithRoot:(NSURL *)root
                                       fault:(nullable DSHLocalWorkspaceFaultHook)fault
                               UUIDGenerator:(DSHLocalWorkspaceUUIDGenerator)UUIDGenerator {
  __weak LocalWorkspaceAccessTests *weakSelf = self;
  return [[DSHLocalWorkspaceAccess alloc]
      initWithPrivateRootURL:root
      clock:^NSDate *{
        return weakSelf.now;
      }
      UUIDGenerator:UUIDGenerator
      legacyResolver:^BOOL(NSString *projectId,
                           NSString *__autoreleasing *identityDigest,
                           NSSet<NSString *> *__autoreleasing *capabilities,
                           NSError *__autoreleasing *error) {
        __strong LocalWorkspaceAccessTests *self = weakSelf;
        self.resolverCalls += 1;
        if (self.resolverThrows) {
          [NSException raise:@"PrivateResolverFailure"
                      format:@"native path /private/secret must not escape"];
        }
        if (![projectId isEqual:DSHProjectA] &&
            ![projectId isEqual:DSHProjectWide]) {
          if (error != nil) {
            *error = [NSError errorWithDomain:@"private.native"
                                         code:71
                                     userInfo:@{NSLocalizedDescriptionKey:
                                         @"provider /private/secret unavailable"}];
          }
          return NO;
        }
        if (identityDigest != nil) *identityDigest = self.resolverIdentity;
        if (capabilities != nil) *capabilities = self.resolverCapabilities;
        return YES;
      }
      faultHook:fault];
}

- (DSHLocalWorkspaceAccess *)access {
  return [self accessWithRoot:self.rootURL fault:nil];
}

- (NSURL *)registryURLForRoot:(NSURL *)root {
  return [[root URLByAppendingPathComponent:@"local-workspaces"
                                isDirectory:YES]
      URLByAppendingPathComponent:@"registry-v1.json"];
}

- (NSURL *)receiptsURLForRoot:(NSURL *)root {
  return [[root URLByAppendingPathComponent:@"local-workspaces"
                                isDirectory:YES]
      URLByAppendingPathComponent:@"receipts-v1.json"];
}

- (NSURL *)journalURLForRoot:(NSURL *)root {
  return [[root URLByAppendingPathComponent:@"local-workspaces"
                                isDirectory:YES]
      URLByAppendingPathComponent:@"authority-journal-v1.json"];
}

- (NSURL *)authorityURLForRoot:(NSURL *)root
                           kind:(NSString *)kind
                    workspaceId:(NSString *)workspaceId
                       revision:(NSUInteger)revision {
  NSString *name = [NSString stringWithFormat:@"%@-%@-r%lu.json", kind,
                    workspaceId, (unsigned long)revision];
  return [[root URLByAppendingPathComponent:@"workspace-bindings"
                                isDirectory:YES]
      URLByAppendingPathComponent:name];
}

- (NSString *)sha256ForData:(NSData *)data {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:64];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [result appendFormat:@"%02x", digest[index]];
  }
  return result;
}

- (NSData *)canonicalData:(id)object {
  return [NSJSONSerialization dataWithJSONObject:object
                                          options:NSJSONWritingSortedKeys
                                            error:nil];
}

- (void)secureWriteObject:(id)object toURL:(NSURL *)url {
  NSData *data = [self canonicalData:object];
  XCTAssertNotNil(data);
  [self secureWriteData:data toURL:url];
}

- (void)secureWriteData:(NSData *)data toURL:(NSURL *)url {
  XCTAssertTrue([data writeToURL:url options:NSDataWritingAtomic error:nil]);
  XCTAssertTrue(([NSFileManager.defaultManager
      setAttributes:@{NSFilePosixPermissions:@0600,
                      NSFileProtectionKey:NSFileProtectionComplete}
       ofItemAtPath:url.path
              error:nil]));
  XCTAssertTrue([url setResourceValue:@YES
                               forKey:NSURLIsExcludedFromBackupKey
                                error:nil]);
}

- (NSDictionary *)recordForWorkspaceId:(NSString *)workspaceId
                                  origin:(NSString *)origin
                         rootLocatorKind:(NSString *)rootLocatorKind
                           locationClass:(NSString *)locationClass
                     ownedDirectoryName:(nullable NSString *)ownedDirectoryName
                        legacyProjectId:(nullable NSString *)legacyProjectId
                        bindingRevision:(NSUInteger)bindingRevision {
  return @{
    @"schema_version": @1,
    @"workspace_id": workspaceId,
    @"display_name": [NSString stringWithFormat:@"Workspace %@",
                      [workspaceId substringToIndex:4]],
    @"origin": origin,
    @"root_locator_kind": rootLocatorKind,
    @"location_class": locationClass,
    @"owned_directory_name": ownedDirectoryName ?: NSNull.null,
    @"legacy_project_id": legacyProjectId ?: NSNull.null,
    @"binding_revision": @(bindingRevision),
    @"created_at": DSHTimestamp,
    @"last_opened_at": DSHTimestamp,
  };
}

- (NSDictionary *)legacyRecordWithRevision:(NSUInteger)revision {
  return [self recordForWorkspaceId:DSHWorkspaceA
                             origin:@"legacy_app_owned"
                    rootLocatorKind:@"legacy_app_owned"
                      locationClass:@"rish_owned"
                ownedDirectoryName:nil
                   legacyProjectId:DSHProjectA
                   bindingRevision:revision];
}

- (NSDictionary *)legacyAuthorityWithRevision:(NSUInteger)revision
                                authorityDigest:(NSString *)digest {
  NSDictionary *record = [self legacyRecordWithRevision:revision];
  return @{
    @"schema_version": @1,
    @"workspace_id": DSHWorkspaceA,
    @"binding_revision": @(revision),
    @"legacy_project_id": DSHProjectA,
    @"root_identity_sha256": digest,
    @"display_name": record[@"display_name"],
    @"created_at": DSHTimestamp,
    @"last_opened_at": DSHTimestamp,
    @"recorded_at": DSHTimestamp,
  };
}

- (NSDictionary *)ownedAuthorityForWorkspace:(NSString *)workspaceId
                                      revision:(NSUInteger)revision
                                 directoryName:(NSString *)directoryName {
  NSData *nameData = [directoryName dataUsingEncoding:NSUTF8StringEncoding];
  return @{
    @"schema_version": @1,
    @"workspace_id": workspaceId,
    @"binding_revision": @(revision),
    @"device_id": @"42",
    @"inode_id": @"84",
    @"directory_name_sha256": [self sha256ForData:nameData],
    @"recorded_at": DSHTimestamp,
  };
}

- (NSDictionary *)bookmarkAuthorityForWorkspace:(NSString *)workspaceId
                                         revision:(NSUInteger)revision
                                            bytes:(NSData *)bytes {
  return @{
    @"schema_version": @1,
    @"workspace_id": workspaceId,
    @"binding_revision": @(revision),
    @"bookmark_sha256": [self sha256ForData:bytes],
    @"bookmark_bytes_base64": [bytes base64EncodedStringWithOptions:0],
    @"recorded_at": DSHTimestamp,
  };
}

- (NSDictionary *)grantedAuthorityForWorkspace:(NSString *)workspaceId
                                        revision:(NSUInteger)revision
                                   bookmarkDigest:(NSString *)bookmarkDigest {
  return @{
    @"schema_version": @1,
    @"workspace_id": workspaceId,
    @"binding_revision": @(revision),
    @"volume_identifier_sha256": DSHDigestA,
    @"resource_identifier_sha256": DSHDigestB,
    @"device_id": @"7",
    @"inode_id": @"9",
    @"bookmark_sha256": bookmarkDigest,
    @"classified_at": DSHTimestamp,
  };
}

- (void)writeRegistryRecords:(NSArray<NSDictionary *> *)records
                   generation:(NSUInteger)generation
                         root:(NSURL *)root {
  [self secureWriteObject:@{
    @"schema_version": @1,
    @"generation": @(generation),
    @"records": records,
  } toURL:[self registryURLForRoot:root]];
}

- (NSDictionary *)bootstrapWithAccess:(DSHLocalWorkspaceAccess *)access
                           operationId:(NSString *)operationId
                                 error:(NSError **)error {
  return [access bootstrapLegacyProjectId:DSHProjectA
                               displayName:@"Legacy Workspace"
                                operationId:operationId
                                      error:error];
}

- (NSDictionary *)resolve:(DSHLocalWorkspaceAccess *)access
                  revision:(nullable NSNumber *)revision
               capabilities:(NSArray<NSString *> *)capabilities
                      error:(NSError **)error {
  return [access resolveWorkspaceId:DSHWorkspaceA
             expectedBindingRevision:revision
                requiredCapabilities:capabilities
                               error:error];
}

- (NSString *)JSONText:(id)object {
  if (object == nil) return @"";
  if ([object isKindOfClass:NSError.class]) {
    NSError *error = object;
    object = @{ @"domain": error.domain,
                @"code": @(error.code),
                @"description": error.localizedDescription,
                @"user_info": error.userInfo ?: @{} };
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                  options:NSJSONWritingSortedKeys
                                                    error:nil];
  return data == nil ? [object description]
                     : [[NSString alloc] initWithData:data
                                              encoding:NSUTF8StringEncoding];
}

- (void)assertDictionary:(NSDictionary *)dictionary
             hasExactKeys:(NSArray<NSString *> *)keys {
  XCTAssertEqualObjects([NSSet setWithArray:dictionary.allKeys],
                        [NSSet setWithArray:keys]);
  XCTAssertEqual(dictionary.count, keys.count);
}

- (void)testPrivateLayoutUsesBoundedProtectedBackupExcludedFiles {
  NSError *error = nil;
  XCTAssertTrue([[self access] ensurePrivateLayoutWithError:&error]);
  XCTAssertNil(error);

  for (NSString *name in @[@"local-workspaces", @"workspace-bindings"]) {
    NSURL *directory = [self.rootURL URLByAppendingPathComponent:name
                                                      isDirectory:YES];
    NSDictionary *attributes = [NSFileManager.defaultManager
        attributesOfItemAtPath:directory.path error:&error];
    XCTAssertEqual([attributes[NSFilePosixPermissions] unsignedShortValue] & 0777,
                   0700);
    NSNumber *excluded = nil;
    XCTAssertTrue([directory getResourceValue:&excluded
                                       forKey:NSURLIsExcludedFromBackupKey
                                        error:&error]);
    XCTAssertTrue(excluded.boolValue);
  }

  NSURL *authorityLock = [[self.rootURL
      URLByAppendingPathComponent:@"local-workspaces" isDirectory:YES]
      URLByAppendingPathComponent:@"authority.lock"];
  NSURL *layoutManifest = [[self.rootURL
      URLByAppendingPathComponent:@"local-workspaces" isDirectory:YES]
      URLByAppendingPathComponent:@"layout-v1.json"];
  for (NSURL *file in @[[self registryURLForRoot:self.rootURL],
                        [self receiptsURLForRoot:self.rootURL], authorityLock,
                        layoutManifest]) {
    NSDictionary *attributes = [NSFileManager.defaultManager
        attributesOfItemAtPath:file.path error:&error];
    XCTAssertEqual([attributes[NSFilePosixPermissions] unsignedShortValue] & 0777,
                   0600);
#if TARGET_OS_SIMULATOR
    if (attributes[NSFileProtectionKey] != nil) {
      XCTAssertEqualObjects(attributes[NSFileProtectionKey],
                            NSFileProtectionComplete);
    }
#else
    XCTAssertEqualObjects(attributes[NSFileProtectionKey], NSFileProtectionComplete);
#endif
    NSNumber *excluded = nil;
    XCTAssertTrue([file getResourceValue:&excluded
                                  forKey:NSURLIsExcludedFromBackupKey
                                   error:&error]);
    XCTAssertTrue(excluded.boolValue);
  }
}

- (void)testInitializedStoreNeverRecreatesMissingRegistryOrReceipts {
  for (NSString *missing in @[@"registry", @"receipts"]) {
    NSURL *root = [self.rootURL URLByAppendingPathComponent:missing
                                                isDirectory:YES];
    XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:root
                                         withIntermediateDirectories:YES
                                                          attributes:nil
                                                               error:nil]);
    DSHLocalWorkspaceAccess *access = [self accessWithRoot:root fault:nil];
    XCTAssertNotNil([access bootstrapLegacyProjectId:DSHProjectA
                                          displayName:@"Persisted"
                                           operationId:DSHOperationA error:nil]);
    NSURL *target = [missing isEqual:@"registry"]
        ? [self registryURLForRoot:root] : [self receiptsURLForRoot:root];
    XCTAssertTrue([NSFileManager.defaultManager removeItemAtURL:target error:nil]);

    DSHLocalWorkspaceAccess *restarted = [self accessWithRoot:root fault:nil];
    NSError *error = nil;
    XCTAssertNil([restarted listWorkspaceMetadataWithError:&error]);
    XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
    XCTAssertFalse([NSFileManager.defaultManager fileExistsAtPath:target.path]);
  }
}

- (void)testPrivateFilesRejectPermissionDriftFromExact0600 {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  XCTAssertEqual(chmod([self registryURLForRoot:self.rootURL]
                           .fileSystemRepresentation, 0400), 0);
  NSError *error = nil;
  XCTAssertNil([access listWorkspaceMetadataWithError:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
}

- (void)testRegistryRejectsNonExactOversizedUnsortedAndInvalidRecords {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSDictionary *recordA = [self legacyRecordWithRevision:1];
  [self secureWriteObject:[self legacyAuthorityWithRevision:1
                                               authorityDigest:DSHDigestA]
                    toURL:[self authorityURLForRoot:self.rootURL
                                               kind:@"legacy"
                                        workspaceId:DSHWorkspaceA
                                           revision:1]];

  NSMutableDictionary *extraEnvelope = [@{
    @"schema_version": @1, @"generation": @1,
    @"records": @[recordA], @"extra": @1,
  } mutableCopy];
  [self secureWriteObject:extraEnvelope
                    toURL:[self registryURLForRoot:self.rootURL]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSString *recordText = [[NSString alloc]
      initWithData:[self canonicalData:recordA]
           encoding:NSUTF8StringEncoding];
  NSString *duplicateKeyJSON = [NSString stringWithFormat:
      @"{\"schema_version\":1,\"generation\":0,\"generation\":1,"
       "\"records\":[%@]}", recordText];
  [self secureWriteData:[duplicateKeyJSON dataUsingEncoding:NSUTF8StringEncoding]
                   toURL:[self registryURLForRoot:self.rootURL]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSString *negativeZeroJSON = [NSString stringWithFormat:
      @"{\"schema_version\":1,\"generation\":-0e0,\"records\":[%@]}",
      recordText];
  [self secureWriteData:[negativeZeroJSON dataUsingEncoding:NSUTF8StringEncoding]
                   toURL:[self registryURLForRoot:self.rootURL]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSString *escapedDuplicateJSON = [NSString stringWithFormat:
      @"{\"schema_version\":1,\"generation\":0,"
       "\"gen\\u0065ration\":1,\"records\":[%@]}", recordText];
  [self secureWriteData:[escapedDuplicateJSON
      dataUsingEncoding:NSUTF8StringEncoding]
                   toURL:[self registryURLForRoot:self.rootURL]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSMutableString *tooDeep = [NSMutableString stringWithString:
      @"{\"schema_version\":1,\"generation\":0,\"records\":" ];
  for (NSUInteger index = 0; index < 65; index++) [tooDeep appendString:@"["];
  [tooDeep appendString:@"0"];
  for (NSUInteger index = 0; index < 65; index++) [tooDeep appendString:@"]"];
  [tooDeep appendString:@"}"];
  [self secureWriteData:[tooDeep dataUsingEncoding:NSUTF8StringEncoding]
                   toURL:[self registryURLForRoot:self.rootURL]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSMutableDictionary *invalidRecord = [recordA mutableCopy];
  invalidRecord[@"workspace_id"] = DSHProjectA.uppercaseString;
  [self writeRegistryRecords:@[invalidRecord] generation:1 root:self.rootURL];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSDictionary *recordB = [self recordForWorkspaceId:DSHWorkspaceB
                                               origin:@"legacy_app_owned"
                                      rootLocatorKind:@"legacy_app_owned"
                                        locationClass:@"rish_owned"
                                  ownedDirectoryName:nil
                                     legacyProjectId:DSHProjectA
                                     bindingRevision:1];
  [self writeRegistryRecords:@[recordB, recordA]
                   generation:1 root:self.rootURL];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSMutableArray *tooMany = [NSMutableArray arrayWithCapacity:1025];
  for (NSUInteger index = 0; index < 1025; index++) {
    NSString *workspace = [NSString stringWithFormat:@"%08lx-0000-4000-8000-%012lx",
                           (unsigned long)index, (unsigned long)index];
    [tooMany addObject:[self recordForWorkspaceId:workspace
                                           origin:@"legacy_app_owned"
                                  rootLocatorKind:@"legacy_app_owned"
                                    locationClass:@"rish_owned"
                              ownedDirectoryName:nil
                                 legacyProjectId:DSHProjectA
                                 bindingRevision:1]];
  }
  [self writeRegistryRecords:tooMany generation:1 root:self.rootURL];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSMutableData *oversized = [NSMutableData dataWithLength:(1024 * 1024) + 1];
  [oversized replaceBytesInRange:NSMakeRange(0, 1) withBytes:"{"];
  XCTAssertTrue([oversized writeToURL:[self registryURLForRoot:self.rootURL]
                              options:NSDataWritingAtomic error:nil]);
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);
}

- (void)testIndependentAuthoritySchemasAreExactAndCorruptionFailsClosed {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSData *bookmark = [@"PRIVATE_BOOKMARK_BYTES" dataUsingEncoding:NSUTF8StringEncoding];
  NSString *bookmarkDigest = [self sha256ForData:bookmark];
  NSArray *records = @[
    [self recordForWorkspaceId:DSHWorkspaceA origin:@"rish_created"
               rootLocatorKind:@"documents_owned" locationClass:@"rish_owned"
         ownedDirectoryName:@"Owned A" legacyProjectId:nil bindingRevision:1],
    [self recordForWorkspaceId:DSHWorkspaceB origin:@"imported"
               rootLocatorKind:@"documents_owned" locationClass:@"rish_owned"
         ownedDirectoryName:@"Imported B" legacyProjectId:nil bindingRevision:1],
    [self recordForWorkspaceId:DSHWorkspaceC origin:@"granted_folder"
               rootLocatorKind:@"security_scoped" locationClass:@"proven_local"
         ownedDirectoryName:nil legacyProjectId:nil bindingRevision:1],
    [self recordForWorkspaceId:DSHWorkspaceD origin:@"legacy_app_owned"
               rootLocatorKind:@"legacy_app_owned" locationClass:@"rish_owned"
         ownedDirectoryName:nil legacyProjectId:DSHProjectA bindingRevision:1],
  ];
  [self writeRegistryRecords:records generation:1 root:self.rootURL];
  [self secureWriteObject:[self ownedAuthorityForWorkspace:DSHWorkspaceA
                                                   revision:1
                                              directoryName:@"Owned A"]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"owned"
                                        workspaceId:DSHWorkspaceA revision:1]];
  [self secureWriteObject:[self ownedAuthorityForWorkspace:DSHWorkspaceB
                                                   revision:1
                                              directoryName:@"Imported B"]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"owned"
                                        workspaceId:DSHWorkspaceB revision:1]];
  [self secureWriteObject:[self bookmarkAuthorityForWorkspace:DSHWorkspaceC
                                                      revision:1 bytes:bookmark]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"bookmark"
                                        workspaceId:DSHWorkspaceC revision:1]];
  [self secureWriteObject:[self grantedAuthorityForWorkspace:DSHWorkspaceC
                                                     revision:1
                                                bookmarkDigest:bookmarkDigest]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"granted"
                                        workspaceId:DSHWorkspaceC revision:1]];
  NSDictionary *legacy = @{
    @"schema_version": @1, @"workspace_id": DSHWorkspaceD,
    @"binding_revision": @1, @"legacy_project_id": DSHProjectA,
    @"root_identity_sha256": DSHDigestA, @"display_name": @"Workspace 4444",
    @"created_at": DSHTimestamp, @"last_opened_at": DSHTimestamp,
    @"recorded_at": DSHTimestamp,
  };
  [self secureWriteObject:legacy
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"legacy"
                                        workspaceId:DSHWorkspaceD revision:1]];
  NSArray *listed = [access listWorkspaceMetadataWithError:nil];
  XCTAssertEqual(listed.count, 4u);

  NSMutableDictionary *corrupt = [[self grantedAuthorityForWorkspace:DSHWorkspaceC
                                                               revision:1
                                                          bookmarkDigest:bookmarkDigest]
      mutableCopy];
  corrupt[@"native_path"] = @"/private/secret";
  [self secureWriteObject:corrupt
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"granted"
                                        workspaceId:DSHWorkspaceC revision:1]];
  NSError *error = nil;
  XCTAssertNil([access listWorkspaceMetadataWithError:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
  XCTAssertFalse([[self JSONText:error] containsString:@"/private/secret"]);

  [self secureWriteObject:[self grantedAuthorityForWorkspace:DSHWorkspaceC
                                                     revision:1
                                                bookmarkDigest:bookmarkDigest]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"granted"
                                        workspaceId:DSHWorkspaceC revision:1]];
  NSMutableDictionary *ownedCorrupt =
      [[self ownedAuthorityForWorkspace:DSHWorkspaceA
                               revision:1 directoryName:@"Owned A"] mutableCopy];
  ownedCorrupt[@"directory_name_sha256"] = DSHDigestA;
  [self secureWriteObject:ownedCorrupt
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"owned"
                                        workspaceId:DSHWorkspaceA revision:1]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);
  [self secureWriteObject:[self ownedAuthorityForWorkspace:DSHWorkspaceA
                                                   revision:1
                                              directoryName:@"Owned A"]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"owned"
                                        workspaceId:DSHWorkspaceA revision:1]];

  NSMutableDictionary *bookmarkCorrupt =
      [[self bookmarkAuthorityForWorkspace:DSHWorkspaceC
                                  revision:1 bytes:bookmark] mutableCopy];
  bookmarkCorrupt[@"bookmark_sha256"] = DSHDigestA;
  [self secureWriteObject:bookmarkCorrupt
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"bookmark"
                                        workspaceId:DSHWorkspaceC revision:1]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);

  NSData *oversizedBookmark = [NSMutableData
      dataWithLength:(256 * 1024) + 1];
  [self secureWriteObject:[self bookmarkAuthorityForWorkspace:DSHWorkspaceC
                                                      revision:1
                                                         bytes:oversizedBookmark]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"bookmark"
                                        workspaceId:DSHWorkspaceC revision:1]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);
  [self secureWriteObject:[self bookmarkAuthorityForWorkspace:DSHWorkspaceC
                                                      revision:1 bytes:bookmark]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"bookmark"
                                        workspaceId:DSHWorkspaceC revision:1]];

  NSMutableDictionary *legacyCorrupt = [legacy mutableCopy];
  legacyCorrupt[@"root_identity_sha256"] = @"not-a-digest";
  [self secureWriteObject:legacyCorrupt
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"legacy"
                                        workspaceId:DSHWorkspaceD revision:1]];
  XCTAssertNil([access listWorkspaceMetadataWithError:nil]);
}

- (void)testMetadataProbeHasZeroOperationalCapabilitiesAndDoesNotResolveLegacyRoot {
  DSHLocalWorkspaceAccess *access = [self access];
  NSError *error = nil;
  NSDictionary *workspace = [self bootstrapWithAccess:access
                                           operationId:DSHOperationA error:&error];
  XCTAssertNotNil(workspace);
  self.resolverCalls = 0;
  NSDictionary *probe = [self resolve:access revision:nil
                            capabilities:@[@"read"] error:&error];
  XCTAssertNotNil(probe);
  XCTAssertEqual(self.resolverCalls, 1u);
  NSDictionary *caps = probe[@"workspace"][@"capabilities"];
  XCTAssertEqualObjects(caps[@"read"], @NO);
  XCTAssertEqualObjects(caps[@"write"], @NO);
  XCTAssertEqualObjects(caps[@"git"], @NO);
  XCTAssertEqualObjects(caps[@"project_context"], @NO);

  self.resolverIdentity = DSHDigestB;
  NSDictionary *unavailable = [self resolve:access revision:nil
                                  capabilities:@[@"read"] error:&error];
  XCTAssertEqualObjects(unavailable[@"workspace"][@"status"], @"unavailable");
  XCTAssertEqualObjects(unavailable[@"workspace"][@"capabilities"][@"read"],
                        @NO);
}

- (void)testRegistryCapacityRejectsThe1025thMutationBeforePublication {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSMutableArray *records = [NSMutableArray arrayWithCapacity:1024];
  for (NSUInteger index = 0; index < 1024; index++) {
    NSString *workspace = [NSString stringWithFormat:
        @"%08lx-0000-4000-8000-%012lx", (unsigned long)index,
        (unsigned long)index];
    NSString *directory = [NSString stringWithFormat:@"Owned %04lu",
                           (unsigned long)index];
    [records addObject:[self recordForWorkspaceId:workspace
                                           origin:@"rish_created"
                                  rootLocatorKind:@"documents_owned"
                                    locationClass:@"rish_owned"
                              ownedDirectoryName:directory
                                 legacyProjectId:nil
                                 bindingRevision:1]];
  }
  [self writeRegistryRecords:records generation:7 root:self.rootURL];
  NSData *before = [NSData dataWithContentsOfURL:
      [self registryURLForRoot:self.rootURL]];
  NSError *error = nil;
  XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                   error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_BUSY");
  XCTAssertEqualObjects([NSData dataWithContentsOfURL:
      [self registryURLForRoot:self.rootURL]], before);
  XCTAssertFalse([NSFileManager.defaultManager
      fileExistsAtPath:[self journalURLForRoot:self.rootURL].path]);
  XCTAssertFalse([NSFileManager.defaultManager
      fileExistsAtPath:[self authorityURLForRoot:self.rootURL kind:@"legacy"
                                    workspaceId:DSHWorkspaceA revision:1].path]);
}

- (void)testRegistryGenerationOverflowFailsBeforeMutationEvidence {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  [self writeRegistryRecords:@[]
                   generation:(NSUInteger)9007199254740991ULL
                         root:self.rootURL];
  NSData *before = [NSData dataWithContentsOfURL:
      [self registryURLForRoot:self.rootURL]];
  NSError *error = nil;
  XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                   error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
  XCTAssertEqualObjects([NSData dataWithContentsOfURL:
      [self registryURLForRoot:self.rootURL]], before);
  XCTAssertFalse([NSFileManager.defaultManager
      fileExistsAtPath:[self journalURLForRoot:self.rootURL].path]);
  XCTAssertFalse([NSFileManager.defaultManager
      fileExistsAtPath:[self authorityURLForRoot:self.rootURL kind:@"legacy"
                                    workspaceId:DSHWorkspaceA revision:1].path]);
}

- (void)testMutationFailsClosedOnUnrelatedPublishedAuthorityCorruption {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSDictionary *owned = [self recordForWorkspaceId:DSHWorkspaceB
                                             origin:@"rish_created"
                                    rootLocatorKind:@"documents_owned"
                                      locationClass:@"rish_owned"
                                ownedDirectoryName:@"Missing authority"
                                   legacyProjectId:nil bindingRevision:1];
  [self writeRegistryRecords:@[owned] generation:1 root:self.rootURL];
  NSData *before = [NSData dataWithContentsOfURL:
      [self registryURLForRoot:self.rootURL]];
  NSError *error = nil;
  XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                   error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
  XCTAssertEqualObjects([NSData dataWithContentsOfURL:
      [self registryURLForRoot:self.rootURL]], before);
  XCTAssertFalse([NSFileManager.defaultManager
      fileExistsAtPath:[self journalURLForRoot:self.rootURL].path]);
  XCTAssertFalse([NSFileManager.defaultManager
      fileExistsAtPath:[self authorityURLForRoot:self.rootURL kind:@"legacy"
                                    workspaceId:DSHWorkspaceA revision:1].path]);
}

- (void)testOperationalResolveRequiresExactRevisionAndFailsBeforeAuthorityOpen {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertNotNil([self bootstrapWithAccess:access
                                operationId:DSHOperationA error:nil]);
  NSURL *authority = [self authorityURLForRoot:self.rootURL kind:@"legacy"
                                   workspaceId:DSHWorkspaceA revision:1];
  NSDictionary *originalAuthority = [NSJSONSerialization
      JSONObjectWithData:[NSData dataWithContentsOfURL:authority]
                 options:0 error:nil];
  [self secureWriteObject:@{@"corrupt": @YES} toURL:authority];

  NSError *error = nil;
  XCTAssertNil([self resolve:access revision:@2 capabilities:@[@"read"]
                       error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"],
                        @"E_WORKSPACE_REVISION_STALE");
  XCTAssertEqual(self.resolverCalls, 1u); // bootstrap only

  [self secureWriteObject:originalAuthority toURL:authority];
  NSDictionary *resolved = [self resolve:access revision:@1
                               capabilities:@[@"read", @"git"] error:&error];
  XCTAssertEqualObjects(resolved[@"disposition"], @"direct");
  XCTAssertEqualObjects(resolved[@"workspace"][@"capabilities"][@"read"], @YES);
  XCTAssertEqualObjects(resolved[@"workspace"][@"capabilities"][@"git"], @YES);
}

- (void)testRegistryCASRejectsOldGenerationAndDigestWithoutPublication {
  DSHLocalWorkspaceFaultHook hook = ^BOOL(NSString *stage) {
    return [stage isEqual:@"after_authority_ready"];
  };
  DSHLocalWorkspaceAccess *access = [self accessWithRoot:self.rootURL fault:hook];
  NSError *error = nil;
  XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                   error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
  [self writeRegistryRecords:@[] generation:1 root:self.rootURL];

  DSHLocalWorkspaceAccess *restarted = [self accessWithRoot:self.rootURL fault:nil];
  NSArray *listed = [restarted listWorkspaceMetadataWithError:&error];
  XCTAssertNotNil(listed);
  XCTAssertEqual(listed.count, 0u);
  NSDictionary *query = [restarted queryOperationId:DSHOperationA error:&error];
  XCTAssertEqualObjects(query[@"status"], @"not_started");
}

- (void)testConflictRecoveryClearsJournalWhenUnreferencedAuthorityWasAlreadyRemoved {
  DSHLocalWorkspaceAccess *access = [self accessWithRoot:self.rootURL
      fault:^BOOL(NSString *stage) {
        return [stage isEqual:@"after_authority_ready"];
      }];
  XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                   error:nil]);
  [self writeRegistryRecords:@[] generation:1 root:self.rootURL];
  NSURL *authority = [self authorityURLForRoot:self.rootURL kind:@"legacy"
                                   workspaceId:DSHWorkspaceA revision:1];
  XCTAssertTrue([NSFileManager.defaultManager removeItemAtURL:authority error:nil]);

  DSHLocalWorkspaceAccess *restarted = [self access];
  NSError *error = nil;
  NSArray *listed = [restarted listWorkspaceMetadataWithError:&error];
  XCTAssertNotNil(listed);
  XCTAssertEqual(listed.count, 0u);
  XCTAssertFalse([NSFileManager.defaultManager
      fileExistsAtPath:[self journalURLForRoot:self.rootURL].path]);
}

- (void)testThreePhaseRecoveryConvergesWithoutDuplicatePublication {
  for (NSString *stage in @[@"after_journal_prepared",
                            @"after_authority_write_before_journal",
                            @"after_authority_ready",
                            @"after_registry_publication_before_journal",
                            @"after_registry_committed",
                            @"after_receipt_written_before_journal_clear"]) {
    NSURL *root = [self.rootURL URLByAppendingPathComponent:stage
                                                isDirectory:YES];
    XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:root
                                         withIntermediateDirectories:YES
                                                          attributes:nil
                                                               error:nil]);
    DSHLocalWorkspaceAccess *access = [self accessWithRoot:root
        fault:^BOOL(NSString *candidate) {
          return [candidate isEqual:stage];
        }];
    NSError *error = nil;
    XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                     error:&error]);
    XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");

    NSData *registryBytes = [NSData dataWithContentsOfURL:[self registryURLForRoot:root]];
    NSString *registryText = [[NSString alloc] initWithData:registryBytes
                                                   encoding:NSUTF8StringEncoding];
    BOOL registryCommitted =
        [stage isEqual:@"after_registry_publication_before_journal"] ||
        [stage isEqual:@"after_registry_committed"] ||
        [stage isEqual:@"after_receipt_written_before_journal_clear"];
    XCTAssertEqual([registryText containsString:DSHWorkspaceA], registryCommitted);

    DSHLocalWorkspaceAccess *restarted = [self accessWithRoot:root fault:nil];
    NSArray *listed = [restarted listWorkspaceMetadataWithError:&error];
    XCTAssertNotNil(listed);
    if ([stage isEqual:@"after_journal_prepared"] ||
        [stage isEqual:@"after_authority_write_before_journal"]) {
      XCTAssertEqual(listed.count, 0u);
      XCTAssertNotNil([self bootstrapWithAccess:restarted
                                    operationId:DSHOperationA error:&error]);
    } else {
      XCTAssertEqual(listed.count, 1u);
    }
    XCTAssertEqual([restarted listWorkspaceMetadataWithError:&error].count, 1u);
    XCTAssertEqualObjects([restarted queryOperationId:DSHOperationA
                                                error:&error][@"status"],
                          @"committed");
  }
}

- (void)testUnsupportedFutureJournalFailsClosedWithoutDeletingEvidence {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSData *registryData =
      [NSData dataWithContentsOfURL:[self registryURLForRoot:self.rootURL]];
  NSDictionary *futureJournal = @{
    @"schema_version": @1,
    @"operation_id": DSHOperationA,
    @"workspace_id": DSHWorkspaceA,
    @"operation": @"create",
    @"phase": @"prepared",
    @"binding_revision": @1,
    @"previous_registry_generation": @0,
    @"previous_registry_sha256": [self sha256ForData:registryData],
    @"authority_sha256": NSNull.null,
    @"record_sha256": NSNull.null,
    @"staging_name": @"staging-a",
    @"destination_name": @"destination-a",
    @"legacy_project_id": NSNull.null,
    @"clearance_receipt_id": NSNull.null,
    @"confirmation_id": NSNull.null,
    @"created_at": DSHTimestamp,
    @"updated_at": DSHTimestamp,
  };
  [self secureWriteObject:futureJournal
                    toURL:[self journalURLForRoot:self.rootURL]];

  DSHLocalWorkspaceAccess *restarted = [self access];
  NSError *error = nil;
  XCTAssertNil([restarted listWorkspaceMetadataWithError:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
  XCTAssertTrue([NSFileManager.defaultManager
      fileExistsAtPath:[self journalURLForRoot:self.rootURL].path]);
}

- (void)testPreparedRecoveryNeverDeletesAuthorityReferencedByRegistry {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertNotNil([self bootstrapWithAccess:access
                                operationId:DSHOperationA error:nil]);
  NSData *registryData =
      [NSData dataWithContentsOfURL:[self registryURLForRoot:self.rootURL]];
  NSDictionary *prepared = @{
    @"schema_version": @1,
    @"operation_id": DSHOperationB,
    @"workspace_id": DSHWorkspaceA,
    @"operation": @"bootstrap_legacy",
    @"phase": @"prepared",
    @"binding_revision": @1,
    @"previous_registry_generation": @1,
    @"previous_registry_sha256": [self sha256ForData:registryData],
    @"authority_sha256": NSNull.null,
    @"record_sha256": NSNull.null,
    @"staging_name": NSNull.null,
    @"destination_name": NSNull.null,
    @"legacy_project_id": DSHProjectA,
    @"clearance_receipt_id": NSNull.null,
    @"confirmation_id": NSNull.null,
    @"created_at": DSHTimestamp,
    @"updated_at": DSHTimestamp,
  };
  [self secureWriteObject:prepared
                    toURL:[self journalURLForRoot:self.rootURL]];
  NSURL *authority = [self authorityURLForRoot:self.rootURL kind:@"legacy"
                                   workspaceId:DSHWorkspaceA revision:1];

  DSHLocalWorkspaceAccess *restarted = [self access];
  NSError *error = nil;
  XCTAssertNil([restarted listWorkspaceMetadataWithError:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
  XCTAssertTrue([NSFileManager.defaultManager fileExistsAtPath:authority.path]);
  XCTAssertTrue([NSFileManager.defaultManager
      fileExistsAtPath:[self journalURLForRoot:self.rootURL].path]);
}

- (void)testAuthorityReadyRecordIsInvisibleUntilRegistryPublication {
  DSHLocalWorkspaceAccess *access = [self accessWithRoot:self.rootURL
      fault:^BOOL(NSString *stage) {
        return [stage isEqual:@"after_authority_ready"];
      }];
  XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                   error:nil]);
  NSArray *listed = [access listWorkspaceMetadataWithError:nil];
  XCTAssertEqual(listed.count, 0u);
  XCTAssertTrue([NSFileManager.defaultManager
      fileExistsAtPath:[self authorityURLForRoot:self.rootURL kind:@"legacy"
                                    workspaceId:DSHWorkspaceA revision:1].path]);
}

- (void)testOperationIdRetryReturnsSameReceiptAcrossRestart {
  DSHLocalWorkspaceAccess *access = [self access];
  NSDictionary *first = [self bootstrapWithAccess:access
                                       operationId:DSHOperationA error:nil];
  XCTAssertNotNil(first);
  NSDictionary *second = [self bootstrapWithAccess:access
                                        operationId:DSHOperationA error:nil];
  XCTAssertEqualObjects(first, second);
  XCTAssertEqual([access listWorkspaceMetadataWithError:nil].count, 1u);

  DSHLocalWorkspaceAccess *restarted = [self access];
  NSDictionary *query = [restarted queryOperationId:DSHOperationA error:nil];
  XCTAssertEqualObjects(query[@"status"], @"committed");
  NSDictionary *third = [self bootstrapWithAccess:restarted
                                       operationId:DSHOperationA error:nil];
  XCTAssertEqualObjects(first, third);
  XCTAssertEqual([restarted listWorkspaceMetadataWithError:nil].count, 1u);

  NSError *error = nil;
  XCTAssertNil([restarted bootstrapLegacyProjectId:DSHProjectA
                                       displayName:@"Different Workspace"
                                        operationId:DSHOperationA
                                              error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_CONFLICT");

  NSURL *authority = [self authorityURLForRoot:self.rootURL kind:@"legacy"
                                   workspaceId:DSHWorkspaceA revision:1];
  NSDictionary *authorityObject = [NSJSONSerialization
      JSONObjectWithData:[NSData dataWithContentsOfURL:authority]
                 options:0 error:nil];
  XCTAssertTrue([NSFileManager.defaultManager removeItemAtURL:authority error:nil]);
  error = nil;
  XCTAssertNil([restarted bootstrapLegacyProjectId:DSHProjectA
                                       displayName:@"Legacy Workspace"
                                        operationId:DSHOperationA error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");

  [self secureWriteObject:authorityObject toURL:authority];
  self.resolverIdentity = DSHDigestB;
  NSDictionary *unavailable = [restarted bootstrapLegacyProjectId:DSHProjectA
                                                       displayName:@"Legacy Workspace"
                                                        operationId:DSHOperationA
                                                              error:nil];
  XCTAssertEqualObjects(unavailable[@"status"], @"unavailable");
}

- (void)testSameInstanceRetryRecoversPostAuthorityJournalBeforeNewUUID {
  NSArray<NSString *> *stages = @[
    @"after_authority_ready",
    @"after_registry_publication_before_journal",
    @"after_registry_committed",
    @"after_receipt_written_before_journal_clear",
  ];
  for (NSString *stage in stages) {
    NSURL *root = [self.rootURL URLByAppendingPathComponent:
        [@"same-instance-" stringByAppendingString:stage] isDirectory:YES];
    XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:root
                                         withIntermediateDirectories:YES
                                                          attributes:nil
                                                               error:nil]);
    __block NSString *nextWorkspaceId = DSHWorkspaceA;
    __block BOOL faultInjected = NO;
    DSHLocalWorkspaceAccess *access = [self accessWithRoot:root
        fault:^BOOL(NSString *candidate) {
          if (!faultInjected && [candidate isEqual:stage]) {
            faultInjected = YES;
            return YES;
          }
          return NO;
        }
        UUIDGenerator:^NSString *{
          return nextWorkspaceId;
        }];
    NSError *error = nil;
    XCTAssertNil([access bootstrapLegacyProjectId:DSHProjectA
                                       displayName:@"Stable request"
                                        operationId:DSHOperationA error:&error]);
    XCTAssertTrue(faultInjected);
    nextWorkspaceId = DSHWorkspaceB;
    self.now = [self.now dateByAddingTimeInterval:1];
    error = nil;

    NSDictionary *retried = [access bootstrapLegacyProjectId:DSHProjectA
                                                   displayName:@"Stable request"
                                                    operationId:DSHOperationA
                                                          error:&error];
    XCTAssertNotNil(retried, @"stage %@", stage);
    XCTAssertEqualObjects(retried[@"workspace_id"], DSHWorkspaceA,
                          @"stage %@", stage);
    XCTAssertEqual([access listWorkspaceMetadataWithError:&error].count, 1u);
    XCTAssertEqualObjects([access queryOperationId:DSHOperationA
                                             error:&error][@"status"],
                          @"committed");
  }
}

- (void)testAccessInstancesShareOneAuthorityExecutor {
  dispatch_semaphore_t authorityReady = dispatch_semaphore_create(0);
  dispatch_semaphore_t releaseFirst = dispatch_semaphore_create(0);
  dispatch_semaphore_t firstDone = dispatch_semaphore_create(0);
  dispatch_semaphore_t secondDone = dispatch_semaphore_create(0);
  DSHLocalWorkspaceAccess *first = [self accessWithRoot:self.rootURL
      fault:^BOOL(NSString *stage) {
        if ([stage isEqual:@"after_authority_ready"]) {
          dispatch_semaphore_signal(authorityReady);
          dispatch_semaphore_wait(releaseFirst,
              dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        }
        return NO;
      }
      workspaceId:DSHWorkspaceA];
  DSHLocalWorkspaceAccess *second = [self accessWithRoot:self.rootURL
                                                   fault:nil
                                             workspaceId:DSHWorkspaceB];
  XCTAssertTrue([first ensurePrivateLayoutWithError:nil]);
  XCTAssertTrue([second ensurePrivateLayoutWithError:nil]);
  __block NSDictionary *firstResult = nil;
  __block NSDictionary *secondResult = nil;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    firstResult = [first bootstrapLegacyProjectId:DSHProjectA
                                       displayName:@"First"
                                        operationId:DSHOperationA error:nil];
    dispatch_semaphore_signal(firstDone);
  });
  XCTAssertEqual(dispatch_semaphore_wait(authorityReady,
      dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)), 0l);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    secondResult = [second bootstrapLegacyProjectId:DSHProjectWide
                                         displayName:@"Second"
                                          operationId:DSHOperationB error:nil];
    dispatch_semaphore_signal(secondDone);
  });
  XCTAssertNotEqual(dispatch_semaphore_wait(secondDone,
      dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC)), 0l);
  dispatch_semaphore_signal(releaseFirst);
  XCTAssertEqual(dispatch_semaphore_wait(firstDone,
      dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)), 0l);
  XCTAssertEqual(dispatch_semaphore_wait(secondDone,
      dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)), 0l);
  XCTAssertNotNil(firstResult);
  XCTAssertNotNil(secondResult);
  XCTAssertEqual([[self access] listWorkspaceMetadataWithError:nil].count, 2u);
}

- (void)testLegacyBootstrapAcceptsCanonicalUUIDOutsideVersionAndVariantSubset {
  DSHLocalWorkspaceAccess *access = [self access];
  NSError *error = nil;
  NSDictionary *workspace = [access bootstrapLegacyProjectId:DSHProjectWide
                                                   displayName:@"Wide UUID"
                                                    operationId:DSHOperationA
                                                          error:&error];
  XCTAssertNotNil(workspace);
  XCTAssertNil(error);
}

- (NSDictionary *)receiptWithIndex:(NSUInteger)index committedAt:(NSString *)timestamp {
  NSString *operationId = [NSString stringWithFormat:@"%08lx-0000-4000-8000-%012lx",
                           (unsigned long)index, (unsigned long)index];
  return @{
    @"schema_version": @1,
    @"operation_id": operationId,
    @"workspace_id": DSHWorkspaceB,
    @"operation": @"bootstrap_legacy",
    @"binding_revision": @1,
    @"registry_generation": @1,
    @"registry_sha256": DSHDigestA,
    @"outcome": @"committed",
    @"committed_at": timestamp,
  };
}

- (void)testReceiptTTLPrunesExpiredCapacityAndSurvivesRestart {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSMutableArray *receipts = [NSMutableArray arrayWithCapacity:2048];
  for (NSUInteger index = 0; index < 2048; index++) {
    [receipts addObject:[self receiptWithIndex:index committedAt:DSHTimestamp]];
  }
  [self secureWriteObject:@{@"schema_version": @1, @"receipts": receipts}
                    toURL:[self receiptsURLForRoot:self.rootURL]];
  NSError *error = nil;
  XCTAssertNil([self bootstrapWithAccess:access operationId:DSHOperationA
                                   error:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_BUSY");

  self.now = [self.now dateByAddingTimeInterval:31 * 24 * 60 * 60];
  DSHLocalWorkspaceAccess *restarted = [self access];
  XCTAssertNotNil([self bootstrapWithAccess:restarted
                                operationId:DSHOperationA error:&error]);
  XCTAssertEqualObjects([restarted queryOperationId:DSHOperationA
                                              error:&error][@"status"],
                        @"committed");
}

- (void)testReceiptStoreRejectsImpossibleBootstrapOutcomeAndRevision {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSMutableDictionary *impossible =
      [[self receiptWithIndex:9 committedAt:DSHTimestamp] mutableCopy];
  impossible[@"outcome"] = @"purge_pending";
  [self secureWriteObject:@{@"schema_version": @1,
                            @"receipts": @[impossible]}
                    toURL:[self receiptsURLForRoot:self.rootURL]];
  XCTAssertNil([access queryOperationId:impossible[@"operation_id"] error:nil]);

  impossible[@"outcome"] = @"committed";
  impossible[@"binding_revision"] = @2;
  [self secureWriteObject:@{@"schema_version": @1,
                            @"receipts": @[impossible]}
                    toURL:[self receiptsURLForRoot:self.rootURL]];
  XCTAssertNil([access queryOperationId:impossible[@"operation_id"] error:nil]);
}

- (void)testRevisionStartsAtOneIncrementsMonotonicallyAndOverflowsClosed {
  DSHLocalWorkspaceAccess *access = [self access];
  NSDictionary *created = [self bootstrapWithAccess:access
                                        operationId:DSHOperationA error:nil];
  XCTAssertEqualObjects(created[@"binding_revision"], @1);

  NSError *error = nil;
  XCTAssertTrue(DSHLocalWorkspaceValidateBindingRevisionAdvance(@1, @2, &error));
  XCTAssertNil(error);
  XCTAssertFalse(DSHLocalWorkspaceValidateBindingRevisionAdvance(@2, @4, &error));
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_CONFLICT");
  XCTAssertFalse(DSHLocalWorkspaceValidateBindingRevisionAdvance(
      @((NSUInteger)9007199254740991ULL),
      @((NSUInteger)9007199254740991ULL), &error));
  XCTAssertEqualObjects(error.userInfo[@"code"],
                        @"E_WORKSPACE_REVISION_OVERFLOW");
}

- (void)testMalformedJournalReceiptRootReplacementAndForeignExceptionsAreValueFree {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  [self secureWriteObject:@{@"schema_version": @1, @"native_error": @"secret"}
                    toURL:[self journalURLForRoot:self.rootURL]];
  NSError *error = nil;
  XCTAssertNil([access listWorkspaceMetadataWithError:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_PERSISTENCE");
  XCTAssertFalse([[self JSONText:error] containsString:@"secret"]);

  [NSFileManager.defaultManager removeItemAtURL:[self journalURLForRoot:self.rootURL]
                                          error:nil];
  [self secureWriteObject:@{@"schema_version": @1,
                            @"receipts": @[@{@"bad": @"/private/secret"}]}
                    toURL:[self receiptsURLForRoot:self.rootURL]];
  DSHLocalWorkspaceAccess *receiptReader = [self access];
  XCTAssertNil([receiptReader queryOperationId:DSHOperationA error:&error]);
  XCTAssertFalse([[self JSONText:error] containsString:@"/private/secret"]);

  NSURL *moved = [self.rootURL URLByAppendingPathExtension:@"moved"];
  XCTAssertTrue([NSFileManager.defaultManager moveItemAtURL:self.rootURL
                                                     toURL:moved error:nil]);
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:self.rootURL
                                       withIntermediateDirectories:YES
                                                        attributes:nil error:nil]);
  XCTAssertNil([access listWorkspaceMetadataWithError:&error]);
  XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_UNAVAILABLE");
  [NSFileManager.defaultManager removeItemAtURL:moved error:nil];

  NSURL *throwRoot = [self.rootURL URLByAppendingPathComponent:@"throw"
                                                   isDirectory:YES];
  XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtURL:throwRoot
                                       withIntermediateDirectories:YES
                                                        attributes:nil error:nil]);
  self.resolverThrows = YES;
  DSHLocalWorkspaceAccess *throwing = [self accessWithRoot:throwRoot fault:nil];
  XCTAssertNil([self bootstrapWithAccess:throwing operationId:DSHOperationA
                                   error:&error]);
  NSString *errorText = [self JSONText:error];
  XCTAssertFalse([errorText containsString:@"PrivateResolverFailure"]);
  XCTAssertFalse([errorText containsString:@"/private/secret"]);
}

- (void)testPublicOutputsNeverExposePathsBookmarkBytesInodesOrNativeErrors {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertNotNil([self bootstrapWithAccess:access
                                operationId:DSHOperationA error:nil]);
  NSArray *listed = [access listWorkspaceMetadataWithError:nil];
  NSDictionary *resolved = [self resolve:access revision:@1
                               capabilities:@[@"read"] error:nil];
  NSDictionary *query = [access queryOperationId:DSHOperationA error:nil];
  NSString *text = [self JSONText:@{ @"list": listed,
                                     @"resolved": resolved,
                                     @"query": query }];
  for (NSString *forbidden in @[@"/private/", @"bookmark_bytes_base64",
                                @"PRIVATE_BOOKMARK_BYTES", @"inode_id",
                                @"device_id", @"root_identity_sha256",
                                @"native_error"]) {
    XCTAssertFalse([text containsString:forbidden], @"leaked %@", forbidden);
  }
  [self assertDictionary:listed.firstObject hasExactKeys:@[
    @"schema_version", @"workspace_id", @"display_name", @"origin", @"status",
    @"binding_revision", @"capabilities", @"created_at", @"last_opened_at"
  ]];
  [self assertDictionary:listed.firstObject[@"capabilities"] hasExactKeys:@[
    @"read", @"write", @"git", @"project_context", @"files_visible"
  ]];
  [self assertDictionary:resolved
             hasExactKeys:@[@"schema_version", @"disposition", @"workspace"]];
  [self assertDictionary:query
             hasExactKeys:@[@"schema_version", @"status", @"receipt"]];
  [self assertDictionary:query[@"receipt"] hasExactKeys:@[
    @"schema_version", @"operation_id", @"workspace_id", @"operation",
    @"binding_revision", @"registry_generation", @"registry_sha256",
    @"outcome", @"committed_at"
  ]];
}

- (void)testDocumentsAndGrantedOperationalResolveFailUnavailableWithZeroCapabilities {
  DSHLocalWorkspaceAccess *access = [self access];
  XCTAssertTrue([access ensurePrivateLayoutWithError:nil]);
  NSData *bookmark = [@"BOOKMARK" dataUsingEncoding:NSUTF8StringEncoding];
  NSString *bookmarkDigest = [self sha256ForData:bookmark];
  NSArray *records = @[
    [self recordForWorkspaceId:DSHWorkspaceA origin:@"rish_created"
               rootLocatorKind:@"documents_owned" locationClass:@"rish_owned"
         ownedDirectoryName:@"Owned A" legacyProjectId:nil bindingRevision:1],
    [self recordForWorkspaceId:DSHWorkspaceB origin:@"granted_folder"
               rootLocatorKind:@"security_scoped" locationClass:@"proven_local"
         ownedDirectoryName:nil legacyProjectId:nil bindingRevision:1],
  ];
  [self writeRegistryRecords:records generation:1 root:self.rootURL];
  [self secureWriteObject:[self ownedAuthorityForWorkspace:DSHWorkspaceA
                                                   revision:1 directoryName:@"Owned A"]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"owned"
                                        workspaceId:DSHWorkspaceA revision:1]];
  [self secureWriteObject:[self bookmarkAuthorityForWorkspace:DSHWorkspaceB
                                                      revision:1 bytes:bookmark]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"bookmark"
                                        workspaceId:DSHWorkspaceB revision:1]];
  [self secureWriteObject:[self grantedAuthorityForWorkspace:DSHWorkspaceB
                                                     revision:1
                                                bookmarkDigest:bookmarkDigest]
                    toURL:[self authorityURLForRoot:self.rootURL kind:@"granted"
                                        workspaceId:DSHWorkspaceB revision:1]];

  NSArray *listed = [access listWorkspaceMetadataWithError:nil];
  XCTAssertEqual(listed.count, 2u);
  for (NSDictionary *descriptor in listed) {
    XCTAssertEqualObjects(descriptor[@"status"], @"unavailable");
    XCTAssertEqualObjects(descriptor[@"capabilities"][@"read"], @NO);
    XCTAssertEqualObjects(descriptor[@"capabilities"][@"write"], @NO);
    XCTAssertEqualObjects(descriptor[@"capabilities"][@"git"], @NO);
    XCTAssertEqualObjects(descriptor[@"capabilities"][@"project_context"], @NO);
    BOOL owned = [descriptor[@"workspace_id"] isEqual:DSHWorkspaceA];
    XCTAssertEqualObjects(descriptor[@"capabilities"][@"files_visible"],
                          @(owned));
    NSDictionary *probe = [access resolveWorkspaceId:descriptor[@"workspace_id"]
                             expectedBindingRevision:nil
                                requiredCapabilities:@[@"read"] error:nil];
    XCTAssertEqualObjects(probe[@"workspace"][@"status"], @"unavailable");
    XCTAssertEqualObjects(probe[@"workspace"][@"capabilities"][@"read"], @NO);
  }

  for (NSString *workspace in @[DSHWorkspaceA, DSHWorkspaceB]) {
    NSError *error = nil;
    NSDictionary *result = [access resolveWorkspaceId:workspace
                               expectedBindingRevision:@1
                                  requiredCapabilities:@[@"read"]
                                                 error:&error];
    XCTAssertNil(result);
    XCTAssertEqualObjects(error.userInfo[@"code"], @"E_WORKSPACE_UNAVAILABLE");
  }
  XCTAssertEqual(self.resolverCalls, 0u);
}

@end
