//! In-memory storage.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use async_trait::async_trait;

use super::search::{KeywordSearchStrategy, SearchStrategy, StorageSearchResult};
use super::{Storage, normalize_key, normalize_prefix, sort_keys};
use crate::error::Result;

type Entries = HashMap<String, Vec<u8>>;

/// Options for [`InMemoryStorage`] (`InMemoryStorageConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct InMemoryStorageConfig {
    /// Search strategy. When set, writes are indexed and [`InMemoryStorage::search`] delegates to
    /// it instead of the default keyword scan.
    pub search_strategy: Option<Arc<dyn SearchStrategy>>,
}

impl fmt::Debug for InMemoryStorageConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InMemoryStorageConfig")
            .field("search_strategy", &self.search_strategy.is_some())
            .finish()
    }
}

/// [`Storage`] backed by a map in memory (`InMemoryStorage`).
///
/// For tests and for environments without disk access. Content does not survive the process
/// ([`Storage::is_ephemeral`] is `true`); use [`LocalFileStorage`](super::LocalFileStorage) to
/// persist. The store is unbounded, with no eviction. Keys follow the shipped backends' rules:
/// slash runs collapse, leading and trailing slashes are stripped and `..` segments are rejected.
///
/// ```
/// use strands::storage::{InMemoryStorage, Storage};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> strands::Result<()> {
/// let storage = InMemoryStorage::new();
/// let agent = storage.namespace("memory/agent")?;
/// agent.write("notes.md", b"dark mode").await?;
/// assert_eq!(storage.list("").await?, ["memory/agent/notes.md"]);
/// assert_eq!(agent.search("dark").await?[0].key, "notes.md");
/// # Ok(())
/// # }
/// ```
pub struct InMemoryStorage {
    /// Shared with every instance [`namespace`](Self::namespace) returns; each sees only the keys
    /// under its own prefix.
    entries: Arc<RwLock<Entries>>,
    prefix: String,
    namespaced: bool,
    search_strategy: Option<Arc<dyn SearchStrategy>>,
}

impl InMemoryStorage {
    /// An empty store using the default keyword search.
    pub fn new() -> Self {
        Self::with_config(InMemoryStorageConfig::default())
    }

    /// An empty store with options.
    pub fn with_config(config: InMemoryStorageConfig) -> Self {
        Self {
            entries: Arc::default(),
            prefix: String::new(),
            namespaced: false,
            search_strategy: config.search_strategy,
        }
    }

    /// A store scoped to `prefix` that shares this store's entries and search strategy.
    ///
    /// Unlike a [`NamespacedStorage`](super::NamespacedStorage) view, the scoped store's search
    /// sees only the entries under the prefix and scores their keys without it, so a query does
    /// not match every entry because it contains a word of the prefix. The shared strategy
    /// receives the scoped store and keys relative to the prefix.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`](crate::StorageError) when the prefix contains a backslash or a
    /// `..` segment.
    pub fn namespace(&self, prefix: &str) -> Result<Self> {
        let normalized = normalize_prefix(prefix)?;
        let normalized = normalized.strip_suffix('/').unwrap_or(&normalized);
        let prefix = if normalized.is_empty() {
            self.prefix.clone()
        } else {
            format!("{}{normalized}/", self.prefix)
        };
        Ok(Self {
            entries: Arc::clone(&self.entries),
            prefix,
            namespaced: true,
            search_strategy: self.search_strategy.clone(),
        })
    }

    /// Searches the entries this store sees, with its strategy or the default keyword scan.
    ///
    /// # Errors
    ///
    /// Returns the strategy's error.
    pub async fn search(&self, query: &str) -> Result<Vec<StorageSearchResult>> {
        match &self.search_strategy {
            Some(strategy) => strategy.search(self, query).await,
            None => KeywordSearchStrategy.search(self, query).await,
        }
    }

    /// Removes every entry this store sees: those under its namespace, or all of them when it is
    /// not namespaced.
    pub fn clear(&self) {
        let mut entries = self.write_entries();
        if self.prefix.is_empty() {
            entries.clear();
            return;
        }
        entries.retain(|key, _| !key.starts_with(&self.prefix));
    }

