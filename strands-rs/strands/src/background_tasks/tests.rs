use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::BackgroundTasksConfig;
use super::engine::{Admission, Engine, EngineOptions, ExecuteFn, ExecutionOutcome, TaskRecord};
use super::manager::{Manager, ManagerOptions, RunFailure, RunFn, ToolRun};
use super::plugin::{BACKGROUND_TASKS_STATE_KEY, MANAGE_TOOL_NAME};
use super::types::{BackgroundTask, BackgroundTaskStatus, TaskFailure, TaskFailureType};
use crate::agent::{Agent, AgentConfig, DirectToolCallOptions, InvocationState, InvokeArgs};
use crate::cancel::CancelOptions;
use crate::hooks::{
    AfterInvocationEvent, AfterToolCallEvent, BeforeModelCallEvent, BeforeToolCallEvent, InitializedEvent,
};
use crate::interrupt::{Interrupt, InterruptSource, InterruptStateData};
use crate::middleware::{ExecuteToolStage, InvokeModelStage, StageStream};
use crate::testing::{MockModel, MockTurn};
use crate::tools::{FunctionTool, Tool, ToolContext, ToolOutcome, ToolStreamItem};
use crate::types::{
    ContentBlock, ImageBlock, ImageFormat, ImageSource, InterruptParams, InterruptResponse, InterruptResponseContent,
    Message, StopReason, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolSpec, ToolUse, ToolUseBlock,
};

// --- engine fixtures ----------------------------------------------------------------------------

/// A one-shot outcome an execution waits for (`deferred`).
#[derive(Clone, Default)]
struct Gate {
    outcome: Arc<Mutex<Option<ExecutionOutcome>>>,
    notify: Arc<Notify>,
}

impl Gate {
    fn release(&self, outcome: ExecutionOutcome) {
        *self.outcome.lock().unwrap() = Some(outcome);
        self.notify.notify_waiters();
        self.notify.notify_one();
    }

    async fn wait(&self) -> ExecutionOutcome {
        loop {
            let notified = self.notify.notified();
            if let Some(outcome) = self.outcome.lock().unwrap().take() {
                return outcome;
            }
            notified.await;
        }
    }
}

fn result(value: &str) -> ToolResultBlock {
    ToolResultBlock::success(value, vec![ToolResultContent::text(value)])
}

fn interrupt_state(value: &str) -> InterruptStateData {
    serde_json::from_value(json!({"interrupts": {value: {"id": value, "name": value}}, "activated": true})).unwrap()
}

fn state_value(state: &InterruptStateData) -> String {
    state.interrupts.keys().next().unwrap().clone()
}

fn admission(value: &str) -> Admission {
    Admission {
        tool_use_id: value.to_owned(),
        tool_name: value.to_owned(),
        invocation_state_id: value.to_owned(),
    }
}

type Updates = Arc<Mutex<Vec<BackgroundTaskStatus>>>;

fn engine_with(
    execute: impl Fn(
        super::engine::ExecutionContext,
    ) -> futures::future::BoxFuture<'static, crate::Result<ExecutionOutcome>>
    + Send
    + Sync
    + 'static,
    max_concurrency: usize,
    timeout: Option<Duration>,
) -> (Engine, Updates) {
    let updates = Updates::default();
    let recorded = updates.clone();
    let engine = Engine::new(EngineOptions {
        max_concurrency,
        timeout,
        execute: Arc::new(execute) as ExecuteFn,
        on_task_updated: Arc::new(move |task: &TaskRecord| recorded.lock().unwrap().push(task.status)),
    })
    .unwrap();
    (engine, updates)
}

fn statuses(updates: &Updates) -> Vec<&'static str> {
    updates.lock().unwrap().iter().map(|status| status.as_str()).collect()
}

fn gated_engine(gate: &Gate, max_concurrency: usize, timeout: Option<Duration>) -> (Engine, Updates) {
    let gate = gate.clone();
    engine_with(
        move |_| {
            let gate = gate.clone();
            Box::pin(async move { Ok(gate.wait().await) })
        },
        max_concurrency,
        timeout,
    )
}

// --- engine: waiting and transitions ------------------------------------------------------------

#[tokio::test]
async fn cancels_idle_observation_without_cancelling_work() {
    let gate = Gate::default();
    let (engine, _) = gated_engine(&gate, 2, Some(Duration::from_secs(1)));
    let task = engine.submit(admission("work"));
    let waited = tokio::time::timeout(Duration::from_millis(1), engine.wait_for_idle()).await;
    assert!(waited.is_err());
    assert_eq!(engine.get(&task.task_id).unwrap().status, BackgroundTaskStatus::Working);
    gate.release(ExecutionOutcome::Completed(result("done")));
    engine.wait_for_idle().await;
}

#[tokio::test]
async fn requires_input_updates_state_and_resumes_execution() {
    let (engine, _) = engine_with(
        |context| {
            Box::pin(async move {
                Ok(match context.state {
                    Some(state) => ExecutionOutcome::Completed(result(&state_value(&state))),
                    None => ExecutionOutcome::InputRequired(interrupt_state("waiting")),
                })
            })
        },
        2,
        None,
    );
    let task = engine.submit(admission("work"));
    engine.wait_for_idle().await;
    let waiting = engine.get(&task.task_id).unwrap();
    assert_eq!(waiting.status, BackgroundTaskStatus::InputRequired);
    assert_eq!(waiting.state, Some(interrupt_state("waiting")));
    let still = engine
        .resume(&task.task_id, |_| Ok((interrupt_state("still waiting"), false)))
        .unwrap();
    assert_eq!(still.status, BackgroundTaskStatus::InputRequired);
    assert_eq!(still.state, Some(interrupt_state("still waiting")));
    engine.resume(&task.task_id, |state| Ok((state, true))).unwrap();
    engine.wait_for_idle().await;
    let completed = engine.get(&task.task_id).unwrap();
    assert_eq!(completed.status, BackgroundTaskStatus::Completed);
    assert_eq!(completed.result, Some(result("still waiting")));
    assert_eq!(completed.created_at, task.created_at);
}

#[tokio::test]
async fn cancels_running_work_and_removes_it_before_execution_settles() {
    let gate = Gate::default();
    let signal = Arc::new(Mutex::new(None));
    let seen = signal.clone();
    let wait_gate = gate.clone();
    let (engine, _) = engine_with(
        move |context| {
            *seen.lock().unwrap() = Some(context.cancel_signal);
            let gate = wait_gate.clone();
            Box::pin(async move { Ok(gate.wait().await) })
        },
        2,
        None,
    );
    let task = engine.submit(admission("work"));
    tokio::task::yield_now().await;
    assert_eq!(
        engine.cancel(&task.task_id, "Stop work").unwrap().status,
        BackgroundTaskStatus::Cancelled
    );
    let signal = signal.lock().unwrap().clone().unwrap();
    assert_eq!(signal.reason().as_deref(), Some("Stop work"));
    engine.remove(&task.task_id).unwrap();
    assert!(engine.get(&task.task_id).is_none());
    assert_eq!(
        engine.cancel(&task.task_id, "Again").unwrap_err().to_string(),
        format!("Background task '{}' was not found", task.task_id)
    );
    gate.release(ExecutionOutcome::Completed(result("late")));
    engine.wait_for_idle().await;
}

async fn preserve(action: &str) {
    let gate = Gate::default();
    let timeout = (action == "timeout").then(|| Duration::from_millis(10));
    let aborted = Arc::new(Notify::new());
    let on_abort = aborted.clone();
    let wait_gate = gate.clone();
    let (engine, updates) = engine_with(
        move |context| {
            let gate = wait_gate.clone();
            let on_abort = on_abort.clone();
            Box::pin(async move {
                tokio::spawn(async move {
                    context.cancel_signal.cancelled().await;
                    on_abort.notify_one();
                });
                Ok(gate.wait().await)
            })
        },
        2,
        timeout,
    );
    let task = engine.submit(admission("work"));
    if action == "timeout" {
        aborted.notified().await;
    } else {
        engine.cancel(&task.task_id, "Stop work").unwrap();
    }
    let terminal = engine.get(&task.task_id);
    if action == "remove" {
        engine.remove(&task.task_id).unwrap();
    }
    gate.release(ExecutionOutcome::Cancelled);
    engine.wait_for_idle().await;
    let expected = if action == "remove" { None } else { terminal };
    assert_eq!(engine.get(&task.task_id), expected);
    let last = if action == "timeout" { "failed" } else { "cancelled" };
    assert_eq!(statuses(&updates), ["queued", "working", last]);
}

#[tokio::test(start_paused = true)]
async fn preserves_action_when_execution_later_returns_cancelled() {
    for action in ["cancel", "timeout", "remove"] {
        preserve(action).await;
    }
}

