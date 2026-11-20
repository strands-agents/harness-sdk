//! Extraction config defaults.

use std::sync::Arc;

use super::{
    ExtractionConfig, ExtractionTrigger, Extractor, IntervalTrigger, IntervalTriggerOptions, MemoryMessageFilter,
    ModelExtractor,
};
use crate::memory::MemoryStore;

/// The default cadence when a config has no trigger: every N turns.
pub(crate) const DEFAULT_EXTRACTION_TRIGGER_TURNS: u64 = 5;

/// An [`ExtractionConfig`] with every default applied (`ResolvedExtractionConfig`).
#[derive(Clone)]
pub(crate) struct ResolvedExtractionConfig {
    /// Never empty for a config the manager accepts.
    pub(crate) triggers: Vec<Arc<dyn ExtractionTrigger>>,
    /// `None` writes the raw messages through `add_messages`.
    pub(crate) extractor: Option<Arc<dyn Extractor>>,
    pub(crate) filter: MemoryMessageFilter,
}

/// Applies the defaults to a store's extraction config; `None` is
/// off. A store implementing `add_messages` gets no extractor, one implementing only `add` gets a
/// [`ModelExtractor`].
pub(crate) fn resolve_extraction_config(
    extraction: Option<ExtractionConfig>,
    store: &dyn MemoryStore,
) -> Option<ResolvedExtractionConfig> {
    let config = extraction?;
    let triggers = config.trigger.unwrap_or_else(|| {
        let interval = IntervalTrigger::new(IntervalTriggerOptions {
            turns: DEFAULT_EXTRACTION_TRIGGER_TURNS,
        });
        interval
            .map(|trigger| Arc::new(trigger) as Arc<dyn ExtractionTrigger>)
            .into_iter()
            .collect()
    });
    let extractor = config.extractor.or_else(|| {
        (store.implements_add() && !store.implements_add_messages())
            .then(|| Arc::new(ModelExtractor::default()) as Arc<dyn Extractor>)
    });
    Some(ResolvedExtractionConfig {
        triggers,
        extractor,
        filter: config.filter.unwrap_or_default(),
    })
}
