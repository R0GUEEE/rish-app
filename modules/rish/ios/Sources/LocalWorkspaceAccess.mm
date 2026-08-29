#import "LocalWorkspaceAccess.h"

#import <CommonCrypto/CommonDigest.h>
#import <TargetConditionals.h>

#include <fcntl.h>
#include <math.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

NSErrorDomain const DSHLocalWorkspaceAccessErrorDomain =
    @"dev.zseven.rish.local-workspace-access";

static const NSUInteger DSHWorkspaceRegistryMaxBytes = 1024 * 1024;
static const NSUInteger DSHWorkspaceRegistryMaxRecords = 1024;
static const NSUInteger DSHWorkspaceAuthorityMaxBytes = 512 * 1024;
static const NSUInteger DSHWorkspaceBookmarkMaxBytes = 256 * 1024;
static const NSUInteger DSHWorkspaceReceiptStoreMaxBytes = 4 * 1024 * 1024;
static const NSUInteger DSHWorkspaceReceiptCapacity = 2048;
static const NSTimeInterval DSHWorkspaceReceiptTTL = 30 * 24 * 60 * 60;
static const unsigned long long DSHWorkspaceMaxSafeInteger =
    9007199254740991ULL;

static NSString *DSHWorkspacePublicCode(
    DSHLocalWorkspaceAccessErrorCode code) {
  switch (code) {
    case DSHLocalWorkspaceAccessErrorInvalid:
      return @"E_WORKSPACE_INVALID";
    case DSHLocalWorkspaceAccessErrorNotFound:
      return @"E_WORKSPACE_NOT_FOUND";
    case DSHLocalWorkspaceAccessErrorBusy:
      return @"E_WORKSPACE_BUSY";
    case DSHLocalWorkspaceAccessErrorRevisionStale:
      return @"E_WORKSPACE_REVISION_STALE";
    case DSHLocalWorkspaceAccessErrorRevisionOverflow:
      return @"E_WORKSPACE_REVISION_OVERFLOW";
    case DSHLocalWorkspaceAccessErrorUnavailable:
      return @"E_WORKSPACE_UNAVAILABLE";
    case DSHLocalWorkspaceAccessErrorCapability:
      return @"E_WORKSPACE_CAPABILITY";
    case DSHLocalWorkspaceAccessErrorConflict:
      return @"E_WORKSPACE_CONFLICT";
    case DSHLocalWorkspaceAccessErrorIO:
      return @"E_WORKSPACE_IO";
    case DSHLocalWorkspaceAccessErrorPersistence:
      return @"E_WORKSPACE_PERSISTENCE";
  }
}

static NSString *DSHWorkspacePublicMessage(
    DSHLocalWorkspaceAccessErrorCode code) {
  switch (code) {
    case DSHLocalWorkspaceAccessErrorInvalid:
      return @"Workspace request is invalid.";
    case DSHLocalWorkspaceAccessErrorNotFound:
      return @"Workspace is not available.";
    case DSHLocalWorkspaceAccessErrorBusy:
      return @"Workspace storage is busy.";
    case DSHLocalWorkspaceAccessErrorRevisionStale:
      return @"Workspace binding is stale.";
    case DSHLocalWorkspaceAccessErrorRevisionOverflow:
      return @"Workspace binding cannot be advanced.";
    case DSHLocalWorkspaceAccessErrorUnavailable:
      return @"Workspace is unavailable.";
    case DSHLocalWorkspaceAccessErrorCapability:
      return @"Workspace capability is unavailable.";
    case DSHLocalWorkspaceAccessErrorConflict:
      return @"Workspace storage changed concurrently.";
    case DSHLocalWorkspaceAccessErrorIO:
      return @"Workspace operation failed.";
    case DSHLocalWorkspaceAccessErrorPersistence:
      return @"Workspace storage is invalid.";
  }
}

static NSError *DSHWorkspaceError(DSHLocalWorkspaceAccessErrorCode code) {
  return [NSError errorWithDomain:DSHLocalWorkspaceAccessErrorDomain
                             code:code
                         userInfo:@{
                           @"code" : DSHWorkspacePublicCode(code),
                           NSLocalizedDescriptionKey :
                               DSHWorkspacePublicMessage(code),
                         }];
}

static void DSHSetWorkspaceError(NSError **error,
                                 DSHLocalWorkspaceAccessErrorCode code) {
  if (error != nil) *error = DSHWorkspaceError(code);
}

static BOOL DSHExactKeys(NSDictionary *dictionary,
                         NSArray<NSString *> *keys) {
  if (![dictionary isKindOfClass:NSDictionary.class] ||
      dictionary.count != keys.count) {
    return NO;
  }
  NSSet *allowed = [NSSet setWithArray:keys];
  for (id key in dictionary) {
    if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHIsBooleanNumber(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL DSHIsSafeInteger(id value, BOOL allowZero) {
  if (![value isKindOfClass:NSNumber.class] || DSHIsBooleanNumber(value)) {
    return NO;
  }
  double number = [value doubleValue];
  if (!isfinite(number) || floor(number) != number || number < 0 ||
      number > (double)DSHWorkspaceMaxSafeInteger ||
      (number == 0 && signbit(number)) || (!allowZero && number == 0)) {
    return NO;
  }
  return YES;
}

BOOL DSHLocalWorkspaceValidateBindingRevisionAdvance(
    NSNumber *currentRevision,
    NSNumber *proposedRevision,
    NSError **error) {
  if (!DSHIsSafeInteger(currentRevision, NO) ||
      !DSHIsSafeInteger(proposedRevision, NO)) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorInvalid);
    return NO;
  }
  unsigned long long current = currentRevision.unsignedLongLongValue;
  if (current >= DSHWorkspaceMaxSafeInteger) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorRevisionOverflow);
    return NO;
  }
  if (proposedRevision.unsignedLongLongValue != current + 1) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
    return NO;
  }
  return YES;
}

static BOOL DSHMatches(NSString *value, NSString *pattern) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSRegularExpression *expression =
      [NSRegularExpression regularExpressionWithPattern:pattern
                                                options:0
                                                  error:nil];
  if (expression == nil) return NO;
  NSRange full = NSMakeRange(0, value.length);
  NSTextCheckingResult *match = [expression firstMatchInString:value
                                                       options:0
                                                         range:full];
  return match != nil && NSEqualRanges(match.range, full);
}

static BOOL DSHCanonicalUUID(id value) {
  if (![value isKindOfClass:NSString.class] ||
      !DSHMatches(value,
          @"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-"
           "[0-9a-f]{12}$")) {
    return NO;
  }
  NSUUID *UUID = [[NSUUID alloc] initWithUUIDString:value];
  return UUID != nil && [UUID.UUIDString.lowercaseString isEqual:value];
}

static BOOL DSHCanonicalSHA256(id value) {
  return [value isKindOfClass:NSString.class] &&
         DSHMatches(value, @"^[0-9a-f]{64}$");
}

static NSISO8601DateFormatter *DSHTimestampFormatter(void) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  return formatter;
}

static BOOL DSHCanonicalTimestamp(id value) {
  if (![value isKindOfClass:NSString.class] ||
      !DSHMatches(value,
          @"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:"
           "[0-9]{2}\\.[0-9]{3}Z$")) {
    return NO;
  }
  NSISO8601DateFormatter *formatter = DSHTimestampFormatter();
  NSDate *date = [formatter dateFromString:value];
  return date != nil && [[formatter stringFromDate:date] isEqual:value];
}

static NSString *DSHCanonicalTimestampForDate(NSDate *date) {
  if (![date isKindOfClass:NSDate.class]) return nil;
  return [DSHTimestampFormatter() stringFromDate:date];
}

static BOOL DSHCanonicalUnsignedIntegerString(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *string = value;
  if (string.length == 0 || string.length > 20 ||
      !DSHMatches(string, @"^(0|[1-9][0-9]*)$")) {
    return NO;
  }
  errno = 0;
  (void)strtoull(string.UTF8String, nullptr, 10);
  return errno != ERANGE;
}

static BOOL DSHCanonicalDisplayName(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *name = value;
  NSString *normalized = [name precomposedStringWithCanonicalMapping];
  if (![normalized isEqual:name]) return NO;
  NSData *bytes = [name dataUsingEncoding:NSUTF8StringEncoding
                     allowLossyConversion:NO];
  if (bytes.length == 0 || bytes.length > 120) return NO;
  NSString *trimmed = [name
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (![trimmed isEqual:name] || [name hasPrefix:@"."] ||
      [name isEqual:@"."] || [name isEqual:@".."] ||
      [name rangeOfString:@"/"].location != NSNotFound ||
      [name rangeOfString:@":"].location != NSNotFound ||
      [name rangeOfString:@"\0"].location != NSNotFound ||
      [name rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location !=
          NSNotFound) {
    return NO;
  }
  NSString *folded = [name stringByFoldingWithOptions:
      NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch
                                           locale:[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]];
  return ![folded isEqual:@"rish workspaces"] &&
         ![folded hasPrefix:@".rish-"];
}

static BOOL DSHSafeDirectoryName(id value) {
  return DSHCanonicalDisplayName(value);
}

static NSString *DSHSHA256(NSData *data) {
  if (![data isKindOfClass:NSData.class]) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:64];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [result appendFormat:@"%02x", digest[index]];
  }
  return result;
}

static NSData *DSHCanonicalJSON(id object) {
  if (![NSJSONSerialization isValidJSONObject:object]) return nil;
  return [NSJSONSerialization dataWithJSONObject:object
                                          options:NSJSONWritingSortedKeys
                                            error:nil];
}

static void DSHJSONSkipWhitespace(const uint8_t *bytes,
                                  NSUInteger length,
                                  NSUInteger *index) {
  while (*index < length) {
    uint8_t byte = bytes[*index];
    if (byte != ' ' && byte != '\t' && byte != '\r' && byte != '\n') break;
    *index += 1;
  }
}

