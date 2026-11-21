//! Tests for the retrieval tool, including media restoration.

use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::context_manager::test_support::tool_result_message;
use crate::storage::InMemoryStorage;
use crate::types::{ImageBlock, ImageFormat, ImageSource, JsonBlock, Role, ToolResultBlock};

fn archive() -> Archive {
    Archive::new(Arc::new(InMemoryStorage::new()), "test-session", "test-agent").unwrap()
}

async fn invoke(archive: &Archive, input: JsonValue) -> JsonValue {
    invoke_within(archive, input, DEFAULT_MAX_RESULT_TOKENS).await
}

/// The error a failed retrieval raises.
async fn invoke_error(archive: &Archive, input: JsonValue) -> String {
    let input = serde_json::from_value(input).unwrap();
    retrieve_context(archive, input, DEFAULT_MAX_RESULT_TOKENS * CHARS_PER_TOKEN)
        .await
        .unwrap_err()
        .to_string()
}

/// Invokes the tool with a result budget of `max_result_tokens`.
async fn invoke_within(archive: &Archive, input: JsonValue, max_result_tokens: usize) -> JsonValue {
    let input = serde_json::from_value(input).unwrap();
    retrieve_context(archive, input, max_result_tokens * CHARS_PER_TOKEN)
        .await
        .unwrap()
}

async fn store(archive: &Archive, id: &str, index: usize, data: &JsonValue) {
    archive
        .store(id, index, &serde_json::to_vec(data).unwrap())
        .await
        .unwrap();
}

fn text(value: &str) -> ToolResultContent {
    ToolResultContent::text(value)
}

/// The tool result content the value becomes.
fn content(value: JsonValue) -> Vec<ToolResultContent> {
    wrap_in_tool_result(value, "call-1").content
}

async fn archive_with_text(text: &str) -> (Archive, String) {
    let archive = archive();
    let reference = archive
        .store("tool-1", 0, &serde_json::to_vec(&json!({ "text": text })).unwrap())
        .await
        .unwrap();
    (archive, reference)
}

#[test]
fn has_the_correct_tool_name() {
    assert_eq!(RetrievalTool::new(archive(), None).name(), RETRIEVAL_TOOL_NAME);
}

#[tokio::test]
async fn retrieves_full_text_content() {
    let (archive, reference) = archive_with_text("hello world\nline two").await;
    assert_eq!(
        content(invoke(&archive, json!({ "reference": reference })).await),
        [text("hello world\nline two")]
    );
}

