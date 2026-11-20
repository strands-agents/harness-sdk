//! Tool wire types.

use serde::de::Error as _;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::json::{JsonObject, JsonSchema, JsonValue};

/// Describes a tool to the model (`ToolSpec`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolSpec {
    /// The unique name of the tool.
    pub name: String,
    /// What the tool does, so the model knows when to use it.
    pub description: String,
    /// JSON Schema for the tool input. Tools default it to an empty object schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<JsonSchema>,
    /// JSON Schema for the tool output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<JsonSchema>,
    /// Untrusted tool-behaviour hints such as MCP `readOnlyHint`. Never sent to providers and never
    /// a security boundary; a missing key means unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<JsonObject>,
}

impl ToolSpec {
    /// Creates a spec with a name and description.
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema: None,
            output_schema: None,
            annotations: None,
        }
    }

    /// Sets the input schema.
    #[must_use]
    pub fn with_input_schema(mut self, schema: JsonSchema) -> Self {
        self.input_schema = Some(schema);
        self
    }

    /// Sets the output schema.
    #[must_use]
    pub fn with_output_schema(mut self, schema: JsonSchema) -> Self {
        self.output_schema = Some(schema);
        self
    }

    /// Sets the annotations.
    #[must_use]
    pub fn with_annotations(mut self, annotations: JsonObject) -> Self {
        self.annotations = Some(annotations);
        self
    }
}

/// A tool invocation request (`ToolUse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolUse {
    /// The name of the tool to execute.
    pub name: String,
    /// Identifier that matches the result back to this request.
    pub tool_use_id: String,
    /// The tool input.
    pub input: JsonValue,
}

impl ToolUse {
    /// Creates a tool use.
    pub fn new(name: impl Into<String>, tool_use_id: impl Into<String>, input: JsonValue) -> Self {
        Self {
            name: name.into(),
            tool_use_id: tool_use_id.into(),
            input,
        }
    }
}

/// Outcome of a tool execution (`ToolResultStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum ToolResultStatus {
    /// The tool succeeded.
    Success,
    /// The tool failed.
    Error,
}

/// How the model chooses a tool (`ToolChoice`).
///
/// Wire shapes: `{"auto":{}}`, `{"any":{}}` and `{"tool":{"name":"..."}}`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ToolChoice {
    /// The model decides whether to use a tool.
    Auto,
    /// The model must use one of the available tools.
    Any,
    /// The model must use the named tool.
    Tool {
        /// The tool name.
        name: String,
    },
}

impl ToolChoice {
    /// Forces the named tool.
    pub fn tool(name: impl Into<String>) -> Self {
        Self::Tool { name: name.into() }
    }
}

#[derive(Serialize, Deserialize)]
struct NamedTool {
    name: String,
}

impl Serialize for ToolChoice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        match self {
            Self::Auto => map.serialize_entry("auto", &JsonObject::new())?,
            Self::Any => map.serialize_entry("any", &JsonObject::new())?,
            Self::Tool { name } => map.serialize_entry("tool", &NamedTool { name: name.clone() })?,
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ToolChoice {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut map = JsonObject::deserialize(deserializer)?;
        if map.contains_key("auto") {
            return Ok(Self::Auto);
        }
        if map.contains_key("any") {
            return Ok(Self::Any);
        }
        let Some(tool) = map.remove("tool") else {
            return Err(D::Error::custom("Unknown ToolChoice type"));
        };
        let named = NamedTool::deserialize(tool).map_err(D::Error::custom)?;
        Ok(Self::Tool { name: named.name })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn tool_choice_wire_shapes() {
        let cases = [
            (ToolChoice::Auto, json!({"auto": {}})),
            (ToolChoice::Any, json!({"any": {}})),
            (ToolChoice::tool("calculator"), json!({"tool": {"name": "calculator"}})),
        ];
        for (choice, wire) in cases {
            assert_eq!(serde_json::to_value(&choice).unwrap(), wire);
            assert_eq!(serde_json::from_value::<ToolChoice>(wire).unwrap(), choice);
        }
    }

    #[test]
    fn tool_choice_rejects_unknown_shapes() {
        let error = serde_json::from_value::<ToolChoice>(json!({"none": {}})).unwrap_err();
        assert_eq!(error.to_string(), "Unknown ToolChoice type");
    }

    #[test]
    fn tool_spec_omits_absent_optionals() {
        assert_eq!(
            serde_json::to_value(ToolSpec::new("a", "b")).unwrap(),
            json!({"name": "a", "description": "b"})
        );
    }

    #[test]
    fn tool_spec_serializes_schemas_and_annotations_in_ts_order() {
        let mut annotations = JsonObject::new();
        annotations.insert("readOnlyHint".into(), json!(true));
        let spec = ToolSpec::new("get_weather", "Get the weather")
            .with_input_schema(json!({"type": "object"}))
            .with_output_schema(json!({"type": "string"}))
            .with_annotations(annotations);
        assert_eq!(
            serde_json::to_string(&spec).unwrap(),
            r#"{"name":"get_weather","description":"Get the weather","inputSchema":{"type":"object"},"outputSchema":{"type":"string"},"annotations":{"readOnlyHint":true}}"#
        );
    }

    #[test]
    fn tool_use_uses_camel_case_keys() {
        let tool_use = ToolUse::new("calc", "t-1", json!({"a": 1}));
        assert_eq!(
            serde_json::to_value(&tool_use).unwrap(),
            json!({"name": "calc", "toolUseId": "t-1", "input": {"a": 1}})
        );
    }
}
