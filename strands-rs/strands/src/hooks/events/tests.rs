use serde_json::json;

use super::*;
use crate::hooks::{AgentStreamEvent, HookEvent};
use crate::models::streaming::{ContentBlockDelta, ModelContentBlockDeltaEvent, TextDelta};
use crate::telemetry::AgentMetrics;
use crate::test_support::{MockTool, local_agent, tool_agent};
use crate::types::{Role, ToolResultContent};

fn message() -> Message {
    Message::new(Role::Assistant, vec![ContentBlock::text("test")]).with_tracking_id("m-1")
}

fn tool_use() -> ToolUse {
    ToolUse::new("test", "id-1", json!({}))
}

fn result() -> ToolResultBlock {
    ToolResultBlock::success("id-1", vec![ToolResultContent::text("ok")])
}

fn record(event: impl Into<AgentStreamEvent>) -> JsonValue {
    serde_json::to_value(event.into()).unwrap()
}

fn text_delta(text: &str) -> ModelStreamEvent {
    ModelStreamEvent::ContentBlockDelta(ModelContentBlockDeltaEvent::new(ContentBlockDelta::Text(
        TextDelta::new(text),
    )))
}

const fn reverses<K: HookEvent>() -> bool {
    K::REVERSE
}

#[test]
fn initialized_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let mut event = InitializedEvent::new(&mut agent);
    assert_eq!(event.agent().id(), "agent-1");
    event.agent_mut().messages_mut().push(message());
    assert_eq!(agent.messages().len(), 1);
}

#[test]
fn returns_false_for_should_reverse_callbacks_on_before_and_data_events() {
    assert!(!reverses::<InitializedEvent<'static>>());
    assert!(!reverses::<BeforeInvocationEvent<'static>>());
    assert!(!reverses::<MessageAddedEvent<'static>>());
    assert!(!reverses::<BeforeToolCallEvent>());
    assert!(!reverses::<BeforeModelCallEvent<'static>>());
    assert!(!reverses::<BeforeToolsEvent<'static>>());
    assert!(!reverses::<ModelStreamUpdateEvent<'static>>());
    assert!(!reverses::<ToolResultEvent>());
}

#[test]
fn returns_true_for_should_reverse_callbacks_on_after_events() {
    assert!(reverses::<AfterInvocationEvent<'static>>());
    assert!(reverses::<AfterToolCallEvent>());
    assert!(reverses::<AfterModelCallEvent<'static>>());
    assert!(reverses::<AfterToolsEvent<'static>>());
}

#[test]
fn before_invocation_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let state = InvocationState::new();
    state.insert(7_u32);
    let event = BeforeInvocationEvent::new(&mut agent, state, vec![message()]);
    assert_eq!(event.agent().id(), "agent-1");
    assert_eq!(event.invocation_state().get::<u32>(), Some(7));
    assert_eq!(event.messages(), [message()]);
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
    assert!(event.invocation_context().is_none());
}

#[test]
fn allows_cancel_to_be_set_to_true() {
    let mut agent = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    event.set_cancel(true);
    assert_eq!(event.cancel(), &Cancel::Cancelled);
    assert_eq!(event.cancel().message_or("default"), Some("default"));
}

#[test]
fn allows_cancel_to_be_set_to_a_string_message() {
    let mut agent = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    event.set_cancel("custom cancel message");
    assert_eq!(event.cancel().message_or("default"), Some("custom cancel message"));
    event.set_cancel(false);
    assert!(!event.cancel().is_cancelled());
}

#[test]
fn allows_messages_to_be_mutated_and_replaced() {
    let mut agent = local_agent();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), vec![message()]);
    event.messages_mut().push(Message::user("more"));
    assert_eq!(event.messages().len(), 2);
    event.set_messages(vec![Message::user("replaced")]);
    assert_eq!(event.messages()[0].text(), "replaced");
}

#[test]
fn after_invocation_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let event = AfterInvocationEvent::new(&mut agent, InvocationState::new());
    assert_eq!(event.agent().id(), "agent-1");
    assert!(event.resume().is_none());
}

#[test]
fn allows_resume_to_be_set_to_new_input() {
    let mut agent = local_agent();
    let mut event = AfterInvocationEvent::new(&mut agent, InvocationState::new());
    event.set_resume("follow up");
    assert_eq!(event.resume(), Some(&InvokeArgs::Text("follow up".into())));
    event.clear_resume();
    assert!(event.resume().is_none());
}

#[test]
fn message_added_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let event = MessageAddedEvent::new(&mut agent, InvocationState::new(), message());
    assert_eq!(event.message(), &message());
}

#[test]
fn creates_instance_with_correct_properties_when_tool_is_found() {
    let tool: Arc<dyn Tool> = Arc::new(MockTool::new("test"));
    let event = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), Some(tool.clone()));
    assert_eq!(event.tool_use(), &tool_use());
    assert!(Arc::ptr_eq(event.tool().unwrap(), &tool));
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
    assert!(event.selected_tool().is_none());
    assert_eq!(event.agent().id(), "agent-1");
}

#[test]
fn creates_instance_with_undefined_tool_when_tool_is_not_found() {
    let event = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None);
    assert!(event.tool().is_none());
}

#[test]
fn before_tool_call_allows_cancel_to_be_set_to_true() {
    let mut event = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None);
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
    event.set_cancel(true);
    assert_eq!(event.cancel(), &Cancel::Cancelled);
}

