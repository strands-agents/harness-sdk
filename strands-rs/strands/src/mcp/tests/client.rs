//! Connection, trace context, arguments, metadata, `continue_on_error` and transport resolution.

use std::sync::atomic::Ordering;

use serde_json::json;

use super::*;
use crate::mcp::{McpCallToolOptions, McpClientCredentials, McpConnectionState, McpToolConfig};
use crate::test_support::record_logs;
use crate::types::JsonObject;

const TRACEPARENT: &str = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";

fn fixed_traceparent() -> Result<Option<JsonObject>, String> {
    Ok(Some(
        json!({"traceparent": TRACEPARENT})
            .as_object()
            .cloned()
            .unwrap_or_default(),
    ))
}

fn no_span() -> Result<Option<JsonObject>, String> {
    Ok(None)
}

fn failing_propagation() -> Result<Option<JsonObject>, String> {
    Err("propagation failed".to_owned())
}

fn traced_client(server: TestServer, carrier: super::super::trace::TraceCarrierFn, disable: bool) -> McpClient {
    let (transport, _) = duplex_transport(server);
    McpClient::with_trace_carrier(
        McpClientConfig {
            transport: Some(transport),
            options: McpClientOptions {
                disable_mcp_instrumentation: disable,
                ..McpClientOptions::default()
            },
            ..McpClientConfig::default()
        },
        carrier,
    )
    .unwrap()
}

async fn call_args(client: &McpClient, args: JsonValue) -> JsonValue {
    let tool = tool_named(client, "args").await;
    let result = client
        .call_tool(&tool, args, McpCallToolOptions::default())
        .await
        .unwrap();
    serde_json::from_str(&first_text(&result)).unwrap()
}

#[tokio::test]
async fn initializes_sdk_client_with_correct_configuration() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "client_info").await;
    let result = client
        .call_tool(&tool, empty_args(), McpCallToolOptions::default())
        .await
        .unwrap();
    let info: JsonValue = serde_json::from_str(&first_text(&result)).unwrap();
    assert_eq!(client.client_name(), "TestApp");
    assert_eq!(info["clientInfo"]["name"], "TestApp");
    assert_eq!(info["clientInfo"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["protocolVersion"], "2025-11-25");
    assert_eq!(info["capabilities"], json!({}));
}

#[tokio::test]
async fn uses_the_rust_sdk_name_by_default() {
    let client = client_with(TestServer::new(), McpClientOptions::default());
    assert_eq!(client.client_name(), "strands-agents-rs-sdk");
}

#[tokio::test]
async fn injects_trace_context_into_tool_arguments_when_active_span_exists() {
    let client = traced_client(TestServer::new(), fixed_traceparent, false);
    let args = call_args(&client, json!({"op": "add"})).await;
    assert_eq!(args, json!({"op": "add", "_meta": {"traceparent": TRACEPARENT}}));
}

#[tokio::test]
async fn merges_trace_context_with_existing_meta_field() {
    let client = traced_client(TestServer::new(), fixed_traceparent, false);
    let args = call_args(&client, json!({"_meta": {"custom": "value"}, "op": "add"})).await;
    assert_eq!(
        args,
        json!({"_meta": {"custom": "value", "traceparent": TRACEPARENT}, "op": "add"})
    );
}

#[tokio::test]
async fn passes_args_unchanged_when_no_active_span_exists() {
    let client = traced_client(TestServer::new(), super::super::trace::current_trace_carrier, false);
    assert_eq!(call_args(&client, json!({"op": "add"})).await, json!({"op": "add"}));
}

#[tokio::test]
async fn passes_args_unchanged_when_span_has_empty_trace_id() {
    let client = traced_client(TestServer::new(), no_span, false);
    assert_eq!(call_args(&client, json!({"op": "add"})).await, json!({"op": "add"}));
}

#[tokio::test]
async fn passes_args_unchanged_when_context_injection_fails() {
    let (logs, _guard) = record_logs();
    let client = traced_client(TestServer::new(), failing_propagation, false);
    assert_eq!(call_args(&client, json!({"op": "add"})).await, json!({"op": "add"}));
    assert!(
        logs.text()
            .contains("error=<propagation failed> | failed to inject trace context into mcp tool call args"),
        "{}",
        logs.text()
    );
}

