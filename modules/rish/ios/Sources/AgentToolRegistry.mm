#import "AgentToolRegistry.h"

#import "AgentNativeWAL.h"
#import "AgentRootResolver.h"

#include <CoreFoundation/CoreFoundation.h>

static NSArray<NSDictionary *> *DSHAgentNativeToolDescriptors(void) {
  static NSArray<NSDictionary *> *descriptors;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    // This table is deliberately native-only.  Parameter names and schemas
    // are required to build the provider request/digest, but are never
    // copied into the safe registry projection or an RN result.
    descriptors = @[
      @{
        @"schema_version" : @1,
        @"name" : @"git_commit",
        @"required_capability" : @"git_commit",
        @"effect" : @"git_commit",
        @"safe_summary_key" : @"agent.git_commit",
        @"parameters" : @{
          @"type" : @"object",
          @"properties" : @{
            @"message" : @{
              @"type" : @"string", @"max_utf8_bytes" : @4096,
            },
          },
          @"required" : @[ @"message" ],
        },
      },
      @{
        @"schema_version" : @1,
        @"name" : @"git_push",
        @"required_capability" : @"git_push",
        @"effect" : @"git_push",
        @"safe_summary_key" : @"agent.git_push",
        @"fixed_remote" : @"origin",
        @"parameters" : @{
          @"type" : @"object", @"properties" : @{}, @"required" : @[],
        },
      },
      @{
        @"schema_version" : @1,
        @"name" : @"git_status",
        @"required_capability" : @"git_status",
        @"effect" : @"read",
        @"safe_summary_key" : @"agent.git_status",
        @"parameters" : @{
          @"type" : @"object", @"properties" : @{}, @"required" : @[],
        },
      },
      @{
        @"schema_version" : @1,
        @"name" : @"list_dir",
        @"required_capability" : @"file_read",
        @"effect" : @"read",
        @"safe_summary_key" : @"agent.list_dir",
        @"parameters" : @{
          @"type" : @"object",
          @"properties" : @{
            @"path" : @{
              @"type" : @"string", @"max_utf8_bytes" : @4096,
            },
          },
          @"required" : @[ @"path" ],
        },
      },
      @{
        @"schema_version" : @1,
        @"name" : @"read_file",
        @"required_capability" : @"file_read",
        @"effect" : @"read",
        @"safe_summary_key" : @"agent.read_file",
        @"parameters" : @{
          @"type" : @"object",
          @"properties" : @{
            @"path" : @{
              @"type" : @"string", @"max_utf8_bytes" : @4096,
            },
          },
          @"required" : @[ @"path" ],
        },
      },
      @{
        @"schema_version" : @1,
        @"name" : @"write_file",
        @"required_capability" : @"file_write",
        @"effect" : @"write",
        @"safe_summary_key" : @"agent.write_file",
        @"parameters" : @{
          @"type" : @"object",
          @"properties" : @{
            @"path" : @{
              @"type" : @"string", @"max_utf8_bytes" : @4096,
            },
            @"content" : @{
              @"type" : @"string", @"max_utf8_bytes" : @32768,
            },
            @"expected_revision" : @{
              @"type" : @[ @"string", @"null" ],
              @"max_utf8_bytes" : @256,
            },
          },
          @"required" : @[ @"path", @"content", @"expected_revision" ],
        },
      },
    ];
  });
  return descriptors;
}

static NSDictionary *DSHAgentNativeDescriptorForName(NSString *name) {
  for (NSDictionary *descriptor in DSHAgentNativeToolDescriptors()) {
    if ([descriptor[@"name"] isEqual:name]) return descriptor;
  }
  return nil;
}

static BOOL DSHAgentRegistryCapabilitySet(id value,
                                          NSSet<NSString *> **setOut) {
  if (![value isKindOfClass:NSArray.class] || [value count] > 5) return NO;
  NSSet *allowed = [NSSet setWithArray:@[
    @"file_read", @"file_write", @"git_status", @"git_commit", @"git_push",
  ]];
  NSMutableSet *set = [NSMutableSet set];
  for (id item in value) {
    if (![item isKindOfClass:NSString.class] || ![allowed containsObject:item] ||
        [set containsObject:item]) return NO;
    [set addObject:item];
  }
  if (setOut != nullptr) *setOut = [set copy];
  return YES;
}

