//! The 17 hook events.
//!
//! Sequential events run on the agent loop and lend callbacks the mutable [`LocalAgent`]
//! (`BeforeInvocationEvent<'a>`). Per-tool events ([`BeforeToolCallEvent`],
//! [`AfterToolCallEvent`], [`ToolStreamUpdateEvent`], [`ToolResultEvent`]) run inside tool tasks
//! and hold a [`ToolAgent`].
//!
//! Fields are private; every field has a getter, and only the fields hooks may write have
//! setters. The serializable records of these events are in [`AgentStreamEvent`].
//!
//! [`AgentStreamEvent`]: super::AgentStreamEvent

use std::fmt;
use std::sync::Arc;

use crate::agent::continuation::ContinuationInput;
use crate::agent::{AgentResult, InvocationContext, InvocationState, InvokeArgs, LocalAgent, ToolAgent};
use crate::error::Error;
use crate::interrupt::{Interrupt, InterruptError, InterruptSource};
use crate::models::streaming::ModelStreamEvent;
use crate::models::{Model, Redaction};
use crate::tools::{Tool, ToolStreamEvent};
use crate::types::{
    ContentBlock, InterruptParams, JsonValue, Message, StopReason, ToolResultBlock, ToolResultError, ToolUse,
};

/// The tool-use descriptor on tool-call events (`ToolUseData`): the shape of the model's tool use.
pub type ToolUseData = ToolUse;

/// A hook's request to cancel an operation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum Cancel {
    /// Not cancelled (`false`).
    #[default]
    NotCancelled,
    /// Cancelled with the default message (`true`).
    Cancelled,
    /// Cancelled with this message (a string).
    Message(String),
}

impl Cancel {
    /// Whether cancellation was requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        !matches!(self, Self::NotCancelled)
    }

    /// The cancel message, or `default` for a plain cancel; `None` when not cancelled.
    #[must_use]
    pub fn message_or<'a>(&'a self, default: &'a str) -> Option<&'a str> {
        match self {
            Self::NotCancelled => None,
            Self::Cancelled => Some(default),
            Self::Message(message) => Some(message),
        }
    }
}

impl From<bool> for Cancel {
    fn from(cancel: bool) -> Self {
        if cancel { Self::Cancelled } else { Self::NotCancelled }
    }
}

impl From<&str> for Cancel {
    fn from(message: &str) -> Self {
        Self::Message(message.to_owned())
    }
}

impl From<String> for Cancel {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

/// A hook's request to end the turn after a tool batch.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub enum EndTurn {
    /// Keep going (`false`).
    #[default]
    Continue,
    /// End with the default message `Turn ended early by hook after tool execution` (`true`).
    End,
    /// End with this text as the final assistant message (a string).
    Message(String),
    /// End with these blocks as the final assistant message (`ContentBlock[]`).
    Content(Vec<ContentBlock>),
}

impl EndTurn {
    /// Whether ending the turn was requested.
    #[must_use]
    pub fn is_end(&self) -> bool {
        !matches!(self, Self::Continue)
    }
}

impl From<bool> for EndTurn {
    fn from(end: bool) -> Self {
        if end { Self::End } else { Self::Continue }
    }
}

impl From<&str> for EndTurn {
    fn from(message: &str) -> Self {
        Self::Message(message.to_owned())
    }
}

impl From<String> for EndTurn {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<Vec<ContentBlock>> for EndTurn {
    fn from(content: Vec<ContentBlock>) -> Self {
        Self::Content(content)
    }
}

/// What a model call returned (`ModelStopResponse`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelStopResponse {
    /// The message the model returned.
    pub message: Message,
    /// Why the model stopped.
    pub stop_reason: StopReason,
    /// Set when guardrails redacted the last user message; the redacted message is the last one
    /// in the agent's history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redaction: Option<Redaction>,
}

impl ModelStopResponse {
    /// Creates the response.
    pub fn new(message: Message, stop_reason: StopReason) -> Self {
        Self {
            message,
            stop_reason,
            redaction: None,
        }
    }

