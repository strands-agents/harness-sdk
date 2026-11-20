//! Session manager tests for the agent scope. They store through `InMemoryStorage`, which the
//! manager scopes under `session`, and read back through a `SnapshotStorageAdapter` on the same
//! view.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::agent::InvocationState;
use crate::hooks::ModelStopResponse;
use crate::models::Redaction;
use crate::storage::InMemoryStorage;
use crate::test_support::record_logs;
use crate::testing::MockModel;
use crate::types::{Message, StopReason};

const SESSION: &str = "test-session";

struct Fixture {
    root: Arc<InMemoryStorage>,
    adapter: SnapshotStorageAdapter,
}

impl Fixture {
    fn new() -> Self {
        let root = Arc::new(InMemoryStorage::new());
        let view = NamespacedStorage::new(root.clone(), SESSION_NAMESPACE).unwrap();
        Self {
            adapter: SnapshotStorageAdapter::new(Arc::new(view)),
            root,
        }
    }

    fn manager(&self, session_id: &str, save_latest_on: Option<SaveLatestStrategy>) -> SessionManager {
        self.manager_with(session_id, save_latest_on, None)
    }

    fn manager_with(
        &self,
        session_id: &str,
        save_latest_on: Option<SaveLatestStrategy>,
        snapshot_trigger: Option<SnapshotTriggerCallback>,
    ) -> SessionManager {
        let config = SessionManagerConfig {
            storage: Some(self.root.clone()),
            session_id: Some(session_id.to_owned()),
            save_latest_on,
            snapshot_trigger,
        };
        SessionManager::with_id_source(config, UuidV7Source::sequence()).unwrap()
    }

    async fn latest(&self, session_id: &str, agent_id: &str) -> Option<Snapshot> {
        let location = SnapshotLocation::new(session_id, Scope::Agent, agent_id);
        self.adapter.load_snapshot(&location, None).await.unwrap()
    }

    async fn ids(&self, session_id: &str, agent_id: &str) -> Vec<String> {
        let location = SnapshotLocation::new(session_id, Scope::Agent, agent_id);
        self.adapter.list_snapshot_ids(&location, None, None).await.unwrap()
    }

    async fn store(&self, agent_id: &str, snapshot_id: &str, snapshot: &Snapshot) {
        let location = SnapshotLocation::new(SESSION, Scope::Agent, agent_id);
        let is_latest = snapshot_id == LATEST_SNAPSHOT_ID;
        self.adapter
            .save_snapshot(&location, snapshot_id, is_latest, snapshot)
            .await
            .unwrap();
    }
}

fn agent(id: &str) -> LocalAgent {
    LocalAgent::new(id, Arc::new(MockModel::new()))
}

fn test_snapshot() -> Snapshot {
    serde_json::from_value(json!({
        "schemaVersion": "1.0",
        "scope": "agent",
        "createdAt": "2024-01-01T00:00:00.000Z",
        "data": {
            "messages": [{"role": "user", "content": [{"text": "restored"}]}],
            "state": {"testKey": "testValue"},
            "systemPrompt": "You are a test assistant"
        },
        "appData": {}
    }))
    .unwrap()
}

fn test_message() -> Message {
    Message::user("test")
}

async fn attach(manager: &SessionManager, agent: &mut LocalAgent) {
    manager.init_agent(agent).await.unwrap();
}

async fn fire_initialized(agent: &mut LocalAgent) {
    let hooks = agent.hooks().clone();
    hooks.invoke(&mut InitializedEvent::new(agent)).await.unwrap();
}

async fn fire_after_invocation(agent: &mut LocalAgent) {
    let hooks = agent.hooks().clone();
    let mut event = AfterInvocationEvent::new(agent, InvocationState::new());
    hooks.invoke(&mut event).await.unwrap();
}

async fn fire_message_added(agent: &mut LocalAgent) {
    let hooks = agent.hooks().clone();
    let mut event = MessageAddedEvent::new(agent, InvocationState::new(), test_message());
    hooks.invoke(&mut event).await.unwrap();
}

async fn fire_after_model_call(agent: &mut LocalAgent, redacted: bool) {
    let hooks = agent.hooks().clone();
    let mut stop = ModelStopResponse::new(Message::assistant("Response"), StopReason::EndTurn);
    if redacted {
        stop = stop.with_redaction(Redaction::new("[User input redacted.]"));
    }
    let model: Arc<dyn crate::models::Model> = Arc::new(MockModel::new());
    let mut event = AfterModelCallEvent::new(agent, InvocationState::new(), model, 1).with_stop_data(stop);
    hooks.invoke(&mut event).await.unwrap();
}

