//! The background tasks plugin.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use async_trait::async_trait;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde_json::json;

use super::BackgroundTasksConfig;
use super::manager::{Manager, ManagerOptions, RunFn};
use super::types::{BackgroundTask, BackgroundTaskStatus, TaskFailure, TaskFailureType, not_found};
use crate::agent::continuation::ContinuationInput;
use crate::agent::{InvocationState, InvokeArgs, LocalAgent};
use crate::cancel::CancelSignal;
use crate::clock::iso_timestamp;
use crate::error::{Error, Result};
use crate::hooks::{AfterInvocationEvent, BeforeModelCallEvent, HookCallbackOptions, HookOrder, InitializedEvent};
use crate::interrupt::InterruptState;
use crate::middleware::InvokeModelStage;
use crate::plugins::Plugin;
use crate::state_store::StateStore;
use crate::tools::{
    DelegationToken, STRUCTURED_OUTPUT_TOOL_NAME, Tool, ToolContext, ToolOutcome, ToolRegistry, ToolSource, ToolStream,
};
use crate::types::{
    ContentBlock, JsonValue, Message, Role, ToolResultBlock, ToolResultContent, ToolSpec, ToolUse, ToolUseBlock,
};

pub(crate) const BACKGROUND_TASKS_STATE_KEY: &str = "strands.backgroundTasks";
pub(crate) const BACKGROUND_PROPERTY: &str = "_background_execution";
pub(crate) const MANAGE_TOOL_NAME: &str = "strands_manage_background_task";
const PLUGIN_NAME: &str = "strands:background-tasks";
const COMPOSITE_SCHEMA_KEYS: [&str; 8] = ["$ref", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"];
const FOREGROUND_TOOL_NAMES: [&str; 4] = [
    STRUCTURED_OUTPUT_TOOL_NAME,
    "summarize_context",
    "truncate_context",
    "pin_context",
];
const MANAGE_TOOL_DESCRIPTION: &str = "List, get, or cancel background tasks. Results are delivered automatically as synthetic 'get' calls. Do not poll for results.";
const RECOVERY_MESSAGE: &str = "Background task cannot resume after restoring persisted state";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Never,
    Agentic,
    Always,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::Agentic => "agentic",
            Self::Always => "always",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Policy {
    mode: Mode,
    exact: bool,
}

/// Where a tool call runs.
pub(crate) enum Route {
    Foreground,
    Background,
    Error(ToolResultBlock),
}

#[derive(Default)]
struct Shared {
    /// The name the management tool is registered and delivered under.
    manage_tool_name: String,
    /// Whether this invocation raised task interrupts: a cancel can drop the interrupt the
    /// invocation already returns, so the interrupt state is not enough.
    raised_interrupt: AtomicBool,
    tasks: Mutex<IndexMap<String, BackgroundTask>>,
    manager: OnceLock<Manager>,
    app_state: OnceLock<StateStore>,
}

impl Shared {
    fn tasks(&self) -> MutexGuard<'_, IndexMap<String, BackgroundTask>> {
        self.tasks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn snapshot(&self) -> Vec<BackgroundTask> {
        self.tasks().values().cloned().collect()
    }

    fn manager(&self) -> Result<&Manager> {
        self.manager
            .get()
            .ok_or_else(|| Error::other("background tasks are not initialized"))
    }

    /// Stores the tracked tasks in app state, or removes the key when there are none.
    fn persist(&self) {
        let Some(app_state) = self.app_state.get() else {
            return;
        };
        let tasks = self.snapshot();
        if tasks.is_empty() {
            app_state.delete(BACKGROUND_TASKS_STATE_KEY);
            return;
        }
        if let Err(error) = app_state.set(BACKGROUND_TASKS_STATE_KEY, &tasks) {
            tracing::warn!("error=<{error}> | failed to persist background tasks");
        }
    }

    fn record(&self, task: BackgroundTask) {
        self.tasks().insert(task.task_id.clone(), task);
        self.persist();
    }
}

/// Background tool execution for one agent (`BackgroundTasks`), registered as a plugin.
pub(crate) struct BackgroundTasks {
    config: BackgroundTasksConfig,
    policy: HashMap<String, Mode>,
    shared: Arc<Shared>,
}

/// Resolves the per-tool modes, rejecting a tool named for two modes.
fn resolve_policy(config: &BackgroundTasksConfig) -> Result<HashMap<String, Mode>> {
    let names_wildcard =
        |names: &Option<Vec<String>>| names.as_ref().is_some_and(|names| names.iter().any(|name| name == "*"));
    let explicit_wildcard = names_wildcard(&config.always) || names_wildcard(&config.never);
    let agentic = config.agentic.clone().unwrap_or_else(|| {
        if explicit_wildcard {
            Vec::new()
        } else {
            vec!["*".to_owned()]
        }
    });
    let assignments = [
        (Mode::Agentic, agentic),
        (Mode::Always, config.always.clone().unwrap_or_default()),
        (Mode::Never, config.never.clone().unwrap_or_default()),
    ];
    let mut policy = HashMap::new();
    for (mode, names) in assignments {
        for name in names {
            if let Some(existing) = policy.get(&name).copied()
                && existing != mode
            {
                return Err(Error::other(format!(
                    "Tool '{name}' cannot be configured as both '{}' and '{}'",
                    Mode::as_str(existing),
                    mode.as_str()
                )));
            }
            policy.insert(name, mode);
        }
    }
    Ok(policy)
}

fn can_execute_in_background(tool: Option<&Arc<dyn Tool>>, manage_tool_name: &str) -> bool {
    tool.is_some_and(|tool| {
        tool.name() != manage_tool_name
            && !FOREGROUND_TOOL_NAMES.contains(&tool.name())
            && !tool.is_delegation_tool(DelegationToken(()))
    })
}

/// The spec with the `_background_execution` selector added, or `None` when its schema cannot
/// take one.
fn add_background_selection(spec: &ToolSpec) -> Option<ToolSpec> {
    let schema = spec
        .input_schema
        .as_ref()
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    if COMPOSITE_SCHEMA_KEYS.iter().any(|key| schema.contains_key(*key)) {
        return None;
    }
    if schema.get("type").is_some_and(|kind| kind != "object") {
        return None;
    }
    let properties = match schema.get("properties") {
        None => serde_json::Map::new(),
        Some(JsonValue::Object(properties)) => properties.clone(),
        Some(_) => return None,
    };
    let required = schema.get("required").and_then(JsonValue::as_array);
    if properties.contains_key(BACKGROUND_PROPERTY)
        || required.is_some_and(|required| required.iter().any(|name| name == BACKGROUND_PROPERTY))
    {
        return None;
    }
    let mut properties = properties;
    properties.insert(
        BACKGROUND_PROPERTY.to_owned(),
        json!({
            "type": "boolean",
            "description": "Run this tool in the background and continue without waiting for its result."
        }),
    );
    let mut schema = schema;
    schema.insert("type".to_owned(), json!("object"));
    schema.insert("properties".to_owned(), JsonValue::Object(properties));
    let mut spec = spec.clone();
    spec.input_schema = Some(JsonValue::Object(schema));
    Some(spec)
}

fn can_select_background(tool: &Arc<dyn Tool>) -> bool {
    add_background_selection(&tool.tool_spec()).is_some()
}

fn tool_error(tool_use_id: &str, message: &str) -> ToolResultBlock {
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(message)])
        .with_error(Error::other(message.to_owned()))
}

