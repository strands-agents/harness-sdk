//! Agent loop edge cases: a sub-agent raising several interrupts, dropping the
//! stream at each point of an invocation, panicking tools and hooks, hook errors, the size of
//! errors and stream events, and the builder's conversions.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockTool, tool_use_turn, tool_uses_turn, types};
use futures::StreamExt;
use serde_json::json;
use strands::hooks::{
    AfterInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, InitializedEvent, MessageAddedEvent,
};
use strands::plugins::Plugin;
use strands::retry::{ModelRetryContext, ModelRetryStrategy, RetryDecision, RetryStrategy};
use strands::testing::{MockModel, MockTurn};
use strands::tools::{ToolStream, ToolStreamEvent, ToolStreamItem};
use strands::types::{ToolResultContent, ToolResultStatus, ToolSpec, ToolUseBlock};
use strands::{
    Agent, AgentStreamEvent, BoxError, ContentBlock, Error, LocalAgent, Message, Role, StopReason, Tool, ToolContext,
    ToolResultBlock, async_trait,
};

fn shape(agent: &Agent) -> Vec<String> {
    agent
        .messages()
        .iter()
        .map(|message| {
            let kinds: Vec<&str> = message
                .content
                .iter()
                .map(|block| match block {
                    ContentBlock::ToolUse(_) => "toolUse",
                    ContentBlock::ToolResult(_) => "toolResult",
                    ContentBlock::Text(_) => "text",
                    _ => "other",
                })
                .collect();
            format!("{:?}:{}", message.role, kinds.join(","))
        })
        .collect()
}

fn has_tool_use(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse(_)))
}

fn added_log(agent: &Agent) -> Arc<Mutex<Vec<String>>> {
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = log.clone();
    agent.add_hook(move |event: &mut MessageAddedEvent<'_>| {
        let message = event.message();
        let label = format!(
            "{:?}:{}",
            message.role,
            if has_tool_use(message) { "toolUse" } else { "" }
        );
        seen.lock().unwrap().push(label);
    });
    log
}

fn ok_agent(model: MockModel) -> Agent {
    Agent::builder()
        .model(model)
        .printer(false)
        .tools([MockTool::text("t", "ok")])
        .build()
        .unwrap()
}

fn asker(name: &'static str) -> MockTool {
    MockTool::new(name, move |context| {
        let id = context.tool_use().tool_use_id.clone();
        match context.interrupt(format!("ask-{name}")) {
            Ok(_) => ToolResultBlock::success(id, vec![ToolResultContent::text("answered")]).into(),
            Err(interrupts) => interrupts.into(),
        }
    })
}

/// C8: a sub-agent that stops for two interrupts surfaces both on the calling agent.
#[tokio::test]
async fn a_sub_agent_with_two_interrupts_raises_both_on_the_parent() {
    let child_model = MockModel::new().with_turn(MockTurn::content([
        ContentBlock::from(ToolUseBlock::new("a", "ca", json!({}))),
        ContentBlock::from(ToolUseBlock::new("b", "cb", json!({}))),
    ]));
    let child = Agent::builder()
        .model(child_model)
        .printer(false)
        .name("child")
        .tools([asker("a"), asker("b")])
        .build()
        .unwrap();
    let parent_model = MockModel::new().with_turn(tool_use_turn("child", "p1", json!({"input": "do it"})));
    let mut parent = Agent::builder()
        .model(parent_model)
        .printer(false)
        .tools([child])
        .build()
        .unwrap();

    let mut interrupt_events = Vec::new();
    let mut result = None;
    let mut stream = parent.stream("go");
    while let Some(event) = stream.next().await {
        match event.unwrap() {
            AgentStreamEvent::Interrupt(data) => interrupt_events.push(data.interrupt.name),
            AgentStreamEvent::AgentResult(data) => result = Some(data),
            _ => {}
        }
    }
    drop(stream);
    assert_eq!(interrupt_events, ["ask-a", "ask-b"]);
    let result = result.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    let names: Vec<&str> = result
        .interrupts()
        .iter()
        .map(|interrupt| interrupt.name.as_str())
        .collect();
    assert_eq!(names, ["ask-a", "ask-b"]);
}