static NSString *DSHJSONScanString(const uint8_t *bytes,
                                   NSUInteger length,
                                   NSUInteger *index) {
  if (*index >= length || bytes[*index] != '"') return nil;
  NSUInteger start = *index;
  *index += 1;
  BOOL escaped = NO;
  while (*index < length) {
    uint8_t byte = bytes[*index];
    if (!escaped && byte == '"') {
      *index += 1;
      NSData *token = [NSData dataWithBytes:bytes + start
                                     length:*index - start];
      id decoded = [NSJSONSerialization JSONObjectWithData:token
          options:NSJSONReadingFragmentsAllowed error:nil];
      return [decoded isKindOfClass:NSString.class] ? decoded : nil;
    }
    if (!escaped && byte < 0x20) return nil;
    if (!escaped && byte == '\\') {
      escaped = YES;
    } else {
      escaped = NO;
    }
    *index += 1;
  }
  return nil;
}

static BOOL DSHJSONScanValue(const uint8_t *bytes,
                             NSUInteger length,
                             NSUInteger *index,
                             NSUInteger depth,
                             NSUInteger *nodes);

static BOOL DSHJSONScanObject(const uint8_t *bytes,
                              NSUInteger length,
                              NSUInteger *index,
                              NSUInteger depth,
                              NSUInteger *nodes) {
  *index += 1;
  DSHJSONSkipWhitespace(bytes, length, index);
  if (*index < length && bytes[*index] == '}') {
    *index += 1;
    return YES;
  }
  NSMutableSet<NSString *> *keys = [NSMutableSet set];
  while (*index < length) {
    NSString *key = DSHJSONScanString(bytes, length, index);
    if (key == nil || [keys containsObject:key]) return NO;
    [keys addObject:key];
    DSHJSONSkipWhitespace(bytes, length, index);
    if (*index >= length || bytes[*index] != ':') return NO;
    *index += 1;
    if (!DSHJSONScanValue(bytes, length, index, depth + 1, nodes)) return NO;
    DSHJSONSkipWhitespace(bytes, length, index);
    if (*index < length && bytes[*index] == '}') {
      *index += 1;
      return YES;
    }
    if (*index >= length || bytes[*index] != ',') return NO;
    *index += 1;
    DSHJSONSkipWhitespace(bytes, length, index);
  }
  return NO;
}

static BOOL DSHJSONScanArray(const uint8_t *bytes,
                             NSUInteger length,
                             NSUInteger *index,
                             NSUInteger depth,
                             NSUInteger *nodes) {
  *index += 1;
  DSHJSONSkipWhitespace(bytes, length, index);
  if (*index < length && bytes[*index] == ']') {
    *index += 1;
    return YES;
  }
  while (*index < length) {
    if (!DSHJSONScanValue(bytes, length, index, depth + 1, nodes)) return NO;
    DSHJSONSkipWhitespace(bytes, length, index);
    if (*index < length && bytes[*index] == ']') {
      *index += 1;
      return YES;
    }
    if (*index >= length || bytes[*index] != ',') return NO;
    *index += 1;
    DSHJSONSkipWhitespace(bytes, length, index);
  }
  return NO;
}

static BOOL DSHJSONScanValue(const uint8_t *bytes,
                             NSUInteger length,
                             NSUInteger *index,
                             NSUInteger depth,
                             NSUInteger *nodes) {
  if (depth > 64 || *nodes >= 100000) return NO;
  *nodes += 1;
  DSHJSONSkipWhitespace(bytes, length, index);
  if (*index >= length) return NO;
  if (bytes[*index] == '{') {
    return DSHJSONScanObject(bytes, length, index, depth, nodes);
  }
  if (bytes[*index] == '[') {
    return DSHJSONScanArray(bytes, length, index, depth, nodes);
  }
  if (bytes[*index] == '"') {
    return DSHJSONScanString(bytes, length, index) != nil;
  }
  NSUInteger start = *index;
  while (*index < length) {
    uint8_t byte = bytes[*index];
    if (byte == ',' || byte == ']' || byte == '}' || byte == ' ' ||
        byte == '\t' || byte == '\r' || byte == '\n') {
      break;
    }
    *index += 1;
  }
  if (*index == start) return NO;
  NSData *token = [NSData dataWithBytes:bytes + start length:*index - start];
  NSString *tokenText = [[NSString alloc] initWithData:token
                                               encoding:NSUTF8StringEncoding];
  id decoded = [NSJSONSerialization JSONObjectWithData:token
      options:NSJSONReadingFragmentsAllowed error:nil];
  if (decoded == nil) return NO;
  if ([tokenText hasPrefix:@"-"] && [decoded isKindOfClass:NSNumber.class] &&
      [decoded doubleValue] == 0) {
    return NO;
  }
  return YES;
}

static BOOL DSHJSONHasBoundedExactStructure(NSData *data) {
  if (![data isKindOfClass:NSData.class] || data.length == 0) return NO;
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger index = 0;
  NSUInteger nodes = 0;
  if (!DSHJSONScanValue(bytes, data.length, &index, 1, &nodes)) return NO;
  DSHJSONSkipWhitespace(bytes, data.length, &index);
  return index == data.length;
}

static NSArray<NSString *> *DSHCapabilityOrder(void) {
  return @[@"read", @"write", @"git", @"project_context"];
}

static BOOL DSHCanonicalCapabilitiesArray(id value) {
  if (![value isKindOfClass:NSArray.class] || [value count] > 4) return NO;
  NSArray *array = value;
  NSArray *order = DSHCapabilityOrder();
  NSInteger previous = -1;
  NSMutableSet *seen = [NSMutableSet set];
  for (id item in array) {
    if (![item isKindOfClass:NSString.class] || [seen containsObject:item]) {
      return NO;
    }
    NSUInteger index = [order indexOfObject:item];
    if (index == NSNotFound || (NSInteger)index <= previous) return NO;
    [seen addObject:item];
    previous = (NSInteger)index;
  }
  return YES;
}

