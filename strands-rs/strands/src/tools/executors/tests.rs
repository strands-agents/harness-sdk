use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::{FutureExt, StreamExt};
use indexmap::IndexMap;
use serde_json::json;
use tokio::sync::{Notify, oneshot};

use super::executor::{BatchOutcome, CallOutcome, EventSink, ExecutorItem, ToolBatch, ToolPipelineFn};
use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::interrupt::{Interrupt, InterruptSource};
use crate::tools::ToolOutcome;
use crate::types::{ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUseBlock};

fn uses(names: &[&str]) -> Vec<ToolUseBlock> {
    names
        .iter()
        .map(|name| ToolUseBlock::new(*name, format!("{name}-1"), json!({})))
        .collect()
}

fn batch(names: &[&str]) -> ToolBatch {
    ToolBatch {
        tool_uses: uses(names),
        completed: IndexMap::new(),
        cancel_signal: CancelHandle::new().signal(),
    }
}

fn ok(tool_use: &ToolUseBlock, text: &str) -> ToolOutcome {
    ToolResultBlock::success(tool_use.tool_use_id.clone(), vec![ToolResultContent::text(text)]).into()
}

fn pipeline<F, Fut>(f: F) -> ToolPipelineFn<String>
where
    F: Fn(ToolUseBlock, EventSink<String>) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ToolOutcome> + Send + 'static,
{
    Arc::new(move |tool_use, sink| Box::pin(f(tool_use, sink).map(CallOutcome::from)))
}

#[derive(Debug, Default)]
struct Run {
    items: Vec<String>,
    outcome: BatchOutcome,
}

async fn run(strategy: ToolExecutorStrategy, batch: ToolBatch, pipeline: ToolPipelineFn<String>) -> Run {
    let mut stream = strategy.execute(batch, pipeline);
    let mut run = Run::default();
    while let Some(item) = stream.next().await {
        match item {
            ExecutorItem::Event(event) => run.items.push(event),
            ExecutorItem::Result(result) => run.items.push(format!("result:{}", result.tool_use_id)),
            ExecutorItem::Done(outcome) => run.outcome = outcome,
        }
    }
    run
}

fn texts(results: &[ToolResultBlock]) -> Vec<String> {
    results
        .iter()
        .map(|result| match &result.content[..] {
            [ToolResultContent::Text(text)] => format!("{}:{}", result.tool_use_id, text.text),
            _ => result.tool_use_id.clone(),
        })
        .collect()
}

#[tokio::test]
async fn concurrent_calls_run_together_and_keep_per_call_event_order() {
    let started = Arc::new(Notify::new());
    let gate = started.clone();
    let pipeline = pipeline(move |tool_use, sink| {
        let gate = gate.clone();
        async move {
            sink.send(format!("{}:start", tool_use.name)).await;
            if tool_use.name == "slow" {
                gate.notified().await;
            } else {
                gate.notify_one();
            }
            sink.send(format!("{}:end", tool_use.name)).await;
            ok(&tool_use, &tool_use.name)
        }
    });
    let run = run(ToolExecutorStrategy::Concurrent, batch(&["slow", "fast"]), pipeline).await;

    let position = |item: &str| run.items.iter().position(|seen| seen == item).unwrap();
    assert!(position("fast:end") < position("slow:end"));
    assert!(position("slow:start") < position("slow:end"));
    assert!(position("slow:end") < position("result:slow-1"));
    assert!(position("result:fast-1") < position("result:slow-1"));
    assert_eq!(texts(&run.outcome.results), ["slow-1:slow", "fast-1:fast"]);
    assert!(run.outcome.interrupts.is_empty());
}

fn interrupt(tool_use: &ToolUseBlock) -> ToolOutcome {
    Interrupt::new(format!("tool:{}:confirm", tool_use.tool_use_id), "confirm")
        .with_source(InterruptSource::Tool)
        .into()
}

#[tokio::test]
async fn concurrent_lets_siblings_finish_before_an_interrupt_propagates() {
    let pipeline = pipeline(|tool_use, _| async move {
        if tool_use.name == "ask" {
            return interrupt(&tool_use);
        }
        tokio::task::yield_now().await;
        ok(&tool_use, "done")
    });
    let run = run(ToolExecutorStrategy::Concurrent, batch(&["ask", "work"]), pipeline).await;

    assert_eq!(run.items, ["result:work-1"]);
    assert_eq!(
        texts(&run.outcome.results),
        ["ask-1:Tool execution interrupted", "work-1:done"]
    );
    assert_eq!(run.outcome.completed.keys().collect::<Vec<_>>(), ["work-1"]);
    assert_eq!(run.outcome.interrupts.len(), 1);
    assert_eq!(run.outcome.interrupts[0].id, "tool:ask-1:confirm");
}

