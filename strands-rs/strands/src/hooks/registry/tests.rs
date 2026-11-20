use std::sync::Mutex;

use serde_json::json;

use super::*;
use crate::agent::InvocationState;
use crate::hooks::HookOrder;
use crate::test_support::{local_agent, tool_agent};
use crate::types::ToolUse;

type Calls = Arc<Mutex<Vec<String>>>;

fn calls() -> Calls {
    Arc::default()
}

fn names(calls: &Calls) -> Vec<String> {
    calls.lock().unwrap().clone()
}

fn record(
    calls: &Calls,
    name: &'static str,
) -> impl for<'a, 'b> Fn(&'b mut BeforeInvocationEvent<'a>) + Send + Sync + 'static {
    let calls = calls.clone();
    move |_| calls.lock().unwrap().push(name.to_owned())
}

fn record_after(
    calls: &Calls,
    name: &'static str,
) -> impl for<'a, 'b> Fn(&'b mut AfterInvocationEvent<'a>) + Send + Sync + 'static {
    let calls = calls.clone();
    move |_| calls.lock().unwrap().push(name.to_owned())
}

async fn fire_before(registry: &HookRegistry) {
    let mut agent = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    registry.invoke(&mut event).await.unwrap();
}

async fn fire_after(registry: &HookRegistry) {
    let mut agent = local_agent();
    let mut event = AfterInvocationEvent::new(&mut agent, InvocationState::new());
    registry.invoke(&mut event).await.unwrap();
}

fn order(order: i32) -> HookCallbackOptions {
    HookCallbackOptions { order }
}

#[tokio::test]
async fn registers_callback_for_event_type() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook(record(&calls, "a"));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["a"]);
}

#[tokio::test]
async fn registers_multiple_callbacks_for_same_event_type() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook(record(&calls, "a"));
    registry.add_hook(record(&calls, "b"));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["a", "b"]);
}

#[tokio::test]
async fn registers_callbacks_for_different_event_types_separately() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook(record(&calls, "before"));
    registry.add_hook(record_after(&calls, "after"));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["before"]);
    fire_after(&registry).await;
    assert_eq!(names(&calls), ["before", "after"]);
}

#[tokio::test]
async fn calls_registered_callbacks_in_order() {
    let (registry, calls) = (HookRegistry::new(), calls());
    for name in ["first", "second", "third"] {
        registry.add_hook(record(&calls, name));
    }
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["first", "second", "third"]);
}

#[tokio::test]
async fn reverses_callback_order_for_after_events() {
    let (registry, calls) = (HookRegistry::new(), calls());
    for name in ["first", "second", "third"] {
        registry.add_hook(record_after(&calls, name));
    }
    fire_after(&registry).await;
    assert_eq!(names(&calls), ["third", "second", "first"]);
}

#[tokio::test]
async fn awaits_async_callbacks() {
    let (registry, calls) = (HookRegistry::new(), calls());
    let seen = calls.clone();
    registry.add_async_hook::<BeforeInvocationEvent<'_>>(move |_| {
        let seen = seen.clone();
        Box::pin(async move {
            tokio::task::yield_now().await;
            seen.lock().unwrap().push("async".to_owned());
        })
    });
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["async"]);
}

#[tokio::test]
async fn handles_mixed_sync_and_async_callbacks() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook(record(&calls, "sync1"));
    let seen = calls.clone();
    registry.add_async_hook::<BeforeInvocationEvent<'_>>(move |_| {
        let seen = seen.clone();
        Box::pin(async move {
            tokio::task::yield_now().await;
            seen.lock().unwrap().push("async".to_owned());
        })
    });
    registry.add_hook(record(&calls, "sync2"));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["sync1", "async", "sync2"]);
}

#[tokio::test]
async fn returns_the_event_after_invocation() {
    let registry = HookRegistry::new();
    registry.add_hook(|event: &mut BeforeInvocationEvent<'_>| {
        event.set_cancel("stop");
        event
            .agent_mut()
            .messages_mut()
            .push(crate::types::Message::user("added"));
    });
    let mut agent = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    registry.invoke(&mut event).await.unwrap();
    assert_eq!(event.cancel(), &crate::hooks::Cancel::Message("stop".into()));
    assert_eq!(agent.messages().len(), 1);
}

#[tokio::test]
async fn lower_order_runs_first() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook_with(record(&calls, "late"), order(100));
    registry.add_hook_with(record(&calls, "early"), order(-100));
    registry.add_hook(record(&calls, "default"));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["early", "default", "late"]);
}

#[tokio::test]
async fn same_order_preserves_registration_order() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook_with(record(&calls, "a"), order(10));
    registry.add_hook_with(record(&calls, "b"), order(10));
    registry.add_hook_with(record(&calls, "c"), order(10));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["a", "b", "c"]);
}

