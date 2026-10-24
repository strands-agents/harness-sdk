"""Graded relevance benchmark for search_docs ranking.

Gives ranking changes a before/after measurement instead of an argument. Each
case names a query and the document a user asking that query wants, so a change
to scoring can be judged by whether targets move up or down.

Related: https://github.com/strands-agents/harness-sdk/issues/3317 (tracking),
#3321 (content indexing), #3322 (stemming), #3323 (guides vs API reference).

The corpus is a frozen extract of the live ``llms.txt`` - real titles and URLs,
kept small so the benchmark is deterministic and needs no network. It preserves
the property that matters for ranking: API entries are dotted module paths that
repeat their own name, user guides are short prose titles.

Cases that the current ranking gets wrong are marked ``xfail`` with the issue
that should fix them. They are non-strict, so they report as ``xpass`` rather
than failing CI once a fix lands.
"""

import pytest

from strands_mcp_server.utils.indexer import Doc, IndexSearch
from strands_mcp_server.utils.text_processor import index_title_variants, normalize

# (title, url) exactly as they appear in llms.txt
CORPUS = [
    # --- Api Python
    ("strands.agent.agent", "https://strandsagents.com/docs/api/python/strands.agent.agent/index.md"),
    ("strands.agent.a2a_agent", "https://strandsagents.com/docs/api/python/strands.agent.a2a_agent/index.md"),
    ("strands.agent.agent_result", "https://strandsagents.com/docs/api/python/strands.agent.agent_result/index.md"),
    (
        "strands.tools.structured_output.structured_output_tool",
        "https://strandsagents.com/docs/api/python/strands.tools.structured_output.structured_output_tool/index.md",
    ),
    ("strands.types.guardrails", "https://strandsagents.com/docs/api/python/strands.types.guardrails/index.md"),
    ("strands.event_loop.streaming", "https://strandsagents.com/docs/api/python/strands.event_loop.streaming/index.md"),
    # --- user guide
    ("Structured Output", "https://strandsagents.com/docs/user-guide/concepts/agents/structured-output/index.md"),
    ("agent-to-agent", "https://strandsagents.com/docs/user-guide/concepts/multi-agent/agent-to-agent/index.md"),
    (
        "Multi-Agent Systems",
        "https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/index.md",
    ),
    ("Streaming Responses", "https://strandsagents.com/docs/user-guide/concepts/streaming/index.md"),
    ("guardrails", "https://strandsagents.com/docs/user-guide/safety-security/guardrails/index.md"),
    # --- blog
    (
        "Runtime Guardrails for Strands Agents with Agent Control",
        "https://strandsagents.com/blog/strands-agents-with-agent-control/index.md",
    ),
]


@pytest.fixture(scope="module")
def index():
    """Index the frozen corpus the way ``cache.load_links_only()`` does."""
    built = IndexSearch()
    for title, url in CORPUS:
        display_title = normalize(title)
        built.add(
            Doc(
                uri=url,
                display_title=display_title,
                content="",
                index_title=index_title_variants(display_title, url),
            )
        )
    return built


def rank_of(index, query, title, k=len(CORPUS)):
    """1-based rank of ``title`` for ``query``, or None if it does not match."""
    for position, (_score, doc) in enumerate(index.search(query, k=k), start=1):
        if doc.display_title == title:
            return position
    return None


def test_exact_title_query_ranks_its_own_page_first(index):
    """Control: an unambiguous title query returns that page first."""
    exp_rank = 1
    tru_rank = rank_of(index, "Streaming Responses", "Streaming Responses")

    assert tru_rank == exp_rank


@pytest.mark.xfail(
    reason="title TF counts substrings, so a module path outranks the page it names",
    strict=False,
)
def test_exact_title_query_beats_module_page_of_same_name(index):
    """A page queried by its exact title should outrank a module path echoing it.

    ``_calculate_md_score`` scores titles with ``title_lower.count(token)``, a
    substring count, while ``doc_indices`` tokenizes on word boundaries. The
    slug variant from ``index_title_variants`` repeats the module name, so
    'structured' and 'output' each appear four times in the module page's
    index_title against once in the guide's - and with empty content the title
    boost is at its maximum. The guide loses to the module page 4:1 on a query
    that is its own title.
    """
    tru_guide = rank_of(index, "Structured Output", "Structured Output")
    tru_module = rank_of(index, "Structured Output", "strands.tools.structured_output.structured_output_tool")

    assert tru_guide < tru_module


def test_body_only_terms_reach_no_documents(index):
    """Terms that appear only in page bodies match nothing while search is title-only.

    This is the measurable form of #3321 and the reason natural-language queries
    are decided by whichever single token happens to appear in a title.
    """
    exp_matches = 0
    for term in ("constructor", "parameters", "inputs"):
        assert len(index.doc_indices.get(term, [])) == exp_matches, term


@pytest.mark.xfail(reason="#3321: bodies are not indexed, so only 'agent' discriminates", strict=False)
def test_agent_class_query_finds_the_agent_module(index):
    """The Agent class page should win a query about the Agent class.

    From strands-agents/mcp-server#30: the reporter's assistant asked for the
    Agent constructor and never saw this page.
    """
    exp_rank = 1
    tru_rank = rank_of(index, "Agent class constructor parameters inputs", "strands.agent.agent")

    assert tru_rank == exp_rank


@pytest.mark.xfail(reason="#3323: API module pages outrank user guides on conceptual queries", strict=False)
def test_conceptual_query_prefers_user_guide_over_api_module(index):
    """A "how do I" query should surface the guide, not the module reference."""
    tru_guide = rank_of(index, "how do I use structured output", "Structured Output")
    tru_api = rank_of(
        index, "how do I use structured output", "strands.tools.structured_output.structured_output_tool"
    )

    assert tru_guide < tru_api


@pytest.mark.xfail(reason="#3322: no stemming, singular query misses plural title", strict=False)
def test_singular_query_matches_plural_title(index):
    """'guardrail' should find the guardrails guide."""
    tru_rank = rank_of(index, "guardrail", "guardrails")

    assert tru_rank is not None
