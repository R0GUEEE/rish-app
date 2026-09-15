#import <Foundation/Foundation.h>
@class DSHAgentRootResolver, DSHRuntimeEnvironmentStore, DSHRuntimeProgramVM;
NS_ASSUME_NONNULL_BEGIN
typedef DSHRuntimeProgramVM *_Nonnull (^DSHRuntimeProgramVMFactory)(void);

@interface DSHRuntimeProgramService : NSObject
+ (instancetype)sharedService;
/// Native-only injection. Production bridge always uses sharedService.
- (instancetype)initWithResolver:(DSHAgentRootResolver *)resolver
                           store:(DSHRuntimeEnvironmentStore *)store
                       vmFactory:(DSHRuntimeProgramVMFactory)factory;
- (nullable NSDictionary *)startRequest:(id)request error:(NSError **)error;
- (nullable NSDictionary *)statusRequest:(id)request error:(NSError **)error;
- (nullable NSDictionary *)stopRequest:(id)request error:(NSError **)error;
- (void)cancelForBackground;
@end
NS_ASSUME_NONNULL_END