#[tokio::test]
async fn settles_a_resumed_execution_as_cancelled_and_clears_interrupt_state() {
    let (engine, updates) = engine_with(
        |context| {
            Box::pin(async move {
                Ok(match context.state {
                    Some(_) => ExecutionOutcome::Cancelled,
                    None => ExecutionOutcome::InputRequired(interrupt_state("waiting")),
                })
            })
        },
        2,
        None,
    );
    let task = engine.submit(admission("work"));
    engine.wait_for_idle().await;
    engine.resume(&task.task_id, |state| Ok((state, true))).unwrap();
    engine.wait_for_idle().await;
    let cancelled = engine.get(&task.task_id).unwrap();
    assert_eq!(cancelled.status, BackgroundTaskStatus::Cancelled);
    assert_eq!(cancelled.state, None);
    assert_eq!(
        statuses(&updates),
        ["queued", "working", "input_required", "queued", "working", "cancelled"]
    );
}

#[tokio::test]
async fn cancels_queued_work_without_executing_it() {
    let gate = Gate::default();
    let executions = Arc::new(Mutex::new(Vec::new()));
    let seen = executions.clone();
    let wait_gate = gate.clone();
    let (engine, _) = engine_with(
        move |context| {
            seen.lock().unwrap().push(context.tool_name);
            let gate = wait_gate.clone();
            Box::pin(async move { Ok(gate.wait().await) })
        },
        1,
        None,
    );
    engine.submit(admission("running"));
    let queued = engine.submit(admission("queued"));
    assert_eq!(
        engine.cancel(&queued.task_id, "No longer needed").unwrap().status,
        BackgroundTaskStatus::Cancelled
    );
    gate.release(ExecutionOutcome::Completed(result("done")));
    engine.wait_for_idle().await;
    assert_eq!(*executions.lock().unwrap(), ["running"]);
}

#[test]
fn rejects_invalid_execution_configuration() {
    let build = |max_concurrency: usize, timeout: Option<Duration>| {
        Engine::new(EngineOptions {
            max_concurrency,
            timeout,
            execute: Arc::new(|_| Box::pin(async { Ok(ExecutionOutcome::Cancelled) })),
            on_task_updated: Arc::new(|_: &TaskRecord| {}),
        })
    };
    let error = |result: crate::Result<Engine>| result.err().unwrap().to_string();
    assert!(error(build(0, None)).starts_with("maxConcurrency must be a positive"));
    assert!(error(build(2, Some(Duration::ZERO))).starts_with("timeout must be a positive"));
    assert!(build(2, Some(Duration::from_millis((1 << 31) - 1))).is_ok());
    assert!(error(build(2, Some(Duration::from_millis(1 << 31)))).starts_with("timeout must be at most"));
}

// --- engine: admission and execution ------------------------------------------------------------

#[tokio::test]
async fn prevents_task_update_callbacks_from_mutating_engine_owned_state() {
    let (engine, updates) = engine_with(
        |context| Box::pin(async move { Ok(ExecutionOutcome::Completed(result(&context.tool_name.to_uppercase()))) }),
        2,
        None,
    );
    let mut admitted = engine.submit(admission("hello"));
    admitted.status = BackgroundTaskStatus::Cancelled;
    engine.wait_for_idle().await;
    let mut completed = engine.get(&admitted.task_id).unwrap();
    assert_eq!(completed.status, BackgroundTaskStatus::Completed);
    assert_eq!(completed.result, Some(result("HELLO")));
    assert_eq!(engine.list(), [completed.clone()]);
    assert_eq!(statuses(&updates), ["queued", "working", "completed"]);
    completed.status = BackgroundTaskStatus::Cancelled;
    assert_eq!(
        engine.get(&admitted.task_id).unwrap().status,
        BackgroundTaskStatus::Completed
    );
    engine.remove(&admitted.task_id).unwrap();
    assert!(engine.list().is_empty());
}

/// Rust-only: the terminal check, the change and its callback happen under
/// one lock, so a cancel racing a completion reports one terminal status, and callbacks arrive in
/// commit order.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancel_racing_completion_reports_one_terminal_status_in_commit_order() {
    for _ in 0..200 {
        let gate = Gate::default();
        let (engine, updates) = gated_engine(&gate, 1, None);
        let task = engine.submit(admission("race"));
        assert_eq!(engine.get(&task.task_id).unwrap().status, BackgroundTaskStatus::Working);
        let release = gate.clone();
        let releaser = tokio::spawn(async move { release.release(ExecutionOutcome::Completed(result("done"))) });
        let returned = engine.cancel(&task.task_id, "stop").unwrap();
        releaser.await.unwrap();
        engine.wait_for_idle().await;

        let seen = statuses(&updates);
        let terminal: Vec<&str> = seen
            .iter()
            .copied()
            .filter(|status| matches!(*status, "completed" | "cancelled"))
            .collect();
        let stored = engine.get(&task.task_id).unwrap().status.as_str();
        assert_eq!(terminal, [stored], "{seen:?}");
        assert_eq!(seen.last().copied(), Some(stored), "{seen:?}");
        assert_eq!(returned.status.as_str(), stored);
    }
}

#[tokio::test]
async fn cancelling_a_finished_task_returns_it_unchanged_without_a_notification() {
    let (engine, updates) = engine_with(
        |_| Box::pin(async { Ok(ExecutionOutcome::Completed(result("done"))) }),
        1,
        None,
    );
    let task = engine.submit(admission("done"));
    engine.wait_for_idle().await;

    let returned = engine.cancel(&task.task_id, "stop").unwrap();

    assert_eq!(returned.status, BackgroundTaskStatus::Completed);
    assert_eq!(statuses(&updates), ["queued", "working", "completed"]);
}

#[tokio::test]
async fn a_panicking_execution_fails_its_task_and_frees_its_slot() {
    let (engine, updates) = engine_with(
        |context| {
            Box::pin(async move {
                assert_ne!(context.tool_name, "panics", "execution boom");
                Ok(ExecutionOutcome::Completed(result("done")))
            })
        },
        1,
        None,
    );
    let panicking = engine.submit(admission("panics"));
    let queued = engine.submit(admission("next"));
    engine.wait_for_idle().await;

    let failed = engine.get(&panicking.task_id).unwrap();
    assert_eq!(failed.status, BackgroundTaskStatus::Failed);
    assert_eq!(failed.failure.unwrap().failure_type, TaskFailureType::ExecutionError);
    assert_eq!(
        engine.get(&queued.task_id).unwrap().status,
        BackgroundTaskStatus::Completed
    );
    assert_eq!(
        statuses(&updates),
        ["queued", "working", "queued", "failed", "working", "completed"]
    );
}

