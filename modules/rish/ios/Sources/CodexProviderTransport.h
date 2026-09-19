#import <Foundation/Foundation.h>

#import "DSHCompletionProviderTransport.h"
#import "DSHStreamEvents.h"

NS_ASSUME_NONNULL_BEGIN

/// The OpenAI Responses streaming dialect. The reading is the shared core's
/// (`wire: responses`); this names the wire and keeps this transport's own
/// error codes, 3301..3308. The identity comes from `response.created` /
/// `response.completed` and the emitted vocabulary is the one every parser
/// here emits: {type:"delta", content?, reasoning?, tool_calls?,
/// finish_reason?} and {type:"done"}.
@interface CodexStreamEventParser : DSHStreamEventParser
@end

/// Codex Harness provider transport. Overrides the DeepSeek dialect hooks of
/// DSHCompletionProviderTransport for the OpenAI Responses API: function
/// tools, reasoning summaries, status-to-finish mapping, and the gpt-5.6
/// model catalog. The shared completion-slot, digest, cancellation, and
/// redirect orchestration is inherited unchanged.
@interface CodexProviderTransport : DSHCompletionProviderTransport

@end

NS_ASSUME_NONNULL_END
