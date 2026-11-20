//! The per-invocation state an agent threads through hooks and tools, and request-wide limits and
//! usage.
//!
//! Request contexts are crate-internal, so the tests obtain them from earlier calls: a call whose
//! `BeforeInvocationEvent` hook cancels it leaves a context with its limits and no usage.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::{MockTool, async_tool, tool_use_turn};
use serde_json::json;
use strands::agent::AgentAsToolOptions;
use strands::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, BeforeInvocationEvent, BeforeModelCallEvent,
    MessageAddedEvent,
};
use strands::testing::{MockModel, MockTurn};
use strands::types::ToolResultContent;
use strands::{
    Agent, Error, InvocationContext, InvocationState, InvokeLimits, InvokeOptions, Message, StopReason,
    ToolResultBlock, ToolResultStatus, Usage,
};
use tokio::sync::Mutex as AsyncMutex;

fn agent(model: MockModel) -> Agent {
    Agent::builder().model(model).printer(false).build().unwrap()
}

fn with_state(state: &InvocationState) -> InvokeOptions {
    InvokeOptions {
        invocation_state: Some(state.clone()),
        ..InvokeOptions::default()
    }
}

#[derive(Debug, Clone, PartialEq)]
struct UserId(&'static str);

#[derive(Debug, Clone, PartialEq)]
struct TraceId(&'static str);

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Counter(u32);

#[derive(Debug, Clone, Copy, PartialEq)]
struct Marker;

/// Whether two handles are the same state: a value inserted through one is visible in the other.
fn same_state(a: &InvocationState, b: &InvocationState) -> bool {
    let had = a.contains::<Marker>();
    a.insert(Marker);
    let shared = b.contains::<Marker>();
    if !had {
        a.remove::<Marker>();
    }
    shared
}

// --- invocationState: round-trip ---

#[tokio::test]
async fn returns_an_empty_object_on_agent_result_when_no_invocation_state_is_passed() {
    let mut agent = agent(MockModel::from_turns(["Hello"]));
    let result = agent.invoke("Hi").await.unwrap();
    assert!(result.invocation_state().is_empty());
}

#[tokio::test]
async fn returns_the_passed_invocation_state_on_agent_result() {
    let mut agent = agent(MockModel::from_turns(["Hello"]));
    let state = InvocationState::new();
    state.insert(UserId("u-1"));
    state.insert(TraceId("t-1"));
    let result = agent.invoke_with("Hi", with_state(&state)).await.unwrap();
    assert_eq!(result.invocation_state().get::<UserId>(), Some(UserId("u-1")));
    assert_eq!(result.invocation_state().get::<TraceId>(), Some(TraceId("t-1")));
    assert_eq!(result.invocation_state().len(), 2);
}

#[tokio::test]
async fn preserves_reference_identity_caller_keeps_the_same_object_they_passed_in() {
    let mut agent = agent(MockModel::from_turns(["Hello"]));
    let state = InvocationState::new();
    state.insert(UserId("u-1"));
    let result = agent.invoke_with("Hi", with_state(&state)).await.unwrap();
    assert!(same_state(&state, result.invocation_state()));
}

// --- invocationState: hook mutation ---

#[tokio::test]
async fn propagates_mutations_from_before_model_call_event_to_after_model_call_event_and_agent_result() {
    let mut agent = agent(MockModel::from_turns(["Hello"]));
    let seen_in_after: Arc<Mutex<Option<Counter>>> = Arc::default();
    agent.add_hook(|e: &mut BeforeModelCallEvent<'_>| e.invocation_state().update(|c: &mut Counter| c.0 += 1));
    let seen = seen_in_after.clone();
    agent.add_hook(move |e: &mut AfterModelCallEvent<'_>| {
        *seen.lock().unwrap() = e.invocation_state().get::<Counter>();
    });
    let result = agent.invoke("Hi").await.unwrap();
    assert_eq!(*seen_in_after.lock().unwrap(), Some(Counter(1)));
    assert_eq!(result.invocation_state().get::<Counter>(), Some(Counter(1)));
}

#[tokio::test]
async fn shares_the_same_invocation_state_object_across_all_lifecycle_events_in_one_invocation() {
    let mut agent = agent(MockModel::from_turns(["Hello"]));
    let seen: Arc<Mutex<Vec<InvocationState>>> = Arc::default();
    macro_rules! collect_on {
        ($($event:ty),*) => {$(
            let s = seen.clone();
            agent.add_hook(move |e: &mut $event| s.lock().unwrap().push(e.invocation_state().clone()));
        )*};
    }
    collect_on!(
        BeforeInvocationEvent<'_>,
        BeforeModelCallEvent<'_>,
        AfterModelCallEvent<'_>,
        MessageAddedEvent<'_>,
        AfterInvocationEvent<'_>
    );

    let result = agent.invoke("Hi").await.unwrap();

    let seen = seen.lock().unwrap();
    assert!(!seen.is_empty());
    for observed in seen.iter() {
        assert!(same_state(observed, result.invocation_state()));
    }
}

// --- invocationState: multi-cycle persistence ---

#[derive(Debug, Clone, Copy, PartialEq)]
struct ToolCompleted;

#[tokio::test]
async fn persists_mutations_across_recursive_agent_loop_cycles_tool_use_scenario() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("ping", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([MockTool::text("ping", "pong")])
        .printer(false)
        .build()
        .unwrap();
    agent.add_hook(|e: &mut AfterToolCallEvent| {
        e.invocation_state().insert(ToolCompleted);
    });
    let model_calls = Arc::new(AtomicUsize::new(0));
    let cycle2: Arc<Mutex<Option<bool>>> = Arc::default();
    let (calls, seen) = (model_calls.clone(), cycle2.clone());
    agent.add_hook(move |e: &mut BeforeModelCallEvent<'_>| {
        if calls.fetch_add(1, Ordering::SeqCst) == 1 {
            *seen.lock().unwrap() = Some(e.invocation_state().contains::<ToolCompleted>());
        }
    });

    let result = agent.invoke("Run ping").await.unwrap();

    assert_eq!(model_calls.load(Ordering::SeqCst), 2);
    assert_eq!(*cycle2.lock().unwrap(), Some(true));
    assert_eq!(result.invocation_state().get::<ToolCompleted>(), Some(ToolCompleted));
}

// --- invocationState: tool access ---

#[derive(Debug, Clone, PartialEq)]
struct LastToolSeenUserId(Option<UserId>);

#[tokio::test]
async fn passes_invocation_state_to_tools_via_tool_context_and_surfaces_mutations_on_the_result() {
    let writer = MockTool::new("writer", |context| {
        let state = context.invocation_state();
        state.update(|count: &mut Counter| count.0 += 1);
        state.insert(LastToolSeenUserId(state.get::<UserId>()));
        ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("ok")],
        )
        .into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("writer", "tu-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([writer])
        .printer(false)
        .build()
        .unwrap();
    let state = InvocationState::new();
    state.insert(UserId("u-42"));

    let result = agent.invoke_with("Run writer", with_state(&state)).await.unwrap();

    let state = result.invocation_state();
    assert_eq!(state.get::<UserId>(), Some(UserId("u-42")));
    assert_eq!(state.get::<Counter>(), Some(Counter(1)));
    assert_eq!(
        state.get::<LastToolSeenUserId>(),
        Some(LastToolSeenUserId(Some(UserId("u-42"))))
    );
    assert_eq!(state.len(), 3);
}

// --- invocationState: isolation from appState ---

#[derive(Debug, Clone, PartialEq)]
struct Ephemeral(&'static str);

#[derive(Debug, Clone, PartialEq)]
struct RequestId(&'static str);

#[tokio::test]
async fn does_not_touch_agent_app_state_when_invocation_state_is_mutated() {
    let mut agent = Agent::builder()
        .model(MockModel::from_turns(["Hello"]))
        .app_state(json!({"persistent": "yes"}).as_object().unwrap().clone())
        .printer(false)
        .build()
        .unwrap();
    agent.add_hook(|e: &mut BeforeModelCallEvent<'_>| {
        e.invocation_state().insert(Ephemeral("only-this-run"));
    });
    let state = InvocationState::new();
    state.insert(RequestId("r-1"));

    let result = agent.invoke_with("Hi", with_state(&state)).await.unwrap();

    assert_eq!(result.invocation_state().get::<RequestId>(), Some(RequestId("r-1")));
    assert_eq!(
        result.invocation_state().get::<Ephemeral>(),
        Some(Ephemeral("only-this-run"))
    );
    assert_eq!(agent.app_state().get_value("persistent"), Some(json!("yes")));
    assert_eq!(agent.app_state().keys(), ["persistent"]);
}

// --- invocationState: across invocations ---

#[tokio::test]
async fn does_not_leak_state_between_invocations_on_the_same_agent_default_bag() {
    let mut agent = agent(MockModel::from_turns(["A", "B"]));
    agent.add_hook(|e: &mut BeforeModelCallEvent<'_>| {
        e.invocation_state().insert(Marker);
    });
    let first = agent.invoke("1").await.unwrap();
    first.invocation_state().insert(Counter(7));
    let second = agent.invoke("2").await.unwrap();
    assert!(first.invocation_state().contains::<Marker>());
    assert!(second.invocation_state().contains::<Marker>());
    assert_eq!(second.invocation_state().get::<Counter>(), None);
}

// --- invocationState: retry paths ---

#[tokio::test]
async fn preserves_same_invocation_state_reference_across_after_model_call_event_retry() {
    let model = MockModel::new()
        .with_turn(MockTurn::error(|| Error::other("transient failure")))
        .with_turn("Success after retry");
    let mut agent = agent(model);
    let seen: Arc<Mutex<Vec<InvocationState>>> = Arc::default();
    let s = seen.clone();
    agent.add_hook(move |e: &mut BeforeModelCallEvent<'_>| {
        s.lock().unwrap().push(e.invocation_state().clone());
        e.invocation_state().update(|c: &mut Counter| c.0 += 1);
    });
    let s = seen.clone();
    let retried = Arc::new(AtomicUsize::new(0));
    agent.add_hook(move |e: &mut AfterModelCallEvent<'_>| {
        s.lock().unwrap().push(e.invocation_state().clone());
        if e.error().is_some() && retried.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_retry(true);
        }
    });
    let state = InvocationState::new();
    state.insert(UserId("u-1"));

    let result = agent.invoke_with("Test", with_state(&state)).await.unwrap();

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 4);
    for observed in seen.iter() {
        assert!(same_state(observed, result.invocation_state()));
    }
    assert_eq!(result.invocation_state().get::<UserId>(), Some(UserId("u-1")));
    assert_eq!(result.invocation_state().get::<Counter>(), Some(Counter(2)));
}

