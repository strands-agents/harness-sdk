use std::sync::Mutex;

use serde_json::json;

use super::*;
use crate::agent::{InvocationState, LocalAgent, ToolAgent};
use crate::hooks::{Cancel, ModelStopResponse};
use crate::interrupt::InterruptSource;
use crate::interventions::{Confirm, Proceed, Transform};
use crate::test_support::{local_agent, record_logs};
use crate::testing::MockModel;
use crate::types::{JsonValue, StopReason, ToolUse};

type Calls = Arc<Mutex<Vec<String>>>;

fn calls() -> Calls {
    Arc::default()
}

fn names(calls: &Calls) -> Vec<String> {
    calls.lock().unwrap().clone()
}

/// A handler whose `before_tool_call` records its name and returns what `action` builds.
struct ToolHandler {
    name: &'static str,
    on_error: OnError,
    calls: Option<Calls>,
    action: Box<dyn Fn() -> InterventionResult<BeforeToolCallEvent> + Send + Sync>,
}

impl ToolHandler {
    fn new(
        name: &'static str,
        action: impl Fn() -> InterventionResult<BeforeToolCallEvent> + Send + Sync + 'static,
    ) -> Self {
        Self {
            name,
            on_error: OnError::Throw,
            calls: None,
            action: Box::new(action),
        }
    }

    fn on_error(mut self, on_error: OnError) -> Self {
        self.on_error = on_error;
        self
    }

    fn recording(mut self, calls: &Calls) -> Self {
        self.calls = Some(calls.clone());
        self
    }
}

#[async_trait]
impl InterventionHandler for ToolHandler {
    fn name(&self) -> &str {
        self.name
    }

    fn on_error(&self) -> OnError {
        self.on_error
    }

    async fn before_tool_call(&self, _event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        if let Some(calls) = &self.calls {
            calls.lock().unwrap().push(self.name.to_owned());
        }
        (self.action)()
    }
}

fn deny_handler() -> ToolHandler {
    ToolHandler::new("deny-handler", || Ok(InterventionAction::deny("not authorized")))
}

fn guide_handler() -> ToolHandler {
    ToolHandler::new("guide-handler", || Ok(InterventionAction::guide("add more context")))
}

fn confirm_handler() -> ToolHandler {
    ToolHandler::new("confirm-handler", || {
        Ok(InterventionAction::confirm("approve this action?"))
    })
}

fn proceed_handler() -> ToolHandler {
    ToolHandler::new("proceed-handler", || Ok(Proceed::new().with_reason("all good").into()))
}

fn later(calls: &Calls) -> ToolHandler {
    ToolHandler::new("later", || Ok(InterventionAction::proceed())).recording(calls)
}

fn crashing(name: &'static str, on_error: OnError) -> ToolHandler {
    ToolHandler::new(name, || Err("handler crashed".into())).on_error(on_error)
}

struct ModelGuide(&'static str, &'static str);

#[async_trait]
impl InterventionHandler for ModelGuide {
    fn name(&self) -> &str {
        self.0
    }

    async fn before_model_call<'a>(
        &self,
        _event: &mut BeforeModelCallEvent<'a>,
    ) -> InterventionResult<BeforeModelCallEvent<'a>> {
        Ok(InterventionAction::guide(self.1))
    }

    async fn after_model_call<'a>(
        &self,
        _event: &mut AfterModelCallEvent<'a>,
    ) -> InterventionResult<AfterModelCallEvent<'a>> {
        Ok(InterventionAction::guide(self.1))
    }
}

fn registry(handlers: Vec<Arc<dyn InterventionHandler>>) -> HookRegistry {
    let hooks = HookRegistry::new();
    InterventionRegistry::new(handlers).unwrap().register(&hooks);
    hooks
}

fn handlers(list: Vec<ToolHandler>) -> Vec<Arc<dyn InterventionHandler>> {
    list.into_iter()
        .map(|handler| Arc::new(handler) as Arc<dyn InterventionHandler>)
        .collect()
}

fn tool_event(agent: &ToolAgent) -> BeforeToolCallEvent {
    BeforeToolCallEvent::new(
        agent.clone(),
        InvocationState::new(),
        ToolUse::new("testTool", "id-1", json!({})),
        None,
    )
}

