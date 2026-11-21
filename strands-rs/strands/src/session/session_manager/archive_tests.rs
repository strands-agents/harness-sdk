//! Session manager archive tests, with a real agent. A `ContextManager` supplies the agent's
//! archive.

use serde_json::json;

use super::*;
use crate::Agent;
use crate::context_manager::{ArchiveConfig, ContextManager, ContextManagerConfig, ContextManagerStrategy};
use crate::storage::InMemoryStorage;
use crate::test_support::record_logs;
use crate::testing::MockModel;

const SESSION: &str = "test-session";

/// A snapshot store for the tests: snapshots under `session/` of their own storage.
struct Snapshots {
    root: Arc<InMemoryStorage>,
    adapter: SnapshotStorageAdapter,
}

impl Snapshots {
    fn new() -> Self {
        let root = Arc::new(InMemoryStorage::new());
        let view = NamespacedStorage::new(root.clone(), SESSION_NAMESPACE).unwrap();
        Self {
            adapter: SnapshotStorageAdapter::new(Arc::new(view)),
            root,
        }
    }

    fn manager(&self) -> SessionManager {
        manager_on(self.root.clone())
    }

    async fn latest(&self) -> Option<Snapshot> {
        let location = SnapshotLocation::new(SESSION, Scope::Agent, "agent");
        self.adapter.load_snapshot(&location, None).await.unwrap()
    }

    async fn store_latest(&self, snapshot: &Snapshot) {
        let location = SnapshotLocation::new(SESSION, Scope::Agent, "agent");
        self.adapter
            .save_snapshot(&location, LATEST_SNAPSHOT_ID, true, snapshot)
            .await
            .unwrap();
    }
}

fn manager_on(storage: Arc<dyn Storage>) -> SessionManager {
    SessionManager::new(SessionManagerConfig {
        storage: Some(storage),
        session_id: Some(SESSION.to_owned()),
        ..SessionManagerConfig::default()
    })
    .unwrap()
}

fn agent() -> LocalAgent {
    LocalAgent::new("agent", Arc::new(MockModel::new()))
}

/// An agent whose context manager has `archive`.
fn agent_with_archive(archive: &Archive, durable: bool) -> LocalAgent {
    let mut agent = agent();
    agent.set_context_manager(Some(
        ContextManager::with_test_archive(archive.clone(), durable).unwrap(),
    ));
    agent.set_context_archive(Some(AgentArchive {
        archive: archive.clone(),
        durable,
    }));
    agent
}

fn archive_on(storage: Arc<dyn Storage>, agent_id: &str) -> Archive {
    Archive::new(storage, SESSION, agent_id).unwrap()
}

fn test_snapshot(archive: Option<JsonValue>) -> Snapshot {
    let mut snapshot: Snapshot = serde_json::from_value(json!({
        "schemaVersion": "1.0",
        "scope": "agent",
        "createdAt": "2024-01-01T00:00:00.000Z",
        "data": {"messages": [], "state": {}},
        "appData": {}
    }))
    .unwrap();
    if let Some(archive) = archive {
        snapshot.data.insert("archive".to_owned(), archive);
    }
    snapshot
}

fn bytes(value: &JsonValue) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

// --- saveSnapshot -------------------------------------------------------------------------------

#[tokio::test]
async fn includes_archive_data_in_the_snapshot() {
    let snapshots = Snapshots::new();
    let manager = snapshots.manager();
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    archive
        .store("tool-1", 0, &bytes(&json!({"text": "hello"})))
        .await
        .unwrap();
    manager
        .save_snapshot(&agent_with_archive(&archive, false), true)
        .await
        .unwrap();
    let snapshot = snapshots.latest().await.unwrap();
    assert_eq!(
        snapshot.data["archive"],
        json!({"location": "inline", "entries": {"tool-1_0": {"text": "hello"}}})
    );
}

#[tokio::test]
async fn omits_archive_key_when_agent_has_no_context_manager() {
    let snapshots = Snapshots::new();
    snapshots.manager().save_snapshot(&agent(), true).await.unwrap();
    assert!(!snapshots.latest().await.unwrap().data.contains_key("archive"));
}

#[tokio::test]
async fn omits_archive_key_when_archive_is_empty() {
    let snapshots = Snapshots::new();
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    snapshots
        .manager()
        .save_snapshot(&agent_with_archive(&archive, false), true)
        .await
        .unwrap();
    assert!(!snapshots.latest().await.unwrap().data.contains_key("archive"));
}

