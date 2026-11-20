//! Message pinning: pinned messages carry `metadata.custom.pinned = true` and survive context
//! reduction.

use crate::types::{ContentBlock, JsonValue, Message, MessageMetadata};

const PINNED: &str = "pinned";

fn pinned_flag(message: &Message) -> bool {
    message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.custom.as_ref())
        .and_then(|custom| custom.get(PINNED))
        == Some(&JsonValue::Bool(true))
}

fn tool_use_ids(message: &Message) -> impl Iterator<Item = &str> {
    message.content.iter().filter_map(|block| match block {
        ContentBlock::ToolUse(tool_use) => Some(tool_use.tool_use_id.as_str()),
        _ => None,
    })
}

fn tool_result_ids(message: &Message) -> impl Iterator<Item = &str> {
    message.content.iter().filter_map(|block| match block {
        ContentBlock::ToolResult(result) => Some(result.tool_use_id.as_str()),
        _ => None,
    })
}

fn pairs(uses: &Message, results: &Message) -> bool {
    let result_ids: Vec<&str> = tool_result_ids(results).collect();
    tool_use_ids(uses).any(|id| result_ids.contains(&id))
}

/// Whether the message at `index` is pinned, or is the tool-use or tool-result partner of an
/// adjacent pinned message, matched by tool use id.
pub(crate) fn is_pinned(messages: &[Message], index: usize) -> bool {
    let message = &messages[index];
    if pinned_flag(message) {
        return true;
    }
    let partner_of_previous = index > 0 && tool_result_ids(message).next().is_some() && {
        let previous = &messages[index - 1];
        pinned_flag(previous) && pairs(previous, message)
    };
    let partner_of_next = tool_use_ids(message).next().is_some()
        && messages
            .get(index + 1)
            .is_some_and(|next| pinned_flag(next) && pairs(message, next));
    partner_of_previous || partner_of_next
}

/// Pins a message: sets `metadata.custom.pinned = true`, keeping other metadata.
pub(crate) fn pin_message(messages: &mut [Message], index: usize) {
    let metadata = messages[index].metadata.get_or_insert_with(MessageMetadata::new);
    metadata
        .custom
        .get_or_insert_with(Default::default)
        .insert(PINNED.to_owned(), JsonValue::Bool(true));
}

/// Unpins a message, dropping `custom` and then `metadata` when nothing else remains.
pub(crate) fn unpin_message(messages: &mut [Message], index: usize) {
    let message = &mut messages[index];
    let Some(metadata) = message.metadata.as_mut() else {
        return;
    };
    if let Some(custom) = metadata.custom.as_mut() {
        custom.shift_remove(PINNED);
        if custom.is_empty() {
            metadata.custom = None;
        }
    }
    if metadata.usage.is_none() && metadata.metrics.is_none() && metadata.custom.is_none() {
        message.metadata = None;
    }
}

/// Pins the first `count` messages.
pub(crate) fn apply_pin_first(messages: &mut [Message], count: usize) {
    for index in 0..count.min(messages.len()) {
        pin_message(messages, index);
    }
}

/// Splits `messages[start..end]` into the pinned and the unpinned messages.
pub(crate) fn partition_pinned(messages: &[Message], start: usize, end: usize) -> (Vec<Message>, Vec<Message>) {
    (start..end).fold((Vec::new(), Vec::new()), |(mut pinned, mut unpinned), index| {
        if is_pinned(messages, index) {
            pinned.push(messages[index].clone());
        } else {
            unpinned.push(messages[index].clone());
        }
        (pinned, unpinned)
    })
}
