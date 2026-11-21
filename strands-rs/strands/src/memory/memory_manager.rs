//! The memory manager plugin.

use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures::future::join_all;
use serde_json::json;
use tracing::Instrument;

use super::extraction::coordinator::{ExtractionBinding, ExtractionCoordinator};
use super::extraction::resolve::resolve_extraction_config;
use super::extraction::{ExtractionFire, ExtractionTriggerContext};
use super::types::{
    AggregateError, MemoryAddOptions, MemoryAddToolConfig, MemoryEntry, MemoryInjectionConfig, MemoryManagerConfig,
    MemorySearchOptions, MemoryStore, MemoryToolConfig, SearchOptions,
};
use crate::agent::LocalAgent;
use crate::error::{Error, Result};
use crate::hooks::MessageAddedEvent;
use crate::injection::xml::{escape_xml_attr, escape_xml_text};
use crate::injection::{InjectionTrigger, injection_middleware, is_user_turn};
use crate::plugins::Plugin;
use crate::telemetry::{
    EndMemoryAddSpanOptions, EndMemoryInjectSpanOptions, EndMemorySearchSpanOptions, StartMemoryAddSpanOptions,
    StartMemoryInjectSpanOptions, StartMemorySearchSpanOptions, Tracer,
};
use crate::tools::{FunctionTool, SchemaValidator, ToolError, ToolSource};
use crate::types::Toggle;
use crate::types::{ContentBlock, JsonValue, Message, Role};

const SEARCH_TOOL_DESCRIPTION: &str = "Search long-term memory for facts, preferences, or context from previous conversations. Use when you need background about the user or topic that may have been discussed before.";

const ADD_TOOL_DESCRIPTION: &str = "Add facts, preferences, or decisions to long-term memory so they are remembered across conversations. Use when the user shares something worth recalling later.";

/// Results per store when neither the caller nor the store sets a limit.
pub(crate) const DEFAULT_MAX_SEARCH_RESULTS: usize = 3;

/// Entries injected per model call by default: a store ranks by similarity, not usefulness, so a
/// small candidate set beats betting on the top hit.
const DEFAULT_MAX_ENTRIES: usize = 5;

const MEMORY_MANAGER_NAME: &str = "strands:memory-manager";

fn has_write_sink(store: &dyn MemoryStore) -> bool {
    store.implements_add() || store.implements_add_messages()
}

/// Why an `add` failed: a bad target, or the store writes that failed.
enum AddError {
    Target(Error),
    Writes(AggregateError),
}

impl From<AddError> for Error {
    fn from(error: AddError) -> Self {
        match error {
            AddError::Target(error) => error,
            AddError::Writes(error) => Error::other(error),
        }
    }
}

struct Inner {
    stores: Vec<Arc<dyn MemoryStore>>,
    /// Writable stores implementing `add`: the unscoped targets of [`MemoryManager::add`].
    add_stores: Vec<Arc<dyn MemoryStore>>,
    search_tool_config: Option<MemoryToolConfig>,
    add_tool: Option<(MemoryAddToolConfig, Vec<Arc<dyn MemoryStore>>)>,
    extraction: Vec<ExtractionBinding>,
    injection: Option<MemoryInjectionConfig>,
    coordinator: Mutex<Option<ExtractionCoordinator>>,
    /// The memory spans' tracer, shared with the extraction coordinator. Each manager has its own;
    /// spans still parent through the current span.
    tracer: Arc<Tracer>,
}

