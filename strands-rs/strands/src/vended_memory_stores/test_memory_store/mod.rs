//! A zero-infrastructure memory store: [`TestMemoryStore`] keeps entries in memory and, by
//! default, in a local JSON file. Use it for prototyping and tests.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde_json::json;
use uuid::Uuid;

use crate::clock::Clock;
use crate::error::{Error, Result};
use crate::memory::{ExtractionConfig, MemoryEntry, MemoryStore, SearchOptions, Toggle};
use crate::storage::search::keyword::{token_overlap_score, tokenize};
use crate::storage::{InMemoryStorage, LocalFileStorage, Storage};
use crate::types::{JsonObject, JsonValue};

#[cfg(test)]
mod tests;

const DEFAULT_MAX_SEARCH_RESULTS: usize = 10;
/// The metadata key holding a result's token-overlap score.
const RELEVANCE_SCORE_KEY: &str = "_relevanceScore";

/// Configuration for [`TestMemoryStore`] (`TestMemoryStoreConfig`). The builder takes the name
/// first: `TestMemoryStoreConfig::builder("notes").persist(false).build()`.
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct TestMemoryStoreConfig {
    /// The store name; not blank.
    #[builder(start_fn, into)]
    pub name: String,
    /// What the store contains.
    #[builder(into)]
    pub description: Option<String>,
    /// The default maximum number of results per search; at least 1. Defaults to 10.
    pub max_search_results: Option<usize>,
    /// Whether the store accepts writes. Defaults to `true`.
    pub writable: Option<bool>,
    /// Automatic extraction.
    pub extraction: Option<Toggle<ExtractionConfig>>,
    /// Whether entries survive the process in a JSON file. Defaults to `true`; `false` keeps
    /// them in memory only.
    pub persist: Option<bool>,
    /// The JSON file backing the store. Defaults to `~/.strands/memory/<sanitized-name>.json`;
    /// ignored when `persist` is `false`.
    #[builder(into)]
    pub path: Option<PathBuf>,
}

impl TestMemoryStoreConfig {
    /// A config with the store name and the defaults.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }
}

/// What [`TestMemoryStore::add`] returns (`TestMemoryAddResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TestMemoryAddResult {
    /// The id of the stored (or already present) record.
    pub id: String,
}

/// A store name as a safe single path segment, the same in every Strands SDK: `..`,
/// slashes and every other character outside `[A-Za-z0-9_.-]` become `_`, one per UTF-16 unit.
fn sanitize_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.replace("..", "_").chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
            out.push(c);
            continue;
        }
        for _ in 0..c.len_utf16() {
            out.push('_');
        }
    }
    out
}

/// A memory store that keeps entries in memory and by default persists them to a local JSON file
/// (`TestMemoryStore`). Recall is lexical: results rank by how many query tokens an entry shares,
/// most recent first on ties. Each `add` rewrites the whole file, so it fits modest volumes.
///
/// The file format is shared with the other Strands SDKs: an array of records with `id`,
/// `content`, `createdAt` and an optional `metadata`, so each SDK reads the others' files.
pub struct TestMemoryStore {
    name: String,
    description: Option<String>,
    max_search_results: Option<usize>,
    writable: bool,
    extraction: Option<ExtractionConfig>,
    persist: bool,
    path: Option<PathBuf>,
    resolved: OnceLock<(Arc<dyn Storage>, String)>,
    write_chain: tokio::sync::Mutex<()>,
    clock: Clock,
}

impl fmt::Debug for TestMemoryStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TestMemoryStore")
            .field("name", &self.name)
            .field("persist", &self.persist)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

/// The directory of the default backing files: `<home>/.strands/memory`.
fn default_dir(home: &Path) -> PathBuf {
    home.join(".strands").join("memory")
}

fn invalid_file(key: &str, reason: &str) -> Error {
    Error::other(format!("TestMemoryStore: invalid backing file {key}: {reason}"))
}

