//! The agent's spans. They export through the SDK's layer to an in-memory exporter, and the checks
//! read the finished spans. A disabled span stands in for a span whose start failed.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use futures::future::BoxFuture;
use opentelemetry::Context;
use opentelemetry::baggage::{Baggage, BaggageExt};
use opentelemetry::trace::{FutureExt as _, SpanId, Status};
use opentelemetry_sdk::trace::SpanData;
use serde_json::json;
use tracing::Instrument;

use crate::hooks::{AfterInvocationEvent, AfterToolsEvent, BeforeToolCallEvent, MessageAddedEvent};
use crate::middleware::InvokeModelStage;
use crate::models::Model;
use crate::models::streaming::Usage;
use crate::retry::{
    ConstantBackoff, ConstantBackoffOptions, DefaultModelRetryStrategy, DefaultModelRetryStrategyOptions, RetryStrategy,
};
use crate::telemetry::AgentTrace;
use crate::telemetry::test_support::{
    attr, attr_i64, attr_str, capture_spans, capture_spans_except, capture_spans_with_baggage, event_attr, events,
    exceptions, is_error,
};
use crate::telemetry::tracer::Tracer;
use crate::telemetry::utils::TracerSettings;
use crate::test_support::MockTool;
use crate::testing::{MockModel, MockTurn};
use crate::tools::{Tool, ToolContext, ToolExecutorStrategy, ToolStream, create_error_result};
use crate::types::{ContentBlock, ToolResultBlock, ToolResultContent, ToolSpec, ToolUseBlock};
use crate::{Agent, AgentStreamEvent, CancelOptions, Error, StopReason, ToolOutcome, ToolSource};

fn agent(model: MockModel) -> Agent {
    Agent::builder().model(model).printer(false).build().unwrap()
}

fn tool_turn(name: &str, id: &str, input: serde_json::Value) -> MockTurn {
    MockTurn::content([ToolUseBlock::new(name, id, input)])
}

fn ok_tool(name: &str, text: &'static str) -> MockTool {
    MockTool::new(name).with_result(move |context| {
        ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text(text)],
        )
        .into()
    })
}

fn tool_agent(model: MockModel, tools: Vec<ToolSource>) -> Agent {
    Agent::builder()
        .model(model)
        .tools(tools)
        .printer(false)
        .build()
        .unwrap()
}

const AGENT_SPAN: &str = "invoke_agent Strands Agent";
const LOOP_SPAN: &str = "execute_agent_loop_cycle";

/// A tool backed by an async closure.
struct FnTool {
    name: String,
    run: Arc<dyn Fn(ToolContext) -> BoxFuture<'static, ToolOutcome> + Send + Sync>,
}

impl FnTool {
    fn new(name: &str, run: impl Fn(ToolContext) -> BoxFuture<'static, ToolOutcome> + Send + Sync + 'static) -> Self {
        Self {
            name: name.to_owned(),
            run: Arc::new(run),
        }
    }
}

impl Tool for FnTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "test tool"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new(&self.name, "test tool").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        ToolStream::from_future((self.run)(context))
    }
}

fn empty_result(context: &ToolContext) -> ToolOutcome {
    ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into()
}

#[tokio::test]
async fn initializes_tracer_with_trace_attributes_from_config() {
    let capture = capture_spans();
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .printer(false)
        .trace_attributes([("custom.attr", "value")])
        .build()
        .unwrap();
    agent.invoke("Hi").await.unwrap();
    for name in [AGENT_SPAN, LOOP_SPAN, "chat"] {
        assert_eq!(
            attr_str(&capture.span(name), "custom.attr").as_deref(),
            Some("value"),
            "{name}"
        );
    }
}

#[tokio::test]
async fn initializes_tracer_without_trace_attributes_when_not_provided() {
    let capture = capture_spans();
    let mut agent = agent(MockModel::new().with_turn("Hello"));
    agent.invoke("Hi").await.unwrap();
    assert!(attr(&capture.span(AGENT_SPAN), "custom.attr").is_none());
}

#[tokio::test]
async fn defaults_name_to_strands_agent_and_id_to_agent() {
    let capture = capture_spans();
    let mut agent = agent(MockModel::new().with_turn("Hello"));
    assert_eq!(agent.name(), "Strands Agent");
    assert_eq!(agent.id(), "agent");
    agent.invoke("Hi").await.unwrap();
    let span = capture.span(AGENT_SPAN);
    assert_eq!(attr_str(&span, "gen_ai.agent.name").as_deref(), Some("Strands Agent"));
    assert_eq!(attr_str(&span, "gen_ai.agent.id").as_deref(), Some("agent"));
}

#[test]
fn uses_provided_name() {
    let agent = Agent::builder()
        .model(MockModel::new())
        .name("My Agent")
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.name(), "My Agent");
}

#[test]
fn uses_provided_id() {
    let agent = Agent::builder()
        .model(MockModel::new())
        .id("custom-id-123")
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.id(), "custom-id-123");
}

