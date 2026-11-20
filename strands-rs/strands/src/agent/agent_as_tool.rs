//! An agent used as another agent's tool, with the `AgentToolStreamer` that forwards the
//! sub-agent's interrupts to the calling agent.

use std::fmt;
use std::ops::DerefMut;
use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::Mutex;

use super::agent::Agent;
use super::config::InvokeOptions;
use super::invoke_args::InvokeArgs;
use super::result::AgentResult;
use super::snapshot::take_session_snapshot;
use crate::cancel::CancelHandle;
use crate::error::{Error, Result};
use crate::hooks::AgentStreamEvent;
use crate::interrupt::{Interrupt, InterruptError, InterruptSource, InterruptState};
use crate::tools::{
    DelegationToken, Tool, ToolContext, ToolOutcome, ToolSource, ToolStream, ToolStreamEvent, ToolStreamItem,
    create_error_result,
};
use crate::types::{
    InterruptResponse, InterruptResponseContent, JsonValue, Snapshot, StopReason, ToolResultBlock, ToolResultContent,
    ToolSpec,
};

/// Appended to a delegating tool's description (`DELEGATION_DESCRIPTION_SUFFIX`).
pub const DELEGATION_DESCRIPTION_SUFFIX: &str = " Calling this tool will return its response directly to the user as the final answer. It should be the only tool called in the turn.";

const INTERRUPTED_TURNS_KEY: &str = "subAgentInterruptedTurns";

/// Options for [`Agent::as_tool`] (`AgentAsToolOptions`).
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct AgentAsToolOptions {
    /// The tool name. Defaults to the agent's name, which must then be a valid tool name
    /// (letters, digits, `-` and `_`): name the agent with `.name("researcher")`, or set this. The
    /// default `Strands Agent` is not a valid tool name.
    #[builder(into)]
    pub name: Option<String>,
    /// The tool description. Defaults to the agent's description, then
    /// `Use the <name> agent by providing a natural language input`.
    #[builder(into)]
    pub description: Option<String>,
    /// Keep the agent's conversation across calls. Defaults to `false`: each call starts from the
    /// state the agent had when it became a tool.
    pub preserve_context: Option<bool>,
    /// Return the agent's answer directly to the user as the final answer (`delegate`). The
    /// description says so to the model.
    pub delegate: Option<bool>,
}

/// An agent wrapped as a tool (`AgentAsTool`): the tool takes an `input` string, invokes the
/// agent with it and returns the agent's answer.
///
/// The wrapped agent's events stream as the tool's progress events, and its interrupts surface
/// on the calling agent with ids scoped to the tool call, so resuming the caller resumes it.
pub struct AgentAsTool {
    inner: Arc<Inner>,
}

struct Inner {
    name: String,
    description: String,
    spec: ToolSpec,
    delegate: bool,
    agent: Arc<Mutex<Agent>>,
    preserve_context: bool,
    initial_snapshot: Option<Snapshot>,
    conflict: Option<String>,
}

impl Agent {
    /// Wraps the agent as a tool for another agent. An agent passed to
    /// [`AgentBuilder::tools`](crate::AgentBuilder::tools) is wrapped with default options.
    ///
    /// ```
    /// use strands::Agent;
    /// use strands::agent::AgentAsToolOptions;
    /// use strands::testing::MockModel;
    ///
    /// let researcher = Agent::builder()
    ///     .model(MockModel::new())
    ///     .name("researcher")
    ///     .description("Finds information")
    ///     .printer(false)
    ///     .build()?;
    /// let tool = researcher.as_tool(AgentAsToolOptions::default());
    /// let writer = Agent::builder().model(MockModel::new()).tools([tool]).printer(false).build()?;
    /// assert!(writer.tool_registry().get("researcher").is_some());
    /// # Ok::<(), strands::Error>(())
    /// ```
    ///
    /// An agent with a session manager needs `preserve_context(true)`: a tool built from one
    /// without it fails every call with the error [`try_as_tool`](Self::try_as_tool) returns.
    #[must_use]
    pub fn as_tool(self, options: AgentAsToolOptions) -> AgentAsTool {
        AgentAsTool::new(self, options)
    }

