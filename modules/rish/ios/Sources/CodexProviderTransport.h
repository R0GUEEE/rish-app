#import <Foundation/Foundation.h>

#import "DSHCompletionProviderTransport.h"

NS_ASSUME_NONNULL_BEGIN

/// Incremental Server-Sent-Events parser for the OpenAI Responses API
/// streaming dialect (response.output_text.delta,
/// response.reasoning_summary_text.delta,
/// response.function_call_arguments.delta, response.completed). Emits the
/// same delta vocabulary as DSHStreamEventParser:
/// {type:"delta", content?, reasoning?, finish_reason?}.
@interface CodexStreamEventParser : NSObject <DSHProviderStreamEventParsing>

- (nullable NSArray<NSDictionary<NSString *, id> *> *)appendBytes:(const uint8_t *)bytes
                                                             length:(NSUInteger)length
                                                               error:(NSError **)error;

- (nullable NSArray<NSDictionary<NSString *, id> *> *)finish:(NSError **)error;

- (void)reset;

@end

/// Codex Harness provider transport. Overrides the DeepSeek dialect hooks of
/// DSHCompletionProviderTransport for the OpenAI Responses API: function
/// tools, reasoning summaries, status-to-finish mapping, and the gpt-5.6
/// model catalog. The shared completion-slot, digest, cancellation, and
/// redirect orchestration is inherited unchanged.
@interface CodexProviderTransport : DSHCompletionProviderTransport

@end

NS_ASSUME_NONNULL_END
