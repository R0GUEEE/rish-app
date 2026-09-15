#import "AgentWorkspaceParent.h"
#import "AgentNativeWAL.h"
#import "AgentWriteParentPlan.h"

#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

static void DSHParentError(NSError **error, DSHAgentNativeStoreErrorCode code) {
  DSHSetAgentNativeStoreError(error, code);
}

static NSString *DSHParentPathDigest(NSArray<NSString *> *components, NSUInteger depth) {
  NSString *path = [[components subarrayWithRange:NSMakeRange(0, depth)]
      componentsJoinedByString:@"/"];
  return DSHAgentHB(@"relative-path", [path dataUsingEncoding:NSUTF8StringEncoding], nil);
}

static NSString *DSHParentIdentity(int descriptor, NSArray<NSString *> *components,
                                   NSUInteger depth) {
  struct stat state = {};
  if (fstat(descriptor, &state) != 0 || !S_ISDIR(state.st_mode)) return nil;
  return DSHAgentHJ(@"write-parent-anchor", @{
    @"relative_path_sha256" : DSHParentPathDigest(components, depth),
    @"device_id" : [NSString stringWithFormat:@"%llu", (unsigned long long)state.st_dev],
    @"inode_id" : [NSString stringWithFormat:@"%llu", (unsigned long long)state.st_ino],
  }, nil);
}

