//! A tool built from a callback.

use std::fmt;
use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use futures::{Stream, StreamExt};
use schemars::JsonSchema as SchemarsJsonSchema;
use serde_json::json;

use super::error::ToolError;
use super::schema::{SchemaValidator, schema_for};
use super::tool::{Tool, ToolContext, ToolOutcome, ToolStream, ToolStreamEvent, ToolStreamItem};
use crate::models::BoxStream;
use crate::types::{JsonSchema, JsonValue, ToolResultBlock, ToolResultContent, ToolSpec};

/// What a streaming [`FunctionTool`] callback yields (an async generator's `yield` and `return`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum FunctionToolItem {
    /// A progress value, surfaced as a [`ToolStreamEvent`].
    Update(JsonValue),
    /// The return value, wrapped in the tool result; the stream ends here.
    Return(JsonValue),
}

type Callback = Arc<dyn Fn(JsonValue, ToolContext) -> BoxFuture<'static, Result<JsonValue, ToolError>> + Send + Sync>;
type StreamCallback =
    Arc<dyn Fn(JsonValue, ToolContext) -> BoxStream<'static, Result<FunctionToolItem, ToolError>> + Send + Sync>;

#[derive(Clone)]
enum Body {
    Future(Callback),
    Stream(StreamCallback),
}

/// A tool that wraps a callback and shapes its return value into a result (`FunctionTool`).
///
/// The callback receives the raw input and the [`ToolContext`] and returns a JSON value, which
/// becomes the result content following these rules:
///
/// - a one-key object that reads as tool result content (`{"text": ..}`, `{"json": ..}`,
///   `{"image": ..}`, `{"video": ..}`, `{"document": ..}`) is used as is, and so is an array of
///   such objects;
/// - a string, number or boolean becomes text;
/// - `null` becomes the text `null`;
/// - any other array becomes JSON content `{"$value": [..]}`, and any other object JSON content.
///
/// An `Err` becomes an error result with the text `Error: <message>`, except an interrupt, which
/// ends the tool as [`ToolOutcome::Interrupt`].
///
/// ```
/// use serde_json::json;
/// use strands::tools::FunctionTool;
///
/// let greet = FunctionTool::builder("greeter", "Greets a person by name")
///     .input_schema(json!({
///         "type": "object",
///         "properties": {"name": {"type": "string"}},
///         "required": ["name"]
///     }))
///     .callback(|input, _context| async move { Ok(format!("Hello, {}!", input["name"].as_str().unwrap_or("you")).into()) });
/// # let _ = greet;
/// ```
#[derive(Clone)]
pub struct FunctionTool {
    spec: ToolSpec,
    validator: Option<Arc<SchemaValidator>>,
    body: Body,
}

/// Builds a [`FunctionTool`]; finish with [`callback`](Self::callback) or
/// [`stream_callback`](Self::stream_callback).
#[derive(Debug)]
pub struct FunctionToolBuilder {
    name: String,
    description: String,
    input_schema: Option<JsonSchema>,
    validator: Option<Arc<SchemaValidator>>,
}

impl FunctionTool {
    /// Starts a tool with a name and description.
    pub fn builder(name: impl Into<String>, description: impl Into<String>) -> FunctionToolBuilder {
        FunctionToolBuilder {
            name: name.into(),
            description: description.into(),
            input_schema: None,
            validator: None,
        }
    }

    async fn run_future(
        callback: Callback,
        validator: Option<Arc<SchemaValidator>>,
        context: ToolContext,
    ) -> ToolOutcome {
        let tool_use_id = context.tool_use().tool_use_id.clone();
        let input = context.tool_use().input.clone();
        if let Some(error) = validator.and_then(|validator| validator.validate(&input).err()) {
            return ToolError::new(error).into_outcome(tool_use_id);
        }
        match callback(input, context).await {
            Ok(value) => wrap_in_tool_result(value, tool_use_id).into(),
            Err(error) => error.into_outcome(tool_use_id),
        }
    }

    fn run_stream(callback: &StreamCallback, validator: Option<&SchemaValidator>, context: ToolContext) -> ToolStream {
        let tool_use_id = context.tool_use().tool_use_id.clone();
        let input = context.tool_use().input.clone();
        if let Some(error) = validator.and_then(|validator| validator.validate(&input).err()) {
            return ToolStream::ready(ToolError::new(error).into_outcome(tool_use_id));
        }
        let items = callback(input, context);
        ToolStream::new(async_stream::stream! {
            futures::pin_mut!(items);
            while let Some(item) = items.next().await {
                match item {
                    Ok(FunctionToolItem::Update(data)) => yield ToolStreamItem::Event(ToolStreamEvent::new(data)),
                    Ok(FunctionToolItem::Return(value)) => {
                        yield ToolStreamItem::Outcome(wrap_in_tool_result(value, tool_use_id.clone()).into());
                        return;
                    }
                    Err(error) => {
                        yield ToolStreamItem::Outcome(error.into_outcome(tool_use_id.clone()));
                        return;
                    }
                }
            }
            yield ToolStreamItem::Outcome(wrap_in_tool_result(JsonValue::Null, tool_use_id).into());
        })
    }
}

