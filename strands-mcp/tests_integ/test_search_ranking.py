"""Regression queries for search_docs ranking against the live catalog."""

import pytest

from strands_mcp_server import server
from strands_mcp_server.utils import cache

from .conftest import integ_marks

pytestmark = integ_marks

BASE = "https://strandsagents.com/"

EXPECTED_TOP_3 = {
    "evals quickstart": "docs/user-guide/evals-sdk/quickstart/index.md",
    "harness configuration": "docs/user-guide/harness/reference/configuration/index.md",
    "strands.models.bedrock": "docs/api/python/strands.models.bedrock/index.md",
    "harness sessions": "docs/user-guide/harness/configure/sessions/index.md",
    "BedrockModel": "docs/api/typescript/BedrockModel/index.md",
    "python v1.62.0": "changelog/sdk/python-v1.62.0/index.md",
    "migrate strands-agents-tools": "docs/user-guide/migrate/strands-agents-tools/index.md",
    "shell mcp server": "docs/user-guide/shell/mcp-server/index.md",
    "bedrock": "docs/user-guide/sdk/model-providers/amazon-bedrock/index.md",
    "hooks": "docs/user-guide/sdk/agents/hooks/index.md",
    "guardrails": "docs/user-guide/sdk/safety-security/guardrails/index.md",
}

# Each search_docs call hydrates its top results, including the changelog aggregate page.
HYDRATING_QUERIES = ["BedrockModel typescript", "sdk changelog 1.62", "changelog", "agent", "mcp", *EXPECTED_TOP_3]


def _top_3() -> dict[str, list[str]]:
    index = cache.get_index()
    return {query: [doc.uri for _, doc in index.search(query, k=3)] for query in EXPECTED_TOP_3}


@pytest.fixture(scope="module")
def rankings():
    """Top 3 per regression query on a fresh index, then again after search_docs hydrated pages."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cache, "_INDEX", None)
        mp.setattr(cache, "_URL_CACHE", {})
        mp.setattr(cache, "_URL_TITLES", {})
        mp.setattr(cache, "_LINKS_LOADED", False)
        cache.ensure_ready()
        fresh = _top_3()
        for query in HYDRATING_QUERIES:
            server.search_docs(query)
        hydrated_urls = {url for url, page in cache.get_url_cache().items() if page is not None}
        yield {"fresh": fresh, "hydrated": _top_3(), "hydrated_urls": hydrated_urls}


def test_queries_hydrated_pages(rankings):
    assert len(rankings["hydrated_urls"]) >= 10
    assert f"{BASE}changelog/index.md" in rankings["hydrated_urls"]


@pytest.mark.parametrize("stage", ["fresh", "hydrated"])
@pytest.mark.parametrize("query", EXPECTED_TOP_3)
def test_expected_page_in_top_3(rankings, stage, query):
    assert BASE + EXPECTED_TOP_3[query] in rankings[stage][query]
