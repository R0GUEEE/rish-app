use super::*;

fn facts<'a>(thinking: &'a str) -> Facts<'a> {
    Facts {
        model_supported: true,
        requested_model: "deepseek-v4-flash",
        thinking_mode: thinking,
        fallback_call_id: "11111111-1111-4111-8111-111111111111",
    }
}

fn response(message: Value, finish: &str) -> Value {
    json!({
        "id": "resp-1", "model": "deepseek-v4-flash",
        "choices": [{ "message": message, "finish_reason": finish }],
    })
}

fn call(id: &str, name: &str, arguments: &str) -> Value {
    json!({ "id": id, "type": "function",
            "function": { "name": name, "arguments": arguments } })
}

#[test]
fn a_plain_answer_parses() {
    let parsed = parse(
        &response(json!({ "role": "assistant", "content": "hello" }), "stop"),
        &facts("off"),
    )
    .expect("parsed");
    assert_eq!(parsed["text"], json!("hello"));
    assert_eq!(parsed["tool_calls"], json!([]));
    assert_eq!(parsed["finish_reason"], json!("stop"));
}

#[test]
fn a_reply_must_be_for_the_model_that_was_asked() {
    let mut wrong = response(json!({ "role": "assistant", "content": "hi" }), "stop");
    wrong["model"] = json!("some-other-model");
    assert_eq!(parse(&wrong, &facts("off")), Err(MODEL_MISMATCH));
    let mut unknown = facts("off");
    unknown.model_supported = false;
    assert_eq!(
        parse(
            &response(json!({ "role": "assistant", "content": "hi" }), "stop"),
            &unknown
        ),
        Err(RESPONSE_MODEL)
    );
}

/// A reply cut off mid-argument can still be syntactically valid JSON.
/// Running it would run a call the model never finished writing.
#[test]
fn a_length_limited_reply_never_yields_an_executable_call() {
    let message = json!({
        "role": "assistant", "content": "", "reasoning_content": "r",
        "tool_calls": [call("c1", "read_file", "{\"path\":\"a\"}")],
    });
    assert_eq!(
        parse(&response(message, "length"), &facts("high")),
        Err(LENGTH)
    );
}

#[test]
fn the_finish_reason_and_the_calls_must_agree() {
    // Content stays a string here: a null content is only allowed for a
    // tool-only reply, so with "stop" it would fail as an empty response
    // before the finish relation is ever reached.
    let with_calls = json!({
        "role": "assistant", "content": "text", "reasoning_content": "r",
        "tool_calls": [call("c1", "read_file", "{\"path\":\"a\"}")],
    });
    assert_eq!(
        parse(&response(with_calls, "stop"), &facts("high")),
        Err(FINISH_RELATION)
    );
    let without = json!({ "role": "assistant", "content": "text" });
    assert_eq!(
        parse(&response(without, "tool_calls"), &facts("high")),
        Err(FINISH_RELATION)
    );
}

#[test]
fn a_tool_call_comes_with_the_reasoning_that_produced_it() {
    let message = json!({
        "role": "assistant", "content": null,
        "tool_calls": [call("c1", "read_file", "{\"path\":\"a\"}")],
    });
    assert_eq!(
        parse(&response(message.clone(), "tool_calls"), &facts("high")),
        Err(FINISH_RELATION)
    );
    // With thinking off there is nothing to show.
    assert!(parse(&response(message, "tool_calls"), &facts("off")).is_ok());
}

#[test]
fn two_calls_may_not_share_an_identifier() {
    let message = json!({
        "role": "assistant", "content": null, "reasoning_content": "r",
        "tool_calls": [
            call("c1", "read_file", "{\"path\":\"a\"}"),
            call("c1", "read_file", "{\"path\":\"b\"}"),
        ],
    });
    assert_eq!(
        parse(&response(message, "tool_calls"), &facts("high")),
        Err(TOOL_CALL_INVALID)
    );
}

#[test]
fn a_numbered_call_must_be_numbered_with_its_own_position() {
    let numbered = |index: u64| {
        json!({ "id": "c1", "type": "function", "index": index,
                "function": { "name": "read_file", "arguments": "{}" } })
    };
    let good = json!({
        "role": "assistant", "content": null, "reasoning_content": "r",
        "tool_calls": [numbered(0)],
    });
    assert!(parse(&response(good, "tool_calls"), &facts("high")).is_ok());
    let bad = json!({
        "role": "assistant", "content": null, "reasoning_content": "r",
        "tool_calls": [numbered(3)],
    });
    assert_eq!(
        parse(&response(bad, "tool_calls"), &facts("high")),
        Err(TOOL_CALL_INVALID)
    );
}

