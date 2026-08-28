#import "ProjectContextService.h"

#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>

#include <math.h>

static NSString *const DSHPCRequestInvalid = @"E_CONTEXT_REQUEST_INVALID";
static NSString *const DSHPCResultInvalid = @"E_CONTEXT_RESULT_INVALID";
static NSString *const DSHPCBusy = @"E_CONTEXT_BUSY";
static NSString *const DSHPCCancelled = @"E_CONTEXT_CANCELLED";
static NSString *const DSHPCNative = @"E_CONTEXT_NATIVE";

static NSDictionary *DSHPCDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSArray *DSHPCArray(id value) {
  return [value isKindOfClass:NSArray.class] ? value : nil;
}

static NSString *DSHPCString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static BOOL DSHPCExactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
  if (![value isKindOfClass:NSDictionary.class] || value.count != keys.count) {
    return NO;
  }
  return [[NSSet setWithArray:value.allKeys]
      isEqualToSet:[NSSet setWithArray:keys]];
}

static BOOL DSHPCSafeInteger(id value, uint64_t maximum, uint64_t *output) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() ||
      [value isKindOfClass:NSDecimalNumber.class]) {
    return NO;
  }
  NSNumber *number = value;
  double bridged = number.doubleValue;
  if (!isfinite(bridged) || signbit(bridged) || floor(bridged) != bridged ||
      bridged > (double)maximum) return NO;
  uint64_t exact = number.unsignedLongLongValue;
  if ((double)exact != bridged || exact > maximum) return NO;
  if (output != nullptr) *output = exact;
  return YES;
}

static BOOL DSHPCBoolean(id value, BOOL *output) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()) {
    return NO;
  }
  if (output != nullptr) *output = ((NSNumber *)value).boolValue;
  return YES;
}

static NSString *DSHPCBoundedString(id value, NSUInteger maximumBytes,
                                    BOOL allowEmpty) {
  NSString *string = DSHPCString(value);
  NSData *data = [string dataUsingEncoding:NSUTF8StringEncoding];
  if (string == nil || data == nil || data.length > maximumBytes ||
      (!allowEmpty && string.length == 0)) {
    return nil;
  }
  return [string copy];
}

static NSString *DSHPCCanonicalIdentifier(id value) {
  NSString *candidate = DSHPCString(value);
  if (candidate.length != 36 ||
      ![candidate isEqualToString:candidate.lowercaseString]) {
    return nil;
  }
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:candidate];
  NSString *canonical = uuid.UUIDString.lowercaseString;
  return [canonical isEqualToString:candidate] ? canonical : nil;
}

static BOOL DSHPCMatches(NSString *value, NSString *pattern) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSRange range = [value rangeOfString:pattern
                               options:NSRegularExpressionSearch];
  return range.location == 0 && range.length == value.length;
}

static NSString *DSHPCDigest(id value) {
  NSString *string = DSHPCString(value);
  return DSHPCMatches(string, @"[0-9a-f]{64}") ? [string copy] : nil;
}

static NSString *DSHPCHeadOid(id value) {
  if (value == NSNull.null) return (NSString *)NSNull.null;
  NSString *string = DSHPCString(value);
  return DSHPCMatches(string, @"[0-9a-f]{40}") ? [string copy] : nil;
}

static BOOL DSHPCTimestamp(id value) {
  NSString *string = DSHPCBoundedString(value, 64, NO);
  if (string == nil) return NO;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  if ([formatter dateFromString:string] != nil) return YES;
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter dateFromString:string] != nil;
}

static NSString *DSHPCSafeRelativePath(id value) {
  NSString *path = DSHPCBoundedString(value, 4096, NO);
  if (path == nil || [path hasPrefix:@"/"] || [path containsString:@"\\"] ||
      [path rangeOfString:@"\0"].location != NSNotFound) {
    return nil;
  }
  NSArray<NSString *> *components = [path componentsSeparatedByString:@"/"];
  if (components.count == 0) return nil;
  NSCharacterSet *controls = [NSCharacterSet controlCharacterSet];
  if ([path rangeOfCharacterFromSet:controls].location != NSNotFound) return nil;
  for (NSString *component in components) {
    if (component.length == 0 || [component isEqualToString:@"."] ||
        [component isEqualToString:@".."]) {
      return nil;
    }
  }
  return [path copy];
}

