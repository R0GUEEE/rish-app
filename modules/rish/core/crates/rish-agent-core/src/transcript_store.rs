//! `DSHAgentTranscriptStore` as a pure reducer: create, validate, native
//! message reconstruction, append, mark terminal, discard and cleanup query.
//! The Objective-C facade owns the WAL transaction (or snapshot) and the
//! file-based round presentation cache; the fresh transcript UUID and the
//! retention timestamp come in through the environment because the reducer
//! has neither randomness nor a clock.

use crate::execution_ledger::{as_str, feedback_string_valid, get, object_map, transcript_digest};
use crate::ledger_ops::Slotted;
use crate::schema::*;
use crate::store::StoreError;
use crate::strict_json::parse_arguments;
use serde_json::{json, Map, Value};

/// `DSHAgentNativeWALMaxTranscriptCount`.
pub const MAX_TRANSCRIPT_COUNT: u64 = 128;
const MAX_MESSAGES: usize = 1024;

#[derive(Debug, Clone, Default)]
pub struct Env {
    pub launch_id: String,
    pub now: String,
    /// `[wal currentTimestampAddingInterval:7 days]` for mark terminal.
    pub retention_until: String,
    /// A fresh lowercase UUID for create.
    pub transcript_ref: String,
}

/// A round or ledger row reduced to what discard needs to refuse.
#[derive(Debug, Clone, Default)]
pub struct RowReference {
    pub state: String,
    pub before_ref: Option<Value>,
    pub after_ref: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct View {
    /// Whether the transcripts table exists in the candidate.
    pub transcripts_present: bool,
    pub transcript_count: u64,
    /// Transcript rows of the request's attempt, in table order.
    pub attempt_transcripts: Vec<Value>,
    /// The full transcript row named by the request's transcript reference.
    pub transcript: Option<Value>,
    /// Cleanup entries whose cleanup_id matches the request.
    pub cleanup: Vec<Slotted>,
    pub rounds: Vec<RowReference>,
    pub ledger: Vec<RowReference>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    InsertTranscript(Value),
    ReplaceTranscript(Value),
    RemoveTranscript(Value),
    InsertCleanup(Value),
    ReplaceCleanup { slot: u64, record: Value },
}

#[derive(Debug, Clone, Default)]
pub struct Effect {
    pub commit: bool,
    pub output: Value,
    pub changes: Vec<Change>,
}

fn string_eq(value: Option<&Value>, expected: &str) -> bool {
    as_str(value) == Some(expected)
}

fn set(map: &mut Map<String, Value>, key: &str, value: Value) {
    map.insert(key.to_string(), value);
}

fn reason_valid(value: Option<&Value>) -> bool {
    matches!(
        as_str(value),
        Some("completed" | "cancelled" | "failed" | "conversation_deleted")
    )
}

/// `DSHAgentTranscriptMessage`: the exact assistant / tool message unions.
pub fn transcript_message(message: &Value) -> bool {
    let Value::Object(map) = message else {
        return false;
    };
    if safe_integer(map.get("schema_version"), 1, false).is_none()
        || safe_integer(map.get("round_index"), 7, true).is_none()
    {
        return false;
    }
    match as_str(map.get("role")) {
        Some("assistant") => {
            let keys = [
                "schema_version",
                "role",
                "round_index",
                "content",
                "reasoning_content",
                "tool_calls",
            ];
            let Some(Value::Array(tool_calls)) = map.get("tool_calls") else {
                return false;
            };
            if exact_keys(Some(message), &keys).is_none()
                || bounded_utf8(map.get("content"), MAX_TRANSCRIPT_BYTES as usize, true).is_none()
                || bounded_utf8(
                    map.get("reasoning_content"),
                    MAX_TRANSCRIPT_BYTES as usize,
                    true,
                )
                .is_none()
                || tool_calls.len() > 16
            {
                return false;
            }
            tool_calls.iter().all(|call| {
                exact_keys(
                    Some(call),
                    &["schema_version", "call_id", "name", "arguments_json"],
                )
                .is_some()
                    && safe_integer(get(call, "schema_version"), 1, false).is_some()
                    && opaque_identifier(get(call, "call_id"))
                    && tool_name_well_formed(get(call, "name")).is_some()
                    && as_str(get(call, "arguments_json"))
                        .and_then(parse_arguments)
                        .is_some()
            })
        }
        Some("tool") => {
            let keys = [
                "schema_version",
                "role",
                "round_index",
                "call_id",
                "content",
                "truncated",
            ];
            exact_keys(Some(message), &keys).is_some()
                && opaque_identifier(map.get("call_id"))
                && bounded_utf8(map.get("content"), MAX_TRANSCRIPT_BYTES as usize, true).is_some()
                && as_str(map.get("content"))
                    .is_some_and(|content| feedback_string_valid(content).is_ok())
                && matches!(map.get("truncated"), Some(Value::Bool(_)))
        }
        _ => false,
    }
}

fn reference_for_row(row: &Value) -> Value {
    json!({
        "schema_version": 1,
        "transcript_ref": get(row, "transcript_ref"),
        "generation": get(row, "generation"),
        "transcript_sha256": get(row, "transcript_sha256"),
        "transcript_bytes": get(row, "transcript_bytes"),
    })
}

/// `DSHAgentExpectedReferenceMatches`.
fn expected_reference_matches(
    row: &Value,
    expected: &Value,
    attempt_id: Option<&Value>,
    root: &Value,
) -> bool {
    transcript_reference(Some(expected))
        && get(row, "attempt_id") == attempt_id
        && get(row, "root_fingerprint_sha256") == get(root, "root_fingerprint_sha256")
        && get(row, "transcript_ref") == get(expected, "transcript_ref")
        && get(row, "generation") == get(expected, "generation")
        && get(row, "transcript_sha256") == get(expected, "transcript_sha256")
        && get(row, "transcript_bytes") == get(expected, "transcript_bytes")
}

fn row_digest_matches(row: &Value, enforce_cap: bool) -> Result<(), StoreError> {
    let messages = match get(row, "messages") {
        Some(Value::Array(messages)) => messages.clone(),
        _ => Vec::new(),
    };
    let generation = get(row, "generation").and_then(Value::as_u64).unwrap_or(0);
    let (digest, bytes) =
        transcript_digest(row, &messages, generation).map_err(|_| StoreError::Corrupt)?;
    if as_str(get(row, "transcript_sha256")) != Some(digest.as_str())
        || get(row, "transcript_bytes").and_then(Value::as_u64) != Some(bytes)
        || (enforce_cap && bytes > MAX_TRANSCRIPT_BYTES)
    {
        return Err(StoreError::Corrupt);
    }
    Ok(())
}

fn located_row<'a>(view: &'a View, transcript_ref: Option<&Value>) -> Option<&'a Value> {
    view.transcript
        .as_ref()
        .filter(|row| get(row, "transcript_ref") == transcript_ref)
}

