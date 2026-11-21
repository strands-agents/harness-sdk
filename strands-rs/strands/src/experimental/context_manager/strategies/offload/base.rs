//! Base offload strategy: conditions, target routing, eager hooks, and the shared per-block and
//! message-level execution paths.
//!
//! Reading order: `apply` checks `reached`, then a block target runs `transform_blocks`, which
//! calls each strategy's `replace_block`, and target `All` runs the strategy's
//! `apply_per_message` on `removable_messages`, which hands them to `remove_messages` in
//! `message_trimming` before `repair_alternation` restores alternation.
//!
//! Messages are identified by their index into the history.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;

use super::conditions::{OffloadConditions, ResolvedConditions};
use super::target::{
    OffloadTarget, OffloadTargetMatcher, build_tool_name_map, is_media_block, is_media_content, is_protocol_block,
    target_json,
};
use crate::agent::{InvocationContext, LocalAgent};
use crate::conversation_manager::compression::pin_message::is_pinned;
use crate::error::{Error, Result};
use crate::experimental::context_manager::message_trimming::{
    FormattedPlaceholder, collect_removable_with_pair, remove_messages, repair_alternation,
};
use crate::experimental::context_manager::placeholder::{
    carried_tokens, format_elided, is_offloaded, offload_placeholder, offloaded_content_of,
};
use crate::experimental::context_manager::retrieval_tool::RETRIEVAL_TOOL_NAME;
use crate::experimental::context_manager::stash::Stash;
use crate::experimental::context_manager::types::{ContextState, ContextStrategy};
use crate::hooks::MessageAddedEvent;
use crate::logging::warn_once;
use crate::models::model_proxy::ModelProxy;
use crate::models::{CountTokensOptions, is_js_whitespace};
use crate::types::{ContentBlock, Message, OffloadMethod, Role, TextBlock, ToolResultBlock};

/// How one offload method replaces a block and removes whole messages.
#[async_trait]
pub(crate) trait OffloadBehavior: Send + Sync + 'static {
    /// The replacement for a block, or `None` to leave it. `tokens` is the size the replacement
    /// stands for: the block's own tokens plus what a placeholder it holds already stood for.
    /// `stash_ref` is the reference the original is retrievable under; `tool_name` names the tool
    /// that produced a tool result, when its tool use is in the conversation.
    #[allow(clippy::too_many_arguments, reason = "mirrors the shared replace hook")]
    async fn replace_block(
        &self,
        core: &OffloadCore,
        block: &ContentBlock,
        tokens: u64,
        message: &Message,
        agent: &LocalAgent,
        stash_ref: Option<&str>,
        tool_name: Option<&str>,
        invocation_context: Option<&InvocationContext>,
    ) -> Result<Option<ContentBlock>>;

    /// Message-level execution for target `All`; `apply` restores alternation afterwards.
    async fn apply_per_message(&self, core: &OffloadCore, context: &mut ContextState<'_>) -> Result<bool>;
}

/// The state every offload strategy shares: conditions, firing, granularity, eager hooks and
/// `preserve_recent`.
pub(crate) struct OffloadCore {
    pub(crate) name: String,
    pub(crate) method: OffloadMethod,
    pub(crate) matcher: OffloadTargetMatcher,
    pub(crate) conditions: ResolvedConditions,
    /// Whether the eager hook processes each message as it arrives.
    runs_eagerly: bool,
    /// The conditions as given to `when`, for `Debug`.
    pub(crate) offload_conditions: Option<OffloadConditions>,
    stash: Mutex<Option<Stash>>,
}

impl OffloadCore {
    /// A core for `method` on `target`; with `conditions` given, they are checked to leave the
    /// strategy runnable.
    ///
    /// # Errors
    ///
    /// A target that matches nothing, an invalid condition value, or conditions that leave the
    /// strategy unable to run.
    pub(crate) fn new(
        method: OffloadMethod,
        target: OffloadTarget,
        conditions: Option<OffloadConditions>,
    ) -> Result<Self> {
        let matcher = OffloadTargetMatcher::new(target)?;
        let resolved = conditions
            .as_ref()
            .map(ResolvedConditions::new)
            .transpose()?
            .unwrap_or_default();
        let runs_eagerly = !matcher.matches_all() && !resolved.defers_arrival();
        let core = Self {
            name: format!("offload:{method}"),
            method,
            matcher,
            conditions: resolved,
            runs_eagerly,
            offload_conditions: conditions,
            stash: Mutex::new(None),
        };
        if core.offload_conditions.is_some() {
            core.check_runnable()?;
        }
        Ok(core)
    }

