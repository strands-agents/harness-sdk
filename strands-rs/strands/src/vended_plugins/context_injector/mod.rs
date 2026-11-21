//! The context-injection plugin: [`ContextInjector`] writes just-in-time text into the latest
//! user message before each model call, as an [`InjectedBlock`] that stays in the conversation.
//!
//! ```
//! use strands::Agent;
//! use strands::testing::MockModel;
//! use strands::vended_plugins::context_injector::{ContextInjector, ContextInjectorConfig};
//!
//! # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
//! let injector = ContextInjector::new(ContextInjectorConfig::new(|_context| async {
//!     Ok(Some("<now>2026-11-11</now>".to_owned()))
//! }));
//! let mut agent = Agent::builder()
//!     .model(MockModel::new().with_turn("ok"))
//!     .plugins([injector])
//!     .printer(false)
//!     .build()?;
//! agent.invoke("What day is it?").await?;
//! assert_eq!(agent.messages()[0].content.len(), 2);
//! # Ok::<(), strands::Error>(())
//! # }).unwrap();
//! ```

use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;

use crate::agent::LocalAgent;
use crate::error::{BoxError, Result};
use crate::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, BeforeModelCallEvent, HookCallbackOptions, HookOrder, ModelMessageEvent,
};
use crate::injection::RenderContent;
pub use crate::injection::{InjectionContext, InjectionTrigger};
use crate::middleware::{InvokeModelContext, InvokeModelStage};
use crate::plugins::Plugin;
use crate::types::{ContentBlock, InjectedBlock, Message, Role};

#[cfg(test)]
mod tests;

const DEFAULT_NAME: &str = "strands:context-injector";

/// Configuration for the [`ContextInjector`] plugin (`ContextInjectorConfig`).
///
/// The render callback is required, so the config has no `Default`; start from
/// [`ContextInjectorConfig::new`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ContextInjectorConfig {
    /// Plugin name, for logging and duplicate detection. Defaults to `strands:context-injector`.
    /// It is stored with every block the injector writes and keeps a retried call from writing
    /// again, also after a session restore, so keep it stable and give each injector its own.
    pub name: Option<String>,
    /// When to inject. Defaults to [`InjectionTrigger::UserTurn`].
    pub trigger: Option<InjectionTrigger>,
    /// Renders the text to write into the latest user message; `Ok(None)` or blank text skips.
    /// The text reaches the model verbatim, so escape any attacker-influenced fields yourself.
    /// Called at most once per user message: a retry, a forced structured output call or a resume
    /// sends the text it returned the first time. An error fails open (logged, injection skipped).
    pub render_content: RenderContent,
}

impl ContextInjectorConfig {
    /// A config with the render callback and the default name and trigger.
    pub fn new<F, Fut>(render_content: F) -> Self
    where
        F: Fn(InjectionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<Option<String>, BoxError>> + Send + 'static,
    {
        Self {
            name: None,
            trigger: None,
            render_content: RenderContent::new(render_content),
        }
    }

    /// Sets the plugin name.
    #[must_use]
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Sets the trigger.
    #[must_use]
    pub fn with_trigger(mut self, trigger: InjectionTrigger) -> Self {
        self.trigger = Some(trigger);
        self
    }
}

/// A block written into this call's input that the conversation does not hold yet.
struct PendingWrite {
    tracking_id: String,
    position: usize,
    /// Blocks other injectors wrote ahead of this one at `position`, so the conversation keeps
    /// the order the model input had.
    rank: usize,
    block: InjectedBlock,
}

/// The number of injected blocks that directly follow `start`.
fn injected_run(content: &[ContentBlock], start: usize) -> usize {
    content[start..]
        .iter()
        .take_while(|block| matches!(block, ContentBlock::Injected(_)))
        .count()
}

struct Inner {
    name: String,
    trigger: InjectionTrigger,
    render_content: RenderContent,
    pending: Mutex<Vec<PendingWrite>>,
}

impl Inner {
    fn wrote(&self, block: &ContentBlock) -> bool {
        matches!(block, ContentBlock::Injected(injected) if injected.source == self.name)
    }

    fn has_pending(&self, tracking_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .any(|write| write.tracking_id == tracking_id)
    }