#[tokio::test]
async fn bounds_execution_concurrency() {
    let gates = [Gate::default(), Gate::default(), Gate::default()];
    let started = Arc::new(AtomicUsize::new(0));
    let execute_gates = gates.clone();
    let counter = started.clone();
    let (engine, _) = engine_with(
        move |context| {
            counter.fetch_add(1, Ordering::SeqCst);
            let gate = execute_gates[context.tool_name.parse::<usize>().unwrap()].clone();
            Box::pin(async move { Ok(gate.wait().await) })
        },
        2,
        None,
    );
    let tasks: Vec<TaskRecord> = ["0", "1", "2"]
        .iter()
        .map(|value| engine.submit(admission(value)))
        .collect();
    tokio::task::yield_now().await;
    assert_eq!(started.load(Ordering::SeqCst), 2);
    assert_eq!(
        engine.get(&tasks[2].task_id).unwrap().status,
        BackgroundTaskStatus::Queued
    );
    gates[0].release(ExecutionOutcome::Completed(result("0")));
    for _ in 0..100 {
        if started.load(Ordering::SeqCst) == 3 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(started.load(Ordering::SeqCst), 3);
    gates[1].release(ExecutionOutcome::Completed(result("1")));
    gates[2].release(ExecutionOutcome::Completed(result("2")));
    engine.wait_for_idle().await;
}

#[tokio::test]
async fn records_classified_failures() {
    let (thrown, _) = engine_with(
        |_| Box::pin(async { Err(crate::Error::other("Execution exploded")) }),
        2,
        None,
    );
    let task = thrown.submit(admission("throw"));
    thrown.wait_for_idle().await;
    assert_eq!(
        thrown.get(&task.task_id).unwrap().failure,
        Some(TaskFailure::new(TaskFailureType::ExecutionError, "Execution exploded"))
    );

    let (opaque, _) = engine_with(|_| Box::pin(async { Err(crate::Error::other("")) }), 2, None);
    let task = opaque.submit(admission("opaque"));
    opaque.wait_for_idle().await;
    assert_eq!(
        opaque.get(&task.task_id).unwrap().failure,
        Some(TaskFailure::new(
            TaskFailureType::ExecutionError,
            "Background task execution failed"
        ))
    );

    let (returned, _) = engine_with(
        |_| {
            Box::pin(async {
                Ok(ExecutionOutcome::Failed {
                    failure: TaskFailure::new(TaskFailureType::ToolError, "Tool failed"),
                    result: Some(result("tool detail")),
                })
            })
        },
        2,
        None,
    );
    let task = returned.submit(admission("return"));
    returned.wait_for_idle().await;
    let failed = returned.get(&task.task_id).unwrap();
    assert_eq!(failed.status, BackgroundTaskStatus::Failed);
    assert_eq!(
        failed.failure,
        Some(TaskFailure::new(TaskFailureType::ToolError, "Tool failed"))
    );
    assert_eq!(failed.result, Some(result("tool detail")));
}

#[tokio::test(start_paused = true)]
async fn does_not_release_capacity_until_a_timed_out_execution_settles() {
    let gate = Gate::default();
    let timed_out = Arc::new(Notify::new());
    let on_abort = timed_out.clone();
    let wait_gate = gate.clone();
    let (engine, _) = engine_with(
        move |context| {
            let gate = wait_gate.clone();
            let on_abort = on_abort.clone();
            Box::pin(async move {
                if context.tool_name != "hang" {
                    return Ok(ExecutionOutcome::Completed(result("next")));
                }
                context.cancel_signal.cancelled().await;
                on_abort.notify_one();
                Ok(gate.wait().await)
            })
        },
        1,
        Some(Duration::from_millis(10)),
    );
    let hung = engine.submit(admission("hang"));
    let next = engine.submit(admission("next"));
    timed_out.notified().await;
    assert_eq!(engine.get(&next.task_id).unwrap().status, BackgroundTaskStatus::Queued);
    gate.release(ExecutionOutcome::Completed(result("late")));
    engine.wait_for_idle().await;
    assert_eq!(engine.get(&next.task_id).unwrap().result, Some(result("next")));
    let hung = engine.get(&hung.task_id).unwrap();
    assert_eq!(hung.status, BackgroundTaskStatus::Failed);
    assert_eq!(
        hung.failure,
        Some(TaskFailure::new(TaskFailureType::Timeout, "Timed out after 10ms"))
    );
}

#[tokio::test(start_paused = true)]
async fn allows_infinity_to_disable_execution_timeouts() {
    let gate = Gate::default();
    let (engine, _) = gated_engine(&gate, 2, None);
    let task = engine.submit(admission("work"));
    tokio::time::sleep(Duration::from_secs(3600)).await;
    assert_eq!(engine.get(&task.task_id).unwrap().status, BackgroundTaskStatus::Working);
    gate.release(ExecutionOutcome::Completed(result("done")));
    engine.wait_for_idle().await;
    assert_eq!(
        engine.get(&task.task_id).unwrap().status,
        BackgroundTaskStatus::Completed
    );
}

// --- manager ------------------------------------------------------------------------------------

/// Runs the tool's own stream with the task's interrupts and signal.
fn direct_runner() -> RunFn {
    Arc::new(|run: ToolRun| {
        Box::pin(async move {
            let agent = crate::agent::ToolAgent::new("agent", "session", Arc::new(MockModel::new()))
                .with_cancel_signal(run.cancel_signal.clone());
            let context =
                ToolContext::new(run.tool_use.clone(), agent, run.invocation_state).with_interrupt(run.tool_interrupt);
            let mut stream = run.tool.stream(context);
            while let Some(item) = stream.next().await {
                match item {
                    ToolStreamItem::Outcome(ToolOutcome::Result(result)) => return Ok(result),
                    ToolStreamItem::Outcome(ToolOutcome::Interrupt(interrupt)) => {
                        return Err(RunFailure::Interrupts(interrupt.into_interrupts()));
                    }
                    _ => {}
                }
            }
            Err(RunFailure::Error(crate::Error::other("tool ended without a result")))
        })
    })
}

fn manager() -> Manager {
    Manager::new(ManagerOptions {
        max_concurrency: None,
        timeout: None,
        on_task_updated: None,
    })
    .unwrap()
}

fn work<F, Fut>(callback: F) -> Arc<dyn Tool>
where
    F: Fn(Value, ToolContext) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, crate::ToolError>> + Send + 'static,
{
    Arc::new(FunctionTool::builder("work", "Perform controlled test work.").callback(callback))
}

fn submit_work(
    manager: &Manager,
    tool: &Arc<dyn Tool>,
    value: &str,
    tool_use_id: &str,
    pass_id: &str,
) -> BackgroundTask {
    manager.submit(
        ToolUse::new("work", tool_use_id, json!({"value": value})),
        InvocationState::new(),
        pass_id,
        tool.clone(),
        direct_runner(),
    )
}

fn task_json(task: &BackgroundTask) -> Value {
    let mut value = serde_json::to_value(task).unwrap();
    value["createdAt"] = json!("*");
    value["lastUpdatedAt"] = json!("*");
    value
}

#[tokio::test]
async fn executes_the_selected_tool_with_transient_invocation_state() {
    #[derive(Clone)]
    struct RequestId(&'static str);
    let manager = manager();
    let tool = Arc::new(
        FunctionTool::builder("work", "Perform work.").stream_callback(|input, context| {
            let value = input["value"].as_str().unwrap_or_default().to_uppercase();
            assert_eq!(context.invocation_state().get::<RequestId>().unwrap().0, "request-1");
            assert_eq!(context.tool_use().name, "hook-alias");
            futures::stream::iter([
                Ok(crate::tools::FunctionToolItem::Update(json!("progress"))),
                Ok(crate::tools::FunctionToolItem::Return(json!(value))),
            ])
        }),
    ) as Arc<dyn Tool>;
    let state = InvocationState::new();
    state.insert(RequestId("request-1"));
    let admitted = manager.submit(
        ToolUse::new("hook-alias", "tool-use-1", json!({"value": "hello"})),
        state,
        "pass-1",
        tool,
        direct_runner(),
    );
    let completed = manager.wait(&admitted.task_id).await.unwrap();
    assert_eq!(
        task_json(&completed),
        json!({
            "taskId": admitted.task_id,
            "toolUseId": "tool-use-1",
            "toolName": "hook-alias",
            "status": "completed",
            "createdAt": "*",
            "lastUpdatedAt": "*",
            "result": {"content": [{"text": "HELLO"}]}
        })
    );
    assert_eq!(manager.list(), std::slice::from_ref(&completed));
    manager.remove(std::slice::from_ref(&admitted.task_id)).unwrap();
    assert!(manager.get(&admitted.task_id).is_none());
}

#[tokio::test]
async fn deduplicates_repeated_submissions_within_one_pass() {
    let executions = Arc::new(AtomicUsize::new(0));
    let counter = executions.clone();
    let tool = work(move |input, _| {
        counter.fetch_add(1, Ordering::SeqCst);
        async move { Ok(input["value"].clone()) }
    });
    let manager = manager();
    let first = submit_work(&manager, &tool, "same", "tool-use-1", "pass-1");
    let duplicate = submit_work(&manager, &tool, "same", "tool-use-1", "pass-1");
    let later = submit_work(&manager, &tool, "same", "tool-use-1", "pass-2");
    assert_eq!(duplicate.task_id, first.task_id);
    assert_ne!(later.task_id, first.task_id);
    manager.wait(&first.task_id).await.unwrap();
    manager.wait(&later.task_id).await.unwrap();
    assert_eq!(executions.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn projects_a_tool_error_as_failed_and_an_error_after_cancellation_as_cancelled() {
    let manager = manager();
    let failing = work(|_, _| async { Err(crate::ToolError::msg("timed out")) });
    let admitted = submit_work(&manager, &failing, "error", "tool-use-error", "pass-error");
    let failed = manager.wait(&admitted.task_id).await.unwrap();
    assert_eq!(failed.status, BackgroundTaskStatus::Failed);
    assert_eq!(
        failed.error,
        Some(TaskFailure::new(TaskFailureType::ToolError, "timed out"))
    );
    assert_eq!(
        serde_json::to_value(&failed.result).unwrap(),
        json!({"content": [{"text": "Error: timed out"}]})
    );

    let aborting = work(|_, context| async move {
        context.cancel_signal().cancelled().await;
        Err(crate::ToolError::msg("aborted"))
    });
    let admitted = submit_work(&manager, &aborting, "abort", "tool-use-abort", "pass-abort");
    tokio::task::yield_now().await;
    manager.cancel(&admitted.task_id).unwrap();
    let cancelled = manager.wait(&admitted.task_id).await.unwrap();
    assert_eq!(cancelled.status, BackgroundTaskStatus::Cancelled);
    assert!(cancelled.result.is_none());
}

#[tokio::test]
async fn cancels_tool_execution() {
    let started = Arc::new(Notify::new());
    let on_start = started.clone();
    let signal = Arc::new(Mutex::new(None));
    let seen = signal.clone();
    let tool = work(move |_, context| {
        let on_start = on_start.clone();
        *seen.lock().unwrap() = Some(context.cancel_signal().clone());
        async move {
            on_start.notify_one();
            context.cancel_signal().cancelled().await;
            Ok(json!("late"))
        }
    });
    let manager = manager();
    let admitted = submit_work(&manager, &tool, "cancel", "tool-use-cancel", "pass-cancel");
    started.notified().await;
    let cancelled = manager.cancel(&admitted.task_id).unwrap();
    assert_eq!(cancelled.status, BackgroundTaskStatus::Cancelled);
    assert_eq!(manager.wait(&admitted.task_id).await.unwrap(), cancelled);
    let signal = signal.lock().unwrap().clone().unwrap();
    assert!(signal.is_cancelled());
    assert_eq!(signal.reason().as_deref(), Some("Cancellation requested"));
    manager.wait_for_idle(None).await.unwrap();
}

#[tokio::test]
async fn rejects_an_invalid_wait_timeout() {
    let error = manager().wait_for_idle(Some(Duration::ZERO)).await.unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("wait timeout must be a positive finite integer")
    );
}

#[tokio::test(start_paused = true)]
async fn throws_background_task_timeout_error_when_the_wait_exceeds_the_timeout() {
    let tool = work(|_, context| async move {
        context.cancel_signal().cancelled().await;
        Ok(json!("cancelled"))
    });
    let manager = manager();
    let admitted = submit_work(&manager, &tool, "slow", "tool-use-slow", "pass-slow");
    let error = manager
        .wait_for_idle(Some(Duration::from_millis(10)))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "Timed out waiting for background tasks after 10ms");
    manager.cancel(&admitted.task_id).unwrap();
    manager.wait_for_idle(None).await.unwrap();
}

#[tokio::test]
async fn requests_input_and_resumes_tool_interrupts() {
    let tool = work(|input, context| async move {
        if input["value"] == "complete" {
            return Ok(json!("complete"));
        }
        let response = context.interrupt(InterruptParams::new("approve_work").with_reason("Approve work?"))?;
        Ok(json!(format!("approved:{}", response.as_str().unwrap_or_default())))
    });
    let manager = manager();
    let completed = submit_work(&manager, &tool, "complete", "tool-use-complete", "pass-complete");
    manager.wait(&completed.task_id).await.unwrap();
    let admitted = submit_work(&manager, &tool, "interrupt", "tool-use-1", "pass-interrupt");
    let waiting = manager.wait(&admitted.task_id).await.unwrap();
    assert_eq!(waiting.status, BackgroundTaskStatus::InputRequired);
    let interrupts = waiting.interrupts.clone().unwrap();
    assert_eq!(
        serde_json::to_value(&interrupts).unwrap(),
        json!([{
            "id": format!("tool:{}:approve_work", admitted.task_id),
            "name": "approve_work",
            "reason": "Approve work?",
            "source": "tool"
        }])
    );
    let error = manager
        .remove(&[completed.task_id.clone(), admitted.task_id.clone()])
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        format!(
            "Background task '{}' cannot be removed before reaching a terminal status",
            admitted.task_id
        )
    );
    assert!(manager.get(&completed.task_id).is_some());
    let queued = manager
        .resume(
            &admitted.task_id,
            &[InterruptResponse::new(interrupts[0].id.clone(), "yes")],
        )
        .unwrap();
    assert_eq!(queued.status, BackgroundTaskStatus::Queued);
    let done = manager.wait(&admitted.task_id).await.unwrap();
    assert_eq!(
        serde_json::to_value(&done.result).unwrap(),
        json!({"content": [{"text": "approved:yes"}]})
    );
}

#[tokio::test]
async fn fails_tasks_interrupted_outside_their_tool_context() {
    let manager = manager();
    let runner: RunFn = Arc::new(|_| {
        Box::pin(async {
            Err(RunFailure::Interrupts(vec![
                Interrupt::new("hook:beforeToolCall:tool-use-1:approve_hook", "approve_hook")
                    .with_source(InterruptSource::Hook),
            ]))
        })
    });
    let tool = work(|_, _| async { Ok(json!("unused")) });
    let admitted = manager.submit(
        ToolUse::new("work", "tool-use-1", json!({})),
        InvocationState::new(),
        "pass",
        tool,
        runner,
    );
    let failed = manager.wait(&admitted.task_id).await.unwrap();
    assert_eq!(failed.status, BackgroundTaskStatus::Failed);
    assert_eq!(
        failed.error,
        Some(TaskFailure::new(
            TaskFailureType::ExecutionError,
            "Interrupt raised: approve_hook"
        ))
    );
}

// --- plugin -------------------------------------------------------------------------------------

fn deliveries(agent: &Agent) -> Vec<ToolUseBlock> {
    deliveries_named(agent, MANAGE_TOOL_NAME)
}

fn deliveries_named(agent: &Agent, tool_name: &str) -> Vec<ToolUseBlock> {
    agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) if tool_use.name == tool_name => Some(tool_use.clone()),
            _ => None,
        })
        .collect()
}

