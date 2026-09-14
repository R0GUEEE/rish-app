//! `DSHSessionParseObject`: the strict pre-scan (depth and node limits,
//! duplicate keys, raw control bytes in strings, the negative-zero lexeme)
//! followed by a parse and a tree validation that admits only finite
//! integral numbers and valid UTF-8 strings.

use crate::execution_ledger::get;
use serde_json::Value;

/// `DSHSessionSnapshotMaximumJSONDepth`.
pub const MAX_JSON_DEPTH: usize = 64;
/// `DSHSessionSnapshotMaximumJSONNodes`.
pub const MAX_JSON_NODES: usize = 250_000;
/// `DSHSessionSnapshotMaximumTombstoneJSONNodes`.
pub const MAX_TOMBSTONE_JSON_NODES: usize = 450_000;

struct Scanner<'a> {
    bytes: &'a [u8],
    index: usize,
    nodes: usize,
    maximum_nodes: usize,
}

impl Scanner<'_> {
    fn skip_whitespace(&mut self) {
        while let Some(&byte) = self.bytes.get(self.index) {
            if !matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
                break;
            }
            self.index += 1;
        }
    }

    fn scan_string(&mut self) -> Option<String> {
        if self.bytes.get(self.index) != Some(&b'"') {
            return None;
        }
        let start = self.index;
        self.index += 1;
        let mut escaped = false;
        while let Some(&byte) = self.bytes.get(self.index) {
            if !escaped && byte == b'"' {
                self.index += 1;
                let token = std::str::from_utf8(&self.bytes[start..self.index]).ok()?;
                return serde_json::from_str::<String>(token).ok();
            }
            if !escaped && (byte < 0x20 || byte == 0x7f) {
                return None;
            }
            escaped = !escaped && byte == b'\\';
            self.index += 1;
        }
        None
    }

    fn scan_object(&mut self, depth: usize) -> bool {
        if self.bytes.get(self.index) != Some(&b'{') {
            return false;
        }
        self.index += 1;
        self.skip_whitespace();
        let mut keys: Vec<String> = Vec::new();
        if self.bytes.get(self.index) == Some(&b'}') {
            self.index += 1;
            return true;
        }
        while self.index < self.bytes.len() {
            let Some(key) = self.scan_string() else {
                return false;
            };
            if keys.contains(&key) {
                return false;
            }
            keys.push(key);
            self.skip_whitespace();
            if self.bytes.get(self.index) != Some(&b':') {
                return false;
            }
            self.index += 1;
            if !self.scan_value(depth + 1) {
                return false;
            }
            self.skip_whitespace();
            if self.bytes.get(self.index) == Some(&b'}') {
                self.index += 1;
                return true;
            }
            if self.bytes.get(self.index) != Some(&b',') {
                return false;
            }
            self.index += 1;
            self.skip_whitespace();
        }
        false
    }

    fn scan_array(&mut self, depth: usize) -> bool {
        if self.bytes.get(self.index) != Some(&b'[') {
            return false;
        }
        self.index += 1;
        self.skip_whitespace();
        if self.bytes.get(self.index) == Some(&b']') {
            self.index += 1;
            return true;
        }
        while self.index < self.bytes.len() {
            if !self.scan_value(depth + 1) {
                return false;
            }
            self.skip_whitespace();
            if self.bytes.get(self.index) == Some(&b']') {
                self.index += 1;
                return true;
            }
            if self.bytes.get(self.index) != Some(&b',') {
                return false;
            }
            self.index += 1;
            self.skip_whitespace();
        }
        false
    }

    fn scan_scalar(&mut self) -> bool {
        let start = self.index;
        while let Some(&byte) = self.bytes.get(self.index) {
            if matches!(byte, b',' | b']' | b'}' | b' ' | b'\t' | b'\r' | b'\n') {
                break;
            }
            self.index += 1;
        }
        if self.index == start {
            return false;
        }
        let token = &self.bytes[start..self.index];
        // Every numeric spelling whose signed mantissa is all zero is negative
        // zero, which Foundation would silently fold into +0.
        if token[0] == b'-' {
            let mut non_zero = false;
            for &byte in &token[1..] {
                if byte == b'e' || byte == b'E' {
                    break;
                }
                if (b'1'..=b'9').contains(&byte) {
                    non_zero = true;
                    break;
                }
            }
            if !non_zero {
                return false;
            }
        }
        let Ok(text) = std::str::from_utf8(token) else {
            return false;
        };
        matches!(
            serde_json::from_str::<Value>(text),
            Ok(Value::Number(_) | Value::Null | Value::Bool(_))
        )
    }

    fn scan_value(&mut self, depth: usize) -> bool {
        self.skip_whitespace();
        if depth > MAX_JSON_DEPTH
            || self.nodes >= self.maximum_nodes
            || self.index >= self.bytes.len()
        {
            return false;
        }
        self.nodes += 1;
        match self.bytes[self.index] {
            b'{' => self.scan_object(depth),
            b'[' => self.scan_array(depth),
            b'"' => self.scan_string().is_some(),
            _ => self.scan_scalar(),
        }
    }
}

/// `DSHSessionValidateJSONTree`.
fn validate_tree(value: &Value, depth: usize, nodes: &mut usize, maximum_nodes: usize) -> bool {
    if depth > MAX_JSON_DEPTH || *nodes >= maximum_nodes {
        return false;
    }
    *nodes += 1;
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Number(_) => super::primitives::finite_number(Some(value)),
        Value::Array(items) => items
            .iter()
            .all(|item| validate_tree(item, depth + 1, nodes, maximum_nodes)),
        Value::Object(map) => map
            .values()
            .all(|item| validate_tree(item, depth + 1, nodes, maximum_nodes)),
    }
}

/// `DSHSessionParseObjectWithNodeLimit` without the byte bounds (callers
/// check those first because they map to different error codes): the strict
/// scan, a top-level object, the parse, and the tree validation.
pub fn parse_object(bytes: &[u8], maximum_nodes: usize) -> Option<Value> {
    if bytes.is_empty() {
        return None;
    }
    let mut scanner = Scanner {
        bytes,
        index: 0,
        nodes: 0,
        maximum_nodes,
    };
    if !scanner.scan_value(0) {
        return None;
    }
    scanner.skip_whitespace();
    let first = bytes
        .iter()
        .position(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))?;
    if scanner.index != bytes.len() || bytes[first] != b'{' {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let object: Value = serde_json::from_str(text).ok()?;
    if !object.is_object() {
        return None;
    }
    let mut nodes = 0usize;
    if !validate_tree(&object, 0, &mut nodes, maximum_nodes) {
        return None;
    }
    let _ = get(&object, "schema_version");
    Some(object)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_refuses_duplicates_negative_zero_and_fractions() {
        assert!(parse_object(br#"{"a":1,"b":[true,null,"x"]}"#, 100).is_some());
        assert!(parse_object(br#"{"a":1,"a":2}"#, 100).is_none());
        assert!(parse_object(br#"{"a":-0}"#, 100).is_none());
        assert!(parse_object(br#"{"a":-0.0e5}"#, 100).is_none());
        assert!(parse_object(br#"{"a":1.5}"#, 100).is_none());
        assert!(parse_object(br#"{"a":1.0}"#, 100).is_some());
        assert!(parse_object(b"[1]", 100).is_none());
        assert!(parse_object(b"{\"a\":\"\x7f\"}", 100).is_none());
        assert!(parse_object(br#"{"a":1} x"#, 100).is_none());
        assert!(parse_object(br#"{"a":[1,2,3]}"#, 3).is_none());
    }
}
