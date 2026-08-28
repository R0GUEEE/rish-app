#import <XCTest/XCTest.h>

// The host application keeps its symbol table for simulator builds, so the
// completionV2 helpers resolve from the linked pod like every other native
// symbol.
#import "../../../../modules/rish/ios/Sources/DSHCompletionV2.h"
#import "../../../../modules/rish/ios/Sources/ModelTransitionProof.h"

@interface CompletionV2Tests : XCTestCase
@end

@implementation CompletionV2Tests

#pragma mark - Redacted model transition proof

- (NSDictionary *)validModelTransition {
  return @{
    @"conversation_id": @"conversation-opaque-123",
    @"from_model": @"deepseek-v4-flash",
    @"to_model": @"deepseek-v4-pro",
    @"source": @"composer_picker",
    @"request_epoch": @7,
    @"request_state": @"idle",
    @"attachment_busy": @NO,
    @"draft_image_count": @0,
    @"history_image_count": @1,
  };
}

- (void)testModelTransitionProofRedactsConversationAndHasExactPersistedKeys {
  NSError *error = nil;
  NSDictionary *row = DSHValidatedModelTransitionProofRow(
      [self validModelTransition], @"2026-08-28T00:00:00.000Z", &error);
  XCTAssertNil(error);
  XCTAssertNotNil(row);
  NSSet *actualKeys = [NSSet setWithArray:row.allKeys];
  NSArray *expectedKeyList = @[
    @"conversation_id_sha256", @"from_model", @"to_model", @"source",
    @"request_epoch", @"request_state", @"attachment_busy",
    @"draft_image_count", @"history_image_count", @"recorded_at",
  ];
  NSSet *expectedKeys = [NSSet setWithArray:expectedKeyList];
  XCTAssertEqualObjects(actualKeys, expectedKeys);
  NSString *digest = row[@"conversation_id_sha256"];
  XCTAssertEqual(digest.length, 64u);
  XCTAssertNotEqualObjects(digest, @"conversation-opaque-123");
  NSRange digestRange = [digest rangeOfString:@"^[0-9a-f]{64}$"
                                      options:NSRegularExpressionSearch];
  XCTAssertNotEqual(digestRange.location, NSNotFound);
  XCTAssertFalse([[row description] containsString:@"conversation-opaque-123"]);
}

- (void)testModelTransitionProofRejectsUnknownMissingAndMalformedFields {
  NSMutableDictionary *extra = [[self validModelTransition] mutableCopy];
  extra[@"message"] = @"must never cross the boundary";
  NSError *error = nil;
  XCTAssertNil(DSHValidatedModelTransitionProofRow(
      extra, @"2026-08-28T00:00:00.000Z", &error));
  XCTAssertNotNil(error);

  NSMutableDictionary *missing = [[self validModelTransition] mutableCopy];
  [missing removeObjectForKey:@"source"];
  error = nil;
  XCTAssertNil(DSHValidatedModelTransitionProofRow(
      missing, @"2026-08-28T00:00:00.000Z", &error));

  // React Native may bridge an integral JS number through an NSNumber whose
  // storage is floating-point; mathematical integers remain valid.
  NSMutableDictionary *bridgedInteger = [[self validModelTransition] mutableCopy];
  bridgedInteger[@"request_epoch"] = @1.0;
  error = nil;
  XCTAssertNotNil(DSHValidatedModelTransitionProofRow(
      bridgedInteger, @"2026-08-28T00:00:00.000Z", &error));
  XCTAssertNil(error);

  NSArray<NSDictionary *> *invalid = @[
    @{ @"source": @"attachment_result" },
    @{ @"from_model": @"unknown-model" },
    @{ @"to_model": @"unknown-model" },
    @{ @"request_state": @"complete" },
    @{ @"request_epoch": @YES },
    @{ @"request_epoch": @1.5 },
    @{ @"request_epoch": @2147483648LL },
    @{ @"attachment_busy": @1 },
    @{ @"draft_image_count": @25 },
    @{ @"history_image_count": @100001 },
    @{ @"conversation_id": [@"x" stringByPaddingToLength:257
                                                 withString:@"x"
                                            startingAtIndex:0] },
  ];
  for (NSDictionary *patch in invalid) {
    NSMutableDictionary *entry = [[self validModelTransition] mutableCopy];
    [entry addEntriesFromDictionary:patch];
    error = nil;
    XCTAssertNil(DSHValidatedModelTransitionProofRow(
        entry, @"2026-08-28T00:00:00.000Z", &error), @"%@", patch);
    XCTAssertNotNil(error);
  }
}

