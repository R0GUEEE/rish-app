//! The frozen tool table, the registry projection a root implies, and the
//! policy that bounds writes.
//!
//! Ported from `AgentToolRegistry.mm`. The table is a pure table, so it lives
//! here rather than being typed out once per platform: its canonical bytes are
//! the `toolset_sha256` every stored authority is bound to, and two copies of
//! it would eventually disagree.
//!
//! Whether the guest CGI tools exist is a build fact, not a rule — iOS
//! compiles them in behind `DSH_GUEST_CGI_AVAILABLE` — so the host says, and
//! the digest follows.

use serde_json::{json, Value};

use crate::canonical::hash_json;
use crate::schema::{bounded_utf8, canonical_sha256, exact_keys, root_full};
use crate::store::StoreError;

const CAPABILITIES: &[&str] = &[
    "file_read",
    "file_write",
    "git_status",
    "git_commit",
    "git_push",
    "guest_service",
];

/// The capability each tool requires, and with it the set of known names.
const REQUIRED: &[(&str, &str)] = &[
    ("list_dir", "file_read"),
    ("read_file", "file_read"),
    ("write_file", "file_write"),
    ("git_status", "git_status"),
    ("git_commit", "git_commit"),
    ("git_push", "git_push"),
    ("start_guest_cgi", "guest_service"),
    ("stop_guest_cgi", "guest_service"),
];

fn string_property(max: u64) -> Value {
    json!({ "type": "string", "max_utf8_bytes": max })
}

fn nullable_string_property(max: u64) -> Value {
    json!({ "type": ["string", "null"], "max_utf8_bytes": max })
}

/// The table itself, in the order the digest is taken over. Parameter names
/// and schemas are needed to build a provider request, and are never copied
/// into the safe projection.
pub fn descriptors(guest_cgi: bool) -> Vec<Value> {
    let mut table = Vec::with_capacity(8);
    if guest_cgi {
        table.push(json!({
            "schema_version": 1, "name": "start_guest_cgi",
            "required_capability": "guest_service", "effect": "guest_service",
            "safe_summary_key": "agent.start_guest_cgi",
            "parameters": {
                "type": "object",
                "properties": {
                    "index_path": string_property(1024),
                    "index_sha256": string_property(64),
                    "backend_path": string_property(1024),
                    "backend_sha256": string_property(64),
                    "initial_data_path": nullable_string_property(1024),
                    "initial_data_sha256": nullable_string_property(64),
                },
                "required": ["index_path", "index_sha256", "backend_path",
                             "backend_sha256", "initial_data_path", "initial_data_sha256"],
            },
        }));
        table.push(json!({
            "schema_version": 1, "name": "stop_guest_cgi",
            "required_capability": "guest_service", "effect": "guest_service",
            "safe_summary_key": "agent.stop_guest_cgi",
            "parameters": {
                "type": "object",
                "properties": { "service_id": string_property(36) },
                "required": ["service_id"],
            },
        }));
    }
    table.push(json!({
        "schema_version": 1, "name": "git_commit", "required_capability": "git_commit",
        "effect": "git_commit", "safe_summary_key": "agent.git_commit",
        "parameters": {
            "type": "object",
            "properties": { "message": string_property(4096) },
            "required": ["message"],
        },
    }));
    table.push(json!({
        "schema_version": 1, "name": "git_push", "required_capability": "git_push",
        "effect": "git_push", "safe_summary_key": "agent.git_push",
        "fixed_remote": "origin",
        "parameters": { "type": "object", "properties": {}, "required": [] },
    }));
    table.push(json!({
        "schema_version": 1, "name": "git_status", "required_capability": "git_status",
        "effect": "read", "safe_summary_key": "agent.git_status",
        "parameters": { "type": "object", "properties": {}, "required": [] },
    }));
    table.push(json!({
        "schema_version": 1, "name": "list_dir", "required_capability": "file_read",
        "effect": "read", "safe_summary_key": "agent.list_dir",
        "parameters": {
            "type": "object",
            "properties": { "path": string_property(4096) },
            "required": ["path"],
        },
    }));
    table.push(json!({
        "schema_version": 1, "name": "read_file", "required_capability": "file_read",
        "effect": "read", "safe_summary_key": "agent.read_file",
        "parameters": {
            "type": "object",
            "properties": { "path": string_property(4096) },
            "required": ["path"],
        },
    }));
    table.push(json!({
        "schema_version": 1, "name": "write_file", "required_capability": "file_write",
        "effect": "write", "safe_summary_key": "agent.write_file",
        "parameters": {
            "type": "object",
            "properties": {
                "path": string_property(4096),
                "content": string_property(32768),
                "expected_revision": string_property(256),
            },
            "required": ["path", "content"],
        },
    }));
    table
}