/// Cross-session memory for agents (`MemoryManager`): manages one or more [`MemoryStore`]s and
/// exposes the `search_memory` and `add_memory` tools, any tools the stores provide, memory
/// injection before model calls and automatic extraction.
///
/// A `MemoryManager` is a handle: clones share the stores, the configuration and the pending
/// extraction, so a clone kept before handing one to an agent can search or flush the same state.
///
/// ```
/// use std::sync::Arc;
/// use strands::memory::{MemoryManager, MemoryManagerConfig, MemoryStore};
/// use strands::vended_memory_stores::test_memory_store::{TestMemoryStore, TestMemoryStoreConfig};
///
/// # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
/// let store = TestMemoryStore::new(TestMemoryStoreConfig { persist: Some(false), ..TestMemoryStoreConfig::new("notes") })?;
/// store.add("User prefers dark mode", None).await?;
/// let manager = MemoryManager::new(MemoryManagerConfig {
///     stores: vec![Arc::new(store)],
///     ..Default::default()
/// })?;
/// let entries = manager.search("dark mode").await?;
/// assert_eq!(entries[0].content, "User prefers dark mode");
/// assert_eq!(entries[0].store_name.as_deref(), Some("notes"));
/// # Ok::<(), strands::Error>(())
/// # }).unwrap();
/// ```
#[derive(Clone)]
pub struct MemoryManager {
    inner: Arc<Inner>,
}

