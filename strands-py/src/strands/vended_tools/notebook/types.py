"""Shared types and constants for the notebook tool."""

_NotebookState = dict[str, str]
"""Type alias for the notebooks map stored under the ``"notebooks"`` state key."""


DEFAULT_NOTEBOOK_DESCRIPTION = (
    "Manages text notebooks for note-taking and documentation. Supports create, list, read, "
    "write (append, replace, or insert), and clear operations. "
    "In write mode: new_str alone appends to the end; new_str with old_str replaces matching text; "
    "new_str with insert_line inserts at a position. "
    "Write operations only succeed on notebooks that already exist; use list to check or create to initialize one "
    "(create overwrites any existing content)."
)
"""Description for the notebook tool."""
