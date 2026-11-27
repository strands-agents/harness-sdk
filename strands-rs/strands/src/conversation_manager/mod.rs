//! Conversation history management.
//!
//! A [`ConversationManager`] keeps the history within the model's context window. When the model
//! reports a [`ContextWindowOverflowError`], the agent calls [`ConversationManager::reduce`] with
//! the error and retries the call if the history was reduced; when the error persists it leaves
//! the agent loop. With proactive compression enabled, the agent also calls `reduce` (without an
//! error) before a model call whose projected input exceeds the threshold.
//!
//! The built-in managers are [`SlidingWindowConversationManager`] (the default, 40 messages),
//! [`SummarizingConversationManager`] and [`NullConversationManager`].
//!
//! ```
//! use strands::Agent;
//! use strands::conversation_manager::{SlidingWindowConversationManager, SlidingWindowConversationManagerConfig};
//! use strands::testing::MockModel;
//!
//! let manager = SlidingWindowConversationManager::new(SlidingWindowConversationManagerConfig {
//!     window_size: Some(20),
//!     ..Default::default()
//! })?;
//! let agent = Agent::builder()
//!     .model(MockModel::new())
//!     .conversation_manager(manager)
//!     .printer(false)
//!     .build()?;
//! # let _ = agent;
//! # Ok::<(), strands::Error>(())
//! ```

pub(crate) mod compression;
mod null_conversation_manager;
mod sliding_window_conversation_manager;
mod summarizing_conversation_manager;

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;

pub use null_conversation_manager::NullConversationManager;
pub use sliding_window_conversation_manager::{
    SlidingWindowConversationManager, SlidingWindowConversationManagerConfig,
};
pub use summarizing_conversation_manager::{SummarizingConversationManager, SummarizingConversationManagerConfig};

use crate::agent::{InvocationContext, LocalAgent};
use crate::error::{ContextWindowOverflowError, Error, Result};
use crate::hooks::{AfterModelCallEvent, BeforeModelCallEvent};
use crate::models::Model;
use crate::plugins::Plugin;

/// The default proactive compression threshold (`DEFAULT_COMPRESSION_THRESHOLD`).
pub(crate) const DEFAULT_COMPRESSION_THRESHOLD: f64 = 0.7;

/// What [`ConversationManager::reduce`] gets (`ConversationManagerReduceOptions`).
#[non_exhaustive]
pub struct ConversationManagerReduceOptions<'a> {
    /// The agent; reduce `agent.messages_mut()` in place.
    pub agent: &'a mut LocalAgent,
    /// The model of the call that triggered the reduction. Use it to size the reduction;
    /// managers that reduce through a model call resolve their own, usually the aux model.
    pub model: Arc<dyn Model>,
    /// The overflow that triggered the call, or `None` for proactive compression. When set,
    /// `reduce` must remove enough history for the next call to succeed.
    pub error: Option<ContextWindowOverflowError>,
    /// The request the reduction runs for; a nested model call adds to its usage, but its limits
    /// do not apply.
    pub invocation_context: Option<InvocationContext>,
}

impl<'a> ConversationManagerReduceOptions<'a> {
    /// Options for a proactive reduction of `agent`'s history.
    pub fn new(agent: &'a mut LocalAgent, model: Arc<dyn Model>) -> Self {
        Self {
            agent,
            model,
            error: None,
            invocation_context: None,
        }
    }

    /// Marks the reduction as recovery from `error`.
    #[must_use]
    pub fn with_error(mut self, error: ContextWindowOverflowError) -> Self {
        self.error = Some(error);
        self
    }

    /// Sets the request the reduction runs for.
    #[must_use]
    pub fn with_invocation_context(mut self, invocation_context: Option<InvocationContext>) -> Self {
        self.invocation_context = invocation_context;
        self
    }
}

impl fmt::Debug for ConversationManagerReduceOptions<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConversationManagerReduceOptions")
            .field("model", &self.model.model_id())
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

/// When proactive compression runs.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[non_exhaustive]
pub enum ProactiveCompression {
    /// Only reactive overflow recovery (`false` or omitted).
    #[default]
    Disabled,
    /// Compress at 70% of the context window (`true`).
    Enabled,
    /// Compress at this ratio of the context window, in `(0, 1]` (`{ compressionThreshold }`).
    Threshold(f64),
}

impl From<bool> for ProactiveCompression {
    fn from(enabled: bool) -> Self {
        if enabled { Self::Enabled } else { Self::Disabled }
    }
}

impl ProactiveCompression {
    /// The threshold ratio, or `None` when disabled.
    ///
    /// # Errors
    ///
    /// A threshold outside `(0, 1]`.
    pub fn threshold(self) -> Result<Option<f64>> {
        let threshold = match self {
            Self::Disabled => return Ok(None),
            Self::Enabled => DEFAULT_COMPRESSION_THRESHOLD,
            Self::Threshold(threshold) => threshold,
        };
        if threshold.is_nan() || threshold <= 0.0 || threshold > 1.0 {
            return Err(Error::other(format!(
                "compressionThreshold must be between 0 (exclusive) and 1 (inclusive), got {threshold}"
            )));
        }
        Ok(Some(threshold))
    }
}

