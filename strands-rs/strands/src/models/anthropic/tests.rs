//! Anthropic provider tests. This module covers construction, model info, config updates, stream
//! event handling, stale thinking recovery, structured output enforcement, token counting and API
//! version compatibility; the rest are in the submodules. A scripted [`MockClient`] stands in for the
//! Anthropic client; `http` exercises the real client against a local server.

mod caching;
mod formatting;
mod http;
mod server_tools;
mod summary;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use futures::future::BoxFuture;
use serde_json::json;

use super::client::{AnthropicClient, ClientRequest, EventStream, resolve_api_version};
use super::*;
use crate::logging::forget_warning;
use crate::models::AggregatedEvent;
use crate::models::StreamAggregatedResult;
use crate::test_support::{capture_logs, record_logs};
use crate::types::ToolSpec;

type Events = Vec<std::result::Result<JsonValue, HttpError>>;
type Script = Box<dyn Fn(usize) -> Events + Send + Sync>;

/// A scripted Messages client that records what it is sent.
pub(super) struct MockClient {
    script: Script,
    requests: Mutex<Vec<ClientRequest>>,
    beta: Option<Mutex<VecDeque<Events>>>,
    count: Option<Box<dyn Fn() -> std::result::Result<JsonValue, HttpError> + Send + Sync>>,
    count_requests: Mutex<Vec<ClientRequest>>,
}

impl MockClient {
    /// Answers call `n` (from 0) with `script(n)`.
    pub(super) fn new(script: impl Fn(usize) -> Events + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self::bare(Box::new(script)))
    }

    fn bare(script: Script) -> Self {
        Self {
            script,
            requests: Mutex::new(Vec::new()),
            beta: None,
            count: None,
            count_requests: Mutex::new(Vec::new()),
        }
    }

    /// Answers every call with `events`.
    pub(super) fn replying(events: Vec<JsonValue>) -> Arc<Self> {
        Self::new(move |_| events.iter().cloned().map(Ok).collect())
    }

    /// Answers every call with an empty stream.
    pub(super) fn capture() -> Arc<Self> {
        Self::new(|_| Vec::new())
    }

    /// A client with a beta API that answers each call with the next of `responses`.
    pub(super) fn with_beta(
        script: impl Fn(usize) -> Events + Send + Sync + 'static,
        responses: Vec<Events>,
    ) -> Arc<Self> {
        let mut client = Self::bare(Box::new(script));
        client.beta = Some(Mutex::new(responses.into()));
        Arc::new(client)
    }

    /// A client whose token counting answers with `count`.
    pub(super) fn counting(
        count: impl Fn() -> std::result::Result<JsonValue, HttpError> + Send + Sync + 'static,
    ) -> Arc<Self> {
        let mut client = Self::bare(Box::new(|_| Vec::new()));
        client.count = Some(Box::new(count));
        Arc::new(client)
    }

    pub(super) fn requests(&self) -> Vec<ClientRequest> {
        self.requests.lock().unwrap().clone()
    }

    pub(super) fn calls(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    /// The last request body sent to `stream` or `beta_stream`.
    pub(super) fn last(&self) -> JsonValue {
        self.requests.lock().unwrap().last().unwrap().body.clone()
    }

    pub(super) fn last_beta(&self) -> Option<String> {
        self.requests.lock().unwrap().last().unwrap().beta.clone()
    }

    pub(super) fn count_requests(&self) -> Vec<ClientRequest> {
        self.count_requests.lock().unwrap().clone()
    }
}

impl AnthropicClient for MockClient {
    fn stream(&self, request: ClientRequest) -> EventStream {
        let mut requests = self.requests.lock().unwrap();
        let index = requests.len();
        requests.push(request);
        Box::pin(futures::stream::iter((self.script)(index)))
    }

    fn beta_stream(&self, request: ClientRequest) -> Option<EventStream> {
        let responses = self.beta.as_ref()?;
        self.requests.lock().unwrap().push(request);
        let events = responses.lock().unwrap().pop_front().unwrap_or_default();
        Some(Box::pin(futures::stream::iter(events)))
    }

    fn count_tokens(
        &self,
        request: ClientRequest,
    ) -> Option<BoxFuture<'static, std::result::Result<JsonValue, HttpError>>> {
        let count = self.count.as_ref()?;
        self.count_requests.lock().unwrap().push(request);
        let result = count();
        Some(Box::pin(async move { result }))
    }
}

/// Serializes model construction, so a test watching for the default warnings sees them even when
/// another test constructs a model in between.
static CONSTRUCTION: Mutex<()> = Mutex::new(());

pub(super) fn constructing<T>(construct: impl FnOnce() -> T) -> T {
    let _guard = CONSTRUCTION.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    construct()
}

/// A model on `client` whose API version is unknown.
pub(super) fn model(client: &Arc<MockClient>, config: AnthropicModelConfig) -> AnthropicModel {
    let config = constructing(|| prepare_config(config)).unwrap();
    AnthropicModel::from_parts(config, Arc::clone(client) as Arc<dyn AnthropicClient>, Vec::new(), None)
}

/// A model on `client` set up as [`AnthropicModel::new`] sets up its own client, with
/// `custom_headers` as `ANTHROPIC_CUSTOM_HEADERS`.
pub(super) fn built_model(
    client: &Arc<MockClient>,
    options: AnthropicModelOptions,
    custom_headers: Option<&str>,
) -> AnthropicModel {
    let (config, _, client_config) = options.into_parts();
    let config = constructing(|| prepare_config(config)).unwrap();
    AnthropicModel::from_parts(
        config,
        Arc::clone(client) as Arc<dyn AnthropicClient>,
        client_betas(&client_config),
        Some(resolve_api_version(&client_config, custom_headers)),
    )
}

pub(super) fn config() -> AnthropicModelConfigBuilder {
    AnthropicModelConfig::builder()
}

pub(super) fn request(messages: Vec<Message>) -> ModelRequest {
    ModelRequest::builder().messages(messages).build()
}

pub(super) fn hi() -> ModelRequest {
    request(vec![Message::user("Hi")])
}

/// The stream's events as JSON.
pub(super) async fn collect(model: &AnthropicModel, request: ModelRequest) -> Result<Vec<JsonValue>> {
    let mut events = Vec::new();
    let mut stream = model.stream(request);
    while let Some(event) = stream.next().await {
        events.push(serde_json::to_value(event?).unwrap());
    }
    Ok(events)
}