#[tokio::test]
async fn preserves_same_invocation_state_reference_across_after_tool_call_event_retry() {
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let calls = tool_calls.clone();
    let flaky = MockTool::new("flaky", move |context| {
        let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
        let (status, text) = if first {
            (ToolResultStatus::Error, "fail")
        } else {
            (ToolResultStatus::Success, "ok")
        };
        ToolResultBlock::new(
            context.tool_use().tool_use_id.clone(),
            status,
            vec![ToolResultContent::text(text)],
        )
        .into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("flaky", "tu-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([flaky])
        .printer(false)
        .build()
        .unwrap();
    let seen: Arc<Mutex<Vec<InvocationState>>> = Arc::default();
    let s = seen.clone();
    let retried = Arc::new(AtomicUsize::new(0));
    agent.add_hook(move |e: &mut AfterToolCallEvent| {
        s.lock().unwrap().push(e.invocation_state().clone());
        e.invocation_state().update(|c: &mut Counter| c.0 += 1);
        if e.result().status == ToolResultStatus::Error && retried.fetch_add(1, Ordering::SeqCst) == 0 {
            e.set_retry(true);
        }
    });
    let state = InvocationState::new();
    state.insert(RequestId("r-1"));

    let result = agent.invoke_with("Run flaky", with_state(&state)).await.unwrap();

    assert_eq!(tool_calls.load(Ordering::SeqCst), 2);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    for observed in seen.iter() {
        assert!(same_state(observed, result.invocation_state()));
    }
    assert_eq!(result.invocation_state().get::<RequestId>(), Some(RequestId("r-1")));
    assert_eq!(result.invocation_state().get::<Counter>(), Some(Counter(2)));
}

// --- request-wide limits ---

fn usage(input: u64, output: u64, total: u64) -> Usage {
    Usage::new(input, output, total)
}

fn text_with_usage(text: &str, usage: Usage) -> MockTurn {
    MockTurn::text(text).with_usage(usage)
}

fn limits(limits: InvokeLimits) -> InvokeOptions {
    InvokeOptions {
        limits: Some(limits),
        ..InvokeOptions::default()
    }
}

fn in_context(context: &InvocationContext, limits: Option<InvokeLimits>) -> InvokeOptions {
    InvokeOptions {
        invocation_context: Some(context.clone()),
        limits,
        ..InvokeOptions::default()
    }
}

/// A request context with `limits` and no usage: the context of a call a hook cancelled.
async fn empty_request(limits: Option<InvokeLimits>) -> InvocationContext {
    let mut agent = agent(MockModel::new());
    agent.add_hook(|e: &mut BeforeInvocationEvent<'_>| e.set_cancel(true));
    let options = InvokeOptions {
        limits,
        ..InvokeOptions::default()
    };
    let result = agent.invoke_with("setup", options).await.unwrap();
    result.invocation_context().unwrap().clone()
}

/// A tool that runs `sub` with the options `forward` builds from its context.
fn relay(
    sub: Agent,
    runs: &Arc<AtomicUsize>,
    forward: fn(&strands::ToolContext) -> InvokeOptions,
) -> strands::tools::FunctionTool {
    let sub = Arc::new(AsyncMutex::new(sub));
    let runs = runs.clone();
    async_tool("relay", move |_, context| {
        let sub = sub.clone();
        let runs = runs.clone();
        async move {
            let result = sub.lock().await.invoke_with("go", forward(&context)).await?;
            runs.fetch_add(1, Ordering::SeqCst);
            Ok(json!(result.stop_reason().to_string()))
        }
    })
}

fn sub_agent() -> Agent {
    agent(MockModel::from_turns([text_with_usage("sub done", usage(1, 1, 2))]))
}

#[tokio::test]
async fn leaves_the_parent_limit_intact_and_the_child_uncounted_when_a_hand_written_tool_forwards_invocation_state() {
    let runs = Arc::new(AtomicUsize::new(0));
    let tool = relay(sub_agent(), &runs, |context| with_state(context.invocation_state()));
    let parent_model = MockModel::new()
        .with_turn(tool_use_turn("relay", "tu-1", json!({})).with_usage(usage(1, 1, 2)))
        .with_turn(tool_use_turn("relay", "tu-2", json!({})).with_usage(usage(1, 1, 2)))
        .with_turn(tool_use_turn("relay", "tu-3", json!({})).with_usage(usage(1, 1, 2)));
    let mut parent = Agent::builder()
        .model(parent_model.clone())
        .tools([tool])
        .printer(false)
        .build()
        .unwrap();

    let result = parent
        .invoke_with(
            "start",
            limits(InvokeLimits {
                turns: Some(2),
                ..Default::default()
            }),
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::LimitTurns);
    assert_eq!(parent_model.call_count(), 2);
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn produces_a_well_formed_result_when_an_inherited_limit_is_already_exhausted_on_entry() {
    let mut earlier = agent(MockModel::from_turns(["earlier answer"]));
    let exhausted = earlier
        .invoke_with(
            "earlier",
            limits(InvokeLimits {
                turns: Some(1),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    let inherited = exhausted.invocation_context().unwrap().clone();
    let mut agent = Agent::builder()
        .model(MockModel::from_turns([text_with_usage(
            "should not run",
            usage(1, 1, 2),
        )]))
        .messages(vec![
            Message::user("earlier question"),
            Message::assistant("earlier answer"),
        ])
        .printer(false)
        .build()
        .unwrap();

    let result = agent.invoke_with("go", in_context(&inherited, None)).await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::LimitTurns);
    assert_eq!(result.last_message().role, strands::Role::Assistant);
    assert!(result.last_message().content.is_empty());
    assert_eq!(result.to_string(), "");
}

#[tokio::test]
async fn rejects_invalid_limits_before_any_invocation_hook_runs() {
    let mut agent = agent(MockModel::new());
    let before = Arc::new(AtomicUsize::new(0));
    let b = before.clone();
    agent.add_hook(move |_: &mut BeforeInvocationEvent<'_>| {
        b.fetch_add(1, Ordering::SeqCst);
    });
    let error = agent
        .invoke_with(
            "go",
            limits(InvokeLimits {
                turns: Some(0),
                ..Default::default()
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "limits.turns must be a positive finite number, got 0"
    );
    assert_eq!(before.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn reports_the_whole_requests_usage_on_the_result_while_metrics_cover_this_agent_only() {
    let inner = Agent::builder()
        .model(MockModel::from_turns([text_with_usage("inner done", usage(5, 7, 12))]))
        .name("inner")
        .description("inner agent")
        .printer(false)
        .build()
        .unwrap();
    let outer_model = MockModel::new()
        .with_turn(tool_use_turn("inner", "tu-1", json!({"input": "hi"})).with_usage(usage(1, 2, 3)))
        .with_turn(text_with_usage("outer done", usage(1, 1, 2)));
    let mut outer = Agent::builder()
        .model(outer_model)
        .tools([inner.as_tool(AgentAsToolOptions::default())])
        .printer(false)
        .build()
        .unwrap();

    let result = outer.invoke("go").await.unwrap();

    let request = result.invocation_context().unwrap().usage();
    assert_eq!(request.turns_taken, 3);
    assert_eq!(request.usage, usage(7, 10, 17));
    let own = &result.metrics().unwrap().accumulated_usage;
    assert_eq!((own.input_tokens, own.output_tokens, own.total_tokens), (2, 3, 5));
}

#[tokio::test]
async fn continues_a_previous_calls_limits_and_usage_when_passed_its_invocation_context() {
    let model = MockModel::new()
        .with_turn(text_with_usage("first", usage(1, 1, 2)))
        .with_turn(text_with_usage("second", usage(1, 1, 2)))
        .with_turn("never reached");
    let mut agent = agent(model.clone());

    let first = agent
        .invoke_with(
            "one",
            limits(InvokeLimits {
                turns: Some(2),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    let first_context = first.invocation_context().unwrap().clone();
    let second = agent
        .invoke_with("two", in_context(&first_context, None))
        .await
        .unwrap();
    let second_context = second.invocation_context().unwrap().clone();
    let third = agent
        .invoke_with("three", in_context(&second_context, None))
        .await
        .unwrap();

    assert_eq!(
        [first.stop_reason(), second.stop_reason(), third.stop_reason()],
        [StopReason::EndTurn, StopReason::EndTurn, StopReason::LimitTurns]
    );
    assert!(second_context.ptr_eq(&first_context));
    let request = third.invocation_context().unwrap().usage();
    assert_eq!(request.turns_taken, 2);
    assert_eq!(request.usage, usage(2, 2, 4));
    assert_eq!(model.call_count(), 2);
}

#[tokio::test]
async fn counts_only_a_nested_invokes_own_tokens_against_its_own_token_limits() {
    let mut setup = agent(MockModel::from_turns([text_with_usage(
        "earlier",
        usage(4000, 4000, 8000),
    )]));
    let enclosing = setup
        .invoke("earlier")
        .await
        .unwrap()
        .invocation_context()
        .unwrap()
        .clone();
    let mut agent = agent(MockModel::from_turns([text_with_usage("done", usage(10, 10, 20))]));

    let result = agent
        .invoke_with(
            "go",
            in_context(
                &enclosing,
                Some(InvokeLimits {
                    total_tokens: Some(5000),
                    ..Default::default()
                }),
            ),
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    let own = result.invocation_context().unwrap().usage();
    assert_eq!((own.turns_taken, own.usage), (1, usage(10, 10, 20)));
    let request = enclosing.usage();
    assert_eq!(request.turns_taken, 2, "the setup call took the first turn");
    assert_eq!(request.usage, usage(4010, 4010, 8020));
}

fn loop_agent(model: MockModel) -> Agent {
    let loop_tool = async_tool("loop", |_, _| async { Ok(json!("again")) });
    Agent::builder()
        .model(model)
        .tools([loop_tool])
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn stops_a_nested_invoke_on_the_requests_limit_even_when_its_own_limit_is_looser() {
    let mut setup = agent(MockModel::from_turns(["setup"]));
    let request = setup
        .invoke_with(
            "setup",
            limits(InvokeLimits {
                turns: Some(2),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
        .invocation_context()
        .unwrap()
        .clone();
    let model = MockModel::new()
        .with_turn(tool_use_turn("loop", "tu-1", json!({})))
        .with_turn(tool_use_turn("loop", "tu-2", json!({})));
    let mut agent = loop_agent(model.clone());

    let result = agent
        .invoke_with(
            "go",
            in_context(
                &request,
                Some(InvokeLimits {
                    turns: Some(5),
                    ..Default::default()
                }),
            ),
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::LimitTurns);
    assert_eq!(model.call_count(), 1);
    assert_eq!(request.usage().turns_taken, 2);
}

#[tokio::test]
async fn stops_a_nested_invoke_on_its_own_tighter_limit_and_counts_its_turns_toward_the_request() {
    let enclosing = empty_request(Some(InvokeLimits {
        turns: Some(10),
        ..Default::default()
    }))
    .await;
    let model = MockModel::new()
        .with_turn(tool_use_turn("loop", "tu-1", json!({})).with_usage(usage(1, 2, 3)))
        .with_turn("never reached");
    let mut agent = loop_agent(model.clone());

    let result = agent
        .invoke_with(
            "go",
            in_context(
                &enclosing,
                Some(InvokeLimits {
                    turns: Some(1),
                    ..Default::default()
                }),
            ),
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::LimitTurns);
    assert_eq!(model.call_count(), 1);
    let request = enclosing.usage();
    assert_eq!((request.turns_taken, request.usage), (1, usage(1, 2, 3)));
}

#[tokio::test]
async fn counts_a_nested_invokes_structured_output_failures_toward_the_request() {
    let request = empty_request(Some(InvokeLimits {
        structured_output_attempts: Some(1),
        ..Default::default()
    }))
    .await;
    let model = MockModel::new()
        .with_turn(tool_use_turn("strands_structured_output", "tu-1", json!({})))
        .with_turn(tool_use_turn("strands_structured_output", "tu-2", json!({})));
    let mut agent = Agent::builder()
        .model(model.clone())
        .structured_output_schema_json(json!({
            "type": "object",
            "properties": {"value": {"type": "number"}},
            "required": ["value"]
        }))
        .printer(false)
        .build()
        .unwrap();

    let result = agent
        .invoke_with(
            "go",
            in_context(
                &request,
                Some(InvokeLimits {
                    structured_output_attempts: Some(5),
                    ..Default::default()
                }),
            ),
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::LimitStructuredOutputAttempts);
    assert_eq!(model.call_count(), 1);
}

#[tokio::test]
async fn joins_the_request_when_a_hand_written_tool_forwards_context_invocation_context() {
    let runs = Arc::new(AtomicUsize::new(0));
    let tool = relay(sub_agent(), &runs, |context| InvokeOptions {
        invocation_context: context.invocation_context().cloned(),
        ..InvokeOptions::default()
    });
    let parent_model = MockModel::new()
        .with_turn(tool_use_turn("relay", "tu-1", json!({})))
        .with_turn(tool_use_turn("relay", "tu-2", json!({})));
    let mut parent = Agent::builder()
        .model(parent_model.clone())
        .tools([tool])
        .printer(false)
        .build()
        .unwrap();

    let result = parent
        .invoke_with(
            "start",
            limits(InvokeLimits {
                turns: Some(2),
                ..Default::default()
            }),
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::LimitTurns);
    assert_eq!(parent_model.call_count(), 1);
}

#[tokio::test]
async fn attaches_one_request_handle_to_the_events_and_tool_context_it_hands_out() {
    let probe_context: Arc<Mutex<Option<InvocationContext>>> = Arc::default();
    let captured = probe_context.clone();
    let probe = MockTool::new("probe", move |context| {
        *captured.lock().unwrap() = context.invocation_context().cloned();
        ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("ok")],
        )
        .into()
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("probe", "tu-1", json!({})))
        .with_turn("done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([probe])
        .printer(false)
        .build()
        .unwrap();
    let contexts: Arc<Mutex<Vec<Option<InvocationContext>>>> = Arc::default();
    let seen = contexts.clone();
    agent.add_hook(move |e: &mut BeforeModelCallEvent<'_>| {
        seen.lock().unwrap().push(e.invocation_context().cloned());
    });

    agent.invoke("go").await.unwrap();

    let contexts = contexts.lock().unwrap();
    let first = contexts[0].as_ref().unwrap();
    assert!(contexts[1].as_ref().unwrap().ptr_eq(first));
    assert!(probe_context.lock().unwrap().as_ref().unwrap().ptr_eq(first));
}

#[tokio::test]
async fn starts_fresh_request_state_on_each_root_invoke_of_a_reused_agent() {
    let mut agent = agent(MockModel::from_turns(["first", "second"]));
    let contexts: Arc<Mutex<Vec<Option<InvocationContext>>>> = Arc::default();
    let seen = contexts.clone();
    agent.add_hook(move |e: &mut BeforeModelCallEvent<'_>| {
        seen.lock().unwrap().push(e.invocation_context().cloned());
    });

    agent.invoke("one").await.unwrap();
    agent.invoke("two").await.unwrap();

    let contexts = contexts.lock().unwrap();
    let (first, second) = (contexts[0].as_ref().unwrap(), contexts[1].as_ref().unwrap());
    assert!(!second.ptr_eq(first));
    assert_eq!(second.usage().turns_taken, 1);
}

#[tokio::test]
async fn ends_on_a_limit_stop_even_when_a_hook_asks_to_resume() {
    let mut agent = loop_agent(MockModel::from_turns([tool_use_turn("loop", "tu-1", json!({}))]));
    let (passes, model_calls) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let p = passes.clone();
    agent.add_hook(move |_: &mut BeforeInvocationEvent<'_>| {
        p.fetch_add(1, Ordering::SeqCst);
    });
    let m = model_calls.clone();
    agent.add_hook(move |_: &mut BeforeModelCallEvent<'_>| {
        m.fetch_add(1, Ordering::SeqCst);
    });
    let p = passes.clone();
    agent.add_hook(move |e: &mut AfterInvocationEvent<'_>| {
        if p.load(Ordering::SeqCst) < 5 {
            e.set_resume("try again");
        }
    });

    let result = agent
        .invoke_with(
            "go",
            limits(InvokeLimits {
                turns: Some(1),
                ..Default::default()
            }),
        )
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::LimitTurns);
    assert_eq!(passes.load(Ordering::SeqCst), 1);
    assert_eq!(model_calls.load(Ordering::SeqCst), 1);
}
