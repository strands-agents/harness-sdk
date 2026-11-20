//! The per-tool pipeline: the before-call hooks, the tool's stream, the after-call hooks and
//! retries. Runs inside a tool task.

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, PoisonError};
use tokio::time::Instant;

use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};

use super::invocation_state::InvocationState;
use super::tool_agent::{Refusal, RefusedCall, ToolAgent, ToolPipeline, no_result, not_found_result};
use crate::background_tasks::{BackgroundTasks, Route, RunFailure, RunFn, ToolRun};
use crate::error::Error;
use crate::hooks::{
    AfterToolCallEvent, AgentStreamEvent, BeforeToolCallEvent, HookRegistry, ToolStreamUpdateEvent,
    ToolStreamUpdateEventData,
};
use crate::interrupt::InterruptError;
use crate::middleware::{
    ExecuteToolContext, ExecuteToolResult, ExecuteToolStage, MiddlewareError, MiddlewareRegistry, StageItem,
    StageResult, StageStream, TerminalFn,
};
use crate::telemetry::{EndToolCallSpanOptions, InSpan, Meter, ToolSpan, Tracer};
use crate::tools::executors::{CallOutcome, EventSink, failure_result, panic_result};
use crate::tools::{InterruptFn, Tool, ToolContext, ToolOutcome, ToolStreamItem, create_error_result};
use crate::types::{ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUse, ToolUseBlock};

/// A record from a tool task, with the hook decision the printer shows.
pub(crate) struct LoopEvent {
    pub(crate) record: AgentStreamEvent,
    pub(crate) cancelled: bool,
}

impl LoopEvent {
    fn new(record: AgentStreamEvent) -> Self {
        Self {
            record,
            cancelled: false,
        }
    }
}

/// What a tool call needs from the agent while it runs on its own task.
#[derive(Clone)]
pub(crate) struct ToolCallPipeline {
    hooks: Arc<HookRegistry>,
    middleware: Arc<MiddlewareRegistry>,
    invocation_state: InvocationState,
    meter: Arc<Mutex<Meter>>,
    tracer: Arc<Tracer>,
    background: Option<(Arc<BackgroundTasks>, String)>,
}

type ToolGuard = Arc<dyn Fn(Option<&Arc<dyn Tool>>) -> crate::error::Result<()> + Send + Sync>;

/// What a background run changes in the tool stage.
#[derive(Clone, Default)]
struct StageOverrides {
    /// The result the stage returns instead of running the tool (a routing error).
    preset: Option<ToolResultBlock>,
    guard: Option<ToolGuard>,
    tool_interrupt: Option<InterruptFn>,
    middleware_interrupt: Option<InterruptFn>,
}

impl ToolCallPipeline {
    pub(crate) fn new(
        hooks: Arc<HookRegistry>,
        middleware: Arc<MiddlewareRegistry>,
        invocation_state: InvocationState,
        meter: Arc<Mutex<Meter>>,
        tracer: Arc<Tracer>,
    ) -> Self {
        Self {
            hooks,
            middleware,
            invocation_state,
            meter,
            tracer,
            background: None,
        }
    }

    /// Routes this batch's calls through `background`; `pass_id` scopes submission dedup
    /// (the assistant message's tracking id).
    pub(crate) fn with_background(mut self, background: Option<Arc<BackgroundTasks>>, pass_id: &str) -> Self {
        self.background = background.map(|background| (background, pass_id.to_owned()));
        self
    }

    /// Runs one tool use to its final result.
    pub(crate) async fn execute_tool(
        &self,
        agent: ToolAgent,
        block: ToolUseBlock,
        sink: EventSink<LoopEvent>,
    ) -> CallOutcome {
        match self.execute_gated(agent, block, sink, None).await {
            Gated::Outcome(outcome) => outcome,
            Gated::Refused(result, _) => CallOutcome::Result(result),
        }
    }

