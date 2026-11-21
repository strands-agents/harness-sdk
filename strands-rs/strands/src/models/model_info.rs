//! What the SDK knows about models: [`ModelInfo`] and the shared model info data.
//!
//! Every field is optional, and `None` means unknown. The same shape is used for the shared data
//! file, the `model_info` config override and the resolved [`Model::model_info`]. A known
//! `Unsupported` disables a feature; unknown leaves the SDK's existing default in place.
//!
//! The data is `shared/model-info.json` at the repository root, the source of truth for every
//! Strands SDK, embedded by the build script.
//!
//! [`Model::model_info`]: crate::models::Model::model_info

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

/// How a model supports prompt caching (`PromptCaching`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum PromptCaching {
    /// The model does not cache prompts.
    Unsupported,
    /// The provider caches automatically.
    Auto,
    /// The request places explicit cache points.
    CachePoints,
}

/// How a model keeps deferred tool schemas out of its context until it loads them
/// (`DeferredToolLoading`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum DeferredToolLoading {
    /// Every tool goes with its full input schema.
    Unsupported,
    /// Deferred tools go with the API's own deferral flag.
    Native,
    /// Each deferred tool goes as its name and description with an open schema.
    Stubs,
}

/// What the model can do (`ModelCapabilities`). `None` is unknown.
///
/// Fields are added as the SDK learns to read more facts, so build values with the builder or
/// `ModelCapabilities { stateful: Some(true), ..Default::default() }` rather than listing every
/// field. The same holds for [`ModelLimits`] and [`ModelInfo`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    /// Whether the model keeps conversation state server-side; [`Model::stateful`] reads it.
    ///
    /// [`Model::stateful`]: crate::models::Model::stateful
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stateful: Option<bool>,
    /// Whether and how the model caches prompts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_caching: Option<PromptCaching>,
    /// Whether the Bedrock and Anthropic providers force the structured output tool (`Any` or a
    /// named tool) on the structured output retry. False when the model rejects forcing, or when a
    /// forced call degrades the response (for example, it skips thinking).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forced_tool_choice: Option<bool>,
    /// Whether the provider can make the model's text output conform to a JSON schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_structured_output: Option<bool>,
    /// Whether the model summarizes history server-side through [`Model::summarize`]; set
    /// `Some(false)` in `model_info` to summarize client-side.
    ///
    /// [`Model::summarize`]: crate::models::Model::summarize
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_side_summary: Option<bool>,
    /// Whether the model and provider take temporary messages: injected text the model reads only
    /// until the next user message. When `true`, the provider receives each `InjectedBlock` as
    /// stored; otherwise it receives only the latest user message's injected text, as text. The
    /// default [`Model::model_info`] reports `false` unless the provider can send them.
    ///
    /// [`Model::model_info`]: crate::models::Model::model_info
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporary_messages: Option<bool>,
    /// How the model and provider defer tool schemas. In the shared data, `Native` is the path on
    /// the model vendor's own API and `Unsupported` marks a model that cannot fill in a stub's
    /// parameters, such as one that constrains its tool calls to the stub's open schema. The
    /// default [`Model::model_info`] reports `Stubs` for every other model; `Native` comes only
    /// from a provider that sends the deferral flag (`AnthropicModel`), and `Unsupported` from one
    /// that needs each tool's full input schema (`BedrockModel` with `strict_tools`). A
    /// `model_info` override that sets `Unsupported` sends every full spec to a model that handles
    /// stubs badly. On a provider without the flag, an override that sets `Native` sends every full
    /// spec and only changes the `load_tools` result: `BedrockModel` names each loaded tool and
    /// other providers leave it out.
    ///
    /// [`Model::model_info`]: crate::models::Model::model_info
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred_tool_loading: Option<DeferredToolLoading>,
}

