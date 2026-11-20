//! OpenAI provider tests. This module covers construction, config updates, `stateful` and the managed
//! params warning; the stream and formatting tests are in the submodules. A scripted [`MockClient`]
//! stands in for the OpenAI client; `http` exercises the real client against a local server.

mod chat;
mod http;
#[cfg(feature = "mantle")]
mod mantle;
mod responses;
mod responses_cache;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use serde_json::json;

use super::client::{EventStream, OpenAIClient};
use super::*;
use crate::logging::forget_warning;
use crate::models::{AggregatedEvent, StreamAggregatedResult};
use crate::test_support::{capture_logs, record_logs};
use crate::types::Message;

type Events = Vec<std::result::Result<JsonValue, HttpError>>;
type Script = Box<dyn Fn(usize) -> Events + Send + Sync>;

/// A request the mock client received.
#[derive(Debug, Clone)]
pub(super) struct Sent {
    pub(super) path: &'static str,
    pub(super) body: JsonValue,
}

/// A scripted OpenAI client that records what it is sent.
pub(super) struct MockClient {
    script: Script,
    requests: Mutex<Vec<Sent>>,
    base_url: Option<String>,
}

impl MockClient {
    /// Answers call `n` (from 0) with `script(n)`.
    pub(super) fn new(script: impl Fn(usize) -> Events + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            script: Box::new(script),
            requests: Mutex::new(Vec::new()),
            base_url: None,
        })
    }

    /// Answers every call with `events`, then `error` when given, reporting `base_url` as its base
    /// URL.
    pub(super) fn at(
        base_url: Option<&str>,
        events: Vec<JsonValue>,
        error: Option<Box<dyn Fn() -> HttpError + Send + Sync>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            script: Box::new(move |_| {
                let mut answer: Events = events.iter().cloned().map(Ok).collect();
                answer.extend(error.as_ref().map(|error| Err(error())));
                answer
            }),
            requests: Mutex::new(Vec::new()),
            base_url: base_url.map(str::to_owned),
        })
    }

    /// Answers every call with `events`.
    pub(super) fn replying(events: Vec<JsonValue>) -> Arc<Self> {
        Self::new(move |_| events.iter().cloned().map(Ok).collect())
    }

    /// Answers every call with `events`, then `error`.
    pub(super) fn failing(events: Vec<JsonValue>, error: impl Fn() -> HttpError + Send + Sync + 'static) -> Arc<Self> {
        Self::new(move |_| events.iter().cloned().map(Ok).chain([Err(error())]).collect())
    }

    pub(super) fn requests(&self) -> Vec<Sent> {
        self.requests.lock().unwrap().clone()
    }

    /// The last request body.
    pub(super) fn last(&self) -> JsonValue {
        self.requests.lock().unwrap().last().unwrap().body.clone()
    }
}

impl OpenAIClient for MockClient {
    fn stream(&self, path: &'static str, body: JsonValue) -> EventStream {
        let mut requests = self.requests.lock().unwrap();
        let index = requests.len();
        requests.push(Sent { path, body });
        Box::pin(futures::stream::iter((self.script)(index)))
    }

    fn base_url(&self) -> Option<&str> {
        self.base_url.as_deref()
    }
}

/// Serializes model construction, so a test watching for the default model warning sees it even
/// when another test constructs a model in between.
static CONSTRUCTION: Mutex<()> = Mutex::new(());

pub(super) fn constructing<T>(construct: impl FnOnce() -> T) -> T {
    let _guard = CONSTRUCTION.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    construct()
}

/// A model on `client` built from `options` as [`OpenAIModel::new`] would, without its client.
pub(super) fn model_with(client: &Arc<MockClient>, options: OpenAIModelOptions) -> OpenAIModel {
    constructing(|| build(client, options))
}

fn build(client: &Arc<MockClient>, options: OpenAIModelOptions) -> OpenAIModel {
    let parts = options.into_parts();
    let config = prepare_config(parts.api, parts.config).unwrap();
    OpenAIModel::from_parts(parts.api, config, Arc::clone(client) as Arc<dyn OpenAIClient>)
}

