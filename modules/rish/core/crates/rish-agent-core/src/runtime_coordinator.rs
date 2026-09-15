//! The runtime coordinator's decisions, ported from `AgentRuntimeCoordinator.mm`.
//!
//! This first cut covers the read-only half: request shapes, the session proof
//! every controller-facing operation starts from, and the tool and attempt
//! projections. The host keeps the stores, the transactions and the executors;
//! it loads the session snapshot and the WAL state and passes both in, and
//! calls the typed services itself, handing their answers back as facts.

use serde_json::{json, Map, Value};

use crate::canonical::hash_json;
use crate::schema::{
    canonical_sha256, canonical_timestamp, canonical_uuid, exact_keys, is_null, safe_integer,
    MAX_SAFE_INTEGER,
};
use crate::store::StoreError;

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
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

fn owned(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn u64_of(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// The exact keys each controller-facing request carries. `DSHRuntimeRequest`
/// additionally pins `schema_version` to 2.
fn request_keys(op: &str) -> Option<&'static [&'static str]> {
    Some(match op {
        "query_tool" => &[
            "schema_version",
            "controller_cas",
            "task_id",
            "conversation_id",
            "attempt_id",
            "round_id",
            "round_index",
            "call_index",
            "call_id",
            "idempotency_key",
            "expected_execution_revision",
            "expected_transcript",
            "expected_root_fingerprint_sha256",
            "expected_workspace_binding_revision",
        ],
        "query_attempt" => &[
            "schema_version",
            "controller_cas",
            "task_id",
            "conversation_id",
            "attempt_id",
            "expected_journal_revision",
            "expected_session_generation",
            "expected_session_sha256",
            "expected_transcript",
            "expected_root_fingerprint_sha256",
            "expected_workspace_binding_revision",
        ],
        _ => return None,
    })
}

/// `DSHRuntimeControllerMatchesIdentity`.
fn controller_matches_identity(request: &Value) -> bool {
    let cas = get(request, "controller_cas");
    cas.is_some_and(Value::is_object)
        && at(cas, "conversation_id") == get(request, "conversation_id")
        && at(cas, "task_id") == get(request, "task_id")
        && at(cas, "attempt_id") == get(request, "attempt_id")
}

/// `DSHRuntimeRequest` plus the identity check every query starts with.
pub fn request_shape(op: &str, request: &Value) -> Result<(), StoreError> {
    let Some(keys) = request_keys(op) else {
        return Err(StoreError::InvalidArgument);
    };
    if exact_keys(Some(request), keys).is_none()
        || get(request, "schema_version") != Some(&json!(2))
        || !controller_matches_identity(request)
    {
        return Err(StoreError::InvalidArgument);
    }
    Ok(())
}

/// The execution locator `queryAgentTool` builds from its request.
pub fn tool_locator(request: &Value) -> Value {
    json!({
        "schema_version": 2,
        "task_id": get(request, "task_id"),
        "attempt_id": get(request, "attempt_id"),
        "round_id": get(request, "round_id"),
        "round_index": get(request, "round_index"),
        "call_index": get(request, "call_index"),
        "call_id": get(request, "call_id"),
        "idempotency_key": get(request, "idempotency_key"),
    })
}

/// `DSHRuntimeChildOperationID`: a stable UUID derived from the parent
/// operation and a purpose, so a retried parent names the same child.
pub fn child_operation_id(operation_id: &Value, purpose: &str) -> Option<String> {
    let digest = hash_json(
        "agent-child-operation",
        &json!({ "operation_id": operation_id, "purpose": purpose }),
    )?;
    if digest.len() != 64 {
        return None;
    }
    let mut hex: Vec<u8> = digest.as_bytes()[..32].to_vec();
    hex[12] = b'4';
    let nibble = match hex[16] {
        digit @ b'0'..=b'9' => digit - b'0',
        letter => 10 + letter - b'a',
    };
    hex[16] = std::char::from_digit(u32::from((nibble & 0x3) | 0x8), 16)? as u8;
    let hex = String::from_utf8(hex).ok()?;
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// `DSHRuntimeSessionProof`: the committed session must still say what the
/// controller thinks it says. `facts` carries what the host read beside the
/// session bytes — the snapshot's generation and digest.
pub fn session_proof(
    session: &Value,
    facts: &Value,
    expectations: &Value,
) -> Result<Value, StoreError> {
    if get(session, "schema_version") != Some(&json!(9))
        || !get(session, "conversations").is_some_and(Value::is_array)
        || !get(session, "session_events").is_some_and(Value::is_array)
    {
        return Err(StoreError::Corrupt);
    }
    let conversation = array(get(session, "conversations"))
        .iter()
        .find(|candidate| get(candidate, "id") == get(expectations, "conversation_id"));
    let attempt = array(conversation.and_then(|c| get(c, "attempts")))
        .iter()
        .find(|candidate| get(candidate, "attempt_id") == get(expectations, "attempt_id"));
    let controller = attempt
        .and_then(|attempt| get(attempt, "agent"))
        .and_then(|agent| get(agent, "controller_generation"));
    let journal = attempt.and_then(|attempt| get(attempt, "journal_revision"));
    if attempt.and_then(|attempt| get(attempt, "turn_id")) != get(expectations, "task_id")
        || safe_integer(controller, MAX_SAFE_INTEGER, true).is_none()
        || safe_integer(journal, MAX_SAFE_INTEGER, true).is_none()
    {
        return Err(StoreError::Conflict);
    }
    let generation = get(facts, "session_generation");
    let digest = get(facts, "session_sha256");
    let matches = controller == get(expectations, "expected_controller_generation")
        && journal == get(expectations, "expected_journal_revision")
        && generation == get(expectations, "expected_session_generation")
        && digest == get(expectations, "expected_session_sha256");
    Ok(json!({
        "matches": matches,
        "controller_generation": controller,
        "journal_revision": journal,
        "session_generation": generation,
        "session_sha256": digest,
    }))
}

/// `readAgentRoundPresentations`' own request shape and ownership check.
pub fn presentations_request(request: &Value) -> Result<(), StoreError> {
    if exact_keys(
        Some(request),
        &["schema_version", "conversation_id", "attempt_id"],
    )
    .is_none()
        || get(request, "schema_version") != Some(&json!(1))
        || !canonical_uuid(get(request, "conversation_id"))
        || !canonical_uuid(get(request, "attempt_id"))
    {
        return Err(StoreError::InvalidArgument);
    }
    Ok(())
}

/// Whether the committed session still lists this attempt under this
/// conversation; a presentation read of an attempt the session does not own is
/// not found rather than empty.
pub fn session_owns_attempt(session: &Value, conversation_id: &Value, attempt_id: &Value) -> bool {
    array(get(session, "conversations"))
        .iter()
        .filter(|conversation| get(conversation, "id") == Some(conversation_id))
        .any(|conversation| {
            array(get(conversation, "attempts"))
                .iter()
                .any(|attempt| get(attempt, "attempt_id") == Some(attempt_id))
        })
}

/// `DSHRuntimeFindLedgerRow`.
fn find_ledger_row<'a>(state: &'a Value, locator: &Value) -> Option<&'a Value> {
    array(get(state, "ledger"))
        .iter()
        .find(|row| get(row, "locator") == Some(locator))
}

