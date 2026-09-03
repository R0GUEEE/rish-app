#import <UIKit/UIKit.h>
#import <XCTest/XCTest.h>

/**
 * Device / simulator UI acceptance:
 * 1) Public HTTPS clone through the Projects surface.
 * 2) New chat + bind an existing workspace via the composer chip.
 *
 * Prefer accessibilityIdentifier (RN testID) over locale-specific labels.
 */

@interface DeviceCloneDriveUITests : XCTestCase
@end

@implementation DeviceCloneDriveUITests {
  XCUIApplication *_app;
}

- (XCUIApplication *)app {
  if (_app == nil) {
    _app = [[XCUIApplication alloc] init];
  }
  return _app;
}

- (XCUIElement *)elementWithIdentifier:(NSString *)identifier
                               timeout:(NSTimeInterval)timeout {
  XCUIElement *match =
      [[self.app descendantsMatchingType:XCUIElementTypeAny]
          matchingIdentifier:identifier]
          .firstMatch;
  if ([match waitForExistenceWithTimeout:timeout]) {
    return match;
  }
  return nil;
}

- (XCUIElement *)elementMatchingAnyOf:(NSArray<NSString *> *)labels
                              timeout:(NSTimeInterval)timeout {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while ([deadline timeIntervalSinceNow] > 0) {
    for (NSString *label in labels) {
      NSPredicate *exact =
          [NSPredicate predicateWithFormat:@"label == %@", label];
      XCUIElement *match =
          [[[self.app descendantsMatchingType:XCUIElementTypeAny]
              matchingPredicate:exact] firstMatch];
      if (match.exists) {
        return match;
      }
    }
    [NSThread sleepForTimeInterval:0.4];
  }
  return nil;
}

- (XCUIElement *)requireIdentifier:(NSString *)identifier
                           timeout:(NSTimeInterval)timeout {
  XCUIElement *match = [self elementWithIdentifier:identifier timeout:timeout];
  XCTAssertNotNil(match, @"missing accessibilityIdentifier %@", identifier);
  return match;
}

- (XCUIElement *)requireIdentifier:(NSString *)identifier
                      orLabels:(NSArray<NSString *> *)labels
                       timeout:(NSTimeInterval)timeout {
  XCUIElement *byId =
      [self elementWithIdentifier:identifier timeout:timeout];
  if (byId != nil) {
    return byId;
  }
  XCUIElement *byLabel = [self elementMatchingAnyOf:labels timeout:2];
  XCTAssertNotNil(byLabel,
                  @"missing accessibilityIdentifier %@ and labels %@",
                  identifier, labels);
  return byLabel;
}

- (void)pasteText:(NSString *)text intoField:(XCUIElement *)field {
  XCTAssertTrue(field.exists, @"paste target missing");
  [field tap];

  // Clear any existing value via select-all + paste overwrite.
  UIPasteboard.generalPasteboard.string = text;

  [field pressForDuration:1.1];

  XCUIElement *selectAll = nil;
  NSArray<NSString *> *selectAllLabels = @[ @"Select All", @"全选", @"Select all" ];
  for (NSString *label in selectAllLabels) {
    XCUIElement *candidate = self.app.menuItems[label];
    if ([candidate waitForExistenceWithTimeout:1.5]) {
      selectAll = candidate;
      break;
    }
  }
  if (selectAll != nil && selectAll.exists) {
    [selectAll tap];
  }

  XCUIElement *paste = nil;
  NSArray<NSString *> *pasteLabels = @[ @"Paste", @"粘贴" ];
  for (NSString *label in pasteLabels) {
    XCUIElement *candidate = self.app.menuItems[label];
    if ([candidate waitForExistenceWithTimeout:2.0]) {
      paste = candidate;
      break;
    }
  }

  if (paste != nil && paste.exists) {
    [paste tap];
    return;
  }

  // Fallback: character-wise typing with a short settle between keystrokes.
  // Avoids RN TextInput caret reordering that garbles bulk typeText.
  NSString *current = field.value;
  if ([current isKindOfClass:[NSString class]] && current.length > 0 &&
      ![current isEqualToString:text]) {
    // Best-effort clear: delete characters one by one.
    NSMutableString *deletes =
        [NSMutableString stringWithCapacity:current.length];
    for (NSUInteger i = 0; i < current.length; i++) {
      [deletes appendString:@"\b"];
    }
    [field typeText:deletes];
  }
  for (NSUInteger i = 0; i < text.length; i++) {
    unichar c = [text characterAtIndex:i];
    NSString *ch = [NSString stringWithCharacters:&c length:1];
    [field typeText:ch];
  }
}

