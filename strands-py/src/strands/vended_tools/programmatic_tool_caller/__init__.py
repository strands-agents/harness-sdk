"""Programmatic tool caller: lets the agent orchestrate its other tools with Python code.

The code runs in a sandboxed interpreter with every other registered tool exposed as an
``async`` function, and only what it prints is returned to the model.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import programmatic_tool_caller, shell

    agent = Agent(tools=[programmatic_tool_caller, shell])
    ```
"""

from .programmatic_tool_caller import make_programmatic_tool_caller, programmatic_tool_caller

__all__ = [
    "make_programmatic_tool_caller",
    "programmatic_tool_caller",
]
