---
name: add-mcp-server
description: Connect a Strands agent to an MCP server in Python or TypeScript. Use when the user asks to load MCP tools into a Strands application, choose an MCP transport, filter tools, or configure multiple servers.
---

# Add an MCP server to a Strands agent

Read [the shared Strands skill](../../SKILL.md) and [the MCP guide](../../references/add-mcp-server.md) completely.

Confirm whether the user means an MCP server used by the Strands application or the Strands documentation server used by their coding assistant. For an application server, inspect its command or URL and required credentials, use the current managed `MCPClient` or `McpClient` integration, and verify initialization and tool discovery before relying on model-driven calls.
