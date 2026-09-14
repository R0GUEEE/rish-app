//! Scenario tests for the transcript-store reducer.

use rish_agent_core::ledger_ops::Slotted;
use rish_agent_core::store::StoreError;
use rish_agent_core::transcript_store::{reduce, reduce_json, Change, Env, RowReference, View};
use serde_json::{json, Value};

const ATTEMPT: &str = "22222222-2222-4222-8222-222222222222";
const REF: &str = "88888888-8888-4888-8888-888888888888";
const ROOT_DIGEST: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const NOW: &str = "2023-11-14T22:13:20.000Z";
const LATER: &str = "2023-11-21T22:13:20.000Z";
const CLEANUP: &str = "99999999-9999-4999-8999-999999999999";
const OWNER: &str = "77777777-7777-4777-8777-777777777777";

fn env() -> Env {
    Env {
        launch_id: String::new(),
        now: NOW.to_string(),
        retention_until: LATER.to_string(),
        transcript_ref: REF.to_string(),
    }
}

fn root() -> Value {
    json!({
        "schema_version": 1, "kind": "workspace", "workspace_id": "77777777-7777-4777-8777-777777777777",
        "workspace_binding_revision": 7, "project_id": null, "root_fingerprint_sha256": ROOT_DIGEST,
        "capabilities": ["file_read", "file_write"],
    })
}

fn created_row() -> Value {
    let view = View {
        transcripts_present: true,
        ..Default::default()
    };
    let effect = reduce(
        "create",
        &json!({ "schema_version": 1, "attempt_id": ATTEMPT, "root": root() }),
        &env(),
        &view,
    )
    .unwrap();
    match &effect.changes[0] {
        Change::InsertTranscript(row) => row.clone(),
        other => panic!("unexpected change {other:?}"),
    }
}

fn reference_of(row: &Value) -> Value {
    json!({
        "schema_version": 1, "transcript_ref": row["transcript_ref"], "generation": row["generation"],
        "transcript_sha256": row["transcript_sha256"], "transcript_bytes": row["transcript_bytes"],
    })
}

fn bound_request(row: &Value) -> Value {
    json!({ "schema_version": 1, "attempt_id": ATTEMPT, "root": root(), "transcript": reference_of(row) })
}

#[test]
fn create_is_idempotent_per_attempt_and_bound_to_one_root() {
    let row = created_row();
    assert_eq!(row["generation"], json!(0));
    assert_eq!(row["state"], "open");
    let replay_view = View {
        transcripts_present: true,
        transcript_count: 1,
        attempt_transcripts: vec![row.clone()],
        ..Default::default()
    };
    let replay = reduce(
        "create",
        &json!({ "schema_version": 1, "attempt_id": ATTEMPT, "root": root() }),
        &env(),
        &replay_view,
    )
    .unwrap();
    assert!(!replay.commit);
    assert_eq!(replay.output, reference_of(&row));
    let mut other_root = root();
    other_root["root_fingerprint_sha256"] = json!("b".repeat(64));
    assert_eq!(
        reduce(
            "create",
            &json!({ "schema_version": 1, "attempt_id": ATTEMPT, "root": other_root }),
            &env(),
            &replay_view
        )
        .unwrap_err(),
        StoreError::Conflict
    );
    let full = View {
        transcripts_present: true,
        transcript_count: 128,
        ..Default::default()
    };
    assert_eq!(
        reduce(
            "create",
            &json!({ "schema_version": 1, "attempt_id": ATTEMPT, "root": root() }),
            &env(),
            &full
        )
        .unwrap_err(),
        StoreError::Capacity
    );
    let missing = View::default();
    assert_eq!(
        reduce(
            "create",
            &json!({ "schema_version": 1, "attempt_id": ATTEMPT, "root": root() }),
            &env(),
            &missing
        )
        .unwrap_err(),
        StoreError::Corrupt
    );
}

#[test]
fn append_validate_and_native_messages_agree_on_digests() {
    let row = created_row();
    let view = View {
        transcript: Some(row.clone()),
        ..Default::default()
    };
    let message = json!({ "schema_version": 1, "role": "assistant", "round_index": 0, "content": "hi", "reasoning_content": "", "tool_calls": [] });
    let appended = reduce(
        "append",
        &json!({ "message": message, "expected_transcript": reference_of(&row), "root": root(), "attempt_id": ATTEMPT }),
        &env(),
        &view,
    )
    .unwrap();
    let next = match &appended.changes[0] {
        Change::ReplaceTranscript(row) => row.clone(),
        other => panic!("unexpected change {other:?}"),
    };
    assert_eq!(next["generation"], json!(1));
    assert_eq!(appended.output, reference_of(&next));

    let next_view = View {
        transcript: Some(next.clone()),
        ..Default::default()
    };
    let valid = reduce("validate", &bound_request(&next), &env(), &next_view).unwrap();
    assert_eq!(valid.output["status"], "valid");
    let messages = reduce("native_messages", &bound_request(&next), &env(), &next_view).unwrap();
    assert_eq!(messages.output.as_array().unwrap().len(), 1);

    // A stale reference conflicts; a tampered digest is corrupt.
    assert_eq!(
        reduce("validate", &bound_request(&row), &env(), &next_view).unwrap_err(),
        StoreError::Conflict
    );
    let mut tampered = next.clone();
    tampered["transcript_sha256"] = json!("c".repeat(64));
    let mut tampered_request = bound_request(&tampered);
    tampered_request["transcript"]["transcript_sha256"] = json!("c".repeat(64));
    let tampered_view = View {
        transcript: Some(tampered),
        ..Default::default()
    };
    assert_eq!(
        reduce("validate", &tampered_request, &env(), &tampered_view).unwrap_err(),
        StoreError::Corrupt
    );

    // Tool messages must carry canonical feedback.
    let bad_tool = json!({ "schema_version": 1, "role": "tool", "round_index": 0, "call_id": "c1", "content": "{}", "truncated": false });
    assert_eq!(
        reduce("append", &json!({ "message": bad_tool, "expected_transcript": reference_of(&next), "root": root(), "attempt_id": ATTEMPT }), &env(), &next_view).unwrap_err(),
        StoreError::InvalidArgument
    );
}

