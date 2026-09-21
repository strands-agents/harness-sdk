"""Completion round trips against a local server on either supported MCP major line."""

import asyncio
import socket
import threading
import time

import pytest
import uvicorn
from mcp.types import Completion, PromptReference, ResourceTemplateReference

from strands.tools.mcp import MCPClient
from strands.tools.mcp._compat import MCP_V2, MCPError


@pytest.fixture(scope="module")
def completion_started():
    return threading.Event()


@pytest.fixture(scope="module")
def completion_server_url(completion_started):
    if MCP_V2:
        from mcp.server.mcpserver import MCPServer
    else:
        from mcp.server.fastmcp import FastMCP as MCPServer

    server = MCPServer("completion-test")

    @server.prompt()
    def review(language: str) -> str:
        return f"Review {language} code"

    @server.resource("github://repos/{owner}/{repo}")
    def repository(owner: str, repo: str) -> str:
        return f"{owner}/{repo}"

    @server.completion()
    async def complete(ref, argument, context):
        if argument.value == "waiting":
            completion_started.set()
            await asyncio.Event().wait()
        if isinstance(ref, PromptReference):
            candidates = ["python", "typescript"]
        else:
            owner = context.arguments.get("owner", "default") if context else "default"
            candidates = [f"{owner}-python", f"{owner}-typescript"]
        values = [value for value in candidates if value.startswith(argument.value)]
        return Completion(values=values, total=len(values))

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        runner = uvicorn.Server(uvicorn.Config(server.streamable_http_app(), log_level="error"))
        worker = threading.Thread(target=runner.run, kwargs={"sockets": [listener]}, daemon=True)
        worker.start()
        try:
            deadline = time.monotonic() + 10
            while not runner.started and worker.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            assert runner.started, "local MCP server did not start"
            yield f"http://127.0.0.1:{port}/mcp"
        finally:
            runner.should_exit = True
            worker.join(timeout=10)
            assert not worker.is_alive(), "local MCP server did not stop"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["sync", "async"])
async def test_complete_prompt_and_contextual_resource(completion_server_url, mode):
    with MCPClient(url=completion_server_url) as client:
        prompt = PromptReference(type="ref/prompt", name="review")
        argument = {"name": "language", "value": "py"}
        if mode == "sync":
            languages = client.complete_sync(prompt, argument)
        else:
            languages = await client.complete_async(prompt, argument)
        assert languages.completion.values == ["python"]
        assert languages.completion.total == 1
        assert (
            "python"
            in client.get_prompt_sync("review", {"language": languages.completion.values[0]}).messages[0].content.text
        )

        template = ResourceTemplateReference(type="ref/resource", uri="github://repos/{owner}/{repo}")
        results = []
        for owner in ["first", "second"]:
            arguments = {"name": "repo", "value": owner + "-py"}
            if mode == "sync":
                result = client.complete_sync(template, arguments, {"owner": owner})
            else:
                result = await client.complete_async(template, arguments, {"owner": owner})
            results.append(result.completion.values)
        assert results == [["first-python"], ["second-python"]]

        no_matches = await client.complete_async(prompt, {"name": "language", "value": "missing"})
        assert no_matches.completion.values == []
        assert no_matches.completion.total == 0


@pytest.mark.asyncio
async def test_complete_connection_closes(completion_server_url, completion_started):
    with MCPClient(url=completion_server_url) as client:
        request = asyncio.create_task(
            client.complete_async(
                PromptReference(type="ref/prompt", name="review"), {"name": "language", "value": "waiting"}
            )
        )
        try:
            assert await asyncio.to_thread(completion_started.wait, 5)
            await asyncio.to_thread(client.stop, None, None, None)
            with pytest.raises((RuntimeError, MCPError)):
                await asyncio.wait_for(request, 5)
        finally:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
