use std::sync::Mutex;

use futures::stream;
use serde_json::json;

use super::*;
use crate::Error;
use crate::interrupt::Interrupt;
use crate::testing::tool_context;
use crate::types::{ToolResultStatus, ToolUse};

fn simple(value: JsonValue) -> FunctionTool {
    FunctionTool::builder("testTool", "Test tool description")
        .input_schema(json!({"type": "object", "properties": {}}))
        .callback(move |_, _| {
            let value = value.clone();
            async move { Ok(value) }
        })
}

async fn run(tool: &FunctionTool, input: JsonValue) -> (Vec<ToolStreamEvent>, ToolOutcome) {
    run_with_id(tool, "test-1", input).await
}

async fn run_with_id(tool: &FunctionTool, tool_use_id: &str, input: JsonValue) -> (Vec<ToolStreamEvent>, ToolOutcome) {
    let context = tool_context(ToolUse::new(tool.name(), tool_use_id, input));
    let mut events = Vec::new();
    let outcome = tool.stream(context).run(|event| events.push(event)).await.unwrap();
    (events, outcome)
}

async fn result_of(tool: &FunctionTool) -> ToolResultBlock {
    match run(tool, json!({})).await.1 {
        ToolOutcome::Result(result) => result,
        other => panic!("expected a result, got {other:?}"),
    }
}

async fn content_of(value: JsonValue) -> JsonValue {
    let result = result_of(&simple(value)).await;
    assert_eq!(result.status, ToolResultStatus::Success);
    serde_json::to_value(&result.content).unwrap()
}

#[test]
fn has_a_non_empty_tool_name() {
    assert_eq!(simple(json!(null)).name(), "testTool");
}

#[test]
fn has_a_non_empty_description() {
    assert_eq!(simple(json!(null)).description(), "Test tool description");
}

#[test]
fn has_a_valid_tool_spec() {
    assert_eq!(
        serde_json::to_value(simple(json!(null)).tool_spec()).unwrap(),
        json!({"name": "testTool", "description": "Test tool description", "inputSchema": {"type": "object", "properties": {}}})
    );
}

#[test]
fn has_matching_tool_name_and_tool_spec_name() {
    let tool = simple(json!(null));
    assert_eq!(tool.name(), tool.tool_spec().name);
}

#[test]
fn has_matching_description_and_tool_spec_description() {
    let tool = simple(json!(null));
    assert_eq!(tool.description(), tool.tool_spec().description);
}

#[tokio::test]
async fn wraps_return_value_in_tool_result() {
    let tool = FunctionTool::builder("testTool", "Test tool").callback(|input, _| async move {
        Ok(json!(
            input["a"].as_i64().unwrap_or(0) + input["b"].as_i64().unwrap_or(0)
        ))
    });
    let (events, outcome) = run(&tool, json!({"a": 5, "b": 3})).await;
    assert!(events.is_empty());
    assert_eq!(
        serde_json::to_value(outcome.result().unwrap()).unwrap(),
        json!({"toolUseId": "test-1", "status": "success", "content": [{"text": "8"}]})
    );
}

#[tokio::test]
async fn handles_string_return_values() {
    assert_eq!(
        content_of(json!("Hello, World!")).await,
        json!([{"text": "Hello, World!"}])
    );
}

#[tokio::test]
async fn keeps_returned_tool_references_as_tool_reference_content() {
    assert_eq!(
        content_of(json!([{"toolReference": {"name": "shell"}}])).await,
        json!([{"toolReference": {"name": "shell"}}])
    );
}

#[tokio::test]
async fn handles_object_return_values() {
    assert_eq!(
        content_of(json!({"key": "value", "count": 42})).await,
        json!([{"json": {"key": "value", "count": 42}}])
    );
}

#[tokio::test]
async fn treats_objects_with_extra_keys_beyond_a_content_block_key_as_json() {
    assert_eq!(
        content_of(json!({"text": "abc", "extra": "123"})).await,
        json!([{"json": {"text": "abc", "extra": "123"}}])
    );
}

