//! What the agent sends a model: renders blocks a provider cannot take and records each call's usage
//! on the request.

use std::sync::Arc;

use super::model::{CountTokensOptions, Model, ModelRequest, latest_user_index};
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::Result;
use crate::models::streaming::Usage;
use crate::types::{ContentBlock, Message, TextBlock, ToolResultBlock, ToolResultContent};

const UNSUPPORTED_CONTENT_PLACEHOLDER: &str = "[unsupported content omitted]";

/// Wraps the model the agent calls (`ModelProxy`).
pub(crate) struct ModelProxy {
    model: Arc<dyn Model>,
}

/// The rendered messages and the number of blocks at the end of the latest user message that
/// change between calls.
pub(crate) struct Rendered {
    pub(crate) messages: Vec<Message>,
    pub(crate) dynamic_trailing_blocks: usize,
}

impl ModelProxy {
    pub(crate) fn new(model: Arc<dyn Model>) -> Self {
        Self { model }
    }

    /// Renders the request's messages for the model and keeps the cache point ahead of injected
    /// text, which the next call no longer sends.
    pub(crate) fn prepare_request(&self, request: ModelRequest) -> ModelRequest {
        prepare_request_for(self.model.as_ref(), request)
    }

    /// Records a finished call's usage on the request (`_record`).
    pub(crate) fn record(usage: Option<&Usage>, invocation_context: &InvocationContext) {
        if let Some(usage) = usage {
            invocation_context.record_usage(usage);
        }
    }

    /// Counts the tokens of the messages as they would be sent.
    pub(crate) async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        let rendered = self.prepare(messages.to_vec());
        self.model.count_tokens(&rendered.messages, options).await
    }

    pub(crate) fn prepare(&self, messages: Vec<Message>) -> Rendered {
        prepare_for(self.model.as_ref(), messages)
    }
}

/// [`ModelProxy::prepare_request`] for a model borrowed as `&M`, such as a provider's own
/// `summarize`.
pub(crate) fn prepare_request_for<M: Model + ?Sized>(model: &M, mut request: ModelRequest) -> ModelRequest {
    let rendered = prepare_for(model, std::mem::take(&mut request.messages));
    request.messages = rendered.messages;
    if rendered.dynamic_trailing_blocks > request.dynamic_trailing_blocks.unwrap_or(0) {
        request.dynamic_trailing_blocks = Some(rendered.dynamic_trailing_blocks);
    }
    request
}

fn prepare_for<M: Model + ?Sized>(model: &M, messages: Vec<Message>) -> Rendered {
    let capabilities = model.model_info().capabilities;
    let messages = with_unknown_only_tool_results_filled(with_summary_text(
        messages,
        capabilities.server_side_summary == Some(true),
    ));
    if !messages.iter().any(has_injected_block) || capabilities.temporary_messages == Some(true) {
        return Rendered {
            messages,
            dynamic_trailing_blocks: 0,
        };
    }
    render_injected_blocks(messages)
}

fn with_summary_text(messages: Vec<Message>, server_side_summary: bool) -> Vec<Message> {
    if server_side_summary {
        return messages;
    }
    messages
        .into_iter()
        .map(|mut message| {
            for block in &mut message.content {
                if let ContentBlock::Summary(summary) = block {
                    *block = ContentBlock::Text(TextBlock::new(summary.text.clone()));
                }
            }
            message
        })
        .collect()
}

fn is_unknown_only_tool_result(block: &ContentBlock) -> bool {
    let ContentBlock::ToolResult(result) = block else {
        return false;
    };
    !result.content.is_empty()
        && result
            .content
            .iter()
            .all(|content| matches!(content, ToolResultContent::Unknown(_)))
}

fn with_unknown_only_tool_results_filled(messages: Vec<Message>) -> Vec<Message> {
    messages
        .into_iter()
        .map(|mut message| {
            for block in &mut message.content {
                if !is_unknown_only_tool_result(block) {
                    continue;
                }
                let ContentBlock::ToolResult(result) = block else {
                    continue;
                };
                let filled = ToolResultBlock::new(
                    result.tool_use_id.clone(),
                    result.status,
                    vec![ToolResultContent::text(UNSUPPORTED_CONTENT_PLACEHOLDER)],
                );
                let error = result.error.take();
                *result = match error {
                    Some(error) => filled.with_error(error),
                    None => filled,
                };
            }
            message
        })
        .collect()
}

fn render_injected_blocks(messages: Vec<Message>) -> Rendered {
    let latest_user = latest_user_index(&messages);
    let mut dynamic_trailing_blocks = 0;
    let messages = messages
        .into_iter()
        .enumerate()
        .map(|(index, mut message)| {
            if !has_injected_block(&message) {
                return message;
            }
            if Some(index) != latest_user {
                message
                    .content
                    .retain(|block| !matches!(block, ContentBlock::Injected(_)));
                return message;
            }
            if let Some(first) = message
                .content
                .iter()
                .position(|block| matches!(block, ContentBlock::Injected(_)))
            {
                dynamic_trailing_blocks = message.content.len() - first;
            }
            for (position, block) in message.content.iter_mut().enumerate() {
                let ContentBlock::Injected(injected) = block else {
                    continue;
                };
                let text = if position > 0 && !injected.text.starts_with('\n') {
                    format!("\n\n{}", injected.text)
                } else {
                    injected.text.clone()
                };
                *block = ContentBlock::Text(TextBlock::new(text));
            }
            message
        })
        .collect();
    Rendered {
        messages,
        dynamic_trailing_blocks,
    }
}

fn has_injected_block(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::Injected(_)))
}

/// Counts what the next request carries: the messages, plus the system prompt and tool specs that
/// occupy the same context window, so a utilization gate that leaves them out reads low
/// (`countRequestTokens`). A count of a single block or a subset calls `count_tokens` directly:
/// including the system prompt there would inflate every block against its threshold.
///
/// # Errors
///
/// The model's token count error.
pub(crate) async fn count_request_tokens(agent: &LocalAgent, messages: &[Message]) -> Result<u64> {
    let options = CountTokensOptions {
        system_prompt: agent.system_prompt().cloned(),
        tool_specs: agent
            .tool_registry()
            .list()
            .iter()
            .map(|tool| tool.tool_spec())
            .collect(),
    };
    ModelProxy::new(agent.model().clone())
        .count_tokens(messages, options)
        .await
}

#[cfg(test)]
mod tests;