    /// Wraps the agent as a tool, rejecting a session manager that conflicts with the options.
    ///
    /// # Errors
    ///
    /// The agent has a session manager and `preserve_context` is not `true`: the session manager
    /// persists the history while the tool resets it between calls.
    pub fn try_as_tool(self, options: AgentAsToolOptions) -> Result<AgentAsTool> {
        if let Some(conflict) = session_manager_conflict(&self, &options) {
            return Err(Error::other(conflict));
        }
        Ok(AgentAsTool::new(self, options))
    }
}

/// The error for an agent whose session manager conflicts with `preserveContext=false`.
fn session_manager_conflict(agent: &Agent, options: &AgentAsToolOptions) -> Option<String> {
    let preserve_context = options.preserve_context.unwrap_or(false);
    (!preserve_context && agent.session_manager().is_some()).then(|| {
        format!(
            "Agent '{}' has a SessionManager, which conflicts with preserveContext=false. The SessionManager persists conversation history externally, but preserveContext=false resets state between invocations. Use preserveContext=true or remove the SessionManager.",
            agent.name()
        )
    })
}

impl AgentAsTool {
    fn new(agent: Agent, options: AgentAsToolOptions) -> Self {
        let conflict = session_manager_conflict(&agent, &options);
        if let Some(conflict) = &conflict {
            tracing::error!("agent_name=<{}> | {conflict}", agent.name());
        }
        let preserve_context = options.preserve_context.unwrap_or(false);
        let delegate = options.delegate.unwrap_or(false);
        let initial_snapshot = if preserve_context {
            None
        } else {
            take_session_snapshot(&agent.local)
                .inspect_err(|error| tracing::warn!("error=<{error}> | failed to snapshot the agent used as a tool"))
                .ok()
        };
        let name = options.name.unwrap_or_else(|| agent.name().to_owned());
        let mut description = options
            .description
            .or_else(|| agent.description().map(str::to_owned))
            .unwrap_or_else(|| format!("Use the {name} agent by providing a natural language input"));
        if delegate {
            description.push_str(DELEGATION_DESCRIPTION_SUFFIX);
        }
        let spec = ToolSpec::new(&name, &description).with_input_schema(json!({
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "description": "The natural language input to send to the agent."
                }
            },
            "required": ["input"]
        }));
        Self {
            inner: Arc::new(Inner {
                name,
                description,
                spec,
                delegate,
                agent: Arc::new(Mutex::new(agent)),
                preserve_context,
                initial_snapshot,
                conflict,
            }),
        }
    }

    /// Whether the tool hands the agent's answer to the user as the final answer (`delegate`).
    #[must_use]
    pub fn delegate(&self) -> bool {
        self.inner.delegate
    }

    /// The wrapped agent (`agent`); waits while a call is running.
    pub async fn agent(&self) -> impl DerefMut<Target = Agent> + Send + '_ {
        self.inner.agent.lock().await
    }
}

