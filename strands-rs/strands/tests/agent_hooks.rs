//! Hooks fired by the agent loop.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::{MockTool, async_tool, collect, tool_use_turn, tool_uses_turn};
use serde_json::{Value, json};
use strands::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, AgentStreamEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent, EndTurn, HookCallbackOptions,
    HookOrder, InitializedEvent, MessageAddedEvent, ModelMessageEvent, ModelStreamUpdateEvent, ToolResultEvent,
    ToolStreamUpdateEvent,
};
use strands::plugins::Plugin;
use strands::testing::{MockModel, MockTurn};
use strands::tools::ToolExecutorStrategy;
use strands::types::ToolResultContent;
use strands::{
    Agent, CancelOptions, ContentBlock, Error, LocalAgent, Message, Role, StopReason, Tool, ToolError, ToolResultBlock,
};

type Invocations = Arc<Mutex<Vec<(&'static str, Value, bool)>>>;

/// Records the events `MockPlugin` subscribes to: the event's type name, its data as JSON
/// (with tracking ids removed) and whether its invocation state is empty.
#[derive(Clone, Default)]
struct MockPlugin {
    invocations: Invocations,
}

fn strip_tracking_ids(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.shift_remove("trackingId");
            map.values_mut().for_each(strip_tracking_ids);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_tracking_ids),
        _ => {}
    }
}

fn push(invocations: &Invocations, name: &'static str, data: impl serde::Serialize, state_empty: bool) {
    let mut data = serde_json::to_value(data).unwrap();
    strip_tracking_ids(&mut data);
    invocations.lock().unwrap().push((name, data, state_empty));
}

impl MockPlugin {
    fn names(&self) -> Vec<&'static str> {
        self.invocations
            .lock()
            .unwrap()
            .iter()
            .map(|(name, ..)| *name)
            .collect()
    }

    fn of(&self, name: &str) -> Vec<Value> {
        self.invocations
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, ..)| *event == name)
            .map(|(_, data, _)| data.clone())
            .collect()
    }

    fn len(&self) -> usize {
        self.invocations.lock().unwrap().len()
    }
}

#[strands::async_trait]
impl Plugin for MockPlugin {
    fn name(&self) -> &str {
        "mock-plugin"
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> strands::Result<()> {
        let i = self.invocations.clone();
        agent.add_hook(move |_: &mut InitializedEvent<'_>| push(&i, "InitializedEvent", json!({}), true));
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut BeforeInvocationEvent<'_>| {
            push(
                &i,
                "BeforeInvocationEvent",
                json!({"messages": e.messages()}),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
            push(
                &i,
                "AfterInvocationEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut MessageAddedEvent<'_>| {
            push(
                &i,
                "MessageAddedEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut BeforeToolsEvent<'_>| {
            push(
                &i,
                "BeforeToolsEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut AfterToolsEvent<'_>| {
            push(
                &i,
                "AfterToolsEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut BeforeToolCallEvent| {
            push(
                &i,
                "BeforeToolCallEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut AfterToolCallEvent| {
            push(
                &i,
                "AfterToolCallEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut BeforeModelCallEvent<'_>| {
            push(
                &i,
                "BeforeModelCallEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut AfterModelCallEvent<'_>| {
            push(
                &i,
                "AfterModelCallEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut ToolResultEvent| {
            push(
                &i,
                "ToolResultEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        let i = self.invocations.clone();
        agent.add_hook(move |e: &mut ToolStreamUpdateEvent| {
            push(
                &i,
                "ToolStreamUpdateEvent",
                AgentStreamEvent::from(&*e),
                e.invocation_state().is_empty(),
            );
        });
        Ok(())
    }
}

fn agent_with(model: MockModel, tools: Vec<strands::ToolSource>, plugin: Option<&MockPlugin>) -> Agent {
    let plugins: Vec<Arc<dyn Plugin>> = plugin
        .map(|p| Arc::new(p.clone()) as Arc<dyn Plugin>)
        .into_iter()
        .collect();
    Agent::builder()
        .model(model)
        .tools(tools)
        .plugins(plugins)
        .printer(false)
        .build()
        .unwrap()
}

fn success(context: &strands::ToolContext, text: &str) -> strands::ToolOutcome {
    ToolResultBlock::success(
        context.tool_use().tool_use_id.clone(),
        vec![ToolResultContent::text(text)],
    )
    .into()
}

fn counting_tool(name: &str, count: &Arc<AtomicUsize>, text: &str) -> MockTool {
    let count = count.clone();
    let text = text.to_owned();
    MockTool::new(name, move |context| {
        count.fetch_add(1, Ordering::SeqCst);
        success(context, &text)
    })
}

fn counter() -> Arc<AtomicUsize> {
    Arc::new(AtomicUsize::new(0))
}

fn get(count: &Arc<AtomicUsize>) -> usize {
    count.load(Ordering::SeqCst)
}

fn lifecycle_records() -> Vec<(&'static str, Value)> {
    vec![
        ("InitializedEvent", json!({})),
        (
            "BeforeInvocationEvent",
            json!({"messages": [{"role": "user", "content": [{"text": "Hi"}]}]}),
        ),
        (
            "MessageAddedEvent",
            json!({"type": "messageAddedEvent", "message": {"role": "user", "content": [{"text": "Hi"}]}}),
        ),
        ("BeforeModelCallEvent", Value::Null),
        (
            "AfterModelCallEvent",
            json!({
                "type": "afterModelCallEvent",
                "attemptCount": 1,
                "stopData": {"message": {"role": "assistant", "content": [{"text": "Hello"}]}, "stopReason": "endTurn"}
            }),
        ),
        (
            "MessageAddedEvent",
            json!({"type": "messageAddedEvent", "message": {"role": "assistant", "content": [{"text": "Hello"}]}}),
        ),
        ("AfterInvocationEvent", json!({"type": "afterInvocationEvent"})),
    ]
}

fn assert_lifecycle(plugin: &MockPlugin) {
    let invocations = plugin.invocations.lock().unwrap().clone();
    let expected = lifecycle_records();
    assert_eq!(invocations.len(), expected.len());
    for ((name, data, state_empty), (expected_name, expected_data)) in invocations.iter().zip(expected) {
        assert_eq!(*name, expected_name);
        assert!(state_empty, "{name}");
        if expected_name == "BeforeModelCallEvent" {
            assert_eq!(data["type"], "beforeModelCallEvent");
            assert!(data["projectedInputTokens"].is_u64(), "{data}");
        } else {
            assert_eq!(*data, expected_data, "{name}");
        }
    }
}

// --- invocation lifecycle ---

#[tokio::test]
async fn fires_hooks_during_invoke() {
    let plugin = MockPlugin::default();
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], Some(&plugin));
    agent.invoke("Hi").await.unwrap();
    assert_lifecycle(&plugin);
}

#[tokio::test]
async fn fires_hooks_during_stream() {
    let plugin = MockPlugin::default();
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], Some(&plugin));
    collect(agent.stream("Hi")).await;
    assert_lifecycle(&plugin);
}

// --- before invocation messages ---

#[tokio::test]
async fn uses_messages_mutated_in_place_by_a_hook() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    let history_empty = Arc::new(AtomicBool::new(false));
    let seen = history_empty.clone();
    agent.add_hook(move |e: &mut BeforeInvocationEvent<'_>| {
        seen.store(e.agent().messages().is_empty(), Ordering::SeqCst);
        e.messages_mut()[0].content[0] = ContentBlock::text("redacted");
    });
    agent.invoke("secret").await.unwrap();
    assert!(history_empty.load(Ordering::SeqCst));
    let shapes: Vec<(Role, String)> = agent.messages().iter().map(|m| (m.role, m.text())).collect();
    assert_eq!(
        shapes,
        [(Role::User, "redacted".into()), (Role::Assistant, "Hello".into())]
    );
}

#[tokio::test]
async fn does_not_mutate_a_caller_owned_message_array() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    let input_message = Message::user("original");
    let context_message = Message::user("context");
    let input_messages = vec![input_message.clone()];
    let added = context_message.clone();
    agent.add_hook(move |e: &mut BeforeInvocationEvent<'_>| e.messages_mut().push(added.clone()));

    agent.invoke(input_messages.clone()).await.unwrap();

    assert_eq!(input_messages.len(), 1);
    assert_eq!(input_messages[0], input_message);
    let messages = agent.messages();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0], input_message);
    assert_eq!(messages[1], context_message);
    assert_eq!(
        (messages[2].role, messages[2].text()),
        (Role::Assistant, "Hello".into())
    );
}

#[tokio::test]
async fn uses_messages_replaced_by_a_hook() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    let replacement = Message::user("replacement");
    let set = replacement.clone();
    agent.add_hook(move |e: &mut BeforeInvocationEvent<'_>| e.set_messages(vec![set.clone()]));
    agent.invoke("original").await.unwrap();
    assert_eq!(agent.messages()[0], replacement);
}

#[tokio::test]
async fn uses_an_empty_replacement_from_a_hook() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    agent.add_hook(|e: &mut BeforeInvocationEvent<'_>| e.set_messages(Vec::new()));
    agent.invoke("removed").await.unwrap();
    let shapes: Vec<(Role, String)> = agent.messages().iter().map(|m| (m.role, m.text())).collect();
    assert_eq!(shapes, [(Role::Assistant, "Hello".into())]);
}

// --- runtime hook registration ---

#[tokio::test]
async fn allows_adding_hooks_after_agent_creation_via_add_hook() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    let invocations: Arc<Mutex<Vec<Value>>> = Arc::default();
    let i = invocations.clone();
    agent.add_hook(move |e: &mut BeforeInvocationEvent<'_>| {
        let mut data = json!({"event": "before", "messages": e.messages(), "empty": e.invocation_state().is_empty()});
        strip_tracking_ids(&mut data);
        i.lock().unwrap().push(data);
    });
    let i = invocations.clone();
    agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
        i.lock()
            .unwrap()
            .push(json!({"event": "after", "empty": e.invocation_state().is_empty()}));
    });