fn trigger(decide: impl Fn(&SnapshotTriggerParams<'_>) -> bool + Send + Sync + 'static) -> SnapshotTriggerCallback {
    SnapshotTriggerCallback::new(decide)
}

// --- constructor -------------------------------------------------------------------------------

#[tokio::test]
async fn defaults_save_latest_on_to_invocation() {
    let fixture = Fixture::new();
    let manager = fixture.manager("test-default", None);
    let mut agent = agent("agent");
    attach(&manager, &mut agent).await;

    fire_after_invocation(&mut agent).await;

    assert!(fixture.latest("test-default", "agent").await.is_some());
}

#[test]
fn defaults_the_session_id_and_validates_it() {
    let manager = SessionManager::new(SessionManagerConfig::default()).unwrap();
    assert_eq!(manager.session_id(), "default-session");
    let error = SessionManager::builder().session_id("Bad Id").build().unwrap_err();
    assert_eq!(
        error.to_string(),
        "Identifier 'Bad Id' can only contain lowercase letters, numbers, hyphens, and underscores"
    );
}

#[tokio::test]
async fn fails_without_storage_on_the_manager_or_the_agent() {
    let manager = SessionManager::builder().session_id(SESSION).build().unwrap();
    let error = manager.save_snapshot(&agent("agent"), true).await.unwrap_err();
    assert_eq!(error.to_string(), NO_STORAGE_ERROR);
    let error = manager.init_agent(&mut agent("agent")).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "SessionManager requires a storage backend. Provide storage in SessionManagerConfig or set storage on the Agent."
    );
}

#[tokio::test]
async fn uses_a_namespaced_storage_as_it_is() {
    let root = Arc::new(InMemoryStorage::new());
    let scoped = Arc::new(NamespacedStorage::new(root.clone(), "sessions").unwrap());
    let manager = SessionManager::builder()
        .session_id(SESSION)
        .storage(scoped)
        .build()
        .unwrap();

    manager.save_snapshot(&agent("agent"), true).await.unwrap();

    assert_eq!(
        root.list("").await.unwrap(),
        ["sessions/test-session/scopes/agent/agent/snapshots/snapshot_latest.json"]
    );
}

#[test]
fn is_named_after_the_ts_plugin() {
    let manager = SessionManager::new(SessionManagerConfig::default()).unwrap();
    assert_eq!(manager.name(), "strands:session-manager");
}

// --- saveSnapshot ------------------------------------------------------------------------------

#[tokio::test]
async fn saves_snapshot_latest_when_is_latest_is_true() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);

    manager.save_snapshot(&agent("test-agent"), true).await.unwrap();

    let snapshot = fixture.latest(SESSION, "test-agent").await.unwrap();
    assert_eq!(snapshot.scope, Scope::Agent);
}

#[tokio::test]
async fn saves_immutable_snapshot_when_is_latest_is_false() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);

    manager.save_snapshot(&agent("test-agent"), false).await.unwrap();

    assert!(!fixture.ids(SESSION, "test-agent").await.is_empty());
}

#[tokio::test]
async fn allocates_unique_snapshot_ids() {
    let fixture = Fixture::new();
    let manager = SessionManager::builder()
        .session_id(SESSION)
        .storage(fixture.root.clone())
        .build()
        .unwrap();
    let agent = agent("test-agent");

    for _ in 0..3 {
        manager.save_snapshot(&agent, false).await.unwrap();
    }

    let ids = fixture.ids(SESSION, "test-agent").await;
    assert_eq!(ids.len(), 3);
    for id in &ids {
        crate::session::validation::validate_uuid_v7(id).unwrap();
    }
}

// --- listSnapshotIds ---------------------------------------------------------------------------

#[tokio::test]
async fn returns_empty_array_when_no_snapshots_exist() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);

    let ids = manager
        .list_snapshot_ids(&agent("test-agent"), None, None)
        .await
        .unwrap();

    assert!(ids.is_empty());
}

