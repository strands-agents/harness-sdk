//! A file-based memory store: [`FileMemoryStore`] keeps knowledge as markdown files under a
//! `memory/<name>` storage namespace and searches them by keyword.
//!
//! ```
//! use std::sync::Arc;
//! use strands::memory::{MemoryStore, SearchOptions};
//! use strands::storage::InMemoryStorage;
//! use strands::vended_memory_stores::file_memory_store::{FileMemoryStore, FileMemoryStoreConfig};
//!
//! # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
//! let store = FileMemoryStore::new(FileMemoryStoreConfig {
//!     storage: Some(Arc::new(InMemoryStorage::new())),
//!     ..FileMemoryStoreConfig::new("agent-memory")
//! })?;
//! store.add("# User preferences\nPrefers dark mode", None).await?;
//! let entries = store.search("dark mode", SearchOptions::default()).await?;
//! assert_eq!(entries[0].content, "# User preferences\nPrefers dark mode");
//! # Ok::<(), strands::Error>(())
//! # }).unwrap();
//! ```

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::json;

use crate::error::Result;
use crate::memory::{
    ExtractionConfig, ExtractionResult, ExtractionTrigger, Extractor, ExtractorContext, MemoryEntry,
    MemoryMessageFilter, MemoryStore, ModelExtractor, ModelExtractorOptions, SearchOptions, Toggle,
};
use crate::models::Model;
use crate::storage::search::{KeywordSearchStrategy, SearchStrategy};
use crate::storage::{LocalFileStorage, Storage, StorageSearchResult, normalize_key, resolve_namespace};
use crate::types::{JsonObject, JsonValue, Message, toggle_from_config};

#[cfg(test)]
mod tests;

/// Overridable framing for what to extract.
const DEFAULT_EXTRACTION_GUIDANCE: &str =
    "You extract durable facts worth remembering across future conversations from a transcript.";

/// The heading-first layout `add` slugifies to group facts by topic; always appended after the
/// guidance so an overridden prompt keeps append-on-topic.
const EXTRACTION_CONTRACT: &str = r##"Group related facts into a single entry. The first line is a markdown heading (e.g. "# User preferences", "# Project setup", "# Team conventions"). Put each fact on its own line below the heading."##;

const DEFAULT_MAX_SEARCH_RESULTS: usize = 10;
const STORAGE_NAMESPACE: &str = "memory";

/// Extraction for a [`FileMemoryStore`] (`FileMemoryExtractionConfig`): the shared
/// [`ExtractionConfig`] fields plus the built-in key-aware extractor's model and prompt, which a
/// custom `extractor` replaces.
#[derive(Clone, Default, bon::Builder)]
pub struct FileMemoryExtractionConfig {
    /// When extraction runs. Defaults to every 5 turns.
    pub trigger: Option<Vec<Arc<dyn ExtractionTrigger>>>,
    /// A custom extractor; `model` and `system_prompt` are then ignored.
    pub extractor: Option<Arc<dyn Extractor>>,
    /// Block kinds to strip first.
    pub filter: Option<MemoryMessageFilter>,
    /// The model the built-in extractor uses. Resolution order: `this model > agent.aux_model >
    /// agent.model`.
    pub model: Option<Arc<dyn Model>>,
    /// What counts as a durable fact, replacing the default guidance; the store's output contract
    /// is always appended.
    #[builder(into)]
    pub system_prompt: Option<String>,
}

impl fmt::Debug for FileMemoryExtractionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileMemoryExtractionConfig")
            .field("filter", &self.filter)
            .field("system_prompt", &self.system_prompt)
            .finish_non_exhaustive()
    }
}

toggle_from_config!(FileMemoryExtractionConfig);

/// Configuration for [`FileMemoryStore`] (`FileMemoryStoreConfig`). The builder takes the name
/// first: `FileMemoryStoreConfig::builder("notes").writable(false).build()`.
#[derive(Clone, Default, bon::Builder)]
pub struct FileMemoryStoreConfig {
    /// The store name, used to target it in the memory tools and in its namespace.
    #[builder(start_fn, into)]
    pub name: String,
    /// What the store contains.
    #[builder(into)]
    pub description: Option<String>,
    /// The default maximum number of results per search. Defaults to 10.
    pub max_search_results: Option<usize>,
    /// Whether the store accepts writes. Defaults to `true`.
    pub writable: Option<bool>,
    /// The backend. Defaults to [`LocalFileStorage`] at `./.strands/`. Keys go under
    /// `memory/<name>/` unless the storage is already namespaced, so stores with distinct names
    /// can share one backend.
    pub storage: Option<Arc<dyn Storage>>,
    /// Automatic extraction; `true` uses the key-aware extractor with the defaults.
    pub extraction: Option<Toggle<FileMemoryExtractionConfig>>,
}

