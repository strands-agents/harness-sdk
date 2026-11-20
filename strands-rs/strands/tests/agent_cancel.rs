//! Cancelling an invocation, and the cancel signal tools and middleware see through the agent.
//!
//! `agent.cancel()` is `agent.cancel_handle().cancel(..)`, `event.agent().cancel(..)` in hooks and
//! `ctx.agent().cancel(..)` in tools; an `AbortController` is a [`CancelHandle`].

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use common::{MockTool, async_tool, tool_use_turn, tool_uses_turn};
use futures::StreamExt;
use serde_json::json;
use strands::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AgentResultEvent, BeforeModelCallEvent,
    BeforeToolCallEvent,
};
use strands::models::streaming::{ModelMessageStartEvent, ModelStreamEvent};
use strands::models::{BaseModelConfig, BoxStream, Model, ModelRequest};
use strands::testing::{MockModel, test_agent};
use strands::tools::ToolExecutorStrategy;
use strands::types::ToolResultContent;
use strands::{
    Agent, AgentStreamEvent, CancelHandle, CancelOptions, CancelSignal, ContentBlock, Error, InvokeOptions, Message,
    Role, StopReason, ToolResultBlock,
};
use tokio::sync::Notify;

fn agent_with(model: MockModel, tools: Vec<strands::ToolSource>, executor: Option<ToolExecutorStrategy>) -> Agent {
    Agent::builder()
        .model(model)
        .tools(tools)
        .printer(false)
        .maybe_tool_executor(executor)
        .build()
        .unwrap()
}

fn cancel() -> CancelOptions {
    CancelOptions::default()
}

fn deferred(message: Option<&str>) -> CancelOptions {
    CancelOptions {
        message: message.map(str::to_owned),
        after_current_tools: true,
    }
}

fn success(tool_use_id: &str, text: &str) -> ToolResultBlock {
    ToolResultBlock::success(tool_use_id, vec![ToolResultContent::text(text)])
}

fn error(tool_use_id: &str, text: &str) -> ToolResultBlock {
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(text)])
}

fn tool_result(message: &Message, index: usize) -> &ToolResultBlock {
    match &message.content[index] {
        ContentBlock::ToolResult(result) => result,
        other => panic!("expected a tool result, got {other:?}"),
    }
}

fn first_text(message: &Message) -> &str {
    message.content[0].as_text().expect("text block")
}

type Executed = Arc<Mutex<Vec<String>>>;

/// A tool that records its name, runs `before` on its context and succeeds with `text`.
fn recording_tool(
    executed: &Executed,
    name: &'static str,
    text: &'static str,
    before: impl Fn(&strands::ToolContext) + Send + Sync + 'static,
) -> strands::ToolSource {
    let executed = executed.clone();
    MockTool::new(name, move |context| {
        executed.lock().unwrap().push(name.to_owned());
        before(context);
        success(&context.tool_use().tool_use_id, text).into()
    })
    .into()
}

fn cancel_on_tool_use(agent: &Agent, options: CancelOptions) {
    agent.add_hook(move |event: &mut AfterModelCallEvent<'_>| {
        if event
            .stop_data()
            .is_some_and(|data| data.stop_reason == StopReason::ToolUse)
        {
            event.agent().cancel(options.clone());
        }
    });
}

fn assert_no_orphaned_tool_uses(agent: &Agent) {
    let messages = agent.messages();
    for (index, message) in messages.iter().enumerate() {
        let uses = message
            .content
            .iter()
            .filter(|block| matches!(block, ContentBlock::ToolUse(_)))
            .count();
        if message.role != Role::Assistant || uses == 0 {
            continue;
        }
        let next = messages.get(index + 1).expect("a message after the tool uses");
        assert_eq!(next.role, Role::User);
        let results = next
            .content
            .iter()
            .filter(|block| matches!(block, ContentBlock::ToolResult(_)))
            .count();
        assert_eq!(results, uses);
    }
}

