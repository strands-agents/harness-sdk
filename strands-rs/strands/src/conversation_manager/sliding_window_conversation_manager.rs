//! The sliding window strategy.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde::Serialize;

use super::compression::context_compression::{find_valid_trim_point, has_tool_result, has_tool_use};
use super::compression::pin_message::{apply_pin_first, is_pinned};
use super::{ConversationManager, ConversationManagerReduceOptions, ProactiveCompression};
use crate::agent::LocalAgent;
use crate::error::Result;
use crate::hooks::AfterInvocationEvent;
use crate::types::{
    ContentBlock, DocumentBlock, DocumentSource, ImageBlock, ImageSource, Message, Role, TextBlock, ToolResultBlock,
    ToolResultContent, VideoBlock, VideoSource,
};

const PRESERVE_CHARS: usize = 200;
/// The longest plausible truncation marker, newlines included.
const MIN_TRUNCATION_GAIN: usize = 50;
/// Text at or below this length is not worth truncating, so truncated output (just above
/// `2 * PRESERVE_CHARS`) is not truncated again.
const TRUNCATION_THRESHOLD: usize = 2 * PRESERVE_CHARS + MIN_TRUNCATION_GAIN;
const DEFAULT_WINDOW_SIZE: usize = 40;

/// Configuration for [`SlidingWindowConversationManager`] (`SlidingWindowConversationManagerConfig`).
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct SlidingWindowConversationManagerConfig {
    /// The most messages kept in history. Defaults to 40.
    pub window_size: Option<usize>,
    /// Whether overflow recovery truncates large tool results before trimming messages.
    /// Defaults to `true`.
    pub should_truncate_results: Option<bool>,
    /// Proactive compression before model calls. Defaults to disabled.
    #[builder(into)]
    pub proactive_compression: Option<ProactiveCompression>,
    /// How many messages at the start of the conversation to pin permanently, so reduction never
    /// removes them.
    pub pin_first: Option<usize>,
}

struct Inner {
    window_size: usize,
    should_truncate_results: bool,
    pin_first: Option<usize>,
    pin_first_applied: AtomicBool,
    compression_threshold: Option<f64>,
}

/// Keeps the most recent messages (`SlidingWindowConversationManager`): after every invocation
/// it trims history to the window, and on a context-window overflow it truncates the oldest large
/// tool result or trims the oldest messages. Trimming never starts history on a tool result or
/// separates a tool use from its result.
#[derive(Clone)]
pub struct SlidingWindowConversationManager {
    inner: Arc<Inner>,
}

impl Default for SlidingWindowConversationManager {
    fn default() -> Self {
        Self::with_inner(&SlidingWindowConversationManagerConfig::default(), None)
    }
}

impl std::fmt::Debug for SlidingWindowConversationManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlidingWindowConversationManager")
            .field("window_size", &self.inner.window_size)
            .field("should_truncate_results", &self.inner.should_truncate_results)
            .finish_non_exhaustive()
    }
}

impl SlidingWindowConversationManager {
    /// Creates the manager.
    ///
    /// # Errors
    ///
    /// A proactive compression threshold outside `(0, 1]`.
    #[expect(
        clippy::needless_pass_by_value,
        reason = "configs are taken by value like every manager's, so fields that own data can join"
    )]
    pub fn new(config: SlidingWindowConversationManagerConfig) -> Result<Self> {
        let threshold = config.proactive_compression.unwrap_or_default().threshold()?;
        Ok(Self::with_inner(&config, threshold))
    }

    fn with_inner(config: &SlidingWindowConversationManagerConfig, compression_threshold: Option<f64>) -> Self {
        Self {
            inner: Arc::new(Inner {
                window_size: config.window_size.unwrap_or(DEFAULT_WINDOW_SIZE),
                should_truncate_results: config.should_truncate_results.unwrap_or(true),
                pin_first: config.pin_first,
                pin_first_applied: AtomicBool::new(false),
                compression_threshold,
            }),
        }
    }

    /// The most messages kept in history.
    #[must_use]
    pub fn window_size(&self) -> usize {
        self.inner.window_size
    }

    /// Whether overflow recovery truncates tool results first.
    #[must_use]
    pub fn should_truncate_results(&self) -> bool {
        self.inner.should_truncate_results
    }
}

#[async_trait]
impl ConversationManager for SlidingWindowConversationManager {
    fn name(&self) -> &str {
        "strands:sliding-window-conversation-manager"
    }

    /// Truncates the oldest large tool result (overflow recovery only), otherwise trims the oldest
    /// messages.
    async fn reduce(&self, options: ConversationManagerReduceOptions<'_>) -> Result<bool> {
        let overflow = options.error.is_some();
        Ok(self.inner.reduce_context(options.agent.messages_mut(), overflow))
    }

