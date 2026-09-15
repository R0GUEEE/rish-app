#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
FOUNDATION_EXPORT BOOL DSHAgentIsRuntimeTool(id name);
FOUNDATION_EXPORT NSArray<NSDictionary *> *DSHAgentRuntimeToolDescriptors(void);
FOUNDATION_EXPORT NSDictionary * _Nullable DSHAgentRuntimeContract(NSString *operation,
    id value, NSString * _Nullable name);
FOUNDATION_EXPORT BOOL DSHAgentRuntimeContractValid(NSString *operation, id value);
NS_ASSUME_NONNULL_END