// cancel() when idle

#[test]
fn is_a_noop_and_cancel_signal_is_not_aborted() {
    let agent = test_agent(MockModel::new().with_turn("Hello"));
    assert!(!agent.cancel_signal().is_cancelled());
    agent.cancel_handle().cancel(cancel());
    assert!(!agent.cancel_signal().is_cancelled());
    assert!(!agent.cancel_handle().signal().is_cancelled());
}

// cancel at top of loop (checkpoint A)

#[tokio::test]
async fn cancels_immediately_with_already_aborted_signal() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let controller = CancelHandle::new();
    controller.cancel(cancel());

    let result = agent
        .invoke_with(
            "Hi",
            InvokeOptions {
                cancel_signal: Some(controller.signal()),
                ..InvokeOptions::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "Cancelled by user");
    assert!(agent.messages().is_empty());
}

// cancel during model streaming (checkpoint B)

#[tokio::test]
async fn cancels_when_signal_is_aborted_before_model_processes_events() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    agent.add_hook(|event: &mut BeforeModelCallEvent<'_>| event.agent().cancel(cancel()));

    let result = agent.invoke("Hi").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "Cancelled by user");
}

// cancel before tool execution (checkpoint C)

#[tokio::test]
async fn creates_error_results_for_all_pending_tools_without_executing_them() {
    let executed: Executed = Arc::default();
    let tool = recording_tool(&executed, "myTool", "Success", |_| {});
    let mut agent = agent_with(
        MockModel::new().with_turn(tool_use_turn("myTool", "tool-1", json!({}))),
        vec![tool],
        None,
    );
    cancel_on_tool_use(&agent, cancel());

    let result = agent.invoke("Do it").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert!(executed.lock().unwrap().is_empty());
    let messages = agent.messages();
    assert_eq!(messages.len(), 4);
    assert_eq!(
        tool_result(&messages[2], 0),
        &error("tool-1", "Tool execution cancelled")
    );
    assert_eq!(first_text(&messages[3]), "Cancelled by user");
    assert_eq!(result.last_message(), &messages[3]);
}

#[tokio::test]
async fn creates_error_results_for_multiple_pending_tools() {
    let executed: Executed = Arc::default();
    let tools = vec![
        recording_tool(&executed, "tool1", "R1", |_| {}),
        recording_tool(&executed, "tool2", "R2", |_| {}),
    ];
    let model = MockModel::new().with_turn(tool_uses_turn(&[("tool1", "t1"), ("tool2", "t2")]));
    let mut agent = agent_with(model, tools, None);
    cancel_on_tool_use(&agent, cancel());

    let result = agent.invoke("Do both").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    let results = &agent.messages()[2];
    assert_eq!(results.content.len(), 2);
    assert_eq!(tool_result(results, 0), &error("t1", "Tool execution cancelled"));
    assert_eq!(tool_result(results, 1), &error("t2", "Tool execution cancelled"));
}

// cancel between sequential tool executions

#[tokio::test]
async fn skips_remaining_tools_after_first_tool_calls_cancel() {
    let executed: Executed = Arc::default();
    let tools = vec![
        recording_tool(&executed, "firstTool", "Done", |context| {
            context.agent().cancel(cancel());
        }),
        recording_tool(&executed, "secondTool", "Done", |_| {}),
    ];
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("firstTool", "t1"), ("secondTool", "t2")]))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, tools, Some(ToolExecutorStrategy::Sequential));

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(*executed.lock().unwrap(), ["firstTool"]);
    let messages = agent.messages();
    assert_eq!(messages.len(), 4);
    assert_eq!(tool_result(&messages[2], 0), &success("t1", "Done"));
    assert_eq!(tool_result(&messages[2], 1), &error("t2", "Tool execution cancelled"));
    assert_eq!(first_text(&messages[3]), "Cancelled by user");
    assert_eq!(result.last_message(), &messages[3]);
}

// cancel after the tool batch

