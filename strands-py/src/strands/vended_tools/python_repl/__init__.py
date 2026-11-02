"""Python REPL tool for running Python through the agent's sandbox.

A thin shim over :meth:`~strands.sandbox.base.Sandbox.execute_code`. Each call runs
in a fresh interpreter, so in-memory state does not persist across calls.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import python_repl

    agent = Agent(tools=[python_repl])
    ```
"""

from .python_repl import make_python_repl, python_repl

__all__ = [
    "make_python_repl",
    "python_repl",
]
