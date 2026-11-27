//! `#[tool]` and `#[tools]`.
//!
//! The macro keeps the annotated function callable as written, so cases that invoke a tool call
//! the function directly.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use strands::testing::tool_context;
use strands::tools::{ToolStream, ToolStreamItem};
use strands::{
    InterruptParams, JsonValue, Tool, ToolContext, ToolError, ToolOutcome, ToolResultBlock, ToolResultContent,
    ToolSource, ToolUse, tool, tools,
};

async fn run(tool: &dyn Tool, input: JsonValue) -> (Vec<JsonValue>, ToolOutcome) {
    let stream: ToolStream = tool.stream(tool_context(ToolUse::new(tool.name(), "test-123", input)));
    let items: Vec<ToolStreamItem> = stream.collect().await;
    let mut events = Vec::new();
    let mut outcome = None;
    for item in items {
        match item {
            ToolStreamItem::Event(event) => events.push(serde_json::to_value(event).unwrap()),
            ToolStreamItem::Outcome(found) => outcome = Some(found),
            _ => panic!("unexpected stream item"),
        }
    }
    (events, outcome.expect("the stream ends with an outcome"))
}

async fn result(tool: &dyn Tool, input: JsonValue) -> JsonValue {
    let (events, outcome) = run(tool, input).await;
    assert!(events.is_empty());
    let ToolOutcome::Result(result) = outcome else {
        panic!("expected a result, got {outcome:?}");
    };
    serde_json::to_value(result).unwrap()
}

fn success(content: &JsonValue) -> JsonValue {
    json!({"toolUseId": "test-123", "status": "success", "content": content})
}

fn error(text: &str) -> JsonValue {
    json!({"toolUseId": "test-123", "status": "error", "content": [{"text": text}]})
}

/// Compares JSON including key order, which is part of the wire format.
fn assert_json_in_order(actual: &JsonValue, expected: &JsonValue) {
    assert_eq!(
        serde_json::to_string_pretty(actual).unwrap(),
        serde_json::to_string_pretty(expected).unwrap()
    );
}

/// Test description
#[tool(name = "testTool")]
async fn test_tool(value: String) -> String {
    value
}

#[test]
fn creates_tool_with_correct_properties() {
    assert_eq!(TestTool.name(), "testTool");
    assert_eq!(TestTool.description(), "Test description");
    assert_json_in_order(
        &serde_json::to_value(TestTool.tool_spec()).unwrap(),
        &json!({
            "name": "testTool",
            "description": "Test description",
            "inputSchema": {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": false
            }
        }),
    );
}

/// Async tool
#[tool]
async fn prefix(value: String) -> String {
    format!("Result: {value}")
}

#[tokio::test]
async fn handles_promise_callback() {
    assert_eq!(prefix("test".to_owned()).await, "Result: test");
}

/// Synchronous tool
#[tool]
async fn add(a: f64, b: f64) -> f64 {
    a + b
}

#[tokio::test]
async fn handles_synchronous_callback() {
    assert_eq!(add(5.0, 3.0).await, 8.0);
    assert_eq!(
        result(&Add, json!({"a": 5, "b": 3})).await,
        success(&json!([{"text": "8"}]))
    );
}

#[tokio::test]
async fn streams_synchronous_callback_result() {
    let (events, outcome) = run(&TestTool, json!({"value": "hello"})).await;
    assert!(events.is_empty());
    assert_eq!(
        outcome,
        ToolOutcome::Result(ToolResultBlock::success(
            "test-123",
            vec![ToolResultContent::text("hello")]
        ))
    );
}

/// Async tool
#[tool]
async fn double(value: f64) -> f64 {
    value * 2.0
}

#[tokio::test]
async fn streams_promise_callback_result() {
    assert_eq!(
        result(&Double, json!({"value": 21})).await,
        success(&json!([{"text": "42"}]))
    );
}

/// Validates input
#[tool]
async fn validator(#[schemars(range(min = 0, max = 120))] age: i64) -> i64 {
    age
}

