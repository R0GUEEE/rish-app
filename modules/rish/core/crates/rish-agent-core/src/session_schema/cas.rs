//! The session store's CAS decisions, ported from `casPersistSessionLocked:`,
//! `querySessionCommit:`, `persistSessionWithWorkspaceClearance:` and
//! `queryWorkspaceClearance:`. Every function is a pure decision over a
//! [`Loaded`] view the host reads from disk; the host keeps the locks, the
//! reads, the atomic writes and the post-write verification read, and calls
//! back in between with what it observed.

use super::primitives::{
    canonical_digest, canonical_operation_id, exact_keys, exact_schema, safe_integer,
    MAX_SAFE_INTEGER,
};
use super::{validate_candidate, Env, SessionError, MAX_BYTES, MAX_RECENT_COMMITS, MAX_TOMBSTONES};
use crate::canonical::canonical_json;
use crate::execution_ledger::{as_str, get};
use serde_json::{json, Value};

/// One entry of a v3 envelope's `recent_commits`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub operation_id: String,
    pub generation: u64,
    pub session_sha256: String,
}

impl Commit {
    fn to_json(&self) -> Value {
        json!({
            "schema_version": 1,
            "operation_id": self.operation_id,
            "generation": self.generation,
            "session_sha256": self.session_sha256,
        })
    }
}

/// What `readTombstoneStateWithError:` observed: `missing` (no file),
/// `valid` (a well-formed ledger) or neither (unreadable or malformed).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TombstoneView {
    pub missing: bool,
    pub valid: bool,
    pub generation: u64,
    pub operation_ids: Vec<String>,
}

/// What `readStateWithError:` observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded {
    Missing,
    Legacy {
        legacy_bytes_sha256: String,
    },
    Present {
        generation: u64,
        session_sha256: String,
        recent_commits: Vec<Commit>,
        /// The tombstone ledger read right after the envelope, if the host
        /// read it (`None` when that read failed).
        tombstones: Option<TombstoneView>,
        /// `operation_id` of every `workspace_authority_outbox` entry in the
        /// stored session.
        outbox_operation_ids: Vec<String>,
    },
}

impl Loaded {
    /// The authority token the host reports for this state.
    pub fn authority(&self) -> Value {
        match self {
            Loaded::Missing => json!({ "schema_version": 1, "kind": "missing" }),
            Loaded::Legacy {
                legacy_bytes_sha256,
            } => json!({
                "schema_version": 1,
                "kind": "legacy_present",
                "legacy": { "schema_version": 1, "legacy_bytes_sha256": legacy_bytes_sha256 },
            }),
            Loaded::Present {
                generation,
                session_sha256,
                ..
            } => json!({
                "schema_version": 1,
                "kind": "present",
                "snapshot": snapshot_ref(*generation, session_sha256),
            }),
        }
    }

    fn commits(&self) -> &[Commit] {
        match self {
            Loaded::Present { recent_commits, .. } => recent_commits,
            _ => &[],
        }
    }

    fn commit_for(&self, operation_id: &str) -> Option<&Commit> {
        self.commits()
            .iter()
            .find(|commit| commit.operation_id == operation_id)
    }

    /// `state.tombstoneAvailable`: the ledger can prove absence for this
    /// generation.
    fn tombstone_available(&self) -> bool {
        let Loaded::Present {
            generation,
            tombstones: Some(tombstones),
            ..
        } = self
        else {
            return false;
        };
        let within_history = *generation <= MAX_RECENT_COMMITS as u64;
        (tombstones.valid && (within_history || tombstones.generation >= *generation))
            || (tombstones.missing && within_history)
    }
}

pub fn snapshot_ref(generation: u64, digest: &str) -> Value {
    json!({ "schema_version": 1, "generation": generation, "session_sha256": digest })
}