    /// Sets the redaction.
    #[must_use]
    pub fn with_redaction(mut self, redaction: Redaction) -> Self {
        self.redaction = Some(redaction);
        self
    }
}

/// Fields every sequential event carries.
struct Sequential<'a> {
    agent: &'a mut LocalAgent,
    invocation_state: InvocationState,
    invocation_context: Option<InvocationContext>,
}

impl<'a> Sequential<'a> {
    fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState) -> Self {
        Self {
            agent,
            invocation_state,
            invocation_context: None,
        }
    }
}

/// Fields every per-tool event carries.
#[derive(Clone)]
struct PerTool {
    agent: ToolAgent,
    invocation_state: InvocationState,
    invocation_context: Option<InvocationContext>,
}

impl PerTool {
    fn new(agent: ToolAgent, invocation_state: InvocationState) -> Self {
        let invocation_context = agent.invocation_context().cloned();
        Self {
            agent,
            invocation_state,
            invocation_context,
        }
    }
}

macro_rules! sequential_accessors {
    ($event:ident) => {
        impl<'a> $event<'a> {
            /// The agent.
            #[must_use]
            pub fn agent(&self) -> &LocalAgent {
                self.base.agent
            }

            /// The agent, mutably: hooks may change its messages, system prompt, tools and state.
            pub fn agent_mut(&mut self) -> &mut LocalAgent {
                self.base.agent
            }

            /// The caller's per-invocation state.
            #[must_use]
            pub fn invocation_state(&self) -> &InvocationState {
                &self.base.invocation_state
            }

            /// The request this event belongs to.
            #[must_use]
            pub fn invocation_context(&self) -> Option<&InvocationContext> {
                self.base.invocation_context.as_ref()
            }

            pub(crate) fn with_invocation_context(mut self, context: Option<InvocationContext>) -> Self {
                self.base.invocation_context = context;
                self
            }
        }

        impl fmt::Debug for $event<'_> {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.debug_struct(stringify!($event)).finish_non_exhaustive()
            }
        }
    };
}

macro_rules! per_tool_accessors {
    ($event:ident) => {
        impl $event {
            /// The agent running the tool.
            #[must_use]
            pub fn agent(&self) -> &ToolAgent {
                &self.base.agent
            }

            /// The caller's per-invocation state.
            #[must_use]
            pub fn invocation_state(&self) -> &InvocationState {
                &self.base.invocation_state
            }

            /// The request this event belongs to.
            #[must_use]
            pub fn invocation_context(&self) -> Option<&InvocationContext> {
                self.base.invocation_context.as_ref()
            }
        }

        impl fmt::Debug for $event {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.debug_struct(stringify!($event)).finish_non_exhaustive()
            }
        }
    };
}

/// The agent finished construction and initialized its built-in components (`InitializedEvent`).
///
/// It fires outside any invocation, so it carries no invocation state.
#[non_exhaustive]
pub struct InitializedEvent<'a> {
    agent: &'a mut LocalAgent,
}

impl<'a> InitializedEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent) -> Self {
        Self { agent }
    }

    /// The agent.
    #[must_use]
    pub fn agent(&self) -> &LocalAgent {
        self.agent
    }

    /// The agent, mutably.
    pub fn agent_mut(&mut self) -> &mut LocalAgent {
        self.agent
    }
}

impl fmt::Debug for InitializedEvent<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InitializedEvent").finish_non_exhaustive()
    }
}

/// A new request is starting, before any model call or tool runs (`BeforeInvocationEvent`).
#[non_exhaustive]
pub struct BeforeInvocationEvent<'a> {
    base: Sequential<'a>,
    messages: Vec<Message>,
    cancel: Cancel,
}

sequential_accessors!(BeforeInvocationEvent);