async fn fire_tool(hooks: &HookRegistry) -> (Result<()>, BeforeToolCallEvent) {
    let agent = local_agent().tool_agent();
    let mut event = tool_event(&agent);
    let result = hooks.invoke(&mut event).await;
    (result, event)
}

fn preload(agent: &ToolAgent, handler: &str, response: JsonValue) {
    let id = format!("hook:beforeToolCall:id-1:{handler}");
    agent
        .interrupt_state()
        .get_or_create_interrupt(&id, &InterruptParams::new(handler), InterruptSource::Hook);
    agent.interrupt_state().respond(&id, response);
}

async fn fire_tool_with_response(hooks: &HookRegistry, handler: &str, response: JsonValue) -> BeforeToolCallEvent {
    let agent = local_agent().tool_agent();
    preload(&agent, handler, response);
    let mut event = tool_event(&agent);
    hooks.invoke(&mut event).await.unwrap();
    event
}

fn cancel_message(event: &BeforeToolCallEvent) -> Option<&str> {
    event.cancel().message_or("true")
}

fn after_model_event(agent: &mut LocalAgent) -> AfterModelCallEvent<'_> {
    let message = Message::new(Role::Assistant, vec![ContentBlock::text("response")]);
    AfterModelCallEvent::new(agent, InvocationState::new(), Arc::new(MockModel::new()), 0)
        .with_stop_data(ModelStopResponse::new(message, StopReason::EndTurn))
}

fn is_interrupt(result: &Result<()>) -> bool {
    matches!(result, Err(Error::Interrupt(_)))
}

#[tokio::test]
async fn default_methods_return_proceed() {
    struct NoOp;
    #[async_trait]
    impl InterventionHandler for NoOp {
        fn name(&self) -> &str {
            "no-op"
        }
    }
    let agent = local_agent().tool_agent();
    let action = NoOp.before_tool_call(&mut tool_event(&agent)).await.unwrap();
    assert_eq!(action.action_type(), "proceed");
    let mut local = local_agent();
    let mut event = after_model_event(&mut local);
    assert_eq!(
        NoOp.after_model_call(&mut event).await.unwrap().action_type(),
        "proceed"
    );
}

#[test]
fn rejects_duplicate_handler_names() {
    let error = InterventionRegistry::new(handlers(vec![deny_handler(), deny_handler()]))
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "Duplicate intervention handler name: 'deny-handler'");
}

#[test]
fn accepts_handlers_with_unique_names() {
    assert!(InterventionRegistry::new(handlers(vec![deny_handler(), guide_handler()])).is_ok());
}

#[tokio::test]
async fn only_registers_hooks_for_overridden_methods() {
    let hooks = registry(handlers(vec![deny_handler()]));
    let (_, event) = fire_tool(&hooks).await;
    assert_eq!(cancel_message(&event), Some("DENIED: not authorized"));

    let mut local = local_agent();
    let mut event = after_model_event(&mut local);
    hooks.invoke(&mut event).await.unwrap();
    assert!(!event.retry());
}

#[tokio::test]
async fn calls_handlers_in_registration_order() {
    let calls = calls();
    let first = ToolHandler::new("first", || Ok(InterventionAction::proceed())).recording(&calls);
    let second = ToolHandler::new("second", || Ok(InterventionAction::proceed())).recording(&calls);
    fire_tool(&registry(handlers(vec![first, second]))).await.0.unwrap();
    assert_eq!(names(&calls), ["first", "second"]);
}

#[tokio::test]
async fn skips_handlers_that_do_not_override_the_method() {
    let calls = calls();
    let tool = ToolHandler::new("tool", || Ok(InterventionAction::proceed())).recording(&calls);
    let mut list = handlers(vec![tool]);
    list.push(Arc::new(ModelGuide("model", "unused")));
    fire_tool(&registry(list)).await.0.unwrap();
    assert_eq!(names(&calls), ["tool"]);
}

#[tokio::test]
async fn deny_sets_cancel_on_before_tool_call_event() {
    let (_, event) = fire_tool(&registry(handlers(vec![deny_handler()]))).await;
    assert_eq!(cancel_message(&event), Some("DENIED: not authorized"));
}

#[tokio::test]
async fn deny_short_circuits_later_handlers_do_not_run() {
    let calls = calls();
    fire_tool(&registry(handlers(vec![deny_handler(), later(&calls)])))
        .await
        .0
        .unwrap();
    assert!(names(&calls).is_empty());
}

