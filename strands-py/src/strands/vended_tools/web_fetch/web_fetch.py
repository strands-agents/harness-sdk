"""Web fetch tool: fetch a URL and return relevant content about it.

Provides :func:`make_web_fetch` and the default :data:`web_fetch` instance.
The factory's ``mode`` parameter selects the extraction strategy at
construction time:

* ``agentic`` (default): HTML is converted to markdown and passed to an analyst
  agent that answers ``prompt``; the full page never enters the main agent's
  context.
* ``markdown``: HTML is converted to clean markdown with scripts, styles, and
  noise stripped. Use when the agent needs full pages for reasoning.

The tool routes all HTTP requests through the agent's sandbox by running
``curl``, keeping network access inside the sandbox boundary.
"""

from __future__ import annotations

import shlex
from typing import TYPE_CHECKING, Literal

from ...sandbox.errors import SandboxTimeoutError
from ...sandbox.types import ExecutionResult
from ...tools.decorator import tool
from ...types.tools import ToolContext
from ._extract import html_to_markdown
from .types import WEB_FETCH_DESCRIPTION_AGENTIC, WEB_FETCH_DESCRIPTION_MARKDOWN


class WebFetchError(ValueError):
    """Raised when a web fetch request fails."""


if TYPE_CHECKING:
    from ...models.model import Model
    from ...tools.decorator import DecoratedFunctionTool

_USER_AGENT = "strands-agents-web-fetch/1.0"

_DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MiB
_DEFAULT_MAX_CONTENT_CHARS = 50_000
_DEFAULT_TIMEOUT_SECONDS = 30

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
    timeout: float = _DEFAULT_TIMEOUT_SECONDS,
    model: Model | None = None,
    mode: Literal["markdown", "agentic"] = "agentic",
) -> DecoratedFunctionTool:
    """Create a web fetch tool.

    Args:
        name: Tool name. Defaults to ``"web_fetch"``.
        description: Tool description shown to the model. Defaults to a mode-appropriate
            description when ``None``.
        max_bytes: Maximum response body size in bytes. Responses larger than
            this are rejected. Defaults to 5 MiB.
        max_content_chars: Maximum characters of extracted content delivered to
            the model or analyst. Content exceeding this is truncated with a
            visible marker. Defaults to 50,000.
        timeout: Maximum time in seconds to wait for the curl request.
            Defaults to 30. Pass ``0`` to disable the timeout.
        model: Optional model for the analyst. Only used when ``mode='agentic'``.
            Resolution order: this model, then the host agent's model,
            then ``WebFetchError`` if neither is available.
        mode: Extraction mode. Defaults to ``agentic``.

    Returns:
        A decorated tool that fetches a URL via the agent's sandbox and
        extracts content according to the configured mode:

        - ``agentic`` (default): HTML is converted to markdown and passed to an
          analyst agent that answers a ``prompt``; the full page never enters
          the main agent's context.
        - ``markdown``: HTML converted to clean markdown; other content
          types returned as-is.

    Raises:
        ValueError: If ``max_bytes`` or ``max_content_chars`` is not positive,
            or ``mode`` is invalid.
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
    analyst_model = model

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_markdown(
        url: str,
        tool_context: ToolContext,
    ) -> str:
        """Fetches an HTTP(S) URL and returns clean markdown.

        Raises ``WebFetchError`` if the request fails or the size cap is exceeded.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            tool_context: Framework-injected. Not model-visible.
        """
        content_type, raw = await _fetch_once(url=url, max_bytes=max_bytes, timeout=timeout, tool_context=tool_context)

        is_markup = "html" in content_type.lower() or "xml" in content_type.lower()
        content = html_to_markdown(raw) if is_markup else raw
        if len(content) > max_content_chars:
            content = content[:max_content_chars] + "\n\n[content truncated]"
        return content

    @tool(name=name, description=resolved_description, context=True)
    async def web_fetch_tool_agentic(
        url: str,
        prompt: str,
        tool_context: ToolContext,
    ) -> str:
        """Fetches an HTTP(S) URL and returns an analyst's answer about it.

        Raises ``WebFetchError`` if the request fails or the size cap is exceeded.

        Args:
            url: The URL to fetch. Must be ``http://`` or ``https://``.
            prompt: The question or instruction about the page content.
            tool_context: Framework-injected. Not model-visible.
        """
        # Local import to avoid circular dependency
        from ...agent.agent import Agent

        if not prompt.strip():
            raise WebFetchError("web_fetch: agentic mode requires a non-empty prompt.")

        host_model = getattr(tool_context.agent, "model", None)
        effective_model = analyst_model or host_model
        if effective_model is None:
            raise WebFetchError(
                "web_fetch: agentic mode requires a model. "
                "Pass model= to make_web_fetch or call the tool from an agent."
            )

        content_type, raw = await _fetch_once(url=url, max_bytes=max_bytes, timeout=timeout, tool_context=tool_context)

        # Fresh agent per call — no history from one fetch bleeds into the next.
        analyst = Agent(
            model=effective_model,
            system_prompt=_ANALYST_PROMPT,
            callback_handler=None,
        )
        is_markup = "html" in content_type.lower() or "xml" in content_type.lower()
        content = html_to_markdown(raw) if is_markup else raw
        if len(content) > max_content_chars:
            content = content[:max_content_chars] + "\n\n[content truncated]"
        invoke_prompt = f"URL: {url}\n\nRequest: {prompt}\n\n--- Content ---\n{content}"
        try:
            result = await analyst.invoke_async(invoke_prompt, cancel_signal=tool_context.cancel_signal)
        except Exception as exc:
            raise WebFetchError(f"Web fetch analyst failed for {url}: {exc}") from exc
        return str(result)

    return web_fetch_tool_markdown if mode == "markdown" else web_fetch_tool_agentic


web_fetch = make_web_fetch()
"""Default web fetch tool (agentic mode)."""


# ---- Internals ----


async def _fetch_once(
    *,
    url: str,
    max_bytes: int,
    timeout: float,
    tool_context: ToolContext,
) -> tuple[str, str]:
    """Perform one HTTP GET, returning ``(content_type, body_text)``.

    Raises:
        WebFetchError: On transport failure, HTTP error status, or body exceeding
            ``max_bytes``.
        SandboxTimeoutError: When the sandbox execution times out.
    """
    if not url.startswith("http://") and not url.startswith("https://"):
        raise WebFetchError(f"url=<{url}> | fetch failed: only http and https URLs are supported")

    # --max-filesize exits 63 when Content-Length exceeds the cap.
    # --write-out writes the final-hop content-type to stderr, separate from the content.
    command = (
        f"curl -sSLg --fail-with-body --max-filesize {max_bytes} -A {shlex.quote(_USER_AGENT)}"
        f" --write-out {shlex.quote('%{stderr}%{content_type}')} {shlex.quote(url)}"
    )

    effective_timeout = timeout if timeout > 0 else None
    try:
        result: ExecutionResult = await tool_context.agent.sandbox.execute(command, timeout=effective_timeout)
    except SandboxTimeoutError:
        raise
    except Exception as exc:
        raise WebFetchError(f"url=<{url}> | fetch failed: {exc}") from exc

    # Length check covers chunked responses.
    if result.exit_code == 63 or len(result.stdout) > max_bytes:
        raise WebFetchError(f"Response body exceeded {max_bytes} bytes. Refusing to buffer more.")

    if result.exit_code != 0:
        first_line = result.stderr.split("\n")[0].strip()
        detail = first_line or f"curl exited with code {result.exit_code}"
        raise WebFetchError(f"url=<{url}> | fetch failed: {detail}")

    # On success, stderr contains only the content-type written by --write-out.
    content_type = result.stderr.strip()

    return content_type, result.stdout
