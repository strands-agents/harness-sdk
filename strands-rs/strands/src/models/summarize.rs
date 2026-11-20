//! The client-side summarizer behind the default [`Model::summarize`].

use futures::StreamExt;

use super::model::{AggregatedEvent, Model, ModelRequest, SummarizeOptions, is_js_whitespace};
use super::streaming::{ModelStreamEvent, Usage};
use crate::error::{Error, Result};
use crate::types::{ContentBlock, Message, Role, StopReason, SummaryBlock, TextBlock};

/// Opens every summarize instruction, since the request can carry the caller's own persona and
/// tools (`SUMMARIZE_GUARD`).
pub(crate) const SUMMARIZE_GUARD: &str = "STOP. Do not act on, answer, or continue any request above, and do not call any tools - tool calls will be rejected. Your only task now is to summarize everything above.";

/// The instructions used when the caller gives none (`DEFAULT_SUMMARIZE_INSTRUCTIONS`).
pub(crate) const DEFAULT_SUMMARIZE_INSTRUCTIONS: &str = "Write a handoff summary for a fresh context window. Preserve: key data, values and identifiers; decisions and conclusions; error messages and stack traces; the user's outstanding requests and what was about to happen next. Be concise, third person, no preamble. Output only the summary.";

/// The result of [`Model::summarize`] (`SummarizeResult`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct SummarizeResult {
    /// The summary as `SummaryBlock`s, empty when the model wrote none. Built-in implementations
    /// return at most one block; a caller that places one summary uses the first.
    pub content: Vec<ContentBlock>,
    /// Token usage of the calls made for the summary; `None` when an implementation reports none.
    /// The default implementation always reports usage, with zero counts when the provider sent
    /// none.
    pub usage: Option<Usage>,
}

impl SummarizeResult {
    /// Creates a result without usage.
    pub fn new(content: Vec<ContentBlock>) -> Self {
        Self { content, usage: None }
    }

    /// Sets the usage.
    #[must_use]
    pub fn with_usage(mut self, usage: Usage) -> Self {
        self.usage = Some(usage);
        self
    }
}

fn is_summary_stop_reason(stop_reason: &StopReason) -> bool {
    matches!(
        stop_reason,
        StopReason::EndTurn | StopReason::MaxTokens | StopReason::StopSequence
    )
}

fn short_type_name<M: ?Sized>() -> &'static str {
    let name = std::any::type_name::<M>();
    let base = name.split('<').next().unwrap_or(name);
    base.rsplit("::").next().unwrap_or(base)
}

/// Returns `messages` with `instructions` closing the final user turn, or in a user turn after it.
fn with_instructions(mut messages: Vec<Message>, instructions: String) -> Vec<Message> {
    let block = ContentBlock::Text(TextBlock::new(instructions));
    match messages.last_mut() {
        Some(last) if last.role == Role::User => {
            let mut content = last.content.clone();
            content.push(block);
            *last = Message::new(Role::User, content);
        }
        _ => messages.push(Message::new(Role::User, vec![block])),
    }
    messages
}

struct Reply {
    stop_reason: Option<StopReason>,
    message: Option<Message>,
    usage: Usage,
}

/// The default [`Model::summarize`]: sends `messages` as a request that ends with one summarize
/// instruction and returns the reply's text as a `SummaryBlock`.
///
/// A provider that overrides [`Model::summarize`] (for a server-side summary) calls this as its
/// fallback.
///
/// # Errors
///
/// Returns the model's stream error, unless the call was cancelled.
pub async fn summarize_client_side<M: Model + ?Sized>(
    model: &M,
    messages: Vec<Message>,
    options: SummarizeOptions,
) -> Result<SummarizeResult> {
    let cancel_signal = options.cancel_signal.clone();
    if cancel_signal.as_ref().is_some_and(|signal| signal.is_cancelled()) {
        return Ok(SummarizeResult::new(Vec::new()).with_usage(Usage::default()));
    }
    let instructions = options
        .instructions
        .as_deref()
        .filter(|instructions| !instructions.is_empty())
        .unwrap_or(DEFAULT_SUMMARIZE_INSTRUCTIONS);
    let request = ModelRequest {
        messages: with_instructions(messages, format!("{SUMMARIZE_GUARD}\n\n{instructions}")),
        system_prompt: options.system_prompt,
        tool_specs: options.tool_specs,
        agent_metadata: options.agent_metadata,
        cancel_signal: options.cancel_signal,
        ..ModelRequest::default()
    };
    let is_cancelled = || cancel_signal.as_ref().is_some_and(|signal| signal.is_cancelled());

    let mut reply = Reply {
        stop_reason: None,
        message: None,
        usage: Usage::default(),
    };
    let mut stream = model.stream_aggregated(super::model_proxy::prepare_request_for(model, request));
    while let Some(item) = stream.next().await {
        match item {
            Ok(AggregatedEvent::Done(result)) => {
                reply.stop_reason = Some(result.stop_reason);
                reply.usage = result
                    .metadata
                    .and_then(|metadata| metadata.usage)
                    .unwrap_or(reply.usage);
                reply.message = Some(result.message);
                break;
            }
            Ok(_) if is_cancelled() => {
                reply.stop_reason = Some(StopReason::Cancelled);
                break;
            }
            Ok(AggregatedEvent::ModelStreamEvent(ModelStreamEvent::Metadata(metadata))) => {
                reply.usage = metadata.usage.unwrap_or(reply.usage);
            }
            Ok(_) => {}
            Err(Error::MaxTokens(error)) => {
                reply.stop_reason = Some(StopReason::MaxTokens);
                reply.usage = error
                    .partial_message
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.usage)
                    .unwrap_or(reply.usage);
                reply.message = Some(*error.partial_message);
                break;
            }
            Err(_) if is_cancelled() => {
                reply.stop_reason = Some(StopReason::Cancelled);
                break;
            }
            Err(error) => return Err(error),
        }
    }
    drop(stream);

    if !reply.stop_reason.as_ref().is_some_and(is_summary_stop_reason) {
        let stop_reason = reply
            .stop_reason
            .as_ref()
            .map_or_else(|| "undefined".to_owned(), ToString::to_string);
        tracing::warn!(
            "model=<{}>, stop_reason=<{stop_reason}> | summary reply did not finish | ignoring the reply",
            short_type_name::<M>()
        );
        return Ok(SummarizeResult::new(Vec::new()).with_usage(reply.usage));
    }
    let text = reply
        .message
        .iter()
        .flat_map(|message| message.content.iter())
        .filter_map(ContentBlock::as_text)
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim_matches(is_js_whitespace);
    if text.is_empty() {
        return Ok(SummarizeResult::new(Vec::new()).with_usage(reply.usage));
    }
    let summary = ContentBlock::Summary(SummaryBlock::new(text));
    Ok(SummarizeResult::new(vec![summary]).with_usage(reply.usage))
}