#[test]
fn before_tool_call_allows_cancel_to_be_set_to_a_string_message() {
    let mut event = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None);
    event.set_cancel("tool not allowed");
    assert_eq!(event.cancel(), &Cancel::Message("tool not allowed".into()));
}

#[test]
fn allows_selected_tool_to_be_set_to_a_replacement_tool() {
    let mut event = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None);
    let replacement: Arc<dyn Tool> = Arc::new(MockTool::new("replacement"));
    event.set_selected_tool(replacement.clone());
    assert!(Arc::ptr_eq(event.selected_tool().unwrap(), &replacement));
}

#[test]
fn allows_mutating_tool_use_fields_in_place() {
    let mut event = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None);
    event.tool_use_mut().input = json!({"rewritten": true});
    event.tool_use_mut().name = "other".into();
    assert_eq!(event.tool_use().input, json!({"rewritten": true}));
    assert_eq!(event.tool_use().name, "other");
}

#[test]
fn allows_reassigning_tool_use_to_a_new_object() {
    let mut event = BeforeToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None);
    event.set_tool_use(ToolUse::new("new", "id-1", json!({"a": 1})));
    assert_eq!(event.tool_use(), &ToolUse::new("new", "id-1", json!({"a": 1})));
}

#[test]
fn after_tool_call_event_creates_instance_with_correct_properties_on_success() {
    let event = AfterToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None, result());
    assert_eq!(event.tool_use(), &tool_use());
    assert_eq!(event.result(), &result());
    assert!(event.error().is_none());
    assert!(!event.retry());
}

#[test]
fn allows_result_to_be_replaced() {
    let mut event = AfterToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None, result());
    event.set_result(ToolResultBlock::error(
        "id-1",
        vec![ToolResultContent::text("redacted")],
    ));
    assert_eq!(event.result().content, vec![ToolResultContent::text("redacted")]);
    event.result_mut().content.clear();
    assert!(event.result().content.is_empty());
}

#[test]
fn creates_instance_with_error_property_when_tool_execution_fails() {
    let failed = ToolResultBlock::error("id-1", vec![ToolResultContent::text("Error: boom")]).with_error("boom");
    let mut event = AfterToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None, failed);
    assert_eq!(event.error().unwrap().to_string(), "boom");
    event.set_result(result());
    assert_eq!(event.error().unwrap().to_string(), "boom");
}

