//! The frozen root projection: what a resolved root looks like, which
//! capabilities a workspace's grants imply, how a workspace root is promoted
//! to a project root, and which of them an operation may ask for.
//!
//! Ported from `AgentRootResolver.mm`. Resolving a root is a host capability —
//! only the host owns the workspace registry, the leases, the guards and
//! libgit2 — but every *judgement* the resolver makes along the way is a rule,
//! and the rules are what two platforms would otherwise each write down. The
//! capability derivation and its inverse are the sharpest case: they are read
//! in opposite directions by different call sites and must stay exact
//! inverses, which is only checkable if they sit next to each other.
//!
//! Whether this build has the guest CGI tools is a build fact, not a rule, so
//! the host says — exactly as it does for the tool table's digest.

use serde_json::{json, Map, Value};

use crate::schema::{
    canonical_sha256, canonical_uuid, is_null, root_full, safe_integer, MAX_SAFE_INTEGER,
};
use crate::store::StoreError;

/// The six capabilities a root may carry, in the order a projection lists them.
pub const CAPABILITIES: &[&str] = &[
    "file_read",
    "file_write",
    "git_status",
    "git_commit",
    "git_push",
    "guest_service",
];

/// The three Git capabilities a project root adds, in their canonical order.
const GIT: &[&str] = &["git_status", "git_commit", "git_push"];

/// The workspace grants a host can hold. `DSHLocalWorkspaceAccess` names them
/// this way; the Agent capabilities above are derived from them and never
/// stored.
const GRANTS: &[&str] = &["read", "write", "git"];

/// An operation's mode, and with it the one capability it must be able to name
/// in the root before any lease is taken.
const MODES: &[(&str, &str)] = &[
    ("read", "file_read"),
    ("write", "file_write"),
    ("git_read", "git_status"),
    ("git_write", "git_commit"),
    ("project_context", "file_read"),
];

/// The legacy bound-project adapter's own mode, which is the operation mode
/// for a plain operation and a precedence over the requested capabilities for
/// a final proof.
const LEGACY_MODE: &[(&str, &str)] = &[
    ("read", "read"),
    ("write", "write"),
    ("git_read", "git_read"),
    ("git_write", "git_write"),
    ("project_context", "project_context"),
];

/// The longest an Agent root operation may hold a lease, in seconds.
pub const MAX_OPERATION_TIMEOUT: f64 = 30.0;

fn string_list(value: Option<&Value>, allowed: &[&str]) -> Result<Vec<String>, StoreError> {
    let Some(Value::Array(items)) = value else {
        return Err(StoreError::InvalidArgument);
    };
    let mut names: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let Value::String(name) = item else {
            return Err(StoreError::InvalidArgument);
        };
        if !allowed.contains(&name.as_str()) || names.iter().any(|seen| seen == name) {
            return Err(StoreError::InvalidArgument);
        }
        names.push(name.clone());
    }
    Ok(names)
}

/// `DSHAgentCapabilitiesForWorkspace`: the Agent capabilities the host's
/// grants imply, in the frozen order. `guest_service` exists only where the
/// build has the guest CGI tools, and only with both file grants — it is the
/// one capability that is not a rename of a grant.
pub fn capabilities_for_grants(grants: &[String], project: bool, guest_cgi: bool) -> Vec<String> {
    let has = |name: &str| grants.iter().any(|grant| grant == name);
    let mut capabilities: Vec<String> = Vec::with_capacity(6);
    if has("read") {
        capabilities.push("file_read".to_string());
    }
    if has("write") {
        capabilities.push("file_write".to_string());
    }
    if project && has("git") {
        capabilities.extend(GIT.iter().map(|name| name.to_string()));
    }
    if guest_cgi && has("read") && has("write") {
        capabilities.push("guest_service".to_string());
    }
    capabilities
}

