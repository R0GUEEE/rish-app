//! The WAL's operation relation: start, query and commit, plus the three
//! records that share its transaction — the attempt authority, the write
//! batch and the durable denial.
//!
//! Ported from `AgentNativeWAL.mm`. Every decision here is a pure function of
//! the committed state, the command and the clock: the host keeps the file,
//! the descriptors, the lock and the transaction, and applies the returned
//! change set only when it has written and confirmed it. A rolled-back
//! transaction's discarded mutation is not observable, so it is not part of
//! the contract.

use serde_json::{json, Map, Value};

use crate::canonical::canonical_json;
use crate::schema::{canonical_sha256, canonical_uuid, safe_integer, MAX_SAFE_INTEGER};
use crate::store::StoreError;
use crate::wal_state::{
    contains_forbidden_safe_key, known_result_status, opaque_call_id, operation_result_shape,
    operation_shape, result_reference_shape, result_status_allowed, safe_result_shape,
    MAX_AUTHORITIES, MAX_BATCHES_PER_ATTEMPT, MAX_DENIED_CALLS, MAX_DENIED_CALLS_PER_ATTEMPT,
    MAX_OPERATIONS, MAX_OPERATIONS_PER_ATTEMPT, MAX_OPERATION_RECORD_BYTES,
    MAX_OPERATION_RESULT_BYTES, OPERATION_KINDS,
};

/// What the host does with the transaction it is holding.
pub enum Outcome {
    /// Replace these top-level arrays, write, and return the output.
    Commit {
        changes: Map<String, Value>,
        output: Value,
    },
    /// Write nothing; the command is an exact repeat and this is its answer.
    Replay {
        output: Value,
    },
    Error(StoreError),
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

fn as_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn string_eq(value: Option<&Value>, expected: &str) -> bool {
    as_str(value) == Some(expected)
}

fn is_null(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}

fn hash_json(label: &str, value: &Value) -> Option<String> {
    crate::canonical::hash_json(label, value)
}

/// `DSHAgentWALFindOperation`.
fn find_operation<'a>(operations: &'a [Value], id: Option<&Value>) -> Option<&'a Value> {
    operations
        .iter()
        .find(|operation| get(operation, "operation_id") == id)
}

/// `DSHAgentWALFindOperationResult`.
fn find_result<'a>(results: &'a [Value], id: Option<&Value>) -> Option<&'a Value> {
    results
        .iter()
        .find(|result| get(result, "operation_id") == id)
}

/// `DSHAgentWALCanonicalEqual`.
fn canonical_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => match (canonical_json(left), canonical_json(right)) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        },
        _ => false,
    }
}

/// `DSHAgentWALRequestSHA`.
pub fn request_sha(operation_kind: &str, request: &Value) -> Option<String> {
    hash_json(
        "agent-operation-request",
        &json!({ "operation_kind": operation_kind, "request": request }),
    )
}

/// `DSHAgentWALReplayEnvelope`.
fn replay_envelope(operation: &Value, snapshot: Option<&Value>) -> Value {
    match snapshot {
        None => json!({
            "schema_version": 2,
            "status": "started",
            "request_sha256": get(operation, "request_sha256"),
            "record": operation,
            "result": Value::Null,
        }),
        Some(snapshot) => json!({
            "schema_version": 2,
            "status": "replayed",
            "request_sha256": get(operation, "request_sha256"),
            "record": operation,
            "result": get(snapshot, "result"),
        }),
    }
}

/// `DSHAgentWALMakeOperationResult`.
fn make_operation_result(
    operation_id: &Value,
    operation_kind: &Value,
    result_status: &Value,
    safe_result: &Value,
    timestamp: &str,
) -> Result<Value, StoreError> {
    if !safe_result_shape(
        Some(safe_result),
        Some(operation_kind),
        Some(operation_id),
        Some(result_status),
    ) {
        return Err(StoreError::InvalidArgument);
    }
    let bytes = canonical_json(safe_result).map_err(|_| StoreError::InvalidArgument)?;
    let digest = hash_json(
        "agent-operation-result",
        &json!({
            "operation_kind": operation_kind,
            "result_status": result_status,
            "result": safe_result,
        }),
    );
    if bytes.len() > MAX_OPERATION_RESULT_BYTES as usize {
        return Err(StoreError::Capacity);
    }
    let Some(digest) = digest.filter(|_| !bytes.is_empty()) else {
        return Err(StoreError::InvalidArgument);
    };
    let snapshot = json!({
        "schema_version": 2,
        "operation_id": operation_id,
        "operation_kind": operation_kind,
        "result_status": result_status,
        "result_sha256": digest,
        "result_bytes": bytes.len(),
        "result": safe_result,
        "created_at": timestamp,
    });
    if !operation_result_shape(&snapshot) {
        return Err(StoreError::InvalidArgument);
    }
    Ok(snapshot)
}

