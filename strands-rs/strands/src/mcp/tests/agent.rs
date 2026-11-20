//! An agent picking up MCP tool-list changes, and the trace context an MCP tool call carries in an
//! agent run.

#[cfg(feature = "otel")]
use opentelemetry::trace::TraceContextExt as _;
use rmcp::model::Tool as ServerTool;

use super::*;
use crate::Agent;
#[cfg(feature = "otel")]
use crate::telemetry::test_support::capture_spans;
use crate::testing::MockModel;
#[cfg(feature = "otel")]
use crate::testing::MockTurn;
#[cfg(feature = "otel")]
use crate::types::{ContentBlock, ToolResultContent, ToolUseBlock};

fn tool(name: &str, description: &str) -> ServerTool {
    ServerTool::new(
        name.to_owned(),
        description.to_owned(),
        Arc::new(serde_json::Map::new()),
    )
}

fn tool_names(agent: &Agent) -> Vec<String> {
    agent.tools().iter().map(|tool| tool.name().to_owned()).collect()
}

#[tokio::test]
async fn removes_old_tools_and_adds_new_tools_when_on_tools_changed_fires() {
    let server = TestServer::with_tools(vec![tool("tool_a", "A"), tool("tool_b", "B")]);
    let client = client_with(server.clone(), McpClientOptions::default());
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("done"))
        .tools([client.clone()])
        .printer(false)
        .build()
        .unwrap();
    agent.initialize().await.unwrap();
    assert_eq!(tool_names(&agent), ["tool_a", "tool_b"]);

    server.set_tools(vec![tool("tool_b", "B-updated"), tool("tool_c", "C")]);
    client.handle_tools_changed().await;
    agent.invoke("hi").await.unwrap();

    assert_eq!(tool_names(&agent), ["tool_b", "tool_c"]);
    assert_eq!(agent.tool_registry().get("tool_b").unwrap().description(), "B-updated");
}

/// The trace context an MCP tool call carries in an agent run is the `execute_tool` span's.
#[cfg(feature = "otel")]
#[tokio::test]
async fn injects_the_tool_span_trace_context_into_mcp_tool_calls_in_an_agent_run() {
    opentelemetry::global::set_text_map_propagator(opentelemetry_sdk::propagation::TraceContextPropagator::new());
    let capture = capture_spans();
    let client = client(TestServer::new());
    let model = MockModel::new()
        .with_turn(MockTurn::content([ToolUseBlock::new(
            "args",
            "t1",
            json!({"op": "add"}),
        )]))
        .with_turn("done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([client])
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("hi").await.unwrap();

    let result = agent.messages().iter().find_map(|message| {
        message.content.iter().find_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.clone()),
            _ => None,
        })
    });
    let Some(ToolResultContent::Text(text)) = result.unwrap().content.first().cloned() else {
        panic!("expected a text result");
    };
    let args: JsonValue = serde_json::from_str(&text.text).unwrap();
    let span = capture.span("execute_tool args");
    let context = span.span_context;
    let expected = format!("00-{}-{}-01", context.trace_id(), context.span_id());
    assert_eq!(args["_meta"]["traceparent"], json!(expected));
    assert!(!opentelemetry::Context::current().span().span_context().is_valid());
}
