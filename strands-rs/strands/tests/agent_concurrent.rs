//! Tool executor strategies through the agent. [`ToolExecutorStrategy`] is an enum, so an unknown
//! executor is a compile error, as is concurrent invocation of one agent (`invoke` takes
//! `&mut self`).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::gated::{GatedStreamingTool, GatedTool};
use common::{MockTool, tool_use_turn, tool_uses_turn};
use futures::StreamExt;
use serde_json::json;
use strands::hooks::{
    AfterToolCallEvent, AfterToolsEvent, BeforeToolCallEvent, BeforeToolsEvent, ToolResultEvent, ToolStreamUpdateEvent,
};
use strands::middleware::{ExecuteToolStage, StageStream};
use strands::testing::MockModel;
use strands::tools::{ConcurrentToolExecutor, SequentialToolExecutor, ToolExecutorStrategy};
use strands::types::{InterruptParams, ToolResultContent, ToolResultStatus};
use strands::{
    Agent, AgentStreamEvent, CancelOptions, ContentBlock, Message, StopReason, ToolOutcome, ToolResultBlock,
    ToolSource, ToolUse,
};
use tokio::sync::Notify;

fn two_tool_turn() -> MockModel {
    MockModel::new()
        .with_turn(tool_uses_turn(&[("toolA", "a"), ("toolB", "b")]))
        .with_turn("Done")
}

fn agent(model: MockModel, tools: Vec<ToolSource>, executor: Option<ToolExecutorStrategy>) -> Agent {
    Agent::builder()
        .model(model)
        .tools(tools)
        .printer(false)
        .maybe_tool_executor(executor)
        .build()
        .unwrap()
}

fn gated_pair() -> (GatedTool, GatedTool) {
    (GatedTool::new("toolA"), GatedTool::new("toolB"))
}

fn tools(a: &GatedTool, b: &GatedTool) -> Vec<ToolSource> {
    vec![a.clone().into(), b.clone().into()]
}

fn capture_after_tools(agent: &Agent) -> Arc<Mutex<Option<Message>>> {
    let captured: Arc<Mutex<Option<Message>>> = Arc::default();
    let slot = captured.clone();
    agent.add_hook(move |event: &mut AfterToolsEvent<'_>| *slot.lock().unwrap() = Some(event.message().clone()));
    captured
}

fn results(message: &Message) -> Vec<ToolResultBlock> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn uses_concurrent_tool_executor_by_default() {
    let agent = Agent::builder().model(MockModel::new()).printer(false).build().unwrap();
    assert_eq!(agent.tool_executor(), ToolExecutorStrategy::Concurrent);
}

#[test]
fn preserves_a_supplied_tool_executor_instance() {
    let agent = Agent::builder()
        .model(MockModel::new())
        .tool_executor(SequentialToolExecutor::new())
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.tool_executor(), ToolExecutorStrategy::Sequential);
}

#[test]
fn resolves_a_string_shorthand_assigned_to_tool_executor() {
    let mut agent = Agent::builder().model(MockModel::new()).printer(false).build().unwrap();
    agent.set_tool_executor(ToolExecutorStrategy::Sequential);
    assert_eq!(agent.tool_executor(), ToolExecutorStrategy::Sequential);
}

#[tokio::test]
async fn uses_a_reassigned_tool_executor_for_subsequent_tool_calls() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), None);
    agent.set_tool_executor(SequentialToolExecutor::new());

    let driver = async {
        a.started().await;
        assert!(!b.has_started());
        a.release();
        b.started().await;
        b.release();
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();
}

#[tokio::test]
async fn runs_tools_concurrently_by_default() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), None);

    let driver = async {
        tokio::join!(a.started(), b.started());
        assert!(!a.has_completed());
        assert!(!b.has_completed());
        a.release();
        b.release();
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();

    assert!(a.has_completed());
    assert!(b.has_completed());
}