    /// Writes the blocks of earlier model inputs into the conversation, each into the message it
    /// was written for, at the position it had in that input.
    fn apply(&self, messages: &mut [Message]) {
        let writes = std::mem::take(&mut *self.pending.lock().unwrap_or_else(PoisonError::into_inner));
        for write in writes {
            let Some(message) = messages
                .iter_mut()
                .find(|message| message.tracking_id() == write.tracking_id)
            else {
                continue;
            };
            if message.content.iter().any(|block| self.wrote(block)) {
                continue;
            }
            let start = write.position.min(message.content.len());
            let at = start + write.rank.min(injected_run(&message.content, start));
            message.content.insert(at, ContentBlock::Injected(write.block));
        }
    }

    /// Writes the rendered text into the latest user message of this call (`_inject`). A message
    /// gets at most one block from this injector; anything that skips leaves the input unchanged.
    async fn inject(&self, mut context: InvokeModelContext) -> InvokeModelContext {
        let Some(latest) = context.agent.messages().last() else {
            return context;
        };
        if latest.role != Role::User || latest.content.iter().any(|block| self.wrote(block)) {
            return context;
        }
        let tracking_id = latest.tracking_id().to_owned();
        let position = latest.content.len();
        if self.has_pending(&tracking_id) {
            return context;
        }
        // Another middleware may have replaced this call's messages.
        let Some(index) = context
            .messages
            .iter()
            .position(|message| message.tracking_id() == tracking_id)
        else {
            return context;
        };
        let injection_context = InjectionContext::from_model_context(&context);
        if !self.trigger.fires(&injection_context) {
            return context;
        }
        let Some(text) = self.render_content.render(injection_context).await else {
            return context;
        };
        if text.trim().is_empty() {
            return context;
        }
        let block = InjectedBlock::new(text, self.name.clone());
        let target = &mut context.messages[index];
        // After the stored content, so text other middleware adds for this call only stays last.
        let start = position.min(target.content.len());
        let rank = injected_run(&target.content, start);
        target
            .content
            .insert(start + rank, ContentBlock::Injected(block.clone()));
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(PendingWrite {
                tracking_id,
                position,
                rank,
                block,
            });
        context
    }
}

/// Injects just-in-time context into the latest user message before each model call
/// (`ContextInjector`).
///
/// Before each model call the plugin asks its render callback for text, gated by the trigger, and
/// writes it into the latest user message as an [`InjectedBlock`] named after the plugin. The
/// block stays in the conversation and the session. A model that takes temporary messages
/// receives each block as a system message it reads until the next user message, so the stored
/// history is sent unchanged on every call; every other model receives only the latest user
/// message's blocks, as text.
///
/// The block reaches the model input at once and the conversation when the model call ends
/// (before `ModelMessageEvent` hooks run); one injector serves one agent. Several injectors may
/// be registered; each contributes its text in plugin registration order.
pub struct ContextInjector {
    inner: Arc<Inner>,
}

impl ContextInjector {
    /// Creates the plugin.
    #[must_use]
    pub fn new(config: ContextInjectorConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                name: config.name.unwrap_or_else(|| DEFAULT_NAME.to_owned()),
                trigger: config.trigger.unwrap_or_default(),
                render_content: config.render_content,
                pending: Mutex::new(Vec::new()),
            }),
        }
    }
}

impl fmt::Debug for ContextInjector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContextInjector")
            .field("name", &self.inner.name)
            .field("trigger", &self.inner.trigger)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl Plugin for ContextInjector {
    fn name(&self) -> &str {
        &self.inner.name
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let inner = self.inner.clone();
        agent.add_middleware(InvokeModelStage::input(move |context| {
            let inner = inner.clone();
            async move { Ok(inner.inject(context).await) }
        }));
        let first = HookCallbackOptions {
            order: HookOrder::SDK_FIRST,
        };
        let inner = self.inner.clone();
        agent.add_hook_with(
            move |event: &mut BeforeModelCallEvent<'_>| inner.apply(event.agent_mut().messages_mut()),
            first,
        );
        let inner = self.inner.clone();
        agent.add_hook_with(
            move |event: &mut ModelMessageEvent<'_>| inner.apply(event.agent_mut().messages_mut()),
            first,
        );
        let inner = self.inner.clone();
        agent.add_hook_with(
            move |event: &mut AfterModelCallEvent<'_>| inner.apply(event.agent_mut().messages_mut()),
            first,
        );
        let inner = self.inner.clone();
        agent.add_hook_with(
            move |event: &mut AfterInvocationEvent<'_>| inner.apply(event.agent_mut().messages_mut()),
            first,
        );
        Ok(())
    }
}