    /// [`execute_tool`](Self::execute_tool), where an interrupt a before-call hook raises is
    /// refused when `refusal` is set: the call ends with an error result carrying its text, which
    /// `AfterToolCallEvent` still sees.
    async fn execute_gated(
        &self,
        agent: ToolAgent,
        block: ToolUseBlock,
        sink: EventSink<LoopEvent>,
        mut refusal: Option<Refusal>,
    ) -> Gated {
        let registry_tool = agent.tool_registry().get(&block.name).cloned();
        let mut tool_use = ToolUse::new(block.name.clone(), block.tool_use_id.clone(), block.input.clone());
        loop {
            let mut before = BeforeToolCallEvent::new(
                agent.clone(),
                self.invocation_state.clone(),
                tool_use.clone(),
                registry_tool.clone(),
            );
            if let Err(error) = self.hooks.invoke(&mut before).await {
                return match (error, refusal.take()) {
                    (Error::Interrupt(interrupts), Some(refusal)) => {
                        let mut refused_use = before.tool_use().clone();
                        refused_use.tool_use_id.clone_from(&block.tool_use_id);
                        self.refuse(&agent, refused_use, registry_tool, interrupts, refusal, &sink)
                            .await
                    }
                    (error, _) => Gated::Outcome(hook_failure(error)),
                };
            }
            let cancel_message = before.cancel().message_or("Tool cancelled by hook").map(str::to_owned);
            sink.send(LoopEvent {
                record: AgentStreamEvent::from(&before),
                cancelled: cancel_message.is_some(),
            })
            .await;
            tool_use = before.tool_use().clone();
            tool_use.tool_use_id.clone_from(&block.tool_use_id);
            let effective_tool = match before.take_selected_tool() {
                Some(tool) => Some(tool),
                None if tool_use.name != block.name => agent.tool_registry().get(&tool_use.name).cloned(),
                None => registry_tool.clone(),
            };
            let result = match cancel_message {
                Some(message) => {
                    ToolResultBlock::error(tool_use.tool_use_id.clone(), vec![ToolResultContent::text(message)])
                }
                None => {
                    let mut overrides = StageOverrides::default();
                    match self.route(&agent, &mut tool_use, registry_tool.as_ref(), effective_tool.as_ref()) {
                        Some(Ok(acknowledgement)) => {
                            return Gated::Outcome(CallOutcome::Result(normalize_tool_result_id(
                                acknowledgement,
                                &block.tool_use_id,
                            )));
                        }
                        Some(Err(preset)) => overrides.preset = Some(preset),
                        None => {}
                    }
                    match self
                        .execute_tool_stage(&agent, effective_tool.as_ref(), &tool_use, &sink, overrides)
                        .await
                    {
                        CallOutcome::Result(result) => result,
                        other => return Gated::Outcome(other),
                    }
                }
            };
            let result = normalize_tool_result_id(result, &tool_use.tool_use_id);
            let mut after = AfterToolCallEvent::new(
                agent.clone(),
                self.invocation_state.clone(),
                tool_use.clone(),
                effective_tool,
                result,
            );
            if let Err(error) = self.hooks.invoke(&mut after).await {
                return Gated::Outcome(hook_failure(error));
            }
            sink.send(LoopEvent::new(AgentStreamEvent::from(&after))).await;
            if after.retry() && !agent.cancel_signal().is_cancelled() {
                continue;
            }
            return Gated::Outcome(CallOutcome::Result(normalize_tool_result_id(
                after.into_result(),
                &block.tool_use_id,
            )));
        }
    }

    /// Ends a call whose before-call hooks raised `interrupts` with the refusal's error result,
    /// through `AfterToolCallEvent` (never retried).
    async fn refuse(
        &self,
        agent: &ToolAgent,
        tool_use: ToolUse,
        tool: Option<Arc<dyn Tool>>,
        interrupts: InterruptError,
        refusal: Refusal,
        sink: &EventSink<LoopEvent>,
    ) -> Gated {
        let tool_use_id = tool_use.tool_use_id.clone();
        let refused = ToolResultBlock::error(tool_use_id.clone(), vec![ToolResultContent::text(refusal(&interrupts))]);
        let mut after = AfterToolCallEvent::new(agent.clone(), self.invocation_state.clone(), tool_use, tool, refused);
        if let Err(error) = self.hooks.invoke(&mut after).await {
            return Gated::Outcome(hook_failure(error));
        }
        sink.send(LoopEvent::new(AgentStreamEvent::from(&after))).await;
        Gated::Refused(normalize_tool_result_id(after.into_result(), &tool_use_id), interrupts)
    }

