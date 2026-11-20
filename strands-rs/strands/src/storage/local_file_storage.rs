//! Local filesystem storage.

use std::fmt;
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use super::search::{KeywordSearchStrategy, SearchStrategy, StorageSearchResult};
use super::{Storage, normalize_key, normalize_prefix, sort_keys};
use crate::error::{Error, Result, StorageError};
use crate::sandbox::Sandbox;

/// Marks the scratch file of an in-progress write; listings skip files whose name contains it.
const TMP_MARKER: &str = ".__strands_tmp";

/// The default base directory.
const DEFAULT_BASE_DIR: &str = "./.strands/";

/// Options for [`LocalFileStorage`] (`LocalFileStorageConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct LocalFileStorageConfig {
    /// A sandbox to route all I/O through instead of the host filesystem; usually set with
    /// [`LocalFileStorage::for_sandbox`]. Cannot be combined with a search strategy that
    /// [requires host filesystem access](SearchStrategy::requires_host_fs).
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// Search strategy. When set, writes are indexed and [`LocalFileStorage::search`] delegates to
    /// it instead of the default keyword scan.
    pub search_strategy: Option<Arc<dyn SearchStrategy>>,
}

impl fmt::Debug for LocalFileStorageConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LocalFileStorageConfig")
            .field("sandbox", &self.sandbox.is_some())
            .field("search_strategy", &self.search_strategy.is_some())
            .finish()
    }
}

/// [`Storage`] that keeps each key as a file under a base directory (`LocalFileStorage`).
///
/// The key's `/` segments map onto directories: key `a/b.json` is the file `<base_dir>/a/b.json`.
/// Writes are atomic: the bytes go to a scratch sibling that is then renamed over the target, so
/// a crash mid-write never leaves a partial file. Missing directories are created on write. Bound
/// to a [`Sandbox`] (see [`for_sandbox`](Self::for_sandbox)), all I/O goes through the sandbox
/// instead, and atomicity is the sandbox's.
///
/// The harness keeps its sessions in `LocalFileStorage::new("./.agent").namespace("sessions")`,
/// the on-disk layout shared with the other Strands harness SDKs.
///
/// ```
/// use strands::storage::{LocalFileStorage, Storage};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> strands::Result<()> {
/// # let dir = tempfile::tempdir()?;
/// # let root = dir.path().join(".agent");
/// let sessions = LocalFileStorage::new(&root).namespace("sessions")?;
/// sessions.write("abc/scopes/agent/default/snapshots/snapshot_latest.json", b"{}").await?;
/// assert!(root.join("sessions/abc/scopes/agent/default/snapshots/snapshot_latest.json").is_file());
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct LocalFileStorage {
    base_dir: PathBuf,
    namespaced: bool,
    search_strategy: Option<Arc<dyn SearchStrategy>>,
    sandbox: Option<Arc<dyn Sandbox>>,
}

impl LocalFileStorage {
    /// Storage rooted at `base_dir`, using the default keyword search.
    pub fn new(base_dir: impl AsRef<Path>) -> Self {
        Self {
            base_dir: base_dir.as_ref().components().collect(),
            namespaced: false,
            search_strategy: None,
            sandbox: None,
        }
    }

    /// Storage rooted at `base_dir`, with options.
    ///
    /// # Errors
    ///
    /// When `config` combines a sandbox with a search strategy that requires host filesystem
    /// access.
    pub fn with_config(base_dir: impl AsRef<Path>, config: LocalFileStorageConfig) -> Result<Self> {
        if config.sandbox.is_some()
            && let Some(strategy) = config
                .search_strategy
                .as_ref()
                .filter(|strategy| strategy.requires_host_fs())
        {
            return Err(Error::other(format!(
                "{} requires host filesystem access and cannot be used with a sandbox",
                strategy.name()
            )));
        }
        Ok(Self {
            sandbox: config.sandbox,
            search_strategy: config.search_strategy,
            ..Self::new(base_dir)
        })
    }