static int DSHOpenParentChild(int parent, NSString *name) {
  int child = openat(parent, name.fileSystemRepresentation,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (child < 0) return -1;
  struct stat opened = {};
  struct stat linked = {};
  if (fstat(child, &opened) != 0 || !S_ISDIR(opened.st_mode) ||
      fstatat(parent, name.fileSystemRepresentation, &linked, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(linked.st_mode) || linked.st_dev != opened.st_dev || linked.st_ino != opened.st_ino) {
    close(child);
    errno = ESTALE;
    return -1;
  }
  return child;
}

int DSHAgentWorkspaceProbeParent(int rootDescriptor, NSArray<NSString *> *components,
                                NSDictionary **missingPlan, NSError **error) {
  if (missingPlan != nullptr) *missingPlan = nil;
  if (components.count == 0) {
    DSHParentError(error, DSHAgentNativeStoreErrorInvalidArgument);
    return -1;
  }
  int current = dup(rootDescriptor);
  if (current < 0) {
    DSHParentError(error, DSHAgentNativeStoreErrorPersistence);
    return -1;
  }
  for (NSUInteger index = 0; index + 1 < components.count; index++) {
    int next = DSHOpenParentChild(current, components[index]);
    if (next >= 0) { close(current); current = next; continue; }
    int failure = errno;
    struct stat entry = {};
    BOOL absent = failure == ENOENT &&
        fstatat(current, components[index].fileSystemRepresentation, &entry,
            AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
    NSUInteger missingCount = components.count - 1 - index;
    NSString *identity = absent ? DSHParentIdentity(current, components, index) : nil;
    close(current);
    if (!absent || identity == nil || missingCount > 32) {
      DSHParentError(error, absent && missingCount > 32
          ? DSHAgentNativeStoreErrorCapacity : DSHAgentNativeStoreErrorInvalidArgument);
      return -1;
    }
    NSMutableArray *paths = [NSMutableArray array];
    for (NSUInteger depth = index + 1; depth < components.count; depth++) {
      [paths addObject:DSHParentPathDigest(components, depth)];
    }
    if (missingPlan != nullptr) *missingPlan = @{
      @"schema_version" : @1, @"ancestor_depth" : @(index),
      @"ancestor_identity_sha256" : identity, @"missing_parent_path_sha256" : [paths copy],
    };
    return -1;
  }
  return current;
}

BOOL DSHAgentWorkspaceValidateParentPlan(NSDictionary *plan, NSArray<NSString *> *components,
                                       NSError **error) {
  if (!DSHAgentWriteParentPlan(plan)) {
    DSHParentError(error, DSHAgentNativeStoreErrorInvalidArgument); return NO;
  }
  NSArray *paths = plan[@"missing_parent_path_sha256"];
  NSUInteger depth = [plan[@"ancestor_depth"] unsignedIntegerValue];
  if (paths.count < 1 || paths.count > 32 || components.count != depth + paths.count + 1) {
    DSHParentError(error, DSHAgentNativeStoreErrorInvalidArgument); return NO;
  }
  for (NSUInteger index = 0; index < paths.count; index++) {
    if (!DSHAgentCanonicalSHA256(paths[index]) ||
        ![paths[index] isEqual:DSHParentPathDigest(components, depth + index + 1)]) {
      DSHParentError(error, DSHAgentNativeStoreErrorConflict); return NO;
    }
  }
  return YES;
}

static int DSHOpenPlannedAnchor(int root, NSArray<NSString *> *components,
                               NSDictionary *plan, NSError **error) {
  if (!DSHAgentWorkspaceValidateParentPlan(plan, components, error)) return -1;
  int current = dup(root);
  NSUInteger depth = [plan[@"ancestor_depth"] unsignedIntegerValue];
  for (NSUInteger index = 0; current >= 0 && index < depth; index++) {
    int next = DSHOpenParentChild(current, components[index]);
    close(current); current = next;
  }
  if (current < 0 || ![DSHParentIdentity(current, components, depth)
      isEqual:plan[@"ancestor_identity_sha256"]]) {
    if (current >= 0) close(current);
    DSHParentError(error, DSHAgentNativeStoreErrorConflict); return -1;
  }
  return current;
}

BOOL DSHAgentWorkspaceParentPlanRemainsAbsent(int root, NSArray<NSString *> *components,
                                            NSDictionary *plan, BOOL *absent,
                                            NSError **error) {
  if (absent != nullptr) *absent = NO;
  int anchor = DSHOpenPlannedAnchor(root, components, plan, error);
  if (anchor < 0) return NO;
  struct stat state = {};
  NSString *first = components[[plan[@"ancestor_depth"] unsignedIntegerValue]];
  int result = fstatat(anchor, first.fileSystemRepresentation, &state, AT_SYMLINK_NOFOLLOW);
  int failure = errno;
  close(anchor);
  if (result < 0 && failure != ENOENT) {
    DSHParentError(error, DSHAgentNativeStoreErrorPersistence); return NO;
  }
  if (absent != nullptr) *absent = result < 0 && failure == ENOENT;
  return YES;
}

@interface DSHCreatedWorkspaceParent : NSObject
@property(nonatomic) int parent;
@property(nonatomic) int child;
@property(nonatomic) dev_t device;
@property(nonatomic) ino_t inode;
@property(nonatomic, copy) NSString *name;
@end
@implementation DSHCreatedWorkspaceParent
- (instancetype)init { self = [super init]; if (self) { _parent = -1; _child = -1; } return self; }
- (void)dealloc { if (_parent >= 0) close(_parent); if (_child >= 0) close(_child); }
@end

@interface DSHAgentWorkspaceParentCreation ()
@property(nonatomic) int root;
@property(nonatomic) int parent;
@property(nonatomic, copy) NSArray<NSString *> *components;
@property(nonatomic, copy) NSDictionary *plan;
@property(nonatomic, strong) NSMutableArray<DSHCreatedWorkspaceParent *> *created;
@property(nonatomic) BOOL unprovenCreation;
@end

@implementation DSHAgentWorkspaceParentCreation
- (instancetype)initWithRootDescriptor:(int)root components:(NSArray<NSString *> *)components
                                  plan:(NSDictionary *)plan {
  self = [super init];
  if (self) { _root = dup(root); _parent = -1; _components = [components copy];
    _plan = [plan copy]; _created = [NSMutableArray array]; }
  return self;
}
- (void)dealloc { if (_root >= 0) close(_root); if (_parent >= 0) close(_parent); }
- (int)duplicateParentDescriptor { return _parent < 0 ? -1 : dup(_parent); }
- (BOOL)openParentWithError:(NSError **)error {
  int current = DSHOpenPlannedAnchor(_root, _components, _plan, error);
  if (current < 0) return NO;
  NSUInteger start = [_plan[@"ancestor_depth"] unsignedIntegerValue];
  for (NSUInteger index = start; index + 1 < _components.count; index++) {
    NSString *name = _components[index];
    int next = DSHOpenParentChild(current, name);
    if (next < 0) {
      int failure = errno;
      if (failure != ENOENT) {
        close(current); DSHParentError(error, DSHAgentNativeStoreErrorConflict); return NO;
      }
      BOOL made = mkdirat(current, name.fileSystemRepresentation, 0700) == 0;
      if (!made && errno != EEXIST) {
        close(current); DSHParentError(error, DSHAgentNativeStoreErrorPersistence); return NO;
      }
      next = DSHOpenParentChild(current, name);
      if (next < 0) {
        if (made) _unprovenCreation = YES;
        close(current); DSHParentError(error, DSHAgentNativeStoreErrorConflict); return NO;
      }
      if (made) {
        struct stat state = {};
        DSHCreatedWorkspaceParent *entry = [[DSHCreatedWorkspaceParent alloc] init];
        entry.parent = dup(current); entry.child = dup(next); entry.name = name;
        if (entry.parent < 0 || entry.child < 0 || fstat(next, &state) != 0) {
          _unprovenCreation = YES;
          close(next); close(current); DSHParentError(error, DSHAgentNativeStoreErrorPersistence); return NO;
        }
        entry.device = state.st_dev; entry.inode = state.st_ino;
        [_created addObject:entry];
      }
    }
    // A sibling write may have created this planned directory first. Keep
    // that directory, but establish the same durability before using it.
    if (fsync(next) != 0 || fsync(current) != 0) {
      close(next); close(current); DSHParentError(error, DSHAgentNativeStoreErrorPersistence); return NO;
    }
    close(current); current = next;
  }
  _parent = current;
  return [self validateParentWithError:error];
}
- (BOOL)validateParentWithError:(NSError **)error {
  int anchor = DSHOpenPlannedAnchor(_root, _components, _plan, error);
  if (anchor < 0) return NO;
  int current = anchor;
  for (NSUInteger index = [_plan[@"ancestor_depth"] unsignedIntegerValue];
       current >= 0 && index + 1 < _components.count; index++) {
    int next = DSHOpenParentChild(current, _components[index]); close(current); current = next;
  }
  struct stat actual = {}, held = {};
  BOOL valid = current >= 0 && _parent >= 0 && fstat(current, &actual) == 0 &&
      fstat(_parent, &held) == 0 && actual.st_dev == held.st_dev && actual.st_ino == held.st_ino;
  if (current >= 0) close(current);
  if (!valid) DSHParentError(error, DSHAgentNativeStoreErrorConflict);
  return valid;
}
- (BOOL)removeCreatedDirectoriesWithError:(NSError **)error {
  BOOL removed = !_unprovenCreation;
  for (DSHCreatedWorkspaceParent *entry in [_created reverseObjectEnumerator]) {
    struct stat linked = {}, held = {};
    int found = fstatat(entry.parent, entry.name.fileSystemRepresentation, &linked, AT_SYMLINK_NOFOLLOW);
    if (found < 0 && errno == ENOENT) continue;
    BOOL owned = found == 0 && S_ISDIR(linked.st_mode) &&
        fstat(entry.child, &held) == 0 && linked.st_dev == entry.device &&
        linked.st_ino == entry.inode && held.st_dev == entry.device && held.st_ino == entry.inode;
    if (!owned || unlinkat(entry.parent, entry.name.fileSystemRepresentation, AT_REMOVEDIR) != 0 ||
        fsync(entry.parent) != 0) removed = NO;
  }
  [_created removeAllObjects];
  if (!removed) DSHParentError(error, DSHAgentNativeStoreErrorPersistence);
  return removed;
}
@end