/// The `get` result content: the task metadata as JSON, then its result content.
fn task_result_content(task: &BackgroundTask) -> Vec<ToolResultContent> {
    let mut metadata = task.clone();
    let result = metadata.result.take();
    let metadata = serde_json::to_value(&metadata).unwrap_or(JsonValue::Null);
    std::iter::once(ToolResultContent::json(metadata))
        .chain(result.into_iter().flat_map(|result| result.content))
        .collect()
}

/// A task restored from app state; one that had not finished fails.
fn recover_task(mut task: BackgroundTask) -> BackgroundTask {
    if task.status.is_terminal() {
        return task;
    }
    task.interrupts = None;
    task.status = BackgroundTaskStatus::Failed;
    task.last_updated_at = iso_timestamp();
    task.error = Some(TaskFailure::new(TaskFailureType::ExecutionError, RECOVERY_MESSAGE));
    task
}

impl BackgroundTasks {
    /// Creates the plugin.
    ///
    /// # Errors
    ///
    /// A tool configured for two modes.
    pub(crate) fn new(config: BackgroundTasksConfig) -> Result<Self> {
        let manage_tool_name = config
            .manage_tool_name
            .clone()
            .unwrap_or_else(|| MANAGE_TOOL_NAME.to_owned());
        Ok(Self {
            policy: resolve_policy(&config)?,
            config,
            shared: Arc::new(Shared {
                manage_tool_name,
                ..Shared::default()
            }),
        })
    }

