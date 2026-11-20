//! Live tests of `AnthropicModel` on Amazon Bedrock's InvokeModel API. Ignored by default; they
//! skip when the default AWS credential chain has no credentials. They only invoke models.
//!
//! ```text
//! cargo test -p strands --features anthropic,bedrock --test live_anthropic_bedrock -- --ignored
//! ```

#![cfg(all(feature = "anthropic", feature = "bedrock"))]
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::print_stdout,
    reason = "live tests report failures by panicking and print skips"
)]

use aws_config::BehaviorVersion;
use aws_credential_types::provider::ProvideCredentials;
use futures::StreamExt;
use serde_json::json;
use strands::models::anthropic::{AnthropicBedrockConfig, AnthropicModel, AnthropicModelOptions};
use strands::models::{AggregatedEvent, Model, ModelRequest, StreamAggregatedResult};
use strands::{ContentBlock, Message, Role, StopReason, ToolResultBlock, ToolResultContent, ToolSpec};

const REGION: &str = "us-east-1";
const HAIKU: &str = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

async fn credentials_available() -> bool {
    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(REGION))
        .load()
        .await;
    let present = match config.credentials_provider() {
        Some(provider) => provider.provide_credentials().await.is_ok(),
        None => false,
    };
    if !present {
        println!("skipping: no AWS credentials in the default chain");
    }
    present
}

fn model(options: AnthropicModelOptions) -> AnthropicModel {
    AnthropicModel::bedrock(options, AnthropicBedrockConfig::builder().region(REGION).build()).unwrap()
}

fn options() -> AnthropicModelOptions {
    AnthropicModel::builder()
        .model_id(HAIKU)
        .max_tokens(1024)
        .build_options()
}

async fn aggregate(model: &AnthropicModel, request: ModelRequest) -> strands::Result<StreamAggregatedResult> {
    let mut stream = model.stream_aggregated(request);
    while let Some(item) = stream.next().await {
        if let AggregatedEvent::Done(result) = item? {
            return Ok(result);
        }
    }
    panic!("the stream ended without a result")
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_plain_text_with_a_sampling_param() {
    if !credentials_available().await {
        return;
    }
    let mut options = options();
    options.temperature = Some(0.2);
    let request = ModelRequest::builder()
        .messages(vec![Message::user("Reply with the single word: pong")])
        .build();

    let result = aggregate(&model(options), request).await.unwrap();

    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert!(
        result.message.text().to_lowercase().contains("pong"),
        "{}",
        result.message.text()
    );
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_tool_call_round_trip() {
    if !credentials_available().await {
        return;
    }
    let model = model(options());
    let weather = ToolSpec::new("get_weather", "Get the weather for a city").with_input_schema(json!({
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

    let first = aggregate(&model, request(&messages)).await.unwrap();
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
    let second = aggregate(&model, request(&messages)).await.unwrap();

    assert_eq!(second.stop_reason, StopReason::EndTurn);
    assert!(second.message.text().contains("24"), "{}", second.message.text());
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_an_unknown_model_fails_with_a_status_error() {
    if !credentials_available().await {
        return;
    }
    let mut options = options();
    options.model_id = Some("us.anthropic.claude-does-not-exist-v1:0".to_owned());
    let request = ModelRequest::builder().messages(vec![Message::user("Hi")]).build();

    let error = aggregate(&model(options), request).await.unwrap_err();

    assert!(
        error.to_string().starts_with("400 ") || error.to_string().starts_with("404 "),
        "{error}"
    );
}
