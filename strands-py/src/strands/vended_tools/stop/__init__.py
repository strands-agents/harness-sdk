"""Tool for gracefully ending the agent loop.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import stop

    agent = Agent(tools=[stop])
    ```
"""

from .stop import make_stop, stop

__all__ = [
    "make_stop",
    "stop",
]