static NSString *DSHPCGitBranch(id value) {
  if (value == NSNull.null) return (NSString *)NSNull.null;
  NSString *branch = DSHPCBoundedString(value, 1024, NO);
  if (branch == nil || [branch isEqualToString:@"@"] ||
      [branch rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet]
              .location != NSNotFound) {
    return nil;
  }
  NSString *fullName = [@"refs/heads/" stringByAppendingString:branch];
  int valid = 0;
  if (git_reference_name_is_valid(&valid, fullName.UTF8String) != 0 ||
      valid != 1) {
    return nil;
  }
  return [branch copy];
}

static NSString *DSHPCProjectName(id value) {
  NSString *name = DSHPCBoundedString(value, 120, NO);
  NSString *trimmed = [name stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (name == nil || ![trimmed isEqualToString:name] ||
      [name rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet]
              .location != NSNotFound ||
      [name containsString:@"/"] || [name containsString:@"\\"] ||
      [name isEqualToString:@"."] || [name isEqualToString:@".."]) {
    return nil;
  }
  return [name copy];
}

static NSString *DSHPCCursor(id value, BOOL allowNull) {
  if (allowNull && (value == nil || value == NSNull.null)) {
    return (NSString *)NSNull.null;
  }
  NSString *cursor = DSHPCString(value);
  return cursor.length == 98 && DSHPCMatches(cursor, @"[A-Za-z0-9_-]{98}")
      ? [cursor copy] : nil;
}

static NSSet<NSString *> *DSHPCModels(void) {
  static NSSet<NSString *> *values = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    values = [NSSet setWithArray:@[
      @"deepseek-v4-flash", @"deepseek-v4-pro",
      @"deepseek-v4-flash-vision-exp",
    ]];
  });
  return values;
}

static NSSet<NSString *> *DSHPCOmissionReasons(void) {
  static NSSet<NSString *> *values = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    values = [NSSet setWithArray:@[
      @"secret_path", @"generated", @"lockfile", @"suspected_secret",
      @"binary", @"invalid_encoding", @"not_tracked", @"budget_exceeded",
      @"policy",
    ]];
  });
  return values;
}

static NSDictionary *DSHPCSelection(id raw) {
  NSDictionary *selection = DSHPCDictionary(raw);
  NSArray *keys = @[
    @"schema_version", @"project_id", @"conversation_id", @"provider",
    @"model", @"policy", @"selected_paths",
  ];
  uint64_t schema = 0;
  NSString *projectId = DSHPCCanonicalIdentifier(selection[@"project_id"]);
  NSString *conversationId =
      DSHPCCanonicalIdentifier(selection[@"conversation_id"]);
  NSString *model = DSHPCString(selection[@"model"]);
  NSArray *paths = DSHPCArray(selection[@"selected_paths"]);
  if (!DSHPCExactKeys(selection, keys) ||
      !DSHPCSafeInteger(selection[@"schema_version"], 1, &schema) ||
      schema != 1 || projectId == nil || conversationId == nil ||
      ![selection[@"provider"] isEqual:@"deepseek"] ||
      ![DSHPCModels() containsObject:model] ||
      ![selection[@"policy"] isEqual:@"chat-read-v1"] || paths == nil ||
      paths.count > 5000) {
    return nil;
  }
  NSMutableArray<NSString *> *normalized =
      [NSMutableArray arrayWithCapacity:paths.count];
  NSMutableSet<NSString *> *seen = [NSMutableSet setWithCapacity:paths.count];
  for (id value in paths) {
    NSString *path = DSHPCSafeRelativePath(value);
    if (path == nil || [seen containsObject:path]) return nil;
    [seen addObject:path];
    [normalized addObject:path];
  }
  [normalized sortUsingSelector:@selector(compare:)];
  return @{
    @"schema_version": @1,
    @"project_id": projectId,
    @"conversation_id": conversationId,
    @"provider": @"deepseek",
    @"model": [model copy],
    @"policy": @"chat-read-v1",
    @"selected_paths": [normalized copy],
  };
}

