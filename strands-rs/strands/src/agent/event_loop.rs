//! The agent loop.
//!
//! Cancellation and interrupts travel as [`Halt`] values.
//! Every model call goes through [`Agent::invoke_model_stage`] and every tool call through the
//! tool pipeline's `execute_tool_stage`, the seams middleware wraps.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, PoisonError};

use futures::StreamExt;
use indexmap::IndexMap;

use super::agent::{Agent, InFlight, PendingCleanup};
use super::config::InvokeOptions;
use super::continuation::{self, ContinuationInput, Prepared};
use super::invocation_context::{InvocationContext, LimitKey};
use super::invocation_state::InvocationState;
use super::invoke_args::InvokeArgs;
use super::result::AgentResult;
use super::stream::Emitter;
use super::tool_pipeline::{LoopEvent, ToolCallPipeline};
use crate::cancel::{CancelHandle, CancelOptions, CancelSignal};
use crate::error::{Error, Result};
use crate::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolsEvent, AgentResultEvent, AgentStreamEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolsEvent, ContentBlockEvent, EndTurn, InterruptEvent,
    MessageAddedEvent, ModelMessageEvent, ModelStopResponse, ModelStreamUpdateEvent, ToolResultEvent,
};
use crate::hooks::{ContentBlockEventData, ModelStreamUpdateEventData};
use crate::interrupt::{Interrupt, InterruptError, PendingToolExecution};
use crate::middleware::{
    InvokeModelContext, InvokeModelResult, InvokeModelStage, MiddlewareError, StageItem, StageResult, StageStream,
    TerminalFn,
};
use crate::models::model_proxy::ModelProxy;
use crate::models::routing::{RouterAttachment, same_model};
use crate::models::{
    AggregatedEvent, CountTokensOptions, Model, ModelRequest, StreamAggregatedResult, is_js_whitespace,
};
use crate::state_store::StateStore;
use crate::telemetry::{
    AgentSpan, Cycle, EndAgentSpanOptions, EndModelSpanOptions, ModelSpan, StartAgentSpanOptions,
    StartModelInvokeSpanOptions, Tracer,
};
use crate::tools::executors::{ExecutorItem, ToolBatch, ToolPipelineFn};
use crate::tools::{STRUCTURED_OUTPUT_TOOL_NAME, StructuredOutputTool, is_valid_tool_name};
use crate::types::AgentMetadata;
use crate::types::{
    ContentBlock, JsonSchema, JsonValue, Message, Role, StopReason, TextBlock, ToolChoice, ToolResultBlock,
    ToolResultContent, ToolSpec, ToolUseBlock,
};

const CANCELLED_BY_USER: &str = "Cancelled by user";
const INVALID_TOOL_NAME_PLACEHOLDER: &str = "INVALID_TOOL_NAME";
const BLANK_TEXT_PLACEHOLDER: &str = "[blank text]";

/// Why the loop stopped before producing a result.
pub(crate) enum Halt {
    Cancelled,
    Interrupt(Vec<Interrupt>),
    Error(Error),
}

impl From<Error> for Halt {
    fn from(error: Error) -> Self {
        match error {
            Error::Interrupt(interrupts) => Self::Interrupt(interrupts.into_interrupts()),
            error => Self::Error(error),
        }
    }
}

type Flow<T> = std::result::Result<T, Halt>;

/// The internal error a cancelled model call reports to `AfterModelCallEvent` (`CancelledError`).
#[derive(Debug, thiserror::Error)]
#[error("Agent invocation cancelled")]
struct CancelledError;

/// Whether `error` is the cancellation a cancelled model call reports.
pub(crate) fn is_cancelled_error(error: &Error) -> bool {
    matches!(error, Error::Other(error) if error.is::<CancelledError>())
}

#[cfg(test)]
pub(crate) fn cancelled_error() -> Error {
    Error::other(CancelledError)
}

/// One invocation's shared state.
pub(crate) struct Run<'e> {
    emitter: &'e Emitter,
    invocation_state: InvocationState,
    invocation_context: InvocationContext,
}

/// The input the first cycle appends: the caller's messages, or continuation messages ahead of
/// them.
enum PendingInput {
    Messages(Vec<Message>),
    Continuation(Prepared, Vec<Message>),
}

const NOT_INCORPORATED: &str = "Continuation was not incorporated into agent history";

/// How a cycle ended.
enum Step {
    Continue,
    Done(Box<AgentResult>),
}

/// How a turn that ended without a tool call continues (`TextTurnOutcome`).
enum TextTurn {
    Retry,
    End {
        stop_reason: StopReason,
        structured_output: Option<JsonValue>,
    },
}

/// The tool batch of a turn (`ToolsExecutionResult`).
struct ToolsResult {
    message: Message,
    end_turn: EndTurn,
    skipped: bool,
}

/// Repairs history when an invocation's stream is dropped mid-run.
struct InvocationGuard<'a> {
    agent: &'a mut Agent,
    armed: bool,
}

impl Drop for InvocationGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.agent.abandon_invocation();
        }
    }
}

impl Agent {
    pub(crate) async fn run_invocation(
        &mut self,
        args: InvokeArgs,
        options: InvokeOptions,
        emitter: Emitter,
    ) -> Result<AgentResult> {
        self.run_pending_cleanup().await;
        let mut guard = InvocationGuard {
            agent: self,
            armed: true,
        };
        let result = guard.agent.stream_invocation(args, options, &emitter).await;
        guard.armed = false;
        guard.agent.in_flight = None;
        guard.agent.end_cancel_scope();
        result
    }

    /// Runs the hooks a dropped stream left pending, logging their errors.
    pub(crate) async fn run_pending_cleanup(&mut self) {
        while self.pending_cleanup.is_some() {
            if let Err(error) = self.run_cleanup_step().await {
                tracing::warn!("error=<{error}> | error invoking callbacks during cleanup");
            }
        }
    }

    /// Runs the pending hooks and fails on the first hook error, dropping what is left.
    pub(crate) async fn drain_pending_cleanup(&mut self) -> Result<()> {
        while self.pending_cleanup.is_some() {
            if let Err(error) = self.run_cleanup_step().await {
                self.pending_cleanup = None;
                return Err(error);
            }
        }
        Ok(())
    }

    /// Fires the next pending event: one item leaves the queue only once its callbacks ran, so a
    /// cleanup that is itself dropped resumes at the callback it interrupted.
    async fn run_cleanup_step(&mut self) -> Result<()> {
        let Some(cleanup) = &self.pending_cleanup else {
            return Ok(());
        };
        let hooks = self.local.hooks().clone();
        let invocation_state = cleanup.invocation_state.clone();
        let invocation_context = cleanup.invocation_context.clone();
        if let Some(message) = cleanup.messages.front().cloned() {
            let progress = cleanup.message_progress.clone();
            let mut event = MessageAddedEvent::new(&mut self.local, invocation_state, message)
                .with_invocation_context(invocation_context);
            let invoked = hooks.invoke_tracked(&mut event, &progress).await;
            drop(event);
            progress.store(0, Ordering::SeqCst);
            if let Some(cleanup) = &mut self.pending_cleanup {
                cleanup.messages.pop_front();
            }
            return invoked;
        }
        let after_invocation = cleanup.after_invocation.clone();
        if let Some(progress) = after_invocation {
            // The invocation ended with its dropped stream: hooks see it cancelled, so none waits
            // for work (background tasks) the dropped invocation no longer collects.
            let cancelled = CancelHandle::new();
            cancelled.cancel(CancelOptions::default());
            let previous = self.local.cancel_signal();
            self.local.set_cancel_signal(cancelled.signal());
            let mut event = AfterInvocationEvent::new(&mut self.local, invocation_state)
                .with_invocation_context(invocation_context);
            let invoked = hooks.invoke_tracked(&mut event, &progress).await;
            drop(event);
            self.local.set_cancel_signal(previous);
            self.pending_cleanup = None;
            return invoked;
        }
        self.pending_cleanup = None;
        Ok(())
    }

