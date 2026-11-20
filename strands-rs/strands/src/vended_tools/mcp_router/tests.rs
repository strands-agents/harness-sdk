//! These route to local streamable HTTP servers configured by URL.

use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::agent::{InvocationState, ToolAgent};
use crate::cancel::{CancelHandle, CancelOptions};
use crate::mcp::{McpServerConfig, SerializableMcpToolFilters};
use crate::testing::MockModel;
use crate::tools::{ToolContext, ToolOutcome};
use crate::types::{ToolResultBlock, ToolUse};

use crate::mcp::tests::server;
use crate::mcp::tests::server::{HttpServer, TestServer, serve_http};

fn agent() -> ToolAgent {
    ToolAgent::new("agent", "session", Arc::new(MockModel::new()))
}

fn http_config(url: String) -> McpServerConfig {
    McpServerConfig::builder().url(url).build()
}

fn router(servers: Vec<(&str, McpServerConfig)>) -> FunctionTool {
    make_mcp_router(MakeMcpRouterOptions {
        servers: servers
            .into_iter()
            .map(|(name, config)| (name.to_owned(), config))
            .collect(),
        ..MakeMcpRouterOptions::default()
    })
    .unwrap()
}

async fn invoke_with(
    tool: &FunctionTool,
    input: JsonValue,
    agent: &ToolAgent,
    signal: Option<crate::CancelSignal>,
) -> ToolResultBlock {
    let context = ToolContext::new(
        ToolUse::new("mcp_router", "test-id", input),
        agent.clone(),
        InvocationState::new(),
    );
    let context = match signal {
        Some(signal) => context.with_cancel_signal(signal),
        None => context,
    };
    match tool.stream(context).run(|_| {}).await {
        Some(ToolOutcome::Result(result)) => result,
        other => panic!("unexpected outcome {other:?}"),
    }
}

async fn invoke(tool: &FunctionTool, input: JsonValue, agent: &ToolAgent) -> ToolResultBlock {
    invoke_with(tool, input, agent, None).await
}

fn text(result: &ToolResultBlock) -> String {
    match result.content.first() {
        Some(ToolResultContent::Text(block)) => block.text.clone(),
        other => format!("{other:?}"),
    }
}

async fn ok_text(tool: &FunctionTool, input: JsonValue, agent: &ToolAgent) -> String {
    let result = invoke(tool, input, agent).await;
    assert_eq!(result.status, ToolResultStatus::Success, "{result:?}");
    text(&result)
}

async fn error(tool: &FunctionTool, input: JsonValue, agent: &ToolAgent) -> String {
    let result = invoke(tool, input, agent).await;
    assert_eq!(result.status, ToolResultStatus::Error, "{result:?}");
    text(&result)
}

fn json_of(result: &ToolResultBlock) -> JsonValue {
    serde_json::to_value(&result.content).unwrap()
}

async fn connect(tool: &FunctionTool, agent: &ToolAgent, server: &str, id: &str) -> String {
    ok_text(
        tool,
        json!({"command": "connect", "server_name": server, "connection_id": id}),
        agent,
    )
    .await
}

async fn served() -> (HttpServer, TestServer) {
    let server = TestServer::new();
    (serve_http(server.clone(), None).await, server)
}

async fn closed_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    drop(listener);
    url
}

// describe('server validation')

#[test]
fn rejects_empty_allowlist() {
    let error = make_mcp_router(MakeMcpRouterOptions::default()).unwrap_err();
    assert!(error.to_string().contains("must not be empty"), "{error}");
}

#[test]
fn rejects_zero_max_connections() {
    let error = make_mcp_router(MakeMcpRouterOptions {
        servers: [("mcp".to_owned(), http_config("https://mcp.example.com/mcp".to_owned()))].into(),
        max_connections: Some(0),
        ..MakeMcpRouterOptions::default()
    })
    .unwrap_err();
    assert!(error.to_string().contains("maxConnections"), "{error}");
}