/// `validateAuthority:`.
pub fn authority_valid(authority: Option<&Value>) -> bool {
    let Some(authority) = authority.filter(|a| a.is_object()) else {
        return false;
    };
    if !exact_schema(get(authority, "schema_version"), 1) {
        return false;
    }
    match as_str(get(authority, "kind")) {
        Some("missing") => exact_keys(authority, &["schema_version", "kind"]),
        Some("legacy_present") => {
            let legacy = get(authority, "legacy");
            exact_keys(authority, &["schema_version", "kind", "legacy"])
                && legacy.is_some_and(|l| exact_keys(l, &["schema_version", "legacy_bytes_sha256"]))
                && exact_schema(legacy.and_then(|l| get(l, "schema_version")), 1)
                && canonical_digest(legacy.and_then(|l| get(l, "legacy_bytes_sha256")))
        }
        Some("present") => {
            let snapshot = get(authority, "snapshot");
            exact_keys(authority, &["schema_version", "kind", "snapshot"])
                && snapshot.is_some_and(|s| {
                    exact_keys(s, &["schema_version", "generation", "session_sha256"])
                })
                && exact_schema(snapshot.and_then(|s| get(s, "schema_version")), 1)
                && safe_integer(snapshot.and_then(|s| get(s, "generation")), false).is_some()
                && canonical_digest(snapshot.and_then(|s| get(s, "session_sha256")))
        }
        _ => false,
    }
}

/// The CAS request's pure shape: `{schema_version:1, operation_id, expected,
/// candidate_json}` with a well-formed authority. The host checks that
/// `candidate_json` is a string before handing its bytes over.
pub fn cas_request_valid(request: &Value) -> bool {
    exact_keys(
        request,
        &[
            "schema_version",
            "operation_id",
            "expected",
            "candidate_json",
        ],
    ) && exact_schema(get(request, "schema_version"), 1)
        && canonical_operation_id(get(request, "operation_id"))
        && get(request, "candidate_json").is_some_and(Value::is_string)
        && authority_valid(get(request, "expected"))
}

/// The outcome of the first look at the state under the lock.
#[derive(Debug, Clone, PartialEq)]
pub enum Precheck {
    /// The operation already committed with this exact candidate.
    Committed {
        snapshot: Value,
    },
    /// The operation committed a different candidate, or `expected` is not
    /// the current authority.
    Conflict {
        current: Value,
    },
    Proceed,
}

/// The replay-by-operation-id and expected-authority checks that precede the
/// re-read.
pub fn cas_precheck(
    operation_id: &str,
    expected: &Value,
    candidate_digest: &str,
    state: &Loaded,
) -> Precheck {
    if let Some(commit) = state.commit_for(operation_id) {
        if commit.session_sha256 == candidate_digest {
            return Precheck::Committed {
                snapshot: snapshot_ref(commit.generation, &commit.session_sha256),
            };
        }
        return Precheck::Conflict {
            current: state.authority(),
        };
    }
    if *expected != state.authority() {
        return Precheck::Conflict {
            current: state.authority(),
        };
    }
    Precheck::Proceed
}

/// The bytes the host writes for one commit.
#[derive(Debug, Clone, PartialEq)]
pub struct WritePlan {
    pub next_generation: u64,
    pub recent_commits: Vec<Commit>,
    pub tombstone_json: String,
    pub envelope_json: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    Conflict { current: Value },
    Unknown { current: Value },
    Write(WritePlan),
}