    /// The drop guard: closes an open user turn with the cancel message, unless
    /// the turn stopped for interrupts and awaits its resume, removes the structured output tool
    /// and defers the hooks that `Drop` cannot run: `MessageAddedEvent` for messages already in
    /// history and a due `AfterInvocationEvent`, each from the callback the drop interrupted.
    fn abandon_invocation(&mut self) {
        let Some(in_flight) = self.in_flight.take() else {
            self.end_cancel_scope();
            return;
        };
        if in_flight.structured_output_registered {
            self.local.tool_registry_mut().remove(STRUCTURED_OUTPUT_TOOL_NAME);
        }
        let mut messages = std::mem::take(&mut self.hook_progress.unfired);
        let awaiting_resume = self.local.interrupt_state().activated();
        if !awaiting_resume && self.has_open_user_turn() {
            let message = self.cancel_result_message();
            self.local.messages_mut().push(message.clone());
            messages.push_back(message);
        }
        tracing::debug!("agent_id=<{}> | agent stream dropped mid-invocation", self.local.id());
        if in_flight.after_invocation_due || !messages.is_empty() {
            let message_progress = std::mem::take(&mut self.hook_progress.message);
            let after_invocation = in_flight
                .after_invocation_due
                .then(|| std::mem::take(&mut self.hook_progress.after_invocation));
            self.pending_cleanup = Some(PendingCleanup {
                messages,
                message_progress,
                after_invocation,
                invocation_state: in_flight.invocation_state,
                invocation_context: Some(in_flight.invocation_context),
            });
        }
        self.end_cancel_scope();
    }

    /// A fresh cancel signal for one pass, merged with the caller's.
    fn begin_cancel_scope(&mut self, external: Option<&CancelSignal>) {
        let handle = self.local.cancel_handle().clone();
        handle.reset();
        handle.set_active(true);
        let own = handle.signal();
        let signal = match external {
            Some(external) => CancelSignal::any(&own, external),
            None => own,
        };
        self.local.set_cancel_signal(signal);
    }

    fn end_cancel_scope(&mut self) {
        let handle = self.local.cancel_handle().clone();
        handle.set_active(false);
        handle.reset();
        self.local.set_cancel_signal(handle.signal());
    }

    fn is_aborted(&self) -> bool {
        self.local.cancel_signal().is_cancelled()
    }

