//! Tool listing: spec conversion, prefixes, filters, the name-length limit and pagination.

use std::sync::Mutex;

use regex::Regex;
use rmcp::model::Tool as ServerTool;
use serde_json::json;

use super::*;
use crate::error::Error;
use crate::mcp::{McpCallToolOptions, McpListToolsOptions, McpToolFilters, McpToolMatcher};
use crate::test_support::record_logs;

fn raw_tool(name: &str) -> ServerTool {
    ServerTool::new_with_raw(name.to_owned(), None, Arc::new(serde_json::Map::new()))
}

fn server_with(names: &[&str]) -> TestServer {
    let mut tools: Vec<ServerTool> = names.iter().map(|name| raw_tool(name)).collect();
    tools.push(ServerTool::new(
        "args",
        "Returns its arguments",
        Arc::new(serde_json::Map::new()),
    ));
    TestServer::with_tools(tools)
}

fn options(prefix: Option<&str>, filters: Option<McpToolFilters>) -> McpClientOptions {
    McpClientOptions {
        prefix: prefix.map(str::to_owned),
        tool_filters: filters,
        ..McpClientOptions::default()
    }
}

fn allowed(matchers: Vec<McpToolMatcher>) -> McpToolFilters {
    McpToolFilters {
        allowed: Some(matchers),
        rejected: None,
    }
}

#[tokio::test]
async fn converts_sdk_tool_specs_to_mcp_tool_instances() {
    let long_name = "a".repeat(65);
    let output_schema =
        json!({"type": "object", "properties": {"forecast": {"type": "string"}}, "required": ["forecast"]});
    let weather = ServerTool::new("weather", "Get weather", Arc::new(serde_json::Map::new()))
        .with_raw_output_schema(Arc::new(output_schema.as_object().cloned().unwrap()));
    let server = TestServer::with_tools(vec![weather, raw_tool(&long_name)]);
    let client = client(server.clone());

    let tools = client.list_tools().await.unwrap();

    assert_eq!(names(&tools), vec!["weather".to_owned(), long_name.clone()]);
    assert_eq!(
        serde_json::to_value(tools[0].tool_spec()).unwrap(),
        json!({"name": "weather", "description": "Get weather", "inputSchema": {}, "outputSchema": output_schema})
    );
    client
        .call_tool(&tools[1], json!({}), McpCallToolOptions::default())
        .await
        .unwrap();
    assert_eq!(server.calls(), vec![long_name]);
}

#[tokio::test]
async fn matches_strings_and_regexes_against_the_server_side_name_and_passes_the_renamed_tool_to_callbacks() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = seen.clone();
    let callback = McpToolMatcher::callback(move |tool| {
        recorder.lock().unwrap().push(tool.name().to_owned());
        tool.name() == "server_callback_tool"
    });
    let filters = McpToolFilters {
        allowed: Some(vec!["exact".into(), Regex::new("regex_").unwrap().into(), callback]),
        rejected: Some(vec!["regex_rejected".into()]),
    };
    let server = server_with(&[
        "exact",
        "exact_extra",
        "regex_allowed",
        "xregex_unanchored",
        "regex_rejected",
        "callback_tool",
    ]);
    let client = client_with(server, options(Some("server"), Some(filters)));

    let tools = client.list_tools().await.unwrap();

    assert_eq!(
        names(&tools),
        ["server_exact", "server_regex_allowed", "server_callback_tool"]
    );
    assert_eq!(
        *seen.lock().unwrap(),
        [
            "server_exact_extra",
            "server_xregex_unanchored",
            "server_callback_tool",
            "server_args"
        ]
    );
}

#[tokio::test]
async fn applies_allowed_before_rejected_with_rejected_winning_and_distinguishes_missing_from_empty_allowed() {
    let client = client(server_with(&["one", "two"]));
    let list = |filters: McpToolFilters| {
        let client = client.clone();
        async move {
            names(
                &client
                    .list_tools_with(McpListToolsOptions {
                        prefix: None,
                        tool_filters: Some(filters),
                    })
                    .await
                    .unwrap(),
            )
        }
    };
    assert_eq!(
        list(McpToolFilters {
            allowed: None,
            rejected: Some(vec!["two".into(), "args".into()]),
        })
        .await,
        ["one"]
    );
    assert!(list(allowed(Vec::new())).await.is_empty());
    assert!(
        list(McpToolFilters {
            allowed: Some(vec!["one".into()]),
            rejected: Some(vec!["one".into()]),
        })
        .await
        .is_empty()
    );
}

#[tokio::test]
async fn inherits_constructor_defaults_while_explicit_empty_prefix_and_filters_disable_them() {
    let client = client_with(
        server_with(&["one", "two"]),
        options(Some("default"), Some(allowed(vec!["one".into()]))),
    );

    let defaulted = client.list_tools().await.unwrap();
    assert_eq!(names(&defaulted), ["default_one"]);
    assert_eq!(
        serde_json::to_value(defaulted[0].tool_spec()).unwrap(),
        json!({"name": "default_one", "description": "Tool which performs one", "inputSchema": {}})
    );
    let disabled = client
        .list_tools_with(McpListToolsOptions {
            prefix: Some(String::new()),
            tool_filters: Some(McpToolFilters::default()),
        })
        .await
        .unwrap();
    assert_eq!(names(&disabled), ["one", "two", "args"]);
    let overridden = client
        .list_tools_with(McpListToolsOptions {
            prefix: Some("override".to_owned()),
            tool_filters: Some(allowed(vec!["two".into()])),
        })
        .await
        .unwrap();
    assert_eq!(names(&overridden), ["override_two"]);
}

