"""Subagent delegation tool.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools.subagent import make_subagent

    subagent = make_subagent()
    agent = Agent(tools=[subagent])
    ```
"""

from .subagent import make_subagent

__all__ = [
    "make_subagent",
]
