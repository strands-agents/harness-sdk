//! The agent: construction, accessors and the public invocation API. The loop itself is in
//! `event_loop.rs`.

use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use futures::StreamExt;

use super::agent_delegation::{AGENT_DELEGATION_NAME, AgentDelegation};
use super::config::{AgentBuilder, AgentConfig, InvokeOptions, ModelSource};
#[cfg(not(feature = "bedrock"))]
use super::default_model::DefaultModelSlot;
use super::invocation_context::InvocationContext;
use super::invocation_state::InvocationState;
use super::invoke_args::InvokeArgs;
use super::local_agent::LocalAgent;
use super::mcp_tools::McpTools;
use super::printer::{AgentPrinter, default_appender};
use super::result::AgentResult;
use super::snapshot::TakeSnapshotOptions;
use super::stream::{AgentStream, Emitter};
use crate::background_tasks::{BackgroundTasks, BackgroundTasksPlugin};
use crate::cancel::{CancelHandle, CancelSignal};
use crate::conversation_manager::{
    ConversationManager, ConversationManagerPlugin, NullConversationManager, SlidingWindowConversationManager,
};
use crate::error::{Error, Result};
use crate::experimental::context_manager::modes::agentic::AgenticContext;
use crate::experimental::context_manager::{ContextManager, ContextManagerStrategy};
use crate::hooks::{HookCallbackOptions, HookCleanup, HookEvent, IntoAsyncHook, IntoHookImpl, IntoSyncHook};
use crate::interventions::InterventionRegistry;
use crate::memory::{MemoryManager, MemoryManagerSource};
use crate::middleware::{Middleware, MiddlewareCleanup, MiddlewareStage};
use crate::models::Model;
use crate::models::routing::{ModelRouter, ModelRouterPlugin, RouterAttachment};
use crate::plugins::{ModelPlugin, Plugin, PluginRegistry};
use crate::retry::{
    DefaultModelRetryStrategy, ModelRetryPlugin, RetryStrategy, SleeperSlot, TokioSleeper,
    warn_on_duplicate_retry_strategy_types,
};
use crate::sandbox::Sandbox;
use crate::session::SessionManager;
use crate::state_store::StateStore;
use crate::storage::Storage;
use crate::telemetry::{AgentMetrics, Tracer, with_baggage};
use crate::tools::{Tool, ToolExecutorStrategy, ToolRegistry, ToolSource};
use crate::types::{AgentMetadata, JsonSchema, JsonValue, Message, Snapshot, SystemPrompt, Toggle};

pub(crate) const DEFAULT_AGENT_NAME: &str = "Strands Agent";
const DEFAULT_AGENT_ID: &str = "agent";

/// Work left over from a stream that was dropped mid-invocation: the hooks that could not run
/// inside `Drop`. It runs at the start of the next `invoke`, `stream` or `shutdown`. Each
/// counter is the number of callbacks of its event that already ran, so every callback runs
/// once.
pub(crate) struct PendingCleanup {
    /// Messages already in history whose `MessageAddedEvent` has not finished, in order.
    pub(crate) messages: VecDeque<Message>,
    /// Callbacks that already ran for the first message.
    pub(crate) message_progress: Arc<AtomicUsize>,
    /// Callbacks that already ran for the due `AfterInvocationEvent`.
    pub(crate) after_invocation: Option<Arc<AtomicUsize>>,
    pub(crate) invocation_state: InvocationState,
    pub(crate) invocation_context: Option<InvocationContext>,
}

/// What a running invocation needs if its stream is dropped.
pub(crate) struct InFlight {
    pub(crate) invocation_state: InvocationState,
    pub(crate) invocation_context: InvocationContext,
    pub(crate) after_invocation_due: bool,
    pub(crate) structured_output_registered: bool,
}

/// Hook runs a dropped stream can cut short, kept on the agent so the next call resumes them.
#[derive(Default)]
pub(crate) struct HookProgress {
    /// Messages already in history whose `MessageAddedEvent` has not finished, in order.
    pub(crate) unfired: VecDeque<Message>,
    /// Callbacks that already ran for the first unfired message.
    pub(crate) message: Arc<AtomicUsize>,
    /// Callbacks that already ran for the current `AfterInvocationEvent`.
    pub(crate) after_invocation: Arc<AtomicUsize>,
    /// Callbacks that already ran for `InitializedEvent`.
    pub(crate) initialized: Arc<AtomicUsize>,
}

