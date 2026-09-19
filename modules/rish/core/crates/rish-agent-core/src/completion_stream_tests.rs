//! The cases a line-reading stream parser cannot be asked about.
//!
//! Every test here drives the reducer the way the host does -- bytes in,
//! state carried between calls -- so the chunk boundaries are part of what is
//! under test. `served` splits a transcript at every possible boundary and
//! insists the answer never depends on where the socket happened to break.

use super::*;

const HOST: &str = "chatcmpl-1";

fn envelope_chunk(state: &Value, bytes: &[u8]) -> Value {
    stream_chunk(&json!({
        "op": "stream_chunk",
        "state": state.clone(),
        "chunk_base64": encode_base64(bytes),
    }))
    .expect("the chunk was refused")
}

/// Feeds `pieces` in order and answers `(state, previews)`.
fn feed(pieces: &[&[u8]]) -> (Value, Vec<Value>) {
    let mut state = Value::Null;
    let mut previews = Vec::new();
    for piece in pieces {
        let answer = envelope_chunk(&state, piece);
        state = answer["state"].clone();
        previews.extend(answer["previews"].as_array().expect("previews").clone());
    }
    (state, previews)
}

fn assembled(state: &Value) -> Value {
    stream_finish(&json!({ "op": "stream_finish", "state": state.clone() }))
        .expect("the stream did not assemble")["response"]
        .clone()
}

fn message(response: &Value) -> Value {
    response["choices"][0]["message"].clone()
}

/// The transcript every test that does not care about framing uses.
fn transcript() -> String {
    [
        format!(
            "data: {{\"id\":\"{HOST}\",\"model\":\"deepseek-chat\",\
             \"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"Hello\"}}}}]}}\n\n"
        ),
        format!(
            "data: {{\"id\":\"{HOST}\",\"model\":\"deepseek-chat\",\
             \"choices\":[{{\"index\":0,\"delta\":{{\"content\":\" world\"}},\
             \"finish_reason\":\"stop\"}}]}}\n\n"
        ),
        "data: [DONE]\n\n".to_owned(),
    ]
    .concat()
}

/// The whole transcript in one piece, and the reply it describes.
#[test]
fn a_stream_becomes_the_reply_a_whole_response_would_be() {
    let (state, previews) = feed(&[transcript().as_bytes()]);
    assert_eq!(previews.len(), 2);
    assert_eq!(previews[0], json!({ "text": "Hello" }));
    assert_eq!(
        previews[1],
        json!({ "text": " world", "finish_reason": "stop" })
    );

    let response = assembled(&state);
    assert_eq!(response["id"], json!(HOST));
    assert_eq!(response["model"], json!("deepseek-chat"));
    assert_eq!(response["choices"][0]["finish_reason"], json!("stop"));
    assert_eq!(
        message(&response),
        json!({ "role": "assistant", "content": "Hello world", "reasoning_content": "" }),
    );
}

/// The reason this takes bytes: the same transcript cut at every offset --
/// mid-line, mid-token, mid-character -- has to give the same reply.
#[test]
fn where_the_socket_breaks_cannot_change_the_answer() {
    let bytes = transcript().into_bytes();
    let whole = assembled(&feed(&[&bytes]).0);
    for split in 1..bytes.len() {
        let (state, _) = feed(&[&bytes[..split], &bytes[split..]]);
        assert_eq!(
            assembled(&state),
            whole,
            "a split at {split} changed the reply"
        );
    }
}

/// A character split across a chunk boundary is one character, not two
/// replacement marks -- the bug a platform line reader hides.
#[test]
fn a_character_split_between_chunks_survives() {
    let line = format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"content\":\"你好\"}},\"finish_reason\":\"stop\"}}]}}\n\n"
    );
    let bytes = line.as_bytes();
    // "你" is three bytes; break inside it.
    let inside = line.find("你").expect("the character is there") + 1;
    let (state, previews) = feed(&[&bytes[..inside], &bytes[inside..]]);
    assert_eq!(previews[0]["text"], json!("你好"));
    assert_eq!(message(&assembled(&state))["content"], json!("你好"));
}

