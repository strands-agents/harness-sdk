//! Offload strategies: reduce content in the context window by dropping it, truncating it to a
//! preview or summarizing it.

mod base;
mod drop;
mod summarize;
mod truncate;

pub use base::{EmergencyTruncateStrategy, OffloadConditions, OffloadConditionsBuilder, OffloadTarget};
pub use drop::DropStrategy;
pub use summarize::{SummarizeConfig, SummarizeConfigBuilder, SummarizeStrategy};
pub use truncate::TruncateStrategy;

use crate::error::Result;
use crate::experimental::context_manager::methods::truncate::TruncateConfig;

/// Builds the offload strategies (`Offload`). Chain [`when`](DropStrategy::when) to set the
/// conditions they fire under.
///
/// ```
/// use strands::experimental::context_manager::{
///     Offload, OffloadConditions, OffloadTarget, SummarizeConfig, TruncateConfig,
/// };
///
/// // Truncate each tool result over 1,500 tokens to a 750-token preview, eagerly.
/// let truncate = Offload::truncate(
///     OffloadTarget::ToolResults,
///     TruncateConfig { preview_tokens: Some(750.0), ..Default::default() },
/// )?
/// .when(OffloadConditions { threshold: Some(1500.0), ..Default::default() })?;
/// // Summarize the oldest messages at 85% utilization, keeping the last four.
/// let summarize = Offload::summarize(OffloadTarget::All, SummarizeConfig::default())?.when(OffloadConditions {
///     utilization: Some(0.85),
///     preserve_recent: Some(4.0),
///     ..Default::default()
/// });
/// # let _ = (truncate, summarize);
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct Offload;

impl Offload {
    /// Drops matching content from the context window entirely (`Offload.drop`).
    ///
    /// # Errors
    ///
    /// An empty [`OffloadTarget::Tools`] list.
    pub fn drop(target: OffloadTarget) -> Result<DropStrategy> {
        DropStrategy::new(target, OffloadConditions::default())
    }

    /// Replaces oversized content with a preview (`Offload.truncate`).
    ///
    /// # Errors
    ///
    /// An empty [`OffloadTarget::Tools`] list.
    pub fn truncate(target: OffloadTarget, config: TruncateConfig) -> Result<TruncateStrategy> {
        TruncateStrategy::new(target, config, OffloadConditions::default())
    }

    /// Replaces oversized content with a model-written summary (`Offload.summarize`).
    ///
    /// # Errors
    ///
    /// An empty [`OffloadTarget::Tools`] list.
    pub fn summarize(target: OffloadTarget, config: SummarizeConfig) -> Result<SummarizeStrategy> {
        SummarizeStrategy::new(target, config, OffloadConditions::default())
    }
}
