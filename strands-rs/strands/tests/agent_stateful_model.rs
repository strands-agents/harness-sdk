//! An agent on a model that keeps the conversation server-side.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

use std::sync::{Arc, Mutex};

use serde_json::json;
use strands::models::{BaseModelConfig, BoxStream, Model, ModelRequest};
use strands::storage::{InMemoryStorage, Storage};
use strands::testing::MockModel;
use strands::{Agent, ModelStreamEvent, SessionManager, StateStore};

/// A model that reports itself stateful and writes a fresh response id into the model state it
/// receives, as a server-side conversation provider does (`StatefulMockModel`).
#[derive(Clone)]
struct StatefulMockModel {
    inner: MockModel,
    response_ids: Vec<&'static str>,
    received: Arc<Mutex<Vec<StateStore>>>,
    seen_response_ids: Arc<Mutex<Vec<Option<serde_json::Value>>>>,
}

impl StatefulMockModel {
    fn new(response_ids: &[&'static str], turns: &[&str]) -> Self {
        Self {
            inner: MockModel::from_turns(turns.iter().copied()),
            response_ids: response_ids.to_vec(),
            received: Arc::default(),
            seen_response_ids: Arc::default(),
        }
    }

    fn received(&self) -> Vec<StateStore> {
        self.received.lock().unwrap().clone()
    }
}

#[strands::async_trait]
impl Model for StatefulMockModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, strands::Result<ModelStreamEvent>> {
        let mut received = self.received.lock().unwrap();
        received.push(request.model_state.clone());
        self.seen_response_ids
            .lock()
            .unwrap()
            .push(request.model_state.get_value("responseId"));
        if let Some(next) = self.response_ids.get(received.len() - 1) {
            request.model_state.set("responseId", *next).unwrap();
        }
        drop(received);
        self.inner.stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> strands::Result<()> {
        self.inner.update_config(config)
    }

    fn stateful(&self) -> bool {
        true
    }
}

fn agent(model: impl Model) -> Agent {
    Agent::builder().model(model).printer(false).build().unwrap()
}

// --- constructor ---

#[test]
fn initializes_model_state_as_an_empty_store() {
    let agent = agent(StatefulMockModel::new(&["resp_1"], &[]));
    assert!(agent.model_state().get_all().is_empty());
}

#[test]
fn hydrates_model_state_from_agent_config_model_state() {
    let agent = Agent::builder()
        .model(StatefulMockModel::new(&["resp_1"], &[]))
        .model_state(json!({"responseId": "resp_restored"}).as_object().unwrap().clone())
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(
        serde_json::Value::Object(agent.model_state().get_all()),
        json!({"responseId": "resp_restored"})
    );
}

// --- invocation ---

#[tokio::test]
async fn passes_model_state_snapshot_to_the_model_and_writes_back_changes() {
    let model = StatefulMockModel::new(&["resp_first"], &["Hi"]);
    let mut agent = agent(model.clone());
    agent.invoke("Hello").await.unwrap();

    agent.model_state().set("probe", 1).unwrap();
    assert_eq!(model.received()[0].get_value("probe"), None, "the model got a copy");
    agent.model_state().delete("probe");
    assert_eq!(
        serde_json::Value::Object(agent.model_state().get_all()),
        json!({"responseId": "resp_first"})
    );
}

#[tokio::test]
async fn clears_messages_after_invocation_since_the_server_holds_history() {
    let mut agent = agent(StatefulMockModel::new(&["resp_1"], &["Hi there"]));
    agent.invoke("First turn").await.unwrap();
    assert!(agent.messages().is_empty());
}

#[tokio::test]
async fn preserves_model_state_across_invocations_so_previous_response_id_chains() {
    let model = StatefulMockModel::new(&["resp_1", "resp_2"], &["one", "two"]);
    let mut agent = agent(model.clone());

    agent.invoke("turn 1").await.unwrap();
    assert_eq!(agent.model_state().get_value("responseId"), Some(json!("resp_1")));
    agent.invoke("turn 2").await.unwrap();
    assert_eq!(agent.model_state().get_value("responseId"), Some(json!("resp_2")));

    assert_eq!(model.received().len(), 2);
    assert_eq!(*model.seen_response_ids.lock().unwrap(), [None, Some(json!("resp_1"))]);
}

#[tokio::test]
async fn clears_messages_before_session_manager_snapshots_on_after_invocation_event() {
    let storage = Arc::new(InMemoryStorage::new());
    let session_manager = SessionManager::builder()
        .session_id("test-session")
        .storage(storage.clone())
        .build()
        .unwrap();
    let mut agent = Agent::builder()
        .id("agent-1")
        .model(StatefulMockModel::new(&["resp_1"], &["reply"]))
        .session_manager(session_manager)
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("hi").await.unwrap();

    let bytes = storage
        .read("session/test-session/scopes/agent/agent-1/snapshots/snapshot_latest.json")
        .await
        .unwrap()
        .expect("the session manager saved a snapshot");
    let snapshot: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(snapshot["data"]["messages"], json!([]));
}

// --- stateless model (default) ---

#[tokio::test]
async fn does_not_clear_messages_after_invocation() {
    let mut agent = agent(MockModel::from_turns(["Hello"]));
    agent.invoke("Hi").await.unwrap();
    assert_eq!(agent.messages().len(), 2);
}

// --- SessionManager restore guard ---

/// A session storage whose `snapshot_latest` for `agent_id` holds one old user message.
async fn storage_with_messages(agent_id: &str, session_id: &str) -> Arc<InMemoryStorage> {
    let storage = Arc::new(InMemoryStorage::new());
    let snapshot = json!({
        "scope": "agent",
        "schemaVersion": "1.0",
        "createdAt": "2026-11-11T12:00:00.000Z",
        "data": {
            "messages": [{"role": "user", "content": [{"text": "old turn"}]}],
            "state": {},
            "systemPrompt": null,
            "modelState": {}
        },
        "appData": {}
    });
    let key = format!("session/{session_id}/scopes/agent/{agent_id}/snapshots/snapshot_latest.json");
    storage
        .write(&key, &serde_json::to_vec(&snapshot).unwrap())
        .await
        .unwrap();
    storage
}

fn session_agent(id: &str, session_id: &str, storage: Arc<InMemoryStorage>, model: impl Model) -> Agent {
    let session_manager = SessionManager::builder()
        .session_id(session_id)
        .storage(storage)
        .build()
        .unwrap();
    Agent::builder()
        .id(id)
        .model(model)
        .session_manager(session_manager)
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn discards_restored_messages_when_the_model_is_stateful() {
    let storage = storage_with_messages("agent-1", "session-stateful").await;
    let mut agent = session_agent("agent-1", "session-stateful", storage, StatefulMockModel::new(&[], &[]));

    agent.initialize().await.unwrap();

    assert!(agent.messages().is_empty());
}

#[tokio::test]
async fn restores_messages_when_the_model_is_stateless() {
    let storage = storage_with_messages("agent-2", "session-stateless").await;
    let mut agent = session_agent("agent-2", "session-stateless", storage, MockModel::new());

    agent.initialize().await.unwrap();

    assert_eq!(agent.messages().len(), 1);
    assert_eq!(agent.messages()[0].role, strands::Role::User);
}
