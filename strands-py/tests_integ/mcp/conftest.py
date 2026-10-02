from strands.tools.mcp._compat import MCP_V2

# These modules build fixture servers and transports from 1.x-only `mcp` names (`FastMCP`, `streamablehttp_client`,
# `McpError`), so on a 2.x install they fail at import and cannot be collected. The mcp-1x scope in
# python-integration-test.yml forces mcp 1.x and runs them there.
if MCP_V2:
    collect_ignore = [
        "test_mcp_client.py",
        "test_mcp_client_structured_content_and_metadata.py",
        "test_mcp_client_tasks.py",
        "test_mcp_elicitation.py",
        "test_mcp_output_schema.py",
        "test_mcp_resources.py",
        "test_mcp_tool_provider.py",
    ]
