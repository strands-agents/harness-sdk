import re

from .doc_fetcher import Page

_WHITESPACE = re.compile(r"\s+")
_CODE_FENCE = re.compile(r"```.*?```", re.S)
_MD_HEADER = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)

SMALL_DOC_THRESHOLD = 8192  # bytes - docs under this return full content
_PARAGRAPH_MIN_CHARS = 120  # min chars before breaking a paragraph


def normalize(s: str) -> str:
    """Normalize whitespace in a string.

    Args:
        s: Input string to normalize

    Returns:
        String with collapsed whitespace and trimmed edges
    """
    return _WHITESPACE.sub(" ", s).strip()


def title_from_url(url: str) -> str:
    """Generate a human-readable title from a URL path.

    Args:
        url: URL to extract title from

    Returns:
        Formatted title derived from the URL path

    Note:
        Removes 'index.*' files, converts hyphens/underscores to spaces,
        and applies title case. Falls back to 'Documentation' if no path.
    """
    path = url.split("://", 1)[-1]
    parts = [p for p in path.split("/") if p]
    # remove trailing index.*
    if parts and parts[-1].startswith("index."):
        parts = parts[:-1]
    slug = parts[-1] if parts else path
    slug = slug.replace("-", " ").replace("_", " ").strip()
    return slug.title() or "Documentation"


def format_display_title(url: str, extracted: str | None, url_titles: dict[str, str]) -> str:
    """Determine the best display title for a document.

    Args:
        url: Document URL
        extracted: Title extracted from document content (if any)
        url_titles: Mapping of URLs to curated titles from llms.txt

    Returns:
        The best available title for display purposes

    Priority:
        1. Curated title from llms.txt (highest priority)
        2. URL-derived title if extracted title is missing/generic
        3. Normalized extracted title otherwise

    """
    # Fast path: check curated first (most common case)
    curated = url_titles.get(url)
    if curated:
        return normalize(curated)

    # No extracted title or it's generic - use URL slug
    if not extracted:
        return title_from_url(url)

    t = extracted.strip()
    if not t or t.lower() in {"index", "index.md"} or t.endswith(".md"):
        return title_from_url(url)
    return normalize(t)


def index_title_variants(display_title: str, url: str) -> str:
    """Generate searchable title variants for indexing.

    Args:
        display_title: The main display title
        url: Document URL for additional context

    Returns:
        Space-separated string of title variants for search indexing

    """
    base = display_title
    # hyphen/underscore variants from URL slug
    slug = title_from_url(url)

    # numeric-to-word '2' -> 'to' for cases like Agent2Agent
    variant = re.sub(r"(?i)(\w)2(\w)", r"\1 to \2", base)
    # collapse whitespace
    base = normalize(base)
    slug = normalize(slug)
    variant = normalize(variant)

    # Build a minimal distinct set: avoid obvious duplicates like "Agent Loop" twice
    variants = []
    for v in (base, variant, slug):
        if v and v.lower() not in {x.lower() for x in variants}:
            variants.append(v)

    return " ".join(variants)


def normalize_for_comparison(string: str) -> str:
    """Normalize string for case-insensitive comparison.

    Args:
        string: Input string to normalize

    Returns:
        Lowercase string with only alphanumeric characters and spaces

    Note:
        Removes punctuation and normalizes whitespace for reliable comparison.
    """
    string_lower = string.lower()
    processed_string = re.sub(r"[^a-z0-9 ]+", " ", string_lower)
    return _WHITESPACE.sub(" ", processed_string).strip()


def _truncate(text: str, max_chars: int) -> str:
    """Truncate text to max_chars, adding ellipsis if needed."""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "\u2026"


