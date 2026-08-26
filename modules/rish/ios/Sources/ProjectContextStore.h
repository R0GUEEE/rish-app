#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const DSHProjectContextStoreErrorDomain;
FOUNDATION_EXPORT const NSUInteger DSHProjectContextStoreDefaultCapacityBytes;

typedef NS_ERROR_ENUM(DSHProjectContextStoreErrorDomain,
                      DSHProjectContextStoreErrorCode) {
  DSHProjectContextStoreErrorInvalidArgument = 1,
  DSHProjectContextStoreErrorUnavailable = 2,
  DSHProjectContextStoreErrorIntegrity = 3,
  DSHProjectContextStoreErrorNotFound = 4,
  DSHProjectContextStoreErrorCapacity = 5,
};

typedef NSDate *_Nonnull (^DSHProjectContextClock)(void);
typedef NSString *_Nonnull (^DSHProjectContextIdentifierGenerator)(void);
typedef id _Nullable (^DSHProjectContextAuthorizedOperation)(
    NSDictionary *snapshot, NSError **error);

@class DSHProjectContextStore;

@interface DSHProjectContextAuthorizationLease : NSObject
@property(nonatomic, copy, readonly) NSDictionary *snapshot;
@end

/// Protected immutable snapshot storage. Snapshot records contain metadata and
/// digests only; raw envelope bytes are stored in a separate immutable file.
@interface DSHProjectContextStore : NSObject

- (instancetype)init;
- (instancetype)initWithRootURL:(nullable NSURL *)rootURL
                    capacityBytes:(NSUInteger)capacityBytes
                            clock:(DSHProjectContextClock)clock
              identifierGenerator:
                  (DSHProjectContextIdentifierGenerator)identifierGenerator
    NS_DESIGNATED_INITIALIZER;

- (BOOL)saveEnvelope:(NSData *)envelope
             manifest:(NSDictionary *)manifest
      sourceDescriptor:(NSDictionary *)sourceDescriptor
           snapshotId:(NSString *)snapshotId
                error:(NSError **)error;

- (BOOL)beginPrepareTransactionWithEnvelope:(NSData *)envelope
                                    manifest:(NSDictionary *)manifest
                             sourceDescriptor:(NSDictionary *)sourceDescriptor
                                  snapshotId:(NSString *)snapshotId
                           activeReferenceKey:(NSString *)activeReferenceKey
                                       error:(NSError **)error;
- (BOOL)abortPrepareTransactionForSnapshotId:(NSString *)snapshotId
                           activeReferenceKey:(NSString *)activeReferenceKey
                                        error:(NSError **)error;
- (nullable NSDictionary *)
    commitPrepareTransactionForSnapshotId:(NSString *)snapshotId
                        activeReferenceKey:(NSString *)activeReferenceKey
                            snapshotDigest:(NSString *)snapshotDigest
                                     error:(NSError **)error;

- (BOOL)saveEnvelope:(NSData *)envelope
             manifest:(NSDictionary *)manifest
      sourceDescriptor:(NSDictionary *)sourceDescriptor
           snapshotId:(NSString *)snapshotId
   activeReferenceKey:(nullable NSString *)activeReferenceKey
                error:(NSError **)error;

/// Returns envelope, manifest, source_descriptor and storage metadata after a
/// strict schema and exact-byte digest check.
- (nullable NSDictionary *)loadSnapshotId:(NSString *)snapshotId
                                     error:(NSError **)error;

- (nullable NSDictionary *)saveConsentForSnapshotId:(NSString *)snapshotId
                                      snapshotDigest:(NSString *)snapshotDigest
                                               error:(NSError **)error;
- (nullable NSDictionary *)loadConsentReceiptId:(NSString *)receiptId
                                           error:(NSError **)error;

- (BOOL)setReferenceKey:(NSString *)referenceKey
              snapshotId:(NSString *)snapshotId
                   error:(NSError **)error;
- (BOOL)clearReferenceKey:(NSString *)referenceKey error:(NSError **)error;
- (BOOL)clearReferenceKeyKeepingSnapshot:(NSString *)referenceKey
                                    error:(NSError **)error;
- (nullable NSString *)snapshotIdForReferenceKey:(NSString *)referenceKey
                                            error:(NSError **)error;
- (BOOL)isSnapshotIdAuthorized:(NSString *)snapshotId
             activeReferenceKey:(nullable NSString *)activeReferenceKey
                          error:(NSError **)error;
- (nullable DSHProjectContextAuthorizationLease *)
    beginAuthorizationForSnapshotId:(NSString *)snapshotId
                  activeReferenceKey:(nullable NSString *)activeReferenceKey
                               error:(NSError **)error;
- (nullable id)completeAuthorizationLease:
                    (DSHProjectContextAuthorizationLease *)authorizationLease
                         activeReferenceKey:(nullable NSString *)activeReferenceKey
                                  operation:
                                      (DSHProjectContextAuthorizedOperation)operation
                                      error:(NSError **)error;
- (void)cancelAuthorizationLease:
    (DSHProjectContextAuthorizationLease *)authorizationLease;

- (BOOL)discardSnapshotId:(NSString *)snapshotId error:(NSError **)error;
- (NSArray<NSURL *> *)fileURLsForSnapshotId:(NSString *)snapshotId
                                      error:(NSError **)error;
- (BOOL)pruneWithProtectedSnapshotId:(nullable NSString *)snapshotId
                                error:(NSError **)error;

@property(nonatomic, strong, readonly) NSURL *rootURL;

@end


NS_ASSUME_NONNULL_END