/// `DSHRuntimeFindAuthority`.
fn find_authority<'a>(
    state: &'a Value,
    task_id: Option<&Value>,
    attempt_id: Option<&Value>,
) -> Option<&'a Value> {
    array(get(state, "authorities"))
        .iter()
        .find(|row| get(row, "task_id") == task_id && get(row, "attempt_id") == attempt_id)
}

/// `DSHRuntimeReferenceForRow`: a settled row speaks through the transcript it
/// produced, an unsettled one through the transcript it was written against.
fn reference_for_row(row: &Value) -> Value {
    match get(row, "transcript_after") {
        Some(after) if !after.is_null() => after.clone(),
        _ => owned(get(row, "transcript_before")),
    }
}

/// `DSHRuntimeToolStatus`.
fn tool_status(row: &Value) -> Value {
    let state = get(row, "state");
    if !string_eq(state, "settled") {
        return owned(state);
    }
    match as_str(get(row, "receipt").and_then(|receipt| get(receipt, "outcome"))) {
        Some("ok") => json!("completed"),
        Some("denied") => json!("denied"),
        _ => json!("failed"),
    }
}

/// `DSHRuntimeToolProjection`.
pub fn tool_projection(row: &Value) -> Value {
    let locator = get(row, "locator");
    json!({
        "schema_version": 2,
        "task_id": at(locator, "task_id"),
        "attempt_id": at(locator, "attempt_id"),
        "round_id": at(locator, "round_id"),
        "round_index": at(locator, "round_index"),
        "call_index": at(locator, "call_index"),
        "call_id": at(locator, "call_id"),
        "name": get(row, "name"),
        "arguments_sha256": get(row, "arguments_sha256"),
        "idempotency_key": at(locator, "idempotency_key"),
        "execution_revision": get(row, "row_revision"),
        "status": tool_status(row),
        "transcript": reference_for_row(row),
        "receipt": get(row, "receipt"),
    })
}

