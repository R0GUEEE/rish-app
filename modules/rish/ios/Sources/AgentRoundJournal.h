#import <Foundation/Foundation.h>

#import "AgentNativeWAL.h"

NS_ASSUME_NONNULL_BEGIN

/// The durable provider-round view over DSHAgentNativeWAL. A round is located
/// by task, attempt, round ID, and round index; an execution-row CAS is never
/// reused as round authority.
@interface DSHAgentRoundJournal : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
    NS_DESIGNATED_INITIALIZER;

- (nullable NSDictionary *)createAgentRoundWithInsertCAS:(NSDictionary *)insertCAS
                                         exactRoundStart:(NSDictionary *)round
                                                  error:(NSError **)error;

- (nullable NSDictionary *)claimAgentRoundWithLocator:(NSDictionary *)locator
                                 expectedRowRevision:(NSNumber *)revision
                                  expectedOwnerNull:(BOOL)expectedOwnerNull
                                              owner:(NSDictionary *)owner
                                              error:(NSError **)error;

- (nullable NSDictionary *)casAgentRoundWithCAS:(NSDictionary *)cas
                                          patch:(NSDictionary *)patch
                                          error:(NSError **)error;

- (nullable NSDictionary *)heartbeatAgentRoundWithCAS:(NSDictionary *)cas
                                                owner:(NSDictionary *)owner
                                                error:(NSError **)error;

- (nullable NSDictionary *)markAgentRoundDispatchedWithCAS:(NSDictionary *)cas
                                                      error:(NSError **)error;

- (nullable NSDictionary *)queryAgentRoundWithLocator:(NSDictionary *)locator
                                   expectedTranscript:(NSDictionary *)transcript
                                                  root:(NSDictionary *)root
                                                error:(NSError **)error;

/// Commits provider assistant/tool-call data and the completed round row in
/// one native WAL transaction. `messages` are native-only exact unions; the
/// result contains the row and reference, never the raw transcript.
- (nullable NSDictionary *)completeAgentRoundWithLocator:(NSDictionary *)locator
                                             expectedCAS:(NSDictionary *)cas
                                                messages:(NSArray *)messages
                                    completionReceipt:(NSDictionary *)receipt
                                        terminalKind:(NSString *)terminalKind
                                                calls:(NSArray *)calls
                                                 root:(NSDictionary *)root
                                                error:(NSError **)error;

- (nullable NSDictionary *)markAgentRoundFailedRetryableWithCAS:(NSDictionary *)cas
                                                     failureCode:(NSString *)failureCode
                                                           error:(NSError **)error;

/// Cancellation is proof-gated: in-flight requests first become
/// `cancel_requested`; only persisted `not_dispatched` may reach cancelled.
- (nullable NSDictionary *)cancelAgentRoundWithCAS:(NSDictionary *)cas
                                             error:(NSError **)error;

- (nullable NSDictionary *)reconcileAgentRoundOwnerLossWithLocator:(NSDictionary *)locator
                                                   expectedCAS:(NSDictionary *)cas
                                                        state:(NSString *)state
                                                         error:(NSError **)error;

/// Native schema-3 round view used by AgentProviderRoundService.  These
/// selectors are native-only; no provider body, transcript message, owner,
/// or row is exported through RN.
- (nullable NSDictionary *)createAgentRoundV3WithInsertCAS:(NSDictionary *)insertCAS
                                           exactRoundStart:(NSDictionary *)round
                                                     error:(NSError **)error;
- (nullable NSDictionary *)claimAgentRoundV3WithLocator:(NSDictionary *)locator
                                    expectedRowRevision:(NSNumber *)revision
                                                   owner:(NSDictionary *)owner
                                                     error:(NSError **)error;
- (nullable NSDictionary *)markAgentRoundV3DispatchedWithCAS:(NSDictionary *)cas
                                                        error:(NSError **)error;
- (nullable NSDictionary *)completeAgentRoundV3WithLocator:(NSDictionary *)locator
                                               expectedCAS:(NSDictionary *)cas
                                                  messages:(NSArray *)messages
                                         completionReceipt:(NSDictionary *)receipt
                                              terminalKind:(NSString *)terminalKind
                                                    calls:(NSArray *)calls
                                                     root:(NSDictionary *)root
                                                     error:(NSError **)error;
- (nullable NSDictionary *)cancelAgentRoundV3WithCAS:(NSDictionary *)cas
                                               error:(NSError **)error;
- (nullable NSDictionary *)reconcileAgentRoundV3OwnerLossWithLocator:(NSDictionary *)locator
                                                          expectedCAS:(NSDictionary *)cas
                                                                 error:(NSError **)error;
- (nullable NSDictionary *)queryAgentRoundV3WithLocator:(NSDictionary *)locator
                                                     error:(NSError **)error;

@property(nonatomic, strong, readonly) DSHAgentNativeWAL *wal;

@end

@compatibility_alias AgentRoundJournal DSHAgentRoundJournal;

/// Full persisted-row validator used by WAL bootstrap before any typed view
/// is allowed to read or mutate the row.
FOUNDATION_EXPORT BOOL DSHAgentValidateRoundNativeEntryV2(
    NSDictionary *row,
    NSError **error);

NS_ASSUME_NONNULL_END
