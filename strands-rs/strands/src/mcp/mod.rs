//! Model Context Protocol clients (feature `mcp`), built on [`rmcp`].
//!
//! An [`McpClient`] reaches one server over stdio ([`McpTransport::stdio`]), streamable HTTP
//! ([`McpClientConfig::url`]) or the legacy HTTP+SSE protocol ([`McpTransport::sse`]). Pass it
//! to an agent with `.tools([client])`: the agent lists the server's tools as [`McpTool`]s when
//! it initializes and follows the server's list-changed notifications.
//! [`McpClient::load_servers`] builds clients from an `mcp.json`-style config.
//!
//! The raw MCP results ([`McpClient::list_prompts`], [`McpClient::read_resource`], ...) are the
//! `rmcp` model types; use them through the re-export [`strands::mcp::rmcp`](rmcp) so the
//! versions match. They are part of this crate's public API: an `rmcp` major version bump is a
//! breaking release of `strands`.

mod callbacks;
mod client;
mod config;
mod error;
mod filters;
mod handler;
mod http;
mod mcp_tool;
mod progress;
mod sse;
mod trace;
mod transport;

pub use callbacks::{
    ElicitationCallback, ElicitationContext, McpLogHandler, McpLogLevel, McpLogMessage, McpProgress,
    McpProgressCallback, ToolsChangedCallback,
};
pub use client::{
    DEFAULT_CLIENT_NAME, McpCallToolOptions, McpClient, McpClientConfig, McpClientOptions, McpConnectionState,
    McpListOptions, McpListToolsOptions,
};
pub use config::{
    McpLoadServersOptions, McpServerConfig, McpServerTransport, McpServersSource, SerializableMcpToolFilters,
};
pub use error::{McpError, McpSdkErrorCode, URL_ELICITATION_REQUIRED};
pub use filters::{McpToolFilterCallback, McpToolFilters, McpToolMatcher};
pub use http::{McpAuthProvider, McpClientCredentials};
pub(crate) use mcp_tool::tool_result;
pub use mcp_tool::{McpTool, McpToolConfig};
/// The `rmcp` crate, whose model types the raw MCP results use. An `rmcp` major version bump is
/// a breaking release of `strands`.
pub use rmcp;
pub use transport::{McpTransport, StdioServerParameters, default_environment};

#[cfg(test)]
pub(crate) mod tests;