    fn read_entries(&self) -> RwLockReadGuard<'_, Entries> {
        self.entries.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write_entries(&self) -> RwLockWriteGuard<'_, Entries> {
        self.entries.write().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for InMemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for InMemoryStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InMemoryStorage")
            .field("prefix", &self.prefix)
            .field("search_strategy", &self.search_strategy.is_some())
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl Storage for InMemoryStorage {
    async fn write(&self, key: &str, data: &[u8]) -> Result<()> {
        let normalized = normalize_key(key)?;
        self.write_entries()
            .insert(format!("{}{normalized}", self.prefix), data.to_vec());
        if let Some(strategy) = &self.search_strategy {
            strategy.index(self, &normalized, data).await?;
        }
        Ok(())
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let full_key = format!("{}{}", self.prefix, normalize_key(key)?);
        Ok(self.read_entries().get(&full_key).cloned())
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let full_key = format!("{}{}", self.prefix, normalize_key(key)?);
        self.write_entries().remove(&full_key);
        Ok(())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let full_prefix = format!("{}{}", self.prefix, normalize_prefix(prefix)?);
        let mut keys: Vec<String> = self
            .read_entries()
            .keys()
            .filter(|key| key.starts_with(&full_prefix))
            .map(|key| key[self.prefix.len()..].to_owned())
            .collect();
        sort_keys(&mut keys);
        Ok(keys)
    }

    fn namespace(&self, prefix: &str) -> Option<Result<Arc<dyn Storage>>> {
        Some(Self::namespace(self, prefix).map(|scoped| Arc::new(scoped) as Arc<dyn Storage>))
    }

    async fn search(&self, query: &str) -> Option<Result<Vec<StorageSearchResult>>> {
        Some(Self::search(self, query).await)
    }

    fn storage_type(&self) -> &str {
        "InMemoryStorage"
    }

    fn is_ephemeral(&self) -> bool {
        true
    }

    fn is_namespaced(&self) -> bool {
        self.namespaced
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn text(bytes: Option<Vec<u8>>) -> String {
        String::from_utf8(bytes.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn stores_data_under_the_given_key() {
        let storage = InMemoryStorage::new();
        storage.write("test/key", b"hello").await.unwrap();
        assert_eq!(storage.read("test/key").await.unwrap(), Some(b"hello".to_vec()));
    }

    #[tokio::test]
    async fn overwrites_existing_data() {
        let storage = InMemoryStorage::new();
        storage.write("key", b"first").await.unwrap();
        storage.write("key", b"second").await.unwrap();
        assert_eq!(text(storage.read("key").await.unwrap()), "second");
    }

    #[tokio::test]
    async fn copies_bytes_on_write_to_prevent_aliasing() {
        let storage = InMemoryStorage::new();
        let mut data = vec![1, 2, 3];
        storage.write("key", &data).await.unwrap();
        data[0] = 99;
        assert_eq!(storage.read("key").await.unwrap().unwrap()[0], 1);
    }

    #[tokio::test]
    async fn returns_null_for_missing_keys() {
        let storage = InMemoryStorage::new();
        assert_eq!(storage.read("nonexistent").await.unwrap(), None);
    }

    #[tokio::test]
    async fn copies_bytes_on_read_to_prevent_aliasing() {
        let storage = InMemoryStorage::new();
        storage.write("key", &[1, 2, 3]).await.unwrap();
        let mut first = storage.read("key").await.unwrap().unwrap();
        first[0] = 99;
        assert_eq!(storage.read("key").await.unwrap().unwrap()[0], 1);
    }

    #[tokio::test]
    async fn removes_an_existing_key() {
        let storage = InMemoryStorage::new();
        storage.write("key", &[1]).await.unwrap();
        storage.delete("key").await.unwrap();
        assert_eq!(storage.read("key").await.unwrap(), None);
    }

    #[tokio::test]
    async fn is_a_no_op_for_missing_keys() {
        let storage = InMemoryStorage::new();
        storage.delete("nonexistent").await.unwrap();
    }

    #[tokio::test]
    async fn returns_keys_matching_a_prefix() {
        let storage = InMemoryStorage::new();
        storage.write("sessions/a/data", &[1]).await.unwrap();
        storage.write("sessions/b/data", &[2]).await.unwrap();
        storage.write("memory/notes", &[3]).await.unwrap();
        assert_eq!(
            storage.list("sessions/").await.unwrap(),
            ["sessions/a/data", "sessions/b/data"]
        );
    }

    #[tokio::test]
    async fn returns_all_keys_when_prefix_is_empty() {
        let storage = InMemoryStorage::new();
        storage.write("a", &[1]).await.unwrap();
        storage.write("b", &[2]).await.unwrap();
        assert_eq!(storage.list("").await.unwrap(), ["a", "b"]);
    }

    #[tokio::test]
    async fn returns_keys_sorted_lexicographically() {
        let storage = InMemoryStorage::new();
        for key in ["c", "a", "b"] {
            storage.write(key, &[1]).await.unwrap();
        }
        assert_eq!(storage.list("").await.unwrap(), ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn returns_empty_array_when_no_keys_match() {
        let storage = InMemoryStorage::new();
        storage.write("other/key", &[1]).await.unwrap();
        assert!(storage.list("sessions/").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn removes_all_entries() {
        let storage = InMemoryStorage::new();
        storage.write("a", &[1]).await.unwrap();
        storage.write("b", &[2]).await.unwrap();
        storage.clear();
        assert!(storage.list("").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn normalizes_slashes_so_equivalent_keys_resolve_to_the_same_entry() {
        let storage = InMemoryStorage::new();
        storage.write("/a//b/", &[1]).await.unwrap();
        assert_eq!(storage.read("a/b").await.unwrap(), Some(vec![1]));
    }

    #[tokio::test]
    async fn rejects_empty_keys() {
        let storage = InMemoryStorage::new();
        let error = storage.write("", &[1]).await.unwrap_err();
        assert_eq!(error.name(), "StorageError");
    }

    #[tokio::test]
    async fn rejects_keys_with_dot_dot_segments() {
        let storage = InMemoryStorage::new();
        let error = storage.write("a/../b", &[1]).await.unwrap_err();
        assert_eq!(error.name(), "StorageError");
    }

    #[tokio::test]
    async fn rejects_prefixes_with_dot_dot_segments() {
        let storage = InMemoryStorage::new();
        let error = storage.list("../").await.unwrap_err();
        assert_eq!(error.name(), "StorageError");
    }

    /// An `index` call: the key, the bytes and the keys the storage it was given lists.
    type IndexCall = (String, Vec<u8>, Vec<String>);

    /// Records `index` and `search` calls with the relative keys and the storage's view of itself.
    #[derive(Default)]
    struct Recording {
        indexed: Mutex<Vec<IndexCall>>,
        searched: Mutex<Vec<(String, Vec<String>)>>,
    }

    #[async_trait]
    impl SearchStrategy for Recording {
        async fn index(&self, storage: &dyn Storage, key: &str, data: &[u8]) -> Result<()> {
            let visible = storage.list("").await?;
            self.indexed
                .lock()
                .unwrap()
                .push((key.to_owned(), data.to_vec(), visible));
            Ok(())
        }

        async fn search(&self, storage: &dyn Storage, query: &str) -> Result<Vec<StorageSearchResult>> {
            let visible = storage.list("").await?;
            self.searched.lock().unwrap().push((query.to_owned(), visible));
            Ok(vec![StorageSearchResult::new("hit", 1.0)])
        }
    }

    fn with_strategy(strategy: &Arc<Recording>) -> InMemoryStorage {
        let config = InMemoryStorageConfig::builder()
            .search_strategy(Arc::clone(strategy) as Arc<dyn SearchStrategy>)
            .build();
        InMemoryStorage::with_config(config)
    }

    #[tokio::test]
    async fn indexes_writes_and_delegates_search_to_a_search_strategy_from_config() {
        let strategy = Arc::new(Recording::default());
        let configured = with_strategy(&strategy);
        configured.write("a", &[1]).await.unwrap();
        assert_eq!(
            *strategy.indexed.lock().unwrap(),
            [("a".to_owned(), vec![1], vec!["a".to_owned()])]
        );
        assert_eq!(
            configured.search("query").await.unwrap(),
            [StorageSearchResult::new("hit", 1.0)]
        );
        assert_eq!(strategy.searched.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn uses_the_default_keyword_scan_with_an_empty_config() {
        let configured = InMemoryStorage::with_config(InMemoryStorageConfig::default());
        configured.write("notes", b"dark mode").await.unwrap();
        let results = configured.search("dark").await.unwrap();
        assert_eq!(results.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), ["notes"]);
    }

    #[tokio::test]
    async fn returns_a_scoped_in_memory_storage_that_shares_entries_with_the_parent() {
        let storage = InMemoryStorage::new();
        let scoped = storage.namespace("memory/agent").unwrap();
        scoped.write("notes.md", b"hello").await.unwrap();
        assert!(Storage::is_namespaced(&scoped));
        assert_eq!(scoped.storage_type(), "InMemoryStorage");
        assert_eq!(storage.list("").await.unwrap(), ["memory/agent/notes.md"]);
        assert_eq!(scoped.list("").await.unwrap(), ["notes.md"]);
        assert_eq!(text(scoped.read("notes.md").await.unwrap()), "hello");
        scoped.delete("notes.md").await.unwrap();
        assert!(storage.list("").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn composes_nested_namespaces() {
        let storage = InMemoryStorage::new();
        let nested = storage.namespace("a").unwrap().namespace("b/").unwrap();
        nested.write("k", b"v").await.unwrap();
        assert_eq!(storage.list("").await.unwrap(), ["a/b/k"]);
    }

    #[tokio::test]
    async fn searches_only_entries_under_the_prefix_and_scores_keys_without_it() {
        let storage = InMemoryStorage::new();
        storage
            .write("other/memory-agent-notes.md", b"unrelated")
            .await
            .unwrap();
        let scoped = storage.namespace("memory/agent").unwrap();
        scoped.write("deploy.md", b"blue green deploys").await.unwrap();
        scoped.write("theme.md", b"dark mode").await.unwrap();
        let results = scoped.search("memory agent deploy").await.unwrap();
        assert_eq!(
            results.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
            ["deploy.md"]
        );
    }

    #[tokio::test]
    async fn passes_the_scoped_instance_and_relative_keys_to_the_search_strategy() {
        let strategy = Arc::new(Recording::default());
        let parent = with_strategy(&strategy);
        parent.write("outside.md", b"x").await.unwrap();
        let scoped = parent.namespace("memory/agent").unwrap();
        scoped.write("deploy.md", b"x").await.unwrap();
        scoped.search("query").await.unwrap();
        let indexed = strategy.indexed.lock().unwrap();
        assert_eq!(
            indexed[1],
            ("deploy.md".to_owned(), b"x".to_vec(), vec!["deploy.md".to_owned()])
        );
        assert_eq!(
            *strategy.searched.lock().unwrap(),
            [("query".to_owned(), vec!["deploy.md".to_owned()])]
        );
    }

    #[tokio::test]
    async fn clears_only_entries_under_the_prefix() {
        let storage = InMemoryStorage::new();
        storage.write("keep.md", b"x").await.unwrap();
        let scoped = storage.namespace("memory").unwrap();
        scoped.write("drop.md", b"y").await.unwrap();
        scoped.clear();
        assert_eq!(storage.list("").await.unwrap(), ["keep.md"]);
    }

    #[tokio::test]
    async fn exposes_namespacing_and_search_through_dyn_storage() {
        let storage: Arc<dyn Storage> = Arc::new(InMemoryStorage::new());
        assert!(storage.is_ephemeral());
        assert!(!storage.is_namespaced());
        let scoped = storage.namespace("memory").unwrap().unwrap();
        scoped.write("theme.md", b"dark mode").await.unwrap();
        let results = scoped.search("dark").await.unwrap().unwrap();
        assert_eq!(results[0].key, "theme.md");
        assert_eq!(storage.list("").await.unwrap(), ["memory/theme.md"]);
    }

    #[test]
    fn an_empty_namespace_keeps_the_prefix() {
        let storage = InMemoryStorage::new();
        let scoped = storage.namespace("a").unwrap().namespace("").unwrap();
        assert_eq!(scoped.prefix, "a/");
        assert!(storage.namespace("../x").is_err());
    }
}
