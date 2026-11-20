//! The `mcp_router` input, description and error (`vended-tools/mcp-router/types.ts`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::types::JsonObject;

/// The description of the `mcp_router` tool shown to the model (`MCP_ROUTER_DESCRIPTION`).
pub const MCP_ROUTER_DESCRIPTION: &str = concat!(
    "Connects to Model Context Protocol (MCP) servers at runtime to discover and invoke their tools. ",
    "'connect' opens a connection to a permitted server. ",
    "'list_connections' returns all currently open connection IDs. ",
    "'list_tools' returns the tools the connected server exposes, including their names and input schemas. ",
    "'call_tool' invokes a named tool on a connected server and returns its result. ",
    "'disconnect' closes a connection. ",
    "Multiple servers can be connected simultaneously. ",
    "Use connection_id to identify which connection to use for list_tools, call_tool, and disconnect."
);

/// An `mcp_router` operation failed (`McpRouterToolError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
#[non_exhaustive]
pub struct McpRouterToolError {
    message: String,
}

impl McpRouterToolError {
    /// The error class name.
    pub const NAME: &'static str = "McpRouterToolError";

    /// An error with `message`.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// What failed.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

/// An `mcp_router` operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum McpRouterCommand {
    /// Opens a connection to a permitted server.
    Connect,
    /// Returns the open connection ids.
    ListConnections,
    /// Returns the connected server's tools.
    ListTools,
    /// Invokes a tool on a connected server.
    CallTool,
    /// Closes a connection.
    Disconnect,
}

/// The input of the `mcp_router` tool (`McpRouterInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[non_exhaustive]
pub struct McpRouterInput {
    /// The operation to perform: 'connect', 'list_connections', 'list_tools', 'call_tool', 'disconnect'.
    pub command: McpRouterCommand,
    /// A descriptive name for this connection. Required for all commands except list_connections. Must be unique per agent. Reusing an active id is rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// Server name to connect to. Required for 'connect'.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    /// Tool name to invoke. Required for 'call_tool'.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Arguments to pass to the invoked tool. Used with 'call_tool'.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<JsonObject>,
}

impl McpRouterInput {
    /// An input for `command` with no other fields.
    ///
    /// ```
    /// use strands::vended_tools::mcp_router::{McpRouterCommand, McpRouterInput};
    ///
    /// let input = McpRouterInput::new(McpRouterCommand::CallTool)
    ///     .with_connection_id("docs")
    ///     .with_tool_name("search");
    /// assert_eq!(input.tool_name.as_deref(), Some("search"));
    /// ```
    #[must_use]
    pub fn new(command: McpRouterCommand) -> Self {
        Self {
            command,
            connection_id: None,
            server_name: None,
            tool_name: None,
            arguments: None,
        }
    }

    /// Sets the connection id.
    #[must_use]
    pub fn with_connection_id(mut self, connection_id: impl Into<String>) -> Self {
        self.connection_id = Some(connection_id.into());
        self
    }

    /// Sets the server to connect to.
    #[must_use]
    pub fn with_server_name(mut self, server_name: impl Into<String>) -> Self {
        self.server_name = Some(server_name.into());
        self
    }

    /// Sets the tool to invoke.
    #[must_use]
    pub fn with_tool_name(mut self, tool_name: impl Into<String>) -> Self {
        self.tool_name = Some(tool_name.into());
        self
    }

    /// Sets the arguments for the invoked tool.
    #[must_use]
    pub fn with_arguments(mut self, arguments: JsonObject) -> Self {
        self.arguments = Some(arguments);
        self
    }
}