fn bound_request_valid(request: &Value) -> bool {
    exact_keys(
        Some(request),
        &["schema_version", "attempt_id", "root", "transcript"],
    )
    .is_some()
        && safe_integer(get(request, "schema_version"), 1, false).is_some()
        && canonical_uuid(get(request, "attempt_id"))
        && root_full(get(request, "root"))
        && transcript_reference(get(request, "transcript"))
}

fn create(request: &Value, env: &Env, view: &View) -> Result<Effect, StoreError> {
    if exact_keys(Some(request), &["schema_version", "attempt_id", "root"]).is_none()
        || safe_integer(get(request, "schema_version"), 1, false).is_none()
        || !canonical_uuid(get(request, "attempt_id"))
        || !root_full(get(request, "root"))
    {
        return Err(StoreError::InvalidArgument);
    }
    if !view.transcripts_present {
        return Err(StoreError::Corrupt);
    }
    let root = get(request, "root").expect("validated");
    if let Some(existing) = view
        .attempt_transcripts
        .iter()
        .find(|row| get(row, "attempt_id") == get(request, "attempt_id"))
    {
        if get(existing, "root_fingerprint_sha256") != get(root, "root_fingerprint_sha256") {
            return Err(StoreError::Conflict);
        }
        return Ok(Effect {
            commit: false,
            output: reference_for_row(existing),
            changes: vec![],
        });
    }
    if view.transcript_count >= MAX_TRANSCRIPT_COUNT {
        return Err(StoreError::Capacity);
    }
    let seed = json!({
        "transcript_ref": env.transcript_ref,
        "attempt_id": get(request, "attempt_id"),
        "root_fingerprint_sha256": get(root, "root_fingerprint_sha256"),
    });
    let (digest, bytes) = transcript_digest(&seed, &[], 0)?;
    let row = json!({
        "schema_version": 1,
        "transcript_ref": env.transcript_ref,
        "attempt_id": get(request, "attempt_id"),
        "root_fingerprint_sha256": get(root, "root_fingerprint_sha256"),
        "generation": 0,
        "messages": [],
        "transcript_sha256": digest,
        "transcript_bytes": bytes,
        "state": "open",
        "retention_until": null,
        "created_at": env.now,
        "updated_at": env.now,
    });
    Ok(Effect {
        commit: true,
        output: reference_for_row(&row),
        changes: vec![Change::InsertTranscript(row)],
    })
}