def make_snippet(page: Page | None, display_title: str, max_chars: int = 300) -> str:
    """Create a contextual snippet from page content.

    Args:
        page: Page object with content attribute (or None)
        display_title: Title to use as fallback
        max_chars: Maximum length of the snippet

    Returns:
        Contextual snippet text, truncated with ellipsis if needed

    """
    if not page or not page.content:
        return display_title

    text = page.content.strip()
    # Remove fenced code blocks
    text = _CODE_FENCE.sub("", text)

    lines = [line.strip() for line in text.splitlines() if line.strip()]

    # Drop a first line that looks like a title or a Markdown heading
    if lines:
        first = lines[0]
        if first.startswith("#"):
            lines = lines[1:]
        else:
            if normalize_for_comparison(first) == normalize_for_comparison(display_title) or normalize_for_comparison(
                first
            ).startswith(normalize_for_comparison(display_title)):
                lines = lines[1:]

    # Collect first meaningful paragraph: skip headings/TOC bullets
    paras: list[str] = []
    buf: list[str] = []

    def is_heading_or_toc(line: str) -> bool:
        """Check if a line is a heading or table of contents entry.

        Args:
            line: Text line to check

        Returns:
            True if line appears to be a heading or TOC entry
        """
        no_leading_space_line = line.lstrip()
        return (
            no_leading_space_line.startswith("#")  # Markdown headers
            or no_leading_space_line.startswith(("-", "*"))  # Bullet points
            or re.match(r"^\d+\.", no_leading_space_line) is not None  # Numbered lists
        )

    for line in lines:
        if is_heading_or_toc(line):
            if buf:
                break
            continue
        buf.append(line)
        # stop when we have a decent paragraph
        if len(" ".join(buf)) >= _PARAGRAPH_MIN_CHARS or line.endswith("."):
            paras.append(" ".join(buf))
            buf = []
            break

    if not paras and buf:
        paras.append(" ".join(buf))

    snippet = paras[0] if paras else display_title
    snippet = " ".join(snippet.split())
    return _truncate(snippet, max_chars)


def _code_fence_ranges(content: str) -> list[tuple[int, int]]:
    """Find all fenced code block ranges in content.

    Args:
        content: Raw markdown text

    Returns:
        List of (start, end) character offset tuples for code blocks
    """
    return [(m.start(), m.end()) for m in _CODE_FENCE.finditer(content)]


def _in_code_block(pos: int, ranges: list[tuple[int, int]]) -> bool:
    """Check if a character position falls inside a fenced code block.

    Args:
        pos: Character offset to check
        ranges: Code block ranges from _code_fence_ranges()

    Returns:
        True if the position is inside a code block
    """
    return any(start <= pos < end for start, end in ranges)


def extract_preamble(content: str) -> str:
    """Extract the preamble text before the first H2 section.

    The preamble is the introductory content at the top of a markdown document,
    after the title heading but before the first ## section. The H1 heading line
    itself is stripped (it is already available as the document title).

    If no H2 sections exist, the entire content (minus the H1 line) is returned.

    Args:
        content: Raw markdown text

    Returns:
        Preamble text with H1 line stripped, or empty string if no content exists
    """
    if not content:
        return ""

    fence_ranges = _code_fence_ranges(content)

    # Find first real ## header (not inside a code block)
    first_h2_pos = None
    for m in _MD_HEADER.finditer(content):
        level = len(m.group(1))
        if level == 2 and not _in_code_block(m.start(), fence_ranges):
            first_h2_pos = m.start()
            break

    # No H2 found - entire content after H1 is the preamble
    if first_h2_pos is None:
        preamble = content
    else:
        preamble = content[:first_h2_pos]

    # Strip the first H1 heading line (e.g., "# Page Title\n")
    preamble = re.sub(r"^#\s+[^\n]*\n?", "", preamble)

    return preamble.strip()


def parse_sections(content: str) -> list[dict]:
    """Parse markdown content into a hierarchical section tree.

    Splits content on ATX-style headers (# through ######).
    Skips headers inside fenced code blocks.
    Returns flat list of ## sections with children names.

    Args:
        content: Raw markdown text

    Returns:
        List of section dicts with id, level, title, summary, children, _start
    """
    if not content:
        return []

    fence_ranges = _code_fence_ranges(content)
    headers = []
    for m in _MD_HEADER.finditer(content):
        if not _in_code_block(m.start(), fence_ranges):
            headers.append((len(m.group(1)), m.group(2).strip(), m.start()))

    # Build tree: only ## sections are top-level
    sections: list[dict] = []
    h2_index = 0

    for i, (level, title, start) in enumerate(headers):
        if level != 2:
            continue

        h2_index += 1
        section_id = str(h2_index)

        # Find end: next header at level <= 2, or EOF
        end = len(content)
        for j in range(i + 1, len(headers)):
            if headers[j][0] <= 2:
                end = headers[j][2]
                break

        section_text = content[start:end]

        # Collect children (level > 2 within this section's range)
        children = []
        child_index = 0
        for j in range(i + 1, len(headers)):
            child_level, child_title, child_start = headers[j]
            if child_level <= 2:
                break
            child_index += 1
            children.append(
                {
                    "id": f"{section_id}.{child_index}",
                    "title": child_title,
                    "_start": child_start,
                    "_level": child_level,
                }
            )

        sections.append(
            {
                "id": section_id,
                "level": 2,
                "title": title,
                "summary": make_section_summary(section_text),
                "children": [{"id": c["id"], "title": c["title"]} for c in children],
                "_start": start,
                "_children_internal": children,
            }
        )

    return sections


