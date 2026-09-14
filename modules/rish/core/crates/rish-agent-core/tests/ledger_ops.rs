//! Scenario tests for the execution-ledger row reducer. Rows are built the
//! way `AgentNativeStoreTests` builds them: a real idempotency key, a real
//! transcript digest, and a reservation for write intents.

use rish_agent_core::canonical::{canonical_json, hash_bytes, hash_json};
use rish_agent_core::ledger_ops::{reduce, reduce_json, Change, Env, Slotted, View};
use rish_agent_core::schema::{arguments_sha256, idempotency_key_for_locator};
use rish_agent_core::store::StoreError;
use serde_json::{json, Map, Value};

const TASK: &str = "11111111-1111-4111-8111-111111111111";
const ATTEMPT: &str = "22222222-2222-4222-8222-222222222222";
const ROUND: &str = "33333333-3333-4333-8333-333333333333";
const LAUNCH: &str = "44444444-4444-4444-8444-444444444444";
const NATIVE: &str = "55555555-5555-4555-8555-555555555555";
const TRANSCRIPT_REF: &str = "88888888-8888-4888-8888-888888888888";
const ROOT_DIGEST: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const NOW: &str = "2023-11-14T22:13:20.000Z";
const LATER: &str = "2023-11-14T22:13:21.000Z";
const READ_ARGUMENTS: &str = "{\"path\":\"README.md\"}";
const WRITE_ARGUMENTS: &str =
    "{\"path\":\"notes.md\",\"content\":\"hello\",\"expected_revision\":null}";

fn env() -> Env {
    Env {
        launch_id: LAUNCH.to_string(),
        now: LATER.to_string(),
        attempt_row_count: 0,
    }
}

fn owner() -> Value {
    json!({
        "schema_version": 1, "task_id": TASK, "launch_id": LAUNCH, "native_task_id": NATIVE,
        "owner_generation": 1, "heartbeat_at": NOW,
    })
}

fn transcript_state(messages: Vec<Value>, generation: u64) -> Value {
    let input = json!({
        "schema_version": 1, "transcript_ref": TRANSCRIPT_REF, "attempt_id": ATTEMPT,
        "root_fingerprint_sha256": ROOT_DIGEST, "generation": generation, "messages": messages,
    });
    let bytes = canonical_json(&input).unwrap().len() as u64;
    let digest = hash_json("agent-transcript", &input).unwrap();
    json!({
        "schema_version": 1, "transcript_ref": TRANSCRIPT_REF, "attempt_id": ATTEMPT, "state": "open",
        "root_fingerprint_sha256": ROOT_DIGEST, "generation": generation, "transcript_sha256": digest,
        "transcript_bytes": bytes, "messages": input["messages"], "created_at": NOW, "updated_at": NOW,
    })
}

fn reference_of(transcript: &Value) -> Value {
    json!({
        "schema_version": 1, "transcript_ref": TRANSCRIPT_REF, "generation": transcript["generation"],
        "transcript_sha256": transcript["transcript_sha256"], "transcript_bytes": transcript["transcript_bytes"],
    })
}

fn locator(call_index: u64, call_id: &str, arguments_digest: &str) -> Value {
    let mut locator = json!({
        "schema_version": 2, "task_id": TASK, "attempt_id": ATTEMPT, "round_id": ROUND, "round_index": 0,
        "call_index": call_index, "call_id": call_id, "idempotency_key": "0".repeat(64),
    });
    let key = idempotency_key_for_locator(
        Some(&locator),
        Some(&json!(ROOT_DIGEST)),
        Some(&json!(arguments_digest)),
    )
    .unwrap();
    locator["idempotency_key"] = json!(key);
    locator
}

fn read_intent(transcript: &Value) -> Value {
    let digest = arguments_sha256(Some(&json!("read_file")), Some(&json!(READ_ARGUMENTS))).unwrap();
    json!({
        "schema_version": 2, "locator": locator(0, "call_0", &digest), "row_revision": 1,
        "root_fingerprint_sha256": ROOT_DIGEST, "binding_revision": 7, "transcript_before": reference_of(transcript),
        "name": "read_file", "arguments_sha256": digest,
        "precondition": { "schema_version": 1, "kind": "read_file", "source_revision": "rev-1" },
        "reserved_write_bytes": 0, "state": "intent", "owner": null, "settled_facts": null,
        "transcript_after": null, "receipt": null, "created_at": NOW, "updated_at": NOW,
    })
}