#[tokio::test]
async fn passes_content_block_data_through() {
    assert_eq!(content_of(json!({"text": "abc"})).await, json!([{"text": "abc"}]));
    assert_eq!(
        content_of(json!([{"text": "a"}, {"json": {"b": 1}}])).await,
        json!([{"text": "a"}, {"json": {"b": 1}}])
    );
}

#[tokio::test]
async fn passes_input_to_callback_exactly_as_provided_to_stream() {
    let received = Arc::new(Mutex::new(None));
    let seen = received.clone();
    let tool = FunctionTool::builder("testTool", "Test tool").callback(move |input, _| {
        *seen.lock().unwrap() = Some(input);
        async { Ok(json!("ok")) }
    });
    let input = json!({"nested": {"value": [1, 2, 3]}, "flag": true});
    run(&tool, input.clone()).await;
    assert_eq!(received.lock().unwrap().clone(), Some(input));
}

#[tokio::test]
async fn handles_null_return_values_correctly() {
    assert_eq!(content_of(JsonValue::Null).await, json!([{"text": "null"}]));
}

#[tokio::test]
async fn handles_undefined_return_values_correctly() {
    let tool = FunctionTool::builder("undefinedTool", "Returns undefined")
        .input_schema(json!({"type": "object"}))
        .callback(|_, _| async { Ok(serde_json::to_value(()).unwrap()) });
    let (_, outcome) = run_with_id(&tool, "test-undefined", json!({})).await;
    assert_eq!(
        serde_json::to_value(outcome.result().unwrap()).unwrap(),
        json!({"toolUseId": "test-undefined", "status": "success", "content": [{"text": "null"}]})
    );
}

#[tokio::test]
async fn handles_boolean_return_values_as_text_content() {
    assert_eq!(content_of(json!(true)).await, json!([{"text": "true"}]));
    assert_eq!(content_of(json!(false)).await, json!([{"text": "false"}]));
}

#[tokio::test]
async fn handles_number_return_values_as_text_content() {
    assert_eq!(content_of(json!(42)).await, json!([{"text": "42"}]));
    assert_eq!(content_of(json!(-2.5)).await, json!([{"text": "-2.5"}]));
    assert_eq!(content_of(json!(2.0)).await, json!([{"text": "2"}]));
}

#[tokio::test]
async fn handles_array_return_values_as_wrapped_json_content() {
    assert_eq!(
        content_of(json!([1, 2, 3, {"key": "value"}])).await,
        json!([{"json": {"$value": [1, 2, 3, {"key": "value"}]}}])
    );
    assert_eq!(content_of(json!([])).await, json!([{"json": {"$value": []}}]));
}

#[tokio::test]
async fn wraps_resolved_value_in_tool_result() {
    let tool = FunctionTool::builder("promiseTool", "Returns promise")
        .input_schema(json!({"type": "object", "properties": {"value": {"type": "number"}}}))
        .callback(|input: JsonValue, _| async move { Ok(json!(input["value"].as_i64().unwrap() + 10)) });
    let (events, outcome) = run_with_id(&tool, "test-promise-1", json!({"value": 5})).await;
    assert!(events.is_empty());
    let result = outcome.result().unwrap();
    assert_eq!(result.tool_use_id, "test-promise-1");
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(result.content, vec![ToolResultContent::text("15")]);
}

#[tokio::test]
async fn can_access_tool_context_in_promise() {
    let tool = FunctionTool::builder("contextTool", "Uses context")
        .callback(|_, context: ToolContext| async move { Ok(json!(context.tool_use().tool_use_id)) });
    let result = result_of(&tool).await;
    assert_eq!(result.content, vec![ToolResultContent::text("test-1")]);
}

