import json

import pytest
from mcp import StdioServerParameters, stdio_client
from mcp.types import ElicitResult

from strands import Agent
from strands.tools.mcp import MCPClient


@pytest.fixture
def callback():
    async def callback_(_, params):
        return ElicitResult(action="accept", content={"message": f"server_message=<{params.message}>"})

    return callback_


@pytest.fixture
def client(callback):
    return MCPClient(
        lambda: stdio_client(
            StdioServerParameters(command="python", args=["tests_integ/mcp/elicitation_server.py"]),
        ),
        elicitation_callback=callback,
    )


def test_mcp_elicitation(client):
    with client:
        tools = client.list_tools_sync()
        agent = Agent(tools=tools)

        agent("Can you get approval")

    tool_result = agent.messages[-2]

    tru_result = json.loads(tool_result["content"][0]["toolResult"]["content"][0]["text"])
    exp_result = {"action": "accept", "data": {"message": "server_message=<Do you approve>"}}
    assert tru_result == exp_result
