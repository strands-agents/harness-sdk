//! Live Amazon Bedrock tests. Ignored by default; they call Bedrock with the default AWS credential
//! chain and skip when no credentials resolve:
//!
//! ```text
//! cargo test -p strands --features bedrock --test live_bedrock -- --ignored
//! ```
//!
//! Model-level tests drive `Model::stream` directly; agent-level tests run the real [`Agent`] on a
//! Bedrock model.

#![cfg(feature = "bedrock")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    reason = "live tests report failures by panicking and print skips"
)]

use aws_config::BehaviorVersion;
use aws_credential_types::provider::ProvideCredentials;
use futures::StreamExt;
use serde_json::json;
use std::sync::Arc;

use strands::conversation_manager::{SlidingWindowConversationManager, SlidingWindowConversationManagerConfig};
use strands::models::bedrock::{BedrockModel, BedrockModelConfig};
use strands::models::{CacheConfig, CacheStrategy, CountTokensOptions, Model, ModelRequest, StreamAggregatedResult};
use strands::tools::FunctionTool;
use strands::{
    Agent, AggregatedEvent, CachePointBlock, ContentBlock, ContentBlockDelta, Message, ModelStreamEvent, Role,
    StopReason, SystemContentBlock, SystemPrompt, ToolChoice, ToolResultBlock, ToolResultContent, ToolSpec, Usage,
};

const NOVA_LITE: &str = "us.amazon.nova-lite-v1:0";
const HAIKU: &str = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
/// CountTokens takes a foundation model id, not an inference profile.
const COUNT_TOKENS_MODEL_ID: &str = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const CACHING_MODEL_ID: &str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

async fn credentials_available() -> bool {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let Some(provider) = config.credentials_provider() else {
        println!("skipping: no AWS credentials provider");
        return false;
    };
    if provider.provide_credentials().await.is_err() {
        println!("skipping: AWS credentials did not resolve");
        return false;
    }
    true
}

macro_rules! require_credentials {
    () => {
        if !credentials_available().await {
            return;
        }
    };
}

fn model(model_id: &str, max_tokens: u64) -> BedrockModel {
    BedrockModel::new(BedrockModelConfig {
        model_id: Some(model_id.to_owned()),
        max_tokens: Some(max_tokens),
        ..BedrockModelConfig::default()
    })
}

async fn aggregate(model: &impl Model, request: ModelRequest) -> (Vec<ModelStreamEvent>, StreamAggregatedResult) {
    let mut stream = model.stream_aggregated(request);
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item.expect("model call") {
            AggregatedEvent::ModelStreamEvent(event) => events.push(event),
            AggregatedEvent::Done(result) => return (events, result),
            _ => {}
        }
    }
    panic!("stream ended without a result");
}