    fn cancel_result_message(&self) -> Message {
        let text = self
            .local
            .cancel_signal()
            .reason()
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| CANCELLED_BY_USER.to_owned());
        Message::new(Role::Assistant, vec![ContentBlock::text(text)])
    }

    fn has_open_user_turn(&self) -> bool {
        self.local
            .messages()
            .last()
            .is_some_and(|message| message.role == Role::User)
    }

    fn set_after_invocation_due(&mut self, due: bool) {
        self.hook_progress.after_invocation.store(0, Ordering::SeqCst);
        if let Some(in_flight) = &mut self.in_flight {
            in_flight.after_invocation_due = due;
        }
    }

    fn set_structured_output_registered(&mut self, registered: bool) {
        if let Some(in_flight) = &mut self.in_flight {
            in_flight.structured_output_registered = registered;
        }
    }

    async fn emit(&mut self, run: &Run<'_>, record: AgentStreamEvent, cancelled: bool) {
        if let Some(printer) = &mut self.printer {
            printer.process_event(&record, cancelled);
        }
        run.emitter.emit(record).await;
    }

    fn result(&self, run: &Run<'_>, stop_reason: StopReason, last_message: Message) -> AgentResult {
        AgentResult::new(stop_reason, last_message)
            .with_traces(self.local.tracer().local_traces())
            .with_metrics(self.local.metrics())
            .with_invocation_state(run.invocation_state.clone())
            .with_invocation_context(run.invocation_context.clone())
    }

    fn close_cycle(&self, cycle: &mut Cycle) {
        cycle.close(None);
    }

    async fn stream_invocation(
        &mut self,
        args: InvokeArgs,
        options: InvokeOptions,
        emitter: &Emitter,
    ) -> Result<AgentResult> {
        self.initialize().await?;
        let invocation_state = options.invocation_state.clone().unwrap_or_default();
        let invocation_context = InvocationContext::resolve(options.limits, options.invocation_context.as_ref())?;
        self.in_flight = Some(InFlight {
            invocation_state: invocation_state.clone(),
            invocation_context: invocation_context.clone(),
            after_invocation_due: false,
            structured_output_registered: false,
        });
        let run = Run {
            emitter,
            invocation_state,
            invocation_context,
        };
        let mut current = args;
        let mut continuation: Option<Prepared> = None;
        loop {
            self.begin_cancel_scope(options.cancel_signal.as_ref());
            if let InvokeArgs::InterruptResponses(responses) = &current {
                self.local.interrupt_state().resume(responses)?;
            }
            let input_messages = normalize_input(&current)?;
            let hooks = self.local.hooks().clone();
            let mut before = BeforeInvocationEvent::new(&mut self.local, run.invocation_state.clone(), input_messages)
                .with_invocation_context(Some(run.invocation_context.clone()));
            hooks.invoke(&mut before).await?;
            let cancel = before
                .cancel()
                .message_or("invocation denied by hook")
                .map(str::to_owned);
            let messages = before.take_messages();
            let record = AgentStreamEvent::from(&before);
            drop(before);
            self.emit(&run, record, false).await;

            if let Some(text) = cancel {
                let message = Message::new(Role::Assistant, vec![ContentBlock::text(text)]);
                self.append_message(&run, message.clone()).await?;
                if let Some(prepared) = continuation.take() {
                    prepared.abandon(NOT_INCORPORATED);
                }
                let (_, inputs) = self.after_invocation(&run).await?;
                continuation::abandon(inputs, continuation::STREAM_CLOSED);
                return Ok(self.result(&run, StopReason::EndTurn, message));
            }

            self.set_after_invocation_due(true);
            let outcome = self
                .stream_with_middleware(&run, &current, messages, &options, &mut continuation)
                .await;
            if let Some(prepared) = continuation.take() {
                prepared.abandon(NOT_INCORPORATED);
            }
            let after = self.after_invocation(&run).await;
            let result = outcome?;
            let (resume, inputs) = after?;
            let stop_reason = result.stop_reason();
            continuation = continuation::prepare(inputs, Some(&stop_reason), Some(&mut self.deferred_continuations));
            let has_continuation = continuation.is_some();
            let resume = self.should_resume(resume, &run.invocation_context);
            if has_continuation || resume.is_some() {
                current = resume.unwrap_or_else(|| InvokeArgs::Messages(Vec::new()));
                continue;
            }
            let hooks = self.local.hooks().clone();
            let mut event = AgentResultEvent::new(&mut self.local, run.invocation_state.clone(), result.clone())
                .with_invocation_context(Some(run.invocation_context.clone()));
            hooks.invoke(&mut event).await?;
            let record = AgentStreamEvent::from(&event);
            drop(event);
            self.emit(&run, record, false).await;
            return Ok(result);
        }
    }

    /// Fires `AfterInvocationEvent` and returns the resume input and continuation input hooks
    /// set.
    async fn after_invocation(&mut self, run: &Run<'_>) -> Result<(Option<InvokeArgs>, Vec<ContinuationInput>)> {
        let hooks = self.local.hooks().clone();
        let progress = self.hook_progress.after_invocation.clone();
        let mut event = AfterInvocationEvent::new(&mut self.local, run.invocation_state.clone())
            .with_invocation_context(Some(run.invocation_context.clone()));
        let invoked = hooks.invoke_tracked(&mut event, &progress).await;
        let resume = event.take_resume();
        let inputs = event.take_continuation_inputs();
        let record = AgentStreamEvent::from(&event);
        drop(event);
        self.set_after_invocation_due(false);
        invoked?;
        self.emit(run, record, false).await;
        Ok((resume, inputs))
    }

    /// Whether a hook's resume starts another pass; never once a limit is reached.
    fn should_resume(&self, resume: Option<InvokeArgs>, invocation_context: &InvocationContext) -> Option<InvokeArgs> {
        let resume = resume?;
        match invocation_context.reached_limit() {
            None => Some(resume),
            Some(limit) => {
                tracing::debug!("limit=<{limit}> | ignoring resume because the request reached its limit");
                None
            }
        }
    }

    /// The seam for `AgentStreamStage` middleware.
    async fn stream_with_middleware(
        &mut self,
        run: &Run<'_>,
        args: &InvokeArgs,
        input_messages: Vec<Message>,
        options: &InvokeOptions,
        continuation: &mut Option<Prepared>,
    ) -> Result<AgentResult> {
        let continuation_applies =
            continuation.is_some() && (!normalize_input(args)?.is_empty() || is_empty_list(args));
        let pending = if continuation_applies {
            continuation.take()
        } else {
            None
        };
        let result = self.stream_core(run, args, input_messages, options, pending).await?;
        let state = self.local.interrupt_state();
        if state.activated() && result.stop_reason() != StopReason::Interrupt && !state.has_pending_tool_execution() {
            state.deactivate();
        }
        Ok(result)
    }

    /// One pass of the loop (`_stream`).
    async fn stream_core(
        &mut self,
        run: &Run<'_>,
        args: &InvokeArgs,
        input_messages: Vec<Message>,
        options: &InvokeOptions,
        continuation: Option<Prepared>,
    ) -> Result<AgentResult> {
        let message_count_at_start = self.local.messages().len();
        let schema = options
            .structured_output_schema
            .clone()
            .or_else(|| self.structured_output_schema.clone());
        let structured_output_tool = schema.clone().map(StructuredOutputTool::new).transpose()?;
        let resuming = matches!(args, InvokeArgs::InterruptResponses(responses) if !responses.is_empty());
        if self.local.interrupt_state().activated() && !resuming {
            return Err(Error::other(
                "Agent is in an interrupted state. Resume by invoking with interruptResponse content blocks.",
            ));
        }
        let pending_input = match (resuming, continuation) {
            (true, Some(prepared)) => {
                prepared.abandon(NOT_INCORPORATED);
                None
            }
            (true, None) => None,
            (false, Some(mut prepared)) => {
                let messages = std::mem::take(&mut prepared.messages);
                Some(PendingInput::Continuation(
                    prepared,
                    messages.into_iter().chain(input_messages).collect(),
                ))
            }
            (false, None) => Some(PendingInput::Messages(input_messages)),
        };
        self.local
            .meter()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .start_new_invocation();
        let agent_span = self.start_agent_span(pending_input.as_ref());

        let outcome = match &structured_output_tool {
            Some(tool) => match self.local.tool_registry_mut().add(tool.clone()) {
                Ok(()) => {
                    self.set_structured_output_registered(true);
                    let outcome = self
                        .run_cycles(run, pending_input, Some(tool), schema, message_count_at_start)
                        .await;
                    self.local.tool_registry_mut().remove(STRUCTURED_OUTPUT_TOOL_NAME);
                    self.set_structured_output_registered(false);
                    outcome
                }
                Err(error) => Err(Halt::Error(error)),
            },
            None => {
                self.run_cycles(run, pending_input, None, None, message_count_at_start)
                    .await
            }
        };

        let result = self.finish_pass(run, outcome).await;
        let error = result.as_ref().err().map(ToString::to_string);
        let ok = result.as_ref().ok();
        agent_span.end(EndAgentSpanOptions {
            response: ok.map(AgentResult::last_message),
            error,
            accumulated_usage: None,
            stop_reason: ok.map(|result| result.stop_reason()).as_ref().map(StopReason::as_str),
        });
        result
    }

    /// Starts the `invoke_agent` span of a pass with its input messages.
    fn start_agent_span(&self, pending_input: Option<&PendingInput>) -> AgentSpan {
        let messages = match pending_input {
            Some(PendingInput::Messages(messages) | PendingInput::Continuation(_, messages)) => messages.as_slice(),
            None => &[],
        };
        let tools = self.local.tool_registry().list();
        let tool_names: Vec<String> = tools.iter().map(|tool| tool.name().to_owned()).collect();
        let tracer = self.local.tracer();
        let tools_config: Option<crate::types::JsonObject> = tracer.includes_tool_definitions().then(|| {
            tools
                .iter()
                .map(|tool| {
                    (
                        tool.name().to_owned(),
                        serde_json::to_value(tool.tool_spec()).unwrap_or_default(),
                    )
                })
                .collect()
        });
        let model_id = self.local.model().model_id();
        tracer
            .start_agent_span(StartAgentSpanOptions {
                messages,
                agent_name: self.local.name(),
                agent_id: Some(self.local.id()),
                model_id: model_id.as_deref(),
                tools: &tool_names,
                tools_config: tools_config.as_ref(),
                system_prompt: self.local.system_prompt(),
                ..StartAgentSpanOptions::default()
            })
            .with_meter(self.local.meter().clone())
    }

    /// Turns a pass's outcome into its result: a cancelled pass closes the user turn, an
    /// interrupted one fires `InterruptEvent`.
    async fn finish_pass(&mut self, run: &Run<'_>, outcome: Flow<AgentResult>) -> Result<AgentResult> {
        match outcome {
            Ok(result) => Ok(result),
            Err(Halt::Error(error)) => Err(error),
            Err(Halt::Cancelled) => {
                let message = self.cancel_result_message();
                if self.has_open_user_turn() {
                    self.append_message(run, message.clone()).await?;
                }
                Ok(self.result(run, StopReason::Cancelled, message))
            }
            Err(Halt::Interrupt(interrupts)) => self.stop_for_interrupts(run, interrupts).await,
        }
    }

    async fn stop_for_interrupts(&mut self, run: &Run<'_>, interrupts: Vec<Interrupt>) -> Result<AgentResult> {
        for interrupt in &interrupts {
            self.local.interrupt_state().register_interrupt(interrupt);
        }
        self.local.interrupt_state().activate();
        for interrupt in interrupts {
            let hooks = self.local.hooks().clone();
            let mut event = InterruptEvent::new(&mut self.local, run.invocation_state.clone(), interrupt)
                .with_invocation_context(Some(run.invocation_context.clone()));
            hooks.invoke(&mut event).await?;
            let record = AgentStreamEvent::from(&event);
            drop(event);
            self.emit(run, record, false).await;
        }
        Ok(self.interrupt_result(run))
    }

    /// The result of a pass an interrupt stopped, carrying the unanswered interrupts.
    fn interrupt_result(&self, run: &Run<'_>) -> AgentResult {
        let last_message = self
            .local
            .messages()
            .last()
            .cloned()
            .unwrap_or_else(|| Message::new(Role::Assistant, vec![ContentBlock::text("Interrupted")]));
        self.result(run, StopReason::Interrupt, last_message)
            .with_interrupts(self.local.interrupt_state().unanswered_interrupts())
    }

    async fn run_cycles(
        &mut self,
        run: &Run<'_>,
        mut pending_input: Option<PendingInput>,
        structured_output_tool: Option<&StructuredOutputTool>,
        schema: Option<JsonSchema>,
        message_count_at_start: usize,
    ) -> Flow<AgentResult> {
        let mut structured_output_choice: Option<ToolChoice> = None;
        loop {
            if self.is_aborted() {
                return Err(Halt::Cancelled);
            }
            if let Some(limit) = run.invocation_context.reached_limit() {
                return Ok(self.limit_result(run, limit, message_count_at_start));
            }
            run.invocation_context.record_turn();
            let mut cycle = Cycle::start(self.local.meter(), self.local.tracer(), self.local.messages());
            let step = self
                .run_cycle(
                    run,
                    &mut pending_input,
                    &mut structured_output_choice,
                    structured_output_tool,
                    schema.as_ref(),
                    &mut cycle,
                )
                .await;
            cycle.close(step.as_ref().err().map(halt_message).as_deref());
            match step? {
                Step::Continue => {}
                Step::Done(result) => return Ok(*result),
            }
        }
    }

    /// The result of a pass a limit stopped: the last message added during the pass, or an empty
    /// assistant message.
    fn limit_result(&self, run: &Run<'_>, limit: StopReason, message_count_at_start: usize) -> AgentResult {
        let messages = self.local.messages();
        let last_message = (messages.len() > message_count_at_start)
            .then(|| messages.last().cloned())
            .flatten()
            .unwrap_or_else(|| Message::new(Role::Assistant, Vec::new()));
        self.result(run, limit, last_message)
    }

    async fn run_cycle(
        &mut self,
        run: &Run<'_>,
        pending_input: &mut Option<PendingInput>,
        structured_output_choice: &mut Option<ToolChoice>,
        structured_output_tool: Option<&StructuredOutputTool>,
        schema: Option<&JsonSchema>,
        cycle: &mut Cycle,
    ) -> Flow<Step> {
        match pending_input.take() {
            Some(PendingInput::Messages(messages)) => {
                for message in messages {
                    self.append_message(run, message).await?;
                }
            }
            Some(PendingInput::Continuation(prepared, messages)) => {
                self.append_continuation_messages(run, messages).await?;
                prepared.mark_appended();
            }
            None => {}
        }

        let (assistant_message, completed) = match self.local.interrupt_state().pending_execution() {
            Some(pending) => (pending.assistant_message_data, pending.completed_tool_results),
            None => {
                let forced_schema = structured_output_choice.as_ref().and(schema).cloned();
                let model_result = self
                    .invoke_model(run, structured_output_choice.clone(), forced_schema)
                    .await?;
                if model_result.stop_reason != StopReason::ToolUse {
                    return self
                        .end_text_turn(
                            run,
                            model_result,
                            structured_output_choice,
                            structured_output_tool,
                            cycle,
                        )
                        .await;
                }
                if structured_output_choice.is_some()
                    && structured_output_tool_use_ids(&model_result.message).is_empty()
                {
                    run.invocation_context.record_structured_output_failure();
                }
                if self.is_aborted() {
                    return self.cancel_before_tools(run, model_result.message, cycle).await;
                }
                (model_result.message, IndexMap::new())
            }
        };

        let tools = self.execute_tools(run, &assistant_message, completed).await?;
        if self.is_aborted() && tools.skipped && self.local.interrupt_state().has_pending_tool_execution() {
            return Ok(Step::Continue);
        }
        let structured_output =
            structured_output_tool.and_then(|_| extract_structured_output(&assistant_message, &tools.message));
        self.append_messages(run, vec![assistant_message.clone(), tools.message])
            .await?;
        let interrupt_state = self.local.interrupt_state();
        interrupt_state.clear_pending_tool_execution();
        if interrupt_state.activated() {
            interrupt_state.deactivate();
        }
        self.close_cycle(cycle);
        if structured_output_tool.is_some()
            && structured_output.is_none()
            && !structured_output_tool_use_ids(&assistant_message).is_empty()
        {
            run.invocation_context.record_structured_output_failure();
        }

        if let Some(content) = end_turn_content(tools.end_turn) {
            let last_message = Message::new(Role::Assistant, content);
            self.append_message(run, last_message.clone()).await?;
            return Ok(Step::Done(Box::new(self.result(
                run,
                StopReason::EndTurn,
                last_message,
            ))));
        }
        let signal = self.local.cancel_signal();
        if signal.is_deferred() || signal.is_cancelled() {
            let message = self.cancel_result_message();
            self.append_message(run, message.clone()).await?;
            let result = self.result(run, StopReason::Cancelled, message);
            return Ok(Step::Done(Box::new(with_structured_output(result, structured_output))));
        }
        if let Some(structured_output) = structured_output {
            let result = self
                .result(run, StopReason::ToolUse, assistant_message)
                .with_structured_output(structured_output);
            return Ok(Step::Done(Box::new(result)));
        }
        Ok(Step::Continue)
    }

    async fn end_text_turn(
        &mut self,
        run: &Run<'_>,
        model_result: StreamAggregatedResult,
        structured_output_choice: &mut Option<ToolChoice>,
        structured_output_tool: Option<&StructuredOutputTool>,
        cycle: &mut Cycle,
    ) -> Flow<Step> {
        let turn = resolve_text_turn(
            &model_result,
            structured_output_tool,
            structured_output_choice.is_some(),
            &run.invocation_context,
        )?;
        self.close_cycle(cycle);
        let TextTurn::End {
            stop_reason,
            structured_output,
        } = turn
        else {
            *structured_output_choice = Some(ToolChoice::tool(STRUCTURED_OUTPUT_TOOL_NAME));
            tracing::debug!(
                "structured output schema set but model responded with plain text; forcing tool use on next cycle"
            );
            return Ok(Step::Continue);
        };
        self.append_message(run, model_result.message.clone()).await?;
        let result = self.result(run, stop_reason, model_result.message);
        Ok(Step::Done(Box::new(with_structured_output(result, structured_output))))
    }

    /// Cancel observed after the model asked for tools: every tool gets a cancelled result.
    async fn cancel_before_tools(
        &mut self,
        run: &Run<'_>,
        assistant_message: Message,
        cycle: &mut Cycle,
    ) -> Flow<Step> {
        let cancelled = cancelled_results(&tool_use_blocks(&assistant_message), "Tool execution cancelled");
        self.append_messages(run, vec![assistant_message, tool_result_message(cancelled)])
            .await?;
        self.close_cycle(cycle);
        let message = self.cancel_result_message();
        self.append_message(run, message.clone()).await?;
        Ok(Step::Done(Box::new(self.result(run, StopReason::Cancelled, message))))
    }

    /// Appends a message to history and fires `MessageAddedEvent`.
    async fn append_message(&mut self, run: &Run<'_>, message: Message) -> Result<()> {
        self.append_messages(run, vec![message]).await
    }

    /// Appends messages to history together, then fires `MessageAddedEvent` for each. History
    /// holds a tool use and its results together before any hook runs, so a stream dropped in a
    /// hook leaves it re-invokable; the drop guard defers the events that did not finish.
    async fn append_messages(&mut self, run: &Run<'_>, messages: Vec<Message>) -> Result<()> {
        self.local.messages_mut().extend(messages.iter().cloned());
        self.fire_message_added(run, messages).await
    }

    /// Fires `MessageAddedEvent` for messages already in history, one after another.
    async fn fire_message_added(&mut self, run: &Run<'_>, messages: Vec<Message>) -> Result<()> {
        self.hook_progress.unfired.extend(messages);
        while let Some(message) = self.hook_progress.unfired.front().cloned() {
            let hooks = self.local.hooks().clone();
            let progress = self.hook_progress.message.clone();
            let mut event = MessageAddedEvent::new(&mut self.local, run.invocation_state.clone(), message)
                .with_invocation_context(Some(run.invocation_context.clone()));
            let invoked = hooks.invoke_tracked(&mut event, &progress).await;
            let record = AgentStreamEvent::from(&event);
            drop(event);
            self.hook_progress.unfired.pop_front();
            progress.store(0, Ordering::SeqCst);
            if let Err(error) = invoked {
                self.hook_progress.unfired.clear();
                return Err(error);
            }
            self.emit(run, record, false).await;
        }
        Ok(())
    }

    /// Appends messages, merging each into the last message when they share a role, and fires
    /// `MessageAddedEvent` for every message that changed.
    async fn append_continuation_messages(&mut self, run: &Run<'_>, messages: Vec<Message>) -> Result<()> {
        let mut changed: Vec<usize> = Vec::new();
        for message in messages {
            let history = self.local.messages_mut();
            match history.last_mut() {
                Some(last) if last.role == message.role => last.content.extend(message.content),
                _ => history.push(message),
            }
            let index = history.len() - 1;
            if changed.last() != Some(&index) {
                changed.push(index);
            }
        }
        let changed = changed
            .into_iter()
            .map(|index| self.local.messages()[index].clone())
            .collect();
        self.fire_message_added(run, changed).await
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.local.tool_registry().tool_specs()
    }

    /// Calls the model, with the before and after hooks and retries.
    async fn invoke_model(
        &mut self,
        run: &Run<'_>,
        tool_choice: Option<ToolChoice>,
        structured_output_schema: Option<JsonSchema>,
    ) -> Flow<StreamAggregatedResult> {
        let mut attempt_count = 1;
        loop {
            if self.is_aborted() {
                return Err(Halt::Cancelled);
            }
            self.mcp.apply_changes(self.local.tool_registry_mut());
            let model = self.routed_model().unwrap_or_else(|| self.local.model().clone());
            let tool_specs = self.tool_specs();
            let mut projected_input_tokens = match self.estimate_input_tokens(&tool_specs).await {
                Ok(tokens) => Some(tokens),
                Err(error) => {
                    tracing::debug!("error=<{error}> | token estimation failed, proceeding without estimate");
                    None
                }
            };
            let hooks = self.local.hooks().clone();
            let mut before = BeforeModelCallEvent::new(&mut self.local, run.invocation_state.clone(), model.clone())
                .with_invocation_context(Some(run.invocation_context.clone()));
            if let Some(tokens) = projected_input_tokens {
                before = before.with_projected_input_tokens(tokens);
            }
            hooks.invoke(&mut before).await?;
            let raised = before.take_raised_interrupts();
            if !raised.is_empty() {
                return Err(Halt::Interrupt(raised));
            }
            let cancel = before
                .cancel()
                .message_or("model call denied by hook")
                .map(str::to_owned);
            let inputs = before.take_continuation_inputs();
            let record = AgentStreamEvent::from(&before);
            drop(before);
            self.emit(run, record, false).await;
            let prepared = continuation::prepare(inputs, None, None);

            if let Some(text) = cancel {
                if let Some(prepared) = prepared {
                    prepared.abandon("Continuation abandoned by BeforeModelCallEvent");
                }
                let message = Message::new(Role::Assistant, vec![ContentBlock::text(text)]);
                let stop_data = ModelStopResponse::new(message.clone(), StopReason::EndTurn);
                let (retry, _) = self
                    .after_model_call(run, model.clone(), attempt_count, Ok(stop_data))
                    .await?;
                if retry {
                    attempt_count = self.next_attempt_count(&model, attempt_count);
                    continue;
                }
                return Ok(StreamAggregatedResult::new(message, StopReason::EndTurn));
            }
            if let Some(mut prepared) = prepared {
                let messages = std::mem::take(&mut prepared.messages);
                self.append_continuation_messages(run, messages).await?;
                prepared.mark_appended();
                projected_input_tokens = match self.estimate_input_tokens(&tool_specs).await {
                    Ok(tokens) => Some(tokens),
                    Err(error) => {
                        tracing::debug!(
                            "error=<{error}> | token estimation failed after continuation input, proceeding without estimate"
                        );
                        None
                    }
                };
            }

            let (outcome, invoked) = self
                .invoke_model_stage(
                    run,
                    &model,
                    tool_choice.clone(),
                    structured_output_schema.clone(),
                    projected_input_tokens,
                )
                .await;
            let routed = self.routed_model().unwrap_or_else(|| model.clone());
            // A failure before the terminal ran (in input middleware) is the routed model's.
            let model = invoked.unwrap_or_else(|| if outcome.is_ok() { model } else { routed.clone() });
            match outcome {
                Ok(result) => {
                    self.local
                        .meter()
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .update_cycle(
                            result.metadata.as_ref().and_then(|metadata| metadata.usage.as_ref()),
                            result.metadata.as_ref().and_then(|metadata| metadata.metrics.as_ref()),
                        );
                    let hooks = self.local.hooks().clone();
                    let mut event = ModelMessageEvent::new(
                        &mut self.local,
                        run.invocation_state.clone(),
                        result.message.clone(),
                        result.stop_reason.clone(),
                    )
                    .with_invocation_context(Some(run.invocation_context.clone()));
                    hooks.invoke(&mut event).await?;
                    let record = AgentStreamEvent::from(&event);
                    drop(event);
                    self.emit(run, record, false).await;
                    if let Some(redaction) = &result.redaction {
                        let user_message = redaction.user_message.clone();
                        self.redact_last_message(&user_message);
                    }
                    let mut stop_data = ModelStopResponse::new(result.message.clone(), result.stop_reason.clone());
                    stop_data.redaction.clone_from(&result.redaction);
                    let (retry, _) = self.after_model_call(run, model, attempt_count, Ok(stop_data)).await?;
                    if retry {
                        attempt_count = self.next_attempt_count(&routed, attempt_count);
                        continue;
                    }
                    return Ok(result);
                }
                Err(halt) => {
                    let (cancelled, error) = match halt {
                        Halt::Cancelled => (true, Error::other(CancelledError)),
                        Halt::Error(error) => (false, error),
                        Halt::Interrupt(interrupts) => (false, Error::Interrupt(InterruptError::new(interrupts))),
                    };
                    let (retry, error) = self.after_model_call(run, model, attempt_count, Err(error)).await?;
                    if cancelled {
                        return Err(Halt::Cancelled);
                    }
                    if retry {
                        attempt_count = self.next_attempt_count(&routed, attempt_count);
                        continue;
                    }
                    return Err(Halt::from(error.unwrap_or_else(|| Error::other("model call failed"))));
                }
            }
        }
    }

    /// The model the router chose for this invocation, once its opening selection ran.
    fn routed_model(&self) -> Option<Arc<dyn Model>> {
        self.model_router.as_ref().and_then(RouterAttachment::routed_model)
    }

    /// The attempt count of a retry: 1 when the router switched away from
    /// `model`, otherwise one more.
    fn next_attempt_count(&self, model: &Arc<dyn Model>, attempt_count: u32) -> u32 {
        match self.routed_model() {
            Some(next) if !same_model(&next, model) => 1,
            _ => attempt_count + 1,
        }
    }

    /// Fires `AfterModelCallEvent`; returns whether a hook asked to retry and the error back.
    async fn after_model_call(
        &mut self,
        run: &Run<'_>,
        model: Arc<dyn Model>,
        attempt_count: u32,
        outcome: std::result::Result<ModelStopResponse, Error>,
    ) -> Flow<(bool, Option<Error>)> {
        let hooks = self.local.hooks().clone();
        let event = AfterModelCallEvent::new(&mut self.local, run.invocation_state.clone(), model, attempt_count)
            .with_invocation_context(Some(run.invocation_context.clone()));
        let mut event = match outcome {
            Ok(stop_data) => event.with_stop_data(stop_data),
            Err(error) => event.with_error(error),
        };
        hooks.invoke(&mut event).await?;
        let record = AgentStreamEvent::from(&event);
        let retry = event.retry();
        let error = event.take_error();
        drop(event);
        self.emit(run, record, false).await;
        Ok((retry, error))
    }

    /// Runs the model call through the `InvokeModelStage` chain.
    /// Every terminal call gets a fresh copy of the pre-chain model state; the copy of the last
    /// call that ran is committed when the whole chain succeeds, and nothing is when no call ran.
    /// Returns the outcome and the model the terminal called, when it ran.
    async fn invoke_model_stage(
        &mut self,
        run: &Run<'_>,
        model: &Arc<dyn Model>,
        tool_choice: Option<ToolChoice>,
        structured_output_schema: Option<JsonSchema>,
        projected_input_tokens: Option<u64>,
    ) -> (Flow<StreamAggregatedResult>, Option<Arc<dyn Model>>) {
        let model_state = self.local.model_state().snapshot();
        let latest_model_state: Arc<Mutex<Option<StateStore>>> = Arc::default();
        let invoked: Arc<Mutex<Option<Arc<dyn Model>>>> = Arc::default();
        let context = InvokeModelContext {
            agent: self
                .local
                .tool_agent()
                .with_invocation_context(Some(run.invocation_context.clone())),
            model: model.clone(),
            messages: self.local.messages().to_vec(),
            system_prompt: self.local.system_prompt().cloned(),
            tool_specs: self.tool_specs(),
            tool_choice,
            invocation_state: run.invocation_state.clone(),
            projected_input_tokens,
            dynamic_trailing_blocks: None,
            structured_output_schema,
            invocation_context: Some(run.invocation_context.clone()),
        };
        let terminal = model_terminal(ModelTerminal {
            tracer: self.local.tracer().clone(),
            model_state,
            latest_model_state: latest_model_state.clone(),
            agent_metadata: self.local.agent_metadata().cloned(),
            cancel_signal: self.local.cancel_signal(),
            invocation_context: run.invocation_context.clone(),
            invoked: invoked.clone(),
        });
        let stream = self.local.middleware().invoke::<InvokeModelStage>(context, terminal);
        let outcome = self.drive_model_stage(run, stream).await;
        let invoked = invoked.lock().unwrap_or_else(PoisonError::into_inner).take();
        let latest_model_state = latest_model_state.lock().unwrap_or_else(PoisonError::into_inner).take();
        if outcome.is_ok()
            && let Some(latest_model_state) = latest_model_state
        {
            self.local.model_state().replace_with(&latest_model_state);
        }
        (outcome, invoked)
    }

    /// Polls the model stage's chain, firing the stream and block hooks on the events that come
    /// out of it.
    async fn drive_model_stage(
        &mut self,
        run: &Run<'_>,
        mut stream: StageStream<InvokeModelStage>,
    ) -> Flow<StreamAggregatedResult> {
        let signal = self.local.cancel_signal();
        loop {
            let item = tokio::select! {
                biased;
                item = stream.next() => item,
                () = signal.cancelled() => return Err(Halt::Cancelled),
            };
            let item = match item {
                None => return Err(Halt::Error(Error::other("model stream ended without a result"))),
                Some(StageItem::Done(outcome)) => return self.model_stage_outcome(outcome),
                Some(item) => item,
            };
            if self.is_aborted() {
                return Err(Halt::Cancelled);
            }
            if let StageItem::Event(record) = item {
                self.fire_stage_event(run, record).await?;
            }
        }
    }

    fn model_stage_outcome(&self, outcome: StageResult<InvokeModelResult>) -> Flow<StreamAggregatedResult> {
        match outcome {
            Ok(result) => Ok(result.result),
            Err(MiddlewareError::Cancelled) => Err(Halt::Cancelled),
            Err(MiddlewareError::Interrupt(interrupts)) => Err(Halt::Interrupt(interrupts.into_interrupts())),
            Err(MiddlewareError::Error(error)) if self.is_aborted() => {
                tracing::debug!("error=<{error}> | model stream failed after cancellation");
                Err(Halt::Cancelled)
            }
            Err(MiddlewareError::Error(error)) => Err(Halt::Error(error)),
        }
    }

    /// Fires the hooks of a stream update or content block that came out of the model stage, and
    /// emits its record; other records are emitted as they are.
    async fn fire_stage_event(&mut self, run: &Run<'_>, record: AgentStreamEvent) -> Flow<()> {
        let hooks = self.local.hooks().clone();
        let record = match record {
            AgentStreamEvent::ModelStreamUpdate(data) => {
                let mut event = ModelStreamUpdateEvent::new(&mut self.local, run.invocation_state.clone(), data.event)
                    .with_invocation_context(Some(run.invocation_context.clone()));
                hooks.invoke(&mut event).await?;
                AgentStreamEvent::from(&event)
            }
            AgentStreamEvent::ContentBlock(data) => {
                let mut event =
                    ContentBlockEvent::new(&mut self.local, run.invocation_state.clone(), data.content_block)
                        .with_invocation_context(Some(run.invocation_context.clone()));
                hooks.invoke(&mut event).await?;
                AgentStreamEvent::from(&event)
            }
            other => other,
        };
        self.emit(run, record, false).await;
        Ok(())
    }

    /// Estimates the input tokens of the next model call: the last
    /// assistant message's known usage plus an estimate of what was added since.
    pub(crate) async fn estimate_input_tokens(&self, tool_specs: &[ToolSpec]) -> Result<u64> {
        let messages = self.local.messages();
        let proxy = ModelProxy::new(self.local.model().clone());
        let baseline = messages.iter().enumerate().rev().find_map(|(index, message)| {
            let usage = message.metadata.as_ref()?.usage.as_ref()?;
            (message.role == Role::Assistant).then_some((index, usage))
        });
        let Some((index, usage)) = baseline else {
            let options = CountTokensOptions {
                system_prompt: self.local.system_prompt().cloned(),
                tool_specs: tool_specs.to_vec(),
            };
            return proxy.count_tokens(messages, options).await;
        };
        let known = usage.total_prompt_tokens().saturating_add(usage.output_tokens);
        let added = &messages[index + 1..];
        if added.is_empty() {
            return Ok(known);
        }
        let estimate = proxy.count_tokens(added, CountTokensOptions::default()).await?;
        Ok(known.saturating_add(estimate))
    }

    /// Replaces the last user message after a guardrail redacted the input:
    /// tool results keep their structure with the redaction text, other
    /// content becomes the redaction text.
    pub(crate) fn redact_last_message(&mut self, redact_message: &str) {
        let Some(last) = self.local.messages_mut().last_mut() else {
            return;
        };
        if last.role != Role::User {
            tracing::warn!(
                "role=<{:?}> | received input redaction but last message is not from user | redaction skipped",
                last.role
            );
            return;
        }
        let mut redacted: Vec<ContentBlock> = last
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult(result) => Some(ContentBlock::ToolResult(ToolResultBlock::new(
                    result.tool_use_id.clone(),
                    result.status,
                    vec![ToolResultContent::text(redact_message)],
                ))),
                _ => None,
            })
            .collect();
        if redacted.is_empty() {
            redacted.push(ContentBlock::text(redact_message));
        }
        last.content = redacted;
    }

    /// Fires `BeforeToolsEvent`, runs the batch and fires `AfterToolsEvent`.
    async fn execute_tools(
        &mut self,
        run: &Run<'_>,
        assistant_message: &Message,
        completed: IndexMap<String, ToolResultBlock>,
    ) -> Flow<ToolsResult> {
        let hooks = self.local.hooks().clone();
        let mut before =
            BeforeToolsEvent::new(&mut self.local, run.invocation_state.clone(), assistant_message.clone())
                .with_invocation_context(Some(run.invocation_context.clone()));
        let invoked = hooks.invoke(&mut before).await;
        let cancel = before.cancel().message_or("Tool cancelled by hook").map(str::to_owned);
        let record = AgentStreamEvent::from(&before);
        drop(before);
        if let Err(error) = invoked {
            if matches!(error, Error::Interrupt(_)) {
                self.local
                    .interrupt_state()
                    .set_pending_tool_execution(PendingToolExecution::new(assistant_message.clone(), IndexMap::new()));
            }
            return Err(error.into());
        }
        self.emit(run, record, cancel.is_some()).await;

        let tool_uses = tool_use_blocks(assistant_message);
        let pipeline = ToolCallPipeline::new(
            hooks,
            self.local.middleware().clone(),
            run.invocation_state.clone(),
            self.local.meter().clone(),
            self.local.tracer().clone(),
        )
        .with_background(self.background_tasks.clone(), assistant_message.tracking_id());
        let view = self
            .local
            .tool_agent()
            .with_invocation_context(Some(run.invocation_context.clone()))
            .with_pipeline(Arc::new(pipeline.clone()));
        let cancel = cancel.or_else(|| self.is_aborted().then(|| "Tool execution cancelled".to_owned()));
        let mut skipped = false;
        let mut interrupts = Vec::new();
        let mut failure = None;
        let results = if tool_uses.is_empty() {
            failure = Some(Error::other(
                "Model indicated toolUse but no tool use blocks found in message",
            ));
            Vec::new()
        } else if let Some(message) = cancel {
            skipped = true;
            let results = cancelled_results(&tool_uses, &message);
            for result in &results {
                self.fire_tool_result(run, &view, result.clone()).await?;
            }
            results
        } else {
            let batch = self.run_batch(run, &view, pipeline, tool_uses, completed).await?;
            failure = batch.error;
            if !batch.interrupts.is_empty() {
                self.local
                    .interrupt_state()
                    .set_pending_tool_execution(PendingToolExecution::new(assistant_message.clone(), batch.completed));
                interrupts = batch.interrupts;
            }
            batch.results
        };

        let message = tool_result_message(results);
        let hooks = self.local.hooks().clone();
        let mut after = AfterToolsEvent::new(&mut self.local, run.invocation_state.clone(), message.clone())
            .with_invocation_context(Some(run.invocation_context.clone()));
        hooks.invoke(&mut after).await?;
        let end_turn = after.end_turn().clone();
        let record = AgentStreamEvent::from(&after);
        drop(after);
        self.emit(run, record, false).await;
        if let Some(error) = failure {
            return Err(Halt::Error(error));
        }
        if !interrupts.is_empty() {
            return Err(Halt::Interrupt(interrupts));
        }
        Ok(ToolsResult {
            message,
            end_turn,
            skipped,
        })
    }

    async fn run_batch(
        &mut self,
        run: &Run<'_>,
        view: &crate::agent::ToolAgent,
        pipeline: ToolCallPipeline,
        tool_uses: Vec<ToolUseBlock>,
        completed: IndexMap<String, ToolResultBlock>,
    ) -> Flow<crate::tools::executors::BatchOutcome> {
        let pipeline_view = view.clone();
        let pipeline_fn: ToolPipelineFn<LoopEvent> = Arc::new(move |block, sink| {
            let pipeline = pipeline.clone();
            let agent = pipeline_view.clone();
            Box::pin(async move { pipeline.execute_tool(agent, block, sink).await })
        });
        self.local
            .tracer()
            .order_tool_calls(tool_uses.iter().map(|tool_use| tool_use.tool_use_id.as_str()));
        let batch = ToolBatch {
            tool_uses,
            completed,
            cancel_signal: self.local.cancel_signal(),
        };
        let mut stream = self.tool_executor.execute(batch, pipeline_fn);
        while let Some(item) = stream.next().await {
            match item {
                ExecutorItem::Event(event) => self.emit(run, event.record, event.cancelled).await,
                ExecutorItem::Result(result) => self.fire_tool_result(run, view, result).await?,
                ExecutorItem::Done(outcome) => return Ok(outcome),
            }
        }
        Err(Halt::Error(Error::other("tool executor ended without an outcome")))
    }

    async fn fire_tool_result(
        &mut self,
        run: &Run<'_>,
        view: &crate::agent::ToolAgent,
        result: ToolResultBlock,
    ) -> Flow<()> {
        let hooks = self.local.hooks().clone();
        let mut event = ToolResultEvent::new(view.clone(), run.invocation_state.clone(), result);
        hooks.invoke(&mut event).await?;
        let record = AgentStreamEvent::from(&event);
        self.emit(run, record, false).await;
        Ok(())
    }
}