#[test]
fn after_tool_call_allows_retry_to_be_set_when_error_is_present() {
    let failed = ToolResultBlock::error("id-1", vec![ToolResultContent::text("Error")]).with_error("Tool failed");
    let mut event = AfterToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None, failed);
    assert!(!event.retry());
    event.set_retry(true);
    assert!(event.retry());
    event.set_retry(false);
    assert!(!event.retry());
}

#[test]
fn after_tool_call_allows_retry_to_be_set_on_success() {
    let mut event = AfterToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None, result());
    assert!(!event.retry());
    event.set_retry(true);
    assert!(event.retry());
}

fn model() -> Arc<dyn Model> {
    Arc::new(crate::testing::MockModel::new())
}

#[test]
fn before_model_call_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let model = model();
    let event = BeforeModelCallEvent::new(&mut agent, InvocationState::new(), model.clone());
    assert!(Arc::ptr_eq(event.model(), &model));
    assert_eq!(event.projected_input_tokens(), None);
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
}

#[test]
fn includes_projected_input_tokens_when_provided() {
    let mut agent = local_agent();
    let event =
        BeforeModelCallEvent::new(&mut agent, InvocationState::new(), model()).with_projected_input_tokens(1234);
    assert_eq!(event.projected_input_tokens(), Some(1234));
    assert_eq!(
        record(&event),
        json!({"type": "beforeModelCallEvent", "projectedInputTokens": 1234})
    );
}

#[test]
fn excludes_projected_input_tokens_from_to_json_when_not_provided() {
    let mut agent = local_agent();
    let event = BeforeModelCallEvent::new(&mut agent, InvocationState::new(), model());
    assert_eq!(record(&event), json!({"type": "beforeModelCallEvent"}));
}

#[test]
fn before_model_call_allows_cancel_to_be_set_to_true() {
    let mut agent = local_agent();
    let mut event = BeforeModelCallEvent::new(&mut agent, InvocationState::new(), model());
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
    event.set_cancel(true);
    assert_eq!(event.cancel(), &Cancel::Cancelled);
}

#[test]
fn before_model_call_allows_cancel_to_be_set_to_a_string_message() {
    let mut agent = local_agent();
    let mut event = BeforeModelCallEvent::new(&mut agent, InvocationState::new(), model());
    event.set_cancel("rate limited");
    assert_eq!(event.cancel(), &Cancel::Message("rate limited".into()));
}

#[test]
fn after_model_call_event_creates_instance_with_correct_properties_on_success() {
    let mut agent = local_agent();
    let stop = ModelStopResponse::new(message(), StopReason::EndTurn);
    let event = AfterModelCallEvent::new(&mut agent, InvocationState::new(), model(), 1).with_stop_data(stop.clone());
    assert_eq!(event.stop_data(), Some(&stop));
    assert_eq!(event.attempt_count(), 1);
    assert!(event.error().is_none());
}

#[test]
fn creates_instance_with_error_property_when_model_invocation_fails() {
    let mut agent = local_agent();
    let mut event = AfterModelCallEvent::new(&mut agent, InvocationState::new(), model(), 2)
        .with_error(Error::other("model unavailable"));
    assert_eq!(
        event.error().map(ToString::to_string).as_deref(),
        Some("model unavailable")
    );
    assert!(event.stop_data().is_none());
    assert_eq!(
        event.take_error().map(|error| error.to_string()).as_deref(),
        Some("model unavailable")
    );
}

#[test]
fn allows_retry_to_be_set_when_error_is_present() {
    let mut agent = local_agent();
    let mut event = AfterModelCallEvent::new(&mut agent, InvocationState::new(), model(), 1)
        .with_error(Error::other("Model failed"));
    assert!(!event.retry());
    event.set_retry(true);
    assert!(event.retry());
    event.set_retry(false);
    assert!(!event.retry());
}

#[test]
fn retry_is_optional_and_defaults_to_undefined() {
    let mut agent = local_agent();
    let event = AfterModelCallEvent::new(&mut agent, InvocationState::new(), model(), 1);
    assert!(!event.retry());
}