impl ModelCapabilities {
    /// Whether nothing is known.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn overlay(&mut self, other: &Self) {
        self.stateful = other.stateful.or(self.stateful);
        self.prompt_caching = other.prompt_caching.or(self.prompt_caching);
        self.forced_tool_choice = other.forced_tool_choice.or(self.forced_tool_choice);
        self.native_structured_output = other.native_structured_output.or(self.native_structured_output);
        self.server_side_summary = other.server_side_summary.or(self.server_side_summary);
        self.temporary_messages = other.temporary_messages.or(self.temporary_messages);
        self.deferred_tool_loading = other.deferred_tool_loading.or(self.deferred_tool_loading);
    }
}

/// Size limits of the model (`ModelLimits`). `None` is unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase")]
pub struct ModelLimits {
    /// Context window size in tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Largest `max_tokens` the model accepts. Providers that need a default `max_tokens` use it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

impl ModelLimits {
    /// Whether nothing is known.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn overlay(&mut self, other: &Self) {
        self.context_window = other.context_window.or(self.context_window);
        self.max_output_tokens = other.max_output_tokens.or(self.max_output_tokens);
    }
}

/// Everything the SDK knows about a model (`ModelInfo`). Read it from [`Model::model_info`].
///
/// [`Model::model_info`]: crate::models::Model::model_info
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
pub struct ModelInfo {
    /// What the model can do.
    #[serde(default, skip_serializing_if = "ModelCapabilities::is_empty")]
    #[builder(default)]
    pub capabilities: ModelCapabilities,
    /// Size limits of the model.
    #[serde(default, skip_serializing_if = "ModelLimits::is_empty")]
    #[builder(default)]
    pub limits: ModelLimits,
}

impl ModelInfo {
    /// Merges partial records, later known fields winning; unknown fields inherit, and `None`
    /// parts are skipped.
    ///
    /// A provider that overrides [`Model::model_info`] layers its facts over
    /// [`base_model_info`](crate::models::base_model_info) and puts the user's `model_info`
    /// override on top:
    ///
    /// ```
    /// use strands::models::{BaseModelConfig, ModelCapabilities, ModelInfo, PromptCaching, base_model_info};
    ///
    /// let config = BaseModelConfig::builder().model_id("claude-sonnet-4-6").build();
    /// let facts = ModelInfo {
    ///     capabilities: ModelCapabilities { prompt_caching: Some(PromptCaching::Auto), ..Default::default() },
    ///     ..Default::default()
    /// };
    /// let info = ModelInfo::merge([Some(&base_model_info(&config)), Some(&facts), config.model_info.as_ref()]);
    /// assert_eq!(info.capabilities.prompt_caching, Some(PromptCaching::Auto));
    /// ```
    ///
    /// [`Model::model_info`]: crate::models::Model::model_info
    #[must_use]
    pub fn merge<'a>(parts: impl IntoIterator<Item = Option<&'a ModelInfo>>) -> ModelInfo {
        let mut merged = ModelInfo::default();
        for part in parts.into_iter().flatten() {
            merged.overlay(part);
        }
        merged
    }

    fn overlay(&mut self, other: &Self) {
        self.capabilities.overlay(&other.capabilities);
        self.limits.overlay(&other.limits);
    }
}

/// Turns `server_side_summary` off, for providers that serve a model the shared data lists it for
/// but have no server-side summary of their own (`SERVER_SIDE_SUMMARY_OFF`).
#[allow(
    dead_code,
    reason = "providers without a server-side summary layer it over the shared data"
)]
pub(crate) fn server_side_summary_off() -> ModelInfo {
    ModelInfo {
        capabilities: ModelCapabilities {
            server_side_summary: Some(false),
            ..ModelCapabilities::default()
        },
        limits: ModelLimits::default(),
    }
}

#[derive(Deserialize)]
struct DefaultLimits {
    #[serde(rename = "contextWindow")]
    context_window: u64,
}

#[derive(Deserialize)]
struct Defaults {
    limits: DefaultLimits,
}

#[derive(Deserialize)]
struct ModelInfoData {
    defaults: Defaults,
    models: HashMap<String, ModelInfo>,
}

const MODEL_INFO_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/model-info.json"));

const FALLBACK_CONTEXT_WINDOW_LIMIT: u64 = 200_000;

