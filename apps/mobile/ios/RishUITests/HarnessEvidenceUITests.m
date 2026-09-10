#import <XCTest/XCTest.h>

/**
 * Simulator evidence drive for the built-in Harness catalog: opens the
 * Harnesses screen, switches to Claude Code and Codex, and captures the
 * composer model picker for each so the screenshots prove which Harnesses
 * and models are mounted. PNGs are written to $RISH_EVIDENCE_DIR (passed as
 * TEST_RUNNER_RISH_EVIDENCE_DIR) and attached to the test result.
 *
 * Both English and Chinese labels are probed so the run does not depend on
 * the simulator locale. No provider request is made: selecting a Harness
 * only changes the conversation model and the credential slot.
 */
@interface HarnessEvidenceUITests : XCTestCase
@end

@implementation HarnessEvidenceUITests

- (XCUIApplication *)app {
  static XCUIApplication *shared;
  if (shared == nil) shared = [[XCUIApplication alloc] init];
  return shared;
}

- (XCUIElement *)elementMatchingAnyOf:(NSArray<NSString *> *)labels {
  for (NSString *label in labels) {
    NSPredicate *exact = [NSPredicate predicateWithFormat:@"label == %@", label];
    XCUIElement *match = [[[self.app descendantsMatchingType:XCUIElementTypeAny]
        matchingPredicate:exact] firstMatch];
    if ([match waitForExistenceWithTimeout:4]) return match;
  }
  return nil;
}

- (XCUIElement *)elementWithLabelPrefixAnyOf:(NSArray<NSString *> *)prefixes {
  for (NSString *prefix in prefixes) {
    NSPredicate *begins = [NSPredicate predicateWithFormat:@"label BEGINSWITH %@", prefix];
    XCUIElement *match = [[[self.app descendantsMatchingType:XCUIElementTypeAny]
        matchingPredicate:begins] firstMatch];
    if ([match waitForExistenceWithTimeout:4]) return match;
  }
  return nil;
}

- (void)capture:(NSString *)name {
  sleep(1);
  XCUIScreenshot *screenshot = XCUIScreen.mainScreen.screenshot;
  XCTAttachment *attachment = [XCTAttachment attachmentWithScreenshot:screenshot];
  attachment.name = name;
  attachment.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:attachment];
  NSString *directory = NSProcessInfo.processInfo.environment[@"RISH_EVIDENCE_DIR"];
  if (directory.length == 0) return;
  [NSFileManager.defaultManager createDirectoryAtPath:directory
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:nil];
  NSString *path = [directory stringByAppendingPathComponent:
      [name stringByAppendingPathExtension:@"png"]];
  BOOL written = [screenshot.PNGRepresentation writeToFile:path atomically:YES];
  XCTAssertTrue(written, @"could not write %@", path);
}

- (void)openHarnesses {
  XCUIElement *drawerButton = [self elementMatchingAnyOf:@[ @"Open navigation", @"打开导航" ]];
  XCTAssertNotNil(drawerButton, @"navigation button not found");
  [drawerButton tap];
  sleep(1);
  XCUIElement *harnesses = [self elementMatchingAnyOf:@[ @"Harnesses", @"Harness" ]];
  XCTAssertNotNil(harnesses, @"Harnesses drawer entry not found");
  [harnesses tap];
  sleep(1);
}

- (void)selectHarnessNamed:(NSString *)name tag:(NSString *)tag {
  [self openHarnesses];
  [self capture:[NSString stringWithFormat:@"%@-harnesses-before-%@", tag, name]];
  XCUIElement *card = [self elementMatchingAnyOf:@[
    [NSString stringWithFormat:@"Use %@", name],
    [NSString stringWithFormat:@"使用 %@", name],
  ]];
  XCTAssertNotNil(card, @"%@ harness card not found", name);
  [card tap];
  sleep(1);
  [self capture:[NSString stringWithFormat:@"%@-home-%@", tag, name]];
  XCUIElement *options = [self elementWithLabelPrefixAnyOf:@[ @"Model ", @"模型 " ]];
  XCTAssertNotNil(options, @"composer options button not found for %@", name);
  [options tap];
  sleep(1);
  [self capture:[NSString stringWithFormat:@"%@-model-picker-%@", tag, name]];
}

- (void)testCaptureHarnessAndModelPickerEvidence {
  [self.app launch];
  sleep(2);
  [self capture:@"00-home-launch"];
  [self selectHarnessNamed:@"Claude Code" tag:@"01"];
  [self.app terminate];
  [self.app launch];
  sleep(2);
  [self selectHarnessNamed:@"Codex" tag:@"02"];
  [self.app terminate];
  [self.app launch];
  sleep(2);
  [self selectHarnessNamed:@"DSH" tag:@"03"];
  [self.app terminate];
}

@end
