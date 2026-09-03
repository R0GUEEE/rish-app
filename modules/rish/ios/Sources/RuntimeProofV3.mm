#import "RuntimeProofV3.h"
#import "RishHarnessCatalog.h"

#import <CommonCrypto/CommonDigest.h>
#import <objc/runtime.h>

#include <stdint.h>
#include <string.h>

#define DSH_PROOF_V3_RETAIN \
  __attribute__((used, retain, visibility("default")))

DSH_PROOF_V3_RETAIN const NSInteger DSHRuntimeProofV3SchemaVersion = 3;
DSH_PROOF_V3_RETAIN const NSUInteger DSHRuntimeProofV3MaxIncludedEntries = 96;
DSH_PROOF_V3_RETAIN const NSUInteger DSHRuntimeProofV3MaxOmittedEntries = 5000;
DSH_PROOF_V3_RETAIN const NSUInteger DSHRuntimeProofV3MaxAttachments = 6;
DSH_PROOF_V3_RETAIN const NSUInteger DSHRuntimeProofV3MaxProviderRounds = 8;
DSH_PROOF_V3_RETAIN const NSUInteger DSHRuntimeProofV3MaxToolEvidenceEntries = 128;

DSH_PROOF_V3_RETAIN NSErrorDomain const DSHRuntimeProofV3ErrorDomain =
    @"dev.zseven.rish.runtime-proof-v3";

DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorExactKeys = @"E_PROOF_V3_EXACT_KEYS";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorSchema = @"E_PROOF_V3_SCHEMA";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorUntrustedContainer =
    @"E_PROOF_V3_UNTRUSTED_CONTAINER";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorIdentifier = @"E_PROOF_V3_IDENTIFIER";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorTimestamp = @"E_PROOF_V3_TIMESTAMP";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorDigest = @"E_PROOF_V3_DIGEST";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorText = @"E_PROOF_V3_TEXT";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorPath = @"E_PROOF_V3_PATH";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorNumber = @"E_PROOF_V3_NUMBER";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorOrder = @"E_PROOF_V3_ORDER";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorDuplicate = @"E_PROOF_V3_DUPLICATE";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorEnum = @"E_PROOF_V3_ENUM";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorBounds = @"E_PROOF_V3_BOUNDS";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorRelation = @"E_PROOF_V3_RELATION";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorAttestationDigest =
    @"E_PROOF_V3_ATTESTATION_DIGEST";
DSH_PROOF_V3_RETAIN NSString *const DSHRuntimeProofV3ErrorCanonicalization =
    @"E_PROOF_V3_CANONICALIZATION";

static const uint64_t DSHRuntimeProofV3MaximumJSONInteger =
    9007199254740991ULL;
static const uint64_t DSHRuntimeProofV3MaximumIncludedBytes = 512ULL * 1024;
static const uint64_t DSHRuntimeProofV3MaximumAttachmentBytes =
    32ULL * 1024 * 1024;
static const uint64_t DSHRuntimeProofV3MaximumToolResultBytes =
    32ULL * 1024 * 1024;
static const uint64_t DSHRuntimeProofV3MaximumDurationMilliseconds =
    24ULL * 60 * 60 * 1000;
static const NSUInteger DSHRuntimeProofV3MaximumJSONDepth = 8;
static const NSUInteger DSHRuntimeProofV3MaximumJSONNodes = 30000;

// CocoaPods links this static archive with -ObjC before the hosted XCTest
// bundle is loaded. Keeping a private Objective-C anchor in this object file
// ensures the pure C++ helpers are present in the host without coupling them
// to LocalRuntimeModule or adding a production call site.
@interface DSHRuntimeProofV3LinkAnchor : NSObject
@end

@implementation DSHRuntimeProofV3LinkAnchor
@end

static NSError *DSHProofV3Error(NSString *code) {
  return [NSError errorWithDomain:DSHRuntimeProofV3ErrorDomain
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey : code}];
}

static BOOL DSHProofV3Fail(NSError **error, NSString *code) {
  if (error != nil) *error = DSHProofV3Error(code);
  return NO;
}

static BOOL DSHProofV3ClassComesFromFoundation(id value) {
  if (value == nil) return NO;
  const char *image = class_getImageName(object_getClass(value));
  if (image == nullptr) return NO;
  return strstr(image, "/Foundation.framework/") != nullptr ||
      strstr(image, "/CoreFoundation.framework/") != nullptr ||
      strstr(image, "/libobjc.A.dylib") != nullptr;
}

static BOOL DSHProofV3TrustedDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] &&
      ![value isKindOfClass:NSMutableDictionary.class] &&
      DSHProofV3ClassComesFromFoundation(value);
}

static BOOL DSHProofV3TrustedArray(id value) {
  return [value isKindOfClass:NSArray.class] &&
      ![value isKindOfClass:NSMutableArray.class] &&
      DSHProofV3ClassComesFromFoundation(value);
}

static BOOL DSHProofV3TrustedString(id value) {
  if (![value isKindOfClass:NSString.class] ||
      !DSHProofV3ClassComesFromFoundation(value)) {
    return NO;
  }
  // NSMutableString and NSString share concrete CoreFoundation classes on
  // current Apple platforms. NSCopying is the supported mutability boundary:
  // immutable class-cluster strings return self; mutable strings do not.
  return [value copy] == value;
}

static BOOL DSHProofV3TrustedNumber(id value) {
  return [value isKindOfClass:NSNumber.class] &&
      DSHProofV3ClassComesFromFoundation(value);
}