/// Checks one record's shape; a present, non-null `metadata` must be an object (`null` counts
/// as absent, as in the Python store).
fn check_record(record: &JsonValue, key: &str) -> Result<()> {
    let is_string = |field: &str| record.get(field).is_some_and(JsonValue::is_string);
    if !record.is_object() || !is_string("id") || !is_string("content") || !is_string("createdAt") {
        return Err(invalid_file(
            key,
            "each record must have string 'id', 'content', and 'createdAt' fields",
        ));
    }
    match record.get("metadata") {
        None | Some(JsonValue::Null | JsonValue::Object(_)) => Ok(()),
        Some(_) => Err(invalid_file(
            key,
            "a record's 'metadata', when present, must be a JSON object",
        )),
    }
}

fn field<'a>(record: &'a JsonValue, name: &str) -> &'a str {
    record.get(name).and_then(JsonValue::as_str).unwrap_or_default()
}

impl TestMemoryStore {
    /// Creates the store; nothing touches the filesystem until the first search or add.
    ///
    /// # Errors
    ///
    /// A blank name (`TestMemoryStore: name must not be empty.`), `max_search_results` below 1
    /// (`TestMemoryStore: maxSearchResults must be at least 1.`) or an empty path
    /// (`TestMemoryStore: path must not be empty.`).
    pub fn new(config: TestMemoryStoreConfig) -> Result<Self> {
        if config.name.trim().is_empty() {
            return Err(Error::other("TestMemoryStore: name must not be empty."));
        }
        if config.max_search_results.is_some_and(|max| max < 1) {
            return Err(Error::other("TestMemoryStore: maxSearchResults must be at least 1."));
        }
        if config
            .path
            .as_ref()
            .is_some_and(|path| path.as_os_str().to_string_lossy().trim().is_empty())
        {
            return Err(Error::other("TestMemoryStore: path must not be empty."));
        }
        Ok(Self {
            name: config.name,
            description: config.description,
            max_search_results: config.max_search_results,
            writable: config.writable.unwrap_or(true),
            extraction: config.extraction.and_then(Toggle::into_option),
            persist: config.persist.unwrap_or(true),
            path: config.path,
            resolved: OnceLock::new(),
            write_chain: tokio::sync::Mutex::new(()),
            clock: Clock::system(),
        })
    }

    /// The backend and key (`_resolve`): in memory, the file at `path`, or
    /// `~/.strands/memory/<name>.json`.
    fn resolve(&self) -> &(Arc<dyn Storage>, String) {
        self.resolved.get_or_init(|| {
            let file_name = format!("{}.json", sanitize_name(&self.name));
            if !self.persist {
                return (Arc::new(InMemoryStorage::new()), file_name);
            }
            if let Some(path) = &self.path {
                let parent = path.parent().unwrap_or_else(|| Path::new(""));
                let key = path
                    .file_name()
                    .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
                return (Arc::new(LocalFileStorage::new(parent)), key);
            }
            let home = std::env::home_dir().unwrap_or_default();
            (Arc::new(LocalFileStorage::new(default_dir(&home))), file_name)
        })
    }

    /// Reads and checks the backing file; a missing file is an empty store (`_read`).
    async fn read(&self) -> Result<Vec<JsonValue>> {
        let (storage, key) = self.resolve();
        let Some(bytes) = storage.read(key).await? else {
            return Ok(Vec::new());
        };
        let text = String::from_utf8_lossy(&bytes);
        let parsed: JsonValue = serde_json::from_str(&text).map_err(|error| {
            Error::other(InvalidJson {
                key: key.clone(),
                source: error,
            })
        })?;
        let JsonValue::Array(records) = parsed else {
            return Err(invalid_file(key, "expected a JSON array of records"));
        };
        for record in &records {
            check_record(record, key)?;
        }
        Ok(records)
    }

    async fn write(&self, records: &[JsonValue]) -> Result<()> {
        let (storage, key) = self.resolve();
        let bytes = serde_json::to_vec_pretty(records)?;
        storage.write(key, &bytes).await
    }