#[test]
fn model_stream_update_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let event = ModelStreamUpdateEvent::new(&mut agent, InvocationState::new(), text_delta("Hi"));
    assert_eq!(event.event(), &text_delta("Hi"));
}

#[test]
fn content_block_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let event = ContentBlockEvent::new(&mut agent, InvocationState::new(), ContentBlock::text("test"));
    assert_eq!(event.content_block(), &ContentBlock::text("test"));
}

#[test]
fn model_message_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let event = ModelMessageEvent::new(&mut agent, InvocationState::new(), message(), StopReason::EndTurn);
    assert_eq!(event.message(), &message());
    assert_eq!(event.stop_reason(), StopReason::EndTurn);
}

#[test]
fn tool_result_event_creates_instance_with_correct_properties() {
    let event = ToolResultEvent::new(tool_agent(), InvocationState::new(), result());
    assert_eq!(event.result(), &result());
    assert_eq!(event.agent().id(), "agent-1");
}

#[test]
fn tool_stream_update_event_creates_instance_with_correct_properties() {
    let event = ToolStreamUpdateEvent::new(
        tool_agent(),
        InvocationState::new(),
        ToolStreamEvent::new(json!({"progress": 50})),
    );
    assert_eq!(event.event().data, Some(json!({"progress": 50})));
}

#[test]
fn agent_result_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let result = AgentResult::new(StopReason::EndTurn, message()).with_metrics(AgentMetrics::new());
    let event = AgentResultEvent::new(&mut agent, InvocationState::new(), result);
    assert_eq!(event.result().stop_reason(), StopReason::EndTurn);
}

#[test]
fn before_tools_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let event = BeforeToolsEvent::new(&mut agent, InvocationState::new(), message());
    assert_eq!(event.message(), &message());
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
}

#[test]
fn before_tools_allows_cancel_to_be_set_to_true() {
    let mut agent = local_agent();
    let mut event = BeforeToolsEvent::new(&mut agent, InvocationState::new(), message());
    assert_eq!(event.cancel(), &Cancel::NotCancelled);
    event.set_cancel(true);
    assert_eq!(event.cancel(), &Cancel::Cancelled);
}

#[test]
fn before_tools_allows_cancel_to_be_set_to_a_string_message() {
    let mut agent = local_agent();
    let mut event = BeforeToolsEvent::new(&mut agent, InvocationState::new(), message());
    event.set_cancel("tools not allowed");
    assert_eq!(event.cancel(), &Cancel::Message("tools not allowed".into()));
}

#[test]
fn before_tools_interrupt_uses_the_batch_scoped_id() {
    let mut agent = local_agent();
    let mut event = BeforeToolsEvent::new(&mut agent, InvocationState::new(), message());
    let error = event.interrupt("approve").unwrap_err();
    let interrupt = &error.interrupts[0];
    assert_eq!(interrupt.id, "hook:beforeTools:approve");
    assert_eq!(interrupt.source, InterruptSource::Hook);
    assert_eq!(event.take_interrupts(), error.interrupts);
}

#[test]
fn after_tools_event_creates_instance_with_correct_properties() {
    let mut agent = local_agent();
    let event = AfterToolsEvent::new(&mut agent, InvocationState::new(), message());
    assert_eq!(event.message(), &message());
}

#[test]
fn defaults_end_turn_to_false() {
    let mut agent = local_agent();
    let mut event = AfterToolsEvent::new(&mut agent, InvocationState::new(), message());
    assert_eq!(event.end_turn(), &EndTurn::Continue);
    event.set_end_turn(vec![ContentBlock::text("done")]);
    assert_eq!(event.end_turn(), &EndTurn::Content(vec![ContentBlock::text("done")]));
    event.set_end_turn(true);
    assert!(event.end_turn().is_end());
}

#[test]
fn interrupt_event_carries_the_interrupt() {
    let mut agent = local_agent();
    let interrupt = Interrupt::new("tool:t:x", "x").with_source(InterruptSource::Tool);
    let event = InterruptEvent::new(&mut agent, InvocationState::new(), interrupt.clone());
    assert_eq!(event.interrupt(), &interrupt);
}