fn validate(request: &Value, view: &View) -> Result<Effect, StoreError> {
    if !bound_request_valid(request) {
        return Err(StoreError::InvalidArgument);
    }
    let expected = get(request, "transcript").expect("validated");
    let Some(row) = located_row(view, get(expected, "transcript_ref")) else {
        return Err(StoreError::NotFound);
    };
    if !expected_reference_matches(
        row,
        expected,
        get(request, "attempt_id"),
        get(request, "root").expect("validated"),
    ) {
        return Err(StoreError::Conflict);
    }
    row_digest_matches(row, true)?;
    Ok(Effect {
        commit: false,
        output: json!({ "schema_version": 1, "status": "valid" }),
        changes: vec![],
    })
}

fn native_messages(request: &Value, view: &View) -> Result<Effect, StoreError> {
    if !bound_request_valid(request) {
        return Err(StoreError::InvalidArgument);
    }
    let expected = get(request, "transcript").expect("validated");
    let Some(row) = located_row(view, get(expected, "transcript_ref")) else {
        return Err(StoreError::NotFound);
    };
    if !expected_reference_matches(
        row,
        expected,
        get(request, "attempt_id"),
        get(request, "root").expect("validated"),
    ) {
        return Err(StoreError::Conflict);
    }
    if !matches!(as_str(get(row, "state")), Some("open" | "terminal")) {
        return Err(StoreError::Conflict);
    }
    row_digest_matches(row, false)?;
    let messages = get(row, "messages")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    Ok(Effect {
        commit: false,
        output: messages,
        changes: vec![],
    })
}

fn append(request: &Value, env: &Env, view: &View) -> Result<Effect, StoreError> {
    let message = get(request, "message").unwrap_or(&Value::Null);
    let expected = get(request, "expected_transcript").unwrap_or(&Value::Null);
    let root = get(request, "root").unwrap_or(&Value::Null);
    let attempt_id = get(request, "attempt_id");
    if !transcript_message(message)
        || !transcript_reference(Some(expected))
        || !root_full(Some(root))
        || !canonical_uuid(attempt_id)
    {
        return Err(StoreError::InvalidArgument);
    }
    let Some(row) = located_row(view, get(expected, "transcript_ref")) else {
        return Err(StoreError::NotFound);
    };
    if !expected_reference_matches(row, expected, attempt_id, root) {
        return Err(StoreError::Conflict);
    }
    if !string_eq(get(row, "state"), "open") {
        return Err(StoreError::Conflict);
    }
    let mut messages = match get(row, "messages") {
        Some(Value::Array(messages)) if messages.len() < MAX_MESSAGES => messages.clone(),
        _ => return Err(StoreError::Capacity),
    };
    messages.push(message.clone());
    let generation = get(row, "generation").and_then(Value::as_u64).unwrap_or(0);
    if generation == MAX_SAFE_INTEGER {
        return Err(StoreError::Capacity);
    }
    let generation = generation + 1;
    let (digest, bytes) = transcript_digest(row, &messages, generation)?;
    let mut updated = object_map(row);
    set(&mut updated, "messages", Value::Array(messages));
    set(&mut updated, "generation", Value::from(generation));
    set(
        &mut updated,
        "transcript_sha256",
        Value::from(digest.as_str()),
    );
    set(&mut updated, "transcript_bytes", Value::from(bytes));
    set(&mut updated, "updated_at", Value::from(env.now.as_str()));
    let updated = Value::Object(updated);
    Ok(Effect {
        commit: true,
        output: reference_for_row(&updated),
        changes: vec![Change::ReplaceTranscript(updated)],
    })
}