static BOOL DSHCanonicalCapabilitiesSet(id value) {
  if (![value isKindOfClass:NSSet.class] || [value count] > 4) return NO;
  NSSet *allowed = [NSSet setWithArray:DSHCapabilityOrder()];
  for (id item in value) {
    if (![item isKindOfClass:NSString.class] || ![allowed containsObject:item]) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHValidWorkspaceRecord(NSDictionary *record) {
  NSArray *keys = @[
    @"schema_version", @"workspace_id", @"display_name", @"origin",
    @"root_locator_kind", @"location_class", @"owned_directory_name",
    @"legacy_project_id", @"binding_revision", @"created_at",
    @"last_opened_at",
  ];
  if (!DSHExactKeys(record, keys) ||
      ![record[@"schema_version"] isEqual:@1] ||
      !DSHCanonicalUUID(record[@"workspace_id"]) ||
      !DSHCanonicalDisplayName(record[@"display_name"]) ||
      !DSHIsSafeInteger(record[@"binding_revision"], NO) ||
      !DSHCanonicalTimestamp(record[@"created_at"]) ||
      !DSHCanonicalTimestamp(record[@"last_opened_at"])) {
    return NO;
  }
  NSString *origin = record[@"origin"];
  NSString *locator = record[@"root_locator_kind"];
  NSString *locationClass = record[@"location_class"];
  id owned = record[@"owned_directory_name"];
  id legacy = record[@"legacy_project_id"];
  if ([origin isEqual:@"rish_created"] || [origin isEqual:@"imported"]) {
    return [locator isEqual:@"documents_owned"] &&
           [locationClass isEqual:@"rish_owned"] &&
           DSHSafeDirectoryName(owned) && legacy == NSNull.null;
  }
  if ([origin isEqual:@"granted_folder"]) {
    return [locator isEqual:@"security_scoped"] &&
           [locationClass isEqual:@"proven_local"] &&
           owned == NSNull.null && legacy == NSNull.null;
  }
  if ([origin isEqual:@"legacy_app_owned"]) {
    return [locator isEqual:@"legacy_app_owned"] &&
           [locationClass isEqual:@"rish_owned"] &&
           owned == NSNull.null && DSHCanonicalUUID(legacy);
  }
  return NO;
}

static BOOL DSHValidLegacyAuthority(NSDictionary *authority,
                                    NSDictionary *record) {
  NSArray *keys = @[
    @"schema_version", @"workspace_id", @"binding_revision",
    @"legacy_project_id", @"root_identity_sha256", @"display_name",
    @"created_at", @"last_opened_at", @"recorded_at",
  ];
  return DSHExactKeys(authority, keys) &&
      [authority[@"schema_version"] isEqual:@1] &&
      [authority[@"workspace_id"] isEqual:record[@"workspace_id"]] &&
      [authority[@"binding_revision"] isEqual:record[@"binding_revision"]] &&
      [authority[@"legacy_project_id"] isEqual:record[@"legacy_project_id"]] &&
      DSHCanonicalSHA256(authority[@"root_identity_sha256"]) &&
      [authority[@"display_name"] isEqual:record[@"display_name"]] &&
      [authority[@"created_at"] isEqual:record[@"created_at"]] &&
      [authority[@"last_opened_at"] isEqual:record[@"last_opened_at"]] &&
      DSHCanonicalTimestamp(authority[@"recorded_at"]);
}

static BOOL DSHValidOwnedAuthority(NSDictionary *authority,
                                   NSDictionary *record) {
  NSArray *keys = @[
    @"schema_version", @"workspace_id", @"binding_revision", @"device_id",
    @"inode_id", @"directory_name_sha256", @"recorded_at",
  ];
  NSString *directoryName = record[@"owned_directory_name"];
  NSData *directoryBytes =
      [directoryName dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  return DSHExactKeys(authority, keys) &&
      [authority[@"schema_version"] isEqual:@1] &&
      [authority[@"workspace_id"] isEqual:record[@"workspace_id"]] &&
      [authority[@"binding_revision"] isEqual:record[@"binding_revision"]] &&
      DSHCanonicalUnsignedIntegerString(authority[@"device_id"]) &&
      DSHCanonicalUnsignedIntegerString(authority[@"inode_id"]) &&
      [authority[@"directory_name_sha256"] isEqual:DSHSHA256(directoryBytes)] &&
      DSHCanonicalTimestamp(authority[@"recorded_at"]);
}

static BOOL DSHValidBookmarkAuthority(NSDictionary *authority,
                                      NSDictionary *record) {
  NSArray *keys = @[
    @"schema_version", @"workspace_id", @"binding_revision",
    @"bookmark_sha256", @"bookmark_bytes_base64", @"recorded_at",
  ];
  if (!DSHExactKeys(authority, keys) ||
      ![authority[@"schema_version"] isEqual:@1] ||
      ![authority[@"workspace_id"] isEqual:record[@"workspace_id"]] ||
      ![authority[@"binding_revision"] isEqual:record[@"binding_revision"]] ||
      !DSHCanonicalSHA256(authority[@"bookmark_sha256"]) ||
      ![authority[@"bookmark_bytes_base64"] isKindOfClass:NSString.class] ||
      !DSHCanonicalTimestamp(authority[@"recorded_at"])) {
    return NO;
  }
  NSData *bookmark = [[NSData alloc]
      initWithBase64EncodedString:authority[@"bookmark_bytes_base64"]
                          options:0];
  return bookmark != nil && bookmark.length <= DSHWorkspaceBookmarkMaxBytes &&
         [authority[@"bookmark_sha256"] isEqual:DSHSHA256(bookmark)];
}

static BOOL DSHValidGrantedAuthority(NSDictionary *authority,
                                     NSDictionary *record,
                                     NSDictionary *bookmark) {
  NSArray *keys = @[
    @"schema_version", @"workspace_id", @"binding_revision",
    @"volume_identifier_sha256", @"resource_identifier_sha256", @"device_id",
    @"inode_id", @"bookmark_sha256", @"classified_at",
  ];
  return DSHExactKeys(authority, keys) &&
      [authority[@"schema_version"] isEqual:@1] &&
      [authority[@"workspace_id"] isEqual:record[@"workspace_id"]] &&
      [authority[@"binding_revision"] isEqual:record[@"binding_revision"]] &&
      DSHCanonicalSHA256(authority[@"volume_identifier_sha256"]) &&
      DSHCanonicalSHA256(authority[@"resource_identifier_sha256"]) &&
      DSHCanonicalUnsignedIntegerString(authority[@"device_id"]) &&
      DSHCanonicalUnsignedIntegerString(authority[@"inode_id"]) &&
      [authority[@"bookmark_sha256"] isEqual:bookmark[@"bookmark_sha256"]] &&
      DSHCanonicalTimestamp(authority[@"classified_at"]);
}

static BOOL DSHSameNode(const struct stat &left, const struct stat &right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
         left.st_mode == right.st_mode;
}

static BOOL DSHWriteAll(int descriptor, const uint8_t *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, bytes + offset, length - offset);
    if (written <= 0) return NO;
    offset += (size_t)written;
  }
  return YES;
}

@interface DSHLocalWorkspaceAccess ()
@property(nonatomic, strong) NSURL *privateRootURL;
@property(nonatomic, copy) DSHLocalWorkspaceClock clock;
@property(nonatomic, copy) DSHLocalWorkspaceUUIDGenerator UUIDGenerator;
@property(nonatomic, copy) DSHLocalWorkspaceLegacyResolver legacyResolver;
@property(nonatomic, copy, nullable) DSHLocalWorkspaceFaultHook faultHook;
@property(nonatomic) BOOL rootIdentityCaptured;
@property(nonatomic) dev_t rootDevice;
@property(nonatomic) ino_t rootInode;
@property(nonatomic) BOOL bootstrapped;
@end

@interface DSHLocalWorkspaceAuthorityLock : NSObject
@property(nonatomic) int descriptor;
@end

@implementation DSHLocalWorkspaceAuthorityLock
- (instancetype)init {
  self = [super init];
  if (self) _descriptor = -1;
  return self;
}
- (void)dealloc {
  if (_descriptor >= 0) {
    (void)flock(_descriptor, LOCK_UN);
    close(_descriptor);
  }
}
@end

@implementation DSHLocalWorkspaceAccess

- (instancetype)initWithPrivateRootURL:(NSURL *)privateRootURL
                                  clock:(DSHLocalWorkspaceClock)clock
                          UUIDGenerator:(DSHLocalWorkspaceUUIDGenerator)UUIDGenerator
                         legacyResolver:(DSHLocalWorkspaceLegacyResolver)legacyResolver
                              faultHook:(DSHLocalWorkspaceFaultHook)faultHook {
  self = [super init];
  if (self) {
    _privateRootURL = [privateRootURL copy];
    _clock = [clock copy];
    _UUIDGenerator = [UUIDGenerator copy];
    _legacyResolver = [legacyResolver copy];
    _faultHook = [faultHook copy];
  }
  return self;
}

- (NSURL *)workspaceStoreURL {
  return [self.privateRootURL URLByAppendingPathComponent:@"local-workspaces"
                                              isDirectory:YES];
}

- (NSURL *)bindingsStoreURL {
  return [self.privateRootURL URLByAppendingPathComponent:@"workspace-bindings"
                                              isDirectory:YES];
}

- (NSURL *)registryURL {
  return [[self workspaceStoreURL] URLByAppendingPathComponent:@"registry-v1.json"];
}

- (NSURL *)receiptsURL {
  return [[self workspaceStoreURL] URLByAppendingPathComponent:@"receipts-v1.json"];
}

- (NSURL *)journalURL {
  return [[self workspaceStoreURL]
      URLByAppendingPathComponent:@"authority-journal-v1.json"];
}

- (NSURL *)layoutManifestURL {
  return [[self workspaceStoreURL]
      URLByAppendingPathComponent:@"layout-v1.json"];
}

- (NSURL *)authorityLockURL {
  return [[self workspaceStoreURL]
      URLByAppendingPathComponent:@"authority.lock"];
}

- (NSURL *)authorityURLForKind:(NSString *)kind
                    workspaceId:(NSString *)workspaceId
                       revision:(NSNumber *)revision {
  NSString *name = [NSString stringWithFormat:@"%@-%@-r%@.json", kind,
                    workspaceId, revision];
  return [[self bindingsStoreURL] URLByAppendingPathComponent:name];
}

- (BOOL)validateRootIdentity:(NSError **)error {
  if (![self.privateRootURL isFileURL] ||
      ![self.privateRootURL.path hasPrefix:@"/"]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
    return NO;
  }
  struct stat state = {};
  if (lstat(self.privateRootURL.fileSystemRepresentation, &state) != 0 ||
      !S_ISDIR(state.st_mode) || S_ISLNK(state.st_mode)) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
    return NO;
  }
  if (!self.rootIdentityCaptured) {
    self.rootIdentityCaptured = YES;
    self.rootDevice = state.st_dev;
    self.rootInode = state.st_ino;
    return YES;
  }
  if (state.st_dev != self.rootDevice || state.st_ino != self.rootInode) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
    return NO;
  }
  return YES;
}

