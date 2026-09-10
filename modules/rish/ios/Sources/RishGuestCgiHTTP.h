#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Strict, bounded HTTP/1.1 request used by the experimental loopback bridge.
@interface RishGuestHttpRequest : NSObject
@property(nonatomic, copy) NSString *method;
@property(nonatomic, copy) NSString *path;
@property(nonatomic, copy) NSDictionary<NSString *, NSString *> *headers;
@property(nonatomic, copy) NSData *body;
@end

FOUNDATION_EXPORT NSUInteger const RishGuestHttpMaxHeaderBytes;
FOUNDATION_EXPORT NSUInteger const RishGuestHttpMaxBodyBytes;

/// Parses exactly one request. It rejects transfer encoding, duplicate or
/// non-decimal Content-Length, malformed header names, and trailing bytes.
FOUNDATION_EXPORT BOOL RishParseGuestHttpRequest(NSData *data,
                                                  RishGuestHttpRequest * _Nullable * _Nullable request,
                                                  NSString * _Nullable * _Nullable errorMessage);

NS_ASSUME_NONNULL_END