#[tokio::test]
async fn returns_error_result_on_validation_failure() {
    assert_eq!(
        result(&Validator, json!({"age": -5})).await,
        error("Error: Validation failed:\n- /age: -5 is less than the minimum of 0")
    );
    assert_eq!(
        result(&Validator, json!({"age": 150})).await,
        error("Error: Validation failed:\n- /age: 150 is greater than the maximum of 120")
    );
}

/// Required fields
#[tool]
async fn required(name: String, value: f64) -> String {
    format!("{name}: {value}")
}

#[tokio::test]
async fn returns_error_result_on_missing_required_fields() {
    assert_eq!(
        result(&Required, json!({"name": "test"})).await,
        error("Error: Validation failed:\n- \"value\" is a required property")
    );
}

#[tokio::test]
async fn validates_required_fields() {
    assert_eq!(
        result(&Required, json!({"value": "x"})).await,
        error(
            "Error: Validation failed:\n- \"name\" is a required property\n- /value: \"x\" is not of type \"number\""
        )
    );
}

#[tokio::test]
async fn ignores_keys_the_schema_does_not_declare() {
    assert_eq!(
        result(&Required, json!({"name": "a", "value": 1, "extra": true})).await,
        success(&json!([{"text": "a: 1"}]))
    );
}

/// Throws error
#[tool]
async fn failing(value: String) -> Result<String, ToolError> {
    let _ = value;
    Err(ToolError::msg("Callback error"))
}

#[tokio::test]
async fn catches_callback_errors_and_returns_error_result() {
    let (events, outcome) = run(&Failing, json!({"value": "test"})).await;
    assert!(events.is_empty());
    let ToolOutcome::Result(result) = outcome else {
        panic!("expected a result");
    };
    assert_eq!(serde_json::to_value(&result).unwrap(), error("Error: Callback error"));
    assert_eq!(result.error.unwrap().to_string(), "Callback error");
}

/// Throws async error
#[tool]
async fn async_error(value: String) -> std::io::Result<String> {
    let _ = value;
    Err(std::io::Error::other("Async error"))
}

#[tokio::test]
async fn catches_async_callback_errors() {
    assert_eq!(
        result(&AsyncError, json!({"value": "test"})).await,
        error("Error: Async error")
    );
}

/// Fails with a boxed error.
#[tool]
async fn boxed_error(value: String) -> Result<String, strands::BoxError> {
    let parsed: u32 = value.parse()?;
    Ok(parsed.to_string())
}

/// Fails with a string.
#[tool]
async fn string_error(value: String) -> Result<String, String> {
    Err(format!("no weather for {value}"))
}

/// An error type that, like `anyhow::Error`, does not implement `std::error::Error` but converts
/// into a `BoxError`.
#[derive(Debug)]
struct Opaque(String);

impl From<Opaque> for strands::BoxError {
    fn from(error: Opaque) -> Self {
        error.0.into()
    }
}

/// Fails with an opaque error.
#[tool]
async fn opaque_error(value: String) -> Result<String, Opaque> {
    Err(Opaque(format!("opaque {value}")))
}

#[tokio::test]
async fn converts_errors_that_only_convert_into_box_error() {
    assert_eq!(
        result(&BoxedError, json!({"value": "x"})).await,
        error("Error: invalid digit found in string")
    );
    assert_eq!(
        result(&BoxedError, json!({"value": "7"})).await,
        success(&json!([{"text": "7"}]))
    );
    assert_eq!(
        result(&StringError, json!({"value": "Lisbon"})).await,
        error("Error: no weather for Lisbon")
    );
    assert_eq!(
        result(&OpaqueError, json!({"value": "x"})).await,
        error("Error: opaque x")
    );
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct User {
    name: String,
    age: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct Metadata {
    timestamp: f64,
}

/// Nested objects
#[tool]
async fn nested(user: User, metadata: Metadata) -> String {
    let _ = metadata.timestamp;
    format!("{} ({})", user.name, user.age)
}

#[tokio::test]
async fn handles_nested_object_schemas() {
    assert_json_in_order(
        &Nested.tool_spec().input_schema.unwrap(),
        &json!({
            "type": "object",
            "properties": {
                "user": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "age": {"type": "integer", "minimum": 0}
                    },
                    "required": ["name", "age"]
                },
                "metadata": {
                    "type": "object",
                    "properties": {"timestamp": {"type": "number"}},
                    "required": ["timestamp"]
                }
            },
            "required": ["user", "metadata"],
            "additionalProperties": false
        }),
    );
    let input = json!({"user": {"name": "Alice", "age": 30}, "metadata": {"timestamp": 1.0}});
    assert_eq!(result(&Nested, input).await, success(&json!([{"text": "Alice (30)"}])));
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Add,
    Subtract,
    Multiply,
    Divide,
}

