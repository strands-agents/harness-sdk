//! Tool filters (`McpToolFilters`, `McpToolMatcher`): which listed tools a client exposes.

use std::fmt;

use regex::Regex;

use super::mcp_tool::McpTool;

crate::callback::callback! {
    /// Decides whether a tool matches a filter (`McpToolFilterCallback`). It receives the tool under
    /// its agent-facing name.
    pub struct McpToolFilterCallback(Fn(&McpTool) -> bool);
}

/// Matches a tool for filtering (`McpToolMatcher`).
#[derive(Clone)]
#[non_exhaustive]
pub enum McpToolMatcher {
    /// Matches the server-side tool name exactly.
    Name(String),
    /// Matches the server-side tool name from its start, as Python's `Pattern.match` does.
    Regex(Regex),
    /// Asks a callback, which receives the tool.
    Callback(McpToolFilterCallback),
}

impl McpToolMatcher {
    /// A matcher that asks `callback`.
    pub fn callback(callback: impl Fn(&McpTool) -> bool + Send + Sync + 'static) -> Self {
        Self::Callback(McpToolFilterCallback::new(callback))
    }

    fn matches(&self, tool: &McpTool, server_tool_name: &str) -> bool {
        match self {
            Self::Name(name) => name == server_tool_name,
            Self::Regex(regex) => regex.find(server_tool_name).is_some_and(|found| found.start() == 0),
            Self::Callback(callback) => callback(tool),
        }
    }
}

impl From<&str> for McpToolMatcher {
    fn from(name: &str) -> Self {
        Self::Name(name.to_owned())
    }
}

impl From<String> for McpToolMatcher {
    fn from(name: String) -> Self {
        Self::Name(name)
    }
}

impl From<Regex> for McpToolMatcher {
    fn from(regex: Regex) -> Self {
        Self::Regex(regex)
    }
}

impl fmt::Debug for McpToolMatcher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Name(name) => f.debug_tuple("Name").field(name).finish(),
            Self::Regex(regex) => f.debug_tuple("Regex").field(&regex.as_str()).finish(),
            Self::Callback(_) => f.write_str("Callback"),
        }
    }
}

/// Filters controlling which MCP tools a client exposes (`McpToolFilters`).
///
/// Allowed applies first, then rejected, so a rejected tool is excluded even when also allowed.
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct McpToolFilters {
    /// When present, only tools matching at least one matcher are exposed. An empty list
    /// exposes nothing.
    pub allowed: Option<Vec<McpToolMatcher>>,
    /// Tools matching at least one matcher are excluded, even when also allowed.
    pub rejected: Option<Vec<McpToolMatcher>>,
}

impl McpToolFilters {
    /// Whether `tool`, listed by the server as `server_tool_name`, passes the filters.
    pub(crate) fn includes(&self, tool: &McpTool, server_tool_name: &str) -> bool {
        let any = |matchers: &[McpToolMatcher]| matchers.iter().any(|matcher| matcher.matches(tool, server_tool_name));
        if self.allowed.as_deref().is_some_and(|allowed| !any(allowed)) {
            return false;
        }
        !self.rejected.as_deref().is_some_and(any)
    }
}
