#import <XCTest/XCTest.h>

#import "../../../../modules/rish/ios/Sources/DSHStreamEvents.h"

@interface StreamEventParserTests : XCTestCase
@end

@implementation StreamEventParserTests

- (DSHStreamEventParser *)parser {
  return [[DSHStreamEventParser alloc] init];
}

- (NSString *)contentDeltaJson:(NSString *)text {
  return [NSString stringWithFormat:
      @"data: {\"choices\":[{\"delta\":{\"content\":\"%@\"}}]}\n\n", text];
}

- (NSString *)reasoningDeltaJson:(NSString *)text {
  return [NSString stringWithFormat:
      @"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"%@\"}}]}\n\n",
      text];
}

- (void)testParsesContentDeltasSplitAcrossChunkBoundaries {
  DSHStreamEventParser *parser = [self parser];
  // One event split into three raw chunks (mid-header, mid-JSON, mid-CRLF).
  NSString *full = [self contentDeltaJson:@"Hello"];
  NSArray<NSString *> *pieces = @[
    [full substringToIndex:9],
    [full substringWithRange:NSMakeRange(9, 21)],
    [full substringFromIndex:30],
  ];
  NSMutableArray<NSDictionary *> *collected = [NSMutableArray array];
  for (NSString *piece in pieces) {
    const char *c = piece.UTF8String;
    NSError *error = nil;
    NSArray *deltas = [parser appendBytes:(const uint8_t *)c
                                    length:strlen(c) error:&error];
    XCTAssertNil(error);
    [collected addObjectsFromArray:deltas];
  }
  XCTAssertEqual(collected.count, 1u);
  XCTAssertEqualObjects(collected.firstObject[@"type"], @"delta");
  XCTAssertEqualObjects(collected.firstObject[@"content"], @"Hello");
}

- (void)testParsesReasoningAndFinishInOneEvent {
  DSHStreamEventParser *parser = [self parser];
  NSString *event =
      @"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"},"
      @"\"finish_reason\":\"stop\"}]}\n\n";
  const char *c = event.UTF8String;
  NSError *error = nil;
  NSArray *deltas = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                  error:&error];
  XCTAssertNil(error);
  XCTAssertEqual(deltas.count, 1u);
  XCTAssertEqualObjects(deltas.firstObject[@"reasoning"], @"thinking");
  XCTAssertEqualObjects(deltas.firstObject[@"finish_reason"], @"stop");
}

- (void)testDoneSentinelAndCommentsAreHandled {
  DSHStreamEventParser *parser = [self parser];
  NSString *stream = [NSString stringWithFormat:
      @": keep-alive\n\n%@data: [DONE]\n\n", [self contentDeltaJson:@"x"]];
  const char *c = stream.UTF8String;
  NSError *error = nil;
  NSArray *deltas = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                  error:&error];
  XCTAssertNil(error);
  XCTAssertEqual(deltas.count, 2u);
  XCTAssertEqualObjects(deltas.firstObject[@"content"], @"x");
  XCTAssertEqualObjects(deltas.lastObject[@"type"], @"done");
}

- (void)testMultiDataLineEventsAreJoinedPerSSESpec {
  DSHStreamEventParser *parser = [self parser];
  // A JSON payload deliberately split across two data: lines at a safe
  // boundary (between two complete events it must NOT merge).
  NSString *stream =
      @"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n"
      @"data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n";
  const char *c = stream.UTF8String;
  NSError *error = nil;
  NSArray *deltas = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                  error:&error];
  // Joined with \n the payload is invalid JSON → fail closed.
  XCTAssertNotNil(error);
}

- (void)testFinishFlushesATrailingUnterminatedEvent {
  DSHStreamEventParser *parser = [self parser];
  NSString *truncated =
      @"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}";
  const char *c = truncated.UTF8String;
  NSError *error = nil;
  NSArray *first = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                 error:&error];
  XCTAssertNil(error);
  XCTAssertEqual(first.count, 0u);
  NSArray *flushed = [parser finish:&error];
  XCTAssertNil(error);
  XCTAssertEqual(flushed.count, 1u);
  XCTAssertEqualObjects(flushed.firstObject[@"content"], @"tail");
  // Second finish fails closed.
  error = nil;
  XCTAssertNil([parser finish:&error]);
  XCTAssertNotNil(error);
}

- (void)testCRLFTransportsAreNormalized {
  DSHStreamEventParser *parser = [self parser];
  NSString *crlf = [self contentDeltaJson:@"crlf"];
  crlf = [crlf stringByReplacingOccurrencesOfString:@"\n"
                                         withString:@"\r\n"];
  const char *c = crlf.UTF8String;
  NSError *error = nil;
  NSArray *deltas = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                  error:&error];
  XCTAssertNil(error);
  XCTAssertEqual(deltas.count, 1u);
  XCTAssertEqualObjects(deltas.firstObject[@"content"], @"crlf");
}

- (void)testOversizedLinesFailClosed {
  DSHStreamEventParser *parser = [self parser];
  NSMutableString *big = [NSMutableString stringWithString:@"data: "];
  while (big.length < DSHStreamMaxLineBytes + 16) {
    [big appendString:@"a"];
  }
  const char *c = big.UTF8String;
  NSError *error = nil;
  XCTAssertNil([parser appendBytes:(const uint8_t *)c length:strlen(c)
                             error:&error]);
  XCTAssertNotNil(error);
}

- (void)testChunksWithoutChoicesAreNoOps {
  DSHStreamEventParser *parser = [self parser];
  NSString *stream = @"data: {\"id\":\"x\",\"usage\":{\"total_tokens\":1}}\n\n";
  const char *c = stream.UTF8String;
  NSError *error = nil;
  NSArray *deltas = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                  error:&error];
  XCTAssertNil(error);
  XCTAssertEqual(deltas.count, 0u);
}

- (void)testResetAllowsReuse {
  DSHStreamEventParser *parser = [self parser];
  NSString *event = [self contentDeltaJson:@"one"];
  const char *c = event.UTF8String;
  NSError *error = nil;
  NSArray *first = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                 error:&error];
  XCTAssertEqual(first.count, 1u);
  [parser reset];
  NSArray *second = [parser appendBytes:(const uint8_t *)c length:strlen(c)
                                  error:&error];
  XCTAssertEqual(second.count, 1u);
  XCTAssertEqualObjects(second.firstObject[@"content"], @"one");
}

@end
