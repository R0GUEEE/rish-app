#import <Foundation/Foundation.h>

#import "LocalProjectAccess.h"
#import "ProjectContextPolicy.h"
#import "ProjectContextStore.h"

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const DSHProjectContextServiceErrorDomain;

typedef NS_ERROR_ENUM(DSHProjectContextServiceErrorDomain,
                      DSHProjectContextServiceErrorCode) {
  DSHProjectContextServiceErrorInvalidArgument = 1,
  DSHProjectContextServiceErrorProjectUnavailable = 2,
  DSHProjectContextServiceErrorChanged = 3,
  DSHProjectContextServiceErrorSecret = 4,
  DSHProjectContextServiceErrorBudgetExceeded = 5,
  DSHProjectContextServiceErrorStorage = 6,
  DSHProjectContextServiceErrorTimeout = 7,
  DSHProjectContextServiceErrorConsent = 8,
  DSHProjectContextServiceErrorIntegrity = 9,
  DSHProjectContextServiceErrorSnapshotMissing = 10,
};

typedef void (^DSHProjectContextServiceHook)(NSString *stage,
                                              NSString *_Nullable relativePath);

@interface DSHProjectContextService : NSObject

- (instancetype)init;
- (instancetype)initWithProjectAccess:(DSHLocalProjectAccess *)projectAccess
                                  store:(DSHProjectContextStore *)store
                                 policy:(DSHProjectContextPolicy *)policy
                                  clock:(DSHProjectContextClock)clock
                    identifierGenerator:
                        (DSHProjectContextIdentifierGenerator)identifierGenerator
                                   hook:(nullable DSHProjectContextServiceHook)hook
    NS_DESIGNATED_INITIALIZER;

- (nullable NSDictionary *)listCandidatesForProjectId:(NSString *)projectId
                                                  query:(NSString *)query
                                                 cursor:(nullable NSString *)cursor
                                                  error:(NSError **)error;
- (nullable NSDictionary *)prepareSelection:(NSDictionary *)selection
                                       error:(NSError **)error;
- (nullable NSDictionary *)confirmSnapshotId:(NSString *)snapshotId
                                        error:(NSError **)error;
- (nullable NSDictionary *)inspectSnapshotId:(NSString *)snapshotId
                                        error:(NSError **)error;
- (BOOL)discardSnapshotId:(NSString *)snapshotId error:(NSError **)error;
- (nullable NSData *)verifiedEnvelopeForSnapshotId:(NSString *)snapshotId
                                   consentReceiptId:(NSString *)consentReceiptId
                                        requestBind:(NSDictionary *)requestBind
                                            receipt:
                                                (NSDictionary *_Nullable *_Nullable)receipt
                                              error:(NSError **)error;

@end

/// One process-wide composition root. All production bridge instances share
/// its project access, protected store, policy cursor key, clock, and ids.
FOUNDATION_EXPORT DSHProjectContextService *DSHSharedProjectContextService(void);

NS_ASSUME_NONNULL_END