/// C1: a stream dropped when the assistant tool-use message is reported leaves history
/// re-invokable, and the deferred `MessageAddedEvent`s still fire.
#[tokio::test]
async fn dropping_the_stream_at_the_tool_use_message_keeps_history_re_invokable() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("t", "id1", json!({})))
        .with_turn("done");
    let mut agent = ok_agent(model);
    let log = added_log(&agent);
    {
        let mut stream = agent.stream("go");
        while let Some(event) = stream.next().await {
            if let AgentStreamEvent::MessageAdded(data) = event.unwrap()
                && has_tool_use(&data.message)
            {
                break;
            }
        }
    }
    assert_eq!(
        shape(&agent),
        ["User:text", "Assistant:toolUse", "User:toolResult", "Assistant:text"]
    );
    assert_eq!(agent.messages()[3].text(), "Cancelled by user");
    let result = agent.invoke("again").await.unwrap();
    assert_eq!(result.to_string(), "done");
    assert_eq!(
        *log.lock().unwrap(),
        [
            "User:",
            "Assistant:toolUse",
            "User:",
            "Assistant:",
            "User:",
            "Assistant:"
        ]
    );
}

/// C1: dropped while a `MessageAddedEvent` hook for the tool-use message is pending.
#[tokio::test(start_paused = true)]
async fn dropping_the_stream_inside_a_message_added_hook_keeps_history_re_invokable() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("t", "id1", json!({})))
        .with_turn("done");
    let mut agent = ok_agent(model);
    let slow_calls = Arc::new(AtomicUsize::new(0));
    let calls = slow_calls.clone();
    agent.add_async_hook::<MessageAddedEvent<'_>>(move |event| {
        let first_tool_use = has_tool_use(event.message()) && calls.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first_tool_use {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        })
    });
    {
        let stream = agent.stream("go");
        let _ = tokio::time::timeout(Duration::from_millis(200), stream.collect::<Vec<_>>()).await;
    }
    assert_eq!(
        shape(&agent),
        ["User:text", "Assistant:toolUse", "User:toolResult", "Assistant:text"]
    );
    agent.invoke("again").await.unwrap();
    assert_eq!(slow_calls.load(Ordering::SeqCst), 2);
}

struct SlowPlugin {
    name: &'static str,
    inits: Arc<AtomicUsize>,
    delay: Duration,
}

#[async_trait]
impl Plugin for SlowPlugin {
    fn name(&self) -> &str {
        self.name
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> strands::Result<()> {
        tokio::time::sleep(self.delay).await;
        self.inits.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// C3: a stream dropped during a plugin's initialization continues with that plugin next time,
/// and `InitializedEvent` fires once.
#[tokio::test(start_paused = true)]
async fn dropping_the_stream_during_plugin_initialization_initializes_every_plugin_once() {
    let inits_a = Arc::new(AtomicUsize::new(0));
    let inits_b = Arc::new(AtomicUsize::new(0));
    let plugins: Vec<Arc<dyn Plugin>> = vec![
        Arc::new(SlowPlugin {
            name: "slow-a",
            inits: inits_a.clone(),
            delay: Duration::from_millis(500),
        }),
        Arc::new(SlowPlugin {
            name: "slow-b",
            inits: inits_b.clone(),
            delay: Duration::from_millis(1),
        }),
    ];
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .printer(false)
        .plugins(plugins)
        .build()
        .unwrap();
    let initialized = Arc::new(AtomicUsize::new(0));
    let counter = initialized.clone();
    agent.add_hook(move |_: &mut InitializedEvent<'_>| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    {
        let stream = agent.stream("go");
        let _ = tokio::time::timeout(Duration::from_millis(100), stream.collect::<Vec<_>>()).await;
    }
    let result = agent.invoke("go").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(inits_a.load(Ordering::SeqCst), 1);
    assert_eq!(inits_b.load(Ordering::SeqCst), 1);
    assert_eq!(initialized.load(Ordering::SeqCst), 1);
}

/// C4: a cleanup that is itself dropped still runs the deferred `AfterInvocationEvent` once.
#[tokio::test(start_paused = true)]
async fn dropping_the_stream_during_deferred_cleanup_runs_the_rest_next_time() {
    let model = MockModel::new()
        .with_turn(MockTurn::text("long").with_delay(Duration::from_secs(3600)))
        .with_turn("second");
    let mut agent = Agent::builder().model(model).printer(false).build().unwrap();
    let after = Arc::new(AtomicUsize::new(0));
    let counter = after.clone();
    agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let slow = Arc::new(AtomicUsize::new(0));
    let slow_calls = slow.clone();
    agent.add_async_hook::<MessageAddedEvent<'_>>(move |event| {
        let first_cancel =
            event.message().text() == "Cancelled by user" && slow_calls.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first_cancel {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        })
    });
    {
        let stream = agent.stream("one");
        let _ = tokio::time::timeout(Duration::from_millis(50), stream.collect::<Vec<_>>()).await;
    }
    {
        let stream = agent.stream("two");
        let _ = tokio::time::timeout(Duration::from_millis(100), stream.collect::<Vec<_>>()).await;
    }
    assert_eq!(after.load(Ordering::SeqCst), 0);
    agent.invoke("three").await.unwrap();
    assert_eq!(after.load(Ordering::SeqCst), 2);
}

