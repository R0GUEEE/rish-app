#import <Foundation/Foundation.h>

#import "AgentNativeWAL.h"
#import "AgentPreparedAttemptStore.h"
#import "AgentRoundJournal.h"
#import "AgentTranscriptStore.h"
#import "DSHCompletionProviderTransport.h"

NS_ASSUME_NONNULL_BEGIN

/// Native-only credential/history/body providers.  They are injected by the
/// existing LocalRuntime owner; none of these values are part of the RN
/// request or any service result. The credential provider receives the
/// harness id from the round request so the generic runtime can key the
/// Keychain slot (DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY).
typedef NSString * _Nullable (^DSHAgentProviderRoundCredentialProvider)(
    NSString *harnessId, NSUInteger *generation);
typedef NSArray<NSDictionary *> * _Nullable (^DSHAgentProviderRoundVisibleHistoryProvider)(
    NSDictionary *authority, NSError **error);
typedef NSDictionary * _Nullable (^DSHAgentProviderRoundContextReceiptProvider)(
    NSDictionary *authority, NSError **error);

/// For schema-3 rounds the callback returns exactly
/// `{project_context_sha256,receipt:{...},messages:[{role:"system",content,attachments:[]}]}`.
/// The digest is compared with the frozen authority before model input is
/// built. Context bytes/text are native-only model input; only the redacted
/// receipt appears in the completed public result.

/// Native-only coordinator for one transactional provider round.  The
/// request/result seam is intentionally not exported through React Native:
/// callers provide only frozen authority assertions and receive redacted
/// receipts/projections.  Provider arguments and transcript messages stay in
/// native stores.
@interface DSHAgentProviderRoundService : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
               preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                  transcripts:(DSHAgentTranscriptStore *)transcripts
                       rounds:(DSHAgentRoundJournal *)rounds
                    transport:(DSHCompletionProviderTransport *)transport;

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                   transcripts:(DSHAgentTranscriptStore *)transcripts
                        rounds:(DSHAgentRoundJournal *)rounds
                     transport:(DSHCompletionProviderTransport *)transport
          credentialProvider:(nullable DSHAgentProviderRoundCredentialProvider)credentialProvider
       visibleHistoryProvider:(nullable DSHAgentProviderRoundVisibleHistoryProvider)visibleHistoryProvider;

- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                   transcripts:(DSHAgentTranscriptStore *)transcripts
                        rounds:(DSHAgentRoundJournal *)rounds
                     transport:(DSHCompletionProviderTransport *)transport
          credentialProvider:(nullable DSHAgentProviderRoundCredentialProvider)credentialProvider
       visibleHistoryProvider:(nullable DSHAgentProviderRoundVisibleHistoryProvider)visibleHistoryProvider
       contextReceiptProvider:(nullable DSHAgentProviderRoundContextReceiptProvider)contextReceiptProvider
    NS_DESIGNATED_INITIALIZER;

/// Provider-agnostic coordinator entry point. `transport` remains the DSH
/// transport for legacy callers and tests; `claudeTransport` and
/// `codexTransport` serve the other two builtin harnesses. A request for a
/// harness whose transport is nil fails closed as unavailable.
- (instancetype)initWithWAL:(DSHAgentNativeWAL *)wal
                preparedStore:(DSHAgentPreparedAttemptStore *)preparedStore
                   transcripts:(DSHAgentTranscriptStore *)transcripts
                        rounds:(DSHAgentRoundJournal *)rounds
                     transport:(DSHCompletionProviderTransport *)transport
              claudeTransport:(nullable DSHCompletionProviderTransport *)claudeTransport
               codexTransport:(nullable DSHCompletionProviderTransport *)codexTransport
          credentialProvider:(nullable DSHAgentProviderRoundCredentialProvider)credentialProvider
       visibleHistoryProvider:(nullable DSHAgentProviderRoundVisibleHistoryProvider)visibleHistoryProvider
       contextReceiptProvider:(nullable DSHAgentProviderRoundContextReceiptProvider)contextReceiptProvider;

/// Synchronously composes one native round around the asynchronous provider
/// transport.  The blocking wait is confined to this native-private helper;
/// the future RN facade should invoke it off the main thread.
- (nullable NSDictionary *)completeAgentRoundV2WithRequest:(NSDictionary *)request
                                                     error:(NSError **)error;

/// Reopens only an existing `failed_retryable` row.  The locator and
/// expected row revision remain frozen; native claim increments the persisted
/// launch attempt and installs a fresh owner before the shared transport is
/// dispatched.  This never takes the insert-if-absent path.
- (nullable NSDictionary *)retryFailedAgentRoundV2WithRequest:(NSDictionary *)request
                                                         error:(NSError **)error;

- (nullable NSDictionary *)queryAgentRoundWithRequest:(NSDictionary *)request
                                                error:(NSError **)error;
- (nullable NSDictionary *)recoverAgentRoundWithRequest:(NSDictionary *)request
                                                   error:(NSError **)error;
- (nullable NSDictionary *)cancelAgentRoundWithRequest:(NSDictionary *)request
                                                  error:(NSError **)error;

@property(nonatomic, strong, readonly) DSHAgentNativeWAL *wal;
@property(nonatomic, strong, readonly) DSHAgentPreparedAttemptStore *preparedStore;
@property(nonatomic, strong, readonly) DSHAgentTranscriptStore *transcripts;
@property(nonatomic, strong, readonly) DSHAgentRoundJournal *rounds;
@property(nonatomic, strong, readonly) DSHCompletionProviderTransport *transport;
@property(nonatomic, strong, readonly, nullable) DSHCompletionProviderTransport *claudeTransport;
@property(nonatomic, strong, readonly, nullable) DSHCompletionProviderTransport *codexTransport;

/// Selects the transport for the request's harness_id (defaults to dsh).
- (nullable DSHCompletionProviderTransport *)transportForRequest:(NSDictionary *)request;

@end

@compatibility_alias AgentProviderRoundService DSHAgentProviderRoundService;

NS_ASSUME_NONNULL_END
