"""Tests for the indexer module with TF-IDF scoring and content hydration."""

from strands_mcp_server.utils.indexer import Doc, IndexSearch


class TestIndexerBasic:
    """Basic indexer functionality tests."""

    def test_add_and_search_simple(self):
        index = IndexSearch()
        doc = Doc(
            uri="https://example.com/test",
            display_title="Test Doc",
            content="hello world",
            index_title="test doc",
        )
        index.add(doc)

        results = index.search("hello")

        assert len(results) == 1
        assert results[0][1].uri == "https://example.com/test"

    def test_search_returns_empty_for_no_match(self):
        index = IndexSearch()
        doc = Doc(
            uri="https://example.com/test",
            display_title="Test Doc",
            content="hello world",
            index_title="test doc",
        )
        index.add(doc)

        results = index.search("nonexistent")

        assert len(results) == 0

    def test_title_search_ranks_higher(self):
        index = IndexSearch()
        doc1 = Doc(
            uri="https://example.com/body",
            display_title="Other Topic",
            content="This document discusses guardrail implementation details.",
            index_title="other topic",
        )
        doc2 = Doc(
            uri="https://example.com/title",
            display_title="Guardrail Guide",
            content="This is a guide about safety mechanisms.",
            index_title="guardrail guide",
        )
        index.add(doc1)
        index.add(doc2)

        results = index.search("guardrail")

        assert len(results) == 2
        assert results[0][1].uri == "https://example.com/title"

    def test_add_deduplicates_postings_per_document(self):
        """Regression test for issue #3325: one posting per token per document."""
        index = IndexSearch()
        index.add(Doc(uri="first", display_title="First", content="agent agent", index_title="agent"))
        index.add(Doc(uri="second", display_title="Second", content="agent", index_title=""))

        exp_postings = [0, 1]
        assert index.doc_indices["agent"] == exp_postings
        assert index.doc_frequency["agent"] == 2

    def test_search_scores_each_posting_once(self):
        """Regression test: TF-IDF scoring counts term frequency correctly."""
        index = IndexSearch()
        index.add(Doc(uri="doc", display_title="Doc", content="agent agent agent", index_title=""))

        results = index.search("agent")

        assert len(results) == 1
        # TF-IDF: tf=3 (content count), idf=log(2/2)+1=1.0, score=3.0
        assert results[0][0] == 3.0


class TestContentHydration:
    """Tests for content hydration and index updates."""

    def test_body_only_terms_found_after_hydration(self):
        # Core fix for issue #3321: body-only terms become searchable after hydration
        index = IndexSearch()

        doc = Doc(
            uri="https://strandsagents.com/guardrails.md",
            display_title="Safety Guide",
            content="",
            index_title="safety guide",
        )
        index.add(doc)

        results_before = index.search("guardrail")
        assert len(results_before) == 0

        new_content = """# Safety Guide

## Guardrails

Guardrails help protect your agent from harmful outputs. You can configure
custom guardrail policies to filter content.

### Setting up guardrails

Use the guardrail configuration to define rules.
"""
        updated = index.update_content("https://strandsagents.com/guardrails.md", new_content)
        assert updated is True

        results_after = index.search("guardrail")
        assert len(results_after) == 1
        assert results_after[0][1].uri == "https://strandsagents.com/guardrails.md"

    def test_idempotent_rehydration(self):
        index = IndexSearch()

        doc = Doc(
            uri="https://example.com/test",
            display_title="Test",
            content="",
            index_title="test",
        )
        index.add(doc)

        content = "This is the test content with unique terms."

        index.update_content("https://example.com/test", content)
        results1 = index.search("unique")
        score1 = results1[0][0] if results1 else 0

        index.update_content("https://example.com/test", content)
        results2 = index.search("unique")
        score2 = results2[0][0] if results2 else 0

        assert len(results1) == len(results2)
        assert score1 == score2

    def test_update_content_returns_false_for_unknown_uri(self):
        index = IndexSearch()
        result = index.update_content("https://unknown.com/page", "content")
        assert result is False

    def test_hydration_removes_old_tokens(self):
        index = IndexSearch()

        doc = Doc(
            uri="https://example.com/test",
            display_title="Test",
            content="apple banana cherry",
            index_title="test",
        )
        index.add(doc)

        assert len(index.search("apple")) == 1

        index.update_content("https://example.com/test", "orange grape melon")

        assert len(index.search("apple")) == 0
        assert len(index.search("orange")) == 1