impl Inner {
    async fn run(
        self: Arc<Self>,
        context: ToolContext,
        mut events: futures::channel::mpsc::Sender<ToolStreamEvent>,
    ) -> ToolOutcome {
        let tool_use_id = context.tool_use().tool_use_id.clone();
        if let Some(conflict) = &self.conflict {
            return create_error_result(conflict.clone(), tool_use_id).into();
        }
        let Ok(mut child) = self.agent.clone().try_lock_owned() else {
            return create_error_result(
                format!("Agent '{}' is already processing a request", self.name),
                tool_use_id,
            )
            .into();
        };
        let mut streamer = AgentToolStreamer::new(
            context.agent().interrupt_state().clone(),
            &tool_use_id,
            "agent_as_tool",
            !self.preserve_context,
            format!("Agent '{}'", self.name),
        );
        let input = if streamer.is_resuming() {
            let unavailable = format!(
                "Agent '{}' did NOT run and the human's response was NOT applied: its interrupted turn is not available. Do not report the requested action as completed; tell the user it failed and ask them to respond again.",
                self.name
            );
            match streamer.resume(Some(&mut *child), &unavailable).await {
                Resume::Responses(responses) => {
                    tracing::debug!(
                        "tool_name=<{}>, tool_use_id=<{tool_use_id}> | resuming sub-agent from interrupt",
                        self.name
                    );
                    InvokeArgs::InterruptResponses(responses)
                }
                Resume::Raise(interrupts) => return raise(interrupts, &tool_use_id),
                Resume::Stop => return streamer.terminal_result(render_success),
            }
        } else {
            let text = context.tool_use().input["input"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            if let Some(snapshot) = &self.initial_snapshot
                && let Err(error) = child.load_snapshot(snapshot)
            {
                return create_error_result(error, tool_use_id).into();
            }
            InvokeArgs::Text(text)
        };

        let options = InvokeOptions {
            invocation_state: Some(context.invocation_state().clone()),
            cancel_signal: Some(context.cancel_signal().clone()),
            invocation_context: context.invocation_context().cloned(),
            ..InvokeOptions::default()
        };
        if let Err(error) = streamer
            .stream(&mut child, input, options, &self.name, &mut events)
            .await
        {
            return create_error_result(error, tool_use_id).into();
        }
        if streamer.interrupts.is_some() && self.preserve_context && child.session_manager().is_none() {
            tracing::warn!(
                "tool_name=<{}>, tool_use_id=<{tool_use_id}> | interrupted sub-agent has preserveContext=true and no session manager, so its interrupt cannot be resumed after a restart",
                self.name
            );
        }
        streamer.terminal_result(render_success)
    }
}

fn raise(interrupts: Vec<Interrupt>, tool_use_id: &str) -> ToolOutcome {
    if interrupts.is_empty() {
        return create_error_result("sub-agent interrupted without any interrupts", tool_use_id).into();
    }
    ToolOutcome::Interrupt(InterruptError::new(interrupts))
}

fn render_success(result: &AgentResult) -> Vec<ToolResultContent> {
    match result.structured_output_value() {
        Some(value) => vec![ToolResultContent::json(value.clone())],
        None => vec![ToolResultContent::text(result.to_string())],
    }
}

impl Tool for AgentAsTool {
    fn name(&self) -> &str {
        &self.inner.name
    }

    fn description(&self) -> &str {
        &self.inner.description
    }

    fn tool_spec(&self) -> ToolSpec {
        self.inner.spec.clone()
    }

    fn is_delegation_tool(&self, _: DelegationToken) -> bool {
        self.inner.delegate
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        // No buffer: the sub-agent advances only as the caller takes its events, so a call holds
        // the agent until its stream is finished or dropped.
        let (sender, receiver) = futures::channel::mpsc::channel(0);
        let run = self.inner.clone().run(context, sender);
        let outcome = futures::stream::once(run).map(ToolStreamItem::Outcome);
        ToolStream::new(merge_events_first(receiver.map(ToolStreamItem::Event), outcome))
    }
}

/// Streams every progress event, then the outcome: the run future feeds the events while it
/// runs and finishes with the outcome.
pub(crate) fn merge_events_first(
    events: impl futures::Stream<Item = ToolStreamItem> + Send + 'static,
    outcome: impl futures::Stream<Item = ToolStreamItem> + Send + 'static,
) -> impl futures::Stream<Item = ToolStreamItem> + Send + 'static {
    async_stream::stream! {
        let mut events = Box::pin(events);
        let mut outcome = Box::pin(outcome);
        let mut finished = None;
        loop {
            tokio::select! {
                biased;
                event = events.next() => match event {
                    Some(event) => yield event,
                    None => break,
                },
                item = outcome.next(), if finished.is_none() => finished = item,
            }
        }
        if let Some(item) = finished {
            yield item;
        }
    }
}