#[test]
fn description_includes_server_names() {
    let tool = router(vec![(
        "my-server",
        http_config("https://mcp.example.com/mcp".to_owned()),
    )]);
    assert!(tool.tool_spec().description.contains("my-server"));
}

// describe('connect')

#[tokio::test]
async fn rejects_server_not_on_allowlist() {
    let tool = router(vec![("mcp", http_config("https://mcp.example.com/mcp".to_owned()))]);
    let message = error(
        &tool,
        json!({"command": "connect", "server_name": "evil", "connection_id": "c1"}),
        &agent(),
    )
    .await;
    assert_eq!(
        message,
        "Error: Server \"evil\" is not on the MCP server allowlist: mcp"
    );
}

#[tokio::test]
async fn rejects_missing_connection_id() {
    let tool = router(vec![("mcp", http_config("https://mcp.example.com/mcp".to_owned()))]);
    let message = error(&tool, json!({"command": "connect", "server_name": "mcp"}), &agent()).await;
    assert!(message.contains("connection_id"), "{message}");
}

#[tokio::test]
async fn rejects_missing_server_name() {
    let tool = router(vec![("mcp", http_config("https://mcp.example.com/mcp".to_owned()))]);
    let message = error(&tool, json!({"command": "connect", "connection_id": "c1"}), &agent()).await;
    assert!(message.contains("server_name"), "{message}");
}

#[tokio::test]
async fn supports_multiple_simultaneous_connections() {
    let (http_a, server_a) = served().await;
    let (http_b, server_b) = served().await;
    let tool = router(vec![
        ("server-a", http_config(http_a.url("/mcp"))),
        ("server-b", http_config(http_b.url("/mcp"))),
    ]);
    let agent = agent();
    connect(&tool, &agent, "server-a", "conn-a").await;
    connect(&tool, &agent, "server-b", "conn-b").await;

    invoke(
        &tool,
        json!({"command": "list_tools", "connection_id": "conn-a"}),
        &agent,
    )
    .await;
    invoke(
        &tool,
        json!({"command": "list_tools", "connection_id": "conn-b"}),
        &agent,
    )
    .await;

    assert_eq!(server_a.lists(), 1);
    assert_eq!(server_b.lists(), 1);
}

#[tokio::test]
async fn rejects_reconnect_with_same_id() {
    let (http, _) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    let message = error(
        &tool,
        json!({"command": "connect", "server_name": "mcp", "connection_id": "c1"}),
        &agent,
    )
    .await;
    assert!(message.contains("already exists"), "{message}");
}

#[tokio::test]
async fn enforces_connection_cap() {
    let (http, _) = served().await;
    let tool = make_mcp_router(MakeMcpRouterOptions {
        servers: [("mcp".to_owned(), http_config(http.url("/mcp")))].into(),
        max_connections: Some(2),
        ..MakeMcpRouterOptions::default()
    })
    .unwrap();
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    connect(&tool, &agent, "mcp", "c2").await;
    let message = error(
        &tool,
        json!({"command": "connect", "server_name": "mcp", "connection_id": "c3"}),
        &agent,
    )
    .await;
    assert_eq!(
        message,
        "Error: Connection limit of 2 reached. Disconnect one of the active connections before opening a new one. Active connection_ids: c1, c2"
    );
}

#[tokio::test]
async fn isolates_connections_between_agents() {
    let (http, _) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let (agent_a, agent_b) = (agent(), agent());
    connect(&tool, &agent_a, "mcp", "c1").await;
    let message = error(&tool, json!({"command": "list_tools", "connection_id": "c1"}), &agent_b).await;
    assert!(message.contains("No active connection"), "{message}");
}

#[tokio::test]
async fn cleans_up_on_start_failure() {
    let tool = router(vec![("mcp", http_config(closed_url().await))]);
    let agent = agent();
    let message = error(
        &tool,
        json!({"command": "connect", "server_name": "mcp", "connection_id": "c1"}),
        &agent,
    )
    .await;
    assert!(message.starts_with("Error: "), "{message}");
    let message = error(&tool, json!({"command": "list_tools", "connection_id": "c1"}), &agent).await;
    assert!(message.contains("No active connection"), "{message}");
}

