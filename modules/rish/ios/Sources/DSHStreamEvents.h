#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Incremental Server-Sent-Events parser for DeepSeek streaming chunks.
// Pure state machine: feed it raw bytes as they arrive, receive parsed
// deltas. No I/O, no transport — fully unit-testable.

extern const NSInteger DSHStreamMaxLineBytes;
extern const NSInteger DSHStreamMaxBufferedLines;

/// Error domain for all parser errors (2101 invalid UTF-8, 2102 not a JSON
/// object, 2103 already finished, 2104 oversized line, 2105 too many lines).
extern NSString * const DSHStreamEventErrorDomain;

/// A parsed streaming delta emitted to JS.
typedef NSDictionary<NSString *, id> DSHStreamDelta;

@interface DSHStreamEventParser : NSObject

/// Feed raw chunk bytes. Returns the deltas decoded from complete SSE
/// events, or nil with *error on malformed/oversized input.
- (nullable NSArray<DSHStreamDelta *> *)appendBytes:(const uint8_t *)bytes
                                             length:(NSUInteger)length
                                               error:(NSError **)error;

/// Flush any complete-but-unfed lines at stream end (a trailing event
/// without its blank-line terminator is tolerated once).
- (nullable NSArray<DSHStreamDelta *> *)finish:(NSError **)error;

/// Resets to a clean state for reuse.
- (void)reset;

@end

NS_ASSUME_NONNULL_END
