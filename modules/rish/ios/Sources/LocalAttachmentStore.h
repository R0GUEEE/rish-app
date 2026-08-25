#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Native-only attachment store contract. JavaScript receives opaque identifiers.
// ReadPayload validates the manifest, file type, size, and SHA-256 while holding
// the store lock, then returns an immutable snapshot that remains valid if the
// attachment is discarded concurrently. It is safe to call from any thread.
FOUNDATION_EXPORT NSData * _Nullable RishLocalAttachmentReadPayload(
  NSString *attachmentID,
  NSDictionary<NSString *, id> * _Nullable * _Nullable manifest,
  NSError * _Nullable * _Nullable error);

// ResolvePayload is retained for native file APIs that require a URL. The URL is
// app-owned and valid only until a concurrent discard/prune; new consumers should
// use ReadPayload so validation and consumption share one lock boundary.
FOUNDATION_EXPORT NSURL * _Nullable RishLocalAttachmentResolvePayload(
  NSString *attachmentID,
  NSDictionary<NSString *, id> * _Nullable * _Nullable manifest,
  NSError * _Nullable * _Nullable error);

FOUNDATION_EXPORT NSDictionary<NSString *, id> * _Nullable
RishLocalAttachmentLoadManifest(
  NSString *attachmentID,
  NSError * _Nullable * _Nullable error);

NS_ASSUME_NONNULL_END