def make_section_summary(section_text: str, max_chars: int = 200) -> str:
    """Create a summary from a markdown section's content.

    Extracts the first meaningful paragraph, skipping code blocks,
    heading lines, and bullet points.

    Args:
        section_text: Raw markdown text of the section (including header)
        max_chars: Maximum length of the summary

    Returns:
        Summary text, or "Contains: child1, child2, ..." fallback
    """
    # Strip fenced code blocks
    text = _CODE_FENCE.sub("", section_text)

    lines = [line.strip() for line in text.splitlines() if line.strip()]

    # Collect first meaningful paragraph
    buf: list[str] = []
    child_names: list[str] = []

    for line in lines:
        stripped = line.lstrip()
        # Skip heading lines
        if stripped.startswith("#"):
            if stripped.startswith("###"):
                # Track child header names for fallback
                child_names.append(stripped.lstrip("#").strip())
            continue
        # Skip bullets and numbered lists
        if stripped.startswith(("-", "*")) or re.match(r"^\d+\.", stripped):
            continue
        buf.append(line)
        if len(" ".join(buf)) >= _PARAGRAPH_MIN_CHARS or line.endswith("."):
            break

    if buf:
        summary = " ".join(buf)
        summary = " ".join(summary.split())
        return _truncate(summary, max_chars)

    # Fallback: no prose, just child headers
    if child_names:
        fallback = "Contains: " + ", ".join(child_names)
        return _truncate(fallback, max_chars)

    return ""


def extract_section(content: str, section_id: str, sections: list[dict]) -> dict | None:
    """Extract a section's full markdown content by dotted index.

    Args:
        content: Full document markdown
        section_id: Dotted index (e.g., "3" or "3.2")
        sections: Parsed section tree from parse_sections()

    Returns:
        Dict with section_id, section_title, content - or None if not found
    """
    if not section_id or not sections:
        return None

    # Parse and validate section ID parts
    parts = section_id.split(".")
    try:
        indices = [int(p) for p in parts]
    except ValueError:
        return None

    if any(idx < 1 for idx in indices):
        return None

    # Top-level section lookup
    top_idx = indices[0]
    if top_idx > len(sections):
        return None

    section = sections[top_idx - 1]

    if len(parts) == 1:
        # Return entire ## section including children
        start = section["_start"]
        # Find end: next ## section start, or EOF
        end = len(content)
        section_index = top_idx - 1
        if section_index + 1 < len(sections):
            end = sections[section_index + 1]["_start"]

        return {
            "section_id": section_id,
            "section_title": section["title"],
            "content": content[start:end].rstrip(),
        }

    if len(parts) == 2:
        child_idx = indices[1]
        children = section.get("_children_internal", [])
        if child_idx < 1 or child_idx > len(children):
            return None

        child = children[child_idx - 1]
        start = child["_start"]

        # Find end: next sibling at same-or-higher level, or parent section end
        end = len(content)
        section_index = top_idx - 1
        if section_index + 1 < len(sections):
            end = sections[section_index + 1]["_start"]

        for k in range(child_idx, len(children)):
            next_child = children[k]
            if next_child["_level"] <= child["_level"]:
                end = next_child["_start"]
                break

        return {
            "section_id": section_id,
            "section_title": child["title"],
            "content": content[start:end].rstrip(),
        }

    # 3+ nesting levels not supported
    return None