    agent.invoke("Hi").await.unwrap();

    assert_eq!(
        *invocations.lock().unwrap(),
        [
            json!({"event": "before", "messages": [{"role": "user", "content": [{"text": "Hi"}]}], "empty": true}),
            json!({"event": "after", "empty": true}),
        ]
    );
}

// --- multi-turn conversations ---

#[tokio::test]
async fn fires_hooks_for_each_invoke_call() {
    let plugin = MockPlugin::default();
    let model = MockModel::from_turns(["First response", "Second response"]);
    let mut agent = agent_with(model, vec![], Some(&plugin));

    agent.invoke("First message").await.unwrap();
    assert_eq!(plugin.len(), 7);
    agent.invoke("Second message").await.unwrap();
    assert_eq!(plugin.len(), 13);
    let invocation_events = plugin
        .names()
        .into_iter()
        .filter(|name| *name == "BeforeInvocationEvent" || *name == "AfterInvocationEvent")
        .count();
    assert_eq!(invocation_events, 4);
}

// --- tool execution hooks ---

#[tokio::test]
async fn fires_tool_hooks_during_tool_execution() {
    let tool: Arc<dyn Tool> = Arc::new(MockTool::new("testTool", |c| success(c, "Tool result")));
    let model = MockModel::new()
        .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
        .with_turn("Final response");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(model, vec![tool.clone().into()], Some(&plugin));
    let tools_seen: Arc<Mutex<Vec<(bool, bool)>>> = Arc::default();
    let (seen, expected) = (tools_seen.clone(), tool.clone());
    agent.add_hook(move |e: &mut BeforeToolCallEvent| {
        seen.lock()
            .unwrap()
            .push((e.tool().is_some_and(|t| Arc::ptr_eq(t, &expected)), true));
    });
    let (seen, expected) = (tools_seen.clone(), tool.clone());
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        seen.lock()
            .unwrap()
            .push((e.tool().is_some_and(|t| Arc::ptr_eq(t, &expected)), e.error().is_none()));
    });

    agent.invoke("Test with tool").await.unwrap();

    assert_eq!(plugin.of("MessageAddedEvent").len(), 4);
    assert_eq!(
        plugin.of("BeforeToolCallEvent"),
        [json!({"type": "beforeToolCallEvent", "toolUse": {"name": "testTool", "toolUseId": "tool-1", "input": {}}})]
    );
    assert_eq!(
        plugin.of("AfterToolCallEvent"),
        [json!({
            "type": "afterToolCallEvent",
            "toolUse": {"name": "testTool", "toolUseId": "tool-1", "input": {}},
            "result": {"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": "Tool result"}]}}
        })]
    );
    assert_eq!(*tools_seen.lock().unwrap(), [(true, true), (true, true)]);
}

#[tokio::test]
async fn fires_after_tool_call_event_with_error_when_tool_fails() {
    let tool = async_tool("failingTool", |_, _| async {
        Err(ToolError::msg("Tool execution failed"))
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("failingTool", "tool-1", json!({})))
        .with_turn("Handled error");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(model, vec![tool.into()], Some(&plugin));
    type ErrorAndTool = (Option<String>, Option<String>);
    let errors: Arc<Mutex<Vec<ErrorAndTool>>> = Arc::default();
    let seen = errors.clone();
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        let tool = e.tool().map(|tool| tool.name().to_owned());
        seen.lock().unwrap().push((e.error().map(ToString::to_string), tool));
    });

    let result = agent.invoke("Test with failing tool").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        plugin.of("AfterToolCallEvent"),
        [json!({
            "type": "afterToolCallEvent",
            "toolUse": {"name": "failingTool", "toolUseId": "tool-1", "input": {}},
            "result": {"toolResult": {
                "toolUseId": "tool-1",
                "status": "error",
                "content": [{"text": "Error: Tool execution failed"}]
            }},
            "error": {"message": "Tool execution failed"}
        })]
    );
    assert_eq!(
        *errors.lock().unwrap(),
        [(Some("Tool execution failed".to_owned()), Some("failingTool".to_owned()))]
    );
}