/// The inverse: the workspace grants a lease must require to satisfy these
/// Agent capabilities. `guest_service` needs both file grants because it is
/// derived from both; every `git_*` collapses to the single `git` grant.
pub fn grants_for_capabilities(capabilities: &[String]) -> Result<Vec<String>, StoreError> {
    let mut grants: Vec<String> = Vec::with_capacity(3);
    let push = |grant: &str, grants: &mut Vec<String>| {
        if !grants.iter().any(|seen| seen == grant) {
            grants.push(grant.to_string());
        }
    };
    for capability in capabilities {
        match capability.as_str() {
            "file_read" => push("read", &mut grants),
            "file_write" => push("write", &mut grants),
            "guest_service" => {
                push("read", &mut grants);
                push("write", &mut grants);
            }
            name if name.starts_with("git_") && CAPABILITIES.contains(&name) => {
                push("git", &mut grants);
            }
            _ => return Err(StoreError::InvalidArgument),
        }
    }
    // The host compares a set; the list is sorted into the grant order so two
    // equal requests are also equal bytes.
    grants.sort_by_key(|grant| {
        GRANTS
            .iter()
            .position(|name| name == grant)
            .unwrap_or(GRANTS.len())
    });
    Ok(grants)
}

/// `DSHAgentRootProjectionShape`: the complete frozen projection. The shape
/// itself already lives in `schema::root_full`, which the round journal and
/// the execution ledger validate stored roots with; the resolver reads the
/// same rule rather than a second copy of it.
pub fn projection_shape(root: Option<&Value>) -> bool {
    root_full(root)
}

/// The resolver's arguments. All three absent means "no root", which is not an
/// error: an attempt may legitimately have none.
pub enum Request {
    None,
    Resolve {
        workspace_id: String,
        project_id: Option<String>,
        binding_revision: u64,
    },
}

/// Validates `{workspace_id, project_id, binding_revision}` as the resolver
/// reads them. A project id alone is not a root: the binding always travels
/// with its workspace.
pub fn resolve_request(envelope: &Value) -> Result<Request, StoreError> {
    let workspace = envelope.get("workspace_id");
    let project = envelope.get("project_id");
    let revision = envelope.get("binding_revision");
    let absent = |value: Option<&Value>| value.is_none() || is_null(value);
    if absent(workspace) && absent(project) && absent(revision) {
        return Ok(Request::None);
    }
    if !canonical_uuid(workspace) {
        return Err(StoreError::InvalidArgument);
    }
    let Some(binding_revision) = safe_integer(revision, MAX_SAFE_INTEGER, false) else {
        return Err(StoreError::InvalidArgument);
    };
    let project_id = if absent(project) {
        None
    } else if canonical_uuid(project) {
        Some(
            project
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        )
    } else {
        return Err(StoreError::InvalidArgument);
    };
    Ok(Request::Resolve {
        workspace_id: workspace
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        project_id,
        binding_revision,
    })
}

/// The workspace projection the host's evidence implies. `project_id` is
/// always null here: the workspace registry stores a binding without one, and
/// project identity comes only from an independently verified project lease.
pub fn workspace_projection(
    workspace_id: &str,
    binding_revision: u64,
    fingerprint: &str,
    grants: &[String],
    guest_cgi: bool,
) -> Result<Value, StoreError> {
    if !canonical_uuid(Some(&json!(workspace_id))) || binding_revision > MAX_SAFE_INTEGER {
        return Err(StoreError::InvalidArgument);
    }
    if !canonical_sha256(Some(&json!(fingerprint))) {
        // A registry that stores something other than a digest here is
        // corrupt, not a bad request: the host read it, it did not ask for it.
        return Err(StoreError::Corrupt);
    }
    let root = json!({
        "schema_version": 1,
        "kind": "workspace",
        "workspace_id": workspace_id,
        "workspace_binding_revision": binding_revision,
        "project_id": null,
        "root_fingerprint_sha256": fingerprint,
        "capabilities": capabilities_for_grants(grants, false, guest_cgi),
    });
    Ok(root)
}