fn write_intent(transcript: &Value) -> Value {
    let digest =
        arguments_sha256(Some(&json!("write_file")), Some(&json!(WRITE_ARGUMENTS))).unwrap();
    json!({
        "schema_version": 2, "locator": locator(1, "call_1", &digest), "row_revision": 1,
        "root_fingerprint_sha256": ROOT_DIGEST, "binding_revision": 7, "transcript_before": reference_of(transcript),
        "name": "write_file", "arguments_sha256": digest,
        "precondition": {
            "schema_version": 2, "kind": "write_file",
            "relative_path_sha256": hash_bytes("relative-path", b"notes.md").unwrap(),
            "prior": { "schema_version": 1, "kind": "absent" },
            "content_sha256": hash_bytes("file-content", b"hello").unwrap(), "content_bytes": 5,
        },
        "reserved_write_bytes": 5, "state": "intent", "owner": null, "settled_facts": null,
        "transcript_after": null, "receipt": null, "created_at": NOW, "updated_at": NOW,
    })
}

fn insert_cas(row: &Value) -> Value {
    json!({
        "schema_version": 1, "locator": row["locator"], "expected_absent": true,
        "expected_transcript_generation": row["transcript_before"]["generation"],
        "expected_transcript_sha256": row["transcript_before"]["transcript_sha256"],
        "expected_root_fingerprint_sha256": ROOT_DIGEST, "expected_binding_revision": 7,
    })
}

fn cas_for(row: &Value) -> Value {
    let owner = &row["owner"];
    json!({
        "schema_version": 2, "locator": row["locator"], "expected_row_revision": row["row_revision"],
        "expected_state": row["state"],
        "expected_owner_generation": if owner.is_null() { Value::Null } else { owner["owner_generation"].clone() },
        "expected_launch_id": if owner.is_null() { Value::Null } else { owner["launch_id"].clone() },
        "expected_native_task_id": if owner.is_null() { Value::Null } else { owner["native_task_id"].clone() },
        "expected_transcript_generation": row["transcript_before"]["generation"],
        "expected_transcript_sha256": row["transcript_before"]["transcript_sha256"],
        "expected_root_fingerprint_sha256": ROOT_DIGEST, "expected_binding_revision": 7,
    })
}

fn reservation(row: &Value) -> Slotted {
    let precondition = &row["precondition"];
    Slotted {
        slot: 0,
        record: json!({
            "schema_version": 1, "task_id": TASK, "attempt_id": ATTEMPT, "root_fingerprint_sha256": ROOT_DIGEST,
            "binding_revision": 7, "reservation_version": 1, "reserved_write_bytes": 5,
            "policy": { "schema_version": 1, "policy_version": "v1", "max_single_write_bytes": 32768, "max_batch_write_bytes": 524288, "max_attempt_write_bytes": 4194304 },
            "keys": [{
                "idempotency_key": row["locator"]["idempotency_key"], "state": "active",
                "relative_path_sha256": precondition["relative_path_sha256"],
                "content_sha256": precondition["content_sha256"], "content_bytes": 5,
            }],
        }),
    }
}

fn marker(row: &Value, state: &str) -> Value {
    json!({ "schema_version": 1, "kind": "execution", "locator": row["locator"], "dispatch_state": state })
}

fn args(pairs: Value) -> Map<String, Value> {
    pairs.as_object().unwrap().clone()
}

fn view(row: Option<Value>, dispatch: Vec<Value>, transcript: Option<Value>) -> View {
    View {
        row,
        dispatch,
        transcript,
        authorities: None,
        arg_owner_alive: true,
        row_owner_alive: true,
        ..Default::default()
    }
}

fn replaced_row(effect: &rish_agent_core::ledger_ops::Effect) -> Value {
    effect
        .changes
        .iter()
        .find_map(|change| match change {
            Change::ReplaceLedgerRow(row) | Change::InsertLedgerRow(row) => Some(row.clone()),
            _ => None,
        })
        .expect("row change")
}

