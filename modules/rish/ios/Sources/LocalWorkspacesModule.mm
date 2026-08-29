#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#import "LocalWorkspaceAccess.h"

#include <CoreFoundation/CoreFoundation.h>

@interface LocalWorkspacesModule : NSObject <RCTBridgeModule>
@property(nonatomic, strong) dispatch_queue_t workspaceQueue;
@property(nonatomic, strong) DSHLocalWorkspaceAccess *access;
@end

@implementation LocalWorkspacesModule

RCT_EXPORT_MODULE(LocalWorkspaces)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _workspaceQueue = dispatch_queue_create(
        "dev.zseven.rish.local-workspaces",
        DISPATCH_QUEUE_SERIAL);
    NSError *error = nil;
    NSURL *support = [[NSFileManager defaultManager]
        URLForDirectory:NSApplicationSupportDirectory
        inDomain:NSUserDomainMask
        appropriateForURL:nil
        create:YES
        error:&error];
    if (support != nil) {
      _access = [[DSHLocalWorkspaceAccess alloc]
          initWithPrivateRootURL:support
          clock:^NSDate *{
            return NSDate.date;
          }
          UUIDGenerator:^NSString *{
            return NSUUID.UUID.UUIDString.lowercaseString;
          }
          legacyResolver:^BOOL(
              NSString *projectId,
              NSString *__autoreleasing *identityDigest,
              NSSet<NSString *> *__autoreleasing *capabilities,
              NSError *__autoreleasing *resolverError) {
            (void)projectId;
            (void)identityDigest;
            (void)capabilities;
            if (resolverError != nil) {
              *resolverError = [NSError errorWithDomain:
                  @"LocalWorkspaces"
                                      code:1
                                  userInfo:@{
                                    NSLocalizedDescriptionKey :
                                        @"Legacy workspace access is not linked.",
                                  }];
            }
            return NO;
          }
          faultHook:nil];
    }
  }
  return self;
}

static NSString *LWErrorCode(NSError *error) {
  NSString *code = error.userInfo[@"code"];
  return [code isKindOfClass:NSString.class]
      ? code
      : @"E_WORKSPACE_UNAVAILABLE";
}

static NSString *LWErrorMessage(NSError *error) {
  NSString *message = error.localizedDescription;
  return [message isKindOfClass:NSString.class] && message.length > 0
      ? message
      : @"Workspace operation is unavailable.";
}

static BOOL LWSchemaVersionIsOne(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
         [value isEqual:@1];
}

- (void)reject:(RCTPromiseRejectBlock)reject error:(NSError *)error {
  if (error == nil) {
    reject(@"E_WORKSPACE_UNAVAILABLE",
           @"Workspace operation is unavailable.",
           nil);
    return;
  }
  reject(LWErrorCode(error), LWErrorMessage(error), nil);
}

- (void)rejectUnavailable:(RCTPromiseRejectBlock)reject {
  reject(@"E_WORKSPACE_UNAVAILABLE",
         @"This workspace operation is not available yet.",
         nil);
}

- (BOOL)hasExactKeys:(NSDictionary *)value keys:(NSArray<NSString *> *)keys {
  if (![value isKindOfClass:NSDictionary.class] || value.count != keys.count) {
    return NO;
  }
  NSSet *expected = [NSSet setWithArray:keys];
  for (id key in value) {
    if (![key isKindOfClass:NSString.class] || ![expected containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

RCT_REMAP_METHOD(list,
                 listWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSError *error = nil;
    if (self.access == nil || ![self.access ensurePrivateLayoutWithError:&error]) {
      [self reject:reject error:error];
      return;
    }
    NSArray<NSDictionary *> *workspaces =
        [self.access listWorkspaceMetadataWithError:&error];
    if (workspaces == nil) {
      [self reject:reject error:error];
      return;
    }
    resolve(@{ @"schema_version" : @1, @"workspaces" : workspaces });
  });
}

RCT_REMAP_METHOD(resolveMetadata,
                 resolveMetadataRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSDictionary *request = [requestValue isKindOfClass:NSDictionary.class]
        ? requestValue
        : nil;
    NSArray<NSString *> *keys = @[
      @"schema_version", @"workspace_id", @"expected_binding_revision",
      @"required_capabilities",
    ];
    id revision = request[@"expected_binding_revision"];
    if (![self hasExactKeys:request keys:keys] ||
        !LWSchemaVersionIsOne(request[@"schema_version"]) ||
        (revision != NSNull.null && ![revision isKindOfClass:NSNumber.class])) {
      NSError *error = [NSError errorWithDomain:
          @"LocalWorkspaces"
                              code:1
                          userInfo:@{
                            @"code" : @"E_WORKSPACE_INVALID",
                            NSLocalizedDescriptionKey :
                                @"Workspace request is invalid.",
                          }];
      [self reject:reject error:error];
      return;
    }
    NSError *error = nil;
    NSDictionary *result = [self.access
        resolveWorkspaceId:request[@"workspace_id"]
        expectedBindingRevision:revision == NSNull.null ? nil : revision
        requiredCapabilities:request[@"required_capabilities"]
        error:&error];
    if (result == nil) {
      [self reject:reject error:error];
      return;
    }
    resolve(result);
  });
}

