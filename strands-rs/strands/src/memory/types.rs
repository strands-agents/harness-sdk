//! Memory types.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::extraction::ExtractionConfig;
use crate::error::{BoxError, Error, Result};
use crate::injection::InjectionTrigger;
use crate::tools::ToolSource;
use crate::types::{JsonObject, JsonValue, Message, Toggle, toggle_from_config};

/// One memory entry retrieved from or stored to a memory store (`MemoryEntry`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MemoryEntry {
    /// The text of the entry.
    pub content: String,
    /// The store the entry came from; [`MemoryManager::search`](super::MemoryManager::search)
    /// sets it, stores need not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_name: Option<String>,
    /// Metadata such as a score, source, id or timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
}

impl MemoryEntry {
    /// An entry with content only.
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            ..Self::default()
        }
    }

    /// Sets the store name.
    #[must_use]
    pub fn with_store_name(mut self, store_name: impl Into<String>) -> Self {
        self.store_name = Some(store_name.into());
        self
    }

    /// Sets the metadata.
    #[must_use]
    pub fn with_metadata(mut self, metadata: JsonObject) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

/// Options for [`MemoryStore::search`] (`SearchOptions`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, bon::Builder)]
pub struct SearchOptions {
    /// Maximum number of results to return from this store.
    pub max_search_results: Option<usize>,
}

/// Context the manager passes to [`MemoryStore::add_messages`] with a batch
/// (`AddMessagesContext`). Fields may be added without changing the method.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct AddMessagesContext {
    /// One identity per message (`sequence_numbers[i]` identifies `messages[i]`). A retried batch
    /// reuses the numbers, so a store can build an idempotency key that survives retries. Numbers
    /// increase with order but may have gaps, and restart at 0 each agent run.
    pub sequence_numbers: Option<Vec<u64>>,
}

impl AddMessagesContext {
    /// A context with sequence numbers.
    #[must_use]
    pub fn with_sequence_numbers(mut self, sequence_numbers: Vec<u64>) -> Self {
        self.sequence_numbers = Some(sequence_numbers);
        self
    }
}

/// A memory store backend (`MemoryStore`, with the declarative `MemoryStoreConfig` properties as
/// methods).
///
/// Every store is searchable. A writable store also accepts writes through [`add`](Self::add),
/// [`add_messages`](Self::add_messages) or both; each write method has an `implements_*` flag the
/// manager reads at construction, so set the flag of every write method you implement.
///
/// ```
/// use strands::memory::{MemoryEntry, MemoryStore, SearchOptions};
///
/// struct Notes;
///
/// #[strands::async_trait]
/// impl MemoryStore for Notes {
///     fn name(&self) -> &str {
///         "notes"
///     }
///
///     fn writable(&self) -> bool {
///         false
///     }
///
///     async fn search(&self, _query: &str, _options: SearchOptions) -> strands::Result<Vec<MemoryEntry>> {
///         Ok(vec![MemoryEntry::new("User prefers dark mode")])
///     }
/// }
/// ```
#[async_trait]
pub trait MemoryStore: Send + Sync + 'static {
    /// The store's unique name, used to target it in the search and add tools.
    fn name(&self) -> &str;

    /// What the store contains; included in the tool descriptions.
    fn description(&self) -> Option<&str> {
        None
    }

    /// The default maximum number of results per search when the caller passes none.
    fn max_search_results(&self) -> Option<usize> {
        None
    }

    /// Whether the store accepts writes. A writable store implements at least one write method.
    fn writable(&self) -> bool;

    /// Automatic extraction for this writable store; `None` is off. The defaults run every 5
    /// turns: a store implementing `add_messages` gets the raw messages (server-side extraction),
    /// one implementing only `add` gets facts a [`ModelExtractor`](super::ModelExtractor) distills
    /// with `agent.aux_model`.
    fn extraction(&self) -> Option<ExtractionConfig> {
        None
    }

    /// Searches the store, most relevant first.
    async fn search(&self, query: &str, options: SearchOptions) -> Result<Vec<MemoryEntry>>;

    /// Whether the store implements [`add`](Self::add).
    fn implements_add(&self) -> bool {
        false
    }

    /// Adds one piece of content (`add`); used by the `add_memory` tool, [`MemoryManager::add`]
    /// and extraction with an extractor. Extraction writes are at-least-once, so tolerate
    /// duplicates. The returned value is store-specific and not read by the manager.
    ///
    /// [`MemoryManager::add`]: super::MemoryManager::add
    async fn add(&self, content: &str, metadata: Option<JsonObject>) -> Result<JsonValue> {
        let _ = (content, metadata);
        Err(Error::other(format!("store '{}' does not implement add", self.name())))
    }

    /// Whether the store implements [`add_messages`](Self::add_messages).
    fn implements_add_messages(&self) -> bool {
        false
    }

    /// Ingests a batch of conversation messages with their roles (`addMessages`): the sink for
    /// extraction without an extractor.
    async fn add_messages(&self, messages: &[Message], context: AddMessagesContext) -> Result<JsonValue> {
        let _ = (messages, context);
        Err(Error::other(format!(
            "store '{}' does not implement addMessages",
            self.name()
        )))
    }

    /// Async setup that must succeed before the agent runs; the manager calls it in `init_agent`.
    async fn initialize(&self) -> Result<()> {
        Ok(())
    }

    /// Store-specific tools the manager registers next to its own.
    fn get_tools(&self) -> Vec<ToolSource> {
        Vec::new()
    }
}

toggle_from_config!(
    MemoryToolConfig,
    MemoryAddToolConfig,
    MemoryInjectionConfig,
    ExtractionConfig
);

