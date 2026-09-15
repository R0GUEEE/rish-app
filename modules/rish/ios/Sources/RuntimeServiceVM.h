#import "RuntimeProgramServiceVM.h"

NS_ASSUME_NONNULL_BEGIN
FOUNDATION_EXPORT const NSUInteger DSHRuntimeServiceMaxRequestBytes;
FOUNDATION_EXPORT const NSUInteger DSHRuntimeServiceMaxResponseBytes;
typedef void (^DSHRuntimeServiceHTTPCompletion)(NSData *_Nullable response, NSError *_Nullable error);
typedef void (^DSHRuntimeServiceReady)(NSData *probeResponse);

/// Language-independent HTTP service in an owned disposable guest. The host
/// validates HTTP/origin policy and owns its loopback listener; this class
/// forwards bounded raw bytes to the fixed guest loopback port using that same
/// VM's serial worker. It neither installs packages nor accepts a host path.
@interface DSHRuntimeServiceVM : DSHRuntimeProgramVM
/// Blocking worker scope. ready supplies the first raw guest HTTP response;
/// the host must validate its framing before publishing a loopback URL.
/// Return follows actual VM teardown. Cancellation frees the whole guest,
/// including its detached server/descendants and bounded log collectors.
- (nullable NSNumber *)serveLease:(DSHRuntimeEnvironmentLease *)lease
                         snapshot:(DSHRuntimeWorkspaceSnapshot *)snapshot
                        entryPath:(NSString *)entryPath
                             args:(NSArray<NSString *> *)args
                        guestPort:(NSUInteger)guestPort
                            ready:(DSHRuntimeServiceReady)ready
                           output:(DSHRuntimeProgramOutput)output
                            error:(NSError **)error;
/// Thread-safe enqueue; completion is outside locks, after the serial worker
/// has collected raw stdout bytes. The host must send Connection: close and
/// validate the returned HTTP framing before forwarding it to a browser.
- (void)requestHTTP:(NSData *)request completion:(DSHRuntimeServiceHTTPCompletion)completion;
@end
NS_ASSUME_NONNULL_END
