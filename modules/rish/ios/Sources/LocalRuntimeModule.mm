#import "DSHCompletionV2.h"
#import "LocalAttachmentStore.h"
#import "ModelTransitionProof.h"

#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <Security/Security.h>
#import <TargetConditionals.h>
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include "rish.h"

static NSString *const DSHCredentialService = @"dev.zseven.dsh.mobile.credentials";
static NSString *const DSHCredentialAccount = @"DEEPSEEK_API_KEY";
static NSString *const DSHProofFilename = @"runtime-proof.json";
static NSString *const DSHSessionFilename = @"sessions.json";
static NSString *const DSHRuntimeIdFilename = @"runtime-id.txt";
static NSUInteger const DSHMaximumHistoryCount = 200;
static NSUInteger const DSHMaximumMessageBytes = 256 * 1024;
static NSUInteger const DSHMaximumHistoryBytes = 2 * 1024 * 1024;
static NSUInteger const DSHMaximumResponseBytes = 8 * 1024 * 1024;
static NSUInteger const DSHMaximumSessionBytes = 16 * 1024 * 1024;
static NSUInteger const DSHMaximumPersistedMessageCount = 10000;
static NSUInteger const DSHMaximumPersistedMessageBytes = 1024 * 1024;
static NSUInteger const DSHMaximumProofBytes = 1024 * 1024;
static NSUInteger const DSHMaximumAttachmentsPerMessage = 6;
static NSUInteger const DSHMaximumAttachmentCount = 24;
static NSUInteger const DSHMaximumAttachmentBytes = 24 * 1024 * 1024;
static NSUInteger const DSHMaximumTextAttachmentBytes = 1024 * 1024;
static NSUInteger const DSHMaximumPDFTextBytes = 512 * 1024;
static NSUInteger const DSHMaximumExpandedHistoryBytes = 4 * 1024 * 1024;
static NSUInteger const DSHMaximumPDFPages = 512;
static NSUInteger const DSHMaximumRequestBodyBytes = 40 * 1024 * 1024;

static NSString *DSHNow(void) {
  static NSISO8601DateFormatter *formatter = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime
      | NSISO8601DateFormatWithFractionalSeconds;
  });
  return [formatter stringFromDate:NSDate.date];
}

