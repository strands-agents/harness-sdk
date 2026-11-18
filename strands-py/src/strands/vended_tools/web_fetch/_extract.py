"""HTML → markdown extraction for the web fetch tool.

Converts fetched HTML into markdown suitable for a model to read. Non-content
elements are removed and ``data:`` URI images are replaced with their alt text
so large inline blobs do not bloat the output. Images with a ``javascript:`` or
``vbscript:`` source are dropped, and links with a ``javascript:``,
``vbscript:``, or ``data:`` href are reduced to their text. The page title,
image alt text, link and image titles and URLs, and link and image syntax in
body text are escaped so they cannot change the structure of the output. The
page title is prepended.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from urllib.parse import quote, urlparse

try:
    from bs4 import BeautifulSoup, NavigableString, Tag
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

_SCRIPT_SCHEMES = frozenset(["javascript", "vbscript"])

# Format characters (Cf) that the Unicode tables of Python 3.10 and 3.11 predate.
_NEWER_FORMAT_CHARACTERS = frozenset(map(chr, (0x0890, 0x0891, *range(0x13439, 0x13440))))

# What URL parsers strip from both ends of a URL. A bare str.strip() differs from JavaScript's trim().
_C0_CONTROL_OR_SPACE = "".join(map(chr, range(0x20 + 1)))

# Same set as JavaScript's [\s\p{Cc}]. On its own, \s differs between the two languages.
_WHITESPACE_OR_CONTROL = r"\s\x00-\x1f\x7f-\x9f\ufeff"


def _url_scheme(url: str) -> str:
    """Return the URL scheme, stripping leading whitespace and invisible characters first."""
    for index, char in enumerate(url):
        if char not in _NEWER_FORMAT_CHARACTERS and unicodedata.category(char) not in ("Cc", "Cf", "Zs", "Zl", "Zp"):
            # A scheme ends before the first "/". urlparse can raise on what follows (a malformed host).
            return urlparse(url[index:].partition("/")[0]).scheme
    return ""


def _tag_attribute(tag: Tag, name: str) -> str:
    """Return ``tag[name]`` as a single string ("" if absent), joining multi-valued attributes."""
    value = tag.get(name)
    if isinstance(value, list):
        return " ".join(value)
    return value or ""


def _escape_text(text: str) -> str:
    """Collapse whitespace and control characters, and escape markdown and HTML syntax, so the text is plain text."""
    text = re.sub(r"[\\\[\]`~]", r"\\\g<0>", re.sub(rf"[{_WHITESPACE_OR_CONTROL}]+", " ", text))
    # A "(" can only open a link destination after a "]", so it is escaped only there.
    text = re.sub(r"(\\\] ?)\(", r"\1\\(", text)
    return text.replace("<", "&lt;").replace(">", "&gt;")


def _escape_alt_text(text: str) -> str:
    """Escape image alt text, which can directly follow a "![" or a "]": a "^" or "(" at its start is escaped too."""
    return re.sub(r"^(?=\^)|^ ?(?=\()", r"\g<0>\\", _escape_text(text))


def _escape_trailing_bang(text: str) -> str:
    """Escape a final "!" in image alt text written bare, so a link that follows does not become an image."""
    return re.sub(r"!(?= ?$)", r"\\!", text)


def _escape_url(url: str) -> str:
    """Drop tabs and newlines as URL parsers do, and percent-encode what a markdown parser could read as syntax."""
    url = re.sub(r"[\t\n\r]", "", url)
    return re.sub(rf"[{_WHITESPACE_OR_CONTROL}()<>\\\"'`]", lambda match: quote(match[0], safe=""), url)


class _EscapedText(NavigableString):
    """Text in the tree that is already escaped."""


class _Converter(MarkdownConverter):
    """MarkdownConverter that escapes link syntax in text and a trailing "!" in an image written as its alt text."""

    def process_text(self, el: NavigableString, parent_tags: set[str] | None = None) -> str:
        if isinstance(el, _EscapedText):
            parent_tags = {*(parent_tags or ()), "_escaped"}
        return str(super().process_text(el, parent_tags))  # type: ignore[misc]

    def escape(self, text: str, parent_tags: set[str]) -> str:
        # markdownify escapes only "*" and "_".
        if "_escaped" not in parent_tags:
            text = re.sub(r"[\\\[\]]", r"\\\g<0>", text)
        return str(super().escape(text, parent_tags))  # type: ignore[misc]

    def convert_img(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        markdown = str(super().convert_img(el, text, parent_tags))  # type: ignore[misc]
        # Inside a heading or table cell markdownify writes only the alt text.
        return _escape_trailing_bang(markdown) if "_inline" in parent_tags else markdown


def _sanitize_tree(soup: BeautifulSoup) -> None:
    """Remove non-content elements and unsafe/oversized links and images in place."""
    for element in soup(_DROPPED_ELEMENTS):
        element.decompose()
    for image in soup.find_all("img"):
        alt = _escape_alt_text(_tag_attribute(image, "alt"))
        src = _tag_attribute(image, "src").strip(_C0_CONTROL_OR_SPACE)
        scheme = _url_scheme(src)
        # data: URI blobs can be enormous, so replace them with their alt text.
        if scheme == "data":
            image.replace_with(_EscapedText(_escape_trailing_bang(alt)))
        # Script sources are not useful to a model.
        elif scheme in _SCRIPT_SCHEMES:
            image.decompose()
        else:
            image["alt"] = alt
            image["src"] = _escape_url(src)
            # A title cannot follow an empty link destination.
            image["title"] = _escape_text(_tag_attribute(image, "title")) if src else ""
    # Unwrap script-scheme and data: links to their text so the scheme never reaches output.
    for anchor in soup.find_all("a"):
        href = _tag_attribute(anchor, "href").strip(_C0_CONTROL_OR_SPACE)
        scheme = _url_scheme(href)
        if scheme in _SCRIPT_SCHEMES or scheme == "data":
            anchor.unwrap()
        else:
            anchor["href"] = _escape_url(href)
            anchor["title"] = _escape_text(_tag_attribute(anchor, "title"))


def html_to_markdown(html: str) -> str:
    """Convert HTML to markdown suitable for a model to read.

    The page title is prepended when present. Returns the original HTML
    rather than failing on a parser error.
    """
    try:
        soup = BeautifulSoup(html, "html.parser")
        title = ""
        if soup.title:
            # The title is one line of plain text. "*" and "_" are escaped as they are in body text.
            title = re.sub(r"[*_]", r"\\\g<0>", _escape_text(soup.title.get_text())).strip(" ")
            soup.title.decompose()
        if soup.head is not None:
            soup.head.decompose()
        _sanitize_tree(soup)
        markdown = str(_Converter(heading_style="ATX", bullets="-", autolinks=False).convert_soup(soup)).strip()
        if title:
            markdown = f"# {title}\n\n{markdown}".strip()
    except (ValueError, RecursionError, ParserRejectedMarkup):
        logger.warning("html_to_markdown failed; returning raw html", exc_info=True)
        return html
    return markdown