/// `DSHAgentWALCompactAcknowledgedEvidence`: an attempt whose cleanup row was
/// discarded and which nothing in flight still refers to has its terminal
/// operations, their results, its batches and its denials dropped. Returns the
/// replaced arrays, or `None` when nothing changes.
fn compact_acknowledged_evidence(state: &Value) -> Option<Map<String, Value>> {
    let mut acknowledged: Vec<&Value> = Vec::new();
    for cleanup in array(get(state, "cleanup")) {
        let attempt = get(cleanup, "attempt_id");
        if string_eq(get(cleanup, "status"), "discarded")
            && attempt.is_some_and(Value::is_string)
            && !acknowledged.contains(&attempt.expect("checked"))
        {
            acknowledged.push(attempt.expect("checked"));
        }
    }
    if acknowledged.is_empty() {
        return None;
    }
    let mut protected: Vec<&Value> = Vec::new();
    for authority in array(get(state, "authorities")) {
        if let Some(attempt) = get(authority, "attempt_id") {
            protected.push(attempt);
        }
    }
    for round in array(get(state, "rounds")) {
        if matches!(
            as_str(get(round, "state")),
            Some("in_flight" | "cancel_requested" | "failed_retryable" | "unknown" | "ambiguous")
        ) {
            if let Some(attempt) = get(round, "locator").and_then(|l| get(l, "attempt_id")) {
                protected.push(attempt);
            }
        }
    }
    for ledger in array(get(state, "ledger")) {
        if matches!(
            as_str(get(ledger, "state")),
            Some("intent" | "running" | "cancel_requested" | "unknown" | "ambiguous")
        ) {
            if let Some(attempt) = get(ledger, "locator").and_then(|l| get(l, "attempt_id")) {
                protected.push(attempt);
            }
        }
    }
    acknowledged.retain(|attempt| !protected.contains(attempt));
    if acknowledged.is_empty() {
        return None;
    }
    let mut removed: Vec<&Value> = Vec::new();
    let mut operations: Vec<Value> = Vec::new();
    for operation in array(get(state, "operations")) {
        let terminal = matches!(
            as_str(get(operation, "state")),
            Some("committed" | "rejected" | "conflict")
        );
        let attempt = get(operation, "attempt_id");
        if terminal && attempt.is_some_and(|attempt| acknowledged.contains(&attempt)) {
            if let Some(id) = get(operation, "operation_id") {
                removed.push(id);
            }
        } else {
            operations.push(operation.clone());
        }
    }
    let results: Vec<Value> = array(get(state, "operation_results"))
        .iter()
        .filter(|result| !get(result, "operation_id").is_some_and(|id| removed.contains(&id)))
        .cloned()
        .collect();
    let batches: Vec<Value> = array(get(state, "batches"))
        .iter()
        .filter(|batch| {
            !get(batch, "attempt_id").is_some_and(|attempt| acknowledged.contains(&attempt))
        })
        .cloned()
        .collect();
    let denials: Vec<Value> = array(get(state, "denied_calls"))
        .iter()
        .filter(|denial| {
            !get(denial, "attempt_id").is_some_and(|attempt| acknowledged.contains(&attempt))
        })
        .cloned()
        .collect();
    let changed = operations.len() != array(get(state, "operations")).len()
        || results.len() != array(get(state, "operation_results")).len()
        || batches.len() != array(get(state, "batches")).len()
        || denials.len() != array(get(state, "denied_calls")).len();
    if !changed {
        return None;
    }
    let mut changes = Map::new();
    changes.insert("operations".into(), Value::Array(operations));
    changes.insert("operation_results".into(), Value::Array(results));
    changes.insert("batches".into(), Value::Array(batches));
    changes.insert("denied_calls".into(), Value::Array(denials));
    Some(changes)
}

/// Reads a top-level array through a pending change set, so a decision taken
/// after compaction sees the compacted rows.
fn rows<'a>(state: &'a Value, changes: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    changes
        .get(key)
        .or_else(|| get(state, key))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn count_by_attempt(rows: &[Value], attempt: Option<&Value>) -> usize {
    rows.iter()
        .filter(|row| get(row, "attempt_id") == attempt)
        .count()
}

/// The identity a start is bound to, once the arguments have been proved.
struct Started<'a> {
    operation_kind: &'a Value,
    operation_id: &'a Value,
    request_sha256: String,
    task_id: &'a Value,
    attempt_id: &'a Value,
    authority_revision: &'a Value,
}

