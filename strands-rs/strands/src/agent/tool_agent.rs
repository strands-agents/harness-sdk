//! The agent view that per-tool hook events and tools see.

use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;

use super::invocation_context::InvocationContext;
use super::invocation_state::InvocationState;
use crate::cancel::{CancelHandle, CancelOptions, CancelSignal};
use crate::experimental::context_manager::ContextManager;
use crate::interrupt::{Interrupt, InterruptError, InterruptSource, InterruptState};
use crate::interventions::InterventionHandler;
use crate::models::Model;
use crate::sandbox::{Sandbox, default_sandbox};
use crate::state_store::StateStore;
use crate::telemetry::Tracer;
use crate::tools::{Tool, ToolContext, ToolOutcome, ToolRegistry};
use crate::types::{InterruptParams, JsonValue, Message, ToolResultBlock, ToolResultContent, ToolUse};

/// Runs a tool call through the agent's full per-tool pipeline (hooks, interventions,
/// middleware). The agent loop supplies it; a [`ToolAgent`] without one runs the tool directly.
pub(crate) trait ToolPipeline: Send + Sync {
    /// Runs `tool_use` for `agent` and returns the final result, or the interrupts that stopped
    /// it.
    fn call_tool(
        &self,
        agent: ToolAgent,
        tool_use: ToolUse,
    ) -> BoxFuture<'static, Result<ToolResultBlock, InterruptError>>;

    /// Runs `tool_use` like [`call_tool`](Self::call_tool), refusing an interrupt its
    /// before-call hooks raise with `refusal`'s text, which `AfterToolCallEvent` sees.
    fn call_tool_refusing(
        &self,
        agent: ToolAgent,
        tool_use: ToolUse,
        refusal: Refusal,
    ) -> BoxFuture<'static, Result<ToolResultBlock, RefusedCall>>;
}

/// The text of a refused inner call's error result, from the interrupts it raised.
pub(crate) type Refusal = Box<dyn FnOnce(&InterruptError) -> String + Send>;

/// An inner call that stopped for human input, from
/// [`ToolAgent::call_tool_without_interrupts`]. Nothing records or registers its interrupts.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{interrupts}")]
#[non_exhaustive]
pub struct RefusedCall {
    /// The unanswered interrupts.
    pub interrupts: InterruptError,
    /// When a before-call hook or intervention raised them (an approval, say): the refusal's
    /// error result as `AfterToolCallEvent` left it, which a hook may have changed. `None` when
    /// middleware or the tool itself raised them; `AfterToolCallEvent` does not fire then.
    pub result: Option<ToolResultBlock>,
}

impl RefusedCall {
    pub(crate) fn new(interrupts: InterruptError, result: Option<ToolResultBlock>) -> Self {
        Self { interrupts, result }
    }
}

/// The tool call a view runs for: [`ToolAgent::call_tool`] numbers its inner calls from it and
/// records their interrupts on it, so the outer call stops with them.
#[derive(Default)]
struct CallScope {
    tool_use_id: String,
    next_call: AtomicUsize,
    interrupts: Mutex<Vec<Interrupt>>,
}

/// What the default subagent builder passes from the parent to a child besides its tools,
/// model, sandbox and printer setting.
#[derive(Clone, Default)]
pub(crate) struct ChildInheritance {
    /// The parent's context manager, whose tools the child does not inherit.
    pub(crate) context_manager: Option<ContextManager>,
    /// The parent's intervention handlers, shared with the child.
    pub(crate) interventions: Arc<[Arc<dyn InterventionHandler>]>,
    /// The parent's tracer, whose trace attributes the child copies.
    pub(crate) tracer: Option<Arc<Tracer>>,
}

