#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSDictionary *_Nullable DSHDshModelCatalog(void);
FOUNDATION_EXPORT NSDictionary *_Nullable DSHSaveDshModelCatalog(NSDictionary *request);
FOUNDATION_EXPORT NSDictionary *_Nullable DSHDshModelEntry(NSString *model);
FOUNDATION_EXPORT BOOL DSHDshModelSupportsImages(NSString *model);

/// Built-in catalog of the built-in Rish Harnesses, the provider models they
/// serve, and the provider identity recorded on receipts, project-context
/// consent, and runtime proof. This is the single native mirror of
/// apps/mobile/src/harness/types.ts; every closed-shape validator resolves
/// model ids, harness ids, provider ids, and provider hosts through it
/// instead of carrying its own list. DSH model identities additionally use the device model catalog.

/// These functions describe built-in logical model slots and official defaults.
/// A custom request's actual endpoint/model identity is its immutable
/// provider_configuration binding, never a mutation of this legacy catalog.
/// All model ids across the four built-in Harnesses.
FOUNDATION_EXPORT NSSet<NSString *> *DSHHarnessSupportedModels(void);
FOUNDATION_EXPORT BOOL DSHHarnessIsSupportedModel(id _Nullable value);

/// "dsh" | "claude-code" | "codex" | "glm".
FOUNDATION_EXPORT NSSet<NSString *> *DSHHarnessSupportedHarnessIds(void);
FOUNDATION_EXPORT BOOL DSHHarnessIsSupportedHarnessId(id _Nullable value);

/// The Harness that catalogs `model`, or nil for an unknown model.
FOUNDATION_EXPORT NSString *_Nullable DSHHarnessIdForModel(id _Nullable model);

/// "deepseek" | "anthropic" | "openai" | "bigmodel".
FOUNDATION_EXPORT NSSet<NSString *> *DSHHarnessSupportedProviderIds(void);
FOUNDATION_EXPORT BOOL DSHHarnessIsProviderId(id _Nullable value);
FOUNDATION_EXPORT NSString *_Nullable DSHProviderIdForHarnessId(id _Nullable harnessId);
FOUNDATION_EXPORT NSString *_Nullable DSHProviderIdForModel(id _Nullable model);

/// "api.deepseek.com" | "api.anthropic.com" | "api.openai.com" | "open.bigmodel.cn".
FOUNDATION_EXPORT NSSet<NSString *> *DSHHarnessSupportedProviderHosts(void);
FOUNDATION_EXPORT BOOL DSHHarnessIsProviderHost(id _Nullable value);
FOUNDATION_EXPORT NSString *_Nullable DSHProviderHostForProviderId(id _Nullable providerId);
FOUNDATION_EXPORT NSString *_Nullable DSHProviderHostForModel(id _Nullable model);

/// Keychain account (credential slot) for a Harness:
/// DEEPSEEK_API_KEY | ANTHROPIC_API_KEY | OPENAI_API_KEY | BIGMODEL_API_KEY. The Keychain
/// service name stays owned by LocalRuntimeModule and never changes.
FOUNDATION_EXPORT NSSet<NSString *> *DSHHarnessCredentialAccounts(void);
FOUNDATION_EXPORT BOOL DSHHarnessIsCredentialAccount(id _Nullable value);
FOUNDATION_EXPORT NSString *_Nullable DSHCredentialAccountForHarnessId(id _Nullable harnessId);

NS_ASSUME_NONNULL_END
