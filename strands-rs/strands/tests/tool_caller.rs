//! Direct tool calls through `agent.tool("name")`.

#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::{Arc, Mutex};

use futures::StreamExt;
use serde_json::json;
use strands::agent::DirectToolCallOptions;
use strands::hooks::MessageAddedEvent;
use strands::testing::{MockModel, MockTurn, test_agent};
use strands::tool_list;
use strands::tools::{FunctionTool, ToolStream, ToolStreamEvent, ToolStreamItem};
use strands::types::{ToolResultContent, ToolResultStatus, ToolSpec, ToolUseBlock};
use strands::{
    Agent, CancelSignal, ContentBlock, Error, JsonValue, Message, Role, Tool, ToolContext, ToolOutcome, ToolResultBlock,
};

use common::MockTool;

fn agent_with(tools: Vec<MockTool>) -> Agent {
    Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .tools(tools)
        .printer(false)
        .build()
        .unwrap()
}

fn fixed(name: &str, text: &str) -> MockTool {
    let text = text.to_owned();
    MockTool::new(name, move |_| {
        ToolResultBlock::success("test-id", vec![ToolResultContent::text(text.clone())]).into()
    })
}

fn tool_use_of(message: &Message) -> &strands::ToolUseBlock {
    match &message.content[0] {
        ContentBlock::ToolUse(tool_use) => tool_use,
        other => panic!("expected a tool use, got {other:?}"),
    }
}

fn message_json(message: &Message) -> JsonValue {
    json!({"role": message.role, "content": message.content})
}

#[tokio::test]
async fn calls_a_tool_by_name_and_returns_the_result() {
    let mut agent = agent_with(vec![fixed("calculator", "8")]);
    let result = agent.tool("calculator").invoke(json!({"a": 5, "b": 3})).await.unwrap();
    assert_eq!(
        result,
        ToolResultBlock::success("test-id", vec![ToolResultContent::text("8")])
    );
}

#[tokio::test]
async fn calls_a_tool_with_empty_input_when_no_input_provided() {
    let received = Arc::new(Mutex::new(None));
    let seen = received.clone();
    let tool = MockTool::new("ping", move |context| {
        *seen.lock().unwrap() = Some(context.tool_use().input.clone());
        ToolResultBlock::success("test-id", vec![ToolResultContent::text("pong")]).into()
    });
    let mut agent = agent_with(vec![tool]);
    let result = agent.tool("ping").invoke(json!({})).await.unwrap();
    assert_eq!(
        result,
        ToolResultBlock::success("test-id", vec![ToolResultContent::text("pong")])
    );
    assert_eq!(*received.lock().unwrap(), Some(json!({})));
}

#[tokio::test]
async fn passes_agent_cancel_signal_to_direct_tool_calls() {
    let received: Arc<Mutex<Option<CancelSignal>>> = Arc::new(Mutex::new(None));
    let seen = received.clone();
    let tool = MockTool::new("probe", move |context| {
        *seen.lock().unwrap() = Some(context.cancel_signal().clone());
        ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into()
    });
    let mut agent = agent_with(vec![tool]);
    agent.tool("probe").invoke(json!({})).await.unwrap();
    let signal = received.lock().unwrap().clone().unwrap();
    assert_eq!(signal.is_cancelled(), agent.cancel_signal().is_cancelled());
    assert!(!signal.is_cancelled());
}

#[tokio::test]
async fn throws_when_tool_is_not_found() {
    let mut agent = agent_with(vec![]);
    let error = agent.tool("nonexistent").invoke(json!({})).await.unwrap_err();
    assert!(matches!(error, Error::ToolNotFound(_)));
    assert_eq!(error.to_string(), "Tool 'nonexistent' not found");
}

#[tokio::test]
async fn resolves_underscore_names_to_hyphenated_tool_names() {
    let mut agent = agent_with(vec![fixed("my-tool", "ok")]);
    let result = agent.tool("my_tool").invoke(json!({})).await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Success);
}

