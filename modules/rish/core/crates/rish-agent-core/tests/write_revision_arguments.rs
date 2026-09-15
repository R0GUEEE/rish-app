//! Admission of new write calls must not redefine durable argument identity.

use rish_agent_core::{schema, tool_batch};
use serde_json::{json, Value};

const REASON: &str = "expected_revision_must_be_json_null_or_a_read_file_revision";

fn plan(name: &str, arguments: Value, round_index: u64) -> Value {
    let name_value = json!(name);
    let encoded = json!(arguments.to_string());
    let digest = schema::arguments_sha256(Some(&name_value), Some(&encoded))
        .expect("even a refused call keeps its durable identity");
    tool_batch::prepare_calls(
        &json!({"round_index":round_index}),
        &json!({"calls":[{"call_index":0,"call_id":"call","name":name,"arguments_sha256":digest}]}),
        Some(&[
            json!({"role":"assistant","round_index":round_index,"tool_calls":[{
                "call_id":"call","name":name,"arguments_json":encoded,
            }]}),
        ]),
        &json!({"registry":{"tools":[{"name":name,"access":"auto","safe_summary_key":format!("agent.{name}")}]}}),
        &[],
    )
}

#[test]
fn placeholder_revisions_settle_as_repairable_feedback_then_accept_corrected_calls() {
    for placeholder in ["null", "undefined"] {
        let bad = json!({"path":"repair.txt","content":"first","expected_revision":placeholder});
        let prepared = plan("write_file", bad.clone(), 0);
        assert!(prepared.get("reject").is_none(), "{prepared}");
        let call = &prepared["calls"][0];
        assert_eq!(call["rejection"]["failure_code"], "E_AGENT_BAD_ARGUMENTS");
        assert_eq!(call["rejection"]["reason"], REASON);
        assert!(
            call["executor"].is_null(),
            "bad arguments must not reach filesystem preflight"
        );
        let preserved: Value =
            serde_json::from_str(call["arguments_json"].as_str().unwrap()).unwrap();
        assert_eq!(
            preserved, bad,
            "refusal must never rewrite a placeholder into create-only null"
        );
        let finished =
            tool_batch::prepare_finish(&json!({}), prepared["calls"].as_array().unwrap(), &[]);
        assert!(finished.get("reject").is_none(), "{finished}");
        let refused = &finished["prepared_calls"][0];
        assert_eq!(
            refused["rejection"]["failure_code"],
            "E_AGENT_BAD_ARGUMENTS"
        );
        assert_eq!(refused["rejection"]["reason"], REASON);
        assert_eq!(refused["reserved_write_bytes"], 0);
        assert!(refused["precondition"].is_null());

        // The next rounds of the same conversation can repair, read, and then
        // update using an opaque token returned by read_file. The native test
        // drives the corresponding actual filesystem operations.
        for (round, name, arguments) in [
            (
                1,
                "write_file",
                json!({"path":"repair.txt","content":"first","expected_revision":null}),
            ),
            (2, "read_file", json!({"path":"repair.txt"})),
            (
                3,
                "write_file",
                json!({"path":"repair.txt","content":"second","expected_revision":"16777235:48207435:6:1789625112:781234567"}),
            ),
        ] {
            let corrected = plan(name, arguments.clone(), round);
            assert!(corrected.get("reject").is_none(), "{corrected}");
            assert!(corrected["calls"][0]["rejection"].is_null(), "{corrected}");
            assert_eq!(corrected["calls"][0]["executor"], "workspace");
            assert_eq!(corrected["calls"][0]["arguments"], arguments);
        }
    }
}

#[test]
fn revision_strings_remain_opaque_and_historical_bad_arguments_remain_hashable() {
    for revision in [
        Value::Null,
        json!("16777235:48207435:6:1789625112:781234567"),
        json!("a-future-native-opaque-revision"),
    ] {
        let args = json!({"path":"a.txt","content":"x","expected_revision":revision});
        assert_eq!(
            tool_batch::tool_arguments_accepted(
                Some(&json!("write_file")),
                args.as_object().unwrap()
            ),
            Ok(())
        );
    }
    let name = json!("write_file");
    let absent = json!("{\"path\":\"a.txt\",\"content\":\"x\",\"expected_revision\":null}");
    let null_text = json!("{\"path\":\"a.txt\",\"content\":\"x\",\"expected_revision\":\"null\"}");
    let undefined_text =
        json!("{\"path\":\"a.txt\",\"content\":\"x\",\"expected_revision\":\"undefined\"}");
    let missing = json!("{\"path\":\"a.txt\",\"content\":\"x\"}");
    let hashes: Vec<_> = [absent, null_text, undefined_text, missing]
        .iter()
        .map(|args| schema::arguments_sha256(Some(&name), Some(args)).unwrap())
        .collect();
    for (index, hash) in hashes.iter().enumerate() {
        assert!(hashes[index + 1..].iter().all(|other| other != hash));
    }
}
