//! [`McpTool`], a tool that proxies calls to an MCP server.

use std::fmt;

use super::client::{McpCallToolOptions, McpClient};
use super::error::{McpError, URL_ELICITATION_REQUIRED};
use crate::error::Error;
use crate::tools::{Tool, ToolContext, ToolOutcome, ToolStream, create_error_result};
use crate::types::media::base64_bytes;
use crate::types::{
    ImageBlock, ImageFormat, ImageSource, JsonObject, JsonSchema, JsonValue, ToolResultBlock, ToolResultContent,
    ToolSpec,
};

const NO_OUTPUT: &str = "Tool execution completed successfully with no output.";

/// What an [`McpTool`] is built from (`McpToolConfig`).
#[derive(Debug, Clone, bon::Builder)]
#[builder(on(String, into))]
#[non_exhaustive]
pub struct McpToolConfig {
    /// The agent-facing tool name.
    pub name: String,
    /// What the tool does.
    pub description: String,
    /// JSON Schema for the input.
    pub input_schema: JsonSchema,
    /// JSON Schema for the output.
    pub output_schema: Option<JsonSchema>,
    /// The server's behaviour hints, such as `readOnlyHint`.
    pub annotations: Option<JsonObject>,
    /// The client that runs the tool.
    pub client: McpClient,
}

/// A tool that proxies calls to an MCP server (`McpTool`).
///
/// [`McpClient::list_tools`] builds these. The tool is invoked under its server-side name, which
/// differs from [`name`](Tool::name) when the client sets a prefix.
#[derive(Clone)]
pub struct McpTool {
    name: String,
    description: String,
    tool_spec: ToolSpec,
    server_tool_name: String,
    client: McpClient,
}

impl McpTool {
    /// Creates a tool invoked on the server under `config.name`.
    #[must_use]
    pub fn new(config: McpToolConfig) -> Self {
        let server_tool_name = config.name.clone();
        Self::listed(config, server_tool_name)
    }

    pub(crate) fn listed(config: McpToolConfig, server_tool_name: String) -> Self {
        let mut tool_spec =
            ToolSpec::new(config.name.clone(), config.description.clone()).with_input_schema(config.input_schema);
        tool_spec.output_schema = config.output_schema;
        tool_spec.annotations = config.annotations;
        Self {
            name: config.name,
            description: config.description,
            tool_spec,
            server_tool_name,
            client: config.client,
        }
    }

    /// The MCP client this tool belongs to.
    #[must_use]
    pub fn mcp_client(&self) -> &McpClient {
        &self.client
    }

    /// The name the server lists the tool under.
    #[must_use]
    pub fn server_tool_name(&self) -> &str {
        &self.server_tool_name
    }
}

impl fmt::Debug for McpTool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpTool")
            .field("name", &self.name)
            .field("server_tool_name", &self.server_tool_name)
            .finish_non_exhaustive()
    }
}

impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn tool_spec(&self) -> ToolSpec {
        self.tool_spec.clone()
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let tool = self.clone();
        ToolStream::from_future(async move {
            let tool_use_id = context.tool_use().tool_use_id.clone();
            let options = McpCallToolOptions {
                cancel_signal: Some(context.cancel_signal().clone()),
                ..McpCallToolOptions::default()
            };
            let result = tool
                .client
                .call_tool(&tool, context.tool_use().input.clone(), options)
                .await;
            ToolOutcome::Result(tool_result(tool_use_id, result))
        })
    }
}

/// Translates a `tools/call` outcome into a tool result.
pub(crate) fn tool_result(tool_use_id: String, result: Result<JsonValue, Error>) -> ToolResultBlock {
    let raw = match result {
        Ok(raw) => raw,
        Err(error) => return error_result(tool_use_id, error),
    };
    let Some(items) = raw.get("content").and_then(JsonValue::as_array) else {
        return create_error_result(
            "Invalid tool result from MCP Client: missing content array",
            tool_use_id,
        );
    };
    let mut content: Vec<ToolResultContent> = items.iter().map(map_content).collect();
    if content.is_empty() {
        content.push(ToolResultContent::text(NO_OUTPUT));
    }
    let is_error = raw.get("isError").is_some_and(is_truthy);
    if is_error {
        ToolResultBlock::error(tool_use_id, content)
    } else {
        ToolResultBlock::success(tool_use_id, content)
    }
}