/// An agent: a model, tools and a conversation, run by the agent loop (`Agent`).
///
/// The agent is owned and its calls take `&mut self`, so invoking an agent while an invocation
/// runs is a compile error. Share one across tasks with `Arc<tokio::sync::Mutex<Agent>>`.
///
/// ```
/// use strands::Agent;
/// use strands::testing::MockModel;
///
/// # tokio_test_run(async {
/// let mut agent = Agent::builder()
///     .model(MockModel::new().with_turn("Hello!"))
///     .system_prompt("You are a concise assistant.")
///     .printer(false)
///     .build()?;
/// let result = agent.invoke("Hi").await?;
/// assert_eq!(result.to_string(), "Hello!");
/// assert_eq!(agent.messages().len(), 2);
/// # Ok::<(), strands::Error>(())
/// # });
/// # fn tokio_test_run<F: std::future::Future>(f: F) -> F::Output {
/// #     tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
/// # }
/// ```
pub struct Agent {
    pub(crate) local: LocalAgent,
    pub(crate) plugins: PluginRegistry,
    pub(crate) initialized: bool,
    pub(crate) printer: Option<AgentPrinter>,
    pub(crate) structured_output_schema: Option<JsonSchema>,
    pub(crate) tool_executor: ToolExecutorStrategy,
    pub(crate) pending_cleanup: Option<PendingCleanup>,
    pub(crate) in_flight: Option<InFlight>,
    pub(crate) hook_progress: HookProgress,
    pub(crate) deferred_continuations: Vec<super::continuation::ContinuationInput>,
    #[allow(dead_code, reason = "tests swap the sleeper retries wait on")]
    pub(crate) retry_sleeper: SleeperSlot,
    pub(crate) mcp: McpTools,
    #[allow(dead_code, reason = "tests check which manager the agent resolved")]
    pub(crate) conversation_manager: Arc<dyn ConversationManager>,
    pub(crate) background_tasks: Option<Arc<BackgroundTasks>>,
    pub(crate) model_router: Option<RouterAttachment>,
    pub(crate) session_manager: Option<SessionManager>,
    pub(crate) memory_manager: Option<MemoryManager>,
}

const STATEFUL_MANAGER_ERROR: &str = "contextManager and conversationManager cannot be used with a stateful model. The model manages conversation state server-side.";

/// The conversation manager the agent uses: none for a stateful model, the configured one, or a
/// 40-message sliding window.
fn resolve_conversation_manager(
    model: &Arc<dyn Model>,
    configured: Option<Arc<dyn ConversationManager>>,
    context_manager: Option<&ContextManagerStrategy>,
) -> Arc<dyn ConversationManager> {
    if model.stateful() {
        return Arc::new(NullConversationManager::new());
    }
    match context_manager {
        None => configured.unwrap_or_else(|| Arc::new(SlidingWindowConversationManager::default())),
        Some(ContextManagerStrategy::Disabled) => {
            configured.unwrap_or_else(|| Arc::new(NullConversationManager::new()))
        }
        Some(_) => {
            if configured.is_some() {
                tracing::warn!("contextManager is set, ignoring co-provided conversationManager");
            }
            Arc::new(NullConversationManager::new())
        }
    }
}

/// The plugins the agent registers itself, around the user's.
struct BuiltInPlugins {
    model_router: bool,
    conversation_manager: Arc<dyn ConversationManager>,
    retry_strategies: Vec<Arc<dyn Plugin>>,
    user_plugins: Vec<Arc<dyn Plugin>>,
    background_tasks: Option<Arc<BackgroundTasks>>,
    memory_manager: Option<Arc<dyn Plugin>>,
    context_manager: Option<Arc<dyn Plugin>>,
    session_manager: Option<Arc<dyn Plugin>>,
    model: Arc<dyn Model>,
}

