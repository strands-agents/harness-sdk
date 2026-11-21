//! The truncate strategy: replaces oversized content with a preview, or elides the middle of the
//! conversation.

use std::sync::Arc;

use async_trait::async_trait;

use super::base::{OffloadBehavior, OffloadCore};
use super::conditions::OffloadConditions;
use super::target::{OffloadTarget, media_kind};
use crate::agent::{InvocationContext, LocalAgent};
use crate::context_manager::archive::Archive;
use crate::context_manager::message_trimming::{FormattedPlaceholder, remove_messages, with_pairs};
use crate::context_manager::methods::truncate::{TruncateConfig, truncate_text_block, truncate_tool_result_block};
use crate::context_manager::placeholder::{format_elided, format_offloaded, is_offloaded};
use crate::context_manager::types::{ContextState, ContextStrategy};
use crate::error::{Error, Result};
use crate::models::CountTokensOptions;
use crate::types::{ContentBlock, Message, OffloadMethod, ToolResultContent};

struct TruncateBehavior {
    config: TruncateConfig,
    preview_tokens: f64,
}

impl TruncateBehavior {
    #[allow(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
    /// The eligible messages between the head and tail kept within the preview token budget.
    async fn select_middle(&self, eligible: &[usize], agent: &LocalAgent) -> Result<Vec<usize>> {
        let head_budget = self.preview_tokens * self.config.preview.unwrap_or_default().head_share();
        let head_count = count_within_budget(eligible.iter().copied(), head_budget, agent).await?;
        let rest = &eligible[head_count..];
        let tail_count =
            count_within_budget(rest.iter().rev().copied(), self.preview_tokens - head_budget, agent).await?;
        Ok(rest[..rest.len() - tail_count].to_vec())
    }
}

#[allow(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
/// How many leading messages fit within `budget` tokens.
async fn count_within_budget(indices: impl Iterator<Item = usize>, budget: f64, agent: &LocalAgent) -> Result<usize> {
    let mut total = 0u64;
    let mut count = 0;
    for index in indices {
        total += agent
            .model()
            .count_tokens(
                std::slice::from_ref(&agent.messages()[index]),
                CountTokensOptions::default(),
            )
            .await?;
        if total as f64 > budget {
            break;
        }
        count += 1;
    }
    Ok(count)
}

#[async_trait]
impl OffloadBehavior for TruncateBehavior {
    async fn replace_block(
        &self,
        core: &OffloadCore,
        block: &ContentBlock,
        tokens: u64,
        message: &Message,
        _agent: &LocalAgent,
        archive_ref: Option<&str>,
        _tool_name: Option<&str>,
        _invocation_context: Option<&InvocationContext>,
    ) -> Result<Option<ContentBlock>> {
        match block {
            ContentBlock::ToolResult(result) => {
                let Some(truncated) = truncate_tool_result_block(result, &self.config) else {
                    return Ok(None);
                };
                tracing::debug!(
                    "tool_use_id=<{}>, tokens=<{tokens}> | truncated tool result",
                    result.tool_use_id
                );
                let mut content = vec![ToolResultContent::Text(core.placeholder(
                    &truncated.preview,
                    archive_ref,
                    tokens,
                ))];
                content.extend(truncated.kept);
                Ok(Some(ContentBlock::ToolResult(result.clone().with_content(content))))
            }
            ContentBlock::Text(text) => {
                let Some(preview) = truncate_text_block(text, &self.config) else {
                    return Ok(None);
                };
                tracing::debug!(
                    "tracking_id=<{}>, tokens=<{tokens}> | truncated text block",
                    message.tracking_id()
                );
                Ok(Some(ContentBlock::Text(core.placeholder(
                    &preview,
                    archive_ref,
                    tokens,
                ))))
            }
            other => {
                tracing::debug!(
                    "tracking_id=<{}>, tokens=<{tokens}> | offloaded media block",
                    message.tracking_id()
                );
                Ok(Some(ContentBlock::Text(core.placeholder(
                    &format_offloaded(tokens, media_kind(other)),
                    archive_ref,
                    tokens,
                ))))
            }
        }
    }

