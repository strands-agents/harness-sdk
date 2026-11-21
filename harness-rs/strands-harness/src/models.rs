//! Model resolution from `provider/name` strings, with per-provider reasoning effort and
//! caching.
//!
//! A model option is a model instance, a router, a `"provider/name"` string or a bare Bedrock
//! model id. Every provider uses its real model ids. The [`Effort`] level maps to each provider's
//! own request fields here, so the caller sets one value whatever the provider. Prompt caching
//! reaches Bedrock and Anthropic as an SDK cache config (cache points plus cached tool
//! definitions) and OpenAI and Bedrock Mantle as one too (a per-session cache key, plus cache
//! points on models that take them). A pre-built instance cannot be configured, so effort and
//! caching are only warned about there.
//!
//! Resolution first computes a [`ModelPlan`], the provider and the exact config fields, then
//! builds the provider from it; a provider whose cargo feature is disabled fails at that step.

use std::sync::Arc;

use serde_json::{Value, json};
use strands::ModelSource;
use strands::models::Model;
use strands::models::routing::CandidateModel;

use crate::defaults::DEFAULT_MODEL;
use crate::env::Env;
use crate::logging::warn_once;
use crate::types::{Effort, json_string};

const ANTHROPIC_MAX_TOKENS: u64 = 32_000;

const CLAUDE_MAX_TOKENS: [(&str, u64); 4] = [
    ("claude-opus-", 128_000),
    ("claude-sonnet-", 128_000),
    ("claude-haiku-", 128_000),
    ("claude-fable-", 128_000),
];

const CLAUDE_MAX_TOKENS_BY_VERSION: [(&str, u64); 6] = [
    ("claude-opus-4-5", 64_000),
    ("claude-opus-4.5", 64_000),
    ("claude-sonnet-4-5", 64_000),
    ("claude-sonnet-4.5", 64_000),
    ("claude-haiku-4-5", 64_000),
    ("claude-haiku-4.5", 64_000),
];

/// Small fast model per provider for the `web_fetch` summarizer (and memory extraction), keyed by
/// the main agent's provider so it shares its credentials.
const WEB_FETCH_MODELS: [(Provider, &str); 4] = [
    (Provider::Bedrock, "global.anthropic.claude-haiku-4-5-20251001-v1:0"),
    (Provider::BedrockMantle, "openai.gpt-5.6-luna"),
    (Provider::Anthropic, "claude-haiku-4-5-20251001"),
    (Provider::OpenAI, "gpt-5.6-luna"),
];

/// Providers whose endpoint an env var can repoint; such an endpoint serves its own model list.
const CUSTOM_ENDPOINT_VARS: [(Provider, &str); 2] = [
    (Provider::Anthropic, "ANTHROPIC_BASE_URL"),
    (Provider::OpenAI, "OPENAI_BASE_URL"),
];

const BEDROCK_REGION_PREFIXES: [&str; 6] = ["global.", "apac.", "us.", "eu.", "au.", "jp."];
const BEDROCK_GPT_PREFIXES: [&str; 4] = [
    "openai.gpt-5.",
    "openai.gpt-daybreak-",
    "openai.gpt-6-",
    "openai.gpt-6.",
];

const ANTHROPIC_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const OPENAI_LEVELS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "none"];
const BEDROCK_GPT_LEVELS: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];
// Converse rejects max on GPT-5.4/5.5 and none on GPT-6 Astra/6.1 Sol.
const BEDROCK_GPT_NO_MAX_LEVELS: &[&str] = &["none", "low", "medium", "high", "xhigh"];
const BEDROCK_GPT_NO_NONE_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const BEDROCK_GPT_OSS_LEVELS: &[&str] = &["low", "medium", "high"];
const BEDROCK_QWEN_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const BEDROCK_XAI_LEVELS: &[&str] = &["low", "medium", "high", "xhigh"];
// Gemma 4 on Mantle only reasons at `high`.
const MANTLE_MODEL_LEVELS: [(&str, &[&str]); 1] = [("google.gemma-4-", &["none", "high"])];
const NO_THINKING_LEVELS: &[&str] = &[];

const CLAUDE_FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "mythos"];

fn adaptive_thinking_since(family: &str) -> Option<(u32, u32)> {
    match family {
        "opus" | "sonnet" => Some((4, 6)),
        "haiku" => Some((5, 5)),
        _ => None,
    }
}

