#import "RishHarnessCatalog.h"

static NSString *const DSHCatalogHarnessDsh = @"dsh";
static NSString *const DSHCatalogHarnessClaudeCode = @"claude-code";
static NSString *const DSHCatalogHarnessCodex = @"codex";
static NSString *const DSHCodexDiscoveredModelsKey = @"rish.codex.discovered-models.v1";
static BOOL DSHCodexDiscoveryID(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] > 80) return NO;
  return [value rangeOfString:@"^(?:(?:gpt|codex)-[A-Za-z0-9][A-Za-z0-9._-]*|o[0-9][A-Za-z0-9._-]*)$" options:NSRegularExpressionSearch].location != NSNotFound;
}
static NSSet<NSString *> *DSHCodexDiscoveredModels(void) {
  NSArray *values = [NSUserDefaults.standardUserDefaults arrayForKey:DSHCodexDiscoveredModelsKey];
  NSMutableSet *result = [NSMutableSet set];
  for (id value in values) if (DSHCodexDiscoveryID(value) && result.count < 256) [result addObject:value];
  return result;
}
BOOL DSHRegisterCodexSubscriptionModels(NSArray<NSString *> *models) {
  if (![models isKindOfClass:NSArray.class] || models.count > 64) return NO;
  @synchronized (NSUserDefaults.standardUserDefaults) {
    NSMutableSet *all = [DSHCodexDiscoveredModels() mutableCopy];
    for (id model in models) { if (!DSHCodexDiscoveryID(model)) return NO; [all addObject:model]; }
    if (all.count > 256) return NO;
    [NSUserDefaults.standardUserDefaults setObject:[all.allObjects sortedArrayUsingSelector:@selector(compare:)] forKey:DSHCodexDiscoveredModelsKey];
    return YES;
  }
}
/// Zhipu GLM served over its Anthropic-compatible Messages endpoint. A
/// distinct catalog entry rather than a base-URL override on claude-code:
/// provider_host is recorded in consent manifests, runtime proof and session
/// snapshots and compared by equality, so the host that actually served a
/// round has to be a fixed catalog fact, not mutable state.
static NSString *const DSHCatalogHarnessGlm = @"glm";

static NSDictionary<NSString *, NSString *> *DSHCatalogHarnessByModel(void) {
  static NSDictionary<NSString *, NSString *> *table = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    table = @{
      @"deepseek-v4-flash" : DSHCatalogHarnessDsh,
      @"deepseek-v4-pro" : DSHCatalogHarnessDsh,
      @"deepseek-v4-flash-vision-exp" : DSHCatalogHarnessDsh,
      @"claude-sonnet-5" : DSHCatalogHarnessClaudeCode,
      @"claude-opus-5" : DSHCatalogHarnessClaudeCode,
      @"claude-haiku-4-5-20251001" : DSHCatalogHarnessClaudeCode,
      @"claude-fable-5-1" : DSHCatalogHarnessClaudeCode,
      @"gpt-5.6" : DSHCatalogHarnessCodex,
      @"gpt-5.6-mini" : DSHCatalogHarnessCodex,
      @"gpt-5.6-nano" : DSHCatalogHarnessCodex,
      @"GLM-5.3" : DSHCatalogHarnessGlm,
      @"GLM-5.3-Flash" : DSHCatalogHarnessGlm,
    };
  });
  return table;
}

static NSDictionary<NSString *, NSString *> *DSHCatalogProviderByHarness(void) {
  static NSDictionary<NSString *, NSString *> *table = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    table = @{
      DSHCatalogHarnessDsh : @"deepseek",
      DSHCatalogHarnessClaudeCode : @"anthropic",
      DSHCatalogHarnessCodex : @"openai",
      DSHCatalogHarnessGlm : @"bigmodel",
    };
  });
  return table;
}

static NSDictionary<NSString *, NSString *> *DSHCatalogHostByProvider(void) {
  static NSDictionary<NSString *, NSString *> *table = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    table = @{
      @"deepseek" : @"api.deepseek.com",
      @"anthropic" : @"api.anthropic.com",
      @"openai" : @"api.openai.com",
      @"bigmodel" : @"open.bigmodel.cn",
    };
  });
  return table;
}