static NSString *DSHSha256Hex(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

static NSDictionary *DSHDictionary(id value) {
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSArray *DSHArray(id value) {
  return [value isKindOfClass:NSArray.class] ? value : nil;
}

static NSString *DSHString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static BOOL DSHProofToolNameIsSafe(NSString *value) {
  if (value.length == 0 || value.length > 64) return NO;
  NSCharacterSet *invalid =
      [[NSCharacterSet characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
          invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHProofDigestIsSafe(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSString *hex = value;
  if ([value hasPrefix:@"sha1:"]) {
    if (value.length != 13) return NO;
    hex = [value substringFromIndex:5];
  } else if (value.length != 64) {
    return NO;
  }
  NSCharacterSet *nonHex =
      [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"]
          invertedSet];
  return [hex rangeOfCharacterFromSet:nonHex].location == NSNotFound;
}

static BOOL DSHCredentialPromptUsesChinese(id localeValue) {
  NSString *locale = DSHString(localeValue);
  return [locale isEqualToString:@"zh-CN"];
}

static NSError *DSHLocalRuntimeError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"LocalRuntime"
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static BOOL DSHIsSupportedModel(NSString *model) {
  return [model isEqualToString:@"deepseek-v4-flash"]
    || [model isEqualToString:@"deepseek-v4-pro"]
    || [model isEqualToString:@"deepseek-v4-flash-vision-exp"];
}

static BOOL DSHIsThinkingMode(NSString *mode) {
  return [mode isEqualToString:@"off"]
    || [mode isEqualToString:@"high"]
    || [mode isEqualToString:@"max"];
}

static BOOL DSHIsValidRequestId(NSString *requestId) {
  if (requestId.length != 36) return NO;
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:requestId];
  return uuid != nil && [uuid.UUIDString.lowercaseString isEqualToString:requestId];
}

static NSString *DSHJSONSha256(id object, NSError **error) {
  if (![NSJSONSerialization isValidJSONObject:object]) {
    if (error != nil) *error = DSHLocalRuntimeError(1010, @"Value is not valid JSON");
    return nil;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                 options:NSJSONWritingSortedKeys
                                                   error:error];
  return data == nil ? nil : DSHSha256Hex(data);
}

static NSString *DSHTextSha256(NSString *text) {
  NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
  return data == nil ? nil : DSHSha256Hex(data);
}

static NSString *DSHCanonicalAttachmentID(id value) {
  NSString *candidate = DSHString(value);
  if (candidate.length != 36 || ![candidate isEqualToString:candidate.lowercaseString]) {
    return nil;
  }
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:candidate];
  NSString *canonical = uuid.UUIDString.lowercaseString;
  return [canonical isEqualToString:candidate] ? canonical : nil;
}

static BOOL DSHExactUnsignedNumber(id value, uint64_t *output) {
  if (![value isKindOfClass:NSNumber.class]
    || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  NSNumber *number = value;
  double floating = number.doubleValue;
  uint64_t integer = number.unsignedLongLongValue;
  if (!isfinite(floating) || floating < 0 || floating != (double)integer) return NO;
  if (output != nil) *output = integer;
  return YES;
}

static NSDictionary<NSString *, id> *DSHResolveAttachmentReference(
    id value, NSData **payloadData, NSDictionary **manifestOut, NSError **error) {
  NSDictionary *reference = DSHDictionary(value);
  static NSSet<NSString *> *allowedKeys = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedKeys = [NSSet setWithArray:@[
      @"schema_version", @"id", @"kind", @"name", @"mime_type", @"size",
    ]];
  });
  uint64_t schemaVersion = 0;
  uint64_t referencedSize = 0;
  if (reference == nil
    || ![[NSSet setWithArray:reference.allKeys] isEqualToSet:allowedKeys]
    || !DSHExactUnsignedNumber(reference[@"schema_version"], &schemaVersion)
    || schemaVersion != 1
    || !DSHExactUnsignedNumber(reference[@"size"], &referencedSize)
    || referencedSize == 0) {
    if (error != nil) *error = DSHLocalRuntimeError(1020, @"Attachment reference is invalid");
    return nil;
  }
  NSString *attachmentID = DSHCanonicalAttachmentID(reference[@"id"]);
  if (attachmentID == nil) {
    if (error != nil) *error = DSHLocalRuntimeError(1021, @"Attachment identifier is invalid");
    return nil;
  }
  NSError *storeError = nil;
  NSDictionary *manifest = nil;
  NSData *payload = RishLocalAttachmentReadPayload(attachmentID, &manifest, &storeError);
  if (payload == nil || manifest == nil) {
    if (error != nil) {
      *error = DSHLocalRuntimeError(1022,
        storeError.localizedDescription ?: @"Attachment is unavailable");
    }
    return nil;
  }
  NSString *kind = DSHString(manifest[@"kind"]);
  NSString *name = DSHString(manifest[@"name"]);
  NSString *mimeType = DSHString(manifest[@"mime_type"]);
  NSNumber *size = [manifest[@"size"] isKindOfClass:NSNumber.class]
    ? manifest[@"size"] : nil;
  BOOL matchesManifest = [DSHString(reference[@"id"]) isEqualToString:attachmentID]
    && [DSHString(reference[@"kind"]) isEqualToString:kind]
    && [DSHString(reference[@"name"]) isEqualToString:name]
    && [DSHString(reference[@"mime_type"]) isEqualToString:mimeType]
    && referencedSize == size.unsignedLongLongValue;
  if (!matchesManifest) {
    if (error != nil) {
      *error = DSHLocalRuntimeError(1023, @"Attachment reference does not match native storage");
    }
    return nil;
  }
  if (payloadData != nil) *payloadData = payload;
  if (manifestOut != nil) *manifestOut = manifest;
  return @{
    @"schema_version": @1,
    @"id": attachmentID,
    @"kind": kind,
    @"name": name,
    @"mime_type": mimeType,
    @"size": size,
  };
}

static NSArray<NSDictionary *> *DSHProjectedAttachmentReferences(
    id value, BOOL assistant, NSError **error) {
  if (value == nil || value == NSNull.null) return @[];
  NSArray *entries = DSHArray(value);
  if (entries == nil || entries.count > DSHMaximumAttachmentsPerMessage
    || (assistant && entries.count > 0)) {
    if (error != nil) *error = DSHLocalRuntimeError(1024, @"Message attachments are invalid");
    return nil;
  }
  NSMutableSet<NSString *> *identifiers = [NSMutableSet setWithCapacity:entries.count];
  NSMutableArray<NSDictionary *> *references = [NSMutableArray arrayWithCapacity:entries.count];
  uint64_t totalBytes = 0;
  for (id entry in entries) {
    NSDictionary *reference = DSHResolveAttachmentReference(entry, nil, nil, error);
    NSString *identifier = DSHString(reference[@"id"]);
    uint64_t size = [reference[@"size"] unsignedLongLongValue];
    if (reference == nil || [identifiers containsObject:identifier]
      || size > DSHMaximumAttachmentBytes - totalBytes) {
      if (error != nil && *error == nil) {
        *error = DSHLocalRuntimeError(1025, @"Message attachments exceed safe limits");
      }
      return nil;
    }
    [identifiers addObject:identifier];
    [references addObject:reference];
    totalBytes += size;
  }
  return references;
}

static NSArray<NSDictionary *> *DSHProjectPersistedMessages(id value, NSError **error) {
  NSArray *entries = DSHArray(value);
  if (entries == nil || entries.count > DSHMaximumPersistedMessageCount) {
    if (error != nil) *error = DSHLocalRuntimeError(1011, @"Session messages are invalid");
    return nil;
  }
  NSMutableArray<NSDictionary *> *projected = [NSMutableArray arrayWithCapacity:entries.count];
  for (id entryValue in entries) {
    NSDictionary *entry = DSHDictionary(entryValue);
    NSString *identifier = DSHString(entry[@"id"]);
    NSString *role = DSHString(entry[@"role"]);
    NSString *text = DSHString(entry[@"text"]) ?: DSHString(entry[@"content"]);
    BOOL assistant = [role isEqualToString:@"assistant"];
    NSArray<NSDictionary *> *attachments = DSHProjectedAttachmentReferences(
      entry[@"attachments"], assistant, error);
    BOOL validIdentifier = identifier.length > 0 && identifier.length <= 256;
    BOOL validRole = [role isEqualToString:@"user"] || [role isEqualToString:@"assistant"];
    NSUInteger textBytes = [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    BOOL hasText = [[text stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]] length] > 0;
    BOOL validContent = text != nil && textBytes <= DSHMaximumPersistedMessageBytes
      && (hasText || (!assistant && attachments.count > 0));
    if (entry == nil || !validIdentifier || !validRole || attachments == nil
      || !validContent) {
      if (error != nil) *error = DSHLocalRuntimeError(1012, @"Session contains an invalid message");
      return nil;
    }
    NSMutableDictionary *message = [@{@"role": role, @"content": text} mutableCopy];
    if (attachments.count > 0) message[@"attachments"] = attachments;
    [projected addObject:message];
  }
  return projected;
}

static NSString *DSHReadUTF8Attachment(NSData *data, NSError **error) {
  if (data == nil || data.length == 0 || data.length > DSHMaximumTextAttachmentBytes) {
    if (error != nil && *error == nil) {
      *error = DSHLocalRuntimeError(1026, @"Text attachment exceeds the model input limit");
    }
    return nil;
  }
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (text == nil) {
    if (error != nil) *error = DSHLocalRuntimeError(1027, @"Text attachment is not valid UTF-8");
    return nil;
  }
  return text;
}

static NSString *DSHExtractPDFAttachment(NSData *payload, NSError **error) {
  PDFDocument *document = [[PDFDocument alloc] initWithData:payload];
  if (document == nil || document.isLocked || document.pageCount == 0) {
    if (error != nil) *error = DSHLocalRuntimeError(1028, @"PDF attachment cannot be read");
    return nil;
  }
  if (document.pageCount > DSHMaximumPDFPages) {
    if (error != nil) *error = DSHLocalRuntimeError(1029, @"PDF attachment has too many pages");
    return nil;
  }
  NSMutableString *projection = [NSMutableString string];
  NSUInteger projectedBytes = 0;
  for (NSUInteger index = 0; index < document.pageCount; index += 1) {
    NSString *pageText = [document pageAtIndex:index].string;
    if (pageText.length == 0) continue;
    NSString *section = [NSString stringWithFormat:@"\n[PDF page %lu]\n%@",
      (unsigned long)(index + 1), pageText];
    NSUInteger sectionBytes = [section lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if (sectionBytes == 0 || sectionBytes > DSHMaximumPDFTextBytes - projectedBytes) {
      if (error != nil) {
        *error = DSHLocalRuntimeError(1030, @"Extracted PDF text exceeds the model input limit");
      }
      return nil;
    }
    [projection appendString:section];
    projectedBytes += sectionBytes;
  }
  NSString *trimmed = [projection stringByTrimmingCharactersInSet:
    NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (trimmed.length == 0) {
    if (error != nil) {
      *error = DSHLocalRuntimeError(1031,
        @"PDF contains no extractable text; scanned PDFs are not supported yet");
    }
    return nil;
  }
  return trimmed;
}

static NSString *DSHDelimitedAttachment(NSDictionary *reference,
                                         NSString *projection,
                                         NSString *projectionKind) {
  NSString *identifier = DSHString(reference[@"id"]);
  NSString *name = DSHString(reference[@"name"]);
  NSString *mimeType = DSHString(reference[@"mime_type"]);
  return [NSString stringWithFormat:
    @"--- BEGIN %@ ATTACHMENT %@ (%@; %@) ---\n%@\n--- END ATTACHMENT %@ ---",
    projectionKind, identifier, name, mimeType, projection, identifier];
}

static BOOL DSHMessagesMatchModelResponse(NSArray<NSDictionary *> *messages,
                                          NSDictionary *modelResponse) {
  NSString *requestId = DSHString(modelResponse[@"request_id"]);
  NSString *expectedHistoryDigest = DSHString(modelResponse[@"request_history_sha256"]);
  NSString *expectedAssistantDigest = DSHString(modelResponse[@"assistant_text_sha256"]);
  NSUInteger requestCount = [modelResponse[@"request_message_count"] unsignedIntegerValue];
  if (!DSHIsValidRequestId(requestId)
    || expectedHistoryDigest.length != CC_SHA256_DIGEST_LENGTH * 2
    || expectedAssistantDigest.length != CC_SHA256_DIGEST_LENGTH * 2
    || requestCount == 0
    || requestCount + 1 != messages.count) {
    return NO;
  }
  NSDictionary *assistant = messages.lastObject;
  if (![DSHString(assistant[@"role"]) isEqualToString:@"assistant"]) return NO;
  NSArray *history = [messages subarrayWithRange:NSMakeRange(0, requestCount)];
  NSString *historyDigest = DSHJSONSha256(history, nil);
  NSString *assistantDigest = DSHTextSha256(DSHString(assistant[@"content"]));
  return [historyDigest isEqualToString:expectedHistoryDigest]
    && [assistantDigest isEqualToString:expectedAssistantDigest];
}

static BOOL DSHReasoningMatchesModelResponse(id rawMessages,
                                             NSDictionary *modelResponse) {
  NSArray *messages = DSHArray(rawMessages);
  NSDictionary *last = messages.count == 0 ? nil : DSHDictionary(messages.lastObject);
  NSDictionary *metadata = DSHDictionary(last[@"metadata"]);
  NSString *reasoning = DSHString(metadata[@"reasoning"]) ?: @"";
  NSString *expected = DSHString(modelResponse[@"reasoning_text_sha256"]);
  if ([expected isEqualToString:@"none"]) return reasoning.length == 0;
  return expected.length == CC_SHA256_DIGEST_LENGTH * 2
    && [DSHTextSha256(reasoning) isEqualToString:expected];
}

static NSData *DSHDataFromByteArray(NSArray *values) {
  NSMutableData *data = [NSMutableData dataWithCapacity:values.count];
  for (id value in values) {
    if (![value isKindOfClass:NSNumber.class]) return nil;
    NSInteger number = [value integerValue];
    if (number < 0 || number > UINT8_MAX) return nil;
    uint8_t byte = (uint8_t)number;
    [data appendBytes:&byte length:1];
  }
  return data;
}

static NSString *DSHLaunchInstanceId(void) {
  static NSString *value = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    value = NSUUID.UUID.UUIDString.lowercaseString;
  });
  return value;
}

static BOOL DSHCanConnectToMacProxy(void) {
  int descriptor = socket(AF_INET, SOCK_STREAM, 0);
  if (descriptor < 0) return NO;
  int flags = fcntl(descriptor, F_GETFL, 0);
  if (flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) < 0) {
    close(descriptor);
    return NO;
  }
  struct sockaddr_in address = {};
  address.sin_family = AF_INET;
  address.sin_port = htons(3180);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  int result = connect(descriptor, reinterpret_cast<struct sockaddr *>(&address), sizeof(address));
  if (result == 0) {
    close(descriptor);
    return YES;
  }
  if (errno != EINPROGRESS) {
    close(descriptor);
    return NO;
  }
  fd_set writable;
  FD_ZERO(&writable);
  FD_SET(descriptor, &writable);
  struct timeval timeout = {.tv_sec = 0, .tv_usec = 300000};
  result = select(descriptor + 1, nullptr, &writable, nullptr, &timeout);
  int socketError = 0;
  socklen_t errorLength = sizeof(socketError);
  BOOL connected = result > 0
    && getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socketError, &errorLength) == 0
    && socketError == 0;
  close(descriptor);
  return connected;
}

@interface LocalRuntimeModule : NSObject <RCTBridgeModule>
@property(nonatomic, strong) dispatch_queue_t stateQueue;
@property(nonatomic, strong) NSURLSession *modelSession;
@property(nonatomic, strong) NSURLSessionDataTask *activeCompletionTask;
@property(nonatomic, copy) NSString *activeCompletionRequestId;
@property(nonatomic) NSUInteger activeCompletionGeneration;
@property(nonatomic) NSUInteger completionGeneration;
@property(nonatomic) NSUInteger credentialGeneration;
@end

@implementation LocalRuntimeModule

RCT_EXPORT_MODULE(LocalRuntime)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _stateQueue = dispatch_queue_create("dev.zseven.dsh.mobile.local-runtime", DISPATCH_QUEUE_SERIAL);
    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.URLCache = nil;
    configuration.HTTPCookieStorage = nil;
    configuration.HTTPShouldSetCookies = NO;
    configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    _modelSession = [NSURLSession sessionWithConfiguration:configuration];
  }
  return self;
}

- (NSArray<NSString *> *)documentDirectories {
  return NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
}

- (NSURL *)applicationSupportURL:(NSError **)error {
  NSURL *url = [[NSFileManager defaultManager] URLForDirectory:NSApplicationSupportDirectory
                                                      inDomain:NSUserDomainMask
                                             appropriateForURL:nil
                                                        create:YES
                                                         error:error];
  if (url != nil) {
    [[NSFileManager defaultManager] setAttributes:@{NSFilePosixPermissions: @0700}
                                     ofItemAtPath:url.path
                                            error:nil];
  }
  return url;
}

