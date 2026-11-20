//! Approved tool calls as in-process background tasks.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::future::BoxFuture;
use indexmap::IndexMap;
use tokio::sync::Notify;

use super::engine::{
    Admission, Engine, EngineOptions, ExecutionContext, ExecutionOutcome, TaskRecord, assert_timer_delay,
};
use super::types::{
    BackgroundTask, BackgroundTaskStatus, BackgroundTaskTimeoutError, TaskFailure, TaskFailureType, TaskResult,
    not_found,
};
use crate::agent::InvocationState;
use crate::cancel::CancelSignal;
use crate::error::{Error, Result};
use crate::interrupt::{Interrupt, InterruptError, InterruptSource, InterruptState};
use crate::middleware::middleware_interrupt;
use crate::tools::{InterruptFn, Tool};
use crate::types::{
    InterruptParams, InterruptResponse, InterruptResponseContent, ToolResultBlock, ToolResultContent, ToolResultStatus,
    ToolUse,
};

/// One background run of a tool, with the interrupts its task owns.
pub(crate) struct ToolRun {
    pub(crate) tool: Arc<dyn Tool>,
    pub(crate) tool_use: ToolUse,
    pub(crate) invocation_state: InvocationState,
    pub(crate) cancel_signal: CancelSignal,
    pub(crate) tool_interrupt: InterruptFn,
    pub(crate) middleware_interrupt: InterruptFn,
}

/// Why a background run did not produce a result.
#[derive(Debug)]
pub(crate) enum RunFailure {
    Interrupts(Vec<Interrupt>),
    Error(Error),
}

/// Runs a tool call through the agent's per-tool pipeline.
pub(crate) type RunFn =
    Arc<dyn Fn(ToolRun) -> BoxFuture<'static, std::result::Result<ToolResultBlock, RunFailure>> + Send + Sync>;

/// Receives every committed task change.
pub(crate) type TaskUpdatedFn = Arc<dyn Fn(BackgroundTask) + Send + Sync>;

struct LiveExecution {
    tool_use: ToolUse,
    invocation_state: InvocationState,
    tool: Arc<dyn Tool>,
    run: RunFn,
}

/// Options for [`Manager::new`].
pub(crate) struct ManagerOptions {
    pub(crate) max_concurrency: Option<usize>,
    pub(crate) timeout: Option<Duration>,
    pub(crate) on_task_updated: Option<TaskUpdatedFn>,
}

type Executions = Arc<Mutex<HashMap<String, LiveExecution>>>;

