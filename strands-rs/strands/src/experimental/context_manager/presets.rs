//! Strategy presets: named building blocks that resolve to strategy configurations.
//!
//! The preset name is the stable contract; the strategies it expands to may be retuned between
//! releases. Use [`Offload`] strategies directly for a pinned configuration.

use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use super::methods::truncate::TruncateConfig;
use super::strategies::deferred_tool_loading::{DeferConditions, DeferTarget};
use super::strategies::offload::{ConditionValue, Offload, OffloadConditions, OffloadTarget, SummarizeConfig};
use super::types::ContextStrategy;
use crate::error::{Error, Result};

/// A named strategy preset (`StrategyPresetName`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StrategyPresetName {
    /// Summarizes the oldest 30% of messages at 70% context utilization
    /// (`proactiveSummarization`).
    ProactiveSummarization,
    /// Truncates tool results over 2,500 tokens to a 1,000-token preview (`largeToolOffloading`).
    LargeToolOffloading,
    /// Drops the oldest messages when the context window is full (`overflowProtection`).
    OverflowProtection,
    /// Drops tool results outside the newest five tool-result messages (`staleToolCleanup`).
    StaleToolCleanup,
    /// Experimental: from 20 tools, the SDK's own included, defers tools' input schemas until the
    /// model loads them (`deferredToolLoading`). Claude 4.5 and later defer natively through
    /// `AnthropicModel`, most other models get each deferred tool as a stub (name and
    /// description), and models that can't use stubs (`DeferredToolLoading::Unsupported`) get
    /// every spec. The SDK's own tools and tools without parameters are always sent in full and
    /// every other tool is deferred, so the model loads even its most used tools first;
    /// [`Offload::defer`] keeps the ones you name.
    DeferredToolLoading,
}

/// Every preset, in their canonical order.
pub(crate) const STRATEGY_PRESET_NAMES: [StrategyPresetName; 5] = [
    StrategyPresetName::ProactiveSummarization,
    StrategyPresetName::LargeToolOffloading,
    StrategyPresetName::OverflowProtection,
    StrategyPresetName::StaleToolCleanup,
    StrategyPresetName::DeferredToolLoading,
];

impl StrategyPresetName {
    /// The preset's config name, such as `largeToolOffloading`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProactiveSummarization => "proactiveSummarization",
            Self::LargeToolOffloading => "largeToolOffloading",
            Self::OverflowProtection => "overflowProtection",
            Self::StaleToolCleanup => "staleToolCleanup",
            Self::DeferredToolLoading => "deferredToolLoading",
        }
    }
}

impl fmt::Display for StrategyPresetName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for StrategyPresetName {
    type Err = Error;

    fn from_str(name: &str) -> Result<Self> {
        STRATEGY_PRESET_NAMES
            .into_iter()
            .find(|preset| preset.as_str() == name)
            .ok_or_else(|| {
                let valid: Vec<&str> = STRATEGY_PRESET_NAMES.iter().map(|preset| preset.as_str()).collect();
                Error::other(format!(
                    "Unknown strategy preset: \"{name}\". Valid presets: {}",
                    valid.join(", ")
                ))
            })
    }
}

/// A strategy or a preset name in [`ContextManagerConfig::strategies`](super::ContextManagerConfig).
#[derive(Clone)]
#[non_exhaustive]
pub enum StrategyEntry {
    /// A strategy, used as is.
    Strategy(Arc<dyn ContextStrategy>),
    /// A preset, expanded to its strategies.
    Preset(StrategyPresetName),
}

impl fmt::Debug for StrategyEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Strategy(strategy) => f.debug_tuple("Strategy").field(&strategy.name()).finish(),
            Self::Preset(preset) => f.debug_tuple("Preset").field(preset).finish(),
        }
    }
}

impl From<StrategyPresetName> for StrategyEntry {
    fn from(preset: StrategyPresetName) -> Self {
        Self::Preset(preset)
    }
}

impl From<Arc<dyn ContextStrategy>> for StrategyEntry {
    fn from(strategy: Arc<dyn ContextStrategy>) -> Self {
        Self::Strategy(strategy)
    }
}

impl<S: ContextStrategy> From<S> for StrategyEntry {
    fn from(strategy: S) -> Self {
        Self::Strategy(Arc::new(strategy))
    }
}

fn conditions(
    context_utilization: Option<&str>,
    block_threshold: Option<u64>,
    preserve_recent: Option<ConditionValue>,
) -> OffloadConditions {
    OffloadConditions {
        context_utilization: context_utilization.map(ConditionValue::from),
        block_threshold: block_threshold.map(ConditionValue::from),
        preserve_recent,
    }
}

fn preview(tokens: f64) -> TruncateConfig {
    TruncateConfig {
        preview_tokens: Some(tokens),
        ..TruncateConfig::default()
    }
}

/// The strategies a preset stands for. Defaults are tuning decisions, not API promises.
pub(crate) fn resolve_preset(name: StrategyPresetName) -> Result<Vec<Arc<dyn ContextStrategy>>> {
    let strategy: Arc<dyn ContextStrategy> = match name {
        StrategyPresetName::ProactiveSummarization => Arc::new(
            Offload::summarize(OffloadTarget::All, SummarizeConfig::default())?.when(conditions(
                Some("70%"),
                None,
                Some("70%".into()),
            ))?,
        ),
        StrategyPresetName::LargeToolOffloading => Arc::new(
            Offload::truncate(OffloadTarget::ToolResults, preview(1000.0))?.when(conditions(None, Some(2500), None))?,
        ),
        StrategyPresetName::OverflowProtection => {
            Arc::new(Offload::drop(OffloadTarget::All)?.when(conditions(Some("100%"), None, Some(4.into())))?)
        }
        StrategyPresetName::StaleToolCleanup => {
            Arc::new(Offload::drop(OffloadTarget::ToolResults)?.when(conditions(None, None, Some(5.into())))?)
        }
        StrategyPresetName::DeferredToolLoading => {
            Arc::new(Offload::defer(DeferTarget::ToolSpecs)?.when(DeferConditions {
                tool_count: Some(20.into()),
                ..DeferConditions::default()
            })?)
        }
    };
    Ok(vec![strategy])
}

/// Expands presets in a mixed list of strategies and presets, keeping the order.
pub(crate) fn resolve_strategies(entries: &[StrategyEntry]) -> Result<Vec<Arc<dyn ContextStrategy>>> {
    let mut strategies = Vec::new();
    for entry in entries {
        match entry {
            StrategyEntry::Strategy(strategy) => strategies.push(strategy.clone()),
            StrategyEntry::Preset(preset) => strategies.extend(resolve_preset(*preset)?),
        }
    }
    Ok(strategies)
}

#[cfg(test)]
#[path = "presets/tests.rs"]
mod tests;