/// Everything between the re-read and the writes: the expected-authority
/// re-check, the tombstone-ledger rules, the next generation, the commit
/// chain, the tombstone envelope and the v3 envelope bytes.
pub fn cas_plan(
    operation_id: &str,
    expected: &Value,
    candidate: &[u8],
    env: &Env,
    current: &Loaded,
    tombstones: Option<&TombstoneView>,
    launch_instance_id: &str,
) -> Result<Plan, SessionError> {
    let accepted = validate_candidate(candidate, env)?;
    let current_authority = current.authority();
    if *expected != current_authority {
        return Ok(Plan::Conflict {
            current: current_authority,
        });
    }
    let Some(tombstones) = tombstones else {
        return Ok(Plan::Unknown {
            current: current_authority,
        });
    };
    if !tombstones.valid && !tombstones.missing {
        return Ok(Plan::Unknown {
            current: current_authority,
        });
    }
    let (generation, commits) = match current {
        Loaded::Present {
            generation,
            recent_commits,
            ..
        } => (Some(*generation), recent_commits.as_slice()),
        _ => (None, &[][..]),
    };
    if let Some(generation) = generation {
        if generation > commits.len() as u64
            && (!tombstones.valid || tombstones.generation < generation)
        {
            return Ok(Plan::Unknown {
                current: current_authority,
            });
        }
    }
    if tombstones.valid && tombstones.operation_ids.iter().any(|id| id == operation_id) {
        return Ok(Plan::Unknown {
            current: current_authority,
        });
    }
    let next_generation = generation.map_or(1, |g| g + 1);
    if next_generation == 0 || next_generation > MAX_SAFE_INTEGER {
        return Err(SessionError::Bounds);
    }
    let mut chain: Vec<Commit> = commits.to_vec();
    chain.push(Commit {
        operation_id: operation_id.to_string(),
        generation: next_generation,
        session_sha256: accepted.digest.clone(),
    });
    while chain.len() > MAX_RECENT_COMMITS {
        chain.remove(0);
    }
    let mut tombstoned: Vec<String> = Vec::new();
    if generation.is_some_and(|g| g > MAX_RECENT_COMMITS as u64) {
        let mut retained = tombstones.operation_ids.clone();
        retained.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        tombstoned.extend(retained);
    }
    if commits.len() == MAX_RECENT_COMMITS {
        let evicted = &commits[0].operation_id;
        if !tombstoned.iter().any(|id| id == evicted) {
            tombstoned.push(evicted.clone());
        }
    }
    if tombstoned.len() > MAX_TOMBSTONES {
        return Err(SessionError::Bounds);
    }
    let tombstone_envelope = json!({
        "schema_version": 1,
        "generation": next_generation,
        "operation_ids": tombstoned,
    });
    let tombstone_bytes =
        canonical_json(&tombstone_envelope).map_err(|_| SessionError::InvalidArgument)?;
    if tombstone_bytes.is_empty() || tombstone_bytes.len() > MAX_BYTES {
        return Err(SessionError::Bounds);
    }
    let envelope = json!({
        "schema_version": 3,
        "writer_launch_instance_id": launch_instance_id,
        "generation": next_generation,
        "session_sha256": accepted.digest,
        "session": accepted.session,
        "recent_commits": chain.iter().map(Commit::to_json).collect::<Vec<_>>(),
        "proof_run_id": Value::Null,
        "proof_request_id": Value::Null,
    });
    let envelope_bytes = canonical_json(&envelope).map_err(|_| SessionError::InvalidArgument)?;
    if envelope_bytes.is_empty() || envelope_bytes.len() > MAX_BYTES {
        return Err(SessionError::InvalidArgument);
    }
    Ok(Plan::Write(WritePlan {
        next_generation,
        recent_commits: chain,
        tombstone_json: String::from_utf8(tombstone_bytes)
            .map_err(|_| SessionError::InvalidArgument)?,
        envelope_json: String::from_utf8(envelope_bytes)
            .map_err(|_| SessionError::InvalidArgument)?,
    }))
}

/// The post-write read-back: the file must show the generation, digest and
/// last operation the plan wrote.
pub fn cas_verified(
    operation_id: &str,
    next_generation: u64,
    candidate_digest: &str,
    verified: Option<&Loaded>,
) -> bool {
    match verified {
        Some(Loaded::Present {
            generation,
            session_sha256,
            recent_commits,
            ..
        }) => {
            *generation == next_generation
                && session_sha256 == candidate_digest
                && recent_commits
                    .last()
                    .is_some_and(|c| c.operation_id == operation_id)
        }
        _ => false,
    }
}

/// `querySessionCommit:` over a state the host read (`None` when the read
/// failed).
pub fn query_commit(operation_id: &str, state: Option<&Loaded>) -> Value {
    let Some(state) = state else {
        return json!({ "schema_version": 1, "status": "unknown" });
    };
    let Loaded::Present {
        generation,
        recent_commits,
        tombstones,
        ..
    } = state
    else {
        return json!({ "schema_version": 1, "status": "not_started" });
    };
    if let Some(commit) = state.commit_for(operation_id) {
        return json!({
            "schema_version": 1,
            "status": "committed",
            "snapshot": snapshot_ref(commit.generation, &commit.session_sha256),
        });
    }
    let history_evicted = *generation > recent_commits.len() as u64;
    let tombstoned = tombstones
        .as_ref()
        .is_some_and(|t| t.operation_ids.iter().any(|id| id == operation_id));
    let tombstone_proves_absence = !history_evicted || (state.tombstone_available() && !tombstoned);
    let full_history_retained = !history_evicted
        && recent_commits.len() as u64 == *generation
        && recent_commits.first().is_some_and(|c| c.generation == 1);
    json!({
        "schema_version": 1,
        "status": if full_history_retained || tombstone_proves_absence { "not_started" } else { "unknown" },
    })
}