#[tokio::test]
async fn returns_snapshot_ids_for_the_target_agent() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);
    let target = agent("test-agent");
    manager.save_snapshot(&target, false).await.unwrap();
    manager.save_snapshot(&target, false).await.unwrap();
    manager.save_snapshot(&agent("other-agent"), false).await.unwrap();

    let ids = manager.list_snapshot_ids(&target, None, None).await.unwrap();

    assert_eq!(ids.len(), 2);
}

#[tokio::test]
async fn does_not_return_latest_snapshot_id() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);
    let target = agent("test-agent");
    manager.save_snapshot(&target, true).await.unwrap();

    let ids = manager.list_snapshot_ids(&target, None, None).await.unwrap();

    assert!(ids.is_empty());
}

#[tokio::test]
async fn forwards_limit_parameter() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);
    let target = agent("test-agent");
    for _ in 0..3 {
        manager.save_snapshot(&target, false).await.unwrap();
    }

    let ids = manager.list_snapshot_ids(&target, Some(2), None).await.unwrap();

    assert_eq!(ids.len(), 2);
}

#[tokio::test]
async fn forwards_start_after_parameter() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);
    let target = agent("test-agent");
    manager.save_snapshot(&target, false).await.unwrap();
    manager.save_snapshot(&target, false).await.unwrap();

    let all = manager.list_snapshot_ids(&target, None, None).await.unwrap();
    let page = manager.list_snapshot_ids(&target, None, Some(&all[0])).await.unwrap();

    assert_eq!(page, [all[1].clone()]);
}

// --- restoreSnapshot ---------------------------------------------------------------------------

#[tokio::test]
async fn restores_snapshot_latest_when_no_snapshot_id_provided() {
    let fixture = Fixture::new();
    fixture.store("test-agent", "latest", &test_snapshot()).await;
    let manager = fixture.manager(SESSION, None);
    let mut target = agent("test-agent");

    assert!(manager.restore_snapshot(&mut target, None).await.unwrap());

    assert_eq!(target.app_state().get_value("testKey"), Some(json!("testValue")));
    assert_eq!(target.messages().len(), 1);
}

#[tokio::test]
async fn restores_specific_snapshot_by_id() {
    let fixture = Fixture::new();
    fixture.store("test-agent", "5", &test_snapshot()).await;
    let manager = fixture.manager(SESSION, None);
    let mut target = agent("test-agent");

    assert!(manager.restore_snapshot(&mut target, Some("5")).await.unwrap());

    assert_eq!(
        target.system_prompt(),
        Some(&crate::types::SystemPrompt::from("You are a test assistant"))
    );
}

#[tokio::test]
async fn returns_false_when_snapshot_not_found() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, None);

    let restored = manager
        .restore_snapshot(&mut agent("test-agent"), Some("999"))
        .await
        .unwrap();

    assert!(!restored);
}

// --- InitializedEvent --------------------------------------------------------------------------

#[tokio::test]
async fn loads_snapshot_latest_on_initialization() {
    let fixture = Fixture::new();
    let snapshot = test_snapshot();
    fixture.store("test-agent", "latest", &snapshot).await;
    let manager = fixture.manager(SESSION, None);
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_initialized(&mut target).await;

    let mut restored = serde_json::to_value(target.messages()).unwrap();
    for message in restored.as_array_mut().unwrap() {
        message.as_object_mut().unwrap().remove("trackingId");
    }
    assert_eq!(restored, snapshot.data["messages"]);
}

#[tokio::test]
async fn handles_missing_snapshot_gracefully() {
    let fixture = Fixture::new();
    let manager = fixture.manager("new-session", None);
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_initialized(&mut target).await;

    assert!(target.messages().is_empty());
}

#[tokio::test]
async fn warns_when_snapshot_restore_overwrites_existing_messages() {
    let fixture = Fixture::new();
    fixture.store("test-agent", "latest", &test_snapshot()).await;
    let manager = fixture.manager(SESSION, None);
    let mut target = agent("test-agent");
    target.messages_mut().push(test_message());
    attach(&manager, &mut target).await;

    let (logs, guard) = record_logs();
    fire_initialized(&mut target).await;
    drop(guard);

    assert!(logs.text().contains(
        "WARN agent_id=<test-agent>, session_id=<test-session> | agent had existing messages that were overwritten by session restore"
    ));
}

#[tokio::test]
async fn does_not_warn_when_restoring_into_agent_with_no_messages() {
    let fixture = Fixture::new();
    fixture.store("test-agent", "latest", &test_snapshot()).await;
    let manager = fixture.manager(SESSION, None);
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    let (logs, guard) = record_logs();
    fire_initialized(&mut target).await;
    drop(guard);

    assert!(!logs.text().contains("WARN"));
}

