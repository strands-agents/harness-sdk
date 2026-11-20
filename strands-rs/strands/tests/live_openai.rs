//! Live tests of `OpenAIModel` against the OpenAI API, on the Responses API and Chat Completions,
//! at the model level and through an [`Agent`]. Ignored by default; they skip when
//! `OPENAI_API_KEY` is unset.
//!
//! ```text
//! cargo test -p strands --features openai --test live_openai -- --ignored
//! ```

#![cfg(feature = "openai")]
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "live tests report failures by panicking"
)]

use futures::StreamExt;
use serde_json::json;
use strands::models::openai::{OpenAIApi, OpenAIModel, OpenAIModelOptions};
use strands::models::streaming::ContentBlockDelta;
use strands::models::{AggregatedEvent, CacheConfig, Model, ModelRequest, StreamAggregatedResult};
use strands::storage::InMemoryStorage;
use strands::tools::FunctionTool;
use strands::{
    Agent, ContentBlock, Error, Message, ModelStreamEvent, Role, SessionManager, StateStore, StopReason, ToolChoice,
    ToolResultBlock, ToolResultContent, ToolSpec,
};

/// The small model the live tests use.
const MODEL_ID: &str = "gpt-5.4-mini";

fn has_key() -> bool {
    let present = std::env::var("OPENAI_API_KEY").is_ok_and(|key| !key.is_empty());
    if !present {
        eprintln!("skipping: OPENAI_API_KEY is not set");
    }
    present
}

fn options(api: OpenAIApi) -> OpenAIModelOptions {
    OpenAIModelOptions {
        api,
        model_id: Some(MODEL_ID.to_owned()),
        max_tokens: Some(256),
        ..Default::default()
    }
}

fn provider(options: OpenAIModelOptions) -> OpenAIModel {
    OpenAIModel::new(options).unwrap()
}

async fn aggregate(
    model: &OpenAIModel,
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

async fn events(model: &OpenAIModel, request: ModelRequest) -> Vec<ModelStreamEvent> {
    let mut stream = model.stream(request);
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event.unwrap());
    }
    events
}

fn ask(text: &str) -> ModelRequest {
    ModelRequest::builder().messages(vec![Message::user(text)]).build()
}

fn weather_tool() -> ToolSpec {
    ToolSpec::new("get_weather", "Get the current weather for a city.").with_input_schema(json!({
        "type": "object",
        "properties": {"city": {"type": "string", "description": "The city name"}},
        "required": ["city"]
    }))
}

