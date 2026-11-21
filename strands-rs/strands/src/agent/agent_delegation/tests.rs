use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use serde_json::{Value, json};

use crate::agent::{Agent, AgentAsToolOptions, AgentConfig};
use crate::hooks::{AfterToolCallEvent, AgentStreamEvent, BeforeToolCallEvent, MessageAddedEvent};
use crate::models::{BaseModelConfig, Model, ModelInfo};
use crate::testing::{MockModel, MockTurn};
use crate::tools::{FunctionTool, Tool, schema_for};
use crate::types::{ContentBlock, Message, Role, StopReason, ToolResultContent, ToolResultStatus, ToolUseBlock};

fn agent(model: MockModel, name: &str, tools: Vec<crate::ToolSource>) -> Agent {
    Agent::new(AgentConfig {
        model: Some(model.into()),
        name: Some(name.into()),
        tools,
        printer: Some(false),
        ..Default::default()
    })
    .unwrap()
}

fn specialist(name: &str, reply: &str) -> crate::ToolSource {
    let sub = agent(MockModel::new().with_turn(reply), name, Vec::new());
    sub.as_tool(AgentAsToolOptions {
        delegate: Some(true),
        ..Default::default()
    })
    .into()
}

fn call(name: &str, id: &str, input: &str) -> MockTurn {
    MockTurn::content([ToolUseBlock::new(name, id, json!({"input": input}))])
}

fn calls(uses: &[(&str, &str)]) -> MockTurn {
    MockTurn::content(
        uses.iter()
            .map(|(name, id)| ContentBlock::from(ToolUseBlock::new(*name, *id, json!({"input": "go"}))))
            .collect::<Vec<_>>(),
    )
}

fn calculator() -> crate::ToolSource {
    FunctionTool::builder("calculator", "Calculates")
        .callback(|_, _| async { Ok(json!("Result: 42")) })
        .into()
}

fn stateful() -> MockModel {
    let model = MockModel::new();
    let mut info = ModelInfo::default();
    info.capabilities.stateful = Some(true);
    model
        .update_config(BaseModelConfig {
            model_info: Some(info),
            ..Default::default()
        })
        .unwrap();
    model
}

fn text_blocks(message: &Message) -> Vec<String> {
    message
        .content
        .iter()
        .filter_map(|block| block.as_text().map(str::to_owned))
        .collect()
}

#[tokio::test]
async fn routes_to_the_correct_specialist_and_returns_stop_reason_end_turn() {
    let model = MockModel::new().with_turn(call("TechSupport", "call-1", "My wifi does not work"));
    let mut orchestrator = agent(
        model,
        "Orchestrator",
        vec![
            specialist("Billing", "Your balance is $42."),
            specialist("TechSupport", "Try rebooting your router."),
        ],
    );
    let result = orchestrator.invoke("My wifi does not work").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["Try rebooting your router."]);
}

#[tokio::test]
async fn regular_tools_work_normally_when_called_alone() {
    let model = MockModel::from_turns([
        MockTurn::content([ToolUseBlock::new("calculator", "calc-1", json!({}))]),
        MockTurn::text("The answer is 42."),
    ]);
    let mut orchestrator = agent(
        model,
        "Orchestrator",
        vec![calculator(), specialist("TechSupport", "Specialist response")],
    );
    let result = orchestrator.invoke("What is 6 * 7?").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["The answer is 42."]);
}

#[tokio::test]
async fn cancels_all_tools_when_delegation_tool_is_called_alongside_other_tools_then_retries() {
    let model = MockModel::from_turns([
        calls(&[("calculator", "calc-1"), ("TechSupport", "tech-1")]),
        call("TechSupport", "tech-2", "help"),
    ]);
    let mut orchestrator = agent(
        model.clone(),
        "Orchestrator",
        vec![calculator(), specialist("TechSupport", "Specialist answer")],
    );
    let result = orchestrator.invoke("Do both things").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["Specialist answer"]);
    let ContentBlock::ToolResult(cancelled) = &orchestrator.messages()[2].content[0] else {
        panic!("expected the cancelled results");
    };
    assert_eq!(cancelled.status, ToolResultStatus::Error);
    let ToolResultContent::Text(text) = &cancelled.content[0] else {
        panic!("expected text");
    };
    assert!(text.text.starts_with("This tool call was not executed."));
}

#[tokio::test]
async fn cancels_all_tools_when_two_delegation_tools_are_called_simultaneously_then_retries() {
    let model = MockModel::from_turns([
        calls(&[("Billing", "bill-1"), ("TechSupport", "tech-1")]),
        call("TechSupport", "tech-2", "wifi"),
    ]);
    let mut orchestrator = agent(
        model,
        "Orchestrator",
        vec![
            specialist("Billing", "Billing response"),
            specialist("TechSupport", "Tech response"),
        ],
    );
    let result = orchestrator.invoke("Handle both billing and tech").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["Tech response"]);
}