fn generator(items: Vec<Result<FunctionToolItem, ToolError>>) -> FunctionTool {
    let items = Arc::new(Mutex::new(Some(items)));
    FunctionTool::builder("generatorTool", "Streams progress")
        .stream_callback(move |_, _| stream::iter(items.lock().unwrap().take().unwrap_or_default()))
}

#[tokio::test]
async fn yields_tool_stream_events_then_final_tool_result() {
    let tool = generator(vec![
        Ok(FunctionToolItem::Update(json!("Starting..."))),
        Ok(FunctionToolItem::Update(json!("Processing..."))),
        Ok(FunctionToolItem::Update(json!("Complete!"))),
        Ok(FunctionToolItem::Return(json!("Final result"))),
    ]);
    let (events, outcome) = run(&tool, json!({})).await;
    assert_eq!(
        serde_json::to_value(&events).unwrap(),
        json!([
            {"type": "toolStreamEvent", "data": "Starting..."},
            {"type": "toolStreamEvent", "data": "Processing..."},
            {"type": "toolStreamEvent", "data": "Complete!"}
        ])
    );
    assert_eq!(
        outcome.result().unwrap().content,
        vec![ToolResultContent::text("Final result")]
    );
}

#[tokio::test]
async fn can_yield_objects_as_tool_stream_events() {
    let tool = generator(vec![
        Ok(FunctionToolItem::Update(
            json!({"progress": 0.25, "message": "Quarter done"}),
        )),
        Ok(FunctionToolItem::Update(
            json!({"progress": 0.5, "message": "Halfway done"}),
        )),
        Ok(FunctionToolItem::Return(json!("Done"))),
    ]);
    let (events, outcome) = run(&tool, json!({})).await;
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|event| event.data.is_some()));
    assert_eq!(outcome.result().unwrap().status, ToolResultStatus::Success);
}

#[tokio::test]
async fn returns_null_when_a_generator_ends_without_a_return_value() {
    let tool = generator(vec![Ok(FunctionToolItem::Update(json!(1)))]);
    let (_, outcome) = run(&tool, json!({})).await;
    assert_eq!(outcome.result().unwrap().content, vec![ToolResultContent::text("null")]);
}

#[tokio::test]
async fn catches_promise_rejections() {
    let tool = FunctionTool::builder("rejectTool", "Rejects")
        .callback(|_, _| async { Err(ToolError::msg("Promise rejected")) });
    let (events, outcome) = run(&tool, json!({})).await;
    assert!(events.is_empty());
    let result = outcome.result().unwrap();
    assert_eq!(result.tool_use_id, "test-1");
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(result.content, vec![ToolResultContent::text("Error: Promise rejected")]);
}

#[tokio::test]
async fn captures_error_object_in_tool_result_when_callback_throws_error() {
    let tool = FunctionTool::builder("errorTool", "Throws")
        .callback(|_, _| async { Err(Error::other("Something went wrong").into()) });
    let result = result_of(&tool).await;
    assert_eq!(result.error.unwrap().to_string(), "Something went wrong");
}

#[tokio::test]
async fn captures_errors_thrown_in_async_generator_callbacks() {
    let tool = generator(vec![
        Ok(FunctionToolItem::Update(json!("Starting..."))),
        Err(ToolError::msg("Async generator error")),
    ]);
    let (events, outcome) = run_with_id(&tool, "test-async-gen-error", json!({})).await;
    assert_eq!(
        serde_json::to_value(&events).unwrap(),
        json!([{"type": "toolStreamEvent", "data": "Starting..."}])
    );
    let result = outcome.result().unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({"toolUseId": "test-async-gen-error", "status": "error", "content": [{"text": "Error: Async generator error"}]})
    );
    assert_eq!(result.error.as_ref().unwrap().to_string(), "Async generator error");
}