#[tokio::test]
async fn deny_sets_cancel_on_before_invocation_event() {
    struct InvocationDeny;
    #[async_trait]
    impl InterventionHandler for InvocationDeny {
        fn name(&self) -> &str {
            "invocation-deny"
        }
        async fn before_invocation<'a>(
            &self,
            _event: &mut BeforeInvocationEvent<'a>,
        ) -> InterventionResult<BeforeInvocationEvent<'a>> {
            Ok(InterventionAction::deny("unauthorized user"))
        }
    }
    let hooks = registry(vec![Arc::new(InvocationDeny)]);
    let mut local = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut local, InvocationState::new(), Vec::new());
    hooks.invoke(&mut event).await.unwrap();
    assert_eq!(event.cancel(), &Cancel::Message("DENIED: unauthorized user".into()));
}

#[tokio::test]
async fn deny_sets_cancel_on_before_model_call_event() {
    struct ModelDeny;
    #[async_trait]
    impl InterventionHandler for ModelDeny {
        fn name(&self) -> &str {
            "model-deny"
        }
        async fn before_model_call<'a>(
            &self,
            _event: &mut BeforeModelCallEvent<'a>,
        ) -> InterventionResult<BeforeModelCallEvent<'a>> {
            Ok(InterventionAction::deny("prompt injection detected"))
        }
    }
    let hooks = registry(vec![Arc::new(ModelDeny)]);
    let mut local = local_agent();
    let mut event = BeforeModelCallEvent::new(&mut local, InvocationState::new(), Arc::new(MockModel::new()));
    hooks.invoke(&mut event).await.unwrap();
    assert_eq!(
        event.cancel(),
        &Cancel::Message("DENIED: prompt injection detected".into())
    );
}

#[tokio::test]
async fn guide_sets_cancel_with_guidance_on_before_tool_call_event() {
    let (_, event) = fire_tool(&registry(handlers(vec![guide_handler()]))).await;
    assert_eq!(
        cancel_message(&event),
        Some("GUIDANCE: [guide-handler] add more context")
    );
}

#[tokio::test]
async fn accumulates_feedback_from_multiple_handlers() {
    let second = ToolHandler::new("second-guide", || {
        Ok(InterventionAction::guide("also check permissions"))
    });
    let (_, event) = fire_tool(&registry(handlers(vec![guide_handler(), second]))).await;
    assert_eq!(
        cancel_message(&event),
        Some("GUIDANCE: [guide-handler] add more context\n[second-guide] also check permissions")
    );
}

#[tokio::test]
async fn sets_retry_true_and_injects_guidance_message_on_after_model_call_event() {
    let hooks = registry(vec![Arc::new(ModelGuide("model-guide", "be more specific"))]);
    let mut local = local_agent();
    let mut event = after_model_event(&mut local);
    hooks.invoke(&mut event).await.unwrap();
    assert!(event.retry());
    drop(event);
    assert_eq!(local.messages().len(), 1);
    let message = &local.messages()[0];
    assert_eq!(message.role, Role::User);
    assert_eq!(message.text(), "[model-guide] be more specific");
    assert!(!message.tracking_id().is_empty());
}

#[tokio::test]
async fn confirm_pauses_agent_when_no_response_is_provided() {
    let (result, _) = fire_tool(&registry(handlers(vec![confirm_handler()]))).await;
    assert!(is_interrupt(&result));
}

#[tokio::test]
async fn confirm_short_circuits_later_handlers_do_not_run() {
    let calls = calls();
    let (result, _) = fire_tool(&registry(handlers(vec![confirm_handler(), later(&calls)]))).await;
    assert!(is_interrupt(&result));
    assert!(names(&calls).is_empty());
}

#[tokio::test]
async fn response_approve_deny_on_resume() {
    const DENIED: &str = "CONFIRMATION_FAILED: approve this action?";
    let cases = [
        (json!(true), None),
        (json!("yes"), None),
        (json!("y"), None),
        (json!("Y"), None),
        (json!("YES"), None),
        (json!("  yes  "), None),
        (json!("no"), Some(DENIED)),
        (json!(false), Some(DENIED)),
        (JsonValue::Null, Some(DENIED)),
        (json!(""), Some(DENIED)),
    ];
    for (response, expected) in cases {
        let hooks = registry(handlers(vec![confirm_handler()]));
        let event = fire_tool_with_response(&hooks, "confirm-handler", response.clone()).await;
        assert_eq!(cancel_message(&event), expected, "response {response}");
    }
}