#[tokio::test]
async fn rejects_when_client_silently_enters_failed_state_continue_on_error() {
    let config = McpServerConfig::builder()
        .url(closed_url().await)
        .continue_on_error(true)
        .build();
    let tool = router(vec![("mcp", config)]);
    let message = error(
        &tool,
        json!({"command": "connect", "server_name": "mcp", "connection_id": "c1"}),
        &agent(),
    )
    .await;
    assert_eq!(
        message,
        "Error: Server \"mcp\" failed to connect; check the server config"
    );
}

#[tokio::test]
async fn throws_when_allowlisted_server_has_disabled_true() {
    let config = McpServerConfig::builder()
        .url("https://mcp.example.com/mcp")
        .disabled(true)
        .build();
    let tool = router(vec![("mcp", config)]);
    let message = error(
        &tool,
        json!({"command": "connect", "server_name": "mcp", "connection_id": "c1"}),
        &agent(),
    )
    .await;
    assert_eq!(
        message,
        "Error: Server \"mcp\" failed to initialise; check the server config"
    );
}

// describe('session lifecycle')

#[tokio::test]
async fn runs_full_connect_list_tools_call_tool_disconnect_flow() {
    let (http, server) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let agent = agent();

    assert_eq!(
        connect(&tool, &agent, "mcp", "c1").await,
        "Successfully connected to mcp as \"c1\""
    );

    let listed = invoke(&tool, json!({"command": "list_tools", "connection_id": "c1"}), &agent).await;
    let specs = &json_of(&listed)[0]["json"]["$value"];
    assert_eq!(specs[0]["name"], "echo");
    assert_eq!(specs.as_array().unwrap().len(), server::default_tools().len());

    let called = invoke(
        &tool,
        json!({"command": "call_tool", "connection_id": "c1", "tool_name": "echo", "arguments": {"value": "hello world"}}),
        &agent,
    )
    .await;
    assert_eq!(json_of(&called), json!([{"text": "hello world"}]));
    assert_eq!(server.calls(), ["echo"]);

    assert_eq!(
        ok_text(&tool, json!({"command": "disconnect", "connection_id": "c1"}), &agent).await,
        "Successfully disconnected"
    );
    let message = error(&tool, json!({"command": "list_tools", "connection_id": "c1"}), &agent).await;
    assert!(message.contains("No active connection"), "{message}");
}

#[tokio::test]
async fn rejects_call_tool_without_tool_name() {
    let (http, _) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    let message = error(&tool, json!({"command": "call_tool", "connection_id": "c1"}), &agent).await;
    assert!(message.contains("tool_name"), "{message}");
}

#[tokio::test]
async fn rejects_call_tool_for_a_tool_that_list_tools_does_not_return() {
    let (http, server) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    let message = error(
        &tool,
        json!({"command": "call_tool", "connection_id": "c1", "tool_name": "missing"}),
        &agent,
    )
    .await;
    assert!(
        message.contains("Tool \"missing\" is not available on connection \"c1\""),
        "{message}"
    );
    assert!(server.calls().is_empty());
}

#[tokio::test]
async fn lists_tools_for_call_tool_only_when_the_name_is_not_yet_listed() {
    let (http, server) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    let call = |name: &'static str| json!({"command": "call_tool", "connection_id": "c1", "tool_name": name});

    invoke(&tool, call("echo"), &agent).await;
    invoke(&tool, call("echo"), &agent).await;
    assert_eq!(server.lists(), 1);

    let mut tools = server::default_tools();
    tools.push(rmcp::model::Tool::new(
        "added",
        "Added",
        Arc::new(serde_json::Map::new()),
    ));
    server.set_tools(tools);
    invoke(&tool, call("added"), &agent).await;

    assert_eq!(server.lists(), 2);
    assert_eq!(server.calls(), ["echo", "echo", "added"]);
}

