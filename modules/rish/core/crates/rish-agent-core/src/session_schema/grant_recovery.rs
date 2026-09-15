//! Recover the narrow prepare-committed/reply-lost window. A call reference is
//! never sufficient: the committed prepare receipt, intent, manifest, dispatch
//! marker, frozen registry and current live grant must all describe that call.
use crate::execution_ledger::{as_str, get, ledger_row};
use crate::schema::canonical_uuid;
use serde_json::{json, Value};

fn array(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn same(left: Option<&Value>, right: Option<&Value>) -> bool {
    matches!((left, right), (Some(a), Some(b)) if a == b)
}
fn tokenless_bound(call: &Value) -> bool {
    as_str(get(call, "access")) == Some("conversation_confirm")
        && as_str(get(call, "approval_state")) == Some("bound")
        && get(call, "approval_token") == Some(&Value::Null)
}
fn prepared_receipt<'a>(state: &'a Value, batch: &Value) -> Option<&'a Value> {
    array(get(state, "operation_results"))
        .iter()
        .rev()
        .find_map(|snapshot| {
            let wrapper = get(snapshot, "result")?;
            let result = get(wrapper, "result")?;
            let receipt = get(result, "receipt")?;
            (get(wrapper, "schema_version") == Some(&json!(2))
                && get(result, "schema_version") == Some(&json!(2))
                && get(receipt, "schema_version") == Some(&json!(2))
                && as_str(get(wrapper, "result_kind")) == Some("prepare_agent_tool_batch")
                && matches!(
                    as_str(get(result, "status")),
                    Some("prepared" | "already_prepared")
                )
                && as_str(get(receipt, "batch_kind")) == Some("write_batch")
                && same(get(receipt, "effect_gate"), get(batch, "effect_gate"))
                && [
                    "task_id",
                    "attempt_id",
                    "round_id",
                    "round_index",
                    "batch_revision",
                    "manifest_sha256",
                ]
                .iter()
                .all(|key| same(get(receipt, key), get(batch, key))))
            .then_some(receipt)
        })
}
fn wal_call_bound(
    state: &Value,
    batch: &Value,
    receipt: &Value,
    call: &Value,
    base: &Value,
) -> bool {
    let Some(name) = as_str(get(call, "name")) else {
        return false;
    };
    let Some(prepared) = array(get(receipt, "calls")).iter().find(|p| {
        [
            "call_id",
            "call_index",
            "name",
            "arguments_sha256",
            "idempotency_key",
            "access",
            "safe_summary_key",
            "approval_state",
            "approval_token",
            "approval_reference",
        ]
        .iter()
        .all(|key| same(get(p, key), get(call, key)))
    }) else {
        return false;
    };
    if !tokenless_bound(prepared)
        || !canonical_uuid(get(call, "approval_reference"))
        || as_str(get(call, "execution_status")) != Some("intent")
        || get(call, "receipt") != Some(&Value::Null)
    {
        return false;
    }
    let registered = array(get(base, "registry").and_then(|r| get(r, "tools")))
        .iter()
        .any(|tool| {
            as_str(get(tool, "name")) == Some(name)
                && as_str(get(tool, "access")) == Some("conversation_confirm")
                && same(get(tool, "safe_summary_key"), get(call, "safe_summary_key"))
        });
    if !registered {
        return false;
    }
    let rows: Vec<_> = array(get(state, "ledger"))
        .iter()
        .filter(|row| {
            let locator = get(row, "locator");
            ["task_id", "attempt_id", "round_id", "round_index"]
                .iter()
                .all(|key| same(locator.and_then(|l| get(l, key)), get(batch, key)))
                && ["call_id", "call_index", "idempotency_key"]
                    .iter()
                    .all(|key| same(locator.and_then(|l| get(l, key)), get(call, key)))
        })
        .collect();
    if rows.len() != 1 {
        return false;
    }
    let row = rows[0];
    let manifest = crate::ledger_ops::write_manifest_call_for_intent(row);
    ledger_row(row)
        && as_str(get(row, "state")) == Some("intent")
        && same(get(row, "name"), get(call, "name"))
        && same(get(row, "arguments_sha256"), get(call, "arguments_sha256"))
        && same(get(row, "row_revision"), get(call, "native_row_revision"))
        && same(get(row, "row_revision"), get(call, "execution_revision"))
        && same(
            get(row, "root_fingerprint_sha256"),
            get(batch, "root_fingerprint_sha256"),
        )
        && same(get(row, "binding_revision"), get(batch, "binding_revision"))
        && manifest.is_some_and(|m| array(get(batch, "manifest_calls")).contains(&m))
        && crate::ledger_ops::dispatch_state_in(array(get(state, "dispatch")), get(row, "locator"))
            == Some("not_dispatched")
}