#[tokio::test]
async fn filters_and_prefixes_sdk_results_and_invokes_tools_by_the_server_side_name() {
    let server = server_with(&["keep_one", "drop_one", "keep_two"]);
    let client = client_with(
        server.clone(),
        options(Some("server"), Some(allowed(vec![Regex::new("keep_").unwrap().into()]))),
    );

    let tools = client.list_tools().await.unwrap();
    client
        .call_tool(&tools[1], json!({"value": 1}), McpCallToolOptions::default())
        .await
        .unwrap();

    assert_eq!(names(&tools), ["server_keep_one", "server_keep_two"]);
    assert_eq!(tools[1].server_tool_name(), "keep_two");
    assert_eq!(server.calls(), ["keep_two"]);
}

#[tokio::test]
async fn skips_overlong_names_in_listed_tools_and_preserves_the_64_character_boundary() {
    let (logs, _guard) = record_logs();
    let boundary = "a".repeat(57);
    let overlong = "a".repeat(58);
    let client = client_with(
        TestServer::with_tools(vec![raw_tool(&overlong), raw_tool(&boundary), raw_tool("short")]),
        McpClientOptions {
            prefix: Some("server".to_owned()),
            continue_on_error: true,
            ..McpClientOptions::default()
        },
    );

    let tools = client.list_tools().await.unwrap();

    assert_eq!(names(&tools), [format!("server_{boundary}"), "server_short".to_owned()]);
    let text = logs.text();
    let warnings: Vec<&str> = text.lines().filter(|line| line.contains("WARN")).collect();
    assert_eq!(warnings.len(), 1, "{}", logs.text());
    for detail in [
        "test-server",
        overlong.as_str(),
        &format!("server_{overlong}"),
        "65",
        "64",
        "prefix",
        "skipping",
    ] {
        assert!(warnings[0].contains(detail), "{detail}: {}", warnings[0]);
    }
    assert_eq!(client.connection_state(), super::super::McpConnectionState::Connected);
}

async fn throws_an_actionable_error(continue_on_error: bool) {
    let (logs, _guard) = record_logs();
    let server_name = "get_cloudformation_pre_deploy_validation_instructions";
    let client = client_with(
        TestServer::with_tools(vec![raw_tool(server_name)]),
        McpClientOptions {
            prefix: Some("awslabs_aws-iac-mcp-server".to_owned()),
            continue_on_error,
            ..McpClientOptions::default()
        },
    );

    let error = client.list_tools().await.unwrap_err();

    assert!(matches!(error, Error::ToolValidation(_)), "{error:?}");
    let message = error.to_string();
    assert!(
        Regex::new("test-server.*get_cloudformation.*64.*prefix")
            .unwrap()
            .is_match(&message),
        "{message}"
    );
    assert!(!logs.text().contains("WARN"), "{}", logs.text());
}

#[tokio::test]
async fn throws_an_actionable_error_with_continue_on_error_undefined() {
    throws_an_actionable_error(false).await;
}

#[tokio::test]
async fn throws_an_actionable_error_with_continue_on_error_false() {
    throws_an_actionable_error(false).await;
}

#[tokio::test]
async fn generates_description_fallback_when_description_is_missing() {
    let client = client(TestServer::with_tools(vec![raw_tool("weather")]));
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools[0].description(), "Tool which performs weather");
}

#[tokio::test]
async fn generates_description_fallback_when_description_is_empty_string() {
    let tool = ServerTool::new("weather", "", Arc::new(serde_json::Map::new()));
    let client = client(TestServer::with_tools(vec![tool]));
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools[0].description(), "Tool which performs weather");
}

#[tokio::test]
async fn passes_list_max_pages_to_the_sdk_client_when_set() {
    let client = client_with(
        TestServer::new().paged(1),
        McpClientOptions {
            list_max_pages: Some(2),
            ..McpClientOptions::default()
        },
    );
    let error = client.list_tools().await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "tools/list: exceeded listMaxPages (2); server pagination did not terminate"
    );
}

#[tokio::test]
async fn omits_list_max_pages_when_unset_so_the_sdk_default_applies() {
    let client = client(TestServer::new().paged(2));
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools.len(), server::default_tools().len());
}

#[tokio::test]
async fn disables_the_page_cap_with_zero() {
    let client = client_with(
        TestServer::new().paged(1),
        McpClientOptions {
            list_max_pages: Some(0),
            ..McpClientOptions::default()
        },
    );
    assert_eq!(client.list_tools().await.unwrap().len(), server::default_tools().len());
}