#[tokio::test]
async fn skips_trace_context_injection_when_disable_mcp_instrumentation_is_true() {
    let client = traced_client(TestServer::new(), fixed_traceparent, true);
    assert_eq!(call_args(&client, json!({"op": "add"})).await, json!({"op": "add"}));
}

#[tokio::test]
async fn manages_connection_state_lazily() {
    let (transport, starts) = duplex_transport(TestServer::new());
    let client = McpClient::with_transport(transport);
    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
    client.connect(false).await.unwrap();
    client.connect(false).await.unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
}

#[tokio::test]
async fn supports_forced_reconnection() {
    let (transport, starts) = duplex_transport(TestServer::new());
    let client = McpClient::with_transport(transport);
    client.connect(false).await.unwrap();
    client.connect(true).await.unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
}

#[tokio::test]
async fn stops_a_caller_waiting_on_a_shared_connection_when_its_signal_aborts() {
    let (transport, gate, starts) = gated_transport(TestServer::new(), vec![]);
    let client = McpClient::with_transport(transport);
    let handle = CancelHandle::new();
    let signal = handle.signal();

    let first = tokio::spawn({
        let client = client.clone();
        async move { client.connect(false).await }
    });
    tokio::task::yield_now().await;
    let second = {
        let client = client.clone();
        tokio::spawn(async move { client.connect_with(false, Some(&signal)).await })
    };
    tokio::task::yield_now().await;
    cancel(&handle, "caller left");
    assert_eq!(second.await.unwrap().unwrap_err().to_string(), "caller left");

    gate.add_permits(1);
    first.await.unwrap().unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

async fn keeps_the_connection_shared_after_its_creator_aborts(continue_on_error: bool) {
    let (transport, gate, starts) = gated_transport(TestServer::new(), vec![]);
    let client = McpClient::new(McpClientConfig {
        transport: Some(transport),
        options: McpClientOptions {
            continue_on_error,
            ..McpClientOptions::default()
        },
        ..McpClientConfig::default()
    })
    .unwrap();
    let handle = CancelHandle::new();
    let signal = handle.signal();

    let creator = {
        let client = client.clone();
        tokio::spawn(async move { client.connect_with(false, Some(&signal)).await })
    };
    tokio::task::yield_now().await;
    cancel(&handle, "creator left");
    assert_eq!(creator.await.unwrap().unwrap_err().to_string(), "creator left");
    let follower = {
        let client = client.clone();
        tokio::spawn(async move { client.connect(false).await })
    };
    tokio::task::yield_now().await;
    assert_eq!(starts.load(Ordering::SeqCst), 1);

    gate.add_permits(1);
    follower.await.unwrap().unwrap();
    client.connect(false).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn keeps_the_connection_shared_after_its_creator_aborts_continue_on_error_false() {
    keeps_the_connection_shared_after_its_creator_aborts(false).await;
}

#[tokio::test]
async fn keeps_the_connection_shared_after_its_creator_aborts_continue_on_error_true() {
    keeps_the_connection_shared_after_its_creator_aborts(true).await;
}

#[tokio::test]
async fn releases_a_rejected_connection_after_its_creator_aborts_so_an_explicit_retry_can_run() {
    let (transport, gate, starts) = gated_transport(TestServer::new(), vec![false, true]);
    let client = McpClient::with_transport(transport);
    let handle = CancelHandle::new();
    let signal = handle.signal();
    let creator = {
        let client = client.clone();
        tokio::spawn(async move { client.connect_with(false, Some(&signal)).await })
    };
    tokio::task::yield_now().await;
    cancel(&handle, "creator left");
    assert_eq!(creator.await.unwrap().unwrap_err().to_string(), "creator left");

    let follower = {
        let client = client.clone();
        tokio::spawn(async move { client.connect(false).await })
    };
    tokio::task::yield_now().await;
    gate.add_permits(1);
    assert_eq!(follower.await.unwrap().unwrap_err().to_string(), "handshake failed");
    assert_eq!(starts.load(Ordering::SeqCst), 1);

    gate.add_permits(1);
    client.connect(true).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
    assert_eq!(starts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn rejects_immediately_when_connect_is_called_with_an_aborted_signal() {
    let (transport, starts) = duplex_transport(TestServer::new());
    let client = McpClient::with_transport(transport);
    let (_handle, signal) = cancelled("already cancelled");
    let error = client.connect_with(false, Some(&signal)).await.unwrap_err();
    assert_eq!(error.to_string(), "already cancelled");
    assert_eq!(starts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stops_waiting_for_the_connection_when_call_tool_is_aborted_without_tasks_config() {
    let server = TestServer::new();
    let (transport, _gate, _) = gated_transport(server.clone(), vec![]);
    let client = McpClient::with_transport(transport);
    let tool = McpTool::new(McpToolConfig {
        name: "calc".to_owned(),
        description: String::new(),
        input_schema: json!({}),
        output_schema: None,
        annotations: None,
        client: client.clone(),
    });
    let handle = CancelHandle::new();
    let options = McpCallToolOptions {
        cancel_signal: Some(handle.signal()),
        ..McpCallToolOptions::default()
    };
    let pending = {
        let client = client.clone();
        tokio::spawn(async move { client.call_tool(&tool, json!({}), options).await })
    };
    tokio::task::yield_now().await;
    cancel(&handle, "caller aborted during connect");
    assert_eq!(
        pending.await.unwrap().unwrap_err().to_string(),
        "caller aborted during connect"
    );
    assert!(server.calls().is_empty());
}

#[tokio::test]
async fn validates_tool_arguments() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "echo").await;
    let error = client
        .call_tool(&tool, json!([]), McpCallToolOptions::default())
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "MCP Protocol Error: Tool arguments must be a JSON Object (named parameters). Received: Array"
    );
    let error = client
        .call_tool(&tool, json!("text"), McpCallToolOptions::default())
        .await
        .unwrap_err();
    assert!(error.to_string().ends_with("Received: string"), "{error}");
}

#[tokio::test]
async fn treats_null_arguments_as_an_empty_object() {
    let client = traced_client(TestServer::new(), no_span, false);
    assert_eq!(call_args(&client, JsonValue::Null).await, json!({}));
}

#[tokio::test]
async fn rejects_an_invalid_call_timeout() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "echo").await;
    let options = McpCallToolOptions {
        timeout: Some(std::time::Duration::ZERO),
        ..McpCallToolOptions::default()
    };
    let error = client.call_tool(&tool, json!({}), options).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "MCP call timeout must be a positive safe integer no greater than 2147483647"
    );
}

