#import "AgentNativeWAL.h"
#import "RishHarnessCatalog.h"

#import "DSHWorkspaceCanonical.h"
#import "AgentExecutionLedger.h"
#import "AgentRoundJournal.h"

#import <TargetConditionals.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <string.h>
#include <unistd.h>

#include <algorithm>
#include <cstdlib>
#include <stdint.h>
#include <string>
#include <set>

NSErrorDomain const DSHAgentNativeStoreErrorDomain =
    @"dev.zseven.rish.agent-native-store";

const NSUInteger DSHAgentNativeWALMaxTranscriptBytes = 2 * 1024 * 1024;
const NSUInteger DSHAgentNativeWALMaxTranscriptCount = 128;
const NSUInteger DSHAgentNativeWALMaxLedgerRowsPerAttempt = 128;
const NSUInteger DSHAgentNativeWALMaxRoundRowsPerAttempt = 8;
const NSUInteger DSHAgentNativeWALMaxStoreBytes = 64 * 1024 * 1024;
const NSUInteger DSHAgentNativeWALMaxSingleWriteBytes = 32 * 1024;
const NSUInteger DSHAgentNativeWALMaxBatchWriteBytes = 512 * 1024;
const NSUInteger DSHAgentNativeWALMaxAttemptWriteBytes = 4 * 1024 * 1024;
const NSUInteger DSHAgentNativeWALMaxAuthorities = 128;
const NSUInteger DSHAgentNativeWALMaxOperationsPerAttempt = 256;
const NSUInteger DSHAgentNativeWALMaxOperations = 2048;
const NSUInteger DSHAgentNativeWALMaxOperationRecordBytes = 16 * 1024;
const NSUInteger DSHAgentNativeWALMaxOperationResultBytes = 768 * 1024;
const NSUInteger DSHAgentNativeWALMaxBatchesPerAttempt = 128;
const NSUInteger DSHAgentNativeWALMaxDeniedCallsPerAttempt = 128;
const NSUInteger DSHAgentNativeWALMaxDeniedCalls = 2048;

static const unsigned long long DSHAgentMaximumSafeInteger = 9007199254740991ULL;
static NSString *const DSHAgentWALFileName = @"agent-native-wal-v1.json";
static NSString *const DSHAgentWALTemporarySuffix = @".tmp";

static NSArray<NSString *> *DSHAgentWALV1Keys(void) {
  static NSArray<NSString *> *keys;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    keys = @[
      @"schema_version",
      @"generation",
      @"transcripts",
      @"rounds",
      @"ledger",
      @"reservations",
      @"cleanup",
      @"dispatch",
      @"batches",
    ];
  });
  return keys;
}

static NSArray<NSString *> *DSHAgentWALV2Keys(void) {
  static NSArray<NSString *> *keys;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    keys = @[
      @"schema_version",
      @"generation",
      @"authorities",
      @"operations",
      @"operation_results",
      @"transcripts",
      @"rounds",
      @"ledger",
      @"reservations",
      @"cleanup",
      @"dispatch",
      @"batches",
      @"denied_calls",
    ];
  });
  return keys;
}

static BOOL DSHAgentIsBooleanNumber(id value) {
  return [value isKindOfClass:NSNumber.class] &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL DSHAgentFiniteJSONNumber(NSNumber *number) {
  if (number == nil || DSHAgentIsBooleanNumber(number)) return YES;
  const char *type = number.objCType;
  if (type == nullptr || type[0] == '\0') return NO;
  if (strchr("fd", type[0]) != nullptr) {
    const double value = number.doubleValue;
    if (!isfinite(value) || (value == 0 && signbit(value))) return NO;
    if (floor(value) == value &&
        fabs(value) > (double)DSHAgentMaximumSafeInteger) {
      return NO;
    }
    return YES;
  }
  return strchr("cCsSiIlLqQ", type[0]) != nullptr;
}

static BOOL DSHAgentJSONTree(id value,
                             NSUInteger depth,
                             NSUInteger *nodes,
                             NSMutableSet<NSValue *> *ancestors) {
  if (value == nil || nodes == nullptr || ancestors == nil || depth > 64 ||
      *nodes >= 30000) {
    return NO;
  }
  *nodes += 1;
  if (value == NSNull.null) return YES;
  if ([value isKindOfClass:NSString.class]) {
    return [value dataUsingEncoding:NSUTF8StringEncoding] != nil;
  }
  if ([value isKindOfClass:NSNumber.class]) {
    return DSHAgentFiniteJSONNumber(value);
  }
  const BOOL isDictionary = [value isKindOfClass:NSDictionary.class];
  const BOOL isArray = [value isKindOfClass:NSArray.class];
  if (!isDictionary && !isArray) return NO;

  NSValue *identity = [NSValue valueWithPointer:(__bridge const void *)value];
  if ([ancestors containsObject:identity]) return NO;
  [ancestors addObject:identity];

  BOOL valid = YES;
  if (isDictionary) {
    for (id key in (NSDictionary *)value) {
      if (![key isKindOfClass:NSString.class] ||
          [key dataUsingEncoding:NSUTF8StringEncoding] == nil ||
          !DSHAgentJSONTree(((NSDictionary *)value)[key], depth + 1, nodes,
                            ancestors)) {
        valid = NO;
        break;
      }
    }
  } else {
    for (id child in (NSArray *)value) {
      if (!DSHAgentJSONTree(child, depth + 1, nodes, ancestors)) {
        valid = NO;
        break;
      }
    }
  }
  [ancestors removeObject:identity];
  return valid;
}

BOOL DSHAgentIsImmutableFoundationJSON(id value) {
  if (value == nil) return NO;
  NSUInteger nodes = 0;
  return DSHAgentJSONTree(value, 0, &nodes, [NSMutableSet set]);
}

BOOL DSHAgentExactDictionaryKeys(NSDictionary *value,
                                 NSArray<NSString *> *keys) {
  if (![value isKindOfClass:NSDictionary.class] ||
      ![keys isKindOfClass:NSArray.class] || value.count != keys.count) {
    return NO;
  }
  NSSet *allowed = [NSSet setWithArray:keys];
  for (id key in value) {
    if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

BOOL DSHAgentExactDictionaryKeysWithOptional(NSDictionary *value,
                                             NSArray<NSString *> *keys,
                                             NSArray<NSString *> *optionalKeys) {
  if (![value isKindOfClass:NSDictionary.class] ||
      ![keys isKindOfClass:NSArray.class] ||
      ![optionalKeys isKindOfClass:NSArray.class]) {
    return NO;
  }
  NSSet *allowed = [NSSet setWithArray:
      [keys arrayByAddingObjectsFromArray:optionalKeys]];
  NSSet *required = [NSSet setWithArray:keys];
  for (id key in value) {
    if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
      return NO;
    }
  }
  for (NSString *key in keys) {
    if (value[key] == nil) return NO;
  }
  (void)required;
  return YES;
}

BOOL DSHAgentCanonicalUUID(id value) {
  if (![value isKindOfClass:NSString.class] ||
      ((NSString *)value).length != 36) {
    return NO;
  }
  NSString *candidate = (NSString *)value;
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:candidate];
  return uuid != nil && [uuid.UUIDString.lowercaseString isEqualToString:candidate];
}

BOOL DSHAgentCanonicalSHA256(id value) {
  if (![value isKindOfClass:NSString.class] ||
      ((NSString *)value).length != 64) {
    return NO;
  }
  static NSCharacterSet *invalid;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    invalid = [[NSCharacterSet
        characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  });
  return [((NSString *)value) rangeOfCharacterFromSet:invalid].location ==
      NSNotFound;
}

BOOL DSHAgentSafeInteger(id value, NSUInteger maximum, BOOL allowZero) {
  if (![value isKindOfClass:NSNumber.class] || DSHAgentIsBooleanNumber(value)) {
    return NO;
  }
  NSNumber *number = (NSNumber *)value;
  const double numeric = number.doubleValue;
  if (!isfinite(numeric) || floor(numeric) != numeric || signbit(numeric) ||
      numeric < 0 || numeric > (double)maximum ||
      numeric > (double)DSHAgentMaximumSafeInteger ||
      number.unsignedLongLongValue != (unsigned long long)numeric ||
      (!allowZero && numeric == 0)) {
    return NO;
  }
  return YES;
}

BOOL DSHAgentBoundedUTF8String(id value,
                               NSUInteger maximumBytes,
                               BOOL allowEmpty,
                               NSString **output) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *string = (NSString *)value;
  if (!allowEmpty && string.length == 0) return NO;
  NSData *data = [string dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil || data.length > maximumBytes) return NO;
  if (output != nullptr) *output = string;
  return YES;
}

BOOL DSHAgentCanonicalTimestamp(id value) {
  if (![value isKindOfClass:NSString.class] ||
      ![value dataUsingEncoding:NSUTF8StringEncoding]) return NO;
  NSString *timestamp = value;
  if (timestamp.length != 24) return NO;
  NSRegularExpression *pattern = [NSRegularExpression
      regularExpressionWithPattern:
          @"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
                              options:0
                                error:nil];
  NSRange full = NSMakeRange(0, timestamp.length);
  if ([pattern firstMatchInString:timestamp options:0 range:full] == nil) return NO;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  NSDate *date = [formatter dateFromString:timestamp];
  return date != nil && [[formatter stringFromDate:date] isEqual:timestamp];
}

BOOL DSHAgentFailureCode(id value) {
  if (!DSHAgentBoundedUTF8String(value, 128, NO, nullptr)) return NO;
  static NSSet<NSString *> *codes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    codes = [NSSet setWithArray:@[
      @"E_AGENT_UNKNOWN_TOOL",
      @"E_AGENT_BAD_ARGUMENTS",
      @"E_AGENT_BAD_PATH",
      @"E_AGENT_NO_ROOT",
      @"E_AGENT_ROOT_STALE",
      @"E_AGENT_CAPABILITY",
      @"E_AGENT_APPROVAL",
      @"E_AGENT_TRANSCRIPT",
      @"E_AGENT_LEDGER",
      @"E_AGENT_ROUND_AMBIGUOUS",
      @"E_AGENT_EXECUTION_AMBIGUOUS",
      @"E_AGENT_RETRY_LINEAGE",
      @"E_AGENT_PERSISTENCE",
      @"E_AGENT_CONFLICT",
      @"E_AGENT_ROUND_LIMIT",
      @"E_AGENT_CANCELLED",
      @"E_AGENT_TOOL_FAILED",
      @"E_AGENT_NATIVE",
      @"E_AGENT_NOT_FOUND",
      @"E_AGENT_CAPACITY",
      @"E_COMPLETION_LENGTH",
      @"E_COMPLETION_CONTENT_FILTER",
      @"E_AGENT_DENIED_BY_USER",
    ]];
  });
  return [codes containsObject:value];
}

NSError *DSHAgentNativeStoreError(DSHAgentNativeStoreErrorCode code) {
  NSString *stableCode = @"E_AGENT_PERSISTENCE";
  NSString *message = @"Agent native storage is unavailable.";
  switch (code) {
    case DSHAgentNativeStoreErrorInvalidArgument:
      stableCode = @"E_AGENT_BAD_ARGUMENTS";
      message = @"Agent request is invalid.";
      break;
    case DSHAgentNativeStoreErrorCorrupt:
      stableCode = @"E_AGENT_TRANSCRIPT";
      message = @"Agent native storage failed integrity validation.";
      break;
    case DSHAgentNativeStoreErrorConflict:
      stableCode = @"E_AGENT_CONFLICT";
      message = @"Agent native state changed concurrently.";
      break;
    case DSHAgentNativeStoreErrorCapacity:
      stableCode = @"E_AGENT_CAPACITY";
      message = @"Agent native storage capacity is exhausted.";
      break;
    case DSHAgentNativeStoreErrorOwnerLost:
      stableCode = @"E_AGENT_EXECUTION_AMBIGUOUS";
      message = @"Agent native task ownership is no longer provable.";
      break;
    case DSHAgentNativeStoreErrorNotFound:
      stableCode = @"E_AGENT_NOT_FOUND";
      message = @"Agent native record is unavailable.";
      break;
    case DSHAgentNativeStoreErrorPersistence:
      stableCode = @"E_AGENT_PERSISTENCE";
      message = @"Agent native storage could not be committed.";
      break;
    case DSHAgentNativeStoreErrorUnavailable:
      break;
  }
  return [NSError errorWithDomain:DSHAgentNativeStoreErrorDomain
                              code:code
                          userInfo:@{
                            @"code" : stableCode,
                            NSLocalizedDescriptionKey : message,
                          }];
}

void DSHSetAgentNativeStoreError(NSError **error,
                                 DSHAgentNativeStoreErrorCode code) {
  if (error != nullptr) *error = DSHAgentNativeStoreError(code);
}

NSData *DSHAgentCanonicalJSON(id value, NSError **error) {
  NSError *canonicalError = nil;
  NSData *data = DSHWorkspaceCanonicalJSONData(value, &canonicalError);
  if (data != nil) return data;
  if (error != nullptr) *error = DSHAgentNativeStoreError(
      DSHAgentNativeStoreErrorInvalidArgument);
  return nil;
}