#[tokio::test]
async fn negative_order_runs_before_default() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook(record(&calls, "default"));
    registry.add_hook_with(record(&calls, "early"), order(HookOrder::SDK_FIRST));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["early", "default"]);
}

#[tokio::test]
async fn after_events_lower_order_still_runs_first_across_groups() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook_with(record_after(&calls, "early"), order(-100));
    registry.add_hook_with(record_after(&calls, "late"), order(100));
    fire_after(&registry).await;
    assert_eq!(names(&calls), ["early", "late"]);
}

#[tokio::test]
async fn after_events_reverse_within_an_order_group_only() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook_with(record_after(&calls, "a10"), order(10));
    registry.add_hook(record_after(&calls, "a0"));
    registry.add_hook_with(record_after(&calls, "b10"), order(10));
    registry.add_hook(record_after(&calls, "b0"));
    fire_after(&registry).await;
    assert_eq!(names(&calls), ["b0", "a0", "b10", "a10"]);
}

#[tokio::test]
async fn returns_cleanup_function_that_removes_the_callback() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook(record(&calls, "a")).remove();
    fire_before(&registry).await;
    assert!(names(&calls).is_empty());
}

#[tokio::test]
async fn cleanup_function_is_idempotent() {
    let (registry, calls) = (HookRegistry::new(), calls());
    let cleanup = registry.add_hook(record(&calls, "a"));
    cleanup.remove();
    cleanup.remove();
    cleanup.remove();
    fire_before(&registry).await;
    assert!(names(&calls).is_empty());
    assert!(registry.is_empty());
}

#[tokio::test]
async fn cleanup_function_does_not_affect_other_callbacks() {
    let (registry, calls) = (HookRegistry::new(), calls());
    let cleanup = registry.add_hook(record(&calls, "a"));
    registry.add_hook(record(&calls, "b"));
    cleanup.remove();
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["b"]);
}

#[tokio::test]
async fn allows_callback_to_be_re_registered_after_cleanup() {
    let (registry, calls) = (HookRegistry::new(), calls());
    registry.add_hook(record(&calls, "a")).remove();
    registry.add_hook(record(&calls, "a"));
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["a"]);
}

#[tokio::test]
async fn cleanup_from_one_registration_does_not_affect_independent_registration_of_same_function() {
    let (registry, calls) = (HookRegistry::new(), calls());
    let callback = Arc::new(record(&calls, "shared"));
    let first = callback.clone();
    registry.add_hook(move |event: &mut BeforeInvocationEvent<'_>| first(event));
    let second = callback.clone();
    let cleanup = registry.add_hook(move |event: &mut BeforeInvocationEvent<'_>| second(event));
    cleanup.remove();
    fire_before(&registry).await;
    assert_eq!(names(&calls), ["shared"]);
}

#[tokio::test]
async fn cleanup_after_the_registry_is_dropped_does_nothing() {
    let registry = HookRegistry::new();
    let cleanup = registry.add_hook(|_: &mut BeforeToolCallEvent| {});
    drop(registry);
    cleanup.remove();
}

fn tool_event() -> BeforeToolCallEvent {
    BeforeToolCallEvent::new(
        tool_agent(),
        InvocationState::new(),
        ToolUse::new("test", "tool-1", json!({})),
        None,
    )
}

fn raise(
    name: &'static str,
    reason: Option<&'static str>,
) -> impl Fn(&mut BeforeToolCallEvent) + Send + Sync + 'static {
    move |event: &mut BeforeToolCallEvent| {
        let params = crate::types::InterruptParams::new(name);
        let params = match reason {
            Some(reason) => params.with_reason(reason),
            None => params,
        };
        let _ = event.interrupt(params);
    }
}

#[tokio::test]
async fn collects_interrupt_errors_from_multiple_callbacks_and_invokes_all_of_them() {
    let registry = HookRegistry::new();
    registry.add_hook(raise("interrupt_a", Some("Reason A")));
    registry.add_hook(raise("interrupt_b", Some("Reason B")));
    let mut event = tool_event();
    let interrupts = interrupts_of(registry.invoke(&mut event).await);
    assert_eq!(interrupts.len(), 2);
    let mut state: Vec<String> = event
        .agent()
        .interrupt_state()
        .interrupts()
        .into_iter()
        .map(|i| i.name)
        .collect();
    state.sort();
    assert_eq!(state, ["interrupt_a", "interrupt_b"]);
}

#[tokio::test]
async fn throws_interrupt_error_with_all_collected_interrupts_after_all_callbacks_run() {
    let registry = HookRegistry::new();
    registry.add_hook(raise("first", Some("First")));
    registry.add_hook(raise("second", Some("Second")));
    let mut event = tool_event();
    let interrupts = interrupts_of(registry.invoke(&mut event).await);
    assert_eq!(
        serde_json::to_value(&interrupts).unwrap(),
        json!([
            {"id": "hook:beforeToolCall:tool-1:first", "name": "first", "reason": "First", "source": "hook"},
            {"id": "hook:beforeToolCall:tool-1:second", "name": "second", "reason": "Second", "source": "hook"}
        ])
    );
}

#[tokio::test]
async fn runs_all_callbacks_when_only_some_raise_interrupts() {
    let (registry, calls) = (HookRegistry::new(), calls());
    for (name, interrupt) in [
        ("first", Some("interrupt_a")),
        ("second-no-interrupt", None),
        ("third", Some("interrupt_b")),
    ] {
        let seen = calls.clone();
        registry.add_hook(move |event: &mut BeforeToolCallEvent| {
            seen.lock().unwrap().push(name.to_owned());
            if let Some(interrupt) = interrupt {
                let _ = event.interrupt(interrupt);
            }
        });
    }
    let mut event = tool_event();
    let interrupts = interrupts_of(registry.invoke(&mut event).await);
    assert_eq!(names(&calls), ["first", "second-no-interrupt", "third"]);
    assert_eq!(interrupts.len(), 2);
}

#[tokio::test]
async fn throws_when_two_callbacks_use_the_same_interrupt_name() {
    let registry = HookRegistry::new();
    registry.add_hook(raise("confirm", Some("First")));
    registry.add_hook(raise("confirm", Some("Second")));
    let error = registry.invoke(&mut tool_event()).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "interrupt_names=<confirm> | duplicate interrupt names"
    );
}

