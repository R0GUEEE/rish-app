#import "SessionSnapshotStore.h"

#import "DSHWorkspaceCanonical.h"
#import "LocalWorkspaceAccess.h"
#import "WorkspaceClearanceStore.h"

#import <TargetConditionals.h>
#import <objc/runtime.h>

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

NSErrorDomain const DSHSessionSnapshotStoreErrorDomain =
    @"dev.zseven.rish.session-snapshot-store";

NSString *const DSHSessionSnapshotStoreErrorInvalidCode =
    @"E_SESSION_INVALID";
NSString *const DSHSessionSnapshotStoreErrorCorruptCode =
    @"E_SESSION_CORRUPT";
NSString *const DSHSessionSnapshotStoreErrorStorageCode =
    @"E_SESSION_STORAGE";
NSString *const DSHSessionSnapshotStoreErrorProtectionCode =
    @"E_SESSION_PROTECTION";
NSString *const DSHSessionSnapshotStoreErrorBoundsCode =
    @"E_SESSION_BOUNDS";
NSString *const DSHSessionSnapshotStoreErrorConflictCode =
    @"E_SESSION_CONFLICT";

static const NSUInteger DSHSessionSnapshotMaximumBytes = 16U * 1024U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumCanonicalBytes =
    16U * 1024U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumJSONDepth = 64U;
static const NSUInteger DSHSessionSnapshotMaximumJSONNodes = 30000U;
static const NSUInteger DSHSessionSnapshotMaximumTombstoneJSONNodes = 450000U;
static const NSUInteger DSHSessionSnapshotMaximumRecentCommits = 64U;
static const NSUInteger DSHSessionSnapshotMaximumEvents = 512U;
static const NSUInteger DSHSessionSnapshotMaximumOutbox = 16U;
static const NSUInteger DSHSessionSnapshotMaximumCleanup = 64U;
static const unsigned long long DSHSessionSnapshotMaximumSafeInteger =
    9007199254740991ULL;
static const NSUInteger DSHSessionSnapshotMaximumMessageBytes = 1000000U;
static const NSUInteger DSHSessionSnapshotMaximumTitleBytes = 120U;
static const NSUInteger DSHSessionSnapshotMaximumIdBytes = 256U;
static const NSUInteger DSHSessionSnapshotMaximumOpaqueIdBytes = 128U;
static const NSUInteger DSHSessionSnapshotMaximumTurns = 100000U;
static const NSUInteger DSHSessionSnapshotMaximumAttempts = 100000U;
static const NSUInteger DSHSessionSnapshotMaximumAttachments = 6U;
static const NSUInteger DSHSessionSnapshotMaximumAttachmentBytes =
    24U * 1024U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumTextAttachmentBytes =
    1024U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumBinaryAttachmentBytes =
    8U * 1024U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumVisibleMessages = 200U;
static const NSUInteger DSHSessionSnapshotMaximumVisibleAttachments = 24U;
static const NSUInteger DSHSessionSnapshotMaximumContextBytes = 256U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumResultBytes = 32U * 1024U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumTranscriptBytes = 2U * 1024U * 1024U;
static const NSUInteger DSHSessionSnapshotMaximumTombstones = 400000U;
static const NSUInteger DSHSessionSnapshotMaximumTombstoneBytes =
    16U * 1024U * 1024U;

static NSString *const DSHSessionSnapshotFilename = @"sessions.json";
static NSString *const DSHSessionSnapshotTombstoneFilename =
    @".sessions.commit-tombstones";

static NSError *DSHSessionStoreError(
    DSHSessionSnapshotStoreErrorCode code) {
  NSString *publicCode = DSHSessionSnapshotStoreErrorStorageCode;
  switch (code) {
    case DSHSessionSnapshotStoreErrorInvalidArgument:
      publicCode = DSHSessionSnapshotStoreErrorInvalidCode;
      break;
    case DSHSessionSnapshotStoreErrorCorrupt:
      publicCode = DSHSessionSnapshotStoreErrorCorruptCode;
      break;
    case DSHSessionSnapshotStoreErrorStorage:
      publicCode = DSHSessionSnapshotStoreErrorStorageCode;
      break;
    case DSHSessionSnapshotStoreErrorProtection:
      publicCode = DSHSessionSnapshotStoreErrorProtectionCode;
      break;
    case DSHSessionSnapshotStoreErrorBounds:
      publicCode = DSHSessionSnapshotStoreErrorBoundsCode;
      break;
    case DSHSessionSnapshotStoreErrorConflict:
      publicCode = DSHSessionSnapshotStoreErrorConflictCode;
      break;
  }
  return [NSError errorWithDomain:DSHSessionSnapshotStoreErrorDomain
                             code:code
                         userInfo:@{
                           @"code" : publicCode,
                           NSLocalizedDescriptionKey : publicCode,
                         }];
}

static BOOL DSHSessionSetError(NSError **error,
                               DSHSessionSnapshotStoreErrorCode code) {
  if (error != nullptr) *error = DSHSessionStoreError(code);
  return NO;
}

typedef NS_ENUM(NSInteger, DSHSessionPinnedPathCheck) {
  DSHSessionPinnedPathCheckOK = 0,
  DSHSessionPinnedPathCheckStorage = 1,
  DSHSessionPinnedPathCheckProtection = 2,
  DSHSessionPinnedPathCheckConflict = 3,
};

static BOOL DSHSessionSamePinnedIdentity(const struct stat *left,
                                         const struct stat *right) {
  return left != nullptr && right != nullptr &&
      left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
      left->st_size == right->st_size &&
      (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT) &&
      left->st_nlink == right->st_nlink &&
      (left->st_mode & 0777) == (right->st_mode & 0777);
}

static DSHSessionPinnedPathCheck DSHSessionCheckPinnedPath(
    int descriptor,
    NSURL *url,
    BOOL directory,
    mode_t requiredMode,
    const struct stat *expected,
    struct stat *stateOut) {
  if (descriptor < 0 || ![url isKindOfClass:NSURL.class] || !url.isFileURL ||
      url.path.length == 0) {
    return DSHSessionPinnedPathCheckStorage;
  }
  struct stat descriptorState = {};
  struct stat pathState = {};
  if (fstat(descriptor, &descriptorState) != 0 ||
      lstat(url.fileSystemRepresentation, &pathState) != 0) {
    return DSHSessionPinnedPathCheckStorage;
  }
  BOOL descriptorTypeOK = directory ? S_ISDIR(descriptorState.st_mode)
                                    : S_ISREG(descriptorState.st_mode);
  BOOL pathTypeOK = directory ? S_ISDIR(pathState.st_mode)
                              : S_ISREG(pathState.st_mode);
  if (!descriptorTypeOK || !pathTypeOK || S_ISLNK(pathState.st_mode)) {
    return DSHSessionPinnedPathCheckProtection;
  }
  if (!DSHSessionSamePinnedIdentity(&descriptorState, &pathState) ||
      (expected != nullptr &&
       !DSHSessionSamePinnedIdentity(&descriptorState, expected))) {
    return DSHSessionPinnedPathCheckConflict;
  }
  if ((!directory &&
       (descriptorState.st_nlink != 1 || pathState.st_nlink != 1)) ||
      (descriptorState.st_mode & 0777) != requiredMode ||
      (pathState.st_mode & 0777) != requiredMode) {
    return DSHSessionPinnedPathCheckProtection;
  }
  if (stateOut != nullptr) *stateOut = descriptorState;
  return DSHSessionPinnedPathCheckOK;
}

static BOOL DSHSessionObjectComesFromSystemFramework(id value) {
  if (value == nil) return NO;
  const char *image = class_getImageName(object_getClass(value));
  if (image == nullptr) return NO;
  return strstr(image, "/Foundation.framework/") != nullptr ||
      strstr(image, "/CoreFoundation.framework/") != nullptr ||
      strstr(image, "/libobjc.A.dylib") != nullptr;
}

static BOOL DSHSessionTrustedDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] &&
      DSHSessionObjectComesFromSystemFramework(value) && [value copy] == value;
}

static BOOL DSHSessionTrustedArray(id value) {
  return [value isKindOfClass:NSArray.class] &&
      DSHSessionObjectComesFromSystemFramework(value) && [value copy] == value;
}

static BOOL DSHSessionTrustedString(id value) {
  return [value isKindOfClass:NSString.class] &&
      DSHSessionObjectComesFromSystemFramework(value) && [value copy] == value;
}

static BOOL DSHSessionTrustedNumber(id value) {
  return [value isKindOfClass:NSNumber.class] &&
      ![value isKindOfClass:NSDecimalNumber.class] &&
      DSHSessionObjectComesFromSystemFramework(value);
}

