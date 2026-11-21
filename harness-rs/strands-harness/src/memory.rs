//! File-based memory resolution: a `MemoryManager` over a local `FileMemoryStore`.
//!
//! Memory is on by default. Facts the agent learns are distilled every few turns into markdown
//! files under the memory directory (default `./.agent/memory`), searched and injected before
//! each user turn. Persistence is plain files, independent of any session. Extraction is
//! background and turn-triggered, so call [`Agent::shutdown`](strands::Agent::shutdown) at your
//! shutdown boundary to persist what is pending.
//!
//! A consumer can swap the backend with its own stores; the harness still owns the manager, so
//! its policy (injection on, `search_memory` on, `add_memory` off) applies either way.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use strands::ModelSource;
use strands::async_trait;
use strands::memory::{
    MemoryEntry, MemoryManager, MemoryManagerConfig, MemoryStore, ModelExtractor, ModelExtractorOptions, SearchOptions,
    Toggle,
};
use strands::models::Model;
use strands::storage::LocalFileStorage;
use strands::vended_memory_stores::file_memory_store::{
    FileMemoryExtractionConfig, FileMemoryStore, FileMemoryStoreConfig,
};

use crate::defaults::DEFAULT_MEMORY_DIR;
use crate::env::Env;
use crate::models::resolve_web_fetch_model;

/// Store name, surfaced as the `source` attribute on each injected `<memory>` entry.
const MEMORY_STORE_NAME: &str = "memory";

/// Options for [`resolve_memory`] (`ResolveMemoryOptions`).
#[derive(Clone, Default)]
pub(crate) struct ResolveMemoryOptions {
    /// Stores to manage instead of the default file store; empty builds the default store.
    pub(crate) stores: Vec<Arc<dyn MemoryStore>>,
    /// The agent's `model` option, used to derive the small extraction model.
    pub(crate) model: Option<ModelSource>,
    /// Directory the default store's files live in.
    pub(crate) dir: Option<PathBuf>,
    /// The agent's `builtin_tools.web_fetch.model`, which overrides the extraction model.
    pub(crate) web_fetch_model: Option<ModelSource>,
    /// `false` builds a recall-only manager: the default store is read-only and consumer stores
    /// are wrapped in a read-only view (the shape for a `subagent` delegate).
    pub(crate) read_only: bool,
}

/// Builds the memory manager: the consumer's stores or a default
/// `FileMemoryStore` under the directory, with the SDK's tool defaults (`search_memory` on, no
/// `add_memory`) and injection on each user turn.
pub(crate) fn resolve_memory(options: ResolveMemoryOptions, env: &Env) -> strands::Result<MemoryManager> {
    let stores = if options.stores.is_empty() {
        let (store, _) = default_store(&options, env)?;
        vec![Arc::new(store) as Arc<dyn MemoryStore>]
    } else if options.read_only {
        options.stores.into_iter().map(read_only).collect()
    } else {
        options.stores
    };
    MemoryManager::new(MemoryManagerConfig {
        stores,
        ..Default::default()
    })
}

/// The default file-backed store, writing markdown directly under the directory, and the model
/// its extractor runs on. The storage is pre-namespaced to the directory so the store's own
/// `memory/<name>/` scoping does not double the path.
pub(crate) fn default_store(
    options: &ResolveMemoryOptions,
    env: &Env,
) -> strands::Result<(FileMemoryStore, Option<Arc<dyn Model>>)> {
    let dir = options.dir.as_deref().unwrap_or(Path::new(DEFAULT_MEMORY_DIR));
    let storage = LocalFileStorage::new(dir).namespace("")?;
    let model = if options.read_only {
        None
    } else {
        Some(resolve_web_fetch_model(
            options.model.as_ref(),
            options.web_fetch_model.as_ref(),
            env,
        )?)
    };
    let extraction = model.clone().map(|model| {
        let extractor = ModelExtractor::new(ModelExtractorOptions {
            model: Some(model),
            ..Default::default()
        });
        Toggle::On(FileMemoryExtractionConfig {
            extractor: Some(Arc::new(extractor)),
            ..Default::default()
        })
    });
    let store = FileMemoryStore::new(FileMemoryStoreConfig {
        storage: Some(Arc::new(storage)),
        writable: Some(!options.read_only),
        extraction,
        ..FileMemoryStoreConfig::new(MEMORY_STORE_NAME)
    })?;
    Ok((store, model))
}

/// A recall-only view of a store: the same backend, still searchable, with every write path and
/// its extraction dropped. Store-native tools are dropped too, since such a tool is a surface
/// that cannot be guaranteed read-only.
fn read_only(store: Arc<dyn MemoryStore>) -> Arc<dyn MemoryStore> {
    Arc::new(ReadOnlyStore(store))
}

struct ReadOnlyStore(Arc<dyn MemoryStore>);

#[async_trait]
impl MemoryStore for ReadOnlyStore {
    fn name(&self) -> &str {
        self.0.name()
    }

    fn description(&self) -> Option<&str> {
        self.0.description()
    }

    fn max_search_results(&self) -> Option<usize> {
        self.0.max_search_results()
    }

    fn writable(&self) -> bool {
        false
    }

    async fn search(&self, query: &str, options: SearchOptions) -> strands::Result<Vec<MemoryEntry>> {
        self.0.search(query, options).await
    }

    async fn initialize(&self) -> strands::Result<()> {
        self.0.initialize().await
    }
}

#[cfg(test)]
mod tests;