#[tokio::test]
async fn searches_with_pattern() {
    let text = (0..20)
        .map(|index| format!("line {}: {}", index + 1, if index % 3 == 0 { "ERROR" } else { "ok" }))
        .collect::<Vec<_>>()
        .join("\n");
    let (archive, reference) = archive_with_text(&text).await;
    let result = invoke(&archive, json!({ "reference": reference, "pattern": "ERROR" })).await;
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
    let (archive, reference) = archive_with_text(&text).await;
    let result = invoke(
        &archive,
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
    assert_eq!(
        invoke_error(&archive(), json!({"reference": "[ref: nonexistent]"})).await,
        "reference not found: [ref: nonexistent]. Pass only the <id> from the placeholder's \"[ref: <id>]\". If that is what you passed, the content is unavailable — do not retry."
    );
}

#[tokio::test]
async fn ignores_whitespace_around_the_reference() {
    let archive = archive();
    store(&archive, "tool-1", 0, &json!({"text": "original"})).await;
    assert_eq!(
        content(invoke(&archive, json!({"reference": " tool-1 "})).await),
        [text("original")]
    );
}

#[tokio::test]
async fn returns_stored_text_that_only_looks_like_a_placeholder() {
    let archive = archive();
    store(&archive, "tool-1", 0, &json!({"text": "[Dropped] [ref: tool-2]"})).await;
    assert_eq!(
        content(invoke(&archive, json!({"reference": "tool-1"})).await),
        [text("[Dropped] [ref: tool-2]")]
    );
}

async fn archive_with_items() -> Archive {
    let archive = archive();
    store(&archive, "tool-1", 2, &json!({"text": "third ERROR"})).await;
    store(&archive, "tool-1", 0, &json!({"text": "first"})).await;
    store(&archive, "tool-1", 1, &json!({"json": {"count": 2}})).await;
    store(&archive, "tool-10", 0, &json!({"text": "another tool"})).await;
    archive
}

#[tokio::test]
async fn returns_every_stored_item_of_a_tool_result_in_index_order() {
    assert_eq!(
        content(invoke(&archive_with_items().await, json!({"reference": "tool-1"})).await),
        [
            text("first"),
            ToolResultContent::Json(JsonBlock::new(json!({"count": 2}))),
            text("third ERROR"),
        ]
    );
}

#[tokio::test]
async fn leaves_out_the_textual_items_after_the_one_that_exhausts_the_budget() {
    let archive = archive();
    store(&archive, "tool-1", 0, &json!({"text": "a".repeat(30)})).await;
    store(&archive, "tool-1", 1, &json!({"text": "b".repeat(30)})).await;
    store(&archive, "tool-1", 2, &json!({"text": "c".repeat(5)})).await;
    assert_eq!(
        content(invoke_within(&archive, json!({"reference": "tool-1"}), 10).await),
        [
            text(&"a".repeat(30)),
            text(&format!("{}\n\n[truncated]", "b".repeat(10)))
        ]
    );
}

#[tokio::test]
async fn returns_media_as_media_and_cuts_only_the_text_to_the_result_budget() {
    let archive = archive();
    store(
        &archive,
        "tool-1",
        0,
        &json!({"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}}),
    )
    .await;
    store(&archive, "tool-1", 1, &json!({"text": "x".repeat(100)})).await;
    let result = content(invoke_within(&archive, json!({"reference": "tool-1"}), 10).await);
    assert!(matches!(result[0], ToolResultContent::Image(_)));
    assert_eq!(result[1], text(&format!("{}\n\n[truncated]", "x".repeat(40))));
}

#[tokio::test]
async fn searches_across_the_items_text() {
    let result = invoke(
        &archive_with_items().await,
        json!({"reference": "tool-1", "pattern": "ERROR"}),
    )
    .await;
    let result = result.as_str().unwrap();
    assert!(result.contains("third ERROR"));
    assert!(!result.contains("another tool"));
}

#[tokio::test]
async fn returns_the_single_item_itself_when_the_result_holds_one() {
    let archive = archive();
    store(&archive, "tool-1", 0, &json!({"text": "only"})).await;
    assert_eq!(
        invoke(&archive, json!({"reference": "tool-1"})).await,
        json!({"text": "only"})
    );
}

#[tokio::test]
async fn resolves_an_id_before_an_exact_key_whose_stem_is_another_id() {
    let archive = archive();
    store(&archive, "tool", 0, &json!({"text": "tool item 0"})).await;
    store(&archive, "tool", 1, &json!({"text": "tool item 1"})).await;
    store(&archive, "tool_1", 0, &json!({"text": "tool_1 item 0"})).await;
    store(&archive, "tool_1", 1, &json!({"text": "tool_1 item 1"})).await;
    assert_eq!(
        content(invoke(&archive, json!({"reference": "tool_1"})).await),
        [text("tool_1 item 0"), text("tool_1 item 1")]
    );
    assert_eq!(
        content(invoke(&archive, json!({"reference": "tool_1_1"})).await),
        [text("tool_1 item 1")]
    );
}

#[tokio::test]
async fn refuses_to_serve_a_stored_placeholder_as_the_original() {
    for extra in [json!({}), json!({"pattern": "row-4321"})] {
        let archive = archive();
        store(
            &archive,
            "tool-1",
            0,
            &json!({"text": "[Dropped] [ref: tool-1]", "offloaded": {"method": "drop", "ref": "tool-1"}}),
        )
        .await;
        let mut input = json!({"reference": "tool-1"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert_eq!(
            invoke_error(&archive, input).await,
            "original content for reference tool-1 is no longer available — do not retry."
        );
    }
}

#[tokio::test]
async fn matches_the_id_exactly_when_ids_contain_underscores_and_digits() {
    let archive = archive();
    store(&archive, "call", 0, &json!({"text": "bare"})).await;
    store(&archive, "call_12", 0, &json!({"text": "twelve"})).await;
    assert_eq!(
        content(invoke(&archive, json!({"reference": "call"})).await),
        [text("bare")]
    );
    assert_eq!(
        content(invoke(&archive, json!({"reference": "call_12"})).await),
        [text("twelve")]
    );
}

#[tokio::test]
async fn returns_removed_messages_as_role_markers_and_their_content_and_searches_their_text() {
    let archive = archive();
    let removed = json!([
        {"role": "user", "content": [{"text": "alpha"}], "trackingId": "r0"},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t", "name": "x", "input": {}}}], "trackingId": "r1"},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t", "status": "success", "content": [{"text": "beta ERROR"}, {"json": 1}]}}],
            "trackingId": "r2"
        }
    ]);
    store(&archive, "removed-m1", 0, &removed).await;
    assert_eq!(
        content(invoke(&archive, json!({"reference": "removed-m1"})).await),
        [
            text("\n---\n[user]"),
            text("alpha"),
            text("\n---\n[assistant]"),
            text("[tool call: x] {}"),
            text("\n---\n[user]"),
            text("[tool result: x]"),
            text("beta ERROR"),
            text("1"),
        ]
    );
    let matches = invoke(&archive, json!({"reference": "removed-m1", "pattern": "ERROR"})).await;
    let matches = matches.as_str().unwrap();
    assert!(matches.contains("[1 match for /ERROR/]"));
    assert!(matches.contains("> 2| beta ERROR"));
}

#[tokio::test]
async fn returns_media_in_removed_messages_as_media_and_cuts_only_their_text() {
    let archive = archive();
    let image = json!({"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}});
    store(
        &archive,
        "removed-m1",
        0,
        &json!([{"role": "user", "content": [image.clone(), {"text": "x".repeat(100)}]}]),
    )
    .await;
    let result = content(invoke_within(&archive, json!({"reference": "removed-m1"}), 10).await);
    assert_eq!(result[0], text("\n---\n[user]"));
    assert_eq!(serde_json::to_value(&result[1]).unwrap(), image);
    let marker_len = "\n---\n[user]".len();
    assert_eq!(
        result[2],
        text(&format!("{}\n\n[truncated]", "x".repeat(40 - marker_len)))
    );
}

#[tokio::test]
async fn restores_image_content_as_an_image_block_instead_of_raw_json() {
    let archive = archive();
    let data = json!({"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}});
    let reference = archive
        .store("tool-img", 0, &serde_json::to_vec(&data).unwrap())
        .await
        .unwrap();
    let result = content(invoke(&archive, json!({ "reference": reference })).await);
    assert!(matches!(&result[..], [ToolResultContent::Image(image)] if image.format == ImageFormat::Png));
}

#[tokio::test]
async fn retrieves_json_content_as_parsed_object() {
    let archive = archive();
    let json = json!({"key": "value", "nested": [1, 2, 3]});
    let reference = archive
        .store("tool-json", 0, &serde_json::to_vec(&json!({ "json": json })).unwrap())
        .await
        .unwrap();
    assert_eq!(
        content(invoke(&archive, json!({ "reference": reference })).await),
        [ToolResultContent::Json(JsonBlock::new(json))]
    );
}

#[tokio::test]
async fn returns_error_when_searching_non_text_content() {
    let archive = archive();
    let data = json!({"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}});
    let reference = archive
        .store("tool-img", 0, &serde_json::to_vec(&data).unwrap())
        .await
        .unwrap();
    let error = invoke_error(&archive, json!({ "reference": reference, "pattern": "test" })).await;
    assert!(error.contains("cannot search non-text content"));
}

#[tokio::test]
async fn returns_other_stored_blocks_in_their_json_form_cut_to_the_budget() {
    let archive = archive();
    store(
        &archive,
        "track-1",
        0,
        &json!({"citations": {"citations": [], "content": [{"text": "x".repeat(100)}]}}),
    )
    .await;
    let input = serde_json::from_value(json!({"reference": "track-1"})).unwrap();
    let result = retrieve_context(&archive, input, 20).await.unwrap();
    let serialized =
        serde_json::to_string(&json!({"citations": {"citations": [], "content": [{"text": "x".repeat(100)}]}}))
            .unwrap();
    assert_eq!(result, json!(format!("{}\n\n[truncated]", &serialized[..20])));
}

#[tokio::test]
async fn restores_image_blocks_as_image_block_instances() {
    let archive = archive();
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
    archive.store_message(&message, None, None).await;
    let keys = archive.list("").await.unwrap();
    let result = content(invoke(&archive, json!({ "reference": keys[0] })).await);
    assert!(matches!(&result[..], [ToolResultContent::Image(image)] if image.format == ImageFormat::Png));
}

#[tokio::test]
async fn returns_text_content_normally_not_treated_as_media() {
    let archive = archive();
    archive
        .store_message(&tool_result_message("hello world", "tool-123"), None, None)
        .await;
    let keys = archive.list("").await.unwrap();
    assert_eq!(
        content(invoke(&archive, json!({ "reference": keys[0] })).await),
        [text("hello world")]
    );
}

#[tokio::test]
async fn restores_document_blocks_as_document_block_instances() {
    let archive = archive();
    let data = json!({"document": {"format": "pdf", "name": "doc", "source": {"bytes": "YmFzZTY0"}}});
    let reference = archive
        .store("tool-doc", 0, &serde_json::to_vec(&data).unwrap())
        .await
        .unwrap();
    let result = content(invoke(&archive, json!({ "reference": reference })).await);
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
    let (archive, reference) = archive_with_text("hello").await;
    let tool = RetrievalTool::new(archive, None);
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

// Regression: https://github.com/strands-agents/harness-sdk/issues/4241 — failures returned their
// text as a success result, and a model reading "Error" under success retries and then invents the
// content. Driven through the tool, which is what produces the status the model sees.
async fn stream_result(archive: Archive, input: JsonValue) -> crate::types::ToolResultBlock {
    let tool = RetrievalTool::new(archive, None);
    let context = ToolContext::new(
        crate::types::ToolUse::new(RETRIEVAL_TOOL_NAME, "tu-1", input),
        crate::test_support::tool_agent(),
        crate::agent::InvocationState::new(),
    );
    let Some(ToolOutcome::Result(result)) = outcome(tool.stream(context)).await else {
        panic!("expected a result");
    };
    result
}

fn error_text(result: &crate::types::ToolResultBlock) -> String {
    assert_eq!(result.status, crate::types::ToolResultStatus::Error);
    let ToolResultContent::Text(text) = &result.content[0] else {
        panic!("not text");
    };
    text.text.clone()
}

#[tokio::test]
async fn reports_an_unknown_reference_as_an_error() {
    let text = error_text(&stream_result(archive(), json!({"reference": "tu-old_0"})).await);
    assert!(text.contains("reference not found: tu-old_0"));
    assert!(text.contains("do not retry"));
}

#[tokio::test]
async fn reports_a_stored_placeholder_as_an_error() {
    let archive = archive();
    store(
        &archive,
        "tool-1",
        0,
        &json!({"text": "[Dropped] [ref: tool-1]", "offloaded": {"method": "drop", "ref": "tool-1"}}),
    )
    .await;
    let text = error_text(&stream_result(archive, json!({"reference": "tool-1"})).await);
    assert!(text.contains("no longer available"));
}

#[tokio::test]
async fn reports_an_unsearchable_entry_as_an_error() {
    let archive = archive();
    store(
        &archive,
        "tool-img",
        0,
        &json!({"image": {"format": "png", "source": {"bytes": "iVBO"}}}),
    )
    .await;
    let input = json!({"reference": "tool-img_0", "pattern": "test"});
    let text = error_text(&stream_result(archive, input).await);
    assert!(text.contains("cannot search non-text content"));
}

#[tokio::test]
async fn reports_an_out_of_range_line_range_as_an_error() {
    let (archive, reference) = archive_with_text("only one line").await;
    let input = json!({"reference": reference, "line_range": {"start": 9, "end": 2}});
    let text = error_text(&stream_result(archive, input).await);
    assert!(text.contains("must be <= line_range.end"));
}
