"""Web fetch tool: fetch a URL and return relevant content about it.

Provides :func:`make_web_fetch` and the default :data:`web_fetch` instance.
The factory's ``mode`` parameter selects the extraction strategy at
construction time:

* ``agentic`` (default): HTML is converted to markdown and passed to an analyst
  agent that answers ``prompt``; the full page never enters the main agent's
  context.
* ``markdown``: HTML is converted to clean markdown with scripts, styles, and
  noise stripped. Use when the agent needs full pages for reasoning.

The ``client`` parameter selects how the HTTP request is made:

* ``"curl"`` (default): the request runs as ``curl`` inside the agent's
  :class:`~strands.sandbox.Sandbox`, so sandbox network-isolation and egress
  rules cover ``web_fetch`` automatically.
* An ``httpx.AsyncClient`` instance: the tool delegates all networking to that
  client, giving full control over transport configuration, caching, proxies,
  redirects, and connection pooling.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import shlex
import threading
import uuid
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlparse

import httpx

from ...tools.decorator import tool
from ...types.tools import ToolContext
from ._extract import html_to_markdown
from .types import WEB_FETCH_DESCRIPTION_AGENTIC, WEB_FETCH_DESCRIPTION_MARKDOWN


class WebFetchError(ValueError):
    """Raised when a web fetch request fails."""


if TYPE_CHECKING:
    from ...models.model import Model
    from ...sandbox import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_HEADERS = {
    "User-Agent": "strands-agents-web-fetch/1.0",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
}

_DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MiB
_DEFAULT_MAX_CONTENT_CHARS = 50_000
_CURL_TIMEOUT = 30
# The characters RFC 3986 allows anywhere in a URL; anything else is rejected before
# the URL reaches a shell command.  Security-critical for the curl transport.
_URL_CHARS = re.compile(r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")

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
    client: httpx.AsyncClient | Literal["curl"] = "curl",
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
            the model or analyst. Content exceeding this is truncated with a
            visible marker. Defaults to 50,000.
        client: HTTP transport to use. ``"curl"`` runs ``curl``
            inside the agent's :class:`~strands.sandbox.Sandbox`. Pass an
            ``httpx.AsyncClient`` to use a pre-configured HTTP client run
            on the host.
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
    if not isinstance(client, httpx.AsyncClient) and client != "curl":
        raise ValueError(f"client must be an httpx.AsyncClient or 'curl', got {client!r}")
    resolved_description = description or (
        WEB_FETCH_DESCRIPTION_MARKDOWN if mode == "markdown" else WEB_FETCH_DESCRIPTION_AGENTIC
    )
    external_client = client
    analyst_model = model

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_markdown(
        url: str,
        tool_context: ToolContext | None = None,
    ) -> str:
        """Fetches an HTTP(S) URL and returns clean markdown.

        Raises ``WebFetchError`` if the request fails or the client's timeout is exceeded.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            tool_context: Framework-injected. Not model-visible. Carries the
                agent so the tool can read its cancel signal.
        """
        return await _fetch_content(
            url=url,
            tool_context=tool_context,
            client=external_client,
            max_bytes=max_bytes,
            max_content_chars=max_content_chars,
        )

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_agentic(
        url: str,
        prompt: str,
        tool_context: ToolContext | None = None,
    ) -> str:
        """Fetches an HTTP(S) URL and returns an analyst's answer about it.

        Raises ``WebFetchError`` if the request fails or the client's timeout is exceeded.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            prompt: The question or instruction about the page content.
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
        content = await _fetch_content(
            url=url,
            tool_context=tool_context,
            client=external_client,
            max_bytes=max_bytes,
            max_content_chars=max_content_chars,
        )

        # Fresh agent per call — no history from one fetch bleeds into the next.
        analyst = Agent(
            model=effective_model,
            system_prompt=_ANALYST_PROMPT,
            callback_handler=None,
        )
        invoke_prompt = f"URL: {url}\n\nRequest: {prompt}\n\n--- Content ---\n{content}"
        try:
            result = await analyst.invoke_async(invoke_prompt, cancel_signal=cancel_signal)
        except Exception as exc:
            raise WebFetchError(f"Web fetch analyst failed for {url}: {exc}") from exc
        return str(result)

    return web_fetch_tool_markdown if mode == "markdown" else web_fetch_tool_agentic


web_fetch = make_web_fetch()
"""Default web fetch tool (agentic mode, curl transport)."""


# ---- Shared fetch + extract ----