- (NSString *)runtimeId:(NSError **)error {
  NSURL *support = [self applicationSupportURL:error];
  if (support == nil) return nil;
  NSURL *file = [support URLByAppendingPathComponent:DSHRuntimeIdFilename];
  NSString *existing = [NSString stringWithContentsOfURL:file
                                                encoding:NSUTF8StringEncoding
                                                   error:nil];
  existing = [existing stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (existing.length > 0) return existing;

  NSString *created = NSUUID.UUID.UUIDString.lowercaseString;
  if (![created writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:error]) return nil;
  [[NSFileManager defaultManager] setAttributes:@{NSFilePosixPermissions: @0600}
                                   ofItemAtPath:file.path
                                          error:nil];
  return created;
}

- (NSMutableDictionary *)keychainQuery {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: DSHCredentialService,
    (__bridge id)kSecAttrAccount: DSHCredentialAccount,
    (__bridge id)kSecAttrSynchronizable: @NO,
  } mutableCopy];
}

- (OSStatus)credentialLookupStatus {
  NSMutableDictionary *query = [self keychainQuery];
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  return SecItemCopyMatching((__bridge CFDictionaryRef)query, nil);
}

- (NSString *)credential {
  NSMutableDictionary *query = [self keychainQuery];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = nil;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status != errSecSuccess || result == nil) return nil;
  NSData *data = CFBridgingRelease(result);
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

- (void)credentialDidChange {
  NSURLSessionDataTask *task = nil;
  @synchronized (self) {
    self.credentialGeneration += 1;
    task = self.activeCompletionTask;
    self.activeCompletionTask = nil;
    self.activeCompletionRequestId = nil;
    self.activeCompletionGeneration = 0;
  }
  [task cancel];
}

