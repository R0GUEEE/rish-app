#import <Foundation/Foundation.h>

#import "CodexProviderTransport.h"
#import "HarnessAuthService.h"

NS_ASSUME_NONNULL_BEGIN

/// Codex's native ChatGPT subscription transport. Authentication is supplied
/// by the shared native auth service; this class never persists credentials.
@interface CodexSubscriptionTransport : CodexProviderTransport

@property(nonatomic, strong, nullable) DSHHarnessAuthService *accountAuth;

- (void)fetchAvailableModels:(void (^)(NSArray<NSDictionary *> *models,
                                        NSString * _Nullable errorCode))completion;

@end

NS_ASSUME_NONNULL_END
