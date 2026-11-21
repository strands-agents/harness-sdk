//! Messages and tool results rendered as content blocks that can go back into model input.
//!
//! The summarize strategy renders the content it summarizes through these, and the retrieval tool
//! renders the messages it hands back the same way, so stored media reaches the model as media
//! rather than as JSON.

use std::collections::HashMap;

use crate::types::{ContentBlock, Message, Role, ToolResultBlock, ToolResultContent, ToolResultStatus};

/// A block as what a model takes as input: text, images and documents pass through, other content
/// is rendered as text or a placeholder, and the rest is left out.
fn to_input_blocks(block: &ContentBlock) -> Vec<ContentBlock> {
    match block {
        ContentBlock::Text(_) | ContentBlock::Image(_) | ContentBlock::Document(_) => vec![block.clone()],
        ContentBlock::Citations(citations) => citations
            .content
            .iter()
            .map(|content| ContentBlock::text(content.text.clone()))
            .collect(),
        ContentBlock::GuardContent(guard) => vec![ContentBlock::text(
            guard
                .text()
                .map_or_else(|| "[image omitted]".to_owned(), |text| text.text.clone()),
        )],
        ContentBlock::Summary(summary) => vec![ContentBlock::text(summary.text.clone())],
        ContentBlock::Video(_) => vec![ContentBlock::text("[video omitted]")],
        ContentBlock::Audio(_) => vec![ContentBlock::text("[audio omitted]")],
        _ => Vec::new(),
    }
}

/// Tool result content as content blocks a model takes as input (`toolResultToContentBlocks`).
pub(crate) fn tool_result_to_content_blocks(content: &[ToolResultContent]) -> Vec<ContentBlock> {
    content
        .iter()
        .flat_map(|item| match item {
            ToolResultContent::Text(text) => vec![ContentBlock::Text(text.clone())],
            ToolResultContent::Image(image) => vec![ContentBlock::Image(image.clone())],
            ToolResultContent::Document(document) => vec![ContentBlock::Document(document.clone())],
            ToolResultContent::Json(json) => {
                vec![ContentBlock::text(
                    serde_json::to_string_pretty(&json.json).unwrap_or_default(),
                )]
            }
            ToolResultContent::Video(_) => vec![ContentBlock::text("[video omitted]")],
            _ => Vec::new(),
        })
        .collect()
}

/// The label the summarizer reads before a tool result's content, such as
/// `[tool result: bash (error)]` (`formatToolResultLabel`).
pub(crate) fn format_tool_result_label(block: &ToolResultBlock, name: Option<&str>) -> String {
    let status = if block.status == ToolResultStatus::Error {
        " (error)"
    } else {
        ""
    };
    match name.filter(|name| !name.is_empty()) {
        Some(name) => format!("[tool result: {name}{status}]"),
        None => format!("[tool result{status}]"),
    }
}

/// A message's content as content blocks, with tool calls and tool result labels as text.
fn message_to_content_blocks(message: &Message, tool_names: &HashMap<String, String>) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    for block in &message.content {
        match block {
            ContentBlock::ToolResult(result) => {
                let name = tool_names.get(&result.tool_use_id).map(String::as_str);
                blocks.push(ContentBlock::text(format_tool_result_label(result, name)));
                blocks.extend(tool_result_to_content_blocks(&result.content));
            }
            ContentBlock::ToolUse(tool_use) => blocks.push(ContentBlock::text(format!(
                "[tool call: {}] {}",
                tool_use.name,
                serde_json::to_string(&tool_use.input).unwrap_or_default()
            ))),
            other => blocks.extend(to_input_blocks(other)),
        }
    }
    blocks
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

/// A range of messages flattened into one content block list, for a summary request or a retrieval
/// result (`flattenMessagesToContent`).
///
/// Role markers and separators let the reader tell the message boundaries. Reasoning is left out:
/// it is assistant-only content, and its signatures are bound to the conversation that produced
/// it. A message with nothing left gets no role marker.
pub(crate) fn flatten_messages_to_content(messages: &[Message]) -> Vec<ContentBlock> {
    let tool_names: HashMap<String, String> = messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some((tool_use.tool_use_id.clone(), tool_use.name.clone())),
            _ => None,
        })
        .collect();
    let mut blocks = Vec::new();
    for message in messages {
        let content = message_to_content_blocks(message, &tool_names);
        if content.is_empty() {
            continue;
        }
        blocks.push(ContentBlock::text(format!("\n---\n[{}]", role_name(message.role))));
        blocks.extend(content);
    }
    blocks
}

#[cfg(test)]
#[path = "content_rendering/tests.rs"]
mod tests;
