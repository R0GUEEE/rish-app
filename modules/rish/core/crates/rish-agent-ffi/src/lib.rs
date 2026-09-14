//! C ABI over `rish-agent-core`, in the same style as the rish runtime's
//! `rish-ffi`: UTF-8 JSON in with an explicit length, Rust-owned UTF-8 out,
//! released with [`rish_agent_string_free`]. Every entry point is safe to
//! call from any thread and never panics across the boundary.

use rish_agent_core::canonical::{canonical_json, hash_bytes, hash_json};
use rish_agent_core::ledger_ops::reduce_json as ledger_reduce_json;
use rish_agent_core::round_journal::reduce_json;
use rish_agent_core::strict_json::parse_arguments;
use std::ffi::CString;
use std::os::raw::c_char;
use std::slice;

/// Returns the JSON protocol version implemented by this library.
#[no_mangle]
pub extern "C" fn rish_agent_protocol_version() -> u32 {
    rish_agent_core::PROTOCOL_VERSION
}

/// Releases a string returned by any operation in this library.
///
/// # Safety
/// `value` must be null or a pointer previously returned by this library and
/// not yet freed.
#[no_mangle]
pub unsafe extern "C" fn rish_agent_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

unsafe fn input(pointer: *const c_char, length: usize) -> Option<&'static str> {
    if pointer.is_null() {
        return None;
    }
    std::str::from_utf8(slice::from_raw_parts(pointer.cast::<u8>(), length)).ok()
}

fn output(text: String) -> *mut c_char {
    CString::new(text)
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

/// Canonical JSON of the JSON text `input` (any JSON value). Returns null when
/// the text is not JSON or the value cannot be canonicalised.
///
/// # Safety
/// `pointer` must reference `length` readable bytes or be null.
#[no_mangle]
pub unsafe extern "C" fn rish_agent_canonical_json(
    pointer: *const c_char,
    length: usize,
) -> *mut c_char {
    let Some(text) = input(pointer, length) else {
        return std::ptr::null_mut();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return std::ptr::null_mut();
    };
    match canonical_json(&value) {
        Ok(bytes) => output(String::from_utf8(bytes).unwrap_or_default()),
        Err(_) => std::ptr::null_mut(),
    }
}

/// `DSHAgentHJ`: domain-separated SHA-256 of the canonical form of a JSON text.
///
/// # Safety
/// Both pointers must reference their stated lengths or be null.
#[no_mangle]
pub unsafe extern "C" fn rish_agent_hash_json(
    tag: *const c_char,
    tag_length: usize,
    pointer: *const c_char,
    length: usize,
) -> *mut c_char {
    let (Some(tag), Some(text)) = (input(tag, tag_length), input(pointer, length)) else {
        return std::ptr::null_mut();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return std::ptr::null_mut();
    };
    hash_json(tag, &value)
        .map(output)
        .unwrap_or(std::ptr::null_mut())
}

/// `DSHAgentHB`: domain-separated SHA-256 of raw bytes.
///
/// # Safety
/// Both pointers must reference their stated lengths or be null.
#[no_mangle]
pub unsafe extern "C" fn rish_agent_hash_bytes(
    tag: *const c_char,
    tag_length: usize,
    pointer: *const u8,
    length: usize,
) -> *mut c_char {
    let Some(tag) = input(tag, tag_length) else {
        return std::ptr::null_mut();
    };
    if pointer.is_null() && length != 0 {
        return std::ptr::null_mut();
    }
    let bytes = if length == 0 {
        &[][..]
    } else {
        slice::from_raw_parts(pointer, length)
    };
    hash_bytes(tag, bytes)
        .map(output)
        .unwrap_or(std::ptr::null_mut())
}

/// Returns the canonical form of tool arguments when the strict parser
/// accepts them, null otherwise (`DSHAgentParseArgumentsJSON`).
///
/// # Safety
/// `pointer` must reference `length` readable bytes or be null.
#[no_mangle]
pub unsafe extern "C" fn rish_agent_parse_arguments(
    pointer: *const c_char,
    length: usize,
) -> *mut c_char {
    let Some(text) = input(pointer, length) else {
        return std::ptr::null_mut();
    };
    let Some(object) = parse_arguments(text) else {
        return std::ptr::null_mut();
    };
    match canonical_json(&serde_json::Value::Object(object)) {
        Ok(bytes) => output(String::from_utf8(bytes).unwrap_or_default()),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Runs one schema-3 round-journal operation over the JSON envelope
/// documented on `rish_agent_core::round_journal::reduce_json`. Always returns
/// a JSON object (`ok` true or false); null only when `input` is not UTF-8.
///
/// # Safety
/// `pointer` must reference `length` readable bytes or be null.
#[no_mangle]
pub unsafe extern "C" fn rish_agent_round_reduce(
    pointer: *const c_char,
    length: usize,
) -> *mut c_char {
    let Some(text) = input(pointer, length) else {
        return std::ptr::null_mut();
    };
    output(reduce_json(text))
}

/// Runs one execution-ledger row operation over the JSON envelope documented
/// on `rish_agent_core::ledger_ops::reduce_json`. Always returns a JSON object
/// (`ok` true or false); null only when `input` is not UTF-8.
///
/// # Safety
/// `pointer` must reference `length` readable bytes or be null.
#[no_mangle]
pub unsafe extern "C" fn rish_agent_ledger_reduce(
    pointer: *const c_char,
    length: usize,
) -> *mut c_char {
    let Some(text) = input(pointer, length) else {
        return std::ptr::null_mut();
    };
    output(ledger_reduce_json(text))
}
