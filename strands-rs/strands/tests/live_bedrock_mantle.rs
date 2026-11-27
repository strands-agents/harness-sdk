//! Live tests of `OpenAIModel` through Amazon Bedrock's OpenAI-compatible Mantle endpoint. Ignored
//! by default; they skip when the default AWS credential chain has no credentials. They only
//! invoke models.
//!
//! ```text
//! cargo test -p strands --no-default-features --features mantle --test live_bedrock_mantle -- --ignored
//! ```

#![cfg(feature = "mantle")]
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "live tests report failures by panicking"
)]

use aws_credential_types::provider::ProvideCredentials;
use futures::StreamExt;
use serde_json::json;
use strands::models::openai::{BedrockMantleConfig, OpenAIApi, OpenAIModel, OpenAIModelConfig, OpenAIModelOptions};
use strands::models::{AggregatedEvent, ModelRequest, StreamAggregatedResult};
use strands::tools::FunctionTool;
use strands::{
    Agent, ContentBlock, Message, Role, StateStore, StopReason, ToolResultBlock, ToolResultContent, ToolSpec,
};

/// The region and model the live tests use.
const REGION: &str = "us-east-1";
const MODEL_ID: &str = "openai.gpt-oss-120b";

async fn has_credentials() -> bool {
    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_config::Region::new(REGION))
        .load()
        .await;
    let present = match config.credentials_provider() {
        Some(provider) => provider.provide_credentials().await.is_ok(),
        None => false,
    };
    if !present {
        eprintln!("skipping: no AWS credentials in the default chain");
    }
    present
}

fn options(api: OpenAIApi) -> OpenAIModelOptions {
    OpenAIModelOptions {
        api,
        model_id: Some(MODEL_ID.to_owned()),
        ..Default::default()
    }
}

fn mantle_model(options: OpenAIModelOptions) -> strands::Result<OpenAIModel> {
    OpenAIModel::bedrock_mantle(options, BedrockMantleConfig::builder().region(REGION).build())
}

async fn aggregate(
    model: &OpenAIModel,
    request: ModelRequest,
) -> strands::Result<(Vec<AggregatedEvent>, StreamAggregatedResult)> {
    let mut items = Vec::new();
    let mut stream = strands::models::Model::stream_aggregated(model, request);
    while let Some(item) = stream.next().await {
        match item? {
            AggregatedEvent::Done(result) => return Ok((items, result)),
            item => items.push(item),
        }
    }
    panic!("stream ended without a result")
}

fn turn(messages: Vec<Message>, model_state: &StateStore) -> ModelRequest {
    ModelRequest::builder()
        .messages(messages)
        .system_prompt("Reply in one short sentence.")
        .model_state(model_state.clone())
        .build()
}

