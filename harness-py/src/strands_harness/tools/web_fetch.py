"""web_fetch: fetch a URL and answer a prompt about its content.

Fetches the URL, reduces it to text, and asks a small fast model to answer the prompt over that
content, returning the answer rather than the raw page so large payloads never reach the main
agent's context. The summarizer runs on the same provider as the main agent (see
``resolve_web_fetch_model`` in ``models.py``), so credentials always align.

By default the HTTP request runs as ``curl`` inside the agent's ``sandbox`` (the same seam ``shell``
and the file tools use), so a sandbox with network isolation or egress rules covers ``web_fetch``
too. ``transport="direct"`` opts back into a plain standard-library request from the harness process.
Candidate to port into the core SDK later; keep it minimal and SDK-idiomatic.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import shlex
import time
import uuid
from typing import Any
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from strands import Agent
from strands.models import Model
from strands.sandbox import Sandbox
from strands.tools.decorator import tool
from strands.types.tools import ToolContext

from strands_harness.types.agent import WebFetchTransport

_USER_AGENT = "strands-harness/1.0"
_TIMEOUT = 30
_MAX_BYTES = 5 * 1024 * 1024
_MAX_CHARS = 50_000
_CACHE_TTL_SECONDS = 15 * 60
# The characters RFC 3986 allows anywhere in a URL; anything else (whitespace, quotes, control
# characters, non-ASCII) is rejected before the URL reaches a shell or a socket.
_URL_CHARS = re.compile(r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")

_SUMMARIZER_PROMPT = (
    "You answer a request about a single fetched web page. Use only the provided content; if it "
    "does not contain the answer, say so plainly. Be concise and factual, and preserve concrete "
    "details (names, numbers, quotes, links) relevant to the request."
)


def _html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def _validate_url(url: str) -> str:
    """Return ``url`` stripped, or raise ``ValueError`` unless it is a well-formed http(s) URL."""
    url = url.strip()
    if not _URL_CHARS.fullmatch(url):
        raise ValueError(
            "web_fetch URLs may only contain the characters RFC 3986 allows; percent-encode spaces and non-ASCII "
            "characters (and punycode the host) and retry."
        )
    parts = urlparse(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"web_fetch only supports http(s) URLs, got {url!r}.")
    if not parts.hostname:
        raise ValueError(f"web_fetch URL has no host: {url!r}.")
    return url


def _curl_command(url: str, output: str) -> str:
    # -g keeps ``{}``/``[]`` in the URL literal; --proto/--proto-redir keep the request and any redirect on
    # http(s) (curl would otherwise follow a redirect to ftp://); --fail turns HTTP errors into a non-zero
    # exit; -sS keeps curl's own error text on stderr. The body goes to a file (stdout is decoded text,
    # which would lose the charset and split multi-byte characters) and is truncated in the sandbox before
    # it is read back; stdout carries only the final hop's content type and URL.
    out, part = shlex.quote(output), shlex.quote(output + ".part")
    return (
        f"curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time {_TIMEOUT} "
        f"-A {shlex.quote(_USER_AGENT)} -o {out} -w '%{{content_type}}\\n%{{url_effective}}' -- {shlex.quote(url)} "
        f"&& head -c {_MAX_BYTES} {out} > {part} && mv -f {part} {out}"
    )


def _decode(data: bytes, content_type: str) -> str:
    match = re.search(r"charset=[\"']?([\w.-]+)", content_type, re.IGNORECASE)
    try:
        return data.decode(match.group(1) if match else "utf-8", errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _to_text(data: bytes, content_type: str, resolved_url: str, url: str) -> tuple[str, str]:
    raw = _decode(data, content_type)
    text = _html_to_text(raw) if "html" in content_type.lower() else raw
    return resolved_url.strip() or url, text[:_MAX_CHARS]


async def _fetch_curl(sandbox: Sandbox, url: str) -> tuple[str, str]:
    """Fetch a validated ``url`` with ``curl`` inside ``sandbox``; raises ``RuntimeError`` when curl fails."""
    output = f"/tmp/strands-web-fetch-{uuid.uuid4().hex}"
    try:
        result = await sandbox.execute(_curl_command(url, output), timeout=_TIMEOUT + 5)
        if result.exit_code != 0:
            raise RuntimeError(result.stderr.strip() or f"curl exited with code {result.exit_code}")
        # The trailer is the last two lines; the content-type line is empty when the header is absent.
        lines = result.stdout.splitlines()
        content_type = lines[-2].strip() if len(lines) >= 2 else ""
        resolved_url = lines[-1].strip() if lines else ""
        data = await sandbox.read_file(output)
    finally:
        with contextlib.suppress(Exception):
            await sandbox.execute(f"rm -f {shlex.quote(output)} {shlex.quote(output + '.part')}", timeout=10)
    return _to_text(data, content_type, resolved_url, url)


class _HttpOnlyRedirects(HTTPRedirectHandler):
    """Redirect handler that holds every hop to the same URL rules as the original request (urllib's
    default would also follow a redirect to ``ftp://``)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        _validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch_direct_sync(url: str) -> tuple[str, str]:
    deadline = time.monotonic() + _TIMEOUT
    opener = build_opener(_HttpOnlyRedirects)
    with opener.open(Request(url, headers={"User-Agent": _USER_AGENT}), timeout=_TIMEOUT) as response:
        # ``timeout`` bounds each socket read; the deadline bounds the whole download.
        chunks: list[bytes] = []
        size = 0
        while size < _MAX_BYTES:
            chunk = response.read1(min(65536, _MAX_BYTES - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if time.monotonic() > deadline:
                raise TimeoutError(f"web_fetch gave up after {_TIMEOUT}s.")
        content_type = response.headers.get("Content-Type", "")
        resolved_url = response.geturl()
    return _to_text(b"".join(chunks), content_type, resolved_url, url)


async def _fetch_direct(url: str) -> tuple[str, str]:
    """Fetch a validated ``url`` from the harness process with the standard library (bypasses the sandbox)."""
    return await asyncio.to_thread(_fetch_direct_sync, url)


async def _fetch_text(sandbox: Sandbox, url: str, transport: WebFetchTransport) -> tuple[str, str]:
    """Fetch ``url`` over ``transport`` and reduce it to text. Returns ``(resolved_url, text)``; raises on failure."""
    url = _validate_url(url)
    if transport == "curl":
        return await _fetch_curl(sandbox, url)
    return await _fetch_direct(url)


def make_web_fetch(*, model: Model, transport: WebFetchTransport = "curl") -> Any:
    """Build a ``web_fetch`` tool whose summarizer answers over the fetched page using ``model``.

    ``transport`` is ``"curl"`` (run inside the agent's sandbox, the default) or ``"direct"`` (from the
    harness process).
    """
    if transport not in ("curl", "direct"):
        raise ValueError(f"web_fetch transport must be 'curl' or 'direct', got {transport!r}.")
    cache: dict[str, tuple[float, str, str]] = {}

    @tool(name="web_fetch", context="tool_context")
    async def web_fetch(url: str, tool_context: ToolContext, prompt: str = "") -> str:
        """Fetch a URL and answer a prompt about its content.

        Performs an HTTP GET, reduces the response to text, and asks a small fast model to answer
        the prompt using only that content, returning the answer rather than the raw page so large
        pages do not flood the conversation. Fetched content is cached for 15 minutes, so repeated
        fetches of the same URL are fast while each prompt is answered fresh.

        Args:
            url: The http(s) URL to fetch.
            tool_context: Injected by the framework. Not user-facing.
            prompt: What to extract from or answer about the fetched content. Leave empty to get
                the whole page content back verbatim instead of a model-generated answer.
        """
        cached = cache.get(url)
        if cached and cached[0] > time.monotonic():
            resolved_url, text = cached[1], cached[2]
        else:
            try:
                resolved_url, text = await _fetch_text(tool_context.agent.sandbox, url, transport)
            except Exception as exc:
                return f"Failed to fetch {url}: {exc}"
            cache[url] = (time.monotonic() + _CACHE_TTL_SECONDS, resolved_url, text)

        if not prompt.strip():
            return text

        summarizer = Agent(model=model, system_prompt=_SUMMARIZER_PROMPT, callback_handler=None)
        result = await summarizer.invoke_async(
            f"Fetched URL: {resolved_url}\n\nRequest: {prompt}\n\n--- Content ---\n{text}"
        )
        return str(result)

    return web_fetch
