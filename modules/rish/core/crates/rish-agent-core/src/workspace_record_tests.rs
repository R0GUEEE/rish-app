use super::*;

/// A stand-in for Foundation's case-and-diacritic fold, good enough for the
/// ASCII names these tests use. The real fold stays with the host.
fn fold(name: &str) -> String {
    name.to_lowercase()
}

fn record(origin: &str) -> Value {
    let mut value = json!({
        "schema_version": 1,
        "workspace_id": "a1b2c3d4-1111-4111-8111-1111abcd1111",
        "display_name": "Notes",
        "origin": origin,
        "root_locator_kind": "documents_owned",
        "location_class": "rish_owned",
        "owned_directory_name": "Notes",
        "legacy_project_id": Value::Null,
        "binding_revision": 3,
        "created_at": "2026-09-16T00:00:00.000Z",
        "last_opened_at": "2026-09-16T01:00:00.000Z",
    });
    match origin {
        "granted_folder" => {
            value["root_locator_kind"] = json!("security_scoped");
            value["location_class"] = json!("proven_local");
            value["owned_directory_name"] = Value::Null;
        }
        "legacy_app_owned" => {
            value["root_locator_kind"] = json!("legacy_app_owned");
            value["owned_directory_name"] = Value::Null;
            value["legacy_project_id"] = json!("b2c3d4e5-2222-4222-8222-2222abcd2222");
        }
        _ => {}
    }
    value
}

fn accepts(value: &Value) -> bool {
    let display = value.get("display_name").and_then(Value::as_str).map(fold);
    let directory = value
        .get("owned_directory_name")
        .and_then(Value::as_str)
        .map(fold);
    record_shape(Some(value), display.as_deref(), directory.as_deref())
}

#[test]
fn each_origin_has_a_well_formed_record() {
    for origin in [
        "rish_created",
        "imported",
        "granted_folder",
        "legacy_app_owned",
    ] {
        assert!(accepts(&record(origin)), "{origin}");
    }
}

/// The origin fixes the locator kind, the location class and which optional
/// identity is present. A record does not get to choose them separately.
#[test]
fn an_origin_cannot_borrow_another_origins_shape() {
    let mut owned = record("rish_created");
    owned["root_locator_kind"] = json!("security_scoped");
    assert!(!accepts(&owned), "owned with a granted locator");

    let mut owned = record("rish_created");
    owned["location_class"] = json!("proven_local");
    assert!(!accepts(&owned), "owned with a granted location class");

    let mut owned = record("rish_created");
    owned["legacy_project_id"] = json!("b2c3d4e5-2222-4222-8222-2222abcd2222");
    assert!(!accepts(&owned), "owned naming a legacy project");

    let mut granted = record("granted_folder");
    granted["owned_directory_name"] = json!("Notes");
    assert!(!accepts(&granted), "granted naming an owned directory");

    let mut legacy = record("legacy_app_owned");
    legacy["legacy_project_id"] = Value::Null;
    assert!(!accepts(&legacy), "legacy naming no project");

    let mut unknown = record("rish_created");
    unknown["origin"] = json!("somewhere_else");
    assert!(!accepts(&unknown), "an origin the rule does not know");
}

#[test]
fn the_eleven_keys_are_exact() {
    for key in [
        "schema_version",
        "workspace_id",
        "display_name",
        "origin",
        "root_locator_kind",
        "location_class",
        "owned_directory_name",
        "legacy_project_id",
        "binding_revision",
        "created_at",
        "last_opened_at",
    ] {
        let mut missing = record("rish_created");
        missing.as_object_mut().expect("object").remove(key);
        assert!(!accepts(&missing), "missing {key}");
    }
    let mut extra = record("rish_created");
    extra["path"] = json!("/tmp");
    assert!(!accepts(&extra), "a twelfth key");
}