typedef NS_ENUM(NSInteger, DSHProofV3TreeState) {
  DSHProofV3TreeStateValid = 0,
  DSHProofV3TreeStateUntrusted = 1,
  DSHProofV3TreeStateBounds = 2,
};

static DSHProofV3TreeState DSHProofV3TrustedJSONTree(
    id value,
    NSUInteger depth,
    NSUInteger *nodes) {
  if (depth > DSHRuntimeProofV3MaximumJSONDepth ||
      *nodes >= DSHRuntimeProofV3MaximumJSONNodes) {
    return DSHProofV3TreeStateBounds;
  }
  *nodes += 1;
  if (value == NSNull.null) return DSHProofV3TreeStateValid;
  if ([value isKindOfClass:NSDictionary.class]) {
    if (!DSHProofV3TrustedDictionary(value)) {
      return DSHProofV3TreeStateUntrusted;
    }
    NSDictionary *dictionary = value;
    if (dictionary.count > DSHRuntimeProofV3MaximumJSONNodes - *nodes) {
      return DSHProofV3TreeStateBounds;
    }
    for (id key in dictionary.allKeys) {
      if (!DSHProofV3TrustedString(key)) {
        return DSHProofV3TreeStateUntrusted;
      }
      DSHProofV3TreeState state = DSHProofV3TrustedJSONTree(
          dictionary[key], depth + 1, nodes);
      if (state != DSHProofV3TreeStateValid) {
        return state;
      }
    }
    return DSHProofV3TreeStateValid;
  }
  if ([value isKindOfClass:NSArray.class]) {
    if (!DSHProofV3TrustedArray(value)) {
      return DSHProofV3TreeStateUntrusted;
    }
    NSArray *array = value;
    if (array.count > DSHRuntimeProofV3MaximumJSONNodes - *nodes) {
      return DSHProofV3TreeStateBounds;
    }
    for (id item in array) {
      DSHProofV3TreeState state = DSHProofV3TrustedJSONTree(
          item, depth + 1, nodes);
      if (state != DSHProofV3TreeStateValid) return state;
    }
    return DSHProofV3TreeStateValid;
  }
  if ([value isKindOfClass:NSString.class]) {
    return DSHProofV3TrustedString(value)
        ? DSHProofV3TreeStateValid : DSHProofV3TreeStateUntrusted;
  }
  if ([value isKindOfClass:NSNumber.class]) {
    return DSHProofV3TrustedNumber(value)
        ? DSHProofV3TreeStateValid : DSHProofV3TreeStateUntrusted;
  }
  return DSHProofV3TreeStateUntrusted;
}

static BOOL DSHProofV3PreflightTrustedJSONTree(id value, NSError **error) {
  NSUInteger nodes = 0;
  DSHProofV3TreeState state =
      DSHProofV3TrustedJSONTree(value, 0, &nodes);
  if (state == DSHProofV3TreeStateValid) return YES;
  return DSHProofV3Fail(
      error, state == DSHProofV3TreeStateBounds
          ? DSHRuntimeProofV3ErrorBounds
          : DSHRuntimeProofV3ErrorUntrustedContainer);
}

static BOOL DSHProofV3ExactKeys(NSDictionary *dictionary,
                                NSArray<NSString *> *keys,
                                NSError **error) {
  if (!DSHProofV3TrustedDictionary(dictionary)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorUntrustedContainer);
  }
  if (dictionary.count != keys.count) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorExactKeys);
  }
  NSSet<NSString *> *expected = [NSSet setWithArray:keys];
  for (id key in dictionary.allKeys) {
    if (!DSHProofV3TrustedString(key)) {
      return DSHProofV3Fail(error,
                            DSHRuntimeProofV3ErrorUntrustedContainer);
    }
    if (![expected containsObject:key]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorExactKeys);
    }
  }
  return YES;
}