- (void)testModelTransitionTraceIsBoundedAndSurvivesBaseProofRewrites {
  NSError *error = nil;
  NSDictionary *row = DSHValidatedModelTransitionProofRow(
      [self validModelTransition], @"2026-08-28T00:00:00.000Z", &error);
  XCTAssertNotNil(row);
  NSDictionary *trace = nil;
  for (NSUInteger index = 0;
       index < DSHMaximumModelTransitionTraceEntries + 4;
       index += 1) {
    trace = DSHModelTransitionTraceByAppendingRow(
        trace, row, @"2026-08-28T00:00:00.000Z");
  }
  NSArray *entries = trace[@"entries"];
  XCTAssertEqual(entries.count, DSHMaximumModelTransitionTraceEntries);
  XCTAssertEqualObjects(trace[@"entry_count"],
                        @(DSHMaximumModelTransitionTraceEntries));
  NSSet *traceKeys = [NSSet setWithArray:trace.allKeys];
  NSSet *expectedTraceKeys = [NSSet setWithArray:
      @[ @"recorded_at", @"entry_count", @"entries" ]];
  XCTAssertEqualObjects(traceKeys, expectedTraceKeys);

  NSDictionary *agent = @{
    @"recorded_at": @"2026-08-28T00:00:00.000Z",
    @"entry_count": @1,
    @"entries": @[ @{
      @"name": @"read_file",
      @"arguments_sha256": @"sha1:0123abcd",
      @"outcome": @"ok",
      @"recorded_at": @"2026-08-28T00:00:00.000Z",
    } ],
  };
  NSMutableDictionary *rewritten = [@{ @"schema_version": @2 } mutableCopy];
  DSHPreserveRuntimeProofTraces(
      @{ @"agent_tool_trace": agent, @"model_transition_trace": trace },
      rewritten);
  XCTAssertEqualObjects(rewritten[@"agent_tool_trace"], agent);
  XCTAssertEqualObjects(rewritten[@"model_transition_trace"], trace);

  NSDictionary *emptyModelTrace = @{
    @"recorded_at": @"2026-08-28T00:00:00.000Z",
    @"entry_count": @0,
    @"entries": @[],
  };
  NSMutableDictionary *emptyRewrite = [NSMutableDictionary dictionary];
  DSHPreserveRuntimeProofTraces(
      @{ @"model_transition_trace": emptyModelTrace }, emptyRewrite);
  XCTAssertEqualObjects(emptyRewrite[@"model_transition_trace"],
                        emptyModelTrace);

  NSMutableDictionary *unsafeAgent = [agent mutableCopy];
  unsafeAgent[@"message"] = @"raw content must not survive";
  NSMutableDictionary *unsafeRewrite = [NSMutableDictionary dictionary];
  DSHPreserveRuntimeProofTraces(
      @{ @"agent_tool_trace": unsafeAgent }, unsafeRewrite);
  XCTAssertNil(unsafeRewrite[@"agent_tool_trace"]);

  NSMutableDictionary *unsafeDigestAgent = [agent mutableCopy];
  unsafeDigestAgent[@"entries"] = @[ @{
    @"name": @"read_file",
    @"arguments_sha256": @"raw/path/or/message",
    @"outcome": @"ok",
    @"recorded_at": @"2026-08-28T00:00:00.000Z",
  } ];
  NSMutableDictionary *unsafeDigestRewrite = [NSMutableDictionary dictionary];
  DSHPreserveRuntimeProofTraces(
      @{ @"agent_tool_trace": unsafeDigestAgent }, unsafeDigestRewrite);
  XCTAssertNil(unsafeDigestRewrite[@"agent_tool_trace"]);

  NSMutableDictionary *oversizedTrace = [trace mutableCopy];
  oversizedTrace[@"recorded_at"] =
      [@"x" stringByPaddingToLength:65 withString:@"x" startingAtIndex:0];
  NSMutableDictionary *oversizedRewrite = [NSMutableDictionary dictionary];
  DSHPreserveRuntimeProofTraces(
      @{ @"model_transition_trace": oversizedTrace }, oversizedRewrite);
  XCTAssertNil(oversizedRewrite[@"model_transition_trace"]);
}

#pragma mark - Tools validation