/// `DSHAgentHJ("agent-toolset", {registry_version, tools})`: the digest every
/// stored authority is bound to.
pub fn toolset_sha256(guest_cgi: bool) -> Option<String> {
    hash_json(
        "agent-toolset",
        &json!({ "registry_version": 2, "tools": descriptors(guest_cgi) }),
    )
}

fn descriptor_named(name: &str, guest_cgi: bool) -> Option<Value> {
    descriptors(guest_cgi)
        .into_iter()
        .find(|descriptor| descriptor.get("name").and_then(Value::as_str) == Some(name))
}

/// The root's capability set, refused when it is not one.
fn capability_set(root: &Value) -> Option<Vec<&str>> {
    let Some(Value::Array(items)) = root.get("capabilities") else {
        return None;
    };
    if items.len() > 6 {
        return None;
    }
    let mut set: Vec<&str> = Vec::with_capacity(items.len());
    for item in items {
        let name = item.as_str()?;
        if !CAPABILITIES.contains(&name) || set.contains(&name) {
            return None;
        }
        set.push(name);
    }
    Some(set)
}

/// `DSHAgentRegistryAccessForName`: what this root lets this tool do, or
/// `None` when it does not offer it at all.
pub fn access_for(name: &str, capabilities: &[&str], project: bool) -> Option<&'static str> {
    let required = REQUIRED
        .iter()
        .find(|(tool, _)| *tool == name)
        .map(|(_, capability)| *capability)?;
    if !capabilities.contains(&required) || (name.starts_with("git_") && !project) {
        return None;
    }
    if matches!(name, "list_dir" | "read_file" | "git_status") {
        return Some("auto");
    }
    // git_push follows the git_commit pattern: per-conversation confirmation,
    // a recorded grant, and the same ledger and replay protection. Network
    // effects are still covered by the write-batch effect gate.
    Some("conversation_confirm")
}

fn safe_projection(descriptor: &Value, access: &str) -> Value {
    json!({
        "schema_version": 2,
        "name": descriptor.get("name"),
        "safe_summary_key": descriptor.get("safe_summary_key"),
        "access": access,
    })
}

/// A tool this root does not offer, or does not know, is projected as a
/// durable denial. The name is bounded and opaque — never a path or payload.
fn durable_deny(name: &str) -> Value {
    let safe = if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        "unknown"
    } else {
        name
    };
    json!({
        "schema_version": 2,
        "name": safe,
        "safe_summary_key": "agent.unknown",
        "access": "durable_deny",
    })
}

fn known_tool(name: &str) -> bool {
    REQUIRED.iter().any(|(tool, _)| *tool == name)
}

