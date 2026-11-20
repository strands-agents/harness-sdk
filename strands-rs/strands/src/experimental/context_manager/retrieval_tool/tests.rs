//! Tests for the retrieval tool, including media restoration.

use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::experimental::context_manager::test_support::tool_result_message;
use crate::storage::InMemoryStorage;
use crate::types::{ImageBlock, ImageFormat, ImageSource, ToolResultBlock, ToolResultContent};

fn stash() -> Stash {
    Stash::new(Arc::new(InMemoryStorage::new()), "test-session", "test-agent").unwrap()
}

async fn invoke(stash: &Stash, input: JsonValue) -> JsonValue {
    let input = serde_json::from_value(input).unwrap();
    retrieve_context(stash, input, DEFAULT_MAX_RESULT_TOKENS * CHARS_PER_TOKEN)
        .await
        .unwrap()
}

/// The tool result content the value becomes.
fn content(value: JsonValue) -> Vec<ToolResultContent> {
    wrap_in_tool_result(value, "call-1").content
}

async fn stash_with_text(text: &str) -> (Stash, String) {
    let stash = stash();
    let reference = stash
        .store("tool-1", 0, &serde_json::to_vec(&json!({ "text": text })).unwrap())
        .await
        .unwrap();
    (stash, reference)
}

#[test]
fn has_the_correct_tool_name() {
    assert_eq!(RetrievalTool::new(stash(), None).name(), RETRIEVAL_TOOL_NAME);
}

#[tokio::test]
async fn retrieves_full_text_content() {
    let (stash, reference) = stash_with_text("hello world\nline two").await;
    assert_eq!(
        invoke(&stash, json!({ "reference": reference })).await,
        json!({"text": "hello world\nline two"})
    );
}

#[tokio::test]
async fn searches_with_pattern() {
    let text = (0..20)
        .map(|index| format!("line {}: {}", index + 1, if index % 3 == 0 { "ERROR" } else { "ok" }))
        .collect::<Vec<_>>()
        .join("\n");
    let (stash, reference) = stash_with_text(&text).await;
    let result = invoke(&stash, json!({ "reference": reference, "pattern": "ERROR" })).await;
    let result = result.as_str().unwrap();
    assert!(result.contains("ERROR"));
    assert!(result.contains("match"));
}

