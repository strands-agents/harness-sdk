//! The mutable agent view that sequential hook events and plugins see (`LocalAgent`).

use std::fmt;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use super::tool_agent::{ChildInheritance, ToolAgent};
use crate::background_tasks::BackgroundTasks;
use crate::cancel::{CancelHandle, CancelOptions, CancelSignal};
use crate::context_manager::{AgentArchive, ContextManager};
use crate::hooks::{
    HookCallbackOptions, HookCleanup, HookEvent, HookRegistry, IntoAsyncHook, IntoHookImpl, IntoSyncHook,
};
use crate::interrupt::InterruptState;
use crate::interventions::InterventionHandler;
use crate::middleware::{Middleware, MiddlewareCleanup, MiddlewareRegistry, MiddlewareStage};
use crate::models::Model;
use crate::models::model_proxy::{CallTools, CallToolsRecord};
use crate::sandbox::{Sandbox, default_sandbox};
use crate::state_store::StateStore;
use crate::storage::Storage;
use crate::telemetry::{AgentMetrics, Meter, Tracer};
use crate::tools::ToolRegistry;
use crate::types::{AgentMetadata, Message, SystemPrompt};

/// The agent as sequential hook events and plugins see it (`LocalAgent`).
///
/// It holds everything those callbacks may change: the conversation, the system prompt, the
/// tools and the state, plus the agent's identity, models and hooks. Hook events lend it out as
/// `&mut LocalAgent` while the loop is paused at the event.
#[non_exhaustive]
pub struct LocalAgent {
    id: String,
    name: Option<String>,
    description: Option<String>,
    session_id: OnceLock<String>,
    app_state: StateStore,
    model_state: StateStore,
    messages: Vec<Message>,
    system_prompt: Option<SystemPrompt>,
    model: Arc<dyn Model>,
    aux_model: Option<Arc<dyn Model>>,
    agent_metadata: Option<AgentMetadata>,
    tool_registry: ToolRegistry,
    cancel_handle: CancelHandle,
    cancel_signal: CancelSignal,
    meter: Arc<Mutex<Meter>>,
    tracer: Arc<Tracer>,
    hooks: Arc<HookRegistry>,
    middleware: Arc<MiddlewareRegistry>,
    interrupt_state: InterruptState,
    background_tasks: Option<Arc<BackgroundTasks>>,
    sandbox: Option<Arc<dyn Sandbox>>,
    printer: bool,
    storage: Option<Arc<dyn Storage>>,
    context_manager: Option<ContextManager>,
    context_archive: Option<AgentArchive>,
    latest_call_tools: CallToolsRecord,
    interventions: Arc<[Arc<dyn InterventionHandler>]>,
}

impl LocalAgent {
    /// Creates a view with an id and a model, and empty state otherwise.
    pub(crate) fn new(id: impl Into<String>, model: Arc<dyn Model>) -> Self {
        let cancel_handle = CancelHandle::new();
        Self {
            id: id.into(),
            name: None,
            description: None,
            session_id: OnceLock::new(),
            app_state: StateStore::new(),
            model_state: StateStore::new(),
            messages: Vec::new(),
            system_prompt: None,
            model,
            aux_model: None,
            agent_metadata: None,
            tool_registry: ToolRegistry::new(),
            cancel_signal: cancel_handle.signal(),
            cancel_handle,
            meter: Arc::new(Mutex::new(Meter::new())),
            tracer: Arc::new(Tracer::default()),
            hooks: Arc::new(HookRegistry::new()),
            middleware: Arc::new(MiddlewareRegistry::new()),
            interrupt_state: InterruptState::new(),
            background_tasks: None,
            sandbox: None,
            printer: false,
            storage: None,
            context_manager: None,
            context_archive: None,
            latest_call_tools: CallToolsRecord::default(),
            interventions: Arc::from(Vec::new()),
        }
    }

    pub(crate) fn set_name(&mut self, name: Option<String>, description: Option<String>) {
        self.name = name;
        self.description = description;
    }

    /// Uses a session manager's id instead of the generated one.
    pub(crate) fn set_session_id(&mut self, session_id: String) {
        self.session_id = OnceLock::from(session_id);
    }

