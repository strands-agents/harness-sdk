"""Tool validation utilities."""

from ..tools.tools import InvalidToolUseNameException, validate_tool_use
from ..types.content import Message
from ..types.tools import ToolResult, ToolUse


def validate_and_prepare_tools(
    message: Message,
    tool_uses: list[ToolUse],
    tool_results: list[ToolResult],
    invalid_tool_use_ids: list[str],
) -> None:
    """Validate tool uses and prepare them for execution.

    Args:
        message: Current message.
        tool_uses: List to populate with tool uses.
        tool_results: List to populate with tool results for invalid tools.
        invalid_tool_use_ids: List to populate with invalid tool use IDs.
    """
    # Extract tool uses from message
    for content in message["content"]:
        if isinstance(content, dict) and "toolUse" in content:
            tool_uses.append(content["toolUse"])

    # Validate tool uses
    # Avoid modifying original `tool_uses` variable during iteration
    tool_uses_copy = tool_uses.copy()
    for tool in tool_uses_copy:
        try:
            validate_tool_use(tool)
        except InvalidToolUseNameException as e:
            # Return invalid name error as ToolResult to the LLM as context
            # The replacement of the tool name to INVALID_TOOL_NAME happens in streaming.py now
            tool_uses.remove(tool)
            invalid_tool_use_ids.append(tool["toolUseId"])
            tool_uses.append(tool)
            tool_results.append(
                {
                    "toolUseId": tool["toolUseId"],
                    "status": "error",
                    "content": [{"text": f"Error: {str(e)}"}],
                }
            )