- (NSDictionary *)validTool {
  return @{
    @"type": @"function",
    @"name": @"git_commit",
    @"description": @"Commit staged work",
    @"parameters": @{@"type": @"object", @"properties": @{}},
  };
}

- (void)testAcceptsAWellFormedToolAndPreservesFields {
  NSError *error = nil;
  NSArray *tools = DSHCompletionToolsV2FromArray(@[ [self validTool] ], &error);
  XCTAssertNil(error);
  XCTAssertEqual(tools.count, 1u);
  XCTAssertEqualObjects(
      tools.firstObject[@"function"][@"name"], @"git_commit");
  XCTAssertEqualObjects(tools.firstObject[@"type"], @"function");
}

- (void)testOmittedToolTypeDefaultsToFunction {
  NSError *error = nil;
  NSMutableDictionary *tool = [[self validTool] mutableCopy];
  [tool removeObjectForKey:@"type"];
  NSArray *tools = DSHCompletionToolsV2FromArray(@[ tool ], &error);
  XCTAssertNil(error);
  XCTAssertEqualObjects(tools.firstObject[@"type"], @"function");
}

- (void)testRejectsMoreThanTheMaximumToolCount {
  NSMutableArray *tools = [NSMutableArray array];
  for (NSUInteger i = 0; i < DSHCompletionV2MaxToolCount + 1; ++i) {
    NSMutableDictionary *tool = [[self validTool] mutableCopy];
    tool[@"name"] = [NSString stringWithFormat:@"tool_%lu", (unsigned long)i];
    [tools addObject:tool];
  }
  NSError *error = nil;
  XCTAssertNil(DSHCompletionToolsV2FromArray(tools, &error));
  XCTAssertNotNil(error);
}

- (void)testRejectsInvalidToolNames {
  for (NSString *bad in @[ @"", @"has space", @"dot.name", @" slash/",
                           [@"x" stringByPaddingToLength:65 withString:@"a"
                                                startingAtIndex:0] ]) {
    NSMutableDictionary *tool = [[self validTool] mutableCopy];
    tool[@"name"] = bad;
    NSError *error = nil;
    XCTAssertNil(DSHCompletionToolsV2FromArray(@[ tool ], &error),
                 "expected rejection for %@", bad);
    XCTAssertNotNil(error);
  }
}

- (void)testRejectsNonFunctionTypeAndBadParameters {
  NSMutableDictionary *tool = [[self validTool] mutableCopy];
  tool[@"type"] = @"web_search";
  NSError *error = nil;
  XCTAssertNil(DSHCompletionToolsV2FromArray(@[ tool ], &error));

  NSMutableDictionary *badParams = [[self validTool] mutableCopy];
  badParams[@"parameters"] = @"not-an-object";
  error = nil;
  XCTAssertNil(DSHCompletionToolsV2FromArray(@[ badParams ], &error));
  XCTAssertNotNil(error);
}

- (void)testRejectsOversizedSchemaAndDescription {
  NSMutableDictionary *tool = [[self validTool] mutableCopy];
  NSString *big = [@"" stringByPaddingToLength:(DSHCompletionV2MaxToolSchemaBytes + 64)
                                    withString:@"a" startingAtIndex:0];
  tool[@"parameters"] = @{@"marker": big};
  NSError *error = nil;
  XCTAssertNil(DSHCompletionToolsV2FromArray(@[ tool ], &error));

  NSMutableDictionary *longDescription = [[self validTool] mutableCopy];
  longDescription[@"description"] =
      [@"" stringByPaddingToLength:(DSHCompletionV2MaxToolDescriptionLength + 1)
                         withString:@"d" startingAtIndex:0];
  error = nil;
  XCTAssertNil(DSHCompletionToolsV2FromArray(@[ longDescription ], &error));
  XCTAssertNotNil(error);
}

#pragma mark - Request body

