"""Search and formatting utilities for offloaded content.

Provides grep-like pattern matching and line-range random access over stored
text content, with output capped to a character budget.
"""

from __future__ import annotations

import re

_MAX_PATTERN_LENGTH = 200
# Best-effort heuristic; does not catch all catastrophic patterns (e.g. (.*a){12}$).
_NESTED_QUANTIFIER = re.compile(r"[+*]\s*\)\s*[+*]")
_MATCH_LINE = re.compile(r"^>", re.MULTILINE)

_TEXT_APPLICATION_TYPES = frozenset(
    {
        "application/json",
        "application/xml",
        "application/javascript",
        "application/typescript",
        "application/yaml",
        "application/x-yaml",
        "application/toml",
        "application/sql",
        "application/graphql",
        "application/xhtml+xml",
    }
)


def _is_searchable_content(content_type: str) -> bool:
    """Return whether the given MIME content type can be searched as text."""
    return content_type.startswith("text/") or content_type in _TEXT_APPLICATION_TYPES


def _search_content(
    text: str,
    *,
    pattern: str | None = None,
    line_range: tuple[int, int] | None = None,
    context_lines: int = 5,
    max_chars: int = 10_000,
) -> str:
    """Search offloaded text content by pattern or line range.

    Args:
        text: The full text content to search.
        pattern: Regex or keyword to grep for.
        line_range: Tuple of (start, end) 1-indexed inclusive line numbers.
        context_lines: Lines before and after each match.
        max_chars: Maximum output size in characters; results are truncated beyond this.

    Returns:
        Formatted search results with line numbers, or a message reporting empty content or no matches.

    Raises:
        ValueError: If line_range is not a 1-indexed, non-empty range within the content.
    """
    lines = text.split("\n")
    total_lines = len(lines)

    if total_lines == 0 or (total_lines == 1 and lines[0] == ""):
        return "Content is empty (0 lines)."

    scope_start = 0
    scope_end = total_lines - 1

    if line_range is not None:
        start, end = line_range
        if start < 1:
            raise ValueError(f"line_range.start ({start}) must be >= 1.")
        if start > end:
            raise ValueError(f"line_range.start ({start}) must be <= line_range.end ({end}).")
        if start > total_lines:
            raise ValueError(f"line_range.start ({start}) is beyond content length ({total_lines} lines).")
        scope_start = start - 1
        scope_end = min(end - 1, total_lines - 1)

    context_lines = max(0, context_lines)

    if pattern:
        scope_label = f" in lines {line_range[0]}-{scope_end + 1}" if line_range else ""
        return _search_by_pattern(lines, pattern, scope_start, scope_end, context_lines, max_chars, scope_label)

    return _search_by_line_range(lines, scope_start, scope_end, total_lines, max_chars)


def _truncate(output: str, max_chars: int, message: str) -> str:
    """Cut output at the last newline before max_chars and append a truncation message.

    When the first matched line (``>`` prefix) within the budget begins after that newline, cut at
    ``max_chars`` instead so the matched line stays visible.
    """
    if len(output) <= max_chars:
        return output

    cut = output.rfind("\n", 0, max_chars)
    first_match = _MATCH_LINE.search(output, 0, max_chars)
    drops_first_match = first_match is not None and first_match.start() > cut
    slice_end = cut if cut > 0 and not drops_first_match else max_chars

    return output[:slice_end] + f"\n\n[{message}]"


def _clip_to_match(line: str, match: re.Match[str], width: int) -> str:
    """Clip a line to a ``width``-char window centered on ``match``, marking cut ends with ``…``.

    A match wider than the window (e.g. ``ERROR.*``) shows its head and tail rather than its middle.
    """
    if match.end() - match.start() > width:
        half = width // 2
        head = line[match.start() : match.start() + half]
        tail = line[match.end() - half : match.end()]
        return ("…" if match.start() > 0 else "") + head + "…" + tail + ("…" if match.end() < len(line) else "")
    center = (match.start() + match.end()) // 2
    start = min(max(0, center - width // 2), len(line) - width)
    end = start + width
    return ("…" if start > 0 else "") + line[start:end] + ("…" if end < len(line) else "")


def _format_lines(lines: list[str], indices: list[int], matched_set: set[int]) -> str:
    """Format line indices with line numbers, > prefixes for matches, and --- separators."""
    if not indices:
        return ""
    pad_width = len(str(indices[-1] + 1))
    output: list[str] = []
    for i, idx in enumerate(indices):
        if i > 0 and idx > indices[i - 1] + 1:
            output.append("---")
        line_num = str(idx + 1).rjust(pad_width)
        prefix = ">" if idx in matched_set else " "
        output.append(f"{prefix} {line_num}| {lines[idx]}")
    return "\n".join(output)


def _search_by_pattern(
    lines: list[str],
    pattern: str,
    scope_start: int,
    scope_end: int,
    context_lines: int,
    max_chars: int,
    scope_label: str,
) -> str:
    """Find lines matching a pattern, expand with context, and format with truncation."""
    safe_input = pattern[:_MAX_PATTERN_LENGTH] if len(pattern) > _MAX_PATTERN_LENGTH else pattern

    try:
        if _NESTED_QUANTIFIER.search(safe_input):
            raise re.error("nested quantifier")
        regex = re.compile(safe_input)
    except re.error:
        regex = re.compile(re.escape(safe_input))

    matches: dict[int, re.Match[str]] = {}
    for i in range(scope_start, scope_end + 1):
        if match := regex.search(lines[i]):
            matches[i] = match

    if not matches:
        return f"No matches found for pattern '{pattern}'{scope_label} (searched {scope_end - scope_start + 1} lines)."

    matched_set = set(matches)
    visible: set[int] = set()
    for idx in matched_set:
        for i in range(max(scope_start, idx - context_lines), min(scope_end, idx + context_lines) + 1):
            visible.add(i)

    safe_pattern = re.sub(r"[\n\r/\]]", " ", pattern)[:50]
    header = f"[{len(matched_set)} match{'es' if len(matched_set) > 1 else ''} for /{safe_pattern}/{scope_label}]"
    # A matched line longer than the budget would be cut at its start, hiding the match; show a window around the
    # match instead. Half the budget leaves room for the line prefix and preceding context lines.
    display = list(lines)
    for idx, match in matches.items():
        if len(lines[idx]) > max_chars:
            display[idx] = _clip_to_match(lines[idx], match, max_chars // 2)
    body = _format_lines(display, sorted(visible), matched_set)
    truncated_body = _truncate(body, max_chars, "output truncated, narrow your search")
    return f"{header}\n\n{truncated_body}"


def _search_by_line_range(lines: list[str], start: int, end: int, total_lines: int, max_chars: int) -> str:
    """Format a contiguous range of lines with truncation."""
    indices = list(range(start, end + 1))
    header = f"[Lines {start + 1}-{end + 1} of {total_lines}]"
    body = _format_lines(lines, indices, set())
    truncated_body = _truncate(body, max_chars, "output truncated, narrow your range")
    return f"{header}\n\n{truncated_body}"
