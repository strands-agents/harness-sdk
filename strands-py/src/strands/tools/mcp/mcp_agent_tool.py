"""MCP Agent Tool module for adapting Model Context Protocol tools to the agent framework.

This module provides the MCPAgentTool class which serves as an adapter between
MCP (Model Context Protocol) tools and the agent framework's tool interface.
It allows MCP tools to be seamlessly integrated and used within the agent ecosystem.
"""

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from mcp.types import Tool as MCPTool
from typing_extensions import override

from ...types._events import ToolResultEvent
from ...types.tools import AgentTool, ToolGenerator, ToolSpec, ToolUse
from ._compat import input_schema, output_schema

if TYPE_CHECKING:
    from .mcp_client import MCPClient

logger = logging.getLogger(__name__)


class MCPAgentTool(AgentTool):
    """Adapter class that wraps an MCP tool and exposes it as an AgentTool.

    This class bridges the gap between the MCP protocol's tool representation
    and the agent framework's tool interface, allowing MCP tools to be used
    seamlessly within the agent framework.
    """

    def __init__(
        self,
        mcp_tool: MCPTool,
        mcp_client: "MCPClient",
        name_override: str | None = None,
        timeout: timedelta | None = None,
    ) -> None:
        """Initialize a new MCPAgentTool instance.

        Args:
            mcp_tool: The MCP tool to adapt
            mcp_client: The MCP server connection to use for tool invocation
            name_override: Optional name to use for the agent tool (for disambiguation)
                           If None, uses the original MCP tool name
            timeout: Optional timeout duration for tool execution. On the mcp 2.x line, the timeout
                     bounds each request round of a multi round-trip tool call rather than the call as a whole.
        """
        super().__init__()
        logger.debug("tool_name=<%s> | creating mcp agent tool", mcp_tool.name)
        self.mcp_tool = mcp_tool
        self.mcp_client = mcp_client
        self._agent_tool_name = name_override or mcp_tool.name
        self.timeout = timeout

    @property
    def tool_name(self) -> str:
        """Get the name of the tool.

        Returns:
            str: The agent-facing name of the tool (may be disambiguated)
        """
        return self._agent_tool_name

    @property
    def tool_spec(self) -> ToolSpec:
        """Get the specification of the tool.

        This method converts the MCP tool specification to the agent framework's
        ToolSpec format, including the input schema, description, optional output
        schema, and optional tool annotations.

        Returns:
            ToolSpec: The tool specification in the agent framework format
        """
        description: str = self.mcp_tool.description or f"Tool which performs {self.mcp_tool.name}"

        spec: ToolSpec = {
            "inputSchema": {"json": input_schema(self.mcp_tool)},
            "name": self.tool_name,  # Use agent-facing name in spec
            "description": description,
        }

        tool_output_schema = output_schema(self.mcp_tool)
        if tool_output_schema:
            spec["outputSchema"] = {"json": tool_output_schema}

        # Pass annotations through opaquely: per MCP spec they are untrusted hints,
        # and the annotation vocabulary is still evolving (SEP-1984, SEP-1913).
        # An annotations object with no set fields is treated the same as no annotations.
        # Dump by alias so the keys are the camelCase wire names on both `mcp`
        # lines: 2.x fields are snake_case with camelCase aliases; 1.x has no aliases.
        if self.mcp_tool.annotations:
            annotations = self.mcp_tool.annotations.model_dump(by_alias=True, exclude_none=True)
            if annotations:
                spec["annotations"] = annotations

        return spec

    @property
    def tool_type(self) -> str:
        """Get the type of the tool.

        Returns:
            str: The type of the tool, always "python" for MCP tools
        """
        return "python"

    @override
    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        """Stream the MCP tool.

        This method delegates the tool stream to the MCP server connection, passing the tool use ID, tool name, and
        input arguments.

        Args:
            tool_use: The tool use request containing tool ID and parameters.
            invocation_state: Context for the tool invocation, including agent state.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Tool events with the last being the tool result.
        """
        logger.debug("tool_name=<%s>, tool_use_id=<%s> | streaming", self.tool_name, tool_use["toolUseId"])

        result = await self.mcp_client.call_tool_async(
            tool_use_id=tool_use["toolUseId"],
            name=self.mcp_tool.name,  # Use original MCP name for server communication
            arguments=tool_use["input"],
            read_timeout_seconds=self.timeout,
            cancel_signal=getattr(invocation_state.get("agent"), "_cancel_signal", None),
        )
        yield ToolResultEvent(result)
