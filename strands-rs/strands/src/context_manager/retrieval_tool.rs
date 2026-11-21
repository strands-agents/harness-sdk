//! The `retrieve_context` tool: reads content the context manager offloaded to its archive.

use std::sync::{Arc, LazyLock};

use serde::Deserialize;
use serde_json::json;

use super::archive::Archive;
use super::content_rendering::flatten_messages_to_content;
use super::placeholder::{is_offloaded, is_offloaded_content};
use super::search::{LineRange, SearchInput, search_content};
use crate::context_manager::js_text::{js_len, js_prefix};
use crate::error::{Error, Result};
use crate::tools::{SchemaValidator, Tool, ToolContext, ToolError, ToolOutcome, ToolStream, wrap_in_tool_result};
use crate::types::{ContentBlock, JsonValue, Message, TextBlock, ToolResultContent, ToolSpec};

/// The tool's name (`RETRIEVAL_TOOL_NAME`).
pub(crate) const RETRIEVAL_TOOL_NAME: &str = "retrieve_context";

const DEFAULT_MAX_RESULT_TOKENS: usize = 10_000;
const CHARS_PER_TOKEN: usize = 4;

const DESCRIPTION: &str = "Retrieve content that was offloaded from context.

When content is offloaded (truncated, dropped, or summarized), the original is persisted and the placeholder left in its place ends in \"[ref: <id>]\". Pass that <id> as the reference to access the original content.

Options:
  - pattern: regex/keyword to find matching lines with context
  - line_range: { start, end } to read a specific span
  - Without pattern/line_range: returns the full original content

