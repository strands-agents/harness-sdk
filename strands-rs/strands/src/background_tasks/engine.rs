//! Bounded in-process task execution.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use indexmap::{IndexMap, IndexSet};
use tokio::sync::Notify;
use tokio::task::{AbortHandle, JoinHandle};

use super::types::{BackgroundTaskStatus, TaskFailure, TaskFailureType, not_found};
use crate::cancel::{CancelHandle, CancelOptions, CancelSignal};
use crate::clock::iso_timestamp;
use crate::error::{Error, Result};
use crate::interrupt::InterruptStateData;
use crate::types::ToolResultBlock;

const DEFAULT_EXECUTION_FAILURE_MESSAGE: &str = "Background task execution failed";
/// The longest timeout accepted, in milliseconds (2^31 - 1).
pub(crate) const MAX_TIMER_DELAY_MS: u128 = (1 << 31) - 1;

/// One tracked task.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TaskRecord {
    pub(crate) task_id: String,
    pub(crate) tool_use_id: String,
    pub(crate) tool_name: String,
    pub(crate) invocation_state_id: String,
    pub(crate) status: BackgroundTaskStatus,
    pub(crate) state: Option<InterruptStateData>,
    pub(crate) result: Option<ToolResultBlock>,
    pub(crate) failure: Option<TaskFailure>,
    pub(crate) created_at: String,
    pub(crate) last_updated_at: String,
}

/// What a task admission names (`submit`'s argument).
#[derive(Debug, Clone)]
pub(crate) struct Admission {
    pub(crate) tool_use_id: String,
    pub(crate) tool_name: String,
    pub(crate) invocation_state_id: String,
}

/// What one execution gets.
#[derive(Debug, Clone)]
pub(crate) struct ExecutionContext {
    pub(crate) task_id: String,
    #[allow(
        dead_code,
        reason = "part of the task context; the manager keys executions by invocation state"
    )]
    pub(crate) tool_use_id: String,
    #[allow(
        dead_code,
        reason = "part of the task context; the manager keys executions by invocation state"
    )]
    pub(crate) tool_name: String,
    pub(crate) invocation_state_id: String,
    pub(crate) state: Option<InterruptStateData>,
    pub(crate) cancel_signal: CancelSignal,
}

/// How one execution ended.
#[derive(Debug, Clone)]
#[allow(
    clippy::large_enum_variant,
    reason = "one outcome per execution, moved straight into the record"
)]
pub(crate) enum ExecutionOutcome {
    Cancelled,
    Completed(ToolResultBlock),
    InputRequired(InterruptStateData),
    Failed {
        failure: TaskFailure,
        result: Option<ToolResultBlock>,
    },
}

pub(crate) type ExecuteFn = Arc<dyn Fn(ExecutionContext) -> BoxFuture<'static, Result<ExecutionOutcome>> + Send + Sync>;
pub(crate) type UpdateFn = Arc<dyn Fn(&TaskRecord) + Send + Sync>;

/// Options for [`Engine::new`].
pub(crate) struct EngineOptions {
    pub(crate) max_concurrency: usize,
    /// `None` disables timeouts.
    pub(crate) timeout: Option<Duration>,
    pub(crate) execute: ExecuteFn,
    pub(crate) on_task_updated: UpdateFn,
}

struct Active {
    cancel: CancelHandle,
    timeout: Option<JoinHandle<()>>,
    execution: Option<AbortHandle>,
}

#[derive(Default)]
struct State {
    tasks: IndexMap<String, TaskRecord>,
    queue: IndexSet<String>,
    active: HashMap<String, Active>,
}

struct Inner {
    max_concurrency: usize,
    timeout: Option<Duration>,
    execute: ExecuteFn,
    on_task_updated: UpdateFn,
    state: Mutex<State>,
    idle: Notify,
}

/// Runs tracked tasks on tokio tasks, at most `max_concurrency` at once. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Engine {
    inner: Arc<Inner>,
}

/// Checks a timeout: whole milliseconds, more than zero and at most [`MAX_TIMER_DELAY_MS`].
pub(crate) fn assert_timer_delay(name: &str, value: Duration) -> Result<()> {
    let millis = value.as_millis();
    if value.is_zero() || !value.subsec_nanos().is_multiple_of(1_000_000) {
        return Err(Error::other(format!(
            "{name} must be a positive finite integer, got {}",
            value.as_secs_f64() * 1000.0
        )));
    }
    if millis > MAX_TIMER_DELAY_MS {
        return Err(Error::other(format!(
            "{name} must be at most {MAX_TIMER_DELAY_MS}ms, got {millis}"
        )));
    }
    Ok(())
}

