#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *const DSHProjectContextPolicyVersion;

FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxEntries;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxDepth;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxFiles;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxFileBytes;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxChangedPaths;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxDiffBytes;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxContextBytes;
FOUNDATION_EXPORT const NSTimeInterval DSHProjectContextDeadlineSeconds;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxCandidatePageSize;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxRelativePathCharacters;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextMaxQueryCharacters;
FOUNDATION_EXPORT const NSUInteger
    DSHProjectContextMaxSourceFingerprintCharacters;

FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonSecretPath;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonGenerated;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonLockfile;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonSuspectedSecret;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonBinary;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonInvalidEncoding;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonNotTracked;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonBudgetExceeded;
FOUNDATION_EXPORT NSString *const DSHProjectContextOmissionReasonPolicy;

FOUNDATION_EXPORT NSErrorDomain const DSHProjectContextPolicyErrorDomain;

typedef NS_ERROR_ENUM(DSHProjectContextPolicyErrorDomain,
                      DSHProjectContextPolicyErrorCode) {
  DSHProjectContextPolicyErrorInvalidArgument = 1,
  DSHProjectContextPolicyErrorInvalidCursor = 2,
  DSHProjectContextPolicyErrorStaleCursor = 3,
  DSHProjectContextPolicyErrorBudgetExceeded = 4,
};

@interface DSHProjectContextPathDecision : NSObject
@property(nonatomic, copy, readonly) NSString *normalizedPath;
@property(nonatomic, readonly, getter=isEligible) BOOL eligible;
@property(nonatomic, copy, readonly, nullable) NSString *omissionReason;
@end

@interface DSHProjectContextContentDecision : NSObject
@property(nonatomic, readonly, getter=isEligible) BOOL eligible;
@property(nonatomic, copy, readonly, nullable) NSString *omissionReason;
@end

@interface DSHProjectContextSecretDecision : NSObject
@property(nonatomic, readonly) BOOL suspectedSecret;
@property(nonatomic, copy, readonly, nullable) NSString *omissionReason;
@end

/// Pure chat-read-v1 policy. The instance owns only an ephemeral cursor MAC key.
/// It does not enumerate or read project files and does not persist credentials.
@interface DSHProjectContextPolicy : NSObject

- (DSHProjectContextPathDecision *)decisionForRelativePath:(NSString *)relativePath;
- (DSHProjectContextContentDecision *)decisionForContentData:(NSData *)data;

/// Bounded credential grammar, not arbitrary language parsing. It recognizes
/// scalar identifiers whose final component is an exact credential key or a
/// scoped `_key`/`.key` suffix; constant JSON properties and bounded
/// JavaScript bracket expressions (quoted/backtick keys, comments, supported
/// escapes and assignment operators); and simple XML/plist credential elements or
/// `name`/`value` attributes, including bounded entities, CDATA, and namespaces.
/// Dynamic computed-key assignments fail closed when the whole bounded bracket
/// expression visibly contains a credential-key component. Values are exempt
/// only as complete placeholders.
- (DSHProjectContextSecretDecision *)secretDecisionForData:(NSData *)data;

- (nullable NSString *)encodeCursorForSourceFingerprint:(NSString *)sourceFingerprint
                                                  offset:(NSUInteger)offset
                                                   error:(NSError *_Nullable *_Nullable)error;

- (BOOL)decodeCursor:(NSString *)cursor
    sourceFingerprint:(NSString *)sourceFingerprint
               offset:(NSUInteger *_Nullable)offset
                error:(NSError *_Nullable *_Nullable)error;

/// Filters and pages already-enumerated candidate metadata. Output records contain
/// only path, size, revision, git_state, eligible, and omission_reason.
- (nullable NSDictionary<NSString *, id> *)
    candidatePageForCandidates:(NSArray<NSDictionary<NSString *, id> *> *)candidates
                          query:(NSString *)query
              sourceFingerprint:(NSString *)sourceFingerprint
                         cursor:(nullable NSString *)cursor
                          limit:(NSUInteger)limit
                          error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