#[tokio::test]
async fn throws_mcp_router_tool_error_when_mcp_tool_returns_is_error() {
    let (http, _) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    let message = error(
        &tool,
        json!({"command": "call_tool", "connection_id": "c1", "tool_name": "fail", "arguments": {"message": "boom"}}),
        &agent,
    )
    .await;
    assert_eq!(message, "Error: boom");
}

#[tokio::test]
async fn disconnect_succeeds_even_when_client_disconnect_throws() {
    let (http, _) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    drop(http);
    assert_eq!(
        ok_text(&tool, json!({"command": "disconnect", "connection_id": "c1"}), &agent).await,
        "Successfully disconnected"
    );
    let message = error(&tool, json!({"command": "list_tools", "connection_id": "c1"}), &agent).await;
    assert!(message.contains("No active connection"), "{message}");
}

#[tokio::test]
async fn forwards_cancel_signal_to_call_tool() {
    let (http, server) = served().await;
    let tool = Arc::new(router(vec![("mcp", http_config(http.url("/mcp")))]));
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;
    let handle = CancelHandle::new();
    let pending = {
        let (tool, agent, signal) = (tool.clone(), agent.clone(), handle.signal());
        tokio::spawn(async move {
            invoke_with(
                &tool,
                json!({"command": "call_tool", "connection_id": "c1", "tool_name": "wait"}),
                &agent,
                Some(signal),
            )
            .await
        })
    };
    while server.calls().is_empty() {
        tokio::task::yield_now().await;
    }
    handle.cancel(CancelOptions {
        message: Some("stopped".to_owned()),
        ..CancelOptions::default()
    });
    let result = pending.await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(text(&result), "Error: Error: stopped");
}

// describe('config forwarding')

#[tokio::test]
async fn forwards_server_config_and_name_to_load_servers() {
    let (http, _) = served().await;
    let config = McpServerConfig::builder()
        .url(http.url("/mcp"))
        .headers([("X-Api-Key".to_owned(), "secret".to_owned())].into())
        .build();
    let tool = router(vec![("my-api", config)]);
    connect(&tool, &agent(), "my-api", "c1").await;
    let keys = http.recorded.header("/mcp", "x-api-key");
    assert!(!keys.is_empty() && keys.iter().all(|key| key.as_deref() == Some("secret")));
}

// describe('list_connections')

#[tokio::test]
async fn returns_sorted_open_connection_ids() {
    let (http_a, _) = served().await;
    let (http_b, _) = served().await;
    let tool = router(vec![
        ("server-a", http_config(http_a.url("/mcp"))),
        ("server-b", http_config(http_b.url("/mcp"))),
    ]);
    let agent = agent();
    assert_eq!(ok_text(&tool, json!({"command": "list_connections"}), &agent).await, "");
    connect(&tool, &agent, "server-b", "conn-b").await;
    connect(&tool, &agent, "server-a", "conn-a").await;
    assert_eq!(
        ok_text(&tool, json!({"command": "list_connections"}), &agent).await,
        "conn-a, conn-b"
    );
}

#[tokio::test]
async fn isolates_connection_listings_between_agents() {
    let (http, _) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let (first, other) = (agent(), agent());
    connect(&tool, &first, "mcp", "c1").await;
    assert_eq!(ok_text(&tool, json!({"command": "list_connections"}), &other).await, "");
}

// describe('tool metadata')

#[test]
fn uses_custom_name() {
    let tool = make_mcp_router(MakeMcpRouterOptions {
        name: Some("my_mcp".to_owned()),
        servers: [("mcp".to_owned(), http_config("https://mcp.example.com/mcp".to_owned()))].into(),
        ..MakeMcpRouterOptions::default()
    })
    .unwrap();
    assert_eq!(tool.name(), "my_mcp");
}

#[test]
fn exposes_expected_schema_fields() {
    let tool = router(vec![("mcp", http_config("https://mcp.example.com/mcp".to_owned()))]);
    let schema = tool.tool_spec().input_schema.unwrap();
    let properties = schema["properties"].as_object().unwrap();
    for field in ["command", "server_name", "connection_id", "tool_name", "arguments"] {
        assert!(properties.contains_key(field), "{field}: {schema}");
    }
    assert!(!properties.contains_key("tool_context"));
    assert_eq!(schema["required"], json!(["command"]));
}