// --- ModelStreamUpdateEvent ---

#[tokio::test]
async fn is_yielded_in_the_stream_and_dispatched_to_hooks() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    let from_hooks: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = from_hooks.clone();
    agent.add_hook(move |e: &mut ModelStreamUpdateEvent<'_>| {
        seen.lock()
            .unwrap()
            .push(serde_json::to_value(AgentStreamEvent::from(&*e)).unwrap());
    });

    let events = collect(agent.stream("Test")).await;

    let streamed: Vec<Value> = events
        .iter()
        .filter(|e| matches!(e, AgentStreamEvent::ModelStreamUpdate(_)))
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    assert!(!streamed.is_empty());
    assert_eq!(streamed, *from_hooks.lock().unwrap());
}

// --- MessageAddedEvent ---

#[tokio::test]
async fn fires_for_initial_user_input() {
    let plugin = MockPlugin::default();
    let mut agent = Agent::builder()
        .model(MockModel::from_turns(["Response"]))
        .messages(vec![Message::user("Initial")])
        .plugins(vec![Arc::new(plugin.clone()) as Arc<dyn Plugin>])
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("New message").await.unwrap();

    assert_eq!(
        plugin.of("MessageAddedEvent"),
        [
            json!({"type": "messageAddedEvent", "message": {"role": "user", "content": [{"text": "New message"}]}}),
            json!({"type": "messageAddedEvent", "message": {"role": "assistant", "content": [{"text": "Response"}]}}),
        ]
    );
}

// --- AfterModelCallEvent retry ---

fn user_hello_count(agent: &Agent) -> usize {
    agent
        .messages()
        .iter()
        .filter(|m| m.role == Role::User && m.text() == "Hello")
        .count()
}

#[tokio::test]
async fn does_not_duplicate_user_messages_on_error_retry() {
    let model = MockModel::new()
        .with_turn(MockTurn::error(|| Error::other("context overflow")))
        .with_turn("Success");
    let mut agent = agent_with(model, vec![], None);
    agent.add_hook(|e: &mut AfterModelCallEvent<'_>| {
        if e.error().is_some() {
            e.set_retry(true);
        }
    });
    agent.invoke("Hello").await.unwrap();
    assert_eq!(user_hello_count(&agent), 1);
}

#[tokio::test]
async fn does_not_duplicate_user_messages_on_success_retry() {
    let model = MockModel::from_turns(["First", "Second"]);
    let mut agent = agent_with(model, vec![], None);
    let calls = counter();
    let c = calls.clone();
    agent.add_hook(move |e: &mut AfterModelCallEvent<'_>| {
        if c.fetch_add(1, Ordering::SeqCst) == 0 && e.error().is_none() {
            e.set_retry(true);
        }
    });
    agent.invoke("Hello").await.unwrap();
    assert_eq!(user_hello_count(&agent), 1);
}

#[tokio::test]
async fn retries_model_call_when_hook_sets_retry() {
    let model = MockModel::new()
        .with_turn(MockTurn::error(|| Error::other("First attempt failed")))
        .with_turn("Success after retry");
    let mut agent = agent_with(model, vec![], None);
    let calls = counter();
    let c = calls.clone();
    agent.add_hook(move |e: &mut AfterModelCallEvent<'_>| {
        if c.fetch_add(1, Ordering::SeqCst) == 0 && e.error().is_some() {
            e.set_retry(true);
        }
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(
        result.last_message().content[0],
        ContentBlock::text("Success after retry")
    );
    assert_eq!(get(&calls), 2);
}

#[tokio::test]
async fn does_not_retry_when_retry_is_not_set() {
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("Failure")));
    let mut agent = agent_with(model, vec![], None);
    let error = agent.invoke("Test").await.unwrap_err();
    assert!(error.to_string().contains("Failure"), "{error}");
}

#[tokio::test]
async fn retries_model_call_on_success_when_hook_requests_it() {
    let model = MockModel::from_turns(["First response", "Second response after retry"]);
    let mut agent = agent_with(model, vec![], None);
    let calls = counter();
    let c = calls.clone();
    agent.add_hook(move |e: &mut AfterModelCallEvent<'_>| {
        if c.fetch_add(1, Ordering::SeqCst) == 0 && e.error().is_none() {
            e.set_retry(true);
        }
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(
        result.last_message().content[0],
        ContentBlock::text("Second response after retry")
    );
    assert_eq!(get(&calls), 2);
}

// --- AfterToolCallEvent retry ---

fn one_tool_model(name: &str) -> MockModel {
    MockModel::new()
        .with_turn(tool_use_turn(name, "tool-1", json!({})))
        .with_turn("Done")
}

#[tokio::test]
async fn retries_tool_call_when_hook_sets_retry() {
    let tool_calls = counter();
    let t = tool_calls.clone();
    let tool = async_tool("retryableTool", move |_, _| {
        let first = t.fetch_add(1, Ordering::SeqCst) == 0;
        async move {
            if first {
                Err(ToolError::msg("First attempt failed"))
            } else {
                Ok(json!("Success"))
            }
        }
    });
    let mut agent = agent_with(one_tool_model("retryableTool"), vec![tool.into()], None);
    let hook_calls = counter();
    let h = hook_calls.clone();
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        if h.fetch_add(1, Ordering::SeqCst) == 0 && e.error().is_some() {
            e.set_retry(true);
        }
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&tool_calls), 2);
    assert_eq!(get(&hook_calls), 2);
}

#[tokio::test]
async fn does_not_retry_a_tool_call_after_agent_cancellation() {
    let tool_calls = counter();
    let t = tool_calls.clone();
    let tool = MockTool::new("cancelledTool", move |context| {
        t.fetch_add(1, Ordering::SeqCst);
        ToolResultBlock::error(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("Cancelled locally")],
        )
        .into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("cancelledTool", "tool-1", json!({})))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, vec![tool.into()], None);
    let hook_calls = counter();
    let h = hook_calls.clone();
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        if h.fetch_add(1, Ordering::SeqCst) == 0 {
            e.agent().cancel(CancelOptions::default());
            e.set_retry(true);
        }
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(get(&tool_calls), 1);
    assert_eq!(get(&hook_calls), 1);
}