fn is_truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(value) => *value,
        JsonValue::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        JsonValue::String(text) => !text.is_empty(),
        JsonValue::Array(_) | JsonValue::Object(_) => true,
    }
}

fn error_result(tool_use_id: String, error: Error) -> ToolResultBlock {
    if let Error::Mcp(mcp) = &error
        && let Some(elicitations) = url_elicitations(mcp)
    {
        let text = format!(
            "MCP Elicitation required: [{}] with data {}",
            mcp.to_js_string(),
            JsonValue::Array(elicitations.clone())
        );
        return ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(text)]);
    }
    create_error_result(error, tool_use_id)
}

fn url_elicitations(error: &McpError) -> Option<&Vec<JsonValue>> {
    let McpError::Protocol {
        code: URL_ELICITATION_REQUIRED,
        data: Some(data),
        ..
    } = error
    else {
        return None;
    };
    data.get("elicitations")
        .and_then(JsonValue::as_array)
        .filter(|elicitations| !elicitations.is_empty())
}

/// Maps one MCP content item to tool result content.
pub(crate) fn map_content(item: &JsonValue) -> ToolResultContent {
    let Some(record) = item.as_object() else {
        return ToolResultContent::json(item.clone());
    };
    match record.get("type").and_then(JsonValue::as_str) {
        Some("text") => match record.get("text").and_then(JsonValue::as_str) {
            Some(text) => ToolResultContent::text(text),
            None => ToolResultContent::json(item.clone()),
        },
        Some("image") => map_image(record, item),
        Some("resource") => map_embedded_resource(record, item),
        _ => ToolResultContent::json(item.clone()),
    }
}

fn image_format(mime_type: &str) -> Option<ImageFormat> {
    let format = crate::mime::to_media_format(mime_type)?;
    serde_json::from_value(JsonValue::String(format.to_owned())).ok()
}

fn image_block(format: ImageFormat, data: &str) -> Option<ToolResultContent> {
    let bytes = base64_bytes::decode(data).ok()?;
    Some(ToolResultContent::Image(ImageBlock::new(
        format,
        ImageSource::Bytes(bytes),
    )))
}

fn map_image(record: &JsonObject, item: &JsonValue) -> ToolResultContent {
    let data = record.get("data").and_then(JsonValue::as_str);
    let mime_type = record.get("mimeType").and_then(JsonValue::as_str);
    let (Some(data), Some(mime_type)) = (data, mime_type) else {
        tracing::warn!("content_type=<image> | mcp image content missing data or mimeType, falling back to json");
        return ToolResultContent::json(item.clone());
    };
    let Some(format) = image_format(mime_type) else {
        tracing::warn!("mime_type=<{mime_type}> | unsupported mcp image mime type, falling back to json");
        return ToolResultContent::json(item.clone());
    };
    image_block(format, data).unwrap_or_else(|| ToolResultContent::json(item.clone()))
}

fn map_embedded_resource(record: &JsonObject, item: &JsonValue) -> ToolResultContent {
    let Some(resource) = record.get("resource").and_then(JsonValue::as_object) else {
        return ToolResultContent::json(item.clone());
    };
    if let Some(text) = resource.get("text").and_then(JsonValue::as_str) {
        return ToolResultContent::text(text);
    }
    let blob = resource.get("blob").and_then(JsonValue::as_str);
    let mime_type = resource.get("mimeType").and_then(JsonValue::as_str);
    let (Some(blob), Some(mime_type)) = (blob, mime_type) else {
        return ToolResultContent::json(item.clone());
    };
    if let Some(block) = image_format(mime_type).and_then(|format| image_block(format, blob)) {
        return block;
    }
    tracing::warn!("mime_type=<{mime_type}> | unsupported mcp resource blob mime type, falling back to json");
    ToolResultContent::json(item.clone())
}
