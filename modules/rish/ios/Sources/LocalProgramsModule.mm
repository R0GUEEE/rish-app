#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import "RuntimeProgramService.h"
#import "RuntimeWorkspaceSnapshot.h"

@interface LocalProgramsModule : NSObject <RCTBridgeModule>
@end
@implementation LocalProgramsModule
RCT_EXPORT_MODULE(LocalPrograms)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (void)deliver:(NSDictionary *)result error:(NSError *)error resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
  if (result) { resolve(result); return; }
  NSString *code = [error.domain isEqual:DSHRuntimeProgramErrorDomain]
      ? DSHRuntimeProgramError(error.userInfo[@"code"]).userInfo[@"code"] : @"E_PROGRAM_NATIVE";
  reject(code, code, nil);
}
RCT_REMAP_METHOD(startProgram, startProgram:(id)request resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSDictionary *result = [DSHRuntimeProgramService.sharedService startRequest:request error:&error];
  [self deliver:result error:error resolve:resolve reject:reject];
}
RCT_REMAP_METHOD(programStatus, programStatus:(id)request resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSDictionary *result = [DSHRuntimeProgramService.sharedService statusRequest:request error:&error];
  [self deliver:result error:error resolve:resolve reject:reject];
}
RCT_REMAP_METHOD(stopProgram, stopProgram:(id)request resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSDictionary *result = [DSHRuntimeProgramService.sharedService stopRequest:request error:&error];
  [self deliver:result error:error resolve:resolve reject:reject];
}
@end
