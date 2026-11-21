//! Offload strategies: reduce content in the context window by dropping it, truncating it to a
//! preview or summarizing it.

mod base;
pub(crate) mod conditions;
mod drop;
mod summarize;
pub(crate) mod target;
mod truncate;

pub use base::EmergencyTruncateStrategy;
pub use conditions::{ConditionValue, OffloadConditions, OffloadConditionsBuilder};
pub use drop::DropStrategy;
pub use summarize::{SummarizeConfig, SummarizeConfigBuilder, SummarizeStrategy};
pub use target::OffloadTarget;
pub use truncate::TruncateStrategy;

use super::deferred_tool_loading::{DeferConditions, DeferStrategy, DeferTarget};
use crate::context_manager::methods::truncate::TruncateConfig;
use crate::error::Result;

/// Builds the offload strategies (`Offload`). Each returns a strategy; chain `when` to set when and
/// on what it acts.
///
/// Target [`OffloadTarget::All`] acts on whole messages; any other target acts on each block.
/// `block_threshold` measures whichever the target acts on, and `context_utilization` only gates
/// when the strategy fires. Targets `All` and `Media` need conditions from `when`; any other target
/// without them acts on each matching block as it arrives, before the model reads it.
///
/// ```
/// use strands::context_manager::{
///     Offload, OffloadConditions, OffloadTarget, SummarizeConfig, TruncateConfig,
/// };
///
/// // Per block, eagerly: truncate each tool result over 1,500 tokens to a 750-token preview.
/// let truncate = Offload::truncate(
///     OffloadTarget::ToolResults,
///     TruncateConfig { preview_tokens: Some(750.0), ..Default::default() },
/// )?
/// .when(OffloadConditions { block_threshold: Some(1500.into()), ..Default::default() })?;
/// // Whole messages: summarize the oldest at 70% context utilization, keeping the newest four.
/// let summarize = Offload::summarize(OffloadTarget::All, SummarizeConfig::default())?.when(OffloadConditions {
///     context_utilization: Some("70%".into()),
///     preserve_recent: Some(4.into()),
///     ..Default::default()
/// })?;
/// // Whole messages: once the window is full, drop the oldest, keeping the newest 70%.
/// let drop = Offload::drop(OffloadTarget::All)?.when(OffloadConditions {
///     context_utilization: Some("100%".into()),
///     preserve_recent: Some("70%".into()),
///     ..Default::default()
/// })?;
/// # let _ = (truncate, summarize, drop);
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct Offload;

impl Offload {
    /// Drops matching content from the context window entirely (`Offload.drop`). Without `when`
    /// conditions, drops each block on arrival.
    ///
    /// # Errors
    ///
    /// A tool list target that is empty or excludes every tool it includes.
    pub fn drop(target: OffloadTarget) -> Result<DropStrategy> {
        DropStrategy::new(target, None)
    }

    /// Replaces oversized content with a preview (`Offload.truncate`). Without `when` conditions,
    /// truncates each block on arrival.
    ///
    /// # Errors
    ///
    /// A tool list target that is empty or excludes every tool it includes.
    pub fn truncate(target: OffloadTarget, config: TruncateConfig) -> Result<TruncateStrategy> {
        TruncateStrategy::new(target, config, None)
    }

    /// Replaces content with a model-written summary (`Offload.summarize`). Without `when`
    /// conditions, summarizes each block on arrival.
    ///
    /// # Errors
    ///
    /// A tool list target that is empty or excludes every tool it includes.
    pub fn summarize(target: OffloadTarget, config: SummarizeConfig) -> Result<SummarizeStrategy> {
        SummarizeStrategy::new(target, config, None)
    }

    /// Keeps tools' input schemas out of the context until the model loads them with
    /// `load_tools` (`Offload.defer`). The model still sees each deferred tool's name and
    /// description. Without [`when`](DeferStrategy::when) conditions, defers at any tool count;
    /// either of its conditions is enough. One per context manager, the `deferredToolLoading`
    /// preset included.
    ///
    /// # Errors
    ///
    /// A [`DeferTarget::Tools`] list that is empty, lists `toolSpecs`, or excludes every tool it
    /// includes.
    pub fn defer(target: DeferTarget) -> Result<DeferStrategy> {
        DeferStrategy::new(target, DeferConditions::default())
    }
}
