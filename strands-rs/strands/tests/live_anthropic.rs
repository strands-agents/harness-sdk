//! Live tests of `AnthropicModel` against the Anthropic API, at the model level and through an
//! [`Agent`]. Ignored by default; they skip when `ANTHROPIC_API_KEY` is unset.
//!
//! ```text
//! cargo test -p strands --features anthropic --test live_anthropic -- --ignored
//! ```

#![cfg(feature = "anthropic")]
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "live tests report failures by panicking"
)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use futures::StreamExt;
use serde_json::json;
use strands::hooks::BeforeModelCallEvent;
use strands::models::anthropic::{AnthropicClientConfig, AnthropicModel, AnthropicModelOptions};
use strands::models::streaming::ContentBlockDelta;
use strands::models::{
    AggregatedEvent, CacheConfig, CacheStrategy, CountTokensOptions, Model, ModelRequest, StreamAggregatedResult,
    SummarizeOptions,
};
use strands::tools::FunctionTool;
use strands::types::InjectedBlock;
use strands::{
    Agent, CachePointBlock, ContentBlock, Error, ImageBlock, ImageFormat, ImageSource, Message, ModelStreamEvent, Role,
    StopReason, SystemContentBlock, SystemPrompt, ToolChoice, ToolResultBlock, ToolResultContent, ToolSpec, Usage,
};

/// The small model the live tests use.
const MODEL_ID: &str = "claude-haiku-4-5";

fn has_key() -> bool {
    let present = std::env::var("ANTHROPIC_API_KEY").is_ok_and(|key| !key.is_empty());
    if !present {
        eprintln!("skipping: ANTHROPIC_API_KEY is not set");
    }
    present
}

fn options() -> AnthropicModelOptions {
    AnthropicModelOptions {
        model_id: Some(MODEL_ID.to_owned()),
        max_tokens: Some(256),
        ..Default::default()
    }
}

fn provider(options: AnthropicModelOptions) -> AnthropicModel {
    AnthropicModel::new(options).unwrap()
}

async fn aggregate(
    model: &AnthropicModel,
    request: ModelRequest,
) -> strands::Result<(Vec<AggregatedEvent>, StreamAggregatedResult)> {
    let mut items = Vec::new();
    let mut stream = model.stream_aggregated(request);
    while let Some(item) = stream.next().await {
        match item? {
            AggregatedEvent::Done(result) => return Ok((items, result)),
            item => items.push(item),
        }
    }
    panic!("stream ended without a result")
}

