//! [`ToolSource`], anything that provides tools to an agent, and [`tool_list!`](crate::tool_list).

use std::fmt;
use std::sync::Arc;

use super::tool::Tool;

/// Something that provides tools to an agent.
///
/// Convert a tool, a shared `Arc<dyn Tool>` or a list with `.into()`. A list of different tool
/// types needs [`tool_list!`](crate::tool_list) or `ToolSource::from` on each item, because `.into()` has no single
/// target type there.
#[derive(Clone)]
#[non_exhaustive]
pub enum ToolSource {
    /// One tool.
    Tool(Arc<dyn Tool>),
    /// A nested list.
    List(Vec<ToolSource>),
    /// An MCP client; the agent lists its tools when it initializes.
    #[cfg(feature = "mcp")]
    McpClient(crate::mcp::McpClient),
}

impl ToolSource {
    /// The tools, with nested lists flattened in order. MCP clients are left out: their tools
    /// come from the server when an agent initializes.
    #[must_use]
    pub fn into_tools(self) -> Vec<Arc<dyn Tool>> {
        self.into_parts().tools
    }

    /// The tools, for a registry, which cannot hold an MCP client.
    pub(crate) fn into_registry_tools(self) -> crate::error::Result<Vec<Arc<dyn Tool>>> {
        let parts = self.into_parts();
        #[cfg(feature = "mcp")]
        if !parts.mcp_clients.is_empty() {
            return Err(crate::error::ToolValidationError::new(
                "An MCP client is not a tool; pass it to the agent's tools, or register the tools from its list_tools()",
            )
            .into());
        }
        Ok(parts.tools)
    }

    /// The tools and the MCP clients, each in order.
    pub(crate) fn into_parts(self) -> SourceParts {
        let mut parts = SourceParts::default();
        self.flatten_into(&mut parts);
        parts
    }

    fn flatten_into(self, parts: &mut SourceParts) {
        match self {
            Self::Tool(tool) => parts.tools.push(tool),
            Self::List(sources) => {
                for source in sources {
                    source.flatten_into(parts);
                }
            }
            #[cfg(feature = "mcp")]
            Self::McpClient(client) => parts.mcp_clients.push(client),
        }
    }
}

/// A flattened [`ToolSource`].
#[derive(Default)]
pub(crate) struct SourceParts {
    pub(crate) tools: Vec<Arc<dyn Tool>>,
    #[cfg(feature = "mcp")]
    pub(crate) mcp_clients: Vec<crate::mcp::McpClient>,
}

#[cfg(feature = "mcp")]
impl From<crate::mcp::McpClient> for ToolSource {
    fn from(client: crate::mcp::McpClient) -> Self {
        Self::McpClient(client)
    }
}

impl<T: Tool> From<T> for ToolSource {
    fn from(tool: T) -> Self {
        Self::Tool(Arc::new(tool))
    }
}

impl From<Arc<dyn Tool>> for ToolSource {
    fn from(tool: Arc<dyn Tool>) -> Self {
        Self::Tool(tool)
    }
}

impl<T: Into<ToolSource>> From<Vec<T>> for ToolSource {
    fn from(sources: Vec<T>) -> Self {
        Self::List(sources.into_iter().map(Into::into).collect())
    }
}

impl fmt::Debug for ToolSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Tool(tool) => f.debug_tuple("Tool").field(&tool.name()).finish(),
            Self::List(sources) => f.debug_tuple("List").field(sources).finish(),
            #[cfg(feature = "mcp")]
            Self::McpClient(client) => f.debug_tuple("McpClient").field(&client.client_name()).finish(),
        }
    }
}

/// Builds a `Vec<ToolSource>` from items of different types.
///
/// ```
/// use strands::tools::{FunctionTool, ToolRegistry};
/// use strands::{ToolSource, tool_list};
///
/// let ping = FunctionTool::builder("ping", "Replies pong").callback(|_, _| async { Ok("pong".into()) });
/// let echo = FunctionTool::builder("echo", "Echoes").callback(|input, _| async move { Ok(input) });
/// let tools: Vec<ToolSource> = tool_list![ping, vec![echo]];
///
/// let mut registry = ToolRegistry::new();
/// registry.add(tools).unwrap();
/// assert_eq!(registry.list().len(), 2);
/// ```
#[macro_export]
macro_rules! tool_list {
    ($($source:expr),* $(,)?) => {
        ::std::vec![$($crate::ToolSource::from($source)),*]
    };
}
