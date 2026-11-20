"""Web fetch tool: fetch a URL and return relevant content about it.

Provides :func:`make_web_fetch` and the default :data:`web_fetch` instance.
The factory's ``mode`` parameter selects the extraction strategy at
construction time:

* ``agentic`` (default): HTML is converted to markdown and passed to an analyst
  agent that answers ``prompt``, keeping the page out of the main agent's
  context. An empty ``prompt`` returns the converted page instead.
* ``markdown``: HTML is converted to clean markdown with scripts, styles, and
  noise stripped. Use when the agent needs full pages for reasoning.

The factory's ``sandbox`` parameter selects where the HTTP request runs:

* ``False`` (default): from the agent process, through the ``httpx.AsyncClient``
  provided by the operator, giving full control over transport configuration,
  caching, proxies, redirects, and connection pooling.
* ``True``: as ``curl`` through the host agent's sandbox, so the request is
  confined only as far as that sandbox is.
* A ``Sandbox`` instance: as ``curl`` through that sandbox, as ``make_shell`` binds one.
"""

from __future__ import annotations

import asyncio
import base64
import re
import shlex
import threading
import weakref
from collections.abc import Awaitable
from typing import TYPE_CHECKING, Literal

import httpx

from ...agent.invocation_context import _create_auxiliary_invocation_context
from ...sandbox.base import Sandbox
from ...sandbox.errors import SandboxTimeoutError
from ...tools.decorator import tool
from ...types.tools import ToolContext
from .types import WEB_FETCH_DESCRIPTION_AGENTIC, WEB_FETCH_DESCRIPTION_MARKDOWN


class WebFetchError(ValueError):
    """Raised when a web fetch request fails."""


if TYPE_CHECKING:
    from ...models.model import Model
    from ...sandbox.types import ExecutionResult
    from ...tools.decorator import DecoratedFunctionTool

_HEADERS = {
    "User-Agent": "strands-agents-web-fetch/1.0",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
}

_DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MiB
_DEFAULT_MAX_CONTENT_CHARS = 50_000
_TIMEOUT_SECONDS = 30