    fn policy_for(&self, tool: Option<&Arc<dyn Tool>>) -> Option<Policy> {
        let tool = tool?;
        if let Some(mode) = self.policy.get(tool.name()) {
            return Some(Policy {
                mode: *mode,
                exact: true,
            });
        }
        self.policy.get("*").map(|mode| Policy {
            mode: *mode,
            exact: false,
        })
    }

    /// Cancels every unfinished task and aborts its execution: on `Agent::shutdown` and drop,
    /// so no tool call outlives the agent.
    pub(crate) fn shutdown(&self) {
        if let Ok(manager) = self.shared.manager() {
            manager.shutdown();
        }
    }

    /// Cancels every task that is not terminal and drops the agent interrupts they raised
    /// (`cancelAll`). The tasks are recorded as cancelled before this returns; it does not wait
    /// for their tools to stop.
    fn cancel_all(&self, interrupt_state: &InterruptState) {
        let Ok(manager) = self.shared.manager() else {
            return;
        };
        let interrupt_ids: Vec<String> = self
            .shared
            .snapshot()
            .iter()
            .filter(|task| !task.status.is_terminal())
            .flat_map(|task| task.interrupts.iter().flatten().map(|interrupt| interrupt.id.clone()))
            .collect();
        manager.cancel_all();
        drop_interrupts(interrupt_state, &interrupt_ids);
        self.shared.persist();
    }

    /// Decides where a call runs and strips `_background_execution` from its input, so the tool
    /// never sees the selector.
    pub(crate) fn route_tool_call(
        &self,
        tool_use: &mut ToolUse,
        requested: Option<&Arc<dyn Tool>>,
        effective: Option<&Arc<dyn Tool>>,
    ) -> Route {
        let mut selected = false;
        if let JsonValue::Object(input) = &mut tool_use.input
            && let Some(value) = input.shift_remove(BACKGROUND_PROPERTY)
        {
            let JsonValue::Bool(value) = value else {
                return Route::Error(tool_error(
                    &tool_use.tool_use_id,
                    &format!("'{BACKGROUND_PROPERTY}' must be a boolean"),
                ));
            };
            if self
                .policy_for(requested)
                .is_some_and(|policy| policy.mode == Mode::Agentic)
            {
                selected = value;
            }
        }
        let Some(policy) = self.policy_for(effective).filter(|policy| policy.mode != Mode::Never) else {
            return Route::Foreground;
        };
        if !can_execute_in_background(effective, &self.shared.manage_tool_name) {
            return self.reject(policy, tool_use, "cannot run in the background");
        }
        if policy.mode == Mode::Agentic && !effective.is_some_and(can_select_background) {
            return self.reject(policy, tool_use, "cannot use agentic background selection");
        }
        if policy.mode == Mode::Always || selected {
            Route::Background
        } else {
            Route::Foreground
        }
    }

    fn reject(&self, policy: Policy, tool_use: &ToolUse, reason: &str) -> Route {
        if !policy.exact {
            return Route::Foreground;
        }
        Route::Error(tool_error(
            &tool_use.tool_use_id,
            &format!("Tool '{}' {reason}", tool_use.name),
        ))
    }