#[tokio::test]
async fn reports_all_duplicate_interrupt_names_in_error() {
    let registry = HookRegistry::new();
    for name in ["alpha", "alpha", "beta", "beta"] {
        registry.add_hook(raise(name, None));
    }
    let error = registry.invoke(&mut tool_event()).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "interrupt_names=<alpha, beta> | duplicate interrupt names"
    );
}

#[tokio::test]
async fn an_answered_interrupt_returns_the_response_and_is_not_collected() {
    let registry = HookRegistry::new();
    let responses = calls();
    let seen = responses.clone();
    registry.add_hook(move |event: &mut BeforeToolCallEvent| {
        if let Ok(response) = event.interrupt("confirm") {
            seen.lock().unwrap().push(response.to_string());
        }
    });
    let mut event = tool_event();
    let _ = event.agent().interrupt_state().get_or_create_interrupt(
        "hook:beforeToolCall:tool-1:confirm",
        &"confirm".into(),
        crate::interrupt::InterruptSource::Hook,
    );
    event
        .agent()
        .interrupt_state()
        .respond("hook:beforeToolCall:tool-1:confirm", json!("yes"));
    registry.invoke(&mut event).await.unwrap();
    assert_eq!(names(&responses), ["\"yes\""]);
}

struct Counter(Arc<Mutex<u32>>);

#[async_trait]
impl<'a> Hook<BeforeInvocationEvent<'a>> for Counter {
    async fn handle(&self, _event: &mut BeforeInvocationEvent<'a>) -> Result<(), crate::BoxError> {
        *self.0.lock().unwrap() += 1;
        Ok(())
    }
}

#[async_trait]
impl Hook<BeforeToolCallEvent> for Counter {
    async fn handle(&self, event: &mut BeforeToolCallEvent) -> Result<(), crate::BoxError> {
        event.set_cancel(true);
        Ok(())
    }
}

#[tokio::test]
async fn hook_impls_register_per_event() {
    let registry = HookRegistry::new();
    let count = Arc::new(Mutex::new(0));
    registry.add_hook_impl::<BeforeInvocationEvent<'_>>(Counter(count.clone()));
    registry.add_hook_impl::<BeforeToolCallEvent>(Counter(count.clone()));
    fire_before(&registry).await;
    let mut event = tool_event();
    registry.invoke(&mut event).await.unwrap();
    assert_eq!(*count.lock().unwrap(), 1);
    assert!(event.cancel().is_cancelled());
}

#[tokio::test]
async fn per_tool_events_fire_on_spawned_tasks() {
    let registry = Arc::new(HookRegistry::new());
    registry.add_hook(|event: &mut BeforeToolCallEvent| event.set_cancel("no"));
    let shared = registry.clone();
    let cancel = tokio::spawn(async move {
        let mut event = tool_event();
        shared.invoke(&mut event).await.unwrap();
        event.cancel().clone()
    })
    .await
    .unwrap();
    assert_eq!(cancel, crate::hooks::Cancel::Message("no".into()));
}

fn interrupts_of(result: Result<()>) -> Vec<Interrupt> {
    match result {
        Err(Error::Interrupt(interrupts)) => interrupts.into_interrupts(),
        other => panic!("expected interrupts, got {other:?}"),
    }
}

