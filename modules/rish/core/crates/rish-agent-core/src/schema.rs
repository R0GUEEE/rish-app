//! Exact bounded primitive validators shared by the typed views, ported from
//! the `DSHAgent*` helpers in `AgentNativeWAL.mm`. They never normalise:
//! invalid identifiers, numbers and strings reject rather than round.
//!
//! Inputs are `serde_json::Value`s parsed from canonical JSON the host
//! produced, so numbers arrive as integer lexemes whenever the host held an
//! integral NSNumber; a fractional lexeme therefore never denotes an integer.

use serde_json::{Map, Value};

/// Largest integer the bridge carries exactly (2^53 - 1).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Whether `value` is present and JSON `null` (Foundation `NSNull`).
pub fn is_null(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null))
}

/// `DSHAgentCanonicalUUID`: 36 characters, lowercase hex, 8-4-4-4-12.
pub fn canonical_uuid(value: Option<&Value>) -> bool {
    let Some(Value::String(text)) = value else {
        return false;
    };
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
    })
}

/// `DSHAgentCanonicalSHA256`: 64 lowercase hex characters.
pub fn canonical_sha256(value: Option<&Value>) -> bool {
    let Some(Value::String(text)) = value else {
        return false;
    };
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `DSHAgentSafeInteger`: a non-boolean integral number in `0..=maximum`
/// (and never above 2^53 - 1); zero only when `allow_zero`. Returns the value.
pub fn safe_integer(value: Option<&Value>, maximum: u64, allow_zero: bool) -> Option<u64> {
    let Some(Value::Number(number)) = value else {
        return None;
    };
    let integer = number.as_u64()?;
    if integer > maximum || integer > MAX_SAFE_INTEGER || (!allow_zero && integer == 0) {
        return None;
    }
    Some(integer)
}

/// `DSHAgentBoundedUTF8String`: a string of at most `maximum_bytes` UTF-8
/// bytes, non-empty unless `allow_empty`.
pub fn bounded_utf8(
    value: Option<&Value>,
    maximum_bytes: usize,
    allow_empty: bool,
) -> Option<&str> {
    let Some(Value::String(text)) = value else {
        return None;
    };
    if (!allow_empty && text.is_empty()) || text.len() > maximum_bytes {
        return None;
    }
    Some(text)
}

/// `DSHAgentCanonicalTimestamp`: exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` naming a
/// real UTC instant, which is what the ISO 8601 round trip on the ObjC side
/// enforces (no month 13, no 30 February, no leap second).
pub fn canonical_timestamp(value: Option<&Value>) -> bool {
    let Some(Value::String(text)) = value else {
        return false;
    };
    let bytes = text.as_bytes();
    if bytes.len() != 24 {
        return false;
    }
    const LAYOUT: &[u8] = b"dddd-dd-ddTdd:dd:dd.dddZ";
    for (byte, expected) in bytes.iter().zip(LAYOUT) {
        let ok = match expected {
            b'd' => byte.is_ascii_digit(),
            other => byte == other,
        };
        if !ok {
            return false;
        }
    }
    let field = |range: std::ops::Range<usize>| -> u32 { text[range].parse().expect("digits") };
    let (year, month, day) = (field(0..4), field(5..7), field(8..10));
    let (hour, minute, second) = (field(11..13), field(14..16), field(17..19));
    if year == 0 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if leap {
                29
            } else {
                28
            }
        }
    };
    (1..=days_in_month).contains(&day)
}

/// `DSHAgentFailureCode`: the closed, value-free failure-code union.
pub fn failure_code(value: Option<&Value>) -> bool {
    const CODES: &[&str] = &[
        "E_AGENT_UNKNOWN_TOOL",
        "E_AGENT_BAD_ARGUMENTS",
        "E_AGENT_BAD_PATH",
        "E_AGENT_NO_ROOT",
        "E_AGENT_ROOT_STALE",
        "E_AGENT_CAPABILITY",
        "E_AGENT_APPROVAL",
        "E_AGENT_TRANSCRIPT",
        "E_AGENT_LEDGER",
        "E_AGENT_ROUND_AMBIGUOUS",
        "E_AGENT_EXECUTION_AMBIGUOUS",
        "E_AGENT_RETRY_LINEAGE",
        "E_AGENT_PERSISTENCE",
        "E_AGENT_CONFLICT",
        "E_AGENT_ROUND_LIMIT",
        "E_AGENT_CANCELLED",
        "E_AGENT_TOOL_FAILED",
        "E_AGENT_NATIVE",
        "E_AGENT_NOT_FOUND",
        "E_AGENT_CAPACITY",
        "E_COMPLETION_LENGTH",
        "E_COMPLETION_CONTENT_FILTER",
        "E_AGENT_DENIED_BY_USER",
    ];
    match bounded_utf8(value, 128, false) {
        Some(code) => CODES.contains(&code),
        None => false,
    }
}