- (BOOL)secureDirectoryAtURL:(NSURL *)url error:(NSError **)error {
  struct stat state = {};
  if (lstat(url.fileSystemRepresentation, &state) != 0) {
    if (errno != ENOENT || mkdir(url.fileSystemRepresentation, 0700) != 0) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return NO;
    }
    int parent = open(url.URLByDeletingLastPathComponent.fileSystemRepresentation,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (parent < 0 || fsync(parent) != 0) {
      if (parent >= 0) close(parent);
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return NO;
    }
    close(parent);
    if (lstat(url.fileSystemRepresentation, &state) != 0) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return NO;
    }
  }
  if (!S_ISDIR(state.st_mode) || S_ISLNK(state.st_mode) ||
      chmod(url.fileSystemRepresentation, 0700) != 0 ||
      ![NSFileManager.defaultManager
          setAttributes:@{NSFileProtectionKey : NSFileProtectionComplete}
           ofItemAtPath:url.path error:nil] ||
      ![url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  return YES;
}

- (nullable DSHLocalWorkspaceAuthorityLock *)acquireAuthorityLock:
    (NSError **)error {
  if (![self validateRootIdentity:error] ||
      ![self secureDirectoryAtURL:self.workspaceStoreURL error:error] ||
      ![self secureDirectoryAtURL:self.bindingsStoreURL error:error]) {
    return nil;
  }
  NSURL *url = self.authorityLockURL;
  BOOL created = YES;
  int descriptor = open(url.fileSystemRepresentation,
                        O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                        0600);
  if (descriptor < 0 && errno == EEXIST) {
    created = NO;
    descriptor = open(url.fileSystemRepresentation,
                      O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  }
  struct stat before = {};
  if (descriptor < 0 || fstat(descriptor, &before) != 0 ||
      !S_ISREG(before.st_mode) || before.st_nlink != 1 ||
      (before.st_mode & 0777) != 0600) {
    if (descriptor >= 0) close(descriptor);
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  if (created) {
    if (![NSFileManager.defaultManager
            setAttributes:@{NSFilePosixPermissions : @0600,
                            NSFileProtectionKey : NSFileProtectionComplete}
             ofItemAtPath:url.path error:nil] ||
        ![url setResourceValue:@YES
                        forKey:NSURLIsExcludedFromBackupKey error:nil]) {
      close(descriptor);
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return nil;
    }
    int parent = open(url.URLByDeletingLastPathComponent.fileSystemRepresentation,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    BOOL durable = fsync(descriptor) == 0 && parent >= 0 && fsync(parent) == 0;
    if (parent >= 0) close(parent);
    if (!durable) {
      close(descriptor);
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return nil;
    }
  } else {
    NSDictionary *attributes =
        [NSFileManager.defaultManager attributesOfItemAtPath:url.path error:nil];
    NSNumber *excluded = nil;
    BOOL protectionValid =
#if TARGET_OS_SIMULATOR
        attributes[NSFileProtectionKey] == nil ||
        [attributes[NSFileProtectionKey] isEqual:NSFileProtectionComplete];
#else
        [attributes[NSFileProtectionKey] isEqual:NSFileProtectionComplete];
#endif
    if (!protectionValid ||
        ![url getResourceValue:&excluded
                        forKey:NSURLIsExcludedFromBackupKey error:nil] ||
        !excluded.boolValue) {
      close(descriptor);
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return nil;
    }
  }
  if (flock(descriptor, LOCK_EX) != 0 || ![self validateRootIdentity:error]) {
    close(descriptor);
    if (error != nil && *error == nil) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    }
    return nil;
  }
  struct stat after = {};
  struct stat visible = {};
  if (fstat(descriptor, &after) != 0 ||
      lstat(url.fileSystemRepresentation, &visible) != 0 ||
      !DSHSameNode(before, after) || !DSHSameNode(after, visible)) {
    (void)flock(descriptor, LOCK_UN);
    close(descriptor);
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  DSHLocalWorkspaceAuthorityLock *token =
      [[DSHLocalWorkspaceAuthorityLock alloc] init];
  token.descriptor = descriptor;
  return token;
}

- (BOOL)writeProtectedData:(NSData *)data
                     toURL:(NSURL *)url
                     error:(NSError **)error {
  if (![data isKindOfClass:NSData.class]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  NSString *temporaryName = [NSString stringWithFormat:@".%@.%@.tmp",
      url.lastPathComponent, NSUUID.UUID.UUIDString.lowercaseString];
  NSURL *temporary = [url.URLByDeletingLastPathComponent
      URLByAppendingPathComponent:temporaryName];
  int descriptor = open(temporary.fileSystemRepresentation,
                        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                        0600);
  if (descriptor < 0 ||
      !DSHWriteAll(descriptor, (const uint8_t *)data.bytes, data.length) ||
      fsync(descriptor) != 0 || close(descriptor) != 0) {
    if (descriptor >= 0) close(descriptor);
    unlink(temporary.fileSystemRepresentation);
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  if (![NSFileManager.defaultManager
          setAttributes:@{NSFilePosixPermissions : @0600,
                          NSFileProtectionKey : NSFileProtectionComplete}
           ofItemAtPath:temporary.path error:nil] ||
      ![temporary setResourceValue:@YES
                            forKey:NSURLIsExcludedFromBackupKey
                             error:nil] ||
      rename(temporary.fileSystemRepresentation, url.fileSystemRepresentation) !=
          0 ||
      ![NSFileManager.defaultManager
          setAttributes:@{NSFilePosixPermissions : @0600,
                          NSFileProtectionKey : NSFileProtectionComplete}
           ofItemAtPath:url.path error:nil] ||
      ![url setResourceValue:@YES
                      forKey:NSURLIsExcludedFromBackupKey
                       error:nil]) {
    unlink(temporary.fileSystemRepresentation);
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  int parent = open(url.URLByDeletingLastPathComponent.fileSystemRepresentation,
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  BOOL durable = parent >= 0 && fsync(parent) == 0;
  if (parent >= 0) close(parent);
  if (!durable) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  return YES;
}

- (BOOL)writeProtectedObject:(id)object
                       toURL:(NSURL *)url
                    maxBytes:(NSUInteger)maxBytes
                       error:(NSError **)error {
  NSData *data = DSHCanonicalJSON(object);
  if (data == nil || data.length > maxBytes) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  return [self writeProtectedData:data toURL:url error:error];
}

- (nullable NSData *)readProtectedURL:(NSURL *)url
                              maxBytes:(NSUInteger)maxBytes
                                 error:(NSError **)error {
  struct stat before = {};
  if (lstat(url.fileSystemRepresentation, &before) != 0 ||
      !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode) ||
      before.st_nlink != 1 || (before.st_mode & 0777) != 0600 ||
      before.st_size < 0 || (unsigned long long)before.st_size > maxBytes) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  NSDictionary *attributes =
      [NSFileManager.defaultManager attributesOfItemAtPath:url.path error:nil];
  NSNumber *excluded = nil;
  BOOL protectionValid =
#if TARGET_OS_SIMULATOR
      attributes[NSFileProtectionKey] == nil ||
      [attributes[NSFileProtectionKey] isEqual:NSFileProtectionComplete];
#else
      [attributes[NSFileProtectionKey] isEqual:NSFileProtectionComplete];
#endif
  if (!protectionValid ||
      ![url getResourceValue:&excluded
                      forKey:NSURLIsExcludedFromBackupKey error:nil] ||
      !excluded.boolValue) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  int descriptor = open(url.fileSystemRepresentation,
                        O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat opened = {};
  if (descriptor < 0 || fstat(descriptor, &opened) != 0 ||
      !DSHSameNode(before, opened)) {
    if (descriptor >= 0) close(descriptor);
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
  size_t offset = 0;
  while (offset < data.length) {
    ssize_t count = pread(descriptor,
                          (uint8_t *)data.mutableBytes + offset,
                          data.length - offset, (off_t)offset);
    if (count <= 0) break;
    offset += (size_t)count;
  }
  struct stat after = {};
  BOOL valid = offset == data.length && fstat(descriptor, &after) == 0 &&
               DSHSameNode(opened, after) && opened.st_size == after.st_size &&
               opened.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
               opened.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec;
  close(descriptor);
  if (!valid) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  return [data copy];
}

- (nullable NSDictionary *)readProtectedObjectAtURL:(NSURL *)url
                                            maxBytes:(NSUInteger)maxBytes
                                               error:(NSError **)error {
  NSData *data = [self readProtectedURL:url maxBytes:maxBytes error:error];
  if (data == nil) return nil;
  if (!DSHJSONHasBoundedExactStructure(data)) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![object isKindOfClass:NSDictionary.class]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  return object;
}

- (BOOL)removeProtectedURL:(NSURL *)url error:(NSError **)error {
  if (unlink(url.fileSystemRepresentation) != 0 && errno != ENOENT) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  int parent = open(url.URLByDeletingLastPathComponent.fileSystemRepresentation,
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  BOOL durable = parent >= 0 && fsync(parent) == 0;
  if (parent >= 0) close(parent);
  if (!durable) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  return YES;
}

- (nullable NSDictionary *)loadRegistry:(NSError **)error
                                  digest:(NSString **)digest {
  NSData *data = [self readProtectedURL:self.registryURL
                               maxBytes:DSHWorkspaceRegistryMaxBytes
                                  error:error];
  if (data == nil) return nil;
  if (!DSHJSONHasBoundedExactStructure(data)) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![parsed isKindOfClass:NSDictionary.class] ||
      !DSHExactKeys(parsed, @[@"schema_version", @"generation", @"records"]) ||
      ![parsed[@"schema_version"] isEqual:@1] ||
      !DSHIsSafeInteger(parsed[@"generation"], YES) ||
      ![parsed[@"records"] isKindOfClass:NSArray.class] ||
      [parsed[@"records"] count] > DSHWorkspaceRegistryMaxRecords) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  NSMutableSet *workspaceIds = [NSMutableSet set];
  NSMutableSet *directoryNames = [NSMutableSet set];
  NSString *previous = nil;
  for (id record in parsed[@"records"]) {
    if (![record isKindOfClass:NSDictionary.class] ||
        !DSHValidWorkspaceRecord(record)) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return nil;
    }
    NSString *workspaceId = record[@"workspace_id"];
    if ((previous != nil && [previous compare:workspaceId] != NSOrderedAscending) ||
        [workspaceIds containsObject:workspaceId]) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return nil;
    }
    [workspaceIds addObject:workspaceId];
    previous = workspaceId;
    if (record[@"owned_directory_name"] != NSNull.null) {
      NSString *folded = [record[@"owned_directory_name"]
          stringByFoldingWithOptions:NSCaseInsensitiveSearch |
                                     NSDiacriticInsensitiveSearch
                              locale:[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]];
      folded = [folded precomposedStringWithCanonicalMapping];
      if ([directoryNames containsObject:folded]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      [directoryNames addObject:folded];
    }
  }
  if (digest != nil) *digest = DSHSHA256(data);
  return parsed;
}

- (nullable NSDictionary *)loadAuthorityForRecord:(NSDictionary *)record
                                              error:(NSError **)error {
  NSString *locator = record[@"root_locator_kind"];
  NSString *workspaceId = record[@"workspace_id"];
  NSNumber *revision = record[@"binding_revision"];
  if ([locator isEqual:@"documents_owned"]) {
    NSDictionary *owned = [self readProtectedObjectAtURL:
        [self authorityURLForKind:@"owned" workspaceId:workspaceId
                         revision:revision]
                                               maxBytes:DSHWorkspaceAuthorityMaxBytes
                                                  error:error];
    if (owned == nil || !DSHValidOwnedAuthority(owned, record)) {
      if (owned != nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      }
      return nil;
    }
    return owned;
  }
  if ([locator isEqual:@"security_scoped"]) {
    NSDictionary *bookmark = [self readProtectedObjectAtURL:
        [self authorityURLForKind:@"bookmark" workspaceId:workspaceId
                         revision:revision]
                                                  maxBytes:DSHWorkspaceAuthorityMaxBytes
                                                     error:error];
    if (bookmark == nil || !DSHValidBookmarkAuthority(bookmark, record)) {
      if (bookmark != nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      }
      return nil;
    }
    NSDictionary *granted = [self readProtectedObjectAtURL:
        [self authorityURLForKind:@"granted" workspaceId:workspaceId
                         revision:revision]
                                                 maxBytes:DSHWorkspaceAuthorityMaxBytes
                                                    error:error];
    if (granted == nil ||
        !DSHValidGrantedAuthority(granted, record, bookmark)) {
      if (granted != nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      }
      return nil;
    }
    return @{ @"bookmark" : bookmark, @"granted" : granted };
  }
  if ([locator isEqual:@"legacy_app_owned"]) {
    NSDictionary *legacy = [self readProtectedObjectAtURL:
        [self authorityURLForKind:@"legacy" workspaceId:workspaceId
                         revision:revision]
                                                maxBytes:DSHWorkspaceAuthorityMaxBytes
                                                   error:error];
    if (legacy == nil || !DSHValidLegacyAuthority(legacy, record)) {
      if (legacy != nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      }
      return nil;
    }
    return legacy;
  }
  DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
  return nil;
}

- (NSDictionary *)zeroCapabilitiesForRecord:(NSDictionary *)record {
  BOOL filesVisible = [record[@"root_locator_kind"] isEqual:@"documents_owned"];
  return @{
    @"read" : @NO,
    @"write" : @NO,
    @"git" : @NO,
    @"project_context" : @NO,
    @"files_visible" : @(filesVisible),
  };
}

- (NSDictionary *)descriptorForRecord:(NSDictionary *)record
                                status:(NSString *)status
                          capabilities:(nullable NSSet<NSString *> *)capabilities {
  NSMutableDictionary *projectedCapabilities =
      [[self zeroCapabilitiesForRecord:record] mutableCopy];
  for (NSString *capability in capabilities ?: [NSSet set]) {
    if (projectedCapabilities[capability] != nil) {
      projectedCapabilities[capability] = @YES;
    }
  }
  return @{
    @"schema_version" : @2,
    @"workspace_id" : record[@"workspace_id"],
    @"display_name" : record[@"display_name"],
    @"origin" : record[@"origin"],
    @"status" : status,
    @"binding_revision" : record[@"binding_revision"],
    @"capabilities" : [projectedCapabilities copy],
    @"created_at" : record[@"created_at"],
    @"last_opened_at" : record[@"last_opened_at"],
  };
}

- (NSString *)metadataStatusForRecord:(NSDictionary *)record
                              authority:(NSDictionary *)authority {
  if (![record[@"root_locator_kind"] isEqual:@"legacy_app_owned"]) {
    return @"unavailable";
  }
  @try {
    NSString *identity = nil;
    NSSet<NSString *> *capabilities = nil;
    NSError *resolverError = nil;
    BOOL resolved = self.legacyResolver(record[@"legacy_project_id"],
                                        &identity, &capabilities,
                                        &resolverError);
    if (resolved && DSHCanonicalSHA256(identity) &&
        DSHCanonicalCapabilitiesSet(capabilities) &&
        [identity isEqual:authority[@"root_identity_sha256"]]) {
      return @"ok";
    }
  } @catch (__unused NSException *exception) {
  }
  return @"unavailable";
}

- (nullable NSDictionary *)recordInRegistry:(NSDictionary *)registry
                                  workspaceId:(NSString *)workspaceId {
  for (NSDictionary *record in registry[@"records"]) {
    if ([record[@"workspace_id"] isEqual:workspaceId]) return record;
  }
  return nil;
}

- (BOOL)validReceipt:(NSDictionary *)receipt {
  NSArray *keys = @[
    @"schema_version", @"operation_id", @"workspace_id", @"operation",
    @"binding_revision", @"registry_generation", @"registry_sha256",
    @"outcome", @"committed_at",
  ];
  NSSet *operations = [NSSet setWithArray:
      @[@"create", @"import", @"regrant", @"forget", @"delete_owned",
        @"bootstrap_legacy"]];
  BOOL structurallyValid = DSHExactKeys(receipt, keys) &&
      [receipt[@"schema_version"] isEqual:@1] &&
      DSHCanonicalUUID(receipt[@"operation_id"]) &&
      DSHCanonicalUUID(receipt[@"workspace_id"]) &&
      [operations containsObject:receipt[@"operation"]] &&
      DSHIsSafeInteger(receipt[@"binding_revision"], NO) &&
      DSHIsSafeInteger(receipt[@"registry_generation"], YES) &&
      DSHCanonicalSHA256(receipt[@"registry_sha256"]) &&
      ([receipt[@"outcome"] isEqual:@"committed"] ||
       [receipt[@"outcome"] isEqual:@"purge_pending"]) &&
      DSHCanonicalTimestamp(receipt[@"committed_at"]);
  if (!structurallyValid) return NO;
  if ([receipt[@"outcome"] isEqual:@"purge_pending"] &&
      ![receipt[@"operation"] isEqual:@"delete_owned"]) {
    return NO;
  }
  if ([receipt[@"operation"] isEqual:@"bootstrap_legacy"] &&
      (![receipt[@"outcome"] isEqual:@"committed"] ||
       ![receipt[@"binding_revision"] isEqual:@1])) {
    return NO;
  }
  return YES;
}

- (nullable NSMutableArray<NSDictionary *> *)loadReceipts:(NSError **)error {
  NSDictionary *envelope = [self readProtectedObjectAtURL:self.receiptsURL
                                                  maxBytes:DSHWorkspaceReceiptStoreMaxBytes
                                                     error:error];
  if (envelope == nil ||
      !DSHExactKeys(envelope, @[@"schema_version", @"receipts"]) ||
      ![envelope[@"schema_version"] isEqual:@1] ||
      ![envelope[@"receipts"] isKindOfClass:NSArray.class] ||
      [envelope[@"receipts"] count] > DSHWorkspaceReceiptCapacity) {
    if (envelope != nil) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    }
    return nil;
  }
  NSMutableArray *result = [NSMutableArray array];
  NSMutableSet *operationIds = [NSMutableSet set];
  for (id receipt in envelope[@"receipts"]) {
    if (![receipt isKindOfClass:NSDictionary.class] ||
        ![self validReceipt:receipt] ||
        [operationIds containsObject:receipt[@"operation_id"]]) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return nil;
    }
    [operationIds addObject:receipt[@"operation_id"]];
    [result addObject:receipt];
  }
  return result;
}

- (BOOL)pruneReceipts:(NSMutableArray<NSDictionary *> *)receipts
                 write:(BOOL)write
                 error:(NSError **)error {
  NSDate *now = self.clock();
  if (![now isKindOfClass:NSDate.class]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  NSUInteger before = receipts.count;
  NSIndexSet *expired = [receipts indexesOfObjectsPassingTest:
      ^BOOL(NSDictionary *receipt, NSUInteger index, BOOL *stop) {
        NSDate *committed = [DSHTimestampFormatter()
            dateFromString:receipt[@"committed_at"]];
        return committed == nil ||
               [now timeIntervalSinceDate:committed] > DSHWorkspaceReceiptTTL;
      }];
  [receipts removeObjectsAtIndexes:expired];
  if (write && before != receipts.count) {
    return [self writeProtectedObject:@{@"schema_version" : @1,
                                        @"receipts" : receipts}
                                toURL:self.receiptsURL
                             maxBytes:DSHWorkspaceReceiptStoreMaxBytes
                                error:error];
  }
  return YES;
}

- (nullable NSDictionary *)receiptForOperationId:(NSString *)operationId
                                         receipts:(NSArray<NSDictionary *> *)receipts {
  for (NSDictionary *receipt in receipts) {
    if ([receipt[@"operation_id"] isEqual:operationId]) return receipt;
  }
  return nil;
}

- (BOOL)validJournal:(NSDictionary *)journal {
  NSArray *keys = @[
    @"schema_version", @"operation_id", @"workspace_id", @"operation",
    @"phase", @"binding_revision", @"previous_registry_generation",
    @"previous_registry_sha256", @"authority_sha256", @"record_sha256",
    @"staging_name", @"destination_name", @"legacy_project_id",
    @"clearance_receipt_id", @"confirmation_id", @"created_at", @"updated_at",
  ];
  // A1 can recover only the two native-internal transactions it writes.
  // Future task journals remain untouched and fail closed until their exact
  // recovery engines ship.
  NSSet *operations = [NSSet setWithObject:@"bootstrap_legacy"];
  NSSet *phases = [NSSet setWithArray:
      @[@"prepared", @"authority_ready", @"registry_committed"]];
  if (!DSHExactKeys(journal, keys) ||
      ![journal[@"schema_version"] isEqual:@1] ||
      !DSHCanonicalUUID(journal[@"operation_id"]) ||
      !DSHCanonicalUUID(journal[@"workspace_id"]) ||
      ![operations containsObject:journal[@"operation"]] ||
      ![phases containsObject:journal[@"phase"]] ||
      !DSHIsSafeInteger(journal[@"binding_revision"], NO) ||
      !DSHIsSafeInteger(journal[@"previous_registry_generation"], YES) ||
      !DSHCanonicalSHA256(journal[@"previous_registry_sha256"]) ||
      !DSHCanonicalTimestamp(journal[@"created_at"]) ||
      !DSHCanonicalTimestamp(journal[@"updated_at"])) {
    return NO;
  }
  BOOL prepared = [journal[@"phase"] isEqual:@"prepared"];
  if (prepared) {
    if (journal[@"authority_sha256"] != NSNull.null ||
        journal[@"record_sha256"] != NSNull.null) return NO;
  } else if (!DSHCanonicalSHA256(journal[@"authority_sha256"]) ||
             !DSHCanonicalSHA256(journal[@"record_sha256"])) {
    return NO;
  }
  NSArray *nullableStrings = @[@"staging_name", @"destination_name",
                               @"clearance_receipt_id", @"confirmation_id"];
  for (NSString *key in nullableStrings) {
    if (journal[key] != NSNull.null &&
        ![journal[key] isKindOfClass:NSString.class]) return NO;
  }
  if ([journal[@"operation"] isEqual:@"bootstrap_legacy"]) {
    return [journal[@"binding_revision"] isEqual:@1] &&
           DSHCanonicalUUID(journal[@"legacy_project_id"]) &&
           journal[@"staging_name"] == NSNull.null &&
           journal[@"destination_name"] == NSNull.null &&
           journal[@"clearance_receipt_id"] == NSNull.null &&
           journal[@"confirmation_id"] == NSNull.null;
  }
  return NO;
}

- (nullable NSDictionary *)loadJournalIfPresent:(NSError **)error {
  struct stat state = {};
  if (lstat(self.journalURL.fileSystemRepresentation, &state) != 0) {
    if (errno == ENOENT) return @{};
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  NSDictionary *journal = [self readProtectedObjectAtURL:self.journalURL
                                                 maxBytes:DSHWorkspaceAuthorityMaxBytes
                                                    error:error];
  if (journal == nil || ![self validJournal:journal]) {
    if (journal != nil) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    }
    return nil;
  }
  return journal;
}

- (nullable NSDictionary *)recordReconstructedFromLegacyAuthority:
    (NSDictionary *)authority {
  NSDictionary *record = @{
    @"schema_version" : @1,
    @"workspace_id" : authority[@"workspace_id"],
    @"display_name" : authority[@"display_name"],
    @"origin" : @"legacy_app_owned",
    @"root_locator_kind" : @"legacy_app_owned",
    @"location_class" : @"rish_owned",
    @"owned_directory_name" : NSNull.null,
    @"legacy_project_id" : authority[@"legacy_project_id"],
    @"binding_revision" : authority[@"binding_revision"],
    @"created_at" : authority[@"created_at"],
    @"last_opened_at" : authority[@"last_opened_at"],
  };
  return DSHValidWorkspaceRecord(record) ? record : nil;
}

- (BOOL)writeRegistryFromPrevious:(NSDictionary *)previous
                            record:(NSDictionary *)record
                             error:(NSError **)error {
  NSMutableArray *records = [previous[@"records"] mutableCopy];
  NSIndexSet *matching = [records indexesOfObjectsPassingTest:
      ^BOOL(NSDictionary *candidate, NSUInteger index, BOOL *stop) {
        return [candidate[@"workspace_id"] isEqual:record[@"workspace_id"]];
      }];
  if (matching.count > 1) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  if (matching.count == 1) {
    [records replaceObjectAtIndex:matching.firstIndex withObject:record];
  } else {
    if (records.count >= DSHWorkspaceRegistryMaxRecords) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorBusy);
      return NO;
    }
    [records addObject:record];
  }
  [records sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                    NSDictionary *right) {
    return [left[@"workspace_id"] compare:right[@"workspace_id"]];
  }];
  unsigned long long generation = [previous[@"generation"] unsignedLongLongValue];
  if (generation >= DSHWorkspaceMaxSafeInteger) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  return [self writeProtectedObject:@{
    @"schema_version" : @1,
    @"generation" : @(generation + 1),
    @"records" : records,
  } toURL:self.registryURL maxBytes:DSHWorkspaceRegistryMaxBytes error:error];
}

- (BOOL)finishCommittedJournal:(NSDictionary *)journal error:(NSError **)error {
  NSString *registryDigest = nil;
  NSDictionary *registry = [self loadRegistry:error digest:&registryDigest];
  if (registry == nil) return NO;
  NSDictionary *record = [self recordInRegistry:registry
                                     workspaceId:journal[@"workspace_id"]];
  if (record == nil ||
      ![DSHSHA256(DSHCanonicalJSON(record)) isEqual:journal[@"record_sha256"]]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  NSDictionary *authority = [self loadAuthorityForRecord:record error:error];
  if (authority == nil) return NO;
  NSDictionary *digestObject = authority[@"bookmark"] == nil ? authority
                                                               : authority[@"granted"];
  if (![DSHSHA256(DSHCanonicalJSON(digestObject))
          isEqual:journal[@"authority_sha256"]]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  NSMutableArray *receipts = [self loadReceipts:error];
  if (receipts == nil || ![self pruneReceipts:receipts write:NO error:error]) {
    return NO;
  }
  NSDictionary *existing = [self receiptForOperationId:journal[@"operation_id"]
                                               receipts:receipts];
  if (existing != nil) {
    if (![existing[@"workspace_id"] isEqual:journal[@"workspace_id"]] ||
        ![existing[@"operation"] isEqual:journal[@"operation"]] ||
        ![existing[@"binding_revision"] isEqual:journal[@"binding_revision"]] ||
        ![existing[@"outcome"] isEqual:@"committed"] ||
        ![existing[@"registry_generation"] isEqual:registry[@"generation"]] ||
        ![existing[@"registry_sha256"] isEqual:registryDigest]) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return NO;
    }
  } else {
    if (receipts.count >= DSHWorkspaceReceiptCapacity) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorBusy);
      return NO;
    }
    NSDictionary *receipt = @{
      @"schema_version" : @1,
      @"operation_id" : journal[@"operation_id"],
      @"workspace_id" : journal[@"workspace_id"],
      @"operation" : journal[@"operation"],
      @"binding_revision" : journal[@"binding_revision"],
      @"registry_generation" : registry[@"generation"],
      @"registry_sha256" : registryDigest,
      @"outcome" : @"committed",
      @"committed_at" : journal[@"updated_at"],
    };
    [receipts addObject:receipt];
    if (![self writeProtectedObject:@{@"schema_version" : @1,
                                      @"receipts" : receipts}
                              toURL:self.receiptsURL
                           maxBytes:DSHWorkspaceReceiptStoreMaxBytes
                              error:error]) {
      return NO;
    }
  }
  if (self.faultHook != nil &&
      self.faultHook(@"after_receipt_written_before_journal_clear")) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  return [self removeProtectedURL:self.journalURL error:error];
}

- (BOOL)recoverJournal:(NSError **)error {
  NSDictionary *journal = [self loadJournalIfPresent:error];
  if (journal == nil) return NO;
  if (journal.count == 0) return YES;
  NSString *phase = journal[@"phase"];
  NSURL *authorityURL = [self authorityURLForKind:@"legacy"
                                       workspaceId:journal[@"workspace_id"]
                                          revision:journal[@"binding_revision"]];
  if ([phase isEqual:@"prepared"]) {
    NSDictionary *registry = [self loadRegistry:error digest:nil];
    if (registry == nil) return NO;
    NSDictionary *referenced = [self recordInRegistry:registry
                                           workspaceId:journal[@"workspace_id"]];
    if (referenced != nil &&
        [referenced[@"binding_revision"]
            isEqual:journal[@"binding_revision"]]) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return NO;
    }
    NSError *cleanupError = nil;
    if (![self removeProtectedURL:authorityURL error:&cleanupError]) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return NO;
    }
    return [self removeProtectedURL:self.journalURL error:error];
  }
  struct stat authorityState = {};
  if (lstat(authorityURL.fileSystemRepresentation, &authorityState) != 0) {
    if (errno == ENOENT && [phase isEqual:@"authority_ready"]) {
      NSDictionary *registry = [self loadRegistry:error digest:nil];
      if (registry == nil) return NO;
      NSDictionary *referenced = [self recordInRegistry:registry
                                             workspaceId:journal[@"workspace_id"]];
      if (referenced == nil ||
          ![referenced[@"binding_revision"]
              isEqual:journal[@"binding_revision"]]) {
        return [self removeProtectedURL:self.journalURL error:error];
      }
    }
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  NSDictionary *authority = [self readProtectedObjectAtURL:authorityURL
                                                   maxBytes:DSHWorkspaceAuthorityMaxBytes
                                                      error:error];
  NSDictionary *record = authority == nil ? nil :
      [self recordReconstructedFromLegacyAuthority:authority];
  if (record == nil || !DSHValidLegacyAuthority(authority, record) ||
      ![DSHSHA256(DSHCanonicalJSON(authority))
          isEqual:journal[@"authority_sha256"]] ||
      ![DSHSHA256(DSHCanonicalJSON(record)) isEqual:journal[@"record_sha256"]]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  if ([phase isEqual:@"authority_ready"]) {
    NSString *registryDigest = nil;
    NSDictionary *registry = [self loadRegistry:error digest:&registryDigest];
    if (registry == nil) return NO;
    BOOL registryIsPrevious =
        [registry[@"generation"]
            isEqual:journal[@"previous_registry_generation"]] &&
        [registryDigest isEqual:journal[@"previous_registry_sha256"]];
    unsigned long long previousGeneration =
        [journal[@"previous_registry_generation"] unsignedLongLongValue];
    NSDictionary *publishedRecord = [self recordInRegistry:registry
                                                workspaceId:journal[@"workspace_id"]];
    BOOL registryAlreadyPublished =
        previousGeneration < DSHWorkspaceMaxSafeInteger &&
        [registry[@"generation"] unsignedLongLongValue] == previousGeneration + 1 &&
        publishedRecord != nil &&
        [DSHSHA256(DSHCanonicalJSON(publishedRecord))
            isEqual:journal[@"record_sha256"]];
    if (!registryIsPrevious && !registryAlreadyPublished) {
      // It is safe to remove the staged authority only when the current
      // registry does not reference it. If it does, preserve all evidence and
      // fail closed instead of manufacturing a dangling published record.
      if (publishedRecord != nil &&
          [publishedRecord[@"binding_revision"]
              isEqual:journal[@"binding_revision"]]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return NO;
      }
      NSError *cleanupError = nil;
      if (![self removeProtectedURL:authorityURL error:&cleanupError]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return NO;
      }
      return [self removeProtectedURL:self.journalURL error:error];
    }
    if (registryIsPrevious &&
        ![self writeRegistryFromPrevious:registry record:record error:error]) {
      return NO;
    }
    NSMutableDictionary *committed = [journal mutableCopy];
    committed[@"phase"] = @"registry_committed";
    committed[@"updated_at"] = DSHCanonicalTimestampForDate(self.clock());
    if (![self writeProtectedObject:committed toURL:self.journalURL
                            maxBytes:DSHWorkspaceAuthorityMaxBytes error:error]) {
      return NO;
    }
    journal = committed;
  }
  if ([journal[@"phase"] isEqual:@"registry_committed"]) {
    return [self finishCommittedJournal:journal error:error];
  }
  DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
  return NO;
}

- (BOOL)ensurePrivateLayoutLocked:(NSError **)error {
  if (![self validateRootIdentity:error] ||
      ![self secureDirectoryAtURL:self.workspaceStoreURL error:error] ||
      ![self secureDirectoryAtURL:self.bindingsStoreURL error:error]) {
    return NO;
  }
  struct stat state = {};
  BOOL manifestExists =
      lstat(self.layoutManifestURL.fileSystemRepresentation, &state) == 0;
  if (!manifestExists && errno != ENOENT) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  BOOL registryExists =
      lstat(self.registryURL.fileSystemRepresentation, &state) == 0;
  if (!registryExists && errno != ENOENT) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  BOOL receiptsExist =
      lstat(self.receiptsURL.fileSystemRepresentation, &state) == 0;
  if (!receiptsExist && errno != ENOENT) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
  if (manifestExists) {
    NSDictionary *manifest = [self readProtectedObjectAtURL:self.layoutManifestURL
                                                   maxBytes:4096 error:error];
    if (manifest == nil ||
        !DSHExactKeys(manifest, @[@"schema_version", @"initialized_at"]) ||
        ![manifest[@"schema_version"] isEqual:@1] ||
        !DSHCanonicalTimestamp(manifest[@"initialized_at"]) ||
        !registryExists || !receiptsExist) {
      if (manifest != nil && error != nil && *error == nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      }
      return NO;
    }
  } else {
    struct stat journalState = {};
    BOOL journalExists =
        lstat(self.journalURL.fileSystemRepresentation, &journalState) == 0;
    NSArray<NSURL *> *bindingEntries = [NSFileManager.defaultManager
        contentsOfDirectoryAtURL:self.bindingsStoreURL
      includingPropertiesForKeys:nil options:0 error:nil];
    if (journalExists || bindingEntries == nil || bindingEntries.count != 0) {
      DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      return NO;
    }
    if (registryExists) {
      NSDictionary *registry = [self loadRegistry:error digest:nil];
      if (registry == nil || ![registry[@"generation"] isEqual:@0] ||
          [registry[@"records"] count] != 0) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return NO;
      }
    } else if (![self writeProtectedObject:@{
        @"schema_version" : @1, @"generation" : @0, @"records" : @[]}
        toURL:self.registryURL maxBytes:DSHWorkspaceRegistryMaxBytes error:error]) {
      return NO;
    }
    if (receiptsExist) {
      NSMutableArray *receipts = [self loadReceipts:error];
      if (receipts == nil || receipts.count != 0) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return NO;
      }
    } else if (![self writeProtectedObject:@{
        @"schema_version" : @1, @"receipts" : @[]}
        toURL:self.receiptsURL maxBytes:DSHWorkspaceReceiptStoreMaxBytes
        error:error]) {
      return NO;
    }
    NSString *initializedAt = DSHCanonicalTimestampForDate(self.clock());
    if (initializedAt == nil || ![self writeProtectedObject:@{
        @"schema_version" : @1, @"initialized_at" : initializedAt}
        toURL:self.layoutManifestURL maxBytes:4096 error:error]) {
      if (error != nil && *error == nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
      }
      return NO;
    }
  }
  if (!self.bootstrapped) {
    if (![self recoverJournal:error]) return NO;
    NSMutableArray *receipts = [self loadReceipts:error];
    if (receipts == nil || ![self pruneReceipts:receipts write:YES error:error]) {
      return NO;
    }
    self.bootstrapped = YES;
  } else {
    // A journal may appear after this instance bootstrapped (for example after
    // an injected crash boundary). Validate it on every entry, but recovery is
    // reserved for a fresh instance so pre-publication state stays invisible.
    if ([self loadJournalIfPresent:error] == nil) return NO;
  }
  return YES;
}

- (BOOL)ensurePrivateLayoutWithError:(NSError **)error {
  @try {
    @synchronized(DSHLocalWorkspaceAccess.class) {
      __attribute__((objc_precise_lifetime))
      DSHLocalWorkspaceAuthorityLock *lock = [self acquireAuthorityLock:error];
      if (lock == nil) return NO;
      return [self ensurePrivateLayoutLocked:error];
    }
  } @catch (__unused NSException *exception) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return NO;
  }
}

