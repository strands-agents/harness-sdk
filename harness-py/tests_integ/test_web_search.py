"""Live checks of the ``web_search`` backends: Exa's hosted MCP server and AgentCore ``InvokeWebSearch``.

The unit tests stub the transport, so a change on Exa's side (the MCP handshake, the text format of
``web_search_exa`` results) would otherwise surface only as a silent ``No results.`` for every user
on a model without native search. Keyless; ``EXA_API_KEY`` is picked up when present.
"""

from __future__ import annotations

import pytest

from strands_harness.tools.web_search import WebSearchError
from strands_harness.tools.web_search import _agentcore_backend as agentcore_backend
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


async def test_agentcore_backend_returns_parsed_results():
    """``web_search`` on Bedrock: a live ``InvokeWebSearch`` call in the region ``BedrockModel`` resolves."""
    try:
        results = await agentcore_backend()("Strands Agents SDK documentation", 3)
    except WebSearchError as exc:
        # Skipped only until the integ role is granted bedrock-agentcore:InvokeWebSearch.
        if "the caller needs bedrock-agentcore:InvokeWebSearch" in str(exc):
            pytest.skip(str(exc))
        raise
    assert 0 < len(results) <= 3, "InvokeWebSearch returned no results; check webSearchId and the response shape"
    assert all(r["url"].startswith("http") and r["snippet"] for r in results)
