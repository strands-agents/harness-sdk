//! `McpTool` calls. Results a real server can send run end to end; shapes no conforming server
//! sends go through the result translation directly.

use serde_json::json;

use super::*;
use crate::agent::{InvocationState, ToolAgent};
use crate::error::Error;
use crate::mcp::{McpError, McpToolConfig, tool_result};
use crate::testing::MockModel;
use crate::tools::{ToolContext, ToolOutcome};
use crate::types::{ImageFormat, ImageSource, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUse};

fn context(name: &str, input: JsonValue, signal: Option<CancelSignal>) -> ToolContext {
    let agent = ToolAgent::new("agent", "session", Arc::new(MockModel::new()));
    let context = ToolContext::new(ToolUse::new(name, "id-123", input), agent, InvocationState::new());
    match signal {
        Some(signal) => context.with_cancel_signal(signal),
        None => context,
    }
}

async fn run(tool: &McpTool, input: JsonValue) -> ToolResultBlock {
    run_with(tool, context(tool.name(), input, None)).await
}

async fn run_with(tool: &McpTool, context: ToolContext) -> ToolResultBlock {
    match tool.stream(context).run(|_| {}).await {
        Some(ToolOutcome::Result(result)) => result,
        other => panic!("unexpected outcome {other:?}"),
    }
}

async fn content_result(kind: &str) -> ToolResultBlock {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "content").await;
    run(&tool, json!({"kind": kind})).await
}

fn translated(raw: JsonValue) -> ToolResultBlock {
    tool_result("id-123".to_owned(), Ok(raw))
}

fn failed(error: McpError) -> ToolResultBlock {
    tool_result("id-123".to_owned(), Err(Error::Mcp(error)))
}

fn text(result: &ToolResultBlock, index: usize) -> &str {
    match &result.content[index] {
        ToolResultContent::Text(block) => &block.text,
        other => panic!("not text: {other:?}"),
    }
}

fn is_json(result: &ToolResultBlock, index: usize) -> bool {
    matches!(result.content[index], ToolResultContent::Json(_))
}

fn image_format(result: &ToolResultBlock, index: usize) -> ImageFormat {
    match &result.content[index] {
        ToolResultContent::Image(image) => {
            assert!(matches!(image.source, ImageSource::Bytes(_)));
            image.format
        }
        other => panic!("not an image: {other:?}"),
    }
}

#[tokio::test]
async fn exposes_the_original_client_without_allowing_reassignment() {
    let client = client(TestServer::new());
    let tool = McpTool::new(McpToolConfig {
        name: "weather".to_owned(),
        description: "Get weather".to_owned(),
        input_schema: json!({}),
        output_schema: None,
        annotations: None,
        client: client.clone(),
    });
    assert_eq!(tool.mcp_client().client_name(), client.client_name());
    assert_eq!(tool.server_tool_name(), "weather");
}

#[tokio::test]
async fn forwards_the_tool_execution_cancel_signal_to_call_tool() {
    let server = TestServer::new();
    let client = client(server.clone());
    let tool = tool_named(&client, "wait").await;
    let handle = CancelHandle::new();
    let pending = {
        let context = context("wait", json!({}), Some(handle.signal()));
        tokio::spawn(async move { run_with(&tool, context).await })
    };
    while server.calls().is_empty() {
        tokio::task::yield_now().await;
    }
    cancel(&handle, "The operation was aborted");
    let result = pending.await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(text(&result, 0), "Error: The operation was aborted");
}

#[tokio::test]
async fn returns_text_results_on_success() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "echo").await;
    let result = run(&tool, json!({"value": "Sunny"})).await;
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(text(&result, 0), "Sunny");
}

#[test]
fn returns_structured_data_results_on_success() {
    let result = translated(json!({"content": [{"type": "data", "value": {"temperature": 72}}]}));
    assert_eq!(
        result.content,
        [ToolResultContent::json(
            json!({"type": "data", "value": {"temperature": 72}})
        )]
    );
}

#[tokio::test]
async fn returns_the_text_of_a_structured_content_result() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "structured").await;
    let result = run(&tool, json!({})).await;
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(text(&result, 0), "{\"temperature\":72}");
}

#[tokio::test]
async fn provides_default_message_for_empty_output() {
    let result = content_result("empty").await;
    assert_eq!(
        text(&result, 0),
        "Tool execution completed successfully with no output."
    );
}

#[tokio::test]
async fn handles_protocol_level_errors() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "fail").await;
    let result = run(&tool, json!({})).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(text(&result, 0), "Service Unavailable");
}

#[tokio::test]
async fn catches_and_wraps_client_exceptions() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "protocol_error").await;
    let result = run(&tool, json!({"message": "Network Error"})).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(text(&result, 0), "Error: Network Error");
}

#[test]
fn validates_sdk_response_format() {
    let result = translated(json!({"content": null}));
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result, 0).contains("missing content array"));
}

#[tokio::test]
async fn maps_mcp_image_content_to_image_block() {
    let result = content_result("image").await;
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(result.content.len(), 1);
    assert_eq!(image_format(&result, 0), ImageFormat::Png);
}

#[tokio::test]
async fn falls_back_to_json_block_for_unsupported_image_mime_type() {
    let (logs, _guard) = crate::test_support::record_logs();
    let result = content_result("bad_image").await;
    assert!(is_json(&result, 0));
    assert!(
        logs.text()
            .contains("mime_type=<image/bmp> | unsupported mcp image mime type, falling back to json"),
        "{}",
        logs.text()
    );
}