fn extended_thinking_since(family: &str) -> Option<(u32, u32)> {
    matches!(family, "opus" | "sonnet" | "haiku").then_some((4, 5))
}

fn extended_thinking_budget(effort: &str) -> u64 {
    match effort {
        "low" => 2_048,
        "medium" => 8_192,
        "xhigh" => 32_768,
        "max" => 49_152,
        _ => 16_384,
    }
}

/// A model provider a `"provider/name"` string can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    Bedrock,
    BedrockMantle,
    Anthropic,
    OpenAI,
}

impl Provider {
    const ALL: [Self; 4] = [Self::Anthropic, Self::Bedrock, Self::BedrockMantle, Self::OpenAI];

    fn name(self) -> &'static str {
        match self {
            Self::Bedrock => "bedrock",
            Self::BedrockMantle => "bedrock-mantle",
            Self::Anthropic => "anthropic",
            Self::OpenAI => "openai",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|provider| provider.name() == name)
    }

    /// The level `'auto'` maps to.
    fn recommended(self) -> Option<&'static str> {
        Some("high")
    }

    fn levels(self) -> &'static [&'static str] {
        match self {
            Self::Bedrock | Self::Anthropic => ANTHROPIC_LEVELS,
            Self::BedrockMantle | Self::OpenAI => OPENAI_LEVELS,
        }
    }

    /// Whether native web search is enabled through model config: OpenAI Responses tools for
    /// OpenAI and Mantle, Anthropic server tools; Bedrock Converse has no mechanism.
    fn web_search(self) -> bool {
        self != Self::Bedrock
    }

    /// The cargo feature of `strands-harness` (and of `strands`, under the same name) the provider
    /// needs.
    fn feature(self) -> &'static str {
        match self {
            Self::Bedrock => "bedrock",
            Self::Anthropic => "anthropic",
            Self::BedrockMantle => "mantle",
            Self::OpenAI => "openai",
        }
    }
}

/// Providers a model string can name that this crate does not support yet, with whether each
/// takes a reasoning level, so [`supports_thinking`] still answers for them.
const UNSUPPORTED_PROVIDERS: [(&str, bool); 3] = [("google", true), ("ollama", false), ("litellm", false)];

/// The provider and exact config a model string resolves to, before the provider is built.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ModelPlan {
    /// The `"provider/name"` string resolved.
    pub(crate) spec: String,
    pub(crate) provider: Provider,
    pub(crate) model_id: String,
    pub(crate) max_tokens: Option<u64>,
    /// Whether the provider gets `cache_config: { strategy: auto }`.
    pub(crate) caching: bool,
    /// Bedrock `additional_request_fields`.
    pub(crate) additional_request_fields: Option<Value>,
    /// Anthropic, OpenAI and Mantle `params`.
    pub(crate) params: Option<Value>,
    /// Anthropic `anthropic_tools`.
    pub(crate) anthropic_tools: Option<Vec<Value>>,
    /// Bedrock and Mantle region, from `AWS_REGION` or else `AWS_DEFAULT_REGION`.
    pub(crate) region: Option<String>,
}

/// A parsed Claude model id (`CLAUDE_ID`): the optional leading version, the family and the
/// optional trailing version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClaudeId<'a> {
    lead: Option<(u32, Option<u32>)>,
    family: &'a str,
    major: Option<u32>,
    minor: Option<u32>,
}

fn digits_options(text: &str) -> Vec<(u32, usize)> {
    let count = text.bytes().take(2).take_while(u8::is_ascii_digit).count();
    (1..=count)
        .rev()
        .filter_map(|len| text[..len].parse().ok().map(|value| (value, len)))
        .collect()
}

/// `(?:[-.](\d{1,2}))?` in backtracking order: two digits, one digit, absent.
fn version_part_options(text: &str) -> Vec<(Option<u32>, usize)> {
    let mut options: Vec<(Option<u32>, usize)> = Vec::new();
    if text.starts_with(['-', '.']) {
        options.extend(
            digits_options(&text[1..])
                .into_iter()
                .map(|(value, len)| (Some(value), len + 1)),
        );
    }
    options.push((None, 0));
    options
}

/// `(?:(\d{1,2})(?:[-.](\d{1,2}))?-)?` in backtracking order.
/// A leading `major[-.minor]-` version.
type Lead = Option<(u32, Option<u32>)>;

