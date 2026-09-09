"""Tests for the relevance module."""

import pytest

from strands.vended_plugins.context_offloader.relevance import (
    Chunk,
    RelevancePreview,
    _assemble_preview,
    _chunk_text,
    _format_gap_marker,
    _has_protected_content,
    _select_chunks,
    _validate_scores,
)
from strands.vended_plugins.context_offloader.reranker import RerankerError


def _chunks(*texts: str) -> list[Chunk]:
    """Build chunks with one line each, sized by the given texts."""
    return [Chunk(index=i, text=text, start_line=i + 1, end_line=i + 1) for i, text in enumerate(texts)]


class TestChunk:
    def test_is_frozen(self):
        chunk = Chunk(index=0, text="a", start_line=1, end_line=1)
        with pytest.raises(AttributeError):
            chunk.text = "b"  # type: ignore[misc]


class TestChunkText:
    def test_empty_text_returns_empty_list(self):
        assert _chunk_text("", chunk_tokens=1) == []

    def test_invalid_chunk_tokens(self):
        with pytest.raises(ValueError, match="chunk_tokens"):
            _chunk_text("abc", chunk_tokens=0)

    def test_text_within_budget_is_single_chunk(self):
        chunks = _chunk_text("abc", chunk_tokens=10)
        assert len(chunks) == 1
        assert chunks[0] == Chunk(index=0, text="abc", start_line=1, end_line=1)

    def test_boundary_keeps_newline_with_preceding_chunk(self):
        # max_chars = 4, so "aa\n" and "bb\n" cannot share a chunk.
        chunks = _chunk_text("aa\nbb\ncc", chunk_tokens=1)
        assert [c.text for c in chunks] == ["aa\n", "bb\n", "cc"]
        assert [(c.start_line, c.end_line) for c in chunks] == [(1, 1), (2, 2), (3, 3)]

    def test_long_line_is_split_by_character_inheriting_lines(self):
        chunks = _chunk_text("x" * 9, chunk_tokens=1)
        assert [c.text for c in chunks] == ["xxxx", "xxxx", "x"]
        assert all((c.start_line, c.end_line) == (1, 1) for c in chunks)

    def test_long_line_flushes_pending_buffer_first(self):
        text = "ab\n" + "y" * 6 + "\nz"
        chunks = _chunk_text(text, chunk_tokens=1)
        assert [c.text for c in chunks] == ["ab\n", "yyyy", "yy\n", "z"]
        assert [(c.start_line, c.end_line) for c in chunks] == [(1, 1), (2, 2), (2, 2), (3, 3)]

    @pytest.mark.parametrize(
        "text",
        ["a", "\n", "\n\n\n", "a\nb\nc", "a\n\nb\n", "line one\nline two\n", "z" * 100],
    )
    def test_is_a_lossless_partition(self, text):
        for chunk_tokens in (1, 2, 3, 7):
            chunks = _chunk_text(text, chunk_tokens=chunk_tokens)
            max_chars = chunk_tokens * 4
            assert "".join(c.text for c in chunks) == text
            assert [c.index for c in chunks] == list(range(len(chunks)))
            assert all(1 <= len(c.text) <= max_chars for c in chunks)
            assert all(c.start_line <= c.end_line for c in chunks)
            for previous, current in zip(chunks, chunks[1:], strict=False):
                assert current.start_line in (previous.end_line, previous.end_line + 1)
            assert chunks[0].start_line == 1
            assert chunks[-1].end_line <= len(text.split("\n"))

    def test_start_line_counts_preceding_newlines(self):
        text = "aa\nbb\ncc\ndd"
        for chunk in _chunk_text(text, chunk_tokens=1):
            offset = text.index(chunk.text) if text.count(chunk.text) == 1 else None
            if offset is not None:
                assert chunk.start_line == text[:offset].count("\n") + 1

    def test_is_deterministic(self):
        text = "alpha\nbeta\ngamma\n" + "q" * 30
        assert _chunk_text(text, chunk_tokens=2) == _chunk_text(text, chunk_tokens=2)