static NSDictionary *DSHPCCandidate(id raw) {
  NSDictionary *candidate = DSHPCDictionary(raw);
  NSArray *keys = @[
    @"path", @"size", @"revision", @"git_state", @"eligible",
    @"omission_reason",
  ];
  NSString *path = DSHPCSafeRelativePath(candidate[@"path"]);
  uint64_t size = 0;
  NSString *revision = DSHPCString(candidate[@"revision"]);
  NSString *gitState = DSHPCString(candidate[@"git_state"]);
  BOOL eligible = NO;
  id omissionValue = candidate[@"omission_reason"];
  NSString *omission = omissionValue == NSNull.null
      ? (NSString *)NSNull.null : DSHPCString(omissionValue);
  BOOL revisionValid = DSHPCMatches(revision, @"[0-9a-f]{40}") ||
      DSHPCMatches(revision, @"[0-9a-f]{64}");
  NSSet *states = [NSSet setWithArray:
      @[@"unchanged", @"staged", @"unstaged", @"conflicted"]];
  if (!DSHPCExactKeys(candidate, keys) || path == nil ||
      !DSHPCSafeInteger(candidate[@"size"], 9007199254740991ULL, &size) ||
      !revisionValid || ![states containsObject:gitState] ||
      !DSHPCBoolean(candidate[@"eligible"], &eligible) || omission == nil ||
      (omission != (id)NSNull.null &&
       ![DSHPCOmissionReasons() containsObject:omission]) ||
      eligible != (omission == (id)NSNull.null)) {
    return nil;
  }
  return @{
    @"path": path,
    @"size": @(size),
    @"revision": [revision copy],
    @"git_state": [gitState copy],
    @"eligible": @(eligible),
    @"omission_reason": omission,
  };
}

static NSDictionary *DSHPCCandidatePage(id raw, NSString *expectedProjectId) {
  NSDictionary *page = DSHPCDictionary(raw);
  NSArray *keys = @[
    @"schema_version", @"project_id", @"candidates", @"next_cursor",
  ];
  uint64_t schema = 0;
  NSString *projectId = DSHPCCanonicalIdentifier(page[@"project_id"]);
  NSArray *candidates = DSHPCArray(page[@"candidates"]);
  NSString *cursor = DSHPCCursor(page[@"next_cursor"], YES);
  if (!DSHPCExactKeys(page, keys) ||
      !DSHPCSafeInteger(page[@"schema_version"], 1, &schema) || schema != 1 ||
      ![projectId isEqualToString:expectedProjectId] || candidates == nil ||
      candidates.count > 100 || cursor == nil) {
    return nil;
  }
  NSMutableArray *projected = [NSMutableArray arrayWithCapacity:candidates.count];
  NSMutableSet *paths = [NSMutableSet set];
  for (id rawCandidate in candidates) {
    NSDictionary *candidate = DSHPCCandidate(rawCandidate);
    if (candidate == nil || [paths containsObject:candidate[@"path"]]) return nil;
    [paths addObject:candidate[@"path"]];
    [projected addObject:candidate];
  }
  return @{
    @"schema_version": @1,
    @"project_id": projectId,
    @"candidates": [projected copy],
    @"next_cursor": cursor,
  };
}