/// `DSHAgentWALStartValidatedOperation`.
fn start_validated(state: &Value, started: &Started, timestamp: &str) -> Outcome {
    let Started {
        operation_kind,
        operation_id,
        request_sha256,
        task_id,
        attempt_id,
        authority_revision,
    } = started;
    let (operation_kind, operation_id) = (*operation_kind, *operation_id);
    let (task_id, attempt_id, authority_revision) = (*task_id, *attempt_id, *authority_revision);
    let request_sha256 = request_sha256.as_str();
    let operations = array(get(state, "operations"));
    if let Some(existing) = find_operation(operations, Some(operation_id)) {
        if !string_eq(get(existing, "request_sha256"), request_sha256)
            || get(existing, "operation_kind") != Some(operation_kind)
            || get(existing, "task_id") != Some(task_id)
            || get(existing, "attempt_id") != Some(attempt_id)
            || get(existing, "authority_revision") != Some(authority_revision)
        {
            return Outcome::Error(StoreError::Conflict);
        }
        let snapshot = find_result(array(get(state, "operation_results")), Some(operation_id));
        return Outcome::Replay {
            output: replay_envelope(existing, snapshot),
        };
    }
    let mut changes = Map::new();
    let over_capacity = |changes: &Map<String, Value>| {
        let operations = rows(state, changes, "operations");
        count_by_attempt(operations, Some(attempt_id)) >= MAX_OPERATIONS_PER_ATTEMPT
            || operations.len() >= MAX_OPERATIONS
    };
    if over_capacity(&changes) {
        if let Some(compacted) = compact_acknowledged_evidence(state) {
            changes = compacted;
        }
        if over_capacity(&changes) {
            return Outcome::Error(StoreError::Capacity);
        }
    }
    let record = json!({
        "schema_version": 2,
        "operation_id": operation_id,
        "operation_kind": operation_kind,
        "request_sha256": request_sha256,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "result_ref": { "schema_version": 2, "kind": "none" },
        "state": "started",
        "result_status": "pending",
        "result_revision": Value::Null,
        "result_snapshot_ref": Value::Null,
        "authority_revision": authority_revision,
        "created_at": timestamp,
        "updated_at": timestamp,
    });
    match canonical_json(&record) {
        Ok(bytes) if bytes.len() > MAX_OPERATION_RECORD_BYTES => {
            return Outcome::Error(StoreError::Capacity)
        }
        Ok(_) if operation_shape(&record) => {}
        _ => return Outcome::Error(StoreError::InvalidArgument),
    }
    let mut operations = rows(state, &changes, "operations").to_vec();
    operations.push(record.clone());
    changes.insert("operations".into(), Value::Array(operations));
    Outcome::Commit {
        changes,
        output: replay_envelope(&record, None),
    }
}

/// `DSHAgentNativeWALStartOperation`.
pub fn start(state: &Value, arguments: &Value, timestamp: &str) -> Outcome {
    let request = get(arguments, "request");
    let operation_kind = get(arguments, "operation_kind");
    let task_id = get(arguments, "task_id");
    let attempt_id = get(arguments, "attempt_id");
    let authority_revision = get(arguments, "authority_revision");
    let operation_id = request.and_then(|request| get(request, "operation_id"));
    if !as_str(operation_kind).is_some_and(|kind| OPERATION_KINDS.contains(&kind))
        || !request.is_some_and(Value::is_object)
        || request.and_then(|request| get(request, "schema_version")) != Some(&json!(2))
        || !canonical_uuid(operation_id)
        || !canonical_uuid(task_id)
        || !canonical_uuid(attempt_id)
        || request.and_then(|request| get(request, "task_id")) != task_id
        || request.and_then(|request| get(request, "attempt_id")) != attempt_id
        || safe_integer(authority_revision, MAX_SAFE_INTEGER, true).is_none()
        || request.is_some_and(contains_forbidden_safe_key)
    {
        return Outcome::Error(StoreError::InvalidArgument);
    }
    let (Some(request), Some(kind)) = (request, as_str(operation_kind)) else {
        return Outcome::Error(StoreError::InvalidArgument);
    };
    let Some(request_sha256) = request_sha(kind, request) else {
        return Outcome::Error(StoreError::InvalidArgument);
    };
    start_validated(
        state,
        &Started {
            operation_kind: operation_kind.expect("checked"),
            operation_id: operation_id.expect("checked"),
            request_sha256,
            task_id: task_id.expect("checked"),
            attempt_id: attempt_id.expect("checked"),
            authority_revision: authority_revision.expect("checked"),
        },
        timestamp,
    )
}