/// The view of the agent that tools and per-tool hook events get.
///
/// Tools run on their own tasks, so this view is `'static` and cheap to clone. It shares the
/// agent's app state, model state, models and cancel handle, and holds a snapshot of the messages
/// and tool registry taken when the tool batch started. History cannot be rewritten mid-batch.
#[derive(Clone)]
#[non_exhaustive]
pub struct ToolAgent {
    id: String,
    name: Option<String>,
    session_id: String,
    app_state: StateStore,
    model_state: StateStore,
    model: Arc<dyn Model>,
    aux_model: Option<Arc<dyn Model>>,
    cancel_handle: CancelHandle,
    cancel_signal: CancelSignal,
    messages: Arc<[Message]>,
    tool_registry: Arc<ToolRegistry>,
    invocation_context: Option<InvocationContext>,
    interrupt_state: InterruptState,
    pipeline: Option<Arc<dyn ToolPipeline>>,
    call_scope: Option<Arc<CallScope>>,
    sandbox: Arc<dyn Sandbox>,
    printer: bool,
    inheritance: ChildInheritance,
}

impl ToolAgent {
    /// Creates a view with the given identity and model, and empty state otherwise.
    pub(crate) fn new(id: impl Into<String>, session_id: impl Into<String>, model: Arc<dyn Model>) -> Self {
        let cancel_handle = CancelHandle::new();
        Self {
            id: id.into(),
            name: None,
            session_id: session_id.into(),
            app_state: StateStore::new(),
            model_state: StateStore::new(),
            model,
            aux_model: None,
            cancel_signal: cancel_handle.signal(),
            cancel_handle,
            messages: Arc::from(Vec::new()),
            tool_registry: Arc::new(ToolRegistry::new()),
            invocation_context: None,
            interrupt_state: InterruptState::new(),
            pipeline: None,
            call_scope: None,
            sandbox: default_sandbox().clone(),
            printer: false,
            inheritance: ChildInheritance::default(),
        }
    }

    pub(crate) fn with_name(mut self, name: Option<String>) -> Self {
        self.name = name;
        self
    }

    pub(crate) fn with_state(mut self, app_state: StateStore, model_state: StateStore) -> Self {
        self.app_state = app_state;
        self.model_state = model_state;
        self
    }

    pub(crate) fn with_aux_model(mut self, aux_model: Option<Arc<dyn Model>>) -> Self {
        self.aux_model = aux_model;
        self
    }

    pub(crate) fn with_cancel_handle(mut self, cancel_handle: CancelHandle) -> Self {
        self.cancel_signal = cancel_handle.signal();
        self.cancel_handle = cancel_handle;
        self
    }

    pub(crate) fn with_cancel_signal(mut self, cancel_signal: CancelSignal) -> Self {
        self.cancel_signal = cancel_signal;
        self
    }

    pub(crate) fn with_messages(mut self, messages: Arc<[Message]>) -> Self {
        self.messages = messages;
        self
    }

    pub(crate) fn with_tool_registry(mut self, tool_registry: Arc<ToolRegistry>) -> Self {
        self.tool_registry = tool_registry;
        self
    }

    pub(crate) fn with_invocation_context(mut self, invocation_context: Option<InvocationContext>) -> Self {
        self.invocation_context = invocation_context;
        self
    }

    pub(crate) fn with_interrupt_state(mut self, interrupt_state: InterruptState) -> Self {
        self.interrupt_state = interrupt_state;
        self
    }

    pub(crate) fn with_pipeline(mut self, pipeline: Arc<dyn ToolPipeline>) -> Self {
        self.pipeline = Some(pipeline);
        self
    }

    /// The view a tool with the id `tool_use_id` runs with: its inner calls get ids derived from
    /// that id.
    pub(crate) fn for_tool_call(&self, tool_use_id: &str) -> Self {
        let mut view = self.clone();
        view.call_scope = Some(Arc::new(CallScope {
            tool_use_id: tool_use_id.to_owned(),
            ..CallScope::default()
        }));
        view
    }

    /// The interrupts inner calls raised during this view's tool call, removed from it.
    pub(crate) fn take_inner_interrupts(&self) -> Vec<Interrupt> {
        let Some(scope) = &self.call_scope else {
            return Vec::new();
        };
        std::mem::take(&mut *scope.interrupts.lock().unwrap_or_else(PoisonError::into_inner))
    }

