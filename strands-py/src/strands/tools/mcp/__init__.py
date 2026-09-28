"""Model Context Protocol (MCP) integration.

This package provides integration with the Model Context Protocol (MCP), allowing agents to use tools provided by MCP
servers.

- Docs: https://www.anthropic.com/news/model-context-protocol
"""

from .mcp_agent_tool import MCPAgentTool
from .mcp_client import MCPClient, MCPServerConfig, ToolFilters
from .mcp_tasks import (
    MCPCallToolResult,
    MCPCancelTaskResult,
    MCPCreateTaskResult,
    MCPGetTaskResult,
    MCPInputRequest,
    MCPInputRequests,
    MCPInputResponse,
    MCPInputResponses,
    MCPTask,
    MCPTaskError,
    MCPTaskStatus,
    MCPUpdateTaskResult,
    TasksConfig,
)
from .mcp_types import MCPClientCredentials, MCPTransport, ToolsChanged, ToolsChangedCallback

__all__ = [
    "MCPAgentTool",
    "MCPClient",
    "MCPClientCredentials",
    "MCPServerConfig",
    "MCPTransport",
    "MCPCallToolResult",
    "MCPCancelTaskResult",
    "MCPCreateTaskResult",
    "MCPGetTaskResult",
    "MCPInputRequest",
    "MCPInputRequests",
    "MCPInputResponse",
    "MCPInputResponses",
    "MCPTask",
    "MCPTaskError",
    "MCPTaskStatus",
    "MCPUpdateTaskResult",
    "TasksConfig",
    "ToolFilters",
    "ToolsChanged",
    "ToolsChangedCallback",
]