// --- MessageAddedEvent -------------------------------------------------------------------------

#[tokio::test]
async fn message_added_saves_snapshot_latest_when_save_latest_on_is_message() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Message));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_message_added(&mut target).await;

    assert!(fixture.latest(SESSION, "test-agent").await.is_some());
}

#[tokio::test]
async fn does_not_save_when_save_latest_on_is_invocation() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Invocation));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;
    let message_strategy = fixture.manager(SESSION, Some(SaveLatestStrategy::Message));
    let mut counted = agent("counted");
    attach(&message_strategy, &mut counted).await;

    fire_message_added(&mut target).await;

    assert_eq!(counted.hooks().len(), target.hooks().len() + 1);
    assert!(fixture.latest(SESSION, "test-agent").await.is_none());
}

// --- AfterInvocationEvent ----------------------------------------------------------------------

#[tokio::test]
async fn after_invocation_saves_snapshot_latest_when_save_latest_on_is_invocation() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Invocation));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;

    assert!(fixture.latest(SESSION, "test-agent").await.is_some());
}

#[tokio::test]
async fn after_invocation_saves_snapshot_latest_when_save_latest_on_is_message() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Message));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;

    assert!(fixture.latest(SESSION, "test-agent").await.is_some());
}

#[tokio::test]
async fn does_not_save_snapshot_latest_when_save_latest_on_is_trigger() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Trigger));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;

    assert!(fixture.latest(SESSION, "test-agent").await.is_none());
}

// --- snapshotTrigger ---------------------------------------------------------------------------

#[tokio::test]
async fn creates_immutable_snapshot_when_trigger_returns_true() {
    let fixture = Fixture::new();
    let manager = fixture.manager_with(SESSION, Some(SaveLatestStrategy::Trigger), Some(trigger(|_| true)));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;

    assert_eq!(fixture.ids(SESSION, "test-agent").await.len(), 1);
}

#[tokio::test]
async fn does_not_create_immutable_snapshot_when_trigger_returns_false() {
    let fixture = Fixture::new();
    let manager = fixture.manager_with(SESSION, Some(SaveLatestStrategy::Trigger), Some(trigger(|_| false)));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;

    assert!(fixture.ids(SESSION, "test-agent").await.is_empty());
}

#[tokio::test]
async fn provides_agent_data_to_trigger() {
    let fixture = Fixture::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let (seen_by_trigger, calls_by_trigger) = (seen.clone(), calls.clone());
    let manager = fixture.manager_with(
        SESSION,
        Some(SaveLatestStrategy::Trigger),
        Some(trigger(move |params| {
            calls_by_trigger.fetch_add(1, Ordering::SeqCst);
            let agent = params.agent_data;
            seen_by_trigger.lock().unwrap().push((
                agent.id().to_owned(),
                agent.messages().len(),
                agent.app_state().get_value("k"),
            ));
            false
        })),
    );
    let mut target = agent("test-agent");
    target.messages_mut().push(test_message());
    target.app_state().set("k", "v").unwrap();
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(*seen.lock().unwrap(), [("test-agent".to_owned(), 1, Some(json!("v")))]);
}

#[tokio::test]
async fn saves_both_immutable_and_latest_when_trigger_fires() {
    let fixture = Fixture::new();
    let manager = fixture.manager_with(SESSION, Some(SaveLatestStrategy::Trigger), Some(trigger(|_| true)));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;

    assert_eq!(fixture.ids(SESSION, "test-agent").await.len(), 1);
    assert!(fixture.latest(SESSION, "test-agent").await.is_some());
}

#[tokio::test]
async fn trigger_based_on_message_count_via_agent_data() {
    let fixture = Fixture::new();
    let manager = fixture.manager_with(
        SESSION,
        Some(SaveLatestStrategy::Trigger),
        Some(trigger(|params| params.agent_data.messages().len() >= 2)),
    );
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;
    assert!(fixture.ids(SESSION, "test-agent").await.is_empty());

    target.messages_mut().extend([test_message(), test_message()]);
    fire_after_invocation(&mut target).await;
    assert_eq!(fixture.ids(SESSION, "test-agent").await.len(), 1);
}

