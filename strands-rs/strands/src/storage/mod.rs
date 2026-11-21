//! Unified byte storage.
//!
//! [`Storage`] persists raw bytes under string keys. Every SDK subsystem that needs persistence
//! (sessions, memory, context offloading) consumes it. The SDK ships [`InMemoryStorage`] and
//! [`LocalFileStorage`]; [`namespace`] scopes any backend under a key prefix (through its own
//! namespacing or a [`NamespacedStorage`]), and [`search`] holds the pluggable search strategies.
//!
//! ```
//! use strands::storage::{InMemoryStorage, Storage};
//!
//! # #[tokio::main(flavor = "current_thread")]
//! # async fn main() -> strands::Result<()> {
//! let storage = InMemoryStorage::new();
//! storage.write("memory/notes.json", b"[]").await?;
//! assert_eq!(storage.read("memory/notes.json").await?, Some(b"[]".to_vec()));
//! assert_eq!(storage.list("memory/").await?, ["memory/notes.json"]);
//! # Ok(())
//! # }
//! ```

use std::any::type_name;
use std::sync::Arc;

use async_trait::async_trait;

use crate::error::{Result, StorageError};

mod in_memory_storage;
mod local_file_storage;
mod namespaced_storage;
pub mod search;

pub use in_memory_storage::{InMemoryStorage, InMemoryStorageConfig, InMemoryStorageConfigBuilder};
pub use local_file_storage::{LocalFileStorage, LocalFileStorageConfig, LocalFileStorageConfigBuilder};
pub use namespaced_storage::NamespacedStorage;
pub use search::StorageSearchResult;

/// A backend for storing and retrieving raw bytes under string keys (`Storage`).
///
/// Keys are opaque strings and implementations round-trip the bytes they are given unchanged.
/// The shipped backends read `/` as a logical separator: they collapse slash runs, strip leading
/// and trailing slashes and reject empty keys, backslashes and `..` segments. Custom backends may
/// use their own key scheme.
///
/// Two methods are optional capabilities: [`namespace`](Storage::namespace) and
/// [`search`](Storage::search) return `None` when the backend does not implement them, and
/// callers then fall back to a [`NamespacedStorage`] view or a client-side
/// [`KeywordSearchStrategy`](search::KeywordSearchStrategy) scan.
///
/// ```
/// use std::collections::BTreeMap;
/// use std::sync::Mutex;
///
/// use strands::storage::Storage;
///
/// #[derive(Default)]
/// struct MapStorage(Mutex<BTreeMap<String, Vec<u8>>>);
///
/// #[strands::async_trait]
/// impl Storage for MapStorage {
///     async fn write(&self, key: &str, data: &[u8]) -> strands::Result<()> {
///         self.0.lock().unwrap().insert(key.to_owned(), data.to_vec());
///         Ok(())
///     }
///
///     async fn read(&self, key: &str) -> strands::Result<Option<Vec<u8>>> {
///         Ok(self.0.lock().unwrap().get(key).cloned())
///     }
///
///     async fn delete(&self, key: &str) -> strands::Result<()> {
///         self.0.lock().unwrap().remove(key);
///         Ok(())
///     }
///
///     async fn list(&self, prefix: &str) -> strands::Result<Vec<String>> {
///         let map = self.0.lock().unwrap();
///         Ok(map.keys().filter(|key| key.starts_with(prefix)).cloned().collect())
///     }
/// }
///
/// assert_eq!(MapStorage::default().storage_type(), "MapStorage");
/// ```
#[async_trait]
pub trait Storage: Send + Sync + 'static {
    /// Stores `data` under `key`, overwriting any existing value.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] when the key is invalid or the write fails.
    async fn write(&self, key: &str, data: &[u8]) -> Result<()>;

    /// The bytes stored under `key`, or `None` when no value exists.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] when the key is invalid or the read fails for a reason other
    /// than a missing key.
    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>>;

    /// Deletes the value stored under `key`. A no-op when the key does not exist.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] when the key is invalid or the delete fails.
    async fn delete(&self, key: &str) -> Result<()>;

    /// The full keys that start with `prefix`, sorted ascending. An empty prefix lists every key.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] when the prefix is invalid or the listing fails.
    async fn list(&self, prefix: &str) -> Result<Vec<String>>;

    /// A view of this storage with every key prefixed by `prefix` (optional `namespace`).
    ///
    /// `None` means the backend has no namespacing of its own; wrap it in a [`NamespacedStorage`]
    /// instead. The shipped backends return an instance of their own type.
    fn namespace(&self, _prefix: &str) -> Option<Result<Arc<dyn Storage>>> {
        None
    }

    /// Searches stored content for `query`, best match first (optional `search`).
    ///
    /// `None` means the backend does not search; callers fall back to a client-side scan such as
    /// [`KeywordSearchStrategy`](search::KeywordSearchStrategy). How a query is interpreted
    /// (keyword scan, full-text index, vector similarity) is up to the backend.
    async fn search(&self, _query: &str) -> Option<Result<Vec<StorageSearchResult>>> {
        None
    }

    /// The backend's type name, recorded as the archive `storageType`.
    ///
    /// Defaults to the implementing type's name without its module path or generics. That name
    /// comes from [`std::any::type_name`], whose output Rust does not guarantee across compiler
    /// versions, so a custom backend whose archive may be restored by another build or SDK should
    /// override it with a fixed name.
    fn storage_type(&self) -> &str {
        short_type_name(type_name::<Self>())
    }

    /// Whether stored data is lost when the process exits.
    fn is_ephemeral(&self) -> bool {
        false
    }

    /// Whether this is already a namespaced view, so constructs that scope storage under a default
    /// prefix use it as it is.
    fn is_namespaced(&self) -> bool {
        false
    }
}

