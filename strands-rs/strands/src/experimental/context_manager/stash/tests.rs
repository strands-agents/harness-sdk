use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::storage::InMemoryStorage;
use crate::types::{ImageBlock, ImageFormat, ImageSource, Role, ToolResultContent};

fn stash() -> Stash {
    Stash::new(Arc::new(InMemoryStorage::new()), "test-session", "test-agent").unwrap()
}

fn bytes(value: &JsonValue) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

#[tokio::test]
async fn round_trips_text_content() {
    let stash = stash();
    let data = json!({"type": "text", "text": "hello world"});
    let reference = stash.store("tool-123", 0, &bytes(&data)).await.unwrap();
    assert!(reference.contains("tool-123"));
    assert_eq!(stash.retrieve(&reference).await.unwrap(), Some(data));
}

#[tokio::test]
async fn round_trips_json_content() {
    let stash = stash();
    let data = json!({"key": "value", "count": 42});
    let reference = stash.store("tool-456", 1, &bytes(&data)).await.unwrap();
    assert_eq!(stash.retrieve(&reference).await.unwrap(), Some(data));
}

#[tokio::test]
async fn returns_null_for_unknown_references() {
    assert_eq!(stash().retrieve("nonexistent").await.unwrap(), None);
}

#[tokio::test]
async fn produces_deterministic_keys_from_the_same_id_and_block_index() {
    let stash = stash();
    let content = bytes(&json!("data"));
    let first = stash.store("tool-1", 0, &content).await.unwrap();
    let second = stash.store("tool-1", 0, &content).await.unwrap();
    assert_eq!(first, second);
}

#[tokio::test]
async fn produces_different_keys_for_different_id_or_block_index() {
    let stash = stash();
    let content = bytes(&json!("data"));
    let first = stash.store("tool-1", 0, &content).await.unwrap();
    let second = stash.store("tool-1", 1, &content).await.unwrap();
    let third = stash.store("tool-2", 0, &content).await.unwrap();
    assert_ne!(first, second);
    assert_ne!(first, third);
}

#[tokio::test]
async fn lists_all_stored_references() {
    let stash = stash();
    let content = bytes(&json!("data"));
    let first = stash.store("tool-a", 0, &content).await.unwrap();
    let second = stash.store("tool-b", 0, &content).await.unwrap();
    let keys = stash.list().await.unwrap();
    assert!(keys.contains(&first));
    assert!(keys.contains(&second));
}

#[tokio::test]
async fn removes_a_stashed_entry() {
    let stash = stash();
    let reference = stash.store("tool-x", 0, &bytes(&json!("data"))).await.unwrap();
    stash.delete(&reference).await.unwrap();
    assert_eq!(stash.retrieve(&reference).await.unwrap(), None);
}

#[tokio::test]
async fn does_not_conflict_with_other_storage_users() {
    let storage = Arc::new(InMemoryStorage::new());
    let stash = Stash::new(storage.clone(), "test-session", "test-agent").unwrap();
    stash.store("tool-1", 0, &bytes(&json!("stash data"))).await.unwrap();
    storage.write("other-key", b"other").await.unwrap();
    let keys = storage.list("").await.unwrap();
    assert!(keys.iter().any(|key| key.starts_with("context/")));
    assert!(keys.contains(&"other-key".to_owned()));
}

#[tokio::test]
async fn uses_the_view_as_the_exact_root() {
    let storage = InMemoryStorage::new();
    let view = Arc::new(storage.namespace("tenants/t1/research").unwrap());
    let stash = Stash::with_namespace(view, "sess-1", "agent-a", true).unwrap();
    stash
        .store("tool-1", 0, &bytes(&json!({"text": "test"})))
        .await
        .unwrap();
    assert_eq!(storage.list("").await.unwrap(), ["tenants/t1/research/tool-1_0"]);
}

#[tokio::test]
async fn uses_the_per_agent_root_under_a_view_unless_allowed() {
    let storage = InMemoryStorage::new();
    let stash = Stash::new(Arc::new(storage.namespace("tenant").unwrap()), "sess-1", "agent-a").unwrap();
    stash
        .store("tool-1", 0, &bytes(&json!({"text": "test"})))
        .await
        .unwrap();
    assert_eq!(
        storage.list("").await.unwrap(),
        ["tenant/context/sess-1/scopes/agent/agent-a/tool-1_0"]
    );
}