fn persisted(agent: &Agent) -> Option<Vec<BackgroundTask>> {
    agent.app_state().get(BACKGROUND_TASKS_STATE_KEY).unwrap()
}

fn blocks(agent: &Agent) -> Vec<ContentBlock> {
    agent
        .messages()
        .iter()
        .flat_map(|message| message.content.clone())
        .collect()
}

fn background_agent(model: MockModel, tools: Vec<crate::ToolSource>, config: BackgroundTasksConfig) -> Agent {
    Agent::new(AgentConfig {
        model: Some(model.into()),
        tools,
        background_tasks: Some(config.into()),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap()
}

fn uses(calls: &[(&str, &str, Value)]) -> MockTurn {
    MockTurn::content(
        calls
            .iter()
            .map(|(name, id, input)| ContentBlock::from(ToolUseBlock::new(*name, *id, input.clone())))
            .collect::<Vec<_>>(),
    )
}

fn object_schema() -> Value {
    json!({"type": "object", "properties": {}})
}

fn tool(name: &str, callback: impl Fn(Value, ToolContext) -> Value + Send + Sync + 'static) -> FunctionTool {
    FunctionTool::builder(name, format!("Tool {name}"))
        .input_schema(object_schema())
        .callback(move |input, context| {
            let value = callback(input, context);
            async move { Ok(value) }
        })
}

async fn eventually(check: impl Fn() -> bool) {
    for _ in 0..10_000 {
        if check() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("condition never held");
}

fn tool_result_of(agent: &Agent, tool_use_id: &str) -> ToolResultBlock {
    blocks(agent)
        .into_iter()
        .find_map(|block| match block {
            ContentBlock::ToolResult(result) if result.tool_use_id == tool_use_id => Some(result),
            _ => None,
        })
        .unwrap()
}

fn strip_times(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        for key in ["createdAt", "lastUpdatedAt"] {
            if object.contains_key(key) {
                object.insert(key.to_owned(), json!("*"));
            }
        }
    }
}

fn result_json(result: &ToolResultBlock) -> Value {
    let mut value = serde_json::to_value(&result.content).unwrap();
    if let Some(first) = value.get_mut(0).and_then(|first| first.get_mut("json")) {
        strip_times(first);
    }
    value
}

#[tokio::test]
async fn registers_the_custom_management_tool_name_and_runs_its_calls_in_the_foreground() {
    let tool_name = "manage_background_task";
    let model = MockModel::from_turns([
        uses(&[(tool_name, "management-use", json!({"mode": "list"}))]),
        MockTurn::text("Listed."),
    ]);
    let mut agent = background_agent(
        model,
        Vec::new(),
        BackgroundTasksConfig {
            manage_tool_name: Some(tool_name.to_owned()),
            always: Some(vec!["*".into()]),
            ..Default::default()
        },
    );

    agent.invoke("List tasks.").await.unwrap();

    let names: Vec<String> = agent.tools().iter().map(|tool| tool.name().to_owned()).collect();
    assert_eq!(names, [tool_name]);
    let result = tool_result_of(&agent, "management-use");
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(result_json(&result), json!([{"json": {"tasks": []}}]));
}

#[tokio::test]
async fn dispatches_selected_calls_through_the_normal_tool_pipeline_and_delivers_their_results() {
    let tool_name = "task_admin";
    let work = FunctionTool::builder("work", "Perform work.")
        .input_schema(json!({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}))
        .callback(|input, _| async move { Ok(json!(format!("done:{}", input["value"].as_str().unwrap()))) });
    let model = MockModel::from_turns([
        uses(&[(
            "work",
            "work-use",
            json!({"value": "background", "_background_execution": true}),
        )]),
        MockTurn::text("Tasks admitted."),
        MockTurn::text("Result received."),
    ]);
    let mut agent = background_agent(
        model,
        vec![work.into()],
        BackgroundTasksConfig {
            manage_tool_name: Some(tool_name.to_owned()),
            agentic: Some(vec!["work".into()]),
            ..Default::default()
        },
    );
    let specs: Arc<Mutex<Option<Vec<ToolSpec>>>> = Arc::default();
    let seen_specs = specs.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        seen_specs
            .lock()
            .unwrap()
            .get_or_insert_with(|| context.tool_specs.clone());
        next.call(context)
    }));
    let retried = Arc::new(AtomicBool::new(false));
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        if !retried.swap(true, Ordering::SeqCst) {
            event.set_retry(true);
        }
    });
    let middleware_calls = Arc::new(AtomicUsize::new(0));
    let counter = middleware_calls.clone();
    agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
        counter.fetch_add(1, Ordering::SeqCst);
        next.call(context)
    }));

    agent.invoke("Run work.").await.unwrap();

    assert_eq!(middleware_calls.load(Ordering::SeqCst), 2);
    let specs = specs.lock().unwrap().clone().unwrap();
    let work_spec = specs.iter().find(|spec| spec.name == "work").unwrap();
    assert!(
        work_spec.input_schema.as_ref().unwrap()["properties"]
            .get("_background_execution")
            .is_some()
    );
    let delivery = deliveries_named(&agent, tool_name).remove(0);
    assert_eq!(delivery.input, json!({"mode": "get", "taskId": delivery.tool_use_id}));
    assert!(specs.iter().any(|spec| spec.name == tool_name));
    let delivered = tool_result_of(&agent, &delivery.tool_use_id);
    assert_eq!(delivered.status, ToolResultStatus::Success);
    assert_eq!(
        result_json(&delivered),
        json!([
            {"json": {
                "taskId": delivery.tool_use_id,
                "toolUseId": "work-use",
                "toolName": "work",
                "status": "completed",
                "createdAt": "*",
                "lastUpdatedAt": "*"
            }},
            {"text": "done:background"}
        ])
    );
}

