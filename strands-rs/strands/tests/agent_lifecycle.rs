//! The stream drop guard and the agent lifecycle. Dropping a stream drops the loop's future; a
//! drop guard repairs history and the async hooks run at the start of the next `invoke`, `stream`
//! or `shutdown`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests report failures by panicking"
)]

mod common;

use std::io;
use std::sync::{Arc, Mutex};

use common::gated::GatedTool;
use common::{texts, tool_use_turn};
use futures::StreamExt;
use serde_json::json;
use strands::hooks::{AfterInvocationEvent, BeforeInvocationEvent, MessageAddedEvent};
use strands::testing::{MockModel, test_agent};
use strands::tools::STRUCTURED_OUTPUT_TOOL_NAME;
use strands::{Agent, AgentStreamEvent, CancelOptions, ContentBlock, Role, StopReason};

type Log = Arc<Mutex<Vec<String>>>;

/// Records `BeforeInvocation`, `MessageAdded:<text>` and `AfterInvocation` in firing order.
fn record_lifecycle(agent: &Agent) -> Log {
    let log: Log = Arc::default();
    let entries = log.clone();
    agent.add_hook(move |_: &mut BeforeInvocationEvent<'_>| entries.lock().unwrap().push("BeforeInvocation".into()));
    let entries = log.clone();
    agent.add_hook(move |event: &mut MessageAddedEvent<'_>| {
        entries
            .lock()
            .unwrap()
            .push(format!("MessageAdded:{}", event.message().text()));
    });
    let entries = log.clone();
    agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| entries.lock().unwrap().push("AfterInvocation".into()));
    log
}

fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

/// Polls the stream until `stop` matches a record, then drops it.
async fn drop_at(agent: &mut Agent, prompt: &str, stop: impl Fn(&AgentStreamEvent) -> bool) {
    let mut stream = agent.stream(prompt);
    while let Some(event) = stream.next().await {
        if stop(&event.unwrap()) {
            break;
        }
    }
}

fn is_stream_update(event: &AgentStreamEvent) -> bool {
    matches!(event, AgentStreamEvent::ModelStreamUpdate(_))
}

#[tokio::test]
async fn dropping_the_stream_mid_model_stream_closes_the_open_user_turn() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story..."));

    drop_at(&mut agent, "Write a story", is_stream_update).await;

    assert_eq!(texts(&agent), ["Write a story", "Cancelled by user"]);
    assert_eq!(agent.messages()[1].role, Role::Assistant);
}

#[tokio::test]
async fn dropping_the_stream_uses_the_cancel_message() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story..."));
    let cancel = agent.cancel_handle();

    drop_at(&mut agent, "Write a story", |event| {
        if is_stream_update(event) {
            cancel.cancel(CancelOptions::builder().message("Stopped by the operator").build());
            return true;
        }
        false
    })
    .await;

    assert_eq!(texts(&agent), ["Write a story", "Stopped by the operator"]);
}

#[tokio::test]
async fn dropping_the_stream_mid_tools_aborts_in_flight_tools_and_leaves_no_dangling_tool_use() {
    let tool = GatedTool::new("slow");
    let model = MockModel::new()
        .with_turn(tool_use_turn("slow", "t-1", json!({})))
        .with_turn("unreachable");
    let mut agent = Agent::builder()
        .model(model.clone())
        .tools([tool.clone()])
        .printer(false)
        .build()
        .unwrap();

    {
        let mut stream = agent.stream("Go");
        while let Some(event) = stream.next().await {
            if matches!(event.unwrap(), AgentStreamEvent::BeforeToolCall(_)) {
                break;
            }
        }
        tool.started().await;
    }
    tool.release();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    assert!(tool.has_started());
    assert!(
        !tool.has_completed(),
        "the tool task was aborted when the stream dropped"
    );
    assert_eq!(texts(&agent), ["Go", "Cancelled by user"]);
    assert!(agent.messages().iter().all(|message| {
        !message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse(_)))
    }));
    assert_eq!(model.requests().len(), 1);
}

#[tokio::test]
async fn defers_after_invocation_and_message_added_hooks_to_the_next_invoke() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story...").with_turn("Second"));
    let log = record_lifecycle(&agent);

    drop_at(&mut agent, "First", is_stream_update).await;
    assert_eq!(entries(&log), ["BeforeInvocation", "MessageAdded:First"]);

    agent.invoke("Again").await.unwrap();

    assert_eq!(
        entries(&log),
        [
            "BeforeInvocation",
            "MessageAdded:First",
            "MessageAdded:Cancelled by user",
            "AfterInvocation",
            "BeforeInvocation",
            "MessageAdded:Again",
            "MessageAdded:Second",
            "AfterInvocation",
        ]
    );
}

#[tokio::test]
async fn runs_deferred_hooks_at_the_start_of_the_next_stream() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story...").with_turn("Second"));
    let log = record_lifecycle(&agent);

    drop_at(&mut agent, "First", is_stream_update).await;
    {
        let mut stream = agent.stream("Again");
        let first = stream.next().await.unwrap().unwrap();
        assert!(matches!(first, AgentStreamEvent::BeforeInvocation(_)));
    }

    assert_eq!(
        entries(&log)[..5],
        [
            "BeforeInvocation",
            "MessageAdded:First",
            "MessageAdded:Cancelled by user",
            "AfterInvocation",
            "BeforeInvocation",
        ]
    );
}

