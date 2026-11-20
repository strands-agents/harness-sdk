//! Output-schema validation of `tools/call` results against the schemas of the last `tools/list`.

use rmcp::model::Tool as ServerTool;
use serde_json::json;

use super::*;
use crate::error::Error;
use crate::mcp::{McpCallToolOptions, McpError};

fn with_output_schema(name: &str, schema: JsonValue) -> ServerTool {
    let JsonValue::Object(schema) = schema else {
        panic!("schema must be an object");
    };
    ServerTool::new_with_raw(name.to_owned(), None, Arc::new(serde_json::Map::new()))
        .with_raw_output_schema(Arc::new(schema))
}

fn temperature_schema(kind: &str) -> JsonValue {
    json!({
        "type": "object",
        "properties": {"temperature": {"type": kind}},
        "required": ["temperature"]
    })
}

async fn call(server: TestServer, name: &str) -> (Result<JsonValue, Error>, TestServer) {
    let client = client(server.clone());
    let tool = tool_named(&client, name).await;
    let result = client.call_tool(&tool, json!({}), McpCallToolOptions::default()).await;
    (result, server)
}

fn protocol_error(result: Result<JsonValue, Error>) -> (i32, String) {
    match result {
        Err(Error::Mcp(McpError::Protocol { code, message, .. })) => (code, message),
        other => panic!("expected a protocol error, got {other:?}"),
    }
}

#[tokio::test]
async fn accepts_structured_content_that_matches_the_output_schema() {
    let server = TestServer::with_tools(vec![with_output_schema("structured", temperature_schema("number"))]);
    let (result, _) = call(server, "structured").await;
    assert_eq!(result.unwrap()["structuredContent"], json!({"temperature": 72}));
}

#[tokio::test]
async fn rejects_structured_content_that_does_not_match_the_output_schema() {
    let server = TestServer::with_tools(vec![with_output_schema("structured", temperature_schema("string"))]);
    let (code, message) = protocol_error(call(server, "structured").await.0);
    assert_eq!(code, -32602);
    assert!(
        message.starts_with("Structured content does not match the tool's output schema: /temperature: "),
        "{message}"
    );
}

#[tokio::test]
async fn rejects_a_result_without_structured_content_when_the_tool_has_an_output_schema() {
    let server = TestServer::with_tools(vec![with_output_schema("echo", temperature_schema("number"))]);
    let (code, message) = protocol_error(call(server, "echo").await.0);
    assert_eq!(code, -32600);
    assert_eq!(
        message,
        "Tool echo has an output schema but did not return structured content"
    );
}

#[tokio::test]
async fn skips_output_validation_for_an_error_result() {
    let server = TestServer::with_tools(vec![with_output_schema("fail", temperature_schema("number"))]);
    let (result, _) = call(server, "fail").await;
    assert_eq!(result.unwrap()["isError"], json!(true));
}

#[tokio::test]
async fn rejects_a_call_to_a_tool_with_an_invalid_output_schema_before_sending_it() {
    let server = TestServer::with_tools(vec![with_output_schema("args", json!({"type": 12}))]);
    let (result, server) = call(server, "args").await;
    let (code, message) = protocol_error(result);
    assert_eq!(code, -32602);
    assert!(
        message.starts_with("Tool 'args' has an invalid outputSchema: "),
        "{message}"
    );
    assert!(server.calls().is_empty());
}

#[tokio::test]
async fn validates_a_prefixed_tool_under_its_server_side_name() {
    let server = TestServer::with_tools(vec![with_output_schema("echo", temperature_schema("number"))]);
    let client = client_with(
        server,
        McpClientOptions {
            prefix: Some("srv".to_owned()),
            ..McpClientOptions::default()
        },
    );
    let tool = tool_named(&client, "srv_echo").await;
    let result = client.call_tool(&tool, json!({}), McpCallToolOptions::default()).await;
    assert_eq!(
        protocol_error(result).1,
        "Tool echo has an output schema but did not return structured content"
    );
}
