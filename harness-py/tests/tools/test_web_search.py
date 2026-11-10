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


@pytest.fixture
def agentcore(monkeypatch):
    """A real ``bedrock-agentcore`` client behind a botocore Stubber, handed to the AgentCore backend."""
    import boto3
    from botocore.stub import Stubber

    client = boto3.client(
        "bedrock-agentcore", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x"
    )
    regions = []

    class Session:
        region_name = None

        def client(self, service, region_name):
            assert service == "bedrock-agentcore"
            regions.append(region_name)
            return client

    monkeypatch.setattr(web_search_module.boto3, "Session", Session)
    with Stubber(client) as stubber:
        stubber.regions = regions
        yield stubber


async def test_agentcore_web_search_calls_invoke_web_search_and_formats(agentcore):
    agentcore.add_response(
        "invoke_web_search",
        {
            "results": [
                {"title": "Strands", "url": "https://strandsagents.com", "text": "Build   agents\nfast. " + "x" * 600},
                {"url": "https://untitled.example", "text": "no title"},
            ]
        },
        {"webSearchId": "web-search.v1", "searchQuery": "strands agents", "maxResults": 10},
    )
    tool = web_search_module.make_agentcore_web_search("us-west-2")
    out = await tool._tool_func(query="strands agents", max_results=50)
    assert agentcore.regions == ["us-west-2"]
    lines = out.splitlines()
    assert lines[:2] == ["Sources:", "1. Strands — https://strandsagents.com"]
    assert lines[2].startswith("   Build agents fast. xxx") and len(lines[2]) == 3 + web_search_module._SNIPPET_CHARS
    assert lines[3:] == ["2. https://untitled.example — https://untitled.example", "   no title"]
    agentcore.assert_no_pending_responses()


async def test_agentcore_web_search_builds_one_client_across_searches(agentcore):
    for _ in range(2):
        agentcore.add_response("invoke_web_search", {"results": []})
    tool = web_search_module.make_agentcore_web_search("us-west-2")
    assert [await tool._tool_func(query="q"), await tool._tool_func(query="q")] == ["No results.", "No results."]
    assert agentcore.regions == ["us-west-2"]


async def test_agentcore_web_search_region_defaults_like_bedrock_model(agentcore, monkeypatch):
    monkeypatch.delenv("AWS_REGION", raising=False)
    agentcore.add_response("invoke_web_search", {"results": []})
    await web_search_module.make_agentcore_web_search()._tool_func(query="q")
    assert agentcore.regions == ["us-west-2"]


async def test_agentcore_web_search_access_denied_names_the_permission_and_stops_calling(agentcore):
    agentcore.add_client_error("invoke_web_search", "AccessDeniedException", "the request is not authorized")
    tool = web_search_module.make_agentcore_web_search("us-west-2")
    expected = (
        "web_search failed: An error occurred (AccessDeniedException) when calling the InvokeWebSearch operation: "
        "the request is not authorized (the caller needs bedrock-agentcore:InvokeWebSearch on "
        "arn:aws:bedrock-agentcore:us-west-2:aws:tool/web-search.v1). "
        "web_search is unavailable here; answer without it."
    )
    assert await tool._tool_func(query="q") == expected
    # No second response is queued: the Stubber would raise if the backend called the API again.
    assert await tool._tool_func(query="q") == expected


async def test_agentcore_web_search_names_an_unsupported_region_and_stops_calling(agentcore):
    agentcore.add_client_error("invoke_web_search", "404", "Invalid api path", http_status_code=404)
    tool = web_search_module.make_agentcore_web_search("eu-central-1")
    expected = (
        "web_search failed: AgentCore web search is not available in eu-central-1 (An error occurred (404) when "
        "calling the InvokeWebSearch operation: Invalid api path). web_search is unavailable here; answer without it."
    )
    assert await tool._tool_func(query="q") == expected
    assert await tool._tool_func(query="q") == expected


async def test_agentcore_web_search_passes_other_errors_through_and_retries(agentcore):
    agentcore.add_client_error("invoke_web_search", "ThrottlingException", "slow down", http_status_code=429)
    agentcore.add_client_error(
        "invoke_web_search", "ResourceNotFoundException", "no such web search", http_status_code=404
    )
    tool = web_search_module.make_agentcore_web_search("us-west-2")
    assert await tool._tool_func(query="q") == (
        "web_search failed: An error occurred (ThrottlingException) when calling the InvokeWebSearch operation: "
        "slow down"
    )
    assert await tool._tool_func(query="q") == (
        "web_search failed: An error occurred (ResourceNotFoundException) when calling the InvokeWebSearch "
        "operation: no such web search"
    )
    agentcore.assert_no_pending_responses()
