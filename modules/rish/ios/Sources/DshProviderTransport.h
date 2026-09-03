#import <Foundation/Foundation.h>

#import "DSHCompletionProviderTransport.h"

NS_ASSUME_NONNULL_BEGIN

/// DSH Harness provider transport: the DeepSeek chat-completions dialect
/// (request body, response parsing, SSE parsing, Bearer credential header,
/// model catalog). The credential account DEEPSEEK_API_KEY and the shared
/// completion-slot orchestration stay with the generic runtime; this class
/// only owns what is DeepSeek-specific.
@interface DshProviderTransport : DSHCompletionProviderTransport

@end

NS_ASSUME_NONNULL_END