fn execution_conflict(failure_code: &str, request: &Value, actual: Value) -> Value {
    json!({
        "schema_version": 2,
        "status": "conflict",
        "failure_code": failure_code,
        "expected_execution_revision": get(request, "expected_execution_revision"),
        "actual_execution_revision": actual,
    })
}

/// The conflict a tool query reports when the session no longer matches the
/// controller's checkpoint: the revision the ledger actually holds, or zero.
pub fn query_tool_session_conflict(state: &Value, request: &Value) -> Value {
    let locator = tool_locator(request);
    let actual = find_ledger_row(state, &locator)
        .and_then(|row| get(row, "row_revision"))
        .cloned()
        .unwrap_or(json!(0));
    execution_conflict("E_AGENT_CONFLICT", request, actual)
}

/// The conflict a tool query reports when the ledger itself refused: a root
/// that moved and a transcript that moved are named apart from a plain
/// revision conflict.
pub fn query_tool_ledger_conflict(state: &Value, request: &Value) -> Value {
    let locator = tool_locator(request);
    let row = find_ledger_row(state, &locator);
    let failure_code = match row {
        Some(row)
            if get(row, "root_fingerprint_sha256")
                != get(request, "expected_root_fingerprint_sha256")
                || get(row, "binding_revision")
                    != get(request, "expected_workspace_binding_revision") =>
        {
            "E_AGENT_ROOT_STALE"
        }
        Some(row) if get(row, "transcript_before") != get(request, "expected_transcript") => {
            "E_AGENT_TRANSCRIPT"
        }
        _ => "E_AGENT_CONFLICT",
    };
    let actual = row
        .and_then(|row| get(row, "row_revision"))
        .cloned()
        .unwrap_or(json!(0));
    execution_conflict(failure_code, request, actual)
}

/// The answer a tool query gives once the ledger has spoken.
pub fn query_tool_result(queried: &Value, request: &Value) -> Value {
    if string_eq(get(queried, "status"), "not_started") {
        if get(request, "expected_execution_revision") == Some(&json!(0)) {
            return queried.clone();
        }
        return execution_conflict("E_AGENT_CONFLICT", request, json!(0));
    }
    let row = get(queried, "row").unwrap_or(&Value::Null);
    if get(row, "row_revision") != get(request, "expected_execution_revision") {
        return execution_conflict("E_AGENT_CONFLICT", request, owned(get(row, "row_revision")));
    }
    let tool = tool_projection(row);
    json!({
        "schema_version": 2,
        "status": get(&tool, "status"),
        "tool": tool,
    })
}

