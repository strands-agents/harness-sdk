//! Cross-SDK sessions: Rust restores the session tree a TS `SessionManager` wrote through
//! `LocalFileStorage` (`conformance/fixtures/session-tree/`, written by `conformance/generate.ts`),
//! and TS restores one Rust wrote (`conformance/check-session-tree.ts`, run through `npx tsx` only
//! when `STRANDS_CONFORMANCE_TS=1`).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use common::{MockTool, tool_use_turn};
use serde_json::{Value, json};
use strands::storage::LocalFileStorage;
use strands::testing::MockModel;
use strands::{Agent, SessionManager, SnapshotTriggerCallback};

const TS_SESSION: &str = "conformance-session";
const TS_AGENT: &str = "conformance-agent";
const TS_SNAPSHOTS: &str = "session/conformance-session/scopes/agent/conformance-agent/snapshots";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture_tree() -> PathBuf {
    repo_root().join("strands-rs/conformance/fixtures/session-tree")
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn session_agent(dir: &Path, session_id: &str, agent_id: &str, model: MockModel) -> Agent {
    session_agent_with(dir, session_id, agent_id, model, None)
}

fn session_agent_with(
    dir: &Path,
    session_id: &str,
    agent_id: &str,
    model: MockModel,
    snapshot_trigger: Option<SnapshotTriggerCallback>,
) -> Agent {
    let session_manager = SessionManager::builder()
        .session_id(session_id)
        .storage(Arc::new(LocalFileStorage::new(dir)))
        .maybe_snapshot_trigger(snapshot_trigger)
        .build()
        .unwrap();
    Agent::builder()
        .id(agent_id)
        .model(model)
        .tools([MockTool::text("get_weather", "sunny")])
        .session_manager(session_manager)
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn restores_the_session_tree_ts_wrote() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture_tree(), dir.path());
    let snapshots = dir.path().join(TS_SNAPSHOTS);
    let latest = read_json(&snapshots.join("snapshot_latest.json"));
    let mut agent = session_agent(dir.path(), TS_SESSION, TS_AGENT, MockModel::new());

    agent.initialize().await.unwrap();

    assert_eq!(
        serde_json::to_value(agent.messages()).unwrap(),
        latest["data"]["messages"]
    );
    assert_eq!(
        Value::Object(agent.app_state().get_all()),
        json!({"units": "metric", "visits": 1})
    );
    assert_eq!(
        serde_json::to_value(agent.system_prompt()).unwrap(),
        json!("You are a weather assistant.")
    );
    assert_eq!(agent.messages().len(), 4);

    let manager = agent.session_manager().unwrap().clone();
    let ids = manager.list_snapshot_ids(agent.local(), None, None).await.unwrap();
    let history: Vec<String> = std::fs::read_dir(snapshots.join("immutable_history"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(history, [format!("snapshot_{}.json", ids[0])]);

    let mut from_history = session_agent(dir.path(), "other-session", TS_AGENT, MockModel::new());
    assert!(
        manager
            .restore_snapshot(from_history.local_mut(), Some(&ids[0]))
            .await
            .unwrap()
    );
    assert_eq!(from_history.messages(), agent.messages());
}

#[tokio::test]
async fn writes_back_the_data_ts_wrote() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture_tree(), dir.path());
    let ts_latest = read_json(&dir.path().join(TS_SNAPSHOTS).join("snapshot_latest.json"));
    let mut agent = session_agent(dir.path(), TS_SESSION, TS_AGENT, MockModel::new());
    agent.initialize().await.unwrap();

    let out = tempfile::tempdir().unwrap();
    let manager = SessionManager::builder()
        .session_id(TS_SESSION)
        .storage(Arc::new(LocalFileStorage::new(out.path())))
        .build()
        .unwrap();
    manager.save_snapshot(agent.local(), true).await.unwrap();

    let rust_path = out.path().join(TS_SNAPSHOTS).join("snapshot_latest.json");
    let rust_latest = read_json(&rust_path);
    assert_eq!(rust_latest["data"], ts_latest["data"]);
    assert_eq!(rust_latest["scope"], ts_latest["scope"]);
    assert_eq!(rust_latest["schemaVersion"], ts_latest["schemaVersion"]);

    let ts_bytes = std::fs::read_to_string(dir.path().join(TS_SNAPSHOTS).join("snapshot_latest.json")).unwrap();
    let rust_bytes = std::fs::read_to_string(&rust_path).unwrap();
    assert_eq!(mask_created_at(&rust_bytes), mask_created_at(&ts_bytes));
}

/// The snapshot text with the `createdAt` value blanked, so two writes compare byte for byte,
/// key order included.
fn mask_created_at(text: &str) -> String {
    let key = "\"createdAt\":\"";
    let start = text.find(key).expect("snapshot has createdAt") + key.len();
    let end = start + text[start..].find('"').expect("createdAt is a string");
    format!("{}{}", &text[..start], &text[end..])
}

#[tokio::test]
async fn ts_restores_the_session_tree_rust_wrote() {
    if std::env::var("STRANDS_CONFORMANCE_TS").as_deref() != Ok("1") {
        eprintln!("skipping: set STRANDS_CONFORMANCE_TS=1 to run the TS session check through npx tsx");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let model = MockModel::new()
        .with_turn(tool_use_turn("get_weather", "tooluse-1", json!({"city": "Seattle"})))
        .with_turn("It is sunny in Seattle.");
    let mut agent = session_agent_with(
        dir.path(),
        "rust-session",
        "rust-agent",
        model,
        Some(SnapshotTriggerCallback::new(|_| true)),
    );
    agent.app_state().set("units", "metric").unwrap();
    agent.set_system_prompt(Some("You are a weather assistant.".into()));
    agent.invoke("What is the weather in Seattle?").await.unwrap();
    let ids = agent
        .session_manager()
        .unwrap()
        .list_snapshot_ids(agent.local(), None, None)
        .await
        .unwrap();

    let output = Command::new("npx")
        .args(["tsx", "strands-rs/conformance/check-session-tree.ts"])
        .arg(dir.path())
        .args(["rust-session", "rust-agent"])
        .current_dir(repo_root())
        .output()
        .expect("npx runs");
    assert!(
        output.status.success(),
        "check-session-tree.ts failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let restored: Value = serde_json::from_slice(&output.stdout).unwrap();

    let messages = serde_json::to_value(agent.messages()).unwrap();
    assert_eq!(messages.as_array().unwrap().len(), 4);
    assert_eq!(restored["messages"], messages);
    assert_eq!(restored["appState"], json!({"units": "metric"}));
    assert_eq!(restored["systemPrompt"], json!("You are a weather assistant."));
    assert_eq!(restored["snapshotIds"], json!(ids));
    assert_eq!(restored["historyMessages"], messages);
}