#[tokio::test]
async fn does_not_retry_a_hook_cancelled_tool_after_agent_cancellation() {
    let tool_calls = counter();
    let tool = counting_tool("cancelledTool", &tool_calls, "Success");
    let model = MockModel::new()
        .with_turn(tool_use_turn("cancelledTool", "tool-1", json!({})))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, vec![tool.into()], None);
    agent.add_hook(|e: &mut BeforeToolCallEvent| e.set_cancel(true));
    let hook_calls = counter();
    let h = hook_calls.clone();
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        h.fetch_add(1, Ordering::SeqCst);
        e.agent().cancel(CancelOptions::default());
        e.set_retry(true);
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(get(&tool_calls), 0);
    assert_eq!(get(&hook_calls), 1);
}

#[tokio::test]
async fn does_not_retry_tool_call_when_retry_is_not_set() {
    let tool_calls = counter();
    let t = tool_calls.clone();
    let tool = async_tool("failingTool", move |_, _| {
        t.fetch_add(1, Ordering::SeqCst);
        async { Err(ToolError::msg("Tool failed")) }
    });
    let mut agent = agent_with(one_tool_model("failingTool"), vec![tool.into()], None);
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&tool_calls), 1);
}

#[tokio::test]
async fn fires_before_tool_call_event_on_each_retry() {
    let tool_calls = counter();
    let tool = counting_tool("retryableTool", &tool_calls, "Result");
    let mut agent = agent_with(one_tool_model("retryableTool"), vec![tool.into()], None);
    let (before, after) = (counter(), counter());
    let b = before.clone();
    agent.add_hook(move |_: &mut BeforeToolCallEvent| {
        b.fetch_add(1, Ordering::SeqCst);
    });
    let a = after.clone();
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        if a.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_retry(true);
        }
    });
    agent.invoke("Test").await.unwrap();
    assert_eq!((get(&before), get(&after), get(&tool_calls)), (2, 2, 2));
}

#[tokio::test]
async fn retries_tool_call_on_success_when_hook_requests_it() {
    let tool_calls = counter();
    let tool = counting_tool("successTool", &tool_calls, "Result");
    let mut agent = agent_with(one_tool_model("successTool"), vec![tool.into()], None);
    let hook_calls = counter();
    let h = hook_calls.clone();
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        if h.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_retry(true);
        }
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!((get(&tool_calls), get(&hook_calls)), (2, 2));
}

// --- cancel tool via hooks ---

fn error_result_json(id: &str, text: &str) -> Value {
    json!({"toolResult": {"toolUseId": id, "status": "error", "content": [{"text": text}]}})
}

#[tokio::test]
async fn cancels_individual_tool_call_with_default_message_when_cancel_is_true() {
    let executed = counter();
    let tool = counting_tool("blockedTool", &executed, "Success");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(one_tool_model("blockedTool"), vec![tool.into()], Some(&plugin));
    agent.add_hook(|e: &mut BeforeToolCallEvent| e.set_cancel(true));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&executed), 0);
    let after = plugin.of("AfterToolCallEvent");
    assert_eq!(after.len(), 1);
    assert_eq!(
        after[0]["result"],
        error_result_json("tool-1", "Tool cancelled by hook")
    );
}

#[tokio::test]
async fn cancels_individual_tool_call_with_custom_message_when_cancel_is_a_string() {
    let executed = counter();
    let tool = counting_tool("blockedTool", &executed, "Success");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(one_tool_model("blockedTool"), vec![tool.into()], Some(&plugin));
    agent.add_hook(|e: &mut BeforeToolCallEvent| e.set_cancel("Tool call limit exceeded"));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&executed), 0);
    let after = plugin.of("AfterToolCallEvent");
    assert_eq!(after.len(), 1);
    assert_eq!(
        after[0]["result"],
        error_result_json("tool-1", "Tool call limit exceeded")
    );
}

#[tokio::test]
async fn cancels_only_specific_tools_when_before_tool_call_event_selectively_cancels() {
    let executed: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let e1 = executed.clone();
    let tool1 = MockTool::new("allowedTool", move |c| {
        e1.lock().unwrap().push("allowedTool");
        success(c, "Allowed")
    });
    let e2 = executed.clone();
    let tool2 = MockTool::new("blockedTool", move |c| {
        e2.lock().unwrap().push("blockedTool");
        success(c, "Blocked")
    });
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("allowedTool", "tool-1"), ("blockedTool", "tool-2")]))
        .with_turn("Done");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(model, vec![tool1.into(), tool2.into()], Some(&plugin));
    agent.set_tool_executor(ToolExecutorStrategy::Sequential);
    agent.add_hook(|e: &mut BeforeToolCallEvent| {
        if e.tool_use().name == "blockedTool" {
            e.set_cancel("This tool is blocked");
        }
    });

    let result = agent.invoke("Test").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(*executed.lock().unwrap(), ["allowedTool"]);
    let after: Vec<Value> = plugin
        .of("AfterToolCallEvent")
        .iter()
        .map(|e| e["result"].clone())
        .collect();
    assert_eq!(
        after,
        [
            json!({"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": "Allowed"}]}}),
            error_result_json("tool-2", "This tool is blocked"),
        ]
    );
}

#[tokio::test]
async fn cancels_all_tools_with_default_message_when_before_tools_event_cancel_is_true() {
    let executed = counter();
    let tool = counting_tool("blockedTool", &executed, "Success");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(one_tool_model("blockedTool"), vec![tool.into()], Some(&plugin));
    agent.add_hook(|e: &mut BeforeToolsEvent<'_>| e.set_cancel(true));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&executed), 0);
    let after = plugin.of("AfterToolsEvent");
    assert_eq!(after.len(), 1);
    assert_eq!(
        after[0]["message"]["content"][0],
        error_result_json("tool-1", "Tool cancelled by hook")
    );
}

#[tokio::test]
async fn cancels_all_tools_with_custom_message_when_before_tools_event_cancel_is_a_string() {
    let executed = counter();
    let tool = counting_tool("blockedTool", &executed, "Success");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(one_tool_model("blockedTool"), vec![tool.into()], Some(&plugin));
    agent.add_hook(|e: &mut BeforeToolsEvent<'_>| e.set_cancel("All tools blocked"));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&executed), 0);
    let after = plugin.of("AfterToolsEvent");
    assert_eq!(
        after[0]["message"]["content"][0],
        error_result_json("tool-1", "All tools blocked")
    );
}

#[tokio::test]
async fn cancels_all_tools_in_a_batch_via_before_tools_event_with_correct_tool_use_ids() {
    let executed = counter();
    let tool1 = counting_tool("tool1", &executed, "Result 1");
    let tool2 = counting_tool("tool2", &executed, "Result 2");
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("tool1", "tool-1"), ("tool2", "tool-2")]))
        .with_turn("Done");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(model, vec![tool1.into(), tool2.into()], Some(&plugin));
    agent.add_hook(|e: &mut BeforeToolsEvent<'_>| e.set_cancel("Batch cancelled"));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&executed), 0);
    let after = plugin.of("AfterToolsEvent");
    assert_eq!(after.len(), 1);
    assert_eq!(
        after[0]["message"]["content"],
        json!([
            error_result_json("tool-1", "Batch cancelled"),
            error_result_json("tool-2", "Batch cancelled"),
        ])
    );
}