fn attempt_conflict(failure_code: &str, request: &Value, proof: &Value) -> Value {
    json!({
        "schema_version": 2,
        "status": "conflict",
        "failure_code": failure_code,
        "expected_journal_revision": get(request, "expected_journal_revision"),
        "actual_journal_revision": get(proof, "journal_revision"),
        "expected_session_generation": get(request, "expected_session_generation"),
        "actual_session_generation": get(proof, "session_generation"),
    })
}

/// An attempt query pins the checkpoint twice: once through the controller's
/// own CAS and once through the request's expectations.
pub fn query_attempt_session_conflict(request: &Value, proof: &Value) -> Option<Value> {
    let request_matches = get(proof, "journal_revision")
        == get(request, "expected_journal_revision")
        && get(proof, "session_generation") == get(request, "expected_session_generation")
        && get(proof, "session_sha256") == get(request, "expected_session_sha256");
    if get(proof, "matches") == Some(&json!(true)) && request_matches {
        return None;
    }
    Some(attempt_conflict("E_AGENT_CONFLICT", request, proof))
}

/// The prepared authority the store handed back has to be the one the request
/// names, on the root and transcript the request expects.
pub fn query_attempt_base_conflict(base: &Value, request: &Value, proof: &Value) -> Option<Value> {
    let root = get(base, "root");
    if get(base, "conversation_id") == get(request, "conversation_id")
        && get(base, "transcript") == get(request, "expected_transcript")
        && at(root, "root_fingerprint_sha256") == get(request, "expected_root_fingerprint_sha256")
        && at(root, "workspace_binding_revision")
            == get(request, "expected_workspace_binding_revision")
    {
        return None;
    }
    Some(attempt_conflict("E_AGENT_ROOT_STALE", request, proof))
}

/// `DSHRuntimeLatestRound`.
fn latest_round<'a>(
    state: &'a Value,
    task_id: Option<&Value>,
    attempt_id: Option<&Value>,
) -> Option<&'a Value> {
    let mut latest: Option<&Value> = None;
    for row in array(get(state, "rounds")) {
        let locator = get(row, "locator");
        if at(locator, "task_id") != task_id || at(locator, "attempt_id") != attempt_id {
            continue;
        }
        let index = u64_of(at(locator, "round_index"));
        let better = latest.is_none_or(|latest| {
            index > u64_of(get(latest, "locator").and_then(|l| get(l, "round_index")))
        });
        if better {
            latest = Some(row);
        }
    }
    latest
}

/// `DSHRuntimeLatestBatch`: the highest round, and within it the highest
/// revision.
fn latest_batch<'a>(
    state: &'a Value,
    task_id: Option<&Value>,
    attempt_id: Option<&Value>,
) -> Option<&'a Value> {
    let mut latest: Option<&Value> = None;
    for row in array(get(state, "batches")) {
        if get(row, "task_id") != task_id || get(row, "attempt_id") != attempt_id {
            continue;
        }
        let better = latest.is_none_or(|latest| {
            u64_of(get(row, "round_index")) > u64_of(get(latest, "round_index"))
                || (get(row, "round_index") == get(latest, "round_index")
                    && u64_of(get(row, "batch_revision")) > u64_of(get(latest, "batch_revision")))
        });
        if better {
            latest = Some(row);
        }
    }
    latest
}

