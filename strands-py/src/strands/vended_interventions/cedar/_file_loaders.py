"""File loading utilities for Cedar policies, entities, and schemas."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_policies(source: str) -> str:
    """Load Cedar policies from a .cedar file or return inline text.

    Args:
        source: Path to a .cedar file, or inline Cedar policy text.

    Returns:
        Cedar policy text.

    Raises:
        FileNotFoundError: If a .cedar file path is provided but doesn't exist.
    """
    if source.endswith(".cedar"):
        path = Path(source)
        if not path.exists():
            raise FileNotFoundError(f"Cedar policy file not found: {source}")
        return path.read_text(encoding="utf-8")
    return source


def load_entities(source: list[dict[str, Any]] | str | None) -> list[dict[str, Any]]:
    """Load Cedar entities from a .json file, inline JSON string, inline list, or return empty.

    Args:
        source: Path to a .json file, an inline JSON array string, a list of entity dicts, or None.

    Returns:
        List of Cedar entity dicts.

    Raises:
        FileNotFoundError: If a .json file path is provided but doesn't exist.
        ValueError: If entities have invalid structure.
    """
    if source is None:
        return []

    parsed: list[dict[str, Any]]
    if isinstance(source, str):
        stripped = source.strip()
        if stripped.startswith("["):
            parsed = json.loads(stripped)
        else:
            path = Path(source)
            if not path.exists():
                raise FileNotFoundError(f"Cedar entities file not found: {source}")
            parsed = json.loads(path.read_text(encoding="utf-8"))
    else:
        parsed = source

    for entity in parsed:
        if "uid" not in entity:
            raise ValueError("Invalid entity: each entity must have a uid with type and id")
        uid = entity["uid"]
        if "__entity" in uid:
            uid = uid["__entity"]
        if not uid.get("type") or not uid.get("id"):
            raise ValueError("Invalid entity: each entity must have a uid with type and id")

    return parsed


def load_schema(source: str | None) -> str | None:
    """Load Cedar schema from a .cedarschema file or return inline text.

    Args:
        source: Path to a .cedarschema file, inline schema text, or None.

    Returns:
        Cedar schema text, or None if source is None.

    Raises:
        FileNotFoundError: If a .cedarschema file path is provided but doesn't exist.
    """
    if source is None:
        return None
    if source.endswith(".cedarschema"):
        path = Path(source)
        if not path.exists():
            raise FileNotFoundError(f"Cedar schema file not found: {source}")
        return path.read_text(encoding="utf-8")
    return source