/// Basic calculator
#[tool]
async fn calculator(operation: Operation, a: f64, b: f64) -> f64 {
    match operation {
        Operation::Add => a + b,
        Operation::Subtract => a - b,
        Operation::Multiply => a * b,
        Operation::Divide => a / b,
    }
}

#[tokio::test]
async fn handles_enum_schemas() {
    let schema = Calculator.tool_spec().input_schema.unwrap();
    assert_eq!(
        schema["properties"]["operation"],
        json!({"type": "string", "enum": ["add", "subtract", "multiply", "divide"]})
    );
    assert_eq!(
        result(&Calculator, json!({"operation": "add", "a": 5, "b": 3})).await,
        success(&json!([{"text": "8"}]))
    );
    assert_eq!(
        result(&Calculator, json!({"operation": "multiply", "a": 4, "b": 7})).await,
        success(&json!([{"text": "28"}]))
    );
    assert_eq!(
        result(&Calculator, json!({"operation": "modulo", "a": 4, "b": 7})).await["status"],
        "error"
    );
}

/// Generates greeting
#[tool]
async fn greeting(name: String, title: Option<String>) -> String {
    match title {
        Some(title) => format!("{title} {name}"),
        None => name,
    }
}

#[tokio::test]
async fn handles_optional_fields() {
    let schema = Greeting.tool_spec().input_schema.unwrap();
    assert_eq!(schema["required"], json!(["name"]));
    assert_eq!(schema["properties"]["title"], json!({"type": ["string", "null"]}));
    assert_eq!(
        result(&Greeting, json!({"name": "Smith"})).await,
        success(&json!([{"text": "Smith"}]))
    );
    assert_eq!(
        result(&Greeting, json!({"name": "Smith", "title": "Dr."})).await,
        success(&json!([{"text": "Dr. Smith"}]))
    );
    assert_eq!(
        result(&Greeting, json!({"name": "Smith", "title": null})).await,
        success(&json!([{"text": "Smith"}]))
    );
}

/// Sums numbers
#[tool]
async fn sum(numbers: Vec<f64>) -> f64 {
    numbers.iter().sum()
}

#[tokio::test]
async fn handles_array_schemas() {
    assert_eq!(
        result(&Sum, json!({"numbers": [1, 2, 3, 4, 5]})).await,
        success(&json!([{"text": "15"}]))
    );
}

/// Uses context
#[tool]
async fn uses_context(value: String, #[tool(context)] ctx: &ToolContext) -> String {
    format!("{value} from {}", ctx.tool_use().tool_use_id)
}

#[tokio::test]
async fn passes_context_to_callback() {
    let spec = UsesContext.tool_spec();
    assert_eq!(spec.input_schema.unwrap()["required"], json!(["value"]));
    assert_eq!(
        result(&UsesContext, json!({"value": "test"})).await,
        success(&json!([{"text": "test from test-123"}]))
    );
}

/// Tool with no input
#[tool(name = "noInputTool")]
async fn no_input_tool() -> &'static str {
    "result"
}

#[test]
fn creates_tool_with_default_empty_object_schema() {
    assert_eq!(NoInputTool.name(), "noInputTool");
    assert_eq!(NoInputTool.description(), "Tool with no input");
    assert_json_in_order(
        &serde_json::to_value(NoInputTool.tool_spec()).unwrap(),
        &json!({
            "name": "noInputTool",
            "description": "Tool with no input",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        }),
    );
}

#[derive(Serialize)]
struct Preferences {
    theme: &'static str,
    language: &'static str,
}

