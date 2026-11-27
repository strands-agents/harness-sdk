//! Dispatch of intervention handlers through the hooks.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;

use super::actions::{Guide, InterventionAction};
use super::handler::{InterventionHandler, InterventionResult, OnError};
use crate::error::{BoxError, Error, Result};
use crate::hooks::{
    AfterModelCallEvent, AfterToolCallEvent, BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, Hook,
    HookCallbackOptions, HookOrder, HookRegistry,
};
use crate::types::{ContentBlock, InterruptParams, Message, Role};

type Handlers = Arc<[Arc<dyn InterventionHandler>]>;

/// Bridges an agent's handlers and its hooks (`InterventionRegistry`): one hook per lifecycle
/// event dispatches to every handler in registration order, short-circuiting on a cancel and
/// accumulating guidance.
pub(crate) struct InterventionRegistry {
    handlers: Handlers,
}

impl InterventionRegistry {
    /// Checks the handler names.
    ///
    /// # Errors
    ///
    /// `Duplicate intervention handler name: '<name>'` when two handlers share a name.
    pub(crate) fn new(handlers: Vec<Arc<dyn InterventionHandler>>) -> Result<Self> {
        let mut seen = HashSet::new();
        for handler in &handlers {
            if !seen.insert(handler.name().to_owned()) {
                return Err(Error::other(format!(
                    "Duplicate intervention handler name: '{}'",
                    handler.name()
                )));
            }
        }
        Ok(Self {
            handlers: handlers.into(),
        })
    }

    /// The handlers in registration order; subagent children share them.
    pub(crate) fn handlers(&self) -> Arc<[Arc<dyn InterventionHandler>]> {
        self.handlers.clone()
    }

    /// Registers the dispatching hooks; nothing when there are no handlers.
    pub(crate) fn register(&self, hooks: &HookRegistry) {
        if self.handlers.is_empty() {
            return;
        }
        let input = HookCallbackOptions {
            order: HookOrder::INTERVENTION_INPUT,
        };
        let output = HookCallbackOptions {
            order: HookOrder::INTERVENTION_OUTPUT,
        };
        let dispatcher = Dispatcher(self.handlers.clone());
        hooks.add_hook_impl_with::<BeforeInvocationEvent<'_>>(dispatcher.clone(), input);
        hooks.add_hook_impl_with::<BeforeToolCallEvent>(dispatcher.clone(), input);
        hooks.add_hook_impl_with::<AfterToolCallEvent>(dispatcher.clone(), output);
        hooks.add_hook_impl_with::<BeforeModelCallEvent<'_>>(dispatcher.clone(), input);
        hooks.add_hook_impl_with::<AfterModelCallEvent<'_>>(dispatcher, output);
    }
}

#[derive(Clone)]
struct Dispatcher(Handlers);

/// One lifecycle method: how to call it and how its actions change the event.
trait Lifecycle<E: Send> {
    const METHOD: &'static str;

    fn call<'x>(handler: &'x dyn InterventionHandler, event: &'x mut E) -> BoxFuture<'x, InterventionResult<E>>;

    /// Applies the action; `true` short-circuits the remaining handlers.
    fn apply(event: &mut E, action: InterventionAction<E>, handler: &str) -> std::result::Result<bool, BoxError>;
}

struct OnBeforeInvocation;
struct OnBeforeToolCall;
struct OnAfterToolCall;
struct OnBeforeModelCall;
struct OnAfterModelCall;

fn no_effect<E>(action: &InterventionAction<E>, handler: &str, method: &str) -> bool {
    tracing::warn!(
        "handler=<{handler}>, event=<{method}> | {} has no effect",
        action.action_type()
    );
    false
}

fn user_message(feedback: String) -> Message {
    Message::new(Role::User, vec![ContentBlock::text(feedback)])
}

impl<'a> Lifecycle<BeforeInvocationEvent<'a>> for OnBeforeInvocation {
    const METHOD: &'static str = "beforeInvocation";

    fn call<'x>(
        handler: &'x dyn InterventionHandler,
        event: &'x mut BeforeInvocationEvent<'a>,
    ) -> BoxFuture<'x, InterventionResult<BeforeInvocationEvent<'a>>> {
        handler.before_invocation(event)
    }

    fn apply(
        event: &mut BeforeInvocationEvent<'a>,
        action: InterventionAction<BeforeInvocationEvent<'a>>,
        handler: &str,
    ) -> std::result::Result<bool, BoxError> {
        match action {
            InterventionAction::Deny(deny) => {
                event.set_cancel(format!("DENIED: {}", deny.reason));
                Ok(true)
            }
            InterventionAction::Guide(guide) => {
                event.set_cancel(format!("GUIDANCE: {}", guide.feedback));
                Ok(false)
            }
            InterventionAction::Transform(transform) => (transform.apply)(event).map(|()| false),
            InterventionAction::Proceed(_) => Ok(false),
            action => Ok(no_effect(&action, handler, Self::METHOD)),
        }
    }
}