pub(super) fn options(api: OpenAIApi) -> OpenAIModelOptions {
    OpenAIModelOptions {
        api,
        ..Default::default()
    }
}

/// A model with the default model id set explicitly, so it logs no default warning.
pub(super) fn chat_model(client: &Arc<MockClient>) -> OpenAIModel {
    model_with(client, pinned(OpenAIApi::Chat))
}

/// A Responses model with the default model id set explicitly.
pub(super) fn responses_model(client: &Arc<MockClient>) -> OpenAIModel {
    model_with(client, pinned(OpenAIApi::Responses))
}

pub(super) fn pinned(api: OpenAIApi) -> OpenAIModelOptions {
    OpenAIModelOptions {
        model_id: Some("gpt-5.4".to_owned()),
        ..options(api)
    }
}

/// A client that answers with an empty stream, for tests that only need a model.
pub(super) fn idle() -> Arc<MockClient> {
    MockClient::new(|_| Vec::new())
}

pub(super) fn request(messages: Vec<Message>) -> ModelRequest {
    ModelRequest::builder().messages(messages).build()
}

pub(super) fn hi() -> ModelRequest {
    request(vec![Message::user("Hi")])
}

/// The stream's events as JSON.
pub(super) async fn collect(model: &OpenAIModel, request: ModelRequest) -> Result<Vec<JsonValue>> {
    let mut events = Vec::new();
    let mut stream = model.stream(request);
    while let Some(event) = stream.next().await {
        events.push(serde_json::to_value(event?).unwrap());
    }
    Ok(events)
}

/// The error the stream ends with.
pub(super) async fn collect_error(model: &OpenAIModel, request: ModelRequest) -> Error {
    collect(model, request).await.unwrap_err()
}