/// Gets user preferences
#[tool]
async fn get_preferences() -> Preferences {
    Preferences {
        theme: "dark",
        language: "en",
    }
}

#[tokio::test]
async fn invoke_works_with_empty_object() {
    let preferences = get_preferences().await;
    assert_eq!((preferences.theme, preferences.language), ("dark", "en"));
}

/// Gets system status
#[tool]
async fn get_status(#[tool(context)] ctx: &ToolContext) -> JsonValue {
    let _ = ctx;
    json!({"status": "operational", "uptime": 99.9})
}

#[tokio::test]
async fn stream_works_with_empty_input() {
    assert_eq!(
        result(&GetStatus, json!({})).await,
        success(&json!([{"json": {"status": "operational", "uptime": 99.9}}]))
    );
    assert_eq!(GetStatus.tool_spec().input_schema.unwrap()["properties"], json!({}));
}

#[tokio::test]
async fn takes_the_input_of_a_tool_without_parameters_as_given() {
    assert_eq!(
        result(&NoInputTool, json!(null)).await,
        success(&json!([{"text": "result"}]))
    );
}

#[tokio::test]
async fn works_with_async_callback() {
    assert_eq!(no_input_tool().await, "result");
    assert_eq!(
        result(&NoInputTool, json!({})).await,
        success(&json!([{"text": "result"}]))
    );
}

/// Look up the weather.
///
/// Reads the live feed.
///
/// # Errors
///
/// This section is for people, not the model.
#[tool]
async fn weather(
    /// City name, for example "Seattle".
    city: String,
    /// Days to forecast.
    #[serde(rename = "forecastDays", default)]
    days: u32,
    /// Units.
    #[schemars(extend("enum" = ["metric", "imperial"]))]
    units: Option<String>,
) -> String {
    format!("{city} {days} {units:?}")
}

#[test]
fn builds_the_spec_from_doc_comments_and_parameter_attributes() {
    assert_eq!(Weather.description(), "Look up the weather.\n\nReads the live feed.");
    assert_json_in_order(
        &Weather.tool_spec().input_schema.unwrap(),
        &json!({
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name, for example \"Seattle\"."},
                "forecastDays": {"type": "integer", "default": 0, "minimum": 0, "description": "Days to forecast."},
                "units": {"type": ["string", "null"], "description": "Units.", "enum": ["metric", "imperial"]}
            },
            "required": ["city"],
            "additionalProperties": false
        }),
    );
}

#[tokio::test]
async fn passes_renamed_and_defaulted_parameters() {
    assert_eq!(
        result(&Weather, json!({"city": "Lisbon", "forecastDays": 3})).await,
        success(&json!([{"text": "Lisbon 3 None"}]))
    );
    assert_eq!(
        result(&Weather, json!({"city": "Lisbon"})).await,
        success(&json!([{"text": "Lisbon 0 None"}]))
    );
}

/// Doc comment that the attribute replaces.
#[tool(name = "search-web", description = "Searches the web.")]
async fn search(query: String) -> String {
    query
}

#[test]
fn attribute_arguments_override_the_name_and_description() {
    assert_eq!(Search.name(), "search-web");
    assert_eq!(Search.description(), "Searches the web.");
    let spec = Search.tool_spec();
    assert_eq!(
        (spec.name.as_str(), spec.description.as_str()),
        ("search-web", "Searches the web.")
    );
}

#[test]
fn generated_structs_are_copy_default_and_debug() {
    let tool = Search;
    let copy = tool;
    fn default_of<T: Default>() -> T {
        T::default()
    }
    assert_eq!(format!("{:?}", default_of::<Search>()), "Search");
    assert_eq!(copy.name(), tool.name());
    let source = ToolSource::from(Search);
    assert_eq!(source.into_tools()[0].name(), "search-web");
}

/// Asks a human to approve, then reports the answer.
#[tool]
async fn approve(#[tool(context)] ctx: &ToolContext) -> Result<String, ToolError> {
    let answer = ctx.interrupt(InterruptParams::new("confirm").with_reason("approve?"))?;
    Ok(format!("approved: {answer}"))
}

