#!/usr/bin/env python3
"""
Integration test for ToolContext functionality with real agent interactions.
"""

from strands import Agent, ToolContext, tool
from strands.models.bedrock import BedrockModel
from strands.types.tools import ToolResult


@tool(context="custom_context_field")
def good_story(message: str, custom_context_field: ToolContext) -> dict:
    """Tool that writes a good story"""
    tool_use_id = custom_context_field.tool_use["toolUseId"]
    return {
        "status": "success",
        "content": [{"text": f"Context tool processed with ID: {tool_use_id}"}],
    }


@tool(context=True)
def bad_story(message: str, tool_context: ToolContext) -> dict:
    """Tool that writes a bad story"""
    tool_use_id = tool_context.tool_use["toolUseId"]
    return {
        "status": "success",
        "content": [{"text": f"Context tool processed with ID: {tool_use_id}"}],
    }


def _validate_tool_result_content(agent: Agent):
    first_tool_result: ToolResult = [
        block["toolResult"] for message in agent.messages for block in message["content"] if "toolResult" in block
    ][0]

    assert first_tool_result["status"] == "success"
    assert (
        first_tool_result["content"][0]["text"] == f"Context tool processed with ID: {first_tool_result['toolUseId']}"
    )


def test_strands_context_integration_context_true():
    """Test ToolContext functionality with real agent interactions."""

    model = BedrockModel(model_id="global.anthropic.claude-sonnet-4-6")
    agent = Agent(model=model, tools=[good_story])
    agent("using a tool, write a good story about a dragon")

    _validate_tool_result_content(agent)


def test_strands_context_integration_context_custom():
    """Test ToolContext functionality with real agent interactions."""

    agent = Agent(tools=[bad_story])
    agent("using a tool, write a bad story about a dragon")

    _validate_tool_result_content(agent)


@tool(context=True)
def calculate_sum(a: int, b: int, tool_context: ToolContext) -> int:
    result = a + b
    tool_context.agent.state.set("last_calculation", result)
    return result


def test_agent_state_access_through_tool_context():
    """Test that tools can access agent state through ToolContext."""
    agent = Agent(tools=[calculate_sum])
    result = agent.tool.calculate_sum(a=1, b=1)

    # Verify the tool executed successfully
    assert result["status"] == "success"

    # Verify the agent state was updated
    assert agent.state.get("last_calculation") == 2
