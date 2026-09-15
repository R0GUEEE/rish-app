//! Parity with the Objective-C++ WAL operation relation.
//! `wal-transaction-golden.json` was recorded from `AgentNativeWAL.mm` by
//! running the whole native suite with the entry points instrumented, while
//! they still decided everything themselves. Each step is one command against
//! one committed state: the observable contract is (state, command, clock) ->
//! (output or error, committed state), so that is what is replayed here.

use rish_agent_core::store::StoreError;
use rish_agent_core::wal_operations::{
    commit_apply, commit_prepare, prepare_authority, query, record_batch, record_denied_call,
    start, start_target, CommitPrepared, Outcome,
};
use serde_json::{json, Map, Value};
use std::path::PathBuf;

/// The arrays the operation relation owns; everything else in the state is
/// the transaction's business, not this relation's.
const OWNED: &[&str] = &[
    "authorities",
    "operations",
    "operation_results",
    "batches",
    "denied_calls",
];

const POOLED: &[&str] = &[
    "authorities",
    "operations",
    "operation_results",
    "transcripts",
    "rounds",
    "ledger",
    "reservations",
    "cleanup",
    "dispatch",
    "batches",
    "denied_calls",
];

struct Golden {
    values: Vec<Value>,
    states: Vec<Value>,
    steps: Vec<Value>,
}

fn load() -> Golden {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "fixtures",
        "wal-transaction-golden.json",
    ]
    .iter()
    .collect();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let document: Value = serde_json::from_str(&text).expect("parse golden");
    Golden {
        values: document["values"].as_array().expect("values").clone(),
        states: document["states"].as_array().expect("states").clone(),
        steps: document["steps"].as_array().expect("steps").clone(),
    }
}

impl Golden {
    fn value(&self, index: &Value) -> Value {
        self.values[index.as_u64().expect("value index") as usize].clone()
    }

    fn state(&self, index: &Value) -> Option<Value> {
        let index = index.as_u64()? as usize;
        let encoded = self.states[index].as_object().expect("state object");
        let mut state = Map::new();
        for (key, value) in encoded {
            if POOLED.contains(&key.as_str()) {
                let rows: Vec<Value> = value
                    .as_array()
                    .expect("row indices")
                    .iter()
                    .map(|index| self.value(index))
                    .collect();
                state.insert(key.clone(), Value::Array(rows));
            } else {
                state.insert(key.clone(), value.clone());
            }
        }
        Some(Value::Object(state))
    }

    fn arguments(&self, step: &Value) -> Value {
        let mut arguments = Map::new();
        for (key, index) in step["arguments"].as_object().expect("arguments") {
            arguments.insert(key.clone(), self.value(index));
        }
        Value::Object(arguments)
    }
}