static NSDictionary *DSHPCIncluded(id raw) {
  NSDictionary *item = DSHPCDictionary(raw);
  NSArray *keys = @[@"path", @"source", @"bytes", @"sha256"];
  NSString *path = DSHPCSafeRelativePath(item[@"path"]);
  NSString *source = DSHPCString(item[@"source"]);
  uint64_t bytes = 0;
  NSSet *sources = [NSSet setWithArray:
      @[@"tracked_file", @"staged_diff", @"worktree_diff"]];
  if (!DSHPCExactKeys(item, keys) || path == nil ||
      ![sources containsObject:source] ||
      !DSHPCSafeInteger(item[@"bytes"], 256 * 1024, &bytes) ||
      DSHPCDigest(item[@"sha256"]) == nil) {
    return nil;
  }
  return @{
    @"path": path, @"source": [source copy], @"bytes": @(bytes),
    @"sha256": DSHPCDigest(item[@"sha256"]),
  };
}

static NSDictionary *DSHPCOmitted(id raw) {
  NSDictionary *item = DSHPCDictionary(raw);
  if (!DSHPCExactKeys(item, @[@"path", @"reason"])) return nil;
  NSString *path = DSHPCSafeRelativePath(item[@"path"]);
  NSString *reason = DSHPCString(item[@"reason"]);
  if (path == nil || ![DSHPCOmissionReasons() containsObject:reason]) return nil;
  return @{@"path": path, @"reason": [reason copy]};
}

static NSDictionary *DSHPCManifest(id raw, NSString *expectedProjectId,
                                   NSString *expectedSnapshotId,
                                   NSString *expectedModel) {
  NSDictionary *manifest = DSHPCDictionary(raw);
  NSArray *keys = @[
    @"schema_version", @"snapshot_id", @"project_id", @"project_name",
    @"branch", @"head_oid", @"clean", @"conflicted", @"captured_at",
    @"policy_version", @"provider_host", @"model", @"included", @"omitted",
    @"context_bytes", @"estimated_tokens", @"snapshot_sha256",
    @"source_fingerprint",
  ];
  uint64_t schema = 0;
  uint64_t contextBytes = 0;
  uint64_t estimatedTokens = 0;
  NSString *snapshotId = DSHPCCanonicalIdentifier(manifest[@"snapshot_id"]);
  NSString *projectId = DSHPCCanonicalIdentifier(manifest[@"project_id"]);
  NSString *projectName = DSHPCProjectName(manifest[@"project_name"]);
  NSString *branch = DSHPCGitBranch(manifest[@"branch"]);
  NSString *headOid = DSHPCHeadOid(manifest[@"head_oid"]);
  BOOL clean = NO;
  BOOL conflicted = NO;
  NSString *model = DSHPCString(manifest[@"model"]);
  NSArray *included = DSHPCArray(manifest[@"included"]);
  NSArray *omitted = DSHPCArray(manifest[@"omitted"]);
  if (!DSHPCExactKeys(manifest, keys) ||
      !DSHPCSafeInteger(manifest[@"schema_version"], 1, &schema) || schema != 1 ||
      snapshotId == nil || projectId == nil || projectName == nil ||
      branch == nil || headOid == nil ||
      !DSHPCBoolean(manifest[@"clean"], &clean) ||
      !DSHPCBoolean(manifest[@"conflicted"], &conflicted) ||
      (clean && conflicted) || !DSHPCTimestamp(manifest[@"captured_at"]) ||
      ![manifest[@"policy_version"] isEqual:@"chat-read-v1.0.0"] ||
      ![manifest[@"provider_host"] isEqual:@"api.deepseek.com"] ||
      ![DSHPCModels() containsObject:model] || included == nil ||
      included.count > 32 || omitted == nil || omitted.count > 5000 ||
      !DSHPCSafeInteger(manifest[@"context_bytes"], 256 * 1024,
                        &contextBytes) || contextBytes == 0 ||
      !DSHPCSafeInteger(manifest[@"estimated_tokens"], 65536,
                        &estimatedTokens) ||
      estimatedTokens != (contextBytes + 3) / 4 ||
      DSHPCDigest(manifest[@"snapshot_sha256"]) == nil ||
      DSHPCDigest(manifest[@"source_fingerprint"]) == nil ||
      (expectedProjectId != nil && ![projectId isEqual:expectedProjectId]) ||
      (expectedSnapshotId != nil && ![snapshotId isEqual:expectedSnapshotId]) ||
      (expectedModel != nil && ![model isEqual:expectedModel])) {
    return nil;
  }
  NSMutableArray *projectedIncluded =
      [NSMutableArray arrayWithCapacity:included.count];
  NSMutableSet *includedIdentity = [NSMutableSet set];
  for (id rawItem in included) {
    NSDictionary *item = DSHPCIncluded(rawItem);
    NSString *identity = item == nil ? nil :
        [NSString stringWithFormat:@"%@\n%@", item[@"path"], item[@"source"]];
    if (item == nil || [includedIdentity containsObject:identity]) return nil;
    [includedIdentity addObject:identity];
    [projectedIncluded addObject:item];
  }
  NSMutableArray *projectedOmitted =
      [NSMutableArray arrayWithCapacity:omitted.count];
  NSMutableSet *omittedIdentity = [NSMutableSet set];
  for (id rawItem in omitted) {
    NSDictionary *item = DSHPCOmitted(rawItem);
    NSString *identity = item == nil ? nil :
        [NSString stringWithFormat:@"%@\n%@", item[@"path"], item[@"reason"]];
    if (item == nil || [omittedIdentity containsObject:identity]) return nil;
    [omittedIdentity addObject:identity];
    [projectedOmitted addObject:item];
  }
  return @{
    @"schema_version": @1,
    @"snapshot_id": snapshotId,
    @"project_id": projectId,
    @"project_name": projectName,
    @"branch": branch,
    @"head_oid": headOid,
    @"clean": @(clean),
    @"conflicted": @(conflicted),
    @"captured_at": [manifest[@"captured_at"] copy],
    @"policy_version": @"chat-read-v1.0.0",
    @"provider_host": @"api.deepseek.com",
    @"model": [model copy],
    @"included": [projectedIncluded copy],
    @"omitted": [projectedOmitted copy],
    @"context_bytes": @(contextBytes),
    @"estimated_tokens": @(estimatedTokens),
    @"snapshot_sha256": DSHPCDigest(manifest[@"snapshot_sha256"]),
    @"source_fingerprint": DSHPCDigest(manifest[@"source_fingerprint"]),
  };
}

