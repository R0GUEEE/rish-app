#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NSURLSessionDataTask *_Nullable (^RishZCodeRequest)(NSURLRequest *, void (^)(NSHTTPURLResponse *_Nullable, NSData *_Nullable, NSError *_Nullable));
typedef NSData *_Nullable (^RishZCodeRead)(NSString *, NSError **);
typedef BOOL (^RishZCodeWrite)(NSString *, NSData *_Nullable, NSError **);

/// ZCode account OAuth only. This is not official CLI authentication or a
/// manual GLM API-key slot. Secret fields never appear in public status.
@interface RishZCodeAccountAuthService : NSObject
@property(nonatomic, copy, nullable) void (^onAccountConnected)(NSString *provider);
- (instancetype)init;
- (instancetype)initWithRequest:(RishZCodeRequest)request
                           read:(RishZCodeRead)read
                          write:(RishZCodeWrite)write
                          clock:(NSTimeInterval (^)(void))clock;
+ (BOOL)isProvider:(id)provider;
+ (BOOL)isSafeAuthorizeURL:(NSString *)url provider:(NSString *)provider;
- (NSDictionary *)statusForProvider:(NSString *)provider;
- (void)startForProvider:(NSString *)provider completion:(void (^)(NSDictionary *))completion;
- (void)cancelForProvider:(NSString *)provider completion:(void (^)(NSDictionary *))completion;
- (void)logoutForProvider:(NSString *)provider completion:(void (^)(NSDictionary *))completion;
/// Native-only account material for later entitlement/credential resolution.
- (nullable NSDictionary *)nativeCredentialForProvider:(NSString *)provider error:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
