#import "RishHarnessCatalog.h"

static NSString *const DSHCatalogHarnessDsh = @"dsh";
static NSString *const DSHCatalogHarnessClaudeCode = @"claude-code";
static NSString *const DSHCatalogHarnessCodex = @"codex";
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
  static NSSet<NSString *> *models = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    models = [NSSet setWithArray:DSHCatalogHarnessByModel().allKeys];
  });
  return models;
}

BOOL DSHHarnessIsSupportedModel(id value) {
  NSString *model = DSHCatalogString(value);
  return model != nil && DSHCatalogHarnessByModel()[model] != nil;
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
  return key == nil ? nil : DSHCatalogHarnessByModel()[key];
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
