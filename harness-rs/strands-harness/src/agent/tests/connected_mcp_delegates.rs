//! `subagent` children built with the parent's MCP servers, which need a connected server. The server is an in-process rmcp server over a duplex stream, connected through the
//! SDK's `McpClient` and passed in `tools` under the client name `srv`.

use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as McpContent, ErrorData, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool as McpServerTool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use strands::error::BoxError;
use strands::mcp::{McpClient, McpClientConfig, McpClientOptions, McpTransport};
use tokio::io::DuplexStream;

use super::*;

#[derive(Clone)]
struct EchoServer;

impl ServerHandler for EchoServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut schema = rmcp::model::JsonObject::new();
        schema.insert("type".to_owned(), json!("object"));
        schema.insert("properties".to_owned(), json!({ "text": { "type": "string" } }));
        Ok(ListToolsResult::with_all_items(vec![McpServerTool::new(
            "echo",
            "Echoes the text back",
            Arc::new(schema),
        )]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let text = request
            .arguments
            .unwrap_or_default()
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Ok(CallToolResult::success(vec![McpContent::text(text)]).into())
    }
}

fn srv_client() -> McpClient {
    let transport = McpTransport::from_fn(|| async {
        let (client, server) = tokio::io::duplex(1 << 16);
        tokio::spawn(async move {
            if let Ok(running) = EchoServer.serve(server).await {
                let _ = running.waiting().await;
            }
        });
        Ok::<DuplexStream, BoxError>(client)
    });
    McpClient::new(McpClientConfig {
        transport: Some(transport),
        options: McpClientOptions {
            application_name: Some("srv".to_owned()),
            prefix: Some("srv".to_owned()),
            ..Default::default()
        },
        ..Default::default()
    })
    .unwrap()
}

/// Builds and initializes an agent, returning the config its own delegates are rebuilt from.
async fn build(options: HarnessAgentOptions) -> (Agent, Arc<ParentConfig>) {
    let assembly = assembled(options).await;
    let parent = Arc::clone(&assembly.parent);
    let mut agent = Agent::new(assembly.config).unwrap();
    agent.initialize().await.unwrap();
    (agent, parent)
}

/// A delegate of `parent`, narrowed to `tools` when given.
async fn child_of(parent: &ParentConfig, tools: Option<&[&str]>) -> (Agent, Arc<ParentConfig>) {
    let spec = ChildSpec {
        tools: tools.map(|names| names.iter().map(|name| (*name).to_owned()).collect()),
        ..Default::default()
    };
    let options = child_options(parent, &delegable(&parent.tools), spec, &offline_env()).unwrap();
    build(options).await
}

fn names(agent: &Agent) -> Vec<String> {
    agent.tools().iter().map(|tool| tool.name().to_owned()).collect()
}

fn parent_options() -> HarnessAgentOptions {
    HarnessAgentOptions {
        tools: vec![ToolSource::McpClient(srv_client())],
        ..quiet_with_mock()
    }
}

#[tokio::test]
async fn inherits_every_parent_mcp_server_also_on_a_narrowed_delegate() {
    let (parent_agent, parent) = build(parent_options()).await;
    assert!(names(&parent_agent).contains(&"srv_echo".to_owned()));
    let subagent = parent_agent.tool_registry().get("subagent").unwrap();
    let schema = serde_json::to_value(subagent.tool_spec().input_schema.unwrap()).unwrap();
    assert!(schema["properties"].get("mcp_servers").is_none());

    let (inherit_all, _) = child_of(&parent, None).await;
    assert!(names(&inherit_all).contains(&"srv_echo".to_owned()));
    let (narrowed, _) = child_of(&parent, Some(&["read"])).await;
    let narrowed = names(&narrowed);
    assert!(narrowed.contains(&"read".to_owned()));
    assert!(narrowed.contains(&"srv_echo".to_owned()));
}

#[tokio::test]
async fn forwards_inherited_mcp_servers_to_a_grandchild() {
    let (_, parent) = build(parent_options()).await;
    let (child, child_parent) = child_of(&parent, None).await;
    assert!(names(&child).contains(&"srv_echo".to_owned()));
    let (grandchild, _) = child_of(&child_parent, None).await;
    assert!(names(&grandchild).contains(&"srv_echo".to_owned()));
}
