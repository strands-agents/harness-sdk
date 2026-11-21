//! Runtime support for the code `#[tool]` and `#[tools]` generate. Not public API: anything here
//! may change in any release.

pub use std::sync::{Arc, LazyLock};

pub use schemars;
pub use serde;
pub use serde_json;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::error::BoxError;
use crate::tools::{SchemaValidator, ToolContext, ToolError, ToolOutcome, schema_for, wrap_in_tool_result};
use crate::types::{JsonSchema, JsonValue, ToolResultBlock, ToolResultContent, ToolSpec};

/// The input schema of a macro-generated tool and the validator for its input.
#[derive(Debug)]
pub struct ToolSchema {
    schema: JsonSchema,
    validator: Option<SchemaValidator>,
}

impl ToolSchema {
    /// The normalized schema of the generated input struct `T`.
    ///
    /// The spec keeps the root `additionalProperties: false` the struct declares, as its last key,
    /// but the validator ignores it: unknown keys are dropped rather than rejected.
    #[must_use]
    pub fn of<T: schemars::JsonSchema>() -> Self {
        let mut schema = schema_for::<T>();
        let mut lenient = schema.clone();
        if let JsonValue::Object(root) = &mut lenient {
            root.remove("additionalProperties");
        }
        if let JsonValue::Object(root) = &mut schema
            && let Some(additional) = root.shift_remove("additionalProperties")
        {
            root.insert("additionalProperties".to_owned(), additional);
        }
        let validator = SchemaValidator::new(&lenient)
            .inspect_err(|error| tracing::warn!("error=<{error}> | tool input schema does not compile"))
            .ok();
        Self { schema, validator }
    }

    /// The schema of a tool without parameters, which takes its input unvalidated.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
            validator: None,
        }
    }

    /// The tool spec.
    #[must_use]
    pub fn spec(&self, name: &str, description: &str) -> ToolSpec {
        ToolSpec::new(name, description).with_input_schema(self.schema.clone())
    }

    /// Validates the call's input and deserializes it into the input struct.
    ///
    /// # Errors
    ///
    /// The validation error, or the deserialization error for input the schema allows but serde
    /// rejects.
    pub fn parse<I: DeserializeOwned>(&self, context: &ToolContext) -> Result<I, ToolError> {
        let input = &context.tool_use().input;
        if let Some(validator) = &self.validator {
            validator.validate(input).map_err(ToolError::new)?;
        }
        serde_json::from_value(input.clone()).map_err(ToolError::new)
    }
}

/// Picks how a tool's return value becomes its result, by autoref specialization: a
/// [`ToolResultBlock`] and a `Vec<ToolResultContent>` are used as they are, any other
/// `Serialize` value is shaped like a [`FunctionTool`](crate::tools::FunctionTool) return value.
///
/// Call it as `(&&Shape(&value)).strands_kind().outcome(value, tool_use_id)` with all three
/// shape traits in scope.
#[derive(Debug)]
pub struct Shape<'a, T>(pub &'a T);

/// A [`ToolResultBlock`] return value.
#[derive(Debug, Clone, Copy)]
pub struct BlockKind;

/// A `Vec<ToolResultContent>` return value.
#[derive(Debug, Clone, Copy)]
pub struct ContentKind;

/// Any other `Serialize` return value.
#[derive(Debug, Clone, Copy)]
pub struct ValueKind;

/// Selects [`BlockKind`].
pub trait BlockShape {
    /// The kind.
    fn strands_kind(&self) -> BlockKind {
        BlockKind
    }
}

impl BlockShape for &Shape<'_, ToolResultBlock> {}

/// Selects [`ContentKind`].
pub trait ContentShape {
    /// The kind.
    fn strands_kind(&self) -> ContentKind {
        ContentKind
    }
}

impl ContentShape for &Shape<'_, Vec<ToolResultContent>> {}

/// Selects [`ValueKind`].
pub trait ValueShape {
    /// The kind.
    fn strands_kind(&self) -> ValueKind {
        ValueKind
    }
}

impl<T: Serialize> ValueShape for Shape<'_, T> {}

impl BlockKind {
    /// The block, answering this call's tool use.
    #[must_use]
    pub fn outcome(self, mut block: ToolResultBlock, tool_use_id: String) -> ToolOutcome {
        block.tool_use_id = tool_use_id;
        ToolOutcome::Result(block)
    }
}

impl ContentKind {
    /// A successful result with this content.
    #[must_use]
    pub fn outcome(self, content: Vec<ToolResultContent>, tool_use_id: String) -> ToolOutcome {
        ToolOutcome::Result(ToolResultBlock::success(tool_use_id, content))
    }
}

impl ValueKind {
    /// The serialized value shaped into a successful result, or an error result when it does not
    /// serialize.
    pub fn outcome<T: Serialize>(self, value: T, tool_use_id: String) -> ToolOutcome {
        match serde_json::to_value(value) {
            Ok(value) => ToolOutcome::Result(wrap_in_tool_result(value, tool_use_id)),
            Err(error) => ToolError::new(error).into_outcome(tool_use_id),
        }
    }
}

/// Picks how a tool's `Err` becomes a [`ToolError`], by autoref specialization: an error that
/// converts into `ToolError` (any `std::error::Error`, or `ToolError` itself) converts with
/// `Into`, and any other `Into<BoxError>` (`BoxError`, `String`, `&str`, `anyhow::Error`) goes
/// through [`ToolError::from_boxed`].
///
/// Call it as `(&&ErrorShape(&error)).strands_error_kind().into_tool_error(error)` with both
/// error shape traits in scope.
#[derive(Debug)]
pub struct ErrorShape<'a, E>(pub &'a E);

/// An error that converts into [`ToolError`].
#[derive(Debug, Clone, Copy)]
pub struct ToolErrorKind;

/// An error that converts into [`BoxError`].
#[derive(Debug, Clone, Copy)]
pub struct BoxErrorKind;

/// Selects [`ToolErrorKind`].
pub trait ToolErrorShape {
    /// The kind.
    fn strands_error_kind(&self) -> ToolErrorKind {
        ToolErrorKind
    }
}

impl<E: Into<ToolError>> ToolErrorShape for &ErrorShape<'_, E> {}

/// Selects [`BoxErrorKind`].
pub trait BoxErrorShape {
    /// The kind.
    fn strands_error_kind(&self) -> BoxErrorKind {
        BoxErrorKind
    }
}

impl<E> BoxErrorShape for ErrorShape<'_, E> {}

/// An error a `#[tool]` body returns that converts into [`BoxError`].
#[diagnostic::on_unimplemented(
    message = "`#[tool]` cannot turn `{Self}` into a tool error",
    label = "the error type of this `Result`",
    note = "return an error that implements `std::error::Error`, `ToolError`, or a type that converts into `strands::BoxError` (`String`, `&str`, `anyhow::Error`)"
)]
pub trait IntoBoxError {
    /// The error, boxed.
    fn into_box_error(self) -> BoxError;
}

impl<E: Into<BoxError>> IntoBoxError for E {
    fn into_box_error(self) -> BoxError {
        self.into()
    }
}

impl ToolErrorKind {
    /// The error, converted.
    pub fn into_tool_error<E: Into<ToolError>>(self, error: E) -> ToolError {
        error.into()
    }
}

impl BoxErrorKind {
    /// The error, boxed and wrapped.
    pub fn into_tool_error<E: IntoBoxError>(self, error: E) -> ToolError {
        ToolError::from_boxed(error.into_box_error())
    }
}