    /// Admits a call for background execution and returns its dispatch acknowledgement.
    pub(crate) fn submit_tool_call(
        &self,
        tool_use: ToolUse,
        invocation_state: InvocationState,
        pass_id: &str,
        tool: Arc<dyn Tool>,
        cancel_signal: &CancelSignal,
        run: RunFn,
    ) -> ToolResultBlock {
        if cancel_signal.is_cancelled() {
            return tool_error(&tool_use.tool_use_id, "Tool execution cancelled");
        }
        let tool_use_id = tool_use.tool_use_id.clone();
        let task = match self.shared.manager() {
            Ok(manager) => manager.submit(tool_use, invocation_state, pass_id, tool, run),
            Err(error) => {
                tracing::warn!("error=<{error}> | background task admission failed");
                return tool_error(&tool_use_id, "Background task admission failed");
            }
        };
        let text = [
            "Background task dispatched.".to_owned(),
            String::new(),
            format!("Task ID: {}", task.task_id),
            format!("Tool: {}", task.tool_name),
            format!("Status: {}", task.status.as_str()),
            String::new(),
            "The task is running in the background. Continue without waiting or polling.".to_owned(),
            "The final result will be delivered automatically when the task completes.".to_owned(),
        ]
        .join("\n");
        ToolResultBlock::success(tool_use_id, vec![ToolResultContent::text(text)])
    }

    /// Fails a background run whose tool middleware swapped for one that cannot run detached.
    pub(crate) fn assert_tool_can_run(&self, tool: Option<&Arc<dyn Tool>>) -> Result<()> {
        let allowed = can_execute_in_background(tool, &self.shared.manage_tool_name)
            && self.policy_for(tool).is_some_and(|policy| policy.mode != Mode::Never);
        if allowed {
            Ok(())
        } else {
            Err(Error::other("Tool cannot run in the background"))
        }
    }

    /// Refuses a snapshot load while tasks are tracked.
    pub(crate) fn assert_can_load_snapshot(&self) -> Result<()> {
        if self.shared.manager.get().is_some_and(Manager::has_tasks) {
            return Err(Error::other(
                "Cannot load a snapshot while background tasks are still tracked",
            ));
        }
        Ok(())
    }

    /// Restores the tasks persisted in app state: unfinished ones fail, and their
    /// interrupts leave the agent's interrupt state.
    pub(crate) fn load_app_state(&self, agent: &LocalAgent) {
        load_app_state(&self.shared, agent.app_state(), agent.interrupt_state());
    }

    fn validate_registered_tools(&self, registry: &ToolRegistry) -> Result<()> {
        for tool in registry.list() {
            let Some(policy) = self.policy_for(Some(&tool)) else {
                continue;
            };
            if !policy.exact || policy.mode == Mode::Never {
                continue;
            }
            if !can_execute_in_background(Some(&tool), &self.shared.manage_tool_name) {
                return Err(Error::other(format!(
                    "Tool '{}' cannot run in the background",
                    tool.name()
                )));
            }
            if policy.mode == Mode::Agentic && !can_select_background(&tool) {
                return Err(Error::other(format!(
                    "Tool '{}' cannot use agentic background selection",
                    tool.name()
                )));
            }
        }
        Ok(())
    }

    /// The model-stage Input handler that offers `_background_execution` on agentic tools.
    fn select_specs(self: &Arc<Self>, registry: &ToolRegistry, specs: Vec<ToolSpec>) -> Result<Vec<ToolSpec>> {
        specs
            .into_iter()
            .map(|spec| {
                let tool = registry.get(&spec.name).cloned();
                let Some(policy) = self
                    .policy_for(tool.as_ref())
                    .filter(|policy| policy.mode == Mode::Agentic)
                else {
                    return Ok(spec);
                };
                let rejected = || Error::other(format!("Tool '{}' cannot use agentic background selection", spec.name));
                if !can_execute_in_background(tool.as_ref(), &self.shared.manage_tool_name) {
                    return if policy.exact { Err(rejected()) } else { Ok(spec) };
                }
                match add_background_selection(&spec) {
                    Some(transformed) => Ok(transformed),
                    None if policy.exact => Err(rejected()),
                    None => Ok(spec),
                }
            })
            .collect()
    }
}

