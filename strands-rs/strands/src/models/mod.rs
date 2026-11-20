//! Model abstractions: the [`Model`] trait, its request and result types,
//! stream events and what the SDK knows about models ([`ModelInfo`]).

#[cfg(feature = "anthropic")]
pub mod anthropic;
#[cfg(feature = "bedrock")]
pub mod bedrock;
#[cfg(feature = "bedrock")]
mod bedrock_cache;
pub(crate) mod defaults;
#[cfg(any(feature = "anthropic", feature = "openai"))]
pub(crate) mod http;
mod model;
pub(crate) mod model_info;
pub(crate) mod model_proxy;
pub(crate) mod native_output;
#[cfg(feature = "openai")]
pub mod openai;
pub mod routing;
pub mod streaming;
pub(crate) mod strict_schema;
mod summarize;
pub(crate) mod thinking_binding;

#[cfg(all(feature = "anthropic", feature = "bedrock"))]
pub use anthropic::AnthropicBedrockConfig;
#[cfg(feature = "anthropic")]
pub use anthropic::{AnthropicClientConfig, AnthropicModel, AnthropicModelConfig, AnthropicModelOptions};
#[cfg(feature = "bedrock")]
pub use bedrock::{BedrockModel, BedrockModelConfig, BedrockModelOptions};
pub use model::{
    AggregatedEvent, BaseModelConfig, BoxStream, CacheConfig, CacheKey, CacheSectionSetting, CacheStrategy, CacheTtl,
    CountTokensOptions, Model, ModelRequest, Redaction, StreamAggregatedResult, SummarizeOptions, base_model_info,
    estimate_tokens,
};
#[allow(unused_imports, reason = "providers use these crate-internal helpers")]
pub(crate) use model::{
    ResolvedCacheSection, is_js_whitespace, latest_user_index, resolve_cache_section, resolve_config_metadata,
    resolve_max_tokens,
};
pub use model_info::{ModelCapabilities, ModelInfo, ModelLimits, PromptCaching};
#[cfg(feature = "mantle")]
pub use openai::BedrockMantleConfig;
#[cfg(feature = "openai")]
pub use openai::{OpenAIApi, OpenAIClientConfig, OpenAIModel, OpenAIModelConfig, OpenAIModelOptions};
pub use summarize::{SummarizeResult, summarize_client_side};