impl MemoryManager {
    /// Whether two handles share one manager.
    #[cfg(test)]
    pub(crate) fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl fmt::Debug for MemoryManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryManager")
            .field(
                "stores",
                &self.inner.stores.iter().map(|store| store.name()).collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

fn validate_store(store: &Arc<dyn MemoryStore>, seen: &mut HashSet<String>) -> Result<Option<ExtractionBinding>> {
    let name = store.name();
    if !seen.insert(name.to_owned()) {
        return Err(Error::other(format!("MemoryManager: duplicate store name '{name}'")));
    }
    if store.writable() && !has_write_sink(store.as_ref()) {
        return Err(Error::other(format!(
            "MemoryManager: store '{name}' is writable but has no add or addMessages method"
        )));
    }
    let Some(extraction) = store.extraction() else {
        return Ok(None);
    };
    if !store.writable() {
        return Err(Error::other(format!(
            "MemoryManager: store '{name}' has extraction config but is not writable"
        )));
    }
    let Some(config) = resolve_extraction_config(Some(extraction), store.as_ref()) else {
        return Ok(None);
    };
    if config.triggers.is_empty() {
        return Err(Error::other(format!(
            "MemoryManager: store '{name}' has extraction config but no triggers"
        )));
    }
    if config.extractor.is_some() && !store.implements_add() {
        return Err(Error::other(format!(
            "MemoryManager: store '{name}' has an extractor but no add method (extracted entries are written via add)"
        )));
    }
    if config.extractor.is_none() && !store.implements_add_messages() {
        return Err(Error::other(format!(
            "MemoryManager: store '{name}' has extraction config without an extractor but no addMessages method"
        )));
    }
    Ok(Some(ExtractionBinding {
        store: store.clone(),
        config,
    }))
}

/// The stores' names, in order.
fn names_of(stores: &[Arc<dyn MemoryStore>]) -> Vec<String> {
    stores.iter().map(|store| store.name().to_owned()).collect()
}

/// Keeps the first of each name.
fn dedupe(names: &[String]) -> Vec<&str> {
    let mut seen = HashSet::new();
    names
        .iter()
        .map(String::as_str)
        .filter(|name| seen.insert(*name))
        .collect()
}

impl MemoryManager {
    /// Creates the manager.
    ///
    /// # Errors
    ///
    /// No stores, duplicate store names, a writable store with no write method, an extraction
    /// config the store cannot serve (not writable, no triggers, or missing the write method its
    /// route needs), or an `add_memory` tool with no store it may write to.
    pub fn new(config: MemoryManagerConfig) -> Result<Self> {
        if config.stores.is_empty() {
            return Err(Error::other("MemoryManager: at least one store is required"));
        }
        let mut seen = HashSet::new();
        let mut extraction = Vec::new();
        for store in &config.stores {
            extraction.extend(validate_store(store, &mut seen)?);
        }
        let add_stores: Vec<_> = config
            .stores
            .iter()
            .filter(|store| store.writable() && store.implements_add())
            .cloned()
            .collect();
        let search_tool_config = config
            .search_tool_config
            .unwrap_or(Toggle::On(MemoryToolConfig::default()))
            .into_option();
        let add_tool = match config.add_tool_config.and_then(Toggle::into_option) {
            None => None,
            Some(tool_config) => {
                if add_stores.is_empty() {
                    return Err(Error::other(
                        "MemoryManager: addToolConfig is enabled but no writable stores implement add",
                    ));
                }
                let stores = resolve_add_tool_stores(&config.stores, &add_stores, &tool_config)?;
                Some((tool_config, stores))
            }
        };
        let injection = config
            .injection
            .unwrap_or(Toggle::On(MemoryInjectionConfig::default()))
            .into_option();
        Ok(Self {
            inner: Arc::new(Inner {
                stores: config.stores,
                add_stores,
                search_tool_config,
                add_tool,
                extraction,
                injection,
                coordinator: Mutex::new(None),
                tracer: Arc::new(Tracer::default()),
            }),
        })
    }

    /// Searches every store and concatenates their results in store order, each entry carrying
    /// its store's name (`search` without options); [`search_with`](Self::search_with) narrows
    /// the stores or the result count. Every store gets its own default count, else 3. A store
    /// that fails is logged and skipped.
    ///
    /// # Errors
    ///
    /// None today: store failures are logged and skipped.
    pub async fn search(&self, query: &str) -> Result<Vec<MemoryEntry>> {
        self.search_with(query, MemorySearchOptions::default()).await
    }

    /// Searches the stores with options (`search`): every store gets the caller's
    /// `max_search_results`, else its own default, else 3.
    ///
    /// # Errors
    ///
    /// `MemoryManager: store '<name>' not found` for a named store that is not configured.
    pub async fn search_with(&self, query: &str, options: MemorySearchOptions) -> Result<Vec<MemoryEntry>> {
        self.inner.search(query, options).await
    }

    /// Adds content to every writable store (`add` without options), waiting for every write;
    /// [`add_with`](Self::add_with) names the stores or attaches metadata. Store failures are
    /// logged and reported together.
    ///
    /// # Errors
    ///
    /// No writable store (`no writable store matched`), or an [`AggregateError`]
    /// `MemoryManager: store writes failed: <names>` when any write fails.
    pub async fn add(&self, content: &str) -> Result<()> {
        self.add_with(content, MemoryAddOptions::default()).await
    }

    /// Adds content with options (`add`): to the named writable stores, with metadata.
    ///
    /// # Errors
    ///
    /// An unknown (`store '<name>' not found`) or read-only (`store '<name>' is read-only`)
    /// named store, no target (`no writable store matched`), or an [`AggregateError`]
    /// `MemoryManager: store writes failed: <names>` when any write fails.
    pub async fn add_with(&self, content: &str, options: MemoryAddOptions) -> Result<()> {
        Ok(self.inner.add(content, options, false).await?)
    }

    /// Saves every store's remaining messages and waits for the saves (`flush`); does nothing
    /// without extraction. Extraction runs in the background, so the latest turn may not be saved
    /// when the agent answers; [`Agent::shutdown`](crate::Agent::shutdown) calls this. Calling it
    /// after every turn forces a save each time and defeats the triggers' schedule.
    pub async fn flush(&self) {
        let coordinator = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(coordinator) = coordinator {
            coordinator.flush().await;
        }
    }

    #[cfg(test)]
    pub(crate) fn coordinator(&self) -> Option<ExtractionCoordinator> {
        self.inner
            .coordinator
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn injection_config(&self) -> Option<&MemoryInjectionConfig> {
        self.inner.injection.as_ref()
    }

    #[cfg(test)]
    pub(crate) async fn provide_memory_context(&self, messages: &[Message]) -> Result<Option<String>> {
        let config = self.inner.injection.clone().unwrap_or_default();
        self.inner.provide_memory_context(messages, &config).await
    }

    fn init_extraction(&self, agent: &LocalAgent) {
        if self.inner.extraction.is_empty() {
            return;
        }
        let coordinator = ExtractionCoordinator::new(
            self.inner.extraction.clone(),
            agent.aux_model().clone(),
            self.inner.tracer.clone(),
        );
        *self.inner.coordinator.lock().unwrap_or_else(PoisonError::into_inner) = Some(coordinator.clone());
        let recorder = coordinator.clone();
        agent.add_hook(move |event: &mut MessageAddedEvent<'_>| recorder.record(event.message().clone()));
        for (index, binding) in self.inner.extraction.iter().enumerate() {
            for trigger in &binding.config.triggers {
                let coordinator = coordinator.clone();
                let fire = ExtractionFire::new(move |invocation_context| {
                    drop(coordinator.process(index, invocation_context));
                });
                trigger.attach(ExtractionTriggerContext { agent, fire });
            }
        }
    }

    fn init_injection(&self, agent: &LocalAgent) {
        let Some(config) = self.inner.injection.clone() else {
            return;
        };
        let inner = self.inner.clone();
        let trigger = config.trigger.clone().unwrap_or(InjectionTrigger::UserTurn);
        agent.add_middleware(injection_middleware(trigger, move |context| {
            let inner = inner.clone();
            let config = config.clone();
            async move {
                inner
                    .provide_memory_context(&context.messages, &config)
                    .await
                    .unwrap_or_else(|error| {
                        tracing::warn!("reason=<{error}> | injection renderContent threw; skipping injection");
                        None
                    })
            }
        }));
    }
}

fn resolve_add_tool_stores(
    stores: &[Arc<dyn MemoryStore>],
    add_stores: &[Arc<dyn MemoryStore>],
    config: &MemoryAddToolConfig,
) -> Result<Vec<Arc<dyn MemoryStore>>> {
    let Some(names) = &config.stores else {
        return Ok(add_stores.to_vec());
    };
    dedupe(names)
        .into_iter()
        .map(|name| {
            let Some(found) = stores.iter().find(|store| store.name() == name) else {
                return Err(Error::other(format!(
                    "MemoryManager: addToolConfig store '{name}' not found"
                )));
            };
            if !found.writable() {
                return Err(Error::other(format!(
                    "MemoryManager: addToolConfig store '{name}' is not writable"
                )));
            }
            if !found.implements_add() {
                return Err(Error::other(format!(
                    "MemoryManager: addToolConfig store '{name}' has no add method (only addMessages)"
                )));
            }
            Ok(found.clone())
        })
        .collect()
}

/// The stores a tool call targets: all in scope when none are named;
/// out-of-scope names are dropped with a warning, and an error when none is left.
fn resolve_tool_targets(
    scoped: &[String],
    requested: Option<Vec<String>>,
) -> std::result::Result<Vec<String>, ToolError> {
    let Some(requested) = requested.filter(|requested| !requested.is_empty()) else {
        return Ok(scoped.to_vec());
    };
    let (in_scope, out_of_scope): (Vec<String>, Vec<String>) =
        requested.iter().cloned().partition(|name| scoped.contains(name));
    if in_scope.is_empty() {
        return Err(ToolError::msg(format!(
            "MemoryManager: requested=<{}> | none of the requested memory stores are available; available stores: {}",
            requested.join(", "),
            scoped.join(", ")
        )));
    }
    if !out_of_scope.is_empty() {
        tracing::warn!(
            "requested=<{}> | ignoring memory stores outside this tool's scope",
            out_of_scope.join(", ")
        );
    }
    Ok(in_scope)
}

fn store_descriptions(stores: &[Arc<dyn MemoryStore>]) -> Vec<String> {
    stores
        .iter()
        .filter_map(|store| {
            let description = store.description().filter(|description| !description.is_empty())?;
            Some(format!("- {}: {description}", store.name()))
        })
        .collect()
}

fn string_list(input: &JsonValue, key: &str) -> Option<Vec<String>> {
    input.get(key)?.as_array().map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect()
    })
}

fn validator(schema: &JsonValue) -> Option<Arc<SchemaValidator>> {
    SchemaValidator::new(schema).ok().map(Arc::new)
}

fn validate(validator: Option<&SchemaValidator>, input: &JsonValue) -> std::result::Result<(), ToolError> {
    match validator {
        Some(validator) => validator.validate(input).map_err(ToolError::new),
        None => Ok(()),
    }
}

/// Collects the store errors behind failed `add` calls.
fn flatten(failures: Vec<AddError>) -> Vec<Error> {
    failures
        .into_iter()
        .flat_map(|failure| match failure {
            AddError::Target(error) => vec![error],
            AddError::Writes(aggregate) => aggregate.into_errors(),
        })
        .collect()
}

impl Inner {
    fn find(&self, name: &str) -> Result<&Arc<dyn MemoryStore>> {
        self.stores
            .iter()
            .find(|store| store.name() == name)
            .ok_or_else(|| Error::other(format!("MemoryManager: store '{name}' not found")))
    }

    async fn search(&self, query: &str, options: MemorySearchOptions) -> Result<Vec<MemoryEntry>> {
        tracing::debug!(
            "query=<{query}>, max_search_results=<{:?}>, stores=<{:?}> | searching stores",
            options.max_search_results,
            options.stores
        );
        let store_names = options.stores.clone().unwrap_or_else(|| names_of(&self.stores));
        let span = self.tracer.start_memory_search_span(StartMemorySearchSpanOptions {
            query,
            store_names: &store_names,
            max_search_results: options.max_search_results,
        });
        let targets = match self.search_targets(options.stores.as_deref()) {
            Ok(targets) => targets,
            Err(error) => {
                let message = error.to_string();
                self.tracer.end_memory_search_span(
                    span,
                    EndMemorySearchSpanOptions {
                        error: Some(&message),
                        ..EndMemorySearchSpanOptions::default()
                    },
                );
                return Err(error);
            }
        };
        let searches = targets.iter().map(|store| {
            let max_search_results = options
                .max_search_results
                .or_else(|| store.max_search_results())
                .unwrap_or(DEFAULT_MAX_SEARCH_RESULTS);
            store.search(
                query,
                SearchOptions {
                    max_search_results: Some(max_search_results),
                },
            )
        });
        let mut results = Vec::new();
        let mut store_failure_count = 0;
        for (store, outcome) in targets.iter().zip(join_all(searches).await) {
            let name = store.name();
            match outcome {
                Ok(entries) => results.extend(entries.into_iter().map(|entry| entry.with_store_name(name))),
                Err(error) => {
                    tracing::warn!("store=<{name}>, reason=<{error}> | store search failed");
                    store_failure_count += 1;
                }
            }
        }
        self.tracer.end_memory_search_span(
            span,
            EndMemorySearchSpanOptions {
                entries: &results,
                store_failure_count,
                error: None,
            },
        );
        tracing::debug!("results=<{}> | search complete", results.len());
        Ok(results)
    }

    fn search_targets(&self, stores: Option<&[String]>) -> Result<Vec<&Arc<dyn MemoryStore>>> {
        match stores {
            Some(names) => dedupe(names).into_iter().map(|name| self.find(name)).collect(),
            None => Ok(self.stores.iter().collect()),
        }
    }

    fn add_targets(&self, stores: Option<&[String]>) -> Result<Vec<Arc<dyn MemoryStore>>> {
        let Some(names) = stores else {
            return Ok(self.add_stores.clone());
        };
        dedupe(names)
            .into_iter()
            .map(|name| {
                let found = self.find(name)?;
                if !found.writable() {
                    return Err(Error::other(format!("MemoryManager: store '{name}' is read-only")));
                }
                Ok(found.clone())
            })
            .collect()
    }

    /// Writes `content` (`add`); a `detached` write (the fire-and-forget tool path) starts its
    /// span as a trace root rather than under a span that may have ended.
    async fn add(&self, content: &str, options: MemoryAddOptions, detached: bool) -> std::result::Result<(), AddError> {
        let store_names = options.stores.clone().unwrap_or_else(|| names_of(&self.add_stores));
        let span = self.tracer.start_memory_add_span(StartMemoryAddSpanOptions {
            content,
            store_names: &store_names,
            force_root: detached,
        });
        let outcome = self.write(content, options).await;
        let (store_failure_count, message) = match &outcome {
            Ok(()) => (0, None),
            Err(AddError::Target(error)) => (0, Some(error.to_string())),
            Err(AddError::Writes(error)) => (error.errors().len(), Some(error.to_string())),
        };
        self.tracer.end_memory_add_span(
            span,
            EndMemoryAddSpanOptions {
                store_failure_count,
                error: message.as_deref(),
            },
        );
        outcome
    }

    async fn write(&self, content: &str, options: MemoryAddOptions) -> std::result::Result<(), AddError> {
        let targets = self.add_targets(options.stores.as_deref()).map_err(AddError::Target)?;
        if targets.is_empty() {
            return Err(AddError::Target(Error::other(
                "MemoryManager: no writable store matched",
            )));
        }
        let writes = targets.iter().map(|store| store.add(content, options.metadata.clone()));
        let mut failed = Vec::new();
        let mut errors = Vec::new();
        for (store, outcome) in targets.iter().zip(join_all(writes).await) {
            let Err(error) = outcome else {
                continue;
            };
            let name = store.name();
            tracing::warn!("store=<{name}>, reason=<{error}> | store write failed");
            failed.push(name.to_owned());
            errors.push(error);
        }
        if errors.is_empty() {
            return Ok(());
        }
        Err(AddError::Writes(AggregateError::new(
            errors,
            format!("MemoryManager: store writes failed: {}", failed.join(", ")),
        )))
    }

    /// The text to inject for a call, or `None` to skip: derives the
    /// query, searches and renders the top entries.
    async fn provide_memory_context(
        &self,
        messages: &[Message],
        config: &MemoryInjectionConfig,
    ) -> Result<Option<String>> {
        let max_entries = config.max_entries.unwrap_or(DEFAULT_MAX_ENTRIES);
        let span = self.tracer.start_memory_inject_span(StartMemoryInjectSpanOptions {
            max_entries: Some(max_entries),
        });
        let outcome = self
            .render_memory_context(messages, config, max_entries)
            .instrument(span.span())
            .await;
        let (rendered, end) = match outcome {
            Ok(rendered) => rendered,
            Err(error) => {
                self.tracer
                    .end_memory_inject_span(span, EndMemoryInjectSpanOptions::default());
                return Err(error);
            }
        };
        self.tracer.end_memory_inject_span(span, end);
        Ok(rendered)
    }

    /// Derives the query, searches and renders the top entries, with how the inject span ends.
    async fn render_memory_context(
        &self,
        messages: &[Message],
        config: &MemoryInjectionConfig,
        max_entries: usize,
    ) -> Result<(Option<String>, EndMemoryInjectSpanOptions)> {
        let skipped = EndMemoryInjectSpanOptions::default();
        let Some(query) = resolve_injection_query(messages, config).filter(|query| !query.trim().is_empty()) else {
            return Ok((None, skipped));
        };
        let options = MemorySearchOptions {
            max_search_results: Some(max_entries),
            stores: None,
        };
        let mut entries = self.search(&query, options).await?;
        entries.truncate(max_entries);
        if entries.is_empty() {
            return Ok((None, skipped));
        }
        let injected = EndMemoryInjectSpanOptions {
            injected: true,
            entry_count: entries.len(),
            format_error: false,
        };
        let Some(format) = &config.format else {
            return Ok((Some(default_injection_format(&entries)), injected));
        };
        match (format.0)(&entries) {
            Ok(rendered) => Ok((Some(rendered), injected)),
            Err(error) => {
                tracing::warn!("reason=<{error}> | injection format threw; skipping injection");
                let format_error = EndMemoryInjectSpanOptions {
                    format_error: true,
                    ..skipped
                };
                Ok((None, format_error))
            }
        }
    }
}

/// The injection search query: the configured callback, or the latest
/// user text on a user turn and the most recent assistant text otherwise.
fn resolve_injection_query(messages: &[Message], config: &MemoryInjectionConfig) -> Option<String> {
    if let Some(query) = &config.query {
        return (query.0)(messages).unwrap_or_else(|error| {
            tracing::warn!("reason=<{error}> | injection query threw; skipping injection");
            None
        });
    }
    let role = if is_user_turn(messages) {
        Role::User
    } else {
        Role::Assistant
    };
    let message = messages.iter().rev().find(|message| message.role == role)?;
    let text = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// The default injection format: a `<memory>` block with one
/// escaped `<entry>` per result, attributed to its store when known.
pub(crate) fn default_injection_format(entries: &[MemoryEntry]) -> String {
    let items: Vec<String> = entries
        .iter()
        .map(
            |entry| match entry.store_name.as_deref().filter(|name| !name.is_empty()) {
                Some(store) => format!(
                    "<entry source=\"{}\">{}</entry>",
                    escape_xml_attr(store),
                    escape_xml_text(&entry.content)
                ),
                None => format!("<entry>{}</entry>", escape_xml_text(&entry.content)),
            },
        )
        .collect();
    format!("<memory>\n{}\n</memory>", items.join("\n"))
}

fn search_tool(inner: &Arc<Inner>, config: &MemoryToolConfig) -> FunctionTool {
    let mut description = config
        .description
        .clone()
        .unwrap_or_else(|| SEARCH_TOOL_DESCRIPTION.to_owned());
    let descriptions = store_descriptions(&inner.stores);
    if !descriptions.is_empty() {
        description.push_str(&format!("\n\nAvailable memory stores:\n{}", descriptions.join("\n")));
        description.push_str("\n\nYou can target one or more memory stores by name if you know which domains are relevant, or omit the stores parameter to search all.");
    }
    let scoped: Arc<Vec<String>> = Arc::new(inner.stores.iter().map(|store| store.name().to_owned()).collect());
    let schema = json!({
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for"},
            "maxSearchResults": {"description": "Maximum number of results per store", "type": "number"},
            "stores": {
                "description": "Filter to specific stores by name. Omit to search all available stores.",
                "type": "array",
                "items": {"type": "string"}
            }
        },
        "required": ["query"],
        "additionalProperties": false
    });
    let validator = validator(&schema);
    let inner = inner.clone();
    FunctionTool::builder(config.name.as_deref().unwrap_or("search_memory"), description)
        .input_schema(schema)
        .callback(move |input, _context| {
            let inner = inner.clone();
            let scoped = scoped.clone();
            let validator = validator.clone();
            async move {
                validate(validator.as_deref(), &input)?;
                let stores = resolve_tool_targets(&scoped, string_list(&input, "stores"))?;
                let query = input.get("query").and_then(JsonValue::as_str).unwrap_or_default();
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a JSON number of results, clamped at zero and floored to a count"
                )]
                let max_search_results = input
                    .get("maxSearchResults")
                    .and_then(JsonValue::as_f64)
                    .map(|max| max.max(0.0) as usize);
                let options = MemorySearchOptions {
                    max_search_results,
                    stores: Some(stores),
                };
                let results = inner.search(query, options).await?;
                Ok(serde_json::to_value(results)?)
            }
        })
}

