//! Automatic memory extraction: triggers decide when a store's unsaved messages are written,
//! extractors decide how.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::agent::{InvocationContext, LocalAgent};
use crate::error::Result;
use crate::models::Model;
use crate::telemetry::Tracer;
use crate::types::{ContentBlock, JsonObject, Message};

pub(crate) mod coordinator;
mod model_extractor;
pub(crate) mod resolve;
mod triggers;

#[cfg(test)]
mod tests;

pub use model_extractor::{ModelExtractor, ModelExtractorOptions, ModelExtractorOptionsBuilder};
pub use triggers::{IntervalTrigger, IntervalTriggerOptions, IntervalTriggerOptionsBuilder, InvocationTrigger};

/// A content block kind a [`MemoryMessageFilter`] can strip (`MemoryContentBlockType`): the
/// block's wire key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum MemoryContentBlockType {
    /// `text`.
    Text,
    /// `toolUse`.
    ToolUse,
    /// `toolResult`.
    ToolResult,
    /// `reasoning`.
    Reasoning,
    /// `cachePoint`.
    CachePoint,
    /// `guardContent`.
    GuardContent,
    /// `audio`.
    Audio,
    /// `image`.
    Image,
    /// `video`.
    Video,
    /// `document`.
    Document,
    /// `citations`.
    Citations,
    /// `injected`.
    Injected,
    /// `summary`.
    Summary,
}

impl MemoryContentBlockType {
    /// The kind of a block; a block this version does not know has none.
    pub(crate) fn of(block: &ContentBlock) -> Option<Self> {
        Some(match block {
            ContentBlock::Text(_) => Self::Text,
            ContentBlock::ToolUse(_) => Self::ToolUse,
            ContentBlock::ToolResult(_) => Self::ToolResult,
            ContentBlock::Reasoning(_) => Self::Reasoning,
            ContentBlock::CachePoint(_) => Self::CachePoint,
            ContentBlock::GuardContent(_) => Self::GuardContent,
            ContentBlock::Audio(_) => Self::Audio,
            ContentBlock::Image(_) => Self::Image,
            ContentBlock::Video(_) => Self::Video,
            ContentBlock::Document(_) => Self::Document,
            ContentBlock::Citations(_) => Self::Citations,
            ContentBlock::Injected(_) => Self::Injected,
            ContentBlock::Summary(_) => Self::Summary,
            _ => return None,
        })
    }
}

/// Strips content blocks before extraction (`MemoryMessageFilter`); a message left empty is
/// dropped. The default excludes tool traffic (`toolUse`, `toolResult`); pass an empty `exclude`
/// to keep everything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryMessageFilter {
    /// The block kinds to strip.
    pub exclude: Vec<MemoryContentBlockType>,
}

impl Default for MemoryMessageFilter {
    fn default() -> Self {
        Self {
            exclude: vec![MemoryContentBlockType::ToolUse, MemoryContentBlockType::ToolResult],
        }
    }
}

/// An entry an [`Extractor`] produced, written through the store's `add` (`ExtractionResult`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ExtractionResult {
    /// The entry text.
    pub content: String,
    /// Metadata stored with the entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
}

impl ExtractionResult {
    /// An entry with content only.
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            metadata: None,
        }
    }

    /// Sets the metadata.
    #[must_use]
    pub fn with_metadata(mut self, metadata: JsonObject) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

/// What [`Extractor::extract`] gets besides the messages (`ExtractorContext`).
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct ExtractorContext {
    /// The model an extractor without its own uses (`agent.aux_model`, which defaults to the
    /// agent's model).
    pub default_model: Option<Arc<dyn Model>>,
    /// The request this extraction runs for: the call's usage adds to it, its limits do not apply.
    pub invocation_context: Option<InvocationContext>,
    /// The tracer of the extraction span, so a model call nests a `chat` span under it; `None`
    /// for standalone use.
    pub(crate) tracer: Option<Arc<Tracer>>,
}

impl ExtractorContext {
    /// Sets the fallback model.
    #[must_use]
    pub fn with_default_model(mut self, model: Arc<dyn Model>) -> Self {
        self.default_model = Some(model);
        self
    }

    /// Sets the request the extraction runs for.
    #[must_use]
    pub fn with_invocation_context(mut self, invocation_context: Option<InvocationContext>) -> Self {
        self.invocation_context = invocation_context;
        self
    }

    pub(crate) fn with_tracer(mut self, tracer: Arc<Tracer>) -> Self {
        self.tracer = Some(tracer);
        self
    }
}

impl fmt::Debug for ExtractorContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtractorContext")
            .field(
                "default_model",
                &self.default_model.as_ref().map(|model| model.model_id()),
            )
            .finish_non_exhaustive()
    }
}

/// Turns conversation messages into discrete entries (`Extractor`).
#[async_trait]
pub trait Extractor: Send + Sync + 'static {
    /// Extracts entries from the filtered messages.
    async fn extract(&self, messages: &[Message], context: ExtractorContext) -> Result<Vec<ExtractionResult>>;

    /// The name the extraction span records as `memory.extractor`.
    fn name(&self) -> &str {
        "Extractor"
    }
}