fn ask(text: &str) -> ModelRequest {
    ModelRequest::builder().messages(vec![Message::user(text)]).build()
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_plain_text() {
    require_credentials!();
    let (_, result) = aggregate(
        &model(NOVA_LITE, 50),
        ask("What is the capital of France? Answer in one word."),
    )
    .await;
    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert!(
        result.message.text().to_lowercase().contains("paris"),
        "{}",
        result.message.text()
    );
    let usage = result.metadata.and_then(|metadata| metadata.usage).expect("usage");
    assert!(usage.input_tokens > 0 && usage.output_tokens > 0);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_streaming_text_deltas() {
    require_credentials!();
    let (events, result) = aggregate(&model(NOVA_LITE, 200), ask("Count from 1 to 30, one number per line.")).await;
    let deltas = events
        .iter()
        .filter(|event| matches!(event, ModelStreamEvent::ContentBlockDelta(delta) if matches!(delta.delta, ContentBlockDelta::Text(_))))
        .count();
    assert!(deltas > 1, "expected several text deltas, got {deltas}");
    assert!(result.message.text().contains("30"));
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_non_streaming_text() {
    require_credentials!();
    let model = BedrockModel::new(BedrockModelConfig {
        model_id: Some(NOVA_LITE.to_owned()),
        max_tokens: Some(50),
        stream: Some(false),
        ..BedrockModelConfig::default()
    });
    let (_, result) = aggregate(&model, ask("What is the capital of France? Answer in one word.")).await;
    assert!(
        result.message.text().to_lowercase().contains("paris"),
        "{}",
        result.message.text()
    );
    assert!(result.metadata.and_then(|metadata| metadata.metrics).is_some());
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_respects_max_tokens() {
    require_credentials!();
    let mut stream = model(NOVA_LITE, 20).stream_aggregated(ask("Write a long story about dragons."));
    let mut error = None;
    while let Some(item) = stream.next().await {
        if let Err(failure) = item {
            error = Some(failure);
        }
    }
    let error = error.expect("a max tokens error");
    assert_eq!(error.name(), "MaxTokensError");
}

fn weather_tool() -> ToolSpec {
    ToolSpec::new("get_weather", "Get the current weather for a city.").with_input_schema(json!({
        "type": "object",
        "properties": {"city": {"type": "string", "description": "The city name"}},
        "required": ["city"]
    }))
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_tool_call_round_trip() {
    require_credentials!();
    let model = model(NOVA_LITE, 300);
    let mut messages = vec![Message::user("What is the weather in Paris? Use the get_weather tool.")];
    let request = ModelRequest::builder()
        .messages(messages.clone())
        .tool_specs(vec![weather_tool()])
        .build();
    let (_, first) = aggregate(&model, request).await;
    assert_eq!(first.stop_reason, StopReason::ToolUse);
    let tool_use = first
        .message
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some(tool_use.clone()),
            _ => None,
        })
        .expect("a tool use");
    assert_eq!(tool_use.name, "get_weather");
    assert!(
        tool_use.input["city"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("paris")
    );
    messages.push(first.message);
    messages.push(Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            tool_use.tool_use_id,
            vec![ToolResultContent::text("Sunny, 23 degrees Celsius")],
        ))],
    ));
    let request = ModelRequest::builder()
        .messages(messages)
        .tool_specs(vec![weather_tool()])
        .build();
    let (_, second) = aggregate(&model, request).await;
    assert_eq!(second.stop_reason, StopReason::EndTurn);
    assert!(second.message.text().contains("23"), "{}", second.message.text());
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_structured_output_forced_tool() {
    require_credentials!();
    let schema = json!({
        "type": "object",
        "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
        "required": ["name", "age"],
        "additionalProperties": false
    });
    let request = ModelRequest {
        messages: vec![Message::user("Generate a person named Ada who is 36.")],
        tool_specs: vec![
            ToolSpec::new("strands_structured_output", "Output the person").with_input_schema(schema.clone()),
        ],
        tool_choice: Some(ToolChoice::tool("strands_structured_output")),
        structured_output_schema: Some(schema),
        ..ModelRequest::default()
    };
    let (_, result) = aggregate(&model(HAIKU, 300), request).await;
    let input = result
        .message
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::ToolUse(tool_use) if tool_use.name == "strands_structured_output" => {
                Some(tool_use.input.clone())
            }
            _ => None,
        })
        .expect("a structured output tool use");
    assert_eq!(input["name"], "Ada");
    assert_eq!(input["age"], 36);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_reasoning_is_streamed_and_replayed() {
    require_credentials!();
    let model = BedrockModel::new(BedrockModelConfig {
        model_id: Some(HAIKU.to_owned()),
        max_tokens: Some(2048),
        additional_request_fields: Some(json!({"thinking": {"type": "enabled", "budget_tokens": 1024}})),
        ..BedrockModelConfig::default()
    });
    let mut messages = vec![Message::user("What is 17 * 23? Answer with the number.")];
    let (_, first) = aggregate(&model, ModelRequest::builder().messages(messages.clone()).build()).await;
    let reasoning = first
        .message
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::Reasoning(reasoning) => Some(reasoning.clone()),
            _ => None,
        })
        .expect("a reasoning block");
    assert!(reasoning.signature.is_some(), "Claude reasoning carries a signature");
    assert!(first.message.text().contains("391"));
    messages.push(first.message);
    messages.push(Message::user("Now add 9. Answer with the number."));
    let (_, second) = aggregate(&model, ModelRequest::builder().messages(messages).build()).await;
    assert!(second.message.text().contains("400"), "{}", second.message.text());
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_native_count_tokens() {
    require_credentials!();
    let model = BedrockModel::new(BedrockModelConfig {
        model_id: Some(COUNT_TOKENS_MODEL_ID.to_owned()),
        use_native_token_count: Some(true),
        ..BedrockModelConfig::default()
    });
    let messages = vec![Message::user("Hello, how are you today?")];
    let options = CountTokensOptions {
        system_prompt: Some("Be brief.".into()),
        tool_specs: vec![weather_tool()],
    };
    let native = model.count_tokens(&messages, options.clone()).await.unwrap();
    let estimate = strands::models::estimate_tokens(&messages, &options);
    println!("count_tokens native={native} estimate={estimate}");
    assert!(native > 0);
    assert_ne!(native, estimate, "the native count fell back to the estimate");
}