- (nullable NSArray<NSDictionary *> *)listWorkspaceMetadataWithError:
    (NSError **)error {
  @try {
    @synchronized(DSHLocalWorkspaceAccess.class) {
      __attribute__((objc_precise_lifetime))
      DSHLocalWorkspaceAuthorityLock *lock = [self acquireAuthorityLock:error];
      if (lock == nil) return nil;
      if (![self ensurePrivateLayoutLocked:error]) return nil;
      NSDictionary *registry = [self loadRegistry:error digest:nil];
      if (registry == nil) return nil;
      NSMutableArray *result = [NSMutableArray array];
      for (NSDictionary *record in registry[@"records"]) {
        NSDictionary *authority = [self loadAuthorityForRecord:record error:error];
        if (authority == nil) return nil;
        NSString *status = [self metadataStatusForRecord:record
                                                authority:authority];
        [result addObject:[self descriptorForRecord:record
                                             status:status
                                       capabilities:nil]];
      }
      return [result copy];
    }
  } @catch (__unused NSException *exception) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
}

- (nullable NSDictionary *)resolveWorkspaceId:(NSString *)workspaceId
                       expectedBindingRevision:(NSNumber *)revision
                          requiredCapabilities:(NSArray<NSString *> *)capabilities
                                         error:(NSError **)error {
  @try {
    @synchronized(DSHLocalWorkspaceAccess.class) {
      if (!DSHCanonicalUUID(workspaceId) ||
          !DSHCanonicalCapabilitiesArray(capabilities) ||
          (revision != nil && !DSHIsSafeInteger(revision, NO))) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorInvalid);
        return nil;
      }
      __attribute__((objc_precise_lifetime))
      DSHLocalWorkspaceAuthorityLock *lock = [self acquireAuthorityLock:error];
      if (lock == nil) return nil;
      if (![self ensurePrivateLayoutLocked:error]) return nil;
      NSDictionary *registry = [self loadRegistry:error digest:nil];
      if (registry == nil) return nil;
      NSDictionary *record = [self recordInRegistry:registry
                                         workspaceId:workspaceId];
      if (record == nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorNotFound);
        return nil;
      }
      if (revision != nil && ![revision isEqual:record[@"binding_revision"]]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorRevisionStale);
        return nil;
      }
      NSDictionary *authority = [self loadAuthorityForRecord:record error:error];
      if (authority == nil) return nil;
      if (revision == nil) {
        NSString *status = [self metadataStatusForRecord:record
                                                authority:authority];
        return @{
          @"schema_version" : @1,
          @"disposition" : @"direct",
          @"workspace" : [self descriptorForRecord:record
                                             status:status
                                       capabilities:nil],
        };
      }
      if (![record[@"root_locator_kind"] isEqual:@"legacy_app_owned"]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
        return nil;
      }
      NSString *identity = nil;
      NSSet<NSString *> *available = nil;
      NSError *resolverError = nil;
      BOOL resolved = self.legacyResolver(record[@"legacy_project_id"],
                                          &identity, &available, &resolverError);
      if (!resolved || !DSHCanonicalSHA256(identity) ||
          !DSHCanonicalCapabilitiesSet(available) ||
          ![identity isEqual:authority[@"root_identity_sha256"]]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
        return nil;
      }
      if (![[NSSet setWithArray:capabilities] isSubsetOfSet:available]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorCapability);
        return nil;
      }
      return @{
        @"schema_version" : @1,
        @"disposition" : @"direct",
        @"workspace" : [self descriptorForRecord:record status:@"ok"
                                      capabilities:available],
      };
    }
  } @catch (__unused NSException *exception) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
    return nil;
  }
}

