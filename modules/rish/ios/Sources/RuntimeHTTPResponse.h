#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
FOUNDATION_EXPORT NSData *_Nullable DSHRuntimeValidateHTTPResponse(
    NSData *response, NSString *method, NSError **error);
FOUNDATION_EXPORT BOOL DSHRuntimeHTTPToken(NSString *value);
FOUNDATION_EXPORT BOOL DSHRuntimeHTTPHeaderLine(NSString *line,
    NSString *_Nullable *_Nullable name, NSString *_Nullable *_Nullable value);
FOUNDATION_EXPORT NSUInteger DSHRuntimeHTTPHeaderEnd(NSData *data);
NS_ASSUME_NONNULL_END