#[tokio::test]
async fn does_not_trigger_delegation_when_sub_agent_fails_loop_continues() {
    let failing = agent(
        MockModel::new().with_turn(MockTurn::error(|| crate::Error::other("Sub-agent crashed"))),
        "FailAgent",
        Vec::new(),
    )
    .as_tool(AgentAsToolOptions {
        delegate: Some(true),
        ..Default::default()
    });
    let model = MockModel::from_turns([
        call("FailAgent", "fail-1", "do something"),
        MockTurn::text("Sorry, the specialist is unavailable."),
    ]);
    let mut orchestrator = agent(model, "Orchestrator", vec![failing.into()]);
    let result = orchestrator.invoke("Help me").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        text_blocks(result.last_message()),
        ["Sorry, the specialist is unavailable."]
    );
}

#[tokio::test]
async fn does_not_leak_delegation_state_into_the_next_request() {
    let model = MockModel::from_turns([
        call("Sub", "del-1", "first request"),
        MockTurn::text("FRESH_SECOND_RESULT"),
    ]);
    let mut orchestrator = agent(model, "Orchestrator", vec![specialist("Sub", "FIRST_RESULT")]);
    let first = orchestrator.invoke("first").await.unwrap();
    assert_eq!(text_blocks(first.last_message()), ["FIRST_RESULT"]);
    let second = orchestrator.invoke("second").await.unwrap();
    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(second.last_message()), ["FRESH_SECOND_RESULT"]);
}

#[tokio::test]
async fn does_not_leak_delegation_state_when_a_later_after_tools_hook_throws() {
    let model = MockModel::from_turns([
        call("Sub", "del-1", "first request"),
        MockTurn::text("FRESH_SECOND_RESULT"),
    ]);
    let mut orchestrator = agent(model, "Orchestrator", vec![specialist("Sub", "STALE_FIRST_RESULT")]);
    let throw_on_next = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let throwing = throw_on_next.clone();
    orchestrator.add_hook(move |_: &mut crate::hooks::AfterToolsEvent<'_>| {
        if throwing.load(Ordering::SeqCst) {
            return Err(crate::Error::other("AFTER_TOOLS_BOOM"));
        }
        Ok(())
    });
    let error = orchestrator.invoke("first").await.unwrap_err();
    assert_eq!(error.to_string(), "AFTER_TOOLS_BOOM");
    throw_on_next.store(false, Ordering::SeqCst);
    let second = orchestrator.invoke("second").await.unwrap();
    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(second.last_message()), ["FRESH_SECOND_RESULT"]);
}

#[tokio::test]
async fn skips_delegation_when_sub_agent_returns_empty_text_and_loop_continues() {
    let model = MockModel::from_turns([call("EmptyAgent", "empty-1", "go"), MockTurn::text("I continued.")]);
    let mut orchestrator = agent(model, "Orchestrator", vec![specialist("EmptyAgent", "")]);
    let result = orchestrator.invoke("go").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["I continued."]);
}

#[tokio::test]
async fn skips_delegation_logic_for_delegation_tools_added_after_init_tool_runs_normally() {
    let model = stateful();
    model.add_turn(call("Sub", "del-1", "do something"));
    model.add_turn("Got the sub-agent response, done.");
    let mut orchestrator = agent(model, "Orchestrator", Vec::new());
    orchestrator.initialize().await.unwrap();
    orchestrator
        .tool_registry_mut()
        .add(specialist("Sub", "Sub response"))
        .unwrap();
    let result = orchestrator.invoke("Do something").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        text_blocks(result.last_message()),
        ["Got the sub-agent response, done."]
    );
}

#[tokio::test]
async fn does_not_enforce_single_call_constraint_for_stateful_models_with_runtime_added_tools() {
    let model = stateful();
    model.add_turn(calls(&[("calculator", "calc-1"), ("Sub", "del-1")]));
    model.add_turn("Both tools ran successfully.");
    let mut orchestrator = agent(model, "Orchestrator", vec![calculator()]);
    orchestrator.initialize().await.unwrap();
    orchestrator
        .tool_registry_mut()
        .add(specialist("Sub", "Sub response"))
        .unwrap();
    let result = orchestrator.invoke("Do both").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["Both tools ran successfully."]);
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[allow(dead_code, reason = "the schema is what matters")]
struct Items {
    items: Vec<String>,
    count: u32,
}