/// `DSHAgentWALTargetIdentity`.
fn target_identity(
    target: Option<&Value>,
    task_id: Option<&Value>,
    attempt_id: Option<&Value>,
) -> bool {
    let t = |key: &str| target.and_then(|target| get(target, key));
    if !target.is_some_and(Value::is_object)
        || t("schema_version") != Some(&json!(2))
        || t("task_id") != task_id
        || t("attempt_id") != attempt_id
        || !canonical_uuid(task_id)
        || !canonical_uuid(attempt_id)
        || !t("kind").is_some_and(Value::is_string)
    {
        return false;
    }
    let exact = |keys: &[&str]| {
        target.and_then(Value::as_object).is_some_and(|map| {
            map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key))
        })
    };
    let kind = as_str(t("kind")).unwrap_or_default();
    if kind == "attempt" {
        return exact(&["schema_version", "kind", "task_id", "attempt_id"]);
    }
    if kind != "round" && kind != "tool" {
        return false;
    }
    if !canonical_uuid(t("round_id")) || safe_integer(t("round_index"), 7, true).is_none() {
        return false;
    }
    let base = [
        "schema_version",
        "kind",
        "task_id",
        "attempt_id",
        "round_id",
        "round_index",
    ];
    if kind == "round" {
        return exact(&base);
    }
    let mut keys = base.to_vec();
    keys.extend_from_slice(&["call_index", "call_id", "idempotency_key"]);
    exact(&keys)
        && safe_integer(t("call_index"), 15, true).is_some()
        && opaque_call_id(t("call_id"))
        && canonical_sha256(t("idempotency_key"))
}

/// `DSHAgentNativeWALStartTargetOperation`.
pub fn start_target(state: &Value, arguments: &Value, timestamp: &str) -> Outcome {
    let request = get(arguments, "request");
    let target = get(arguments, "target");
    let operation_kind = get(arguments, "operation_kind");
    let task_id = get(arguments, "task_id");
    let attempt_id = get(arguments, "attempt_id");
    let authority_revision = get(arguments, "authority_revision");
    let request_keys: &[&str] = match as_str(operation_kind) {
        Some("cancel_agent_attempt") => &[
            "schema_version",
            "operation_id",
            "controller_cas",
            "committed_checkpoint",
            "target",
            "cancel_token",
            "expected_round_revision",
            "expected_execution_revision",
            "expected_transcript",
            "root",
        ],
        Some("recover_agent_attempt") => &[
            "schema_version",
            "operation_id",
            "controller_cas",
            "committed_checkpoint",
            "target",
            "action",
            "expected_round_revision",
            "expected_execution_revision",
            "expected_transcript",
            "root",
        ],
        _ => return Outcome::Error(StoreError::InvalidArgument),
    };
    let operation_id = request.and_then(|request| get(request, "operation_id"));
    let exact = request.and_then(Value::as_object).is_some_and(|map| {
        map.len() == request_keys.len() && request_keys.iter().all(|key| map.contains_key(*key))
    });
    if !request.is_some_and(Value::is_object)
        || !target.is_some_and(Value::is_object)
        || !exact
        || request.and_then(|request| get(request, "schema_version")) != Some(&json!(2))
        || !canonical_uuid(operation_id)
        || !canonical_equal(request.and_then(|request| get(request, "target")), target)
        || !target_identity(target, task_id, attempt_id)
        || safe_integer(authority_revision, MAX_SAFE_INTEGER, true).is_none()
        || request.is_some_and(contains_forbidden_safe_key)
    {
        return Outcome::Error(StoreError::InvalidArgument);
    }
    let (Some(request), Some(kind)) = (request, as_str(operation_kind)) else {
        return Outcome::Error(StoreError::InvalidArgument);
    };
    let Some(request_sha256) = request_sha(kind, request) else {
        return Outcome::Error(StoreError::InvalidArgument);
    };
    start_validated(
        state,
        &Started {
            operation_kind: operation_kind.expect("checked"),
            operation_id: operation_id.expect("checked"),
            request_sha256,
            task_id: task_id.expect("checked"),
            attempt_id: attempt_id.expect("checked"),
            authority_revision: authority_revision.expect("checked"),
        },
        timestamp,
    )
}

/// `DSHAgentNativeWALQueryOperation`. A query never writes: it either proves
/// the operation was never started, that the identity does not match, or hands
/// back the record as stored.
pub fn query(state: &Value, arguments: &Value) -> Result<Value, StoreError> {
    let operation_id = get(arguments, "operation_id");
    let request_sha256 = get(arguments, "request_sha256");
    let task_id = get(arguments, "task_id");
    let attempt_id = get(arguments, "attempt_id");
    if !canonical_uuid(operation_id)
        || !canonical_sha256(request_sha256)
        || !canonical_uuid(task_id)
        || !canonical_uuid(attempt_id)
    {
        return Err(StoreError::InvalidArgument);
    }
    let Some(operation) = find_operation(array(get(state, "operations")), operation_id) else {
        return Ok(json!({ "schema_version": 2, "status": "not_started" }));
    };
    if get(operation, "request_sha256") != request_sha256
        || get(operation, "task_id") != task_id
        || get(operation, "attempt_id") != attempt_id
    {
        return Ok(json!({
            "schema_version": 2,
            "status": "conflict",
            "actual_request_sha256": get(operation, "request_sha256"),
            "actual_state": get(operation, "state"),
        }));
    }
    Ok(json!({ "schema_version": 2, "status": "found", "record": operation }))
}