static NSDictionary<NSString *, NSString *> *DSHCatalogAccountByHarness(void) {
  static NSDictionary<NSString *, NSString *> *table = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    table = @{
      DSHCatalogHarnessDsh : @"DEEPSEEK_API_KEY",
      DSHCatalogHarnessClaudeCode : @"ANTHROPIC_API_KEY",
      DSHCatalogHarnessCodex : @"OPENAI_API_KEY",
      DSHCatalogHarnessGlm : @"BIGMODEL_API_KEY",
    };
  });
  return table;
}

static NSString *_Nullable DSHCatalogString(id _Nullable value) {
  return [value isKindOfClass:NSString.class] ? value : nil;
}

NSSet<NSString *> *DSHHarnessSupportedModels(void) {
  NSMutableSet *models = [NSMutableSet setWithArray:DSHCatalogHarnessByModel().allKeys];
  [models unionSet:DSHCodexDiscoveredModels()];
  NSDictionary *catalog = DSHDshModelCatalog();
  for (NSArray *rows in @[catalog[@"models"] ?: @[], catalog[@"retired_models"] ?: @[]])
    for (NSDictionary *row in rows) [models addObject:row[@"id"]];
  return models;
}

BOOL DSHHarnessIsSupportedModel(id value) {
  NSString *model = DSHCatalogString(value);
  return model != nil && (DSHCatalogHarnessByModel()[model] != nil || DSHDshModelEntry(model) != nil || [DSHCodexDiscoveredModels() containsObject:model]);
}

NSSet<NSString *> *DSHHarnessSupportedHarnessIds(void) {
  static NSSet<NSString *> *ids = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    ids = [NSSet setWithArray:DSHCatalogProviderByHarness().allKeys];
  });
  return ids;
}

BOOL DSHHarnessIsSupportedHarnessId(id value) {
  NSString *harness = DSHCatalogString(value);
  return harness != nil && DSHCatalogProviderByHarness()[harness] != nil;
}

NSString *DSHHarnessIdForModel(id model) {
  NSString *key = DSHCatalogString(model);
  return key == nil ? nil : (DSHCatalogHarnessByModel()[key] ?: (DSHDshModelEntry(key) ? @"dsh" : ([DSHCodexDiscoveredModels() containsObject:key] ? @"codex" : nil)));
}

NSSet<NSString *> *DSHHarnessSupportedProviderIds(void) {
  static NSSet<NSString *> *ids = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    ids = [NSSet setWithArray:DSHCatalogHostByProvider().allKeys];
  });
  return ids;
}

BOOL DSHHarnessIsProviderId(id value) {
  NSString *provider = DSHCatalogString(value);
  return provider != nil && DSHCatalogHostByProvider()[provider] != nil;
}

NSString *DSHProviderIdForHarnessId(id harnessId) {
  NSString *key = DSHCatalogString(harnessId);
  return key == nil ? nil : DSHCatalogProviderByHarness()[key];
}

NSString *DSHProviderIdForModel(id model) {
  return DSHProviderIdForHarnessId(DSHHarnessIdForModel(model));
}

NSSet<NSString *> *DSHHarnessSupportedProviderHosts(void) {
  static NSSet<NSString *> *hosts = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    hosts = [NSSet setWithArray:DSHCatalogHostByProvider().allValues];
  });
  return hosts;
}

BOOL DSHHarnessIsProviderHost(id value) {
  NSString *host = DSHCatalogString(value);
  return host != nil && [DSHHarnessSupportedProviderHosts() containsObject:host];
}

NSString *DSHProviderHostForProviderId(id providerId) {
  NSString *key = DSHCatalogString(providerId);
  return key == nil ? nil : DSHCatalogHostByProvider()[key];
}

NSString *DSHProviderHostForModel(id model) {
  return DSHProviderHostForProviderId(DSHProviderIdForModel(model));
}

NSSet<NSString *> *DSHHarnessCredentialAccounts(void) {
  static NSSet<NSString *> *accounts = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    accounts = [NSSet setWithArray:DSHCatalogAccountByHarness().allValues];
  });
  return accounts;
}

BOOL DSHHarnessIsCredentialAccount(id value) {
  NSString *account = DSHCatalogString(value);
  return account != nil && [DSHHarnessCredentialAccounts() containsObject:account];
}

NSString *DSHCredentialAccountForHarnessId(id harnessId) {
  NSString *key = DSHCatalogString(harnessId);
  return key == nil ? nil : DSHCatalogAccountByHarness()[key];
}