/// Options for [`MemoryManager::search`](super::MemoryManager::search) (`MemorySearchOptions`).
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct MemorySearchOptions {
    /// Maximum number of results per store, forwarded to every store.
    pub max_search_results: Option<usize>,
    /// Only these stores, by name; `None` searches all.
    pub stores: Option<Vec<String>>,
}

/// Options for [`MemoryManager::add`](super::MemoryManager::add) (`MemoryAddOptions`).
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct MemoryAddOptions {
    /// Metadata stored with the entry.
    pub metadata: Option<JsonObject>,
    /// Only these writable stores, by name; `None` writes to all writable stores.
    pub stores: Option<Vec<String>>,
}

/// A custom name or description for a memory tool (`MemoryToolConfig`).
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct MemoryToolConfig {
    /// The tool name.
    #[builder(into)]
    pub name: Option<String>,
    /// The tool description.
    #[builder(into)]
    pub description: Option<String>,
}

/// Configuration of the `add_memory` tool (`MemoryAddToolConfig`).
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct MemoryAddToolConfig {
    /// The tool name. Defaults to `add_memory`.
    #[builder(into)]
    pub name: Option<String>,
    /// The tool description.
    #[builder(into)]
    pub description: Option<String>,
    /// The writable stores the tool may write to, by name (pass `store.name()` for an instance).
    /// Each must be a configured writable store that implements `add`. `None` allows all.
    pub stores: Option<Vec<String>>,
    /// Whether the tool waits for the writes before returning. Defaults to `true`, returning
    /// `{"stored": n}` or the failure; `false` returns `{"accepted": n}` once the writes are
    /// dispatched and logs failures.
    pub wait_for_writes: Option<bool>,
}

type QueryFn = Arc<dyn Fn(&[Message]) -> std::result::Result<Option<String>, BoxError> + Send + Sync>;
type FormatFn = Arc<dyn Fn(&[MemoryEntry]) -> std::result::Result<String, BoxError> + Send + Sync>;

/// Derives the injection search query from the conversation (`MemoryInjectionConfig.query`):
/// `Ok(None)` or blank skips the call, an error fails open.
#[derive(Clone)]
pub struct MemoryQuery(pub(crate) QueryFn);

impl MemoryQuery {
    /// Wraps a query callback.
    pub fn new(
        query: impl Fn(&[Message]) -> std::result::Result<Option<String>, BoxError> + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(query))
    }
}

impl fmt::Debug for MemoryQuery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MemoryQuery(..)")
    }
}

/// Renders retrieved entries into the injected text (`MemoryInjectionConfig.format`); an error
/// fails open. A custom format that emits markup does its own escaping.
#[derive(Clone)]
pub struct MemoryFormat(pub(crate) FormatFn);

impl MemoryFormat {
    /// Wraps a format callback.
    pub fn new(
        format: impl Fn(&[MemoryEntry]) -> std::result::Result<String, BoxError> + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(format))
    }
}

impl fmt::Debug for MemoryFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MemoryFormat(..)")
    }
}

/// Memory context injection (`MemoryInjectionConfig`): before a model call the manager searches
/// memory and folds the top results into that call's input only; they never enter the stored
/// conversation or session.
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct MemoryInjectionConfig {
    /// When injection runs. Defaults to [`InjectionTrigger::UserTurn`].
    pub trigger: Option<InjectionTrigger>,
    /// Maximum number of entries retrieved and injected per call. Defaults to 5. With several
    /// stores the results are concatenated in store order, with no cross-store ranking.
    pub max_entries: Option<usize>,
    /// Derives the query. Defaults to the latest user message's text on a user turn, otherwise
    /// the most recent assistant message's text.
    pub query: Option<MemoryQuery>,
    /// Renders the entries. Defaults to a `<memory>` block with one escaped
    /// `<entry source="STORE">` per result.
    pub format: Option<MemoryFormat>,
}

/// Configuration for the [`MemoryManager`](super::MemoryManager) (`MemoryManagerConfig`).
///
/// The `Toggle` options take `true`/`false` or a config through `into()`.
#[derive(Clone, Default, bon::Builder)]
pub struct MemoryManagerConfig {
    /// The memory stores; at least one.
    #[builder(default)]
    pub stores: Vec<Arc<dyn MemoryStore>>,
    /// The `search_memory` tool. Defaults to on.
    #[builder(into)]
    pub search_tool_config: Option<Toggle<MemoryToolConfig>>,
    /// The `add_memory` tool. Defaults to off; `true` writes to all writable stores that
    /// implement `add`.
    #[builder(into)]
    pub add_tool_config: Option<Toggle<MemoryAddToolConfig>>,
    /// Memory context injection. Defaults to on (`trigger` user turn, 5 entries, the adaptive
    /// query and the `<memory>` format).
    #[builder(into)]
    pub injection: Option<Toggle<MemoryInjectionConfig>>,
}

impl fmt::Debug for MemoryManagerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryManagerConfig")
            .field(
                "stores",
                &self.stores.iter().map(|store| store.name()).collect::<Vec<_>>(),
            )
            .field("search_tool_config", &self.search_tool_config)
            .field("add_tool_config", &self.add_tool_config)
            .field("injection", &self.injection)
            .finish()
    }
}

/// Several failures reported as one: the message names what failed and
/// [`errors`](Self::errors) holds each cause.
#[derive(Debug)]
#[non_exhaustive]
pub struct AggregateError {
    message: String,
    errors: Vec<Error>,
}

impl AggregateError {
    pub(crate) fn new(errors: Vec<Error>, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            errors,
        }
    }

    /// The individual failures.
    #[must_use]
    pub fn errors(&self) -> &[Error] {
        &self.errors
    }

    pub(crate) fn into_errors(self) -> Vec<Error> {
        self.errors
    }
}

impl fmt::Display for AggregateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AggregateError {}