async fn plain_text(api: OpenAIApi) {
    let (_, result) = aggregate(&provider(options(api)), ask("Reply with exactly the word: pong"))
        .await
        .unwrap();
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
#[ignore = "calls the OpenAI API"]
async fn live_responses_plain_text() {
    if !has_key() {
        return;
    }
    plain_text(OpenAIApi::Responses).await;
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_chat_plain_text() {
    if !has_key() {
        return;
    }
    plain_text(OpenAIApi::Chat).await;
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_streaming_text_deltas_with_the_block_lifecycle() {
    if !has_key() {
        return;
    }
    for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
        let events = events(&provider(options(api)), ask("Count from 1 to 20, separated by spaces.")).await;
        let deltas: Vec<String> = events
            .iter()
            .filter_map(|event| match event {
                ModelStreamEvent::ContentBlockDelta(delta) => match &delta.delta {
                    ContentBlockDelta::Text(text) => Some(text.text.clone()),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert!(deltas.len() > 1, "{api}: {deltas:?}");
        assert!(deltas.concat().contains("20"), "{api}");
        let position = |wanted: fn(&ModelStreamEvent) -> bool| events.iter().position(wanted).unwrap();
        let start = position(|event| matches!(event, ModelStreamEvent::ContentBlockStart(_)));
        let first_delta = position(|event| matches!(event, ModelStreamEvent::ContentBlockDelta(_)));
        let stop = position(|event| matches!(event, ModelStreamEvent::ContentBlockStop(_)));
        assert!(start < first_delta && first_delta < stop, "{api}");
    }
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_max_tokens_stop_reason() {
    if !has_key() {
        return;
    }
    for (api, max_tokens) in [(OpenAIApi::Responses, 20), (OpenAIApi::Chat, 10)] {
        let model = provider(OpenAIModelOptions {
            max_tokens: Some(max_tokens),
            ..options(api)
        });
        let events = events(&model, ask("Write a very long story about dragons.")).await;
        let Some(stop) = events.iter().find_map(|event| match event {
            ModelStreamEvent::MessageStop(stop) => Some(stop),
            _ => None,
        }) else {
            panic!("{api}: no stop event");
        };
        assert_eq!(stop.stop_reason, StopReason::MaxTokens, "{api}");
    }
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_tool_call_round_trip() {
    if !has_key() {
        return;
    }
    for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
        let model = provider(options(api));
        let mut messages = vec![Message::user("What is the weather in Paris? Use the tool.")];
        let request = |messages: &[Message]| {
            ModelRequest::builder()
                .messages(messages.to_vec())
                .tool_specs(vec![weather_tool()])
                .build()
        };

        let (_, first) = aggregate(&model, request(&messages)).await.unwrap();
        assert_eq!(first.stop_reason, StopReason::ToolUse, "{api}");
        let tool_use = first
            .message
            .content
            .iter()
            .find_map(|block| match block {
                ContentBlock::ToolUse(tool_use) => Some(tool_use.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(tool_use.name, "get_weather", "{api}");
        assert!(tool_use.input["city"].as_str().unwrap().contains("Paris"), "{api}");

        messages.push(first.message);
        let result = ToolResultBlock::success(
            tool_use.tool_use_id,
            vec![ToolResultContent::text("Sunny, 24 degrees Celsius")],
        );
        messages.push(Message::new(Role::User, vec![result.into()]));
        let (_, second) = aggregate(&model, request(&messages)).await.unwrap();

        assert_eq!(second.stop_reason, StopReason::EndTurn, "{api}");
        assert!(second.message.text().contains("24"), "{api}: {}", second.message.text());
    }
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_structured_output_forced_tool() {
    if !has_key() {
        return;
    }
    let schema = json!({
        "type": "object",
        "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
        "required": ["name", "age"],
        "additionalProperties": false
    });
    for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
        let request = ModelRequest {
            messages: vec![Message::user("Ada Lovelace was 36. Record the person.")],
            tool_specs: vec![ToolSpec::new("strands_structured_output", "Output").with_input_schema(schema.clone())],
            tool_choice: Some(ToolChoice::tool("strands_structured_output")),
            structured_output_schema: Some(schema.clone()),
            ..Default::default()
        };
        let (_, result) = aggregate(&provider(options(api)), request).await.unwrap();
        let input = result
            .message
            .content
            .iter()
            .find_map(|block| match block {
                ContentBlock::ToolUse(tool_use) => Some(tool_use.input.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(input["age"], 36, "{api}");
        assert!(input["name"].as_str().unwrap().contains("Ada"), "{api}");
    }
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_stateful_conversation() {
    if !has_key() {
        return;
    }
    let model = provider(OpenAIModelOptions {
        stateful: Some(true),
        ..options(OpenAIApi::Responses)
    });
    assert!(model.stateful());
    let model_state = StateStore::new();
    let turn = |text: &str| {
        ModelRequest::builder()
            .messages(vec![Message::user(text)])
            .system_prompt("Reply in one short sentence.")
            .model_state(model_state.clone())
            .build()
    };

    aggregate(&model, turn("My name is Alice.")).await.unwrap();
    let response_id = model_state.get_value("responseId").unwrap();
    assert!(response_id.as_str().unwrap().starts_with("resp"), "{response_id}");
    let (_, second) = aggregate(&model, turn("What is my name?")).await.unwrap();

    assert!(
        second.message.text().to_lowercase().contains("alice"),
        "{}",
        second.message.text()
    );
    assert_ne!(model_state.get_value("responseId").unwrap(), response_id);
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_web_search_citations_in_their_own_blocks() {
    if !has_key() {
        return;
    }
    let model = provider(OpenAIModelOptions {
        model_id: Some("gpt-4o".to_owned()),
        max_tokens: Some(4096),
        params: Some(json!({"tools": [{"type": "web_search"}]})),
        ..options(OpenAIApi::Responses)
    });
    let request = ask("Search the web and tell me in two sentences what Strands Agents is. Cite your sources.");

    let (items, result) = aggregate(&model, request).await.unwrap();

    assert!(
        result
            .message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Citations(_))),
        "{:?}",
        result.message.content
    );
    let raw: Vec<&ModelStreamEvent> = items
        .iter()
        .filter_map(|item| match item {
            AggregatedEvent::ModelStreamEvent(event) => Some(event),
            _ => None,
        })
        .collect();
    let mut last_start = None;
    let mut last_text = None;
    for (index, event) in raw.iter().enumerate() {
        match event {
            ModelStreamEvent::ContentBlockStart(_) => last_start = Some(index),
            ModelStreamEvent::ContentBlockDelta(delta) => match &delta.delta {
                ContentBlockDelta::Text(_) => last_text = Some(index),
                ContentBlockDelta::Citations(_) => {
                    if let Some(text) = last_text {
                        assert!(last_start.unwrap() > text, "a citation shares a block with text");
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_error_mapping_for_an_unknown_model() {
    if !has_key() {
        return;
    }
    for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
        let model = provider(OpenAIModelOptions {
            model_id: Some("invalid-model-id-that-does-not-exist-xyz".to_owned()),
            ..options(api)
        });

        let error = aggregate(&model, ask("Hello")).await.unwrap_err();

        assert!(matches!(error, Error::Model(_)), "{api}: {error:?}");
        assert!(
            error.to_string().starts_with("400 ") || error.to_string().starts_with("404 "),
            "{api}: {error}"
        );
    }
}

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_respects_temperature() {
    if !has_key() {
        return;
    }
    for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
        let model = provider(OpenAIModelOptions {
            temperature: Some(0.0),
            max_tokens: Some(50),
            ..options(api)
        });
        let (_, result) = aggregate(&model, ask("Say \"hello world\" exactly.")).await.unwrap();
        assert!(
            result.message.text().to_lowercase().contains("hello"),
            "{api}: {}",
            result.message.text()
        );
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

#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_agent_round_trip_with_a_function_tool() {
    if !has_key() {
        return;
    }
    for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
        let mut agent = Agent::builder()
            .model(provider(options(api)))
            .tools([weather_function_tool()])
            .printer(false)
            .build()
            .unwrap();
        let result = agent
            .invoke("What is the weather in Paris? Use the tool.")
            .await
            .unwrap();
        assert_eq!(result.stop_reason(), StopReason::EndTurn, "{api}");
        assert!(
            result.last_message().text().contains("24"),
            "{api}: {}",
            result.last_message().text()
        );
        let blocks: Vec<&ContentBlock> = agent.messages().iter().flat_map(|message| &message.content).collect();
        assert!(
            blocks.iter().any(|block| matches!(block, ContentBlock::ToolUse(_))),
            "{api}"
        );
        assert!(
            blocks.iter().any(|block| matches!(block, ContentBlock::ToolResult(_))),
            "{api}"
        );
    }
}

/// An agent with an explicit `cache_key` reads the cache on its second turn.
#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_agent_explicit_cache_key_reads_on_the_second_turn() {
    if !has_key() {
        return;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let prefix = "You answer arithmetic questions with only the number and never add commentary. ".repeat(200);
    for api in [OpenAIApi::Chat, OpenAIApi::Responses] {
        let model = provider(OpenAIModelOptions {
            model_id: Some("gpt-4o-mini".to_owned()),
            cache_config: Some(
                CacheConfig::builder()
                    .cache_key(format!("strands-live-{nanos:x}").as_str())
                    .build(),
            ),
            ..options(api)
        });
        let mut agent = Agent::builder()
            .model(model)
            .system_prompt(format!("Session {nanos:x}-{api}. {prefix}"))
            .printer(false)
            .build()
            .unwrap();
        agent.invoke("What is 2+2? Answer with just the number.").await.unwrap();
        let result = agent.invoke("What is 3+3? Answer with just the number.").await.unwrap();
        let read = result
            .metrics()
            .and_then(|metrics| metrics.accumulated_usage.cache_read_input_tokens)
            .unwrap_or_default();
        assert!(
            read > 0,
            "{api}: {:?}",
            result.metrics().map(|metrics| &metrics.accumulated_usage)
        );
    }
}

fn cache_read(result: &strands::AgentResult) -> u64 {
    result
        .metrics()
        .and_then(|metrics| metrics.accumulated_usage.cache_read_input_tokens)
        .unwrap_or_default()
}

fn session_cached_model(api: OpenAIApi) -> OpenAIModel {
    provider(OpenAIModelOptions {
        model_id: Some("gpt-4o-mini".to_owned()),
        cache_config: Some(CacheConfig::default()),
        ..options(api)
    })
}

fn session_agent(
    api: OpenAIApi,
    session_id: &str,
    storage: &std::sync::Arc<InMemoryStorage>,
    system_prompt: &str,
) -> Agent {
    let session_manager = SessionManager::builder()
        .session_id(session_id)
        .storage(storage.clone())
        .build()
        .unwrap();
    Agent::builder()
        .model(session_cached_model(api))
        .system_prompt(system_prompt)
        .session_manager(session_manager)
        .printer(false)
        .build()
        .unwrap()
}

fn run_nonce() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos:x}")
}

/// With `cache_config` set and a session manager attached, the requests carry
/// `strands-<sessionId>` and the second turn reads the cache.
#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_agent_session_derived_cache_key_reads_on_the_second_turn() {
    if !has_key() {
        return;
    }
    let prefix = "You answer arithmetic questions with only the number and never add commentary. ".repeat(200);
    for api in [OpenAIApi::Chat, OpenAIApi::Responses] {
        let storage = std::sync::Arc::new(InMemoryStorage::new());
        let system_prompt = format!("Session {}-{api}. {prefix}", run_nonce());
        let mut agent = session_agent(api, "integ-openai-session-cache", &storage, &system_prompt);
        agent.invoke("What is 2+2? Answer with just the number.").await.unwrap();
        let result = agent.invoke("What is 3+3? Answer with just the number.").await.unwrap();
        assert!(
            cache_read(&result) > 0,
            "{api}: {:?}",
            result.metrics().map(|metrics| &metrics.accumulated_usage)
        );
    }
}

/// A rebuilt agent restored from the same storage reuses `strands-<sessionId>` and reads the cache
/// on its next turn.
#[tokio::test]
#[ignore = "calls the OpenAI API"]
async fn live_agent_restored_session_reuses_the_derived_cache_key() {
    if !has_key() {
        return;
    }
    let prefix = "You answer arithmetic questions with only the number and never add commentary. ".repeat(200);
    for api in [OpenAIApi::Chat, OpenAIApi::Responses] {
        let storage = std::sync::Arc::new(InMemoryStorage::new());
        let system_prompt = format!("Restore {}-{api}. {prefix}", run_nonce());
        let mut before = session_agent(api, "integ-openai-session-restore", &storage, &system_prompt);
        before
            .invoke("What is 2+2? Answer with just the number.")
            .await
            .unwrap();
        before
            .invoke("What is 3+3? Answer with just the number.")
            .await
            .unwrap();

        let mut after = session_agent(api, "integ-openai-session-restore", &storage, &system_prompt);
        after.initialize().await.unwrap();
        assert!(
            !after.messages().is_empty(),
            "{api}: the session manager restored the turns"
        );
        let result = after.invoke("What is 5+5? Answer with just the number.").await.unwrap();
        assert!(
            cache_read(&result) > 0,
            "{api}: {:?}",
            result.metrics().map(|metrics| &metrics.accumulated_usage)
        );
    }
}