#[tokio::test]
async fn ends_the_loop_when_a_tool_calls_cancel_without_calling_the_model_again() {
    let executed: Executed = Arc::default();
    let tool = recording_tool(&executed, "cancelTool", "Done", |context| {
        context.agent().cancel(cancel());
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("cancelTool", "tool-1", json!({})))
        .with_turn("Should not reach");
    let mut agent = agent_with(model.clone(), vec![tool], None);

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(*executed.lock().unwrap(), ["cancelTool"]);
    let messages = agent.messages();
    assert_eq!(messages.len(), 4);
    assert_eq!(first_text(&messages[3]), "Cancelled by user");
    assert_eq!(result.last_message(), &messages[3]);
    assert_eq!(model.requests().len(), 1);
}

#[tokio::test]
async fn lets_sibling_tools_finish_then_stops_with_the_deferred_message() {
    let executed: Executed = Arc::default();
    let sibling_saw_abort = Arc::new(AtomicBool::new(false));
    let saw = sibling_saw_abort.clone();
    let tools = vec![
        recording_tool(&executed, "stopTool", "stopping", |context| {
            context.agent().cancel(deferred(Some("Task complete")));
        }),
        recording_tool(&executed, "siblingTool", "sibling ran", move |context| {
            saw.store(context.cancel_signal().is_cancelled(), Ordering::SeqCst);
        }),
    ];
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("stopTool", "t1"), ("siblingTool", "t2")]))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, tools, Some(ToolExecutorStrategy::Sequential));

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(*executed.lock().unwrap(), ["stopTool", "siblingTool"]);
    assert!(!sibling_saw_abort.load(Ordering::SeqCst));
    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "Task complete");
    let messages = agent.messages();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[3].role, Role::Assistant);
    assert_eq!(first_text(&messages[3]), "Task complete");
    assert_eq!(tool_result(&messages[2], 1), &success("t2", "sibling ran"));
}

#[tokio::test]
async fn falls_back_to_a_default_assistant_message_when_the_deferred_cancel_carries_none() {
    let executed: Executed = Arc::default();
    let tool = recording_tool(&executed, "quietStop", "ok", |context| {
        context.agent().cancel(deferred(None));
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("quietStop", "t1", json!({})))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, vec![tool], None);

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    let messages = agent.messages();
    assert_eq!(messages.len(), 4);
    assert_eq!(first_text(&messages[3]), "Cancelled by user");
    assert_eq!(result.last_message(), &messages[3]);
}

#[tokio::test]
async fn keeps_the_last_message_written_when_two_tools_defer_in_the_same_batch() {
    let executed: Executed = Arc::default();
    let tools = vec![
        recording_tool(&executed, "firstStop", "ok", |context| {
            context.agent().cancel(deferred(Some("first")));
        }),
        recording_tool(&executed, "secondStop", "ok", |context| {
            context.agent().cancel(deferred(Some("second")));
        }),
    ];
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("firstStop", "t1"), ("secondStop", "t2")]))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, tools, Some(ToolExecutorStrategy::Sequential));

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "second");
}

#[tokio::test]
async fn keeps_a_stored_message_when_a_later_cancel_carries_none() {
    let executed: Executed = Arc::default();
    let tools = vec![
        recording_tool(&executed, "stopTool", "ok", |context| {
            context.agent().cancel(deferred(Some("summary")));
        }),
        recording_tool(&executed, "abortTool", "ok", |context| context.agent().cancel(cancel())),
    ];
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("stopTool", "t1"), ("abortTool", "t2")]))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, tools, Some(ToolExecutorStrategy::Sequential));

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "summary");
}

