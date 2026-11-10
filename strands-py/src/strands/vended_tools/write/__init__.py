"""Sandbox-routed write tool for creating or overwriting a text file.

Writes the full provided content to an absolute path; pair with ``read`` and
``edit`` for the focused file-editing surface.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import write

    agent = Agent(tools=[write])
    ```
"""

from .write import make_write, write

__all__ = [
    "make_write",
    "write",
]