#[test]
fn insert_binds_raw_arguments_and_replays_identically() {
    let transcript = transcript_state(vec![], 0);
    let intent = read_intent(&transcript);
    let effect = reduce(
        "insert",
        &args(json!({ "insert_cas": insert_cas(&intent), "arguments_json": READ_ARGUMENTS, "intent": intent })),
        &env(),
        &view(None, vec![], Some(transcript.clone())),
    )
    .unwrap();
    assert!(effect.commit);
    assert_eq!(effect.output["status"], "inserted");
    assert!(
        matches!(&effect.changes[1], Change::InsertDispatchMarker(marker) if marker["dispatch_state"] == "not_dispatched")
    );

    let replay = reduce(
        "insert",
        &args(json!({ "insert_cas": insert_cas(&intent), "arguments_json": READ_ARGUMENTS, "intent": intent })),
        &env(),
        &view(Some(intent.clone()), vec![marker(&intent, "not_dispatched")], Some(transcript.clone())),
    )
    .unwrap();
    assert!(!replay.commit);
    assert_eq!(replay.output["status"], "existing_identical");

    // Arguments that do not hash to the intent's digest are a conflict, and
    // arguments that do not parse are an invalid argument.
    let other = reduce(
        "insert",
        &args(
            json!({ "insert_cas": insert_cas(&intent), "arguments_json": "{\"path\":\"OTHER.md\"}", "intent": intent }),
        ),
        &env(),
        &view(None, vec![], Some(transcript.clone())),
    );
    assert_eq!(other.unwrap_err(), StoreError::Conflict);
    let garbage = reduce(
        "insert",
        &args(
            json!({ "insert_cas": insert_cas(&intent), "arguments_json": "nope", "intent": intent }),
        ),
        &env(),
        &view(None, vec![], Some(transcript.clone())),
    );
    assert_eq!(garbage.unwrap_err(), StoreError::InvalidArgument);

    // A write intent needs its active reservation key.
    let write = write_intent(&transcript);
    let unreserved = reduce(
        "insert",
        &args(
            json!({ "insert_cas": insert_cas(&write), "arguments_json": WRITE_ARGUMENTS, "intent": write }),
        ),
        &env(),
        &view(None, vec![], Some(transcript.clone())),
    );
    assert_eq!(unreserved.unwrap_err(), StoreError::Conflict);
    let mut reserved = view(None, vec![], Some(transcript.clone()));
    reserved.reservations = vec![reservation(&write)];
    let inserted = reduce(
        "insert",
        &args(json!({ "insert_cas": insert_cas(&write), "arguments_json": WRITE_ARGUMENTS, "intent": write })),
        &env(),
        &reserved,
    )
    .unwrap();
    assert!(inserted.commit);
}