static BOOL DSHProofV3StrictBoolean(id value) {
  return DSHProofV3TrustedNumber(value) &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL DSHProofV3UnsignedInteger(id value, uint64_t maximum,
                                      NSUInteger *result) {
  if (!DSHProofV3TrustedNumber(value) || DSHProofV3StrictBoolean(value)) {
    return NO;
  }
  const char *encoding = [value objCType];
  if (encoding == nullptr || encoding[0] == '\0') return NO;
  uint64_t number = 0;
  switch (encoding[0]) {
    case 'c':
    case 's':
    case 'i':
    case 'l':
    case 'q': {
      long long signedNumber = [value longLongValue];
      if (signedNumber < 0) return NO;
      number = static_cast<uint64_t>(signedNumber);
      break;
    }
    case 'C':
    case 'S':
    case 'I':
    case 'L':
    case 'Q':
      number = [value unsignedLongLongValue];
      break;
    default:
      // Floating-point and NSDecimalNumber storage are rejected even when
      // conversion to double would round a fractional value to an integer.
      return NO;
  }
  if (number > DSHRuntimeProofV3MaximumJSONInteger || number > maximum) {
    return NO;
  }
  if (result != nullptr) *result = static_cast<NSUInteger>(number);
  return YES;
}

static BOOL DSHProofV3StringHasNoControls(NSString *value) {
  return [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet]
             .location == NSNotFound;
}

static BOOL DSHProofV3BoundedText(id value, NSUInteger maximumBytes) {
  if (!DSHProofV3TrustedString(value)) return NO;
  NSString *text = value;
  NSUInteger bytes = [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  return text.length > 0 && bytes > 0 && bytes <= maximumBytes &&
      DSHProofV3StringHasNoControls(text) &&
      [text isEqualToString:text.precomposedStringWithCanonicalMapping];
}

static BOOL DSHProofV3CharactersAreAllowed(NSString *value,
                                           NSString *allowedCharacters) {
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:allowedCharacters] invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHProofV3CanonicalUUID(id value) {
  if (!DSHProofV3TrustedString(value)) return NO;
  NSString *identifier = value;
  if (identifier.length != 36 ||
      ![identifier isEqualToString:identifier.lowercaseString]) {
    return NO;
  }
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:identifier];
  return uuid != nil &&
      [uuid.UUIDString.lowercaseString isEqualToString:identifier];
}

static BOOL DSHProofV3OpaqueIdentifier(id value) {
  return DSHProofV3BoundedText(value, 128) &&
      DSHProofV3CharactersAreAllowed(
          value,
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-");
}

static BOOL DSHProofV3SHA256(id value) {
  if (!DSHProofV3TrustedString(value)) return NO;
  NSString *digest = value;
  return digest.length == 64 && DSHProofV3CharactersAreAllowed(
      digest, @"0123456789abcdef");
}

static BOOL DSHProofV3GitOID(id value) {
  if (!DSHProofV3TrustedString(value)) return NO;
  NSString *digest = value;
  return (digest.length == 40 || digest.length == 64) &&
      DSHProofV3CharactersAreAllowed(digest, @"0123456789abcdef");
}

static BOOL DSHProofV3Timestamp(id value) {
  if (!DSHProofV3TrustedString(value)) return NO;
  NSString *timestamp = value;
  if (timestamp.length != 24) return NO;
  static NSRegularExpression *shape = nil;
  static NSDateFormatter *formatter = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    shape = [NSRegularExpression
        regularExpressionWithPattern:
            @"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
                              options:0
                                error:nil];
    formatter = [[NSDateFormatter alloc] init];
    formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
    formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
    formatter.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";
    formatter.lenient = NO;
  });
  NSRange full = NSMakeRange(0, timestamp.length);
  if ([shape numberOfMatchesInString:timestamp options:0 range:full] != 1) {
    return NO;
  }
  NSDate *date = [formatter dateFromString:timestamp];
  return date != nil && [[formatter stringFromDate:date] isEqualToString:timestamp];
}