/// `DSHAgentExactDictionaryKeys`: an object with exactly these keys.
pub fn exact_keys<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let Some(Value::Object(map)) = value else {
        return None;
    };
    if map.len() != keys.len() || !map.keys().all(|key| keys.contains(&key.as_str())) {
        return None;
    }
    Some(map)
}

/// `DSHAgentExactDictionaryKeysWithOptional`: every required key present,
/// no key outside required ∪ optional.
pub fn exact_keys_with_optional<'a>(
    value: Option<&'a Value>,
    keys: &[&str],
    optional: &[&str],
) -> Option<&'a Map<String, Value>> {
    let Some(Value::Object(map)) = value else {
        return None;
    };
    if !map
        .keys()
        .all(|key| keys.contains(&key.as_str()) || optional.contains(&key.as_str()))
    {
        return None;
    }
    if !keys.iter().all(|key| map.contains_key(*key)) {
        return None;
    }
    Some(map)
}

/// `DSHAgentOpaqueIdentifier`: 1..=128 bytes of `[A-Za-z0-9._:-]`.
pub fn opaque_identifier(value: Option<&Value>) -> bool {
    match bounded_utf8(value, 128, false) {
        Some(text) => text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')),
        None => false,
    }
}

/// `DSHAgentToolNameWellFormed`: 1..=64 bytes of `[A-Za-z0-9_-]`.
pub fn tool_name_well_formed(value: Option<&Value>) -> Option<&str> {
    let text = bounded_utf8(value, 64, false)?;
    text.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        .then_some(text)
}

/// `DSHAgentArgumentsSHA256`: HJ(tool-arguments, {name, arguments}) over a
/// well-formed name and parseable arguments; `None` when either refuses.
pub fn arguments_sha256(name: Option<&Value>, arguments_json: Option<&Value>) -> Option<String> {
    let tool_name = tool_name_well_formed(name)?;
    let Some(Value::String(text)) = arguments_json else {
        return None;
    };
    let arguments = crate::strict_json::parse_arguments(text)?;
    let mut identity = Map::new();
    identity.insert("name".to_string(), Value::String(tool_name.to_string()));
    identity.insert("arguments".to_string(), Value::Object(arguments));
    crate::canonical::hash_json("tool-arguments", &Value::Object(identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timestamps_must_name_real_instants() {
        let ok = json!("2023-11-14T22:13:20.000Z");
        let feb30 = json!("2023-02-30T00:00:00.000Z");
        let leap_ok = json!("2024-02-29T00:00:00.000Z");
        let leap_no = json!("2023-02-29T00:00:00.000Z");
        let leap_second = json!("2023-06-30T23:59:60.000Z");
        let short = json!("2023-11-14T22:13:20Z");
        assert!(canonical_timestamp(Some(&ok)));
        assert!(!canonical_timestamp(Some(&feb30)));
        assert!(canonical_timestamp(Some(&leap_ok)));
        assert!(!canonical_timestamp(Some(&leap_no)));
        assert!(!canonical_timestamp(Some(&leap_second)));
        assert!(!canonical_timestamp(Some(&short)));
    }

    #[test]
    fn identifiers_are_lowercase_and_bounded() {
        assert!(canonical_uuid(Some(&json!(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ))));
        assert!(!canonical_uuid(Some(&json!(
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
        ))));
        assert!(canonical_sha256(Some(&json!("a".repeat(64)))));
        assert!(!canonical_sha256(Some(&json!("A".repeat(64)))));
        assert_eq!(safe_integer(Some(&json!(7)), 7, true), Some(7));
        assert_eq!(safe_integer(Some(&json!(8)), 7, true), None);
        assert_eq!(safe_integer(Some(&json!(0)), 7, false), None);
        assert_eq!(safe_integer(Some(&json!(true)), 7, true), None);
        assert_eq!(safe_integer(Some(&json!(-1)), 7, true), None);
        assert!(opaque_identifier(Some(&json!("call_00:x.y-z"))));
        assert!(!opaque_identifier(Some(&json!("call 00"))));
        assert_eq!(
            tool_name_well_formed(Some(&json!("read_file"))),
            Some("read_file")
        );
        assert_eq!(tool_name_well_formed(Some(&json!("read.file"))), None);
    }
}