/// The aggregated stream's items and result.
pub(super) async fn aggregate(
    model: &AnthropicModel,
    request: ModelRequest,
) -> Result<(Vec<AggregatedEvent>, StreamAggregatedResult)> {
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

/// An error response as the API sends it, with `message` in the body.
pub(super) fn api_error(status: u16, message: &str) -> HttpError {
    let body = json!({"type": "error", "error": {"type": "invalid_request_error", "message": message}});
    HttpError::status(status, Some(body), "", crate::models::http::ErrorPayload::Body)
}

/// An `error` event in the middle of a stream.
pub(super) fn stream_error(message: &str) -> HttpError {
    HttpError::event(&json!({"type": "error", "error": {"type": "api_error", "message": message}}).to_string())
}

pub(super) fn message_start(input_tokens: u64) -> JsonValue {
    json!({"type": "message_start", "message": {"role": "assistant", "usage": {"input_tokens": input_tokens}}})
}

pub(super) fn message_end(stop_reason: &str, output_tokens: u64) -> [JsonValue; 2] {
    [
        json!({"type": "message_delta", "delta": {"stop_reason": stop_reason}, "usage": {"output_tokens": output_tokens}}),
        json!({"type": "message_stop"}),
    ]
}

mod constructor {
    use super::*;

    #[test]
    fn creates_an_instance_with_default_configuration() {
        let options = AnthropicModelOptions::builder().api_key("test-key").build_options();
        let provider = constructing(|| AnthropicModel::with_env(options, &|_| None)).unwrap();
        let config = provider.config();
        assert_eq!(config.model_id.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(config.max_tokens, Some(128_000));
    }

    #[test]
    fn uses_provided_model_id() {
        let provider = model(
            &MockClient::capture(),
            config().model_id("claude-3-opus-20240229").build(),
        );
        assert_eq!(
            provider.get_config().model_id.as_deref(),
            Some("claude-3-opus-20240229")
        );
    }

    #[test]
    fn uses_api_key_from_constructor_parameter() {
        let options = AnthropicModelOptions::builder().api_key("sk-explicit").build_options();
        assert!(constructing(|| AnthropicModel::with_env(options, &|_| None)).is_ok());
    }

    #[test]
    fn uses_api_key_from_environment_variable() {
        let env = |name: &str| (name == "ANTHROPIC_API_KEY").then(|| "sk-from-env".to_owned());
        assert!(constructing(|| AnthropicModel::with_env(AnthropicModelOptions::default(), &env)).is_ok());
    }

    #[test]
    fn throws_error_when_no_api_key_is_available() {
        let env = |name: &str| (name == "ANTHROPIC_API_KEY").then(String::new);
        let error = constructing(|| AnthropicModel::with_env(AnthropicModelOptions::default(), &env)).unwrap_err();
        assert!(
            error.to_string().starts_with("Anthropic API key is required"),
            "{error}"
        );
    }

    fn construction_logs(options: AnthropicModelOptions) -> String {
        constructing(|| {
            forget_warning(&default_model_warning_message("claude-sonnet-4-6"));
            forget_warning(&default_max_tokens_warning_message(128_000));
            capture_logs(|| {
                AnthropicModel::with_env(options, &|name| (name == "ANTHROPIC_API_KEY").then(|| "sk".to_owned()))
                    .unwrap()
            })
            .1
        })
    }

    #[test]
    fn warns_when_max_tokens_is_not_explicitly_set() {
        let logs = construction_logs(AnthropicModelOptions::default());
        assert!(
            logs.contains("WARN") && logs.contains("using default maxTokens"),
            "{logs}"
        );
    }

    #[test]
    fn does_not_warn_when_max_tokens_is_explicitly_set() {
        let logs = construction_logs(AnthropicModelOptions::builder().max_tokens(4096).build_options());
        assert!(!logs.contains("using default maxTokens"), "{logs}");
    }

    #[test]
    fn does_not_warn_when_max_tokens_is_pinned_through_model_info() {
        let info = ModelInfo {
            limits: crate::models::ModelLimits {
                max_output_tokens: Some(2_000),
                ..Default::default()
            },
            ..Default::default()
        };
        let logs = construction_logs(AnthropicModelOptions::builder().model_info(info).build_options());
        assert!(!logs.contains("using default maxTokens"), "{logs}");
    }

    #[test]
    fn warns_when_model_id_is_not_explicitly_set() {
        let logs = construction_logs(AnthropicModelOptions::default());
        assert!(
            logs.contains("WARN") && logs.contains("using default modelId"),
            "{logs}"
        );
    }

    #[test]
    fn does_not_warn_when_model_id_is_explicitly_set() {
        let logs = construction_logs(
            AnthropicModelOptions::builder()
                .model_id("claude-3-opus-20240229")
                .build_options(),
        );
        assert!(!logs.contains("using default modelId"), "{logs}");
    }

    fn base(model_id: &str, max_tokens: u64, context_window_limit: Option<u64>) -> BaseModelConfig {
        BaseModelConfig {
            model_id: Some(model_id.to_owned()),
            max_tokens: Some(max_tokens),
            context_window_limit,
            ..Default::default()
        }
    }

    #[test]
    fn auto_populates_context_window_limit_from_model_id_lookup() {
        let provider = model(&MockClient::capture(), config().model_id("claude-sonnet-4-6").build());
        assert_eq!(
            provider.get_config(),
            base("claude-sonnet-4-6", 128_000, Some(1_000_000))
        );
    }

    #[test]
    fn auto_populates_context_window_limit_for_default_model_id() {
        let provider = model(&MockClient::capture(), AnthropicModelConfig::default());
        assert_eq!(
            provider.get_config(),
            base("claude-sonnet-4-6", 128_000, Some(1_000_000))
        );
    }

    #[test]
    fn does_not_override_explicit_context_window_limit() {
        let provider = model(
            &MockClient::capture(),
            config()
                .model_id("claude-sonnet-4-6")
                .context_window_limit(100_000)
                .build(),
        );
        assert_eq!(provider.get_config(), base("claude-sonnet-4-6", 128_000, Some(100_000)));
    }

    #[test]
    fn leaves_context_window_limit_undefined_for_unknown_model_ids() {
        let provider = model(&MockClient::capture(), config().model_id("unknown-model").build());
        assert_eq!(provider.get_config(), base("unknown-model", 64_000, None));
    }
}

mod info {
    use super::*;

    fn info_of(config: AnthropicModelConfig) -> ModelInfo {
        model(&MockClient::capture(), config).model_info()
    }

    #[test]
    fn reads_cache_points_from_the_shared_model_info() {
        let info = info_of(config().model_id("claude-sonnet-4-6").build());
        assert_eq!(
            info.capabilities.prompt_caching,
            Some(crate::models::PromptCaching::CachePoints)
        );
    }

    #[test]
    fn reports_temporary_messages_from_the_shared_model_info() {
        for (model_id, expected) in [
            ("claude-opus-5-5", true),
            ("claude-opus-5-5-20260401", true),
            ("claude-sonnet-5", false),
            ("claude-sonnet-4-6", false),
        ] {
            let info = info_of(config().model_id(model_id).build());
            assert_eq!(info.capabilities.temporary_messages, Some(expected), "{model_id}");
        }
    }

    #[test]
    fn lets_the_model_info_config_turn_temporary_messages_off() {
        let override_info = ModelInfo {
            capabilities: ModelCapabilities {
                temporary_messages: Some(false),
                ..Default::default()
            },
            ..Default::default()
        };
        let info = info_of(config().model_id("claude-opus-5-5").model_info(override_info).build());
        assert_eq!(info.capabilities.temporary_messages, Some(false));
    }

    #[test]
    fn re_resolves_the_default_max_tokens_when_model_id_changes() {
        let provider = model(&MockClient::capture(), config().model_id("claude-sonnet-4-6").build());
        assert_eq!(provider.get_config().max_tokens, Some(128_000));

        provider
            .update_config(config().model_id("claude-opus-4-1").build())
            .unwrap();

        assert_eq!(provider.get_config().max_tokens, Some(32_000));
        assert_eq!(provider.model_info().limits.max_output_tokens, Some(32_000));
    }

    #[test]
    fn defaults_max_tokens_to_an_info_override_of_the_output_ceiling() {
        let override_info = ModelInfo {
            limits: crate::models::ModelLimits {
                max_output_tokens: Some(8_000),
                ..Default::default()
            },
            ..Default::default()
        };
        let provider = model(
            &MockClient::capture(),
            config().model_id("claude-sonnet-4-6").model_info(override_info).build(),
        );
        assert_eq!(provider.get_config().max_tokens, Some(8_000));
        assert_eq!(provider.model_info().limits.max_output_tokens, Some(8_000));
    }

    #[test]
    fn defaults_max_tokens_to_the_model_output_ceiling_from_the_shared_model_info() {
        let max_tokens = |config: AnthropicModelConfig| model(&MockClient::capture(), config).get_config().max_tokens;
        assert_eq!(
            max_tokens(config().model_id("claude-opus-4-1-20250805").build()),
            Some(32_000)
        );
        assert_eq!(max_tokens(config().model_id("claude-unknown-9").build()), Some(64_000));
        assert_eq!(
            max_tokens(config().model_id("claude-opus-5-5").max_tokens(4_096).build()),
            Some(4_096)
        );
    }
}

mod update_config {
    use super::*;

    #[test]
    fn merges_new_config_with_existing_config() {
        let provider = model(&MockClient::capture(), config().temperature(0.5).build());
        provider
            .update_config(config().temperature(0.8).max_tokens(8192).build())
            .unwrap();
        let config = provider.config();
        assert_eq!((config.temperature, config.max_tokens), (Some(0.8), Some(8192)));
    }

    #[test]
    fn re_resolves_context_window_limit_when_model_id_changes_and_it_was_auto_resolved() {
        let provider = model(&MockClient::capture(), AnthropicModelConfig::default());
        assert_eq!(provider.get_config().context_window_limit, Some(1_000_000));

        Model::update_config(
            &provider,
            BaseModelConfig::builder()
                .model_id("claude-sonnet-4-5-20250929")
                .build(),
        )
        .unwrap();
        assert_eq!(provider.get_config().context_window_limit, Some(200_000));
    }

    #[test]
    fn preserves_explicit_context_window_limit_when_model_id_changes() {
        let provider = model(&MockClient::capture(), config().context_window_limit(50_000).build());
        provider
            .update_config(config().model_id("claude-sonnet-4-6").build())
            .unwrap();
        assert_eq!(provider.get_config().context_window_limit, Some(50_000));
    }
}

mod stream_event_handling {
    use super::*;

    #[tokio::test]
    async fn yields_correct_event_sequence_for_simple_text_response() {
        let [delta, stop] = message_end("end_turn", 5);
        let client = MockClient::replying(vec![
            message_start(10),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}),
            json!({"type": "content_block_stop", "index": 0}),
            delta,
            stop,
        ]);

        let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();

        assert_eq!(
            events,
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent"}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}),
                json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            ]
        );
    }

    #[tokio::test]
    async fn reports_a_total_that_includes_cache_reads_and_writes() {
        let [delta, stop] = message_end("end_turn", 7);
        let client = MockClient::replying(vec![
            json!({"type": "message_start", "message": {"role": "assistant", "usage": {"input_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 50}}}),
            delta,
            stop,
        ]);

        let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();

        assert_eq!(
            events[1],
            json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 5, "outputTokens": 7, "totalTokens": 162, "cacheReadInputTokens": 100, "cacheWriteInputTokens": 50}})
        );
    }

    #[tokio::test]
    async fn handles_tool_use_events() {
        let [delta, stop] = message_end("tool_use", 10);
        let client = MockClient::replying(vec![
            message_start(10),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "tool_1", "name": "calc"}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"a\""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": ":1}"}}),
            json!({"type": "content_block_stop", "index": 0}),
            delta,
            stop,
        ]);

        let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();

        for expected in [
            json!({"type": "modelContentBlockStartEvent", "start": {"type": "toolUseStart", "name": "calc", "toolUseId": "tool_1"}}),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "toolUseInputDelta", "input": "{\"a\""}}),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "toolUseInputDelta", "input": ":1}"}}),
            json!({"type": "modelMessageStopEvent", "stopReason": "toolUse"}),
        ] {
            assert!(events.contains(&expected), "{expected}");
        }
    }

    #[tokio::test]
    async fn maps_anthropic_stop_reason_refusal_to_refusal() {
        let [delta, stop] = message_end("refusal", 1);
        let client = MockClient::replying(vec![message_start(1), delta, stop]);

        let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();

        assert!(events.contains(&json!({"type": "modelMessageStopEvent", "stopReason": "refusal"})));
    }

    #[tokio::test]
    async fn handles_thinking_reasoning_events() {
        let [delta, stop] = message_end("end_turn", 20);
        let client = MockClient::replying(vec![
            message_start(10),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Hmm..."}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig_123"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Answer"}}),
            json!({"type": "content_block_stop", "index": 1}),
            delta,
            stop,
        ]);

        let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();

        assert!(events.contains(
            &json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "reasoningContentDelta", "text": "Hmm..."}})
        ));
        assert!(events.contains(
            &json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "reasoningContentDelta", "signature": "sig_123"}})
        ));
    }

    #[tokio::test]
    async fn handles_redacted_thinking_events() {
        let [delta, stop] = message_end("end_turn", 5);
        let client = MockClient::replying(vec![
            message_start(10),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "redacted_thinking", "data": "data"}}),
            json!({"type": "content_block_stop", "index": 0}),
            delta,
            stop,
        ]);

        let mut stream = model(&client, AnthropicModelConfig::default()).stream(hi());
        let mut redacted = None;
        while let Some(event) = stream.next().await {
            if let ModelStreamEvent::ContentBlockDelta(delta) = event.unwrap()
                && let crate::models::streaming::ContentBlockDelta::ReasoningContent(reasoning) = delta.delta
            {
                redacted = reasoning.redacted_content;
            }
        }

        assert_eq!(redacted, Some(vec![117, 171, 90]));
    }

    // Regression for #4587: redacted thinking data must reach the next request as the verbatim
    // base64 string across a serialization round trip.
    #[tokio::test]
    async fn preserves_redacted_thinking_data_through_stream_serialization_and_request_round_trips() {
        let redacted_data = "EmwKAgIBc2VjcmV0LWRhdGE=";
        let decoded = vec![18, 108, 10, 2, 2, 1, 115, 101, 99, 114, 101, 116, 45, 100, 97, 116, 97];
        let [delta, stop] = message_end("end_turn", 5);
        let client = MockClient::replying(vec![
            message_start(10),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "redacted_thinking", "data": redacted_data}}),
            json!({"type": "content_block_stop", "index": 0}),
            delta,
            stop,
        ]);

        let (_, result) = aggregate(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();
        let ContentBlock::Reasoning(streamed) = &result.message.content[0] else {
            panic!("expected a reasoning block");
        };
        assert_eq!(streamed.redacted_content.as_ref(), Some(&decoded));

        let restored: Message = serde_json::from_value(serde_json::to_value(&result.message).unwrap()).unwrap();
        let ContentBlock::Reasoning(restored_block) = &restored.content[0] else {
            panic!("expected a reasoning block");
        };
        assert_eq!(restored_block.redacted_content.as_ref(), Some(&decoded));

        let capture = MockClient::capture();
        collect(
            &model(&capture, AnthropicModelConfig::default()),
            request(vec![restored]),
        )
        .await
        .unwrap();
        assert_eq!(
            capture.last()["messages"][0]["content"],
            json!([{"type": "redacted_thinking", "data": redacted_data}])
        );
    }

    #[tokio::test]
    async fn handles_text_payload_directly_in_content_block_start_optimization() {
        let [delta, stop] = message_end("end_turn", 5);
        let client = MockClient::replying(vec![
            message_start(10),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "Full text"}}),
            json!({"type": "content_block_stop", "index": 0}),
            delta,
            stop,
        ]);

        let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();

        assert!(events.contains(
            &json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Full text"}})
        ));
    }

    fn failing(error: fn() -> HttpError) -> Arc<MockClient> {
        MockClient::new(move |_| vec![Ok(json!({"type": "ping"})), Err(error())])
    }

    #[tokio::test]
    async fn handles_error_during_stream() {
        let client = failing(|| stream_error("API Error"));
        let error = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Model(_)), "{error:?}");
        assert!(error.to_string().contains("API Error"), "{error}");
    }

    #[tokio::test]
    async fn maps_overload_error_to_context_window_overflow_error() {
        let client = failing(|| stream_error("prompt is too long"));
        let error = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap_err();
        assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
    }

    #[tokio::test]
    async fn maps_overflow_phrase_to_context_window_overflow_error() {
        for phrase in [
            "input is too long",
            "input length exceeds context window",
            "input and output tokens exceed your context limit",
            "max_tokens exceeded",
            "input too long",
        ] {
            let client = MockClient::new(move |_| vec![Err(api_error(400, phrase))]);
            let error = collect(&model(&client, AnthropicModelConfig::default()), hi())
                .await
                .unwrap_err();
            assert!(matches!(error, Error::ContextWindowOverflow(_)), "{phrase}: {error:?}");
        }
    }

    #[tokio::test]
    async fn matches_overflow_phrases_case_insensitively() {
        let client = failing(|| stream_error("PROMPT IS TOO LONG: 200000 tokens"));
        let error = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap_err();
        assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
    }

    #[tokio::test]
    async fn maps_http_429_error_to_model_throttled_error() {
        let client = MockClient::new(|_| vec![Err(api_error(429, "Rate limit exceeded"))]);
        let error = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap_err();
        assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
        assert!(error.to_string().contains("Rate limit exceeded"), "{error}");
        assert!(std::error::Error::source(&error).is_some());
    }

    #[tokio::test]
    async fn maps_a_transport_failure_to_model_network_error() {
        let client = MockClient::new(|_| vec![Err(HttpError::connection("reset")), Err(HttpError::timeout())]);
        let error = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap_err();
        assert!(matches!(error, Error::ModelNetwork(_)), "{error:?}");
        assert_eq!(error.to_string(), "Connection error.");
    }
}