#[test]
fn uses_default_description_with_mcp_router_description() {
    let tool = router(vec![
        ("b", http_config("https://b.example.com/mcp".to_owned())),
        ("a", http_config("https://a.example.com/mcp".to_owned())),
    ]);
    assert_eq!(
        tool.tool_spec().description,
        format!("{MCP_ROUTER_DESCRIPTION} Permitted server names: 'a', 'b'.")
    );
}

#[test]
fn accepts_custom_description() {
    let tool = make_mcp_router(MakeMcpRouterOptions {
        description: Some("Custom desc".to_owned()),
        servers: [("mcp".to_owned(), http_config("https://mcp.example.com/mcp".to_owned()))].into(),
        ..MakeMcpRouterOptions::default()
    })
    .unwrap();
    assert_eq!(tool.tool_spec().description, "Custom desc");
}

// describe('garbage collection cleanup')

#[tokio::test]
async fn disconnects_all_connections_when_the_callback_fires_and_swallows_errors() {
    let (http, _) = served().await;
    let tool = router(vec![("mcp", http_config(http.url("/mcp")))]);
    let gone = agent();
    connect(&tool, &gone, "mcp", "conn-a").await;
    connect(&tool, &gone, "mcp", "conn-b").await;
    let before = http.recorded.paths().len();
    drop(gone);

    ok_text(&tool, json!({"command": "list_connections"}), &agent()).await;
    let closed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while http.recorded.paths().len() < before + 2 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(closed.is_ok(), "the dropped agent's connections did not close");
}

// mcp-router.test.node.ts

async fn enforces_tool_filters_on_call_tool(filters: SerializableMcpToolFilters) {
    let server = TestServer::with_tools(vec![
        rmcp::model::Tool::new("list_items", "Lists", Arc::new(serde_json::Map::new())),
        rmcp::model::Tool::new("delete_everything", "Deletes", Arc::new(serde_json::Map::new())),
    ]);
    let http = serve_http(server.clone(), None).await;
    let config = McpServerConfig::builder()
        .url(http.url("/mcp"))
        .tool_filters(filters)
        .build();
    let tool = router(vec![("mcp", config)]);
    let agent = agent();
    connect(&tool, &agent, "mcp", "c1").await;

    let listed = invoke(&tool, json!({"command": "list_tools", "connection_id": "c1"}), &agent).await;
    let message = error(
        &tool,
        json!({"command": "call_tool", "connection_id": "c1", "tool_name": "delete_everything"}),
        &agent,
    )
    .await;
    let called = invoke(
        &tool,
        json!({"command": "call_tool", "connection_id": "c1", "tool_name": "list_items"}),
        &agent,
    )
    .await;

    let names: Vec<JsonValue> = json_of(&listed)[0]["json"]["$value"]
        .as_array()
        .unwrap()
        .iter()
        .map(|spec| spec["name"].clone())
        .collect();
    assert_eq!(names, [json!("list_items")]);
    assert!(message.contains("Tool \"delete_everything\" is not available on connection \"c1\""));
    assert_eq!(json_of(&called), json!([{"text": "called list_items"}]));
    assert_eq!(server.calls(), ["list_items"]);
}

#[tokio::test]
async fn enforces_rejected_tool_filters_from_the_server_config_on_call_tool() {
    enforces_tool_filters_on_call_tool(SerializableMcpToolFilters {
        allowed: None,
        rejected: Some(vec!["delete_everything".to_owned()]),
    })
    .await;
}

#[tokio::test]
async fn enforces_allowed_tool_filters_from_the_server_config_on_call_tool() {
    enforces_tool_filters_on_call_tool(SerializableMcpToolFilters {
        allowed: Some(vec!["list_items".to_owned()]),
        rejected: None,
    })
    .await;
}