impl fmt::Debug for AgentAsTool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentAsTool")
            .field("name", &self.inner.name)
            .field("delegate", &self.inner.delegate)
            .field("preserve_context", &self.inner.preserve_context)
            .finish_non_exhaustive()
    }
}

impl From<Agent> for ToolSource {
    fn from(agent: Agent) -> Self {
        Self::from(agent.as_tool(AgentAsToolOptions::default()))
    }
}

/// How resuming an interrupted sub-agent turn goes.
pub(crate) enum Resume {
    Responses(Vec<InterruptResponseContent>),
    Raise(Vec<Interrupt>),
    Stop,
}

/// Forwards a sub-agent's interrupts to the calling agent and resumes them.
pub(crate) struct AgentToolStreamer {
    state: InterruptState,
    tool_use_id: String,
    prefix: String,
    persist_interrupted_turn: bool,
    label: String,
    result: Option<AgentResult>,
    interrupts: Option<Vec<Interrupt>>,
    error: Option<String>,
}

impl AgentToolStreamer {
    /// A streamer for the call `tool_use_id`, scoping the child's interrupt ids under
    /// `namespace`; `label` names the child in error messages.
    pub(crate) fn new(
        state: InterruptState,
        tool_use_id: &str,
        namespace: &str,
        persist_interrupted_turn: bool,
        label: String,
    ) -> Self {
        Self {
            state,
            tool_use_id: tool_use_id.to_owned(),
            prefix: format!("{namespace}:{}:", encode_uri_component(tool_use_id)),
            persist_interrupted_turn,
            label,
            result: None,
            interrupts: None,
            error: None,
        }
    }

    pub(crate) fn is_resuming(&self) -> bool {
        self.state.activated()
            && self
                .state
                .interrupt_list()
                .iter()
                .any(|interrupt| interrupt.id.starts_with(&self.prefix))
    }

    fn turns(&self) -> serde_json::Map<String, JsonValue> {
        match self.state.context_value(INTERRUPTED_TURNS_KEY) {
            Some(JsonValue::Object(turns)) => turns,
            _ => serde_json::Map::new(),
        }
    }

    fn set_turn(&self, turn: Option<JsonValue>) {
        let mut turns = self.turns();
        match turn {
            Some(turn) => {
                turns.insert(self.tool_use_id.clone(), turn);
            }
            None => {
                turns.shift_remove(&self.tool_use_id);
            }
        }
        let value = (!turns.is_empty()).then_some(JsonValue::Object(turns));
        self.state.set_context_value(INTERRUPTED_TURNS_KEY, value);
    }

    pub(crate) async fn stream(
        &mut self,
        child: &mut Agent,
        input: InvokeArgs,
        options: InvokeOptions,
        name: &str,
        events: &mut futures::channel::mpsc::Sender<ToolStreamEvent>,
    ) -> crate::Result<()> {
        let child_cancel = child.cancel_handle();
        let external = options.cancel_signal.clone();
        let mut outcome = None;
        let mut classified = false;
        {
            let mut stream = child.stream_with(input, options);
            while let Some(event) = stream.next().await {
                let event = event?;
                if !classified && let AgentStreamEvent::AgentResult(result) = &event {
                    outcome = Some(self.classify(&child_cancel, external.as_ref(), result, name));
                    classified = true;
                }
                let tool_event = match &event {
                    AgentStreamEvent::ToolStreamUpdate(update) => update.event.clone(),
                    other => ToolStreamEvent::new(serde_json::to_value(other)?),
                };
                let _ = events.send(tool_event).await;
            }
            self.result = stream.take_result();
        }
        let Some(result) = &self.result else {
            self.error = Some(format!("{} did not produce a result.", self.label));
            return Ok(());
        };
        let outcome = match outcome {
            Some(outcome) => outcome,
            None => self.classify(&child_cancel, external.as_ref(), result, name),
        };
        match outcome {
            Classified::Interrupts(interrupts) => {
                if self.persist_interrupted_turn {
                    let snapshot = take_session_snapshot(&child.local)?;
                    self.set_turn(Some(serde_json::to_value(snapshot)?));
                }
                let registered = interrupts
                    .iter()
                    .map(|interrupt| {
                        let mut scoped =
                            Interrupt::new(format!("{}{}", self.prefix, interrupt.id), interrupt.name.clone())
                                .with_source(InterruptSource::Tool);
                        scoped.reason.clone_from(&interrupt.reason);
                        self.state.register_interrupt(&scoped)
                    })
                    .collect();
                self.interrupts = Some(registered);
            }
            Classified::Error(error) => {
                self.set_turn(None);
                self.error = Some(error);
            }
            Classified::Success => self.set_turn(None),
        }
        Ok(())
    }