#[tokio::test]
async fn trigger_based_on_agent_state_via_agent_data() {
    let fixture = Fixture::new();
    let manager = fixture.manager_with(
        SESSION,
        Some(SaveLatestStrategy::Trigger),
        Some(trigger(|params| {
            params.agent_data.app_state().get_value("checkpoint") == Some(json!(true))
        })),
    );
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_invocation(&mut target).await;
    assert!(fixture.ids(SESSION, "test-agent").await.is_empty());

    target.app_state().set("checkpoint", true).unwrap();
    fire_after_invocation(&mut target).await;
    assert_eq!(fixture.ids(SESSION, "test-agent").await.len(), 1);
}

// --- integration scenarios ---------------------------------------------------------------------

#[tokio::test]
async fn handles_complete_session_lifecycle() {
    let fixture = Fixture::new();
    let manager = fixture.manager_with(
        "lifecycle-test",
        Some(SaveLatestStrategy::Invocation),
        Some(trigger(|_| true)),
    );
    let mut target = agent("agent");
    attach(&manager, &mut target).await;

    fire_initialized(&mut target).await;
    for _ in 0..3 {
        fire_after_invocation(&mut target).await;
    }

    assert!(fixture.latest("lifecycle-test", "agent").await.is_some());
    assert_eq!(fixture.ids("lifecycle-test", "agent").await.len(), 3);
}

#[tokio::test]
async fn supports_resuming_from_immutable_snapshot() {
    let fixture = Fixture::new();
    let manager = fixture.manager_with(
        "resume-test",
        Some(SaveLatestStrategy::Trigger),
        Some(trigger(|params| params.agent_data.messages().len() == 2)),
    );
    let mut first = agent("agent");
    attach(&manager, &mut first).await;
    fire_initialized(&mut first).await;
    first.messages_mut().extend([test_message(), test_message()]);
    fire_after_invocation(&mut first).await;
    let ids = fixture.ids("resume-test", "agent").await;
    assert_eq!(ids.len(), 1);

    let resumed_manager = fixture.manager("resume-test", Some(SaveLatestStrategy::Invocation));
    let mut second = agent("agent");
    attach(&resumed_manager, &mut second).await;
    fire_initialized(&mut second).await;
    resumed_manager
        .restore_snapshot(&mut second, Some(&ids[0]))
        .await
        .unwrap();

    assert_eq!(second.messages(), first.messages());
}

// --- AfterModelCallEvent with redaction --------------------------------------------------------

#[tokio::test]
async fn saves_snapshot_latest_when_save_latest_on_is_message_and_redaction_occurred() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Message));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_model_call(&mut target, true).await;

    assert!(fixture.latest(SESSION, "test-agent").await.is_some());
}

#[tokio::test]
async fn does_not_save_when_save_latest_on_is_message_but_no_redaction_occurred() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Message));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_model_call(&mut target, false).await;

    assert!(fixture.latest(SESSION, "test-agent").await.is_none());
}

#[tokio::test]
async fn saves_snapshot_latest_on_redaction_when_save_latest_on_is_invocation_or_message() {
    for strategy in [SaveLatestStrategy::Invocation, SaveLatestStrategy::Message] {
        let fixture = Fixture::new();
        let manager = fixture.manager(SESSION, Some(strategy));
        let mut target = agent("test-agent");
        attach(&manager, &mut target).await;

        fire_after_model_call(&mut target, true).await;

        assert!(fixture.latest(SESSION, "test-agent").await.is_some(), "{strategy:?}");
    }
}

#[tokio::test]
async fn does_not_register_after_model_call_event_hook_when_save_latest_on_is_trigger() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Trigger));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_model_call(&mut target, true).await;

    assert_eq!(target.hooks().len(), 2);
    assert!(fixture.latest(SESSION, "test-agent").await.is_none());
}

#[tokio::test]
async fn does_not_save_on_after_model_call_event_without_redaction_under_save_latest_on_invocation() {
    let fixture = Fixture::new();
    let manager = fixture.manager(SESSION, Some(SaveLatestStrategy::Invocation));
    let mut target = agent("test-agent");
    attach(&manager, &mut target).await;

    fire_after_model_call(&mut target, false).await;

    assert!(fixture.latest(SESSION, "test-agent").await.is_none());
}