    /// Applies the background policy to a call: `Ok` is the dispatch acknowledgement of a
    /// detached call (no `AfterToolCallEvent` fires for it; the background run fires its own),
    /// `Err` a routing error the stage returns in place of the tool's result, `None` a foreground
    /// call.
    fn route(
        &self,
        agent: &ToolAgent,
        tool_use: &mut ToolUse,
        requested: Option<&Arc<dyn Tool>>,
        effective: Option<&Arc<dyn Tool>>,
    ) -> Option<std::result::Result<ToolResultBlock, ToolResultBlock>> {
        let (background, pass_id) = self.background.as_ref()?;
        match background.route_tool_call(tool_use, requested, effective) {
            Route::Foreground => None,
            Route::Error(result) => Some(Err(result)),
            Route::Background => {
                let tool = effective?.clone();
                let run = self.background_runner(agent.clone(), background.clone());
                Some(Ok(background.submit_tool_call(
                    tool_use.clone(),
                    self.invocation_state.clone(),
                    pass_id,
                    tool,
                    &agent.cancel_signal(),
                    run,
                )))
            }
        }
    }

    /// The function a background task runs its tool call with: the tool
    /// stage and `AfterToolCallEvent`, retried as hooks ask, with the task's own cancel signal
    /// and interrupts. Its events reach hooks but not the agent's stream.
    fn background_runner(&self, agent: ToolAgent, background: Arc<BackgroundTasks>) -> RunFn {
        let pipeline = self.clone();
        Arc::new(move |run: ToolRun| {
            let pipeline = pipeline.clone();
            let agent = agent.clone().with_cancel_signal(run.cancel_signal.clone());
            let guard_tasks = background.clone();
            Box::pin(async move {
                let overrides = StageOverrides {
                    guard: Some(Arc::new(move |tool| guard_tasks.assert_tool_can_run(tool))),
                    tool_interrupt: Some(run.tool_interrupt),
                    middleware_interrupt: Some(run.middleware_interrupt),
                    preset: None,
                };
                let pipeline = ToolCallPipeline {
                    invocation_state: run.invocation_state,
                    tracer: Arc::new(pipeline.tracer.detached()),
                    ..pipeline
                };
                pipeline.run_background(agent, run.tool, run.tool_use, overrides).await
            })
        })
    }

    async fn run_background(
        &self,
        agent: ToolAgent,
        tool: Arc<dyn Tool>,
        tool_use: ToolUse,
        overrides: StageOverrides,
    ) -> std::result::Result<ToolResultBlock, RunFailure> {
        let sink = EventSink::discard();
        loop {
            let result = match self
                .run_tool_stage(&agent, Some(&tool), &tool_use, &sink, overrides.clone())
                .await
                .map_err(MiddlewareError::Error)
                .and_then(|outcome| outcome)
            {
                Ok(result) => result,
                Err(MiddlewareError::Interrupt(interrupts)) => {
                    return Err(RunFailure::Interrupts(interrupts.into_interrupts()));
                }
                Err(MiddlewareError::Error(error)) => return Err(RunFailure::Error(error)),
                Err(MiddlewareError::Cancelled) => ToolResultBlock::error(
                    tool_use.tool_use_id.clone(),
                    vec![ToolResultContent::text("Tool execution cancelled")],
                ),
            };
            let result = normalize_tool_result_id(result, &tool_use.tool_use_id);
            let mut after = AfterToolCallEvent::new(
                agent.clone(),
                self.invocation_state.clone(),
                tool_use.clone(),
                Some(tool.clone()),
                result,
            );
            if let Err(error) = self.hooks.invoke(&mut after).await {
                return Err(RunFailure::Error(error));
            }
            if after.retry() && !agent.cancel_signal().is_cancelled() {
                continue;
            }
            return Ok(normalize_tool_result_id(after.into_result(), &tool_use.tool_use_id));
        }
    }

