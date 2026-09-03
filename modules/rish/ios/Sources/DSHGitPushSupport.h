#import <Foundation/Foundation.h>

#include <git2.h>

NS_ASSUME_NONNULL_BEGIN

/// Keychain service shared with the pre-existing git HTTPS credential store.
extern NSString *const DSHGitPushCredentialService;

/// Expiry choices offered by the native credential prompt, in seconds.
typedef NS_ENUM(NSInteger, DSHGitCredentialExpiry) {
  DSHGitCredentialExpiryOneHour = 3600,
  DSHGitCredentialExpiryOneDay = 24 * 3600,
  DSHGitCredentialExpirySevenDays = 7 * 24 * 3600,
};

/// Validated remote URL for clone, set-origin, credential status, and push.
NSURL *_Nullable DSHGitValidatedRemoteURL(id value, NSError **error);

/// Keychain account key for the workspace-scoped credential.
NSString *DSHGitCredentialAccountForScope(NSString *workspaceId,
                                          NSString *host);

/// Reads the credential for (workspaceId, host). Expired items are deleted.
NSDictionary *_Nullable DSHGitCredentialForScope(NSString *workspaceId,
                                                 NSString *host,
                                                 NSError **error);

/// Stores or updates the credential with an absolute expiry.
BOOL DSHGitStoreCredentialForScope(NSString *workspaceId, NSString *host,
                                   NSString *username, NSString *token,
                                   NSInteger expirySeconds, NSError **error);

/// Deletes the workspace-scoped credential for one host.
BOOL DSHGitDeleteCredentialForScope(NSString *workspaceId, NSString *host,
                                    NSError **error);

/// Deletes a legacy v1 host-only credential left behind by older builds.
BOOL DSHGitDeleteLegacyHostCredential(NSString *host, NSError **error);

typedef NS_ENUM(NSInteger, DSHGitPushOutcome) {
  DSHGitPushOutcomeSuccess = 0,
  DSHGitPushOutcomeNonFastForward,
  DSHGitPushOutcomeRejected,
  DSHGitPushOutcomeAuthFailure,
  DSHGitPushOutcomeTimedOut,
  DSHGitPushOutcomeCancelled,
  DSHGitPushOutcomeFailed,
};

/// Cancellation token polled by the bounded push runner.
@interface DSHGitPushCancelToken : NSObject
@property(nonatomic, readonly) BOOL cancelled;
- (void)cancel;
@end

@interface DSHGitPushRequest : NSObject
@property(nonatomic) git_repository *repository;  // borrowed; caller keeps lease
@property(nonatomic, copy) NSString *remoteName;  // origin
@property(nonatomic, copy) NSString *remoteURL;   // validated absolute URL
@property(nonatomic, copy) NSString *host;        // lowercase host
@property(nonatomic, copy) NSString *fullReference;  // refs/heads/<branch>
@property(nonatomic, copy) NSString *branch;
@property(nonatomic, copy) NSString *localOID;
@property(nonatomic, copy, nullable) NSString *username;
@property(nonatomic, copy, nullable) NSString *token;
@property(nonatomic, copy, nullable) NSString *proxyURL;
@property(nonatomic, strong, nullable) DSHGitPushCancelToken *cancelToken;
@property(nonatomic) NSTimeInterval timeout;  // default 60
/// Fires exactly once on the push worker queue with the settled outcome.
@property(nonatomic, copy, nullable) void (^completion)(
    DSHGitPushOutcome outcome, NSString *_Nullable remoteOID);
@end

@interface DSHGitPushResult : NSObject
@property(nonatomic) DSHGitPushOutcome outcome;
@property(nonatomic, copy, nullable) NSString *remoteOID;
@end

/// Runs the push bounded by timeout, polling the cancel token.
DSHGitPushResult *DSHGitPushRun(DSHGitPushRequest *request);

/// Appends a push receipt to the project's native receipt journal.
BOOL DSHGitPushRecordReceipt(int projectDescriptor,
                             NSString *projectId,
                             NSDictionary *receipt,
                             NSError **error);

/// Loads the receipt journal for a project (oldest first).
NSArray<NSDictionary *> *_Nullable DSHGitPushLoadReceipts(
    int projectDescriptor, NSString *projectId, NSError **error);

NS_ASSUME_NONNULL_END