#[tokio::test]
async fn prefers_exact_name_match_over_normalized_match() {
    let mut agent = agent_with(vec![fixed("my_tool", "exact")]);
    let result = agent.tool("my_tool").invoke(json!({})).await.unwrap();
    assert_eq!(
        result,
        ToolResultBlock::success("test-id", vec![ToolResultContent::text("exact")])
    );
}

#[tokio::test]
async fn resolves_tool_names_case_insensitively() {
    let mut agent = agent_with(vec![fixed("MyTool", "ok")]);
    let result = agent.tool("mytool").invoke(json!({})).await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Success);
}

#[tokio::test]
async fn prefers_exact_match_over_case_insensitive_match() {
    let mut agent = agent_with(vec![fixed("myTool", "exact"), fixed("MYTOOL", "upper")]);
    let result = agent.tool("myTool").invoke(json!({})).await.unwrap();
    assert_eq!(result.content[0], ToolResultContent::text("exact"));
}

#[tokio::test]
async fn records_tool_call_in_message_history_by_default() {
    let mut agent = agent_with(vec![fixed("calculator", "8")]);
    agent.tool("calculator").invoke(json!({"a": 5, "b": 3})).await.unwrap();

    let messages = agent.messages();
    assert_eq!(messages.len(), 3);
    let tool_use_id = &tool_use_of(&messages[0]).tool_use_id;
    assert!(tool_use_id.starts_with("tooluse_"), "{tool_use_id}");
    assert_eq!(
        messages.iter().map(message_json).collect::<Vec<_>>(),
        vec![
            json!({"role": "assistant", "content": [
                {"toolUse": {"name": "calculator", "toolUseId": tool_use_id, "input": {"a": 5, "b": 3}}}
            ]}),
            json!({"role": "user", "content": [
                {"toolResult": {"toolUseId": "test-id", "status": "success", "content": [{"text": "8"}]}}
            ]}),
            json!({"role": "assistant", "content": [{"text": "agent.tool.calculator was called."}]}),
        ]
    );
    assert!(messages.iter().all(|message| !message.tracking_id().is_empty()));
}

#[tokio::test]
async fn does_not_record_when_record_direct_tool_call_is_false_per_call() {
    let mut agent = agent_with(vec![fixed("calculator", "8")]);
    let options = DirectToolCallOptions {
        record_direct_tool_call: Some(false),
    };
    agent
        .tool("calculator")
        .invoke_with(json!({"a": 5, "b": 3}), options)
        .await
        .unwrap();
    assert!(agent.messages().is_empty());
}

#[tokio::test]
async fn records_when_explicitly_set_to_true_per_call() {
    let mut agent = agent_with(vec![fixed("calculator", "8")]);
    let options = DirectToolCallOptions::builder().record_direct_tool_call(true).build();
    agent
        .tool("calculator")
        .invoke_with(json!({"a": 5, "b": 3}), options)
        .await
        .unwrap();
    assert_eq!(agent.messages().len(), 3);
}

/// A tool whose spec allows only `allowed`.
struct StrictTool;

impl Tool for StrictTool {
    fn name(&self) -> &str {
        "my-tool"
    }

    fn description(&self) -> &str {
        "Tool with strict schema"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new("my-tool", "Tool with strict schema").with_input_schema(json!({
            "type": "object",
            "properties": {"allowed": {"type": "string"}}
        }))
    }

    fn stream(&self, _context: ToolContext) -> ToolStream {
        ToolStream::ready(ToolResultBlock::success("test-id", vec![ToolResultContent::text("ok")]))
    }
}

#[tokio::test]
async fn records_full_input_without_filtering() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .tools([StrictTool])
        .printer(false)
        .build()
        .unwrap();
    agent
        .tool("my_tool")
        .invoke(json!({"allowed": "yes", "extra": "also-recorded"}))
        .await
        .unwrap();
    assert_eq!(
        tool_use_of(&agent.messages()[0]).input,
        json!({"allowed": "yes", "extra": "also-recorded"})
    );
}