static DATA: LazyLock<ModelInfoData> = LazyLock::new(|| {
    serde_json::from_str(MODEL_INFO_JSON).unwrap_or_else(|error| {
        tracing::error!("error=<{error}> | embedded model info data is invalid | using no model info");
        ModelInfoData {
            defaults: Defaults {
                limits: DefaultLimits {
                    context_window: FALLBACK_CONTEXT_WINDOW_LIMIT,
                },
            },
            models: HashMap::new(),
        }
    })
});

/// Context window limit in tokens assumed for a model whose window is unknown
/// (`DEFAULT_CONTEXT_WINDOW_LIMIT`).
pub(crate) fn default_context_window_limit() -> u64 {
    DATA.defaults.limits.context_window
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Strips a trailing Bedrock version suffix (`-v1:0`, `-v2`, `-1:0`).
fn strip_version_suffix(model_id: &str) -> &str {
    let Some((head, tail)) = model_id.rsplit_once('-') else {
        return model_id;
    };
    let is_version = match tail.strip_prefix('v') {
        Some(version) => match version.split_once(':') {
            Some((major, minor)) => all_digits(major) && all_digits(minor),
            None => all_digits(version),
        },
        None => tail
            .split_once(':')
            .is_some_and(|(major, minor)| all_digits(major) && all_digits(minor)),
    };
    if is_version { head } else { model_id }
}

/// Strips a trailing snapshot date (`-20260401`, `@20251001`).
fn strip_date_suffix(model_id: &str) -> &str {
    let bytes = model_id.as_bytes();
    let Some(start) = bytes.len().checked_sub(9) else {
        return model_id;
    };
    let dated = matches!(bytes[start], b'-' | b'@') && bytes[start + 1..].iter().all(u8::is_ascii_digit);
    if dated { &model_id[..start] } else { model_id }
}

/// Finds the entry for a model id.
///
/// Tries the id as given, then without a trailing Bedrock version suffix, then without a trailing
/// date, then with each leading dot-separated segment removed in turn
/// (`us.anthropic.claude-x`, `anthropic.claude-x`, `claude-x`), the rule the Python SDK applies.
pub(crate) fn lookup_model(model_id: &str) -> Option<&'static ModelInfo> {
    lookup_key(model_id).and_then(|key| DATA.models.get(key))
}

/// Finds the key of the entry for a model id, by the rule [`lookup_model`] documents.
fn lookup_key(model_id: &str) -> Option<&'static str> {
    let models = &DATA.models;
    let mut candidate = model_id;
    loop {
        let unversioned = strip_version_suffix(candidate);
        let keys = [candidate, unversioned, strip_date_suffix(unversioned)];
        if let Some((key, _)) = keys.iter().find_map(|key| models.get_key_value(*key)) {
            return Some(key.as_str());
        }
        let (_, rest) = candidate.split_once('.')?;
        candidate = rest;
    }
}

/// The values of `capabilities.chatCompletionsTools` in the data (`ChatCompletionsTools`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChatCompletionsTools {
    /// The model accepts tools only with `reasoning_effort: "none"`.
    ReasoningOff,
    /// The model accepts no tools.
    Unsupported,
}

/// The values of `capabilities.systemPromptPlacement` in the data (`SystemPromptPlacement`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SystemPromptPlacement {
    /// The system prompt goes at the start of the messages.
    Message,
}

/// The `capabilities` fields of the shared data that [`ModelCapabilities`] does not carry, which
/// a single provider reads.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCapabilities {
    chat_completions_tools: Option<ChatCompletionsTools>,
    system_prompt_placement: Option<SystemPromptPlacement>,
}

#[derive(Deserialize)]
struct ProviderEntry {
    #[serde(default)]
    capabilities: ProviderCapabilities,
}

#[derive(Deserialize)]
struct ProviderData {
    models: HashMap<String, ProviderEntry>,
}

/// [`ProviderCapabilities`] by model key.
static PROVIDER_CAPABILITIES: LazyLock<HashMap<String, ProviderCapabilities>> = LazyLock::new(|| {
    let data: ProviderData = serde_json::from_str(MODEL_INFO_JSON).unwrap_or_else(|error| {
        tracing::error!("error=<{error}> | embedded model info data is invalid | using no provider capabilities");
        ProviderData { models: HashMap::new() }
    });
    data.models
        .into_iter()
        .map(|(key, entry)| (key, entry.capabilities))
        .collect()
});