/// Starts a store's extraction in the background (`ExtractionTriggerContext.fire`).
#[derive(Clone)]
pub struct ExtractionFire(Arc<dyn Fn(Option<InvocationContext>) + Send + Sync>);

impl ExtractionFire {
    /// A fire handle that calls `fire`; the memory manager builds the real one, tests of a custom
    /// [`ExtractionTrigger`] can record the calls.
    pub fn new(fire: impl Fn(Option<InvocationContext>) + Send + Sync + 'static) -> Self {
        Self(Arc::new(fire))
    }

    /// Saves the store's unsaved messages now, in the background; returns at once, so it never
    /// blocks a hook. Pass the firing event's invocation context so a client-side extractor's
    /// model call joins that request. To wait for the save, use
    /// [`MemoryManager::flush`](crate::memory::MemoryManager::flush).
    pub fn fire(&self, invocation_context: Option<InvocationContext>) {
        (self.0)(invocation_context);
    }
}

impl fmt::Debug for ExtractionFire {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ExtractionFire(..)")
    }
}

/// What [`ExtractionTrigger::attach`] gets (`ExtractionTriggerContext`).
#[non_exhaustive]
pub struct ExtractionTriggerContext<'a> {
    /// The agent to register hooks on.
    pub agent: &'a LocalAgent,
    /// Starts extraction for the store this trigger is attached to.
    pub fire: ExtractionFire,
}

impl<'a> ExtractionTriggerContext<'a> {
    /// The context a trigger attaches to `agent` with, firing through `fire`.
    ///
    /// ```
    /// use std::sync::Arc;
    /// use std::sync::atomic::{AtomicUsize, Ordering};
    /// use strands::memory::{ExtractionFire, ExtractionTrigger, ExtractionTriggerContext, InvocationTrigger};
    /// use strands::testing::{MockModel, test_agent};
    ///
    /// let agent = test_agent(MockModel::new());
    /// let fired = Arc::new(AtomicUsize::new(0));
    /// let counter = fired.clone();
    /// let fire = ExtractionFire::new(move |_| {
    ///     counter.fetch_add(1, Ordering::SeqCst);
    /// });
    /// InvocationTrigger::new().attach(ExtractionTriggerContext::new(agent.local(), fire));
    /// assert_eq!(fired.load(Ordering::SeqCst), 0);
    /// ```
    #[must_use]
    pub fn new(agent: &'a LocalAgent, fire: ExtractionFire) -> Self {
        Self { agent, fire }
    }
}

impl fmt::Debug for ExtractionTriggerContext<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtractionTriggerContext")
            .field("agent", &self.agent.id())
            .finish_non_exhaustive()
    }
}

/// Decides when a store's extraction runs (`ExtractionTrigger`): [`attach`](Self::attach)
/// registers the hooks it needs and calls `fire` when extraction should happen. A trigger that
/// never fires never extracts; [`MemoryManager::flush`](crate::memory::MemoryManager::flush)
/// writes everything regardless.
pub trait ExtractionTrigger: Send + Sync + 'static {
    /// A stable name for the trigger kind, used in logs.
    fn name(&self) -> &str;

    /// Wires the trigger into the agent; called once per store when the manager initializes.
    fn attach(&self, context: ExtractionTriggerContext<'_>);
}

/// A store's automatic-extraction configuration (`ExtractionConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct ExtractionConfig {
    /// When extraction runs; it runs whenever any trigger fires. `None` is every 5 turns; an
    /// empty list is rejected by the manager.
    pub trigger: Option<Vec<Arc<dyn ExtractionTrigger>>>,
    /// How messages become entries (client-side; the store must implement `add`). `None` hands
    /// the raw messages to `add_messages` when the store implements it, and otherwise uses a
    /// [`ModelExtractor`].
    pub extractor: Option<Arc<dyn Extractor>>,
    /// Block kinds to strip first. Defaults to [`MemoryMessageFilter::default`].
    pub filter: Option<MemoryMessageFilter>,
}

impl ExtractionConfig {
    /// Sets the triggers.
    #[must_use]
    pub fn with_trigger(mut self, triggers: impl IntoIterator<Item = Arc<dyn ExtractionTrigger>>) -> Self {
        self.trigger = Some(triggers.into_iter().collect());
        self
    }

    /// Sets the extractor.
    #[must_use]
    pub fn with_extractor(mut self, extractor: Arc<dyn Extractor>) -> Self {
        self.extractor = Some(extractor);
        self
    }

    /// Sets the filter.
    #[must_use]
    pub fn with_filter(mut self, filter: MemoryMessageFilter) -> Self {
        self.filter = Some(filter);
        self
    }
}

impl fmt::Debug for ExtractionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtractionConfig")
            .field(
                "trigger",
                &self
                    .trigger
                    .as_ref()
                    .map(|triggers| triggers.iter().map(|trigger| trigger.name()).collect::<Vec<_>>()),
            )
            .field("extractor", &self.extractor.as_ref().map(|_| ".."))
            .field("filter", &self.filter)
            .finish()
    }
}
