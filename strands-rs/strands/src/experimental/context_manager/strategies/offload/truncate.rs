//! The truncate strategy: replaces oversized content with a preview.

use std::sync::Arc;

use async_trait::async_trait;

use super::base::{BlockReplacer, OffloadConditions, OffloadCore, OffloadTarget, elided_marker};
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::{Error, Result};
use crate::experimental::context_manager::methods::truncate::{
    TruncateConfig, truncate_text_block, truncate_tool_result_block,
};
use crate::experimental::context_manager::stash::{Stash, format_stash_refs};
use crate::experimental::context_manager::types::{ContextState, ContextStrategy};
use crate::types::{ContentBlock, Message, ToolResultBlock, ToolResultContent};

struct TruncateReplacer {
    config: TruncateConfig,
}

/// Appends the stash refs to the first text item of a truncated tool result.
fn append_stash_refs(mut block: ToolResultBlock, stash_refs: &[String]) -> ToolResultBlock {
    let refs = format_stash_refs(stash_refs);
    if refs.is_empty() {
        return block;
    }
    if let Some(ToolResultContent::Text(text)) = block
        .content
        .iter_mut()
        .find(|item| matches!(item, ToolResultContent::Text(_)))
    {
        text.text = format!("{}\n\n[Stashed]{refs}", text.text);
    }
    ToolResultBlock::new(block.tool_use_id, block.status, std::mem::take(&mut block.content))
}

#[async_trait]
impl BlockReplacer for TruncateReplacer {
    async fn replace_block(
        &self,
        block: &ContentBlock,
        tokens: u64,
        message: &Message,
        _agent: &LocalAgent,
        stash_refs: &[String],
        _invocation_context: Option<&InvocationContext>,
    ) -> Result<Option<ContentBlock>> {
        match block {
            ContentBlock::ToolResult(result) => {
                tracing::debug!(
                    "tool_use_id=<{}>, tokens=<{tokens}> | truncated tool result",
                    result.tool_use_id
                );
                Ok(truncate_tool_result_block(result, &self.config)
                    .map(|truncated| ContentBlock::ToolResult(append_stash_refs(truncated, stash_refs))))
            }
            ContentBlock::Text(text) => {
                tracing::debug!(
                    "tracking_id=<{}>, tokens=<{tokens}> | truncated text block",
                    message.tracking_id()
                );
                let truncated = truncate_text_block(text, &self.config);
                let refs = format_stash_refs(stash_refs);
                if refs.is_empty() {
                    return Ok(truncated);
                }
                let base = truncated
                    .as_ref()
                    .and_then(ContentBlock::as_text)
                    .unwrap_or(&text.text)
                    .to_owned();
                Ok(Some(ContentBlock::text(format!("{base}\n\n[Stashed]{refs}"))))
            }
            _ => {
                tracing::debug!(
                    "tracking_id=<{}>, tokens=<{tokens}> | offloaded media block",
                    message.tracking_id()
                );
                Ok(Some(ContentBlock::text(format!(
                    "[Offloaded: ~{tokens} tokens]{}",
                    format_stash_refs(stash_refs)
                ))))
            }
        }
    }

    fn removal_marker(&self, count: usize) -> Option<String> {
        Some(elided_marker(count))
    }
}

/// Replaces oversized content with a preview (`Offload.truncate`), built with
/// [`Offload::truncate`](super::Offload::truncate).
pub struct TruncateStrategy {
    core: Arc<OffloadCore>,
    replacer: Arc<TruncateReplacer>,
}

impl TruncateStrategy {
    pub(crate) fn new(target: OffloadTarget, config: TruncateConfig, conditions: OffloadConditions) -> Result<Self> {
        let preview_tokens = config.effective_preview_tokens();
        if let Some(threshold) = conditions.threshold.filter(|threshold| threshold.is_finite())
            && threshold <= preview_tokens
        {
            return Err(Error::other(format!(
                "threshold ({threshold}) must be greater than previewTokens ({preview_tokens}) to ensure truncation converges"
            )));
        }
        Ok(Self {
            core: Arc::new(OffloadCore::new(target, conditions)?),
            replacer: Arc::new(TruncateReplacer { config }),
        })
    }

    /// The same strategy with `conditions` deciding when it fires (`when`).
    ///
    /// # Errors
    ///
    /// A `threshold` that is not greater than the preview size, so truncation could not converge.
    pub fn when(self, conditions: OffloadConditions) -> Result<Self> {
        Self::new(self.core.target.clone(), self.replacer.config.clone(), conditions)
    }
}

impl std::fmt::Debug for TruncateStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TruncateStrategy")
            .field("target", &self.core.target)
            .field("config", &self.replacer.config)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ContextStrategy for TruncateStrategy {
    fn name(&self) -> &str {
        "offload:truncate"
    }

    fn init(&self, agent: &mut LocalAgent, stash: Option<&Stash>) {
        self.core.init(self.replacer.clone(), agent, stash);
    }

    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
        self.core.apply(self.replacer.as_ref(), context).await
    }
}