#[tokio::test]
async fn emits_cancel_events_correctly_via_stream() {
    let executed = counter();
    let tool = counting_tool("blockedTool", &executed, "Success");
    let mut agent = agent_with(one_tool_model("blockedTool"), vec![tool.into()], None);
    agent.add_hook(|e: &mut BeforeToolCallEvent| e.set_cancel("Cancelled via stream"));

    let events = collect(agent.stream("Test")).await;

    assert_eq!(get(&executed), 0);
    let before = events
        .iter()
        .filter(|e| matches!(e, AgentStreamEvent::BeforeToolCall(_)))
        .count();
    let after: Vec<&AgentStreamEvent> = events
        .iter()
        .filter(|e| matches!(e, AgentStreamEvent::AfterToolCall(_)))
        .collect();
    assert_eq!((before, after.len()), (1, 1));
    assert_eq!(
        serde_json::to_value(after[0]).unwrap()["result"],
        error_result_json("tool-1", "Cancelled via stream")
    );
}

#[tokio::test]
async fn allows_retry_after_cancel_on_before_tool_call_event() {
    let tool_calls = counter();
    let tool = counting_tool("retryTool", &tool_calls, "Success");
    let mut agent = agent_with(one_tool_model("retryTool"), vec![tool.into()], None);
    let before = counter();
    let b = before.clone();
    agent.add_hook(move |e: &mut BeforeToolCallEvent| {
        if b.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_cancel("Not yet");
        }
    });
    let b = before.clone();
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        if e.result().status == strands::ToolResultStatus::Error && get(&b) == 1 {
            e.set_retry(true);
        }
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&before), 2);
    assert_eq!(get(&tool_calls), 1);
}

fn tool_result_of(agent: &Agent, tool_use_id: &str) -> ToolResultBlock {
    agent
        .messages()
        .iter()
        .flat_map(|m| m.content.iter())
        .find_map(|block| match block {
            ContentBlock::ToolResult(result) if result.tool_use_id == tool_use_id => Some(result.clone()),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn allows_hooks_to_replace_result_on_after_tool_call_event() {
    let tool = MockTool::text("myTool", "original result");
    let mut agent = agent_with(one_tool_model("myTool"), vec![tool.into()], None);
    agent.add_hook(|e: &mut AfterToolCallEvent| {
        let id = e.result().tool_use_id.clone();
        e.set_result(ToolResultBlock::success(
            id,
            vec![ToolResultContent::text("replaced result")],
        ));
    });
    agent.invoke("Test").await.unwrap();
    assert_eq!(
        tool_result_of(&agent, "tool-1"),
        ToolResultBlock::success("tool-1", vec![ToolResultContent::text("replaced result")])
    );
}

// --- AfterToolsEvent.endTurn ---

fn single_tool_setup() -> (MockTool, MockModel) {
    let model = MockModel::new()
        .with_turn(tool_use_turn("myTool", "tool-1", json!({})))
        .with_turn("Should not reach this");
    (MockTool::text("myTool", "result"), model)
}

fn end_turn_agent(end_turn: impl Into<EndTurn> + Clone + Send + Sync + 'static) -> (Agent, MockModel) {
    let (tool, model) = single_tool_setup();
    let agent = agent_with(model.clone(), vec![tool.into()], None);
    agent.add_hook(move |e: &mut AfterToolsEvent<'_>| e.set_end_turn(end_turn.clone()));
    (agent, model)
}

#[tokio::test]
async fn halts_the_loop_when_end_turn_is_true_with_default_message() {
    let (mut agent, model) = end_turn_agent(true);
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().role, Role::Assistant);
    assert!(
        result
            .last_message()
            .content
            .contains(&ContentBlock::text("Turn ended early by hook after tool execution"))
    );
    assert_eq!(model.call_count(), 1);
}

#[tokio::test]
async fn halts_the_loop_with_custom_assistant_message_when_end_turn_is_a_string() {
    let (mut agent, model) = end_turn_agent("enough information gathered");
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(
        result
            .last_message()
            .content
            .contains(&ContentBlock::text("enough information gathered"))
    );
    assert_eq!(model.call_count(), 1);
}

#[tokio::test]
async fn does_not_halt_when_end_turn_is_false_default() {
    let (tool, model) = single_tool_setup();
    let mut agent = agent_with(model.clone(), vec![tool.into()], None);
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().role, Role::Assistant);
    assert_eq!(model.call_count(), 2);
}

#[tokio::test]
async fn treats_empty_string_end_turn_as_falsy_does_not_halt() {
    let (mut agent, model) = end_turn_agent("");
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(model.call_count(), 2);
}

#[tokio::test]
async fn treats_empty_array_end_turn_as_falsy_does_not_halt() {
    let (mut agent, model) = end_turn_agent(Vec::<ContentBlock>::new());
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(model.call_count(), 2);
}

#[tokio::test]
async fn halts_with_content_blocks_when_end_turn_is_a_content_block_array() {
    let (mut agent, model) = end_turn_agent(vec![ContentBlock::text("delegated response")]);
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        result.last_message().content,
        [ContentBlock::text("delegated response")]
    );
    assert_eq!(
        agent.messages().last().unwrap().content,
        [ContentBlock::text("delegated response")]
    );
    assert_eq!(model.call_count(), 1);
}

#[tokio::test]
async fn shallow_copies_the_end_turn_array_so_later_mutation_does_not_affect_history() {
    let hook_list = Arc::new(Mutex::new(vec![ContentBlock::text("from hook")]));
    let (tool, model) = single_tool_setup();
    let mut agent = agent_with(model, vec![tool.into()], None);
    let list = hook_list.clone();
    agent.add_hook(move |e: &mut AfterToolsEvent<'_>| e.set_end_turn(list.lock().unwrap().clone()));

    agent.invoke("Test").await.unwrap();
    hook_list
        .lock()
        .unwrap()
        .push(ContentBlock::text("MUTATED AFTER THE FACT"));

    assert_eq!(
        agent.messages().last().unwrap().content,
        [ContentBlock::text("from hook")]
    );
}

#[tokio::test]
async fn appends_tool_results_and_default_end_turn_message_to_conversation_history() {
    let (mut agent, _) = end_turn_agent(true);
    agent.invoke("Test").await.unwrap();
    let messages = agent.messages();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].role, Role::User);
    assert_eq!(messages[1].role, Role::Assistant);
    assert!(matches!(messages[1].content[0], ContentBlock::ToolUse(_)));
    assert_eq!(messages[2].role, Role::User);
    assert!(matches!(messages[2].content[0], ContentBlock::ToolResult(_)));
    assert_eq!(messages[3].role, Role::Assistant);
    assert_eq!(
        messages[3].content,
        [ContentBlock::text("Turn ended early by hook after tool execution")]
    );
}