impl FileMemoryStoreConfig {
    /// A config with the store name and the defaults.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }
}

impl fmt::Debug for FileMemoryStoreConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileMemoryStoreConfig")
            .field("name", &self.name)
            .field("description", &self.description)
            .field("max_search_results", &self.max_search_results)
            .field("writable", &self.writable)
            .field("extraction", &self.extraction)
            .finish_non_exhaustive()
    }
}

/// The filename stem of a key, without `.md`.
fn basename(key: &str) -> &str {
    let filename = key.rsplit('/').next().unwrap_or(key);
    filename.strip_suffix(".md").unwrap_or(filename)
}

/// Unicode white space plus the byte-order mark.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Kebab-case slug of `text`, at most 50 characters (`slugify`).
fn slugify(text: &str) -> String {
    let kept: String = text
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-' || is_js_space(*c))
        .collect();
    let mut slug = String::new();
    let mut in_space = false;
    for c in kept.trim_matches(is_js_space).chars() {
        if is_js_space(c) {
            in_space = true;
            continue;
        }
        if in_space {
            slug.push('-');
            in_space = false;
        }
        slug.push(c);
    }
    slug.truncate(50);
    slug.trim_end_matches('-').to_owned()
}

/// Strips a leading markdown heading marker (`^#+\s*`).
fn strip_heading(line: &str) -> &str {
    let rest = line.trim_start_matches('#');
    if rest.len() == line.len() {
        return line;
    }
    rest.trim_start_matches(is_js_space)
}

/// An extractor that shows the model the store's existing topics so it reuses them.
struct KeyAwareExtractor {
    storage: Arc<dyn Storage>,
    model: Option<Arc<dyn Model>>,
    system_prompt: Option<String>,
}

#[async_trait]
impl Extractor for KeyAwareExtractor {
    async fn extract(&self, messages: &[Message], context: ExtractorContext) -> Result<Vec<ExtractionResult>> {
        let keys = self.storage.list("").await?;
        let headings: Vec<String> = keys.iter().map(|key| basename(key).replace('-', " ")).collect();
        let framing = self.system_prompt.as_deref().unwrap_or(DEFAULT_EXTRACTION_GUIDANCE);
        let mut prompt = format!("{framing}\n\n{EXTRACTION_CONTRACT}");
        if !headings.is_empty() {
            prompt.push_str(&format!(
                "\n\nExisting topics: {}. Reuse an existing topic heading when new facts belong to it.",
                headings.join(", ")
            ));
        }
        ModelExtractor::new(ModelExtractorOptions {
            model: self.model.clone(),
            system_prompt: Some(prompt),
        })
        .extract(messages, context)
        .await
    }
}

/// A memory store keeping knowledge as markdown files in a [`Storage`] (`FileMemoryStore`).
///
/// Entries live under `memory/<name>/` (`./.strands/memory/<name>/` with the default backend),
/// one file per topic named after the slug of its first line. Search delegates to the backend's
/// search, falling back to [`KeywordSearchStrategy`].
pub struct FileMemoryStore {
    name: String,
    writable: bool,
    description: Option<String>,
    max_search_results: Option<usize>,
    extraction: Option<ExtractionConfig>,
    storage: Arc<dyn Storage>,
    write_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl fmt::Debug for FileMemoryStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileMemoryStore")
            .field("name", &self.name)
            .field("writable", &self.writable)
            .finish_non_exhaustive()
    }
}

impl FileMemoryStore {
    /// Creates the store.
    ///
    /// # Errors
    ///
    /// A name that is not a valid storage namespace.
    pub fn new(config: FileMemoryStoreConfig) -> Result<Self> {
        let backend = config.storage.unwrap_or_else(|| Arc::new(LocalFileStorage::default()));
        let storage = resolve_namespace(backend, &format!("{STORAGE_NAMESPACE}/{}", config.name))?;
        let extraction = config
            .extraction
            .and_then(Toggle::into_option)
            .map(|extraction| resolve_extraction(extraction, &storage));
        Ok(Self {
            name: config.name,
            writable: config.writable.unwrap_or(true),
            description: config.description,
            max_search_results: config.max_search_results,
            extraction,
            storage,
            write_locks: Mutex::new(HashMap::new()),
        })
    }

