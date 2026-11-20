use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::hooks::BeforeInvocationEvent;
use crate::session::SessionManager;
use crate::storage::InMemoryStorage;
use crate::test_support::{MockTool, record_logs};
use crate::testing::{MockModel, MockTurn, tool_context};
use crate::types::{ContentBlock, InterruptParams, ToolUse, ToolUseBlock};

const INNER_ID: &str = "tool:inner-1:confirm";
const OUTER_ID: &str = "agent_as_tool:outer-1:tool:inner-1:confirm";

struct Nested {
    orch: Agent,
    sub: Arc<AgentAsTool>,
    orch_model: MockModel,
    confirmed: Arc<AtomicUsize>,
}

fn tool_use(name: &str, id: &str, input: JsonValue) -> MockTurn {
    MockTurn::content([ContentBlock::from(ToolUseBlock::new(name, id, input))])
}

fn confirm_tool(confirmed: &Arc<AtomicUsize>) -> MockTool {
    let confirmed = confirmed.clone();
    MockTool::new("confirmTool").with_result(move |context| {
        match context.interrupt(InterruptParams::new("confirm").with_reason("Please confirm")) {
            Ok(_) => {
                confirmed.fetch_add(1, Ordering::SeqCst);
                ToolResultBlock::success(
                    context.tool_use().tool_use_id.clone(),
                    vec![ToolResultContent::text("ok")],
                )
                .into()
            }
            Err(interrupt) => interrupt.into(),
        }
    })
}

/// A sub-agent whose only tool asks for confirmation, and the orchestrator that calls it once.
fn nested(preserve_context: bool) -> Nested {
    let confirmed = Arc::new(AtomicUsize::new(0));
    let sub_model = MockModel::new()
        .with_turn(tool_use("confirmTool", "inner-1", json!({})))
        .with_turn("sub done");
    let sub = Agent::builder()
        .id("sub")
        .name("sub")
        .model(sub_model)
        .tools([confirm_tool(&confirmed)])
        .printer(false)
        .build()
        .unwrap();
    let sub = Arc::new(sub.as_tool(AgentAsToolOptions::builder().preserve_context(preserve_context).build()));
    let orch_model = MockModel::new()
        .with_turn(tool_use("sub", "outer-1", json!({"input": "go"})))
        .with_turn("orch done");
    let orch = Agent::builder()
        .id("orch")
        .model(orch_model.clone())
        .tools([ToolSource::from(sub.clone() as Arc<dyn Tool>)])
        .printer(false)
        .build()
        .unwrap();
    Nested {
        orch,
        sub,
        orch_model,
        confirmed,
    }
}

fn stored_turns(agent: &Agent) -> serde_json::Map<String, JsonValue> {
    match agent.local.interrupt_state().context_value(INTERRUPTED_TURNS_KEY) {
        Some(JsonValue::Object(turns)) => turns,
        _ => serde_json::Map::new(),
    }
}

fn store_turn(agent: &Agent, turn: &JsonValue) {
    agent
        .local
        .interrupt_state()
        .set_context_value(INTERRUPTED_TURNS_KEY, Some(json!({"outer-1": turn})));
}

fn respond(id: &str) -> Vec<InterruptResponse> {
    vec![InterruptResponse::new(id, json!("yes"))]
}

fn ids(result: &AgentResult) -> Vec<String> {
    result
        .interrupts()
        .iter()
        .map(|interrupt| interrupt.id.clone())
        .collect()
}

#[tokio::test]
async fn propagates_a_sub_agent_interrupt_to_the_orchestrator_with_an_id_scoped_to_the_tool_call() {
    let Nested { mut orch, .. } = nested(false);

    let result = orch.invoke("Test").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(
        serde_json::to_value(result.interrupts()).unwrap(),
        json!([{"id": OUTER_ID, "name": "confirm", "reason": "Please confirm", "source": "tool"}])
    );
    assert!(!serde_json::to_string(orch.messages()).unwrap().contains("toolResult"));
}