#[tokio::test]
#[should_panic(expected = "hook exploded")]
async fn concurrent_resumes_a_pipeline_panic_on_the_caller() {
    let pipeline = pipeline(|tool_use, sink| async move {
        if tool_use.name == "boom" {
            sink.send("boom:before".to_owned()).await;
            panic!("hook exploded");
        }
        ok(&tool_use, "fine")
    });
    run(ToolExecutorStrategy::Concurrent, batch(&["boom", "fine"]), pipeline).await;
}

fn failing_pipeline(failing: &'static str) -> ToolPipelineFn<String> {
    Arc::new(move |tool_use, _sink| {
        Box::pin(async move {
            if tool_use.name == failing {
                return CallOutcome::Error(crate::Error::other("hook failed"));
            }
            CallOutcome::from(ok(&tool_use, "fine"))
        })
    })
}

#[tokio::test]
async fn concurrent_stops_the_batch_at_a_hook_error() {
    let run = run(
        ToolExecutorStrategy::Concurrent,
        batch(&["bad"]),
        failing_pipeline("bad"),
    )
    .await;
    assert_eq!(run.outcome.error.unwrap().to_string(), "hook failed");
    assert_eq!(texts(&run.outcome.results), ["bad-1:Tool execution interrupted"]);
}

#[tokio::test]
async fn sequential_stops_the_batch_at_a_hook_error() {
    let run = run(
        ToolExecutorStrategy::Sequential,
        batch(&["first", "bad", "never"]),
        failing_pipeline("bad"),
    )
    .await;
    assert_eq!(run.outcome.error.unwrap().to_string(), "hook failed");
    assert_eq!(texts(&run.outcome.results), ["first-1:fine"]);
    assert_eq!(run.items, ["result:first-1"]);
}

#[tokio::test]
async fn a_tool_produces_events_only_as_fast_as_the_batch_is_consumed() {
    let produced = Arc::new(AtomicUsize::new(0));
    let counter = produced.clone();
    let pipeline = pipeline(move |tool_use, sink| {
        let counter = counter.clone();
        async move {
            for index in 0..100 {
                counter.fetch_add(1, Ordering::SeqCst);
                sink.send(format!("event-{index}")).await;
            }
            ok(&tool_use, "done")
        }
    });
    let mut stream = ToolExecutorStrategy::Concurrent.execute(batch(&["chatty"]), pipeline);
    let first = stream.next().await;
    assert!(matches!(first, Some(ExecutorItem::Event(_))));
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(
        produced.load(Ordering::SeqCst) <= 3,
        "{}",
        produced.load(Ordering::SeqCst)
    );
}

#[tokio::test]
async fn concurrent_skips_restored_results_without_events() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let pipeline = pipeline(move |tool_use, sink| {
        counted.fetch_add(1, Ordering::SeqCst);
        async move {
            sink.send(tool_use.name.clone()).await;
            ok(&tool_use, "new")
        }
    });
    let mut batch = batch(&["restored", "fresh"]);
    let restored = ToolResultBlock::success("restored-1", vec![ToolResultContent::text("old")]);
    batch.completed.insert("restored-1".into(), restored);
    let run = run(ToolExecutorStrategy::Concurrent, batch, pipeline).await;

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(run.items, ["fresh", "result:fresh-1"]);
    assert_eq!(texts(&run.outcome.results), ["restored-1:old", "fresh-1:new"]);
    assert_eq!(run.outcome.completed.len(), 2);
}

#[tokio::test]
async fn concurrent_aborts_calls_in_flight_when_the_stream_is_dropped() {
    let (dropped_tx, dropped_rx) = oneshot::channel::<()>();
    let guard = Arc::new(Mutex::new(Some(dropped_tx)));
    let pipeline = pipeline(move |tool_use, sink| {
        let held = guard.lock().unwrap().take();
        async move {
            let _held = held;
            sink.send("started".to_owned()).await;
            std::future::pending::<()>().await;
            ok(&tool_use, "never")
        }
    });
    let mut stream = ToolExecutorStrategy::Concurrent.execute(batch(&["hang"]), pipeline);
    assert!(matches!(stream.next().await, Some(ExecutorItem::Event(event)) if event == "started"));
    drop(stream);
    assert!(dropped_rx.await.is_err());
}

