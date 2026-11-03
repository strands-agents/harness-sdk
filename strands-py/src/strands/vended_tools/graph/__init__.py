"""Graph tool for running a directed acyclic graph of sub-agents at runtime.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import graph

    agent = Agent(tools=[graph])
    ```
"""

from .graph import graph, make_graph

__all__ = [
    "graph",
    "make_graph",
]
