"""Tests for MCP server tools."""

import asyncio
from threading import Event, Lock
from unittest.mock import patch

import pytest

from strands_mcp_server.server import ToolError, fetch_doc, mcp, search_docs
from strands_mcp_server.utils.doc_fetcher import Page
from strands_mcp_server.utils.indexer import Doc


def _listed_tools() -> dict[str, dict]:
    return {
        tool.name: tool.model_dump(by_alias=True, mode="json", exclude_none=True)
        for tool in asyncio.run(mcp.list_tools())
    }


class TestServerMetadata:
    """Tests for what the server advertises to clients."""

    def test_instructions_name_both_tools(self):
        assert "search_docs" in mcp.instructions
        assert "fetch_doc" in mcp.instructions

    @pytest.mark.parametrize("name", ["search_docs", "fetch_doc"])
    def test_tools_are_titled_and_annotated_read_only(self, name):
        tool = _listed_tools()[name]

        assert tool["title"]
        assert tool["annotations"] == {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": True,
        }

    @pytest.mark.parametrize(("name", "params"), [("search_docs", ["query", "k"]), ("fetch_doc", ["uri", "section"])])
    def test_parameters_are_described_in_schema(self, name, params):
        properties = _listed_tools()[name]["inputSchema"]["properties"]

        assert all(properties[param].get("description") for param in params)

    def test_search_result_limit_is_bounded(self):
        k_schema = _listed_tools()["search_docs"]["inputSchema"]["properties"]["k"]

        assert (k_schema["minimum"], k_schema["maximum"]) == (1, 20)


@patch("strands_mcp_server.server.cache")
def test_search_docs_hydrates_pages_concurrently(mock_cache):
    """Guard against serial snippet hydration (#3329)."""
    docs = [
        Doc(uri=f"https://strandsagents.com/{index}.md", display_title=f"Doc {index}", content="", index_title="")
        for index in range(2)
    ]
    ranked_docs = [docs[0], docs[0], docs[1]]
    mock_cache.get_index.return_value.search.return_value = [(1.0, doc) for doc in ranked_docs]
    mock_cache.get_url_cache.return_value = {doc.uri: None for doc in docs}
    mock_cache.SNIPPET_HYDRATE_MAX = 5

    fetch_lock = Lock()
    both_fetches_started = Event()
    active_fetches = 0
    max_active_fetches = 0

    def ensure_page(_url: str) -> None:
        nonlocal active_fetches, max_active_fetches
        with fetch_lock:
            active_fetches += 1
            max_active_fetches = max(max_active_fetches, active_fetches)
            if active_fetches == len(docs):
                both_fetches_started.set()
        both_fetches_started.wait(timeout=0.5)
        with fetch_lock:
            active_fetches -= 1

    mock_cache.ensure_page.side_effect = ensure_page

    tru_result = search_docs("agent")

    assert max_active_fetches == 2
    assert mock_cache.ensure_page.call_count == 2
    assert {call.args[0] for call in mock_cache.ensure_page.call_args_list} == {doc.uri for doc in docs}
    assert [result["url"] for result in tru_result] == [doc.uri for doc in ranked_docs]