/// Promotes a verified workspace projection to a project root. The three Git
/// capabilities are appended in their canonical order and only once, so
/// promoting an already-promoted root is the identity — the resolver relies on
/// that when it re-derives an expectation from a base it may already hold.
pub fn project_projection(
    base: Option<&Value>,
    project_id: &str,
    fingerprint: Option<&str>,
) -> Result<Value, StoreError> {
    if !projection_shape(base) {
        return Err(StoreError::InvalidArgument);
    }
    let base = base
        .and_then(Value::as_object)
        .ok_or(StoreError::InvalidArgument)?;
    if !canonical_uuid(Some(&json!(project_id))) {
        return Err(StoreError::InvalidArgument);
    }
    let mut root: Map<String, Value> = base.clone();
    root.insert("kind".to_string(), json!("project"));
    root.insert("project_id".to_string(), json!(project_id));
    if let Some(fingerprint) = fingerprint {
        if !canonical_sha256(Some(&json!(fingerprint))) {
            return Err(StoreError::InvalidArgument);
        }
        root.insert("root_fingerprint_sha256".to_string(), json!(fingerprint));
    }
    let mut capabilities = match root.get("capabilities") {
        Some(Value::Array(items)) => items.clone(),
        _ => return Err(StoreError::InvalidArgument),
    };
    if !capabilities.iter().any(|item| item == "git_status") {
        capabilities.extend(GIT.iter().map(|name| json!(name)));
    }
    root.insert("capabilities".to_string(), Value::Array(capabilities));
    let root = Value::Object(root);
    // Promotion may not produce something the stored-root rule would refuse:
    // a workspace with no `git` grant has no Git capabilities to add and a
    // seventh capability would overflow the frozen projection.
    if !projection_shape(Some(&root)) {
        return Err(StoreError::InvalidArgument);
    }
    Ok(root)
}

/// `rootRef`: the narrow reference a project lease is taken against.
pub fn root_ref(root: Option<&Value>) -> Result<Value, StoreError> {
    if !projection_shape(root) {
        return Err(StoreError::InvalidArgument);
    }
    let root = root
        .and_then(Value::as_object)
        .ok_or(StoreError::InvalidArgument)?;
    if root.get("kind") != Some(&json!("project")) {
        return Err(StoreError::InvalidArgument);
    }
    Ok(json!({
        "schema_version": 1,
        "workspace_id": root.get("workspace_id"),
        "binding_revision": root.get("workspace_binding_revision"),
        "project_id": root.get("project_id"),
    }))
}

/// What an operation in `mode` needs before it may take a lease: the
/// capability the root must already carry, and the adapter mode it maps to.
/// A capability the root does not carry is a conflict, not a bad request —
/// the request is well formed, the root simply cannot serve it.
pub fn operation_mode(root: Option<&Value>, mode: &str, timeout: f64) -> Result<Value, StoreError> {
    if !projection_shape(root)
        || !timeout.is_finite()
        || !(0.0..=MAX_OPERATION_TIMEOUT).contains(&timeout)
    {
        return Err(StoreError::InvalidArgument);
    }
    let Some((_, capability)) = MODES.iter().find(|(name, _)| *name == mode) else {
        return Err(StoreError::InvalidArgument);
    };
    let Some((_, legacy)) = LEGACY_MODE.iter().find(|(name, _)| *name == mode) else {
        return Err(StoreError::InvalidArgument);
    };
    let carries = root
        .and_then(|value| value.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item == capability));
    if !carries {
        return Err(StoreError::Conflict);
    }
    Ok(json!({ "capability": capability, "legacy_mode": legacy }))
}