- (NSString *)stringValueOf:(XCUIElement *)element {
  id value = element.value;
  if ([value isKindOfClass:[NSString class]]) {
    return (NSString *)value;
  }
  if ([value isKindOfClass:[NSNumber class]]) {
    return [(NSNumber *)value stringValue];
  }
  NSString *label = element.label;
  return label ?: @"";
}

- (void)setUp {
  [super setUp];
  self.continueAfterFailure = NO;
  self.app.launchEnvironment = @{@"DSH_ANCHOR_TRACE" : @"1"};
}

- (void)testDrivePublicCloneEndToEnd {
  [self.app launch];

  XCUIElement *nav = [self requireIdentifier:@"home-open-navigation"
                                    orLabels:@[ @"打开导航", @"Open navigation" ]
                                     timeout:60];
  [nav tap];

  XCUIElement *projects =
      [self requireIdentifier:@"drawer-projects"
                     orLabels:@[ @"项目", @"Projects" ]
                      timeout:10];
  [projects tap];

  XCUIElement *cloneMode =
      [self requireIdentifier:@"projects-clone-repository"
                     orLabels:@[ @"克隆仓库", @"Clone repository" ]
                      timeout:10];
  [cloneMode tap];

  NSString *projectName = @"Hello-World";
  NSString *remoteURL = @"https://github.com/octocat/Hello-World.git";

  XCUIElement *nameField =
      [self requireIdentifier:@"projects-name-input" timeout:8];
  [self pasteText:projectName intoField:nameField];
  XCTAssertEqualObjects([self stringValueOf:nameField], projectName,
                        @"project name field was not set correctly");

  XCUIElement *urlField =
      [self requireIdentifier:@"projects-remote-url-input" timeout:8];
  [self pasteText:remoteURL intoField:urlField];
  NSString *urlValue = [self stringValueOf:urlField];
  XCTAssertEqualObjects(urlValue, remoteURL,
                        @"remote URL field was garbled or incomplete: %@",
                        urlValue);

  XCUIElement *submit =
      [self requireIdentifier:@"projects-clone-submit" timeout:5];
  [submit tap];

  // Clone opens the project detail. Wait for the title, then return to the
  // list and assert the row (requirement: cloned project row within 120s).
  XCUIElement *detailTitle =
      [self requireIdentifier:@"projects-detail-title" timeout:120];
  NSPredicate *titleHasName = [NSPredicate
      predicateWithFormat:@"label CONTAINS %@ OR value CONTAINS %@",
                          projectName, projectName];
  XCUIElement *titled =
      [[self.app descendantsMatchingType:XCUIElementTypeAny]
          matchingPredicate:titleHasName]
          .firstMatch;
  BOOL detailReady = NO;
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:120];
  while ([deadline timeIntervalSinceNow] > 0) {
    if (detailTitle.exists &&
        ([[self stringValueOf:detailTitle] containsString:projectName] ||
         titled.exists)) {
      detailReady = YES;
      break;
    }
    // Also accept the list row appearing without leaving detail.
    XCUIElement *earlyRow =
        [self elementWithIdentifier:[NSString
                                        stringWithFormat:@"projects-row-%@",
                                                         projectName]
                            timeout:0.2];
    if (earlyRow != nil) {
      detailReady = YES;
      break;
    }
    [NSThread sleepForTimeInterval:1.0];
  }
  XCTAssertTrue(detailReady, @"clone never reached detail/list for %@",
                projectName);

  XCUIElement *back =
      [self elementWithIdentifier:@"projects-back" timeout:5];
  if (back != nil) {
    [back tap];
  }

  XCUIElement *row = [self
      requireIdentifier:[NSString stringWithFormat:@"projects-row-%@",
                                                   projectName]
                timeout:30];
  XCTAssertTrue(row.exists, @"cloned project row never appeared");
}