fn load_app_state(shared: &Shared, app_state: &StateStore, interrupt_state: &InterruptState) {
    let stored: Vec<BackgroundTask> = app_state
        .get(BACKGROUND_TASKS_STATE_KEY)
        .unwrap_or_else(|error| {
            tracing::warn!("error=<{error}> | ignoring unreadable background tasks in app state");
            None
        })
        .unwrap_or_default();
    let mut recovered_interrupts = Vec::new();
    {
        let mut tasks = shared.tasks();
        tasks.clear();
        for task in stored {
            if !task.status.is_terminal() {
                recovered_interrupts.extend(task.interrupts.iter().flatten().map(|interrupt| interrupt.id.clone()));
            }
            let task = recover_task(task);
            tasks.insert(task.task_id.clone(), task);
        }
    }
    drop_interrupts(interrupt_state, &recovered_interrupts);
    shared.persist();
}

/// Removes `interrupt_ids` from the agent's interrupt state, and deactivates it once no interrupt
/// is left.
fn drop_interrupts(interrupt_state: &InterruptState, interrupt_ids: &[String]) {
    let mut data = interrupt_state.to_data();
    let removed = interrupt_ids
        .iter()
        .filter(|id| data.interrupts.shift_remove(id.as_str()).is_some())
        .count();
    if removed > 0 {
        interrupt_state.load_data(data);
    }
    if interrupt_state.activated() && interrupt_state.interrupt_list().is_empty() {
        interrupt_state.deactivate();
    }
}

/// Adds the finished tasks as a synthetic `get` exchange, removed once it reaches history.
fn delivery(shared: &Arc<Shared>, tasks: &[BackgroundTask]) -> Option<ContinuationInput> {
    let finished: Vec<&BackgroundTask> = tasks.iter().filter(|task| task.status.is_terminal()).collect();
    if finished.is_empty() {
        return None;
    }
    let task_ids: Vec<String> = finished.iter().map(|task| task.task_id.clone()).collect();
    let messages: Vec<Message> = finished
        .iter()
        .flat_map(|task| {
            let tool_use = ToolUseBlock::new(
                shared.manage_tool_name.clone(),
                task.task_id.clone(),
                json!({"mode": "get", "taskId": task.task_id}),
            );
            let result = ToolResultBlock::success(task.task_id.clone(), task_result_content(task));
            [
                Message::new(Role::Assistant, vec![tool_use.into()]),
                Message::new(Role::User, vec![ContentBlock::ToolResult(result)]),
            ]
        })
        .collect();
    let shared = shared.clone();
    Some(
        ContinuationInput::new(InvokeArgs::Messages(messages)).on_appended(move || {
            if let Ok(manager) = shared.manager() {
                let live: Vec<String> = manager.list().into_iter().map(|task| task.task_id).collect();
                let tracked: Vec<String> = task_ids.iter().filter(|id| live.contains(id)).cloned().collect();
                if let Err(error) = manager.remove(&tracked) {
                    tracing::warn!("error=<{error}> | failed to remove delivered background tasks");
                }
            }
            {
                let mut tasks = shared.tasks();
                for task_id in &task_ids {
                    tasks.shift_remove(task_id);
                }
            }
            shared.persist();
        }),
    )
}

/// Before a model call: resumes tasks waiting on the interrupt responses of this pass, raises the
/// interrupts of tasks still waiting, and delivers finished tasks.
fn before_model_call(shared: &Arc<Shared>, event: &mut BeforeModelCallEvent<'_>) -> Result<()> {
    let interrupt_state = event.agent().interrupt_state().clone();
    let responses = interrupt_state.resume_responses();
    if !responses.is_empty()
        && let Ok(manager) = shared.manager()
    {
        let waiting: Vec<BackgroundTask> = manager
            .list()
            .into_iter()
            .filter(|task| task.status == BackgroundTaskStatus::InputRequired)
            .collect();
        let task_interrupt_ids: Vec<String> = waiting
            .iter()
            .flat_map(|task| task.interrupts.iter().flatten().map(|interrupt| interrupt.id.clone()))
            .collect();
        for task in &waiting {
            let ids: Vec<&str> = task
                .interrupts
                .iter()
                .flatten()
                .map(|interrupt| interrupt.id.as_str())
                .collect();
            let answers: Vec<_> = responses
                .iter()
                .map(|content| content.interrupt_response.clone())
                .filter(|response| ids.contains(&response.interrupt_id.as_str()))
                .collect();
            if !answers.is_empty() {
                manager.resume(&task.task_id, &answers)?;
            }
        }
        if interrupt_state
            .interrupt_list()
            .iter()
            .all(|interrupt| task_interrupt_ids.contains(&interrupt.id))
        {
            interrupt_state.deactivate();
        }
    }
    let tasks = shared.snapshot();
    let interrupts: Vec<_> = tasks
        .iter()
        .filter(|task| task.status == BackgroundTaskStatus::InputRequired)
        .flat_map(|task| task.interrupts.clone().unwrap_or_default())
        .collect();
    if !interrupts.is_empty() {
        shared.raised_interrupt.store(true, Ordering::SeqCst);
        event.raise_interrupts(interrupts);
        return Ok(());
    }
    if let Some(input) = delivery(shared, &tasks) {
        event.add_continuation_input(input);
    }
    Ok(())
}