static NSDictionary *DSHPCConsent(id raw, NSString *expectedSnapshotId) {
  NSDictionary *consent = DSHPCDictionary(raw);
  NSArray *keys = @[
    @"schema_version", @"consent_receipt_id", @"snapshot_id",
    @"snapshot_sha256", @"confirmed_at",
  ];
  uint64_t schema = 0;
  NSString *receiptId =
      DSHPCCanonicalIdentifier(consent[@"consent_receipt_id"]);
  NSString *snapshotId = DSHPCCanonicalIdentifier(consent[@"snapshot_id"]);
  if (!DSHPCExactKeys(consent, keys) ||
      !DSHPCSafeInteger(consent[@"schema_version"], 1, &schema) || schema != 1 ||
      receiptId == nil || ![snapshotId isEqual:expectedSnapshotId] ||
      DSHPCDigest(consent[@"snapshot_sha256"]) == nil ||
      !DSHPCTimestamp(consent[@"confirmed_at"])) {
    return nil;
  }
  return @{
    @"schema_version": @1,
    @"consent_receipt_id": receiptId,
    @"snapshot_id": snapshotId,
    @"snapshot_sha256": DSHPCDigest(consent[@"snapshot_sha256"]),
    @"confirmed_at": [consent[@"confirmed_at"] copy],
  };
}