/// The aggregated stream's items and result.
pub(super) async fn aggregate(
    model: &OpenAIModel,
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

/// The `type` of each event.
pub(super) fn types(events: &[JsonValue]) -> Vec<&str> {
    events.iter().map(|event| event["type"].as_str().unwrap()).collect()
}

/// An environment with only `vars` set.
pub(super) fn env_of(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect();
    move |name| vars.get(name).cloned()
}

/// An API error response, as the SDK builds it from a status and an error body.
pub(super) fn status_error(status: u16, message: &str, code: Option<&str>) -> HttpError {
    let body = json!({"error": {"message": message, "code": code}});
    HttpError::status(status, Some(body), "", crate::models::http::ErrorPayload::ErrorField)
}

/// An error object in a stream, which the SDK raises as an `APIError` without a status.
pub(super) fn event_error(message: &str, code: Option<JsonValue>) -> HttpError {
    let mut error = json!({"message": message});
    if let Some(code) = code {
        error["code"] = code;
    }
    HttpError::event_error_field(json!({"error": error}))
}

fn default_model_warning() -> String {
    default_model_warning_message("gpt-5.4")
}

fn warnings(logs: &str) -> Vec<&str> {
    logs.lines().filter(|line| line.contains("WARN")).collect()
}

mod constructor {
    use super::*;

    #[test]
    fn creates_an_instance_with_required_model_id() {
        let model = model_with(
            &idle(),
            OpenAIModelOptions {
                model_id: Some("gpt-5.4".to_owned()),
                ..options(OpenAIApi::Chat)
            },
        );
        assert_eq!(model.config().model_id.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn uses_custom_model_id() {
        let model = model_with(
            &idle(),
            OpenAIModelOptions {
                model_id: Some("gpt-3.5-turbo".to_owned()),
                ..options(OpenAIApi::Chat)
            },
        );
        assert_eq!(
            model.config(),
            OpenAIModelConfig {
                model_id: Some("gpt-3.5-turbo".to_owned()),
                ..Default::default()
            }
        );
    }

    #[test]
    fn warns_when_model_id_is_not_explicitly_set() {
        let (_, logs) = constructing(|| {
            forget_warning(&default_model_warning());
            capture_logs(|| build(&idle(), options(OpenAIApi::Chat)))
        });
        assert!(logs.contains(&default_model_warning()), "{logs}");
    }

    #[test]
    fn does_not_warn_when_model_id_is_explicitly_set() {
        let (_, logs) = constructing(|| {
            forget_warning(&default_model_warning());
            capture_logs(|| {
                build(
                    &idle(),
                    OpenAIModelOptions {
                        model_id: Some("gpt-5.4".to_owned()),
                        ..options(OpenAIApi::Chat)
                    },
                )
            })
        });
        assert!(!logs.contains("using default modelId"), "{logs}");
    }

    #[test]
    fn throws_error_when_no_api_key_is_available() {
        for api in [OpenAIApi::Chat, OpenAIApi::Responses] {
            let error =
                constructing(|| OpenAIModel::with_env(options(api), &env_of(&[("OPENAI_API_KEY", "")]))).unwrap_err();
            assert_eq!(
                error.to_string(),
                "OpenAI API key is required. Provide it via the 'api_key' option (string or function) or set the OPENAI_API_KEY environment variable."
            );
        }
    }

    #[test]
    fn uses_api_key_from_environment_variable() {
        let model = constructing(|| {
            OpenAIModel::with_env(options(OpenAIApi::Chat), &env_of(&[("OPENAI_API_KEY", "sk-from-env")]))
        });
        assert!(model.is_ok());
    }

    #[test]
    fn accepts_function_based_api_key() {
        let options = OpenAIModelOptions {
            api_key: Some(ApiKey::setter(|| async { Ok("sk-dynamic".to_owned()) })),
            ..options(OpenAIApi::Chat)
        };
        assert!(constructing(|| OpenAIModel::with_env(options, &env_of(&[]))).is_ok());
    }

    #[test]
    fn builds_with_the_builder_and_reports_the_api() {
        let model = constructing(|| {
            OpenAIModel::builder()
                .api(OpenAIApi::Chat)
                .model_id("gpt-5.4")
                .api_key("sk-test")
                .build()
        })
        .unwrap();
        assert_eq!(model.api(), OpenAIApi::Chat);
        let default_api = constructing(|| OpenAIModel::builder().model_id("gpt-5.4").api_key("sk").build()).unwrap();
        assert_eq!(default_api.api(), OpenAIApi::Responses);
        assert_eq!(OpenAIApi::Chat.to_string(), "chat");
        assert_eq!(OpenAIApi::Responses.as_str(), "responses");
    }

    #[test]
    fn redacts_the_api_key_in_debug_output() {
        let options = OpenAIModelOptions {
            api_key: Some("sk-secret".into()),
            ..Default::default()
        };
        assert!(!format!("{options:?}").contains("sk-secret"));
        assert_eq!(ApiKey::from("a"), ApiKey::from("a".to_owned()));
    }
}

mod update_config {
    use super::*;

    fn chat_with(options: OpenAIModelOptions) -> OpenAIModel {
        model_with(
            &idle(),
            OpenAIModelOptions {
                api: OpenAIApi::Chat,
                ..options
            },
        )
    }

    #[test]
    fn merges_new_config_with_existing_config() {
        let model = chat_with(OpenAIModelOptions {
            model_id: Some("gpt-5.4".to_owned()),
            temperature: Some(0.5),
            ..Default::default()
        });
        model
            .update_config(
                OpenAIModelConfig::builder()
                    .model_id("gpt-5.4")
                    .temperature(0.8)
                    .max_tokens(2048)
                    .build(),
            )
            .unwrap();
        assert_eq!(
            model.config(),
            OpenAIModelConfig {
                model_id: Some("gpt-5.4".to_owned()),
                temperature: Some(0.8),
                max_tokens: Some(2048),
                context_window_limit: Some(1_050_000),
                ..Default::default()
            }
        );
    }

    #[test]
    fn preserves_fields_not_included_in_the_update() {
        let model = chat_with(OpenAIModelOptions {
            model_id: Some("gpt-3.5-turbo".to_owned()),
            temperature: Some(0.5),
            max_tokens: Some(1024),
            ..Default::default()
        });
        model
            .update_config(
                OpenAIModelConfig::builder()
                    .model_id("gpt-3.5-turbo")
                    .temperature(0.8)
                    .build(),
            )
            .unwrap();
        assert_eq!(
            model.config(),
            OpenAIModelConfig {
                model_id: Some("gpt-3.5-turbo".to_owned()),
                temperature: Some(0.8),
                max_tokens: Some(1024),
                ..Default::default()
            }
        );
    }

    #[test]
    fn re_resolves_context_window_limit_when_model_id_changes_and_it_was_auto_resolved() {
        let model = model_with(&idle(), options(OpenAIApi::Chat));
        assert_eq!(model.config().context_window_limit, Some(1_050_000));
        model
            .update_config(OpenAIModelConfig::builder().model_id("gpt-4o").build())
            .unwrap();
        assert_eq!(model.config().context_window_limit, Some(128_000));
    }

    #[test]
    fn preserves_explicit_context_window_limit_when_model_id_changes() {
        let model = chat_with(OpenAIModelOptions {
            context_window_limit: Some(50_000),
            ..Default::default()
        });
        assert_eq!(model.config().context_window_limit, Some(50_000));
        model
            .update_config(OpenAIModelConfig::builder().model_id("gpt-4o").build())
            .unwrap();
        assert_eq!(model.config().context_window_limit, Some(50_000));
    }

    #[test]
    fn merges_config_without_clobbering_unspecified_fields() {
        let model = model_with(
            &idle(),
            OpenAIModelOptions {
                model_id: Some("gpt-4o".to_owned()),
                temperature: Some(0.5),
                max_tokens: Some(1024),
                ..options(OpenAIApi::Responses)
            },
        );
        model
            .update_config(OpenAIModelConfig::builder().temperature(0.9).build())
            .unwrap();
        let config = model.config();
        assert_eq!(config.model_id.as_deref(), Some("gpt-4o"));
        assert_eq!(config.temperature, Some(0.9));
        assert_eq!(config.max_tokens, Some(1024));
    }

    #[test]
    fn the_model_trait_update_merges_base_fields() {
        let model = chat_model(&idle());
        Model::update_config(
            &model,
            BaseModelConfig {
                temperature: Some(0.2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(model.get_config().temperature, Some(0.2));
        assert_eq!(model.model_id().as_deref(), Some("gpt-5.4"));
    }
}

/// Server-side summary is off for listed models unless the model info override sets it, on both APIs.
#[test]
fn turns_server_side_summary_off_unless_the_override_sets_it() {
    for api in [OpenAIApi::Chat, OpenAIApi::Responses] {
        let listed = OpenAIModelOptions {
            model_id: Some("claude-sonnet-5-5".to_owned()),
            ..options(api)
        };
        let model = model_with(&idle(), listed.clone());
        assert_eq!(
            model.model_info().capabilities.server_side_summary,
            Some(false),
            "{api}"
        );
        let model = model_with(
            &idle(),
            OpenAIModelOptions {
                model_info: Some(ModelInfo {
                    capabilities: ModelCapabilities {
                        server_side_summary: Some(true),
                        ..ModelCapabilities::default()
                    },
                    ..ModelInfo::default()
                }),
                ..listed
            },
        );
        assert_eq!(model.model_info().capabilities.server_side_summary, Some(true), "{api}");
    }
}

#[test]
fn takes_json_params_and_rejects_params_that_are_not_an_object() {
    let model = constructing(|| {
        OpenAIModel::with_env(
            OpenAIModelOptions {
                api_key: Some("sk".into()),
                params: Some(json!({"reasoning": {"effort": "high"}})),
                ..pinned(OpenAIApi::Responses)
            },
            &env_of(&[]),
        )
    })
    .unwrap();
    assert_eq!(model.config().params, Some(json!({"reasoning": {"effort": "high"}})));
    let error = constructing(|| {
        OpenAIModel::with_env(
            OpenAIModelOptions {
                api_key: Some("sk".into()),
                params: Some(json!(["not", "an", "object"])),
                ..pinned(OpenAIApi::Responses)
            },
            &env_of(&[]),
        )
    })
    .unwrap_err();
    assert_eq!(error.to_string(), "'params' must be a JSON object");
    let error = model
        .update_config(OpenAIModelConfig::builder().params(json!("text")).build())
        .unwrap_err();
    assert_eq!(error.to_string(), "'params' must be a JSON object");
    assert_eq!(model.config().params, Some(json!({"reasoning": {"effort": "high"}})));
}

#[test]
fn creates_the_model_from_a_bare_config() {
    let model = constructing(|| {
        OpenAIModel::with_env(
            OpenAIModelConfig::builder().model_id("gpt-5.4-mini").build().into(),
            &env_of(&[("OPENAI_API_KEY", "sk")]),
        )
    })
    .unwrap();
    assert_eq!(model.config().model_id.as_deref(), Some("gpt-5.4-mini"));
    assert_eq!(
        OpenAIModelConfig::from(BaseModelConfig::default()).to_base(),
        BaseModelConfig::default()
    );
}

mod get_config {
    use super::*;

    fn chat_with(options: OpenAIModelOptions) -> OpenAIModelConfig {
        model_with(
            &idle(),
            OpenAIModelOptions {
                api: OpenAIApi::Chat,
                ..options
            },
        )
        .config()
    }

    #[test]
    fn returns_the_current_configuration() {
        let config = chat_with(OpenAIModelOptions {
            model_id: Some("gpt-5.4".to_owned()),
            max_tokens: Some(1024),
            temperature: Some(0.7),
            ..Default::default()
        });
        assert_eq!(
            config,
            OpenAIModelConfig {
                model_id: Some("gpt-5.4".to_owned()),
                max_tokens: Some(1024),
                temperature: Some(0.7),
                context_window_limit: Some(1_050_000),
                ..Default::default()
            }
        );
    }

    #[test]
    fn includes_context_window_limit_in_config_when_provided() {
        let config = chat_with(OpenAIModelOptions {
            model_id: Some("gpt-4o".to_owned()),
            context_window_limit: Some(128_000),
            ..Default::default()
        });
        assert_eq!(config.context_window_limit, Some(128_000));
    }

    #[test]
    fn auto_populates_context_window_limit_from_model_id_lookup() {
        let config = chat_with(OpenAIModelOptions {
            model_id: Some("gpt-4o".to_owned()),
            ..Default::default()
        });
        assert_eq!(
            config,
            OpenAIModelConfig {
                model_id: Some("gpt-4o".to_owned()),
                context_window_limit: Some(128_000),
                ..Default::default()
            }
        );
    }

    #[test]
    fn auto_populates_context_window_limit_for_default_model_id() {
        let config = chat_with(OpenAIModelOptions::default());
        assert_eq!(
            config,
            OpenAIModelConfig {
                context_window_limit: Some(1_050_000),
                ..Default::default()
            }
        );
    }

    #[test]
    fn does_not_override_explicit_context_window_limit() {
        let config = chat_with(OpenAIModelOptions {
            model_id: Some("gpt-4o".to_owned()),
            context_window_limit: Some(50_000),
            ..Default::default()
        });
        assert_eq!(config.context_window_limit, Some(50_000));
    }

    #[test]
    fn leaves_context_window_limit_undefined_for_unknown_model_ids() {
        let config = chat_with(OpenAIModelOptions {
            model_id: Some("unknown-model".to_owned()),
            ..Default::default()
        });
        assert_eq!(
            config,
            OpenAIModelConfig {
                model_id: Some("unknown-model".to_owned()),
                ..Default::default()
            }
        );
    }
}

mod stateful {
    use super::*;

    fn responses_with(stateful: Option<bool>) -> OpenAIModel {
        model_with(
            &idle(),
            OpenAIModelOptions {
                stateful,
                ..options(OpenAIApi::Responses)
            },
        )
    }

    #[test]
    fn defaults_to_false() {
        assert!(!responses_with(None).stateful());
    }

    #[test]
    fn returns_true_when_explicitly_enabled() {
        assert!(responses_with(Some(true)).stateful());
    }

    #[test]
    fn is_declared_on_info() {
        assert_eq!(
            responses_with(Some(true)).model_info().capabilities.stateful,
            Some(true)
        );
        assert_eq!(responses_with(None).model_info().capabilities.stateful, Some(false));
    }

    #[test]
    fn is_construction_only_and_cannot_be_changed_via_update_config() {
        let model = responses_with(Some(false));
        let (_, logs) = capture_logs(|| {
            model
                .update_config(OpenAIModelConfig::builder().stateful(true).build())
                .unwrap();
        });
        assert!(!model.stateful());
        assert!(logs.contains("'stateful' is construction-only"), "{logs}");
    }

    #[test]
    fn chat_completions_is_never_stateful() {
        let model = model_with(
            &idle(),
            OpenAIModelOptions {
                stateful: Some(true),
                ..options(OpenAIApi::Chat)
            },
        );
        assert!(!model.stateful());
    }

    #[test]
    fn turns_server_side_summary_off_and_keeps_the_override_on_top() {
        let model = model_with(
            &idle(),
            OpenAIModelOptions {
                model_info: Some(ModelInfo {
                    capabilities: ModelCapabilities {
                        stateful: Some(true),
                        ..Default::default()
                    },
                    ..Default::default()
                }),
                ..options(OpenAIApi::Chat)
            },
        );
        let info = model.model_info();
        assert_eq!(info.capabilities.server_side_summary, Some(false));
        assert_eq!(info.capabilities.stateful, Some(true));
        assert_eq!(info.limits.context_window, Some(1_050_000));
    }
}

mod managed_params_warning {
    use super::*;

    fn params(value: JsonValue) -> Option<JsonValue> {
        match value {
            JsonValue::Object(_) => Some(value),
            _ => None,
        }
    }

    fn construct_logs(api: OpenAIApi, value: JsonValue) -> String {
        capture_logs(|| {
            model_with(
                &idle(),
                OpenAIModelOptions {
                    model_id: Some("gpt-5.4".to_owned()),
                    params: params(value),
                    ..options(api)
                },
            )
        })
        .1
    }

    #[test]
    fn warns_on_construction_when_params_contains_provider_managed_keys() {
        let logs = construct_logs(OpenAIApi::Chat, json!({"model": "bad", "stream": false}));
        let warned = warnings(&logs);
        assert_eq!(warned.len(), 2, "{logs}");
        assert!(warned[0].contains("'model'"), "{logs}");
        assert!(warned[1].contains("'stream'"), "{logs}");
        assert!(
            warned[0].ends_with(
                "params_key=<model> | 'model' is managed by the provider and will be ignored in params — use the dedicated config property instead"
            ),
            "{logs}"
        );

        let logs = construct_logs(OpenAIApi::Responses, json!({"model": "bad", "store": false}));
        let warned = warnings(&logs);
        assert_eq!(warned.len(), 2, "{logs}");
        assert!(warned[1].contains("'store'"), "{logs}");
    }

    #[test]
    fn warns_on_update_config_when_params_contains_provider_managed_keys() {
        for (api, key) in [(OpenAIApi::Chat, "stream_options"), (OpenAIApi::Responses, "stream")] {
            let model = model_with(
                &idle(),
                OpenAIModelOptions {
                    model_id: Some("gpt-5.4".to_owned()),
                    ..options(api)
                },
            );
            let (_, logs) = capture_logs(|| {
                let update = OpenAIModelConfig {
                    params: params(json!({key: true})),
                    ..Default::default()
                };
                model.update_config(update).unwrap();
            });
            let warned = warnings(&logs);
            assert_eq!(warned.len(), 1, "{logs}");
            assert!(warned[0].contains(&format!("'{key}'")), "{logs}");
        }
    }

    #[test]
    fn does_not_warn_when_params_contains_only_non_managed_keys() {
        assert!(warnings(&construct_logs(OpenAIApi::Chat, json!({"seed": 42}))).is_empty());
        assert!(
            warnings(&construct_logs(
                OpenAIApi::Responses,
                json!({"reasoning": {"summary": "auto"}})
            ))
            .is_empty()
        );
    }
}