/// `DSHSessionCandidateReferencesWorkspace`.
pub fn candidate_references_workspace(candidate: &Value, workspace_id: Option<&Value>) -> bool {
    let (Some(Value::Array(conversations)), Some(Value::String(workspace_id))) =
        (get(candidate, "conversations"), workspace_id)
    else {
        return true;
    };
    for conversation in conversations {
        if !conversation.is_object() {
            return true;
        }
        let matches = |value: Option<&Value>| {
            value.is_some_and(|v| !v.is_null() && v == &Value::String(workspace_id.clone()))
        };
        if matches(get(conversation, "workspace_id")) {
            return true;
        }
        if let Some(binding) = get(conversation, "workspace_binding").filter(|b| !b.is_null()) {
            if get(binding, "workspace_id") == Some(&Value::String(workspace_id.clone())) {
                return true;
            }
        }
        if let Some(Value::Array(attempts)) = get(conversation, "attempts") {
            for attempt in attempts {
                if !attempt.is_object() || matches(get(attempt, "workspace_id")) {
                    return true;
                }
            }
        }
    }
    false
}

/// The clearance path's candidate checks after acceptance: the operation
/// must appear unchanged in the candidate's `workspace_authority_outbox`,
/// and nothing in the candidate may still reference the workspace.
/// `Ok(())` to proceed, `Err(Conflict)` otherwise.
pub fn clearance_candidate_check(
    candidate: &[u8],
    env: &Env,
    operation: &Value,
) -> Result<(), SessionError> {
    let accepted = validate_candidate(candidate, env)?;
    let operation_id = get(operation, "operation_id");
    let mut in_candidate = false;
    if let Some(Value::Array(entries)) = get(&accepted.session, "workspace_authority_outbox") {
        for entry in entries {
            if get(entry, "operation_id").is_some() && get(entry, "operation_id") == operation_id {
                in_candidate = true;
                if entry != operation {
                    return Err(SessionError::Conflict);
                }
            }
        }
    }
    if !in_candidate
        || candidate_references_workspace(&accepted.session, get(operation, "workspace_id"))
    {
        return Err(SessionError::Conflict);
    }
    Ok(())
}

/// The clearance path's replay rule: a replayed operation is idempotent
/// only while it still describes the current authority. `false` means
/// `not_committed`.
pub fn clearance_replay_allowed(operation_id: &str, state: &Loaded) -> bool {
    let Loaded::Present {
        generation,
        session_sha256,
        ..
    } = state
    else {
        return true;
    };
    match state.commit_for(operation_id) {
        Some(commit) => {
            commit.generation == *generation && commit.session_sha256 == *session_sha256
        }
        None => true,
    }
}

/// `queryWorkspaceClearance:`: once the session store has durably observed
/// the operation (a commit or an outbox entry), a missing receipt is not
/// provable absence.
pub fn clearance_operation_observed(operation_id: &str, state: &Loaded) -> bool {
    let Loaded::Present {
        outbox_operation_ids,
        ..
    } = state
    else {
        return false;
    };
    state.commit_for(operation_id).is_some()
        || outbox_operation_ids.iter().any(|id| id == operation_id)
}

// MARK: - JSON views