static NSDictionary *DSHPCInspection(id raw, NSString *expectedSnapshotId) {
  NSDictionary *inspection = DSHPCDictionary(raw);
  if (inspection == nil || inspection.count != 19) return nil;
  NSString *state = DSHPCString(inspection[@"state"]);
  NSSet *states = [NSSet setWithArray:@[@"prepared", @"confirmed", @"stale"]];
  if (![states containsObject:state]) return nil;
  NSMutableDictionary *rawManifest = [inspection mutableCopy];
  [rawManifest removeObjectForKey:@"state"];
  NSDictionary *manifest = DSHPCManifest(rawManifest, nil, expectedSnapshotId, nil);
  if (manifest == nil) return nil;
  return @{
    @"schema_version": @1,
    @"state": [state copy],
    @"manifest": manifest,
  };
}

static NSString *DSHPCServiceErrorCode(NSError *error) {
  if (![error.domain isEqual:DSHProjectContextServiceErrorDomain]) {
    return DSHPCNative;
  }
  switch ((DSHProjectContextServiceErrorCode)error.code) {
    case DSHProjectContextServiceErrorInvalidArgument:
      return DSHPCRequestInvalid;
    case DSHProjectContextServiceErrorProjectUnavailable:
      return @"E_PROJECT_NOT_FOUND";
    case DSHProjectContextServiceErrorChanged:
      return @"E_CONTEXT_CHANGED";
    case DSHProjectContextServiceErrorSecret:
      return @"E_CONTEXT_SECRET";
    case DSHProjectContextServiceErrorBudgetExceeded:
      return @"E_CONTEXT_BUDGET";
    case DSHProjectContextServiceErrorStorage:
      return @"E_CONTEXT_STORAGE";
    case DSHProjectContextServiceErrorTimeout:
      return @"E_CONTEXT_TIMEOUT";
    case DSHProjectContextServiceErrorConsent:
      return @"E_CONTEXT_CONSENT_INVALID";
    case DSHProjectContextServiceErrorIntegrity:
      return @"E_CONTEXT_INTEGRITY";
    case DSHProjectContextServiceErrorSnapshotMissing:
      return @"E_CONTEXT_SNAPSHOT_MISSING";
  }
  return DSHPCNative;
}

static void DSHPCReject(RCTPromiseRejectBlock reject, NSString *code) {
  reject(code, code, nil);
}

typedef id _Nullable (^DSHPCServiceOperation)(NSError **error);
typedef id _Nullable (^DSHPCResultProjection)(id raw);

@interface DSHPCOperationScheduler : NSObject
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic) NSUInteger maximumPending;
@property(nonatomic) NSUInteger pending;
- (instancetype)initWithQueue:(dispatch_queue_t)queue
                maximumPending:(NSUInteger)maximumPending;
- (BOOL)reserve;
- (void)releaseReservation;
@end

@implementation DSHPCOperationScheduler
- (instancetype)initWithQueue:(dispatch_queue_t)queue
                maximumPending:(NSUInteger)maximumPending {
  self = [super init];
  if (self != nil) {
    _queue = queue;
    _maximumPending = MIN(MAX(maximumPending, 1), 16);
  }
  return self;
}
- (BOOL)reserve {
  @synchronized (self) {
    if (self.pending >= self.maximumPending) return NO;
    self.pending += 1;
    return YES;
  }
}
- (void)releaseReservation {
  @synchronized (self) {
    if (self.pending > 0) self.pending -= 1;
  }
}
@end

static DSHPCOperationScheduler *DSHPCSharedScheduler(void) {
  static DSHPCOperationScheduler *scheduler = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    scheduler = [[DSHPCOperationScheduler alloc]
        initWithQueue:dispatch_queue_create(
            "dev.zseven.rish.project-context-bridge", DISPATCH_QUEUE_SERIAL)
        maximumPending:16];
  });
  return scheduler;
}

@interface LocalProjectContextModule : NSObject <RCTBridgeModule, RCTInvalidating>
@property(nonatomic, strong) DSHProjectContextService *service;
@property(nonatomic, strong) dispatch_queue_t operationQueue;
@property(nonatomic, strong) DSHPCOperationScheduler *scheduler;
@property(nonatomic) NSUInteger maxPending;
@property(nonatomic) NSUInteger pending;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) BOOL invalidated;

