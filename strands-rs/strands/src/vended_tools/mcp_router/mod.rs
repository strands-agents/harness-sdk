//! The `mcp_router` tool: connects to allowlisted MCP servers at runtime to discover and invoke
//! their tools.

mod types;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError, RwLock, Weak};

use indexmap::IndexMap;
use serde_json::json;

pub use types::{MCP_ROUTER_DESCRIPTION, McpRouterCommand, McpRouterInput, McpRouterToolError};

use crate::error::{Error, Result};
use crate::mcp::{
    McpCallToolOptions, McpClient, McpClientOptions, McpConnectionState, McpListToolsOptions, McpLoadServersOptions,
    McpServerConfig, McpServersSource, McpTool, McpToolConfig, tool_result,
};
use crate::tools::{FunctionTool, Tool, ToolContext, ToolError};
use crate::types::{JsonObject, JsonValue, ToolResultContent, ToolResultStatus};

const DEFAULT_MAX_CONNECTIONS: usize = 10;

/// Options for [`make_mcp_router`] (`MakeMcpRouterOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeMcpRouterOptions {
    /// The tool name shown to the model; `mcp_router` when absent.
    pub name: Option<String>,
    /// The tool description shown to the model; [`MCP_ROUTER_DESCRIPTION`] plus the permitted
    /// server names when absent.
    pub description: Option<String>,
    /// The allowlisted servers by name. A server's `tool_filters` decide which tools
    /// `list_tools` returns and `call_tool` accepts. Must not be empty.
    pub servers: BTreeMap<String, McpServerConfig>,
    /// The most connections one agent may hold open; 10 when absent.
    pub max_connections: Option<usize>,
}

struct Connection {
    client: McpClient,
    listed_names: Option<HashSet<String>>,
}

type AgentKey = Weak<RwLock<JsonObject>>;

struct AgentConnections {
    agent: AgentKey,
    connections: IndexMap<String, Connection>,
}

struct Router {
    servers: BTreeMap<String, McpServerConfig>,
    max_connections: usize,
    agents: Mutex<Vec<AgentConnections>>,
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

fn router_error(message: impl Into<String>) -> ToolError {
    ToolError::new(McpRouterToolError::new(message))
}

async fn stop_client(client: &McpClient) {
    if let Err(error) = client.disconnect().await {
        tracing::debug!("error=<{error}> | failed to stop MCP client");
    }
}

fn stop_in_background(connections: IndexMap<String, Connection>) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    for (connection_id, connection) in connections {
        tracing::debug!("connection_id=<{connection_id}> | closing MCP connection during garbage collection");
        runtime.spawn(async move { stop_client(&connection.client).await });
    }
}

impl Router {
    /// Runs `f` on the connections of the agent behind `key`, after closing the connections of
    /// agents that no longer exist.
    fn with_agent<T>(&self, key: &AgentKey, f: impl FnOnce(&mut IndexMap<String, Connection>) -> T) -> T {
        let mut agents = self.agents.lock().unwrap_or_else(PoisonError::into_inner);
        let (live, dead): (Vec<_>, Vec<_>) = agents.drain(..).partition(|entry| entry.agent.strong_count() > 0);
        *agents = live;
        for entry in dead {
            stop_in_background(entry.connections);
        }
        let index = match agents.iter().position(|entry| Weak::ptr_eq(&entry.agent, key)) {
            Some(index) => index,
            None => {
                agents.push(AgentConnections {
                    agent: key.clone(),
                    connections: IndexMap::new(),
                });
                agents.len() - 1
            }
        };
        f(&mut agents[index].connections)
    }

    fn client(&self, key: &AgentKey, connection_id: &str) -> std::result::Result<McpClient, McpRouterToolError> {
        self.with_agent(key, |connections| {
            connections
                .get(connection_id)
                .map(|connection| connection.client.clone())
        })
        .ok_or_else(|| McpRouterToolError::new(format!("No active connection for id {}", quoted(connection_id))))
    }

    fn list_connections(&self, key: &AgentKey) -> JsonValue {
        let mut ids: Vec<String> = self.with_agent(key, |connections| connections.keys().cloned().collect());
        ids.sort();
        JsonValue::String(ids.join(", "))
    }