static NSString *DSHAgentRegistryAccessForName(NSString *name,
                                               NSSet<NSString *> *capabilities,
                                               BOOL project) {
  NSDictionary *required = @{
    @"list_dir" : @"file_read",
    @"read_file" : @"file_read",
    @"write_file" : @"file_write",
    @"git_status" : @"git_status",
    @"git_commit" : @"git_commit",
    @"git_push" : @"git_push",
  };
  NSString *capability = required[name];
  if (capability == nil || ![capabilities containsObject:capability] ||
      ([name hasPrefix:@"git_"] && !project)) return nil;
  if ([name isEqualToString:@"list_dir"] ||
      [name isEqualToString:@"read_file"] ||
      [name isEqualToString:@"git_status"]) return @"auto";
  if ([name isEqualToString:@"git_push"]) return @"confirm_once";
  return @"conversation_confirm";
}

static NSDictionary *DSHAgentSafeToolProjection(NSDictionary *descriptor,
                                                NSString *access) {
  return @{
    @"schema_version" : @2,
    @"name" : descriptor[@"name"],
    @"safe_summary_key" : descriptor[@"safe_summary_key"],
    @"access" : access,
  };
}

static NSDictionary *DSHAgentDurableDenyProjection(NSString *name) {
  NSString *safeName = [name isKindOfClass:NSString.class] && name.length > 0
      ? name : @"unknown";
  // `name` is intentionally bounded and opaque; it is not a path or payload.
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:
          @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"]
      invertedSet];
  if (safeName.length > 64 ||
      [safeName rangeOfCharacterFromSet:invalid].location != NSNotFound) {
    safeName = @"unknown";
  }
  return @{
    @"schema_version" : @2,
    @"name" : safeName,
    @"safe_summary_key" : @"agent.unknown",
    @"access" : @"durable_deny",
  };
}

static BOOL DSHAgentKnownToolName(NSString *name) {
  return [@[ @"list_dir", @"read_file", @"write_file", @"git_status",
             @"git_commit", @"git_push" ] containsObject:name];
}

static BOOL DSHAgentRegistryShape(NSDictionary *registry,
                                  NSDictionary *root,
                                  NSError **error) {
  if (!DSHAgentIsImmutableFoundationJSON(registry) ||
      !DSHAgentExactDictionaryKeys(registry, @[
        @"schema_version", @"registry_version", @"toolset_sha256", @"tools",
      ]) || ![registry[@"schema_version"] isEqual:@2] ||
      ![registry[@"registry_version"] isEqual:@1] ||
      !DSHAgentCanonicalSHA256(registry[@"toolset_sha256"]) ||
      ![registry[@"tools"] isKindOfClass:NSArray.class] ||
      [registry[@"tools"] count] > 6 ||
      ![DSHAgentRootResolver validateAgentRootProjection:root error:error]) {
    if (error != nullptr && *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    }
    return NO;
  }
  NSSet *rootCapabilities = nil;
  if (!DSHAgentRegistryCapabilitySet(root[@"capabilities"], &rootCapabilities)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return NO;
  }
  BOOL project = [root[@"kind"] isEqualToString:@"project"];
  NSString *previous = nil;
  NSMutableSet *names = [NSMutableSet set];
  for (NSDictionary *tool in registry[@"tools"]) {
    if (!DSHAgentExactDictionaryKeys(tool, @[
          @"schema_version", @"name", @"safe_summary_key", @"access",
        ]) || ![tool[@"schema_version"] isEqual:@2] ||
        ![tool[@"name"] isKindOfClass:NSString.class] ||
        !DSHAgentBoundedUTF8String(tool[@"safe_summary_key"], 128, NO, nullptr) ||
        !DSHAgentKnownToolName(tool[@"name"]) ||
        [names containsObject:tool[@"name"]] ||
        (previous != nil && [previous compare:tool[@"name"]
                                  options:NSLiteralSearch] != NSOrderedAscending)) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
      return NO;
    }
    NSString *access = DSHAgentRegistryAccessForName(tool[@"name"],
                                                      rootCapabilities,
                                                      project);
    if (access == nil || ![access isEqual:tool[@"access"]]) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
      return NO;
    }
    [names addObject:tool[@"name"]];
    previous = tool[@"name"];
  }
  return YES;
}

@interface DSHAgentToolRegistry ()
@property(nonatomic, copy, readwrite) NSString *toolsetSHA256;
@property(nonatomic, copy) NSArray<NSDictionary *> *nativeDescriptors;
@end