#[tokio::test]
async fn resumes_the_sub_agent_in_process_and_runs_the_confirmed_tool_once() {
    let Nested {
        mut orch,
        orch_model,
        confirmed,
        ..
    } = nested(false);
    orch.invoke("Test").await.unwrap();

    let result = orch.invoke(respond(OUTER_ID)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(confirmed.load(Ordering::SeqCst), 1);
    assert_eq!(orch_model.call_count(), 2);
}

#[tokio::test]
async fn stores_an_ephemeral_sub_agent_turn_on_the_orchestrator_and_frees_it_on_resume() {
    let Nested { mut orch, sub, .. } = nested(false);
    orch.invoke("Test").await.unwrap();

    let turns = stored_turns(&orch);
    assert_eq!(turns.keys().collect::<Vec<_>>(), ["outer-1"]);
    let sub_messages = serde_json::to_value(sub.agent().await.messages()).unwrap();
    assert_eq!(turns["outer-1"]["data"]["messages"], sub_messages);

    orch.invoke(respond(OUTER_ID)).await.unwrap();
    assert!(stored_turns(&orch).is_empty());
}

#[tokio::test]
async fn stores_nothing_for_a_context_preserving_sub_agent_and_warns_when_it_has_no_session_manager() {
    let (logs, _guard) = record_logs();
    let Nested { mut orch, .. } = nested(true);

    orch.invoke("Test").await.unwrap();

    assert_eq!(orch.local.interrupt_state().to_data().context, None);
    assert!(
        logs.text().contains("preserveContext=true and no session manager"),
        "{}",
        logs.text()
    );
}

#[tokio::test]
async fn raises_the_interrupt_again_when_the_stored_turn_cannot_be_loaded() {
    let Nested { mut orch, .. } = nested(false);
    orch.invoke("Test").await.unwrap();
    store_turn(
        &orch,
        &json!({"data": {"messages": "not-a-list", "interrupts": {"interrupts": {INNER_ID: {}}}}}),
    );

    let result = orch.invoke(respond(OUTER_ID)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(ids(&result), [OUTER_ID]);
    assert_eq!(stored_turns(&orch).keys().collect::<Vec<_>>(), ["outer-1"]);
}

#[tokio::test]
async fn logs_instead_of_re_raising_when_an_unloadable_stored_turn_has_no_readable_interrupt_state() {
    let Nested { mut orch, .. } = nested(false);
    orch.invoke("Test").await.unwrap();
    store_turn(&orch, &json!({"data": {"messages": "not-a-list"}}));
    let (logs, _guard) = record_logs();

    let result = orch.invoke(respond(OUTER_ID)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(logs.text().contains("no readable interrupt state"), "{}", logs.text());
}

/// A tool context whose agent awaits a resume with `responses` for `interrupt_ids`.
fn resuming_context(tool_use_id: &str, interrupt_ids: &[&str], responses: &[(&str, &str)]) -> ToolContext {
    let context = tool_context(ToolUse::new("sub", tool_use_id, json!({"input": "go"})));
    let state = context.agent().interrupt_state();
    for id in interrupt_ids {
        state.register_interrupt(&Interrupt::new(*id, "confirm"));
    }
    state.activate();
    let responses: Vec<InterruptResponseContent> = responses
        .iter()
        .map(|(id, response)| InterruptResponseContent::new(InterruptResponse::new(*id, json!(response))))
        .collect();
    state.resume(&responses).unwrap();
    context
}

async fn outcome(stream: ToolStream) -> ToolOutcome {
    let mut stream = stream;
    let mut last = None;
    while let Some(item) = stream.next().await {
        if let ToolStreamItem::Outcome(outcome) = item {
            last = Some(outcome);
        }
    }
    last.unwrap()
}

#[tokio::test]
async fn returns_an_error_result_when_there_is_no_turn_to_resume() {
    let sub = Agent::builder()
        .name("sub")
        .model(MockModel::new())
        .printer(false)
        .build()
        .unwrap();
    let tool = sub.as_tool(AgentAsToolOptions::default());
    let context = resuming_context("outer-1", &[OUTER_ID], &[(OUTER_ID, "yes")]);

    let ToolOutcome::Result(result) = outcome(tool.stream(context)).await else {
        panic!("expected a result");
    };

    assert_eq!(result.status, crate::types::ToolResultStatus::Error);
    assert!(serde_json::to_string(&result.content).unwrap().contains("NOT applied"));
}

#[tokio::test]
async fn maps_only_this_calls_responses_with_the_tool_use_id_escaped() {
    let sub = Agent::builder()
        .name("sub")
        .model(MockModel::new().with_turn("done"))
        .printer(false)
        .build()
        .unwrap();
    sub.local
        .interrupt_state()
        .register_interrupt(&Interrupt::new("interrupt-1", "confirm"));
    sub.local.interrupt_state().activate();
    let received = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = received.clone();
    sub.add_hook(move |event: &mut BeforeInvocationEvent<'_>| {
        *sink.lock().unwrap() = event.agent().interrupt_state().resume_responses();
    });
    let tool = sub.as_tool(AgentAsToolOptions::builder().preserve_context(true).build());
    let mine = format!("agent_as_tool:{}:interrupt-1", encode_uri_component("tool:123"));
    let other = format!("agent_as_tool:{}:interrupt-1", encode_uri_component("tool:123:extra"));
    assert_eq!(mine, "agent_as_tool:tool%3A123:interrupt-1");
    let context = resuming_context("tool:123", &[&mine, &other], &[(&other, "no"), (&mine, "yes")]);

    outcome(tool.stream(context)).await;

    assert_eq!(
        *received.lock().unwrap(),
        [InterruptResponseContent::new(InterruptResponse::new(
            "interrupt-1",
            json!("yes")
        ))]
    );
}

#[tokio::test]
async fn does_not_adopt_an_interrupt_that_belongs_to_another_tool_call() {
    let Nested {
        mut orch,
        sub,
        confirmed,
        ..
    } = nested(false);
    let foreign = "agent_as_tool:tool-999:tool:inner-1:confirm";
    orch.local
        .interrupt_state()
        .register_interrupt(&Interrupt::new(foreign, "confirm"));
    orch.local.interrupt_state().activate();
    {
        let sub = sub.agent().await;
        sub.local
            .interrupt_state()
            .register_interrupt(&Interrupt::new("stale", "stale"));
        sub.local.interrupt_state().activate();
    }

    let result = orch.invoke(respond(foreign)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(ids(&result), [OUTER_ID]);
    let sub_interrupts = sub.agent().await.local.interrupt_state().interrupt_list();
    assert!(sub_interrupts.iter().all(|interrupt| interrupt.id != "stale"));
    assert_eq!(confirmed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn raises_the_interrupt_again_when_only_another_interrupt_was_answered_and_keeps_the_turn() {
    let Nested { mut orch, .. } = nested(false);
    orch.invoke("Test").await.unwrap();
    let sibling = "tool:other-1:confirm";
    orch.local
        .interrupt_state()
        .register_interrupt(&Interrupt::new(sibling, "confirm"));

    let result = orch.invoke(respond(sibling)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert!(ids(&result).contains(&OUTER_ID.to_owned()));
    assert_eq!(stored_turns(&orch).keys().collect::<Vec<_>>(), ["outer-1"]);
}

#[tokio::test]
async fn re_raises_only_the_interrupts_the_stored_turn_still_awaits() {
    let Nested { mut orch, sub, .. } = nested(false);
    orch.invoke("Test").await.unwrap();
    let finished = "agent_as_tool:outer-1:tool:inner-0:earlier";
    orch.local
        .interrupt_state()
        .register_interrupt(&Interrupt::new(finished, "earlier"));
    let mut unloadable = serde_json::to_value(take_session_snapshot(&sub.agent().await.local).unwrap()).unwrap();
    unloadable["schemaVersion"] = json!("0.0");
    store_turn(&orch, &unloadable);

    let responses = vec![
        InterruptResponse::new(finished, json!("yes")),
        InterruptResponse::new(OUTER_ID, json!("yes")),
    ];
    let result = orch.invoke(responses).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(ids(&result), [OUTER_ID]);
    assert_eq!(stored_turns(&orch).keys().collect::<Vec<_>>(), ["outer-1"]);
}

#[tokio::test]
async fn surfaces_the_interrupts_of_two_sub_agents_that_pause_in_the_same_turn() {
    let sub = |id: &str| {
        Agent::builder()
            .id(id)
            .name(id)
            .printer(false)
            .model(
                MockModel::new()
                    .with_turn(tool_use("confirmTool", &format!("{id}-inner"), json!({})))
                    .with_turn("done"),
            )
            .tools([
                MockTool::new("confirmTool").with_result(|context| match context.interrupt("confirm") {
                    Ok(_) => ToolResultBlock::success(context.tool_use().tool_use_id.clone(), Vec::new()).into(),
                    Err(interrupt) => interrupt.into(),
                }),
            ])
            .build()
            .unwrap()
    };
    let model = MockModel::new()
        .with_turn(MockTurn::content([
            ContentBlock::from(ToolUseBlock::new("a", "call-a", json!({"input": "go"}))),
            ContentBlock::from(ToolUseBlock::new("b", "call-b", json!({"input": "go"}))),
        ]))
        .with_turn("done");
    let mut orch = Agent::builder()
        .printer(false)
        .model(model)
        .tools([
            sub("a").as_tool(AgentAsToolOptions::default()),
            sub("b").as_tool(AgentAsToolOptions::default()),
        ])
        .build()
        .unwrap();

    let result = orch.invoke("Test").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    let mut ids = ids(&result);
    ids.sort();
    assert_eq!(
        ids,
        [
            "agent_as_tool:call-a:tool:a-inner:confirm",
            "agent_as_tool:call-b:tool:b-inner:confirm"
        ]
    );
}

#[test]
fn encode_uri_component_matches_js() {
    assert_eq!(encode_uri_component("tool:1/a b"), "tool%3A1%2Fa%20b");
    assert_eq!(encode_uri_component("A-z_0.!~*'()"), "A-z_0.!~*'()");
    assert_eq!(encode_uri_component("é"), "%C3%A9");
}

/// `nested({ preserveContext, sessionStorage, subSessionStorage, rebuilt })`: both agents keep their
/// sessions in `storage` (the sub-agent only with `sub_session`); a rebuilt pair has fresh models
/// that start at the turn after the interrupted tool call.
fn nested_in_session(
    preserve_context: bool,
    storage: &Arc<InMemoryStorage>,
    sub_session: bool,
    rebuilt: bool,
) -> Nested {
    let confirmed = Arc::new(AtomicUsize::new(0));
    let session = || {
        SessionManager::builder()
            .session_id("s1")
            .storage(storage.clone())
            .build()
            .unwrap()
    };
    let sub_model = MockModel::new();
    if !rebuilt {
        sub_model.add_turn(tool_use("confirmTool", "inner-1", json!({})));
    }
    sub_model.add_turn("sub done");
    let sub = Agent::builder()
        .id("sub")
        .name("sub")
        .model(sub_model)
        .tools([confirm_tool(&confirmed)])
        .maybe_session_manager(sub_session.then(session))
        .printer(false)
        .build()
        .unwrap();
    let sub = Arc::new(sub.as_tool(AgentAsToolOptions::builder().preserve_context(preserve_context).build()));
    let orch_model = MockModel::new();
    if !rebuilt {
        orch_model.add_turn(tool_use("sub", "outer-1", json!({"input": "go"})));
    }
    orch_model.add_turn("orch done");
    let orch = Agent::builder()
        .id("orch")
        .model(orch_model.clone())
        .tools([ToolSource::from(sub.clone() as Arc<dyn Tool>)])
        .session_manager(session())
        .printer(false)
        .build()
        .unwrap();
    Nested {
        orch,
        sub,
        orch_model,
        confirmed,
    }
}

#[tokio::test]
async fn resumes_after_both_agents_are_rebuilt_from_a_session() {
    let storage = Arc::new(InMemoryStorage::new());
    let mut first = nested_in_session(false, &storage, false, false);
    let interrupted = first.orch.invoke("Test").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);

    let mut second = nested_in_session(false, &storage, false, true);
    let result = second.orch.invoke(respond(OUTER_ID)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(second.confirmed.load(Ordering::SeqCst), 1);
    assert_eq!(first.confirmed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn resumes_a_context_preserving_sub_agent_with_its_own_session_manager_after_both_are_rebuilt() {
    let storage = Arc::new(InMemoryStorage::new());
    let mut first = nested_in_session(true, &storage, true, false);
    let (logs, guard) = record_logs();
    assert_eq!(
        first.orch.invoke("Test").await.unwrap().stop_reason(),
        StopReason::Interrupt
    );
    drop(guard);
    assert_eq!(first.orch.local.interrupt_state().to_data().context, None);
    assert!(!logs.text().contains("no session manager"), "{}", logs.text());

    let mut second = nested_in_session(true, &storage, true, true);
    let result = second.orch.invoke(respond(OUTER_ID)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(second.confirmed.load(Ordering::SeqCst), 1);
}