fn custom_approval() -> ToolHandler {
    ToolHandler::new("custom-approval", || {
        Ok(Confirm::new("approve?")
            .with_evaluate(|response| response == &json!("custom-yes"))
            .into())
    })
}

#[tokio::test]
async fn uses_custom_evaluate_when_provided() {
    let hooks = registry(handlers(vec![custom_approval()]));
    let event = fire_tool_with_response(&hooks, "custom-approval", json!("yes")).await;
    assert_eq!(cancel_message(&event), Some("CONFIRMATION_FAILED: approve?"));
}

#[tokio::test]
async fn custom_evaluate_approves_when_its_condition_is_met() {
    let hooks = registry(handlers(vec![custom_approval()]));
    let event = fire_tool_with_response(&hooks, "custom-approval", json!("custom-yes")).await;
    assert_eq!(cancel_message(&event), None);
}

#[tokio::test]
async fn approved_confirm_does_not_short_circuit_later_handlers() {
    let calls = calls();
    let hooks = registry(handlers(vec![confirm_handler(), later(&calls)]));
    let event = fire_tool_with_response(&hooks, "confirm-handler", json!("yes")).await;
    assert_eq!(cancel_message(&event), None);
    assert_eq!(names(&calls), ["later"]);
}

#[tokio::test]
async fn denied_confirm_short_circuits_later_handlers() {
    let calls = calls();
    let hooks = registry(handlers(vec![confirm_handler(), later(&calls)]));
    let event = fire_tool_with_response(&hooks, "confirm-handler", json!("no")).await;
    assert_eq!(
        cancel_message(&event),
        Some("CONFIRMATION_FAILED: approve this action?")
    );
    assert!(names(&calls).is_empty());
}

fn inline_confirm(response: JsonValue) -> ToolHandler {
    ToolHandler::new("inline-confirm", move || {
        Ok(Confirm::new("approve?").with_response(response.clone()).into())
    })
}

#[tokio::test]
async fn approves_when_response_is_an_approved_value() {
    let (result, event) = fire_tool(&registry(handlers(vec![inline_confirm(json!("yes"))]))).await;
    result.unwrap();
    assert_eq!(cancel_message(&event), None);
}

#[tokio::test]
async fn denies_when_response_is_a_non_approved_value() {
    let (_, event) = fire_tool(&registry(handlers(vec![inline_confirm(json!("no"))]))).await;
    assert_eq!(cancel_message(&event), Some("CONFIRMATION_FAILED: approve?"));
}

#[tokio::test]
async fn uses_custom_evaluate_with_preemptive_response() {
    let otp = ToolHandler::new("otp-handler", || {
        Ok(Confirm::new("Enter OTP:")
            .with_response("123456")
            .with_evaluate(|response| response == &json!("123456"))
            .into())
    });
    let (result, event) = fire_tool(&registry(handlers(vec![otp]))).await;
    result.unwrap();
    assert_eq!(cancel_message(&event), None);
}

#[tokio::test]
async fn passes_response_as_preemptive_value_so_agent_never_pauses() {
    let hooks = registry(handlers(vec![inline_confirm(json!("yes"))]));
    let agent = local_agent().tool_agent();
    let mut event = tool_event(&agent);
    hooks.invoke(&mut event).await.unwrap();
    let interrupts = agent.interrupt_state().interrupts();
    assert_eq!(interrupts.len(), 1);
    assert_eq!(interrupts[0].name, "inline-confirm");
    assert_eq!(interrupts[0].reason, Some(json!("approve?")));
    assert_eq!(interrupts[0].response, Some(json!("yes")));
}

#[tokio::test]
async fn denies_when_response_is_falsy_but_defined_false() {
    let (_, event) = fire_tool(&registry(handlers(vec![inline_confirm(json!(false))]))).await;
    assert_eq!(cancel_message(&event), Some("CONFIRMATION_FAILED: approve?"));
}

#[tokio::test]
async fn interrupt_error_always_propagates_regardless_of_on_error() {
    for on_error in [OnError::Proceed, OnError::Deny] {
        let handler =
            ToolHandler::new("confirm-onerror", || Ok(InterventionAction::confirm("approve?"))).on_error(on_error);
        let (result, _) = fire_tool(&registry(handlers(vec![handler]))).await;
        assert!(is_interrupt(&result), "{on_error:?}");
    }
}