/// `DSHRuntimeLatestBatchCalls`: the prepare-time projection is the source of
/// safe summaries, previews and approval envelopes; the persisted bind
/// decisions and ledger settlements are merged onto it so a recovery after a
/// kill replays decisions and denial receipts instead of re-presenting calls
/// that are already settled.
pub fn latest_batch_calls(state: &Value, batch: &Value) -> Value {
    if batch.is_null() {
        return json!([]);
    }
    let snapshots = array(get(state, "operation_results"));
    let prepared = snapshots.iter().rev().find_map(|snapshot| {
        let wrapper = get(snapshot, "result");
        let receipt = at(wrapper, "result").and_then(|result| get(result, "receipt"));
        let bound = |key: &str| at(receipt, key) == get(batch, key);
        if string_eq(at(wrapper, "result_kind"), "prepare_agent_tool_batch")
            && bound("task_id")
            && bound("attempt_id")
            && bound("round_id")
            && bound("batch_revision")
        {
            at(receipt, "calls")
        } else {
            None
        }
    });
    let Some(prepared) = prepared else {
        return json!([]);
    };
    let mut merged = Vec::with_capacity(array(Some(prepared)).len());
    for projection in array(Some(prepared)) {
        let mut call = projection.as_object().cloned().unwrap_or_default();
        for snapshot in snapshots.iter().rev() {
            let wrapper = get(snapshot, "result");
            if !string_eq(at(wrapper, "result_kind"), "bind_agent_approval") {
                continue;
            }
            let result = at(wrapper, "result").and_then(|result| get(result, "result"));
            if !matches!(
                as_str(at(result, "status")),
                Some("bound" | "already_bound")
            ) {
                continue;
            }
            if at(result, "task_id") != get(batch, "task_id")
                || at(result, "attempt_id") != get(batch, "attempt_id")
                || at(result, "round_id") != get(batch, "round_id")
                || at(result, "call_index") != call.get("call_index")
                || at(result, "call_id") != call.get("call_id")
            {
                continue;
            }
            let decision = as_str(at(result, "decision")).unwrap_or_default();
            if matches!(decision, "denied" | "cancelled") {
                call.insert("approval_state".into(), json!(decision));
                call.insert("approval_token".into(), Value::Null);
                call.insert("approval_reference".into(), Value::Null);
            } else {
                call.insert("approval_state".into(), json!("bound"));
                call.insert(
                    "approval_reference".into(),
                    owned(at(result, "approval_reference")),
                );
            }
            if decision == "denied" && at(result, "receipt").is_some_and(Value::is_object) {
                call.insert("execution_status".into(), json!("denied"));
                call.insert("receipt".into(), owned(at(result, "receipt")));
            }
            break;
        }
        for row in array(get(state, "ledger")) {
            let locator = get(row, "locator");
            let bound = |key: &str| at(locator, key) == get(batch, key);
            let call_bound = |key: &str| at(locator, key) == call.get(key);
            if !bound("task_id")
                || !bound("attempt_id")
                || !bound("round_id")
                || !bound("round_index")
                || !call_bound("call_index")
                || !call_bound("call_id")
                || !call_bound("idempotency_key")
            {
                continue;
            }
            call.insert(
                "native_row_revision".into(),
                owned(get(row, "row_revision")),
            );
            if string_eq(get(row, "state"), "settled") {
                call.insert("execution_status".into(), tool_status(row));
                call.insert("receipt".into(), owned(get(row, "receipt")));
                call.insert("execution_revision".into(), owned(get(row, "row_revision")));
            }
            break;
        }
        merged.push(Value::Object(call));
    }
    Value::Array(merged)
}