pub(crate) fn frozen_ids_after_lost_prepare(
    state: &Value,
    batch: &Value,
    calls: &Value,
    proof: &Value,
    request: &Value,
    base: &Value,
) -> Option<Value> {
    let mut frozen = super::grant_reuse::frozen_ids_for_projection(proof, request, base)?
        .as_array()?
        .clone();
    let missing: Vec<_> = array(Some(calls))
        .iter()
        .filter(|call| {
            tokenless_bound(call)
                && !frozen
                    .iter()
                    .any(|id| Some(id) == get(call, "approval_reference"))
        })
        .collect();
    if missing.is_empty() {
        return Some(Value::Array(frozen));
    }
    if !["conversation_id", "task_id", "attempt_id"]
        .iter()
        .all(|key| same(get(base, key), get(request, key)))
        || !crate::wal_state::batch_shape_v2(batch)
        || as_str(get(batch, "effect_gate")) != Some("closed")
        || !["task_id", "attempt_id"]
            .iter()
            .all(|key| same(get(batch, key), get(request, key)))
        || !same(
            get(batch, "root_fingerprint_sha256"),
            get(base, "root").and_then(|r| get(r, "root_fingerprint_sha256")),
        )
        || !same(
            get(batch, "binding_revision"),
            get(base, "root").and_then(|r| get(r, "workspace_binding_revision")),
        )
    {
        return None;
    }
    let conversation = array(get(proof, "session").and_then(|s| get(s, "conversations")))
        .iter()
        .find(|c| same(get(c, "id"), get(request, "conversation_id")))?;
    let attempt = array(get(conversation, "attempts"))
        .iter()
        .find(|a| same(get(a, "attempt_id"), get(request, "attempt_id")))?;
    let journal = get(attempt, "agent")?;
    let receipt = prepared_receipt(state, batch)?;
    for call in missing {
        if !wal_call_bound(state, batch, receipt, call, base) {
            return None;
        }
        let reference = get(call, "approval_reference")?;
        let grants: Vec<_> = array(get(conversation, "agent_grants"))
            .iter()
            .filter(|g| get(g, "grant_id") == Some(reference))
            .collect();
        if grants.len() != 1 {
            return None;
        }
        let issued = get(grants[0], "issued_for")?;
        if !array(get(conversation, "attempts")).iter().any(|a| {
            same(get(a, "attempt_id"), get(issued, "attempt_id"))
                && same(get(a, "turn_id"), get(issued, "task_id"))
        }) {
            return None;
        }
        if !frozen.contains(reference) {
            frozen.push(reference.clone());
        }
        if frozen.len() > 2 {
            return None;
        }
        let mut projected = call.clone();
        projected["approval_decision"] = json!("allow_conversation");
        let mut recovered_journal = journal.clone();
        recovered_journal["batch"] = json!([projected]);
        recovered_journal["frozen_grant_ids"] = json!(frozen);
        if !super::grant_reuse::call_shape(&recovered_journal["batch"][0])
            || !super::grant_reuse::conversation_bound(&recovered_journal, conversation)
        {
            return None;
        }
    }
    Some(Value::Array(frozen))
}