class TestHasProtectedContent:
    @pytest.mark.parametrize(
        "text",
        [
            "total 1.234",  # thousand separator
            "taxa 0,5 ao mes",  # decimal separator
            "saldo R$ 10",
            "fee $ 9",
            "preco 8 €",
            "amount USD",
            "amount BRL",
            "| a | b |",  # two or more pipes on one line
            "a\tb\tc",  # two or more tabs on one line
            "codigo 123",  # three consecutive digits
            "prosa sem numero\nlinha com 4,20",  # only the second line matches
        ],
    )
    def test_detects_protected_patterns(self, text):
        assert _has_protected_content(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "plain prose with no digits",
            "apenas 42 unidades",  # two digits, no separator
            "a | b",  # single pipe
            "a\tb",  # single tab
            "a | b\nc\td",  # one pipe and one tab, on different lines
            "usd brl",  # lowercase codes are not currency markers
        ],
    )
    def test_ignores_unprotected_text(self, text):
        assert _has_protected_content(text) is False

    def test_is_deterministic_and_does_not_mutate_input(self):
        text = "saldo R$ 1.234,56\noutra linha"
        results = [_has_protected_content(text) for _ in range(5)]
        assert results == [True] * 5
        assert text == "saldo R$ 1.234,56\noutra linha"


class TestSelectChunks:
    def test_empty_chunks_returns_empty_list(self):
        assert _select_chunks([], [], threshold=0.5, budget_chars=100) == []

    def test_misaligned_scores_raise(self):
        with pytest.raises(ValueError, match="align"):
            _select_chunks(_chunks("a"), [0.5, 0.5], threshold=0.5, budget_chars=100)

    def test_keeps_only_chunks_at_or_above_threshold(self):
        chunks = _chunks("aa", "bb", "cc")
        selected = _select_chunks(chunks, [0.9, 0.4, 0.5], threshold=0.5, budget_chars=100)
        assert [c.index for c in selected] == [0, 2]

    def test_returns_ascending_index_order_not_score_order(self):
        chunks = _chunks("aa", "bb", "cc")
        selected = _select_chunks(chunks, [0.6, 0.9, 0.7], threshold=0.5, budget_chars=100)
        assert [c.index for c in selected] == [0, 1, 2]

    def test_visits_all_candidates_so_a_smaller_one_still_fits(self):
        # Budget 7: the top-scored 5-char chunk fits, the 4-char runner-up does not,
        # and the 2-char chunk with the lowest score still does.
        chunks = _chunks("aaaaa", "bbbb", "cc")
        selected = _select_chunks(chunks, [0.9, 0.8, 0.6], threshold=0.5, budget_chars=7)
        assert [c.index for c in selected] == [0, 2]

    def test_ties_are_broken_by_ascending_index(self):
        chunks = _chunks("aa", "bb")
        selected = _select_chunks(chunks, [0.7, 0.7], threshold=0.5, budget_chars=2)
        assert [c.index for c in selected] == [0]

    def test_empty_selection_guard_picks_highest_score(self):
        chunks = _chunks("aa", "bb", "cc")
        selected = _select_chunks(chunks, [0.1, 0.3, 0.2], threshold=0.9, budget_chars=100)
        assert [c.index for c in selected] == [1]

    def test_empty_selection_guard_breaks_ties_by_index(self):
        chunks = _chunks("aa", "bb")
        selected = _select_chunks(chunks, [0.2, 0.2], threshold=0.9, budget_chars=100)
        assert [c.index for c in selected] == [0]

    def test_single_candidate_larger_than_budget_is_selected(self):
        chunks = _chunks("a" * 20, "b" * 30)
        selected = _select_chunks(chunks, [0.6, 0.9], threshold=0.5, budget_chars=10)
        assert [c.index for c in selected] == [1]

    def test_budget_is_respected_when_more_than_one_chunk_fits(self):
        chunks = _chunks("aaaa", "bbbb", "cccc")
        selected = _select_chunks(chunks, [0.9, 0.8, 0.7], threshold=0.5, budget_chars=8)
        assert sum(len(c.text) for c in selected) <= 8

    def test_no_repetition_and_deterministic(self):
        chunks = _chunks("aa", "bbbb", "cc", "dddd")
        scores = [0.9, 0.9, 0.5, 0.7]
        first = _select_chunks(chunks, scores, threshold=0.5, budget_chars=8)
        second = _select_chunks(chunks, scores, threshold=0.5, budget_chars=8)
        assert first == second
        assert len({c.index for c in first}) == len(first)