#[tokio::test]
async fn wins_over_a_structured_output_stop_in_the_same_batch_and_still_carries_the_output() {
    let executed: Executed = Arc::default();
    let tool = recording_tool(&executed, "stopTool", "ok", |context| {
        context.agent().cancel(deferred(Some("summary")));
    });
    let model = MockModel::new()
        .with_turn(strands::testing::MockTurn::content([
            ContentBlock::from(strands::ToolUseBlock::new("stopTool", "t1", json!({}))),
            ContentBlock::from(strands::ToolUseBlock::new(
                "strands_structured_output",
                "t2",
                json!({"value": 42}),
            )),
        ]))
        .with_turn("Should not reach");
    let mut agent = Agent::builder()
        .model(model)
        .tools([tool])
        .structured_output_schema_json(json!({
            "type": "object",
            "properties": {"value": {"type": "number"}},
            "required": ["value"]
        }))
        .printer(false)
        .build()
        .unwrap();

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(result.structured_output_value(), Some(&json!({"value": 42})));
    assert_eq!(first_text(result.last_message()), "summary");
}

#[tokio::test]
async fn leaves_cancel_signal_readable_on_agent_result_event_and_resets_it_after_the_stream() {
    let executed: Executed = Arc::default();
    let tool = recording_tool(&executed, "abortTool", "ok", |context| context.agent().cancel(cancel()));
    let model = MockModel::new()
        .with_turn(tool_use_turn("abortTool", "t1", json!({})))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, vec![tool], None);
    let aborted_on_result: Arc<Mutex<Option<bool>>> = Arc::default();
    let seen = aborted_on_result.clone();
    agent.add_hook(move |event: &mut AgentResultEvent<'_>| {
        *seen.lock().unwrap() = Some(event.agent().cancel_signal().is_cancelled());
    });

    let mut stream = agent.stream("Go");
    let mut saw_result = false;
    while let Some(event) = stream.next().await {
        saw_result |= matches!(event.unwrap(), AgentStreamEvent::AgentResult(_));
    }
    drop(stream);

    assert!(saw_result);
    assert_eq!(*aborted_on_result.lock().unwrap(), Some(true));
    assert!(!agent.cancel_signal().is_cancelled());
}

#[tokio::test]
async fn is_a_noop_when_the_turn_has_no_tool_use_to_defer_behind() {
    let mut agent = test_agent(MockModel::new().with_turn("Plain answer").with_turn("Next answer"));
    let model_calls = AtomicUsize::new(0);
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        if model_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            event.agent().cancel(deferred(Some("dropped")));
        }
    });

    let first = agent.invoke("Go").await.unwrap();
    assert_eq!(first.stop_reason(), StopReason::EndTurn);
    assert_eq!(first_text(first.last_message()), "Plain answer");

    let second = agent.invoke("Again").await.unwrap();
    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert_eq!(first_text(second.last_message()), "Next answer");
}

#[tokio::test]
async fn does_not_leak_a_deferred_cancel_into_the_next_invocation() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let tool = MockTool::new("maybeStop", move |context| {
        if counter.fetch_add(1, Ordering::SeqCst) == 0 {
            context.agent().cancel(deferred(Some("done for now")));
        }
        success(&context.tool_use().tool_use_id, "ok").into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("maybeStop", "t1", json!({})))
        .with_turn(tool_use_turn("maybeStop", "t1", json!({})))
        .with_turn("All done");
    let mut agent = agent_with(model, vec![tool.into()], None);

    let first = agent.invoke("Go").await.unwrap();
    assert_eq!(first.stop_reason(), StopReason::Cancelled);

    let second = agent.invoke("Go again").await.unwrap();
    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert_eq!(first_text(second.last_message()), "All done");
    assert!(!agent.cancel_signal().is_cancelled());
}

#[tokio::test]
async fn is_a_noop_when_the_agent_is_idle() {
    let mut agent = test_agent(MockModel::new().with_turn("First").with_turn("Second"));
    agent.cancel_handle().cancel(deferred(Some("ignored")));

    let result = agent.invoke("Hi").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(first_text(result.last_message()), "First");
}

// cancel with a message

