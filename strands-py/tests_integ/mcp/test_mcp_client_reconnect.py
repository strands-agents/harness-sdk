"""Integration tests for `MCPClient` ``auto_reconnect`` against a stdio server whose process exits."""

import asyncio
import sys
from pathlib import Path

import pytest
from mcp import StdioServerParameters
from mcp.client.stdio import stdio_client

from strands.tools.mcp import MCPClient

SERVER_PATH = str(Path(__file__).with_name("exiting_server.py"))


@pytest.mark.parametrize("call_async", [False, True], ids=["sync", "async"])
def test_call_tool_reconnects_after_stdio_server_exits(call_async):
    def call(client, name):
        if call_async:
            return asyncio.run(client.call_tool_async(tool_use_id="tu-1", name=name, arguments={}))
        return client.call_tool_sync(tool_use_id="tu-1", name=name, arguments={})

    client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command=sys.executable, args=[SERVER_PATH])),
        auto_reconnect=True,
    )
    with client:
        first_pid = call(client, "get_pid")["content"][0]["text"]
        # The retry lands on a fresh server and exits that one too, so the call fails and the session is dead again.
        exit_result = call(client, "exit_process")
        recovered = call(client, "get_pid")

    assert exit_result["status"] == "error"
    assert recovered["status"] == "success"
    assert recovered["content"][0]["text"] != first_pid