    fn compression_threshold(&self) -> Option<f64> {
        self.inner.compression_threshold
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let inner = self.inner.clone();
        agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
            inner.apply_management(event.agent_mut().messages_mut());
        });
        Ok(())
    }
}

impl Inner {
    /// Trims history to the window after an invocation.
    fn apply_management(&self, messages: &mut Vec<Message>) {
        if messages.len() <= self.window_size {
            return;
        }
        self.reduce_context(messages, false);
    }

    fn reduce_context(&self, messages: &mut Vec<Message>, overflow: bool) -> bool {
        if let Some(count) = self.pin_first.filter(|count| *count > 0)
            && !self.pin_first_applied.swap(true, Ordering::Relaxed)
        {
            apply_pin_first(messages, count);
        }

        if overflow
            && self.should_truncate_results
            && let Some(index) = find_oldest_message_with_tool_results(messages)
            && truncate_tool_results(messages, index)
        {
            return true;
        }

        let start_index = if messages.len() <= self.window_size {
            2
        } else {
            messages.len() - self.window_size
        };
        let mut trim_index = find_valid_trim_point(messages, start_index);
        let mut fallback_user_index = None;
        if trim_index == messages.len()
            && self.window_size > 0
            && let Some(tool_pair_index) = find_tool_pair_trim_point(messages, start_index)
        {
            let Some(anchor) = find_tool_pair_user_anchor(messages, tool_pair_index) else {
                tracing::debug!(
                    "window_size=<{}>, trim_index=<{tool_pair_index}> | complete tool pair found but no valid user anchor, declining fallback",
                    self.window_size
                );
                return false;
            };
            tracing::debug!(
                "window_size=<{}>, trim_index=<{tool_pair_index}>, user_anchor_index=<{anchor}> | no plain user trim point, falling back to complete tool pair",
                self.window_size
            );
            trim_index = tool_pair_index;
            fallback_user_index = Some(anchor);
        }

        if trim_index > messages.len() || (trim_index == messages.len() && self.window_size > 0) {
            tracing::warn!(
                "window_size=<{}>, messages=<{}> | unable to trim conversation context, no valid trim point found",
                self.window_size,
                messages.len()
            );
            return false;
        }

        let to_remove: Vec<usize> = (0..trim_index)
            .filter(|&index| Some(index) != fallback_user_index && !is_pinned(messages, index))
            .collect();
        if to_remove.is_empty() {
            tracing::warn!(
                "window_size=<{}>, messages=<{}> | all messages in trim range are protected, unable to reduce",
                self.window_size,
                messages.len()
            );
            return false;
        }
        for index in to_remove.into_iter().rev() {
            messages.remove(index);
        }
        true
    }
}

/// The oldest unpinned message holding tool results.
pub(crate) fn find_oldest_message_with_tool_results(messages: &[Message]) -> Option<usize> {
    (0..messages.len()).find(|&index| !is_pinned(messages, index) && has_tool_result(&messages[index]))
}

/// The first assistant tool use at or after `start_index` whose result follows.
fn find_tool_pair_trim_point(messages: &[Message], start_index: usize) -> Option<usize> {
    (start_index..messages.len()).find(|&index| {
        let message = &messages[index];
        message.role == Role::Assistant
            && has_tool_use(message)
            && messages
                .get(index + 1)
                .is_some_and(|next| next.role == Role::User && has_tool_result(next))
    })
}

/// A user message that can stay right before a fallback tool pair:
/// the last pinned message when the pinned prefix is a valid user-first alternation, otherwise the
/// latest plain user message before the pair.
fn find_tool_pair_user_anchor(messages: &[Message], tool_pair_index: usize) -> Option<usize> {
    let pinned: Vec<usize> = (0..tool_pair_index)
        .filter(|&index| is_pinned(messages, index))
        .collect();
    let Some(&last_pinned) = pinned.last() else {
        return (0..tool_pair_index).rev().find(|&index| {
            let message = &messages[index];
            message.role == Role::User && !has_tool_use(message) && !has_tool_result(message)
        });
    };
    let first = &messages[pinned[0]];
    if first.role != Role::User || has_tool_result(first) {
        return None;
    }
    if pinned
        .windows(2)
        .any(|pair| messages[pair[0]].role == messages[pair[1]].role)
    {
        return None;
    }
    let last = &messages[last_pinned];
    (last.role == Role::User && !has_tool_use(last)).then_some(last_pinned)
}

/// Head and tail with a marker when `text` is over the threshold.
fn truncate_long_text(text: &str) -> Option<String> {
    let length = text.chars().count();
    if length <= TRUNCATION_THRESHOLD {
        return None;
    }
    let prefix: String = text.chars().take(PRESERVE_CHARS).collect();
    let suffix: String = text.chars().skip(length - PRESERVE_CHARS).collect();
    let removed = length - 2 * PRESERVE_CHARS;
    Some(format!("{prefix}\n<truncated chars=\"{removed}\"/>\n{suffix}"))
}