fn cleanup_matches(entry: &Value, request: &Value, row: &Value) -> bool {
    get(entry, "cleanup_owner") == get(request, "cleanup_owner")
        && get(entry, "reason") == get(request, "reason")
        && get(entry, "transcript_ref") == get(row, "transcript_ref")
        && get(entry, "transcript_sha256") == get(row, "transcript_sha256")
}

fn mark_terminal(request: &Value, env: &Env, view: &View) -> Result<Effect, StoreError> {
    let keys = [
        "schema_version",
        "attempt_id",
        "root",
        "transcript",
        "reason",
        "cleanup_id",
        "cleanup_owner",
    ];
    if exact_keys(Some(request), &keys).is_none()
        || safe_integer(get(request, "schema_version"), 1, false).is_none()
        || !canonical_uuid(get(request, "attempt_id"))
        || !root_full(get(request, "root"))
        || !transcript_reference(get(request, "transcript"))
        || !reason_valid(get(request, "reason"))
        || !canonical_uuid(get(request, "cleanup_id"))
        || !canonical_uuid(get(request, "cleanup_owner"))
    {
        return Err(StoreError::InvalidArgument);
    }
    let expected = get(request, "transcript").expect("validated");
    let Some(row) = located_row(view, get(expected, "transcript_ref")) else {
        return Err(StoreError::NotFound);
    };
    if !expected_reference_matches(
        row,
        expected,
        get(request, "attempt_id"),
        get(request, "root").expect("validated"),
    ) {
        return Err(StoreError::Conflict);
    }
    let entries: Vec<&Slotted> = view
        .cleanup
        .iter()
        .filter(|entry| get(&entry.record, "cleanup_id") == get(request, "cleanup_id"))
        .collect();
    if matches!(
        as_str(get(row, "state")),
        Some("terminal" | "cleanup_pending")
    ) {
        let Some(existing) = entries.first() else {
            return Err(StoreError::Conflict);
        };
        if !cleanup_matches(&existing.record, request, row) {
            return Err(StoreError::Conflict);
        }
        return Ok(Effect {
            commit: false,
            output: json!({ "schema_version": 1, "status": "already_terminal", "transcript": reference_for_row(row) }),
            changes: vec![],
        });
    }
    if !string_eq(get(row, "state"), "open") {
        return Err(StoreError::Conflict);
    }
    let mut updated = object_map(row);
    set(&mut updated, "state", Value::from("terminal"));
    set(
        &mut updated,
        "retention_until",
        Value::from(env.retention_until.as_str()),
    );
    set(&mut updated, "updated_at", Value::from(env.now.as_str()));
    let updated = Value::Object(updated);
    for entry in &entries {
        if !cleanup_matches(&entry.record, request, &updated) {
            return Err(StoreError::Conflict);
        }
    }
    let mut changes = vec![Change::ReplaceTranscript(updated.clone())];
    if entries.is_empty() {
        changes.push(Change::InsertCleanup(json!({
            "schema_version": 1,
            "cleanup_id": get(request, "cleanup_id"),
            "attempt_id": get(request, "attempt_id"),
            "transcript_ref": get(&updated, "transcript_ref"),
            "transcript_sha256": get(&updated, "transcript_sha256"),
            "cleanup_owner": get(request, "cleanup_owner"),
            "reason": get(request, "reason"),
            "created_at": env.now,
            "status": "pending",
        })));
    }
    Ok(Effect {
        commit: true,
        output: json!({ "schema_version": 1, "status": "terminal", "transcript": reference_for_row(&updated) }),
        changes,
    })
}

fn references_transcript(row: &RowReference, transcript_ref: Option<&Value>) -> bool {
    row.before_ref.as_ref() == transcript_ref
        || (row.after_ref.is_some() && row.after_ref.as_ref() == transcript_ref)
}