id DSHAgentImmutableJSONCopy(id value, NSError **error) {
  NSData *data = DSHAgentCanonicalJSON(value, error);
  if (data == nil) return nil;
  NSError *decodeError = nil;
  id copy = [NSJSONSerialization JSONObjectWithData:data options:0 error:&decodeError];
  if (!DSHAgentIsImmutableFoundationJSON(copy)) {
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return copy;
}

static NSData *DSHAgentUTF8(NSString *value) {
  return [value dataUsingEncoding:NSUTF8StringEncoding];
}

NSString *DSHAgentHJ(NSString *tag, id value, NSError **error) {
  NSString *safeTag = nil;
  if (!DSHAgentBoundedUTF8String(tag, 128, NO, &safeTag)) {
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *canonicalError = nil;
  NSData *canonical = DSHAgentCanonicalJSON(value, &canonicalError);
  if (canonical == nil) {
    if (error != nullptr) *error = canonicalError;
    return nil;
  }
  NSMutableData *input = [NSMutableData dataWithData:
      DSHAgentUTF8([NSString stringWithFormat:@"rish.%@.v1\0", safeTag])];
  [input appendData:canonical];
  return DSHWorkspaceSHA256Hex(input);
}

NSString *DSHAgentHB(NSString *tag, NSData *bytes, NSError **error) {
  NSString *safeTag = nil;
  if (!DSHAgentBoundedUTF8String(tag, 128, NO, &safeTag) ||
      ![bytes isKindOfClass:NSData.class]) {
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSMutableData *input = [NSMutableData dataWithData:
      DSHAgentUTF8([NSString stringWithFormat:@"rish.%@.v1\0", safeTag])];
  uint64_t length = CFSwapInt64HostToBig((uint64_t)bytes.length);
  [input appendBytes:&length length:sizeof(length)];
  [input appendData:bytes];
  return DSHWorkspaceSHA256Hex(input);
}

namespace {

static bool DSHAgentDecimalMagnitudeWithinSafeInteger(const std::string &token) {
  size_t cursor = token.size() > 0 && token[0] == '-' ? 1 : 0;
  size_t dot = token.find('.', cursor);
  size_t exponentMark = token.find_first_of("eE", cursor);
  size_t significandEnd = exponentMark == std::string::npos
      ? token.size() : exponentMark;
  size_t fractionDigits = 0;
  std::string digits;
  digits.reserve(significandEnd - cursor);
  for (size_t index = cursor; index < significandEnd; index += 1) {
    if (token[index] == '.') {
      continue;
    }
    if (dot != std::string::npos && index > dot) fractionDigits += 1;
    digits.push_back(token[index]);
  }
  size_t firstSignificant = digits.find_first_not_of('0');
  if (firstSignificant == std::string::npos) return true;
  digits.erase(0, firstSignificant);
  long long exponent = 0;
  if (exponentMark != std::string::npos) {
    size_t index = exponentMark + 1;
    bool negative = false;
    if (index < token.size() && (token[index] == '+' || token[index] == '-')) {
      negative = token[index] == '-';
      index += 1;
    }
    // Exponents beyond this bound are already unambiguously outside/inside
    // the integer window; cap them to avoid integer overflow while parsing.
    long long magnitude = 0;
    while (index < token.size()) {
      unsigned digit = static_cast<unsigned>(token[index] - '0');
      if (magnitude < 100000) magnitude = magnitude * 10 + digit;
      if (magnitude > 100000) magnitude = 100000;
      index += 1;
    }
    exponent = negative ? -magnitude : magnitude;
  }
  long long decimalShift = exponent - static_cast<long long>(fractionDigits);
  long long integerDigits = decimalShift >= 0
      ? static_cast<long long>(digits.size()) + decimalShift
      : std::max<long long>(0, static_cast<long long>(digits.size()) + decimalShift);
  bool fractional = false;
  if (decimalShift < 0 &&
      static_cast<long long>(digits.size()) > integerDigits) {
    for (size_t index = static_cast<size_t>(integerDigits);
         index < digits.size(); index += 1) {
      if (digits[index] != '0') {
        fractional = true;
        break;
      }
    }
  }
  // Non-integral decimal/exponent lexemes with more than fifteen meaningful
  // digits cannot round-trip through the bridge's IEEE-754 number type. Exact
  // integral values are handled by the safe-integer comparison below and are
  // allowed at the 9007199254740991 boundary.
  if (fractional && (dot != std::string::npos || exponentMark != std::string::npos)) {
    std::string meaningful = digits;
    while (!meaningful.empty() && meaningful.back() == '0') meaningful.pop_back();
    if (meaningful.size() > 15) return false;
  }
  if (integerDigits < 16) return true;
  if (integerDigits > 16) return false;

  std::string integerPart;
  if (decimalShift >= 0) {
    integerPart = digits;
    integerPart.append(static_cast<size_t>(decimalShift), '0');
  } else {
    integerPart = digits.substr(0, 16);
  }
  if (integerPart.size() > 16) return false;
  if (integerPart.size() < 16) integerPart.append(16 - integerPart.size(), '0');
  const std::string safe = "9007199254740991";
  if (integerPart > safe) return false;
  if (integerPart < safe) return true;
  if (decimalShift < 0 && digits.size() > 16) {
    for (size_t index = 16; index < digits.size(); index += 1) {
      if (digits[index] != '0') return false;
    }
  }
  return true;
}

class DSHAgentStrictJSONScanner {
 public:
  explicit DSHAgentStrictJSONScanner(NSData *data)
      : data_(data), bytes_(static_cast<const uint8_t *>(data.bytes)),
        length_(data.length), position_(0), nodes_(0) {}

  bool run() {
    if (!parseValue(0)) return false;
    skipWhitespace();
    return position_ == length_;
  }

 private:
  void skipWhitespace() {
    while (position_ < length_) {
      uint8_t c = bytes_[position_];
      if (c != ' ' && c != '\n' && c != '\r' && c != '\t') break;
      position_ += 1;
    }
  }

  bool parseValue(size_t depth) {
    if (depth > 64 || nodes_ >= 30000) return false;
    skipWhitespace();
    if (position_ >= length_) return false;
    nodes_ += 1;
    switch (bytes_[position_]) {
      case '{': return parseObject(depth + 1);
      case '[': return parseArray(depth + 1);
      case '"': return parseString(nullptr, nullptr);
      case 't': return parseLiteral("true");
      case 'f': return parseLiteral("false");
      case 'n': return parseLiteral("null");
      default: return parseNumber();
    }
  }

  bool parseLiteral(const char *literal) {
    size_t index = 0;
    while (literal[index] != '\0') {
      if (position_ >= length_ || bytes_[position_] != literal[index]) return false;
      position_ += 1;
      index += 1;
    }
    return true;
  }

  bool parseString(size_t *start, size_t *end) {
    if (position_ >= length_ || bytes_[position_] != '"') return false;
    size_t begin = position_;
    position_ += 1;
    while (position_ < length_) {
      uint8_t c = bytes_[position_++];
      if (c == '"') {
        if (start != nullptr) *start = begin;
        if (end != nullptr) *end = position_;
        return true;
      }
      if (c < 0x20) return false;
      if (c != '\\') continue;
      if (position_ >= length_) return false;
      uint8_t escape = bytes_[position_++];
      if (escape == 'u') {
        if (position_ + 4 > length_) return false;
        for (size_t index = 0; index < 4; index += 1) {
          uint8_t hex = bytes_[position_++];
          if (!((hex >= '0' && hex <= '9') ||
                (hex >= 'a' && hex <= 'f') ||
                (hex >= 'A' && hex <= 'F'))) return false;
        }
      } else if (escape != '"' && escape != '\\' && escape != '/' &&
                 escape != 'b' && escape != 'f' && escape != 'n' &&
                 escape != 'r' && escape != 't') {
        return false;
      }
    }
    return false;
  }

  bool parseNumber() {
    size_t begin = position_;
    if (position_ < length_ && bytes_[position_] == '-') position_ += 1;
    if (position_ >= length_) return false;
    if (bytes_[position_] == '0') {
      position_ += 1;
      if (position_ < length_ && bytes_[position_] >= '0' &&
          bytes_[position_] <= '9') return false;
    } else if (bytes_[position_] >= '1' && bytes_[position_] <= '9') {
      while (position_ < length_ && bytes_[position_] >= '0' &&
             bytes_[position_] <= '9') position_ += 1;
    } else {
      return false;
    }
    bool integer = true;
    if (position_ < length_ && bytes_[position_] == '.') {
      integer = false;
      position_ += 1;
      size_t fractionStart = position_;
      while (position_ < length_ && bytes_[position_] >= '0' &&
             bytes_[position_] <= '9') position_ += 1;
      if (fractionStart == position_) return false;
    }
    if (position_ < length_ && (bytes_[position_] == 'e' ||
                               bytes_[position_] == 'E')) {
      integer = false;
      position_ += 1;
      if (position_ < length_ && (bytes_[position_] == '+' ||
                                 bytes_[position_] == '-')) position_ += 1;
      size_t exponentStart = position_;
      while (position_ < length_ && bytes_[position_] >= '0' &&
             bytes_[position_] <= '9') position_ += 1;
      if (exponentStart == position_) return false;
    }
    std::string token(reinterpret_cast<const char *>(bytes_ + begin),
                      position_ - begin);
    char *end = nullptr;
    errno = 0;
    // Foundation/JavaScript ultimately represent decoded JSON numbers as
    // IEEE-754 values.  Parse through long double first so an exponent or a
    // decimal cannot silently overflow/underflow or round an integer outside
    // the JSON safe-integer subset before the ordinary JSON decoder sees it.
    long double value = std::strtold(token.c_str(), &end);
    if (end == nullptr || *end != '\0' || errno == ERANGE ||
        !std::isfinite(value) ||
        (value == 0.0L && token.size() > 0 && token[0] == '-') ||
        !DSHAgentDecimalMagnitudeWithinSafeInteger(token)) {
      return false;
    }
    // An exponent/decimal which is mathematically an integer is subject to
    // the same safe-integer bound as an integer lexeme.  The absolute bound
    // above also rejects fractional values whose magnitude cannot be carried
    // by the bridge without becoming an unsafe integer.
    if (integer && std::fabs(value) > (long double)DSHAgentMaximumSafeInteger) {
      return false;
    }
    return true;
  }

  bool parseObject(size_t depth) {
    if (bytes_[position_] != '{') return false;
    position_ += 1;
    skipWhitespace();
    std::set<std::string> keys;
    if (position_ < length_ && bytes_[position_] == '}') {
      position_ += 1;
      return true;
    }
    while (position_ < length_) {
      size_t start = 0;
      size_t end = 0;
      if (!parseString(&start, &end)) return false;
      NSData *keyData = [data_ subdataWithRange:NSMakeRange(start, end - start)];
      NSError *keyError = nil;
      id keyObject = [NSJSONSerialization JSONObjectWithData:keyData
                                                        options:NSJSONReadingAllowFragments
                                                          error:&keyError];
      if (![keyObject isKindOfClass:NSString.class]) return false;
      NSData *keyUTF8 = [keyObject dataUsingEncoding:NSUTF8StringEncoding];
      std::string key(reinterpret_cast<const char *>(keyUTF8.bytes), keyUTF8.length);
      if (!keys.insert(key).second) return false;
      skipWhitespace();
      if (position_ >= length_ || bytes_[position_] != ':') return false;
      position_ += 1;
      if (!parseValue(depth)) return false;
      skipWhitespace();
      if (position_ < length_ && bytes_[position_] == '}') {
        position_ += 1;
        return true;
      }
      if (position_ >= length_ || bytes_[position_] != ',') return false;
      position_ += 1;
      skipWhitespace();
    }
    return false;
  }

  bool parseArray(size_t depth) {
    if (bytes_[position_] != '[') return false;
    position_ += 1;
    skipWhitespace();
    if (position_ < length_ && bytes_[position_] == ']') {
      position_ += 1;
      return true;
    }
    while (position_ < length_) {
      if (!parseValue(depth)) return false;
      skipWhitespace();
      if (position_ < length_ && bytes_[position_] == ']') {
        position_ += 1;
        return true;
      }
      if (position_ >= length_ || bytes_[position_] != ',') return false;
      position_ += 1;
      skipWhitespace();
    }
    return false;
  }

  NSData *data_;
  const uint8_t *bytes_;
  size_t length_;
  size_t position_;
  size_t nodes_;
};

}  // namespace

NSDictionary *DSHAgentParseArgumentsJSON(NSString *argumentsJSON,
                                          NSError **error) {
  NSString *arguments = nil;
  // The write payload itself is capped at 32768 bytes, but its JSON wrapper
  // (quotes, escaped bytes, and object keys) is not part of that payload
  // budget.  Keep a separate bounded parser envelope so a full-size payload
  // remains admissible without making arguments unbounded.
  // A 32768-byte UTF-8 payload may expand to six-byte \u00XX escapes for
  // control characters, in addition to the object wrapper and argument keys.
  // Keep the parser bounded at 256 KiB so the worst valid write remains
  // representable without accepting an unbounded provider string.
  if (!DSHAgentBoundedUTF8String(argumentsJSON, 256 * 1024, YES, &arguments)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSData *bytes = [arguments dataUsingEncoding:NSUTF8StringEncoding];
  DSHAgentStrictJSONScanner scanner(bytes);
  if (!scanner.run()) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSError *decodeError = nil;
  id object = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:&decodeError];
  if (![object isKindOfClass:NSDictionary.class] ||
      DSHAgentCanonicalJSON(object, &decodeError) == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return object;
}

static BOOL DSHAgentArgumentPathAllowed(NSString *path, BOOL allowEmpty) {
  if (!DSHAgentBoundedUTF8String(path, 512, allowEmpty, nullptr) ||
      [path hasPrefix:@"/"] || [path containsString:@"\\"] ||
      [path rangeOfString:@"\0"].location != NSNotFound ||
      ![path isEqualToString:path.precomposedStringWithCanonicalMapping]) {
    return NO;
  }
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if ([component isEqualToString:@".."] ||
        (component.length == 0 && !(allowEmpty && path.length == 0))) return NO;
  }
  return YES;
}

static BOOL DSHAgentArgumentWritePriorShape(id prior) {
  if (![prior isKindOfClass:NSDictionary.class]) return NO;
  NSString *kind = prior[@"kind"];
  if (![kind isKindOfClass:NSString.class]) return NO;
  if ([kind isEqualToString:@"absent"]) {
    return DSHAgentExactDictionaryKeys(prior, @[@"schema_version", @"kind"]) &&
        DSHAgentSafeInteger(prior[@"schema_version"], 1, NO);
  }
  if ([kind isEqualToString:@"known"]) {
    return DSHAgentExactDictionaryKeys(prior, @[
      @"schema_version", @"kind", @"revision",
    ]) && DSHAgentSafeInteger(prior[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(prior[@"revision"], 256, NO, nullptr);
  }
  return [kind isEqualToString:@"unknown"] &&
      DSHAgentExactDictionaryKeys(prior, @[
        @"schema_version", @"kind", @"failure_code",
      ]) && DSHAgentSafeInteger(prior[@"schema_version"], 1, NO) &&
      DSHAgentFailureCode(prior[@"failure_code"]);
}

NSString *DSHAgentArgumentsSHA256(NSString *name,
                                  NSString *argumentsJSON,
                                  NSError **error) {
  NSString *toolName = nil;
  if (!DSHAgentBoundedUTF8String(name, 64, NO, &toolName)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
      invertedSet];
  if ([toolName rangeOfCharacterFromSet:invalid].location != NSNotFound) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *arguments = DSHAgentParseArgumentsJSON(argumentsJSON, error);
  if (arguments == nil) return nil;
  if ([toolName isEqualToString:@"write_file"] ||
      [toolName isEqualToString:@"read_file"] ||
      [toolName isEqualToString:@"list_dir"]) {
    NSString *path = arguments[@"path"];
    BOOL listDirectory = [toolName isEqualToString:@"list_dir"];
    BOOL exactPath = [toolName isEqualToString:@"write_file"]
        ? [path isKindOfClass:NSString.class]
        : (listDirectory
            ? (arguments.count == 0 || DSHAgentExactDictionaryKeys(arguments, @[@"path"]))
            : DSHAgentExactDictionaryKeys(arguments, @[@"path"]));
    if (listDirectory && path == nil) path = @"";
    if (!exactPath || !DSHAgentArgumentPathAllowed(path, listDirectory)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
  }
  if ([toolName isEqualToString:@"write_file"]) {
    id expectedRevision = arguments[@"expected_revision"];
    id expectedPrior = arguments[@"expected_prior"];
    NSData *contentBytes = [arguments[@"content"]
        isKindOfClass:NSString.class]
        ? [arguments[@"content"] dataUsingEncoding:NSUTF8StringEncoding]
        : nil;
    if ((!DSHAgentExactDictionaryKeys(arguments,
                                      @[@"path", @"content", @"expected_revision"]) &&
         !DSHAgentExactDictionaryKeys(arguments,
                                      @[@"path", @"content", @"expected_prior"])) ||
        ![arguments[@"content"] isKindOfClass:NSString.class] ||
        contentBytes == nil ||
        contentBytes.length > DSHAgentNativeWALMaxSingleWriteBytes ||
        (expectedRevision != nil && expectedRevision != NSNull.null &&
         !DSHAgentBoundedUTF8String(expectedRevision, 256, NO, nullptr)) ||
        (expectedPrior != nil && !DSHAgentArgumentWritePriorShape(expectedPrior))) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return nil;
    }
  } else if ([toolName isEqualToString:@"git_commit"] &&
             (!DSHAgentExactDictionaryKeys(arguments, @[@"message"]) ||
              !DSHAgentBoundedUTF8String(arguments[@"message"], 500, NO, nullptr))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  } else if ([toolName isEqualToString:@"git_push"] &&
             arguments.count != 0) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return DSHAgentHJ(@"tool-arguments", @{
    @"name" : toolName,
    @"arguments" : arguments,
  }, error);
}

NSString *DSHAgentIdempotencyKeyForLocator(NSDictionary *locator,
                                           NSString *rootFingerprintSHA256,
                                           NSString *argumentsSHA256,
                                           NSError **error) {
  if (!DSHAgentExactDictionaryKeys(locator, @[
        @"schema_version", @"task_id", @"attempt_id", @"round_id",
        @"round_index", @"call_index", @"call_id", @"idempotency_key",
      ]) || ![locator[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(locator[@"task_id"]) ||
      !DSHAgentCanonicalUUID(locator[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(locator[@"round_id"]) ||
      !DSHAgentSafeInteger(locator[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(locator[@"call_index"], 15, YES) ||
      !DSHAgentBoundedUTF8String(locator[@"call_id"], 128, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(rootFingerprintSHA256) ||
      !DSHAgentCanonicalSHA256(argumentsSHA256)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSCharacterSet *invalidCallId = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  if ([locator[@"call_id"] rangeOfCharacterFromSet:invalidCallId].location != NSNotFound) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return DSHAgentHJ(@"tool-idempotency", @{
    @"task_id" : locator[@"task_id"],
    @"attempt_id" : locator[@"attempt_id"],
    @"round_id" : locator[@"round_id"],
    @"round_index" : locator[@"round_index"],
    @"call_index" : locator[@"call_index"],
    @"call_id" : locator[@"call_id"],
    @"root_fingerprint_sha256" : rootFingerprintSHA256,
    @"arguments_sha256" : argumentsSHA256,
  }, error);
}

BOOL DSHAgentValidateNativeToolFeedbackString(NSString *feedbackJSON,
                                              NSError **error) {
  NSString *feedbackText = nil;
  if (!DSHAgentBoundedUTF8String(feedbackJSON,
                                DSHAgentNativeWALMaxTranscriptBytes, YES,
                                &feedbackText)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSData *bytes = [feedbackText dataUsingEncoding:NSUTF8StringEncoding];
  NSError *decodeError = nil;
  id object = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:&decodeError];
  NSError *canonicalError = nil;
  NSData *canonical = DSHAgentCanonicalJSON(object, &canonicalError);
  if (canonical == nil || ![canonical isEqualToData:bytes] ||
      ![object isKindOfClass:NSDictionary.class] ||
      !DSHAgentExactDictionaryKeys(object, @[
        @"schema_version", @"name", @"outcome", @"payload",
      ]) || !DSHAgentSafeInteger(object[@"schema_version"], 1, NO) ||
      !DSHAgentBoundedUTF8String(object[@"name"], 64, NO, nullptr) ||
      ![object[@"payload"] isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  NSDictionary *feedback = object;
  NSDictionary *payload = feedback[@"payload"];
  NSString *name = feedback[@"name"];
  NSString *outcome = feedback[@"outcome"];
  if ([name isEqualToString:@"list_dir"] && bytes.length > 64 * 1024) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
    return NO;
  }
  NSCharacterSet *invalidName = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
      invertedSet];
  if ([name rangeOfCharacterFromSet:invalidName].location != NSNotFound) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if ([outcome isEqualToString:@"failed"] ||
      [outcome isEqualToString:@"denied"] ||
      [outcome isEqualToString:@"cancelled"] ||
      [outcome isEqualToString:@"ambiguous"]) {
    // git_push failures may carry a value-free `reason` token next to the
    // stable failure code (non_fast_forward, remote_moved, auth_failed, ...).
    NSCharacterSet *reasonAlphabet = [[NSCharacterSet
        characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz_"]
        invertedSet];
    BOOL validReason = payload[@"reason"] == nil ||
        (DSHAgentExactDictionaryKeys(payload, @[
            @"schema_version", @"failure_code", @"reason",
          ]) &&
         DSHAgentBoundedUTF8String(payload[@"reason"], 64, NO, nullptr) &&
         [(NSString *)payload[@"reason"] rangeOfCharacterFromSet:reasonAlphabet]
             .location == NSNotFound);
    BOOL validFailure = (payload[@"reason"] != nil
        ? validReason
        : DSHAgentExactDictionaryKeys(payload, @[
            @"schema_version", @"failure_code",
          ])) && DSHAgentSafeInteger(payload[@"schema_version"], 1, NO) &&
        DSHAgentFailureCode(payload[@"failure_code"]);
    if (!validFailure && [outcome isEqualToString:@"denied"] &&
        [payload[@"failure_code"] isEqualToString:@"E_AGENT_DENIED_BY_USER"]) {
      // User denials optionally carry a bounded model-directed message.
      validFailure = DSHAgentExactDictionaryKeys(payload, @[
        @"schema_version", @"failure_code", @"user_message",
      ]) && DSHAgentSafeInteger(payload[@"schema_version"], 1, NO) &&
        (payload[@"user_message"] == NSNull.null ||
         DSHAgentBoundedUTF8String(payload[@"user_message"], 2000, YES,
                                   nullptr));
    }
    if (!validFailure) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    return YES;
  }
  if (![outcome isEqualToString:@"ok"] ||
      !DSHAgentSafeInteger(payload[@"schema_version"], 1, NO)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if ([name isEqualToString:@"list_dir"]) {
    if (!DSHAgentExactDictionaryKeys(payload, @[
          @"schema_version", @"entries", @"truncated",
        ]) || ![payload[@"entries"] isKindOfClass:NSArray.class] ||
        [(NSArray *)payload[@"entries"] count] > 1000 ||
        ![payload[@"truncated"] isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)payload[@"truncated"]) != CFBooleanGetTypeID()) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    for (NSDictionary *entry in payload[@"entries"]) {
      if (!DSHAgentExactDictionaryKeys(entry, @[
            @"schema_version", @"name", @"type", @"revision",
          ]) || !DSHAgentSafeInteger(entry[@"schema_version"], 1, NO) ||
          !DSHAgentBoundedUTF8String(entry[@"name"], 4096, NO, nullptr) ||
          (![entry[@"type"] isEqualToString:@"file"] &&
           ![entry[@"type"] isEqualToString:@"directory"]) ||
          !DSHAgentBoundedUTF8String(entry[@"revision"], 256, NO, nullptr)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
        return NO;
      }
    }
    return YES;
  }
  if ([name isEqualToString:@"read_file"]) {
    if (bytes.length > 64 * 1024) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    return DSHAgentExactDictionaryKeys(payload, payload[@"sha256"] == nil
        ? @[@"schema_version", @"content", @"revision", @"truncated"]
        : @[@"schema_version", @"content", @"revision", @"truncated", @"sha256"]) &&
        (payload[@"sha256"] == nil || (DSHAgentCanonicalSHA256(payload[@"sha256"]) && ![payload[@"truncated"] boolValue])) && DSHAgentBoundedUTF8String(payload[@"content"], 64 * 1024, YES,
                                           nullptr) &&
        DSHAgentBoundedUTF8String(payload[@"revision"], 256, NO, nullptr) &&
        [payload[@"truncated"] isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)payload[@"truncated"]) == CFBooleanGetTypeID();
  }
  if ([name isEqualToString:@"write_file"]) {
    return DSHAgentExactDictionaryKeys(payload, payload[@"sha256"] == nil
        ? @[@"schema_version", @"bytes", @"revision"]
        : @[@"schema_version", @"bytes", @"revision", @"sha256"]) &&
        (payload[@"sha256"] == nil || DSHAgentCanonicalSHA256(payload[@"sha256"])) && DSHAgentSafeInteger(payload[@"bytes"], 32768, YES) &&
        DSHAgentBoundedUTF8String(payload[@"revision"], 256, NO, nullptr);
  }
  if ([name isEqualToString:@"start_guest_cgi"] || [name isEqualToString:@"stop_guest_cgi"]) {
    BOOL start = [name isEqualToString:@"start_guest_cgi"];
    if (!DSHAgentExactDictionaryKeys(payload, start ? @[@"schema_version", @"status", @"service_id", @"url"] : @[@"schema_version", @"status", @"service_id"]) || !DSHAgentCanonicalUUID(payload[@"service_id"]) || ![payload[@"status"] isEqual:(start ? @"running" : @"stopped")]) return NO;
    if (!start) return YES;
    if (!DSHAgentBoundedUTF8String(payload[@"url"], 128, NO, nullptr)) return NO;
    NSURLComponents *url = [NSURLComponents componentsWithString:payload[@"url"]];
    return [url.scheme isEqual:@"http"] && [url.host isEqual:@"127.0.0.1"] && url.port.integerValue > 0 && url.port.integerValue <= 65535 && [url.path isEqual:@"/"] && url.user == nil && url.password == nil && url.query == nil && url.fragment == nil;
  }
  if ([name isEqualToString:@"git_status"]) {
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"branch", @"head_oid", @"clean",
             @"has_conflicts", @"entry_count",
           ]) && (payload[@"branch"] == NSNull.null ||
                  DSHAgentBoundedUTF8String(payload[@"branch"], 1024, NO, nullptr)) &&
        (payload[@"head_oid"] == NSNull.null ||
         DSHAgentBoundedUTF8String(payload[@"head_oid"], 128, NO, nullptr)) &&
        [payload[@"clean"] isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)payload[@"clean"]) == CFBooleanGetTypeID() &&
        [payload[@"has_conflicts"] isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)payload[@"has_conflicts"]) == CFBooleanGetTypeID() &&
        DSHAgentSafeInteger(payload[@"entry_count"], 1000000, YES);
  }
  if ([name isEqualToString:@"git_commit"]) {
    return DSHAgentExactDictionaryKeys(payload, @[
             @"schema_version", @"commit_oid", @"tree_oid",
           ]) && DSHAgentBoundedUTF8String(payload[@"commit_oid"], 128, NO, nullptr) &&
        DSHAgentBoundedUTF8String(payload[@"tree_oid"], 128, NO, nullptr);
  }
  if ([name isEqualToString:@"git_push"]) {
    // `remote_oid` is the OID the server advertised after the push was
    // accepted; older feedback without it stays valid.
    BOOL exactKeys = payload[@"remote_oid"] == nil
        ? DSHAgentExactDictionaryKeys(payload, @[
            @"schema_version", @"remote", @"remote_ref", @"pushed_oid",
          ])
        : DSHAgentExactDictionaryKeys(payload, @[
            @"schema_version", @"remote", @"remote_ref", @"pushed_oid",
            @"remote_oid",
          ]) && DSHAgentBoundedUTF8String(payload[@"remote_oid"], 128, NO, nullptr);
    return exactKeys && [payload[@"remote"] isEqualToString:@"origin"] &&
        DSHAgentBoundedUTF8String(payload[@"remote_ref"], 256, NO, nullptr) &&
        DSHAgentBoundedUTF8String(payload[@"pushed_oid"], 128, NO, nullptr);
  }
  DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
  return NO;
}

static BOOL DSHAgentDirectoryIsSafe(NSURL *url) {
  if (url == nil || !url.isFileURL) return NO;
  struct stat metadata = {};
  return lstat(url.fileSystemRepresentation, &metadata) == 0 &&
      S_ISDIR(metadata.st_mode) && !S_ISLNK(metadata.st_mode) &&
      metadata.st_nlink >= 2;
}

static BOOL DSHAgentVerifyFileProtectionDescriptor(int descriptor,
                                                   const struct stat *expected);

static BOOL DSHAgentEnsureDirectory(NSURL *url) {
  if (url == nil || !url.isFileURL) return NO;
  NSURL *parentURL = url.URLByDeletingLastPathComponent;
  int parentDescriptor = open(parentURL.fileSystemRepresentation,
                              O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat parentMetadata = {};
  if (parentDescriptor < 0 || fstat(parentDescriptor, &parentMetadata) != 0 ||
      !S_ISDIR(parentMetadata.st_mode) || parentMetadata.st_nlink < 2) {
    if (parentDescriptor >= 0) close(parentDescriptor);
    return NO;
  }
  struct stat metadata = {};
  BOOL existed = lstat(url.fileSystemRepresentation, &metadata) == 0;
  struct stat initialMetadata = metadata;
  if (existed) {
    if (!S_ISDIR(metadata.st_mode) || S_ISLNK(metadata.st_mode)) {
      close(parentDescriptor);
      return NO;
    }
  } else if (errno == ENOENT) {
    if (mkdir(url.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) {
      close(parentDescriptor);
      return NO;
    }
  } else {
    close(parentDescriptor);
    return NO;
  }
  // All security-sensitive mutation is performed through an opened
  // descriptor.  The final path is re-stat'ed through its opened parent both
  // before and after protection metadata changes, so a path swap cannot turn
  // chmod/protection application into mutation of an attacker-selected
  // directory.
  int descriptor = open(url.fileSystemRepresentation,
                        O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (descriptor < 0) {
    close(parentDescriptor);
    return NO;
  }
  struct stat opened = {};
  BOOL identityOK = fstat(descriptor, &opened) == 0 &&
      S_ISDIR(opened.st_mode) && !S_ISLNK(opened.st_mode) &&
      opened.st_nlink >= 2 &&
      (!existed || (opened.st_dev == initialMetadata.st_dev &&
                    opened.st_ino == initialMetadata.st_ino));
  struct stat fromParent = {};
  identityOK = identityOK &&
      fstatat(parentDescriptor, url.lastPathComponent.UTF8String, &fromParent,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISDIR(fromParent.st_mode) && !S_ISLNK(fromParent.st_mode) &&
      fromParent.st_dev == opened.st_dev && fromParent.st_ino == opened.st_ino &&
      fchmod(descriptor, 0700) == 0;
  if (!identityOK) {
    if (parentDescriptor >= 0) close(parentDescriptor);
    close(descriptor);
    return NO;
  }
  NSError *attributeError = nil;
  // Keep the POSIX mode operation independent from the iOS metadata keys.
  // The simulator filesystem does not implement all NSFileProtection and
  // backup-resource keys, so those requests are best effort there; physical
  // iOS still requires both Complete protection and backup exclusion below.
  BOOL permissions = [[NSFileManager defaultManager]
      setAttributes:@{ NSFilePosixPermissions : @0700 }
       ofItemAtPath:url.path
              error:&attributeError];
  BOOL protection = [[NSFileManager defaultManager]
      setAttributes:@{
        NSFileProtectionKey :
            NSFileProtectionCompleteUntilFirstUserAuthentication
      }
       ofItemAtPath:url.path
              error:&attributeError];
  BOOL excluded = [url setResourceValue:@YES
                                 forKey:NSURLIsExcludedFromBackupKey
                                 error:&attributeError];
#if TARGET_OS_SIMULATOR || TARGET_OS_OSX
  BOOL attributes = permissions;
  (void)protection;
  (void)excluded;
  excluded = YES;
#else
  BOOL attributes = permissions && protection;
#endif
  struct stat after = {};
  struct stat fromParentAfter = {};
  BOOL unchanged = fstat(descriptor, &after) == 0 &&
      fstatat(parentDescriptor, url.lastPathComponent.UTF8String, &fromParentAfter,
              AT_SYMLINK_NOFOLLOW) == 0 &&
      after.st_dev == opened.st_dev && after.st_ino == opened.st_ino &&
      S_ISDIR(fromParentAfter.st_mode) &&
      fromParentAfter.st_dev == opened.st_dev &&
      fromParentAfter.st_ino == opened.st_ino &&
      (after.st_mode & 0777) == 0700;
  BOOL protectionOK = unchanged &&
      DSHAgentVerifyFileProtectionDescriptor(descriptor, &opened);
  close(parentDescriptor);
  close(descriptor);
  return attributes && excluded && unchanged && protectionOK;
}

static BOOL DSHAgentWriteAll(int descriptor, NSData *data) {
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger offset = 0;
  while (offset < data.length) {
    ssize_t written = write(descriptor, bytes + offset, data.length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return NO;
    offset += (NSUInteger)written;
  }
  return fsync(descriptor) == 0;
}

static int DSHAgentOpenRootDescriptor(NSURL *rootURL) {
  if (rootURL == nil || !rootURL.isFileURL) return -1;
  int descriptor = open(rootURL.fileSystemRepresentation,
                        O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (descriptor < 0) return -1;
  int parentDescriptor = open(rootURL.URLByDeletingLastPathComponent.fileSystemRepresentation,
                              O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat opened = {};
  struct stat fromParent = {};
  BOOL identityOK = parentDescriptor >= 0 && fstat(descriptor, &opened) == 0 &&
      S_ISDIR(opened.st_mode) && !S_ISLNK(opened.st_mode) &&
      opened.st_nlink >= 2 &&
      fstatat(parentDescriptor, rootURL.lastPathComponent.UTF8String, &fromParent,
              AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(fromParent.st_mode) &&
      !S_ISLNK(fromParent.st_mode) && fromParent.st_dev == opened.st_dev &&
      fromParent.st_ino == opened.st_ino;
  if (parentDescriptor >= 0) close(parentDescriptor);
  if (!identityOK) {
    close(descriptor);
    return -1;
  }
  return descriptor;
}

static BOOL DSHAgentRegularFileIdentity(struct stat metadata) {
  return S_ISREG(metadata.st_mode) && !S_ISLNK(metadata.st_mode) &&
      metadata.st_nlink == 1 && (metadata.st_mode & 0777) == 0600;
}

static BOOL DSHAgentVerifyFileProtectionDescriptor(int descriptor,
                                                   const struct stat *expected) {
  if (descriptor < 0) return NO;
  struct stat opened = {};
  if (fstat(descriptor, &opened) != 0 ||
      (expected != nullptr &&
       (opened.st_dev != expected->st_dev || opened.st_ino != expected->st_ino))) {
    return NO;
  }
  char resolvedPath[PATH_MAX] = {};
  if (fcntl(descriptor, F_GETPATH, resolvedPath) != 0) return NO;
  NSURL *descriptorURL = [NSURL fileURLWithPath:
      [[NSFileManager defaultManager]
          stringWithFileSystemRepresentation:resolvedPath
                                       length:strlen(resolvedPath)]];
  struct stat pathBefore = {};
  if (lstat(resolvedPath, &pathBefore) != 0 ||
      (!S_ISREG(pathBefore.st_mode) && !S_ISDIR(pathBefore.st_mode)) ||
      S_ISLNK(pathBefore.st_mode) || pathBefore.st_dev != opened.st_dev ||
      pathBefore.st_ino != opened.st_ino) {
    return NO;
  }
  id protection = nil;
  BOOL protectionRead = [descriptorURL getResourceValue:&protection
                                                  forKey:NSURLFileProtectionKey
                                                   error:nil];
  NSNumber *excluded = nil;
  BOOL excludedRead = [descriptorURL getResourceValue:&excluded
                                                forKey:NSURLIsExcludedFromBackupKey
                                                 error:nil];
#if TARGET_OS_OSX
  (void)protectionRead;
  (void)protection;
  (void)excludedRead;
  (void)excluded;
#elif TARGET_OS_SIMULATOR
  // Simulator filesystems may report an unsupported protection/backup key as
  // a readable default (for example, `excluded = NO`) or return no value at
  // all.  These metadata values are not security evidence in the simulator;
  // mode, descriptor identity, and no-follow checks above remain mandatory.
  (void)protectionRead;
  (void)protection;
  (void)excludedRead;
  (void)excluded;
#else
  BOOL protectionOK = !protectionRead || protection == nil ||
      [protection
          isEqual:NSURLFileProtectionCompleteUntilFirstUserAuthentication];
  BOOL backupOK = !excludedRead || excluded == nil || excluded.boolValue;
  if (!protectionOK || !backupOK) return NO;
#endif
  struct stat after = {};
  struct stat pathAfter = {};
  int descriptorResult = fstat(descriptor, &after);
  int pathResult = lstat(resolvedPath, &pathAfter);
  BOOL descriptorIdentity = descriptorResult == 0 &&
      after.st_dev == opened.st_dev && after.st_ino == opened.st_ino;
  BOOL pathIdentity = pathResult == 0 &&
      pathAfter.st_dev == opened.st_dev && pathAfter.st_ino == opened.st_ino;
  BOOL modeIdentity = pathResult == 0 &&
      pathAfter.st_mode == pathBefore.st_mode;
  return descriptorIdentity && pathIdentity && modeIdentity;
}

static NSData *DSHAgentReadDescriptor(int descriptor,
                                      NSUInteger maximum,
                                      NSError **error) {
  NSMutableData *data = [NSMutableData dataWithCapacity:4096];
  uint8_t buffer[16 * 1024];
  while (YES) {
    ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count == 0) break;
    if (count < 0 || data.length > maximum - (NSUInteger)count) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return nil;
    }
    [data appendBytes:buffer length:(NSUInteger)count];
  }
  return data;
}

static NSData *DSHAgentReadWALAtRoot(int rootDescriptor,
                                     const char *name,
                                     NSError **error) {
  struct stat metadata = {};
  if (fstatat(rootDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return nil;
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  if (!DSHAgentRegularFileIdentity(metadata)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  int descriptor = openat(rootDescriptor, name, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  struct stat opened = {};
  BOOL valid = fstat(descriptor, &opened) == 0 &&
      DSHAgentRegularFileIdentity(opened) && opened.st_dev == metadata.st_dev &&
      opened.st_ino == metadata.st_ino &&
      DSHAgentVerifyFileProtectionDescriptor(descriptor, &opened);
  NSData *data = valid ? DSHAgentReadDescriptor(descriptor,
                                                DSHAgentNativeWALMaxStoreBytes,
                                                error) : nil;
  struct stat after = {};
  valid = valid && fstat(descriptor, &after) == 0 &&
      after.st_dev == opened.st_dev && after.st_ino == opened.st_ino &&
      after.st_size == opened.st_size;
  close(descriptor);
  if (!valid || data == nil) {
    if (error == nullptr || *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    }
    return nil;
  }
  return data;
}

static NSRecursiveLock *DSHAgentLockForRoot(NSURL *rootURL) {
  static NSMutableDictionary<NSString *, NSRecursiveLock *> *locks;
  static NSLock *guard;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    locks = [NSMutableDictionary dictionary];
    guard = [[NSLock alloc] init];
  });
  NSString *key = rootURL.path.stringByStandardizingPath ?: @"<invalid>";
  [guard lock];
  NSRecursiveLock *lock = locks[key];
  if (lock == nil) {
    lock = [[NSRecursiveLock alloc] init];
    locks[key] = lock;
  }
  [guard unlock];
  return lock;
}

static NSMutableDictionary *DSHAgentFreshWALState(void) {
  return [@{
    @"schema_version" : @2,
    @"generation" : @0,
    @"authorities" : @[],
    @"operations" : @[],
    @"operation_results" : @[],
    @"transcripts" : @[],
    @"rounds" : @[],
    @"ledger" : @[],
    @"reservations" : @[],
    @"cleanup" : @[],
    @"dispatch" : @[],
    @"batches" : @[],
    @"denied_calls" : @[],
  } mutableCopy];
}

static NSUInteger DSHAgentAttemptCount(NSArray *rows, NSString *attemptID) {
  NSUInteger count = 0;
  for (NSDictionary *row in rows) {
    if (![row isKindOfClass:NSDictionary.class]) continue;
    NSDictionary *locator = row[@"locator"];
    if ([locator isKindOfClass:NSDictionary.class] &&
        [locator[@"attempt_id"] isEqual:attemptID]) {
      count += 1;
    }
  }
  return count;
}

static BOOL DSHAgentWALReferenceShape(NSDictionary *reference) {
  return DSHAgentExactDictionaryKeys(reference, @[
    @"schema_version", @"transcript_ref", @"generation",
    @"transcript_sha256", @"transcript_bytes",
  ]) && DSHAgentSafeInteger(reference[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(reference[@"transcript_ref"]) &&
      DSHAgentSafeInteger(reference[@"generation"], DSHAgentMaximumSafeInteger, YES) &&
      DSHAgentCanonicalSHA256(reference[@"transcript_sha256"]) &&
      DSHAgentSafeInteger(reference[@"transcript_bytes"],
                          DSHAgentNativeWALMaxTranscriptBytes, YES);
}

static BOOL DSHAgentWALTranscriptBound(NSDictionary *state,
                                       NSDictionary *row) {
  NSDictionary *before = row[@"transcript_before"];
  NSString *stateName = row[@"state"];
  if (![stateName isKindOfClass:NSString.class] ||
      ![before isKindOfClass:NSDictionary.class]) return NO;
  if (([stateName isEqualToString:@"completed"] ||
       [stateName isEqualToString:@"settled"] ||
       [stateName isEqualToString:@"cancelled"] ||
       [stateName isEqualToString:@"ambiguous"]) &&
      row[@"transcript_after"] != NSNull.null) {
    before = row[@"transcript_after"];
  }
  NSDictionary *locator = row[@"locator"];
  for (NSDictionary *transcript in state[@"transcripts"]) {
    if ([transcript[@"transcript_ref"] isEqual:before[@"transcript_ref"]] &&
        [transcript[@"attempt_id"] isEqual:locator[@"attempt_id"]] &&
        [transcript[@"root_fingerprint_sha256"]
            isEqual:row[@"root_fingerprint_sha256"]] &&
        (([transcript[@"generation"] isEqual:before[@"generation"]] &&
          [transcript[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] &&
          [transcript[@"transcript_bytes"] isEqual:before[@"transcript_bytes"]]) ||
         ([transcript[@"generation"] unsignedIntegerValue] >
              [before[@"generation"] unsignedIntegerValue]) ||
         (row[@"transcript_after"] == NSNull.null &&
          (![stateName isEqualToString:@"intent"] &&
           ![stateName isEqualToString:@"running"] &&
           ![stateName isEqualToString:@"in_flight"] &&
           ![stateName isEqualToString:@"cancel_requested"])))) {
      return YES;
    }
  }
  return NO;
}

static BOOL DSHAgentWALCanonicalFeedbackString(NSString *value) {
  NSData *contentBytes = [value dataUsingEncoding:NSUTF8StringEncoding];
  if (contentBytes == nil || contentBytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
    return NO;
  }
  NSError *contentError = nil;
  id contentObject = [NSJSONSerialization JSONObjectWithData:contentBytes
                                                        options:0
                                                          error:&contentError];
  NSData *canonicalContent = DSHAgentCanonicalJSON(contentObject, &contentError);
  return canonicalContent != nil && [canonicalContent isEqualToData:contentBytes];
}

static BOOL DSHAgentWALMessageShape(NSDictionary *message) {
  if (![message isKindOfClass:NSDictionary.class]) return NO;
  NSString *role = message[@"role"];
  if (!DSHAgentSafeInteger(message[@"schema_version"], 1, NO) ||
      !DSHAgentSafeInteger(message[@"round_index"], 7, YES) ||
      ![role isKindOfClass:NSString.class]) {
    return NO;
  }
  if ([role isEqualToString:@"assistant"]) {
    if (!DSHAgentExactDictionaryKeys(message, @[
          @"schema_version", @"role", @"round_index", @"content",
          @"reasoning_content", @"tool_calls",
        ]) ||
        !DSHAgentBoundedUTF8String(message[@"content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        !DSHAgentBoundedUTF8String(message[@"reasoning_content"],
                                   DSHAgentNativeWALMaxTranscriptBytes, YES,
                                   nullptr) ||
        ![message[@"tool_calls"] isKindOfClass:NSArray.class] ||
        [(NSArray *)message[@"tool_calls"] count] > 16) {
      return NO;
    }
    for (NSDictionary *call in message[@"tool_calls"]) {
      if (!DSHAgentExactDictionaryKeys(call, @[
            @"schema_version", @"call_id", @"name", @"arguments_json",
          ]) ||
          !DSHAgentSafeInteger(call[@"schema_version"], 1, NO) ||
          !DSHAgentBoundedUTF8String(call[@"call_id"], 128, NO, nullptr) ||
          !DSHAgentBoundedUTF8String(call[@"name"], 64, NO, nullptr) ||
          !DSHAgentParseArgumentsJSON(call[@"arguments_json"], nullptr)) {
        return NO;
      }
      NSCharacterSet *callInvalid = [[NSCharacterSet
          characterSetWithCharactersInString:
              @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
          invertedSet];
      NSCharacterSet *nameInvalid = [[NSCharacterSet
          characterSetWithCharactersInString:
              @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
          invertedSet];
      if ([call[@"call_id"] rangeOfCharacterFromSet:callInvalid].location !=
              NSNotFound ||
          [call[@"name"] rangeOfCharacterFromSet:nameInvalid].location != NSNotFound) {
        return NO;
      }
    }
    return YES;
  }
  NSCharacterSet *toolCallInvalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  return [role isEqualToString:@"tool"] &&
      DSHAgentExactDictionaryKeys(message, @[
        @"schema_version", @"role", @"round_index", @"call_id",
        @"content", @"truncated",
      ]) &&
      DSHAgentBoundedUTF8String(message[@"call_id"], 128, NO, nullptr) &&
      [message[@"call_id"] rangeOfCharacterFromSet:toolCallInvalid].location ==
          NSNotFound &&
      DSHAgentBoundedUTF8String(message[@"content"],
                                DSHAgentNativeWALMaxTranscriptBytes, YES,
                                nullptr) &&
      DSHAgentWALCanonicalFeedbackString(message[@"content"]) &&
      DSHAgentValidateNativeToolFeedbackString(message[@"content"], nullptr) &&
      [message[@"truncated"] isKindOfClass:NSNumber.class] &&
      CFGetTypeID((__bridge CFTypeRef)message[@"truncated"]) ==
          CFBooleanGetTypeID();
}

static BOOL DSHAgentWALReservationShape(NSDictionary *reservation) {
  if (!DSHAgentExactDictionaryKeys(reservation, @[
        @"schema_version", @"task_id", @"attempt_id",
        @"root_fingerprint_sha256", @"binding_revision", @"policy",
        @"reserved_write_bytes", @"reservation_version", @"keys",
      ]) || !DSHAgentSafeInteger(reservation[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(reservation[@"task_id"]) ||
      !DSHAgentCanonicalUUID(reservation[@"attempt_id"]) ||
      !DSHAgentCanonicalSHA256(reservation[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(reservation[@"binding_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      ![reservation[@"policy"] isKindOfClass:NSDictionary.class] ||
      !DSHAgentSafeInteger(reservation[@"reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      !DSHAgentSafeInteger(reservation[@"reservation_version"],
                          DSHAgentMaximumSafeInteger, YES) ||
      ![reservation[@"keys"] isKindOfClass:NSArray.class] ||
      [(NSArray *)reservation[@"keys"] count] > 128) {
    return NO;
  }
  NSDictionary *policy = reservation[@"policy"];
  if (!DSHAgentExactDictionaryKeys(policy, @[
        @"schema_version", @"policy_version", @"max_single_write_bytes",
        @"max_batch_write_bytes", @"max_attempt_write_bytes",
      ]) || !DSHAgentSafeInteger(policy[@"schema_version"], 1, NO) ||
      !DSHAgentBoundedUTF8String(policy[@"policy_version"], 128, NO, nullptr) ||
      !DSHAgentSafeInteger(policy[@"max_single_write_bytes"],
                          DSHAgentNativeWALMaxSingleWriteBytes, NO) ||
      [policy[@"max_single_write_bytes"] unsignedIntegerValue] !=
          DSHAgentNativeWALMaxSingleWriteBytes ||
      !DSHAgentSafeInteger(policy[@"max_batch_write_bytes"],
                          DSHAgentNativeWALMaxBatchWriteBytes, NO) ||
      [policy[@"max_batch_write_bytes"] unsignedIntegerValue] <
          DSHAgentNativeWALMaxSingleWriteBytes ||
      !DSHAgentSafeInteger(policy[@"max_attempt_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, NO) ||
      [policy[@"max_attempt_write_bytes"] unsignedIntegerValue] <
          [policy[@"max_batch_write_bytes"] unsignedIntegerValue]) {
    return NO;
  }
  NSMutableSet *seen = [NSMutableSet set];
  NSUInteger activeBytes = 0;
  for (NSDictionary *key in reservation[@"keys"]) {
    if (!DSHAgentExactDictionaryKeys(key, @[
          @"idempotency_key", @"relative_path_sha256", @"content_sha256",
          @"content_bytes", @"state",
        ]) || !DSHAgentCanonicalSHA256(key[@"idempotency_key"]) ||
        !DSHAgentCanonicalSHA256(key[@"relative_path_sha256"]) ||
        !DSHAgentCanonicalSHA256(key[@"content_sha256"]) ||
        !DSHAgentSafeInteger(key[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
        ![key[@"state"] isKindOfClass:NSString.class] ||
        (![key[@"state"] isEqualToString:@"active"] &&
         ![key[@"state"] isEqualToString:@"released"]) ||
        [seen containsObject:key[@"idempotency_key"]]) {
      return NO;
    }
    [seen addObject:key[@"idempotency_key"]];
    if ([key[@"state"] isEqualToString:@"active"]) {
      NSUInteger bytes = [key[@"content_bytes"] unsignedIntegerValue];
      if (activeBytes > DSHAgentNativeWALMaxAttemptWriteBytes - bytes) return NO;
      activeBytes += bytes;
    }
  }
  return activeBytes == [reservation[@"reserved_write_bytes"] unsignedIntegerValue];
}

static BOOL DSHAgentWALCleanupShape(NSDictionary *cleanup) {
  return DSHAgentExactDictionaryKeys(cleanup, @[
    @"schema_version", @"cleanup_id", @"attempt_id", @"transcript_ref",
    @"transcript_sha256", @"cleanup_owner", @"reason", @"created_at",
    @"status",
  ]) && DSHAgentSafeInteger(cleanup[@"schema_version"], 1, NO) &&
      DSHAgentCanonicalUUID(cleanup[@"cleanup_id"]) &&
      DSHAgentCanonicalUUID(cleanup[@"attempt_id"]) &&
      DSHAgentCanonicalUUID(cleanup[@"transcript_ref"]) &&
      DSHAgentCanonicalSHA256(cleanup[@"transcript_sha256"]) &&
      DSHAgentCanonicalUUID(cleanup[@"cleanup_owner"]) &&
      DSHAgentCanonicalTimestamp(cleanup[@"created_at"]) &&
      [cleanup[@"reason"] isKindOfClass:NSString.class] &&
      [cleanup[@"status"] isKindOfClass:NSString.class] &&
      ([cleanup[@"reason"] isEqualToString:@"completed"] ||
       [cleanup[@"reason"] isEqualToString:@"cancelled"] ||
       [cleanup[@"reason"] isEqualToString:@"failed"] ||
       [cleanup[@"reason"] isEqualToString:@"conversation_deleted"]) &&
      ([cleanup[@"status"] isEqualToString:@"pending"] ||
       [cleanup[@"status"] isEqualToString:@"discarded"]);
}

static BOOL DSHAgentWALDispatchShape(NSDictionary *dispatch) {
  if (!DSHAgentExactDictionaryKeys(dispatch, @[
        @"schema_version", @"kind", @"locator", @"dispatch_state",
      ]) || !DSHAgentSafeInteger(dispatch[@"schema_version"], 1, NO) ||
      ![dispatch[@"kind"] isKindOfClass:NSString.class] ||
      ![dispatch[@"dispatch_state"] isKindOfClass:NSString.class] ||
      (![dispatch[@"kind"] isEqualToString:@"round"] &&
       ![dispatch[@"kind"] isEqualToString:@"execution"]) ||
      ![dispatch[@"locator"] isKindOfClass:NSDictionary.class] ||
      (![dispatch[@"dispatch_state"] isEqualToString:@"not_dispatched"] &&
       ![dispatch[@"dispatch_state"] isEqualToString:@"dispatched"])) {
    return NO;
  }
  NSDictionary *locator = dispatch[@"locator"];
  if ([dispatch[@"kind"] isEqualToString:@"round"]) {
    return DSHAgentExactDictionaryKeys(locator, @[
             @"schema_version", @"task_id", @"attempt_id", @"round_id",
             @"round_index",
           ]) && [locator[@"schema_version"] isEqual:@1] &&
        DSHAgentCanonicalUUID(locator[@"task_id"]) &&
        DSHAgentCanonicalUUID(locator[@"attempt_id"]) &&
        DSHAgentCanonicalUUID(locator[@"round_id"]) &&
        DSHAgentSafeInteger(locator[@"round_index"], 7, YES);
  }
  return DSHAgentExactDictionaryKeys(locator, @[
           @"schema_version", @"task_id", @"attempt_id", @"round_id",
           @"round_index", @"call_index", @"call_id", @"idempotency_key",
         ]) && [locator[@"schema_version"] isEqual:@2] &&
      DSHAgentCanonicalUUID(locator[@"task_id"]) &&
      DSHAgentCanonicalUUID(locator[@"attempt_id"]) &&
      DSHAgentCanonicalUUID(locator[@"round_id"]) &&
      DSHAgentSafeInteger(locator[@"round_index"], 7, YES) &&
      DSHAgentSafeInteger(locator[@"call_index"], 15, YES) &&
      DSHAgentBoundedUTF8String(locator[@"call_id"], 128, NO, nullptr) &&
      DSHAgentCanonicalSHA256(locator[@"idempotency_key"]);
}

static NSData *DSHAgentCanonicalIdentityKey(id value);

static BOOL DSHAgentWALWritePriorShape(NSDictionary *prior) {
  if (![prior isKindOfClass:NSDictionary.class]) return NO;
  NSString *kind = prior[@"kind"];
  if (![kind isKindOfClass:NSString.class]) return NO;
  if ([kind isEqualToString:@"absent"]) {
    return DSHAgentExactDictionaryKeys(prior, @[@"schema_version", @"kind"]) &&
        DSHAgentSafeInteger(prior[@"schema_version"], 1, NO);
  }
  if ([kind isEqualToString:@"known"]) {
    return DSHAgentExactDictionaryKeys(prior, @[
      @"schema_version", @"kind", @"revision",
    ]) && DSHAgentSafeInteger(prior[@"schema_version"], 1, NO) &&
        DSHAgentBoundedUTF8String(prior[@"revision"], 256, NO, nullptr);
  }
  return [kind isEqualToString:@"unknown"] &&
      DSHAgentExactDictionaryKeys(prior, @[
        @"schema_version", @"kind", @"failure_code",
      ]) && DSHAgentSafeInteger(prior[@"schema_version"], 1, NO) &&
      DSHAgentFailureCode(prior[@"failure_code"]);
}

static BOOL DSHAgentWALOpaqueCallID(id value) {
  if (!DSHAgentBoundedUTF8String(value, 128, NO, nullptr)) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"]
      invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHAgentWALRootShape(NSDictionary *root) {
  if (!DSHAgentExactDictionaryKeys(root, @[
        @"schema_version", @"kind", @"workspace_id",
        @"workspace_binding_revision", @"project_id",
        @"root_fingerprint_sha256", @"capabilities",
      ]) || ![root[@"schema_version"] isEqual:@1] ||
      !DSHAgentCanonicalUUID(root[@"workspace_id"]) ||
      !DSHAgentSafeInteger(root[@"workspace_binding_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalSHA256(root[@"root_fingerprint_sha256"]) ||
      ![root[@"capabilities"] isKindOfClass:NSArray.class] ||
      [(NSArray *)root[@"capabilities"] count] > 6) {
    return NO;
  }
  NSString *kind = root[@"kind"];
  id projectID = root[@"project_id"];
  if (![kind isEqualToString:@"project"] &&
      ![kind isEqualToString:@"workspace"]) return NO;
  if ([kind isEqualToString:@"project"] &&
      !DSHAgentCanonicalUUID(projectID)) return NO;
  if ([kind isEqualToString:@"workspace"] && projectID != NSNull.null) return NO;
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push", @"guest_service",
  ]];
  NSMutableSet *seen = [NSMutableSet set];
  for (id capability in root[@"capabilities"]) {
    if (![capability isKindOfClass:NSString.class] ||
        ![allowed containsObject:capability] || [seen containsObject:capability] ||
        ([kind isEqualToString:@"workspace"] &&
         [(NSString *)capability hasPrefix:@"git_"])) return NO;
    [seen addObject:capability];
  }
  return YES;
}

static BOOL DSHAgentWALPolicyShape(NSDictionary *policy) {
  if (!DSHAgentExactDictionaryKeys(policy, @[
        @"schema_version", @"policy_version", @"max_single_write_bytes",
        @"max_batch_write_bytes", @"max_attempt_write_bytes",
      ]) || ![policy[@"schema_version"] isEqual:@1] ||
      ![policy[@"policy_version"] isEqualToString:@"agent-v1"] ||
      ![policy[@"max_single_write_bytes"]
          isEqual:@(DSHAgentNativeWALMaxSingleWriteBytes)] ||
      !DSHAgentSafeInteger(policy[@"max_batch_write_bytes"],
                          DSHAgentNativeWALMaxBatchWriteBytes, NO) ||
      [policy[@"max_batch_write_bytes"] unsignedIntegerValue] <
          DSHAgentNativeWALMaxSingleWriteBytes ||
      !DSHAgentSafeInteger(policy[@"max_attempt_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, NO) ||
      [policy[@"max_attempt_write_bytes"] unsignedIntegerValue] <
          [policy[@"max_batch_write_bytes"] unsignedIntegerValue]) {
    return NO;
  }
  return YES;
}

static BOOL DSHAgentWALRegistryShape(NSDictionary *registry) {
  if (!DSHAgentExactDictionaryKeys(registry, @[
        @"schema_version", @"registry_version", @"toolset_sha256", @"tools",
      ]) || ![registry[@"schema_version"] isEqual:@2] ||
      (![registry[@"registry_version"] isEqual:@1] &&
       ![registry[@"registry_version"] isEqual:@2]) ||
      !DSHAgentCanonicalSHA256(registry[@"toolset_sha256"]) ||
      ![registry[@"tools"] isKindOfClass:NSArray.class] ||
      [(NSArray *)registry[@"tools"] count] > 8) return NO;
  NSSet *names = [NSSet setWithArray:@[
    @"list_dir", @"read_file", @"write_file", @"git_status", @"git_commit",
    @"git_push", @"start_guest_cgi", @"stop_guest_cgi",
  ]];
  NSMutableSet *seen = [NSMutableSet set];
  NSString *previous = nil;
  for (NSDictionary *tool in registry[@"tools"]) {
    if (!DSHAgentExactDictionaryKeys(tool, @[
          @"schema_version", @"name", @"safe_summary_key", @"access",
        ]) || ![tool[@"schema_version"] isEqual:@2] ||
        ![names containsObject:tool[@"name"]] ||
        [seen containsObject:tool[@"name"]] ||
        !DSHAgentBoundedUTF8String(tool[@"safe_summary_key"], 128, NO, nullptr) ||
        (![tool[@"access"] isEqualToString:@"auto"] &&
         ![tool[@"access"] isEqualToString:@"conversation_confirm"] &&
         ![tool[@"access"] isEqualToString:@"confirm_once"] &&
         ![tool[@"access"] isEqualToString:@"durable_deny"]) ||
        (previous != nil && [previous compare:tool[@"name"]
                                    options:NSLiteralSearch] != NSOrderedAscending)) {
      return NO;
    }
    previous = tool[@"name"];
    [seen addObject:tool[@"name"]];
  }
  return YES;
}

static BOOL DSHAgentWALAuthorityShape(NSDictionary *authority) {
  if (!DSHAgentExactDictionaryKeys(authority, @[
        @"schema_version", @"task_id", @"conversation_id", @"attempt_id",
        @"root", @"policy", @"registry", @"transport_schema_version", @"model",
        @"thinking_mode", @"visible_message_ids", @"visible_history_sha256",
        @"visible_message_count", @"project_context_sha256", @"transcript",
        @"reserved_write_bytes", @"authority_revision", @"state", @"cleanup_id",
        @"created_at", @"updated_at",
      ]) || ![authority[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(authority[@"task_id"]) ||
      !DSHAgentCanonicalUUID(authority[@"conversation_id"]) ||
      !DSHAgentCanonicalUUID(authority[@"attempt_id"]) ||
      !DSHAgentWALRootShape(authority[@"root"]) ||
      !DSHAgentWALPolicyShape(authority[@"policy"]) ||
      !DSHAgentWALRegistryShape(authority[@"registry"]) ||
      (![authority[@"transport_schema_version"] isEqual:@2] &&
       ![authority[@"transport_schema_version"] isEqual:@3]) ||
      !DSHAgentBoundedUTF8String(authority[@"model"], 128, NO, nullptr) ||
      !DSHAgentBoundedUTF8String(authority[@"thinking_mode"], 32, NO, nullptr) ||
      ![authority[@"visible_message_ids"] isKindOfClass:NSArray.class] ||
      [(NSArray *)authority[@"visible_message_ids"] count] > 96 ||
      !DSHAgentCanonicalSHA256(authority[@"visible_history_sha256"]) ||
      !DSHAgentSafeInteger(authority[@"visible_message_count"], 96, YES) ||
      [(NSArray *)authority[@"visible_message_ids"] count] !=
          [authority[@"visible_message_count"] unsignedIntegerValue] ||
      !(authority[@"project_context_sha256"] == NSNull.null ||
        DSHAgentCanonicalSHA256(authority[@"project_context_sha256"])) ||
      !DSHAgentWALReferenceShape(authority[@"transcript"]) ||
      !DSHAgentSafeInteger(authority[@"reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      !DSHAgentSafeInteger(authority[@"authority_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalTimestamp(authority[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(authority[@"updated_at"])) return NO;
  NSSet *models = DSHHarnessSupportedModels();
  static NSSet *thinkingModes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    thinkingModes = [NSSet setWithArray:@[@"off", @"high", @"max"]];
  });
  if (![models containsObject:authority[@"model"]] ||
      ![thinkingModes containsObject:authority[@"thinking_mode"]]) return NO;
  NSDictionary *root = authority[@"root"];
  NSSet *capabilities = [NSSet setWithArray:root[@"capabilities"]];
  NSMutableDictionary<NSString *, NSString *> *expectedTools =
      [NSMutableDictionary dictionary];
  if ([capabilities containsObject:@"file_read"]) {
    expectedTools[@"list_dir"] = @"auto";
    expectedTools[@"read_file"] = @"auto";
  }
  if ([capabilities containsObject:@"file_write"]) {
    expectedTools[@"write_file"] = @"conversation_confirm";
  }
  if ([root[@"kind"] isEqualToString:@"project"] &&
      [capabilities containsObject:@"git_status"]) {
    expectedTools[@"git_status"] = @"auto";
  }
  if ([root[@"kind"] isEqualToString:@"project"] &&
      [capabilities containsObject:@"git_commit"]) {
    expectedTools[@"git_commit"] = @"conversation_confirm";
  }
  if ([root[@"kind"] isEqualToString:@"project"] &&
      [capabilities containsObject:@"git_push"]) {
    // git_push follows the git_commit pattern (see AgentToolRegistry).
    expectedTools[@"git_push"] = @"conversation_confirm";
  }
  if ([capabilities containsObject:@"guest_service"]) {
    if (![authority[@"registry"][@"registry_version"] isEqual:@2]) return NO;
    expectedTools[@"start_guest_cgi"] = @"conversation_confirm";
    expectedTools[@"stop_guest_cgi"] = @"conversation_confirm";
  }
  if (expectedTools.count != [(NSArray *)authority[@"registry"][@"tools"] count]) {
    return NO;
  }
  for (NSDictionary *tool in authority[@"registry"][@"tools"]) {
    if ([expectedTools[tool[@"name"]] isEqual:tool[@"access"]]) continue;
    // Authorities prepared by builds that registered git_push as once-only
    // stay readable; the pulled device evidence fixtures carry that shape.
    if ([tool[@"name"] isEqualToString:@"git_push"] &&
        [tool[@"access"] isEqualToString:@"confirm_once"]) continue;
    return NO;
  }
  if ([authority[@"transport_schema_version"] isEqual:@3]) {
    if (![root[@"kind"] isEqualToString:@"project"] ||
        root[@"project_id"] == NSNull.null ||
        !DSHAgentCanonicalSHA256(authority[@"project_context_sha256"])) return NO;
  } else if (authority[@"project_context_sha256"] != NSNull.null) {
    return NO;
  }
  NSMutableSet *visibleIDs = [NSMutableSet set];
  for (id visibleID in authority[@"visible_message_ids"]) {
    if (!DSHAgentCanonicalUUID(visibleID) || [visibleIDs containsObject:visibleID]) {
      return NO;
    }
    [visibleIDs addObject:visibleID];
  }
  NSString *state = authority[@"state"];
  if (([state isEqualToString:@"prepared"] || [state isEqualToString:@"terminal"]) &&
      authority[@"cleanup_id"] == NSNull.null) return YES;
  return [state isEqualToString:@"cleanup_pending"] &&
      DSHAgentCanonicalUUID(authority[@"cleanup_id"]);
}

static NSSet<NSString *> *DSHAgentWALOperationKinds(void) {
  static NSSet<NSString *> *values;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    values = [NSSet setWithArray:@[
      @"prepare_agent_attempt", @"complete_agent_round_v2",
      @"prepare_agent_tool_batch", @"bind_agent_approval",
      @"execute_agent_tool", @"cancel_agent_attempt", @"recover_agent_attempt",
      @"finalize_agent_attempt", @"discard_agent_attempt",
      @"interrupt_agent_attempt",
    ]];
  });
  return values;
}

static NSSet<NSString *> *DSHAgentWALOperationResultStatuses(void) {
  static NSSet<NSString *> *values;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    values = [NSSet setWithArray:@[
      @"prepared", @"already_prepared", @"not_agent", @"completed", @"in_flight",
      @"failed_retryable", @"failed", @"cancel_requested", @"cancelled", @"unknown",
      @"ambiguous", @"rejected", @"bound", @"already_bound", @"running",
      @"denied", @"retryable", @"resumed", @"manual_reconciliation", @"terminal",
      @"discarded", @"already_missing", @"pending", @"conflict",
    ]];
  });
  return values;
}

static BOOL DSHAgentWALKnownOperationResultStatus(NSString *status) {
  return [DSHAgentWALOperationResultStatuses() containsObject:status] ||
      [status isEqualToString:@"settled"] ||
      [status isEqualToString:@"already_terminal"];
}

static BOOL DSHAgentWALOperationResultStatusAllowed(NSString *operationKind,
                                                    NSString *status) {
  if ([status isEqualToString:@"settled"]) {
    return [operationKind isEqualToString:@"cancel_agent_attempt"];
  }
  if ([status isEqualToString:@"already_terminal"]) {
    return [operationKind isEqualToString:@"finalize_agent_attempt"];
  }
  return [DSHAgentWALOperationResultStatuses() containsObject:status];
}

static BOOL DSHAgentWALResultReferenceShape(NSDictionary *reference) {
  if (![reference isKindOfClass:NSDictionary.class] ||
      ![reference[@"schema_version"] isEqual:@2] ||
      ![reference[@"kind"] isKindOfClass:NSString.class]) return NO;
  NSString *kind = reference[@"kind"];
  if ([kind isEqualToString:@"none"]) {
    return DSHAgentExactDictionaryKeys(reference, @[@"schema_version", @"kind"]);
  }
  if ([kind isEqualToString:@"cleanup"]) {
    return DSHAgentExactDictionaryKeys(reference, @[
      @"schema_version", @"kind", @"cleanup_id",
    ]) && DSHAgentCanonicalUUID(reference[@"cleanup_id"]);
  }
  NSMutableArray *keys = [NSMutableArray arrayWithArray:@[
    @"schema_version", @"kind", @"task_id", @"attempt_id",
  ]];
  if (!DSHAgentCanonicalUUID(reference[@"task_id"]) ||
      !DSHAgentCanonicalUUID(reference[@"attempt_id"])) return NO;
  if ([kind isEqualToString:@"authority"]) {
    [keys addObject:@"authority_revision"];
    return DSHAgentExactDictionaryKeys(reference, keys) &&
        DSHAgentSafeInteger(reference[@"authority_revision"],
                            DSHAgentMaximumSafeInteger, NO);
  }
  [keys addObjectsFromArray:@[@"round_id", @"round_index"]];
  if (!DSHAgentCanonicalUUID(reference[@"round_id"]) ||
      !DSHAgentSafeInteger(reference[@"round_index"], 7, YES)) return NO;
  if ([kind isEqualToString:@"round"] || [kind isEqualToString:@"batch"]) {
    NSString *revisionKey = [kind isEqualToString:@"round"]
        ? @"round_revision" : @"batch_revision";
    [keys addObject:revisionKey];
    return DSHAgentExactDictionaryKeys(reference, keys) &&
        DSHAgentSafeInteger(reference[revisionKey], DSHAgentMaximumSafeInteger, NO);
  }
  if (![kind isEqualToString:@"approval"] &&
      ![kind isEqualToString:@"tool"] &&
      ![kind isEqualToString:@"denied_call"]) return NO;
  [keys addObjectsFromArray:@[@"call_index", @"call_id"]];
  if (!DSHAgentSafeInteger(reference[@"call_index"], 15, YES) ||
      !DSHAgentWALOpaqueCallID(reference[@"call_id"])) return NO;
  NSString *revisionKey = [kind isEqualToString:@"approval"] ? @"batch_revision" :
      ([kind isEqualToString:@"tool"] ? @"execution_revision" :
       @"native_row_revision");
  [keys addObject:revisionKey];
  return DSHAgentExactDictionaryKeys(reference, keys) &&
      DSHAgentSafeInteger(reference[revisionKey], DSHAgentMaximumSafeInteger, NO);
}

static BOOL DSHAgentWALSnapshotReferenceShape(NSDictionary *reference) {
  return DSHAgentExactDictionaryKeys(reference, @[
           @"schema_version", @"operation_id", @"result_sha256", @"result_bytes",
         ]) && [reference[@"schema_version"] isEqual:@2] &&
      DSHAgentCanonicalUUID(reference[@"operation_id"]) &&
      DSHAgentCanonicalSHA256(reference[@"result_sha256"]) &&
      DSHAgentSafeInteger(reference[@"result_bytes"],
                          DSHAgentNativeWALMaxOperationResultBytes, NO);
}

static BOOL DSHAgentWALContainsForbiddenSafeKey(id value) {
  static NSSet<NSString *> *forbidden;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    forbidden = [NSSet setWithArray:@[
      @"arguments", @"content", @"path", @"raw_arguments", @"raw_result",
      @"tool_feedback", @"messages", @"native_envelope", @"precondition",
      @"settled_facts", @"patch", @"owner", @"arguments_json",
    ]];
  });
  if ([value isKindOfClass:NSDictionary.class]) {
    for (id key in (NSDictionary *)value) {
      if ([forbidden containsObject:key] ||
          DSHAgentWALContainsForbiddenSafeKey(((NSDictionary *)value)[key])) return YES;
    }
  } else if ([value isKindOfClass:NSArray.class]) {
    for (id child in (NSArray *)value) {
      if (DSHAgentWALContainsForbiddenSafeKey(child)) return YES;
    }
  }
  return NO;
}

static NSString *DSHAgentWALResultKindForOperationKind(NSString *operationKind) {
  if ([operationKind isEqualToString:@"complete_agent_round_v2"]) {
    return @"complete_agent_round_v2";
  }
  return operationKind;
}

static BOOL DSHAgentWALSafeResultShape(NSDictionary *safeResult,
                                       NSString *operationKind,
                                       NSString *operationID,
                                       NSString *resultStatus) {
  if (!DSHAgentExactDictionaryKeys(safeResult, @[
        @"schema_version", @"result_kind", @"result",
      ]) || ![safeResult[@"schema_version"] isEqual:@2] ||
      ![safeResult[@"result_kind"]
          isEqualToString:DSHAgentWALResultKindForOperationKind(operationKind)] ||
      ![safeResult[@"result"] isKindOfClass:NSDictionary.class] ||
      DSHAgentWALContainsForbiddenSafeKey(safeResult)) return NO;
  NSDictionary *result = safeResult[@"result"];
  return [result[@"schema_version"] isEqual:@2] &&
      [result[@"operation_id"] isEqual:operationID] &&
      [result[@"status"] isEqual:resultStatus] &&
      DSHAgentCanonicalUUID(result[@"operation_id"]);
}

static BOOL DSHAgentWALOperationShape(NSDictionary *operation) {
  if (!DSHAgentExactDictionaryKeys(operation, @[
        @"schema_version", @"operation_id", @"operation_kind", @"request_sha256",
        @"task_id", @"attempt_id", @"result_ref", @"state", @"result_status",
        @"result_revision", @"result_snapshot_ref", @"authority_revision",
        @"created_at", @"updated_at",
      ]) || ![operation[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(operation[@"operation_id"]) ||
      ![DSHAgentWALOperationKinds() containsObject:operation[@"operation_kind"]] ||
      !DSHAgentCanonicalSHA256(operation[@"request_sha256"]) ||
      !DSHAgentCanonicalUUID(operation[@"task_id"]) ||
      !DSHAgentCanonicalUUID(operation[@"attempt_id"]) ||
      !DSHAgentWALResultReferenceShape(operation[@"result_ref"]) ||
      !DSHAgentWALOperationResultStatusAllowed(operation[@"operation_kind"],
                                               operation[@"result_status"]) ||
      !(operation[@"result_revision"] == NSNull.null ||
        DSHAgentSafeInteger(operation[@"result_revision"],
                            DSHAgentMaximumSafeInteger, NO)) ||
      !(operation[@"result_snapshot_ref"] == NSNull.null ||
        DSHAgentWALSnapshotReferenceShape(operation[@"result_snapshot_ref"])) ||
      !DSHAgentSafeInteger(operation[@"authority_revision"],
                          DSHAgentMaximumSafeInteger, YES) ||
      !DSHAgentCanonicalTimestamp(operation[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(operation[@"updated_at"])) return NO;
  NSString *state = operation[@"state"];
  NSDictionary *resultRef = operation[@"result_ref"];
  if (resultRef[@"task_id"] != nil &&
      (![resultRef[@"task_id"] isEqual:operation[@"task_id"]] ||
       ![resultRef[@"attempt_id"] isEqual:operation[@"attempt_id"]])) return NO;
  if (operation[@"result_snapshot_ref"] != NSNull.null &&
      ![operation[@"result_snapshot_ref"][@"operation_id"]
          isEqual:operation[@"operation_id"]]) return NO;
  BOOL none = [operation[@"result_ref"][@"kind"] isEqualToString:@"none"];
  BOOL nullRevision = operation[@"result_revision"] == NSNull.null;
  BOOL nullSnapshot = operation[@"result_snapshot_ref"] == NSNull.null;
  if ([state isEqualToString:@"started"]) {
    return none && nullRevision && nullSnapshot &&
        [operation[@"result_status"] isEqualToString:@"pending"];
  }
  if ([state isEqualToString:@"committed"]) {
    return !none && !nullRevision && !nullSnapshot;
  }
  if ([state isEqualToString:@"rejected"] ||
      [state isEqualToString:@"conflict"]) {
    return none && nullRevision && !nullSnapshot;
  }
  if ([state isEqualToString:@"unknown"] ||
      [state isEqualToString:@"ambiguous"]) {
    return (none == nullRevision) && !nullSnapshot;
  }
  return NO;
}

static BOOL DSHAgentWALOperationResultShape(NSDictionary *snapshot) {
  if (!DSHAgentExactDictionaryKeys(snapshot, @[
        @"schema_version", @"operation_id", @"operation_kind", @"result_status",
        @"result_sha256", @"result_bytes", @"result", @"created_at",
      ]) || ![snapshot[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(snapshot[@"operation_id"]) ||
      ![DSHAgentWALOperationKinds() containsObject:snapshot[@"operation_kind"]] ||
      !DSHAgentWALOperationResultStatusAllowed(snapshot[@"operation_kind"],
                                               snapshot[@"result_status"]) ||
      !DSHAgentCanonicalSHA256(snapshot[@"result_sha256"]) ||
      !DSHAgentSafeInteger(snapshot[@"result_bytes"],
                          DSHAgentNativeWALMaxOperationResultBytes, NO) ||
      !DSHAgentCanonicalTimestamp(snapshot[@"created_at"]) ||
      !DSHAgentWALSafeResultShape(snapshot[@"result"], snapshot[@"operation_kind"],
                                  snapshot[@"operation_id"],
                                  snapshot[@"result_status"])) return NO;
  NSError *canonicalError = nil;
  NSData *resultBytes = DSHAgentCanonicalJSON(snapshot[@"result"], &canonicalError);
  NSString *resultSHA = DSHAgentHJ(@"agent-operation-result", @{
    @"operation_kind" : snapshot[@"operation_kind"],
    @"result_status" : snapshot[@"result_status"],
    @"result" : snapshot[@"result"],
  }, &canonicalError);
  return resultBytes != nil && resultBytes.length > 0 &&
      resultBytes.length <= DSHAgentNativeWALMaxOperationResultBytes &&
      [snapshot[@"result_bytes"] isEqual:@(resultBytes.length)] &&
      [snapshot[@"result_sha256"] isEqual:resultSHA];
}

static BOOL DSHAgentWALBatchShapeV1(NSDictionary *batch) {
  if (!DSHAgentExactDictionaryKeys(batch, @[
        @"schema_version", @"task_id", @"attempt_id",
        @"root_fingerprint_sha256", @"binding_revision",
        @"manifest_sha256", @"manifest_calls", @"write_keys",
        @"reserved_write_bytes", @"reservation_delta_bytes",
        @"attempt_reserved_write_bytes", @"reservation_version", @"effect_gate",
        @"created_at", @"updated_at",
      ]) || !DSHAgentSafeInteger(batch[@"schema_version"], 1, NO) ||
      !DSHAgentCanonicalUUID(batch[@"task_id"]) ||
      !DSHAgentCanonicalUUID(batch[@"attempt_id"]) ||
      !DSHAgentCanonicalSHA256(batch[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(batch[@"binding_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalSHA256(batch[@"manifest_sha256"]) ||
      ![batch[@"manifest_calls"] isKindOfClass:NSArray.class] ||
      [(NSArray *)batch[@"manifest_calls"] count] == 0 ||
      [(NSArray *)batch[@"manifest_calls"] count] > 16 ||
      ![batch[@"write_keys"] isKindOfClass:NSArray.class] ||
      [(NSArray *)batch[@"write_keys"] count] > 16 ||
      !DSHAgentSafeInteger(batch[@"reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      !DSHAgentSafeInteger(batch[@"reservation_delta_bytes"],
                          DSHAgentNativeWALMaxBatchWriteBytes, YES) ||
      !DSHAgentSafeInteger(batch[@"attempt_reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      !DSHAgentSafeInteger(batch[@"reservation_version"],
                          DSHAgentMaximumSafeInteger, NO) ||
      [batch[@"reserved_write_bytes"] unsignedIntegerValue] >
          [batch[@"attempt_reserved_write_bytes"] unsignedIntegerValue] ||
      [batch[@"reservation_delta_bytes"] unsignedIntegerValue] >
          [batch[@"attempt_reserved_write_bytes"] unsignedIntegerValue] ||
      ![batch[@"effect_gate"] isKindOfClass:NSString.class] ||
      (![batch[@"effect_gate"] isEqualToString:@"closed"] &&
       ![batch[@"effect_gate"] isEqualToString:@"open"] &&
       ![batch[@"effect_gate"] isEqualToString:@"settled"] &&
       ![batch[@"effect_gate"] isEqualToString:@"released"]) ||
      !DSHAgentCanonicalTimestamp(batch[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(batch[@"updated_at"])) {
    return NO;
  }
  NSMutableSet *seen = [NSMutableSet set];
  for (id key in batch[@"write_keys"]) {
    if (!DSHAgentCanonicalSHA256(key) || [seen containsObject:key]) return NO;
    [seen addObject:key];
  }
  NSMutableArray *manifestKeys = [NSMutableArray array];
  NSMutableSet *manifestLocators = [NSMutableSet set];
  NSNumber *previousCallIndex = nil;
  NSString *batchRoundId = nil;
  NSNumber *batchRoundIndex = nil;
  for (NSDictionary *call in batch[@"manifest_calls"]) {
    if (![call isKindOfClass:NSDictionary.class]) return NO;
    NSDictionary *locator = call[@"locator"];
    if (!DSHAgentExactDictionaryKeys(call, @[
          @"locator", @"relative_path_sha256", @"prior", @"content_sha256",
          @"content_bytes",
        ]) || !DSHAgentExactDictionaryKeys(locator, @[
          @"schema_version", @"task_id", @"attempt_id", @"round_id",
          @"round_index", @"call_index", @"call_id", @"idempotency_key",
        ]) || ![locator[@"schema_version"] isEqual:@2] ||
        !DSHAgentCanonicalUUID(locator[@"task_id"]) ||
        !DSHAgentCanonicalUUID(locator[@"attempt_id"]) ||
        !DSHAgentCanonicalUUID(locator[@"round_id"]) ||
        ![locator[@"task_id"] isEqual:batch[@"task_id"]] ||
        ![locator[@"attempt_id"] isEqual:batch[@"attempt_id"]] ||
        !DSHAgentSafeInteger(locator[@"round_index"], 7, YES) ||
        !DSHAgentSafeInteger(locator[@"call_index"], 15, YES) ||
        DSHAgentWALOpaqueCallID(locator[@"call_id"]) == NO ||
        !DSHAgentCanonicalSHA256(locator[@"idempotency_key"]) ||
        !DSHAgentCanonicalSHA256(call[@"relative_path_sha256"]) ||
        !DSHAgentCanonicalSHA256(call[@"content_sha256"]) ||
        !DSHAgentSafeInteger(call[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
        !DSHAgentWALWritePriorShape(call[@"prior"])) {
      return NO;
    }
    NSData *key = DSHAgentCanonicalIdentityKey(locator);
    if (key == nil || [manifestLocators containsObject:key]) return NO;
    NSNumber *callIndex = locator[@"call_index"];
    if ((previousCallIndex != nil &&
         callIndex.unsignedIntegerValue <= previousCallIndex.unsignedIntegerValue) ||
        (batchRoundId != nil && ![batchRoundId isEqual:locator[@"round_id"]]) ||
        (batchRoundIndex != nil &&
         ![batchRoundIndex isEqual:locator[@"round_index"]])) {
      return NO;
    }
    previousCallIndex = callIndex;
    batchRoundId = locator[@"round_id"];
    batchRoundIndex = locator[@"round_index"];
    [manifestLocators addObject:key];
    [manifestKeys addObject:locator[@"idempotency_key"]];
  }
  NSError *manifestError = nil;
  NSString *expectedManifest = DSHAgentHJ(@"write-manifest", @{
    @"calls" : batch[@"manifest_calls"],
  }, &manifestError);
  return expectedManifest != nil &&
      [expectedManifest isEqual:batch[@"manifest_sha256"]] &&
      [manifestKeys isEqualToArray:batch[@"write_keys"]];
}

static BOOL DSHAgentWALManifestCallShapeV2(NSDictionary *call,
                                           NSDictionary *batch,
                                           NSMutableSet *locators,
                                           NSNumber **previousCallIndex) {
  NSDictionary *locator = call[@"locator"];
  if (![call isKindOfClass:NSDictionary.class] ||
      ![call[@"schema_version"] isEqual:@2] ||
      ![call[@"mutation_kind"] isKindOfClass:NSString.class] ||
      !DSHAgentExactDictionaryKeys(locator, @[
        @"schema_version", @"task_id", @"attempt_id", @"round_id",
        @"round_index", @"call_index", @"call_id", @"idempotency_key",
      ]) || ![locator[@"schema_version"] isEqual:@2] ||
      ![locator[@"task_id"] isEqual:batch[@"task_id"]] ||
      ![locator[@"attempt_id"] isEqual:batch[@"attempt_id"]] ||
      ![locator[@"round_id"] isEqual:batch[@"round_id"]] ||
      ![locator[@"round_index"] isEqual:batch[@"round_index"]] ||
      !DSHAgentCanonicalUUID(locator[@"task_id"]) ||
      !DSHAgentCanonicalUUID(locator[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(locator[@"round_id"]) ||
      !DSHAgentSafeInteger(locator[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(locator[@"call_index"], 15, YES) ||
      !DSHAgentWALOpaqueCallID(locator[@"call_id"]) ||
      !DSHAgentCanonicalSHA256(locator[@"idempotency_key"]) ||
      !DSHAgentCanonicalSHA256(call[@"precondition_sha256"])) return NO;
  NSString *mutationKind = call[@"mutation_kind"];
  if ([mutationKind isEqualToString:@"file_write"]) {
    if (!DSHAgentExactDictionaryKeys(call, @[
          @"schema_version", @"mutation_kind", @"locator",
          @"precondition_sha256", @"relative_path_sha256", @"prior",
          @"content_sha256", @"content_bytes",
        ]) || !DSHAgentCanonicalSHA256(call[@"relative_path_sha256"]) ||
        !DSHAgentWALWritePriorShape(call[@"prior"]) ||
        !DSHAgentCanonicalSHA256(call[@"content_sha256"]) ||
        !DSHAgentSafeInteger(call[@"content_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES)) return NO;
  } else if ([mutationKind isEqualToString:@"git_commit"] ||
             [mutationKind isEqualToString:@"git_push"] || [mutationKind isEqualToString:@"start_guest_cgi"] || [mutationKind isEqualToString:@"stop_guest_cgi"]) {
    if (!DSHAgentExactDictionaryKeys(call, @[
          @"schema_version", @"mutation_kind", @"locator",
          @"precondition_sha256", @"content_bytes",
        ]) || ![call[@"content_bytes"] isEqual:@0]) return NO;
  } else {
    return NO;
  }
  NSData *key = DSHAgentCanonicalIdentityKey(locator);
  if (key == nil || [locators containsObject:key] ||
      (*previousCallIndex != nil &&
       [locator[@"call_index"] unsignedIntegerValue] <=
           [*previousCallIndex unsignedIntegerValue])) return NO;
  [locators addObject:key];
  *previousCallIndex = locator[@"call_index"];
  return YES;
}

static BOOL DSHAgentWALBatchShapeV2(NSDictionary *batch) {
  if (![batch isKindOfClass:NSDictionary.class] ||
      ![batch[@"schema_version"] isEqual:@2] ||
      ![batch[@"kind"] isKindOfClass:NSString.class] ||
      !DSHAgentCanonicalUUID(batch[@"task_id"]) ||
      !DSHAgentCanonicalUUID(batch[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(batch[@"round_id"]) ||
      !DSHAgentSafeInteger(batch[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(batch[@"batch_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalTimestamp(batch[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(batch[@"updated_at"])) return NO;
  if ([batch[@"kind"] isEqualToString:@"read_only_batch"]) {
    return DSHAgentExactDictionaryKeys(batch, @[
             @"schema_version", @"kind", @"task_id", @"attempt_id", @"round_id",
             @"round_index", @"batch_revision", @"manifest_sha256",
             @"reservation_delta_bytes", @"reserved_write_bytes",
             @"attempt_reserved_write_bytes", @"effect_gate", @"created_at",
             @"updated_at",
           ]) && batch[@"manifest_sha256"] == NSNull.null &&
        [batch[@"reservation_delta_bytes"] isEqual:@0] &&
        [batch[@"reserved_write_bytes"] isEqual:@0] &&
        DSHAgentSafeInteger(batch[@"attempt_reserved_write_bytes"],
                            DSHAgentNativeWALMaxAttemptWriteBytes, YES) &&
        [batch[@"effect_gate"] isEqualToString:@"not_applicable"];
  }
  if (![batch[@"kind"] isEqualToString:@"write_batch"] ||
      !DSHAgentExactDictionaryKeys(batch, @[
        @"schema_version", @"kind", @"task_id", @"attempt_id", @"round_id",
        @"round_index", @"batch_revision", @"root_fingerprint_sha256",
        @"binding_revision", @"manifest_sha256", @"manifest_calls", @"write_keys",
        @"reservation_delta_bytes", @"reserved_write_bytes",
        @"attempt_reserved_write_bytes", @"effect_gate", @"created_at", @"updated_at",
      ]) || !DSHAgentCanonicalSHA256(batch[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(batch[@"binding_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentCanonicalSHA256(batch[@"manifest_sha256"]) ||
      ![batch[@"manifest_calls"] isKindOfClass:NSArray.class] ||
      [(NSArray *)batch[@"manifest_calls"] count] == 0 ||
      [(NSArray *)batch[@"manifest_calls"] count] > 16 ||
      ![batch[@"write_keys"] isKindOfClass:NSArray.class] ||
      [(NSArray *)batch[@"write_keys"] count] !=
          [(NSArray *)batch[@"manifest_calls"] count] ||
      !DSHAgentSafeInteger(batch[@"reservation_delta_bytes"],
                          DSHAgentNativeWALMaxBatchWriteBytes, YES) ||
      !DSHAgentSafeInteger(batch[@"reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      !DSHAgentSafeInteger(batch[@"attempt_reserved_write_bytes"],
                          DSHAgentNativeWALMaxAttemptWriteBytes, YES) ||
      [batch[@"reserved_write_bytes"] unsignedIntegerValue] >
          [batch[@"attempt_reserved_write_bytes"] unsignedIntegerValue] ||
      [batch[@"reservation_delta_bytes"] unsignedIntegerValue] >
          [batch[@"attempt_reserved_write_bytes"] unsignedIntegerValue] ||
      (![batch[@"effect_gate"] isEqualToString:@"closed"] &&
       ![batch[@"effect_gate"] isEqualToString:@"open"] &&
       ![batch[@"effect_gate"] isEqualToString:@"released"])) return NO;
  NSMutableSet *locators = [NSMutableSet set];
  NSMutableSet *writeKeys = [NSMutableSet set];
  NSMutableArray *manifestWriteKeys = [NSMutableArray array];
  NSNumber *previousCallIndex = nil;
  for (NSDictionary *call in batch[@"manifest_calls"]) {
    if (!DSHAgentWALManifestCallShapeV2(call, batch, locators,
                                        &previousCallIndex)) return NO;
    [manifestWriteKeys addObject:call[@"locator"][@"idempotency_key"]];
  }
  for (id key in batch[@"write_keys"]) {
    if (!DSHAgentCanonicalSHA256(key) || [writeKeys containsObject:key]) return NO;
    [writeKeys addObject:key];
  }
  NSError *digestError = nil;
  NSString *manifest = DSHAgentHJ(@"write-manifest", @{
    @"calls" : batch[@"manifest_calls"],
  }, &digestError);
  return [manifestWriteKeys isEqualToArray:batch[@"write_keys"]] &&
      [manifest isEqual:batch[@"manifest_sha256"]];
}

static BOOL DSHAgentWALToolReceiptShape(NSDictionary *receipt) {
  if (!DSHAgentExactDictionaryKeys(receipt, @[
        @"schema_version", @"call_id", @"name", @"arguments_sha256",
        @"result_sha256", @"result_bytes", @"truncated", @"duration_ms",
        @"outcome", @"failure_code", @"approval_reference",
      ]) || ![receipt[@"schema_version"] isEqual:@1] ||
      !DSHAgentWALOpaqueCallID(receipt[@"call_id"]) ||
      !DSHAgentBoundedUTF8String(receipt[@"name"], 64, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(receipt[@"arguments_sha256"]) ||
      !DSHAgentCanonicalSHA256(receipt[@"result_sha256"]) ||
      !DSHAgentSafeInteger(receipt[@"result_bytes"], 32 * 1024 * 1024, YES) ||
      !DSHAgentIsBooleanNumber(receipt[@"truncated"]) ||
      !DSHAgentSafeInteger(receipt[@"duration_ms"], 24 * 60 * 60 * 1000, YES) ||
      !(receipt[@"approval_reference"] == NSNull.null ||
        DSHAgentCanonicalUUID(receipt[@"approval_reference"]))) return NO;
  NSString *outcome = receipt[@"outcome"];
  NSSet *outcomes = [NSSet setWithArray:@[
    @"ok", @"failed", @"denied", @"cancelled", @"ambiguous",
  ]];
  if (![outcomes containsObject:outcome]) return NO;
  if ([outcome isEqualToString:@"ok"]) return receipt[@"failure_code"] == NSNull.null;
  if (!DSHAgentFailureCode(receipt[@"failure_code"])) return NO;
  return ![outcome isEqualToString:@"ambiguous"] ||
      [receipt[@"failure_code"] isEqualToString:@"E_AGENT_EXECUTION_AMBIGUOUS"];
}

static BOOL DSHAgentWALDeniedCallShape(NSDictionary *row) {
  if (!DSHAgentExactDictionaryKeys(row, @[
        @"schema_version", @"task_id", @"attempt_id", @"round_id", @"round_index",
        @"call_index", @"call_id", @"name", @"arguments_sha256",
        @"root_fingerprint_sha256", @"binding_revision", @"transcript_before",
        @"state", @"row_revision", @"feedback", @"transcript_after", @"receipt",
        @"created_at", @"updated_at",
      ]) || ![row[@"schema_version"] isEqual:@1] ||
      !DSHAgentCanonicalUUID(row[@"task_id"]) ||
      !DSHAgentCanonicalUUID(row[@"attempt_id"]) ||
      !DSHAgentCanonicalUUID(row[@"round_id"]) ||
      !DSHAgentSafeInteger(row[@"round_index"], 7, YES) ||
      !DSHAgentSafeInteger(row[@"call_index"], 15, YES) ||
      !DSHAgentWALOpaqueCallID(row[@"call_id"]) ||
      !DSHAgentBoundedUTF8String(row[@"name"], 64, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(row[@"arguments_sha256"]) ||
      !DSHAgentCanonicalSHA256(row[@"root_fingerprint_sha256"]) ||
      !DSHAgentSafeInteger(row[@"binding_revision"],
                          DSHAgentMaximumSafeInteger, NO) ||
      !DSHAgentWALReferenceShape(row[@"transcript_before"]) ||
      ![row[@"state"] isEqualToString:@"denied"] ||
      ![row[@"row_revision"] isEqual:@1] ||
      !DSHAgentWALReferenceShape(row[@"transcript_after"]) ||
      !DSHAgentWALToolReceiptShape(row[@"receipt"]) ||
      !DSHAgentCanonicalTimestamp(row[@"created_at"]) ||
      !DSHAgentCanonicalTimestamp(row[@"updated_at"])) return NO;
  NSDictionary *feedback = row[@"feedback"];
  NSDictionary *payload = feedback[@"payload"];
  if (!DSHAgentExactDictionaryKeys(feedback, @[
        @"schema_version", @"name", @"outcome", @"payload",
      ]) || ![feedback[@"schema_version"] isEqual:@1] ||
      ![feedback[@"name"] isEqual:row[@"name"]] ||
      ![feedback[@"outcome"] isEqualToString:@"denied"] ||
      !DSHAgentExactDictionaryKeys(payload, @[
        @"schema_version", @"failure_code",
      ]) || ![payload[@"schema_version"] isEqual:@1] ||
      (![payload[@"failure_code"] isEqualToString:@"E_AGENT_UNKNOWN_TOOL"] &&
       ![payload[@"failure_code"] isEqualToString:@"E_AGENT_CAPABILITY"])) return NO;
  NSError *digestError = nil;
  NSData *feedbackBytes = DSHAgentCanonicalJSON(feedback, &digestError);
  NSString *resultSHA = DSHAgentHB(@"tool-result", feedbackBytes, &digestError);
  NSDictionary *receipt = row[@"receipt"];
  return feedbackBytes.length <= 8 * 1024 &&
      [receipt[@"call_id"] isEqual:row[@"call_id"]] &&
      [receipt[@"name"] isEqual:row[@"name"]] &&
      [receipt[@"arguments_sha256"] isEqual:row[@"arguments_sha256"]] &&
      [receipt[@"result_sha256"] isEqual:resultSHA] &&
      [receipt[@"result_bytes"] isEqual:@(feedbackBytes.length)] &&
      [receipt[@"outcome"] isEqualToString:@"denied"] &&
      [receipt[@"failure_code"] isEqual:payload[@"failure_code"]];
}

static BOOL DSHAgentWALRoundCallV3Shape(NSDictionary *call,
                                        NSUInteger expectedIndex,
                                        BOOL *denied) {
  if (!DSHAgentExactDictionaryKeys(call, @[
        @"schema_version", @"call_index", @"call_id", @"name",
        @"arguments_sha256", @"safe_summary_key", @"access", @"approval_state",
      ]) || ![call[@"schema_version"] isEqual:@3] ||
      ![call[@"call_index"] isEqual:@(expectedIndex)] ||
      !DSHAgentWALOpaqueCallID(call[@"call_id"]) ||
      !DSHAgentBoundedUTF8String(call[@"name"], 64, NO, nullptr) ||
      !DSHAgentCanonicalSHA256(call[@"arguments_sha256"]) ||
      !DSHAgentBoundedUTF8String(call[@"safe_summary_key"], 128, NO, nullptr)) {
    return NO;
  }
  NSString *access = call[@"access"];
  BOOL durable = [access isEqualToString:@"durable_deny"];
  static NSSet<NSString *> *knownNames;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    knownNames = [NSSet setWithArray:@[
      @"list_dir", @"read_file", @"write_file", @"git_status", @"git_commit",
      @"git_push", @"start_guest_cgi", @"stop_guest_cgi",
    ]];
  });
  BOOL known = [knownNames containsObject:call[@"name"]];
  if ((!durable && ![access isEqualToString:@"auto"] &&
       ![access isEqualToString:@"conversation_confirm"] &&
       ![access isEqualToString:@"confirm_once"]) ||
      (durable && ![call[@"approval_state"] isEqualToString:@"durable_denied"]) ||
      (!durable && ![call[@"approval_state"] isEqualToString:@"deferred"]) ||
      (!known && (!durable ||
                  ![call[@"safe_summary_key"] isEqualToString:@"agent.unknown"]))) {
    return NO;
  }
  if (denied != nullptr) *denied = durable;
  return YES;
}

static BOOL DSHAgentWALRoundV3Shape(NSDictionary *row) {
  if (!DSHAgentExactDictionaryKeys(row, @[
        @"schema_version", @"locator", @"row_revision",
        @"root_fingerprint_sha256", @"binding_revision", @"request_sha256",
        @"transcript_before", @"launch_attempt", @"state", @"owner",
        @"failure_code", @"completion_receipt", @"transcript_after", @"calls",
        @"batch_class", @"executable_call_count", @"denied_call_count",
        @"terminal_kind", @"created_at", @"updated_at",
      ]) || ![row[@"schema_version"] isEqual:@3] ||
      ![row[@"calls"] isKindOfClass:NSArray.class] ||
      [(NSArray *)row[@"calls"] count] > 16 ||
      !DSHAgentSafeInteger(row[@"executable_call_count"], 16, YES) ||
      !DSHAgentSafeInteger(row[@"denied_call_count"], 16, YES)) return NO;
  NSUInteger executableCount = 0;
  NSUInteger deniedCount = 0;
  NSMutableArray *v2Calls = [NSMutableArray array];
  NSUInteger index = 0;
  for (NSDictionary *call in row[@"calls"]) {
    BOOL denied = NO;
    if (!DSHAgentWALRoundCallV3Shape(call, index, &denied)) return NO;
    denied ? deniedCount++ : executableCount++;
    [v2Calls addObject:@{
      @"schema_version" : @1,
      @"call_id" : call[@"call_id"],
      @"name" : call[@"name"],
      @"arguments_sha256" : call[@"arguments_sha256"],
      @"safe_summary_key" : call[@"safe_summary_key"],
      @"access" : denied ? @"auto" : call[@"access"],
    }];
    index += 1;
  }
  if (![row[@"executable_call_count"] isEqual:@(executableCount)] ||
      ![row[@"denied_call_count"] isEqual:@(deniedCount)]) return NO;
  id batchClass = row[@"batch_class"];
  if (index == 0) {
    if (batchClass != NSNull.null || executableCount != 0 || deniedCount != 0) {
      return NO;
    }
  } else {
    NSString *expectedClass = deniedCount == 0 ? @"executable" :
        (executableCount == 0 ? @"denied_only" : @"mixed");
    if (![batchClass isEqualToString:expectedClass]) return NO;
  }
  if ([row[@"state"] isEqualToString:@"completed"]) {
    NSString *terminalKind = row[@"terminal_kind"];
    if ([terminalKind isEqualToString:@"tool_batch"] && index == 0) return NO;
    if (([terminalKind isEqualToString:@"final"] ||
         [terminalKind isEqualToString:@"blocked"]) && index != 0) return NO;
  }
  NSMutableDictionary *v2 = [row mutableCopy];
  v2[@"schema_version"] = @2;
  v2[@"calls"] = v2Calls;
  [v2 removeObjectForKey:@"batch_class"];
  [v2 removeObjectForKey:@"executable_call_count"];
  [v2 removeObjectForKey:@"denied_call_count"];
  return DSHAgentValidateRoundNativeEntryV2(v2, nullptr);
}

static NSDictionary *DSHAgentWALMigrateRoundV2ToV3(NSDictionary *row,
                                                    NSError **error) {
  if (![row[@"schema_version"] isEqual:@2] ||
      !DSHAgentValidateRoundNativeEntryV2(row, error)) return nil;
  NSSet *knownNames = [NSSet setWithArray:@[
    @"list_dir", @"read_file", @"write_file", @"git_status", @"git_commit",
    @"git_push", @"start_guest_cgi", @"stop_guest_cgi",
  ]];
  NSMutableArray *calls = [NSMutableArray array];
  NSUInteger executableCount = 0;
  NSUInteger deniedCount = 0;
  NSUInteger index = 0;
  for (NSDictionary *call in row[@"calls"]) {
    BOOL known = [knownNames containsObject:call[@"name"]];
    NSString *access = known ? call[@"access"] : @"durable_deny";
    NSString *summary = known ? call[@"safe_summary_key"] : @"agent.unknown";
    [calls addObject:@{
      @"schema_version" : @3,
      @"call_index" : @(index),
      @"call_id" : call[@"call_id"],
      @"name" : call[@"name"],
      @"arguments_sha256" : call[@"arguments_sha256"],
      @"safe_summary_key" : summary,
      @"access" : access,
      @"approval_state" : known ? @"deferred" : @"durable_denied",
    }];
    known ? executableCount++ : deniedCount++;
    index += 1;
  }
  if ([@"tool_batch" isEqual:row[@"terminal_kind"]] && index == 0) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSMutableDictionary *migrated = [row mutableCopy];
  migrated[@"schema_version"] = @3;
  migrated[@"calls"] = calls;
  migrated[@"batch_class"] = index == 0 ? NSNull.null :
      (deniedCount == 0 ? @"executable" :
       (executableCount == 0 ? @"denied_only" : @"mixed"));
  migrated[@"executable_call_count"] = @(executableCount);
  migrated[@"denied_call_count"] = @(deniedCount);
  if (!DSHAgentWALRoundV3Shape(migrated)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return migrated;
}

static NSDictionary *DSHAgentWALMigrateBatchV1ToV2(NSDictionary *batch,
                                                    NSError **error) {
  if (!DSHAgentWALBatchShapeV1(batch)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSDictionary *firstLocator = batch[@"manifest_calls"][0][@"locator"];
  NSString *roundID = firstLocator[@"round_id"];
  NSNumber *roundIndex = firstLocator[@"round_index"];
  NSMutableArray *manifestCalls = [NSMutableArray array];
  for (NSDictionary *call in batch[@"manifest_calls"]) {
    NSDictionary *locator = call[@"locator"];
    if (![locator[@"round_id"] isEqual:roundID] ||
        ![locator[@"round_index"] isEqual:roundIndex]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return nil;
    }
    NSDictionary *precondition = @{
      @"schema_version" : @2, @"kind" : @"write_file",
      @"relative_path_sha256" : call[@"relative_path_sha256"],
      @"prior" : call[@"prior"], @"content_sha256" : call[@"content_sha256"],
      @"content_bytes" : call[@"content_bytes"],
    };
    NSString *preconditionSHA = DSHAgentHJ(@"tool-precondition", @{
      @"schema_version" : @1, @"name" : @"write_file",
      @"precondition" : precondition,
    }, error);
    if (preconditionSHA == nil) return nil;
    [manifestCalls addObject:@{
      @"schema_version" : @2, @"mutation_kind" : @"file_write",
      @"locator" : locator, @"precondition_sha256" : preconditionSHA,
      @"relative_path_sha256" : call[@"relative_path_sha256"],
      @"prior" : call[@"prior"], @"content_sha256" : call[@"content_sha256"],
      @"content_bytes" : call[@"content_bytes"],
    }];
  }
  NSMutableDictionary *migrated = [batch mutableCopy];
  migrated[@"schema_version"] = @2;
  migrated[@"kind"] = @"write_batch";
  migrated[@"round_id"] = roundID;
  migrated[@"round_index"] = roundIndex;
  migrated[@"batch_revision"] = batch[@"reservation_version"];
  migrated[@"manifest_calls"] = manifestCalls;
  migrated[@"manifest_sha256"] = DSHAgentHJ(@"write-manifest", @{
    @"calls" : manifestCalls,
  }, error);
  [migrated removeObjectForKey:@"reservation_version"];
  if (!DSHAgentWALBatchShapeV2(migrated)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return migrated;
}

static NSMutableDictionary *DSHAgentWALMigrateV1ToV2(NSDictionary *state,
                                                      NSError **error) {
  if (![state[@"schema_version"] isEqual:@1] ||
      !DSHAgentExactDictionaryKeys(state, DSHAgentWALV1Keys()) ||
      [state[@"generation"] unsignedLongLongValue] >=
          DSHAgentMaximumSafeInteger) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSMutableArray *rounds = [NSMutableArray arrayWithCapacity:
      [(NSArray *)state[@"rounds"] count]];
  for (NSDictionary *round in state[@"rounds"]) {
    NSDictionary *migrated = DSHAgentWALMigrateRoundV2ToV3(round, error);
    if (migrated == nil) return nil;
    [rounds addObject:migrated];
  }
  NSMutableArray *batches = [NSMutableArray arrayWithCapacity:
      [(NSArray *)state[@"batches"] count]];
  NSMutableDictionary<NSString *, NSNumber *> *batchCounts =
      [NSMutableDictionary dictionary];
  for (NSDictionary *batch in state[@"batches"]) {
    NSDictionary *migrated = DSHAgentWALMigrateBatchV1ToV2(batch, error);
    if (migrated == nil) return nil;
    NSString *attemptID = migrated[@"attempt_id"];
    NSUInteger count = [batchCounts[attemptID] unsignedIntegerValue] + 1;
    if (count > DSHAgentNativeWALMaxBatchesPerAttempt) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return nil;
    }
    batchCounts[attemptID] = @(count);
    [batches addObject:migrated];
  }
  NSMutableDictionary *migrated = [state mutableCopy];
  migrated[@"schema_version"] = @2;
  migrated[@"generation"] = @([state[@"generation"] unsignedLongLongValue] + 1);
  migrated[@"authorities"] = @[];
  migrated[@"operations"] = @[];
  migrated[@"operation_results"] = @[];
  migrated[@"rounds"] = rounds;
  migrated[@"batches"] = batches;
  migrated[@"denied_calls"] = @[];
  return migrated;
}

/// Typed views created before WAL schema 2 may still hand the transaction
/// block a V2 round or legacy write-batch candidate. They are never persisted
/// beside V3/V2 rows: the WAL upgrades the complete candidate in-memory before
/// validation and the single atomic replacement.
static BOOL DSHAgentWALNormalizeTransactionCandidate(NSMutableDictionary *state,
                                                     NSError **error) {
  if (![state[@"schema_version"] isEqual:@2]) return YES;
  NSMutableArray *rounds = [NSMutableArray arrayWithCapacity:
      [(NSArray *)state[@"rounds"] count]];
  for (NSDictionary *round in state[@"rounds"]) {
    if ([round[@"schema_version"] isEqual:@3]) {
      if (!DSHAgentWALRoundV3Shape(round)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      [rounds addObject:round];
      continue;
    }
    NSDictionary *migrated = DSHAgentWALMigrateRoundV2ToV3(round, error);
    if (migrated == nil) return NO;
    [rounds addObject:migrated];
  }
  NSMutableArray *batches = [NSMutableArray arrayWithCapacity:
      [(NSArray *)state[@"batches"] count]];
  for (NSDictionary *batch in state[@"batches"]) {
    if ([batch[@"schema_version"] isEqual:@2]) {
      if (!DSHAgentWALBatchShapeV2(batch)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      [batches addObject:batch];
      continue;
    }
    NSDictionary *migrated = DSHAgentWALMigrateBatchV1ToV2(batch, error);
    if (migrated == nil) return NO;
    [batches addObject:migrated];
  }
  state[@"rounds"] = rounds;
  state[@"batches"] = batches;
  return YES;
}

static NSString *DSHAgentFindDispatchState(NSArray *dispatchRows,
                                           NSString *kind,
                                           NSDictionary *locator);

static NSData *DSHAgentCanonicalIdentityKey(id value) {
  NSError *canonicalError = nil;
  return DSHAgentCanonicalJSON(value, &canonicalError);
}

/// WAL bootstrap rejects malformed rows before a typed view can accidentally
/// use them. Full typed round/ledger validators are mandatory here; these
/// checks additionally cover the shared envelope, cross-store bindings, and
/// uniqueness relations.
static BOOL DSHAgentWALRowsShape(NSDictionary *state, NSError **error) {
  const BOOL schemaV2 = [state[@"schema_version"] isEqual:@2];
  NSMutableSet *transcriptRefs = [NSMutableSet set];
  NSMutableSet *transcriptAttempts = [NSMutableSet set];
  for (NSDictionary *transcript in state[@"transcripts"]) {
    if (![transcript isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if (!DSHAgentExactDictionaryKeys(transcript, @[
          @"schema_version", @"transcript_ref", @"attempt_id",
          @"root_fingerprint_sha256", @"generation", @"messages",
          @"transcript_sha256", @"transcript_bytes", @"state",
          @"retention_until", @"created_at", @"updated_at",
        ]) || !DSHAgentSafeInteger(transcript[@"schema_version"], 1, NO) ||
        !DSHAgentCanonicalUUID(transcript[@"transcript_ref"]) ||
        !DSHAgentCanonicalUUID(transcript[@"attempt_id"]) ||
        !DSHAgentCanonicalSHA256(transcript[@"root_fingerprint_sha256"]) ||
        !DSHAgentSafeInteger(transcript[@"generation"], DSHAgentMaximumSafeInteger, YES) ||
        ![transcript[@"messages"] isKindOfClass:NSArray.class] ||
        [(NSArray *)transcript[@"messages"] count] > 1024 ||
        !DSHAgentCanonicalSHA256(transcript[@"transcript_sha256"]) ||
        !DSHAgentSafeInteger(transcript[@"transcript_bytes"],
                            DSHAgentNativeWALMaxTranscriptBytes, YES) ||
        ![transcript[@"state"] isKindOfClass:NSString.class] ||
        (![transcript[@"state"] isEqualToString:@"open"] &&
         ![transcript[@"state"] isEqualToString:@"terminal"] &&
         ![transcript[@"state"] isEqualToString:@"cleanup_pending"]) ||
        !(transcript[@"retention_until"] == NSNull.null ||
          DSHAgentCanonicalTimestamp(transcript[@"retention_until"])) ||
        !DSHAgentCanonicalTimestamp(transcript[@"created_at"]) ||
        !DSHAgentCanonicalTimestamp(transcript[@"updated_at"])) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSData *transcriptRef = DSHAgentCanonicalIdentityKey(
        transcript[@"transcript_ref"]);
    if (transcriptRef == nil || [transcriptRefs containsObject:transcriptRef] ||
        [transcriptAttempts containsObject:transcript[@"attempt_id"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [transcriptRefs addObject:transcriptRef];
    [transcriptAttempts addObject:transcript[@"attempt_id"]];
    for (NSDictionary *message in transcript[@"messages"]) {
      if (!DSHAgentWALMessageShape(message)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
    NSError *transcriptBytesError = nil;
    NSData *transcriptEnvelope = DSHAgentCanonicalJSON(transcript, &transcriptBytesError);
    if (transcriptEnvelope == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSDictionary *digestInput = @{
      @"schema_version" : @1,
      @"transcript_ref" : transcript[@"transcript_ref"],
      @"attempt_id" : transcript[@"attempt_id"],
      @"root_fingerprint_sha256" : transcript[@"root_fingerprint_sha256"],
      @"generation" : transcript[@"generation"],
      @"messages" : transcript[@"messages"],
    };
    NSError *transcriptDigestError = nil;
    NSString *actualTranscriptDigest = DSHAgentHJ(
        @"agent-transcript", digestInput, &transcriptDigestError);
    NSData *transcriptDigestBytes = DSHAgentCanonicalJSON(digestInput,
                                                           &transcriptDigestError);
    if (actualTranscriptDigest == nil || transcriptDigestBytes == nil ||
        ![transcript[@"transcript_bytes"] isEqual:@(transcriptDigestBytes.length)] ||
        ![actualTranscriptDigest isEqual:transcript[@"transcript_sha256"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
  }
  if (schemaV2) {
    NSMutableSet *authorityKeys = [NSMutableSet set];
    if ([(NSArray *)state[@"authorities"] count] >
        DSHAgentNativeWALMaxAuthorities) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    for (NSDictionary *authority in state[@"authorities"]) {
      if (!DSHAgentWALAuthorityShape(authority)) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      NSString *key = [NSString stringWithFormat:@"%@:%@",
          authority[@"task_id"], authority[@"attempt_id"]];
      if ([authorityKeys containsObject:key]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      [authorityKeys addObject:key];
      NSUInteger transcriptMatches = 0;
      for (NSDictionary *transcript in state[@"transcripts"]) {
        if ([transcript[@"transcript_ref"]
                isEqual:authority[@"transcript"][@"transcript_ref"]]) {
          transcriptMatches += 1;
          if (![transcript[@"attempt_id"] isEqual:authority[@"attempt_id"]] ||
              ![transcript[@"root_fingerprint_sha256"]
                  isEqual:authority[@"root"][@"root_fingerprint_sha256"]]) {
            DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
            return NO;
          }
        }
      }
      if (transcriptMatches != 1) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
    NSMutableDictionary<NSString *, NSDictionary *> *snapshotsByID =
        [NSMutableDictionary dictionary];
    if ([(NSArray *)state[@"operation_results"] count] >
        DSHAgentNativeWALMaxOperations) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    for (NSDictionary *snapshot in state[@"operation_results"]) {
      if (!DSHAgentWALOperationResultShape(snapshot) ||
          snapshotsByID[snapshot[@"operation_id"]] != nil) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      snapshotsByID[snapshot[@"operation_id"]] = snapshot;
    }
    NSMutableSet *operationIDs = [NSMutableSet set];
    NSMutableDictionary<NSString *, NSNumber *> *operationCounts =
        [NSMutableDictionary dictionary];
    if ([(NSArray *)state[@"operations"] count] > DSHAgentNativeWALMaxOperations) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    for (NSDictionary *operation in state[@"operations"]) {
      NSError *recordBytesError = nil;
      NSData *recordBytes = DSHAgentCanonicalJSON(operation, &recordBytesError);
      if (!DSHAgentWALOperationShape(operation) || recordBytes == nil ||
          recordBytes.length > DSHAgentNativeWALMaxOperationRecordBytes ||
          [operationIDs containsObject:operation[@"operation_id"]]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      [operationIDs addObject:operation[@"operation_id"]];
      NSString *attemptID = operation[@"attempt_id"];
      NSUInteger count = [operationCounts[attemptID] unsignedIntegerValue] + 1;
      if (count > DSHAgentNativeWALMaxOperationsPerAttempt) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      operationCounts[attemptID] = @(count);
      NSDictionary *snapshot = snapshotsByID[operation[@"operation_id"]];
      if (operation[@"result_snapshot_ref"] == NSNull.null) {
        if (snapshot != nil) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
      } else if (snapshot == nil ||
                 ![snapshot[@"operation_kind"]
                     isEqual:operation[@"operation_kind"]] ||
                 ![snapshot[@"result_status"]
                     isEqual:operation[@"result_status"]] ||
                 ![snapshot[@"result_sha256"]
                     isEqual:operation[@"result_snapshot_ref"][@"result_sha256"]] ||
                 ![snapshot[@"result_bytes"]
                     isEqual:operation[@"result_snapshot_ref"][@"result_bytes"]]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
    for (NSString *operationID in snapshotsByID) {
      if (![operationIDs containsObject:operationID]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
  }
  NSMutableSet *roundLocators = [NSMutableSet set];
  for (NSDictionary *round in state[@"rounds"]) {
    if (![round isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSDictionary *locator = round[@"locator"];
    BOOL validRound = schemaV2 ? DSHAgentWALRoundV3Shape(round) :
        DSHAgentValidateRoundNativeEntryV2(round, nullptr);
    if (!validRound) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSData *roundKey = DSHAgentCanonicalIdentityKey(locator);
    if (roundKey == nil || [roundLocators containsObject:roundKey]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [roundLocators addObject:roundKey];
    if (!DSHAgentWALTranscriptBound(state, round)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
  }
  NSMutableDictionary<NSString *, NSNumber *> *roundCounts = [NSMutableDictionary dictionary];
  for (NSDictionary *round in state[@"rounds"]) {
    NSString *attemptId = round[@"locator"][@"attempt_id"];
    NSUInteger count = [roundCounts[attemptId] unsignedIntegerValue];
    if (count >= DSHAgentNativeWALMaxRoundRowsPerAttempt) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    roundCounts[attemptId] = @(count + 1);
  }
  NSMutableSet *ledgerLocators = [NSMutableSet set];
  for (NSDictionary *ledger in state[@"ledger"]) {
    if (![ledger isKindOfClass:NSDictionary.class]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSDictionary *locator = ledger[@"locator"];
    if (!DSHAgentExactDictionaryKeys(ledger, @[
          @"schema_version", @"locator", @"row_revision",
          @"root_fingerprint_sha256", @"binding_revision", @"transcript_before",
          @"name", @"arguments_sha256", @"precondition", @"reserved_write_bytes",
          @"state", @"owner", @"settled_facts", @"transcript_after", @"receipt",
          @"created_at", @"updated_at",
        ]) || ![ledger[@"schema_version"] isEqual:@2] ||
        !DSHAgentExactDictionaryKeys(locator, @[
          @"schema_version", @"task_id", @"attempt_id", @"round_id",
          @"round_index", @"call_index", @"call_id", @"idempotency_key",
        ]) || ![locator[@"schema_version"] isEqual:@2] ||
        !DSHAgentCanonicalUUID(locator[@"task_id"]) ||
        !DSHAgentCanonicalUUID(locator[@"attempt_id"]) ||
        !DSHAgentCanonicalUUID(locator[@"round_id"]) ||
        !DSHAgentSafeInteger(locator[@"round_index"], 7, YES) ||
        !DSHAgentSafeInteger(locator[@"call_index"], 15, YES) ||
        !DSHAgentCanonicalSHA256(locator[@"idempotency_key"]) ||
        !DSHAgentBoundedUTF8String(locator[@"call_id"], 128, NO, nullptr) ||
        !DSHAgentSafeInteger(ledger[@"row_revision"], DSHAgentMaximumSafeInteger, NO) ||
        !DSHAgentCanonicalSHA256(ledger[@"root_fingerprint_sha256"]) ||
        !DSHAgentSafeInteger(ledger[@"binding_revision"], DSHAgentMaximumSafeInteger, NO) ||
        !DSHAgentWALReferenceShape(ledger[@"transcript_before"]) ||
        !DSHAgentBoundedUTF8String(ledger[@"name"], 64, NO, nullptr) ||
        !DSHAgentCanonicalSHA256(ledger[@"arguments_sha256"]) ||
        !DSHAgentSafeInteger(ledger[@"reserved_write_bytes"],
                            DSHAgentNativeWALMaxSingleWriteBytes, YES) ||
        ![ledger[@"state"] isKindOfClass:NSString.class] ||
        (![ledger[@"state"] isEqualToString:@"intent"] &&
         ![ledger[@"state"] isEqualToString:@"running"] &&
         ![ledger[@"state"] isEqualToString:@"cancel_requested"] &&
         ![ledger[@"state"] isEqualToString:@"settled"] &&
         ![ledger[@"state"] isEqualToString:@"cancelled"] &&
         ![ledger[@"state"] isEqualToString:@"unknown"] &&
         ![ledger[@"state"] isEqualToString:@"ambiguous"]) ||
        !DSHAgentCanonicalTimestamp(ledger[@"created_at"]) ||
        !DSHAgentCanonicalTimestamp(ledger[@"updated_at"])) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSData *ledgerKey = DSHAgentCanonicalIdentityKey(locator);
    if (ledgerKey == nil || [ledgerLocators containsObject:ledgerKey]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [ledgerLocators addObject:ledgerKey];
    if (!DSHAgentValidateExecutionLedgerEntryV2(ledger, error)) {
      return NO;
    }
    if (!DSHAgentWALTranscriptBound(state, ledger)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
  }
  NSMutableSet *reservationIdentities = [NSMutableSet set];
  for (NSDictionary *reservation in state[@"reservations"]) {
    if (!DSHAgentWALReservationShape(reservation)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSString *reservationKey = [NSString stringWithFormat:@"%@:%@",
      reservation[@"task_id"], reservation[@"attempt_id"]];
    if ([reservationIdentities containsObject:reservationKey]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [reservationIdentities addObject:reservationKey];
  }
  NSMutableSet *cleanupIdentities = [NSMutableSet set];
  for (NSDictionary *cleanup in state[@"cleanup"]) {
    if (!DSHAgentWALCleanupShape(cleanup)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if ([cleanupIdentities containsObject:cleanup[@"cleanup_id"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [cleanupIdentities addObject:cleanup[@"cleanup_id"]];
    NSUInteger matchingTranscripts = 0;
    for (NSDictionary *transcript in state[@"transcripts"]) {
      if (![transcript[@"transcript_ref"] isEqual:cleanup[@"transcript_ref"]]) {
        continue;
      }
      matchingTranscripts += 1;
      if (![transcript[@"attempt_id"] isEqual:cleanup[@"attempt_id"]] ||
          ![transcript[@"transcript_sha256"]
              isEqual:cleanup[@"transcript_sha256"]]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
    if (([cleanup[@"status"] isEqualToString:@"pending"] &&
         matchingTranscripts != 1) ||
        ([cleanup[@"status"] isEqualToString:@"discarded"] &&
         matchingTranscripts != 0)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
  }
  NSMutableSet *dispatchKeys = [NSMutableSet set];
  for (NSDictionary *dispatch in state[@"dispatch"]) {
    if (!DSHAgentWALDispatchShape(dispatch)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSError *dispatchBytesError = nil;
    NSData *dispatchBytes = DSHAgentCanonicalJSON(dispatch[@"locator"], &dispatchBytesError);
    NSString *dispatchKey = [NSString stringWithFormat:@"%@:%@",
      dispatch[@"kind"], [[NSString alloc] initWithData:dispatchBytes ?: NSData.data
                                                encoding:NSUTF8StringEncoding]];
    if ([dispatchKeys containsObject:dispatchKey]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [dispatchKeys addObject:dispatchKey];
  }
  NSMutableSet *batchKeys = [NSMutableSet set];
  NSMutableDictionary<NSString *, NSNumber *> *batchCounts =
      [NSMutableDictionary dictionary];
  for (NSDictionary *batch in state[@"batches"]) {
    BOOL validBatch = schemaV2 ? DSHAgentWALBatchShapeV2(batch) :
        DSHAgentWALBatchShapeV1(batch);
    if (!validBatch) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSString *identity = schemaV2
        ? [NSString stringWithFormat:@"%@:%@:%@:%@:%@",
            batch[@"task_id"], batch[@"attempt_id"], batch[@"round_id"],
            batch[@"round_index"], batch[@"batch_revision"]]
        : [NSString stringWithFormat:@"%@:%@:%@",
            batch[@"task_id"], batch[@"attempt_id"], batch[@"manifest_sha256"]];
    if ([batchKeys containsObject:identity]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    [batchKeys addObject:identity];
    NSString *batchAttemptID = batch[@"attempt_id"];
    NSUInteger batchCount = [batchCounts[batchAttemptID] unsignedIntegerValue] + 1;
    if (schemaV2 && batchCount > DSHAgentNativeWALMaxBatchesPerAttempt) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    batchCounts[batchAttemptID] = @(batchCount);
    if (schemaV2 && [batch[@"kind"] isEqualToString:@"read_only_batch"]) {
      continue;
    }
    NSDictionary *reservation = nil;
    for (NSDictionary *candidate in state[@"reservations"]) {
      if ([candidate[@"task_id"] isEqual:batch[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:batch[@"attempt_id"]]) {
        if (reservation != nil ||
            ![candidate[@"root_fingerprint_sha256"]
                isEqual:batch[@"root_fingerprint_sha256"]] ||
            ![candidate[@"binding_revision"] isEqual:batch[@"binding_revision"]] ||
            [batch[@"reservation_delta_bytes"] unsignedIntegerValue] >
                [candidate[@"policy"][@"max_batch_write_bytes"] unsignedIntegerValue] ||
            [(schemaV2 ? batch[@"batch_revision"] : batch[@"reservation_version"])
                unsignedIntegerValue] >
                [candidate[@"reservation_version"] unsignedIntegerValue]) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        reservation = candidate;
      }
    }
    if (reservation == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    for (NSDictionary *manifestCall in batch[@"manifest_calls"]) {
      NSUInteger matchingRows = 0;
      for (NSDictionary *ledger in state[@"ledger"]) {
        if (![ledger[@"locator"] isEqual:manifestCall[@"locator"]]) continue;
        matchingRows += 1;
        NSDictionary *precondition = ledger[@"precondition"];
        // Schema-one batches predate the mutation discriminator and contain
        // file-write calls only.  Validate those rows against their legacy
        // shape before the atomic bootstrap migration adds the V2 digest.
        NSString *mutationKind = schemaV2
            ? manifestCall[@"mutation_kind"] : @"file_write";
        NSString *expectedName = [mutationKind isEqualToString:@"file_write"]
            ? @"write_file" : mutationKind;
        NSString *preconditionSHA = DSHAgentHJ(@"tool-precondition", @{
          @"schema_version" : @1, @"name" : ledger[@"name"],
          @"precondition" : precondition,
        }, error);
        BOOL released = NO;
        for (NSDictionary *reservationKey in reservation[@"keys"]) {
          if ([reservationKey[@"idempotency_key"]
                  isEqual:manifestCall[@"locator"][@"idempotency_key"]] &&
              [reservationKey[@"state"] isEqualToString:@"released"]) {
            released = YES;
            break;
          }
        }
        if (![ledger[@"locator"][@"task_id"] isEqual:batch[@"task_id"]] ||
            ![ledger[@"locator"][@"attempt_id"] isEqual:batch[@"attempt_id"]] ||
            ![ledger[@"root_fingerprint_sha256"]
                isEqual:batch[@"root_fingerprint_sha256"]] ||
            ![ledger[@"binding_revision"] isEqual:batch[@"binding_revision"]] ||
            ![ledger[@"name"] isEqual:expectedName] || preconditionSHA == nil ||
            (schemaV2 &&
             ![preconditionSHA isEqual:manifestCall[@"precondition_sha256"]])) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        if ([mutationKind isEqualToString:@"file_write"]) {
          if (![precondition[@"relative_path_sha256"]
                  isEqual:manifestCall[@"relative_path_sha256"]] ||
              ![precondition[@"prior"] isEqual:manifestCall[@"prior"]] ||
              ![precondition[@"content_sha256"]
                  isEqual:manifestCall[@"content_sha256"]] ||
              ![precondition[@"content_bytes"]
                  isEqual:manifestCall[@"content_bytes"]] ||
              (![ledger[@"reserved_write_bytes"]
                  isEqual:manifestCall[@"content_bytes"]] &&
               !(([ledger[@"state"] isEqualToString:@"intent"] ||
                  [ledger[@"state"] isEqualToString:@"cancelled"]) &&
                 [ledger[@"reserved_write_bytes"] isEqual:@0] && released))) {
            DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
            return NO;
          }
        } else if (![ledger[@"reserved_write_bytes"] isEqual:@0] || released) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
      }
      if (matchingRows != 1) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
  }
  if (schemaV2) {
    if ([(NSArray *)state[@"denied_calls"] count] >
        DSHAgentNativeWALMaxDeniedCalls) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    NSMutableSet *denialKeys = [NSMutableSet set];
    NSMutableDictionary<NSString *, NSNumber *> *denialCounts =
        [NSMutableDictionary dictionary];
    for (NSDictionary *deniedCall in state[@"denied_calls"]) {
      NSError *denialBytesError = nil;
      NSData *denialBytes = DSHAgentCanonicalJSON(deniedCall, &denialBytesError);
      if (!DSHAgentWALDeniedCallShape(deniedCall) || denialBytes == nil ||
          denialBytes.length > 8 * 1024) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      NSArray *identity = @[
        deniedCall[@"task_id"], deniedCall[@"attempt_id"], deniedCall[@"round_id"],
        deniedCall[@"round_index"], deniedCall[@"call_index"], deniedCall[@"call_id"],
        deniedCall[@"arguments_sha256"],
      ];
      NSData *identityKey = DSHAgentCanonicalIdentityKey(identity);
      if (identityKey == nil || [denialKeys containsObject:identityKey]) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      [denialKeys addObject:identityKey];
      NSString *attemptID = deniedCall[@"attempt_id"];
      NSUInteger count = [denialCounts[attemptID] unsignedIntegerValue] + 1;
      if (count > DSHAgentNativeWALMaxDeniedCallsPerAttempt) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      denialCounts[attemptID] = @(count);
      NSUInteger transcriptMatches = 0;
      for (NSDictionary *transcript in state[@"transcripts"]) {
        if (![transcript[@"transcript_ref"]
                isEqual:deniedCall[@"transcript_after"][@"transcript_ref"]]) continue;
        if (![transcript[@"attempt_id"] isEqual:deniedCall[@"attempt_id"]] ||
            ![transcript[@"root_fingerprint_sha256"]
                isEqual:deniedCall[@"root_fingerprint_sha256"]] ||
            [transcript[@"generation"] unsignedLongLongValue] <
                [deniedCall[@"transcript_after"][@"generation"]
                    unsignedLongLongValue]) {
          DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
          return NO;
        }
        transcriptMatches += 1;
      }
      if (transcriptMatches != 1) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
  }
  for (NSDictionary *round in state[@"rounds"]) {
    NSString *dispatchState = DSHAgentFindDispatchState(state[@"dispatch"],
                                                         @"round",
                                                         round[@"locator"]);
    if (dispatchState == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if (([round[@"state"] isEqualToString:@"failed_retryable"] ||
         [round[@"state"] isEqualToString:@"cancelled"] ||
         [round[@"state"] isEqualToString:@"unknown"]) &&
        ![dispatchState isEqualToString:@"not_dispatched"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if ([round[@"state"] isEqualToString:@"completed"] &&
        ![dispatchState isEqualToString:@"dispatched"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
  }
  for (NSDictionary *ledger in state[@"ledger"]) {
    NSString *dispatchState = DSHAgentFindDispatchState(state[@"dispatch"],
                                                         @"execution",
                                                         ledger[@"locator"]);
    if (dispatchState == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if ([ledger[@"state"] isEqualToString:@"cancelled"] &&
        ![dispatchState isEqualToString:@"not_dispatched"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if ([ledger[@"state"] isEqualToString:@"intent"] &&
        ![dispatchState isEqualToString:@"not_dispatched"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if ([ledger[@"state"] isEqualToString:@"unknown"] &&
        ![dispatchState isEqualToString:@"not_dispatched"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if ([ledger[@"state"] isEqualToString:@"ambiguous"] &&
        ![dispatchState isEqualToString:@"dispatched"]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    if ([ledger[@"state"] isEqualToString:@"settled"] &&
        ![dispatchState isEqualToString:@"dispatched"]) {
      // The only settlement without a dispatch is a user denial: the intent
      // row was never dispatched, carries no settled facts or approval
      // reference, and its receipt is exactly the denied-by-user shape.
      NSDictionary *receipt = [ledger[@"receipt"] isKindOfClass:NSDictionary.class]
          ? ledger[@"receipt"] : nil;
      BOOL userDenial = [dispatchState isEqualToString:@"not_dispatched"] &&
          receipt != nil &&
          [receipt[@"outcome"] isEqualToString:@"denied"] &&
          [receipt[@"failure_code"] isEqualToString:@"E_AGENT_DENIED_BY_USER"] &&
          receipt[@"approval_reference"] == NSNull.null &&
          ledger[@"settled_facts"] == NSNull.null &&
          ledger[@"owner"] == NSNull.null;
      if (!userDenial) {
        DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
    }
  }
  // Dispatch markers are a bijection with typed rows.  An orphan marker is
  // not harmless metadata: it could otherwise be mistaken for proof about a
  // later/reused locator.
  for (NSDictionary *dispatch in state[@"dispatch"]) {
    BOOL found = NO;
    NSArray *rows = [dispatch[@"kind"] isEqualToString:@"round"]
        ? state[@"rounds"] : state[@"ledger"];
    for (NSDictionary *row in rows) {
      if ([row[@"locator"] isEqual:dispatch[@"locator"]]) {
        found = YES;
        break;
      }
    }
    if (!found) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
  }
  return YES;
}

static BOOL DSHAgentWALStateBasicValidation(NSDictionary *state,
                                            NSError **error) {
  BOOL schemaV1 = [state[@"schema_version"] isEqual:@1];
  BOOL schemaV2 = [state[@"schema_version"] isEqual:@2];
  NSArray *rootKeys = schemaV1 ? DSHAgentWALV1Keys() : DSHAgentWALV2Keys();
  if ((!schemaV1 && !schemaV2) ||
      !DSHAgentExactDictionaryKeys(state, rootKeys) ||
      !DSHAgentSafeInteger(state[@"generation"], DSHAgentMaximumSafeInteger,
                           YES) ||
      (schemaV2 &&
       (![state[@"authorities"] isKindOfClass:NSArray.class] ||
        ![state[@"operations"] isKindOfClass:NSArray.class] ||
        ![state[@"operation_results"] isKindOfClass:NSArray.class] ||
        ![state[@"denied_calls"] isKindOfClass:NSArray.class])) ||
      ![state[@"transcripts"] isKindOfClass:NSArray.class] ||
      ![state[@"rounds"] isKindOfClass:NSArray.class] ||
      ![state[@"ledger"] isKindOfClass:NSArray.class] ||
      ![state[@"reservations"] isKindOfClass:NSArray.class] ||
      ![state[@"cleanup"] isKindOfClass:NSArray.class] ||
      ![state[@"dispatch"] isKindOfClass:NSArray.class] ||
      ![state[@"batches"] isKindOfClass:NSArray.class]) {
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCorrupt);
    return NO;
  }
  if ([(NSArray *)state[@"transcripts"] count] > DSHAgentNativeWALMaxTranscriptCount) {
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCapacity);
    return NO;
  }
  if ([(NSArray *)state[@"ledger"] count] > DSHAgentNativeWALMaxTranscriptCount *
                                  DSHAgentNativeWALMaxLedgerRowsPerAttempt ||
      [(NSArray *)state[@"rounds"] count] > DSHAgentNativeWALMaxTranscriptCount *
                                   DSHAgentNativeWALMaxRoundRowsPerAttempt) {
    if (error != nullptr) *error = DSHAgentNativeStoreError(
        DSHAgentNativeStoreErrorCapacity);
    return NO;
  }
  NSMutableSet *attempts = [NSMutableSet set];
  for (NSDictionary *row in state[@"ledger"]) {
    if (![row isKindOfClass:NSDictionary.class]) {
      if (error != nullptr) *error = DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSDictionary *locator = row[@"locator"];
    if (![locator isKindOfClass:NSDictionary.class] ||
        !DSHAgentBoundedUTF8String(locator[@"attempt_id"], 128, NO, nullptr)) {
      if (error != nullptr) *error = DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSString *attemptID = locator[@"attempt_id"];
    [attempts addObject:attemptID];
  }
  for (NSString *attemptID in attempts) {
    if (DSHAgentAttemptCount(state[@"ledger"], attemptID) >
        DSHAgentNativeWALMaxLedgerRowsPerAttempt) {
      if (error != nullptr) *error = DSHAgentNativeStoreError(
          DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
  }
  if (!DSHAgentWALRowsShape(state, error)) {
    return NO;
  }
  NSError *canonicalError = nil;
  NSData *canonical = DSHAgentCanonicalJSON(state, &canonicalError);
  if (canonical == nil || canonical.length > DSHAgentNativeWALMaxStoreBytes) {
    if (error != nullptr) *error = canonical == nil
        ? DSHAgentNativeStoreError(DSHAgentNativeStoreErrorCorrupt)
        : DSHAgentNativeStoreError(DSHAgentNativeStoreErrorCapacity);
    return NO;
  }
  return YES;
}

static NSString *DSHAgentFindDispatchState(NSArray *dispatchRows,
                                           NSString *kind,
                                           NSDictionary *locator) {
  for (NSDictionary *entry in dispatchRows) {
    if ([entry[@"kind"] isEqual:kind] && [entry[@"locator"] isEqual:locator]) {
      return entry[@"dispatch_state"];
    }
  }
  return nil;
}

@interface DSHAgentNativeWAL ()
@property(nonatomic, copy, readwrite) NSString *launchId;
@property(nonatomic, strong, readwrite) NSURL *rootURL;
@property(nonatomic, strong, readwrite) NSURL *walURL;
@property(nonatomic, strong) NSRecursiveLock *lock;
@property(nonatomic, copy) DSHAgentNativeWALClock clock;
@property(nonatomic, copy) DSHAgentNativeWALIdentifierGenerator generator;
@property(nonatomic, copy) DSHAgentNativeWALFaultHook faultHook;
@property(nonatomic, strong) NSMutableSet<NSString *> *liveTaskIds;
@property(nonatomic) BOOL storageReady;
@property(nonatomic) BOOL ownerReconciled;
- (BOOL)writeStateLocked:(NSDictionary *)state
            oldGeneration:(NSUInteger)oldGeneration
                     error:(NSError **)error;
- (BOOL)faultAtStage:(NSString *)stage error:(NSError **)error;
@end

static NSDictionary *DSHAgentWALFindOperation(NSArray *operations,
                                              NSString *operationID) {
  for (NSDictionary *operation in operations) {
    if ([operation[@"operation_id"] isEqual:operationID]) return operation;
  }
  return nil;
}

static NSDictionary *DSHAgentWALFindOperationResult(NSArray *results,
                                                    NSString *operationID) {
  for (NSDictionary *result in results) {
    if ([result[@"operation_id"] isEqual:operationID]) return result;
  }
  return nil;
}

static BOOL DSHAgentWALCanonicalEqual(id left, id right) {
  NSError *error = nil;
  NSData *leftBytes = DSHAgentCanonicalJSON(left, &error);
  NSData *rightBytes = DSHAgentCanonicalJSON(right, &error);
  return leftBytes != nil && rightBytes != nil && [leftBytes isEqual:rightBytes];
}

static BOOL DSHAgentWALCompactAcknowledgedEvidence(NSMutableDictionary *state) {
  NSMutableSet *acknowledgedAttempts = [NSMutableSet set];
  for (NSDictionary *cleanup in state[@"cleanup"]) {
    if ([cleanup[@"status"] isEqualToString:@"discarded"] &&
        [cleanup[@"attempt_id"] isKindOfClass:NSString.class]) {
      [acknowledgedAttempts addObject:cleanup[@"attempt_id"]];
    }
  }
  if (acknowledgedAttempts.count == 0) return NO;
  NSMutableSet *protectedAttempts = [NSMutableSet set];
  for (NSDictionary *authority in state[@"authorities"]) {
    [protectedAttempts addObject:authority[@"attempt_id"]];
  }
  for (NSDictionary *round in state[@"rounds"]) {
    if ([round[@"state"] isEqualToString:@"in_flight"] ||
        [round[@"state"] isEqualToString:@"cancel_requested"] ||
        [round[@"state"] isEqualToString:@"failed_retryable"] ||
        [round[@"state"] isEqualToString:@"unknown"] ||
        [round[@"state"] isEqualToString:@"ambiguous"]) {
      [protectedAttempts addObject:round[@"locator"][@"attempt_id"]];
    }
  }
  for (NSDictionary *ledger in state[@"ledger"]) {
    if ([ledger[@"state"] isEqualToString:@"intent"] ||
        [ledger[@"state"] isEqualToString:@"running"] ||
        [ledger[@"state"] isEqualToString:@"cancel_requested"] ||
        [ledger[@"state"] isEqualToString:@"unknown"] ||
        [ledger[@"state"] isEqualToString:@"ambiguous"]) {
      [protectedAttempts addObject:ledger[@"locator"][@"attempt_id"]];
    }
  }
  [acknowledgedAttempts minusSet:protectedAttempts];
  if (acknowledgedAttempts.count == 0) return NO;
  NSMutableSet *removedOperationIDs = [NSMutableSet set];
  NSMutableArray *operations = [NSMutableArray array];
  for (NSDictionary *operation in state[@"operations"]) {
    BOOL terminal = [operation[@"state"] isEqualToString:@"committed"] ||
        [operation[@"state"] isEqualToString:@"rejected"] ||
        [operation[@"state"] isEqualToString:@"conflict"];
    if (terminal && [acknowledgedAttempts containsObject:operation[@"attempt_id"]]) {
      [removedOperationIDs addObject:operation[@"operation_id"]];
    } else {
      [operations addObject:operation];
    }
  }
  NSMutableArray *results = [NSMutableArray array];
  for (NSDictionary *result in state[@"operation_results"]) {
    if (![removedOperationIDs containsObject:result[@"operation_id"]]) {
      [results addObject:result];
    }
  }
  NSMutableArray *batches = [NSMutableArray array];
  for (NSDictionary *batch in state[@"batches"]) {
    if (![acknowledgedAttempts containsObject:batch[@"attempt_id"]]) {
      [batches addObject:batch];
    }
  }
  NSMutableArray *denials = [NSMutableArray array];
  for (NSDictionary *denial in state[@"denied_calls"]) {
    if (![acknowledgedAttempts containsObject:denial[@"attempt_id"]]) {
      [denials addObject:denial];
    }
  }
  BOOL changed = operations.count != [(NSArray *)state[@"operations"] count] ||
      results.count != [(NSArray *)state[@"operation_results"] count] ||
      batches.count != [(NSArray *)state[@"batches"] count] ||
      denials.count != [(NSArray *)state[@"denied_calls"] count];
  if (changed) {
    state[@"operations"] = operations;
    state[@"operation_results"] = results;
    state[@"batches"] = batches;
    state[@"denied_calls"] = denials;
  }
  return changed;
}

static NSString *DSHAgentWALRequestSHA(NSString *operationKind,
                                      NSDictionary *request,
                                      NSError **error) {
  return DSHAgentHJ(@"agent-operation-request", @{
    @"operation_kind" : operationKind,
    @"request" : request,
  }, error);
}

static NSDictionary *DSHAgentWALMakeOperationResult(
    NSString *operationID,
    NSString *operationKind,
    NSString *resultStatus,
    NSDictionary *safeResult,
    NSString *timestamp,
    NSError **error) {
  if (!DSHAgentWALSafeResultShape(safeResult, operationKind, operationID,
                                  resultStatus)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSData *resultBytes = DSHAgentCanonicalJSON(safeResult, error);
  NSString *resultSHA = DSHAgentHJ(@"agent-operation-result", @{
    @"operation_kind" : operationKind,
    @"result_status" : resultStatus,
    @"result" : safeResult,
  }, error);
  if (resultBytes == nil || resultBytes.length == 0 ||
      resultBytes.length > DSHAgentNativeWALMaxOperationResultBytes ||
      resultSHA == nil) {
    DSHSetAgentNativeStoreError(error,
        resultBytes != nil && resultBytes.length >
            DSHAgentNativeWALMaxOperationResultBytes
            ? DSHAgentNativeStoreErrorCapacity
            : DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *snapshot = @{
    @"schema_version" : @2,
    @"operation_id" : operationID,
    @"operation_kind" : operationKind,
    @"result_status" : resultStatus,
    @"result_sha256" : resultSHA,
    @"result_bytes" : @(resultBytes.length),
    @"result" : safeResult,
    @"created_at" : timestamp,
  };
  if (!DSHAgentWALOperationResultShape(snapshot)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  return snapshot;
}

static NSDictionary *DSHAgentWALReplayEnvelope(NSDictionary *operation,
                                               NSDictionary *snapshot) {
  if (snapshot == nil) {
    return @{
      @"schema_version" : @2,
      @"status" : @"started",
      @"request_sha256" : operation[@"request_sha256"],
      @"record" : operation,
      @"result" : NSNull.null,
    };
  }
  return @{
    @"schema_version" : @2,
    @"status" : @"replayed",
    @"request_sha256" : operation[@"request_sha256"],
    @"record" : operation,
    @"result" : snapshot[@"result"],
  };
}

static NSDictionary *DSHAgentWALStartValidatedOperation(
    DSHAgentNativeWAL *wal,
    NSString *operationKind,
    NSString *operationID,
    NSString *requestSHA,
    NSString *taskId,
    NSString *attemptId,
    NSNumber *authorityRevision,
    NSError **error) {
  __block NSDictionary *output = nil;
  BOOL committed = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSDictionary *existing = DSHAgentWALFindOperation(state[@"operations"],
                                                       operationID);
    if (existing != nil) {
      if (![existing[@"request_sha256"] isEqual:requestSHA] ||
          ![existing[@"operation_kind"] isEqual:operationKind] ||
          ![existing[@"task_id"] isEqual:taskId] ||
          ![existing[@"attempt_id"] isEqual:attemptId] ||
          ![existing[@"authority_revision"] isEqual:authorityRevision]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSDictionary *snapshot = DSHAgentWALFindOperationResult(
          state[@"operation_results"], operationID);
      output = DSHAgentWALReplayEnvelope(existing, snapshot);
      return NO;
    }
    NSUInteger attemptCount = 0;
    for (NSDictionary *candidate in state[@"operations"]) {
      if ([candidate[@"attempt_id"] isEqual:attemptId]) attemptCount += 1;
    }
    if (attemptCount >= DSHAgentNativeWALMaxOperationsPerAttempt ||
        [(NSArray *)state[@"operations"] count] >=
            DSHAgentNativeWALMaxOperations) {
      DSHAgentWALCompactAcknowledgedEvidence(state);
      attemptCount = 0;
      for (NSDictionary *candidate in state[@"operations"]) {
        if ([candidate[@"attempt_id"] isEqual:attemptId]) attemptCount += 1;
      }
      if (attemptCount >= DSHAgentNativeWALMaxOperationsPerAttempt ||
          [(NSArray *)state[@"operations"] count] >=
              DSHAgentNativeWALMaxOperations) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
    }
    NSString *timestamp = [wal currentTimestamp];
    NSDictionary *record = @{
      @"schema_version" : @2,
      @"operation_id" : operationID,
      @"operation_kind" : operationKind,
      @"request_sha256" : requestSHA,
      @"task_id" : taskId,
      @"attempt_id" : attemptId,
      @"result_ref" : @{ @"schema_version" : @2, @"kind" : @"none" },
      @"state" : @"started",
      @"result_status" : @"pending",
      @"result_revision" : NSNull.null,
      @"result_snapshot_ref" : NSNull.null,
      @"authority_revision" : authorityRevision,
      @"created_at" : timestamp,
      @"updated_at" : timestamp,
    };
    NSError *bytesError = nil;
    NSData *recordBytes = DSHAgentCanonicalJSON(record, &bytesError);
    if (!DSHAgentWALOperationShape(record) || recordBytes == nil ||
        recordBytes.length > DSHAgentNativeWALMaxOperationRecordBytes) {
      DSHSetAgentNativeStoreError(mutationError,
          recordBytes != nil && recordBytes.length >
              DSHAgentNativeWALMaxOperationRecordBytes
              ? DSHAgentNativeStoreErrorCapacity
              : DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSMutableArray *operations = [state[@"operations"] mutableCopy];
    [operations addObject:record];
    state[@"operations"] = operations;
    output = DSHAgentWALReplayEnvelope(record, nil);
    return YES;
  } error:error];
  if (!committed && output != nil && (error == nullptr || *error == nil)) {
    return DSHAgentImmutableJSONCopy(output, error);
  }
  return committed ? DSHAgentImmutableJSONCopy(output, error) : nil;
}

static BOOL DSHAgentWALTargetIdentity(NSDictionary *target,
                                      NSString *taskId,
                                      NSString *attemptId) {
  if (![target isKindOfClass:NSDictionary.class] ||
      ![target[@"schema_version"] isEqual:@2] ||
      ![target[@"task_id"] isEqual:taskId] ||
      ![target[@"attempt_id"] isEqual:attemptId] ||
      !DSHAgentCanonicalUUID(taskId) || !DSHAgentCanonicalUUID(attemptId) ||
      ![target[@"kind"] isKindOfClass:NSString.class]) return NO;
  NSString *kind = target[@"kind"];
  if ([kind isEqualToString:@"attempt"]) {
    return DSHAgentExactDictionaryKeys(target, @[
      @"schema_version", @"kind", @"task_id", @"attempt_id",
    ]);
  }
  if (![kind isEqualToString:@"round"] && ![kind isEqualToString:@"tool"]) {
    return NO;
  }
  NSMutableArray<NSString *> *keys = [@[
    @"schema_version", @"kind", @"task_id", @"attempt_id", @"round_id",
    @"round_index",
  ] mutableCopy];
  if (!DSHAgentCanonicalUUID(target[@"round_id"]) ||
      !DSHAgentSafeInteger(target[@"round_index"], 7, YES)) return NO;
  if ([kind isEqualToString:@"round"]) {
    return DSHAgentExactDictionaryKeys(target, keys);
  }
  [keys addObjectsFromArray:@[
    @"call_index", @"call_id", @"idempotency_key",
  ]];
  return DSHAgentExactDictionaryKeys(target, keys) &&
      DSHAgentSafeInteger(target[@"call_index"], 15, YES) &&
      DSHAgentWALOpaqueCallID(target[@"call_id"]) &&
      DSHAgentCanonicalSHA256(target[@"idempotency_key"]);
}

NSDictionary *DSHAgentNativeWALStartOperation(
    DSHAgentNativeWAL *wal,
    NSString *operationKind,
    NSDictionary *request,
    NSString *taskId,
    NSString *attemptId,
    NSNumber *authorityRevision,
    NSError **error) {
  NSError *copyError = nil;
  NSDictionary *safeRequest = DSHAgentImmutableJSONCopy(request, &copyError);
  NSString *operationID = safeRequest[@"operation_id"];
  if (wal == nil || ![DSHAgentWALOperationKinds() containsObject:operationKind] ||
      ![safeRequest isKindOfClass:NSDictionary.class] ||
      ![safeRequest[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(operationID) || !DSHAgentCanonicalUUID(taskId) ||
      !DSHAgentCanonicalUUID(attemptId) ||
      ![safeRequest[@"task_id"] isEqual:taskId] ||
      ![safeRequest[@"attempt_id"] isEqual:attemptId] ||
      !DSHAgentSafeInteger(authorityRevision, DSHAgentMaximumSafeInteger, YES) ||
      DSHAgentWALContainsForbiddenSafeKey(safeRequest)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *requestSHA = DSHAgentWALRequestSHA(operationKind, safeRequest, error);
  if (requestSHA == nil) return nil;
  return DSHAgentWALStartValidatedOperation(
      wal, operationKind, operationID, requestSHA, taskId, attemptId,
      authorityRevision, error);
}

NSDictionary *DSHAgentNativeWALStartTargetOperation(
    DSHAgentNativeWAL *wal,
    NSString *operationKind,
    NSDictionary *request,
    NSDictionary *target,
    NSString *taskId,
    NSString *attemptId,
    NSNumber *authorityRevision,
    NSError **error) {
  NSError *copyError = nil;
  NSDictionary *safeRequest = DSHAgentImmutableJSONCopy(request, &copyError);
  NSDictionary *safeTarget = DSHAgentImmutableJSONCopy(target, &copyError);
  NSArray<NSString *> *requestKeys = nil;
  if ([operationKind isEqualToString:@"cancel_agent_attempt"]) {
    requestKeys = @[
      @"schema_version", @"operation_id", @"controller_cas",
      @"committed_checkpoint", @"target", @"cancel_token",
      @"expected_round_revision", @"expected_execution_revision",
      @"expected_transcript", @"root",
    ];
  } else if ([operationKind isEqualToString:@"recover_agent_attempt"]) {
    requestKeys = @[
      @"schema_version", @"operation_id", @"controller_cas",
      @"committed_checkpoint", @"target", @"action",
      @"expected_round_revision", @"expected_execution_revision",
      @"expected_transcript", @"root",
    ];
  }
  NSString *operationID = safeRequest[@"operation_id"];
  if (wal == nil || requestKeys == nil ||
      ![safeRequest isKindOfClass:NSDictionary.class] ||
      ![safeTarget isKindOfClass:NSDictionary.class] ||
      !DSHAgentExactDictionaryKeys(safeRequest, requestKeys) ||
      ![safeRequest[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(operationID) ||
      !DSHAgentWALCanonicalEqual(safeRequest[@"target"], safeTarget) ||
      !DSHAgentWALTargetIdentity(safeTarget, taskId, attemptId) ||
      !DSHAgentSafeInteger(authorityRevision, DSHAgentMaximumSafeInteger, YES) ||
      DSHAgentWALContainsForbiddenSafeKey(safeRequest)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *requestSHA = DSHAgentWALRequestSHA(operationKind, safeRequest, error);
  if (requestSHA == nil) return nil;
  return DSHAgentWALStartValidatedOperation(
      wal, operationKind, operationID, requestSHA, taskId, attemptId,
      authorityRevision, error);
}

NSDictionary *DSHAgentNativeWALQueryOperation(
    DSHAgentNativeWAL *wal,
    NSString *operationId,
    NSString *requestSHA256,
    NSString *taskId,
    NSString *attemptId,
    NSError **error) {
  if (wal == nil || !DSHAgentCanonicalUUID(operationId) ||
      !DSHAgentCanonicalSHA256(requestSHA256) ||
      !DSHAgentCanonicalUUID(taskId) || !DSHAgentCanonicalUUID(attemptId)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *state = [wal snapshotWithError:error];
  if (state == nil) return nil;
  NSDictionary *operation = DSHAgentWALFindOperation(state[@"operations"],
                                                     operationId);
  if (operation == nil) return @{
    @"schema_version" : @2,
    @"status" : @"not_started",
  };
  if (![operation[@"request_sha256"] isEqual:requestSHA256] ||
      ![operation[@"task_id"] isEqual:taskId] ||
      ![operation[@"attempt_id"] isEqual:attemptId]) {
    return @{
      @"schema_version" : @2,
      @"status" : @"conflict",
      @"actual_request_sha256" : operation[@"request_sha256"],
      @"actual_state" : operation[@"state"],
    };
  }
  return @{
    @"schema_version" : @2,
    @"status" : @"found",
    @"record" : operation,
  };
}

NSDictionary *DSHAgentNativeWALCommitOperationInState(
    NSMutableDictionary *state,
    DSHAgentNativeWAL *wal,
    NSString *operationId,
    NSString *requestSHA256,
    NSString *taskId,
    NSString *attemptId,
    NSString *terminalState,
    NSString *resultStatus,
    NSDictionary *resultRef,
    NSNumber *resultRevision,
    NSDictionary *safeResult,
    NSError **error) {
  NSSet *terminalStates = [NSSet setWithArray:@[
    @"committed", @"rejected", @"conflict", @"unknown", @"ambiguous",
  ]];
  NSError *copyError = nil;
  NSDictionary *immutableRef = DSHAgentImmutableJSONCopy(resultRef, &copyError);
  NSDictionary *immutableResult = DSHAgentImmutableJSONCopy(safeResult, &copyError);
  if (![state isKindOfClass:NSMutableDictionary.class] || wal == nil ||
      !DSHAgentCanonicalUUID(operationId) ||
      !DSHAgentCanonicalSHA256(requestSHA256) ||
      !DSHAgentCanonicalUUID(taskId) || !DSHAgentCanonicalUUID(attemptId) ||
      ![terminalStates containsObject:terminalState] ||
      !DSHAgentWALKnownOperationResultStatus(resultStatus) ||
      !DSHAgentWALResultReferenceShape(immutableRef) ||
      !(resultRevision == nil || resultRevision == (id)NSNull.null ||
        DSHAgentSafeInteger(resultRevision, DSHAgentMaximumSafeInteger, NO)) ||
      ![immutableResult isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  BOOL none = [immutableRef[@"kind"] isEqualToString:@"none"];
  BOOL nullRevision = resultRevision == nil || resultRevision == (id)NSNull.null;
  if (([terminalState isEqualToString:@"committed"] &&
       (none || nullRevision)) ||
      (([terminalState isEqualToString:@"rejected"] ||
        [terminalState isEqualToString:@"conflict"]) &&
       (!none || !nullRevision)) ||
      (([terminalState isEqualToString:@"unknown"] ||
        [terminalState isEqualToString:@"ambiguous"]) &&
       (none != nullRevision))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSMutableArray *operations = [state[@"operations"] mutableCopy];
  NSUInteger operationIndex = NSNotFound;
  NSDictionary *operation = nil;
  for (NSUInteger index = 0; index < operations.count; index += 1) {
    if ([operations[index][@"operation_id"] isEqual:operationId]) {
      operationIndex = index;
      operation = operations[index];
      break;
    }
  }
  if (operation == nil || ![operation[@"request_sha256"] isEqual:requestSHA256] ||
      ![operation[@"task_id"] isEqual:taskId] ||
      ![operation[@"attempt_id"] isEqual:attemptId] ||
      !DSHAgentWALOperationResultStatusAllowed(operation[@"operation_kind"],
                                               resultStatus)) {
    DSHSetAgentNativeStoreError(error, operation == nil
        ? DSHAgentNativeStoreErrorNotFound : DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  NSDictionary *snapshot = DSHAgentWALMakeOperationResult(
      operationId, operation[@"operation_kind"], resultStatus,
      immutableResult, [wal currentTimestamp], error);
  if (snapshot == nil) return nil;
  NSDictionary *existingSnapshot = DSHAgentWALFindOperationResult(
      state[@"operation_results"], operationId);
  if (![operation[@"state"] isEqualToString:@"started"]) {
    NSNumber *normalizedRevision = nullRevision ? (id)NSNull.null : resultRevision;
    if ([operation[@"state"] isEqual:terminalState] &&
        [operation[@"result_status"] isEqual:resultStatus] &&
        [operation[@"result_ref"] isEqual:immutableRef] &&
        [operation[@"result_revision"] isEqual:normalizedRevision] &&
        DSHAgentWALCanonicalEqual(existingSnapshot, snapshot)) {
      return DSHAgentWALReplayEnvelope(operation, existingSnapshot);
    }
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return nil;
  }
  if (existingSnapshot != nil ||
      ![wal faultAtStage:@"wal.operation.before_result_commit" error:error]) {
    if (existingSnapshot != nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    }
    return nil;
  }
  NSMutableDictionary *updated = [operation mutableCopy];
  updated[@"state"] = terminalState;
  updated[@"result_status"] = resultStatus;
  updated[@"result_ref"] = immutableRef;
  updated[@"result_revision"] = nullRevision ? (id)NSNull.null : resultRevision;
  updated[@"result_snapshot_ref"] = @{
    @"schema_version" : @2, @"operation_id" : operationId,
    @"result_sha256" : snapshot[@"result_sha256"],
    @"result_bytes" : snapshot[@"result_bytes"],
  };
  updated[@"updated_at"] = [wal currentTimestamp];
  NSData *recordBytes = DSHAgentCanonicalJSON(updated, error);
  if (!DSHAgentWALOperationShape(updated) || recordBytes == nil ||
      recordBytes.length > DSHAgentNativeWALMaxOperationRecordBytes) {
    DSHSetAgentNativeStoreError(error,
        recordBytes != nil && recordBytes.length >
            DSHAgentNativeWALMaxOperationRecordBytes
            ? DSHAgentNativeStoreErrorCapacity
            : DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSMutableArray *results = [state[@"operation_results"] mutableCopy];
  if (results.count >= DSHAgentNativeWALMaxOperations) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
    return nil;
  }
  operations[operationIndex] = updated;
  [results addObject:snapshot];
  state[@"operations"] = operations;
  state[@"operation_results"] = results;
  return DSHAgentWALReplayEnvelope(updated, snapshot);
}

NSDictionary *DSHAgentNativeWALCommitOperation(
    DSHAgentNativeWAL *wal,
    NSString *operationId,
    NSString *requestSHA256,
    NSString *taskId,
    NSString *attemptId,
    NSString *terminalState,
    NSString *resultStatus,
    NSDictionary *resultRef,
    NSNumber *resultRevision,
    NSDictionary *safeResult,
    NSError **error) {
  NSSet *terminalStates = [NSSet setWithArray:@[
    @"committed", @"rejected", @"conflict", @"unknown", @"ambiguous",
  ]];
  NSError *copyError = nil;
  NSDictionary *immutableRef = DSHAgentImmutableJSONCopy(resultRef, &copyError);
  NSDictionary *immutableResult = DSHAgentImmutableJSONCopy(safeResult, &copyError);
  if (wal == nil || !DSHAgentCanonicalUUID(operationId) ||
      !DSHAgentCanonicalSHA256(requestSHA256) || !DSHAgentCanonicalUUID(taskId) ||
      !DSHAgentCanonicalUUID(attemptId) ||
      ![terminalStates containsObject:terminalState] ||
      !DSHAgentWALKnownOperationResultStatus(resultStatus) ||
      !DSHAgentWALResultReferenceShape(immutableRef) ||
      !(resultRevision == nil || resultRevision == (id)NSNull.null ||
        DSHAgentSafeInteger(resultRevision, DSHAgentMaximumSafeInteger, NO)) ||
      ![immutableResult isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  BOOL none = [immutableRef[@"kind"] isEqualToString:@"none"];
  BOOL nullRevision = resultRevision == nil || resultRevision == (id)NSNull.null;
  if (([terminalState isEqualToString:@"committed"] &&
       (none || nullRevision)) ||
      (([terminalState isEqualToString:@"rejected"] ||
        [terminalState isEqualToString:@"conflict"]) &&
       (!none || !nullRevision)) ||
      (([terminalState isEqualToString:@"unknown"] ||
        [terminalState isEqualToString:@"ambiguous"]) &&
       (none != nullRevision))) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *operations = [state[@"operations"] mutableCopy];
    NSUInteger operationIndex = NSNotFound;
    NSDictionary *operation = nil;
    for (NSUInteger index = 0; index < operations.count; index += 1) {
      if ([operations[index][@"operation_id"] isEqual:operationId]) {
        operationIndex = index;
        operation = operations[index];
        break;
      }
    }
    if (operation == nil || ![operation[@"request_sha256"] isEqual:requestSHA256] ||
        ![operation[@"task_id"] isEqual:taskId] ||
        ![operation[@"attempt_id"] isEqual:attemptId] ||
        !DSHAgentWALOperationResultStatusAllowed(operation[@"operation_kind"],
                                                 resultStatus)) {
      DSHSetAgentNativeStoreError(mutationError,
                                  operation == nil
                                      ? DSHAgentNativeStoreErrorNotFound
                                      : DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSDictionary *snapshot = DSHAgentWALMakeOperationResult(
        operationId, operation[@"operation_kind"], resultStatus,
        immutableResult, [wal currentTimestamp], mutationError);
    if (snapshot == nil) return NO;
    NSDictionary *existingSnapshot = DSHAgentWALFindOperationResult(
        state[@"operation_results"], operationId);
    if (![operation[@"state"] isEqualToString:@"started"]) {
      NSNumber *normalizedRevision = nullRevision ? (id)NSNull.null : resultRevision;
      if ([operation[@"state"] isEqual:terminalState] &&
          [operation[@"result_status"] isEqual:resultStatus] &&
          [operation[@"result_ref"] isEqual:immutableRef] &&
          [operation[@"result_revision"] isEqual:normalizedRevision] &&
          DSHAgentWALCanonicalEqual(existingSnapshot, snapshot)) {
        output = DSHAgentWALReplayEnvelope(operation, existingSnapshot);
        return NO;
      }
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    if (existingSnapshot != nil) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCorrupt);
      return NO;
    }
    NSMutableDictionary *updated = [operation mutableCopy];
    updated[@"state"] = terminalState;
    updated[@"result_status"] = resultStatus;
    updated[@"result_ref"] = immutableRef;
    updated[@"result_revision"] = nullRevision ? (id)NSNull.null : resultRevision;
    updated[@"result_snapshot_ref"] = @{
      @"schema_version" : @2,
      @"operation_id" : operationId,
      @"result_sha256" : snapshot[@"result_sha256"],
      @"result_bytes" : snapshot[@"result_bytes"],
    };
    updated[@"updated_at"] = [wal currentTimestamp];
    NSError *recordBytesError = nil;
    NSData *recordBytes = DSHAgentCanonicalJSON(updated, &recordBytesError);
    if (!DSHAgentWALOperationShape(updated) || recordBytes == nil ||
        recordBytes.length > DSHAgentNativeWALMaxOperationRecordBytes) {
      DSHSetAgentNativeStoreError(mutationError,
          recordBytes != nil && recordBytes.length >
              DSHAgentNativeWALMaxOperationRecordBytes
              ? DSHAgentNativeStoreErrorCapacity
              : DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    operations[operationIndex] = updated;
    NSMutableArray *results = [state[@"operation_results"] mutableCopy];
    if (results.count >= DSHAgentNativeWALMaxOperations) {
      DSHSetAgentNativeStoreError(mutationError, DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    [results addObject:snapshot];
    state[@"operations"] = operations;
    state[@"operation_results"] = results;
    output = DSHAgentWALReplayEnvelope(updated, snapshot);
    return YES;
  } error:error];
  if (!committed && output != nil && (error == nullptr || *error == nil)) {
    return DSHAgentImmutableJSONCopy(output, error);
  }
  return committed ? DSHAgentImmutableJSONCopy(output, error) : nil;
}

NSDictionary *DSHAgentNativeWALPrepareAuthorityOperation(
    DSHAgentNativeWAL *wal,
    NSDictionary *authority,
    NSDictionary *request,
    NSDictionary *safeResult,
    NSError **error) {
  NSError *copyError = nil;
  NSDictionary *immutableAuthority = DSHAgentImmutableJSONCopy(authority, &copyError);
  NSDictionary *immutableRequest = DSHAgentImmutableJSONCopy(request, &copyError);
  NSDictionary *immutableResult = DSHAgentImmutableJSONCopy(safeResult, &copyError);
  NSString *operationID = immutableRequest[@"operation_id"];
  NSString *taskID = immutableAuthority[@"task_id"];
  NSString *attemptID = immutableAuthority[@"attempt_id"];
  NSString *resultStatus = immutableResult[@"result"][@"status"];
  if (wal == nil || !DSHAgentWALAuthorityShape(immutableAuthority) ||
      ![immutableAuthority[@"authority_revision"] isEqual:@1] ||
      ![immutableRequest[@"schema_version"] isEqual:@2] ||
      !DSHAgentCanonicalUUID(operationID) ||
      ![immutableRequest[@"task_id"] isEqual:taskID] ||
      ![immutableRequest[@"attempt_id"] isEqual:attemptID] ||
      ![immutableRequest[@"conversation_id"]
          isEqual:immutableAuthority[@"conversation_id"]] ||
      DSHAgentWALContainsForbiddenSafeKey(immutableRequest) ||
      !DSHAgentWALOperationResultStatusAllowed(@"prepare_agent_attempt",
                                               resultStatus) ||
      !DSHAgentWALSafeResultShape(immutableResult, @"prepare_agent_attempt",
                                  operationID, resultStatus)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *requestSHA = DSHAgentWALRequestSHA(@"prepare_agent_attempt",
                                               immutableRequest, error);
  if (requestSHA == nil) return nil;
  __block NSDictionary *output = nil;
  BOOL committed = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSDictionary *existingOperation = DSHAgentWALFindOperation(
        state[@"operations"], operationID);
    if (existingOperation != nil) {
      if (![existingOperation[@"request_sha256"] isEqual:requestSHA] ||
          ![existingOperation[@"operation_kind"]
              isEqualToString:@"prepare_agent_attempt"] ||
          ![existingOperation[@"task_id"] isEqual:taskID] ||
          ![existingOperation[@"attempt_id"] isEqual:attemptID]) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      NSDictionary *snapshot = DSHAgentWALFindOperationResult(
          state[@"operation_results"], operationID);
      if (snapshot == nil) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorPersistence);
        return NO;
      }
      output = DSHAgentWALReplayEnvelope(existingOperation, snapshot);
      return NO;
    }
    NSDictionary *existingAuthority = nil;
    for (NSDictionary *candidate in state[@"authorities"]) {
      if ([candidate[@"task_id"] isEqual:taskID] &&
          [candidate[@"attempt_id"] isEqual:attemptID]) {
        existingAuthority = candidate;
        break;
      }
    }
    if (existingAuthority != nil ||
        [(NSArray *)state[@"authorities"] count] >=
            DSHAgentNativeWALMaxAuthorities) {
      DSHSetAgentNativeStoreError(mutationError,
          existingAuthority != nil ? DSHAgentNativeStoreErrorConflict :
                                     DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    NSUInteger operationCount = 0;
    for (NSDictionary *operation in state[@"operations"]) {
      if ([operation[@"attempt_id"] isEqual:attemptID]) operationCount += 1;
    }
    if (operationCount >= DSHAgentNativeWALMaxOperationsPerAttempt ||
        [(NSArray *)state[@"operations"] count] >=
            DSHAgentNativeWALMaxOperations ||
        [(NSArray *)state[@"operation_results"] count] >=
            DSHAgentNativeWALMaxOperations) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorCapacity);
      return NO;
    }
    BOOL transcriptMatches = NO;
    for (NSDictionary *transcript in state[@"transcripts"]) {
      if ([transcript[@"transcript_ref"]
              isEqual:immutableAuthority[@"transcript"][@"transcript_ref"]] &&
          [transcript[@"attempt_id"] isEqual:attemptID] &&
          [transcript[@"root_fingerprint_sha256"]
              isEqual:immutableAuthority[@"root"][@"root_fingerprint_sha256"]] &&
          [transcript[@"generation"]
              isEqual:immutableAuthority[@"transcript"][@"generation"]] &&
          [transcript[@"transcript_sha256"]
              isEqual:immutableAuthority[@"transcript"][@"transcript_sha256"]] &&
          [transcript[@"transcript_bytes"]
              isEqual:immutableAuthority[@"transcript"][@"transcript_bytes"]]) {
        transcriptMatches = YES;
        break;
      }
    }
    if (!transcriptMatches) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    NSString *timestamp = [wal currentTimestamp];
    NSDictionary *snapshot = DSHAgentWALMakeOperationResult(
        operationID, @"prepare_agent_attempt", resultStatus, immutableResult,
        timestamp, mutationError);
    if (snapshot == nil) return NO;
    NSDictionary *resultRef = @{
      @"schema_version" : @2,
      @"kind" : @"authority",
      @"task_id" : taskID,
      @"attempt_id" : attemptID,
      @"authority_revision" : @1,
    };
    NSDictionary *operation = @{
      @"schema_version" : @2,
      @"operation_id" : operationID,
      @"operation_kind" : @"prepare_agent_attempt",
      @"request_sha256" : requestSHA,
      @"task_id" : taskID,
      @"attempt_id" : attemptID,
      @"result_ref" : resultRef,
      @"state" : @"committed",
      @"result_status" : resultStatus,
      @"result_revision" : @1,
      @"result_snapshot_ref" : @{
        @"schema_version" : @2,
        @"operation_id" : operationID,
        @"result_sha256" : snapshot[@"result_sha256"],
        @"result_bytes" : snapshot[@"result_bytes"],
      },
      @"authority_revision" : @1,
      @"created_at" : timestamp,
      @"updated_at" : timestamp,
    };
    if (!DSHAgentWALOperationShape(operation)) {
      DSHSetAgentNativeStoreError(mutationError,
                                  DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSMutableArray *authorities = [state[@"authorities"] mutableCopy];
    NSMutableArray *operations = [state[@"operations"] mutableCopy];
    NSMutableArray *results = [state[@"operation_results"] mutableCopy];
    [authorities addObject:immutableAuthority];
    [operations addObject:operation];
    [results addObject:snapshot];
    state[@"authorities"] = authorities;
    state[@"operations"] = operations;
    state[@"operation_results"] = results;
    output = DSHAgentWALReplayEnvelope(operation, snapshot);
    return YES;
  } error:error];
  if (!committed && output != nil && (error == nullptr || *error == nil)) {
    return DSHAgentImmutableJSONCopy(output, error);
  }
  return committed ? DSHAgentImmutableJSONCopy(output, error) : nil;
}

NSDictionary *DSHAgentNativeWALRecordBatch(DSHAgentNativeWAL *wal,
                                           NSDictionary *batch,
                                           NSError **error) {
  NSError *copyError = nil;
  NSDictionary *immutableBatch = DSHAgentImmutableJSONCopy(batch, &copyError);
  if (wal == nil || !DSHAgentWALBatchShapeV2(immutableBatch)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *batches = [state[@"batches"] mutableCopy];
    NSUInteger attemptCount = 0;
    for (NSDictionary *candidate in batches) {
      if ([candidate[@"attempt_id"] isEqual:immutableBatch[@"attempt_id"]]) {
        attemptCount += 1;
      }
      BOOL sameIdentity =
          [candidate[@"task_id"] isEqual:immutableBatch[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:immutableBatch[@"attempt_id"]] &&
          [candidate[@"round_id"] isEqual:immutableBatch[@"round_id"]] &&
          [candidate[@"round_index"] isEqual:immutableBatch[@"round_index"]] &&
          [candidate[@"batch_revision"]
              isEqual:immutableBatch[@"batch_revision"]];
      if (!sameIdentity) continue;
      if (!DSHAgentWALCanonicalEqual(candidate, immutableBatch)) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      output = candidate;
      return NO;
    }
    if (attemptCount >= DSHAgentNativeWALMaxBatchesPerAttempt) {
      DSHAgentWALCompactAcknowledgedEvidence(state);
      attemptCount = 0;
      for (NSDictionary *candidate in state[@"batches"]) {
        if ([candidate[@"attempt_id"] isEqual:immutableBatch[@"attempt_id"]]) {
          attemptCount += 1;
        }
      }
      if (attemptCount >= DSHAgentNativeWALMaxBatchesPerAttempt) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      batches = [state[@"batches"] mutableCopy];
    }
    [batches addObject:immutableBatch];
    state[@"batches"] = batches;
    output = immutableBatch;
    return YES;
  } error:error];
  if (!committed && output != nil && (error == nullptr || *error == nil)) {
    return DSHAgentImmutableJSONCopy(output, error);
  }
  return committed ? DSHAgentImmutableJSONCopy(output, error) : nil;
}

NSDictionary *DSHAgentNativeWALRecordDeniedCall(DSHAgentNativeWAL *wal,
                                                NSDictionary *deniedCall,
                                                NSError **error) {
  NSError *copyError = nil;
  NSDictionary *immutableCall = DSHAgentImmutableJSONCopy(deniedCall, &copyError);
  if (wal == nil || !DSHAgentWALDeniedCallShape(immutableCall)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  __block NSDictionary *output = nil;
  BOOL committed = [wal performAtomicTransaction:^BOOL(
      NSMutableDictionary *state, NSError **mutationError) {
    NSMutableArray *denials = [state[@"denied_calls"] mutableCopy];
    NSUInteger attemptCount = 0;
    for (NSDictionary *candidate in denials) {
      if ([candidate[@"attempt_id"] isEqual:immutableCall[@"attempt_id"]]) {
        attemptCount += 1;
      }
      BOOL sameIdentity =
          [candidate[@"task_id"] isEqual:immutableCall[@"task_id"]] &&
          [candidate[@"attempt_id"] isEqual:immutableCall[@"attempt_id"]] &&
          [candidate[@"round_id"] isEqual:immutableCall[@"round_id"]] &&
          [candidate[@"round_index"] isEqual:immutableCall[@"round_index"]] &&
          [candidate[@"call_index"] isEqual:immutableCall[@"call_index"]] &&
          [candidate[@"call_id"] isEqual:immutableCall[@"call_id"]] &&
          [candidate[@"arguments_sha256"]
              isEqual:immutableCall[@"arguments_sha256"]];
      if (!sameIdentity) continue;
      if (!DSHAgentWALCanonicalEqual(candidate, immutableCall)) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorConflict);
        return NO;
      }
      output = candidate;
      return NO;
    }
    if (attemptCount >= DSHAgentNativeWALMaxDeniedCallsPerAttempt ||
        denials.count >= DSHAgentNativeWALMaxDeniedCalls) {
      DSHAgentWALCompactAcknowledgedEvidence(state);
      denials = [state[@"denied_calls"] mutableCopy];
      attemptCount = 0;
      for (NSDictionary *candidate in denials) {
        if ([candidate[@"attempt_id"] isEqual:immutableCall[@"attempt_id"]]) {
          attemptCount += 1;
        }
      }
      if (attemptCount >= DSHAgentNativeWALMaxDeniedCallsPerAttempt ||
          denials.count >= DSHAgentNativeWALMaxDeniedCalls) {
        DSHSetAgentNativeStoreError(mutationError,
                                    DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
    }
    [denials addObject:immutableCall];
    state[@"denied_calls"] = denials;
    output = immutableCall;
    return YES;
  } error:error];
  if (!committed && output != nil && (error == nullptr || *error == nil)) {
    return DSHAgentImmutableJSONCopy(output, error);
  }
  return committed ? DSHAgentImmutableJSONCopy(output, error) : nil;
}

@implementation DSHAgentNativeWAL

- (instancetype)initWithRootURL:(NSURL *)rootURL
                           clock:(DSHAgentNativeWALClock)clock
              identifierGenerator:(DSHAgentNativeWALIdentifierGenerator)generator
                         faultHook:(DSHAgentNativeWALFaultHook)faultHook {
  self = [super init];
  if (self) {
    _rootURL = [rootURL copy];
    _walURL = [_rootURL URLByAppendingPathComponent:DSHAgentWALFileName];
    _clock = [clock copy];
    _generator = [generator copy];
    _faultHook = [faultHook copy];
    _lock = DSHAgentLockForRoot(_rootURL);
    _liveTaskIds = [NSMutableSet set];
    NSString *candidate = _generator != nil ? _generator() : nil;
    _launchId = DSHAgentCanonicalUUID(candidate)
        ? [candidate copy]
        : NSUUID.UUID.UUIDString.lowercaseString;
  }
  return self;
}

- (instancetype)initWithRootURL:(NSURL *)rootURL
                           clock:(DSHAgentNativeWALClock)clock
               launchIdGenerator:(DSHAgentNativeWALIdentifierGenerator)generator
                       faultHook:(DSHAgentNativeWALFaultHook)faultHook {
  return [self initWithRootURL:rootURL
                          clock:clock
             identifierGenerator:generator
                        faultHook:faultHook];
}

- (BOOL)faultAtStage:(NSString *)stage error:(NSError **)error {
  if (self.faultHook == nil) return YES;
  BOOL allowed = NO;
  @try {
    allowed = self.faultHook(stage);
  } @catch (__unused NSException *exception) {
    allowed = NO;
  }
  if (!allowed) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorPersistence);
    return NO;
  }
  return YES;
}

- (NSDictionary *)loadStateLocked:(NSError **)error {
  if (!DSHAgentDirectoryIsSafe(self.rootURL)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  int rootDescriptor = DSHAgentOpenRootDescriptor(self.rootURL);
  if (rootDescriptor < 0) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  struct stat temporaryMetadata = {};
  if (fstatat(rootDescriptor, [[DSHAgentWALFileName
      stringByAppendingString:DSHAgentWALTemporarySuffix] UTF8String],
              &temporaryMetadata, AT_SYMLINK_NOFOLLOW) == 0) {
    close(rootDescriptor);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  if (errno != ENOENT) {
    close(rootDescriptor);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  struct stat fileMetadata = {};
  if (fstatat(rootDescriptor, DSHAgentWALFileName.UTF8String, &fileMetadata,
              AT_SYMLINK_NOFOLLOW) != 0) {
    BOOL missing = errno == ENOENT;
    close(rootDescriptor);
    if (missing) {
      if (error != nullptr) *error = nil;
      return DSHAgentFreshWALState();
    }
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return nil;
  }
  NSData *data = DSHAgentReadWALAtRoot(rootDescriptor,
                                       DSHAgentWALFileName.UTF8String,
                                       error);
  close(rootDescriptor);
  if (data == nil) return nil;
  if (data.length == 0 || data.length > DSHAgentNativeWALMaxStoreBytes) {
    DSHSetAgentNativeStoreError(error,
                                data.length > DSHAgentNativeWALMaxStoreBytes
                                    ? DSHAgentNativeStoreErrorCapacity
                                    : DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSError *decodeError = nil;
  id object = [NSJSONSerialization JSONObjectWithData:data
                                               options:NSJSONReadingMutableContainers |
                                                       NSJSONReadingMutableLeaves
                                                 error:&decodeError];
  if (!DSHAgentIsImmutableFoundationJSON(object) ||
      ![object isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  NSError *canonicalError = nil;
  NSData *canonical = DSHAgentCanonicalJSON(object, &canonicalError);
  if (canonical == nil || ![canonical isEqualToData:data] ||
      !DSHAgentWALStateBasicValidation(object, error)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return nil;
  }
  return [object mutableCopy];
}

- (BOOL)ensureStorageWithError:(NSError **)error {
  [self.lock lock];
  BOOL baseValid = self.rootURL != nil && self.rootURL.isFileURL &&
      self.clock != nil && self.launchId != nil;
  NSURL *parent = baseValid ? self.rootURL.URLByDeletingLastPathComponent : nil;
  BOOL parentSafe = baseValid && DSHAgentDirectoryIsSafe(parent);
  BOOL directoryReady = parentSafe && DSHAgentEnsureDirectory(self.rootURL);
  BOOL valid = baseValid && parentSafe && directoryReady;
  if (!valid) {
    [self.lock unlock];
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return NO;
  }
  NSError *loadError = nil;
  NSDictionary *state = [self loadStateLocked:&loadError];
  if (state == nil) {
    [self.lock unlock];
    if (error != nullptr) *error = loadError;
    return NO;
  }
  if ([state[@"schema_version"] isEqual:@1]) {
    NSMutableDictionary *migrated = DSHAgentWALMigrateV1ToV2(state, &loadError);
    if (migrated == nil) {
      [self.lock unlock];
      if (error != nullptr) *error = loadError;
      return NO;
    }
    if (![self writeStateLocked:migrated
                  oldGeneration:[state[@"generation"] unsignedIntegerValue]
                           error:&loadError]) {
      [self.lock unlock];
      if (error != nullptr) *error = loadError;
      return NO;
    }
    state = migrated;
  }
  self.storageReady = YES;
  [self.lock unlock];
  if (!self.ownerReconciled) {
    // Set the guard before entering reconciliation: reconciliation itself uses
    // the same WAL API and must not recursively bootstrap this instance.
    self.ownerReconciled = YES;
    if (![self reconcileOwnerLossWithError:error]) {
      self.ownerReconciled = NO;
      return NO;
    }
  }
  return YES;
}

- (BOOL)writeStateLocked:(NSDictionary *)state
                oldGeneration:(NSUInteger)oldGeneration
                         error:(NSError **)error {
  NSError *validationError = nil;
  if (!DSHAgentWALStateBasicValidation(state, &validationError)) {
    if (error != nullptr) *error = validationError;
    return NO;
  }
  NSNumber *generation = state[@"generation"];
  if (![generation isEqual:@(oldGeneration + 1)]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  NSData *data = DSHAgentCanonicalJSON(state, &validationError);
  if (data == nil || data.length > DSHAgentNativeWALMaxStoreBytes) {
    if (error != nullptr) *error = data == nil
        ? validationError
        : DSHAgentNativeStoreError(DSHAgentNativeStoreErrorCapacity);
    return NO;
  }
  if (![self faultAtStage:@"wal.before_prepare" error:error]) return NO;
  int rootDescriptor = DSHAgentOpenRootDescriptor(self.rootURL);
  if (rootDescriptor < 0) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return NO;
  }
  const char *temporaryName = [[DSHAgentWALFileName
      stringByAppendingString:DSHAgentWALTemporarySuffix] UTF8String];
  struct stat temporaryMetadata = {};
  if (fstatat(rootDescriptor, temporaryName, &temporaryMetadata,
              AT_SYMLINK_NOFOLLOW) == 0) {
    close(rootDescriptor);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCorrupt);
    return NO;
  }
  if (errno != ENOENT) {
    close(rootDescriptor);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorUnavailable);
    return NO;
  }
  int descriptor = openat(rootDescriptor, temporaryName,
                          O_WRONLY | O_CREAT | O_EXCL | O_TRUNC | O_NOFOLLOW,
                          0600);
  if (descriptor < 0) {
    close(rootDescriptor);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorPersistence);
    return NO;
  }
  BOOL written = DSHAgentWriteAll(descriptor, data);
  struct stat stagedMetadata = {};
  BOOL identity = fstat(descriptor, &stagedMetadata) == 0 &&
      DSHAgentRegularFileIdentity(stagedMetadata);
  if (fchmod(descriptor, 0600) != 0) identity = NO;
  if (close(descriptor) != 0) identity = NO;
  NSURL *temporaryURL = [self.walURL.URLByDeletingLastPathComponent
      URLByAppendingPathComponent:[self.walURL.lastPathComponent
          stringByAppendingString:DSHAgentWALTemporarySuffix]];
  NSError *attributeError = nil;
  BOOL permissions = [[NSFileManager defaultManager]
      setAttributes:@{ NSFilePosixPermissions : @0600 }
       ofItemAtPath:temporaryURL.path
              error:&attributeError];
  BOOL protection = [[NSFileManager defaultManager]
      setAttributes:@{
        NSFileProtectionKey :
            NSFileProtectionCompleteUntilFirstUserAuthentication
      }
       ofItemAtPath:temporaryURL.path
              error:&attributeError];
  BOOL excluded = [temporaryURL setResourceValue:@YES
                                           forKey:NSURLIsExcludedFromBackupKey
                                            error:&attributeError];
#if TARGET_OS_SIMULATOR || TARGET_OS_OSX
  BOOL protectedFile = identity && permissions;
  (void)protection;
  (void)excluded;
#else
  BOOL protectedFile = identity && permissions && protection && excluded;
#endif
#if TARGET_OS_OSX
#else
  if (protectedFile) {
    BOOL fileProtection = [temporaryURL
        setResourceValue:
            NSURLFileProtectionCompleteUntilFirstUserAuthentication
                  forKey:NSURLFileProtectionKey
                   error:&attributeError];
#if TARGET_OS_SIMULATOR || TARGET_OS_OSX
    (void)fileProtection;
#else
    protectedFile = fileProtection;
#endif
  }
#endif
  int verifyDescriptor = openat(rootDescriptor, temporaryName,
                                O_RDONLY | O_NOFOLLOW);
  struct stat verifiedMetadata = {};
  BOOL verified = verifyDescriptor >= 0 && fstat(verifyDescriptor, &verifiedMetadata) == 0 &&
      DSHAgentRegularFileIdentity(verifiedMetadata) &&
      verifiedMetadata.st_dev == stagedMetadata.st_dev &&
      verifiedMetadata.st_ino == stagedMetadata.st_ino && protectedFile &&
      DSHAgentVerifyFileProtectionDescriptor(verifyDescriptor, &stagedMetadata);
  if (verifyDescriptor >= 0) close(verifyDescriptor);
  if (!written || !verified) {
    unlinkat(rootDescriptor, temporaryName, 0);
    close(rootDescriptor);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorPersistence);
    return NO;
  }
  if (![self faultAtStage:@"wal.after_temp_write" error:error]) {
    close(rootDescriptor);
    return NO;
  }
  if (renameat(rootDescriptor, temporaryName, rootDescriptor,
               DSHAgentWALFileName.UTF8String) != 0) {
    close(rootDescriptor);
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorPersistence);
    return NO;
  }
  struct stat replacedMetadata = {};
  BOOL replaced = fstatat(rootDescriptor, DSHAgentWALFileName.UTF8String,
                          &replacedMetadata, AT_SYMLINK_NOFOLLOW) == 0 &&
      DSHAgentRegularFileIdentity(replacedMetadata) &&
      replacedMetadata.st_dev == stagedMetadata.st_dev &&
      replacedMetadata.st_ino == stagedMetadata.st_ino;
  if (![self faultAtStage:@"wal.after_replace" error:error]) {
    close(rootDescriptor);
    return NO;
  }
  BOOL synced = fsync(rootDescriptor) == 0;
  close(rootDescriptor);
  if (!replaced || !synced ||
      ![self faultAtStage:@"wal.after_directory_fsync" error:error]) return NO;
  return YES;
}

- (BOOL)performAtomicTransaction:(DSHAgentNativeWALMutation)mutation
                           error:(NSError **)error {
  if (mutation == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  if (![self ensureStorageWithError:error]) return NO;
  [self.lock lock];
  NSError *loadError = nil;
  NSMutableDictionary *state = [[self loadStateLocked:&loadError] mutableCopy];
  if (state == nil) {
    [self.lock unlock];
    if (error != nullptr) *error = loadError;
    return NO;
  }
  NSUInteger oldGeneration = [state[@"generation"] unsignedIntegerValue];
  NSError *mutationError = nil;
  BOOL changed = NO;
  @try {
    changed = mutation(state, &mutationError);
  } @catch (__unused NSException *exception) {
    changed = NO;
    mutationError = DSHAgentNativeStoreError(DSHAgentNativeStoreErrorPersistence);
  }
  if (!changed) {
    [self.lock unlock];
    // A nil mutation error is the explicit idempotent/no-op result. This is
    // useful for duplicate cleanup, owner probes, and exact replay checks:
    // no WAL generation is consumed and no bytes are rewritten.
    if (mutationError == nil) {
      if (error != nullptr) *error = nil;
      return YES;
    }
    if (error != nullptr) *error = mutationError;
    return NO;
  }
  NSError *normalizationError = nil;
  if (!DSHAgentWALNormalizeTransactionCandidate(state, &normalizationError)) {
    [self.lock unlock];
    if (error != nullptr) *error = normalizationError;
    return NO;
  }
  if (oldGeneration == DSHAgentMaximumSafeInteger) {
    [self.lock unlock];
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorCapacity);
    return NO;
  }
  state[@"generation"] = @(oldGeneration + 1);
  NSError *commitError = nil;
  BOOL committed = [self writeStateLocked:state
                            oldGeneration:oldGeneration
                                     error:&commitError];
  if (!committed && commitError.code == DSHAgentNativeStoreErrorCapacity &&
      DSHAgentWALCompactAcknowledgedEvidence(state)) {
    commitError = nil;
    committed = [self writeStateLocked:state
                          oldGeneration:oldGeneration
                                   error:&commitError];
  }
  [self.lock unlock];
  if (!committed && error != nullptr) *error = commitError;
  return committed;
}

- (NSDictionary *)snapshotWithError:(NSError **)error {
  if (![self ensureStorageWithError:error]) return nil;
  [self.lock lock];
  NSError *loadError = nil;
  NSDictionary *state = [self loadStateLocked:&loadError];
  id copy = state == nil ? nil : DSHAgentImmutableJSONCopy(state, &loadError);
  [self.lock unlock];
  if (copy == nil && error != nullptr) *error = loadError;
  return [copy isKindOfClass:NSDictionary.class] ? copy : nil;
}

- (NSString *)dispatchStateForKind:(NSString *)kind
                            locator:(NSDictionary *)locator
                              error:(NSError **)error {
  if ((![kind isEqualToString:@"round"] &&
       ![kind isEqualToString:@"execution"]) ||
      ![locator isKindOfClass:NSDictionary.class]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *state = [self snapshotWithError:error];
  if (state == nil) return nil;
  NSString *dispatchState = DSHAgentFindDispatchState(state[@"dispatch"], kind,
                                                      locator);
  if (dispatchState == nil && error != nullptr) *error = nil;
  return dispatchState;
}

- (BOOL)registerNativeTaskId:(NSString *)nativeTaskId error:(NSError **)error {
  if (!DSHAgentCanonicalUUID(nativeTaskId)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  [self.lock lock];
  [self.liveTaskIds addObject:nativeTaskId];
  [self.lock unlock];
  return YES;
}

- (BOOL)unregisterNativeTaskId:(NSString *)nativeTaskId error:(NSError **)error {
  if (!DSHAgentCanonicalUUID(nativeTaskId)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  [self.lock lock];
  [self.liveTaskIds removeObject:nativeTaskId];
  [self.lock unlock];
  return YES;
}

- (BOOL)isNativeTaskAlive:(NSString *)nativeTaskId launchId:(NSString *)launchId {
  if (!DSHAgentCanonicalUUID(nativeTaskId) ||
      !DSHAgentCanonicalUUID(launchId) || ![launchId isEqual:self.launchId]) {
    return NO;
  }
  [self.lock lock];
  BOOL alive = [self.liveTaskIds containsObject:nativeTaskId];
  [self.lock unlock];
  return alive;
}

- (BOOL)reconcileOwnerLossWithError:(NSError **)error {
  if (![self ensureStorageWithError:error]) return NO;
  __weak DSHAgentNativeWAL *weakSelf = self;
  BOOL result = [self performAtomicTransaction:^BOOL(NSMutableDictionary *state,
                                                    NSError **mutationError) {
    DSHAgentNativeWAL *strongSelf = weakSelf;
    BOOL changed = NO;
    NSMutableArray *rounds = [state[@"rounds"] mutableCopy];
    NSArray *dispatchRows = state[@"dispatch"];
    for (NSMutableDictionary *row in rounds) {
      if (![row isKindOfClass:NSMutableDictionary.class]) continue;
      NSString *status = row[@"state"];
      NSDictionary *owner = row[@"owner"];
      if (![status isEqualToString:@"in_flight"] &&
          ![status isEqualToString:@"cancel_requested"]) continue;
      if (owner == nil || (id)owner == NSNull.null) continue;
      NSString *launchId = owner[@"launch_id"];
      NSString *nativeTaskId = owner[@"native_task_id"];
      if ([strongSelf isNativeTaskAlive:nativeTaskId launchId:launchId]) continue;
      NSDictionary *before = row[@"transcript_before"];
      BOOL transcriptBound = NO;
      for (NSDictionary *transcript in state[@"transcripts"]) {
        if ([transcript[@"transcript_ref"] isEqual:before[@"transcript_ref"]] &&
            [transcript[@"attempt_id"] isEqual:row[@"locator"][@"attempt_id"]] &&
            [transcript[@"root_fingerprint_sha256"]
                isEqual:row[@"root_fingerprint_sha256"]] &&
            [transcript[@"generation"] isEqual:before[@"generation"]] &&
            [transcript[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] &&
            [transcript[@"transcript_bytes"] isEqual:before[@"transcript_bytes"]]) {
          transcriptBound = YES;
          break;
        }
      }
      if (!transcriptBound) {
        if (mutationError != nullptr) *mutationError = DSHAgentNativeStoreError(
            DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      NSString *dispatchState = DSHAgentFindDispatchState(dispatchRows,
                                                            @"round",
                                                            row[@"locator"]);
      BOOL notDispatched = [dispatchState isEqualToString:@"not_dispatched"];
      row[@"state"] = notDispatched ? @"failed_retryable" : @"ambiguous";
      row[@"owner"] = NSNull.null;
      row[@"failure_code"] = notDispatched ? @"E_AGENT_PERSISTENCE"
                                             : @"E_AGENT_ROUND_AMBIGUOUS";
      row[@"completion_receipt"] = NSNull.null;
      row[@"terminal_kind"] = NSNull.null;
      NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
      if (revision == DSHAgentMaximumSafeInteger) {
        if (mutationError != nullptr) *mutationError = DSHAgentNativeStoreError(
            DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"row_revision"] = @(revision + 1);
      row[@"updated_at"] = [strongSelf currentTimestamp];
      changed = YES;
    }
    state[@"rounds"] = rounds;
    NSMutableArray *ledger = [state[@"ledger"] mutableCopy];
    for (NSMutableDictionary *row in ledger) {
      if (![row isKindOfClass:NSMutableDictionary.class]) continue;
      NSString *status = row[@"state"];
      NSDictionary *owner = row[@"owner"];
      if (![status isEqualToString:@"running"] &&
          ![status isEqualToString:@"cancel_requested"]) continue;
      if (owner == nil || (id)owner == NSNull.null) continue;
      if ([strongSelf isNativeTaskAlive:owner[@"native_task_id"]
                                 launchId:owner[@"launch_id"]]) continue;
      NSDictionary *ledgerBefore = row[@"transcript_before"];
      BOOL ledgerTranscriptBound = NO;
      for (NSDictionary *transcript in state[@"transcripts"]) {
        if ([transcript[@"transcript_ref"] isEqual:ledgerBefore[@"transcript_ref"]] &&
            [transcript[@"attempt_id"] isEqual:row[@"locator"][@"attempt_id"]] &&
            [transcript[@"root_fingerprint_sha256"]
                isEqual:row[@"root_fingerprint_sha256"]] &&
            [transcript[@"generation"] isEqual:ledgerBefore[@"generation"]] &&
            [transcript[@"transcript_sha256"] isEqual:ledgerBefore[@"transcript_sha256"]] &&
            [transcript[@"transcript_bytes"] isEqual:ledgerBefore[@"transcript_bytes"]]) {
          ledgerTranscriptBound = YES;
          break;
        }
      }
      if (!ledgerTranscriptBound) {
        if (mutationError != nullptr) *mutationError = DSHAgentNativeStoreError(
            DSHAgentNativeStoreErrorCorrupt);
        return NO;
      }
      NSString *dispatchState = DSHAgentFindDispatchState(dispatchRows,
                                                            @"execution",
                                                            row[@"locator"]);
      BOOL notDispatched = [dispatchState isEqualToString:@"not_dispatched"];
      row[@"state"] = notDispatched ? @"unknown" : @"ambiguous";
      row[@"owner"] = NSNull.null;
      row[@"settled_facts"] = NSNull.null;
      if (notDispatched) {
        row[@"transcript_after"] = NSNull.null;
        row[@"receipt"] = NSNull.null;
      } else {
        NSDictionary *before = row[@"transcript_before"];
        NSMutableDictionary *transcript = nil;
        NSUInteger transcriptIndex = NSNotFound;
        for (NSUInteger index = 0; index < [state[@"transcripts"] count]; index += 1) {
          NSMutableDictionary *candidate = [state[@"transcripts"][index] mutableCopy];
          if ([candidate[@"transcript_ref"] isEqual:before[@"transcript_ref"]]) {
            transcript = candidate;
            transcriptIndex = index;
            break;
          }
        }
        if (transcript == nil ||
            ![transcript[@"generation"] isEqual:before[@"generation"]] ||
            ![transcript[@"transcript_sha256"] isEqual:before[@"transcript_sha256"]] ||
            ![transcript[@"state"] isEqualToString:@"open"]) {
          // Without a matching protected transcript, native cannot create the
          // required ambiguous feedback; retain a conservative unknown row.
          row[@"state"] = @"unknown";
          row[@"transcript_after"] = NSNull.null;
          row[@"receipt"] = NSNull.null;
        } else {
          NSString *callId = row[@"locator"][@"call_id"];
          NSString *name = row[@"name"];
          NSDictionary *feedback = @{
            @"schema_version" : @1,
            @"name" : name,
            @"outcome" : @"ambiguous",
            @"payload" : @{
              @"schema_version" : @1,
              @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
            },
          };
          NSError *feedbackError = nil;
          NSData *feedbackBytes = DSHAgentCanonicalJSON(feedback, &feedbackError);
          if (feedbackBytes == nil) {
            row[@"state"] = @"unknown";
            row[@"transcript_after"] = NSNull.null;
            row[@"receipt"] = NSNull.null;
          } else {
            NSMutableArray *messages = [transcript[@"messages"] mutableCopy];
            [messages addObject:@{
              @"schema_version" : @1,
              @"role" : @"tool",
              @"round_index" : row[@"locator"][@"round_index"],
              @"call_id" : callId,
              @"content" : [[NSString alloc] initWithData:feedbackBytes
                                                    encoding:NSUTF8StringEncoding],
              @"truncated" : @NO,
            }];
            NSUInteger generation = [transcript[@"generation"] unsignedIntegerValue];
            if (generation == DSHAgentMaximumSafeInteger) {
              row[@"state"] = @"unknown";
              row[@"transcript_after"] = NSNull.null;
              row[@"receipt"] = NSNull.null;
            } else {
              generation += 1;
              NSDictionary *digestInput = @{
                @"schema_version" : @1,
                @"transcript_ref" : transcript[@"transcript_ref"],
                @"attempt_id" : transcript[@"attempt_id"],
                @"root_fingerprint_sha256" : transcript[@"root_fingerprint_sha256"],
                @"generation" : @(generation),
                @"messages" : messages,
              };
              NSString *transcriptDigest = DSHAgentHJ(@"agent-transcript",
                                                       digestInput,
                                                       &feedbackError);
              if (transcriptDigest == nil) {
                row[@"state"] = @"unknown";
                row[@"transcript_after"] = NSNull.null;
                row[@"receipt"] = NSNull.null;
              } else {
                transcript[@"messages"] = messages;
                transcript[@"generation"] = @(generation);
                transcript[@"transcript_sha256"] = transcriptDigest;
                NSData *digestBytes = DSHAgentCanonicalJSON(digestInput, &feedbackError);
                NSString *resultDigest = DSHAgentHB(@"tool-result", feedbackBytes,
                                                    &feedbackError);
                if (digestBytes == nil || resultDigest == nil ||
                    digestBytes.length > DSHAgentNativeWALMaxTranscriptBytes) {
                  row[@"state"] = @"unknown";
                  row[@"transcript_after"] = NSNull.null;
                  row[@"receipt"] = NSNull.null;
                  goto ambiguous_feedback_done;
                }
                transcript[@"transcript_bytes"] = @(digestBytes.length);
                transcript[@"updated_at"] = [strongSelf currentTimestamp];
                state[@"transcripts"][transcriptIndex] = transcript;
                row[@"transcript_after"] = @{
                  @"schema_version" : @1,
                  @"transcript_ref" : transcript[@"transcript_ref"],
                  @"generation" : @(generation),
                  @"transcript_sha256" : transcriptDigest,
                  @"transcript_bytes" : @(digestBytes.length),
                };
                row[@"receipt"] = @{
                  @"schema_version" : @1,
                  @"call_id" : callId,
                  @"name" : name,
                  @"arguments_sha256" : row[@"arguments_sha256"],
                  @"result_sha256" : resultDigest,
                  @"result_bytes" : @(feedbackBytes.length),
                  @"truncated" : @NO,
                  @"duration_ms" : @0,
                  @"outcome" : @"ambiguous",
                  @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
                  @"approval_reference" : NSNull.null,
                };
              }
            }
          }
        }
      }
ambiguous_feedback_done:
      NSUInteger revision = [row[@"row_revision"] unsignedIntegerValue];
      if (revision == DSHAgentMaximumSafeInteger) {
        if (mutationError != nullptr) *mutationError = DSHAgentNativeStoreError(
            DSHAgentNativeStoreErrorCapacity);
        return NO;
      }
      row[@"row_revision"] = @(revision + 1);
      row[@"updated_at"] = [strongSelf currentTimestamp];
      changed = YES;
    }
    state[@"ledger"] = ledger;
    return changed;
  } error:error];
  if (result) self.ownerReconciled = YES;
  // A failed reconciliation must fail bootstrap.  A readable old snapshot
  // does not prove that the owner-loss transition reached durable storage.
  return result;
}

- (NSString *)currentTimestamp {
  NSDate *date = self.clock != nil ? self.clock() : NSDate.date;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  return [formatter stringFromDate:date] ?: @"1970-01-01T00:00:00.000Z";
}

- (NSString *)currentTimestampAddingInterval:(NSTimeInterval)interval {
  NSDate *date = self.clock != nil ? self.clock() : NSDate.date;
  date = [date dateByAddingTimeInterval:interval];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  return [formatter stringFromDate:date] ?: @"1970-01-01T00:00:00.000Z";
}

- (NSDictionary *)ambiguousReceiptForLedgerRow:(NSDictionary *)row {
  NSString *name = [row[@"name"] isKindOfClass:NSString.class]
      ? row[@"name"] : @"unknown";
  NSString *callId = [row[@"locator"] isKindOfClass:NSDictionary.class]
      ? row[@"locator"][@"call_id"] : @"unknown";
  NSString *arguments = [row[@"arguments_sha256"] isKindOfClass:NSString.class]
      ? row[@"arguments_sha256"] : @"";
  NSDictionary *feedback = @{
    @"schema_version" : @1,
    @"name" : name,
    @"outcome" : @"ambiguous",
    @"payload" : @{
      @"schema_version" : @1,
      @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
    },
  };
  NSError *digestError = nil;
  NSData *feedbackData = DSHAgentCanonicalJSON(feedback, &digestError);
  NSString *resultDigest = DSHAgentHB(@"tool-result", feedbackData ?: NSData.data,
                                      &digestError) ?:
      @"0000000000000000000000000000000000000000000000000000000000000000";
  return @{
    @"schema_version" : @1,
    @"call_id" : callId,
    @"name" : name,
    @"arguments_sha256" : arguments,
    @"result_sha256" : resultDigest,
    @"result_bytes" : @(feedbackData.length),
    @"truncated" : @NO,
    @"duration_ms" : @0,
    @"outcome" : @"ambiguous",
    @"failure_code" : @"E_AGENT_EXECUTION_AMBIGUOUS",
    @"approval_reference" : NSNull.null,
  };
}

@end
