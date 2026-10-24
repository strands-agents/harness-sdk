"""Sandbox-routed edit tool for in-place changes to a text file.

Supports ``str_replace`` (replace an exact unique string) and ``insert``
(insert text at a line number).

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