/// What the builders' `storage(..)` setters take: a storage by value, an `Arc` of one, or an
/// `Arc<dyn Storage>` (kept as is, so the agent's [`storage`](crate::Agent::storage) is the same
/// instance).
pub trait IntoStorage {
    /// The storage, shared.
    fn into_storage(self) -> Arc<dyn Storage>;
}

impl<S: Storage> IntoStorage for S {
    fn into_storage(self) -> Arc<dyn Storage> {
        Arc::new(self)
    }
}

impl<S: Storage> IntoStorage for Arc<S> {
    fn into_storage(self) -> Arc<dyn Storage> {
        self
    }
}

impl IntoStorage for Arc<dyn Storage> {
    fn into_storage(self) -> Arc<dyn Storage> {
        self
    }
}

/// `strands::storage::InMemoryStorage` -> `InMemoryStorage`; `a::Wrapper<b::Inner>` -> `Wrapper`.
fn short_type_name(full: &str) -> &str {
    let path = full.split('<').next().unwrap_or(full);
    path.rsplit("::").next().unwrap_or(path)
}

/// Validates and normalizes a key for the path-based backends: collapses slash
/// runs and strips leading and trailing slashes; rejects backslashes, empty keys and `..` segments.
pub(crate) fn normalize_key(key: &str) -> Result<String> {
    if key.contains('\\') {
        return Err(StorageError::new(format!("Invalid storage key '{key}': backslashes are not allowed")).into());
    }
    let segments: Vec<&str> = key.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.is_empty() {
        return Err(StorageError::new("Storage key must not be empty").into());
    }
    if segments.contains(&"..") {
        return Err(StorageError::new(format!(
            "Invalid storage key '{key}': '..' path segments are not allowed"
        ))
        .into());
    }
    Ok(segments.join("/"))
}