#[tokio::test]
async fn applies_always_and_never_policies_per_tool() {
    let executions = Arc::new(Mutex::new(Vec::new()));
    let inputs = Arc::new(Mutex::new(Vec::new()));
    let make = |name: &'static str| {
        let executions = executions.clone();
        let inputs = inputs.clone();
        tool(name, move |input, _| {
            inputs.lock().unwrap().push(input);
            executions.lock().unwrap().push(name);
            Value::Null
        })
    };
    let background = make("background");
    let foreground = make("foreground");
    let incompatible: Arc<dyn Tool> = Arc::new(make("summarize_context"));
    let model = MockModel::from_turns([
        uses(&[
            ("foreground", "background-use", json!({"_background_execution": false})),
            ("foreground", "foreground-use", json!({"_background_execution": true})),
            ("foreground", "incompatible-use", json!({})),
        ]),
        MockTurn::text("Task admitted."),
        MockTurn::text("Result received."),
    ]);
    let mut agent = background_agent(
        model,
        vec![background.into(), foreground.into()],
        BackgroundTasksConfig {
            always: Some(vec!["background".into(), "summarize_context".into()]),
            never: Some(vec!["*".into()]),
            ..Default::default()
        },
    );
    let specs: Arc<Mutex<Option<Vec<ToolSpec>>>> = Arc::default();
    let seen_specs = specs.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        seen_specs
            .lock()
            .unwrap()
            .get_or_insert_with(|| context.tool_specs.clone());
        next.call(context)
    }));
    agent.add_hook(move |event: &mut BeforeToolCallEvent| {
        if event.tool_use().tool_use_id == "background-use" {
            let mut tool_use = event.tool_use().clone();
            tool_use.name = "background".into();
            event.set_tool_use(tool_use);
        }
        if event.tool_use().tool_use_id == "incompatible-use" {
            event.set_selected_tool(incompatible.clone());
        }
    });

    agent.invoke("Run both.").await.unwrap();

    let mut ran = executions.lock().unwrap().clone();
    ran.sort_unstable();
    assert_eq!(ran, ["background", "foreground"]);
    assert_eq!(*inputs.lock().unwrap(), [json!({}), json!({})]);
    let delivered = deliveries(&agent);
    assert_eq!(delivered.len(), 1);
    let task_id = delivered[0].input["taskId"].as_str().unwrap();
    assert!(!task_id.is_empty());
    assert_eq!(delivered[0].input, json!({"mode": "get", "taskId": task_id}));
    let specs = specs.lock().unwrap().clone().unwrap();
    for name in ["background", "foreground"] {
        let spec = specs.iter().find(|spec| spec.name == name).unwrap();
        assert!(
            spec.input_schema.as_ref().unwrap()["properties"]
                .get("_background_execution")
                .is_none()
        );
    }
}

#[test]
fn rejects_conflicting_tool_policies() {
    let error = Agent::new(AgentConfig {
        model: Some(MockModel::new().into()),
        background_tasks: Some(crate::Toggle::On(BackgroundTasksConfig {
            always: Some(vec!["work".into()]),
            never: Some(vec!["work".into()]),
            ..Default::default()
        })),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Tool 'work' cannot be configured as both 'always' and 'never'"
    );
}

#[tokio::test]
async fn runs_queued_work_under_the_request_that_submitted_it_even_after_that_request_returned() {
    let released = Arc::new(Notify::new());
    let gate = released.clone();
    let blocker = FunctionTool::builder("blocker", "Hold the only execution slot.")
        .input_schema(object_schema())
        .callback(move |_, _| {
            let gate = gate.clone();
            async move {
                gate.notified().await;
                Ok(json!("unblocked"))
            }
        });
    let probe_context = Arc::new(Mutex::new(None));
    let seen = probe_context.clone();
    let probe = tool("probe", move |_, context| {
        *seen.lock().unwrap() = Some(context.invocation_context().cloned());
        json!("probed")
    });
    let model = MockModel::from_turns([
        uses(&[
            ("blocker", "blocker-use", json!({"_background_execution": true})),
            ("probe", "probe-use", json!({"_background_execution": true})),
        ]),
        MockTurn::text("Tasks admitted."),
    ]);
    let mut agent = background_agent(
        model,
        vec![blocker.into(), probe.into()],
        BackgroundTasksConfig {
            wait_for_completion: Some(false),
            max_concurrency: Some(1),
            ..Default::default()
        },
    );
    let submitting = Arc::new(Mutex::new(None));
    let first = submitting.clone();
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        first
            .lock()
            .unwrap()
            .get_or_insert_with(|| event.invocation_context().cloned());
    });

    agent.invoke("Run both.").await.unwrap();
    assert!(probe_context.lock().unwrap().is_none());

    released.notify_one();
    eventually(|| probe_context.lock().unwrap().is_some()).await;
    let submitted = submitting.lock().unwrap().clone().flatten().unwrap();
    let probed = probe_context.lock().unwrap().clone().flatten().unwrap();
    assert!(probed.ptr_eq(&submitted));
}