async fn two_plus_two(api: OpenAIApi) {
    let model = mantle_model(options(api)).unwrap();
    let (_, result) = aggregate(&model, turn(vec![Message::user("What is 2+2?")], &StateStore::new()))
        .await
        .unwrap();
    assert_eq!(result.stop_reason, StopReason::EndTurn, "{api}");
    let text = result.message.text().to_lowercase();
    assert!(text.contains('4') || text.contains("four"), "{api}: {text}");
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock Mantle"]
async fn live_mantle_chat_completions() {
    if !has_credentials().await {
        return;
    }
    two_plus_two(OpenAIApi::Chat).await;
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock Mantle"]
async fn live_mantle_responses() {
    if !has_credentials().await {
        return;
    }
    two_plus_two(OpenAIApi::Responses).await;
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock Mantle"]
async fn live_mantle_stateful_conversation() {
    if !has_credentials().await {
        return;
    }
    let model = mantle_model(OpenAIModelOptions {
        stateful: Some(true),
        ..options(OpenAIApi::Responses)
    })
    .unwrap();
    let model_state = StateStore::new();

    aggregate(&model, turn(vec![Message::user("My name is Alice.")], &model_state))
        .await
        .unwrap();
    let (_, second) = aggregate(&model, turn(vec![Message::user("What is my name?")], &model_state))
        .await
        .unwrap();

    assert!(
        second.message.text().to_lowercase().contains("alice"),
        "{}",
        second.message.text()
    );
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock Mantle"]
async fn live_mantle_reasoning_across_turns() {
    if !has_credentials().await {
        return;
    }
    let model = mantle_model(OpenAIModelOptions {
        params: Some(json!({"reasoning": {"effort": "low"}})),
        ..options(OpenAIApi::Responses)
    })
    .unwrap();
    let mut messages = vec![Message::user("What is 2+2?")];

    let (_, first) = aggregate(&model, turn(messages.clone(), &StateStore::new()))
        .await
        .unwrap();
    assert!(first.message.text().contains('4'), "{}", first.message.text());
    messages.push(first.message);
    messages.push(Message::user("What about 3+3?"));
    let (_, second) = aggregate(&model, turn(messages, &StateStore::new())).await.unwrap();

    assert_eq!(second.stop_reason, StopReason::EndTurn);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock Mantle"]
async fn live_mantle_tool_call_round_trip() {
    if !has_credentials().await {
        return;
    }
    let model = mantle_model(options(OpenAIApi::Chat)).unwrap();
    let weather = ToolSpec::new("get_weather", "Get the current weather for a city.").with_input_schema(json!({
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
    }));
    let request = |messages: &[Message]| {
        ModelRequest::builder()
            .messages(messages.to_vec())
            .tool_specs(vec![weather.clone()])
            .build()
    };
    let mut messages = vec![Message::user("What is the weather in Paris? Use the tool.")];

    let (_, first) = aggregate(&model, request(&messages)).await.unwrap();
    assert_eq!(first.stop_reason, StopReason::ToolUse);
    let tool_use = first
        .message
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some(tool_use.clone()),
            _ => None,
        })
        .unwrap();
    messages.push(first.message);
    let result = ToolResultBlock::success(
        tool_use.tool_use_id,
        vec![ToolResultContent::text("Sunny, 24 degrees Celsius")],
    );
    messages.push(Message::new(Role::User, vec![result.into()]));
    let (_, second) = aggregate(&model, request(&messages)).await.unwrap();

    assert_eq!(second.stop_reason, StopReason::EndTurn);
    assert!(second.message.text().contains("24"), "{}", second.message.text());
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock Mantle"]
async fn live_mantle_agent_tool_round_trip() {
    if !has_credentials().await {
        return;
    }
    let weather = FunctionTool::builder("get_weather", "Get the current weather for a city.")
        .input_schema(json!({
            "type": "object",
            "properties": {"city": {"type": "string", "description": "The city name"}},
            "required": ["city"]
        }))
        .callback(|input, _ctx| async move { Ok(json!(format!("Sunny, 24 degrees Celsius in {}", input["city"]))) });
    let mut agent = Agent::builder()
        .model(mantle_model(options(OpenAIApi::Chat)).unwrap())
        .tools([weather])
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
    assert!(
        agent
            .messages()
            .iter()
            .flat_map(|message| &message.content)
            .any(|block| matches!(block, ContentBlock::ToolResult(_)))
    );
}

/// A fixed set of catalog models on both base paths (listing the live catalog needs
/// `bedrock-mantle:ListModels`; these tests only invoke models). A wrong base path fails
/// with HTTP 400. The last step moves one model to the other base path through `update_config`.
#[tokio::test]
#[ignore = "calls Amazon Bedrock Mantle"]
async fn live_mantle_routes_every_live_model_to_its_base_path() {
    if !has_credentials().await {
        return;
    }
    let models = ["openai.gpt-oss-120b", "openai.gpt-oss-20b", "google.gemma-4-31b"];
    for model_id in models {
        let model = mantle_model(OpenAIModelOptions {
            model_id: Some(model_id.to_owned()),
            max_tokens: Some(512),
            ..options(OpenAIApi::Chat)
        })
        .unwrap();
        let (_, result) = aggregate(&model, turn(vec![Message::user("Say hi.")], &StateStore::new()))
            .await
            .unwrap_or_else(|error| panic!("{model_id}: {error}"));
        assert!(!result.message.content.is_empty(), "{model_id}");
    }
    let model = mantle_model(OpenAIModelOptions {
        max_tokens: Some(512),
        ..options(OpenAIApi::Chat)
    })
    .unwrap();
    model
        .update_config(OpenAIModelConfig::builder().model_id("google.gemma-4-31b").build())
        .unwrap();
    let (_, result) = aggregate(&model, turn(vec![Message::user("Say hi.")], &StateStore::new()))
        .await
        .unwrap();
    assert!(!result.message.content.is_empty());
}