#[tokio::test]
async fn halts_the_loop_with_concurrent_tool_execution() {
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("tool1", "tool-1"), ("tool2", "tool-2")]))
        .with_turn("Should not reach this");
    let tools = vec![
        MockTool::text("tool1", "Result 1").into(),
        MockTool::text("tool2", "Result 2").into(),
    ];
    let mut agent = agent_with(model.clone(), tools, None);
    agent.set_tool_executor(ToolExecutorStrategy::Concurrent);
    agent.add_hook(|e: &mut AfterToolsEvent<'_>| e.set_end_turn(true));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().role, Role::Assistant);
    assert_eq!(model.call_count(), 1);
}

#[tokio::test]
async fn emits_after_tools_event_with_end_turn_via_stream() {
    let (mut agent, _) = end_turn_agent(true);
    let end_turns: Arc<Mutex<Vec<EndTurn>>> = Arc::default();
    let seen = end_turns.clone();
    agent.add_hook_with(
        move |e: &mut AfterToolsEvent<'_>| seen.lock().unwrap().push(e.end_turn().clone()),
        HookCallbackOptions {
            order: HookOrder::SDK_LAST,
        },
    );

    let events = collect(agent.stream("Test")).await;

    let after_tools = events
        .iter()
        .filter(|e| matches!(e, AgentStreamEvent::AfterTools(_)))
        .count();
    assert_eq!(after_tools, 1);
    assert_eq!(*end_turns.lock().unwrap(), [EndTurn::End]);
    let results: Vec<StopReason> = events
        .iter()
        .filter_map(|e| match e {
            AgentStreamEvent::AgentResult(result) => Some(result.stop_reason()),
            _ => None,
        })
        .collect();
    assert_eq!(results, [StopReason::EndTurn]);
}

#[tokio::test]
async fn halts_even_when_set_on_a_cancelled_tools_after_tools_event() {
    let (mut agent, model) = end_turn_agent(true);
    agent.add_hook(|e: &mut BeforeToolsEvent<'_>| e.set_cancel(true));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().role, Role::Assistant);
    assert_eq!(model.call_count(), 1);
}

// --- cancel invocation via hooks ---

#[tokio::test]
async fn cancels_invocation_with_default_message_when_cancel_is_true() {
    let plugin = MockPlugin::default();
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], Some(&plugin));
    agent.add_hook(|e: &mut BeforeInvocationEvent<'_>| e.set_cancel(true));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        result.last_message().content[0],
        ContentBlock::text("invocation denied by hook")
    );
    assert!(plugin.of("BeforeModelCallEvent").is_empty());
}

#[tokio::test]
async fn cancels_invocation_with_custom_message_when_cancel_is_a_string() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    agent.add_hook(|e: &mut BeforeInvocationEvent<'_>| e.set_cancel("Unauthorized user"));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        result.last_message().content[0],
        ContentBlock::text("Unauthorized user")
    );
}

#[tokio::test]
async fn does_not_append_user_message_when_invocation_is_cancelled() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    agent.add_hook(|e: &mut BeforeInvocationEvent<'_>| e.set_cancel(true));
    agent.invoke("Test").await.unwrap();
    assert_eq!(agent.messages().len(), 1);
    assert_eq!(agent.messages()[0].role, Role::Assistant);
}

#[tokio::test]
async fn emits_after_invocation_event_when_invocation_is_cancelled() {
    let plugin = MockPlugin::default();
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], Some(&plugin));
    agent.add_hook(|e: &mut BeforeInvocationEvent<'_>| e.set_cancel(true));
    agent.invoke("Test").await.unwrap();
    assert_eq!(plugin.of("BeforeInvocationEvent").len(), 1);
    assert_eq!(plugin.of("AfterInvocationEvent").len(), 1);
}

// --- cancel model call via hooks ---

#[tokio::test]
async fn cancels_model_call_with_default_message_when_cancel_is_true() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    agent.add_hook(|e: &mut BeforeModelCallEvent<'_>| e.set_cancel(true));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        result.last_message().content[0],
        ContentBlock::text("model call denied by hook")
    );
}

#[tokio::test]
async fn cancels_model_call_with_custom_message_when_cancel_is_a_string() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    agent.add_hook(|e: &mut BeforeModelCallEvent<'_>| e.set_cancel("Rate limited"));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().content[0], ContentBlock::text("Rate limited"));
}

#[tokio::test]
async fn emits_after_model_call_event_when_model_call_is_cancelled() {
    let plugin = MockPlugin::default();
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], Some(&plugin));
    agent.add_hook(|e: &mut BeforeModelCallEvent<'_>| e.set_cancel(true));
    agent.invoke("Test").await.unwrap();
    assert_eq!(plugin.of("BeforeModelCallEvent").len(), 1);
    assert_eq!(plugin.of("AfterModelCallEvent").len(), 1);
}

#[tokio::test]
async fn does_not_emit_model_message_event_when_model_call_is_cancelled() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    let model_messages = counter();
    let m = model_messages.clone();
    agent.add_hook(move |_: &mut ModelMessageEvent<'_>| {
        m.fetch_add(1, Ordering::SeqCst);
    });
    agent.add_hook(|e: &mut BeforeModelCallEvent<'_>| e.set_cancel(true));
    agent.invoke("Test").await.unwrap();
    assert_eq!(get(&model_messages), 0);
}

#[tokio::test]
async fn allows_retry_after_cancel_on_model_call() {
    let mut agent = agent_with(MockModel::from_turns(["Hello"]), vec![], None);
    let before = counter();
    let b = before.clone();
    agent.add_hook(move |e: &mut BeforeModelCallEvent<'_>| {
        if b.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_cancel("Not yet");
        }
    });
    let b = before.clone();
    agent.add_hook(move |e: &mut AfterModelCallEvent<'_>| {
        if get(&b) == 1 {
            e.set_retry(true);
        }
    });
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(get(&before), 2);
    assert_eq!(result.last_message().content[0], ContentBlock::text("Hello"));
}

// --- BeforeToolCallEvent selectedTool ---

#[tokio::test]
async fn invokes_the_replacement_tool_instead_of_the_registry_tool() {
    let (original_runs, replacement_runs) = (counter(), counter());
    let original = counting_tool("originalTool", &original_runs, "original");
    let replacement: Arc<dyn Tool> = Arc::new(counting_tool("replacementTool", &replacement_runs, "replacement"));
    let plugin = MockPlugin::default();
    let mut agent = agent_with(one_tool_model("originalTool"), vec![original.into()], Some(&plugin));
    agent.add_hook(move |e: &mut BeforeToolCallEvent| e.set_selected_tool(replacement.clone()));

    agent.invoke("Test").await.unwrap();

    assert_eq!((get(&original_runs), get(&replacement_runs)), (0, 1));
    let after = plugin.of("AfterToolCallEvent");
    assert_eq!(after.len(), 1);
    assert_eq!(
        after[0]["result"]["toolResult"]["content"],
        json!([{"text": "replacement"}])
    );
}