/// C5: callbacks of an `AfterInvocationEvent` cut short by a drop run once each.
#[tokio::test(start_paused = true)]
async fn dropping_the_stream_in_an_after_invocation_hook_runs_each_callback_once() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("one").with_turn("two"))
        .printer(false)
        .build()
        .unwrap();
    let slow = Arc::new(AtomicUsize::new(0));
    let slow_calls = slow.clone();
    agent.add_async_hook::<AfterInvocationEvent<'_>>(move |_event| {
        let call = slow_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call == 0 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        })
    });
    let quick = Arc::new(AtomicUsize::new(0));
    let counter = quick.clone();
    agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    {
        let stream = agent.stream("one");
        let _ = tokio::time::timeout(Duration::from_millis(100), stream.collect::<Vec<_>>()).await;
    }
    agent.invoke("two").await.unwrap();
    assert_eq!(quick.load(Ordering::SeqCst), 2);
    assert_eq!(slow.load(Ordering::SeqCst), 3);
}

struct PanicTool;

impl Tool for PanicTool {
    fn name(&self) -> &str {
        "boom"
    }

    fn description(&self) -> &str {
        "boom"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new("boom", "boom").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, _context: ToolContext) -> ToolStream {
        ToolStream::from_future(async move {
            tokio::task::yield_now().await;
            panic!("kaboom");
        })
    }
}

/// C2: a panicking tool never costs a sibling its result.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_panicking_tool_keeps_every_sibling_result() {
    for _ in 0..200 {
        let mut calls = vec![("boom", "b")];
        let names: Vec<String> = (0..6).map(|index| format!("q{index}")).collect();
        let ids: Vec<String> = (0..6).map(|index| format!("id{index}")).collect();
        calls.extend(names.iter().map(String::as_str).zip(ids.iter().map(String::as_str)));
        let mut tools: Vec<strands::ToolSource> = vec![PanicTool.into()];
        tools.extend(names.iter().map(|name| MockTool::text(name, "fine").into()));
        let mut agent = Agent::builder()
            .model(MockModel::new().with_turn(tool_uses_turn(&calls)).with_turn("done"))
            .printer(false)
            .tools(tools)
            .build()
            .unwrap();
        agent.invoke("go").await.unwrap();
        let results = &agent.messages()[2];
        assert_eq!(results.role, Role::User);
        for block in &results.content {
            let ContentBlock::ToolResult(result) = block else {
                panic!("expected tool results");
            };
            let text = match &result.content[..] {
                [ToolResultContent::Text(text)] => text.text.clone(),
                other => panic!("unexpected content: {other:?}"),
            };
            if result.tool_use_id == "b" {
                assert_eq!(result.status, ToolResultStatus::Error);
                assert_eq!(text, "kaboom");
            } else {
                assert_eq!(result.status, ToolResultStatus::Success, "{text}");
            }
        }
    }
}

struct Chatty(Arc<AtomicUsize>);

impl Tool for Chatty {
    fn name(&self) -> &str {
        "chatty"
    }

    fn description(&self) -> &str {
        "chatty"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new("chatty", "chatty").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let produced = self.0.clone();
        let done = ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("done")],
        );
        let events = (0..5000).map(move |index| {
            produced.fetch_add(1, Ordering::SeqCst);
            ToolStreamItem::Event(ToolStreamEvent::new(json!(index)))
        });
        ToolStream::new(futures::stream::iter(events).chain(futures::stream::once(async move {
            ToolStreamItem::Outcome(done.into())
        })))
    }
}

/// C6: a tool produces events only as fast as the agent stream is consumed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_events_wait_for_the_stream_consumer() {
    let produced = Arc::new(AtomicUsize::new(0));
    let model = MockModel::new()
        .with_turn(tool_use_turn("chatty", "c1", json!({})))
        .with_turn("done");
    let mut agent = Agent::builder()
        .model(model)
        .printer(false)
        .tools([Chatty(produced.clone())])
        .build()
        .unwrap();
    let mut stream = agent.stream("go");
    while let Some(event) = stream.next().await {
        if let AgentStreamEvent::ToolStreamUpdate(_) = event.unwrap() {
            break;
        }
    }
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
    let produced = produced.load(Ordering::SeqCst);
    assert!(produced < 10, "the tool ran ahead of the consumer: {produced} events");
}

