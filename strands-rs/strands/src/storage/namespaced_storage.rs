//! The generic prefixed view over any backend.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;

use super::{Storage, StorageSearchResult, normalize_prefix};
use crate::error::{Result, StorageError};

/// A view of a [`Storage`] with every key prefixed by a namespace.
///
/// Writes, reads and deletes go to `<prefix>/<key>` in the underlying storage; `list` and `search`
/// return keys with the prefix stripped. Namespaces compose: [`Storage::namespace`] on a view
/// nests the prefixes. The prefix is normalized as a `/`-separated path, so use this with
/// backends that follow that key scheme. The shipped backends have their own
/// [`namespace`](super::InMemoryStorage::namespace) that returns their own type; this view is for
/// custom backends that do not.
///
/// ```
/// use std::sync::Arc;
///
/// use strands::storage::{InMemoryStorage, NamespacedStorage, Storage};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> strands::Result<()> {
/// let backend = Arc::new(InMemoryStorage::new());
/// let sessions = NamespacedStorage::new(backend.clone(), "session")?;
/// sessions.write("abc/snapshot.json", b"{}").await?;
/// assert_eq!(backend.list("").await?, ["session/abc/snapshot.json"]);
/// assert_eq!(sessions.list("").await?, ["abc/snapshot.json"]);
/// # Ok(())
/// # }
/// ```
pub struct NamespacedStorage {
    inner: Arc<dyn Storage>,
    prefix: String,
}

impl NamespacedStorage {
    /// Scopes `storage` under `prefix`. An empty prefix leaves keys unchanged.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] when the prefix contains a backslash or a `..` segment.
    pub fn new(storage: Arc<dyn Storage>, prefix: &str) -> Result<Self> {
        let normalized = normalize_prefix(prefix)?;
        let normalized = normalized.trim_end_matches('/');
        let prefix = if normalized.is_empty() {
            String::new()
        } else {
            format!("{normalized}/")
        };
        Ok(Self { inner: storage, prefix })
    }

    /// The full key in the underlying storage. A key with no segments would address the namespace
    /// itself, outside the view, so it is rejected as an empty key.
    fn full_key(&self, key: &str) -> Result<String> {
        if key.split('/').all(str::is_empty) {
            return Err(StorageError::new("Storage key must not be empty").into());
        }
        Ok(format!("{}{key}", self.prefix))
    }

    fn strip(&self, key: String) -> String {
        match key.strip_prefix(&self.prefix) {
            Some(relative) => relative.to_owned(),
            None => key,
        }
    }
}

impl fmt::Debug for NamespacedStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NamespacedStorage")
            .field("inner", &self.inner.storage_type())
            .field("prefix", &self.prefix)
            .finish()
    }
}

#[async_trait]
impl Storage for NamespacedStorage {
    async fn write(&self, key: &str, data: &[u8]) -> Result<()> {
        self.inner.write(&self.full_key(key)?, data).await
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.inner.read(&self.full_key(key)?).await
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.inner.delete(&self.full_key(key)?).await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let keys = self.inner.list(&format!("{}{prefix}", self.prefix)).await?;
        Ok(keys.into_iter().map(|key| self.strip(key)).collect())
    }

    fn namespace(&self, prefix: &str) -> Option<Result<Arc<dyn Storage>>> {
        let nested = Self::new(Arc::clone(&self.inner), &format!("{}{prefix}", self.prefix));
        Some(nested.map(|view| Arc::new(view) as Arc<dyn Storage>))
    }

    async fn search(&self, query: &str) -> Option<Result<Vec<StorageSearchResult>>> {
        let results = self.inner.search(query).await?;
        Some(results.map(|results| {
            results
                .into_iter()
                .filter(|result| result.key.starts_with(&self.prefix))
                .map(|mut result| {
                    result.key = self.strip(result.key);
                    result
                })
                .collect()
        }))
    }

    /// `"Object"`, the `storageType` the other Strands SDKs persist for a namespaced view.
    fn storage_type(&self) -> &str {
        "Object"
    }

    fn is_ephemeral(&self) -> bool {
        self.inner.is_ephemeral()
    }