/// A conversation history strategy (`ConversationManager`).
///
/// The agent registers it as a plugin: on a context-window overflow it calls
/// [`reduce`](Self::reduce) with the error and retries when it returns `true`; before a model
/// call it calls `reduce` without an error when [`compression_threshold`](Self::compression_threshold)
/// is set and the projected input reaches it. [`init_agent`](Self::init_agent) adds any other
/// hooks the strategy needs.
///
/// ```
/// use strands::async_trait;
/// use strands::conversation_manager::{ConversationManager, ConversationManagerReduceOptions};
///
/// struct LastTenMessages;
///
/// #[async_trait]
/// impl ConversationManager for LastTenMessages {
///     fn name(&self) -> &str {
///         "my:last-10-messages"
///     }
///
///     async fn reduce(&self, options: ConversationManagerReduceOptions<'_>) -> strands::Result<bool> {
///         let messages = options.agent.messages_mut();
///         if messages.len() <= 10 {
///             return Ok(false);
///         }
///         let excess = messages.len() - 10;
///         messages.drain(..excess);
///         Ok(true)
///     }
/// }
/// ```
#[async_trait]
pub trait ConversationManager: Send + Sync + 'static {
    /// A stable identifier, also the plugin name.
    fn name(&self) -> &str;

    /// Reduces the history and returns whether it changed (`reduce`).
    ///
    /// With `options.error` set this is overflow recovery and must make progress, or the overflow
    /// leaves the agent loop. Without it, it is best-effort proactive compression.
    ///
    /// # Errors
    ///
    /// A reduction that failed. During recovery the error replaces the overflow error; during
    /// proactive compression it is logged and the call proceeds.
    async fn reduce(&self, options: ConversationManagerReduceOptions<'_>) -> Result<bool>;

    /// The proactive compression threshold, or `None` when only overflow recovery runs: the
    /// ratio of the context window, in `(0, 1]`, at which a model call reduces first. The agent
    /// checks it when the manager is initialized and fails otherwise.
    fn compression_threshold(&self) -> Option<f64> {
        None
    }

    /// Registers the strategy's own hooks, after the overflow and compression hooks.
    ///
    /// # Errors
    ///
    /// A failed initialization; the agent's first invocation reports it.
    async fn init_agent(&self, _agent: &mut LocalAgent) -> Result<()> {
        Ok(())
    }
}

/// A shared manager is a manager, so the builder's `conversation_manager(..)` takes one by value
/// or as an `Arc`.
#[async_trait]
impl<M: ConversationManager + ?Sized> ConversationManager for Arc<M> {
    fn name(&self) -> &str {
        (**self).name()
    }

    async fn reduce(&self, options: ConversationManagerReduceOptions<'_>) -> Result<bool> {
        (**self).reduce(options).await
    }

    fn compression_threshold(&self) -> Option<f64> {
        (**self).compression_threshold()
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        (**self).init_agent(agent).await
    }
}

/// Registers a conversation manager's hooks on an agent (`ConversationManager.initAgent`).
pub(crate) struct ConversationManagerPlugin {
    manager: Arc<dyn ConversationManager>,
}

impl ConversationManagerPlugin {
    pub(crate) fn new(manager: Arc<dyn ConversationManager>) -> Self {
        Self { manager }
    }
}

/// Reactive overflow recovery: a reduction error fails the invocation with it.
async fn recover_from_overflow(manager: &dyn ConversationManager, event: &mut AfterModelCallEvent<'_>) -> Result<()> {
    let Some(Error::ContextWindowOverflow(error)) = event.error() else {
        return Ok(());
    };
    let error = error.clone();
    let model = event.model().clone();
    let invocation_context = InvocationContext::auxiliary(event.invocation_context());
    let options = ConversationManagerReduceOptions::new(event.agent_mut(), model)
        .with_error(error)
        .with_invocation_context(invocation_context);
    if manager.reduce(options).await? {
        event.set_retry(true);
    }
    Ok(())
}

async fn compress_proactively(manager: &dyn ConversationManager, event: &mut BeforeModelCallEvent<'_>) {
    let Some(threshold) = manager.compression_threshold() else {
        return;
    };
    let Some(projected) = event.projected_input_tokens() else {
        return;
    };
    let ratio = event.model().estimate_utilization(projected);
    if ratio < threshold {
        return;
    }
    tracing::debug!(
        "projected_tokens=<{projected}>, ratio=<{ratio:.2}>, compression_threshold=<{threshold}> | compression threshold exceeded, reducing context"
    );
    let model = event.model().clone();
    let invocation_context = InvocationContext::auxiliary(event.invocation_context());
    let options =
        ConversationManagerReduceOptions::new(event.agent_mut(), model).with_invocation_context(invocation_context);
    if let Err(error) = manager.reduce(options).await {
        tracing::warn!(
            "conversation_manager=<{}> | proactive compression failed, continuing | error=<{error}>",
            manager.name()
        );
    }
}

#[async_trait]
impl Plugin for ConversationManagerPlugin {
    fn name(&self) -> &str {
        self.manager.name()
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        if let Some(threshold) = self.manager.compression_threshold() {
            ProactiveCompression::Threshold(threshold).threshold()?;
        }
        let manager = self.manager.clone();
        agent.add_async_hook::<AfterModelCallEvent<'_>>(move |event| {
            let manager = manager.clone();
            Box::pin(async move { recover_from_overflow(manager.as_ref(), event).await })
        });
        let manager = self.manager.clone();
        agent.add_async_hook::<BeforeModelCallEvent<'_>>(move |event| {
            let manager = manager.clone();
            Box::pin(async move { compress_proactively(manager.as_ref(), event).await })
        });
        self.manager.init_agent(agent).await
    }
}

#[cfg(test)]
mod tests;
