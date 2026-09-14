//! The WAL store error vocabulary shared by every typed view.

/// `DSHAgentNativeStoreErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    InvalidArgument = 1,
    Corrupt = 2,
    Conflict = 3,
    Capacity = 4,
    Unavailable = 5,
    OwnerLost = 6,
    NotFound = 7,
    Persistence = 8,
}

impl StoreError {
    pub fn code(self) -> u8 {
        self as u8
    }
}