/// The attempt an attempt query returns: the prepared authority, the
/// controller's own counters, and whatever the latest round and batch say
/// about the phase it is in.
pub fn query_attempt_projection(
    state: &Value,
    base: &Value,
    proof: &Value,
    request: &Value,
) -> Value {
    let task_id = get(request, "task_id");
    let attempt_id = get(request, "attempt_id");
    let mut attempt = base.as_object().cloned().unwrap_or_default();
    attempt.insert(
        "controller_generation".into(),
        owned(get(proof, "controller_generation")),
    );
    attempt.insert(
        "journal_revision".into(),
        owned(get(proof, "journal_revision")),
    );
    if let Some(round) = latest_round(state, task_id, attempt_id) {
        let locator = get(round, "locator");
        let state_name = as_str(get(round, "state")).unwrap_or_default();
        attempt.insert("round_id".into(), owned(at(locator, "round_id")));
        attempt.insert("round_index".into(), owned(at(locator, "round_index")));
        attempt.insert("round_revision".into(), owned(get(round, "row_revision")));
        attempt.insert(
            "round_status".into(),
            if state_name == "in_flight" {
                json!("active")
            } else {
                json!(state_name)
            },
        );
        match state_name {
            "in_flight" | "cancel_requested" => {
                attempt.insert("phase".into(), json!("round_in_flight"));
            }
            "cancelled" => {
                attempt.insert("phase".into(), json!("cancelled"));
            }
            "unknown" | "ambiguous" => {
                attempt.insert("phase".into(), json!(state_name));
            }
            _ => {}
        }
    }
    if let Some(batch) = latest_batch(state, task_id, attempt_id) {
        let calls = latest_batch_calls(state, batch);
        attempt.insert("batch_kind".into(), owned(get(batch, "kind")));
        attempt.insert("batch_revision".into(), owned(get(batch, "batch_revision")));
        attempt.insert(
            "manifest_sha256".into(),
            owned(get(batch, "manifest_sha256")),
        );
        // A batch whose every call already holds a receipt (executed, denied
        // or refused at preparation) is waiting for the next round; approval
        // checks only concern calls that are still unsettled.
        let calls_array = array(Some(&calls));
        let mut all_settled = !calls_array.is_empty();
        let mut pending_approval = false;
        for call in calls_array {
            let settled = get(call, "receipt").is_some_and(|receipt| !receipt.is_null());
            if !settled {
                all_settled = false;
                if string_eq(get(call, "approval_state"), "pending") {
                    pending_approval = true;
                }
            }
        }
        attempt.insert(
            "phase".into(),
            if all_settled {
                json!("tool_result_pending")
            } else if pending_approval {
                json!("approval_pending")
            } else {
                json!("batch_frozen")
            },
        );
        attempt.insert("batch".into(), calls);
    }
    let authority_state =
        find_authority(state, task_id, attempt_id).and_then(|row| get(row, "state"));
    let status = if matches!(
        as_str(authority_state),
        Some("terminal" | "cleanup_pending")
    ) {
        "terminal"
    } else {
        "active"
    };
    json!({ "schema_version": 2, "status": status, "attempt": Value::Object(attempt) })
}

/// `DSHRuntimeCleanupOutboxProof`: the committed session's cleanup outbox has
/// to hold exactly this cleanup, described exactly as the request describes it.
pub fn cleanup_outbox_proof(session: &Value, request: &Value) -> bool {
    let outbox = get(session, "agent_transcript_cleanup_outbox");
    if get(session, "schema_version") != Some(&json!(9)) || !outbox.is_some_and(Value::is_array) {
        return false;
    }
    let mut matched: Option<&Value> = None;
    for candidate in array(outbox) {
        if get(candidate, "cleanup_id") != get(request, "cleanup_id") {
            continue;
        }
        if matched.is_some() {
            return false;
        }
        matched = Some(candidate);
    }
    let keys = [
        "schema_version",
        "cleanup_id",
        "conversation_id",
        "task_id",
        "attempt_id",
        "transcript_ref",
        "transcript_sha256",
        "reason",
        "created_at",
    ];
    let bound = |key: &str| at(matched, key) == get(request, key);
    exact_keys(matched, &keys).is_some()
        && at(matched, "schema_version") == Some(&json!(1))
        && bound("conversation_id")
        && bound("task_id")
        && bound("attempt_id")
        && bound("transcript_ref")
        && bound("transcript_sha256")
        && matches!(
            as_str(at(matched, "reason")),
            Some("completed" | "cancelled" | "failed" | "conversation_deleted")
        )
        && canonical_timestamp(at(matched, "created_at"))
}