    /// Classifies a sub-agent result: interrupts to forward, an error (an interrupt stop without
    /// interrupts, a cancel from either side, a limit stop), or success.
    fn classify(
        &self,
        child_cancel: &CancelHandle,
        external: Option<&crate::cancel::CancelSignal>,
        result: &AgentResult,
        name: &str,
    ) -> Classified {
        match result.stop_reason() {
            StopReason::Interrupt if result.interrupts().is_empty() => {
                Classified::Error(format!("{} interrupted without any interrupts", self.label))
            }
            StopReason::Interrupt => Classified::Interrupts(result.interrupts().to_vec()),
            StopReason::Cancelled => {
                let aborted =
                    child_cancel.signal().is_cancelled() || external.is_some_and(|signal| signal.is_cancelled());
                if aborted {
                    Classified::Error(format!("{} cancelled", self.label))
                } else {
                    Classified::Success
                }
            }
            stop_reason @ (StopReason::LimitTurns
            | StopReason::LimitTotalTokens
            | StopReason::LimitOutputTokens
            | StopReason::LimitStructuredOutputAttempts) => Classified::Error(format!(
                "Agent '{name}' stopped early ({stop_reason}): a limit on this call was reached, so its answer is incomplete"
            )),
            _ => Classified::Success,
        }
    }

    /// The tool's outcome: a failure is an `Error: <message>` result, checked before interrupts and
    /// the rendered result.
    pub(crate) fn terminal_result(&self, render: impl FnOnce(&AgentResult) -> Vec<ToolResultContent>) -> ToolOutcome {
        if let Some(error) = &self.error {
            return create_error_result(error.clone(), self.tool_use_id.clone()).into();
        }
        if let Some(interrupts) = &self.interrupts {
            return raise(interrupts.clone(), &self.tool_use_id);
        }
        let content = self.result.as_ref().map(render).unwrap_or_default();
        ToolResultBlock::success(self.tool_use_id.clone(), content).into()
    }

    /// The tool's terminal result: a failure is an error result with the message as its text, and
    /// interrupts are raised before it.
    pub(crate) fn terminal_tool_result(
        &self,
        render: impl FnOnce(&AgentResult) -> Vec<ToolResultContent>,
    ) -> ToolOutcome {
        if let Some(interrupts) = &self.interrupts {
            return raise(interrupts.clone(), &self.tool_use_id);
        }
        if let Some(error) = &self.error {
            let content = vec![ToolResultContent::text(error.clone())];
            return ToolResultBlock::error(self.tool_use_id.clone(), content).into();
        }
        let content = self.result.as_ref().map(render).unwrap_or_default();
        ToolResultBlock::success(self.tool_use_id.clone(), content).into()
    }