#[tokio::test]
async fn stops_execution_on_first_non_interrupt_error() {
    let registry = HookRegistry::new();
    let calls = calls();
    let seen = calls.clone();
    registry.add_hook(move |_: &mut BeforeToolCallEvent| -> std::result::Result<(), Error> {
        seen.lock().unwrap().push("first".to_owned());
        Err(Error::other("hook failed"))
    });
    let seen = calls.clone();
    registry.add_hook(move |_: &mut BeforeToolCallEvent| seen.lock().unwrap().push("second".to_owned()));
    let error = registry.invoke(&mut tool_event()).await.unwrap_err();
    assert_eq!(error.to_string(), "hook failed");
    assert_eq!(names(&calls), ["first"]);
}

#[tokio::test]
async fn a_typed_sdk_error_from_a_hook_keeps_its_variant() {
    let registry = HookRegistry::new();
    registry.add_async_hook::<BeforeToolCallEvent>(|_| {
        Box::pin(async move { Err::<(), _>(Error::from(crate::ToolNotFoundError::new("gone"))) })
    });
    let error = registry.invoke(&mut tool_event()).await.unwrap_err();
    assert!(matches!(error, Error::ToolNotFound(_)), "{error:?}");
}

#[tokio::test]
async fn an_interrupt_returned_with_the_question_mark_is_collected_once() {
    let registry = HookRegistry::new();
    registry.add_hook(
        |event: &mut BeforeToolCallEvent| -> std::result::Result<(), crate::BoxError> {
            event.interrupt("confirm")?;
            Ok(())
        },
    );
    registry.add_async_hook::<BeforeToolCallEvent>(|event| {
        Box::pin(async move {
            event.interrupt("approve")?;
            Ok::<(), crate::BoxError>(())
        })
    });
    let interrupts = interrupts_of(registry.invoke(&mut tool_event()).await);
    let ids: Vec<&str> = interrupts.iter().map(|interrupt| interrupt.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "hook:beforeToolCall:tool-1:confirm",
            "hook:beforeToolCall:tool-1:approve"
        ]
    );
}

#[tokio::test]
async fn an_interrupt_error_from_a_hook_of_any_event_stops_for_input() {
    let registry = HookRegistry::new();
    registry.add_hook(|_: &mut BeforeInvocationEvent<'_>| {
        Err::<(), _>(InterruptError::from(Interrupt::new("custom:1", "custom")))
    });
    let mut agent = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    let interrupts = interrupts_of(registry.invoke(&mut event).await);
    assert_eq!(interrupts[0].id, "custom:1");
}

#[tokio::test]
async fn tracked_invocation_resumes_after_the_callbacks_that_ran() {
    let registry = HookRegistry::new();
    let calls = calls();
    for name in ["a", "b", "c"] {
        let seen = calls.clone();
        registry.add_hook(move |_: &mut BeforeToolCallEvent| seen.lock().unwrap().push(name.to_owned()));
    }
    let progress = AtomicUsize::new(2);
    registry.invoke_tracked(&mut tool_event(), &progress).await.unwrap();
    assert_eq!(names(&calls), ["c"]);
    assert_eq!(progress.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn tracked_invocation_does_not_count_a_failed_callback() {
    let registry = HookRegistry::new();
    registry.add_hook(|_: &mut BeforeToolCallEvent| {});
    registry.add_hook(|_: &mut BeforeToolCallEvent| Err::<(), _>(Error::other("Hook failed")));
    let progress = AtomicUsize::new(0);
    let error = registry.invoke_tracked(&mut tool_event(), &progress).await.unwrap_err();
    assert_eq!(error.to_string(), "Hook failed");
    assert_eq!(progress.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn propagates_callback_errors() {
    let registry = HookRegistry::new();
    registry.add_hook(|_: &mut BeforeInvocationEvent<'_>| Err::<(), _>(Error::other("Hook failed")));
    let mut agent = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    let error = registry.invoke(&mut event).await.unwrap_err();
    assert_eq!(error.to_string(), "Hook failed");
}

#[tokio::test]
async fn stops_on_non_interrupt_error_even_when_interrupts_were_collected() {
    let registry = HookRegistry::new();
    let calls = calls();
    registry.add_hook(raise("interrupt_a", Some("Reason A")));
    registry.add_hook(|_: &mut BeforeToolCallEvent| Err::<(), _>(Error::other("Non-interrupt failure")));
    let seen = calls.clone();
    registry.add_hook(move |_: &mut BeforeToolCallEvent| seen.lock().unwrap().push("third".to_owned()));
    let error = registry.invoke(&mut tool_event()).await.unwrap_err();
    assert_eq!(error.to_string(), "Non-interrupt failure");
    assert!(names(&calls).is_empty());
}
