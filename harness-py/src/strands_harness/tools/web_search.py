"""web_search: search the web and return the top results as numbered sources.

On Bedrock models the tool is backed by Amazon Bedrock AgentCore's ``InvokeWebSearch`` API, in the
model's region and authorized by IAM. The opt-in Exa tool (``builtin_tools={"web_search": "exa"}``)
serves it on any model from Exa's hosted MCP server, a third party that receives the queries; the
keyless free tier covers getting started and ``EXA_API_KEY`` lifts the rate limit in place. On
OpenAI, Anthropic, Gemini and Mantle GPT models a plain ``True`` is a model flag instead and no tool
is built (see ``agent.py``). The tool/backend split keeps the model-facing contract fixed while the
search provider behind it can change.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any, TypedDict

import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from strands.models.bedrock import DEFAULT_BEDROCK_REGION
from strands.tools.decorator import tool
from strands.tools.mcp import MCPClient

logger = logging.getLogger(__name__)

_AGENTCORE_WEB_SEARCH_ID = "web-search.v1"
_EXA_MCP_URL = "https://mcp.exa.ai/mcp"
_EXA_TOOL = "web_search_exa"
_TIMEOUT = timedelta(seconds=30)
_MAX_RESULTS = 10
_SNIPPET_CHARS = 500
_UNAVAILABLE = " web_search is unavailable here; answer without it."


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


def _unavailable(state: dict[str, Any], reason: str) -> str:
    """Remember a permanent AgentCore failure (logged once) and return what the model is told."""
    if "unavailable" not in state:
        logger.warning("web_search: AgentCore web search is unavailable, so every search will fail: %s", reason)
        state["unavailable"] = reason + _UNAVAILABLE
    return str(state["unavailable"])


def _agentcore_backend(region: str | None = None, boto_session: boto3.Session | None = None) -> SearchBackend:
    """Search backend over Amazon Bedrock AgentCore's ``InvokeWebSearch`` API, authorized by IAM.

    ``region`` defaults the way ``BedrockModel`` resolves its own. A missing permission, missing
    credentials, or an unsupported region is permanent, so it is remembered (and logged once) and
    later calls fail without a request.
    """
    state: dict[str, Any] = {}  # the client is built on first search, so constructing a harness stays cheap

    def call(query: str, max_results: int) -> list[SearchResult]:
        if "unavailable" in state:
            raise WebSearchError(state["unavailable"])
        if "client" not in state:
            session = boto_session or boto3.Session()
            state["region"] = region or session.region_name or os.environ.get("AWS_REGION") or DEFAULT_BEDROCK_REGION
            state["client"] = session.client("bedrock-agentcore", region_name=state["region"])
        try:
            response = state["client"].invoke_web_search(
                webSearchId=_AGENTCORE_WEB_SEARCH_ID, searchQuery=query, maxResults=max_results
            )
        except NoCredentialsError as exc:
            reason = (
                f"{exc} (AgentCore web search is signed with AWS credentials; a Bedrock API key does not cover it)."
            )
            raise WebSearchError(_unavailable(state, reason)) from exc
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            # A modeled ResourceNotFoundException (e.g. an unknown webSearchId) is a 404 too; only the
            # unmodeled routing 404 means the region lacks the API.
            if status == 404 and code != "ResourceNotFoundException":
                reason = f"AgentCore web search is not available in {state['region']} ({exc})."
            elif code == "AccessDeniedException":
                resource = f"arn:aws:bedrock-agentcore:{state['region']}:aws:tool/{_AGENTCORE_WEB_SEARCH_ID}"
                reason = f"{exc} (the caller needs bedrock-agentcore:InvokeWebSearch on {resource})."
            else:
                raise
            raise WebSearchError(_unavailable(state, reason)) from exc
        return [
            {
                "title": result.get("title") or result.get("url", ""),
                "url": result.get("url", ""),
                "snippet": " ".join(result.get("text", "").split())[:_SNIPPET_CHARS],
            }
            for result in response.get("results", [])
        ]

    async def search(query: str, max_results: int) -> list[SearchResult]:
        return await asyncio.to_thread(call, query, max_results)

    return search


def make_agentcore_web_search(*, region: str | None = None, boto_session: boto3.Session | None = None) -> Any:
    """Build a ``web_search`` tool over Amazon Bedrock AgentCore web search.

    ``region`` defaults the way ``BedrockModel`` resolves its own (the session, then ``AWS_REGION``,
    then ``us-west-2``); ``boto_session`` (default: a new ``boto3.Session()``) supplies the credentials,
    which need ``bedrock-agentcore:InvokeWebSearch``.
    """
    return _search_tool(_agentcore_backend(region, boto_session))


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