#[tokio::test]
async fn lets_agents_in_different_sessions_sharing_a_view_read_each_other_entries() {
    let storage = InMemoryStorage::new();
    let first = Stash::with_namespace(Arc::new(storage.namespace("team").unwrap()), "sess-1", "agent-a", true).unwrap();
    let second =
        Stash::with_namespace(Arc::new(storage.namespace("team").unwrap()), "sess-2", "agent-b", true).unwrap();
    first
        .store("tool-1", 0, &bytes(&json!({"text": "from a"})))
        .await
        .unwrap();
    assert_eq!(
        second.retrieve("tool-1_0").await.unwrap(),
        Some(json!({"text": "from a"}))
    );
}

#[tokio::test]
async fn keeps_a_shared_view_on_clear_session() {
    let storage = InMemoryStorage::new();
    let stash = Stash::with_namespace(Arc::new(storage.namespace("team").unwrap()), "sess-1", "agent-a", true).unwrap();
    stash
        .store("tool-1", 0, &bytes(&json!({"text": "shared"})))
        .await
        .unwrap();
    stash.clear_session().await.unwrap();
    assert_eq!(storage.list("").await.unwrap(), ["team/tool-1_0"]);
}

#[tokio::test]
async fn clears_the_session_for_every_agent() {
    let storage = Arc::new(InMemoryStorage::new());
    let first = Stash::new(storage.clone(), "sess-1", "agent-a").unwrap();
    let second = Stash::new(storage.clone(), "sess-1", "agent-b").unwrap();
    let other = Stash::new(storage.clone(), "sess-2", "agent-a").unwrap();
    for stash in [&first, &second, &other] {
        stash.store("tool-1", 0, b"{}").await.unwrap();
    }
    first.clear_session().await.unwrap();
    assert_eq!(
        storage.list("").await.unwrap(),
        ["context/sess-2/scopes/agent/agent-a/tool-1_0"]
    );
}

#[test]
fn detects_formatted_refs() {
    for refs in [
        vec!["tu-1_0".to_owned()],
        vec!["tu-1_0".to_owned(), "tu-1_1".to_owned()],
    ] {
        let text = format!("[Dropped]{}", format_stash_refs(&refs));
        assert!(is_offload_placeholder_data(&json!({ "text": text })));
        assert!(is_offload_placeholder(&ContentBlock::text(text)));
    }
}

#[test]
fn ignores_non_placeholder() {
    for data in [
        json!({"text": "plain text"}),
        json!({"text": "see [ref: x] for details"}),
        json!({"json": {"text": "[Dropped] [ref: tu-1_0]"}}),
        json!("[Dropped] [ref: tu-1_0]"),
        JsonValue::Null,
    ] {
        assert!(!is_offload_placeholder_data(&data), "{data}");
    }
}

#[tokio::test]
async fn skips_a_tool_result_carrying_stash_refs_including_its_other_items() {
    let stash = stash();
    let message = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tu-1",
            vec![
                ToolResultContent::text("[Truncated: 1 block, ~10,973 tokens]\n\nrow-1\n\n[Stashed] [ref: tu-1_0]"),
                ToolResultContent::Image(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]))),
            ],
        ))],
    );
    stash.store_message(&message, None).await;
    assert!(stash.take_snapshot().await.unwrap().is_empty());
}

#[tokio::test]
async fn skips_a_text_placeholder_and_keeps_other_blocks() {
    let stash = stash();
    let message = Message::new(
        Role::User,
        vec![
            ContentBlock::text("[Dropped] [refs: track-1_0, track-1_1]"),
            ContentBlock::text("see [ref: x] for details"),
        ],
    )
    .with_tracking_id("track-1");
    stash.store_message(&message, None).await;
    assert_eq!(
        JsonValue::Object(stash.take_snapshot().await.unwrap()),
        json!({"track-1_1": {"text": "see [ref: x] for details"}})
    );
}

#[tokio::test]
async fn loads_a_snapshot_back_into_an_empty_stash() {
    let source = stash();
    source.store("tool-1", 0, &bytes(&json!({"text": "a"}))).await.unwrap();
    let entries = source.take_snapshot().await.unwrap();
    let target = stash();
    target.load_snapshot(&entries).await.unwrap();
    assert_eq!(target.take_snapshot().await.unwrap(), entries);
    assert_eq!(target.storage_type_name(), "InMemoryStorage");
}