    pub(crate) fn set_model(&mut self, model: Arc<dyn Model>) {
        self.model = model;
    }

    pub(crate) fn set_aux_model(&mut self, aux_model: Option<Arc<dyn Model>>) {
        self.aux_model = aux_model;
    }

    pub(crate) fn set_agent_metadata(&mut self, agent_metadata: Option<AgentMetadata>) {
        self.agent_metadata = agent_metadata;
    }

    pub(crate) fn set_storage(&mut self, storage: Option<Arc<dyn Storage>>) {
        self.storage = storage;
    }

    /// Records the agent's intervention handlers, for the children the default subagent builder
    /// makes.
    pub(crate) fn set_interventions(&mut self, interventions: Arc<[Arc<dyn InterventionHandler>]>) {
        self.interventions = interventions;
    }

    #[cfg(test)]
    pub(crate) fn interventions(&self) -> &[Arc<dyn InterventionHandler>] {
        &self.interventions
    }

    pub(crate) fn set_context_manager(&mut self, context_manager: Option<ContextManager>) {
        self.context_manager = context_manager;
    }

    /// The resolved context manager, when a preset, configuration or instance was given.
    pub(crate) fn context_manager(&self) -> Option<&ContextManager> {
        self.context_manager.as_ref()
    }

    pub(crate) fn set_context_archive(&mut self, context_archive: Option<AgentArchive>) {
        self.context_archive = context_archive;
    }

    /// The archive the context manager made for this agent, once it is attached.
    pub(crate) fn context_archive(&self) -> Option<&AgentArchive> {
        self.context_archive.as_ref()
    }

    /// Where the agent's model calls record the tools they send.
    pub(crate) fn latest_call_tools_record(&self) -> &CallToolsRecord {
        &self.latest_call_tools
    }