    /// A storage with the same base directory whose I/O goes through `sandbox`.
    ///
    /// Storage already bound to a sandbox comes back unchanged. A search strategy that requires
    /// host filesystem access is dropped with a warning, falling back to the keyword scan, which
    /// reads through the sandbox.
    #[must_use]
    pub fn for_sandbox(&self, sandbox: Arc<dyn Sandbox>) -> Self {
        if self.sandbox.is_some() {
            return self.clone();
        }
        let mut search_strategy = self.search_strategy.clone();
        if let Some(strategy) = search_strategy.as_ref().filter(|strategy| strategy.requires_host_fs()) {
            tracing::warn!(
                "strategy=<{}> | search strategy requires host filesystem access and is not compatible with sandboxed storage | falling back to keyword search",
                strategy.name()
            );
            search_strategy = None;
        }
        Self {
            sandbox: Some(sandbox),
            search_strategy,
            namespaced: false,
            base_dir: self.base_dir.clone(),
        }
    }

    /// The root directory of this storage, with repeated and trailing separators removed.
    #[must_use]
    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// A storage rooted at the `prefix` subdirectory, sharing this storage's search strategy.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] when the prefix contains a backslash, a `..` segment, or a
    /// segment the platform does not read as one plain name (a Windows drive prefix).
    pub fn namespace(&self, prefix: &str) -> Result<Self> {
        let normalized = normalize_prefix(prefix)?;
        let base_dir = join_segments(&self.base_dir, &normalized, "prefix", prefix)?;
        Ok(Self {
            base_dir,
            namespaced: true,
            search_strategy: self.search_strategy.clone(),
            sandbox: self.sandbox.clone(),
        })
    }

    /// Searches the stored files with the configured strategy or the default keyword scan.
    ///
    /// # Errors
    ///
    /// Returns the strategy's error, or a [`StorageError`] when the keyword scan cannot list.
    pub async fn search(&self, query: &str) -> Result<Vec<StorageSearchResult>> {
        match &self.search_strategy {
            Some(strategy) => strategy.search(self, query).await,
            None => KeywordSearchStrategy.search(self, query).await,
        }
    }

    fn path_for(&self, normalized: &str, key: &str) -> Result<PathBuf> {
        join_segments(&self.base_dir, normalized, "key", key)
    }

    /// The sandbox path of `relative` under the base directory (`/`-joined, as sandboxes may be
    /// remote).
    fn sandbox_path(&self, relative: &str) -> String {
        let base = self.base_dir.to_string_lossy();
        let base = base.trim_end_matches('/');
        if relative.is_empty() {
            base.to_owned()
        } else {
            format!("{base}/{relative}")
        }
    }

    /// Every file key under the sandbox directory `dir`, whose key is `key_prefix`.
    async fn walk_sandbox(&self, sandbox: &dyn Sandbox, dir: String, key_prefix: String) -> Result<Vec<String>> {
        let mut found = Vec::new();
        let mut pending = vec![(dir, key_prefix)];
        while let Some((dir, prefix)) = pending.pop() {
            let entries = match sandbox.list_files(&dir).await {
                Ok(entries) => entries,
                Err(error) if is_sandbox_not_found(&error) => continue,
                Err(error) => {
                    let message = format!("Failed to list sandbox storage under '{prefix}'");
                    return Err(StorageError::new(message).with_source(error).into());
                }
            };
            for entry in entries {
                let is_dir = entry.is_dir == Some(true);
                if !is_dir && entry.name.contains(TMP_MARKER) {
                    continue;
                }
                let child_key = if prefix.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{prefix}/{}", entry.name)
                };
                if is_dir {
                    pending.push((format!("{dir}/{}", entry.name), child_key));
                } else {
                    found.push(child_key);
                }
            }
        }
        Ok(found)
    }

    /// Every file key under `dir`, whose key is `key_prefix`; a missing directory has none.
    async fn walk(&self, dir: PathBuf, key_prefix: String) -> Result<Vec<String>> {
        let mut found = Vec::new();
        let mut pending = vec![(dir, key_prefix)];
        while let Some((dir, prefix)) = pending.pop() {
            let entries = match read_dir_entries(&dir).await {
                Ok(entries) => entries,
                Err(error) if is_not_found(&error) => continue,
                Err(error) => {
                    let message = format!("Failed to list local storage under '{prefix}'");
                    return Err(StorageError::new(message).with_source(error).into());
                }
            };
            for (name, is_dir) in entries {
                if !is_dir && name.contains(TMP_MARKER) {
                    continue;
                }
                let child_key = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if is_dir {
                    pending.push((dir.join(&name), child_key));
                } else {
                    found.push(child_key);
                }
            }
        }
        Ok(found)
    }
}

