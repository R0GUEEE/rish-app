#import <Foundation/Foundation.h>

#import "DSHCompletionProviderTransport.h"

NS_ASSUME_NONNULL_BEGIN

/// Incremental Server-Sent-Events parser for the Anthropic Messages API
/// streaming dialect (message_start / content_block_start /
/// content_block_delta / message_delta / message_stop). Emits the same
/// delta vocabulary as DSHStreamEventParser:
/// {type:"delta", content?, reasoning?, finish_reason?}.
@interface ClaudeStreamEventParser : NSObject <DSHProviderStreamEventParsing>
/// Identity from `message_start` (message id / model); nil until seen.
@property(nonatomic, copy, readonly, nullable) NSString *streamedResponseId;
@property(nonatomic, copy, readonly, nullable) NSString *streamedModel;

- (nullable NSArray<NSDictionary<NSString *, id> *> *)appendBytes:(const uint8_t *)bytes
                                                             length:(NSUInteger)length
                                                               error:(NSError **)error;

- (nullable NSArray<NSDictionary<NSString *, id> *> *)finish:(NSError **)error;

- (void)reset;

@end

/// Claude Code Harness provider transport. Overrides the DeepSeek dialect
/// hooks of DSHCompletionProviderTransport for the Anthropic Messages API:
/// tool_use/tool_result blocks, extended-thinking mapping, stop-reason
/// mapping, and the anthropic-version header. The shared completion-slot,
/// digest, cancellation, and redirect orchestration is inherited unchanged.
@interface ClaudeProviderTransport : DSHCompletionProviderTransport

/// Provider-specific response identity policy. Claude retains its existing
/// absent-echo / exact-alias / alias-prefixed-snapshot behavior.
- (BOOL)providerReportedModel:(nullable NSString *)reportedModel
        matchesRequestedModel:(NSString *)requestedModel;

@end

/// GLM Harness provider transport: Zhipu serves GLM models over an
/// Anthropic-compatible Messages endpoint, so the whole Claude dialect
/// (blocks, thinking, stop reasons, SSE parser, headers) is reused and only
/// the base URL, the harness identity and the model gates differ. A GLM
/// response must echo the exact requested model, ignoring ASCII case only.
@interface GlmProviderTransport : ClaudeProviderTransport
@property(atomic, copy, nullable) NSString *accountProvider;
@property(atomic, copy, nullable) NSArray<NSString *> *trialAllowedModels;

/// Account-plan endpoints are selected by the native ZCode plan resolver.
/// Manual BIGMODEL_API_KEY requests retain the existing BigModel default;
/// these helpers let LocalRuntime bind a resolved provider explicitly without
/// storing or silently substituting credential material in the transport.
+ (nullable NSURL *)endpointForZCodeProvider:(NSString *)provider;
+ (NSDictionary<NSString *, NSString *> *)headersForZCodeCredential:(NSString *)credential;

@end

NS_ASSUME_NONNULL_END
