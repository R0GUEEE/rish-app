# Mobile attachment contract

Rish attachments are native-owned inputs, not JavaScript file paths. A picker
copies the selected content into the app container and returns only an opaque
attachment id plus bounded display metadata.

## Version 1 UX

- The composer `+` menu offers Camera, Photos, and Files.
- Up to six pending attachments appear above the text field and can be removed
  before sending.
- A message may contain text, attachments, or both.
- Image selection switches that conversation to Flash Exp because the other
  built-in DeepSeek models are text-only.
- Sent message cards persist attachment descriptors and recover their bounded
  thumbnails from native storage after restart.
- Draft and sent image, text, and PDF cards open a full native Quick Look
  preview and return to the same conversation when closed.

## Native storage and bridge boundary

Each attachment is published atomically at:

`Application Support/attachments/<opaque-uuid>/`

with a validated `manifest.json`, a `payload`, and an optional generated
`thumbnail.jpg`. Directories are mode `0700`, payloads are mode `0600`, and
symlinks are rejected. JavaScript never receives the provider URL, a security
scoped bookmark, an absolute container path, or the full image bytes.

For active preview, native code takes an integrity-checked payload snapshot and
writes a private `0700/0600` temporary copy with its safe original filename.
Quick Look is read-only and external links are blocked. Close, interactive
dismiss, and bridge invalidation remove the temporary copy; startup also
reclaims crash leftovers older than one hour.

The persisted descriptor contains only `id`, `kind`, `name`, `mime_type`, and
`size`. Draft thumbnails are bounded data URLs and are never written into chat
JSON. Removed drafts and deleted conversations discard their payloads; a
native prune pass removes old unreferenced staging content.

## Input limits

- Six attachments per message.
- 8 MiB per image or PDF and 24 MiB total binary input.
- 1 MiB per UTF-8 text attachment.
- A completion request accepts at most 24 attachment references and 24 MiB
  across the conversation history; oversized histories fail before networking.
- Images are decoded, orientation-normalized, metadata-stripped, and encoded
  to a supported PNG/JPEG payload before publication.
- Files selection accepts supported image, text, and PDF content only.

## Model transport

Images are resolved from opaque ids by native code and sent only to
`deepseek-v4-flash-vision-exp` as OpenAI-compatible `text` and `image_url`
content parts. Text files are appended as delimited text. PDFKit extracts a
bounded text projection; empty or scanned PDFs fail clearly instead of being
silently ignored.

Native code revalidates the manifest, file type, size, and SHA-256 under the
attachment-store lock before every request, then transports an immutable byte
snapshot. A concurrent discard cannot swap or invalidate the bytes being sent.
Session records contain only opaque attachment descriptors, while runtime proof
contains their canonical request digest; neither contains base64 payloads or
filesystem paths. API and validation failures remain visible to the user.

## Acceptance

1. Select one image from Photos and one supported file from iOS Files.
2. Remove and re-add an attachment without leaving orphaned draft state.
3. Send an image-only prompt through Flash Exp and verify a content-specific
   response.
4. Terminate and relaunch the app; verify message attachment cards and native
   previews recover.
5. Verify a text attachment reaches the model and unsupported/scanned content
   fails with a localized error.
6. Confirm the app bundle and persisted chat JSON contain no API key, provider
   URL, absolute path, or base64 attachment payload.

## Evidence recorded on 2026-08-25

- A direct authenticated probe confirmed that
  `deepseek-v4-flash-vision-exp` accepts the OpenAI-compatible `content[]` plus
  base64 `image_url` format. Both text-plus-image and image-only requests
  returned HTTP 200.
- The Release Simulator app selected a PNG through the iOS Files picker,
  rendered its bounded thumbnail, automatically selected Flash Exp, sent an
  attachment-only message, and received an image-specific model response.
- After forced termination and relaunch, the same message thumbnail and model
  response were restored from schema-v4 chat state plus native preview lookup.
- The app selected `proof.txt` through iOS Files. The model read the native
  UTF-8 projection and correctly returned its first word, `Rish`.
- Camera presentation and cancellation were exercised in Simulator. A real
  camera capture still requires a physical iPhone.
- The persisted session contained two opaque attachment descriptors and no
  `data:image`, `file://`, `/Users/`, provider URL, or clipboard path. Native
  payload and manifest files were mode `0600`, and both stored SHA-256 values
  matched independently computed hashes.
- TypeScript, ESLint, 14 Jest suites / 141 tests, arm64 Simulator Release, and
  unsigned arm64 iPhoneOS Release all passed. Simulator and device bundles
  passed the no-bundled-secret scan.
- The subsequent preview slice opened the committed image at full resolution
  and displayed the complete `proof.txt` contents through native Quick Look;
  both Close actions returned to the original conversation. Independent
  inspection confirmed no temporary preview file remained. The final suite is
  14 Jest suites / 143 tests.
