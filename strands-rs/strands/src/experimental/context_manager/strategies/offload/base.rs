//! Shared offload infrastructure: target routing, eager per-block offloading on message arrival,
//! `preserve_recent`, pair-safe message removal, removal markers and role alternation repair.
//!
//! Messages are identified by their index into the history.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;

use crate::agent::{InvocationContext, LocalAgent};
use crate::conversation_manager::compression::pin_message::is_pinned;
use crate::error::{Error, Result};
use crate::experimental::context_manager::retrieval_tool::RETRIEVAL_TOOL_NAME;
use crate::experimental::context_manager::stash::Stash;
use crate::experimental::context_manager::types::{ContextState, ContextStrategy};
use crate::hooks::MessageAddedEvent;
use crate::models::CountTokensOptions;
use crate::models::model_proxy::ModelProxy;
use crate::types::{
    ContentBlock, JsonObject, JsonValue, Message, MessageMetadata, Role, ToolResultBlock, ToolResultStatus,
};

/// What an offload strategy acts on (`OffloadTarget`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum OffloadTarget {
    /// All content: tool results and text blocks (`'*'`).
    All,
    /// Successful tool results (`'toolResults'`).
    ToolResults,
    /// Failed tool results (`'toolResultErrors'`).
    ToolResultErrors,
    /// Text blocks of assistant messages (`'assistantText'`).
    AssistantText,
    /// Text blocks of user messages, tool results excluded (`'userText'`).
    UserText,
    /// Results of the named tools, each `tool::<name>`; a leading `!` excludes a tool instead.
    Tools(Vec<String>),
}

impl OffloadTarget {
    /// The results of the named tools (`['tool::bash', '!tool::read']`).
    pub fn tools(tools: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Tools(tools.into_iter().map(Into::into).collect())
    }
}

/// When an offload strategy fires (`OffloadConditions`).
///
/// `threshold` alone acts per block, eagerly on message arrival; `utilization` acts on whole
/// messages, oldest first; both act on whole messages that hold a block over the threshold.
#[derive(Debug, Clone, Copy, Default, PartialEq, bon::Builder)]
pub struct OffloadConditions {
    /// Token size above which a block is offloaded.
    pub threshold: Option<f64>,
    /// Context utilization (0 to 1 and above) above which the strategy fires.
    pub utilization: Option<f64>,
    /// Recent matching messages to leave untouched: a count of 1 or more, or a ratio between 0
    /// and 1 exclusive.
    pub preserve_recent: Option<f64>,
}

fn finite_or_none(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite()).map(|value| value.max(0.0))
}

/// `toolUseId` to tool name, from every assistant tool use.
pub(crate) fn build_tool_name_map(messages: &[Message]) -> HashMap<String, String> {
    messages
        .iter()
        .filter(|message| message.role == Role::Assistant)
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some((tool_use.tool_use_id.clone(), tool_use.name.clone())),
            _ => None,
        })
        .collect()
}

/// A parsed `OffloadTarget::Tools` list.
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolFilter {
    include: Option<HashSet<String>>,
    exclude: Option<HashSet<String>>,
}

impl ToolFilter {
    fn resolve(target: &OffloadTarget) -> Self {
        const TOOL_PREFIX: &str = "tool::";
        let OffloadTarget::Tools(entries) = target else {
            return Self::default();
        };
        let strip = |name: &str| name.strip_prefix(TOOL_PREFIX).unwrap_or(name).to_owned();
        let mut includes = HashSet::new();
        let mut excludes = HashSet::new();
        for entry in entries {
            match entry.strip_prefix('!') {
                Some(name) => excludes.insert(strip(name)),
                None => includes.insert(strip(entry)),
            };
        }
        if !excludes.is_empty() && !includes.is_empty() {
            tracing::warn!("tool filter contains both includes and excludes, excludes will be ignored");
            return Self {
                include: Some(includes),
                exclude: None,
            };
        }
        Self {
            include: (!includes.is_empty()).then_some(includes),
            exclude: (!excludes.is_empty()).then_some(excludes),
        }
    }
}

