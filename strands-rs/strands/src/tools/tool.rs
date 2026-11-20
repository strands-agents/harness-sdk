//! The [`Tool`] trait, its stream and its context.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

use crate::agent::{InvocationContext, InvocationState, ToolAgent};
use crate::cancel::CancelSignal;
use crate::error::BoxError;
use crate::interrupt::{Interrupt, InterruptError, InterruptSource};
use crate::models::BoxStream;
use crate::types::{InterruptParams, JsonValue, ToolResultBlock, ToolResultContent, ToolSpec, ToolUse};

/// A tool the model can call (`Tool`).
///
/// [`stream`](Tool::stream) yields zero or more progress events and ends with exactly one
/// [`ToolOutcome`]: the result, or an interrupt that pauses the agent for human input. A failing
/// tool returns an error result rather than failing the stream.
///
/// Most tools are written with `#[tool]` or [`FunctionTool`](crate::tools::FunctionTool);
/// implement the trait directly for full control.
///
/// ```
/// use strands::tools::{Tool, ToolContext, ToolOutcome, ToolStream};
/// use strands::{ToolResultBlock, ToolResultContent, ToolSpec};
///
/// struct Echo;
///
/// impl Tool for Echo {
///     fn name(&self) -> &str {
///         "echo"
///     }
///
///     fn description(&self) -> &str {
///         "Echoes its input"
///     }
///
///     fn tool_spec(&self) -> ToolSpec {
///         ToolSpec::new(self.name(), self.description())
///     }
///
///     fn stream(&self, context: ToolContext) -> ToolStream {
///         ToolStream::from_future(async move {
///             let text = context.tool_use().input.to_string();
///             let id = context.tool_use().tool_use_id.clone();
///             ToolOutcome::from(ToolResultBlock::success(id, vec![ToolResultContent::text(text)]))
///         })
///     }
/// }
/// ```
pub trait Tool: Send + Sync + 'static {
    /// The unique tool name; it must match the spec's name.
    fn name(&self) -> &str;

    /// What the tool does; it must match the spec's description.
    fn description(&self) -> &str;

    /// The spec sent to the model: name, description and input schema.
    fn tool_spec(&self) -> ToolSpec;

    /// Runs the tool. The stream is `'static`, so the agent can run it on its own task.
    fn stream(&self, context: ToolContext) -> ToolStream;

    /// Whether this is an agent-as-tool that delegates (`AgentAsTool` with `delegate: true`); the
    /// agent's delegation and background-task rules read it. Only the SDK can name the token, so
    /// only its tools answer.
    #[doc(hidden)]
    fn is_delegation_tool(&self, _: DelegationToken) -> bool {
        false
    }
}

mod sealed {
    /// The argument of [`Tool::is_delegation_tool`](super::Tool::is_delegation_tool); only the SDK
    /// can name it, so only the SDK overrides or calls the method.
    #[derive(Debug, Clone, Copy)]
    pub struct DelegationToken(pub(crate) ());
}

pub(crate) use sealed::DelegationToken;

impl fmt::Debug for dyn Tool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tool")
            .field("name", &self.name())
            .finish_non_exhaustive()
    }
}

/// Progress data a tool yields while it runs (`ToolStreamEvent`).
///
/// Serializes as `{"type":"toolStreamEvent","data":...}`, without `data` when there is none.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "toolStreamEvent")]
#[non_exhaustive]
pub struct ToolStreamEvent {
    /// Caller-defined progress data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<JsonValue>,
}

impl ToolStreamEvent {
    /// Creates an event carrying `data`.
    pub fn new(data: impl Into<JsonValue>) -> Self {
        Self {
            data: Some(data.into()),
        }
    }

    /// Creates an event without data.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }
}

/// How a tool run ended.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ToolOutcome {
    /// The tool finished with a result, successful or not.
    Result(ToolResultBlock),
    /// The tool raised one or more interrupts (a sub-agent can raise several); it runs again
    /// from the start when the agent resumes.
    Interrupt(InterruptError),
}

impl ToolOutcome {
    /// The result, unless the tool was interrupted.
    #[must_use]
    pub fn result(&self) -> Option<&ToolResultBlock> {
        match self {
            Self::Result(result) => Some(result),
            Self::Interrupt(_) => None,
        }
    }
}

impl From<ToolResultBlock> for ToolOutcome {
    fn from(result: ToolResultBlock) -> Self {
        Self::Result(result)
    }
}

impl From<Interrupt> for ToolOutcome {
    fn from(interrupt: Interrupt) -> Self {
        Self::Interrupt(interrupt.into())
    }
}

impl From<InterruptError> for ToolOutcome {
    fn from(interrupts: InterruptError) -> Self {
        Self::Interrupt(interrupts)
    }
}

/// One item of a [`ToolStream`].
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ToolStreamItem {
    /// A progress event.
    Event(ToolStreamEvent),
    /// The final outcome; the stream ends after it.
    Outcome(ToolOutcome),
}