class TestAssemblePreview:
    def test_empty_inputs_return_empty_string(self):
        chunks = _chunks("aa")
        assert _assemble_preview([], [], budget_chars=100) == ""
        assert _assemble_preview(chunks, [], budget_chars=100) == ""
        assert _assemble_preview(chunks, chunks, budget_chars=0) == ""

    def test_adjacent_chunks_are_concatenated_verbatim(self):
        chunks = _chunks("aa\n", "bb\n", "cc")
        assert _assemble_preview(chunks, chunks, budget_chars=100) == "aa\nbb\ncc"

    def test_gap_marker_counts_omitted_lines_between_non_adjacent_chunks(self):
        chunks = [
            Chunk(index=0, text="aa", start_line=1, end_line=2),
            Chunk(index=1, text="bb", start_line=3, end_line=7),
            Chunk(index=2, text="cc", start_line=8, end_line=9),
        ]
        preview = _assemble_preview(chunks, [chunks[0], chunks[2]], budget_chars=100)
        # start_line 8 - end_line 2 - 1 = 5 lines omitted.
        assert preview == "aa" + _format_gap_marker(5) + "cc"

    def test_gap_marker_is_skipped_when_it_does_not_fit(self):
        chunks = _chunks("aa", "bb", "cc")
        preview = _assemble_preview(chunks, [chunks[0], chunks[2]], budget_chars=4)
        assert preview == "aacc"

    def test_last_chunk_is_truncated_at_line_boundary_with_closing_marker(self):
        chunk = Chunk(index=0, text="aaa\n" * 10, start_line=1, end_line=10)
        budget = 35
        preview = _assemble_preview([chunk], [chunk], budget_chars=budget)
        assert preview == "aaa\naaa\n" + _format_gap_marker(8)
        assert len(preview) <= budget

    def test_earlier_chunks_stay_intact_when_the_last_one_is_truncated(self):
        chunks = [
            Chunk(index=0, text="aaa\n", start_line=1, end_line=1),
            Chunk(index=1, text="bbb\nccc\n", start_line=2, end_line=3),
        ]
        preview = _assemble_preview(chunks, chunks, budget_chars=8)
        assert preview.startswith("aaa\n")
        assert preview == "aaa\nbbb\n"
        assert len(preview) <= 8

    def test_truncation_falls_back_to_character_count_when_no_line_fits(self):
        chunk = Chunk(index=0, text="aaaaaaaaaa\nbbb\n", start_line=1, end_line=2)
        preview = _assemble_preview([chunk], [chunk], budget_chars=4)
        assert preview == "aaaa"

    def test_chunk_without_remaining_budget_merges_into_a_single_marker(self):
        chunks = [
            Chunk(index=0, text="aa", start_line=1, end_line=1),
            Chunk(index=1, text="bb", start_line=2, end_line=2),
            Chunk(index=2, text="cc", start_line=3, end_line=5),
        ]
        budget = 2 + len(_format_gap_marker(1))
        preview = _assemble_preview(chunks, [chunks[0], chunks[2]], budget_chars=budget)
        # One line for the gap plus the three lines of the dropped chunk.
        assert preview == "aa" + _format_gap_marker(4)
        assert len(preview) <= budget

    def test_budget_is_never_exceeded(self):
        chunks = [
            Chunk(index=0, text="aaa\naaa\n", start_line=1, end_line=2),
            Chunk(index=1, text="bbb\n", start_line=3, end_line=3),
            Chunk(index=2, text="ccc\nccc\n", start_line=4, end_line=5),
        ]
        for budget in range(1, 80):
            preview = _assemble_preview(chunks, [chunks[0], chunks[2]], budget_chars=budget)
            assert len(preview) <= budget

    def test_non_empty_source_yields_at_least_one_source_character(self):
        chunk = Chunk(index=0, text="aaaaa\nbbbbb\n", start_line=1, end_line=2)
        for budget in range(1, 15):
            preview = _assemble_preview([chunk], [chunk], budget_chars=budget)
            assert "a" in preview


