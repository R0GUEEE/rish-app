#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Process-wide view of whether a rish guest session is currently booted.
///
/// LocalGuestModule flips this flag when a session commits or is released;
/// LocalMirrorsModule reads it so its receipt only reports
/// `guest_runtime_mounted = true` while a guest is genuinely live. The flag is
/// strictly in-process: it resets on every app launch and says nothing about
/// whether staged overlay configuration reached the guest (it cannot today).
@interface DSHGuestRuntimeState : NSObject

+ (instancetype)sharedState;

@property(nonatomic, readonly) BOOL guestRuntimeMounted;

- (void)setGuestRuntimeMounted:(BOOL)mounted;

@end

NS_ASSUME_NONNULL_END