fn commit_from_json(value: &Value) -> Option<Commit> {
    Some(Commit {
        operation_id: as_str(get(value, "operation_id"))?.to_string(),
        generation: get(value, "generation").and_then(Value::as_u64)?,
        session_sha256: as_str(get(value, "session_sha256"))?.to_string(),
    })
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|i| as_str(Some(i)).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// `{missing, valid, generation, operation_ids}`; `null` means the read failed.
pub fn tombstones_from_json(value: Option<&Value>) -> Option<TombstoneView> {
    let value = value.filter(|v| v.is_object())?;
    Some(TombstoneView {
        missing: get(value, "missing") == Some(&Value::Bool(true)),
        valid: get(value, "valid") == Some(&Value::Bool(true)),
        generation: get(value, "generation")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        operation_ids: strings(get(value, "operation_ids")),
    })
}

/// `{"kind":"missing"}`, `{"kind":"legacy","legacy_bytes_sha256"}` or
/// `{"kind":"present","generation","session_sha256","recent_commits",
/// "tombstones"?, "outbox_operation_ids"?}`; `null` or malformed means the
/// read failed.
pub fn loaded_from_json(value: Option<&Value>) -> Option<Loaded> {
    let value = value.filter(|v| v.is_object())?;
    match as_str(get(value, "kind"))? {
        "missing" => Some(Loaded::Missing),
        "legacy" => Some(Loaded::Legacy {
            legacy_bytes_sha256: as_str(get(value, "legacy_bytes_sha256"))?.to_string(),
        }),
        "present" => {
            let Some(Value::Array(commits)) = get(value, "recent_commits") else {
                return None;
            };
            Some(Loaded::Present {
                generation: get(value, "generation").and_then(Value::as_u64)?,
                session_sha256: as_str(get(value, "session_sha256"))?.to_string(),
                recent_commits: commits
                    .iter()
                    .map(commit_from_json)
                    .collect::<Option<Vec<_>>>()?,
                tombstones: tombstones_from_json(get(value, "tombstones")),
                outbox_operation_ids: strings(get(value, "outbox_operation_ids")),
            })
        }
        _ => None,
    }
}

/// Dispatches the CAS ops of the session reducer. `request` is the parsed
/// `{"op", ...}` envelope, `input` the candidate bytes where an op takes them.
pub(super) fn reduce(
    op: &str,
    request: &Value,
    input: &[u8],
    env: &Env,
) -> Result<Value, SessionError> {
    let operation_id = || as_str(get(request, "operation_id")).ok_or(SessionError::InvalidArgument);
    match op {
        "cas_request" => {
            if !cas_request_valid(get(request, "request").ok_or(SessionError::InvalidArgument)?) {
                return Err(SessionError::InvalidArgument);
            }
            Ok(json!({}))
        }
        "cas_precheck" => {
            let expected = get(request, "expected").ok_or(SessionError::InvalidArgument)?;
            let digest =
                as_str(get(request, "candidate_digest")).ok_or(SessionError::InvalidArgument)?;
            let state =
                loaded_from_json(get(request, "state")).ok_or(SessionError::InvalidArgument)?;
            Ok(
                match cas_precheck(operation_id()?, expected, digest, &state) {
                    Precheck::Committed { snapshot } => {
                        json!({ "outcome": "committed", "snapshot": snapshot })
                    }
                    Precheck::Conflict { current } => {
                        json!({ "outcome": "conflict", "current": current })
                    }
                    Precheck::Proceed => json!({ "outcome": "proceed" }),
                },
            )
        }
        "cas_plan" => {
            let expected = get(request, "expected").ok_or(SessionError::InvalidArgument)?;
            let current =
                loaded_from_json(get(request, "current")).ok_or(SessionError::InvalidArgument)?;
            let tombstones = tombstones_from_json(get(request, "tombstones"));
            let launch =
                as_str(get(request, "launch_instance_id")).ok_or(SessionError::InvalidArgument)?;
            Ok(
                match cas_plan(
                    operation_id()?,
                    expected,
                    input,
                    env,
                    &current,
                    tombstones.as_ref(),
                    launch,
                )? {
                    Plan::Conflict { current } => {
                        json!({ "outcome": "conflict", "current": current })
                    }
                    Plan::Unknown { current } => {
                        json!({ "outcome": "unknown", "current": current })
                    }
                    Plan::Write(plan) => json!({
                        "outcome": "write",
                        "next_generation": plan.next_generation,
                        "recent_commits": plan.recent_commits.iter().map(Commit::to_json).collect::<Vec<_>>(),
                        "tombstone_json": plan.tombstone_json,
                        "envelope_json": plan.envelope_json,
                    }),
                },
            )
        }
        "cas_verify" => {
            let next = get(request, "next_generation")
                .and_then(Value::as_u64)
                .ok_or(SessionError::InvalidArgument)?;
            let digest =
                as_str(get(request, "candidate_digest")).ok_or(SessionError::InvalidArgument)?;
            let verified = loaded_from_json(get(request, "verified"));
            Ok(
                json!({ "committed": cas_verified(operation_id()?, next, digest, verified.as_ref()) }),
            )
        }
        "query_request" => {
            let query = get(request, "request").ok_or(SessionError::InvalidArgument)?;
            if !exact_keys(query, &["schema_version", "operation_id"])
                || !exact_schema(get(query, "schema_version"), 1)
                || !canonical_operation_id(get(query, "operation_id"))
            {
                return Err(SessionError::InvalidArgument);
            }
            Ok(json!({}))
        }
        "query_commit" => {
            let state = loaded_from_json(get(request, "state"));
            Ok(json!({ "result": query_commit(operation_id()?, state.as_ref()) }))
        }
        "clearance_candidate" => {
            let operation = get(request, "operation").ok_or(SessionError::InvalidArgument)?;
            clearance_candidate_check(input, env, operation)?;
            Ok(json!({}))
        }
        "clearance_replay" => {
            let state =
                loaded_from_json(get(request, "state")).ok_or(SessionError::InvalidArgument)?;
            Ok(json!({ "allowed": clearance_replay_allowed(operation_id()?, &state) }))
        }
        "clearance_observed" => {
            let state =
                loaded_from_json(get(request, "state")).ok_or(SessionError::InvalidArgument)?;
            Ok(json!({ "observed": clearance_operation_observed(operation_id()?, &state) }))
        }
        _ => Err(SessionError::InvalidArgument),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn present(
        generation: u64,
        commits: &[(u64, &str)],
        tombstones: Option<TombstoneView>,
    ) -> Loaded {
        Loaded::Present {
            generation,
            session_sha256: commits.last().map(|c| c.1.to_string()).unwrap_or_default(),
            recent_commits: commits
                .iter()
                .map(|(g, d)| Commit {
                    operation_id: format!("op-{g}"),
                    generation: *g,
                    session_sha256: d.to_string(),
                })
                .collect(),
            tombstones,
            outbox_operation_ids: Vec::new(),
        }
    }

    #[test]
    fn precheck_replays_and_conflicts() {
        let state = present(2, &[(1, "a"), (2, "b")], None);
        assert_eq!(
            cas_precheck("op-2", &state.authority(), "b", &state),
            Precheck::Committed {
                snapshot: snapshot_ref(2, "b")
            }
        );
        assert_eq!(
            cas_precheck("op-2", &state.authority(), "c", &state),
            Precheck::Conflict {
                current: state.authority()
            }
        );
        assert_eq!(
            cas_precheck("op-3", &Loaded::Missing.authority(), "c", &state),
            Precheck::Conflict {
                current: state.authority()
            }
        );
        assert_eq!(
            cas_precheck("op-3", &state.authority(), "c", &state),
            Precheck::Proceed
        );
    }

    #[test]
    fn query_commit_reasons_about_tombstones() {
        let full = present(2, &[(1, "a"), (2, "b")], None);
        assert_eq!(query_commit("op-9", Some(&full))["status"], "not_started");
        assert_eq!(query_commit("op-1", Some(&full))["status"], "committed");
        let evicted = present(70, &[(70, "z")], None);
        assert_eq!(query_commit("op-9", Some(&evicted))["status"], "unknown");
        let proven = present(
            70,
            &[(70, "z")],
            Some(TombstoneView {
                missing: false,
                valid: true,
                generation: 70,
                operation_ids: vec![],
            }),
        );
        assert_eq!(query_commit("op-9", Some(&proven))["status"], "not_started");
        let tombstoned = present(
            70,
            &[(70, "z")],
            Some(TombstoneView {
                missing: false,
                valid: true,
                generation: 70,
                operation_ids: vec!["op-9".into()],
            }),
        );
        assert_eq!(query_commit("op-9", Some(&tombstoned))["status"], "unknown");
        assert_eq!(query_commit("op-9", None)["status"], "unknown");
        assert_eq!(
            query_commit("op-9", Some(&Loaded::Missing))["status"],
            "not_started"
        );
    }

    #[test]
    fn authority_shapes() {
        assert!(authority_valid(Some(&Loaded::Missing.authority())));
        assert!(authority_valid(Some(
            &Loaded::Legacy {
                legacy_bytes_sha256: "0".repeat(64)
            }
            .authority()
        )));
        assert!(authority_valid(Some(
            &present(3, &[(3, &"a".repeat(64))], None).authority()
        )));
        assert!(!authority_valid(Some(
            &json!({ "schema_version": 1, "kind": "present" })
        )));
        assert!(!authority_valid(Some(
            &json!({ "schema_version": 1, "kind": "missing", "extra": 1 })
        )));
    }
}