#[tokio::test]
async fn uses_the_message_as_the_final_message_when_cancelled_during_streaming() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    agent.add_hook(|event: &mut BeforeModelCallEvent<'_>| {
        event
            .agent()
            .cancel(CancelOptions::builder().message("Stopped by the operator").build());
    });

    let result = agent.invoke("Hi").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "Stopped by the operator");
    assert_eq!(first_text(agent.messages().last().unwrap()), "Stopped by the operator");
}

#[tokio::test]
async fn appends_the_message_when_cancelled_before_tool_execution() {
    let tool = MockTool::text("myTool", "never runs");
    let model = MockModel::new().with_turn(tool_use_turn("myTool", "tool-1", json!({})));
    let mut agent = agent_with(model, vec![tool.into()], None);
    cancel_on_tool_use(&agent, CancelOptions::builder().message("Aborting the batch").build());

    let result = agent.invoke("Do it").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "Aborting the batch");
    assert_eq!(agent.messages().len(), 4);
    assert_eq!(&agent.messages()[3], result.last_message());
}

// InvokeOptions.cancelSignal

#[tokio::test]
async fn cancels_via_external_abort_signal() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let controller = CancelHandle::new();
    let hook_controller = controller.clone();
    agent.add_hook(move |_: &mut BeforeModelCallEvent<'_>| hook_controller.cancel(CancelOptions::default()));

    let result = agent
        .invoke_with(
            "Hi",
            InvokeOptions {
                cancel_signal: Some(controller.signal()),
                ..InvokeOptions::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::Cancelled);
}

#[tokio::test]
async fn skips_the_tool_when_cancel_arrives_during_before_tool_call_event() {
    for executor in [ToolExecutorStrategy::Sequential, ToolExecutorStrategy::Concurrent] {
        for external in [false, true] {
            let executed = Executed::default();
            let model =
                MockModel::from_turns([tool_use_turn("firstTool", "t1", json!({}))]).with_turn("Should not reach");
            let mut agent = agent_with(
                model,
                vec![recording_tool(&executed, "firstTool", "Done", |_| {})],
                Some(executor),
            );
            let controller = CancelHandle::new();
            let hook_controller = controller.clone();
            agent.add_hook(move |event: &mut BeforeToolCallEvent| {
                if external {
                    hook_controller.cancel(CancelOptions::default());
                } else {
                    event.agent().cancel(CancelOptions::default());
                }
            });

            let options = InvokeOptions {
                cancel_signal: Some(controller.signal()),
                ..InvokeOptions::default()
            };
            let result = agent.invoke_with("Go", options).await.unwrap();

            assert_eq!(result.stop_reason(), StopReason::Cancelled, "{executor:?} {external}");
            assert!(executed.lock().unwrap().is_empty());
            assert_eq!(
                agent.messages()[2].content,
                vec![ContentBlock::ToolResult(error("t1", "Tool execution cancelled"))]
            );
        }
    }
}

#[tokio::test]
async fn keeps_the_hook_cancel_message_when_the_signal_is_also_aborted() {
    let executed = Executed::default();
    let model = MockModel::from_turns([tool_use_turn("marker", "marker-1", json!({}))]).with_turn("Done");
    let mut agent = agent_with(
        model,
        vec![recording_tool(&executed, "marker", "wrote", |_| {})],
        Some(ToolExecutorStrategy::Sequential),
    );
    let controller = CancelHandle::new();
    let hook_controller = controller.clone();
    agent.add_hook(move |event: &mut BeforeToolCallEvent| {
        event.set_cancel("hook cancel message");
        hook_controller.cancel(CancelOptions::default());
    });

    let options = InvokeOptions {
        cancel_signal: Some(controller.signal()),
        ..InvokeOptions::default()
    };
    agent.invoke_with("Go", options).await.unwrap();

    assert!(executed.lock().unwrap().is_empty());
    assert_eq!(
        agent.messages()[2].content,
        vec![ContentBlock::ToolResult(error("marker-1", "hook cancel message"))]
    );
}

/// A model that starts a message, then waits on the request's cancel signal and fails the way a
/// transport does when it is aborted.
struct HangingModel {
    config: RwLock<BaseModelConfig>,
    signal: Arc<Mutex<Option<CancelSignal>>>,
    pending: Arc<Notify>,
}

#[strands::async_trait]
impl Model for HangingModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, strands::Result<ModelStreamEvent>> {
        let signal = request.cancel_signal;
        *self.signal.lock().unwrap() = signal.clone();
        let pending = self.pending.clone();
        Box::pin(async_stream::stream! {
            yield Ok(ModelStreamEvent::from(ModelMessageStartEvent::new(Role::Assistant)));
            pending.notify_one();
            if let Some(signal) = signal {
                signal.cancelled().await;
            }
            yield Err(Error::other("transport aborted"));
        })
    }

    fn get_config(&self) -> BaseModelConfig {
        self.config.read().unwrap().clone()
    }

    fn update_config(&self, config: BaseModelConfig) -> strands::Result<()> {
        self.config.write().unwrap().merge(config);
        Ok(())
    }
}