#[tokio::test]
async fn shutdown_runs_the_deferred_hooks_once() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story..."));
    let log = record_lifecycle(&agent);

    drop_at(&mut agent, "First", is_stream_update).await;
    agent.shutdown().await.unwrap();
    agent.shutdown().await.unwrap();

    assert_eq!(
        entries(&log),
        [
            "BeforeInvocation",
            "MessageAdded:First",
            "MessageAdded:Cancelled by user",
            "AfterInvocation",
        ]
    );
}

#[tokio::test]
async fn shutdown_is_a_noop_without_pending_work() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = record_lifecycle(&agent);
    agent.invoke("Hi").await.unwrap();
    let before = entries(&log);

    agent.shutdown().await.unwrap();
    agent.shutdown().await.unwrap();

    assert_eq!(entries(&log), before);
}

#[tokio::test]
async fn dropping_the_stream_before_it_is_polled_leaves_the_agent_untouched() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = record_lifecycle(&agent);

    drop(agent.stream("Hi"));
    agent.shutdown().await.unwrap();

    assert!(agent.messages().is_empty());
    assert!(entries(&log).is_empty());
}

/// `AfterInvocationEvent` pairs with a `BeforeInvocationEvent` whose record the
/// consumer let pass; dropping at that record runs no after-invocation hooks.
#[tokio::test]
async fn dropping_at_the_before_invocation_record_defers_no_after_invocation_event() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = record_lifecycle(&agent);

    drop_at(&mut agent, "Hi", |event| {
        matches!(event, AgentStreamEvent::BeforeInvocation(_))
    })
    .await;
    agent.shutdown().await.unwrap();

    assert_eq!(entries(&log), ["BeforeInvocation"]);
    assert!(agent.messages().is_empty());
}

#[tokio::test]
async fn dropping_at_the_agent_result_record_leaves_nothing_pending() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = record_lifecycle(&agent);

    drop_at(&mut agent, "Hi", |event| {
        matches!(event, AgentStreamEvent::AgentResult(_))
    })
    .await;
    let after_drop = entries(&log);
    agent.shutdown().await.unwrap();

    assert_eq!(texts(&agent), ["Hi", "Hello"]);
    assert_eq!(entries(&log), after_drop);
    assert_eq!(after_drop.last().map(String::as_str), Some("AfterInvocation"));
}

#[tokio::test]
async fn removes_the_structured_output_tool_when_the_stream_drops() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("not structured"))
        .structured_output_schema_json(json!({"type": "object", "properties": {"value": {"type": "number"}}}))
        .printer(false)
        .build()
        .unwrap();

    drop_at(&mut agent, "Go", is_stream_update).await;

    assert!(agent.tool_registry().get(STRUCTURED_OUTPUT_TOOL_NAME).is_none());
}

#[tokio::test]
async fn the_agent_is_reusable_after_a_drop() {
    let model = MockModel::new().with_turn("A long story...").with_turn("pineapple");
    let mut agent = test_agent(model.clone());

    drop_at(&mut agent, "Write a story", is_stream_update).await;
    let result = agent.invoke("Say pineapple").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        texts(&agent),
        ["Write a story", "Cancelled by user", "Say pineapple", "pineapple"]
    );
    let roles: Vec<Role> = model.requests()[1]
        .messages
        .iter()
        .map(|message| message.role)
        .collect();
    assert_eq!(roles, [Role::User, Role::Assistant, Role::User]);
    assert!(!agent.cancel_signal().is_cancelled());
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn logs_while(f: impl FnOnce()) -> String {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .without_time()
        .with_max_level(tracing::Level::WARN)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        f();
    });
    String::from_utf8(captured.0.lock().unwrap().clone()).unwrap()
}

const PENDING_WARNING: &str = "agent dropped with pending shutdown work";

#[tokio::test]
async fn dropping_an_agent_with_pending_cleanup_warns() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story..."));
    drop_at(&mut agent, "First", is_stream_update).await;

    let logs = logs_while(|| drop(agent));

    assert!(logs.contains("WARN"), "{logs}");
    assert!(logs.contains(PENDING_WARNING), "{logs}");
    assert!(logs.contains("agent_id=<agent>"), "{logs}");
}

#[tokio::test]
async fn dropping_an_agent_without_pending_cleanup_does_not_warn() {
    let mut idle = test_agent(MockModel::new().with_turn("Hello"));
    idle.invoke("Hi").await.unwrap();
    let mut shut_down = test_agent(MockModel::new().with_turn("A long story..."));
    drop_at(&mut shut_down, "First", is_stream_update).await;
    shut_down.shutdown().await.unwrap();

    let logs = logs_while(|| {
        drop(idle);
        drop(shut_down);
    });

    assert!(!logs.contains(PENDING_WARNING), "{logs}");
}
