//! The actions an intervention handler returns.

use std::fmt;

use crate::error::BoxError;
use crate::hooks::HookOutput;
use crate::models::is_js_whitespace;
use crate::types::JsonValue;

crate::callback::callback! {
    /// Decides whether a human's response approves a [`Confirm`].
    pub struct Evaluate(Fn(&JsonValue) -> bool);
}

/// The in-place mutation a [`Transform`] applies to the event.
pub(crate) type TransformFn<E> = Box<dyn FnOnce(&mut E) -> Result<(), BoxError> + Send>;

/// The default approval test of a [`Confirm`]: `true`, or `"y"`/`"yes"`
/// (case-insensitive, trimmed of Unicode whitespace other than `U+0085`, plus `U+FEFF`).
///
/// ```
/// use serde_json::json;
/// use strands::interventions::default_evaluate;
///
/// assert!(default_evaluate(&json!(true)));
/// assert!(default_evaluate(&json!(" YES ")));
/// assert!(!default_evaluate(&json!("no")));
/// ```
#[must_use]
pub fn default_evaluate(response: &JsonValue) -> bool {
    match response {
        JsonValue::Bool(approved) => *approved,
        JsonValue::String(text) => matches!(text.to_lowercase().trim_matches(is_js_whitespace), "y" | "yes"),
        _ => false,
    }
}

/// Lets the operation continue unchanged (`Proceed`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Proceed {
    /// Debugging metadata; not shown to the model.
    pub reason: Option<String>,
}

impl Proceed {
    /// A proceed without a reason.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the debugging reason.
    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

/// Blocks the operation (`Deny`): on `Before*` events the cancel message is `DENIED: <reason>`,
/// which the model sees.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Deny {
    /// Why the operation was blocked; shown to the model.
    pub reason: String,
}

impl Deny {
    /// A denial with the reason shown to the model.
    pub fn new(reason: impl Into<String>) -> Self {
        Self { reason: reason.into() }
    }
}

/// Steers the model with feedback (`Guide`).
///
/// On `before_tool_call` and `before_invocation` the event is cancelled with `GUIDANCE: ..`; on
/// `before_model_call` the feedback is appended as a user message for this call; on
/// `after_model_call` the response is discarded and the call retried with the feedback appended.
/// Feedback from several handlers accumulates as `[<handler>] <feedback>` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Guide {
    /// The guidance shown to the model.
    pub feedback: String,
    /// Debugging metadata; not shown to the model.
    pub reason: Option<String>,
}

impl Guide {
    /// Guidance with the feedback shown to the model.
    pub fn new(feedback: impl Into<String>) -> Self {
        Self {
            feedback: feedback.into(),
            reason: None,
        }
    }

    /// Sets the debugging reason.
    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

/// Asks a human to approve the tool call (`Confirm`); only `before_tool_call` supports it.
///
/// Without a [`response`](Self::response) the agent stops with an interrupt named after the
/// handler, whose reason is the prompt, and the answer arrives on resume. With one, the interrupt
/// is recorded with that answer and the agent never pauses. The answer goes through
/// [`evaluate`](Self::evaluate) ([`default_evaluate`] when unset); a rejection cancels the call
/// with `CONFIRMATION_FAILED: <prompt>`.
#[derive(Clone)]
#[non_exhaustive]
pub struct Confirm {
    /// The question for the human; not shown to the model.
    pub prompt: String,
    /// Debugging metadata; not shown to the model.
    pub reason: Option<String>,
    /// An answer collected by the handler itself, so the agent does not pause.
    pub response: Option<JsonValue>,
    /// The approval test; [`default_evaluate`] when `None`.
    pub evaluate: Option<Evaluate>,
}

impl Confirm {
    /// A confirmation with the default approval test.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            reason: None,
            response: None,
            evaluate: None,
        }
    }

    /// Sets the debugging reason.
    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    /// Supplies the human's answer up front (inline mode).
    #[must_use]
    pub fn with_response(mut self, response: impl Into<JsonValue>) -> Self {
        self.response = Some(response.into());
        self
    }

    /// Replaces the approval test.
    #[must_use]
    pub fn with_evaluate(mut self, evaluate: impl Fn(&JsonValue) -> bool + Send + Sync + 'static) -> Self {
        self.evaluate = Some(Evaluate::new(evaluate));
        self
    }

    pub(crate) fn approves(&self, response: &JsonValue) -> bool {
        match &self.evaluate {
            Some(evaluate) => evaluate(response),
            None => default_evaluate(response),
        }
    }
}

impl fmt::Debug for Confirm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Confirm")
            .field("prompt", &self.prompt)
            .field("reason", &self.reason)
            .field("response", &self.response)
            .field("evaluate", &self.evaluate.as_ref().map(|_| ".."))
            .finish()
    }
}