#[tokio::test]
async fn delivers_work_that_finishes_between_invocations() {
    let image = ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]));
    let released = Arc::new(Notify::new());
    let gate = released.clone();
    let image_json = serde_json::to_value(ToolResultContent::Image(image.clone())).unwrap();
    let returned = json!([{"text": "done"}, image_json]);
    let work = FunctionTool::builder("work", "Perform deferred work.")
        .input_schema(object_schema())
        .callback(move |_, _| {
            let gate = gate.clone();
            let returned = returned.clone();
            async move {
                gate.notified().await;
                Ok(returned)
            }
        });
    let model = MockModel::from_turns([
        uses(&[("work", "work-use", json!({"_background_execution": true}))]),
        MockTurn::text("Task admitted."),
    ]);
    let mut agent = background_agent(
        model,
        vec![work.into()],
        BackgroundTasksConfig {
            wait_for_completion: Some(false),
            ..Default::default()
        },
    );

    agent.invoke("Run work.").await.unwrap();
    assert!(deliveries(&agent).is_empty());
    let state_only = agent
        .take_snapshot(crate::TakeSnapshotOptions {
            include: vec![crate::SnapshotField::State],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        agent.load_snapshot(&state_only).unwrap_err().to_string(),
        "Cannot load a snapshot while background tasks are still tracked"
    );

    released.notify_one();
    eventually(|| {
        persisted(&agent).is_some_and(|tasks| {
            tasks
                .first()
                .is_some_and(|task| task.status == BackgroundTaskStatus::Completed)
        })
    })
    .await;
    let task = persisted(&agent).unwrap().remove(0);
    assert_eq!(
        serde_json::to_value(&task.result).unwrap(),
        json!({"content": [{"text": "done"}, image_json]})
    );
    let inspected = agent
        .tool(MANAGE_TOOL_NAME)
        .invoke_with(
            json!({"mode": "get", "taskId": task.task_id}),
            DirectToolCallOptions {
                record_direct_tool_call: Some(false),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        inspected.content[1..],
        [ToolResultContent::text("done"), ToolResultContent::Image(image)]
    );
    let snapshot = agent.take_snapshot(crate::TakeSnapshotOptions::session()).unwrap();
    let mut restored = background_agent(
        MockModel::new().with_turn("Result received."),
        Vec::new(),
        BackgroundTasksConfig::default(),
    );
    restored.load_snapshot(&snapshot).unwrap();
    restored.invoke("Continue.").await.unwrap();

    assert_eq!(deliveries(&restored).len(), 1);
    assert_eq!(tool_result_of(&restored, &task.task_id).content, inspected.content);
    assert!(persisted(&restored).is_none());
}

#[tokio::test]
async fn stops_waiting_for_running_tasks_when_the_invocation_is_cancelled() {
    let released = Arc::new(Notify::new());
    let gate = released.clone();
    let work = FunctionTool::builder("work", "Perform deferred work.")
        .input_schema(object_schema())
        .callback(move |_, _| {
            let gate = gate.clone();
            async move {
                gate.notified().await;
                Ok(json!("done"))
            }
        });
    let abort = tool("abort", |_, context| {
        context.agent().cancel(crate::CancelOptions::default());
        json!("aborting")
    });
    let model = MockModel::from_turns([
        uses(&[
            ("work", "work-use", json!({"_background_execution": true})),
            ("abort", "abort-use", json!({})),
        ]),
        MockTurn::text("unreachable"),
    ]);
    let mut agent = background_agent(model, vec![work.into(), abort.into()], BackgroundTasksConfig::default());

    let result = agent.invoke("Run work.").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(persisted(&agent).unwrap()[0].status, BackgroundTaskStatus::Working);
    released.notify_one();
    eventually(|| persisted(&agent).is_some_and(|tasks| tasks[0].status == BackgroundTaskStatus::Completed)).await;
}

#[tokio::test]
async fn fails_interrupted_work_restored_from_app_state() {
    let created_at = "2026-08-27T12:00:00.000Z";
    let interrupt = Interrupt::new("tool:working:approve", "approve")
        .with_reason("Approve restored work?")
        .with_source(InterruptSource::Tool);
    let source = crate::testing::test_agent(MockModel::new());
    source
        .app_state()
        .set(
            BACKGROUND_TASKS_STATE_KEY,
            json!([{
                "taskId": "working",
                "toolUseId": "working-use",
                "toolName": "working-work",
                "status": "input_required",
                "createdAt": created_at,
                "lastUpdatedAt": created_at,
                "interrupts": [interrupt]
            }]),
        )
        .unwrap();
    source.local.interrupt_state().register_interrupt(&interrupt);
    source.local.interrupt_state().activate();
    let snapshot = source.take_snapshot(crate::TakeSnapshotOptions::session()).unwrap();
    let mut agent = background_agent(
        MockModel::new().with_turn("Results received."),
        Vec::new(),
        BackgroundTasksConfig::default(),
    );
    agent.add_hook(move |event: &mut InitializedEvent<'_>| {
        event.agent_mut().load_snapshot(&snapshot).unwrap();
    });

    agent.initialize().await.unwrap();

    let mut restored = serde_json::to_value(&persisted(&agent).unwrap()[0]).unwrap();
    restored["lastUpdatedAt"] = json!("*");
    restored["error"]["message"] = json!("*");
    assert_eq!(
        restored,
        json!({
            "taskId": "working",
            "toolUseId": "working-use",
            "toolName": "working-work",
            "status": "failed",
            "createdAt": created_at,
            "lastUpdatedAt": "*",
            "error": {"type": "executionError", "message": "*"}
        })
    );
    assert!(!agent.local.interrupt_state().activated());
    let cancelled = agent
        .tool(MANAGE_TOOL_NAME)
        .invoke_with(
            json!({"mode": "cancel", "taskId": "working"}),
            DirectToolCallOptions {
                record_direct_tool_call: Some(false),
            },
        )
        .await
        .unwrap();
    assert_eq!(cancelled.status, ToolResultStatus::Success);
    assert_eq!(
        serde_json::to_value(&cancelled.content).unwrap(),
        json!([{"json": {"taskId": "working", "status": "failed"}}])
    );

    agent.invoke("Continue.").await.unwrap();

    let delivered = deliveries(&agent);
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].tool_use_id, "working");
    assert_eq!(delivered[0].input, json!({"mode": "get", "taskId": "working"}));
}

#[tokio::test]
async fn surfaces_and_resumes_interrupts_from_detached_tools() {
    let started = Arc::new(Notify::new());
    let on_start = started.clone();
    let approval = tool("approval", |_, _| json!("approved"));
    let blocked = FunctionTool::builder("blocked", "Wait for release.")
        .input_schema(object_schema())
        .callback(move |_, context| {
            let on_start = on_start.clone();
            async move {
                on_start.notify_one();
                context.cancel_signal().cancelled().await;
                Ok(json!("cancelled"))
            }
        });
    let model = MockModel::from_turns([
        uses(&[
            ("approval", "approval-use", json!({"_background_execution": true})),
            ("blocked", "blocked-use", json!({"_background_execution": true})),
        ]),
        MockTurn::text("Task admitted."),
        MockTurn::text("Task resumed."),
        MockTurn::text("Result received."),
    ]);
    let mut agent = background_agent(
        model,
        vec![approval.into(), blocked.into()],
        BackgroundTasksConfig::default(),
    );
    let specs: Arc<Mutex<Option<Vec<ToolSpec>>>> = Arc::default();
    let seen_specs = specs.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        seen_specs
            .lock()
            .unwrap()
            .get_or_insert_with(|| context.tool_specs.clone());
        next.call(context)
    }));
    let response = Arc::new(Mutex::new(None));
    let seen_response = response.clone();
    agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
        if context.tool_use.name == "approval" {
            match context.interrupt(InterruptParams::new("approve").with_reason("Approve work?")) {
                Ok(answer) => *seen_response.lock().unwrap() = Some(answer.response),
                Err(interrupt) => return StageStream::from_result(Err(interrupt.into())),
            }
        }
        next.call(context)
    }));

    let interrupted = agent.invoke("Run approval.").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
    let mut interrupts = serde_json::to_value(interrupted.interrupts()).unwrap();
    interrupts[0]["id"] = json!("*");
    assert_eq!(
        interrupts,
        json!([{"id": "*", "name": "approve", "reason": "Approve work?", "source": "middleware"}])
    );

    started.notified().await;
    let manage = specs
        .lock()
        .unwrap()
        .clone()
        .unwrap()
        .into_iter()
        .find(|spec| spec.name == MANAGE_TOOL_NAME)
        .unwrap();
    assert!(
        manage.input_schema.unwrap()["properties"]
            .get("_background_execution")
            .is_none()
    );
    let blocked_task = persisted(&agent)
        .unwrap()
        .into_iter()
        .find(|task| task.tool_name == "blocked")
        .unwrap();
    let options = || DirectToolCallOptions {
        record_direct_tool_call: Some(false),
    };
    let inspected = agent
        .tool(MANAGE_TOOL_NAME)
        .invoke_with(json!({"mode": "get", "taskId": blocked_task.task_id}), options())
        .await
        .unwrap();
    assert_eq!(
        result_json(&inspected),
        json!([{"json": {
            "taskId": blocked_task.task_id,
            "toolUseId": "blocked-use",
            "toolName": "blocked",
            "status": "working",
            "createdAt": "*",
            "lastUpdatedAt": "*"
        }}])
    );
    let cancelled = agent
        .tool(MANAGE_TOOL_NAME)
        .invoke_with(json!({"mode": "cancel", "taskId": blocked_task.task_id}), options())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&cancelled.content).unwrap(),
        json!([{"json": {"taskId": blocked_task.task_id, "status": "cancelled"}}])
    );

    let answer = InterruptResponse::new(interrupted.interrupts()[0].id.clone(), "yes");
    agent.invoke(vec![answer]).await.unwrap();

    assert_eq!(*response.lock().unwrap(), Some(json!("yes")));
    assert_eq!(deliveries(&agent).len(), 2);
    let _ = (Message::user("x"), InvokeArgs::Messages(Vec::new()));
}

