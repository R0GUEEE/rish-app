//! What a stored workspace authority looks like, and how it is tied to its
//! record.
//!
//! Ported from `DSHValidOwnedAuthority`, `DSHValidBookmarkAuthority`,
//! `DSHValidGrantedAuthority` and `DSHValidLegacyAuthority` in
//! `LocalWorkspaceAccess.mm`. The fourth workspace rule, and the one that ties
//! the other three together: every shape here re-states the record's identity
//! and ends in the fingerprint from `workspace_fingerprint`.
//!
//! The cross-checks are the point. An authority that merely *looks* well
//! formed but names a different workspace, a different binding revision or a
//! different display name than the record it was loaded for is not an
//! authority for that record — it is someone else's, and the whole reason the
//! fingerprint folds in the authority digest is so the two cannot be mixed.
//!
//! **Base64 stays with the host.** The core has no base64, and decoding a
//! bookmark is mechanical; the host decodes and passes the length and the
//! digest of the decoded bytes. The rule — that the claimed digest must be the
//! bytes' digest and the bytes must fit the cap — stays here.

use serde_json::{json, Map, Value};

use crate::canonical::sha256_hex;
use crate::schema::{canonical_sha256, canonical_timestamp, exact_keys};
use crate::workspace_fingerprint::fingerprint_valid;
use crate::workspace_record::capabilities_array;

/// A security-scoped bookmark is at most this many bytes.
pub const MAX_BOOKMARK_BYTES: u64 = 256 * 1024;

/// `DSHCanonicalUnsignedIntegerString`.
fn unsigned_string(value: Option<&Value>) -> bool {
    let Some(Value::String(text)) = value else {
        return false;
    };
    !text.is_empty()
        && text.len() <= 20
        && (text == "0" || !text.starts_with('0'))
        && text.bytes().all(|b| b.is_ascii_digit())
        && text.parse::<u64>().is_ok()
}

/// `DSHCanonicalPositiveIntegerString`: the same, but a device or inode of
/// zero names nothing.
fn positive_string(value: Option<&Value>) -> bool {
    unsigned_string(value) && value != Some(&json!("0"))
}

/// Foundation compares these with `isEqual:`, and two `NSNumber`s are equal
/// when their values are, so a binding revision written `3.0` reads as equal
/// to `3`. That is reproduced. The other `NSNumber` coincidence — `true`
/// equalling `1` — is not: nothing writes a boolean revision, and treating one
/// as a number here would be carrying a Foundation accident into the rule.
fn same_value(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(Value::Number(a)), Some(Value::Number(b))) => match (a.as_f64(), b.as_f64()) {
            (Some(a), Some(b)) => a == b,
            _ => a == b,
        },
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Every authority restates the record's own identity, so a well-formed
/// authority for one workspace cannot be read as an authority for another.
fn matches_record(authority: &Map<String, Value>, record: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .all(|key| same_value(authority.get(*key), record.get(*key)))
}

/// `DSHValidOwnedAuthority`. The directory-name digest is checked against the
/// record's own directory name: an authority cannot claim a folder the record
/// does not name.
pub fn owned_authority(authority: Option<&Value>, record: &Value) -> bool {
    let Some(map) = exact_keys(
        authority,
        &[
            "schema_version",
            "workspace_id",
            "binding_revision",
            "device_id",
            "inode_id",
            "directory_name_sha256",
            "recorded_at",
            "root_fingerprint_sha256",
        ],
    ) else {
        return false;
    };
    let Some(Value::String(directory)) = record.get("owned_directory_name") else {
        return false;
    };
    map.get("schema_version") == Some(&json!(1))
        && matches_record(map, record, &["workspace_id", "binding_revision"])
        && unsigned_string(map.get("device_id"))
        && unsigned_string(map.get("inode_id"))
        && map.get("directory_name_sha256") == Some(&json!(sha256_hex(directory.as_bytes())))
        && canonical_timestamp(map.get("recorded_at"))
        && fingerprint_valid(authority.expect("checked"), record)
}

/// What the host observed about a bookmark's bytes. It decodes; the rule about
/// what the bytes must satisfy is here.
pub struct BookmarkBytes<'a> {
    /// `None` when the base64 could not be decoded at all.
    pub sha256: Option<&'a str>,
    pub length: u64,
}