    /// Runs the selected tool through the `ExecuteToolStage` chain.
    async fn execute_tool_stage(
        &self,
        agent: &ToolAgent,
        tool: Option<&Arc<dyn Tool>>,
        tool_use: &ToolUse,
        sink: &EventSink<LoopEvent>,
        overrides: StageOverrides,
    ) -> CallOutcome {
        match self.run_tool_stage(agent, tool, tool_use, sink, overrides).await {
            Ok(outcome) => stage_outcome(outcome, &tool_use.tool_use_id),
            Err(error) => hook_failure(error),
        }
    }

    /// The stage chain, firing the stream-update hooks on the events that come out of it. The
    /// outer error is a hook failure, which fails the invocation; the stage's own outcome is
    /// inside.
    async fn run_tool_stage(
        &self,
        agent: &ToolAgent,
        tool: Option<&Arc<dyn Tool>>,
        tool_use: &ToolUse,
        sink: &EventSink<LoopEvent>,
        overrides: StageOverrides,
    ) -> crate::error::Result<StageResult<ToolResultBlock>> {
        let mut context = ExecuteToolContext::new(
            agent.clone(),
            tool.cloned(),
            tool_use.clone(),
            self.invocation_state.clone(),
            agent.cancel_signal(),
        );
        if let Some(interrupt) = overrides.middleware_interrupt.clone() {
            context = context.with_interrupt(interrupt);
        }
        let pipeline = self.clone();
        let terminal: TerminalFn<ExecuteToolStage> = Arc::new(move |context: ExecuteToolContext| {
            if let Some(guard) = &overrides.guard
                && let Err(error) = guard(context.tool.as_ref())
            {
                return StageStream::from_result(Err(error.into()));
            }
            if let Some(preset) = overrides.preset.clone() {
                return StageStream::from_result(Ok(ExecuteToolResult::new(preset)));
            }
            pipeline.execute_tool_core(context, overrides.tool_interrupt.clone())
        });
        let mut stream = self.middleware.invoke::<ExecuteToolStage>(context, terminal);
        while let Some(item) = stream.next().await {
            match item {
                StageItem::Event(AgentStreamEvent::ToolStreamUpdate(data)) => {
                    let mut update =
                        ToolStreamUpdateEvent::new(agent.clone(), self.invocation_state.clone(), data.event);
                    self.hooks.invoke(&mut update).await?;
                    sink.send(LoopEvent::new(AgentStreamEvent::from(&update))).await;
                }
                StageItem::Event(record) => sink.send(LoopEvent::new(record)).await,
                StageItem::Done(outcome) => return Ok(outcome.map(|result| result.result)),
            }
        }
        Ok(Err(MiddlewareError::Error(Error::other(
            "middleware stream ended without a result",
        ))))
    }

