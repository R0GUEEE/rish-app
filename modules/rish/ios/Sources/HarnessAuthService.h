#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Stable native status envelope for official CLI subscription authentication.
/// The service deliberately owns no API key slots and never returns tokens,
/// CLI homes, or process output to React Native. Credential persistence, when
/// reached after official CLI verification, stores bounded auth.json bytes in
/// a separate per-harness device-only Keychain item; no synthetic marker is
/// accepted.
FOUNDATION_EXPORT NSString *const DSHHarnessAuthHarnessCodex;
FOUNDATION_EXPORT NSString *const DSHHarnessAuthHarnessClaudeCode;
FOUNDATION_EXPORT BOOL DSHCodexChatUsesSubscription(void);

@interface DSHHarnessAuthService : NSObject

/// Called after a login, source selection, or logout changes the logical
/// Codex chat credential. Refreshing an access token does not invoke it.
@property(nonatomic, copy, nullable) void (^onCodexChatCredentialChanged)(void);

- (instancetype)initWithBundle:(NSBundle *)bundle;

/// Returns the bounded status envelope described by the LocalRuntime bridge.
- (NSDictionary *)statusForHarnessId:(NSString *)harnessId;

/// Starts only an explicitly supported official CLI login. The current app
/// does not report an executable auth runtime; if a future asset manifest
/// advertises a CLI without the required interactive transport, this returns
/// E_HARNESS_AUTH_INTERACTIVE_UNAVAILABLE.
- (void)startLoginForHarnessId:(NSString *)harnessId
                    completion:(void (^)(NSDictionary *status))completion;

- (void)cancelLoginForHarnessId:(NSString *)harnessId
                      sessionId:(NSString *)sessionId
                     completion:(void (^)(NSDictionary *status))completion;

- (void)logoutForHarnessId:(NSString *)harnessId
                completion:(void (^)(NSDictionary *status))completion;

- (void)presentLoginCodeForHarnessId:(NSString *)harnessId
                           sessionId:(NSString *)sessionId
                              locale:(nullable NSString *)locale
                          completion:(void (^)(NSDictionary *status))completion;

/// Extracts only an official verification origin/path and a bounded user-code
/// token from captured official CLI text. Codex query strings are discarded;
/// Claude retains only its allowlisted OAuth state/PKCE parameters. All other
/// output is intentionally discarded.
+ (NSDictionary *)safeLoginFieldsFromOfficialOutput:(NSString *)output
                                            harnessId:(NSString *)harnessId;
+ (nullable NSString *)pasteableDeviceCode:(NSString *)code;
- (void)authorizationBrowserDidCloseForSession:(NSString *)session;

/// The chat transport's native-only credential source. API-key slots remain
/// owned by the caller and are never read or returned by this service.
- (NSString *)codexChatSource;
- (BOOL)selectCodexChatSource:(NSString *)source error:(NSError **)error;
- (nullable NSDictionary *)codexChatCredential;
- (void)ensureCodexChatCredential:(void (^)(NSDictionary * _Nullable credential,
                                             NSString * _Nullable errorCode))completion;

/// Pure seams used by source tests; these never access Keychain or the network.
+ (nullable NSDictionary *)codexChatCredentialFromAuthJSON:(NSDictionary *)json;
+ (BOOL)codexAccessTokenNeedsRefresh:(NSString *)accessToken now:(NSDate *)now;

@end

NS_ASSUME_NONNULL_END