#[tokio::test]
async fn aborts_the_in_flight_model_stream_and_returns_cancelled() {
    let signal: Arc<Mutex<Option<CancelSignal>>> = Arc::default();
    let pending = Arc::new(Notify::new());
    let model = HangingModel {
        config: RwLock::default(),
        signal: signal.clone(),
        pending: pending.clone(),
    };
    let mut agent = Agent::builder().model(model).printer(false).build().unwrap();
    let controller = CancelHandle::new();
    let options = InvokeOptions {
        cancel_signal: Some(controller.signal()),
        ..InvokeOptions::default()
    };

    let invocation = agent.invoke_with("Hi", options);
    let driver = async {
        pending.notified().await;
        let model_signal = signal
            .lock()
            .unwrap()
            .clone()
            .expect("the request carries a cancel signal");
        assert!(!model_signal.is_cancelled());
        controller.cancel(CancelOptions::default());
        model_signal
    };
    let (result, model_signal) = tokio::join!(invocation, driver);

    assert_eq!(result.unwrap().stop_reason(), StopReason::Cancelled);
    assert!(model_signal.is_cancelled());
}

// agent reuse after cancel

#[tokio::test]
async fn allows_a_second_invocation_after_cancellation() {
    let mut agent = test_agent(MockModel::new().with_turn("First").with_turn("Second"));
    let calls = AtomicUsize::new(0);
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            event.agent().cancel(CancelOptions::default());
        }
    });

    let first = agent.invoke("Hello").await.unwrap();
    assert_eq!(first.stop_reason(), StopReason::Cancelled);

    let second = agent.invoke("Hello again").await.unwrap();
    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert_eq!(first_text(second.last_message()), "Second");
}

// cancel via stream break (for-await + break)

async fn cancel_and_drop_at_first_stream_update(agent: &mut Agent, prompt: &str) {
    let handle = agent.cancel_handle();
    let mut stream = agent.stream(prompt);
    while let Some(event) = stream.next().await {
        if matches!(event.unwrap(), AgentStreamEvent::ModelStreamUpdate(_)) {
            handle.cancel(CancelOptions::default());
            break;
        }
    }
}

#[tokio::test]
async fn appends_assistant_message_when_stream_is_broken_out_of_after_cancel() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story..."));

    cancel_and_drop_at_first_stream_update(&mut agent, "Write a story").await;

    let last = agent.messages().last().unwrap();
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(first_text(last), "Cancelled by user");
}

#[tokio::test]
async fn allows_reuse_after_cancellation_via_stream_break() {
    let mut agent = test_agent(MockModel::new().with_turn("A long story...").with_turn("pineapple"));

    cancel_and_drop_at_first_stream_update(&mut agent, "Write a story").await;

    let result = agent.invoke("Say the word \"pineapple\"").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(first_text(result.last_message()), "pineapple");
}

