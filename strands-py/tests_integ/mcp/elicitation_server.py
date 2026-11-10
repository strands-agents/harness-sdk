"""MCP server for testing elicitation.

- Docs: https://modelcontextprotocol.io/specification/draft/client/elicitation
"""

from mcp.server import FastMCP
from pydantic import BaseModel, Field


class ApprovalSchema(BaseModel):
    message: str = Field(description="request message")


def server() -> None:
    """Simulate approval through MCP elicitation."""
    server_ = FastMCP()

    @server_.tool(description="Tool to request approval")
    async def approval_tool() -> str:
        """Simulated approval tool.

        Returns:
            The elicitation result from the user.
        """
        result = await server_.get_context().elicit(
            message="Do you approve",
            schema=ApprovalSchema,
        )
        return result.model_dump_json()

    server_.run(transport="stdio")


if __name__ == "__main__":
    server()