#[test]
fn falls_back_to_json_block_for_image_content_missing_data() {
    let (result, logs) = crate::test_support::capture_logs(|| {
        translated(json!({"content": [{"type": "image", "mimeType": "image/png"}]}))
    });
    assert!(is_json(&result, 0));
    assert!(logs.contains("content_type=<image> | mcp image content missing data or mimeType, falling back to json"));
}

#[tokio::test]
async fn maps_mcp_text_resource_to_text_block() {
    let result = content_result("resource_text").await;
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(text(&result, 0), "Some notes");
}

#[tokio::test]
async fn maps_mcp_blob_resource_with_image_mime_type_to_image_block() {
    let result = content_result("resource_image").await;
    assert_eq!(image_format(&result, 0), ImageFormat::Png);
    let jpeg = translated(
        json!({"content": [{"type": "resource", "resource": {"uri": "file:///img.png", "blob": PNG_BASE64, "mimeType": "image/jpeg"}}]}),
    );
    assert_eq!(image_format(&jpeg, 0), ImageFormat::Jpeg);
}

#[tokio::test]
async fn falls_back_to_json_block_for_blob_resource_with_non_image_mime_type() {
    let (logs, _guard) = crate::test_support::record_logs();
    let result = content_result("resource_pdf").await;
    assert!(is_json(&result, 0));
    assert!(
        logs.text()
            .contains("mime_type=<application/pdf> | unsupported mcp resource blob mime type, falling back to json")
    );
}

#[test]
fn falls_back_to_json_block_for_resource_with_neither_text_nor_blob() {
    let result = translated(json!({"content": [{"type": "resource", "resource": {"uri": "file:///unknown"}}]}));
    assert!(is_json(&result, 0));
}

#[tokio::test]
async fn falls_back_to_json_block_for_audio_and_resource_links() {
    assert!(is_json(&content_result("audio").await, 0));
    assert!(is_json(&content_result("resource_link").await, 0));
}

#[test]
fn falls_back_to_json_block_for_items_that_are_not_objects_or_lack_text() {
    let result = translated(json!({"content": ["plain", {"type": "text", "text": 5}]}));
    assert_eq!(
        result.content,
        [
            ToolResultContent::json(json!("plain")),
            ToolResultContent::json(json!({"type": "text", "text": 5}))
        ]
    );
}

#[tokio::test]
async fn handles_mixed_content_types_in_a_single_result() {
    let result = content_result("mixed").await;
    assert_eq!(result.content.len(), 3);
    assert_eq!(text(&result, 0), "Here is the image:");
    assert_eq!(image_format(&result, 1), ImageFormat::Png);
    assert_eq!(text(&result, 2), "Some notes");
}

fn elicitations() -> JsonValue {
    json!([{
        "mode": "url",
        "message": "Please authorize with GitHub",
        "elicitationId": "e-123",
        "url": "https://github.com/login/oauth/authorize?client_id=abc"
    }])
}

#[tokio::test]
async fn surfaces_elicitation_data_for_protocol_error_with_code_32042() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "protocol_error").await;
    let args = json!({"code": -32042, "message": "Authorization required", "data": {"elicitations": elicitations()}});
    let result = run(&tool, args).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(
        text(&result, 0),
        format!(
            "MCP Elicitation required: [ProtocolError: Authorization required] with data {}",
            elicitations()
        )
    );
}

#[test]
fn surfaces_multiple_elicitations_for_protocol_error_with_code_32042() {
    let many = json!([
        {"mode": "url", "message": "Authorize with GitHub", "elicitationId": "e-1", "url": "https://github.com/login/oauth/authorize"},
        {"mode": "url", "message": "Authorize with Google", "elicitationId": "e-2", "url": "https://accounts.google.com/o/oauth2/auth"}
    ]);
    let result = failed(McpError::protocol(
        -32042,
        "Authorization required",
        Some(json!({"elicitations": many})),
    ));
    assert_eq!(
        text(&result, 0),
        format!("MCP Elicitation required: [ProtocolError: Authorization required] with data {many}")
    );
}

#[test]
fn surfaces_elicitation_data_for_url_elicitation_required_error() {
    let data = json!({"elicitations": [{"mode": "url", "message": "Please authorize", "elicitationId": "e-1", "url": "https://example.com/auth"}]});
    let result = failed(McpError::protocol(-32042, "Auth required", Some(data)));
    assert!(text(&result, 0).contains("MCP Elicitation required"));
    assert!(text(&result, 0).contains("https://example.com/auth"));
}

fn falls_through(data: Option<JsonValue>, code: i32) {
    let result = failed(McpError::protocol(code, "Auth required", data));
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(text(&result, 0), "Error: Auth required");
}

#[test]
fn falls_through_to_generic_error_for_protocol_error_32042_with_malformed_data() {
    falls_through(Some(json!({"unexpected": "shape"})), -32042);
}

#[test]
fn falls_through_to_generic_error_for_protocol_error_32042_with_undefined_data() {
    falls_through(None, -32042);
}

#[test]
fn falls_through_to_generic_error_for_protocol_error_32042_with_non_array_elicitations() {
    falls_through(Some(json!({"elicitations": "not-an-array"})), -32042);
}

#[test]
fn falls_through_to_generic_error_for_protocol_error_32042_with_empty_elicitations() {
    falls_through(Some(json!({"elicitations": []})), -32042);
}

#[test]
fn falls_through_to_generic_error_for_protocol_error_with_a_different_code() {
    falls_through(Some(json!({"elicitations": elicitations()})), -32600);
}
