use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use serde_json::json;

use super::ContinuationInput;
use crate::agent::InvokeArgs;
use crate::hooks::{
    AfterInvocationEvent, AgentStreamEvent, BeforeInvocationEvent, BeforeModelCallEvent, MessageAddedEvent,
};
use crate::test_support::MockTool;
use crate::testing::{MockModel, MockTurn, test_agent};
use crate::tools::ToolOutcome;
use crate::types::{
    ContentBlock, InterruptParams, InterruptResponse, JsonValue, Message, MessageMetadata, Role, StopReason,
    ToolResultBlock, ToolResultContent, ToolUseBlock,
};

fn text_of(message: &Message) -> String {
    message.text()
}

fn text_model(turns: &[&str]) -> MockModel {
    MockModel::from_turns(turns.iter().copied())
}

fn request_messages(model: &MockModel, index: usize) -> Vec<Message> {
    model.requests()[index].messages.clone()
}

fn shape(message: &Message) -> JsonValue {
    json!({"role": message.role, "content": message.content})
}

type Calls = Arc<Mutex<Vec<String>>>;

fn calls() -> Calls {
    Arc::default()
}

fn push(calls: &Calls, value: impl Into<String>) {
    calls.lock().unwrap().push(value.into());
}

fn taken(calls: &Calls) -> Vec<String> {
    calls.lock().unwrap().clone()
}

fn record_before_invocation(agent: &crate::Agent) -> Arc<Mutex<Vec<Vec<String>>>> {
    let inputs: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let recorded = inputs.clone();
    agent.add_hook(move |event: &mut BeforeInvocationEvent<'_>| {
        recorded
            .lock()
            .unwrap()
            .push(event.messages().iter().map(text_of).collect());
    });
    inputs
}

#[tokio::test]
async fn combines_multiple_follow_up_contributions_with_public_resume_input() {
    let model = text_model(&["initial", "final"]);
    let mut agent = test_agent(model.clone());
    let appended = calls();
    let abandoned = calls();
    let before_inputs = record_before_invocation(&agent);
    let resumed = AtomicBool::new(false);
    let (appended_hook, abandoned_hook) = (appended.clone(), abandoned.clone());
    agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
        if resumed.swap(true, Ordering::SeqCst) {
            return;
        }
        for args in ["first", "second"] {
            let appended = appended_hook.clone();
            event.add_continuation_input(ContinuationInput::new(args).on_appended(move || push(&appended, args)));
        }
        let abandoned = abandoned_hook.clone();
        event.add_continuation_input(
            ContinuationInput::new(Message::assistant("invalid"))
                .on_abandoned(move |reason| push(&abandoned, reason.to_string())),
        );
        event.set_resume("public");
    });

    agent.invoke("start").await.unwrap();

    let second = request_messages(&model, 1);
    assert_eq!(
        second.iter().map(|message| message.role).collect::<Vec<_>>(),
        [Role::User, Role::Assistant, Role::User]
    );
    assert_eq!(text_of(second.last().unwrap()), "firstsecondpublic");
    assert_eq!(
        agent.messages().iter().map(text_of).collect::<Vec<_>>(),
        ["start", "initial", "firstsecondpublic", "final"]
    );
    assert_eq!(*before_inputs.lock().unwrap(), [vec!["start"], vec!["public"]]);
    assert_eq!(taken(&appended), ["first", "second"]);
    assert_eq!(
        taken(&abandoned),
        ["Continuation input must contain a complete message sequence"]
    );
}