#[test]
fn terminal_then_discard_follows_the_cleanup_ledger() {
    let row = created_row();
    let request = json!({
        "schema_version": 1, "attempt_id": ATTEMPT, "root": root(), "transcript": reference_of(&row),
        "reason": "completed", "cleanup_id": CLEANUP, "cleanup_owner": OWNER,
    });
    let view = View {
        transcript: Some(row.clone()),
        ..Default::default()
    };
    let terminal = reduce("mark_terminal", &request, &env(), &view).unwrap();
    assert_eq!(terminal.output["status"], "terminal");
    let (updated, cleanup) = match (&terminal.changes[0], &terminal.changes[1]) {
        (Change::ReplaceTranscript(row), Change::InsertCleanup(record)) => {
            (row.clone(), record.clone())
        }
        other => panic!("unexpected changes {other:?}"),
    };
    assert_eq!(updated["state"], "terminal");
    assert_eq!(updated["retention_until"], LATER);
    assert_eq!(cleanup["status"], "pending");

    let again_view = View {
        transcript: Some(updated.clone()),
        cleanup: vec![Slotted {
            slot: 3,
            record: cleanup.clone(),
        }],
        ..Default::default()
    };
    let again = reduce("mark_terminal", &request, &env(), &again_view).unwrap();
    assert!(!again.commit);
    assert_eq!(again.output["status"], "already_terminal");

    let discard_request = json!({
        "schema_version": 1, "attempt_id": ATTEMPT, "transcript_ref": REF, "transcript_sha256": updated["transcript_sha256"],
        "cleanup_id": CLEANUP, "cleanup_owner": OWNER,
    });
    let mut blocked = again_view.clone();
    blocked.rounds = vec![RowReference {
        state: "in_flight".into(),
        before_ref: Some(json!(REF)),
        after_ref: None,
    }];
    assert_eq!(
        reduce("discard", &discard_request, &env(), &blocked).unwrap_err(),
        StoreError::Conflict
    );

    let discarded = reduce("discard", &discard_request, &env(), &again_view).unwrap();
    assert_eq!(discarded.output["status"], "discarded");
    assert!(
        matches!(&discarded.changes[0], Change::RemoveTranscript(reference) if reference == &json!(REF))
    );
    let discarded_entry = match &discarded.changes[1] {
        Change::ReplaceCleanup { slot: 3, record } => record.clone(),
        other => panic!("unexpected change {other:?}"),
    };
    assert_eq!(discarded_entry["status"], "discarded");

    let gone = View {
        cleanup: vec![Slotted {
            slot: 3,
            record: discarded_entry.clone(),
        }],
        ..Default::default()
    };
    let missing = reduce("discard", &discard_request, &env(), &gone).unwrap();
    assert_eq!(missing.output["status"], "already_missing");
    let status = reduce(
        "query_cleanup",
        &json!({ "schema_version": 1, "cleanup_id": CLEANUP }),
        &env(),
        &gone,
    )
    .unwrap();
    assert_eq!(status.output["status"], "discarded");
    let unknown = reduce(
        "query_cleanup",
        &json!({ "schema_version": 1, "cleanup_id": CLEANUP }),
        &env(),
        &View::default(),
    )
    .unwrap();
    assert_eq!(unknown.output["status"], "unknown");
}

#[test]
fn json_envelope_round_trips() {
    let envelope = json!({
        "op": "create",
        "request": { "schema_version": 1, "attempt_id": ATTEMPT, "root": root() },
        "env": { "launch_id": "x", "now": NOW, "retention_until": LATER, "transcript_ref": REF },
        "view": { "transcripts_present": true, "transcript_count": 0 },
    });
    let output: Value = serde_json::from_str(&reduce_json(&envelope.to_string())).unwrap();
    assert_eq!(output["ok"], true);
    assert_eq!(output["changes"][0]["kind"], "insert_transcript");
    assert_eq!(output["output"]["transcript_ref"], REF);
}