/// What the model stage's terminal needs from the agent.
struct ModelTerminal {
    tracer: Arc<Tracer>,
    /// The model state before the chain ran; each call streams with its own copy.
    model_state: StateStore,
    /// The copy of the last call that ran.
    latest_model_state: Arc<Mutex<Option<StateStore>>>,
    agent_metadata: Option<AgentMetadata>,
    cancel_signal: CancelSignal,
    invocation_context: InvocationContext,
    invoked: Arc<Mutex<Option<Arc<dyn Model>>>>,
}

/// The innermost layer of the model stage: streams the context's model with the context's
/// inputs and yields the stream updates and blocks as records.
fn model_terminal(terminal: ModelTerminal) -> TerminalFn<InvokeModelStage> {
    let terminal = Arc::new(terminal);
    Arc::new(move |context: InvokeModelContext| {
        let terminal = terminal.clone();
        *terminal.invoked.lock().unwrap_or_else(PoisonError::into_inner) = Some(context.model.clone());
        let model_state = terminal.model_state.snapshot();
        *terminal
            .latest_model_state
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(model_state.clone());
        let model_id = context.model.model_id();
        let span = terminal.tracer.start_model_invoke_span(StartModelInvokeSpanOptions {
            messages: &context.messages,
            model_id: model_id.as_deref(),
            system_prompt: context.system_prompt.as_ref(),
        });
        let request = ModelRequest {
            messages: fill_empty_assistant_messages(normalize_tool_use_names(context.messages)),
            system_prompt: context.system_prompt,
            tool_specs: context.tool_specs,
            tool_choice: context.tool_choice,
            model_state,
            dynamic_trailing_blocks: context.dynamic_trailing_blocks.filter(|count| *count > 0),
            agent_metadata: terminal.agent_metadata.clone(),
            structured_output_schema: context.structured_output_schema,
            cancel_signal: Some(terminal.cancel_signal.clone()),
        };
        let request = ModelProxy::new(context.model.clone()).prepare_request(request);
        let mut stream = context.model.stream_aggregated(request);
        StageStream::new(async_stream::stream! {
            let signal = terminal.cancel_signal.clone();
            let mut span = Some(span);
            loop {
                let item = tokio::select! {
                    biased;
                    item = stream.next() => item,
                    () = signal.cancelled() => {
                        end_model_span_with_error(span.take(), &CancelledError);
                        yield StageItem::Done(Err(MiddlewareError::Cancelled));
                        return;
                    }
                };
                match item {
                    None => {
                        let error = Error::other("model stream ended without a result");
                        end_model_span_with_error(span.take(), &error);
                        yield StageItem::Done(Err(error.into()));
                        return;
                    }
                    Some(Err(error)) => {
                        end_model_span_with_error(span.take(), &error);
                        yield StageItem::Done(Err(error.into()));
                        return;
                    }
                    Some(Ok(AggregatedEvent::ModelStreamEvent(event))) => {
                        yield StageItem::Event(AgentStreamEvent::ModelStreamUpdate(ModelStreamUpdateEventData::new(event)));
                    }
                    Some(Ok(AggregatedEvent::ContentBlock(block))) => {
                        yield StageItem::Event(AgentStreamEvent::ContentBlock(ContentBlockEventData::new(block)));
                    }
                    Some(Ok(AggregatedEvent::Done(result))) => {
                        if let Some(span) = span.take() {
                            let metadata = result.metadata.as_ref();
                            span.end(EndModelSpanOptions {
                                usage: metadata.and_then(|metadata| metadata.usage.as_ref()),
                                metrics: metadata.and_then(|metadata| metadata.metrics.as_ref()),
                                error: None,
                                output: Some(&result.message),
                                stop_reason: Some(result.stop_reason.as_str()),
                            });
                        }
                        ModelProxy::record(
                            result.metadata.as_ref().and_then(|metadata| metadata.usage.as_ref()),
                            &terminal.invocation_context,
                        );
                        yield StageItem::Done(Ok(InvokeModelResult::new(result)));
                        return;
                    }
                }
            }
        })
    })
}