@patch("strands_mcp_server.server.cache")
class TestFetchDocTocMode:
    """Tests for fetch_doc TOC mode (no section param)."""

    def test_returns_toc_for_large_doc(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md")

        assert "sections" in tru_result
        assert len(tru_result["sections"]) == 3
        assert tru_result["title"] == "Test Doc"

        # Internal fields must not leak into tool responses
        for section in tru_result["sections"]:
            for key in section:
                assert not key.startswith("_"), f"Internal field '{key}' leaked"

    def test_small_doc_returns_full_content(self, mock_cache, small_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/small.md",
            title="Small Doc",
            content=small_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/small.md")

        assert tru_result["document_small"] is True
        assert tru_result["reason"] == "size"
        assert "content" in tru_result
        assert "sections" not in tru_result

    def test_small_doc_ignores_section_param(self, mock_cache, small_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/small.md",
            title="Small Doc",
            content=small_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/small.md", section="1")

        # Section param should be ignored for small docs
        assert tru_result["document_small"] is True
        assert tru_result["reason"] == "size"
        assert "content" in tru_result
        assert "section_id" not in tru_result

    def test_toc_includes_preamble(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md")

        assert "preamble" in tru_result
        assert "Experimental hook events" in tru_result["preamble"]

    def test_no_h2_headers_returns_full_content(self, mock_cache, no_h2_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/no-h2.md",
            title="No H2 Doc",
            content=no_h2_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/no-h2.md")

        # No ## sections means fallback to full content
        assert tru_result["document_small"] is True
        assert tru_result["reason"] == "no_sections"
        assert "content" in tru_result
        assert "sections" not in tru_result

    @pytest.mark.parametrize("kwargs", [{}, {"uri": ""}], ids=["no-args", "empty-uri"])
    def test_omitted_uri_returns_url_catalog(self, mock_cache, kwargs):
        mock_cache.get_url_titles.return_value = {"https://strandsagents.com/a.md": "Doc A"}

        tru_result = fetch_doc(**kwargs)

        assert tru_result == {"urls": [{"url": "https://strandsagents.com/a.md", "title": "Doc A"}]}


@patch("strands_mcp_server.server.cache")
class TestFetchDocSectionMode:
    """Tests for fetch_doc section mode."""

    def test_returns_section_content(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md", section="1")

        assert tru_result["section_id"] == "1"
        assert "content" in tru_result
        assert "sections" not in tru_result


@patch("strands_mcp_server.server.cache")
class TestFetchDocErrors:
    """Tests for fetch_doc error handling."""

    @pytest.mark.parametrize(
        "malicious_uri",
        [
            "https://strandsagents.com.evil.com/path",
            "https://strandsagents.com@evil.com/path",
            "http://strandsagents.com/path",
            "ftp://strandsagents.com/path",
            "https://evil.com/hack",
        ],
    )
    def test_ssrf_bypass_vectors_rejected(self, mock_cache, malicious_uri):
        tru_result = fetch_doc(uri=malicious_uri)

        assert "error" in tru_result
        assert tru_result["error"] == "only https://strandsagents.com URLs allowed"

    def test_disallowed_url_points_to_search(self, mock_cache):
        tru_result = fetch_doc(uri="https://evil.com/hack")

        assert tru_result == {
            "error": "only https://strandsagents.com URLs allowed",
            "url": "https://evil.com/hack",
            "hint": "Use search_docs to find the Strands page for this topic.",
        }

    def test_invalid_section_lists_valid_sections(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md", section="99")

        assert tru_result == {
            "error": "section '99' not found",
            "url": "https://strandsagents.com/test.md",
            "sections": [
                {
                    "id": "1",
                    "title": "AfterModelCallEvent",
                    "children": [
                        {"id": "1.1", "title": "should_reverse_callbacks"},
                        {"id": "1.2", "title": "ModelStopResponse"},
                    ],
                },
                {
                    "id": "2",
                    "title": "AfterToolCallEvent",
                    "children": [{"id": "2.1", "title": "should_reverse_callbacks"}],
                },
                {
                    "id": "3",
                    "title": "AgentTool",
                    "children": [{"id": "3.1", "title": "__init__()"}, {"id": "3.2", "title": "stream()"}],
                },
            ],
            "hint": "Use one of the listed section IDs.",
        }

    def test_uncatalogued_url_fetch_failure_suggests_close_catalog_urls(self, mock_cache):
        mock_cache.ensure_page.return_value = None
        mock_cache.get_url_titles.return_value = {
            "https://strandsagents.com/docs/user-guide/agents/index.md": "Agents",
            "https://strandsagents.com/blog/launch/index.md": "Launch",
        }

        tru_result = fetch_doc(uri="https://strandsagents.com/docs/user-guide/agent/index.md")

        assert tru_result == {
            "error": "fetch failed",
            "url": "https://strandsagents.com/docs/user-guide/agent/index.md",
            "suggestions": [{"url": "https://strandsagents.com/docs/user-guide/agents/index.md", "title": "Agents"}],
            "hint": "This URL is not in the docs catalog. Use a suggested URL, or search_docs to find the page.",
        }

    def test_uncatalogued_url_without_close_match_has_no_suggestions(self, mock_cache):
        mock_cache.ensure_page.return_value = None
        mock_cache.get_url_titles.return_value = {
            "https://strandsagents.com/docs/contribute/index.md": "Contribute",
            "https://strandsagents.com/docs/labs/index.md": "Labs",
        }

        tru_result = fetch_doc(uri="https://strandsagents.com/docs/does-not-exist/index.md")

        assert tru_result == {
            "error": "fetch failed",
            "url": "https://strandsagents.com/docs/does-not-exist/index.md",
            "suggestions": [],
            "hint": "This URL is not in the docs catalog. Use a suggested URL, or search_docs to find the page.",
        }

    def test_catalog_url_fetch_failure_is_a_tool_error(self, mock_cache):
        catalog_url = "https://strandsagents.com/docs/user-guide/agents/index.md"
        mock_cache.ensure_page.return_value = None
        mock_cache.get_url_titles.return_value = {catalog_url: "Agents"}

        with pytest.raises(ToolError, match="fetch failed"):
            fetch_doc(uri=catalog_url)