- (instancetype)initWithService:(DSHProjectContextService *)service
                   operationQueue:(dispatch_queue_t)operationQueue
                       maxPending:(NSUInteger)maxPending;
@end

@implementation LocalProjectContextModule

RCT_EXPORT_MODULE(LocalProjectContext)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _service = DSHSharedProjectContextService();
    _scheduler = DSHPCSharedScheduler();
    _operationQueue = _scheduler.queue;
    _maxPending = _scheduler.maximumPending;
  }
  return self;
}

- (instancetype)initWithService:(DSHProjectContextService *)service
                   operationQueue:(dispatch_queue_t)operationQueue
                       maxPending:(NSUInteger)maxPending {
  self = [super init];
  if (self != nil) {
    _service = service;
    _operationQueue = operationQueue ?: dispatch_queue_create(
        "dev.zseven.rish.project-context-bridge.test", DISPATCH_QUEUE_SERIAL);
    _maxPending = MIN(MAX(maxPending, 1), 16);
    _scheduler = [[DSHPCOperationScheduler alloc]
        initWithQueue:_operationQueue maximumPending:_maxPending];
  }
  return self;
}

- (void)invalidate {
  @synchronized (self) {
    self.invalidated = YES;
    self.generation += 1;
  }
}

- (void)enqueueOperation:(DSHPCServiceOperation)operation
              projection:(DSHPCResultProjection)projection
                resolver:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)reject {
  __block NSUInteger generation = 0;
  NSString *immediateFailure = nil;
  @synchronized (self) {
    if (self.invalidated) {
      immediateFailure = DSHPCCancelled;
    } else if (![self.scheduler reserve]) {
      immediateFailure = DSHPCBusy;
    } else {
      self.pending += 1;
      generation = self.generation;
    }
  }
  if (immediateFailure != nil) {
    DSHPCReject(reject, immediateFailure);
    return;
  }
  dispatch_async(self.operationQueue, ^{
    BOOL cancelledBeforeStart = NO;
    @synchronized (self) {
      if (self.invalidated || generation != self.generation) {
        self.pending -= 1;
        cancelledBeforeStart = YES;
      }
    }
    if (cancelledBeforeStart) {
      [self.scheduler releaseReservation];
      DSHPCReject(reject, DSHPCCancelled);
      return;
    }
    NSError *serviceError = nil;
    id raw = nil;
    NSString *failure = nil;
    @try {
      raw = operation(&serviceError);
      if (raw == nil) {
        failure = serviceError == nil ? DSHPCNative
                                      : DSHPCServiceErrorCode(serviceError);
      }
    } @catch (__unused NSException *exception) {
      failure = DSHPCNative;
    }
    id result = nil;
    if (failure == nil) {
      @try {
        result = projection(raw);
      } @catch (__unused NSException *exception) {
        failure = DSHPCNative;
      }
      if (failure == nil && result == nil) failure = DSHPCResultInvalid;
    }
    BOOL cancelled = NO;
    @synchronized (self) {
      self.pending -= 1;
      cancelled = self.invalidated || generation != self.generation;
    }
    [self.scheduler releaseReservation];
    if (cancelled) {
      DSHPCReject(reject, DSHPCCancelled);
    } else if (failure != nil) {
      DSHPCReject(reject, failure);
    } else {
      resolve(result);
    }
  });
}

