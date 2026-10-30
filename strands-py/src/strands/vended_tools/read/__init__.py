"""Sandbox-routed read tool for viewing files.

Text files return ``cat -n`` style numbered lines so a model can cite
``path:line``, with ``offset`` and ``limit`` for paging. Images and binary
documents return as media content blocks when the model accepts media; otherwise
``make_read(media=False)`` returns a short text placeholder describing the file.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import read

    agent = Agent(tools=[read])
    ```
"""

from .read import make_read, read

__all__ = [
    "make_read",
    "read",
]
