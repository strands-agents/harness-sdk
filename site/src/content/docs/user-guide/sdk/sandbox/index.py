"""Sandbox documentation code examples."""

import asyncio
import json

from strands import Agent, tool
from strands.sandbox.docker import DockerSandbox
from strands.sandbox.ssh import SshSandbox
from strands.types.tools import ToolContext


# --8<-- [start:basic_usage]
agent = Agent(sandbox=DockerSandbox("my-container-id"))

# The agent's sandbox_shell and sandbox_file_editor tools execute inside the container
agent("List all files inside the current directory")
# --8<-- [end:basic_usage]



# --8<-- [start:programmatic_access]
async def main():
    agent = Agent(sandbox=DockerSandbox("my-container-id"))

    # Seed an input file, let the agent work, then read the result back
    await agent.sandbox.write_text("/workspace/input.csv", "id,value\n1,42\n")

    agent("Summarize /workspace/input.csv and write the summary to /workspace/out.txt")

    result = await agent.sandbox.execute("cat /workspace/out.txt")
    print(result.exit_code, result.stdout)


asyncio.run(main())
# --8<-- [end:programmatic_access]


# --8<-- [start:streaming]
from strands.sandbox import ExecutionResult, StreamChunk


async def stream_example():
    sandbox = DockerSandbox("my-container-id")

    async for chunk in sandbox.execute_streaming("npm run build"):
        if isinstance(chunk, StreamChunk):
            print(chunk.data, end="")
        elif isinstance(chunk, ExecutionResult):
            print(f"\nexit code: {chunk.exit_code}")


asyncio.run(stream_example())
# --8<-- [end:streaming]


# --8<-- [start:tool_override]
from strands.vended_tools import make_shell

sandbox = DockerSandbox("agent-workspace")

locked_shell = make_shell(
    sandbox=sandbox,
    name="sandbox_shell",
    description="Run read-only shell commands. Do not modify files.",
)

# The agent keeps locked_shell; the sandbox's own sandbox_shell is skipped
agent = Agent(sandbox=sandbox, tools=[locked_shell])
# --8<-- [end:tool_override]


# --8<-- [start:custom_tool]
@tool(context="tool_context")
async def lint(path: str, tool_context: ToolContext) -> list:
    """Lint a file and return structured errors.

    Args:
        path: File path to lint.
        tool_context: Injected by the framework.
    """
    result = await tool_context.agent.sandbox.execute(f"eslint --format json {path}")
    issues = json.loads(result.stdout)
    return [msg for file in issues for msg in file["messages"]]


agent = Agent(
    sandbox=DockerSandbox("my-dev-env"),
    tools=[lint],
)
# Agent now has: sandbox_shell, sandbox_file_editor (vended) + lint (yours)
# --8<-- [end:custom_tool]


# --8<-- [start:custom_sandbox]
import asyncio
from collections.abc import AsyncGenerator
from typing import Any

from strands.sandbox import PosixShellSandbox
from strands.sandbox.types import ExecutionResult, StreamChunk


class FirecrackerSandbox(PosixShellSandbox):
    """Run commands in a Firecracker microVM addressed by id."""

    def __init__(self, vm_id: str) -> None:
        self.vm_id = vm_id

    async def execute_streaming(
        self,
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
        proc = await asyncio.create_subprocess_exec(
            "fc-exec", self.vm_id, "sh", "-c", command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if stdout:
            yield StreamChunk(data=stdout.decode(), stream_type="stdout")
        if stderr:
            yield StreamChunk(data=stderr.decode(), stream_type="stderr")
        yield ExecutionResult(
            exit_code=proc.returncode or 0,
            stdout=stdout.decode(),
            stderr=stderr.decode(),
        )
# --8<-- [end:custom_sandbox]


# --8<-- [start:docker_constructor]
from strands import Agent
from strands.sandbox.docker import DockerSandbox

sandbox = DockerSandbox(
    "agent-workspace",
    working_dir="/workspace",
    user="1000:1000",
)
agent = Agent(sandbox=sandbox)
agent("Run the test suite and summarize any failures")
# --8<-- [end:docker_constructor]


# --8<-- [start:ssh_constructor]
from strands import Agent
from strands.sandbox.ssh import SshSandbox

sandbox = SshSandbox(
    "ubuntu@10.0.1.5",
    working_dir="/home/ubuntu/workspace",
    identity_file="~/.ssh/agent_key",
)
agent = Agent(sandbox=sandbox)
agent("Check disk usage and list running processes")
# --8<-- [end:ssh_constructor]


# --8<-- [start:vend_tools]
from strands.types.tools import AgentTool
from strands.vended_tools import make_file_editor, make_shell


# Inside your custom sandbox class:
def get_tools(self) -> list[AgentTool]:
    return [
        make_file_editor(sandbox=self, name="sandbox_file_editor"),
        make_shell(sandbox=self, name="sandbox_shell"),
    ]
# --8<-- [end:vend_tools]
