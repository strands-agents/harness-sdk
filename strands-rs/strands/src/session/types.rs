//! Session data shapes.

use serde::{Deserialize, Serialize};

use crate::agent::LocalAgent;
use crate::types::SNAPSHOT_SCHEMA_VERSION;

/// Snapshot metadata stored next to a scope's snapshots (`SnapshotManifest`), as
/// `manifest.json`.
///
/// ```
/// use strands::session::SnapshotManifest;
///
/// let manifest = SnapshotManifest::new("2026-11-11T12:00:00.000Z");
/// assert_eq!(
///     serde_json::to_string(&manifest).unwrap(),
///     r#"{"schemaVersion":"1.0","updatedAt":"2026-11-11T12:00:00.000Z"}"#
/// );
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SnapshotManifest {
    /// Schema version, for forward and backward compatibility.
    pub schema_version: String,
    /// ISO 8601 time of the last manifest update.
    pub updated_at: String,
}

impl SnapshotManifest {
    /// A manifest at the current schema version, updated at `updated_at`.
    pub fn new(updated_at: impl Into<String>) -> Self {
        Self {
            schema_version: SNAPSHOT_SCHEMA_VERSION.to_owned(),
            updated_at: updated_at.into(),
        }
    }

    /// Sets the schema version.
    #[must_use]
    pub fn with_schema_version(mut self, schema_version: impl Into<String>) -> Self {
        self.schema_version = schema_version.into();
        self
    }
}

/// What a [`SnapshotTriggerCallback`] sees when deciding whether to save an immutable snapshot
/// (`SnapshotTriggerParams`).
#[non_exhaustive]
pub struct SnapshotTriggerParams<'a> {
    /// The agent's current data, including its messages and state.
    pub agent_data: &'a LocalAgent,
}

impl<'a> SnapshotTriggerParams<'a> {
    pub(crate) fn new(agent_data: &'a LocalAgent) -> Self {
        Self { agent_data }
    }
}

crate::callback::callback! {
    /// Decides after each invocation whether to save an immutable snapshot
    /// (`SnapshotTriggerCallback`): `true` saves one.
    ///
    /// ```
    /// use strands::session::SnapshotTriggerCallback;
    /// use strands::storage::InMemoryStorage;
    /// use strands::SessionManager;
    ///
    /// let every_ten_messages =
    ///     SnapshotTriggerCallback::new(|params| params.agent_data.messages().len() % 10 == 0);
    /// let manager = SessionManager::builder()
    ///     .storage(InMemoryStorage::new())
    ///     .snapshot_trigger(every_ten_messages)
    ///     .build()?;
    /// # let _ = manager;
    /// # Ok::<(), strands::Error>(())
    /// ```
    pub struct SnapshotTriggerCallback(Fn(&SnapshotTriggerParams<'_>) -> bool);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn manifest_serializes_in_ts_key_order_and_reads_pretty_json() {
        let manifest = SnapshotManifest::new("2025-06-01T00:00:00.000Z");
        assert_eq!(
            serde_json::to_value(&manifest).unwrap(),
            json!({"schemaVersion": "1.0", "updatedAt": "2025-06-01T00:00:00.000Z"})
        );
        let pretty = "{\n  \"schemaVersion\": \"2.0\",\n  \"updatedAt\": \"x\"\n}";
        let parsed: SnapshotManifest = serde_json::from_str(pretty).unwrap();
        assert_eq!(parsed, SnapshotManifest::new("x").with_schema_version("2.0"));
    }
}