    /// The innermost layer of the tool stage: runs the tool and records its duration.
    fn execute_tool_core(
        &self,
        context: ExecuteToolContext,
        tool_interrupt: Option<InterruptFn>,
    ) -> StageStream<ExecuteToolStage> {
        let meter = self.meter.clone();
        let tracer = self.tracer.clone();
        let invocation_state = context.invocation_state.clone();
        StageStream::new(async_stream::stream! {
            let tool_use = context.tool_use;
            let mut metric = ToolCallMetric::start(meter, &tracer, &tool_use);
            let mut outcome = None;
            match &context.tool {
                None => outcome = Some(Ok(ExecuteToolResult::new(not_found_result(&tool_use)))),
                Some(tool) => {
                    let agent = context.agent.for_tool_call(&tool_use.tool_use_id);
                    let mut tool_context = ToolContext::new(tool_use.clone(), agent.clone(), invocation_state);
                    if let Some(interrupt) = tool_interrupt {
                        tool_context = tool_context.with_interrupt(interrupt);
                    }
                    let span = metric.span.as_ref().map_or_else(tracing::Span::none, ToolSpan::span);
                    match span.in_scope(|| std::panic::catch_unwind(AssertUnwindSafe(|| tool.stream(tool_context)))) {
                        Err(payload) => {
                            let result = tool_panicked(&tool_use, payload.as_ref());
                            metric.error = Some(first_text(&result));
                            outcome = Some(Ok(ExecuteToolResult::new(result)));
                        }
                        Ok(stream) => {
                            let mut stream = InSpan::new(stream, span);
                            loop {
                            let item = match AssertUnwindSafe(stream.next()).catch_unwind().await {
                                Ok(Some(item)) => item,
                                Ok(None) => break,
                                Err(payload) => {
                                    let result = tool_panicked(&tool_use, payload.as_ref());
                                    metric.error = Some(first_text(&result));
                                    outcome = Some(Ok(ExecuteToolResult::new(result)));
                                    break;
                                }
                            };
                            match item {
                                ToolStreamItem::Event(event) => {
                                    yield StageItem::Event(AgentStreamEvent::ToolStreamUpdate(ToolStreamUpdateEventData::new(event)));
                                }
                                ToolStreamItem::Outcome(ToolOutcome::Result(result)) => {
                                    outcome = Some(Ok(ExecuteToolResult::new(result)));
                                    break;
                                }
                                ToolStreamItem::Outcome(ToolOutcome::Interrupt(interrupts)) => {
                                    outcome = Some(Err(MiddlewareError::from(interrupts)));
                                    break;
                                }
                            }
                            }
                        }
                    }
                    let inner = agent.take_inner_interrupts();
                    if !inner.is_empty() && !matches!(outcome, Some(Err(_))) {
                        outcome = Some(Err(MiddlewareError::from(InterruptError::new(inner))));
                    }
                }
            }
            let outcome = outcome.unwrap_or_else(|| Ok(ExecuteToolResult::new(no_result(&tool_use))));
            metric.success = matches!(&outcome, Ok(result) if result.result.status == ToolResultStatus::Success);
            if let Ok(result) = &outcome {
                if metric.error.is_none() {
                    metric.error = result.result.error.as_ref().map(ToString::to_string);
                }
                metric.end_span(Some(&result.result));
            }
            drop(metric);
            yield StageItem::Done(outcome);
        })
    }
}

/// Ends the tool span and records the call in the meter when dropped, so a call whose stream a
/// Wrap handler drops early still counts, as a failure.
struct ToolCallMetric {
    meter: Arc<Mutex<Meter>>,
    span: Option<ToolSpan>,
    tool_name: String,
    started: Instant,
    success: bool,
    error: Option<String>,
}

impl ToolCallMetric {
    fn start(meter: Arc<Mutex<Meter>>, tracer: &Arc<Tracer>, tool_use: &ToolUse) -> Self {
        Self {
            meter,
            span: Some(tracer.start_tool_call_span(tool_use)),
            tool_name: tool_use.name.clone(),
            started: Instant::now(),
            success: false,
            error: None,
        }
    }

    /// Ends the tool span with the raw result, borrowed, so no copy of it is made for the span.
    fn end_span(&mut self, result: Option<&ToolResultBlock>) {
        if let Some(span) = self.span.take() {
            span.end(EndToolCallSpanOptions {
                tool_result: result,
                error: self.error.as_deref(),
            });
        }
    }
}