/// `agent.tool` takes `&mut Agent`, so it cannot run while the agent is invoking; during an
/// invocation a tool makes the direct call through its context's agent, which never records.
#[tokio::test]
async fn allows_direct_tool_call_during_invocation_when_record_direct_tool_call_is_false() {
    let caller = FunctionTool::builder("caller", "Calls quick-tool").callback(|_, context: ToolContext| async move {
        let result = context.agent().call_tool("quick-tool", json!({})).await?;
        Ok(json!({"status": result.status, "content": result.content}))
    });
    let model = MockModel::new()
        .with_turn(MockTurn::content([ContentBlock::from(ToolUseBlock::new(
            "caller",
            "c-1",
            json!({}),
        ))]))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools(tool_list![caller, fixed("quick-tool", "ok")])
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("Go").await.unwrap();

    let ContentBlock::ToolResult(result) = &agent.messages()[2].content[0] else {
        panic!("expected the caller's result");
    };
    assert_eq!(
        serde_json::to_value(&result.content).unwrap(),
        json!([{"json": {"status": "success", "content": [{"text": "ok"}]}}])
    );
    assert_eq!(agent.messages().len(), 4);

    let mut agent = agent_with(vec![fixed("quick-tool", "ok")]);
    let options = DirectToolCallOptions {
        record_direct_tool_call: Some(false),
    };
    let result = agent.tool("quick_tool").invoke_with(json!({}), options).await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Success);
}

#[tokio::test]
async fn returns_an_error_result_when_the_tool_fails() {
    let tool = MockTool::new("thrower", |context| {
        strands::tools::create_error_result("Boom!", context.tool_use().tool_use_id.clone()).into()
    });
    let mut agent = agent_with(vec![tool]);
    let result = agent.tool("thrower").invoke(json!({})).await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(result.content, vec![ToolResultContent::text("Error: Boom!")]);
}

#[tokio::test]
async fn reports_an_interrupt_as_an_error_result() {
    let tool = MockTool::new("asker", |context| match context.interrupt("confirm") {
        Ok(_) => ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into(),
        Err(interrupt) => ToolOutcome::Interrupt(interrupt),
    });
    let mut agent = agent_with(vec![tool]);
    let result = agent.tool("asker").invoke(json!({})).await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(
        result.content,
        vec![ToolResultContent::text(
            "Error: Interrupts are not supported in direct tool calls"
        )]
    );
}

#[tokio::test]
async fn generates_unique_tool_use_ids_using_crypto_random_uuid() {
    let mut agent = agent_with(vec![fixed("id-tool", "ok")]);
    agent.tool("id_tool").invoke(json!({})).await.unwrap();
    agent.tool("id_tool").invoke(json!({})).await.unwrap();

    let messages = agent.messages();
    assert_eq!(messages.len(), 6);
    let first = &tool_use_of(&messages[0]).tool_use_id;
    let second = &tool_use_of(&messages[3]).tool_use_id;
    assert!(first.starts_with("tooluse_"));
    assert!(second.starts_with("tooluse_"));
    assert_ne!(first, second);
}

/// Yields three progress events, then completes; records how far it ran.
struct StreamingTool {
    yields: Arc<Mutex<Vec<&'static str>>>,
}

impl Tool for StreamingTool {
    fn name(&self) -> &str {
        "streamer"
    }

    fn description(&self) -> &str {
        "A tool that yields progress events"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new("streamer", "A tool that yields progress events")
            .with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, _context: ToolContext) -> ToolStream {
        let yields = self.yields.clone();
        ToolStream::new(async_stream::stream! {
            for (step, data) in [("first", "step 1"), ("second", "step 2"), ("third", "step 3")] {
                yields.lock().unwrap().push(step);
                yield ToolStreamItem::Event(ToolStreamEvent::new(data));
            }
            yield ToolStreamItem::from(ToolResultBlock::success(
                "stream-id",
                vec![ToolResultContent::text("complete")],
            ));
        })
    }
}