#[tokio::test]
async fn cancel_wins_over_selected_tool() {
    let replacement_runs = counter();
    let replacement: Arc<dyn Tool> = Arc::new(counting_tool("replacementTool", &replacement_runs, "replacement"));
    let registry_tool = MockTool::text("registryTool", "registry");
    let mut agent = agent_with(one_tool_model("registryTool"), vec![registry_tool.into()], None);
    let selected = replacement.clone();
    agent.add_hook(move |e: &mut BeforeToolCallEvent| {
        e.set_selected_tool(selected.clone());
        e.set_cancel("blocked");
    });
    let reported: Arc<Mutex<Vec<bool>>> = Arc::default();
    let (seen, expected) = (reported.clone(), replacement.clone());
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        seen.lock()
            .unwrap()
            .push(e.tool().is_some_and(|tool| Arc::ptr_eq(tool, &expected)));
    });

    agent.invoke("Test").await.unwrap();

    assert_eq!(get(&replacement_runs), 0);
    assert_eq!(*reported.lock().unwrap(), [true]);
}

#[tokio::test]
async fn selected_tool_works_with_concurrent_tool_executor() {
    let (original_runs, replacement_runs) = (counter(), counter());
    let original = counting_tool("originalTool", &original_runs, "original");
    let replacement: Arc<dyn Tool> = Arc::new(counting_tool("replacementTool", &replacement_runs, "replacement"));
    let other = MockTool::text("otherTool", "other");
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("originalTool", "tool-1"), ("otherTool", "tool-2")]))
        .with_turn("Done");
    let mut agent = agent_with(model, vec![original.into(), other.into()], None);
    agent.set_tool_executor(ToolExecutorStrategy::Concurrent);
    agent.add_hook(move |e: &mut BeforeToolCallEvent| {
        if e.tool_use().name == "originalTool" {
            e.set_selected_tool(replacement.clone());
        }
    });
    agent.invoke("Test").await.unwrap();
    assert_eq!((get(&original_runs), get(&replacement_runs)), (0, 1));
}

// --- BeforeToolCallEvent toolUse mutation ---

fn capturing_tool(name: &str, captured: &Arc<Mutex<Vec<(String, Value)>>>) -> MockTool {
    let captured = captured.clone();
    MockTool::new(name, move |context| {
        captured
            .lock()
            .unwrap()
            .push((context.tool_use().name.clone(), context.tool_use().input.clone()));
        success(context, "ok")
    })
}

#[tokio::test]
async fn passes_mutated_input_to_the_tool() {
    let captured: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let tool = capturing_tool("tool", &captured);
    let model = MockModel::new()
        .with_turn(tool_use_turn("tool", "tool-1", json!({"a": 1})))
        .with_turn("Done");
    let mut agent = agent_with(model, vec![tool.into()], None);
    agent.add_hook(|e: &mut BeforeToolCallEvent| e.tool_use_mut().input = json!({"a": 2, "injected": true}));
    agent.invoke("Test").await.unwrap();
    let inputs: Vec<Value> = captured
        .lock()
        .unwrap()
        .iter()
        .map(|(_, input)| input.clone())
        .collect();
    assert_eq!(inputs, [json!({"a": 2, "injected": true})]);
}

#[tokio::test]
async fn re_resolves_the_tool_when_hook_renames_tool_use_name() {
    let (orig_runs, renamed_runs) = (counter(), counter());
    let orig = counting_tool("orig", &orig_runs, "orig");
    let renamed = counting_tool("renamed", &renamed_runs, "renamed");
    let mut agent = agent_with(one_tool_model("orig"), vec![orig.into(), renamed.into()], None);
    agent.add_hook(|e: &mut BeforeToolCallEvent| e.tool_use_mut().name = "renamed".into());
    agent.invoke("Test").await.unwrap();
    assert_eq!((get(&orig_runs), get(&renamed_runs)), (0, 1));
}

#[tokio::test]
async fn tool_use_mutation_works_with_concurrent_tool_executor() {
    let captured: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let model = MockModel::new()
        .with_turn(MockTurn::content([
            ContentBlock::from(strands::types::ToolUseBlock::new(
                "toolA",
                "a",
                json!({"original": "a"}),
            )),
            ContentBlock::from(strands::types::ToolUseBlock::new(
                "toolB",
                "b",
                json!({"original": "b"}),
            )),
        ]))
        .with_turn("Done");
    let tools = vec![
        capturing_tool("toolA", &captured).into(),
        capturing_tool("toolB", &captured).into(),
    ];
    let mut agent = agent_with(model, tools, None);
    agent.set_tool_executor(ToolExecutorStrategy::Concurrent);
    agent.add_hook(|e: &mut BeforeToolCallEvent| {
        let name = e.tool_use().name.clone();
        e.tool_use_mut().input = json!({"mutated": name});
    });
    agent.invoke("Test").await.unwrap();
    let mut seen = captured.lock().unwrap().clone();
    seen.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        seen,
        [
            ("toolA".to_owned(), json!({"mutated": "toolA"})),
            ("toolB".to_owned(), json!({"mutated": "toolB"})),
        ]
    );
}

// --- AfterToolCallEvent result mutation ---

fn redact(e: &mut AfterToolCallEvent) {
    e.set_result(ToolResultBlock::success(
        "tool-1",
        vec![ToolResultContent::text("[REDACTED]")],
    ));
}

#[tokio::test]
async fn propagates_mutated_result_into_the_conversation_message() {
    let tool = MockTool::text("tool", "SECRET_VALUE");
    let mut agent = agent_with(one_tool_model("tool"), vec![tool.into()], None);
    agent.add_hook(redact);
    agent.invoke("Test").await.unwrap();
    assert_eq!(
        tool_result_of(&agent, "tool-1").content,
        [ToolResultContent::text("[REDACTED]")]
    );
}

#[tokio::test]
async fn propagates_mutated_result_into_after_tools_event() {
    let tool = MockTool::text("tool", "SECRET_VALUE");
    let plugin = MockPlugin::default();
    let mut agent = agent_with(one_tool_model("tool"), vec![tool.into()], Some(&plugin));
    agent.add_hook(redact);
    agent.invoke("Test").await.unwrap();
    let after = plugin.of("AfterToolsEvent");
    assert_eq!(after.len(), 1);
    assert_eq!(
        after[0]["message"]["content"][0]["toolResult"]["content"],
        json!([{"text": "[REDACTED]"}])
    );
}

// --- AfterInvocationEvent resume ---

