#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class DSHAgentExecutionLedger;
@class DSHAgentGitToolExecutor;
@class DSHAgentNativeWAL;
@class DSHAgentPreparedAttemptStore;
@class DSHAgentTranscriptStore;
@class DSHAgentWorkspaceToolExecutor;

/// The sole native protected call protocol: validate -> claim -> dispatch ->
/// one effect -> operation-specific reconciliation -> ledger/transcript settle.
@interface DSHAgentToolExecutionService : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                      ledger:(DSHAgentExecutionLedger *)ledger
               preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                 transcripts:(DSHAgentTranscriptStore *)transcripts
           workspaceExecutor:(DSHAgentWorkspaceToolExecutor *)workspaceExecutor
                 gitExecutor:(DSHAgentGitToolExecutor *)gitExecutor
    NS_DESIGNATED_INITIALIZER;

- (nullable NSDictionary *)executeAgentToolWithRequest:(NSDictionary *)request
                                                   error:(NSError **)error;

/// Reconciles one existing full-locator ledger row.  It never dispatches a new
/// effect and returns only a safe tool projection/result.
- (nullable NSDictionary *)recoverAgentToolWithRequest:(NSDictionary *)request
                                                   error:(NSError **)error;

@end

@compatibility_alias AgentToolExecutionService DSHAgentToolExecutionService;

NS_ASSUME_NONNULL_END
