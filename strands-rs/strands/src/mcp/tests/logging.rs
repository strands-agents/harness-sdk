//! Server log routing.

use serde_json::json;

use super::*;
use crate::mcp::handler::default_log_handler;
use crate::mcp::{McpCallToolOptions, McpLogHandler, McpLogLevel, McpLogMessage};
use crate::test_support::capture_logs;

fn routed(level: McpLogLevel) -> String {
    let params = McpLogMessage::new(level, json!("hello"));
    let ((), logs) = capture_logs(|| default_log_handler(&params));
    logs
}

fn assert_routed(level: McpLogLevel, tracing_level: &str) {
    let logs = routed(level);
    assert!(logs.contains(tracing_level), "{logs}");
    assert!(
        logs.contains("logger=<mcp>, data=<\"hello\"> | MCP server log"),
        "{logs}"
    );
}

#[test]
fn routes_debug_level_to_logger_debug() {
    assert_routed(McpLogLevel::Debug, "DEBUG");
}

#[test]
fn routes_info_level_to_logger_info() {
    assert_routed(McpLogLevel::Info, "INFO");
}

#[test]
fn routes_notice_level_to_logger_info() {
    assert_routed(McpLogLevel::Notice, "INFO");
}

#[test]
fn routes_warning_level_to_logger_warn() {
    assert_routed(McpLogLevel::Warning, "WARN");
}

#[test]
fn routes_error_level_to_logger_error() {
    assert_routed(McpLogLevel::Error, "ERROR");
}

#[test]
fn routes_critical_level_to_logger_error() {
    assert_routed(McpLogLevel::Critical, "ERROR");
}

#[test]
fn routes_alert_level_to_logger_error() {
    assert_routed(McpLogLevel::Alert, "ERROR");
}

#[test]
fn routes_emergency_level_to_logger_error() {
    assert_routed(McpLogLevel::Emergency, "ERROR");
}

#[test]
fn includes_logger_name_and_data_in_the_message() {
    let params = McpLogMessage::new(McpLogLevel::Info, json!({"key": "val"})).with_logger("my-server");
    let ((), logs) = capture_logs(|| default_log_handler(&params));
    assert!(
        logs.contains("logger=<my-server>, data=<{\"key\":\"val\"}> | MCP server log"),
        "{logs}"
    );
}

#[tokio::test]
async fn routes_server_logs_through_tracing_by_default() {
    let (logs, _guard) = crate::test_support::record_logs();
    let client = client(TestServer::new());
    let tool = tool_named(&client, "log").await;
    client
        .call_tool(
            &tool,
            json!({"level": "warning", "data": "disk low"}),
            McpCallToolOptions::default(),
        )
        .await
        .unwrap();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(
        logs.text()
            .contains("logger=<mcp>, data=<\"disk low\"> | MCP server log"),
        "{}",
        logs.text()
    );
}

#[tokio::test]
async fn calls_custom_log_handler_when_provided() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();
    let client = client_with(
        TestServer::new(),
        McpClientOptions {
            log_handler: Some(McpLogHandler::new(move |params: &McpLogMessage| {
                sink.lock().unwrap().push(params.clone());
            })),
            ..McpClientOptions::default()
        },
    );
    let tool = tool_named(&client, "log").await;
    client
        .call_tool(
            &tool,
            json!({"level": "info", "data": "test"}),
            McpCallToolOptions::default(),
        )
        .await
        .unwrap();
    while received.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    let params = received.lock().unwrap()[0].clone();
    assert_eq!(params, McpLogMessage::new(McpLogLevel::Info, json!("test")));
}