// Compatibility alias for older JS callers. New code must use resolveMetadata
// with the exact request envelope.
RCT_REMAP_METHOD(resolve,
                 resolveWorkspaceRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSDictionary *request = [requestValue isKindOfClass:NSDictionary.class]
      ? requestValue
      : ( [requestValue isKindOfClass:NSString.class]
            ? @{
                @"schema_version" : @1,
                @"workspace_id" : requestValue,
                @"expected_binding_revision" : NSNull.null,
                @"required_capabilities" : @[],
              }
            : nil);
  [self resolveMetadataRequest:request resolver:resolve rejecter:reject];
}

RCT_REMAP_METHOD(queryOperation,
                 queryOperationRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSDictionary *request = [requestValue isKindOfClass:NSDictionary.class]
        ? requestValue
        : nil;
    if (![self hasExactKeys:request keys:@[ @"schema_version", @"operation_id" ]] ||
        !LWSchemaVersionIsOne(request[@"schema_version"])) {
      NSError *error = [NSError errorWithDomain:
          @"LocalWorkspaces"
                              code:1
                          userInfo:@{
                            @"code" : @"E_WORKSPACE_INVALID",
                            NSLocalizedDescriptionKey :
                                @"Workspace request is invalid.",
                          }];
      [self reject:reject error:error];
      return;
    }
    NSError *error = nil;
    NSDictionary *result = [self.access queryOperationId:request[@"operation_id"]
                                                   error:&error];
    if (result == nil) {
      [self reject:reject error:error];
      return;
    }
    resolve(result);
  });
}

// Task B exposes only the Rish-owned create vertical slice. Picker/import/
// regrant and destructive authority mutations remain fail-closed until their
// bounded native lifetimes and schema-8 clearance receipts are implemented.
RCT_REMAP_METHOD(create,
                 createWorkspaceRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.workspaceQueue, ^{
    NSDictionary *request = [requestValue isKindOfClass:NSDictionary.class]
        ? requestValue
        : nil;
    NSArray<NSString *> *keys = @[
      @"schema_version", @"display_name", @"operation_id",
    ];
    if (![self hasExactKeys:request keys:keys] ||
        !LWSchemaVersionIsOne(request[@"schema_version"]) ||
        ![request[@"display_name"] isKindOfClass:NSString.class] ||
        ![request[@"operation_id"] isKindOfClass:NSString.class]) {
      NSError *error = [NSError errorWithDomain:@"LocalWorkspaces"
                                            code:1
                                        userInfo:@{
                                          @"code" : @"E_WORKSPACE_INVALID",
                                          NSLocalizedDescriptionKey :
                                              @"Workspace request is invalid.",
                                        }];
      [self reject:reject error:error];
      return;
    }
    NSError *error = nil;
    NSDictionary *descriptor =
        [self.access createRishOwnedWorkspaceWithDisplayName:
                       request[@"display_name"]
                                               operationId:
                                                   request[@"operation_id"]
                                                     error:&error];
    if (descriptor == nil) {
      [self reject:reject error:error];
      return;
    }
    resolve(descriptor);
  });
}

RCT_REMAP_METHOD(presentFolderPicker,
                 presentFolderPickerRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  (void)requestValue;
  (void)resolve;
  [self rejectUnavailable:reject];
}

RCT_REMAP_METHOD(grantFolder,
                 grantFolderRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  (void)requestValue;
  (void)resolve;
  [self rejectUnavailable:reject];
}

RCT_REMAP_METHOD(importFolder,
                 importFolderRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  (void)requestValue;
  (void)resolve;
  [self rejectUnavailable:reject];
}

RCT_REMAP_METHOD(forget,
                 forgetWorkspaceRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  (void)requestValue;
  (void)resolve;
  [self rejectUnavailable:reject];
}

RCT_REMAP_METHOD(deleteOwnedContent,
                 deleteOwnedContentRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  (void)requestValue;
  (void)resolve;
  [self rejectUnavailable:reject];
}

RCT_REMAP_METHOD(cancelPicker,
                 cancelPickerRequest:(id)requestValue
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  (void)requestValue;
  (void)resolve;
  [self rejectUnavailable:reject];
}

@end