/// Several events in one chunk are several events.
#[test]
fn a_chunk_carrying_three_events_previews_three_times() {
    let mut wire = String::new();
    for piece in ["a", "b", "c"] {
        wire.push_str(&format!(
            "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
             {{\"content\":\"{piece}\"}}}}]}}\n\n"
        ));
    }
    let (_, previews) = feed(&[wire.as_bytes()]);
    assert_eq!(previews.len(), 3);
    assert_eq!(previews[2], json!({ "text": "c" }));
}

/// Arguments arrive a few characters at a time and are one string at the end.
#[test]
fn half_an_argument_is_not_an_argument_until_it_is_whole() {
    let mut wire = format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":{{\"tool_calls\":\
         [{{\"index\":0,\"id\":\"call_1\",\"function\":{{\"name\":\"read_file\",\
         \"arguments\":\"\"}}}}]}}}}]}}\n\n"
    );
    for piece in ["{\\\"path\\\"", ":\\\"a.txt", "\\\"}"] {
        wire.push_str(&format!(
            "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":{{\"tool_calls\":\
             [{{\"index\":0,\"function\":{{\"arguments\":\"{piece}\"}}}}]}}}}]}}\n\n"
        ));
    }
    wire.push_str(&format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":{{}},\
         \"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    ));

    let (state, previews) = feed(&[wire.as_bytes()]);
    // The first preview names the call; the ones after it carry only the
    // fragment that arrived, never the accumulation.
    assert_eq!(previews[0]["tool_calls"][0]["name"], json!("read_file"));
    assert_eq!(
        previews[1]["tool_calls"][0]["arguments"],
        json!("{\"path\"")
    );
    assert!(previews[1]["tool_calls"][0].get("name").is_none());

    let calls = message(&assembled(&state))["tool_calls"].clone();
    assert_eq!(
        calls,
        json!([{
            "id": "call_1",
            "type": "function",
            "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" },
        }]),
    );
}

/// Two calls whose fragments interleave stay two calls, in index order, even
/// though the wire put the second one first.
#[test]
fn interleaved_tool_calls_are_kept_apart_and_ordered() {
    let mut wire = String::new();
    for (slot, identifier, name, piece) in [
        (1, "call_b", "write_file", "{\"b\""),
        (0, "call_a", "read_file", "{\"a\""),
        (1, "", "", ":2}"),
        (0, "", "", ":1}"),
    ] {
        let function = if name.is_empty() {
            format!("{{\"arguments\":\"{}\"}}", piece.replace('"', "\\\""))
        } else {
            format!(
                "{{\"name\":\"{name}\",\"arguments\":\"{}\"}}",
                piece.replace('"', "\\\"")
            )
        };
        let identifier = if identifier.is_empty() {
            String::new()
        } else {
            format!("\"id\":\"{identifier}\",")
        };
        wire.push_str(&format!(
            "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":{{\"tool_calls\":\
             [{{\"index\":{slot},{identifier}\"function\":{function}}}]}}}}]}}\n\n"
        ));
    }
    wire.push_str(&format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":{{}},\
         \"finish_reason\":\"tool_calls\"}}]}}\n\n"
    ));

    let (state, _) = feed(&[wire.as_bytes()]);
    let calls = message(&assembled(&state))["tool_calls"].clone();
    assert_eq!(calls.as_array().expect("two calls").len(), 2);
    assert_eq!(calls[0]["id"], json!("call_a"));
    assert_eq!(calls[0]["function"]["arguments"], json!("{\"a\":1}"));
    assert_eq!(calls[1]["id"], json!("call_b"));
    assert_eq!(calls[1]["function"]["arguments"], json!("{\"b\":2}"));
}

/// A tool-call fragment this cannot place is the end of the stream, not a
/// fragment to skip: what it describes is a call a person would approve.
#[test]
fn an_unplaceable_tool_call_fragment_ends_the_stream() {
    let refused = |fragments: &str| {
        let wire = format!(
            "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
             {{\"tool_calls\":{fragments}}}}}]}}\n\n"
        );
        stream_chunk(&json!({
            "state": Value::Null,
            "chunk_base64": encode_base64(wire.as_bytes()),
        }))
    };
    // No index at all: nothing says which of two interleaved calls this is.
    assert_eq!(
        refused("[{\"id\":\"a\",\"function\":{\"name\":\"one\"}}]"),
        Err("E_COMPLETION_RESPONSE_JSON"),
    );
    // An index no reply could have, and one that is not a whole number.
    assert_eq!(refused("[{\"index\":16}]"), Err("E_COMPLETION_RESPONSE_JSON"));
    assert_eq!(refused("[{\"index\":-1}]"), Err("E_COMPLETION_RESPONSE_JSON"));
    assert_eq!(refused("[{\"index\":\"0\"}]"), Err("E_COMPLETION_RESPONSE_JSON"));
    // A fragment that is not an object, and a list that is not one either.
    assert_eq!(refused("[7]"), Err("E_COMPLETION_RESPONSE_JSON"));
    assert_eq!(refused("{\"index\":0}"), Err("E_COMPLETION_RESPONSE_JSON"));
    // More calls than a reply may ask for.
    let many: Vec<String> = (0..17).map(|slot| format!("{{\"index\":{slot}}}")).collect();
    assert_eq!(
        refused(&format!("[{}]", many.join(","))),
        Err("E_COMPLETION_RESPONSE_JSON"),
    );
    // A null list is a provider saying there are none, which is not a fault.
    assert!(refused("null").is_ok());
}

/// One line may not grow without end either, whether or not the stream has.
#[test]
fn a_line_past_the_line_cap_is_refused() {
    let mut line = b"data: ".to_vec();
    line.extend(std::iter::repeat_n(b'x', 256 * 1024));
    assert_eq!(
        stream_chunk(&json!({
            "state": Value::Null,
            "chunk_base64": encode_base64(&line),
        })),
        Err("E_COMPLETION_RESPONSE_SIZE"),
    );
}

/// Reasoning is kept apart from the answer, both while it streams and after.
#[test]
fn reasoning_is_its_own_channel() {
    let wire = format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"reasoning_content\":\"think\"}}}}]}}\n\n\
         data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"content\":\"say\"}},\"finish_reason\":\"stop\"}}]}}\n\n"
    );
    let (state, previews) = feed(&[wire.as_bytes()]);
    assert_eq!(previews[0], json!({ "reasoning": "think" }));
    assert_eq!(
        message(&assembled(&state)),
        json!({ "role": "assistant", "content": "say", "reasoning_content": "think" }),
    );
}

/// Framing this parser must step over: comments, keep-alives, blank data,
/// event names, CRLF line ends, and a chunk that says nothing to show.
#[test]
fn framing_that_is_not_an_event_shows_nothing() {
    let wire = format!(
        ": ping\r\n\
         event: message\r\n\
         data:\r\n\
         data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"usage\":{{\"total_tokens\":3}},\
         \"choices\":[{{\"delta\":{{}}}}]}}\r\n\r\n\
         data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"content\":\"x\"}},\"finish_reason\":\"stop\"}}]}}\r\n\r\n"
    );
    let (state, previews) = feed(&[wire.as_bytes()]);
    assert_eq!(
        previews.len(),
        1,
        "only the chunk with something in it: {previews:?}"
    );
    assert_eq!(previews[0], json!({ "text": "x", "finish_reason": "stop" }));
    assert_eq!(message(&assembled(&state))["content"], json!("x"));
}

/// A finish reason spelled as the string "null" is a provider saying "not
/// yet", and a stream that only ever said that has not finished.
#[test]
fn a_finish_reason_of_null_is_not_a_reason() {
    let wire = format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"content\":\"x\"}},\"finish_reason\":\"null\"}}]}}\n\n"
    );
    let (state, previews) = feed(&[wire.as_bytes()]);
    assert_eq!(previews[0], json!({ "text": "x" }));
    assert_eq!(
        stream_finish(&json!({ "state": state })),
        Err("E_COMPLETION_RESPONSE_JSON"),
    );
}

/// Everything after the terminator is noise, and saying it twice is not an
/// error -- but neither may it add to the reply.
#[test]
fn a_repeated_terminator_adds_nothing() {
    let wire = format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"content\":\"x\"}},\"finish_reason\":\"stop\"}}]}}\n\n\
         data: [DONE]\n\n\
         data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"content\":\"after\"}}}}]}}\n\n\
         data: [DONE]\n\n"
    );
    let (state, previews) = feed(&[wire.as_bytes()]);
    assert_eq!(previews.len(), 1);
    assert_eq!(message(&assembled(&state))["content"], json!("x"));
}

/// A stream that stops in the middle of a line is a stream that did not say
/// what it was: the half-line is never parsed, and there is no reply.
#[test]
fn a_stream_cut_short_has_no_reply() {
    let wire = format!(
        "data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choices\":[{{\"delta\":\
         {{\"content\":\"x\"}}}}]}}\n\n\
         data: {{\"id\":\"{HOST}\",\"model\":\"m\",\"choi"
    );
    let (state, previews) = feed(&[wire.as_bytes()]);
    assert_eq!(previews.len(), 1);
    assert_eq!(
        stream_finish(&json!({ "state": state })),
        Err("E_COMPLETION_RESPONSE_JSON"),
    );
}

/// A `data:` line that is not JSON is the reply being unreadable, not an
/// event to skip.
#[test]
fn a_data_line_that_is_not_json_fails_the_stream() {
    let answer = stream_chunk(&json!({
        "state": Value::Null,
        "chunk_base64": encode_base64(b"data: {not json}\n\n"),
    }));
    assert_eq!(answer, Err("E_COMPLETION_RESPONSE_JSON"));
}

/// Past four mebibytes a stream is not a reply, counted across chunks even
/// when every line in it was short enough on its own.
#[test]
fn a_stream_past_the_cap_is_refused() {
    let mut state = Value::Null;
    // Comment lines: read and discarded, so nothing accumulates but the count.
    let filler: Vec<u8> = ": keep-alive\n".repeat(32 * 1024).into_bytes();
    let mut sent = 0u64;
    while sent + filler.len() as u64 <= 4 * 1024 * 1024 {
        state = envelope_chunk(&state, &filler)["state"].clone();
        sent += filler.len() as u64;
    }
    // Whatever is left under the cap, and then one byte past it.
    let remainder = vec![b'\n'; (4 * 1024 * 1024 - sent) as usize];
    state = envelope_chunk(&state, &remainder)["state"].clone();
    assert_eq!(
        stream_chunk(&json!({ "state": state, "chunk_base64": encode_base64(b"x") })),
        Err("E_COMPLETION_RESPONSE_SIZE"),
    );
}

/// A line that never ends is refused rather than carried without limit, and
/// it is refused on the chunk that passes the cap, not at the end.
#[test]
fn a_line_that_never_ends_is_refused() {
    let mut state = Value::Null;
    let filler = vec![b'x'; 64 * 1024];
    for _ in 0..8 {
        let answer = stream_chunk(&json!({
            "state": state.clone(),
            "chunk_base64": encode_base64(&filler),
        }));
        match answer {
            Ok(next) => state = next["state"].clone(),
            Err(code) => {
                assert_eq!(code, "E_COMPLETION_RESPONSE_SIZE");
                return;
            }
        }
    }
    panic!("an unbounded line was carried");
}

/// The state crosses the bridge as JSON, so what comes back has to be what
/// went out -- including a carry that is half a character.
#[test]
fn the_carried_state_survives_a_round_trip_through_json() {
    let bytes = transcript().into_bytes();
    let head = transcript().find("world").expect("mid-line") + 2;
    let mut state = envelope_chunk(&Value::Null, &bytes[..head])["state"].clone();
    let text = serde_json::to_string(&state).expect("the state is JSON");
    state = serde_json::from_str(&text).expect("and reads back");
    let state = envelope_chunk(&state, &bytes[head..])["state"].clone();
    assert_eq!(message(&assembled(&state))["content"], json!("Hello world"));
}

/// The op the host calls, refused the way the dispatcher refuses.
#[test]
fn a_chunk_without_bytes_is_a_bad_request() {
    assert_eq!(
        stream_chunk(&json!({ "op": "stream_chunk" })),
        Err("E_COMPLETION_RESPONSE_JSON"),
    );
    assert_eq!(
        stream_chunk(&json!({ "op": "stream_chunk", "chunk_base64": "not base64!" })),
        Err("E_COMPLETION_RESPONSE_JSON"),
    );
    assert_eq!(
        stream_chunk(&json!({ "op": "stream_chunk", "state": 7, "chunk_base64": "" })),
        Err("E_COMPLETION_RESPONSE_JSON"),
    );
}

/// The base64 that carries the bytes, over the cases that break a hand-rolled
/// one: every length modulo three, and every byte value.
#[test]
fn base64_round_trips_every_byte_and_every_length() {
    for length in 0..=48usize {
        let bytes: Vec<u8> = (0..length).map(|index| (index * 7 % 256) as u8).collect();
        let text = encode_base64(&bytes);
        assert_eq!(text.len() % 4, 0, "length {length} is not padded");
        assert_eq!(decode_base64(&text).as_deref(), Some(bytes.as_slice()));
    }
    let every: Vec<u8> = (0..=255u8).collect();
    assert_eq!(
        decode_base64(&encode_base64(&every)).as_deref(),
        Some(every.as_slice())
    );
    assert_eq!(decode_base64("!!!!"), None);
    // Padding bits that are not zero are not a base64 text this wrote.
    assert_eq!(decode_base64("AB"), None);
}
