//! The MCP clients an agent lists tools from.

use crate::error::Result;
use crate::tools::SourceParts;
use crate::tools::ToolRegistry;

#[cfg(feature = "mcp")]
mod enabled {
    use std::sync::{Arc, Mutex, PoisonError};

    use super::{Result, SourceParts, ToolRegistry};
    use crate::mcp::{McpClient, McpTool, ToolsChangedCallback};

    type Change = (Vec<String>, Vec<McpTool>);

    /// The agent's MCP clients and the tool-list changes they reported since the last model call.
    ///
    /// The clients' callbacks hold the change queue weakly: queued changes hold tools, and tools
    /// hold their client, so a strong reference would keep the client and its transport alive.
    #[derive(Default)]
    pub(crate) struct McpTools {
        clients: Vec<McpClient>,
        initialized: bool,
        changes: Arc<Mutex<Vec<Change>>>,
    }

    impl McpTools {
        pub(crate) fn take(parts: &mut SourceParts) -> Self {
            Self {
                clients: std::mem::take(&mut parts.mcp_clients),
                ..Self::default()
            }
        }

        /// Lists every client's tools into the registry and follows their list changes
        /// (`initialize`).
        pub(crate) async fn initialize(&mut self, registry: &mut ToolRegistry) -> Result<()> {
            if self.initialized {
                return Ok(());
            }
            let listed = futures::future::try_join_all(self.clients.iter().map(McpClient::list_tools)).await?;
            for (client, tools) in self.clients.iter().zip(listed) {
                registry.add(tools)?;
                let changes = Arc::downgrade(&self.changes);
                client.set_on_tools_changed(Some(ToolsChangedCallback::new(move |old_names, new_tools| {
                    let Some(changes) = changes.upgrade() else {
                        return;
                    };
                    changes
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push((old_names, new_tools));
                })));
            }
            self.initialized = true;
            Ok(())
        }

        /// Swaps in the tools of every list change reported since the last call.
        pub(crate) fn apply_changes(&self, registry: &mut ToolRegistry) {
            let changes = std::mem::take(&mut *self.changes.lock().unwrap_or_else(PoisonError::into_inner));
            for (old_names, new_tools) in changes {
                for name in &old_names {
                    registry.remove(name);
                }
                if let Err(error) = registry.add_or_replace(new_tools) {
                    tracing::warn!("error=<{error}> | failed to register refreshed mcp tools");
                }
            }
        }
    }
}

#[cfg(feature = "mcp")]
pub(crate) use enabled::McpTools;

/// Without the `mcp` feature an agent has no MCP clients.
#[cfg(not(feature = "mcp"))]
#[derive(Default)]
pub(crate) struct McpTools {}

#[cfg(not(feature = "mcp"))]
impl McpTools {
    pub(crate) fn take(_parts: &mut SourceParts) -> Self {
        Self {}
    }

    #[allow(clippy::unused_async, reason = "shares the signature of the mcp variant")]
    pub(crate) async fn initialize(&mut self, _registry: &mut ToolRegistry) -> Result<()> {
        Ok(())
    }

    pub(crate) fn apply_changes(&self, _registry: &mut ToolRegistry) {}
}