fn provider_capabilities(model_id: &str) -> Option<&'static ProviderCapabilities> {
    lookup_key(model_id).and_then(|key| PROVIDER_CAPABILITIES.get(key))
}

/// Whether OpenAI's Chat Completions API accepts tools for a model: `ReasoningOff` when only with
/// reasoning off, `Unsupported` when not at all, `None` when the data does not say.
#[allow(dead_code, reason = "the OpenAI Chat Completions provider reads it")]
pub(crate) fn lookup_chat_completions_tools(model_id: &str) -> Option<ChatCompletionsTools> {
    provider_capabilities(model_id)?.chat_completions_tools
}

/// Where a model's system prompt goes when not in the provider's system prompt field: `Message`
/// at the start of the messages, `None` when the data does not say.
#[allow(dead_code, reason = "the OpenAI Responses provider reads it")]
pub(crate) fn lookup_system_prompt_placement(model_id: &str) -> Option<SystemPromptPlacement> {
    provider_capabilities(model_id)?.system_prompt_placement
}

/// What the shared model info data knows about a model; empty when it knows nothing.
pub(crate) fn lookup_model_info(model_id: &str) -> ModelInfo {
    ModelInfo::merge([lookup_model(model_id)])
}

/// The context window limit the shared data lists for a model id.
#[allow(dead_code, reason = "providers fill `context_window_limit` from it")]
pub(crate) fn get_context_window_limit(model_id: &str) -> Option<u64> {
    lookup_model_info(model_id).limits.context_window
}