#[tokio::test]
async fn keeps_prepared_continuation_messages_outside_hook_mutations() {
    let model = text_model(&["initial", "final"]);
    let mut agent = test_agent(model.clone());
    let appended = Arc::new(AtomicUsize::new(0));
    let before_inputs: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let recorded = before_inputs.clone();
    agent.add_hook(move |event: &mut BeforeInvocationEvent<'_>| {
        let mut inputs = recorded.lock().unwrap();
        inputs.push(event.messages().iter().map(text_of).collect());
        if inputs.len() == 2 {
            event.set_messages(Vec::new());
        }
    });
    let continuation_messages = vec![
        Message::new(
            Role::Assistant,
            vec![ToolUseBlock::new("backgroundTask", "task-1", json!({})).into()],
        ),
        Message::new(
            Role::User,
            vec![ContentBlock::ToolResult(ToolResultBlock::success(
                "task-1",
                vec![ToolResultContent::text("done")],
            ))],
        ),
    ];
    let resumed = AtomicBool::new(false);
    let counter = appended.clone();
    agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
        if resumed.swap(true, Ordering::SeqCst) {
            return;
        }
        let counter = counter.clone();
        event.add_continuation_input(
            ContinuationInput::new(continuation_messages.clone()).on_appended(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        );
        event.set_resume("public");
    });

    agent.invoke("start").await.unwrap();

    assert_eq!(*before_inputs.lock().unwrap(), [vec!["start"], vec!["public"]]);
    let second = request_messages(&model, 1);
    assert_eq!(
        second.iter().map(shape).collect::<Vec<_>>(),
        [
            json!({"role": "user", "content": [{"text": "start"}]}),
            json!({"role": "assistant", "content": [
                {"text": "initial"},
                {"toolUse": {"name": "backgroundTask", "toolUseId": "task-1", "input": {}}}
            ]}),
            json!({"role": "user", "content": [
                {"toolResult": {"toolUseId": "task-1", "status": "success", "content": [{"text": "done"}]}}
            ]}),
        ]
    );
    assert!(!second.iter().any(|message| text_of(message) == "public"));
    assert_eq!(appended.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retains_follow_up_input_through_failed_resume_attempts() {
    let model = MockModel::new()
        .with_turn(MockTurn::content([ContentBlock::from(ToolUseBlock::new(
            "confirmTool",
            "tool-1",
            json!({}),
        ))]))
        .with_turn("resumed")
        .with_turn("continued");
    let mut agent = test_agent(model.clone());
    agent
        .tool_registry_mut()
        .add(MockTool::new("confirmTool").with_result(|context| {
            match context.interrupt(InterruptParams::new("confirm").with_reason("Confirm?")) {
                Ok(response) => ToolResultBlock::success(
                    context.tool_use().tool_use_id.clone(),
                    vec![ToolResultContent::text(format!("confirmed:{response}"))],
                )
                .into(),
                Err(interrupt) => ToolOutcome::Interrupt(interrupt),
            }
        }))
        .unwrap();
    let appended = Arc::new(AtomicUsize::new(0));
    let abandoned = Arc::new(AtomicUsize::new(0));
    let added = AtomicBool::new(false);
    let (appended_hook, abandoned_hook) = (appended.clone(), abandoned.clone());
    agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
        if added.swap(true, Ordering::SeqCst) {
            return;
        }
        let (appended, abandoned) = (appended_hook.clone(), abandoned_hook.clone());
        event.add_continuation_input(
            ContinuationInput::new("pending")
                .on_appended(move || {
                    appended.fetch_add(1, Ordering::SeqCst);
                })
                .on_abandoned(move |_| {
                    abandoned.fetch_add(1, Ordering::SeqCst);
                }),
        );
    });

    let interrupted = agent.invoke("start").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
    assert_eq!(appended.load(Ordering::SeqCst), 0);
    assert_eq!(abandoned.load(Ordering::SeqCst), 0);

    let error = agent.invoke("invalid resume").await.unwrap_err();
    assert!(error.to_string().contains("Agent is in an interrupted state"));
    assert_eq!(appended.load(Ordering::SeqCst), 0);
    assert_eq!(abandoned.load(Ordering::SeqCst), 0);

    let id = interrupted.interrupts()[0].id.clone();
    let result = agent
        .invoke(vec![InterruptResponse::new(id, json!("yes"))])
        .await
        .unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(text_of(request_messages(&model, 2).last().unwrap()), "pending");
    assert_eq!(appended.load(Ordering::SeqCst), 1);
    assert_eq!(abandoned.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn preserves_an_unrecognized_stop_reason_instead_of_continuing() {
    let stop_reason = StopReason::from("providerSpecificStop");
    let model = MockModel::new()
        .with_turn(MockTurn::text("partial").with_stop_reason(stop_reason.clone()))
        .with_turn("unreachable");
    let mut agent = test_agent(model.clone());
    let abandoned = Arc::new(AtomicUsize::new(0));
    let added = AtomicBool::new(false);
    let counter = abandoned.clone();
    agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
        if added.swap(true, Ordering::SeqCst) {
            return;
        }
        let counter = counter.clone();
        event.add_continuation_input(ContinuationInput::new("pending").on_abandoned(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
    });

    let result = agent.invoke("start").await.unwrap();

    assert_eq!(result.stop_reason(), stop_reason);
    assert_eq!(model.call_count(), 1);
    assert_eq!(
        agent.messages().iter().map(text_of).collect::<Vec<_>>(),
        ["start", "partial"]
    );
    assert_eq!(abandoned.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn appends_a_complete_tool_exchange_contributed_before_the_model_call() {
    let model = text_model(&["final"]);
    let mut agent = test_agent(model.clone());
    let mut custom = crate::types::JsonObject::new();
    custom.insert("pinned".into(), json!(true));
    let metadata = MessageMetadata::new().with_custom(custom);
    let initial_input = Message::user("start")
        .with_tracking_id("durable-1")
        .with_metadata(metadata.clone());
    let tool_use = Message::new(
        Role::Assistant,
        vec![ToolUseBlock::new("background-result", "delivery-1", json!({})).into()],
    );
    let tool_result = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "delivery-1",
            vec![ToolResultContent::text("complete")],
        ))],
    );
    let appended = Arc::new(AtomicUsize::new(0));
    let added_messages: Arc<Mutex<Vec<Message>>> = Arc::default();
    let recorded = added_messages.clone();
    agent.add_hook(move |event: &mut MessageAddedEvent<'_>| {
        recorded.lock().unwrap().push(event.message().clone());
    });
    let exchange = vec![tool_use.clone(), tool_result.clone()];
    let counter = appended.clone();
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        event.add_continuation_input(ContinuationInput::new("guidance"));
        let counter = counter.clone();
        event.add_continuation_input(ContinuationInput::new(exchange.clone()).on_appended(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
    });

    agent.invoke(vec![initial_input]).await.unwrap();

    let first = request_messages(&model, 0);
    assert_eq!(
        first.iter().map(|message| message.role).collect::<Vec<_>>(),
        [Role::User, Role::Assistant, Role::User]
    );
    assert_eq!(text_of(&first[0]), "startguidance");
    let messages = agent.messages();
    assert_eq!(messages.len(), 4);
    assert_eq!(
        messages[0],
        Message::new(
            Role::User,
            vec![ContentBlock::text("start"), ContentBlock::text("guidance")]
        )
        .with_tracking_id("durable-1")
        .with_metadata(metadata)
    );
    assert_eq!(messages[1], tool_use);
    assert_eq!(messages[2], tool_result);
    assert!(added_messages.lock().unwrap().contains(&messages[0]));
    assert_eq!(appended.load(Ordering::SeqCst), 1);
}