async def _fetch_content(
    *,
    url: str,
    tool_context: ToolContext | None,
    client: httpx.AsyncClient | Literal["curl"],
    max_bytes: int,
    max_content_chars: int,
) -> str:
    """Fetch the url, convert markup to markdown, and truncate.

    Dispatches to :func:`_fetch_curl` (sandbox) or :func:`_fetch_direct`
    depending on client, then extracts readable content and enforces the
    character limit.
    """
    if isinstance(client, httpx.AsyncClient):
        cancel_signal = tool_context.cancel_signal if tool_context else None
        content_type, data = await _fetch_direct(
            url=url,
            max_bytes=max_bytes,
            client=client,
            cancel_signal=cancel_signal,
        )
    else:
        # curl transport — requires a sandbox on the host agent.
        sandbox = getattr(tool_context.agent, "sandbox", None) if tool_context else None
        if sandbox is None:
            raise WebFetchError(
                "web_fetch with client='curl' requires a sandbox. "
                "Call from an agent with a sandbox, or pass an httpx.AsyncClient."
            )
        content_type, data = await _fetch_curl(sandbox, url, max_bytes=max_bytes)

    charset = _parse_charset(content_type)
    try:
        raw = data.decode(charset, errors="replace")
    except LookupError:
        raw = data.decode("utf-8", errors="replace")

    is_markup = "html" in content_type.lower() or "xml" in content_type.lower()
    content = html_to_markdown(raw) if is_markup else raw
    if len(content) > max_content_chars:
        content = content[:max_content_chars] + "\n\n[content truncated]"
    return content


def _validate_url(url: str) -> str:
    """Return *url* stripped, or raise :class:`WebFetchError` for non-http(s) or shell-unsafe URLs.

    Only RFC 3986 characters are accepted so the URL is safe to embed in a
    ``curl`` shell command without injection risk.
    """
    url = url.strip()
    if not _URL_CHARS.fullmatch(url):
        raise WebFetchError(
            "web_fetch URLs may only contain the characters RFC 3986 allows; "
            "percent-encode spaces and non-ASCII characters (and punycode the host) and retry."
        )
    parts = urlparse(url)
    if parts.scheme not in ("http", "https"):
        raise WebFetchError(f"web_fetch only supports http(s) URLs, got {url!r}.")
    if not parts.hostname:
        raise WebFetchError(f"web_fetch URL has no host: {url!r}.")
    return url


def _curl_command(url: str, output: str, *, max_bytes: int) -> str:
    """Build a ``curl`` command line for fetching *url* into *output*.

    ``-g`` keeps ``{}``/``[]`` in the URL literal; ``--proto``/``--proto-redir``
    restrict both the initial request and any redirect to http(s); ``--fail``
    turns HTTP errors into a non-zero exit; ``-sS`` keeps curl's own error text
    on stderr.  The body goes to a file and is truncated before it is read back;
    stdout carries only the final hop's content-type and URL.
    """
    out = shlex.quote(output)
    part = shlex.quote(output + ".part")
    return (
        f"curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' "
        f"--max-time {_CURL_TIMEOUT} "
        f"-A {shlex.quote(_HEADERS['User-Agent'])} "
        f"-o {out} -w '%{{content_type}}\\n%{{url_effective}}' -- {shlex.quote(url)} "
        f"&& head -c {max_bytes} {out} > {part} && mv -f {part} {out}"
    )


async def _fetch_curl(
    sandbox: Sandbox,
    url: str,
    *,
    max_bytes: int,
) -> tuple[str, bytes]:
    """Fetch *url* with ``curl`` inside *sandbox*; returns ``(content_type, body_bytes)``.

    Raises:
        WebFetchError: On validation failure, non-zero curl exit, or read error.
    """
    url = _validate_url(url)
    output = f"/tmp/strands-web-fetch-{uuid.uuid4().hex}"
    try:
        result = await sandbox.execute(
            _curl_command(url, output, max_bytes=max_bytes),
            timeout=_CURL_TIMEOUT + 5,
        )
        if result.exit_code != 0:
            raise WebFetchError(result.stderr.strip() or f"curl exited with code {result.exit_code}")

        # The -w format writes content_type then url_effective, one per line.
        lines = result.stdout.splitlines()
        content_type = lines[-2].strip() if len(lines) >= 2 else ""

        data = await sandbox.read_file(output)
    finally:
        with contextlib.suppress(Exception):
            await sandbox.execute(
                f"rm -f {shlex.quote(output)} {shlex.quote(output + '.part')}",
                timeout=10,
            )

    return content_type, data


async def _fetch_direct(
    *,
    url: str,
    max_bytes: int,
    client: httpx.AsyncClient | None,
    cancel_signal: threading.Event | None,
) -> tuple[str, bytes]:
    """Perform one HTTP GET via httpx, returning ``(content_type, body_bytes)``.

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

    return content_type, body


def _parse_charset(content_type: str) -> str:
    """Extract the charset from a Content-Type header, defaulting to ``utf-8``."""
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("charset="):
            value = part[8:].strip().strip("'\"")
            if value:
                return value
    return "utf-8"
