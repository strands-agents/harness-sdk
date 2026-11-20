//! Strategy presets: named building blocks that resolve to strategy configurations.
//!
//! The preset name is the stable contract; the strategies it expands to may be retuned between
//! releases. Use [`Offload`] strategies directly for a pinned configuration.

use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use super::methods::truncate::TruncateConfig;
use super::strategies::offload::{Offload, OffloadConditions, OffloadTarget, SummarizeConfig};
use super::types::ContextStrategy;
use crate::error::{Error, Result};

/// A named strategy preset (`StrategyPresetName`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StrategyPresetName {
    /// Summarizes the oldest 30% of messages at 70% utilization (`proactiveSummarization`).
    ProactiveSummarization,
    /// Truncates tool results over 2,500 tokens to a 1,000-token preview (`largeToolOffloading`).
    LargeToolOffloading,
    /// Truncates the oldest messages when the context window is full (`overflowProtection`).
    OverflowProtection,
    /// Drops tool results older than the last five matching messages (`staleToolCleanup`).
    StaleToolCleanup,
}

/// Every preset, in their canonical order.
pub(crate) const STRATEGY_PRESET_NAMES: [StrategyPresetName; 4] = [
    StrategyPresetName::ProactiveSummarization,
    StrategyPresetName::LargeToolOffloading,
    StrategyPresetName::OverflowProtection,
    StrategyPresetName::StaleToolCleanup,
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

fn conditions(threshold: Option<f64>, utilization: Option<f64>, preserve_recent: Option<f64>) -> OffloadConditions {
    OffloadConditions {
        threshold,
        utilization,
        preserve_recent,
    }
}

fn preview(tokens: f64) -> TruncateConfig {
    TruncateConfig {
        preview_tokens: Some(tokens),
        ..TruncateConfig::default()
    }
}

/// The strategies a preset stands for.
pub(crate) fn resolve_preset(name: StrategyPresetName) -> Result<Vec<Arc<dyn ContextStrategy>>> {
    let strategy: Arc<dyn ContextStrategy> = match name {
        StrategyPresetName::ProactiveSummarization => Arc::new(
            Offload::summarize(OffloadTarget::All, SummarizeConfig::default())?.when(conditions(
                None,
                Some(0.7),
                Some(0.7),
            )),
        ),
        StrategyPresetName::LargeToolOffloading => Arc::new(
            Offload::truncate(OffloadTarget::ToolResults, preview(1000.0))?.when(conditions(
                Some(2500.0),
                None,
                None,
            ))?,
        ),
        StrategyPresetName::OverflowProtection => Arc::new(
            Offload::truncate(OffloadTarget::All, TruncateConfig::default())?.when(conditions(
                None,
                Some(1.0),
                Some(4.0),
            ))?,
        ),
        StrategyPresetName::StaleToolCleanup => {
            Arc::new(Offload::drop(OffloadTarget::ToolResults)?.when(conditions(None, None, Some(5.0))))
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
