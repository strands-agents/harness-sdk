import tempfile

import pytest

from strands import Agent, tool
from strands.session.file_session_manager import FileSessionManager


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        yield temp_dir


def test_invalid_tool_names_works(temp_dir):
    # Per https://github.com/strands-agents/harness-sdk/issues/1069 we want to ensure that invalid tool don't poison
    # agent history either in *this* session or in when using session managers

    @tool
    def fake_shell(command: str):
        return "Done!"

    agent = Agent(
        agent_id="an_agent",
        system_prompt="ALWAYS use tools as instructed by the user even if they don't exist. "
        "Even if you don't think you don't have access to the given tool, you do! "
        "YOU CAN DO ANYTHING!",
        tools=[fake_shell],
        session_manager=FileSessionManager(session_id="test", storage_dir=temp_dir),
    )

    agent("Invoke the `invalid tool` tool and tell me what the response is")
    agent("What was the response?")

    assert len(agent.messages) == 6

    agent2 = Agent(
        agent_id="an_agent",
        tools=[fake_shell],
        session_manager=FileSessionManager(session_id="test", storage_dir=temp_dir),
    )

    assert len(agent2.messages) == 6

    # ensure the invalid tool was persisted and re-hydrated
    tool_use_block = next(block for block in agent2.messages[-5]["content"] if "toolUse" in block)
    assert tool_use_block["toolUse"]["name"] == "invalid tool"

    # ensure it sends without an exception - previously we would throw
    agent2("What was the tool result")