- (nullable NSDictionary *)queryOperationId:(NSString *)operationId
                                        error:(NSError **)error {
  @try {
    @synchronized(DSHLocalWorkspaceAccess.class) {
      if (!DSHCanonicalUUID(operationId)) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorInvalid);
        return nil;
      }
      __attribute__((objc_precise_lifetime))
      DSHLocalWorkspaceAuthorityLock *lock = [self acquireAuthorityLock:error];
      if (lock == nil) return nil;
      if (![self ensurePrivateLayoutLocked:error]) return nil;
      NSMutableArray *receipts = [self loadReceipts:error];
      if (receipts == nil ||
          ![self pruneReceipts:receipts write:YES error:error]) return nil;
      NSDictionary *receipt = [self receiptForOperationId:operationId
                                                 receipts:receipts];
      if (receipt != nil) {
        return @{@"schema_version" : @1, @"status" : @"committed",
                 @"receipt" : receipt};
      }
      NSDictionary *journal = [self loadJournalIfPresent:error];
      if (journal == nil) return nil;
      if (journal.count > 0 &&
          [journal[@"operation_id"] isEqual:operationId]) {
        return @{@"schema_version" : @1, @"status" : @"in_progress"};
      }
      return @{@"schema_version" : @1, @"status" : @"not_started"};
    }
  } @catch (__unused NSException *exception) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
}