/// C7: an error from a `BeforeToolCallEvent` hook fails the invocation once `AfterToolsEvent`
/// fired.
#[tokio::test]
async fn a_tool_call_hook_error_fails_the_invocation_after_the_batch() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("t", "id1", json!({})))
        .with_turn("done");
    let mut agent = ok_agent(model);
    agent.add_hook(|_: &mut BeforeToolCallEvent| -> Result<(), Error> { Err(Error::other("policy check failed")) });
    let mut records = Vec::new();
    let mut failure = None;
    {
        let mut stream = agent.stream("go");
        while let Some(event) = stream.next().await {
            match event {
                Ok(event) => records.push(event),
                Err(error) => failure = Some(error),
            }
        }
    }
    assert_eq!(failure.unwrap().to_string(), "policy check failed");
    let types = types(&records);
    assert_eq!(types[types.len() - 2..], ["afterToolsEvent", "afterInvocationEvent"]);
    assert!(!types.contains(&"afterToolCallEvent"));
    assert_eq!(shape(&agent), ["User:text"]);
}

/// A1: an error from a sequential hook fails the invocation with that error.
#[tokio::test]
async fn a_model_call_hook_error_fails_the_invocation() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("never"))
        .printer(false)
        .build()
        .unwrap();
    agent.add_async_hook::<BeforeModelCallEvent<'_>>(|_| {
        Box::pin(async move { Err::<(), BoxError>("quota exhausted".into()) })
    });
    let error = agent.invoke("go").await.unwrap_err();
    assert_eq!(error.to_string(), "quota exhausted");
}

/// A1: a panicking per-tool hook is not a tool result; it propagates to the caller.
#[tokio::test]
#[should_panic(expected = "tool hook boom")]
async fn a_panicking_tool_call_hook_propagates() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("t", "id1", json!({})))
        .with_turn("done");
    let mut agent = ok_agent(model);
    agent.add_hook(|_: &mut BeforeToolCallEvent| -> () { panic!("tool hook boom") });
    let _ = agent.invoke("go").await;
}

struct FailingStrategy;

#[async_trait]
impl ModelRetryStrategy for FailingStrategy {
    fn name(&self) -> &str {
        "test:failing"
    }

    async fn compute_retry_decision(&self, _context: &ModelRetryContext<'_>) -> strands::Result<RetryDecision> {
        Err(Error::other("retry backend unavailable"))
    }
}

/// A retry decision error fails the invocation with it.
#[tokio::test]
async fn a_retry_decision_error_fails_the_invocation() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn(MockTurn::throttled("slow down")))
        .printer(false)
        .retry_strategy(vec![RetryStrategy::model(FailingStrategy)])
        .build()
        .unwrap();
    let error = agent.invoke("go").await.unwrap_err();
    assert_eq!(error.to_string(), "retry backend unavailable");
}

/// A2, A3: the error and stream types stay small.
#[test]
fn errors_and_stream_events_stay_small() {
    use std::mem::size_of;
    assert_eq!(size_of::<strands::ToolError>(), size_of::<usize>());
    assert_eq!(size_of::<strands::AgentResult>(), size_of::<usize>());
    assert!(size_of::<strands::InterruptError>() <= 3 * size_of::<usize>());
    assert!(size_of::<AgentStreamEvent>() < 544, "{}", size_of::<AgentStreamEvent>());
}

struct Named(&'static str);

#[async_trait]
impl Plugin for Named {
    fn name(&self) -> &str {
        self.0
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> strands::Result<()> {
        Ok(())
    }
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[allow(dead_code, reason = "schema-only type")]
struct Answer {
    value: u32,
}

/// A11: builder and setter ergonomics.
#[tokio::test]
async fn builder_takes_plugins_by_value_or_arc_and_typed_schemas() {
    let shared: Arc<dyn Plugin> = Arc::new(Named("shared"));
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .printer(false)
        .plugins([Named("owned")])
        .plugins([shared])
        .structured_output_schema::<Answer>()
        .build()
        .unwrap();
    agent.set_model(MockModel::new().with_turn("replaced")).unwrap();
    agent
        .set_model(Arc::new(MockModel::new().with_turn("plain")) as Arc<dyn strands::Model>)
        .unwrap();
    let options = strands::InvokeOptions::builder()
        .structured_output_schema::<Answer>()
        .build();
    assert!(options.structured_output_schema.is_some());
    let prompt = String::from("hello");
    let mut plain = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(plain.invoke(&prompt).await.unwrap().to_string(), "hi");
    agent.initialize().await.unwrap();
}