impl<'a> BeforeInvocationEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, messages: Vec<Message>) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            messages,
            cancel: Cancel::NotCancelled,
        }
    }

    /// The input messages of this invocation.
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// The input messages, to edit before processing.
    pub fn messages_mut(&mut self) -> &mut Vec<Message> {
        &mut self.messages
    }

    /// Replaces the input messages.
    pub fn set_messages(&mut self, messages: Vec<Message>) {
        self.messages = messages;
    }

    /// The cancel request.
    #[must_use]
    pub fn cancel(&self) -> &Cancel {
        &self.cancel
    }

    /// Cancels the invocation: `true` uses the default message, a string becomes the assistant
    /// response.
    pub fn set_cancel(&mut self, cancel: impl Into<Cancel>) {
        self.cancel = cancel.into();
    }

    pub(crate) fn take_messages(&mut self) -> Vec<Message> {
        std::mem::take(&mut self.messages)
    }
}

/// The request ended, successfully or not (`AfterInvocationEvent`). Callbacks with the same order
/// run in reverse registration order.
#[non_exhaustive]
pub struct AfterInvocationEvent<'a> {
    base: Sequential<'a>,
    resume: Option<InvokeArgs>,
    continuation_inputs: Vec<ContinuationInput>,
}

sequential_accessors!(AfterInvocationEvent);

impl<'a> AfterInvocationEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            resume: None,
            continuation_inputs: Vec::new(),
        }
    }

    /// The input of the follow-up invocation, if a hook requested one.
    #[must_use]
    pub fn resume(&self) -> Option<&InvokeArgs> {
        self.resume.as_ref()
    }

    /// Re-enters the loop with `args` once the callbacks finish, with a fresh pair of invocation
    /// events. Ignored when the invocation failed or a limit was reached; the last callback to set
    /// it wins.
    pub fn set_resume(&mut self, args: impl Into<InvokeArgs>) {
        self.resume = Some(args.into());
    }

    /// Clears a requested follow-up invocation.
    pub fn clear_resume(&mut self) {
        self.resume = None;
    }

    pub(crate) fn take_resume(&mut self) -> Option<InvokeArgs> {
        self.resume.take()
    }

    /// Contributes input to a follow-up pass (`continuations.addInput`).
    pub(crate) fn add_continuation_input(&mut self, input: ContinuationInput) {
        self.continuation_inputs.push(input);
    }

    pub(crate) fn take_continuation_inputs(&mut self) -> Vec<ContinuationInput> {
        std::mem::take(&mut self.continuation_inputs)
    }
}

/// The framework added a message to the history (`MessageAddedEvent`).
#[non_exhaustive]
pub struct MessageAddedEvent<'a> {
    base: Sequential<'a>,
    message: Message,
}

sequential_accessors!(MessageAddedEvent);

impl<'a> MessageAddedEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, message: Message) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            message,
        }
    }

    /// The added message.
    #[must_use]
    pub fn message(&self) -> &Message {
        &self.message
    }
}

/// A model call is about to start (`BeforeModelCallEvent`).
#[non_exhaustive]
pub struct BeforeModelCallEvent<'a> {
    base: Sequential<'a>,
    model: Arc<dyn Model>,
    projected_input_tokens: Option<u64>,
    cancel: Cancel,
    continuation_inputs: Vec<ContinuationInput>,
    raised_interrupts: Vec<Interrupt>,
}

sequential_accessors!(BeforeModelCallEvent);

impl<'a> BeforeModelCallEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, model: Arc<dyn Model>) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            model,
            projected_input_tokens: None,
            cancel: Cancel::NotCancelled,
            continuation_inputs: Vec::new(),
            raised_interrupts: Vec::new(),
        }
    }

    /// Contributes input appended before this model call (`continuations.addInput`).
    pub(crate) fn add_continuation_input(&mut self, input: ContinuationInput) {
        self.continuation_inputs.push(input);
    }

    /// Stops the invocation for interrupts raised elsewhere, such as by background tasks that
    /// need input.
    pub(crate) fn raise_interrupts(&mut self, interrupts: Vec<Interrupt>) {
        self.raised_interrupts.extend(interrupts);
    }

    pub(crate) fn take_raised_interrupts(&mut self) -> Vec<Interrupt> {
        std::mem::take(&mut self.raised_interrupts)
    }

    pub(crate) fn take_continuation_inputs(&mut self) -> Vec<ContinuationInput> {
        std::mem::take(&mut self.continuation_inputs)
    }

    #[must_use]
    pub(crate) fn with_projected_input_tokens(mut self, tokens: u64) -> Self {
        self.projected_input_tokens = Some(tokens);
        self
    }

    /// The model about to be called.
    #[must_use]
    pub fn model(&self) -> &Arc<dyn Model> {
        &self.model
    }

    /// The projected input tokens of the call, from message metadata and token estimation.
    #[must_use]
    pub fn projected_input_tokens(&self) -> Option<u64> {
        self.projected_input_tokens
    }

    /// The cancel request.
    #[must_use]
    pub fn cancel(&self) -> &Cancel {
        &self.cancel
    }

    /// Cancels the model call: `true` uses the default message, a string becomes the assistant
    /// response.
    pub fn set_cancel(&mut self, cancel: impl Into<Cancel>) {
        self.cancel = cancel.into();
    }
}

