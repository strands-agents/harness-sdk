//! The built-in stages and their contexts and the middleware interrupt.

use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::sync::Arc;

use indexmap::IndexMap;

use super::registry::{MiddlewareRegistry, StageRegistry};
use super::types::{Middleware, MiddlewareNext, MiddlewareStage, StageResult, StageStream, private};
use crate::agent::{InvocationContext, InvocationState, ToolAgent};
use crate::cancel::CancelSignal;
use crate::interrupt::{Interrupt, InterruptError, InterruptSource, InterruptState};
use crate::models::{Model, StreamAggregatedResult};
use crate::tools::Tool;
use crate::types::{
    InterruptParams, JsonSchema, JsonValue, Message, SystemPrompt, ToolChoice, ToolResultBlock, ToolSpec, ToolUse,
};

macro_rules! stage_constructors {
    ($stage:ident) => {
        impl $stage {
            /// An Input handler (`.Input`): transforms the context before the stage runs.
            pub fn input<F, Fut>(handler: F) -> Middleware<Self>
            where
                F: Fn(<Self as MiddlewareStage>::Context) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = StageResult<<Self as MiddlewareStage>::Context>> + Send + 'static,
            {
                Middleware::input(handler)
            }

            /// An Output handler (`.Output`): transforms the result after the stage runs.
            pub fn output<F, Fut>(handler: F) -> Middleware<Self>
            where
                F: Fn(<Self as MiddlewareStage>::Result) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = StageResult<<Self as MiddlewareStage>::Result>> + Send + 'static,
            {
                Middleware::output(handler)
            }

            /// A Wrap handler (the bare stage or `.Wrap`): gets the context and `next`.
            pub fn wrap<F>(handler: F) -> Middleware<Self>
            where
                F: Fn(<Self as MiddlewareStage>::Context, MiddlewareNext<Self>) -> StageStream<Self>
                    + Send
                    + Sync
                    + 'static,
            {
                Middleware::wrap(handler)
            }
        }
    };
}

/// The model call (`InvokeModelStage`): rate-limit, cache, route or transform model inputs.
///
/// Hooks fire outside the chain: `BeforeModelCallEvent` before it, `AfterModelCallEvent` after,
/// once per call even when a handler short-circuits or retries. Model state is not on the
/// context; the agent commits the provider's writes after the whole chain succeeds.
///
/// ```
/// use strands::Agent;
/// use strands::middleware::InvokeModelStage;
/// use strands::testing::MockModel;
///
/// # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
/// let model = MockModel::new().with_turn("Hello");
/// let mut agent = Agent::builder().model(model.clone()).printer(false).build()?;
/// agent.add_middleware(InvokeModelStage::input(|mut context| async move {
///     context.system_prompt = Some("Answer in French.".into());
///     Ok(context)
/// }));
/// agent.invoke("Hi").await?;
/// assert_eq!(model.requests()[0].system_prompt, Some("Answer in French.".into()));
/// # Ok::<(), strands::Error>(())
/// # }).unwrap();
/// ```
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct InvokeModelStage;

impl private::Sealed for InvokeModelStage {
    fn slot(registry: &MiddlewareRegistry) -> &StageRegistry<Self> {
        registry.invoke_model()
    }
}

impl MiddlewareStage for InvokeModelStage {
    type Context = InvokeModelContext;
    type Result = InvokeModelResult;
    const NAME: &'static str = "invokeModel";
}

stage_constructors!(InvokeModelStage);

/// One tool execution (`ExecuteToolStage`): add telemetry, validate inputs, mock or cache results.
///
/// Runs on the tool's task, inside `BeforeToolCallEvent` and `AfterToolCallEvent`.
///
/// ```
/// use serde_json::json;
/// use strands::middleware::{ExecuteToolResult, ExecuteToolStage, StageStream};
/// use strands::types::{ToolResultBlock, ToolResultContent};
///
/// let mock = ExecuteToolStage::wrap(|context, next| {
///     if context.tool_use.name != "weather" {
///         return next.call(context);
///     }
///     let result = ToolResultBlock::success(context.tool_use.tool_use_id, vec![ToolResultContent::text("sunny")]);
///     StageStream::from_result(Ok(ExecuteToolResult::new(result)))
/// });
/// # let _ = (mock, json!(null));
/// ```
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct ExecuteToolStage;

impl private::Sealed for ExecuteToolStage {
    fn slot(registry: &MiddlewareRegistry) -> &StageRegistry<Self> {
        registry.execute_tool()
    }
}

impl MiddlewareStage for ExecuteToolStage {
    type Context = ExecuteToolContext;
    type Result = ExecuteToolResult;
    const NAME: &'static str = "executeTool";
}

stage_constructors!(ExecuteToolStage);

/// What model-stage handlers receive (`InvokeModelContext`). Collections are copies of the
/// agent's; `invocation_state` is shared with hooks, tools and the result.
#[derive(Clone)]
#[non_exhaustive]
pub struct InvokeModelContext {
    /// The agent, as tools see it (an escape hatch).
    pub agent: ToolAgent,
    /// The model this call invokes; initialized from the agent's and replaceable per call.
    pub model: Arc<dyn Model>,
    /// The messages to send.
    pub messages: Vec<Message>,
    /// The system prompt.
    pub system_prompt: Option<SystemPrompt>,
    /// The tool specs the model may use.
    pub tool_specs: Vec<ToolSpec>,
    /// How the model selects tools.
    pub tool_choice: Option<ToolChoice>,
    /// Per-invocation state, shared.
    pub invocation_state: InvocationState,
    /// The estimated input tokens of this call, when estimation succeeded.
    pub projected_input_tokens: Option<u64>,
    /// How many trailing blocks of the last user message are rebuilt on every call; producers
    /// add to it.
    pub dynamic_trailing_blocks: Option<usize>,
    /// The schema this call must produce, set on the structured output retry.
    pub structured_output_schema: Option<JsonSchema>,
    /// Names of the tools this call defers, set by deferred tool loading and passed to the
    /// provider in [`ModelRequest::deferred_tools`](crate::models::ModelRequest::deferred_tools).
    pub deferred_tools: HashSet<String>,
    /// The request this call belongs to.
    pub invocation_context: Option<InvocationContext>,
}

