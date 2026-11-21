//! The built-in model plugin.

use std::sync::Arc;

use async_trait::async_trait;

use super::plugin::Plugin;
use crate::agent::LocalAgent;
use crate::error::Result;
use crate::hooks::AfterInvocationEvent;
use crate::models::Model;

/// Clears the history after each invocation when the model keeps the conversation server-side
/// (`ModelPlugin`).
pub(crate) struct ModelPlugin {
    model: Arc<dyn Model>,
}

impl ModelPlugin {
    pub(crate) fn new(model: Arc<dyn Model>) -> Self {
        Self { model }
    }
}

#[async_trait]
impl Plugin for ModelPlugin {
    fn name(&self) -> &str {
        "strands:model"
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let model = self.model.clone();
        agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
            if model.stateful() {
                event.agent_mut().messages_mut().clear();
                tracing::debug!("cleared messages for server-managed conversation");
            }
        });
        Ok(())
    }
}
