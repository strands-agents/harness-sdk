//! Cross-session memory: the [`MemoryManager`] plugin, the [`MemoryStore`] trait backends
//! implement, and [`extraction`] of memories from the conversation.
//!
//! Ready-made stores are in [`vended_memory_stores`](crate::vended_memory_stores).

use std::sync::Arc;

pub mod extraction;
mod memory_manager;
mod types;

#[cfg(test)]
mod tests;

pub use crate::injection::{InjectionConfig, InjectionConfigBuilder, InjectionContext, InjectionTrigger};
/// The memory options' on/off type, shared with the rest of the SDK.
pub use crate::types::Toggle;
pub use extraction::{
    ExtractionConfig, ExtractionConfigBuilder, ExtractionFire, ExtractionResult, ExtractionTrigger,
    ExtractionTriggerContext, Extractor, ExtractorContext, IntervalTrigger, IntervalTriggerOptions,
    IntervalTriggerOptionsBuilder, InvocationTrigger, MemoryContentBlockType, MemoryMessageFilter, ModelExtractor,
    ModelExtractorOptions, ModelExtractorOptionsBuilder,
};
pub use memory_manager::MemoryManager;
pub use types::{
    AddMessagesContext, AggregateError, MemoryAddOptions, MemoryAddOptionsBuilder, MemoryAddToolConfig,
    MemoryAddToolConfigBuilder, MemoryEntry, MemoryFormat, MemoryInjectionConfig, MemoryInjectionConfigBuilder,
    MemoryManagerConfig, MemoryManagerConfigBuilder, MemoryQuery, MemorySearchOptions, MemorySearchOptionsBuilder,
    MemoryStore, MemoryToolConfig, MemoryToolConfigBuilder, SearchOptions, SearchOptionsBuilder,
};

/// The memory manager an agent uses: an instance, or a config the agent builds one from.
#[derive(Clone)]
#[non_exhaustive]
pub enum MemoryManagerSource {
    /// A manager handle, kept as is.
    Manager(MemoryManager),
    /// A configuration; the agent creates the manager.
    Config(Box<MemoryManagerConfig>),
}

impl MemoryManagerSource {
    pub(crate) fn resolve(self) -> crate::Result<MemoryManager> {
        match self {
            Self::Manager(manager) => Ok(manager),
            Self::Config(config) => MemoryManager::new(*config),
        }
    }

    /// The manager, for agents assembled without a fallible step; a config that fails to build
    /// is logged and dropped. `Agent::new` resolves configs first and returns the error.
    pub(crate) fn into_manager(self) -> Option<MemoryManager> {
        self.resolve()
            .inspect_err(|error| tracing::error!("error=<{error}> | memory manager config is invalid"))
            .ok()
    }
}

impl From<MemoryManager> for MemoryManagerSource {
    fn from(manager: MemoryManager) -> Self {
        Self::Manager(manager)
    }
}

/// The handle the `Arc` holds; both share one manager.
impl From<Arc<MemoryManager>> for MemoryManagerSource {
    fn from(manager: Arc<MemoryManager>) -> Self {
        Self::Manager(MemoryManager::clone(&manager))
    }
}

impl From<MemoryManagerConfig> for MemoryManagerSource {
    fn from(config: MemoryManagerConfig) -> Self {
        Self::Config(Box::new(config))
    }
}

impl std::fmt::Debug for MemoryManagerSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Manager(manager) => f.debug_tuple("Manager").field(manager).finish(),
            Self::Config(config) => f.debug_tuple("Config").field(config).finish(),
        }
    }
}