#[tokio::test]
async fn writes_external_ref_when_storage_is_durable() {
    let snapshots = Snapshots::new();
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    archive
        .store("tool-1", 0, &bytes(&json!({"text": "hello"})))
        .await
        .unwrap();
    snapshots
        .manager()
        .save_snapshot(&agent_with_archive(&archive, true), true)
        .await
        .unwrap();
    assert_eq!(
        snapshots.latest().await.unwrap().data["archive"],
        json!({"location": "external", "storageType": "InMemoryStorage"})
    );
}

#[tokio::test]
async fn includes_archive_data_in_immutable_snapshots_from_the_trigger() {
    let snapshots = Snapshots::new();
    let manager = SessionManager::with_id_source(
        SessionManagerConfig {
            storage: Some(snapshots.root.clone()),
            session_id: Some(SESSION.to_owned()),
            save_latest_on: Some(SaveLatestStrategy::Trigger),
            snapshot_trigger: Some(SnapshotTriggerCallback::new(|_: &SnapshotTriggerParams<'_>| true)),
        },
        UuidV7Source::sequence(),
    )
    .unwrap();
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    archive
        .store("tool-1", 0, &bytes(&json!({"text": "hello"})))
        .await
        .unwrap();
    let mut target = agent_with_archive(&archive, false);
    manager.init_agent(&mut target).await.unwrap();
    let hooks = target.hooks().clone();
    let mut event = AfterInvocationEvent::new(&mut target, crate::agent::InvocationState::new());
    hooks.invoke(&mut event).await.unwrap();
    let location = SnapshotLocation::new(SESSION, Scope::Agent, "agent");
    let ids = snapshots
        .adapter
        .list_snapshot_ids(&location, None, None)
        .await
        .unwrap();
    let immutable = snapshots
        .adapter
        .load_snapshot(&location, Some(&ids[0]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        immutable.data["archive"]["entries"]["tool-1_0"],
        json!({"text": "hello"})
    );
    assert_eq!(
        snapshots.latest().await.unwrap().data["archive"],
        immutable.data["archive"]
    );
}

// --- restoreSnapshot ----------------------------------------------------------------------------

#[tokio::test]
async fn restores_archive_data_from_snapshot() {
    let snapshots = Snapshots::new();
    let manager = snapshots.manager();
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    archive
        .store("tool-1", 0, &bytes(&json!({"text": "hello"})))
        .await
        .unwrap();
    archive
        .store("tool-2", 0, &bytes(&json!({"text": "world"})))
        .await
        .unwrap();
    manager
        .save_snapshot(&agent_with_archive(&archive, false), true)
        .await
        .unwrap();

    let fresh_archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    let mut fresh = agent_with_archive(&fresh_archive, false);
    assert!(manager.restore_snapshot(&mut fresh, None).await.unwrap());
    assert_eq!(
        fresh_archive.retrieve("tool-1_0").await.unwrap(),
        Some(json!({"text": "hello"}))
    );
    assert_eq!(
        fresh_archive.retrieve("tool-2_0").await.unwrap(),
        Some(json!({"text": "world"}))
    );
}

#[tokio::test]
async fn skips_archive_restore_when_location_is_external() {
    let snapshots = Snapshots::new();
    snapshots
        .store_latest(&test_snapshot(Some(json!({"location": "external"}))))
        .await;
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    let mut target = agent_with_archive(&archive, false);
    assert!(snapshots.manager().restore_snapshot(&mut target, None).await.unwrap());
    assert!(archive.list("").await.unwrap().is_empty());
}

#[tokio::test]
async fn warns_when_archive_storage_type_changed_since_snapshot() {
    let (logs, _guard) = record_logs();
    let snapshots = Snapshots::new();
    snapshots
        .store_latest(&test_snapshot(Some(
            json!({"location": "external", "storageType": "S3Storage"}),
        )))
        .await;
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    let mut target = agent_with_archive(&archive, false);
    snapshots.manager().restore_snapshot(&mut target, None).await.unwrap();
    assert!(logs.text().contains(
        "session_id=<test-session>, snapshot_storage=<S3Storage>, current_storage=<InMemoryStorage> | archive storage type changed since snapshot was created, archive data may be inaccessible"
    ));
}

#[tokio::test]
async fn handles_snapshot_without_archive_data() {
    let snapshots = Snapshots::new();
    snapshots.store_latest(&test_snapshot(None)).await;
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    let mut target = agent_with_archive(&archive, false);
    assert!(snapshots.manager().restore_snapshot(&mut target, None).await.unwrap());
}

// --- deleteSession ------------------------------------------------------------------------------

async fn attached(manager: &SessionManager, storage: Arc<dyn Storage>, archive: &Archive) {
    let mut target = agent_with_archive(archive, false);
    target.set_storage(Some(storage));
    manager.init_agent(&mut target).await.unwrap();
}

#[tokio::test]
async fn deletes_archive_data_via_archive_reference() {
    let root = Arc::new(InMemoryStorage::new());
    let manager = manager_on(root.clone());
    let archive = archive_on(root.clone(), "agent");
    attached(&manager, root, &archive).await;
    archive.store("tool-1", 0, &bytes(&json!("data1"))).await.unwrap();
    archive.store("tool-2", 0, &bytes(&json!("data2"))).await.unwrap();
    assert_eq!(archive.list("").await.unwrap().len(), 2);
    manager.delete_session().await.unwrap();
    assert!(archive.list("").await.unwrap().is_empty());
}

#[tokio::test]
async fn deletes_archive_data_from_custom_archive_storage() {
    let root = Arc::new(InMemoryStorage::new());
    let manager = manager_on(root.clone());
    let archive = archive_on(Arc::new(InMemoryStorage::new()), "agent");
    attached(&manager, root, &archive).await;
    archive.store("tool-1", 0, &bytes(&json!("data1"))).await.unwrap();
    assert_eq!(archive.list("").await.unwrap().len(), 1);
    manager.delete_session().await.unwrap();
    assert!(archive.list("").await.unwrap().is_empty());
}

#[tokio::test]
async fn deletes_archive_data_when_storage_is_pre_namespaced() {
    let root = Arc::new(InMemoryStorage::new());
    let manager = manager_on(root.clone());
    let shared = InMemoryStorage::new();
    let archive = archive_on(Arc::new(shared.namespace("my-prefix").unwrap()), "agent");
    attached(&manager, root, &archive).await;
    archive.store("tool-1", 0, &bytes(&json!("data1"))).await.unwrap();
    assert_eq!(archive.list("").await.unwrap().len(), 1);
    manager.delete_session().await.unwrap();
    assert!(archive.list("").await.unwrap().is_empty());
}

#[tokio::test]
async fn does_not_over_delete_when_root_storage_is_pre_namespaced() {
    let shared = InMemoryStorage::new();
    let namespaced: Arc<dyn Storage> = Arc::new(shared.namespace("tenant-a").unwrap());
    let manager = manager_on(namespaced.clone());
    let archive = archive_on(namespaced.clone(), "agent");
    attached(&manager, namespaced.clone(), &archive).await;
    archive.store("tool-1", 0, &bytes(&json!("data1"))).await.unwrap();
    namespaced.write("other-data/important", b"keep-me").await.unwrap();
    manager.delete_session().await.unwrap();
    assert!(archive.list("").await.unwrap().is_empty());
    assert!(namespaced.read("other-data/important").await.unwrap().is_some());
}

#[tokio::test]
async fn clear_session_cleans_up_archive_data_from_other_agents_in_the_session() {
    let root = Arc::new(InMemoryStorage::new());
    let manager = manager_on(root.clone());
    let first = archive_on(root.clone(), "agent-a");
    let second = archive_on(root.clone(), "agent-b");
    attached(&manager, root, &first).await;
    first.store("tool-1", 0, &bytes(&json!("from-a"))).await.unwrap();
    second.store("tool-2", 0, &bytes(&json!("from-b"))).await.unwrap();
    manager.delete_session().await.unwrap();
    assert!(first.list("").await.unwrap().is_empty());
    assert!(second.list("").await.unwrap().is_empty());
}

#[tokio::test]
async fn succeeds_when_no_archive_is_available() {
    let snapshots = Snapshots::new();
    let manager = snapshots.manager();
    manager.init_agent(&mut agent()).await.unwrap();
    manager.delete_session().await.unwrap();
}

// --- with a real Agent --------------------------------------------------------------------------

fn real_agent(
    session_manager: SessionManager,
    storage: Option<Arc<dyn Storage>>,
    context_manager: ContextManagerConfig,
) -> Agent {
    Agent::builder()
        .model(MockModel::new())
        .maybe_storage(storage)
        .context_manager(ContextManagerStrategy::Config(context_manager))
        .session_manager(session_manager)
        .printer(false)
        .build()
        .unwrap()
}

fn archive_of(agent: &Agent) -> Archive {
    agent.context_manager().unwrap().archive().unwrap()
}

#[tokio::test]
async fn round_trips_archive_data_through_save_and_restore_with_real_agent() {
    let storage: Arc<dyn Storage> = Arc::new(InMemoryStorage::new());
    let snapshots = Snapshots::new();
    let mut agent = real_agent(
        snapshots.manager(),
        Some(storage.clone()),
        ContextManagerConfig::default(),
    );
    agent.initialize().await.unwrap();
    let archive = archive_of(&agent);
    archive
        .store("tool-1", 0, &bytes(&json!({"text": "hello"})))
        .await
        .unwrap();
    archive
        .store("tool-2", 0, &bytes(&json!({"text": "world"})))
        .await
        .unwrap();
    agent
        .session_manager()
        .unwrap()
        .save_snapshot(&agent.local, true)
        .await
        .unwrap();

    let mut fresh = real_agent(snapshots.manager(), Some(storage), ContextManagerConfig::default());
    fresh.initialize().await.unwrap();
    let fresh_archive = archive_of(&fresh);
    assert_eq!(
        fresh_archive.retrieve("tool-1_0").await.unwrap(),
        Some(json!({"text": "hello"}))
    );
    assert_eq!(
        fresh_archive.retrieve("tool-2_0").await.unwrap(),
        Some(json!({"text": "world"}))
    );
}

#[tokio::test]
async fn delete_session_cleans_up_archive_data_with_real_agent() {
    let storage = Arc::new(InMemoryStorage::new());
    let mut agent = real_agent(
        manager_on(storage.clone()),
        Some(storage.clone()),
        ContextManagerConfig::default(),
    );
    agent.initialize().await.unwrap();
    archive_of(&agent)
        .store("tool-1", 0, &bytes(&json!({"text": "hello"})))
        .await
        .unwrap();
    assert!(!storage.list("context/").await.unwrap().is_empty());
    agent.session_manager().unwrap().delete_session().await.unwrap();
    assert!(storage.list("context/").await.unwrap().is_empty());
}

#[tokio::test]
async fn delete_session_keeps_an_archive_rooted_at_an_explicitly_configured_scoped_view() {
    let storage = InMemoryStorage::new();
    let team: Arc<dyn Storage> = Arc::new(storage.namespace("team").unwrap());
    let snapshots = Snapshots::new();
    let config = ContextManagerConfig {
        archive: Some(
            ArchiveConfig {
                storage: Some(team.clone()),
                ..ArchiveConfig::default()
            }
            .into(),
        ),
        ..ContextManagerConfig::default()
    };
    let mut agent = real_agent(snapshots.manager(), None, config);
    agent.initialize().await.unwrap();
    archive_of(&agent).store("tool-1", 0, b"{}").await.unwrap();
    team.write("from-another-session_0", br#"{"text":"keep"}"#)
        .await
        .unwrap();
    agent.session_manager().unwrap().delete_session().await.unwrap();
    assert_eq!(team.list("").await.unwrap(), ["from-another-session_0", "tool-1_0"]);
}

#[tokio::test]
async fn delete_session_with_a_scoped_agent_storage_removes_only_this_session() {
    let storage = InMemoryStorage::new();
    let tenant: Arc<dyn Storage> = Arc::new(storage.namespace("tenant").unwrap());
    tenant.write("memory/prefs.json", b"{}").await.unwrap();
    let snapshots = Snapshots::new();
    let mut agent = real_agent(
        snapshots.manager(),
        Some(tenant.clone()),
        ContextManagerConfig::default(),
    );
    agent.initialize().await.unwrap();
    archive_of(&agent).store("tool-1", 0, b"{}").await.unwrap();
    let prefix = format!("context/{SESSION}/scopes/agent/{}/", agent.local.id());
    assert!(!tenant.list(&prefix).await.unwrap().is_empty());
    agent.session_manager().unwrap().delete_session().await.unwrap();
    assert_eq!(storage.list("").await.unwrap(), ["tenant/memory/prefs.json"]);
}