#[tokio::test]
async fn returns_line_range() {
    let text = (1..=50)
        .map(|index| format!("line {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (stash, reference) = stash_with_text(&text).await;
    let result = invoke(
        &stash,
        json!({ "reference": reference, "line_range": {"start": 5, "end": 10} }),
    )
    .await;
    let result = result.as_str().unwrap();
    assert!(result.contains("line 5"));
    assert!(result.contains("line 10"));
    assert!(!result.contains("line 11"));
}

#[tokio::test]
async fn returns_error_for_unknown_reference() {
    let result = invoke(&stash(), json!({"reference": "nonexistent"})).await;
    assert!(result.as_str().unwrap().contains("Error: reference not found"));
}

#[tokio::test]
async fn returns_error_for_an_offload_placeholder_with_input() {
    for extra in [json!({}), json!({"pattern": "row-4321"})] {
        let (stash, reference) =
            stash_with_text("[Truncated: 1 block, ~10,973 tokens]\n\nrow-1\n\n[Stashed] [ref: tool-1_0]").await;
        let mut input = json!({ "reference": reference });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert_eq!(
            invoke(&stash, input).await,
            json!(format!(
                "Error: original content for reference {reference} is no longer available"
            ))
        );
    }
}

#[tokio::test]
async fn restores_image_content_as_an_image_block_instead_of_raw_json() {
    let stash = stash();
    let data = json!({"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}});
    let reference = stash
        .store("tool-img", 0, &serde_json::to_vec(&data).unwrap())
        .await
        .unwrap();
    let result = content(invoke(&stash, json!({ "reference": reference })).await);
    assert!(matches!(&result[..], [ToolResultContent::Image(image)] if image.format == ImageFormat::Png));
}

#[tokio::test]
async fn retrieves_json_content_as_parsed_object() {
    let stash = stash();
    let json = json!({"key": "value", "nested": [1, 2, 3]});
    let reference = stash
        .store("tool-json", 0, &serde_json::to_vec(&json!({ "json": json })).unwrap())
        .await
        .unwrap();
    assert_eq!(
        invoke(&stash, json!({ "reference": reference })).await,
        json!({ "json": json })
    );
}

#[tokio::test]
async fn returns_error_when_searching_non_text_content() {
    let stash = stash();
    let data = json!({"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}});
    let reference = stash
        .store("tool-img", 0, &serde_json::to_vec(&data).unwrap())
        .await
        .unwrap();
    let result = invoke(&stash, json!({ "reference": reference, "pattern": "test" })).await;
    assert!(result.as_str().unwrap().contains("cannot search non-text content"));
}

#[tokio::test]
async fn truncates_a_full_retrieval_over_the_budget() {
    let (stash, reference) = stash_with_text(&"x".repeat(100)).await;
    let input = serde_json::from_value(json!({ "reference": reference })).unwrap();
    let result = retrieve_context(&stash, input, 20).await.unwrap();
    assert_eq!(result, json!(format!("{{\"text\":\"{}\n\n[truncated]", "x".repeat(11))));
}

#[tokio::test]
async fn restores_image_blocks_as_image_block_instances() {
    let stash = stash();
    let message = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tool-img",
            vec![ToolResultContent::Image(ImageBlock::new(
                ImageFormat::Png,
                ImageSource::Bytes(vec![0x89, 0x50, 0x4e, 0x47]),
            ))],
        ))],
    );
    stash.store_message(&message, None).await;
    let keys = stash.list().await.unwrap();
    let result = content(invoke(&stash, json!({ "reference": keys[0] })).await);
    assert!(matches!(&result[..], [ToolResultContent::Image(image)] if image.format == ImageFormat::Png));
}

#[tokio::test]
async fn returns_text_content_normally_not_treated_as_media() {
    let stash = stash();
    stash
        .store_message(&tool_result_message("hello world", "tool-123"), None)
        .await;
    let keys = stash.list().await.unwrap();
    assert_eq!(
        invoke(&stash, json!({ "reference": keys[0] })).await,
        json!({"text": "hello world"})
    );
}

#[tokio::test]
async fn restores_document_blocks_as_document_block_instances() {
    let stash = stash();
    let data = json!({"document": {"format": "pdf", "name": "doc", "source": {"bytes": "YmFzZTY0"}}});
    let reference = stash
        .store("tool-doc", 0, &serde_json::to_vec(&data).unwrap())
        .await
        .unwrap();
    let result = content(invoke(&stash, json!({ "reference": reference })).await);
    assert!(matches!(&result[..], [ToolResultContent::Document(_)]));
}

async fn outcome(stream: ToolStream) -> Option<ToolOutcome> {
    use futures::StreamExt;
    let mut stream = stream;
    while let Some(item) = stream.next().await {
        if let crate::tools::ToolStreamItem::Outcome(outcome) = item {
            return Some(outcome);
        }
    }
    None
}

#[tokio::test]
async fn the_tool_validates_its_input_and_wraps_the_result() {
    let (stash, reference) = stash_with_text("hello").await;
    let tool = RetrievalTool::new(stash, None);
    let agent = crate::test_support::tool_agent();
    let run = |input: JsonValue| {
        let context = ToolContext::new(
            crate::types::ToolUse::new(RETRIEVAL_TOOL_NAME, "call-1", input),
            agent.clone(),
            crate::agent::InvocationState::new(),
        );
        outcome(tool.stream(context))
    };
    let Some(ToolOutcome::Result(result)) = run(json!({ "reference": reference })).await else {
        panic!("expected a result");
    };
    assert_eq!(result.content, [ToolResultContent::text("hello")]);
    let Some(ToolOutcome::Result(result)) = run(json!({"pattern": "x"})).await else {
        panic!("expected a result");
    };
    assert_eq!(result.status, crate::types::ToolResultStatus::Error);
}