impl BuiltInPlugins {
    /// The registration order: model router, conversation manager, retry strategies, user plugins,
    /// background tasks, delegation, memory manager, context manager, session manager, then the
    /// model plugin. The model plugin is last so its `AfterInvocationEvent` hook, which runs in
    /// reverse order, clears a stateful model's messages before a session manager saves them.
    fn in_registration_order(self) -> Vec<Arc<dyn Plugin>> {
        let mut plugins: Vec<Arc<dyn Plugin>> = Vec::new();
        if self.model_router {
            plugins.push(Arc::new(ModelRouterPlugin));
        }
        plugins.push(Arc::new(ConversationManagerPlugin::new(self.conversation_manager)));
        plugins.extend(self.retry_strategies);
        let has_delegation = self
            .user_plugins
            .iter()
            .any(|plugin| plugin.name() == AGENT_DELEGATION_NAME);
        plugins.extend(self.user_plugins);
        if let Some(background_tasks) = self.background_tasks {
            plugins.push(Arc::new(BackgroundTasksPlugin(background_tasks)));
        }
        if !has_delegation {
            plugins.push(Arc::new(AgentDelegation::new()));
        }
        plugins.extend(self.memory_manager);
        plugins.extend(self.context_manager);
        plugins.extend(self.session_manager);
        plugins.push(Arc::new(ModelPlugin::new(self.model)));
        plugins
    }
}

fn resolve_model(source: ModelSource) -> Result<Arc<dyn Model>> {
    resolve_plain_model(
        source,
        "a ModelRouter is accepted only as the agent's configured model, not by set_model",
    )
}

/// Resolves `aux_model` like `model`, rejecting a router.
fn resolve_aux_model(source: ModelSource) -> Result<Arc<dyn Model>> {
    resolve_plain_model(
        source,
        "auxModel must be a Model or a Bedrock model id, not a ModelRouter",
    )
}

/// Resolves a model where a router is not accepted, failing with `router_error` for one.
pub(crate) fn resolve_plain_model(source: ModelSource, router_error: &str) -> Result<Arc<dyn Model>> {
    match source {
        ModelSource::Model(model) => Ok(model),
        ModelSource::Router(_) => Err(Error::other(router_error.to_owned())),
        ModelSource::Id(model_id) => model_from_id(model_id),
    }
}

#[cfg(feature = "bedrock")]
fn model_from_id(model_id: String) -> Result<Arc<dyn Model>> {
    Ok(Arc::new(crate::models::BedrockModel::new(
        crate::models::BedrockModelConfig {
            model_id: Some(model_id),
            ..Default::default()
        },
    )))
}

#[cfg(feature = "bedrock")]
fn default_model() -> Arc<dyn Model> {
    crate::models::bedrock::default_bedrock_model()
}

#[cfg(not(feature = "bedrock"))]
fn default_model() -> Arc<dyn Model> {
    Arc::new(DefaultModelSlot::new(None))
}

#[cfg(not(feature = "bedrock"))]
#[allow(
    clippy::needless_pass_by_value,
    reason = "shares the signature of the bedrock variant"
)]
fn model_from_id(model_id: String) -> Result<Arc<dyn Model>> {
    Err(crate::error::DefaultNotConfiguredError::new(format!(
        "model id \"{model_id}\" is a Bedrock model id, which requires the strands feature \"bedrock\""
    ))
    .into())
}

impl Agent {
    /// Starts an agent builder; its setters are the [`AgentConfig`] keys.
    ///
    /// ```
    /// use strands::Agent;
    /// use strands::testing::MockModel;
    ///
    /// let agent = Agent::builder()
    ///     .model(MockModel::new())
    ///     .name("researcher")
    ///     .printer(false)
    ///     .build()?;
    /// assert_eq!(agent.name(), "researcher");
    /// # Ok::<(), strands::Error>(())
    /// ```
    pub fn builder() -> AgentBuilder {
        AgentConfig::builder()
    }