static BOOL DSHProofV3ProviderHost(id value) {
  if (!DSHProofV3BoundedText(value, 253)) return NO;
  NSString *host = value;
  if (![host isEqualToString:host.lowercaseString] ||
      [host hasPrefix:@"."] || [host hasSuffix:@"."] ||
      [host containsString:@".."] || ![host containsString:@"."]) {
    return NO;
  }
  NSArray<NSString *> *labels = [host componentsSeparatedByString:@"."];
  for (NSString *label in labels) {
    if (label.length == 0 || label.length > 63 || [label hasPrefix:@"-"] ||
        [label hasSuffix:@"-"] ||
        !DSHProofV3CharactersAreAllowed(
            label, @"abcdefghijklmnopqrstuvwxyz0123456789-")) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHProofV3GitBranch(id value) {
  if (!DSHProofV3BoundedText(value, 1024)) return NO;
  NSString *branch = value;
  NSCharacterSet *invalidCharacters =
      [NSCharacterSet characterSetWithCharactersInString:@" ~^:?*[\\"];
  if ([branch hasPrefix:@"/"] || [branch hasSuffix:@"/"] ||
      [branch hasSuffix:@"."] || [branch containsString:@"//"] ||
      [branch containsString:@".."] || [branch containsString:@"@{"] ||
      [branch isEqualToString:@"@"] ||
      [branch rangeOfCharacterFromSet:invalidCharacters].location !=
          NSNotFound) {
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

static BOOL DSHProofV3RelativePath(id value) {
  if (!DSHProofV3BoundedText(value, 4096)) return NO;
  NSString *path = value;
  if ([path hasPrefix:@"/"] || [path hasSuffix:@"/"] ||
      [path containsString:@"\\"] || [path containsString:@"//"] ||
      [path hasPrefix:@"~"] || [path containsString:@":"]) {
    return NO;
  }
  NSArray<NSString *> *components = [path componentsSeparatedByString:@"/"];
  for (NSString *component in components) {
    if (component.length == 0 || [component isEqualToString:@"."] ||
        [component isEqualToString:@".."]) {
      return NO;
    }
  }
  return YES;
}

static NSComparisonResult DSHProofV3Compare(NSString *left,
                                            NSString *right) {
  return [left compare:right options:NSLiteralSearch];
}

static BOOL DSHProofV3Enum(id value, NSSet<NSString *> *allowed) {
  return DSHProofV3TrustedString(value) && [allowed containsObject:value];
}

static BOOL DSHProofV3FailureCode(id value) {
  return DSHProofV3BoundedText(value, 64) && [value hasPrefix:@"E_"] &&
      DSHProofV3CharactersAreAllowed(value, @"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_");
}

static BOOL DSHProofV3MediaType(id value) {
  if (!DSHProofV3BoundedText(value, 127)) return NO;
  NSString *mediaType = value;
  if (![mediaType isEqualToString:mediaType.lowercaseString]) return NO;
  NSArray<NSString *> *parts = [mediaType componentsSeparatedByString:@"/"];
  if (parts.count != 2) return NO;
  NSString *allowed = @"abcdefghijklmnopqrstuvwxyz0123456789!#$&^_.+-";
  return [parts[0] length] > 0 && [parts[1] length] > 0 &&
      DSHProofV3CharactersAreAllowed(parts[0], allowed) &&
      DSHProofV3CharactersAreAllowed(parts[1], allowed);
}

static NSData *DSHProofV3CanonicalJSON(id value, NSError **error) {
  if (![NSJSONSerialization isValidJSONObject:value]) {
    if (error != nil) {
      *error = DSHProofV3Error(DSHRuntimeProofV3ErrorCanonicalization);
    }
    return nil;
  }
  NSError *jsonError = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                  options:NSJSONWritingSortedKeys
                                                    error:&jsonError];
  if (data == nil) {
    if (error != nil) {
      *error = DSHProofV3Error(DSHRuntimeProofV3ErrorCanonicalization);
    }
    return nil;
  }
  return [data copy];
}

static id DSHProofV3ImmutableDeepCopy(id value, NSError **error) {
  NSData *data = DSHProofV3CanonicalJSON(value, error);
  if (data == nil) return nil;
  NSError *jsonError = nil;
  id copy = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
  if (copy == nil) {
    if (error != nil) {
      *error = DSHProofV3Error(DSHRuntimeProofV3ErrorCanonicalization);
    }
    return nil;
  }
  return copy;
}

DSH_PROOF_V3_RETAIN NSString *DSHRuntimeProofV3SHA256Hex(NSData *data) {
  if (![data isKindOfClass:NSData.class] ||
      !DSHProofV3ClassComesFromFoundation(data) || [data copy] != data ||
      data.length > UINT32_MAX) {
    return nil;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, static_cast<CC_LONG>(data.length), digest);
  NSMutableString *hex =
      [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return [hex copy];
}

static BOOL DSHProofV3ConstantTimeDigestEqual(NSString *left,
                                              NSString *right) {
  if (left.length != 64 || right.length != 64) return NO;
  const char *leftBytes = left.UTF8String;
  const char *rightBytes = right.UTF8String;
  if (leftBytes == nullptr || rightBytes == nullptr) return NO;
  unsigned char difference = 0;
  for (NSUInteger index = 0; index < 64; index += 1) {
    difference |= (unsigned char)(leftBytes[index] ^ rightBytes[index]);
  }
  return difference == 0;
}

static BOOL DSHProofV3ValidateIncluded(NSArray *entries,
                                       NSMutableSet<NSString *> *pairs,
                                       NSError **error) {
  if (!DSHProofV3TrustedArray(entries)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorUntrustedContainer);
  }
  if (entries.count > DSHRuntimeProofV3MaxIncludedEntries) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorBounds);
  }
  NSSet *sources = [NSSet setWithArray:
      @[ @"tracked_file", @"staged_diff", @"worktree_diff" ]];
  NSString *previousPath = nil;
  NSString *previousSource = nil;
  for (id value in entries) {
    NSArray *keys = @[ @"relative_path", @"sha256", @"bytes", @"source" ];
    if (!DSHProofV3ExactKeys(value, keys, error)) return NO;
    NSDictionary *entry = value;
    NSString *path = entry[@"relative_path"];
    NSString *source = entry[@"source"];
    if (!DSHProofV3RelativePath(path)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorPath);
    }
    if (!DSHProofV3SHA256(entry[@"sha256"])) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDigest);
    }
    if (!DSHProofV3UnsignedInteger(entry[@"bytes"],
                                   DSHRuntimeProofV3MaximumIncludedBytes,
                                   nullptr)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorNumber);
    }
    if (!DSHProofV3Enum(source, sources)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
    }
    NSString *pair = [NSString stringWithFormat:@"%@\u001f%@", path, source];
    if ([pairs containsObject:pair]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDuplicate);
    }
    [pairs addObject:pair];
    if (previousPath != nil) {
      NSComparisonResult pathOrder = DSHProofV3Compare(previousPath, path);
      NSComparisonResult sourceOrder = DSHProofV3Compare(previousSource, source);
      if (pathOrder == NSOrderedDescending ||
          (pathOrder == NSOrderedSame && sourceOrder != NSOrderedAscending)) {
        return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorOrder);
      }
    }
    previousPath = path;
    previousSource = source;
  }
  return YES;
}

static BOOL DSHProofV3ValidateOmitted(NSArray *entries,
                                      NSSet<NSString *> *includedPairs,
                                      NSError **error) {
  if (!DSHProofV3TrustedArray(entries)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorUntrustedContainer);
  }
  if (entries.count > DSHRuntimeProofV3MaxOmittedEntries) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorBounds);
  }
  NSSet *sources = [NSSet setWithArray:@[
    @"selection", @"tracked_file", @"staged_diff", @"worktree_diff",
  ]];
  NSSet *reasons = [NSSet setWithArray:@[
    @"secret_path", @"generated", @"lockfile", @"suspected_secret",
    @"binary", @"invalid_encoding", @"not_tracked", @"budget_exceeded",
    @"policy",
  ]];
  NSMutableSet<NSString *> *triples = [NSMutableSet set];
  NSString *previousPath = nil;
  NSString *previousSource = nil;
  NSString *previousReason = nil;
  for (id value in entries) {
    NSArray *keys = @[ @"relative_path", @"source", @"reason" ];
    if (!DSHProofV3ExactKeys(value, keys, error)) return NO;
    NSDictionary *entry = value;
    NSString *path = entry[@"relative_path"];
    NSString *source = entry[@"source"];
    NSString *reason = entry[@"reason"];
    if (!DSHProofV3RelativePath(path)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorPath);
    }
    if (!DSHProofV3Enum(source, sources) ||
        !DSHProofV3Enum(reason, reasons)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
    }
    NSString *pair = [NSString stringWithFormat:@"%@\u001f%@", path, source];
    NSString *triple = [NSString stringWithFormat:@"%@\u001f%@\u001f%@",
                        path, source, reason];
    if ([triples containsObject:triple]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDuplicate);
    }
    if ([includedPairs containsObject:pair]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
    }
    [triples addObject:triple];
    if (previousPath != nil) {
      NSComparisonResult pathOrder = DSHProofV3Compare(previousPath, path);
      NSComparisonResult sourceOrder = DSHProofV3Compare(previousSource, source);
      NSComparisonResult reasonOrder = DSHProofV3Compare(previousReason, reason);
      BOOL invalid = pathOrder == NSOrderedDescending ||
          (pathOrder == NSOrderedSame && sourceOrder == NSOrderedDescending) ||
          (pathOrder == NSOrderedSame && sourceOrder == NSOrderedSame &&
           reasonOrder != NSOrderedAscending);
      if (invalid) {
        return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorOrder);
      }
    }
    previousPath = path;
    previousSource = source;
    previousReason = reason;
  }
  return YES;
}