/// A model call finished, successfully or not (`AfterModelCallEvent`). Callbacks with the same
/// order run in reverse registration order.
#[non_exhaustive]
pub struct AfterModelCallEvent<'a> {
    base: Sequential<'a>,
    model: Arc<dyn Model>,
    attempt_count: u32,
    stop_data: Option<ModelStopResponse>,
    error: Option<Error>,
    retry: bool,
}

sequential_accessors!(AfterModelCallEvent);

impl<'a> AfterModelCallEvent<'a> {
    pub(crate) fn new(
        agent: &'a mut LocalAgent,
        invocation_state: InvocationState,
        model: Arc<dyn Model>,
        attempt_count: u32,
    ) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            model,
            attempt_count,
            stop_data: None,
            error: None,
            retry: false,
        }
    }

    #[must_use]
    pub(crate) fn with_stop_data(mut self, stop_data: ModelStopResponse) -> Self {
        self.stop_data = Some(stop_data);
        self
    }

    #[must_use]
    pub(crate) fn with_error(mut self, error: Error) -> Self {
        self.error = Some(error);
        self
    }

    /// The model that was called.
    #[must_use]
    pub fn model(&self) -> &Arc<dyn Model> {
        &self.model
    }

    /// The 1-based model attempt within this turn, counting the one that just finished. A fresh
    /// turn always starts at 1.
    #[must_use]
    pub fn attempt_count(&self) -> u32 {
        self.attempt_count
    }

    /// The model's response; `None` when the call failed.
    #[must_use]
    pub fn stop_data(&self) -> Option<&ModelStopResponse> {
        self.stop_data.as_ref()
    }

    /// The error the call failed with.
    #[must_use]
    pub fn error(&self) -> Option<&Error> {
        self.error.as_ref()
    }

    /// Whether a hook requested a retry of the model call.
    #[must_use]
    pub fn retry(&self) -> bool {
        self.retry
    }

    /// Requests (or withdraws) a retry of the model call.
    pub fn set_retry(&mut self, retry: bool) {
        self.retry = retry;
    }

    pub(crate) fn take_error(&mut self) -> Option<Error> {
        self.error.take()
    }
}

/// One streaming event from the model (`ModelStreamUpdateEvent`).
#[non_exhaustive]
pub struct ModelStreamUpdateEvent<'a> {
    base: Sequential<'a>,
    event: ModelStreamEvent,
}

sequential_accessors!(ModelStreamUpdateEvent);

impl<'a> ModelStreamUpdateEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, event: ModelStreamEvent) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            event,
        }
    }

    /// The model stream event.
    #[must_use]
    pub fn event(&self) -> &ModelStreamEvent {
        &self.event
    }
}

/// A content block the model finished (`ContentBlockEvent`).
#[non_exhaustive]
pub struct ContentBlockEvent<'a> {
    base: Sequential<'a>,
    content_block: ContentBlock,
}

sequential_accessors!(ContentBlockEvent);

impl<'a> ContentBlockEvent<'a> {
    pub(crate) fn new(
        agent: &'a mut LocalAgent,
        invocation_state: InvocationState,
        content_block: ContentBlock,
    ) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            content_block,
        }
    }

    /// The finished block.
    #[must_use]
    pub fn content_block(&self) -> &ContentBlock {
        &self.content_block
    }
}