#[tokio::test]
async fn starts_and_ends_agent_span_on_successful_invocation() {
    let capture = capture_spans();
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .name("TestAgent")
        .id("test-id")
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("Hi").await.unwrap();
    let span = capture.span("invoke_agent TestAgent");
    assert_eq!(attr_str(&span, "gen_ai.agent.name").as_deref(), Some("TestAgent"));
    assert_eq!(attr_str(&span, "gen_ai.agent.id").as_deref(), Some("test-id"));
    assert_eq!(attr_str(&span, "gen_ai.request.model").as_deref(), Some("test-model"));
    assert_eq!(span.status, Status::Ok);
    assert_eq!(
        event_attr(&events(&span, "gen_ai.user.message")[0], "content"),
        r#"[{"text":"Hi"}]"#
    );
    let choice = &events(&span, "gen_ai.choice")[0];
    assert_eq!(event_attr(choice, "message"), "Hello");
    assert_eq!(event_attr(choice, "finish_reason"), "endTurn");
}

fn max_tokens_model() -> MockModel {
    MockModel::new().with_turn(MockTurn::text("Partial").with_stop_reason(StopReason::MaxTokens))
}

#[tokio::test]
async fn ends_agent_span_with_error_when_invocation_fails() {
    let capture = capture_spans();
    let mut agent = agent(max_tokens_model());
    let error = agent.invoke("Hi").await.unwrap_err();
    assert!(matches!(error, Error::MaxTokens(_)));
    let span = capture.span(AGENT_SPAN);
    assert!(is_error(&span, &error.to_string()));
    assert_eq!(exceptions(&span), vec![error.to_string()]);
}

async fn agent_span_system_prompt(prompt: Option<&str>) -> Option<String> {
    let capture = capture_spans();
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .maybe_system_prompt(prompt)
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("Hi").await.unwrap();
    attr_str(&capture.span(AGENT_SPAN), "system_prompt")
}