    /// Searches entries by token overlap with the query, most recent first on ties (`search`).
    /// Each result's metadata holds `_relevanceScore`; a query without tokens returns nothing.
    ///
    /// # Errors
    ///
    /// `max_search_results` below 1, a malformed backing file or a backend failure.
    pub async fn search(&self, query: &str, options: SearchOptions) -> Result<Vec<MemoryEntry>> {
        if options.max_search_results.is_some_and(|max| max < 1) {
            return Err(Error::other("TestMemoryStore: maxSearchResults must be at least 1."));
        }
        let limit = options
            .max_search_results
            .or(self.max_search_results)
            .unwrap_or(DEFAULT_MAX_SEARCH_RESULTS);
        let query_tokens = tokenize(query);
        if query_tokens.is_empty() {
            return Ok(Vec::new());
        }
        let records = self.read().await?;
        let mut scored: Vec<(JsonValue, usize)> = records
            .into_iter()
            .filter_map(|record| {
                let score = token_overlap_score(&query_tokens, field(&record, "content"));
                (score > 0).then_some((record, score))
            })
            .collect();
        scored.sort_by(|(left, left_score), (right, right_score)| {
            right_score
                .cmp(left_score)
                .then_with(|| field(right, "createdAt").cmp(field(left, "createdAt")))
        });
        Ok(scored
            .into_iter()
            .take(limit)
            .map(|(record, score)| {
                let mut metadata = record
                    .get("metadata")
                    .and_then(JsonValue::as_object)
                    .cloned()
                    .unwrap_or_default();
                metadata.insert(RELEVANCE_SCORE_KEY.into(), json!(score));
                MemoryEntry::new(field(&record, "content")).with_metadata(metadata)
            })
            .collect())
    }

    /// Adds content (`add`). Identical content (after trimming) is stored once: a repeat returns
    /// the existing record's id, so extraction retries never accumulate duplicates. Concurrent
    /// adds on one instance are serialized.
    ///
    /// # Errors
    ///
    /// A store that is not writable, blank content, a malformed backing file or a backend failure.
    pub async fn add(&self, content: &str, metadata: Option<JsonObject>) -> Result<TestMemoryAddResult> {
        if !self.writable {
            return Err(Error::other(
                "TestMemoryStore: store is not writable. Set writable: true in config to enable add().",
            ));
        }
        if content.trim().is_empty() {
            return Err(Error::other("TestMemoryStore: content must not be empty."));
        }
        let _chain = self.write_chain.lock().await;
        let mut records = self.read().await?;
        let normalized = content.trim();
        if let Some(existing) = records
            .iter()
            .find(|record| field(record, "content").trim() == normalized)
        {
            return Ok(TestMemoryAddResult {
                id: field(existing, "id").to_owned(),
            });
        }
        let id = Uuid::now_v7().to_string();
        let mut record = JsonObject::new();
        record.insert("id".into(), JsonValue::from(id.clone()));
        record.insert("content".into(), JsonValue::from(content));
        record.insert("createdAt".into(), JsonValue::from(self.clock.now_iso()));
        if let Some(metadata) = metadata {
            record.insert("metadata".into(), JsonValue::Object(metadata));
        }
        records.push(JsonValue::Object(record));
        self.write(&records).await?;
        Ok(TestMemoryAddResult { id })
    }
}

/// The backing file is not JSON.
#[derive(Debug)]
struct InvalidJson {
    key: String,
    source: serde_json::Error,
}

impl fmt::Display for InvalidJson {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TestMemoryStore: invalid JSON in {}", self.key)
    }
}

impl std::error::Error for InvalidJson {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

#[async_trait]
impl MemoryStore for TestMemoryStore {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    fn max_search_results(&self) -> Option<usize> {
        self.max_search_results
    }

    fn writable(&self) -> bool {
        self.writable
    }

    fn extraction(&self) -> Option<ExtractionConfig> {
        self.extraction.clone()
    }

    async fn search(&self, query: &str, options: SearchOptions) -> Result<Vec<MemoryEntry>> {
        Self::search(self, query, options).await
    }

    fn implements_add(&self) -> bool {
        true
    }

    async fn add(&self, content: &str, metadata: Option<JsonObject>) -> Result<JsonValue> {
        let result = Self::add(self, content, metadata).await?;
        Ok(json!({"id": result.id}))
    }
}