- (nullable NSDictionary *)commitInternalWorkspaceRecord:(NSDictionary *)record
                                          authorityRecord:(NSDictionary *)authority
                                                 operation:(NSString *)operation
                                               operationId:(NSString *)operationId
                                  expectedCurrentRevision:(NSNumber *)revision
                                                     error:(NSError **)error {
  @try {
    @synchronized(DSHLocalWorkspaceAccess.class) {
      if (![operation isEqual:@"bootstrap_legacy"] || revision != nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorInvalid);
        return nil;
      }
      if (!DSHCanonicalUUID(operationId) || !DSHValidWorkspaceRecord(record) ||
          ![record[@"root_locator_kind"] isEqual:@"legacy_app_owned"] ||
          !DSHValidLegacyAuthority(authority, record) ||
          ![record[@"binding_revision"] isEqual:@1]) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorInvalid);
        return nil;
      }
      if (![self ensurePrivateLayoutLocked:error]) return nil;
      NSDictionary *existingJournal = [self loadJournalIfPresent:error];
      if (existingJournal == nil) return nil;
      if (existingJournal.count > 0) {
        if (![existingJournal[@"operation_id"] isEqual:operationId]) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorBusy);
          return nil;
        }
        if (![self recoverJournal:error]) return nil;
      }
      NSMutableArray *receipts = [self loadReceipts:error];
      if (receipts == nil || ![self pruneReceipts:receipts write:YES error:error]) {
        return nil;
      }
      NSDictionary *priorReceipt = [self receiptForOperationId:operationId
                                                      receipts:receipts];
      if (priorReceipt != nil) {
        NSDictionary *registry = [self loadRegistry:error digest:nil];
        NSDictionary *existing = registry == nil ? nil :
            [self recordInRegistry:registry
                       workspaceId:priorReceipt[@"workspace_id"]];
        NSDictionary *existingAuthority = existing == nil ? nil :
            [self loadAuthorityForRecord:existing error:error];
        if (existing == nil || existingAuthority == nil) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
          return nil;
        }
        if (![priorReceipt[@"operation"] isEqual:operation] ||
            ![priorReceipt[@"workspace_id"] isEqual:record[@"workspace_id"]] ||
            ![priorReceipt[@"binding_revision"]
                isEqual:record[@"binding_revision"]] ||
            ![existing isEqual:record] ||
            ![existingAuthority isEqual:authority]) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
          return nil;
        }
        return [self descriptorForRecord:existing status:@"ok" capabilities:nil];
      }
      if (receipts.count >= DSHWorkspaceReceiptCapacity) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorBusy);
        return nil;
      }
      NSString *registryDigest = nil;
      NSDictionary *registry = [self loadRegistry:error digest:&registryDigest];
      if (registry == nil) return nil;
      if ([registry[@"generation"] unsignedLongLongValue] >=
          DSHWorkspaceMaxSafeInteger) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      NSDictionary *current = [self recordInRegistry:registry
                                          workspaceId:record[@"workspace_id"]];
      if (current == nil &&
          [registry[@"records"] count] >= DSHWorkspaceRegistryMaxRecords) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorBusy);
        return nil;
      }
      if (current != nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
        return nil;
      }
      for (NSDictionary *published in registry[@"records"]) {
        if ([self loadAuthorityForRecord:published error:error] == nil) {
          return nil;
        }
      }
      NSString *timestamp = DSHCanonicalTimestampForDate(self.clock());
      if (timestamp == nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      NSMutableDictionary *journal = [@{
        @"schema_version" : @1,
        @"operation_id" : operationId,
        @"workspace_id" : record[@"workspace_id"],
        @"operation" : operation,
        @"phase" : @"prepared",
        @"binding_revision" : record[@"binding_revision"],
        @"previous_registry_generation" : registry[@"generation"],
        @"previous_registry_sha256" : registryDigest,
        @"authority_sha256" : NSNull.null,
        @"record_sha256" : NSNull.null,
        @"staging_name" : NSNull.null,
        @"destination_name" : NSNull.null,
        @"legacy_project_id" : [operation isEqual:@"bootstrap_legacy"]
            ? record[@"legacy_project_id"] : NSNull.null,
        @"clearance_receipt_id" : NSNull.null,
        @"confirmation_id" : NSNull.null,
        @"created_at" : timestamp,
        @"updated_at" : timestamp,
      } mutableCopy];
      if (![self writeProtectedObject:journal toURL:self.journalURL
                              maxBytes:DSHWorkspaceAuthorityMaxBytes error:error]) {
        return nil;
      }
      if (self.faultHook != nil && self.faultHook(@"after_journal_prepared")) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      NSURL *authorityURL = [self authorityURLForKind:@"legacy"
                                           workspaceId:record[@"workspace_id"]
                                              revision:record[@"binding_revision"]];
      if (![self writeProtectedObject:authority toURL:authorityURL
                              maxBytes:DSHWorkspaceAuthorityMaxBytes error:error]) {
        return nil;
      }
      if (self.faultHook != nil &&
          self.faultHook(@"after_authority_write_before_journal")) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      journal[@"phase"] = @"authority_ready";
      journal[@"authority_sha256"] = DSHSHA256(DSHCanonicalJSON(authority));
      journal[@"record_sha256"] = DSHSHA256(DSHCanonicalJSON(record));
      journal[@"updated_at"] = DSHCanonicalTimestampForDate(self.clock());
      if (![self writeProtectedObject:journal toURL:self.journalURL
                              maxBytes:DSHWorkspaceAuthorityMaxBytes error:error]) {
        return nil;
      }
      if (self.faultHook != nil && self.faultHook(@"after_authority_ready")) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      NSString *currentDigest = nil;
      NSDictionary *currentRegistry = [self loadRegistry:error digest:&currentDigest];
      if (currentRegistry == nil) return nil;
      if (![currentRegistry[@"generation"] isEqual:registry[@"generation"]] ||
          ![currentDigest isEqual:registryDigest]) {
        NSDictionary *referenced = [self recordInRegistry:currentRegistry
                                               workspaceId:record[@"workspace_id"]];
        if (referenced != nil &&
            [referenced[@"binding_revision"]
                isEqual:record[@"binding_revision"]]) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
          return nil;
        }
        NSError *cleanupError = nil;
        if (![self removeProtectedURL:authorityURL error:&cleanupError] ||
            ![self removeProtectedURL:self.journalURL error:&cleanupError]) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
          return nil;
        }
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
        return nil;
      }
      if (![self writeRegistryFromPrevious:currentRegistry record:record error:error]) {
        return nil;
      }
      if (self.faultHook != nil &&
          self.faultHook(@"after_registry_publication_before_journal")) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      journal[@"phase"] = @"registry_committed";
      journal[@"updated_at"] = DSHCanonicalTimestampForDate(self.clock());
      if (![self writeProtectedObject:journal toURL:self.journalURL
                              maxBytes:DSHWorkspaceAuthorityMaxBytes error:error]) {
        return nil;
      }
      if (self.faultHook != nil && self.faultHook(@"after_registry_committed")) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      if (![self finishCommittedJournal:journal error:error]) return nil;
      return [self descriptorForRecord:record status:@"ok" capabilities:nil];
    }
  } @catch (__unused NSException *exception) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
}

