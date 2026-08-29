#import "DSHGuestRuntimeState.h"

@implementation DSHGuestRuntimeState {
  BOOL _guestRuntimeMounted;
}

+ (instancetype)sharedState {
  static DSHGuestRuntimeState *state = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    state = [[DSHGuestRuntimeState alloc] init];
  });
  return state;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _guestRuntimeMounted = NO;
  }
  return self;
}

- (BOOL)guestRuntimeMounted {
  @synchronized(self) {
    return _guestRuntimeMounted;
  }
}

- (void)setGuestRuntimeMounted:(BOOL)mounted {
  @synchronized(self) {
    _guestRuntimeMounted = mounted;
  }
}

@end
