//! The no-op conversation manager.

use async_trait::async_trait;

use super::{ConversationManager, ConversationManagerReduceOptions};
use crate::error::Result;

/// Leaves the history alone (`NullConversationManager`): `reduce` always returns `false`, so a
/// context-window overflow leaves the agent loop. Stateful models use it, since the provider
/// keeps the history.
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct NullConversationManager;

impl NullConversationManager {
    /// Creates the manager.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ConversationManager for NullConversationManager {
    fn name(&self) -> &str {
        "strands:null-conversation-manager"
    }

    async fn reduce(&self, _options: ConversationManagerReduceOptions<'_>) -> Result<bool> {
        Ok(false)
    }
}
