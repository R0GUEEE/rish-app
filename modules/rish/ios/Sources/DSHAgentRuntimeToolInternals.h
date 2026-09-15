#import "DSHAgentRuntimeToolExecutor.h"
#import "AgentNativeWAL.h"
#import "AgentRuntimeToolContracts.h"
#import "AgentRootResolver.h"
#import "RuntimeEnvironmentStore.h"
#import "RuntimeWorkspaceSnapshot.h"
#import "RuntimeProgramServiceVM.h"
#import "RuntimeServiceVM.h"
#import "RuntimeHTTPServer.h"

@interface DSHAgentRuntimeRecord : NSObject
@property(nonatomic, copy) NSString *key;
@property(nonatomic, copy) NSString *identity;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, copy) NSDictionary *owner;
@property(nonatomic, copy) NSDictionary *root;
@property(nonatomic, copy) NSDictionary *arguments;
@property(nonatomic, copy) NSDictionary *precondition;
@property(atomic, copy) DSHAgentRuntimeOwnerValidator validator;
@property(nonatomic, copy) NSDictionary *effect;
@property(nonatomic) BOOL dispatched;
@property(atomic) BOOL durable;
@property(atomic) BOOL cancelled;
@property(atomic) BOOL effectStarted;
@property(nonatomic, strong) DSHRuntimeProgramVM *vm;
@property(nonatomic, copy) NSString *installToken;
@property(nonatomic, strong) NSMutableData *stdoutData;
@property(nonatomic, strong) NSMutableData *stderrData;
@property(nonatomic) BOOL outputTruncated;
@property(nonatomic, copy) NSString *serviceId;
@property(nonatomic, strong) DSHRuntimeHTTPServer *http;
@property(nonatomic, strong) dispatch_group_t serviceDone;
@property(atomic) BOOL serviceReady;
@property(atomic) BOOL serviceFinished;
@property(nonatomic, strong) NSError *serviceError;
@property(nonatomic, strong) NSNumber *serviceExit;
@end

@interface DSHAgentRuntimeToolExecutor ()
@property(nonatomic, strong) DSHAgentRootResolver *resolver;
@property(nonatomic, strong) DSHRuntimeEnvironmentStore *store;
@property(nonatomic, strong) NSMutableDictionary<NSString *, DSHAgentRuntimeRecord *> *records;
@property(nonatomic, strong) NSMutableDictionary<NSString *, DSHAgentRuntimeRecord *> *services;
@property(nonatomic) BOOL backgrounded;
- (BOOL)recordCurrent:(DSHAgentRuntimeRecord *)record execution:(BOOL)execution;
- (void)cancelRecord:(DSHAgentRuntimeRecord *)record;
- (NSDictionary *)descriptorForId:(NSString *)environmentId;
- (DSHRuntimeWorkspaceSnapshot *)snapshotForArguments:(NSDictionary *)arguments root:(NSDictionary *)root error:(NSError **)error;
@end
@interface DSHAgentRuntimeToolExecutor (Effects)
- (NSDictionary *)performRecord:(DSHAgentRuntimeRecord *)record;
@end
@interface DSHAgentRuntimeToolExecutor (ServiceLifecycle)
- (NSDictionary *)performServiceStart:(DSHAgentRuntimeRecord *)record snapshot:(DSHRuntimeWorkspaceSnapshot *)snapshot lease:(DSHRuntimeEnvironmentLease *)lease;
- (NSDictionary *)performServiceStop:(DSHAgentRuntimeRecord *)record;
@end
@interface DSHAgentRuntimeToolExecutor (Feedback)
- (void)captureOutput:(NSData *)bytes channel:(NSString *)channel record:(DSHAgentRuntimeRecord *)record;
@end

FOUNDATION_EXPORT NSString *DSHAgentRuntimeKey(NSDictionary *owner);
FOUNDATION_EXPORT NSString *DSHAgentRuntimeSnapshotSHA(DSHRuntimeWorkspaceSnapshot *snapshot);
FOUNDATION_EXPORT NSDictionary *DSHAgentRuntimeEffect(NSString *name, NSString *outcome, NSDictionary *payload,
    NSDictionary *precondition, BOOL mayHaveOccurred);
FOUNDATION_EXPORT NSDictionary *DSHAgentRuntimeFailure(DSHAgentRuntimeRecord *record, NSString *code,
    NSString *reason, NSNumber *exitCode);
FOUNDATION_EXPORT NSDictionary *DSHAgentRuntimeOutput(DSHAgentRuntimeRecord *record);