/// Dropping the stream defers the `AfterInvocationEvent` hooks to the next call (or
/// `shutdown`); the input those hooks add is then abandoned. The drop guard closes the open
/// user turn with the cancel message.
#[tokio::test]
async fn abandons_follow_up_input_when_the_stream_closes_before_it_is_appended() {
    let mut agent = test_agent(text_model(&["initial", "unreachable"]));
    let abandoned: Arc<Mutex<Vec<String>>> = Arc::default();
    let added = AtomicBool::new(false);
    let recorded = abandoned.clone();
    agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
        if added.swap(true, Ordering::SeqCst) {
            return;
        }
        let recorded = recorded.clone();
        event.add_continuation_input(
            ContinuationInput::new(InvokeArgs::from("pending"))
                .on_abandoned(move |reason| recorded.lock().unwrap().push(reason.to_string())),
        );
    });

    {
        let mut stream = agent.stream("start");
        while let Some(event) = stream.next().await {
            if matches!(event.unwrap(), AgentStreamEvent::MessageAdded(_)) {
                break;
            }
        }
    }
    agent.shutdown().await.unwrap();

    assert_eq!(
        *abandoned.lock().unwrap(),
        ["Agent stream closed before continuation input was incorporated into agent history"]
    );
    assert_eq!(
        agent.messages().iter().map(text_of).collect::<Vec<_>>(),
        ["start", "Cancelled by user"]
    );
}