fn wire<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn image_placeholder(image: &ImageBlock) -> String {
    let format = wire(&image.format);
    match &image.source {
        ImageSource::Bytes(bytes) => format!("[image: {format}, source: bytes, {} bytes]", bytes.len()),
        ImageSource::Url(_) => format!("[image: {format}, source: url]"),
        _ => format!("[image: {format}, source: s3]"),
    }
}

fn video_placeholder(video: &VideoBlock) -> String {
    let format = wire(&video.format);
    match &video.source {
        VideoSource::Bytes(bytes) => format!("[video: {format}, source: bytes, {} bytes]", bytes.len()),
        _ => format!("[video: {format}, source: s3]"),
    }
}

fn document_placeholder(document: &DocumentBlock, bytes: Option<usize>) -> String {
    let format = wire(&document.format);
    match bytes {
        Some(bytes) => format!("[document: {}, {format}, source: bytes, {bytes} bytes]", document.name),
        None => format!("[document: {}, {format}, source: s3]", document.name),
    }
}

/// The truncated form of a document, or `None` when it stays as it is.
fn truncate_document(document: &DocumentBlock) -> Option<ToolResultContent> {
    let source = match &document.source {
        DocumentSource::Bytes(bytes) => {
            return Some(ToolResultContent::text(document_placeholder(
                document,
                Some(bytes.len()),
            )));
        }
        DocumentSource::Location(_) => return Some(ToolResultContent::text(document_placeholder(document, None))),
        DocumentSource::Text(text) => DocumentSource::Text(truncate_long_text(text)?),
        DocumentSource::Content(blocks) => {
            let truncated: Vec<Option<String>> = blocks.iter().map(|block| truncate_long_text(&block.text)).collect();
            if truncated.iter().all(Option::is_none) {
                return None;
            }
            DocumentSource::Content(
                blocks
                    .iter()
                    .zip(truncated)
                    .map(|(block, truncated)| truncated.map_or_else(|| block.clone(), TextBlock::new))
                    .collect(),
            )
        }
    };
    let mut document = document.clone();
    document.source = source;
    Some(ToolResultContent::Document(document))
}

/// The truncated form of one tool result item, or `None` when it stays as it is.
fn truncate_item(item: &ToolResultContent) -> Option<ToolResultContent> {
    match item {
        ToolResultContent::Image(image) => Some(ToolResultContent::text(image_placeholder(image))),
        ToolResultContent::Video(video) => Some(ToolResultContent::text(video_placeholder(video))),
        ToolResultContent::Document(document) => truncate_document(document),
        ToolResultContent::Json(json) => {
            let length = serde_json::to_string(&json.json).ok()?.chars().count();
            (length > TRUNCATION_THRESHOLD).then(|| ToolResultContent::text(format!("[json: {length} chars]")))
        }
        ToolResultContent::Text(text) => truncate_long_text(&text.text).map(ToolResultContent::text),
        _ => None,
    }
}

/// The truncated form of a tool result, keeping its status and error, or `None` when unchanged.
fn truncate_result(result: &ToolResultBlock) -> Option<ToolResultBlock> {
    let truncated: Vec<Option<ToolResultContent>> = result.content.iter().map(truncate_item).collect();
    if truncated.iter().all(Option::is_none) {
        return None;
    }
    let mut result = result.clone();
    result.content = result
        .content
        .iter()
        .zip(truncated)
        .map(|(item, truncated)| truncated.unwrap_or_else(|| item.clone()))
        .collect();
    Some(result)
}

/// Truncates the tool results of the message at `index`, keeping its tracking id and dropping its
/// metadata. Returns whether anything changed.
pub(crate) fn truncate_tool_results(messages: &mut [Message], index: usize) -> bool {
    let Some(message) = messages.get_mut(index) else {
        return false;
    };
    let mut changed = false;
    for block in &mut message.content {
        let ContentBlock::ToolResult(result) = block else {
            continue;
        };
        if let Some(truncated) = truncate_result(result) {
            *result = truncated;
            changed = true;
        }
    }
    if changed {
        message.metadata = None;
    }
    changed
}

#[cfg(test)]
pub(crate) mod test_access {
    use super::{Inner, SlidingWindowConversationManager};
    use crate::types::Message;

    impl SlidingWindowConversationManager {
        pub(crate) fn reduce_messages(&self, messages: &mut Vec<Message>, overflow: bool) -> bool {
            self.inner.reduce_context(messages, overflow)
        }

        pub(crate) fn apply_management(&self, messages: &mut Vec<Message>) {
            Inner::apply_management(&self.inner, messages);
        }
    }

    pub(crate) use super::{find_oldest_message_with_tool_results, truncate_tool_results};
}
