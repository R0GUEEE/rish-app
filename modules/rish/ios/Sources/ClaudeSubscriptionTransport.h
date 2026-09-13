#import "DSHCompletionProviderTransport.h"
@class DSHClaudeOfficialSession;
NS_ASSUME_NONNULL_BEGIN
/// Text-only local official CLI transport; never obtains an API credential.
@interface DSHClaudeSubscriptionTransport : DSHCompletionProviderTransport
- (instancetype)initWithOfficialSession:(DSHClaudeOfficialSession *)session;
@end
NS_ASSUME_NONNULL_END