/// What a commit may still do once the host's fault hook has had its say.
pub enum CommitPrepared {
    /// The exact same commit already settled; this is its answer.
    Replay {
        output: Value,
    },
    /// Apply this result snapshot to the operation.
    Proceed {
        snapshot: Value,
    },
    Error(StoreError),
}

const TERMINAL_STATES: &[&str] = &["committed", "rejected", "conflict", "unknown", "ambiguous"];

fn commit_arguments_valid(arguments: &Value) -> Result<(), StoreError> {
    let terminal_state = get(arguments, "terminal_state");
    let result_ref = get(arguments, "result_ref");
    let result_revision = get(arguments, "result_revision");
    if !canonical_uuid(get(arguments, "operation_id"))
        || !canonical_sha256(get(arguments, "request_sha256"))
        || !canonical_uuid(get(arguments, "task_id"))
        || !canonical_uuid(get(arguments, "attempt_id"))
        || !as_str(terminal_state).is_some_and(|state| TERMINAL_STATES.contains(&state))
        || !known_result_status(get(arguments, "result_status"))
        || !result_reference_shape(result_ref)
        || !(is_null(result_revision)
            || safe_integer(result_revision, MAX_SAFE_INTEGER, false).is_some())
        || !get(arguments, "safe_result").is_some_and(Value::is_object)
    {
        return Err(StoreError::InvalidArgument);
    }
    // The reference and the revision are the same fact seen twice: a commit
    // carries both, a rejection or conflict neither, and the two unsettled
    // terminals must agree with each other.
    let none = string_eq(result_ref.and_then(|r| get(r, "kind")), "none");
    let null_revision = is_null(result_revision);
    let refused = match as_str(terminal_state) {
        Some("committed") => none || null_revision,
        Some("rejected" | "conflict") => !none || !null_revision,
        Some("unknown" | "ambiguous") => none != null_revision,
        _ => true,
    };
    if refused {
        return Err(StoreError::InvalidArgument);
    }
    Ok(())
}

/// The first half of `DSHAgentNativeWALCommitOperation`, up to the point where
/// the in-state variant lets the host's fault hook refuse.
pub fn commit_prepare(state: &Value, arguments: &Value, timestamp: &str) -> CommitPrepared {
    if let Err(error) = commit_arguments_valid(arguments) {
        return CommitPrepared::Error(error);
    }
    let operation_id = get(arguments, "operation_id");
    let result_status = get(arguments, "result_status").expect("checked");
    let Some(operation) = find_operation(array(get(state, "operations")), operation_id) else {
        return CommitPrepared::Error(StoreError::NotFound);
    };
    if get(operation, "request_sha256") != get(arguments, "request_sha256")
        || get(operation, "task_id") != get(arguments, "task_id")
        || get(operation, "attempt_id") != get(arguments, "attempt_id")
        || !result_status_allowed(
            as_str(get(operation, "operation_kind")),
            as_str(Some(result_status)),
        )
    {
        return CommitPrepared::Error(StoreError::Conflict);
    }
    let snapshot = match make_operation_result(
        operation_id.expect("checked"),
        get(operation, "operation_kind").unwrap_or(&Value::Null),
        result_status,
        get(arguments, "safe_result").expect("checked"),
        timestamp,
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => return CommitPrepared::Error(error),
    };
    let existing = find_result(array(get(state, "operation_results")), operation_id);
    if !string_eq(get(operation, "state"), "started") {
        let revision = get(arguments, "result_revision").unwrap_or(&Value::Null);
        let normalized = if revision.is_null() {
            &Value::Null
        } else {
            revision
        };
        if get(operation, "state") == get(arguments, "terminal_state")
            && get(operation, "result_status") == Some(result_status)
            && get(operation, "result_ref") == get(arguments, "result_ref")
            && get(operation, "result_revision") == Some(normalized)
            && canonical_equal(existing, Some(&snapshot))
        {
            return CommitPrepared::Replay {
                output: replay_envelope(operation, existing),
            };
        }
        return CommitPrepared::Error(StoreError::Conflict);
    }
    if existing.is_some() {
        // A started operation that already has a result snapshot is a torn
        // commit, not a repeat.
        return CommitPrepared::Error(StoreError::Corrupt);
    }
    CommitPrepared::Proceed { snapshot }
}