#[tokio::test]
async fn an_interrupt_ends_the_tool_as_an_interrupt() {
    let (events, outcome) = run(&Approve, json!({})).await;
    assert!(events.is_empty());
    let ToolOutcome::Interrupt(interrupt) = outcome else {
        panic!("expected an interrupt, got {outcome:?}");
    };
    assert_eq!(
        serde_json::to_value(&interrupt.interrupts).unwrap(),
        json!([{"id": "tool:test-123:confirm", "name": "confirm", "reason": "approve?", "source": "tool"}])
    );
}

/// Asks with a preemptive answer.
#[tool]
async fn preapproved(#[tool(context)] ctx: &ToolContext) -> Result<String, ToolError> {
    let answer = ctx.interrupt(InterruptParams::new("confirm").with_response("yes"))?;
    Ok(format!("approved: {answer}"))
}

#[tokio::test]
async fn an_answered_interrupt_returns_the_response() {
    assert_eq!(
        result(&Preapproved, json!({})).await,
        success(&json!([{"text": "approved: \"yes\""}]))
    );
}

/// Returns a whole result.
#[tool]
async fn whole_result() -> ToolResultBlock {
    ToolResultBlock::error("ignored", vec![ToolResultContent::text("not found")])
}

/// Returns content.
#[tool]
async fn content() -> Vec<ToolResultContent> {
    vec![ToolResultContent::text("a"), ToolResultContent::json(json!({"b": 1}))]
}

/// Returns no content.
#[tool]
async fn no_content() -> Vec<ToolResultContent> {
    Vec::new()
}

/// Returns nothing.
#[tool]
async fn unit() {}

/// Returns a list.
#[tool]
async fn list() -> Vec<u32> {
    vec![1, 2]
}

/// Returns a flag.
#[tool]
async fn flag() -> bool {
    true
}

/// Returns nothing found.
#[tool]
async fn nothing() -> Option<String> {
    None
}

/// A shipping address.
#[derive(Deserialize, schemars::JsonSchema)]
struct Address {
    /// The city.
    city: String,
    /// Extra address lines.
    lines: Vec<String>,
}

/// A user with a nested address.
#[derive(Deserialize, schemars::JsonSchema)]
struct NestedUser {
    /// The user's name.
    name: String,
    /// The user's address.
    address: Address,
    /// Free-form tags.
    tags: HashMap<String, u32>,
}

/// Describes a user.
#[tool]
async fn describe_user(user: NestedUser) -> String {
    format!(
        "{} in {} ({} lines, {} tags)",
        user.name,
        user.address.city,
        user.address.lines.len(),
        user.tags.len()
    )
}

/// Returns a content-shaped value.
#[tool]
async fn content_value() -> JsonValue {
    json!({"text": "as text"})
}

/// Returns a map JSON cannot hold.
#[tool]
async fn unserializable() -> HashMap<(u8, u8), u8> {
    HashMap::from([((1, 2), 3)])
}

#[tokio::test]
async fn shapes_return_values_into_results() {
    assert_eq!(
        result(&WholeResult, json!({})).await,
        json!({"toolUseId": "test-123", "status": "error", "content": [{"text": "not found"}]})
    );
    assert_eq!(
        result(&Content, json!({})).await,
        success(&json!([{"text": "a"}, {"json": {"b": 1}}]))
    );
    assert_eq!(result(&NoContent, json!({})).await, success(&json!([])));
    assert_eq!(result(&Unit, json!({})).await, success(&json!([{"text": "null"}])));
    assert_eq!(
        result(&List, json!({})).await,
        success(&json!([{"json": {"$value": [1, 2]}}]))
    );
    assert_eq!(
        result(&ContentValue, json!({})).await,
        success(&json!([{"text": "as text"}]))
    );
    assert_eq!(
        result(&Unserializable, json!({})).await,
        error("Error: key must be a string")
    );
}

mod reexport {
    #[allow(
        clippy::single_component_path_imports,
        reason = "the module re-exports strands under a new path"
    )]
    pub(crate) use strands;
}

/// Uses a re-exported strands path.
#[tool(crate = "crate::reexport::strands")]
async fn reexported(value: String) -> String {
    value
}