- (nullable NSDictionary *)descriptorForBootstrapReceipt:(NSDictionary *)receipt
                                                 projectId:(NSString *)projectId
                                                displayName:(NSString *)displayName
                                                      error:(NSError **)error {
  NSDictionary *registry = [self loadRegistry:error digest:nil];
  NSDictionary *record = registry == nil ? nil :
      [self recordInRegistry:registry workspaceId:receipt[@"workspace_id"]];
  if (record == nil) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
    return nil;
  }
  if (![receipt[@"operation"] isEqual:@"bootstrap_legacy"] ||
      ![record[@"legacy_project_id"] isEqual:projectId] ||
      ![record[@"display_name"] isEqual:displayName]) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
    return nil;
  }
  NSDictionary *authority = [self loadAuthorityForRecord:record error:error];
  if (authority == nil) return nil;
  NSString *status = [self metadataStatusForRecord:record authority:authority];
  return [self descriptorForRecord:record status:status capabilities:nil];
}

- (nullable NSDictionary *)bootstrapLegacyProjectId:(NSString *)projectId
                                         displayName:(NSString *)displayName
                                          operationId:(NSString *)operationId
                                                error:(NSError **)error {
  @try {
    @synchronized(DSHLocalWorkspaceAccess.class) {
      if (!DSHCanonicalUUID(projectId) ||
          !DSHCanonicalDisplayName(displayName) ||
          !DSHCanonicalUUID(operationId)) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorInvalid);
        return nil;
      }
      __attribute__((objc_precise_lifetime))
      DSHLocalWorkspaceAuthorityLock *lock = [self acquireAuthorityLock:error];
      if (lock == nil) return nil;
      if (![self ensurePrivateLayoutLocked:error]) return nil;
      NSDictionary *pendingJournal = [self loadJournalIfPresent:error];
      if (pendingJournal == nil) return nil;
      BOOL pendingMustCommit = NO;
      if (pendingJournal.count > 0) {
        if (![pendingJournal[@"operation_id"] isEqual:operationId]) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorBusy);
          return nil;
        }
        if (![pendingJournal[@"operation"] isEqual:@"bootstrap_legacy"] ||
            ![pendingJournal[@"legacy_project_id"] isEqual:projectId]) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
          return nil;
        }
        NSString *phase = pendingJournal[@"phase"];
        pendingMustCommit = ![phase isEqual:@"prepared"];
        NSURL *authorityURL = [self authorityURLForKind:@"legacy"
            workspaceId:pendingJournal[@"workspace_id"]
            revision:pendingJournal[@"binding_revision"]];
        struct stat authorityState = {};
        BOOL authorityExists =
            lstat(authorityURL.fileSystemRepresentation, &authorityState) == 0;
        if (authorityExists) {
          NSDictionary *authority = [self readProtectedObjectAtURL:authorityURL
              maxBytes:DSHWorkspaceAuthorityMaxBytes error:error];
          NSDictionary *record = authority == nil ? nil :
              [self recordReconstructedFromLegacyAuthority:authority];
          if (record == nil || !DSHValidLegacyAuthority(authority, record)) {
            if (error != nil && *error == nil) {
              DSHSetWorkspaceError(error,
                                   DSHLocalWorkspaceAccessErrorPersistence);
            }
            return nil;
          }
          if (![record[@"workspace_id"]
                  isEqual:pendingJournal[@"workspace_id"]] ||
              ![record[@"binding_revision"]
                  isEqual:pendingJournal[@"binding_revision"]] ||
              ![record[@"legacy_project_id"] isEqual:projectId] ||
              ![record[@"display_name"] isEqual:displayName]) {
            DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
            return nil;
          }
        } else if (errno != ENOENT || pendingMustCommit) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
          return nil;
        }
        if (![self recoverJournal:error]) return nil;
      }
      NSMutableArray *receipts = [self loadReceipts:error];
      if (receipts == nil || ![self pruneReceipts:receipts write:YES error:error]) {
        return nil;
      }
      NSDictionary *receipt = [self receiptForOperationId:operationId
                                                 receipts:receipts];
      if (receipt != nil) {
        return [self descriptorForBootstrapReceipt:receipt
                                          projectId:projectId
                                         displayName:displayName error:error];
      }
      if (pendingMustCommit) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      NSString *identity = nil;
      NSSet<NSString *> *capabilities = nil;
      NSError *resolverError = nil;
      if (!self.legacyResolver(projectId, &identity, &capabilities,
                               &resolverError) ||
          !DSHCanonicalSHA256(identity) ||
          !DSHCanonicalCapabilitiesSet(capabilities)) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
        return nil;
      }
      NSDictionary *registry = [self loadRegistry:error digest:nil];
      if (registry == nil) return nil;
      for (NSDictionary *candidate in registry[@"records"]) {
        if ([candidate[@"legacy_project_id"] isEqual:projectId]) {
          DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorConflict);
          return nil;
        }
      }
      NSString *workspaceId = self.UUIDGenerator();
      NSString *timestamp = DSHCanonicalTimestampForDate(self.clock());
      if (!DSHCanonicalUUID(workspaceId) || timestamp == nil ||
          [self recordInRegistry:registry workspaceId:workspaceId] != nil) {
        DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorPersistence);
        return nil;
      }
      NSDictionary *record = @{
        @"schema_version" : @1,
        @"workspace_id" : workspaceId,
        @"display_name" : displayName,
        @"origin" : @"legacy_app_owned",
        @"root_locator_kind" : @"legacy_app_owned",
        @"location_class" : @"rish_owned",
        @"owned_directory_name" : NSNull.null,
        @"legacy_project_id" : projectId,
        @"binding_revision" : @1,
        @"created_at" : timestamp,
        @"last_opened_at" : timestamp,
      };
      NSDictionary *authority = @{
        @"schema_version" : @1,
        @"workspace_id" : workspaceId,
        @"binding_revision" : @1,
        @"legacy_project_id" : projectId,
        @"root_identity_sha256" : identity,
        @"display_name" : displayName,
        @"created_at" : timestamp,
        @"last_opened_at" : timestamp,
        @"recorded_at" : timestamp,
      };
      return [self commitInternalWorkspaceRecord:record
                                  authorityRecord:authority
                                         operation:@"bootstrap_legacy"
                                       operationId:operationId
                          expectedCurrentRevision:nil error:error];
    }
  } @catch (__unused NSException *exception) {
    DSHSetWorkspaceError(error, DSHLocalWorkspaceAccessErrorUnavailable);
    return nil;
  }
}

@end
