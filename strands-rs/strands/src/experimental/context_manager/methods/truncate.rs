//! The truncate reduction method: replaces content with a head, tail or head-and-tail preview.

use crate::experimental::context_manager::js_text::{Utf16Text, with_separators};
use crate::types::{ContentBlock, TextBlock, ToolResultBlock, ToolResultContent};

/// The prefix of every truncation header (`TRUNCATED_PREFIX`).
pub(crate) const TRUNCATED_PREFIX: &str = "[Truncated:";

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
    fn head_share(self) -> f64 {
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
    /// Tokens of text to keep as the preview. Defaults to 1,000.
    pub preview_tokens: Option<f64>,
    /// Which part of the text to keep. Defaults to [`PreviewMode::HeadTail`].
    pub preview: Option<PreviewMode>,
}

impl TruncateConfig {
    /// The preview size in tokens, ignoring a value that is not finite (`previewTokens`).
    pub(crate) fn effective_preview_tokens(&self) -> f64 {
        self.preview_tokens
            .filter(|tokens| tokens.is_finite())
            .unwrap_or(DEFAULT_PREVIEW_TOKENS)
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
    let preview_tokens = config.effective_preview_tokens().max(0.0);
    let preview_chars = preview_tokens * CHARS_PER_TOKEN;
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
    let noun = if block_count == 1 { "block" } else { "blocks" };
    let tokens = (total_chars as f64 / CHARS_PER_TOKEN).ceil() as u64;
    let result = format!(
        "{TRUNCATED_PREFIX} {block_count} {noun}, ~{} tokens]\n\n{preview}",
        with_separators(tokens)
    );
    if Utf16Text::new(&result).len() >= total_chars {
        return full_text.to_owned();
    }
    result
}

/// A tool result with its text and JSON content replaced by one preview; images, video and
/// documents are kept after it. Returns `None` when nothing changes.
pub(crate) fn truncate_tool_result_block(block: &ToolResultBlock, config: &TruncateConfig) -> Option<ToolResultBlock> {
    let mut textual = Vec::new();
    let mut opaque = Vec::new();
    for content in &block.content {
        match content {
            ToolResultContent::Text(text) => textual.push(text.text.clone()),
            ToolResultContent::Json(_) => textual.push(serde_json::to_string(content).unwrap_or_default()),
            other => opaque.push(other.clone()),
        }
    }
    if textual.is_empty() {
        return None;
    }
    let full_text = textual.join("\n");
    let preview = build_preview(&full_text, textual.len(), config);
    if preview == full_text {
        return None;
    }
    let mut content = vec![ToolResultContent::text(preview)];
    content.extend(opaque);
    Some(ToolResultBlock::new(block.tool_use_id.clone(), block.status, content))
}

/// A text block holding the preview, or `None` when the preview would not be shorter.
pub(crate) fn truncate_text_block(block: &TextBlock, config: &TruncateConfig) -> Option<ContentBlock> {
    let preview = build_preview(&block.text, 1, config);
    (preview != block.text).then(|| ContentBlock::text(preview))
}
