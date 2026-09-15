#import "DSHGuestRuntimeState.h"

@interface DSHGuestVMOwner ()
- (instancetype)initPrivate;
@end
@implementation DSHGuestVMOwner
- (instancetype)initPrivate { return [super init]; }
@end

@implementation DSHGuestRuntimeState {
  BOOL _guestRuntimeMounted;
  DSHGuestVMOwner *_owner;
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
    if (_owner == nil) _guestRuntimeMounted = mounted;
  }
}

- (DSHGuestVMOwner *)acquireGuestOwner {
  @synchronized(self) {
    if (_owner != nil) return nil;
    _owner = [[DSHGuestVMOwner alloc] initPrivate];
    _guestRuntimeMounted = NO;
    return _owner;
  }
}

- (BOOL)setGuestRuntimeMounted:(BOOL)mounted owner:(DSHGuestVMOwner *)owner {
  @synchronized(self) {
    if (owner == nil || owner != _owner) return NO;
    _guestRuntimeMounted = mounted;
    return YES;
  }
}

- (BOOL)releaseGuestOwner:(DSHGuestVMOwner *)owner {
  @synchronized(self) {
    if (owner == nil || owner != _owner) return NO;
    _guestRuntimeMounted = NO;
    _owner = nil;
    return YES;
  }
}

@end