- (BOOL)storeCredential:(NSString *)credential error:(NSError **)error {
  NSString *trimmed = [credential stringByTrimmingCharactersInSet:
    [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  BOOL containsWhitespace = [trimmed rangeOfCharacterFromSet:
    [NSCharacterSet whitespaceAndNewlineCharacterSet]].location != NSNotFound;
  if (trimmed.length < 16 || trimmed.length > 512 || containsWhitespace) {
    if (error != nil) {
      *error = DSHLocalRuntimeError(1004, @"DeepSeek credential format is invalid");
    }
    return NO;
  }

  NSData *data = [trimmed dataUsingEncoding:NSUTF8StringEncoding];
  NSMutableDictionary *query = [self keychainQuery];
  OSStatus status = SecItemUpdate(
    (__bridge CFDictionaryRef)query,
    (__bridge CFDictionaryRef)@{
      (__bridge id)kSecValueData: data,
      (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    }
  );
  if (status == errSecItemNotFound) {
    query[(__bridge id)kSecValueData] = data;
    query[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
    query[(__bridge id)kSecAttrSynchronizable] = @NO;
    status = SecItemAdd((__bridge CFDictionaryRef)query, nil);
  }
  if (status == errSecSuccess) {
    [self credentialDidChange];
    return YES;
  }
  if (error != nil) {
    *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
  }
  return NO;
}

- (BOOL)deleteCredential:(NSError **)error {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)[self keychainQuery]);
  if (status == errSecSuccess || status == errSecItemNotFound) {
    [self credentialDidChange];
    return YES;
  }
  if (error != nil) {
    *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
  }
  return NO;
}

- (NSArray<NSDictionary *> *)validatedMessagesFromHistory:(id)history
                                                     model:(NSString *)model
                                             proofMessages:(NSArray<NSDictionary *> **)proofMessages
                                                     error:(NSError **)error {
  if (![history isKindOfClass:NSArray.class]) {
    if (error != nil) *error = DSHLocalRuntimeError(1005, @"Conversation history must be an array");
    return nil;
  }
  NSArray *entries = (NSArray *)history;
  if (entries.count == 0 || entries.count > DSHMaximumHistoryCount) {
    if (error != nil) *error = DSHLocalRuntimeError(1006, @"Conversation history has an invalid message count");
    return nil;
  }

  NSUInteger totalBytes = 0;
  NSUInteger expandedBytes = 0;
  NSUInteger attachmentCount = 0;
  uint64_t attachmentBytes = 0;
  NSMutableArray<NSDictionary *> *messages = [NSMutableArray arrayWithCapacity:entries.count];
  NSMutableArray<NSDictionary *> *projectedMessages = [NSMutableArray arrayWithCapacity:entries.count];
  for (id entryValue in entries) {
    NSDictionary *entry = DSHDictionary(entryValue);
    NSString *role = DSHString(entry[@"role"]);
    NSString *content = DSHString(entry[@"content"]);
    BOOL supportedRole = [role isEqualToString:@"user"] || [role isEqualToString:@"assistant"];
    BOOL assistant = [role isEqualToString:@"assistant"];
    NSUInteger contentBytes = [content lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    BOOL hasText = [[content stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]] length] > 0;
    id attachmentValue = entry[@"attachments"];
    NSArray *attachmentEntries = attachmentValue == nil ? @[] : DSHArray(attachmentValue);
    if (entry == nil || !supportedRole || content == nil
      || attachmentEntries == nil
      || attachmentEntries.count > DSHMaximumAttachmentsPerMessage
      || (assistant && attachmentEntries.count > 0)
      || (!hasText && attachmentEntries.count == 0)
      || contentBytes > DSHMaximumMessageBytes) {
      if (error != nil) *error = DSHLocalRuntimeError(1007, @"Conversation history contains an invalid message");
      return nil;
    }
    if (contentBytes > DSHMaximumHistoryBytes - totalBytes) {
      if (error != nil) *error = DSHLocalRuntimeError(1008, @"Conversation history is too large");
      return nil;
    }
    totalBytes += contentBytes;

    NSMutableArray<NSDictionary *> *references = [NSMutableArray arrayWithCapacity:attachmentEntries.count];
    NSMutableArray<NSDictionary *> *imageParts = [NSMutableArray array];
    NSMutableArray<NSString *> *textProjections = [NSMutableArray array];
    NSMutableSet<NSString *> *messageAttachmentIDs = [NSMutableSet setWithCapacity:attachmentEntries.count];
    for (id attachmentValueEntry in attachmentEntries) {
      NSData *payload = nil;
      NSDictionary *manifest = nil;
      NSDictionary *reference = DSHResolveAttachmentReference(
        attachmentValueEntry, &payload, &manifest, error);
      if (reference == nil) return nil;
      NSString *identifier = DSHString(reference[@"id"]);
      if ([messageAttachmentIDs containsObject:identifier]) {
        if (error != nil) *error = DSHLocalRuntimeError(1032, @"Duplicate attachment reference");
        return nil;
      }
      [messageAttachmentIDs addObject:identifier];
      uint64_t size = [reference[@"size"] unsignedLongLongValue];
      if (attachmentCount >= DSHMaximumAttachmentCount
        || size > DSHMaximumAttachmentBytes - attachmentBytes) {
        if (error != nil) {
          *error = DSHLocalRuntimeError(1033, @"Conversation attachments exceed the request limit");
        }
        return nil;
      }
      attachmentCount += 1;
      attachmentBytes += size;
      [references addObject:reference];

      NSString *kind = DSHString(reference[@"kind"]);
      if ([kind isEqualToString:@"image"]) {
        if (![model isEqualToString:@"deepseek-v4-flash-vision-exp"]) {
          if (error != nil) {
            *error = DSHLocalRuntimeError(1034, @"Image attachments require Flash Exp");
          }
          return nil;
        }
        NSData *imageData = payload;
        if (imageData == nil
          || imageData.length != [manifest[@"size"] unsignedLongLongValue]) {
          if (error != nil && *error == nil) {
            *error = DSHLocalRuntimeError(1035, @"Image attachment cannot be read safely");
          }
          return nil;
        }
        NSString *mimeType = DSHString(manifest[@"mime_type"]);
        NSString *encoded = [imageData base64EncodedStringWithOptions:0];
        NSString *dataURL = [NSString stringWithFormat:@"data:%@;base64,%@", mimeType, encoded];
        [imageParts addObject:@{
          @"type": @"image_url",
          @"image_url": @{@"url": dataURL},
        }];
      } else if ([kind isEqualToString:@"text"]) {
        NSString *text = DSHReadUTF8Attachment(payload, error);
        if (text == nil) return nil;
        [textProjections addObject:DSHDelimitedAttachment(reference, text, @"TEXT")];
      } else if ([kind isEqualToString:@"pdf"]) {
        NSString *text = DSHExtractPDFAttachment(payload, error);
        if (text == nil) return nil;
        [textProjections addObject:DSHDelimitedAttachment(reference, text, @"PDF")];
      } else {
        if (error != nil) *error = DSHLocalRuntimeError(1036, @"Unsupported attachment kind");
        return nil;
      }
    }

    NSMutableArray<NSString *> *textParts = [NSMutableArray array];
    if (hasText) [textParts addObject:content];
    [textParts addObjectsFromArray:textProjections];
    NSString *expandedText = [textParts componentsJoinedByString:@"\n\n"];
    NSUInteger messageExpandedBytes = [expandedText lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if (messageExpandedBytes > DSHMaximumExpandedHistoryBytes - expandedBytes) {
      if (error != nil) {
        *error = DSHLocalRuntimeError(1037, @"Expanded attachment text exceeds the request limit");
      }
      return nil;
    }
    expandedBytes += messageExpandedBytes;

    id modelContent = expandedText;
    if (imageParts.count > 0) {
      NSMutableArray<NSDictionary *> *contentParts = [NSMutableArray array];
      if (expandedText.length > 0) {
        [contentParts addObject:@{@"type": @"text", @"text": expandedText}];
      }
      [contentParts addObjectsFromArray:imageParts];
      modelContent = contentParts;
    }
    NSMutableDictionary *modelMessage = [@{@"role": role, @"content": modelContent} mutableCopy];
    [messages addObject:modelMessage];
    NSMutableDictionary *projected = [@{@"role": role, @"content": content} mutableCopy];
    if (references.count > 0) projected[@"attachments"] = references;
    [projectedMessages addObject:projected];
  }
  if (![DSHString(messages.lastObject[@"role"]) isEqualToString:@"user"]) {
    if (error != nil) *error = DSHLocalRuntimeError(1009, @"Conversation history must end with a user message");
    return nil;
  }
  if (proofMessages != nil) *proofMessages = projectedMessages;
  return messages;
}

- (BOOL)importStagedCredential:(NSError **)error {
#if TARGET_OS_SIMULATOR && defined(DSH_LOCAL_PROOF)
  NSString *temporary = NSTemporaryDirectory();
  NSURL *staged = [NSURL fileURLWithPath:[temporary stringByAppendingPathComponent:@".dsh-provision-key"]];
  NSURL *acknowledgement = [NSURL fileURLWithPath:[temporary stringByAppendingPathComponent:@".dsh-provision-ack"]];
  int descriptor = open(staged.fileSystemRepresentation, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    if (errno == ENOENT) return [self credentialLookupStatus] == errSecSuccess;
    if (error != nil) *error = DSHLocalRuntimeError(1013, @"Unable to open staged credential securely");
    return NO;
  }
  if (unlink(staged.fileSystemRepresentation) != 0) {
    close(descriptor);
    if (error != nil) *error = DSHLocalRuntimeError(1015, @"Unable to consume staged credential safely");
    return NO;
  }

  struct stat metadata = {};
  BOOL metadataValid = fstat(descriptor, &metadata) == 0
    && S_ISREG(metadata.st_mode)
    && metadata.st_uid == geteuid()
    && (metadata.st_mode & 0777) == 0600
    && metadata.st_size >= 16
    && metadata.st_size <= 513;
  if (!metadataValid) {
    close(descriptor);
    if (error != nil) *error = DSHLocalRuntimeError(1014, @"Staged credential metadata is invalid");
    return NO;
  }

  NSMutableData *stagedData = [NSMutableData dataWithLength:(NSUInteger)metadata.st_size];
  uint8_t *destination = static_cast<uint8_t *>(stagedData.mutableBytes);
  ssize_t totalRead = 0;
  while (totalRead < metadata.st_size) {
    ssize_t amount = read(descriptor, destination + totalRead, (size_t)(metadata.st_size - totalRead));
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) break;
    totalRead += amount;
  }
  close(descriptor);
  if (totalRead != metadata.st_size) {
    [stagedData resetBytesInRange:NSMakeRange(0, stagedData.length)];
    if (error != nil) *error = DSHLocalRuntimeError(1015, @"Unable to consume staged credential safely");
    return NO;
  }

  NSString *value = [[NSString alloc] initWithData:stagedData encoding:NSUTF8StringEncoding];
  [stagedData resetBytesInRange:NSMakeRange(0, stagedData.length)];
  value = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (value.length < 16 || value.length > 512) {
    if (error != nil) *error = DSHLocalRuntimeError(1001, @"Staged credential has an invalid value");
    return NO;
  }
  if (![self storeCredential:value error:error]) return NO;
  NSData *ack = [@"ok\n" dataUsingEncoding:NSUTF8StringEncoding];
  if (![ack writeToURL:acknowledgement options:NSDataWritingAtomic error:error]) return NO;
  [[NSFileManager defaultManager] setAttributes:@{NSFilePosixPermissions: @0600}
                                   ofItemAtPath:acknowledgement.path error:nil];
  return YES;
#else
  return self.credential.length > 0;
#endif
}

- (NSDictionary *)runRishProbe:(NSError **)error {
  NSURL *support = [self applicationSupportURL:error];
  if (support == nil) return nil;
  NSURL *workspace = [support URLByAppendingPathComponent:@"rish-workspace" isDirectory:YES];
  if (![[NSFileManager defaultManager] createDirectoryAtURL:workspace
                                withIntermediateDirectories:YES
                                                 attributes:@{NSFilePosixPermissions: @0700}
                                                      error:error]) {
    return nil;
  }

  NSData *stdinData = [@"dsh-mobile-local-proof" dataUsingEncoding:NSUTF8StringEncoding];
  NSMutableArray<NSNumber *> *stdinBytes = [NSMutableArray arrayWithCapacity:stdinData.length];
  const uint8_t *bytes = static_cast<const uint8_t *>(stdinData.bytes);
  for (NSUInteger index = 0; index < stdinData.length; index += 1) {
    [stdinBytes addObject:@(bytes[index])];
  }
  NSDictionary *request = @{
    @"protocol_version": @1,
    @"sandbox_root": workspace.path,
    @"read_only": @NO,
    @"user": @"dsh-mobile",
    @"hostname": @"ios-simulator",
    @"command": @{
      @"program": @"sha256sum",
      @"args": @[],
      @"env": @{},
      @"cwd": @"/",
      @"stdin": stdinBytes,
    },
  };
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:request options:0 error:error];
  if (encoded == nil) return nil;

  char *raw = rish_execute_applet_json(
    static_cast<const char *>(encoded.bytes),
    encoded.length
  );
  if (raw == nullptr) {
    if (error != nil) {
      *error = [NSError errorWithDomain:@"LocalRuntime"
                                   code:1002
                               userInfo:@{NSLocalizedDescriptionKey: @"rish returned a null response"}];
    }
    return nil;
  }
  NSString *responseText = [NSString stringWithUTF8String:raw];
  rish_string_free(raw);
  if (responseText == nil) {
    if (error != nil) *error = DSHLocalRuntimeError(1016, @"rish returned invalid UTF-8");
    return nil;
  }
  NSData *responseData = [responseText dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *response = DSHDictionary(
    [NSJSONSerialization JSONObjectWithData:responseData options:0 error:error]
  );
  NSDictionary *outcome = DSHDictionary(response[@"outcome"]);
  NSDictionary *path = DSHDictionary(outcome[@"path"]);
  NSData *stdoutData = DSHDataFromByteArray(DSHArray(outcome[@"stdout"]));
  NSData *stderrData = DSHDataFromByteArray(DSHArray(outcome[@"stderr"]));
  NSString *stdoutText = [[NSString alloc] initWithData:stdoutData encoding:NSUTF8StringEncoding];
  NSString *expected = [NSString stringWithFormat:@"%@  -\n", DSHSha256Hex(stdinData)];
  BOOL valid = [response[@"ok"] boolValue]
    && [response[@"protocol_version"] integerValue] == rish_protocol_version()
    && [outcome[@"exit_code"] integerValue] == 0
    && [DSHString(path[@"kind"]) isEqualToString:@"portable_applet"]
    && [DSHString(path[@"name"]) isEqualToString:@"sha256sum"]
    && stderrData.length == 0
    && [stdoutText isEqualToString:expected];
  if (!valid) {
    if (error != nil) {
      *error = [NSError errorWithDomain:@"LocalRuntime"
                                   code:1003
                               userInfo:@{NSLocalizedDescriptionKey: DSHString(response[@"error"]) ?: @"rish probe receipt is invalid"}];
    }
    return nil;
  }
  return @{
    @"protocol_version": response[@"protocol_version"],
    @"program": @"sha256sum",
    @"exit_code": outcome[@"exit_code"],
    @"path_kind": path[@"kind"],
    @"path_name": path[@"name"],
    @"stdout": stdoutText,
  };
}

- (NSURL *)proofURL:(NSError **)error {
  return [[self applicationSupportURL:error] URLByAppendingPathComponent:DSHProofFilename];
}

- (NSMutableDictionary *)readProof:(NSError **)error {
  NSURL *url = [self proofURL:error];
  if (url == nil) return nil;
  NSData *data = [NSData dataWithContentsOfURL:url options:0 error:nil];
  if (data == nil) return nil;
  if (data.length == 0 || data.length > DSHMaximumProofBytes) {
    if (error != nil) *error = DSHLocalRuntimeError(1017, @"Runtime proof has an invalid size");
    return nil;
  }
  NSDictionary *decoded = DSHDictionary(
    [NSJSONSerialization JSONObjectWithData:data options:0 error:error]
  );
  if (decoded == nil) {
    if (error != nil && *error == nil) *error = DSHLocalRuntimeError(1018, @"Runtime proof root is invalid");
    return nil;
  }
  return [decoded mutableCopy];
}

- (BOOL)writeProof:(NSDictionary *)proof error:(NSError **)error {
  NSURL *url = [self proofURL:error];
  if (url == nil) return NO;
  NSData *data = [NSJSONSerialization dataWithJSONObject:proof
                                                 options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                   error:error];
  if (data == nil || data.length > DSHMaximumProofBytes
    || ![data writeToURL:url options:NSDataWritingAtomic error:error]) {
    if (error != nil && *error == nil) *error = DSHLocalRuntimeError(1019, @"Runtime proof is too large");
    return NO;
  }
  [[NSFileManager defaultManager] setAttributes:@{NSFilePosixPermissions: @0600}
                                   ofItemAtPath:url.path
                                          error:nil];
  return YES;
}

- (NSMutableDictionary *)baseProofWithRishReceipt:(NSDictionary *)currentRishReceipt
                                       credential:(BOOL)hasCredential
                                             error:(NSError **)error {
  NSMutableDictionary *previous = [self readProof:nil] ?: [NSMutableDictionary dictionary];
  NSDictionary *modelResponse = DSHDictionary(previous[@"model_response"]);
  NSDictionary *sessionPersisted = DSHDictionary(previous[@"session_persisted"]);
  NSDictionary *sessionRestore = DSHDictionary(previous[@"session_restore"]);
  NSDictionary *rishReceipt = currentRishReceipt ?: DSHDictionary(previous[@"rish_probe"]);
  NSString *launchId = DSHLaunchInstanceId();
  BOOL modelReceived = DSHString(modelResponse[@"launch_instance_id"]).length > 0;
  BOOL restoredForThisLaunch = [DSHString(sessionRestore[@"restore_launch_instance_id"])
    isEqualToString:launchId];
  NSString *runtimeId = [self runtimeId:error];
  if (runtimeId == nil) return nil;

#if TARGET_OS_SIMULATOR
  NSString *platform = @"ios_simulator";
#else
  NSString *platform = @"ios_device";
#endif

  NSMutableDictionary *proof = [@{
    @"schema_version": @2,
    @"product": @"rish",
    @"active_harness": @"dsh",
    @"mode": @"local_substrate",
    @"platform": platform,
    @"bundle_id": NSBundle.mainBundle.bundleIdentifier ?: @"dev.zseven.dsh.mobile",
    @"runtime_id": runtimeId,
    @"launch_instance_id": launchId,
    @"process_id": @(getpid()),
    @"generated_at": DSHNow(),
    @"container_root": @"Application Support",
    @"session_store": DSHSessionFilename,
    @"model_transport": @"url_session",
    @"rish_backend": @"portable_applet",
    @"rish_protocol_version": @(rish_protocol_version()),
    @"rish_probe": rishReceipt ?: @{},
    @"mac_dsh_port_3180_reachable": @(DSHCanConnectToMacProxy()),
    @"checks": @{
      @"credential_in_keychain": @(hasCredential),
      @"model_response_received": @(modelReceived),
      @"session_restored_after_restart": @(restoredForThisLaunch),
      @"rish_applet_executed": @(rishReceipt.count > 0),
    },
  } mutableCopy];
  NSString *proofRunId = DSHString(previous[@"proof_run_id"]);
  if (proofRunId.length > 0) proof[@"proof_run_id"] = proofRunId;
  if (modelResponse != nil) proof[@"model_response"] = modelResponse;
  if (sessionPersisted != nil) proof[@"session_persisted"] = sessionPersisted;
  if (sessionRestore != nil) proof[@"session_restore"] = sessionRestore;
  DSHPreserveRuntimeProofTraces(previous, proof);
  return proof;
}

- (void)recordCredentialConfigured:(BOOL)configured {
  NSMutableDictionary *proof = [self baseProofWithRishReceipt:nil
                                                    credential:configured
                                                          error:nil];
  if (proof != nil) [self writeProof:proof error:nil];
}

- (BOOL)finishCompletionRequestId:(NSString *)requestId
             completionGeneration:(NSUInteger)completionGeneration
             credentialGeneration:(NSUInteger)credentialGeneration {
  @synchronized (self) {
    if (![self.activeCompletionRequestId isEqualToString:requestId]
      || self.activeCompletionGeneration != completionGeneration
      || self.credentialGeneration != credentialGeneration) {
      return NO;
    }
    self.activeCompletionTask = nil;
    self.activeCompletionRequestId = nil;
    self.activeCompletionGeneration = 0;
    return YES;
  }
}

RCT_REMAP_METHOD(credentialStatus,
                 credentialStatusWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.stateQueue, ^{
    NSError *importError = nil;
    [self importStagedCredential:&importError];
    if (importError != nil) {
      reject(@"credential",
             importError.localizedDescription ?: @"Unable to import staged credential",
             importError);
      return;
    }
    OSStatus status = [self credentialLookupStatus];
    if (status == errSecSuccess) {
      resolve(@{@"status": @"configured"});
    } else if (status == errSecItemNotFound) {
      resolve(@{@"status": @"missing"});
    } else {
      NSError *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
      reject(@"keychain", @"Unable to read credential status", error);
    }
  });
}

RCT_REMAP_METHOD(presentCredentialPrompt,
                 presentCredentialPromptForLocale:(id)localeValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  // The app passes its resolved locale. Any absent, malformed, or unsupported
  // value falls back to English instead of consulting mutable device state.
  BOOL usesChinese = DSHCredentialPromptUsesChinese(localeValue);
  NSString *title = usesChinese ? @"DeepSeek API 密钥" : @"DeepSeek API key";
  NSString *message = usesChinese
    ? @"仅保存在此设备的钥匙串中。Rish 不会将密钥发送到 JavaScript。"
    : @"Saved only in this device's Keychain. Rish never sends the key to JavaScript.";
  NSString *cancelTitle = usesChinese ? @"取消" : @"Cancel";
  NSString *saveTitle = usesChinese ? @"安全保存" : @"Save securely";
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = RCTPresentedViewController();
    if (presenter == nil || [presenter isKindOfClass:UIAlertController.class]) {
      reject(@"presentation", @"Credential prompt cannot be presented right now", nil);
      return;
    }

    UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:title
                       message:message
                preferredStyle:UIAlertControllerStyleAlert];
    [alert addTextFieldWithConfigurationHandler:^(UITextField *textField) {
      textField.placeholder = @"sk-…";
      textField.secureTextEntry = YES;
      textField.autocorrectionType = UITextAutocorrectionTypeNo;
      textField.autocapitalizationType = UITextAutocapitalizationTypeNone;
      textField.keyboardType = UIKeyboardTypeASCIICapable;
      textField.clearButtonMode = UITextFieldViewModeWhileEditing;
    }];

    __weak UIAlertController *weakAlert = alert;
    UIAlertAction *cancel = [UIAlertAction actionWithTitle:cancelTitle
                                                      style:UIAlertActionStyleCancel
                                                    handler:^(__unused UIAlertAction *action) {
      weakAlert.textFields.firstObject.text = @"";
      resolve(@{@"status": @"cancelled"});
    }];
    UIAlertAction *save = [UIAlertAction actionWithTitle:saveTitle
                                                    style:UIAlertActionStyleDefault
                                                  handler:^(__unused UIAlertAction *action) {
      UITextField *field = weakAlert.textFields.firstObject;
      NSString *value = field.text ?: @"";
      field.text = @"";
      dispatch_async(self.stateQueue, ^{
        NSError *error = nil;
        if (![self storeCredential:value error:&error]) {
          reject(@"credential", error.localizedDescription ?: @"Unable to save credential", error);
          return;
        }
        [self recordCredentialConfigured:YES];
        resolve(@{@"status": @"configured"});
      });
    }];
    [alert addAction:cancel];
    [alert addAction:save];
    [presenter presentViewController:alert animated:YES completion:nil];
  });
}