#[tokio::test]
async fn catches_errors_in_async_generators() {
    let tool = generator(vec![
        Ok(FunctionToolItem::Update(json!("Starting..."))),
        Err(ToolError::msg("Generator error")),
    ]);
    let (events, outcome) = run_with_id(&tool, "test-error-3", json!({})).await;
    assert_eq!(events.len(), 1);
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap()["type"],
        json!("toolStreamEvent")
    );
    assert_eq!(outcome.result().unwrap().status, ToolResultStatus::Error);
}

#[tokio::test]
async fn ends_as_an_interrupt_when_the_callback_raises_one() {
    let tool = FunctionTool::builder("confirmTool", "Asks first")
        .callback(|_, context: ToolContext| async move { Ok(context.interrupt("confirm")?) });
    let (_, outcome) = run(&tool, json!({})).await;
    let ToolOutcome::Interrupt(interrupt) = outcome else {
        panic!("expected an interrupt");
    };
    assert_eq!(
        interrupt,
        Interrupt::new("tool:test-1:confirm", "confirm")
            .with_source(crate::InterruptSource::Tool)
            .into()
    );
}

#[test]
fn creates_tool_with_default_empty_object_schema() {
    let tool =
        FunctionTool::builder("noInputTool", "Tool that takes no input").callback(|_, _| async { Ok(json!("result")) });
    assert_eq!(tool.name(), "noInputTool");
    assert_eq!(tool.description(), "Tool that takes no input");
    assert_eq!(
        serde_json::to_value(tool.tool_spec()).unwrap(),
        json!({
            "name": "noInputTool",
            "description": "Tool that takes no input",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        })
    );
}

#[tokio::test]
async fn executes_successfully_with_empty_input() {
    let tool = FunctionTool::builder("statusTool", "Gets status")
        .callback(|_, _| async { Ok(json!({"status": "operational"})) });
    assert_eq!(
        result_of(&tool).await.content,
        vec![ToolResultContent::json(json!({"status": "operational"}))]
    );
}

#[tokio::test]
async fn works_with_async_callback_without_input_schema() {
    let tool = FunctionTool::builder("asyncNoInput", "Async tool with no input")
        .callback(|_, _| async { Ok(json!("async result")) });
    let (_, outcome) = run_with_id(&tool, "test-async-no-input", json!({})).await;
    assert_eq!(
        serde_json::to_value(outcome.result().unwrap()).unwrap(),
        json!({"toolUseId": "test-async-no-input", "status": "success", "content": [{"text": "async result"}]})
    );
}

#[tokio::test]
async fn works_with_async_generator_callback() {
    let tool = generator(vec![
        Ok(FunctionToolItem::Update(json!("Starting..."))),
        Ok(FunctionToolItem::Return(json!("Done"))),
    ]);
    let (events, outcome) = run(&tool, json!({})).await;
    assert_eq!(events, vec![ToolStreamEvent::new("Starting...")]);
    assert_eq!(outcome.result().unwrap().content, vec![ToolResultContent::text("Done")]);
}

#[derive(schemars::JsonSchema)]
#[allow(dead_code, reason = "schema-only type")]
struct Person {
    name: String,
    age: u32,
}

#[tokio::test]
async fn input_schema_for_validates_input_before_the_callback() {
    let tool = FunctionTool::builder("person", "Takes a person")
        .input_schema_for::<Person>()
        .callback(|input, _| async move { Ok(input) });
    assert_eq!(
        tool.tool_spec().input_schema,
        Some(json!({
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "integer", "minimum": 0}},
            "required": ["name", "age"]
        }))
    );
    let (_, ok) = run(&tool, json!({"name": "Ann", "age": 3})).await;
    assert_eq!(ok.result().unwrap().status, ToolResultStatus::Success);
    let (_, invalid) = run(&tool, json!({"name": "Ann", "age": "three"})).await;
    let result = invalid.result().unwrap();
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(
        result.content,
        vec![ToolResultContent::text(
            "Error: Validation failed:\n- /age: \"three\" is not of type \"integer\""
        )]
    );
}
