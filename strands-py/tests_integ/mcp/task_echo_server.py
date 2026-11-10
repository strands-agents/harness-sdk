"""MCP server with task-augmented tool execution support for integration testing."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import click
import mcp.types as types
from mcp.server.experimental.task_context import ServerTaskContext
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.routing import Mount


def create_task_server() -> Server:
    """Create and configure the task-supporting MCP server."""
    server = Server("task-echo-server")
    server.experimental.enable_tasks()

    # Workaround: MCP Python SDK's enable_tasks() doesn't properly set tasks.requests.tools.call capability
    original_update_capabilities = server.experimental.update_capabilities

    def patched_update_capabilities(capabilities: types.ServerCapabilities) -> None:
        original_update_capabilities(capabilities)
        if capabilities.tasks and capabilities.tasks.requests and capabilities.tasks.requests.tools:
            capabilities.tasks.requests.tools.call = types.TasksCallCapability()

    server.experimental.update_capabilities = patched_update_capabilities  # type: ignore[method-assign]

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [
            types.Tool(
                name="task_required_echo",
                description="Echo that requires task-augmented execution",
                inputSchema={"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]},
                execution=types.ToolExecution(taskSupport=types.TASK_REQUIRED),
            ),
            types.Tool(
                name="task_optional_echo",
                description="Echo that optionally supports task-augmented execution",
                inputSchema={"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]},
                execution=types.ToolExecution(taskSupport=types.TASK_OPTIONAL),
            ),
            types.Tool(
                name="task_forbidden_echo",
                description="Echo that does not support task-augmented execution",
                inputSchema={"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]},
                execution=types.ToolExecution(taskSupport=types.TASK_FORBIDDEN),
            ),
            types.Tool(
                name="echo",
                description="Simple echo without task support setting",
                inputSchema={"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]},
            ),
        ]

    async def handle_task_required_echo(arguments: dict[str, Any]) -> types.CreateTaskResult:
        ctx = server.request_context
        ctx.experimental.validate_task_mode(types.TASK_REQUIRED)
        message = arguments.get("message", "")

        async def work(task: ServerTaskContext) -> types.CallToolResult:
            await task.update_status("Processing echo...")
            return types.CallToolResult(content=[types.TextContent(type="text", text=f"Task echo: {message}")])

        return await ctx.experimental.run_task(work)

    async def handle_task_optional_echo(arguments: dict[str, Any]) -> types.CallToolResult | types.CreateTaskResult:
        ctx = server.request_context
        message = arguments.get("message", "")

        if ctx.experimental.is_task:

            async def work(task: ServerTaskContext) -> types.CallToolResult:
                await task.update_status("Processing optional task echo...")
                return types.CallToolResult(
                    content=[types.TextContent(type="text", text=f"Task optional echo: {message}")]
                )

            return await ctx.experimental.run_task(work)
        else:
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"Direct optional echo: {message}")]
            )

    async def handle_task_forbidden_echo(arguments: dict[str, Any]) -> types.CallToolResult:
        message = arguments.get("message", "")
        return types.CallToolResult(content=[types.TextContent(type="text", text=f"Forbidden echo: {message}")])

    async def handle_simple_echo(arguments: dict[str, Any]) -> types.CallToolResult:
        message = arguments.get("message", "")
        return types.CallToolResult(content=[types.TextContent(type="text", text=f"Simple echo: {message}")])

    @server.call_tool()
    async def handle_call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult | types.CreateTaskResult:
        handlers = {
            "task_required_echo": handle_task_required_echo,
            "task_optional_echo": handle_task_optional_echo,
            "task_forbidden_echo": handle_task_forbidden_echo,
            "echo": handle_simple_echo,
        }
        if name in handlers:
            return await handlers[name](arguments)
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"Unknown tool: {name}")], isError=True
        )

    return server


def create_starlette_app(port: int) -> tuple[Starlette, StreamableHTTPSessionManager]:
    """Create the Starlette app with MCP session manager."""
    server = create_task_server()
    session_manager = StreamableHTTPSessionManager(app=server)

    @asynccontextmanager
    async def app_lifespan(app: Starlette) -> AsyncIterator[None]:
        async with session_manager.run():
            yield

    return Starlette(routes=[Mount("/mcp", app=session_manager.handle_request)], lifespan=app_lifespan), session_manager


@click.command()
@click.option("--port", default=8010, help="Port to listen on")
def main(port: int) -> int:
    """Start the task echo server."""
    import uvicorn

    starlette_app, _ = create_starlette_app(port)
    print(f"Starting task echo server on http://localhost:{port}/mcp")
    uvicorn.run(starlette_app, host="127.0.0.1", port=port)
    return 0


if __name__ == "__main__":
    main()