/// A display name is one folder's one name: no padding, no leading dot, no
/// path separators, no controls, and not the container's own directory.
#[test]
fn a_display_name_is_one_name_for_one_folder() {
    let ok = |name: &str| display_name(Some(&json!(name)), Some(&fold(name)));
    for good in ["Notes", "My Work", "a", "Ümlaut", "项目"] {
        assert!(ok(good), "{good}");
    }
    for bad in [
        "",
        " Notes",
        "Notes ",
        "\tNotes",
        ".hidden",
        ".",
        "..",
        "a/b",
        "a\\b",
        "a:b",
        "a\u{0}b",
        "a\u{1}b",
        "a\u{200b}b",
    ] {
        assert!(!ok(bad), "{bad:?}");
    }
    // Past the byte bound, counted in UTF-8 bytes rather than characters.
    assert!(ok(&"a".repeat(MAX_DISPLAY_NAME_BYTES)));
    assert!(!ok(&"a".repeat(MAX_DISPLAY_NAME_BYTES + 1)));
    assert!(!ok(&"é".repeat(MAX_DISPLAY_NAME_BYTES / 2 + 1)));
    // A decomposed name is a second spelling of the same name.
    assert!(!display_name(
        Some(&json!("cafe\u{301}")),
        Some("cafe\u{301}")
    ));
}

/// The container's own directory and the private prefix are reserved, and the
/// check is on the folded spelling so case and diacritics cannot dodge it.
#[test]
fn the_containers_own_names_are_reserved() {
    for reserved in ["Rish Workspaces", "RISH WORKSPACES", "rish workspaces"] {
        assert!(
            !display_name(Some(&json!(reserved)), Some("rish workspaces")),
            "{reserved}"
        );
    }
    // A host that could not fold refuses rather than guessing.
    assert!(!display_name(Some(&json!("Notes")), None));
}

/// One capability set has one spelling, so a stored record digests the same
/// everywhere.
#[test]
fn a_capability_array_is_ordered_and_without_repeats() {
    for good in [
        json!([]),
        json!(["read"]),
        json!(["read", "write"]),
        json!(["read", "write", "git", "project_context"]),
        json!(["write", "project_context"]),
    ] {
        assert!(capabilities_array(Some(&good)), "{good}");
    }
    for bad in [
        json!(["write", "read"]),
        json!(["read", "read"]),
        json!(["read", "teleport"]),
        json!(["read", "write", "git", "project_context", "read"]),
        json!([1]),
        json!("read"),
    ] {
        assert!(!capabilities_array(Some(&bad)), "{bad}");
    }
}

/// A revision advances by exactly one: a gap would let two rebinds look like
/// one, and a repeat would let a stale authority pass as current.
#[test]
fn a_binding_revision_advances_by_exactly_one() {
    assert_eq!(
        binding_revision_advance(Some(&json!(3)), Some(&json!(4))),
        Advance::Ok
    );
    assert_eq!(
        binding_revision_advance(Some(&json!(3)), Some(&json!(5))),
        Advance::Conflict
    );
    assert_eq!(
        binding_revision_advance(Some(&json!(3)), Some(&json!(3))),
        Advance::Conflict
    );
    assert_eq!(
        binding_revision_advance(Some(&json!(0)), Some(&json!(1))),
        Advance::Invalid,
        "a revision starts at one"
    );
    assert_eq!(
        binding_revision_advance(Some(&json!("3")), Some(&json!(4))),
        Advance::Invalid
    );
    // At the top of the safe range a binding can never be rebound again, and
    // that is a different answer from a conflict.
    assert_eq!(
        binding_revision_advance(
            Some(&json!(MAX_SAFE_INTEGER)),
            Some(&json!(MAX_SAFE_INTEGER))
        ),
        Advance::Overflow
    );
}

#[test]
fn the_reducer_answers_its_ops() {
    let run = |value: Value| -> Value {
        serde_json::from_str(&reduce_json(&value.to_string())).expect("reply")
    };
    let value = record("rish_created");
    let reply = run(json!({
        "op": "record_shape", "record": value,
        "folded_display_name": "notes", "folded_directory_name": "notes",
    }));
    assert_eq!(reply["valid"], json!(true));
    assert_eq!(
        run(json!({ "op": "capabilities_array", "value": ["write", "read"] }))["valid"],
        json!(false)
    );
    assert_eq!(
        run(json!({ "op": "binding_revision_advance", "current": 3, "proposed": 4 }))["outcome"],
        json!("ok")
    );
    assert_eq!(run(json!({ "op": "teleport" }))["ok"], json!(false));
}