static BOOL DSHSessionIsBoolean(id value) {
  return DSHSessionTrustedNumber(value) &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL DSHSessionSafeInteger(id value, BOOL allowZero) {
  if (!DSHSessionTrustedNumber(value) || DSHSessionIsBoolean(value)) {
    return NO;
  }
  double number = [value doubleValue];
  if (!isfinite(number) || floor(number) != number || number < 0.0 ||
      number > (double)DSHSessionSnapshotMaximumSafeInteger ||
      (number == 0.0 && signbit(number)) || (!allowZero && number == 0.0)) {
    return NO;
  }
  return YES;
}

static BOOL DSHSessionFiniteNumber(id value) {
  if (!DSHSessionTrustedNumber(value) || DSHSessionIsBoolean(value)) {
    return NO;
  }
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number &&
      !(number == 0.0 && signbit(number)) &&
      fabs(number) <= (double)DSHSessionSnapshotMaximumSafeInteger;
}

static BOOL DSHSessionExactKeys(NSDictionary *dictionary,
                                NSArray<NSString *> *keys) {
  if (!DSHSessionTrustedDictionary(dictionary) ||
      dictionary.count != keys.count) {
    return NO;
  }
  NSSet *expected = [NSSet setWithArray:keys];
  for (id key in dictionary) {
    if (!DSHSessionTrustedString(key) || ![expected containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHSessionOptionalPairKeys(NSDictionary *dictionary,
                                       NSArray<NSString *> *base,
                                       NSArray<NSString *> *pair) {
  if (DSHSessionExactKeys(dictionary, base)) return YES;
  NSMutableArray *all = [base mutableCopy];
  [all addObjectsFromArray:pair];
  return DSHSessionExactKeys(dictionary, all);
}

static BOOL DSHSessionCanonicalUUID(id value) {
  if (!DSHSessionTrustedString(value)) return NO;
  NSString *string = value;
  if (string.length != 36 || ![string isEqualToString:string.lowercaseString]) {
    return NO;
  }
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:string];
  return uuid != nil && [uuid.UUIDString.lowercaseString isEqualToString:string];
}

static BOOL DSHSessionCanonicalDigest(id value) {
  if (!DSHSessionTrustedString(value)) return NO;
  NSString *string = value;
  if (string.length != 64 || ![string isEqualToString:string.lowercaseString]) {
    return NO;
  }
  NSCharacterSet *hex =
      [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [string rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

static BOOL DSHSessionCanonicalOperationId(id value) {
  return DSHSessionCanonicalUUID(value);
}

static BOOL DSHSessionCanonicalTimestamp(id value) {
  if (!DSHSessionTrustedString(value)) return NO;
  NSString *string = value;
  if (string.length != 24 ||
      [string lengthOfBytesUsingEncoding:NSUTF8StringEncoding] != 24 ||
      [string characterAtIndex:4] != '-' ||
      [string characterAtIndex:7] != '-' ||
      [string characterAtIndex:10] != 'T' ||
      [string characterAtIndex:13] != ':' ||
      [string characterAtIndex:16] != ':' ||
      [string characterAtIndex:19] != '.' ||
      [string characterAtIndex:23] != 'Z') {
    return NO;
  }
  static const NSUInteger digitPositions[] = {
    0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22,
  };
  for (NSUInteger position : digitPositions) {
    unichar character = [string characterAtIndex:position];
    if (character < '0' || character > '9') return NO;
  }
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  NSDate *date = [formatter dateFromString:string];
  return date != nil && [[formatter stringFromDate:date] isEqualToString:string];
}

static BOOL DSHSessionValidAgentFailureCode(id value) {
  if (value == NSNull.null) return YES;
  if (!DSHSessionTrustedString(value)) return NO;
  NSString *string = value;
  static NSSet<NSString *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = [NSSet setWithArray:@[
      @"E_AGENT_UNKNOWN_TOOL", @"E_AGENT_BAD_ARGUMENTS", @"E_AGENT_BAD_PATH",
      @"E_AGENT_NO_ROOT", @"E_AGENT_ROOT_STALE", @"E_AGENT_CAPABILITY",
      @"E_AGENT_APPROVAL", @"E_AGENT_TRANSCRIPT", @"E_AGENT_LEDGER",
      @"E_AGENT_ROUND_AMBIGUOUS", @"E_AGENT_EXECUTION_AMBIGUOUS",
      @"E_AGENT_RETRY_LINEAGE", @"E_AGENT_PERSISTENCE", @"E_AGENT_CONFLICT",
      @"E_AGENT_ROUND_LIMIT", @"E_AGENT_CANCELLED", @"E_AGENT_TOOL_FAILED",
    ]];
  });
  return string.length > 0 && string.length <= 128 && [codes containsObject:string];
}

static BOOL DSHSessionBoundedText(id value,
                                  NSUInteger maximumBytes,
                                  BOOL allowEmpty);
static BOOL DSHSessionValidOpaqueIdentifier(id value);
static BOOL DSHSessionValidHarnessId(id value);
static BOOL DSHSessionValidIdentifier(id value, NSUInteger maximumBytes);
static BOOL DSHSessionValidAgentSummaryKey(id value);

static BOOL DSHSessionSafeMirrorURL(id value) {
  if (!DSHSessionBoundedText(value, 2048, NO)) return NO;
  NSString *string = value;
  if (![string isEqualToString:[string stringByTrimmingCharactersInSet:
                                    NSCharacterSet.whitespaceAndNewlineCharacterSet]] ||
      [string rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location !=
          NSNotFound) {
    return NO;
  }
  NSURL *url = [NSURL URLWithString:string];
  return url != nil && [url.scheme.lowercaseString isEqualToString:@"https"] &&
      url.host.length > 0 && url.user.length == 0 && url.password.length == 0 &&
      url.query.length == 0 && url.fragment.length == 0;
}

static BOOL DSHSessionSafeProxyURL(id value) {
  if (!DSHSessionBoundedText(value, 2048, NO)) return NO;
  NSString *string = value;
  if (![string isEqualToString:[string stringByTrimmingCharactersInSet:
                                    NSCharacterSet.whitespaceAndNewlineCharacterSet]] ||
      [string rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location !=
          NSNotFound) {
    return NO;
  }
  NSRegularExpression *expression = [NSRegularExpression
      regularExpressionWithPattern:
          @"^https?://(\\[[^\\]]+\\]|[^@:/?#]+):([0-9]{1,5})/?$"
                              options:NSRegularExpressionCaseInsensitive
                                error:nil];
  if ([expression firstMatchInString:string
                             options:0
                               range:NSMakeRange(0, string.length)] == nil) {
    return NO;
  }
  NSURL *url = [NSURL URLWithString:string];
  NSInteger port = url.port.integerValue;
  return url != nil && (port >= 1 && port <= 65535) && url.host.length > 0 &&
      url.user.length == 0 && url.password.length == 0 && url.query.length == 0 &&
      url.fragment.length == 0 &&
      (url.path.length == 0 || [url.path isEqualToString:@"/"]);
}

static BOOL DSHSessionStringOrNull(id value) {
  return value == NSNull.null || DSHSessionTrustedString(value);
}

static BOOL DSHSessionBoundedText(id value,
                                  NSUInteger maximumBytes,
                                  BOOL allowEmpty) {
  if (!DSHSessionTrustedString(value)) return NO;
  NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding
                    allowLossyConversion:NO];
  return bytes != nil && bytes.length <= maximumBytes &&
      (allowEmpty || bytes.length > 0);
}

static BOOL DSHSessionExactSchema(id value, NSUInteger schema) {
  return DSHSessionSafeInteger(value, YES) &&
      [value unsignedIntegerValue] == schema;
}

static void DSHSessionSkipWhitespace(const uint8_t *bytes,
                                     NSUInteger length,
                                     NSUInteger *index) {
  while (*index < length) {
    uint8_t byte = bytes[*index];
    if (byte != ' ' && byte != '\t' && byte != '\r' && byte != '\n') break;
    *index += 1;
  }
}

static NSString *DSHSessionScanString(const uint8_t *bytes,
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
      return DSHSessionTrustedString(decoded) ? decoded : nil;
    }
    if (!escaped && (byte < 0x20 || byte == 0x7f)) return nil;
    if (!escaped && byte == '\\') {
      escaped = YES;
    } else {
      escaped = NO;
    }
    *index += 1;
  }
  return nil;
}

static BOOL DSHSessionScanValue(const uint8_t *bytes,
                                NSUInteger length,
                                NSUInteger *index,
                                NSUInteger depth,
                                NSUInteger *nodes,
                                NSUInteger maximumNodes);

static BOOL DSHSessionScanObject(const uint8_t *bytes,
                                 NSUInteger length,
                                 NSUInteger *index,
                                 NSUInteger depth,
                                 NSUInteger *nodes,
                                 NSUInteger maximumNodes) {
  if (*index >= length || bytes[*index] != '{') return NO;
  *index += 1;
  DSHSessionSkipWhitespace(bytes, length, index);
  NSMutableSet<NSString *> *keys = [NSMutableSet set];
  if (*index < length && bytes[*index] == '}') {
    *index += 1;
    return YES;
  }
  while (*index < length) {
    NSString *key = DSHSessionScanString(bytes, length, index);
    if (key == nil || [keys containsObject:key]) return NO;
    [keys addObject:key];
    DSHSessionSkipWhitespace(bytes, length, index);
    if (*index >= length || bytes[*index] != ':') return NO;
    *index += 1;
    if (!DSHSessionScanValue(bytes, length, index, depth + 1, nodes,
                             maximumNodes)) return NO;
    DSHSessionSkipWhitespace(bytes, length, index);
    if (*index < length && bytes[*index] == '}') {
      *index += 1;
      return YES;
    }
    if (*index >= length || bytes[*index] != ',') return NO;
    *index += 1;
    DSHSessionSkipWhitespace(bytes, length, index);
  }
  return NO;
}

static BOOL DSHSessionScanArray(const uint8_t *bytes,
                                NSUInteger length,
                                NSUInteger *index,
                                NSUInteger depth,
                                NSUInteger *nodes,
                                NSUInteger maximumNodes) {
  if (*index >= length || bytes[*index] != '[') return NO;
  *index += 1;
  DSHSessionSkipWhitespace(bytes, length, index);
  if (*index < length && bytes[*index] == ']') {
    *index += 1;
    return YES;
  }
  while (*index < length) {
    if (!DSHSessionScanValue(bytes, length, index, depth + 1, nodes,
                             maximumNodes)) return NO;
    DSHSessionSkipWhitespace(bytes, length, index);
    if (*index < length && bytes[*index] == ']') {
      *index += 1;
      return YES;
    }
    if (*index >= length || bytes[*index] != ',') return NO;
    *index += 1;
    DSHSessionSkipWhitespace(bytes, length, index);
  }
  return NO;
}

static BOOL DSHSessionScanScalar(const uint8_t *bytes,
                                 NSUInteger length,
                                 NSUInteger *index) {
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
  // Foundation normalizes the integer token `-0` to a positive NSNumber zero,
  // so preserve this lexical distinction before decoding.  Every numeric
  // spelling whose signed mantissa is all zero is negative zero and is not
  // admitted to the canonical session boundary.
  if (bytes[start] == '-') {
    BOOL hasNonZeroMantissaDigit = NO;
    for (NSUInteger cursor = start + 1; cursor < *index; cursor += 1) {
      uint8_t byte = bytes[cursor];
      if (byte == 'e' || byte == 'E') break;
      if (byte >= '1' && byte <= '9') {
        hasNonZeroMantissaDigit = YES;
        break;
      }
    }
    if (!hasNonZeroMantissaDigit) return NO;
  }
  NSData *token = [NSData dataWithBytes:bytes + start
                                 length:*index - start];
  id decoded = [NSJSONSerialization JSONObjectWithData:token
      options:NSJSONReadingFragmentsAllowed error:nil];
  if (!DSHSessionTrustedNumber(decoded) && decoded != NSNull.null &&
      ![decoded isKindOfClass:NSClassFromString(@"__NSCFBoolean")]) {
    return NO;
  }
  return decoded != nil;
}

static BOOL DSHSessionScanValue(const uint8_t *bytes,
                                NSUInteger length,
                                NSUInteger *index,
                                NSUInteger depth,
                                NSUInteger *nodes,
                                NSUInteger maximumNodes) {
  DSHSessionSkipWhitespace(bytes, length, index);
  if (depth > DSHSessionSnapshotMaximumJSONDepth ||
      *nodes >= maximumNodes || *index >= length) {
    return NO;
  }
  *nodes += 1;
  switch (bytes[*index]) {
    case '{':
      return DSHSessionScanObject(bytes, length, index, depth, nodes,
                                  maximumNodes);
    case '[':
      return DSHSessionScanArray(bytes, length, index, depth, nodes,
                                 maximumNodes);
    case '"':
      return DSHSessionScanString(bytes, length, index) != nil;
    default:
      return DSHSessionScanScalar(bytes, length, index);
  }
}

static BOOL DSHSessionValidateJSONTree(id value,
                                       NSUInteger depth,
                                       NSUInteger *nodes,
                                       NSUInteger maximumNodes) {
  if (depth > DSHSessionSnapshotMaximumJSONDepth ||
      *nodes >= maximumNodes) {
    return NO;
  }
  *nodes += 1;
  if (value == NSNull.null) return YES;
  if (DSHSessionTrustedDictionary(value)) {
    for (id key in (NSDictionary *)value) {
      if (!DSHSessionTrustedString(key) ||
          !DSHSessionValidateJSONTree(value[key], depth + 1, nodes,
                                      maximumNodes)) {
        return NO;
      }
    }
    return YES;
  }
  if (DSHSessionTrustedArray(value)) {
    for (id item in (NSArray *)value) {
      if (!DSHSessionValidateJSONTree(item, depth + 1, nodes,
                                      maximumNodes)) return NO;
    }
    return YES;
  }
  if (DSHSessionTrustedString(value)) {
    return [value dataUsingEncoding:NSUTF8StringEncoding
               allowLossyConversion:NO] != nil;
  }
  if (DSHSessionIsBoolean(value)) return YES;
  if (DSHSessionTrustedNumber(value)) return DSHSessionFiniteNumber(value);
  return NO;
}

static NSDictionary *DSHSessionParseObjectWithNodeLimit(
    NSData *data,
    DSHSessionSnapshotStoreErrorCode errorCode,
    NSUInteger maximumNodes,
    NSError **error) {
  if (![data isKindOfClass:NSData.class] || data.length == 0 ||
      data.length > DSHSessionSnapshotMaximumBytes) {
    DSHSessionSetError(error, errorCode == DSHSessionSnapshotStoreErrorCorrupt
                               ? DSHSessionSnapshotStoreErrorCorrupt
                               : DSHSessionSnapshotStoreErrorBounds);
    return nil;
  }
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger index = 0;
  NSUInteger nodes = 0;
  if (!DSHSessionScanValue(bytes, data.length, &index, 0, &nodes,
                           maximumNodes)) {
    DSHSessionSetError(error, errorCode);
    return nil;
  }
  DSHSessionSkipWhitespace(bytes, data.length, &index);
  NSUInteger first = 0;
  DSHSessionSkipWhitespace(bytes, data.length, &first);
  if (index != data.length || first >= data.length || bytes[first] != '{') {
    DSHSessionSetError(error, errorCode);
    return nil;
  }
  NSError *decodeError = nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&decodeError];
  NSUInteger validationNodes = 0;
  if (!DSHSessionTrustedDictionary(object) ||
      !DSHSessionValidateJSONTree(object, 0, &validationNodes, maximumNodes)) {
    DSHSessionSetError(error, errorCode);
    return nil;
  }
  return object;
}

static NSDictionary *DSHSessionParseObject(NSData *data,
                                           DSHSessionSnapshotStoreErrorCode errorCode,
                                           NSError **error) {
  return DSHSessionParseObjectWithNodeLimit(
      data, errorCode, DSHSessionSnapshotMaximumJSONNodes, error);
}

static NSData *DSHSessionCanonicalJSON(id object,
                                       NSError **error,
                                       DSHSessionSnapshotStoreErrorCode code) {
  NSError *canonicalError = nil;
  NSData *data = DSHWorkspaceCanonicalJSONData(object, &canonicalError);
  if (![data isKindOfClass:NSData.class] || data.length == 0 ||
      data.length > DSHSessionSnapshotMaximumCanonicalBytes) {
    DSHSessionSetError(error, code);
    return nil;
  }
  return data;
}

static NSData *DSHSessionDomainSeparatedBytes(NSString *tag,
                                              NSData *payload,
                                              BOOL lengthPrefixed) {
  if (![tag isKindOfClass:NSString.class] || ![payload isKindOfClass:NSData.class]) {
    return nil;
  }
  NSString *header = [NSString stringWithFormat:@"rish.%@.v1\0", tag];
  NSData *headerData = [header dataUsingEncoding:NSUTF8StringEncoding
                           allowLossyConversion:NO];
  if (headerData == nil) return nil;
  NSMutableData *input = [NSMutableData dataWithData:headerData];
  if (lengthPrefixed) {
    uint64_t length = payload.length;
    uint8_t encodedLength[8] = {
      (uint8_t)(length >> 56), (uint8_t)(length >> 48),
      (uint8_t)(length >> 40), (uint8_t)(length >> 32),
      (uint8_t)(length >> 24), (uint8_t)(length >> 16),
      (uint8_t)(length >> 8),  (uint8_t)length,
    };
    [input appendBytes:encodedLength length:sizeof(encodedLength)];
  }
  [input appendData:payload];
  return input;
}

static NSString *DSHSessionHashObject(NSString *tag,
                                      id object,
                                      NSError **error,
                                      DSHSessionSnapshotStoreErrorCode code) {
  NSData *canonical = DSHSessionCanonicalJSON(object, error, code);
  if (canonical == nil) return nil;
  NSData *input = DSHSessionDomainSeparatedBytes(tag, canonical, NO);
  NSString *digest = [DSHWorkspaceSHA256Hex(input) copy];
  if (digest == nil) {
    DSHSessionSetError(error, code);
    return nil;
  }
  return digest;
}

static NSString *DSHSessionHashBytes(NSString *tag,
                                     NSData *bytes,
                                     NSError **error,
                                     DSHSessionSnapshotStoreErrorCode code) {
  NSData *input = DSHSessionDomainSeparatedBytes(tag, bytes, YES);
  NSString *digest = [DSHWorkspaceSHA256Hex(input) copy];
  if (digest == nil) {
    DSHSessionSetError(error, code);
    return nil;
  }
  return digest;
}

static BOOL DSHSessionValidatePreferences(NSDictionary *preferences) {
  if (!DSHSessionTrustedDictionary(preferences)) return NO;
  NSNumber *schema = preferences[@"schema_version"];
  if (!DSHSessionExactSchema(schema, 1) ||
      !DSHSessionTrustedString(preferences[@"theme_mode"]) ||
      !DSHSessionTrustedString(preferences[@"locale"]) ||
      !DSHSessionTrustedString(preferences[@"default_model"]) ||
      !DSHSessionTrustedString(preferences[@"thinking_mode"]) ||
      !DSHSessionTrustedString(preferences[@"tool_permission"]) ||
      !DSHSessionIsBoolean(preferences[@"show_reasoning"]) ||
      !DSHSessionIsBoolean(preferences[@"auto_expand_tools"]) ||
      !DSHSessionIsBoolean(preferences[@"confirm_destructive_file_actions"])) {
    return NO;
  }
  if (![@[@"system", @"light", @"dark"]
          containsObject:preferences[@"theme_mode"]] ||
      ![@[@"system", @"zh-CN", @"en-US"]
          containsObject:preferences[@"locale"]] ||
      ![@[@"deepseek-v4-flash", @"deepseek-v4-pro",
          @"deepseek-v4-flash-vision-exp"]
          containsObject:preferences[@"default_model"]] ||
      ![@[@"off", @"high", @"max"]
          containsObject:preferences[@"thinking_mode"]] ||
      ![@[@"read-only", @"workspace-write"]
          containsObject:preferences[@"tool_permission"]]) {
    return NO;
  }
  NSSet *known = [NSSet setWithArray:@[
    @"schema_version", @"theme_mode", @"locale", @"default_model",
    @"selected_harness_id", @"thinking_mode", @"tool_permission",
    @"show_reasoning", @"auto_expand_tools",
    @"confirm_destructive_file_actions", @"git_https_proxy_url", @"mirrors",
  ]];
  for (id key in preferences) {
    if (![known containsObject:key]) return NO;
  }
  if (preferences[@"selected_harness_id"] != nil &&
      !DSHSessionValidHarnessId(preferences[@"selected_harness_id"])) {
    return NO;
  }
  if (preferences[@"git_https_proxy_url"] != nil &&
      preferences[@"git_https_proxy_url"] != NSNull.null &&
      !DSHSessionSafeProxyURL(preferences[@"git_https_proxy_url"])) {
    return NO;
  }
  NSDictionary *mirrors = preferences[@"mirrors"];
  if (mirrors != nil) {
    if (!DSHSessionTrustedDictionary(mirrors) ||
        !DSHSessionExactKeys(mirrors, @[@"alpine", @"pip", @"npm"])) {
      return NO;
    }
    for (NSString *category in @[@"alpine", @"pip", @"npm"]) {
      NSDictionary *entry = mirrors[category];
      if (!DSHSessionTrustedDictionary(entry) ||
          !DSHSessionExactKeys(entry, @[@"enabled", @"base_url"]) ||
          !DSHSessionIsBoolean(entry[@"enabled"]) ||
          !DSHSessionSafeMirrorURL(entry[@"base_url"])) {
        return NO;
      }
    }
  }
  return YES;
}

static BOOL DSHSessionValidateEvent(NSDictionary *event) {
  NSArray *keys = @[
    @"schema_version", @"event_id", @"attempt_id", @"seq", @"kind",
    @"round_index", @"call_id", @"status", @"safe_summary_key",
    @"arguments_sha256", @"result_sha256", @"approval_reference",
    @"failure_code", @"created_at",
  ];
  if (!DSHSessionExactKeys(event, keys) ||
      !DSHSessionExactSchema(event[@"schema_version"], 2) ||
      !DSHSessionCanonicalUUID(event[@"event_id"]) ||
      !DSHSessionCanonicalUUID(event[@"attempt_id"]) ||
      !DSHSessionSafeInteger(event[@"seq"], YES) ||
      !DSHSessionTrustedString(event[@"kind"]) ||
      !(event[@"round_index"] == NSNull.null ||
        (DSHSessionSafeInteger(event[@"round_index"], YES) &&
         [event[@"round_index"] unsignedIntegerValue] < 8)) ||
      !(event[@"call_id"] == NSNull.null ||
        DSHSessionValidOpaqueIdentifier(event[@"call_id"])) ||
      !DSHSessionTrustedString(event[@"status"]) ||
      ![@[@"waiting", @"approval", @"running", @"ok", @"failed", @"denied",
         @"cancelled", @"unknown", @"ambiguous"] containsObject:event[@"status"]] ||
      !(event[@"safe_summary_key"] == NSNull.null ||
        DSHSessionValidAgentSummaryKey(event[@"safe_summary_key"])) ||
      !(event[@"arguments_sha256"] == NSNull.null ||
        DSHSessionCanonicalDigest(event[@"arguments_sha256"])) ||
      !(event[@"result_sha256"] == NSNull.null ||
        DSHSessionCanonicalDigest(event[@"result_sha256"])) ||
      !(event[@"approval_reference"] == NSNull.null ||
        DSHSessionValidIdentifier(event[@"approval_reference"], 256)) ||
      !DSHSessionValidAgentFailureCode(event[@"failure_code"]) ||
      !DSHSessionCanonicalTimestamp(event[@"created_at"])) {
    return NO;
  }
  NSString *kind = event[@"kind"];
  if ([kind isEqualToString:@"cancel"]) {
    if (![event[@"status"] isEqualToString:@"cancelled"] ||
        event[@"safe_summary_key"] != NSNull.null ||
        event[@"result_sha256"] != NSNull.null ||
        ![event[@"approval_reference"] isEqual:event[@"event_id"]] ||
        ![@[@"E_AGENT_CANCELLED", @"E_AGENT_ROOT_STALE",
           @"E_AGENT_PERSISTENCE"] containsObject:event[@"failure_code"]]) {
      return NO;
    }
    BOOL attemptTarget = event[@"round_index"] == NSNull.null &&
        event[@"call_id"] == NSNull.null &&
        event[@"arguments_sha256"] == NSNull.null;
    BOOL roundTarget = event[@"round_index"] != NSNull.null &&
        event[@"call_id"] == NSNull.null &&
        event[@"arguments_sha256"] == NSNull.null;
    BOOL toolTarget = event[@"round_index"] != NSNull.null &&
        event[@"call_id"] != NSNull.null &&
        event[@"arguments_sha256"] != NSNull.null;
    return attemptTarget || roundTarget || toolTarget;
  }
  return [@[@"round", @"tool_call", @"tool_result", @"approval", @"terminal"]
      containsObject:kind];
}

static BOOL DSHSessionKeys(NSDictionary *value,
                           NSArray<NSString *> *required,
                           NSArray<NSString *> *optional) {
  if (!DSHSessionTrustedDictionary(value)) return NO;
  NSMutableSet<NSString *> *allowed = [NSMutableSet setWithArray:required];
  [allowed addObjectsFromArray:optional];
  for (NSString *key in required) {
    if (value[key] == nil) return NO;
  }
  for (id key in value) {
    if (!DSHSessionTrustedString(key) || ![allowed containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHSessionValidIdentifier(id value, NSUInteger maximumBytes) {
  return DSHSessionBoundedText(value, maximumBytes, NO) &&
      [value stringByTrimmingCharactersInSet:
                 NSCharacterSet.whitespaceAndNewlineCharacterSet].length > 0;
}

static BOOL DSHSessionValidOpaqueIdentifier(id value) {
  if (!DSHSessionValidIdentifier(value, DSHSessionSnapshotMaximumOpaqueIdBytes)) {
    return NO;
  }
  NSString *string = value;
  for (NSUInteger index = 0; index < string.length; index += 1) {
    unichar character = [string characterAtIndex:index];
    if (!((character >= 'a' && character <= 'z') ||
          (character >= 'A' && character <= 'Z') ||
          (character >= '0' && character <= '9') || character == '.' ||
          character == '_' || character == ':' || character == '-')) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHSessionValidModel(id value) {
  return [@[@"deepseek-v4-flash", @"deepseek-v4-pro",
            @"deepseek-v4-flash-vision-exp"] containsObject:value];
}

static BOOL DSHSessionValidThinkingMode(id value) {
  return [@[@"off", @"high", @"max"] containsObject:value];
}

static BOOL DSHSessionValidTimestampPair(NSString *created, NSString *updated) {
  return DSHSessionCanonicalTimestamp(created) &&
      DSHSessionCanonicalTimestamp(updated) &&
      [created compare:updated] != NSOrderedDescending;
}

static BOOL DSHSessionValidProjectPath(id value) {
  if (!DSHSessionBoundedText(value, 4096, NO)) return NO;
  NSString *path = value;
  if ([path hasPrefix:@"/"] || [path rangeOfString:@"\\"].location != NSNotFound) {
    return NO;
  }
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if (component.length == 0 || [component isEqual:@"."] ||
        [component isEqual:@".."] ||
        [component rangeOfCharacterFromSet:
            NSCharacterSet.controlCharacterSet].location != NSNotFound) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHSessionValidProjectName(id value) {
  if (!DSHSessionBoundedText(value, 120, NO)) return NO;
  NSString *name = value;
  if (![name isEqualToString:[name stringByTrimmingCharactersInSet:
                                  NSCharacterSet.whitespaceAndNewlineCharacterSet]] ||
      [name rangeOfString:@"/"].location != NSNotFound ||
      [name rangeOfString:@"\\"].location != NSNotFound ||
      [name isEqual:@"."] || [name isEqual:@".."] ||
      [name rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location !=
          NSNotFound) {
    return NO;
  }
  return YES;
}

static BOOL DSHSessionValidGitBranch(id value) {
  if (value == NSNull.null) return YES;
  if (!DSHSessionBoundedText(value, 1024, NO)) return NO;
  NSString *branch = value;
  if ([branch isEqual:@"@"] || [branch hasPrefix:@"/"] ||
      [branch hasSuffix:@"/"] || [branch hasPrefix:@"."] ||
      [branch hasSuffix:@"."] || [branch containsString:@".."] ||
      [branch containsString:@"@{"] ||
      [branch rangeOfCharacterFromSet:
                  [NSCharacterSet characterSetWithCharactersInString:@"~^:?*["]]
              .location != NSNotFound ||
      [branch rangeOfString:@"\\"].location != NSNotFound ||
      [branch rangeOfCharacterFromSet:[NSCharacterSet controlCharacterSet]]
              .location != NSNotFound) {
    return NO;
  }
  for (NSString *component in [branch componentsSeparatedByString:@"/"]) {
    if (component.length == 0 || [component hasPrefix:@"."] ||
        [component hasSuffix:@".lock"]) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHSessionValidGitObjectId(id value) {
  if (value == NSNull.null) return YES;
  if (!DSHSessionTrustedString(value) || [value length] != 40) return NO;
  NSCharacterSet *hex =
      [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [value rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

static BOOL DSHSessionValidHarnessId(id value) {
  if (!DSHSessionBoundedText(value, 64, NO)) return NO;
  NSString *string = value;
  NSRegularExpression *expression = [NSRegularExpression
      regularExpressionWithPattern:
          @"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$"
                              options:0
                                error:nil];
  return [expression firstMatchInString:string
                                 options:0
                                   range:NSMakeRange(0, string.length)] != nil;
}

static BOOL DSHSessionValidProjectContextErrorCode(id value) {
  if (value == NSNull.null) return YES;
  if (!DSHSessionTrustedString(value)) return NO;
  static NSSet<NSString *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = [NSSet setWithArray:@[
      @"E_PROJECT_ID_INVALID", @"E_PROJECT_NOT_FOUND",
      @"E_PROJECT_STORAGE_UNSAFE", @"E_REPOSITORY_UNSUPPORTED",
      @"E_CONTEXT_CHANGED", @"E_CONTEXT_BUDGET", @"E_CONTEXT_SECRET",
      @"E_CONTEXT_ENCODING", @"E_CONTEXT_TIMEOUT", @"E_CONTEXT_CANCELLED",
      @"E_CONTEXT_CONSENT_INVALID", @"E_CONTEXT_SNAPSHOT_MISSING",
    ]];
  });
  return [codes containsObject:value];
}

static BOOL DSHSessionValidAgentSummaryKey(id value) {
  if (!DSHSessionBoundedText(value, 128, NO)) return NO;
  static NSSet<NSString *> *keys;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    keys = [NSSet setWithArray:@[
      @"agent.list_dir", @"agent.read_file", @"agent.write_file",
      @"agent.git_status", @"agent.git_commit", @"agent.git_push",
      @"agent.unknown",
    ]];
  });
  return [keys containsObject:value];
}

static BOOL DSHSessionAgentSummaryMatchesName(id summary, id name) {
  if (!DSHSessionValidAgentSummaryKey(summary) ||
      !DSHSessionTrustedString(name)) return NO;
  NSSet<NSString *> *registered = [NSSet setWithArray:@[
    @"list_dir", @"read_file", @"write_file", @"git_status", @"git_commit",
    @"git_push",
  ]];
  NSString *expected = [registered containsObject:name]
      ? [NSString stringWithFormat:@"agent.%@", name] : @"agent.unknown";
  return [summary isEqual:expected];
}

static BOOL DSHSessionValidAttemptFailureCode(id value) {
  if (value == NSNull.null) return YES;
  if (!DSHSessionTrustedString(value)) return NO;
  static NSSet<NSString *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = [NSSet setWithArray:@[
      @"E_ATTEMPT_INTERRUPTED", @"E_ATTEMPT_PERSISTENCE",
      @"E_ATTEMPT_CONTEXT_REQUIRED", @"E_COMPLETION_RESULT_KEYS",
      @"E_COMPLETION_RESULT_TYPE", @"E_COMPLETION_RESULT_IDENTIFIER",
      @"E_COMPLETION_RESULT_BOUNDS", @"E_COMPLETION_RESULT_ENUM",
      @"E_COMPLETION_RESULT_DIGEST", @"E_COMPLETION_RESULT_RELATION",
      @"E_COMPLETION_RESULT_CORRELATION", @"E_COMPLETION_NATIVE",
      @"E_COMPLETION_SCHEMA", @"E_COMPLETION_IDENTIFIER",
      @"E_COMPLETION_ROUND", @"E_COMPLETION_MODEL",
      @"E_COMPLETION_THINKING", @"E_COMPLETION_HISTORY",
      @"E_COMPLETION_TRANSCRIPT", @"E_COMPLETION_TOOLS",
      @"E_COMPLETION_CONTEXT_INVALID", @"E_COMPLETION_CONTEXT_UNSUPPORTED",
      @"E_COMPLETION_CREDENTIAL_UNAVAILABLE",
      @"E_COMPLETION_CREDENTIAL_CHANGED", @"E_COMPLETION_BODY_INVALID",
      @"E_COMPLETION_BODY_TOO_LARGE", @"E_COMPLETION_BUSY",
      @"E_COMPLETION_CANCELLED", @"E_COMPLETION_REDIRECT",
      @"E_COMPLETION_TRANSPORT", @"E_COMPLETION_HTTP_STATUS",
      @"E_COMPLETION_RESPONSE_SIZE", @"E_COMPLETION_RESPONSE_JSON",
      @"E_COMPLETION_PROVIDER_REQUEST_ID",
      @"E_COMPLETION_PROVIDER_RESPONSE_ID", @"E_COMPLETION_RESPONSE_MODEL",
      @"E_COMPLETION_MODEL_MISMATCH", @"E_COMPLETION_FINISH_RELATION",
      @"E_COMPLETION_TOOL_CALL_INVALID", @"E_COMPLETION_EMPTY_RESPONSE",
      @"E_PROJECT_ID_INVALID", @"E_PROJECT_NOT_FOUND",
      @"E_PROJECT_STORAGE_UNSAFE", @"E_REPOSITORY_UNSUPPORTED",
      @"E_CONTEXT_CHANGED", @"E_CONTEXT_BUDGET", @"E_CONTEXT_SECRET",
      @"E_CONTEXT_ENCODING", @"E_CONTEXT_TIMEOUT", @"E_CONTEXT_CANCELLED",
      @"E_CONTEXT_CONSENT_INVALID", @"E_CONTEXT_SNAPSHOT_MISSING",
      @"E_CONTEXT_REQUEST_INVALID", @"E_CONTEXT_RESULT_INVALID",
      @"E_CONTEXT_STORAGE", @"E_CONTEXT_INTEGRITY", @"E_CONTEXT_BUSY",
      @"E_CONTEXT_NATIVE", @"E_WORKSPACE_REVOKED",
    ]];
  });
  return [codes containsObject:value];
}

static BOOL DSHSessionValidateAttachment(NSDictionary *attachment) {
  if (!DSHSessionExactKeys(attachment, @[
        @"schema_version", @"id", @"kind", @"name", @"mime_type", @"size",
      ]) ||
      !DSHSessionExactSchema(attachment[@"schema_version"], 1) ||
      !DSHSessionValidIdentifier(attachment[@"id"],
                                 DSHSessionSnapshotMaximumIdBytes) ||
      !DSHSessionTrustedString(attachment[@"kind"]) ||
      ![@[@"image", @"text", @"pdf"] containsObject:attachment[@"kind"]] ||
      !DSHSessionBoundedText(attachment[@"name"],
                             DSHSessionSnapshotMaximumIdBytes, NO) ||
      [attachment[@"name"] rangeOfString:@"\0"].location != NSNotFound ||
      !DSHSessionBoundedText(attachment[@"mime_type"], 256, NO) ||
      !DSHSessionSafeInteger(attachment[@"size"], YES)) {
    return NO;
  }
  NSString *kind = attachment[@"kind"];
  NSString *mime = [attachment[@"mime_type"] lowercaseString];
  BOOL mimeOK = ([kind isEqual:@"image"] && [mime hasPrefix:@"image/"]) ||
      ([kind isEqual:@"text"] && [mime hasPrefix:@"text/"]) ||
      ([kind isEqual:@"pdf"] && [mime isEqual:@"application/pdf"]);
  NSRegularExpression *mimeExpression = [NSRegularExpression
      regularExpressionWithPattern:@"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$"
                              options:0
                                error:nil];
  NSUInteger maximum = [kind isEqual:@"text"]
      ? DSHSessionSnapshotMaximumTextAttachmentBytes
      : DSHSessionSnapshotMaximumBinaryAttachmentBytes;
  return mimeOK && [mimeExpression firstMatchInString:attachment[@"mime_type"]
                                                options:0
                                                  range:NSMakeRange(0, [attachment[@"mime_type"] length])] != nil &&
      [attachment[@"size"] unsignedIntegerValue] > 0 &&
      [attachment[@"size"] unsignedIntegerValue] <= maximum;
}

static BOOL DSHSessionValidateMetadata(NSDictionary *metadata) {
  if (!DSHSessionKeys(metadata, @[], @[
        @"model_id", @"latency_ms", @"finish_reason", @"reasoning",
      ])) {
    return NO;
  }
  if (metadata[@"model_id"] != nil && !DSHSessionValidModel(metadata[@"model_id"])) {
    return NO;
  }
  if (metadata[@"latency_ms"] != nil &&
      !DSHSessionSafeInteger(metadata[@"latency_ms"], YES)) {
    return NO;
  }
  if (metadata[@"finish_reason"] != nil &&
      !DSHSessionBoundedText(metadata[@"finish_reason"], 256, NO)) {
    return NO;
  }
  return metadata[@"reasoning"] == nil ||
      DSHSessionBoundedText(metadata[@"reasoning"],
                            DSHSessionSnapshotMaximumMessageBytes, NO);
}

static BOOL DSHSessionValidateMessage(NSDictionary *message,
                                      NSUInteger schemaVersion) {
  NSArray *required = schemaVersion >= 4
      ? @[@"id", @"role", @"text", @"created_at", @"attachments"]
      : @[@"id", @"role", @"text", @"created_at"];
  if (!DSHSessionKeys(message, required, @[@"metadata"]) ||
      !DSHSessionValidIdentifier(message[@"id"], DSHSessionSnapshotMaximumIdBytes) ||
      !DSHSessionTrustedString(message[@"role"]) ||
      ![@[@"user", @"assistant"] containsObject:message[@"role"]] ||
      !DSHSessionBoundedText(message[@"text"],
                             DSHSessionSnapshotMaximumMessageBytes, YES) ||
      !DSHSessionCanonicalTimestamp(message[@"created_at"])) {
    return NO;
  }
  NSArray *attachments = @[];
  if (schemaVersion >= 4) {
    if (!DSHSessionTrustedArray(message[@"attachments"]) ||
        [(NSArray *)message[@"attachments"] count] >
            DSHSessionSnapshotMaximumAttachments) {
      return NO;
    }
    NSMutableSet *attachmentIds = [NSMutableSet set];
    NSUInteger totalBytes = 0;
    for (NSDictionary *attachment in message[@"attachments"]) {
      if (!DSHSessionValidateAttachment(attachment) ||
          [attachmentIds containsObject:attachment[@"id"]]) {
        return NO;
      }
      [attachmentIds addObject:attachment[@"id"]];
      totalBytes += [attachment[@"size"] unsignedIntegerValue];
      if (totalBytes > DSHSessionSnapshotMaximumAttachmentBytes) return NO;
    }
    attachments = message[@"attachments"];
  }
  if (message[@"metadata"] != nil &&
      !DSHSessionValidateMetadata(message[@"metadata"])) {
    return NO;
  }
  NSString *text = message[@"text"];
  if ([text stringByTrimmingCharactersInSet:
           NSCharacterSet.whitespaceAndNewlineCharacterSet]
          .length == 0 &&
      ([message[@"role"] isEqual:@"assistant"] || attachments.count == 0)) {
    return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateMessages(NSArray *messages,
                                       NSUInteger schemaVersion,
                                       NSMutableDictionary<NSString *, NSDictionary *> **byIdOut) {
  if (!DSHSessionTrustedArray(messages) ||
      messages.count > DSHSessionSnapshotMaximumAttempts) {
    return NO;
  }
  NSMutableDictionary *byId = [NSMutableDictionary dictionary];
  for (NSDictionary *message in messages) {
    if (!DSHSessionValidateMessage(message, schemaVersion) ||
        byId[message[@"id"]] != nil) {
      return NO;
    }
    byId[message[@"id"]] = message;
  }
  if (byIdOut != nullptr) *byIdOut = byId;
  return YES;
}

static BOOL DSHSessionValidateProjectContextManifest(NSDictionary *manifest,
                                                     NSString *projectId) {
  if (!DSHSessionExactKeys(manifest, @[
        @"schema_version", @"snapshot_id", @"project_id", @"project_name",
        @"branch", @"head_oid", @"clean", @"conflicted", @"captured_at",
        @"policy_version", @"provider_host", @"model", @"included",
        @"omitted", @"context_bytes", @"estimated_tokens",
        @"snapshot_sha256", @"source_fingerprint",
      ]) ||
      !DSHSessionExactSchema(manifest[@"schema_version"], 1) ||
      !DSHSessionCanonicalUUID(manifest[@"snapshot_id"]) ||
      !DSHSessionCanonicalUUID(manifest[@"project_id"]) ||
      ![manifest[@"project_id"] isEqual:projectId] ||
      !DSHSessionValidProjectName(manifest[@"project_name"]) ||
      !DSHSessionValidGitBranch(manifest[@"branch"]) ||
      !DSHSessionValidGitObjectId(manifest[@"head_oid"]) ||
      !DSHSessionIsBoolean(manifest[@"clean"]) ||
      !DSHSessionIsBoolean(manifest[@"conflicted"]) ||
      ([manifest[@"clean"] boolValue] &&
       [manifest[@"conflicted"] boolValue]) ||
      !DSHSessionCanonicalTimestamp(manifest[@"captured_at"]) ||
      ![manifest[@"policy_version"] isEqual:@"chat-read-v1.0.0"] ||
      ![manifest[@"provider_host"] isEqual:@"api.deepseek.com"] ||
      !DSHSessionValidModel(manifest[@"model"]) ||
      !DSHSessionTrustedArray(manifest[@"included"]) ||
      [(NSArray *)manifest[@"included"] count] > 32 ||
      !DSHSessionTrustedArray(manifest[@"omitted"]) ||
      [(NSArray *)manifest[@"omitted"] count] > 5000 ||
      !DSHSessionSafeInteger(manifest[@"context_bytes"], YES) ||
      [manifest[@"context_bytes"] unsignedIntegerValue] == 0 ||
      [manifest[@"context_bytes"] unsignedIntegerValue] >
          DSHSessionSnapshotMaximumContextBytes ||
      !DSHSessionSafeInteger(manifest[@"estimated_tokens"], YES) ||
      [manifest[@"estimated_tokens"] unsignedIntegerValue] !=
          ([manifest[@"context_bytes"] unsignedIntegerValue] + 3) / 4 ||
      !DSHSessionCanonicalDigest(manifest[@"snapshot_sha256"]) ||
      !DSHSessionCanonicalDigest(manifest[@"source_fingerprint"])) {
    return NO;
  }
  NSMutableSet *included = [NSMutableSet set];
  for (NSDictionary *item in manifest[@"included"]) {
    if (!DSHSessionExactKeys(item, @[@"path", @"source", @"bytes", @"sha256"]) ||
        !DSHSessionValidProjectPath(item[@"path"]) ||
        ![@[@"tracked_file", @"staged_diff", @"worktree_diff"]
            containsObject:item[@"source"]] ||
        !DSHSessionSafeInteger(item[@"bytes"], YES) ||
        [item[@"bytes"] unsignedIntegerValue] >
            DSHSessionSnapshotMaximumContextBytes ||
        !DSHSessionCanonicalDigest(item[@"sha256"]) ||
        [included containsObject:[NSString stringWithFormat:@"%@\n%@",
                                  item[@"path"], item[@"source"]]]) {
      return NO;
    }
    [included addObject:[NSString stringWithFormat:@"%@\n%@",
                          item[@"path"], item[@"source"]]];
  }
  NSSet *reasons = [NSSet setWithArray:@[
    @"secret_path", @"generated", @"lockfile", @"suspected_secret", @"binary",
    @"invalid_encoding", @"not_tracked", @"budget_exceeded", @"policy",
  ]];
  NSMutableSet *omitted = [NSMutableSet set];
  for (NSDictionary *item in manifest[@"omitted"]) {
    if (!DSHSessionExactKeys(item, @[@"path", @"reason"]) ||
        !DSHSessionValidProjectPath(item[@"path"]) ||
        ![reasons containsObject:item[@"reason"]] ||
        [omitted containsObject:[NSString stringWithFormat:@"%@\n%@",
                                 item[@"path"], item[@"reason"]]]) {
      return NO;
    }
    [omitted addObject:[NSString stringWithFormat:@"%@\n%@",
                         item[@"path"], item[@"reason"]]];
  }
  return YES;
}

static BOOL DSHSessionValidateProjectContext(NSDictionary *context,
                                             NSString *projectId) {
  if (!DSHSessionExactKeys(context, @[
        @"schema_version", @"project_id", @"status", @"selected_paths",
        @"active_preparation_id", @"manifest", @"consent", @"stale_reason",
        @"error_code",
      ]) ||
      !DSHSessionExactSchema(context[@"schema_version"], 1) ||
      !DSHSessionValidIdentifier(projectId,
                                 DSHSessionSnapshotMaximumIdBytes) ||
      ![context[@"project_id"] isEqual:projectId] ||
      ![@[@"setup_required", @"checking", @"ready", @"stale", @"partial",
          @"error", @"unavailable"] containsObject:context[@"status"]] ||
      !DSHSessionTrustedArray(context[@"selected_paths"]) ||
      [(NSArray *)context[@"selected_paths"] count] > 5000 ||
      !(context[@"active_preparation_id"] == NSNull.null ||
        DSHSessionValidIdentifier(context[@"active_preparation_id"],
                                  DSHSessionSnapshotMaximumIdBytes)) ||
      !(context[@"manifest"] == NSNull.null ||
        DSHSessionTrustedDictionary(context[@"manifest"])) ||
      !(context[@"consent"] == NSNull.null ||
        DSHSessionTrustedDictionary(context[@"consent"])) ||
      !(context[@"stale_reason"] == NSNull.null ||
        [@[@"project_changed", @"selection_changed", @"model_changed",
           @"provider_changed", @"policy_changed", @"snapshot_missing"]
            containsObject:context[@"stale_reason"]]) ||
      !(context[@"error_code"] == NSNull.null ||
        DSHSessionValidProjectContextErrorCode(context[@"error_code"]))) {
    return NO;
  }
  NSArray *paths = context[@"selected_paths"];
  NSString *previousPath = nil;
  for (NSString *path in paths) {
    if (!DSHSessionValidProjectPath(path) ||
        (previousPath != nil && [previousPath compare:path] != NSOrderedAscending)) {
      return NO;
    }
    previousPath = path;
  }
  NSDictionary *manifest = context[@"manifest"] == NSNull.null
      ? nil : context[@"manifest"];
  NSDictionary *consent = context[@"consent"] == NSNull.null
      ? nil : context[@"consent"];
  if (manifest == nil) {
    if (consent != nil) return NO;
  } else if (!DSHSessionValidateProjectContextManifest(manifest, projectId)) {
    return NO;
  }
  if (consent != nil) {
    if (!DSHSessionExactKeys(consent, @[
          @"schema_version", @"consent_receipt_id", @"snapshot_id",
          @"snapshot_sha256", @"confirmed_at",
        ]) ||
        !DSHSessionExactSchema(consent[@"schema_version"], 1) ||
        !DSHSessionCanonicalUUID(consent[@"consent_receipt_id"]) ||
        !DSHSessionCanonicalUUID(consent[@"snapshot_id"]) ||
        !DSHSessionCanonicalDigest(consent[@"snapshot_sha256"]) ||
        !DSHSessionCanonicalTimestamp(consent[@"confirmed_at"] ) ||
        ![consent[@"snapshot_id"] isEqual:manifest[@"snapshot_id"]] ||
        ![consent[@"snapshot_sha256"] isEqual:manifest[@"snapshot_sha256"]] ||
        [consent[@"confirmed_at"] compare:manifest[@"captured_at"]] == NSOrderedAscending) {
      return NO;
    }
  }
  NSString *status = context[@"status"];
  BOOL initialSetup = context[@"active_preparation_id"] == NSNull.null &&
      manifest == nil && consent == nil;
  BOOL preparedSetup = context[@"active_preparation_id"] != NSNull.null &&
      manifest != nil && [(NSArray *)manifest[@"omitted"] count] == 0 &&
      consent == nil;
  BOOL consentMatches = manifest != nil && consent != nil &&
      [consent[@"snapshot_id"] isEqual:manifest[@"snapshot_id"]] &&
      [consent[@"snapshot_sha256"] isEqual:manifest[@"snapshot_sha256"]];
  if ([status isEqual:@"checking"]) {
    return context[@"active_preparation_id"] != NSNull.null && manifest == nil &&
        consent == nil && context[@"stale_reason"] == NSNull.null &&
        context[@"error_code"] == NSNull.null;
  }
  if ([status isEqual:@"setup_required"]) {
    return context[@"stale_reason"] == NSNull.null &&
        context[@"error_code"] == NSNull.null &&
        (initialSetup || preparedSetup);
  }
  if ([status isEqual:@"ready"]) {
    return context[@"active_preparation_id"] == NSNull.null &&
        manifest != nil && [(NSArray *)manifest[@"omitted"] count] == 0 &&
        consentMatches && context[@"stale_reason"] == NSNull.null &&
        context[@"error_code"] == NSNull.null;
  }
  if ([status isEqual:@"partial"]) {
    BOOL partialManifest = manifest != nil &&
        [(NSArray *)manifest[@"omitted"] count] > 0 &&
        context[@"stale_reason"] == NSNull.null &&
        context[@"error_code"] == NSNull.null;
    BOOL partialPrepared = context[@"active_preparation_id"] != NSNull.null &&
        consent == nil;
    BOOL partialConfirmed = context[@"active_preparation_id"] == NSNull.null &&
        consentMatches;
    return partialManifest && (partialPrepared || partialConfirmed);
  }
  if ([status isEqual:@"stale"]) {
    return context[@"stale_reason"] != NSNull.null && consent == nil &&
        context[@"active_preparation_id"] == NSNull.null &&
        context[@"error_code"] == NSNull.null;
  }
  if ([status isEqual:@"error"]) {
    return context[@"error_code"] != NSNull.null && consent == nil &&
        context[@"active_preparation_id"] == NSNull.null &&
        context[@"stale_reason"] == NSNull.null;
  }
  if ([status isEqual:@"unavailable"]) {
    return manifest == nil && consent == nil &&
        context[@"active_preparation_id"] == NSNull.null &&
        context[@"stale_reason"] == NSNull.null &&
        context[@"error_code"] == NSNull.null;
  }
  return NO;
}

static BOOL DSHSessionValidASCIIName(id value, NSUInteger maximumBytes) {
  if (!DSHSessionBoundedText(value, maximumBytes, NO)) return NO;
  NSString *name = value;
  for (NSUInteger index = 0; index < name.length; index += 1) {
    unichar character = [name characterAtIndex:index];
    if (character < 0x21 || character > 0x7e) return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateAgentRoot(NSDictionary *root) {
  if (!DSHSessionExactKeys(root, @[
        @"schema_version", @"kind", @"workspace_id",
        @"workspace_binding_revision", @"project_id",
        @"root_fingerprint_sha256", @"capabilities",
      ]) ||
      !DSHSessionExactSchema(root[@"schema_version"], 1) ||
      !DSHSessionTrustedString(root[@"kind"]) ||
      ![@[@"project", @"workspace"] containsObject:root[@"kind"]] ||
      !DSHSessionCanonicalUUID(root[@"workspace_id"]) ||
      !DSHSessionSafeInteger(root[@"workspace_binding_revision"], NO) ||
      [root[@"workspace_binding_revision"] unsignedIntegerValue] >=
          DSHSessionSnapshotMaximumSafeInteger ||
      !(root[@"project_id"] == NSNull.null ||
        DSHSessionCanonicalUUID(root[@"project_id"])) ||
      !DSHSessionCanonicalDigest(root[@"root_fingerprint_sha256"]) ||
      !DSHSessionTrustedArray(root[@"capabilities"]) ||
      [(NSArray *)root[@"capabilities"] count] > 5) {
    return NO;
  }
  BOOL project = root[@"project_id"] != NSNull.null;
  if (([root[@"kind"] isEqual:@"project"]) != project) return NO;
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push",
  ]];
  NSMutableSet *seen = [NSMutableSet set];
  for (NSString *capability in root[@"capabilities"]) {
    if (!DSHSessionTrustedString(capability) ||
        ![allowed containsObject:capability] ||
        [seen containsObject:capability] ||
        ([root[@"kind"] isEqual:@"workspace"] &&
         [capability hasPrefix:@"git_"])) {
      return NO;
    }
    [seen addObject:capability];
  }
  return YES;
}

static BOOL DSHSessionValidateAgentPolicy(NSDictionary *policy) {
  if (!DSHSessionExactKeys(policy, @[
        @"schema_version", @"policy_version", @"max_single_write_bytes",
        @"max_batch_write_bytes", @"max_attempt_write_bytes",
      ]) ||
      !DSHSessionExactSchema(policy[@"schema_version"], 1) ||
      !DSHSessionBoundedText(policy[@"policy_version"], 256, NO) ||
      !DSHSessionSafeInteger(policy[@"max_single_write_bytes"], YES) ||
      !DSHSessionSafeInteger(policy[@"max_batch_write_bytes"], YES) ||
      !DSHSessionSafeInteger(policy[@"max_attempt_write_bytes"], YES)) {
    return NO;
  }
  NSUInteger single = [policy[@"max_single_write_bytes"] unsignedIntegerValue];
  NSUInteger batch = [policy[@"max_batch_write_bytes"] unsignedIntegerValue];
  NSUInteger attempt = [policy[@"max_attempt_write_bytes"] unsignedIntegerValue];
  return single == 32768 && batch >= 32768 && batch <= 524288 &&
      attempt >= batch && attempt <= 4194304;
}

static BOOL DSHSessionValidateTranscriptReference(NSDictionary *reference) {
  return DSHSessionExactKeys(reference, @[
           @"schema_version", @"transcript_ref", @"generation",
           @"transcript_sha256", @"transcript_bytes",
         ]) &&
      DSHSessionExactSchema(reference[@"schema_version"], 1) &&
      DSHSessionCanonicalUUID(reference[@"transcript_ref"]) &&
      DSHSessionSafeInteger(reference[@"generation"], YES) &&
      DSHSessionCanonicalDigest(reference[@"transcript_sha256"]) &&
      DSHSessionSafeInteger(reference[@"transcript_bytes"], YES) &&
      [reference[@"transcript_bytes"] unsignedIntegerValue] <=
          DSHSessionSnapshotMaximumTranscriptBytes;
}

static BOOL DSHSessionValidateAgentReceipt(NSDictionary *receipt) {
  if (!DSHSessionExactKeys(receipt, @[
        @"schema_version", @"call_id", @"name", @"arguments_sha256",
        @"result_sha256", @"result_bytes", @"truncated", @"duration_ms",
        @"outcome", @"failure_code", @"approval_reference",
      ]) ||
      !DSHSessionExactSchema(receipt[@"schema_version"], 1) ||
      !DSHSessionValidOpaqueIdentifier(receipt[@"call_id"]) ||
      !DSHSessionValidASCIIName(receipt[@"name"], 64) ||
      !DSHSessionCanonicalDigest(receipt[@"arguments_sha256"]) ||
      !DSHSessionCanonicalDigest(receipt[@"result_sha256"]) ||
      !DSHSessionSafeInteger(receipt[@"result_bytes"], YES) ||
      [receipt[@"result_bytes"] unsignedIntegerValue] >
          DSHSessionSnapshotMaximumResultBytes ||
      !DSHSessionIsBoolean(receipt[@"truncated"]) ||
      !DSHSessionSafeInteger(receipt[@"duration_ms"], YES) ||
      [receipt[@"duration_ms"] unsignedIntegerValue] >
          (24U * 60U * 60U * 1000U) ||
      ![@[@"ok", @"failed", @"denied", @"cancelled", @"ambiguous"]
          containsObject:receipt[@"outcome"]] ||
      !DSHSessionValidAgentFailureCode(receipt[@"failure_code"]) ||
      !(receipt[@"approval_reference"] == NSNull.null ||
        DSHSessionValidIdentifier(receipt[@"approval_reference"],
                                  DSHSessionSnapshotMaximumIdBytes))) {
    return NO;
  }
  if ([receipt[@"outcome"] isEqual:@"ok"] &&
      receipt[@"failure_code"] != NSNull.null) {
    return NO;
  }
  if (([receipt[@"outcome"] isEqual:@"failed"] ||
       [receipt[@"outcome"] isEqual:@"denied"] ||
       [receipt[@"outcome"] isEqual:@"cancelled"]) &&
      [receipt[@"failure_code"] isEqual:@"E_AGENT_EXECUTION_AMBIGUOUS"]) {
    return NO;
  }
  if ([receipt[@"outcome"] isEqual:@"ambiguous"] &&
      ![receipt[@"failure_code"] isEqual:@"E_AGENT_EXECUTION_AMBIGUOUS"]) {
    return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateAgentCall(NSDictionary *call) {
  if (!DSHSessionExactKeys(call, @[
        @"schema_version", @"call_id", @"call_index", @"name",
        @"arguments_sha256", @"safe_summary_key", @"access",
        @"approval_token", @"approval_decision", @"approval_reference",
        @"idempotency_key", @"native_row_revision", @"receipt",
      ]) ||
      !DSHSessionExactSchema(call[@"schema_version"], 3) ||
      !DSHSessionValidOpaqueIdentifier(call[@"call_id"]) ||
      !DSHSessionSafeInteger(call[@"call_index"], YES) ||
      !DSHSessionValidASCIIName(call[@"name"], 64) ||
      !DSHSessionCanonicalDigest(call[@"arguments_sha256"]) ||
      !DSHSessionValidAgentSummaryKey(call[@"safe_summary_key"]) ||
      ![@[@"auto", @"conversation_confirm", @"confirm_once", @"durable_deny"]
          containsObject:call[@"access"]] ||
      ![@[@"pending", @"denied", @"allow_once", @"allow_conversation",
          @"cancelled"] containsObject:call[@"approval_decision"]] ||
      !(call[@"approval_token"] == NSNull.null ||
        DSHSessionValidIdentifier(call[@"approval_token"],
                                  DSHSessionSnapshotMaximumIdBytes)) ||
      !(call[@"approval_reference"] == NSNull.null ||
        DSHSessionValidIdentifier(call[@"approval_reference"],
                                  DSHSessionSnapshotMaximumIdBytes)) ||
      !(call[@"idempotency_key"] == NSNull.null ||
        DSHSessionCanonicalDigest(call[@"idempotency_key"])) ||
      !(call[@"native_row_revision"] == NSNull.null ||
        DSHSessionSafeInteger(call[@"native_row_revision"], NO)) ||
      !(call[@"receipt"] == NSNull.null ||
        DSHSessionTrustedDictionary(call[@"receipt"]))) {
    return NO;
  }
  if (call[@"receipt"] != NSNull.null &&
      call[@"native_row_revision"] == NSNull.null) {
    return NO;
  }
  if (call[@"receipt"] != NSNull.null &&
      !DSHSessionValidateAgentReceipt(call[@"receipt"])) {
    return NO;
  }
  if (call[@"receipt"] != NSNull.null &&
      ([call[@"receipt"][@"call_id"] isEqual:call[@"call_id"]] == NO ||
       [call[@"receipt"][@"name"] isEqual:call[@"name"]] == NO ||
       [call[@"receipt"][@"arguments_sha256"] isEqual:call[@"arguments_sha256"]] == NO)) {
    return NO;
  }
  if (call[@"receipt"] != NSNull.null &&
      (([call[@"receipt"][@"outcome"] isEqual:@"ok"] &&
        call[@"receipt"][@"failure_code"] != NSNull.null) ||
       ([call[@"receipt"][@"outcome"] isEqual:@"ambiguous"] &&
        ![call[@"receipt"][@"failure_code"] isEqual:@"E_AGENT_EXECUTION_AMBIGUOUS"]) ||
       (([call[@"receipt"][@"outcome"] isEqual:@"failed"] ||
         [call[@"receipt"][@"outcome"] isEqual:@"denied"] ||
         [call[@"receipt"][@"outcome"] isEqual:@"cancelled"]) &&
        [call[@"receipt"][@"failure_code"] isEqual:@"E_AGENT_EXECUTION_AMBIGUOUS"]))) {
    return NO;
  }
  NSString *name = call[@"name"];
  NSSet *registered = [NSSet setWithArray:@[
    @"list_dir", @"read_file", @"write_file", @"git_status", @"git_commit",
    @"git_push",
  ]];
  NSSet *autoTools = [NSSet setWithArray:@[@"list_dir", @"read_file", @"git_status"]];
  NSSet *conversationTools = [NSSet setWithArray:@[@"write_file", @"git_commit"]];
  if (!DSHSessionAgentSummaryMatchesName(call[@"safe_summary_key"], name)) {
    return NO;
  }
  if (![registered containsObject:name] &&
      ![call[@"access"] isEqual:@"durable_deny"]) {
    return NO;
  }
  if ([autoTools containsObject:name] && ![call[@"access"] isEqual:@"auto"]) return NO;
  if ([conversationTools containsObject:name] &&
      ![call[@"access"] isEqual:@"conversation_confirm"]) return NO;
  if ([name isEqual:@"git_push"] && ![call[@"access"] isEqual:@"confirm_once"]) return NO;
  if ([call[@"access"] isEqual:@"durable_deny"] &&
      (![call[@"approval_decision"] isEqual:@"denied"] ||
       call[@"approval_token"] != NSNull.null ||
       call[@"approval_reference"] != NSNull.null)) {
    return NO;
  }
  if ([call[@"access"] isEqual:@"auto"] &&
      (call[@"approval_token"] != NSNull.null ||
       call[@"approval_reference"] != NSNull.null)) {
    return NO;
  }
  if (([call[@"access"] isEqual:@"conversation_confirm"] ||
       [call[@"access"] isEqual:@"confirm_once"]) &&
      call[@"approval_token"] == NSNull.null) {
    return NO;
  }
  if ([name isEqual:@"git_push"] &&
      [call[@"approval_decision"] isEqual:@"allow_conversation"]) {
    return NO;
  }
  NSDictionary *receipt = call[@"receipt"] == NSNull.null ? nil : call[@"receipt"];
  return receipt == nil ||
      (DSHSessionValidateAgentReceipt(receipt) &&
       [receipt[@"call_id"] isEqual:call[@"call_id"]] &&
       [receipt[@"name"] isEqual:call[@"name"]] &&
       [receipt[@"arguments_sha256"] isEqual:call[@"arguments_sha256"]]);
}

static BOOL DSHSessionValidateAgentJournal(NSDictionary *journal) {
  if (!DSHSessionExactKeys(journal, @[
        @"schema_version", @"phase", @"controller_generation", @"policy",
        @"root", @"tool_registry_version", @"toolset_sha256", @"transcript",
        @"round_index", @"round_lineage", @"call_index", @"batch",
        @"frozen_grant_ids", @"reserved_write_bytes", @"updated_at",
      ]) ||
      !DSHSessionExactSchema(journal[@"schema_version"], 3) ||
      ![@[@"ready_for_round", @"round_in_flight", @"batch_frozen",
          @"approval_pending", @"execution_intent", @"tool_result_pending",
          @"final_response", @"cancelled", @"failed", @"unknown", @"ambiguous"]
          containsObject:journal[@"phase"]] ||
      !DSHSessionSafeInteger(journal[@"controller_generation"], YES) ||
      !DSHSessionTrustedDictionary(journal[@"policy"]) ||
      !DSHSessionValidateAgentPolicy(journal[@"policy"]) ||
      !DSHSessionTrustedDictionary(journal[@"root"]) ||
      !DSHSessionValidateAgentRoot(journal[@"root"]) ||
      !DSHSessionExactSchema(journal[@"tool_registry_version"], 1) ||
      !DSHSessionCanonicalDigest(journal[@"toolset_sha256"]) ||
      !DSHSessionTrustedDictionary(journal[@"transcript"]) ||
      !DSHSessionValidateTranscriptReference(journal[@"transcript"]) ||
      !DSHSessionSafeInteger(journal[@"round_index"], YES) ||
      [journal[@"round_index"] unsignedIntegerValue] >= 8 ||
      !(journal[@"round_lineage"] == NSNull.null ||
        DSHSessionTrustedDictionary(journal[@"round_lineage"])) ||
      !(journal[@"call_index"] == NSNull.null ||
        DSHSessionSafeInteger(journal[@"call_index"], YES)) ||
      !DSHSessionTrustedArray(journal[@"batch"]) ||
      [(NSArray *)journal[@"batch"] count] > 16 ||
      !DSHSessionTrustedArray(journal[@"frozen_grant_ids"]) ||
      [(NSArray *)journal[@"frozen_grant_ids"] count] > 2 ||
      !DSHSessionSafeInteger(journal[@"reserved_write_bytes"], YES) ||
      [journal[@"reserved_write_bytes"] unsignedIntegerValue] >
          [journal[@"policy"][@"max_attempt_write_bytes"] unsignedIntegerValue] ||
      !DSHSessionCanonicalTimestamp(journal[@"updated_at"])) {
    return NO;
  }
  NSMutableSet *callIds = [NSMutableSet set];
  for (NSUInteger index = 0; index < [(NSArray *)journal[@"batch"] count]; index += 1) {
    NSDictionary *call = journal[@"batch"][index];
    if (!DSHSessionValidateAgentCall(call) ||
        [call[@"call_index"] unsignedIntegerValue] != index ||
        [callIds containsObject:call[@"call_id"]]) {
      return NO;
    }
    [callIds addObject:call[@"call_id"]];
  }
  if (journal[@"call_index"] != NSNull.null &&
      [journal[@"call_index"] unsignedIntegerValue] >=
          [(NSArray *)journal[@"batch"] count]) {
    return NO;
  }
  NSMutableSet *grantIds = [NSMutableSet set];
  for (NSString *grantId in journal[@"frozen_grant_ids"]) {
    if (!DSHSessionCanonicalUUID(grantId) || [grantIds containsObject:grantId]) return NO;
    [grantIds addObject:grantId];
  }
  NSDictionary *lineage = journal[@"round_lineage"] == NSNull.null
      ? nil : journal[@"round_lineage"];
  if (lineage != nil &&
      (!DSHSessionExactKeys(lineage, @[
        @"schema_version", @"round_id", @"round_index", @"launch_attempt",
        @"status", @"native_row_revision",
      ]) ||
       !DSHSessionExactSchema(lineage[@"schema_version"], 2) ||
       !DSHSessionCanonicalUUID(lineage[@"round_id"]) ||
       !DSHSessionSafeInteger(lineage[@"round_index"], YES) ||
       [lineage[@"round_index"] unsignedIntegerValue] !=
           [journal[@"round_index"] unsignedIntegerValue] ||
       !DSHSessionSafeInteger(lineage[@"launch_attempt"], NO) ||
       [lineage[@"launch_attempt"] unsignedIntegerValue] > 8 ||
       ![@[@"ready", @"active", @"failed_retryable", @"completed",
           @"cancel_requested", @"cancelled", @"unknown", @"ambiguous"]
           containsObject:lineage[@"status"]] ||
       !(lineage[@"native_row_revision"] == NSNull.null ||
         DSHSessionSafeInteger(lineage[@"native_row_revision"], NO)))) {
    return NO;
  }
  NSString *phase = journal[@"phase"];
  NSString *lineageStatus = lineage[@"status"];
  NSArray *batch = journal[@"batch"];
  if ([phase isEqual:@"ready_for_round"] &&
      (journal[@"call_index"] != NSNull.null || batch.count != 0 ||
       (lineage != nil && ![lineageStatus isEqual:@"ready"]))) return NO;
  if ([phase isEqual:@"round_in_flight"] &&
      (lineage == nil || ![lineageStatus isEqual:@"active"])) return NO;
  if (([phase isEqual:@"batch_frozen"] || [phase isEqual:@"approval_pending"] ||
       [phase isEqual:@"execution_intent"] || [phase isEqual:@"tool_result_pending"]) &&
      (lineage == nil || ![lineageStatus isEqual:@"completed"])) return NO;
  if ([phase isEqual:@"approval_pending"]) {
    BOOL pending = NO;
    for (NSDictionary *call in batch) {
      pending |= ![call[@"access"] isEqual:@"auto"] &&
          ![call[@"access"] isEqual:@"durable_deny"] &&
          [call[@"approval_decision"] isEqual:@"pending"];
    }
    if (!pending) return NO;
  }
  if ([phase isEqual:@"execution_intent"]) {
    if (journal[@"call_index"] == NSNull.null) return NO;
    NSDictionary *call = batch[[journal[@"call_index"] unsignedIntegerValue]];
    if (call[@"idempotency_key"] == NSNull.null ||
       (![call[@"access"] isEqual:@"auto"] &&
        ![call[@"approval_decision"] isEqual:@"allow_once"] &&
         ![call[@"approval_decision"] isEqual:@"allow_conversation"])) return NO;
  }
  if ([phase isEqual:@"tool_result_pending"]) {
    if (journal[@"call_index"] == NSNull.null ||
        batch[[journal[@"call_index"] unsignedIntegerValue]][@"receipt"] == NSNull.null ||
        (![batch[[journal[@"call_index"] unsignedIntegerValue]][@"receipt"][@"outcome"]
             isEqual:@"ok"] &&
         ![batch[[journal[@"call_index"] unsignedIntegerValue]][@"receipt"][@"outcome"]
             isEqual:@"failed"] &&
         ![batch[[journal[@"call_index"] unsignedIntegerValue]][@"receipt"][@"outcome"]
             isEqual:@"denied"])) return NO;
  }
  if ([phase isEqual:@"cancelled"]) {
    for (NSDictionary *call in batch) {
      if (call[@"receipt"] == NSNull.null &&
          ![call[@"approval_decision"] isEqual:@"denied"] &&
          ![call[@"approval_decision"] isEqual:@"cancelled"]) return NO;
    }
  }
  return YES;
}

static BOOL DSHSessionValidateAgentGrant(NSDictionary *grant) {
  if (!DSHSessionExactKeys(grant, @[
        @"schema_version", @"grant_id", @"conversation_id", @"workspace_id",
        @"project_id", @"binding_revision", @"root_fingerprint_sha256",
        @"tool_family", @"registry_version", @"policy_version", @"issued_for",
        @"created_at",
      ]) ||
      !DSHSessionExactSchema(grant[@"schema_version"], 2) ||
      !DSHSessionCanonicalUUID(grant[@"grant_id"]) ||
      !DSHSessionValidIdentifier(grant[@"conversation_id"],
                                 DSHSessionSnapshotMaximumIdBytes) ||
      !DSHSessionCanonicalUUID(grant[@"workspace_id"]) ||
      !(grant[@"project_id"] == NSNull.null ||
        DSHSessionCanonicalUUID(grant[@"project_id"])) ||
      !DSHSessionSafeInteger(grant[@"binding_revision"], NO) ||
      [grant[@"binding_revision"] unsignedIntegerValue] >=
          DSHSessionSnapshotMaximumSafeInteger ||
      !DSHSessionCanonicalDigest(grant[@"root_fingerprint_sha256"]) ||
      ![@[@"file_write", @"git_commit"] containsObject:grant[@"tool_family"]] ||
      ([grant[@"tool_family"] isEqual:@"git_commit"] && grant[@"project_id"] == NSNull.null) ||
      !DSHSessionExactSchema(grant[@"registry_version"], 1) ||
      !DSHSessionBoundedText(grant[@"policy_version"], 256, NO) ||
      !DSHSessionTrustedDictionary(grant[@"issued_for"]) ||
      !DSHSessionExactKeys(grant[@"issued_for"], @[@"schema_version", @"task_id", @"attempt_id"]) ||
      !DSHSessionExactSchema(grant[@"issued_for"][@"schema_version"], 1) ||
      !DSHSessionCanonicalUUID(grant[@"issued_for"][@"task_id"]) ||
      !DSHSessionCanonicalUUID(grant[@"issued_for"][@"attempt_id"]) ||
      !DSHSessionCanonicalTimestamp(grant[@"created_at"])) {
    return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateCleanup(NSDictionary *cleanup) {
  return DSHSessionExactKeys(cleanup, @[
           @"schema_version", @"cleanup_id", @"conversation_id", @"task_id",
           @"attempt_id", @"transcript_ref", @"transcript_sha256", @"reason",
           @"created_at",
         ]) &&
      DSHSessionExactSchema(cleanup[@"schema_version"], 1) &&
      DSHSessionCanonicalUUID(cleanup[@"cleanup_id"]) &&
      DSHSessionValidIdentifier(cleanup[@"conversation_id"],
                                DSHSessionSnapshotMaximumIdBytes) &&
      DSHSessionCanonicalUUID(cleanup[@"task_id"]) &&
      DSHSessionCanonicalUUID(cleanup[@"attempt_id"]) &&
      DSHSessionCanonicalUUID(cleanup[@"transcript_ref"]) &&
      DSHSessionCanonicalDigest(cleanup[@"transcript_sha256"]) &&
      [@[@"completed", @"cancelled", @"failed", @"conversation_deleted"]
          containsObject:cleanup[@"reason"]] &&
      DSHSessionCanonicalTimestamp(cleanup[@"created_at"]);
}

static BOOL DSHSessionValidateProjectContextReceipt(id receipt) {
  if (receipt == NSNull.null) return YES;
  return DSHSessionExactKeys(receipt, @[
           @"schema_version", @"snapshot_id", @"snapshot_sha256",
           @"source_fingerprint", @"context_bytes", @"verified_at",
         ]) &&
      DSHSessionExactSchema(receipt[@"schema_version"], 1) &&
      DSHSessionCanonicalUUID(receipt[@"snapshot_id"]) &&
      DSHSessionCanonicalDigest(receipt[@"snapshot_sha256"]) &&
      DSHSessionCanonicalDigest(receipt[@"source_fingerprint"]) &&
      DSHSessionSafeInteger(receipt[@"context_bytes"], YES) &&
      [receipt[@"context_bytes"] unsignedIntegerValue] > 0 &&
      [receipt[@"context_bytes"] unsignedIntegerValue] <=
          DSHSessionSnapshotMaximumContextBytes &&
      DSHSessionCanonicalTimestamp(receipt[@"verified_at"]);
}

static BOOL DSHSessionValidateAttemptProjectContext(NSDictionary *context) {
  return DSHSessionExactKeys(context, @[
           @"schema_version", @"runtime_context_id", @"project_id",
           @"snapshot_id", @"snapshot_sha256", @"source_fingerprint",
           @"context_bytes", @"consent_receipt_id", @"provider", @"policy",
           @"policy_version",
         ]) &&
      DSHSessionExactSchema(context[@"schema_version"], 1) &&
      DSHSessionCanonicalUUID(context[@"runtime_context_id"]) &&
      DSHSessionValidIdentifier(context[@"project_id"],
                                DSHSessionSnapshotMaximumIdBytes) &&
      DSHSessionCanonicalUUID(context[@"snapshot_id"]) &&
      DSHSessionCanonicalDigest(context[@"snapshot_sha256"]) &&
      DSHSessionCanonicalDigest(context[@"source_fingerprint"]) &&
      DSHSessionSafeInteger(context[@"context_bytes"], YES) &&
      [context[@"context_bytes"] unsignedIntegerValue] > 0 &&
      [context[@"context_bytes"] unsignedIntegerValue] <=
          DSHSessionSnapshotMaximumContextBytes &&
      DSHSessionCanonicalUUID(context[@"consent_receipt_id"]) &&
      [context[@"provider"] isEqual:@"deepseek"] &&
      [context[@"policy"] isEqual:@"chat-read-v1"] &&
      [context[@"policy_version"] isEqual:@"chat-read-v1.0.0"];
}

static BOOL DSHSessionValidateRoundReceipt(NSDictionary *receipt) {
  if (!DSHSessionExactKeys(receipt, @[
        @"schema_version", @"transport_schema_version", @"turn_id",
        @"attempt_id", @"round_id", @"round_index", @"provider_request_id",
        @"provider_response_id", @"requested_model", @"model", @"thinking_mode",
        @"finish_reason", @"latency_ms", @"visible_history_sha256",
        @"model_input_sha256", @"request_body_sha256", @"project_context_receipt",
      ]) ||
      !DSHSessionExactSchema(receipt[@"schema_version"], 1) ||
      !DSHSessionSafeInteger(receipt[@"transport_schema_version"], NO) ||
      (![receipt[@"transport_schema_version"] isEqual:@2] &&
       ![receipt[@"transport_schema_version"] isEqual:@3]) ||
      !DSHSessionCanonicalUUID(receipt[@"turn_id"]) ||
      !DSHSessionCanonicalUUID(receipt[@"attempt_id"]) ||
      !DSHSessionCanonicalUUID(receipt[@"round_id"]) ||
      !DSHSessionSafeInteger(receipt[@"round_index"], YES) ||
      [receipt[@"round_index"] unsignedIntegerValue] >= 8 ||
      !DSHSessionCanonicalUUID(receipt[@"provider_request_id"]) ||
      !DSHSessionValidOpaqueIdentifier(receipt[@"provider_response_id"]) ||
      !DSHSessionValidModel(receipt[@"requested_model"]) ||
      !DSHSessionValidModel(receipt[@"model"]) ||
      !DSHSessionValidThinkingMode(receipt[@"thinking_mode"]) ||
      ![@[@"stop", @"tool_calls", @"length", @"content_filter"]
          containsObject:receipt[@"finish_reason"]] ||
      !DSHSessionSafeInteger(receipt[@"latency_ms"], YES) ||
      !DSHSessionCanonicalDigest(receipt[@"visible_history_sha256"]) ||
      !DSHSessionCanonicalDigest(receipt[@"model_input_sha256"]) ||
      !DSHSessionCanonicalDigest(receipt[@"request_body_sha256"]) ||
      !(receipt[@"project_context_receipt"] == NSNull.null ||
        DSHSessionTrustedDictionary(receipt[@"project_context_receipt"])) ||
      !DSHSessionValidateProjectContextReceipt(receipt[@"project_context_receipt"])) {
    return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateTurn(NSDictionary *turn) {
  if (!DSHSessionExactKeys(turn, @[
        @"schema_version", @"turn_id", @"user_message_id", @"attempt_ids",
        @"created_at",
      ]) ||
      !DSHSessionExactSchema(turn[@"schema_version"], 1) ||
      !DSHSessionCanonicalUUID(turn[@"turn_id"]) ||
      !DSHSessionValidIdentifier(turn[@"user_message_id"],
                                 DSHSessionSnapshotMaximumIdBytes) ||
      !DSHSessionTrustedArray(turn[@"attempt_ids"]) ||
      [(NSArray *)turn[@"attempt_ids"] count] == 0 ||
      [(NSArray *)turn[@"attempt_ids"] count] > DSHSessionSnapshotMaximumAttempts ||
      !DSHSessionCanonicalTimestamp(turn[@"created_at"])) {
    return NO;
  }
  NSMutableSet *ids = [NSMutableSet set];
  for (NSString *attemptId in turn[@"attempt_ids"]) {
    if (!DSHSessionCanonicalUUID(attemptId) || [ids containsObject:attemptId]) return NO;
    [ids addObject:attemptId];
  }
  return YES;
}

static BOOL DSHSessionValidateAttempt(NSDictionary *attempt,
                                      NSUInteger schemaVersion) {
  BOOL workspaceRouting = schemaVersion >= 8;
  BOOL agentSchema = schemaVersion >= 9;
  NSMutableArray *keys = [NSMutableArray arrayWithArray:@[
    @"schema_version", @"attempt_id", @"turn_id", @"status",
    @"visible_message_ids", @"visible_history_sha256", @"attachment_ids",
    @"model_id", @"thinking_mode", @"context_disposition", @"context_project_id",
    @"project_context", @"active_round", @"rounds", @"assistant_message_id",
    @"failure_code", @"created_at", @"updated_at",
  ]];
  if (workspaceRouting) {
    [keys addObject:@"workspace_id"];
    [keys addObject:@"workspace_binding_revision"];
  }
  if (agentSchema) {
    [keys addObject:@"journal_revision"];
    [keys addObject:@"agent"];
  }
  if (!DSHSessionExactKeys(attempt, keys) ||
      !DSHSessionExactSchema(attempt[@"schema_version"], agentSchema ? 3 : 1) ||
      !DSHSessionCanonicalUUID(attempt[@"attempt_id"]) ||
      !DSHSessionCanonicalUUID(attempt[@"turn_id"]) ||
      ![@[@"prepared", @"sending", @"completed", @"failed", @"cancelled"]
          containsObject:attempt[@"status"]] ||
      !DSHSessionTrustedArray(attempt[@"visible_message_ids"]) ||
      [(NSArray *)attempt[@"visible_message_ids"] count] >
          DSHSessionSnapshotMaximumVisibleMessages ||
      !DSHSessionTrustedArray(attempt[@"attachment_ids"]) ||
      [(NSArray *)attempt[@"attachment_ids"] count] >
          DSHSessionSnapshotMaximumVisibleAttachments ||
      !DSHSessionValidModel(attempt[@"model_id"]) ||
      !DSHSessionValidThinkingMode(attempt[@"thinking_mode"]) ||
      ![@[@"unbound", @"verified", @"explicit_without_context"]
          containsObject:attempt[@"context_disposition"]] ||
      !(attempt[@"context_project_id"] == NSNull.null ||
        DSHSessionValidIdentifier(attempt[@"context_project_id"],
                                  DSHSessionSnapshotMaximumIdBytes)) ||
      !(attempt[@"project_context"] == NSNull.null ||
        DSHSessionTrustedDictionary(attempt[@"project_context"])) ||
      !(attempt[@"active_round"] == NSNull.null ||
        DSHSessionTrustedDictionary(attempt[@"active_round"])) ||
      !DSHSessionTrustedArray(attempt[@"rounds"]) ||
      [(NSArray *)attempt[@"rounds"] count] > 8 ||
      !(attempt[@"assistant_message_id"] == NSNull.null ||
        DSHSessionValidIdentifier(attempt[@"assistant_message_id"],
                                  DSHSessionSnapshotMaximumIdBytes)) ||
      !DSHSessionValidAttemptFailureCode(attempt[@"failure_code"]) ||
      !DSHSessionCanonicalTimestamp(attempt[@"created_at"]) ||
      !DSHSessionCanonicalTimestamp(attempt[@"updated_at"]) ||
      [attempt[@"created_at"] compare:attempt[@"updated_at"]] == NSOrderedDescending) {
    return NO;
  }
  NSMutableSet *visibleIds = [NSMutableSet set];
  for (NSString *messageId in attempt[@"visible_message_ids"]) {
    if (!DSHSessionValidIdentifier(messageId, DSHSessionSnapshotMaximumIdBytes) ||
        [visibleIds containsObject:messageId]) return NO;
    [visibleIds addObject:messageId];
  }
  NSMutableSet *attachmentIds = [NSMutableSet set];
  for (NSString *attachmentId in attempt[@"attachment_ids"]) {
    if (!DSHSessionValidIdentifier(attachmentId, DSHSessionSnapshotMaximumIdBytes) ||
        [attachmentIds containsObject:attachmentId]) return NO;
    [attachmentIds addObject:attachmentId];
  }
  if (attempt[@"visible_history_sha256"] != NSNull.null &&
      !DSHSessionCanonicalDigest(attempt[@"visible_history_sha256"])) return NO;
  if (workspaceRouting) {
    BOOL hasWorkspace = attempt[@"workspace_id"] != NSNull.null;
    BOOL hasRevision = attempt[@"workspace_binding_revision"] != NSNull.null;
    if (hasWorkspace != hasRevision ||
        (hasWorkspace && !DSHSessionCanonicalUUID(attempt[@"workspace_id"])) ||
        (hasRevision && !DSHSessionSafeInteger(attempt[@"workspace_binding_revision"], NO))) {
      return NO;
    }
  }
  NSDictionary *context = attempt[@"project_context"] == NSNull.null
      ? nil : attempt[@"project_context"];
  NSString *contextDisposition = attempt[@"context_disposition"];
  BOOL verified = [contextDisposition isEqual:@"verified"];
  if ((context != nil) != verified ||
      ([contextDisposition isEqual:@"unbound"] &&
       (context != nil || attempt[@"context_project_id"] != NSNull.null)) ||
      ([contextDisposition isEqual:@"explicit_without_context"] &&
       (context != nil || attempt[@"context_project_id"] == NSNull.null)) ||
      (verified &&
       (attempt[@"context_project_id"] == NSNull.null ||
        ![context[@"project_id"] isEqual:attempt[@"context_project_id"]]))) {
    return NO;
  }
  if (context != nil) {
    if (!DSHSessionValidateAttemptProjectContext(context) ||
        ![context[@"project_id"] isEqual:attempt[@"context_project_id"]]) return NO;
  }
  for (NSDictionary *round in attempt[@"rounds"]) {
    if (!DSHSessionValidateRoundReceipt(round)) return NO;
  }
  if (attempt[@"active_round"] != NSNull.null) {
    NSDictionary *active = attempt[@"active_round"];
    if (!DSHSessionExactKeys(active, @[@"round_id", @"round_index"]) ||
        !DSHSessionCanonicalUUID(active[@"round_id"]) ||
        !DSHSessionSafeInteger(active[@"round_index"], YES) ||
        [active[@"round_index"] unsignedIntegerValue] >= 8 ||
        [active[@"round_index"] unsignedIntegerValue] !=
            [(NSArray *)attempt[@"rounds"] count]) return NO;
  }
  BOOL sending = [attempt[@"status"] isEqual:@"sending"];
  if (sending != (attempt[@"active_round"] != NSNull.null) ||
      ([attempt[@"status"] isEqual:@"completed"] !=
       (attempt[@"assistant_message_id"] != NSNull.null)) ||
      ([attempt[@"status"] isEqual:@"failed"] !=
       (attempt[@"failure_code"] != NSNull.null)) ||
      ([attempt[@"status"] isEqual:@"cancelled"] &&
       attempt[@"failure_code"] != NSNull.null) ||
      (![attempt[@"status"] isEqual:@"completed"] &&
       attempt[@"assistant_message_id"] != NSNull.null) ||
      (([attempt[@"status"] isEqual:@"prepared"] ||
        [attempt[@"status"] isEqual:@"sending"]) &&
       attempt[@"failure_code"] != NSNull.null) ||
      ([(NSArray *)attempt[@"rounds"] count] > 0 &&
       attempt[@"visible_history_sha256"] == NSNull.null)) return NO;
  if (agentSchema) {
    if (!DSHSessionSafeInteger(attempt[@"journal_revision"], YES) ||
        !DSHSessionTrustedDictionary(attempt[@"agent"])) {
      if (attempt[@"agent"] != NSNull.null ||
          !DSHSessionSafeInteger(attempt[@"journal_revision"], YES)) return NO;
    }
    if (attempt[@"agent"] == NSNull.null) {
      if ([attempt[@"journal_revision"] unsignedIntegerValue] != 0) return NO;
    } else if ([attempt[@"journal_revision"] unsignedIntegerValue] < 1 ||
               !DSHSessionValidateAgentJournal(attempt[@"agent"])) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHSessionFrozenAttemptEqual(NSDictionary *left,
                                         NSDictionary *right) {
  NSArray *keys = @[
    @"visible_message_ids", @"attachment_ids", @"model_id",
    @"thinking_mode", @"context_disposition", @"context_project_id",
    @"workspace_id", @"workspace_binding_revision", @"project_context",
  ];
  for (NSString *key in keys) {
    if (![left[key] isEqual:right[key]]) return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateConversation(NSDictionary *conversation,
                                           NSUInteger schemaVersion,
                                           NSMutableDictionary **messagesByIdOut,
                                           NSMutableDictionary **attemptsByIdOut) {
  BOOL projectContextShape = schemaVersion >= 6;
  BOOL workspaceRouting = schemaVersion >= 8;
  BOOL agentSchema = schemaVersion >= 9;
  NSArray *required = nil;
  NSArray *optional = @[];
  if (schemaVersion <= 2) {
    required = @[
      @"id", @"title", @"title_source", @"model_id", @"messages",
      @"created_at", @"updated_at",
    ];
    optional = @[@"thinking_mode"];
  } else if (schemaVersion <= 4) {
    required = @[
      @"id", @"project_id", @"title", @"title_source", @"model_id",
      @"thinking_mode", @"messages", @"created_at", @"updated_at",
    ];
  } else if (schemaVersion == 5) {
    required = @[
      @"id", @"project_id", @"workspace_id", @"title", @"title_source",
      @"model_id", @"thinking_mode", @"messages", @"created_at", @"updated_at",
    ];
  } else {
    NSMutableArray *base = [NSMutableArray arrayWithArray:@[
      @"id", @"project_id", @"workspace_id", @"runtime_context_id",
      @"project_context", @"title", @"title_source", @"model_id",
      @"thinking_mode", @"messages", @"turns", @"attempts", @"created_at",
      @"updated_at",
    ]];
    if (workspaceRouting) {
      [base addObject:@"workspace_binding"];
      [base addObject:@"workspace_bootstrap_state"];
    }
    if (agentSchema) [base addObject:@"agent_grants"];
    required = base;
  }
  if (!DSHSessionKeys(conversation, required, optional) ||
      !DSHSessionValidIdentifier(conversation[@"id"],
                                 DSHSessionSnapshotMaximumIdBytes) ||
      !DSHSessionBoundedText(conversation[@"title"],
                             DSHSessionSnapshotMaximumTitleBytes, NO) ||
      ![@[@"auto", @"manual"] containsObject:conversation[@"title_source"]] ||
      !DSHSessionValidModel(conversation[@"model_id"]) ||
      (conversation[@"thinking_mode"] != nil &&
       !DSHSessionValidThinkingMode(conversation[@"thinking_mode"])) ||
      !DSHSessionTrustedArray(conversation[@"messages"]) ||
      !DSHSessionValidTimestampPair(conversation[@"created_at"],
                                    conversation[@"updated_at"])) {
    return NO;
  }
  NSString *projectId = nil;
  if (schemaVersion <= 2) {
    projectId = nil;
  } else if (conversation[@"project_id"] != NSNull.null) {
    if (!DSHSessionValidIdentifier(conversation[@"project_id"],
                                   DSHSessionSnapshotMaximumIdBytes)) return NO;
    projectId = conversation[@"project_id"];
  }
  if (projectContextShape &&
      (conversation[@"runtime_context_id"] == NSNull.null
           ? NO
           : !DSHSessionCanonicalUUID(conversation[@"runtime_context_id"]))) {
    return NO;
  }
  if (projectContextShape &&
      !(conversation[@"project_context"] == NSNull.null ||
        DSHSessionTrustedDictionary(conversation[@"project_context"]))) {
    return NO;
  }
  NSDictionary *context = projectContextShape &&
          conversation[@"project_context"] != NSNull.null
      ? conversation[@"project_context"] : nil;
  if ((projectId == nil) != (context == nil)) return NO;
  if (context != nil && !DSHSessionValidateProjectContext(context, projectId)) return NO;
  BOOL contextSendable = context != nil &&
      ([context[@"status"] isEqual:@"ready"] ||
       [context[@"status"] isEqual:@"partial"]);
  if (contextSendable) {
    NSDictionary *manifest = context[@"manifest"] == NSNull.null
        ? nil : context[@"manifest"];
    if (conversation[@"runtime_context_id"] == NSNull.null ||
        manifest == nil ||
        ![manifest[@"model"] isEqual:conversation[@"model_id"]]) {
      return NO;
    }
  }

  if (workspaceRouting) {
    id workspaceId = conversation[@"workspace_id"];
    if (workspaceId != NSNull.null &&
        !DSHSessionValidIdentifier(workspaceId,
                                   DSHSessionSnapshotMaximumIdBytes)) return NO;
    if (![@[@"none", @"pending_legacy_project", @"pending_registry_resolution",
            @"blocked_invalid_legacy_id", @"blocked_missing_legacy_workspace"]
          containsObject:conversation[@"workspace_bootstrap_state"]]) return NO;
    id binding = conversation[@"workspace_binding"];
    if (binding != NSNull.null) {
      if (!DSHSessionTrustedDictionary(binding) ||
          !DSHSessionExactKeys(binding, @[
            @"schema_version", @"workspace_id", @"binding_revision", @"project_id",
          ]) ||
          !DSHSessionExactSchema(binding[@"schema_version"], 1) ||
          !DSHSessionCanonicalUUID(binding[@"workspace_id"]) ||
          !DSHSessionSafeInteger(binding[@"binding_revision"], NO) ||
          [binding[@"binding_revision"] unsignedIntegerValue] >=
              DSHSessionSnapshotMaximumSafeInteger ||
          !(binding[@"project_id"] == NSNull.null ||
            DSHSessionValidIdentifier(binding[@"project_id"],
                                      DSHSessionSnapshotMaximumIdBytes)) ||
          ![binding[@"workspace_id"] isEqual:workspaceId] ||
          ![binding[@"project_id"] isEqual:(projectId ?: NSNull.null)] ||
          ![conversation[@"workspace_bootstrap_state"] isEqual:@"none"]) {
        return NO;
      }
    } else if (workspaceId != NSNull.null &&
               [conversation[@"workspace_bootstrap_state"] isEqual:@"none"]) {
      return NO;
    }
  } else if (schemaVersion >= 5 &&
             !DSHSessionStringOrNull(conversation[@"workspace_id"])) {
    return NO;
  }
  if (contextSendable && workspaceRouting &&
      [conversation[@"workspace_bootstrap_state"] isEqual:@"none"] &&
      conversation[@"workspace_binding"] == NSNull.null) {
    return NO;
  }

  NSMutableDictionary *messagesById = nil;
  if (!DSHSessionValidateMessages(
          conversation[@"messages"], schemaVersion, &messagesById)) return NO;
  if ([messagesById.allValues filteredArrayUsingPredicate:
          [NSPredicate predicateWithBlock:^BOOL(NSDictionary *message,
                                                NSDictionary *bindings) {
            return [message[@"created_at"] compare:conversation[@"updated_at"]] ==
                NSOrderedDescending;
          }]].count > 0) return NO;

  NSMutableDictionary *attemptsById = [NSMutableDictionary dictionary];
  NSMutableSet *turnIds = [NSMutableSet set];
  NSMutableSet *referencedAttempts = [NSMutableSet set];
  NSMutableDictionary *messageIndexes = [NSMutableDictionary dictionary];
  NSUInteger attemptMessageReferences = 0;
  NSUInteger turnAttemptReferences = 0;
  for (NSUInteger index = 0; index < [(NSArray *)conversation[@"messages"] count];
       index += 1) {
    messageIndexes[conversation[@"messages"][index][@"id"]] = @(index);
  }
  NSArray *turns = projectContextShape ? conversation[@"turns"] : @[];
  NSArray *attempts = projectContextShape ? conversation[@"attempts"] : @[];
  if (projectContextShape &&
      (!DSHSessionTrustedArray(conversation[@"turns"]) ||
       [(NSArray *)conversation[@"turns"] count] > DSHSessionSnapshotMaximumTurns ||
       !DSHSessionTrustedArray(conversation[@"attempts"]) ||
       [(NSArray *)conversation[@"attempts"] count] > DSHSessionSnapshotMaximumAttempts)) return NO;
  for (NSDictionary *turn in turns) {
    if (!DSHSessionValidateTurn(turn) || [turnIds containsObject:turn[@"turn_id"]]) return NO;
    [turnIds addObject:turn[@"turn_id"]];
    NSDictionary *userMessage = messagesById[turn[@"user_message_id"]];
    if (userMessage == nil || ![userMessage[@"role"] isEqual:@"user"] ||
        ![userMessage[@"created_at"] isEqual:turn[@"created_at"]]) return NO;
  }
  NSUInteger previousUserIndex = 0;
  BOOL havePreviousUser = NO;
  for (NSDictionary *turn in turns) {
    NSUInteger userIndex = [messageIndexes[turn[@"user_message_id"]] unsignedIntegerValue];
    if (havePreviousUser && userIndex <= previousUserIndex) return NO;
    previousUserIndex = userIndex;
    havePreviousUser = YES;
  }
  for (NSDictionary *attempt in attempts) {
    if (!DSHSessionValidateAttempt(attempt, schemaVersion) ||
        attemptsById[attempt[@"attempt_id"]] != nil ||
        ![turnIds containsObject:attempt[@"turn_id"]]) return NO;
    attemptMessageReferences += [(NSArray *)attempt[@"visible_message_ids"] count];
    if (attemptMessageReferences > 1000000U) return NO;
    for (NSString *messageId in attempt[@"visible_message_ids"]) {
      if (messagesById[messageId] == nil) return NO;
    }
    NSDictionary *attemptTurn = nil;
    for (NSDictionary *turn in turns) {
      if ([turn[@"attempt_ids"] containsObject:attempt[@"attempt_id"]]) {
        attemptTurn = turn;
        break;
      }
    }
    if (attemptTurn == nil) return NO;
    NSUInteger userIndex = [messageIndexes[attemptTurn[@"user_message_id"]]
        unsignedIntegerValue];
    NSUInteger expectedStart = userIndex + 1 > DSHSessionSnapshotMaximumVisibleMessages
        ? userIndex + 1 - DSHSessionSnapshotMaximumVisibleMessages
        : 0;
    NSUInteger expectedLength = userIndex + 1 - expectedStart;
    if ([(NSArray *)attempt[@"visible_message_ids"] count] != expectedLength) return NO;
    for (NSUInteger index = 0; index < expectedLength; index += 1) {
      NSString *expectedId = conversation[@"messages"][expectedStart + index][@"id"];
      if (![expectedId isEqual:attempt[@"visible_message_ids"][index]]) return NO;
    }
    NSMutableArray *expectedAttachmentIds = [NSMutableArray array];
    NSMutableSet *seenAttachmentIds = [NSMutableSet set];
    NSUInteger attachmentOccurrences = 0;
    NSUInteger attachmentBytes = 0;
    for (NSString *messageId in attempt[@"visible_message_ids"]) {
      NSDictionary *message = messagesById[messageId];
      for (NSDictionary *attachment in message[@"attachments"]) {
        attachmentOccurrences += 1;
        attachmentBytes += [attachment[@"size"] unsignedIntegerValue];
        if (![seenAttachmentIds containsObject:attachment[@"id"]]) {
          [seenAttachmentIds addObject:attachment[@"id"]];
          [expectedAttachmentIds addObject:attachment[@"id"]];
        }
      }
    }
    if (attachmentOccurrences > DSHSessionSnapshotMaximumVisibleAttachments ||
        attachmentBytes > DSHSessionSnapshotMaximumAttachmentBytes ||
        ![attempt[@"attachment_ids"] isEqual:expectedAttachmentIds]) return NO;
    for (NSUInteger roundIndex = 0;
         roundIndex < [(NSArray *)attempt[@"rounds"] count];
         roundIndex += 1) {
      NSDictionary *round = attempt[@"rounds"][roundIndex];
      if (![round[@"turn_id"] isEqual:attempt[@"turn_id"]] ||
          ![round[@"attempt_id"] isEqual:attempt[@"attempt_id"]] ||
          [round[@"round_index"] unsignedIntegerValue] != roundIndex ||
          ![round[@"requested_model"] isEqual:attempt[@"model_id"]] ||
          ![round[@"model"] isEqual:attempt[@"model_id"]] ||
          ![round[@"thinking_mode"] isEqual:attempt[@"thinking_mode"]] ||
          ![round[@"visible_history_sha256"]
              isEqual:attempt[@"visible_history_sha256"]]) return NO;
      if (roundIndex + 1 < [(NSArray *)attempt[@"rounds"] count] &&
          ![round[@"finish_reason"] isEqual:@"tool_calls"]) return NO;
      NSDictionary *attemptContext = attempt[@"project_context"] == NSNull.null
          ? nil : attempt[@"project_context"];
      BOOL hasContext = attemptContext != nil;
      if ((hasContext &&
           (![round[@"transport_schema_version"] isEqual:@3] ||
            round[@"project_context_receipt"] == NSNull.null)) ||
          (!hasContext &&
           (![round[@"transport_schema_version"] isEqual:@2] ||
            round[@"project_context_receipt"] != NSNull.null))) {
        return NO;
      }
      if (hasContext) {
        NSDictionary *projectReceipt = round[@"project_context_receipt"];
        if (![projectReceipt[@"snapshot_id"] isEqual:attemptContext[@"snapshot_id"]] ||
            ![projectReceipt[@"snapshot_sha256"] isEqual:attemptContext[@"snapshot_sha256"]] ||
            ![projectReceipt[@"source_fingerprint"] isEqual:attemptContext[@"source_fingerprint"]] ||
            ![projectReceipt[@"context_bytes"] isEqual:attemptContext[@"context_bytes"]]) {
          return NO;
        }
      }
    }
    attemptsById[attempt[@"attempt_id"]] = attempt;
  }
  NSDictionary *conversationBinding = workspaceRouting &&
          conversation[@"workspace_binding"] != NSNull.null
      ? conversation[@"workspace_binding"] : nil;
  for (NSDictionary *attempt in attempts) {
    BOOL hasWorkspace = attempt[@"workspace_id"] != NSNull.null;
    BOOL hasRevision = attempt[@"workspace_binding_revision"] != NSNull.null;
    if (workspaceRouting) {
      if (hasWorkspace != hasRevision) return NO;
      if (hasWorkspace &&
          (conversationBinding == nil ||
           ![attempt[@"workspace_id"] isEqual:conversationBinding[@"workspace_id"]] ||
           ![attempt[@"workspace_binding_revision"]
               isEqual:conversationBinding[@"binding_revision"]])) {
        return NO;
      }
      if (([attempt[@"status"] isEqual:@"prepared"] ||
           [attempt[@"status"] isEqual:@"sending"]) &&
          [conversation[@"workspace_bootstrap_state"] isEqual:@"none"] &&
          projectId != nil &&
          (conversationBinding == nil || !hasWorkspace ||
           ![attempt[@"context_project_id"] isEqual:conversationBinding[@"project_id"]])) {
        return NO;
      }
    }
    if (attempt[@"project_context"] != NSNull.null &&
        ![attempt[@"project_context"][@"runtime_context_id"]
            isEqual:conversation[@"runtime_context_id"]]) {
      return NO;
    }
    if (attempt[@"project_context"] != NSNull.null &&
        (projectId == nil ||
         ![attempt[@"project_context"][@"project_id"] isEqual:projectId])) {
      return NO;
    }
    if (([attempt[@"status"] isEqual:@"prepared"] ||
         [attempt[@"status"] isEqual:@"sending"]) &&
        ![attempt[@"context_project_id"] isEqual:(projectId ?: NSNull.null)]) {
      return NO;
    }
  }
  NSMutableSet *assistantAttemptReferences = [NSMutableSet set];
  for (NSDictionary *turn in turns) {
    NSString *knownVisibleHistory = nil;
    NSUInteger completedAttempts = 0;
    NSArray *turnAttemptIds = turn[@"attempt_ids"];
    for (NSUInteger attemptIndex = 0;
         attemptIndex < turnAttemptIds.count;
         attemptIndex += 1) {
      NSString *attemptId = turnAttemptIds[attemptIndex];
      turnAttemptReferences += 1;
      if (turnAttemptReferences > DSHSessionSnapshotMaximumAttempts) return NO;
      NSDictionary *attempt = attemptsById[attemptId];
      if (attempt == nil || ![attempt[@"turn_id"] isEqual:turn[@"turn_id"]] ||
          [referencedAttempts containsObject:attemptId]) return NO;
      [referencedAttempts addObject:attemptId];
      if (attemptIndex == 0 &&
          ![attempt[@"created_at"] isEqual:turn[@"created_at"]]) return NO;
      if (attemptIndex + 1 < turnAttemptIds.count &&
          ![attempt[@"status"] isEqual:@"failed"] &&
          ![attempt[@"status"] isEqual:@"cancelled"]) return NO;
      if (attemptIndex > 0) {
        NSDictionary *firstAttempt = attemptsById[turnAttemptIds.firstObject];
        if (firstAttempt == nil ||
            !DSHSessionFrozenAttemptEqual(firstAttempt, attempt)) return NO;
      }
      NSString *visibleHistory = attempt[@"visible_history_sha256"] == NSNull.null
          ? nil : attempt[@"visible_history_sha256"];
      if (visibleHistory == nil) {
        if (knownVisibleHistory != nil) return NO;
      } else if (knownVisibleHistory == nil) {
        knownVisibleHistory = visibleHistory;
      } else if (![knownVisibleHistory isEqual:visibleHistory]) {
        return NO;
      }
      if ([(NSArray *)attempt[@"rounds"] count] == 0 && visibleHistory != nil) {
        BOOL provenance = NO;
        for (NSUInteger priorIndex = 0; priorIndex < attemptIndex;
             priorIndex += 1) {
          NSDictionary *prior = attemptsById[turnAttemptIds[priorIndex]];
          if (prior != nil && [(NSArray *)prior[@"rounds"] count] > 0 &&
              [prior[@"visible_history_sha256"] isEqual:visibleHistory] &&
              DSHSessionFrozenAttemptEqual(prior, attempt)) {
            provenance = YES;
            break;
          }
        }
        if (!provenance) return NO;
      }
      if ([attempt[@"status"] isEqual:@"completed"]) {
        completedAttempts += 1;
        NSString *assistantId = attempt[@"assistant_message_id"] == NSNull.null
            ? nil : attempt[@"assistant_message_id"];
        if (completedAttempts > 1 || assistantId == nil ||
            [assistantAttemptReferences containsObject:assistantId]) return NO;
        [assistantAttemptReferences addObject:assistantId];
      }
    }
  }
  if (referencedAttempts.count != attemptsById.count) return NO;
  NSUInteger liveAttempts = 0;
  for (NSDictionary *attempt in attempts) {
    if ([attempt[@"status"] isEqual:@"prepared"] ||
        [attempt[@"status"] isEqual:@"sending"]) liveAttempts += 1;
    if (liveAttempts > 1) return NO;
    if (attempt[@"assistant_message_id"] != NSNull.null) {
      NSDictionary *assistant = messagesById[attempt[@"assistant_message_id"]];
      if (assistant == nil || ![assistant[@"role"] isEqual:@"assistant"]) return NO;
      NSDictionary *attemptTurn = nil;
      for (NSDictionary *turn in turns) {
        if ([turn[@"attempt_ids"] containsObject:attempt[@"attempt_id"]]) {
          attemptTurn = turn;
          break;
        }
      }
      NSNumber *userIndexValue = attemptTurn == nil
          ? nil : messageIndexes[attemptTurn[@"user_message_id"]];
      NSNumber *assistantIndexValue = messageIndexes[attempt[@"assistant_message_id"]];
      NSUInteger userIndex = userIndexValue == nil
          ? NSNotFound : userIndexValue.unsignedIntegerValue;
      NSUInteger assistantIndex = assistantIndexValue == nil
          ? NSNotFound : assistantIndexValue.unsignedIntegerValue;
      if (attemptTurn == nil || userIndex == NSNotFound ||
          assistantIndex == NSNotFound || assistantIndex <= userIndex ||
          [assistant[@"created_at"] compare:attempt[@"created_at"]] == NSOrderedAscending) {
        return NO;
      }
      NSDictionary *lastRound = [(NSArray *)attempt[@"rounds"] lastObject];
      NSDictionary *metadata = assistant[@"metadata"];
      if (lastRound == nil || metadata == nil ||
          ![metadata[@"model_id"] isEqual:lastRound[@"model"]] ||
          ![metadata[@"latency_ms"] isEqual:lastRound[@"latency_ms"]] ||
          ![metadata[@"finish_reason"] isEqual:lastRound[@"finish_reason"]]) return NO;
    }
    if ([attempt[@"status"] isEqual:@"completed"] &&
        ([(NSArray *)attempt[@"rounds"] count] == 0 ||
         [[(NSArray *)attempt[@"rounds"] lastObject][@"finish_reason"]
             isEqual:@"tool_calls"])) return NO;
  }
  if (agentSchema) {
    if (!DSHSessionTrustedArray(conversation[@"agent_grants"]) ||
        [(NSArray *)conversation[@"agent_grants"] count] > 2) return NO;
    NSMutableSet *grantIds = [NSMutableSet set];
    for (NSDictionary *grant in conversation[@"agent_grants"]) {
      if (!DSHSessionValidateAgentGrant(grant) ||
          [grantIds containsObject:grant[@"grant_id"]] ||
          ![grant[@"conversation_id"] isEqual:conversation[@"id"]]) return NO;
      if (grant[@"project_id"] != NSNull.null &&
          (projectId == nil || ![grant[@"project_id"] isEqual:projectId])) return NO;
      id binding = conversation[@"workspace_binding"];
      if (binding == NSNull.null ||
          ![grant[@"workspace_id"] isEqual:binding[@"workspace_id"]] ||
          ![grant[@"binding_revision"] isEqual:binding[@"binding_revision"]] ||
          ![grant[@"project_id"] isEqual:(projectId ?: NSNull.null)]) return NO;
      NSDictionary *issued = grant[@"issued_for"];
      NSDictionary *attempt = attemptsById[issued[@"attempt_id"]];
      if (attempt == nil || ![attempt[@"turn_id"] isEqual:issued[@"task_id"]]) return NO;
      [grantIds addObject:grant[@"grant_id"]];
    }
    for (NSDictionary *attempt in attempts) {
      NSDictionary *journal = attempt[@"agent"] == NSNull.null ? nil : attempt[@"agent"];
      if (journal == nil) continue;
      id binding = conversation[@"workspace_binding"];
      if (binding == NSNull.null ||
          ![journal[@"root"][@"workspace_id"] isEqual:binding[@"workspace_id"]] ||
          ![journal[@"root"][@"workspace_binding_revision"] isEqual:binding[@"binding_revision"]] ||
          ![journal[@"root"][@"project_id"] isEqual:(projectId ?: NSNull.null)] ||
          [journal[@"round_index"] unsignedIntegerValue] >
              [(NSArray *)attempt[@"rounds"] count]) return NO;
      NSDictionary *lineage = journal[@"round_lineage"] == NSNull.null
          ? nil : journal[@"round_lineage"];
      NSDictionary *activeRound = attempt[@"active_round"] == NSNull.null
          ? nil : attempt[@"active_round"];
      if ([journal[@"phase"] isEqual:@"round_in_flight"] &&
          (activeRound == nil || lineage == nil ||
           ![activeRound[@"round_id"] isEqual:lineage[@"round_id"]] ||
           ![activeRound[@"round_index"] isEqual:lineage[@"round_index"]])) return NO;
      if (![journal[@"phase"] isEqual:@"round_in_flight"] && activeRound != nil) {
        return NO;
      }
      for (NSString *grantId in journal[@"frozen_grant_ids"]) {
        NSDictionary *grant = nil;
        for (NSDictionary *candidate in conversation[@"agent_grants"]) {
          if ([candidate[@"grant_id"] isEqual:grantId]) {
            grant = candidate;
            break;
          }
        }
        if (grant == nil ||
            ![grant[@"workspace_id"] isEqual:journal[@"root"][@"workspace_id"]] ||
            ![grant[@"binding_revision"] isEqual:journal[@"root"][@"workspace_binding_revision"]] ||
            ![grant[@"project_id"] isEqual:journal[@"root"][@"project_id"]] ||
            ![grant[@"registry_version"] isEqual:journal[@"tool_registry_version"]] ||
            ![grant[@"policy_version"] isEqual:journal[@"policy"][@"policy_version"]]) return NO;
        NSString *requiredCapability = [grant[@"tool_family"] isEqual:@"file_write"]
            ? @"file_write" : @"git_commit";
        if (![journal[@"root"][@"capabilities"] containsObject:requiredCapability]) return NO;
      }
    }
  }
  if (messagesByIdOut != nullptr) *messagesByIdOut = messagesById;
  if (attemptsByIdOut != nullptr) *attemptsByIdOut = attemptsById;
  return YES;
}

static BOOL DSHSessionValidateEventCorrelations(
    NSArray<NSDictionary *> *events,
    NSDictionary<NSString *, NSDictionary *> *attemptsById) {
  NSMutableDictionary<NSString *, NSDictionary *> *eventCalls =
      [NSMutableDictionary dictionary];
  for (NSDictionary *event in events) {
    NSString *attemptId = event[@"attempt_id"];
    NSDictionary *attempt = attemptsById[attemptId];
    if (attempt == nil) return NO;
    NSDictionary *journal = attempt[@"agent"] == NSNull.null
        ? nil : attempt[@"agent"];
    NSDictionary *journalCall = nil;
    if (journal != nil && event[@"call_id"] != NSNull.null) {
      for (NSDictionary *call in journal[@"batch"]) {
        if ([call[@"call_id"] isEqual:event[@"call_id"]]) {
          journalCall = call;
          break;
        }
      }
    }
    NSString *eventCallKey = event[@"call_id"] == NSNull.null
        ? nil : [NSString stringWithFormat:@"%@\0%@", attemptId,
                                          event[@"call_id"]];
    NSDictionary *previous = eventCallKey == nil
        ? nil : eventCalls[eventCallKey];
    NSNumber *roundIndex = event[@"round_index"] == NSNull.null
        ? nil : event[@"round_index"];
    NSUInteger roundCount = [(NSArray *)attempt[@"rounds"] count];
    NSNumber *journalRoundIndex = journal == nil ? nil : journal[@"round_index"];
    if (roundIndex != nil && roundIndex.unsignedIntegerValue >= roundCount &&
        (journalRoundIndex == nil ||
         roundIndex.unsignedIntegerValue != journalRoundIndex.unsignedIntegerValue)) {
      return NO;
    }
    NSString *kind = event[@"kind"];
    if ([kind isEqual:@"cancel"]) {
      if (journal == nil) return NO;
      if (roundIndex == nil) {
        if (event[@"call_id"] != NSNull.null ||
            event[@"arguments_sha256"] != NSNull.null) return NO;
        continue;
      }
      if (event[@"call_id"] == NSNull.null) {
        if (event[@"arguments_sha256"] != NSNull.null) return NO;
        continue;
      }
      if (journalCall == nil || journalRoundIndex == nil ||
          roundIndex.unsignedIntegerValue !=
              journalRoundIndex.unsignedIntegerValue ||
          ![event[@"arguments_sha256"]
              isEqual:journalCall[@"arguments_sha256"]]) return NO;
      continue;
    }
    if ([kind isEqual:@"round"] || [kind isEqual:@"terminal"]) {
      if (event[@"call_id"] != NSNull.null ||
          event[@"arguments_sha256"] != NSNull.null ||
          event[@"result_sha256"] != NSNull.null ||
          event[@"approval_reference"] != NSNull.null ||
          event[@"safe_summary_key"] != NSNull.null) return NO;
      continue;
    }
    if (event[@"call_id"] == NSNull.null) return NO;
    if (journalCall == nil && previous == nil) return NO;
    if (journalCall != nil && journalRoundIndex != nil &&
        (roundIndex == nil ||
         roundIndex.unsignedIntegerValue != journalRoundIndex.unsignedIntegerValue)) {
      return NO;
    }
    if (previous != nil &&
        ![previous[@"round_index"] isEqual:event[@"round_index"]]) return NO;
    id knownArguments = journalCall != nil
        ? journalCall[@"arguments_sha256"] : previous[@"arguments_sha256"];
    id knownSummary = journalCall != nil
        ? journalCall[@"safe_summary_key"] : previous[@"safe_summary_key"];
    id knownApproval = journalCall != nil
        ? journalCall[@"approval_reference"] : previous[@"approval_reference"];
    if (event[@"arguments_sha256"] != NSNull.null && knownArguments != nil &&
        ![event[@"arguments_sha256"] isEqual:knownArguments]) return NO;
    if (event[@"safe_summary_key"] != NSNull.null && knownSummary != nil &&
        ![event[@"safe_summary_key"] isEqual:knownSummary]) return NO;
    if (journalCall != nil && ![kind isEqual:@"tool_call"] &&
        ![event[@"approval_reference"] isEqual:knownApproval]) return NO;
    if ([kind isEqual:@"tool_call"]) {
      if (event[@"arguments_sha256"] == NSNull.null ||
          event[@"safe_summary_key"] == NSNull.null ||
          event[@"result_sha256"] != NSNull.null ||
          event[@"approval_reference"] != NSNull.null ||
          (![event[@"status"] isEqual:@"waiting"] &&
           ![event[@"status"] isEqual:@"approval"] &&
           ![event[@"status"] isEqual:@"running"])) return NO;
      eventCalls[eventCallKey] = @{
        @"attempt_id" : attemptId,
        @"round_index" : event[@"round_index"],
        @"safe_summary_key" : event[@"safe_summary_key"],
        @"arguments_sha256" : event[@"arguments_sha256"],
        @"approval_reference" : NSNull.null,
      };
      continue;
    }
    if ([kind isEqual:@"approval"]) {
      if (event[@"arguments_sha256"] == NSNull.null ||
          event[@"safe_summary_key"] == NSNull.null ||
          ![event[@"status"] isEqual:@"approval"]) return NO;
      NSMutableDictionary *row = previous != nil
          ? [previous mutableCopy] : [NSMutableDictionary dictionaryWithDictionary:@{
              @"attempt_id" : attemptId,
              @"round_index" : event[@"round_index"],
            }];
      row[@"safe_summary_key"] = event[@"safe_summary_key"];
      row[@"arguments_sha256"] = event[@"arguments_sha256"];
      row[@"approval_reference"] = event[@"approval_reference"];
      eventCalls[eventCallKey] = [row copy];
      continue;
    }
    if (![kind isEqual:@"tool_result"] ||
        event[@"arguments_sha256"] == NSNull.null ||
        event[@"result_sha256"] == NSNull.null ||
        (![event[@"status"] isEqual:@"ok"] &&
         ![event[@"status"] isEqual:@"failed"] &&
         ![event[@"status"] isEqual:@"denied"] &&
         ![event[@"status"] isEqual:@"cancelled"] &&
         ![event[@"status"] isEqual:@"unknown"] &&
         ![event[@"status"] isEqual:@"ambiguous"])) return NO;
    NSDictionary *receipt = journalCall == nil ||
            journalCall[@"receipt"] == NSNull.null
        ? nil : journalCall[@"receipt"];
    if (journalCall != nil && receipt == nil) return NO;
    if (receipt != nil) {
      if (![event[@"status"] isEqual:receipt[@"outcome"]] ||
          ![event[@"result_sha256"] isEqual:receipt[@"result_sha256"]] ||
          ![event[@"arguments_sha256"] isEqual:receipt[@"arguments_sha256"]] ||
          ![event[@"approval_reference"] isEqual:receipt[@"approval_reference"]] ||
          ![event[@"failure_code"] isEqual:receipt[@"failure_code"]]) return NO;
    }
    if (receipt == nil && previous != nil &&
        previous[@"result_sha256"] != nil &&
        (![previous[@"result_sha256"] isEqual:event[@"result_sha256"]] ||
         ![previous[@"receipt_status"] isEqual:event[@"status"]] ||
         ![previous[@"failure_code"] isEqual:event[@"failure_code"]])) return NO;
    NSMutableDictionary *row = previous != nil
        ? [previous mutableCopy] : [NSMutableDictionary dictionaryWithDictionary:@{
            @"attempt_id" : attemptId,
            @"round_index" : event[@"round_index"],
          }];
    row[@"arguments_sha256"] = event[@"arguments_sha256"];
    row[@"result_sha256"] = event[@"result_sha256"];
    row[@"approval_reference"] = event[@"approval_reference"];
    row[@"failure_code"] = event[@"failure_code"];
    row[@"receipt_status"] = event[@"status"];
    eventCalls[eventCallKey] = [row copy];
  }
  return YES;
}

static BOOL DSHSessionValidateWorkspaceOutboxEntry(NSDictionary *entry) {
  return DSHSessionExactKeys(entry, @[
           @"schema_version", @"operation_id", @"action", @"workspace_id",
           @"binding_revision", @"clearance_receipt_id", @"created_at",
         ]) &&
      DSHSessionExactSchema(entry[@"schema_version"], 1) &&
      DSHSessionCanonicalUUID(entry[@"operation_id"]) &&
      [@[@"forget", @"delete_owned"] containsObject:entry[@"action"]] &&
      DSHSessionCanonicalUUID(entry[@"workspace_id"]) &&
      DSHSessionSafeInteger(entry[@"binding_revision"], NO) &&
      [entry[@"binding_revision"] unsignedIntegerValue] <
          DSHSessionSnapshotMaximumSafeInteger &&
      DSHSessionCanonicalUUID(entry[@"clearance_receipt_id"]) &&
      DSHSessionCanonicalTimestamp(entry[@"created_at"]);
}

static BOOL DSHSessionValidateDestructiveTransition(NSDictionary *transition) {
  if (!DSHSessionExactKeys(transition, @[
        @"schema_version", @"lifecycle_id", @"epoch", @"action", @"phase",
        @"conversation_id", @"source_project_id", @"source_runtime_context_id",
        @"source_model_id", @"snapshot_id", @"snapshot_sha256",
        @"consent_receipt_id", @"target_project_id", @"created_at", @"updated_at",
      ]) ||
      !DSHSessionExactSchema(transition[@"schema_version"], 1) ||
      !DSHSessionCanonicalUUID(transition[@"lifecycle_id"]) ||
      !DSHSessionSafeInteger(transition[@"epoch"], NO) ||
      ![@[@"unbind", @"delete", @"rebind"] containsObject:transition[@"action"]] ||
      ![@[@"intent", @"cleanup_pending", @"ready_to_finalize"]
          containsObject:transition[@"phase"]] ||
      !DSHSessionValidIdentifier(transition[@"conversation_id"],
                                 DSHSessionSnapshotMaximumIdBytes) ||
      !DSHSessionValidIdentifier(transition[@"source_project_id"],
                                 DSHSessionSnapshotMaximumIdBytes) ||
      !(transition[@"source_runtime_context_id"] == NSNull.null ||
        DSHSessionCanonicalUUID(transition[@"source_runtime_context_id"])) ||
      !DSHSessionValidModel(transition[@"source_model_id"]) ||
      !DSHSessionCanonicalUUID(transition[@"snapshot_id"]) ||
      !DSHSessionCanonicalDigest(transition[@"snapshot_sha256"]) ||
      !(transition[@"consent_receipt_id"] == NSNull.null ||
        DSHSessionCanonicalUUID(transition[@"consent_receipt_id"])) ||
      !(transition[@"target_project_id"] == NSNull.null ||
        DSHSessionValidIdentifier(transition[@"target_project_id"],
                                  DSHSessionSnapshotMaximumIdBytes)) ||
      !DSHSessionCanonicalTimestamp(transition[@"created_at"]) ||
      !DSHSessionCanonicalTimestamp(transition[@"updated_at"]) ||
      [transition[@"created_at"] compare:transition[@"updated_at"]] ==
          NSOrderedDescending) {
    return NO;
  }
  BOOL rebind = [transition[@"action"] isEqual:@"rebind"];
  BOOL hasTarget = transition[@"target_project_id"] != NSNull.null;
  return rebind == hasTarget &&
      (!rebind || ![transition[@"target_project_id"]
          isEqual:transition[@"source_project_id"]]);
}

static BOOL DSHSessionTransitionHasReferences(NSDictionary *conversation,
                                              NSDictionary *transition) {
  NSArray *messages = conversation[@"messages"];
  NSUInteger visibleStart = messages.count > DSHSessionSnapshotMaximumVisibleMessages
      ? messages.count - DSHSessionSnapshotMaximumVisibleMessages : 0;
  NSArray *visibleWindow = messages.count == 0
      ? @[] : [messages subarrayWithRange:NSMakeRange(visibleStart,
                                                       messages.count - visibleStart)];
  for (NSDictionary *attempt in conversation[@"attempts"]) {
    NSString *disposition = attempt[@"context_disposition"];
    NSDictionary *attemptContext = attempt[@"project_context"] == NSNull.null
        ? nil : attempt[@"project_context"];
    if ([disposition isEqual:@"unbound"]) {
      if (attemptContext != nil || attempt[@"context_project_id"] != NSNull.null) {
        return YES;
      }
      continue;
    }
    if ([disposition isEqual:@"explicit_without_context"]) {
      if (attemptContext != nil || attempt[@"context_project_id"] == NSNull.null ||
          ![attempt[@"context_project_id"] isEqual:conversation[@"project_id"]]) {
        return YES;
      }
      continue;
    }
    if (![disposition isEqual:@"verified"] || attemptContext == nil) return YES;
    if (![attemptContext[@"snapshot_id"] isEqual:transition[@"snapshot_id"]]) {
      continue;
    }
    NSString *status = attempt[@"status"];
    if ([status isEqual:@"prepared"] || [status isEqual:@"sending"]) return YES;
    if (([status isEqual:@"failed"] || [status isEqual:@"cancelled"]) &&
        ![attempt[@"visible_message_ids"] isEqual:visibleWindow]) return YES;
  }
  return NO;
}

static BOOL DSHSessionValidateSchema9Root(NSDictionary *session) {
  NSArray *keys = @[
    @"schema_version", @"workspace_authority_outbox",
    @"agent_transcript_cleanup_outbox", @"project_context_destructive_epoch",
    @"project_context_destructive_transition", @"active_conversation_id",
    @"conversations", @"messages", @"session_events", @"preferences",
  ];
  if (!DSHSessionExactKeys(session, keys) ||
      !DSHSessionExactSchema(session[@"schema_version"], 9) ||
      !DSHSessionTrustedArray(session[@"workspace_authority_outbox"]) ||
      [(NSArray *)session[@"workspace_authority_outbox"] count] >
          DSHSessionSnapshotMaximumOutbox ||
      !DSHSessionTrustedArray(session[@"agent_transcript_cleanup_outbox"]) ||
      [(NSArray *)session[@"agent_transcript_cleanup_outbox"] count] >
          DSHSessionSnapshotMaximumCleanup ||
      !DSHSessionSafeInteger(session[@"project_context_destructive_epoch"], YES) ||
      !(session[@"project_context_destructive_transition"] == NSNull.null ||
        DSHSessionTrustedDictionary(session[@"project_context_destructive_transition"])) ||
      !DSHSessionStringOrNull(session[@"active_conversation_id"]) ||
      !DSHSessionTrustedArray(session[@"conversations"]) ||
      [(NSArray *)session[@"conversations"] count] > 10000 ||
      !DSHSessionTrustedArray(session[@"messages"]) ||
      !DSHSessionTrustedArray(session[@"session_events"]) ||
      [(NSArray *)session[@"session_events"] count] >
          DSHSessionSnapshotMaximumEvents ||
      !DSHSessionValidatePreferences(session[@"preferences"])) {
    return NO;
  }
  if (session[@"active_conversation_id"] != NSNull.null &&
      !DSHSessionBoundedText(session[@"active_conversation_id"], 256, NO)) {
    return NO;
  }
  NSMutableSet *workspaceOperationIds = [NSMutableSet set];
  for (NSDictionary *item in session[@"workspace_authority_outbox"]) {
    if (!DSHSessionValidateWorkspaceOutboxEntry(item) ||
        [workspaceOperationIds containsObject:item[@"operation_id"]]) return NO;
    [workspaceOperationIds addObject:item[@"operation_id"]];
  }
  NSMutableDictionary *conversations = [NSMutableDictionary dictionary];
  NSMutableSet *conversationIds = [NSMutableSet set];
  NSMutableDictionary *attempts = [NSMutableDictionary dictionary];
  for (NSDictionary *item in session[@"conversations"]) {
    NSMutableDictionary *messages = nil;
    NSMutableDictionary *conversationAttempts = nil;
    if (!DSHSessionValidateConversation(item, 9, &messages,
                                        &conversationAttempts) ||
        [conversationIds containsObject:item[@"id"]]) return NO;
    [conversationIds addObject:item[@"id"]];
    conversations[item[@"id"]] = item;
    for (NSString *attemptId in conversationAttempts) {
      if (attempts[attemptId] != nil) return NO;
      attempts[attemptId] = conversationAttempts[attemptId];
    }
  }
  for (NSDictionary *entry in session[@"workspace_authority_outbox"]) {
    NSString *workspaceId = entry[@"workspace_id"];
    for (NSDictionary *conversation in session[@"conversations"]) {
      if (conversation[@"workspace_id"] != NSNull.null &&
          [conversation[@"workspace_id"] isEqual:workspaceId]) {
        return NO;
      }
      NSDictionary *binding = conversation[@"workspace_binding"] == NSNull.null
          ? nil : conversation[@"workspace_binding"];
      if (binding != nil && [binding[@"workspace_id"] isEqual:workspaceId]) {
        return NO;
      }
      for (NSDictionary *attempt in conversation[@"attempts"]) {
        if (attempt[@"workspace_id"] != NSNull.null &&
            [attempt[@"workspace_id"] isEqual:workspaceId]) {
          return NO;
        }
      }
    }
  }
  NSMutableDictionary *rootMessages = nil;
  if (!DSHSessionValidateMessages(session[@"messages"], 9, &rootMessages)) return NO;
  id activeId = session[@"active_conversation_id"];
  NSDictionary *activeConversation = activeId == NSNull.null
      ? nil : conversations[activeId];
  if ((activeId != NSNull.null && activeConversation == nil) ||
      (activeConversation == nil && rootMessages.count != 0) ||
      (activeConversation != nil &&
       ![session[@"messages"] isEqual:activeConversation[@"messages"]])) return NO;

  // Lifecycle and provider identifiers are globally unique across the
  // session, not merely unique inside one conversation.  This mirrors the
  // JS hydration boundary and prevents two durable rows from sharing a
  // journal/receipt identity.
  NSMutableSet *lifecycleIds = [NSMutableSet set];
  NSMutableSet *providerRequestIds = [NSMutableSet set];
  NSMutableSet *providerResponseIds = [NSMutableSet set];
  for (NSDictionary *conversation in session[@"conversations"]) {
    for (NSDictionary *grant in conversation[@"agent_grants"]) {
      NSString *grantId = grant[@"grant_id"];
      if ([lifecycleIds containsObject:grantId]) return NO;
      [lifecycleIds addObject:grantId];
    }
    NSString *runtimeContextId = conversation[@"runtime_context_id"];
    if (![runtimeContextId isEqual:NSNull.null]) {
      if ([lifecycleIds containsObject:runtimeContextId]) return NO;
      [lifecycleIds addObject:runtimeContextId];
    }
    for (NSDictionary *turn in conversation[@"turns"]) {
      NSString *turnId = turn[@"turn_id"];
      if ([lifecycleIds containsObject:turnId]) return NO;
      [lifecycleIds addObject:turnId];
    }
    for (NSDictionary *attempt in conversation[@"attempts"]) {
      NSString *attemptId = attempt[@"attempt_id"];
      if ([lifecycleIds containsObject:attemptId]) return NO;
      [lifecycleIds addObject:attemptId];
      for (NSDictionary *round in attempt[@"rounds"]) {
        NSString *roundId = round[@"round_id"];
        if ([lifecycleIds containsObject:roundId] ||
            [providerRequestIds containsObject:round[@"provider_request_id"]] ||
            [providerResponseIds containsObject:round[@"provider_response_id"]]) {
          return NO;
        }
        [lifecycleIds addObject:roundId];
        [providerRequestIds addObject:round[@"provider_request_id"]];
        [providerResponseIds addObject:round[@"provider_response_id"]];
      }
      NSDictionary *activeRound = attempt[@"active_round"] == NSNull.null
          ? nil : attempt[@"active_round"];
      if (activeRound != nil) {
        NSString *roundId = activeRound[@"round_id"];
        if ([lifecycleIds containsObject:roundId]) return NO;
        [lifecycleIds addObject:roundId];
      }
      NSDictionary *journal = attempt[@"agent"] == NSNull.null
          ? nil : attempt[@"agent"];
      NSDictionary *lineage = journal[@"round_lineage"] == NSNull.null
          ? nil : journal[@"round_lineage"];
      if (lineage != nil) {
        NSString *roundId = lineage[@"round_id"];
        BOOL alreadyRepresented = (activeRound != nil &&
                                    [activeRound[@"round_id"] isEqual:roundId]);
        for (NSDictionary *round in attempt[@"rounds"]) {
          alreadyRepresented |= [round[@"round_id"] isEqual:roundId];
        }
        if (!alreadyRepresented) {
          if ([lifecycleIds containsObject:roundId]) return NO;
          [lifecycleIds addObject:roundId];
        }
      }
      if (journal != nil) {
        NSString *transcriptRef = journal[@"transcript"][@"transcript_ref"];
        if ([lifecycleIds containsObject:transcriptRef]) return NO;
        [lifecycleIds addObject:transcriptRef];
      }
    }
  }
  NSMutableSet *cleanupIds = [NSMutableSet set];
  for (NSDictionary *item in session[@"agent_transcript_cleanup_outbox"]) {
    if (!DSHSessionValidateCleanup(item) ||
        [cleanupIds containsObject:item[@"cleanup_id"]] ||
        [lifecycleIds containsObject:item[@"cleanup_id"]]) return NO;
    NSDictionary *conversation = conversations[item[@"conversation_id"]];
    NSDictionary *attempt = attempts[item[@"attempt_id"]];
    if (conversation == nil) {
      if (![item[@"reason"] isEqual:@"conversation_deleted"]) {
        return NO;
      }
      // Deleted conversations intentionally leave an exact owner row behind
      // until native transcript reconciliation consumes it.  The owner IDs
      // remain in the cleanup entry; no replacement owner is synthesized.
      [cleanupIds addObject:item[@"cleanup_id"]];
      [lifecycleIds addObject:item[@"cleanup_id"]];
      continue;
    }
    if (attempt == nil ||
        ![conversation[@"attempts"] containsObject:attempt] ||
        ![attempt[@"turn_id"] isEqual:item[@"task_id"]] ||
        attempt[@"agent"] == NSNull.null ||
        ![attempt[@"agent"][@"transcript"][@"transcript_ref"]
            isEqual:item[@"transcript_ref"]] ||
        ![attempt[@"agent"][@"transcript"][@"transcript_sha256"]
            isEqual:item[@"transcript_sha256"]]) return NO;
    [cleanupIds addObject:item[@"cleanup_id"]];
    [lifecycleIds addObject:item[@"cleanup_id"]];
  }
  NSMutableDictionary<NSString *, NSNumber *> *lastSeqByAttempt =
      [NSMutableDictionary dictionary];
  NSMutableSet<NSString *> *eventIds = [NSMutableSet set];
  for (NSDictionary *event in session[@"session_events"]) {
    if (!DSHSessionValidateEvent(event)) return NO;
    if ([eventIds containsObject:event[@"event_id"]]) return NO;
    if (attempts[event[@"attempt_id"]] == nil) return NO;
    if ([lifecycleIds containsObject:event[@"event_id"]]) return NO;
    [eventIds addObject:event[@"event_id"]];
    [lifecycleIds addObject:event[@"event_id"]];
    NSString *attemptId = event[@"attempt_id"];
    NSUInteger seq = [event[@"seq"] unsignedIntegerValue];
    NSNumber *previous = lastSeqByAttempt[attemptId];
    if (previous != nil && seq <= previous.unsignedIntegerValue) return NO;
    lastSeqByAttempt[attemptId] = @(seq);
  }
  if (!DSHSessionValidateEventCorrelations(session[@"session_events"], attempts)) {
    return NO;
  }
  NSDictionary *transition = session[@"project_context_destructive_transition"] == NSNull.null
      ? nil : session[@"project_context_destructive_transition"];
  if (transition != nil &&
      (!DSHSessionValidateDestructiveTransition(transition) ||
       ![transition[@"epoch"] isEqual:session[@"project_context_destructive_epoch"]] ||
       conversations[transition[@"conversation_id"]] == nil ||
       [lifecycleIds containsObject:transition[@"lifecycle_id"]])) return NO;
  if (transition != nil) [lifecycleIds addObject:transition[@"lifecycle_id"]];
  if (transition != nil) {
    NSDictionary *conversation = conversations[transition[@"conversation_id"]];
    NSDictionary *context = conversation[@"project_context"] == NSNull.null
        ? nil : conversation[@"project_context"];
    if (![conversation[@"project_id"] isEqual:transition[@"source_project_id"]] ||
        ![conversation[@"runtime_context_id"]
            isEqual:transition[@"source_runtime_context_id"]] ||
        ![conversation[@"model_id"] isEqual:transition[@"source_model_id"]] ||
        context == nil) return NO;
    if ([transition[@"phase"] isEqual:@"intent"]) {
      NSDictionary *manifest = context[@"manifest"] == NSNull.null
          ? nil : context[@"manifest"];
      NSDictionary *consent = context[@"consent"] == NSNull.null
          ? nil : context[@"consent"];
      if (![transition[@"created_at"] isEqual:transition[@"updated_at"]] ||
          context[@"active_preparation_id"] != NSNull.null ||
          [conversation[@"updated_at"] compare:transition[@"created_at"]] ==
              NSOrderedDescending ||
          manifest == nil ||
          ![manifest[@"snapshot_id"] isEqual:transition[@"snapshot_id"]] ||
          ![manifest[@"snapshot_sha256"] isEqual:transition[@"snapshot_sha256"]] ||
          ![consent[@"consent_receipt_id"]
              isEqual:(transition[@"consent_receipt_id"] ?: NSNull.null)] ||
          DSHSessionTransitionHasReferences(conversation, transition)) return NO;
    } else if (![context[@"status"] isEqual:@"setup_required"] ||
               [(NSArray *)context[@"selected_paths"] count] != 0 ||
               context[@"active_preparation_id"] != NSNull.null ||
               context[@"manifest"] != NSNull.null ||
               context[@"consent"] != NSNull.null ||
               context[@"stale_reason"] != NSNull.null ||
               context[@"error_code"] != NSNull.null ||
               DSHSessionTransitionHasReferences(conversation, transition)) {
      return NO;
    }
    if ([transition[@"phase"] isEqual:@"cleanup_pending"] &&
        ![conversation[@"updated_at"] isEqual:transition[@"updated_at"]]) return NO;
    if ([transition[@"phase"] isEqual:@"ready_to_finalize"] &&
        [conversation[@"updated_at"] compare:transition[@"updated_at"]] ==
            NSOrderedDescending) return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateLegacyRoot(NSDictionary *session) {
  NSNumber *schema = session[@"schema_version"];
  if (!DSHSessionTrustedDictionary(session) || !DSHSessionSafeInteger(schema, YES)) {
    return NO;
  }
  NSUInteger version = schema.unsignedIntegerValue;
  if (version < 2 || version > 8) return NO;
  NSArray *base = nil;
  switch (version) {
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
      base = @[@"schema_version", @"active_conversation_id",
               @"conversations", @"messages"];
      break;
    case 7:
      base = @[
        @"schema_version", @"project_context_destructive_epoch",
        @"project_context_destructive_transition", @"active_conversation_id",
        @"conversations", @"messages",
      ];
      break;
    case 8:
      base = @[
        @"schema_version", @"workspace_authority_outbox",
        @"project_context_destructive_epoch",
        @"project_context_destructive_transition", @"active_conversation_id",
        @"conversations", @"messages",
      ];
      break;
  }
  NSMutableArray *allowed = [base mutableCopy];
  [allowed addObject:@"preferences"];
  [allowed addObject:@"session_events"];
  if (session.count < base.count || session.count > allowed.count) return NO;
  NSSet *allowedSet = [NSSet setWithArray:allowed];
  for (id key in session) {
    if (!DSHSessionTrustedString(key) || ![allowedSet containsObject:key]) return NO;
  }
  for (NSString *key in base) {
    if (session[key] == nil) return NO;
  }
  if (!DSHSessionStringOrNull(session[@"active_conversation_id"]) ||
      !DSHSessionTrustedArray(session[@"conversations"]) ||
      !DSHSessionTrustedArray(session[@"messages"])) {
    return NO;
  }
  if (version >= 7 &&
      (!DSHSessionSafeInteger(session[@"project_context_destructive_epoch"], YES) ||
       !(session[@"project_context_destructive_transition"] == NSNull.null ||
         DSHSessionTrustedDictionary(session[@"project_context_destructive_transition"])))) {
    return NO;
  }
  if (version == 8 && !DSHSessionTrustedArray(session[@"workspace_authority_outbox"])) return NO;
  if (session[@"preferences"] != nil &&
      !DSHSessionValidatePreferences(session[@"preferences"])) return NO;
  if (session[@"session_events"] != nil &&
      !DSHSessionTrustedArray(session[@"session_events"])) {
    return NO;
  }
  NSMutableDictionary *rootMessages = nil;
  if (!DSHSessionValidateMessages(session[@"messages"], version, &rootMessages)) return NO;
  NSMutableDictionary *conversations = [NSMutableDictionary dictionary];
  NSMutableSet *conversationIds = [NSMutableSet set];
  for (NSDictionary *conversation in session[@"conversations"]) {
    NSMutableDictionary *messages = nil;
    NSMutableDictionary *attempts = nil;
    if (!DSHSessionValidateConversation(conversation, version, &messages, &attempts) ||
        [conversationIds containsObject:conversation[@"id"]]) return NO;
    [conversationIds addObject:conversation[@"id"]];
    conversations[conversation[@"id"]] = conversation;
  }
  id activeId = session[@"active_conversation_id"];
  NSDictionary *activeConversation = activeId == NSNull.null
      ? nil : conversations[activeId];
  if ((activeId != NSNull.null && activeConversation == nil) ||
      (activeConversation == nil && rootMessages.count != 0) ||
      (activeConversation != nil &&
       ![session[@"messages"] isEqual:activeConversation[@"messages"]])) return NO;
  if (version >= 7 && session[@"project_context_destructive_transition"] != NSNull.null &&
      (!DSHSessionValidateDestructiveTransition(
           session[@"project_context_destructive_transition"]) ||
       ![session[@"project_context_destructive_transition"][@"epoch"]
           isEqual:session[@"project_context_destructive_epoch"]] ||
       conversations[session[@"project_context_destructive_transition"][@"conversation_id"]] == nil)) return NO;
  if (version >= 7 && session[@"project_context_destructive_transition"] != NSNull.null) {
    NSDictionary *transition = session[@"project_context_destructive_transition"];
    NSDictionary *conversation = conversations[transition[@"conversation_id"]];
    NSDictionary *context = conversation[@"project_context"] == NSNull.null
        ? nil : conversation[@"project_context"];
    if (conversation == nil || context == nil ||
        ![conversation[@"project_id"] isEqual:transition[@"source_project_id"]] ||
        ![conversation[@"runtime_context_id"]
            isEqual:transition[@"source_runtime_context_id"]] ||
        ![conversation[@"model_id"] isEqual:transition[@"source_model_id"]]) return NO;
    if ([transition[@"phase"] isEqual:@"intent"]) {
      NSDictionary *manifest = context[@"manifest"] == NSNull.null
          ? nil : context[@"manifest"];
      NSDictionary *consent = context[@"consent"] == NSNull.null
          ? nil : context[@"consent"];
      if (![transition[@"created_at"] isEqual:transition[@"updated_at"]] ||
          context[@"active_preparation_id"] != NSNull.null ||
          [conversation[@"updated_at"] compare:transition[@"created_at"]] ==
              NSOrderedDescending || manifest == nil ||
          ![manifest[@"snapshot_id"] isEqual:transition[@"snapshot_id"]] ||
          ![manifest[@"snapshot_sha256"] isEqual:transition[@"snapshot_sha256"]] ||
          ![consent[@"consent_receipt_id"]
              isEqual:(transition[@"consent_receipt_id"] ?: NSNull.null)] ||
          DSHSessionTransitionHasReferences(conversation, transition)) return NO;
    } else if (![context[@"status"] isEqual:@"setup_required"] ||
               [(NSArray *)context[@"selected_paths"] count] != 0 ||
               context[@"active_preparation_id"] != NSNull.null ||
               context[@"manifest"] != NSNull.null ||
               context[@"consent"] != NSNull.null ||
               context[@"stale_reason"] != NSNull.null ||
               context[@"error_code"] != NSNull.null ||
               DSHSessionTransitionHasReferences(conversation, transition)) {
      return NO;
    }
    if ([transition[@"phase"] isEqual:@"cleanup_pending"] &&
        ![conversation[@"updated_at"] isEqual:transition[@"updated_at"]]) return NO;
    if ([transition[@"phase"] isEqual:@"ready_to_finalize"] &&
        [conversation[@"updated_at"] compare:transition[@"updated_at"]] ==
            NSOrderedDescending) return NO;
  }
  if (version == 8) {
    NSMutableSet *operationIds = [NSMutableSet set];
    for (NSDictionary *entry in session[@"workspace_authority_outbox"]) {
      if (!DSHSessionValidateWorkspaceOutboxEntry(entry) ||
          [operationIds containsObject:entry[@"operation_id"]]) return NO;
      [operationIds addObject:entry[@"operation_id"]];
    }
    for (NSDictionary *entry in session[@"workspace_authority_outbox"]) {
      NSString *workspaceId = entry[@"workspace_id"];
      for (NSDictionary *conversation in session[@"conversations"]) {
        if ((conversation[@"workspace_id"] != NSNull.null &&
             [conversation[@"workspace_id"] isEqual:workspaceId]) ||
            (conversation[@"workspace_binding"] != nil &&
             conversation[@"workspace_binding"] != NSNull.null &&
             [conversation[@"workspace_binding"][@"workspace_id"]
                 isEqual:workspaceId])) {
          return NO;
        }
        for (NSDictionary *attempt in conversation[@"attempts"]) {
          if (attempt[@"workspace_id"] != NSNull.null &&
              [attempt[@"workspace_id"] isEqual:workspaceId]) return NO;
        }
      }
    }
  }
  NSMutableSet *lifecycleIds = [NSMutableSet set];
  NSMutableSet *providerRequestIds = [NSMutableSet set];
  NSMutableSet *providerResponseIds = [NSMutableSet set];
  for (NSDictionary *conversation in session[@"conversations"]) {
    if (conversation[@"runtime_context_id"] != nil &&
        conversation[@"runtime_context_id"] != NSNull.null) {
      NSString *value = conversation[@"runtime_context_id"];
      if ([lifecycleIds containsObject:value]) return NO;
      [lifecycleIds addObject:value];
    }
    for (NSDictionary *turn in conversation[@"turns"]) {
      NSString *value = turn[@"turn_id"];
      if ([lifecycleIds containsObject:value]) return NO;
      [lifecycleIds addObject:value];
    }
    for (NSDictionary *attempt in conversation[@"attempts"]) {
      NSString *attemptId = attempt[@"attempt_id"];
      if ([lifecycleIds containsObject:attemptId]) return NO;
      [lifecycleIds addObject:attemptId];
      for (NSDictionary *round in attempt[@"rounds"]) {
        NSString *roundId = round[@"round_id"];
        if ([lifecycleIds containsObject:roundId] ||
            [providerRequestIds containsObject:round[@"provider_request_id"]] ||
            [providerResponseIds containsObject:round[@"provider_response_id"]]) {
          return NO;
        }
        [lifecycleIds addObject:roundId];
        [providerRequestIds addObject:round[@"provider_request_id"]];
        [providerResponseIds addObject:round[@"provider_response_id"]];
      }
      NSDictionary *activeRound = attempt[@"active_round"] == NSNull.null
          ? nil : attempt[@"active_round"];
      if (activeRound != nil) {
        NSString *roundId = activeRound[@"round_id"];
        if ([lifecycleIds containsObject:roundId]) return NO;
        [lifecycleIds addObject:roundId];
      }
    }
  }
  if (version >= 7 && session[@"project_context_destructive_transition"] != NSNull.null) {
    NSString *lifecycleId = session[@"project_context_destructive_transition"][@"lifecycle_id"];
    if ([lifecycleIds containsObject:lifecycleId]) return NO;
  }
  return YES;
}

static BOOL DSHSessionValidateTombstoneEnvelope(
    NSDictionary *envelope,
    NSUInteger *generationOut,
    NSSet<NSString *> **operationIdsOut) {
  if (!DSHSessionExactKeys(envelope, @[
        @"schema_version", @"generation", @"operation_ids",
      ]) ||
      !DSHSessionExactSchema(envelope[@"schema_version"], 1) ||
      !DSHSessionSafeInteger(envelope[@"generation"], YES) ||
      !DSHSessionTrustedArray(envelope[@"operation_ids"]) ||
      [(NSArray *)envelope[@"operation_ids"] count] >
          DSHSessionSnapshotMaximumTombstones) {
    return NO;
  }
  NSMutableSet<NSString *> *ids = [NSMutableSet set];
  for (id operationId in envelope[@"operation_ids"]) {
    if (!DSHSessionCanonicalOperationId(operationId) ||
        [ids containsObject:operationId]) return NO;
    [ids addObject:operationId];
  }
  if (generationOut != nullptr) {
    *generationOut = [envelope[@"generation"] unsignedIntegerValue];
  }
  if (operationIdsOut != nullptr) *operationIdsOut = [ids copy];
  return YES;
}

static NSDictionary *DSHSessionSnapshotRef(NSUInteger generation,
                                           NSString *digest) {
  return @{
    @"schema_version" : @1,
    @"generation" : @(generation),
    @"session_sha256" : digest,
  };
}

static NSDictionary *DSHSessionLegacyRef(NSString *digest) {
  return @{
    @"schema_version" : @1,
    @"legacy_bytes_sha256" : digest,
  };
}

static NSDictionary *DSHSessionMissingAuthority(void) {
  return @{@"schema_version" : @1, @"kind" : @"missing"};
}

static NSDictionary *DSHSessionLegacyAuthority(NSString *digest) {
  return @{
    @"schema_version" : @1,
    @"kind" : @"legacy_present",
    @"legacy" : DSHSessionLegacyRef(digest),
  };
}

static NSDictionary *DSHSessionPresentAuthority(NSUInteger generation,
                                                NSString *digest) {
  return @{
    @"schema_version" : @1,
    @"kind" : @"present",
    @"snapshot" : DSHSessionSnapshotRef(generation, digest),
  };
}

static NSDictionary *DSHSessionLoadMissingResult(void) {
  return @{
    @"schema_version" : @1,
    @"status" : @"missing",
    @"snapshot" : NSNull.null,
    @"session_json" : NSNull.null,
  };
}

@interface DSHSessionLoadedState : NSObject
@property(nonatomic) BOOL missing;
@property(nonatomic) BOOL legacy;
@property(nonatomic) BOOL hasFile;
@property(nonatomic) dev_t device;
@property(nonatomic) ino_t inode;
@property(nonatomic) off_t fileSize;
@property(nonatomic, strong) NSData *rawBytes;
@property(nonatomic, strong) NSDictionary *session;
@property(nonatomic, strong) NSArray<NSDictionary *> *recentCommits;
@property(nonatomic, copy) NSString *legacyBytesDigest;
@property(nonatomic, copy) NSString *sessionDigest;
@property(nonatomic) NSUInteger generation;
@property(nonatomic, copy) NSDictionary *authority;
@property(nonatomic) BOOL tombstoneAvailable;
@property(nonatomic, strong) NSSet<NSString *> *tombstonedOperationIds;
@property(nonatomic) NSUInteger tombstoneGeneration;
@property(nonatomic) dev_t tombstoneDevice;
@property(nonatomic) ino_t tombstoneInode;
@property(nonatomic) off_t tombstoneFileSize;
@property(nonatomic, strong) NSData *tombstoneRawBytes;
@end

@implementation DSHSessionLoadedState
@end

@interface DSHSessionTombstoneState : NSObject
@property(nonatomic) BOOL missing;
@property(nonatomic) BOOL valid;
@property(nonatomic) dev_t device;
@property(nonatomic) ino_t inode;
@property(nonatomic) off_t fileSize;
@property(nonatomic, strong) NSData *rawBytes;
@property(nonatomic) NSUInteger generation;
@property(nonatomic, strong) NSSet<NSString *> *operationIds;
@end

@implementation DSHSessionTombstoneState
@end

static DSHSessionLoadedState *DSHSessionExpectedStateForTombstones(
    DSHSessionTombstoneState *tombstones) {
  DSHSessionLoadedState *expected = [[DSHSessionLoadedState alloc] init];
  expected.missing = tombstones == nil || tombstones.missing;
  expected.hasFile = !expected.missing;
  if (tombstones != nil) {
    expected.device = tombstones.device;
    expected.inode = tombstones.inode;
    expected.fileSize = tombstones.fileSize;
    expected.rawBytes = tombstones.rawBytes;
  }
  return expected;
}

typedef NS_ENUM(NSInteger, DSHSessionAtomicWriteResult) {
  DSHSessionAtomicWriteCommitted = 0,
  DSHSessionAtomicWriteNoEffect = 1,
  DSHSessionAtomicWriteUnknown = 2,
};

@interface DSHSessionSnapshotStore ()
@property(nonatomic, readwrite, strong) NSURL *sessionURL;
@property(nonatomic, readwrite, strong) NSURL *rootURL;
@property(nonatomic, readwrite, copy) NSString *launchInstanceId;
@property(nonatomic, readwrite, strong) DSHSessionWorkspaceCoordinator *coordinator;
@property(nonatomic, readwrite, strong) DSHWorkspaceClearanceStore *clearanceStore;
@property(nonatomic, strong) DSHLocalWorkspaceAccess *clearanceWorkspaceAccess;
@property(nonatomic, copy) DSHSessionSnapshotStoreFaultHook faultHook;
@property(nonatomic) int rootDescriptor;
@property(nonatomic) dev_t rootDevice;
@property(nonatomic) ino_t rootInode;
@property(nonatomic) int parentDescriptor;
@property(nonatomic) dev_t parentDevice;
@property(nonatomic) ino_t parentInode;
@property(nonatomic, copy) NSString *rootName;
@property(nonatomic, copy) NSString *sessionFilename;
- (BOOL)requiresSessionResourceMetadata;
- (id)sessionProtectionPolicyValue;
- (BOOL)setSessionProtectionValue:(id)value
                            atURL:(NSURL *)url
                            error:(NSError **)error;
- (BOOL)setSessionBackupExcluded:(BOOL)excluded
                           atURL:(NSURL *)url
                           error:(NSError **)error;
- (BOOL)getSessionProtectionAtURL:(NSURL *)url
                            value:(id *)value
                            error:(NSError **)error;
- (BOOL)getSessionBackupExcludedAtURL:(NSURL *)url
                                value:(NSNumber **)value
                                error:(NSError **)error;
- (BOOL)hardenPinnedDescriptor:(int)descriptor
                         atURL:(NSURL *)url
                     directory:(BOOL)directory
                 excludeBackup:(BOOL)excludeBackup
                         error:(NSError **)error;
- (BOOL)validatePinnedDescriptor:(int)descriptor
                           atURL:(NSURL *)url
                       directory:(BOOL)directory
                   excludeBackup:(BOOL)excludeBackup
                 requireMetadata:(BOOL)requireMetadata
                           error:(NSError **)error;
- (NSData *)readStoredBytesForFilename:(NSString *)filename
                               missing:(BOOL *)missing
                                 state:(struct stat *)identity
                                 error:(NSError **)error;
- (BOOL)targetMatchesExpectedState:(DSHSessionLoadedState *)expected
                           filename:(NSString *)filename
                              error:(NSError **)error;
- (BOOL)validateProtectedFileWithIdentity:(const struct stat *)expected
                                  filename:(NSString *)filename
                                     error:(NSError **)error;
- (DSHSessionAtomicWriteResult)writeProtectedData:(NSData *)data
                                          filename:(NSString *)filename
                                     expectedState:(DSHSessionLoadedState *)expected
                                             error:(NSError **)error;
- (DSHSessionAtomicWriteResult)writeProtectedData:(NSData *)data
                                          filename:(NSString *)filename
                                     expectedState:(DSHSessionLoadedState *)expected
                                    lockDescriptor:(int)lockDescriptor
                                             error:(NSError **)error;
- (DSHSessionAtomicWriteResult)writeEnvelopeData:(NSData *)data
                                     expectedState:(DSHSessionLoadedState *)expected
                                    lockDescriptor:(int)lockDescriptor
                                             error:(NSError **)error;
- (DSHSessionAtomicWriteResult)publishTemporaryFilename:(NSString *)temporaryName
                                               filename:(NSString *)filename
                                          expectedState:(DSHSessionLoadedState *)expected
                                                  error:(NSError **)error;
- (DSHSessionTombstoneState *)readTombstoneStateWithError:(NSError **)error;
- (int)acquireCASLock:(NSError **)error;
- (nullable NSDictionary *)casPersistSessionLocked:(NSDictionary *)request
                                    lockDescriptor:(int)lockDescriptor
                                              error:(NSError **)error;
@end

NSString *DSHSessionSnapshotStoreLaunchInstanceId(void) {
  static NSString *value = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    value = NSUUID.UUID.UUIDString.lowercaseString;
  });
  return value;
}

@implementation DSHSessionSnapshotStore

- (nullable instancetype)initWithError:(NSError **)error {
  NSError *supportError = nil;
  NSURL *support = [[NSFileManager defaultManager]
      URLForDirectory:NSApplicationSupportDirectory
             inDomain:NSUserDomainMask
    appropriateForURL:nil
               create:YES
                error:&supportError];
  if (support == nil) {
    if (error != nullptr) *error = DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorStorage);
    return nil;
  }
  return [self initWithRootURL:support
                     sessionURL:[support URLByAppendingPathComponent:
                                           DSHSessionSnapshotFilename]
               launchInstanceId:nil
                     coordinator:nil
                       faultHook:nil];
}

- (instancetype)initWithRootURL:(NSURL *)rootURL {
  return [self initWithRootURL:rootURL
                     sessionURL:[rootURL URLByAppendingPathComponent:
                                           DSHSessionSnapshotFilename]
               launchInstanceId:nil
                     coordinator:nil
                       faultHook:nil];
}

- (instancetype)initWithRootURL:(NSURL *)rootURL
                launchInstanceId:(NSString *)launchInstanceId {
  return [self initWithRootURL:rootURL
                     sessionURL:[rootURL URLByAppendingPathComponent:
                                           DSHSessionSnapshotFilename]
               launchInstanceId:launchInstanceId
                     coordinator:nil
                       faultHook:nil];
}

- (instancetype)initWithPrivateRootURL:(NSURL *)privateRootURL {
  return [self initWithRootURL:privateRootURL];
}

- (instancetype)initWithSessionURL:(NSURL *)sessionURL {
  return [self initWithRootURL:sessionURL.URLByDeletingLastPathComponent
                     sessionURL:sessionURL
               launchInstanceId:nil
                     coordinator:nil
                       faultHook:nil];
}

- (instancetype)initWithSessionURL:(NSURL *)sessionURL
                  launchInstanceId:(NSString *)launchInstanceId {
  return [self initWithRootURL:sessionURL.URLByDeletingLastPathComponent
                     sessionURL:sessionURL
               launchInstanceId:launchInstanceId
                     coordinator:nil
                       faultHook:nil];
}

- (instancetype)initWithRootURL:(NSURL *)rootURL
                      sessionURL:(NSURL *)sessionURL
                launchInstanceId:(NSString *)launchInstanceId
                      coordinator:(DSHSessionWorkspaceCoordinator *)coordinator
                        faultHook:(DSHSessionSnapshotStoreFaultHook)faultHook {
  return [self initWithRootURL:rootURL
                    sessionURL:sessionURL
              launchInstanceId:launchInstanceId
                    coordinator:coordinator
                      faultHook:faultHook
        projectDetachValidator:nil];
}

- (instancetype)initWithRootURL:(NSURL *)rootURL
                      sessionURL:(NSURL *)sessionURL
                launchInstanceId:(NSString *)launchInstanceId
                      coordinator:(DSHSessionWorkspaceCoordinator *)coordinator
                        faultHook:(DSHSessionSnapshotStoreFaultHook)faultHook
          projectDetachValidator:
              (DSHWorkspaceClearanceProjectDetachValidator)projectDetachValidator {
  if (![rootURL isKindOfClass:NSURL.class] || !rootURL.isFileURL ||
      ![sessionURL isKindOfClass:NSURL.class] || !sessionURL.isFileURL ||
      rootURL.path.length == 0 || sessionURL.path.length == 0) {
    return nil;
  }
  NSString *rootPath = rootURL.path.stringByStandardizingPath;
  NSString *sessionPath = sessionURL.path.stringByStandardizingPath;
  NSString *normalizedRootName = [NSURL fileURLWithPath:rootPath
                                          isDirectory:YES].lastPathComponent;
  NSString *normalizedSessionName = [NSURL fileURLWithPath:sessionPath
                                             isDirectory:NO].lastPathComponent;
  if (![sessionPath hasPrefix:[rootPath stringByAppendingString:@"/"]] ||
      ![[sessionURL.URLByDeletingLastPathComponent.path stringByStandardizingPath]
          isEqualToString:rootPath] ||
      normalizedRootName.length == 0 || [normalizedRootName isEqual:@"."] ||
      [normalizedRootName isEqual:@".."] || normalizedSessionName.length == 0 ||
      [normalizedSessionName isEqual:@"."] || [normalizedSessionName isEqual:@".."] ||
      [normalizedSessionName rangeOfString:@"/"].location != NSNotFound) {
    return nil;
  }
  self = [super init];
  if (self != nil) {
    _rootURL = [NSURL fileURLWithPath:rootPath isDirectory:YES];
    _sessionURL = [NSURL fileURLWithPath:sessionPath isDirectory:NO];
    NSString *candidate = launchInstanceId ?: DSHSessionSnapshotStoreLaunchInstanceId();
    if (launchInstanceId != nil && !DSHSessionCanonicalUUID(candidate)) {
      return nil;
    }
    _launchInstanceId = [candidate copy];
    _coordinator = coordinator ?: [DSHSessionWorkspaceCoordinator sharedCoordinator];
    _clearanceStore = [[DSHWorkspaceClearanceStore alloc]
        initWithPrivateRootURL:_rootURL
                    coordinator:_coordinator
                          clock:nil
             identifierGenerator:nil
                      faultHook:nil
         projectDetachValidator:projectDetachValidator];
    _clearanceWorkspaceAccess = [[DSHLocalWorkspaceAccess alloc]
        initWithPrivateRootURL:_rootURL
                         clock:^NSDate * { return NSDate.date; }
                 UUIDGenerator:^NSString * {
                   return NSUUID.UUID.UUIDString.lowercaseString;
                 }
                legacyResolver:^BOOL(__unused NSString *projectId,
                                      NSDictionary **evidence,
                                      NSError **innerError) {
                  if (evidence != nil) *evidence = nil;
                  if (innerError != nil) {
                    *innerError = [NSError errorWithDomain:
                        DSHLocalWorkspaceAccessErrorDomain
                                                       code:
                        DSHLocalWorkspaceAccessErrorUnavailable
                                                   userInfo:@{}];
                  }
                  return NO;
                }
                     faultHook:nil];
    _faultHook = [faultHook copy];
    _rootDescriptor = -1;
    _parentDescriptor = -1;
    _rootName = [normalizedRootName copy];
    _sessionFilename = [normalizedSessionName copy];
  }
  return self;
}

- (void)dealloc {
  if (_rootDescriptor >= 0) close(_rootDescriptor);
  if (_parentDescriptor >= 0) close(_parentDescriptor);
}

- (BOOL)requiresSessionResourceMetadata {
#if TARGET_OS_OSX || TARGET_OS_SIMULATOR
  return NO;
#else
  return YES;
#endif
}

- (id)sessionProtectionPolicyValue {
  return NSURLFileProtectionCompleteUntilFirstUserAuthentication;
}

- (BOOL)setSessionProtectionValue:(id)value
                            atURL:(NSURL *)url
                            error:(NSError **)error {
  return [url setResourceValue:value
                         forKey:NSURLFileProtectionKey
                          error:error];
}

- (BOOL)setSessionBackupExcluded:(BOOL)excluded
                           atURL:(NSURL *)url
                           error:(NSError **)error {
  return [url setResourceValue:@(excluded)
                         forKey:NSURLIsExcludedFromBackupKey
                          error:error];
}

- (BOOL)getSessionProtectionAtURL:(NSURL *)url
                            value:(id *)value
                            error:(NSError **)error {
  return [url getResourceValue:value
                        forKey:NSURLFileProtectionKey
                         error:error];
}

- (BOOL)getSessionBackupExcludedAtURL:(NSURL *)url
                                value:(NSNumber **)value
                                error:(NSError **)error {
  return [url getResourceValue:value
                        forKey:NSURLIsExcludedFromBackupKey
                         error:error];
}

- (BOOL)setErrorForPinnedPathCheck:(DSHSessionPinnedPathCheck)check
                             error:(NSError **)error {
  switch (check) {
    case DSHSessionPinnedPathCheckOK:
      return YES;
    case DSHSessionPinnedPathCheckStorage:
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    case DSHSessionPinnedPathCheckProtection:
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
    case DSHSessionPinnedPathCheckConflict:
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
}

- (BOOL)validatePinnedDescriptor:(int)descriptor
                           atURL:(NSURL *)url
                       directory:(BOOL)directory
                   excludeBackup:(BOOL)excludeBackup
                 requireMetadata:(BOOL)requireMetadata
                           error:(NSError **)error {
  mode_t requiredMode = directory ? 0700 : 0600;
  DSHSessionPinnedPathCheck check = DSHSessionCheckPinnedPath(
      descriptor, url, directory, requiredMode, nullptr, nullptr);
  if (![self setErrorForPinnedPathCheck:check error:error]) return NO;
  if (!requireMetadata || ![self requiresSessionResourceMetadata]) return YES;

  NSError *readError = nil;
  id protection = nil;
  if (![self getSessionProtectionAtURL:url value:&protection error:&readError]) {
    if (readError != nil) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
  }
  if (![protection isEqual:[self sessionProtectionPolicyValue]]) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
  }
  check = DSHSessionCheckPinnedPath(descriptor, url, directory, requiredMode,
                                    nullptr, nullptr);
  if (![self setErrorForPinnedPathCheck:check error:error]) return NO;
  NSNumber *excluded = nil;
  readError = nil;
  if (![self getSessionBackupExcludedAtURL:url value:&excluded error:&readError]) {
    if (readError != nil) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
  }
  if (![excluded isKindOfClass:NSNumber.class] ||
      excluded.boolValue != excludeBackup) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
  }
  check = DSHSessionCheckPinnedPath(descriptor, url, directory, requiredMode,
                                    nullptr, nullptr);
  return [self setErrorForPinnedPathCheck:check error:error];
}

- (BOOL)hardenPinnedDescriptor:(int)descriptor
                         atURL:(NSURL *)url
                     directory:(BOOL)directory
                 excludeBackup:(BOOL)excludeBackup
                         error:(NSError **)error {
  if (descriptor < 0 || ![url isKindOfClass:NSURL.class] || !url.isFileURL) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  struct stat descriptorBefore = {};
  struct stat pathBefore = {};
  if (fstat(descriptor, &descriptorBefore) != 0 ||
      lstat(url.fileSystemRepresentation, &pathBefore) != 0) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  BOOL descriptorTypeOK = directory ? S_ISDIR(descriptorBefore.st_mode)
                                    : S_ISREG(descriptorBefore.st_mode);
  BOOL pathTypeOK = directory ? S_ISDIR(pathBefore.st_mode)
                              : S_ISREG(pathBefore.st_mode);
  if (!descriptorTypeOK || !pathTypeOK || S_ISLNK(pathBefore.st_mode) ||
      (!directory &&
       (descriptorBefore.st_nlink != 1 || pathBefore.st_nlink != 1))) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
  }
  if (!DSHSessionSamePinnedIdentity(&descriptorBefore, &pathBefore)) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  mode_t requiredMode = directory ? 0700 : 0600;
  if (fchmod(descriptor, requiredMode) != 0) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  struct stat hardened = {};
  DSHSessionPinnedPathCheck check = DSHSessionCheckPinnedPath(
      descriptor, url, directory, requiredMode, nullptr, &hardened);
  if (![self setErrorForPinnedPathCheck:check error:error]) return NO;

  if ([self requiresSessionResourceMetadata]) {
    check = DSHSessionCheckPinnedPath(descriptor, url, directory, requiredMode,
                                      &hardened, nullptr);
    if (![self setErrorForPinnedPathCheck:check error:error]) return NO;
    NSError *metadataError = nil;
    if (![self setSessionProtectionValue:[self sessionProtectionPolicyValue]
                                   atURL:url
                                   error:&metadataError]) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    check = DSHSessionCheckPinnedPath(descriptor, url, directory, requiredMode,
                                      &hardened, nullptr);
    if (![self setErrorForPinnedPathCheck:check error:error]) return NO;

    check = DSHSessionCheckPinnedPath(descriptor, url, directory, requiredMode,
                                      &hardened, nullptr);
    if (![self setErrorForPinnedPathCheck:check error:error]) return NO;
    metadataError = nil;
    if (![self setSessionBackupExcluded:excludeBackup
                                  atURL:url
                                  error:&metadataError]) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    check = DSHSessionCheckPinnedPath(descriptor, url, directory, requiredMode,
                                      &hardened, nullptr);
    if (![self setErrorForPinnedPathCheck:check error:error]) return NO;
    if (![self validatePinnedDescriptor:descriptor
                                  atURL:url
                              directory:directory
                          excludeBackup:excludeBackup
                        requireMetadata:YES
                                  error:error]) {
      return NO;
    }
  }
  if (fsync(descriptor) != 0) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  check = DSHSessionCheckPinnedPath(descriptor, url, directory, requiredMode,
                                    &hardened, nullptr);
  if (![self setErrorForPinnedPathCheck:check error:error]) return NO;
  return [self validatePinnedDescriptor:descriptor
                                  atURL:url
                              directory:directory
                          excludeBackup:excludeBackup
                        requireMetadata:YES
                                  error:error];
}

- (BOOL)ensurePrivateRoot:(NSError **)error {
  if (self.rootDescriptor >= 0) {
    struct stat pinned = {};
    struct stat parent = {};
    NSURL *parentURL = self.rootURL.URLByDeletingLastPathComponent;
    int visibleParentDescriptor = open(
        parentURL.fileSystemRepresentation,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat visibleParent = {};
    BOOL parentPathPinned = visibleParentDescriptor >= 0 &&
        fstat(visibleParentDescriptor, &visibleParent) == 0;
    if (visibleParentDescriptor >= 0) close(visibleParentDescriptor);
    if (!parentPathPinned || fstat(self.rootDescriptor, &pinned) != 0 ||
        fstat(self.parentDescriptor, &parent) != 0) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    if (!S_ISDIR(pinned.st_mode) || S_ISLNK(pinned.st_mode)) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
    }
    if (pinned.st_dev != self.rootDevice || pinned.st_ino != self.rootInode ||
        visibleParent.st_dev != self.parentDevice ||
        visibleParent.st_ino != self.parentInode ||
        parent.st_dev != self.parentDevice || parent.st_ino != self.parentInode) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
    }
    return [self hardenPinnedDescriptor:self.rootDescriptor
                                  atURL:self.rootURL
                              directory:YES
                          excludeBackup:NO
                                  error:error];
  }

  NSURL *parentURL = self.rootURL.URLByDeletingLastPathComponent;
  int parent = open(parentURL.fileSystemRepresentation,
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (parent < 0) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  struct stat parentState = {};
  if (fstat(parent, &parentState) != 0) {
    close(parent);
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  int descriptor = openat(parent, self.rootName.fileSystemRepresentation,
                          O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0 && errno == ENOENT) {
    if (mkdirat(parent, self.rootName.fileSystemRepresentation, 0700) != 0 &&
        errno != EEXIST) {
      close(parent);
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    if (fsync(parent) != 0) {
      close(parent);
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    descriptor = openat(parent, self.rootName.fileSystemRepresentation,
                        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  }
  if (descriptor < 0) {
    close(parent);
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  struct stat state = {};
  if (fstat(descriptor, &state) != 0) {
    close(descriptor);
    close(parent);
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  if (!S_ISDIR(state.st_mode) || S_ISLNK(state.st_mode)) {
    close(descriptor);
    close(parent);
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
  }
  struct stat visible = {};
  if (fstatat(parent, self.rootName.fileSystemRepresentation, &visible,
              AT_SYMLINK_NOFOLLOW) != 0 || visible.st_dev != state.st_dev ||
      visible.st_ino != state.st_ino) {
    close(descriptor);
    close(parent);
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  if (![self hardenPinnedDescriptor:descriptor
                              atURL:self.rootURL
                          directory:YES
                      excludeBackup:NO
                              error:error]) {
    close(descriptor);
    close(parent);
    return NO;
  }
  self.parentDescriptor = parent;
  self.parentDevice = parentState.st_dev;
  self.parentInode = parentState.st_ino;
  self.rootDescriptor = descriptor;
  self.rootDevice = state.st_dev;
  self.rootInode = state.st_ino;
  return YES;
}

- (int)acquireCASLock:(NSError **)error {
  NSString *lockName = @".sessions.cas-lock";
  int descriptor = openat(self.rootDescriptor,
                          lockName.fileSystemRepresentation,
                          O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return -1;
  }
  struct stat state = {};
  if (fstat(descriptor, &state) != 0) {
    close(descriptor);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return -1;
  }
  if (!S_ISREG(state.st_mode) || state.st_nlink != 1) {
    close(descriptor);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorProtection);
    return -1;
  }
  int lockResult = 0;
  do {
    lockResult = flock(descriptor, LOCK_EX);
  } while (lockResult != 0 && errno == EINTR);
  if (lockResult != 0) {
    close(descriptor);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return -1;
  }
  NSURL *lockURL = [self.rootURL URLByAppendingPathComponent:lockName
                                                isDirectory:NO];
  if (![self hardenPinnedDescriptor:descriptor
                              atURL:lockURL
                          directory:NO
                      excludeBackup:YES
                              error:error]) {
    close(descriptor);
    return -1;
  }
  return descriptor;
}

- (BOOL)validateStoredFileDescriptor:(int)descriptor
                               atURL:(NSURL *)url
                      requireMetadata:(BOOL)requireMetadata
                                error:(NSError **)error {
  return [self validatePinnedDescriptor:descriptor
                                  atURL:url
                              directory:NO
                          excludeBackup:YES
                        requireMetadata:requireMetadata
                                  error:error];
}

- (NSData *)readStoredBytes:(BOOL *)missing
                       state:(struct stat *)identity
                       error:(NSError **)error {
  return [self readStoredBytesForFilename:self.sessionFilename
                                  missing:missing
                                    state:identity
                                    error:error];
}

- (NSData *)readStoredBytesForFilename:(NSString *)filename
                               missing:(BOOL *)missing
                                 state:(struct stat *)identity
                                 error:(NSError **)error {
  if (missing != nullptr) *missing = NO;
  if (![self ensurePrivateRoot:error]) return nil;
  int descriptor = openat(self.rootDescriptor, filename.fileSystemRepresentation,
                          O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    if (errno == ENOENT) {
      if (missing != nullptr) *missing = YES;
      return nil;
    }
    DSHSessionSetError(error, errno == ELOOP
                               ? DSHSessionSnapshotStoreErrorProtection
                               : DSHSessionSnapshotStoreErrorStorage);
    return nil;
  }
  struct stat before = {};
  NSURL *storedURL = [self.rootURL URLByAppendingPathComponent:filename
                                                  isDirectory:NO];
  if (fstat(descriptor, &before) != 0) {
    close(descriptor);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return nil;
  }
  BOOL descriptorValid = [self validateStoredFileDescriptor:descriptor
                                                      atURL:storedURL
                                            requireMetadata:NO
                                                      error:error];
  BOOL sizeValid = descriptorValid && before.st_size > 0 &&
      (uint64_t)before.st_size <= DSHSessionSnapshotMaximumBytes;
  if (!sizeValid) {
    if (descriptorValid && before.st_size == 0) {
      DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
    } else if (descriptorValid && before.st_size > 0 &&
               (uint64_t)before.st_size > DSHSessionSnapshotMaximumBytes) {
      DSHSessionSetError(error, DSHSessionSnapshotStoreErrorBounds);
    }
    close(descriptor);
    return nil;
  }
  NSMutableData *data = [NSMutableData dataWithCapacity:(NSUInteger)before.st_size];
  uint8_t buffer[16384];
  while (data.length < (NSUInteger)before.st_size) {
    ssize_t count = read(descriptor, buffer,
                         MIN(sizeof(buffer),
                             (NSUInteger)before.st_size - data.length));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      close(descriptor);
      DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
      return nil;
    }
    [data appendBytes:buffer length:(NSUInteger)count];
  }
  struct stat after = {};
  struct stat visible = {};
  BOOL stable = fstat(descriptor, &after) == 0 &&
      fstatat(self.rootDescriptor, filename.fileSystemRepresentation,
              &visible, AT_SYMLINK_NOFOLLOW) == 0 &&
      after.st_dev == before.st_dev && after.st_ino == before.st_ino &&
      after.st_size == before.st_size && visible.st_dev == before.st_dev &&
      visible.st_ino == before.st_ino && visible.st_size == before.st_size;
  close(descriptor);
  if (!stable) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
    return nil;
  }
  if (identity != nullptr) *identity = before;
  return [data copy];
}

- (DSHSessionTombstoneState *)readTombstoneStateWithError:(NSError **)error {
  DSHSessionTombstoneState *state = [[DSHSessionTombstoneState alloc] init];
  BOOL missing = NO;
  struct stat identity = {};
  NSError *readError = nil;
  NSData *raw = [self readStoredBytesForFilename:DSHSessionSnapshotTombstoneFilename
                                          missing:&missing
                                            state:&identity
                                            error:&readError];
  if (missing) {
    state.missing = YES;
    state.valid = YES;
    state.generation = 0;
    state.operationIds = [NSSet set];
    return state;
  }
  if (raw == nil) {
    state.valid = NO;
    if (error != nullptr) *error = readError;
    return state;
  }
  state.missing = NO;
  state.device = identity.st_dev;
  state.inode = identity.st_ino;
  state.fileSize = identity.st_size;
  state.rawBytes = raw;
  if (raw.length > DSHSessionSnapshotMaximumTombstoneBytes) {
    state.valid = NO;
    if (error != nullptr) *error = DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorBounds);
    return state;
  }
  NSError *parseError = nil;
  NSDictionary *envelope = DSHSessionParseObjectWithNodeLimit(
      raw, DSHSessionSnapshotStoreErrorCorrupt,
      DSHSessionSnapshotMaximumTombstoneJSONNodes, &parseError);
  NSUInteger generation = 0;
  NSSet<NSString *> *operationIds = nil;
  if (envelope == nil ||
      !DSHSessionValidateTombstoneEnvelope(envelope, &generation,
                                            &operationIds)) {
    state.valid = NO;
    if (error != nullptr) *error = parseError ?: DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorCorrupt);
    return state;
  }
  NSError *protectionError = nil;
  if (![self validateProtectedFileWithIdentity:&identity
                                        filename:DSHSessionSnapshotTombstoneFilename
                                           error:&protectionError]) {
    state.valid = NO;
    if (error != nullptr) *error = protectionError;
    return state;
  }
  state.missing = NO;
  state.valid = YES;
  state.device = identity.st_dev;
  state.inode = identity.st_ino;
  state.fileSize = identity.st_size;
  state.rawBytes = raw;
  state.generation = generation;
  state.operationIds = operationIds ?: [NSSet set];
  return state;
}

- (BOOL)hardenLegacyFileWithIdentity:(const struct stat *)expected
                                error:(NSError **)error {
  int descriptor = openat(self.rootDescriptor,
                          self.sessionFilename.fileSystemRepresentation,
                          O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  struct stat before = {};
  BOOL same = fstat(descriptor, &before) == 0 &&
      expected != nullptr && before.st_dev == expected->st_dev &&
      before.st_ino == expected->st_ino && before.st_size == expected->st_size;
  if (!same) {
    close(descriptor);
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  BOOL ok = [self hardenPinnedDescriptor:descriptor
                                   atURL:self.sessionURL
                               directory:NO
                           excludeBackup:YES
                                   error:error];
  if (ok && fsync(self.rootDescriptor) != 0) {
    ok = DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
  }
  close(descriptor);
  return ok;
}

- (BOOL)validateProtectedFileWithIdentity:(const struct stat *)expected
                                     error:(NSError **)error {
  return [self validateProtectedFileWithIdentity:expected
                                         filename:self.sessionFilename
                                            error:error];
}

- (BOOL)validateProtectedFileWithIdentity:(const struct stat *)expected
                                  filename:(NSString *)filename
                                     error:(NSError **)error {
  if (expected == nullptr || ![filename isKindOfClass:NSString.class] ||
      filename.length == 0 || [filename containsString:@"/"]) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
  }
  int descriptor = openat(self.rootDescriptor,
                          filename.fileSystemRepresentation,
                          O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  struct stat state = {};
  struct stat visible = {};
  NSURL *storedURL = [self.rootURL URLByAppendingPathComponent:filename
                                                  isDirectory:NO];
  BOOL ok = fstat(descriptor, &state) == 0 &&
      state.st_dev == expected->st_dev && state.st_ino == expected->st_ino &&
      state.st_size == expected->st_size &&
      [self validateStoredFileDescriptor:descriptor
                                   atURL:storedURL
                         requireMetadata:YES
                                   error:error] &&
      fstatat(self.rootDescriptor, filename.fileSystemRepresentation,
              &visible, AT_SYMLINK_NOFOLLOW) == 0 &&
      visible.st_dev == state.st_dev && visible.st_ino == state.st_ino &&
      visible.st_size == state.st_size;
  close(descriptor);
  if (!ok && (error == nullptr || *error == nil)) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  return ok;
}

- (BOOL)validateV2Envelope:(NSDictionary *)envelope
                    session:(NSDictionary **)sessionOut
                      error:(NSError **)error {
  NSArray *base = @[
    @"schema_version", @"writer_launch_instance_id", @"session",
  ];
  NSArray *pair = @[@"proof_run_id", @"proof_request_id"];
  if (!DSHSessionOptionalPairKeys(envelope, base, pair) ||
      !DSHSessionExactSchema(envelope[@"schema_version"], 2) ||
      !DSHSessionCanonicalUUID(envelope[@"writer_launch_instance_id"]) ||
      !DSHSessionTrustedDictionary(envelope[@"session"]) ||
      !DSHSessionValidateLegacyRoot(envelope[@"session"])) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
  }
  BOOL hasProofPair = envelope.count == 5;
  if (hasProofPair) {
    BOOL bothNull = envelope[@"proof_run_id"] == NSNull.null &&
        envelope[@"proof_request_id"] == NSNull.null;
    BOOL bothIds = DSHSessionCanonicalUUID(envelope[@"proof_run_id"]) &&
        DSHSessionCanonicalUUID(envelope[@"proof_request_id"]);
    if (!bothNull && !bothIds) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
    }
  }
  if (sessionOut != nullptr) *sessionOut = envelope[@"session"];
  return YES;
}

- (BOOL)validateV3Envelope:(NSDictionary *)envelope
                    session:(NSDictionary **)sessionOut
                     digest:(NSString **)digestOut
                 generation:(NSUInteger *)generationOut
                    commits:(NSArray<NSDictionary *> **)commitsOut
                      error:(NSError **)error {
  NSArray *keys = @[
    @"schema_version", @"writer_launch_instance_id", @"generation",
    @"session_sha256", @"session", @"recent_commits", @"proof_run_id",
    @"proof_request_id",
  ];
  if (!DSHSessionExactKeys(envelope, keys) ||
      !DSHSessionExactSchema(envelope[@"schema_version"], 3) ||
      !DSHSessionCanonicalUUID(envelope[@"writer_launch_instance_id"]) ||
      !DSHSessionSafeInteger(envelope[@"generation"], NO) ||
      !DSHSessionCanonicalDigest(envelope[@"session_sha256"]) ||
      !DSHSessionTrustedDictionary(envelope[@"session"]) ||
      !DSHSessionValidateSchema9Root(envelope[@"session"]) ||
      !DSHSessionTrustedArray(envelope[@"recent_commits"]) ||
      [(NSArray *)envelope[@"recent_commits"] count] == 0 ||
      [(NSArray *)envelope[@"recent_commits"] count] >
          DSHSessionSnapshotMaximumRecentCommits ||
      !(envelope[@"proof_run_id"] == NSNull.null ||
        DSHSessionCanonicalUUID(envelope[@"proof_run_id"])) ||
      !(envelope[@"proof_request_id"] == NSNull.null ||
        DSHSessionCanonicalUUID(envelope[@"proof_request_id"]))) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
  }
  BOOL proofPairValid = (envelope[@"proof_run_id"] == NSNull.null &&
                         envelope[@"proof_request_id"] == NSNull.null) ||
      (envelope[@"proof_run_id"] != NSNull.null &&
       envelope[@"proof_request_id"] != NSNull.null);
  if (!proofPairValid) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
  }
  NSError *digestError = nil;
  NSString *computed = DSHSessionHashObject(@"chat-session", envelope[@"session"],
                                            &digestError,
                                            DSHSessionSnapshotStoreErrorCorrupt);
  if (computed == nil || ![computed isEqualToString:envelope[@"session_sha256"]]) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
  }
  NSUInteger generation = [envelope[@"generation"] unsignedIntegerValue];
  NSMutableSet *operationIds = [NSMutableSet set];
  NSUInteger previousGeneration = 0;
  BOOL first = YES;
  for (NSDictionary *commit in envelope[@"recent_commits"]) {
    if (!DSHSessionExactKeys(commit, @[
          @"schema_version", @"operation_id", @"generation",
          @"session_sha256",
        ]) ||
        !DSHSessionExactSchema(commit[@"schema_version"], 1) ||
        !DSHSessionCanonicalOperationId(commit[@"operation_id"]) ||
        !DSHSessionSafeInteger(commit[@"generation"], NO) ||
        !DSHSessionCanonicalDigest(commit[@"session_sha256"]) ||
        [operationIds containsObject:commit[@"operation_id"]]) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
    }
    NSUInteger commitGeneration = [commit[@"generation"] unsignedIntegerValue];
    if (!first && commitGeneration <= previousGeneration) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
    }
    [operationIds addObject:commit[@"operation_id"]];
    previousGeneration = commitGeneration;
    first = NO;
  }
  NSArray *commits = envelope[@"recent_commits"];
  NSDictionary *last = commits.lastObject;
  if (![last[@"generation"] isEqual:@(generation)] ||
      ![last[@"session_sha256"] isEqualToString:envelope[@"session_sha256"]] ||
      commits.count > generation ||
      [commits.firstObject[@"generation"] unsignedIntegerValue] !=
          generation - commits.count + 1) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
  }
  if (sessionOut != nullptr) *sessionOut = envelope[@"session"];
  if (digestOut != nullptr) *digestOut = envelope[@"session_sha256"];
  if (generationOut != nullptr) *generationOut = generation;
  if (commitsOut != nullptr) *commitsOut = commits;
  return YES;
}

- (DSHSessionLoadedState *)readStateWithError:(NSError **)error {
  BOOL missing = NO;
  struct stat identity = {};
  NSData *raw = [self readStoredBytes:&missing state:&identity error:error];
  if (missing) {
    DSHSessionLoadedState *state = [[DSHSessionLoadedState alloc] init];
    state.missing = YES;
    state.authority = DSHSessionMissingAuthority();
    return state;
  }
  if (raw == nil) return nil;
  NSError *parseError = nil;
  NSDictionary *envelope = DSHSessionParseObject(
      raw, DSHSessionSnapshotStoreErrorCorrupt, &parseError);
  if (envelope == nil) {
    if (error != nullptr) *error = parseError ?: DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorCorrupt);
    return nil;
  }
  NSNumber *schema = envelope[@"schema_version"];
  if (DSHSessionExactSchema(schema, 2)) {
    NSDictionary *session = nil;
    NSError *validationError = nil;
    if (![self validateV2Envelope:envelope session:&session error:&validationError]) {
      if (error != nullptr) *error = validationError;
      return nil;
    }
    NSString *legacyDigest = DSHSessionHashBytes(
        @"legacy-session-json", raw, &validationError,
        DSHSessionSnapshotStoreErrorCorrupt);
    if (legacyDigest == nil) {
      if (error != nullptr) *error = validationError;
      return nil;
    }
    DSHSessionLoadedState *state = [[DSHSessionLoadedState alloc] init];
    state.legacy = YES;
    state.hasFile = YES;
    state.device = identity.st_dev;
    state.inode = identity.st_ino;
    state.fileSize = identity.st_size;
    state.rawBytes = raw;
    state.session = session;
    state.legacyBytesDigest = legacyDigest;
    NSError *hardenError = nil;
    BOOL hardened =
        [self hardenLegacyFileWithIdentity:&identity error:&hardenError];
    if (!hardened) {
      if (error != nullptr) *error = hardenError;
      return nil;
    }
    state.authority = DSHSessionLegacyAuthority(legacyDigest);
    return state;
  }
  if (DSHSessionExactSchema(schema, 3)) {
    NSDictionary *session = nil;
    NSString *digest = nil;
    NSUInteger generation = 0;
    NSArray *commits = nil;
    NSError *validationError = nil;
    if (![self validateV3Envelope:envelope
                          session:&session
                           digest:&digest
                       generation:&generation
                          commits:&commits
                            error:&validationError]) {
      if (error != nullptr) *error = validationError;
      return nil;
    }
    DSHSessionLoadedState *state = [[DSHSessionLoadedState alloc] init];
    NSError *protectionError = nil;
    if (![self validateProtectedFileWithIdentity:&identity error:&protectionError]) {
      if (error != nullptr) *error = protectionError;
      return nil;
    }
    state.hasFile = YES;
    state.device = identity.st_dev;
    state.inode = identity.st_ino;
    state.fileSize = identity.st_size;
    state.rawBytes = raw;
    state.session = session;
    state.sessionDigest = digest;
    state.generation = generation;
    state.recentCommits = commits;
    state.authority = DSHSessionPresentAuthority(generation, digest);
    NSError *tombstoneError = nil;
    DSHSessionTombstoneState *tombstones =
        [self readTombstoneStateWithError:&tombstoneError];
    if (tombstones != nil) {
      state.tombstoneDevice = tombstones.device;
      state.tombstoneInode = tombstones.inode;
      state.tombstoneFileSize = tombstones.fileSize;
      state.tombstoneRawBytes = tombstones.rawBytes;
      state.tombstoneGeneration = tombstones.generation;
      state.tombstonedOperationIds = tombstones.operationIds ?: [NSSet set];
      state.tombstoneAvailable = tombstones.valid &&
          (generation <= DSHSessionSnapshotMaximumRecentCommits ||
           tombstones.generation >= generation);
      if (tombstones.missing && generation <= DSHSessionSnapshotMaximumRecentCommits) {
        state.tombstoneAvailable = YES;
      }
    }
    return state;
  }
  DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
  return nil;
}

- (NSDictionary *)loadResultForState:(DSHSessionLoadedState *)state
                                error:(NSError **)error {
  if (state.missing) return DSHSessionLoadMissingResult();
  NSData *sessionData = DSHSessionCanonicalJSON(
      state.session, error, DSHSessionSnapshotStoreErrorCorrupt);
  if (sessionData == nil) return nil;
  NSString *sessionJSON = [[NSString alloc] initWithData:sessionData
                                                 encoding:NSUTF8StringEncoding];
  if (sessionJSON == nil) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorCorrupt);
    return nil;
  }
  if (state.legacy) {
    return @{
      @"schema_version" : @1,
      @"status" : @"legacy_present",
      @"legacy" : DSHSessionLegacyRef(state.legacyBytesDigest),
      @"session_json" : sessionJSON,
    };
  }
  return @{
    @"schema_version" : @1,
    @"status" : @"present",
    @"snapshot" : DSHSessionSnapshotRef(state.generation, state.sessionDigest),
    @"session_json" : sessionJSON,
  };
}

- (NSDictionary *)authorityResultForState:(DSHSessionLoadedState *)state {
  return state.authority ?: DSHSessionMissingAuthority();
}

- (BOOL)validateAuthority:(NSDictionary *)authority error:(NSError **)error {
  if (!DSHSessionTrustedDictionary(authority) ||
      !DSHSessionExactSchema(authority[@"schema_version"], 1) ||
      !DSHSessionTrustedString(authority[@"kind"])) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
  }
  NSString *kind = authority[@"kind"];
  if ([kind isEqualToString:@"missing"]) {
    if (!DSHSessionExactKeys(authority, @[@"schema_version", @"kind"])) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
    }
    return YES;
  }
  if ([kind isEqualToString:@"legacy_present"]) {
    NSDictionary *legacy = authority[@"legacy"];
    if (!DSHSessionExactKeys(authority, @[@"schema_version", @"kind", @"legacy"]) ||
        !DSHSessionExactKeys(legacy, @[@"schema_version", @"legacy_bytes_sha256"]) ||
        !DSHSessionExactSchema(legacy[@"schema_version"], 1) ||
        !DSHSessionCanonicalDigest(legacy[@"legacy_bytes_sha256"])) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
    }
    return YES;
  }
  if ([kind isEqualToString:@"present"]) {
    NSDictionary *snapshot = authority[@"snapshot"];
    if (!DSHSessionExactKeys(authority, @[@"schema_version", @"kind", @"snapshot"]) ||
        !DSHSessionExactKeys(snapshot, @[
          @"schema_version", @"generation", @"session_sha256",
        ]) ||
        !DSHSessionExactSchema(snapshot[@"schema_version"], 1) ||
        !DSHSessionSafeInteger(snapshot[@"generation"], NO) ||
        !DSHSessionCanonicalDigest(snapshot[@"session_sha256"])) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
    }
    return YES;
  }
  return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
}

- (BOOL)authorityMatchesState:(NSDictionary *)authority
                        state:(DSHSessionLoadedState *)state {
  return [authority isEqual:state.authority];
}

- (BOOL)targetMatchesExpectedState:(DSHSessionLoadedState *)expected
                              error:(NSError **)error {
  return [self targetMatchesExpectedState:expected
                                 filename:self.sessionFilename
                                    error:error];
}

- (BOOL)targetMatchesExpectedState:(DSHSessionLoadedState *)expected
                           filename:(NSString *)filename
                              error:(NSError **)error {
  if (expected == nil || ![filename isKindOfClass:NSString.class] ||
      filename.length == 0 || [filename containsString:@"/"]) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
  }
  struct stat target = {};
  if (fstatat(self.rootDescriptor, filename.fileSystemRepresentation,
              &target, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT && expected.missing) return YES;
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  if (expected.missing || !expected.hasFile || !S_ISREG(target.st_mode) ||
      target.st_nlink != 1 || (target.st_mode & 0777) != 0600 ||
      target.st_dev != expected.device || target.st_ino != expected.inode ||
      target.st_size != expected.fileSize) {
    return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  }
  // Device/inode identity catches replacement, while the byte comparison
  // catches an in-place external writer that preserves both identity and
  // length.  The latter is required for a real CAS boundary because the
  // process-global queue cannot serialize another process.
  if (expected.rawBytes != nil) {
    int descriptor = openat(self.rootDescriptor,
                            filename.fileSystemRepresentation,
                            O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
    }
    struct stat opened = {};
    NSURL *storedURL = [self.rootURL URLByAppendingPathComponent:filename
                                                    isDirectory:NO];
    BOOL same = fstat(descriptor, &opened) == 0 &&
        opened.st_dev == expected.device && opened.st_ino == expected.inode &&
        opened.st_size == expected.fileSize &&
        [self validateStoredFileDescriptor:descriptor
                                     atURL:storedURL
                           requireMetadata:YES
                                     error:error];
    NSMutableData *bytes = [NSMutableData dataWithCapacity:
        expected.rawBytes.length];
    uint8_t buffer[16384];
    while (same && bytes.length < expected.rawBytes.length) {
      ssize_t count = read(descriptor, buffer,
                           MIN(sizeof(buffer),
                               expected.rawBytes.length - bytes.length));
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) {
        same = NO;
        break;
      }
      [bytes appendBytes:buffer length:(NSUInteger)count];
    }
    struct stat visible = {};
    same = same && bytes.length == expected.rawBytes.length &&
        [bytes isEqualToData:expected.rawBytes] &&
        fstat(descriptor, &opened) == 0 &&
        fstatat(self.rootDescriptor, filename.fileSystemRepresentation,
                &visible, AT_SYMLINK_NOFOLLOW) == 0 &&
        opened.st_dev == expected.device && opened.st_ino == expected.inode &&
        opened.st_size == expected.fileSize && visible.st_dev == expected.device &&
        visible.st_ino == expected.inode && visible.st_size == expected.fileSize;
    close(descriptor);
    if (!same) {
      return DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
    }
  }
  return YES;
}

- (DSHSessionAtomicWriteResult)publishTemporaryFilename:(NSString *)temporaryName
                                               filename:(NSString *)filename
                                          expectedState:(DSHSessionLoadedState *)expected
                                                  error:(NSError **)error {
  if (expected == nil || expected.missing) {
    if (renameatx_np(self.rootDescriptor, temporaryName.fileSystemRepresentation,
                     self.rootDescriptor, filename.fileSystemRepresentation,
                     RENAME_EXCL) == 0) {
      return DSHSessionAtomicWriteCommitted;
    }
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    DSHSessionSetError(error, errno == EEXIST
                               ? DSHSessionSnapshotStoreErrorConflict
                               : DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  if (expected.rawBytes == nil) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
    return DSHSessionAtomicWriteNoEffect;
  }
  struct stat replacementIdentity = {};
  int replacementDescriptor = openat(
      self.rootDescriptor, temporaryName.fileSystemRepresentation,
      O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  BOOL replacementIdentityValid = replacementDescriptor >= 0 &&
      fstat(replacementDescriptor, &replacementIdentity) == 0;
  if (replacementDescriptor >= 0) close(replacementDescriptor);
  if (!replacementIdentityValid) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  if (renameatx_np(self.rootDescriptor, temporaryName.fileSystemRepresentation,
                   self.rootDescriptor, filename.fileSystemRepresentation,
                   RENAME_SWAP) != 0) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  int oldTarget = openat(self.rootDescriptor, temporaryName.fileSystemRepresentation,
                         O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (oldTarget < 0) {
    // The exchange succeeded; leave both inodes recoverable for the next
    // reconciliation rather than unlinking an unknown target.
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  struct stat oldState = {};
  BOOL matches = fstat(oldTarget, &oldState) == 0 &&
      oldState.st_dev == expected.device && oldState.st_ino == expected.inode &&
      oldState.st_size == expected.fileSize && oldState.st_nlink == 1 &&
      (oldState.st_mode & 0777) == 0600;
  NSMutableData *oldBytes = [NSMutableData dataWithCapacity:
      expected.rawBytes.length];
  uint8_t buffer[16384];
  while (matches && oldBytes.length < expected.rawBytes.length) {
    ssize_t count = read(oldTarget, buffer,
                         MIN(sizeof(buffer),
                             expected.rawBytes.length - oldBytes.length));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      matches = NO;
      break;
    }
    [oldBytes appendBytes:buffer length:(NSUInteger)count];
  }
  struct stat oldAfter = {};
  matches = matches && oldBytes.length == expected.rawBytes.length &&
      [oldBytes isEqualToData:expected.rawBytes] && fstat(oldTarget, &oldAfter) == 0 &&
      oldAfter.st_dev == oldState.st_dev && oldAfter.st_ino == oldState.st_ino &&
      oldAfter.st_size == oldState.st_size;
  close(oldTarget);
  if (matches) {
    if (unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0) == 0) {
      return DSHSessionAtomicWriteCommitted;
    }
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  // The target changed after the original read. Atomically exchange back so
  // the changed inode remains authoritative, then remove only our temporary
  // inode after verifying its identity.
  if (renameatx_np(self.rootDescriptor, temporaryName.fileSystemRepresentation,
                   self.rootDescriptor, filename.fileSystemRepresentation,
                   RENAME_SWAP) != 0) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  int replacement = openat(self.rootDescriptor,
                           temporaryName.fileSystemRepresentation,
                           O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat replacementState = {};
  BOOL replacementIsOurs = replacement >= 0 && fstat(replacement, &replacementState) == 0 &&
      replacementState.st_dev == replacementIdentity.st_dev &&
      replacementState.st_ino == replacementIdentity.st_ino;
  if (replacement >= 0) close(replacement);
  if (replacementIsOurs) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
  }
  DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
  return DSHSessionAtomicWriteNoEffect;
}

- (DSHSessionAtomicWriteResult)writeProtectedData:(NSData *)data
                                          filename:(NSString *)filename
                                     expectedState:(DSHSessionLoadedState *)expected
                                             error:(NSError **)error {
  if (![self ensurePrivateRoot:error]) return DSHSessionAtomicWriteNoEffect;
  int lockDescriptor = [self acquireCASLock:error];
  if (lockDescriptor < 0) return DSHSessionAtomicWriteNoEffect;
  @try {
    return [self writeProtectedData:data
                            filename:filename
                       expectedState:expected
                      lockDescriptor:lockDescriptor
                               error:error];
  } @finally {
    close(lockDescriptor);
  }
}

- (DSHSessionAtomicWriteResult)writeProtectedData:(NSData *)data
                                          filename:(NSString *)filename
                                     expectedState:(DSHSessionLoadedState *)expected
                                    lockDescriptor:(int)lockDescriptor
                                             error:(NSError **)error {
  if (![data isKindOfClass:NSData.class] || data.length == 0 ||
      data.length > DSHSessionSnapshotMaximumBytes ||
      lockDescriptor < 0) {
    return DSHSessionAtomicWriteNoEffect;
  }
  if (![self targetMatchesExpectedState:expected filename:filename error:error]) {
    return DSHSessionAtomicWriteNoEffect;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointBeforeWrite)) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  NSString *temporaryName = [NSString stringWithFormat:@".%@.%@.tmp",
      filename, NSUUID.UUID.UUIDString.lowercaseString];
  int descriptor = openat(self.rootDescriptor, temporaryName.fileSystemRepresentation,
                          O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                          0600);
  if (descriptor < 0) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  BOOL ok = YES;
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger offset = 0;
  while (ok && offset < data.length) {
    ssize_t count = write(descriptor, bytes + offset, data.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      ok = NO;
      break;
    }
    offset += (NSUInteger)count;
  }
  NSURL *temporaryURL = [self.rootURL URLByAppendingPathComponent:temporaryName
                                                      isDirectory:NO];
  if (ok) {
    ok = [self hardenPinnedDescriptor:descriptor
                                atURL:temporaryURL
                            directory:NO
                        excludeBackup:YES
                                error:error];
  }
  if (close(descriptor) != 0) ok = NO;
  descriptor = -1;
  if (!ok) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    if (error == nullptr || *error == nil) {
      DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    return DSHSessionAtomicWriteNoEffect;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointAfterWriteBeforeRename)) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  if (![self targetMatchesExpectedState:expected filename:filename error:error]) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    return DSHSessionAtomicWriteNoEffect;
  }
  DSHSessionAtomicWriteResult publishResult =
      [self publishTemporaryFilename:temporaryName
                             filename:filename
                        expectedState:expected
                                error:error];
  if (publishResult != DSHSessionAtomicWriteCommitted) {
    return publishResult;
  }
  int published = openat(self.rootDescriptor, filename.fileSystemRepresentation,
                         O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (published < 0) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  struct stat publishedBefore = {};
  struct stat visibleBefore = {};
  BOOL identity = fstat(published, &publishedBefore) == 0 &&
      fstatat(self.rootDescriptor, filename.fileSystemRepresentation,
              &visibleBefore, AT_SYMLINK_NOFOLLOW) == 0 &&
      publishedBefore.st_dev == visibleBefore.st_dev &&
      publishedBefore.st_ino == visibleBefore.st_ino &&
      publishedBefore.st_size == visibleBefore.st_size &&
      publishedBefore.st_size == (off_t)data.length;
  if (!identity) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
    return DSHSessionAtomicWriteUnknown;
  }
  NSURL *publishedURL = [self.rootURL URLByAppendingPathComponent:filename
                                                     isDirectory:NO];
  if (![self hardenPinnedDescriptor:published
                              atURL:publishedURL
                          directory:NO
                      excludeBackup:YES
                              error:error]) {
    close(published);
    return DSHSessionAtomicWriteUnknown;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointAfterRename)) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  if (fsync(published) != 0 || fsync(self.rootDescriptor) != 0) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointAfterRenameBeforeVerify)) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  struct stat finalState = {};
  struct stat finalVisible = {};
  BOOL verified = fstat(published, &finalState) == 0 &&
      [self validateStoredFileDescriptor:published
                                   atURL:publishedURL
                         requireMetadata:YES
                                   error:error] &&
      fstatat(self.rootDescriptor, filename.fileSystemRepresentation,
              &finalVisible, AT_SYMLINK_NOFOLLOW) == 0 &&
      finalVisible.st_dev == finalState.st_dev &&
      finalVisible.st_ino == finalState.st_ino &&
      finalVisible.st_size == finalState.st_size &&
      finalState.st_size == (off_t)data.length;
  close(published);
  if (!verified) return DSHSessionAtomicWriteUnknown;
  return DSHSessionAtomicWriteCommitted;
}

- (DSHSessionAtomicWriteResult)writeEnvelopeData:(NSData *)data
                                     expectedState:(DSHSessionLoadedState *)expected
                                             error:(NSError **)error {
  if (![self ensurePrivateRoot:error]) return DSHSessionAtomicWriteNoEffect;
  int lockDescriptor = [self acquireCASLock:error];
  if (lockDescriptor < 0) return DSHSessionAtomicWriteNoEffect;
  @try {
    return [self writeEnvelopeData:data
                      expectedState:expected
                     lockDescriptor:lockDescriptor
                              error:error];
  } @finally {
    close(lockDescriptor);
  }
}

- (DSHSessionAtomicWriteResult)writeEnvelopeData:(NSData *)data
                                     expectedState:(DSHSessionLoadedState *)expected
                                    lockDescriptor:(int)lockDescriptor
                                             error:(NSError **)error {
  if (![data isKindOfClass:NSData.class] || data.length == 0 ||
      data.length > DSHSessionSnapshotMaximumBytes ||
      lockDescriptor < 0) {
    return DSHSessionAtomicWriteNoEffect;
  }
  if (![self targetMatchesExpectedState:expected error:error]) {
    return DSHSessionAtomicWriteNoEffect;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointBeforeWrite)) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  NSString *temporaryName = [NSString stringWithFormat:@".%@.%@.tmp",
      self.sessionFilename, NSUUID.UUID.UUIDString.lowercaseString];
  int descriptor = openat(self.rootDescriptor, temporaryName.fileSystemRepresentation,
                          O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                          0600);
  if (descriptor < 0) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  BOOL ok = YES;
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger offset = 0;
  while (ok && offset < data.length) {
    ssize_t count = write(descriptor, bytes + offset, data.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      ok = NO;
      break;
    }
    offset += (NSUInteger)count;
  }
  NSURL *temporaryURL = [self.rootURL URLByAppendingPathComponent:temporaryName
                                                      isDirectory:NO];
  if (ok) {
    ok = [self hardenPinnedDescriptor:descriptor
                                atURL:temporaryURL
                            directory:NO
                        excludeBackup:YES
                                error:error];
  }
  if (close(descriptor) != 0) ok = NO;
  descriptor = -1;
  if (!ok) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    if (error == nullptr || *error == nil) {
      DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    }
    return DSHSessionAtomicWriteNoEffect;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointAfterWriteBeforeRename)) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteNoEffect;
  }
  // Recheck the complete expected target immediately before publication. This
  // is the CAS identity guard; the pinned root descriptor prevents path swap.
  if (![self targetMatchesExpectedState:expected error:error]) {
    unlinkat(self.rootDescriptor, temporaryName.fileSystemRepresentation, 0);
    return DSHSessionAtomicWriteNoEffect;
  }
  DSHSessionAtomicWriteResult publishResult =
      [self publishTemporaryFilename:temporaryName
                             filename:self.sessionFilename
                        expectedState:expected
                                error:error];
  if (publishResult != DSHSessionAtomicWriteCommitted) {
    return publishResult;
  }
  // Keep the published inode open while applying metadata to the canonical
  // path. Identity is checked against the pinned descriptor before and after
  // each resource operation, so a lexical-path swap is a conflict.
  int published = openat(self.rootDescriptor,
                         self.sessionFilename.fileSystemRepresentation,
                         O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (published < 0) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  struct stat publishedBefore = {};
  struct stat visibleBefore = {};
  BOOL publishedIdentity = fstat(published, &publishedBefore) == 0 &&
      fstatat(self.rootDescriptor, self.sessionFilename.fileSystemRepresentation,
              &visibleBefore, AT_SYMLINK_NOFOLLOW) == 0 &&
      publishedBefore.st_dev == visibleBefore.st_dev &&
      publishedBefore.st_ino == visibleBefore.st_ino &&
      publishedBefore.st_size == visibleBefore.st_size &&
      publishedBefore.st_size == (off_t)data.length;
  if (!publishedIdentity) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorConflict);
    return DSHSessionAtomicWriteUnknown;
  }
  NSURL *destinationURL = self.sessionURL;
  if (![self hardenPinnedDescriptor:published
                              atURL:destinationURL
                          directory:NO
                      excludeBackup:YES
                              error:error]) {
    close(published);
    return DSHSessionAtomicWriteUnknown;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointAfterRename)) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  if (fsync(published) != 0 || fsync(self.rootDescriptor) != 0) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  if (self.faultHook != nil &&
      !self.faultHook(DSHSessionSnapshotStoreFaultPointAfterRenameBeforeVerify)) {
    close(published);
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorStorage);
    return DSHSessionAtomicWriteUnknown;
  }
  struct stat state = {};
  struct stat visible = {};
  BOOL fstatOK = fstat(published, &state) == 0;
  BOOL metadataOK = fstatOK &&
      [self validateStoredFileDescriptor:published
                                   atURL:destinationURL
                         requireMetadata:YES
                                   error:error];
  BOOL visibleOK = fstatat(self.rootDescriptor, self.sessionFilename.fileSystemRepresentation,
                           &visible, AT_SYMLINK_NOFOLLOW) == 0;
  BOOL nodeOK = visibleOK && visible.st_dev == state.st_dev &&
      visible.st_ino == state.st_ino && visible.st_size == state.st_size;
  BOOL sizeOK = state.st_size == (off_t)data.length;
  BOOL verified = fstatOK && metadataOK && visibleOK && nodeOK && sizeOK;
  close(published);
  if (!verified) return DSHSessionAtomicWriteUnknown;
  return DSHSessionAtomicWriteCommitted;
}

