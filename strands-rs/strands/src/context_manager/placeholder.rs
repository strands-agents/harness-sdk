//! Offload placeholders: the text block left where content was offloaded, and the wording of each
//! marker it carries.

use super::js_text::with_separators;
use crate::types::{ContentBlock, OffloadMethod, Offloaded, TextBlock, ToolResultContent};

/// A bare marker reads to the model as media that never arrived, so it doubts what it saw.
const AFTER_RECEIVING: &str = "removed from context after it was received";

/// What a message-level marker stands for (`REMOVED_MESSAGES`).
pub(crate) const REMOVED_MESSAGES: &str = "earlier messages";

/// The block that stands in for offloaded content: the preview, followed by the archive reference
/// when the original is retrievable (`offloadPlaceholder`).
pub(crate) fn offload_placeholder(
    method: OffloadMethod,
    preview: &str,
    archive_ref: Option<&str>,
    tokens: u64,
) -> TextBlock {
    let mut offloaded = Offloaded::new(method);
    let text = match archive_ref {
        Some(reference) => {
            offloaded = offloaded.with_reference(reference);
            format!("{preview} [ref: {reference}]")
        }
        None => preview.to_owned(),
    };
    if tokens > 0 {
        offloaded = offloaded.with_tokens(tokens);
    }
    TextBlock::offloaded(text, offloaded)
}

/// The placeholder in a content block, if it is one (`isOffloaded`).
pub(crate) fn offloaded_of(block: &ContentBlock) -> Option<&Offloaded> {
    match block {
        ContentBlock::Text(text) => text.offloaded.as_ref(),
        _ => None,
    }
}

/// Whether a content block is a placeholder the context manager left where it offloaded content.
pub(crate) fn is_offloaded(block: &ContentBlock) -> bool {
    offloaded_of(block).is_some()
}

/// The placeholder in tool result content, if it is one.
pub(crate) fn offloaded_content_of(content: &ToolResultContent) -> Option<&Offloaded> {
    match content {
        ToolResultContent::Text(text) => text.offloaded.as_ref(),
        _ => None,
    }
}

/// Whether tool result content is an offload placeholder.
pub(crate) fn is_offloaded_content(content: &ToolResultContent) -> bool {
    offloaded_content_of(content).is_some()
}

/// The tokens the placeholders among `blocks` already stand for, including ones inside a tool
/// result, so replacing a placeholder reports the content behind it rather than its own few tokens
/// (`carriedTokens`).
pub(crate) fn carried_tokens<'a>(blocks: impl IntoIterator<Item = &'a ContentBlock>) -> u64 {
    let tokens = |offloaded: Option<&Offloaded>| offloaded.and_then(|offloaded| offloaded.tokens).unwrap_or(0);
    blocks
        .into_iter()
        .map(|block| match block {
            ContentBlock::ToolResult(result) => result
                .content
                .iter()
                .map(|content| tokens(offloaded_content_of(content)))
                .sum(),
            other => tokens(offloaded_of(other)),
        })
        .sum()
}

/// Marker for a dropped block, naming the media kind when it was media (`formatDropped`).
pub(crate) fn format_dropped(tokens: u64, media_kind: Option<&str>) -> String {
    marker(
        "Dropped",
        &[
            media_kind,
            Some(&approx_tokens(tokens)),
            media_kind.map(|_| AFTER_RECEIVING),
        ],
    )
}

/// Marker for dropped messages of `tokens` in total (`formatDroppedMessages`).
pub(crate) fn format_dropped_messages(tokens: u64) -> String {
    marker("Dropped", &[Some(REMOVED_MESSAGES), Some(&approx_tokens(tokens))])
}

/// Marker for a block replaced without a preview, naming the media kind when it was media
/// (`formatOffloaded`).
pub(crate) fn format_offloaded(tokens: u64, media_kind: Option<&str>) -> String {
    marker(
        "Offloaded",
        &[
            media_kind,
            Some(&approx_tokens(tokens)),
            media_kind.map(|_| AFTER_RECEIVING),
        ],
    )
}

/// Marker for summarized content, followed by the summary when there is one
/// (`formatSummarized`). `description` says what was summarized, such as `tool result` or
/// [`REMOVED_MESSAGES`].
pub(crate) fn format_summarized(description: &str, tokens: u64, summary: Option<&str>) -> String {
    with_body(
        &marker("Summarized", &[Some(description), Some(&approx_tokens(tokens))]),
        summary,
    )
}

/// Marker for `block_count` blocks shortened to `preview`, followed by the preview
/// (`formatTruncated`).
pub(crate) fn format_truncated(block_count: usize, tokens: u64, preview: &str) -> String {
    with_body(
        &marker(
            "Truncated",
            &[Some(&count_of(block_count, "block")), Some(&approx_tokens(tokens))],
        ),
        Some(preview),
    )
}

/// Marker left where messages of `tokens` in total were removed from the context window
/// (`formatElided`).
pub(crate) fn format_elided(tokens: u64) -> String {
    let elided = format!("{REMOVED_MESSAGES} elided");
    let size = approx_tokens(tokens);
    let details: Vec<&str> = [elided.as_str(), size.as_str()]
        .into_iter()
        .filter(|detail| !detail.is_empty())
        .collect();
    format!("[... {} ...]", details.join(", "))
}

/// `[Label: detail, detail]`, leaving out empty details, or `[Label]` when none remain.
fn marker(label: &str, details: &[Option<&str>]) -> String {
    let shown: Vec<&str> = details
        .iter()
        .flatten()
        .copied()
        .filter(|detail| !detail.is_empty())
        .collect();
    if shown.is_empty() {
        return format!("[{label}]");
    }
    format!("[{label}: {}]", shown.join(", "))
}

/// The size as `~2,525 tokens`, or empty when the token count could not measure it.
fn approx_tokens(tokens: u64) -> String {
    if tokens == 0 {
        return String::new();
    }
    format!("~{} tokens", with_separators(tokens))
}

fn count_of(count: usize, noun: &str) -> String {
    if count == 1 {
        return format!("{count} {noun}");
    }
    format!("{count} {noun}s")
}

fn with_body(header: &str, body: Option<&str>) -> String {
    match body.filter(|body| !body.is_empty()) {
        Some(body) => format!("{header}\n\n{body}"),
        None => header.to_owned(),
    }
}

#[cfg(test)]
#[path = "placeholder/tests.rs"]
mod tests;