fn discard(request: &Value, view: &View) -> Result<Effect, StoreError> {
    let keys = [
        "schema_version",
        "attempt_id",
        "transcript_ref",
        "transcript_sha256",
        "cleanup_id",
        "cleanup_owner",
    ];
    if exact_keys(Some(request), &keys).is_none()
        || safe_integer(get(request, "schema_version"), 1, false).is_none()
        || !canonical_uuid(get(request, "attempt_id"))
        || !canonical_uuid(get(request, "transcript_ref"))
        || !canonical_sha256(get(request, "transcript_sha256"))
        || !canonical_uuid(get(request, "cleanup_id"))
        || !canonical_uuid(get(request, "cleanup_owner"))
    {
        return Err(StoreError::InvalidArgument);
    }
    let transcript_ref = get(request, "transcript_ref");
    let entries: Vec<&Slotted> = view
        .cleanup
        .iter()
        .filter(|entry| get(&entry.record, "cleanup_id") == get(request, "cleanup_id"))
        .collect();
    let Some(row) = located_row(view, transcript_ref) else {
        for entry in &entries {
            if !string_eq(get(&entry.record, "status"), "discarded") {
                continue;
            }
            if get(&entry.record, "cleanup_owner") != get(request, "cleanup_owner")
                || get(&entry.record, "attempt_id") != get(request, "attempt_id")
                || get(&entry.record, "transcript_ref") != transcript_ref
                || get(&entry.record, "transcript_sha256") != get(request, "transcript_sha256")
            {
                return Err(StoreError::Conflict);
            }
            return Ok(Effect {
                commit: false,
                output: json!({ "schema_version": 1, "status": "already_missing" }),
                changes: vec![],
            });
        }
        return Err(StoreError::NotFound);
    };
    if get(row, "attempt_id") != get(request, "attempt_id")
        || get(row, "transcript_sha256") != get(request, "transcript_sha256")
        || !string_eq(get(row, "state"), "terminal")
    {
        return Err(StoreError::Conflict);
    }
    let Some(first) = entries.first() else {
        return Err(StoreError::Conflict);
    };
    if get(&first.record, "cleanup_owner") != get(request, "cleanup_owner")
        || get(&first.record, "transcript_ref") != transcript_ref
        || get(&first.record, "transcript_sha256") != get(request, "transcript_sha256")
    {
        return Err(StoreError::Conflict);
    }
    let active_round = |state: &str| {
        matches!(
            state,
            "in_flight" | "cancel_requested" | "unknown" | "ambiguous"
        )
    };
    if view
        .rounds
        .iter()
        .any(|round| active_round(&round.state) && references_transcript(round, transcript_ref))
    {
        return Err(StoreError::Conflict);
    }
    let active_ledger = |state: &str| {
        matches!(
            state,
            "intent" | "running" | "cancel_requested" | "unknown" | "ambiguous"
        )
    };
    if view
        .ledger
        .iter()
        .any(|row| active_ledger(&row.state) && references_transcript(row, transcript_ref))
    {
        return Err(StoreError::Conflict);
    }
    let mut changes = vec![Change::RemoveTranscript(
        transcript_ref.cloned().unwrap_or(Value::Null),
    )];
    for entry in &entries {
        let mut record = object_map(&entry.record);
        set(&mut record, "status", Value::from("discarded"));
        changes.push(Change::ReplaceCleanup {
            slot: entry.slot,
            record: Value::Object(record),
        });
    }
    Ok(Effect {
        commit: true,
        output: json!({ "schema_version": 1, "status": "discarded" }),
        changes,
    })
}

fn query_cleanup(request: &Value, view: &View) -> Result<Effect, StoreError> {
    if exact_keys(Some(request), &["schema_version", "cleanup_id"]).is_none()
        || safe_integer(get(request, "schema_version"), 1, false).is_none()
        || !canonical_uuid(get(request, "cleanup_id"))
    {
        return Err(StoreError::InvalidArgument);
    }
    let status = view
        .cleanup
        .iter()
        .find(|entry| get(&entry.record, "cleanup_id") == get(request, "cleanup_id"))
        .and_then(|entry| get(&entry.record, "status").cloned())
        .unwrap_or(Value::from("unknown"));
    Ok(Effect {
        commit: false,
        output: json!({ "schema_version": 1, "status": status }),
        changes: vec![],
    })
}