#[test]
fn claim_dispatch_settle_walks_the_row_to_completion() {
    let transcript = transcript_state(vec![], 0);
    let intent = read_intent(&transcript);
    let claimed = reduce(
        "claim",
        &args(
            json!({ "locator": intent["locator"], "expected_row_revision": 1, "owner": owner() }),
        ),
        &env(),
        &view(
            Some(intent.clone()),
            vec![marker(&intent, "not_dispatched")],
            Some(transcript.clone()),
        ),
    )
    .unwrap();
    assert_eq!(claimed.output["ok"], true);
    let running = replaced_row(&claimed);
    assert_eq!(running["state"], "running");
    assert_eq!(running["row_revision"], json!(2));

    // A stale revision conflicts with the current row in the envelope.
    let stale = reduce(
        "claim",
        &args(
            json!({ "locator": intent["locator"], "expected_row_revision": 1, "owner": owner() }),
        ),
        &env(),
        &view(
            Some(running.clone()),
            vec![marker(&intent, "not_dispatched")],
            Some(transcript.clone()),
        ),
    )
    .unwrap();
    assert!(!stale.commit);
    assert_eq!(stale.output["conflict"], true);
    assert_eq!(stale.output["row"], running);

    let dispatched = reduce(
        "mark_dispatched",
        &args(json!({ "cas": cas_for(&running) })),
        &env(),
        &view(
            Some(running.clone()),
            vec![marker(&intent, "not_dispatched")],
            Some(transcript.clone()),
        ),
    )
    .unwrap();
    assert!(dispatched
        .changes
        .iter()
        .any(|change| matches!(change, Change::MarkDispatched(_))));
    let dispatched_row = replaced_row(&dispatched);
    assert_eq!(dispatched_row["row_revision"], json!(3));

    let again = reduce(
        "mark_dispatched",
        &args(json!({ "cas": cas_for(&dispatched_row) })),
        &env(),
        &view(
            Some(dispatched_row.clone()),
            vec![marker(&intent, "dispatched")],
            Some(transcript.clone()),
        ),
    )
    .unwrap();
    assert!(!again.commit);
    assert_eq!(again.output["status"], "already_dispatched");

    let content = "{\"name\":\"read_file\",\"outcome\":\"ok\",\"payload\":{\"content\":\"hi\",\"revision\":\"rev-1\",\"schema_version\":1,\"truncated\":false},\"schema_version\":1}";
    let message = json!({ "schema_version": 1, "role": "tool", "round_index": 0, "call_id": "call_0", "content": content, "truncated": false });
    let receipt = json!({
        "schema_version": 1, "call_id": "call_0", "name": "read_file", "arguments_sha256": intent["arguments_sha256"],
        "result_sha256": hash_bytes("tool-result", content.as_bytes()).unwrap(), "result_bytes": content.len(),
        "truncated": false, "duration_ms": 3, "outcome": "ok", "failure_code": null, "approval_reference": null,
    });
    let patch = json!({ "state": "settled", "receipt": receipt, "settled_facts": { "schema_version": 1, "kind": "read_file", "source_revision": "rev-1" } });
    let operation = json!({ "operation_id": "66666666-6666-4666-8666-666666666666", "request_sha256": "b".repeat(64), "effect_may_have_occurred": false });
    let settled = reduce(
        "settle",
        &args(json!({ "cas": cas_for(&dispatched_row), "patch": patch, "message": message, "operation": operation })),
        &env(),
        &view(Some(dispatched_row.clone()), vec![marker(&intent, "dispatched")], Some(transcript.clone())),
    )
    .unwrap();
    let settled_row = replaced_row(&settled);
    assert_eq!(settled_row["state"], "settled");
    assert!(settled_row["owner"].is_null());
    assert_eq!(settled_row["transcript_after"]["generation"], json!(1));
    let next_transcript = settled
        .changes
        .iter()
        .find_map(|c| match c {
            Change::ReplaceTranscript(row) => Some(row.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(next_transcript["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        settled_row["transcript_after"]["transcript_sha256"],
        next_transcript["transcript_sha256"]
    );
    let commit = settled.commit_operation.unwrap();
    assert_eq!(commit.terminal_state, "committed");
    assert_eq!(commit.result_status, "completed");
    assert_eq!(commit.safe_result["result"]["status"], "completed");
    assert_eq!(commit.result_ref["execution_revision"], json!(4));

    // Facts that disagree with the feedback payload are a conflict.
    let wrong_facts = json!({ "state": "settled", "receipt": settled_row["receipt"], "settled_facts": { "schema_version": 1, "kind": "read_file", "source_revision": "rev-2" } });
    let conflict = reduce(
        "settle",
        &args(
            json!({ "cas": cas_for(&dispatched_row), "patch": wrong_facts, "message": message, "operation": null }),
        ),
        &env(),
        &view(
            Some(dispatched_row.clone()),
            vec![marker(&intent, "dispatched")],
            Some(transcript.clone()),
        ),
    );
    assert_eq!(conflict.unwrap_err(), StoreError::Conflict);
}

#[test]
fn cancel_releases_reservations_and_appends_feedback() {
    let transcript = transcript_state(vec![], 0);
    let write = write_intent(&transcript);
    let mut state = view(
        Some(write.clone()),
        vec![marker(&write, "not_dispatched")],
        Some(transcript.clone()),
    );
    state.reservations = vec![reservation(&write)];
    state.batches = vec![Slotted {
        slot: 3,
        record: json!({
            "attempt_id": ATTEMPT, "write_keys": [write["locator"]["idempotency_key"]], "reserved_write_bytes": 5,
            "effect_gate": "closed", "manifest_calls": [{ "locator": write["locator"] }], "updated_at": NOW,
        }),
    }];
    let effect = reduce(
        "cancel",
        &args(json!({ "cas": cas_for(&write), "patch": { "state": "cancelled" } })),
        &env(),
        &state,
    )
    .unwrap();
    let row = replaced_row(&effect);
    assert_eq!(row["state"], "cancelled");
    assert_eq!(row["reserved_write_bytes"], json!(0));
    assert_eq!(row["receipt"]["failure_code"], "E_AGENT_CANCELLED");
    let reservation_change = effect
        .changes
        .iter()
        .find_map(|c| match c {
            Change::ReplaceReservation { slot, record } => Some((*slot, record.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(reservation_change.0, 0);
    assert_eq!(reservation_change.1["reserved_write_bytes"], json!(0));
    assert_eq!(reservation_change.1["keys"][0]["state"], "released");
    let batch_change = effect
        .changes
        .iter()
        .find_map(|c| match c {
            Change::ReplaceBatch { slot, record } => Some((*slot, record.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(batch_change.0, 3);
    assert_eq!(batch_change.1["effect_gate"], "released");
    assert_eq!(batch_change.1["reserved_write_bytes"], json!(0));

    // Dispatched work can no longer be cancelled.
    let mut dispatched = state.clone();
    dispatched.dispatch = vec![marker(&write, "dispatched")];
    assert_eq!(
        reduce(
            "cancel",
            &args(json!({ "cas": cas_for(&write), "patch": { "state": "cancelled" } })),
            &env(),
            &dispatched
        )
        .unwrap_err(),
        StoreError::Conflict
    );
}

#[test]
fn release_and_reconcile_follow_their_proofs() {
    let transcript = transcript_state(vec![], 0);
    let write = write_intent(&transcript);
    let mut state = view(
        Some(write.clone()),
        vec![marker(&write, "not_dispatched")],
        Some(transcript.clone()),
    );
    state.reservations = vec![reservation(&write)];
    let released = reduce(
        "release",
        &args(json!({ "cas": cas_for(&write) })),
        &env(),
        &state,
    )
    .unwrap();
    assert_eq!(released.output["status"], "released");
    assert_eq!(released.output["reserved_write_bytes"], json!(0));
    assert_eq!(replaced_row(&released)["reserved_write_bytes"], json!(0));

    let read = read_intent(&transcript);
    let mut running = read.clone();
    running["state"] = json!("running");
    running["owner"] = owner();
    let mut dead = view(
        Some(running.clone()),
        vec![marker(&read, "not_dispatched")],
        Some(transcript.clone()),
    );
    dead.row_owner_alive = false;
    let patch = json!({ "state": "unknown", "owner": null, "settled_facts": null, "transcript_after": null, "receipt": null });
    let unknown = reduce(
        "reconcile",
        &args(json!({ "cas": cas_for(&running), "patch": patch })),
        &env(),
        &dead,
    )
    .unwrap();
    assert_eq!(replaced_row(&unknown)["state"], "unknown");

    let alive = view(
        Some(running.clone()),
        vec![marker(&read, "not_dispatched")],
        Some(transcript.clone()),
    );
    assert_eq!(
        reduce(
            "reconcile",
            &args(json!({ "cas": cas_for(&running), "patch": patch })),
            &env(),
            &alive
        )
        .unwrap_err(),
        StoreError::Conflict
    );

    let query = reduce(
        "query",
        &args(json!({ "locator": read["locator"], "expected_transcript": reference_of(&transcript), "root": { "schema_version": 1, "root_fingerprint_sha256": ROOT_DIGEST, "binding_revision": 7 } })),
        &env(),
        &view(Some(running.clone()), vec![], None),
    )
    .unwrap();
    assert_eq!(query.output["status"], "running");
}

#[test]
fn denied_approval_settles_in_the_callers_candidate() {
    let transcript = transcript_state(vec![], 0);
    let write = write_intent(&transcript);
    let feedback = "{\"name\":\"write_file\",\"outcome\":\"denied\",\"payload\":{\"failure_code\":\"E_AGENT_DENIED_BY_USER\",\"schema_version\":1},\"schema_version\":1}";
    let root = json!({
        "schema_version": 1, "kind": "workspace", "workspace_id": "77777777-7777-4777-8777-777777777777",
        "workspace_binding_revision": 7, "project_id": null, "root_fingerprint_sha256": ROOT_DIGEST,
        "capabilities": ["file_read", "file_write"],
    });
    let policy = json!({ "schema_version": 1, "policy_version": "v1", "max_single_write_bytes": 32768, "max_batch_write_bytes": 524288, "max_attempt_write_bytes": 4194304 });
    let mut state = view(
        Some(write.clone()),
        vec![marker(&write, "not_dispatched")],
        Some(transcript.clone()),
    );
    state.expected_transcript = Some(transcript.clone());
    state.authorities = Some(vec![Slotted {
        slot: 0,
        record: json!({
            "task_id": TASK, "attempt_id": ATTEMPT, "state": "prepared", "root": root,
            "transcript": reference_of(&transcript), "policy": policy, "reserved_write_bytes": 5,
            "authority_revision": 1, "updated_at": NOW,
        }),
    }]);
    let effect = reduce(
        "settle_denied_approval",
        &args(json!({
            "locator": write["locator"], "root": root, "expected_transcript": reference_of(&transcript), "policy": policy,
            "expected_reserved_write_bytes": 5, "feedback_json": feedback, "timestamp": LATER,
        })),
        &env(),
        &state,
    )
    .unwrap();
    assert_eq!(effect.output["receipt"]["outcome"], "denied");
    assert_eq!(effect.output["transcript"]["generation"], json!(1));
    let row = replaced_row(&effect);
    assert_eq!(row["state"], "settled");
    assert_eq!(row["row_revision"], json!(2));
    let authority = effect
        .changes
        .iter()
        .find_map(|c| match c {
            Change::ReplaceAuthority { record, .. } => Some(record.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(authority["authority_revision"], json!(2));
    assert_eq!(authority["transcript"], effect.output["transcript"]);

    // A missing authority for a non-empty table is a conflict.
    let mut orphan = state.clone();
    orphan.authorities = Some(vec![]);
    assert_eq!(
        reduce(
            "settle_denied_approval",
            &args(json!({
                "locator": write["locator"], "root": root, "expected_transcript": reference_of(&transcript), "policy": policy,
                "expected_reserved_write_bytes": 5, "feedback_json": feedback, "timestamp": LATER,
            })),
            &env(),
            &orphan,
        )
        .unwrap_err(),
        StoreError::Conflict
    );
}

#[test]
fn json_envelope_carries_slots_and_changes() {
    let transcript = transcript_state(vec![], 0);
    let write = write_intent(&transcript);
    let envelope = json!({
        "op": "release",
        "args": { "cas": cas_for(&write) },
        "env": { "launch_id": LAUNCH, "now": LATER, "attempt_row_count": 1 },
        "view": {
            "row": write, "dispatch": [marker(&write, "not_dispatched")], "transcript": transcript,
            "reservations": [{ "slot": 4, "record": reservation(&write).record }], "batches": [], "authorities": null,
            "arg_owner_alive": false, "row_owner_alive": false,
        },
    });
    let output: Value = serde_json::from_str(&reduce_json(&envelope.to_string())).unwrap();
    assert_eq!(output["ok"], true);
    assert_eq!(output["commit"], true);
    let changes = output["changes"].as_array().unwrap();
    assert_eq!(changes[0]["kind"], "replace_ledger_row");
    assert_eq!(changes[1]["kind"], "replace_reservation");
    assert_eq!(changes[1]["slot"], json!(4));
    assert!(output["commit_operation"].is_null());
    let failure: Value = serde_json::from_str(&reduce_json(
        r#"{"op":"cancel","args":{},"env":{"launch_id":"x","now":"y"},"view":{}}"#,
    ))
    .unwrap();
    assert_eq!(failure, json!({ "ok": false, "error": 1 }));
}