    /// Creates an agent from its configuration (`new Agent(config)`).
    ///
    /// Without a model the agent uses the default Bedrock model, resolved when the agent first
    /// calls it.
    ///
    /// # Errors
    ///
    /// A tool name that is invalid or registered twice, a Bedrock model id without the `bedrock`
    /// feature, or a structured output schema that does not compile when first used.
    pub fn new(mut config: AgentConfig) -> Result<Self> {
        let (model, model_router) = match config.model.take() {
            Some(ModelSource::Router(router)) => (router.default_model(), Some(router)),
            Some(source) => (resolve_model(source)?, None),
            None => (default_model(), None),
        };
        let aux_model = config.aux_model.take().map(resolve_aux_model).transpose()?;
        if let Some(source) = config.memory_manager.take() {
            config.memory_manager = Some(MemoryManagerSource::Manager(source.resolve()?));
        }
        let has_context_manager = !matches!(config.context_manager, None | Some(ContextManagerStrategy::Disabled));
        if (config.conversation_manager.is_some() || has_context_manager) && model.stateful() {
            return Err(Error::other(STATEFUL_MANAGER_ERROR));
        }
        let agentic = matches!(config.context_manager, Some(ContextManagerStrategy::Agentic));
        if let Some(manager) = ContextManager::from_strategy(config.context_manager.clone())? {
            config.context_manager = Some(ContextManagerStrategy::Instance(manager));
        }
        let background_tasks = config
            .background_tasks
            .take()
            .and_then(Toggle::into_option)
            .map(BackgroundTasks::new)
            .transpose()?
            .map(Arc::new);
        let interventions = InterventionRegistry::new(std::mem::take(&mut config.interventions))?;
        let mut parts = ToolSource::List(std::mem::take(&mut config.tools)).into_parts();
        let mut agent = Self::assemble_with(model, aux_model, config, background_tasks, model_router);
        interventions.register(agent.local.hooks());
        agent.local.set_interventions(interventions.handlers());
        agent.mcp = McpTools::take(&mut parts);
        agent.local.tool_registry_mut().add(parts.tools)?;
        if agentic {
            let context = AgenticContext::default();
            agent.local.tool_registry_mut().add(context.tools())?;
            context.register(&agent.local);
        }
        Ok(agent)
    }

    /// Builds an agent from resolved models; `config.tools` is ignored.
    pub(crate) fn assemble(model: Arc<dyn Model>, aux_model: Option<Arc<dyn Model>>, config: AgentConfig) -> Self {
        Self::assemble_with(model, aux_model, config, None, None)
    }

    fn assemble_with(
        model: Arc<dyn Model>,
        aux_model: Option<Arc<dyn Model>>,
        config: AgentConfig,
        background_tasks: Option<Arc<BackgroundTasks>>,
        model_router: Option<ModelRouter>,
    ) -> Self {
        let mut local = LocalAgent::new(config.id.unwrap_or_else(|| DEFAULT_AGENT_ID.to_owned()), model.clone());
        local.set_name(
            Some(config.name.unwrap_or_else(|| DEFAULT_AGENT_NAME.to_owned())),
            config.description,
        );
        local.set_aux_model(aux_model);
        local.set_cancel_handle(CancelHandle::for_agent());
        local.set_system_prompt(config.system_prompt);
        local.set_tracer(Tracer::new(
            config.trace_attributes.unwrap_or_default(),
            config.baggage_attributes.unwrap_or_default(),
        ));
        local.set_sandbox(config.sandbox);
        local.set_printer(config.printer.unwrap_or(true));
        local
            .tool_registry_mut()
            .set_sort_tool_specs(config.sort_tools.unwrap_or(false));
        *local.messages_mut() = config.messages;
        if let Some(app_state) = config.app_state {
            local.app_state().load_json(JsonValue::Object(app_state));
        }
        if let Some(model_state) = config.model_state {
            local.model_state().load_json(JsonValue::Object(model_state));
        }
        local.set_storage(config.storage);
        if let Some(session_manager) = &config.session_manager {
            let session_id = session_manager.session_id().to_owned();
            local.set_agent_metadata(Some(AgentMetadata::new().with_session_id(&session_id)));
            local.set_session_id(session_id);
        }

        let retry_sleeper: SleeperSlot = Arc::new(RwLock::new(Arc::new(TokioSleeper)));
        let strategies = config
            .retry_strategy
            .unwrap_or_else(|| vec![RetryStrategy::model(DefaultModelRetryStrategy::default())]);
        warn_on_duplicate_retry_strategy_types(&strategies);
        let model_router = model_router.map(|router| RouterAttachment::attach(router, &local));
        let conversation_manager =
            resolve_conversation_manager(&model, config.conversation_manager, config.context_manager.as_ref());
        let context_manager = ContextManager::from_strategy(config.context_manager).unwrap_or_else(|error| {
            tracing::warn!("error=<{error}> | context manager did not resolve, continuing without it");
            None
        });
        local.set_context_manager(context_manager.clone());
        let memory_manager = config.memory_manager.and_then(MemoryManagerSource::into_manager);
        let plugins = BuiltInPlugins {
            model_router: model_router.is_some(),
            conversation_manager: conversation_manager.clone(),
            retry_strategies: strategies
                .into_iter()
                .map(|strategy| Arc::new(ModelRetryPlugin::new(strategy, retry_sleeper.clone())) as Arc<dyn Plugin>)
                .collect(),
            user_plugins: config.plugins,
            background_tasks: background_tasks.clone(),
            memory_manager: memory_manager
                .clone()
                .map(|manager| Arc::new(manager) as Arc<dyn Plugin>),
            context_manager: context_manager.map(|manager| Arc::new(manager) as Arc<dyn Plugin>),
            session_manager: config
                .session_manager
                .clone()
                .map(|session_manager| Arc::new(session_manager) as Arc<dyn Plugin>),
            model,
        }
        .in_registration_order();

        let printer = config
            .printer
            .unwrap_or(true)
            .then(|| AgentPrinter::new(default_appender()));
        Self {
            local,
            plugins: PluginRegistry::new(plugins),
            initialized: false,
            printer,
            structured_output_schema: config.structured_output_schema,
            tool_executor: config.tool_executor.unwrap_or_default(),
            pending_cleanup: None,
            in_flight: None,
            hook_progress: HookProgress::default(),
            deferred_continuations: Vec::new(),
            retry_sleeper,
            conversation_manager,
            background_tasks,
            memory_manager,
            mcp: McpTools::default(),
            model_router,
            session_manager: config.session_manager,
        }
    }