- (void)testBodyContainsToolsOnlyWhenProvided {
  NSDictionary *withoutTools = DSHCompletionRequestBodyV2(
      @"deepseek-v4-flash", @"high",
      @[ @{@"role": @"user", @"content": @"hi"} ], nil);
  XCTAssertEqualObjects(withoutTools[@"model"], @"deepseek-v4-flash");
  XCTAssertFalse([withoutTools.allKeys containsObject:@"tools"]);
  XCTAssertEqualObjects(withoutTools[@"thinking"], @{@"type": @"enabled"});
  XCTAssertEqualObjects(withoutTools[@"reasoning_effort"], @"high");

  NSDictionary *withTools = DSHCompletionRequestBodyV2(
      @"deepseek-v4-flash", @"off",
      @[ @{@"role": @"user", @"content": @"hi"} ],
      DSHCompletionToolsV2FromArray(@[ [self validTool] ], nil));
  XCTAssertEqual(((NSArray *)withTools[@"tools"]).count, 1u);
  XCTAssertEqualObjects(withoutTools[@"stream"], @NO);
  XCTAssertNil(withTools[@"reasoning_effort"]);
}

#pragma mark - Response parsing

- (void)testParsesPlainTextStopResponse {
  NSDictionary *decoded = @{
    @"choices": @[ @{
      @"finish_reason": @"stop",
      @"message": @{@"role": @"assistant", @"content": @"Hello"},
    } ],
  };
  NSError *error = nil;
  NSDictionary *result = DSHParseCompletionResponseV2(decoded, &error);
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"text"], @"Hello");
  XCTAssertEqualObjects(result[@"finish_reason"], @"stop");
  XCTAssertEqual(((NSArray *)result[@"tool_calls"]).count, 0u);
}

- (void)testParsesToolCallsWithEmptyContent {
  NSDictionary *decoded = @{
    @"choices": @[ @{
      @"finish_reason": @"tool_calls",
      @"message": @{
        @"role": @"assistant",
        @"content": [NSNull null],
        @"tool_calls": @[
          @{
            @"id": @"call_1",
            @"type": @"function",
            @"function": @{@"name": @"write_file",
                           @"arguments": @"{\"path\":\"a.md\",\"content\":\"x\"}"},
          },
          @{
            @"id": @"call_2",
            @"type": @"function",
            @"function": @{@"name": @"git_commit", @"arguments": @"{}"},
          },
        ],
      },
    } ],
  };
  NSError *error = nil;
  NSDictionary *result = DSHParseCompletionResponseV2(decoded, &error);
  XCTAssertNil(error);
  XCTAssertEqualObjects(result[@"text"], @"");
  XCTAssertEqualObjects(result[@"finish_reason"], @"tool_calls");
  XCTAssertEqual(((NSArray *)result[@"tool_calls"]).count, 2u);
  XCTAssertEqualObjects(result[@"tool_calls"][0][@"name"], @"write_file");
  XCTAssertEqualObjects(result[@"tool_calls"][0][@"id"], @"call_1");
  XCTAssertTrue([result[@"tool_calls"][0][@"arguments"]
      hasPrefix:@"{\"path\""]);
  XCTAssertEqualObjects(result[@"tool_calls"][1][@"name"], @"git_commit");
}

- (void)testFailsClosedOnMalformedToolCalls {
  NSDictionary *missingId = @{
    @"choices": @[ @{
      @"finish_reason": @"tool_calls",
      @"message": @{@"tool_calls": @[ @{
        @"function": @{@"name": @"x", @"arguments": @"{}"},
      } ]},
    } ],
  };
  NSError *error = nil;
  XCTAssertNil(DSHParseCompletionResponseV2(missingId, &error));
  XCTAssertNotNil(error);

  NSDictionary *argumentsNotString = @{
    @"choices": @[ @{
      @"finish_reason": @"tool_calls",
      @"message": @{@"tool_calls": @{
        @"id": @"c1",
        @"function": @{@"name": @"x", @"arguments": @{}},
      } },
    } ],
  };
  error = nil;
  XCTAssertNil(DSHParseCompletionResponseV2(argumentsNotString, &error));
  XCTAssertNotNil(error);
}

- (void)testFailsClosedOnEmptyChoicesAndMissingStructure {
  NSError *error = nil;
  XCTAssertNil(DSHParseCompletionResponseV2(@{}, &error));
  XCTAssertNotNil(error);

  error = nil;
  XCTAssertNil(DSHParseCompletionResponseV2(
      @{ @"choices": @[] }, &error));
  XCTAssertNotNil(error);

  // Empty assistant content with no tool calls is an invalid loop response
  // rather than a silently-empty success.
  error = nil;
  XCTAssertNil(DSHParseCompletionResponseV2(@{
    @"choices": @[ @{ @"finish_reason": @"stop",
                      @"message": @{@"content": @" "} } ],
  }, &error));
  XCTAssertNotNil(error);
}

@end
