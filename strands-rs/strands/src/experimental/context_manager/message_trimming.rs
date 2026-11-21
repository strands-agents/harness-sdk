//! Trimming messages from the context window while keeping it valid for the model: removing them
//! with their tool pairs, leaving a placeholder for each removed run, and restoring user/assistant
//! alternation.
//!
//! Messages are identified by their index into the history.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;

use super::placeholder::{carried_tokens, offload_placeholder};
use super::stash::Stash;
use crate::agent::LocalAgent;
use crate::error::Result;
use crate::models::{CountTokensOptions, Model};
use crate::types::{ContentBlock, Message, MessageMetadata, OffloadMethod, Role, TextBlock};

/// The tokens a run stands for once it is removed: its current content plus what any marker it
/// carries already stood for (`removedTokens`).
///
/// # Errors
///
/// The model's token count error.
pub(crate) async fn removed_tokens(run: &[Message], model: &dyn Model) -> Result<u64> {
    let carried = carried_tokens(run.iter().flat_map(|message| &message.content));
    Ok(model.count_tokens(run, CountTokensOptions::default()).await? + carried)
}

/// The text a removed run leaves behind and the tokens it stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Placeholder {
    pub(crate) text: String,
    pub(crate) tokens: u64,
}

/// Writes the placeholder for messages about to be removed with their tool pairs. `None` keeps
/// them, as summarize does when its model call fails.
#[async_trait]
pub(crate) trait PlaceholderText: Send + Sync {
    async fn text_for(&self, agent: &LocalAgent, removed: &[Message]) -> Result<Option<Placeholder>>;
}

/// A placeholder reading `format(tokens)`, for the methods that always leave a marker
/// (`placeholderFor`). Tokens are counted with `model`, or the agent's model when unset.
pub(crate) struct FormattedPlaceholder {
    model: Option<Arc<dyn Model>>,
    format: Box<dyn Fn(u64) -> String + Send + Sync>,
}

impl FormattedPlaceholder {
    pub(crate) fn new(format: impl Fn(u64) -> String + Send + Sync + 'static) -> Self {
        Self {
            model: None,
            format: Box::new(format),
        }
    }

    pub(crate) fn counted_with(mut self, model: Arc<dyn Model>) -> Self {
        self.model = Some(model);
        self
    }
}

#[async_trait]
impl PlaceholderText for FormattedPlaceholder {
    async fn text_for(&self, agent: &LocalAgent, removed: &[Message]) -> Result<Option<Placeholder>> {
        let model = self.model.as_ref().unwrap_or_else(|| agent.model());
        let tokens = removed_tokens(removed, model.as_ref()).await?;
        Ok(Some(Placeholder {
            text: (self.format)(tokens),
            tokens,
        }))
    }
}

fn has_tool_result(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult(_)))
}

fn has_tool_use(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse(_)))
}

/// The message at `index` and the tool-use or tool-result partner it would orphan; nothing for
/// message 0, the last message, or a pair that reaches either (`collectRemovableWithPair`).
pub(crate) fn collect_removable_with_pair(messages: &[Message], index: usize) -> Vec<usize> {
    let Some(message) = messages.get(index) else {
        return Vec::new();
    };
    if index == 0 || index == messages.len() - 1 {
        return Vec::new();
    }
    let mut result = vec![index];
    if has_tool_result(message) && has_tool_use(&messages[index - 1]) {
        if index - 1 == 0 {
            return Vec::new();
        }
        result.push(index - 1);
    }
    if has_tool_use(message) && messages.get(index + 1).is_some_and(has_tool_result) {
        if index + 1 >= messages.len() - 1 {
            return Vec::new();
        }
        result.push(index + 1);
    }
    result
}

/// The removable messages among `to_remove`, with their tool pairs, in conversation order
/// (`withPairs`).
pub(crate) fn with_pairs(messages: &[Message], to_remove: &[usize]) -> Vec<usize> {
    to_remove
        .iter()
        .flat_map(|&index| collect_removable_with_pair(messages, index))
        .collect::<BTreeSet<usize>>()
        .into_iter()
        .collect()
}

/// Adds a marker as assistant content at the gap left by removed messages (`insertMarker`).
///
/// The marker is appended to an assistant message beside the gap, which keeps that message's
/// tracking id and block indices for stash refs, or becomes its own assistant message. It never
/// joins message 0.
pub(crate) fn insert_marker(messages: &mut Vec<Message>, index: usize, marker: TextBlock) {
    let index = index.min(messages.len()).max(1);
    for neighbor in [index - 1, index] {
        if neighbor > 0
            && let Some(carrier) = messages
                .get_mut(neighbor)
                .filter(|carrier| carrier.role == Role::Assistant)
        {
            carrier.content.push(ContentBlock::Text(marker));
            return;
        }
    }
    let index = index.min(messages.len());
    messages.insert(index, Message::new(Role::Assistant, vec![ContentBlock::Text(marker)]));
}

