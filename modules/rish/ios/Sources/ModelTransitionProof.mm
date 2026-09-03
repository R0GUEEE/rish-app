#import "ModelTransitionProof.h"
#import "RishHarnessCatalog.h"

#import <CommonCrypto/CommonDigest.h>

#include <math.h>

static NSError *DSHModelTransitionError(NSString *message) {
  return [NSError errorWithDomain:@"LocalRuntime.ModelTransition"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static BOOL DSHExactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
  return value.count == keys.count
      && [[NSSet setWithArray:value.allKeys]
          isEqualToSet:[NSSet setWithArray:keys]];
}

static BOOL DSHSupportedTransitionModel(NSString *value) {
  return DSHHarnessIsSupportedModel(value);
}

static BOOL DSHStrictBoolean(id value) {
  return [value isKindOfClass:NSNumber.class]
      && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL DSHBoundedInteger(id value, NSUInteger maximum) {
  if (![value isKindOfClass:NSNumber.class] || DSHStrictBoolean(value)) return NO;
  double number = [value doubleValue];
  return isfinite(number) && number >= 0 && floor(number) == number
      && number <= (double)maximum;
}

static BOOL DSHBoundedText(id value, NSUInteger maximum) {
  return [value isKindOfClass:NSString.class]
      && [(NSString *)value length] > 0
      && [(NSString *)value length] <= maximum;
}

static BOOL DSHLowerHexText(NSString *value, NSUInteger length) {
  if (![value isKindOfClass:NSString.class] || value.length != length) return NO;
  NSCharacterSet *nonHex =
      [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"]
          invertedSet];
  return [value rangeOfCharacterFromSet:nonHex].location == NSNotFound;
}

static NSString *DSHTransitionSHA256(NSString *value) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex =
      [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

NSDictionary<NSString *, id> *DSHValidatedModelTransitionProofRow(
    id value,
    NSString *recordedAt,
    NSError **error) {
  NSArray<NSString *> *keys = @[
    @"conversation_id", @"from_model", @"to_model", @"source",
    @"request_epoch", @"request_state", @"attachment_busy",
    @"draft_image_count", @"history_image_count",
  ];
  if (![value isKindOfClass:NSDictionary.class]
      || !DSHExactKeys((NSDictionary *)value, keys)) {
    if (error != nil) {
      *error = DSHModelTransitionError(
          @"Model transition entry must have the exact supported fields");
    }
    return nil;
  }
  NSDictionary *entry = value;
  NSString *conversationId = [entry[@"conversation_id"]
      isKindOfClass:NSString.class] ? entry[@"conversation_id"] : nil;
  NSString *fromModel = [entry[@"from_model"] isKindOfClass:NSString.class]
      ? entry[@"from_model"] : nil;
  NSString *toModel = [entry[@"to_model"] isKindOfClass:NSString.class]
      ? entry[@"to_model"] : nil;
  NSString *source = [entry[@"source"] isKindOfClass:NSString.class]
      ? entry[@"source"] : nil;
  NSString *requestState = [entry[@"request_state"]
      isKindOfClass:NSString.class] ? entry[@"request_state"] : nil;
  NSData *conversationBytes =
      [conversationId dataUsingEncoding:NSUTF8StringEncoding];
  NSSet *sources = [NSSet setWithArray:@[
    @"composer_picker", @"settings_picker", @"send_image_guard",
  ]];
  BOOL valid = conversationId.length > 0 && conversationId.length <= 256
      && conversationBytes.length > 0 && conversationBytes.length <= 512
      && DSHSupportedTransitionModel(fromModel)
      && DSHSupportedTransitionModel(toModel)
      && ![fromModel isEqualToString:toModel]
      && [sources containsObject:source]
      && ([requestState isEqualToString:@"idle"]
          || [requestState isEqualToString:@"sending"])
      && DSHBoundedInteger(entry[@"request_epoch"], INT32_MAX)
      && DSHStrictBoolean(entry[@"attachment_busy"])
      && DSHBoundedInteger(entry[@"draft_image_count"], 24)
      && DSHBoundedInteger(entry[@"history_image_count"], 100000)
      && [recordedAt isKindOfClass:NSString.class]
      && recordedAt.length > 0 && recordedAt.length <= 64;
  if (!valid) {
    if (error != nil) {
      *error = DSHModelTransitionError(@"Model transition entry is invalid");
    }
    return nil;
  }
  NSString *digest = DSHTransitionSHA256(conversationId);
  if (digest == nil) {
    if (error != nil) {
      *error = DSHModelTransitionError(@"Model transition identifier is invalid");
    }
    return nil;
  }
  return @{
    @"conversation_id_sha256": digest,
    @"from_model": fromModel,
    @"to_model": toModel,
    @"source": source,
    @"request_epoch": entry[@"request_epoch"],
    @"request_state": requestState,
    @"attachment_busy": entry[@"attachment_busy"],
    @"draft_image_count": entry[@"draft_image_count"],
    @"history_image_count": entry[@"history_image_count"],
    @"recorded_at": recordedAt,
  };
}

static BOOL DSHValidPersistedModelTransitionRow(id value) {
  if (![value isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *row = value;
  NSArray<NSString *> *keys = @[
    @"conversation_id_sha256", @"from_model", @"to_model", @"source",
    @"request_epoch", @"request_state", @"attachment_busy",
    @"draft_image_count", @"history_image_count", @"recorded_at",
  ];
  if (!DSHExactKeys(row, keys)) return NO;
  NSString *digest = [row[@"conversation_id_sha256"]
      isKindOfClass:NSString.class] ? row[@"conversation_id_sha256"] : nil;
  if (digest.length != 64) return NO;
  if (!DSHLowerHexText(digest, 64)) return NO;
  NSMutableDictionary *raw = [row mutableCopy];
  raw[@"conversation_id"] = @"persisted-row-validation";
  [raw removeObjectForKey:@"conversation_id_sha256"];
  [raw removeObjectForKey:@"recorded_at"];
  return DSHValidatedModelTransitionProofRow(
      raw, row[@"recorded_at"], nil) != nil;
}

static BOOL DSHValidExistingTransitionTrace(
    id traceValue,
    NSArray<NSDictionary *> **rowsOut) {
  if (![traceValue isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *trace = traceValue;
  NSArray<NSString *> *keys = @[ @"recorded_at", @"entry_count", @"entries" ];
  if (!DSHExactKeys(trace, keys)
      || !DSHBoundedText(trace[@"recorded_at"], 64)
      || ![trace[@"entries"] isKindOfClass:NSArray.class]
      || !DSHBoundedInteger(trace[@"entry_count"],
                            DSHMaximumModelTransitionTraceEntries)) {
    return NO;
  }
  NSArray *entries = trace[@"entries"];
  if (entries.count != [trace[@"entry_count"] unsignedIntegerValue]
      || entries.count > DSHMaximumModelTransitionTraceEntries) {
    return NO;
  }
  for (id row in entries) {
    if (!DSHValidPersistedModelTransitionRow(row)) return NO;
  }
  if (rowsOut != nil) *rowsOut = entries;
  return YES;
}

static BOOL DSHValidAgentToolName(NSString *value) {
  if (![value isKindOfClass:NSString.class] || !DSHBoundedText(value, 64)) {
    return NO;
  }
  NSCharacterSet *invalid =
      [[NSCharacterSet characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
          invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHValidAgentArgumentsDigest(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  if (DSHLowerHexText(value, 64)) return YES;
  return value.length == 13
      && [value hasPrefix:@"sha1:"]
      && DSHLowerHexText([value substringFromIndex:5], 8);
}

static BOOL DSHValidAgentToolTrace(id traceValue) {
  if (![traceValue isKindOfClass:NSDictionary.class]) return NO;
  NSDictionary *trace = traceValue;
  NSArray<NSString *> *keys = @[ @"recorded_at", @"entry_count", @"entries" ];
  if (!DSHExactKeys(trace, keys)
      || !DSHBoundedText(trace[@"recorded_at"], 64)
      || ![trace[@"entries"] isKindOfClass:NSArray.class]
      || !DSHBoundedInteger(trace[@"entry_count"], 32)) {
    return NO;
  }
  NSArray *entries = trace[@"entries"];
  if (entries.count != [trace[@"entry_count"] unsignedIntegerValue]) return NO;
  NSArray<NSString *> *rowKeys = @[
    @"name", @"arguments_sha256", @"outcome", @"recorded_at",
  ];
  NSSet *outcomes = [NSSet setWithArray:@[ @"ok", @"failed", @"denied" ]];
  for (id value in entries) {
    if (![value isKindOfClass:NSDictionary.class]) return NO;
    NSDictionary *row = value;
    NSString *outcome = [row[@"outcome"] isKindOfClass:NSString.class]
        ? row[@"outcome"] : nil;
    if (!DSHExactKeys(row, rowKeys)
        || !DSHValidAgentToolName(row[@"name"])
        || !DSHValidAgentArgumentsDigest(row[@"arguments_sha256"])
        || outcome == nil || ![outcomes containsObject:outcome]
        || !DSHBoundedText(row[@"recorded_at"], 64)) {
      return NO;
    }
  }
  return YES;
}

NSDictionary<NSString *, id> *DSHModelTransitionTraceByAppendingRow(
    id existingTrace,
    NSDictionary<NSString *, id> *row,
    NSString *recordedAt) {
  NSArray<NSDictionary *> *existing = nil;
  if (!DSHValidExistingTransitionTrace(existingTrace, &existing)) existing = @[];
  NSUInteger keep = MIN(existing.count,
                        DSHMaximumModelTransitionTraceEntries - 1);
  NSRange range = NSMakeRange(existing.count - keep, keep);
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray arrayWithCapacity:keep + 1];
  if (keep > 0) [entries addObjectsFromArray:[existing subarrayWithRange:range]];
  [entries addObject:row];
  return @{
    @"recorded_at": recordedAt,
    @"entry_count": @(entries.count),
    @"entries": entries,
  };
}

void DSHPreserveRuntimeProofTraces(
    NSDictionary<NSString *, id> *previous,
    NSMutableDictionary<NSString *, id> *proof) {
  id agentTrace = previous[@"agent_tool_trace"];
  if (DSHValidAgentToolTrace(agentTrace)) {
    proof[@"agent_tool_trace"] = agentTrace;
  }
  id modelTrace = previous[@"model_transition_trace"];
  if (DSHValidExistingTransitionTrace(modelTrace, nil)) {
    proof[@"model_transition_trace"] = modelTrace;
  }
}