Examples:
  { reference: \"toolu_abc\", pattern: \"error\" }
  { reference: \"toolu_abc\", line_range: { start: 10, end: 25 } }
  { reference: \"toolu_abc\" }";

fn input_schema() -> JsonValue {
    json!({
        "type": "object",
        "properties": {
            "reference": {
                "type": "string",
                "description": "The <id> from the \"[ref: <id>]\" at the end of the offload placeholder."
            },
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

/// What an archive entry holds: one stored block, or the messages removed together.
#[derive(Debug, Clone)]
enum ArchiveEntry {
    Content(ToolResultContent),
    Block(ContentBlock),
    Messages(Vec<Message>),
}

/// Reads an archive reference as the tool's return value.
///
/// # Errors
///
/// The archive's read error, or a reference the tool cannot serve. Failures are errors rather than
/// returned text: a returned string reaches the model as a success, and a model that reads "Error"
/// under success retries and then invents the content.
pub(crate) async fn retrieve_context(archive: &Archive, input: RetrievalInput, max_chars: usize) -> Result<JsonValue> {
    let reference = input.reference.trim();
    let entries = resolve_reference(archive, reference).await?;
    // A missing reference is terminal only once the id was passed as the placeholder lists it;
    // content offloaded again never comes back.
    if entries.is_empty() {
        return Err(Error::other(format!(
            "reference not found: {reference}. Pass only the <id> from the placeholder's \"[ref: <id>]\". If that is what you passed, the content is unavailable — do not retry."
        )));
    }
    if entries.iter().any(entry_is_offloaded) {
        return Err(Error::other(format!(
            "original content for reference {reference} is no longer available — do not retry."
        )));
    }
    let pattern = input.pattern.filter(|pattern| !pattern.is_empty());
    if pattern.is_none() && input.line_range.is_none() {
        return full_content(&entries, max_chars);
    }
    let search = SearchInput {
        pattern,
        line_range: input.line_range.map(|range| LineRange {
            start: range.start,
            end: range.end,
        }),
        context_lines: input.context_lines.unwrap_or(5),
    };
    search_entries(&entries, &search, max_chars).map(JsonValue::String)
}

fn entry_is_offloaded(entry: &ArchiveEntry) -> bool {
    match entry {
        ArchiveEntry::Content(content) => is_offloaded_content(content),
        ArchiveEntry::Block(block) => is_offloaded(block),
        ArchiveEntry::Messages(_) => false,
    }
}

/// The stored content itself. Tool result items, and removed messages rendered as role markers and
/// their content, are returned as tool result content, so media reaches the model as media and
/// only their text is cut to `max_chars`; anything else is returned in its JSON form.
fn full_content(entries: &[ArchiveEntry], max_chars: usize) -> Result<JsonValue> {
    let blocks: Option<Vec<ToolResultContent>> = entries
        .iter()
        .flat_map(|entry| match entry {
            ArchiveEntry::Messages(messages) => flatten_messages_to_content(messages)
                .into_iter()
                .map(|block| as_result_content(&block))
                .collect::<Vec<_>>(),
            ArchiveEntry::Content(content) => vec![Some(content.clone())],
            ArchiveEntry::Block(block) => vec![as_result_content(block)],
        })
        .collect();
    if let Some(blocks) = blocks {
        let mut clipped = clip_text(blocks, max_chars);
        if clipped.len() == 1 {
            return Ok(serde_json::to_value(clipped.remove(0))?);
        }
        return Ok(serde_json::to_value(clipped)?);
    }
    let data = if let [entry] = entries {
        entry_to_data(entry)?
    } else {
        JsonValue::Array(entries.iter().map(entry_to_data).collect::<Result<_>>()?)
    };
    let serialized = serde_json::to_string(&data)?;
    if js_len(&serialized) <= max_chars {
        return Ok(data);
    }
    Ok(JsonValue::String(format!(
        "{}\n\n[truncated]",
        js_prefix(&serialized, max_chars)
    )))
}

/// A content block as tool result content, when it is one of the kinds a tool result holds.
fn as_result_content(block: &ContentBlock) -> Option<ToolResultContent> {
    match block {
        ContentBlock::Text(text) => Some(ToolResultContent::Text(text.clone())),
        ContentBlock::Image(image) => Some(ToolResultContent::Image(image.clone())),
        ContentBlock::Video(video) => Some(ToolResultContent::Video(video.clone())),
        ContentBlock::Document(document) => Some(ToolResultContent::Document(document.clone())),
        _ => None,
    }
}

/// Cuts the items' text to `max_chars` in total, in order: the item that exhausts the budget is
/// cut and marked, later textual items are left out, and media passes through untouched.
fn clip_text(blocks: Vec<ToolResultContent>, max_chars: usize) -> Vec<ToolResultContent> {
    let mut budget = max_chars;
    let mut kept = Vec::new();
    for block in blocks {
        let Some(text) = content_text(&block) else {
            kept.push(block);
            continue;
        };
        let length = js_len(&text);
        if length <= budget {
            budget -= length;
            kept.push(block);
        } else if budget > 0 {
            kept.push(ToolResultContent::Text(TextBlock::new(format!(
                "{}\n\n[truncated]",
                js_prefix(&text, budget)
            ))));
            budget = 0;
        }
    }
    kept
}

/// The lines of the entries' text that match the pattern or fall in the line range.
fn search_entries(entries: &[ArchiveEntry], search: &SearchInput, max_chars: usize) -> Result<String> {
    // Actionable rather than terminal: the content is there, the search arguments are what cannot
    // apply.
    let Some(text) = join_text(entries.iter().map(entry_text)) else {
        return Err(Error::other(
            "cannot search non-text content. Omit pattern/line_range to retrieve full content.",
        ));
    };
    search_content(&text, search, max_chars)
}

/// Resolves a reference to its stored entries. An id (a tool result's `toolUseId`, or
/// `removed-<trackingId>`) resolves to every entry keyed under it, in index order; otherwise the
/// reference is an exact key. Ids take precedence because a placeholder references a tool result by
/// id, and an id may itself end like a key (`tool_1`).
async fn resolve_reference(archive: &Archive, reference: &str) -> Result<Vec<ArchiveEntry>> {
    let keys = archive.keys_of(reference).await?;
    if keys.is_empty() {
        let exact = archive.retrieve(reference).await?;
        return Ok(exact.and_then(entry_from_data).into_iter().collect());
    }
    let mut entries = Vec::new();
    for key in keys {
        if let Some(entry) = archive.retrieve(&key).await?.and_then(entry_from_data) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// Deserializes an archive entry with the same readers that load it from a session.
fn entry_from_data(data: JsonValue) -> Option<ArchiveEntry> {
    match data {
        JsonValue::Array(items) => items
            .into_iter()
            .map(|item| Message::from_message_data(item).ok())
            .collect::<Option<Vec<_>>>()
            .map(ArchiveEntry::Messages),
        object @ JsonValue::Object(_) => ToolResultContent::from_data(object.clone())
            .map(ArchiveEntry::Content)
            .or_else(|_| ContentBlock::from_data(object).map(ArchiveEntry::Block))
            .ok(),
        _ => None,
    }
}

fn entry_to_data(entry: &ArchiveEntry) -> Result<JsonValue> {
    Ok(match entry {
        ArchiveEntry::Content(content) => serde_json::to_value(content)?,
        ArchiveEntry::Block(block) => serde_json::to_value(block)?,
        ArchiveEntry::Messages(messages) => serde_json::to_value(messages)?,
    })
}

/// The searchable text of an entry: its text, JSON and tool-result text, in order.
fn entry_text(entry: &ArchiveEntry) -> Option<String> {
    match entry {
        ArchiveEntry::Content(content) => content_text(content),
        ArchiveEntry::Block(block) => block_text(block),
        ArchiveEntry::Messages(messages) => join_text(
            messages
                .iter()
                .flat_map(|message| message.content.iter().map(block_text)),
        ),
    }
}

fn content_text(content: &ToolResultContent) -> Option<String> {
    match content {
        ToolResultContent::Text(text) => Some(text.text.clone()),
        ToolResultContent::Json(json) => serde_json::to_string_pretty(&json.json).ok(),
        _ => None,
    }
}

fn block_text(block: &ContentBlock) -> Option<String> {
    match block {
        ContentBlock::Text(text) => Some(text.text.clone()),
        ContentBlock::ToolResult(result) => join_text(result.content.iter().map(content_text)),
        ContentBlock::Citations(citations) => join_text(citations.content.iter().map(|cited| Some(cited.text.clone()))),
        _ => None,
    }
}

fn join_text(parts: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let present: Vec<String> = parts.into_iter().flatten().collect();
    (!present.is_empty()).then(|| present.join("\n"))
}

/// Retrieves offloaded content from the archive.
pub(crate) struct RetrievalTool {
    archive: Archive,
    max_chars: usize,
    spec: ToolSpec,
}

impl RetrievalTool {
    pub(crate) fn new(archive: Archive, max_result_tokens: Option<usize>) -> Self {
        Self {
            archive,
            max_chars: max_result_tokens.unwrap_or(DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN,
            spec: ToolSpec::new(RETRIEVAL_TOOL_NAME, DESCRIPTION).with_input_schema(input_schema()),
        }
    }
}

async fn run(archive: Archive, max_chars: usize, context: ToolContext) -> ToolOutcome {
    let tool_use_id = context.tool_use().tool_use_id.clone();
    let raw = context.tool_use().input.clone();
    if let Some(Err(error)) = VALIDATOR.as_ref().map(|validator| validator.validate(&raw)) {
        return ToolError::new(error).into_outcome(tool_use_id);
    }
    let input: RetrievalInput = match serde_json::from_value(raw) {
        Ok(input) => input,
        Err(error) => return ToolError::new(error).into_outcome(tool_use_id),
    };
    match retrieve_context(&archive, input, max_chars).await {
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
        ToolStream::from_future(run(self.archive.clone(), self.max_chars, context))
    }
}

/// The tool as a shared tool.
pub(crate) fn create_retrieval_tool(archive: Archive) -> Arc<dyn Tool> {
    Arc::new(RetrievalTool::new(archive, None))
}

#[cfg(test)]
#[path = "retrieval_tool/tests.rs"]
mod tests;