fn lead_options(text: &str) -> Vec<(Lead, usize)> {
    let mut options = Vec::new();
    for (major, major_len) in digits_options(text) {
        for (minor, minor_len) in version_part_options(&text[major_len..]) {
            let consumed = major_len + minor_len;
            if text[consumed..].starts_with('-') {
                options.push((Some((major, minor)), consumed + 1));
            }
        }
    }
    options.push((None, 0));
    options
}

/// Matches the `CLAUDE_ID` pattern, including its `(?!\d)` lookahead and backtracking; the
/// `regex` crate has no lookahead.
fn parse_claude_id(model_id: &str) -> Option<ClaudeId<'_>> {
    for (start, _) in model_id.match_indices("claude-") {
        let rest = &model_id[start + "claude-".len()..];
        for (lead, lead_len) in lead_options(rest) {
            let after_lead = &rest[lead_len..];
            let Some(family) = CLAUDE_FAMILIES.iter().find(|family| after_lead.starts_with(**family)) else {
                continue;
            };
            let after_family = &after_lead[family.len()..];
            for (major, major_len) in version_part_options(after_family) {
                let after_major = &after_family[major_len..];
                for (minor, minor_len) in version_part_options(after_major) {
                    if !after_major[minor_len..].starts_with(|c: char| c.is_ascii_digit()) {
                        return Some(ClaudeId {
                            lead,
                            family,
                            major,
                            minor,
                        });
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThinkingMode {
    Adaptive,
    Extended,
}

fn at_least(version: (u32, u32), floor: Option<(u32, u32)>) -> bool {
    floor.is_some_and(|floor| version >= floor)
}

/// Which thinking a Claude model takes: `None` below the thinking floor.
/// An id that does not parse fails open to adaptive.
fn claude_thinking_mode(model_id: &str) -> Option<ThinkingMode> {
    let Some(id) = parse_claude_id(model_id) else {
        return Some(ThinkingMode::Adaptive);
    };
    let family = id.family;
    let version = match (id.major, id.lead) {
        (None, None) => {
            let takes_adaptive = extended_thinking_since(family).is_none() || adaptive_thinking_since(family).is_some();
            return Some(if takes_adaptive {
                ThinkingMode::Adaptive
            } else {
                ThinkingMode::Extended
            });
        }
        (Some(major), _) => (major, id.minor.unwrap_or(0)),
        (None, Some((major, minor))) => (major, minor.unwrap_or(0)),
    };
    if extended_thinking_since(family).is_none() || at_least(version, adaptive_thinking_since(family)) {
        return Some(ThinkingMode::Adaptive);
    }
    at_least(version, extended_thinking_since(family)).then_some(ThinkingMode::Extended)
}

fn claude_max_tokens(model_id: &str) -> Option<u64> {
    CLAUDE_MAX_TOKENS_BY_VERSION
        .iter()
        .chain(CLAUDE_MAX_TOKENS.iter())
        .find(|(needle, _)| model_id.contains(needle))
        .map(|(_, max_tokens)| *max_tokens)
}

fn claude_thinking_block(model_id: &str, effort: &str, max_tokens: u64) -> Value {
    if claude_thinking_mode(model_id) == Some(ThinkingMode::Extended) {
        let budget = extended_thinking_budget(effort).min(max_tokens.saturating_sub(1));
        return json!({ "thinking": { "type": "enabled", "budget_tokens": budget } });
    }
    json!({
        "thinking": { "type": "adaptive", "display": "summarized" },
        "output_config": { "effort": effort },
    })
}

fn bedrock_family(model_id: &str) -> &str {
    BEDROCK_REGION_PREFIXES
        .iter()
        .find_map(|prefix| model_id.strip_prefix(prefix))
        .unwrap_or(model_id)
}

fn is_bedrock_gpt(family: &str) -> bool {
    BEDROCK_GPT_PREFIXES.iter().any(|prefix| family.starts_with(prefix))
}

fn bedrock_levels(model_id: &str) -> &'static [&'static str] {
    let family = bedrock_family(model_id);
    if family.starts_with("anthropic.") {
        return if claude_thinking_mode(family).is_some() {
            ANTHROPIC_LEVELS
        } else {
            NO_THINKING_LEVELS
        };
    }
    if family.starts_with("openai.gpt-5.4") || family.starts_with("openai.gpt-5.5") {
        return BEDROCK_GPT_NO_MAX_LEVELS;
    }
    if family.starts_with("openai.gpt-6-astra") || family.starts_with("openai.gpt-6.1-sol") {
        return BEDROCK_GPT_NO_NONE_LEVELS;
    }
    if is_bedrock_gpt(family) {
        return BEDROCK_GPT_LEVELS;
    }
    if family.starts_with("openai.gpt-oss-") {
        return BEDROCK_GPT_OSS_LEVELS;
    }
    if family.starts_with("qwen.") {
        return BEDROCK_QWEN_LEVELS;
    }
    if family.starts_with("xai.") {
        return BEDROCK_XAI_LEVELS;
    }
    NO_THINKING_LEVELS
}

fn bedrock_thinking(model_id: &str, effort: Option<&str>) -> Option<Value> {
    let effort = effort?;
    let family = bedrock_family(model_id);
    if family.starts_with("anthropic.") {
        let max_tokens = claude_max_tokens(model_id).unwrap_or(ANTHROPIC_MAX_TOKENS);
        return Some(claude_thinking_block(family, effort, max_tokens));
    }
    if is_bedrock_gpt(family) {
        return Some(json!({ "reasoning": { "effort": effort } }));
    }
    let reasoning_effort = ["openai.gpt-oss-", "qwen.", "xai."]
        .iter()
        .any(|prefix| family.starts_with(prefix));
    reasoning_effort.then(|| json!({ "reasoning_effort": effort }))
}

/// Maps an effort to the level sent to a provider: the provider's `none` (or
/// `None`, omitting the reasoning field) for `Off`, the recommended level for `Auto`, the level
/// itself when supported; anything else fails.
fn resolve_effort(
    effort: Effort,
    recommended: Option<&'static str>,
    levels: &[&'static str],
    subject: &str,
) -> strands::Result<Option<&'static str>> {
    match effort {
        Effort::Off => return Ok(levels.contains(&"none").then_some("none")),
        Effort::Auto => return Ok(recommended),
        _ => {}
    }
    if let Some(level) = levels.iter().find(|level| **level == effort.as_str()) {
        return Ok(Some(level));
    }
    let supported: Vec<&str> = levels.iter().copied().filter(|level| *level != "none").collect();
    let detail = if supported.is_empty() {
        "It supports no reasoning levels; pass 'auto' or 'off'.".to_owned()
    } else {
        format!("Supported levels: {} (or 'auto', 'off').", supported.join(", "))
    };
    Err(strands::Error::other(format!(
        "Effort {} is not supported by {subject}. {detail}",
        json_string(effort.as_str())
    )))
}

fn split_provider(spec: &str) -> (&str, &str) {
    spec.split_once('/').unwrap_or(("bedrock", spec))
}

/// The provider a `"provider/name"` string names, or the unknown or unsupported provider error.
fn provider_of(provider_name: &str, spec: &str) -> strands::Result<Provider> {
    if let Some(provider) = Provider::parse(provider_name) {
        return Ok(provider);
    }
    if UNSUPPORTED_PROVIDERS.iter().any(|(name, _)| *name == provider_name) {
        return Err(strands::Error::other(format!(
            "model provider {} is not supported in Rust yet",
            json_string(provider_name)
        )));
    }
    let supported = Provider::ALL.map(Provider::name).join(", ");
    Err(strands::Error::other(format!(
        "Unknown model provider {} in {}. Supported providers: {supported}. Pass a Model instance for anything else.",
        json_string(provider_name),
        json_string(spec)
    )))
}

fn has_web_search(provider: Provider, name: &str) -> bool {
    provider.web_search() && (provider != Provider::BedrockMantle || is_bedrock_gpt(name))
}

/// Fails when a feature was requested explicitly but cannot be honored; otherwise (it is only
/// on by default) warns and lets the caller go on without it.
fn require_or_warn(explicit: bool, error: String, warning: &str) -> strands::Result<()> {
    if explicit {
        return Err(strands::Error::other(error));
    }
    warn_once(warning);
    Ok(())
}

/// What the model option resolves to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ModelRequest {
    pub(crate) effort: Effort,
    pub(crate) web_search: bool,
    pub(crate) caching: bool,
    pub(crate) caching_explicit: bool,
}

/// Plans the model for a `"provider/name"` string.
pub(crate) fn plan_model(spec: &str, request: ModelRequest, env: &Env) -> strands::Result<ModelPlan> {
    let (provider_name, name) = split_provider(spec);
    let provider = provider_of(provider_name, spec)?;
    let native_search = request.web_search && has_web_search(provider, name);
    let unsupported_caching =
        provider == Provider::Bedrock && bedrock_family(name).starts_with("anthropic.claude-3-haiku-");
    if request.caching && unsupported_caching {
        require_or_warn(
            request.caching_explicit,
            format!("Model {provider_name}/{name} does not support prompt caching. Pass caching: false."),
            &format!(
                "model=<{provider_name}/{name}> | prompt caching not supported by this model; continuing without it"
            ),
        )?;
    }
    let (levels, recommended) = match provider {
        Provider::Anthropic if claude_thinking_mode(name).is_none() => (NO_THINKING_LEVELS, None),
        Provider::BedrockMantle => (
            MANTLE_MODEL_LEVELS
                .iter()
                .find(|(prefix, _)| name.starts_with(prefix))
                .map_or(provider.levels(), |(_, levels)| *levels),
            provider.recommended(),
        ),
        _ => (provider.levels(), provider.recommended()),
    };
    let effort = if provider == Provider::Bedrock {
        let levels = bedrock_levels(name);
        let recommended = (!levels.is_empty()).then_some("high");
        resolve_effort(request.effort, recommended, levels, &format!("Bedrock model {name}"))?
    } else {
        resolve_effort(request.effort, recommended, levels, &format!("model {name}"))?
    };
    let caching = request.caching && !unsupported_caching;
    let region = env.get("AWS_REGION").or_else(|| env.get("AWS_DEFAULT_REGION"));
    let base = ModelPlan {
        spec: spec.to_owned(),
        provider,
        model_id: name.to_owned(),
        max_tokens: None,
        caching,
        additional_request_fields: None,
        params: None,
        anthropic_tools: None,
        region: None,
    };
    Ok(match provider {
        Provider::Bedrock => ModelPlan {
            max_tokens: claude_max_tokens(name),
            additional_request_fields: bedrock_thinking(name, effort),
            region,
            ..base
        },
        Provider::Anthropic => {
            let max_tokens = claude_max_tokens(name).unwrap_or(ANTHROPIC_MAX_TOKENS);
            ModelPlan {
                max_tokens: Some(max_tokens),
                params: effort.map(|effort| claude_thinking_block(name, effort, max_tokens)),
                anthropic_tools: native_search.then(|| {
                    vec![json!({ "type": "web_search_20260318", "name": "web_search", "allowed_callers": ["direct"] })]
                }),
                ..base
            }
        }
        Provider::OpenAI | Provider::BedrockMantle => {
            let mut params = serde_json::Map::new();
            if let Some(effort) = effort {
                params.insert("reasoning".to_owned(), json!({ "effort": effort }));
            }
            if native_search {
                let tool = if provider == Provider::OpenAI {
                    json!({ "type": "web_search" })
                } else {
                    json!({ "type": "web_search", "external_web_access": true })
                };
                params.insert("tools".to_owned(), json!([tool]));
            }
            ModelPlan {
                params: (!params.is_empty()).then_some(Value::Object(params)),
                region: (provider == Provider::BedrockMantle).then_some(region).flatten(),
                ..base
            }
        }
    })
}

fn feature_disabled(plan: &ModelPlan) -> strands::Error {
    strands::Error::other(format!(
        "model '{}' requires the strands-harness feature {}",
        plan.spec,
        json_string(plan.provider.feature())
    ))
}

#[cfg(any(feature = "bedrock", feature = "anthropic", feature = "openai"))]
fn auto_cache(enabled: bool) -> Option<strands::models::CacheConfig> {
    enabled.then(|| strands::models::CacheConfig {
        strategy: Some(strands::models::CacheStrategy::Auto),
        ..Default::default()
    })
}

#[cfg(feature = "bedrock")]
fn build_bedrock(plan: &ModelPlan) -> strands::Result<Arc<dyn Model>> {
    use strands::models::{BedrockModel, BedrockModelOptions};

    Ok(Arc::new(BedrockModel::new(BedrockModelOptions {
        model_id: Some(plan.model_id.clone()),
        region: plan.region.clone(),
        max_tokens: plan.max_tokens,
        cache_config: auto_cache(plan.caching),
        additional_request_fields: plan.additional_request_fields.clone(),
        ..Default::default()
    })))
}

#[cfg(feature = "anthropic")]
fn build_anthropic(plan: &ModelPlan, env: &Env) -> strands::Result<Arc<dyn Model>> {
    use strands::models::{AnthropicModel, AnthropicModelOptions};

    Ok(Arc::new(AnthropicModel::new(AnthropicModelOptions {
        model_id: Some(plan.model_id.clone()),
        max_tokens: plan.max_tokens,
        cache_config: auto_cache(plan.caching),
        params: plan.params.clone(),
        anthropic_tools: plan.anthropic_tools.clone(),
        api_key: env.get("ANTHROPIC_API_KEY"),
        ..Default::default()
    })?))
}

#[cfg(feature = "openai")]
fn openai_options(plan: &ModelPlan) -> strands::models::openai::OpenAIModelOptions {
    strands::models::openai::OpenAIModelOptions {
        model_id: Some(plan.model_id.clone()),
        cache_config: auto_cache(plan.caching),
        params: plan.params.clone(),
        ..Default::default()
    }
}

#[cfg(feature = "openai")]
fn build_openai(plan: &ModelPlan, env: &Env) -> strands::Result<Arc<dyn Model>> {
    use strands::models::openai::{OpenAIClientConfig, OpenAIModel, OpenAIModelOptions};

    Ok(Arc::new(OpenAIModel::new(OpenAIModelOptions {
        api_key: env.get("OPENAI_API_KEY").map(Into::into),
        // The SDK reads `OPENAI_BASE_URL` too; passing it keeps the environment injectable.
        client_config: env
            .get("OPENAI_BASE_URL")
            .map(|base_url| OpenAIClientConfig::builder().base_url(base_url).build()),
        ..openai_options(plan)
    })?))
}

#[cfg(feature = "mantle")]
fn build_mantle(plan: &ModelPlan) -> strands::Result<Arc<dyn Model>> {
    use strands::models::openai::{BedrockMantleConfig, OpenAIModel};

    let mantle_config = BedrockMantleConfig {
        region: plan.region.clone(),
        ..Default::default()
    };
    Ok(Arc::new(OpenAIModel::bedrock_mantle(
        openai_options(plan),
        mantle_config,
    )?))
}

/// Builds the provider a plan describes; a provider whose feature is disabled fails.
pub(crate) fn build_model(plan: &ModelPlan, env: &Env) -> strands::Result<Arc<dyn Model>> {
    let _ = env;
    match plan.provider {
        #[cfg(feature = "bedrock")]
        Provider::Bedrock => build_bedrock(plan),
        #[cfg(feature = "anthropic")]
        Provider::Anthropic => build_anthropic(plan, env),
        #[cfg(feature = "openai")]
        Provider::OpenAI => build_openai(plan, env),
        #[cfg(feature = "mantle")]
        Provider::BedrockMantle => build_mantle(plan),
        #[allow(unreachable_patterns, reason = "reachable when a provider feature is disabled")]
        _ => Err(feature_disabled(plan)),
    }
}

/// The resolved model and, for a model string, the plan it was built from.
#[derive(Clone)]
pub(crate) struct ResolvedModel {
    pub(crate) source: ModelSource,
    pub(crate) plan: Option<ModelPlan>,
}

/// Resolves the `model` option into a model.
///
/// A model instance or router is used as is; `effort` and `caching` do not apply to it, so an
/// explicit request for either is warned about once. `None` resolves `default_model`.
pub(crate) fn resolve_model(
    model: Option<&ModelSource>,
    default_model: &str,
    request: ModelRequest,
    env: &Env,
) -> strands::Result<ResolvedModel> {
    let spec = match model {
        None => default_model,
        Some(ModelSource::Id(spec)) => spec.as_str(),
        Some(instance) => {
            if request.effort != Effort::Auto {
                warn_once(&format!(
                    "effort {} not applied to a pre-built Model instance or ModelRouter; configure reasoning on the instance",
                    json_string(request.effort.as_str())
                ));
            }
            if request.caching && request.caching_explicit {
                warn_once(
                    "prompt caching not applied to a pre-built Model instance or ModelRouter; configure it on the instance",
                );
            }
            return Ok(ResolvedModel {
                source: instance.clone(),
                plan: None,
            });
        }
    };
    let plan = plan_model(spec, request, env)?;
    let built = build_model(&plan, env)?;
    Ok(ResolvedModel {
        source: ModelSource::Model(built),
        plan: Some(plan),
    })
}

fn concrete(source: ModelSource) -> strands::Result<Arc<dyn Model>> {
    match source {
        ModelSource::Model(model) => Ok(model),
        ModelSource::Router(router) => Ok(router.default_model()),
        _ => Err(strands::Error::other("a model id did not resolve to a model")),
    }
}

/// Plans a summarizer model string with reasoning off and no caching.
fn plan_summarizer(spec: &str, env: &Env) -> strands::Result<ModelPlan> {
    let request = ModelRequest {
        effort: Effort::Off,
        ..Default::default()
    };
    plan_model(spec, request, env)
}

/// What the `web_fetch` summarizer resolves to before it is built: an existing model, or a
/// plan for a model string.
#[derive(Clone)]
#[allow(clippy::large_enum_variant, reason = "built once per agent")]
pub(crate) enum SummarizerPlan {
    Instance(Arc<dyn Model>),
    Plan(ModelPlan),
}

/// Plans the model the `web_fetch` summarizer (and memory extraction) runs on.
///
/// An explicit `web_fetch_model` wins. Otherwise the small fast model of the main agent's
/// provider is used so it shares its credentials; a main model instance (provider unknown) is
/// reused. On Bedrock the summarizer follows the main model's family, and a family with no
/// mapped small model reuses the main model with a warning. Reasoning is never applied, and caching is not
/// forwarded: each fetch would write a cache entry no later call can read.
pub(crate) fn plan_web_fetch_model(
    main_model: Option<&ModelSource>,
    web_fetch_model: Option<&ModelSource>,
    env: &Env,
) -> strands::Result<SummarizerPlan> {
    match web_fetch_model {
        Some(ModelSource::Id(spec)) => return plan_summarizer(spec, env).map(SummarizerPlan::Plan),
        Some(instance) => return concrete(instance.clone()).map(SummarizerPlan::Instance),
        None => {}
    }
    let main = match main_model {
        None => DEFAULT_MODEL,
        Some(ModelSource::Id(spec)) => spec.as_str(),
        Some(instance) => return concrete(instance.clone()).map(SummarizerPlan::Instance),
    };
    let (provider_name, name) = split_provider(main);
    let provider = provider_of(provider_name, main)?;
    if provider == Provider::Bedrock {
        let Some(small) = bedrock_web_fetch_model(name) else {
            warn_once(&format!(
                "model=<{main}> | no small web_fetch summarizer is mapped for this Bedrock model family; reusing the main model. Pass builtinTools.web_fetch.model to choose a smaller one."
            ));
            return plan_summarizer(main, env).map(SummarizerPlan::Plan);
        };
        return plan_summarizer(&format!("bedrock/{small}"), env).map(SummarizerPlan::Plan);
    }
    if let Some((_, base_url_var)) = CUSTOM_ENDPOINT_VARS
        .iter()
        .find(|(endpoint_provider, var)| *endpoint_provider == provider && env.get(var).is_some())
    {
        warn_once(&format!(
            "model=<{main}> | {base_url_var} points provider <{provider_name}> at a non-default endpoint, which serves its own model list, so the vended summarizer may not exist there; reusing the main model. Pass builtinTools.web_fetch.model to choose a smaller one."
        ));
        return plan_summarizer(main, env).map(SummarizerPlan::Plan);
    }
    let small = web_fetch_small_model(provider);
    plan_summarizer(&format!("{provider_name}/{small}"), env).map(SummarizerPlan::Plan)
}

/// Builds the summarizer [`plan_web_fetch_model`] plans.
pub(crate) fn resolve_web_fetch_model(
    main_model: Option<&ModelSource>,
    web_fetch_model: Option<&ModelSource>,
    env: &Env,
) -> strands::Result<Arc<dyn Model>> {
    match plan_web_fetch_model(main_model, web_fetch_model, env)? {
        SummarizerPlan::Instance(model) => Ok(model),
        SummarizerPlan::Plan(plan) => build_model(&plan, env),
    }
}

fn web_fetch_small_model(provider: Provider) -> &'static str {
    WEB_FETCH_MODELS
        .iter()
        .find(|(candidate, _)| *candidate == provider)
        .map_or("", |(_, model)| *model)
}

/// The small Bedrock summarizer for a Bedrock main model `name`, or `None` for a family with no
/// mapped small model.
fn bedrock_web_fetch_model(name: &str) -> Option<String> {
    let family = bedrock_family(name);
    if family.starts_with("anthropic.") {
        return Some(web_fetch_small_model(Provider::Bedrock).to_owned());
    }
    if family.starts_with("openai.") {
        let prefix = &name[..name.len() - family.len()];
        return Some(format!("{prefix}openai.{}", web_fetch_small_model(Provider::OpenAI)));
    }
    None
}

/// Whether `model` accepts image and document blocks in a tool result.
///
/// OpenAI-family models on Bedrock Converse reject both, which fails the whole turn, so `read`
/// describes those files in text instead. Every router candidate has to accept media. A model
/// instance is judged by its model id with the Bedrock rule; Rust cannot tell its provider.
#[cfg_attr(not(test), allow(dead_code, reason = "the read tool's media default uses it"))]
pub(crate) fn supports_media(model: Option<&ModelSource>) -> bool {
    match model {
        None => spec_supports_media(DEFAULT_MODEL),
        Some(ModelSource::Id(spec)) => spec_supports_media(spec),
        Some(ModelSource::Model(model)) => instance_supports_media(model.as_ref()),
        Some(ModelSource::Router(router)) => router.candidates().iter().all(|candidate| match candidate.model() {
            CandidateModel::Model(model) => instance_supports_media(model.as_ref()),
            CandidateModel::Router(router) => supports_media(Some(&ModelSource::Router(router.clone()))),
            _ => true,
        }),
        Some(_) => true,
    }
}

fn instance_supports_media(model: &dyn Model) -> bool {
    model
        .model_id()
        .is_none_or(|model_id| !bedrock_family(&model_id).starts_with("openai."))
}

fn spec_supports_media(spec: &str) -> bool {
    let (provider_name, name) = split_provider(spec);
    provider_name != "bedrock" || !bedrock_family(name).starts_with("openai.")
}

/// Whether reasoning can be configured for `model`: `true` for a model
/// instance or router; for a string, whether its provider and model take any reasoning level.
/// `None` is the harness default model.
///
/// ```
/// use strands_harness::supports_thinking;
///
/// assert!(supports_thinking(Some(&"anthropic/claude-haiku-4-5-20251001".into())));
/// assert!(!supports_thinking(Some(&"bedrock/us.anthropic.claude-3-haiku-20240307-v1:0".into())));
/// assert!(supports_thinking(None));
/// ```
#[must_use]
pub fn supports_thinking(model: Option<&ModelSource>) -> bool {
    let spec = match model {
        None => DEFAULT_MODEL,
        Some(ModelSource::Id(spec)) => spec.as_str(),
        Some(_) => return true,
    };
    let (provider_name, name) = split_provider(spec);
    match Provider::parse(provider_name) {
        Some(Provider::Bedrock) => !bedrock_levels(name).is_empty(),
        Some(Provider::Anthropic) => claude_thinking_mode(name).is_some(),
        Some(provider) => !provider.levels().is_empty(),
        None => UNSUPPORTED_PROVIDERS
            .iter()
            .any(|(name, thinks)| *name == provider_name && *thinks),
    }
}

/// Whether native web search can be enabled for `model`: `false` for a
/// model instance or router, whose provider is unknown; `None` is the harness default model.
///
/// ```
/// use strands_harness::supports_web_search;
///
/// assert!(supports_web_search(Some(&"openai/gpt-5.6-sol".into())));
/// assert!(!supports_web_search(Some(&"bedrock/global.anthropic.claude-opus-4-8".into())));
/// assert!(!supports_web_search(None));
/// ```
#[must_use]
pub fn supports_web_search(model: Option<&ModelSource>) -> bool {
    let spec = match model {
        None => DEFAULT_MODEL,
        Some(ModelSource::Id(spec)) => spec.as_str(),
        Some(_) => return false,
    };
    let (provider_name, name) = split_provider(spec);
    Provider::parse(provider_name).is_some_and(|provider| has_web_search(provider, name))
}

#[cfg(test)]
mod tests;
