//! Context injection: the configuration shared by the
//! [`ContextInjector`](crate::vended_plugins::context_injector::ContextInjector) plugin and the
//! `MemoryManager`'s injection, and the crate-internal engine that folds text into the latest
//! user message before a model call.

use std::fmt;
use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;

use crate::agent::ToolAgent;
use crate::error::BoxError;
use crate::middleware::{InvokeModelContext, InvokeModelStage, Middleware};
use crate::state_store::StateStore;
use crate::types::{ContentBlock, Message, Role};

pub(crate) mod xml;

#[cfg(test)]
pub(crate) mod tests;

type TriggerFn = Arc<dyn Fn(&InjectionContext) -> Result<bool, BoxError> + Send + Sync>;
type RenderFn = Arc<dyn Fn(InjectionContext) -> BoxFuture<'static, Result<Option<String>, BoxError>> + Send + Sync>;

/// When injection runs before a model call (`InjectionTrigger`, plus the predicate form of
/// `InjectionConfig.trigger`).
///
/// ```
/// use strands::injection::InjectionTrigger;
///
/// let every_other = InjectionTrigger::predicate(|context| Ok(context.messages.len() % 2 == 1));
/// assert!(matches!(InjectionTrigger::default(), InjectionTrigger::UserTurn));
/// # let _ = every_other;
/// ```
#[derive(Clone, Default)]
#[non_exhaustive]
pub enum InjectionTrigger {
    /// Only when the latest message is a fresh user ask: a user message with no tool result
    /// (`'userTurn'`, the default).
    #[default]
    UserTurn,
    /// Before every model call, including tool-result turns (`'everyTurn'`).
    EveryTurn,
    /// A predicate over the [`InjectionContext`]. One that returns an error fails open: injection
    /// is skipped and the model call proceeds.
    Predicate(TriggerFn),
}

impl InjectionTrigger {
    /// A predicate trigger.
    pub fn predicate(predicate: impl Fn(&InjectionContext) -> Result<bool, BoxError> + Send + Sync + 'static) -> Self {
        Self::Predicate(Arc::new(predicate))
    }

    /// Whether to inject for this context; a failing predicate logs and skips.
    pub(crate) fn fires(&self, context: &InjectionContext) -> bool {
        match self {
            Self::UserTurn => is_user_turn(&context.messages),
            Self::EveryTurn => true,
            Self::Predicate(predicate) => predicate(context).unwrap_or_else(|error| {
                tracing::warn!("reason=<{error}> | injection trigger threw; skipping injection");
                false
            }),
        }
    }
}

impl fmt::Debug for InjectionTrigger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UserTurn => f.write_str("UserTurn"),
            Self::EveryTurn => f.write_str("EveryTurn"),
            Self::Predicate(_) => f.write_str("Predicate(..)"),
        }
    }
}

/// What an injection consumer receives on each model call (`InjectionContext`): passed to the
/// render callback and to a predicate trigger.
#[derive(Clone)]
#[non_exhaustive]
pub struct InjectionContext {
    /// The conversation this model call sends.
    pub messages: Vec<Message>,
    /// The agent's app state, shared with hooks and tools.
    pub app_state: StateStore,
    /// The agent the injection is attached to.
    pub agent: ToolAgent,
}

impl InjectionContext {
    /// The context for a model call that sends `messages` on `agent`, with the agent's app state.
    /// [`testing::injection_context`](crate::testing::injection_context) builds one on a mock
    /// agent, to test a render callback or a predicate on its own.
    #[must_use]
    pub fn new(messages: Vec<Message>, agent: ToolAgent) -> Self {
        Self {
            messages,
            app_state: agent.app_state().clone(),
            agent,
        }
    }

    pub(crate) fn from_model_context(context: &InvokeModelContext) -> Self {
        Self {
            messages: context.messages.clone(),
            app_state: context.agent.app_state().clone(),
            agent: context.agent.clone(),
        }
    }
}