impl Lifecycle<BeforeToolCallEvent> for OnBeforeToolCall {
    const METHOD: &'static str = "beforeToolCall";

    fn call<'x>(
        handler: &'x dyn InterventionHandler,
        event: &'x mut BeforeToolCallEvent,
    ) -> BoxFuture<'x, InterventionResult<BeforeToolCallEvent>> {
        handler.before_tool_call(event)
    }

    fn apply(
        event: &mut BeforeToolCallEvent,
        action: InterventionAction<BeforeToolCallEvent>,
        handler: &str,
    ) -> std::result::Result<bool, BoxError> {
        match action {
            InterventionAction::Deny(deny) => {
                event.set_cancel(format!("DENIED: {}", deny.reason));
                Ok(true)
            }
            InterventionAction::Confirm(confirm) => {
                let mut params = InterruptParams::new(handler).with_reason(confirm.prompt.clone());
                params.response.clone_from(&confirm.response);
                let response = event.interrupt(params)?;
                if confirm.approves(&response) {
                    return Ok(false);
                }
                event.set_cancel(format!("CONFIRMATION_FAILED: {}", confirm.prompt));
                Ok(true)
            }
            InterventionAction::Guide(guide) => {
                event.set_cancel(format!("GUIDANCE: {}", guide.feedback));
                Ok(false)
            }
            InterventionAction::Transform(transform) => (transform.apply)(event).map(|()| false),
            InterventionAction::Proceed(_) => Ok(false),
        }
    }
}

impl Lifecycle<AfterToolCallEvent> for OnAfterToolCall {
    const METHOD: &'static str = "afterToolCall";

    fn call<'x>(
        handler: &'x dyn InterventionHandler,
        event: &'x mut AfterToolCallEvent,
    ) -> BoxFuture<'x, InterventionResult<AfterToolCallEvent>> {
        handler.after_tool_call(event)
    }

    fn apply(
        event: &mut AfterToolCallEvent,
        action: InterventionAction<AfterToolCallEvent>,
        handler: &str,
    ) -> std::result::Result<bool, BoxError> {
        match action {
            InterventionAction::Transform(transform) => (transform.apply)(event).map(|()| false),
            InterventionAction::Proceed(_) => Ok(false),
            action => Ok(no_effect(&action, handler, Self::METHOD)),
        }
    }
}

impl<'a> Lifecycle<BeforeModelCallEvent<'a>> for OnBeforeModelCall {
    const METHOD: &'static str = "beforeModelCall";

    fn call<'x>(
        handler: &'x dyn InterventionHandler,
        event: &'x mut BeforeModelCallEvent<'a>,
    ) -> BoxFuture<'x, InterventionResult<BeforeModelCallEvent<'a>>> {
        handler.before_model_call(event)
    }

    fn apply(
        event: &mut BeforeModelCallEvent<'a>,
        action: InterventionAction<BeforeModelCallEvent<'a>>,
        handler: &str,
    ) -> std::result::Result<bool, BoxError> {
        match action {
            InterventionAction::Deny(deny) => {
                event.set_cancel(format!("DENIED: {}", deny.reason));
                Ok(true)
            }
            // Pushed directly: no `MessageAddedEvent`, no conversation management.
            InterventionAction::Guide(guide) => {
                event.agent_mut().messages_mut().push(user_message(guide.feedback));
                Ok(false)
            }
            InterventionAction::Transform(transform) => (transform.apply)(event).map(|()| false),
            InterventionAction::Proceed(_) => Ok(false),
            action => Ok(no_effect(&action, handler, Self::METHOD)),
        }
    }
}

impl<'a> Lifecycle<AfterModelCallEvent<'a>> for OnAfterModelCall {
    const METHOD: &'static str = "afterModelCall";

    fn call<'x>(
        handler: &'x dyn InterventionHandler,
        event: &'x mut AfterModelCallEvent<'a>,
    ) -> BoxFuture<'x, InterventionResult<AfterModelCallEvent<'a>>> {
        handler.after_model_call(event)
    }

    fn apply(
        event: &mut AfterModelCallEvent<'a>,
        action: InterventionAction<AfterModelCallEvent<'a>>,
        handler: &str,
    ) -> std::result::Result<bool, BoxError> {
        match action {
            // Pushed directly: no `MessageAddedEvent`, no conversation management.
            InterventionAction::Guide(guide) => {
                event.set_retry(true);
                event.agent_mut().messages_mut().push(user_message(guide.feedback));
                Ok(false)
            }
            InterventionAction::Transform(transform) => (transform.apply)(event).map(|()| false),
            InterventionAction::Proceed(_) => Ok(false),
            action => Ok(no_effect(&action, handler, Self::METHOD)),
        }
    }
}

