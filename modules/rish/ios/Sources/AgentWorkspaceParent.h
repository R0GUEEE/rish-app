#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Opens an existing parent, or returns -1 with a side-effect-free creation
/// plan when a parent is missing. A returned descriptor belongs to the caller.
FOUNDATION_EXPORT int DSHAgentWorkspaceProbeParent(
    int rootDescriptor, NSArray<NSString *> *components,
    NSDictionary *_Nullable *_Nullable missingPlan, NSError **error);

FOUNDATION_EXPORT BOOL DSHAgentWorkspaceValidateParentPlan(
    NSDictionary *plan, NSArray<NSString *> *components, NSError **error);

/// A same-identity anchor plus an absent first planned parent proves none of
/// this plan's directory effects remain. Existing/symlink entries never do.
FOUNDATION_EXPORT BOOL DSHAgentWorkspaceParentPlanRemainsAbsent(
    int rootDescriptor, NSArray<NSString *> *components, NSDictionary *plan,
    BOOL *absent, NSError **error);

/// Native-only ownership of directories created by one approved write.
/// Deallocation closes descriptors; cleanup is always explicit and never
/// deletes adopted directories or recursively removes content.
@interface DSHAgentWorkspaceParentCreation : NSObject
- (instancetype)initWithRootDescriptor:(int)rootDescriptor
                            components:(NSArray<NSString *> *)components
                                  plan:(NSDictionary *)plan;
- (BOOL)openParentWithError:(NSError **)error;
- (int)duplicateParentDescriptor;
- (BOOL)validateParentWithError:(NSError **)error;
- (BOOL)removeCreatedDirectoriesWithError:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
