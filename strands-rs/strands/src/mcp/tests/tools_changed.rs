//! Tool-list change refreshes. Most cases call the refresh directly; one drives a real
//! `notifications/tools/list_changed` through the 300 ms debounce.

use std::time::Duration;

use rmcp::model::Tool as ServerTool;
use serde_json::json;

use super::*;
use crate::mcp::{McpCallToolOptions, McpListToolsOptions, McpToolFilters, ToolsChangedCallback};
use crate::test_support::record_logs;

type Changes = Arc<Mutex<Vec<(Vec<String>, Vec<String>)>>>;

fn tool(name: &str) -> ServerTool {
    ServerTool::new_with_raw(name.to_owned(), None, Arc::new(serde_json::Map::new()))
}

fn watch(client: &McpClient) -> Changes {
    let changes: Changes = Arc::default();
    let sink = changes.clone();
    client.set_on_tools_changed(Some(ToolsChangedCallback::new(move |old, new| {
        sink.lock().unwrap().push((old, names(&new)));
    })));
    changes
}

fn prefixed(server: TestServer, prefix: &str, continue_on_error: bool) -> McpClient {
    client_with(
        server,
        McpClientOptions {
            prefix: Some(prefix.to_owned()),
            continue_on_error,
            ..McpClientOptions::default()
        },
    )
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[tokio::test]
async fn calls_on_tools_changed_with_old_names_and_new_tools_when_list_changes() {
    let (logs, _guard) = record_logs();
    let server = TestServer::with_tools(vec![tool("tool_a")]);
    let client = prefixed(server.clone(), "server", true);
    client.list_tools().await.unwrap();
    let changes = watch(&client);
    let overlong = "a".repeat(58);

    server.set_tools(vec![tool("tool_a"), tool("tool_b"), tool(&overlong)]);
    client.handle_tools_changed().await;
    server.set_tools(vec![tool(&overlong)]);
    client.handle_tools_changed().await;
    server.set_tools(vec![tool("tool_c")]);
    client.handle_tools_changed().await;

    assert_eq!(
        *changes.lock().unwrap(),
        [
            (
                strings(&["server_tool_a"]),
                strings(&["server_tool_a", "server_tool_b"])
            ),
            (strings(&["server_tool_a", "server_tool_b"]), Vec::new()),
            (Vec::new(), strings(&["server_tool_c"])),
        ]
    );
    let warnings = logs.text().lines().filter(|line| line.contains("WARN")).count();
    assert_eq!(warnings, 2, "{}", logs.text());
}

#[tokio::test]
async fn updates_registered_tool_names_after_each_list_tools_call() {
    let server = TestServer::with_tools(vec![tool("x"), tool("y")]);
    let client = client(server.clone());
    client.list_tools().await.unwrap();
    let changes = watch(&client);

    server.set_tools(vec![tool("z")]);
    client.handle_tools_changed().await;

    assert_eq!(*changes.lock().unwrap(), [(strings(&["x", "y"]), strings(&["z"]))]);
}

#[tokio::test]
async fn keeps_default_registered_names_after_an_overridden_listing() {
    let client = prefixed(TestServer::with_tools(vec![tool("tool_a")]), "default", false);
    client.list_tools().await.unwrap();
    client
        .list_tools_with(McpListToolsOptions {
            prefix: Some("temporary".to_owned()),
            tool_filters: None,
        })
        .await
        .unwrap();
    let changes = watch(&client);

    client.handle_tools_changed().await;

    assert_eq!(changes.lock().unwrap()[0].0, strings(&["default_tool_a"]));
}

#[tokio::test]
async fn reapplies_constructor_filters_and_prefix_when_refreshing() {
    let client = client_with(
        TestServer::with_tools(vec![tool("tool_a"), tool("tool_b")]),
        McpClientOptions {
            prefix: Some("server".to_owned()),
            tool_filters: Some(McpToolFilters {
                allowed: Some(vec!["tool_a".into()]),
                rejected: None,
            }),
            ..McpClientOptions::default()
        },
    );
    client.list_tools().await.unwrap();
    let changes = watch(&client);

    client.handle_tools_changed().await;

    assert_eq!(
        *changes.lock().unwrap(),
        [(strings(&["server_tool_a"]), strings(&["server_tool_a"]))]
    );
}

#[tokio::test]
async fn does_not_throw_when_on_tools_changed_is_not_set() {
    let server = TestServer::with_tools(vec![tool("tool_a")]);
    let client = client(server.clone());
    client.list_tools().await.unwrap();
    server.set_tools(vec![tool("tool_b")]);
    client.handle_tools_changed().await;
}

async fn logs_warning_and_preserves_registry_when_list_tools_fails_during_refresh(fail_request: bool) {
    let (logs, _guard) = record_logs();
    let server = TestServer::with_tools(vec![tool("tool_a")]);
    let client = prefixed(server.clone(), "server", false);
    client.list_tools().await.unwrap();
    let changes = watch(&client);
    if fail_request {
        server.fail_lists(1);
    } else {
        server.set_tools(vec![tool("ephemeral"), tool(&"a".repeat(58))]);
    }

    client.handle_tools_changed().await;

    assert!(changes.lock().unwrap().is_empty());
    assert!(logs.text().contains("failed to refresh tools"), "{}", logs.text());
    server.set_tools(vec![tool("tool_b")]);
    client.handle_tools_changed().await;
    assert_eq!(
        *changes.lock().unwrap(),
        [(strings(&["server_tool_a"]), strings(&["server_tool_b"]))]
    );
}

#[tokio::test]
async fn logs_warning_and_preserves_registry_when_list_tools_fails_during_refresh_request() {
    logs_warning_and_preserves_registry_when_list_tools_fails_during_refresh(true).await;
}

#[tokio::test]
async fn logs_warning_and_preserves_registry_when_list_tools_fails_during_refresh_name_length() {
    logs_warning_and_preserves_registry_when_list_tools_fails_during_refresh(false).await;
}

#[tokio::test(start_paused = true)]
async fn coalesces_notifications_received_during_an_in_flight_refresh_into_one_extra_refresh() {
    let server = TestServer::with_tools(vec![tool("tool_a")]);
    let client = client(server.clone());
    client.list_tools().await.unwrap();
    let changes = watch(&client);
    server.set_tools(vec![tool("tool_b")]);
    server.set_list_delay(Duration::from_secs(1));

    let refresh = {
        let client = client.clone();
        tokio::spawn(async move { client.handle_tools_changed().await })
    };
    while server.lists() < 2 {
        tokio::task::yield_now().await;
    }
    client.handle_tools_changed().await;
    client.handle_tools_changed().await;
    refresh.await.unwrap();

    assert_eq!(changes.lock().unwrap().len(), 2);
    assert_eq!(server.lists(), 3);
}

#[tokio::test(start_paused = true)]
async fn refreshes_after_a_list_changed_notification_from_the_server() {
    let server = TestServer::new();
    let client = client(server.clone());
    client.list_tools().await.unwrap();
    let changes = watch(&client);
    let add = tool_named(&client, "add_tool").await;

    client
        .call_tool(&add, json!({"name": "late"}), McpCallToolOptions::default())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    while changes.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }

    let (old, new) = changes.lock().unwrap()[0].clone();
    assert!(!old.contains(&"late".to_owned()));
    assert_eq!(new.last().map(String::as_str), Some("late"));
}