/// Merges consecutive same-role messages to restore user/assistant alternation
/// (`repairAlternation`). A merge keeps the earlier message's tracking id and merges both
/// messages' metadata, so it is pinned if either was.
pub(crate) fn repair_alternation(messages: &mut Vec<Message>) {
    let mut repaired: Vec<Message> = Vec::with_capacity(messages.len());
    for current in messages.drain(..) {
        let Some(previous) = repaired.last_mut().filter(|previous| previous.role == current.role) else {
            repaired.push(current);
            continue;
        };
        previous.metadata = merge_metadata(previous.metadata.take(), current.metadata);
        previous.content.extend(current.content);
    }
    *messages = repaired;
}

/// The later message's metadata fields win, and `custom` holds both messages' entries.
fn merge_metadata(earlier: Option<MessageMetadata>, later: Option<MessageMetadata>) -> Option<MessageMetadata> {
    let (Some(earlier), Some(later)) = (&earlier, &later) else {
        return later.or(earlier);
    };
    let mut custom = earlier.custom.clone().unwrap_or_default();
    custom.extend(later.custom.clone().unwrap_or_default());
    let mut merged = MessageMetadata::new();
    merged.usage = later.usage.or(earlier.usage);
    merged.metrics = later.metrics.or(earlier.metrics);
    merged.custom = if custom.is_empty() {
        later.custom.clone().or_else(|| earlier.custom.clone())
    } else {
        Some(custom)
    };
    Some(merged)
}

/// Removes messages with their tool pairs and leaves one placeholder for each contiguous run of
/// them, each stashed under its own reference (`removeMessages`). A run whose text is `None` is
/// kept, and a failed stash write leaves the placeholder without a reference. Callers restore
/// alternation once they are done.
///
/// # Errors
///
/// The placeholder's error, such as a failed token count.
pub(crate) async fn remove_messages(
    agent: &mut LocalAgent,
    to_remove: &[usize],
    text_for: &dyn PlaceholderText,
    method: OffloadMethod,
    stash: Option<&Stash>,
) -> Result<bool> {
    let runs = split_into_runs(&with_pairs(agent.messages(), to_remove));
    let mut acted = false;
    // Last run first, so removing a run leaves the earlier runs' positions unchanged.
    for run in runs.into_iter().rev() {
        if remove_run(agent, run, text_for, method, stash).await? {
            acted = true;
        }
    }
    Ok(acted)
}

/// Replaces a contiguous run of messages with one placeholder.
async fn remove_run(
    agent: &mut LocalAgent,
    run: std::ops::Range<usize>,
    text_for: &dyn PlaceholderText,
    method: OffloadMethod,
    stash: Option<&Stash>,
) -> Result<bool> {
    let removed: Vec<Message> = agent.messages()[run.clone()].to_vec();
    let Some(placeholder) = text_for.text_for(agent, &removed).await? else {
        return Ok(false);
    };
    let start = run.start;
    // Stashed before the run is taken out, and the marker inserted with no await in between: a pass
    // dropped at an await would otherwise leave the run neither in the history nor retrievable.
    let stash_ref = stash_removed(stash, &removed, method).await;
    agent.messages_mut().drain(run);
    let marker = offload_placeholder(method, &placeholder.text, stash_ref.as_deref(), placeholder.tokens);
    insert_marker(agent.messages_mut(), start, marker);
    Ok(true)
}

/// The reference a run of removed messages is retrievable under, or `None` when there is no stash
/// or the write failed, which leaves the placeholder without a reference (`stashRemoved`).
pub(crate) async fn stash_removed(stash: Option<&Stash>, removed: &[Message], method: OffloadMethod) -> Option<String> {
    let stash = stash?;
    if removed.is_empty() {
        return None;
    }
    match stash.store_removed(removed).await {
        Ok(reference) => Some(reference),
        Err(error) => {
            tracing::warn!("method=<{method}>, error=<{error}> | failed to stash removed messages");
            None
        }
    }
}

/// Splits sorted indices into runs of adjacent ones.
fn split_into_runs(selected: &[usize]) -> Vec<std::ops::Range<usize>> {
    let mut runs: Vec<std::ops::Range<usize>> = Vec::new();
    for &index in selected {
        match runs.last_mut() {
            Some(run) if run.end == index => run.end = index + 1,
            _ => runs.push(index..index + 1),
        }
    }
    runs
}

#[cfg(test)]
#[path = "message_trimming/tests.rs"]
mod tests;