/// After an invocation: waits for running tasks (unless disabled), then delivers what finished or
/// re-enters the loop to surface the interrupts of tasks that need input.
async fn after_invocation(shared: Arc<Shared>, wait_for_completion: bool, event: &mut AfterInvocationEvent<'_>) {
    let raised_interrupt = shared.raised_interrupt.swap(false, Ordering::SeqCst);
    if raised_interrupt || event.agent().interrupt_state().activated() {
        return;
    }
    let signal = event.agent().cancel_signal();
    let mut tasks = shared.snapshot();
    let waiting_input = |tasks: &[BackgroundTask]| {
        tasks
            .iter()
            .any(|task| task.status == BackgroundTaskStatus::InputRequired)
    };
    let running = |tasks: &[BackgroundTask]| tasks.iter().any(|task| !task.status.is_terminal());
    while wait_for_completion && !signal.is_cancelled() && !waiting_input(&tasks) && running(&tasks) {
        await_next_settlement(&shared, &tasks, &signal).await;
        tasks = shared.snapshot();
    }
    if waiting_input(&tasks) {
        if event.resume().is_none() {
            event.set_resume(InvokeArgs::Messages(Vec::new()));
        }
        return;
    }
    // Delivering would start another pass; after a cancel the results wait for the next invocation.
    if signal.is_cancelled() || signal.is_deferred() {
        return;
    }
    if let Some(input) = delivery(&shared, &tasks) {
        event.add_continuation_input(input);
    }
}

/// Waits until one of `tasks` settles or the invocation is cancelled.
async fn await_next_settlement(shared: &Shared, tasks: &[BackgroundTask], signal: &CancelSignal) {
    let Ok(manager) = shared.manager() else {
        return;
    };
    let waits: Vec<BoxFuture<'_, ()>> = tasks
        .iter()
        .filter(|task| !task.status.is_terminal())
        .map(|task| -> BoxFuture<'_, ()> {
            Box::pin(async move {
                let _ = manager.wait(&task.task_id).await;
            })
        })
        .collect();
    if waits.is_empty() {
        return;
    }
    tokio::select! {
        () = signal.cancelled() => {}
        _ = futures::future::select_all(waits) => {}
    }
}

