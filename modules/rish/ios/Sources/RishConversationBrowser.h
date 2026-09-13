#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// User-initiated web links. This browser owns no provider authentication state.
@interface RishConversationBrowser : NSObject
+ (nullable NSURL *)URLForRequest:(id)request;
- (void)openRequest:(id)request
        completion:(void (^)(NSString * _Nullable errorCode))completion;
@end

NS_ASSUME_NONNULL_END