#[tokio::test]
async fn yields_intermediate_events_and_returns_final_result() {
    let yields = Arc::new(Mutex::new(Vec::new()));
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .tools([StreamingTool { yields: yields.clone() }])
        .printer(false)
        .build()
        .unwrap();

    let mut events = Vec::new();
    let mut result = None;
    {
        let mut stream = agent.tool("streamer").stream(json!({}));
        while let Some(item) = stream.next().await {
            match item.unwrap() {
                ToolStreamItem::Event(event) => events.push(event),
                ToolStreamItem::Outcome(ToolOutcome::Result(block)) => result = Some(block),
                other => panic!("unexpected item {other:?}"),
            }
        }
    }
    let result = result.unwrap();
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(result.content[0], ToolResultContent::text("complete"));
    assert_eq!(*yields.lock().unwrap(), ["first", "second", "third"]);
    assert_eq!(
        events,
        vec![
            ToolStreamEvent::new("step 1"),
            ToolStreamEvent::new("step 2"),
            ToolStreamEvent::new("step 3")
        ]
    );
}

#[tokio::test]
async fn invoke_also_fully_consumes_multi_yield_generator() {
    let yields = Arc::new(Mutex::new(Vec::new()));
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .tools([StreamingTool { yields: yields.clone() }])
        .printer(false)
        .build()
        .unwrap();
    let result = agent.tool("streamer").invoke(json!({})).await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(result.content[0], ToolResultContent::text("complete"));
    assert_eq!(*yields.lock().unwrap(), ["first", "second", "third"]);
}

#[tokio::test]
async fn passes_all_parameters_to_tool_execution() {
    let received = Arc::new(Mutex::new(None));
    let seen = received.clone();
    let tool = MockTool::new("capture-tool", move |context| {
        *seen.lock().unwrap() = Some(context.tool_use().input.clone());
        ToolResultBlock::success("test-id", vec![ToolResultContent::text("captured")]).into()
    });
    let mut agent = agent_with(vec![tool]);
    agent
        .tool("capture_tool")
        .invoke(json!({"allowed": "yes", "extra": "should-pass-through"}))
        .await
        .unwrap();
    assert_eq!(
        *received.lock().unwrap(),
        Some(json!({"allowed": "yes", "extra": "should-pass-through"}))
    );
}

#[tokio::test]
async fn can_call_a_tool_that_was_added_after_agent_creation() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    agent.tool_registry_mut().add(fixed("later-tool", "dynamic")).unwrap();
    let result = agent.tool("later_tool").invoke(json!({})).await.unwrap();
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(result.content[0], ToolResultContent::text("dynamic"));
}

fn recorded_messages(agent: &Agent) -> Arc<Mutex<Vec<Message>>> {
    let fired = Arc::new(Mutex::new(Vec::new()));
    let sink = fired.clone();
    agent.add_hook(move |event: &mut MessageAddedEvent<'_>| {
        sink.lock().unwrap().push(event.message().clone());
    });
    fired
}

#[tokio::test]
async fn fires_message_added_event_for_each_message_recorded_during_direct_tool_call() {
    let mut agent = agent_with(vec![fixed("calculator", "8")]);
    let fired = recorded_messages(&agent);
    agent.tool("calculator").invoke(json!({"a": 5, "b": 3})).await.unwrap();

    let fired = fired.lock().unwrap();
    assert_eq!(fired.len(), 3);
    assert_eq!(*fired, agent.messages());
    assert_eq!(fired[0].role, Role::Assistant);
    assert_eq!(
        message_json(&fired[1]),
        json!({"role": "user", "content": [
            {"toolResult": {"toolUseId": "test-id", "status": "success", "content": [{"text": "8"}]}}
        ]})
    );
    assert_eq!(fired[2].text(), "agent.tool.calculator was called.");
}

#[tokio::test]
async fn does_not_fire_message_added_event_when_record_direct_tool_call_is_false() {
    let mut agent = agent_with(vec![fixed("calculator", "8")]);
    let fired = recorded_messages(&agent);
    let options = DirectToolCallOptions {
        record_direct_tool_call: Some(false),
    };
    agent
        .tool("calculator")
        .invoke_with(json!({"a": 5, "b": 3}), options)
        .await
        .unwrap();
    assert!(fired.lock().unwrap().is_empty());
}