    /// Invokes the agent and returns the final result (`invoke`); it drains
    /// [`stream`](Self::stream).
    ///
    /// # Errors
    ///
    /// A model error that no retry resolved, a structured output failure, a hook error, a bad
    /// resume input, or an invalid limit. An agent stopped for interrupts accepts only the
    /// responses: invoke it with a `Vec<InterruptResponse>`.
    pub async fn invoke(&mut self, args: impl Into<InvokeArgs>) -> Result<AgentResult> {
        self.invoke_with(args, InvokeOptions::default()).await
    }

    /// Invokes the agent with per-invocation options.
    ///
    /// # Errors
    ///
    /// The same as [`invoke`](Self::invoke).
    pub async fn invoke_with(&mut self, args: impl Into<InvokeArgs>, options: InvokeOptions) -> Result<AgentResult> {
        let mut stream = self.stream_with(args, options);
        while let Some(item) = stream.next().await {
            item?;
        }
        stream
            .take_result()
            .ok_or_else(|| Error::other("agent stream ended without a result"))
    }

    /// Streams the invocation (`stream`): the loop runs as the stream is polled and yields the
    /// event records, ending with [`AgentStreamEvent::AgentResult`](crate::AgentStreamEvent).
    ///
    /// History is always re-invokable: an assistant message with tool uses is appended only after
    /// its tools finish. Dropping the stream early cancels the invocation.
    pub fn stream(&mut self, args: impl Into<InvokeArgs>) -> AgentStream<'_> {
        self.stream_with(args, InvokeOptions::default())
    }

    /// Streams the invocation with per-invocation options.
    pub fn stream_with(&mut self, args: impl Into<InvokeArgs>, options: InvokeOptions) -> AgentStream<'_> {
        let emitter = Emitter::default();
        let args = args.into();
        let loop_emitter = emitter.clone();
        let baggage = self.local.tracer().baggage_attributes().clone();
        AgentStream::new(
            &emitter,
            with_baggage(self.run_invocation(args, options, loop_emitter), baggage),
        )
    }

    /// Initializes the agent's plugins and fires `InitializedEvent` (`initialize`). The first
    /// invocation calls it; calling it again does nothing. When a dropped stream cuts it short,
    /// the next call continues where it stopped: with the plugin it interrupted, and with the
    /// `InitializedEvent` callbacks that have not run. When an `InitializedEvent` callback fails,
    /// the next call fires every callback again.
    ///
    /// # Errors
    ///
    /// A plugin that failed to initialize (later calls fail with the same message), or an
    /// `InitializedEvent` hook error.
    pub async fn initialize(&mut self) -> Result<()> {
        if self.initialized {
            return Ok(());
        }
        self.mcp.initialize(self.local.tool_registry_mut()).await?;
        self.register_sandbox_tools()?;
        self.plugins.initialize(&mut self.local).await?;
        let hooks = self.local.hooks().clone();
        let progress = self.hook_progress.initialized.clone();
        let mut event = crate::hooks::InitializedEvent::new(&mut self.local);
        let invoked = hooks.invoke_tracked(&mut event, &progress).await;
        if invoked.is_err() {
            progress.store(0, Ordering::SeqCst);
        }
        invoked?;
        self.initialized = true;
        self.local.set_background_tasks(self.background_tasks.clone());
        Ok(())
    }

    /// Registers the tools a configured sandbox vends; the host default vends none. A tool whose
    /// name the user already registered is skipped.
    fn register_sandbox_tools(&mut self) -> Result<()> {
        let Some(sandbox) = self.local.configured_sandbox() else {
            return Ok(());
        };
        let tools = sandbox.get_tools();
        let registry = self.local.tool_registry_mut();
        for tool in tools {
            if registry.get(tool.name()).is_some() {
                tracing::debug!(
                    "tool_name=<{}> | sandbox-vended tool skipped, user already registered a tool with this name",
                    tool.name()
                );
                continue;
            }
            registry.add(tool)?;
        }
        Ok(())
    }

    /// Runs the agent's shutdown procedures (`shutdown`): the cleanup a dropped stream left
    /// pending, then cancels the background tasks that have not finished (dropping the agent
    /// cancels them too) and flushes the memory manager. Safe to call
    /// more than once.
    ///
    /// # Errors
    ///
    /// None today; cleanup hook errors are logged. The memory manager's
    /// [`flush`](MemoryManager::flush) logs its store failures.
    pub async fn shutdown(&mut self) -> Result<()> {
        self.run_pending_cleanup().await;
        if let Some(background_tasks) = &self.background_tasks {
            background_tasks.shutdown();
        }
        if let Some(memory_manager) = &self.memory_manager {
            memory_manager.flush().await;
        }
        Ok(())
    }

    /// The memory manager, if one is configured.
    #[must_use]
    pub fn memory_manager(&self) -> Option<&MemoryManager> {
        self.memory_manager.as_ref()
    }

    /// Captures a point-in-time snapshot of the agent's state.
    ///
    /// ```
    /// use strands::{Agent, SnapshotField, TakeSnapshotOptions};
    /// use strands::testing::MockModel;
    ///
    /// let agent = Agent::builder().model(MockModel::new()).printer(false).build()?;
    /// let snapshot = agent.take_snapshot(TakeSnapshotOptions::session())?;
    /// assert!(snapshot.data.contains_key("messages"));
    ///
    /// let partial = agent.take_snapshot(TakeSnapshotOptions {
    ///     include: vec![SnapshotField::Messages, SnapshotField::State],
    ///     ..Default::default()
    /// })?;
    /// assert_eq!(partial.data.len(), 2);
    /// # Ok::<(), strands::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// When the options select no field, or a value fails to serialize.
    pub fn take_snapshot(&self, options: impl Into<TakeSnapshotOptions>) -> Result<Snapshot> {
        self.local.take_snapshot(options)
    }

    /// Restores the agent's state from a snapshot. Only the fields present in
    /// `snapshot.data` are restored; the others stay as they are.
    ///
    /// # Errors
    ///
    /// A snapshot of another scope or schema version, data that does not decode, or background
    /// tasks still tracked.
    pub fn load_snapshot(&mut self, snapshot: &Snapshot) -> Result<()> {
        self.local.load_snapshot(snapshot)
    }

    /// The agent's view as sequential hooks see it.
    #[must_use]
    pub fn local(&self) -> &LocalAgent {
        &self.local
    }

    /// The agent's view as sequential hooks see it, mutably.
    pub fn local_mut(&mut self) -> &mut LocalAgent {
        &mut self.local
    }

    /// The agent's id (`id`).
    #[must_use]
    pub fn id(&self) -> &str {
        self.local.id()
    }

    /// The agent's name (`name`).
    #[must_use]
    pub fn name(&self) -> &str {
        self.local.name()
    }

    /// What the agent does (`description`).
    #[must_use]
    pub fn description(&self) -> Option<&str> {
        self.local.description()
    }

    /// A stable id for the conversation session.
    #[must_use]
    pub fn session_id(&self) -> &str {
        self.local.session_id()
    }

    /// The default storage backend for agent subsystems, if one is configured (`storage`).
    #[must_use]
    pub fn storage(&self) -> Option<&Arc<dyn Storage>> {
        self.local.storage()
    }

    /// The session manager saving and restoring the agent, if one is attached.
    #[must_use]
    pub fn session_manager(&self) -> Option<&SessionManager> {
        self.session_manager.as_ref()
    }

    /// The conversation history (`messages`).
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        self.local.messages()
    }

    /// The conversation history, to edit between invocations.
    pub fn messages_mut(&mut self) -> &mut Vec<Message> {
        self.local.messages_mut()
    }

    /// The system prompt.
    #[must_use]
    pub fn system_prompt(&self) -> Option<&SystemPrompt> {
        self.local.system_prompt()
    }

    /// Replaces or clears the system prompt.
    pub fn set_system_prompt(&mut self, system_prompt: Option<SystemPrompt>) {
        self.local.set_system_prompt(system_prompt);
    }

    /// The model the agent calls (`model`).
    #[must_use]
    pub fn model(&self) -> &Arc<dyn Model> {
        self.local.model()
    }

    /// Replaces the model the agent calls: a model instance, an `Arc<dyn Model>` or a Bedrock
    /// model id, like the builder's `model(..)`.
    ///
    /// # Errors
    ///
    /// A Bedrock model id without the `bedrock` feature, and a [`ModelRouter`](crate::ModelRouter)
    /// (`a ModelRouter is accepted only as the agent's configured model, not by set_model`): a
    /// router is attached when the agent is built, so configure it there.
    pub fn set_model(&mut self, model: impl Into<ModelSource>) -> Result<()> {
        self.local.set_model(resolve_model(model.into())?);
        Ok(())
    }

    /// The model for auxiliary side calls; the agent's model unless one was configured.
    #[must_use]
    pub fn aux_model(&self) -> &Arc<dyn Model> {
        self.local.aux_model()
    }

    /// Sets the auxiliary model; `None` follows the agent's model again.
    pub fn set_aux_model(&mut self, aux_model: Option<Arc<dyn Model>>) {
        self.local.set_aux_model(aux_model);
    }

    /// Where the agent's tools run commands and touch files (`sandbox`): the configured sandbox,
    /// or the shared [`NotASandboxLocalEnvironment`](crate::sandbox::NotASandboxLocalEnvironment)
    /// when none is configured.
    #[must_use]
    pub fn sandbox(&self) -> &Arc<dyn Sandbox> {
        self.local.sandbox()
    }

    /// App state shared with tools.
    #[must_use]
    pub fn app_state(&self) -> &StateStore {
        self.local.app_state()
    }

    /// The model provider's runtime state.
    #[must_use]
    pub fn model_state(&self) -> &StateStore {
        self.local.model_state()
    }

    /// The agent's tools.
    #[must_use]
    pub fn tool_registry(&self) -> &ToolRegistry {
        self.local.tool_registry()
    }

    /// The agent's tools, to add or remove some.
    pub fn tool_registry_mut(&mut self) -> &mut ToolRegistry {
        self.local.tool_registry_mut()
    }

    /// The registered tools (`tools`).
    #[must_use]
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.local.tool_registry().list()
    }

    /// How the tool calls of one model turn run.
    #[must_use]
    pub fn tool_executor(&self) -> ToolExecutorStrategy {
        self.tool_executor
    }

    /// Sets how the tool calls of one model turn run.
    pub fn set_tool_executor(&mut self, tool_executor: impl Into<ToolExecutorStrategy>) {
        self.tool_executor = tool_executor.into();
    }

    /// Accumulated loop metrics: cycles, token usage and tool statistics (`metrics`).
    #[must_use]
    pub fn metrics(&self) -> AgentMetrics {
        self.local.metrics()
    }

    /// The OpenTelemetry baggage entries every invocation runs under.
    #[must_use]
    pub fn baggage_attributes(&self) -> &BTreeMap<String, String> {
        self.local.tracer().baggage_attributes()
    }

    /// A handle that cancels the agent's current invocation (`agent.cancel`). Cancels while the
    /// agent is idle do nothing; the invocation in progress ends with `StopReason::Cancelled`.
    ///
    /// ```
    /// use strands::{Agent, CancelOptions};
    /// use strands::testing::MockModel;
    ///
    /// let agent = Agent::builder().model(MockModel::new()).printer(false).build()?;
    /// let cancel = agent.cancel_handle();
    /// std::thread::spawn(move || cancel.cancel(CancelOptions::default()));
    /// # Ok::<(), strands::Error>(())
    /// ```
    #[must_use]
    pub fn cancel_handle(&self) -> CancelHandle {
        self.local.cancel_handle().clone()
    }

    /// The cancellation signal of the current invocation.
    #[must_use]
    pub fn cancel_signal(&self) -> CancelSignal {
        self.local.cancel_signal()
    }

    /// Registers a hook closure; see [`HookRegistry::add_hook`](crate::hooks::HookRegistry::add_hook).
    pub fn add_hook<K: HookEvent>(&self, callback: impl IntoSyncHook<K>) -> HookCleanup {
        self.local.add_hook(callback)
    }

    /// Registers a hook closure with options.
    pub fn add_hook_with<K: HookEvent>(
        &self,
        callback: impl IntoSyncHook<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.local.add_hook_with(callback, options)
    }

    /// Registers an async hook closure; name the event type.
    pub fn add_async_hook<K: HookEvent>(&self, callback: impl IntoAsyncHook<K>) -> HookCleanup {
        self.local.add_async_hook::<K>(callback)
    }

    /// Registers an async hook closure with options.
    pub fn add_async_hook_with<K: HookEvent>(
        &self,
        callback: impl IntoAsyncHook<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.local.add_async_hook_with::<K>(callback, options)
    }

    /// Registers a [`Hook`](crate::hooks::Hook) implementation.
    pub fn add_hook_impl<K: HookEvent>(&self, hook: impl IntoHookImpl<K>) -> HookCleanup {
        self.local.add_hook_impl(hook)
    }

    /// Registers a [`Hook`](crate::hooks::Hook) implementation with options.
    pub fn add_hook_impl_with<K: HookEvent>(
        &self,
        hook: impl IntoHookImpl<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.local.add_hook_impl_with(hook, options)
    }

    /// Registers a middleware handler for its stage and phase; see
    /// [`middleware`](crate::middleware).
    ///
    /// ```
    /// use strands::Agent;
    /// use strands::middleware::InvokeModelStage;
    /// use strands::testing::MockModel;
    ///
    /// let agent = Agent::builder().model(MockModel::new()).printer(false).build()?;
    /// let cleanup = agent.add_middleware(InvokeModelStage::output(|mut result| async move {
    ///     result.result.message.content.retain(|block| block.as_text().is_some());
    ///     Ok(result)
    /// }));
    /// cleanup.remove();
    /// # Ok::<(), strands::Error>(())
    /// ```
    pub fn add_middleware<S: MiddlewareStage>(&self, middleware: Middleware<S>) -> MiddlewareCleanup {
        self.local.add_middleware(middleware)
    }

    /// Prints through `appender` instead of stdout (tests).
    #[cfg(test)]
    #[allow(dead_code, reason = "used by the printer tests")]
    pub(crate) fn set_printer_appender(&mut self, appender: super::printer::Appender) {
        self.printer = Some(AgentPrinter::new(appender));
    }

    /// Makes retries wait on `sleeper` (tests).
    #[cfg(test)]
    #[allow(dead_code, reason = "used by the retry tests")]
    pub(crate) fn set_retry_sleeper(&self, sleeper: Arc<dyn crate::retry::Sleeper>) {
        *self
            .retry_sleeper
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = sleeper;
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        if let Some(background_tasks) = &self.background_tasks {
            background_tasks.shutdown();
        }
        if self.pending_cleanup.is_some() {
            tracing::warn!(
                "agent_id=<{}> | agent dropped with pending shutdown work, call shutdown().await before dropping it",
                self.local.id()
            );
        }
    }
}

impl fmt::Debug for Agent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Agent")
            .field("id", &self.local.id())
            .field("name", &self.local.name())
            .field("messages", &self.local.messages().len())
            .field("tool_registry", self.local.tool_registry())
            .finish_non_exhaustive()
    }
}
