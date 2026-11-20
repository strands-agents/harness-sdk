//! Agent-level storage flowing to the session manager, and the `storage` property. The context
//! manager stash cases are tested with the context manager.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

use std::sync::Arc;

use strands::storage::{InMemoryStorage, Storage};
use strands::testing::MockModel;
use strands::{Agent, SessionManager};

fn model() -> MockModel {
    MockModel::new().with_turn("hi")
}

fn session_manager(storage: Option<Arc<InMemoryStorage>>) -> SessionManager {
    SessionManager::builder()
        .session_id("test-session")
        .maybe_storage(storage.map(|storage| storage as Arc<dyn Storage>))
        .build()
        .unwrap()
}

#[tokio::test]
async fn session_manager_resolves_storage_from_agent_when_not_explicitly_provided() {
    let storage = Arc::new(InMemoryStorage::new());
    let mut agent = Agent::builder()
        .model(model())
        .storage(storage.clone())
        .session_manager(session_manager(None))
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("hi").await.unwrap();

    assert!(!storage.list("session/").await.unwrap().is_empty());
}

#[tokio::test]
async fn explicit_session_manager_storage_overrides_agent_storage() {
    let agent_storage = Arc::new(InMemoryStorage::new());
    let session_storage = Arc::new(InMemoryStorage::new());
    let mut agent = Agent::builder()
        .model(model())
        .storage(agent_storage.clone())
        .session_manager(session_manager(Some(session_storage.clone())))
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("hi").await.unwrap();

    assert!(!session_storage.list("session/").await.unwrap().is_empty());
    assert!(agent_storage.list("session/").await.unwrap().is_empty());
}

#[tokio::test]
async fn throws_when_session_manager_has_no_storage_and_agent_has_no_storage() {
    let mut agent = Agent::builder()
        .model(model())
        .session_manager(session_manager(None))
        .printer(false)
        .build()
        .unwrap();

    let error = agent.invoke("hi").await.unwrap_err();

    assert!(
        error.to_string().contains("SessionManager requires a storage backend"),
        "{error}"
    );
}

#[test]
fn returns_the_configured_storage() {
    let storage: Arc<dyn Storage> = Arc::new(InMemoryStorage::new());
    let agent = Agent::builder()
        .model(model())
        .storage(storage.clone())
        .printer(false)
        .build()
        .unwrap();

    assert!(Arc::ptr_eq(agent.storage().unwrap(), &storage));
}

#[test]
fn returns_undefined_when_no_storage_configured() {
    let agent = Agent::builder().model(model()).printer(false).build().unwrap();

    assert!(agent.storage().is_none());
}

#[test]
fn the_session_id_and_model_metadata_come_from_the_session_manager() {
    let manager = session_manager(Some(Arc::new(InMemoryStorage::new())));
    let agent = Agent::builder()
        .model(model())
        .session_manager(manager)
        .printer(false)
        .build()
        .unwrap();
    let plain = Agent::builder().model(model()).printer(false).build().unwrap();

    assert_eq!(agent.session_id(), "test-session");
    assert_eq!(
        agent.session_manager().map(SessionManager::session_id),
        Some("test-session")
    );
    assert_eq!(
        agent
            .local()
            .agent_metadata()
            .and_then(|metadata| metadata.session_id.as_deref()),
        Some("test-session")
    );
    assert!(plain.local().agent_metadata().is_none());
    assert!(plain.session_manager().is_none());
}

#[tokio::test]
async fn the_model_receives_the_session_id() {
    let model = model();
    let mut agent = Agent::builder()
        .model(model.clone())
        .session_manager(session_manager(Some(Arc::new(InMemoryStorage::new()))))
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("hi").await.unwrap();

    let metadata = model.requests()[0].agent_metadata.clone().unwrap();
    assert_eq!(metadata.session_id.as_deref(), Some("test-session"));
}

#[tokio::test]
async fn a_rebuilt_agent_resumes_the_saved_conversation() {
    let storage = Arc::new(InMemoryStorage::new());
    let mut first = Agent::builder()
        .model(model())
        .session_manager(session_manager(Some(storage.clone())))
        .printer(false)
        .build()
        .unwrap();
    first.invoke("hi").await.unwrap();
    first.app_state().set("count", 1).unwrap();
    first
        .session_manager()
        .unwrap()
        .save_snapshot(first.local(), true)
        .await
        .unwrap();

    let model = MockModel::new().with_turn("again");
    let mut second = Agent::builder()
        .model(model.clone())
        .session_manager(session_manager(Some(storage)))
        .printer(false)
        .build()
        .unwrap();
    second.invoke("next").await.unwrap();

    assert_eq!(model.requests()[0].messages.len(), 3);
    assert_eq!(second.app_state().get::<u32>("count").unwrap(), Some(1));
    assert_eq!(second.messages().len(), 4);
}

#[tokio::test]
async fn the_builders_take_storage_and_a_sandbox_by_value() {
    let mut agent = Agent::builder()
        .model(model())
        .storage(InMemoryStorage::new())
        .sandbox(strands::sandbox::NotASandboxLocalEnvironment::new())
        .session_manager(
            SessionManager::builder()
                .session_id("by-value")
                .storage(InMemoryStorage::new())
                .build()
                .unwrap(),
        )
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("hello").await.unwrap();
    assert_eq!(agent.storage().unwrap().storage_type(), "InMemoryStorage");
}

#[test]
fn an_arc_of_a_concrete_storage_is_kept_as_the_same_instance() {
    let storage = Arc::new(InMemoryStorage::new());
    let agent = Agent::builder()
        .model(model())
        .storage(storage.clone())
        .printer(false)
        .build()
        .unwrap();
    let shared: Arc<dyn Storage> = storage;
    assert!(Arc::ptr_eq(agent.storage().unwrap(), &shared));
}