fn end_model_span_with_error(span: Option<ModelSpan>, error: &dyn std::error::Error) {
    if let Some(span) = span {
        let message = error.to_string();
        span.end(EndModelSpanOptions {
            error: Some(&message),
            ..EndModelSpanOptions::default()
        });
    }
}

/// The error text a cycle span records for a halted cycle.
fn halt_message(halt: &Halt) -> String {
    match halt {
        Halt::Cancelled => CancelledError.to_string(),
        Halt::Interrupt(interrupts) => InterruptError::new(interrupts.clone()).to_string(),
        Halt::Error(error) => error.to_string(),
    }
}

fn is_empty_list(args: &InvokeArgs) -> bool {
    match args {
        InvokeArgs::ContentBlocks(blocks) => blocks.is_empty(),
        InvokeArgs::Messages(messages) => messages.is_empty(),
        InvokeArgs::InterruptResponses(responses) => responses.is_empty(),
        _ => false,
    }
}

/// Turns invocation input into the messages to append.
pub(crate) fn normalize_input(args: &InvokeArgs) -> Result<Vec<Message>> {
    let messages = match args {
        InvokeArgs::Text(text) => vec![Message::user(text.clone())],
        InvokeArgs::ContentBlocks(blocks) if blocks.is_empty() => Vec::new(),
        InvokeArgs::ContentBlocks(blocks) => vec![Message::new(Role::User, blocks.clone())],
        InvokeArgs::Messages(messages) => messages.clone(),
        InvokeArgs::InterruptResponses(_) => Vec::new(),
    };
    let blank = messages
        .iter()
        .any(|message| message.role == Role::User && message.content.iter().all(is_blank_text_block));
    if blank {
        return Err(Error::other(
            "Input prompt is blank. Provide non-blank text or at least one non-text content block.",
        ));
    }
    Ok(messages)
}