RCT_REMAP_METHOD(clearCredential,
                 clearCredentialWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.stateQueue, ^{
    NSError *error = nil;
    if (![self deleteCredential:&error]) {
      reject(@"keychain", @"Unable to clear credential", error);
      return;
    }
    [self recordCredentialConfigured:NO];
    resolve(@{@"status": @"cleared"});
  });
}

RCT_REMAP_METHOD(cancelCompletion,
                 cancelCompletionRequestId:(NSString *)requestId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(__unused RCTPromiseRejectBlock)reject) {
  if (!DSHIsValidRequestId(requestId)) {
    resolve(@{@"status": @"stale"});
    return;
  }
  NSURLSessionDataTask *task = nil;
  NSString *status = @"idle";
  @synchronized (self) {
    if (self.activeCompletionTask != nil) {
      if ([self.activeCompletionRequestId isEqualToString:requestId]) {
        task = self.activeCompletionTask;
        self.activeCompletionTask = nil;
        self.activeCompletionRequestId = nil;
        self.activeCompletionGeneration = 0;
        status = @"cancelled";
      } else {
        status = @"stale";
      }
    }
  }
  [task cancel];
  resolve(@{@"status": status});
}

RCT_REMAP_METHOD(bootstrap,
                 bootstrapWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.stateQueue, ^{
    NSError *error = nil;
    BOOL hasCredential = [self importStagedCredential:&error];
    if (!hasCredential) {
      reject(@"credential", error.localizedDescription ?: @"DeepSeek credential is unavailable", error);
      return;
    }
    NSDictionary *rish = [self runRishProbe:&error];
    if (rish == nil) {
      reject(@"rish", error.localizedDescription ?: @"rish probe failed", error);
      return;
    }
    NSMutableDictionary *proof = [self baseProofWithRishReceipt:rish credential:YES error:&error];
    if (proof == nil || ![self writeProof:proof error:&error]) {
      reject(@"proof", error.localizedDescription ?: @"cannot persist runtime proof", error);
      return;
    }
    resolve(@{@"proof": proof, @"rish": rish});
  });
}

