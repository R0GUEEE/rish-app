#import <XCTest/XCTest.h>

/**
 * Device acceptance drive: navigates the real UI on the physical iPhone,
 * fills the public clone form, submits it, and asserts the project list
 * shows the cloned repository. This replaces hand-tapping for the clone
 * leg of the device acceptance (anchor fix verification end-to-end).
 *
 * Requires the app to be installed and unlocked. Runs against whatever
 * locale the device uses, so both English and Chinese labels are probed.
 */

@interface DeviceCloneDriveUITests : XCTestCase
@end

@implementation DeviceCloneDriveUITests

- (XCUIApplication *)app {
  static XCUIApplication *shared;
  if (shared == nil) shared = [[XCUIApplication alloc] init];
  return shared;
}

- (XCUIElement *)elementMatchingAnyOf:(NSArray<NSString *> *)labels {
  for (NSString *label in labels) {
    NSPredicate *exact =
        [NSPredicate predicateWithFormat:@"label == %@", label];
    XCUIElementQuery *any = [self.app
        descendantsMatchingType:XCUIElementTypeAny];
    XCUIElement *match = [[any matchingPredicate:exact] firstMatch];
    if ([match waitForExistenceWithTimeout:4]) return match;
  }
  return nil;
}

- (void)setUp {
  [super setUp];
  self.continueAfterFailure = NO;
  // Capture the container-anchor trace (env-gated NSLog in
  // LocalProjectAccess) from the target app while the clone drives the
  // real project-path walk on the device.
  self.app.launchEnvironment = @{@"DSH_ANCHOR_TRACE" : @"1"};
}

- (void)testDrivePublicCloneEndToEnd {
  [self.app launch];

  // 1. Open the navigation drawer.
  XCUIElement *drawerButton = [self elementMatchingAnyOf:@[
    @"打开导航", @"Open navigation",
  ]];
  XCTAssertNotNil(drawerButton, @"navigation button not found");
  [drawerButton tap];
  sleep(1);

  // 2. Open Projects.
  XCUIElement *projects = [self elementMatchingAnyOf:@[
    @"项目", @"Projects",
  ]];
  XCTAssertNotNil(projects, @"projects entry not found");
  [projects tap];
  sleep(1);

  // 3. Choose clone mode.
  XCUIElement *cloneMode = [self elementMatchingAnyOf:@[
    @"克隆仓库", @"Clone repository",
  ]];
  XCTAssertNotNil(cloneMode, @"clone mode button not found");
  [cloneMode waitForExistenceWithTimeout:5];
  [cloneMode tap];

  // 4. Fill the remote URL field (label "Remote HTTPS URL" / 远程 HTTPS URL).
  XCUIElement *urlField = nil;
  {
    NSPredicate *byLabel = [NSPredicate predicateWithFormat:
        @"label == %@ OR label == %@", @"远程 HTTPS 地址", @"Remote HTTPS URL"];
    XCUIElementQuery *fields = [self.app
        descendantsMatchingType:XCUIElementTypeTextField];
    urlField = [[fields matchingPredicate:byLabel] firstMatch];
    if (![urlField waitForExistenceWithTimeout:4]) {
      // Fallback: any text field inside the visible form.
      urlField = fields.firstMatch;
      if (![urlField waitForExistenceWithTimeout:4]) urlField = nil;
    }
  }
  XCTAssertNotNil(urlField, @"clone URL field not found");
  [urlField tap];
  [urlField typeText:@"https://github.com/octocat/Hello-World.git"];

  // 5. Submit the clone.
  XCUIElement *cloneButton = [self elementMatchingAnyOf:@[
    @"克隆", @"Clone",
  ]];
  XCTAssertNotNil(cloneButton, @"clone submit button not found");
  [cloneButton tap];

  // 6. Wait for the cloned project to appear (network clone takes a while).
  NSString *expected = @"Hello-World";
  NSPredicate *appears = [NSPredicate
      predicateWithFormat:@"label CONTAINS %@", expected];
  XCUIElementQuery *any = [self.app
      descendantsMatchingType:XCUIElementTypeAny];
  XCUIElement *row = [[any matchingPredicate:appears] firstMatch];
  // Poll up to 120s for the cloned row to appear.
  BOOL appeared = NO;
  for (int i = 0; i < 120 && !appeared; i++) {
    appeared = row.exists;
    if (!appeared) sleep(1);
  }
  XCTAssertTrue(appeared, @"cloned project row never appeared");
}

@end