fn weather_tool() -> ToolSpec {
    ToolSpec::new("get_weather", "Get the current weather for a city.").with_input_schema(json!({
        "type": "object",
        "properties": {"city": {"type": "string", "description": "The city name"}},
        "required": ["city"]
    }))
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_plain_text() {
    if !has_key() {
        return;
    }
    let request = ModelRequest::builder()
        .messages(vec![Message::user("Reply with exactly the word: pong")])
        .build();

    let (_, result) = aggregate(&provider(options()), request).await.unwrap();

    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert!(
        result.message.text().to_lowercase().contains("pong"),
        "{}",
        result.message.text()
    );
    let usage = result.metadata.unwrap().usage.unwrap();
    assert!(usage.input_tokens > 0 && usage.output_tokens > 0, "{usage:?}");
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_streaming_text_deltas() {
    if !has_key() {
        return;
    }
    let request = ModelRequest::builder()
        .messages(vec![Message::user("Count from 1 to 20, separated by spaces.")])
        .build();

    let mut stream = provider(options()).stream(request);
    let mut deltas = Vec::new();
    while let Some(event) = stream.next().await {
        if let ModelStreamEvent::ContentBlockDelta(delta) = event.unwrap()
            && let ContentBlockDelta::Text(text) = delta.delta
        {
            deltas.push(text.text);
        }
    }

    assert!(deltas.len() > 1, "{deltas:?}");
    assert!(deltas.concat().contains("20"));
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_tool_call_round_trip() {
    if !has_key() {
        return;
    }
    let model = provider(options());
    let mut messages = vec![Message::user("What is the weather in Paris? Use the tool.")];
    let request = |messages: &[Message]| {
        ModelRequest::builder()
            .messages(messages.to_vec())
            .tool_specs(vec![weather_tool()])
            .build()
    };

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
    assert_eq!(tool_use.name, "get_weather");
    assert!(tool_use.input["city"].as_str().unwrap().contains("Paris"));

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

fn person_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
        "required": ["name", "age"],
        "additionalProperties": false
    })
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_structured_output_forced_tool() {
    if !has_key() {
        return;
    }
    let request = ModelRequest {
        messages: vec![Message::user("Ada Lovelace was 36. Record the person.")],
        tool_specs: vec![ToolSpec::new("strands_structured_output", "Output").with_input_schema(person_schema())],
        tool_choice: Some(ToolChoice::tool("strands_structured_output")),
        structured_output_schema: Some(person_schema()),
        ..Default::default()
    };

    let (_, result) = aggregate(&provider(options()), request).await.unwrap();

    let input = result
        .message
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some(tool_use.input.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(input["age"], 36);
    assert!(input["name"].as_str().unwrap().contains("Ada"));
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_structured_output_native() {
    if !has_key() {
        return;
    }
    let request = ModelRequest {
        messages: vec![Message::user("Ada Lovelace was 36. Record the person.")],
        tool_specs: vec![ToolSpec::new("strands_structured_output", "Output").with_input_schema(person_schema())],
        tool_choice: Some(ToolChoice::Auto),
        structured_output_schema: Some(person_schema()),
        ..Default::default()
    };

    let (_, result) = aggregate(&provider(options()), request).await.unwrap();

    let value: serde_json::Value = serde_json::from_str(result.message.text().trim()).unwrap();
    assert_eq!(value["age"], 36);
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_thinking() {
    if !has_key() {
        return;
    }
    let options = AnthropicModelOptions {
        max_tokens: Some(2048),
        params: Some(json!({"thinking": {"type": "enabled", "budget_tokens": 1024}})),
        ..options()
    };
    let request = ModelRequest::builder()
        .messages(vec![Message::user("What is 17 * 23? Answer with the number.")])
        .build();

    let (_, result) = aggregate(&provider(options), request).await.unwrap();

    let reasoning = result.message.content.iter().find_map(|block| match block {
        ContentBlock::Reasoning(reasoning) => Some(reasoning.clone()),
        _ => None,
    });
    let reasoning = reasoning.unwrap();
    assert!(reasoning.signature.is_some());
    assert!(result.message.text().contains("391"), "{}", result.message.text());
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_web_search_citations() {
    if !has_key() {
        return;
    }
    let options = AnthropicModelOptions {
        max_tokens: Some(1024),
        anthropic_tools: Some(vec![
            json!({"type": "web_search_20260318", "name": "web_search", "max_uses": 1, "allowed_callers": ["direct"]}),
        ]),
        ..options()
    };
    let request = ModelRequest::builder()
        .messages(vec![Message::user(
            "Search the web for the Strands Agents SDK and say in one sentence what it is.",
        )])
        .build();

    let (_, result) = aggregate(&provider(options), request).await.unwrap();

    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert!(
        result
            .message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Citations(_))),
        "{:?}",
        result.message.content
    );
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_native_count_tokens() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        use_native_token_count: Some(true),
        ..options()
    });

    let count = model
        .count_tokens(
            &[Message::user("Hello, how are you today?")],
            CountTokensOptions::default(),
        )
        .await
        .unwrap();

    assert!((5..100).contains(&count), "{count}");
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_sampling_params_on_the_previous_api_version() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        temperature: Some(0.2),
        client_config: Some(AnthropicClientConfig {
            default_headers: vec![("anthropic-version".to_owned(), "2023-06-01".to_owned())],
            ..Default::default()
        }),
        ..options()
    });
    let request = ModelRequest::builder().messages(vec![Message::user("Say hi.")]).build();

    let (_, result) = aggregate(&model, request).await.unwrap();

    assert_eq!(result.stop_reason, StopReason::EndTurn);
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_error_mapping_for_an_unknown_model() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        model_id: Some("claude-does-not-exist".to_owned()),
        ..options()
    });
    let request = ModelRequest::builder().messages(vec![Message::user("Hi")]).build();

    let error = aggregate(&model, request).await.unwrap_err();

    assert!(matches!(error, Error::Model(_)), "{error:?}");
    assert!(error.to_string().starts_with("404 "), "{error}");
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_server_side_summary() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        model_id: Some("claude-haiku-5-5".to_owned()),
        max_tokens: Some(1024),
        ..options()
    });
    let messages = vec![
        Message::user("My name is Ada and my project id is PRJ-4471. Remember both."),
        Message::assistant("Noted: your name is Ada and your project id is PRJ-4471."),
        Message::user("Thanks."),
    ];

    let result = model.summarize(messages, SummarizeOptions::default()).await.unwrap();

    let Some(ContentBlock::Summary(summary)) = result.content.first() else {
        panic!("no summary: {result:?}");
    };
    assert_eq!(summary.provider.as_deref(), Some("anthropic"), "{summary:?}");
    assert!(summary.text.contains("PRJ-4471"), "{}", summary.text);
}

