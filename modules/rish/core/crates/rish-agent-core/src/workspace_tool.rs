//! The workspace executor's judgements: which paths it will touch, what a
//! revision is, what a directory listing looks like, and what a person is
//! shown before they approve a write.
//!
//! Ported from `AgentWorkspaceToolExecutor.mm`. The capability there is small
//! and entirely the host's — `openat` a directory descriptor, read and write
//! bytes, `fstatat` — and everything around it is rule. The approval diff is
//! the sharpest piece: it is what a person reads before they say yes, so two
//! copies of it would be two different things to approve.

use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::canonical::{hash_bytes, hash_json};
use crate::schema::bounded_utf8;
use crate::store::StoreError;

/// A workspace-relative path is bounded, NFC, and names no reserved entry.
pub const MAX_PATH_BYTES: usize = 512;
/// `NAME_MAX` on Darwin and bionic alike.
const MAX_COMPONENT_BYTES: usize = 255;
/// Canonical-envelope headroom under the protected feedback cap.
pub const MAX_READ_BYTES: u64 = 60 * 1024;
const MAX_ENTRIES: usize = 1000;
/// The protected cap on anything a workspace tool reports.
const MAX_FEEDBACK_BYTES: usize = 64 * 1024;

/// How much of an existing file is read to build a preview. The host does the
/// reading, so it asks for this rather than holding its own copy.
pub const MAX_PRIOR_READ_BYTES: u64 = 64 * 1024;
const MAX_DIFF_LINES: usize = 2000;
const MAX_HUNK_LINES: usize = 24;
const MAX_CONTEXT_LINES: usize = 3;
const MAX_PREVIEW_BYTES: usize = 4096;

/// `DSHAgentWorkspacePathComponents`. The workspace root is the empty path; a
/// bare "." is accepted as the same root for a listing because models reach
/// for it first, and it never names an entry, so nothing below can be confused
/// with a "." component.
pub fn path_components(path: &str, allow_root: bool) -> Option<Vec<String>> {
    if path.len() > MAX_PATH_BYTES
        || path.nfc().ne(path.chars())
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
    {
        return None;
    }
    if path.is_empty() || (allow_root && path == ".") {
        return allow_root.then(Vec::new);
    }
    let mut components: Vec<String> = Vec::new();
    for component in path.split('/') {
        if component.is_empty()
            || component.len() > MAX_COMPONENT_BYTES
            || matches!(component, "." | ".." | ".git" | ".trash")
            || component.chars().any(|c| c.is_control())
        {
            return None;
        }
        components.push(component.to_string());
    }
    Some(components)
}

/// `DSHAgentWorkspaceRevision`: opaque bounded file-state metadata, not a new
/// protocol digest. The host reads the numbers; their spelling is the rule.
pub fn revision(dev: u64, ino: u64, size: u64, mtime_sec: u64, mtime_nsec: u64) -> String {
    format!("{dev:x}:{ino:x}:{size:x}:{mtime_sec:x}:{mtime_nsec:x}")
}

/// Native metadata is never a tool result, so the same reserved names the
/// local-workspace path validator hides stay hidden here, case-folded.
/// Ordinary dotfiles such as `.gitignore` stay visible.
fn reserved(name: &str) -> bool {
    let folded = name.to_lowercase();
    folded == ".git"
        || folded == ".trash"
        || folded.starts_with(".staging-")
        || folded.starts_with(".rish-write-")
}

/// One directory entry as the host read it. `kind` is "file", "directory",
/// "invalid" for anything the host will not expose — a symlink, a device, a
/// hard-linked regular file, or an entry it could not stat — or "unnamed" for
/// a name that is not UTF-8.
struct Entry {
    name: String,
    kind: String,
    revision: String,
}

