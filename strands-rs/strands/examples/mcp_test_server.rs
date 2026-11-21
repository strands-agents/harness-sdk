//! A local MCP server over stdio, for the MCP client tests (`tests/mcp.rs`).

#[path = "../tests/support/mcp_server.rs"]
mod mcp_server;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    mcp_server::serve_stdio(mcp_server::TestServer::new()).await;
}