#[tokio::test]
async fn cleans_up_resources() {
    let client = client(TestServer::new());
    client.connect(false).await.unwrap();
    client.disconnect().await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
    assert!(client.client().is_none());
    client.list_tools().await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
}

#[tokio::test]
async fn ends_the_transport_when_the_last_clone_drops() {
    let (client_end, server_end) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(async move {
        let running = rmcp::ServiceExt::serve(TestServer::new(), server_end).await.unwrap();
        running.waiting().await.unwrap()
    });
    let client = McpClient::with_transport(McpTransport::new(client_end));
    client.connect(false).await.unwrap();
    let clone = client.clone();
    drop(client);
    assert!(!server.is_finished());
    drop(clone);
    tokio::time::timeout(std::time::Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn fails_to_reconnect_a_transport_that_starts_once() {
    let client = McpClient::with_transport(McpTransport::new(serve_duplex(TestServer::new())));
    client.connect(false).await.unwrap();
    let error = client.connect(true).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "MCP transport already started and cannot start again; construct a new McpClient or use McpTransport::from_fn"
    );
}

#[tokio::test]
async fn fails_pending_connects_after_disconnect() {
    let (transport, gate, _) = gated_transport(TestServer::new(), vec![]);
    let client = McpClient::with_transport(transport);
    let pending = {
        let client = client.clone();
        tokio::spawn(async move { client.connect(false).await })
    };
    tokio::task::yield_now().await;
    client.disconnect().await.unwrap();
    gate.add_permits(1);
    assert_eq!(
        pending.await.unwrap().unwrap_err().to_string(),
        "MCP client disconnected"
    );
    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
}

// describe('server metadata getters')

#[tokio::test]
async fn returns_undefined_for_all_getters_before_connect() {
    let client = client(TestServer::new());
    assert!(client.server_capabilities().is_none());
    assert!(client.server_version().is_none());
    assert!(client.server_instructions().is_none());
}

#[tokio::test]
async fn returns_server_capabilities_after_connect() {
    let client = client(TestServer::new());
    client.connect(false).await.unwrap();
    let capabilities = client.server_capabilities().unwrap();
    assert!(capabilities.tools.is_some());
    assert!(capabilities.prompts.is_some());
}

#[tokio::test]
async fn returns_server_version_after_connect() {
    let client = client(TestServer::new());
    client.connect(false).await.unwrap();
    let version = client.server_version().unwrap();
    assert_eq!(
        (version.name.as_str(), version.version.as_str()),
        ("test-server", "1.0.0")
    );
}

#[tokio::test]
async fn returns_server_instructions_after_connect() {
    let client = client(TestServer::new());
    client.connect(false).await.unwrap();
    assert_eq!(client.server_instructions().as_deref(), Some("Use the echo tool"));
}

#[tokio::test]
async fn connection_state_is_disconnected_before_connect() {
    assert_eq!(
        client(TestServer::new()).connection_state(),
        McpConnectionState::Disconnected
    );
}

#[tokio::test]
async fn connection_state_is_connected_after_successful_connect() {
    let client = client(TestServer::new());
    client.connect(false).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
}

// describe('continueOnError')

fn lenient(transport: McpTransport) -> McpClient {
    McpClient::new(McpClientConfig {
        transport: Some(transport),
        options: McpClientOptions {
            continue_on_error: true,
            ..McpClientOptions::default()
        },
        ..McpClientConfig::default()
    })
    .unwrap()
}

#[tokio::test]
async fn throws_on_connection_failure_by_default() {
    let (transport, _) = failing_transport();
    let client = McpClient::with_transport(transport);
    assert_eq!(
        client.connect(false).await.unwrap_err().to_string(),
        "connection refused"
    );
    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
}

#[tokio::test]
async fn swallows_connection_failure_when_continue_on_error_is_true() {
    let (transport, _) = failing_transport();
    let client = lenient(transport);
    client.connect(false).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Failed);
}