    /// Searches the entries, ranked by relevance (`search`); each entry's metadata holds its
    /// `path` and `score`.
    ///
    /// # Errors
    ///
    /// The backend's search or list failing.
    pub async fn search(&self, query: &str, options: SearchOptions) -> Result<Vec<MemoryEntry>> {
        let max_results = options
            .max_search_results
            .or(self.max_search_results)
            .unwrap_or(DEFAULT_MAX_SEARCH_RESULTS);
        let results = match self.storage.search(query).await {
            Some(results) => {
                tracing::debug!("store=<{}>, path=<backend> | resolved search", self.name);
                results?
            }
            None => {
                tracing::debug!("store=<{}>, path=<keyword> | resolved search", self.name);
                KeywordSearchStrategy.search(self.storage.as_ref(), query).await?
            }
        };
        Ok(self.hydrate(results, max_results).await)
    }

    /// Entries for the ranked results, reading those without data; an unreadable hit is replaced
    /// by the next one.
    async fn hydrate(&self, results: Vec<StorageSearchResult>, max_results: usize) -> Vec<MemoryEntry> {
        let mut entries = Vec::new();
        for result in results {
            if entries.len() >= max_results {
                break;
            }
            let bytes = match result.data {
                Some(bytes) => Some(bytes),
                None => match self.storage.read(&result.key).await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        tracing::debug!("key=<{}> | skipped unreadable memory entry: {error}", result.key);
                        continue;
                    }
                },
            };
            let Some(bytes) = bytes else {
                continue;
            };
            let mut metadata = JsonObject::new();
            metadata.insert("path".into(), JsonValue::from(result.key.clone()));
            metadata.insert("score".into(), json!(result.score));
            entries.push(MemoryEntry::new(String::from_utf8_lossy(&bytes).trim()).with_metadata(metadata));
        }
        entries
    }

    /// Adds an entry (`add`): the file is named after the slug of the first line; when a file of
    /// that slug exists, the lines after the heading are appended to it. Returns the key written.
    ///
    /// # Errors
    ///
    /// The backend's read or write failing.
    pub async fn add(&self, content: &str, _metadata: Option<JsonObject>) -> Result<String> {
        let lines: Vec<&str> = content.split('\n').collect();
        let first_line = strip_heading(lines.first().copied().unwrap_or_default());
        let slug = slugify(first_line);
        let key = if slug.is_empty() {
            format!("entry-{}.md", now_millis())
        } else {
            format!("{slug}.md")
        };
        let canonical_key = normalize_key(&key)?.to_lowercase();
        let lock = self
            .write_locks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(canonical_key.clone())
            .or_default()
            .clone();
        // Writes to one key are serialized so a read-modify-write never loses an update.
        let guard = lock.lock().await;
        let merged = match self.storage.read(&canonical_key).await? {
            Some(existing) => {
                let existing = String::from_utf8_lossy(&existing).into_owned();
                let new_facts = lines.get(1..).unwrap_or_default().join("\n");
                let new_facts = new_facts.trim();
                if new_facts.is_empty() {
                    existing
                } else {
                    format!("{}\n{new_facts}", existing.trim_end())
                }
            }
            None => content.to_owned(),
        };
        let written = self.storage.write(&canonical_key, merged.as_bytes()).await;
        drop(guard);
        let mut locks = self.write_locks.lock().unwrap_or_else(PoisonError::into_inner);
        if locks.get(&canonical_key).is_some_and(|held| Arc::ptr_eq(held, &lock)) && Arc::strong_count(&lock) <= 2 {
            locks.remove(&canonical_key);
        }
        drop(locks);
        written?;
        Ok(canonical_key)
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

/// The store's extraction config: the key-aware extractor unless a custom one is set.
fn resolve_extraction(config: FileMemoryExtractionConfig, storage: &Arc<dyn Storage>) -> ExtractionConfig {
    let extractor = config.extractor.unwrap_or_else(|| {
        Arc::new(KeyAwareExtractor {
            storage: storage.clone(),
            model: config.model,
            system_prompt: config.system_prompt,
        })
    });
    ExtractionConfig {
        trigger: config.trigger,
        extractor: Some(extractor),
        filter: config.filter,
    }
}

#[async_trait]
impl MemoryStore for FileMemoryStore {
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
        Self::add(self, content, metadata).await.map(JsonValue::from)
    }
}