class FakeReranker:
    """Deterministic scorer for tests: keyword hit, no network.

    Records every call so tests can assert on invocation count and arguments.
    """

    max_sources_per_query = 100

    def __init__(self, keyword: str = "", *, scores: list[float] | None = None) -> None:
        self._keyword = keyword
        self._scores = scores
        self.calls: list[tuple[str, list[str]]] = []

    async def score(self, query: str, chunks: list[str]) -> list[float]:
        self.calls.append((query, list(chunks)))
        if self._scores is not None:
            return list(self._scores)
        return [1.0 if self._keyword and self._keyword in chunk else 0.0 for chunk in chunks]


class RaisingReranker:
    """Scorer that always fails, to check the error reaches the caller."""

    max_sources_per_query = 100

    async def score(self, query: str, chunks: list[str]) -> list[float]:
        raise RerankerError("scoring unavailable")


def _preview(reranker, *, threshold=0.5, chunk_tokens=1, preview_tokens=4, summarize_overflow=False):
    """Build a RelevancePreview with small budgets so tests stay readable."""
    return RelevancePreview(
        reranker,
        relevance_threshold=threshold,
        chunk_tokens=chunk_tokens,
        preview_tokens=preview_tokens,
        summarize_overflow=summarize_overflow,
    )


class TestRelevancePreviewBuild:
    @pytest.mark.asyncio
    async def test_empty_text_returns_empty_preview_without_scoring(self):
        reranker = FakeReranker("needle")
        assert await _preview(reranker).build("", "query") == ""
        assert reranker.calls == []

    @pytest.mark.asyncio
    async def test_single_chunk_within_budget_returns_text_verbatim_without_scoring(self):
        reranker = FakeReranker("needle")
        # chunk_tokens=4 -> one chunk of up to 16 chars; preview budget is 16 chars too.
        text = "short answer\n"
        builder = _preview(reranker, chunk_tokens=4, preview_tokens=4)

        assert await builder.build(text, "query") == text
        assert reranker.calls == []

    @pytest.mark.asyncio
    async def test_single_chunk_over_budget_is_scored(self):
        # chunk_tokens=10 -> one chunk of up to 40 chars; preview budget is only 8.
        text = "line one\nline two\n"
        reranker = FakeReranker("line")
        builder = _preview(reranker, chunk_tokens=10, preview_tokens=2)

        preview = await builder.build(text, "query")

        assert len(reranker.calls) == 1
        assert len(preview) <= 8
        assert "line one" in preview

    @pytest.mark.asyncio
    async def test_keeps_the_relevant_chunk_and_marks_the_gap(self):
        text = "aaa\nbbb\nkey\n"
        reranker = FakeReranker("key")
        # chunk_tokens=1 -> 4 chars per chunk, so one chunk per line.
        builder = _preview(reranker, chunk_tokens=1, preview_tokens=10)

        preview = await builder.build(text, "where is key")

        assert preview == "key\n"
        assert len(reranker.calls) == 1
        assert reranker.calls[0] == ("where is key", ["aaa\n", "bbb\n", "key\n"])

    @pytest.mark.asyncio
    async def test_selected_chunks_keep_source_order_with_a_gap_marker(self):
        text = "key one\nfiller!\nkey two\n"
        reranker = FakeReranker("key")
        # Budget wide enough to hold both chunks plus the marker between them.
        builder = _preview(reranker, chunk_tokens=2, preview_tokens=20)

        preview = await builder.build(text, "keys")

        assert preview == "key one\n" + _format_gap_marker(1) + "key two\n"

    @pytest.mark.asyncio
    async def test_scores_every_chunk_exactly_once_per_build(self):
        text = "aaa\nbbb\nccc\nddd\n"
        reranker = FakeReranker("aaa")
        builder = _preview(reranker, chunk_tokens=1, preview_tokens=10)

        await builder.build(text, "query")

        assert len(reranker.calls) == 1
        assert reranker.calls[0][1] == ["aaa\n", "bbb\n", "ccc\n", "ddd\n"]

    @pytest.mark.asyncio
    async def test_never_exceeds_the_preview_budget(self):
        text = "".join(f"line {i:02d}\n" for i in range(20))
        reranker = FakeReranker("line")

        for preview_tokens in range(1, 30):
            builder = _preview(reranker, chunk_tokens=2, preview_tokens=preview_tokens)
            preview = await builder.build(text, "query")
            assert len(preview) <= preview_tokens * 4

    @pytest.mark.asyncio
    async def test_non_empty_text_never_yields_an_empty_preview(self):
        text = "".join(f"row {i}\n" for i in range(10))
        # Nothing reaches the threshold: the empty-selection guard still keeps a chunk.
        reranker = FakeReranker("absent")
        builder = _preview(reranker, chunk_tokens=1, preview_tokens=5)

        preview = await builder.build(text, "query")

        assert preview != ""

    @pytest.mark.asyncio
    async def test_reranker_error_propagates_to_the_caller(self):
        builder = _preview(RaisingReranker(), chunk_tokens=1, preview_tokens=2)

        with pytest.raises(RerankerError, match="scoring unavailable"):
            await builder.build("aaa\nbbb\nccc\n", "query")

    @pytest.mark.asyncio
    async def test_is_deterministic(self):
        text = "alpha\nbeta\ngamma\ndelta\n"
        reranker = FakeReranker(scores=[0.9, 0.1, 0.8, 0.2])
        builder = _preview(reranker, chunk_tokens=2, preview_tokens=6)

        first = await builder.build(text, "query")
        second = await builder.build(text, "query")

        assert first == second

    @pytest.mark.asyncio
    async def test_summarize_overflow_flag_is_accepted_without_changing_the_preview(self):
        text = "aaa\nkey\nbbb\n"
        verbatim = await _preview(FakeReranker("key"), chunk_tokens=1, preview_tokens=10).build(text, "q")
        with_flag = await _preview(
            FakeReranker("key"), chunk_tokens=1, preview_tokens=10, summarize_overflow=True
        ).build(text, "q")

        assert with_flag == verbatim