impl FunctionToolBuilder {
    /// Sets the input JSON Schema. Without one the tool takes an empty object
    /// (`{"type":"object","properties":{},"additionalProperties":false}`). The input is passed to
    /// the callback as given, unvalidated.
    #[must_use]
    pub fn input_schema(mut self, schema: JsonSchema) -> Self {
        self.input_schema = Some(schema);
        self.validator = None;
        self
    }

    /// Uses the normalized schema of `T` as the input schema and validates the input against it
    /// before calling the callback; invalid input becomes an error result listing the violations.
    #[must_use]
    pub fn input_schema_for<T: SchemarsJsonSchema>(mut self) -> Self {
        let schema = schema_for::<T>();
        self.validator = SchemaValidator::new(&schema).ok().map(Arc::new);
        self.input_schema = Some(schema);
        self
    }

    fn spec(&self) -> ToolSpec {
        let schema = self
            .input_schema
            .clone()
            .unwrap_or_else(|| json!({"type": "object", "properties": {}, "additionalProperties": false}));
        ToolSpec::new(&self.name, &self.description).with_input_schema(schema)
    }

    /// Finishes the tool with an async callback that returns the result value.
    pub fn callback<F, Fut>(self, callback: F) -> FunctionTool
    where
        F: Fn(JsonValue, ToolContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<JsonValue, ToolError>> + Send + 'static,
    {
        let callback: Callback = Arc::new(move |input, context| Box::pin(callback(input, context)));
        FunctionTool {
            spec: self.spec(),
            validator: self.validator,
            body: Body::Future(callback),
        }
    }

    /// Finishes the tool with a streaming callback: each [`FunctionToolItem::Update`] becomes a
    /// progress event and [`FunctionToolItem::Return`] the result. A stream that ends without a
    /// return value returns `null`.
    pub fn stream_callback<F, S>(self, callback: F) -> FunctionTool
    where
        F: Fn(JsonValue, ToolContext) -> S + Send + Sync + 'static,
        S: Stream<Item = Result<FunctionToolItem, ToolError>> + Send + 'static,
    {
        let callback: StreamCallback = Arc::new(move |input, context| Box::pin(callback(input, context)));
        FunctionTool {
            spec: self.spec(),
            validator: self.validator,
            body: Body::Stream(callback),
        }
    }
}

impl Tool for FunctionTool {
    fn name(&self) -> &str {
        &self.spec.name
    }

    fn description(&self) -> &str {
        &self.spec.description
    }

    fn tool_spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        match &self.body {
            Body::Future(callback) => {
                ToolStream::from_future(Self::run_future(callback.clone(), self.validator.clone(), context))
            }
            Body::Stream(callback) => Self::run_stream(callback, self.validator.as_deref(), context),
        }
    }
}

impl fmt::Debug for FunctionTool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FunctionTool")
            .field("spec", &self.spec)
            .finish_non_exhaustive()
    }
}

/// Shapes a tool's return value into a successful result; see
/// [`FunctionTool`] for the rules.
#[must_use]
pub(crate) fn wrap_in_tool_result(value: JsonValue, tool_use_id: impl Into<String>) -> ToolResultBlock {
    ToolResultBlock::success(tool_use_id, result_content(value))
}

fn result_content(value: JsonValue) -> Vec<ToolResultContent> {
    if let Some(content) = as_tool_result_content(&value) {
        return vec![content];
    }
    match value {
        JsonValue::Null => vec![ToolResultContent::text("null")],
        JsonValue::String(text) => vec![ToolResultContent::text(text)],
        JsonValue::Bool(flag) => vec![ToolResultContent::text(flag.to_string())],
        JsonValue::Number(number) => vec![ToolResultContent::text(js_number_string(&number))],
        JsonValue::Array(items) => content_list(&items)
            .unwrap_or_else(|| vec![ToolResultContent::json(json!({"$value": JsonValue::Array(items)}))]),
        object @ JsonValue::Object(_) => vec![ToolResultContent::json(object)],
    }
}

fn content_list(items: &[JsonValue]) -> Option<Vec<ToolResultContent>> {
    if items.is_empty() {
        return None;
    }
    items.iter().map(as_tool_result_content).collect()
}

/// A one-key object that parses as tool result content; other values are not content.
fn as_tool_result_content(value: &JsonValue) -> Option<ToolResultContent> {
    let JsonValue::Object(map) = value else {
        return None;
    };
    if map.len() != 1 {
        return None;
    }
    ToolResultContent::from_data(value.clone()).ok()
}

/// Formats a number as text, writing integral floats below 1e21 without a fraction (`2.0` as `2`).
fn js_number_string(number: &serde_json::Number) -> String {
    const MAX_PLAIN_INTEGER: f64 = 1e21;
    match number.as_f64() {
        Some(float) if number.is_f64() && float.fract() == 0.0 && float.abs() < MAX_PLAIN_INTEGER => {
            format!("{float:.0}")
        }
        _ => number.to_string(),
    }
}

#[cfg(test)]
mod tests;