static BOOL DSHProofV3ValidateAttachments(NSArray *entries, NSError **error) {
  if (!DSHProofV3TrustedArray(entries)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorUntrustedContainer);
  }
  if (entries.count > DSHRuntimeProofV3MaxAttachments) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorBounds);
  }
  NSMutableSet<NSString *> *identifiers = [NSMutableSet set];
  NSString *previous = nil;
  for (id value in entries) {
    NSArray *keys = @[ @"opaque_id_sha256", @"sha256", @"bytes",
                       @"media_type" ];
    if (!DSHProofV3ExactKeys(value, keys, error)) return NO;
    NSDictionary *entry = value;
    NSString *identifier = entry[@"opaque_id_sha256"];
    if (!DSHProofV3SHA256(identifier) || !DSHProofV3SHA256(entry[@"sha256"])) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDigest);
    }
    if (!DSHProofV3UnsignedInteger(entry[@"bytes"],
                                   DSHRuntimeProofV3MaximumAttachmentBytes,
                                   nullptr)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorNumber);
    }
    if (!DSHProofV3MediaType(entry[@"media_type"])) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorText);
    }
    if ([identifiers containsObject:identifier]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDuplicate);
    }
    [identifiers addObject:identifier];
    if (previous != nil && DSHProofV3Compare(previous, identifier) !=
                               NSOrderedAscending) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorOrder);
    }
    previous = identifier;
  }
  return YES;
}

static BOOL DSHProofV3ValidateRounds(NSArray *entries, NSError **error) {
  if (!DSHProofV3TrustedArray(entries)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorUntrustedContainer);
  }
  if (entries.count == 0 ||
      entries.count > DSHRuntimeProofV3MaxProviderRounds) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorBounds);
  }
  NSSet *outcomes =
      [NSSet setWithArray:@[ @"succeeded", @"failed", @"cancelled" ]];
  NSSet *finishReasons = [NSSet setWithArray:
      @[ @"stop", @"tool_calls", @"length", @"content_filter" ]];
  NSMutableSet<NSString *> *roundIdentifiers = [NSMutableSet set];
  NSMutableSet<NSString *> *requestIdentifiers = [NSMutableSet set];
  NSMutableSet<NSString *> *responseIdentifiers = [NSMutableSet set];
  for (NSUInteger index = 0; index < entries.count; index += 1) {
    id value = entries[index];
    NSMutableArray *keys = [@[
      @"round_id", @"provider_request_id", @"provider_response_id",
      @"round_index", @"model_input_sha256", @"request_body_sha256",
      @"finish_reason", @"outcome",
    ] mutableCopy];
    // Rounds minted after the Harness split name the Harness that produced
    // the model response; pre-split rounds omit the key and mean DSH.
    BOOL namesHarness = [value isKindOfClass:NSDictionary.class] &&
        ((NSDictionary *)value)[@"harness_id"] != nil;
    if (namesHarness) [keys addObject:@"harness_id"];
    if (!DSHProofV3ExactKeys(value, keys, error)) return NO;
    NSDictionary *entry = value;
    if (namesHarness &&
        !DSHProofV3Enum(entry[@"harness_id"], DSHHarnessSupportedHarnessIds())) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
    }
    NSString *roundId = entry[@"round_id"];
    NSString *requestId = entry[@"provider_request_id"];
    NSUInteger roundIndex = NSNotFound;
    if (!DSHProofV3CanonicalUUID(roundId) ||
        !DSHProofV3CanonicalUUID(requestId)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorIdentifier);
    }
    if ([roundIdentifiers containsObject:roundId] ||
        [requestIdentifiers containsObject:requestId]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDuplicate);
    }
    [roundIdentifiers addObject:roundId];
    [requestIdentifiers addObject:requestId];
    if (!DSHProofV3UnsignedInteger(entry[@"round_index"],
                                   DSHRuntimeProofV3MaxProviderRounds - 1,
                                   &roundIndex)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorNumber);
    }
    if (roundIndex != index) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorOrder);
    }
    if (!DSHProofV3SHA256(entry[@"model_input_sha256"]) ||
        !DSHProofV3SHA256(entry[@"request_body_sha256"])) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDigest);
    }
    NSString *outcome = entry[@"outcome"];
    if (!DSHProofV3Enum(outcome, outcomes)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
    }
    id responseId = entry[@"provider_response_id"];
    id finishReason = entry[@"finish_reason"];
    if ([outcome isEqualToString:@"succeeded"]) {
      if (responseId == NSNull.null || finishReason == NSNull.null) {
        return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
      }
      if (!DSHProofV3OpaqueIdentifier(responseId)) {
        return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorIdentifier);
      }
      if (!DSHProofV3Enum(finishReason, finishReasons)) {
        return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
      }
      if ([responseIdentifiers containsObject:responseId]) {
        return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDuplicate);
      }
      [responseIdentifiers addObject:responseId];
    } else if (responseId != NSNull.null || finishReason != NSNull.null) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
    }
  }
  return YES;
}