// AfterInvocationEvent

#[tokio::test]
async fn still_fires_when_invocation_is_cancelled() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let fired = Arc::new(AtomicBool::new(false));
    let flag = fired.clone();
    agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| flag.store(true, Ordering::SeqCst));
    agent.add_hook(|event: &mut BeforeModelCallEvent<'_>| event.agent().cancel(CancelOptions::default()));

    agent.invoke("Hi").await.unwrap();

    assert!(fired.load(Ordering::SeqCst));
}

// messages state invariants

#[tokio::test]
async fn has_no_orphaned_tool_use_blocks_after_cancel_during_streaming() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    agent.add_hook(|event: &mut BeforeModelCallEvent<'_>| event.agent().cancel(CancelOptions::default()));

    agent.invoke("Hi").await.unwrap();

    assert_no_orphaned_tool_uses(&agent);
}

#[tokio::test]
async fn has_no_orphaned_tool_use_blocks_after_cancel_before_tools() {
    let tool = MockTool::text("myTool", "Done");
    let model = MockModel::new().with_turn(tool_use_turn("myTool", "tool-1", json!({})));
    let mut agent = agent_with(model, vec![tool.into()], None);
    cancel_on_tool_use(&agent, CancelOptions::default());

    agent.invoke("Do it").await.unwrap();

    assert_no_orphaned_tool_uses(&agent);
}

// tool-level cancellation cooperation

/// The tool context's signal and the agent view's signal, before and after a cancel.
type SignalStates = (bool, bool, bool, bool);

