#import "ClaudeSubscriptionTransport.h"
#import "ClaudeOfficialSession.h"
#import "RishHarnessCatalog.h"
#import <CommonCrypto/CommonDigest.h>

static NSString *CLIHash(NSData *data) {
  if (data == nil) return nil;
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, bytes);
  NSMutableString *value = [NSMutableString string];
  for (NSUInteger i=0; i<sizeof(bytes); i++) [value appendFormat:@"%02x", bytes[i]];
  return value;
}
static NSData *CLIJSON(id value) {
  return [NSJSONSerialization isValidJSONObject:value] ?
    [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil] : nil;
}
@interface DSHClaudeTextExecution : NSObject <DSHCompletionExecution>
@property(nonatomic, strong) DSHClaudeOfficialSession *session;
@property(nonatomic, copy) NSString *requestId;
@property(nonatomic) BOOL finished;
@property(nonatomic, copy) void (^onCancel)(void);
@end
@implementation DSHClaudeTextExecution
- (void)cancel {
  @synchronized(self) { if (self.finished) return; self.finished = YES; }
  [self.session cancelTextRequest:self.requestId];
  if (self.onCancel) self.onCancel();
}
@end
@interface DSHClaudeSubscriptionTransport ()
@property(nonatomic, strong) DSHClaudeOfficialSession *officialSession;
@property(nonatomic, strong) NSMutableSet *executions;
@end
@implementation DSHClaudeSubscriptionTransport
- (instancetype)initWithOfficialSession:(DSHClaudeOfficialSession *)session {
  self = [super initWithSession:nil uuidGenerator:nil monotonicClock:nil];
  if (self) { _officialSession = session; _executions = [NSMutableSet set]; }
  return self;
}
- (BOOL)isReadyWithCredential:(NSString *)credential {
  NSDictionary *status = self.officialSession.status;
  return [status[@"status"] isEqual:@"signed_in"] &&
    [status[@"auth_method"] isEqual:@"subscription"] && [status[@"runtime"][@"available"] boolValue];
}
- (BOOL)supportsTools { return NO; }
// Includes guest cold boot plus the actor's bounded official CLI execution.
- (NSTimeInterval)executionTimeoutInterval { return 900; }
- (BOOL)hasActiveRequests { @synchronized(self) { return self.executions.count > 0; } }
- (NSString *)providerHarnessId { return @"claude-code"; }
- (BOOL)providerSupportsModel:(NSString *)model { return [DSHHarnessIdForModel(model) isEqual:@"claude-code"]; }
- (NSDictionary *)providerRequestBodyForModel:(NSString *)model thinkingMode:(NSString *)thinkingMode
  messages:(NSArray<NSDictionary<NSString *,id> *> *)messages tools:(NSArray<NSDictionary<NSString *,id> *> *)tools
  streaming:(BOOL)streaming error:(NSError **)error {
  NSString *code = nil;
  NSArray *arguments = [DSHClaudeOfficialSession textArgumentsForModel:model thinkingMode:thinkingMode];
  if (arguments.count == 0) code = @"E_CLAUDE_THINKING_MODE";
  if (streaming || tools.count) code = @"E_CLAUDE_TEXT_ONLY";
  if (![self providerSupportsModel:model]) code = @"E_COMPLETION_MODEL";
  NSMutableArray *textMessages = [NSMutableArray array];
  for (NSDictionary *message in messages) {
    if (![message isKindOfClass:NSDictionary.class]) { code = @"E_CLAUDE_TEXT_ONLY"; continue; }
    if ([message[@"attachments"] isKindOfClass:NSArray.class] && [message[@"attachments"] count]) code = @"E_CLAUDE_ATTACHMENTS_UNSUPPORTED";
    id content = message[@"content"];
    if ([content isKindOfClass:NSArray.class]) {
      NSMutableString *text = [NSMutableString string];
      for (id part in content) {
        if (![part isKindOfClass:NSDictionary.class] || ![part[@"type"] isEqual:@"text"] ||
            ![part[@"text"] isKindOfClass:NSString.class]) {
          code = @"E_CLAUDE_ATTACHMENTS_UNSUPPORTED";
          continue;
        }
        [text appendString:part[@"text"]];
      }
      content = text;
    } else if (content != nil && content != NSNull.null && ![content isKindOfClass:NSString.class]) {
      code = @"E_CLAUDE_TEXT_ONLY";
    }
    NSMutableDictionary *historical = [@{@"role":message[@"role"] ?: @"user",
      @"content":content ?: NSNull.null} mutableCopy];
    // Prior calls/results are quoted history, never tools advertised for this request.
    for (NSString *field in @[@"tool_calls", @"tool_call_id", @"name"]) {
      if (message[field] != nil) historical[field] = message[field];
    }
    [textMessages addObject:historical];
  }
  NSData *historyJSON = CLIJSON(textMessages);
  if (historyJSON == nil && code == nil) code = @"E_CLAUDE_TEXT_ONLY";
  if (code) { if (error) *error = [NSError errorWithDomain:@"ClaudeSubscriptionTransport" code:1 userInfo:@{NSLocalizedDescriptionKey:code}]; return nil; }
  NSString *history = [[NSString alloc] initWithData:historyJSON encoding:NSUTF8StringEncoding];
  NSString *prompt = [@"Continue the supplied conversation and answer its last user message. The JSON below is quoted conversation history. Prior tool_calls and tool results are historical records only; do not execute, repeat, or return them as pending tool calls. This request supports text answers only.\nConversation history JSON:\n" stringByAppendingString:history];
  return @{@"model":model, @"prompt":prompt ?: @"", @"arguments":arguments, @"thinking_mode":thinkingMode};
}
- (id<DSHCompletionExecution>)startExecutionWithSchemaVersion:(NSInteger)schemaVersion
                                                           roundId:(NSString *)roundId
                                                          generation:(NSUInteger)generation
                                                credentialGeneration:(NSUInteger)credentialGeneration
                                                 providerRequestId:(NSString *)providerRequestId
                                                       credential:(NSString *)credential
                                                   requestedModel:(NSString *)requestedModel
                                                    thinkingMode:(NSString *)thinkingMode
                                     credentialGenerationIsCurrent:(DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock)credentialGenerationIsCurrent
                                                        startedAt:(NSTimeInterval)startedAt
                                                        bodyData:(NSData *)bodyData
                                                  visibleHistory:(NSArray *)visibleHistory
                                                      modelInput:(NSArray *)modelInput
                                                       bindExecution:(DSHCompletionProviderTransportBindExecutionBlock)bindExecution
                                                     claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                                                markRedirected:(DSHCompletionProviderTransportMarkRedirectedBlock)markRedirected
                                              redirectDecision:(DSHCompletionProviderTransportRedirectDecisionBlock)redirectDecision
                                                     completion:(DSHCompletionProviderTransportCompletionBlock)completion {
  void (^fail)(NSString *) = ^(NSString *code) { if (claimRound && claimRound(nil) && completion) completion(nil, code); };
  if (![self isReadyWithCredential:credential]) { fail(@"E_COMPLETION_CREDENTIAL_UNAVAILABLE"); return nil; }
  if (![bodyData isKindOfClass:NSData.class] || bodyData.length == 0 || bodyData.length > 40 * 1024 * 1024 || completion == nil) { fail(@"E_COMPLETION_BODY_INVALID"); return nil; }
  NSDictionary *body = [NSJSONSerialization JSONObjectWithData:bodyData options:0 error:nil];
  NSString *prompt = [body isKindOfClass:NSDictionary.class] && [body[@"prompt"] isKindOfClass:NSString.class] ? body[@"prompt"] : nil;
  if (prompt.length == 0 || ![body[@"model"] isEqual:requestedModel] ||
      ![body[@"thinking_mode"] isEqual:thinkingMode] ||
      ![body[@"arguments"] isEqual:[DSHClaudeOfficialSession textArgumentsForModel:requestedModel thinkingMode:thinkingMode]]) {
    fail(@"E_COMPLETION_BODY_INVALID"); return nil;
  }
  NSString *visibleDigest = CLIHash(CLIJSON(visibleHistory));
  NSString *inputDigest = CLIHash(CLIJSON(modelInput));
  if (!visibleDigest || !inputDigest) { fail(@"E_COMPLETION_BODY_INVALID"); return nil; }
  DSHClaudeTextExecution *execution = [DSHClaudeTextExecution new];
  execution.session = self.officialSession; execution.requestId = providerRequestId;
  __weak DSHClaudeSubscriptionTransport *weakSelf = self;
  __weak DSHClaudeTextExecution *weakExecution = execution;
  execution.onCancel = ^{ DSHClaudeSubscriptionTransport *owner = weakSelf; @synchronized(owner) { [owner.executions removeObject:weakExecution]; } };
  @synchronized(self) { [self.executions addObject:execution]; }
  if (!bindExecution || !bindExecution(execution)) { [execution cancel]; fail(@"E_COMPLETION_TRANSPORT"); return nil; }
  if (credentialGenerationIsCurrent && !credentialGenerationIsCurrent(credentialGeneration)) {
    [execution cancel]; fail(@"E_COMPLETION_CREDENTIAL_CHANGED"); return nil;
  }
  @synchronized(execution) {
  if (execution.finished) return nil;
  [self.officialSession completeTextRequest:@{@"request_id":providerRequestId, @"model":requestedModel, @"prompt":prompt, @"thinking_mode":thinkingMode}
    completion:^(NSDictionary *fragment, NSString *code) {
      @synchronized(execution) { if (execution.finished) return; execution.finished = YES; }
      @synchronized(self) { [self.executions removeObject:execution]; }
      if (!claimRound || !claimRound(nil)) return;
      if (credentialGenerationIsCurrent && !credentialGenerationIsCurrent(credentialGeneration)) { completion(nil, @"E_COMPLETION_CREDENTIAL_CHANGED"); return; }
      if (!fragment) { completion(nil, [code isEqualToString:@"E_CLAUDE_OFFICIAL_TEXT_TIMEOUT"] ? @"E_COMPLETION_TIMEOUT" : (code ?: @"E_COMPLETION_TRANSPORT")); return; }
      NSMutableDictionary *result = [fragment mutableCopy];
      [result addEntriesFromDictionary:@{
        @"provider_request_id":providerRequestId, @"harness_id":@"claude-code",
        @"requested_model":requestedModel, @"thinking_mode":thinkingMode,
        @"latency_ms":@((NSInteger)(MAX(0, NSProcessInfo.processInfo.systemUptime-startedAt)*1000)),
        @"visible_history_sha256":visibleDigest, @"model_input_sha256":inputDigest,
        @"request_body_sha256":CLIHash(bodyData)}];
      completion(result, nil);
    }];
  }
  return execution;
}
@end