/// The text of an error result, the message of the panic it reports.
fn first_text(result: &ToolResultBlock) -> String {
    result
        .content
        .iter()
        .find_map(|content| match content {
            ToolResultContent::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

impl Drop for ToolCallMetric {
    fn drop(&mut self) {
        self.end_span(None);
        let duration = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.meter.lock().unwrap_or_else(PoisonError::into_inner).end_tool_call(
            &self.tool_name,
            duration,
            self.success,
        );
    }
}

/// Maps the tool stage's outcome. A failure leaves the call without `AfterToolCallEvent`; the
/// executor decides what it does to the batch.
fn stage_outcome(outcome: StageResult<ToolResultBlock>, tool_use_id: &str) -> CallOutcome {
    match outcome {
        Ok(result) => CallOutcome::Result(result),
        Err(MiddlewareError::Interrupt(interrupts)) => CallOutcome::Interrupts(interrupts.into_interrupts()),
        Err(MiddlewareError::Cancelled) => CallOutcome::Result(ToolResultBlock::error(
            tool_use_id,
            vec![ToolResultContent::text("Tool execution cancelled")],
        )),
        Err(MiddlewareError::Error(error)) => CallOutcome::StageError(error),
    }
}

/// How [`ToolCallPipeline::execute_gated`] ended: with an outcome, or refused with the result
/// `AfterToolCallEvent` left and the interrupts the refusal answered.
enum Gated {
    Outcome(CallOutcome),
    Refused(ToolResultBlock, InterruptError),
}

/// An inner call's outcome as [`ToolAgent::call_tool`] returns it.
fn inner_result(outcome: CallOutcome, tool_use_id: String) -> std::result::Result<ToolResultBlock, InterruptError> {
    match outcome {
        CallOutcome::Result(result) => Ok(result),
        CallOutcome::Interrupts(interrupts) => Err(InterruptError::new(interrupts)),
        CallOutcome::Error(error) => Ok(create_error_result(error, tool_use_id)),
        CallOutcome::StageError(error) => Ok(failure_result(&tool_use_id, error)),
    }
}

impl ToolPipeline for ToolCallPipeline {
    fn call_tool(
        &self,
        agent: ToolAgent,
        tool_use: ToolUse,
    ) -> BoxFuture<'static, std::result::Result<ToolResultBlock, InterruptError>> {
        let pipeline = self.clone();
        Box::pin(async move {
            let tool_use_id = tool_use.tool_use_id.clone();
            let block = ToolUseBlock::new(tool_use.name, tool_use.tool_use_id, tool_use.input);
            inner_result(
                pipeline.execute_tool(agent, block, EventSink::discard()).await,
                tool_use_id,
            )
        })
    }

    fn call_tool_refusing(
        &self,
        agent: ToolAgent,
        tool_use: ToolUse,
        refusal: Refusal,
    ) -> BoxFuture<'static, std::result::Result<ToolResultBlock, RefusedCall>> {
        let pipeline = self.clone();
        Box::pin(async move {
            let tool_use_id = tool_use.tool_use_id.clone();
            let block = ToolUseBlock::new(tool_use.name, tool_use.tool_use_id, tool_use.input);
            match pipeline
                .execute_gated(agent, block, EventSink::discard(), Some(refusal))
                .await
            {
                Gated::Refused(result, interrupts) => Err(RefusedCall::new(interrupts, Some(result))),
                Gated::Outcome(outcome) => {
                    inner_result(outcome, tool_use_id).map_err(|interrupts| RefusedCall::new(interrupts, None))
                }
            }
        })
    }
}

/// A hook failure in a tool call: interrupts end the call for human input, any other error
/// stops the batch and fails the invocation.
fn hook_failure(error: Error) -> CallOutcome {
    match error {
        Error::Interrupt(interrupts) => CallOutcome::Interrupts(interrupts.into_interrupts()),
        error => CallOutcome::Error(error),
    }
}

/// The error result of a tool whose body panicked: the panic message.
fn tool_panicked(tool_use: &ToolUse, payload: &(dyn std::any::Any + Send)) -> ToolResultBlock {
    tracing::warn!("tool_use_id=<{}> | tool call panicked", tool_use.tool_use_id);
    panic_result(&tool_use.tool_use_id, payload)
}

/// Gives a result the model's tool use id.
pub(crate) fn normalize_tool_result_id(mut result: ToolResultBlock, tool_use_id: &str) -> ToolResultBlock {
    if result.tool_use_id != tool_use_id {
        tool_use_id.clone_into(&mut result.tool_use_id);
    }
    result
}
