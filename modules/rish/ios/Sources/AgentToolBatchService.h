#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class DSHAgentExecutionLedger;
@class DSHAgentGitToolExecutor;
@class DSHAgentNativeWAL;
@class DSHAgentPreparedAttemptStore;
@class DSHAgentTranscriptStore;
@class DSHAgentWorkspaceToolExecutor;

/// Native-only coordinator for whole-batch preparation and approval binding.
/// Its public-shaped requests/results contain no raw arguments, paths, content,
/// transcript messages, or native rows.
@interface DSHAgentToolBatchService : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                      ledger:(DSHAgentExecutionLedger *)ledger
               preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                 transcripts:(DSHAgentTranscriptStore *)transcripts
           workspaceExecutor:(DSHAgentWorkspaceToolExecutor *)workspaceExecutor
                 gitExecutor:(DSHAgentGitToolExecutor *)gitExecutor
    NS_DESIGNATED_INITIALIZER;

- (nullable NSDictionary *)prepareAgentToolBatchWithRequest:
    (NSDictionary *)request error:(NSError **)error;

/// Verifies a Store-committed decision against the native V2 token and frozen
/// batch.  Operation-result persistence is the durable native binding used by
/// AgentToolExecutionService; this method never opens an effect gate.
- (nullable NSDictionary *)bindAgentApprovalWithRequest:(NSDictionary *)request
                                                   error:(NSError **)error;

@property(nonatomic, strong, readonly) DSHAgentNativeWAL *wal;
@property(nonatomic, strong, readonly) DSHAgentExecutionLedger *ledger;
@property(nonatomic, strong, readonly) DSHAgentPreparedAttemptStore *preparedStore;
@property(nonatomic, strong, readonly) DSHAgentTranscriptStore *transcripts;

@end

@compatibility_alias AgentToolBatchService DSHAgentToolBatchService;

NS_ASSUME_NONNULL_END