- (void)testNewChatBindsExistingWorkspaceToComposerChip {
  [self.app launch];

  XCUIElement *nav = [self requireIdentifier:@"home-open-navigation"
                                    orLabels:@[ @"打开导航", @"Open navigation" ]
                                     timeout:60];
  [nav tap];

  XCUIElement *newChat =
      [self requireIdentifier:@"drawer-new-chat"
                     orLabels:@[ @"创建新对话", @"Create new chat" ]
                      timeout:10];
  [newChat tap];

  // Drawer closes after new chat; composer chip requires a configured
  // credential. Fail clearly if the chip is absent.
  XCUIElement *chip =
      [self requireIdentifier:@"composer-workspace-chip" timeout:15];
  [chip tap];

  XCUIElement *sheet =
      [self requireIdentifier:@"workspace-picker-sheet" timeout:8];
  XCTAssertTrue(sheet.exists);

  NSPredicate *rowPred = [NSPredicate
      predicateWithFormat:@"identifier BEGINSWITH %@",
                          @"workspace-picker-row-"];
  XCUIElementQuery *rows =
      [[self.app descendantsMatchingType:XCUIElementTypeAny]
          matchingPredicate:rowPred];
  XCUIElement *firstRow = rows.firstMatch;
  NSString *workspaceName = @"UITest Workspace";

  if (![firstRow waitForExistenceWithTimeout:3]) {
    // Fresh install: create a named workspace, then bind it.
    XCUIElement *nameField =
        [self requireIdentifier:@"workspace-picker-name-input"
                       orLabels:@[ @"Workspace name", @"工作区名称" ]
                        timeout:8];
    [self pasteText:workspaceName intoField:nameField];

    XCUIElement *createButton =
        [self requireIdentifier:@"workspace-picker-new"
                       orLabels:@[ @"New workspace", @"新建工作区" ]
                        timeout:5];
    [createButton tap];

    XCTAssertTrue([firstRow waitForExistenceWithTimeout:15],
                  @"created workspace row never appeared");
  }

  NSString *rowLabel = firstRow.label ?: @"";
  // Label is "Use {name}" / "使用{name}". Prefer parsed label when present.
  NSArray<NSString *> *prefixes = @[ @"Use ", @"使用" ];
  for (NSString *prefix in prefixes) {
    if ([rowLabel hasPrefix:prefix]) {
      workspaceName = [rowLabel substringFromIndex:prefix.length];
      break;
    }
  }
  XCTAssertTrue(workspaceName.length > 0,
                @"could not determine workspace name from %@", rowLabel);

  // Prefer an enabled/hittable match; RN Pressable may surface as Button or Other.
  XCUIElement *rowToTap = firstRow;
  if (!rowToTap.isHittable) {
    XCUIElement *asButton =
        [[self.app.buttons matchingPredicate:rowPred] firstMatch];
    if ([asButton waitForExistenceWithTimeout:2] && asButton.isHittable) {
      rowToTap = asButton;
    }
  }
  XCTAssertTrue(rowToTap.isHittable,
                @"workspace row is not hittable (status may not be ok): %@",
                rowLabel);
  [rowToTap tap];

  // Some picker flows need an explicit confirm.
  XCUIElement *confirm =
      [self elementWithIdentifier:@"workspace-picker-confirm-selection"
                          timeout:3];
  if (confirm != nil && confirm.exists && confirm.isHittable) {
    [confirm tap];
  }

  // Successful bind closes the picker sheet.
  NSDate *sheetDeadline = [NSDate dateWithTimeIntervalSinceNow:15];
  while (sheet.exists && [sheetDeadline timeIntervalSinceNow] > 0) {
    [NSThread sleepForTimeInterval:0.4];
  }
  XCTAssertFalse(sheet.exists,
                 @"workspace picker stayed open; bind likely failed");

  // Chip accessibilityValue carries the bound name (label stays Choose workspace).
  BOOL chipBound = NO;
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
  while ([deadline timeIntervalSinceNow] > 0) {
    XCUIElement *boundChip =
        [self elementWithIdentifier:@"composer-workspace-chip" timeout:1];
    if (boundChip == nil) {
      [NSThread sleepForTimeInterval:0.5];
      continue;
    }
    NSString *chipValue = [self stringValueOf:boundChip];
    NSString *chipLabel = boundChip.label ?: @"";
    if ([chipValue containsString:workspaceName] ||
        [chipLabel containsString:workspaceName]) {
      chipBound = YES;
      break;
    }
    XCUIElement *nested = self.app.staticTexts[workspaceName];
    if ([nested waitForExistenceWithTimeout:0.3]) {
      chipBound = YES;
      break;
    }
    [NSThread sleepForTimeInterval:0.5];
  }
  XCTAssertTrue(chipBound,
                @"composer chip did not show workspace name %@",
                workspaceName);
}

@end