RCT_REMAP_METHOD(listProjectContextCandidates,
                 listProjectContextCandidates:(id)projectIdValue
                 query:(id)queryValue
                 cursor:(id)cursorValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *projectId = nil;
  NSString *query = nil;
  NSData *queryData = nil;
  NSString *cursor = nil;
  @try {
    projectId = DSHPCCanonicalIdentifier(projectIdValue);
    query = DSHPCString(queryValue);
    queryData = [query dataUsingEncoding:NSUTF8StringEncoding];
    cursor = DSHPCCursor(cursorValue, YES);
  } @catch (__unused NSException *exception) {
    DSHPCReject(reject, DSHPCNative);
    return;
  }
  if (projectId == nil || query == nil || query.length > 256 ||
      queryData == nil || cursor == nil) {
    DSHPCReject(reject, DSHPCRequestInvalid);
    return;
  }
  NSString *queryCopy = [query copy];
  id cursorCopy = cursor == (id)NSNull.null ? nil : [cursor copy];
  [self enqueueOperation:^id(NSError **error) {
    return [self.service listCandidatesForProjectId:projectId
                                              query:queryCopy
                                             cursor:cursorCopy
                                              error:error];
  } projection:^id(id raw) {
    return DSHPCCandidatePage(raw, projectId);
  } resolver:resolve rejecter:reject];
}

RCT_REMAP_METHOD(prepareProjectContext,
                 prepareProjectContext:(id)selectionValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSDictionary *selection = nil;
  @try {
    selection = DSHPCSelection(selectionValue);
  } @catch (__unused NSException *exception) {
    DSHPCReject(reject, DSHPCNative);
    return;
  }
  if (selection == nil) {
    DSHPCReject(reject, DSHPCRequestInvalid);
    return;
  }
  [self enqueueOperation:^id(NSError **error) {
    return [self.service prepareSelection:selection error:error];
  } projection:^id(id raw) {
    return DSHPCManifest(raw, selection[@"project_id"], nil,
                         selection[@"model"]);
  } resolver:resolve rejecter:reject];
}

RCT_REMAP_METHOD(confirmProjectContext,
                 confirmProjectContext:(id)snapshotIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *snapshotId = nil;
  @try {
    snapshotId = DSHPCCanonicalIdentifier(snapshotIdValue);
  } @catch (__unused NSException *exception) {
    DSHPCReject(reject, DSHPCNative);
    return;
  }
  if (snapshotId == nil) {
    DSHPCReject(reject, DSHPCRequestInvalid);
    return;
  }
  [self enqueueOperation:^id(NSError **error) {
    return [self.service confirmSnapshotId:snapshotId error:error];
  } projection:^id(id raw) {
    return DSHPCConsent(raw, snapshotId);
  } resolver:resolve rejecter:reject];
}

RCT_REMAP_METHOD(inspectProjectContext,
                 inspectProjectContext:(id)snapshotIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *snapshotId = nil;
  @try {
    snapshotId = DSHPCCanonicalIdentifier(snapshotIdValue);
  } @catch (__unused NSException *exception) {
    DSHPCReject(reject, DSHPCNative);
    return;
  }
  if (snapshotId == nil) {
    DSHPCReject(reject, DSHPCRequestInvalid);
    return;
  }
  [self enqueueOperation:^id(NSError **error) {
    return [self.service inspectSnapshotId:snapshotId error:error];
  } projection:^id(id raw) {
    return DSHPCInspection(raw, snapshotId);
  } resolver:resolve rejecter:reject];
}

RCT_REMAP_METHOD(discardProjectContext,
                 discardProjectContext:(id)snapshotIdValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *snapshotId = nil;
  @try {
    snapshotId = DSHPCCanonicalIdentifier(snapshotIdValue);
  } @catch (__unused NSException *exception) {
    DSHPCReject(reject, DSHPCNative);
    return;
  }
  if (snapshotId == nil) {
    DSHPCReject(reject, DSHPCRequestInvalid);
    return;
  }
  [self enqueueOperation:^id(NSError **error) {
    return [self.service discardSnapshotId:snapshotId error:error] ? @YES : nil;
  } projection:^id(id raw) {
    return [raw isEqual:@YES]
        ? @{@"schema_version": @1, @"status": @"discarded"} : nil;
  } resolver:resolve rejecter:reject];
}

@end