RCT_REMAP_METHOD(complete,
                 completeModel:(NSString *)requestedModel
                 history:(NSArray *)history
                 requestId:(NSString *)requestId
                 thinkingMode:(NSString *)thinkingMode
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  if (!DSHIsSupportedModel(requestedModel)) {
    reject(@"model", @"Unsupported DeepSeek model", nil);
    return;
  }
  if (!DSHIsValidRequestId(requestId)) {
    reject(@"request", @"Completion request ID is invalid", nil);
    return;
  }
  if (!DSHIsThinkingMode(thinkingMode)) {
    reject(@"thinking", @"Unsupported DeepSeek thinking mode", nil);
    return;
  }
  NSError *validationError = nil;
  NSArray<NSDictionary *> *proofMessages = nil;
  NSArray<NSDictionary *> *messages = [self validatedMessagesFromHistory:history
                                                                    model:requestedModel
                                                            proofMessages:&proofMessages
                                                                    error:&validationError];
  if (messages == nil) {
    reject(@"history", validationError.localizedDescription, validationError);
    return;
  }
  NSString *historyDigest = DSHJSONSha256(proofMessages, &validationError);
  if (historyDigest == nil) {
    reject(@"history", validationError.localizedDescription, validationError);
    return;
  }
  __block NSString *apiKey = nil;
  __block NSUInteger credentialGeneration = 0;
  @synchronized (self) {
    apiKey = self.credential;
    credentialGeneration = self.credentialGeneration;
  }
  if (apiKey.length == 0) {
    reject(@"credential", @"DeepSeek credential is unavailable", nil);
    return;
  }
  NSURL *url = [NSURL URLWithString:@"https://api.deepseek.com/chat/completions"];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST";
  request.HTTPShouldHandleCookies = NO;
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  request.timeoutInterval = 90;
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [request setValue:[@"Bearer " stringByAppendingString:apiKey] forHTTPHeaderField:@"Authorization"];
  NSMutableDictionary *body = [@{
    @"model": requestedModel,
    @"stream": @NO,
    @"thinking": @{@"type": [thinkingMode isEqualToString:@"off"] ? @"disabled" : @"enabled"},
    @"max_tokens": [thinkingMode isEqualToString:@"off"] ? @1024 : @4096,
    @"messages": messages,
  } mutableCopy];
  if (![thinkingMode isEqualToString:@"off"]) {
    body[@"reasoning_effort"] = thinkingMode;
  }
  NSError *bodyError = nil;
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:&bodyError];
  if (request.HTTPBody == nil || request.HTTPBody.length > DSHMaximumRequestBodyBytes) {
    if (bodyError == nil && request.HTTPBody.length > DSHMaximumRequestBodyBytes) {
      bodyError = DSHLocalRuntimeError(1038, @"Completion request exceeds the transport limit");
    }
    reject(@"request", bodyError.localizedDescription, bodyError);
    return;
  }

  NSDate *started = NSDate.date;
  __block NSUInteger completionGeneration = 0;
  NSURLSessionDataTask *task = [self.modelSession dataTaskWithRequest:request
                                                            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    BOOL (^finishRequest)(void) = ^BOOL {
      return [self finishCompletionRequestId:requestId
                        completionGeneration:completionGeneration
                        credentialGeneration:credentialGeneration];
    };
    if (error != nil) {
      BOOL current = finishRequest();
      if (!current || ([error.domain isEqualToString:NSURLErrorDomain]
        && error.code == NSURLErrorCancelled)) {
        reject(@"cancelled", @"Completion was cancelled", nil);
        return;
      }
      reject(@"transport", error.localizedDescription, error);
      return;
    }
    if (![response isKindOfClass:NSHTTPURLResponse.class]) {
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"response", @"DeepSeek returned a non-HTTP response", nil);
      }
      return;
    }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    if (data.length == 0 || data.length > DSHMaximumResponseBytes) {
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"response", @"DeepSeek response body has an invalid size", nil);
      }
      return;
    }
    NSError *decodeError = nil;
    NSDictionary *decoded = DSHDictionary(
      [NSJSONSerialization JSONObjectWithData:data options:0 error:&decodeError]
    );
    if (decoded == nil) {
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else if (http.statusCode < 200 || http.statusCode >= 300) {
        reject(@"api", [NSString stringWithFormat:@"DeepSeek returned HTTP %ld", (long)http.statusCode], nil);
      } else {
        reject(@"response", decodeError.localizedDescription ?: @"DeepSeek returned invalid JSON", decodeError);
      }
      return;
    }
    if (http.statusCode < 200 || http.statusCode >= 300) {
      NSDictionary *apiError = DSHDictionary(decoded[@"error"]);
      NSString *message = DSHString(apiError[@"message"]);
      if (message.length == 0 || message.length > 512) {
        message = [NSString stringWithFormat:@"DeepSeek returned HTTP %ld", (long)http.statusCode];
      }
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"api", message, nil);
      }
      return;
    }
    NSArray *choices = DSHArray(decoded[@"choices"]);
    NSDictionary *choice = choices.count > 0 ? DSHDictionary(choices.firstObject) : nil;
    NSDictionary *message = DSHDictionary(choice[@"message"]);
    NSString *text = DSHString(message[@"content"]);
    NSString *reasoning = DSHString(message[@"reasoning_content"]) ?: @"";
    BOOL hasAssistantText = [[text stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]] length] > 0;
    if (![text isKindOfClass:NSString.class] || !hasAssistantText) {
      NSString *finish = DSHString(choice[@"finish_reason"]) ?: @"missing";
      BOOL hasReasoning = DSHString(message[@"reasoning_content"]).length > 0;
      NSString *safeDiagnostic = [NSString stringWithFormat:
        @"DeepSeek response has no assistant text (finish=%@, reasoning=%@)",
        finish,
        hasReasoning ? @"present" : @"absent"];
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"response", safeDiagnostic, nil);
      }
      return;
    }

    NSString *model = DSHString(decoded[@"model"]);
    if (model.length == 0 || model.length > 128) model = requestedModel;
    NSString *responseId = DSHString(decoded[@"id"]);
    if (responseId.length > 256) responseId = nil;
    NSString *finishReason = DSHString(choice[@"finish_reason"]) ?: @"unknown";
    if (finishReason.length > 128) finishReason = @"unknown";
    if (!finishRequest()) {
      reject(@"cancelled", @"Completion was cancelled", nil);
      return;
    }
    NSString *assistantDigest = DSHTextSha256(text);
    NSString *reasoningDigest = reasoning.length == 0 ? nil : DSHTextSha256(reasoning);
    if (assistantDigest == nil) {
      reject(@"response", @"DeepSeek assistant text is not valid UTF-8", nil);
      return;
    }
    NSString *proofRunId = NSUUID.UUID.UUIDString.lowercaseString;

    dispatch_async(self.stateQueue, ^{
      NSError *proofError = nil;
      BOOL hasCurrentCredential = [self credentialLookupStatus] == errSecSuccess;
      NSMutableDictionary *proof = [self baseProofWithRishReceipt:nil
                                                        credential:hasCurrentCredential
                                                              error:&proofError];
      if (proof == nil) return;
      NSMutableDictionary *checks = [proof[@"checks"] mutableCopy];
      checks[@"model_response_received"] = @YES;
      checks[@"session_restored_after_restart"] = @NO;
      proof[@"checks"] = checks;
      proof[@"proof_run_id"] = proofRunId;
      proof[@"model_response"] = @{
        @"proof_run_id": proofRunId,
        @"launch_instance_id": DSHLaunchInstanceId(),
        @"received_at": DSHNow(),
        @"http_status": @(http.statusCode),
        @"model": model,
        @"requested_model": requestedModel,
        @"request_id": requestId,
        @"request_history_sha256": historyDigest,
        @"request_message_count": @(proofMessages.count),
        @"assistant_text_sha256": assistantDigest,
        @"thinking_mode": thinkingMode,
        @"reasoning_text_sha256": reasoningDigest ?: @"none",
        @"finish_reason": finishReason,
        @"response_id": responseId ?: @"unreported",
      };
      [proof removeObjectForKey:@"session_persisted"];
      [proof removeObjectForKey:@"session_restore"];
      [self writeProof:proof error:nil];
    });
    resolve(@{
      @"text": text,
      @"model": model,
      @"request_id": requestId,
      @"latency_ms": @((NSInteger)(-[started timeIntervalSinceNow] * 1000)),
      @"reasoning": reasoning,
      @"thinking_mode": thinkingMode,
    });
  }];
  NSURLSessionDataTask *previousTask = nil;
  @synchronized (self) {
    if (credentialGeneration != self.credentialGeneration) {
      reject(@"credential", @"Credential changed before the request started", nil);
      return;
    }
    self.completionGeneration += 1;
    completionGeneration = self.completionGeneration;
    previousTask = self.activeCompletionTask;
    self.activeCompletionTask = task;
    self.activeCompletionRequestId = requestId;
    self.activeCompletionGeneration = completionGeneration;
  }
  [previousTask cancel];
  [task resume];
}