/// The model finished a message (`ModelMessageEvent`).
#[non_exhaustive]
pub struct ModelMessageEvent<'a> {
    base: Sequential<'a>,
    message: Message,
    stop_reason: StopReason,
}

sequential_accessors!(ModelMessageEvent);

impl<'a> ModelMessageEvent<'a> {
    pub(crate) fn new(
        agent: &'a mut LocalAgent,
        invocation_state: InvocationState,
        message: Message,
        stop_reason: StopReason,
    ) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            message,
            stop_reason,
        }
    }

    /// The assembled message.
    #[must_use]
    pub fn message(&self) -> &Message {
        &self.message
    }

    /// Why the model stopped.
    #[must_use]
    pub fn stop_reason(&self) -> StopReason {
        self.stop_reason.clone()
    }
}

/// The model asked for tools, before any of them runs (`BeforeToolsEvent`).
#[non_exhaustive]
pub struct BeforeToolsEvent<'a> {
    base: Sequential<'a>,
    message: Message,
    cancel: Cancel,
    interrupts: Vec<Interrupt>,
}

sequential_accessors!(BeforeToolsEvent);

impl<'a> BeforeToolsEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, message: Message) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            message,
            cancel: Cancel::NotCancelled,
            interrupts: Vec::new(),
        }
    }

    /// The assistant message with the tool uses.
    #[must_use]
    pub fn message(&self) -> &Message {
        &self.message
    }

    /// The cancel request.
    #[must_use]
    pub fn cancel(&self) -> &Cancel {
        &self.cancel
    }

    /// Cancels every tool call of the batch: `true` uses the default message, a string becomes the
    /// error text of each tool result.
    pub fn set_cancel(&mut self, cancel: impl Into<Cancel>) {
        self.cancel = cancel.into();
    }

    /// Raises an interrupt for human input (`interrupt`), with the id `hook:beforeTools:<name>`.
    ///
    /// Returns the response when the agent resumed with one (or `params` carries a preemptive
    /// response). Otherwise the interrupt is recorded on the event and the agent stops with it
    /// once every callback has run; return the [`InterruptError`] with `?` (it does not fail the
    /// invocation) or simply return from the callback.
    ///
    /// # Errors
    ///
    /// The unanswered interrupt.
    pub fn interrupt(&mut self, params: impl Into<InterruptParams>) -> Result<JsonValue, InterruptError> {
        let params = params.into();
        let id = format!("hook:beforeTools:{}", params.name);
        let raised = self
            .base
            .agent
            .interrupt_state()
            .raise(&id, &params, InterruptSource::Hook);
        raised.inspect_err(|error| self.interrupts.extend(error.interrupts.iter().cloned()))
    }

    pub(crate) fn take_interrupts(&mut self) -> Vec<Interrupt> {
        std::mem::take(&mut self.interrupts)
    }
}

/// Every tool of the batch finished (`AfterToolsEvent`). Callbacks with the same order run in
/// reverse registration order.
#[non_exhaustive]
pub struct AfterToolsEvent<'a> {
    base: Sequential<'a>,
    message: Message,
    end_turn: EndTurn,
}

sequential_accessors!(AfterToolsEvent);

impl<'a> AfterToolsEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, message: Message) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            message,
            end_turn: EndTurn::Continue,
        }
    }

    /// The user message with the tool results.
    #[must_use]
    pub fn message(&self) -> &Message {
        &self.message
    }

    /// The end-turn request.
    #[must_use]
    pub fn end_turn(&self) -> &EndTurn {
        &self.end_turn
    }

    /// Ends the turn after this batch without calling the model again; the stop reason is
    /// `EndTurn`. `true` appends the default message, a string or blocks become the final
    /// assistant message.
    pub fn set_end_turn(&mut self, end_turn: impl Into<EndTurn>) {
        self.end_turn = end_turn.into();
    }
}

/// The final event of an invocation, with its result (`AgentResultEvent`).
#[non_exhaustive]
pub struct AgentResultEvent<'a> {
    base: Sequential<'a>,
    result: AgentResult,
}

sequential_accessors!(AgentResultEvent);

