//! Deferred tools on the Claude API: `defer_loading`, the `load_tools` listing, tool references and
//! the tools cache point.

use std::collections::HashSet;

use serde_json::json;

use super::*;
use crate::models::{CacheConfig, DeferredToolLoading, ModelCapabilities, ModelInfo};
use crate::types::{Role, TextBlock, ToolReferenceBlock, ToolResultBlock, ToolResultContent};

fn deferred(names: &[&str]) -> HashSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

fn spec(name: &str, description: &str) -> ToolSpec {
    ToolSpec::new(name, description).with_input_schema(json!({"type": "object"}))
}

fn tool_specs() -> Vec<ToolSpec> {
    vec![spec("t1", "tool one"), spec("t2", "tool two")]
}

fn tools_cached() -> AnthropicModelConfig {
    config()
        .cache_config(CacheConfig::builder().messages_ttl(false).build())
        .build()
}

async fn sent(config: AnthropicModelConfig, request: ModelRequest) -> JsonValue {
    let client = MockClient::capture();
    collect(&model(&client, config), request).await.unwrap();
    client.last()
}

fn with_tools(tool_specs: Vec<ToolSpec>, deferred_tools: HashSet<String>) -> ModelRequest {
    ModelRequest {
        tool_specs,
        deferred_tools,
        ..hi()
    }
}

#[test]
fn reports_deferred_tools_from_the_shared_model_info() {
    for (model_id, expected) in [
        ("claude-haiku-4-5-20251001", DeferredToolLoading::Native),
        ("claude-opus-5-5", DeferredToolLoading::Native),
        ("claude-opus-4-1", DeferredToolLoading::Stubs),
        ("claude-3-5-haiku-20241022", DeferredToolLoading::Stubs),
    ] {
        let provider = model(&MockClient::capture(), config().model_id(model_id).build());
        assert_eq!(
            provider.model_info().capabilities.deferred_tool_loading,
            Some(expected),
            "{model_id}"
        );
    }
}

mod tool_references {
    use super::*;

    fn shell() -> ToolSpec {
        spec("shell", "Run a command")
    }

    fn read() -> ToolSpec {
        spec("read", "Read a file")
    }

    fn shell_text() -> String {
        format!("shell parameters: {}", json!({"type": "object"}))
    }

    async fn sent_tool_result(content: Vec<ToolResultContent>, deferred_tools: &[&str]) -> JsonValue {
        let message = Message::new(Role::User, vec![ToolResultBlock::success("t1", content).into()]);
        let request = ModelRequest {
            tool_specs: vec![shell(), read()],
            deferred_tools: deferred(deferred_tools),
            ..request(vec![message])
        };
        sent(AnthropicModelConfig::default(), request).await["messages"][0]["content"][0].clone()
    }

    fn tool_result(content: &JsonValue) -> JsonValue {
        json!({"type": "tool_result", "tool_use_id": "t1", "content": content, "is_error": false})
    }

    #[tokio::test]
    async fn sends_references_to_tools_the_request_defers_as_tool_reference_blocks() {
        assert_eq!(
            sent_tool_result(vec![ToolReferenceBlock::new("shell").into()], &["shell"]).await,
            tool_result(&json!([{"type": "tool_reference", "tool_name": "shell"}]))
        );
    }

    #[tokio::test]
    async fn sends_a_reference_as_text_when_the_request_does_not_defer_the_tool_as_in_a_server_side_summary() {
        assert_eq!(
            sent_tool_result(vec![ToolReferenceBlock::new("shell").into()], &[]).await,
            tool_result(&json!(shell_text()))
        );
    }

    #[tokio::test]
    async fn sends_every_reference_in_a_result_as_text_when_the_result_also_holds_other_content_or_a_reference_to_a_tool_the_request_does_not_defer()
     {
        let cases = [
            (
                ToolResultContent::Text(TextBlock::new("note")),
                json!({"type": "text", "text": "note"}),
            ),
            (
                ToolReferenceBlock::new("read").into(),
                json!({"type": "text", "text": format!("read parameters: {}", json!({"type": "object"}))}),
            ),
        ];
        for (other, expected) in cases {
            assert_eq!(
                sent_tool_result(vec![ToolReferenceBlock::new("shell").into(), other], &["shell"]).await,
                tool_result(&json!([{"type": "text", "text": shell_text()}, expected]))
            );
        }
    }
}

#[tokio::test]
async fn sends_deferred_tools_with_defer_loading_and_caches_the_last_non_deferred_tool() {
    let mut specs = tool_specs();
    specs.push(spec("t3", "tool three"));
    let request = sent(tools_cached(), with_tools(specs, deferred(&["t1", "t3"]))).await;
    assert_eq!(
        request["tools"],
        json!([
            {"name": "t1", "description": "tool one", "input_schema": {"type": "object"}, "defer_loading": true},
            {"name": "t2", "description": "tool two", "input_schema": {"type": "object"}, "cache_control": {"type": "ephemeral"}},
            {"name": "t3", "description": "tool three", "input_schema": {"type": "object"}, "defer_loading": true},
        ])
    );
}

#[tokio::test]
async fn lists_the_deferred_tools_in_the_load_tools_description_since_the_api_hides_them() {
    let mut specs = vec![spec("load_tools", "Load tools.")];
    specs.extend(tool_specs());
    let request = sent(tools_cached(), with_tools(specs, deferred(&["t1"]))).await;
    assert_eq!(
        request["tools"][0]["description"],
        "Load tools.\n\nTools you can load:\n- t1: tool one"
    );
}

#[tokio::test]
async fn omits_defer_loading_on_a_model_without_native_deferred_tools() {
    let unsupported = ModelInfo {
        capabilities: ModelCapabilities {
            deferred_tool_loading: Some(DeferredToolLoading::Unsupported),
            ..ModelCapabilities::default()
        },
        ..ModelInfo::default()
    };
    for config in [
        config().model_id("claude-opus-4-1").build(),
        config().model_id("claude-opus-5-5").model_info(unsupported).build(),
    ] {
        let request = sent(config, with_tools(vec![spec("t1", "tool one")], deferred(&["t1"]))).await;
        assert_eq!(
            request["tools"],
            json!([{"name": "t1", "description": "tool one", "input_schema": {"type": "object"}}])
        );
    }
}

#[tokio::test]
async fn omits_defer_loading_on_a_tool_the_call_does_not_defer() {
    let request = sent(
        AnthropicModelConfig::default(),
        with_tools(vec![spec("t1", "tool one")], deferred(&["t2"])),
    )
    .await;
    assert_eq!(
        request["tools"],
        json!([{"name": "t1", "description": "tool one", "input_schema": {"type": "object"}}])
    );
}

#[tokio::test]
async fn adds_no_tools_breakpoint_when_every_tool_is_deferred() {
    let request = sent(tools_cached(), with_tools(tool_specs(), deferred(&["t1", "t2"]))).await;
    assert!(
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool.get("cache_control").is_none())
    );
}
