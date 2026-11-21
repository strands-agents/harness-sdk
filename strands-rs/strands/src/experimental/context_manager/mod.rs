//! Strategy-driven context management (experimental).
//!
//! A [`ContextManager`] keeps an agent's conversation within its context window. It runs a
//! pipeline of [`ContextStrategy`]s before each model call and on overflow, offloads content to a
//! [`Stash`] the model can read back with the `retrieve_context` tool, and protects pinned
//! messages. Set it with `AgentConfig::context_manager`:
//!
//! - [`ContextManagerStrategy::Auto`] truncates tool results over 1,500 tokens and summarizes at
//!   85% context utilization;
//! - [`ContextManagerStrategy::Agentic`] lets the model manage its context with the
//!   `summarize_context`, `truncate_context` and `pin_context` tools and shows it its usage;
//! - [`ContextManagerConfig`] builds a custom pipeline from [`Offload`] strategies and
//!   [`StrategyPresetName`] presets.
//!
//! This module may change in a minor release.

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
mod stash;
mod strategies;
mod types;

pub(crate) use context_manager::AgentStash;
pub use context_manager::{ContextManager, ContextManagerStrategy};
pub use methods::truncate::{PreviewMode, TruncateConfig, TruncateConfigBuilder};
pub use presets::{StrategyEntry, StrategyPresetName};
pub use stash::Stash;
pub use strategies::offload::{
    ConditionValue, DropStrategy, EmergencyTruncateStrategy, Offload, OffloadConditions, OffloadConditionsBuilder,
    OffloadTarget, SummarizeConfig, SummarizeConfigBuilder, SummarizeStrategy, TruncateStrategy,
};
pub use types::{
    ContextManagerConfig, ContextManagerConfigBuilder, ContextState, ContextStrategy, StashConfig, StashConfigBuilder,
};

#[cfg(test)]
mod stash_integration_tests;
#[cfg(test)]
mod test_support;