fn is_blank_text_block(block: &ContentBlock) -> bool {
    matches!(block, ContentBlock::Text(text) if text.text.trim_matches(is_js_whitespace).is_empty())
}

fn resolve_text_turn(
    model_result: &StreamAggregatedResult,
    structured_output_tool: Option<&StructuredOutputTool>,
    forced: bool,
    invocation_context: &InvocationContext,
) -> Flow<TextTurn> {
    let Some(tool) = structured_output_tool else {
        return Ok(TextTurn::End {
            stop_reason: model_result.stop_reason.clone(),
            structured_output: None,
        });
    };
    if forced
        && let Some(structured_output) =
            structured_output_from_forced_text(&model_result.message, tool, invocation_context)?
    {
        return Ok(TextTurn::End {
            stop_reason: model_result.stop_reason.clone(),
            structured_output: Some(structured_output),
        });
    }
    Ok(match invocation_context.reached_limit() {
        Some(limit) => TextTurn::End {
            stop_reason: limit,
            structured_output: None,
        },
        None => TextTurn::Retry,
    })
}

/// Validates the text that ended the forced retry.
fn structured_output_from_forced_text(
    message: &Message,
    tool: &StructuredOutputTool,
    invocation_context: &InvocationContext,
) -> Result<Option<JsonValue>> {
    match tool.result_from_text(message) {
        Ok(value) => Ok(Some(value)),
        Err(Error::StructuredOutput(_)) if invocation_context.has_limit(LimitKey::StructuredOutputAttempts) => {
            invocation_context.record_structured_output_failure();
            tracing::debug!("structured output retry failed | counted toward the structured output attempt limit");
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn with_structured_output(result: AgentResult, structured_output: Option<JsonValue>) -> AgentResult {
    match structured_output {
        Some(value) => result.with_structured_output(value),
        None => result,
    }
}

fn end_turn_content(end_turn: EndTurn) -> Option<Vec<ContentBlock>> {
    match end_turn {
        EndTurn::End => Some(vec![ContentBlock::text(
            "Turn ended early by hook after tool execution",
        )]),
        EndTurn::Message(text) if !text.is_empty() => Some(vec![ContentBlock::text(text)]),
        EndTurn::Content(content) if !content.is_empty() => Some(content),
        _ => None,
    }
}

pub(crate) fn tool_use_blocks(message: &Message) -> Vec<ToolUseBlock> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some(tool_use.clone()),
            _ => None,
        })
        .collect()
}

