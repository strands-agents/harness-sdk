//! The `retrieve_context` tool: reads content the context manager offloaded to its stash.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use serde::Deserialize;
use serde_json::json;

use super::search::{LineRange, SearchInput, is_searchable_content, search_content};
use super::stash::{Stash, is_offload_placeholder_data};
use crate::error::Result;
use crate::experimental::context_manager::js_text::{js_len, js_prefix};
use crate::tools::{SchemaValidator, Tool, ToolContext, ToolError, ToolOutcome, ToolStream, wrap_in_tool_result};
use crate::types::{ContentBlock, JsonValue, Message, Role, ToolResultContent, ToolSpec};

/// The tool's name (`RETRIEVAL_TOOL_NAME`).
pub(crate) const RETRIEVAL_TOOL_NAME: &str = "retrieve_context";

const DEFAULT_MAX_RESULT_TOKENS: usize = 10_000;
const CHARS_PER_TOKEN: usize = 4;

const DESCRIPTION: &str = "Retrieve content that was offloaded from context.

When content is offloaded (truncated, dropped, or summarized), the original is persisted and a reference key is left in its place. Use this tool with that reference to access the original content.

Options:
  - pattern: regex/keyword to find matching lines with context
  - line_range: { start, end } to read a specific span
  - Without pattern/line_range: returns the full original content

Examples:
  { reference: \"1_toolu_abc_0\", pattern: \"error\" }
  { reference: \"1_toolu_abc_0\", line_range: { start: 10, end: 25 } }
  { reference: \"1_toolu_abc_0\" }";

fn input_schema() -> JsonValue {
    json!({
        "type": "object",
        "properties": {
            "reference": {"type": "string", "description": "The reference key from the offload placeholder."},
            "pattern": {
                "type": "string",
                "description": "Regex or keyword to grep for. Returns matching lines with context."
            },
            "line_range": {
                "type": "object",
                "properties": {
                    "start": {"type": "integer", "minimum": 1, "description": "First line to return (1-indexed)."},
                    "end": {"type": "integer", "minimum": 1, "description": "Last line to return (1-indexed)."}
                },
                "required": ["start", "end"],
                "additionalProperties": false,
                "description": "Return only this span of lines."
            },
            "context_lines": {
                "type": "integer",
                "minimum": 0,
                "description": "Lines of context around each match (default: 5)."
            }
        },
        "required": ["reference"],
        "additionalProperties": false
    })
}

static VALIDATOR: LazyLock<Option<SchemaValidator>> = LazyLock::new(|| SchemaValidator::new(&input_schema()).ok());

#[derive(Debug, Deserialize)]
struct LineRangeInput {
    start: usize,
    end: usize,
}

/// The tool's input.
#[derive(Debug, Deserialize)]
pub(crate) struct RetrievalInput {
    reference: String,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    line_range: Option<LineRangeInput>,
    #[serde(default)]
    context_lines: Option<usize>,
}

/// Restores image, document and video data as tool result content.
fn restore_media(data: &JsonValue) -> Option<JsonValue> {
    let object = data.as_object()?;
    if !["image", "document", "video"]
        .iter()
        .any(|key| object.contains_key(*key))
    {
        return None;
    }
    let content = ToolResultContent::from_data(data.clone()).ok()?;
    serde_json::to_value(content).ok()
}

fn extract_text(data: &JsonValue) -> Option<String> {
    if let Some(text) = data.as_str() {
        return Some(text.to_owned());
    }
    let object = data.as_object()?;
    if let Some(text) = object.get("text").and_then(JsonValue::as_str) {
        return Some(text.to_owned());
    }
    object
        .get("json")
        .and_then(|json| serde_json::to_string_pretty(json).ok())
}

/// Reads a stash reference as the tool's return value.
///
/// # Errors
///
/// The stash's read error.
pub(crate) async fn retrieve_context(stash: &Stash, input: RetrievalInput, max_chars: usize) -> Result<JsonValue> {
    let Some(data) = stash.retrieve(&input.reference).await? else {
        return Ok(JsonValue::String(format!(
            "Error: reference not found: {}",
            input.reference
        )));
    };
    if is_offload_placeholder_data(&data) {
        return Ok(JsonValue::String(format!(
            "Error: original content for reference {} is no longer available",
            input.reference
        )));
    }
    let pattern = input.pattern.filter(|pattern| !pattern.is_empty());
    if pattern.is_none() && input.line_range.is_none() {
        if let Some(media) = restore_media(&data) {
            return Ok(media);
        }
        let serialized = serde_json::to_string(&data)?;
        if js_len(&serialized) <= max_chars {
            return Ok(data);
        }
        return Ok(JsonValue::String(format!(
            "{}\n\n[truncated]",
            js_prefix(&serialized, max_chars)
        )));
    }
    let Some(text) = extract_text(&data).filter(|text| !text.is_empty() && is_searchable_content("text/plain")) else {
        return Ok(JsonValue::String(
            "Error: cannot search non-text content. Omit pattern/line_range to retrieve full content.".to_owned(),
        ));
    };
    let search = SearchInput {
        pattern,
        line_range: input.line_range.map(|range| LineRange {
            start: range.start,
            end: range.end,
        }),
        context_lines: input.context_lines.unwrap_or(5),
    };
    Ok(JsonValue::String(search_content(&text, &search, max_chars)))
}

/// Retrieves offloaded content from the stash.
pub(crate) struct RetrievalTool {
    stash: Stash,
    max_chars: usize,
    spec: ToolSpec,
}

impl RetrievalTool {
    pub(crate) fn new(stash: Stash, max_result_tokens: Option<usize>) -> Self {
        Self {
            stash,
            max_chars: max_result_tokens.unwrap_or(DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN,
            spec: ToolSpec::new(RETRIEVAL_TOOL_NAME, DESCRIPTION).with_input_schema(input_schema()),
        }
    }
}

async fn run(stash: Stash, max_chars: usize, context: ToolContext) -> ToolOutcome {
    let tool_use_id = context.tool_use().tool_use_id.clone();
    let raw = context.tool_use().input.clone();
    if let Some(Err(error)) = VALIDATOR.as_ref().map(|validator| validator.validate(&raw)) {
        return ToolError::new(error).into_outcome(tool_use_id);
    }
    let input: RetrievalInput = match serde_json::from_value(raw) {
        Ok(input) => input,
        Err(error) => return ToolError::new(error).into_outcome(tool_use_id),
    };
    match retrieve_context(&stash, input, max_chars).await {
        Ok(value) => wrap_in_tool_result(value, tool_use_id).into(),
        Err(error) => ToolError::new(error).into_outcome(tool_use_id),
    }
}

impl Tool for RetrievalTool {
    fn name(&self) -> &str {
        RETRIEVAL_TOOL_NAME
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn tool_spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        ToolStream::from_future(run(self.stash.clone(), self.max_chars, context))
    }
}

/// Records the tool use ids of `retrieve_context` calls so their results are not stashed again.
pub(crate) fn track_retrieval_tool_use_ids(message: &Message, skip: &mut HashSet<String>) {
    if message.role != Role::Assistant {
        return;
    }
    for block in &message.content {
        if let ContentBlock::ToolUse(tool_use) = block
            && tool_use.name == RETRIEVAL_TOOL_NAME
        {
            skip.insert(tool_use.tool_use_id.clone());
        }
    }
}

/// The tool as a shared tool.
pub(crate) fn create_retrieval_tool(stash: Stash) -> Arc<dyn Tool> {
    Arc::new(RetrievalTool::new(stash, None))
}

#[cfg(test)]
#[path = "retrieval_tool/tests.rs"]
mod tests;
