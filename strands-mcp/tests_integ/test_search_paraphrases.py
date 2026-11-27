"""Conversational queries with alternate phrasings against the live catalog."""

import pytest

from strands_mcp_server import server

from .conftest import integ_marks

pytestmark = integ_marks

BASE = "https://strandsagents.com/"

PARAPHRASES = {
    "stop the agent after 5 turns": (
        ["turn limit", "max cycles", "lifecycle controls"],
        {"docs/user-guide/sdk/agents/lifecycle-controls/index.md"},
    ),
    "remember things between conversations": (
        ["session manager", "persist conversation", "session management"],
        {"docs/user-guide/sdk/agents/session-management/index.md"},
    ),
    "make the model return json matching my pydantic class": (
        ["structured output", "output schema"],
        {"docs/user-guide/sdk/agents/structured-output/index.md"},
    ),
    "let my agent call other agents": (
        ["agents as tools", "multi-agent"],
        {
            "docs/user-guide/sdk/multi-agent/agents-as-tools/index.md",
            "docs/learning/multi-agent-patterns-agents-as-tools/index.md",
        },
    ),
    "use claude instead of bedrock": (
        ["anthropic model provider", "AnthropicModel"],
        {"docs/user-guide/sdk/model-providers/anthropic/index.md"},
    ),
}


@pytest.fixture(scope="module")
def fresh_top_3(fresh_index):
    """Fused top 3 per conversational query on a fresh index, without hydrating any page."""
    return {
        query: {doc.uri for _, doc in server._fused_search(fresh_index, [query, *alternates], 3)}
        for query, (alternates, _) in PARAPHRASES.items()
    }


@pytest.mark.parametrize("query", PARAPHRASES)
def test_alternate_phrasings_find_expected_page(fresh_top_3, query):
    _, expected = PARAPHRASES[query]

    assert {f"{BASE}{path}" for path in expected} & fresh_top_3[query]
