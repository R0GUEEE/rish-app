//! The WAL's stored row shapes, ported from `AgentNativeWAL.mm`. These are
//! the load-time re-validation of `agent-native-wal-v1.json`: every row the
//! store keeps must still hold its shape after a restart, an upgrade, or a
//! partially written file. This first cut covers the bookkeeping rows —
//! transcript references and messages, reservations, cleanup, dispatch
//! markers, the attempt authority, and the operation relation with its
//! result snapshots. The file, the locks and the transaction stay native.

use crate::canonical::{canonical_json, hash_json};
use crate::execution_ledger::{as_str, feedback_string_valid, get, write_prior};
use crate::schema::{
    bounded_utf8, canonical_sha256, canonical_timestamp, canonical_uuid, exact_keys,
    opaque_identifier, root_full, safe_integer, MAX_TRANSCRIPT_BYTES,
};
use crate::session_schema::Env;
use serde_json::{json, Value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// `DSHAgentNativeWALMaxSingleWriteBytes`.
pub const MAX_SINGLE_WRITE_BYTES: u64 = 32 * 1024;
/// `DSHAgentNativeWALMaxBatchWriteBytes`.
pub const MAX_BATCH_WRITE_BYTES: u64 = 512 * 1024;
/// `DSHAgentNativeWALMaxAttemptWriteBytes`.
pub const MAX_ATTEMPT_WRITE_BYTES: u64 = 4 * 1024 * 1024;
/// `DSHAgentNativeWALMaxOperationResultBytes`.
pub const MAX_OPERATION_RESULT_BYTES: u64 = 768 * 1024;

fn equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    matches!((left, right), (Some(l), Some(r)) if l == r)
}

fn string_eq(value: Option<&Value>, expected: &str) -> bool {
    as_str(value) == Some(expected)
}

fn is_null(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null))
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn is_boolean(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(_)))
}

