#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/// A bounded stream to an application-owned temporary file. No response body is retained in memory.
@interface DSHRuntimeEnvironmentDownload : NSObject
// Native transport test injection; production uses an ephemeral configuration.
- (instancetype)initWithConfiguration:(NSURLSessionConfiguration *)configuration;
- (void)startURL:(NSString *)url destination:(NSURL *)destination expectedBytes:(nullable NSNumber *)expectedBytes
       progress:(void (^)(uint64_t downloaded, NSNumber *_Nullable total))progress
     completion:(void (^)(NSError *_Nullable error))completion;
- (void)cancel;
@end
NS_ASSUME_NONNULL_END
