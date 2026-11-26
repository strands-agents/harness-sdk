"""File loading for Dogwood policies and Cedar action schemas."""

from __future__ import annotations

from pathlib import Path


def load_source(value: str, extension: str) -> str:
    """Read ``value`` from disk when it names a file with ``extension``, else return it as source text.

    Args:
        value: A path ending in ``extension``, or inline source text.
        extension: The file extension that marks ``value`` as a path.

    Returns:
        The source text.

    Raises:
        FileNotFoundError: If ``value`` names a file that does not exist.
    """
    if not value.endswith(extension):
        return value

    path = Path(value)
    if not path.exists():
        raise FileNotFoundError(f"Dogwood {extension} file not found: {value}")
    return path.read_text(encoding="utf-8")
