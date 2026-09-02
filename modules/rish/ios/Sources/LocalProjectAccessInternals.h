#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Internal helpers extracted from the container-anchored path walker in
// LocalProjectAccess.mm so the container-root derivation can be unit-tested
// against the real-device and simulator path layouts. Not part of the
// runtime API surface.

/// Returns the 0-based index of the app-container root component within
/// `targetPath`'s path components when `targetPath` lies at or inside the
/// well-formed app container rooted at `containerRootPath`
/// (…/Containers/Data/Application/<UUID>), or NSNotFound when the root is
/// malformed, the target lies outside it, or either input is nil.
FOUNDATION_EXPORT NSUInteger DSHContainerAnchorSegmentCountForPaths(
    NSString *_Nullable targetPath, NSString *_Nullable containerRootPath);

/// Returns the 0-based index of the last well-formed app-container root
/// component (…/Containers/Data/Application/<UUID>) in `path`'s components,
/// or NSNotFound. Shape-matching fallback used only when the system API
/// cannot provide a container root.
FOUNDATION_EXPORT NSUInteger DSHContainerRootScanSegmentCount(
    NSString *_Nullable path);

/// Native-only root-reference validation used by the workspace-routed Git and
/// Project Context cores. The exact four-key shape mirrors WorkspaceRootRefV1;
/// this helper intentionally accepts no path, URL, bookmark, descriptor, or
/// private authority material.
FOUNDATION_EXPORT BOOL DSHLocalProjectAccessValidateWorkspaceRootRefV1(
    NSDictionary *_Nullable rootRef,
    BOOL projectRequired,
    NSError *_Nullable *_Nullable error);

/// Parses the private authority's canonical unsigned decimal identity fields.
/// Native persisted records use strings; the parser also accepts integral
/// NSNumber values emitted by older in-process snapshot records so migration
/// checks remain deterministic. Signs, leading zeroes, fractions, booleans,
/// and overflow are rejected; zero is a valid unsigned spelling.
FOUNDATION_EXPORT BOOL DSHLocalProjectAccessParseCanonicalUInt64(
    id _Nullable value,
    unsigned long long *_Nullable valueOut);

NS_ASSUME_NONNULL_END