#[tokio::test]
async fn saves_the_text_under_message_with_the_next_added_message_with_no_update_event() {
    struct Recording {
        inner: InMemoryStorage,
        saved: Mutex<Vec<Vec<serde_json::Value>>>,
    }

    #[crate::async_trait]
    impl crate::storage::Storage for Recording {
        async fn write(&self, key: &str, data: &[u8]) -> crate::Result<()> {
            if key.ends_with("snapshot_latest.json") {
                let snapshot: serde_json::Value = serde_json::from_slice(data).unwrap();
                let contents = snapshot["data"]["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|message| message["content"].clone())
                    .collect();
                self.saved.lock().unwrap().push(contents);
            }
            self.inner.write(key, data).await
        }

        async fn read(&self, key: &str) -> crate::Result<Option<Vec<u8>>> {
            self.inner.read(key).await
        }

        async fn delete(&self, key: &str) -> crate::Result<()> {
            self.inner.delete(key).await
        }

        async fn list(&self, prefix: &str) -> crate::Result<Vec<String>> {
            self.inner.list(prefix).await
        }
    }

    let storage = Arc::new(Recording {
        inner: InMemoryStorage::new(),
        saved: Mutex::default(),
    });
    let config = SessionManagerConfig {
        storage: Some(storage.clone()),
        session_id: Some(SESSION.to_owned()),
        save_latest_on: Some(SaveLatestStrategy::Message),
        snapshot_trigger: None,
    };
    let injector = crate::vended_plugins::context_injector::ContextInjector::new(
        crate::vended_plugins::context_injector::ContextInjectorConfig::new(|_| async {
            Ok(Some("cwd: /repo".to_owned()))
        }),
    );
    let mut agent = crate::Agent::builder()
        .model(MockModel::new().with_turn("ok"))
        .printer(false)
        .session_manager(SessionManager::new(config).unwrap())
        .plugins([injector])
        .build()
        .unwrap();

    agent.invoke("ask").await.unwrap();

    let injected = json!({"injected": {"text": "cwd: /repo", "source": "strands:context-injector"}});
    let saved = storage.saved.lock().unwrap();
    // Saved once when the user message was added, before the write.
    assert_eq!(saved[0], [json!([{"text": "ask"}])]);
    // Every save from the reply on holds the text.
    let with_reply: Vec<_> = saved.iter().filter(|messages| messages.len() == 2).collect();
    assert!(!with_reply.is_empty());
    for messages in with_reply {
        assert_eq!(messages[0], json!([{"text": "ask"}, injected]));
    }
}

#[tokio::test]
async fn a_retried_initialize_restores_the_session_after_a_failed_read() {
    struct Flaky {
        inner: InMemoryStorage,
        fail_next_read: std::sync::atomic::AtomicBool,
    }

    #[crate::async_trait]
    impl crate::storage::Storage for Flaky {
        async fn write(&self, key: &str, data: &[u8]) -> crate::Result<()> {
            self.inner.write(key, data).await
        }

        async fn read(&self, key: &str) -> crate::Result<Option<Vec<u8>>> {
            if self.fail_next_read.swap(false, Ordering::SeqCst) {
                return Err(crate::Error::other("transient read failure"));
            }
            self.inner.read(key).await
        }

        async fn delete(&self, key: &str) -> crate::Result<()> {
            self.inner.delete(key).await
        }

        async fn list(&self, prefix: &str) -> crate::Result<Vec<String>> {
            self.inner.list(prefix).await
        }
    }

    let storage = Arc::new(Flaky {
        inner: InMemoryStorage::new(),
        fail_next_read: std::sync::atomic::AtomicBool::new(false),
    });
    let manager = || {
        SessionManager::builder()
            .session_id(SESSION)
            .storage(storage.clone())
            .build()
            .unwrap()
    };
    let mut first = crate::Agent::builder()
        .model(MockModel::new().with_turn("one"))
        .session_manager(manager())
        .printer(false)
        .build()
        .unwrap();
    first.invoke("first").await.unwrap();

    storage.fail_next_read.store(true, Ordering::SeqCst);
    let mut second = crate::Agent::builder()
        .model(MockModel::new().with_turn("two"))
        .session_manager(manager())
        .printer(false)
        .build()
        .unwrap();
    let error = second.invoke("second").await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Failed to read 'test-session/scopes/agent/agent/snapshots/snapshot_latest.json' from storage"
    );
    second.invoke("second").await.unwrap();

    let texts: Vec<String> = second.messages().iter().map(Message::text).collect();
    assert_eq!(texts, ["first", "one", "second", "two"]);
}