    async fn run(&self, input: McpRouterInput, context: &ToolContext) -> std::result::Result<JsonValue, ToolError> {
        let key = context.agent().app_state().downgrade();
        let connection_id = || {
            input.connection_id.as_deref().ok_or_else(|| {
                McpRouterToolError::new("`connection_id` is required for all commands except 'list_connections'")
            })
        };
        match input.command {
            McpRouterCommand::ListConnections => Ok(self.list_connections(&key)),
            McpRouterCommand::Connect => {
                let connection_id = connection_id()?;
                let Some(server_name) = input.server_name.as_deref() else {
                    return Err(router_error("`server_name` is required for command='connect'"));
                };
                self.connect(&key, server_name, connection_id).await
            }
            McpRouterCommand::ListTools => {
                let connection_id = connection_id()?;
                let client = self.client(&key, connection_id)?;
                let specs = self.list_and_cache(&key, connection_id, &client).await?;
                Ok(serde_json::to_value(specs)?)
            }
            McpRouterCommand::CallTool => {
                let connection_id = connection_id()?;
                let client = self.client(&key, connection_id)?;
                let Some(tool_name) = input.tool_name.as_deref() else {
                    return Err(router_error("`tool_name` is required for command='call_tool'"));
                };
                self.ensure_tool_listed(&key, connection_id, &client, tool_name).await?;
                call_tool(&client, tool_name, input.arguments.clone().unwrap_or_default(), context).await
            }
            McpRouterCommand::Disconnect => Ok(self.disconnect(&key, connection_id()?).await),
        }
    }

    async fn connect(
        &self,
        key: &AgentKey,
        server_name: &str,
        connection_id: &str,
    ) -> std::result::Result<JsonValue, ToolError> {
        let Some(config) = self.servers.get(server_name) else {
            let permitted: Vec<&str> = self.servers.keys().map(String::as_str).collect();
            return Err(router_error(format!(
                "Server {} is not on the MCP server allowlist: {}",
                quoted(server_name),
                permitted.join(", ")
            )));
        };
        let source = McpServersSource::Servers(vec![(server_name.to_owned(), config.clone())]);
        let loaded =
            McpClient::load_servers(source, McpClientOptions::default(), McpLoadServersOptions::default()).await?;
        let Some(client) = loaded.into_iter().next() else {
            return Err(router_error(format!(
                "Server {} failed to initialise; check the server config",
                quoted(server_name)
            )));
        };
        if let Err(error) = client.connect(false).await {
            stop_client(&client).await;
            return Err(error.into());
        }
        if client.connection_state() == McpConnectionState::Failed {
            stop_client(&client).await;
            return Err(router_error(format!(
                "Server {} failed to connect; check the server config",
                quoted(server_name)
            )));
        }
        let rejected = self.with_agent(key, |connections| {
            if connections.len() >= self.max_connections {
                let mut active: Vec<&str> = connections.keys().map(String::as_str).collect();
                active.sort_unstable();
                return Some(format!(
                    "Connection limit of {} reached. Disconnect one of the active connections before opening a new one. Active connection_ids: {}",
                    self.max_connections,
                    active.join(", ")
                ));
            }
            if connections.contains_key(connection_id) {
                return Some(format!(
                    "Connection {} already exists. Disconnect it first or use a different connection_id.",
                    quoted(connection_id)
                ));
            }
            connections.insert(
                connection_id.to_owned(),
                Connection {
                    client: client.clone(),
                    listed_names: None,
                },
            );
            None
        });
        if let Some(message) = rejected {
            stop_client(&client).await;
            return Err(router_error(message));
        }
        tracing::debug!("connection_id=<{connection_id}>, server_name=<{server_name}> | opened MCP connection");
        Ok(JsonValue::String(format!(
            "Successfully connected to {server_name} as {}",
            quoted(connection_id)
        )))
    }

    async fn list_and_cache(
        &self,
        key: &AgentKey,
        connection_id: &str,
        client: &McpClient,
    ) -> Result<Vec<crate::types::ToolSpec>> {
        let options = McpListToolsOptions {
            prefix: Some(String::new()),
            tool_filters: None,
        };
        let tools = client.list_tools_with(options).await?;
        let specs: Vec<crate::types::ToolSpec> = tools.iter().map(Tool::tool_spec).collect();
        let names: HashSet<String> = specs.iter().map(|spec| spec.name.clone()).collect();
        self.with_agent(key, |connections| {
            if let Some(connection) = connections.get_mut(connection_id) {
                connection.listed_names = Some(names);
            }
        });
        Ok(specs)
    }

    fn is_listed(&self, key: &AgentKey, connection_id: &str, tool_name: &str) -> bool {
        self.with_agent(key, |connections| {
            connections
                .get(connection_id)
                .and_then(|connection| connection.listed_names.as_ref())
                .is_some_and(|names| names.contains(tool_name))
        })
    }