#[tokio::test]
async fn includes_system_prompt_in_agent_span_when_configured() {
    assert_eq!(
        agent_span_system_prompt(Some("Be helpful")).await.as_deref(),
        Some(r#""Be helpful""#)
    );
}

#[tokio::test]
async fn includes_empty_string_system_prompt_in_agent_span() {
    assert_eq!(agent_span_system_prompt(Some("")).await.as_deref(), Some(r#""""#));
}

#[tokio::test]
async fn omits_system_prompt_from_agent_span_when_not_configured() {
    assert_eq!(agent_span_system_prompt(None).await, None);
}

/// Records tool definitions, as `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_tool_definitions` does.
fn record_tool_definitions(agent: &mut Agent) {
    let settings = TracerSettings::from_lookup(&|key| {
        (key == "OTEL_SEMCONV_STABILITY_OPT_IN").then(|| "gen_ai_tool_definitions".to_owned())
    });
    agent
        .local_mut()
        .set_tracer(Tracer::with_settings(settings, BTreeMap::new(), BTreeMap::new()));
}

#[tokio::test]
async fn includes_tools_in_agent_span() {
    let capture = capture_spans();
    let tool = ok_tool("myTool", "");
    let spec = serde_json::to_value(tool.tool_spec()).unwrap();
    let mut agent = tool_agent(MockModel::new().with_turn("Hello"), vec![tool.into()]);
    record_tool_definitions(&mut agent);
    agent.invoke("Hi").await.unwrap();
    let span = capture.span(AGENT_SPAN);
    assert_eq!(attr_str(&span, "gen_ai.agent.tools").as_deref(), Some(r#"["myTool"]"#));
    let definitions: serde_json::Value =
        serde_json::from_str(&attr_str(&span, "gen_ai.tool.definitions").unwrap()).unwrap();
    assert_eq!(definitions[0]["name"], json!("myTool"));
    assert_eq!(definitions[0]["inputSchema"], spec["inputSchema"]);
}

#[tokio::test]
async fn omits_tools_config_from_agent_span_when_agent_has_no_tools() {
    let capture = capture_spans();
    let mut agent = agent(MockModel::new().with_turn("Hello"));
    record_tool_definitions(&mut agent);
    agent.invoke("Hi").await.unwrap();
    assert!(attr_str(&capture.span(AGENT_SPAN), "gen_ai.tool.definitions").is_none());
}

#[tokio::test(start_paused = true)]
async fn ends_the_loop_span_once_when_the_public_stream_iterator_is_closed_mid_cycle() {
    let capture = capture_spans();
    let mut agent = agent(MockModel::new().with_turn("Done"));
    {
        let mut stream = agent.stream("Hi");
        while let Some(event) = stream.next().await {
            if matches!(event.unwrap(), AgentStreamEvent::MessageAdded(_)) {
                tokio::time::advance(std::time::Duration::from_millis(60)).await;
                break;
            }
        }
    }
    assert!(capture.named("chat").is_empty());
    assert_eq!(capture.span(LOOP_SPAN).status, Status::Ok);
    assert_eq!(capture.span(AGENT_SPAN).status, Status::Ok);
    let metrics = agent.metrics();
    assert_eq!(metrics.total_duration, 60);
    assert_eq!(metrics.latest_agent_invocation().unwrap().cycles[0].duration, 60);
}

#[tokio::test]
async fn ends_the_loop_span_once_when_the_consumer_cancels_and_breaks_during_model_streaming() {
    let capture = capture_spans();
    let mut agent = agent(MockModel::new().with_turn("Done"));
    let handle = agent.cancel_handle();
    {
        let mut stream = agent.stream("Hi");
        while let Some(event) = stream.next().await {
            if matches!(event.unwrap(), AgentStreamEvent::ModelStreamUpdate(_)) {
                handle.cancel(CancelOptions::default());
                break;
            }
        }
    }
    assert_eq!(capture.named(LOOP_SPAN).len(), 1);
    assert_eq!(capture.named("chat").len(), 1);
}

#[tokio::test]
async fn closes_cycle_telemetry_for_every_started_cycle_when_the_consumer_breaks_during_tool_execution() {
    let capture = capture_spans();
    let model = MockModel::new()
        .with_turn(tool_turn("testTool", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = tool_agent(model, vec![ok_tool("testTool", "Result").into()]);
    {
        let mut stream = agent.stream("Hi");
        while let Some(event) = stream.next().await {
            if matches!(event.unwrap(), AgentStreamEvent::ToolResult(_)) {
                break;
            }
        }
    }
    let started = usize::try_from(agent.metrics().cycle_count).unwrap();
    assert_eq!(capture.named(LOOP_SPAN).len(), started);
    assert_eq!(capture.named("execute_tool testTool").len(), 1);
}

#[tokio::test]
async fn closes_cycle_telemetry_once_when_an_error_is_thrown_after_the_cycle_already_closed() {
    let capture = capture_spans();
    let mut agent = tool_agent(
        MockModel::new().with_turn(tool_turn("testTool", "tool-1", json!({}))),
        vec![ok_tool("testTool", "Result").into()],
    );
    agent.add_hook(|event: &mut AfterToolsEvent<'_>| event.set_end_turn(true));
    agent.add_hook(|event: &mut MessageAddedEvent<'_>| -> Result<(), String> {
        let ends_turn = event
            .message()
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Text(text) if text.text.contains("Turn ended early")));
        if ends_turn {
            return Err("append failed after cycle close".into());
        }
        Ok(())
    });
    let error = agent.invoke("Hi").await.unwrap_err();
    assert_eq!(error.to_string(), "append failed after cycle close");
    assert_eq!(capture.span(LOOP_SPAN).status, Status::Ok);
    assert!(is_error(&capture.span(AGENT_SPAN), "append failed after cycle close"));
}

fn cycle_ids(capture: &crate::telemetry::test_support::SpanCapture) -> Vec<String> {
    let mut spans = capture.named(LOOP_SPAN);
    spans.sort_by_key(|span| span.start_time);
    spans
        .iter()
        .map(|span| attr_str(span, "agent_loop.cycle_id").unwrap())
        .collect()
}

#[tokio::test]
async fn starts_and_ends_loop_span_for_each_cycle() {
    let capture = capture_spans();
    agent(MockModel::new().with_turn("Done")).invoke("Hi").await.unwrap();
    assert_eq!(cycle_ids(&capture), ["cycle-1"]);
    assert_eq!(capture.span(LOOP_SPAN).status, Status::Ok);
}

fn tool_then_done() -> MockModel {
    MockModel::new()
        .with_turn(tool_turn("testTool", "tool-1", json!({"key": "val"})))
        .with_turn("Done")
}

#[tokio::test]
async fn creates_multiple_loop_spans_for_multi_cycle_invocations() {
    let capture = capture_spans();
    let mut agent = tool_agent(tool_then_done(), vec![ok_tool("testTool", "Result").into()]);
    agent.invoke("Use tool").await.unwrap();
    assert_eq!(cycle_ids(&capture), ["cycle-1", "cycle-2"]);
    let agent_span = capture.span(AGENT_SPAN);
    assert!(
        capture
            .named(LOOP_SPAN)
            .iter()
            .all(|span| span.parent_span_id == agent_span.span_context.span_id())
    );
}

#[tokio::test]
async fn ends_loop_span_with_error_when_cycle_fails() {
    let capture = capture_spans();
    let error = agent(max_tokens_model()).invoke("Hi").await.unwrap_err();
    assert!(is_error(&capture.span(LOOP_SPAN), &error.to_string()));
}

fn value_schema() -> serde_json::Value {
    json!({"type": "object", "properties": {"value": {"type": "number"}}, "required": ["value"]})
}

fn structured_agent(model: MockModel, schema: serde_json::Value) -> Agent {
    Agent::builder()
        .model(model)
        .structured_output_schema_json(schema)
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn ends_loop_span_for_cycle_where_structured_output_forces_tool_choice() {
    let capture = capture_spans();
    let model = MockModel::new().with_turn("First response").with_turn(tool_turn(
        "strands_structured_output",
        "tool-1",
        json!({"value": 42}),
    ));
    structured_agent(model, value_schema()).invoke("Test").await.unwrap();
    assert_eq!(cycle_ids(&capture), ["cycle-1", "cycle-2"]);
}

#[tokio::test]
async fn ends_the_model_invoke_span_once_when_the_consumer_breaks_mid_model_response() {
    let capture = capture_spans();
    let mut agent = agent(MockModel::new().with_turn("Hello"));
    {
        let mut stream = agent.stream("Hi");
        while let Some(event) = stream.next().await {
            if matches!(event.unwrap(), AgentStreamEvent::ModelStreamUpdate(_)) {
                break;
            }
        }
    }
    let span = capture.span("chat");
    assert_eq!(span.status, Status::Ok);
    assert!(events(&span, "gen_ai.choice").is_empty());
}

#[tokio::test]
async fn starts_and_ends_model_span_on_successful_model_call() {
    let capture = capture_spans();
    agent(MockModel::new().with_turn("Hello")).invoke("Hi").await.unwrap();
    let span = capture.span("chat");
    assert_eq!(attr_str(&span, "gen_ai.request.model").as_deref(), Some("test-model"));
    let choice = &events(&span, "gen_ai.choice")[0];
    assert_eq!(event_attr(choice, "finish_reason"), "endTurn");
    assert_eq!(event_attr(choice, "message"), r#"[{"text":"Hello"}]"#);
    assert_eq!(span.parent_span_id, capture.span(LOOP_SPAN).span_context.span_id());
}

#[tokio::test]
async fn ends_model_span_with_error_when_model_call_fails() {
    let capture = capture_spans();
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("Model failed")));
    let mut agent = Agent::builder()
        .model(model)
        .retry_strategy(Vec::new())
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("Hi").await.unwrap_err();
    assert!(is_error(&capture.span("chat"), "Model failed"));
}

#[tokio::test]
async fn creates_model_span_for_each_model_call_in_multi_cycle_invocation() {
    let capture = capture_spans();
    let mut agent = tool_agent(tool_then_done(), vec![ok_tool("testTool", "Result").into()]);
    agent.invoke("Use tool").await.unwrap();
    assert_eq!(capture.named("chat").len(), 2);
}

#[tokio::test]
async fn model_span_records_post_middleware_context_when_invoke_model_stage_middleware_transforms_input() {
    let capture = capture_spans();
    let selected = MockModel::new().with_turn("Selected response");
    selected
        .update_config(
            crate::models::BaseModelConfig::builder()
                .model_id("selected-model")
                .build(),
        )
        .unwrap();
    let selected: Arc<dyn Model> = Arc::new(selected);
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Default response"))
        .system_prompt("Original prompt")
        .printer(false)
        .build()
        .unwrap();
    agent.add_middleware(InvokeModelStage::input(move |mut context| {
        let model = selected.clone();
        async move {
            context.model = model;
            context.system_prompt = Some("Transformed prompt".into());
            Ok(context)
        }
    }));
    agent.invoke("Hi").await.unwrap();
    let span = capture.span("chat");
    assert_eq!(
        attr_str(&span, "gen_ai.request.model").as_deref(),
        Some("selected-model")
    );
    assert_eq!(
        event_attr(&events(&span, "gen_ai.system.message")[0], "content"),
        r#"[{"text":"Transformed prompt"}]"#
    );
}

#[tokio::test]
async fn starts_and_ends_tool_span_for_each_tool_execution() {
    let capture = capture_spans();
    let mut agent = tool_agent(tool_then_done(), vec![ok_tool("testTool", "Result").into()]);
    agent.invoke("Use tool").await.unwrap();
    let span = capture.span("execute_tool testTool");
    assert_eq!(attr_str(&span, "gen_ai.tool.name").as_deref(), Some("testTool"));
    assert_eq!(attr_str(&span, "gen_ai.tool.call.id").as_deref(), Some("tool-1"));
    assert_eq!(
        event_attr(&events(&span, "gen_ai.tool.message")[0], "content"),
        r#"{"key":"val"}"#
    );
    assert_eq!(attr_str(&span, "gen_ai.tool.status").as_deref(), Some("success"));
    assert_eq!(span.status, Status::Ok);
    let cycle = capture
        .named(LOOP_SPAN)
        .into_iter()
        .find(|cycle| attr_str(cycle, "agent_loop.cycle_id").as_deref() == Some("cycle-1"))
        .unwrap();
    assert_eq!(span.parent_span_id, cycle.span_context.span_id());
}

#[tokio::test]
async fn ends_tool_span_with_error_when_tool_is_not_found() {
    let capture = capture_spans();
    let model = MockModel::new()
        .with_turn(tool_turn("missingTool", "tool-1", json!({})))
        .with_turn("Done");
    agent(model).invoke("Use tool").await.unwrap();
    let span = capture.span("execute_tool missingTool");
    assert_eq!(attr_str(&span, "gen_ai.tool.status").as_deref(), Some("error"));
    assert_eq!(span.status, Status::Ok);
}

#[tokio::test]
async fn ends_tool_span_with_error_when_tool_throws() {
    let capture = capture_spans();
    let model = MockModel::new()
        .with_turn(tool_turn("failTool", "tool-1", json!({})))
        .with_turn("Done");
    let tool = MockTool::new("failTool")
        .with_result(|context| create_error_result("Tool exploded", context.tool_use().tool_use_id.clone()).into());
    tool_agent(model, vec![tool.into()]).invoke("Use tool").await.unwrap();
    let span = capture.span("execute_tool failTool");
    assert_eq!(attr_str(&span, "gen_ai.tool.status").as_deref(), Some("error"));
    assert!(is_error(&span, "Tool exploded"));
}

#[tokio::test]
async fn ends_tool_span_with_error_when_tool_panics() {
    let capture = capture_spans();
    let model = MockModel::new()
        .with_turn(tool_turn("panicTool", "tool-1", json!({})))
        .with_turn("Done");
    let tool = FnTool::new("panicTool", |_| Box::pin(async { panic!("Tool exploded") }));
    tool_agent(model, vec![ToolSource::from(tool)])
        .invoke("Use tool")
        .await
        .unwrap();
    assert!(is_error(&capture.span("execute_tool panicTool"), "Tool exploded"));
}

fn two_tools_turn() -> MockTurn {
    MockTurn::content([
        ContentBlock::from(ToolUseBlock::new("tool1", "id-1", json!({}))),
        ContentBlock::from(ToolUseBlock::new("tool2", "id-2", json!({}))),
    ])
}

#[tokio::test]
async fn creates_spans_for_multiple_tool_calls_in_a_single_turn() {
    let capture = capture_spans();
    let model = MockModel::new().with_turn(two_tools_turn()).with_turn("Done");
    let mut agent = tool_agent(
        model,
        vec![ok_tool("tool1", "R1").into(), ok_tool("tool2", "R2").into()],
    );
    agent.invoke("Use tools").await.unwrap();
    assert_eq!(capture.named("execute_tool tool1").len(), 1);
    assert_eq!(capture.named("execute_tool tool2").len(), 1);
}

#[tokio::test]
async fn creates_overlapping_tool_spans_when_tool_executor_is_concurrent() {
    let capture = capture_spans();
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let gated = |name: &str| {
        let barrier = barrier.clone();
        ToolSource::from(FnTool::new(name, move |context| {
            let barrier = barrier.clone();
            Box::pin(async move {
                barrier.wait().await;
                empty_result(&context)
            })
        }))
    };
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn(two_tools_turn()).with_turn("Done"))
        .tools([gated("tool1"), gated("tool2")])
        .tool_executor(ToolExecutorStrategy::default())
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("Use tools").await.unwrap();
    let first = capture.span("execute_tool tool1");
    let second = capture.span("execute_tool tool2");
    assert!(first.start_time < second.end_time && second.start_time < first.end_time);
}

#[tokio::test]
async fn passes_accumulated_usage_to_end_agent_span() {
    let capture = capture_spans();
    let model = MockModel::new().with_turn(MockTurn::text("Hello").with_usage(Usage::new(10, 5, 15)));
    agent(model).invoke("Hi").await.unwrap();
    let span = capture.span(AGENT_SPAN);
    assert_eq!(attr_i64(&span, "gen_ai.usage.input_tokens"), Some(10));
    assert_eq!(attr_i64(&span, "gen_ai.usage.output_tokens"), Some(5));
    assert_eq!(attr_i64(&span, "gen_ai.usage.total_tokens"), Some(15));
    let chat = capture.span("chat");
    assert_eq!(attr_i64(&chat, "gen_ai.usage.input_tokens"), Some(10));
}

async fn completes_without(span_name: &'static str) {
    let capture = capture_spans_except(move |metadata| metadata.name() != span_name);
    let model = MockModel::new()
        .with_turn(tool_turn("testTool", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = tool_agent(model, vec![ok_tool("testTool", "Result").into()]);
    let result = agent.invoke("Use tool").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(!capture.spans().is_empty());
}

#[tokio::test]
async fn completes_successfully_when_start_agent_span_returns_null() {
    completes_without("invoke_agent").await;
}

#[tokio::test]
async fn completes_successfully_when_start_agent_loop_span_returns_null() {
    completes_without("execute_agent_loop_cycle").await;
}

#[tokio::test]
async fn completes_successfully_when_start_model_invoke_span_returns_null() {
    completes_without("chat").await;
}

#[tokio::test]
async fn completes_successfully_when_start_tool_call_span_returns_null() {
    completes_without("execute_tool").await;
}

#[tokio::test]
async fn resets_accumulated_usage_on_each_invocation() {
    let capture = capture_spans();
    let mut agent = agent(MockModel::new().with_turn("First").with_turn("Second"));
    agent.invoke("First").await.unwrap();
    agent.invoke("Second").await.unwrap();
    assert_eq!(capture.named(AGENT_SPAN).len(), 2);
}

#[tokio::test]
async fn creates_tool_span_for_structured_output_tool_execution() {
    let capture = capture_spans();
    let model = MockModel::new()
        .with_turn(tool_turn("strands_structured_output", "tool-1", json!({"value": 42})))
        .with_turn("Done");
    structured_agent(model, value_schema()).invoke("Test").await.unwrap();
    let span = capture.span("execute_tool strands_structured_output");
    assert_eq!(attr_str(&span, "gen_ai.tool.status").as_deref(), Some("success"));
}

#[tokio::test]
async fn ends_agent_span_with_error_when_model_refuses_structured_output_tool_after_forcing() {
    let capture = capture_spans();
    let error = structured_agent(MockModel::new().with_turn("I refuse"), value_schema())
        .invoke("Test")
        .await
        .unwrap_err();
    assert!(matches!(error, Error::StructuredOutput(_)));
    assert!(is_error(&capture.span(AGENT_SPAN), &error.to_string()));
}

#[tokio::test]
async fn ends_cycle_span_with_error_on_structured_output_error() {
    let capture = capture_spans();
    let error = structured_agent(MockModel::new().with_turn("I refuse"), value_schema())
        .invoke("Test")
        .await
        .unwrap_err();
    let mut cycles = capture.named(LOOP_SPAN);
    cycles.sort_by_key(|span| span.start_time);
    assert_eq!(cycles.len(), 2);
    assert_eq!(cycles[0].status, Status::Ok);
    assert!(is_error(&cycles[1], &error.to_string()));
}

#[tokio::test]
async fn ends_agent_span_with_result_on_successful_structured_output() {
    let capture = capture_spans();
    let model = MockModel::new().with_turn(tool_turn("strands_structured_output", "tool-1", json!({"value": 42})));
    structured_agent(model, value_schema()).invoke("Test").await.unwrap();
    let span = capture.span(AGENT_SPAN);
    assert_eq!(span.status, Status::Ok);
    assert_eq!(
        event_attr(&events(&span, "gen_ai.choice")[0], "finish_reason"),
        "toolUse"
    );
}

#[tokio::test]
async fn creates_correct_spans_for_validation_retry_cycle() {
    let capture = capture_spans();
    let schema = json!({
        "type": "object",
        "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
        "required": ["name", "age"],
    });
    let model = MockModel::new()
        .with_turn(tool_turn(
            "strands_structured_output",
            "tool-1",
            json!({"name": "John", "age": "not-a-number"}),
        ))
        .with_turn(tool_turn(
            "strands_structured_output",
            "tool-2",
            json!({"name": "John", "age": 30}),
        ));
    structured_agent(model, schema).invoke("Test").await.unwrap();
    assert_eq!(cycle_ids(&capture), ["cycle-1", "cycle-2"]);
    assert!(capture.named(LOOP_SPAN).iter().all(|span| span.status == Status::Ok));
    let chats = capture.named("chat");
    assert_eq!(chats.len(), 2);
    assert!(chats.iter().all(|chat| events(chat, "gen_ai.choice").len() == 1));
    let mut tools = capture.named("execute_tool strands_structured_output");
    tools.sort_by_key(|span| span.start_time);
    assert_eq!(attr_str(&tools[0], "gen_ai.tool.call.id").as_deref(), Some("tool-1"));
    assert_eq!(attr_str(&tools[0], "gen_ai.tool.status").as_deref(), Some("error"));
    assert_eq!(attr_str(&tools[1], "gen_ai.tool.call.id").as_deref(), Some("tool-2"));
    assert_eq!(attr_str(&tools[1], "gen_ai.tool.status").as_deref(), Some("success"));
}

#[tokio::test]
async fn ends_agent_span_with_error_on_max_tokens_with_structured_output_schema() {
    let capture = capture_spans();
    let error = structured_agent(max_tokens_model(), value_schema())
        .invoke("Test")
        .await
        .unwrap_err();
    assert!(matches!(error, Error::MaxTokens(_)));
    assert!(is_error(&capture.span(AGENT_SPAN), &error.to_string()));
    assert!(is_error(&capture.span(LOOP_SPAN), &error.to_string()));
}

#[tokio::test]
async fn populates_result_traces_with_cycle_model_and_tool_traces() {
    let mut agent = tool_agent(tool_then_done(), vec![ok_tool("testTool", "Result").into()]);
    let result = agent.invoke("Use tool").await.unwrap();
    let traces = result.traces().unwrap();
    let names: Vec<&str> = traces.iter().map(|trace| trace.name.as_str()).collect();
    assert_eq!(names, ["Cycle 1", "Cycle 2"]);
    let children: Vec<&str> = traces[0].children.iter().map(|child| child.name.as_str()).collect();
    assert_eq!(children, ["stream_messages", "Tool: testTool"]);
    assert!(traces[0].children[0].message.is_some());
    assert!(traces.iter().all(|trace| trace.end_time.is_some()));
    assert_eq!(traces[1].metadata["cycleId"], "cycle-2");
}

#[tokio::test]
async fn nests_a_sub_agent_span_under_the_parent_tool_span() {
    let capture = capture_spans();
    let inner = Agent::builder()
        .model(MockModel::new().with_turn("inner done"))
        .name("inner")
        .printer(false)
        .build()
        .unwrap();
    let model = MockModel::new()
        .with_turn(tool_turn("inner", "t1", json!({"input": "go"})))
        .with_turn("outer done");
    let mut outer = tool_agent(model, vec![ToolSource::from(inner)]);
    outer.invoke("Hi").await.unwrap();
    let tool = capture.span("execute_tool inner");
    let inner = capture.span("invoke_agent inner");
    assert_eq!(inner.parent_span_id, tool.span_context.span_id());
    assert_eq!(inner.span_context.trace_id(), tool.span_context.trace_id());
}

fn tenant() -> Option<String> {
    Context::current()
        .baggage()
        .get("tenant.id")
        .map(|value| value.as_str().to_owned())
}

/// An agent that calls `tool` once and then ends its turn.
fn baggage_agent(tool: impl Tool, baggage: Option<&[(&str, &str)]>) -> Agent {
    let model = MockModel::new()
        .with_turn(tool_turn(tool.name(), "t1", json!({})))
        .with_turn("done");
    let builder = Agent::builder()
        .model(model)
        .tools([ToolSource::from(tool)])
        .printer(false);
    match baggage {
        Some(baggage) => builder.baggage_attributes(baggage.iter().copied()).build(),
        None => builder.build(),
    }
    .unwrap()
}

#[tokio::test]
async fn defaults_to_an_empty_map_and_leaves_the_active_baggage_untouched() {
    let _capture = capture_spans();
    let seen = Arc::new(Mutex::new(Some("unset".to_owned())));
    let slot = seen.clone();
    let probe = MockTool::new("probe").with_result(move |context| {
        *slot.lock().unwrap() = tenant();
        empty_result(context)
    });
    let mut agent = baggage_agent(probe, None);
    agent.invoke("Hi").await.unwrap();
    assert!(agent.baggage_attributes().is_empty());
    assert_eq!(*seen.lock().unwrap(), None);
}

#[tokio::test]
async fn is_current_inside_tools_and_when_the_agent_span_starts_merged_with_ambient_baggage() {
    let capture = capture_spans_with_baggage();
    let seen: Arc<Mutex<(Option<String>, Option<String>)>> = Arc::default();
    let slot = seen.clone();
    let probe = MockTool::new("probe").with_result(move |context| {
        let cx = Context::current();
        let baggage = cx.baggage();
        *slot.lock().unwrap() = (
            baggage.get("tenant.id").map(|value| value.as_str().to_owned()),
            baggage.get("ambient").map(|value| value.as_str().to_owned()),
        );
        empty_result(context)
    });
    let mut agent = baggage_agent(probe, Some(&[("tenant.id", "acme")]));
    let mut ambient = Baggage::new();
    ambient.insert("ambient", "up");
    let ambient = Context::current().with_baggage(ambient);
    agent.invoke("Hi").with_context(ambient).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), (Some("acme".into()), Some("up".into())));
    assert_eq!(
        attr_str(&capture.span(AGENT_SPAN), "tenant.id").as_deref(),
        Some("acme")
    );
    assert_eq!(tenant(), None);
}

fn sampler(name: &str, seen: Arc<Mutex<Vec<Option<String>>>>) -> FnTool {
    FnTool::new(name, move |context| {
        let seen = seen.clone();
        Box::pin(async move {
            seen.lock().unwrap().push(tenant());
            tokio::task::yield_now().await;
            seen.lock().unwrap().push(tenant());
            empty_result(&context)
        })
    })
}

#[tokio::test]
async fn isolates_baggage_between_interleaved_concurrent_agents() {
    let _capture = capture_spans();
    let seen_a: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let seen_b: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let mut a = baggage_agent(sampler("tool_a", seen_a.clone()), Some(&[("tenant.id", "acme")]));
    let mut b = baggage_agent(sampler("tool_b", seen_b.clone()), Some(&[("tenant.id", "globex")]));
    let (left, right) = tokio::join!(a.invoke("Hi"), b.invoke("Hi"));
    left.unwrap();
    right.unwrap();
    assert_eq!(*seen_a.lock().unwrap(), vec![Some("acme".to_owned()); 2]);
    assert_eq!(*seen_b.lock().unwrap(), vec![Some("globex".to_owned()); 2]);
}

#[tokio::test]
async fn lets_a_nested_agent_override_baggage_for_its_scope_and_restores_the_outer_value_after() {
    let _capture = capture_spans();
    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let inner_seen = seen.clone();
    let inner_probe = MockTool::new("inner_probe").with_result(move |context| {
        inner_seen.lock().unwrap().push(tenant());
        empty_result(context)
    });
    let inner = Arc::new(tokio::sync::Mutex::new(baggage_agent(
        inner_probe,
        Some(&[("tenant.id", "inner-corp")]),
    )));
    let outer_seen = seen.clone();
    let outer_probe = FnTool::new("outer_probe", move |context| {
        let seen = outer_seen.clone();
        let inner = inner.clone();
        Box::pin(async move {
            seen.lock().unwrap().push(tenant());
            inner.lock().await.invoke("Hi").await.unwrap();
            seen.lock().unwrap().push(tenant());
            empty_result(&context)
        })
    });
    let mut outer = baggage_agent(outer_probe, Some(&[("tenant.id", "outer-corp")]));
    outer.invoke("Hi").await.unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            Some("outer-corp".to_owned()),
            Some("inner-corp".to_owned()),
            Some("outer-corp".to_owned())
        ]
    );
}

#[tokio::test]
async fn keeps_baggage_current_for_invocation_cleanup_when_the_consumer_breaks_early() {
    let _capture = capture_spans();
    let probe = MockTool::new("probe").with_result(empty_result);
    let mut agent = baggage_agent(probe, Some(&[("tenant.id", "acme")]));
    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let slot = seen.clone();
    agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| slot.lock().unwrap().push(tenant()));
    {
        let mut stream = agent.stream("Hi");
        while let Some(event) = stream.next().await {
            if matches!(event.unwrap(), AgentStreamEvent::BeforeModelCall(_)) {
                break;
            }
        }
    }
    agent.invoke("Hi").await.unwrap();
    assert_eq!(seen.lock().unwrap()[0].as_deref(), Some("acme"));
}

#[tokio::test]
async fn runs_tool_call_hooks_with_the_caller_baggage_and_span_with_either_executor() {
    let capture = capture_spans();
    for executor in [ToolExecutorStrategy::Sequential, ToolExecutorStrategy::Concurrent] {
        let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
        let model = MockModel::new()
            .with_turn(tool_turn("probe", "t1", json!({})))
            .with_turn("ok");
        let mut agent = Agent::builder()
            .model(model)
            .tools([ToolSource::from(MockTool::new("probe"))])
            .tool_executor(executor)
            .baggage_attributes([("tenant.id", "acme")])
            .printer(false)
            .build()
            .unwrap();
        let slot = seen.clone();
        agent.add_hook(move |_: &mut BeforeToolCallEvent| {
            slot.lock().unwrap().push(tenant());
            let _span = tracing::info_span!("hook_span").entered();
        });
        agent
            .invoke("hi")
            .instrument(tracing::info_span!("request"))
            .await
            .unwrap();
        assert_eq!(*seen.lock().unwrap(), [Some("acme".to_owned())], "{executor:?}");
        let request = capture.span("request");
        let hook = capture.span("hook_span");
        assert_eq!(hook.parent_span_id, request.span_context.span_id(), "{executor:?}");
        assert_eq!(
            hook.span_context.trace_id(),
            request.span_context.trace_id(),
            "{executor:?}"
        );
        capture.reset();
    }
}

/// A span as the reference fixture records it: name, parent name, attribute keys in order, event
/// names.
fn span_shape(span: &SpanData, names: &HashMap<SpanId, String>) -> serde_json::Value {
    let parent = if span.parent_span_id == SpanId::INVALID {
        serde_json::Value::Null
    } else {
        json!(names.get(&span.parent_span_id).map_or("<external>", String::as_str))
    };
    let attributes: Vec<&str> = span.attributes.iter().map(|kv| kv.key.as_str()).collect();
    let events: Vec<&str> = span.events.iter().map(|event| event.name.as_ref()).collect();
    json!({"name": span.name, "parent": parent, "attributes": attributes, "events": events})
}

fn trace_shape(trace: &AgentTrace) -> serde_json::Value {
    let children: Vec<_> = trace.children.iter().map(trace_shape).collect();
    json!({"name": trace.name, "children": children})
}

fn sorted(values: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut values = values.to_vec();
    values.sort_by_key(|value| value.to_string());
    values
}

/// `ts_reference_spans.json` is the span shapes and local trace tree a reference Strands SDK
/// records for this run (an agent with a scripted model: a throttled turn, a turn calling the
/// `calc` tool and a sub-agent `inner`, then `done`; system prompt `be brief`; trace attributes
/// `custom.key` and `gen_ai.agent.name`; `DefaultModelRetryStrategy` with a 1 ms
/// `ConstantBackoff`), exported through an in-memory span exporter.
#[tokio::test(start_paused = true)]
async fn exports_the_ts_attribute_keys_and_events_of_every_span() {
    let reference: serde_json::Value = serde_json::from_str(include_str!("ts_reference_spans.json")).unwrap();
    let capture = capture_spans();
    let inner = Agent::builder()
        .model(MockModel::new().with_turn(MockTurn::text("inner done").with_usage(Usage::new(3, 2, 5))))
        .name("inner")
        .description("inner agent")
        .printer(false)
        .build()
        .unwrap();
    let mut cached = Usage::new(10, 5, 15);
    cached.cache_read_input_tokens = Some(4);
    let model = MockModel::from_turns([
        MockTurn::throttled("slow down"),
        MockTurn::content([
            ToolUseBlock::new("calc", "t1", json!({"x": 1})),
            ToolUseBlock::new("inner", "t2", json!({"input": "hi"})),
        ])
        .with_usage(cached),
        MockTurn::text("done").with_usage(Usage::new(20, 6, 26)),
    ]);
    let retry = DefaultModelRetryStrategy::new(DefaultModelRetryStrategyOptions {
        max_attempts: 3,
        backoff: Some(Arc::new(ConstantBackoff::new(ConstantBackoffOptions {
            delay: Duration::from_millis(1),
        }))),
        ..Default::default()
    })
    .unwrap();
    let mut outer = Agent::builder()
        .model(model)
        .name("outer")
        .tools([ToolSource::from(ok_tool("calc", "42")), ToolSource::from(inner)])
        .system_prompt("be brief")
        .trace_attributes([("custom.key", "v"), ("gen_ai.agent.name", "override")])
        .retry_strategy(vec![RetryStrategy::model(retry)])
        .printer(false)
        .build()
        .unwrap();
    let result = outer.invoke("hello").await.unwrap();

    let spans = capture.spans();
    let names: HashMap<SpanId, String> = spans
        .iter()
        .map(|span| (span.span_context.span_id(), span.name.to_string()))
        .collect();
    let shapes: Vec<_> = spans.iter().map(|span| span_shape(span, &names)).collect();
    let expected = reference["spans"].as_array().unwrap();
    assert_eq!(sorted(&shapes), sorted(expected));
    let traces: Vec<_> = result.traces().unwrap().iter().map(trace_shape).collect();
    assert_eq!(json!(traces), reference["traces"]);
}

/// The span half of "records span and metric telemetry when a tool interrupts": the tool span ends
/// with no result and no error.
#[tokio::test]
async fn ends_the_tool_span_without_a_result_or_error_when_a_tool_interrupts() {
    let capture = capture_spans();
    let tool = MockTool::new("approvalTool").with_result(|context| {
        match context.interrupt(crate::types::InterruptParams::new("approve").with_reason("Approve this tool call?")) {
            Ok(_) => ToolResultBlock::success(context.tool_use().tool_use_id.clone(), Vec::new()).into(),
            Err(interrupt) => interrupt.into(),
        }
    });
    let model = MockModel::new().with_turn(tool_turn("approvalTool", "tool-1", json!({})));
    let mut agent = tool_agent(model, vec![tool.into()]);

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    let spans = capture.named("execute_tool approvalTool");
    assert_eq!(spans.len(), 1);
    let span = &spans[0];
    assert_eq!(attr_str(span, "gen_ai.tool.status"), None);
    assert!(events(span, "gen_ai.choice").is_empty());
    assert!(exceptions(span).is_empty());
    assert!(!matches!(span.status, Status::Error { .. }), "{:?}", span.status);
}
