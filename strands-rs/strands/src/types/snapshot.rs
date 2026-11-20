//! Snapshot types shared by agent and multi-agent snapshots.

use serde::{Deserialize, Serialize};

use super::json::JsonObject;

/// The current snapshot schema version (`SNAPSHOT_SCHEMA_VERSION`).
pub const SNAPSHOT_SCHEMA_VERSION: &str = "1.0";

/// The context a snapshot belongs to (`Scope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum Scope {
    /// An agent, `"agent"`.
    Agent,
    /// A multi-agent orchestrator, `"multiAgent"`.
    MultiAgent,
}

/// A point-in-time capture of agent or orchestrator state (`Snapshot`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Snapshot {
    /// The context the snapshot belongs to.
    pub scope: Scope,
    /// Schema version, for forward compatibility.
    pub schema_version: String,
    /// ISO 8601 creation time in UTC with milliseconds, such as `2026-11-11T12:00:00.000Z`.
    pub created_at: String,
    /// Framework-owned state.
    pub data: JsonObject,
    /// Application-owned data. Strands never reads or modifies it.
    pub app_data: JsonObject,
}

impl Snapshot {
    /// Creates a snapshot at the current schema version with empty app data.
    pub fn new(scope: Scope, created_at: impl Into<String>, data: JsonObject) -> Self {
        Self {
            scope,
            schema_version: SNAPSHOT_SCHEMA_VERSION.to_owned(),
            created_at: created_at.into(),
            data,
            app_data: JsonObject::new(),
        }
    }

    /// Sets the application-owned data.
    #[must_use]
    pub fn with_app_data(mut self, app_data: JsonObject) -> Self {
        self.app_data = app_data;
        self
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn snapshot_serializes_in_ts_key_order() {
        let mut data = JsonObject::new();
        data.insert("messages".into(), json!([]));
        let snapshot = Snapshot::new(Scope::Agent, "2026-11-11T12:00:00.000Z", data)
            .with_app_data(json!({"k": 1}).as_object().unwrap().clone());
        assert_eq!(
            serde_json::to_string(&snapshot).unwrap(),
            r#"{"scope":"agent","schemaVersion":"1.0","createdAt":"2026-11-11T12:00:00.000Z","data":{"messages":[]},"appData":{"k":1}}"#
        );
    }

    #[test]
    fn multi_agent_scope_uses_camel_case() {
        assert_eq!(serde_json::to_value(Scope::MultiAgent).unwrap(), json!("multiAgent"));
    }
}