    /// Middle-out: keeps the oldest and newest eligible messages within the preview budget and
    /// elides the rest.
    async fn apply_per_message(&self, core: &OffloadCore, context: &mut ContextState<'_>) -> Result<bool> {
        let removable = core.removable_messages(context.agent).await?;
        let middle = with_pairs(
            context.agent.messages(),
            &self.select_middle(&removable, context.agent).await?,
        );
        // A middle of only placeholders has nothing new to elide.
        let messages = context.agent.messages();
        if middle
            .iter()
            .all(|&index| messages[index].content.iter().all(is_offloaded))
        {
            return Ok(false);
        }
        let text = FormattedPlaceholder::new(format_elided);
        let archive = core.archive();
        remove_messages(context.agent, &middle, &text, OffloadMethod::Truncate, archive.as_ref()).await
    }
}

/// Replaces oversized content with a preview (`Offload.truncate`), built with
/// [`Offload::truncate`](super::Offload::truncate). On whole messages it keeps the oldest and
/// newest within the preview budget and elides the rest.
pub struct TruncateStrategy {
    core: Arc<OffloadCore>,
    behavior: Arc<TruncateBehavior>,
}

impl TruncateStrategy {
    pub(crate) fn new(
        target: OffloadTarget,
        config: TruncateConfig,
        conditions: Option<OffloadConditions>,
    ) -> Result<Self> {
        let core = OffloadCore::new(OffloadMethod::Truncate, target, conditions)?;
        let preview_tokens = config.resolve_preview_tokens();
        // Every message over a threshold is larger than previewTokens, so middle-out would elide
        // them all, as drop does.
        if core.matcher.matches_all() && core.conditions.block_threshold.is_some() {
            return Err(Error::other(
                "Offload.truncate('*') doesn't take a blockThreshold; use Offload.drop('*') to remove large messages, or Offload.truncate('toolResults') to preview large blocks",
            ));
        }
        // A percent needs the context window, so init checks it.
        if let Some(threshold) = core.conditions.block_threshold.filter(|threshold| !threshold.is_share) {
            check_threshold_exceeds_preview(threshold.value, &js_count(threshold.value), preview_tokens)?;
        }
        Ok(Self {
            core: Arc::new(core),
            behavior: Arc::new(TruncateBehavior { config, preview_tokens }),
        })
    }

    /// A copy of this strategy, with the same target and config, under `conditions` (`when`). A
    /// strategy keeps per-agent state, so give each agent its own.
    ///
    /// # Errors
    ///
    /// An invalid condition value, conditions that leave the strategy unable to run, a
    /// `block_threshold` on whole messages, or one no larger than the preview.
    pub fn when(&self, conditions: OffloadConditions) -> Result<Self> {
        Self::new(
            self.core.target().clone(),
            self.behavior.config.clone(),
            Some(conditions),
        )
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a whole token count"
)]
fn js_count(value: f64) -> String {
    (value as u64).to_string()
}

fn js_tokens(value: f64) -> String {
    if value.fract() == 0.0 {
        return js_count(value);
    }
    value.to_string()
}

#[allow(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
fn check_threshold_exceeds_preview(tokens: f64, shown: &str, preview_tokens: f64) -> Result<()> {
    if tokens > preview_tokens {
        return Ok(());
    }
    Err(Error::other(format!(
        "blockThreshold ({shown}) must be greater than previewTokens ({}) to ensure truncation converges; raise blockThreshold or lower previewTokens",
        js_tokens(preview_tokens)
    )))
}

impl std::fmt::Debug for TruncateStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TruncateStrategy")
            .field("target", self.core.target())
            .field("conditions", &self.core.offload_conditions)
            .field("config", &self.behavior.config)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ContextStrategy for TruncateStrategy {
    fn name(&self) -> &str {
        &self.core.name
    }

    /// Checks a percent `block_threshold` against the preview, then initializes the strategy.
    #[allow(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
    fn init(&self, agent: &mut LocalAgent, archive: Option<&Archive>) -> Result<()> {
        if self
            .core
            .conditions
            .block_threshold
            .is_some_and(|threshold| threshold.is_share)
            && let Some(tokens) = self.core.conditions.threshold_tokens(agent)
        {
            check_threshold_exceeds_preview(
                tokens as f64,
                &format!("{tokens} tokens of the context window"),
                self.behavior.preview_tokens,
            )?;
        }
        self.core.init(self.behavior.clone(), agent, archive)
    }

    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
        self.core.apply(self.behavior.as_ref(), context).await
    }
}
