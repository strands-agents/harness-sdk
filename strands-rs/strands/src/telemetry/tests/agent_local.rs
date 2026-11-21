//! Agent telemetry that needs no OpenTelemetry layer (Rust-only): what a `fmt` subscriber logs
//! of the agent's spans, the span tool-call hooks run in, and the order of local tool traces.

use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::sync::Notify;
use tracing::Instrument;

use crate::hooks::BeforeToolCallEvent;
use crate::test_support::{MockTool, record_logs};
use crate::testing::{MockModel, MockTurn};
use crate::tools::ToolExecutorStrategy;
use crate::types::{ContentBlock, ToolResultBlock, ToolUseBlock};
use crate::{Agent, ToolSource};

#[tokio::test]
async fn keeps_message_content_out_of_span_fields() {
    let (logs, _guard) = record_logs();
    let tool = MockTool::new("loud").with_result(|context| {
        tracing::info!("tool_use_id=<{}> | hello from tool", context.tool_use().tool_use_id);
        ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into()
    });
    let model = MockModel::new()
        .with_turn(MockTurn::content([ToolUseBlock::new(
            "loud",
            "t1",
            json!({"secret": "s3cr3t"}),
        )]))
        .with_turn("ok");
    let mut agent = Agent::builder()
        .model(model)
        .tools([ToolSource::from(tool)])
        .system_prompt("SYSTEM PROMPT TEXT")
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("user says hi").await.unwrap();
    let text = logs.text();
    let line = text
        .lines()
        .find(|line| line.contains("hello from tool"))
        .unwrap_or_else(|| panic!("no tool log line in {text}"));
    assert!(line.contains("execute_tool{"), "{line}");
    assert!(line.contains("gen_ai.tool.call.id=\"t1\""), "{line}");
    for content in ["SYSTEM PROMPT TEXT", "s3cr3t", "user says hi"] {
        assert!(!text.contains(content), "{content} leaked into {text}");
    }
}

#[tokio::test]
async fn runs_tool_call_hooks_in_the_caller_span_with_either_executor() {
    let (_logs, _guard) = record_logs();
    for executor in [ToolExecutorStrategy::Sequential, ToolExecutorStrategy::Concurrent] {
        let seen: Arc<Mutex<Vec<Option<&'static str>>>> = Arc::default();
        let model = MockModel::new()
            .with_turn(MockTurn::content([ToolUseBlock::new("probe", "t1", json!({}))]))
            .with_turn("ok");
        let mut agent = Agent::builder()
            .model(model)
            .tools([ToolSource::from(MockTool::new("probe"))])
            .tool_executor(executor)
            .printer(false)
            .build()
            .unwrap();
        let slot = seen.clone();
        agent.add_hook(move |_: &mut BeforeToolCallEvent| {
            slot.lock()
                .unwrap()
                .push(tracing::Span::current().metadata().map(|metadata| metadata.name()));
        });
        agent
            .invoke("hi")
            .instrument(tracing::info_span!("request"))
            .await
            .unwrap();
        assert_eq!(*seen.lock().unwrap(), [Some("request")], "{executor:?}");
    }
}

#[tokio::test]
async fn orders_concurrent_tool_traces_by_call() {
    let second_ran = Arc::new(Notify::new());
    let signal = second_ran.clone();
    let second = MockTool::new("tool2").with_result(move |context| {
        signal.notify_one();
        ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into()
    });
    let model = MockModel::new()
        .with_turn(MockTurn::content([
            ContentBlock::from(ToolUseBlock::new("tool1", "id-1", json!({}))),
            ContentBlock::from(ToolUseBlock::new("tool2", "id-2", json!({}))),
        ]))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([ToolSource::from(MockTool::new("tool1")), ToolSource::from(second)])
        .tool_executor(ToolExecutorStrategy::Concurrent)
        .printer(false)
        .build()
        .unwrap();
    agent.add_async_hook::<BeforeToolCallEvent>(move |event| {
        let wait = (event.tool_use().name == "tool1").then(|| second_ran.clone());
        Box::pin(async move {
            if let Some(wait) = wait {
                wait.notified().await;
            }
        })
    });
    let result = agent.invoke("Use tools").await.unwrap();
    let traces = result.traces().unwrap();
    let children: Vec<&str> = traces[0].children.iter().map(|child| child.name.as_str()).collect();
    assert_eq!(children, ["stream_messages", "Tool: tool1", "Tool: tool2"]);
    assert!(traces[0].children.iter().all(|child| child.end_time.is_some()));
}
