"""Minimal XML escaping for folding untrusted text into an XML-shaped block.

Memory entries and other injected content are frequently user-derived, so interpolating them
raw into ``<entry>…</entry>`` both breaks the block structurally (a stray ``</entry>`` or
``"``) and opens a stored-prompt-injection surface. These helpers are deliberately tiny —
enough to keep a ``<memory>`` block well-formed, not a general-purpose serializer.
``_untrusted_json_block`` is the counterpart for a JSON value read by an evaluator model: the
value stays JSON, written so that it cannot contain the closing delimiter.
"""

from __future__ import annotations

import json
from typing import Any


def _escape_xml_text(value: str) -> str:
    """Escape text content for placement between XML tags.

    Escapes ``&`` first (so later replacements are not double-escaped), then ``<`` and ``>``.

    Args:
        value: The raw text to escape.

    Returns:
        The escaped text, safe to place in element content.
    """
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_xml_attr(value: str) -> str:
    """Escape a value for placement inside a double-quoted XML attribute.

    Applies the :func:`_escape_xml_text` rules plus ``"`` and ``'``.

    Args:
        value: The raw attribute value to escape.

    Returns:
        The escaped value, safe to place inside a quoted attribute.
    """
    return _escape_xml_text(value).replace('"', "&quot;").replace("'", "&#39;")


def _untrusted_json_block(tag: str, value: Any) -> str:
    r"""Serialize a value as JSON between ``<tag>`` and ``</tag>`` delimiters.

    ``</`` is written as ``<\/``, and DEL and non-ASCII characters as ``\uXXXX``, so the body is ASCII and cannot
    contain a closing delimiter. Both are JSON escapes: a JSON parser reads the same value.

    Args:
        tag: The delimiter tag name.
        value: The JSON-serializable value to enclose.

    Returns:
        The delimited block.
    """
    body = json.dumps(value, indent=2, ensure_ascii=True).replace("</", "<\\/")
    return f"<{tag}>\n{body}\n</{tag}>"