/// A tool schema large enough for the tools section to pass the model's minimum cacheable prefix.
fn large_tool() -> ToolSpec {
    let properties: serde_json::Map<String, serde_json::Value> = (0..120)
        .map(|index| {
            (
                format!("field_{index:03}"),
                json!({"type": "string", "description": format!("Free-text value number {index} for the record, describing one attribute of the item in detail.")}),
            )
        })
        .collect();
    ToolSpec::new("record_item", "Record an item with many attributes.")
        .with_input_schema(json!({"type": "object", "properties": properties}))
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_prompt_cache_reads_tools_and_system_on_the_second_request() {
    require_credentials!();
    let model = BedrockModel::new(BedrockModelConfig {
        model_id: Some(CACHING_MODEL_ID.to_owned()),
        max_tokens: Some(50),
        cache_config: Some(CacheConfig::default()),
        ..BedrockModelConfig::default()
    });
    let nonce = format!("{:?}", std::time::SystemTime::now());
    let system = SystemPrompt::Blocks(vec![SystemContentBlock::text(format!(
        "You are terse. Context {nonce}: {}",
        "hello ".repeat(1200)
    ))]);
    let request = || ModelRequest {
        messages: vec![Message::user("Say ok.")],
        system_prompt: Some(system.clone()),
        tool_specs: vec![large_tool()],
        ..ModelRequest::default()
    };
    let (_, first) = aggregate(&model, request()).await;
    let first_usage = first.metadata.and_then(|metadata| metadata.usage).expect("usage");
    let (_, second) = aggregate(&model, request()).await;
    let second_usage = second.metadata.and_then(|metadata| metadata.usage).expect("usage");
    println!(
        "cache first write={:?} read={:?}, second write={:?} read={:?}",
        first_usage.cache_write_input_tokens,
        first_usage.cache_read_input_tokens,
        second_usage.cache_write_input_tokens,
        second_usage.cache_read_input_tokens
    );
    assert!(first_usage.cache_write_input_tokens.unwrap_or(0) > 0);
    assert!(second_usage.cache_read_input_tokens.unwrap_or(0) > 0);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_invalid_model_id_is_a_model_error() {
    require_credentials!();
    let mut stream = model("invalid-model-id-that-does-not-exist", 10).stream(ask("Hello"));
    let error = stream.next().await.expect("an item").expect_err("an error");
    println!("invalid model error=<{error}>");
    assert_eq!(error.name(), "ModelError");
    let source = std::error::Error::source(&error)
        .expect("the Bedrock error")
        .to_string();
    assert!(source.starts_with("ValidationException: "), "{source}");
}

const SONNET_4_6: &str = "global.anthropic.claude-sonnet-4-6";

/// A per-run marker, so the first request of a cache test always writes the cache.
fn nonce() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos:x}")
}

fn usage_of(result: &StreamAggregatedResult) -> Usage {
    result
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.usage)
        .expect("usage")
}

