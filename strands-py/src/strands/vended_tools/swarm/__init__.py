"""Swarm tool for spinning up a handoff-based sub-agent team at runtime.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import swarm

    agent = Agent(tools=[swarm])
    ```
"""

from .swarm import make_swarm, swarm

__all__ = [
    "make_swarm",
    "swarm",
]