/// A final-proof request has to describe itself consistently: the leases it
/// says it needs must be exactly the ones its capabilities imply, or the proof
/// would be taken over something other than what the caller will do with it.
/// `git_push` is never served by the legacy bound-project adapter, so the
/// answer also says whether probing it is even allowed.
pub fn final_proof_request(
    root: Option<&Value>,
    capabilities: Option<&Value>,
    needs_project_lease: bool,
    project_write_access: bool,
) -> Result<Value, StoreError> {
    if !projection_shape(root) {
        return Err(StoreError::InvalidArgument);
    }
    let capabilities = string_list(capabilities, CAPABILITIES)?;
    let has = |name: &str| capabilities.iter().any(|capability| capability == name);
    let (file_write, git_read, git_write, git_push) = (
        has("file_write"),
        has("git_status"),
        has("git_commit"),
        has("git_push"),
    );
    let any_git = git_read || git_write || git_push;
    if needs_project_lease != any_git || project_write_access != (git_write || git_push) {
        return Err(StoreError::InvalidArgument);
    }
    let legacy_mode = if git_write {
        "git_write"
    } else if file_write {
        "write"
    } else if git_read {
        "git_read"
    } else {
        "read"
    };
    Ok(json!({
        "legacy_mode": legacy_mode,
        "probe_legacy": !git_push && root.and_then(|value| value.get("kind")) == Some(&json!("project")),
        "grants": grants_for_capabilities(&capabilities)?,
    }))
}

/// One envelope in, one reply out; see `rish_agent_root_reduce`.
pub fn reduce_json(input: &str) -> String {
    let value = match reduce_json_inner(input) {
        Ok(output) => {
            let mut object = output.as_object().cloned().unwrap_or_default();
            object.insert("ok".to_string(), Value::Bool(true));
            Value::Object(object)
        }
        Err(error) => json!({ "ok": false, "error": error.code() }),
    };
    value.to_string()
}