#[tokio::test]
async fn a_handler_raised_interrupt_error_propagates_regardless_of_on_error() {
    struct DirectInterrupt(OnError, bool);
    #[async_trait]
    impl InterventionHandler for DirectInterrupt {
        fn name(&self) -> &str {
            "direct-interrupt"
        }
        fn on_error(&self) -> OnError {
            self.0
        }
        async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
            let raised = event.interrupt(InterruptParams::new("approval").with_reason("approve?"));
            if self.1 {
                raised?;
            }
            Ok(InterventionAction::proceed())
        }
    }
    for on_error in [OnError::Proceed, OnError::Deny] {
        for propagate in [false, true] {
            let (result, event) = fire_tool(&registry(vec![Arc::new(DirectInterrupt(on_error, propagate))])).await;
            assert!(is_interrupt(&result), "{on_error:?} {propagate}");
            assert_eq!(cancel_message(&event), None);
        }
    }
}

#[tokio::test]
async fn transform_calls_the_apply_function_with_the_event() {
    let seen = calls();
    let recorder = seen.clone();
    let handler = ToolHandler::new("transform-handler", move || {
        let recorder = recorder.clone();
        Ok(Transform::new(move |event: &mut BeforeToolCallEvent| {
            recorder.lock().unwrap().push(event.tool_use().tool_use_id.clone());
        })
        .with_reason("sanitized input")
        .into())
    });
    fire_tool(&registry(handlers(vec![handler]))).await.0.unwrap();
    assert_eq!(names(&seen), ["id-1"]);
}

#[tokio::test]
async fn later_handlers_see_the_transformed_state() {
    struct Observer(Calls);
    #[async_trait]
    impl InterventionHandler for Observer {
        fn name(&self) -> &str {
            "observer"
        }
        async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
            self.0
                .lock()
                .unwrap()
                .push(event.cancel().message_or("true").unwrap_or("false").to_owned());
            Ok(InterventionAction::proceed())
        }
    }
    let observed = calls();
    let transformer = ToolHandler::new("transformer", || {
        Ok(InterventionAction::transform(|event: &mut BeforeToolCallEvent| {
            event.set_cancel("transformed");
        }))
    });
    let mut list = handlers(vec![transformer]);
    list.push(Arc::new(Observer(observed.clone())));
    fire_tool(&registry(list)).await.0.unwrap();
    assert_eq!(names(&observed), ["transformed"]);
}

#[tokio::test]
async fn transform_works_on_after_model_call_event() {
    struct ModelTransform(Calls);
    #[async_trait]
    impl InterventionHandler for ModelTransform {
        fn name(&self) -> &str {
            "model-transform"
        }
        async fn after_model_call<'a>(
            &self,
            _event: &mut AfterModelCallEvent<'a>,
        ) -> InterventionResult<AfterModelCallEvent<'a>> {
            let calls = self.0.clone();
            Ok(Transform::new(move |event: &mut AfterModelCallEvent<'a>| {
                calls.lock().unwrap().push(event.stop_data().unwrap().message.text());
            })
            .with_reason("redacted output")
            .into())
        }
    }
    let seen = calls();
    let hooks = registry(vec![Arc::new(ModelTransform(seen.clone()))]);
    let mut local = local_agent();
    let mut event = after_model_event(&mut local);
    hooks.invoke(&mut event).await.unwrap();
    assert_eq!(names(&seen), ["response"]);
}

#[tokio::test]
async fn proceed_does_not_mutate_the_event() {
    let (_, event) = fire_tool(&registry(handlers(vec![proceed_handler()]))).await;
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
}

#[tokio::test]
async fn on_error_throw_default_rethrows_the_error() {
    let hooks = registry(handlers(vec![
        crashing("throwing-handler", OnError::Throw),
        proceed_handler(),
    ]));
    let (result, _) = fire_tool(&hooks).await;
    assert_eq!(result.unwrap_err().to_string(), "handler crashed");
}

#[tokio::test]
async fn on_error_proceed_skips_the_handler_and_continues_to_next() {
    let hooks = registry(handlers(vec![
        crashing("throwing-proceed", OnError::Proceed),
        proceed_handler(),
    ]));
    let (result, event) = fire_tool(&hooks).await;
    result.unwrap();
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
}

