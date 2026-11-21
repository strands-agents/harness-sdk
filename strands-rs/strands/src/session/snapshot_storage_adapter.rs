//! Snapshot persistence on a [`Storage`].
//!
//! Keys, relative to the storage the adapter is given:
//!
//! ```text
//! <sessionId>/scopes/<scope>/<scopeId>/snapshots/
//!   snapshot_latest.json
//!   manifest.json
//!   immutable_history/snapshot_<uuidv7>.json
//! ```
//!
//! Callers choose the namespace by the storage they pass: the session manager scopes a
//! non-namespaced storage under `session`, and `LocalFileStorage::new(dir).namespace("sessions")`
//! gives the session paths shared with the other Strands harness SDKs. Writes are compact JSON;
//! reads also accept pretty-printed JSON, a UTF-8 byte-order mark and invalid UTF-8 (replaced
//! with U+FFFD).

use std::sync::Arc;

use futures::future::try_join_all;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::types::SnapshotManifest;
use super::validation::{scope_name, validate_identifier, validate_uuid_v7};
use crate::clock::Clock;
use crate::error::{Result, SessionError};
use crate::storage::Storage;
use crate::types::{Scope, Snapshot};

/// Keys deleted concurrently per batch by [`SnapshotStorageAdapter::delete_session`].
const DELETE_BATCH_SIZE: usize = 100;

/// Where a scope's snapshots live (`SnapshotLocation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SnapshotLocation {
    pub(crate) session_id: String,
    pub(crate) scope: Scope,
    /// The agent id or multi-agent id.
    pub(crate) scope_id: String,
}

impl SnapshotLocation {
    pub(crate) fn new(session_id: impl Into<String>, scope: Scope, scope_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            scope,
            scope_id: scope_id.into(),
        }
    }
}

/// Saves and loads snapshots and manifests as JSON in a [`Storage`] (`SnapshotStorageAdapter`).
#[derive(Clone)]
pub(crate) struct SnapshotStorageAdapter {
    storage: Arc<dyn Storage>,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "manifests are part of the SnapshotStorage interface; no caller reads them yet (an allow: rustc 1.96 does not report it, later versions do)"
        )
    )]
    clock: Clock,
}