/// Whether a tool result matches the target.
pub(crate) fn tool_matches_target(
    block: &ToolResultBlock,
    target: &OffloadTarget,
    tool_names: &HashMap<String, String>,
    filter: &ToolFilter,
) -> bool {
    match target {
        OffloadTarget::All => true,
        OffloadTarget::ToolResults => block.status == ToolResultStatus::Success,
        OffloadTarget::ToolResultErrors => block.status == ToolResultStatus::Error,
        OffloadTarget::AssistantText | OffloadTarget::UserText => false,
        OffloadTarget::Tools(_) => {
            let Some(name) = tool_names.get(&block.tool_use_id) else {
                return false;
            };
            if let Some(exclude) = &filter.exclude {
                return !exclude.contains(name);
            }
            filter.include.as_ref().is_some_and(|include| include.contains(name))
        }
    }
}

fn has_text(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::Text(_)))
}

/// Whether a message's text matches the target.
pub(crate) fn target_matches_message(target: &OffloadTarget, message: &Message) -> bool {
    match target {
        OffloadTarget::All => true,
        OffloadTarget::AssistantText => message.role == Role::Assistant && has_text(message),
        OffloadTarget::UserText => message.role == Role::User && has_text(message),
        _ => false,
    }
}

/// Whether a message matches the target by text or by a tool result.
pub(crate) fn message_matches_target(
    message: &Message,
    target: &OffloadTarget,
    tool_names: &HashMap<String, String>,
    filter: &ToolFilter,
) -> bool {
    if target_matches_message(target, message) {
        return true;
    }
    if message.role != Role::User {
        return false;
    }
    message.content.iter().any(|block| match block {
        ContentBlock::ToolResult(result) => tool_matches_target(result, target, tool_names, filter),
        _ => false,
    })
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "message counts are small and the rounded values are non-negative"
)]
/// The indices of target-matching messages except the most recent `preserve_recent` matches: a
/// count of 1 or more, or a ratio between 0 and 1 exclusive, rounded up.
pub(crate) fn get_oldest_matches(
    messages: &[Message],
    target: &OffloadTarget,
    preserve_recent: f64,
    tool_names: &HashMap<String, String>,
    filter: &ToolFilter,
) -> Vec<usize> {
    let matching: Vec<usize> = (0..messages.len())
        .filter(|&index| message_matches_target(&messages[index], target, tool_names, filter))
        .collect();
    let count = if preserve_recent > 0.0 && preserve_recent < 1.0 {
        (matching.len() as f64 * preserve_recent).ceil() as usize
    } else {
        preserve_recent.floor() as usize
    };
    if count == 0 || count >= matching.len() {
        return Vec::new();
    }
    matching[..matching.len() - count].to_vec()
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
/// message 0, the last message, or a pair that reaches either.
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

/// Removes the messages at `to_remove` with their tool pairs; returns how many were removed and
/// the lowest removed index.
pub(crate) fn splice_with_pairs(messages: &mut Vec<Message>, to_remove: &[usize]) -> (usize, usize) {
    let indices: BTreeSet<usize> = to_remove
        .iter()
        .flat_map(|&index| collect_removable_with_pair(messages, index))
        .collect();
    let lowest = indices.first().copied().unwrap_or(messages.len());
    for &index in indices.iter().rev() {
        messages.remove(index);
    }
    (indices.len(), lowest)
}

/// Adds a removal marker as assistant text at the gap: appended to an assistant message beside
/// it (keeping its tracking id and metadata), or as its own assistant message. It never joins
/// message 0.
pub(crate) fn insert_marker(messages: &mut Vec<Message>, index: usize, text: &str) {
    let index = index.min(messages.len()).max(1);
    for neighbor in [index - 1, index] {
        if neighbor > 0
            && messages
                .get(neighbor)
                .is_some_and(|carrier| carrier.role == Role::Assistant)
        {
            messages[neighbor].content.push(ContentBlock::text(text));
            return;
        }
    }
    let index = index.min(messages.len());
    messages.insert(index, Message::new(Role::Assistant, vec![ContentBlock::text(text)]));
}

fn pinned_flag(message: &Message) -> bool {
    message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.custom.as_ref())
        .and_then(|custom| custom.get("pinned"))
        == Some(&JsonValue::Bool(true))
}