    fn record_inner_interrupts(&self, error: &InterruptError) {
        let Some(scope) = &self.call_scope else {
            return;
        };
        let mut recorded = scope.interrupts.lock().unwrap_or_else(PoisonError::into_inner);
        for interrupt in &error.interrupts {
            if !recorded.iter().any(|known| known.id == interrupt.id) {
                recorded.push(interrupt.clone());
            }
        }
    }

    /// `<toolUseId>:call:<n>` inside a tool call, numbered in call order, so a resumed tool's
    /// calls get the ids (and the interrupt responses) of the first run; `tooluse_<uuid>`
    /// elsewhere.
    fn next_call_id(&self) -> String {
        match &self.call_scope {
            Some(scope) => {
                let n = scope.next_call.fetch_add(1, Ordering::SeqCst);
                format!("{}:call:{n}", scope.tool_use_id)
            }
            None => format!("tooluse_{}", uuid::Uuid::new_v4()),
        }
    }

    pub(crate) fn with_sandbox(mut self, sandbox: Arc<dyn Sandbox>) -> Self {
        self.sandbox = sandbox;
        self
    }

    pub(crate) fn with_printer(mut self, printer: bool) -> Self {
        self.printer = printer;
        self
    }

    pub(crate) fn with_inheritance(mut self, inheritance: ChildInheritance) -> Self {
        self.inheritance = inheritance;
        self
    }

    /// What children of the default subagent builder inherit.
    pub(crate) fn inheritance(&self) -> &ChildInheritance {
        &self.inheritance
    }

    /// Whether the agent prints to stdout; children of the default subagent builder inherit it.
    pub(crate) fn printer(&self) -> bool {
        self.printer
    }

    pub(crate) fn interrupt_state(&self) -> &InterruptState {
        &self.interrupt_state
    }

    /// The agent's unique id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The agent's name.
    #[must_use]
    pub fn name(&self) -> &str {
        self.name.as_deref().unwrap_or(super::agent::DEFAULT_AGENT_NAME)
    }

    /// The id of the current conversation session.
    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The agent's app state, shared with the agent.
    #[must_use]
    pub fn app_state(&self) -> &StateStore {
        &self.app_state
    }

    /// The model provider's runtime state, shared with the agent.
    #[must_use]
    pub fn model_state(&self) -> &StateStore {
        &self.model_state
    }

    /// The agent's model.
    #[must_use]
    pub fn model(&self) -> &Arc<dyn Model> {
        &self.model
    }

    /// Where the agent's tools run commands and touch files (`sandbox`), shared with the agent.
    #[must_use]
    pub fn sandbox(&self) -> &Arc<dyn Sandbox> {
        &self.sandbox
    }

    /// The model for auxiliary side calls; the agent's model unless one was configured.
    #[must_use]
    pub fn aux_model(&self) -> &Arc<dyn Model> {
        self.aux_model.as_ref().unwrap_or(&self.model)
    }

    /// The agent's cancellation signal for the current invocation.
    #[must_use]
    pub fn cancel_signal(&self) -> CancelSignal {
        self.cancel_signal.clone()
    }

    /// Cancels the agent's current invocation (`cancel`). With
    /// [`CancelOptions::after_current_tools`] the agent stops once the running tool batch ends.
    pub fn cancel(&self, options: CancelOptions) {
        self.cancel_handle.cancel(options);
    }

    /// The conversation history when the tool batch started.
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// The agent's tools when the tool batch started.
    #[must_use]
    pub fn tool_registry(&self) -> &ToolRegistry {
        &self.tool_registry
    }

    /// The request the tool batch belongs to.
    #[must_use]
    pub fn invocation_context(&self) -> Option<&InvocationContext> {
        self.invocation_context.as_ref()
    }