#[tokio::test]
async fn re_invokes_the_agent_with_the_resume_args() {
    let mut agent = agent_with(MockModel::from_turns(["first", "second"]), vec![], None);
    let invocations = counter();
    let i = invocations.clone();
    agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
        if i.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_resume("follow-up");
        }
    });
    let result = agent.invoke("initial").await.unwrap();
    assert_eq!(get(&invocations), 2);
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.to_string(), "second");
    assert_eq!(result.metrics().unwrap().cycle_count, 2);
}

#[tokio::test]
async fn chains_multiple_resumes() {
    let mut agent = agent_with(MockModel::from_turns(["a", "b", "c"]), vec![], None);
    let invocations = counter();
    let i = invocations.clone();
    agent.add_hook(
        move |e: &mut AfterInvocationEvent<'_>| match i.fetch_add(1, Ordering::SeqCst) {
            0 => e.set_resume("second"),
            1 => e.set_resume("third"),
            _ => {}
        },
    );
    let result = agent.invoke("first").await.unwrap();
    assert_eq!(get(&invocations), 3);
    assert_eq!(result.last_message().content[0], ContentBlock::text("c"));
}

#[tokio::test]
async fn does_not_resume_when_resume_is_left_undefined() {
    let mut agent = agent_with(MockModel::from_turns(["only"]), vec![], None);
    let invocations = counter();
    let i = invocations.clone();
    agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| {
        i.fetch_add(1, Ordering::SeqCst);
    });
    agent.invoke("hi").await.unwrap();
    assert_eq!(get(&invocations), 1);
}

#[tokio::test]
async fn does_not_resume_when_the_invocation_errors() {
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("boom")));
    let mut agent = agent_with(model, vec![], None);
    let invocations = counter();
    let i = invocations.clone();
    agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
        i.fetch_add(1, Ordering::SeqCst);
        e.set_resume("should-not-run");
    });
    let error = agent.invoke("hi").await.unwrap_err();
    assert!(error.to_string().contains("boom"), "{error}");
    assert_eq!(get(&invocations), 1);
}

#[tokio::test]
async fn first_registered_hook_wins_when_multiple_hooks_set_resume() {
    let mut agent = agent_with(MockModel::from_turns(["first", "second"]), vec![], None);
    let invocations = counter();
    let i = invocations.clone();
    agent.add_hook(move |_: &mut BeforeInvocationEvent<'_>| {
        i.fetch_add(1, Ordering::SeqCst);
    });
    let i = invocations.clone();
    agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
        if get(&i) == 1 {
            e.set_resume("first-registered wins");
        }
    });
    let i = invocations.clone();
    agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
        if get(&i) == 1 {
            e.set_resume("second-registered loses");
        }
    });

    agent.invoke("initial").await.unwrap();

    let user_texts: Vec<String> = agent
        .messages()
        .iter()
        .filter(|m| m.role == Role::User)
        .map(Message::text)
        .collect();
    assert_eq!(user_texts, ["initial", "first-registered wins"]);
}

#[tokio::test]
async fn ignores_resume_set_during_an_erroring_invocation() {
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("boom")));
    let mut agent = agent_with(model, vec![], None);
    agent.add_hook(|e: &mut AfterInvocationEvent<'_>| e.set_resume("should not run"));
    let passes = counter();
    let p = passes.clone();
    agent.add_hook(move |_: &mut BeforeInvocationEvent<'_>| {
        p.fetch_add(1, Ordering::SeqCst);
    });
    let error = agent.invoke("hi").await.unwrap_err();
    assert!(error.to_string().contains("boom"), "{error}");
    assert_eq!(get(&passes), 1);
}

#[tokio::test]
async fn emits_only_one_agent_result_event_for_a_resumed_chain() {
    let mut agent = agent_with(MockModel::from_turns(["first", "second"]), vec![], None);
    let invocations = counter();
    let i = invocations.clone();
    agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
        if i.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_resume("follow-up");
        }
    });
    let events = collect(agent.stream("initial")).await;
    let count = |kind: &str| events.iter().filter(|e| e.event_type() == kind).count();
    assert_eq!(count("agentResultEvent"), 1);
    assert_eq!(count("afterInvocationEvent"), 2);
}

// --- queue-based lifecycle plugin (WASM bridge pattern) ---

struct LifecycleBridgePlugin {
    queue: Arc<Mutex<Vec<&'static str>>>,
}

#[strands::async_trait]
impl Plugin for LifecycleBridgePlugin {
    fn name(&self) -> &str {
        "strands:lifecycle-bridge"
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> strands::Result<()> {
        macro_rules! queue_on {
            ($($event:ty => $label:literal),* $(,)?) => {$(
                let queue = self.queue.clone();
                agent.add_hook(move |_: &mut $event| queue.lock().unwrap().push($label));
            )*};
        }
        queue_on! {
            InitializedEvent<'_> => "initialized",
            BeforeInvocationEvent<'_> => "before-invocation",
            AfterInvocationEvent<'_> => "after-invocation",
            BeforeModelCallEvent<'_> => "before-model-call",
            AfterModelCallEvent<'_> => "after-model-call",
            MessageAddedEvent<'_> => "message-added",
            BeforeToolCallEvent => "before-tool-call",
            AfterToolCallEvent => "after-tool-call",
        }
        Ok(())
    }
}

#[tokio::test]
async fn receives_lifecycle_events_when_registered_via_plugins_config() {
    let queue: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let plugin = LifecycleBridgePlugin { queue: queue.clone() };
    let mut agent = Agent::builder()
        .model(MockModel::from_turns(["Hello"]))
        .plugins(vec![Arc::new(plugin) as Arc<dyn Plugin>])
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("Hi").await.unwrap();
    assert_eq!(
        *queue.lock().unwrap(),
        [
            "initialized",
            "before-invocation",
            "message-added",
            "before-model-call",
            "after-model-call",
            "message-added",
            "after-invocation",
        ]
    );
}

// --- plugin initialization failure ---

struct FailingPlugin;

#[strands::async_trait]
impl Plugin for FailingPlugin {
    fn name(&self) -> &str {
        "failing-plugin"
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> strands::Result<()> {
        Err(Error::other("plugin initialization failed"))
    }
}

#[tokio::test]
async fn keeps_a_plugin_initialization_failure_fail_closed_across_retries() {
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .plugins(vec![Arc::new(FailingPlugin) as Arc<dyn Plugin>])
        .printer(false)
        .build()
        .unwrap();
    let first = agent.initialize().await.unwrap_err();
    let second = agent.initialize().await.unwrap_err();
    assert_eq!(first.to_string(), "plugin initialization failed");
    assert_eq!(second.to_string(), "plugin initialization failed");
    let third = agent.invoke("Hi").await.unwrap_err();
    assert_eq!(third.to_string(), "plugin initialization failed");
}