RCT_REMAP_METHOD(completeV2,
                 completeV2EnvelopeJSON:(NSString *)envelopeJSON
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *envelopeDecodeError = nil;
  NSData *envelopeData =
    [envelopeJSON dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *envelope = DSHDictionary(
    [NSJSONSerialization JSONObjectWithData:envelopeData options:0
                                      error:&envelopeDecodeError]);
  if (envelope == nil ||
      ![envelope[@"schema_version"] isEqual:@(kDSHCompletionEnvelopeVersion)]) {
    reject(@"request",
           @"CompletionV2 envelope must be an object with schema_version 1", nil);
    return;
  }
  NSString *requestedModel = DSHString(envelope[@"model"]);
  NSString *requestId = DSHString(envelope[@"request_id"]);
  NSString *thinkingMode = DSHString(envelope[@"thinking_mode"]);
  NSArray *history = DSHArray(envelope[@"history"]);
  if (!DSHIsSupportedModel(requestedModel)) {
    reject(@"model", @"Unsupported DeepSeek model", nil);
    return;
  }
  if (!DSHIsValidRequestId(requestId)) {
    reject(@"request", @"Completion request ID is invalid", nil);
    return;
  }
  if (!DSHIsThinkingMode(thinkingMode)) {
    reject(@"thinking", @"Unsupported DeepSeek thinking mode", nil);
    return;
  }
  NSError *validationError = nil;
  NSArray<NSDictionary *> *proofMessages = nil;
  NSArray<NSDictionary *> *messages = [self validatedMessagesFromHistory:history
                                                                    model:requestedModel
                                                            proofMessages:&proofMessages
                                                                    error:&validationError];
  if (messages == nil) {
    reject(@"history", validationError.localizedDescription, validationError);
    return;
  }
  NSArray *tools = DSHCompletionToolsV2FromArray(
    DSHArray(envelope[@"tools"]), &validationError);
  if (tools == nil) {
    reject(@"tools", validationError.localizedDescription, validationError);
    return;
  }
  NSString *historyDigest = DSHJSONSha256(proofMessages, &validationError);
  if (historyDigest == nil) {
    reject(@"history", validationError.localizedDescription, validationError);
    return;
  }
  __block NSString *apiKey = nil;
  __block NSUInteger credentialGeneration = 0;
  @synchronized (self) {
    apiKey = self.credential;
    credentialGeneration = self.credentialGeneration;
  }
  if (apiKey.length == 0) {
    reject(@"credential", @"DeepSeek credential is unavailable", nil);
    return;
  }
  NSURL *url = [NSURL URLWithString:@"https://api.deepseek.com/chat/completions"];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST";
  request.HTTPShouldHandleCookies = NO;
  request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  request.timeoutInterval = 90;
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [request setValue:[@"Bearer " stringByAppendingString:apiKey] forHTTPHeaderField:@"Authorization"];
  NSDictionary *body = DSHCompletionRequestBodyV2(
    requestedModel, thinkingMode, messages, tools);
  if (body == nil) {
    reject(@"request", @"CompletionV2 request body could not be built", nil);
    return;
  }
  NSError *bodyError = nil;
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:&bodyError];
  if (request.HTTPBody == nil || request.HTTPBody.length > DSHMaximumRequestBodyBytes) {
    if (bodyError == nil && request.HTTPBody.length > DSHMaximumRequestBodyBytes) {
      bodyError = DSHLocalRuntimeError(1038, @"Completion request exceeds the transport limit");
    }
    reject(@"request", bodyError.localizedDescription, bodyError);
    return;
  }

  NSDate *started = NSDate.date;
  __block NSUInteger completionGeneration = 0;
  NSURLSessionDataTask *task = [self.modelSession dataTaskWithRequest:request
                                                            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    BOOL (^finishRequest)(void) = ^BOOL {
      return [self finishCompletionRequestId:requestId
                        completionGeneration:completionGeneration
                        credentialGeneration:credentialGeneration];
    };
    if (error != nil) {
      BOOL current = finishRequest();
      if (!current || ([error.domain isEqualToString:NSURLErrorDomain]
        && error.code == NSURLErrorCancelled)) {
        reject(@"cancelled", @"Completion was cancelled", nil);
        return;
      }
      reject(@"transport", error.localizedDescription, error);
      return;
    }
    if (![response isKindOfClass:NSHTTPURLResponse.class]) {
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"response", @"DeepSeek returned a non-HTTP response", nil);
      }
      return;
    }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    if (data.length == 0 || data.length > DSHMaximumResponseBytes) {
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"response", @"DeepSeek response body has an invalid size", nil);
      }
      return;
    }
    NSError *decodeError = nil;
    NSDictionary *decoded = DSHDictionary(
      [NSJSONSerialization JSONObjectWithData:data options:0 error:&decodeError]);
    if (decoded == nil) {
      BOOL current = finishRequest();
      if (!current) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else if (http.statusCode < 200 || http.statusCode >= 300) {
        reject(@"api", [NSString stringWithFormat:@"DeepSeek returned HTTP %ld", (long)http.statusCode], nil);
      } else {
        reject(@"response", decodeError.localizedDescription ?: @"DeepSeek returned invalid JSON", decodeError);
      }
      return;
    }
    if (http.statusCode < 200 || http.statusCode >= 300) {
      NSDictionary *apiError = DSHDictionary(decoded[@"error"]);
      NSString *message = DSHString(apiError[@"message"]);
      if (message.length == 0 || message.length > 512) {
        message = [NSString stringWithFormat:@"DeepSeek returned HTTP %ld", (long)http.statusCode];
      }
      if (!finishRequest()) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"api", message, nil);
      }
      return;
    }
    NSError *parseError = nil;
    NSDictionary *parsed = DSHParseCompletionResponseV2(decoded, &parseError);
    if (parsed == nil) {
      BOOL current = finishRequest();
      if (!current) {
        reject(@"cancelled", @"Completion was cancelled", nil);
      } else {
        reject(@"response", parseError.localizedDescription ?: @"DeepSeek response failed validation", parseError);
      }
      return;
    }
    NSString *text = parsed[@"text"];
    NSString *reasoning = parsed[@"reasoning"];
    NSString *finishReason = parsed[@"finish_reason"];
    NSArray *toolCalls = parsed[@"tool_calls"];
    NSString *model = DSHString(decoded[@"model"]);
    if (model.length == 0 || model.length > 128) model = requestedModel;
    if (!finishRequest()) {
      reject(@"cancelled", @"Completion was cancelled", nil);
      return;
    }
    NSString *assistantDigest = text.length == 0 ? nil : DSHTextSha256(text);
    NSString *reasoningDigest = reasoning.length == 0 ? nil : DSHTextSha256(reasoning);
    if (text.length > 0 && assistantDigest == nil) {
      reject(@"response", @"DeepSeek assistant text is not valid UTF-8", nil);
      return;
    }
    NSString *proofRunId = NSUUID.UUID.UUIDString.lowercaseString;

    dispatch_async(self.stateQueue, ^{
      NSError *proofError = nil;
      BOOL hasCurrentCredential = [self credentialLookupStatus] == errSecSuccess;
      NSMutableDictionary *proof = [self baseProofWithRishReceipt:nil
                                                        credential:hasCurrentCredential
                                                              error:&proofError];
      if (proof == nil) return;
      NSMutableDictionary *checks = [proof[@"checks"] mutableCopy];
      checks[@"model_response_received"] = @YES;
      checks[@"session_restored_after_restart"] = @NO;
      proof[@"checks"] = checks;
      proof[@"proof_run_id"] = proofRunId;
      proof[@"model_response"] = @{
        @"proof_run_id": proofRunId,
        @"launch_instance_id": DSHLaunchInstanceId(),
        @"received_at": DSHNow(),
        @"http_status": @(http.statusCode),
        @"model": model,
        @"requested_model": requestedModel,
        @"request_id": requestId,
        @"request_history_sha256": historyDigest,
        @"request_message_count": @(proofMessages.count),
        @"assistant_text_sha256": assistantDigest ?: @"none",
        @"thinking_mode": thinkingMode,
        @"reasoning_text_sha256": reasoningDigest ?: @"none",
        @"finish_reason": finishReason,
        @"tool_calls_count": @(toolCalls.count),
        @"response_id": DSHString(decoded[@"id"]) ?: @"unreported",
      };
      [proof removeObjectForKey:@"session_persisted"];
      [proof removeObjectForKey:@"session_restore"];
      [self writeProof:proof error:nil];
    });
    resolve(@{
      @"schema_version": @1,
      @"text": text,
      @"tool_calls": toolCalls,
      @"finish_reason": finishReason,
      @"model": model,
      @"request_id": requestId,
      @"latency_ms": @((NSInteger)(-[started timeIntervalSinceNow] * 1000)),
      @"reasoning": reasoning,
      @"thinking_mode": thinkingMode,
    });
  }];
  NSURLSessionDataTask *previousTask = nil;
  @synchronized (self) {
    if (credentialGeneration != self.credentialGeneration) {
      reject(@"credential", @"Credential changed before the request started", nil);
      return;
    }
    self.completionGeneration += 1;
    completionGeneration = self.completionGeneration;
    previousTask = self.activeCompletionTask;
    self.activeCompletionTask = task;
    self.activeCompletionRequestId = requestId;
    self.activeCompletionGeneration = completionGeneration;
  }
  [previousTask cancel];
  [task resume];
}

RCT_REMAP_METHOD(recordAgentTrace,
                 recordAgentTraceEntries:(NSArray *)entries
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.stateQueue, ^{
    NSError *error = nil;
    NSMutableDictionary *proof = [self baseProofWithRishReceipt:nil
                                                      credential:([self credentialLookupStatus] == errSecSuccess)
                                                            error:&error];
    if (proof == nil) {
      reject(@"proof", @"Runtime proof state is unavailable", nil);
      return;
    }
    if (![entries isKindOfClass:NSArray.class] || entries.count > 32) {
      reject(@"trace", @"Agent trace entries must be an array of at most 32 rows", nil);
      return;
    }
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
    for (NSDictionary *entry in entries) {
      if (![entry isKindOfClass:NSDictionary.class]) continue;
      NSString *name = DSHString(entry[@"name"]);
      NSString *argsSha = DSHString(entry[@"arguments_sha256"]);
      NSString *outcome = DSHString(entry[@"outcome"]);
      if (!DSHProofToolNameIsSafe(name)) continue;
      if (!DSHProofDigestIsSafe(argsSha)) continue;
      if (![outcome isEqualToString:@"ok"] &&
          ![outcome isEqualToString:@"failed"] &&
          ![outcome isEqualToString:@"denied"]) continue;
      [rows addObject:@{
        @"name": name,
        @"arguments_sha256": argsSha,
        @"outcome": outcome,
        @"recorded_at": DSHNow(),
      }];
    }
    proof[@"agent_tool_trace"] = @{
      @"recorded_at": DSHNow(),
      @"entry_count": @(rows.count),
      @"entries": rows,
    };
    [self writeProof:proof error:nil];
    resolve(@{ @"recorded": @(rows.count) });
  });
}

RCT_REMAP_METHOD(recordModelTransition,
                 recordModelTransitionEntry:(NSDictionary *)entry
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.stateQueue, ^{
    NSError *error = nil;
    NSString *recordedAt = DSHNow();
    NSDictionary *row = DSHValidatedModelTransitionProofRow(
        entry, recordedAt, &error);
    if (row == nil) {
      reject(@"trace",
             error.localizedDescription ?: @"Model transition entry is invalid",
             error);
      return;
    }
    NSMutableDictionary *proof = [self baseProofWithRishReceipt:nil
                                                      credential:([self credentialLookupStatus] == errSecSuccess)
                                                            error:&error];
    if (proof == nil) {
      reject(@"proof", @"Runtime proof state is unavailable", error);
      return;
    }
    NSDictionary *trace = DSHModelTransitionTraceByAppendingRow(
        proof[@"model_transition_trace"], row, recordedAt);
    proof[@"model_transition_trace"] = trace;
    if (![self writeProof:proof error:&error]) {
      reject(@"proof",
             error.localizedDescription ?: @"Unable to update runtime proof",
             error);
      return;
    }
    resolve(@{ @"recorded": trace[@"entry_count"] });
  });
}