/// The second half: the operation record the commit settles, and the snapshot
/// stored beside it.
pub fn commit_apply(
    state: &Value,
    arguments: &Value,
    snapshot: &Value,
    timestamp: &str,
) -> Outcome {
    let operation_id = get(arguments, "operation_id");
    let operations = array(get(state, "operations"));
    let Some(index) = operations
        .iter()
        .position(|operation| get(operation, "operation_id") == operation_id)
    else {
        return Outcome::Error(StoreError::NotFound);
    };
    let revision = get(arguments, "result_revision").unwrap_or(&Value::Null);
    let mut updated = operations[index].as_object().cloned().unwrap_or_default();
    updated.insert(
        "state".into(),
        get(arguments, "terminal_state")
            .cloned()
            .unwrap_or(Value::Null),
    );
    updated.insert(
        "result_status".into(),
        get(arguments, "result_status")
            .cloned()
            .unwrap_or(Value::Null),
    );
    updated.insert(
        "result_ref".into(),
        get(arguments, "result_ref").cloned().unwrap_or(Value::Null),
    );
    updated.insert("result_revision".into(), revision.clone());
    updated.insert(
        "result_snapshot_ref".into(),
        json!({
            "schema_version": 2,
            "operation_id": operation_id,
            "result_sha256": get(snapshot, "result_sha256"),
            "result_bytes": get(snapshot, "result_bytes"),
        }),
    );
    updated.insert("updated_at".into(), json!(timestamp));
    let updated = Value::Object(updated);
    match canonical_json(&updated) {
        Ok(bytes) if bytes.len() > MAX_OPERATION_RECORD_BYTES => {
            return Outcome::Error(StoreError::Capacity)
        }
        Ok(_) if operation_shape(&updated) => {}
        _ => return Outcome::Error(StoreError::InvalidArgument),
    }
    let mut results = array(get(state, "operation_results")).to_vec();
    if results.len() >= MAX_OPERATIONS {
        return Outcome::Error(StoreError::Capacity);
    }
    let mut operations = operations.to_vec();
    operations[index] = updated.clone();
    results.push(snapshot.clone());
    let mut changes = Map::new();
    changes.insert("operations".into(), Value::Array(operations));
    changes.insert("operation_results".into(), Value::Array(results));
    Outcome::Commit {
        changes,
        output: replay_envelope(&updated, Some(snapshot)),
    }
}

