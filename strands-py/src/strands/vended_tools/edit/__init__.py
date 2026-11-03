"""Sandbox-routed edit tool for in-place changes to a text file.

Replaces an exact, unique string in a file (``old_str`` must appear exactly once).

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import edit

    agent = Agent(tools=[edit])
    ```
"""

from .edit import edit, make_edit

__all__ = [
    "edit",
    "make_edit",
]
