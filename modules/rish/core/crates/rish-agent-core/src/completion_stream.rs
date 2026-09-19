//! Turning a streamed completion into the reply a non-streamed one would be.
//!
//! Both hosts had their own copy of this: iOS in `DSHStreamEvents.mm`,
//! Android in `AndroidModelTransport`. Android's leaned on a platform line
//! reader, which hid the cases that actually break a stream parser -- a
//! multi-byte character split across two chunks, a `data:` line arriving in
//! three pieces, two events in one read.
//!
//! So this takes bytes, not lines. The host hands over whatever the socket
//! gave it and carries an opaque state between calls; only complete lines are
//! decoded, so a chunk boundary can fall anywhere, including inside a
//! character. What comes out at the end is the *non-streaming* response
//! shape, which means everything downstream -- the validation in
//! [`crate::completion_response::parse`], the digests, the receipt -- is the
//! same code for a streamed reply as for a whole one.
//!
//! Where the two hosts disagreed, this keeps the stricter rule, so that
//! adopting it can only narrow what a provider gets away with: iOS's caps on
//! a line and on a tool-call fragment, and Android's refusal to read the
//! literal string `"null"` as a finish reason.
//!
//! One deliberate narrowing. SSE lets one event carry several `data:` lines,
//! joined by newlines, and iOS accumulated them until a blank line; here each
//! `data:` line is its own event, which is what Android did and what every
//! provider this app speaks to actually sends. A provider that split a chunk
//! across `data:` lines would fail as unreadable JSON rather than be misread,
//! so the narrowing fails closed and says so.

use serde_json::{json, Map, Value};

/// Beyond this a stream is not a reply any more.
const MAX_STREAM_BYTES: u64 = 4 * 1024 * 1024;
/// One line of it, from `DSHStreamMaxLineBytes`.
const MAX_LINE_BYTES: usize = 256 * 1024;
/// How many calls one reply may ask for, from the non-streaming parser.
const MAX_TOOL_CALLS: usize = 16;

const RESPONSE_JSON: &str = "E_COMPLETION_RESPONSE_JSON";
const RESPONSE_SIZE: &str = "E_COMPLETION_RESPONSE_SIZE";

/// The state the host carries between chunks. Opaque to it; plain JSON here
/// so a stuck stream can be read in a log.
struct Stream {
    carry: Vec<u8>,
    id: Option<String>,
    model: Option<String>,
    finish: Option<String>,
    text: String,
    reasoning: String,
    calls: Vec<Call>,
    done: bool,
    bytes: u64,
}

struct Call {
    index: i64,
    id: String,
    name: String,
    arguments: String,
}

impl Stream {
    fn new() -> Self {
        Stream {
            carry: Vec::new(),
            id: None,
            model: None,
            finish: None,
            text: String::new(),
            reasoning: String::new(),
            calls: Vec::new(),
            done: false,
            bytes: 0,
        }
    }

    fn from_value(value: Option<&Value>) -> Result<Self, &'static str> {
        let Some(value) = value else {
            return Ok(Stream::new());
        };
        if value.is_null() {
            return Ok(Stream::new());
        }
        let map = value.as_object().ok_or(RESPONSE_JSON)?;
        let text_at = |key: &str| -> Option<String> {
            map.get(key).and_then(Value::as_str).map(str::to_owned)
        };
        let calls = match map.get("calls") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    Ok(Call {
                        index: item
                            .get("index")
                            .and_then(Value::as_i64)
                            .ok_or(RESPONSE_JSON)?,
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        arguments: item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    })
                })
                .collect::<Result<Vec<Call>, &'static str>>()?,
            Some(_) => return Err(RESPONSE_JSON),
        };
        Ok(Stream {
            carry: decode_base64(
                map.get("carry_base64")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )
            .ok_or(RESPONSE_JSON)?,
            id: text_at("id"),
            model: text_at("model"),
            finish: text_at("finish_reason"),
            text: text_at("text").unwrap_or_default(),
            reasoning: text_at("reasoning").unwrap_or_default(),
            calls,
            done: map.get("done") == Some(&Value::Bool(true)),
            bytes: map.get("bytes").and_then(Value::as_u64).unwrap_or(0),
        })
    }

    fn to_value(&self) -> Value {
        json!({
            "schema_version": 1,
            "carry_base64": encode_base64(&self.carry),
            "id": self.id,
            "model": self.model,
            "finish_reason": self.finish,
            "text": self.text,
            "reasoning": self.reasoning,
            "calls": self.calls.iter().map(|call| json!({
                "index": call.index,
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments,
            })).collect::<Vec<Value>>(),
            "done": self.done,
            "bytes": self.bytes,
        })
    }

    fn call_at(&mut self, index: i64) -> &mut Call {
        if let Some(position) = self.calls.iter().position(|call| call.index == index) {
            return &mut self.calls[position];
        }
        self.calls.push(Call {
            index,
            id: String::new(),
            name: String::new(),
            arguments: String::new(),
        });
        let last = self.calls.len() - 1;
        &mut self.calls[last]
    }
}

