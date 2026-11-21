//! Chat Completions stream, request formatting and error tests.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::models::CacheKey;
use crate::models::http::HttpErrorKind;
use crate::types::StopReason;
use crate::types::{
    AgentMetadata, CachePointBlock, ContentBlock, DocumentBlock, DocumentFormat, DocumentSource, GuardContentBlock,
    GuardContentImage, GuardContentText, GuardImageFormat, GuardQualifier, ImageBlock, ImageFormat, ImageSource, Role,
    SystemContentBlock, ToolChoice, ToolResultBlock, ToolSpec, ToolUseBlock, UnknownBlock, VideoBlock, VideoFormat,
    VideoSource,
};
use crate::{ContextWindowOverflowError, ModelThrottledError};

fn role(role: &str) -> JsonValue {
    json!({"choices": [{"delta": {"role": role}, "index": 0}]})
}

fn content(text: &str) -> JsonValue {
    json!({"choices": [{"delta": {"content": text}, "index": 0}]})
}

fn finish(reason: &str) -> JsonValue {
    json!({"choices": [{"finish_reason": reason, "delta": {}, "index": 0}]})
}

fn tool_call(call: JsonValue) -> JsonValue {
    json!({"choices": [{"delta": {"tool_calls": JsonValue::Array(vec![call])}, "index": 0}]})
}

fn usage(usage: JsonValue) -> JsonValue {
    let mut chunk = json!({"choices": []});
    chunk["usage"] = usage;
    chunk
}

/// A capture client: a role chunk and a stop.
fn capture() -> Arc<MockClient> {
    MockClient::replying(vec![role("assistant"), finish("stop")])
}

fn user(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::User, content)
}

fn assistant(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::Assistant, content)
}

fn text(text: &str) -> ContentBlock {
    ContentBlock::text(text)
}

fn png(bytes: &[u8]) -> ImageBlock {
    ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(bytes.to_vec()))
}

/// The request messages a chat model sends for `request`.
async fn sent_messages(request: ModelRequest) -> JsonValue {
    let client = capture();
    collect(&chat_model(&client), request).await.unwrap();
    client.last()["messages"].clone()
}

fn with_system(prompt: impl Into<crate::types::SystemPrompt>) -> ModelRequest {
    ModelRequest::builder()
        .messages(vec![Message::user("Hello")])
        .system_prompt(prompt)
        .build()
}

fn hello() -> JsonValue {
    json!({"role": "user", "content": [{"type": "text", "text": "Hello"}]})
}

pub(super) mod stream {
    use super::*;

    /// A slow producer that notes how many tokens it made and whether it was stopped early.
    struct Producer {
        produced: AtomicUsize,
        stopped: AtomicBool,
    }

    struct StopGuard(Arc<Producer>, bool);

    impl Drop for StopGuard {
        fn drop(&mut self) {
            if !self.1 {
                self.0.stopped.store(true, Ordering::SeqCst);
            }
        }
    }

    struct ProducingClient {
        producer: Arc<Producer>,
        first: Arc<tokio::sync::Notify>,
        chunks: fn(usize) -> JsonValue,
        start: JsonValue,
        end: JsonValue,
    }

    impl OpenAIClient for ProducingClient {
        fn stream(&self, _path: &'static str, _body: JsonValue) -> EventStream {
            let producer = Arc::clone(&self.producer);
            let first = Arc::clone(&self.first);
            let (chunks, start, end) = (self.chunks, self.start.clone(), self.end.clone());
            Box::pin(async_stream::stream! {
                let mut guard = StopGuard(Arc::clone(&producer), false);
                yield Ok(start);
                while producer.produced.load(Ordering::SeqCst) < 20 {
                    let produced = producer.produced.fetch_add(1, Ordering::SeqCst) + 1;
                    if produced == 1 {
                        first.notify_one();
                    }
                    yield Ok(chunks(produced));
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                guard.1 = true;
                yield Ok(end);
            })
        }
    }

    /// Cancels after the first token and checks the producer stopped there.
    pub(in crate::models::openai::tests) async fn stops_on_cancel(
        api: OpenAIApi,
        chunks: fn(usize) -> JsonValue,
        start: JsonValue,
        end: JsonValue,
    ) {
        let producer = Arc::new(Producer {
            produced: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
        });
        let first = Arc::new(tokio::sync::Notify::new());
        let client: Arc<dyn OpenAIClient> = Arc::new(ProducingClient {
            producer: Arc::clone(&producer),
            first: Arc::clone(&first),
            chunks,
            start,
            end,
        });
        let model = OpenAIModel::from_parts(api, OpenAIModelConfig::builder().model_id("gpt-5.4").build(), client);
        let handle = CancelHandle::new();
        let request = ModelRequest::builder()
            .messages(vec![Message::user("Hello")])
            .cancel_signal(handle.signal())
            .build();
        let collected = tokio::spawn(async move { collect(&model, request).await });
        first.notified().await;
        let at_cancel = producer.produced.load(Ordering::SeqCst);
        handle.cancel(CancelOptions::default());
        let error = collected.await.unwrap().unwrap_err();
        assert_eq!(error.to_string(), "Request was aborted.");
        assert!(matches!(error, Error::Model(_)), "{error:?}");
        assert_eq!(producer.produced.load(Ordering::SeqCst), at_cancel);
        assert!(producer.stopped.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn stops_an_in_flight_chat_completions_producer_when_the_signal_aborts() {
        stops_on_cancel(
            OpenAIApi::Chat,
            |_| content("token "),
            role("assistant"),
            finish("stop"),
        )
        .await;
    }

    #[tokio::test]
    async fn throws_error_when_messages_array_is_empty() {
        let error = collect_error(&chat_model(&idle()), request(Vec::new())).await;
        assert_eq!(error.to_string(), "At least one message is required");
    }

    #[tokio::test]
    async fn validates_system_prompt_is_not_empty() {
        let client = MockClient::replying(vec![
            json!({"choices": [{"delta": {"role": "assistant", "content": "Hello"}, "index": 0}]}),
            finish("stop"),
        ]);
        let request = ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .system_prompt("   ")
            .build();
        let events = collect(&chat_model(&client), request).await.unwrap();
        assert_eq!(events[0]["type"], "modelMessageStartEvent");
        assert_eq!(
            client.last()["messages"],
            json!([{"role": "user", "content": [{"type": "text", "text": "Hi"}]}])
        );
    }

    #[tokio::test]
    async fn throws_error_for_streaming_with_n_greater_than_1() {
        let model = model_with(
            &idle(),
            OpenAIModelOptions {
                model_id: Some("gpt-5.4".to_owned()),
                params: Some(json!({"n": 2})),
                ..options(OpenAIApi::Chat)
            },
        );
        let error = collect_error(&model, hi()).await;
        assert_eq!(error.to_string(), "Streaming with n > 1 is not supported");
    }

    #[tokio::test]
    async fn throws_error_for_tool_spec_without_name_or_description() {
        let request = ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .tool_specs(vec![ToolSpec::new("", "test").with_input_schema(json!({}))])
            .build();
        let error = collect_error(&chat_model(&idle()), request).await;
        assert_eq!(
            error.to_string(),
            "Tool specification must have both name and description"
        );
    }

    #[tokio::test]
    async fn throws_error_for_empty_tool_result_content() {
        let messages = vec![user(vec![ToolResultBlock::success("tool-123", Vec::new()).into()])];
        let error = collect_error(&chat_model(&idle()), request(messages)).await;
        assert_eq!(
            error.to_string(),
            "Tool result for toolUseId \"tool-123\" has empty content. OpenAI requires tool messages to have non-empty content."
        );
    }

    #[tokio::test]
    async fn handles_tool_result_with_error_status() {
        let client = MockClient::replying(vec![
            json!({"choices": [{"delta": {"role": "assistant", "content": "Ok"}, "index": 0}]}),
            finish("stop"),
        ]);
        let messages = vec![
            Message::user("Run tool"),
            assistant(vec![
                ToolUseBlock::new("calculator", "tool-123", json!({"expr": "invalid"})).into(),
            ]),
            user(vec![
                ToolResultBlock::error("tool-123", vec!["Division by zero".into()]).into(),
            ]),
        ];
        let events = collect(&chat_model(&client), request(messages)).await.unwrap();
        assert_eq!(events[0]["type"], "modelMessageStartEvent");
        assert_eq!(
            client.last()["messages"],
            json!([
                {"role": "user", "content": [{"type": "text", "text": "Run tool"}]},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "tool-123", "type": "function", "function": {"name": "calculator", "arguments": "{\"expr\":\"invalid\"}"}}
                ]},
                {"role": "tool", "tool_call_id": "tool-123", "content": "[ERROR] Division by zero"},
            ])
        );
    }