mod stale_thinking_recovery {
    use super::*;

    const BINDING_MESSAGE: &str = "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.";

    fn binding_error() -> HttpError {
        api_error(400, BINDING_MESSAGE)
    }

    fn drop_block_thinking() -> JsonValue {
        json!({"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}})
    }

    fn adaptive() -> JsonValue {
        json!({"thinking": {"type": "adaptive"}})
    }

    /// Rejects the first call with `first`, then the second with `retry` when given, then succeeds.
    fn rejecting_once(first: fn() -> HttpError, retry: Option<fn() -> HttpError>) -> Arc<MockClient> {
        MockClient::new(move |call| match (call, retry) {
            (0, _) => vec![Err(first())],
            (1, Some(retry)) => vec![Err(retry())],
            _ => vec![Ok(
                json!({"type": "message_start", "message": {"role": "assistant", "usage": {}}}),
            )],
        })
    }

    fn sent(client: &MockClient) -> Vec<(JsonValue, Option<String>)> {
        client
            .requests()
            .into_iter()
            .map(|request| (request.body["thinking"].clone(), request.beta))
            .collect()
    }

    #[tokio::test]
    async fn retries_once_with_drop_block_and_keeps_it_on_for_later_requests() {
        let (logs, _guard) = record_logs();
        let client = rejecting_once(binding_error, None);
        let provider = model(
            &client,
            config()
                .model_id("m1")
                .betas(vec!["other-beta".to_owned()])
                .params(adaptive())
                .build(),
        );

        let events = collect(&provider, hi()).await.unwrap();

        assert_eq!(
            events[0],
            json!({"type": "modelMessageStartEvent", "role": "assistant"})
        );
        assert!(logs.text().contains("retrying with drop_block"));
        let expected_beta = Some("other-beta,thinking-binding-controls-2026-08-01".to_owned());
        assert_eq!(
            sent(&client),
            vec![
                (json!({"type": "adaptive"}), Some("other-beta".to_owned())),
                (drop_block_thinking(), expected_beta.clone()),
            ]
        );

        collect(&provider, hi()).await.unwrap();

        assert_eq!(client.calls(), 3);
        assert_eq!(sent(&client)[2], (drop_block_thinking(), expected_beta));
    }

    #[tokio::test]
    async fn keeps_betas_from_client_default_headers_on_the_retry() {
        for (headers, betas) in [
            (vec![("anthropic-beta", "client-beta")], "client-beta,"),
            (vec![("Anthropic-Beta", "a"), ("anthropic-beta", "b")], "a,b,"),
            (vec![("anthropic-beta", "a, b")], "a,b,"),
            (vec![], ""),
        ] {
            let client = rejecting_once(binding_error, None);
            let client_config = AnthropicClientConfig {
                default_headers: headers
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                    .collect(),
                ..Default::default()
            };
            let options = AnthropicModelOptions::builder()
                .model_id("m1")
                .params(adaptive())
                .client_config(client_config)
                .build_options();
            let provider = built_model(&client, options, None);

            collect(&provider, hi()).await.unwrap();

            assert_eq!(
                sent(&client).last().unwrap().1,
                Some(format!("{betas}thinking-binding-controls-2026-08-01")),
                "{headers:?}"
            );
        }
    }

    #[tokio::test]
    async fn maps_a_throttle_and_a_context_window_overflow_on_the_retry_to_their_sdk_errors() {
        let client = rejecting_once(binding_error, Some(|| api_error(429, "Rate limit exceeded")));
        let provider = model(&client, config().model_id("m1").params(adaptive()).build());
        let error = collect(&provider, hi()).await.unwrap_err();
        assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
        assert_eq!(client.calls(), 2);

        let client = rejecting_once(binding_error, Some(|| api_error(400, "prompt is too long")));
        let provider = model(&client, config().model_id("m1").params(adaptive()).build());
        let error = collect(&provider, hi()).await.unwrap_err();
        assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
        assert_eq!(client.calls(), 2);
    }

    #[tokio::test]
    async fn re_throws_a_second_binding_error_without_retrying_again() {
        let client = rejecting_once(binding_error, Some(binding_error));
        let provider = model(&client, config().model_id("m1").params(adaptive()).build());

        let error = collect(&provider, hi()).await.unwrap_err();

        assert!(error.to_string().contains("bound to a different conversation"));
        assert_eq!(client.calls(), 2);
    }

    fn forced() -> ModelRequest {
        ModelRequest {
            tool_specs: vec![
                ToolSpec::new("calc", "Calculator").with_input_schema(json!({"type": "object", "properties": {}})),
            ],
            tool_choice: Some(ToolChoice::Any),
            ..hi()
        }
    }

    #[tokio::test]
    async fn re_throws_the_binding_error_with_name() {
        let caller_set =
            json!({"thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "error"}}});
        for (params, request) in [(Some(caller_set), hi()), (None, forced())] {
            let client = rejecting_once(binding_error, None);
            let provider = model(
                &client,
                AnthropicModelConfig {
                    model_id: Some("m1".to_owned()),
                    params,
                    ..Default::default()
                },
            );

            let error = collect(&provider, request).await.unwrap_err();

            assert!(error.to_string().contains("bound to a different conversation"));
            assert_eq!(client.calls(), 1);
        }
    }

    #[tokio::test]
    async fn retries_with_adaptive_thinking_when_no_thinking_config_is_set() {
        let client = rejecting_once(binding_error, None);
        let provider = model(&client, config().model_id("m1").build());

        collect(&provider, hi()).await.unwrap();
        collect(&provider, hi()).await.unwrap();
        collect(&provider, forced()).await.unwrap();

        let beta = Some("thinking-binding-controls-2026-08-01".to_owned());
        assert_eq!(
            sent(&client),
            vec![
                (JsonValue::Null, None),
                (drop_block_thinking(), beta.clone()),
                (drop_block_thinking(), beta.clone()),
                (JsonValue::Null, beta),
            ]
        );
    }

    #[tokio::test]
    async fn does_not_keep_drop_block_on_after_a_rejected_retry() {
        let client = rejecting_once(
            binding_error,
            Some(|| api_error(400, "`temperature` may only be set to 1")),
        );
        let provider = model(&client, config().model_id("m1").temperature(0.2).build());

        let error = collect(&provider, hi()).await.unwrap_err();
        assert!(error.to_string().contains("temperature"), "{error}");
        collect(&provider, hi()).await.unwrap();

        assert_eq!(sent(&client).last().unwrap().0, JsonValue::Null);
    }

    #[tokio::test]
    async fn re_throws_the_binding_message_on_a_non_400_error() {
        let client = rejecting_once(|| api_error(500, BINDING_MESSAGE), None);
        let provider = model(&client, config().model_id("m1").params(adaptive()).build());

        let error = collect(&provider, hi()).await.unwrap_err();

        assert!(error.to_string().contains("bound to a different conversation"));
        assert_eq!(client.calls(), 1);
    }

    #[tokio::test]
    async fn stops_dropping_stale_thinking_after_the_model_changes() {
        let client = rejecting_once(binding_error, None);
        let provider = model(&client, config().model_id("m1").params(adaptive()).build());
        collect(&provider, hi()).await.unwrap();

        provider.update_config(config().model_id("m2").build()).unwrap();
        collect(&provider, hi()).await.unwrap();

        assert_eq!(sent(&client).last().unwrap(), &(json!({"type": "adaptive"}), None));
    }
}

mod structured_output_enforcement {
    use super::*;

    const FORCED_REJECTION: &str = "tool_choice: type \"tool\" and \"any\" are not supported for this model.";
    const NATIVE_REJECTION: &str = "output_config.format: Extra inputs are not permitted";

    fn schema() -> JsonValue {
        json!({
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
            "required": ["name", "age"],
            "additionalProperties": false
        })
    }

    fn structured(schema: JsonValue) -> ModelRequest {
        ModelRequest {
            messages: vec![Message::user("Generate a person")],
            tool_specs: vec![ToolSpec::new("strands_structured_output", "Output").with_input_schema(schema.clone())],
            tool_choice: Some(ToolChoice::tool("strands_structured_output")),
            structured_output_schema: Some(schema),
            ..Default::default()
        }
    }

    /// Rejects each call with the next error, then succeeds.
    fn rejecting(errors: Vec<(u16, &'static str)>) -> Arc<MockClient> {
        MockClient::new(move |call| match errors.get(call) {
            Some((status, message)) => vec![Err(api_error(*status, message))],
            None => vec![Ok(
                json!({"type": "message_start", "message": {"role": "assistant", "usage": {}}}),
            )],
        })
    }

    fn mechanism_of(request: &JsonValue) -> &'static str {
        if request["tool_choice"]["type"] == "tool" {
            return "forced";
        }
        if request["output_config"]["format"].is_object() {
            "native"
        } else {
            "auto"
        }
    }

    fn mechanisms(client: &MockClient) -> Vec<&'static str> {
        client
            .requests()
            .iter()
            .map(|request| mechanism_of(&request.body))
            .collect()
    }

    // The learned rejections are process-wide, so each test uses its own model id.
    #[tokio::test]
    async fn falls_back_to_the_next_mechanism_and_remembers_it() {
        type Case = (&'static str, Vec<(u16, &'static str)>, Vec<&'static str>);
        let cases: [Case; 3] = [
            ("so-none", vec![], vec!["forced"]),
            ("so-forced", vec![(400, FORCED_REJECTION)], vec!["forced", "native"]),
            (
                "so-both",
                vec![(400, FORCED_REJECTION), (400, NATIVE_REJECTION)],
                vec!["forced", "native", "auto"],
            ),
        ];
        for (model_id, rejections, expected) in cases {
            let client = rejecting(rejections);
            let provider = model(&client, config().model_id(model_id).build());

            collect(&provider, structured(schema())).await.unwrap();
            assert_eq!(mechanisms(&client), expected, "{model_id}");

            let calls = client.calls();
            collect(&provider, structured(schema())).await.unwrap();
            assert_eq!(mechanisms(&client)[calls..], [*expected.last().unwrap()], "{model_id}");
        }
    }

    #[tokio::test]
    async fn sends_native_output_with_tool_choice_none_keeping_the_tools_and_other_output_config_settings() {
        let client = rejecting(vec![]);
        let params = json!({"output_config": {"effort": "high"}});
        let provider = model(&client, config().model_id("so-native").params(params).build());

        let mut request = structured(schema());
        request.tool_choice = Some(ToolChoice::Auto);
        collect(&provider, request).await.unwrap();

        let sent = client.last();
        assert_eq!(sent["tool_choice"], json!({"type": "none"}));
        assert_eq!(
            sent["output_config"],
            json!({"effort": "high", "format": {"type": "json_schema", "schema": to_native_output_schema(&schema()).unwrap()}})
        );
        assert_eq!(sent["tools"][0]["name"], "strands_structured_output");
        assert_eq!(sent["tools"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn uses_auto_tool_choice_for_a_schema_native_output_cannot_represent() {
        let client = rejecting(vec![(400, FORCED_REJECTION)]);
        let provider = model(&client, config().model_id("so-record").build());
        let record = json!({
            "type": "object",
            "properties": {"scores": {"type": "object", "additionalProperties": {"type": "number"}}},
            "required": ["scores"],
            "additionalProperties": false
        });

        collect(&provider, structured(record)).await.unwrap();

        assert_eq!(mechanisms(&client), ["forced", "auto"]);
        assert_eq!(client.requests()[1].body["tool_choice"], json!({"type": "auto"}));
    }

    #[tokio::test]
    async fn retries_with_drop_block_before_trying_the_next_mechanism() {
        let client = rejecting(vec![
            (
                400,
                "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
            ),
            (400, FORCED_REJECTION),
        ]);
        let params = json!({"thinking": {"type": "adaptive"}});
        let provider = model(&client, config().model_id("so-binding").params(params).build());

        collect(&provider, structured(schema())).await.unwrap();

        let sent: Vec<(&str, bool)> = client
            .requests()
            .iter()
            .map(|request| {
                (
                    mechanism_of(&request.body),
                    request.body["thinking"].get("block_binding").is_some(),
                )
            })
            .collect();
        assert_eq!(sent, [("forced", false), ("forced", true), ("native", true)]);
    }

    #[tokio::test]
    async fn re_throws_without_retrying() {
        let without_schema = ModelRequest {
            structured_output_schema: None,
            ..structured(schema())
        };
        let cases = [
            (without_schema, 400, FORCED_REJECTION),
            (structured(schema()), 400, "something else"),
            (
                structured(schema()),
                500,
                "tool_choice: type \"tool\" and \"any\" are not supported",
            ),
        ];
        for (index, (request, status, message)) in cases.into_iter().enumerate() {
            let client = rejecting(vec![(status, message)]);
            let provider = model(&client, config().model_id(format!("so-rethrow-{index}")).build());

            let error = collect(&provider, request).await.unwrap_err();

            assert_eq!(error.to_string(), api_error(status, message).to_string());
            assert_eq!(client.calls(), 1, "{message}");
        }
    }
}

mod count_tokens {
    use super::*;

    fn messages() -> Vec<Message> {
        vec![Message::user("hello")]
    }

    fn counting_model(client: &Arc<MockClient>, native: Option<bool>) -> AnthropicModel {
        model(
            client,
            AnthropicModelConfig {
                model_id: Some("claude-sonnet-4-6".to_owned()),
                use_native_token_count: native,
                ..Default::default()
            },
        )
    }

    fn answering(tokens: u64) -> Arc<MockClient> {
        MockClient::counting(move || Ok(json!({"input_tokens": tokens})))
    }

    #[tokio::test]
    async fn should_use_heuristic_by_default_when_use_native_token_count_is_not_set() {
        let client = answering(99);
        let count = counting_model(&client, None)
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap();
        assert!(client.count_requests().is_empty());
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn should_return_native_token_count_on_success() {
        let client = answering(42);
        let count = counting_model(&client, Some(true))
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap();
        assert_eq!(count, 42);
        assert_eq!(client.count_requests().len(), 1);
    }

    #[tokio::test]
    async fn should_fall_back_to_the_heuristic_when_the_client_has_no_count_tokens() {
        let count = counting_model(&MockClient::capture(), Some(true))
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn should_include_system_prompt_in_request() {
        let client = answering(55);
        let options = CountTokensOptions::builder().system_prompt("Be helpful.").build();
        let count = counting_model(&client, Some(true))
            .count_tokens(&messages(), options)
            .await
            .unwrap();
        assert_eq!(count, 55);
        assert_eq!(
            client.count_requests()[0],
            ClientRequest {
                body: json!({
                    "model": "claude-sonnet-4-6",
                    "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
                    "system": "Be helpful."
                }),
                beta: None
            }
        );
    }

    #[tokio::test]
    async fn should_include_tool_specs_in_request() {
        let client = answering(100);
        let spec =
            ToolSpec::new("test_tool", "A test tool").with_input_schema(json!({"type": "object", "properties": {}}));
        let options = CountTokensOptions::builder().tool_specs(vec![spec]).build();
        let count = counting_model(&client, Some(true))
            .count_tokens(&messages(), options)
            .await
            .unwrap();
        assert_eq!(count, 100);
        assert_eq!(
            client.count_requests()[0].body,
            json!({
                "model": "claude-sonnet-4-6",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
                "tools": [{"name": "test_tool", "description": "A test tool", "input_schema": {"type": "object", "properties": {}}}]
            })
        );
    }

    #[tokio::test]
    async fn should_strip_max_tokens_from_request() {
        let client = answering(10);
        counting_model(&client, Some(true))
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap();
        assert_eq!(
            client.count_requests()[0].body,
            json!({
                "model": "claude-sonnet-4-6",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]
            })
        );
    }

    #[tokio::test]
    async fn should_fall_back_to_estimation_on_api_error() {
        let client = MockClient::counting(|| Err(api_error(400, "Unsupported")));
        let count = counting_model(&client, Some(true))
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn should_fall_back_to_estimation_on_generic_exception() {
        let client = MockClient::counting(|| Err(HttpError::connection("Connection failed")));
        let count = counting_model(&client, Some(true))
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn should_skip_native_api_and_use_heuristic_when_use_native_token_count_is_false() {
        let client = answering(99);
        let count = counting_model(&client, Some(false))
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap();
        assert!(client.count_requests().is_empty());
        assert_eq!(count, 2);
    }
}

mod api_version_compatibility {
    use super::*;

    fn hello() -> ModelRequest {
        request(vec![Message::user("Hello")])
    }

    fn hello_request() -> JsonValue {
        json!({
            "model": "m1",
            "max_tokens": 64000,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}],
            "stream": true
        })
    }

    fn pdf() -> ContentBlock {
        ContentBlock::Document(crate::types::DocumentBlock::new(
            "doc.pdf",
            crate::types::DocumentFormat::Pdf,
            crate::types::DocumentSource::Bytes(vec![1, 2, 3]),
        ))
    }

    fn headers(pairs: &[(&str, &str)]) -> AnthropicClientConfig {
        AnthropicClientConfig {
            default_headers: pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
            ..Default::default()
        }
    }

    fn options(config: AnthropicModelConfig, client_config: AnthropicClientConfig) -> AnthropicModelOptions {
        AnthropicModelOptions {
            model_id: config.model_id,
            temperature: config.temperature,
            top_p: config.top_p,
            params: config.params,
            client_config: Some(client_config),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn rejects_temperature_when_anthropic_custom_headers_pins_the_current_api_version() {
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            options(
                config().model_id("m1").temperature(0.2).build(),
                AnthropicClientConfig::default(),
            ),
            Some("anthropic-version: 2026-10-21"),
        );

        let error = collect(&provider, hello()).await.unwrap_err();

        assert!(
            error.to_string().starts_with(
                "temperature is not supported by Anthropic API version 2026-10-21, pinned by the ANTHROPIC_CUSTOM_HEADERS environment variable"
            ),
            "{error}"
        );
        assert_eq!(client.calls(), 0);
    }

    #[tokio::test]
    async fn leaves_the_check_to_the_api_for_an_injected_client() {
        let client = MockClient::capture();
        collect(&model(&client, config().temperature(0.2).build()), hello())
            .await
            .unwrap();
        assert_eq!(client.last()["temperature"], 0.2);
    }

    #[tokio::test]
    async fn rejects_temperature_when_the_current_api_version_is_pinned() {
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            options(
                config().model_id("m1").temperature(0.2).build(),
                headers(&[("anthropic-version", "2026-10-21")]),
            ),
            None,
        );

        let error = collect(&provider, hello()).await.unwrap_err();

        assert!(
            error.to_string().starts_with(
                "temperature is not supported by Anthropic API version 2026-10-21, pinned by client_config.default_headers['anthropic-version']"
            ),
            "{error}"
        );
    }

    #[tokio::test]
    async fn rejects_removed_sampling_params_before_sending_the_request() {
        let cases = [
            (config().temperature(0.2).build(), "temperature is"),
            (config().top_p(0.9).build(), "top_p is"),
            (config().params(json!({"top_k": 3})).build(), "top_k is"),
            (
                config().temperature(0.2).params(json!({"top_p": 0.9})).build(),
                "temperature, top_p are",
            ),
        ];
        for (mut config, params) in cases {
            config.model_id = Some("m1".to_owned());
            let client = MockClient::capture();
            let provider = built_model(&client, options(config, AnthropicClientConfig::default()), None);

            let error = collect(&provider, hello()).await.unwrap_err().to_string();

            let expected = format!(
                "{params} not supported by Anthropic API version 2026-10-21, the default for strands {}",
                env!("CARGO_PKG_VERSION")
            );
            assert!(error.starts_with(&expected), "{error}");
            assert!(error.contains("'anthropic-version': '2023-06-01'"), "{error}");
            assert_eq!(client.calls(), 0);
        }
    }

    #[tokio::test]
    async fn sends_temperature_when_the_previous_api_version_is_pinned() {
        for pairs in [
            vec![("Anthropic-Version", "2023-06-01")],
            vec![("anthropic-version", "2026-10-21"), ("anthropic-version", "2023-06-01")],
        ] {
            let client = MockClient::capture();
            let provider = built_model(
                &client,
                options(config().model_id("m1").temperature(0.2).build(), headers(&pairs)),
                None,
            );

            collect(&provider, hello()).await.unwrap();

            let mut expected = hello_request();
            expected["temperature"] = json!(0.2);
            assert_eq!(client.last(), expected, "{pairs:?}");
        }
    }

    #[tokio::test]
    async fn sends_sampling_params_on_the_previous_api_version() {
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            options(
                config()
                    .model_id("m1")
                    .temperature(0.2)
                    .params(json!({"top_k": 3}))
                    .build(),
                headers(&[("anthropic-version", "2023-06-01")]),
            ),
            None,
        );

        collect(&provider, hello()).await.unwrap();

        let mut expected = hello_request();
        expected["temperature"] = json!(0.2);
        expected["top_k"] = json!(3);
        assert_eq!(client.last(), expected);
    }

    /// The top-level keys go out in a fixed order, so a serialized request matches the other Strands
    /// SDKs byte for byte.
    #[tokio::test]
    async fn sends_top_level_keys_in_ts_order() {
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            AnthropicModelOptions {
                stop_sequences: Some(vec!["STOP".to_owned()]),
                ..options(
                    config()
                        .model_id("m1")
                        .temperature(0.2)
                        .top_p(0.9)
                        .params(json!({"top_k": 3}))
                        .build(),
                    headers(&[("anthropic-version", "2023-06-01")]),
                )
            },
            None,
        );
        let tools = ModelRequest {
            system_prompt: Some("sys".into()),
            tool_specs: vec![ToolSpec::new("calc", "Calculate").with_input_schema(json!({"type": "object"}))],
            tool_choice: Some(ToolChoice::Auto),
            ..hello()
        };

        collect(&provider, tools).await.unwrap();

        assert_eq!(
            client.last().to_string(),
            concat!(
                r#"{"model":"m1","max_tokens":64000,"#,
                r#""messages":[{"role":"user","content":[{"type":"text","text":"Hello"}]}],"stream":true,"#,
                r#""system":"sys","tool_choice":{"type":"auto"},"stop_sequences":["STOP"],"#,
                r#""temperature":0.2,"top_p":0.9,"top_k":3,"#,
                r#""tools":[{"name":"calc","description":"Calculate","input_schema":{"type":"object"}}]}"#
            )
        );
    }

    #[tokio::test]
    async fn lets_a_client_config_pin_win_over_a_differently_cased_anthropic_custom_headers_pin() {
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            options(
                config().model_id("m1").temperature(0.2).build(),
                headers(&[("anthropic-version", "2023-06-01")]),
            ),
            Some("Anthropic-Version: 2026-10-21"),
        );

        collect(&provider, hello()).await.unwrap();

        assert_eq!(client.last()["temperature"], 0.2);
    }

    #[tokio::test]
    async fn sends_temperature_when_anthropic_custom_headers_pins_the_previous_api_version() {
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            options(
                config().model_id("m1").temperature(0.2).build(),
                AnthropicClientConfig::default(),
            ),
            Some("anthropic-version: 2023-06-01"),
        );

        collect(&provider, hello()).await.unwrap();

        assert_eq!(client.last()["temperature"], 0.2);
    }

    #[tokio::test]
    async fn skips_pdf_documents_in_assistant_messages() {
        let (logs, _guard) = record_logs();
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            options(config().model_id("m1").build(), AnthropicClientConfig::default()),
            None,
        );
        let conversation = vec![
            Message::new(crate::types::Role::User, vec![ContentBlock::text("Summarize"), pdf()]),
            Message::new(
                crate::types::Role::Assistant,
                vec![ContentBlock::text("Here it is"), pdf()],
            ),
        ];

        collect(&provider, request(conversation)).await.unwrap();

        let types = |index: usize| -> Vec<JsonValue> {
            client.last()["messages"][index]["content"]
                .as_array()
                .unwrap()
                .iter()
                .map(|block| block["type"].clone())
                .collect()
        };
        assert_eq!(types(0), [json!("text"), json!("document")]);
        assert_eq!(types(1), [json!("text")]);
        assert!(
            logs.text()
                .contains("document blocks are not accepted in assistant messages")
        );
    }

    #[tokio::test]
    async fn keeps_pdf_documents_in_assistant_messages_on_the_previous_api_version() {
        let client = MockClient::capture();
        let provider = built_model(
            &client,
            options(
                config().model_id("m1").build(),
                headers(&[("anthropic-version", "2023-06-01")]),
            ),
            None,
        );

        collect(
            &provider,
            request(vec![Message::new(crate::types::Role::Assistant, vec![pdf()])]),
        )
        .await
        .unwrap();

        let mut expected = hello_request();
        expected["messages"] = json!([{
            "role": "assistant",
            "content": [{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "AQID"}, "title": "doc.pdf"}]
        }]);
        assert_eq!(client.last(), expected);
    }

    #[test]
    fn takes_json_params_and_rejects_values_that_are_not_objects() {
        let provider = model(&MockClient::capture(), AnthropicModelConfig::default());
        let error = provider
            .update_config(config().params(json!(["thinking"])).build())
            .unwrap_err();
        assert_eq!(error.to_string(), "'params' must be a JSON object");
        let error = provider
            .update_config(config().anthropic_tools(vec![json!("web_search")]).build())
            .unwrap_err();
        assert_eq!(error.to_string(), "'anthropic_tools' entries must be JSON objects");
        let error = AnthropicModel::new(
            AnthropicModelOptions::builder()
                .api_key("sk")
                .params(json!(1))
                .build_options(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "'params' must be a JSON object");
    }

    #[test]
    fn creates_the_model_from_a_bare_config_and_clones_share_it() {
        let options = AnthropicModelOptions {
            api_key: Some("sk".to_owned()),
            ..AnthropicModelOptions::from(config().model_id("m1").build())
        };
        let provider = constructing(|| AnthropicModel::with_env(options, &|_| None)).unwrap();
        let clone = provider.clone();
        clone.update_config(config().model_id("m2").build()).unwrap();
        assert_eq!(provider.config().model_id.as_deref(), Some("m2"));
        assert_eq!(
            AnthropicModelConfig::from(BaseModelConfig::default()).to_base(),
            BaseModelConfig::default()
        );
    }

    #[test]
    fn rejects_function_tool_definitions_in_anthropic_tools() {
        let function_tool = json!({"name": "f", "input_schema": {"type": "object"}});
        let options = AnthropicModelOptions::builder()
            .api_key("sk")
            .anthropic_tools(vec![function_tool.clone()])
            .build_options();
        let error = AnthropicModel::new(options).unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("anthropicTools should not contain function tool definitions")
        );

        let provider = model(&MockClient::capture(), AnthropicModelConfig::default());
        let error = provider
            .update_config(config().anthropic_tools(vec![function_tool]).build())
            .unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("anthropicTools should not contain function tool definitions")
        );
        assert_eq!(provider.config().anthropic_tools, None);
    }
}