#[tokio::test]
async fn a_delegation_tool_runs_in_the_foreground_and_the_selector_is_stripped() {
    let tech = Agent::new(AgentConfig {
        model: Some(MockModel::new().with_turn("Try rebooting your router.").into()),
        name: Some("TechSupport".into()),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap()
    .as_tool(crate::agent::AgentAsToolOptions {
        delegate: Some(true),
        ..Default::default()
    });
    let model = MockModel::new().with_turn(uses(&[(
        "TechSupport",
        "call-1",
        json!({"input": "My wifi does not work", "_background_execution": true}),
    )]));
    let mut orchestrator = background_agent(model, vec![tech.into()], BackgroundTasksConfig::default());
    let result = orchestrator.invoke("My wifi does not work").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        result.last_message().content,
        [ContentBlock::text("Try rebooting your router.")]
    );
}

// --- end of life --------------------------------------------------------------------------------

/// Sets its flag when the execution holding it is dropped.
struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// A `work` tool that never finishes on its own, and the flag its dropped execution sets.
fn endless_work() -> (FunctionTool, Arc<AtomicBool>) {
    let dropped = Arc::new(AtomicBool::new(false));
    let flag = dropped.clone();
    let work = FunctionTool::builder("work", "Perform endless work.")
        .input_schema(object_schema())
        .callback(move |_, _| {
            let guard = DropFlag(flag.clone());
            async move {
                std::future::pending::<()>().await;
                drop(guard);
                Ok(json!("never"))
            }
        });
    (work, dropped)
}

fn endless_agent(config: BackgroundTasksConfig) -> (Agent, Arc<AtomicBool>) {
    let (work, dropped) = endless_work();
    let model = MockModel::from_turns([
        uses(&[("work", "work-use", json!({"_background_execution": true}))]),
        MockTurn::text("Task admitted."),
        MockTurn::text("Next answer."),
    ]);
    (background_agent(model, vec![work.into()], config), dropped)
}

fn no_wait() -> BackgroundTasksConfig {
    BackgroundTasksConfig {
        wait_for_completion: Some(false),
        ..Default::default()
    }
}

#[tokio::test]
async fn shutdown_cancels_unfinished_tasks_and_drops_their_executions() {
    let (mut agent, dropped) = endless_agent(no_wait());
    agent.invoke("Run work.").await.unwrap();
    eventually(|| persisted(&agent).is_some_and(|tasks| tasks[0].status == BackgroundTaskStatus::Working)).await;
    agent.shutdown().await.unwrap();
    assert_eq!(persisted(&agent).unwrap()[0].status, BackgroundTaskStatus::Cancelled);
    eventually(|| dropped.load(Ordering::SeqCst)).await;
}

#[tokio::test]
async fn dropping_the_agent_drops_its_background_executions() {
    let (mut agent, dropped) = endless_agent(no_wait());
    agent.invoke("Run work.").await.unwrap();
    eventually(|| persisted(&agent).is_some_and(|tasks| tasks[0].status == BackgroundTaskStatus::Working)).await;
    drop(agent);
    eventually(|| dropped.load(Ordering::SeqCst)).await;
}

/// A stream dropped after its final message defers `AfterInvocationEvent`; the deferred event
/// (here run by `shutdown`) sees a cancelled invocation, so it does not wait for the background
/// task.
#[tokio::test(start_paused = true)]
async fn a_deferred_after_invocation_does_not_wait_for_background_tasks() {
    let (mut agent, _dropped) = endless_agent(BackgroundTasksConfig::default());
    {
        let mut stream = agent.stream("Run work.");
        while let Some(event) = stream.next().await {
            if let crate::AgentStreamEvent::MessageAdded(added) = event.unwrap()
                && added.message.text() == "Task admitted."
            {
                break;
            }
        }
    }
    let shutdown = tokio::time::timeout(Duration::from_secs(60), agent.shutdown()).await;
    shutdown
        .expect("the deferred AfterInvocationEvent waited for the task")
        .unwrap();
    assert_eq!(persisted(&agent).unwrap()[0].status, BackgroundTaskStatus::Cancelled);
}

#[tokio::test]
async fn lets_a_user_tool_named_load_tools_run_in_the_background() {
    let load_tools = crate::tools::FunctionTool::builder("load_tools", "Load data.")
        .input_schema(serde_json::json!({"type": "object", "properties": {}}))
        .callback(|_, _| async { Ok(serde_json::json!("done")) });
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .tools([load_tools])
        .background_tasks(BackgroundTasksConfig {
            always: Some(vec!["load_tools".into()]),
            ..BackgroundTasksConfig::default()
        })
        .printer(false)
        .build()
        .unwrap();
    agent.initialize().await.unwrap();
}

/// `backgroundTasks: true | false | config` takes the same forms as the other toggles.
#[tokio::test]
async fn background_tasks_take_true_false_or_a_config() {
    for (toggle, expected) in [(true.into(), true), (false.into(), false), (no_wait().into(), true)] {
        let toggle: crate::Toggle<BackgroundTasksConfig> = toggle;
        let mut agent = Agent::builder()
            .model(MockModel::new())
            .background_tasks(toggle)
            .printer(false)
            .build()
            .unwrap();
        agent.initialize().await.unwrap();
        assert_eq!(agent.tool_registry().get(MANAGE_TOOL_NAME).is_some(), expected);
    }
}

// --- cancel_background_tasks --------------------------------------------------------------------

fn cancel_background() -> CancelOptions {
    CancelOptions {
        cancel_background_tasks: true,
        ..CancelOptions::default()
    }
}

fn statuses_of(agent: &Agent) -> Vec<BackgroundTaskStatus> {
    persisted(agent)
        .unwrap_or_default()
        .iter()
        .map(|task| task.status)
        .collect()
}

fn waiting_tool(name: &str) -> FunctionTool {
    FunctionTool::builder(name, "Wait until cancelled.")
        .input_schema(object_schema())
        .callback(|_, context| async move {
            context.cancel_signal().cancelled().await;
            Ok(json!("late"))
        })
}

#[tokio::test]
async fn cancels_queued_and_working_tasks_of_an_idle_agent_only_when_requested() {
    let model = MockModel::from_turns([
        uses(&[
            ("work", "work-0", json!({"_background_execution": true})),
            ("work", "work-1", json!({"_background_execution": true})),
        ]),
        MockTurn::text("Tasks admitted."),
    ]);
    let mut agent = background_agent(
        model,
        vec![waiting_tool("work").into()],
        BackgroundTasksConfig {
            wait_for_completion: Some(false),
            max_concurrency: Some(1),
            ..Default::default()
        },
    );
    agent.invoke("Run work.").await.unwrap();
    eventually(|| statuses_of(&agent) == [BackgroundTaskStatus::Working, BackgroundTaskStatus::Queued]).await;

    agent.cancel_handle().cancel(CancelOptions::default());
    assert_eq!(
        statuses_of(&agent),
        [BackgroundTaskStatus::Working, BackgroundTaskStatus::Queued]
    );

    agent.cancel_handle().cancel(cancel_background());
    eventually(|| statuses_of(&agent) == [BackgroundTaskStatus::Cancelled, BackgroundTaskStatus::Cancelled]).await;
}

#[tokio::test]
async fn cancels_background_tasks_from_a_tool_on_the_agent_loop() {
    let stop_all = tool("stop_all", |_, context| {
        context.agent().cancel(cancel_background());
        json!("stopped")
    });
    let model = MockModel::from_turns([
        uses(&[
            ("work", "work-use", json!({"_background_execution": true})),
            ("stop_all", "stop-use", json!({})),
        ]),
        MockTurn::text("unreachable"),
    ]);
    let mut agent = background_agent(
        model,
        vec![waiting_tool("work").into(), stop_all.into()],
        BackgroundTasksConfig::default(),
    );

    let result = agent.invoke("Run work, then stop.").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    eventually(|| statuses_of(&agent).first() == Some(&BackgroundTaskStatus::Cancelled)).await;
}

fn approval_agent(approvals: usize) -> Agent {
    let approval = tool("approval", |_, _| json!("approved"));
    let calls: Vec<(String, Value)> = (0..approvals)
        .map(|index| (format!("approval-use-{index}"), json!({"_background_execution": true})))
        .collect();
    let turn = MockTurn::content(
        calls
            .iter()
            .map(|(id, input)| ContentBlock::from(ToolUseBlock::new("approval", id.clone(), input.clone())))
            .collect::<Vec<_>>(),
    );
    let model = MockModel::from_turns([
        turn,
        MockTurn::text("Task admitted."),
        MockTurn::text("Continued."),
        MockTurn::text("Done."),
    ]);
    let agent = background_agent(model, vec![approval.into()], BackgroundTasksConfig::default());
    agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
        let name = format!("approve-{}", context.tool_use.tool_use_id);
        if let Err(interrupt) = context.interrupt(InterruptParams::new(name).with_reason("Approve work?")) {
            return StageStream::from_result(Err(interrupt.into()));
        }
        next.call(context)
    }));
    agent
}

#[tokio::test]
async fn cancels_an_input_required_task_so_the_next_invoke_does_not_re_raise_its_interrupt() {
    let mut agent = approval_agent(1);
    let interrupted = agent.invoke("Run approval.").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);

    agent.cancel_handle().cancel(cancel_background());
    assert_eq!(statuses_of(&agent), [BackgroundTaskStatus::Cancelled]);
    let resumed = agent.invoke("Continue.").await.unwrap();

    assert_eq!(resumed.stop_reason(), StopReason::EndTurn);
    assert!(!agent.local.interrupt_state().activated());
    let delivery = deliveries(&agent).remove(0);
    let delivered = tool_result_of(&agent, &delivery.tool_use_id);
    assert_eq!(result_json(&delivered)[0]["json"]["status"], json!("cancelled"));
}

/// Where on the resume path a cancel lands. The TS spec lands it after 1 to 40 microtask ticks;
/// with an immediate mock model the resumed invocation never yields, so the cancel lands from the
/// hooks that run before the model call that applies the responses instead.
#[derive(Clone, Copy, Debug)]
enum CancelPoint {
    BeforeInvocation,
    BeforeModelCall,
}