static BOOL DSHProofV3ValidateTools(NSArray *entries, NSUInteger roundCount,
                                    NSError **error) {
  if (!DSHProofV3TrustedArray(entries)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorUntrustedContainer);
  }
  if (entries.count > DSHRuntimeProofV3MaxToolEvidenceEntries) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorBounds);
  }
  NSSet *outcomes =
      [NSSet setWithArray:@[ @"ok", @"failed", @"denied", @"cancelled" ]];
  NSMutableSet<NSString *> *callIdentifiers = [NSMutableSet set];
  NSMutableSet<NSString *> *positions = [NSMutableSet set];
  NSUInteger previousRound = NSNotFound;
  NSUInteger expectedCall = 0;
  for (id value in entries) {
    NSArray *keys = @[
      @"call_id", @"round_index", @"call_index", @"name",
      @"arguments_sha256", @"result_sha256", @"result_bytes",
      @"duration_ms", @"outcome", @"failure_code", @"approval_reference",
    ];
    if (!DSHProofV3ExactKeys(value, keys, error)) return NO;
    NSDictionary *entry = value;
    NSString *callId = entry[@"call_id"];
    NSUInteger roundIndex = NSNotFound;
    NSUInteger callIndex = NSNotFound;
    if (!DSHProofV3OpaqueIdentifier(callId)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorIdentifier);
    }
    if (!DSHProofV3UnsignedInteger(entry[@"round_index"], roundCount - 1,
                                   &roundIndex) ||
        !DSHProofV3UnsignedInteger(entry[@"call_index"], 15, &callIndex)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorNumber);
    }
    NSString *position = [NSString stringWithFormat:@"%lu:%lu",
                          (unsigned long)roundIndex, (unsigned long)callIndex];
    if ([callIdentifiers containsObject:callId] ||
        [positions containsObject:position]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDuplicate);
    }
    [callIdentifiers addObject:callId];
    [positions addObject:position];
    if (previousRound == NSNotFound || roundIndex != previousRound) {
      if (previousRound != NSNotFound && roundIndex <= previousRound) {
        return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorOrder);
      }
      expectedCall = 0;
      previousRound = roundIndex;
    }
    if (callIndex != expectedCall) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorOrder);
    }
    expectedCall += 1;
    if (!DSHProofV3BoundedText(entry[@"name"], 64) ||
        !DSHProofV3CharactersAreAllowed(
            entry[@"name"],
            @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorText);
    }
    if (!DSHProofV3SHA256(entry[@"arguments_sha256"]) ||
        !DSHProofV3SHA256(entry[@"result_sha256"])) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDigest);
    }
    if (!DSHProofV3UnsignedInteger(entry[@"result_bytes"],
                                   DSHRuntimeProofV3MaximumToolResultBytes,
                                   nullptr) ||
        !DSHProofV3UnsignedInteger(entry[@"duration_ms"],
                                   DSHRuntimeProofV3MaximumDurationMilliseconds,
                                   nullptr)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorNumber);
    }
    NSString *outcome = entry[@"outcome"];
    if (!DSHProofV3Enum(outcome, outcomes)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
    }
    id failureCode = entry[@"failure_code"];
    BOOL successful = [outcome isEqualToString:@"ok"];
    if ((successful && failureCode != NSNull.null) ||
        (!successful && !DSHProofV3FailureCode(failureCode))) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
    }
    id approval = entry[@"approval_reference"];
    if (approval != NSNull.null && !DSHProofV3CanonicalUUID(approval)) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorIdentifier);
    }
  }
  return YES;
}