#[tokio::test]
async fn runs_tools_sequentially_with_a_sequential_tool_executor_instance() {
    let (a, b) = gated_pair();
    let mut agent = agent(
        two_tool_turn(),
        tools(&a, &b),
        Some(SequentialToolExecutor::new().into()),
    );

    let driver = async {
        a.started().await;
        assert!(!b.has_started());
        a.release();
        b.started().await;
        b.release();
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();
}

#[derive(Debug, Clone, PartialEq)]
enum Entry {
    Before(String),
    Stream(String),
    After(String),
    Result(String),
}

#[tokio::test]
async fn preserves_per_tool_event_ordering_while_interleaving_across_tools() {
    let a = GatedStreamingTool::new("toolA");
    let b = GatedStreamingTool::new("toolB");
    let mut agent = agent(
        two_tool_turn(),
        vec![a.clone().into(), b.clone().into()],
        Some(ConcurrentToolExecutor::new().into()),
    );
    let entries: Arc<Mutex<Vec<Entry>>> = Arc::default();
    let log = entries.clone();
    agent.add_hook(move |event: &mut BeforeToolCallEvent| {
        log.lock()
            .unwrap()
            .push(Entry::Before(event.tool_use().tool_use_id.clone()));
    });
    let log = entries.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        log.lock()
            .unwrap()
            .push(Entry::After(event.tool_use().tool_use_id.clone()));
    });
    let log = entries.clone();
    agent.add_hook(move |event: &mut ToolResultEvent| {
        log.lock()
            .unwrap()
            .push(Entry::Result(event.result().tool_use_id.clone()));
    });
    let log = entries.clone();
    agent.add_hook(move |event: &mut ToolStreamUpdateEvent| {
        let tool = event
            .event()
            .data
            .as_ref()
            .and_then(|data| data["tool"].as_str())
            .unwrap_or_default();
        log.lock().unwrap().push(Entry::Stream(tool.to_owned()));
    });

    let driver = async {
        for step in 0..3 {
            a.emit(json!({"tool": "toolA", "step": step})).await;
            b.emit(json!({"tool": "toolB", "step": step})).await;
        }
        a.complete().await;
        b.complete().await;
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();

    let entries = entries.lock().unwrap().clone();
    for (id, tool) in [("a", "toolA"), ("b", "toolB")] {
        let own: Vec<&Entry> = entries
            .iter()
            .filter(|entry| match entry {
                Entry::Before(entry_id) | Entry::After(entry_id) | Entry::Result(entry_id) => entry_id == id,
                Entry::Stream(entry_tool) => entry_tool == tool,
            })
            .collect();
        assert_eq!(own.first(), Some(&&Entry::Before(id.to_owned())));
        assert_eq!(
            own[own.len() - 2..],
            [&Entry::After(id.to_owned()), &Entry::Result(id.to_owned())]
        );
        assert!(
            own[1..own.len() - 2]
                .iter()
                .all(|entry| matches!(entry, Entry::Stream(_)))
        );
    }
    let mut runs: Vec<&str> = Vec::new();
    for entry in &entries {
        if let Entry::Stream(tool) = entry
            && runs.last() != Some(&tool.as_str())
        {
            runs.push(tool);
        }
    }
    assert!(runs.len() > 2, "stream events alternated between tools: {runs:?}");
}

#[tokio::test]
async fn retries_one_tool_independently_from_the_other() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    let before_calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = before_calls.clone();
    agent.add_hook(move |event: &mut BeforeToolCallEvent| log.lock().unwrap().push(event.tool_use().name.clone()));
    let retries = AtomicUsize::new(0);
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        if event.tool_use().name == "toolA" && retries.fetch_add(1, Ordering::SeqCst) == 0 {
            event.set_retry(true);
        }
    });

    let driver = async {
        tokio::join!(a.started(), b.started());
        a.release();
        b.release();
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();

    let calls = before_calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|name| *name == "toolA").count(), 2);
    assert_eq!(calls.iter().filter(|name| *name == "toolB").count(), 1);
}

#[tokio::test]
async fn uses_replacement_tool_input_while_preserving_the_model_issued_tool_use_id() {
    let received: Arc<Mutex<Option<ToolUse>>> = Arc::default();
    let slot = received.clone();
    let tool = MockTool::new("captureTool", move |context| {
        *slot.lock().unwrap() = Some(context.tool_use().clone());
        ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("done")],
        )
        .into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn(
            "captureTool",
            "original-id",
            json!({"value": "original"}),
        ))
        .with_turn("Done");
    let mut agent = agent(model, vec![tool.into()], None);
    agent.add_hook(|event: &mut BeforeToolCallEvent| {
        event.set_tool_use(ToolUse::new(
            "captureTool",
            "replacement-id",
            json!({"value": "replacement"}),
        ));
    });

    agent.invoke("Go").await.unwrap();

    assert_eq!(
        *received.lock().unwrap(),
        Some(ToolUse::new(
            "captureTool",
            "original-id",
            json!({"value": "replacement"})
        ))
    );
}

#[tokio::test]
async fn cancels_all_tools_when_before_tools_event_cancel_is_set_concurrent_mode() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    agent.add_hook(|event: &mut BeforeToolsEvent<'_>| event.set_cancel("hook cancelled"));
    let after = capture_after_tools(&agent);

    agent.invoke("Go").await.unwrap();

    assert!(!a.has_started());
    assert!(!b.has_started());
    let results = results(after.lock().unwrap().as_ref().unwrap());
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|result| result.status == ToolResultStatus::Error));
    assert_eq!(results[0].tool_use_id, "a");
    assert_eq!(results[1].tool_use_id, "b");
}