#[tokio::test]
async fn on_error_deny_logs_the_error_and_applies_deny() {
    let calls = calls();
    let hooks = registry(handlers(vec![crashing("throwing-deny", OnError::Deny), later(&calls)]));
    let (_, event) = fire_tool(&hooks).await;
    assert_eq!(cancel_message(&event), Some("DENIED: Handler threw: handler crashed"));
    assert!(names(&calls).is_empty());
}

#[tokio::test]
async fn awaits_async_handler_results() {
    struct AsyncDeny;
    #[async_trait]
    impl InterventionHandler for AsyncDeny {
        fn name(&self) -> &str {
            "async-deny"
        }
        async fn before_tool_call(&self, _event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
            tokio::task::yield_now().await;
            Ok(InterventionAction::deny("async denial"))
        }
    }
    let (_, event) = fire_tool(&registry(vec![Arc::new(AsyncDeny)])).await;
    assert_eq!(cancel_message(&event), Some("DENIED: async denial"));
}

#[tokio::test]
async fn deny_wins_over_guide() {
    let (_, event) = fire_tool(&registry(handlers(vec![guide_handler(), deny_handler()]))).await;
    assert_eq!(cancel_message(&event), Some("DENIED: not authorized"));
}

#[tokio::test]
async fn deny_short_circuits_before_guide_can_accumulate() {
    let (_, event) = fire_tool(&registry(handlers(vec![deny_handler(), guide_handler()]))).await;
    assert_eq!(cancel_message(&event), Some("DENIED: not authorized"));
}

#[tokio::test]
async fn confirm_short_circuits_before_guide_can_accumulate() {
    let (result, _) = fire_tool(&registry(handlers(vec![confirm_handler(), guide_handler()]))).await;
    assert!(is_interrupt(&result));
}

#[tokio::test]
async fn guide_on_before_model_call_injects_a_user_message() {
    let hooks = registry(vec![Arc::new(ModelGuide("model-guide", "check your sources"))]);
    let mut local = local_agent();
    let mut event = BeforeModelCallEvent::new(&mut local, InvocationState::new(), Arc::new(MockModel::new()));
    hooks.invoke(&mut event).await.unwrap();
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
    drop(event);
    assert_eq!(local.messages().len(), 1);
    assert_eq!(local.messages()[0].role, Role::User);
    assert_eq!(local.messages()[0].text(), "[model-guide] check your sources");
    assert!(!local.messages()[0].tracking_id().is_empty());
}

fn bad_transform(on_error: OnError) -> ToolHandler {
    ToolHandler::new("bad-transform", || {
        Ok(InterventionAction::transform(
            |_: &mut BeforeToolCallEvent| -> std::result::Result<(), BoxError> { Err("apply boom".into()) },
        ))
    })
    .on_error(on_error)
}

#[tokio::test]
async fn transform_apply_error_is_handled_via_on_error_policy() {
    let after = ToolHandler::new("after-transform", || {
        Ok(Proceed::new().with_reason("still running").into())
    });
    let (result, event) = fire_tool(&registry(handlers(vec![bad_transform(OnError::Proceed), after]))).await;
    result.unwrap();
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
}

#[tokio::test]
async fn transform_apply_error_with_on_error_throw_propagates() {
    let (result, _) = fire_tool(&registry(handlers(vec![bad_transform(OnError::Throw)]))).await;
    assert_eq!(result.unwrap_err().to_string(), "apply boom");
}

#[tokio::test]
async fn warns_when_action_has_no_effect_on_event_type() {
    struct ConfirmOnInvocation;
    #[async_trait]
    impl InterventionHandler for ConfirmOnInvocation {
        fn name(&self) -> &str {
            "confirm-invocation"
        }
        async fn before_invocation<'a>(
            &self,
            _event: &mut BeforeInvocationEvent<'a>,
        ) -> InterventionResult<BeforeInvocationEvent<'a>> {
            Ok(InterventionAction::confirm("test"))
        }
    }
    let (logs, _guard) = record_logs();
    let hooks = registry(vec![Arc::new(ConfirmOnInvocation)]);
    let mut local = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut local, InvocationState::new(), Vec::new());
    hooks.invoke(&mut event).await.unwrap();
    assert!(
        logs.text()
            .contains("handler=<confirm-invocation>, event=<beforeInvocation> | confirm has no effect")
    );
}