/// `DSHRuntimeCancelSourceProof`: a cancellation is only honoured when the
/// committed session holds exactly one matching cancel event, issued by the
/// completion controller for the phase the attempt is actually in.
pub fn cancel_source_proof(session: &Value, request: &Value) -> bool {
    let target = get(request, "target");
    let token = get(request, "cancel_token");
    let token_keys = [
        "schema_version",
        "issuer",
        "source_event_id",
        "token",
        "task_id",
        "attempt_id",
        "expected_phase",
        "reason_code",
    ];
    let token_shape = exact_keys(token, &token_keys).is_some()
        && at(token, "schema_version") == Some(&json!(2))
        && string_eq(at(token, "issuer"), "completion_controller")
        && canonical_uuid(at(token, "source_event_id"))
        && at(token, "token") == at(token, "source_event_id")
        && canonical_uuid(at(token, "task_id"))
        && canonical_uuid(at(token, "attempt_id"))
        && matches!(
            as_str(at(token, "expected_phase")),
            Some(
                "ready_for_round"
                    | "batch_frozen"
                    | "round_in_flight"
                    | "approval_pending"
                    | "execution_intent"
                    | "tool_result_pending"
            )
        )
        && matches!(
            as_str(at(token, "reason_code")),
            Some("E_AGENT_CANCELLED" | "E_AGENT_ROOT_STALE" | "E_AGENT_PERSISTENCE")
        )
        && at(token, "task_id") == at(target, "task_id")
        && at(token, "attempt_id") == at(target, "attempt_id");
    if get(session, "schema_version") != Some(&json!(9)) || !token_shape {
        return false;
    }
    let conversation_id = at(get(request, "controller_cas"), "conversation_id");
    let conversation = array(get(session, "conversations"))
        .iter()
        .find(|candidate| get(candidate, "id") == conversation_id);
    let attempt = array(conversation.and_then(|c| get(c, "attempts")))
        .iter()
        .find(|candidate| get(candidate, "attempt_id") == at(target, "attempt_id"));
    let agent = attempt.and_then(|attempt| get(attempt, "agent"));
    if attempt.and_then(|attempt| get(attempt, "turn_id")) != at(target, "task_id")
        || at(agent, "phase") != at(token, "expected_phase")
    {
        return false;
    }
    let mut matched: Option<&Value> = None;
    for event in array(get(session, "session_events")) {
        if get(event, "event_id") != at(token, "source_event_id") {
            continue;
        }
        if matched.is_some() {
            return false;
        }
        matched = Some(event);
    }
    let event_keys = [
        "schema_version",
        "event_id",
        "attempt_id",
        "seq",
        "kind",
        "round_index",
        "call_id",
        "status",
        "safe_summary_key",
        "arguments_sha256",
        "result_sha256",
        "approval_reference",
        "failure_code",
        "created_at",
    ];
    let event_shape = exact_keys(matched, &event_keys).is_some()
        && at(matched, "schema_version") == Some(&json!(2))
        && string_eq(at(matched, "kind"), "cancel")
        && canonical_uuid(at(matched, "event_id"))
        && canonical_uuid(at(matched, "attempt_id"))
        && safe_integer(at(matched, "seq"), MAX_SAFE_INTEGER, true).is_some()
        && is_null(at(matched, "safe_summary_key"))
        && is_null(at(matched, "result_sha256"))
        && at(matched, "approval_reference") == at(matched, "event_id")
        && canonical_timestamp(at(matched, "created_at"));
    let common = event_shape
        && at(matched, "attempt_id") == at(target, "attempt_id")
        && string_eq(at(matched, "status"), "cancelled")
        && at(matched, "failure_code") == at(token, "reason_code");
    let target_matches = match as_str(at(target, "kind")) {
        Some("attempt") => {
            is_null(at(matched, "round_index"))
                && is_null(at(matched, "call_id"))
                && is_null(at(matched, "arguments_sha256"))
        }
        Some("round") => {
            at(matched, "round_index") == at(target, "round_index")
                && is_null(at(matched, "call_id"))
                && is_null(at(matched, "arguments_sha256"))
        }
        Some("tool") => {
            let mut journal_call: Option<&Value> = None;
            for candidate in array(at(agent, "batch")) {
                if get(candidate, "call_id") != at(target, "call_id")
                    || get(candidate, "call_index") != at(target, "call_index")
                {
                    continue;
                }
                if journal_call.is_some() {
                    return false;
                }
                journal_call = Some(candidate);
            }
            at(matched, "round_index") == at(target, "round_index")
                && at(matched, "call_id") == at(target, "call_id")
                && canonical_sha256(at(matched, "arguments_sha256"))
                && at(agent, "round_index") == at(target, "round_index")
                && at(journal_call, "arguments_sha256") == at(matched, "arguments_sha256")
        }
        _ => false,
    };
    common && target_matches
}