/// Runs one transcript-store operation: `create`, `validate`,
/// `native_messages`, `append`, `mark_terminal`, `discard`, `query_cleanup`.
pub fn reduce(op: &str, request: &Value, env: &Env, view: &View) -> Result<Effect, StoreError> {
    match op {
        "create" => create(request, env, view),
        "validate" => validate(request, view),
        "native_messages" => native_messages(request, view),
        "append" => append(request, env, view),
        "mark_terminal" => mark_terminal(request, env, view),
        "discard" => discard(request, view),
        "query_cleanup" => query_cleanup(request, view),
        _ => Err(StoreError::InvalidArgument),
    }
}

// MARK: - JSON envelope

fn change_json(change: &Change) -> Value {
    match change {
        Change::InsertTranscript(row) => json!({ "kind": "insert_transcript", "row": row }),
        Change::ReplaceTranscript(row) => json!({ "kind": "replace_transcript", "row": row }),
        Change::RemoveTranscript(reference) => {
            json!({ "kind": "remove_transcript", "transcript_ref": reference })
        }
        Change::InsertCleanup(record) => json!({ "kind": "insert_cleanup", "record": record }),
        Change::ReplaceCleanup { slot, record } => {
            json!({ "kind": "replace_cleanup", "slot": slot, "record": record })
        }
    }
}

/// `{"op","request","env","view"}` in; `{"ok":true,"commit","output","changes"}`
/// or `{"ok":false,"error":<code>}` out.
pub fn reduce_json(input: &str) -> String {
    let value = match reduce_json_inner(input) {
        Ok(effect) => json!({
            "ok": true,
            "commit": effect.commit,
            "output": effect.output,
            "changes": effect.changes.iter().map(change_json).collect::<Vec<_>>(),
        }),
        Err(error) => json!({ "ok": false, "error": error.code() }),
    };
    value.to_string()
}

fn row_references(value: Option<&Value>) -> Vec<RowReference> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| RowReference {
                state: as_str(get(item, "state")).unwrap_or_default().to_string(),
                before_ref: get(item, "before_ref").filter(|v| !v.is_null()).cloned(),
                after_ref: get(item, "after_ref").filter(|v| !v.is_null()).cloned(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn reduce_json_inner(input: &str) -> Result<Effect, StoreError> {
    let envelope: Value = serde_json::from_str(input).map_err(|_| StoreError::Corrupt)?;
    let op = as_str(get(&envelope, "op")).ok_or(StoreError::Corrupt)?;
    let request = get(&envelope, "request").ok_or(StoreError::Corrupt)?;
    let env_value = get(&envelope, "env").ok_or(StoreError::Corrupt)?;
    let view_value = get(&envelope, "view").ok_or(StoreError::Corrupt)?;
    let text = |key: &str| as_str(get(env_value, key)).unwrap_or_default().to_string();
    let env = Env {
        launch_id: text("launch_id"),
        now: as_str(get(env_value, "now"))
            .ok_or(StoreError::Corrupt)?
            .to_owned(),
        retention_until: text("retention_until"),
        transcript_ref: text("transcript_ref"),
    };
    let cleanup = match get(view_value, "cleanup") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                Some(Slotted {
                    slot: get(item, "slot")?.as_u64()?,
                    record: get(item, "record")?.clone(),
                })
            })
            .collect(),
        _ => Vec::new(),
    };
    let view = View {
        transcripts_present: get(view_value, "transcripts_present") == Some(&Value::Bool(true)),
        transcript_count: get(view_value, "transcript_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        attempt_transcripts: match get(view_value, "attempt_transcripts") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        },
        transcript: get(view_value, "transcript")
            .filter(|t| !t.is_null())
            .cloned(),
        cleanup,
        rounds: row_references(get(view_value, "rounds")),
        ledger: row_references(get(view_value, "ledger")),
    };
    reduce(op, request, &env, &view)
}
