//! The tool that validates structured output.

use std::fmt;
use std::sync::Arc;

use schemars::JsonSchema as SchemarsJsonSchema;

use super::schema::{SchemaValidator, schema_for};
use super::tool::{Tool, ToolContext, ToolStream};
use crate::error::{Result, StructuredOutputError};
use crate::types::{ContentBlock, JsonSchema, JsonValue, Message, ToolResultBlock, ToolResultContent, ToolSpec};

/// The name of the structured output tool.
pub const STRUCTURED_OUTPUT_TOOL_NAME: &str = "strands_structured_output";

/// The error text when the model neither called the structured output tool nor returned a JSON
/// object.
pub(crate) const NO_STRUCTURED_OUTPUT_MESSAGE: &str = "The model did not produce structured output: it neither called the structured output tool nor returned a JSON object.";

const INSTRUCTION: &str =
    "This tool MUST only be invoked as the last and final tool before returning the completed result to the caller.";

/// Validates the model's structured output against a JSON Schema (`StructuredOutputTool`).
///
/// A valid input is the result, as JSON content; an invalid one is an error result listing the
/// violations, so the model can retry. The schema's top-level `description` is added to the tool
/// description.
#[derive(Clone)]
pub struct StructuredOutputTool {
    spec: ToolSpec,
    validator: Arc<SchemaValidator>,
}

impl StructuredOutputTool {
    /// Creates the tool for a JSON Schema.
    ///
    /// # Errors
    ///
    /// When `schema` is not a valid JSON Schema.
    pub fn new(schema: JsonSchema) -> Result<Self> {
        let validator = Arc::new(SchemaValidator::new(&schema)?);
        let description = match schema.get("description").and_then(JsonValue::as_str) {
            Some(description) => format!("{INSTRUCTION}\n<description>{description}</description>"),
            None => INSTRUCTION.to_owned(),
        };
        let spec = ToolSpec::new(STRUCTURED_OUTPUT_TOOL_NAME, description).with_input_schema(schema);
        Ok(Self { spec, validator })
    }

    /// Creates the tool for the normalized schema of `T`.
    ///
    /// # Errors
    ///
    /// When the generated schema does not compile.
    pub fn for_type<T: SchemarsJsonSchema>() -> Result<Self> {
        Self::new(schema_for::<T>())
    }

    /// Validates the text of an assistant message as structured output, for
    /// providers that return it as JSON text instead of calling the tool. The text blocks, joined,
    /// must be exactly one JSON object.
    ///
    /// # Errors
    ///
    /// [`StructuredOutputError`] when the text is not a JSON object, or the object does not
    /// validate (`Structured output failed validation: ...`).
    pub fn result_from_text(&self, message: &Message) -> Result<JsonValue> {
        let text: String = message.content.iter().filter_map(ContentBlock::as_text).collect();
        let data = serde_json::from_str::<JsonValue>(&text)
            .ok()
            .filter(JsonValue::is_object)
            .ok_or_else(|| StructuredOutputError::new(NO_STRUCTURED_OUTPUT_MESSAGE))?;
        self.validator.validate(&data).map_err(|error| {
            StructuredOutputError::new(format!("Structured output failed validation: {}", error.message))
        })?;
        Ok(data)
    }
}

impl Tool for StructuredOutputTool {
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
        let tool_use = context.tool_use();
        let result = match self.validator.validate(&tool_use.input) {
            Ok(()) => ToolResultBlock::success(
                tool_use.tool_use_id.clone(),
                vec![ToolResultContent::json(tool_use.input.clone())],
            ),
            Err(error) => ToolResultBlock::error(
                tool_use.tool_use_id.clone(),
                vec![ToolResultContent::text(error.message.clone())],
            )
            .with_error(error),
        };
        ToolStream::ready(result)
    }
}

