#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// completionV2 transport contracts shared between LocalRuntimeModule and the
// native test target. Pure functions only: no I/O, no module state.

extern const NSInteger DSHCompletionV2MaxToolCount;
extern const NSInteger DSHCompletionV2MaxToolNameLength;
extern const NSInteger DSHCompletionV2MaxToolDescriptionLength;
extern const NSInteger DSHCompletionV2MaxToolSchemaBytes;
extern const NSInteger DSHCompletionV2MaxArgumentsBytes;
extern const NSInteger DSHCompletionV2MaxToolCalls;

/// Validates the caller-supplied tool definitions and returns a sanitized
/// array to embed verbatim into the request body under `tools`, or nil with
/// a descriptive *error. Each entry must be a dictionary whose serialized
/// shape carries type "function", a name of [A-Za-z0-9_-]{1,64}, an optional
/// description of at most 1024 characters, and dictionary-shaped parameters
/// that serialize to at most DSHCompletionV2MaxToolSchemaBytes.
NSArray<NSDictionary<NSString *, id> *> * _Nullable DSHCompletionToolsV2FromArray(
    NSArray *tools, NSError **error);

/// Builds the complete request body for a completionV2 call from already
/// validated parts. `messages` must be non-nil; `tools` may be nil or empty
/// and is omitted from the body in that case. Mirrors the v1 body fields
/// (model, stream, thinking, max_tokens, reasoning_effort) so downstream
/// proof and budget logic stay identical.
NSDictionary<NSString *, id> * DSHCompletionRequestBodyV2(
    NSString *model,
    NSString *thinkingMode,
    NSArray<NSDictionary<NSString *, id> *> *messages,
    NSArray<NSDictionary<NSString *, id> *> * _Nullable tools);

/// Parses choices[0] out of a DeepSeek chat-completions payload into:
///
/// {
///   "text": NSString,             // "" when the model returned none
///   "reasoning": NSString,        // "" when absent
///   "finish_reason": NSString,    // verbatim, or "unknown"
///   "tool_calls": NSArray<NSDictionary> // {id, name, arguments} strings
/// }
///
/// Tool-call entries are validated fail-closed: every entry needs a string
/// id (<=128), a string function name (<=128), and string arguments
/// (<= DSHCompletionV2MaxArgumentsBytes). Any missing or malformed piece,
/// empty choices, or more than DSHCompletionV2MaxToolCalls entries returns
/// nil with a descriptive *error instead of a partial result.
NSDictionary<NSString *, id> * _Nullable DSHParseCompletionResponseV2(
    NSDictionary *decoded, NSError **error);

NS_ASSUME_NONNULL_END