/// `DSHAgentNativeWALPrepareAuthorityOperation`: the one operation that is
/// started and committed in the same transaction, because the authority it
/// creates is the result.
pub fn prepare_authority(state: &Value, arguments: &Value, timestamp: &str) -> Outcome {
    let authority = get(arguments, "authority");
    let request = get(arguments, "request");
    let safe_result = get(arguments, "safe_result");
    let operation_id = request.and_then(|request| get(request, "operation_id"));
    let task_id = authority.and_then(|authority| get(authority, "task_id"));
    let attempt_id = authority.and_then(|authority| get(authority, "attempt_id"));
    let result_status = safe_result
        .and_then(|result| get(result, "result"))
        .and_then(|result| get(result, "status"));
    let env = crate::session_schema::env_from_json(get(arguments, "env"));
    if !authority.is_some_and(|authority| crate::wal_state::authority_shape(authority, &env))
        || authority.and_then(|authority| get(authority, "authority_revision")) != Some(&json!(1))
        || request.and_then(|request| get(request, "schema_version")) != Some(&json!(2))
        || !canonical_uuid(operation_id)
        || request.and_then(|request| get(request, "task_id")) != task_id
        || request.and_then(|request| get(request, "attempt_id")) != attempt_id
        || request.and_then(|request| get(request, "conversation_id"))
            != authority.and_then(|authority| get(authority, "conversation_id"))
        || request.is_some_and(contains_forbidden_safe_key)
        || !result_status_allowed(Some("prepare_agent_attempt"), as_str(result_status))
        || !safe_result_shape(
            safe_result,
            Some(&json!("prepare_agent_attempt")),
            operation_id,
            result_status,
        )
    {
        return Outcome::Error(StoreError::InvalidArgument);
    }
    let Some(request_sha256) = request_sha("prepare_agent_attempt", request.expect("checked"))
    else {
        return Outcome::Error(StoreError::InvalidArgument);
    };
    if let Some(existing) = find_operation(array(get(state, "operations")), operation_id) {
        if !string_eq(get(existing, "request_sha256"), &request_sha256)
            || !string_eq(get(existing, "operation_kind"), "prepare_agent_attempt")
            || get(existing, "task_id") != task_id
            || get(existing, "attempt_id") != attempt_id
        {
            return Outcome::Error(StoreError::Conflict);
        }
        let Some(snapshot) = find_result(array(get(state, "operation_results")), operation_id)
        else {
            // The operation is durable but its result is not: the transaction
            // that should have written both was torn.
            return Outcome::Error(StoreError::Persistence);
        };
        return Outcome::Replay {
            output: replay_envelope(existing, Some(snapshot)),
        };
    }
    let authorities = array(get(state, "authorities"));
    let existing_authority = authorities.iter().any(|candidate| {
        get(candidate, "task_id") == task_id && get(candidate, "attempt_id") == attempt_id
    });
    if existing_authority {
        return Outcome::Error(StoreError::Conflict);
    }
    if authorities.len() >= MAX_AUTHORITIES {
        return Outcome::Error(StoreError::Capacity);
    }
    let operations = array(get(state, "operations"));
    if count_by_attempt(operations, attempt_id) >= MAX_OPERATIONS_PER_ATTEMPT
        || operations.len() >= MAX_OPERATIONS
        || array(get(state, "operation_results")).len() >= MAX_OPERATIONS
    {
        return Outcome::Error(StoreError::Capacity);
    }
    let authority = authority.expect("checked");
    let transcript = get(authority, "transcript");
    let t = |key: &str| transcript.and_then(|transcript| get(transcript, key));
    let matches = array(get(state, "transcripts")).iter().any(|candidate| {
        get(candidate, "transcript_ref") == t("transcript_ref")
            && get(candidate, "attempt_id") == attempt_id
            && get(candidate, "root_fingerprint_sha256")
                == get(authority, "root").and_then(|root| get(root, "root_fingerprint_sha256"))
            && get(candidate, "generation") == t("generation")
            && get(candidate, "transcript_sha256") == t("transcript_sha256")
            && get(candidate, "transcript_bytes") == t("transcript_bytes")
    });
    if !matches {
        return Outcome::Error(StoreError::Conflict);
    }
    let snapshot = match make_operation_result(
        operation_id.expect("checked"),
        &json!("prepare_agent_attempt"),
        result_status.unwrap_or(&Value::Null),
        safe_result.expect("checked"),
        timestamp,
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => return Outcome::Error(error),
    };
    let operation = json!({
        "schema_version": 2,
        "operation_id": operation_id,
        "operation_kind": "prepare_agent_attempt",
        "request_sha256": request_sha256,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "result_ref": {
            "schema_version": 2,
            "kind": "authority",
            "task_id": task_id,
            "attempt_id": attempt_id,
            "authority_revision": 1,
        },
        "state": "committed",
        "result_status": result_status,
        "result_revision": 1,
        "result_snapshot_ref": {
            "schema_version": 2,
            "operation_id": operation_id,
            "result_sha256": get(&snapshot, "result_sha256"),
            "result_bytes": get(&snapshot, "result_bytes"),
        },
        "authority_revision": 1,
        "created_at": timestamp,
        "updated_at": timestamp,
    });
    if !operation_shape(&operation) {
        return Outcome::Error(StoreError::InvalidArgument);
    }
    let mut authorities = authorities.to_vec();
    let mut operations = operations.to_vec();
    let mut results = array(get(state, "operation_results")).to_vec();
    authorities.push(authority.clone());
    operations.push(operation.clone());
    results.push(snapshot.clone());
    let mut changes = Map::new();
    changes.insert("authorities".into(), Value::Array(authorities));
    changes.insert("operations".into(), Value::Array(operations));
    changes.insert("operation_results".into(), Value::Array(results));
    Outcome::Commit {
        changes,
        output: replay_envelope(&operation, Some(&snapshot)),
    }
}

/// `DSHAgentNativeWALRecordBatch`: a batch is identified by its revision, so
/// re-recording the identical batch is the same fact and re-recording a
/// different one under the same revision is a conflict.
pub fn record_batch(state: &Value, arguments: &Value) -> Outcome {
    let Some(batch) = get(arguments, "batch") else {
        return Outcome::Error(StoreError::InvalidArgument);
    };
    if !crate::wal_state::batch_shape_v2(batch) {
        return Outcome::Error(StoreError::InvalidArgument);
    }
    let identity = [
        "task_id",
        "attempt_id",
        "round_id",
        "round_index",
        "batch_revision",
    ];
    for candidate in array(get(state, "batches")) {
        if !identity
            .iter()
            .all(|key| get(candidate, key) == get(batch, key))
        {
            continue;
        }
        if !canonical_equal(Some(candidate), Some(batch)) {
            return Outcome::Error(StoreError::Conflict);
        }
        return Outcome::Replay {
            output: candidate.clone(),
        };
    }
    let attempt_id = get(batch, "attempt_id");
    let mut changes = Map::new();
    if count_by_attempt(array(get(state, "batches")), attempt_id) >= MAX_BATCHES_PER_ATTEMPT {
        if let Some(compacted) = compact_acknowledged_evidence(state) {
            changes = compacted;
        }
        if count_by_attempt(rows(state, &changes, "batches"), attempt_id) >= MAX_BATCHES_PER_ATTEMPT
        {
            return Outcome::Error(StoreError::Capacity);
        }
    }
    let mut batches = rows(state, &changes, "batches").to_vec();
    batches.push(batch.clone());
    changes.insert("batches".into(), Value::Array(batches));
    Outcome::Commit {
        changes,
        output: batch.clone(),
    }
}