/// Tracks background tasks and runs them on an [`Engine`].
#[derive(Clone)]
pub(crate) struct Manager {
    engine: Engine,
    executions: Executions,
    submissions: Arc<Mutex<IndexMap<(String, String), String>>>,
    changed: Arc<Notify>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Manager {
    /// Creates a manager; at most four tasks run at once by default, without a timeout.
    ///
    /// # Errors
    ///
    /// An invalid concurrency or timeout.
    pub(crate) fn new(options: ManagerOptions) -> Result<Self> {
        let executions: Executions = Arc::default();
        let changed = Arc::new(Notify::new());
        let execute_executions = executions.clone();
        let update_executions = executions.clone();
        let update_changed = changed.clone();
        let on_task_updated = options.on_task_updated;
        let engine = Engine::new(EngineOptions {
            max_concurrency: options.max_concurrency.unwrap_or(4),
            timeout: options.timeout,
            execute: Arc::new(move |context| {
                let executions = execute_executions.clone();
                Box::pin(async move { execute_tool_task(&executions, context).await })
            }),
            on_task_updated: Arc::new(move |record: &TaskRecord| {
                if record.status.is_terminal() {
                    lock(&update_executions).remove(&record.invocation_state_id);
                }
                if record.status == BackgroundTaskStatus::InputRequired || record.status.is_terminal() {
                    update_changed.notify_waiters();
                }
                if let Some(callback) = &on_task_updated {
                    callback(to_background_task(record));
                }
            }),
        })?;
        Ok(Self {
            engine,
            executions,
            submissions: Arc::default(),
            changed,
        })
    }

    /// Submits an approved tool call (`submit`). Submitting the same tool use of the same pass
    /// again returns the existing task.
    pub(crate) fn submit(
        &self,
        tool_use: ToolUse,
        invocation_state: InvocationState,
        pass_id: &str,
        tool: Arc<dyn Tool>,
        run: RunFn,
    ) -> BackgroundTask {
        let key = (pass_id.to_owned(), tool_use.tool_use_id.clone());
        let existing = lock(&self.submissions).get(&key).cloned();
        if let Some(task) = existing.and_then(|task_id| self.engine.get(&task_id)) {
            return to_background_task(&task);
        }
        let invocation_state_id = uuid::Uuid::new_v4().to_string();
        let admission = Admission {
            tool_use_id: tool_use.tool_use_id.clone(),
            tool_name: tool_use.name.clone(),
            invocation_state_id: invocation_state_id.clone(),
        };
        lock(&self.executions).insert(
            invocation_state_id,
            LiveExecution {
                tool_use,
                invocation_state,
                tool,
                run,
            },
        );
        let record = self.engine.submit(admission);
        lock(&self.submissions).insert(key, record.task_id.clone());
        to_background_task(&record)
    }

    /// One task (`get`).
    #[cfg_attr(not(test), allow(dead_code, reason = "the plugin reads its own task snapshots"))]
    pub(crate) fn get(&self, task_id: &str) -> Option<BackgroundTask> {
        self.engine.get(task_id).as_ref().map(to_background_task)
    }

    /// Every tracked task (`list`).
    pub(crate) fn list(&self) -> Vec<BackgroundTask> {
        self.engine.list().iter().map(to_background_task).collect()
    }

    /// Whether any task is tracked, terminal ones included.
    pub(crate) fn has_tasks(&self) -> bool {
        !lock(&self.submissions).is_empty()
    }

    /// Requests cancellation of a task (`cancel`).
    pub(crate) fn cancel(&self, task_id: &str) -> Result<BackgroundTask> {
        self.engine
            .cancel(task_id, "Cancellation requested")
            .map(|record| to_background_task(&record))
    }

    /// Cancels every unfinished task and aborts the running executions.
    pub(crate) fn shutdown(&self) {
        self.engine.shutdown("Agent shut down");
    }

    /// Waits until the task requires input or ends (`wait`).
    pub(crate) async fn wait(&self, task_id: &str) -> Result<BackgroundTask> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let current = self.engine.get(task_id).ok_or_else(|| not_found(task_id))?;
            if current.status == BackgroundTaskStatus::InputRequired || current.status.is_terminal() {
                return Ok(to_background_task(&current));
            }
            notified.await;
        }
    }

    /// Waits until no task is queued or running.
    #[allow(
        dead_code,
        reason = "no caller waits on the whole manager yet; the plugin waits per task"
    )]
    pub(crate) async fn wait_for_idle(&self, timeout: Option<Duration>) -> Result<()> {
        let Some(timeout) = timeout else {
            self.engine.wait_for_idle().await;
            return Ok(());
        };
        assert_timer_delay("wait timeout", timeout)?;
        tokio::time::timeout(timeout, self.engine.wait_for_idle())
            .await
            .map_err(|_| Error::other(BackgroundTaskTimeoutError(timeout.as_millis())))
    }

    /// Applies interrupt responses to a task that requires input (`resume`).
    pub(crate) fn resume(&self, task_id: &str, responses: &[InterruptResponse]) -> Result<BackgroundTask> {
        let contents: Vec<InterruptResponseContent> =
            responses.iter().cloned().map(InterruptResponseContent::new).collect();
        self.engine
            .resume(task_id, |state| {
                let task_state = InterruptState::new();
                task_state.load_data(state);
                task_state.resume(&contents)?;
                let ready = task_state.unanswered_interrupts().is_empty();
                Ok((task_state.to_data(), ready))
            })
            .map(|record| to_background_task(&record))
    }

    /// Removes terminal tasks (`remove`); nothing is removed when one of them is not terminal.
    pub(crate) fn remove(&self, task_ids: &[String]) -> Result<()> {
        for task_id in task_ids {
            let task = self.engine.get(task_id).ok_or_else(|| not_found(task_id))?;
            if !task.status.is_terminal() {
                return Err(Error::other(format!(
                    "Background task '{task_id}' cannot be removed before reaching a terminal status"
                )));
            }
        }
        for task_id in task_ids {
            if self.engine.get(task_id).is_some() {
                self.engine.remove(task_id)?;
            }
        }
        lock(&self.submissions).retain(|_, task_id| !task_ids.contains(task_id));
        Ok(())
    }
}