class TestValidateScores:
    def test_accepts_a_well_formed_score_list(self):
        assert _validate_scores([0.0, 0.5, 1.0], 3) == [0.0, 0.5, 1.0]

    def test_accepts_empty_list_for_zero_chunks(self):
        assert _validate_scores([], 0) == []

    def test_accepts_integers_and_converts_them_to_float(self):
        validated = _validate_scores([0, 1], 2)

        assert validated == [0.0, 1.0]
        assert all(isinstance(score, float) for score in validated)

    @pytest.mark.parametrize("scores", [[0.5], [0.5, 0.5, 0.5], []])
    def test_rejects_a_length_mismatch(self, scores):
        with pytest.raises(RerankerError, match="scores for 2 chunks"):
            _validate_scores(scores, 2)

    @pytest.mark.parametrize("score", ["0.5", None, True, False, [0.5], object()])
    def test_rejects_non_numeric_values(self, score):
        with pytest.raises(RerankerError, match="is not a number"):
            _validate_scores([score], 1)

    @pytest.mark.parametrize("score", [float("nan"), float("inf"), float("-inf")])
    def test_rejects_non_finite_values(self, score):
        with pytest.raises(RerankerError, match="is not finite"):
            _validate_scores([score], 1)

    @pytest.mark.parametrize("score", [-0.1, 1.1, 2.0, -1])
    def test_rejects_values_outside_the_unit_interval(self, score):
        with pytest.raises(RerankerError, match=r"outside \[0.0, 1.0\]"):
            _validate_scores([score], 1)

    def test_rejects_a_non_sequence_result(self):
        with pytest.raises(RerankerError, match="must return a list of scores"):
            _validate_scores(0.5, 1)

    def test_reports_the_offending_index(self):
        with pytest.raises(RerankerError, match="index 2"):
            _validate_scores([0.1, 0.2, 5.0], 3)

    def test_does_not_mutate_the_received_list(self):
        scores = [0.1, 0.2]
        validated = _validate_scores(scores, 2)

        assert scores == [0.1, 0.2]
        assert validated is not scores