#[tokio::test]
async fn cancels_all_tools_when_agent_is_cancelled_before_launch_concurrent_mode() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    agent.add_hook(|event: &mut BeforeToolsEvent<'_>| event.agent().cancel(CancelOptions::default()));

    agent.invoke("Go").await.unwrap();

    assert!(!a.has_started());
    assert!(!b.has_started());
}

#[tokio::test]
async fn cooperative_mid_flight_cancel_tools_honor_cancel_signal_and_exit() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    let cancel = agent.cancel_handle();

    let driver = async {
        tokio::join!(a.started(), b.started());
        cancel.cancel(CancelOptions::default());
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();

    assert!(a.was_cancelled());
    assert!(b.was_cancelled());
}

/// Rust tools cannot throw; a panicking tool is the failure the executor isolates.
#[tokio::test]
async fn handles_a_throwing_tool_without_affecting_siblings() {
    let b = GatedTool::new("toolB");
    let a = MockTool::new("toolA", |_| panic!("boom"));
    let mut agent = agent(
        two_tool_turn(),
        vec![a.into(), b.clone().into()],
        Some(ToolExecutorStrategy::Concurrent),
    );
    let after = capture_after_tools(&agent);

    let driver = async {
        b.started().await;
        b.release();
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();

    let mut results = results(after.lock().unwrap().as_ref().unwrap());
    results.sort_by(|x, y| x.tool_use_id.cmp(&y.tool_use_id));
    assert_eq!(results[0].status, ToolResultStatus::Error);
    assert_eq!(results[0].content, vec![ToolResultContent::text("boom")]);
    assert_eq!(results[1].status, ToolResultStatus::Success);
}

#[tokio::test]
async fn isolates_unexpected_middleware_failures_to_the_affected_tool() {
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("tool", "failed-tool"), ("tool", "successful-tool")]))
        .with_turn("Done");
    let tool = MockTool::new("tool", |context| {
        let id = context.tool_use().tool_use_id.clone();
        ToolResultBlock::success(id.clone(), vec![ToolResultContent::text(format!("completed:{id}"))]).into()
    });
    let mut agent = Agent::builder()
        .model(model)
        .tools([tool])
        .tool_executor(ToolExecutorStrategy::Concurrent)
        .printer(false)
        .build()
        .unwrap();
    agent.add_middleware(ExecuteToolStage::wrap(|context, next| {
        if context.tool_use.tool_use_id == "failed-tool" {
            return StageStream::from_result(Err(strands::Error::other("middleware failed").into()));
        }
        next.call(context)
    }));
    let message = Arc::new(Mutex::new(None));
    let slot = message.clone();
    agent.add_hook(move |event: &mut AfterToolsEvent<'_>| *slot.lock().unwrap() = Some(event.message().clone()));

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    let message = message.lock().unwrap().take().unwrap();
    let summary: Vec<_> = message
        .content
        .iter()
        .map(|block| {
            let ContentBlock::ToolResult(result) = block else {
                panic!("expected tool results");
            };
            (
                result.tool_use_id.clone(),
                result.status,
                result.content[0].clone(),
                result.error.as_ref().map(ToString::to_string),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (
                "failed-tool".to_owned(),
                ToolResultStatus::Error,
                ToolResultContent::text("middleware failed"),
                Some("middleware failed".to_owned())
            ),
            (
                "successful-tool".to_owned(),
                ToolResultStatus::Success,
                ToolResultContent::text("completed:successful-tool"),
                None
            ),
        ]
    );
}

#[tokio::test]
async fn handles_a_hallucinated_tool_name_in_a_batch_without_affecting_siblings() {
    let a = GatedTool::new("toolA");
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("toolA", "a"), ("unknownTool", "b")]))
        .with_turn("Done");
    let mut agent = agent(model, vec![a.clone().into()], Some(ToolExecutorStrategy::Concurrent));
    let after = capture_after_tools(&agent);

    let driver = async {
        a.started().await;
        a.release();
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();

    let results = results(after.lock().unwrap().as_ref().unwrap());
    assert_eq!(results.len(), 2);
    let by_id = |id: &str| results.iter().find(|result| result.tool_use_id == id).unwrap().status;
    assert_eq!(by_id("a"), ToolResultStatus::Success);
    assert_eq!(by_id("b"), ToolResultStatus::Error);
}

