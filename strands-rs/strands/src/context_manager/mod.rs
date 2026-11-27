//! Strategy-driven context management.
//!
//! A [`ContextManager`] keeps an agent's conversation within its context window. It runs a
//! pipeline of [`ContextStrategy`]s before each model call and on overflow, offloads content to an
//! [`Archive`] the model can read back with the `retrieve_context` tool, and protects pinned
//! messages. Set it with `AgentConfig::context_manager`:
//!
//! - [`ContextManagerStrategy::Auto`] truncates tool results over 1,500 tokens and summarizes at
//!   85% context utilization;
//! - [`ContextManagerStrategy::Agentic`] lets the model manage its context with the
//!   `summarize_context`, `truncate_context` and `pin_context` tools and shows it its usage;
//! - [`ContextManagerConfig`] builds a custom pipeline from [`Offload`] strategies and
//!   [`StrategyPresetName`] presets.

mod archive;
mod content_rendering;
#[allow(clippy::module_inception, reason = "mirrors context-manager/context-manager.ts")]
mod context_manager;
mod js_text;
mod message_trimming;
mod methods;
pub(crate) mod modes;
mod placeholder;
mod presets;
mod retrieval_tool;
mod search;
mod strategies;
mod types;

pub use archive::Archive;
pub(crate) use context_manager::AgentArchive;
pub use context_manager::{ContextManager, ContextManagerStrategy};
pub use methods::truncate::{PreviewMode, TruncateConfig, TruncateConfigBuilder};
pub use presets::{StrategyEntry, StrategyPresetName};
pub use strategies::deferred_tool_loading::{DeferConditions, DeferConditionsBuilder, DeferStrategy, DeferTarget};
pub use strategies::offload::{
    ConditionValue, DropStrategy, EmergencyTruncateStrategy, Offload, OffloadConditions, OffloadConditionsBuilder,
    OffloadTarget, SummarizeConfig, SummarizeConfigBuilder, SummarizeStrategy, TruncateStrategy,
};
pub use types::{
    ArchiveConfig, ArchiveConfigBuilder, ContextManagerConfig, ContextManagerConfigBuilder, ContextState,
    ContextStrategy,
};

#[cfg(test)]
mod archive_integration_tests;
#[cfg(test)]
mod test_support;