    pub(crate) fn target(&self) -> &OffloadTarget {
        &self.matcher.target
    }

    pub(crate) fn stash(&self) -> Option<Stash> {
        self.stash.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn set_stash(&self, stash: Option<Stash>) {
        *self.stash.lock().unwrap_or_else(PoisonError::into_inner) = stash;
    }

    /// Rejects conditions that leave the strategy acting on every message, or removing media
    /// unseen.
    fn check_runnable(&self) -> Result<()> {
        let method = self.method;
        if self.matcher.matches_all() && self.conditions.is_empty() {
            return Err(Error::other(format!(
                "Offload.{method}(\"*\") would act on every message; use .when() to set contextUtilization, blockThreshold, or a preserveRecent above 0"
            )));
        }
        if self.matcher.target == OffloadTarget::Media && self.runs_eagerly {
            return Err(Error::other(format!(
                "Offload.{method}(\"media\") would remove media before the model sees it; use .when() to set contextUtilization or a preserveRecent above 0"
            )));
        }
        Ok(())
    }

    /// Checks the conditions can run on this agent, then registers the eager hook if this runs
    /// eagerly (`init`).
    ///
    /// # Errors
    ///
    /// A whole-message strategy with none of `context_utilization`, `block_threshold` or
    /// `preserve_recent`, a media strategy with neither `context_utilization` nor
    /// `preserve_recent`, or a token-count `context_utilization` larger than the model's context
    /// window.
    pub(crate) fn init(
        self: &Arc<Self>,
        behavior: Arc<dyn OffloadBehavior>,
        agent: &mut LocalAgent,
        stash: Option<&Stash>,
    ) -> Result<()> {
        self.set_stash(stash.cloned());
        self.check_runnable()?;
        self.conditions.check_fits(agent)?;
        if !self.runs_eagerly {
            return Ok(());
        }
        if self.conditions.is_empty() {
            let target = target_json(&self.matcher.target);
            warn_once(&format!(
                "strategy=<{}>, target=<{target}> | strategy has no conditions, so it acts on every matching block as it arrives, before the model reads it | use .when() to set blockThreshold, contextUtilization, or preserveRecent",
                self.name
            ));
        }
        let core = self.clone();
        agent.add_async_hook::<MessageAddedEvent<'_>>(move |event| {
            let core = core.clone();
            let behavior = behavior.clone();
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
                let threshold = core.conditions.threshold_tokens(agent);
                let tool_names = build_tool_name_map(agent.messages());
                let stash = core.stash();
                core.transform_blocks(
                    behavior.as_ref(),
                    agent,
                    index,
                    &tool_names,
                    threshold,
                    stash.as_ref(),
                    None,
                )
                .await?;
                Ok(())
            })
        });
        Ok(())
    }

    /// Runs the strategy (`apply`).
    pub(crate) async fn apply(&self, behavior: &dyn OffloadBehavior, context: &mut ContextState<'_>) -> Result<bool> {
        if context.stash.is_some() {
            self.set_stash(context.stash.clone());
        }
        if !self.conditions.reached(context) {
            return Ok(false);
        }
        if !self.matcher.matches_all() {
            return self.apply_per_block(behavior, context).await;
        }
        let acted = behavior.apply_per_message(self, context).await?;
        if acted {
            repair_alternation(context.agent.messages_mut());
        }
        Ok(acted)
    }

    /// Per-block execution: walk each message and replace individual blocks above the threshold.
    async fn apply_per_block(&self, behavior: &dyn OffloadBehavior, context: &mut ContextState<'_>) -> Result<bool> {
        let invocation_context = context.invocation_context.clone();
        let stash = self.stash();
        let agent = &mut *context.agent;
        let tool_names = build_tool_name_map(agent.messages());
        let threshold = self.conditions.threshold_tokens(agent);
        let last = agent.messages().len().saturating_sub(1);
        let mut acted = false;
        for index in self.unprotected_matches(agent.messages(), &tool_names) {
            // Without the eager hook, message 0 is the task and the last message is one the model
            // has not yet responded to.
            if !self.runs_eagerly && (index == 0 || index == last) {
                continue;
            }
            if self
                .transform_blocks(
                    behavior,
                    agent,
                    index,
                    &tool_names,
                    threshold,
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

    /// Matching messages outside `preserve_recent`, without pinned ones, in history order.
    fn unprotected_matches(&self, messages: &[Message], tool_names: &HashMap<String, String>) -> Vec<usize> {
        let matching: Vec<usize> = (0..messages.len())
            .filter(|&index| self.matcher.matches_message(&messages[index], tool_names))
            .collect();
        self.conditions
            .without_preserved(&matching)
            .into_iter()
            .filter(|&index| !is_pinned(messages, index))
            .collect()
    }

    /// Messages outside `preserve_recent` and larger than `block_threshold`, excluding message 0,
    /// pinned messages, and messages whose tool partner is protected, since removing a message
    /// removes its partner too.
    ///
    /// # Errors
    ///
    /// The model's token count error.
    pub(crate) async fn removable_messages(&self, agent: &LocalAgent) -> Result<Vec<usize>> {
        let messages = agent.messages();
        let unprotected = self.unprotected_matches(messages, &build_tool_name_map(messages));
        let unprotected_set: HashSet<usize> = unprotected.iter().copied().collect();
        let removable: Vec<usize> = unprotected
            .into_iter()
            .filter(|&index| {
                index != 0
                    && collect_removable_with_pair(messages, index)
                        .iter()
                        .all(|removed| unprotected_set.contains(removed))
            })
            .collect();
        let Some(threshold) = self.conditions.threshold_tokens(agent) else {
            return Ok(removable);
        };
        let mut over = Vec::new();
        for index in removable {
            let size = agent
                .model()
                .count_tokens(std::slice::from_ref(&messages[index]), CountTokensOptions::default())
                .await?;
            if size > threshold {
                over.push(index);
            }
        }
        Ok(over)
    }

    /// The placeholder this strategy leaves for a block it replaced, recording the tokens it
    /// stands for.
    pub(crate) fn placeholder(&self, preview: &str, stash_ref: Option<&str>, tokens: u64) -> TextBlock {
        offload_placeholder(self.method, preview, stash_ref, tokens)
    }

    /// Whether a block in `message` is content this strategy may replace.
    fn is_offloadable(
        &self,
        block: &ContentBlock,
        message: &Message,
        tool_names: &HashMap<String, String>,
        stash: Option<&Stash>,
    ) -> bool {
        if is_protocol_block(block) || is_offloaded(block) {
            return false;
        }
        match block {
            ContentBlock::Text(text) if text.text.trim_matches(is_js_whitespace).is_empty() => return false,
            // Injected text is written after its message was stashed, so a ref to it would point at
            // nothing.
            ContentBlock::Injected(_) => return false,
            ContentBlock::ToolResult(result) if self.is_protected_result(result, tool_names, stash) => return false,
            _ => {}
        }
        self.matcher.matches_block(block, message, tool_names)
    }

    /// Whether a tool result is the retrieval tool's output, or already holds a placeholder this
    /// strategy shouldn't replace. Only drop goes further, since truncate and summarize would read
    /// the placeholder as the content.
    fn is_protected_result(
        &self,
        block: &ToolResultBlock,
        tool_names: &HashMap<String, String>,
        stash: Option<&Stash>,
    ) -> bool {
        if stash.is_some() && tool_names.get(&block.tool_use_id).map(String::as_str) == Some(RETRIEVAL_TOOL_NAME) {
            return true;
        }
        block
            .content
            .iter()
            .find_map(offloaded_content_of)
            .is_some_and(|placeholder| self.method != OffloadMethod::Drop || placeholder.method == OffloadMethod::Drop)
    }

    /// Replaces each eligible block of the message at `index` larger than `threshold` tokens, or
    /// every one when unset.
    #[allow(
        clippy::too_many_arguments,
        reason = "the per-block pass and the eager hook share it"
    )]
    pub(crate) async fn transform_blocks(
        &self,
        behavior: &dyn OffloadBehavior,
        agent: &mut LocalAgent,
        index: usize,
        tool_names: &HashMap<String, String>,
        threshold: Option<u64>,
        stash: Option<&Stash>,
        invocation_context: Option<&InvocationContext>,
    ) -> Result<bool> {
        let Some(message) = agent.messages().get(index).cloned() else {
            return Ok(false);
        };
        let mut acted = false;
        for (block_index, block) in message.content.iter().enumerate() {
            if !self.is_offloadable(block, &message, tool_names, stash) {
                continue;
            }
            let measured = count_block_tokens(agent, message.role, block).await?;
            // The token heuristic counts media as 0, so unmeasured media is never treated as within
            // the threshold.
            if threshold.is_some_and(|threshold| measured <= threshold) && !(measured == 0 && holds_media(block)) {
                continue;
            }
            let stash_ref = match stash {
                Some(stash) => Some(stash.ensure_stashed(block, &message, block_index).await?),
                None => None,
            };
            let tool_name = match block {
                ContentBlock::ToolResult(result) => tool_names.get(&result.tool_use_id).map(String::as_str),
                _ => None,
            };
            // The threshold measures what the block occupies now; the replacement stands for what is
            // behind it as well.
            let tokens = measured + carried_tokens([block]);
            let Some(replacement) = behavior
                .replace_block(
                    self,
                    block,
                    tokens,
                    &message,
                    agent,
                    stash_ref.as_deref(),
                    tool_name,
                    invocation_context,
                )
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
}

/// Whether a block is media, or a tool result holding media.
fn holds_media(block: &ContentBlock) -> bool {
    match block {
        ContentBlock::ToolResult(result) => result.content.iter().any(is_media_content),
        other => is_media_block(other),
    }
}

/// The tokens of one block sent alone in a message of `role`.
///
/// # Errors
///
/// The model's token count error.
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
/// every configured strategy, it drops the oldest 20% of the messages after message 0, ignoring
/// pins so an all-pinned overflow is still recoverable (`EmergencyTruncateStrategy`).
#[derive(Debug, Default)]
pub struct EmergencyTruncateStrategy;

impl EmergencyTruncateStrategy {
    /// Creates the strategy.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ContextStrategy for EmergencyTruncateStrategy {
    fn name(&self) -> &str {
        "offload:emergency-truncate"
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "message counts are small"
    )]
    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
        let length = context.agent.messages().len();
        if length <= 3 {
            return Ok(false);
        }
        if !context.overflow {
            // Only what this strategy can remove, never the pipeline's whole-request utilization:
            // that also carries the system prompt and tool specs, which dropping messages cannot
            // shrink, and it is anchored on the last call's usage, which an earlier strategy in the
            // pass has already invalidated.
            let model = context.agent.model().clone();
            let tokens = ModelProxy::new(model.clone())
                .count_tokens(context.agent.messages(), CountTokensOptions::default())
                .await?;
            if model.estimate_utilization(tokens) < 1.0 {
                return Ok(false);
            }
        }
        let removable: Vec<usize> = (1..length).collect();
        let mut remove_count = ((removable.len() as f64 * EMERGENCY_REMOVAL_RATIO).floor() as usize).max(1);
        // Cut just before an assistant message, which holds no tool result to orphan and never
        // merges into message 0.
        let next_is_assistant = removable
            .get(remove_count)
            .is_some_and(|&index| context.agent.messages()[index].role == Role::Assistant);
        if !next_is_assistant {
            remove_count += 1;
        }
        let to_remove = &removable[..remove_count.min(removable.len())];
        let text_for = FormattedPlaceholder::new(format_elided);
        let stash = context.stash.clone();
        if !remove_messages(
            context.agent,
            to_remove,
            &text_for,
            OffloadMethod::Truncate,
            stash.as_ref(),
        )
        .await?
        {
            return Ok(false);
        }
        repair_alternation(context.agent.messages_mut());
        Ok(true)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
