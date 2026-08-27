#import <XCTest/XCTest.h>

// The tests target links no pod libraries (search-paths inheritance only),
// so the pure completionV2 helpers are compiled directly into this bundle
// instead of being resolved against the stripped host application.
#import "../../../../modules/rish/ios/Sources/DSHCompletionV2.mm"

@interface CompletionV2Tests : XCTestCase
@end

@implementation CompletionV2Tests

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
  XCTAssertEqualObjects(tools.firstObject[@"name"], @"git_commit");
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