fn reduce_json_inner(input: &str) -> Result<Value, StoreError> {
    let envelope: Value = serde_json::from_str(input).map_err(|_| StoreError::Corrupt)?;
    let op = envelope
        .get("op")
        .and_then(Value::as_str)
        .ok_or(StoreError::Corrupt)?;
    let guest_cgi = envelope.get("guest_cgi") == Some(&Value::Bool(true));
    let root = || envelope.get("root");
    let text = |key: &str| {
        envelope
            .get(key)
            .and_then(Value::as_str)
            .ok_or(StoreError::InvalidArgument)
    };
    match op {
        "projection_shape" => {
            if projection_shape(envelope.get("value")) {
                Ok(json!({}))
            } else {
                Err(StoreError::InvalidArgument)
            }
        }
        "capabilities" => {
            let grants = string_list(envelope.get("grants"), GRANTS)?;
            let project = envelope.get("project") == Some(&Value::Bool(true));
            Ok(json!({ "capabilities": capabilities_for_grants(&grants, project, guest_cgi) }))
        }
        "grants" => {
            let capabilities = string_list(envelope.get("capabilities"), CAPABILITIES)?;
            Ok(json!({ "grants": grants_for_capabilities(&capabilities)? }))
        }
        "resolve_request" => Ok(match resolve_request(&envelope)? {
            Request::None => json!({ "outcome": "none" }),
            Request::Resolve {
                workspace_id,
                project_id,
                binding_revision,
            } => json!({
                "outcome": "resolve",
                "workspace_id": workspace_id,
                "project_id": project_id,
                "binding_revision": binding_revision,
                "kind": if project_id.is_some() { "project" } else { "workspace" },
            }),
        }),
        "workspace_projection" => {
            let grants = string_list(envelope.get("grants"), GRANTS)?;
            let revision = safe_integer(envelope.get("binding_revision"), MAX_SAFE_INTEGER, false)
                .ok_or(StoreError::InvalidArgument)?;
            Ok(json!({
                "root": workspace_projection(
                    text("workspace_id")?, revision, text("root_fingerprint_sha256")?,
                    &grants, guest_cgi)?
            }))
        }
        "project_projection" => Ok(json!({
            "root": project_projection(
                envelope.get("base"), text("project_id")?,
                envelope.get("root_fingerprint_sha256").and_then(Value::as_str))?
        })),
        "root_ref" => Ok(json!({ "root_ref": root_ref(root())? })),
        "operation_mode" => {
            let timeout = envelope
                .get("timeout")
                .and_then(Value::as_f64)
                .ok_or(StoreError::InvalidArgument)?;
            operation_mode(root(), text("mode")?, timeout)
        }
        "final_proof_request" => final_proof_request(
            root(),
            envelope.get("capabilities"),
            envelope.get("needs_project_lease") == Some(&Value::Bool(true)),
            envelope.get("project_write_access") == Some(&Value::Bool(true)),
        ),
        // Two projections are the same root only if they are the same JSON.
        // Hosts whose dictionaries carry no value equality have compared
        // references here before and silently accepted a stale root.
        "matches" => Ok(json!({
            "matches": projection_shape(envelope.get("value"))
                && envelope.get("value") == envelope.get("expected")
        })),
        _ => Err(StoreError::InvalidArgument),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grants(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn workspace() -> Value {
        workspace_projection(
            "11111111-1111-4111-8111-111111111111",
            7,
            &"c".repeat(64),
            &grants(&["read", "write", "git"]),
            false,
        )
        .expect("workspace root")
    }

    #[test]
    fn a_workspace_root_never_carries_git_capabilities() {
        let root = workspace();
        assert_eq!(root["capabilities"], json!(["file_read", "file_write"]));
        assert_eq!(root["project_id"], Value::Null);
        assert!(projection_shape(Some(&root)));
    }

    #[test]
    fn the_guest_service_capability_needs_the_build_and_both_file_grants() {
        assert_eq!(
            capabilities_for_grants(&grants(&["read", "write"]), false, true),
            vec!["file_read", "file_write", "guest_service"]
        );
        assert_eq!(
            capabilities_for_grants(&grants(&["read"]), false, true),
            vec!["file_read"]
        );
        assert_eq!(
            capabilities_for_grants(&grants(&["read", "write"]), false, false),
            vec!["file_read", "file_write"]
        );
    }

    /// The two directions are read by different call sites — one builds a
    /// projection, the other asks the host for a lease — so a drift between
    /// them would grant a capability no lease was taken for.
    #[test]
    fn the_grant_mapping_round_trips_for_every_grant_set() {
        for bits in 0..8u8 {
            let held: Vec<String> = grants(&["read", "write", "git"])
                .into_iter()
                .enumerate()
                .filter(|(index, _)| bits & (1 << index) != 0)
                .map(|(_, grant)| grant)
                .collect();
            let capabilities = capabilities_for_grants(&held, true, true);
            let derived = grants_for_capabilities(&capabilities).expect("grants");
            assert_eq!(derived, held, "grants {held:?}");
        }
    }

    #[test]
    fn promoting_a_project_root_twice_changes_nothing() {
        let base = workspace();
        let project = "22222222-2222-4222-8222-222222222222";
        let once = project_projection(Some(&base), project, None).expect("project root");
        let twice = project_projection(Some(&once), project, None).expect("project root");
        assert_eq!(once, twice);
        assert_eq!(
            once["capabilities"],
            json!([
                "file_read",
                "file_write",
                "git_status",
                "git_commit",
                "git_push"
            ])
        );
        assert!(projection_shape(Some(&once)));
    }

    /// Six capabilities is the frozen maximum, and a promoted guest-service
    /// root is exactly six. A seventh would be refused by the stored-root
    /// rule after the fact, so promotion refuses to build it.
    #[test]
    fn a_promoted_guest_service_root_is_the_widest_root_there_is() {
        let base = workspace_projection(
            "11111111-1111-4111-8111-111111111111",
            1,
            &"c".repeat(64),
            &grants(&["read", "write", "git"]),
            true,
        )
        .expect("workspace root");
        let root = project_projection(Some(&base), "22222222-2222-4222-8222-222222222222", None)
            .expect("project root");
        assert_eq!(root["capabilities"].as_array().expect("array").len(), 6);
        assert!(projection_shape(Some(&root)));
    }

    #[test]
    fn a_capability_the_root_does_not_carry_is_a_conflict_not_a_bad_request() {
        let root = workspace();
        assert!(operation_mode(Some(&root), "read", 5.0).is_ok());
        assert_eq!(
            operation_mode(Some(&root), "git_read", 5.0),
            Err(StoreError::Conflict)
        );
        assert_eq!(
            operation_mode(Some(&root), "teleport", 5.0),
            Err(StoreError::InvalidArgument)
        );
        assert_eq!(
            operation_mode(Some(&root), "read", 31.0),
            Err(StoreError::InvalidArgument)
        );
        assert_eq!(
            operation_mode(Some(&root), "read", f64::NAN),
            Err(StoreError::InvalidArgument)
        );
    }

    #[test]
    fn a_final_proof_must_ask_for_the_leases_its_capabilities_imply() {
        let root = project_projection(
            Some(&workspace()),
            "22222222-2222-4222-8222-222222222222",
            None,
        )
        .expect("project root");
        let ask = |capabilities: Value, project: bool, write: bool| {
            final_proof_request(Some(&root), Some(&capabilities), project, write)
        };
        assert_eq!(
            ask(json!(["git_commit"]), true, true).expect("proof")["legacy_mode"],
            json!("git_write")
        );
        assert_eq!(
            ask(json!(["file_write"]), false, false).expect("proof")["legacy_mode"],
            json!("write")
        );
        // git_push is never served by the legacy adapter.
        assert_eq!(
            ask(json!(["git_push"]), true, true).expect("proof")["probe_legacy"],
            json!(false)
        );
        assert_eq!(
            ask(json!(["git_commit"]), false, true),
            Err(StoreError::InvalidArgument)
        );
        assert_eq!(
            ask(json!(["git_status"]), true, true),
            Err(StoreError::InvalidArgument)
        );
        assert_eq!(
            ask(json!(["file_read", "file_read"]), false, false),
            Err(StoreError::InvalidArgument)
        );
    }

    #[test]
    fn three_absent_arguments_are_no_root_rather_than_a_bad_one() {
        assert!(matches!(
            resolve_request(&json!({})).expect("request"),
            Request::None
        ));
        assert!(matches!(
            resolve_request(&json!({
                "workspace_id": null, "project_id": null, "binding_revision": null
            }))
            .expect("request"),
            Request::None
        ));
        // A project without its workspace binding is not a root.
        assert_eq!(
            resolve_request(&json!({ "project_id": "22222222-2222-4222-8222-222222222222" })).err(),
            Some(StoreError::InvalidArgument)
        );
    }

    #[test]
    fn the_reducer_answers_the_shape_and_the_match() {
        let root = workspace();
        let reply: Value = serde_json::from_str(&reduce_json(
            &json!({ "op": "projection_shape", "value": root }).to_string(),
        ))
        .expect("reply");
        assert_eq!(reply["ok"], json!(true));
        let reply: Value = serde_json::from_str(&reduce_json(
            &json!({ "op": "matches", "value": root, "expected": root }).to_string(),
        ))
        .expect("reply");
        assert_eq!(reply["matches"], json!(true));
        let mut stale = root.clone();
        stale["workspace_binding_revision"] = json!(8);
        let reply: Value = serde_json::from_str(&reduce_json(
            &json!({ "op": "matches", "value": stale, "expected": root }).to_string(),
        ))
        .expect("reply");
        assert_eq!(reply["matches"], json!(false));
    }
}
