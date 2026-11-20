//! The drop strategy: removes matching content from the context window entirely.

use std::sync::Arc;

use async_trait::async_trait;

use super::base::{BlockReplacer, OffloadConditions, OffloadCore, OffloadTarget};
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::Result;
use crate::experimental::context_manager::stash::{Stash, format_stash_refs};
use crate::experimental::context_manager::types::{ContextState, ContextStrategy};
use crate::types::{ContentBlock, Message, ToolResultBlock, ToolResultContent};

/// The text a dropped block leaves behind (`DROPPED_MARKER`).
pub(crate) const DROPPED_MARKER: &str = "[Dropped]";

struct DropReplacer;

#[async_trait]
impl BlockReplacer for DropReplacer {
    async fn replace_block(
        &self,
        block: &ContentBlock,
        _tokens: u64,
        message: &Message,
        _agent: &LocalAgent,
        stash_refs: &[String],
        _invocation_context: Option<&InvocationContext>,
    ) -> Result<Option<ContentBlock>> {
        let marker = format!("{DROPPED_MARKER}{}", format_stash_refs(stash_refs));
        if let ContentBlock::ToolResult(result) = block {
            tracing::debug!(
                "tool_use_id=<{}> | dropped tool result from context window",
                result.tool_use_id
            );
            return Ok(Some(ContentBlock::ToolResult(ToolResultBlock::new(
                result.tool_use_id.clone(),
                result.status,
                vec![ToolResultContent::text(marker)],
            ))));
        }
        tracing::debug!(
            "tracking_id=<{}> | dropped block from context window",
            message.tracking_id()
        );
        Ok(Some(ContentBlock::text(marker)))
    }

    fn removal_marker(&self, count: usize) -> Option<String> {
        let noun = if count == 1 { "message" } else { "messages" };
        Some(format!("[Dropped: {count} {noun}]"))
    }
}

/// Drops matching content from the context window (`Offload.drop`), built with
/// [`Offload::drop`](super::Offload::drop).
pub struct DropStrategy {
    core: Arc<OffloadCore>,
    replacer: Arc<DropReplacer>,
}

impl DropStrategy {
    pub(crate) fn new(target: OffloadTarget, conditions: OffloadConditions) -> Result<Self> {
        Ok(Self {
            core: Arc::new(OffloadCore::new(target, conditions)?),
            replacer: Arc::new(DropReplacer),
        })
    }

    /// The same strategy with `conditions` deciding when it fires (`when`).
    #[must_use]
    pub fn when(self, conditions: OffloadConditions) -> Self {
        let target = self.core.target.clone();
        Self::new(target, conditions).unwrap_or(self)
    }
}

impl std::fmt::Debug for DropStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DropStrategy")
            .field("target", &self.core.target)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ContextStrategy for DropStrategy {
    fn name(&self) -> &str {
        "offload:drop"
    }

    fn init(&self, agent: &mut LocalAgent, stash: Option<&Stash>) {
        self.core.init(self.replacer.clone(), agent, stash);
    }

    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
        self.core.apply(self.replacer.as_ref(), context).await
    }
}