/// Resolves a handler failure by its policy: an interrupt or `Throw` propagates, `Deny` becomes a
/// denial, `Proceed` skips the handler.
fn on_failure<E>(
    handler: &dyn InterventionHandler,
    error: BoxError,
) -> std::result::Result<Option<InterventionAction<E>>, BoxError> {
    let error = Error::from_boxed(error);
    if matches!(error, Error::Interrupt(_)) {
        return Err(Box::new(error));
    }
    match handler.on_error() {
        OnError::Deny => Ok(Some(InterventionAction::deny(format!("Handler threw: {error}")))),
        OnError::Proceed => Ok(None),
        _ => Err(Box::new(error)),
    }
}

/// Runs the handlers for one event (`_dispatch`): a cancel short-circuits, guidance accumulates
/// and is applied once at the end, transforms apply in place so later handlers see them.
async fn dispatch<E: Send, L: Lifecycle<E>>(handlers: &Handlers, event: &mut E) -> std::result::Result<(), BoxError> {
    let method = L::METHOD;
    tracing::debug!("event=<{method}> | dispatching to {} handler(s)", handlers.len());
    let mut guides: Vec<(String, Guide)> = Vec::new();
    for handler in handlers.iter() {
        let name = handler.name();
        tracing::debug!("handler=<{name}>, event=<{method}> | evaluating");
        let action = match L::call(handler.as_ref(), event).await {
            Ok(action) => action,
            Err(error) => match on_failure(handler.as_ref(), error)? {
                Some(action) => action,
                None => continue,
            },
        };
        tracing::debug!("handler=<{name}>, event=<{method}> | returned {}", action.action_type());
        if let InterventionAction::Guide(guide) = action {
            guides.push((name.to_owned(), guide));
            continue;
        }
        if apply_or_resolve::<E, L>(handler.as_ref(), event, action)? {
            tracing::debug!("handler=<{name}>, event=<{method}> | short-circuited");
            return Ok(());
        }
    }
    if guides.is_empty() {
        return Ok(());
    }
    tracing::debug!(
        "event=<{method}> | applying accumulated guide from {} handler(s)",
        guides.len()
    );
    let feedback = guides
        .iter()
        .map(|(name, guide)| format!("[{name}] {}", guide.feedback))
        .collect::<Vec<_>>()
        .join("\n");
    L::apply(event, InterventionAction::guide(feedback), "")?;
    Ok(())
}

/// Applies an action; a failure while applying it goes through the handler's policy.
fn apply_or_resolve<E: Send, L: Lifecycle<E>>(
    handler: &dyn InterventionHandler,
    event: &mut E,
    action: InterventionAction<E>,
) -> std::result::Result<bool, BoxError> {
    let error = match L::apply(event, action, handler.name()) {
        Ok(short_circuit) => return Ok(short_circuit),
        Err(error) => error,
    };
    match on_failure(handler, error)? {
        Some(action) => L::apply(event, action, handler.name()),
        None => Ok(false),
    }
}

#[async_trait]
impl<'a> Hook<BeforeInvocationEvent<'a>> for Dispatcher {
    async fn handle(&self, event: &mut BeforeInvocationEvent<'a>) -> std::result::Result<(), BoxError> {
        dispatch::<_, OnBeforeInvocation>(&self.0, event).await
    }
}

#[async_trait]
impl Hook<BeforeToolCallEvent> for Dispatcher {
    async fn handle(&self, event: &mut BeforeToolCallEvent) -> std::result::Result<(), BoxError> {
        dispatch::<_, OnBeforeToolCall>(&self.0, event).await
    }
}

#[async_trait]
impl Hook<AfterToolCallEvent> for Dispatcher {
    async fn handle(&self, event: &mut AfterToolCallEvent) -> std::result::Result<(), BoxError> {
        dispatch::<_, OnAfterToolCall>(&self.0, event).await
    }
}

#[async_trait]
impl<'a> Hook<BeforeModelCallEvent<'a>> for Dispatcher {
    async fn handle(&self, event: &mut BeforeModelCallEvent<'a>) -> std::result::Result<(), BoxError> {
        dispatch::<_, OnBeforeModelCall>(&self.0, event).await
    }
}

#[async_trait]
impl<'a> Hook<AfterModelCallEvent<'a>> for Dispatcher {
    async fn handle(&self, event: &mut AfterModelCallEvent<'a>) -> std::result::Result<(), BoxError> {
        dispatch::<_, OnAfterModelCall>(&self.0, event).await
    }
}

/// Handler dispatch and the actions' effects.
#[cfg(test)]
mod tests;