impl Default for LocalFileStorage {
    /// Storage rooted at `./.strands/`.
    fn default() -> Self {
        Self::new(DEFAULT_BASE_DIR)
    }
}

impl fmt::Debug for LocalFileStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LocalFileStorage")
            .field("base_dir", &self.base_dir)
            .field("search_strategy", &self.search_strategy.is_some())
            .field("sandbox", &self.sandbox.is_some())
            .finish_non_exhaustive()
    }
}

/// `base` with each `/` segment of `normalized` pushed in turn. A segment that the platform reads
/// as more than one plain name (a Windows drive prefix such as `C:`) would make the push replace
/// `base`, so it is rejected.
fn join_segments(base: &Path, normalized: &str, kind: &str, original: &str) -> Result<PathBuf> {
    let mut path = base.to_path_buf();
    for segment in normalized.split('/').filter(|segment| !segment.is_empty()) {
        let mut components = Path::new(segment).components();
        let plain = matches!(
            (components.next(), components.next()),
            (Some(Component::Normal(_) | Component::CurDir), None)
        );
        if !plain {
            let message = format!("Invalid storage {kind} '{original}': '{segment}' is not a plain path segment");
            return Err(StorageError::new(message).into());
        }
        path.push(segment);
    }
    Ok(path)
}

/// A missing path, or a path through a file (`ENOENT`, `ENOTDIR`).
fn is_not_found(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

/// Whether a sandbox error reports a missing path.
fn is_sandbox_not_found(error: &Error) -> bool {
    match error {
        Error::SandboxPathNotFound(_) => true,
        Error::Other(source) => source.downcast_ref::<io::Error>().is_some_and(is_not_found),
        _ => false,
    }
}

/// The names of `dir`'s entries and whether each is a directory (symlinks are not followed).
async fn read_dir_entries(dir: &Path) -> io::Result<Vec<(String, bool)>> {
    let mut entries = tokio::fs::read_dir(dir).await?;
    let mut found = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let is_dir = entry.file_type().await?.is_dir();
        found.push((entry.file_name().to_string_lossy().into_owned(), is_dir));
    }
    Ok(found)
}

fn scratch_path(path: &Path) -> PathBuf {
    let mut scratch = path.as_os_str().to_owned();
    scratch.push(format!("{TMP_MARKER}_{}", uuid::Uuid::new_v4()));
    PathBuf::from(scratch)
}

async fn write_atomically(path: &Path, scratch: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(scratch, data).await?;
    tokio::fs::rename(scratch, path).await
}