impl<'a> AgentResultEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, result: AgentResult) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            result,
        }
    }

    /// The result.
    #[must_use]
    pub fn result(&self) -> &AgentResult {
        &self.result
    }
}

/// The agent stopped for an unanswered interrupt; one event fires per interrupt
/// (`InterruptEvent`).
#[non_exhaustive]
pub struct InterruptEvent<'a> {
    base: Sequential<'a>,
    interrupt: Interrupt,
}

sequential_accessors!(InterruptEvent);

impl<'a> InterruptEvent<'a> {
    pub(crate) fn new(agent: &'a mut LocalAgent, invocation_state: InvocationState, interrupt: Interrupt) -> Self {
        Self {
            base: Sequential::new(agent, invocation_state),
            interrupt,
        }
    }

    /// The interrupt; its source tells a tool interrupt from a hook interrupt.
    #[must_use]
    pub fn interrupt(&self) -> &Interrupt {
        &self.interrupt
    }
}

/// A tool is about to run, after its lookup (`BeforeToolCallEvent`).
///
/// Hooks can cancel the call, run a different tool with
/// [`set_selected_tool`](Self::set_selected_tool), or rewrite the tool use; a changed name
/// re-resolves the tool unless one is selected. The tool use id stays the model's.
#[non_exhaustive]
pub struct BeforeToolCallEvent {
    base: PerTool,
    tool_use: ToolUse,
    tool: Option<Arc<dyn Tool>>,
    cancel: Cancel,
    selected_tool: Option<Arc<dyn Tool>>,
    interrupts: Vec<Interrupt>,
}

per_tool_accessors!(BeforeToolCallEvent);

impl BeforeToolCallEvent {
    pub(crate) fn new(
        agent: ToolAgent,
        invocation_state: InvocationState,
        tool_use: ToolUse,
        tool: Option<Arc<dyn Tool>>,
    ) -> Self {
        Self {
            base: PerTool::new(agent, invocation_state),
            tool_use,
            tool,
            cancel: Cancel::NotCancelled,
            selected_tool: None,
            interrupts: Vec::new(),
        }
    }

    /// The tool use about to run.
    #[must_use]
    pub fn tool_use(&self) -> &ToolUse {
        &self.tool_use
    }

    /// The tool use, to edit its name or input in place.
    pub fn tool_use_mut(&mut self) -> &mut ToolUse {
        &mut self.tool_use
    }

    /// Replaces the tool use.
    pub fn set_tool_use(&mut self, tool_use: ToolUse) {
        self.tool_use = tool_use;
    }

    /// The registry's tool for the name, if any.
    #[must_use]
    pub fn tool(&self) -> Option<&Arc<dyn Tool>> {
        self.tool.as_ref()
    }

    /// The cancel request.
    #[must_use]
    pub fn cancel(&self) -> &Cancel {
        &self.cancel
    }

    /// Cancels the tool call: `true` uses the default message, a string becomes the error text of
    /// the tool result.
    pub fn set_cancel(&mut self, cancel: impl Into<Cancel>) {
        self.cancel = cancel.into();
    }

    /// The replacement tool a hook selected.
    #[must_use]
    pub fn selected_tool(&self) -> Option<&Arc<dyn Tool>> {
        self.selected_tool.as_ref()
    }

    /// Runs `tool` instead of the registry's match. The last callback to set it wins.
    pub fn set_selected_tool(&mut self, tool: Arc<dyn Tool>) {
        self.selected_tool = Some(tool);
    }

    /// Raises an interrupt for human input (`interrupt`), with the id
    /// `hook:beforeToolCall:<toolUseId>:<name>`.
    ///
    /// Returns the response when the agent resumed with one (or `params` carries a preemptive
    /// response). Otherwise the interrupt is recorded on the event and the agent stops with it
    /// once every callback has run; return the [`InterruptError`] with `?` (it does not fail the
    /// invocation) or simply return from the callback.
    ///
    /// # Errors
    ///
    /// The unanswered interrupt.
    pub fn interrupt(&mut self, params: impl Into<InterruptParams>) -> Result<JsonValue, InterruptError> {
        let params = params.into();
        let id = format!("hook:beforeToolCall:{}:{}", self.tool_use.tool_use_id, params.name);
        let raised = self.base.agent.raise_interrupt(&id, &params);
        raised.inspect_err(|error| self.interrupts.extend(error.interrupts.iter().cloned()))
    }