fn cancelled_results(tool_uses: &[ToolUseBlock], message: &str) -> Vec<ToolResultBlock> {
    tool_uses
        .iter()
        .map(|tool_use| ToolResultBlock::error(tool_use.tool_use_id.clone(), vec![ToolResultContent::text(message)]))
        .collect()
}

fn tool_result_message(results: Vec<ToolResultBlock>) -> Message {
    Message::new(Role::User, results.into_iter().map(ContentBlock::ToolResult).collect())
}

/// The tool use ids of a message's structured output tool calls.
fn structured_output_tool_use_ids(message: &Message) -> Vec<&str> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) if tool_use.name == STRUCTURED_OUTPUT_TOOL_NAME => {
                Some(tool_use.tool_use_id.as_str())
            }
            _ => None,
        })
        .collect()
}

/// The validated structured output of a tool turn.
fn extract_structured_output(tool_use_message: &Message, tool_result_message: &Message) -> Option<JsonValue> {
    let ids = structured_output_tool_use_ids(tool_use_message);
    let result = tool_result_message.content.iter().find_map(|block| match block {
        ContentBlock::ToolResult(result)
            if ids.contains(&result.tool_use_id.as_str())
                && result.status == crate::types::ToolResultStatus::Success =>
        {
            Some(result)
        }
        _ => None,
    })?;
    match result.content.first()? {
        ToolResultContent::Json(json) => Some(json.json.clone()),
        _ => None,
    }
}