fn add_tool(inner: &Arc<Inner>, config: &MemoryAddToolConfig, stores: &[Arc<dyn MemoryStore>]) -> FunctionTool {
    let mut description = config
        .description
        .clone()
        .unwrap_or_else(|| ADD_TOOL_DESCRIPTION.to_owned());
    let descriptions = store_descriptions(stores);
    if !descriptions.is_empty() {
        description.push_str(&format!("\n\nAvailable writable stores:\n{}", descriptions.join("\n")));
        description.push_str("\n\nYou can target a specific store by name to route facts to the right place, or omit to add to all available writable stores.");
    }
    let scoped: Arc<Vec<String>> = Arc::new(stores.iter().map(|store| store.name().to_owned()).collect());
    let wait_for_writes = config.wait_for_writes.unwrap_or(true);
    let schema = json!({
        "type": "object",
        "properties": {
            "entries": {
                "minItems": 1,
                "type": "array",
                "items": {"type": "string"},
                "description": "Data to add to long-term memory"
            },
            "stores": {
                "description": "Target specific stores by name. Omit to add to all writable stores.",
                "type": "array",
                "items": {"type": "string"}
            }
        },
        "required": ["entries"],
        "additionalProperties": false
    });
    let validator = validator(&schema);
    let inner = inner.clone();
    FunctionTool::builder(config.name.as_deref().unwrap_or("add_memory"), description)
        .input_schema(schema)
        .callback(move |input, _context| {
            let inner = inner.clone();
            let scoped = scoped.clone();
            let validator = validator.clone();
            async move {
                validate(validator.as_deref(), &input)?;
                let stores = resolve_tool_targets(&scoped, string_list(&input, "stores"))?;
                let entries = string_list(&input, "entries").unwrap_or_default();
                if wait_for_writes {
                    store_entries(&inner, entries, stores).await
                } else {
                    Ok(dispatch_entries(&inner, &entries, &stores))
                }
            }
        })
}