#[test]
fn initialized_event_excludes_agent_and_returns_only_type() {
    let mut agent = local_agent();
    let event = InitializedEvent::new(&mut agent);
    let data = crate::hooks::InitializedEventData::from(&event);
    assert_eq!(serde_json::to_value(data).unwrap(), json!({"type": "initializedEvent"}));
}

#[test]
fn before_invocation_event_excludes_agent_invocation_state_and_messages() {
    let mut agent = local_agent();
    let event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), vec![message()]);
    assert_eq!(record(&event), json!({"type": "beforeInvocationEvent"}));
}

#[test]
fn after_invocation_event_excludes_agent_and_returns_only_type() {
    let mut agent = local_agent();
    let mut event = AfterInvocationEvent::new(&mut agent, InvocationState::new());
    event.set_resume("again");
    assert_eq!(record(&event), json!({"type": "afterInvocationEvent"}));
}

#[test]
fn message_added_event_includes_message_and_excludes_agent() {
    let mut agent = local_agent();
    let event = MessageAddedEvent::new(&mut agent, InvocationState::new(), message());
    assert_eq!(
        record(&event),
        json!({"type": "messageAddedEvent", "message": message()})
    );
}

#[test]
fn model_stream_update_event_includes_stream_event_and_excludes_agent() {
    let mut agent = local_agent();
    let event = ModelStreamUpdateEvent::new(&mut agent, InvocationState::new(), text_delta("Hi"));
    assert_eq!(
        record(&event),
        json!({"type": "modelStreamUpdateEvent", "event": {"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hi"}}})
    );
}

#[test]
fn content_block_event_includes_content_block_and_excludes_agent() {
    let mut agent = local_agent();
    let event = ContentBlockEvent::new(&mut agent, InvocationState::new(), ContentBlock::text("test"));
    assert_eq!(
        record(&event),
        json!({"type": "contentBlockEvent", "contentBlock": {"text": "test"}})
    );
}

#[test]
fn model_message_event_includes_message_and_stop_reason_excludes_agent() {
    let mut agent = local_agent();
    let event = ModelMessageEvent::new(&mut agent, InvocationState::new(), message(), StopReason::EndTurn);
    assert_eq!(
        record(&event),
        json!({"type": "modelMessageEvent", "message": message(), "stopReason": "endTurn"})
    );
}

#[test]
fn tool_result_event_includes_result_and_excludes_agent() {
    let event = ToolResultEvent::new(tool_agent(), InvocationState::new(), result());
    assert_eq!(
        record(&event),
        json!({"type": "toolResultEvent", "result": {"toolResult": {"toolUseId": "id-1", "status": "success", "content": [{"text": "ok"}]}}})
    );
}

#[test]
fn tool_stream_update_event_includes_tool_stream_event_and_excludes_agent() {
    let event = ToolStreamUpdateEvent::new(
        tool_agent(),
        InvocationState::new(),
        ToolStreamEvent::new(json!({"progress": 50})),
    );
    assert_eq!(
        record(&event),
        json!({"type": "toolStreamUpdateEvent", "event": {"type": "toolStreamEvent", "data": {"progress": 50}}})
    );
}

#[test]
fn agent_result_event_includes_result_and_excludes_agent() {
    let mut agent = local_agent();
    let result = AgentResult::new(StopReason::EndTurn, message()).with_metrics(AgentMetrics::new());
    let event = AgentResultEvent::new(&mut agent, InvocationState::new(), result);
    assert_eq!(
        record(&event),
        json!({"type": "agentResultEvent", "result": {"type": "agentResult", "stopReason": "endTurn", "lastMessage": message()}})
    );
}

#[test]
fn before_tool_call_event_includes_tool_use_and_excludes_agent_tool_and_cancel() {
    let mut event = BeforeToolCallEvent::new(
        tool_agent(),
        InvocationState::new(),
        tool_use(),
        Some(Arc::new(MockTool::new("test"))),
    );
    event.set_cancel(true);
    assert_eq!(
        record(&event),
        json!({"type": "beforeToolCallEvent", "toolUse": {"name": "test", "toolUseId": "id-1", "input": {}}})
    );
}

