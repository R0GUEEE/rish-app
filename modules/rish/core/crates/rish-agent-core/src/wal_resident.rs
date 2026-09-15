//! The WAL's committed state, held in the core instead of re-read from disk on
//! every transaction.
//!
//! The host still owns the file, the lock and the write. What moves here is
//! *who remembers what is committed*, and with it the one rule that is easy to
//! get wrong: **a write that failed is not a write that did not happen.** A
//! rename can fail after it took effect, and a confirmation can be lost. So a
//! transaction is confirmed in three states, never two, and an unknown
//! confirmation does not fall back to "not committed" — it makes the resident
//! state invalid, and only a fresh read from disk can make it usable again.

use serde_json::Value;

use crate::canonical::canonical_json;
use crate::store::StoreError;

/// What the host learned about the bytes it tried to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirmation {
    /// The bytes are durable: the rename took effect and was confirmed.
    Committed,
    /// The bytes provably never replaced the committed file — the write failed
    /// before the rename, or the host chose not to write them.
    NotCommitted,
    /// Neither could be established. The file on disk may or may not be the
    /// candidate.
    Unknown,
}

impl Confirmation {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "committed" => Some(Self::Committed),
            "not_committed" => Some(Self::NotCommitted),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

/// One storage root's committed state, plus at most one candidate transaction
/// waiting for its confirmation.
#[derive(Debug, Clone)]
pub struct Resident {
    committed: Value,
    candidate: Option<Value>,
    /// Set by an unknown confirmation and never cleared: this handle can no
    /// longer say what is on disk, and nothing may be served from it.
    invalid: bool,
}

impl Resident {
    /// Adopts a state the host has just read and validated.
    pub fn open(committed: Value) -> Self {
        Self {
            committed,
            candidate: None,
            invalid: false,
        }
    }

    /// The committed state, or `None` once this handle has been invalidated.
    pub fn snapshot(&self) -> Option<&Value> {
        if self.invalid {
            return None;
        }
        Some(&self.committed)
    }

    pub fn is_invalid(&self) -> bool {
        self.invalid
    }

    /// Whether a candidate is waiting for its confirmation.
    pub fn has_candidate(&self) -> bool {
        self.candidate.is_some()
    }

    /// Takes a candidate state and returns the exact bytes the host must write.
    /// One candidate at a time: a second `begin` before the first is confirmed
    /// would mean the host is writing two things at once, which the WAL's own
    /// lock is supposed to prevent.
    pub fn begin(&mut self, candidate: Value) -> Result<Vec<u8>, StoreError> {
        if self.invalid {
            return Err(StoreError::Unavailable);
        }
        if self.candidate.is_some() {
            return Err(StoreError::Conflict);
        }
        let bytes = canonical_json(&candidate).map_err(|_| StoreError::Corrupt)?;
        self.candidate = Some(candidate);
        Ok(bytes)
    }

    /// Resolves the outstanding candidate. Returns whether the committed state
    /// moved.
    pub fn confirm(&mut self, confirmation: Confirmation) -> Result<bool, StoreError> {
        if self.invalid {
            return Err(StoreError::Unavailable);
        }
        let Some(candidate) = self.candidate.take() else {
            return Err(StoreError::InvalidArgument);
        };
        match confirmation {
            Confirmation::Committed => {
                self.committed = candidate;
                Ok(true)
            }
            Confirmation::NotCommitted => Ok(false),
            Confirmation::Unknown => {
                // The candidate is neither published nor discarded, because
                // which of those is true is exactly what is not known. The
                // handle stops answering instead of guessing.
                self.invalid = true;
                Err(StoreError::Persistence)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resident() -> Resident {
        Resident::open(json!({ "schema_version": 2, "generation": 1 }))
    }

    #[test]
    fn a_confirmed_commit_publishes_the_candidate() {
        let mut resident = resident();
        let bytes = resident
            .begin(json!({ "schema_version": 2, "generation": 2 }))
            .expect("candidate");
        assert_eq!(bytes, br#"{"generation":2,"schema_version":2}"#.to_vec());
        assert!(resident.confirm(Confirmation::Committed).expect("confirm"));
        assert_eq!(resident.snapshot().expect("state")["generation"], json!(2));
    }

    #[test]
    fn a_write_that_provably_did_not_land_leaves_the_state_alone() {
        let mut resident = resident();
        resident
            .begin(json!({ "generation": 2 }))
            .expect("candidate");
        assert!(!resident
            .confirm(Confirmation::NotCommitted)
            .expect("confirm"));
        assert_eq!(resident.snapshot().expect("state")["generation"], json!(1));
        // And the handle is still usable: nothing was lost.
        resident
            .begin(json!({ "generation": 2 }))
            .expect("candidate again");
    }

    #[test]
    fn an_unknown_confirmation_is_never_downgraded_to_not_committed() {
        let mut resident = resident();
        resident
            .begin(json!({ "generation": 2 }))
            .expect("candidate");
        assert_eq!(
            resident.confirm(Confirmation::Unknown),
            Err(StoreError::Persistence)
        );
        assert!(resident.is_invalid());
        // Neither the old state nor the candidate may be served: only a fresh
        // read from disk can say which one is there.
        assert!(resident.snapshot().is_none());
        assert_eq!(
            resident.begin(json!({ "generation": 3 })),
            Err(StoreError::Unavailable)
        );
        assert_eq!(
            resident.confirm(Confirmation::Committed),
            Err(StoreError::Unavailable)
        );
    }

    #[test]
    fn one_candidate_at_a_time() {
        let mut resident = resident();
        resident
            .begin(json!({ "generation": 2 }))
            .expect("candidate");
        assert_eq!(
            resident.begin(json!({ "generation": 3 })),
            Err(StoreError::Conflict)
        );
        assert!(resident.has_candidate());
    }

    #[test]
    fn a_confirmation_without_a_candidate_is_refused() {
        let mut resident = resident();
        assert_eq!(
            resident.confirm(Confirmation::Committed),
            Err(StoreError::InvalidArgument)
        );
    }
}