/// Merges consecutive same-role messages to restore user/assistant alternation; a merged message
/// keeps the first one's tracking id and only the pin of either.
pub(crate) fn repair_alternation(messages: &mut Vec<Message>) {
    let mut repaired: Vec<Message> = Vec::with_capacity(messages.len());
    for current in messages.drain(..) {
        let Some(previous) = repaired.last_mut().filter(|previous| previous.role == current.role) else {
            repaired.push(current);
            continue;
        };
        let pinned = pinned_flag(previous) || pinned_flag(&current);
        previous.content.extend(current.content);
        previous.metadata = pinned.then(|| {
            let mut custom = JsonObject::new();
            custom.insert("pinned".to_owned(), JsonValue::Bool(true));
            MessageMetadata::new().with_custom(custom)
        });
    }
    *messages = repaired;
}

/// How one offload strategy replaces a block and marks removed messages.
#[async_trait]
pub(crate) trait BlockReplacer: Send + Sync + 'static {
    /// The replacement for a block, or `None` to leave it.
    async fn replace_block(
        &self,
        block: &ContentBlock,
        tokens: u64,
        message: &Message,
        agent: &LocalAgent,
        stash_refs: &[String],
        invocation_context: Option<&InvocationContext>,
    ) -> Result<Option<ContentBlock>>;

    /// The marker left where messages were removed, if any.
    fn removal_marker(&self, _count: usize) -> Option<String> {
        None
    }
}

/// The state every offload strategy shares.
pub(crate) struct OffloadCore {
    pub(crate) target: OffloadTarget,
    pub(crate) threshold: Option<f64>,
    pub(crate) utilization_threshold: Option<f64>,
    pub(crate) preserve_recent: f64,
    pub(crate) filter: ToolFilter,
    stash: Mutex<Option<Stash>>,
}

impl OffloadCore {
    /// # Errors
    ///
    /// An empty tool list target.
    pub(crate) fn new(target: OffloadTarget, conditions: OffloadConditions) -> Result<Self> {
        if matches!(&target, OffloadTarget::Tools(tools) if tools.is_empty()) {
            return Err(Error::other(
                "Empty array target matches nothing — provide at least one target",
            ));
        }
        let filter = ToolFilter::resolve(&target);
        Ok(Self {
            target,
            threshold: finite_or_none(conditions.threshold),
            utilization_threshold: finite_or_none(conditions.utilization),
            preserve_recent: finite_or_none(conditions.preserve_recent).unwrap_or(0.0),
            filter,
            stash: Mutex::new(None),
        })
    }

