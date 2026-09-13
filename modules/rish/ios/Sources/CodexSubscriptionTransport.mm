#import "CodexSubscriptionTransport.h"
#import "ProviderConfiguration.h"

static NSString * const CodexSubscriptionErrorDomain = @"CodexSubscriptionTransportError";
static NSUInteger const CodexSubscriptionMaxLineBytes = 262144;
static NSUInteger const CodexSubscriptionMaxEventLines = 64;
static NSUInteger const CodexSubscriptionMaxResponseBytes = 8 * 1024 * 1024;

static NSString *CodexSubscriptionString(id value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static NSError *CodexSubscriptionStableError(NSString *code) {
  return [NSError errorWithDomain:CodexSubscriptionErrorDomain code:0
                         userInfo:@{NSLocalizedDescriptionKey: code}];
}

/// The subscription endpoint sends a Responses SSE stream even though Rish
/// uses the completion transport's single callback. Assemble output items,
/// but release a response only after the successful terminal event.
static NSData *CodexSubscriptionCompletedResponse(NSData *data, NSError **error) {
  if (error != nil) *error = nil;
  if (![data isKindOfClass:NSData.class] || data.length == 0 ||
      data.length > CodexSubscriptionMaxResponseBytes) {
    if (error != nil) *error = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_SIZE");
    return nil;
  }
  NSMutableData *pending = [NSMutableData data];
  NSMutableArray<NSString *> *dataLines = [NSMutableArray array];
  __block NSString *eventName = nil;
  __block NSDictionary *completed = nil;
  __block BOOL sawTerminal = NO;
  __block NSError *parseError = nil;
  NSMutableArray<NSDictionary *> *interimItems = [NSMutableArray array];
  NSMutableDictionary<NSString *, NSDictionary *> *interimByKey = [NSMutableDictionary dictionary];
  NSMutableSet<NSString *> *doneItemKeys = [NSMutableSet set];
  NSMutableSet<NSString *> *knownEvents = [NSMutableSet set];
  __block NSUInteger textPartCount = 0;

  void (^consumeEvent)(void) = ^{
    if (dataLines.count == 0 || parseError != nil) {
      [dataLines removeAllObjects];
      eventName = nil;
      return;
    }
    NSString *joined = [dataLines componentsJoinedByString:@"\n"];
    NSData *json = [joined dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *chunk = json == nil ? nil : [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
    if (chunk == nil || ![chunk isKindOfClass:NSDictionary.class]) {
      parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON");
    } else {
      NSString *kind = CodexSubscriptionString(chunk[@"type"]) ?: eventName;
      if (kind.length > 0) [knownEvents addObject:kind];
      if (eventName.length > 0 && CodexSubscriptionString(chunk[@"type"]) != nil &&
          ![eventName isEqualToString:chunk[@"type"]]) {
        parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON");
      } else
      if ([kind isEqualToString:@"response.failed"] || [kind isEqualToString:@"error"]) {
        parseError = CodexSubscriptionStableError(@"E_COMPLETION_TRANSPORT");
      } else if ([kind isEqualToString:@"response.completed"]) {
        NSDictionary *response = chunk[@"response"];
        if (![response isKindOfClass:NSDictionary.class]) {
          parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON");
        } else if (sawTerminal) {
          parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON");
        } else {
          NSMutableDictionary *merged = [response mutableCopy];
          NSArray *terminalItems = [response[@"output"] isKindOfClass:NSArray.class] ? response[@"output"] : @[];
          NSMutableArray *items = [terminalItems mutableCopy];
          NSMutableDictionary<NSString *, NSDictionary *> *terminalByKey = [NSMutableDictionary dictionary];
          for (NSDictionary *item in terminalItems) {
            if (![item isKindOfClass:NSDictionary.class]) continue;
            NSString *key = CodexSubscriptionString(item[@"id"]);
            if (key.length == 0 && item[@"output_index"] != nil) key = [item[@"output_index"] description];
            if (key.length > 0) terminalByKey[key] = item;
          }
          if (terminalItems.count == 0 && interimItems.count > 0) {
            [items addObjectsFromArray:interimItems];
          } else {
            for (NSString *key in interimByKey) {
              NSDictionary *interim = interimByKey[key];
              NSDictionary *terminal = terminalByKey[key];
              if (terminal != nil && ![terminal isEqual:interim]) {
                parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON");
                break;
              }
              if (terminal == nil) [items addObject:interim];
            }
          }
          if (parseError == nil) {
            merged[@"output"] = [items copy];
            completed = [merged copy];
          }
          sawTerminal = YES;
        }
      } else if ([kind isEqualToString:@"response.output_item.done"] ||
                 [kind isEqualToString:@"response.output_item.added"]) {
        NSDictionary *item = [chunk[@"item"] isKindOfClass:NSDictionary.class] ? chunk[@"item"] : nil;
        if (item != nil) {
          NSString *key = CodexSubscriptionString(item[@"id"]);
          if (key.length == 0 && chunk[@"output_index"] != nil) key = [chunk[@"output_index"] description];
          if (key.length > 0) {
            NSDictionary *old = interimByKey[key];
            if ([kind isEqualToString:@"response.output_item.done"] && [doneItemKeys containsObject:key]) {
              if (old != nil && ![old isEqual:item]) parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON");
            } else if (old == nil) {
              interimByKey[key] = item;
              [interimItems addObject:item];
              if ([kind isEqualToString:@"response.output_item.done"]) [doneItemKeys addObject:key];
            } else if ([kind isEqualToString:@"response.output_item.done"]) {
              interimByKey[key] = item;
              NSUInteger itemIndex = [interimItems indexOfObjectIdenticalTo:old];
              if (itemIndex != NSNotFound) interimItems[itemIndex] = item;
              [doneItemKeys addObject:key];
            }
          }
        }
        for (NSDictionary *content in [item[@"content"] isKindOfClass:NSArray.class] ? item[@"content"] : @[]) {
          if ([CodexSubscriptionString(content[@"type"]) isEqualToString:@"output_text"]) textPartCount += 1;
        }
      }
    }
    [dataLines removeAllObjects];
    eventName = nil;
  };

  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  for (NSUInteger index = 0; index < data.length && parseError == nil; index++) {
    [pending appendBytes:bytes + index length:1];
    if (bytes[index] != '\n') {
      if (pending.length > CodexSubscriptionMaxLineBytes) {
      parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_SIZE");
      }
      continue;
    }
    NSUInteger lineLength = pending.length - 1;
    NSData *lineData = [pending subdataWithRange:NSMakeRange(0, lineLength)];
    NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
    [pending setLength:0];
    if (line == nil) { parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON"); continue; }
    if ([line hasSuffix:@"\r"]) line = [line substringToIndex:line.length - 1];
    if (line.length == 0) { consumeEvent(); continue; }
    if ([line hasPrefix:@":"]) continue;
    if ([line hasPrefix:@"event:"]) {
      eventName = [line substringFromIndex:6];
      if ([eventName hasPrefix:@" "]) eventName = [eventName substringFromIndex:1];
    } else if ([line hasPrefix:@"data:"]) {
      if (dataLines.count >= CodexSubscriptionMaxEventLines) {
        parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_SIZE");
      } else {
        NSString *payload = [line substringFromIndex:5];
        if ([payload hasPrefix:@" "]) payload = [payload substringFromIndex:1];
        [dataLines addObject:payload];
      }
    }
  }
  if (parseError != nil) {
    if (error != nil) *error = parseError;
    return nil;
  }
  if (completed != nil && [completed[@"output"] count] == 0) {
    NSLog(@"rish_codex_subscription parse events=%lu output_count=%lu item_count=%lu textparts=%lu",
          (unsigned long)knownEvents.count, (unsigned long)[completed[@"output"] count],
          (unsigned long)interimItems.count, (unsigned long)textPartCount);
  }
  if (pending.length > 0) {
    NSString *line = [[NSString alloc] initWithData:pending encoding:NSUTF8StringEncoding];
    if (line == nil) { parseError = CodexSubscriptionStableError(@"E_COMPLETION_RESPONSE_JSON"); }
    else if (line.length > 0) {
      if ([line hasSuffix:@"\r"]) line = [line substringToIndex:line.length - 1];
      if ([line hasPrefix:@"data:"]) {
        NSString *payload = [line substringFromIndex:5];
        if ([payload hasPrefix:@" "]) payload = [payload substringFromIndex:1];
        [dataLines addObject:payload];
      } else {
        parseError = CodexSubscriptionStableError(@"E_COMPLETION_EMPTY_RESPONSE");
      }
    }
  }
  if (dataLines.count > 0) parseError = CodexSubscriptionStableError(@"E_COMPLETION_EMPTY_RESPONSE");
  if (parseError == nil && !sawTerminal) parseError = CodexSubscriptionStableError(@"E_COMPLETION_EMPTY_RESPONSE");
  if (parseError != nil) {
    if (error != nil) *error = parseError;
    return nil;
  }
  return [NSJSONSerialization dataWithJSONObject:completed options:0 error:nil];
}

@interface CodexModelProbeRedirectBlocker : NSObject <NSURLSessionTaskDelegate>
@end
@implementation CodexModelProbeRedirectBlocker
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler { completionHandler(nil); }
@end

@interface CodexSubscriptionTransport ()
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSArray<NSDictionary *> *> *modelCache;
@end
@implementation CodexSubscriptionTransport

/// This transport already streams and re-assembles the ChatGPT SSE body in
/// its own buffered request; the shared streaming round path must not
/// double-handle it.
- (BOOL)providerSupportsStreamingRounds {
  return NO;
}

- (void)fetchAvailableModels:(void (^)(NSArray<NSDictionary *> *, NSString *))completion {
  DSHHarnessAuthService *auth = self.accountAuth;
  if (auth == nil) { if (completion) completion(@[], @"E_COMPLETION_CREDENTIAL_UNAVAILABLE"); return; }
  [auth ensureCodexChatCredential:^(NSDictionary *record, NSString *errorCode) {
    NSString *token = CodexSubscriptionString(record[@"access_token"]);
    NSString *accountId = CodexSubscriptionString(record[@"account_id"]);
    if (errorCode.length || token.length == 0 || accountId.length == 0) {
      if (completion) completion(@[], errorCode.length ? errorCode : @"E_COMPLETION_CREDENTIAL_UNAVAILABLE");
      return;
    }
    @synchronized (self) {
      NSArray *cached = self.modelCache[accountId];
      if (cached != nil) { if (completion) completion(cached, nil); return; }
      if (self.modelCache == nil) self.modelCache = [NSMutableDictionary dictionary];
    }
    NSDictionary *headers = [self providerHeadersWithCredential:token];
    if (![headers[@"ChatGPT-Account-ID"] isEqualToString:accountId]) {
      if (completion) completion(@[], @"E_COMPLETION_CREDENTIAL_CHANGED");
      return;
    }
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.HTTPShouldSetCookies = NO;
  configuration.HTTPCookieStorage = nil;
  configuration.timeoutIntervalForRequest = 15;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:[CodexModelProbeRedirectBlocker new] delegateQueue:nil];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://chatgpt.com/backend-api/codex/models?client_version=0.153.4"]];
  request.allHTTPHeaderFields = headers;
  request.HTTPMethod = @"GET";
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  [[session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class] ? [(NSHTTPURLResponse *)response statusCode] : 0;
    if (error != nil || status < 200 || status >= 300 || data.length == 0 || data.length > 1024 * 1024) {
      if (completion) completion(@[], status == 401 || status == 403 ? @"E_COMPLETION_CREDENTIAL_UNAVAILABLE" : @"E_COMPLETION_HTTP_STATUS");
      [session finishTasksAndInvalidate];
      return;
    }
    id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    NSArray *rows = [object isKindOfClass:NSDictionary.class] && [object[@"models"] isKindOfClass:NSArray.class] ? object[@"models"] : ([object isKindOfClass:NSArray.class] ? object : nil);
    if (rows == nil) {
      if (completion) completion(@[], @"E_COMPLETION_RESPONSE_JSON");
      [session finishTasksAndInvalidate];
      return;
    }
    NSMutableArray *models = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."] invertedSet];
    for (id row in rows) {
      NSDictionary *entry = [row isKindOfClass:NSDictionary.class] ? row : nil;
      NSString *slug = CodexSubscriptionString(entry[@"slug"]);
      NSString *visibility = CodexSubscriptionString(entry[@"visibility"]).lowercaseString;
      if ([entry[@"excluded"] boolValue] || [visibility isEqualToString:@"hidden"] || [visibility isEqualToString:@"excluded"]) continue;
      if (slug.length > 0 && slug.length <= 80 && [slug rangeOfCharacterFromSet:invalid].location == NSNotFound && ![seen containsObject:slug] && models.count < 64) {
        [seen addObject:slug];
        NSString *name = CodexSubscriptionString(entry[@"display_name"]) ?: slug;
        [models addObject:@{ @"id": slug, @"name": name }];
      }
    }
    @synchronized (self) {
      if (self.modelCache == nil) self.modelCache = [NSMutableDictionary dictionary];
      if ([self.accountAuth.codexChatCredential[@"account_id"] isEqualToString:accountId]) self.modelCache[accountId] = [models copy];
    }
    NSLog(@"rish_codex_subscription catalog_http=%ld models=%@", (long)status, [[models valueForKey:@"id"] componentsJoinedByString:@","]);
    NSDictionary *current = [self.accountAuth codexChatCredential];
    if (![current[@"account_id"] isEqualToString:accountId] ||
        ![current[@"access_token"] isEqualToString:token]) {
      if (completion) completion(@[], @"E_COMPLETION_CREDENTIAL_CHANGED");
    } else if (completion) {
      completion([models copy], nil);
    }
    [session finishTasksAndInvalidate];
  }] resume];
  }];
}

- (NSString *)providerErrorCodeForHTTPStatus:(NSInteger)statusCode data:(NSData *)data {
  id value = data.length <= 1024 * 1024 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  NSDictionary *root = [value isKindOfClass:NSDictionary.class] ? value : nil;
  NSDictionary *error = [root[@"error"] isKindOfClass:NSDictionary.class] ? root[@"error"] : root;
  NSString *message = CodexSubscriptionString(error[@"message"]) ?: CodexSubscriptionString(root[@"detail"]) ?: CodexSubscriptionString(root[@"error"]);
  NSString *lower = message.lowercaseString;
  NSString *category = @"unknown";
  for (NSString *known in @[@"model", @"instructions", @"stream", @"max_output_tokens", @"reasoning", @"tools", @"originator", @"quota", @"rate limit", @"token", @"permission", @"input"]) {
    if ([lower containsString:known]) { category = known; break; }
  }
  NSLog(@"rish_codex_subscription http=%ld category=%@ bytes=%lu", (long)statusCode, category, (unsigned long)data.length);
  return [super providerErrorCodeForHTTPStatus:statusCode data:data];
}

- (NSURL *)providerBaseURL {
  return [NSURL URLWithString:@"https://chatgpt.com/backend-api/codex/responses"];
}

- (NSDictionary *)providerConfigurationForModel:(NSString *)model {
  return DSHProviderBindingForModel(model);
}

- (NSDictionary<NSString *, NSString *> *)providerHeadersWithCredential:(NSString *)credential {
  NSMutableDictionary *headers = [@{
    @"Content-Type": @"application/json",
    @"Accept": @"text/event-stream",
    @"Authorization": [@"Bearer " stringByAppendingString:credential ?: @""],
    @"User-Agent": @"Rish",
    @"originator": @"rish",
  } mutableCopy];
  NSString *accountId = nil;
  if (self.accountAuth != nil) {
    NSDictionary *record = [self.accountAuth codexChatCredential];
    if ([record isKindOfClass:NSDictionary.class] &&
        [record[@"access_token"] isKindOfClass:NSString.class] &&
        [record[@"access_token"] isEqualToString:credential]) {
      accountId = CodexSubscriptionString(record[@"account_id"]);
    }
  }
  if (accountId.length == 0) return @{};
  headers[@"ChatGPT-Account-ID"] = accountId;
  return headers;
}

- (NSDictionary<NSString *, id> *)providerRequestBodyForModel:(NSString *)model
                                                  thinkingMode:(NSString *)thinkingMode
                                                      messages:(NSArray<NSDictionary<NSString *, id> *> *)messages
                                                         tools:(NSArray<NSDictionary<NSString *, id> *> *)tools
                                                     streaming:(BOOL)streaming
                                                         error:(NSError **)error {
  NSDictionary *base = [super providerRequestBodyForModel:model thinkingMode:thinkingMode
                                                  messages:messages tools:tools streaming:YES error:error];
  if (base == nil) return nil;
  NSMutableDictionary *body = [base mutableCopy];
  body[@"stream"] = @YES;
  body[@"store"] = @NO;
  [body removeObjectForKey:@"max_output_tokens"];
  if (body[@"instructions"] == nil) body[@"instructions"] = @"";
  return [body copy];
}

- (NSDictionary<NSString *, id> *)providerParseResponseData:(NSData *)data
                                               requestedModel:(NSString *)requestedModel
                                                 thinkingMode:(NSString *)thinkingMode
                                                       error:(NSError **)error {
  NSData *response = CodexSubscriptionCompletedResponse(data, error);
  if (response == nil) return nil;
  return [super providerParseResponseData:response requestedModel:requestedModel
                              thinkingMode:thinkingMode error:error];
}

- (NSURLSessionDataTask *)startRequestWithSchemaVersion:(NSInteger)schemaVersion
                                                  roundId:(NSString *)roundId
                                                 generation:(NSUInteger)generation
                                       credentialGeneration:(NSUInteger)credentialGeneration
                                        providerRequestId:(NSString *)providerRequestId
                                              credential:(NSString *)credential
                                          requestedModel:(NSString *)requestedModel
                                           thinkingMode:(NSString *)thinkingMode
                            credentialGenerationIsCurrent:(DSHCompletionProviderTransportCredentialGenerationIsCurrentBlock)current
                                               startedAt:(NSTimeInterval)startedAt
                                                 bodyData:(NSData *)bodyData
                                            visibleHistory:(NSArray *)visibleHistory
                                                modelInput:(NSArray *)modelInput
                                                 bindTask:(DSHCompletionProviderTransportBindTaskBlock)bindTask
                                               claimRound:(DSHCompletionProviderTransportClaimRoundBlock)claimRound
                                            markRedirected:(DSHCompletionProviderTransportMarkRedirectedBlock)markRedirected
                                           redirectDecision:(DSHCompletionProviderTransportRedirectDecisionBlock)redirectDecision
                                                completion:(DSHCompletionProviderTransportCompletionBlock)completion {
  DSHHarnessAuthService *auth = self.accountAuth;
  __block NSURLSessionDataTask *startedTask = nil;
  void (^start)(NSDictionary *, NSString *) = ^(NSDictionary *record, NSString *failure) {
    if (failure.length > 0 || ![record isKindOfClass:NSDictionary.class]) {
      if (claimRound != nil && claimRound(nil) && completion != nil)
        completion(nil, failure.length > 0 ? failure : @"E_COMPLETION_CREDENTIAL_UNAVAILABLE");
      return;
    }
    NSString *token = CodexSubscriptionString(record[@"access_token"]);
    NSString *accountId = CodexSubscriptionString(record[@"account_id"]);
    if (token.length == 0 || accountId.length == 0) {
      if (claimRound != nil && claimRound(nil) && completion != nil)
        completion(nil, @"E_COMPLETION_CREDENTIAL_UNAVAILABLE");
      return;
    }
    BOOL generationCurrent = YES;
    @try {
      generationCurrent = current == nil || current(credentialGeneration);
    } @catch (__unused NSException *exception) {
      generationCurrent = NO;
    }
    if (!generationCurrent) {
      if (claimRound != nil && claimRound(nil) && completion != nil)
        completion(nil, @"E_COMPLETION_CREDENTIAL_CHANGED");
      return;
    }
    startedTask = [super startRequestWithSchemaVersion:schemaVersion roundId:roundId generation:generation
                     credentialGeneration:credentialGeneration providerRequestId:providerRequestId
                               credential:token requestedModel:requestedModel thinkingMode:thinkingMode
              credentialGenerationIsCurrent:current startedAt:startedAt bodyData:bodyData
                           visibleHistory:visibleHistory modelInput:modelInput bindTask:bindTask
                               claimRound:claimRound markRedirected:markRedirected
                          redirectDecision:redirectDecision completion:completion];
  };
  if (auth != nil) [auth ensureCodexChatCredential:^(NSDictionary *credentialRecord, NSString *errorCode) {
    start(credentialRecord, errorCode);
  }];
  else start(nil, @"E_COMPLETION_CREDENTIAL_UNAVAILABLE");
  return startedTask;
}

@end
