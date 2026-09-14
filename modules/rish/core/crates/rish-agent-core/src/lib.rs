//! `rish-agent-core` is the platform-independent half of the Rish agent
//! engine. The iOS app currently implements the engine in Objective-C++
//! (`modules/rish/ios/Sources/Agent*.mm`); this crate takes it over one
//! component at a time behind the existing native interfaces, with the ObjC
//! test suites as the oracle. See the plan in the document centre
//! (`rish-app/plans/2026-09-14-shared-agent-core-astra.md`).
//!
//! Phase 0 (this crate today): canonical JSON, domain-separated hashing, and
//! the strict argument parser, pinned byte for byte to the ObjC engine by
//! `fixtures/canonical-golden.json`.

pub mod canonical;
pub mod strict_json;

/// Protocol version reported over the C ABI. Bumped when the JSON contract
/// of any exported operation changes incompatibly.
pub const PROTOCOL_VERSION: u32 = 1;
