"""Sandbox-routed file editor tool for viewing, creating, and editing files.

.. deprecated::
    ``file_editor`` is deprecated in favor of the focused ``read``, ``write``,
    and ``edit`` vended tools. It will be removed in a future release.
    Importing ``file_editor`` or calling ``make_file_editor`` emits a
    :class:`DeprecationWarning`.

Supports view (with line ranges), create, str_replace, insert, find_line, and
undo_edit operations.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import file_editor  # deprecated

    agent = Agent(tools=[file_editor])
    ```
"""

from .file_editor import file_editor, make_file_editor

__all__ = [
    "file_editor",
    "make_file_editor",
]
