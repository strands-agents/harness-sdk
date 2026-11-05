"""Shell tool for executing commands through a sandbox.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import shell

    agent = Agent(tools=[shell])
    ```
"""

from .shell import make_shell, shell
from .types import ShellExecutionError, ShellOutput, ShellResultKeys, ShellStdioOutput

__all__ = [
    "ShellExecutionError",
    "ShellOutput",
    "ShellResultKeys",
    "ShellStdioOutput",
    "make_shell",
    "shell",
]
