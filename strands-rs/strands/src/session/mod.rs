//! Session persistence.
//!
//! Sessions save agent [`Snapshot`](crate::types::Snapshot)s to a [`Storage`](crate::storage::Storage)
//! under the layout shared with the other Strands SDKs, so agents in any of them can share a session:
//!
//! ```text
//! <sessionId>/scopes/<scope>/<scopeId>/snapshots/
//!   snapshot_latest.json
//!   manifest.json
//!   immutable_history/snapshot_<uuidv7>.json
//! ```
//!
//! Session, scope and snapshot ids match `^[a-z0-9_-]+$`; immutable snapshot ids are UUID v7s.
//! [`SessionManager`] attaches a session to an agent.

pub(crate) mod clock;
mod session_manager;
pub(crate) mod snapshot_storage_adapter;
mod types;
pub(crate) mod validation;

pub use session_manager::{SaveLatestStrategy, SessionManager, SessionManagerBuilder, SessionManagerConfig};
pub use types::{SnapshotManifest, SnapshotTriggerCallback, SnapshotTriggerParams};