#[test]
fn after_tool_call_event_includes_tool_use_and_result_excludes_agent_and_tool_on_success() {
    let event = AfterToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use(), None, result());
    assert_eq!(
        record(&event),
        json!({
            "type": "afterToolCallEvent",
            "toolUse": {"name": "test", "toolUseId": "id-1", "input": {}},
            "result": {"toolResult": {"toolUseId": "id-1", "status": "success", "content": [{"text": "ok"}]}}
        })
    );
}

#[test]
fn after_tool_call_converts_error_to_message_string_and_excludes_retry() {
    let failed = ToolResultBlock::error("id-1", vec![ToolResultContent::text("Error")]).with_error("Tool crashed");
    let tool_use = ToolUse::new("calc", "id-1", json!({}));
    let mut event = AfterToolCallEvent::new(tool_agent(), InvocationState::new(), tool_use, None, failed);
    event.set_retry(true);
    assert_eq!(
        record(&event),
        json!({
            "type": "afterToolCallEvent",
            "toolUse": {"name": "calc", "toolUseId": "id-1", "input": {}},
            "result": {"toolResult": {"toolUseId": "id-1", "status": "error", "content": [{"text": "Error"}]}},
            "error": {"message": "Tool crashed"}
        })
    );
}

#[test]
fn after_model_call_includes_stop_data_and_attempt_count_and_excludes_agent_and_model_on_success() {
    let mut agent = local_agent();
    let event = AfterModelCallEvent::new(&mut agent, InvocationState::new(), model(), 1)
        .with_stop_data(ModelStopResponse::new(message(), StopReason::EndTurn));
    assert_eq!(
        record(&event),
        json!({"type": "afterModelCallEvent", "attemptCount": 1, "stopData": {"message": message(), "stopReason": "endTurn"}})
    );
}

#[test]
fn after_model_call_converts_error_to_message_string_and_excludes_retry() {
    let mut agent = local_agent();
    let mut event = AfterModelCallEvent::new(&mut agent, InvocationState::new(), model(), 2)
        .with_error(Error::other("model unavailable"));
    event.set_retry(true);
    assert_eq!(
        record(&event),
        json!({"type": "afterModelCallEvent", "attemptCount": 2, "error": {"message": "model unavailable"}})
    );
}

#[test]
fn before_tools_event_includes_message_and_excludes_agent_and_cancel() {
    let mut agent = local_agent();
    let mut event = BeforeToolsEvent::new(&mut agent, InvocationState::new(), message());
    event.set_cancel(true);
    assert_eq!(
        record(&event),
        json!({"type": "beforeToolsEvent", "message": message()})
    );
}

#[test]
fn after_tools_event_includes_message_and_excludes_agent() {
    let mut agent = local_agent();
    let mut event = AfterToolsEvent::new(&mut agent, InvocationState::new(), message());
    event.set_end_turn(true);
    assert_eq!(record(&event), json!({"type": "afterToolsEvent", "message": message()}));
}

#[test]
fn json_stringify_output_never_contains_agent_properties() {
    let mut agent = local_agent();
    agent.messages_mut().push(Message::user("Hello ".repeat(100)));
    let event = ModelStreamUpdateEvent::new(&mut agent, InvocationState::new(), text_delta("Hi"));
    let json = serde_json::to_string(&AgentStreamEvent::from(&event)).unwrap();
    assert!(json.len() < 200);
    assert!(!json.contains("Hello Hello") && !json.contains("appState") && !json.contains("toolRegistry"));
}

