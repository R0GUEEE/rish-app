#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Native-only ownership hooks used by the completion transport.  The
/// transport deliberately does not keep a credential store, create an
/// NSURLSession, or own the LocalRuntime completion slot.  A caller supplies
/// the already-shared slot operations so schema 2, schema 3, and the future
/// provider-round service cannot accidentally grow a second cancellation
/// registry.
typedef BOOL (^DSHCompletionProviderTransportBindTaskBlock)(NSURLSessionDataTask *task);
typedef BOOL (^DSHCompletionProviderTransportClaimRoundBlock)(BOOL * _Nullable redirected);
typedef BOOL (^DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock)(
    NSUInteger credentialGeneration);
typedef void (^DSHCompletionProviderTransportMarkRedirectedBlock)(NSURLSessionDataTask *task);
typedef void (^DSHCompletionProviderTransportRedirectDecisionBlock)(BOOL rejected);

/// Completion carries only a sanitized provider result or a stable,
/// value-free error code.  Provider response bodies, request bytes, and
/// credentials never cross this seam.
typedef void (^DSHCompletionProviderTransportCompletionBlock)(
    NSDictionary<NSString *, id> * _Nullable result,
    NSString * _Nullable errorCode);

/// Private shared DeepSeek HTTP transport for strict completion schema 2/3.
///
/// The injected NSURLSession is the module's one session and is not owned by
/// this object.  Likewise, credential material is accepted per request and
/// never persisted here.  Ownership and generation checks remain in the
/// caller's existing completion slot via the callbacks above.
@interface DSHCompletionProviderTransport : NSObject

- (instancetype)initWithSession:(NSURLSession *)session
                   uuidGenerator:(NSString *(^ _Nullable)(void))uuidGenerator
                  monotonicClock:(NSTimeInterval (^ _Nullable)(void))monotonicClock;

/// Mints the provider correlation id after the caller has reserved its
/// completion slot.  The id is intentionally separate from the RN round id.
- (NSString * _Nullable)nextProviderRequestId:(NSString * _Nullable * _Nullable)errorCode;

/// Creates and starts one POST request once the caller has reserved its
/// shared slot.  `visibleHistory` and `modelInput` are already validated
/// native projections; the transport computes their canonical digests and
/// the exact request-body digest for the result.
/// `credentialGenerationIsCurrent` must consult the caller's existing
/// generation counter; it never reads or stores credential material.
///
/// A nil return means no task was started.  In that case `completion` is
/// still called when an owner callback is available, so a caller can settle
/// its already-reserved slot without leaking it.
- (NSURLSessionDataTask * _Nullable)startRequestWithSchemaVersion:(NSInteger)schemaVersion
                                                           roundId:(NSString *)roundId
                                                          generation:(NSUInteger)generation
                                                credentialGeneration:(NSUInteger)credentialGeneration
                                                 providerRequestId:(NSString *)providerRequestId
                                                       credential:(NSString *)credential
                                                   requestedModel:(NSString *)requestedModel
                                                    thinkingMode:(NSString *)thinkingMode
                                     credentialGenerationIsCurrent:(DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock _Nullable)credentialGenerationIsCurrent
                                                        startedAt:(NSTimeInterval)startedAt
                                                        bodyData:(NSData *)bodyData
                                                  visibleHistory:(NSArray *)visibleHistory
                                                      modelInput:(NSArray *)modelInput
                                                       bindTask:(DSHCompletionProviderTransportBindTaskBlock)bindTask
                                                     claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                                                markRedirected:(DSHCompletionProviderTransportMarkRedirectedBlock _Nullable)markRedirected
                                              redirectDecision:(DSHCompletionProviderTransportRedirectDecisionBlock _Nullable)redirectDecision
                                                     completion:(DSHCompletionProviderTransportCompletionBlock)completion;

/// Returns whether this transport currently owns the task identifier.  The
/// module's NSURLSession delegate uses this to route only strict redirects to
/// this transport; legacy and streaming tasks keep their existing path.
- (BOOL)handlesTask:(NSURLSessionTask *)task;

/// Cancels a task and releases only its transport routing context.  The
/// caller still owns the shared completion slot and settles its promise;
/// this method never invokes a completion callback itself.  Tasks belonging
/// to legacy/streaming paths are simply cancelled.
- (void)cancelTask:(NSURLSessionDataTask *)task;

/// Rejects a redirect for an owned strict request without following the
/// destination.  Unknown tasks are followed unchanged by the caller's
/// existing delegate path.
- (void)handleHTTPRedirectionForTask:(NSURLSessionTask *)task
                          newRequest:(NSURLRequest *)request
                   completionHandler:(void (^)(NSURLRequest * _Nullable))completionHandler;

@end

NS_ASSUME_NONNULL_END