static NSArray *DSHDshDefaultModels(void) {
  return @[
    @{@"id": @"deepseek-v4-flash", @"name": @"V4 Flash", @"supports_images": @YES},
    @{@"id": @"deepseek-v4-pro", @"name": @"V4 Pro", @"supports_images": @NO},
    @{@"id": @"deepseek-v4-flash-vision-exp", @"name": @"Flash Exp", @"supports_images": @YES},
  ];
}
static NSArray *_Nullable DSHValidateDshModels(id value, BOOL retired) {
  if (![value isKindOfClass:NSArray.class] || [value count] > (retired ? 256 : 32) || (!retired && [value count] == 0)) return nil;
  NSMutableSet *seen = [NSMutableSet set];
  NSMutableArray *result = [NSMutableArray array];
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$" options:0 error:nil];
  for (id row in value) {
    if (![row isKindOfClass:NSDictionary.class] || [row count] != 3) return nil;
    NSString *model = row[@"id"], *name = row[@"name"];
    id images = row[@"supports_images"];
    if (![model isKindOfClass:NSString.class] || ![name isKindOfClass:NSString.class] ||
        [pattern numberOfMatchesInString:model options:0 range:NSMakeRange(0, model.length)] != 1 ||
        [seen containsObject:model] || (DSHCatalogHarnessByModel()[model] && ![DSHCatalogHarnessByModel()[model] isEqual:@"dsh"]) ||
        ![images isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)images) != CFBooleanGetTypeID()) return nil;
    name = [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (name.length < 1 || name.length > 80 || [name rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return nil;
    [seen addObject:model];
    [result addObject:@{@"id":model, @"name":name, @"supports_images":images}];
  }
  return result;
}
NSDictionary *DSHDshModelCatalog(void) {
  NSDictionary *value = [NSUserDefaults.standardUserDefaults dictionaryForKey:@"rish.dsh-models.v1"];
  if (!value) return @{@"schema_version":@1, @"models":DSHDshDefaultModels(), @"retired_models":@[]};
  if (![value[@"schema_version"] isKindOfClass:NSNumber.class] || [value[@"schema_version"] doubleValue] != 1 ||
      !DSHValidateDshModels(value[@"models"], NO) || !DSHValidateDshModels(value[@"retired_models"], YES)) return nil;
  return value;
}
NSDictionary *DSHDshModelEntry(NSString *model) {
  NSDictionary *value = DSHDshModelCatalog();
  for (NSArray *rows in @[value[@"models"] ?: @[], value[@"retired_models"] ?: @[], DSHDshDefaultModels()]) {
    for (NSDictionary *row in rows) if ([row[@"id"] isEqual:model]) return row;
  }
  return nil;
}
BOOL DSHDshModelSupportsImages(NSString *model) { return [DSHDshModelEntry(model)[@"supports_images"] boolValue]; }
NSDictionary *DSHSaveDshModelCatalog(NSDictionary *request) {
  if (![request isKindOfClass:NSDictionary.class] || request.count != 2 ||
      ![request[@"schema_version"] isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)request[@"schema_version"]) == CFBooleanGetTypeID() ||
      [request[@"schema_version"] doubleValue] != 1) return nil;
  NSArray *models = DSHValidateDshModels(request[@"models"], NO);
  if (!models) return nil;
  @synchronized(NSUserDefaults.standardUserDefaults) {
    NSDictionary *old = DSHDshModelCatalog();
    if (!old) return nil;
    NSMutableDictionary *known = [NSMutableDictionary dictionary];
    for (NSArray *rows in @[DSHDshDefaultModels(), old[@"retired_models"], old[@"models"]])
      for (NSDictionary *row in rows) known[row[@"id"]] = row;
    for (NSDictionary *row in models) [known removeObjectForKey:row[@"id"]];
    if (known.count > 256) return nil;
    NSMutableArray *retired = [NSMutableArray array];
    for (NSString *key in [known.allKeys sortedArrayUsingSelector:@selector(compare:)]) [retired addObject:known[key]];
    NSDictionary *saved = @{@"schema_version":@1, @"models":models, @"retired_models":retired};
    [NSUserDefaults.standardUserDefaults setObject:saved forKey:@"rish.dsh-models.v1"];
    return saved;
  }
}