/// Mutates the event in place before execution continues (`Transform`); later handlers see the
/// change. An error from the mutation is handled by the handler's
/// [`on_error`](super::InterventionHandler::on_error) policy.
#[non_exhaustive]
pub struct Transform<E> {
    pub(crate) apply: TransformFn<E>,
    /// Debugging metadata; not shown to the model.
    pub reason: Option<String>,
}

impl<E> Transform<E> {
    /// A transform from a closure returning `()` or a `Result`.
    pub fn new<R: HookOutput>(apply: impl FnOnce(&mut E) -> R + Send + 'static) -> Self {
        Self {
            apply: Box::new(move |event| apply(event).into_hook_result()),
            reason: None,
        }
    }

    /// Sets the debugging reason.
    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

impl<E> fmt::Debug for Transform<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Transform")
            .field("reason", &self.reason)
            .finish_non_exhaustive()
    }
}

/// What a handler decides at a lifecycle point (`InterventionAction`), for the event `E` it was
/// given.
///
/// | Action      | before_invocation | before_tool_call | before_model_call | after_tool_call | after_model_call |
/// |-------------|-------------------|------------------|-------------------|-----------------|------------------|
/// | `Proceed`   | -                 | -                | -                 | -               | -                |
/// | `Deny`      | cancel            | cancel           | cancel            | no effect       | no effect        |
/// | `Guide`     | cancel            | cancel           | inject            | no effect       | inject and retry |
/// | `Confirm`   | no effect         | confirm          | no effect         | no effect       | no effect        |
/// | `Transform` | apply             | apply            | apply             | apply           | apply            |
///
/// A cancel by `Deny` (or a rejected `Confirm`) skips the remaining handlers; an action with no
/// effect logs a warning.
///
/// ```
/// use strands::hooks::BeforeToolCallEvent;
/// use strands::interventions::InterventionAction;
///
/// let deny = InterventionAction::<BeforeToolCallEvent>::deny("not authorized");
/// assert_eq!(deny.action_type(), "deny");
/// let redact = InterventionAction::transform(|event: &mut BeforeToolCallEvent| {
///     event.tool_use_mut().input = serde_json::json!({});
/// });
/// assert_eq!(redact.action_type(), "transform");
/// ```
#[non_exhaustive]
pub enum InterventionAction<E> {
    /// Continue unchanged.
    Proceed(Proceed),
    /// Block the operation.
    Deny(Deny),
    /// Steer the model with feedback.
    Guide(Guide),
    /// Ask a human first.
    Confirm(Confirm),
    /// Mutate the event.
    Transform(Transform<E>),
}

impl<E> InterventionAction<E> {
    /// Continue unchanged (`proceed`).
    #[must_use]
    pub fn proceed() -> Self {
        Self::Proceed(Proceed::new())
    }

    /// Block the operation (`deny`); the reason is shown to the model.
    pub fn deny(reason: impl Into<String>) -> Self {
        Self::Deny(Deny::new(reason))
    }

    /// Steer the model (`guide`); the feedback is shown to the model.
    pub fn guide(feedback: impl Into<String>) -> Self {
        Self::Guide(Guide::new(feedback))
    }

    /// Ask a human (`confirm`), with the default approval test and no pre-collected answer. Build
    /// a [`Confirm`] for the options.
    pub fn confirm(prompt: impl Into<String>) -> Self {
        Self::Confirm(Confirm::new(prompt))
    }

    /// Mutate the event (`transform`), with a closure returning `()` or a `Result`.
    pub fn transform<R: HookOutput>(apply: impl FnOnce(&mut E) -> R + Send + 'static) -> Self {
        Self::Transform(Transform::new(apply))
    }

    /// The action's `type` tag: `proceed`, `deny`, `guide`, `confirm` or `transform`.
    #[must_use]
    pub fn action_type(&self) -> &'static str {
        match self {
            Self::Proceed(_) => "proceed",
            Self::Deny(_) => "deny",
            Self::Guide(_) => "guide",
            Self::Confirm(_) => "confirm",
            Self::Transform(_) => "transform",
        }
    }
}

impl<E> fmt::Debug for InterventionAction<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Proceed(action) => action.fmt(f),
            Self::Deny(action) => action.fmt(f),
            Self::Guide(action) => action.fmt(f),
            Self::Confirm(action) => action.fmt(f),
            Self::Transform(action) => action.fmt(f),
        }
    }
}

impl<E> From<Proceed> for InterventionAction<E> {
    fn from(action: Proceed) -> Self {
        Self::Proceed(action)
    }
}

impl<E> From<Deny> for InterventionAction<E> {
    fn from(action: Deny) -> Self {
        Self::Deny(action)
    }
}

impl<E> From<Guide> for InterventionAction<E> {
    fn from(action: Guide) -> Self {
        Self::Guide(action)
    }
}

impl<E> From<Confirm> for InterventionAction<E> {
    fn from(action: Confirm) -> Self {
        Self::Confirm(action)
    }
}

impl<E> From<Transform<E>> for InterventionAction<E> {
    fn from(action: Transform<E>) -> Self {
        Self::Transform(action)
    }
}