RCT_REMAP_METHOD(persistSession,
                 persistSessionJSON:(NSString *)json
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.stateQueue, ^{
    NSError *error = nil;
    if (![json isKindOfClass:NSString.class]) {
      reject(@"session", @"Session payload must be a JSON string", nil);
      return;
    }
    NSData *source = [json dataUsingEncoding:NSUTF8StringEncoding];
    if (source.length == 0 || source.length > DSHMaximumSessionBytes) {
      reject(@"session", @"Session payload has an invalid size", nil);
      return;
    }
    NSDictionary *session = DSHDictionary(
      [NSJSONSerialization JSONObjectWithData:source options:0 error:&error]
    );
    if (session == nil) {
      reject(@"session", error.localizedDescription ?: @"Session root must be an object", error);
      return;
    }
    NSArray<NSDictionary *> *messages = DSHProjectPersistedMessages(session[@"messages"], &error);
    if (messages == nil) {
      reject(@"session", error.localizedDescription, error);
      return;
    }

    NSURL *support = [self applicationSupportURL:&error];
    if (support == nil) {
      reject(@"session", error.localizedDescription ?: @"Session storage is unavailable", error);
      return;
    }
    NSURL *url = [support URLByAppendingPathComponent:DSHSessionFilename];
    NSMutableDictionary *mutableEnvelope = [@{
      @"schema_version": @2,
      @"writer_launch_instance_id": DSHLaunchInstanceId(),
      @"session": session,
    } mutableCopy];
    NSMutableDictionary *proof = [self baseProofWithRishReceipt:nil
                                                      credential:([self credentialLookupStatus] == errSecSuccess)
                                                            error:nil];
    if (proof == nil) {
      reject(@"session", @"Runtime proof state is unavailable", nil);
      return;
    }
    NSDictionary *modelResponse = DSHDictionary(proof[@"model_response"]);
    NSString *proofRunId = DSHString(proof[@"proof_run_id"]);
    NSString *requestId = DSHString(modelResponse[@"request_id"]);
    BOOL responseCorrelated = proofRunId.length > 0
      && [DSHString(modelResponse[@"proof_run_id"]) isEqualToString:proofRunId]
      && [DSHString(modelResponse[@"launch_instance_id"]) isEqualToString:DSHLaunchInstanceId()]
      && DSHMessagesMatchModelResponse(messages, modelResponse)
      && DSHReasoningMatchesModelResponse(session[@"messages"], modelResponse);
    if (responseCorrelated) {
      mutableEnvelope[@"proof_run_id"] = proofRunId;
      mutableEnvelope[@"proof_request_id"] = requestId;
    }
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:mutableEnvelope
                                                      options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                        error:&error];
    if (encoded.length > DSHMaximumSessionBytes) {
      reject(@"session", @"Session envelope is too large", nil);
      return;
    }
    BOOL ok = encoded != nil && [encoded writeToURL:url options:NSDataWritingAtomic error:&error];
    if (!ok) {
      reject(@"session", error.localizedDescription, error);
      return;
    }
    [[NSFileManager defaultManager] setAttributes:@{NSFilePosixPermissions: @0600}
                                     ofItemAtPath:url.path error:nil];
    NSMutableDictionary *checks = [proof[@"checks"] mutableCopy];
    if (messages.count == 0) {
      checks[@"model_response_received"] = @NO;
      checks[@"session_restored_after_restart"] = @NO;
      proof[@"checks"] = checks;
      [proof removeObjectForKey:@"proof_run_id"];
      [proof removeObjectForKey:@"model_response"];
      [proof removeObjectForKey:@"session_persisted"];
      [proof removeObjectForKey:@"session_restore"];
    } else if (responseCorrelated) {
      checks[@"session_restored_after_restart"] = @NO;
      proof[@"checks"] = checks;
      proof[@"session_persisted"] = @{
        @"proof_run_id": proofRunId,
        @"request_id": requestId,
        @"request_history_sha256": modelResponse[@"request_history_sha256"],
        @"assistant_text_sha256": modelResponse[@"assistant_text_sha256"],
        @"reasoning_text_sha256": modelResponse[@"reasoning_text_sha256"],
        @"writer_launch_instance_id": DSHLaunchInstanceId(),
        @"sha256": DSHSha256Hex(encoded),
        @"message_count": @(messages.count),
        @"persisted_at": DSHNow(),
      };
      [proof removeObjectForKey:@"session_restore"];
    } else {
      checks[@"session_restored_after_restart"] = @NO;
      proof[@"checks"] = checks;
      [proof removeObjectForKey:@"session_persisted"];
      [proof removeObjectForKey:@"session_restore"];
    }
    if (![self writeProof:proof error:&error]) {
      reject(@"proof", error.localizedDescription ?: @"Unable to update runtime proof", error);
      return;
    }
    resolve(@YES);
  });
}

RCT_REMAP_METHOD(loadSession,
                 loadSessionWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.stateQueue, ^{
    NSError *error = nil;
    NSURL *support = [self applicationSupportURL:&error];
    if (support == nil) {
      reject(@"session", error.localizedDescription ?: @"Session storage is unavailable", error);
      return;
    }
    NSURL *url = [support URLByAppendingPathComponent:DSHSessionFilename];
    NSData *encoded = [NSData dataWithContentsOfURL:url options:0 error:nil];
    if (encoded == nil) {
      resolve([NSNull null]);
      return;
    }
    if (encoded.length == 0 || encoded.length > DSHMaximumSessionBytes) {
      reject(@"session", @"Session envelope has an invalid size", nil);
      return;
    }
    NSError *decodeError = nil;
    NSDictionary *envelope = DSHDictionary(
      [NSJSONSerialization JSONObjectWithData:encoded options:0 error:&decodeError]
    );
    NSDictionary *session = DSHDictionary(envelope[@"session"]);
    NSArray<NSDictionary *> *messages = session == nil
      ? nil
      : DSHProjectPersistedMessages(session[@"messages"], &decodeError);
    NSString *writer = DSHString(envelope[@"writer_launch_instance_id"]);
    if (envelope == nil || ![envelope[@"schema_version"] isEqual:@2]
      || session == nil || messages == nil || writer.length == 0) {
      reject(@"session", decodeError.localizedDescription ?: @"session envelope is invalid", decodeError);
      return;
    }
    BOOL restoredAcrossLaunch = ![writer isEqualToString:DSHLaunchInstanceId()];
    NSMutableDictionary *proof = [self baseProofWithRishReceipt:nil
                                                      credential:([self credentialLookupStatus] == errSecSuccess)
                                                            error:nil];
    NSDictionary *modelResponse = DSHDictionary(proof[@"model_response"]);
    NSDictionary *sessionPersisted = DSHDictionary(proof[@"session_persisted"]);
    NSString *proofRunId = DSHString(proof[@"proof_run_id"]);
    NSString *requestId = DSHString(modelResponse[@"request_id"]);
    NSString *sessionDigest = DSHSha256Hex(encoded);
    BOOL correlated = restoredAcrossLaunch
      && proofRunId.length > 0
      && [DSHString(envelope[@"proof_run_id"]) isEqualToString:proofRunId]
      && [DSHString(envelope[@"proof_request_id"]) isEqualToString:requestId]
      && [DSHString(modelResponse[@"proof_run_id"]) isEqualToString:proofRunId]
      && [DSHString(sessionPersisted[@"proof_run_id"]) isEqualToString:proofRunId]
      && [DSHString(sessionPersisted[@"request_id"]) isEqualToString:requestId]
      && [DSHString(sessionPersisted[@"request_history_sha256"])
        isEqualToString:DSHString(modelResponse[@"request_history_sha256"])]
      && [DSHString(sessionPersisted[@"assistant_text_sha256"])
        isEqualToString:DSHString(modelResponse[@"assistant_text_sha256"])]
      && [DSHString(sessionPersisted[@"reasoning_text_sha256"])
        isEqualToString:DSHString(modelResponse[@"reasoning_text_sha256"])]
      && [DSHString(modelResponse[@"launch_instance_id"]) isEqualToString:writer]
      && [DSHString(sessionPersisted[@"writer_launch_instance_id"]) isEqualToString:writer]
      && [DSHString(sessionPersisted[@"sha256"]) isEqualToString:sessionDigest]
      && [sessionPersisted[@"message_count"] unsignedIntegerValue] == messages.count
      && DSHMessagesMatchModelResponse(messages, modelResponse)
      && DSHReasoningMatchesModelResponse(session[@"messages"], modelResponse);
    if (correlated) {
      NSMutableDictionary *checks = [proof[@"checks"] mutableCopy];
      checks[@"session_restored_after_restart"] = @YES;
      proof[@"checks"] = checks;
      proof[@"session_restore"] = @{
        @"proof_run_id": proofRunId,
        @"request_id": requestId,
        @"writer_launch_instance_id": writer,
        @"restore_launch_instance_id": DSHLaunchInstanceId(),
        @"sha256": sessionDigest,
        @"message_count": @(messages.count),
        @"restored_at": DSHNow(),
      };
      [self writeProof:proof error:nil];
    }
    NSData *sessionData = [NSJSONSerialization dataWithJSONObject:session
                                                          options:NSJSONWritingSortedKeys
                                                            error:&decodeError];
    if (sessionData == nil) {
      reject(@"session", decodeError.localizedDescription ?: @"Unable to encode stored session", decodeError);
      return;
    }
    NSString *json = [[NSString alloc] initWithData:sessionData encoding:NSUTF8StringEncoding];
    resolve(json);
  });
}

@end
