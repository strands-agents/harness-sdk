"""HTML → markdown extraction for the web fetch tool.

Converts fetched HTML into markdown suitable for a model to read. Non-content
elements are removed and ``data:`` URI images are replaced with their alt text
so large inline blobs do not bloat the output. Images with a ``javascript:`` or
``vbscript:`` source are dropped, and links with a ``javascript:``,
``vbscript:``, or ``data:`` href are reduced to their text. The page title,
image alt text, link and image titles and URLs, and link, image, code and
block syntax in body text are escaped so they cannot change the structure of
the output. The page title is prepended.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from urllib.parse import quote, urlparse

try:
    from bs4 import BeautifulSoup, NavigableString, PageElement, Tag
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


# A block marker at the start of a line: what turndown escapes at the start of text, "1)", and "~" or "~~" ending its
# line. It is escaped whether a space or the end of the line follows. Whitespace before it is stripped or indentation.
_BLOCK_MARKER = re.compile(
    r"^([^\S\n]*)(?=[-=>]|~~~|~{1,2}\s*$|(?:\+|#{1,6}|[0-9]+[.)])(?: |\s*$))([0-9]*)", re.MULTILINE
)


def _escape_text(text: str) -> str:
    """Collapse whitespace and control characters, and escape markdown and HTML syntax, so the text is plain text."""
    text = re.sub(r"[\\\[\]`~]", r"\\\g<0>", re.sub(rf"[{_WHITESPACE_OR_CONTROL}]+", " ", text))
    # A "(" can only open a link destination after a "]", so it is escaped only there.
    text = re.sub(r"(\\\] ?)\(", r"\1\\(", text)
    return text.replace("<", "&lt;").replace(">", "&gt;")


def _escape_alt_text(text: str) -> str:
    """Escape image alt text, which can directly follow a "![" or a "]": a "^" or "(" at its start is escaped too."""
    return re.sub(r"^(?=\^)|^ ?(?=\()", r"\g<0>\\", _escape_text(text))


def _escape_bare_alt_text(text: str) -> str:
    """Escape image alt text written bare: a block marker at its start, and a final "!" so a link is not an image."""
    return _BLOCK_MARKER.sub(r"\g<0>\\", re.sub(r"!(?= ?$)", r"\\!", text))


def _escape_url(url: str) -> str:
    """Drop tabs and newlines as URL parsers do, and percent-encode what a markdown parser could read as syntax."""
    url = re.sub(r"[\t\n\r]", "", url)
    # URL parsers read "\" as "/" before the query of a relative URL and of an http(s), ftp, ws(s) or file URL.
    if re.match(r"(?:https?|ftp|wss?|file):|(?![a-z][a-z0-9+.-]*:)", url, re.IGNORECASE | re.ASCII):
        url = re.sub(r"^[^?#]*", lambda match: match[0].replace("\\", "/"), url)
    return re.sub(rf"[{_WHITESPACE_OR_CONTROL}()<>\\\"'`]", lambda match: quote(match[0], safe=""), url)


# Elements whose content markdownify starts on a new line. A table row starts with "|".
_BLOCK_ELEMENTS = frozenset(
    "article blockquote caption dd div dl dt figcaption h1 h2 h3 h4 h5 h6 li ol p pre section table tbody tfoot thead"
    " tr ul".split()
)


class _EscapedText(NavigableString):
    """Text in the tree that is already escaped."""


class _Converter(MarkdownConverter):
    """MarkdownConverter that escapes markdown syntax in text and a trailing "!" in an image written as its alt text."""

    # Whether output precedes the next text on its line.
    _in_line = False

    def process_element(self, node: PageElement, parent_tags: set[str] | None = None) -> str:
        if isinstance(node, Tag) and node.name in _BLOCK_ELEMENTS:
            self._in_line = node.name == "tr"
        markdown = str(super().process_element(node, parent_tags))  # type: ignore[misc]
        last_line = markdown.rpartition("\n")[2]
        if last_line.strip() or last_line != markdown:
            self._in_line = bool(last_line.strip())
        return markdown

    def process_text(self, el: NavigableString, parent_tags: set[str] | None = None) -> str:
        parent_tags = parent_tags or set()
        if isinstance(el, _EscapedText):
            parent_tags = {*parent_tags, "_escaped"}
        text = str(super().process_text(el, parent_tags))  # type: ignore[misc]
        if parent_tags & {"_noformat", "_escaped"}:
            # A carriage return in code ends a line in markdown too.
            return re.sub(r"\r\n?", "\n", text)
        # The start of the text does not start a line when other output precedes it.
        return _BLOCK_MARKER.sub(
            lambda match: match[0] if self._in_line and match.start() == 0 else f"{match[0]}\\", text
        )

    def escape(self, text: str, parent_tags: set[str]) -> str:
        # markdownify escapes only "*" and "_".
        if "_escaped" not in parent_tags:
            text = re.sub(r"[\\\[\]`]", r"\\\g<0>", text)
            # Next to the "~~" that markdownify writes for <del> and <s>, a "~" would open a fence.
            if parent_tags & {"del", "s"}:
                text = text.replace("~", r"\~")
        return str(super().escape(text, parent_tags))  # type: ignore[misc]

    def convert_img(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        markdown = str(super().convert_img(el, text, parent_tags))  # type: ignore[misc]
        # Inside a heading or table cell markdownify writes only the alt text.
        return _escape_bare_alt_text(markdown) if "_inline" in parent_tags else markdown

    def convert_code(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        # A line that starts a block would end a code span, so the span is written on one line.
        if "_noformat" not in parent_tags:
            text = text.replace("\n", " ")
        return str(super().convert_code(el, text, parent_tags))  # type: ignore[misc]

    convert_kbd = convert_samp = convert_code

    def convert_pre(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        markdown = str(super().convert_pre(el, text, parent_tags))  # type: ignore[misc]
        runs = re.findall(r"`{3,}", text)
        if not runs:
            return markdown
        # Backticks in the code must not close the block, so the fence is longer than any run of them.
        fence = "`" * (len(max(runs, key=len)) + 1)
        head, _, tail = markdown.replace("```", fence, 1).rpartition("```")
        return f"{head}{fence}{tail}"


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
            image.replace_with(_EscapedText(_escape_bare_alt_text(alt)))
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
        _sanitize_tree(soup)
        title = ""
        for element in soup("title"):
            # A title is one line of plain text.
            text = _escape_text(element.get_text()).strip(" ")
            if title and text:
                # A later title, as in a feed, is a heading where it stands.
                heading = soup.new_tag("h1")
                heading.append(_EscapedText(text))
                element.replace_with(heading)
            else:
                # The first title starts the output. "*" and "_" are escaped as they are in body text.
                title = title or re.sub(r"[*_]", r"\\\g<0>", text)
                element.decompose()
        markdown = str(_Converter(heading_style="ATX", bullets="-", autolinks=False).convert_soup(soup)).strip()
        if title:
            markdown = f"# {title}\n\n{markdown}".strip()
    except (ValueError, RecursionError, ParserRejectedMarkup):
        logger.warning("html_to_markdown failed; returning raw html", exc_info=True)
        return html
    return markdown