#[tokio::test]
async fn converts_json_block_to_text_block_with_json_stringified_content() {
    let payload = json!({"items": ["a", "b"], "count": 2});
    let sub_model = MockModel::from_turns([
        MockTurn::content([ToolUseBlock::new("strands_structured_output", "so-1", payload.clone())]),
        MockTurn::text(""),
    ]);
    let sub = Agent::new(AgentConfig {
        model: Some(sub_model.into()),
        name: Some("JsonAgent".into()),
        structured_output_schema: Some(schema_for::<Items>()),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    let tool = sub.as_tool(AgentAsToolOptions {
        delegate: Some(true),
        ..Default::default()
    });
    let mut orchestrator = agent(
        MockModel::new().with_turn(call("JsonAgent", "json-1", "get data")),
        "Orchestrator",
        vec![tool.into()],
    );
    let result = orchestrator.invoke("get data").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().content.len(), 1);
    let text = result.last_message().content[0].as_text().unwrap();
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), payload);
}

#[tokio::test]
async fn throws_when_delegation_tools_are_present_on_a_stateful_model() {
    let model = stateful();
    model.add_turn("Hi");
    let mut orchestrator = agent(model, "Orchestrator", vec![specialist("Sub", "Hi")]);
    let error = orchestrator.initialize().await.unwrap_err();
    assert!(error.to_string().contains("not supported with stateful models"));
}

#[tokio::test]
async fn unwraps_inner_agent_stream_events_as_native_events_in_the_parent_stream() {
    let mut orchestrator = agent(
        MockModel::new().with_turn(call("Sub", "del-1", "handle this")),
        "Orchestrator",
        vec![specialist("Sub", "Delegated response")],
    );
    let mut events = Vec::new();
    {
        let mut stream = orchestrator.stream("handle this");
        while let Some(event) = stream.next().await {
            events.push(event.unwrap());
        }
    }
    assert!(!events.is_empty());
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AgentStreamEvent::ToolStreamUpdate(_)))
    );
    let types: Vec<&str> = events.iter().map(AgentStreamEvent::event_type).collect();
    assert!(types.contains(&"modelStreamUpdateEvent"));
    assert!(types.contains(&"contentBlockEvent"));
    let delegated_blocks = events
        .iter()
        .filter(|event| matches!(event, AgentStreamEvent::ContentBlock(data) if data.content_block.as_text() == Some("Delegated response")))
        .count();
    assert_eq!(delegated_blocks, 1);
}

#[tokio::test]
async fn does_not_stop_the_loop_when_a_later_after_tools_event_hook_changes_the_result_to_error() {
    let model = MockModel::from_turns([
        call("Sub", "del-1", "do something"),
        MockTurn::text("RECOVERED_AFTER_ERROR"),
    ]);
    let mut orchestrator = agent(model, "Orchestrator", vec![specialist("Sub", "SECRET_RAW")]);
    orchestrator.add_hook(|event: &mut AfterToolCallEvent| {
        if event.tool_use().tool_use_id == "del-1" {
            let result = event.result_mut();
            result.status = ToolResultStatus::Error;
            result.content = vec![ToolResultContent::text("REDACTED")];
        }
    });
    let result = orchestrator.invoke("do something").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["RECOVERED_AFTER_ERROR"]);
}

#[tokio::test]
async fn child_delegation_does_not_leak_to_the_parent_agent() {
    let middle = agent(
        MockModel::new().with_turn(call("Leaf", "leaf-1", "go")),
        "Middle",
        vec![specialist("Leaf", "Leaf response")],
    );
    let model = MockModel::from_turns([call("Middle", "mid-1", "go"), MockTurn::text("PARENT_FINAL")]);
    let mut parent = agent(
        model,
        "Parent",
        vec![middle.as_tool(AgentAsToolOptions::default()).into()],
    );
    let result = parent.invoke("go").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["PARENT_FINAL"]);
}

#[tokio::test]
async fn does_not_promote_the_regular_tool_result_as_delegated_when_retry_swaps_to_a_non_delegation_tool() {
    let regular: Arc<dyn Tool> =
        Arc::new(FunctionTool::builder("regular", "Regular").callback(|_, _| async { Ok(json!("REGULAR_RESULT")) }));
    let model = MockModel::from_turns([
        call("Sub", "tool-1", "do something"),
        MockTurn::text("PARENT_FOLLOW_UP"),
    ]);
    let mut orchestrator = agent(
        model,
        "Orchestrator",
        vec![specialist("Sub", "DELEGATED_ANSWER"), regular.clone().into()],
    );
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    orchestrator.add_hook(move |event: &mut AfterToolCallEvent| {
        if event.tool_use().tool_use_id == "tool-1" && counter.fetch_add(1, Ordering::Relaxed) == 0 {
            event.set_retry(true);
        }
    });
    let attempts_seen = attempts.clone();
    orchestrator.add_hook(move |event: &mut BeforeToolCallEvent| {
        if event.tool_use().tool_use_id == "tool-1" && attempts_seen.load(Ordering::Relaxed) == 1 {
            event.set_selected_tool(regular.clone());
        }
    });
    let result = orchestrator.invoke("do something").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_blocks(result.last_message()), ["PARENT_FOLLOW_UP"]);
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[allow(dead_code, reason = "the schema is what matters")]
struct Answer {
    answer: String,
}