/// `rish_agent_runtime_reduce`.
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
    let request = get(&envelope, "request").unwrap_or(&Value::Null);
    let state = get(&envelope, "state").unwrap_or(&Value::Null);
    let session = get(&envelope, "session").unwrap_or(&Value::Null);
    let mut reply = Map::new();
    match op {
        "query_tool_request" => {
            request_shape("query_tool", request)?;
            reply.insert("locator".into(), tool_locator(request));
        }
        "query_attempt_request" => request_shape("query_attempt", request)?,
        "presentations_request" => presentations_request(request)?,
        "session_proof" => {
            let facts = get(&envelope, "facts").unwrap_or(&Value::Null);
            reply.insert("proof".into(), session_proof(session, facts, request)?);
        }
        "session_owns_attempt" => {
            reply.insert(
                "owns".into(),
                json!(session_owns_attempt(
                    session,
                    get(request, "conversation_id").unwrap_or(&Value::Null),
                    get(request, "attempt_id").unwrap_or(&Value::Null)
                )),
            );
        }
        "query_tool_session_conflict" => {
            reply.insert("output".into(), query_tool_session_conflict(state, request));
        }
        "query_tool_ledger_conflict" => {
            reply.insert("output".into(), query_tool_ledger_conflict(state, request));
        }
        "query_tool_result" => {
            let queried = get(&envelope, "queried").ok_or(StoreError::InvalidArgument)?;
            reply.insert("output".into(), query_tool_result(queried, request));
        }
        "query_attempt_session_conflict" => {
            let proof = get(&envelope, "proof").ok_or(StoreError::InvalidArgument)?;
            reply.insert(
                "output".into(),
                owned(query_attempt_session_conflict(request, proof).as_ref()),
            );
        }
        "query_attempt_base_conflict" => {
            let proof = get(&envelope, "proof").ok_or(StoreError::InvalidArgument)?;
            let base = get(&envelope, "base").ok_or(StoreError::InvalidArgument)?;
            reply.insert(
                "output".into(),
                owned(query_attempt_base_conflict(base, request, proof).as_ref()),
            );
        }
        "query_attempt_projection" => {
            let proof = get(&envelope, "proof").ok_or(StoreError::InvalidArgument)?;
            let base = get(&envelope, "base").ok_or(StoreError::InvalidArgument)?;
            reply.insert(
                "output".into(),
                query_attempt_projection(state, base, proof, request),
            );
        }
        "tool_projection" => {
            let row = get(&envelope, "row").ok_or(StoreError::InvalidArgument)?;
            reply.insert("tool".into(), tool_projection(row));
        }
        "latest_batch_calls" => {
            let batch = get(&envelope, "batch").unwrap_or(&Value::Null);
            reply.insert("calls".into(), latest_batch_calls(state, batch));
        }
        "cleanup_outbox_proof" => {
            reply.insert(
                "proves".into(),
                json!(cleanup_outbox_proof(session, request)),
            );
        }
        "cancel_source_proof" => {
            reply.insert(
                "proves".into(),
                json!(cancel_source_proof(session, request)),
            );
        }
        "child_operation_id" => {
            let purpose = as_str(get(&envelope, "purpose")).ok_or(StoreError::InvalidArgument)?;
            let operation_id = get(request, "operation_id").ok_or(StoreError::InvalidArgument)?;
            let child =
                child_operation_id(operation_id, purpose).ok_or(StoreError::InvalidArgument)?;
            reply.insert("operation_id".into(), json!(child));
        }
        _ => return Err(StoreError::InvalidArgument),
    }
    Ok(Value::Object(reply))
}
