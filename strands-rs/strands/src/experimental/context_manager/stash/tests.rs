use std::collections::HashSet;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::storage::InMemoryStorage;
use crate::types::{
    ImageBlock, ImageFormat, ImageSource, OffloadMethod, Offloaded, Role, TextBlock, ToolResultContent,
};

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
async fn lists_all_stored_references() {
    let stash = stash();
    let content = bytes(&json!("data"));
    let first = stash.store("tool-a", 0, &content).await.unwrap();
    let second = stash.store("tool-b", 0, &content).await.unwrap();
    let keys = stash.list("").await.unwrap();
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
fn round_trips_stash_keys() {
    for (id, index) in [("tu-1", 0), ("call_12", 3), ("removed-0199-abc", 0)] {
        let key = format_stash_key(id, index);
        assert_eq!(
            parse_stash_key(&key),
            Some(StashKey {
                id: id.to_owned(),
                index
            })
        );
    }
}

#[test]
fn rejects_text_that_is_not_a_stash_key() {
    for key in ["tu-1", "tu-1_", "_0", "tu-1_x", "tu-1_1a"] {
        assert_eq!(parse_stash_key(key), None, "{key}");
    }
}

#[tokio::test]
async fn ensure_stashed_references_a_tool_result_by_its_tool_use_id_and_any_other_block_by_its_position() {
    let stash = stash();
    let tool_result = ContentBlock::ToolResult(ToolResultBlock::success("tu-1", vec![ToolResultContent::text("a")]));
    let message =
        Message::new(Role::User, vec![ContentBlock::text("t"), tool_result.clone()]).with_tracking_id("track-1");
    assert_eq!(stash.ensure_stashed(&tool_result, &message, 1).await.unwrap(), "tu-1");
    assert_eq!(
        stash.ensure_stashed(&message.content[0], &message, 0).await.unwrap(),
        "track-1_0"
    );
    assert_eq!(
        JsonValue::Object(stash.take_snapshot().await.unwrap()),
        json!({"track-1_0": {"text": "t"}, "tu-1_0": {"text": "a"}})
    );
}

#[tokio::test]
async fn ensure_stashed_leaves_an_entry_already_stored_under_the_reference_untouched() {
    let stash = stash();
    stash
        .store("track-1", 0, &bytes(&json!({"text": "original"})))
        .await
        .unwrap();
    let message = Message::new(Role::User, vec![ContentBlock::text("edited")]).with_tracking_id("track-1");
    assert_eq!(
        stash.ensure_stashed(&message.content[0], &message, 0).await.unwrap(),
        "track-1_0"
    );
    assert_eq!(
        stash.retrieve("track-1_0").await.unwrap(),
        Some(json!({"text": "original"}))
    );
}

#[tokio::test]
async fn stashes_text_that_only_looks_like_a_placeholder() {
    let stash = stash();
    let message =
        Message::new(Role::User, vec![ContentBlock::text("[Dropped] [ref: tu-1]")]).with_tracking_id("track-1");
    stash.store_message(&message, None, None).await;
    assert_eq!(
        JsonValue::Object(stash.take_snapshot().await.unwrap()),
        json!({"track-1_0": {"text": "[Dropped] [ref: tu-1]"}})
    );
}

#[tokio::test]
async fn skips_a_placeholder_and_a_tool_result_that_holds_one_keeping_other_blocks() {
    let stash = stash();
    let dropped = TextBlock::offloaded(
        "[Dropped] [ref: track-0_0]",
        Offloaded::new(OffloadMethod::Drop).with_reference("track-0_0"),
    );
    let truncated = TextBlock::offloaded(
        "[Truncated: 1 block, ~10,973 tokens]\n\nrow-1 [ref: tu-1]",
        Offloaded::new(OffloadMethod::Truncate).with_reference("tu-1"),
    );
    let message = Message::new(
        Role::User,
        vec![
            ContentBlock::Text(dropped),
            ContentBlock::ToolResult(ToolResultBlock::success(
                "tu-1",
                vec![
                    ToolResultContent::Text(truncated),
                    ToolResultContent::Image(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]))),
                ],
            )),
            ContentBlock::text("kept"),
        ],
    )
    .with_tracking_id("track-1");
    stash.store_message(&message, None, None).await;
    assert_eq!(
        JsonValue::Object(stash.take_snapshot().await.unwrap()),
        json!({"track-1_2": {"text": "kept"}})
    );
}

#[tokio::test]
async fn keeps_an_entry_already_stored_when_a_restored_history_holds_a_placeholder() {
    let stash = stash();
    stash
        .store("track-1", 0, &bytes(&json!({"text": "original"})))
        .await
        .unwrap();
    let message = Message::new(Role::User, vec![ContentBlock::text("edited")]).with_tracking_id("track-1");
    let stored: HashSet<String> = stash.list("").await.unwrap().into_iter().collect();
    stash.store_message(&message, None, Some(&stored)).await;
    assert_eq!(
        stash.retrieve("track-1_0").await.unwrap(),
        Some(json!({"text": "original"}))
    );
}

#[tokio::test]
async fn stores_removed_messages_under_one_reference() {
    let stash = stash();
    let removed = [Message::user("q1").with_tracking_id("m1"), Message::assistant("a1")];
    let reference = stash.store_removed(&removed).await.unwrap();
    assert_eq!(reference, "removed-m1");
    assert_eq!(stash.keys_of(&reference).await.unwrap(), ["removed-m1_0"]);
}

#[tokio::test]
async fn keys_of_leaves_out_ids_that_extend_the_id() {
    let stash = stash();
    for (id, index) in [("tu-1", 1), ("tu-1", 0), ("tu-10", 0), ("tu-1_x", 0)] {
        stash.store(id, index, &bytes(&json!("data"))).await.unwrap();
    }
    assert_eq!(stash.keys_of("tu-1").await.unwrap(), ["tu-1_0", "tu-1_1"]);
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
