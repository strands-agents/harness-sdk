//! Shared context-compression helpers.

use std::sync::Arc;

use futures::StreamExt;

use crate::agent::InvocationContext;
use crate::error::{Error, Result};
use crate::models::model_proxy::ModelProxy;
use crate::models::{AggregatedEvent, Model, ModelRequest};
use crate::types::{ContentBlock, Message, Role, SystemPrompt};

/// The system prompt summaries use unless one is configured (`DEFAULT_SUMMARIZATION_PROMPT`).
pub(crate) const DEFAULT_SUMMARIZATION_PROMPT: &str =
    "You are a conversation summarizer. Provide a concise summary of the conversation history.

Format Requirements:
- You MUST create a structured and concise summary in bullet-point format.
- You MUST NOT respond conversationally.
- You MUST NOT address the user directly.
- You MUST NOT comment on tool availability.

Assumptions:
- You MUST NOT assume tool executions failed unless otherwise stated.

Task:
Your task is to create a structured summary document:
- It MUST contain bullet points with key topics and questions covered
- It MUST contain bullet points for all significant tools executed and their results
- It MUST contain bullet points for any code or technical information shared
- It MUST contain a section of key insights gained
- It MUST format the summary in the third person

Example format:

## Conversation Summary
* Topic 1: Key information
* Topic 2: Key information

## Tools Executed
* Tool X: Result Y";

pub(crate) fn has_tool_result(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult(_)))
}

pub(crate) fn has_tool_use(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse(_)))
}

fn followed_by_tool_result(messages: &[Message], index: usize) -> bool {
    messages.get(index + 1).is_some_and(has_tool_result)
}

/// Moves a split point forward so it neither starts on a tool result nor separates a tool use
/// from its result.
///
/// # Errors
///
/// `Unable to find valid split point for summarization` when every later message is invalid.
pub(crate) fn adjust_split_point_for_tool_pairs(messages: &[Message], split_point: usize) -> Result<usize> {
    if split_point >= messages.len() {
        return Ok(split_point);
    }
    let valid = (split_point..messages.len()).find(|&index| {
        let message = &messages[index];
        !has_tool_result(message) && (!has_tool_use(message) || followed_by_tool_result(messages, index))
    });
    valid.ok_or_else(|| Error::other("Unable to find valid split point for summarization"))
}

/// The first index at or after `start_index` where history can start: a user message that is not
/// a tool result and whose tool use, if any, is answered next. Returns
/// `messages.len()` when there is none.
pub(crate) fn find_valid_trim_point(messages: &[Message], start_index: usize) -> usize {
    (start_index..messages.len())
        .find(|&index| {
            let message = &messages[index];
            message.role == Role::User
                && !has_tool_result(message)
                && (!has_tool_use(message) || followed_by_tool_result(messages, index))
        })
        .unwrap_or(messages.len().max(start_index))
}

/// Which messages a compression tool may touch (`MessageTypeFilter`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MessageTypeFilter {
    Tools,
    Messages,
    All,
}

/// Whether the message matches the filter.
pub(crate) fn matches_message_type(message: &Message, filter: MessageTypeFilter) -> bool {
    let has_tool = has_tool_use(message) || has_tool_result(message);
    match filter {
        MessageTypeFilter::All => true,
        MessageTypeFilter::Tools => has_tool,
        MessageTypeFilter::Messages => !has_tool,
    }
}

/// Summarizes `messages_to_summarize` with one model call and returns the summary as a user
/// message. The call's usage adds to `invocation_context`.
///
/// # Errors
///
/// The model's error, or when the reply carries no text.
pub(crate) async fn generate_summary(
    messages_to_summarize: &[Message],
    model: &Arc<dyn Model>,
    system_prompt: Option<&str>,
    invocation_context: Option<&InvocationContext>,
) -> Result<Message> {
    let mut messages = messages_to_summarize.to_vec();
    messages.push(Message::user("Please summarize this conversation."));
    let request = ModelRequest {
        messages,
        system_prompt: Some(SystemPrompt::from(
            system_prompt.unwrap_or(DEFAULT_SUMMARIZATION_PROMPT),
        )),
        ..ModelRequest::default()
    };
    let request = ModelProxy::new(model.clone()).prepare_request(request);
    let mut stream = model.stream_aggregated(request);
    while let Some(event) = stream.next().await {
        if let AggregatedEvent::Done(result) = event? {
            if let Some(context) = invocation_context {
                ModelProxy::record(
                    result.metadata.as_ref().and_then(|metadata| metadata.usage.as_ref()),
                    context,
                );
            }
            return as_user_summary(&result.message);
        }
    }
    Err(Error::other("Failed to generate summary: no response from model"))
}

/// Re-roles a summarizer reply as the user message kept in history, keeping only its text; providers
/// reject reasoning and tool-use blocks in user messages.
///
/// # Errors
///
/// `Failed to generate summary: model response contained no text`.
pub(crate) fn as_user_summary(message: &Message) -> Result<Message> {
    let mut texts: Vec<ContentBlock> = Vec::new();
    for block in &message.content {
        match block {
            ContentBlock::Text(text) => texts.push(ContentBlock::text(text.text.clone())),
            ContentBlock::Citations(citations) => texts.extend(
                citations
                    .content
                    .iter()
                    .filter(|cited| !cited.text.is_empty())
                    .map(|cited| ContentBlock::text(cited.text.clone())),
            ),
            _ => {}
        }
    }
    if texts.is_empty() {
        return Err(Error::other(
            "Failed to generate summary: model response contained no text",
        ));
    }
    Ok(Message::new(Role::User, texts))
}