impl fmt::Debug for StructuredOutputTool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StructuredOutputTool")
            .field("spec", &self.spec)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Error;
    use crate::testing::tool_context;
    use crate::tools::ToolOutcome;
    use crate::types::{ReasoningBlock, Role, ToolResultStatus, ToolUse};

    fn person_schema() -> JsonSchema {
        json!({
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
            "required": ["name", "age"]
        })
    }

    async fn run(tool: &StructuredOutputTool, input: JsonValue) -> ToolResultBlock {
        let context = tool_context(ToolUse::new(STRUCTURED_OUTPUT_TOOL_NAME, "tool-1", input));
        match tool.stream(context).run(|_| {}).await {
            Some(ToolOutcome::Result(result)) => result,
            other => panic!("expected a result, got {other:?}"),
        }
    }

    fn text_of(result: &ToolResultBlock) -> String {
        match &result.content[0] {
            ToolResultContent::Text(text) => text.text.clone(),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn builds_tool_spec_from_schema() {
        let mut schema = person_schema();
        schema["description"] = json!("A person schema");
        let tool = StructuredOutputTool::new(schema).unwrap();
        assert_eq!(tool.name(), STRUCTURED_OUTPUT_TOOL_NAME);
        assert_eq!(tool.tool_spec().name, STRUCTURED_OUTPUT_TOOL_NAME);
        assert!(tool.tool_spec().input_schema.is_some());
        assert_eq!(
            tool.description(),
            format!("{INSTRUCTION}\n<description>A person schema</description>")
        );
    }

    #[test]
    fn uses_base_description_when_schema_has_no_description() {
        let tool = StructuredOutputTool::new(person_schema()).unwrap();
        assert!(tool.description().contains("MUST only be invoked"));
        assert!(!tool.description().contains("<description>"));
    }

    #[test]
    fn builds_the_schema_of_a_type_with_its_doc_comment() {
        /// A person.
        #[derive(schemars::JsonSchema)]
        #[allow(dead_code, reason = "schema-only type")]
        struct Person {
            name: String,
        }
        let tool = StructuredOutputTool::for_type::<Person>().unwrap();
        assert!(tool.description().ends_with("<description>A person.</description>"));
    }

    #[tokio::test]
    async fn returns_success_with_validated_json_for_valid_input() {
        let tool = StructuredOutputTool::new(person_schema()).unwrap();
        let result = run(&tool, json!({"name": "John", "age": 30})).await;
        assert_eq!(
            result,
            ToolResultBlock::success(
                "tool-1",
                vec![ToolResultContent::json(json!({"name": "John", "age": 30}))]
            )
        );
    }

    #[tokio::test]
    async fn returns_error_with_validation_error_for_invalid_input() {
        let tool = StructuredOutputTool::new(person_schema()).unwrap();
        let result = run(&tool, json!({"name": "John", "age": "invalid"})).await;
        assert_eq!(result.status, ToolResultStatus::Error);
        assert!(result.error.is_some());
        assert!(text_of(&result).contains("age"));
    }

    #[tokio::test]
    async fn includes_validation_details_for_multiple_fields() {
        let schema = json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "number"},
                "email": {"type": "string", "pattern": "^[^@]+@[^@]+$"}
            },
            "required": ["name", "age", "email"]
        });
        let tool = StructuredOutputTool::new(schema).unwrap();
        let result = run(&tool, json!({"name": 123, "age": "invalid", "email": "not-email"})).await;
        assert_eq!(result.status, ToolResultStatus::Error);
        let text = text_of(&result);
        assert!(
            text.contains("name") && text.contains("age") && text.contains("email"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn validates_nested_objects() {
        let schema = json!({
            "type": "object",
            "properties": {"user": person_schema()},
            "required": ["user"]
        });
        let tool = StructuredOutputTool::new(schema).unwrap();
        let result = run(&tool, json!({"user": {"name": "John", "age": 30}})).await;
        assert_eq!(result.status, ToolResultStatus::Success);
        assert_eq!(
            result.content,
            vec![ToolResultContent::json(json!({"user": {"name": "John", "age": 30}}))]
        );
    }

    #[tokio::test]
    async fn validates_arrays() {
        let schema = json!({"type": "object", "properties": {"items": {"type": "array", "items": {"type": "string"}}}});
        let tool = StructuredOutputTool::new(schema).unwrap();
        let result = run(&tool, json!({"items": ["a", "b", "c"]})).await;
        assert_eq!(
            result.content,
            vec![ToolResultContent::json(json!({"items": ["a", "b", "c"]}))]
        );
    }

    #[tokio::test]
    async fn handles_optional_fields() {
        let schema = json!({
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
            "required": ["name"]
        });
        let tool = StructuredOutputTool::new(schema).unwrap();
        let result = run(&tool, json!({"name": "John"})).await;
        assert_eq!(result.status, ToolResultStatus::Success);
        assert_eq!(result.content, vec![ToolResultContent::json(json!({"name": "John"}))]);
    }

    fn assistant(content: Vec<ContentBlock>) -> Message {
        Message::new(Role::Assistant, content)
    }

    #[test]
    fn returns_the_validated_json_object_from_the_text_blocks_ignoring_reasoning() {
        let tool = StructuredOutputTool::new(person_schema()).unwrap();
        let message = assistant(vec![
            ReasoningBlock::new().with_text("thinking").into(),
            ContentBlock::text(r#"{"name": "John", "#),
            ContentBlock::text(r#""age": 30, "extra": true}"#),
        ]);
        assert_eq!(
            tool.result_from_text(&message).unwrap(),
            json!({"name": "John", "age": 30, "extra": true})
        );
    }

    #[test]
    fn throws_the_no_structured_output_error_for_non_objects() {
        let tool = StructuredOutputTool::new(person_schema()).unwrap();
        for text in ["John is 30", r#"[{"name": "John", "age": 30}]"#, "42", "null", ""] {
            let error = tool
                .result_from_text(&assistant(vec![ContentBlock::text(text)]))
                .unwrap_err();
            assert!(matches!(error, Error::StructuredOutput(_)), "{text}");
            assert_eq!(error.to_string(), NO_STRUCTURED_OUTPUT_MESSAGE);
        }
    }

    #[test]
    fn throws_a_validation_error_for_an_object_that_does_not_match_the_schema() {
        let tool = StructuredOutputTool::new(person_schema()).unwrap();
        let message = assistant(vec![ContentBlock::text(r#"{"name": "John", "age": "thirty"}"#)]);
        let error = tool.result_from_text(&message).unwrap_err();
        assert!(matches!(error, Error::StructuredOutput(_)));
        let text = error.to_string();
        assert!(text.starts_with("Structured output failed validation: "), "{text}");
        assert!(text.contains("age"), "{text}");
    }
}