#[tokio::test]
async fn finishes_as_cancelled_whenever_cancel_lands_while_interrupt_responses_are_applied() {
    for point in [CancelPoint::BeforeInvocation, CancelPoint::BeforeModelCall] {
        let mut agent = approval_agent(1);
        let interrupted = agent.invoke("Run approval.").await.unwrap();
        let id = interrupted.interrupts()[0].id.clone();
        let armed = Arc::new(AtomicBool::new(true));
        let fire = move |agent: &crate::agent::LocalAgent| {
            if armed.swap(false, Ordering::SeqCst) {
                agent.cancel(cancel_background());
            }
        };
        match point {
            CancelPoint::BeforeInvocation => {
                agent.add_hook(move |event: &mut crate::hooks::BeforeInvocationEvent<'_>| fire(event.agent()));
            }
            CancelPoint::BeforeModelCall => {
                agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| fire(event.agent()));
            }
        }

        let resumed = agent
            .invoke(InvokeArgs::from(vec![InterruptResponseContent::new(
                InterruptResponse::new(id, "yes"),
            )]))
            .await
            .unwrap();

        assert_eq!(resumed.stop_reason(), StopReason::Cancelled, "{point:?}");
    }
}

#[tokio::test]
async fn delivers_each_result_once_when_cancel_lands_after_a_task_interrupt_is_raised() {
    let mut agent = approval_agent(2);
    let interrupted = agent.invoke("Run approvals.").await.unwrap();
    let armed = Arc::new(AtomicBool::new(true));
    agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
        if armed.swap(false, Ordering::SeqCst) {
            event.agent().cancel(cancel_background());
        }
    });

    let id = interrupted.interrupts()[0].id.clone();
    agent
        .invoke(InvokeArgs::from(vec![InterruptResponseContent::new(
            InterruptResponse::new(id, "yes"),
        )]))
        .await
        .unwrap();
    let continued = agent.invoke("Continue.").await.unwrap();

    assert_eq!(continued.stop_reason(), StopReason::EndTurn);
    assert!(!agent.local.interrupt_state().activated());
    assert_eq!(deliveries(&agent).len(), 2);
}

#[tokio::test]
async fn cancels_background_tasks_immediately_while_after_current_tools_lets_the_tool_batch_finish() {
    let statuses_at_stop: Arc<Mutex<Vec<BackgroundTaskStatus>>> = Arc::default();
    let seen = statuses_at_stop.clone();
    let stop_all = FunctionTool::builder("stop_all", "Stop after this batch, and stop background work now.")
        .input_schema(object_schema())
        .callback(move |_, context| {
            let seen = seen.clone();
            async move {
                context.agent().cancel(CancelOptions {
                    after_current_tools: true,
                    cancel_background_tasks: true,
                    ..CancelOptions::default()
                });
                let tasks: Option<Vec<BackgroundTask>> =
                    context.agent().app_state().get(BACKGROUND_TASKS_STATE_KEY).unwrap();
                seen.lock()
                    .unwrap()
                    .extend(tasks.unwrap_or_default().iter().map(|task| task.status));
                Ok(json!("stopped"))
            }
        });
    let after = tool("after", |_, _| json!("ran"));
    let model = MockModel::from_turns([
        uses(&[
            ("work", "work-use", json!({"_background_execution": true})),
            ("stop_all", "stop-use", json!({})),
            ("after", "after-use", json!({})),
        ]),
        MockTurn::text("unreachable"),
    ]);
    let mut agent = Agent::new(AgentConfig {
        model: Some(model.into()),
        tools: vec![waiting_tool("work").into(), stop_all.into(), after.into()],
        background_tasks: Some(BackgroundTasksConfig::default().into()),
        tool_executor: Some(crate::tools::ToolExecutorStrategy::Sequential),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();

    let result = agent.invoke("Run work, then stop.").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(*statuses_at_stop.lock().unwrap(), [BackgroundTaskStatus::Cancelled]);
    let results: Vec<String> = blocks(&agent)
        .into_iter()
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.tool_use_id),
            _ => None,
        })
        .collect();
    assert!(results.contains(&"stop-use".to_owned()));
    assert!(results.contains(&"after-use".to_owned()));
}

#[tokio::test]
async fn returns_without_another_model_call_when_cancel_lands_while_it_waits_for_background_completion() {
    for after_current_tools in [false, true] {
        let model = MockModel::from_turns([
            uses(&[("work", "work-use", json!({"_background_execution": true}))]),
            MockTurn::text("Task admitted."),
            MockTurn::text("Result received."),
        ]);
        let mut agent = background_agent(
            model.clone(),
            vec![waiting_tool("work").into()],
            BackgroundTasksConfig::default(),
        );
        let handle = agent.cancel_handle();
        let calls = model.clone();
        let cancel = async {
            while calls.call_count() < 2 {
                tokio::task::yield_now().await;
            }
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
            handle.cancel(CancelOptions {
                after_current_tools,
                cancel_background_tasks: true,
                ..CancelOptions::default()
            });
        };

        let (result, ()) = tokio::join!(agent.invoke("Run work."), cancel);
        let result = result.unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn, "{after_current_tools}");
        assert_eq!(result.last_message().text(), "Task admitted.");
        assert!(deliveries(&agent).is_empty());
        assert_eq!(model.call_count(), 2);

        let continued = agent.invoke("Continue.").await.unwrap();

        assert_eq!(continued.stop_reason(), StopReason::EndTurn);
        assert_eq!(deliveries(&agent).len(), 1);
        assert!(persisted(&agent).is_none());
    }
}

#[test]
fn ignores_cancel_background_tasks_before_the_agent_has_initialized() {
    let agent = background_agent(MockModel::new(), Vec::new(), BackgroundTasksConfig::default());
    agent.cancel_handle().cancel(cancel_background());
}

#[tokio::test]
async fn only_cancels_the_invocation_when_background_tasks_are_disabled() {
    let stop = tool("stop", |_, context| {
        context.agent().cancel(cancel_background());
        json!("stopped")
    });
    let model = MockModel::from_turns([uses(&[("stop", "stop-use", json!({}))]), MockTurn::text("unreachable")]);
    let mut agent = Agent::new(AgentConfig {
        model: Some(model.into()),
        tools: vec![stop.into()],
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();

    let result = agent.invoke("Stop.").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    agent.cancel_handle().cancel(cancel_background());
}

#[tokio::test]
async fn cancels_every_non_terminal_task_synchronously_including_ones_not_yet_notified() {
    let manager = manager();
    let tool = work(|input, context| async move {
        if input["value"] == "done" {
            return Ok(json!("done"));
        }
        context.cancel_signal().cancelled().await;
        Ok(json!("late"))
    });
    let done = submit_work(&manager, &tool, "done", "tool-use-done", "pass-done");
    manager.wait(&done.task_id).await.unwrap();
    let pending = [
        submit_work(&manager, &tool, "a", "tool-use-a", "pass-a"),
        submit_work(&manager, &tool, "b", "tool-use-b", "pass-b"),
    ];

    manager.cancel_all();

    let statuses: Vec<(String, BackgroundTaskStatus)> = manager
        .list()
        .into_iter()
        .map(|task| (task.task_id, task.status))
        .collect();
    assert_eq!(
        statuses,
        [
            (done.task_id, BackgroundTaskStatus::Completed),
            (pending[0].task_id.clone(), BackgroundTaskStatus::Cancelled),
            (pending[1].task_id.clone(), BackgroundTaskStatus::Cancelled),
        ]
    );
    manager.wait_for_idle(None).await.unwrap();
}

#[tokio::test]
async fn returns_a_cancelled_task_unchanged_instead_of_resuming_it() {
    let executions = Arc::new(AtomicUsize::new(0));
    let counted = executions.clone();
    let (engine, _) = engine_with(
        move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(ExecutionOutcome::InputRequired(interrupt_state("waiting"))) })
        },
        2,
        None,
    );
    let task = engine.submit(admission("work"));
    engine.wait_for_idle().await;
    let cancelled = engine.cancel(&task.task_id, "stop").unwrap();

    let resumed = engine.resume(&task.task_id, |state| Ok((state, true))).unwrap();
    engine.wait_for_idle().await;

    assert_eq!(resumed, cancelled);
    assert_eq!(
        engine.get(&task.task_id).unwrap().status,
        BackgroundTaskStatus::Cancelled
    );
    assert_eq!(executions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_resuming_a_working_task() {
    let gate = Gate::default();
    let (engine, _) = gated_engine(&gate, 2, None);
    let task = engine.submit(admission("work"));

    let error = engine.resume(&task.task_id, |state| Ok((state, true))).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("cannot be resumed: status is 'working', not 'input_required'"),
        "{error}"
    );

    gate.release(ExecutionOutcome::Completed(result("done")));
    engine.wait_for_idle().await;
}
