#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class RishZCodeAccountAuthService;

typedef NSURLSessionDataTask *_Nullable (^RishZCodePlanRequest)(NSURLRequest *, void (^)(NSHTTPURLResponse *_Nullable response, NSData *_Nullable data, NSError *_Nullable error));

/// Resolves the existing ZCode coding-plan API key for an authenticated
/// account. It never creates keys, purchases plans, reads desktop credentials,
/// or exposes the resolved secret in status/results crossing the bridge.
@interface RishZCodePlanResolver : NSObject

- (instancetype)initWithAccountAuth:(RishZCodeAccountAuthService *)accountAuth
                             request:(RishZCodePlanRequest)request
                               clock:(NSTimeInterval (^)(void))clock;

/// Native-only result contains `credential`, `provider`, `endpoint_url`, and
/// `credential_source`; callers must keep it native-private. The resolver
/// returns an error when no existing coding-plan key is available.
- (void)resolveCodingPlanForProvider:(NSString *)provider
                          completion:(void (^)(NSDictionary *_Nullable result,
                                               NSError *_Nullable error))completion;

/// Resolves the explicitly separate ZCode trial entitlement. The result uses
/// the authenticated ZCode JWT and the trial Anthropic endpoint; it never
/// falls back to a paid plan or a manual API key.
- (void)resolveTrialForProvider:(NSString *)provider
                     completion:(void (^)(NSDictionary *_Nullable result,
                                          NSError *_Nullable error))completion;

/// Safe projection for UI/status. It contains account label and plan state,
/// never an API key, OAuth token, organization/project secret, or response.
- (NSDictionary *)statusForProvider:(NSString *)provider;

@end

/// Device-only credential selection. The manual GLM key is never overwritten.
@interface RishGlmCredentialSelection : NSObject
- (instancetype)init;
- (nullable NSString *)source;
- (nullable NSArray<NSString *> *)allowedModels;
- (nullable NSString *)credentialWithAccountAuth:(RishZCodeAccountAuthService *)auth;
- (BOOL)selectAPIKey:(NSError **)error;
- (BOOL)selectProviderPending:(NSString *)provider error:(NSError **)error;
- (BOOL)selectTrialPending:(NSString *)provider error:(NSError **)error;
- (BOOL)selectPlan:(NSDictionary *)plan account:(NSDictionary *)account error:(NSError **)error;
- (void)clearCredentialForProvider:(NSString *)provider;
@end

NS_ASSUME_NONNULL_END