#[test]
fn an_omitted_revision_means_create_only_and_an_explicit_one_survives() {
    let parse_write = |arguments: &str| {
        let message = json!({
            "role": "assistant", "content": null, "reasoning_content": "r",
            "tool_calls": [call("c1", "write_file", arguments)],
        });
        parse(&response(message, "tool_calls"), &facts("high")).expect("parsed")["tool_calls"][0]
            ["arguments"]
            .as_str()
            .expect("arguments")
            .to_string()
    };
    assert_eq!(
        parse_write("{\"path\":\"a\",\"content\":\"b\"}"),
        "{\"content\":\"b\",\"expected_revision\":null,\"path\":\"a\"}"
    );
    // An explicit value, even a bad one, must reach tool preparation
    // rather than become a create request.
    let explicit = "{\"content\":\"b\",\"expected_revision\":\"oops\",\"path\":\"a\"}";
    assert_eq!(parse_write(explicit), explicit);
}

#[test]
fn a_call_described_in_prose_is_accepted_only_in_the_two_exact_shapes() {
    let prose = |text: &str| {
        parse(
            &response(json!({ "role": "assistant", "content": text }), "stop"),
            &facts("off"),
        )
    };
    let parsed = prose("{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}").expect("parsed");
    assert_eq!(parsed["finish_reason"], json!("tool_calls"));
    assert_eq!(parsed["tool_calls"][0]["name"], json!("read_file"));
    assert_eq!(parsed["tool_calls"][0]["id"], json!("compat:resp-1"));
    assert_eq!(parsed["text"], json!(""));
    // Ordinary prose that happens to be JSON stays prose.
    let plain = prose("{\"answer\":42}").expect("parsed");
    assert_eq!(plain["tool_calls"], json!([]));
    assert_eq!(plain["finish_reason"], json!("stop"));
    // A shape that is close but not exact stays prose too.
    let loose = prose("{\"name\":\"read_file\",\"arguments\":{},\"extra\":1}").expect("parsed");
    assert_eq!(loose["tool_calls"], json!([]));
}

#[test]
fn a_compatibility_id_falls_back_when_the_response_id_cannot_spell_one() {
    let mut reply = response(
        json!({ "role": "assistant",
                "content": "{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}" }),
        "stop",
    );
    // 128 bytes is the identifier bound; "compat:" pushes this past it.
    reply["id"] = json!("x".repeat(126));
    let parsed = parse(&reply, &facts("off")).expect("parsed");
    assert_eq!(
        parsed["tool_calls"][0]["id"],
        json!("compat:11111111-1111-4111-8111-111111111111")
    );
}

#[test]
fn a_reply_that_says_nothing_is_not_an_answer() {
    assert_eq!(
        parse(
            &response(json!({ "role": "assistant", "content": "   " }), "stop"),
            &facts("off")
        ),
        Err(FINISH_RELATION)
    );
}

#[test]
fn exactly_one_choice_is_one_turn() {
    let mut two = response(json!({ "role": "assistant", "content": "hi" }), "stop");
    two["choices"] = json!([
        { "message": { "role": "assistant", "content": "a" }, "finish_reason": "stop" },
        { "message": { "role": "assistant", "content": "b" }, "finish_reason": "stop" },
    ]);
    assert_eq!(parse(&two, &facts("off")), Err(EMPTY_RESPONSE));
}

fn envelope(response: Value, storage: Value) -> Value {
    json!({"op":"parse", "response":response, "requested_model":"deepseek-v4-flash",
        "model_supported":true, "thinking_mode":"off", "fallback_call_id":"fallback",
        "projection_contract":"foundation-json-v1", "call_index_storage":storage,
        "json_results":[]})
}

fn reduce(envelope: &Value) -> Value {
    serde_json::from_str(&reduce_json(&envelope.to_string())).unwrap()
}