#[async_trait]
impl Storage for LocalFileStorage {
    async fn write(&self, key: &str, data: &[u8]) -> Result<()> {
        let normalized = normalize_key(key)?;
        if let Some(sandbox) = &self.sandbox {
            let path = self.sandbox_path(&normalized);
            return sandbox.write_file(&path, data).await.map_err(|error| {
                let message = format!("Failed to write '{normalized}' to sandbox storage");
                StorageError::new(message).with_source(error).into()
            });
        }
        let path = self.path_for(&normalized, key)?;
        let scratch = scratch_path(&path);
        if let Err(error) = write_atomically(&path, &scratch, data).await {
            tokio::fs::remove_file(&scratch).await.ok();
            let message = format!("Failed to write '{normalized}' to local storage");
            return Err(StorageError::new(message).with_source(error).into());
        }
        if let Some(strategy) = &self.search_strategy {
            strategy.index(self, &normalized, data).await?;
        }
        Ok(())
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let normalized = normalize_key(key)?;
        if let Some(sandbox) = &self.sandbox {
            return match sandbox.read_file(&self.sandbox_path(&normalized)).await {
                Ok(bytes) => Ok(Some(bytes)),
                Err(error) if is_sandbox_not_found(&error) => Ok(None),
                Err(error) => {
                    let message = format!("Failed to read '{normalized}' from sandbox storage");
                    Err(StorageError::new(message).with_source(error).into())
                }
            };
        }
        match tokio::fs::read(self.path_for(&normalized, key)?).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if is_not_found(&error) => Ok(None),
            Err(error) => {
                let message = format!("Failed to read '{normalized}' from local storage");
                Err(StorageError::new(message).with_source(error).into())
            }
        }
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let normalized = normalize_key(key)?;
        if let Some(sandbox) = &self.sandbox {
            return match sandbox.remove_file(&self.sandbox_path(&normalized)).await {
                Ok(()) => Ok(()),
                Err(error) if is_sandbox_not_found(&error) => Ok(()),
                Err(error) => {
                    let message = format!("Failed to delete '{normalized}' from sandbox storage");
                    Err(StorageError::new(message).with_source(error).into())
                }
            };
        }
        match tokio::fs::remove_file(self.path_for(&normalized, key)?).await {
            Ok(()) => Ok(()),
            Err(error) if is_not_found(&error) => Ok(()),
            Err(error) => {
                let message = format!("Failed to delete '{normalized}' from local storage");
                Err(StorageError::new(message).with_source(error).into())
            }
        }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let normalized = normalize_prefix(prefix)?;
        let dir_portion = normalized.rfind('/').map_or("", |slash| &normalized[..slash]);
        let mut keys = match &self.sandbox {
            Some(sandbox) => {
                self.walk_sandbox(sandbox.as_ref(), self.sandbox_path(dir_portion), dir_portion.to_owned())
                    .await?
            }
            None => {
                let start_dir = join_segments(&self.base_dir, dir_portion, "prefix", prefix)?;
                self.walk(start_dir, dir_portion.to_owned()).await?
            }
        };
        keys.retain(|key| key.starts_with(&normalized));
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
        "LocalFileStorage"
    }

    fn is_namespaced(&self) -> bool {
        self.namespaced
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tempfile::TempDir;

    use super::*;
    use crate::sandbox::NotASandboxLocalEnvironment;

    fn setup() -> (TempDir, PathBuf, LocalFileStorage) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("strands-test");
        let storage = LocalFileStorage::new(&base);
        (dir, base, storage)
    }

    #[tokio::test]
    async fn round_trips_bytes() {
        let (_dir, _base, storage) = setup();
        storage.write("test/file.txt", b"hello world").await.unwrap();
        assert_eq!(
            storage.read("test/file.txt").await.unwrap(),
            Some(b"hello world".to_vec())
        );
    }

    #[tokio::test]
    async fn creates_nested_directories() {
        let (_dir, base, storage) = setup();
        storage.write("deep/nested/path/file.bin", &[1, 2, 3]).await.unwrap();
        assert!(base.join("deep/nested/path/file.bin").is_file());
    }

    #[tokio::test]
    async fn overwrites_existing_values() {
        let (_dir, _base, storage) = setup();
        storage.write("key", b"first").await.unwrap();
        storage.write("key", b"second").await.unwrap();
        assert_eq!(storage.read("key").await.unwrap(), Some(b"second".to_vec()));
    }

    #[tokio::test]
    async fn returns_null_for_missing_keys() {
        let (_dir, _base, storage) = setup();
        assert_eq!(storage.read("nonexistent/key").await.unwrap(), None);
    }

    #[tokio::test]
    async fn writes_atomically_via_tmp_file() {
        let (_dir, base, storage) = setup();
        storage.write("atomic/test", &[1]).await.unwrap();
        assert_eq!(std::fs::read(base.join("atomic/test")).unwrap(), [1]);
        assert!(!base.join("atomic/test.tmp").exists());
        let names: Vec<String> = std::fs::read_dir(base.join("atomic"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["test"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleans_up_tmp_file_on_rename_failure() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, base, storage) = setup();
        let dir = base.join("readonly");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("target"), "original").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result = storage.write("readonly/target", &[1]).await;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = result.unwrap_err();
        assert_eq!(error.to_string(), "Failed to write 'readonly/target' to local storage");
        assert!(std::error::Error::source(&error).is_some());
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(TMP_MARKER)
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[tokio::test]
    async fn cleans_up_tmp_file_when_the_target_is_a_directory() {
        let (_dir, base, storage) = setup();
        std::fs::create_dir_all(base.join("taken/child")).unwrap();
        let error = storage.write("taken", &[1]).await.unwrap_err();
        assert_eq!(error.to_string(), "Failed to write 'taken' to local storage");
        let leftovers = std::fs::read_dir(&base)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(TMP_MARKER)
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[tokio::test]
    async fn rejects_keys_containing_backslashes() {
        let (_dir, _base, storage) = setup();
        let error = storage.write("foo\\bar", &[1]).await.unwrap_err();
        assert!(error.to_string().contains("backslashes are not allowed"), "{error}");
    }

    #[tokio::test]
    async fn rejects_backslash_path_traversal() {
        let (_dir, _base, storage) = setup();
        let error = storage.read("foo\\..\\..\\etc\\passwd").await.unwrap_err();
        assert!(error.to_string().contains("backslashes are not allowed"), "{error}");
    }

    #[tokio::test]
    async fn rejects_dot_dot_path_traversal() {
        let (_dir, _base, storage) = setup();
        let error = storage.write("../escaped", &[1]).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid storage key '../escaped': '..' path segments are not allowed"
        );
    }

    #[tokio::test]
    async fn removes_an_existing_key() {
        let (_dir, _base, storage) = setup();
        storage.write("deleteme", &[1]).await.unwrap();
        storage.delete("deleteme").await.unwrap();
        assert_eq!(storage.read("deleteme").await.unwrap(), None);
    }

    #[tokio::test]
    async fn is_a_no_op_for_missing_keys() {
        let (_dir, _base, storage) = setup();
        storage.delete("nonexistent").await.unwrap();
        storage.write("file", &[1]).await.unwrap();
        storage.delete("file/child").await.unwrap();
    }

    #[tokio::test]
    async fn lists_keys_under_a_prefix() {
        let (_dir, _base, storage) = setup();
        storage.write("sessions/a/data.json", &[1]).await.unwrap();
        storage.write("sessions/b/data.json", &[2]).await.unwrap();
        storage.write("memory/notes.json", &[3]).await.unwrap();
        assert_eq!(
            storage.list("sessions/").await.unwrap(),
            ["sessions/a/data.json", "sessions/b/data.json"]
        );
    }

    #[tokio::test]
    async fn returns_all_keys_for_empty_prefix() {
        let (_dir, _base, storage) = setup();
        storage.write("a", &[1]).await.unwrap();
        storage.write("b", &[2]).await.unwrap();
        assert_eq!(storage.list("").await.unwrap(), ["a", "b"]);
    }

    #[tokio::test]
    async fn returns_empty_array_when_base_directory_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = LocalFileStorage::new(dir.path().join("nonexistent"));
        assert!(fresh.list("").await.unwrap().is_empty());
        assert!(fresh.list("deep/prefix/").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn excludes_scratch_files() {
        let (_dir, base, storage) = setup();
        storage.write("real", &[1]).await.unwrap();
        std::fs::write(base.join("leftover.__strands_tmp"), "garbage").unwrap();
        assert_eq!(storage.list("").await.unwrap(), ["real"]);
    }

    #[tokio::test]
    async fn does_not_exclude_user_tmp_files() {
        let (_dir, _base, storage) = setup();
        storage.write("notes.tmp", &[1]).await.unwrap();
        assert!(storage.list("").await.unwrap().contains(&"notes.tmp".to_owned()));
    }

    #[tokio::test]
    async fn returns_keys_sorted_lexicographically() {
        let (_dir, _base, storage) = setup();
        for key in ["c", "a", "b/z", "b/a"] {
            storage.write(key, &[1]).await.unwrap();
        }
        assert_eq!(storage.list("").await.unwrap(), ["a", "b/a", "b/z", "c"]);
    }

    #[tokio::test]
    async fn matches_a_partial_last_segment() {
        let (_dir, _base, storage) = setup();
        for key in ["sessions/abc/x", "sessions/abd/y", "sessions/b/z", "sessionsx"] {
            storage.write(key, &[1]).await.unwrap();
        }
        assert_eq!(
            storage.list("sessions/ab").await.unwrap(),
            ["sessions/abc/x", "sessions/abd/y"]
        );
        assert_eq!(
            storage.list("sessions").await.unwrap(),
            ["sessions/abc/x", "sessions/abd/y", "sessions/b/z", "sessionsx"]
        );
    }

    #[tokio::test]
    async fn returns_a_local_file_storage_instance_rooted_at_the_subdirectory() {
        let (_dir, base, storage) = setup();
        let namespaced = storage.namespace("sub/dir").unwrap();
        namespaced.write("file.txt", &[1, 2, 3]).await.unwrap();
        assert_eq!(namespaced.read("file.txt").await.unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(namespaced.list("").await.unwrap(), ["file.txt"]);
        assert!(base.join("sub/dir/file.txt").is_file());
        assert!(Storage::is_namespaced(&namespaced));
        assert_eq!(namespaced.storage_type(), "LocalFileStorage");
    }

    #[tokio::test]
    async fn isolates_keys_from_the_parent_storage() {
        let (_dir, _base, storage) = setup();
        let namespaced = storage.namespace("isolated").unwrap();
        storage.write("root.txt", &[1]).await.unwrap();
        namespaced.write("child.txt", &[2]).await.unwrap();
        let parent_keys = storage.list("").await.unwrap();
        assert!(parent_keys.contains(&"root.txt".to_owned()));
        assert!(!parent_keys.contains(&"child.txt".to_owned()));
        assert_eq!(namespaced.list("").await.unwrap(), ["child.txt"]);
    }

    #[test]
    fn exposes_base_dir_pointing_to_the_subdirectory() {
        let (_dir, base, storage) = setup();
        assert_eq!(storage.namespace("nested").unwrap().base_dir(), base.join("nested"));
        assert_eq!(storage.namespace("nested/").unwrap().base_dir(), base.join("nested"));
    }

    #[test]
    fn base_dir_collapses_separators_and_defaults_to_dot_strands() {
        assert_eq!(LocalFileStorage::new("/tmp//a/").base_dir(), Path::new("/tmp/a"));
        assert_eq!(LocalFileStorage::new("/").base_dir(), Path::new("/"));
        assert_eq!(LocalFileStorage::default().base_dir().to_str(), Some("./.strands"));
        assert!(!Storage::is_ephemeral(&LocalFileStorage::default()));
    }

    #[derive(Default)]
    struct Recording {
        indexed: Mutex<Vec<(String, Vec<u8>)>>,
        queries: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl SearchStrategy for Recording {
        async fn index(&self, _storage: &dyn Storage, key: &str, data: &[u8]) -> Result<()> {
            self.indexed.lock().unwrap().push((key.to_owned(), data.to_vec()));
            Ok(())
        }

        async fn search(&self, _storage: &dyn Storage, query: &str) -> Result<Vec<StorageSearchResult>> {
            self.queries.lock().unwrap().push(query.to_owned());
            Ok(vec![StorageSearchResult::new("hit.txt", 1.0)])
        }
    }

    fn config(strategy: &Arc<Recording>) -> LocalFileStorageConfig {
        LocalFileStorageConfig::builder()
            .search_strategy(Arc::clone(strategy) as Arc<dyn SearchStrategy>)
            .build()
    }

    #[tokio::test]
    async fn indexes_writes_and_delegates_search_to_a_search_strategy_from_config() {
        let (_dir, base, _storage) = setup();
        let strategy = Arc::new(Recording::default());
        let configured = LocalFileStorage::with_config(&base, config(&strategy)).unwrap();
        configured.write("a.txt", &[1]).await.unwrap();
        assert_eq!(*strategy.indexed.lock().unwrap(), [("a.txt".to_owned(), vec![1])]);
        assert_eq!(
            configured.search("query").await.unwrap(),
            [StorageSearchResult::new("hit.txt", 1.0)]
        );
        assert_eq!(*strategy.queries.lock().unwrap(), ["query"]);
    }

    #[tokio::test]
    async fn carries_a_search_strategy_from_config_through_namespace() {
        let (_dir, base, _storage) = setup();
        let strategy = Arc::new(Recording::default());
        let configured = LocalFileStorage::with_config(&base, config(&strategy)).unwrap();
        configured.search("one").await.unwrap();
        configured.namespace("sub").unwrap().search("two").await.unwrap();
        assert_eq!(*strategy.queries.lock().unwrap(), ["one", "two"]);
    }

    #[tokio::test]
    async fn uses_the_keyword_scan_without_a_strategy() {
        let (_dir, _base, storage) = setup();
        storage.write("auth.md", b"OAuth2 authentication flow").await.unwrap();
        let results = storage.search("authentication").await.unwrap();
        assert_eq!(results.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), ["auth.md"]);
    }

    #[tokio::test]
    async fn reports_read_failures_other_than_a_missing_key() {
        let (_dir, base, storage) = setup();
        std::fs::create_dir_all(base.join("folder")).unwrap();
        let error = storage.read("folder").await.unwrap_err();
        assert_eq!(error.to_string(), "Failed to read 'folder' from local storage");
        assert_eq!(error.name(), "StorageError");
    }

    /// Records the paths it writes, and reads and lists through the host.
    #[derive(Default)]
    struct WriteRecording {
        writes: Mutex<Vec<String>>,
        missing_reads: bool,
    }

    #[async_trait]
    impl Sandbox for WriteRecording {
        fn execute_streaming(
            &self,
            command: &str,
            options: crate::sandbox::ExecuteOptions,
        ) -> crate::sandbox::ExecutionStream {
            crate::sandbox::default_sandbox().execute_streaming(command, options)
        }

        fn execute_code_streaming(
            &self,
            code: &str,
            language: &str,
            options: crate::sandbox::ExecuteOptions,
        ) -> crate::sandbox::ExecutionStream {
            crate::sandbox::default_sandbox().execute_code_streaming(code, language, options)
        }

        async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
            if self.missing_reads {
                return Err(crate::SandboxPathNotFoundError::new(path).into());
            }
            crate::sandbox::default_sandbox().read_file(path).await
        }

        async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
            self.writes.lock().unwrap().push(path.to_owned());
            crate::sandbox::default_sandbox().write_file(path, content).await
        }

        async fn remove_file(&self, path: &str) -> Result<()> {
            crate::sandbox::default_sandbox().remove_file(path).await
        }

        async fn list_files(&self, path: &str) -> Result<Vec<crate::sandbox::FileInfo>> {
            crate::sandbox::default_sandbox().list_files(path).await
        }
    }

    /// A strategy that declares it needs the host filesystem.
    struct HostIndexStrategy;

    #[async_trait]
    impl SearchStrategy for HostIndexStrategy {
        fn requires_host_fs(&self) -> bool {
            true
        }

        fn name(&self) -> &str {
            "HostIndexStrategy"
        }

        async fn search(&self, _storage: &dyn Storage, _query: &str) -> Result<Vec<StorageSearchResult>> {
            Ok(Vec::new())
        }
    }

    fn sandboxed(
        base: &Path,
        sandbox: Arc<dyn Sandbox>,
        strategy: Option<Arc<dyn SearchStrategy>>,
    ) -> Result<LocalFileStorage> {
        LocalFileStorage::with_config(
            base,
            LocalFileStorageConfig {
                sandbox: Some(sandbox),
                search_strategy: strategy,
            },
        )
    }

    #[tokio::test]
    async fn routes_io_through_a_sandbox_from_config() {
        let (_dir, base, _storage) = setup();
        let sandbox = Arc::new(WriteRecording::default());
        let configured = sandboxed(&base, sandbox.clone(), None).unwrap();
        configured.write("a.txt", &[1]).await.unwrap();
        assert_eq!(*sandbox.writes.lock().unwrap(), [format!("{}/a.txt", base.display())]);
        assert_eq!(configured.read("a.txt").await.unwrap(), Some(vec![1]));
        assert_eq!(configured.list("").await.unwrap(), ["a.txt"]);
        configured.delete("a.txt").await.unwrap();
        configured.delete("a.txt").await.unwrap();
        assert_eq!(configured.read("a.txt").await.unwrap(), None);
    }

    #[tokio::test]
    async fn treats_sandbox_path_not_found_error_from_the_sandbox_as_a_missing_key() {
        let (_dir, base, _storage) = setup();
        let sandbox = Arc::new(WriteRecording {
            missing_reads: true,
            ..WriteRecording::default()
        });
        let storage = sandboxed(&base, sandbox, None).unwrap();
        assert_eq!(storage.read("missing.txt").await.unwrap(), None);
        assert!(storage.list("no-such-dir/").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn accepts_a_sandbox_and_search_strategy() {
        let (_dir, base, _storage) = setup();
        let sandbox = Arc::new(WriteRecording::default());
        let strategy = Arc::new(Recording::default());
        let storage = sandboxed(&base, sandbox.clone(), Some(strategy.clone())).unwrap();
        storage.write("a.txt", &[1]).await.unwrap();
        assert_eq!(sandbox.writes.lock().unwrap().len(), 1);
        storage.search("query").await.unwrap();
        assert_eq!(*strategy.queries.lock().unwrap(), ["query"]);
    }

    #[tokio::test]
    async fn carries_a_search_strategy_from_config_through_for_sandbox_and_namespace() {
        let (_dir, base, _storage) = setup();
        let strategy = Arc::new(Recording::default());
        let configured = LocalFileStorage::with_config(&base, config(&strategy)).unwrap();
        configured
            .for_sandbox(Arc::new(NotASandboxLocalEnvironment::new()))
            .search("one")
            .await
            .unwrap();
        configured.namespace("sub").unwrap().search("two").await.unwrap();
        assert_eq!(*strategy.queries.lock().unwrap(), ["one", "two"]);
    }

    #[test]
    fn rejects_a_host_filesystem_strategy_passed_with_a_sandbox_in_config() {
        let error = sandboxed(
            Path::new("/tmp/x"),
            Arc::new(NotASandboxLocalEnvironment::new()),
            Some(Arc::new(HostIndexStrategy)),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "HostIndexStrategy requires host filesystem access and cannot be used with a sandbox"
        );
    }

    #[tokio::test]
    async fn accepts_a_sandbox_safe_strategy_passed_with_a_sandbox() {
        let (_dir, base, _storage) = setup();
        let strategy = Arc::new(Recording::default());
        let storage = sandboxed(
            &base,
            Arc::new(NotASandboxLocalEnvironment::new()),
            Some(strategy.clone()),
        )
        .unwrap();
        storage.search("query").await.unwrap();
        assert_eq!(strategy.queries.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn drops_a_host_filesystem_strategy_in_for_sandbox_and_falls_back_to_keyword_search() {
        let (_dir, base, _storage) = setup();
        let host = LocalFileStorage::with_config(
            &base,
            LocalFileStorageConfig::builder()
                .search_strategy(Arc::new(HostIndexStrategy) as Arc<dyn SearchStrategy>)
                .build(),
        )
        .unwrap();
        let (bound, logs) =
            crate::test_support::capture_logs(|| host.for_sandbox(Arc::new(NotASandboxLocalEnvironment::new())));
        assert!(logs.contains(
            "strategy=<HostIndexStrategy> | search strategy requires host filesystem access and is not compatible with sandboxed storage | falling back to keyword search"
        ), "{logs}");
        bound.write("auth.md", b"OAuth2 authentication flow").await.unwrap();
        let results = bound.search("authentication").await.unwrap();
        assert_eq!(results.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), ["auth.md"]);
    }

    #[tokio::test]
    async fn keeps_a_sandbox_safe_strategy_in_for_sandbox() {
        let (_dir, base, _storage) = setup();
        let strategy = Arc::new(Recording::default());
        let bound = LocalFileStorage::with_config(&base, config(&strategy))
            .unwrap()
            .for_sandbox(Arc::new(NotASandboxLocalEnvironment::new()));
        bound.search("query").await.unwrap();
        assert_eq!(strategy.queries.lock().unwrap().len(), 1);
    }

    #[test]
    fn returns_storage_already_bound_to_a_sandbox_unchanged() {
        let sandbox: Arc<dyn Sandbox> = Arc::new(NotASandboxLocalEnvironment::new());
        let bound = LocalFileStorage::new("/tmp/x").for_sandbox(sandbox.clone());
        let again = bound.for_sandbox(Arc::new(NotASandboxLocalEnvironment::new()));
        assert!(Arc::ptr_eq(again.sandbox.as_ref().unwrap(), &sandbox));
    }

    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                found.extend(files_under(&path));
            } else {
                found.push(path);
            }
        }
        found
    }

    #[tokio::test]
    async fn keeps_every_write_under_the_base_directory() {
        let (dir, base, storage) = setup();
        for key in [
            "/etc/abs_probe",
            "./dot",
            "a/./b",
            "a/.../b",
            "~/home_probe",
            "C:/win",
            "C:x",
        ] {
            let written = storage.write(key, b"v").await;
            if cfg!(windows) && key.starts_with("C:") {
                assert!(written.is_err(), "{key}");
            } else {
                written.unwrap();
            }
        }
        for key in ["../x", "a/../../x", "a\\b", ".", ".."] {
            assert!(storage.write(key, b"v").await.is_err(), "{key}");
        }
        let outside: Vec<PathBuf> = files_under(dir.path())
            .into_iter()
            .filter(|path| !path.starts_with(&base))
            .collect();
        assert!(outside.is_empty(), "{outside:?}");
    }

    #[test]
    fn rejects_a_segment_that_is_not_one_plain_name() {
        let base = Path::new("base");
        assert_eq!(
            join_segments(base, "a/./b", "key", "a/./b").unwrap(),
            Path::new("base/a/./b")
        );
        if cfg!(windows) {
            for key in ["C:/win", "C:x"] {
                let error = join_segments(base, key, "key", key).unwrap_err();
                assert!(
                    error.to_string().starts_with(&format!("Invalid storage key '{key}'")),
                    "{error}"
                );
            }
        }
    }
}