#[tokio::test]
async fn logs_a_warning_when_continue_on_error_swallows_a_connection_failure() {
    let (logs, _guard) = record_logs();
    let (transport, _) = failing_transport();
    lenient(transport).connect(false).await.unwrap();
    assert!(
        logs.text().contains(
            "client=<strands-agents-rs-sdk>, error=<connection refused> | MCP server failed to connect, continuing (continueOnError)"
        ),
        "{}",
        logs.text()
    );
}

#[tokio::test]
async fn list_tools_returns_empty_array_when_continue_on_error_and_connection_failed() {
    let (transport, _) = failing_transport();
    assert!(lenient(transport).list_tools().await.unwrap().is_empty());
}

#[tokio::test]
async fn call_tool_throws_when_continue_on_error_and_connection_failed() {
    let (transport, _) = failing_transport();
    let client = lenient(transport);
    let tool = McpTool::new(McpToolConfig {
        name: "echo".to_owned(),
        description: "Echo".to_owned(),
        input_schema: json!({}),
        output_schema: None,
        annotations: None,
        client: client.clone(),
    });
    let error = client
        .call_tool(&tool, json!({}), McpCallToolOptions::default())
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "MCP server failed to connect. Call connect(true) to retry."
    );
}

#[tokio::test]
async fn does_not_retry_connection_on_subsequent_calls_after_continue_on_error_failure() {
    let (transport, starts) = failing_transport();
    let client = lenient(transport);
    client.connect(false).await.unwrap();
    client.list_tools().await.unwrap();
    client.connect(false).await.unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn recovers_after_explicit_connect_true_when_server_comes_back() {
    let (transport, gate, _) = gated_transport(TestServer::new(), vec![false, true]);
    gate.add_permits(2);
    let client = lenient(transport);
    client.connect(false).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Failed);
    client.connect(true).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
    assert_eq!(names(&client.list_tools().await.unwrap())[0], "echo");
}

// describe('connect retry transport rebuild')

async fn initializes(server: &server::HttpServer) -> usize {
    server
        .recorded
        .header("/mcp", "mcp-session-id")
        .iter()
        .filter(|session| session.is_none())
        .count()
}

#[tokio::test]
async fn retries_a_url_configured_client_on_a_fresh_transport_and_client() {
    let http = serve_http(TestServer::new(), None).await;
    let client = McpClient::new(McpClientConfig {
        url: Some(http.url("/mcp")),
        options: McpClientOptions {
            continue_on_error: true,
            ..McpClientOptions::default()
        },
        ..McpClientConfig::default()
    })
    .unwrap();
    client.connect(false).await.unwrap();
    client.connect(true).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
    assert_eq!(initializes(&http).await, 2);
}