#[tokio::test]
async fn sequential_runs_calls_one_at_a_time_in_order() {
    let running = Arc::new(AtomicUsize::new(0));
    let active = running.clone();
    let pipeline = pipeline(move |tool_use, sink| {
        let active = active.clone();
        async move {
            assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
            sink.send(format!("{}:run", tool_use.name)).await;
            tokio::task::yield_now().await;
            active.fetch_sub(1, Ordering::SeqCst);
            ok(&tool_use, &tool_use.name)
        }
    });
    let run = run(ToolExecutorStrategy::Sequential, batch(&["a", "b"]), pipeline).await;

    assert_eq!(run.items, ["a:run", "result:a-1", "b:run", "result:b-1"]);
    assert_eq!(texts(&run.outcome.results), ["a-1:a", "b-1:b"]);
}

#[tokio::test]
async fn uses_the_supplied_signal_between_sequential_tool_executions() {
    let handle = CancelHandle::new();
    let executed = Arc::new(Mutex::new(Vec::new()));
    let (cancel, seen) = (handle.clone(), executed.clone());
    let pipeline = pipeline(move |tool_use, _| {
        seen.lock().unwrap().push(tool_use.name.clone());
        cancel.cancel(CancelOptions::default());
        async move { ok(&tool_use, "done") }
    });
    let batch = ToolBatch {
        cancel_signal: handle.signal(),
        ..batch(&["first", "second"])
    };
    let run = run(ToolExecutorStrategy::Sequential, batch, pipeline).await;

    assert_eq!(*executed.lock().unwrap(), ["first"]);
    assert_eq!(
        texts(&run.outcome.results),
        ["first-1:done", "second-1:Tool execution cancelled"]
    );
    assert_eq!(run.outcome.results[1].status, ToolResultStatus::Error);
    assert_eq!(run.items, ["result:first-1", "result:second-1"]);
}

#[tokio::test]
async fn sequential_stops_at_an_interrupt() {
    let pipeline = pipeline(|tool_use, _| async move {
        match tool_use.name.as_str() {
            "ask" => interrupt(&tool_use),
            _ => ok(&tool_use, "done"),
        }
    });
    let run = run(
        ToolExecutorStrategy::Sequential,
        batch(&["work", "ask", "later"]),
        pipeline,
    )
    .await;

    assert_eq!(run.items, ["result:work-1"]);
    assert_eq!(texts(&run.outcome.results), ["work-1:done"]);
    assert_eq!(run.outcome.completed.keys().collect::<Vec<_>>(), ["work-1"]);
    assert_eq!(run.outcome.interrupts[0].id, "tool:ask-1:confirm");
}

#[tokio::test]
#[should_panic(expected = "owned panic")]
async fn sequential_resumes_a_pipeline_panic_on_the_caller() {
    let pipeline = pipeline(|tool_use, _| async move {
        if tool_use.name == "boom" {
            panic!("{}", String::from("owned panic"));
        }
        ok(&tool_use, "after")
    });
    run(ToolExecutorStrategy::Sequential, batch(&["boom", "next"]), pipeline).await;
}

#[tokio::test]
async fn sequential_keeps_restored_results_in_place() {
    let pipeline = pipeline(|tool_use, _| async move { ok(&tool_use, "new") });
    let mut batch = batch(&["restored", "fresh"]);
    let restored = ToolResultBlock::success("restored-1", vec![ToolResultContent::text("old")]);
    batch.completed.insert("restored-1".into(), restored);
    let run = run(ToolExecutorStrategy::Sequential, batch, pipeline).await;

    assert_eq!(run.items, ["result:fresh-1"]);
    assert_eq!(texts(&run.outcome.results), ["restored-1:old", "fresh-1:new"]);
}

#[test]
fn strategy_defaults_to_concurrent_and_converts_from_executors() {
    assert_eq!(ToolExecutorStrategy::default(), ToolExecutorStrategy::Concurrent);
    assert_eq!(
        ToolExecutorStrategy::from(SequentialToolExecutor::new()),
        ToolExecutorStrategy::Sequential
    );
    assert_eq!(
        ToolExecutorStrategy::from(ConcurrentToolExecutor::new()),
        ToolExecutorStrategy::Concurrent
    );
}
