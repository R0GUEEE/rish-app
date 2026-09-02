#import "DSHWorkspaceCanonical.h"

#import <CommonCrypto/CommonDigest.h>

#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <iomanip>
#include <locale>
#include <math.h>
#include <sstream>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <string.h>

NSErrorDomain const DSHWorkspaceCanonicalErrorDomain =
    @"dev.zseven.rish.workspace-canonical";

static const unsigned long long DSHWorkspaceCanonicalMaxSafeInteger =
    9007199254740991ULL;

static NSError *DSHWorkspaceCanonicalError(void) {
  return [NSError errorWithDomain:DSHWorkspaceCanonicalErrorDomain
                              code:DSHWorkspaceCanonicalErrorInvalid
                          userInfo:@{
                            @"code" : @"E_WORKSPACE_INVALID",
                            NSLocalizedDescriptionKey :
                                @"Workspace canonical input is invalid.",
                          }];
}

static void DSHWorkspaceSetCanonicalError(NSError **error) {
  if (error != nullptr) *error = DSHWorkspaceCanonicalError();
}

static BOOL DSHWorkspaceIsBoolean(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL DSHWorkspaceIsFiniteNonNegativeZero(NSNumber *number) {
  if (![number isKindOfClass:NSNumber.class] || DSHWorkspaceIsBoolean(number)) {
    return NO;
  }
  double value = number.doubleValue;
  return isfinite(value) && !(value == 0.0 && signbit(value));
}

static BOOL DSHWorkspaceIsIntegerType(NSNumber *number) {
  const char *type = number.objCType;
  if (type == nullptr) return NO;
  switch (type[0]) {
    case 'c':
    case 'i':
    case 's':
    case 'l':
    case 'q':
    case 'C':
    case 'I':
    case 'S':
    case 'L':
    case 'Q':
      return YES;
    default:
      return NO;
  }
}

static NSString *DSHWorkspaceCanonicalNumber(NSNumber *number) {
  if (!DSHWorkspaceIsFiniteNonNegativeZero(number)) return nil;

  // Root-fingerprint inputs contain only safe integer revisions, but keeping
  // this generic path correct for integer NSNumber subclasses also prevents
  // Foundation's locale-dependent description from entering private hashes.
  if (DSHWorkspaceIsIntegerType(number)) {
    if (fabs(number.doubleValue) >
        (double)DSHWorkspaceCanonicalMaxSafeInteger) {
      return nil;
    }
    return number.stringValue;
  }

  double value = number.doubleValue;
  if (!isfinite(value) || (value == 0.0 && signbit(value))) return nil;

  // Floating to_chars is unavailable before iOS 16.3. Build the shortest
  // round-trip decimal with the C locale by trying the 1..17 significant-digit
  // representations. IEEE-754 doubles need at most 17 significant digits for
  // a round trip; the first candidate that parses back to identical bits is
  // therefore the shortest representation. We apply ECMAScript's fixed versus
  // scientific threshold below, independently of printf's threshold.
  std::string raw;
  uint64_t originalBits = 0;
  memcpy(&originalBits, &value, sizeof(originalBits));
  for (int precision = 1; precision <= 17; precision += 1) {
    std::ostringstream stream;
    stream.imbue(std::locale::classic());
    stream << std::setprecision(precision) << std::defaultfloat << value;
    if (stream.fail()) continue;
    const std::string candidate = stream.str();
    if (candidate.empty()) continue;
    std::istringstream parser(candidate);
    parser.imbue(std::locale::classic());
    double roundTrip = 0.0;
    uint64_t roundTripBits = 0;
    parser >> roundTrip;
    memcpy(&roundTripBits, &roundTrip, sizeof(roundTripBits));
    if (!parser.fail() && parser.eof() && roundTripBits == originalBits) {
      raw = candidate;
      break;
    }
  }
  if (raw.empty()) return nil;

  BOOL negative = raw[0] == '-';
  if (negative) raw.erase(0, 1);
  if (raw.empty()) return nil;

  std::size_t exponentOffset = raw.find_first_of("eE");
  long long exponent = 0;
  std::string mantissa = exponentOffset == std::string::npos
      ? raw
      : raw.substr(0, exponentOffset);
  if (exponentOffset != std::string::npos) {
    const std::string exponentText = raw.substr(exponentOffset + 1);
    char *end = nullptr;
    errno = 0;
    exponent = std::strtoll(exponentText.c_str(), &end, 10);
    if (errno == ERANGE || end == nullptr || *end != '\0') return nil;
  }

  std::size_t decimalOffset = mantissa.find('.');
  if (decimalOffset == std::string::npos) decimalOffset = mantissa.size();
  std::string digits = mantissa;
  if (decimalOffset < digits.size()) digits.erase(decimalOffset, 1);
  if (digits.empty()) return nil;
  std::size_t firstNonZero = digits.find_first_not_of('0');
  if (firstNonZero == std::string::npos) return @"0";
  digits.erase(0, firstNonZero);

  // decimalOffset is measured in the original digit stream. Subtracting the
  // leading zero count gives the point position relative to significant
  // digits; exponent then shifts it. The value is digits * 10^(position-len).
  long long decimalPosition = (long long)decimalOffset -
                               (long long)firstNonZero + exponent;
  long long scientificExponent = decimalPosition - 1;
  BOOL useFixed = scientificExponent >= -6 && scientificExponent < 21;
  std::string result;
  if (useFixed) {
    if (decimalPosition <= 0) {
      result = "0.";
      result.append((std::size_t)(-decimalPosition), '0');
      result += digits;
    } else if (decimalPosition >= (long long)digits.size()) {
      result = digits;
      result.append((std::size_t)(decimalPosition - (long long)digits.size()),
                    '0');
    } else {
      result = digits.substr(0, (std::size_t)decimalPosition);
      result += ".";
      result += digits.substr((std::size_t)decimalPosition);
    }
  } else {
    result.push_back(digits[0]);
    if (digits.size() > 1) {
      result.push_back('.');
      result += digits.substr(1);
    }
    result += "e";
    if (scientificExponent >= 0) result += "+";
    result += std::to_string(scientificExponent);
  }
  if (negative) result.insert(result.begin(), '-');
  return [[NSString alloc] initWithBytes:result.data()
                                  length:result.size()
                                encoding:NSUTF8StringEncoding];
}

static void DSHWorkspaceAppendJSONString(NSString *value,
                                          NSMutableString *output,
                                          BOOL *valid) {
  if (!*valid || ![value isKindOfClass:NSString.class]) {
    *valid = NO;
    return;
  }
  if ([value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO] ==
      nil) {
    *valid = NO;
    return;
  }
  [output appendString:@"\""];
  NSUInteger length = value.length;
  for (NSUInteger index = 0; index < length; index += 1) {
    unichar character = [value characterAtIndex:index];
    switch (character) {
      case '"':
        [output appendString:@"\\\""];
        break;
      case '\\':
        [output appendString:@"\\\\"];
        break;
      case '\b':
        [output appendString:@"\\b"];
        break;
      case '\f':
        [output appendString:@"\\f"];
        break;
      case '\n':
        [output appendString:@"\\n"];
        break;
      case '\r':
        [output appendString:@"\\r"];
        break;
      case '\t':
        [output appendString:@"\\t"];
        break;
      default:
        if (character < 0x20) {
          [output appendFormat:@"\\u%04x", character];
        } else {
          [output appendFormat:@"%C", character];
        }
        break;
    }
  }
  [output appendString:@"\""];
}

static NSComparisonResult DSHWorkspaceUTF16Compare(NSString *left,
                                                   NSString *right) {
  NSUInteger common = MIN(left.length, right.length);
  for (NSUInteger index = 0; index < common; index += 1) {
    unichar l = [left characterAtIndex:index];
    unichar r = [right characterAtIndex:index];
    if (l < r) return NSOrderedAscending;
    if (l > r) return NSOrderedDescending;
  }
  if (left.length < right.length) return NSOrderedAscending;
  if (left.length > right.length) return NSOrderedDescending;
  return NSOrderedSame;
}

static void DSHWorkspaceAppendCanonicalJSON(id object,
                                            NSMutableString *output,
                                            NSUInteger depth,
                                            BOOL *valid,
                                            NSMutableSet<NSValue *> *ancestors) {
  if (!*valid || depth > 64) {
    *valid = NO;
    return;
  }

  if (object == nil || object == NSNull.null) {
    [output appendString:@"null"];
    return;
  }
  if ([object isKindOfClass:NSString.class]) {
    DSHWorkspaceAppendJSONString(object, output, valid);
    return;
  }
  if ([object isKindOfClass:NSNumber.class]) {
    if (DSHWorkspaceIsBoolean(object)) {
      [output appendString:[object boolValue] ? @"true" : @"false"];
      return;
    }
    NSString *number = DSHWorkspaceCanonicalNumber(object);
    if (number == nil) {
      *valid = NO;
      return;
    }
    [output appendString:number];
    return;
  }
  if ([object isKindOfClass:NSArray.class]) {
    NSValue *identity = [NSValue valueWithPointer:(__bridge const void *)object];
    if ([ancestors containsObject:identity]) {
      *valid = NO;
      return;
    }
    [ancestors addObject:identity];
    [output appendString:@"["];
    NSArray *array = object;
    for (NSUInteger index = 0; index < array.count; index += 1) {
      if (index > 0) [output appendString:@","];
      DSHWorkspaceAppendCanonicalJSON(array[index], output, depth + 1, valid,
                                     ancestors);
      if (!*valid) {
        [ancestors removeObject:identity];
        return;
      }
    }
    [output appendString:@"]"];
    [ancestors removeObject:identity];
    return;
  }
  if ([object isKindOfClass:NSDictionary.class]) {
    NSValue *identity = [NSValue valueWithPointer:(__bridge const void *)object];
    if ([ancestors containsObject:identity]) {
      *valid = NO;
      return;
    }
    [ancestors addObject:identity];
    NSDictionary *dictionary = object;
    NSMutableArray<NSString *> *keys = [NSMutableArray arrayWithCapacity:
        dictionary.count];
    for (id key in dictionary) {
      if (![key isKindOfClass:NSString.class]) {
        *valid = NO;
        [ancestors removeObject:identity];
        return;
      }
      [keys addObject:key];
    }
    [keys sortUsingComparator:^NSComparisonResult(NSString *left,
                                                   NSString *right) {
      return DSHWorkspaceUTF16Compare(left, right);
    }];
    [output appendString:@"{"];
    for (NSUInteger index = 0; index < keys.count; index += 1) {
      if (index > 0) [output appendString:@","];
      NSString *key = keys[index];
      DSHWorkspaceAppendJSONString(key, output, valid);
      [output appendString:@":"];
      DSHWorkspaceAppendCanonicalJSON(dictionary[key], output, depth + 1,
                                      valid, ancestors);
      if (!*valid) {
        [ancestors removeObject:identity];
        return;
      }
    }
    [output appendString:@"}"];
    [ancestors removeObject:identity];
    return;
  }
  *valid = NO;
}

NSData *DSHWorkspaceCanonicalJSONData(id object, NSError **error) {
  NSMutableString *text = [NSMutableString string];
  BOOL valid = YES;
  DSHWorkspaceAppendCanonicalJSON(object, text, 0, &valid, [NSMutableSet set]);
  NSData *data = valid
      ? [text dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO]
      : nil;
  if (data == nil) DSHWorkspaceSetCanonicalError(error);
  return data;
}

NSString *DSHWorkspaceSHA256Hex(NSData *data) {
  if (![data isKindOfClass:NSData.class]) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:64];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

static BOOL DSHWorkspaceExactKeys(NSDictionary *dictionary,
                                  NSArray<NSString *> *keys) {
  if (![dictionary isKindOfClass:NSDictionary.class] ||
      dictionary.count != keys.count) {
    return NO;
  }
  NSSet *expected = [NSSet setWithArray:keys];
  for (id key in dictionary) {
    if (![key isKindOfClass:NSString.class] || ![expected containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL DSHWorkspaceCanonicalUUID(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *string = value;
  NSRegularExpression *pattern = [NSRegularExpression
      regularExpressionWithPattern:
          @"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
                                  options:0
                                    error:nil];
  NSRange full = NSMakeRange(0, string.length);
  if ([pattern firstMatchInString:string options:0 range:full] == nil) return NO;
  NSUUID *UUID = [[NSUUID alloc] initWithUUIDString:string];
  return UUID != nil && [UUID.UUIDString.lowercaseString isEqual:string];
}

static BOOL DSHWorkspaceCanonicalDigest(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *string = value;
  NSRegularExpression *pattern = [NSRegularExpression
      regularExpressionWithPattern:@"^[0-9a-f]{64}$"
                             options:0
                               error:nil];
  return [pattern firstMatchInString:string
                             options:0
                               range:NSMakeRange(0, string.length)] != nil;
}

static BOOL DSHWorkspaceCanonicalUnsignedIntegerString(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *string = value;
  if (string.length == 0 || string.length > 20) return NO;
  NSRegularExpression *pattern = [NSRegularExpression
      regularExpressionWithPattern:@"^(0|[1-9][0-9]*)$"
                             options:0
                               error:nil];
  if ([pattern firstMatchInString:string
                             options:0
                               range:NSMakeRange(0, string.length)] == nil) {
    return NO;
  }
  errno = 0;
  (void)strtoull(string.UTF8String, nullptr, 10);
  return errno != ERANGE;
}

static BOOL DSHWorkspaceSafeRevision(id value) {
  if (![value isKindOfClass:NSNumber.class] || DSHWorkspaceIsBoolean(value)) {
    return NO;
  }
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number && number >= 1.0 &&
         number <= (double)DSHWorkspaceCanonicalMaxSafeInteger &&
         !(number == 0.0 && signbit(number));
}

static BOOL DSHWorkspaceValidateCommonRoot(NSDictionary *input,
                                           NSString *origin,
                                           NSString *locator,
                                           NSArray<NSString *> *keys) {
  return DSHWorkspaceExactKeys(input, keys) &&
         [input[@"schema_version"] isKindOfClass:NSNumber.class] &&
         !DSHWorkspaceIsBoolean(input[@"schema_version"]) &&
         [input[@"schema_version"] isEqual:@1] &&
         [input[@"origin"] isEqual:origin] &&
         DSHWorkspaceCanonicalUUID(input[@"workspace_id"]) &&
         DSHWorkspaceSafeRevision(input[@"binding_revision"]) &&
         [input[@"root_locator_kind"] isEqual:locator];
}

BOOL DSHWorkspaceValidateRootFingerprintInput(NSDictionary *input,
                                              NSError **error) {
  if (![input isKindOfClass:NSDictionary.class]) {
    DSHWorkspaceSetCanonicalError(error);
    return NO;
  }

  NSString *origin = input[@"origin"];
  NSString *locator = input[@"root_locator_kind"];
  NSArray<NSString *> *keys = nil;
  if ([origin isEqual:@"rish_created"] || [origin isEqual:@"imported"]) {
    keys = @[
      @"schema_version", @"origin", @"workspace_id", @"binding_revision",
      @"root_locator_kind", @"device_id", @"inode_id",
      @"directory_name_sha256", @"authority_sha256",
    ];
    if (!DSHWorkspaceValidateCommonRoot(input, origin, @"documents_owned",
                                        keys) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(input[@"device_id"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(input[@"inode_id"]) ||
        !DSHWorkspaceCanonicalDigest(input[@"directory_name_sha256"]) ||
        !DSHWorkspaceCanonicalDigest(input[@"authority_sha256"])) {
      DSHWorkspaceSetCanonicalError(error);
      return NO;
    }
    return YES;
  }

  if ([origin isEqual:@"granted_folder"]) {
    keys = @[
      @"schema_version", @"origin", @"workspace_id", @"binding_revision",
      @"root_locator_kind", @"volume_identifier_sha256",
      @"resource_identifier_sha256", @"device_id", @"inode_id",
      @"bookmark_sha256", @"authority_sha256",
    ];
    if (!DSHWorkspaceValidateCommonRoot(input, origin, @"security_scoped",
                                        keys) ||
        !DSHWorkspaceCanonicalDigest(input[@"volume_identifier_sha256"]) ||
        !DSHWorkspaceCanonicalDigest(input[@"resource_identifier_sha256"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(input[@"device_id"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(input[@"inode_id"]) ||
        !DSHWorkspaceCanonicalDigest(input[@"bookmark_sha256"]) ||
        !DSHWorkspaceCanonicalDigest(input[@"authority_sha256"])) {
      DSHWorkspaceSetCanonicalError(error);
      return NO;
    }
    return YES;
  }

  if ([origin isEqual:@"legacy_app_owned"]) {
    keys = @[
      @"schema_version", @"origin", @"workspace_id", @"binding_revision",
      @"root_locator_kind", @"legacy_project_id",
      @"project_metadata_sha256", @"projects_root_device_id",
      @"projects_root_inode_id", @"repository_device_id",
      @"repository_inode_id", @"git_device_id", @"git_inode_id",
    ];
    if (!DSHWorkspaceValidateCommonRoot(input, origin, @"legacy_app_owned",
                                        keys) ||
        !DSHWorkspaceCanonicalUUID(input[@"legacy_project_id"]) ||
        !DSHWorkspaceCanonicalDigest(input[@"project_metadata_sha256"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(
            input[@"projects_root_device_id"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(
            input[@"projects_root_inode_id"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(
            input[@"repository_device_id"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(
            input[@"repository_inode_id"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(input[@"git_device_id"]) ||
        !DSHWorkspaceCanonicalUnsignedIntegerString(input[@"git_inode_id"])) {
      DSHWorkspaceSetCanonicalError(error);
      return NO;
    }
    return YES;
  }

  (void)locator;
  DSHWorkspaceSetCanonicalError(error);
  return NO;
}

NSString *DSHWorkspaceRootFingerprintSHA256(NSDictionary *input,
                                            NSError **error) {
  if (!DSHWorkspaceValidateRootFingerprintInput(input, error)) return nil;
  NSError *canonicalError = nil;
  NSData *canonical = DSHWorkspaceCanonicalJSONData(input, &canonicalError);
  if (canonical == nil) {
    DSHWorkspaceSetCanonicalError(error);
    return nil;
  }
  NSData *domain = [@"rish.workspace-root-fingerprint.v1\0"
      dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  NSMutableData *preimage = [NSMutableData dataWithData:domain];
  [preimage appendData:canonical];
  NSString *digest = DSHWorkspaceSHA256Hex(preimage);
  if (digest == nil) DSHWorkspaceSetCanonicalError(error);
  return digest;
}