    pub(crate) fn stash(&self) -> Option<Stash> {
        self.stash.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub(crate) fn set_stash(&self, stash: Option<Stash>) {
        *self.stash.lock().unwrap_or_else(PoisonError::into_inner) = stash;
    }

    fn is_message_level(&self) -> bool {
        self.utilization_threshold.is_some()
    }

    /// Whether a block may be offloaded under the target. Injected text
    /// is written after its message was stashed, so a ref to it would point at nothing.
    pub(crate) fn block_matches_target(
        &self,
        block: &ContentBlock,
        message: &Message,
        tool_names: &HashMap<String, String>,
        stash: Option<&Stash>,
    ) -> bool {
        match block {
            ContentBlock::ToolUse(_)
            | ContentBlock::CachePoint(_)
            | ContentBlock::Reasoning(_)
            | ContentBlock::Injected(_) => false,
            ContentBlock::Text(_) => target_matches_message(&self.target, message),
            ContentBlock::ToolResult(result) => {
                if stash.is_some()
                    && tool_names.get(&result.tool_use_id).map(String::as_str) == Some(RETRIEVAL_TOOL_NAME)
                {
                    return false;
                }
                tool_matches_target(result, &self.target, tool_names, &self.filter)
            }
            _ => self.target == OffloadTarget::All,
        }
    }

    /// Registers the eager per-block hook for per-block strategies without `preserve_recent`
    /// (`init`).
    pub(crate) fn init(
        self: &Arc<Self>,
        replacer: Arc<dyn BlockReplacer>,
        agent: &mut LocalAgent,
        stash: Option<&Stash>,
    ) {
        self.set_stash(stash.cloned());
        if self.is_message_level() || self.preserve_recent > 0.0 {
            return;
        }
        let core = self.clone();
        let stash = stash.cloned();
        agent.add_async_hook::<MessageAddedEvent<'_>>(move |event| {
            let core = core.clone();
            let replacer = replacer.clone();
            let stash = stash.clone();
            Box::pin(async move {
                let tracking_id = event.message().tracking_id().to_owned();
                let agent = event.agent_mut();
                let Some(index) = agent
                    .messages()
                    .iter()
                    .rposition(|message| message.tracking_id() == tracking_id)
                else {
                    return Ok::<(), Error>(());
                };
                if is_pinned(agent.messages(), index) {
                    return Ok(());
                }
                let tool_names = build_tool_name_map(agent.messages());
                core.transform_blocks(replacer.as_ref(), agent, index, &tool_names, stash.as_ref(), None)
                    .await?;
                Ok(())
            })
        });
    }

    /// Runs the strategy (`apply`).
    pub(crate) async fn apply(&self, replacer: &dyn BlockReplacer, context: &mut ContextState<'_>) -> Result<bool> {
        if context.stash.is_none() {
            context.stash = self.stash();
        }
        let Some(utilization_threshold) = self.utilization_threshold else {
            return self.apply_per_block(replacer, context).await;
        };
        if !context.overflow && context.utilization < utilization_threshold {
            return Ok(false);
        }
        self.apply_per_message(replacer, context).await
    }

    pub(crate) async fn apply_per_block(
        &self,
        replacer: &dyn BlockReplacer,
        context: &mut ContextState<'_>,
    ) -> Result<bool> {
        let invocation_context = context.invocation_context.clone();
        let stash = context.stash.clone();
        let agent = &mut *context.agent;
        let tool_names = build_tool_name_map(agent.messages());
        let eligible: Vec<usize> = if self.preserve_recent > 0.0 {
            get_oldest_matches(
                agent.messages(),
                &self.target,
                self.preserve_recent,
                &tool_names,
                &self.filter,
            )
        } else {
            (0..agent.messages().len()).collect()
        };
        let mut acted = false;
        for index in eligible {
            if is_pinned(agent.messages(), index) {
                continue;
            }
            if self
                .transform_blocks(
                    replacer,
                    agent,
                    index,
                    &tool_names,
                    stash.as_ref(),
                    invocation_context.as_ref(),
                )
                .await?
            {
                acted = true;
            }
        }
        Ok(acted)
    }

    /// Removes eligible messages with pair safety and leaves a marker.
    pub(crate) async fn apply_per_message(
        &self,
        replacer: &dyn BlockReplacer,
        context: &mut ContextState<'_>,
    ) -> Result<bool> {
        if context.agent.messages().len() <= 1 {
            return Ok(false);
        }
        let eligible = self.eligible_messages(context.agent, context.stash.as_ref()).await?;
        if eligible.is_empty() {
            return Ok(false);
        }
        let messages = context.agent.messages_mut();
        let (removed, lowest) = splice_with_pairs(messages, &eligible);
        if removed == 0 {
            return Ok(false);
        }
        if let Some(marker) = replacer.removal_marker(removed) {
            insert_marker(messages, lowest, &marker);
        }
        repair_alternation(messages);
        Ok(true)
    }

    /// Offloads the eligible blocks of the message at `index`.
    pub(crate) async fn transform_blocks(
        &self,
        replacer: &dyn BlockReplacer,
        agent: &mut LocalAgent,
        index: usize,
        tool_names: &HashMap<String, String>,
        stash: Option<&Stash>,
        invocation_context: Option<&InvocationContext>,
    ) -> Result<bool> {
        let threshold = self.threshold.unwrap_or(0.0);
        let Some(message) = agent.messages().get(index).cloned() else {
            return Ok(false);
        };
        let mut acted = false;
        for (block_index, block) in message.content.iter().enumerate() {
            if !self.block_matches_target(block, &message, tool_names, stash) {
                continue;
            }
            let tokens = count_block_tokens(agent, message.role, block).await?;
            #[allow(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
            if tokens as f64 <= threshold {
                continue;
            }
            let refs = stash
                .map(|stash| stash.refs_for(block, &message, block_index))
                .unwrap_or_default();
            let Some(replacement) = replacer
                .replace_block(block, tokens, &message, agent, &refs, invocation_context)
                .await?
            else {
                continue;
            };
            if &replacement == block {
                continue;
            }
            if let Some(slot) = agent
                .messages_mut()
                .get_mut(index)
                .and_then(|live| live.content.get_mut(block_index))
            {
                *slot = replacement;
                acted = true;
            }
        }
        Ok(acted)
    }

    /// Eligible messages for message-level operations: `preserve_recent`, message 0, pins and the
    /// threshold respected.
    pub(crate) async fn eligible_messages(&self, agent: &LocalAgent, stash: Option<&Stash>) -> Result<Vec<usize>> {
        let messages = agent.messages();
        let tool_names = build_tool_name_map(messages);
        let candidates: Vec<usize> = if self.preserve_recent > 0.0 {
            get_oldest_matches(messages, &self.target, self.preserve_recent, &tool_names, &self.filter)
                .into_iter()
                .filter(|&index| index > 0 && !is_pinned(messages, index))
                .collect()
        } else {
            (1..messages.len())
                .filter(|&index| {
                    !is_pinned(messages, index)
                        && message_matches_target(&messages[index], &self.target, &tool_names, &self.filter)
                })
                .collect()
        };
        let Some(threshold) = self.threshold else {
            return Ok(candidates);
        };
        let mut eligible = Vec::new();
        for index in candidates {
            let message = &messages[index];
            for block in &message.content {
                if !self.block_matches_target(block, message, &tool_names, stash) {
                    continue;
                }
                let tokens = count_block_tokens(agent, message.role, block).await?;
                #[allow(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
                if tokens as f64 > threshold {
                    eligible.push(index);
                    break;
                }
            }
        }
        Ok(eligible)
    }
}

