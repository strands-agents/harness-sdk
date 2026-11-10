import pytest

from strands import Agent, tool


@tool
def get_tiger_height() -> int:
    """Returns the height of a tiger in centimeters."""
    return 100


@pytest.mark.asyncio
async def test_stream_async_with_agent_tool():
    inner_agent = Agent(
        name="myAgentTool",
        description="An agent tool knowledgeable about tigers",
        tools=[get_tiger_height],
    )
    agent_tool = inner_agent.as_tool()
    agent = Agent(
        name="myOtherAgent",
        tools=[agent_tool],
    )

    result = await agent.invoke_async(
        prompt="Invoke the myAgentTool and ask about the height of tigers.",
    )

    # Outer agent completed and called the agent tool
    assert result.stop_reason == "end_turn"
    assert "myAgentTool" in result.metrics.tool_metrics
    assert result.metrics.tool_metrics["myAgentTool"].success_count >= 1

    # Inner agent called get_tiger_height
    assert "get_tiger_height" in inner_agent.event_loop_metrics.tool_metrics
    assert inner_agent.event_loop_metrics.tool_metrics["get_tiger_height"].success_count >= 1
