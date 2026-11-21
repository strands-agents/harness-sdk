//! The truncate reduction method: replaces content with a head, tail or head-and-tail preview.

use crate::experimental::context_manager::js_text::{Utf16Text, with_separators};
use crate::experimental::context_manager::placeholder::{format_truncated, is_offloaded_content};
use crate::types::{TextBlock, ToolResultBlock, ToolResultContent};

const DEFAULT_PREVIEW_TOKENS: f64 = 1000.0;
const CHARS_PER_TOKEN: f64 = 4.0;

/// Which part of the text a preview keeps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum PreviewMode {
    /// The start of the text.
    Head,
    /// The end of the text.
    Tail,
    /// 60% from the start and 40% from the end (the default).
    #[default]
    HeadTail,
}

impl PreviewMode {
    /// The share of the preview budget kept from the head; the rest is kept from the tail
    /// (`PREVIEW_HEAD_SHARE`).
    pub(crate) fn head_share(self) -> f64 {
        match self {
            Self::Head => 1.0,
            Self::Tail => 0.0,
            Self::HeadTail => 0.6,
        }
    }
}

/// Configuration of the truncate method (`TruncateConfig`).
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct TruncateConfig {
    /// Tokens of text to keep as the preview. Defaults to 1,000. Content that already fits is left
    /// unchanged. For a whole-message truncate, the budget of whole messages kept at the head and
    /// tail; the rest are replaced by one `[... earlier messages elided, ~N tokens ...]` marker.
    pub preview_tokens: Option<f64>,
    /// Which part of the text to keep. Defaults to [`PreviewMode::HeadTail`]. For a whole-message
    /// truncate, [`PreviewMode::Head`] keeps only the oldest messages and [`PreviewMode::Tail`] only
    /// the newest.
    pub preview: Option<PreviewMode>,
}

impl TruncateConfig {
    /// The preview token budget, defaulting to 1,000 and never below 0 (`resolvePreviewTokens`).
    pub(crate) fn resolve_preview_tokens(&self) -> f64 {
        self.preview_tokens
            .filter(|tokens| tokens.is_finite())
            .map_or(DEFAULT_PREVIEW_TOKENS, |tokens| tokens.max(0.0))
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "character counts are far below 2^52 and the floored values are non-negative"
)]
/// A preview of `full_text` with a truncation header, or `full_text` itself when it already fits
/// or the preview would not be shorter.
pub(crate) fn build_preview(full_text: &str, block_count: usize, config: &TruncateConfig) -> String {
    let preview_chars = config.resolve_preview_tokens() * CHARS_PER_TOKEN;
    let text = Utf16Text::new(full_text);
    let total_chars = text.len();
    if total_chars as f64 <= preview_chars {
        return full_text.to_owned();
    }
    let head_share = config.preview.unwrap_or_default().head_share();
    let head_chars = (preview_chars * head_share).floor() as usize;
    let tail_chars = (preview_chars as usize).saturating_sub(head_chars);
    let head = text.slice(0, head_chars);
    let tail = if tail_chars > 0 {
        text.slice(total_chars.saturating_sub(tail_chars), total_chars)
    } else {
        String::new()
    };
    let elided = total_chars.saturating_sub(head_chars + tail_chars);
    let marker = format!("[... {} chars elided ...]", with_separators(elided as u64));
    let preview = [head, marker, tail]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let tokens = (total_chars as f64 / CHARS_PER_TOKEN).ceil() as u64;
    let result = format_truncated(block_count, tokens, &preview);
    if Utf16Text::new(&result).len() >= total_chars {
        return full_text.to_owned();
    }
    result
}

/// A tool result split by [`truncate_tool_result_block`] (`TruncatedToolResult`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TruncatedToolResult {
    /// Preview of the result's text and JSON items.
    pub(crate) preview: String,
    /// Items kept as they are: media, whose payload can't be previewed as text, and placeholders.
    pub(crate) kept: Vec<ToolResultContent>,
}

/// Splits a tool result into a preview of its text and JSON items and the items kept as they are;
/// `None` when nothing would be truncated.
pub(crate) fn truncate_tool_result_block(
    block: &ToolResultBlock,
    config: &TruncateConfig,
) -> Option<TruncatedToolResult> {
    let mut textual = Vec::new();
    let mut kept = Vec::new();
    for content in &block.content {
        match content {
            ToolResultContent::Text(text) if !is_offloaded_content(content) => textual.push(text.text.clone()),
            ToolResultContent::Json(_) => textual.push(serde_json::to_string(content).unwrap_or_default()),
            other => kept.push(other.clone()),
        }
    }
    if textual.is_empty() {
        return None;
    }
    let full_text = textual.join("\n");
    let preview = build_preview(&full_text, textual.len(), config);
    (preview != full_text).then_some(TruncatedToolResult { preview, kept })
}

/// The preview of a text block, or `None` when the preview would not be shorter
/// (`truncateTextBlock`).
pub(crate) fn truncate_text_block(block: &TextBlock, config: &TruncateConfig) -> Option<String> {
    let preview = build_preview(&block.text, 1, config);
    (preview != block.text).then_some(preview)
}
