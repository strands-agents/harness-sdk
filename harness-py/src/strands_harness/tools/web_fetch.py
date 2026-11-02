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
import base64
import re
import shlex
import time
import weakref
from typing import Any, Literal
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


def _curl_command(url: str) -> str:
    # -g keeps ``{}``/``[]`` in the URL literal; --proto/--proto-redir keep the request and any redirect on
    # http(s) (curl would otherwise follow a redirect to ftp://); --fail turns HTTP errors into a non-zero
    # exit; -sS keeps curl's own error text on stderr. The body is spooled to a file the shell picks with
    # mktemp (so the path only ever has to make sense inside the sandbox), truncated there, and returned over
    # stdout as base64: ASCII survives the chunked stdout decoding that raw bytes would not, and the charset is
    # applied once here. stdout is the final hop's content type and URL, then the base64 body.
    return (
        "f=$(mktemp -t strands-web-fetch.XXXXXX) && "
        f"curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time {_TIMEOUT} "
        f"-A {shlex.quote(_USER_AGENT)} -o \"$f\" -w '%{{content_type}}\\n%{{url_effective}}\\n' -- {shlex.quote(url)} "
        f'&& head -c {_MAX_BYTES} "$f" | base64; s=$?; rm -f "$f"; exit $s'
    )


def _powershell_curl_command(url: str) -> str:
    # The same contract for a sandbox whose shell is PowerShell (the local environment on Windows). ``curl.exe``
    # because plain ``curl`` is an Invoke-WebRequest alias there; the body is truncated and base64-encoded in
    # .NET. Errors are written through the console handle, not PowerShell's own error stream, which is
    # CLIXML-wrapped when stderr is a pipe; the ``try`` also turns a missing curl.exe into a plain exit 127.
    # ``-LiteralPath`` because ``%TEMP%`` may contain wildcard characters.
    quoted = "'" + url.replace("'", "''") + "'"
    return "\n".join(
        [
            '$f = Join-Path ([IO.Path]::GetTempPath()) "strands-web-fetch-$([guid]::NewGuid())"',
            "$s = 127",
            "try {",
            f"  curl.exe -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time {_TIMEOUT} "
            f"-A '{_USER_AGENT}' -o $f --stderr \"$f.err\" -w '%{{content_type}}\\n%{{url_effective}}\\n' {quoted}",
            "  $s = $LASTEXITCODE",
            "  if ($s -eq 0) {",
            "    $in = [IO.File]::OpenRead($f)",
            f"    try {{ $b = (New-Object IO.BinaryReader $in).ReadBytes([Math]::Min($in.Length, {_MAX_BYTES})) }}"
            " finally { $in.Dispose() }",
            "    [Convert]::ToBase64String($b)",
            '  } elseif (Test-Path -LiteralPath "$f.err") { [Console]::Error.Write([IO.File]::ReadAllText("$f.err")) }',
            "} catch { if ($s -eq 0) { $s = 1 }; [Console]::Error.Write($_.Exception.Message) }",
            'Remove-Item -Force -LiteralPath $f, "$f.err" -ErrorAction SilentlyContinue',
            "exit $s",
        ]
    )


# The Sandbox contract names no shell dialect, so the only check that holds for every sandbox is to ask: PowerShell
# prints its edition (``Desktop`` or ``Core``), ``sh`` expands the unset variable to an empty line.
_SHELL_PROBE = 'echo "${PSEdition}"'
_shells: weakref.WeakKeyDictionary[Sandbox, Literal["sh", "powershell"]] = weakref.WeakKeyDictionary()


async def _shell(sandbox: Sandbox) -> Literal["sh", "powershell"]:
    if sandbox not in _shells:
        result = await sandbox.execute(_SHELL_PROBE, timeout=10)
        _shells[sandbox] = "powershell" if result.stdout.strip() in ("Desktop", "Core") else "sh"
    return _shells[sandbox]


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
    command = _powershell_curl_command(url) if await _shell(sandbox) == "powershell" else _curl_command(url)
    result = await sandbox.execute(command, timeout=_TIMEOUT + 5)
    if result.exit_code != 0:
        raise RuntimeError(result.stderr.strip() or f"curl exited with code {result.exit_code}")
    # Two header lines (the content-type line is empty when the header is absent), then the base64 body,
    # which base64(1) may wrap; whitespace is not part of the encoding.
    content_type, resolved_url, *body = result.stdout.split("\n") + ["", ""]
    data = base64.b64decode(re.sub(r"\s+", "", "".join(body)))
    return _to_text(data, content_type.strip(), resolved_url.strip(), url)


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