static BOOL DSHProofV3ValidateAttestation(NSDictionary *attestation,
                                          NSError **error) {
  NSArray *keys = @[
    @"attested_at", @"turn_id", @"attempt_id",
    @"conversation_id_sha256", @"project_id", @"snapshot_id",
    @"consent_receipt_id", @"policy_version", @"provider_host", @"model",
    @"thinking_mode", @"branch", @"head_oid", @"included", @"omitted",
    @"snapshot_sha256", @"visible_history_sha256", @"model_input_sha256",
    @"request_body_sha256", @"attachments", @"assistant_text_sha256",
    @"reasoning_text_sha256", @"finish_reason", @"provider_response_id",
    @"provider_rounds", @"agent_tool_evidence", @"outcome",
  ];
  if (!DSHProofV3ExactKeys(attestation, keys, error)) return NO;
  if (!DSHProofV3Timestamp(attestation[@"attested_at"])) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorTimestamp);
  }
  for (NSString *key in @[
         @"turn_id", @"attempt_id", @"project_id", @"snapshot_id",
         @"consent_receipt_id",
       ]) {
    if (!DSHProofV3CanonicalUUID(attestation[key])) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorIdentifier);
    }
  }
  for (NSString *key in @[
         @"conversation_id_sha256", @"snapshot_sha256",
         @"visible_history_sha256", @"model_input_sha256",
         @"request_body_sha256", @"assistant_text_sha256",
         @"reasoning_text_sha256",
       ]) {
    if (!DSHProofV3SHA256(attestation[key])) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDigest);
    }
  }
  if (!DSHProofV3BoundedText(attestation[@"policy_version"], 64) ||
      !DSHProofV3CharactersAreAllowed(
          attestation[@"policy_version"],
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-") ||
      !DSHProofV3ProviderHost(attestation[@"provider_host"])) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorText);
  }
  NSSet *models = DSHHarnessSupportedModels();
  NSSet *thinkingModes = [NSSet setWithArray:@[ @"off", @"high", @"max" ]];
  if (!DSHProofV3BoundedText(attestation[@"model"], 256) ||
      !DSHProofV3BoundedText(attestation[@"thinking_mode"], 16)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorText);
  }
  if (!DSHProofV3Enum(attestation[@"model"], models) ||
      !DSHProofV3Enum(attestation[@"thinking_mode"], thinkingModes)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
  }
  id branch = attestation[@"branch"];
  if (branch != NSNull.null && !DSHProofV3GitBranch(branch)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorText);
  }
  id headOID = attestation[@"head_oid"];
  if (headOID != NSNull.null && !DSHProofV3GitOID(headOID)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorDigest);
  }
  NSMutableSet<NSString *> *includedPairs = [NSMutableSet set];
  if (!DSHProofV3ValidateIncluded(attestation[@"included"], includedPairs,
                                  error) ||
      !DSHProofV3ValidateOmitted(attestation[@"omitted"], includedPairs,
                                 error) ||
      !DSHProofV3ValidateAttachments(attestation[@"attachments"], error) ||
      !DSHProofV3ValidateRounds(attestation[@"provider_rounds"], error)) {
    return NO;
  }
  NSArray *rounds = attestation[@"provider_rounds"];
  if (!DSHProofV3ValidateTools(attestation[@"agent_tool_evidence"],
                               rounds.count, error)) {
    return NO;
  }
  NSSet *outcomes =
      [NSSet setWithArray:@[ @"completed", @"failed", @"cancelled" ]];
  NSString *outcome = attestation[@"outcome"];
  if (!DSHProofV3Enum(outcome, outcomes)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
  }
  id finishReason = attestation[@"finish_reason"];
  id responseId = attestation[@"provider_response_id"];
  NSSet *finishReasons = [NSSet setWithArray:
      @[ @"stop", @"tool_calls", @"length", @"content_filter" ]];
  if ((finishReason == NSNull.null) != (responseId == NSNull.null)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
  }
  if (responseId != NSNull.null && !DSHProofV3OpaqueIdentifier(responseId)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorIdentifier);
  }
  if (finishReason != NSNull.null &&
      !DSHProofV3Enum(finishReason, finishReasons)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorEnum);
  }
  return YES;
}

static BOOL DSHProofV3ValidateAttestationRelations(
    NSDictionary *attestation,
    NSError **error) {
  NSArray *rounds = attestation[@"provider_rounds"];
  NSDictionary *lastRound = rounds.lastObject;
  if (![lastRound[@"model_input_sha256"]
          isEqualToString:attestation[@"model_input_sha256"]] ||
      ![lastRound[@"request_body_sha256"]
          isEqualToString:attestation[@"request_body_sha256"]] ||
      ![lastRound[@"provider_response_id"]
          isEqual:attestation[@"provider_response_id"]] ||
      ![lastRound[@"finish_reason"] isEqual:attestation[@"finish_reason"]]) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
  }
  for (NSUInteger index = 0; index + 1 < rounds.count; index += 1) {
    NSDictionary *round = rounds[index];
    if (![round[@"outcome"] isEqualToString:@"succeeded"] ||
        ![round[@"finish_reason"] isEqualToString:@"tool_calls"]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
    }
  }
  NSMutableIndexSet *roundsWithToolEvidence = [NSMutableIndexSet indexSet];
  for (NSDictionary *tool in attestation[@"agent_tool_evidence"]) {
    NSUInteger roundIndex = [tool[@"round_index"] unsignedIntegerValue];
    NSDictionary *round = rounds[roundIndex];
    if (![round[@"outcome"] isEqualToString:@"succeeded"] ||
        ![round[@"finish_reason"] isEqualToString:@"tool_calls"]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
    }
    [roundsWithToolEvidence addIndex:roundIndex];
  }
  for (NSUInteger index = 0; index < rounds.count; index += 1) {
    NSDictionary *round = rounds[index];
    BOOL expectsTools = [round[@"outcome"] isEqualToString:@"succeeded"] &&
        [round[@"finish_reason"] isEqualToString:@"tool_calls"];
    if (expectsTools != [roundsWithToolEvidence containsIndex:index]) {
      return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
    }
  }
  NSString *outcome = attestation[@"outcome"];
  if ([outcome isEqualToString:@"completed"] &&
      (![lastRound[@"outcome"] isEqualToString:@"succeeded"] ||
       [lastRound[@"finish_reason"] isEqualToString:@"tool_calls"])) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
  }
  return YES;
}

static BOOL DSHProofV3ValidateDiagnostics(NSDictionary *diagnostics,
                                          NSString *attestedAt,
                                          NSError **error) {
  NSArray *keys = @[ @"schema_version", @"updated_at" ];
  if (!DSHProofV3ExactKeys(diagnostics, keys, error)) return NO;
  NSUInteger schema = NSNotFound;
  if (!DSHProofV3UnsignedInteger(diagnostics[@"schema_version"], 1, &schema) ||
      schema != 1) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorSchema);
  }
  NSString *updatedAt = diagnostics[@"updated_at"];
  if (!DSHProofV3Timestamp(updatedAt)) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorTimestamp);
  }
  if (DSHProofV3Compare(updatedAt, attestedAt) == NSOrderedAscending) {
    return DSHProofV3Fail(error, DSHRuntimeProofV3ErrorRelation);
  }
  return YES;
}