/// Normalizes a list prefix: collapses slash runs and strips leading slashes,
/// keeping one trailing slash. Unlike a key, an empty prefix is valid and matches everything.
pub(crate) fn normalize_prefix(prefix: &str) -> Result<String> {
    if prefix.contains('\\') {
        return Err(StorageError::new(format!(
            "Invalid storage prefix '{prefix}': backslashes are not allowed"
        ))
        .into());
    }
    let segments: Vec<&str> = prefix.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.contains(&"..") {
        return Err(StorageError::new(format!(
            "Invalid storage prefix '{prefix}': '..' path segments are not allowed"
        ))
        .into());
    }
    let joined = segments.join("/");
    if prefix.ends_with('/') && !joined.is_empty() {
        return Ok(format!("{joined}/"));
    }
    Ok(joined)
}

/// Sorts keys by UTF-16 code units, the listing order shared across the Strands SDKs.
pub(crate) fn sort_keys(keys: &mut [String]) {
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// A view of `storage` with every key under `prefix` (`namespace`): the backend's own
/// [`Storage::namespace`] when it has one, a [`NamespacedStorage`] otherwise. This is the form to
/// use on an `Arc<dyn Storage>`, where the trait method returns `None` for backends without
/// namespacing.
///
/// ```
/// use std::sync::Arc;
/// use strands::storage::{self, InMemoryStorage, Storage};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> strands::Result<()> {
/// let root: Arc<dyn Storage> = Arc::new(InMemoryStorage::new());
/// let sessions = storage::namespace(root.clone(), "sessions")?;
/// sessions.write("abc.json", b"{}").await?;
/// assert_eq!(root.list("").await?, ["sessions/abc.json"]);
/// # Ok(())
/// # }
/// ```
///
/// # Errors
///
/// Returns a [`StorageError`] when the prefix is invalid for the backend.
pub fn namespace(storage: Arc<dyn Storage>, prefix: &str) -> Result<Arc<dyn Storage>> {
    if let Some(scoped) = storage.namespace(prefix) {
        return scoped;
    }
    Ok(Arc::new(NamespacedStorage::new(storage, prefix)?))
}

/// Scopes `storage` under `prefix` unless it is already namespaced.
pub(crate) fn resolve_namespace(storage: Arc<dyn Storage>, prefix: &str) -> Result<Arc<dyn Storage>> {
    if storage.is_namespaced() {
        return Ok(storage);
    }
    namespace(storage, prefix)
}

/// Key normalization, `resolve_namespace` and the trait defaults.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_keys_with_the_ts_rules_and_error_texts() {
        assert_eq!(normalize_key("/a//b/").unwrap(), "a/b");
        assert_eq!(normalize_key("./a").unwrap(), "./a");
        assert_eq!(
            normalize_key("").unwrap_err().to_string(),
            "Storage key must not be empty"
        );
        assert_eq!(
            normalize_key("//").unwrap_err().to_string(),
            "Storage key must not be empty"
        );
        assert_eq!(
            normalize_key("a/../b").unwrap_err().to_string(),
            "Invalid storage key 'a/../b': '..' path segments are not allowed"
        );
        assert_eq!(
            normalize_key("foo\\bar").unwrap_err().to_string(),
            "Invalid storage key 'foo\\bar': backslashes are not allowed"
        );
    }

    #[test]
    fn normalizes_prefixes_keeping_one_trailing_slash() {
        assert_eq!(normalize_prefix("").unwrap(), "");
        assert_eq!(normalize_prefix("/").unwrap(), "");
        assert_eq!(normalize_prefix("a/").unwrap(), "a/");
        assert_eq!(normalize_prefix("a//").unwrap(), "a/");
        assert_eq!(normalize_prefix("/a//b").unwrap(), "a/b");
        assert_eq!(
            normalize_prefix("../").unwrap_err().to_string(),
            "Invalid storage prefix '../': '..' path segments are not allowed"
        );
        assert_eq!(
            normalize_prefix("a\\").unwrap_err().to_string(),
            "Invalid storage prefix 'a\\': backslashes are not allowed"
        );
    }

    #[test]
    fn key_errors_are_storage_errors() {
        assert_eq!(normalize_key("").unwrap_err().name(), "StorageError");
        assert_eq!(normalize_prefix("..").unwrap_err().name(), "StorageError");
    }

    #[test]
    fn sorts_keys_by_utf16_code_units_like_js() {
        let mut keys = vec![
            "\u{1F600}".to_owned(),
            "\u{FF5E}".to_owned(),
            "b".to_owned(),
            "a".to_owned(),
        ];
        sort_keys(&mut keys);
        assert_eq!(keys, ["a", "b", "\u{1F600}", "\u{FF5E}"]);
    }

    #[test]
    fn short_type_name_drops_the_module_path_and_generics() {
        assert_eq!(short_type_name("strands::storage::InMemoryStorage"), "InMemoryStorage");
        assert_eq!(short_type_name("a::Wrapper<b::Inner>"), "Wrapper");
        assert_eq!(short_type_name("Plain"), "Plain");
    }

    #[tokio::test]
    async fn resolve_namespace_keeps_namespaced_storage_and_prefers_the_backends_own() {
        let root: Arc<dyn Storage> = Arc::new(InMemoryStorage::new());
        let scoped = resolve_namespace(Arc::clone(&root), "memory").unwrap();
        assert!(scoped.is_namespaced());
        assert_eq!(scoped.storage_type(), "InMemoryStorage");
        assert!(Arc::ptr_eq(
            &resolve_namespace(Arc::clone(&scoped), "other").unwrap(),
            &scoped
        ));
        scoped.write("k", b"v").await.unwrap();
        assert_eq!(root.list("").await.unwrap(), ["memory/k"]);
    }

    #[tokio::test]
    async fn resolve_namespace_wraps_a_backend_without_namespacing() {
        let root: Arc<dyn Storage> = Arc::new(Bare(InMemoryStorage::new()));
        assert!(root.namespace("x").is_none());
        let scoped = resolve_namespace(Arc::clone(&root), "x").unwrap();
        assert!(scoped.is_namespaced());
        scoped.write("k", b"v").await.unwrap();
        assert_eq!(root.list("").await.unwrap(), ["x/k"]);
        assert!(root.search("v").await.is_none());
    }

    #[tokio::test]
    async fn namespace_scopes_a_dyn_storage_with_or_without_its_own_namespacing() {
        let root: Arc<dyn Storage> = Arc::new(InMemoryStorage::new());
        let scoped = namespace(Arc::clone(&root), "a").unwrap();
        let nested = namespace(Arc::clone(&scoped), "b").unwrap();
        nested.write("k", b"v").await.unwrap();
        assert_eq!(root.list("").await.unwrap(), ["a/b/k"]);
        assert_eq!(scoped.storage_type(), "InMemoryStorage");

        let bare: Arc<dyn Storage> = Arc::new(Bare(InMemoryStorage::new()));
        let scoped = namespace(Arc::clone(&bare), "x").unwrap();
        scoped.write("k", b"v").await.unwrap();
        assert_eq!(bare.list("").await.unwrap(), ["x/k"]);
        assert_eq!(
            namespace(bare, "../up").err().map(|error| error.to_string()),
            Some("Invalid storage prefix '../up': '..' path segments are not allowed".to_owned())
        );
    }

    #[test]
    fn trait_defaults_report_a_durable_unscoped_backend_named_after_its_type() {
        let bare = Bare(InMemoryStorage::new());
        assert_eq!(bare.storage_type(), "Bare");
        assert!(!bare.is_ephemeral());
        assert!(!bare.is_namespaced());
    }

    /// A backend that implements only the four required methods.
    struct Bare(InMemoryStorage);

    #[async_trait]
    impl Storage for Bare {
        async fn write(&self, key: &str, data: &[u8]) -> Result<()> {
            Storage::write(&self.0, key, data).await
        }

        async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
            Storage::read(&self.0, key).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            Storage::delete(&self.0, key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<String>> {
            Storage::list(&self.0, prefix).await
        }
    }
}