    fn is_namespaced(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::InMemoryStorage;

    fn setup() -> (Arc<InMemoryStorage>, NamespacedStorage) {
        let backend = Arc::new(InMemoryStorage::new());
        let namespaced = NamespacedStorage::new(backend.clone(), "prefix").unwrap();
        (backend, namespaced)
    }

    #[tokio::test]
    async fn prepends_namespace_to_write_keys() {
        let (backend, namespaced) = setup();
        namespaced.write("key", &[1, 2, 3]).await.unwrap();
        assert_eq!(backend.read("prefix/key").await.unwrap(), Some(vec![1, 2, 3]));
    }

    #[tokio::test]
    async fn prepends_namespace_to_read_keys() {
        let (backend, namespaced) = setup();
        backend.write("prefix/key", &[4, 5]).await.unwrap();
        assert_eq!(namespaced.read("key").await.unwrap(), Some(vec![4, 5]));
    }

    #[tokio::test]
    async fn returns_null_for_missing_keys() {
        let (_backend, namespaced) = setup();
        assert_eq!(namespaced.read("nonexistent").await.unwrap(), None);
    }

    #[tokio::test]
    async fn prepends_namespace_to_delete_keys() {
        let (backend, namespaced) = setup();
        backend.write("prefix/key", &[1]).await.unwrap();
        namespaced.delete("key").await.unwrap();
        assert_eq!(backend.read("prefix/key").await.unwrap(), None);
    }

    #[tokio::test]
    async fn lists_keys_with_namespace_stripped() {
        let (backend, namespaced) = setup();
        backend.write("prefix/a", &[1]).await.unwrap();
        backend.write("prefix/b", &[2]).await.unwrap();
        backend.write("other/c", &[3]).await.unwrap();
        assert_eq!(namespaced.list("").await.unwrap(), ["a", "b"]);
    }

    #[tokio::test]
    async fn lists_keys_with_sub_prefix() {
        let (backend, namespaced) = setup();
        backend.write("prefix/session/abc", &[1]).await.unwrap();
        backend.write("prefix/session/def", &[2]).await.unwrap();
        backend.write("prefix/offloader/xyz", &[3]).await.unwrap();
        assert_eq!(
            namespaced.list("session/").await.unwrap(),
            ["session/abc", "session/def"]
        );
    }

    #[tokio::test]
    async fn composes_nested_namespaces() {
        let backend = Arc::new(InMemoryStorage::new());
        let outer: Arc<dyn Storage> = Arc::new(NamespacedStorage::new(backend.clone(), "prefix").unwrap());
        let nested = NamespacedStorage::new(outer, "sub").unwrap();
        nested.write("key", &[9]).await.unwrap();
        assert_eq!(backend.read("prefix/sub/key").await.unwrap(), Some(vec![9]));
    }

    #[tokio::test]
    async fn handles_empty_namespace_as_no_op_prefix() {
        let backend = Arc::new(InMemoryStorage::new());
        let empty = NamespacedStorage::new(backend.clone(), "").unwrap();
        empty.write("key", &[7]).await.unwrap();
        assert_eq!(backend.read("key").await.unwrap(), Some(vec![7]));
    }

    #[test]
    fn sets_namespaced_symbol_on_returned_view() {
        let (_backend, namespaced) = setup();
        assert!(namespaced.is_namespaced());
    }

    #[test]
    fn does_not_have_namespaced_symbol_on_raw_storage() {
        let (backend, _namespaced) = setup();
        assert!(!Storage::is_namespaced(backend.as_ref()));
    }

    #[tokio::test]
    async fn nests_through_the_namespace_method() {
        let (backend, namespaced) = setup();
        let nested = namespaced.namespace("sub/").unwrap().unwrap();
        nested.write("key", &[1]).await.unwrap();
        assert_eq!(backend.list("").await.unwrap(), ["prefix/sub/key"]);
        assert_eq!(nested.list("").await.unwrap(), ["key"]);
    }

    #[tokio::test]
    async fn strips_a_trailing_slash_prefix_once() {
        let backend = Arc::new(InMemoryStorage::new());
        let namespaced = NamespacedStorage::new(backend.clone(), "a/").unwrap();
        namespaced.write("abc", &[1]).await.unwrap();
        assert_eq!(backend.list("").await.unwrap(), ["a/abc"]);
        assert_eq!(namespaced.list("").await.unwrap(), ["abc"]);
        let hits = namespaced.search("abc").await.unwrap().unwrap();
        assert_eq!(hits.iter().map(|hit| hit.key.as_str()).collect::<Vec<_>>(), ["abc"]);
    }

    #[tokio::test]
    async fn rejects_an_empty_key_instead_of_addressing_the_namespace_itself() {
        let (backend, namespaced) = setup();
        backend.write("prefix", &[1]).await.unwrap();
        for key in ["", "/", "//"] {
            let error = namespaced.read(key).await.unwrap_err();
            assert_eq!(error.to_string(), "Storage key must not be empty");
            assert!(namespaced.write(key, &[2]).await.is_err());
        }
        assert_eq!(backend.read("prefix").await.unwrap(), Some(vec![1]));
    }

    #[tokio::test]
    async fn filters_and_strips_backend_search_results() {
        let (backend, namespaced) = setup();
        backend.write("prefix/dark.md", b"dark mode").await.unwrap();
        backend.write("other/dark.md", b"dark mode").await.unwrap();
        let hits = namespaced.search("dark").await.unwrap().unwrap();
        assert_eq!(hits.iter().map(|hit| hit.key.as_str()).collect::<Vec<_>>(), ["dark.md"]);
    }

    #[test]
    fn carries_the_ephemeral_marker_and_reports_the_ts_object_type() {
        let (_backend, namespaced) = setup();
        assert!(namespaced.is_ephemeral());
        assert_eq!(namespaced.storage_type(), "Object");
    }

    #[test]
    fn rejects_an_invalid_prefix() {
        let backend = Arc::new(InMemoryStorage::new());
        let error = NamespacedStorage::new(backend, "../x").unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid storage prefix '../x': '..' path segments are not allowed"
        );
    }
}
