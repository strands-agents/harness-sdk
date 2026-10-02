"""web_search: search the web and return the top results as numbered sources.

The opt-in hosted tools (``builtin_tools={"web_search": "exa" | "agentcore"}``), built whenever the
setting selects one; a plain ``True`` on OpenAI, Anthropic, Gemini and Mantle GPT models is a model
flag instead and this tool is not built (see ``agent.py``). ``"exa"`` is backed by Exa's hosted MCP
server, a third party that receives the queries; the keyless free tier covers getting started and
``EXA_API_KEY`` lifts the rate limit in place. ``"agentcore"`` is backed by AgentCore Web Search in
the caller's own AWS account, reached through an AgentCore Gateway. The tool/backend split keeps the
model-facing contract fixed while the search provider behind it can change.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any, TypedDict

from strands.tools.decorator import tool
from strands.tools.mcp import MCPClient

_EXA_MCP_URL = "https://mcp.exa.ai/mcp"
_EXA_TOOL = "web_search_exa"
_AGENTCORE_GATEWAY_ENV = "AGENTCORE_GATEWAY_ID"
_TIMEOUT = timedelta(seconds=30)
_MAX_RESULTS = 10
_SNIPPET_CHARS = 500


class SearchResult(TypedDict):
    title: str
    url: str
    snippet: str


SearchBackend = Callable[[str, int], Awaitable[list[SearchResult]]]


class WebSearchError(Exception):
    """A backend failure with a message the model can act on."""


def _parse_exa(text: str) -> list[SearchResult]:
    """Split Exa's ``---``-separated ``Title:/URL:/.../Highlights:`` blocks into results.

    Only a block that opens with a ``Title:`` line directly followed by a ``URL:`` line counts, so
    those words inside a page's highlighted text do not start a source (a highlight would also have
    to carry Exa's ``---`` separator to do that).
    """
    results: list[SearchResult] = []
    for block in re.split(r"(?m)^---\s*$", text):
        head = re.match(r"\s*Title: (.*)\r?\nURL: (\S+)", block)
        if not head:
            continue
        highlights = block.split("Highlights:", 1)[1] if "Highlights:" in block else ""
        snippet = re.sub(r"\s+", " ", highlights).strip()[:_SNIPPET_CHARS]
        results.append({"title": head.group(1).strip(), "url": head.group(2), "snippet": snippet})
    return results


def _exa_call(query: str, max_results: int, api_key: str | None) -> list[SearchResult]:
    """One ``web_search_exa`` call over the SDK's MCP client; the session lives only for this call."""
    client = MCPClient(url=_EXA_MCP_URL, headers={"x-api-key": api_key} if api_key else None)
    try:
        client.start()
    except Exception as exc:
        raise WebSearchError(f"could not reach Exa's MCP server at {_EXA_MCP_URL} ({exc})") from exc
    try:
        result = client.call_tool_sync(
            tool_use_id="web_search",
            name=_EXA_TOOL,
            arguments={"query": query, "numResults": max_results},
            read_timeout_seconds=_TIMEOUT,
        )
    finally:  # a teardown error must not discard a result already in hand
        with contextlib.suppress(Exception):
            client.stop(None, None, None)
    text = "\n".join(c["text"] for c in result["content"] if isinstance(c.get("text"), str))
    if result["status"] == "error":
        raise WebSearchError(text or "Exa reported an error")
    return _parse_exa(text)


def _exa_backend(api_key: str | None = None) -> SearchBackend:
    """Search backend over Exa's hosted MCP server; ``api_key`` defaults to ``EXA_API_KEY`` (read per call)."""

    async def search(query: str, max_results: int) -> list[SearchResult]:
        key = api_key if api_key is not None else os.environ.get("EXA_API_KEY")
        try:
            return await asyncio.to_thread(_exa_call, query, max_results, key)
        except Exception as exc:
            if key:
                raise
            # The SDK client hides the HTTP status, so a keyless 429 is not distinguishable here.
            raise WebSearchError(f"{exc} (Exa's keyless tier is rate limited; set EXA_API_KEY to lift it.)") from exc

    return search