class BadContractReranker:
    """Scorer that violates the contract by returning ``scores`` verbatim."""

    max_sources_per_query = 100

    def __init__(self, scores) -> None:
        self._scores = scores
        self.calls = 0

    async def score(self, query: str, chunks: list[str]):
        self.calls += 1
        return self._scores


class TestRelevancePreviewRejectsBadScores:
    TEXT = "aaa\nbbb\nccc\nddd\n"

    @pytest.mark.parametrize(
        "scores",
        [
            [0.5, 0.5],  # too few
            [0.5] * 5,  # too many
            [0.5, 0.5, "0.5", 0.5],  # non-numeric
            [0.5, 0.5, float("nan"), 0.5],  # non-finite
            [0.5, 0.5, float("inf"), 0.5],  # non-finite
            [0.5, 0.5, 1.5, 0.5],  # above range
            [0.5, 0.5, -0.5, 0.5],  # below range
            [0.5, True, 0.5, 0.5],  # boolean masquerading as a score
            0.5,  # not a list at all
        ],
    )
    @pytest.mark.asyncio
    async def test_contract_violation_raises_reranker_error(self, scores):
        reranker = BadContractReranker(scores)
        builder = _preview(reranker, chunk_tokens=1, preview_tokens=2)

        with pytest.raises(RerankerError):
            await builder.build(self.TEXT, "query")

        # The scorer is not retried for the same tool result.
        assert reranker.calls == 1

    @pytest.mark.asyncio
    async def test_error_path_leaves_the_source_text_untouched(self):
        text = self.TEXT
        builder = _preview(BadContractReranker([2.0, 2.0, 2.0, 2.0]), chunk_tokens=1, preview_tokens=2)

        with pytest.raises(RerankerError):
            await builder.build(text, "query")

        assert text == "aaa\nbbb\nccc\nddd\n"


class TestSearchUnitCounter:
    """The billable-unit counter carried by RelevancePreview."""

    @pytest.mark.asyncio
    async def test_starts_at_zero_and_shortcuts_spend_nothing(self):
        builder = _preview(FakeReranker("needle"), chunk_tokens=4, preview_tokens=4)
        assert builder.search_units == 0

        await builder.build("", "query")
        await builder.build("short answer\n", "query")

        assert builder.search_units == 0

    @pytest.mark.asyncio
    async def test_one_unit_per_batch_sent(self):
        text = "".join(f"row {i}\n" for i in range(10))
        reranker = FakeReranker("row")
        reranker.max_sources_per_query = 4
        # chunk_tokens=2 -> 8 chars per chunk, so one chunk per 6-char line.
        builder = _preview(reranker, chunk_tokens=2, preview_tokens=10)

        await builder.build(text, "query")

        # Ten chunks in batches of four: three batches.
        assert builder.search_units == 3

    @pytest.mark.asyncio
    async def test_accumulates_across_builds_and_counts_failed_calls(self):
        text = "aaa\nbbb\n"
        builder = _preview(FakeReranker("aaa"), chunk_tokens=1, preview_tokens=10)

        await builder.build(text, "query")
        await builder.build(text, "query")

        assert builder.search_units == 2

        failing = _preview(RaisingReranker(), chunk_tokens=1, preview_tokens=10)
        with pytest.raises(RerankerError):
            await failing.build(text, "query")

        assert failing.search_units == 1