impl SnapshotStorageAdapter {
    pub(crate) fn new(storage: Arc<dyn Storage>) -> Self {
        Self {
            storage,
            clock: Clock::system(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// Writes `snapshot` as the scope's latest snapshot, or as immutable history under
    /// `snapshot_id`.
    pub(crate) async fn save_snapshot(
        &self,
        location: &SnapshotLocation,
        snapshot_id: &str,
        is_latest: bool,
        snapshot: &Snapshot,
    ) -> Result<()> {
        let key = if is_latest {
            latest_key(location)?
        } else {
            history_key(location, snapshot_id)?
        };
        self.write_json(&key, snapshot).await
    }

    /// The latest snapshot, or the history entry `snapshot_id`; `None` when it does not exist.
    pub(crate) async fn load_snapshot(
        &self,
        location: &SnapshotLocation,
        snapshot_id: Option<&str>,
    ) -> Result<Option<Snapshot>> {
        let key = match snapshot_id {
            None => latest_key(location)?,
            Some(id) => history_key(location, id)?,
        };
        self.read_json(&key).await
    }

    /// Immutable snapshot ids in ascending (chronological) order, at most `limit`, after the
    /// exclusive cursor `start_after`.
    pub(crate) async fn list_snapshot_ids(
        &self,
        location: &SnapshotLocation,
        limit: Option<usize>,
        start_after: Option<&str>,
    ) -> Result<Vec<String>> {
        if limit == Some(0) {
            return Ok(Vec::new());
        }
        let start_after = start_after.filter(|cursor| !cursor.is_empty());
        if let Some(cursor) = start_after {
            validate_uuid_v7(cursor)?;
        }
        let keys = self.storage.list(&history_prefix(location)?).await?;
        let mut ids: Vec<String> = keys
            .iter()
            .filter_map(|key| snapshot_id_of(key))
            .map(str::to_owned)
            .collect();
        ids.sort();
        if let Some(cursor) = start_after {
            ids.retain(|id| id.as_str() > cursor);
        }
        if let Some(limit) = limit {
            ids.truncate(limit);
        }
        Ok(ids)
    }

    /// Deletes every key of the session.
    pub(crate) async fn delete_session(&self, session_id: &str) -> Result<()> {
        validate_identifier(session_id)?;
        let keys = self.storage.list(&format!("{session_id}/")).await?;
        for batch in keys.chunks(DELETE_BATCH_SIZE) {
            try_join_all(batch.iter().map(|key| self.storage.delete(key))).await?;
        }
        Ok(())
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "manifests are part of the SnapshotStorage interface; no caller reads them yet"
        )
    )]
    /// The scope's manifest, or a new one at the current schema version and time.
    pub(crate) async fn load_manifest(&self, location: &SnapshotLocation) -> Result<SnapshotManifest> {
        let manifest = self.read_json(&manifest_key(location)?).await?;
        Ok(manifest.unwrap_or_else(|| SnapshotManifest::new(self.clock.now_iso())))
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "manifests are part of the SnapshotStorage interface; no caller reads them yet"
        )
    )]
    pub(crate) async fn save_manifest(&self, location: &SnapshotLocation, manifest: &SnapshotManifest) -> Result<()> {
        self.write_json(&manifest_key(location)?, manifest).await
    }

    async fn write_json(&self, key: &str, value: &impl Serialize) -> Result<()> {
        let written = match serde_json::to_vec(value) {
            Ok(bytes) => self.storage.write(key, &bytes).await,
            Err(error) => Err(error.into()),
        };
        written.map_err(|error| {
            SessionError::new(format!("Failed to write '{key}' to storage"))
                .with_source(error)
                .into()
        })
    }

    async fn read_json<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let bytes = match self.storage.read(key).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Ok(None),
            Err(error) => {
                let message = format!("Failed to read '{key}' from storage");
                return Err(SessionError::new(message).with_source(error).into());
            }
        };
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        match serde_json::from_str(text) {
            Ok(value) => Ok(Some(value)),
            Err(error) => Err(SessionError::new(format!("Corrupted JSON at '{key}'"))
                .with_source(error)
                .into()),
        }
    }
}

impl std::fmt::Debug for SnapshotStorageAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnapshotStorageAdapter")
            .field("storage", &self.storage.storage_type())
            .finish_non_exhaustive()
    }
}

fn scope_prefix(location: &SnapshotLocation) -> Result<String> {
    validate_identifier(&location.session_id)?;
    validate_identifier(&location.scope_id)?;
    Ok(format!(
        "{}/scopes/{}/{}/snapshots",
        location.session_id,
        scope_name(location.scope),
        location.scope_id
    ))
}

fn latest_key(location: &SnapshotLocation) -> Result<String> {
    Ok(format!("{}/snapshot_latest.json", scope_prefix(location)?))
}

fn history_key(location: &SnapshotLocation, snapshot_id: &str) -> Result<String> {
    validate_identifier(snapshot_id)?;
    Ok(format!(
        "{}/immutable_history/snapshot_{snapshot_id}.json",
        scope_prefix(location)?
    ))
}

fn history_prefix(location: &SnapshotLocation) -> Result<String> {
    Ok(format!("{}/immutable_history/", scope_prefix(location)?))
}

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "manifests are part of the SnapshotStorage interface; no caller reads them yet (an allow: rustc 1.96 does not report it, later versions do)"
    )
)]
fn manifest_key(location: &SnapshotLocation) -> Result<String> {
    Ok(format!("{}/manifest.json", scope_prefix(location)?))
}

/// The id in a history key: the `[\w-]+` run between `snapshot_` and the final `.json`, leftmost match first.
fn snapshot_id_of(key: &str) -> Option<&str> {
    let stem = key.strip_suffix(".json")?;
    stem.match_indices("snapshot_").find_map(|(start, marker)| {
        let id = &stem[start + marker.len()..];
        let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-';
        (!id.is_empty() && id.bytes().all(is_word)).then_some(id)
    })
}

