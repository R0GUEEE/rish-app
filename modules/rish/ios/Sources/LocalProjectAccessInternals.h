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

NS_ASSUME_NONNULL_END