def make_exa_web_search() -> Any:
    """Build a ``web_search`` tool over Exa's hosted search (``EXA_API_KEY`` lifts the keyless rate limit)."""
    return _search_tool(_exa_backend())


def _search_tool(backend: SearchBackend) -> Any:
    """Build a ``web_search`` tool that formats ``backend``'s results as a numbered ``Sources:`` list."""

    @tool(name="web_search")
    async def web_search(query: str, max_results: int = 5) -> str:
        """Search the web and return the top results as numbered sources with a short excerpt each.

        Args:
            query: What to search for. A descriptive sentence works better than bare keywords.
            max_results: How many results to return, 1-10.
        """
        try:
            results = await backend(query, max(1, min(max_results, _MAX_RESULTS)))
        except Exception as exc:  # any backend failure becomes text the model can act on
            return f"web_search failed: {str(exc) or type(exc).__name__}"
        if not results:
            return "No results."
        lines = ["Sources:"]
        for number, result in enumerate(results, 1):
            lines.append(f"{number}. {' '.join(result['title'].split())} — {result['url']}")
            if result["snippet"]:
                lines.append(f"   {' '.join(result['snippet'].split())}")
        return "\n".join(lines)

    return web_search


exa_web_search = make_exa_web_search()
"""The ``web_search`` tool served by Exa (``EXA_API_KEY`` is read per call)."""


def agentcore_gateway() -> str | None:
    """The configured AgentCore Gateway target (an ID or ARN), or ``None``; read per call."""
    return os.environ.get(_AGENTCORE_GATEWAY_ENV, "").strip() or None


def _agentcore_call(query: str, max_results: int, gateway: str) -> list[SearchResult]:
    """One AgentCore Web Search call through ``bedrock_agentcore``'s client; the client lives only for this call."""
    # The optional agentcore extra stays lazy, like the model providers in ``models.py``.
    from bedrock_agentcore.tools import WebSearchClient

    gateway_args = {"gateway_arn": gateway} if gateway.startswith("arn:") else {"gateway_id": gateway}
    try:
        client = WebSearchClient(timeout=_TIMEOUT.total_seconds(), **gateway_args)
    except Exception as exc:
        raise WebSearchError(f"could not set up the AgentCore Web Search client for {gateway} ({exc})") from exc
    try:
        response = client.search(query, max_results=max_results)
    finally:  # a teardown error must not discard a result already in hand
        with contextlib.suppress(Exception):
            client.close()
    # A result without a URL is nothing the model can follow, so it is dropped.
    return [
        {
            "title": " ".join((result.title or "").split()),
            "url": result.url or "",
            "snippet": re.sub(r"\s+", " ", result.text or "").strip()[:_SNIPPET_CHARS],
        }
        for result in response.results
        if result.url
    ]


def _agentcore_backend(gateway: str | None = None) -> SearchBackend:
    """Search backend over AgentCore Web Search; ``gateway`` (an ID or ARN) defaults to
    ``AGENTCORE_GATEWAY_ID`` (read per call)."""

    async def search(query: str, max_results: int) -> list[SearchResult]:
        target = gateway if gateway is not None else agentcore_gateway()
        if not target:
            raise WebSearchError(
                f"No AgentCore Gateway configured; set {_AGENTCORE_GATEWAY_ENV} to a gateway ID or ARN "
                "that has a web search connector."
            )
        return await asyncio.to_thread(_agentcore_call, query, max_results, target)

    return search


def make_agentcore_web_search() -> Any:
    """Build a ``web_search`` tool over AgentCore Web Search (``AGENTCORE_GATEWAY_ID`` picks the gateway)."""
    return _search_tool(_agentcore_backend())


agentcore_web_search = make_agentcore_web_search()
"""The ``web_search`` tool served by AgentCore (``AGENTCORE_GATEWAY_ID`` is read per call)."""
