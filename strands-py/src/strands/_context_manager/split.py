"""Split large string fields out of tool result content so they are stored and previewed as plain text.

A tool result such as ``{"output": "<100 KB of stdout>", "exit_code": 0}`` is stashed as one line of JSON, which
makes stdout unsearchable: its newlines are escaped. Any string at the top level of a text or JSON content block that
reaches the preview budget is split into its own stash entry, stored as raw UTF-8, and replaced in the parent by a
reference marker. The same split shapes the truncation preview, so the model sees the parent's structure and the
references it can page through.
"""

from __future__ import annotations

import json
import re

from ..types.tools import ToolResultContent

FIELD_REF_PREFIX = "fields/"

_FIELD_NAME = re.compile(r"^[A-Za-z0-9_-]+$")
_FIELD_REF = re.compile(rf"^{FIELD_REF_PREFIX}.+_\d+/[A-Za-z0-9_-]+$")


def field_ref(parent_ref: str, field: str) -> str:
    """Stash key of a string field split out of the block stored under ``parent_ref``."""
    return f"{FIELD_REF_PREFIX}{parent_ref}/{field}"


def is_field_ref(reference: str) -> bool:
    """Whether ``reference`` names a split-out string field (stored as raw text) rather than a JSON block."""
    return _FIELD_REF.match(reference) is not None


def _marker(ref: str, text: str) -> str:
    return f"[ref: {ref} ({text.count(chr(10)) + 1:,} lines, {len(text):,} chars)]"


def split_large_strings(
    item: ToolResultContent, parent_ref: str, threshold: int
) -> tuple[ToolResultContent, dict[str, str]]:
    """Split top-level strings of ``threshold`` chars or more out of a text or JSON content block.

    Returns the block with each split string replaced by a reference marker, plus a map of field ref -> raw text.
    Blocks with nothing to split are returned unchanged with an empty map.
    """
    if "json" in item:
        payload: object = item["json"]
    elif "text" in item:
        text = item["text"]
        if len(text) < threshold:
            return item, {}
        payload = _parse_json_object(text)
        if payload is None:
            ref = field_ref(parent_ref, "text")
            return ToolResultContent(text=_marker(ref, text)), {ref: text}
    else:
        return item, {}

    if not isinstance(payload, dict):
        return item, {}
    fields: dict[str, str] = {}
    replaced = dict(payload)
    for key, value in payload.items():
        if isinstance(value, str) and len(value) >= threshold and _FIELD_NAME.match(key):
            ref = field_ref(parent_ref, key)
            fields[ref] = value
            replaced[key] = _marker(ref, value)
    if not fields:
        return item, {}
    if "json" in item:
        return ToolResultContent(json=replaced), fields
    return ToolResultContent(text=json.dumps(replaced, ensure_ascii=False, separators=(",", ":"))), fields


def _parse_json_object(text: str) -> dict[str, object] | None:
    if not text.lstrip().startswith("{"):
        return None
    try:
        parsed = json.loads(text)
    except (ValueError, RecursionError):
        return None
    return parsed if isinstance(parsed, dict) else None