#[tokio::test]
async fn generates_code_against_a_re_exported_crate_path() {
    assert_eq!(
        result(&Reexported, json!({"value": "ok"})).await,
        success(&json!([{"text": "ok"}]))
    );
}

struct Counter {
    count: AtomicU32,
    step: u32,
}

#[tools]
impl Counter {
    /// Adds the step to the counter and returns the total.
    #[tool]
    async fn increment(
        &self,
        /// How many steps to add.
        times: u32,
    ) -> Result<u32, ToolError> {
        let added = self.step * times;
        Ok(self.count.fetch_add(added, Ordering::SeqCst) + added)
    }

    /// Reads the counter.
    #[tool(name = "read-counter")]
    async fn read(&self, #[tool(context)] ctx: &ToolContext) -> String {
        format!("{} ({})", self.count.load(Ordering::SeqCst), ctx.tool_use().tool_use_id)
    }

    fn reset(&self) {
        self.count.store(0, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn tools_methods_share_the_state_of_their_value() {
    let counter = Arc::new(Counter {
        count: AtomicU32::new(0),
        step: 2,
    });
    let increment = counter.increment_tool();
    assert_json_in_order(
        &serde_json::to_value(increment.tool_spec()).unwrap(),
        &json!({
            "name": "increment",
            "description": "Adds the step to the counter and returns the total.",
            "inputSchema": {
                "type": "object",
                "properties": {"times": {"type": "integer", "description": "How many steps to add.", "minimum": 0}},
                "required": ["times"],
                "additionalProperties": false
            }
        }),
    );
    assert_eq!(
        result(&increment, json!({"times": 3})).await,
        success(&json!([{"text": "6"}]))
    );
    assert_eq!(
        result(&increment, json!({"times": 1})).await,
        success(&json!([{"text": "8"}]))
    );
    assert_eq!(
        result(&increment, json!({"times": -1})).await,
        error("Error: Validation failed:\n- /times: -1 is less than the minimum of 0")
    );

    let read = counter.read_tool();
    assert_eq!(read.name(), "read-counter");
    assert_eq!(read.tool_spec().input_schema.unwrap()["properties"], json!({}));
    assert_eq!(
        result(&read, json!({})).await,
        success(&json!([{"text": "8 (test-123)"}]))
    );

    counter.reset();
    assert_eq!(counter.increment(1).await.unwrap(), 2);
    let names: Vec<String> = counter
        .tools()
        .into_iter()
        .flat_map(ToolSource::into_tools)
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(names, ["increment", "read-counter"]);
}

/// The annotated function keeps its signature, so calling it yields the type it declares and takes
/// the declared parameter types. The type annotations are the assertions.
#[tokio::test]
async fn tool_macro_keeps_the_return_type() {
    let text: String = test_tool("hi".to_owned()).await;
    let number: f64 = add(1.0, 2.0).await;
    let total: f64 = sum(vec![1.0, 2.0]).await;
    let greeted: String = greeting("Ada".to_owned(), None).await;
    let items: Vec<u32> = list().await;
    let preferences: Preferences = get_preferences().await;
    let value: JsonValue = content_value().await;
    let fallible: Result<String, ToolError> = failing("x".to_owned()).await;
    let io: std::io::Result<String> = async_error("x".to_owned()).await;
    let () = unit().await;
    let yes: bool = flag().await;
    let missing: Option<String> = nothing().await;
    let user = NestedUser {
        name: "Ada".to_owned(),
        address: Address {
            city: "London".to_owned(),
            lines: vec!["1 Main St".to_owned()],
        },
        tags: HashMap::from([("admin".to_owned(), 1)]),
    };
    let described: String = describe_user(user).await;
    assert!(yes && missing.is_none());
    assert_eq!(described, "Ada in London (1 lines, 1 tags)");
    assert_eq!(text, "hi");
    assert!((number - 3.0).abs() < f64::EPSILON && (total - 3.0).abs() < f64::EPSILON);
    assert!(greeted.contains("Ada"));
    assert_eq!(items, [1, 2]);
    assert_eq!(preferences.theme, "dark");
    assert!(value.is_object());
    assert!(fallible.is_err() && io.is_err());
}