impl From<ToolStreamEvent> for ToolStreamItem {
    fn from(event: ToolStreamEvent) -> Self {
        Self::Event(event)
    }
}

impl From<ToolOutcome> for ToolStreamItem {
    fn from(outcome: ToolOutcome) -> Self {
        Self::Outcome(outcome)
    }
}

impl From<ToolResultBlock> for ToolStreamItem {
    fn from(result: ToolResultBlock) -> Self {
        Self::Outcome(result.into())
    }
}

/// The stream a [`Tool`] returns (`ToolStreamGenerator`): progress events, then one outcome.
///
/// A stream that ends without an outcome becomes an error result.
pub struct ToolStream {
    inner: BoxStream<'static, ToolStreamItem>,
}

impl ToolStream {
    /// Wraps a stream of items.
    pub fn new(stream: impl Stream<Item = ToolStreamItem> + Send + 'static) -> Self {
        Self {
            inner: Box::pin(stream),
        }
    }

    /// A stream with no progress events, for tools that only compute a result.
    pub fn from_future(future: impl Future<Output = ToolOutcome> + Send + 'static) -> Self {
        Self::new(futures::stream::once(future).map(ToolStreamItem::Outcome))
    }

    /// A stream that ends at once with `outcome`.
    pub fn ready(outcome: impl Into<ToolOutcome>) -> Self {
        Self::new(futures::stream::iter([ToolStreamItem::Outcome(outcome.into())]))
    }

    /// Drains the stream, passing each progress event to `on_event`, and returns the first
    /// outcome, or `None` when the stream ends without one. Items after the outcome are ignored.
    pub(crate) async fn run(mut self, mut on_event: impl FnMut(ToolStreamEvent)) -> Option<ToolOutcome> {
        while let Some(item) = self.next().await {
            match item {
                ToolStreamItem::Event(event) => on_event(event),
                ToolStreamItem::Outcome(outcome) => return Some(outcome),
            }
        }
        None
    }
}

impl Stream for ToolStream {
    type Item = ToolStreamItem;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

impl fmt::Debug for ToolStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolStream").finish_non_exhaustive()
    }
}

pub(crate) type InterruptFn = Arc<dyn Fn(&InterruptParams) -> Result<JsonValue, InterruptError> + Send + Sync>;

/// What a tool receives when it runs (`ToolContext`).
///
/// Cheap to clone and `'static`, so tools can move it into spawned work.
#[derive(Clone)]
pub struct ToolContext {
    tool_use: ToolUse,
    agent: ToolAgent,
    invocation_state: InvocationState,
    cancel_signal: CancelSignal,
    invocation_context: Option<InvocationContext>,
    interrupt: Option<InterruptFn>,
}

impl ToolContext {
    /// Creates the context for one tool call. The cancel signal starts as the agent's.
    pub(crate) fn new(tool_use: ToolUse, agent: ToolAgent, invocation_state: InvocationState) -> Self {
        let cancel_signal = agent.cancel_signal();
        let invocation_context = agent.invocation_context().cloned();
        Self {
            tool_use,
            agent,
            invocation_state,
            cancel_signal,
            invocation_context,
            interrupt: None,
        }
    }

    /// Sets the execution-scoped cancel signal.
    #[must_use]
    #[cfg(test)]
    pub(crate) fn with_cancel_signal(mut self, cancel_signal: CancelSignal) -> Self {
        self.cancel_signal = cancel_signal;
        self
    }

    /// Replaces how interrupts are raised, for callers that scope interrupt ids differently.
    #[must_use]
    pub(crate) fn with_interrupt(mut self, interrupt: InterruptFn) -> Self {
        self.interrupt = Some(interrupt);
        self
    }

    /// The tool use that started this call: name, id and input.
    #[must_use]
    pub fn tool_use(&self) -> &ToolUse {
        &self.tool_use
    }

    /// The agent running the tool.
    #[must_use]
    pub fn agent(&self) -> &ToolAgent {
        &self.agent
    }

    /// The caller's per-invocation state, shared with hooks and other tools.
    #[must_use]
    pub fn invocation_state(&self) -> &InvocationState {
        &self.invocation_state
    }

    /// The cancellation signal for this tool call. Cancellation is cooperative: check it between
    /// steps or await [`CancelSignal::cancelled`].
    #[must_use]
    pub fn cancel_signal(&self) -> &CancelSignal {
        &self.cancel_signal
    }

    /// The request this call belongs to; pass it to a nested agent call to share its limits and
    /// usage.
    #[must_use]
    pub fn invocation_context(&self) -> Option<&InvocationContext> {
        self.invocation_context.as_ref()
    }