fn has_block(agent: &Agent, matches: impl Fn(&ContentBlock) -> bool) -> bool {
    agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .any(matches)
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_prompt_cache_reads_message_cache_points_on_the_second_request() {
    require_credentials!();
    let model = model(CACHING_MODEL_ID, 100);
    let context = format!("Context information: {} [test-{}]", "hello ".repeat(2000), nonce());
    let request = |text: &str| {
        let content = vec![
            ContentBlock::text(context.clone()),
            ContentBlock::CachePoint(CachePointBlock::new()),
            ContentBlock::text(text),
        ];
        ModelRequest::builder()
            .messages(vec![Message::new(Role::User, content)])
            .build()
    };
    let (_, first) = aggregate(&model, request("Say hello")).await;
    let (_, second) = aggregate(&model, request("Say goodbye")).await;
    println!(
        "message cache first={:?} second={:?}",
        usage_of(&first),
        usage_of(&second)
    );
    assert!(usage_of(&first).cache_write_input_tokens.unwrap_or(0) > 0);
    assert!(usage_of(&second).cache_read_input_tokens.unwrap_or(0) > 0);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_per_call_content_stays_out_of_the_cached_prefix() {
    require_credentials!();
    let model = BedrockModel::new(BedrockModelConfig {
        model_id: Some(CACHING_MODEL_ID.to_owned()),
        max_tokens: Some(100),
        cache_config: Some(CacheConfig {
            strategy: Some(CacheStrategy::Auto),
            ..CacheConfig::default()
        }),
        ..BedrockModelConfig::default()
    });
    let prefix = format!(
        "Dossier {}. {}",
        nonce(),
        "The subject prefers concise answers. ".repeat(400)
    );
    let tail = || format!("Addendum {}. {}", nonce(), "Disregard this filler. ".repeat(400));
    let request = || {
        let content = vec![
            ContentBlock::text(prefix.clone()),
            ContentBlock::CachePoint(CachePointBlock::new()),
            ContentBlock::text(tail()),
        ];
        ModelRequest::builder()
            .messages(vec![Message::new(Role::User, content)])
            .build()
    };
    let (_, first) = aggregate(&model, request()).await;
    let (_, second) = aggregate(&model, request()).await;
    println!("per-call first={:?} second={:?}", usage_of(&first), usage_of(&second));
    assert!(usage_of(&first).cache_write_input_tokens.unwrap_or(0) > 0);
    assert!(usage_of(&first).input_tokens > 1000);
    assert!(usage_of(&second).cache_read_input_tokens.unwrap_or(0) > 0);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_count_tokens_grows_with_tools_and_system_prompt() {
    require_credentials!();
    let model = BedrockModel::new(BedrockModelConfig {
        model_id: Some(COUNT_TOKENS_MODEL_ID.to_owned()),
        use_native_token_count: Some(true),
        ..BedrockModelConfig::default()
    });
    let messages = [Message::user("What is the capital of France? Explain in detail.")];
    let without = model
        .count_tokens(&messages, CountTokensOptions::default())
        .await
        .unwrap();
    let with_tools = model
        .count_tokens(
            &messages,
            CountTokensOptions {
                system_prompt: Some("Be helpful.".into()),
                tool_specs: vec![weather_tool()],
            },
        )
        .await
        .unwrap();
    println!("count_tokens without={without} with_tools={with_tools}");
    assert!(without > 0);
    assert!(with_tools > without);
}

fn weather_function_tool() -> FunctionTool {
    FunctionTool::builder("get_weather", "Get the current weather for a city.")
        .input_schema(json!({
            "type": "object",
            "properties": {"city": {"type": "string", "description": "The city name"}},
            "required": ["city"]
        }))
        .callback(|input, _ctx| async move { Ok(json!(format!("Sunny, 24 degrees Celsius in {}", input["city"]))) })
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_agent_tool_round_trip() {
    require_credentials!();
    let mut agent = Agent::builder()
        .model(model(NOVA_LITE, 512))
        .tools([weather_function_tool()])
        .printer(false)
        .build()
        .unwrap();
    let result = agent
        .invoke("What is the weather in Paris? Use the tool.")
        .await
        .unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(
        result.last_message().text().contains("24"),
        "{}",
        result.last_message().text()
    );
    assert!(has_block(&agent, |block| matches!(block, ContentBlock::ToolUse(_))));
    assert!(has_block(&agent, |block| matches!(block, ContentBlock::ToolResult(_))));
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_agent_with_a_string_model_id() {
    require_credentials!();
    let mut agent = Agent::builder().model(SONNET_4_6).printer(false).build().unwrap();
    let result = agent.invoke("Say hello").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().role, Role::Assistant);
    assert!(!result.last_message().text().is_empty());
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_agent_sliding_window_conversation_manager() {
    require_credentials!();
    let manager = SlidingWindowConversationManager::new(SlidingWindowConversationManagerConfig {
        window_size: Some(4),
        ..SlidingWindowConversationManagerConfig::default()
    })
    .unwrap();
    let mut agent = Agent::builder()
        .model(model(NOVA_LITE, 100))
        .conversation_manager(Arc::new(manager))
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("Count from 1 to 1.").await.unwrap();
    assert_eq!(agent.messages().len(), 2);
    agent.invoke("Count from 2 to 2.").await.unwrap();
    assert_eq!(agent.messages().len(), 4);
    agent.invoke("Count from 3 to 3.").await.unwrap();
    assert_eq!(agent.messages().len(), 4);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_agent_thinking_with_tool_use() {
    require_credentials!();
    let test_tool = FunctionTool::builder("testTool", "Test description")
        .input_schema(json!({"type": "object"}))
        .callback(|_input, _ctx| async move { Ok(json!("result")) });
    let model = BedrockModel::new(BedrockModelConfig {
        model_id: Some(SONNET_4_6.to_owned()),
        max_tokens: Some(2048),
        additional_request_fields: Some(json!({"thinking": {"type": "enabled", "budget_tokens": 1024}})),
        ..BedrockModelConfig::default()
    });
    let mut agent = Agent::builder()
        .model(model)
        .tools([test_tool])
        .printer(false)
        .build()
        .unwrap();
    let result = agent
        .invoke("Use the testTool with the message \"Hello World\"")
        .await
        .unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().role, Role::Assistant);
    assert!(!result.last_message().content.is_empty());
    assert!(has_block(&agent, |block| matches!(block, ContentBlock::ToolUse(_))));
    assert!(has_block(&agent, |block| matches!(block, ContentBlock::ToolResult(_))));
    assert!(has_block(&agent, |block| matches!(block, ContentBlock::Reasoning(_))));
}