/// `DSHValidBookmarkAuthority`.
pub fn bookmark_authority(
    authority: Option<&Value>,
    record: &Value,
    bytes: &BookmarkBytes,
) -> bool {
    let Some(map) = exact_keys(
        authority,
        &[
            "schema_version",
            "workspace_id",
            "binding_revision",
            "bookmark_sha256",
            "bookmark_bytes_base64",
            "recorded_at",
        ],
    ) else {
        return false;
    };
    if map.get("schema_version") != Some(&json!(1))
        || !matches_record(map, record, &["workspace_id", "binding_revision"])
        || !canonical_sha256(map.get("bookmark_sha256"))
        || !matches!(map.get("bookmark_bytes_base64"), Some(Value::String(_)))
        || !canonical_timestamp(map.get("recorded_at"))
    {
        return false;
    }
    // Bytes that do not decode, or that outrun the cap, are not a bookmark;
    // and the claimed digest has to be the digest of what decoded.
    let Some(digest) = bytes.sha256 else {
        return false;
    };
    bytes.length <= MAX_BOOKMARK_BYTES && map.get("bookmark_sha256") == Some(&json!(digest))
}

/// `DSHValidGrantedAuthority`. It carries the bookmark's digest rather than
/// the bookmark, and that digest must be the one the bookmark authority
/// recorded — the two are halves of one grant.
pub fn granted_authority(
    authority: Option<&Value>,
    record: &Value,
    bookmark_authority_value: &Value,
) -> bool {
    let Some(map) = exact_keys(
        authority,
        &[
            "schema_version",
            "workspace_id",
            "binding_revision",
            "volume_identifier_sha256",
            "resource_identifier_sha256",
            "device_id",
            "inode_id",
            "bookmark_sha256",
            "classified_at",
            "root_fingerprint_sha256",
        ],
    ) else {
        return false;
    };
    map.get("schema_version") == Some(&json!(1))
        && matches_record(map, record, &["workspace_id", "binding_revision"])
        && canonical_sha256(map.get("volume_identifier_sha256"))
        && canonical_sha256(map.get("resource_identifier_sha256"))
        && unsigned_string(map.get("device_id"))
        && unsigned_string(map.get("inode_id"))
        && same_value(
            map.get("bookmark_sha256"),
            bookmark_authority_value.get("bookmark_sha256"),
        )
        && canonical_timestamp(map.get("classified_at"))
        && fingerprint_valid(authority.expect("checked"), record)
}

/// `DSHValidLegacyAuthority`. The widest shape: it restates the record's
/// display name and both timestamps as well as its identity, because a legacy
/// root is verified by comparing all of them against the project on disk.
pub fn legacy_authority(authority: Option<&Value>, record: &Value) -> bool {
    let Some(map) = exact_keys(
        authority,
        &[
            "schema_version",
            "workspace_id",
            "binding_revision",
            "legacy_project_id",
            "root_identity_sha256",
            "display_name",
            "capabilities",
            "created_at",
            "last_opened_at",
            "recorded_at",
            "project_metadata_sha256",
            "projects_root_device_id",
            "projects_root_inode_id",
            "repository_device_id",
            "repository_inode_id",
            "git_device_id",
            "git_inode_id",
            "root_fingerprint_sha256",
        ],
    ) else {
        return false;
    };
    map.get("schema_version") == Some(&json!(1))
        && matches_record(
            map,
            record,
            &[
                "workspace_id",
                "binding_revision",
                "legacy_project_id",
                "display_name",
                "created_at",
                "last_opened_at",
            ],
        )
        && canonical_sha256(map.get("root_identity_sha256"))
        && capabilities_array(map.get("capabilities"))
        && canonical_timestamp(map.get("recorded_at"))
        && canonical_sha256(map.get("project_metadata_sha256"))
        && [
            "projects_root_device_id",
            "projects_root_inode_id",
            "repository_device_id",
            "repository_inode_id",
            "git_device_id",
            "git_inode_id",
        ]
        .iter()
        .all(|key| positive_string(map.get(*key)))
        && fingerprint_valid(authority.expect("checked"), record)
}

fn text<'a>(envelope: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    envelope.get(key).and_then(Value::as_str)
}

/// One envelope in, one reply out; see `rish_agent_workspace_authority_reduce`.
pub fn reduce_json(input: &str) -> String {
    match reduce_json_inner(input) {
        Some(value) => value.to_string(),
        None => json!({ "ok": false }).to_string(),
    }
}

fn reduce_json_inner(input: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(input).ok()?;
    let envelope = parsed.as_object()?;
    let authority = envelope.get("authority");
    let record = envelope.get("record")?;
    let valid = match text(envelope, "op")? {
        "owned" => owned_authority(authority, record),
        "bookmark" => bookmark_authority(
            authority,
            record,
            &BookmarkBytes {
                sha256: text(envelope, "bookmark_bytes_sha256"),
                length: envelope
                    .get("bookmark_bytes_length")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX),
            },
        ),
        "granted" => granted_authority(
            authority,
            record,
            envelope.get("bookmark_authority").unwrap_or(&Value::Null),
        ),
        "legacy" => legacy_authority(authority, record),
        _ => return None,
    };
    Some(json!({ "ok": true, "valid": valid }))
}

#[cfg(test)]
#[path = "workspace_authority_tests.rs"]
mod tests;