#[tokio::test]
async fn does_not_trigger_delegation_when_parent_has_a_structured_output_schema() {
    let model = MockModel::from_turns([
        call("Sub", "del-1", "go"),
        MockTurn::content([ToolUseBlock::new(
            "strands_structured_output",
            "so-1",
            json!({"answer": "Sub answer"}),
        )]),
    ]);
    let mut orchestrator = Agent::new(AgentConfig {
        model: Some(model.into()),
        name: Some("Orchestrator".into()),
        tools: vec![specialist("Sub", "Sub answer")],
        structured_output_schema: Some(schema_for::<Answer>()),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    let result = orchestrator.invoke("go").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::ToolUse);
    assert_eq!(result.structured_output_value(), Some(&json!({"answer": "Sub answer"})));
}

#[tokio::test]
async fn emits_exactly_one_assistant_message_added_event_with_delegated_content_no_placeholder() {
    let mut orchestrator = agent(
        MockModel::new().with_turn(call("billing", "c1", "check")),
        "Orchestrator",
        vec![specialist("billing", "Balance: $42")],
    );
    let assistant_messages = Arc::new(Mutex::new(Vec::new()));
    let seen = assistant_messages.clone();
    let orchestrator_id = orchestrator.id().to_owned();
    orchestrator.add_hook(move |event: &mut MessageAddedEvent<'_>| {
        if event.agent().id() == orchestrator_id && event.message().role == Role::Assistant {
            seen.lock().unwrap().push(event.message().clone());
        }
    });
    orchestrator.invoke("Check balance").await.unwrap();
    let messages = assistant_messages.lock().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].content, [ContentBlock::text("Balance: $42")]);
    let roles: Vec<Role> = orchestrator.messages().iter().map(|message| message.role).collect();
    assert_eq!(roles, [Role::User, Role::Assistant, Role::User, Role::Assistant]);
}

#[tokio::test]
async fn a_user_plugin_named_strands_agent_delegation_replaces_the_built_in_one() {
    struct Replacement;

    #[async_trait::async_trait]
    impl crate::plugins::Plugin for Replacement {
        fn name(&self) -> &str {
            "strands:agent-delegation"
        }

        async fn init_agent(&self, _agent: &mut crate::LocalAgent) -> crate::Result<()> {
            Ok(())
        }
    }

    let model = MockModel::from_turns([call("Sub", "del-1", "go"), MockTurn::text("Parent continued")]);
    let mut orchestrator = Agent::new(AgentConfig {
        model: Some(model.into()),
        tools: vec![specialist("Sub", "Delegated")],
        plugins: vec![Arc::new(Replacement)],
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    let result = orchestrator.invoke("go").await.unwrap();
    assert_eq!(text_blocks(result.last_message()), ["Parent continued"]);
}

struct Named(&'static str);

#[async_trait::async_trait]
impl crate::plugins::Plugin for Named {
    fn name(&self) -> &str {
        self.0
    }

    async fn init_agent(&self, _agent: &mut crate::LocalAgent) -> crate::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn registers_the_built_in_plugins_in_the_ts_order() {
    let mut agent = Agent::new(AgentConfig {
        model: Some(MockModel::new().into()),
        plugins: vec![Arc::new(Named("user:first")), Arc::new(Named("user:second"))],
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    agent.initialize().await.unwrap();
    assert_eq!(
        agent.plugins.names(),
        [
            "strands:sliding-window-conversation-manager",
            "strands:default-model-retry-strategy",
            "user:first",
            "user:second",
            "strands:agent-delegation",
            "strands:model"
        ]
    );
}

#[tokio::test]
async fn a_user_plugin_with_a_built_in_name_fails_initialization() {
    let mut agent = Agent::new(AgentConfig {
        model: Some(MockModel::new().into()),
        plugins: vec![Arc::new(Named("strands:model"))],
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    let error = agent.initialize().await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "plugin_name=<strands:model> | plugin already registered"
    );
}