/// Feeds one chunk in and answers the previews it produced.
fn chunk(state: &mut Stream, bytes: &[u8]) -> Result<Vec<Value>, &'static str> {
    // The cap is on the whole stream, which is also what bounds the carry: a
    // line that never ends is carried undecoded, and reaches this first.
    state.bytes = state.bytes.saturating_add(bytes.len() as u64);
    if state.bytes > MAX_STREAM_BYTES {
        return Err(RESPONSE_SIZE);
    }
    state.carry.extend_from_slice(bytes);
    let mut previews = Vec::new();
    loop {
        let Some(position) = state.carry.iter().position(|byte| *byte == b'\n') else {
            // A line that is still arriving is bounded too: it is carried
            // undecoded, and a provider with no newline in a quarter of a
            // mebibyte is not sending events.
            if state.carry.len() > MAX_LINE_BYTES {
                return Err(RESPONSE_SIZE);
            }
            break;
        };
        if position > MAX_LINE_BYTES {
            return Err(RESPONSE_SIZE);
        }
        let line: Vec<u8> = state.carry.drain(..=position).collect();
        // The newline, and a carriage return before it, belong to the framing
        // rather than to the payload.
        let mut end = line.len() - 1;
        if end > 0 && line[end - 1] == b'\r' {
            end -= 1;
        }
        if let Some(event) = line_event(state, &line[..end])? {
            previews.push(event);
        }
    }
    Ok(previews)
}

/// One complete line, which may be a comment, a keep-alive, or an event.
fn line_event(state: &mut Stream, line: &[u8]) -> Result<Option<Value>, &'static str> {
    // Anything that is not valid UTF-8 cannot be a `data:` line; a stream
    // that carries such bytes is not one this reads.
    let Ok(line) = std::str::from_utf8(line) else {
        return Err(RESPONSE_JSON);
    };
    let Some(payload) = line.strip_prefix("data:") else {
        return Ok(None);
    };
    let payload = payload.trim();
    if payload.is_empty() {
        return Ok(None);
    }
    if payload == "[DONE]" {
        state.done = true;
        return Ok(None);
    }
    // Everything after the terminator is noise, not a continuation.
    if state.done {
        return Ok(None);
    }
    let decoded: Value = serde_json::from_str(payload).map_err(|_| RESPONSE_JSON)?;
    let Some(object) = decoded.as_object() else {
        return Err(RESPONSE_JSON);
    };
    if state.id.is_none() {
        state.id = non_empty(object.get("id"));
    }
    if state.model.is_none() {
        state.model = non_empty(object.get("model"));
    }
    let Some(choice) = object
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    // A finish reason spelled as the string "null" is how some providers say
    // "not yet"; it is not a reason.
    if let Some(reason) = non_empty(choice.get("finish_reason")) {
        if reason != "null" {
            state.finish = Some(reason);
        }
    }
    let empty = Map::new();
    let delta = choice
        .get("delta")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut event = Map::new();
    if let Some(piece) = non_empty(delta.get("content")) {
        state.text.push_str(&piece);
        event.insert("text".into(), Value::String(piece));
    }
    if let Some(piece) = non_empty(delta.get("reasoning_content")) {
        state.reasoning.push_str(&piece);
        event.insert("reasoning".into(), Value::String(piece));
    }
    // A tool-call fragment this cannot read is not a fragment to skip: what
    // it describes is a call a person would be asked to approve, so an
    // unusable one ends the stream.
    let fragments = match delta.get("tool_calls") {
        None | Some(Value::Null) => &Vec::new()[..],
        Some(Value::Array(fragments)) if fragments.len() <= MAX_TOOL_CALLS => &fragments[..],
        Some(_) => return Err(RESPONSE_JSON),
    };
    {
        let mut previewed = Vec::new();
        for fragment in fragments {
            let Some(fragment) = fragment.as_object() else {
                return Err(RESPONSE_JSON);
            };
            // The index is what keeps two interleaved calls apart, so a
            // fragment without a usable one cannot be placed at all.
            let slot = match fragment.get("index").and_then(Value::as_i64) {
                Some(slot) if (0..MAX_TOOL_CALLS as i64).contains(&slot) => slot,
                _ => return Err(RESPONSE_JSON),
            };
            let mut preview = Map::new();
            preview.insert("index".into(), json!(slot));
            let identifier = non_empty(fragment.get("id"));
            let function = fragment.get("function").and_then(Value::as_object);
            let name = function.and_then(|function| non_empty(function.get("name")));
            let arguments = function.and_then(|function| non_empty(function.get("arguments")));
            let call = state.call_at(slot);
            if let Some(identifier) = identifier {
                call.id = identifier.clone();
                preview.insert("id".into(), Value::String(identifier));
            }
            if let Some(name) = name {
                call.name = name.clone();
                preview.insert("name".into(), Value::String(name));
            }
            if let Some(arguments) = arguments {
                call.arguments.push_str(&arguments);
                preview.insert("arguments".into(), Value::String(arguments));
            }
            previewed.push(Value::Object(preview));
        }
        if !previewed.is_empty() {
            event.insert("tool_calls".into(), Value::Array(previewed));
        }
    }
    if let Some(reason) = state.finish.clone() {
        event.insert("finish_reason".into(), Value::String(reason));
    }
    // A keep-alive, or a chunk carrying only usage, is nothing to show.
    Ok(if event.is_empty() {
        None
    } else {
        Some(Value::Object(event))
    })
}

