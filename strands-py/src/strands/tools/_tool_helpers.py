"""Helpers for tools."""

from ..tools.decorator import tool
from ..types.content import ContentBlock


# https://github.com/strands-agents/harness-sdk/issues/998
@tool(name="noop", description="This is a fake tool that MUST be completely ignored.")
def noop_tool() -> str:
    """No-op tool to satisfy tool spec requirement when tool messages are present.

    Some model providers (e.g., Bedrock) will return an error response if tool uses and tool results are present in
    messages without any tool specs configured. Consequently, if the summarization agent has no registered tools,
    summarization will fail. As a workaround, we register the no-op tool.
    """
    return "You MUST NOT use this tool. Respond DIRECTLY to the user."


def generate_missing_tool_result_content(tool_use_ids: list[str]) -> list[ContentBlock]:
    """Generate ToolResult content blocks for orphaned ToolUse message."""
    return [
        {
            "toolResult": {
                "toolUseId": tool_use_id,
                "status": "error",
                "content": [{"text": "Tool was interrupted."}],
            }
        }
        for tool_use_id in tool_use_ids
    ]