fn u64_of(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// `DSHAgentSafeInteger(value, 1, NO)` plus an exact comparison: the row's
/// own schema tag.
fn schema(value: Option<&Value>, expected: u64) -> bool {
    safe_integer(value, expected, false) == Some(expected)
}

/// `DSHAgentWALReferenceShape`.
pub fn reference_shape(value: Option<&Value>) -> bool {
    let Some(reference) = exact_keys(
        value,
        &[
            "schema_version",
            "transcript_ref",
            "generation",
            "transcript_sha256",
            "transcript_bytes",
        ],
    ) else {
        return false;
    };
    schema(reference.get("schema_version"), 1)
        && canonical_uuid(reference.get("transcript_ref"))
        && safe_integer(reference.get("generation"), MAX_SAFE_INTEGER, true).is_some()
        && canonical_sha256(reference.get("transcript_sha256"))
        && safe_integer(
            reference.get("transcript_bytes"),
            MAX_TRANSCRIPT_BYTES,
            true,
        )
        .is_some()
}

/// `DSHAgentWALCanonicalFeedbackString`: the stored tool content must be the
/// canonical encoding of itself.
fn canonical_feedback_string(value: Option<&Value>) -> bool {
    let Some(text) = as_str(value) else {
        return false;
    };
    if text.len() as u64 > MAX_TRANSCRIPT_BYTES {
        return false;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    matches!(canonical_json(&parsed), Ok(bytes) if bytes == text.as_bytes())
}

/// `DSHAgentWALOpaqueCallID`: 1..=128 bytes of `[A-Za-z0-9._:-]`.
pub fn opaque_call_id(value: Option<&Value>) -> bool {
    opaque_identifier(value)
}

fn tool_name_charset(value: Option<&Value>) -> bool {
    match bounded_utf8(value, 64, false) {
        Some(text) => text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')),
        None => false,
    }
}

/// `DSHAgentWALMessageShape`: one stored transcript message.
pub fn message_shape(message: &Value) -> bool {
    if !message.is_object()
        || !schema(get(message, "schema_version"), 1)
        || safe_integer(get(message, "round_index"), 7, true).is_none()
        || !get(message, "role").is_some_and(Value::is_string)
    {
        return false;
    }
    match as_str(get(message, "role")) {
        Some("assistant") => {
            let calls = array(get(message, "tool_calls"));
            if exact_keys(
                Some(message),
                &[
                    "schema_version",
                    "role",
                    "round_index",
                    "content",
                    "reasoning_content",
                    "tool_calls",
                ],
            )
            .is_none()
                || bounded_utf8(get(message, "content"), MAX_TRANSCRIPT_BYTES as usize, true)
                    .is_none()
                || bounded_utf8(
                    get(message, "reasoning_content"),
                    MAX_TRANSCRIPT_BYTES as usize,
                    true,
                )
                .is_none()
                || !get(message, "tool_calls").is_some_and(Value::is_array)
                || calls.len() > 16
            {
                return false;
            }
            calls.iter().all(|call| {
                exact_keys(
                    Some(call),
                    &["schema_version", "call_id", "name", "arguments_json"],
                )
                .is_some()
                    && schema(get(call, "schema_version"), 1)
                    && opaque_call_id(get(call, "call_id"))
                    && tool_name_charset(get(call, "name"))
                    && as_str(get(call, "arguments_json"))
                        .and_then(crate::strict_json::parse_arguments)
                        .is_some()
            })
        }
        Some("tool") => {
            exact_keys(
                Some(message),
                &[
                    "schema_version",
                    "role",
                    "round_index",
                    "call_id",
                    "content",
                    "truncated",
                ],
            )
            .is_some()
                && opaque_call_id(get(message, "call_id"))
                && bounded_utf8(get(message, "content"), MAX_TRANSCRIPT_BYTES as usize, true)
                    .is_some()
                && canonical_feedback_string(get(message, "content"))
                && as_str(get(message, "content"))
                    .is_some_and(|text| feedback_string_valid(text).is_ok())
                && is_boolean(get(message, "truncated"))
        }
        _ => false,
    }
}

/// `DSHAgentWALReservationShape`: the write reservation and its key ledger.
pub fn reservation_shape(reservation: &Value) -> bool {
    let keys = [
        "schema_version",
        "task_id",
        "attempt_id",
        "root_fingerprint_sha256",
        "binding_revision",
        "policy",
        "reserved_write_bytes",
        "reservation_version",
        "keys",
    ];
    let r = |key: &str| get(reservation, key);
    if exact_keys(Some(reservation), &keys).is_none()
        || !schema(r("schema_version"), 1)
        || !canonical_uuid(r("task_id"))
        || !canonical_uuid(r("attempt_id"))
        || !canonical_sha256(r("root_fingerprint_sha256"))
        || safe_integer(r("binding_revision"), MAX_SAFE_INTEGER, false).is_none()
        || !r("policy").is_some_and(Value::is_object)
        || safe_integer(r("reserved_write_bytes"), MAX_ATTEMPT_WRITE_BYTES, true).is_none()
        || safe_integer(r("reservation_version"), MAX_SAFE_INTEGER, true).is_none()
        || !r("keys").is_some_and(Value::is_array)
        || array(r("keys")).len() > 128
    {
        return false;
    }
    // The reservation carries its own policy copy; it is bounded like the
    // authority's but only requires a non-empty version string.
    let policy = r("policy").expect("checked");
    let p = |key: &str| get(policy, key);
    if exact_keys(
        Some(policy),
        &[
            "schema_version",
            "policy_version",
            "max_single_write_bytes",
            "max_batch_write_bytes",
            "max_attempt_write_bytes",
        ],
    )
    .is_none()
        || !schema(p("schema_version"), 1)
        || bounded_utf8(p("policy_version"), 128, false).is_none()
        || safe_integer(p("max_single_write_bytes"), MAX_SINGLE_WRITE_BYTES, false)
            != Some(MAX_SINGLE_WRITE_BYTES)
        || safe_integer(p("max_batch_write_bytes"), MAX_BATCH_WRITE_BYTES, false).is_none()
        || u64_of(p("max_batch_write_bytes")) < MAX_SINGLE_WRITE_BYTES
        || safe_integer(p("max_attempt_write_bytes"), MAX_ATTEMPT_WRITE_BYTES, false).is_none()
        || u64_of(p("max_attempt_write_bytes")) < u64_of(p("max_batch_write_bytes"))
    {
        return false;
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut active_bytes: u64 = 0;
    for key in array(r("keys")) {
        let k = |name: &str| get(key, name);
        let idempotency = as_str(k("idempotency_key")).unwrap_or_default();
        if exact_keys(
            Some(key),
            &[
                "idempotency_key",
                "relative_path_sha256",
                "content_sha256",
                "content_bytes",
                "state",
            ],
        )
        .is_none()
            || !canonical_sha256(k("idempotency_key"))
            || !canonical_sha256(k("relative_path_sha256"))
            || !canonical_sha256(k("content_sha256"))
            || safe_integer(k("content_bytes"), MAX_SINGLE_WRITE_BYTES, true).is_none()
            || !matches!(as_str(k("state")), Some("active" | "released"))
            || seen.contains(&idempotency)
        {
            return false;
        }
        seen.push(idempotency);
        if string_eq(k("state"), "active") {
            let bytes = u64_of(k("content_bytes"));
            if active_bytes > MAX_ATTEMPT_WRITE_BYTES - bytes {
                return false;
            }
            active_bytes += bytes;
        }
    }
    active_bytes == u64_of(r("reserved_write_bytes"))
}

/// `DSHAgentWALCleanupShape`.
pub fn cleanup_shape(cleanup: &Value) -> bool {
    let keys = [
        "schema_version",
        "cleanup_id",
        "attempt_id",
        "transcript_ref",
        "transcript_sha256",
        "cleanup_owner",
        "reason",
        "created_at",
        "status",
    ];
    let c = |key: &str| get(cleanup, key);
    exact_keys(Some(cleanup), &keys).is_some()
        && schema(c("schema_version"), 1)
        && canonical_uuid(c("cleanup_id"))
        && canonical_uuid(c("attempt_id"))
        && canonical_uuid(c("transcript_ref"))
        && canonical_sha256(c("transcript_sha256"))
        && canonical_uuid(c("cleanup_owner"))
        && canonical_timestamp(c("created_at"))
        && matches!(
            as_str(c("reason")),
            Some("completed" | "cancelled" | "failed" | "conversation_deleted")
        )
        && matches!(as_str(c("status")), Some("pending" | "discarded"))
}

/// `DSHAgentWALDispatchShape`: the round or execution dispatch marker.
pub fn dispatch_shape(dispatch: &Value) -> bool {
    let d = |key: &str| get(dispatch, key);
    if exact_keys(
        Some(dispatch),
        &["schema_version", "kind", "locator", "dispatch_state"],
    )
    .is_none()
        || !schema(d("schema_version"), 1)
        || !matches!(as_str(d("kind")), Some("round" | "execution"))
        || !d("locator").is_some_and(Value::is_object)
        || !matches!(
            as_str(d("dispatch_state")),
            Some("not_dispatched" | "dispatched")
        )
    {
        return false;
    }
    let locator = d("locator").expect("checked");
    let l = |key: &str| get(locator, key);
    if string_eq(d("kind"), "round") {
        return exact_keys(
            Some(locator),
            &[
                "schema_version",
                "task_id",
                "attempt_id",
                "round_id",
                "round_index",
            ],
        )
        .is_some()
            && l("schema_version") == Some(&json!(1))
            && canonical_uuid(l("task_id"))
            && canonical_uuid(l("attempt_id"))
            && canonical_uuid(l("round_id"))
            && safe_integer(l("round_index"), 7, true).is_some();
    }
    let keys = [
        "schema_version",
        "task_id",
        "attempt_id",
        "round_id",
        "round_index",
        "call_index",
        "call_id",
        "idempotency_key",
    ];
    exact_keys(Some(locator), &keys).is_some()
        && l("schema_version") == Some(&json!(2))
        && canonical_uuid(l("task_id"))
        && canonical_uuid(l("attempt_id"))
        && canonical_uuid(l("round_id"))
        && safe_integer(l("round_index"), 7, true).is_some()
        && safe_integer(l("call_index"), 15, true).is_some()
        && bounded_utf8(l("call_id"), 128, false).is_some()
        && canonical_sha256(l("idempotency_key"))
}

/// `DSHAgentWALWritePriorShape`.
pub fn write_prior_shape(prior: Option<&Value>) -> bool {
    write_prior(prior)
}

/// `DSHAgentWALPolicyShape`: the authority's frozen policy.
pub fn policy_shape(policy: Option<&Value>) -> bool {
    let p = |key: &str| policy.and_then(|p| get(p, key));
    exact_keys(
        policy,
        &[
            "schema_version",
            "policy_version",
            "max_single_write_bytes",
            "max_batch_write_bytes",
            "max_attempt_write_bytes",
        ],
    )
    .is_some()
        && p("schema_version") == Some(&json!(1))
        && string_eq(p("policy_version"), "agent-v1")
        && p("max_single_write_bytes") == Some(&json!(MAX_SINGLE_WRITE_BYTES))
        && safe_integer(p("max_batch_write_bytes"), MAX_BATCH_WRITE_BYTES, false).is_some()
        && u64_of(p("max_batch_write_bytes")) >= MAX_SINGLE_WRITE_BYTES
        && safe_integer(p("max_attempt_write_bytes"), MAX_ATTEMPT_WRITE_BYTES, false).is_some()
        && u64_of(p("max_attempt_write_bytes")) >= u64_of(p("max_batch_write_bytes"))
}

/// `DSHAgentWALRegistryShape`: the frozen tool registry, names in ascending
/// literal order.
pub fn registry_shape(registry: Option<&Value>) -> bool {
    let r = |key: &str| registry.and_then(|r| get(r, key));
    if exact_keys(
        registry,
        &[
            "schema_version",
            "registry_version",
            "toolset_sha256",
            "tools",
        ],
    )
    .is_none()
        || r("schema_version") != Some(&json!(2))
        || !(r("registry_version") == Some(&json!(1)) || r("registry_version") == Some(&json!(2)))
        || !canonical_sha256(r("toolset_sha256"))
        || !r("tools").is_some_and(Value::is_array)
        || array(r("tools")).len() > 8
    {
        return false;
    }
    const NAMES: &[&str] = &[
        "list_dir",
        "read_file",
        "write_file",
        "git_status",
        "git_commit",
        "git_push",
        "start_guest_cgi",
        "stop_guest_cgi",
    ];
    let mut seen: Vec<&str> = Vec::new();
    let mut previous: Option<&str> = None;
    for tool in array(r("tools")) {
        let name = as_str(get(tool, "name")).unwrap_or_default();
        if exact_keys(
            Some(tool),
            &["schema_version", "name", "safe_summary_key", "access"],
        )
        .is_none()
            || get(tool, "schema_version") != Some(&json!(2))
            || !NAMES.contains(&name)
            || seen.contains(&name)
            || bounded_utf8(get(tool, "safe_summary_key"), 128, false).is_none()
            || !matches!(
                as_str(get(tool, "access")),
                Some("auto" | "conversation_confirm" | "confirm_once" | "durable_deny")
            )
            || previous.is_some_and(|previous| previous >= name)
        {
            return false;
        }
        previous = Some(name);
        seen.push(name);
    }
    true
}

/// `DSHAgentWALAuthorityShape`: the attempt authority, including the exact
/// tool set its root capabilities imply.
pub fn authority_shape(authority: &Value, env: &Env) -> bool {
    let keys = [
        "schema_version",
        "task_id",
        "conversation_id",
        "attempt_id",
        "root",
        "policy",
        "registry",
        "transport_schema_version",
        "model",
        "thinking_mode",
        "visible_message_ids",
        "visible_history_sha256",
        "visible_message_count",
        "project_context_sha256",
        "transcript",
        "reserved_write_bytes",
        "authority_revision",
        "state",
        "cleanup_id",
        "created_at",
        "updated_at",
    ];
    let a = |key: &str| get(authority, key);
    let visible = array(a("visible_message_ids"));
    if exact_keys(Some(authority), &keys).is_none()
        || a("schema_version") != Some(&json!(2))
        || !canonical_uuid(a("task_id"))
        || !canonical_uuid(a("conversation_id"))
        || !canonical_uuid(a("attempt_id"))
        || !root_full(a("root"))
        || !policy_shape(a("policy"))
        || !registry_shape(a("registry"))
        || !(a("transport_schema_version") == Some(&json!(2))
            || a("transport_schema_version") == Some(&json!(3)))
        || bounded_utf8(a("model"), 128, false).is_none()
        || bounded_utf8(a("thinking_mode"), 32, false).is_none()
        || !a("visible_message_ids").is_some_and(Value::is_array)
        || visible.len() > 96
        || !canonical_sha256(a("visible_history_sha256"))
        || safe_integer(a("visible_message_count"), 96, true).is_none()
        || visible.len() as u64 != u64_of(a("visible_message_count"))
        || !(is_null(a("project_context_sha256")) || canonical_sha256(a("project_context_sha256")))
        || !reference_shape(a("transcript"))
        || safe_integer(a("reserved_write_bytes"), MAX_ATTEMPT_WRITE_BYTES, true).is_none()
        || safe_integer(a("authority_revision"), MAX_SAFE_INTEGER, false).is_none()
        || !canonical_timestamp(a("created_at"))
        || !canonical_timestamp(a("updated_at"))
        || !env.supported_model(a("model"))
        || !matches!(as_str(a("thinking_mode")), Some("off" | "high" | "max"))
    {
        return false;
    }
    let root = a("root").expect("checked");
    let capabilities: Vec<&str> = array(get(root, "capabilities"))
        .iter()
        .filter_map(|c| as_str(Some(c)))
        .collect();
    let has = |name: &str| capabilities.contains(&name);
    let project = string_eq(get(root, "kind"), "project");
    let mut expected: Vec<(&str, &str)> = Vec::new();
    if has("file_read") {
        expected.push(("list_dir", "auto"));
        expected.push(("read_file", "auto"));
    }
    if has("file_write") {
        expected.push(("write_file", "conversation_confirm"));
    }
    if project && has("git_status") {
        expected.push(("git_status", "auto"));
    }
    if project && has("git_commit") {
        expected.push(("git_commit", "conversation_confirm"));
    }
    if project && has("git_push") {
        // git_push follows the git_commit pattern (see AgentToolRegistry).
        expected.push(("git_push", "conversation_confirm"));
    }
    if has("guest_service") {
        if get(a("registry").expect("checked"), "registry_version") != Some(&json!(2)) {
            return false;
        }
        expected.push(("start_guest_cgi", "conversation_confirm"));
        expected.push(("stop_guest_cgi", "conversation_confirm"));
    }
    let tools = array(get(a("registry").expect("checked"), "tools"));
    if expected.len() != tools.len() {
        return false;
    }
    for tool in tools {
        let name = as_str(get(tool, "name")).unwrap_or_default();
        let access = as_str(get(tool, "access")).unwrap_or_default();
        if expected.iter().any(|(n, a)| *n == name && *a == access) {
            continue;
        }
        // Authorities prepared by builds that registered git_push as once-only
        // stay readable; the pulled device evidence fixtures carry that shape.
        if name == "git_push" && access == "confirm_once" {
            continue;
        }
        return false;
    }
    if a("transport_schema_version") == Some(&json!(3)) {
        if !project
            || is_null(get(root, "project_id"))
            || !canonical_sha256(a("project_context_sha256"))
        {
            return false;
        }
    } else if !is_null(a("project_context_sha256")) {
        return false;
    }
    let mut ids: Vec<&str> = Vec::new();
    for id in visible {
        let text = as_str(Some(id)).unwrap_or_default();
        if !canonical_uuid(Some(id)) || ids.contains(&text) {
            return false;
        }
        ids.push(text);
    }
    match as_str(a("state")) {
        Some("prepared" | "terminal") if is_null(a("cleanup_id")) => true,
        Some("cleanup_pending") => canonical_uuid(a("cleanup_id")),
        _ => false,
    }
}

// MARK: - operations

/// `DSHAgentWALOperationKinds`.
pub const OPERATION_KINDS: &[&str] = &[
    "prepare_agent_attempt",
    "complete_agent_round_v2",
    "prepare_agent_tool_batch",
    "bind_agent_approval",
    "execute_agent_tool",
    "cancel_agent_attempt",
    "recover_agent_attempt",
    "finalize_agent_attempt",
    "discard_agent_attempt",
    "interrupt_agent_attempt",
];

/// `DSHAgentWALOperationResultStatuses`.
const RESULT_STATUSES: &[&str] = &[
    "prepared",
    "already_prepared",
    "not_agent",
    "completed",
    "in_flight",
    "failed_retryable",
    "failed",
    "cancel_requested",
    "cancelled",
    "unknown",
    "ambiguous",
    "rejected",
    "bound",
    "already_bound",
    "running",
    "denied",
    "retryable",
    "resumed",
    "manual_reconciliation",
    "terminal",
    "discarded",
    "already_missing",
    "pending",
    "conflict",
];

/// `DSHAgentWALOperationResultStatusAllowed`: two statuses belong to exactly
/// one operation kind.
pub fn result_status_allowed(operation_kind: Option<&str>, status: Option<&str>) -> bool {
    match status {
        Some("settled") => operation_kind == Some("cancel_agent_attempt"),
        Some("already_terminal") => operation_kind == Some("finalize_agent_attempt"),
        Some(status) => RESULT_STATUSES.contains(&status),
        None => false,
    }
}

/// `DSHAgentWALResultReferenceShape`: what an operation's result points at.
pub fn result_reference_shape(reference: Option<&Value>) -> bool {
    let Some(reference) = reference.filter(|r| r.is_object()) else {
        return false;
    };
    let r = |key: &str| get(reference, key);
    if r("schema_version") != Some(&json!(2)) || !r("kind").is_some_and(Value::is_string) {
        return false;
    }
    let kind = as_str(r("kind")).unwrap_or_default();
    if kind == "none" {
        return exact_keys(Some(reference), &["schema_version", "kind"]).is_some();
    }
    if kind == "cleanup" {
        return exact_keys(Some(reference), &["schema_version", "kind", "cleanup_id"]).is_some()
            && canonical_uuid(r("cleanup_id"));
    }
    let mut keys = vec!["schema_version", "kind", "task_id", "attempt_id"];
    if !canonical_uuid(r("task_id")) || !canonical_uuid(r("attempt_id")) {
        return false;
    }
    if kind == "authority" {
        keys.push("authority_revision");
        return exact_keys(Some(reference), &keys).is_some()
            && safe_integer(r("authority_revision"), MAX_SAFE_INTEGER, false).is_some();
    }
    keys.push("round_id");
    keys.push("round_index");
    if !canonical_uuid(r("round_id")) || safe_integer(r("round_index"), 7, true).is_none() {
        return false;
    }
    if kind == "round" || kind == "batch" {
        let revision = if kind == "round" {
            "round_revision"
        } else {
            "batch_revision"
        };
        keys.push(revision);
        return exact_keys(Some(reference), &keys).is_some()
            && safe_integer(r(revision), MAX_SAFE_INTEGER, false).is_some();
    }
    if !matches!(kind, "approval" | "tool" | "denied_call") {
        return false;
    }
    keys.push("call_index");
    keys.push("call_id");
    if safe_integer(r("call_index"), 15, true).is_none() || !opaque_call_id(r("call_id")) {
        return false;
    }
    let revision = match kind {
        "approval" => "batch_revision",
        "tool" => "execution_revision",
        _ => "native_row_revision",
    };
    keys.push(revision);
    exact_keys(Some(reference), &keys).is_some()
        && safe_integer(r(revision), MAX_SAFE_INTEGER, false).is_some()
}

/// `DSHAgentWALSnapshotReferenceShape`.
pub fn snapshot_reference_shape(reference: Option<&Value>) -> bool {
    let r = |key: &str| reference.and_then(|r| get(r, key));
    exact_keys(
        reference,
        &[
            "schema_version",
            "operation_id",
            "result_sha256",
            "result_bytes",
        ],
    )
    .is_some()
        && r("schema_version") == Some(&json!(2))
        && canonical_uuid(r("operation_id"))
        && canonical_sha256(r("result_sha256"))
        && safe_integer(r("result_bytes"), MAX_OPERATION_RESULT_BYTES, false).is_some()
}

/// `DSHAgentWALContainsForbiddenSafeKey`: a published result must never
/// carry raw arguments, content, paths or native envelopes.
pub fn contains_forbidden_safe_key(value: &Value) -> bool {
    const FORBIDDEN: &[&str] = &[
        "arguments",
        "content",
        "path",
        "raw_arguments",
        "raw_result",
        "tool_feedback",
        "messages",
        "native_envelope",
        "precondition",
        "settled_facts",
        "patch",
        "owner",
        "arguments_json",
    ];
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| {
            FORBIDDEN.contains(&key.as_str()) || contains_forbidden_safe_key(child)
        }),
        Value::Array(items) => items.iter().any(contains_forbidden_safe_key),
        _ => false,
    }
}

/// `DSHAgentWALSafeResultShape`.
pub fn safe_result_shape(
    safe_result: Option<&Value>,
    operation_kind: Option<&Value>,
    operation_id: Option<&Value>,
    result_status: Option<&Value>,
) -> bool {
    let Some(safe_result) = safe_result.filter(|s| s.is_object()) else {
        return false;
    };
    if exact_keys(
        Some(safe_result),
        &["schema_version", "result_kind", "result"],
    )
    .is_none()
        || get(safe_result, "schema_version") != Some(&json!(2))
        || !equal(get(safe_result, "result_kind"), operation_kind)
        || !get(safe_result, "result").is_some_and(Value::is_object)
        || contains_forbidden_safe_key(safe_result)
    {
        return false;
    }
    let result = get(safe_result, "result").expect("checked");
    get(result, "schema_version") == Some(&json!(2))
        && equal(get(result, "operation_id"), operation_id)
        && equal(get(result, "status"), result_status)
        && canonical_uuid(get(result, "operation_id"))
}

/// `DSHAgentWALOperationShape`: the operation relation row and the state
/// machine its result reference must agree with.
pub fn operation_shape(operation: &Value) -> bool {
    let keys = [
        "schema_version",
        "operation_id",
        "operation_kind",
        "request_sha256",
        "task_id",
        "attempt_id",
        "result_ref",
        "state",
        "result_status",
        "result_revision",
        "result_snapshot_ref",
        "authority_revision",
        "created_at",
        "updated_at",
    ];
    let o = |key: &str| get(operation, key);
    if exact_keys(Some(operation), &keys).is_none()
        || o("schema_version") != Some(&json!(2))
        || !canonical_uuid(o("operation_id"))
        || !as_str(o("operation_kind")).is_some_and(|kind| OPERATION_KINDS.contains(&kind))
        || !canonical_sha256(o("request_sha256"))
        || !canonical_uuid(o("task_id"))
        || !canonical_uuid(o("attempt_id"))
        || !result_reference_shape(o("result_ref"))
        || !result_status_allowed(as_str(o("operation_kind")), as_str(o("result_status")))
        || !(is_null(o("result_revision"))
            || safe_integer(o("result_revision"), MAX_SAFE_INTEGER, false).is_some())
        || !(is_null(o("result_snapshot_ref"))
            || snapshot_reference_shape(o("result_snapshot_ref")))
        || safe_integer(o("authority_revision"), MAX_SAFE_INTEGER, true).is_none()
        || !canonical_timestamp(o("created_at"))
        || !canonical_timestamp(o("updated_at"))
    {
        return false;
    }
    let result_ref = o("result_ref").expect("checked");
    if get(result_ref, "task_id").is_some()
        && (!equal(get(result_ref, "task_id"), o("task_id"))
            || !equal(get(result_ref, "attempt_id"), o("attempt_id")))
    {
        return false;
    }
    if !is_null(o("result_snapshot_ref"))
        && !equal(
            o("result_snapshot_ref").and_then(|s| get(s, "operation_id")),
            o("operation_id"),
        )
    {
        return false;
    }
    let none = string_eq(get(result_ref, "kind"), "none");
    let null_revision = is_null(o("result_revision"));
    let null_snapshot = is_null(o("result_snapshot_ref"));
    match as_str(o("state")) {
        Some("started") => {
            none && null_revision && null_snapshot && string_eq(o("result_status"), "pending")
        }
        Some("committed") => !none && !null_revision && !null_snapshot,
        Some("rejected" | "conflict") => none && null_revision && !null_snapshot,
        Some("unknown" | "ambiguous") => (none == null_revision) && !null_snapshot,
        _ => false,
    }
}

/// `DSHAgentWALOperationResultShape`: the stored result snapshot, including
/// its own byte length and domain-separated digest.
pub fn operation_result_shape(snapshot: &Value) -> bool {
    let keys = [
        "schema_version",
        "operation_id",
        "operation_kind",
        "result_status",
        "result_sha256",
        "result_bytes",
        "result",
        "created_at",
    ];
    let s = |key: &str| get(snapshot, key);
    if exact_keys(Some(snapshot), &keys).is_none()
        || s("schema_version") != Some(&json!(2))
        || !canonical_uuid(s("operation_id"))
        || !as_str(s("operation_kind")).is_some_and(|kind| OPERATION_KINDS.contains(&kind))
        || !result_status_allowed(as_str(s("operation_kind")), as_str(s("result_status")))
        || !canonical_sha256(s("result_sha256"))
        || safe_integer(s("result_bytes"), MAX_OPERATION_RESULT_BYTES, false).is_none()
        || !canonical_timestamp(s("created_at"))
        || !safe_result_shape(
            s("result"),
            s("operation_kind"),
            s("operation_id"),
            s("result_status"),
        )
    {
        return false;
    }
    let Ok(bytes) = canonical_json(s("result").expect("checked")) else {
        return false;
    };
    let digest = hash_json(
        "agent-operation-result",
        &json!({ "operation_kind": s("operation_kind"), "result_status": s("result_status"), "result": s("result") }),
    );
    !bytes.is_empty()
        && bytes.len() as u64 <= MAX_OPERATION_RESULT_BYTES
        && u64_of(s("result_bytes")) == bytes.len() as u64
        && as_str(s("result_sha256")) == digest.as_deref()
}

// MARK: - JSON envelope

/// `{"op","value",...}` in; `{"ok":true,...}` or `{"ok":false,"error":<code>}` out.
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

fn reduce_json_inner(input: &str) -> Result<Value, crate::store::StoreError> {
    use crate::store::StoreError;
    let envelope: Value = serde_json::from_str(input).map_err(|_| StoreError::Corrupt)?;
    let op = as_str(get(&envelope, "op")).ok_or(StoreError::Corrupt)?;
    let value = get(&envelope, "value").ok_or(StoreError::InvalidArgument)?;
    let valid = match op {
        "reference" => reference_shape(Some(value)),
        "root" => root_full(Some(value)),
        "message" => message_shape(value),
        "reservation" => reservation_shape(value),
        "cleanup" => cleanup_shape(value),
        "dispatch" => dispatch_shape(value),
        "write_prior" => write_prior_shape(Some(value)),
        "policy" => policy_shape(Some(value)),
        "registry" => registry_shape(Some(value)),
        "authority" => authority_shape(
            value,
            &crate::session_schema::env_from_json(get(&envelope, "env")),
        ),
        "result_reference" => result_reference_shape(Some(value)),
        "snapshot_reference" => snapshot_reference_shape(Some(value)),
        "operation" => operation_shape(value),
        "operation_result" => operation_result_shape(value),
        "opaque_call_id" => opaque_call_id(Some(value)),
        _ => return Err(StoreError::InvalidArgument),
    };
    Ok(json!({ "valid": valid }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_markers_are_bound_to_their_kind() {
        let round = json!({
            "schema_version": 1, "kind": "round", "dispatch_state": "dispatched",
            "locator": { "schema_version": 1, "task_id": "0f0e3b1a-4c7d-4e2f-9a1b-2c3d4e5f6a7b",
                         "attempt_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                         "round_id": "9b8a7c6d-5e4f-4321-8765-43210fedcba9", "round_index": 0 },
        });
        assert!(dispatch_shape(&round));
        let mut execution = round.clone();
        execution["kind"] = json!("execution");
        assert!(
            !dispatch_shape(&execution),
            "an execution marker needs the call locator"
        );
    }

    #[test]
    fn safe_results_refuse_raw_payload_keys() {
        let kind = json!("execute_agent_tool");
        let id = json!("0f0e3b1a-4c7d-4e2f-9a1b-2c3d4e5f6a7b");
        let status = json!("completed");
        let safe = json!({
            "schema_version": 2, "result_kind": "execute_agent_tool",
            "result": { "schema_version": 2, "operation_id": id, "status": "completed" },
        });
        assert!(safe_result_shape(
            Some(&safe),
            Some(&kind),
            Some(&id),
            Some(&status)
        ));
        let mut leaked = safe.clone();
        leaked["result"]["arguments_json"] = json!("{}");
        assert!(!safe_result_shape(
            Some(&leaked),
            Some(&kind),
            Some(&id),
            Some(&status)
        ));
    }

    #[test]
    fn registry_tools_must_be_ordered_and_unique() {
        let tool = |name: &str| json!({ "schema_version": 2, "name": name, "safe_summary_key": "agent.x", "access": "auto" });
        let registry = json!({
            "schema_version": 2, "registry_version": 2, "toolset_sha256": "a".repeat(64),
            "tools": [tool("list_dir"), tool("read_file")],
        });
        assert!(registry_shape(Some(&registry)));
        let unordered = json!({
            "schema_version": 2, "registry_version": 2, "toolset_sha256": "a".repeat(64),
            "tools": [tool("read_file"), tool("list_dir")],
        });
        assert!(!registry_shape(Some(&unordered)));
    }
}