/// Tests model info, its lookup and the provider defaults.
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::JsonValue;

    fn base() -> ModelInfo {
        ModelInfo {
            capabilities: ModelCapabilities {
                stateful: Some(false),
                prompt_caching: Some(PromptCaching::CachePoints),
                ..Default::default()
            },
            limits: ModelLimits {
                context_window: Some(200_000),
                ..Default::default()
            },
        }
    }

    fn limits(context_window: u64) -> ModelInfo {
        ModelInfo::builder()
            .limits(ModelLimits::builder().context_window(context_window).build())
            .build()
    }

    fn window(model_id: &str) -> Option<u64> {
        get_context_window_limit(model_id)
    }

    #[test]
    fn returns_the_base_when_nothing_else_is_given() {
        assert_eq!(ModelInfo::merge([Some(&base())]), base());
    }

    #[test]
    fn inherits_fields_a_later_record_leaves_out_or_sets_to_undefined() {
        let merged = ModelInfo::merge([
            Some(&base()),
            Some(&limits(1_000_000)),
            Some(&ModelInfo::builder().capabilities(ModelCapabilities::default()).build()),
        ]);
        assert_eq!(merged.capabilities, base().capabilities);
        assert_eq!(merged.limits.context_window, Some(1_000_000));
    }

    #[test]
    fn lets_a_later_record_win_over_an_earlier_one() {
        let later = ModelInfo {
            capabilities: ModelCapabilities::builder()
                .prompt_caching(PromptCaching::Unsupported)
                .build(),
            limits: ModelLimits::builder().context_window(2).build(),
        };
        let merged = ModelInfo::merge([Some(&base()), Some(&limits(1)), None, Some(&later)]);
        assert_eq!(
            serde_json::to_value(&merged.capabilities).unwrap(),
            json!({"stateful": false, "promptCaching": "unsupported"})
        );
        assert_eq!(merged.limits.context_window, Some(2));
    }

    #[test]
    fn leaves_out_sections_with_nothing_known() {
        let merged = ModelInfo::merge([Some(&ModelInfo::default()), None, Some(&ModelInfo::default())]);
        assert_eq!(serde_json::to_value(merged).unwrap(), json!({}));
    }

    #[test]
    fn resolves_every_spelling_of_a_model_to_its_one_entry() {
        let entry = lookup_model("claude-opus-5-5").unwrap();
        assert_eq!(entry.limits.context_window, Some(1_000_000));
        for id in [
            "anthropic.claude-opus-5-5",
            "us.anthropic.claude-opus-5-5",
            "arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-opus-5-5",
        ] {
            assert!(std::ptr::eq(lookup_model(id).unwrap(), entry), "{id}");
        }
    }

    #[test]
    fn resolves_a_dated_snapshot_to_the_undated_model() {
        assert_eq!(
            lookup_model("anthropic.claude-opus-5-5-20260401-v1:0"),
            lookup_model("claude-opus-5-5")
        );
        assert_eq!(
            lookup_model("claude-haiku-4-5@20251001"),
            lookup_model("claude-haiku-4-5")
        );
        assert!(lookup_model("claude-haiku-4-5").is_some());
        assert_eq!(
            lookup_model("claude-3-5-haiku-20241022").unwrap().limits.context_window,
            Some(200_000)
        );
    }

    #[test]
    fn reads_the_chat_completions_tools_fact_from_the_entry_the_id_resolves_to() {
        let cases = [
            ("gpt-6-sol", Some(ChatCompletionsTools::ReasoningOff)),
            ("us.openai.gpt-6-luna", Some(ChatCompletionsTools::ReasoningOff)),
            ("gpt-6-astra", Some(ChatCompletionsTools::Unsupported)),
            ("openai.gpt-6.1-sol", Some(ChatCompletionsTools::Unsupported)),
            ("openai.gpt-6.2-sol", Some(ChatCompletionsTools::Unsupported)),
            ("gpt-5.4", None),
            ("unknown-model", None),
        ];
        for (model_id, support) in cases {
            assert_eq!(lookup_chat_completions_tools(model_id), support, "{model_id}");
        }
    }

    #[test]
    fn reads_the_system_prompt_placement_fact_from_the_entry_the_id_resolves_to() {
        let cases = [
            ("gpt-6.2-sol", Some(SystemPromptPlacement::Message)),
            ("openai.gpt-6.2-astra", Some(SystemPromptPlacement::Message)),
            ("gpt-6.1-sol", None),
            ("unknown-model", None),
        ];
        for (model_id, placement) in cases {
            assert_eq!(lookup_system_prompt_placement(model_id), placement, "{model_id}");
        }
    }

    #[test]
    fn does_not_read_inherited_object_keys() {
        assert_eq!(lookup_model("toString"), None);
        assert_eq!(lookup_model("x.constructor"), None);
    }

    #[test]
    fn ignores_a_trailing_bedrock_version_suffix() {
        assert_eq!(
            lookup_model("anthropic.claude-3-5-haiku-20241022-v1:0"),
            lookup_model("claude-3-5-haiku-20241022")
        );
        assert_eq!(
            lookup_model("us.anthropic.claude-3-5-sonnet-20241022-v2:0")
                .unwrap()
                .limits
                .context_window,
            Some(200_000)
        );
    }

    #[test]
    fn returns_undefined_for_unknown_ids() {
        assert_eq!(lookup_model("unknown-model"), None);
        assert_eq!(lookup_model(""), None);
    }

    #[test]
    fn keeps_the_typed_fields_and_skips_the_rest() {
        // The data entry also carries defaultEffort, which the SDK does not type.
        assert_eq!(
            serde_json::to_value(lookup_model_info("claude-opus-5-5")).unwrap(),
            json!({
                "capabilities": {
                    "promptCaching": "cachePoints",
                    "forcedToolChoice": false,
                    "nativeStructuredOutput": true,
                    "serverSideSummary": true,
                    "temporaryMessages": true,
                    "deferredToolLoading": "native",
                },
                "limits": {"contextWindow": 1_000_000, "maxOutputTokens": 128_000},
            })
        );
    }

    #[test]
    fn returns_the_entry_facts_and_nothing_for_unknown_ids() {
        assert_eq!(
            serde_json::to_value(lookup_model_info("eu.anthropic.claude-sonnet-4-6")).unwrap(),
            json!({
                "capabilities": {"promptCaching": "cachePoints", "deferredToolLoading": "native"},
                "limits": {"contextWindow": 1_000_000, "maxOutputTokens": 128_000},
            })
        );
        for model_id in [
            "anthropic.claude-opus-5-5",
            "global.anthropic.claude-fable-5-2",
            "claude-mythos-5-2",
        ] {
            assert_eq!(
                serde_json::to_value(lookup_model_info(model_id)).unwrap(),
                json!({
                    "capabilities": {
                        "promptCaching": "cachePoints",
                        "forcedToolChoice": false,
                        "nativeStructuredOutput": true,
                        "serverSideSummary": true,
                        "temporaryMessages": true,
                        "deferredToolLoading": "native",
                    },
                    "limits": {"contextWindow": 1_000_000, "maxOutputTokens": 128_000},
                }),
                "{model_id}"
            );
        }
        assert_eq!(
            serde_json::to_value(lookup_model_info("amazon.nova-pro-v1:0")).unwrap(),
            json!({
                "capabilities": {
                    "forcedToolChoice": true,
                    "nativeStructuredOutput": false,
                    "deferredToolLoading": "unsupported",
                },
                "limits": {"contextWindow": 300_000},
            })
        );
        assert_eq!(lookup_model_info("claude-future-9"), ModelInfo::default());
        assert_eq!(lookup_model_info(""), ModelInfo::default());
    }

    #[test]
    fn keeps_get_context_window_limit_working_for_ids_the_python_table_already_knew() {
        assert_eq!(window("mistral-large-latest"), Some(1_048_576));
        assert_eq!(window("o3"), Some(200_000));
    }

    #[test]
    fn exposes_the_context_window_default_from_the_data() {
        assert_eq!(default_context_window_limit(), 200_000);
    }

    #[test]
    fn has_only_the_fields_model_info_defines_with_the_right_types_in_every_entry() {
        let data: JsonValue = serde_json::from_str(MODEL_INFO_JSON).unwrap();
        let mut keys: Vec<_> = data.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["$comment", "defaults", "models"]);
        assert!(data["defaults"]["limits"]["contextWindow"].is_u64());
        assert_eq!(data["defaults"].as_object().unwrap().len(), 1);
        assert_eq!(data["defaults"]["limits"].as_object().unwrap().len(), 1);
        for (id, entry) in data["models"].as_object().unwrap() {
            let mut chars = id.chars();
            assert!(
                chars
                    .next()
                    .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".:@-".contains(c)),
                "{id}"
            );
            let entry = entry.as_object().unwrap();
            assert!(entry.keys().all(|key| key == "limits" || key == "capabilities"), "{id}");
            for (key, value) in entry.get("limits").and_then(JsonValue::as_object).into_iter().flatten() {
                assert!(
                    ["contextWindow", "maxOutputTokens"].contains(&key.as_str()),
                    "{id}.limits.{key}"
                );
                assert!(value.as_u64().is_some_and(|n| n > 0), "{id}.limits.{key}");
            }
            for (key, value) in entry
                .get("capabilities")
                .and_then(JsonValue::as_object)
                .into_iter()
                .flatten()
            {
                match key.as_str() {
                    "promptCaching" => assert!(
                        ["unsupported", "auto", "cachePoints"].contains(&value.as_str().unwrap()),
                        "{id}.{key}"
                    ),
                    "forcedToolChoice" | "nativeStructuredOutput" | "serverSideSummary" | "temporaryMessages" => {
                        assert!(value.is_boolean(), "{id}.{key}");
                    }
                    "deferredToolLoading" => assert!(
                        ["unsupported", "native"].contains(&value.as_str().unwrap()),
                        "{id}.{key}"
                    ),
                    // Fields the shared file carries for other readers, which `ModelInfo` skips.
                    "defaultEffort" => assert!(
                        ["minimal", "low", "medium", "high", "xhigh", "max"].contains(&value.as_str().unwrap()),
                        "{id}.{key}"
                    ),
                    "chatCompletionsTools" => assert!(
                        ["reasoningOff", "unsupported"].contains(&value.as_str().unwrap()),
                        "{id}.{key}"
                    ),
                    "systemPromptPlacement" => assert_eq!(value, "message", "{id}.{key}"),
                    "toolUse" => assert!(value.is_boolean(), "{id}.{key}"),
                    other => panic!("{id}.capabilities.{other} is not a ModelCapabilities field"),
                }
            }
        }
        assert_eq!(DATA.models.len(), data["models"].as_object().unwrap().len());
    }

    #[test]
    fn returns_the_context_window_limit_for_known_model_ids_across_all_providers() {
        let cases = [
            ("claude-sonnet-4-6", 1_000_000),
            ("claude-opus-4-6", 1_000_000),
            ("claude-opus-4-5", 200_000),
            ("claude-haiku-4-5", 200_000),
            ("anthropic.claude-sonnet-4-6", 1_000_000),
            ("amazon.nova-pro-v1:0", 300_000),
            ("amazon.nova-micro-v1:0", 128_000),
            ("zai.glm-4.7", 203_000),
            ("zai.glm-4.7-flash", 203_000),
            ("zai.glm-5", 200_000),
            ("zai.glm-5.3", 1_000_000),
            ("us.zai.glm-5.3", 1_000_000),
            ("global.zai.glm-5.3", 1_000_000),
            ("mistral.mistral-large-3-675b-instruct", 256_000),
            ("mistral.ministral-3-14b-instruct", 128_000),
            ("mistral.ministral-3-8b-instruct", 128_000),
            ("mistral.ministral-3-3b-instruct", 128_000),
            ("mistral.magistral-small-2509", 128_000),
            ("mistral.pixtral-large-2502-v1:0", 128_000),
            ("mistral.mistral-small-2402-v1:0", 32_000),
            ("mistral.mistral-large-2402-v1:0", 32_000),
            ("us.mistral.mistral-large-3-675b-instruct", 256_000),
            ("global.mistral.mistral-large-3-675b-instruct", 256_000),
            ("google.gemma-4-31b", 256_000),
            ("google.gemma-4-26b-a4b", 256_000),
            ("google.gemma-4-e2b", 128_000),
            ("us.google.gemma-4-31b", 256_000),
            ("xai.grok-4.7", 524_288),
            ("xai.grok-4.6", 500_000),
            ("xai.grok-4.3", 1_000_000),
            ("us.xai.grok-4.7", 524_288),
            ("global.xai.grok-4.7", 524_288),
            ("chat-latest", 272_000),
            ("gpt-6.2-astra", 1_050_000),
            ("gpt-6.2-sol", 1_050_000),
            ("gpt-6-astra", 1_050_000),
            ("gpt-6.1-sol", 1_050_000),
            ("gpt-6.1-terra", 1_050_000),
            ("gpt-6-sol", 1_050_000),
            ("gpt-6-luna", 1_050_000),
            ("gpt-6-cyber", 1_050_000),
            ("gpt-5.4", 1_050_000),
            ("gpt-4o", 128_000),
            ("o3", 200_000),
            ("o4-mini", 200_000),
            ("gpt-oss-120b", 131_072),
            ("gpt-oss-20b", 131_072),
            ("gemini-4-argon", 1_048_576),
            ("gemini-4-neon", 1_048_576),
            ("gemini-4-hydrogen", 1_048_576),
            ("gemini-3.8-flash", 1_048_576),
            ("gemini-3.7-flash", 1_048_576),
            ("gemini-2.5-flash", 1_048_576),
            ("gemini-2.5-pro", 1_048_576),
        ];
        for (model_id, expected) in cases {
            assert_eq!(window(model_id), Some(expected), "{model_id}");
        }
    }

    #[test]
    fn returns_1m_for_the_current_generation_anthropic_models() {
        for model_id in [
            "claude-sonnet-5-5",
            "claude-opus-5-5",
            "claude-fable-5-1",
            "anthropic.claude-sonnet-5-5",
            "anthropic.claude-opus-5-5",
            "anthropic.claude-fable-5-1",
            "global.anthropic.claude-opus-5-5",
            "us.anthropic.claude-fable-5-1",
            "claude-haiku-5-5",
            "anthropic.claude-haiku-5-5",
            "eu.anthropic.claude-haiku-5-5",
            "global.anthropic.claude-haiku-5-5",
            "claude-fable-5-2",
            "global.anthropic.claude-fable-5-2",
            "claude-mythos-5-2",
            "us.anthropic.claude-mythos-5-2",
        ] {
            assert_eq!(window(model_id), Some(1_000_000), "{model_id}");
        }
    }

    #[test]
    fn returns_the_bedrock_window_for_gpt_oss_not_the_openai_hosted_one() {
        for model_id in [
            "openai.gpt-oss-120b",
            "openai.gpt-oss-120b-1:0",
            "openai.gpt-oss-20b",
            "openai.gpt-oss-20b-1:0",
            "openai.gpt-oss-safeguard-120b",
            "openai.gpt-oss-safeguard-20b",
            "us.openai.gpt-oss-120b-1:0",
            "global.openai.gpt-oss-120b",
        ] {
            assert_eq!(window(model_id), Some(128_000), "{model_id}");
        }
    }

    #[test]
    fn resolves_bedrock_gpt_ids_which_are_not_derivable_from_the_openai_hosted_rows() {
        let cases = [
            ("openai.gpt-6-astra", 1_050_000),
            ("openai.gpt-6.1-sol", 1_000_000),
            ("openai.gpt-6.1-terra", 1_050_000),
            ("openai.gpt-6-sol", 1_050_000),
            ("openai.gpt-6-luna", 1_050_000),
            ("openai.gpt-5.6-sol", 1_050_000),
            ("openai.gpt-5.6-terra", 1_050_000),
            ("openai.gpt-5.6-luna", 1_050_000),
            ("openai.gpt-5.6-cyber", 1_050_000),
            ("openai.gpt-daybreak-blue-5.6-sol", 1_050_000),
            ("openai.gpt-5.5", 1_050_000),
            ("openai.gpt-5.4", 1_050_000),
            ("us.openai.gpt-5.5", 1_050_000),
            ("global.openai.gpt-6.1-sol", 1_000_000),
            ("us.openai.gpt-6.1-terra", 1_050_000),
            ("us.openai.gpt-6.2-astra", 1_050_000),
            ("global.openai.gpt-6.2-sol", 1_050_000),
            ("in.openai.gpt-5.6-luna", 1_050_000),
        ];
        for (model_id, expected) in cases {
            assert_eq!(window(model_id), Some(expected), "{model_id}");
        }
    }

    #[test]
    fn strips_bedrock_cross_region_prefix_before_lookup() {
        assert_eq!(window("us.anthropic.claude-sonnet-4-6"), Some(1_000_000));
        assert_eq!(window("global.anthropic.claude-sonnet-4-6"), Some(1_000_000));
    }

    #[test]
    fn strips_leading_segments_one_at_a_time_like_the_python_sdk_so_unknown_prefixes_and_arns_resolve() {
        assert_eq!(window("custom.gpt-5.4"), window("gpt-5.4"));
        assert_eq!(
            window("arn:aws:bedrock:us-west-2:123:inference-profile/us.anthropic.claude-sonnet-4-6"),
            Some(1_000_000)
        );
    }

    #[test]
    fn returns_undefined_for_unknown_model_ids() {
        assert_eq!(window("unknown-model-xyz"), None);
        assert_eq!(window("us.unknown.model-v1:0"), None);
    }

    #[test]
    fn version_and_date_suffixes_strip_only_their_exact_forms() {
        assert_eq!(strip_version_suffix("model-v1:0"), "model");
        assert_eq!(strip_version_suffix("model-v2"), "model");
        assert_eq!(strip_version_suffix("model-1:0"), "model");
        assert_eq!(strip_version_suffix("model-1"), "model-1");
        assert_eq!(strip_version_suffix("model-v"), "model-v");
        assert_eq!(strip_version_suffix("model-v1:"), "model-v1:");
        assert_eq!(strip_date_suffix("model-20260401"), "model");
        assert_eq!(strip_date_suffix("model@20251001"), "model");
        assert_eq!(strip_date_suffix("model-2026040"), "model-2026040");
        assert_eq!(strip_date_suffix("model_20260401"), "model_20260401");
        assert_eq!(strip_date_suffix("é20260401"), "é20260401");
    }
}
