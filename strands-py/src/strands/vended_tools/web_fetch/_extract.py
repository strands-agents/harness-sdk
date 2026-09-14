"""HTML → markdown extraction for the web fetch tool.

Converts fetched HTML into markdown suitable for a model to read. Non-content
elements are removed and ``data:`` URI images are replaced with their alt text
so large inline blobs do not bloat the output. The page title is prepended.
"""

from __future__ import annotations

import logging
import unicodedata
from urllib.parse import urlparse

try:
    from bs4 import BeautifulSoup, Tag
    from bs4.exceptions import ParserRejectedMarkup
    from markdownify import MarkdownConverter
except ImportError as e:
    raise ImportError(
        "web_fetch requires the 'web-fetch' extra (markdownify, beautifulsoup4). "
        "Install with: pip install 'strands-agents[web-fetch]'"
    ) from e

logger = logging.getLogger(__name__)

_DROPPED_ELEMENTS = frozenset(
    [
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "canvas",
        "iframe",
        "object",
        "embed",
        "video",
        "audio",
        "form",
        "input",
        "button",
        "select",
        "textarea",
        "nav",
    ]
)


def _url_scheme(url: str) -> str:
    """Return the URL scheme, stripping leading invisible characters first."""
    for index, char in enumerate(url):
        if unicodedata.category(char) not in ("Cc", "Cf", "Zs"):
            return urlparse(url[index:]).scheme
    return ""


def _tag_attribute(tag: Tag, name: str) -> str:
    """Return ``tag[name]`` as a single string ("" if absent), joining multi-valued attributes."""
    value = tag.get(name)
    if isinstance(value, list):
        return " ".join(value)
    return value or ""


def _sanitize_tree(soup: BeautifulSoup) -> None:
    """Remove non-content elements and unsafe/oversized links and images in place."""
    for element in soup(_DROPPED_ELEMENTS):
        element.decompose()
    for image in soup.find_all("img"):
        scheme = _url_scheme(_tag_attribute(image, "src"))
        # data: URI blobs can be enormous, so replace them with their alt text.
        if scheme == "data":
            image.replace_with(_tag_attribute(image, "alt"))
        # javascript: sources are not useful to a model.
        elif scheme == "javascript":
            image.decompose()
    # Unwrap javascript: links to their text so the scheme never reaches output.
    for anchor in soup.find_all("a"):
        if _url_scheme(_tag_attribute(anchor, "href")) == "javascript":
            anchor.unwrap()


def html_to_markdown(html: str) -> str:
    """Convert HTML to markdown suitable for a model to read.

    The page title is prepended when present. Returns the original HTML
    rather than failing on a parser error.
    """
    try:
        soup = BeautifulSoup(html, "html.parser")
        title = soup.title.get_text(strip=True) if soup.title else ""
        if soup.head is not None:
            soup.head.decompose()
        _sanitize_tree(soup)
        markdown = str(MarkdownConverter(heading_style="ATX", bullets="-").convert_soup(soup)).strip()
        if title:
            markdown = f"# {title}\n\n{markdown}"
    except (ValueError, RecursionError, ParserRejectedMarkup):
        logger.warning("html_to_markdown failed; returning raw html", exc_info=True)
        return html
    return markdown