/// `DSHAgentRegistryShape`: a stored registry projection has to be exactly the
/// one this root and this build imply.
pub fn registry_shape(registry: &Value, root: &Value, guest_cgi: bool) -> bool {
    let Some(map) = exact_keys(
        Some(registry),
        &[
            "schema_version",
            "registry_version",
            "toolset_sha256",
            "tools",
        ],
    ) else {
        return false;
    };
    let Some(Value::Array(tools)) = map.get("tools") else {
        return false;
    };
    if map.get("schema_version") != Some(&json!(2))
        || map.get("registry_version") != Some(&json!(2))
        || !canonical_sha256(map.get("toolset_sha256"))
        || tools.len() > 8
        || !root_full(Some(root))
    {
        return false;
    }
    let Some(capabilities) = capability_set(root) else {
        return false;
    };
    let project = root.get("kind").and_then(Value::as_str) == Some("project");
    let mut previous: Option<&str> = None;
    let mut names: Vec<&str> = Vec::with_capacity(tools.len());
    for tool in tools {
        let keys = ["schema_version", "name", "safe_summary_key", "access"];
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            return false;
        };
        if exact_keys(Some(tool), &keys).is_none()
            || tool.get("schema_version") != Some(&json!(2))
            || bounded_utf8(tool.get("safe_summary_key"), 128, false).is_none()
            || !known_tool(name)
            || names.contains(&name)
            || previous.is_some_and(|previous| previous >= name)
        {
            return false;
        }
        let Some(access) = access_for(name, &capabilities, project) else {
            return false;
        };
        if tool.get("access").and_then(Value::as_str) != Some(access) {
            return false;
        }
        names.push(name);
        previous = Some(name);
    }
    let _ = guest_cgi;
    true
}

/// The registry this root implies, sorted by name.
pub fn registry_for_root(root: &Value, guest_cgi: bool) -> Result<Value, StoreError> {
    let digest = toolset_sha256(guest_cgi).ok_or(StoreError::InvalidArgument)?;
    if !root_full(Some(root)) || !canonical_sha256(Some(&json!(digest))) {
        return Err(StoreError::InvalidArgument);
    }
    let capabilities = capability_set(root).ok_or(StoreError::InvalidArgument)?;
    let project = root.get("kind").and_then(Value::as_str) == Some("project");
    let mut tools: Vec<Value> = descriptors(guest_cgi)
        .iter()
        .filter_map(|descriptor| {
            let name = descriptor.get("name").and_then(Value::as_str)?;
            access_for(name, &capabilities, project)
                .map(|access| safe_projection(descriptor, access))
        })
        .collect();
    // The table above is ASCII sorted; sort again so the invariant survives a
    // future edit that changes its source order.
    tools.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .cmp(&right.get("name").and_then(Value::as_str))
    });
    let registry = json!({
        "schema_version": 2,
        "registry_version": 2,
        "toolset_sha256": digest,
        "tools": tools,
    });
    if !registry_shape(&registry, root, guest_cgi) {
        return Err(StoreError::InvalidArgument);
    }
    Ok(registry)
}

/// The write policy, which does not vary by root but is still refused for one
/// that is not a root.
pub fn policy_for_root(root: &Value) -> Result<Value, StoreError> {
    if !root_full(Some(root)) {
        return Err(StoreError::InvalidArgument);
    }
    Ok(json!({
        "schema_version": 1,
        "policy_version": "agent-v1",
        "max_single_write_bytes": 32768,
        "max_batch_write_bytes": 524_288,
        "max_attempt_write_bytes": 4_194_304,
    }))
}

/// The safe projection for one tool name under this root: the tool as offered,
/// or a durable denial when the root does not offer it or does not know it.
pub fn descriptor_for_tool(name: &str, root: &Value, guest_cgi: bool) -> Result<Value, StoreError> {
    if !root_full(Some(root)) || bounded_utf8(Some(&json!(name)), 64, false).is_none() {
        return Err(StoreError::InvalidArgument);
    }
    let Some(descriptor) = descriptor_named(name, guest_cgi) else {
        return Ok(durable_deny(name));
    };
    let capabilities = capability_set(root).ok_or(StoreError::InvalidArgument)?;
    let project = root.get("kind").and_then(Value::as_str) == Some("project");
    Ok(match access_for(name, &capabilities, project) {
        Some(access) => safe_projection(&descriptor, access),
        None => durable_deny(name),
    })
}

/// The full descriptor, parameters and all, for building a provider request.
pub fn native_descriptor(name: &str, guest_cgi: bool) -> Result<Value, StoreError> {
    if bounded_utf8(Some(&json!(name)), 64, false).is_none() {
        return Err(StoreError::InvalidArgument);
    }
    descriptor_named(name, guest_cgi).ok_or(StoreError::NotFound)
}

