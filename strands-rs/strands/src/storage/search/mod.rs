//! Pluggable search strategies for storage backends.
//!
//! A [`SearchStrategy`] is one way of searching stored content: a keyword scan, a full-text
//! index, vector similarity. Backends delegate their [`Storage::search`] to a strategy, and
//! consumers such as memory stores can override it. [`KeywordSearchStrategy`] is the default for
//! every shipped backend.

use async_trait::async_trait;

use super::Storage;
use crate::error::Result;

pub(crate) mod keyword;

pub use keyword::KeywordSearchStrategy;

/// A single result from a search (`StorageSearchResult`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct StorageSearchResult {
    /// Storage key of the matched item.
    pub key: String,
    /// Relevance score; higher is more relevant. Distance-based backends invert distances to
    /// similarities before returning them.
    pub score: f64,
    /// The stored bytes, when the backend returns them.
    pub data: Option<Vec<u8>>,
}

impl StorageSearchResult {
    /// A result without data.
    pub fn new(key: impl Into<String>, score: f64) -> Self {
        Self {
            key: key.into(),
            score,
            data: None,
        }
    }

    /// Sets the stored bytes.
    #[must_use]
    pub fn with_data(mut self, data: Vec<u8>) -> Self {
        self.data = Some(data);
        self
    }
}

/// A pluggable way to search a storage backend (`SearchStrategy`).
///
/// Backends configured with a strategy call [`index`](SearchStrategy::index) on every write and
/// delegate [`Storage::search`] to [`search`](SearchStrategy::search).
///
/// ```
/// use strands::storage::search::{SearchStrategy, StorageSearchResult};
/// use strands::storage::{InMemoryStorage, InMemoryStorageConfig, Storage};
/// use std::sync::Arc;
///
/// struct PrefixMatch;
///
/// #[strands::async_trait]
/// impl SearchStrategy for PrefixMatch {
///     async fn search(&self, storage: &dyn Storage, query: &str) -> strands::Result<Vec<StorageSearchResult>> {
///         let keys = storage.list(query).await?;
///         Ok(keys.into_iter().map(|key| StorageSearchResult::new(key, 1.0)).collect())
///     }
/// }
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> strands::Result<()> {
/// let config = InMemoryStorageConfig::builder().search_strategy(Arc::new(PrefixMatch)).build();
/// let storage = InMemoryStorage::with_config(config);
/// storage.write("notes/a.md", b"x").await?;
/// assert_eq!(storage.search("notes/").await?[0].key, "notes/a.md");
/// # Ok(())
/// # }
/// ```
#[async_trait]
pub trait SearchStrategy: Send + Sync + 'static {
    /// Indexes one entry for later searches; called on each write. Strategies that search on the
    /// fly (keyword) or manage their own index keep the default no-op.
    ///
    /// `key` is relative to `storage`. Namespaced instances of a backend share its strategy and
    /// pass keys relative to their own prefix, so two entries can arrive with the same key and
    /// one entry can arrive under different keys. A strategy that keeps its own index should key
    /// it by where the entry lives (such as [`LocalFileStorage::base_dir`](super::LocalFileStorage::base_dir)
    /// plus the key), or use a separate storage per index.
    ///
    /// # Errors
    ///
    /// An error fails the write that triggered it.
    async fn index(&self, _storage: &dyn Storage, _key: &str, _data: &[u8]) -> Result<()> {
        Ok(())
    }

    /// Whether the strategy reads or writes the host filesystem itself, so it
    /// cannot work on storage routed through a sandbox. `false` by default.
    fn requires_host_fs(&self) -> bool {
        false
    }

    /// The strategy's name for error messages.
    fn name(&self) -> &str {
        "SearchStrategy"
    }

    /// Searches `storage` for `query`, best match first.
    ///
    /// # Errors
    ///
    /// Returns an error when the search fails.
    async fn search(&self, storage: &dyn Storage, query: &str) -> Result<Vec<StorageSearchResult>>;
}