impl fmt::Debug for InvokeModelContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InvokeModelContext")
            .field("model", &self.model.model_id())
            .field("messages", &self.messages.len())
            .field("tool_specs", &self.tool_specs.len())
            .field("tool_choice", &self.tool_choice)
            .finish_non_exhaustive()
    }
}

/// What the model stage produces (`InvokeModelResult`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct InvokeModelResult {
    /// The aggregated model response.
    pub result: StreamAggregatedResult,
}

impl InvokeModelResult {
    /// Wraps an aggregated model response.
    #[must_use]
    pub fn new(result: StreamAggregatedResult) -> Self {
        Self { result }
    }
}

type InterruptFn = Arc<dyn Fn(&InterruptParams) -> Result<JsonValue, InterruptError> + Send + Sync>;

/// What tool-stage handlers receive (`ExecuteToolContext`). `tool_use` is a copy of the model's
/// request; `invocation_state` is shared.
#[derive(Clone)]
#[non_exhaustive]
pub struct ExecuteToolContext {
    /// The agent, as tools see it (an escape hatch).
    pub agent: ToolAgent,
    /// The tool that runs, or `None` when the name is not registered.
    pub tool: Option<Arc<dyn Tool>>,
    /// The tool use request.
    pub tool_use: ToolUse,
    /// Per-invocation state, shared.
    pub invocation_state: InvocationState,
    cancel_signal: CancelSignal,
    interrupt: InterruptFn,
}

impl ExecuteToolContext {
    pub(crate) fn new(
        agent: ToolAgent,
        tool: Option<Arc<dyn Tool>>,
        tool_use: ToolUse,
        invocation_state: InvocationState,
        cancel_signal: CancelSignal,
    ) -> Self {
        let interrupt = middleware_interrupt(
            agent.interrupt_state().clone(),
            format!("middleware:executeTool:{}", tool_use.tool_use_id),
            None,
        );
        Self {
            agent,
            tool,
            tool_use,
            invocation_state,
            cancel_signal,
            interrupt,
        }
    }

    pub(crate) fn with_interrupt(mut self, interrupt: InterruptFn) -> Self {
        self.interrupt = interrupt;
        self
    }

    /// The executor's cancellation signal for this call; observe it, it cannot be replaced.
    #[must_use]
    pub fn cancel_signal(&self) -> &CancelSignal {
        &self.cancel_signal
    }

    /// Requests a human-in-the-loop interrupt (`interrupt`).
    ///
    /// Returns the response on resume (or the preemptive `params.response`); otherwise the
    /// interrupt, which `?` turns into [`MiddlewareError::Interrupt`](super::MiddlewareError) so
    /// the agent stops with `StopReason::Interrupt` and the tool does not run. The id is
    /// `middleware:executeTool:<toolUseId>:<name>`.
    ///
    /// # Errors
    ///
    /// The unanswered interrupt.
    pub fn interrupt(&self, params: impl Into<InterruptParams>) -> Result<MiddlewareInterruptResult, InterruptError> {
        (self.interrupt)(&params.into()).map(MiddlewareInterruptResult::new)
    }
}

impl fmt::Debug for ExecuteToolContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecuteToolContext")
            .field("tool_use", &self.tool_use)
            .field("tool", &self.tool.as_ref().map(|tool| tool.name().to_owned()))
            .finish_non_exhaustive()
    }
}

/// What the tool stage produces (`ExecuteToolResult`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ExecuteToolResult {
    /// The tool result.
    pub result: ToolResultBlock,
}

impl ExecuteToolResult {
    /// Wraps a tool result.
    #[must_use]
    pub fn new(result: ToolResultBlock) -> Self {
        Self { result }
    }
}

/// What a middleware interrupt returns on resume (`MiddlewareInterruptResult`); an object so it
/// can grow without breaking callers.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct MiddlewareInterruptResult {
    /// The response the caller gave.
    pub response: JsonValue,
}

impl MiddlewareInterruptResult {
    /// Wraps a response.
    #[must_use]
    pub fn new(response: JsonValue) -> Self {
        Self { response }
    }
}

/// A non-mutating interrupt backed by `state`: prior responses are
/// read from `prior` (a snapshot) or the live state, and a new interrupt stays local until the
/// agent stops for it.
pub(crate) fn middleware_interrupt(
    state: InterruptState,
    prefix: String,
    prior: Option<IndexMap<String, Interrupt>>,
) -> InterruptFn {
    Arc::new(move |params: &InterruptParams| {
        let id = format!("{prefix}:{}", params.name);
        let existing = match &prior {
            Some(prior) => prior.get(&id).and_then(|interrupt| interrupt.response.clone()),
            None => state.response(&id),
        };
        if let Some(response) = existing.or_else(|| params.response.clone()) {
            return Ok(response);
        }
        let mut interrupt = Interrupt::new(id, params.name.clone()).with_source(InterruptSource::Middleware);
        interrupt.reason.clone_from(&params.reason);
        Err(interrupt.into())
    })
}