- (NSDictionary *)casPersistSessionLocked:(NSDictionary *)request
                                     error:(NSError **)error {
  BOOL rootReady = [self ensurePrivateRoot:error];
  if (!rootReady) return nil;
  int lockDescriptor = [self acquireCASLock:error];
  if (lockDescriptor < 0) return nil;
  @try {
    NSDictionary *result = [self casPersistSessionLocked:request
                                           lockDescriptor:lockDescriptor
                                                     error:error];
    return result;
  } @finally {
    close(lockDescriptor);
  }
}

- (NSDictionary *)casPersistSessionLocked:(NSDictionary *)request
                            lockDescriptor:(int)lockDescriptor
                                      error:(NSError **)error {
  if (!DSHSessionTrustedDictionary(request) ||
      !DSHSessionExactKeys(request, @[
        @"schema_version", @"operation_id", @"expected", @"candidate_json",
      ]) ||
      !DSHSessionExactSchema(request[@"schema_version"], 1) ||
      !DSHSessionCanonicalOperationId(request[@"operation_id"]) ||
      !DSHSessionTrustedString(request[@"candidate_json"]) ||
      ![self validateAuthority:request[@"expected"] error:error]) {
    if (error != nullptr && *error == nil) {
      DSHSessionSetError(error, DSHSessionSnapshotStoreErrorInvalidArgument);
    }
    return nil;
  }
  NSData *candidateBytes = [request[@"candidate_json"]
      dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (candidateBytes == nil || candidateBytes.length == 0 ||
      candidateBytes.length > DSHSessionSnapshotMaximumBytes) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorBounds);
    return nil;
  }
  NSError *candidateError = nil;
  NSDictionary *candidate = DSHSessionParseObject(
      candidateBytes, DSHSessionSnapshotStoreErrorInvalidArgument, &candidateError);
  if (candidate == nil || !DSHSessionValidateSchema9Root(candidate)) {
    if (error != nullptr) {
      *error = candidateError ?: DSHSessionStoreError(
          DSHSessionSnapshotStoreErrorInvalidArgument);
    }
    return nil;
  }
  NSString *candidateDigest = DSHSessionHashObject(
      @"chat-session", candidate, error, DSHSessionSnapshotStoreErrorInvalidArgument);
  if (candidateDigest == nil) return nil;

  NSError *stateError = nil;
  DSHSessionLoadedState *state = [self readStateWithError:&stateError];
  if (state == nil) {
    if (error != nullptr) *error = stateError;
    return nil;
  }
  NSString *operationId = request[@"operation_id"];
  if (!state.missing && !state.legacy) {
    for (NSDictionary *commit in state.recentCommits) {
      if (![commit[@"operation_id"] isEqualToString:operationId]) continue;
      BOOL identical = [commit[@"session_sha256"] isEqualToString:candidateDigest];
      if (identical) {
        return @{
          @"schema_version" : @1,
          @"status" : @"committed",
          @"snapshot" : DSHSessionSnapshotRef(
              [commit[@"generation"] unsignedIntegerValue],
              commit[@"session_sha256"]),
        };
      }
      return @{
        @"schema_version" : @1,
        @"status" : @"conflict",
        @"current" : state.authority,
      };
    }
  }
  NSDictionary *expected = request[@"expected"];
  if (![self authorityMatchesState:expected state:state]) {
    return @{
      @"schema_version" : @1,
      @"status" : @"conflict",
      @"current" : state.authority,
    };
  }

  // Re-read while still holding the same process-global serial lock.  This is
  // the legacy migration guard: an expected token is the digest of exact raw
  // bytes, not of a parsed/re-serialized object.
  DSHSessionLoadedState *current = [self readStateWithError:&stateError];
  if (current == nil) {
    if (error != nullptr) *error = stateError;
    return nil;
  }
  if (![self authorityMatchesState:expected state:current]) {
    return @{
      @"schema_version" : @1,
      @"status" : @"conflict",
      @"current" : current.authority,
    };
  }
  // Re-read the separate tombstone ledger after the authority re-read.  A
  // valid ledger makes a non-retained operation a fresh operation; an absent,
  // stale, or malformed ledger makes the absence unprovable and therefore
  // cannot be allowed to advance the session.
  NSError *tombstoneError = nil;
  DSHSessionTombstoneState *tombstones =
      [self readTombstoneStateWithError:&tombstoneError];
  if (tombstones == nil) {
    return @{
      @"schema_version" : @1,
      @"status" : @"unknown",
      @"current" : current.authority,
    };
  }
  if (!tombstones.valid && !tombstones.missing) {
    return @{
      @"schema_version" : @1,
      @"status" : @"unknown",
      @"current" : current.authority,
    };
  }
  if (!current.missing && !current.legacy &&
      current.generation > current.recentCommits.count &&
      (!tombstones.valid || tombstones.generation < current.generation)) {
    return @{
      @"schema_version" : @1,
      @"status" : @"unknown",
      @"current" : current.authority,
    };
  }
  if (tombstones.valid && [tombstones.operationIds containsObject:operationId]) {
    return @{
      @"schema_version" : @1,
      @"status" : @"unknown",
      @"current" : current.authority,
    };
  }
  NSUInteger nextGeneration = current.missing || current.legacy
      ? 1
      : current.generation + 1;
  if (nextGeneration == 0 ||
      nextGeneration > DSHSessionSnapshotMaximumSafeInteger) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorBounds);
    return nil;
  }
  NSMutableArray *commits = [NSMutableArray array];
  if (!current.missing && !current.legacy) {
    [commits addObjectsFromArray:current.recentCommits];
  }
  [commits addObject:@{
    @"schema_version" : @1,
    @"operation_id" : operationId,
    @"generation" : @(nextGeneration),
    @"session_sha256" : candidateDigest,
  }];
  while (commits.count > DSHSessionSnapshotMaximumRecentCommits) {
    [commits removeObjectAtIndex:0];
  }
  NSMutableArray<NSString *> *tombstonedOperationIds = [NSMutableArray array];
  if (!current.missing && !current.legacy && current.generation >
          DSHSessionSnapshotMaximumRecentCommits) {
    [tombstonedOperationIds addObjectsFromArray:
        [[tombstones.operationIds allObjects]
            sortedArrayUsingSelector:@selector(compare:)]];
  }
  if (!current.missing && !current.legacy &&
      current.recentCommits.count == DSHSessionSnapshotMaximumRecentCommits) {
    NSString *evicted = current.recentCommits.firstObject[@"operation_id"];
    if (![tombstonedOperationIds containsObject:evicted]) {
      [tombstonedOperationIds addObject:evicted];
    }
  }
  if (tombstonedOperationIds.count > DSHSessionSnapshotMaximumTombstones) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorBounds);
    return nil;
  }
  NSDictionary *tombstoneEnvelope = @{
    @"schema_version" : @1,
    @"generation" : @(nextGeneration),
    @"operation_ids" : [tombstonedOperationIds copy],
  };
  NSData *tombstoneData = DSHSessionCanonicalJSON(
      tombstoneEnvelope, error, DSHSessionSnapshotStoreErrorInvalidArgument);
  if (tombstoneData == nil) return nil;
  if (tombstoneData.length > DSHSessionSnapshotMaximumTombstoneBytes) {
    DSHSessionSetError(error, DSHSessionSnapshotStoreErrorBounds);
    return nil;
  }
  DSHSessionLoadedState *tombstoneExpected =
      DSHSessionExpectedStateForTombstones(tombstones);
  DSHSessionAtomicWriteResult tombstoneWrite =
      [self writeProtectedData:tombstoneData
                        filename:DSHSessionSnapshotTombstoneFilename
                   expectedState:tombstoneExpected
                  lockDescriptor:lockDescriptor
                           error:error];
  if (tombstoneWrite == DSHSessionAtomicWriteNoEffect) {
    return @{
      @"schema_version" : @1,
      @"status" : @"not_committed",
      @"current" : current.authority,
    };
  }
  if (tombstoneWrite == DSHSessionAtomicWriteUnknown) {
    return @{
      @"schema_version" : @1,
      @"status" : @"unknown",
      @"current" : current.authority,
    };
  }
  NSDictionary *envelope = @{
    @"schema_version" : @3,
    @"writer_launch_instance_id" : self.launchInstanceId,
    @"generation" : @(nextGeneration),
    @"session_sha256" : candidateDigest,
    @"session" : candidate,
    @"recent_commits" : [commits copy],
    @"proof_run_id" : NSNull.null,
    @"proof_request_id" : NSNull.null,
  };
  NSData *encoded = DSHSessionCanonicalJSON(
      envelope, error, DSHSessionSnapshotStoreErrorInvalidArgument);
  if (encoded == nil) return nil;
  DSHSessionAtomicWriteResult writeResult =
      [self writeEnvelopeData:encoded
                 expectedState:current
                lockDescriptor:lockDescriptor
                         error:error];
  if (writeResult == DSHSessionAtomicWriteNoEffect) {
    return @{
      @"schema_version" : @1,
      @"status" : @"not_committed",
      @"current" : current.authority,
    };
  }
  if (writeResult == DSHSessionAtomicWriteUnknown) {
    return @{
      @"schema_version" : @1,
      @"status" : @"unknown",
      // The rename may have committed, but native cannot claim the target
      // authority until the protected read-back succeeds. The caller must
      // resolve this operation through querySessionCommit.
      @"current" : current.authority,
    };
  }
  DSHSessionLoadedState *verified = [self readStateWithError:&stateError];
  if (verified != nil && !verified.missing && !verified.legacy &&
      verified.generation == nextGeneration &&
      [verified.sessionDigest isEqualToString:candidateDigest] &&
      [verified.recentCommits.lastObject[@"operation_id"] isEqualToString:operationId]) {
    return @{
      @"schema_version" : @1,
      @"status" : @"committed",
      @"snapshot" : DSHSessionSnapshotRef(nextGeneration, candidateDigest),
    };
  }
  return @{
    @"schema_version" : @1,
    @"status" : @"unknown",
    @"current" : current.authority,
  };
}

