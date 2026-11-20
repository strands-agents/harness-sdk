//! The routing strategy contract.

use async_trait::async_trait;

use super::router::RoutingCandidate;
use crate::agent::{InvocationContext, InvocationState};
use crate::error::{BoxError, Error};
use crate::types::{Message, SystemPrompt, ToolSpec};

/// What failed on a [`RoutingAttempt`]: the error's name and message.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct RoutingFailure {
    /// The error's name (`Error::name`), such as `ModelThrottledError` or `Error`.
    pub name: String,
    /// The error message.
    pub message: String,
}

impl RoutingFailure {
    /// A failure with a class name and message.
    pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
        }
    }
}

impl From<&Error> for RoutingFailure {
    fn from(error: &Error) -> Self {
        Self::new(error.name(), error.to_string())
    }
}

/// A candidate used during an invocation and how that attempt went (`RoutingAttempt`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct RoutingAttempt {
    /// The configured candidate.
    pub candidate: RoutingCandidate,
    /// The model or candidate-resolution failure; `None` when the call succeeded.
    pub exception: Option<RoutingFailure>,
}

impl RoutingAttempt {
    /// A successful attempt.
    #[must_use]
    pub fn success(candidate: RoutingCandidate) -> Self {
        Self {
            candidate,
            exception: None,
        }
    }

    /// A failed attempt.
    #[must_use]
    pub fn failure(candidate: RoutingCandidate, exception: RoutingFailure) -> Self {
        Self {
            candidate,
            exception: Some(exception),
        }
    }
}

/// What a strategy reads to choose a candidate (`RoutingContext`): copies of the request, the
/// configured candidates and the attempts of this invocation.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct RoutingContext {
    /// A copy of the messages.
    pub messages: Vec<Message>,
    /// A copy of the system prompt.
    pub system_prompt: Option<SystemPrompt>,
    /// A copy of the tool specs.
    pub tool_specs: Vec<ToolSpec>,
    /// The configured candidates; a strategy returns one of these.
    pub candidates: Vec<RoutingCandidate>,
    /// The caller's invocation state.
    pub invocation_state: InvocationState,
    /// The attempts of this invocation, oldest first.
    pub attempts: Vec<RoutingAttempt>,
    /// The request this decision runs for; a nested model call that joins it adds to its usage,
    /// but its limits do not apply.
    pub invocation_context: Option<InvocationContext>,
}

impl RoutingContext {
    /// A context over `candidates` with an empty request and no attempts.
    #[must_use]
    pub fn new(candidates: Vec<RoutingCandidate>) -> Self {
        Self {
            messages: Vec::new(),
            system_prompt: None,
            tool_specs: Vec::new(),
            candidates,
            invocation_state: InvocationState::new(),
            attempts: Vec::new(),
            invocation_context: None,
        }
    }

    /// Sets the messages.
    #[must_use]
    pub fn with_messages(mut self, messages: Vec<Message>) -> Self {
        self.messages = messages;
        self
    }

    /// Sets the system prompt.
    #[must_use]
    pub fn with_system_prompt(mut self, system_prompt: impl Into<SystemPrompt>) -> Self {
        self.system_prompt = Some(system_prompt.into());
        self
    }

    /// Sets the tool specs.
    #[must_use]
    pub fn with_tool_specs(mut self, tool_specs: Vec<ToolSpec>) -> Self {
        self.tool_specs = tool_specs;
        self
    }

    /// Sets the attempts.
    #[must_use]
    pub fn with_attempts(mut self, attempts: Vec<RoutingAttempt>) -> Self {
        self.attempts = attempts;
        self
    }

    /// Sets the invocation state.
    #[must_use]
    pub fn with_invocation_state(mut self, invocation_state: InvocationState) -> Self {
        self.invocation_state = invocation_state;
        self
    }

    /// Sets the request the decision runs for.
    #[must_use]
    pub fn with_invocation_context(mut self, invocation_context: Option<InvocationContext>) -> Self {
        self.invocation_context = invocation_context;
        self
    }
}

/// Chooses a configured candidate (`RoutingStrategy`).
///
/// The router asks before the first model call, with no attempts, and after each failure no hook
/// claimed, until routing stops. Return one of `context.candidates` (compared by identity) or
/// `None` to decline.
///
/// Declining the opening selection serves the router's default model; declining after a failure
/// ends routing and the model error surfaces. At the opening selection, errors and foreign
/// candidates propagate; after a failure they end routing without replacing the model error. Each
/// failure round uses a candidate once: naming one already used this round ends routing, and a
/// nested router that cannot resolve uses up its slot while the strategy is asked again.
///
/// ```
/// use strands::models::routing::{RoutingCandidate, RoutingContext, RoutingStrategy};
///
/// struct Last;
///
/// #[strands::async_trait]
/// impl RoutingStrategy for Last {
///     async fn select(&self, context: &RoutingContext) -> Result<Option<RoutingCandidate>, strands::BoxError> {
///         Ok(context.candidates.last().cloned())
///     }
/// }
/// ```
#[async_trait]
pub trait RoutingStrategy: Send + Sync + 'static {
    /// Selects a candidate from `context.candidates`, or `None` to decline.
    ///
    /// # Errors
    ///
    /// Any error; see the trait docs for how the router treats it.
    async fn select(&self, context: &RoutingContext) -> Result<Option<RoutingCandidate>, BoxError>;

    /// The name routing logs use; defaults to the type name.
    fn name(&self) -> &'static str {
        let full = std::any::type_name::<Self>();
        let path = full.split('<').next().unwrap_or(full);
        path.rsplit("::").next().unwrap_or(path)
    }
}