@implementation DSHAgentToolRegistry

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _nativeDescriptors = [DSHAgentNativeToolDescriptors() copy];
    NSError *error = nil;
    NSData *canonical = DSHAgentCanonicalJSON(@{
      @"registry_version" : @1,
      @"tools" : _nativeDescriptors,
    }, &error);
    _toolsetSHA256 = DSHAgentHJ(@"agent-toolset", @{
      @"registry_version" : @1,
      @"tools" : _nativeDescriptors,
    }, &error);
    if (canonical == nil || !DSHAgentCanonicalSHA256(_toolsetSHA256)) {
      _toolsetSHA256 = @"";
    }
  }
  return self;
}

- (nullable NSDictionary *)registryForRoot:(NSDictionary *)root
                                     error:(NSError **)error {
  if (![DSHAgentRootResolver validateAgentRootProjection:root error:error] ||
      !DSHAgentCanonicalSHA256(self.toolsetSHA256)) {
    if (error != nullptr && *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    }
    return nil;
  }
  NSSet *capabilities = nil;
  if (!DSHAgentRegistryCapabilitySet(root[@"capabilities"], &capabilities)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  BOOL project = [root[@"kind"] isEqualToString:@"project"];
  NSMutableArray *tools = [NSMutableArray array];
  for (NSDictionary *descriptor in self.nativeDescriptors) {
    NSString *access = DSHAgentRegistryAccessForName(descriptor[@"name"],
                                                      capabilities,
                                                      project);
    if (access != nil) [tools addObject:DSHAgentSafeToolProjection(descriptor, access)];
  }
  // The descriptor table above is ASCII sorted; sort again so this invariant
  // remains true if a future table edit changes its source order.
  [tools sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                  NSDictionary *right) {
    return [left[@"name"] compare:right[@"name"] options:NSLiteralSearch];
  }];
  NSDictionary *registry = @{
    @"schema_version" : @2,
    @"registry_version" : @1,
    @"toolset_sha256" : self.toolsetSHA256,
    @"tools" : [tools copy],
  };
  if (!DSHAgentRegistryShape(registry, root, error)) return nil;
  return registry;
}

- (nullable NSDictionary *)policyForRoot:(NSDictionary *)root
                                    error:(NSError **)error {
  if (![DSHAgentRootResolver validateAgentRootProjection:root error:error]) {
    return nil;
  }
  return @{
    @"schema_version" : @1,
    @"policy_version" : @"agent-v1",
    @"max_single_write_bytes" : @32768,
    @"max_batch_write_bytes" : @524288,
    @"max_attempt_write_bytes" : @4194304,
  };
}

- (nullable NSDictionary *)descriptorForToolName:(NSString *)name
                                             root:(NSDictionary *)root
                                            error:(NSError **)error {
  if (![DSHAgentRootResolver validateAgentRootProjection:root error:error] ||
      !DSHAgentBoundedUTF8String(name, 64, NO, nullptr)) {
    if (error != nullptr && *error == nil) {
      DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    }
    return nil;
  }
  NSDictionary *native = DSHAgentNativeDescriptorForName(name);
  if (native == nil) return DSHAgentDurableDenyProjection(name);
  NSSet *capabilities = nil;
  if (!DSHAgentRegistryCapabilitySet(root[@"capabilities"], &capabilities)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSString *access = DSHAgentRegistryAccessForName(
      name, capabilities, [root[@"kind"] isEqualToString:@"project"]);
  return access == nil ? DSHAgentDurableDenyProjection(name)
                       : DSHAgentSafeToolProjection(native, access);
}

- (nullable NSDictionary *)nativeDescriptorForToolName:(NSString *)name
                                                 error:(NSError **)error {
  if (!DSHAgentBoundedUTF8String(name, 64, NO, nullptr)) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return nil;
  }
  NSDictionary *descriptor = DSHAgentNativeDescriptorForName(name);
  if (descriptor == nil) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorNotFound);
    return nil;
  }
  return descriptor;
}

- (BOOL)validateToolsetSHA256:(NSString *)toolsetSHA256 error:(NSError **)error {
  if (!DSHAgentCanonicalSHA256(toolsetSHA256) ||
      ![toolsetSHA256 isEqualToString:self.toolsetSHA256]) {
    DSHSetAgentNativeStoreError(error, DSHAgentNativeStoreErrorConflict);
    return NO;
  }
  return YES;
}

+ (BOOL)validateRegistryProjection:(NSDictionary *)registry
                               root:(NSDictionary *)root
                              error:(NSError **)error {
  DSHAgentToolRegistry *instance = [[self alloc] init];
  return DSHAgentRegistryShape(registry, root, error) &&
      [instance validateToolsetSHA256:registry[@"toolset_sha256"] error:error];
}

@end