/// `rish_agent_tool_registry_reduce`.
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
    // Whether this build has the guest CGI tools is the host's to say.
    let guest_cgi = envelope.get("guest_cgi") == Some(&Value::Bool(true));
    let root = || envelope.get("root").ok_or(StoreError::InvalidArgument);
    let name = || {
        envelope
            .get("name")
            .and_then(Value::as_str)
            .ok_or(StoreError::InvalidArgument)
    };
    match op {
        "toolset_sha256" => Ok(
            json!({ "toolset_sha256": toolset_sha256(guest_cgi).ok_or(StoreError::InvalidArgument)? }),
        ),
        "registry" => Ok(json!({ "registry": registry_for_root(root()?, guest_cgi)? })),
        "policy" => Ok(json!({ "policy": policy_for_root(root()?)? })),
        "descriptor" => {
            Ok(json!({ "descriptor": descriptor_for_tool(name()?, root()?, guest_cgi)? }))
        }
        "native_descriptor" => Ok(json!({ "descriptor": native_descriptor(name()?, guest_cgi)? })),
        "registry_shape" => {
            let registry = envelope
                .get("registry")
                .ok_or(StoreError::InvalidArgument)?;
            Ok(json!({ "valid": registry_shape(registry, root()?, guest_cgi) }))
        }
        _ => Err(StoreError::InvalidArgument),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_root(capabilities: Value) -> Value {
        json!({
            "schema_version": 1, "kind": "workspace",
            "workspace_id": "11111111-1111-4111-8111-111111111111",
            "project_id": null,
            "root_fingerprint_sha256": "c".repeat(64),
            "workspace_binding_revision": 1,
            "capabilities": capabilities,
        })
    }

    /// Every stored authority is bound to this digest, so the table's bytes
    /// are a compatibility contract, not an implementation detail. These two
    /// values were the ones the Objective-C table produced; a change to the
    /// table changes them and invalidates every authority on every device.
    #[test]
    fn the_toolset_digest_is_the_one_stored_authorities_are_bound_to() {
        assert_eq!(
            toolset_sha256(true).expect("digest"),
            "bbdeb99de07223175703fb9748e16444f1f89e0b072283d030be9017c2fdebd4"
        );
        assert_eq!(
            toolset_sha256(false).expect("digest"),
            "62e426ffac0cc058b8affcbc8744549eeb91bc9a99923bb1982ec42c47e8a60c"
        );
    }

    #[test]
    fn a_workspace_root_is_never_offered_a_git_tool() {
        // A workspace root may not even carry a git capability, so the
        // registry never has to decide whether to offer one.
        assert!(
            registry_for_root(&workspace_root(json!(["file_read", "git_commit"])), false).is_err()
        );
        let registry =
            registry_for_root(&workspace_root(json!(["file_read", "file_write"])), false)
                .expect("registry");
        let tools = registry["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], json!("list_dir"));
        assert_eq!(tools[1]["name"], json!("read_file"));
        assert_eq!(tools[2]["name"], json!("write_file"));
        assert_eq!(tools[0]["access"], json!("auto"));
        assert_eq!(tools[2]["access"], json!("conversation_confirm"));
    }

    #[test]
    fn a_tool_the_root_does_not_offer_is_a_durable_denial_not_an_error() {
        let root = workspace_root(json!(["file_read"]));
        let denied = descriptor_for_tool("write_file", &root, false).expect("projection");
        assert_eq!(denied["access"], json!("durable_deny"));
        assert_eq!(denied["safe_summary_key"], json!("agent.unknown"));
        // An unknown name is denied under a name that cannot carry a payload.
        let unknown = descriptor_for_tool("../../etc/passwd", &root, false).expect("projection");
        assert_eq!(unknown["name"], json!("unknown"));
    }

    #[test]
    fn a_registry_whose_access_disagrees_with_its_root_is_refused() {
        let root = workspace_root(json!(["file_read", "file_write"]));
        let mut registry = registry_for_root(&root, false).expect("registry");
        assert!(registry_shape(&registry, &root, false));
        registry["tools"][0]["access"] = json!("conversation_confirm");
        assert!(!registry_shape(&registry, &root, false));
    }
}
