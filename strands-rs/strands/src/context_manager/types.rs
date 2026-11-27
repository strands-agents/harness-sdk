//! Configuration and strategy types.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;

use super::archive::Archive;
use super::presets::StrategyEntry;
use super::strategies::deferred_tool_loading::DeferStrategy;
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::Result;
use crate::storage::Storage;
use crate::types::{Message, Toggle, toggle_from_config};

/// A context reduction strategy: offloads, summarizes or otherwise shrinks the conversation
/// (`ContextStrategy`).
///
/// The context manager applies its strategies in order; each decides from the [`ContextState`]
/// whether to act.
///
/// ```
/// use strands::Result;
/// use strands::context_manager::{ContextState, ContextStrategy};
///
/// struct DropOldest;
///
/// #[strands::async_trait]
/// impl ContextStrategy for DropOldest {
///     fn name(&self) -> &str {
///         "drop-oldest"
///     }
///
///     async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
///         if context.utilization < 1.0 || context.messages().len() < 3 {
///             return Ok(false);
///         }
///         context.messages_mut().remove(1);
///         Ok(true)
///     }
/// }
/// ```
#[async_trait]
pub trait ContextStrategy: Send + Sync + 'static {
    /// A stable identifier for logging (`name`).
    fn name(&self) -> &str;

    /// Called once when the context manager is attached to an agent, for example to register
    /// hooks that offload content as it arrives (`init`).
    ///
    /// # Errors
    ///
    /// A strategy that cannot run on this agent; attaching the context manager fails.
    fn init(&self, _agent: &mut LocalAgent, _archive: Option<&Archive>) -> Result<()> {
        Ok(())
    }

    /// Tries to reduce the context; returns whether it changed anything (`apply`).
    ///
    /// # Errors
    ///
    /// A failed reduction; the context manager logs it and continues with the next strategy.
    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool>;

    /// The strategy as deferred tool loading, which the context manager gives its `load_tools`
    /// tool; only [`DeferStrategy`] answers.
    #[doc(hidden)]
    fn as_defer_strategy(&self) -> Option<&DeferStrategy> {
        None
    }
}

/// What a strategy sees when it runs (`ContextState`).
#[non_exhaustive]
pub struct ContextState<'a> {
    /// The agent; its messages are the context window, changed in place.
    pub agent: &'a mut LocalAgent,
    /// Context utilization, 0 to 1 and above; above 1 is an overflow.
    pub utilization: f64,
    /// Set when running for a context window overflow. Strategies should bypass their
    /// utilization gates then: the provider rejected the request, so the estimate is off.
    pub overflow: bool,
    /// The archive for offloaded content, when one is configured.
    pub archive: Option<Archive>,
    /// The request this reduction runs for; a nested call adds to its usage, but its limits do
    /// not apply.
    pub invocation_context: Option<InvocationContext>,
}

impl<'a> ContextState<'a> {
    /// A state for `agent` at `utilization`.
    pub fn new(agent: &'a mut LocalAgent, utilization: f64) -> Self {
        Self {
            agent,
            utilization,
            overflow: false,
            archive: None,
            invocation_context: None,
        }
    }

    /// Marks the run as overflow recovery.
    #[must_use]
    pub fn with_overflow(mut self, overflow: bool) -> Self {
        self.overflow = overflow;
        self
    }

    /// Sets the archive.
    #[must_use]
    pub fn with_archive(mut self, archive: Option<Archive>) -> Self {
        self.archive = archive;
        self
    }

    /// Sets the invocation context.
    #[must_use]
    pub fn with_invocation_context(mut self, invocation_context: Option<InvocationContext>) -> Self {
        self.invocation_context = invocation_context;
        self
    }

    /// The agent's messages (`messages`).
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        self.agent.messages()
    }

    /// The agent's messages, to change in place.
    pub fn messages_mut(&mut self) -> &mut Vec<Message> {
        self.agent.messages_mut()
    }
}

impl fmt::Debug for ContextState<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContextState")
            .field("messages", &self.agent.messages().len())
            .field("utilization", &self.utilization)
            .field("overflow", &self.overflow)
            .field("archive", &self.archive)
            .finish_non_exhaustive()
    }
}

/// Archive configuration (`ArchiveConfig`).
///
/// Each agent archives under `context/<sessionId>/scopes/agent/<agentId>/`. When `storage` is a
/// namespaced view from a built-in backend's `namespace()`, that view is the exact archive root, so
/// agents given the same view share one archive.
#[derive(Clone, Default, bon::Builder)]
pub struct ArchiveConfig {
    /// The storage backend. Defaults to the agent's `storage`, then an
    /// [`InMemoryStorage`](crate::storage::InMemoryStorage).
    pub storage: Option<Arc<dyn Storage>>,
    /// `Some(false)` keeps the archive without registering the `retrieve_context` tool
    /// (`retrievalTool: false`). Defaults to registering it.
    pub retrieval_tool: Option<bool>,
}

impl fmt::Debug for ArchiveConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArchiveConfig")
            .field(
                "storage",
                &self.storage.as_ref().map(|storage| storage.storage_type().to_owned()),
            )
            .field("retrieval_tool", &self.retrieval_tool)
            .finish()
    }
}

toggle_from_config!(ArchiveConfig);

/// Configuration of a [`ContextManager`](super::ContextManager) (`ContextManagerConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct ContextManagerConfig {
    /// The reduction pipeline, applied in order; presets expand in place. Defaults to the `auto`
    /// preset's: tool results over 1,500 tokens truncated to a 750-token preview, and
    /// summarization at 85% context utilization. An emergency truncation always runs last.
    pub strategies: Option<Vec<StrategyEntry>>,
    /// The archive for offloaded content: `true`, an [`ArchiveConfig`], or `false` for no archive and no
    /// retrieval tool. Defaults to enabled.
    #[builder(into)]
    pub archive: Option<Toggle<ArchiveConfig>>,
}