#[async_trait]
impl Plugin for BackgroundTasksPlugin {
    fn name(&self) -> &str {
        PLUGIN_NAME
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let plugin = self.0.clone();
        plugin.validate_registered_tools(agent.tool_registry())?;
        let shared = plugin.shared.clone();
        let _ = shared.app_state.set(agent.app_state().clone());
        let update_shared = shared.clone();
        let manager = Manager::new(ManagerOptions {
            max_concurrency: plugin.config.max_concurrency,
            timeout: plugin.config.timeout,
            on_task_updated: Some(Arc::new(move |task| update_shared.record(task))),
        })?;
        if shared.manager.set(manager).is_err() {
            return Err(Error::other("background tasks are already attached to an agent"));
        }
        let cancelling = plugin.clone();
        let interrupt_state = agent.interrupt_state().clone();
        agent
            .cancel_handle()
            .set_background_cancel(Arc::new(move || cancelling.cancel_all(&interrupt_state)));

        let selector = plugin.clone();
        agent.add_middleware(InvokeModelStage::input(move |mut context| {
            let selector = selector.clone();
            async move {
                let specs = std::mem::take(&mut context.tool_specs);
                context.tool_specs = selector.select_specs(context.agent.tool_registry(), specs)?;
                Ok(context)
            }
        }));
        let before_shared = shared.clone();
        agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| before_model_call(&before_shared, event));
        let after_shared = shared.clone();
        let wait_for_completion = plugin.config.wait_for_completion.unwrap_or(true);
        agent.add_async_hook::<AfterInvocationEvent<'_>>(move |event| {
            let shared = after_shared.clone();
            Box::pin(async move { after_invocation(shared, wait_for_completion, event).await })
        });
        let load_shared = shared;
        agent.add_hook_with(
            move |event: &mut InitializedEvent<'_>| {
                let agent = event.agent();
                load_app_state(&load_shared, agent.app_state(), agent.interrupt_state());
            },
            HookCallbackOptions {
                order: HookOrder::SDK_LAST,
            },
        );
        Ok(())
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        vec![
            ManageTool {
                shared: self.0.shared.clone(),
            }
            .into(),
        ]
    }
}

/// The plugin form of [`BackgroundTasks`]; the agent keeps the `Arc` to route tool calls.
pub(crate) struct BackgroundTasksPlugin(pub(crate) Arc<BackgroundTasks>);

/// The management tool (`strands_manage_background_task` unless renamed): lists, inspects or
/// cancels tasks.
struct ManageTool {
    shared: Arc<Shared>,
}

fn manage_spec(name: &str) -> ToolSpec {
    ToolSpec::new(name, MANAGE_TOOL_DESCRIPTION).with_input_schema(json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["list", "get", "cancel"],
                "description": "Whether to list, inspect, or cancel background tasks."
            },
            "taskId": {
                "type": "string",
                "minLength": 1,
                "description": "The background task ID returned when the task was dispatched. Required for get and cancel."
            }
        },
        "required": ["mode"],
        "additionalProperties": false
    }))
}

impl ManageTool {
    fn handle(&self, input: &JsonValue) -> Result<Vec<ToolResultContent>> {
        let mode = input.get("mode").and_then(JsonValue::as_str).unwrap_or_default();
        if !["list", "get", "cancel"].contains(&mode) {
            return Err(Error::other(format!(
                "mode must be one of 'list', 'get' or 'cancel', got {}",
                input.get("mode").cloned().unwrap_or(JsonValue::Null)
            )));
        }
        if mode == "list" {
            let tasks: Vec<JsonValue> = self
                .shared
                .snapshot()
                .iter()
                .map(|task| json!({"taskId": task.task_id, "toolName": task.tool_name, "status": task.status}))
                .collect();
            return Ok(vec![ToolResultContent::json(json!({"tasks": tasks}))]);
        }
        let Some(task_id) = input
            .get("taskId")
            .and_then(JsonValue::as_str)
            .filter(|id| !id.is_empty())
        else {
            return Err(Error::other(format!("Task ID is required for mode '{mode}'")));
        };
        let task = self
            .shared
            .tasks()
            .get(task_id)
            .cloned()
            .ok_or_else(|| not_found(task_id))?;
        if mode == "get" {
            return Ok(task_result_content(&task));
        }
        let cancelled = if task.status.is_terminal() {
            task
        } else {
            self.shared.manager()?.cancel(task_id)?
        };
        Ok(vec![ToolResultContent::json(
            json!({"taskId": cancelled.task_id, "status": cancelled.status}),
        )])
    }
}

impl Tool for ManageTool {
    fn name(&self) -> &str {
        &self.shared.manage_tool_name
    }

    fn description(&self) -> &str {
        MANAGE_TOOL_DESCRIPTION
    }

    fn tool_spec(&self) -> ToolSpec {
        manage_spec(&self.shared.manage_tool_name)
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let tool_use_id = context.tool_use().tool_use_id.clone();
        let outcome = match self.handle(&context.tool_use().input) {
            Ok(content) => ToolResultBlock::success(tool_use_id, content),
            Err(error) => crate::tools::create_error_result(error, tool_use_id),
        };
        ToolStream::ready(ToolOutcome::Result(outcome))
    }
}