/// `DSHAgentWorkspaceEntryList`'s projection half: hide the reserved names,
/// bound the listing, refuse a non-canonical name, and answer with the public
/// entries and the fingerprint the precondition is taken over.
///
/// The host passes every entry `readdir` returned, in `readdir` order, and
/// reports one it will not expose as "invalid" — or one whose name is not
/// UTF-8 as "unnamed" — rather than refusing it itself. The order the three
/// refusals are reached in is part of the rule: a name that cannot be decoded
/// refuses immediately, but a full listing is at capacity before an entry that
/// merely cannot be exposed is judged, exactly as when these checks were
/// interleaved with the directory walk.
pub fn directory_listing(entries: &[Value]) -> Result<Value, StoreError> {
    let mut visible: Vec<Entry> = Vec::new();
    for entry in entries {
        let kind = entry
            .get("kind")
            .and_then(Value::as_str)
            .ok_or(StoreError::InvalidArgument)?;
        if kind == "unnamed" {
            return Err(StoreError::InvalidArgument);
        }
        let name = bounded_utf8(entry.get("name"), MAX_PATH_BYTES, false)
            .ok_or(StoreError::InvalidArgument)?;
        if name == "." || name == ".." || reserved(name) {
            continue;
        }
        if visible.len() >= MAX_ENTRIES {
            return Err(StoreError::Capacity);
        }
        if kind == "invalid" {
            return Err(StoreError::Conflict);
        }
        if kind != "file" && kind != "directory" {
            return Err(StoreError::InvalidArgument);
        }
        if name.nfc().ne(name.chars()) {
            return Err(StoreError::InvalidArgument);
        }
        let revision =
            bounded_utf8(entry.get("revision"), 256, false).ok_or(StoreError::InvalidArgument)?;
        visible.push(Entry {
            name: name.to_string(),
            kind: kind.to_string(),
            revision: revision.to_string(),
        });
    }
    // Byte order, not locale order: the fingerprint has to be the same on
    // every device that lists the same directory.
    visible.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    let mut public: Vec<Value> = Vec::with_capacity(visible.len());
    let mut fingerprint: Vec<Value> = Vec::with_capacity(visible.len());
    for entry in &visible {
        let digest = hash_bytes("directory-name", entry.name.as_bytes())
            .ok_or(StoreError::InvalidArgument)?;
        public.push(json!({
            "schema_version": 1, "name": entry.name,
            "type": entry.kind, "revision": entry.revision,
        }));
        fingerprint.push(json!({
            "name_sha256": digest, "type": entry.kind, "revision": entry.revision,
        }));
    }
    let digest = hash_json("directory", &json!({ "entries": fingerprint }))
        .ok_or(StoreError::InvalidArgument)?;
    Ok(json!({ "entries": public, "directory_fingerprint_sha256": digest }))
}

/// A prior that is absent, or that the host could not decode as UTF-8, has no
/// preview: a preview of undecodable bytes would leak bytes, not text.
fn looks_binary(text: Option<&str>) -> bool {
    match text {
        None => true,
        Some(text) => text.contains('\0'),
    }
}

fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

/// The result of building a preview: the text a person is shown, and whether
/// anything was left out of it.
pub struct Preview {
    pub diff: Option<String>,
    pub truncated: bool,
}

