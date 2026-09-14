//! Byte-for-byte parity with the Objective-C++ engine. `canonical-golden.json`
//! is written by `AgentCoreGoldenTests.mm` from `canonical-corpus.json`; this
//! test replays the same corpus through the Rust implementation and compares.

use rish_agent_core::canonical::{canonical_json, hash_bytes, hash_json};
use rish_agent_core::strict_json::parse_arguments;
use serde_json::Value;
use std::path::PathBuf;

fn fixture(name: &str) -> Value {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "..", "fixtures", name]
        .iter()
        .collect();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

/// Mirrors the ObjC side: parse the text (fragments allowed) then canonicalise;
/// `None` when either step refuses.
fn canonical_of_text(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let bytes = canonical_json(&value).ok()?;
    Some(String::from_utf8(bytes).expect("canonical output is UTF-8"))
}

#[test]
fn canonical_json_matches_the_objc_engine() {
    let corpus = fixture("canonical-corpus.json");
    let golden = fixture("canonical-golden.json");
    let expected = golden["canonical"].as_object().expect("golden.canonical");
    let divergences = corpus["divergences"]
        .as_object()
        .expect("corpus.divergences");
    let mut failures = Vec::new();
    for case in corpus["canonical"].as_array().expect("corpus.canonical") {
        let name = case["name"].as_str().unwrap();
        let text = case["json"].as_str().unwrap();
        if let Some(divergence) = divergences.get(name) {
            // Documented, deliberate divergence: the corpus states the exact
            // Rust output (null = the core must refuse) so the gap is pinned
            // rather than silently skipped.
            let want = divergence["rust_canonical"].as_str().map(str::to_owned);
            let got = canonical_of_text(text);
            if got != want {
                failures.push(format!(
                    "{name}: rust={got:?} documented divergence expects {want:?}"
                ));
            }
            continue;
        }
        let want = expected
            .get(name)
            .unwrap_or_else(|| panic!("golden has no canonical case {name}"));
        let want_text = want["canonical"].as_str().map(str::to_owned);
        let want_hash = want["hash"].as_str().map(str::to_owned);
        let got_text = canonical_of_text(text);
        let got_hash = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|value| hash_json("golden", &value));
        if got_text != want_text || got_hash != want_hash {
            failures.push(format!(
                "{name}: rust={got_text:?}/{got_hash:?} objc={want_text:?}/{want_hash:?}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "canonical mismatches:\n{}",
        failures.join("\n")
    );
}

#[test]
fn hash_json_matches_the_objc_engine() {
    let corpus = fixture("canonical-corpus.json");
    let golden = fixture("canonical-golden.json");
    let expected = golden["hash_json"].as_object().expect("golden.hash_json");
    for case in corpus["hash_json"].as_array().expect("corpus.hash_json") {
        let name = case["name"].as_str().unwrap();
        let value: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();
        let got = hash_json(case["tag"].as_str().unwrap(), &value);
        let want = expected[name].as_str().map(str::to_owned);
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn hash_bytes_matches_the_objc_engine() {
    let corpus = fixture("canonical-corpus.json");
    let golden = fixture("canonical-golden.json");
    let expected = golden["hash_bytes"].as_object().expect("golden.hash_bytes");
    for case in corpus["hash_bytes"].as_array().expect("corpus.hash_bytes") {
        let name = case["name"].as_str().unwrap();
        let bytes = hex_to_bytes(case["bytes_hex"].as_str().unwrap());
        let got = hash_bytes(case["tag"].as_str().unwrap(), &bytes);
        let want = expected[name].as_str().map(str::to_owned);
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn strict_argument_parser_matches_the_objc_engine() {
    let corpus = fixture("canonical-corpus.json");
    let golden = fixture("canonical-golden.json");
    let expected = golden["arguments"].as_object().expect("golden.arguments");
    let mut failures = Vec::new();
    for case in corpus["arguments"].as_array().expect("corpus.arguments") {
        let name = case["name"].as_str().unwrap();
        let accepted = parse_arguments(case["json"].as_str().unwrap()).is_some();
        let want = expected[name]
            .as_bool()
            .unwrap_or_else(|| panic!("golden has no arguments case {name}"));
        if accepted != want {
            failures.push(format!(
                "{name}: rust accepted={accepted} objc accepted={want}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "argument parser mismatches:\n{}",
        failures.join("\n")
    );
}
