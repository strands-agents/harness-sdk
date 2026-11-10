import os

import pytest

from strands_mcp_server.utils import cache
from strands_mcp_server.utils.text_processor import SMALL_DOC_THRESHOLD

# Known stable documentation URLs for regression testing.
# These are core pages unlikely to be removed.
LARGE_DOC_URL = "https://strandsagents.com/docs/user-guide/sdk/agents/hooks/index.md"

integ_marks = [
    pytest.mark.integ,
    pytest.mark.timeout(60),
    pytest.mark.skipif(
        "SKIP_INTEG_TESTS" in os.environ,
        reason="SKIP_INTEG_TESTS is set",
    ),
]


@pytest.fixture(scope="session")
def live_cache():
    """Initialize the real cache from strandsagents.com llms.txt.

    Session-scoped to avoid re-fetching the llms.txt index for every test.
    """
    cache.ensure_ready()
    return cache


@pytest.fixture(scope="module")
def fresh_index():
    """An index rebuilt from llms.txt with no page hydrated; the session cache is restored afterwards."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cache, "_INDEX", None)
        mp.setattr(cache, "_URL_CACHE", {})
        mp.setattr(cache, "_URL_TITLES", {})
        mp.setattr(cache, "_LINKS_LOADED", False)
        cache.ensure_ready()
        yield cache.get_index()


@pytest.fixture(scope="session")
def large_doc_page(live_cache):
    """Fetch and cache a known large documentation page.

    The Hooks user guide is ~23KB with multiple ## sections - ideal for
    testing TOC generation and section extraction on real content.
    """
    page = live_cache.ensure_page(LARGE_DOC_URL)
    if page is None:
        pytest.fail(f"Could not fetch required documentation page {LARGE_DOC_URL}")
    if len(page.content.encode("utf-8")) <= SMALL_DOC_THRESHOLD:
        pytest.fail(
            f"Doc at {LARGE_DOC_URL} is only {len(page.content.encode('utf-8'))} bytes (need >{SMALL_DOC_THRESHOLD})"
        )
    return page


@pytest.fixture(scope="session")
def url_titles(live_cache):
    """Get the full URL-to-title mapping from llms.txt."""
    return live_cache.get_url_titles()
