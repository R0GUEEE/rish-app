#import <Foundation/Foundation.h>
@class DSHRuntimeWorkspaceSnapshot, DSHRuntimeEnvironmentLease;
NS_ASSUME_NONNULL_BEGIN
typedef void (^DSHRuntimeProgramOutput)(NSString *channel, NSData *data);
typedef NSNumber *_Nullable (^DSHRuntimeVMOperation)(void *session, NSError **error);

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
/// Select compatibility settings only for an audited environment's exact disk.
+ (nullable NSArray<NSString *> *)commandForManifest:(NSDictionary *)manifest
                                          entryPath:(NSString *)entryPath
                                               args:(NSArray<NSString *> *)args;
/// Native-only execution budget. Java source includes the JDK compiler;
/// other entry types and language families retain the default budget.
+ (NSUInteger)executionTimeoutMillisecondsForFamily:(NSString *)family
                                            entryPath:(NSString *)entryPath;
/// Shared native-only boot/mount scope. The borrowed session is valid only
/// inside operation, on the calling worker; it must never escape or be used
/// concurrently. This method always frees the session/owner before returning.
- (nullable NSNumber *)performWithLease:(DSHRuntimeEnvironmentLease *)lease
                               snapshot:(DSHRuntimeWorkspaceSnapshot *)snapshot
                              operation:(DSHRuntimeVMOperation)operation
                                  error:(NSError **)error;
@end
NS_ASSUME_NONNULL_END
