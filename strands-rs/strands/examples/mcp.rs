//! An MCP client over stdio. The example starts itself as the MCP server (the SDK's local test
//! server, `--serve`), lists its tools, gives an agent one of them through a tool filter, and
//! calls it directly, so no model or credentials are needed.
//!
//! ```text
//! cargo run -p strands --features mcp --example mcp
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

#[path = "../tests/support/mcp_server.rs"]
mod mcp_server;

use serde_json::json;
use strands::mcp::{McpClient, McpClientConfig, McpClientOptions, McpToolFilters, McpTransport, StdioServerParameters};
use strands::{Agent, Tool, ToolResultContent};

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--serve") {
        mcp_server::serve_stdio(mcp_server::TestServer::new()).await;
        return;
    }
    if let Err(error) = run().await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn server() -> strands::Result<McpTransport> {
    let command = std::env::current_exe().map_err(strands::Error::other)?;
    Ok(McpTransport::stdio(StdioServerParameters {
        command: command.to_string_lossy().into_owned(),
        args: vec!["--serve".to_owned()],
        env: None,
        cwd: None,
    }))
}

async fn run() -> strands::Result<()> {
    let listing = McpClient::with_transport(server()?);
    let names: Vec<String> = listing
        .list_tools()
        .await?
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    println!("the server offers {} tools: {}", names.len(), names.join(", "));
    listing.disconnect().await?;

    let echo_only = McpClient::new(McpClientConfig {
        transport: Some(server()?),
        options: McpClientOptions {
            tool_filters: Some(McpToolFilters {
                allowed: Some(vec!["echo".into()]),
                ..McpToolFilters::default()
            }),
            ..McpClientOptions::default()
        },
        ..McpClientConfig::default()
    })?;
    let mut agent = Agent::builder().tools([echo_only.clone()]).printer(false).build()?;
    agent.initialize().await?;
    let tools: Vec<String> = agent.tools().iter().map(|tool| tool.name().to_owned()).collect();
    println!("the agent sees: {tools:?}");

    // `agent.invoke(..)` would let the model call the tool; a direct call needs no model.
    let result = agent.tool("echo").invoke(json!({"value": "hello from Rust"})).await?;
    for content in &result.content {
        if let ToolResultContent::Text(text) = content {
            println!("echo returned: {}", text.text);
        }
    }

    agent.shutdown().await?;
    echo_only.disconnect().await
}
