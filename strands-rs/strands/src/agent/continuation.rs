//! Continuation input: messages that SDK components contribute at `AfterInvocationEvent` (a
//! follow-up pass) or `BeforeModelCallEvent` (before the call), appended to history ahead of the
//! caller's input. Crate-internal.

use std::fmt;

use super::event_loop::normalize_input;
use super::invoke_args::InvokeArgs;
use crate::error::Error;
use crate::types::{ContentBlock, Message, Role, StopReason};

pub(crate) const STREAM_CLOSED: &str =
    "Agent stream closed before continuation input was incorporated into agent history";

type Appended = Box<dyn FnOnce() + Send + Sync>;
type Abandoned = Box<dyn FnOnce(&Error) + Send + Sync>;

/// One input contribution (`ContinuationInput`). Exactly one of its callbacks runs, once:
/// `on_appended` when its messages reach history, `on_abandoned` otherwise. An input dropped
/// before either ran is abandoned because the stream closed.
pub(crate) struct ContinuationInput {
    args: InvokeArgs,
    on_appended: Option<Appended>,
    on_abandoned: Option<Abandoned>,
}

impl ContinuationInput {
    pub(crate) fn new(args: impl Into<InvokeArgs>) -> Self {
        Self {
            args: args.into(),
            on_appended: None,
            on_abandoned: None,
        }
    }

    pub(crate) fn on_appended(mut self, callback: impl FnOnce() + Send + Sync + 'static) -> Self {
        self.on_appended = Some(Box::new(callback));
        self
    }

    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "contributors may observe abandonment; only the tests register a callback"
        )
    )]
    pub(crate) fn on_abandoned(mut self, callback: impl FnOnce(&Error) + Send + Sync + 'static) -> Self {
        self.on_abandoned = Some(Box::new(callback));
        self
    }

    fn appended(mut self) {
        self.on_abandoned = None;
        if let Some(callback) = self.on_appended.take() {
            callback();
        }
    }

    pub(crate) fn abandon(mut self, reason: &Error) {
        self.on_appended = None;
        if let Some(callback) = self.on_abandoned.take() {
            callback(reason);
        }
    }
}

impl Drop for ContinuationInput {
    fn drop(&mut self) {
        if let Some(callback) = self.on_abandoned.take() {
            callback(&Error::other(STREAM_CLOSED));
        }
    }
}

impl fmt::Debug for ContinuationInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContinuationInput")
            .field("args", &self.args)
            .finish_non_exhaustive()
    }
}

/// Inputs normalized into complete message sequences, waiting to be appended.
#[derive(Debug, Default)]
pub(crate) struct Prepared {
    inputs: Vec<ContinuationInput>,
    pub(crate) messages: Vec<Message>,
}

impl Prepared {
    /// Runs the append callbacks.
    pub(crate) fn mark_appended(self) {
        for input in self.inputs {
            input.appended();
        }
    }

    /// Runs the abandon callbacks (`abandon`).
    pub(crate) fn abandon(self, reason: &str) {
        abandon(self.inputs, reason);
    }
}

pub(crate) fn abandon(inputs: Vec<ContinuationInput>, reason: &str) {
    let reason = Error::other(reason.to_owned());
    for input in inputs {
        input.abandon(&reason);
    }
}

/// Normalizes the inputs that form complete message sequences (`prepare`). After an interrupt
/// the inputs wait in `deferred` for the pass that resumes; after another stop than `EndTurn`
/// or `StopSequence` nothing continues.
pub(crate) fn prepare(
    inputs: Vec<ContinuationInput>,
    stop_reason: Option<&StopReason>,
    deferred: Option<&mut Vec<ContinuationInput>>,
) -> Option<Prepared> {
    if stop_reason == Some(&StopReason::Interrupt) {
        if let Some(deferred) = deferred {
            deferred.extend(inputs);
        }
        return None;
    }
    if let Some(stop) = stop_reason
        && !matches!(stop, StopReason::EndTurn | StopReason::StopSequence)
    {
        abandon(inputs, &format!("Continuation abandoned after {stop}"));
        return None;
    }
    let mut all = deferred.map(std::mem::take).unwrap_or_default();
    all.extend(inputs);
    let mut prepared = Prepared::default();
    for input in all {
        match normalize_input(&input.args) {
            Ok(messages) if is_complete_message_input(&messages) => {
                prepared.messages.extend(messages);
                prepared.inputs.push(input);
            }
            Ok(_) => input.abandon(&Error::other(
                "Continuation input must contain a complete message sequence",
            )),
            Err(error) => input.abandon(&error),
        }
    }
    (!prepared.inputs.is_empty()).then_some(prepared)
}

/// Whether the messages end with a user turn and pair every tool use with its result.
fn is_complete_message_input(messages: &[Message]) -> bool {
    if messages.last().is_none_or(|message| message.role != Role::User) {
        return false;
    }
    let mut pending: Vec<&str> = Vec::new();
    for message in messages {
        if !pending.is_empty() && message.role != Role::User {
            return false;
        }
        let mut next: Vec<&str> = Vec::new();
        for block in &message.content {
            match block {
                ContentBlock::ToolUse(tool_use) => {
                    if message.role != Role::Assistant || next.contains(&tool_use.tool_use_id.as_str()) {
                        return false;
                    }
                    next.push(&tool_use.tool_use_id);
                }
                ContentBlock::ToolResult(result) => {
                    let Some(index) = pending.iter().position(|id| *id == result.tool_use_id) else {
                        return false;
                    };
                    if message.role != Role::User {
                        return false;
                    }
                    pending.remove(index);
                }
                _ => {}
            }
        }
        if message.role == Role::User && !pending.is_empty() {
            return false;
        }
        pending = next;
    }
    pending.is_empty()
}

#[cfg(test)]
mod tests;