    /// Raises an interrupt for human input (`interrupt`).
    ///
    /// Returns the response when the agent resumed with one (or `params` carries a preemptive
    /// response). Otherwise returns the [`InterruptError`]; propagate it with `?` into a
    /// [`ToolError`](super::ToolError) or a [`BoxError`], which ends the tool as
    /// [`ToolOutcome::Interrupt`]. The tool runs again from the start on resume, and this call
    /// then returns the response. The interrupt id is `tool:<toolUseId>:<name>`.
    ///
    /// # Errors
    ///
    /// The unanswered interrupt.
    pub fn interrupt(&self, params: impl Into<InterruptParams>) -> Result<JsonValue, InterruptError> {
        let params = params.into();
        if let Some(interrupt) = &self.interrupt {
            return interrupt(&params);
        }
        let id = format!("tool:{}:{}", self.tool_use.tool_use_id, params.name);
        self.agent.interrupt_state().raise(&id, &params, InterruptSource::Tool)
    }
}

impl fmt::Debug for ToolContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolContext")
            .field("tool_use", &self.tool_use)
            .field("agent", &self.agent)
            .finish_non_exhaustive()
    }
}

/// An error tool result whose content is `Error: <message>` and which keeps the original error.
pub fn create_error_result(error: impl Into<BoxError>, tool_use_id: impl Into<String>) -> ToolResultBlock {
    let error = error.into();
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(format!("Error: {error}"))]).with_error(error)
}

const TOOL_NAME_MAX_LENGTH: usize = 64;

/// Whether `name` is a tool name providers accept: 1 to 64 characters, only
/// ASCII letters, digits, `_` and `-`.
#[must_use]
pub fn is_valid_tool_name(name: &str) -> bool {
    (1..=TOOL_NAME_MAX_LENGTH).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Tests tool name validation, tool stream events and the `Tool` trait.
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testing::tool_context;

    #[test]
    fn accepts_valid_names() {
        for name in [
            "simple",
            "with_underscore",
            "with-hyphen",
            "Mixed-Case_123",
            "a",
            &"a".repeat(64),
        ] {
            assert!(is_valid_tool_name(name), "{name}");
        }
    }

    #[test]
    fn rejects_invalid_names() {
        for name in [
            "",
            &"a".repeat(65),
            "has space",
            "has.dot",
            "has/slash",
            "has:colon",
            "emoji🚀",
        ] {
            assert!(!is_valid_tool_name(name), "{name}");
        }
    }

    #[test]
    fn creates_instance_with_data() {
        let event = ToolStreamEvent::new("Processing...");
        assert_eq!(event.data, Some(json!("Processing...")));
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"type": "toolStreamEvent", "data": "Processing..."})
        );
    }

    #[test]
    fn creates_instance_without_data() {
        let event = ToolStreamEvent::empty();
        assert_eq!(event.data, None);
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"type": "toolStreamEvent"})
        );
    }

    #[test]
    fn creates_instance_with_structured_data() {
        let data = json!({"progress": 50, "message": "Halfway complete"});
        let event: ToolStreamEvent = serde_json::from_value(json!({"type": "toolStreamEvent", "data": data})).unwrap();
        assert_eq!(
            event,
            ToolStreamEvent::new(json!({"progress": 50, "message": "Halfway complete"}))
        );
    }

    #[test]
    fn creates_an_error_result_with_the_error_prefix() {
        let result = create_error_result("boom", "t-1");
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({"toolUseId": "t-1", "status": "error", "content": [{"text": "Error: boom"}]})
        );
        assert_eq!(result.error.map(|error| error.to_string()).as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn run_returns_the_first_outcome_and_forwards_events() {
        let stream = ToolStream::new(futures::stream::iter([
            ToolStreamItem::from(ToolStreamEvent::new(1)),
            ToolResultBlock::success("t", vec![]).into(),
            ToolStreamItem::from(ToolStreamEvent::new(2)),
        ]));
        let mut events = Vec::new();
        let outcome = stream.run(|event| events.push(event)).await;
        assert_eq!(
            outcome,
            Some(ToolOutcome::Result(ToolResultBlock::success("t", vec![])))
        );
        assert_eq!(events, vec![ToolStreamEvent::new(1)]);
        assert_eq!(ToolStream::new(futures::stream::empty()).run(|_| {}).await, None);
    }

    #[test]
    fn interrupt_raises_with_the_tool_scoped_id_and_returns_the_response_on_resume() {
        let context = tool_context(ToolUse::new("delete", "t-1", json!({})));
        let interrupt = context
            .interrupt(InterruptParams::new("confirm").with_reason("sure?"))
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(&interrupt.interrupts).unwrap(),
            json!([{"id": "tool:t-1:confirm", "name": "confirm", "reason": "sure?", "source": "tool"}])
        );
        context
            .agent()
            .interrupt_state()
            .respond("tool:t-1:confirm", json!("yes"));
        assert_eq!(context.interrupt("confirm").unwrap(), json!("yes"));
    }

    #[test]
    fn interrupt_returns_a_preemptive_response_at_once() {
        let context = tool_context(ToolUse::new("delete", "t-1", json!({})));
        let response = context.interrupt(InterruptParams::new("confirm").with_response(true));
        assert_eq!(response.unwrap(), json!(true));
    }
}
