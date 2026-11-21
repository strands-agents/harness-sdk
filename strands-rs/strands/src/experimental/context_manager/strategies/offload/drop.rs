//! The drop strategy: removes matching content from the context window entirely.

use std::sync::Arc;

use async_trait::async_trait;

use super::base::{OffloadBehavior, OffloadCore};
use super::conditions::OffloadConditions;
use super::target::{OffloadTarget, block_type, media_kind};
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::Result;
use crate::experimental::context_manager::message_trimming::{FormattedPlaceholder, remove_messages};
use crate::experimental::context_manager::placeholder::{format_dropped, format_dropped_messages};
use crate::experimental::context_manager::stash::Stash;
use crate::experimental::context_manager::types::{ContextState, ContextStrategy};
use crate::types::{ContentBlock, Message, OffloadMethod, ToolResultContent};

struct DropBehavior;

#[async_trait]
impl OffloadBehavior for DropBehavior {
    async fn replace_block(
        &self,
        core: &OffloadCore,
        block: &ContentBlock,
        tokens: u64,
        message: &Message,
        _agent: &LocalAgent,
        stash_ref: Option<&str>,
        _tool_name: Option<&str>,
        _invocation_context: Option<&InvocationContext>,
    ) -> Result<Option<ContentBlock>> {
        tracing::debug!(
            "tracking_id=<{}>, block=<{}> | dropped block from context window",
            message.tracking_id(),
            block_type(block)
        );
        let placeholder = core.placeholder(&format_dropped(tokens, media_kind(block)), stash_ref, tokens);
        if let ContentBlock::ToolResult(result) = block {
            return Ok(Some(ContentBlock::ToolResult(
                result.clone().with_content(vec![ToolResultContent::Text(placeholder)]),
            )));
        }
        Ok(Some(ContentBlock::Text(placeholder)))
    }

    async fn apply_per_message(&self, core: &OffloadCore, context: &mut ContextState<'_>) -> Result<bool> {
        let removable = core.removable_messages(context.agent).await?;
        let text = FormattedPlaceholder::new(format_dropped_messages);
        let stash = core.stash();
        remove_messages(context.agent, &removable, &text, OffloadMethod::Drop, stash.as_ref()).await
    }
}

/// Drops matching content from the context window (`Offload.drop`), built with
/// [`Offload::drop`](super::Offload::drop).
pub struct DropStrategy {
    core: Arc<OffloadCore>,
    behavior: Arc<DropBehavior>,
}

impl DropStrategy {
    pub(crate) fn new(target: OffloadTarget, conditions: Option<OffloadConditions>) -> Result<Self> {
        Ok(Self {
            core: Arc::new(OffloadCore::new(OffloadMethod::Drop, target, conditions)?),
            behavior: Arc::new(DropBehavior),
        })
    }

    /// A copy of this strategy, with the same target, under `conditions` (`when`). A strategy keeps
    /// per-agent state, so give each agent its own.
    ///
    /// # Errors
    ///
    /// An invalid condition value, or conditions that leave the strategy unable to run.
    pub fn when(&self, conditions: OffloadConditions) -> Result<Self> {
        Self::new(self.core.target().clone(), Some(conditions))
    }
}

impl std::fmt::Debug for DropStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DropStrategy")
            .field("target", self.core.target())
            .field("conditions", &self.core.offload_conditions)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ContextStrategy for DropStrategy {
    fn name(&self) -> &str {
        &self.core.name
    }

    fn init(&self, agent: &mut LocalAgent, stash: Option<&Stash>) -> Result<()> {
        self.core.init(self.behavior.clone(), agent, stash)
    }

    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
        self.core.apply(self.behavior.as_ref(), context).await
    }
}