/// A 16x16 yellow PNG.
const YELLOW_PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4f52BJMQwqmFUw/DVAADcQNYQAY29EwAAAABJRU5ErkJggg==";

/// A per-run marker, so the first request of a cache test always writes the cache.
fn nonce() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos:x}")
}

/// The usage a raw stream reports; a reply cut at `max_tokens` still counts.
async fn stream_usage(model: &AnthropicModel, request: ModelRequest) -> Usage {
    let mut stream = Model::stream(model, request);
    let mut usage = None;
    while let Some(event) = stream.next().await {
        if let ModelStreamEvent::Metadata(metadata) = event.unwrap() {
            usage = metadata.usage.or(usage);
        }
    }
    usage.unwrap()
}

/// Cache tests run on the default model, whose minimum cacheable prefix the prompts pass.
fn caching_options() -> AnthropicModelOptions {
    AnthropicModelOptions {
        model_id: None,
        max_tokens: Some(100),
        ..options()
    }
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

fn agent_messages_have(agent: &Agent, matches: impl Fn(&ContentBlock) -> bool) -> bool {
    agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .any(matches)
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_respects_max_tokens() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        max_tokens: Some(20),
        ..options()
    });
    let request = ModelRequest::builder()
        .messages(vec![Message::user("Write a very long story about space exploration.")])
        .build();
    let mut events = Vec::new();
    let mut stream = Model::stream(&model, request);
    while let Some(event) = stream.next().await {
        events.push(event.unwrap());
    }
    let output_tokens = events.iter().find_map(|event| match event {
        ModelStreamEvent::Metadata(metadata) => metadata.usage.as_ref().map(|usage| usage.output_tokens),
        _ => None,
    });
    assert!(output_tokens.unwrap() <= 20, "{output_tokens:?}");
    assert!(events.iter().any(
        |event| matches!(event, ModelStreamEvent::MessageStop(stop) if stop.stop_reason == StopReason::MaxTokens)
    ));
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_prompt_cache_reads_the_system_prompt_on_the_second_request() {
    if !has_key() {
        return;
    }
    let model = provider(caching_options());
    let context = format!("Context information: {} [{}]", "repeat ".repeat(5000), nonce());
    let system = SystemPrompt::Blocks(vec![
        SystemContentBlock::text("You are a helpful assistant."),
        SystemContentBlock::text(context),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
    ]);
    let request = |text: &str| {
        ModelRequest::builder()
            .messages(vec![Message::user(text)])
            .system_prompt(system.clone())
            .build()
    };

    let first = stream_usage(&model, request("Hello")).await;
    let second = stream_usage(&model, request("Hi again")).await;

    assert!(first.cache_write_input_tokens.unwrap_or_default() > 0, "{first:?}");
    assert!(second.cache_read_input_tokens.unwrap_or_default() > 0, "{second:?}");
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_prompt_cache_reads_message_cache_points_on_the_second_request() {
    if !has_key() {
        return;
    }
    let model = provider(caching_options());
    let context = format!("Context information: {} [{}]", "repeat ".repeat(5000), nonce());
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

    let first = stream_usage(&model, request("Question 1")).await;
    let second = stream_usage(&model, request("Question 2")).await;

    assert!(first.cache_write_input_tokens.unwrap_or_default() > 0, "{first:?}");
    assert!(second.cache_read_input_tokens.unwrap_or_default() > 0, "{second:?}");
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_cache_config_auto_placement_reads_on_the_second_turn() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        cache_config: Some(CacheConfig {
            strategy: Some(CacheStrategy::Auto),
            ..CacheConfig::default()
        }),
        ..caching_options()
    });
    let prefix = format!(
        "Dossier {}. {}",
        nonce(),
        "The subject prefers concise answers. ".repeat(400)
    );
    let request = || {
        ModelRequest::builder()
            .messages(vec![Message::user(prefix.clone())])
            .build()
    };

    let first = stream_usage(&model, request()).await;
    let second = stream_usage(&model, request()).await;

    assert!(first.cache_write_input_tokens.unwrap_or_default() > 0, "{first:?}");
    assert!(second.cache_read_input_tokens.unwrap_or_default() > 0, "{second:?}");
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_image_input() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        max_tokens: Some(100),
        ..options()
    });
    let bytes = base64::engine::general_purpose::STANDARD.decode(YELLOW_PNG).unwrap();
    let content = vec![
        ContentBlock::Image(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(bytes))),
        ContentBlock::text("What color is this image? Reply with just the color name."),
    ];
    let request = ModelRequest::builder()
        .messages(vec![Message::new(Role::User, content)])
        .build();

    let (_, result) = aggregate(&model, request).await.unwrap();

    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert!(
        result.message.text().to_lowercase().contains("yellow"),
        "{}",
        result.message.text()
    );
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_count_tokens_grows_with_tools_and_system_prompt() {
    if !has_key() {
        return;
    }
    let model = provider(AnthropicModelOptions {
        use_native_token_count: Some(true),
        ..options()
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

    assert!(without > 0);
    assert!(with_tools > without, "{with_tools} <= {without}");
}

#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_agent_tool_round_trip() {
    if !has_key() {
        return;
    }
    let mut agent = Agent::builder()
        .model(provider(options()))
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
    assert!(agent_messages_have(&agent, |block| matches!(
        block,
        ContentBlock::ToolUse(_)
    )));
    assert!(agent_messages_have(&agent, |block| matches!(
        block,
        ContentBlock::ToolResult(_)
    )));
}

/// A `BeforeModelCall` hook writes an `InjectedBlock` into the latest user message once, so
/// history before a replayed thinking block never changes.
#[tokio::test]
#[ignore = "calls the Anthropic API"]
async fn live_agent_preserved_thinking_with_injected_text() {
    if !has_key() {
        return;
    }
    let lookup = FunctionTool::builder("lookup_inventory", "Look up how many units of an item are in stock.")
        .input_schema(json!({
            "type": "object",
            "properties": {"item": {"type": "string"}},
            "required": ["item"]
        }))
        .callback(|input, _ctx| async move {
            let count = match input["item"].as_str() {
                Some("widgets") => "17",
                Some("gadgets") => "4",
                _ => "0",
            };
            Ok(json!(count))
        });
    let model = provider(AnthropicModelOptions {
        model_id: Some("claude-opus-5-5".to_owned()),
        max_tokens: Some(4096),
        betas: Some(vec!["thinking-binding-controls-2026-08-01".to_owned()]),
        params: Some(json!({"thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "error"}}})),
        cache_config: Some(CacheConfig {
            strategy: Some(CacheStrategy::Anthropic),
            ..CacheConfig::default()
        }),
        ..options()
    });
    let system_prompt = format!(
        "You are an inventory assistant {}.\n{}",
        nonce(),
        "Report stock counts exactly as the tool returns them. ".repeat(400)
    );
    let mut agent = Agent::builder()
        .model(model)
        .tools([lookup])
        .system_prompt(system_prompt)
        .printer(false)
        .build()
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        let messages = event.agent_mut().messages_mut();
        let Some(latest) = messages.last_mut().filter(|message| message.role == Role::User) else {
            return;
        };
        if latest
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Injected(_)))
        {
            return;
        }
        let call = counter.fetch_add(1, Ordering::SeqCst) + 1;
        latest.content.push(ContentBlock::Injected(InjectedBlock::new(
            format!("<call>{call}</call>"),
            "live-test",
        )));
    });

    agent
        .invoke("Look up widgets, then gadgets, one at a time, and say which has more stock.")
        .await
        .unwrap();
    let result = agent
        .invoke("Look up widgets again and confirm the count.")
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(calls.load(Ordering::SeqCst) >= 4, "{}", calls.load(Ordering::SeqCst));
    let usage = agent
        .messages()
        .iter()
        .rev()
        .find(|message| message.role == Role::Assistant)
        .and_then(|message| message.metadata.as_ref())
        .and_then(|metadata| metadata.usage);
    assert!(
        usage
            .as_ref()
            .and_then(|usage| usage.cache_read_input_tokens)
            .unwrap_or_default()
            > 0,
        "{usage:?}"
    );
}