/// `DSHAgentApprovalUnifiedDiff`: an anchored prefix/suffix line diff under a
/// strict budget. `truncated` is only ever raised, never cleared, so a caller
/// whose prior read was already cut short keeps saying so.
pub fn diff_preview(prior: Option<&str>, next: &str, prior_truncated: bool) -> Preview {
    let mut truncated = prior_truncated;
    if looks_binary(prior) || looks_binary(Some(next)) {
        return Preview {
            diff: None,
            truncated,
        };
    }
    let prior = prior.unwrap_or_default();
    let mut prior_lines = lines(prior);
    let mut next_lines = lines(next);
    if prior_lines.len() > MAX_DIFF_LINES || next_lines.len() > MAX_DIFF_LINES {
        truncated = true;
        prior_lines.truncate(MAX_DIFF_LINES);
        next_lines.truncate(MAX_DIFF_LINES);
    }
    let mut prefix = 0;
    while prefix < prior_lines.len()
        && prefix < next_lines.len()
        && prior_lines[prefix] == next_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < prior_lines.len() - prefix
        && suffix < next_lines.len() - prefix
        && prior_lines[prior_lines.len() - 1 - suffix] == next_lines[next_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let removed = prior_lines.len() - prefix - suffix;
    let added = next_lines.len() - prefix - suffix;
    if removed == 0 && added == 0 {
        return Preview {
            diff: Some(String::new()),
            truncated,
        };
    }
    let mut preview = format!("@@ -{},{removed} +{},{added} @@", prefix + 1, prefix + 1);
    let context_start = prefix.saturating_sub(MAX_CONTEXT_LINES);
    for line in &prior_lines[context_start..prefix] {
        preview.push_str(&format!("\n {line}"));
    }
    let hunk_truncated = removed > MAX_HUNK_LINES || added > MAX_HUNK_LINES;
    for line in &prior_lines[prefix..prefix + removed.min(MAX_HUNK_LINES)] {
        preview.push_str(&format!("\n-{line}"));
    }
    for line in &next_lines[prefix..prefix + added.min(MAX_HUNK_LINES)] {
        preview.push_str(&format!("\n+{line}"));
    }
    if hunk_truncated {
        preview.push_str("\n…");
    }
    let suffix_start = prefix + removed;
    let context_end = prior_lines.len().min(suffix_start + MAX_CONTEXT_LINES);
    for line in &prior_lines[suffix_start..context_end] {
        preview.push_str(&format!("\n {line}"));
    }
    if preview.len() > MAX_PREVIEW_BYTES {
        truncated = true;
        // The budget is in bytes, so the clip is too, and it stops on a
        // character boundary: a clip taken at a UTF-16 index instead used to
        // run past the end of CJK text and raise.
        let mut budget = MAX_PREVIEW_BYTES / 2;
        while budget > 0 && !preview.is_char_boundary(budget) {
            budget -= 1;
        }
        preview.truncate(budget);
        preview.push_str("\n…");
        return Preview {
            diff: Some(preview),
            truncated,
        };
    }
    Preview {
        diff: Some(preview),
        truncated: truncated || hunk_truncated,
    }
}

/// The three shapes a `write_file` call may take, and the prior each one
/// asserts. A call that names neither form asserts the file is absent.
pub fn write_expected_prior(arguments: &Map<String, Value>) -> Result<Value, StoreError> {
    let keys: Vec<&str> = arguments.keys().map(String::as_str).collect();
    let exact = |expected: &[&str]| {
        keys.len() == expected.len() && keys.iter().all(|key| expected.contains(key))
    };
    if !(exact(&["path", "content", "expected_prior"])
        || exact(&["path", "content", "expected_revision"])
        || exact(&["path", "content"]))
    {
        return Err(StoreError::InvalidArgument);
    }
    if let Some(prior) = arguments.get("expected_prior") {
        return Ok(prior.clone());
    }
    Ok(match arguments.get("expected_revision") {
        None | Some(Value::Null) => json!({ "schema_version": 1, "kind": "absent" }),
        Some(revision) => json!({
            "schema_version": 1, "kind": "known", "revision": revision,
        }),
    })
}

/// `DSHAgentWorkspaceFeedback`: canonicalise what the executor wants to report,
/// hold it to the protected feedback cap, and check it against the contract the
/// ledger will apply. The cap here is tighter than the transcript bound the
/// contract itself uses, and it applies to every workspace tool rather than
/// only the two that carry content.
pub fn feedback(value: &Value) -> Result<String, StoreError> {
    let bytes = crate::canonical::canonical_json(value).map_err(|_| StoreError::InvalidArgument)?;
    if bytes.len() > MAX_FEEDBACK_BYTES {
        return Err(StoreError::Capacity);
    }
    let text = String::from_utf8(bytes).map_err(|_| StoreError::InvalidArgument)?;
    crate::execution_ledger::feedback_string_valid(&text)?;
    Ok(text)
}

/// `DSHAgentWorkspaceFailure`: the result an executor reports when a tool
/// could not run. `ambiguous` says the effect may already have happened, which
/// is the one thing a retry has to know.
pub fn failure_result(name: &str, code: &str, ambiguous: bool) -> Result<Value, StoreError> {
    let outcome = if ambiguous { "ambiguous" } else { "failed" };
    let feedback = json!({
        "schema_version": 1, "name": name, "outcome": outcome,
        "payload": { "schema_version": 1, "failure_code": code },
    });
    let bytes =
        crate::canonical::canonical_json(&feedback).map_err(|_| StoreError::InvalidArgument)?;
    let text = String::from_utf8(bytes).map_err(|_| StoreError::InvalidArgument)?;
    crate::execution_ledger::feedback_string_valid(&text)?;
    Ok(json!({
        "schema_version": 1,
        "status": outcome,
        "feedback": text,
        "settled_facts": Value::Null,
        "truncated": false,
        "effect_may_have_occurred": ambiguous,
    }))
}

/// One envelope in, one reply out; see `rish_agent_workspace_tool_reduce`.
pub fn reduce_json(input: &str) -> String {
    let value = match reduce_json_inner(input) {
        Ok(output) => {
            let mut object = output.as_object().cloned().unwrap_or_default();
            object.insert("ok".to_string(), Value::Bool(true));
            Value::Object(object)
        }
        Err(error) => json!({ "ok": false, "error": error.code() }),
    };
    value.to_string()
}

fn reduce_json_inner(input: &str) -> Result<Value, StoreError> {
    let envelope: Value = serde_json::from_str(input).map_err(|_| StoreError::Corrupt)?;
    let op = envelope
        .get("op")
        .and_then(Value::as_str)
        .ok_or(StoreError::Corrupt)?;
    let number = |key: &str| {
        envelope
            .get(key)
            .and_then(Value::as_u64)
            .ok_or(StoreError::InvalidArgument)
    };
    match op {
        "path_components" => {
            let path = envelope
                .get("path")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidArgument)?;
            let allow_root = envelope.get("allow_root") == Some(&Value::Bool(true));
            let components =
                path_components(path, allow_root).ok_or(StoreError::InvalidArgument)?;
            Ok(json!({ "components": components }))
        }
        // The caps the host enforces while reading and writing bytes. They are
        // rules, so it asks rather than keeping a second copy that could drift.
        "bounds" => Ok(json!({
            "max_path_bytes": MAX_PATH_BYTES,
            "max_read_bytes": MAX_READ_BYTES,
            "max_prior_read_bytes": MAX_PRIOR_READ_BYTES,
            "max_entries": MAX_ENTRIES,
        })),
        "revision" => Ok(json!({
            "revision": revision(
                number("dev")?, number("ino")?, number("size")?,
                number("mtime_sec")?, number("mtime_nsec")?)
        })),
        "directory_listing" => {
            let Some(Value::Array(entries)) = envelope.get("entries") else {
                return Err(StoreError::InvalidArgument);
            };
            directory_listing(entries)
        }
        "diff_preview" => {
            let next = envelope
                .get("next")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidArgument)?;
            // A prior the host could not decode arrives as null, and is
            // treated exactly like binary content: no preview.
            let prior = envelope.get("prior").and_then(Value::as_str);
            let preview = diff_preview(
                prior,
                next,
                envelope.get("prior_truncated") == Some(&Value::Bool(true)),
            );
            Ok(json!({
                "diff_preview": preview.diff,
                "diff_truncated": preview.truncated,
            }))
        }
        "write_expected_prior" => {
            let Some(Value::Object(arguments)) = envelope.get("arguments") else {
                return Err(StoreError::InvalidArgument);
            };
            Ok(json!({ "expected_prior": write_expected_prior(arguments)? }))
        }
        "feedback" => Ok(json!({
            "feedback": feedback(envelope.get("feedback").ok_or(StoreError::InvalidArgument)?)?
        })),
        "failure_result" => Ok(json!({
            "result": failure_result(
                envelope.get("name").and_then(Value::as_str).ok_or(StoreError::InvalidArgument)?,
                envelope.get("failure_code").and_then(Value::as_str).ok_or(StoreError::InvalidArgument)?,
                envelope.get("ambiguous") == Some(&Value::Bool(true)))?
        })),
        _ => Err(StoreError::InvalidArgument),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_is_the_empty_path_and_a_bare_dot_only_for_a_listing() {
        assert_eq!(path_components("", true), Some(vec![]));
        assert_eq!(path_components(".", true), Some(vec![]));
        assert_eq!(path_components("", false), None);
        assert_eq!(path_components(".", false), None);
    }

    #[test]
    fn native_metadata_is_never_addressable_by_a_tool() {
        for path in [
            ".git",
            ".git/config",
            "a/.git",
            ".trash",
            "a/.trash/b",
            "..",
            "a/../b",
            "/abs",
            "a\\b",
            "a//b",
            "a/\u{1}/b",
        ] {
            assert_eq!(path_components(path, true), None, "{path}");
        }
        // Ordinary dotfiles stay addressable.
        assert_eq!(
            path_components("src/.gitignore", false),
            Some(vec!["src".into(), ".gitignore".into()])
        );
    }

    #[test]
    fn a_decomposed_path_is_not_the_same_path() {
        assert!(path_components("café.md", false).is_some());
        // The same name with a combining accent is refused rather than
        // silently normalised into a different file.
        assert_eq!(path_components("cafe\u{301}.md", false), None);
    }

    #[test]
    fn a_listing_is_ordered_by_bytes_so_every_device_fingerprints_it_alike() {
        let entry = |name: &str| json!({ "name": name, "kind": "file", "revision": "1:2:3:4:5" });
        let listed =
            directory_listing(&[entry("b"), entry("A"), entry("a"), entry("ab")]).expect("listing");
        let names: Vec<&str> = listed["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| entry["name"].as_str().expect("name"))
            .collect();
        assert_eq!(names, vec!["A", "a", "ab", "b"]);
    }

    #[test]
    fn reserved_entries_are_hidden_and_do_not_count_against_the_bound() {
        let mut entries: Vec<Value> = vec![
            json!({ "name": ".git", "kind": "directory", "revision": "1:2:3:4:5" }),
            json!({ "name": ".Trash", "kind": "directory", "revision": "1:2:3:4:5" }),
            json!({ "name": ".staging-1", "kind": "file", "revision": "1:2:3:4:5" }),
            json!({ "name": ".rish-write-1", "kind": "file", "revision": "1:2:3:4:5" }),
        ];
        for index in 0..MAX_ENTRIES {
            entries.push(json!({
                "name": format!("f{index:05}"), "kind": "file", "revision": "1:2:3:4:5",
            }));
        }
        let listed = directory_listing(&entries).expect("listing");
        assert_eq!(
            listed["entries"].as_array().expect("entries").len(),
            MAX_ENTRIES
        );
        entries.push(json!({ "name": "one-too-many", "kind": "file", "revision": "1:2:3:4:5" }));
        assert_eq!(directory_listing(&entries), Err(StoreError::Capacity));
    }

    /// The capacity bound is reached before an entry the host will not expose
    /// is judged, because in the original the two checks were interleaved with
    /// the directory walk in that order.
    #[test]
    fn a_full_directory_is_at_capacity_even_if_a_later_entry_is_unusable() {
        let mut entries: Vec<Value> = (0..MAX_ENTRIES)
            .map(|index| {
                json!({
                    "name": format!("f{index:05}"), "kind": "file", "revision": "1:2:3:4:5",
                })
            })
            .collect();
        entries.push(json!({ "name": "link", "kind": "invalid", "revision": "1:2:3:4:5" }));
        assert_eq!(directory_listing(&entries), Err(StoreError::Capacity));
        // With room to spare, the same entry is a conflict.
        assert_eq!(
            directory_listing(&entries[MAX_ENTRIES..]),
            Err(StoreError::Conflict)
        );
    }

    /// A name that cannot be decoded refuses straight away, ahead of the
    /// capacity bound — the one refusal that does not wait its turn.
    #[test]
    fn a_name_that_is_not_utf8_refuses_before_anything_else() {
        let mut entries: Vec<Value> = (0..MAX_ENTRIES + 5)
            .map(|index| {
                json!({
                    "name": format!("f{index:05}"), "kind": "file", "revision": "1:2:3:4:5",
                })
            })
            .collect();
        entries.insert(
            MAX_ENTRIES + 3,
            json!({ "name": "", "kind": "unnamed", "revision": "" }),
        );
        // Capacity is reached first, because the undecodable entry is later.
        assert_eq!(directory_listing(&entries), Err(StoreError::Capacity));
        entries.insert(0, json!({ "name": "", "kind": "unnamed", "revision": "" }));
        assert_eq!(
            directory_listing(&entries),
            Err(StoreError::InvalidArgument)
        );
    }

    #[test]
    fn binary_content_has_no_preview() {
        assert!(diff_preview(Some("a\0b"), "c", false).diff.is_none());
        assert!(diff_preview(Some("a"), "c\0d", false).diff.is_none());
        // A prior the host could not decode arrives as None.
        assert!(diff_preview(None, "c", false).diff.is_none());
    }

    #[test]
    fn an_unchanged_file_previews_as_empty() {
        let preview = diff_preview(Some("a\nb\n"), "a\nb\n", false);
        assert_eq!(preview.diff.as_deref(), Some(""));
        assert!(!preview.truncated);
    }

    /// The bug this replaced: the helper cleared the flag on entry and
    /// assigned it again on exit, so each bound erased the one before it.
    #[test]
    fn every_bound_that_hides_something_raises_the_flag_and_none_clears_it() {
        // A prior read the host already cut short stays marked.
        let preview = diff_preview(Some("a\n"), "b\n", true);
        assert!(preview.truncated);
        // Past the line bound, with a one-line hunk inside it.
        let prior: String = (0..2500).map(|i| format!("line {i:04}\n")).collect();
        let next = prior.replace("line 0005\n", "LINE 0005\n");
        let preview = diff_preview(Some(&prior), &next, false);
        assert!(preview.truncated);
        assert!(preview.diff.expect("diff").contains("-line 0005"));
        // Past the hunk bound.
        let preview = diff_preview(Some("x\n"), &"y\n".repeat(30), false);
        assert!(preview.truncated);
    }

    /// 1,500 Chinese characters are 4,500 UTF-8 bytes but 1,500 UTF-16 units,
    /// so a clip taken at a UTF-16 index ran past the end of the string.
    #[test]
    fn a_wide_character_preview_is_clipped_by_bytes_on_a_character_boundary() {
        let tail = "一直写下去".repeat(5);
        let prior: String = (0..60)
            .map(|i| format!("旧的内容第{i}行{tail}\n"))
            .collect();
        let next: String = (0..60)
            .map(|i| format!("新的内容第{i}行{tail}\n"))
            .collect();
        let preview = diff_preview(Some(&prior), &next, false);
        let diff = preview.diff.expect("diff");
        assert!(preview.truncated);
        // The gap the old clip fell through: over the byte budget, under the
        // UTF-16 index it used to clip at.
        let unclipped: usize = diff.chars().map(char::len_utf16).sum();
        assert!(unclipped < MAX_PREVIEW_BYTES / 2, "{unclipped}");
        assert!(diff.len() <= MAX_PREVIEW_BYTES / 2 + 4, "{}", diff.len());
        assert!(diff.ends_with("\n…"));
    }

    #[test]
    fn a_write_without_an_expectation_asserts_the_file_is_absent() {
        let arguments = |value: Value| value.as_object().expect("object").clone();
        assert_eq!(
            write_expected_prior(&arguments(json!({ "path": "a", "content": "b" })))
                .expect("prior"),
            json!({ "schema_version": 1, "kind": "absent" })
        );
        assert_eq!(
            write_expected_prior(&arguments(
                json!({ "path": "a", "content": "b", "expected_revision": null })
            ))
            .expect("prior"),
            json!({ "schema_version": 1, "kind": "absent" })
        );
        assert_eq!(
            write_expected_prior(&arguments(
                json!({ "path": "a", "content": "b", "expected_revision": "1:2:3:4:5" })
            ))
            .expect("prior"),
            json!({ "schema_version": 1, "kind": "known", "revision": "1:2:3:4:5" })
        );
        // Both forms at once, or an extra key, is not a call this tool takes.
        assert!(write_expected_prior(&arguments(json!({
            "path": "a", "content": "b", "expected_revision": null, "expected_prior": null
        })))
        .is_err());
    }

    #[test]
    fn a_failure_result_is_feedback_the_ledger_would_accept() {
        let result = failure_result("write_file", "E_AGENT_BAD_PATH", false).expect("result");
        assert_eq!(result["status"], json!("failed"));
        assert_eq!(result["effect_may_have_occurred"], json!(false));
        let ambiguous = failure_result("write_file", "E_AGENT_BAD_PATH", true).expect("result");
        assert_eq!(ambiguous["status"], json!("ambiguous"));
        assert_eq!(ambiguous["effect_may_have_occurred"], json!(true));
        // A code outside the closed union cannot be reported at all.
        assert!(failure_result("write_file", "E_MADE_UP", false).is_err());
    }

    #[test]
    fn a_workspace_tool_report_is_capped_tighter_than_a_transcript() {
        let report = |content: &str| {
            json!({
                "schema_version": 1, "name": "read_file", "outcome": "ok",
                "payload": {
                    "schema_version": 1, "content": content,
                    "revision": "1:2:3:4:5", "truncated": true,
                },
            })
        };
        assert!(feedback(&report("hi")).is_ok());
        assert_eq!(
            feedback(&report(&"x".repeat(64 * 1024))),
            Err(StoreError::Capacity)
        );
    }

    #[test]
    fn the_host_reads_its_byte_caps_from_here() {
        let reply: Value =
            serde_json::from_str(&reduce_json(&json!({ "op": "bounds" }).to_string()))
                .expect("reply");
        assert_eq!(reply["max_path_bytes"], json!(512));
        assert_eq!(reply["max_read_bytes"], json!(60 * 1024));
        assert_eq!(reply["max_prior_read_bytes"], json!(64 * 1024));
        assert_eq!(reply["max_entries"], json!(1000));
    }

    #[test]
    fn a_revision_is_the_file_state_the_host_read() {
        assert_eq!(revision(1, 2, 255, 16, 4095), "1:2:ff:10:fff");
    }
}
