"""Live check of the default ``web_search`` backend against Exa's hosted MCP server.

The unit tests stub the transport, so a change on Exa's side (the MCP handshake, the text format of
``web_search_exa`` results) would otherwise surface only as a silent ``No results.`` for every user
on a model without native search. Keyless; ``EXA_API_KEY`` is picked up when present.
"""

from __future__ import annotations

import pytest

from strands_harness.tools.web_search import WebSearchError
from strands_harness.tools.web_search import _exa_backend as exa_backend


async def test_exa_backend_returns_parsed_results():
    try:
        results = await exa_backend()("Strands Agents SDK documentation", 3)
    except WebSearchError as exc:
        if "rate limit" in str(exc):
            pytest.skip(str(exc))
        raise
    assert results, "Exa returned no parseable results; check the wire format in tools/web_search.py"
    assert all(r["title"] and r["url"].startswith("http") for r in results)
