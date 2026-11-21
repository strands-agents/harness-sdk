//! The MCP clients an agent lists tools from.

use crate::error::Result;
use crate::tools::SourceParts;
use crate::tools::ToolRegistry;

#[cfg(feature = "mcp")]
mod enabled {
    use std::sync::{Arc, Mutex, PoisonError};

    use super::{Result, SourceParts, ToolRegistry};
    use crate::mcp::{McpClient, McpTool, ToolsChangedCallback};
    use crate::tools::Tool;

    /// A refreshed tool list and the index of the client that reported it.
    type Change = (usize, Vec<McpTool>);

    /// The agent's MCP clients and the tool-list changes they reported since the last model call.
    ///
    /// The clients' callbacks hold the change queue weakly: queued changes hold tools, and tools
    /// hold their client, so a strong reference would keep the client and its transport alive.
    #[derive(Default)]
    pub(crate) struct McpTools {
        clients: Vec<McpClient>,
        initialized: bool,
        changes: Arc<Mutex<Vec<Change>>>,
        /// Per client, the tools it has registered. A client's own list of old names includes
        /// tools the registry skipped, so a refresh removes what was registered instead.
        registered: Mutex<Vec<Vec<Arc<dyn Tool>>>>,
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
            let mut registered = Vec::with_capacity(self.clients.len());
            for (index, (client, tools)) in self.clients.iter().zip(listed).enumerate() {
                let tools = shared(tools);
                registry.add(tools.clone())?;
                registered.push(tools);
                let changes = Arc::downgrade(&self.changes);
                client.set_on_tools_changed(Some(ToolsChangedCallback::new(move |_old_names, new_tools| {
                    let Some(changes) = changes.upgrade() else {
                        return;
                    };
                    changes
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push((index, new_tools));
                })));
            }
            *self.registered.get_mut().unwrap_or_else(PoisonError::into_inner) = registered;
            self.initialized = true;
            Ok(())
        }

        /// Swaps in the tools of every list change reported since the last call. A refreshed
        /// tool that is invalid, or that takes the name of a tool from another source, is skipped
        /// with a warning; it comes back only on its client's next refresh.
        pub(crate) fn apply_changes(&self, registry: &mut ToolRegistry) {
            let changes = std::mem::take(&mut *self.changes.lock().unwrap_or_else(PoisonError::into_inner));
            let mut registered = self.registered.lock().unwrap_or_else(PoisonError::into_inner);
            for (index, new_tools) in changes {
                let (Some(client), Some(current)) = (self.clients.get(index), registered.get_mut(index)) else {
                    continue;
                };
                let refreshed = shared(new_tools);
                let skipped = registry.swap(current, refreshed.clone());
                for (tool, error) in &skipped {
                    tracing::warn!(
                        "client=<{}>, tool_name=<{}>, error=<{error}> | skipping refreshed mcp tool",
                        client.client_name(),
                        tool.name()
                    );
                }
                *current = refreshed
                    .into_iter()
                    .filter(|tool| !skipped.iter().any(|(skipped, _)| Arc::ptr_eq(skipped, tool)))
                    .collect();
            }
        }
    }

    fn shared(tools: Vec<McpTool>) -> Vec<Arc<dyn Tool>> {
        tools.into_iter().map(|tool| Arc::new(tool) as Arc<dyn Tool>).collect()
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