    /// The tools the agent's latest model call sent, before any stubs; `None` before its first
    /// call (`latestCallTools`).
    pub(crate) fn latest_call_tools(&self) -> Option<CallTools> {
        self.latest_call_tools
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn set_cancel_handle(&mut self, cancel_handle: CancelHandle) {
        self.cancel_signal = cancel_handle.signal();
        self.cancel_handle = cancel_handle;
    }

    pub(crate) fn cancel_handle(&self) -> &CancelHandle {
        &self.cancel_handle
    }

    /// Sets the signal of the current invocation: the agent's own, merged with the caller's.
    pub(crate) fn set_cancel_signal(&mut self, cancel_signal: CancelSignal) {
        self.cancel_signal = cancel_signal;
    }

    pub(crate) fn meter(&self) -> &Arc<Mutex<Meter>> {
        &self.meter
    }

    pub(crate) fn tracer(&self) -> &Arc<Tracer> {
        &self.tracer
    }

    pub(crate) fn set_tracer(&mut self, tracer: Tracer) {
        self.tracer = Arc::new(tracer);
    }

    pub(crate) fn hooks(&self) -> &Arc<HookRegistry> {
        &self.hooks
    }

    /// The agent's background tasks once it is initialized; snapshot loads check them.
    pub(crate) fn set_background_tasks(&mut self, background_tasks: Option<Arc<BackgroundTasks>>) {
        self.background_tasks = background_tasks;
    }

    pub(crate) fn background_tasks(&self) -> Option<&Arc<BackgroundTasks>> {
        self.background_tasks.as_ref()
    }

    pub(crate) fn middleware(&self) -> &Arc<MiddlewareRegistry> {
        &self.middleware
    }

    pub(crate) fn interrupt_state(&self) -> &InterruptState {
        &self.interrupt_state
    }

    /// Records whether the agent prints, for the children the default subagent builder makes.
    pub(crate) fn set_printer(&mut self, printer: bool) {
        self.printer = printer;
    }

    pub(crate) fn set_sandbox(&mut self, sandbox: Option<Arc<dyn Sandbox>>) {
        self.sandbox = sandbox;
    }

    /// The sandbox from the agent's configuration, without the default.
    pub(crate) fn configured_sandbox(&self) -> Option<&Arc<dyn Sandbox>> {
        self.sandbox.as_ref()
    }

    /// The view tools of the next batch get: shared state and models, and snapshots of the
    /// messages and tools.
    pub(crate) fn tool_agent(&self) -> ToolAgent {
        ToolAgent::new(self.id.clone(), self.session_id(), self.model.clone())
            .with_name(self.name.clone())
            .with_state(self.app_state.clone(), self.model_state.clone())
            .with_aux_model(self.aux_model.clone())
            .with_cancel_handle(self.cancel_handle.clone())
            .with_cancel_signal(self.cancel_signal.clone())
            .with_messages(Arc::from(self.messages.clone()))
            .with_tool_registry(Arc::new(self.tool_registry.clone()))
            .with_interrupt_state(self.interrupt_state.clone())
            .with_sandbox(self.sandbox().clone())
            .with_printer(self.printer)
            .with_inheritance(ChildInheritance {
                context_manager: self.context_manager.clone(),
                interventions: self.interventions.clone(),
                tracer: Some(self.tracer.clone()),
            })
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

    /// What the agent does.
    #[must_use]
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    /// A stable id for the current conversation session: the session manager's id
    /// when one is attached, otherwise a random 8-character hex id generated once per agent.
    #[must_use]
    pub fn session_id(&self) -> &str {
        self.session_id.get_or_init(|| format!("{:08x}", rand::random::<u32>()))
    }

    /// App state shared with tools and application code.
    #[must_use]
    pub fn app_state(&self) -> &StateStore {
        &self.app_state
    }

    /// The model provider's runtime state, such as response ids of server-side conversations.
    #[must_use]
    pub fn model_state(&self) -> &StateStore {
        &self.model_state
    }

    /// The conversation history.
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// The conversation history, to edit.
    pub fn messages_mut(&mut self) -> &mut Vec<Message> {
        &mut self.messages
    }

    /// The system prompt.
    #[must_use]
    pub fn system_prompt(&self) -> Option<&SystemPrompt> {
        self.system_prompt.as_ref()
    }

    /// Replaces or clears the system prompt.
    pub fn set_system_prompt(&mut self, system_prompt: Option<SystemPrompt>) {
        self.system_prompt = system_prompt;
    }

    /// The model the agent calls.
    #[must_use]
    pub fn model(&self) -> &Arc<dyn Model> {
        &self.model
    }

    /// The model for auxiliary side calls (summaries, classification); the agent's model unless
    /// one was configured.
    #[must_use]
    pub fn aux_model(&self) -> &Arc<dyn Model> {
        self.aux_model.as_ref().unwrap_or(&self.model)
    }

    /// The metadata the agent passes to its model.
    #[must_use]
    pub fn agent_metadata(&self) -> Option<&AgentMetadata> {
        self.agent_metadata.as_ref()
    }

    /// Where the agent's tools run commands and touch files (`sandbox`): the configured sandbox,
    /// or the shared [`NotASandboxLocalEnvironment`](crate::sandbox::NotASandboxLocalEnvironment)
    /// when none is configured.
    #[must_use]
    pub fn sandbox(&self) -> &Arc<dyn Sandbox> {
        self.sandbox.as_ref().unwrap_or(default_sandbox())
    }

    /// The default storage backend for agent subsystems (`storage`): subsystems without their own
    /// storage, such as the session manager, resolve from it under their own namespace.
    #[must_use]
    pub fn storage(&self) -> Option<&Arc<dyn Storage>> {
        self.storage.as_ref()
    }

    /// The agent's tools.
    #[must_use]
    pub fn tool_registry(&self) -> &ToolRegistry {
        &self.tool_registry
    }

    /// The agent's tools, to add or remove some.
    pub fn tool_registry_mut(&mut self) -> &mut ToolRegistry {
        &mut self.tool_registry
    }

    /// The cancellation signal of the current invocation.
    #[must_use]
    pub fn cancel_signal(&self) -> CancelSignal {
        self.cancel_signal.clone()
    }

    /// Cancels the current invocation (`cancel`); does nothing when the agent is idle.
    pub fn cancel(&self, options: CancelOptions) {
        self.cancel_handle.cancel(options);
    }

    /// Aggregated loop metrics of the agent: cycles, token usage and tool statistics.
    #[must_use]
    pub fn metrics(&self) -> AgentMetrics {
        self.meter.lock().unwrap_or_else(PoisonError::into_inner).metrics()
    }

    /// Registers a hook closure; see [`HookRegistry::add_hook`].
    pub fn add_hook<K: HookEvent>(&self, callback: impl IntoSyncHook<K>) -> HookCleanup {
        self.hooks.add_hook(callback)
    }

    /// Registers a hook closure with options; see [`HookRegistry::add_hook_with`].
    pub fn add_hook_with<K: HookEvent>(
        &self,
        callback: impl IntoSyncHook<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.hooks.add_hook_with(callback, options)
    }

    /// Registers an async hook closure; see [`HookRegistry::add_async_hook`].
    pub fn add_async_hook<K: HookEvent>(&self, callback: impl IntoAsyncHook<K>) -> HookCleanup {
        self.hooks.add_async_hook::<K>(callback)
    }

    /// Registers an async hook closure with options; see [`HookRegistry::add_async_hook_with`].
    pub fn add_async_hook_with<K: HookEvent>(
        &self,
        callback: impl IntoAsyncHook<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.hooks.add_async_hook_with::<K>(callback, options)
    }

    /// Registers a [`Hook`](crate::hooks::Hook) implementation; see [`HookRegistry::add_hook_impl`].
    pub fn add_hook_impl<K: HookEvent>(&self, hook: impl IntoHookImpl<K>) -> HookCleanup {
        self.hooks.add_hook_impl(hook)
    }

    /// Registers a [`Hook`](crate::hooks::Hook) implementation with options.
    pub fn add_hook_impl_with<K: HookEvent>(
        &self,
        hook: impl IntoHookImpl<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.hooks.add_hook_impl_with(hook, options)
    }

    /// Registers a middleware handler for its stage and phase; see
    /// [`middleware`](crate::middleware). Handlers registered while an invocation runs apply from
    /// the next stage call.
    pub fn add_middleware<S: MiddlewareStage>(&self, middleware: Middleware<S>) -> MiddlewareCleanup {
        self.middleware.add(middleware)
    }
}

impl fmt::Debug for LocalAgent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LocalAgent")
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

    fn agent() -> LocalAgent {
        LocalAgent::new("agent-1", Arc::new(MockModel::new()))
    }

    #[test]
    fn session_id_is_generated_once_as_eight_hex_characters() {
        let agent = agent();
        let id = agent.session_id().to_owned();
        assert_eq!(id.len(), 8);
        assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(agent.session_id(), id);
        let mut agent = agent;
        agent.set_session_id("session-1".into());
        assert_eq!(agent.session_id(), "session-1");
    }

    #[test]
    fn tool_agent_shares_state_and_snapshots_messages_and_tools() {
        let mut agent = agent();
        agent.messages_mut().push(Message::user("hi"));
        agent.tool_registry_mut().add(MockTool::new("probe")).unwrap();
        let view = agent.tool_agent();
        agent.messages_mut().clear();
        agent.tool_registry_mut().clear();
        view.app_state().set("k", json!(1)).unwrap();

        assert_eq!(view.messages().len(), 1);
        assert!(view.tool_registry().get("probe").is_some());
        assert_eq!(agent.app_state().get_value("k"), Some(json!(1)));
        assert_eq!(view.session_id(), agent.session_id());
        agent.cancel(CancelOptions::default());
        assert!(view.cancel_signal().is_cancelled());
    }

    #[test]
    fn system_prompt_and_aux_model_have_setters() {
        let mut agent = agent();
        agent.set_system_prompt(Some("Be brief.".into()));
        assert_eq!(agent.system_prompt(), Some(&SystemPrompt::from("Be brief.")));
        assert!(Arc::ptr_eq(agent.aux_model(), agent.model()));
        let aux: Arc<dyn Model> = Arc::new(MockModel::new());
        agent.set_aux_model(Some(aux.clone()));
        assert!(Arc::ptr_eq(agent.aux_model(), &aux));
    }
}