/// `DSHAgentNativeWALRecordDeniedCall`.
pub fn record_denied_call(state: &Value, arguments: &Value) -> Outcome {
    let Some(call) = get(arguments, "denied_call") else {
        return Outcome::Error(StoreError::InvalidArgument);
    };
    if !crate::wal_state::denied_call_shape(call) {
        return Outcome::Error(StoreError::InvalidArgument);
    }
    let identity = [
        "task_id",
        "attempt_id",
        "round_id",
        "round_index",
        "call_index",
        "call_id",
        "arguments_sha256",
    ];
    for candidate in array(get(state, "denied_calls")) {
        if !identity
            .iter()
            .all(|key| get(candidate, key) == get(call, key))
        {
            continue;
        }
        if !canonical_equal(Some(candidate), Some(call)) {
            return Outcome::Error(StoreError::Conflict);
        }
        return Outcome::Replay {
            output: candidate.clone(),
        };
    }
    let attempt_id = get(call, "attempt_id");
    let denials = array(get(state, "denied_calls"));
    let mut changes = Map::new();
    if count_by_attempt(denials, attempt_id) >= MAX_DENIED_CALLS_PER_ATTEMPT
        || denials.len() >= MAX_DENIED_CALLS
    {
        if let Some(compacted) = compact_acknowledged_evidence(state) {
            changes = compacted;
        }
        let denials = rows(state, &changes, "denied_calls");
        if count_by_attempt(denials, attempt_id) >= MAX_DENIED_CALLS_PER_ATTEMPT
            || denials.len() >= MAX_DENIED_CALLS
        {
            return Outcome::Error(StoreError::Capacity);
        }
    }
    let mut denials = rows(state, &changes, "denied_calls").to_vec();
    denials.push(call.clone());
    changes.insert("denied_calls".into(), Value::Array(denials));
    Outcome::Commit {
        changes,
        output: call.clone(),
    }
}

fn outcome_json(outcome: Outcome) -> Value {
    match outcome {
        Outcome::Commit { changes, output } => {
            json!({ "result": "commit", "changes": Value::Object(changes), "output": output })
        }
        Outcome::Replay { output } => json!({ "result": "replay", "output": output }),
        Outcome::Error(error) => json!({ "result": "error", "error": error.code() }),
    }
}

/// `rish_agent_wal_operation_reduce`.
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
    let op = as_str(get(&envelope, "op")).ok_or(StoreError::Corrupt)?;
    let state = get(&envelope, "state").ok_or(StoreError::InvalidArgument)?;
    let arguments = get(&envelope, "arguments").ok_or(StoreError::InvalidArgument)?;
    let timestamp = as_str(get(&envelope, "timestamp")).unwrap_or_default();
    Ok(match op {
        "start" => outcome_json(start(state, arguments, timestamp)),
        "start_target" => outcome_json(start_target(state, arguments, timestamp)),
        "query" => match query(state, arguments) {
            Ok(output) => json!({ "result": "replay", "output": output }),
            Err(error) => json!({ "result": "error", "error": error.code() }),
        },
        "commit_prepare" => match commit_prepare(state, arguments, timestamp) {
            CommitPrepared::Replay { output } => json!({ "result": "replay", "output": output }),
            CommitPrepared::Proceed { snapshot } => {
                json!({ "result": "proceed", "snapshot": snapshot })
            }
            CommitPrepared::Error(error) => json!({ "result": "error", "error": error.code() }),
        },
        "commit_apply" => {
            let snapshot = get(&envelope, "snapshot").ok_or(StoreError::InvalidArgument)?;
            outcome_json(commit_apply(state, arguments, snapshot, timestamp))
        }
        "prepare_authority" => outcome_json(prepare_authority(state, arguments, timestamp)),
        "record_batch" => outcome_json(record_batch(state, arguments)),
        "record_denied_call" => outcome_json(record_denied_call(state, arguments)),
        _ => return Err(StoreError::InvalidArgument),
    })
}
