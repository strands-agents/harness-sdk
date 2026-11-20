//! `AgentToolStreamer` cases, run with real child agents on a [`MockModel`].

use futures::channel::mpsc;
use serde_json::json;

use super::*;
use crate::test_support::MockTool;
use crate::testing::{MockModel, MockTurn};
use crate::types::{ContentBlock, InterruptParams, ToolUseBlock};

const NAMESPACE: &str = "test";
const TOOL_USE_ID: &str = "t";

fn streamer(state: &InterruptState) -> AgentToolStreamer {
    AgentToolStreamer::new(state.clone(), TOOL_USE_ID, NAMESPACE, true, "Child".to_owned())
}

fn child(model: MockModel) -> Agent {
    Agent::builder().model(model).printer(false).build().unwrap()
}

/// A child whose only tool asks for confirmation.
fn confirming_child() -> Agent {
    let confirm =
        MockTool::new("confirmTool").with_result(|context| match context.interrupt(InterruptParams::new("confirm")) {
            Ok(_) => ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into(),
            Err(interrupt) => interrupt.into(),
        });
    let model = MockModel::new().with_turn(MockTurn::content([ContentBlock::from(ToolUseBlock::new(
        "confirmTool",
        "inner-1",
        json!({}),
    ))]));
    Agent::builder()
        .model(model)
        .tools([confirm])
        .printer(false)
        .build()
        .unwrap()
}

async fn run(tool: &mut AgentToolStreamer, child: &mut Agent) -> Vec<ToolStreamEvent> {
    let (mut sender, receiver) = mpsc::channel(64);
    tool.stream(child, "go".into(), InvokeOptions::default(), "child", &mut sender)
        .await
        .unwrap();
    drop(sender);
    receiver.collect().await
}

fn turns(state: &InterruptState) -> JsonValue {
    state.context_value(INTERRUPTED_TURNS_KEY).unwrap_or_else(|| json!({}))
}

/// A serialized agent interrupt state awaiting `approval`.
fn awaited_agent_state() -> JsonValue {
    let state = InterruptState::new();
    state.register_interrupt(&Interrupt::new("approval", "confirm"));
    state.activate();
    serde_json::to_value(state.to_data()).unwrap()
}

/// A parent resuming with an answer to `test:t:approval`, holding `turn` as the stored child turn.
fn resuming_parent(turn: Option<JsonValue>) -> InterruptState {
    let state = InterruptState::new();
    state.register_interrupt(&Interrupt::new("test:t:approval", "confirm"));
    let turns = match turn {
        Some(turn) => json!({TOOL_USE_ID: turn}),
        None => json!({}),
    };
    state.set_context_value(INTERRUPTED_TURNS_KEY, Some(turns));
    state.activate();
    let response = InterruptResponseContent::new(InterruptResponse::new("test:t:approval", json!("approved")));
    state.resume(&[response]).unwrap();
    state
}

#[tokio::test]
async fn yields_progress_events_and_retains_the_terminal_result() {
    let state = InterruptState::new();
    let mut tool = streamer(&state);

    let events = run(&mut tool, &mut child(MockModel::new().with_turn("done"))).await;

    assert!(!events.is_empty());
    let result = tool.result.as_ref().unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.to_string(), "done");
}

#[tokio::test]
async fn stores_the_child_turn_and_namespaces_its_interrupts() {
    let state = InterruptState::new();
    let mut tool = streamer(&state);

    run(&mut tool, &mut confirming_child()).await;

    assert_eq!(
        serde_json::to_value(tool.interrupts.as_ref().unwrap()).unwrap(),
        json!([{"id": "test:t:tool:inner-1:confirm", "name": "confirm", "source": "tool"}])
    );
    let turns = turns(&state);
    assert_eq!(turns.as_object().unwrap().keys().collect::<Vec<_>>(), [TOOL_USE_ID]);
}

#[tokio::test]
async fn clears_the_completed_child_turn_and_preserves_siblings() {
    let state = InterruptState::new();
    state.set_context_value(
        INTERRUPTED_TURNS_KEY,
        Some(json!({TOOL_USE_ID: {"snapshot": "child"}, "t2": {}})),
    );

    run(&mut streamer(&state), &mut child(MockModel::new().with_turn("done"))).await;

    assert_eq!(turns(&state), json!({"t2": {}}));
}

#[tokio::test]
async fn raises_the_interrupts_an_unloadable_agent_turn_still_awaits_again_and_keeps_the_turn() {
    let turn = json!({
        "scope": "agent",
        "schemaVersion": "0.0",
        "data": {"interrupts": awaited_agent_state()},
        "appData": {}
    });
    let state = resuming_parent(Some(turn.clone()));
    let mut tool = streamer(&state);

    let resumed = tool.resume(Some(&mut child(MockModel::new())), "unavailable").await;

    let Resume::Raise(interrupts) = resumed else {
        panic!("expected the interrupts again");
    };
    assert_eq!(interrupts, [Interrupt::new("test:t:approval", "confirm")]);
    assert_eq!(turns(&state), json!({TOOL_USE_ID: turn}));
}

#[tokio::test]
async fn restores_the_stored_turn_and_returns_the_responses_for_this_call_without_the_prefix() {
    let interrupted = child(MockModel::new());
    interrupted
        .local
        .interrupt_state()
        .register_interrupt(&Interrupt::new("approval", "confirm"));
    interrupted.local.interrupt_state().activate();
    let snapshot = serde_json::to_value(take_session_snapshot(&interrupted.local).unwrap()).unwrap();
    let state = resuming_parent(Some(snapshot));
    let mut tool = streamer(&state);

    let resumed = tool.resume(Some(&mut child(MockModel::new())), "x").await;

    let Resume::Responses(responses) = resumed else {
        panic!("expected the responses for this call");
    };
    assert_eq!(
        responses,
        [InterruptResponseContent::new(InterruptResponse::new(
            "approval",
            json!("approved")
        ))]
    );
    assert_eq!(turns(&state), json!({}));
}

#[tokio::test]
async fn sets_an_error_when_the_stored_turn_is_missing_or_unreadable() {
    let cases = [
        ("missing", None),
        ("not an object", Some(json!("garbage"))),
        ("missing its data", Some(json!({"data": "x"}))),
        (
            "without interrupts",
            Some(json!({"data": {"interrupts": {"interrupts": 1}}})),
        ),
    ];
    for (case, turn) in cases {
        let state = resuming_parent(turn);
        let mut tool = streamer(&state);

        let resumed = tool.resume(Some(&mut child(MockModel::new())), "unavailable").await;

        assert!(matches!(resumed, Resume::Stop), "{case}");
        assert_eq!(tool.error.as_deref(), Some("unavailable"), "{case}");
    }
}