    pub(crate) fn take_interrupts(&mut self) -> Vec<Interrupt> {
        std::mem::take(&mut self.interrupts)
    }

    pub(crate) fn take_selected_tool(&mut self) -> Option<Arc<dyn Tool>> {
        self.selected_tool.take()
    }
}

/// A tool call finished, successfully or not (`AfterToolCallEvent`). Callbacks with the same
/// order run in reverse registration order.
#[non_exhaustive]
pub struct AfterToolCallEvent {
    base: PerTool,
    tool_use: ToolUse,
    tool: Option<Arc<dyn Tool>>,
    result: ToolResultBlock,
    error: Option<ToolResultError>,
    retry: bool,
}

per_tool_accessors!(AfterToolCallEvent);

impl AfterToolCallEvent {
    pub(crate) fn new(
        agent: ToolAgent,
        invocation_state: InvocationState,
        tool_use: ToolUse,
        tool: Option<Arc<dyn Tool>>,
        result: ToolResultBlock,
    ) -> Self {
        let error = result.error.clone();
        Self {
            base: PerTool::new(agent, invocation_state),
            tool_use,
            tool,
            result,
            error,
            retry: false,
        }
    }

    /// The tool use that ran.
    #[must_use]
    pub fn tool_use(&self) -> &ToolUse {
        &self.tool_use
    }

    /// The tool that ran, if one was found.
    #[must_use]
    pub fn tool(&self) -> Option<&Arc<dyn Tool>> {
        self.tool.as_ref()
    }

    /// The tool result.
    #[must_use]
    pub fn result(&self) -> &ToolResultBlock {
        &self.result
    }

    /// The tool result, to edit before it reaches the model (redact, truncate).
    pub fn result_mut(&mut self) -> &mut ToolResultBlock {
        &mut self.result
    }

    /// Replaces the tool result.
    pub fn set_result(&mut self, result: ToolResultBlock) {
        self.result = result;
    }

    /// The error the tool failed with; it stays the original when a hook replaces the result.
    #[must_use]
    pub fn error(&self) -> Option<&ToolResultError> {
        self.error.as_ref()
    }

    /// Whether a hook requested a retry of the tool call.
    #[must_use]
    pub fn retry(&self) -> bool {
        self.retry
    }

    /// Requests (or withdraws) a retry of the tool call.
    pub fn set_retry(&mut self, retry: bool) {
        self.retry = retry;
    }

    pub(crate) fn into_result(self) -> ToolResultBlock {
        self.result
    }
}

/// A tool yielded a progress event (`ToolStreamUpdateEvent`).
#[non_exhaustive]
pub struct ToolStreamUpdateEvent {
    base: PerTool,
    event: ToolStreamEvent,
}

per_tool_accessors!(ToolStreamUpdateEvent);

impl ToolStreamUpdateEvent {
    pub(crate) fn new(agent: ToolAgent, invocation_state: InvocationState, event: ToolStreamEvent) -> Self {
        Self {
            base: PerTool::new(agent, invocation_state),
            event,
        }
    }

    /// The tool's progress event.
    #[must_use]
    pub fn event(&self) -> &ToolStreamEvent {
        &self.event
    }
}

/// A tool call's final result is ready (`ToolResultEvent`).
#[non_exhaustive]
pub struct ToolResultEvent {
    base: PerTool,
    result: ToolResultBlock,
}

per_tool_accessors!(ToolResultEvent);

impl ToolResultEvent {
    pub(crate) fn new(agent: ToolAgent, invocation_state: InvocationState, result: ToolResultBlock) -> Self {
        Self {
            base: PerTool::new(agent, invocation_state),
            result,
        }
    }

    /// The result.
    #[must_use]
    pub fn result(&self) -> &ToolResultBlock {
        &self.result
    }
}

#[cfg(test)]
mod tests;