    /// `resume`: the responses addressed to this call, stripped of the scope prefix. `None` is a
    /// child that could not be rebuilt, handled as a failed restore.
    pub(crate) async fn resume(&mut self, child: Option<&mut Agent>, unavailable: &str) -> Resume {
        let responses: Vec<InterruptResponseContent> = self
            .state
            .resume_responses()
            .into_iter()
            .filter(|response| response.interrupt_response.interrupt_id.starts_with(&self.prefix))
            .collect();
        if responses.is_empty() {
            let pending = self
                .state
                .interrupt_list()
                .into_iter()
                .filter(|interrupt| interrupt.id.starts_with(&self.prefix) && interrupt.response.is_none())
                .collect();
            return Resume::Raise(pending);
        }
        let turn = self.turns().get(&self.tool_use_id).cloned();
        let restored = match child {
            Some(child) => Some(restore(child, turn.clone()).await),
            None => None,
        };
        let awaiting = match restored {
            Some(Ok(awaiting)) => {
                self.set_turn(None);
                if !awaiting {
                    tracing::error!(
                        "tool_use_id=<{}> | interrupted sub-agent turn is not available to resume",
                        self.tool_use_id
                    );
                    self.error = Some(unavailable.to_owned());
                }
                awaiting
            }
            Some(Err(error)) => {
                tracing::error!(
                    "tool_use_id=<{}>, error=<{error}> | failed to restore interrupted sub-agent turn",
                    self.tool_use_id
                );
                self.handle_failed_restore(turn.as_ref(), unavailable);
                false
            }
            None => {
                self.handle_failed_restore(turn.as_ref(), unavailable);
                false
            }
        };
        if let Some(interrupts) = self.interrupts.take() {
            return Resume::Raise(interrupts);
        }
        if !awaiting {
            return Resume::Stop;
        }
        Resume::Responses(
            responses
                .into_iter()
                .map(|response| {
                    let id = response.interrupt_response.interrupt_id[self.prefix.len()..].to_owned();
                    InterruptResponseContent::new(InterruptResponse::new(id, response.interrupt_response.response))
                })
                .collect(),
        )
    }

    fn handle_failed_restore(&mut self, turn: Option<&JsonValue>, unavailable: &str) {
        let Some(pending) = turn.and_then(pending_interrupt_ids) else {
            tracing::error!(
                "tool_use_id=<{}> | stored turn has no readable interrupt state",
                self.tool_use_id
            );
            self.error = Some(unavailable.to_owned());
            return;
        };
        let interrupts: Vec<Interrupt> = self
            .state
            .interrupt_list()
            .into_iter()
            .filter(|interrupt| {
                interrupt
                    .id
                    .strip_prefix(&self.prefix)
                    .is_some_and(|id| pending.iter().any(|pending| pending == id))
            })
            .collect();
        if interrupts.is_empty() {
            self.error = Some(unavailable.to_owned());
            return;
        }
        for interrupt in &interrupts {
            self.state.clear_response(&interrupt.id);
        }
        self.interrupts = Some(
            interrupts
                .into_iter()
                .map(|mut interrupt| {
                    interrupt.response = None;
                    interrupt
                })
                .collect(),
        );
    }
}

enum Classified {
    Interrupts(Vec<Interrupt>),
    Error(String),
    Success,
}

/// Restores a sub-agent: loads the stored turn, or initializes a context-preserving
/// child that keeps its own; returns whether the child awaits responses.
async fn restore(child: &mut Agent, turn: Option<JsonValue>) -> crate::Result<bool> {
    match turn {
        Some(turn) => {
            let snapshot: Snapshot = serde_json::from_value(turn)?;
            child.load_snapshot(&snapshot)?;
        }
        None => child.initialize().await?,
    }
    Ok(child.local.interrupt_state().activated())
}

/// The ids of the interrupts stored in an interrupted turn.
fn pending_interrupt_ids(turn: &JsonValue) -> Option<Vec<String>> {
    let interrupts = turn.get("data")?.get("interrupts")?.get("interrupts")?.as_object()?;
    Some(interrupts.keys().cloned().collect())
}

/// Percent-encodes every byte outside the URI-component unreserved set, so forwarded interrupt ids
/// match the other Strands SDKs.
fn encode_uri_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte);
        if unreserved {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Interrupts raised inside an agent used as a tool.
#[cfg(test)]
mod tests;

/// `AgentToolStreamer` cases with real child agents.
#[cfg(test)]
mod streamer_tests;