async fn execute_tool_task(executions: &Executions, context: ExecutionContext) -> Result<ExecutionOutcome> {
    let execution = lock(executions).get(&context.invocation_state_id).map(|execution| {
        (
            execution.tool_use.clone(),
            execution.invocation_state.clone(),
            execution.tool.clone(),
            execution.run.clone(),
        )
    });
    let Some((tool_use, invocation_state, tool, run)) = execution else {
        return Err(Error::other("Background task live execution state is unavailable"));
    };
    let state = InterruptState::new();
    if let Some(data) = context.state {
        state.load_data(data);
    }
    let task_id = context.task_id.clone();
    let tool_state = state.clone();
    let tool_interrupt: InterruptFn = Arc::new(move |params: &InterruptParams| {
        tool_state.raise(
            &format!("tool:{task_id}:{}", params.name),
            params,
            InterruptSource::Tool,
        )
    });
    let outcome = run(ToolRun {
        tool,
        tool_use,
        invocation_state,
        cancel_signal: context.cancel_signal.clone(),
        tool_interrupt,
        middleware_interrupt: middleware_interrupt(state.clone(), format!("middleware:{}", context.task_id), None),
    })
    .await;
    match outcome {
        Ok(result) => Ok(tool_task_outcome(result, &context.cancel_signal)),
        Err(RunFailure::Error(error)) => Err(error),
        Err(RunFailure::Interrupts(interrupts)) => {
            let owned = !interrupts.is_empty()
                && interrupts.iter().all(|interrupt| {
                    let prefix = match interrupt.source {
                        InterruptSource::Middleware => "middleware",
                        InterruptSource::Tool => "tool",
                        _ => return false,
                    };
                    interrupt.id.starts_with(&format!("{prefix}:{}:", context.task_id))
                });
            if !owned {
                return Err(Error::other(InterruptError::new(interrupts)));
            }
            for interrupt in &interrupts {
                state.register_interrupt(interrupt);
            }
            state.activate();
            Ok(ExecutionOutcome::InputRequired(state.to_data()))
        }
    }
}

/// Classifies a tool result. A tool reports an abort as an error result
/// returned after its cancel signal fired.
fn tool_task_outcome(result: ToolResultBlock, cancel_signal: &CancelSignal) -> ExecutionOutcome {
    if result.status == ToolResultStatus::Success {
        return ExecutionOutcome::Completed(result);
    }
    if cancel_signal.is_cancelled() {
        return ExecutionOutcome::Cancelled;
    }
    let message = result
        .error
        .as_ref()
        .map(ToString::to_string)
        .or_else(|| {
            result.content.iter().find_map(|content| match content {
                ToolResultContent::Text(text) => Some(text.text.clone()),
                _ => None,
            })
        })
        .unwrap_or_else(|| "Tool returned an error without a message".to_owned());
    ExecutionOutcome::Failed {
        failure: TaskFailure::new(TaskFailureType::ToolError, message),
        result: Some(result),
    }
}

/// The public snapshot of a record.
pub(crate) fn to_background_task(record: &TaskRecord) -> BackgroundTask {
    let interrupts = record
        .state
        .clone()
        .map(|data| {
            let state = InterruptState::new();
            state.load_data(data);
            state.unanswered_interrupts()
        })
        .filter(|interrupts| !interrupts.is_empty());
    BackgroundTask {
        task_id: record.task_id.clone(),
        tool_use_id: record.tool_use_id.clone(),
        tool_name: record.tool_name.clone(),
        status: record.status,
        created_at: record.created_at.clone(),
        last_updated_at: record.last_updated_at.clone(),
        result: record.result.as_ref().map(|result| TaskResult {
            content: result.content.clone(),
        }),
        error: record.failure.clone(),
        interrupts,
    }
}
