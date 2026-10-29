"""Web fetch tool: fetch a URL and return relevant content about it.

Provides :func:`make_web_fetch` and the default :data:`web_fetch` instance.
The factory's ``mode`` parameter selects the extraction strategy at
construction time:

* ``agentic`` (default): HTML is converted to markdown and passed to an analyst
  agent that answers ``prompt``; the full page never enters the main agent's
  context.
* ``markdown``: HTML is converted to clean markdown with scripts, styles, and
  noise stripped. Use when the agent needs full pages for reasoning.

The tool delegates all networking to the ``httpx.AsyncClient`` instance
provided by the operator, giving full control over transport configuration,
caching, proxies, redirects, and connection pooling.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import httpx

from ...agent.invocation_context import _create_auxiliary_invocation_context
from ...tools.decorator import tool
from ...types.tools import ToolContext
from ._extract import html_to_markdown
from .types import WEB_FETCH_DESCRIPTION_AGENTIC, WEB_FETCH_DESCRIPTION_MARKDOWN


class WebFetchError(ValueError):
    """Raised when a web fetch request fails."""


if TYPE_CHECKING:
    from ...models.model import Model
    from ...tools.decorator import DecoratedFunctionTool

_HEADERS = {
    "User-Agent": "strands-agents-web-fetch/1.0",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
}

_DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MiB
_DEFAULT_MAX_CONTENT_CHARS = 50_000

_ANALYST_PROMPT = (
    "You answer a request about a single fetched web page. Use only the provided "
    "content; if it does not contain the answer, say so plainly. Be concise and "
    "factual, and preserve concrete details (names, numbers, quotes, links) "
    "relevant to the request."
)


def make_web_fetch(
    *,
    name: str = "web_fetch",
    description: str | None = None,
    max_bytes: int = _DEFAULT_MAX_BYTES,
    max_content_chars: int = _DEFAULT_MAX_CONTENT_CHARS,
    client: httpx.AsyncClient | None = None,
    model: Model | None = None,
    mode: Literal["markdown", "agentic"] = "agentic",
) -> DecoratedFunctionTool:
    """Create a web fetch tool.

    Args:
        name: Tool name. Defaults to ``"web_fetch"``.
        description: Tool description shown to the model. Defaults to a mode-appropriate
            description when ``None``.
        max_bytes: Maximum response body size in bytes. Responses larger than
            this are rejected without buffering the entire body. Defaults to
            5 MiB.
        max_content_chars: Maximum characters of extracted content delivered to
            the model or analyst per call. Longer content is truncated with a
            marker that reports the total length and the ``offset`` to pass to
            read the next window. Defaults to 50,000.
        client: Optional ``httpx.AsyncClient`` to use for requests. When
            provided, the tool uses it directly and will not close it.
            When ``None``, a new client is created per request with
            ``follow_redirects=True`` and httpx's default timeout (5s).
        model: Optional model for the analyst. Only used when ``mode='agentic'``.
            Resolution order: this ``model`` > ``agent.aux_model`` > ``agent.model`` of the host
            agent; ``WebFetchError`` if none is available.
        mode: Extraction mode. Defaults to ``agentic``.

    Returns:
        A decorated tool that fetches a URL and extracts content according to
        the configured mode:
        - ``agentic`` (default): HTML is converted to markdown and passed to an
          analyst agent that answers a ``prompt``; the full page never enters
          the main agent's context.
        - ``markdown``: HTML converted to clean markdown; other content
          types returned as-is.
    """
    if max_bytes <= 0:
        raise ValueError(f"max_bytes must be positive, got {max_bytes}")
    if max_content_chars <= 0:
        raise ValueError(f"max_content_chars must be positive, got {max_content_chars}")
    if mode not in ("markdown", "agentic"):
        raise ValueError(f"mode must be 'markdown' or 'agentic', got {mode!r}")
    resolved_description = description or (
        WEB_FETCH_DESCRIPTION_MARKDOWN if mode == "markdown" else WEB_FETCH_DESCRIPTION_AGENTIC
    )
    external_client = client
    analyst_model = model

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_markdown(
        url: str,
        offset: int = 0,
        tool_context: ToolContext | None = None,
    ) -> str:
        """Fetches an HTTP(S) URL and returns clean markdown.

        Raises ``WebFetchError`` if the request fails, the client's timeout is exceeded,
        or ``offset`` is out of range.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            offset: Character offset into the extracted content to start from.
                Use the value given in a previous result's truncation marker to
                read the next part of a long page. Defaults to 0.
            tool_context: Framework-injected. Not model-visible. Carries the
                agent so the tool can read its cancel signal.
        """
        cancel_signal = tool_context.cancel_signal if tool_context else None
        content_type, raw = await _fetch_once(
            url=url,
            max_bytes=max_bytes,
            client=external_client,
            cancel_signal=cancel_signal,
        )

        window = _select_window(_extract_content(content_type, raw), offset, max_content_chars)
        return window.append_marker(window.text, with_hint=True)

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_agentic(
        url: str,
        prompt: str,
        offset: int = 0,
        tool_context: ToolContext | None = None,
    ) -> str:
        """Fetches an HTTP(S) URL and returns an analyst's answer about it.

        Raises ``WebFetchError`` if the request fails, the client's timeout is exceeded,
        or ``offset`` is out of range.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            prompt: The question or instruction about the page content.
            offset: Character offset into the extracted content to start from.
                Use the value given in a previous result's truncation marker to
                ask about the next part of a long page. Defaults to 0.
            tool_context: Framework-injected. Not model-visible. Carries the
                agent so the tool can read its cancel signal.
        """
        # Local import to avoid circular dependency
        from ...agent.agent import Agent

        if not prompt.strip():
            raise WebFetchError("web_fetch: agentic mode requires a non-empty prompt.")

        host_agent = tool_context.agent if tool_context else None
        host_model = getattr(host_agent, "aux_model", None) or getattr(host_agent, "model", None)
        effective_model = analyst_model or host_model
        if effective_model is None:
            raise WebFetchError(
                "web_fetch: agentic mode requires a model. "
                "Pass model= to make_web_fetch or call the tool from an agent."
            )

        cancel_signal = tool_context.cancel_signal if tool_context else None
        content_type, raw = await _fetch_once(
            url=url,
            max_bytes=max_bytes,
            client=external_client,
            cancel_signal=cancel_signal,
        )

        # Fresh agent per call — no history from one fetch bleeds into the next.
        analyst = Agent(
            model=effective_model,
            system_prompt=_ANALYST_PROMPT,
            callback_handler=None,
        )
        window = _select_window(_extract_content(content_type, raw), offset, max_content_chars)
        analyst_content = window.append_marker(window.text, with_hint=False)
        invoke_prompt = f"URL: {url}\n\nRequest: {prompt}\n\n--- Content ---\n{analyst_content}"
        try:
            result = await analyst.invoke_async(
                invoke_prompt,
                cancel_signal=cancel_signal,
                invocation_context=_create_auxiliary_invocation_context(
                    tool_context.invocation_context if tool_context else None
                ),
            )
        except Exception as exc:
            raise WebFetchError(f"Web fetch analyst failed for {url}: {exc}") from exc
        return window.append_marker(str(result), with_hint=True)

    return web_fetch_tool_markdown if mode == "markdown" else web_fetch_tool_agentic


web_fetch = make_web_fetch()
"""Default web fetch tool (agentic mode)."""


# ---- Internals ----


def _extract_content(content_type: str, raw: str) -> str:
    """Convert markup bodies to markdown; return other content types as-is."""
    is_markup = "html" in content_type.lower() or "xml" in content_type.lower()
    return html_to_markdown(raw) if is_markup else raw


@dataclass
class _ContentWindow:
    """The slice of extracted content delivered for one call, with its bounds."""

    text: str
    offset: int
    end: int
    total: int

    def append_marker(self, text: str, *, with_hint: bool) -> str:
        """Append a truncation marker to ``text`` unless the window is the whole content.

        The marker reports the window bounds and total length. With ``with_hint``
        it also tells the caller how to read the next window, or that this is the end.
        """
        if self.offset == 0 and self.end == self.total:
            return text
        marker = f"[content truncated: showing characters {self.offset}-{self.end} of {self.total}"
        if with_hint:
            hint = f"pass offset={self.end} to read the next window" if self.end < self.total else "end of content"
            marker += f"; {hint}"
        return f"{text}\n\n{marker}]"


def _select_window(content: str, offset: int, max_content_chars: int) -> _ContentWindow:
    """Return ``content[offset:offset + max_content_chars]`` with its bounds.

    Raises:
        WebFetchError: When ``offset`` is negative or past the end of the content.
    """
    total = len(content)
    if offset < 0:
        raise WebFetchError(f"offset must be non-negative, got {offset}")
    if offset > 0 and offset >= total:
        raise WebFetchError(
            f"offset {offset} is past the end of the content ({total} characters); "
            f"omit offset or pass a value below {total}"
        )
    end = min(offset + max_content_chars, total)
    return _ContentWindow(text=content[offset:end], offset=offset, end=end, total=total)


async def _fetch_once(
    *,
    url: str,
    max_bytes: int,
    client: httpx.AsyncClient | None,
    cancel_signal: threading.Event | None,
) -> tuple[str, str]:
    """Perform one HTTP GET, returning ``(content_type, body_text)``.

    Raises:
        asyncio.CancelledError: When the agent cancel signal is set.
        WebFetchError: On timeout, transport failure, HTTP error status, or
            body exceeding ``max_bytes``.
    """
    if cancel_signal is not None and cancel_signal.is_set():
        raise asyncio.CancelledError("Web fetch tool request cancelled")

    owns_client = client is None
    active_client = client if client is not None else httpx.AsyncClient(follow_redirects=True)
    try:
        try:
            request = active_client.build_request("GET", url, headers=_HEADERS)
            response = await active_client.send(request, stream=True)
        except httpx.TimeoutException as error:
            raise WebFetchError(f"Fetch timed out: {url!r}") from error
        except (httpx.InvalidURL, httpx.RequestError, ValueError) as exc:
            raise WebFetchError(f"Fetch failed: {exc}") from exc
        try:
            content_type = response.headers.get("content-type", "")
            if response.status_code >= 400:
                raise WebFetchError(f"HTTP {response.status_code} {response.reason_phrase}")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                if cancel_signal is not None and cancel_signal.is_set():
                    raise asyncio.CancelledError("Web fetch tool request cancelled")
                total += len(chunk)
                if total > max_bytes:
                    raise WebFetchError(f"Response body exceeded {max_bytes} bytes. Refusing to buffer more.")
                chunks.append(chunk)
            body = b"".join(chunks)
        finally:
            await response.aclose()
    finally:
        if owns_client:
            await active_client.aclose()

    charset = _parse_charset(content_type)
    try:
        raw = body.decode(charset, errors="replace")
    except LookupError:
        raw = body.decode("utf-8", errors="replace")

    return content_type, raw


def _parse_charset(content_type: str) -> str:
    """Extract the charset from a Content-Type header, defaulting to ``utf-8``."""
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("charset="):
            value = part[8:].strip().strip("'\"")
            if value:
                return value
    return "utf-8"