/// The reply the stream described, in the shape a whole response arrives in.
fn finish(state: &Stream) -> Result<Value, &'static str> {
    let (Some(id), Some(model), Some(finish)) =
        (state.id.clone(), state.model.clone(), state.finish.clone())
    else {
        // A stream that stopped before it said what it was is not a reply.
        return Err(RESPONSE_JSON);
    };
    let mut message = Map::new();
    message.insert("role".into(), json!("assistant"));
    message.insert("content".into(), Value::String(state.text.clone()));
    message.insert(
        "reasoning_content".into(),
        Value::String(state.reasoning.clone()),
    );
    if !state.calls.is_empty() {
        let mut calls: Vec<&Call> = state.calls.iter().collect();
        // The wire may interleave fragments; the batch is ordered by index,
        // because that is the order the model asked for.
        calls.sort_by_key(|call| call.index);
        message.insert(
            "tool_calls".into(),
            Value::Array(
                calls
                    .into_iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.arguments },
                        })
                    })
                    .collect(),
            ),
        );
    }
    Ok(json!({
        "id": id,
        "model": model,
        "choices": [{ "index": 0, "message": Value::Object(message), "finish_reason": finish }],
    }))
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(text) if !text.is_empty() => Some(text.to_owned()),
        _ => None,
    }
}

/// `{"op":"stream_chunk","state":<state|null>,"chunk_base64":"..."}`
pub fn stream_chunk(envelope: &Value) -> Result<Value, &'static str> {
    let mut state = Stream::from_value(envelope.get("state"))?;
    let bytes = decode_base64(
        envelope
            .get("chunk_base64")
            .and_then(Value::as_str)
            .ok_or(RESPONSE_JSON)?,
    )
    .ok_or(RESPONSE_JSON)?;
    let previews = chunk(&mut state, &bytes)?;
    Ok(json!({ "ok": true, "state": state.to_value(), "previews": previews }))
}

/// `{"op":"stream_finish","state":<state>}`
pub fn stream_finish(envelope: &Value) -> Result<Value, &'static str> {
    let state = Stream::from_value(envelope.get("state"))?;
    Ok(json!({ "ok": true, "response": finish(&state)? }))
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64 without a dependency: chunks cross this boundary as text, and this
/// is the whole of what that costs.
fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let b0 = group[0] as u32;
        let b1 = *group.get(1).unwrap_or(&0) as u32;
        let b2 = *group.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if group.len() > 2 {
            ALPHABET[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let trimmed = text.trim_end_matches('=');
    let mut out = Vec::with_capacity(trimmed.len() / 4 * 3);
    let mut accumulator: u32 = 0;
    let mut held = 0;
    for byte in trimmed.bytes() {
        let value = ALPHABET.iter().position(|candidate| *candidate == byte)? as u32;
        accumulator = (accumulator << 6) | value;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push(((accumulator >> held) & 0xff) as u8);
        }
    }
    // Whatever is left over must be padding bits, and padding is zero.
    if accumulator & ((1 << held) - 1) != 0 {
        return None;
    }
    Some(out)
}

#[cfg(test)]
#[path = "completion_stream_tests.rs"]
mod tests;