    #[tokio::test]
    async fn yields_correct_event_sequence_for_simple_text_response() {
        let client = MockClient::replying(vec![
            role("assistant"),
            content("Hello"),
            content(" world"),
            finish("stop"),
        ]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        assert_eq!(
            events,
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent"}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": " world"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            ]
        );
        assert_eq!(client.requests()[0].path, "/chat/completions");
    }

    async fn metadata_for(usage_chunk: JsonValue) -> JsonValue {
        let client = MockClient::replying(vec![role("assistant"), finish("stop"), usage_chunk]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        events
            .into_iter()
            .find(|event| event["type"] == "modelMetadataEvent")
            .unwrap()
    }

    #[tokio::test]
    async fn emits_model_metadata_event_with_usage_information() {
        let metadata = metadata_for(usage(
            json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}),
        ))
        .await;
        assert_eq!(
            metadata,
            json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}})
        );
    }

    #[tokio::test]
    async fn surfaces_cache_read_input_tokens_from_prompt_tokens_details() {
        let metadata = metadata_for(usage(json!({
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "prompt_tokens_details": {"cached_tokens": 64}
        })))
        .await;
        assert_eq!(
            metadata["usage"],
            json!({"inputTokens": 100, "outputTokens": 20, "totalTokens": 120, "cacheReadInputTokens": 64})
        );
    }

    #[tokio::test]
    async fn omits_cache_read_input_tokens_when_cached_tokens_is_zero_or_absent() {
        let metadata = metadata_for(usage(json!({
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "prompt_tokens_details": {"cached_tokens": 0}
        })))
        .await;
        assert_eq!(
            metadata["usage"],
            json!({"inputTokens": 100, "outputTokens": 20, "totalTokens": 120})
        );
    }

    #[tokio::test]
    async fn surfaces_cache_write_input_tokens_from_prompt_tokens_details() {
        let metadata = metadata_for(usage(json!({
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "prompt_tokens_details": {"cached_tokens": 64, "cache_write_tokens": 40}
        })))
        .await;
        assert_eq!(
            metadata["usage"],
            json!({
                "inputTokens": 100, "outputTokens": 20, "totalTokens": 120,
                "cacheReadInputTokens": 64, "cacheWriteInputTokens": 40
            })
        );
    }

    #[tokio::test]
    async fn omits_cache_write_input_tokens_when_cache_write_tokens_is_zero_or_absent() {
        let metadata = metadata_for(usage(json!({
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "prompt_tokens_details": {"cached_tokens": 64, "cache_write_tokens": 0}
        })))
        .await;
        assert_eq!(
            metadata["usage"],
            json!({"inputTokens": 100, "outputTokens": 20, "totalTokens": 120, "cacheReadInputTokens": 64})
        );
    }

    #[tokio::test]
    async fn handles_usage_with_undefined_properties() {
        let metadata = metadata_for(usage(json!({}))).await;
        assert_eq!(
            metadata,
            json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}})
        );
    }

    #[tokio::test]
    async fn emits_usage_that_arrives_on_the_finish_reason_chunk() {
        let client = MockClient::replying(vec![
            role("assistant"),
            content("Hi"),
            json!({
                "choices": [{"finish_reason": "stop", "delta": {"content": ""}, "index": 0}],
                "usage": {"prompt_tokens": 8, "completion_tokens": 6, "total_tokens": 14}
            }),
        ]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        assert_eq!(
            events,
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent"}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hi"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 8, "outputTokens": 6, "totalTokens": 14}}),
                json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            ]
        );
    }

    #[tokio::test]
    async fn filters_out_empty_string_content_deltas() {
        let client = MockClient::replying(vec![role("assistant"), content(""), content("Hello"), finish("stop")]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        let deltas: Vec<_> = events
            .iter()
            .filter(|event| event["type"] == "modelContentBlockDeltaEvent")
            .collect();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0]["delta"]["text"], "Hello");
    }

    #[tokio::test]
    async fn prevents_duplicate_message_start_events() {
        let client = MockClient::replying(vec![
            role("assistant"),
            json!({"choices": [{"delta": {"role": "assistant", "content": "Hello"}, "index": 0}]}),
            finish("stop"),
        ]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        assert_eq!(
            types(&events)
                .iter()
                .filter(|kind| **kind == "modelMessageStartEvent")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn handles_stream_interruption_errors() {
        let client = MockClient::failing(vec![role("assistant"), content("Hello")], || {
            HttpError::connection("Network connection lost")
        });
        let error = collect_error(&chat_model(&client), hi()).await;
        assert!(matches!(error, Error::ModelNetwork(_)), "{error:?}");
        assert_eq!(error.to_string(), "Connection error.");
    }

    #[tokio::test]
    async fn emits_usage_after_the_stream_when_no_stop_event_arrives() {
        let client = MockClient::replying(vec![role("assistant"), usage(json!({"prompt_tokens": 1}))]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        assert_eq!(types(&events), vec!["modelMessageStartEvent", "modelMetadataEvent"]);
    }
}

mod tool_calling {
    use super::*;

    #[tokio::test]
    async fn handles_tool_use_request_with_content_block_start_and_content_block_stop_events() {
        let client = MockClient::replying(vec![
            role("assistant"),
            tool_call(
                json!({"index": 0, "id": "call_123", "type": "function", "function": {"name": "calculator", "arguments": ""}}),
            ),
            tool_call(json!({"index": 0, "function": {"arguments": "{\"expr"}})),
            tool_call(json!({"index": 0, "function": {"arguments": "\":\"2+2\"}"}})),
            finish("tool_calls"),
        ]);
        let events = collect(&chat_model(&client), request(vec![Message::user("Calculate 2+2")]))
            .await
            .unwrap();
        assert_eq!(
            events,
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent", "start": {"type": "toolUseStart", "name": "calculator", "toolUseId": "call_123"}}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "toolUseInputDelta", "input": "{\"expr"}}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "toolUseInputDelta", "input": "\":\"2+2\"}"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMessageStopEvent", "stopReason": "toolUse"}),
            ]
        );
    }

    #[tokio::test]
    async fn handles_multiple_tool_calls() {
        let client = MockClient::replying(vec![
            role("assistant"),
            tool_call(
                json!({"index": 0, "id": "call_1", "type": "function", "function": {"name": "tool1", "arguments": "{}"}}),
            ),
            tool_call(
                json!({"index": 1, "id": "call_2", "type": "function", "function": {"name": "tool2", "arguments": "{}"}}),
            ),
            finish("tool_calls"),
        ]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        assert_eq!(
            types(&events)
                .iter()
                .filter(|kind| **kind == "modelContentBlockStopEvent")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn skips_tool_calls_with_invalid_index() {
        let client = MockClient::replying(vec![
            role("assistant"),
            tool_call(json!({"id": "call_123", "type": "function", "function": {"name": "tool", "arguments": "{}"}})),
            finish("stop"),
        ]);
        let (logs, _guard) = record_logs();
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        assert_eq!(types(&events), vec!["modelMessageStartEvent", "modelMessageStopEvent"]);
        assert!(
            logs.text().contains("| received tool call with invalid index"),
            "{}",
            logs.text()
        );
    }

    #[tokio::test]
    async fn tool_argument_deltas_can_be_reassembled_into_valid_json() {
        let mut chunks = vec![
            role("assistant"),
            tool_call(
                json!({"index": 0, "id": "call_123", "type": "function", "function": {"name": "calculator", "arguments": ""}}),
            ),
        ];
        for piece in ["{\"", "x\":", "10,", "\"y\":", "20}"] {
            chunks.push(tool_call(json!({"index": 0, "function": {"arguments": piece}})));
        }
        chunks.push(finish("tool_calls"));
        let events = collect(&chat_model(&MockClient::replying(chunks)), hi()).await.unwrap();
        let input: String = events
            .iter()
            .filter(|event| event["delta"]["type"] == "toolUseInputDelta")
            .map(|event| event["delta"]["input"].as_str().unwrap())
            .collect();
        assert_eq!(
            serde_json::from_str::<JsonValue>(&input).unwrap(),
            json!({"x": 10, "y": 20})
        );
    }

    #[tokio::test]
    async fn handles_messages_with_both_text_and_tool_calls() {
        let client = MockClient::replying(vec![
            role("assistant"),
            content("Let me calculate "),
            content("that for you."),
            tool_call(
                json!({"index": 0, "id": "call_123", "type": "function", "function": {"name": "calculator", "arguments": "{\"expr\":\"2+2\"}"}}),
            ),
            finish("tool_calls"),
        ]);
        let (_, result) = aggregate(&chat_model(&client), hi()).await.unwrap();
        assert_eq!(result.stop_reason, StopReason::ToolUse);
        assert_eq!(
            serde_json::to_value(&result.message.content).unwrap(),
            json!([
                {"text": "Let me calculate that for you."},
                {"toolUse": {"name": "calculator", "toolUseId": "call_123", "input": {"expr": "2+2"}}}
            ])
        );
    }
}

mod stop_reasons {
    use super::*;

    async fn stop_reason(finish_reason: &str) -> JsonValue {
        let client = MockClient::replying(vec![role("assistant"), finish(finish_reason)]);
        let events = collect(&chat_model(&client), hi()).await.unwrap();
        events.last().unwrap()["stopReason"].clone()
    }

    #[tokio::test]
    async fn maps_openai_stop_reasons_to_sdk_stop_reasons() {
        for (openai, sdk) in [
            ("stop", "endTurn"),
            ("tool_calls", "toolUse"),
            ("length", "maxTokens"),
            ("content_filter", "contentFiltered"),
        ] {
            assert_eq!(stop_reason(openai).await, sdk, "{openai}");
        }
    }

    #[tokio::test]
    async fn handles_unknown_stop_reasons_with_warning() {
        let (logs, _guard) = record_logs();
        assert_eq!(stop_reason("new_unknown_reason").await, "newUnknownReason");
        assert!(
            logs.text().contains(
                "finish_reason=<new_unknown_reason>, fallback=<newUnknownReason> | unknown openai stop reason, using camelCase conversion as fallback"
            ),
            "{}",
            logs.text()
        );
    }
}

mod api_request_formatting {
    use super::*;

    fn cached(cache_config: CacheConfig, params: Option<JsonValue>) -> OpenAIModelOptions {
        OpenAIModelOptions {
            cache_config: Some(cache_config),
            params,
            ..options(OpenAIApi::Chat)
        }
    }

    async fn sent(options: OpenAIModelOptions, request: ModelRequest) -> JsonValue {
        let client = capture();
        collect(&model_with(&client, options), request).await.unwrap();
        client.last()
    }

    fn with_session(session: Option<&str>) -> ModelRequest {
        let metadata = match session {
            Some(session) => AgentMetadata::new().with_session_id(session),
            None => AgentMetadata::new(),
        };
        ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .agent_metadata(metadata)
            .build()
    }

    #[tokio::test]
    async fn formats_api_request_correctly_with_all_options() {
        let client = capture();
        let model = model_with(
            &client,
            OpenAIModelOptions {
                model_id: Some("gpt-5.4".to_owned()),
                temperature: Some(0.7),
                max_tokens: Some(1000),
                ..options(OpenAIApi::Chat)
            },
        );
        let request = ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .system_prompt("You are a helpful assistant")
            .tool_specs(vec![
                ToolSpec::new("calculator", "Calculate expressions")
                    .with_input_schema(json!({"type": "object", "properties": {"expr": {"type": "string"}}})),
            ])
            .tool_choice(ToolChoice::Auto)
            .build();
        collect(&model, request).await.unwrap();
        assert_eq!(client.requests().len(), 1);
        let body = client.last();
        assert_eq!(
            body,
            json!({
                "model": "gpt-5.4",
                "messages": [
                    {"role": "system", "content": "You are a helpful assistant"},
                    {"role": "user", "content": [{"type": "text", "text": "Hi"}]}
                ],
                "stream": true,
                "stream_options": {"include_usage": true},
                "temperature": 0.7,
                "max_completion_tokens": 1000,
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "calculator",
                        "description": "Calculate expressions",
                        "parameters": {"type": "object", "properties": {"expr": {"type": "string"}}}
                    }
                }],
                "tool_choice": "auto"
            })
        );
        let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "model",
                "messages",
                "stream",
                "stream_options",
                "temperature",
                "max_completion_tokens",
                "tools",
                "tool_choice"
            ]
        );
    }

    #[tokio::test]
    async fn formats_penalties_top_p_and_the_forced_tool_choices() {
        let model_options = OpenAIModelOptions {
            top_p: Some(0.5),
            frequency_penalty: Some(0.25),
            presence_penalty: Some(-0.5),
            ..options(OpenAIApi::Chat)
        };
        for (choice, expected) in [
            (ToolChoice::Any, json!("required")),
            (
                ToolChoice::tool("calc"),
                json!({"type": "function", "function": {"name": "calc"}}),
            ),
        ] {
            let request = ModelRequest::builder()
                .messages(vec![Message::user("Hi")])
                .tool_specs(vec![ToolSpec::new("calc", "d")])
                .tool_choice(choice)
                .build();
            let body = sent(model_options.clone(), request).await;
            assert_eq!(body["tool_choice"], expected);
            assert_eq!(body["top_p"], 0.5);
            assert_eq!(body["frequency_penalty"], 0.25);
            assert_eq!(body["presence_penalty"], -0.5);
            assert_eq!(
                body["tools"][0]["function"],
                json!({"name": "calc", "description": "d"})
            );
        }
    }

    #[tokio::test]
    async fn maps_cache_config_cache_key_to_prompt_cache_key() {
        let body = sent(
            cached(CacheConfig::builder().cache_key("tenant-42").build(), None),
            hi(),
        )
        .await;
        assert_eq!(body["prompt_cache_key"], "tenant-42");
    }

    #[tokio::test]
    async fn omits_prompt_cache_key_when_cache_config_is_unset() {
        let body = sent(options(OpenAIApi::Chat), hi()).await;
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[tokio::test]
    async fn lets_an_explicit_prompt_cache_key_in_params_win_over_cache_config() {
        let options = cached(
            CacheConfig::builder().cache_key("from-config").build(),
            Some(json!({"prompt_cache_key": "explicit"})),
        );
        assert_eq!(sent(options, hi()).await["prompt_cache_key"], "explicit");
    }

    #[tokio::test]
    async fn derives_prompt_cache_key_from_the_agent_metadata_session_when_cache_key_is_unset() {
        let body = sent(cached(CacheConfig::default(), None), with_session(Some("s1"))).await;
        assert_eq!(body["prompt_cache_key"], "strands-s1");
    }

    #[tokio::test]
    async fn lets_a_configured_cache_key_win_over_the_agent_metadata_session() {
        let options = cached(CacheConfig::builder().cache_key("tenant-42").build(), None);
        assert_eq!(
            sent(options, with_session(Some("s1"))).await["prompt_cache_key"],
            "tenant-42"
        );
    }

    #[tokio::test]
    async fn treats_a_false_cache_key_as_an_opt_out_even_with_an_agent_metadata_session() {
        let options = cached(
            CacheConfig {
                cache_key: Some(CacheKey::Disabled),
                ..Default::default()
            },
            None,
        );
        assert!(
            sent(options, with_session(Some("s1")))
                .await
                .get("prompt_cache_key")
                .is_none()
        );
    }

    #[tokio::test]
    async fn omits_prompt_cache_key_when_the_agent_metadata_carries_no_session() {
        let body = sent(cached(CacheConfig::default(), None), with_session(None)).await;
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[tokio::test]
    async fn maps_retention_literal_cache_config_ttl_to_prompt_cache_retention() {
        for ttl in ["24h", "in_memory"] {
            let body = sent(cached(CacheConfig::builder().ttl(ttl).build(), None), hi()).await;
            assert_eq!(body["prompt_cache_retention"], ttl);
        }
    }

    #[tokio::test]
    async fn ignores_a_non_retention_cache_config_ttl_and_warns_once() {
        let warning = "ttl=<5m> | cacheConfig.ttl is not an openai retention value, ignoring";
        forget_warning(warning);
        let (logs, _guard) = record_logs();
        let body = sent(cached(CacheConfig::builder().ttl("5m").build(), None), hi()).await;
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(logs.text().contains(warning), "{}", logs.text());
    }

    #[tokio::test]
    async fn lets_an_explicit_prompt_cache_retention_in_params_win_over_cache_config() {
        let options = cached(
            CacheConfig::builder().ttl("in_memory").build(),
            Some(json!({"prompt_cache_retention": "24h"})),
        );
        assert_eq!(sent(options, hi()).await["prompt_cache_retention"], "24h");
    }

    #[tokio::test]
    async fn does_not_warn_about_an_unsupported_ttl_when_an_explicit_prompt_cache_retention_already_wins() {
        let warning = "ttl=<5m> | cacheConfig.ttl is not an openai retention value, ignoring";
        forget_warning(warning);
        let (logs, _guard) = record_logs();
        let options = cached(
            CacheConfig::builder().ttl("5m").build(),
            Some(json!({"prompt_cache_retention": "24h"})),
        );
        assert_eq!(sent(options, hi()).await["prompt_cache_retention"], "24h");
        assert!(
            !logs.text().contains("not an openai retention value"),
            "{}",
            logs.text()
        );
    }

    #[tokio::test]
    async fn warns_once_that_placement_fields_have_no_effect() {
        let warning = "openai caches prefixes automatically server-side | strategy, toolsTTL, systemPromptTTL and messagesTTL have no effect";
        forget_warning(warning);
        let (logs, _guard) = record_logs();
        let cache_config = CacheConfig {
            strategy: Some(crate::models::CacheStrategy::Anthropic),
            system_prompt_ttl: Some(false.into()),
            tools_ttl: Some("1h".into()),
            cache_key: Some("k".into()),
            ..Default::default()
        };
        let model = model_with(&capture(), cached(cache_config, None));
        collect(&model, hi()).await.unwrap();
        collect(&model, hi()).await.unwrap();
        assert_eq!(logs.text().matches("have no effect").count(), 1, "{}", logs.text());
    }
}

mod system_prompt_handling {
    use super::*;

    #[tokio::test]
    async fn formats_array_system_prompt_with_text_blocks_only() {
        let prompt = vec![
            SystemContentBlock::from("You are a helpful assistant"),
            SystemContentBlock::from("Additional context here"),
        ];
        assert_eq!(
            sent_messages(with_system(prompt)).await,
            json!([{"role": "system", "content": "You are a helpful assistantAdditional context here"}, hello()])
        );
    }

    #[tokio::test]
    async fn formats_array_system_prompt_with_cache_points() {
        let (logs, _guard) = record_logs();
        let prompt = vec![
            SystemContentBlock::from("You are a helpful assistant"),
            SystemContentBlock::from("Large context document"),
            CachePointBlock::new().into(),
        ];
        assert_eq!(
            sent_messages(with_system(prompt)).await,
            json!([{"role": "system", "content": "You are a helpful assistantLarge context document"}, hello()])
        );
        assert!(
            logs.text()
                .contains("cache points are not supported in openai system prompts, ignoring cache points"),
            "{}",
            logs.text()
        );
    }

    #[tokio::test]
    async fn handles_empty_array_system_prompt() {
        assert_eq!(
            sent_messages(with_system(Vec::<SystemContentBlock>::new())).await,
            json!([hello()])
        );
    }

    #[tokio::test]
    async fn formats_array_system_prompt_with_single_text_block() {
        let prompt = vec![SystemContentBlock::from("You are a helpful assistant")];
        assert_eq!(
            sent_messages(with_system(prompt)).await,
            json!([{"role": "system", "content": "You are a helpful assistant"}, hello()])
        );
    }

    fn guard(qualifier: GuardQualifier, text: &str) -> SystemContentBlock {
        GuardContentBlock::Text(GuardContentText::new(vec![qualifier], text)).into()
    }

    const GUARD_WARNING: &str = "guard content is not supported in openai system prompts, removing guard content block";

    #[tokio::test]
    async fn warns_and_filters_guard_content_from_system_prompt() {
        let (logs, _guard) = record_logs();
        let prompt = vec![
            SystemContentBlock::from("You are a helpful assistant"),
            guard(GuardQualifier::GroundingSource, "Guard content"),
        ];
        assert_eq!(
            sent_messages(with_system(prompt)).await,
            json!([{"role": "system", "content": "You are a helpful assistant"}, hello()])
        );
        assert!(logs.text().contains(GUARD_WARNING), "{}", logs.text());
    }

    #[tokio::test]
    async fn preserves_text_blocks_when_filtering_guard_content() {
        let (logs, _guard) = record_logs();
        let prompt = vec![
            SystemContentBlock::from("First text"),
            guard(GuardQualifier::Query, "Guard content"),
            SystemContentBlock::from("Second text"),
        ];
        assert_eq!(
            sent_messages(with_system(prompt)).await,
            json!([{"role": "system", "content": "First textSecond text"}, hello()])
        );
        assert!(logs.text().contains(GUARD_WARNING), "{}", logs.text());
    }

    #[tokio::test]
    async fn handles_system_prompt_with_only_guard_content() {
        let (logs, _guard) = record_logs();
        let prompt = vec![guard(GuardQualifier::GuardContent, "Only guard content")];
        assert_eq!(sent_messages(with_system(prompt)).await, json!([hello()]));
        assert!(logs.text().contains(GUARD_WARNING), "{}", logs.text());
    }
}

mod guard_content_in_messages {
    use super::*;

    const WARNING: &str = "block_type=<guardContentBlock> | unsupported content type in openai user message | skipping";

    fn guard_text(text: &str) -> ContentBlock {
        GuardContentBlock::Text(GuardContentText::new(vec![GuardQualifier::GroundingSource], text)).into()
    }

    #[tokio::test]
    async fn warns_and_filters_guard_content_from_user_messages() {
        let (logs, _guard) = record_logs();
        let messages = vec![user(vec![
            text("Verify this:"),
            guard_text("Guard content"),
            text("Is it correct?"),
        ])];
        assert_eq!(
            sent_messages(request(messages)).await,
            json!([{"role": "user", "content": [
                {"type": "text", "text": "Verify this:"},
                {"type": "text", "text": "Is it correct?"}
            ]}])
        );
        assert!(logs.text().contains(WARNING), "{}", logs.text());
    }

    #[tokio::test]
    async fn warns_and_filters_guard_content_with_image_from_user_messages() {
        let (logs, _guard) = record_logs();
        let image = GuardContentBlock::Image(GuardContentImage::new(GuardImageFormat::Jpeg, vec![1, 2, 3, 4]));
        let messages = vec![user(vec![text("Check this image:"), image.into()])];
        assert_eq!(
            sent_messages(request(messages)).await,
            json!([{"role": "user", "content": [{"type": "text", "text": "Check this image:"}]}])
        );
        assert!(logs.text().contains(WARNING), "{}", logs.text());
    }

    #[tokio::test]
    async fn handles_message_with_only_guard_content() {
        let (logs, _guard) = record_logs();
        let messages = vec![user(vec![guard_text("Only guard content")])];
        assert_eq!(sent_messages(request(messages)).await, json!([]));
        assert!(logs.text().contains(WARNING), "{}", logs.text());
    }
}

mod unknown_blocks_in_messages {
    use super::*;

    #[tokio::test]
    async fn skips_unknown_blocks_in_user_and_assistant_messages_without_a_warning() {
        let (logs, _guard) = record_logs();
        let unknown = || {
            ContentBlock::Unknown(UnknownBlock::new(
                json!({"futureBlock": {"value": 1}}).as_object().cloned().unwrap(),
            ))
        };
        let messages = vec![
            user(vec![text("Hello"), unknown()]),
            assistant(vec![text("Hi"), unknown()]),
        ];
        assert_eq!(
            sent_messages(request(messages)).await,
            json!([hello(), {"role": "assistant", "content": "Hi"}])
        );
        assert!(!logs.text().contains("WARN"), "{}", logs.text());
    }
}

mod media_blocks {
    use super::*;

    #[tokio::test]
    async fn formats_image_block_in_user_message_as_image_url_with_base64() {
        let messages = vec![user(vec![
            text("What is in this image?"),
            png(&[72, 101, 108, 108, 111]).into(),
        ])];
        assert_eq!(
            sent_messages(request(messages)).await[0]["content"],
            json!([
                {"type": "text", "text": "What is in this image?"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,SGVsbG8="}}
            ])
        );
    }

    #[tokio::test]
    async fn formats_image_block_in_user_message_with_url_source() {
        let image = ImageBlock::new(
            ImageFormat::Jpeg,
            ImageSource::Url("https://example.com/img.jpg".to_owned()),
        );
        let messages = vec![user(vec![image.into()])];
        assert_eq!(
            sent_messages(request(messages)).await[0]["content"][0],
            json!({"type": "image_url", "image_url": {"url": "https://example.com/img.jpg"}})
        );
    }

    #[tokio::test]
    async fn formats_document_block_with_bytes_source_as_file_in_user_message() {
        let document = DocumentBlock::new("report.pdf", DocumentFormat::Pdf, DocumentSource::Bytes(vec![1, 2, 3]));
        let messages = vec![user(vec![document.into()])];
        assert_eq!(
            sent_messages(request(messages)).await[0]["content"][0],
            json!({"type": "file", "file": {"file_data": "data:application/pdf;base64,AQID", "filename": "report.pdf"}})
        );
    }

    #[tokio::test]
    async fn converts_text_and_content_document_sources_to_text_parts() {
        let (logs, _guard) = record_logs();
        let text_document = DocumentBlock::new("a.txt", DocumentFormat::Txt, DocumentSource::Text("plain".to_owned()));
        let content_document = DocumentBlock::new(
            "b.txt",
            DocumentFormat::Txt,
            DocumentSource::Content(vec![
                crate::types::TextBlock::new("one"),
                crate::types::TextBlock::new("two"),
            ]),
        );
        let messages = vec![user(vec![text_document.into(), content_document.into()])];
        assert_eq!(
            sent_messages(request(messages)).await[0]["content"],
            json!([
                {"type": "text", "text": "plain"},
                {"type": "text", "text": "one"},
                {"type": "text", "text": "two"}
            ])
        );
        assert!(
            logs.text()
                .contains("source_type=<documentSourceText> | openai does not support text document sources directly"),
            "{}",
            logs.text()
        );
    }

    #[tokio::test]
    async fn splits_image_from_tool_result_into_separate_user_message() {
        let result = ToolResultBlock::success(
            "tool-1",
            vec!["Screenshot captured".into(), png(&[72, 101, 108, 108, 111]).into()],
        );
        let messages = sent_messages(request(vec![user(vec![result.into()])])).await;
        assert_eq!(
            messages,
            json!([
                {"role": "tool", "tool_call_id": "tool-1", "content": "Screenshot captured"},
                {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,SGVsbG8="}}]}
            ])
        );
    }

    #[tokio::test]
    async fn injects_placeholder_text_when_tool_result_contains_only_images() {
        let result = ToolResultBlock::success("tool-1", vec![png(&[1]).into()]);
        let messages = sent_messages(request(vec![user(vec![result.into()])])).await;
        assert!(
            messages[0]["content"]
                .as_str()
                .unwrap()
                .contains("Tool successfully returned an image")
        );
    }

    #[tokio::test]
    async fn skips_document_block_in_tool_result_with_warning() {
        let (logs, _guard) = record_logs();
        let document = DocumentBlock::new("doc.pdf", DocumentFormat::Pdf, DocumentSource::Bytes(vec![1]));
        let result = ToolResultBlock::success("tool-1", vec!["result".into(), document.into()]);
        let messages = sent_messages(request(vec![user(vec![result.into()])])).await;
        assert_eq!(messages[0]["content"], "result");
        assert!(
            logs.text().contains("documents not supported in openai tool results"),
            "{}",
            logs.text()
        );
    }

    #[tokio::test]
    async fn skips_video_block_in_tool_result_with_warning() {
        let (logs, _guard) = record_logs();
        let video = VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(vec![1]));
        let result = ToolResultBlock::success("tool-1", vec!["result".into(), video.into()]);
        let messages = sent_messages(request(vec![user(vec![result.into()])])).await;
        assert_eq!(messages[0]["content"], "result");
        assert!(
            logs.text().contains("videos not supported in openai tool results"),
            "{}",
            logs.text()
        );
    }

    #[tokio::test]
    async fn joins_json_tool_results_and_converts_reasoning_to_text() {
        let (logs, _guard) = record_logs();
        let result = ToolResultBlock::success(
            "tool-1",
            vec!["a".into(), crate::types::JsonBlock::new(json!({"b": 1})).into()],
        );
        let reasoning = crate::types::ReasoningBlock::new().with_text("thinking");
        let messages = vec![
            Message::user("q"),
            assistant(vec![reasoning.into(), text(" answer ")]),
            user(vec![result.into()]),
        ];
        let sent = sent_messages(request(messages)).await;
        assert_eq!(sent[1], json!({"role": "assistant", "content": "thinking answer"}));
        assert_eq!(sent[2]["content"], "a{\"b\":1}");
        assert!(
            logs.text()
                .contains("reasoning blocks not supported by openai | converting to text"),
            "{}",
            logs.text()
        );
    }
}

mod tool_result_and_text_ordering {
    use super::*;

    #[tokio::test]
    async fn sends_an_offloaded_block_as_the_text_the_model_receives_in_user_assistant_and_tool_result_content() {
        let placeholder = crate::types::TextBlock::offloaded(
            "[Dropped] [ref: tu-1]",
            crate::types::Offloaded::new(crate::types::OffloadMethod::Drop).with_reference("tu-1"),
        );
        let messages = vec![
            user(vec![ContentBlock::Text(placeholder.clone())]),
            assistant(vec![ContentBlock::Text(placeholder.clone())]),
            user(vec![
                ToolResultBlock::success("tu-1", vec![crate::types::ToolResultContent::Text(placeholder)]).into(),
            ]),
        ];
        let sent = sent_messages(ModelRequest::builder().messages(messages).build()).await;
        assert_eq!(
            sent,
            json!([
                {"role": "user", "content": [{"type": "text", "text": "[Dropped] [ref: tu-1]"}]},
                {"role": "assistant", "content": "[Dropped] [ref: tu-1]"},
                {"role": "tool", "tool_call_id": "tu-1", "content": "[Dropped] [ref: tu-1]"}
            ])
        );
    }

    #[tokio::test]
    async fn keeps_tool_results_adjacent_to_the_assistant_tool_calls() {
        let cases: [(&[&str], &[&str]); 3] = [
            (&["tu1", "text"], &["user", "assistant", "tool", "user"]),
            (&["text", "tu1"], &["user", "assistant", "tool", "user"]),
            (&["tu1", "text", "tu2"], &["user", "assistant", "tool", "tool", "user"]),
        ];
        for (order, roles) in cases {
            let tool_use_ids: Vec<&str> = order.iter().copied().filter(|entry| *entry != "text").collect();
            let messages = vec![
                Message::user("task"),
                assistant(
                    tool_use_ids
                        .iter()
                        .map(|id| ToolUseBlock::new("calc", *id, json!({})).into())
                        .collect(),
                ),
                user(
                    order
                        .iter()
                        .map(|entry| match *entry {
                            "text" => text("\n\nNOTE"),
                            id => ToolResultBlock::success(id, vec!["42".into()]).into(),
                        })
                        .collect(),
                ),
            ];
            let sent = sent_messages(request(messages)).await;
            let sent = sent.as_array().unwrap();
            let sent_roles: Vec<&str> = sent.iter().map(|message| message["role"].as_str().unwrap()).collect();
            assert_eq!(sent_roles, roles, "{order:?}");
            assert_eq!(sent[2], json!({"role": "tool", "tool_call_id": "tu1", "content": "42"}));
            assert_eq!(
                sent.last().unwrap(),
                &json!({"role": "user", "content": [{"type": "text", "text": "\n\nNOTE"}]})
            );
        }
    }

    #[tokio::test]
    async fn keeps_media_hoisted_out_of_a_tool_result_ahead_of_the_injected_text() {
        let result = ToolResultBlock::success("tu1", vec!["42".into(), png(&[1]).into()]);
        let messages = vec![user(vec![result.into(), text("\n\nNOTE")])];
        assert_eq!(
            sent_messages(request(messages)).await,
            json!([
                {"role": "tool", "tool_call_id": "tu1", "content": "42"},
                {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AQ=="}}]},
                {"role": "user", "content": [{"type": "text", "text": "\n\nNOTE"}]}
            ])
        );
    }
}

mod error_handling {
    use super::*;

    async fn error_for(error: impl Fn() -> HttpError + Send + Sync + 'static) -> Error {
        collect_error(&chat_model(&MockClient::failing(Vec::new(), error)), hi()).await
    }

    #[tokio::test]
    async fn throws_context_window_overflow_error_for_structured_error_with_code() {
        let error = error_for(|| status_error(400, "Context length exceeded", Some("context_length_exceeded"))).await;
        assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
        assert_eq!(error.to_string(), "400 Context length exceeded");
    }

    #[tokio::test]
    async fn throws_context_window_overflow_error_for_error_with_message_pattern() {
        let error = error_for(|| event_error("maximum context length exceeded", None)).await;
        assert!(
            matches!(error, Error::ContextWindowOverflow(ContextWindowOverflowError { .. })),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn throws_context_window_overflow_error_for_api_error_instance() {
        let error = error_for(|| event_error("opaque", Some(json!("context_length_exceeded")))).await;
        assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
    }

    #[tokio::test]
    async fn passes_through_other_errors_unchanged() {
        let error = error_for(|| status_error(401, "Invalid API key", Some("invalid_api_key"))).await;
        assert!(matches!(error, Error::Model(_)), "{error:?}");
        assert_eq!(error.to_string(), "401 Invalid API key");
        let source = std::error::Error::source(&error)
            .unwrap()
            .downcast_ref::<HttpError>()
            .unwrap();
        assert_eq!(source.kind(), HttpErrorKind::Status(401));
    }

    #[tokio::test]
    async fn throws_model_throttled_error_for_http_429_status() {
        let error = error_for(|| status_error(429, "Too many requests", None)).await;
        assert!(
            matches!(error, Error::ModelThrottled(ModelThrottledError { .. })),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn throws_model_throttled_error_for_rate_limit_exceeded_error_code() {
        let error = error_for(|| event_error("Rate limit reached", Some(json!("rate_limit_exceeded")))).await;
        assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    }

    #[tokio::test]
    async fn throws_model_throttled_error_for_error_message_containing_rate_limit_pattern() {
        let error = error_for(|| event_error("You have exceeded your rate limit", None)).await;
        assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    }

    #[tokio::test]
    async fn throws_model_throttled_error_for_too_many_requests_message() {
        let error = error_for(|| event_error("Too many requests, please slow down", None)).await;
        assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    }

    #[tokio::test]
    async fn preserves_original_error_as_cause_in_model_throttled_error() {
        let error = error_for(|| status_error(429, "Request too large for gpt-5.4 on tokens per min", None)).await;
        let Error::ModelThrottled(throttled) = &error else {
            panic!("{error:?}");
        };
        assert_eq!(throttled.message, "429 Request too large for gpt-5.4 on tokens per min");
        let source = throttled.source.as_ref().unwrap().downcast_ref::<HttpError>().unwrap();
        assert_eq!(source.status_code(), Some(429));
    }

    #[tokio::test]
    async fn maps_a_timeout_to_model_network_error() {
        let error = error_for(HttpError::timeout).await;
        assert!(matches!(error, Error::ModelNetwork(_)), "{error:?}");
        assert_eq!(error.to_string(), "Request timed out.");
    }
}

mod tools_on_models_that_limit_them {
    use super::*;
    use crate::models::http::ErrorPayload;

    const OPENAI_URL: &str = "https://api.openai.com/v1";
    const MANTLE_URL: &str = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
    const PROXY_URL: &str = "http://localhost:4000/v1";

    struct Sent {
        base_url: Option<&'static str>,
        model_id: &'static str,
        params: Option<JsonValue>,
        with_tools: bool,
    }

    fn sent(base_url: Option<&'static str>, model_id: &'static str) -> Sent {
        Sent {
            base_url,
            model_id,
            params: None,
            with_tools: true,
        }
    }

    fn effort(mut sent: Sent, effort: &str) -> Sent {
        sent.params = Some(json!({"reasoning_effort": effort}));
        sent
    }

    fn without_tools(mut sent: Sent) -> Sent {
        sent.with_tools = false;
        sent
    }

    fn model_options(sent: &Sent) -> OpenAIModelOptions {
        OpenAIModelOptions {
            model_id: Some(sent.model_id.to_owned()),
            params: sent.params.clone(),
            ..options(OpenAIApi::Chat)
        }
    }

    fn tools_request(with_tools: bool) -> ModelRequest {
        let tools = with_tools
            .then(|| ToolSpec::new("echo", "Echo a value").with_input_schema(json!({"type": "object"})))
            .into_iter()
            .collect::<Vec<_>>();
        ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .tool_specs(tools)
            .build()
    }

    /// The body `format_chat_request` builds for `sent`, before any tool limit applies.
    fn formatted(sent: &Sent) -> JsonValue {
        let parts = model_options(sent).into_parts();
        let config = prepare_config(parts.api, parts.config).unwrap();
        JsonValue::Object(format_chat_request(&config, &tools_request(sent.with_tools)).unwrap())
    }

    fn warning(model_id: &str) -> String {
        format!(
            "model_id=<{model_id}> | this model accepts tools on the Chat Completions API only with reasoning off, sending reasoning_effort='none'; use api: OpenAIApi::Responses to keep reasoning"
        )
    }

    async fn send(sent: &Sent) -> JsonValue {
        let client = MockClient::at(sent.base_url, vec![role("assistant"), finish("stop")], None);
        let model = model_with(&client, model_options(sent));
        collect(&model, tools_request(sent.with_tools)).await.unwrap();
        client.last()
    }

    fn api_error(status: u16, param: Option<&str>) -> HttpError {
        let body =
            json!({"error": {"message": "Function tools with reasoning_effort are not supported", "param": param}});
        HttpError::status(status, Some(body), "", ErrorPayload::ErrorField)
    }

    async fn reject(sent: &Sent, status: u16, param: Option<&'static str>) -> Error {
        let error: Box<dyn Fn() -> HttpError + Send + Sync> = Box::new(move || api_error(status, param));
        let client = MockClient::at(sent.base_url, Vec::new(), Some(error));
        collect_error(
            &model_with(&client, model_options(sent)),
            tools_request(sent.with_tools),
        )
        .await
    }

    #[tokio::test]
    async fn turns_reasoning_off_and_warns_when_model_id_is_sent_tools_at_base_url() {
        for sent in [
            sent(Some(OPENAI_URL), "gpt-6-sol"),
            sent(Some("https://API.OPENAI.COM:443/v1"), "gpt-6-sol"),
            sent(Some(MANTLE_URL), "openai.gpt-6.1-terra"),
        ] {
            forget_warning(&warning(sent.model_id));
            let (logs, _guard) = record_logs();
            let mut expected = formatted(&sent);
            expected["reasoning_effort"] = json!("none");

            assert_eq!(send(&sent).await, expected, "{:?}", sent.base_url);
            assert!(logs.text().contains(&warning(sent.model_id)), "{:?}", sent.base_url);
        }
    }

    #[tokio::test]
    async fn sends_the_request_as_formatted_unless_it_turns_reasoning_off() {
        for (name, sent) in [
            ("no tools", without_tools(sent(Some(OPENAI_URL), "gpt-6-sol"))),
            ("effort none", effort(sent(Some(OPENAI_URL), "gpt-6-sol"), "none")),
            ("effort low", effort(sent(Some(OPENAI_URL), "gpt-6-sol"), "low")),
            ("tool-less model", sent(Some(OPENAI_URL), "gpt-6-astra")),
            (
                "tool-less model, effort none",
                effort(sent(Some(OPENAI_URL), "gpt-6.1-sol"), "none"),
            ),
            (
                "tool-less model on Mantle",
                sent(Some(MANTLE_URL), "openai.gpt-6.1-sol"),
            ),
            ("older model", effort(sent(Some(OPENAI_URL), "gpt-5.4"), "low")),
            ("other endpoint", sent(Some(PROXY_URL), "gpt-6-sol")),
            (
                "bedrock-runtime",
                sent(
                    Some("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"),
                    "openai.gpt-6.1-terra",
                ),
            ),
            (
                "look-alike host",
                sent(Some("https://api.openai.com.evil.example/v1"), "gpt-6-sol"),
            ),
            ("client without a base URL", sent(None, "gpt-6-sol")),
        ] {
            forget_warning(&warning(sent.model_id));
            let (logs, _guard) = record_logs();

            assert_eq!(send(&sent).await, formatted(&sent), "{name}");
            assert!(!logs.text().contains("accepts tools"), "{name}");
        }
    }

    #[tokio::test]
    async fn points_to_the_responses_api_when_tools_are_rejected_for_a_model_that_takes_none() {
        for sent in [
            sent(Some(OPENAI_URL), "gpt-6-astra"),
            effort(sent(Some(OPENAI_URL), "gpt-6.1-sol"), "none"),
            sent(Some(MANTLE_URL), "openai.gpt-6.1-sol"),
        ] {
            let error = reject(&sent, 400, Some("reasoning_effort")).await;

            let Error::Model(model_error) = &error else {
                panic!("{error:?}");
            };
            assert_eq!(
                model_error.message,
                format!(
                    "400 Function tools with reasoning_effort are not supported {} does not accept tools on the Chat Completions API with any reasoning_effort. Use OpenAIModel with api: OpenAIApi::Responses instead.",
                    sent.model_id
                )
            );
            let source = std::error::Error::source(&error)
                .unwrap()
                .downcast_ref::<HttpError>()
                .unwrap();
            assert_eq!(
                source.message(),
                "400 Function tools with reasoning_effort are not supported"
            );
            assert_eq!(source.status_code(), Some(400));
        }
    }

    #[tokio::test]
    async fn passes_an_error_through_unless_tools_are_rejected_for_a_model_that_takes_none() {
        for (name, sent, status, param) in [
            (
                "no tools",
                without_tools(sent(Some(OPENAI_URL), "gpt-6-astra")),
                400,
                Some("reasoning_effort"),
            ),
            (
                "model that takes tools",
                effort(sent(Some(OPENAI_URL), "gpt-6-sol"), "low"),
                400,
                Some("reasoning_effort"),
            ),
            (
                "other endpoint",
                sent(Some(PROXY_URL), "gpt-6-astra"),
                400,
                Some("reasoning_effort"),
            ),
            (
                "other param",
                sent(Some(OPENAI_URL), "gpt-6-astra"),
                400,
                Some("max_completion_tokens"),
            ),
            ("no param", sent(Some(OPENAI_URL), "gpt-6-astra"), 400, None),
            (
                "server error",
                sent(Some(OPENAI_URL), "gpt-6-astra"),
                500,
                Some("reasoning_effort"),
            ),
        ] {
            let error = reject(&sent, status, param).await;

            assert!(matches!(error, Error::Model(_)), "{name}: {error:?}");
            assert_eq!(
                error.to_string(),
                format!("{status} Function tools with reasoning_effort are not supported"),
                "{name}"
            );
        }
    }
}

mod params {
    use super::*;

    async fn stream_with_params(model_options: OpenAIModelOptions) -> JsonValue {
        let client = capture();
        collect(&model_with(&client, model_options), hi()).await.unwrap();
        client.last()
    }

    fn with_params(params: JsonValue) -> OpenAIModelOptions {
        OpenAIModelOptions {
            params: Some(params),
            ..pinned(OpenAIApi::Chat)
        }
    }

    #[tokio::test]
    async fn defaults_stream_options_to_include_usage_when_params_does_not_set_it() {
        let request = stream_with_params(with_params(json!({"seed": 42}))).await;
        assert_eq!(request["stream_options"], json!({"include_usage": true}));
    }

    #[tokio::test]
    async fn passes_a_set_stream_options_through_without_a_warning() {
        let (logs, _guard) = record_logs();
        let request = stream_with_params(with_params(json!({"stream_options": {"include_usage": false}}))).await;
        assert_eq!(request["stream_options"], json!({"include_usage": false}));
        assert!(!logs.text().contains("WARN"), "{}", logs.text());
    }

    #[tokio::test]
    async fn omits_every_params_key_set_to_null_and_passes_set_keys_through() {
        let request = stream_with_params(with_params(
            json!({"seed": null, "top_p": 0.8, "prompt_cache_key": null, "stream_options": null}),
        ))
        .await;
        let request = request.as_object().unwrap();
        for key in ["seed", "stream_options", "prompt_cache_key"] {
            assert!(!request.contains_key(key), "{key}");
        }
        assert_eq!(request["top_p"], json!(0.8));
    }

    #[tokio::test]
    async fn lets_dedicated_config_properties_win_over_a_null_params_key() {
        let request = stream_with_params(OpenAIModelOptions {
            temperature: Some(0.5),
            ..with_params(json!({"temperature": null}))
        })
        .await;
        assert_eq!(request["temperature"], json!(0.5));
    }

    #[tokio::test]
    async fn keeps_managed_fields_when_params_sets_them_to_null() {
        let request = stream_with_params(with_params(json!({"model": null, "messages": null, "stream": null}))).await;
        assert_eq!(request["model"], json!("gpt-5.4"));
        assert_eq!(request["stream"], json!(true));
        assert_eq!(
            request["messages"],
            json!([{"role": "user", "content": [{"type": "text", "text": "Hi"}]}])
        );
    }
}
