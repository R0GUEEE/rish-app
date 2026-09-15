#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^DSHRuntimeHTTPCompletion)(NSData *_Nullable response, NSError *_Nullable error);
typedef void (^DSHRuntimeHTTPRequestHandler)(NSData *request, DSHRuntimeHTTPCompletion completion);

/// Bounded HTTP/1.1 loopback bridge to an actual running guest application.
/// The handler receives the original method, origin-form target, headers and
/// binary body, with Connection: close. No application response is synthesized.
@interface DSHRuntimeHTTPServer : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithRequestHandler:(DSHRuntimeHTTPRequestHandler)handler
    NS_DESIGNATED_INITIALIZER;
- (BOOL)startWithError:(NSError **)error;
@property(nonatomic, copy, readonly, nullable) NSURL *url;
- (void)stop;

/// Validates a complete raw HTTP response (including chunk framing). Returns
/// nil on malformed or oversized data; otherwise forces Connection: close
/// while preserving real status, binary payload and repeated response headers.
+ (nullable NSData *)validateResponse:(NSData *)response
                       requestMethod:(NSString *)method
                               error:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