static NSString *DSHProofV3DigestForAttestation(NSDictionary *attestation,
                                                NSError **error) {
  NSData *data = DSHProofV3CanonicalJSON(attestation, error);
  return data == nil ? nil : DSHRuntimeProofV3SHA256Hex(data);
}

DSH_PROOF_V3_RETAIN NSDictionary<NSString *, id> *DSHBuildRuntimeProofV3(
    NSDictionary<NSString *, id> *attestation,
    NSError **error) {
  if (error != nil) *error = nil;
  if (!DSHProofV3PreflightTrustedJSONTree(attestation, error)) return nil;
  if (!DSHProofV3ValidateAttestation(attestation, error)) return nil;
  if (!DSHProofV3ValidateAttestationRelations(attestation, error)) return nil;
  NSDictionary *attestationCopy = DSHProofV3ImmutableDeepCopy(attestation, error);
  if (attestationCopy == nil) return nil;
  NSString *digest = DSHProofV3DigestForAttestation(attestationCopy, error);
  if (digest == nil) return nil;
  NSDictionary *root = @{
    @"schema_version" : @(DSHRuntimeProofV3SchemaVersion),
    @"attestation" : attestationCopy,
    @"attestation_sha256" : digest,
    @"diagnostics" : @{
      @"schema_version" : @1,
      @"updated_at" : attestationCopy[@"attested_at"],
    },
  };
  return DSHProofV3ImmutableDeepCopy(root, error);
}

DSH_PROOF_V3_RETAIN NSDictionary<NSString *, id> *DSHValidateRuntimeProofV3(
    id proof,
    NSError **error) {
  if (error != nil) *error = nil;
  if (!DSHProofV3PreflightTrustedJSONTree(proof, error)) return nil;
  NSArray *keys = @[
    @"schema_version", @"attestation", @"attestation_sha256", @"diagnostics",
  ];
  if (!DSHProofV3ExactKeys(proof, keys, error)) return nil;
  NSDictionary *root = proof;
  NSUInteger schema = NSNotFound;
  if (!DSHProofV3UnsignedInteger(root[@"schema_version"],
                                 DSHRuntimeProofV3SchemaVersion, &schema) ||
      schema != (NSUInteger)DSHRuntimeProofV3SchemaVersion) {
    if (error != nil) *error = DSHProofV3Error(DSHRuntimeProofV3ErrorSchema);
    return nil;
  }
  NSDictionary *attestation = root[@"attestation"];
  if (!DSHProofV3ValidateAttestation(attestation, error)) return nil;
  if (!DSHProofV3ValidateDiagnostics(root[@"diagnostics"],
                                     attestation[@"attested_at"], error)) {
    return nil;
  }
  NSString *providedDigest = root[@"attestation_sha256"];
  if (!DSHProofV3SHA256(providedDigest)) {
    if (error != nil) *error = DSHProofV3Error(DSHRuntimeProofV3ErrorDigest);
    return nil;
  }
  NSString *expectedDigest = DSHProofV3DigestForAttestation(attestation, error);
  if (expectedDigest == nil) return nil;
  if (!DSHProofV3ConstantTimeDigestEqual(providedDigest, expectedDigest)) {
    if (error != nil) {
      *error = DSHProofV3Error(DSHRuntimeProofV3ErrorAttestationDigest);
    }
    return nil;
  }
  if (!DSHProofV3ValidateAttestationRelations(attestation, error)) return nil;
  return DSHProofV3ImmutableDeepCopy(root, error);
}

DSH_PROOF_V3_RETAIN NSData *DSHCanonicalRuntimeProofV3Data(id proof, NSError **error) {
  NSDictionary *validated = DSHValidateRuntimeProofV3(proof, error);
  return validated == nil ? nil : DSHProofV3CanonicalJSON(validated, error);
}

DSH_PROOF_V3_RETAIN NSString *DSHRuntimeProofV3AttestationSHA256(id proof, NSError **error) {
  NSDictionary *validated = DSHValidateRuntimeProofV3(proof, error);
  return validated == nil ? nil : validated[@"attestation_sha256"];
}

DSH_PROOF_V3_RETAIN NSDictionary<NSString *, id> *
DSHRuntimeProofV3ByUpdatingDiagnosticsTimestamp(
    id proof,
    NSString *updatedAt,
    NSError **error) {
  NSDictionary *validated = DSHValidateRuntimeProofV3(proof, error);
  if (validated == nil) return nil;
  if (!DSHProofV3Timestamp(updatedAt)) {
    if (error != nil) *error = DSHProofV3Error(DSHRuntimeProofV3ErrorTimestamp);
    return nil;
  }
  NSString *attestedAt = validated[@"attestation"][@"attested_at"];
  if (DSHProofV3Compare(updatedAt, attestedAt) == NSOrderedAscending) {
    if (error != nil) *error = DSHProofV3Error(DSHRuntimeProofV3ErrorRelation);
    return nil;
  }
  NSDictionary *updated = @{
    @"schema_version" : validated[@"schema_version"],
    @"attestation" : validated[@"attestation"],
    @"attestation_sha256" : validated[@"attestation_sha256"],
    @"diagnostics" : @{
      @"schema_version" : @1,
      @"updated_at" : updatedAt,
    },
  };
  return DSHValidateRuntimeProofV3(updated, error);
}
