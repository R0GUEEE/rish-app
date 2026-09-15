//! Additive precondition for a create-only write with missing directories.
//! Only digests enter the WAL; the executor rechecks the actual path and inode.

use crate::schema::{canonical_sha256, exact_keys, safe_integer};
use serde_json::Value;

pub(crate) fn valid(value: Option<&Value>) -> bool {
    let Some(plan) = exact_keys(
        value,
        &[
            "schema_version",
            "ancestor_depth",
            "ancestor_identity_sha256",
            "missing_parent_path_sha256",
        ],
    ) else {
        return false;
    };
    let Some(depth) = safe_integer(plan.get("ancestor_depth"), 255, true) else {
        return false;
    };
    let Some(Value::Array(paths)) = plan.get("missing_parent_path_sha256") else {
        return false;
    };
    safe_integer(plan.get("schema_version"), 1, false) == Some(1)
        && canonical_sha256(plan.get("ancestor_identity_sha256"))
        && !paths.is_empty()
        && paths.len() <= 32
        && depth + paths.len() as u64 <= 255
        && paths
            .iter()
            .enumerate()
            .all(|(index, path)| canonical_sha256(Some(path)) && !paths[..index].contains(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_ledger::precondition_shape;
    use serde_json::json;

    fn plan() -> Value {
        json!({ "schema_version": 1, "ancestor_depth": 0,
            "ancestor_identity_sha256": "a".repeat(64),
            "missing_parent_path_sha256": ["b".repeat(64), "c".repeat(64)] })
    }
    fn write() -> Value {
        json!({ "schema_version": 3, "kind": "write_file",
            "relative_path_sha256": "d".repeat(64),
            "prior": { "schema_version": 1, "kind": "absent" },
            "content_sha256": "e".repeat(64), "content_bytes": 12,
            "parent_plan": plan() })
    }

    #[test]
    fn accepts_bounded_create_plan_and_keeps_existing_write_contract() {
        assert!(valid(Some(&plan())));
        assert!(precondition_shape(Some(&write())));
        let mut old = write();
        old["schema_version"] = json!(2);
        old.as_object_mut().unwrap().remove("parent_plan");
        assert!(precondition_shape(Some(&old)));
        old["prior"] = json!({ "schema_version": 1, "kind": "known",
            "revision": "1:2:3:4:5" });
        assert!(precondition_shape(Some(&old)));
        old["parent_plan"] = plan();
        assert!(!precondition_shape(Some(&old)));
    }

    #[test]
    fn refuses_unbounded_ambiguous_or_non_create_plans() {
        for (key, value) in [
            ("schema_version", json!(2)),
            ("ancestor_depth", json!(true)),
            ("ancestor_depth", json!(-1)),
            ("ancestor_depth", json!(254)),
            ("ancestor_identity_sha256", json!("not-an-inode-proof")),
            ("missing_parent_path_sha256", json!([])),
            (
                "missing_parent_path_sha256",
                json!(["b".repeat(64), "b".repeat(64)]),
            ),
            ("missing_parent_path_sha256", json!(["public"])),
        ] {
            let mut bad = plan();
            bad[key] = value;
            assert!(!valid(Some(&bad)), "{bad}");
        }
        let mut bad = plan();
        bad["unbound_path"] = json!("public");
        assert!(!valid(Some(&bad)));
        let mut bad = write();
        bad["prior"] = json!({ "schema_version": 1,
            "kind": "known", "revision": "1:2:3:4:5" });
        assert!(!precondition_shape(Some(&bad)));
        let mut bad = write();
        bad.as_object_mut().unwrap().remove("parent_plan");
        assert!(!precondition_shape(Some(&bad)));
    }
}