- (NSDictionary *)loadSessionSnapshotWithError:(NSError **)error {
  __block NSDictionary *result = nil;
  __block NSError *operationError = nil;
  BOOL completed = [self.coordinator performSyncWithError:^BOOL(NSError **innerError) {
    BOOL rootReady = [self ensurePrivateRoot:&operationError];
    if (!rootReady) {
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    int lockDescriptor = [self acquireCASLock:&operationError];
    if (lockDescriptor < 0) {
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    @try {
    DSHSessionLoadedState *state = [self readStateWithError:&operationError];
    if (state == nil) {
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    result = [self loadResultForState:state error:&operationError];
    if (result == nil && innerError != nullptr) *innerError = operationError;
    return result != nil;
    } @finally {
      close(lockDescriptor);
    }
  } error:error];
  if (!completed && error != nullptr && *error == nil) {
    *error = operationError ?: DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorStorage);
  }
  return result;
}

- (NSDictionary *)loadSessionSnapshot:(NSError **)error {
  return [self loadSessionSnapshotWithError:error];
}

- (NSDictionary *)casPersistSession:(NSDictionary *)request
                               error:(NSError **)error {
  __block NSDictionary *result = nil;
  __block NSError *operationError = nil;
  BOOL completed = [self.coordinator performSyncWithError:^BOOL(NSError **innerError) {
    result = [self casPersistSessionLocked:request error:&operationError];
    if (result == nil && innerError != nullptr) *innerError = operationError;
    return result != nil;
  } error:error];
  if (!completed && error != nullptr && *error == nil) {
    *error = operationError ?: DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorStorage);
  }
  return result;
}

- (NSDictionary *)casPersistSessionWithRequest:(NSDictionary *)request
                                          error:(NSError **)error {
  return [self casPersistSession:request error:error];
}

- (NSDictionary *)querySessionCommit:(NSDictionary *)request
                                error:(NSError **)error {
  __block NSDictionary *result = nil;
  __block NSError *operationError = nil;
  BOOL completed = [self.coordinator performSyncWithError:^BOOL(NSError **innerError) {
    if (!DSHSessionTrustedDictionary(request) ||
        !DSHSessionExactKeys(request, @[@"schema_version", @"operation_id"]) ||
        !DSHSessionExactSchema(request[@"schema_version"], 1) ||
        !DSHSessionCanonicalOperationId(request[@"operation_id"])) {
      operationError = DSHSessionStoreError(
          DSHSessionSnapshotStoreErrorInvalidArgument);
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    BOOL rootReady = [self ensurePrivateRoot:&operationError];
    if (!rootReady) {
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    int lockDescriptor = [self acquireCASLock:&operationError];
    if (lockDescriptor < 0) {
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    @try {
    NSError *stateError = nil;
    DSHSessionLoadedState *state = [self readStateWithError:&stateError];
    if (state == nil) {
      // Query is intentionally weaker than load: malformed or unavailable
      // storage prevents proving absence, so it returns `unknown` without
      // projecting any native failure detail.
      result = @{@"schema_version" : @1, @"status" : @"unknown"};
      return YES;
    }
    if (state.missing || state.legacy) {
      result = @{@"schema_version" : @1, @"status" : @"not_started"};
      return YES;
    }
    NSString *operationId = request[@"operation_id"];
    for (NSDictionary *commit in state.recentCommits) {
      if ([commit[@"operation_id"] isEqualToString:operationId]) {
        result = @{
          @"schema_version" : @1,
          @"status" : @"committed",
          @"snapshot" : DSHSessionSnapshotRef(
              [commit[@"generation"] unsignedIntegerValue],
              commit[@"session_sha256"]),
        };
        return YES;
      }
    }
    BOOL historyEvicted = state.generation > state.recentCommits.count;
    BOOL tombstoneProvesAbsence = !historyEvicted ||
        (state.tombstoneAvailable &&
         ![state.tombstonedOperationIds containsObject:request[@"operation_id"]]);
    BOOL fullHistoryRetained = !historyEvicted &&
        state.recentCommits.count == state.generation &&
        [state.recentCommits.firstObject[@"generation"] unsignedIntegerValue] == 1;
    result = @{
      @"schema_version" : @1,
      @"status" : (fullHistoryRetained || tombstoneProvesAbsence)
          ? @"not_started" : @"unknown",
    };
    return YES;
    } @finally {
      close(lockDescriptor);
    }
  } error:error];
  if (!completed && error != nullptr && *error == nil) {
    *error = operationError ?: DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorStorage);
  }
  return result;
}

- (NSDictionary *)querySessionCommitWithRequest:(NSDictionary *)request
                                           error:(NSError **)error {
  return [self querySessionCommit:request error:error];
}

static BOOL DSHSessionCandidateReferencesWorkspace(
    NSDictionary *candidate,
    NSString *workspaceId) {
  NSArray *conversations = candidate[@"conversations"];
  if (!DSHSessionTrustedArray(conversations) ||
      !DSHSessionTrustedString(workspaceId)) {
    return YES;
  }
  for (NSDictionary *conversation in conversations) {
    if (![conversation isKindOfClass:NSDictionary.class]) return YES;
    id conversationWorkspace = conversation[@"workspace_id"];
    if (conversationWorkspace != NSNull.null &&
        [conversationWorkspace isEqual:workspaceId]) {
      return YES;
    }
    NSDictionary *binding = conversation[@"workspace_binding"] == NSNull.null
        ? nil : conversation[@"workspace_binding"];
    if (binding != nil && [binding[@"workspace_id"] isEqual:workspaceId]) {
      return YES;
    }
    for (NSDictionary *attempt in conversation[@"attempts"]) {
      if (![attempt isKindOfClass:NSDictionary.class]) return YES;
      id attemptWorkspace = attempt[@"workspace_id"];
      if (attemptWorkspace != NSNull.null &&
          [attemptWorkspace isEqual:workspaceId]) {
        return YES;
      }
    }
  }
  return NO;
}

static NSDictionary *DSHSessionClearanceResult(NSString *status,
                                               NSDictionary *receipt) {
  return receipt == nil
      ? @{ @"schema_version" : @1,
           @"status" : status,
           @"receipt" : NSNull.null }
      : @{ @"schema_version" : @1,
           @"status" : status,
           @"receipt" : receipt };
}

- (NSDictionary *)persistSessionWithWorkspaceClearance:(NSDictionary *)request
                                                 error:(NSError **)error {
  __block NSDictionary *result = nil;
  __block NSError *operationError = nil;
  BOOL completed = [self.coordinator performSyncWithError:^BOOL(NSError **innerError) {
    if (!DSHSessionTrustedDictionary(request) ||
        !DSHSessionExactKeys(request, @[@"schema_version", @"candidate_json",
                                       @"operation"]) ||
        !DSHSessionExactSchema(request[@"schema_version"], 1) ||
        !DSHSessionTrustedString(request[@"candidate_json"]) ||
        !DSHWorkspaceClearanceValidateOperation(request[@"operation"],
                                                &operationError)) {
      if (operationError == nil) {
        operationError = DSHSessionStoreError(
            DSHSessionSnapshotStoreErrorInvalidArgument);
      }
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    NSDictionary *operation = request[@"operation"];
    NSData *candidateBytes = [request[@"candidate_json"]
        dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
    if (candidateBytes == nil || candidateBytes.length == 0 ||
        candidateBytes.length > DSHSessionSnapshotMaximumBytes) {
      operationError = DSHSessionStoreError(
          DSHSessionSnapshotStoreErrorBounds);
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    NSError *candidateError = nil;
    NSDictionary *candidate = DSHSessionParseObject(
        candidateBytes, DSHSessionSnapshotStoreErrorInvalidArgument,
        &candidateError);
    if (candidate == nil || !DSHSessionValidateSchema9Root(candidate)) {
      operationError = candidateError ?: DSHSessionStoreError(
          DSHSessionSnapshotStoreErrorInvalidArgument);
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    BOOL operationInCandidate = NO;
    for (NSDictionary *entry in candidate[@"workspace_authority_outbox"]) {
      if ([entry[@"operation_id"] isEqual:operation[@"operation_id"]]) {
        operationInCandidate = YES;
        if (![entry isEqual:operation]) {
          operationError = DSHSessionStoreError(
              DSHSessionSnapshotStoreErrorConflict);
          if (innerError != nullptr) *innerError = operationError;
          return NO;
        }
      }
    }
    if (!operationInCandidate ||
        DSHSessionCandidateReferencesWorkspace(candidate,
                                               operation[@"workspace_id"])) {
      operationError = DSHSessionStoreError(
          DSHSessionSnapshotStoreErrorConflict);
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }

    if (![self ensurePrivateRoot:&operationError]) {
      result = DSHSessionClearanceResult(@"unknown", nil);
      return YES;
    }
    int lockDescriptor = [self acquireCASLock:&operationError];
    if (lockDescriptor < 0) {
      result = DSHSessionClearanceResult(@"unknown", nil);
      return YES;
    }
    DSHLocalWorkspaceAuthorityMutationGuard *authorityGuard = nil;
    @try {
      // Fixed lock order: the session CAS lock is outermost, then the shared
      // workspace authority mutation guard. Keep both through proof, CAS,
      // second proof, receipt publication, and lost-response query.
      authorityGuard = [self.clearanceWorkspaceAccess
          acquireAuthorityMutationGuard:&operationError];
      if (authorityGuard == nil || self.clearanceStore == nil ||
          ![self.clearanceStore validateProjectDetachedForOperation:operation
              workspaceAccess:self.clearanceWorkspaceAccess
       authorityMutationGuard:authorityGuard error:nil]) {
        result = DSHSessionClearanceResult(@"not_committed", nil);
        return YES;
      }
      NSError *stateError = nil;
      DSHSessionLoadedState *state = [self readStateWithError:&stateError];
      if (state == nil) {
        // A failed read cannot prove the operation's current CAS or issue a
        // receipt. Preserve the recovery surface without projecting details.
        result = DSHSessionClearanceResult(@"unknown", nil);
        return YES;
      }
      NSString *operationId = operation[@"operation_id"];
      if (!state.missing && !state.legacy) {
        // A replayed operation is only idempotent while it still describes
        // the current authority. Once any later generation committed, the
        // old operation can no longer mint/return its generation-1 receipt.
        for (NSDictionary *commit in state.recentCommits) {
          if (![commit[@"operation_id"] isEqual:operationId]) continue;
          if ([commit[@"generation"] unsignedIntegerValue] != state.generation ||
              ![commit[@"session_sha256"] isEqual:state.sessionDigest]) {
            result = DSHSessionClearanceResult(@"not_committed", nil);
            return YES;
          }
          break;
        }
      }
      NSDictionary *casRequest = @{
        @"schema_version" : @1,
        @"operation_id" : operationId,
        @"expected" : state.authority,
        @"candidate_json" : request[@"candidate_json"],
      };
      NSDictionary *cas = [self casPersistSessionLocked:casRequest
                                          lockDescriptor:lockDescriptor
                                                    error:&stateError];
      if (cas == nil) {
        result = DSHSessionClearanceResult(@"unknown", nil);
        return YES;
      }
      NSString *casStatus = cas[@"status"];
      if (![casStatus isEqual:@"committed"]) {
        result = DSHSessionClearanceResult(
            [casStatus isEqual:@"unknown"] ? @"unknown" : @"not_committed", nil);
        return YES;
      }
      NSDictionary *snapshot = cas[@"snapshot"];
      NSUInteger generation = [snapshot[@"generation"] unsignedIntegerValue];
      NSString *digest = snapshot[@"session_sha256"];
      if (generation == 0 || !DSHSessionCanonicalDigest(digest) ||
          self.clearanceStore == nil) {
        result = DSHSessionClearanceResult(@"unknown", nil);
        return YES;
      }
      NSError *receiptError = nil;
      NSDictionary *receipt = [self.clearanceStore
          issueReceiptForOperation:operation
          committedSessionGeneration:generation
          committedSessionSHA256:digest
          lockDescriptor:lockDescriptor
          workspaceAccess:self.clearanceWorkspaceAccess
          authorityMutationGuard:authorityGuard
          error:&receiptError];
      if (receipt != nil) {
        result = DSHSessionClearanceResult(@"committed", receipt);
        return YES;
      }
      // A receipt may have committed even when its bridge response was lost
      // at the final verification checkpoint. Querying by the same operation
      // and session token recovers it without writing a second receipt.
      NSDictionary *recovered = [self.clearanceStore
          queryReceiptForOperationId:operationId
          currentSessionGeneration:generation
          currentSessionSHA256:digest
          lockDescriptor:lockDescriptor
          error:nil];
      if ([recovered[@"status"] isEqual:@"committed"] &&
          recovered[@"receipt"] != NSNull.null) {
        result = recovered;
      } else {
        result = DSHSessionClearanceResult(@"unknown", nil);
      }
      return YES;
    } @finally {
      authorityGuard = nil;
      close(lockDescriptor);
    }
  } error:error];
  if (!completed && error != nullptr && *error == nil) {
    *error = operationError ?: DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorStorage);
  }
  return result;
}

- (NSDictionary *)queryWorkspaceClearance:(NSDictionary *)request
                                     error:(NSError **)error {
  __block NSDictionary *result = nil;
  __block NSError *operationError = nil;
  BOOL completed = [self.coordinator performSyncWithError:^BOOL(NSError **innerError) {
    if (!DSHSessionTrustedDictionary(request) ||
        !DSHSessionExactKeys(request, @[@"schema_version", @"operation_id"]) ||
        !DSHSessionExactSchema(request[@"schema_version"], 1) ||
        !DSHSessionCanonicalOperationId(request[@"operation_id"])) {
      operationError = DSHSessionStoreError(
          DSHSessionSnapshotStoreErrorInvalidArgument);
      if (innerError != nullptr) *innerError = operationError;
      return NO;
    }
    if (self.clearanceStore == nil) {
      result = @{ @"schema_version" : @1, @"status" : @"unknown" };
      return YES;
    }
    NSError *stateError = nil;
    DSHSessionLoadedState *state = [self readStateWithError:&stateError];
    if (state == nil) {
      result = @{ @"schema_version" : @1, @"status" : @"unknown" };
      return YES;
    }
    if (state.missing || state.legacy) {
      result = @{ @"schema_version" : @1, @"status" : @"not_started" };
      return YES;
    }
    result = [self.clearanceStore
        queryReceiptForOperationId:request[@"operation_id"]
        currentSessionGeneration:state.generation
        currentSessionSHA256:state.sessionDigest
        error:nil];
    if ([result[@"status"] isEqual:@"not_started"]) {
      // A missing receipt is not provable absence once the session store has
      // durably observed this operation.  The session CAS may have committed
      // while receipt publication failed or was interrupted; preserve that
      // recovery surface as unknown instead of inviting a fresh operation.
      BOOL operationObserved = NO;
      for (NSDictionary *commit in state.recentCommits) {
        if ([commit[@"operation_id"] isEqual:request[@"operation_id"]]) {
          operationObserved = YES;
          break;
        }
      }
      if (!operationObserved) {
        for (NSDictionary *entry in state.session[@"workspace_authority_outbox"]) {
          if ([entry[@"operation_id"] isEqual:request[@"operation_id"]]) {
            operationObserved = YES;
            break;
          }
        }
      }
      if (operationObserved) {
        result = @{ @"schema_version" : @1, @"status" : @"unknown" };
      }
    }
    if (result == nil) {
      result = @{ @"schema_version" : @1, @"status" : @"unknown" };
    }
    return YES;
  } error:error];
  if (!completed && error != nullptr && *error == nil) {
    *error = operationError ?: DSHSessionStoreError(
        DSHSessionSnapshotStoreErrorStorage);
  }
  return result;
}

@end
