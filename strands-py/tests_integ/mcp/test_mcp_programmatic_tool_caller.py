"""Programmatic tool caller driving real MCP tools over stdio."""

import pytest
from mcp import StdioServerParameters, stdio_client

from strands import Agent
from strands.tools.mcp.mcp_client import MCPClient
from strands.vended_tools import programmatic_tool_caller


def _run(agent, code):
    return agent.tool.programmatic_tool_caller(code=code, record_direct_tool_call=False)


def _text(result):
    return result["content"][0]["text"]


_MCP_SERVER = "tests_integ/mcp/programmatic_tool_caller_server.py"


@pytest.fixture(scope="module")
def mcp_agent():
    client = MCPClient(lambda: stdio_client(StdioServerParameters(command="python", args=[_MCP_SERVER])))
    with client:
        yield Agent(model=None, tools=[programmatic_tool_caller, *client.list_tools_sync()])


def test_calls_mcp_tool(mcp_agent):
    assert _text(_run(mcp_agent, 'print(await ptc_echo(text="hi"))')) == "echo:hi"


def test_loops_over_mcp_tool_calls(mcp_agent):
    result = _run(mcp_agent, "for i in range(3):\n    print(await ptc_add(a=i, b=10))")
    assert _text(result) == "10\n11\n12"


def test_runs_mcp_tools_concurrently(mcp_agent):
    code = "import asyncio\nprint(await asyncio.gather(*[ptc_echo(text=str(i)) for i in range(3)]))"
    assert _text(_run(mcp_agent, code)) == "['echo:0', 'echo:1', 'echo:2']"


def test_mcp_tool_error_is_catchable(mcp_agent):
    code = "try:\n    await ptc_boom()\nexcept RuntimeError as e:\n    print('caught:', e)"
    result = _run(mcp_agent, code)
    assert result["status"] == "success"
    assert "mcp tool exploded" in _text(result)


def test_hyphenated_mcp_tool_is_callable(mcp_agent):
    assert _text(_run(mcp_agent, 'print(await ptc_dash(value="x"))')) == "dash:x"


def test_dotted_mcp_tool_is_callable(mcp_agent):
    assert _text(_run(mcp_agent, 'print(await ptc_dot(value="y"))')) == "dot:y"


def test_mcp_structured_content_arrives_as_data(mcp_agent):
    result = _run(mcp_agent, 'r = await ptc_info(name="demo")\nprint(type(r).__name__, r["size"])')
    assert _text(result) == "dict 6"


def test_unprinted_mcp_result_does_not_leak(mcp_agent):
    result = _run(mcp_agent, 'x = await ptc_echo(text="secret")\nprint("done")')
    assert _text(result) == "done"