#[test]
fn text_delta_reads_text_deltas_only() {
    let mut agent = local_agent();
    let event = ModelStreamUpdateEvent::new(&mut agent, InvocationState::new(), text_delta("Hi"));
    let AgentStreamEvent::ModelStreamUpdate(data) = AgentStreamEvent::from(&event) else {
        panic!("expected a model stream update");
    };
    assert_eq!(data.text_delta(), Some("Hi"));
    let other = crate::hooks::ModelStreamUpdateEventData::new(ModelStreamEvent::ContentBlockStop(
        crate::models::streaming::ModelContentBlockStopEvent::new(),
    ));
    assert_eq!(other.text_delta(), None);
}

/// Event fields that never reach the record, including the crate-internal fields the loop reads
/// back.
const EXCLUDED_FIELDS: [&str; 14] = [
    "agent",
    "invocation_state",
    "invocation_context",
    "model",
    "tool",
    "cancel",
    "retry",
    "messages",
    "selected_tool",
    "resume",
    "end_turn",
    "continuation_inputs",
    "raised_interrupts",
    "interrupts",
];

/// Fields the record carries in another shape.
const TRANSFORMED_FIELDS: [&str; 1] = ["error"];

/// The names of every field of an event, through exhaustive destructuring: a new field fails to
/// compile until it is listed here and classified by the completeness tests.
macro_rules! fields {
    ($event:expr, $ty:ident { $($field:ident),* $(,)? }) => {{
        let $ty { $($field: _),* } = $event;
        vec![$(stringify!($field)),*]
    }};
}

fn sequential_fields(base: &Sequential<'_>) -> Vec<&'static str> {
    fields!(
        base,
        Sequential {
            agent,
            invocation_state,
            invocation_context
        }
    )
}

fn per_tool_fields(base: &PerTool) -> Vec<&'static str> {
    fields!(
        base,
        PerTool {
            agent,
            invocation_state,
            invocation_context
        }
    )
}

fn with_base(mut fields: Vec<&'static str>, base: Vec<&'static str>) -> Vec<&'static str> {
    fields.retain(|field| *field != "base");
    fields.extend(base);
    fields
}

