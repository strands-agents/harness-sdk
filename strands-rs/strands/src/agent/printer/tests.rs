use std::sync::{Arc, Mutex};

use futures::StreamExt;
use serde_json::json;

use super::AgentPrinter;
use crate::agent::Agent;
use crate::hooks::{
    AgentStreamEvent, BeforeToolCallEvent, BeforeToolCallEventData, BeforeToolsEvent, ModelStreamUpdateEventData,
};
use crate::models::streaming::{ModelContentBlockDeltaEvent, ModelContentBlockStopEvent, ReasoningContentDelta};
use crate::test_support::MockTool;
use crate::testing::{MockModel, MockTurn};
use crate::types::{ContentBlock, ReasoningBlock, ToolResultBlock, ToolResultContent, ToolUse, ToolUseBlock};

type Output = Arc<Mutex<String>>;

fn printer() -> (AgentPrinter, Output) {
    let output: Output = Arc::default();
    let sink = output.clone();
    (
        AgentPrinter::new(Box::new(move |text| sink.lock().unwrap().push_str(text))),
        output,
    )
}

fn agent(model: MockModel, tools: Vec<MockTool>) -> (Agent, Output) {
    let mut agent = Agent::builder()
        .model(model)
        .tools(tools)
        .printer(false)
        .build()
        .unwrap();
    let output: Output = Arc::default();
    let sink = output.clone();
    agent.set_printer_appender(Box::new(move |text| sink.lock().unwrap().push_str(text)));
    (agent, output)
}

async fn drain(agent: &mut Agent) {
    let mut stream = agent.stream("Test");
    while let Some(event) = stream.next().await {
        event.unwrap();
    }
}

fn reasoning(text: &str) -> ContentBlock {
    ContentBlock::Reasoning(ReasoningBlock::new().with_text(text))
}

fn tool_use(name: &str, id: &str) -> ContentBlock {
    ContentBlock::ToolUse(ToolUseBlock::new(name, id, json!({})))
}

fn result_tool(name: &str, id: &str, success: bool, text: &str) -> MockTool {
    let (id, text) = (id.to_owned(), text.to_owned());
    MockTool::new(name).with_result(move |_| {
        let content = vec![ToolResultContent::text(text.clone())];
        let block = if success {
            ToolResultBlock::success(id.clone(), content)
        } else {
            ToolResultBlock::error(id.clone(), content)
        };
        block.into()
    })
}

fn output(output: &Output) -> String {
    output.lock().unwrap().clone()
}

#[tokio::test]
async fn prints_simple_text_output() {
    let (mut agent, out) = agent(MockModel::new().with_turn("Hello world"), vec![]);
    drain(&mut agent).await;
    assert_eq!(output(&out), "Hello world\n");
}

#[tokio::test]
async fn prints_reasoning_content_wrapped_in_tags() {
    let (mut agent, out) = agent(MockModel::new().with_turn(reasoning("Let me think")), vec![]);
    drain(&mut agent).await;
    assert_eq!(output(&out), "\n💭 Reasoning:\n   Let me think\n\n");
}

#[tokio::test]
async fn prints_text_and_reasoning_together() {
    let turn = MockTurn::content([ContentBlock::text("Answer: "), reasoning("thinking")]);
    let (mut agent, out) = agent(MockModel::new().with_turn(turn), vec![]);
    drain(&mut agent).await;
    assert_eq!(output(&out), "Answer: \n💭 Reasoning:\n   thinking\n\n");
}

#[tokio::test]
async fn handles_newlines_in_reasoning_content() {
    let turn = reasoning("First line\nSecond line\nThird line");
    let (mut agent, out) = agent(MockModel::new().with_turn(turn), vec![]);
    drain(&mut agent).await;
    assert_eq!(
        output(&out),
        "\n💭 Reasoning:\n   First line\n   Second line\n   Third line\n\n"
    );
}

#[tokio::test]
async fn prints_tool_execution() {
    let model = MockModel::new()
        .with_turn(tool_use("calc", "tool-1"))
        .with_turn("Result: 4");
    let (mut agent, out) = agent(model, vec![result_tool("calc", "tool-1", true, "4")]);
    drain(&mut agent).await;
    assert_eq!(
        output(&out),
        "\n  ⏳ calc\n\n🔧 Tool #1: calc\n✓ Tool completed\nResult: 4\n"
    );
}

#[tokio::test]
async fn prints_tool_error() {
    let model = MockModel::new()
        .with_turn(tool_use("bad_tool", "tool-1"))
        .with_turn("Error handled");
    let (mut agent, out) = agent(model, vec![result_tool("bad_tool", "tool-1", false, "Failed")]);
    drain(&mut agent).await;
    assert_eq!(
        output(&out),
        "\n  ⏳ bad_tool\n\n🔧 Tool #1: bad_tool\n✗ Tool failed\nError handled\n"
    );
}