#[tokio::test]
async fn passes_agent_cancel_signal_to_foreground_tools() {
    let seen: Arc<Mutex<Option<SignalStates>>> = Arc::default();
    let record = seen.clone();
    let signal_tool = async_tool("signalTool", move |_input, context| {
        let record = record.clone();
        async move {
            let (signal, agent_signal) = (context.cancel_signal().clone(), context.agent().cancel_signal());
            let before = (signal.is_cancelled(), agent_signal.is_cancelled());
            context.agent().cancel(CancelOptions::default());
            *record.lock().unwrap() = Some((before.0, before.1, signal.is_cancelled(), agent_signal.is_cancelled()));
            Ok(json!("done"))
        }
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("signalTool", "t1", json!({})))
        .with_turn("Done");
    let mut agent = agent_with(model, vec![signal_tool.into()], None);

    agent.invoke("Go").await.unwrap();

    // Both start unaborted and observe the same cancellation: they are the same signal.
    assert_eq!(*seen.lock().unwrap(), Some((false, false, true, true)));
}

#[tokio::test]
async fn signal_is_aborted_when_tool_checks_it_after_cancel() {
    let aborted: Arc<Mutex<Option<bool>>> = Arc::default();
    let record = aborted.clone();
    let check_tool = async_tool("checkTool", move |_input, context| {
        let record = record.clone();
        async move {
            context.agent().cancel(CancelOptions::default());
            *record.lock().unwrap() = Some(context.cancel_signal().is_cancelled());
            Ok(json!("done"))
        }
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("checkTool", "t1", json!({})))
        .with_turn("Should not reach");
    let mut agent = agent_with(model, vec![check_tool.into()], None);

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(*aborted.lock().unwrap(), Some(true));
    assert_eq!(result.stop_reason(), StopReason::Cancelled);
}

// The tool executor's cancel signal, through the agent: the invocation's signal is the execution
// signal.

#[tokio::test]
async fn keeps_middleware_and_tools_on_the_supplied_execution_signal() {
    let tool_saw: Arc<Mutex<Option<CancelSignal>>> = Arc::default();
    let record = tool_saw.clone();
    let probe = MockTool::new("probe", move |context| {
        *record.lock().unwrap() = Some(context.cancel_signal().clone());
        success(&context.tool_use().tool_use_id, "ok").into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("probe", "probe-1", json!({})))
        .with_turn("Done");
    let mut agent = agent_with(model, vec![probe.into()], None);
    let execution = CancelHandle::new();

    let result = agent
        .invoke_with(
            "Go",
            InvokeOptions {
                cancel_signal: Some(execution.signal()),
                ..InvokeOptions::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    let tool_signal = tool_saw.lock().unwrap().clone().unwrap();
    assert!(!tool_signal.is_cancelled());
    execution.cancel(CancelOptions::default());
    assert!(tool_signal.is_cancelled(), "the tool sees the supplied signal");
    assert!(!agent.cancel_signal().is_cancelled());
}

#[tokio::test]
async fn uses_the_supplied_signal_between_sequential_tool_executions() {
    let executed: Executed = Arc::default();
    let execution = CancelHandle::new();
    let abort = execution.clone();
    let tools = vec![
        recording_tool(&executed, "first", "done", move |_| {
            abort.cancel(CancelOptions::default());
        }),
        recording_tool(&executed, "second", "unexpected", |_| {}),
    ];
    let model = MockModel::new().with_turn(tool_uses_turn(&[("first", "first-1"), ("second", "second-1")]));
    let mut agent = agent_with(model, tools, Some(ToolExecutorStrategy::Sequential));

    agent
        .invoke_with(
            "Go",
            InvokeOptions {
                cancel_signal: Some(execution.signal()),
                ..InvokeOptions::default()
            },
        )
        .await
        .unwrap();

    assert!(!agent.cancel_signal().is_cancelled());
    assert_eq!(*executed.lock().unwrap(), ["first"]);
    let results = &agent.messages()[2];
    assert_eq!(tool_result(results, 0), &success("first-1", "done"));
    assert_eq!(tool_result(results, 1), &error("second-1", "Tool execution cancelled"));
}

#[tokio::test]
async fn does_not_retry_after_the_supplied_signal_is_aborted() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let tool = MockTool::new("retryable", move |context| {
        counter.fetch_add(1, Ordering::SeqCst);
        success(&context.tool_use().tool_use_id, "done").into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("retryable", "retry-1", json!({})))
        .with_turn("Done");
    let mut agent = agent_with(model, vec![tool.into()], None);
    let execution = CancelHandle::new();
    let abort = execution.clone();
    let after_calls = Arc::new(AtomicUsize::new(0));
    let after_counter = after_calls.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        if after_counter.fetch_add(1, Ordering::SeqCst) == 0 {
            abort.cancel(CancelOptions::default());
            event.set_retry(true);
        }
    });

    agent
        .invoke_with(
            "Go",
            InvokeOptions {
                cancel_signal: Some(execution.signal()),
                ..InvokeOptions::default()
            },
        )
        .await
        .unwrap();

    assert!(!agent.cancel_signal().is_cancelled());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(after_calls.load(Ordering::SeqCst), 1);
}

// Rust: the external signal's message and deferral count like the agent's own.

#[tokio::test]
async fn honours_the_message_and_deferral_of_an_external_cancel_signal() {
    let executed: Executed = Arc::default();
    let external = CancelHandle::new();
    let stop = external.clone();
    let tools = vec![
        recording_tool(&executed, "stopTool", "ok", move |_| {
            stop.cancel(deferred(Some("Stopped outside")));
        }),
        recording_tool(&executed, "siblingTool", "ok", |_| {}),
    ];
    let model = MockModel::new()
        .with_turn(tool_uses_turn(&[("stopTool", "t1"), ("siblingTool", "t2")]))
        .with_turn("Should not reach");
    let mut agent = agent_with(model.clone(), tools, Some(ToolExecutorStrategy::Sequential));

    let result = agent
        .invoke_with(
            "Go",
            InvokeOptions {
                cancel_signal: Some(external.signal()),
                ..InvokeOptions::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(*executed.lock().unwrap(), ["stopTool", "siblingTool"]);
    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(first_text(result.last_message()), "Stopped outside");
    assert_eq!(model.requests().len(), 1);
}