impl Engine {
    /// Creates an engine.
    ///
    /// # Errors
    ///
    /// A zero concurrency or a timeout [`assert_timer_delay`] rejects.
    pub(crate) fn new(options: EngineOptions) -> Result<Self> {
        if options.max_concurrency == 0 {
            return Err(Error::other(format!(
                "maxConcurrency must be a positive finite integer, got {}",
                options.max_concurrency
            )));
        }
        if let Some(timeout) = options.timeout {
            assert_timer_delay("timeout", timeout)?;
        }
        Ok(Self {
            inner: Arc::new(Inner {
                max_concurrency: options.max_concurrency,
                timeout: options.timeout,
                execute: options.execute,
                on_task_updated: options.on_task_updated,
                state: Mutex::new(State::default()),
                idle: Notify::new(),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Admits a task and queues it (`submit`).
    pub(crate) fn submit(&self, admission: Admission) -> TaskRecord {
        let now = iso_timestamp();
        let record = TaskRecord {
            task_id: uuid::Uuid::new_v4().to_string(),
            tool_use_id: admission.tool_use_id,
            tool_name: admission.tool_name,
            invocation_state_id: admission.invocation_state_id,
            status: BackgroundTaskStatus::Queued,
            state: None,
            result: None,
            failure: None,
            created_at: now.clone(),
            last_updated_at: now,
        };
        {
            let mut state = self.lock();
            state.tasks.insert(record.task_id.clone(), record.clone());
            (self.inner.on_task_updated)(&record);
        }
        self.schedule(&record.task_id);
        record
    }

    /// A copy of one task (`get`).
    pub(crate) fn get(&self, task_id: &str) -> Option<TaskRecord> {
        self.lock().tasks.get(task_id).cloned()
    }

    /// Copies of every tracked task (`list`).
    pub(crate) fn list(&self) -> Vec<TaskRecord> {
        self.lock().tasks.values().cloned().collect()
    }

    /// Removes a terminal task (`remove`).
    pub(crate) fn remove(&self, task_id: &str) -> Result<()> {
        let mut state = self.lock();
        let task = state.tasks.get(task_id).ok_or_else(|| not_found(task_id))?;
        if !task.status.is_terminal() {
            return Err(Error::other(format!(
                "Background task '{task_id}' cannot be removed before reaching a terminal status"
            )));
        }
        state.tasks.shift_remove(task_id);
        Ok(())
    }

    /// Cancels a task that has not finished and aborts its execution (`cancel`).
    ///
    /// The terminal check, the status change and the queue removal happen under one lock, so a
    /// task that finishes meanwhile keeps its outcome and is reported once.
    pub(crate) fn cancel(&self, task_id: &str, reason: &str) -> Result<TaskRecord> {
        let (task, active) = {
            let mut state = self.lock();
            let mut cancelled = None;
            let task = self.commit(&mut state, task_id, |record| {
                if record.status.is_terminal() {
                    cancelled = Some(record.clone());
                    return false;
                }
                record.status = BackgroundTaskStatus::Cancelled;
                record.state = None;
                true
            })?;
            let Some(task) = task else {
                return cancelled.ok_or_else(|| not_found(task_id));
            };
            state.queue.shift_remove(task_id);
            let active = state.active.get_mut(task_id).map(|active| {
                if let Some(timeout) = active.timeout.take() {
                    timeout.abort();
                }
                active.cancel.clone()
            });
            (task, active)
        };
        if let Some(cancel) = active {
            cancel.cancel(CancelOptions {
                message: Some(reason.to_owned()),
                ..CancelOptions::default()
            });
        }
        self.inner.idle.notify_waiters();
        Ok(task)
    }

    fn is_idle(&self) -> bool {
        let state = self.lock();
        state.queue.is_empty() && state.active.is_empty()
    }

    /// Waits until no task is queued or running. Tasks that require input do not
    /// count.
    pub(crate) async fn wait_for_idle(&self) {
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_idle() {
                return;
            }
            notified.await;
        }
    }

    /// Applies interrupt responses to a task that requires input and queues it once ready
    /// (`resume`).
    pub(crate) fn resume(
        &self,
        task_id: &str,
        update: impl FnOnce(InterruptStateData) -> Result<(InterruptStateData, bool)>,
    ) -> Result<TaskRecord> {
        let mut failure = None;
        let mut update = Some(update);
        let task = self.update(task_id, |record| {
            if record.status != BackgroundTaskStatus::InputRequired {
                failure = Some(Error::other(format!(
                    "Background task '{task_id}' cannot be resumed: status is '{}', not 'input_required'",
                    record.status.as_str()
                )));
                return false;
            }
            let Some(state) = record.state.take() else {
                failure = Some(Error::other(format!(
                    "Background task '{task_id}' cannot be resumed: interrupt state is missing"
                )));
                return false;
            };
            let Some(update) = update.take() else {
                return false;
            };
            match update(state) {
                Ok((state, ready)) => {
                    record.state = Some(state);
                    if ready {
                        record.status = BackgroundTaskStatus::Queued;
                    }
                    true
                }
                Err(error) => {
                    failure = Some(error);
                    false
                }
            }
        })?;
        if let Some(error) = failure {
            return Err(error);
        }
        let task = task.ok_or_else(|| not_found(task_id))?;
        if task.status == BackgroundTaskStatus::Queued {
            self.schedule(task_id);
        }
        Ok(task)
    }

    fn schedule(&self, task_id: &str) {
        {
            let mut state = self.lock();
            if state.active.contains_key(task_id) {
                return;
            }
            state.queue.insert(task_id.to_owned());
        }
        self.start_queued();
    }

    fn start_queued(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        while let Some((working, cancel)) = self.start_next() {
            let finish = FinishGuard {
                engine: self.clone(),
                task_id: working.task_id.clone(),
            };
            let task_id = working.task_id.clone();
            let execution = runtime.spawn(async move {
                let engine = finish.engine.clone();
                engine.execute(working, cancel).await;
                drop(finish);
            });
            if let Some(active) = self.lock().active.get_mut(&task_id) {
                active.execution = Some(execution.abort_handle());
            }
        }
    }

    /// Cancels every task that has not finished and aborts the running executions, so no tool
    /// call outlives the agent. The engine stays usable.
    pub(crate) fn shutdown(&self, reason: &str) {
        let pending: Vec<String> = self
            .lock()
            .tasks
            .values()
            .filter(|task| !task.status.is_terminal())
            .map(|task| task.task_id.clone())
            .collect();
        for task_id in pending {
            let _ = self.cancel(&task_id, reason);
        }
        let executions: Vec<AbortHandle> = self
            .lock()
            .active
            .values_mut()
            .filter_map(|active| active.execution.take())
            .collect();
        for execution in executions {
            execution.abort();
        }
    }

    /// Moves the next queued task to `working` and arms its timeout before its execution starts.
    /// Queue entries whose task left `queued` meanwhile are skipped.
    fn start_next(&self) -> Option<(TaskRecord, CancelHandle)> {
        let mut state = self.lock();
        if state.active.len() >= self.inner.max_concurrency {
            return None;
        }
        let (task_id, working) = loop {
            let task_id = state.queue.shift_remove_index(0)?;
            let Some(task) = state.tasks.get_mut(&task_id) else {
                continue;
            };
            if task.status != BackgroundTaskStatus::Queued {
                continue;
            }
            task.status = BackgroundTaskStatus::Working;
            task.last_updated_at = iso_timestamp();
            break (task_id, task.clone());
        };
        (self.inner.on_task_updated)(&working);
        let cancel = CancelHandle::new();
        let timeout = self.inner.timeout.map(|timeout| {
            let engine = self.clone();
            let id = task_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                engine.time_out(&id, timeout);
            })
        });
        state.active.insert(
            task_id,
            Active {
                cancel: cancel.clone(),
                timeout,
                execution: None,
            },
        );
        Some((working, cancel))
    }

    fn finish_execution(&self, task_id: &str) {
        {
            let mut state = self.lock();
            if let Some(active) = state.active.remove(task_id)
                && let Some(timeout) = active.timeout
            {
                timeout.abort();
            }
            if state
                .tasks
                .get(task_id)
                .is_some_and(|task| task.status == BackgroundTaskStatus::Queued)
            {
                state.queue.insert(task_id.to_owned());
            }
        }
        self.inner.idle.notify_waiters();
        self.start_queued();
    }

    async fn execute(&self, working: TaskRecord, cancel: CancelHandle) {
        let task_id = working.task_id.clone();
        let context = ExecutionContext {
            task_id: task_id.clone(),
            tool_use_id: working.tool_use_id,
            tool_name: working.tool_name,
            invocation_state_id: working.invocation_state_id,
            state: working.state,
            cancel_signal: cancel.signal(),
        };
        let execution = AssertUnwindSafe((self.inner.execute)(context)).catch_unwind().await;
        let outcome = match execution {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => execution_failure(error.to_string()),
            Err(payload) => {
                tracing::warn!("task_id=<{task_id}> | background task execution panicked");
                execution_failure(panic_message(payload.as_ref()))
            }
        };
        self.finish_outcome(&task_id, outcome);
    }

    /// Records an execution's outcome unless the task left `working` meanwhile.
    fn finish_outcome(&self, task_id: &str, outcome: ExecutionOutcome) {
        let _ = self.update(task_id, |record| {
            if record.status != BackgroundTaskStatus::Working {
                return false;
            }
            match outcome {
                ExecutionOutcome::InputRequired(state) => {
                    record.status = BackgroundTaskStatus::InputRequired;
                    record.state = Some(state);
                }
                ExecutionOutcome::Cancelled => {
                    record.status = BackgroundTaskStatus::Cancelled;
                    record.state = None;
                }
                ExecutionOutcome::Failed { failure, result } => {
                    record.status = BackgroundTaskStatus::Failed;
                    record.state = None;
                    let message = if failure.message.is_empty() {
                        DEFAULT_EXECUTION_FAILURE_MESSAGE.to_owned()
                    } else {
                        failure.message
                    };
                    record.failure = Some(TaskFailure::new(failure.failure_type, message));
                    if result.is_some() {
                        record.result = result;
                    }
                }
                ExecutionOutcome::Completed(result) => {
                    record.status = BackgroundTaskStatus::Completed;
                    record.state = None;
                    record.result = Some(result);
                }
            }
            true
        });
    }

    fn time_out(&self, task_id: &str, timeout: Duration) {
        let reason = format!("Timed out after {}ms", timeout.as_millis());
        let cancel = {
            let mut state = self.lock();
            let task = self.commit(&mut state, task_id, |record| {
                if record.status != BackgroundTaskStatus::Working {
                    return false;
                }
                record.status = BackgroundTaskStatus::Failed;
                record.state = None;
                record.failure = Some(TaskFailure::new(TaskFailureType::Timeout, reason.clone()));
                true
            });
            if !matches!(task, Ok(Some(_))) {
                return;
            }
            state.active.get(task_id).map(|active| active.cancel.clone())
        };
        if let Some(cancel) = cancel {
            cancel.cancel(CancelOptions {
                message: Some(reason),
                ..CancelOptions::default()
            });
        }
    }

    /// Applies `update` to a copy of the task and commits it with a fresh `lastUpdatedAt` when
    /// `update` returns `true`.
    fn update(&self, task_id: &str, update: impl FnOnce(&mut TaskRecord) -> bool) -> Result<Option<TaskRecord>> {
        let mut state = self.lock();
        self.commit(&mut state, task_id, update)
    }

    /// [`update`](Self::update) under a held lock. `on_task_updated` runs before the lock is
    /// released, so callbacks see changes in commit order and a reader that sees a change sees
    /// its callback done. Callbacks must not call back into the engine.
    fn commit(
        &self,
        state: &mut State,
        task_id: &str,
        update: impl FnOnce(&mut TaskRecord) -> bool,
    ) -> Result<Option<TaskRecord>> {
        let current = state.tasks.get(task_id).ok_or_else(|| not_found(task_id))?;
        let mut next = current.clone();
        if !update(&mut next) {
            return Ok(None);
        }
        next.last_updated_at = iso_timestamp();
        state.tasks.insert(task_id.to_owned(), next.clone());
        (self.inner.on_task_updated)(&next);
        Ok(Some(next))
    }
}

/// Ends an execution when its tokio task finishes or is dropped (`_execute(..).finally`), so a
/// task aborted with its runtime still frees its slot and wakes idle waiters.
struct FinishGuard {
    engine: Engine,
    task_id: String,
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        self.engine.finish_execution(&self.task_id);
    }
}

fn execution_failure(message: String) -> ExecutionOutcome {
    ExecutionOutcome::Failed {
        failure: TaskFailure::new(
            TaskFailureType::ExecutionError,
            if message.is_empty() {
                DEFAULT_EXECUTION_FAILURE_MESSAGE.to_owned()
            } else {
                message
            },
        ),
        result: None,
    }
}

/// The message of a panic payload, or the default failure text.
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_default()
}
