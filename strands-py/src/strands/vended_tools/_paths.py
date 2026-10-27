"""Path validation shared across sandbox-routed file tools."""

from __future__ import annotations

import ntpath
import posixpath
import re


def validate_absolute_path(path: str) -> None:
    """Reject non-absolute paths and ``..`` segments.

    Raises:
        ValueError: If the path is not absolute, or contains a ``..`` segment.
    """
    if not (posixpath.isabs(path) or ntpath.isabs(path)):
        raise ValueError(
            f"The path {path} is not absolute; it should start with '/' (or a drive letter or UNC share on Windows)."
        )
    if ".." in re.split(r"[/\\]", path):
        raise ValueError("Invalid path: path traversal is not allowed.")
