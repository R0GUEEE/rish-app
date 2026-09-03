#import <Foundation/Foundation.h>

#import "DSHCompletionProviderTransport.h"

NS_ASSUME_NONNULL_BEGIN

/// Incremental Server-Sent-Events parser for the Anthropic Messages API
/// streaming dialect (message_start / content_block_start /
/// content_block_delta / message_delta / message_stop). Emits the same
/// delta vocabulary as DSHStreamEventParser:
/// {type:"delta", content?, reasoning?, finish_reason?}.
@interface ClaudeStreamEventParser : NSObject <DSHProviderStreamEventParsing>

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

@end

NS_ASSUME_NONNULL_END