#[tokio::test]
async fn preserves_source_order_of_tool_results_in_after_tools_event_message() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    let b_done = Arc::new(Notify::new());
    let notify = b_done.clone();
    agent.add_hook(move |event: &mut ToolResultEvent| {
        if event.result().tool_use_id == "b" {
            notify.notify_one();
        }
    });
    let after = capture_after_tools(&agent);

    let driver = async {
        tokio::join!(a.started(), b.started());
        b.release();
        b_done.notified().await;
        a.release();
    };
    let (result, ()) = tokio::join!(agent.invoke("Go"), driver);
    result.unwrap();

    let ids: Vec<String> = results(after.lock().unwrap().as_ref().unwrap())
        .into_iter()
        .map(|result| result.tool_use_id)
        .collect();
    assert_eq!(ids, ["a", "b"]);
}

/// Drops the stream at the first `ToolResultEvent` (tool `a`), with tool `b` still parked.
async fn drop_at_first_tool_result(agent: &mut Agent, cancel_first: bool) {
    let handle = agent.cancel_handle();
    let mut stream = agent.stream("Go");
    while let Some(event) = stream.next().await {
        if matches!(event.unwrap(), AgentStreamEvent::ToolResult(_)) {
            if cancel_first {
                handle.cancel(CancelOptions::default());
            }
            break;
        }
    }
}

/// Dropping the stream drops the loop, so the batch ends there: `AfterToolsEvent` does not fire
/// and history keeps no half-finished tool turn.
#[tokio::test]
async fn after_tools_event_message_contains_completed_results_when_consumer_breaks_mid_stream() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    agent.add_hook(move |event: &mut BeforeToolCallEvent| {
        if event.tool_use().name == "toolA" {
            a.release();
        }
    });
    let after = capture_after_tools(&agent);

    drop_at_first_tool_result(&mut agent, true).await;

    assert!(after.lock().unwrap().is_none());
    let messages = agent.messages();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].text(), "Cancelled by user");
    assert!(!b.has_completed());
}

#[tokio::test]
async fn closes_in_flight_generators_and_includes_fallback_results_when_consumer_breaks() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    let release_a = a.clone();
    agent.add_hook(move |event: &mut BeforeToolCallEvent| {
        if event.tool_use().name == "toolA" {
            release_a.release();
        }
    });

    drop_at_first_tool_result(&mut agent, false).await;
    b.release();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    assert!(a.has_completed());
    assert!(b.has_started());
    assert!(
        !b.has_completed(),
        "the in-flight tool task was aborted with the stream"
    );
    assert!(!b.was_cancelled());
    let messages = agent.messages();
    assert!(messages.iter().all(|message| {
        !message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse(_)))
    }));
    assert_eq!(messages.last().unwrap().text(), "Cancelled by user");
}

#[tokio::test]
async fn pre_launch_agent_cancel_during_before_tools_event_produces_tool_execution_cancelled_concurrent() {
    let (a, b) = gated_pair();
    let mut agent = agent(two_tool_turn(), tools(&a, &b), Some(ToolExecutorStrategy::Concurrent));
    agent.add_hook(|event: &mut BeforeToolsEvent<'_>| event.agent().cancel(CancelOptions::default()));
    let after = capture_after_tools(&agent);

    agent.invoke("Go").await.unwrap();

    assert!(!a.has_started());
    assert!(!b.has_started());
    let results = results(after.lock().unwrap().as_ref().unwrap());
    assert_eq!(results.len(), 2);
    for result in results {
        assert_eq!(
            result.content,
            vec![ToolResultContent::text("Tool execution cancelled")]
        );
    }
}

/// The span half of this case is `ends_the_tool_span_without_a_result_or_error_when_a_tool_interrupts` in
/// `src/telemetry/tests/agent.rs`, which reads the exported spans.
#[tokio::test]
async fn records_span_and_metric_telemetry_when_a_tool_interrupts() {
    let tool = MockTool::new("approvalTool", |context| {
        match context.interrupt(InterruptParams::new("approve").with_reason("Approve this tool call?")) {
            Ok(_) => ToolResultBlock::success(context.tool_use().tool_use_id.clone(), Vec::new()).into(),
            Err(interrupt) => ToolOutcome::Interrupt(interrupt),
        }
    });
    let model = MockModel::new().with_turn(tool_use_turn("approvalTool", "tool-1", json!({})));
    let mut agent = agent(model, vec![tool.into()], None);

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    let metrics = agent.metrics();
    let tool_metrics = metrics.tool("approvalTool").unwrap();
    assert_eq!(
        (
            tool_metrics.call_count,
            tool_metrics.success_count,
            tool_metrics.error_count
        ),
        (1, 0, 1)
    );
}