#[tokio::test]
async fn prints_denied_tool_with_denied_icon() {
    let model = MockModel::new()
        .with_turn(tool_use("dangerous_tool", "tool-1"))
        .with_turn("Tool was denied");
    let (mut agent, out) = agent(model, vec![result_tool("dangerous_tool", "tool-1", false, "denied")]);
    agent.add_hook(|event: &mut BeforeToolCallEvent| event.set_cancel("Tool not allowed"));
    drain(&mut agent).await;
    assert_eq!(
        output(&out),
        "\n  ⏳ dangerous_tool\n\n🚫 Tool #1: dangerous_tool (denied)\n✗ Tool failed\nTool was denied\n"
    );
}

#[tokio::test]
async fn prints_batch_cancel_notice_when_before_tools_event_cancels() {
    let model = MockModel::new()
        .with_turn(tool_use("tool_a", "tool-1"))
        .with_turn("Done");
    let (mut agent, out) = agent(model, vec![result_tool("tool_a", "tool-1", true, "ok")]);
    agent.add_hook(|event: &mut BeforeToolsEvent<'_>| event.set_cancel(true));
    drain(&mut agent).await;
    assert_eq!(
        output(&out),
        "\n  ⏳ tool_a\n\n🚫 All tools denied\n✗ Tool failed\nDone\n"
    );
}

#[tokio::test]
async fn prints_comprehensive_scenario_with_all_output_types() {
    let model = MockModel::new()
        .with_turn(MockTurn::content([
            ContentBlock::text("Let me help you. "),
            reasoning("I need to use the calculator"),
            ContentBlock::ToolUse(ToolUseBlock::new("calculator", "tool-1", json!({"expr": "2+2"}))),
        ]))
        .with_turn(MockTurn::content([
            ContentBlock::text("The calculation succeeded. "),
            reasoning("Now trying validation"),
            ContentBlock::ToolUse(ToolUseBlock::new("validator", "tool-2", json!({"value": "test"}))),
        ]))
        .with_turn(MockTurn::content([
            ContentBlock::text("All done. "),
            reasoning("Task completed successfully"),
        ]));
    let tools = vec![
        result_tool("calculator", "tool-1", true, "4"),
        result_tool("validator", "tool-2", false, "Validation failed"),
    ];
    let (mut agent, out) = agent(model, tools);
    drain(&mut agent).await;
    let expected = [
        "Let me help you. ",
        "\n💭 Reasoning:\n   I need to use the calculator\n",
        "\n  ⏳ calculator\n",
        "\n🔧 Tool #1: calculator\n",
        "✓ Tool completed\n",
        "The calculation succeeded. ",
        "\n💭 Reasoning:\n   Now trying validation\n",
        "\n  ⏳ validator\n",
        "\n🔧 Tool #2: validator\n",
        "✗ Tool failed\n",
        "All done. ",
        "\n💭 Reasoning:\n   Task completed successfully\n",
        "\n",
    ]
    .concat();
    assert_eq!(output(&out), expected);
}

#[test]
fn indents_reasoning_split_across_deltas() {
    let (mut printer, out) = printer();
    for text in ["First ", "line\nSec", "ond"] {
        let delta = ModelContentBlockDeltaEvent::new(ReasoningContentDelta {
            text: Some(text.to_owned()),
            signature: None,
            redacted_content: None,
        });
        let record = AgentStreamEvent::ModelStreamUpdate(ModelStreamUpdateEventData::new(delta.into()));
        printer.process_event(&record, false);
    }
    let stop = ModelStreamUpdateEventData::new(ModelContentBlockStopEvent::new().into());
    printer.process_event(&AgentStreamEvent::ModelStreamUpdate(stop), false);
    assert_eq!(output(&out), "\n💭 Reasoning:\n   First line\n   Second\n");
}

#[test]
fn counts_tools_across_denied_and_run_calls() {
    let (mut printer, out) = printer();
    let call =
        |name: &str| AgentStreamEvent::BeforeToolCall(BeforeToolCallEventData::new(ToolUse::new(name, "t", json!({}))));
    printer.process_event(&call("a"), true);
    printer.process_event(&call("b"), false);
    assert_eq!(output(&out), "\n🚫 Tool #1: a (denied)\n\n🔧 Tool #2: b\n");
}

#[tokio::test]
async fn validates_output_when_printer_is_enabled() {
    let (mut agent, out) = agent(MockModel::new().with_turn("Hello world"), vec![]);
    drain(&mut agent).await;
    assert!(output(&out).contains("Hello world"));
}

#[test]
fn does_not_create_printer_when_printer_is_false() {
    let agent = Agent::builder().model(MockModel::new()).printer(false).build().unwrap();
    assert!(agent.printer.is_none());
}

#[test]
fn defaults_to_printer_true_when_not_specified() {
    let agent = Agent::builder().model(MockModel::new()).build().unwrap();
    assert!(agent.printer.is_some());
}

#[tokio::test]
async fn agent_works_correctly_with_printer_disabled() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .printer(false)
        .build()
        .unwrap();
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.last_message().content, vec![ContentBlock::text("Hello")]);
}