/// The tokens of one block sent alone in a message of `role`.
pub(crate) async fn count_block_tokens(agent: &LocalAgent, role: Role, block: &ContentBlock) -> Result<u64> {
    agent
        .model()
        .count_tokens(
            &[Message::new(role, vec![block.clone()])],
            CountTokensOptions::default(),
        )
        .await
}

const EMERGENCY_REMOVAL_RATIO: f64 = 0.2;

/// The last-resort strategy the context manager appends: when the window still overflows after
/// every configured strategy, it drops the oldest 20% of the messages after message 0
/// (`EmergencyTruncateStrategy`).
pub struct EmergencyTruncateStrategy {
    core: OffloadCore,
}

impl EmergencyTruncateStrategy {
    /// Creates the strategy.
    #[must_use]
    pub fn new() -> Self {
        Self {
            core: OffloadCore {
                target: OffloadTarget::All,
                threshold: None,
                utilization_threshold: None,
                preserve_recent: 0.0,
                filter: ToolFilter::default(),
                stash: Mutex::new(None),
            },
        }
    }
}

impl Default for EmergencyTruncateStrategy {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for EmergencyTruncateStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmergencyTruncateStrategy").finish_non_exhaustive()
    }
}

pub(crate) fn elided_marker(count: usize) -> String {
    let noun = if count == 1 { "message" } else { "messages" };
    format!("[... {count} {noun} elided ...]")
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "message counts are small"
)]
fn emergency_removal(messages: &mut Vec<Message>) -> bool {
    if messages.len() <= 3 {
        return false;
    }
    let removable: Vec<usize> = (1..messages.len()).collect();
    let mut remove_count = ((removable.len() as f64 * EMERGENCY_REMOVAL_RATIO).floor() as usize).max(1);
    let next_is_assistant = removable
        .get(remove_count)
        .is_some_and(|&index| messages[index].role == Role::Assistant);
    if !next_is_assistant {
        remove_count += 1;
    }
    let to_remove = &removable[..remove_count.min(removable.len())];
    let (removed, lowest) = splice_with_pairs(messages, to_remove);
    if removed == 0 {
        return false;
    }
    insert_marker(messages, lowest, &elided_marker(removed));
    repair_alternation(messages);
    true
}

#[async_trait]
impl ContextStrategy for EmergencyTruncateStrategy {
    fn name(&self) -> &str {
        "offload:emergency-truncate"
    }

    fn init(&self, _agent: &mut LocalAgent, stash: Option<&Stash>) {
        self.core.set_stash(stash.cloned());
    }

    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
        if context.agent.messages().len() <= 3 {
            return Ok(false);
        }
        if !context.overflow {
            let model = context.agent.model().clone();
            let tokens = ModelProxy::new(model.clone())
                .count_tokens(context.agent.messages(), CountTokensOptions::default())
                .await?;
            if model.estimate_utilization(tokens) < 1.0 {
                return Ok(false);
            }
        }
        Ok(emergency_removal(context.agent.messages_mut()))
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