class TestTFIDFScoring:
    """Tests for TF-IDF scoring behavior."""

    def test_higher_term_frequency_ranks_higher(self):
        """Document with more occurrences of the query term should score higher."""
        index = IndexSearch()

        few_doc = Doc(
            uri="https://example.com/few",
            display_title="Few",
            content="python is great.",
            index_title="few",
        )
        many_doc = Doc(
            uri="https://example.com/many",
            display_title="Many",
            content="python python python python python.",
            index_title="many",
        )
        index.add(few_doc)
        index.add(many_doc)

        results = index.search("python")

        assert len(results) == 2
        assert results[0][1].uri == "https://example.com/many"
        assert results[0][0] > results[1][0]

    def test_markdown_header_boost_preserved(self):
        index = IndexSearch()

        header_doc = Doc(
            uri="https://example.com/header",
            display_title="Guide",
            content="# Introduction\n\n## Streaming\n\nContent here.",
            index_title="guide",
        )
        body_doc = Doc(
            uri="https://example.com/body",
            display_title="Other",
            content="# Other Topic\n\nWe discuss streaming in this paragraph.",
            index_title="other",
        )
        index.add(header_doc)
        index.add(body_doc)

        results = index.search("streaming")

        assert len(results) == 2
        assert results[0][1].uri == "https://example.com/header"

    def test_markdown_code_boost_preserved(self):
        index = IndexSearch()

        code_doc = Doc(
            uri="https://example.com/code",
            display_title="Code Example",
            content="# Example\n\n```python\nimport asyncio\n```\n\nText here.",
            index_title="code example",
        )
        body_doc = Doc(
            uri="https://example.com/text",
            display_title="Text Only",
            content="# Topic\n\nWe use asyncio for async programming asyncio is great.",
            index_title="text only",
        )
        index.add(code_doc)
        index.add(body_doc)

        results = index.search("asyncio")

        assert len(results) == 2

    def test_title_queries_rank_titles_first(self):
        index = IndexSearch()

        title_doc = Doc(
            uri="https://example.com/agent",
            display_title="Agent Overview",
            content="This describes the system architecture.",
            index_title="agent overview",
        )
        body_doc = Doc(
            uri="https://example.com/body",
            display_title="System Design",
            content="The agent handles requests. The agent logic is here.",
            index_title="system design",
        )
        index.add(title_doc)
        index.add(body_doc)

        results = index.search("agent")

        assert len(results) == 2
        assert results[0][1].uri == "https://example.com/agent"


class TestEdgeCases:
    """Edge case tests."""

    def test_empty_content_document(self):
        index = IndexSearch()

        doc = Doc(
            uri="https://example.com/empty",
            display_title="Empty Doc",
            content="",
            index_title="empty doc",
        )
        index.add(doc)

        results = index.search("empty")
        assert len(results) == 1

    def test_search_on_empty_index(self):
        index = IndexSearch()
        results = index.search("anything")
        assert results == []

    def test_multiple_documents_same_term(self):
        index = IndexSearch()

        for i in range(5):
            doc = Doc(
                uri=f"https://example.com/doc{i}",
                display_title=f"Doc {i}",
                content=f"Common term appears here. Doc {i} specific content.",
                index_title=f"doc {i}",
            )
            index.add(doc)

        results = index.search("common")

        assert len(results) == 5
        for score, _doc in results:
            assert score > 0

    def test_case_insensitive_search(self):
        index = IndexSearch()

        doc = Doc(
            uri="https://example.com/test",
            display_title="Test",
            content="Python PYTHON python PyThOn",
            index_title="test",
        )
        index.add(doc)

        results_lower = index.search("python")
        results_upper = index.search("PYTHON")
        results_mixed = index.search("PyThOn")

        assert len(results_lower) == len(results_upper) == len(results_mixed) == 1


class TestSourceWeighting:
    def test_search_prioritizes_guides_and_examples_over_api_reference(self) -> None:
        """User-facing documentation ranks above API reference pages."""
        index = IndexSearch()
        api_doc = Doc(
            uri="https://strandsagents.com/docs/api/python/strands.agent/",
            display_title="strands.agent.Agent",
            content="",
            index_title="strands agent agent",
        )
        example_doc = Doc(
            uri="https://strandsagents.com/docs/examples/python/agent/",
            display_title="Agent",
            content="",
            index_title="Agent",
        )
        user_guide_doc = Doc(
            uri="https://strandsagents.com/docs/user-guide/concepts/agents/",
            display_title="Agent",
            content="",
            index_title="Agent",
        )
        for doc in (api_doc, example_doc, user_guide_doc):
            index.add(doc)

        tru_docs = [doc for _, doc in index.search("agent")]

        assert tru_docs == [user_guide_doc, example_doc, api_doc]

    def test_search_preserves_explicit_api_intent(self) -> None:
        """Explicit source terms disable the user-facing documentation prior."""
        index = IndexSearch()
        api_doc = Doc(
            uri="https://strandsagents.com/docs/api/python/strands.hooks/",
            display_title="strands.hooks",
            content="",
            index_title="hooks",
        )
        user_guide_doc = Doc(
            uri="https://strandsagents.com/docs/user-guide/concepts/hooks/",
            display_title="Hooks",
            content="",
            index_title="hooks",
        )
        for doc in (api_doc, user_guide_doc):
            index.add(doc)

        tru_results = index.search("hooks API")

        assert sorted(doc.uri for _, doc in tru_results) == sorted([api_doc.uri, user_guide_doc.uri])
        assert tru_results[0][0] == tru_results[1][0]