/// Awaits every write and reports the store errors behind any failure.
async fn store_entries(
    inner: &Inner,
    entries: Vec<String>,
    stores: Vec<String>,
) -> std::result::Result<JsonValue, ToolError> {
    let writes = entries.iter().map(|content| {
        let options = MemoryAddOptions {
            metadata: None,
            stores: Some(stores.clone()),
        };
        inner.add(content, options, false)
    });
    let failures: Vec<AddError> = join_all(writes)
        .await
        .into_iter()
        .filter_map(|outcome| outcome.err())
        .collect();
    if failures.is_empty() {
        return Ok(json!({"stored": entries.len()}));
    }
    let failed = failures.len();
    let reasons = flatten(failures);
    let message = format!(
        "MemoryManager: failed to add {failed} of {} entries: {}",
        entries.len(),
        reasons.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ")
    );
    Err(ToolError::new(AggregateError::new(reasons, message)))
}

/// Dispatches the writes without waiting, so a slow backend never blocks the loop; `add` logs
/// failures.
fn dispatch_entries(inner: &Arc<Inner>, entries: &[String], stores: &[String]) -> JsonValue {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        for content in entries {
            let inner = inner.clone();
            let content = content.clone();
            let options = MemoryAddOptions {
                metadata: None,
                stores: Some(stores.to_vec()),
            };
            runtime.spawn(async move {
                let _ = inner.add(&content, options, true).await;
            });
        }
    }
    json!({"accepted": entries.len()})
}

#[async_trait]
impl Plugin for MemoryManager {
    fn name(&self) -> &str {
        MEMORY_MANAGER_NAME
    }

    /// Initializes the stores, wires extraction for the stores that use it, and registers the
    /// injection middleware when injection is on.
    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        for store in &self.inner.stores {
            store.initialize().await?;
        }
        self.init_extraction(agent);
        self.init_injection(agent);
        Ok(())
    }

    /// The `search_memory` and `add_memory` tools as configured, then each store's tools.
    fn get_tools(&self) -> Vec<ToolSource> {
        let mut tools: Vec<ToolSource> = Vec::new();
        if let Some(config) = &self.inner.search_tool_config {
            tools.push(search_tool(&self.inner, config).into());
        }
        if let Some((config, stores)) = &self.inner.add_tool {
            tools.push(add_tool(&self.inner, config, stores).into());
        }
        tools.extend(self.inner.stores.iter().flat_map(|store| store.get_tools()));
        tools
    }
}

#[cfg(test)]
#[cfg(feature = "otel")]
mod tracing_tests;