#[tokio::test]
async fn forces_reconnection_of_a_url_configured_client_on_a_fresh_transport() {
    let http = serve_http(TestServer::new(), None).await;
    let client = McpClient::new(McpClientConfig {
        url: Some(http.url("/mcp")),
        ..McpClientConfig::default()
    })
    .unwrap();
    client.connect(false).await.unwrap();
    client.connect(true).await.unwrap();
    assert_eq!(names(&client.list_tools().await.unwrap())[0], "echo");
    assert_eq!(initializes(&http).await, 2);
}

#[tokio::test]
async fn connects_a_url_configured_client_on_a_fresh_transport_after_disconnect() {
    let http = serve_http(TestServer::new(), None).await;
    let client = McpClient::new(McpClientConfig {
        url: Some(http.url("/mcp")),
        ..McpClientConfig::default()
    })
    .unwrap();
    client.connect(false).await.unwrap();
    client.disconnect().await.unwrap();
    client.connect(false).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
    assert_eq!(initializes(&http).await, 2);
}

#[tokio::test]
async fn retries_a_caller_supplied_transport_on_the_same_client_and_transport() {
    let (transport, starts) = duplex_transport(TestServer::new());
    let client = McpClient::with_transport(transport);
    client.connect(false).await.unwrap();
    client.connect(true).await.unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
}

// describe('McpClient transport resolution')

fn config_error(config: McpClientConfig) -> String {
    McpClient::new(config).unwrap_err().to_string()
}

#[test]
fn constructs_streamable_http_client_transport_when_url_is_provided() {
    let client = McpClient::new(McpClientConfig {
        url: Some("https://example.com/mcp".to_owned()),
        ..McpClientConfig::default()
    })
    .unwrap();
    assert!(
        format!("{client:?}").contains("McpTransport(\"streamable-http\")"),
        "{client:?}"
    );
}

#[test]
fn throws_when_both_transport_and_url_are_provided() {
    let (transport, _) = failing_transport();
    assert_eq!(
        config_error(McpClientConfig {
            transport: Some(transport),
            url: Some("https://example.com/mcp".to_owned()),
            ..McpClientConfig::default()
        }),
        "McpClientConfig: provide either \"transport\" or \"url\", not both"
    );
}

#[test]
fn throws_when_neither_transport_nor_url_is_provided() {
    assert_eq!(
        config_error(McpClientConfig::default()),
        "McpClientConfig: either \"transport\" or \"url\" must be provided"
    );
}

const REQUIRES_URL: &str =
    "McpClientConfig: \"auth\", \"authProvider\", and \"headers\" require \"url\" (not compatible with \"transport\")";

#[test]
fn throws_when_auth_is_provided_with_transport() {
    let (transport, _) = failing_transport();
    assert_eq!(
        config_error(McpClientConfig {
            transport: Some(transport),
            auth: Some(
                McpClientCredentials::builder()
                    .client_id("id")
                    .client_secret("secret")
                    .build()
            ),
            ..McpClientConfig::default()
        }),
        REQUIRES_URL
    );
}

#[test]
fn throws_when_headers_is_provided_with_transport() {
    let (transport, _) = failing_transport();
    assert_eq!(
        config_error(McpClientConfig {
            transport: Some(transport),
            headers: Some([("X-Api-Key".to_owned(), "secret".to_owned())].into()),
            ..McpClientConfig::default()
        }),
        REQUIRES_URL
    );
}

#[test]
fn throws_when_both_auth_and_auth_provider_are_provided() {
    assert_eq!(
        config_error(McpClientConfig {
            url: Some("https://example.com/mcp".to_owned()),
            auth: Some(
                McpClientCredentials::builder()
                    .client_id("id")
                    .client_secret("secret")
                    .build()
            ),
            auth_provider: Some(Arc::new(transports::StaticToken("token".to_owned()))),
            ..McpClientConfig::default()
        }),
        "McpClientConfig: provide either \"auth\" or \"authProvider\", not both"
    );
}

#[test]
fn throws_on_an_invalid_url() {
    let error = config_error(McpClientConfig {
        url: Some("not a url".to_owned()),
        ..McpClientConfig::default()
    });
    assert!(error.starts_with("Invalid URL \"not a url\""), "{error}");
}
