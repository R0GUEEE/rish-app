#import <Foundation/Foundation.h>
@class DSHRuntimeWorkspaceSnapshot, DSHRuntimeEnvironmentLease;
NS_ASSUME_NONNULL_BEGIN
typedef void (^DSHRuntimeProgramOutput)(NSString *channel, NSData *data);

/// One owner thread boots/executes/frees the VM. cancel only signals its token.
@interface DSHRuntimeProgramVM : NSObject
- (instancetype)initWithBundle:(NSBundle *)bundle;
@property(nonatomic, readonly, getter=isCancelled) BOOL cancelled;
- (void)cancel;
- (nullable NSNumber *)executeLease:(DSHRuntimeEnvironmentLease *)lease
                           snapshot:(DSHRuntimeWorkspaceSnapshot *)snapshot
                          entryPath:(NSString *)entryPath
                               args:(NSArray<NSString *> *)args
                            started:(dispatch_block_t)started
                             output:(DSHRuntimeProgramOutput)output
                              error:(NSError **)error;
/// Native pure command builder, exposed for regression tests only.
+ (nullable NSArray<NSString *> *)commandForFamily:(NSString *)family
                                         entryPath:(NSString *)entryPath
                                              args:(NSArray<NSString *> *)args;
@end
NS_ASSUME_NONNULL_END