    /// Checks a call against the filtered listing, since filters apply only when listing.
    async fn ensure_tool_listed(
        &self,
        key: &AgentKey,
        connection_id: &str,
        client: &McpClient,
        tool_name: &str,
    ) -> std::result::Result<(), ToolError> {
        if self.is_listed(key, connection_id, tool_name) {
            return Ok(());
        }
        self.list_and_cache(key, connection_id, client).await?;
        if self.is_listed(key, connection_id, tool_name) {
            return Ok(());
        }
        Err(router_error(format!(
            "Tool {} is not available on connection {}. Call list_tools to see the tools you can call.",
            quoted(tool_name),
            quoted(connection_id)
        )))
    }

    async fn disconnect(&self, key: &AgentKey, connection_id: &str) -> JsonValue {
        let removed = self.with_agent(key, |connections| connections.shift_remove(connection_id));
        if let Some(connection) = removed {
            stop_client(&connection.client).await;
        }
        JsonValue::String("Successfully disconnected".to_owned())
    }
}

fn content_text(content: &ToolResultContent) -> String {
    match content {
        ToolResultContent::Text(block) => block.text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

async fn call_tool(
    client: &McpClient,
    tool_name: &str,
    arguments: JsonObject,
    context: &ToolContext,
) -> std::result::Result<JsonValue, ToolError> {
    let tool = McpTool::new(McpToolConfig {
        name: tool_name.to_owned(),
        description: String::new(),
        input_schema: json!({"type": "object"}),
        output_schema: None,
        annotations: None,
        client: client.clone(),
    });
    let options = McpCallToolOptions {
        cancel_signal: Some(context.cancel_signal().clone()),
        ..McpCallToolOptions::default()
    };
    let raw = client.call_tool(&tool, JsonValue::Object(arguments), options).await;
    let result = tool_result(context.tool_use().tool_use_id.clone(), raw);
    if result.status == ToolResultStatus::Error {
        let text = result.content.iter().map(content_text).collect::<Vec<_>>().join("\n");
        let message = if text.is_empty() {
            "MCP tool returned an error".to_owned()
        } else {
            text
        };
        return Err(router_error(message));
    }
    Ok(serde_json::to_value(&result.content)?)
}

/// Creates an `mcp_router` tool bound to an allowlist of servers.
///
/// Connections are per agent and persist across invocations. They close when the model calls
/// `disconnect`, when the tool is dropped, and soon after their agent is dropped.
///
/// ```
/// use std::collections::BTreeMap;
///
/// use strands::mcp::McpServerConfig;
/// use strands::vended_tools::mcp_router::{MakeMcpRouterOptions, make_mcp_router};
///
/// let router = make_mcp_router(MakeMcpRouterOptions {
///     servers: BTreeMap::from([(
///         "my-api".to_owned(),
///         McpServerConfig::builder().url("https://mcp.example.com/mcp").build(),
///     )]),
///     ..MakeMcpRouterOptions::default()
/// })?;
/// let agent = strands::Agent::builder().tools([router]).printer(false).build()?;
/// assert!(agent.tool_registry().get("mcp_router").is_some());
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// `servers` is empty, or `max_connections` is 0. The tool returns an error result with an
/// [`McpRouterToolError`] message when, among others, `call_tool` names a tool that the
/// connection's `list_tools` does not return.
pub fn make_mcp_router(options: MakeMcpRouterOptions) -> Result<FunctionTool> {
    if options.servers.is_empty() {
        return Err(Error::other(
            "`servers` must not be empty; the mcp_router tool requires at least one server",
        ));
    }
    let max_connections = options.max_connections.unwrap_or(DEFAULT_MAX_CONNECTIONS);
    if max_connections < 1 {
        return Err(Error::other("`maxConnections` must be at least 1"));
    }
    let description = options.description.unwrap_or_else(|| {
        let names: Vec<String> = options.servers.keys().map(|name| format!("'{name}'")).collect();
        format!("{MCP_ROUTER_DESCRIPTION} Permitted server names: {}.", names.join(", "))
    });
    let router = Arc::new(Router {
        servers: options.servers,
        max_connections,
        agents: Mutex::new(Vec::new()),
    });
    let name = options.name.unwrap_or_else(|| "mcp_router".to_owned());
    Ok(FunctionTool::builder(name, description)
        .input_schema_for::<McpRouterInput>()
        .callback(move |input, context| {
            let router = router.clone();
            async move {
                let input: McpRouterInput = serde_json::from_value(input)?;
                router.run(input, &context).await
            }
        }))
}

#[cfg(test)]
mod tests;