fn timestamp(step: &Value, index: usize) -> String {
    step["timestamps"]
        .as_array()
        .and_then(|stamps| stamps.get(index))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The committed state the host would be left with.
fn applied(before: &Value, outcome: &Outcome) -> Value {
    let mut state = before.as_object().cloned().expect("state");
    if let Outcome::Commit { changes, .. } = outcome {
        for (key, value) in changes {
            state.insert(key.clone(), value.clone());
        }
    }
    Value::Object(state)
}

fn owned(state: &Value) -> Value {
    let mut map = Map::new();
    for key in OWNED {
        map.insert(
            (*key).to_string(),
            state.get(*key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(map)
}

fn expected_error(step: &Value) -> Option<u64> {
    step["error"].as_u64()
}

fn outcome_error(outcome: &Outcome) -> Option<u64> {
    match outcome {
        Outcome::Error(error) => Some(u64::from(error.code())),
        _ => None,
    }
}

fn outcome_output(outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Commit { output, .. } | Outcome::Replay { output } => output.clone(),
        Outcome::Error(_) => Value::Null,
    }
}

/// `commit` and `commit_in_state` are the same decision; only the in-state
/// variant lets the host's fault hook speak between the two halves, and the
/// golden holds no injected fault on this path.
fn commit_outcome(before: &Value, arguments: &Value, step: &Value) -> Outcome {
    match commit_prepare(before, arguments, &timestamp(step, 0)) {
        CommitPrepared::Replay { output } => Outcome::Replay { output },
        CommitPrepared::Error(error) => Outcome::Error(error),
        CommitPrepared::Proceed { snapshot } => {
            commit_apply(before, arguments, &snapshot, &timestamp(step, 1))
        }
    }
}

#[test]
fn every_recorded_command_decides_exactly_as_the_native_relation_did() {
    let golden = load();
    assert!(golden.steps.len() > 400, "the golden lost steps");
    let mut replayed = 0usize;
    let mut skipped = 0usize;
    for (index, step) in golden.steps.iter().enumerate() {
        let command = step["command"].as_str().expect("command");
        let Some(before) = golden.state(&step["before"]) else {
            continue;
        };
        // A transaction that failed before the host had the lock and a loaded
        // state never asked the relation anything, so there is no decision to
        // replay. The relation itself only reports persistence for a torn
        // prepare, which happens inside the transaction.
        if step["reached"] == json!(false) && step["error"] == json!(8) {
            skipped += 1;
            continue;
        }
        let after = golden.state(&step["after"]).expect("after");
        let arguments = golden.arguments(step);
        // The in-state commit is the one place the host speaks in the middle:
        // its fault hook refuses between the two halves. A recorded
        // persistence failure there means the relation had already said
        // proceed, and nothing was written.
        if command == "commit_in_state" && step["error"] == json!(8) {
            assert!(
                matches!(
                    commit_prepare(&before, &arguments, &timestamp(step, 0)),
                    CommitPrepared::Proceed { .. }
                ),
                "step {index}: the fault hook only speaks after a settled prepare"
            );
            assert_eq!(
                owned(&before),
                owned(&after),
                "step {index}: nothing written"
            );
            replayed += 1;
            continue;
        }
        let outcome = match command {
            "start" => start(&before, &arguments, &timestamp(step, 0)),
            "start_target" => start_target(&before, &arguments, &timestamp(step, 0)),
            "query" => match query(&before, &arguments) {
                Ok(output) => Outcome::Replay { output },
                Err(error) => Outcome::Error(error),
            },
            "commit" | "commit_in_state" => commit_outcome(&before, &arguments, step),
            "prepare_authority" => prepare_authority(&before, &arguments, &timestamp(step, 0)),
            "record_batch" => record_batch(&before, &arguments),
            "record_denied_call" => record_denied_call(&before, &arguments),
            other => panic!("step {index}: unknown command {other}"),
        };
        assert_eq!(
            outcome_error(&outcome),
            expected_error(step),
            "step {index} ({command}): error"
        );
        if expected_error(step).is_none() {
            assert_eq!(
                outcome_output(&outcome),
                golden.value(&step["output"]),
                "step {index} ({command}): output"
            );
        }
        assert_eq!(
            owned(&applied(&before, &outcome)),
            owned(&after),
            "step {index} ({command}): committed rows"
        );
        replayed += 1;
    }
    assert_eq!(
        replayed + skipped,
        golden.steps.len(),
        "every step must replay"
    );
    assert!(
        skipped <= 1,
        "only the host's own write failure may be skipped"
    );
}

#[test]
fn a_commit_needs_its_reference_and_its_revision_together() {
    let state = json!({ "operations": [], "operation_results": [] });
    let arguments = json!({
        "operation_id": "00000000-0000-4000-8000-000000000001",
        "request_sha256": "0".repeat(64),
        "task_id": "00000000-0000-4000-8000-000000000002",
        "attempt_id": "00000000-0000-4000-8000-000000000003",
        "terminal_state": "committed",
        "result_status": "completed",
        "result_ref": { "schema_version": 2, "kind": "none" },
        "result_revision": Value::Null,
        "safe_result": {},
    });
    assert!(matches!(
        commit_prepare(&state, &arguments, "2026-01-01T00:00:00.000Z"),
        CommitPrepared::Error(StoreError::InvalidArgument)
    ));
}
