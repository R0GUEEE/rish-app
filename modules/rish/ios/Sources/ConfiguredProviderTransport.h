#import "DSHCompletionProviderTransport.h"
#import "ProviderConfiguration.h"
NS_ASSUME_NONNULL_BEGIN
@interface DSHConfiguredProviderTransport : DSHCompletionProviderTransport
- (instancetype)initWithHarness:(NSString *)harness
                         session:(NSURLSession *)session
                   uuidGenerator:(NSString *(^_Nullable)(void))uuidGenerator
                  monotonicClock:(NSTimeInterval (^_Nullable)(void))clock
                           store:(DSHProviderConfigurationStore *)store;
@end
NS_ASSUME_NONNULL_END
