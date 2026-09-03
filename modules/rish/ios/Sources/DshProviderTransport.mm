#import "DshProviderTransport.h"

#import "DSHCompletionV2.h"
#import "DSHStreamEvents.h"
#import "RishHarnessCatalog.h"

static NSString * const DSHCompletionTransportErrorDomain = @"DSHCompletionTransportError";

@implementation DshProviderTransport

#pragma mark Provider hooks (DeepSeek dialect)

- (NSURL *)providerBaseURL {
  return [NSURL URLWithString:@"https://api.deepseek.com/chat/completions"];
}

- (NSDictionary<NSString *, NSString *> *)providerHeadersWithCredential:(NSString *)credential {
  return @{
    @"Content-Type": @"application/json",
    @"Authorization": [@"Bearer " stringByAppendingString:credential],
  };
}

- (NSDictionary<NSString *, id> *)providerRequestBodyForModel:(NSString *)model
                                                 thinkingMode:(NSString *)thinkingMode
                                                     messages:(NSArray<NSDictionary<NSString *, id> *> *)messages
                                                        tools:(NSArray<NSDictionary<NSString *, id> *> *)tools
                                                    streaming:(BOOL)streaming
                                                        error:(NSError **)error {
  if (error != nil) *error = nil;
  NSDictionary *body = DSHCompletionRequestBodyV2(
      model, thinkingMode, messages, tools);
  if (body == nil) return nil;
  NSMutableDictionary *bodyCopy = [body mutableCopy];
  bodyCopy[@"stream"] = @(streaming);
  return [bodyCopy copy];
}

- (NSDictionary<NSString *, id> *)providerParseResponseData:(NSData *)data
                                              requestedModel:(NSString *)requestedModel
                                                thinkingMode:(NSString *)thinkingMode
                                                      error:(NSError **)error {
  if (error != nil) *error = nil;
  NSError *decodeError = nil;
  NSDictionary *decoded = [NSJSONSerialization
      JSONObjectWithData:data options:0 error:&decodeError];
  if (![decoded isKindOfClass:NSDictionary.class]) {
    if (error != nil) {
      *error = [NSError errorWithDomain:DSHCompletionTransportErrorDomain
                                   code:2102
                               userInfo:@{NSLocalizedDescriptionKey:
                                   @"E_COMPLETION_RESPONSE_JSON"}];
    }
    return nil;
  }
  return DSHParseCompletionResponseSchema2(decoded, requestedModel,
                                            thinkingMode, error);
}

- (id<DSHProviderStreamEventParsing>)providerNewStreamEventParser {
  return [[DSHStreamEventParser alloc] init];
}

- (BOOL)providerSupportsModel:(NSString *)model {
  return [DSHHarnessIdForModel(model) isEqualToString:@"dsh"];
}

- (NSTimeInterval)providerTimeoutIntervalForStreaming:(BOOL)streaming {
  return streaming ? 120 : 90;
}

- (NSString *)providerHarnessId {
  return @"dsh";
}
@end