/// Replaces invalid tool-use names in assistant messages with `INVALID_TOOL_NAME`, so providers
/// that reject malformed names do not fail the request.
pub(crate) fn normalize_tool_use_names(mut messages: Vec<Message>) -> Vec<Message> {
    for message in messages.iter_mut().filter(|message| message.role == Role::Assistant) {
        for block in &mut message.content {
            let ContentBlock::ToolUse(tool_use) = block else {
                continue;
            };
            if is_valid_tool_name(&tool_use.name) {
                continue;
            }
            tracing::debug!(
                "tool_name=<{}> | replacing invalid tool name with {INVALID_TOOL_NAME_PLACEHOLDER}",
                tool_use.name
            );
            INVALID_TOOL_NAME_PLACEHOLDER.clone_into(&mut tool_use.name);
        }
    }
    messages
}

/// Gives empty assistant messages a `[blank text]` block, so providers do not drop them and send
/// two user turns in a row.
pub(crate) fn fill_empty_assistant_messages(mut messages: Vec<Message>) -> Vec<Message> {
    let mut logged = false;
    for message in &mut messages {
        if message.role != Role::Assistant || !message.content.is_empty() {
            continue;
        }
        if !logged {
            tracing::debug!("replacing empty assistant message content with blank text placeholder");
            logged = true;
        }
        message
            .content
            .push(ContentBlock::Text(TextBlock::new(BLANK_TEXT_PLACEHOLDER)));
    }
    messages
}

/// Last-message redaction, tool-use name normalization and input normalization.
#[cfg(test)]
mod tests;
