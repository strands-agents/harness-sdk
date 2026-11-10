import logging

import pytest

from strands import Agent, tool
from strands.agent import AgentResult
from strands.models.bedrock import BedrockModel
from strands.types.exceptions import MaxTokensReachedException

logger = logging.getLogger(__name__)


@tool
def story_tool(story: str) -> str:
    """
    Tool that writes a story that is minimum 50,000 lines long.
    """
    return story


def test_max_tokens_reached():
    """Test that MaxTokensReachedException is raised but the agent can still rerun on the second pass"""
    model = BedrockModel(max_tokens=100)
    agent = Agent(model=model, tools=[story_tool])

    # This should raise an exception
    with pytest.raises(MaxTokensReachedException):
        agent("Tell me a story!")

    # Validate that at least one message contains the incomplete tool use error message
    expected_text = "tool use was incomplete due to maximum token limits being reached"
    all_text_content = [
        content_block["text"]
        for message in agent.messages
        for content_block in message.get("content", [])
        if "text" in content_block
    ]

    assert any(expected_text in text for text in all_text_content), (
        f"Expected to find message containing '{expected_text}' in agent messages"
    )

    # Remove tools from agent and re-run with a generic question
    agent.tool_registry.registry = {}
    agent.tool_registry.tool_config = {}

    result: AgentResult = agent("What is 3+3")
    assert result.stop_reason == "end_turn"