    /// Calls a registered tool through the agent's full per-tool pipeline (hooks, interventions,
    /// middleware) and returns its result.
    ///
    /// Inside a tool, the call's id is `<toolUseId>:call:<n>`, numbered in call order from 0;
    /// elsewhere it is a fresh `tooluse_<uuid>`. Failures, an unknown tool name included, are
    /// error results.
    ///
    /// # Errors
    ///
    /// The [`InterruptError`] when a hook or intervention on the inner call (an approval, say)
    /// or the inner tool itself raised an interrupt. Return it with `?`: the calling tool then
    /// stops with the interrupt, and it stops with it even if it carries on. On resume the
    /// calling tool runs again from the start, its inner calls get the same ids, and the
    /// answered call proceeds.
    pub async fn call_tool(&self, name: &str, input: JsonValue) -> Result<ToolResultBlock, InterruptError> {
        let tool_use = ToolUse::new(name, self.next_call_id(), input);
        let outcome = match &self.pipeline {
            Some(pipeline) => pipeline.call_tool(self.clone(), tool_use).await,
            None => self.run_directly(tool_use).await,
        };
        outcome.inspect_err(|error| self.record_inner_interrupts(error))
    }

    /// Calls a registered tool like [`call_tool`](Self::call_tool), for a caller that cannot stop
    /// for human input, such as code orchestrating tools.
    ///
    /// An interrupt the inner call raises (from a hook, an intervention, middleware or the tool
    /// itself) is returned in the error, but it is neither recorded on the calling tool nor
    /// registered with the agent: the calling tool completes, and a resume never runs it again.
    /// When a before-call hook or intervention raised it, the call is refused with an error
    /// result whose text `refusal` gives, and `AfterToolCallEvent` fires with that result, as
    /// for a call a hook cancels. Responses saved on the agent do not answer such an interrupt;
    /// a preemptive response ([`InterruptParams::with_response`]) still does. Call ids are
    /// numbered as for [`call_tool`](Self::call_tool).
    ///
    /// ```
    /// use serde_json::json;
    /// use strands::Agent;
    /// use strands::agent::DirectToolCallOptions;
    /// use strands::tools::FunctionTool;
    /// use strands::types::{InterruptParams, ToolResultContent};
    ///
    /// # tokio::runtime::Runtime::new()?.block_on(async {
    /// let ask = FunctionTool::builder("ask", "needs a human").callback(|_, context| async move {
    ///     context.interrupt(InterruptParams::new("approve"))?;
    ///     Ok(json!("approved"))
    /// });
    /// let outer = FunctionTool::builder("outer", "calls ask").callback(|_, context| async move {
    ///     let refused = context
    ///         .agent()
    ///         .call_tool_without_interrupts("ask", json!({}), |_| "needs a human".to_owned())
    ///         .await
    ///         .is_err();
    ///     Ok(json!(format!("refused: {refused}")))
    /// });
    /// let mut agent = Agent::builder().tools([ask, outer]).printer(false).build()?;
    /// let result = agent
    ///     .tool("outer")
    ///     .invoke_with(json!({}), DirectToolCallOptions { record_direct_tool_call: Some(false) })
    ///     .await?;
    /// assert!(matches!(&result.content[..], [ToolResultContent::Text(text)] if text.text == "refused: true"));
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// # })?;
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
    ///
    /// # Errors
    ///
    /// A [`RefusedCall`] when the inner call raised an unanswered interrupt.
    pub async fn call_tool_without_interrupts(
        &self,
        name: &str,
        input: JsonValue,
        refusal: impl FnOnce(&InterruptError) -> String + Send + 'static,
    ) -> Result<ToolResultBlock, RefusedCall> {
        let tool_use = ToolUse::new(name, self.next_call_id(), input);
        let mut detached = self.clone();
        detached.interrupt_state = InterruptState::new();
        match &self.pipeline {
            Some(pipeline) => pipeline.call_tool_refusing(detached, tool_use, Box::new(refusal)).await,
            None => detached
                .run_directly(tool_use)
                .await
                .map_err(|interrupts| RefusedCall::new(interrupts, None)),
        }
    }

    async fn run_directly(&self, tool_use: ToolUse) -> Result<ToolResultBlock, InterruptError> {
        let Some(tool) = self.tool_registry.get(&tool_use.name).cloned() else {
            return Ok(not_found_result(&tool_use));
        };
        let agent = self.for_tool_call(&tool_use.tool_use_id);
        let context = ToolContext::new(tool_use.clone(), agent.clone(), InvocationState::new());
        let outcome = run_tool(tool.as_ref(), context).await;
        let inner = agent.take_inner_interrupts();
        match outcome {
            Some(ToolOutcome::Interrupt(interrupts)) => Err(interrupts),
            _ if !inner.is_empty() => Err(InterruptError::new(inner)),
            Some(ToolOutcome::Result(result)) => Ok(result),
            None => Ok(no_result(&tool_use)),
        }
    }