#[test]
fn original_floating_storage_cannot_become_an_integer_through_host_json_encoding() {
    let mut call = call("c1", "read_file", "{}");
    call["index"] = json!(0); // Foundation has already re-encoded original 0.0.
    let response = response(
        json!({"role":"assistant", "content":null,
        "tool_calls":[call]}),
        "tool_calls",
    );
    for storage in ["floating", "boolean", "other", "missing"] {
        assert_eq!(
            reduce(&envelope(response.clone(), json!([storage])))["failure_code"],
            TOOL_CALL_INVALID
        );
    }
    assert_eq!(
        reduce(&envelope(response.clone(), json!(["signed"])))["ok"],
        true
    );
    for storage in [
        json!([]),
        json!(["signed", "signed"]),
        json!([true]),
        json!(["unknown"]),
    ] {
        assert_eq!(
            reduce(&envelope(response.clone(), storage))["failure_code"],
            RESPONSE_JSON
        );
    }
}

#[test]
fn index_position_is_checked_by_the_core_even_with_integer_storage() {
    let mut call = call("c1", "read_file", "{}");
    for index in [1, 15, 16, -1] {
        call["index"] = json!(index);
        let reply = response(
            json!({"role":"assistant", "content":null,
            "tool_calls":[call]}),
            "tool_calls",
        );
        assert_eq!(
            reduce(&envelope(reply, json!(["signed"])))["failure_code"],
            TOOL_CALL_INVALID
        );
    }
}

#[test]
fn foundation_zero_width_space_is_trimmed_for_empty_and_compatibility_responses() {
    assert_eq!(
        parse(
            &response(json!({"role":"assistant", "content":"\u{200b}"}), "stop"),
            &facts("off")
        ),
        Err(FINISH_RELATION)
    );
    let source = "\u{200b}{\"name\":\"read_file\",\"arguments\":{}}\u{200b}";
    let parsed = parse(
        &response(json!({"role":"assistant", "content":source}), "stop"),
        &facts("off"),
    )
    .unwrap();
    assert_eq!(parsed["finish_reason"], "tool_calls");
}

#[test]
fn empty_write_path_still_gets_create_only_default_before_tool_validation() {
    assert_eq!(
        normalize_create_only_write("write_file", &json!({"path":"", "content":""})),
        json!({"path":"", "content":"", "expected_revision":null})
    );
}

#[test]
fn host_writer_result_controls_exact_bytes_and_the_cap_without_changing_raw_arguments() {
    let source = "{\"name\":\"read_file\",\"arguments\":{\"path\":\"a/b\"}}";
    for count in [MAX_ARGUMENTS_BYTES, MAX_ARGUMENTS_BYTES + 1] {
        let mut input = envelope(
            response(json!({"role":"assistant", "content":source}), "stop"),
            json!([]),
        );
        let first = reduce(&input);
        assert_eq!(first["json_requests"].as_array().unwrap().len(), 1);
        assert_eq!(first["json_requests"][0]["op"], "decode");
        input["json_results"]
            .as_array_mut()
            .unwrap()
            .push(json!({"request":first["json_requests"][0],
            "value":serde_json::from_str::<Value>(source).unwrap()}));
        let second = reduce(&input);
        assert_eq!(second["json_requests"][0]["path"], "arguments");
        let projected = format!("{{\"path\":\"{}\\/\"}}", "a".repeat(count - 13));
        assert_eq!(projected.len(), count);
        input["json_results"]
            .as_array_mut()
            .unwrap()
            .push(json!({"request":second["json_requests"][0], "value":projected}));
        let final_reply = reduce(&input);
        assert_eq!(final_reply["ok"], true);
        let parsed = &final_reply["parsed"];
        if count == MAX_ARGUMENTS_BYTES {
            assert_eq!(parsed["tool_calls"][0]["arguments"], projected);
        } else {
            assert_eq!(parsed["tool_calls"], json!([]));
            assert_eq!(parsed["text"], source);
        }
    }
}

#[test]
fn malformed_projection_facts_do_not_fall_back_to_the_portable_writer() {
    let mut input = envelope(
        response(json!({"role":"assistant", "content":"hi"}), "stop"),
        json!([]),
    );
    for results in [
        json!({}),
        json!([{}]),
        json!([{"request":{"source":"hi"},"value":{}}]),
    ] {
        input["json_results"] = results;
        assert_eq!(reduce(&input)["failure_code"], RESPONSE_JSON);
    }
    input["json_results"] = json!([]);
    input["projection_contract"] = json!("unknown");
    assert_eq!(reduce(&input)["failure_code"], RESPONSE_JSON);
}