fn camel_case(field: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for character in field.chars() {
        if character == '_' {
            upper = true;
        } else if upper {
            out.push(character.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    out
}

/// Records one event: its name, every field name (the base's fields in place of `base`) and its
/// record.
macro_rules! instance {
    ($instances:ident, $event:expr, $base:ident, $ty:ident { $($field:ident),* $(,)? }) => {{
        let event = $event;
        let fields = with_base(fields!(&event, $ty { $($field),* }), $base(&event.base));
        $instances.push((stringify!($ty), fields, record(&event)));
    }};
}

/// A fully populated instance of every event: its name, field names and record.
fn event_instances() -> Vec<(&'static str, Vec<&'static str>, JsonValue)> {
    let tool: Arc<dyn Tool> = Arc::new(MockTool::new("test"));
    let failed = ToolResultBlock::error("id-1", vec![ToolResultContent::text("Error")]).with_error("test error");
    let stop_data = ModelStopResponse::new(message(), StopReason::EndTurn);
    let agent_result = AgentResult::new(StopReason::EndTurn, message()).with_metrics(AgentMetrics::new());
    let state = InvocationState::new;
    let mut instances = Vec::new();
    let mut agent = local_agent();

    let event = InitializedEvent::new(&mut agent);
    let fields = fields!(&event, InitializedEvent { agent });
    let json = serde_json::to_value(crate::hooks::InitializedEventData::from(&event)).unwrap();
    instances.push(("InitializedEvent", fields, json));

    let seq = sequential_fields;
    let tool_fields = per_tool_fields;
    instance!(
        instances,
        BeforeInvocationEvent::new(&mut agent, state(), vec![message()]),
        seq,
        BeforeInvocationEvent { base, messages, cancel }
    );
    instance!(
        instances,
        AfterInvocationEvent::new(&mut agent, state()),
        seq,
        AfterInvocationEvent {
            base,
            resume,
            continuation_inputs
        }
    );
    instance!(
        instances,
        BeforeModelCallEvent::new(&mut agent, state(), model()).with_projected_input_tokens(100),
        seq,
        BeforeModelCallEvent {
            base,
            model,
            projected_input_tokens,
            cancel,
            continuation_inputs,
            raised_interrupts
        }
    );
    let mut after_model = AfterModelCallEvent::new(&mut agent, state(), model(), 1)
        .with_stop_data(stop_data)
        .with_error(Error::other("test error"));
    after_model.set_retry(true);
    instance!(
        instances,
        after_model,
        seq,
        AfterModelCallEvent {
            base,
            model,
            attempt_count,
            stop_data,
            error,
            retry
        }
    );
    instance!(
        instances,
        MessageAddedEvent::new(&mut agent, state(), message()),
        seq,
        MessageAddedEvent { base, message }
    );
    instance!(
        instances,
        ModelStreamUpdateEvent::new(&mut agent, state(), text_delta("Hi")),
        seq,
        ModelStreamUpdateEvent { base, event }
    );
    instance!(
        instances,
        ContentBlockEvent::new(&mut agent, state(), ContentBlock::text("test")),
        seq,
        ContentBlockEvent { base, content_block }
    );
    instance!(
        instances,
        ModelMessageEvent::new(&mut agent, state(), message(), StopReason::EndTurn),
        seq,
        ModelMessageEvent {
            base,
            message,
            stop_reason
        }
    );
    instance!(
        instances,
        ToolResultEvent::new(tool_agent(), state(), result()),
        tool_fields,
        ToolResultEvent { base, result }
    );
    let progress = ToolStreamEvent::new(json!({"progress": 50}));
    instance!(
        instances,
        ToolStreamUpdateEvent::new(tool_agent(), state(), progress),
        tool_fields,
        ToolStreamUpdateEvent { base, event }
    );
    instance!(
        instances,
        AgentResultEvent::new(&mut agent, state(), agent_result),
        seq,
        AgentResultEvent { base, result }
    );
    instance!(
        instances,
        BeforeToolCallEvent::new(tool_agent(), state(), tool_use(), Some(tool.clone())),
        tool_fields,
        BeforeToolCallEvent {
            base,
            tool_use,
            tool,
            cancel,
            selected_tool,
            interrupts
        }
    );
    let mut after_tool = AfterToolCallEvent::new(tool_agent(), state(), tool_use(), Some(tool), failed);
    after_tool.set_retry(true);
    instance!(
        instances,
        after_tool,
        tool_fields,
        AfterToolCallEvent {
            base,
            tool_use,
            tool,
            result,
            error,
            retry
        }
    );
    instance!(
        instances,
        BeforeToolsEvent::new(&mut agent, state(), message()),
        seq,
        BeforeToolsEvent {
            base,
            message,
            cancel,
            interrupts
        }
    );
    instance!(
        instances,
        AfterToolsEvent::new(&mut agent, state(), message()),
        seq,
        AfterToolsEvent {
            base,
            message,
            end_turn
        }
    );
    instance!(
        instances,
        InterruptEvent::new(&mut agent, state(), Interrupt::new("hook:x", "x")),
        seq,
        InterruptEvent { base, interrupt }
    );
    instances
}

#[test]
fn to_json_includes_all_fields_except_known_exclusions() {
    for (name, fields, json) in event_instances() {
        let keys: Vec<&String> = json.as_object().unwrap().keys().filter(|key| *key != "type").collect();
        for field in &fields {
            let key = camel_case(field);
            let serialized = keys.iter().any(|candidate| **candidate == key);
            if EXCLUDED_FIELDS.contains(field) {
                assert!(!serialized, "{name}: excluded field `{field}` is serialized");
            } else {
                assert!(
                    serialized || TRANSFORMED_FIELDS.contains(field),
                    "{name}: field `{field}` is neither serialized nor excluded"
                );
            }
        }
        for key in keys {
            assert!(
                fields.iter().any(|field| camel_case(field) == *key),
                "{name}: record key `{key}` comes from no field"
            );
        }
    }
}

#[test]
fn to_json_never_includes_agent() {
    for (name, _, json) in event_instances() {
        assert!(json.get("agent").is_none(), "{name}");
    }
}