/// Covers the adapter, the `sessions` conformance fixture and the harness session paths.
#[cfg(test)]
mod tests {
    use std::path::Path;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::error::StorageError;
    use crate::storage::{InMemoryStorage, LocalFileStorage, NamespacedStorage};
    use crate::types::JsonObject;

    const SCOPE_ID: &str = "test-agent";

    fn location() -> SnapshotLocation {
        SnapshotLocation::new("test-session", Scope::Agent, SCOPE_ID)
    }

    fn uuid_v7(index: u64) -> String {
        let hex = format!("{index:012x}");
        format!("{}-{}-7000-8000-000000000000", &hex[..8], &hex[8..])
    }

    fn test_snapshot() -> Snapshot {
        let data = json!({
            "messages": [],
            "state": {"testKey": "testValue"},
            "systemPrompt": "You are a test assistant",
        });
        let mut snapshot = Snapshot::new(Scope::Agent, "2024-01-01T00:00:00.000Z", object(data));
        snapshot.schema_version = "1.0".to_owned();
        snapshot
    }

    fn object(value: serde_json::Value) -> JsonObject {
        match value {
            serde_json::Value::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    fn test_manifest(updated_at: &str) -> SnapshotManifest {
        SnapshotManifest::new(updated_at)
    }

    fn setup() -> (Arc<InMemoryStorage>, SnapshotStorageAdapter) {
        let backend = Arc::new(InMemoryStorage::new());
        let adapter = adapter_over(backend.clone(), "session");
        (backend, adapter)
    }

    fn adapter_over(backend: Arc<dyn Storage>, prefix: &str) -> SnapshotStorageAdapter {
        SnapshotStorageAdapter::new(Arc::new(NamespacedStorage::new(backend, prefix).unwrap()))
    }

    async fn save(adapter: &SnapshotStorageAdapter, location: &SnapshotLocation, id: &str, is_latest: bool) {
        adapter
            .save_snapshot(location, id, is_latest, &test_snapshot())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn saves_snapshot_as_latest() {
        let (backend, adapter) = setup();
        save(&adapter, &location(), &uuid_v7(1), true).await;
        let keys = backend.list("session/").await.unwrap();
        assert!(keys.iter().any(|key| key.contains("snapshot_latest.json")), "{keys:?}");
    }

    #[tokio::test]
    async fn saves_snapshot_to_history() {
        let (backend, adapter) = setup();
        let id = uuid_v7(1);
        save(&adapter, &location(), &id, false).await;
        let keys = backend.list("session/").await.unwrap();
        let expected = format!("immutable_history/snapshot_{id}.json");
        assert!(keys.iter().any(|key| key.contains(&expected)), "{keys:?}");
    }

    #[tokio::test]
    async fn round_trips_snapshot_data_through_load_snapshot() {
        let (_backend, adapter) = setup();
        let snapshot = test_snapshot().with_app_data(object(json!({"custom": "value"})));
        let id = uuid_v7(1);
        adapter.save_snapshot(&location(), &id, false, &snapshot).await.unwrap();
        let loaded = adapter.load_snapshot(&location(), Some(&id)).await.unwrap();
        assert_eq!(loaded, Some(snapshot));
    }

    #[tokio::test]
    async fn returns_null_when_snapshot_does_not_exist() {
        let (_backend, adapter) = setup();
        let loaded = adapter.load_snapshot(&location(), Some(&uuid_v7(99))).await.unwrap();
        assert_eq!(loaded, None);
    }

    #[tokio::test]
    async fn loads_latest_snapshot_when_no_snapshot_id_provided() {
        let (_backend, adapter) = setup();
        let snapshot = test_snapshot().with_app_data(object(json!({"version": "latest"})));
        adapter
            .save_snapshot(&location(), &uuid_v7(1), true, &snapshot)
            .await
            .unwrap();
        assert_eq!(adapter.load_snapshot(&location(), None).await.unwrap(), Some(snapshot));
    }

    #[tokio::test]
    async fn returns_null_for_latest_when_no_latest_exists() {
        let (_backend, adapter) = setup();
        assert_eq!(adapter.load_snapshot(&location(), None).await.unwrap(), None);
    }

    #[tokio::test]
    async fn returns_empty_array_when_no_snapshots_exist() {
        let (_backend, adapter) = setup();
        assert!(
            adapter
                .list_snapshot_ids(&location(), None, None)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn lists_snapshot_ids_sorted_chronologically() {
        let (_backend, adapter) = setup();
        for index in [2, 1, 3] {
            save(&adapter, &location(), &uuid_v7(index), false).await;
        }
        let ids = adapter.list_snapshot_ids(&location(), None, None).await.unwrap();
        assert_eq!(ids, [uuid_v7(1), uuid_v7(2), uuid_v7(3)]);
    }

    #[tokio::test]
    async fn does_not_include_latest_in_listing() {
        let (_backend, adapter) = setup();
        let id = uuid_v7(1);
        save(&adapter, &location(), &id, true).await;
        save(&adapter, &location(), &id, false).await;
        assert_eq!(adapter.list_snapshot_ids(&location(), None, None).await.unwrap(), [id]);
    }

    #[tokio::test]
    async fn respects_limit_parameter() {
        let (_backend, adapter) = setup();
        for index in 1..=5 {
            save(&adapter, &location(), &uuid_v7(index), false).await;
        }
        let ids = adapter.list_snapshot_ids(&location(), Some(2), None).await.unwrap();
        assert_eq!(ids, [uuid_v7(1), uuid_v7(2)]);
    }

    #[tokio::test]
    async fn returns_empty_array_when_limit_is_0() {
        let (_backend, adapter) = setup();
        save(&adapter, &location(), &uuid_v7(1), false).await;
        assert!(
            adapter
                .list_snapshot_ids(&location(), Some(0), None)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn respects_start_after_cursor() {
        let (_backend, adapter) = setup();
        for index in 1..=3 {
            save(&adapter, &location(), &uuid_v7(index), false).await;
        }
        let ids = adapter
            .list_snapshot_ids(&location(), None, Some(&uuid_v7(1)))
            .await
            .unwrap();
        assert_eq!(ids, [uuid_v7(2), uuid_v7(3)]);
    }

    #[tokio::test]
    async fn combines_limit_and_start_after() {
        let (_backend, adapter) = setup();
        for index in 1..=5 {
            save(&adapter, &location(), &uuid_v7(index), false).await;
        }
        let ids = adapter
            .list_snapshot_ids(&location(), Some(2), Some(&uuid_v7(2)))
            .await
            .unwrap();
        assert_eq!(ids, [uuid_v7(3), uuid_v7(4)]);
    }

    #[tokio::test]
    async fn validates_the_cursor_and_ignores_an_empty_one() {
        let (_backend, adapter) = setup();
        save(&adapter, &location(), &uuid_v7(1), false).await;
        let error = adapter
            .list_snapshot_ids(&location(), None, Some("../evil"))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "'../evil' is not a valid UUID v7 snapshot ID");
        assert_eq!(
            adapter.list_snapshot_ids(&location(), None, Some("")).await.unwrap(),
            [uuid_v7(1)]
        );
    }

    #[tokio::test]
    async fn deletes_all_data_for_the_session() {
        let (backend, adapter) = setup();
        save(&adapter, &location(), &uuid_v7(1), false).await;
        save(&adapter, &location(), &uuid_v7(1), true).await;
        adapter
            .save_manifest(&location(), &test_manifest("2024-01-01T00:00:00.000Z"))
            .await
            .unwrap();
        adapter.delete_session("test-session").await.unwrap();
        assert!(backend.list("session/test-session/").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn does_not_affect_other_sessions() {
        let (backend, adapter) = setup();
        let first = SnapshotLocation::new("session-1", Scope::Agent, SCOPE_ID);
        let second = SnapshotLocation::new("session-2", Scope::Agent, SCOPE_ID);
        save(&adapter, &first, &uuid_v7(1), false).await;
        save(&adapter, &second, &uuid_v7(2), false).await;
        adapter.delete_session("session-1").await.unwrap();
        assert!(backend.list("session/session-1/").await.unwrap().is_empty());
        assert!(!backend.list("session/session-2/").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn throws_on_invalid_session_id() {
        let (_backend, adapter) = setup();
        let error = adapter.delete_session("INVALID!").await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Identifier 'INVALID!' can only contain lowercase letters, numbers, hyphens, and underscores"
        );
    }

    #[tokio::test]
    async fn deletes_sessions_larger_than_one_batch() {
        let (backend, adapter) = setup();
        for index in 1..=250 {
            save(&adapter, &location(), &uuid_v7(index), false).await;
        }
        adapter.delete_session("test-session").await.unwrap();
        assert!(backend.list("").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn round_trips_manifest_data() {
        let (_backend, adapter) = setup();
        let manifest = test_manifest("2025-06-01T00:00:00.000Z");
        adapter.save_manifest(&location(), &manifest).await.unwrap();
        assert_eq!(adapter.load_manifest(&location()).await.unwrap(), manifest);
    }

    #[tokio::test]
    async fn returns_default_manifest_when_none_exists() {
        let (_backend, adapter) = setup();
        let adapter = adapter.with_clock(Clock::fixed("2026-11-11T12:00:00Z".parse().unwrap()));
        let manifest = adapter.load_manifest(&location()).await.unwrap();
        assert_eq!(manifest.schema_version, "1.0");
        assert_eq!(manifest.updated_at, "2026-11-11T12:00:00.000Z");
    }

    #[tokio::test]
    async fn rejects_snapshot_id_with_path_traversal_characters() {
        let (_backend, adapter) = setup();
        let id = "..\\..\\other-session\\snapshots\\snapshot_latest";
        let result = adapter.save_snapshot(&location(), id, false, &test_snapshot()).await;
        assert_eq!(result.unwrap_err().name(), "Error");
    }

    #[tokio::test]
    async fn rejects_snapshot_id_with_forward_slash_traversal() {
        let (_backend, adapter) = setup();
        let result = adapter.load_snapshot(&location(), Some("../../other-session")).await;
        assert_eq!(result.unwrap_err().name(), "Error");
    }

    #[tokio::test]
    async fn rejects_invalid_session_and_scope_ids_before_touching_storage() {
        let (backend, adapter) = setup();
        for bad in [
            SnapshotLocation::new("Bad", Scope::Agent, SCOPE_ID),
            SnapshotLocation::new("ok", Scope::Agent, "a/b"),
        ] {
            assert!(
                adapter
                    .save_snapshot(&bad, &uuid_v7(1), true, &test_snapshot())
                    .await
                    .is_err()
            );
            assert!(adapter.load_manifest(&bad).await.is_err());
        }
        assert!(backend.list("").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn uses_the_namespace_provided_to_the_adapter() {
        let backend = Arc::new(InMemoryStorage::new());
        let custom = adapter_over(backend.clone(), "custom/prefix");
        save(&custom, &location(), &uuid_v7(1), true).await;
        assert!(backend.list("session/").await.unwrap().is_empty());
        assert!(!backend.list("custom/prefix/").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn wraps_storage_write_errors_in_session_error() {
        let adapter = adapter_over(Arc::new(Failing), "session");
        let error = adapter
            .save_snapshot(&location(), &uuid_v7(1), false, &test_snapshot())
            .await
            .unwrap_err();
        assert_eq!(error.name(), "SessionError");
        let key = format!(
            "test-session/scopes/agent/test-agent/snapshots/immutable_history/snapshot_{}.json",
            uuid_v7(1)
        );
        assert_eq!(error.to_string(), format!("Failed to write '{key}' to storage"));
        assert_eq!(
            std::error::Error::source(&error).map(ToString::to_string).as_deref(),
            Some("disk full")
        );
    }

    #[tokio::test]
    async fn wraps_storage_read_errors_in_session_error() {
        let adapter = adapter_over(Arc::new(Failing), "session");
        let error = adapter.load_snapshot(&location(), Some(&uuid_v7(1))).await.unwrap_err();
        assert_eq!(error.name(), "SessionError");
        assert!(error.to_string().starts_with("Failed to read '"), "{error}");
    }

    #[tokio::test]
    async fn throws_session_error_on_corrupted_json() {
        let (backend, adapter) = setup();
        let key = "session/test-session/scopes/agent/test-agent/snapshots/snapshot_latest.json";
        backend.write(key, b"not valid json{{{").await.unwrap();
        let error = adapter.load_snapshot(&location(), None).await.unwrap_err();
        assert_eq!(error.name(), "SessionError");
        assert_eq!(
            error.to_string(),
            "Corrupted JSON at 'test-session/scopes/agent/test-agent/snapshots/snapshot_latest.json'"
        );
    }

    #[tokio::test]
    async fn reads_pretty_printed_json_with_a_byte_order_mark() {
        let (backend, adapter) = setup();
        let key = "session/test-session/scopes/agent/test-agent/snapshots/snapshot_latest.json";
        let pretty = serde_json::to_string_pretty(&test_snapshot()).unwrap();
        backend
            .write(key, format!("\u{feff}{pretty}").as_bytes())
            .await
            .unwrap();
        assert_eq!(
            adapter.load_snapshot(&location(), None).await.unwrap(),
            Some(test_snapshot())
        );
    }

    #[tokio::test]
    async fn writes_compact_json() {
        let (backend, adapter) = setup();
        adapter.save_manifest(&location(), &test_manifest("t")).await.unwrap();
        let key = "session/test-session/scopes/agent/test-agent/snapshots/manifest.json";
        let bytes = backend.read(key).await.unwrap().unwrap();
        assert_eq!(bytes, br#"{"schemaVersion":"1.0","updatedAt":"t"}"#);
    }

    #[test]
    fn extracts_snapshot_ids_like_the_ts_regex() {
        assert_eq!(snapshot_id_of("a/immutable_history/snapshot_abc-1.json"), Some("abc-1"));
        assert_eq!(snapshot_id_of("snapshot_snapshot_a.json"), Some("snapshot_a"));
        assert_eq!(snapshot_id_of("x/snapshot_a.b.json"), None);
        assert_eq!(snapshot_id_of("x/snapshot_.json"), None);
        assert_eq!(snapshot_id_of("x/snapshot_a.json.tmp"), None);
        assert_eq!(snapshot_id_of("x/foosnapshot_ab.json"), Some("ab"));
    }

    #[tokio::test]
    async fn multi_agent_scope_uses_its_wire_name_in_keys() {
        let (backend, adapter) = setup();
        let location = SnapshotLocation::new("s", Scope::MultiAgent, "swarm");
        save(&adapter, &location, &uuid_v7(1), true).await;
        assert_eq!(
            backend.list("").await.unwrap(),
            ["session/s/scopes/multiAgent/swarm/snapshots/snapshot_latest.json"]
        );
    }

    /// A storage whose reads and writes fail.
    struct Failing;

    #[async_trait]
    impl Storage for Failing {
        async fn write(&self, _key: &str, _data: &[u8]) -> Result<()> {
            Err(StorageError::new("disk full").into())
        }

        async fn read(&self, _key: &str) -> Result<Option<Vec<u8>>> {
            Err(StorageError::new("network timeout").into())
        }

        async fn delete(&self, _key: &str) -> Result<()> {
            Ok(())
        }

        async fn list(&self, _prefix: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    #[derive(serde::Deserialize)]
    struct Fixture {
        cases: Vec<FixtureCase>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureCase {
        name: String,
        json: String,
    }

    fn sessions_fixture() -> std::collections::HashMap<String, String> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/fixtures/sessions.json");
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        fixture.cases.into_iter().map(|case| (case.name, case.json)).collect()
    }

    #[tokio::test]
    async fn writes_the_sessions_fixture_byte_for_byte() {
        let fixture = sessions_fixture();
        let expected_keys: Vec<String> = serde_json::from_str(&fixture["storage_keys"]).unwrap();
        let prefix = "session/conformance-session/scopes/agent/conformance-agent/snapshots";
        let history_key = expected_keys
            .iter()
            .find(|key| key.starts_with(&format!("{prefix}/immutable_history/")))
            .unwrap();
        let history_id = snapshot_id_of(history_key).unwrap();

        let latest: Snapshot = serde_json::from_str(&fixture["snapshot_latest"]).unwrap();
        let history: Snapshot = serde_json::from_str(&fixture["immutable_history_entry"]).unwrap();
        let manifest: SnapshotManifest = serde_json::from_str(&fixture["manifest"]).unwrap();

        let (backend, adapter) = setup();
        let location = SnapshotLocation::new("conformance-session", Scope::Agent, "conformance-agent");
        adapter
            .save_snapshot(&location, history_id, false, &history)
            .await
            .unwrap();
        adapter.save_snapshot(&location, "latest", true, &latest).await.unwrap();
        adapter.save_manifest(&location, &manifest).await.unwrap();

        assert_eq!(backend.list("").await.unwrap(), expected_keys);
        let stored = |key: String| {
            let backend = Arc::clone(&backend);
            async move { String::from_utf8(backend.read(&key).await.unwrap().unwrap()).unwrap() }
        };
        assert_eq!(
            stored(format!("{prefix}/snapshot_latest.json")).await,
            fixture["snapshot_latest"]
        );
        assert_eq!(stored(history_key.clone()).await, fixture["immutable_history_entry"]);
        assert_eq!(stored(format!("{prefix}/manifest.json")).await, fixture["manifest"]);

        assert_eq!(adapter.load_snapshot(&location, None).await.unwrap(), Some(latest));
        assert_eq!(
            adapter.load_snapshot(&location, Some(history_id)).await.unwrap(),
            Some(history)
        );
        assert_eq!(
            adapter.list_snapshot_ids(&location, None, None).await.unwrap(),
            [history_id]
        );
        assert_eq!(adapter.load_manifest(&location).await.unwrap(), manifest);
    }

    #[tokio::test]
    async fn local_file_storage_sessions_namespace_gives_the_harness_ts_file_storage_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".agent");
        let sessions: Arc<dyn Storage> = Arc::new(LocalFileStorage::new(&root).namespace("sessions").unwrap());
        let adapter = SnapshotStorageAdapter::new(sessions);
        let location = SnapshotLocation::new("abc123", Scope::Agent, "default");
        let id = uuid_v7(7);
        save(&adapter, &location, &id, true).await;
        save(&adapter, &location, &id, false).await;
        adapter.save_manifest(&location, &test_manifest("t")).await.unwrap();

        let snapshots = root.join("sessions/abc123/scopes/agent/default/snapshots");
        assert!(snapshots.join("snapshot_latest.json").is_file());
        assert!(snapshots.join("manifest.json").is_file());
        assert!(
            snapshots
                .join(format!("immutable_history/snapshot_{id}.json"))
                .is_file()
        );

        let pretty = serde_json::to_string_pretty(&test_snapshot().with_app_data(object(json!({"by": "ts"})))).unwrap();
        std::fs::write(snapshots.join("snapshot_latest.json"), pretty).unwrap();
        let loaded = adapter.load_snapshot(&location, None).await.unwrap().unwrap();
        assert_eq!(loaded.app_data, object(json!({"by": "ts"})));

        std::fs::write(snapshots.join(format!("immutable_history/snapshot_{id}.json.tmp")), "{").unwrap();
        assert_eq!(adapter.list_snapshot_ids(&location, None, None).await.unwrap(), [id]);
        adapter.delete_session("abc123").await.unwrap();
        assert!(!snapshots.join("snapshot_latest.json").exists());
    }
}