impl fmt::Debug for InjectionContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InjectionContext")
            .field("messages", &self.messages.len())
            .finish_non_exhaustive()
    }
}

/// Configuration common to every injection consumer: when to inject (`InjectionConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct InjectionConfig {
    /// When injection runs. Defaults to [`InjectionTrigger::UserTurn`].
    pub trigger: Option<InjectionTrigger>,
}

/// The callback that renders the text to inject (`renderContent`): `Ok(None)` or blank text skips
/// the call, and an error fails open (logged, injection skipped).
#[derive(Clone)]
pub struct RenderContent(RenderFn);

impl RenderContent {
    /// Wraps an async render callback.
    pub fn new<F, Fut>(render: F) -> Self
    where
        F: Fn(InjectionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<String>, BoxError>> + Send + 'static,
    {
        Self(Arc::new(move |context| Box::pin(render(context))))
    }

    /// Renders the text for a context; an error is logged and skips the injection.
    pub(crate) async fn render(&self, context: InjectionContext) -> Option<String> {
        match (self.0)(context).await {
            Ok(text) => text,
            Err(error) => {
                tracing::warn!("reason=<{error}> | injection renderContent threw; skipping injection");
                None
            }
        }
    }
}

impl fmt::Debug for RenderContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RenderContent(..)")
    }
}

/// Whether the latest message is a fresh user ask: a user message with no tool result.
pub(crate) fn is_user_turn(messages: &[Message]) -> bool {
    messages.last().is_some_and(|last| {
        last.role == Role::User
            && !last
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolResult(_)))
    })
}

/// Appends `text` to the most recent user message as a text block,
/// keeping its tracking id and metadata. Returns the messages and how many trailing blocks of the
/// last message are per-call content: 1 when the fold landed on the last message, otherwise 0
/// (also when there is no user message, in which case the messages are returned unchanged).
pub(crate) fn fold_into_last_user_message(mut messages: Vec<Message>, text: &str) -> (Vec<Message>, usize) {
    let Some(index) = messages.iter().rposition(|message| message.role == Role::User) else {
        return (messages, 0);
    };
    let target = &mut messages[index];
    // Some providers concatenate adjacent text blocks, which would run this onto the user's words.
    let separator = if !target.content.is_empty() && !text.starts_with('\n') {
        "\n\n"
    } else {
        ""
    };
    target.content.push(ContentBlock::text(format!("{separator}{text}")));
    let appended = usize::from(index == messages.len() - 1);
    (messages, appended)
}

/// Folds the rendered text into the latest user message of this call only (the input phase of
/// `injection_middleware`). Anything that skips returns the context unchanged.
pub(crate) async fn inject<F, Fut>(
    mut context: InvokeModelContext,
    trigger: &InjectionTrigger,
    render: F,
) -> InvokeModelContext
where
    F: FnOnce(InjectionContext) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    let injection_context = InjectionContext::from_model_context(&context);
    if !trigger.fires(&injection_context) {
        return context;
    }
    let Some(text) = render(injection_context).await else {
        return context;
    };
    if text.trim().is_empty() {
        return context;
    }
    let (messages, appended) = fold_into_last_user_message(std::mem::take(&mut context.messages), &text);
    context.messages = messages;
    // Several producers may append on one call; the cache point precedes all of it.
    context.dynamic_trailing_blocks = Some(context.dynamic_trailing_blocks.unwrap_or(0) + appended);
    context
}

/// The `InvokeModelStage` input handler that folds rendered text into the model input, ephemerally.
pub(crate) fn injection_middleware<F, Fut>(trigger: InjectionTrigger, render: F) -> Middleware<InvokeModelStage>
where
    F: Fn(InjectionContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Option<String>> + Send + 'static,
{
    let render = Arc::new(render);
    let trigger = Arc::new(trigger);
    InvokeModelStage::input(move |context| {
        let render = render.clone();
        let trigger = trigger.clone();
        async move { Ok(inject(context, &trigger, |injection| render(injection)).await) }
    })
}
