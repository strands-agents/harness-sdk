//! The [`InterventionHandler`] trait.

use std::sync::Arc;

use async_trait::async_trait;

use super::actions::InterventionAction;
use crate::error::BoxError;
use crate::hooks::{
    AfterModelCallEvent, AfterToolCallEvent, BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent,
};

/// What a lifecycle method returns: the action for its event, or an error that the handler's
/// [`OnError`] policy resolves.
pub type InterventionResult<E> = Result<InterventionAction<E>, BoxError>;

/// What happens when a handler fails during evaluation (`OnError`).
///
/// An interrupt raised by a handler is never a failure: it always stops the agent for human input.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum OnError {
    /// Fail the invocation with the error (the default and safest: a broken policy check blocks
    /// execution).
    #[default]
    Throw,
    /// Continue as if the handler returned `Proceed`. This is fail-open: a broken handler stops
    /// enforcing its policy.
    Proceed,
    /// Treat the failure as a `Deny` with the reason `Handler threw: <error>` (fail-closed).
    Deny,
}

/// A policy evaluated at the agent's lifecycle points (`InterventionHandler`).
///
/// Override the methods you care about; the others return `Proceed`. Handlers run in registration
/// order, after the agent's other hooks on `Before*` events
/// ([`HookOrder::INTERVENTION_INPUT`](crate::HookOrder::INTERVENTION_INPUT)) and before them on
/// `After*` events ([`HookOrder::INTERVENTION_OUTPUT`](crate::HookOrder::INTERVENTION_OUTPUT)).
/// Tool calls made with [`ToolAgent::call_tool`](crate::ToolAgent::call_tool) are gated too.
/// Methods on events that borrow the agent name the lifetime, as in
/// `async fn before_model_call<'a>(&self, event: &mut BeforeModelCallEvent<'a>) -> InterventionResult<BeforeModelCallEvent<'a>>`.
///
/// ```
/// use strands::hooks::BeforeToolCallEvent;
/// use strands::interventions::{InterventionAction, InterventionHandler, InterventionResult};
///
/// struct NoShell;
///
/// #[strands::async_trait]
/// impl InterventionHandler for NoShell {
///     fn name(&self) -> &str {
///         "no-shell"
///     }
///
///     async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
///         if event.tool_use().name == "shell" {
///             return Ok(InterventionAction::deny("shell is disabled"));
///         }
///         Ok(InterventionAction::proceed())
///     }
/// }
///
/// let agent = strands::Agent::builder()
///     .model(strands::testing::MockModel::new())
///     .interventions([NoShell])
///     .printer(false)
///     .build()?;
/// # let _ = agent;
/// # Ok::<(), strands::Error>(())
/// ```
#[async_trait]
pub trait InterventionHandler: Send + Sync + 'static {
    /// The handler's name, unique among an agent's handlers; also the name of the interrupt a
    /// `Confirm` raises.
    fn name(&self) -> &str;

    /// What to do when this handler fails. Defaults to [`OnError::Throw`].
    fn on_error(&self) -> OnError {
        OnError::Throw
    }

    /// Evaluates the invocation before it starts.
    ///
    /// # Errors
    ///
    /// Any error is resolved by [`on_error`](Self::on_error).
    async fn before_invocation<'a>(
        &self,
        _event: &mut BeforeInvocationEvent<'a>,
    ) -> InterventionResult<BeforeInvocationEvent<'a>> {
        Ok(InterventionAction::proceed())
    }

    /// Evaluates a tool call before it runs.
    ///
    /// # Errors
    ///
    /// Any error is resolved by [`on_error`](Self::on_error).
    async fn before_tool_call(&self, _event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        Ok(InterventionAction::proceed())
    }

    /// Evaluates a tool result.
    ///
    /// # Errors
    ///
    /// Any error is resolved by [`on_error`](Self::on_error).
    async fn after_tool_call(&self, _event: &mut AfterToolCallEvent) -> InterventionResult<AfterToolCallEvent> {
        Ok(InterventionAction::proceed())
    }

    /// Evaluates a model call before it is made.
    ///
    /// # Errors
    ///
    /// Any error is resolved by [`on_error`](Self::on_error).
    async fn before_model_call<'a>(
        &self,
        _event: &mut BeforeModelCallEvent<'a>,
    ) -> InterventionResult<BeforeModelCallEvent<'a>> {
        Ok(InterventionAction::proceed())
    }

    /// Evaluates a model response.
    ///
    /// # Errors
    ///
    /// Any error is resolved by [`on_error`](Self::on_error).
    async fn after_model_call<'a>(
        &self,
        _event: &mut AfterModelCallEvent<'a>,
    ) -> InterventionResult<AfterModelCallEvent<'a>> {
        Ok(InterventionAction::proceed())
    }
}

/// A shared handler is a handler, so `Arc<dyn InterventionHandler>` and `Arc<H>` go wherever
/// handlers do.
#[async_trait]
impl<H: InterventionHandler + ?Sized> InterventionHandler for Arc<H> {
    fn name(&self) -> &str {
        (**self).name()
    }

    fn on_error(&self) -> OnError {
        (**self).on_error()
    }

    async fn before_invocation<'a>(
        &self,
        event: &mut BeforeInvocationEvent<'a>,
    ) -> InterventionResult<BeforeInvocationEvent<'a>> {
        (**self).before_invocation(event).await
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        (**self).before_tool_call(event).await
    }

    async fn after_tool_call(&self, event: &mut AfterToolCallEvent) -> InterventionResult<AfterToolCallEvent> {
        (**self).after_tool_call(event).await
    }

    async fn before_model_call<'a>(
        &self,
        event: &mut BeforeModelCallEvent<'a>,
    ) -> InterventionResult<BeforeModelCallEvent<'a>> {
        (**self).before_model_call(event).await
    }

    async fn after_model_call<'a>(
        &self,
        event: &mut AfterModelCallEvent<'a>,
    ) -> InterventionResult<AfterModelCallEvent<'a>> {
        (**self).after_model_call(event).await
    }
}