# The characters RFC 3986 allows in a URL; anything else is rejected before the URL reaches a shell.
_URL_CHARS = re.compile(r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")
# Characters httpx leaves as they are after the host; percent-encoded so the direct path's URLs pass ``_URL_CHARS``.
_QUERY_UNSAFE = re.compile(r"[|^`{}\\]")
_SCHEME_AND_HOST = re.compile(r"^((?:[^/?#]*//[^/?#]*)?)")
# PowerShell prints its edition (Desktop or Core); sh expands the unset variable to an empty line.
_SHELL_PROBE = 'echo "${PSEdition}"'
# Keyed by ``id`` so unhashable and value-equal sandboxes each get their own entry.
_shells: dict[int, Literal["sh", "powershell"]] = {}
_SANDBOX_NEEDS = "the sandbox option needs curl, head and base64 in a POSIX sandbox, or curl.exe under PowerShell"
# Room for the content type and exit status that follow the body in the curl output.
_TRAILER_BYTES = 1024
_CURL_FILESIZE_EXCEEDED = 63
_CURL_TIMED_OUT = 28
_COMMAND_NOT_FOUND = 127
_CANCEL_POLL_SECONDS = 0.05

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
    sandbox: Sandbox | bool = False,
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
        client: Optional ``httpx.AsyncClient`` to use for requests. When
            provided, the tool uses it directly and will not close it.
            When ``None``, a new client is created per request with
            ``follow_redirects=True`` and the request is stopped after 30 seconds in total.
            Cannot be combined with ``sandbox``.
        model: Optional model for the analyst. Only used when ``mode='agentic'``.
            Resolution order: this ``model`` > ``agent.aux_model`` > ``agent.model`` of the host
            agent; ``WebFetchError`` if none is available.
        mode: Extraction mode. Defaults to ``agentic``.
        sandbox: When ``True``, the request runs as ``curl`` through the host agent's sandbox
            and is confined only as far as that sandbox is. A ``Sandbox`` instance is used
            in place of the agent's. Defaults to ``False``: the request
            is sent from the agent process.

    Returns:
        A decorated tool that fetches a URL and extracts content according to
        the configured mode:
        - ``agentic`` (default): HTML is converted to markdown and passed to an
          analyst agent that answers a ``prompt``, keeping the page out of
          the main agent's context. An empty ``prompt`` returns the converted
          page content instead.
        - ``markdown``: HTML converted to clean markdown; other content
          types returned as-is.
    """
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, (int, float)) or max_bytes <= 0 or max_bytes % 1:
        raise ValueError(f"max_bytes must be a positive integer, got {max_bytes!r}")
    if max_content_chars <= 0:
        raise ValueError(f"max_content_chars must be positive, got {max_content_chars}")
    if mode not in ("markdown", "agentic"):
        raise ValueError(f"mode must be 'markdown' or 'agentic', got {mode!r}")
    if not isinstance(sandbox, (bool, Sandbox)):
        raise ValueError(f"sandbox must be a bool or a Sandbox, got {type(sandbox).__name__}")
    if sandbox is not False and client is not None:
        raise ValueError("client cannot be combined with sandbox: drop client, or leave sandbox=False to use it")
    resolved_description = description or (
        WEB_FETCH_DESCRIPTION_MARKDOWN if mode == "markdown" else WEB_FETCH_DESCRIPTION_AGENTIC
    )
    max_bytes = int(max_bytes)
    analyst_model = model

    def fetch_content(url: str, tool_context: ToolContext | None) -> Awaitable[str]:
        return _fetch_content(
            url, tool_context, max_bytes=max_bytes, max_content_chars=max_content_chars, client=client, sandbox=sandbox
        )

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_markdown(
        url: str,
        tool_context: ToolContext | None = None,
    ) -> str:
        """Fetches an HTTP(S) URL and returns clean markdown.

        Raises ``WebFetchError`` if the request fails or times out.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            tool_context: Framework-injected. Not model-visible. Carries the
                agent so the tool can read its cancel signal.
        """
        return await fetch_content(url, tool_context)

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_agentic(
        url: str,
        prompt: str = "",
        tool_context: ToolContext | None = None,
    ) -> str:
        """Fetches an HTTP(S) URL and returns an analyst's answer about it, or the page content for an empty prompt.

        Raises ``WebFetchError`` if the request fails or times out.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            prompt: The question or instruction about the page content. Leave empty to get
                the page content itself instead of an answer.
            tool_context: Framework-injected. Not model-visible. Carries the
                agent so the tool can read its cancel signal.
        """
        if not prompt.strip():
            return await fetch_content(url, tool_context)

        # Local import to avoid circular dependency
        from ...agent.agent import Agent

        host_agent = tool_context.agent if tool_context else None
        host_model = getattr(host_agent, "aux_model", None) or getattr(host_agent, "model", None)
        effective_model = analyst_model or host_model
        if effective_model is None:
            raise WebFetchError(
                "web_fetch: agentic mode requires a model. "
                "Pass model= to make_web_fetch or call the tool from an agent."
            )

        content = await fetch_content(url, tool_context)

        # Fresh agent per call — no history from one fetch bleeds into the next.
        analyst = Agent(
            model=effective_model,
            system_prompt=_ANALYST_PROMPT,
            callback_handler=None,
        )
        invoke_prompt = f"URL: {url}\n\nRequest: {prompt}\n\n--- Content ---\n{content}"
        try:
            result = await analyst.invoke_async(
                invoke_prompt,
                cancel_signal=tool_context.cancel_signal if tool_context else None,
                invocation_context=_create_auxiliary_invocation_context(
                    tool_context.invocation_context if tool_context else None
                ),
            )
        except Exception as exc:
            raise WebFetchError(f"Web fetch analyst failed for {url}: {exc}") from exc
        return str(result)

    return web_fetch_tool_markdown if mode == "markdown" else web_fetch_tool_agentic


web_fetch = make_web_fetch()
"""Default web fetch tool (agentic mode)."""


# ---- Internals ----


async def _fetch_content(
    url: str,
    tool_context: ToolContext | None,
    *,
    max_bytes: int,
    max_content_chars: int,
    client: httpx.AsyncClient | None,
    sandbox: Sandbox | bool,
) -> str:
    """Fetch ``url`` and return its content: markup as markdown, cut to ``max_content_chars``."""
    cancel_signal = tool_context.cancel_signal if tool_context else None
    request = _fetch_once(
        url=url,
        max_bytes=max_bytes,
        client=client,
        cancel_signal=cancel_signal,
        # ``is``, not truthiness: a Sandbox subclass may define ``__len__`` or ``__bool__``.
        sandbox=_agent_sandbox(tool_context) if sandbox is True else None if sandbox is False else sandbox,
    )
    if client is None and sandbox is False:
        # httpx times each read, so the tool's own client also gets a total deadline; curl has --max-time.
        request = asyncio.wait_for(request, _TIMEOUT_SECONDS)
    try:
        content_type, raw = await _cancellable(request, cancel_signal)
    except (asyncio.TimeoutError, httpx.TimeoutException) as error:
        raise WebFetchError(f"Fetch timed out: {url!r}") from error
    is_markup = "html" in content_type.lower() or "xml" in content_type.lower()
    content = _html_to_markdown(raw) if is_markup else raw
    if len(content) > max_content_chars:
        content = content[:max_content_chars] + "\n\n[content truncated]"
    return content


async def _fetch_once(
    *,
    url: str,
    max_bytes: int,
    client: httpx.AsyncClient | None,
    cancel_signal: threading.Event | None,
    sandbox: Sandbox | None = None,
) -> tuple[str, str]:
    """Perform one HTTP GET, returning ``(content_type, body_text)``.

    The request runs as ``curl`` through ``sandbox`` when one is given, otherwise through ``client``.

    Raises:
        asyncio.CancelledError: When the agent cancel signal is set.
        WebFetchError: On timeout, transport failure, HTTP error status, or
            body exceeding ``max_bytes``.
    """
    if cancel_signal is not None and cancel_signal.is_set():
        raise asyncio.CancelledError("Web fetch tool request cancelled")

    if sandbox is not None:
        content_type, body = await _fetch_sandbox(sandbox, url, max_bytes, cancel_signal)
        return content_type, _decode(body, content_type)

    owns_client = client is None
    active_client = client if client is not None else httpx.AsyncClient(follow_redirects=True, timeout=_TIMEOUT_SECONDS)
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

    return content_type, _decode(body, content_type)


def _decode(body: bytes, content_type: str) -> str:
    """Decode ``body`` with the charset of ``content_type``, falling back to ``utf-8``."""
    try:
        return body.decode(_parse_charset(content_type), errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def _parse_charset(content_type: str) -> str:
    """Extract the charset from a Content-Type header, defaulting to ``utf-8``."""
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("charset="):
            value = part[8:].strip().strip("'\"")
            if value:
                return value
    return "utf-8"


def _html_to_markdown(html: str) -> str:
    # Imported on first conversion so the tool loads without the optional ``web-fetch`` extra.
    from ._extract import html_to_markdown

    return html_to_markdown(html)


def _agent_sandbox(tool_context: ToolContext | None) -> Sandbox:
    """Return the host agent's sandbox."""
    sandbox: Sandbox | None = getattr(getattr(tool_context, "agent", None), "sandbox", None)
    if sandbox is None:
        raise WebFetchError("web_fetch: sandbox=True requires a sandbox. Call the tool from an agent.")
    return sandbox


async def _fetch_sandbox(
    sandbox: Sandbox, url: str, max_bytes: int, cancel_signal: threading.Event | None
) -> tuple[str, bytes]:
    """Perform one HTTP GET as ``curl`` through ``sandbox``, returning ``(content_type, body)``.

    Raises the same errors as :func:`_fetch_once`.
    """
    try:
        # httpx percent-encodes spaces and non-ASCII characters, as it does for the request it sends itself.
        _, scheme_and_host, rest = _SCHEME_AND_HOST.split(str(httpx.URL(url.strip())), maxsplit=1)
        url = scheme_and_host + _QUERY_UNSAFE.sub(lambda match: f"%{ord(match.group()):02X}", rest)
    except (httpx.InvalidURL, ValueError) as error:
        raise WebFetchError(f"Fetch failed: {error}") from error
    if not _URL_CHARS.fullmatch(url):
        raise WebFetchError("Fetch failed: the URL may only contain the characters RFC 3986 allows.")
    if not re.match(r"https?://[^/?#]", url, re.IGNORECASE):
        raise WebFetchError(f"Fetch failed: only http and https URLs are supported, got {url!r}")

    # A body that fills ``limit`` bytes has pushed the trailer out, so it is over ``max_bytes``.
    limit = max_bytes + _TRAILER_BYTES
    try:
        build = _powershell_curl_command if await _shell_of(sandbox) == "powershell" else _curl_command
        result = await sandbox.execute(build(url, max_bytes, limit), timeout=_TIMEOUT_SECONDS + 5)
    except SandboxTimeoutError as error:
        raise WebFetchError(f"Fetch timed out: {url!r}") from error

    return _parse_curl_result(result, url, max_bytes, limit)


def _parse_curl_result(result: ExecutionResult, url: str, max_bytes: int, limit: int) -> tuple[str, bytes]:
    """Split the curl command's output into ``(content_type, body)``, raising ``WebFetchError`` if curl failed."""
    exit_code, body, content_type = result.exit_code, b"", b""
    if exit_code == 0:
        try:
            data = base64.b64decode("".join(result.stdout.split()))
            head, _, status = data.rpartition(b"\n")
            body, _, content_type = head.rpartition(b"\n")
            exit_code = _CURL_FILESIZE_EXCEEDED if len(data) >= limit else int(status)
        except ValueError as error:
            raise WebFetchError(f"Fetch failed: unexpected curl output from the sandbox. {_SANDBOX_NEEDS}") from error
    if exit_code == _CURL_FILESIZE_EXCEEDED or len(body) > max_bytes:
        raise WebFetchError(f"Response body exceeded {max_bytes} bytes. Refusing to buffer more.")
    if exit_code == _CURL_TIMED_OUT:
        raise WebFetchError(f"Fetch timed out: {url!r}")
    needs = f". {_SANDBOX_NEEDS}" if exit_code == _COMMAND_NOT_FOUND else ""
    if exit_code != 0:
        raise WebFetchError(f"Fetch failed: {result.stderr.strip() or f'curl exited with code {exit_code}'}{needs}")
    return content_type.decode("latin-1").strip(), body


async def _cancellable(request: Awaitable[tuple[str, str]], cancel_signal: threading.Event | None) -> tuple[str, str]:
    """Await ``request``, cancelling it when ``cancel_signal`` is set."""
    task = asyncio.ensure_future(request)
    try:
        while not (await asyncio.wait([task], timeout=_CANCEL_POLL_SECONDS))[0]:
            if cancel_signal is not None and cancel_signal.is_set():
                raise asyncio.CancelledError("Web fetch tool request cancelled")
        return task.result()
    finally:
        task.cancel()


async def _shell_of(sandbox: Sandbox) -> Literal["sh", "powershell"]:
    """Return the shell ``sandbox`` runs commands in, probing it the first time."""
    key = id(sandbox)
    if key not in _shells:
        result = await sandbox.execute(_SHELL_PROBE, timeout=_TIMEOUT_SECONDS)
        edition = result.stdout.strip()
        if result.exit_code != 0 or edition not in ("", "Desktop", "Core"):
            raise WebFetchError("Fetch failed: the sandbox option needs a POSIX shell or PowerShell in the sandbox")
        _shells[key] = "powershell" if edition else "sh"
        # The entry goes when the sandbox does, before its id can be reused.
        weakref.finalize(sandbox, _shells.pop, key, None)
    return _shells[key]


def _curl_command(url: str, max_bytes: int, limit: int) -> str:
    # stdout is base64 of the body, a newline, the content type, a newline, and curl's exit status. ``head`` stops
    # curl at ``limit`` bytes, which --max-filesize alone does not when the response has no Content-Length.
    return (
        f"{{ curl {_curl_args(max_bytes)} -w '\\n%{{content_type}}' -- {shlex.quote(url)}; "
        f"printf '\\n%s' \"$?\"; }} | head -c {limit} | base64"
    )


def _powershell_curl_command(url: str, max_bytes: int, limit: int) -> str:
    # Same stdout as ``_curl_command``. ``curl.exe`` because ``curl`` is an Invoke-WebRequest alias in Windows
    # PowerShell; .NET reads the raw bytes and writes errors, both of which PowerShell's own pipeline would re-encode.
    quoted_url = url.replace("'", "''")
    arguments = f'{_curl_args(max_bytes)} -w "\\n%{{content_type}}\\n0" -- "{quoted_url}"'
    return "\n".join(
        [
            "$status = 127",
            "try {",
            f"  $info = New-Object Diagnostics.ProcessStartInfo 'curl.exe', '{arguments}'",
            "  $info.UseShellExecute = $false",
            "  $info.RedirectStandardOutput = $true",
            "  $info.RedirectStandardError = $true",
            "  $process = [Diagnostics.Process]::Start($info)",
            "  $errors = $process.StandardError.ReadToEndAsync()",
            f"  $bytes = (New-Object IO.BinaryReader $process.StandardOutput.BaseStream).ReadBytes({limit})",
            f"  $full = $bytes.Length -ge {limit}",
            "  if ($full) { try { $process.Kill() } catch { } }",
            "  $process.WaitForExit()",
            "  $status = if ($full) { 0 } else { $process.ExitCode }",
            "  if ($status -eq 0) { [Convert]::ToBase64String($bytes) } "
            "else { [Console]::Error.Write($errors.Result) }",
            "} catch { if ($status -eq 0) { $status = 1 }; [Console]::Error.Write($_.Exception.Message) }",
            "exit $status",
        ]
    )


def _curl_args(max_bytes: int) -> str:
    # -q (first) ignores any .curlrc; -g keeps ``[]`` in the URL literal; --proto/--proto-redir keep the request and
    # every redirect on http(s). Double quotes mean the same to sh and to a Windows command line.
    return (
        f'-q -sSL -g --compressed --fail --proto "=http,https" --proto-redir "=http,https" '
        f"--max-time {_TIMEOUT_SECONDS} --max-filesize {max_bytes} "
        f'-A "{_HEADERS["User-Agent"]}" -H "Accept: {_HEADERS["Accept"]}"'
    )
