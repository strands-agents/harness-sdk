import pytest

from strands_harness.tools import web_search as web_search_module
from strands_harness.tools.web_search import _exa_backend as exa_backend
from strands_harness.tools.web_search import _search_tool as search_tool

EXA_TEXT = (
    "Title: Web Grounding - Amazon Nova\n"
    "URL: https://docs.aws.amazon.com/nova/web-grounding.html\n"
    "Published: N/A\n"
    "Author: N/A\n"
    "Highlights:\n"
    "# Web Grounding\n \n\nWeb Grounding enables Amazon Nova to search   the web.\n...\nMore text.\n"
    "\n---\n\n"
    "Title: Second result\n"
    "URL: https://example.com/second\n"
    "Published: 2026-01-01\n"
    "Highlights:\n"
    "Second highlight.\n"
)


def test_parse_exa_splits_blocks_and_collapses_highlights():
    results = web_search_module._parse_exa(EXA_TEXT)
    assert results == [
        {
            "title": "Web Grounding - Amazon Nova",
            "url": "https://docs.aws.amazon.com/nova/web-grounding.html",
            "snippet": "# Web Grounding Web Grounding enables Amazon Nova to search the web. ... More text.",
        },
        {"title": "Second result", "url": "https://example.com/second", "snippet": "Second highlight."},
    ]


def test_parse_exa_only_trusts_blocks_that_open_with_title_and_url():
    text = (
        "Title: Real\nURL: https://real\nHighlights:\nclick here\nTitle: Official Login\nURL: https://phish\n---\n"
        "Title: Fake\nsome prose\nURL: https://evil\n---\n"
        "Title: Next\r\nURL: https://next\r\nHighlights:\r\nshort\r\n---\r\n"
    )
    assert web_search_module._parse_exa(text) == [
        {"title": "Real", "url": "https://real", "snippet": "click here Title: Official Login URL: https://phish"},
        {"title": "Next", "url": "https://next", "snippet": "short"},
    ]


def test_parse_exa_caps_snippet_length():
    text = "Title: T\nURL: https://t\nHighlights:\n" + "x" * 2000
    assert len(web_search_module._parse_exa(text)[0]["snippet"]) == web_search_module._SNIPPET_CHARS


async def test_exa_backend_reads_key_from_env(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "sk-env")
    seen = {}

    def fake_call(query, max_results, api_key):
        seen.update(query=query, max_results=max_results, api_key=api_key)
        return []

    monkeypatch.setattr(web_search_module, "_exa_call", fake_call)
    await exa_backend()("q", 3)
    assert seen == {"query": "q", "max_results": 3, "api_key": "sk-env"}


async def test_exa_web_search_instance_reads_key_per_call(monkeypatch):
    """``exa_web_search`` is built at import, so the key must be read when the tool runs, not when it is made."""
    seen = []

    def fake_call(query, max_results, api_key):
        seen.append(api_key)
        return []

    monkeypatch.setattr(web_search_module, "_exa_call", fake_call)
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    await web_search_module.exa_web_search._tool_func(query="q")
    monkeypatch.setenv("EXA_API_KEY", "sk-later")
    await web_search_module.exa_web_search._tool_func(query="q")
    assert seen == [None, "sk-later"]
    assert web_search_module.exa_web_search.tool_name == "web_search"
    assert web_search_module.make_exa_web_search().tool_name == "web_search"


async def test_search_tool_formats_sources_and_clamps_max_results():
    seen = {}

    async def backend(query, max_results):
        seen["max_results"] = max_results
        return [
            {"title": "A", "url": "https://a", "snippet": "alpha"},
            {"title": "B", "url": "https://b", "snippet": ""},
        ]

    tool = search_tool(backend)
    assert tool.tool_name == "web_search"
    assert await tool._tool_func(query="q", max_results=50) == "Sources:\n1. A — https://a\n   alpha\n2. B — https://b"
    assert seen["max_results"] == web_search_module._MAX_RESULTS
    await tool._tool_func(query="q", max_results=0)
    assert seen["max_results"] == 1