    /// Raises a hook interrupt with the given id.
    pub(crate) fn raise_interrupt(&self, id: &str, params: &InterruptParams) -> Result<JsonValue, InterruptError> {
        self.interrupt_state.raise(id, params, InterruptSource::Hook)
    }
}

/// Runs a tool to its outcome, dropping progress events.
pub(crate) async fn run_tool(tool: &dyn Tool, context: ToolContext) -> Option<ToolOutcome> {
    tool.stream(context).run(|_| {}).await
}

/// The result for a tool use that names no registered tool.
pub(crate) fn not_found_result(tool_use: &ToolUse) -> ToolResultBlock {
    ToolResultBlock::error(
        tool_use.tool_use_id.clone(),
        vec![ToolResultContent::text(format!(
            "Tool '{}' not found in registry",
            tool_use.name
        ))],
    )
}

/// The result for a tool whose stream ended without an outcome.
pub(crate) fn no_result(tool_use: &ToolUse) -> ToolResultBlock {
    ToolResultBlock::error(
        tool_use.tool_use_id.clone(),
        vec![ToolResultContent::text(format!(
            "Tool '{}' did not return a result",
            tool_use.name
        ))],
    )
}

impl fmt::Debug for ToolAgent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolAgent")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("messages", &self.messages.len())
            .field("tool_registry", &self.tool_registry)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::MockTool;
    use crate::testing::MockModel;
    use crate::types::ToolResultStatus;

    struct StubPipeline;

    impl ToolPipeline for StubPipeline {
        fn call_tool(
            &self,
            agent: ToolAgent,
            tool_use: ToolUse,
        ) -> BoxFuture<'static, Result<ToolResultBlock, InterruptError>> {
            Box::pin(async move {
                Ok(ToolResultBlock::success(
                    tool_use.tool_use_id,
                    vec![ToolResultContent::text(format!("{}:{}", agent.id(), tool_use.name))],
                ))
            })
        }

        fn call_tool_refusing(
            &self,
            agent: ToolAgent,
            tool_use: ToolUse,
            _refusal: Refusal,
        ) -> BoxFuture<'static, Result<ToolResultBlock, RefusedCall>> {
            let call = self.call_tool(agent, tool_use);
            Box::pin(async move { call.await.map_err(|interrupts| RefusedCall::new(interrupts, None)) })
        }
    }

    fn agent() -> ToolAgent {
        let registry = ToolRegistry::with_tools(MockTool::new("echo").with_result(|context| {
            ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::json(context.tool_use().input.clone())],
            )
            .into()
        }))
        .unwrap();
        ToolAgent::new("agent-1", "s-1", Arc::new(MockModel::new())).with_tool_registry(Arc::new(registry))
    }

    #[tokio::test]
    async fn call_tool_runs_through_the_pipeline() {
        let result = agent()
            .with_pipeline(Arc::new(StubPipeline))
            .call_tool("echo", json!({}))
            .await
            .unwrap();
        assert!(result.tool_use_id.starts_with("tooluse_"));
        assert_eq!(result.content, vec![ToolResultContent::text("agent-1:echo")]);
    }

    #[tokio::test]
    async fn call_tool_without_a_pipeline_runs_the_registry_tool() {
        let result = agent().call_tool("echo", json!({"a": 1})).await.unwrap();
        assert_eq!(result.content, vec![ToolResultContent::json(json!({"a": 1}))]);
        let missing = agent().call_tool("missing", json!({})).await.unwrap();
        assert_eq!(missing.status, ToolResultStatus::Error);
        assert_eq!(
            missing.content,
            vec![ToolResultContent::text("Tool 'missing' not found in registry")]
        );
    }

    #[tokio::test]
    async fn call_tool_inside_a_tool_call_numbers_its_calls_by_the_outer_id() {
        let view = agent().with_pipeline(Arc::new(StubPipeline)).for_tool_call("outer");
        let first = view.call_tool("echo", json!({})).await.unwrap();
        let second = view.call_tool("echo", json!({})).await.unwrap();
        assert_eq!(
            (first.tool_use_id.as_str(), second.tool_use_id.as_str()),
            ("outer:call:0", "outer:call:1")
        );
        let rerun = agent().with_pipeline(Arc::new(StubPipeline)).for_tool_call("outer");
        assert_eq!(
            rerun.call_tool("echo", json!({})).await.unwrap().tool_use_id,
            "outer:call:0"
        );
    }

    #[tokio::test]
    async fn call_tool_returns_and_records_an_inner_interrupt() {
        let registry = ToolRegistry::with_tools(MockTool::new("ask").with_result(|context| {
            match context.interrupt(InterruptParams::new("approve")) {
                Ok(_) => ToolOutcome::Result(ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![])),
                Err(interrupt) => ToolOutcome::Interrupt(interrupt),
            }
        }))
        .unwrap();
        let view = ToolAgent::new("agent-1", "s-1", Arc::new(MockModel::new()))
            .with_tool_registry(Arc::new(registry))
            .for_tool_call("outer");
        let error = view.call_tool("ask", json!({})).await.unwrap_err();
        assert_eq!(error.interrupts[0].id, "tool:outer:call:0:approve");
        assert_eq!(view.take_inner_interrupts(), error.interrupts);
        assert!(view.take_inner_interrupts().is_empty());
    }

    fn asking_registry() -> ToolRegistry {
        ToolRegistry::with_tools(MockTool::new("ask").with_result(|context| {
            match context.interrupt(InterruptParams::new("approve")) {
                Ok(response) => ToolOutcome::Result(ToolResultBlock::success(
                    context.tool_use().tool_use_id.clone(),
                    vec![ToolResultContent::json(response)],
                )),
                Err(interrupt) => ToolOutcome::Interrupt(interrupt),
            }
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn call_tool_without_interrupts_returns_the_interrupt_without_recording_it() {
        let view = ToolAgent::new("agent-1", "s-1", Arc::new(MockModel::new()))
            .with_tool_registry(Arc::new(asking_registry()))
            .for_tool_call("outer");
        let error = view
            .call_tool_without_interrupts("ask", json!({}), |_| "refused".to_owned())
            .await
            .unwrap_err();
        assert_eq!(error.interrupts.interrupts[0].id, "tool:outer:call:0:approve");
        assert_eq!(error.result, None);
        assert!(view.take_inner_interrupts().is_empty());
        assert!(view.interrupt_state().interrupt_list().is_empty());
    }

    #[tokio::test]
    async fn call_tool_without_interrupts_ignores_saved_responses() {
        let agent = ToolAgent::new("agent-1", "s-1", Arc::new(MockModel::new()))
            .with_tool_registry(Arc::new(asking_registry()));
        assert!(agent.for_tool_call("outer").call_tool("ask", json!({})).await.is_err());
        agent
            .interrupt_state()
            .respond("tool:outer:call:0:approve", json!("yes"));
        let refused = agent
            .for_tool_call("outer")
            .call_tool_without_interrupts("ask", json!({}), |_| "refused".to_owned())
            .await;
        assert!(refused.is_err());
        let answered = agent.for_tool_call("outer").call_tool("ask", json!({})).await.unwrap();
        assert_eq!(answered.content, vec![ToolResultContent::json(json!("yes"))]);
    }

    #[test]
    fn aux_model_defaults_to_the_model() {
        let agent = agent();
        assert!(Arc::ptr_eq(agent.aux_model(), agent.model()));
        let aux: Arc<dyn Model> = Arc::new(MockModel::new());
        let agent = agent.with_aux_model(Some(aux.clone()));
        assert!(Arc::ptr_eq(agent.aux_model(), &aux));
    }

    #[test]
    fn cancel_fires_the_agent_signal() {
        let agent = agent();
        let signal = agent.cancel_signal();
        agent.cancel(CancelOptions::default());
        assert!(signal.is_cancelled());
    }
}