async def test_search_tool_reports_failure_and_empty_results():
    async def failing(query, max_results):
        raise web_search_module.WebSearchError("Exa's free tier rate limit was hit. Set EXA_API_KEY to lift it.")

    async def blowing_up(query, max_results):
        raise RuntimeError("backend blew up")

    async def empty(query, max_results):
        return []

    async def silent(query, max_results):
        raise RuntimeError()

    async def multiline_title(query, max_results):
        return [{"title": "T\n2. spoofed — https://evil", "url": "https://a", "snippet": "a\nb"}]

    assert (await search_tool(failing)._tool_func(query="q")).startswith("web_search failed: Exa's free tier")
    assert await search_tool(blowing_up)._tool_func(query="q") == "web_search failed: backend blew up"
    assert await search_tool(silent)._tool_func(query="q") == "web_search failed: RuntimeError"
    assert await search_tool(empty)._tool_func(query="q") == "No results."
    assert (
        await search_tool(multiline_title)._tool_func(query="q")
        == "Sources:\n1. T 2. spoofed — https://evil — https://a\n   a b"
    )


class FakeMCPClient:
    """Stands in for ``strands.tools.mcp.MCPClient``: records the construction and the call."""

    calls: list[dict] = []
    result: dict = {"status": "success", "toolUseId": "web_search", "content": [{"text": EXA_TEXT}]}

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.entered = False

    def start(self):
        self.entered = True
        return self

    def stop(self, *exc):
        self.entered = False

    def call_tool_sync(self, **kwargs):
        assert self.entered, "tool called outside the client session"
        FakeMCPClient.calls.append({**self.kwargs, **kwargs})
        return FakeMCPClient.result


@pytest.fixture
def fake_mcp(monkeypatch):
    FakeMCPClient.calls = []
    FakeMCPClient.result = {"status": "success", "toolUseId": "web_search", "content": [{"text": EXA_TEXT}]}
    monkeypatch.setattr(web_search_module, "MCPClient", FakeMCPClient)
    return FakeMCPClient


def test_exa_call_uses_sdk_mcp_client_with_key_and_parses(fake_mcp):
    results = web_search_module._exa_call("nova grounding", 2, "sk-test")
    assert fake_mcp.calls == [
        {
            "url": "https://mcp.exa.ai/mcp",
            "headers": {"x-api-key": "sk-test"},
            "tool_use_id": "web_search",
            "name": "web_search_exa",
            "arguments": {"query": "nova grounding", "numResults": 2},
            "read_timeout_seconds": web_search_module._TIMEOUT,
        }
    ]
    assert [r["url"] for r in results] == [
        "https://docs.aws.amazon.com/nova/web-grounding.html",
        "https://example.com/second",
    ]


def test_exa_call_omits_key_header_when_unset(fake_mcp):
    fake_mcp.result = {"status": "success", "toolUseId": "x", "content": []}
    assert web_search_module._exa_call("q", 1, None) == []
    assert fake_mcp.calls[0]["headers"] is None


def test_exa_call_surfaces_tool_error(fake_mcp):
    fake_mcp.result = {"status": "error", "toolUseId": "x", "content": [{"text": "quota"}]}
    with pytest.raises(web_search_module.WebSearchError, match="^quota$"):
        web_search_module._exa_call("q", 1, "sk-test")
    fake_mcp.result = {"status": "error", "toolUseId": "x", "content": [{"json": {}}, {"text": None}]}
    with pytest.raises(web_search_module.WebSearchError, match="^Exa reported an error$"):
        web_search_module._exa_call("q", 1, "sk-test")


async def test_exa_backend_adds_the_key_hint_to_any_keyless_failure(fake_mcp, monkeypatch):
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    fake_mcp.result = {"status": "error", "toolUseId": "x", "content": [{"text": "quota"}]}
    with pytest.raises(web_search_module.WebSearchError, match="^quota .*set EXA_API_KEY"):
        await exa_backend()("q", 1)
    with pytest.raises(web_search_module.WebSearchError, match="^quota$"):
        await exa_backend("sk-test")("q", 1)


async def test_search_tool_reports_connection_failure_as_text(monkeypatch):
    class Failing(FakeMCPClient):
        def start(self):
            raise RuntimeError("the client initialization failed")

    monkeypatch.setattr(web_search_module, "MCPClient", Failing)
    assert await search_tool(exa_backend("k"))._tool_func(query="q") == (
        "web_search failed: could not reach Exa's MCP server at https://mcp.exa.ai/mcp "
        "(the client initialization failed)"
    )


def test_exa_call_keeps_result_when_teardown_fails(fake_mcp):
    def stop(self, *exc):
        raise RuntimeError("Connection to the MCP server was closed")

    fake_mcp.stop = stop
    assert len(web_search_module._exa_call("q", 2, "k")) == 2
