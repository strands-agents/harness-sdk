"""Unit tests of ``describe.py``: the literal contracts, and the tag selection built on top of them.

All three promise the same kind of thing — that the output is found character for character in the
input — so almost every assertion below is a substring or ``startswith`` check rather than an equality
against a hand-written expectation. That is deliberate: an equality test would pin down the exact cut
position, which is an implementation choice, while the prefix property is the contract. The cut order
is the one exception, because *which* boundary the cut prefers is itself the requirement.

The numeric selection is checked against the shared ``NUMERIC_LINES`` samples so the suite and the
implementation disagree about currency, thousands separators, tabular form and unicode in one place
instead of two.

``select_tags`` is checked at the two ends of ``rarity_weight`` rather than against a hand-computed
score. Pinning the score of a candidate would freeze the formula in a number, and the formula's weights
are explicitly uncalibrated — what the requirement fixes is that rarity only ever helps, which the
monotonicity test states directly and which the property test of task 6.5 generalizes.
"""

import pytest

from strands.vended_plugins.context_graph.describe import (
    _CHARS_PER_TOKEN,
    _TITLE_TOKENS,
    _estimate_tokens,
    compose_description,
    normalize,
    numeric_lines,
    select_tags,
    tag_candidates,
    title_for,
)
from strands.vended_plugins.context_graph.state import Card, ToolPair

from .strategies import NUMERIC_LINES

MAX_TITLE_CHARS = _TITLE_TOKENS * _CHARS_PER_TOKEN

PROSE_LINES = (
    "please review the connector integration",
    "abc123 is an opaque identifier",
    "bumped to version v1.2 yesterday",
    "",
    "   ",
)
"""Lines carrying no standalone number: identifiers with glued digits, a dotted version, and blanks."""


# --- title_for -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "user_text",
    [
        "",
        "hi",
        "what is the balance?",
        "a" * MAX_TITLE_CHARS,
    ],
)
def test_short_message_is_returned_unchanged(user_text):
    """Requirement 4.1: a message already within the ceiling is its own Title."""
    assert title_for(user_text) == user_text


def test_long_message_is_cut_at_a_word_boundary():
    """Requirement 4.1: the cut lands on whitespace, so no word is left broken in half."""
    user_text = "reconcile the open positions against the custodian statement of last friday"

    title = title_for(user_text)

    assert user_text.startswith(title)
    assert len(title) < len(user_text)
    assert not title.endswith(" ")
    # The character just past the cut is whitespace: the Title ends where a word ends.
    assert user_text[len(title)].isspace()


def test_single_word_longer_than_the_budget_is_cut_by_character_count():
    """Requirement 4.1: no word boundary fits, so the cut falls back to the character ceiling."""
    user_text = "x" * (MAX_TITLE_CHARS * 3)

    title = title_for(user_text)

    assert user_text.startswith(title)
    assert len(title) == MAX_TITLE_CHARS


@pytest.mark.parametrize(
    "user_text",
    [
        "reconcile the open positions against the custodian statement of last friday",
        "x" * 500,
        "R$ 1.200,00 " * 20,
        "\u00a0".join(["saldo"] * 40),
    ],
)
def test_title_is_a_literal_prefix_within_the_token_ceiling(user_text):
    """Requirement 4.1: the contract, on every shape of long message."""
    title = title_for(user_text)

    assert user_text.startswith(title)
    assert _estimate_tokens(title) <= _TITLE_TOKENS


def test_title_is_deterministic():
    """Requirement 4.10: two runs over the same message agree character for character."""
    user_text = "compare the two connectors and report the latency of each one of them"

    assert title_for(user_text) == title_for(user_text)


# --- numeric_lines ----------------------------------------------------------------------------


@pytest.mark.parametrize("line", NUMERIC_LINES)
def test_every_numeric_shape_is_selected_literally(line):
    """Requirement 4.4: currency, thousands separator, tabular form and unicode, copied verbatim."""
    assert numeric_lines([line]) == (line,)


@pytest.mark.parametrize(
    "line",
    [
        "R$ 1.200,00",
        "BRL1.2mi em caixa",
        "USD 4,50",
        "total 12 EUR",
        "\u20ac 99,90",
    ],
)
def test_monetary_lines_are_selected(line):
    """Requirement 4.4: a digit next to a currency marker, symbol or glued ISO code."""
    assert numeric_lines([line]) == (line,)


@pytest.mark.parametrize(
    "line",
    [
        "| ativo | 12,50 | 3.400 |",
        "| sku | ABC123 | X9 |",
        "ativo\t12,50\t3.400",
    ],
)
def test_tabular_lines_are_selected(line):
    """Requirement 4.4: a row of cells carrying a digit, even when every digit is glued to a word."""
    assert numeric_lines([line]) == (line,)


@pytest.mark.parametrize("line", PROSE_LINES)
def test_prose_and_blank_lines_are_not_selected(line):
    """Requirement 4.4: selection is by pattern; a digit inside a word is not a number."""
    assert numeric_lines([line]) == ()


def test_selection_preserves_indentation_and_surrounding_characters():
    """Requirement 4.4: the line is copied literally, indentation included, so a table still lines up."""
    text = "resumo:\n    | ativo | 12,50 |\n    | passivo | 3.400 |\n"

    assert numeric_lines([text]) == ("    | ativo | 12,50 |", "    | passivo | 3.400 |")


def test_lines_come_out_in_order_of_first_appearance():
    """Requirement 4.10: text order, then line order — the only ordering that is reproducible."""
    first = "saldo: 1.200,00\nnota de rodape\ntotal: 3.451,90 BRL"
    second = "| ativo | 12,50 |"

    assert numeric_lines([first, second]) == (
        "saldo: 1.200,00",
        "total: 3.451,90 BRL",
        "| ativo | 12,50 |",
    )


def test_exact_duplicates_are_dropped():
    """The same balance repeated across tool results is one line of signal and two of budget."""
    assert numeric_lines(["saldo: 1.200,00", "saldo: 1.200,00", " saldo: 1.200,00"]) == (
        "saldo: 1.200,00",
        " saldo: 1.200,00",
    )


def test_every_selected_line_is_an_exact_substring_of_its_text():
    """Requirement 4.4: no paraphrase and no character reordering, asserted by substring."""
    text = "\n".join(NUMERIC_LINES + PROSE_LINES)

    for line in numeric_lines([text]):
        assert line in text


def test_empty_input_selects_nothing():
    """A Card whose messages carry no text is a Card with no numeric lines, not an error."""
    assert numeric_lines([]) == ()
    assert numeric_lines(["", "\n\n"]) == ()


def test_selection_is_deterministic():
    """Requirement 4.10: two runs over the same texts agree character for character."""
    texts = ["saldo: 1.200,00\nprosa", "| ativo | 12,50 | 3.400 |"]

    assert numeric_lines(texts) == numeric_lines(texts)


# --- compose_description ----------------------------------------------------------------------


UNBOUNDED = 10**6
"""A budget no Description reaches, which is how a test gets the complete Description to compare against."""

SAMPLE_LINES = (
    "R$ 1.200,00",
    "1.200,00",
    "1200",
    "total: 3.451,90 BRL",
    "| ativo | 12,50 | 3.400 |",
)
"""Five literal lines, long enough that a small budget has to leave some of them out."""


def subject_card(**overrides):
    """Build a subject Card, defaults filled in, so each test states only what it is about."""
    fields = {
        "title": "reconcile the open positions",
        "kind": "subject",
        "turn": 3,
        "dialogue_ids": ("d1",),
        "evidence_ids": ("e1",),
        "pairs": (),
        "tool_names": frozenset(),
        "references": (),
        "numeric_lines": (),
        "tags": (),
        "description": "",
    }
    fields.update(overrides)
    return Card(**fields)


def artifact_card(**overrides):
    """Build an artifact Card, defaults filled in and textual unless a test says otherwise."""
    fields = {
        "title": "ref-7",
        "kind": "artifact",
        "turn": 4,
        "dialogue_ids": (),
        "evidence_ids": ("e1",),
        "pairs": (ToolPair(tool_use_id="u1", tool_name="fetch_positions", tracking_ids=("e1",), consumed=True),),
        "tool_names": frozenset({"fetch_positions"}),
        "references": ("s3://bucket/statement.txt",),
        "numeric_lines": (),
        "tags": (),
        "description": "",
        "reference": "s3://bucket/statement.txt",
        "content_type": "text/plain",
        "size_bytes": 4096,
    }
    fields.update(overrides)
    return Card(**fields)


def pair(tool_name, tool_use_id):
    """A consumed tool pair, which is all these tests need out of one."""
    return ToolPair(tool_use_id=tool_use_id, tool_name=tool_name, tracking_ids=(tool_use_id,), consumed=True)


def test_subject_description_carries_name_tools_references_and_lines():
    """Requirement 4.3: the four parts of a subject Description, all present."""
    card = subject_card(
        pairs=(pair("run_query", "u1"), pair("run_query", "u2"), pair("read_file", "u3")),
        tool_names=frozenset({"run_query", "read_file"}),
        references=("ref-7", "ref-9"),
        numeric_lines=("saldo: 1.200,00",),
    )

    description = compose_description(card, UNBOUNDED)

    assert description.startswith("reconcile the open positions")
    assert "run_query (2)" in description
    assert "read_file (1)" in description
    assert "ref-7" in description
    assert "ref-9" in description
    assert "saldo: 1.200,00" in description


def test_tool_counts_follow_first_appearance_among_the_pairs():
    """Requirement 4.10: never set iteration order — string hashing is seeded per process."""
    card = subject_card(
        pairs=(pair("read_file", "u1"), pair("run_query", "u2"), pair("read_file", "u3")),
        tool_names=frozenset({"read_file", "run_query"}),
    )

    assert "tools: read_file (2), run_query (1)" in compose_description(card, UNBOUNDED)


def test_tool_named_without_a_pair_is_counted_once():
    """A ``toolUse`` whose result was never paired is still a call that happened."""
    card = subject_card(pairs=(), tool_names=frozenset({"list_connectors"}))

    assert "tools: list_connectors (1)" in compose_description(card, UNBOUNDED)


def test_subject_description_omits_absent_lines_entirely():
    """A Card with no tools and no references spends no budget saying so."""
    description = compose_description(subject_card(), UNBOUNDED)

    assert description == "reconcile the open positions"


def test_textual_artifact_description_carries_reference_tool_turn_and_lines():
    """Requirement 4.7: the four parts of a textual artifact Description."""
    card = artifact_card(numeric_lines=("total: 3.451,90 BRL",))

    description = compose_description(card, UNBOUNDED)

    assert "reference: s3://bucket/statement.txt" in description
    assert "tool: fetch_positions" in description
    assert "turn: 4" in description
    assert "total: 3.451,90 BRL" in description


@pytest.mark.parametrize(
    "content_type",
    ["text/plain", "text/csv", "application/json", "application/vnd.api+json", "TEXT/HTML; charset=utf-8"],
)
def test_textual_content_types_keep_their_lines(content_type):
    """Requirement 4.7: the lines belong to any content that can be read as text."""
    card = artifact_card(content_type=content_type, numeric_lines=("1.200,00",))

    assert "1.200,00" in compose_description(card, UNBOUNDED)


@pytest.mark.parametrize("content_type", ["application/pdf", "image/png", "application/octet-stream", None])
def test_non_textual_artifact_description_is_exclusively_metadata(content_type):
    """Requirement 4.8: file name, content type, size, tool, turn and reference — and nothing else."""
    card = artifact_card(
        content_type=content_type,
        reference="s3://bucket/report.pdf",
        references=("s3://bucket/report.pdf",),
        numeric_lines=("total: 3.451,90 BRL", "| ativo | 12,50 |"),
    )

    description = compose_description(card, UNBOUNDED)

    assert "file: report.pdf" in description
    assert "size: 4096 bytes" in description
    assert "tool: fetch_positions" in description
    assert "turn: 4" in description
    assert "reference: s3://bucket/report.pdf" in description
    # Bytes that were never text have no lines to copy, so none appear.
    assert "3.451,90" not in description
    assert "12,50" not in description
    if content_type is not None:
        assert f"content_type: {content_type}" in description


def test_omitted_lines_are_counted_in_the_description():
    """Requirement 4.6: the first lines get in, and the Description states how many did not."""
    card = subject_card(title="saldos", numeric_lines=SAMPLE_LINES)

    description = compose_description(card, 15)

    kept = [line for line in SAMPLE_LINES if line in description]
    assert kept == list(SAMPLE_LINES[: len(kept)])  # the leading run, never a later short line
    assert f"(+{len(SAMPLE_LINES) - len(kept)} numeric lines omitted)" in description
    assert _estimate_tokens(description) <= 15


def test_every_line_may_be_left_out_and_still_be_counted():
    """Requirement 4.6: a budget that fits no line at all still reports the gap instead of hiding it."""
    card = subject_card(title="saldos", numeric_lines=SAMPLE_LINES)

    description = compose_description(card, 10)

    assert description == "saldos\n(+5 numeric lines omitted)"


def test_kept_portion_is_a_literal_prefix_of_the_complete_description():
    """Requirement 4.5: strip the omission line, and what remains is found verbatim in the complete one."""
    card = subject_card(
        title="saldos consolidados do trimestre",
        pairs=(pair("run_query", "u1"),),
        tool_names=frozenset({"run_query"}),
        references=("ref-7",),
        numeric_lines=SAMPLE_LINES,
    )
    complete = compose_description(card, UNBOUNDED)

    for budget in range(12, 60):
        description = compose_description(card, budget)
        kept = description.rsplit("\n", 1)[0] if "omitted)" in description else description

        assert complete.startswith(kept)
        assert _estimate_tokens(description) <= budget


@pytest.mark.parametrize(
    "title, budget, expected",
    [
        # A sentence boundary fits: the cut lands after the terminator, with no ellipse.
        ("First sentence here. Second sentence follows and runs long.", 8, "First sentence here."),
        # No sentence boundary fits, so the cut falls back to the last word boundary.
        ("alpha beta gamma delta epsilon zeta eta theta", 4, "alpha beta gamma"),
        # A single token longer than the whole budget: neither boundary fits, so the ceiling decides.
        ("x" * 200, 4, "x" * 16),
    ],
)
def test_cut_prefers_sentence_then_word_then_character_count(title, budget, expected):
    """Requirement 4.5: the ``_truncate_description`` mold, minus the ellipse that would break the prefix."""
    description = compose_description(subject_card(title=title), budget)

    assert description == expected
    assert title.startswith(description)


def test_description_that_already_fits_is_returned_whole():
    """Requirement 4.5: the budget is a ceiling, not a target — nothing is cut that fits."""
    card = subject_card(title="saldos", numeric_lines=("1200",))

    assert compose_description(card, UNBOUNDED) == "saldos\n1200"


@pytest.mark.parametrize("budget", [1, 2, 5, 20, 100])
def test_description_never_exceeds_the_budget(budget):
    """Requirement 4.5: on every kind of Card, at every budget, including the ones that fit nothing."""
    candidates = (
        subject_card(numeric_lines=SAMPLE_LINES, pairs=(pair("run_query", "u1"),), references=("ref-7",)),
        artifact_card(numeric_lines=SAMPLE_LINES),
        artifact_card(content_type="application/pdf", reference="s3://bucket/report.pdf"),
    )

    for card in candidates:
        assert _estimate_tokens(compose_description(card, budget)) <= budget


@pytest.mark.parametrize("budget", [4, 25, UNBOUNDED])
def test_composition_is_deterministic(budget):
    """Requirement 4.10: two runs over the same Card agree character for character."""
    card = subject_card(
        pairs=(pair("run_query", "u1"), pair("read_file", "u2")),
        tool_names=frozenset({"run_query", "read_file", "list_connectors"}),
        references=("ref-7", "ref-7", "ref-9"),
        numeric_lines=SAMPLE_LINES,
    )

    assert compose_description(card, budget) == compose_description(card, budget)


def test_repeated_references_are_listed_once():
    """The same reference cited three times is one address and two lines of budget."""
    card = subject_card(references=("ref-7", "ref-7", "ref-9"))

    assert "references: ref-7, ref-9" in compose_description(card, UNBOUNDED)


def test_every_kept_line_appears_verbatim():
    """Requirement 4.4: composition copies the line, it never rewords it."""
    card = subject_card(numeric_lines=NUMERIC_LINES)

    description = compose_description(card, UNBOUNDED)

    for line in NUMERIC_LINES:
        assert line in description


# --- normalize --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "token",
    [
        "R$ 1.200,00",
        "1.200,00",
        "1,200.00",
        "1200",
        "1200,00",
        "1\u00a0200,00",
        "1.200",
        "US$1200",
        "BRL 1.200,00",
        "1200 USD",
    ],
)
def test_monetary_and_separator_forms_collapse_onto_the_same_number(token):
    """Requirement 5.6: the one collapse that matters, across currency and separator shapes."""
    assert normalize(token) == "1200"


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("1.2", "1.2"),
        ("0.500", "0.5"),
        ("0,5", "0.5"),
        ("-1200", "-1200"),
        ("+1200", "1200"),
        ("1.200.000", "1200000"),
        ("0", "0"),
        ("000", "0"),
    ],
)
def test_number_shapes_keep_the_value_they_carry(token, expected):
    """A fraction stays a fraction: reading ``0.500`` as thousands would turn it into ``500``."""
    assert normalize(token) == expected


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("Connector", "connector"),
        ("  connector, ", "connector"),
        ("(billing)", "billing"),
        ("Get_Balance", "get_balance"),
        ("v1.2", "v1.2"),
        ("2024-03", "2024-03"),
        ("s3://bucket/Statement.TXT", "s3://bucket/statement.txt"),
        ("POSIÇÕES", "posições"),
    ],
)
def test_non_numeric_candidates_are_casefolded_and_stripped_at_the_edges(token, expected):
    """Punctuation inside a candidate is part of it: ``get_balance`` without its mark is two words."""
    assert normalize(token) == expected


@pytest.mark.parametrize("token", ["", "   ", "...", "(),"])
def test_a_candidate_carrying_nothing_normalizes_to_nothing(token):
    """Nothing but punctuation is nothing to compare against, and never becomes a tag."""
    assert normalize(token) == ""


def test_a_plural_is_left_to_similarity():
    """Requirement 5.6 stops at numbers on purpose: the tag is a shortcut, not the only route."""
    assert normalize("position") != normalize("positions")


def test_normalization_is_deterministic():
    """Requirement 5.9: same input, same output, character for character."""
    tokens = ["R$ 1.200,00", "Connector", "positions", "0.500"]

    assert [normalize(token) for token in tokens] == [normalize(token) for token in tokens]


# --- tag_candidates ---------------------------------------------------------------------------


def test_structural_candidates_come_from_tool_names_and_references():
    """Requirement 5.2: two of the three sources, normalized and deduplicated."""
    card = subject_card(
        pairs=(pair("Run_Query", "u1"), pair("read_file", "u2")),
        tool_names=frozenset({"Run_Query", "read_file"}),
        references=("s3://bucket/Statement.txt", "s3://bucket/Statement.txt"),
    )

    structural, _ = tag_candidates(card)

    assert structural == ("run_query", "read_file", "s3://bucket/statement.txt")


def test_the_reference_of_an_artifact_card_is_a_structural_candidate():
    """The reference of an artifact Card is what defines it, so it is never left out.

    Requirement 5.3 puts tool names and references on the same footing, so the assertion is membership
    and not position — the two are both structural, and neither outranks the other.
    """
    structural, _ = tag_candidates(artifact_card())

    assert "s3://bucket/statement.txt" in structural


def test_textual_candidates_are_counted_by_occurrence():
    """Requirement 5.2: the third source, a regex over the Card's text."""
    _, textual = tag_candidates(subject_card(), ["reconcile the positions", "the positions again"])

    assert textual["positions"] == 2
    assert textual["reconcile"] == 1


def test_textual_candidates_appear_in_order_of_first_appearance():
    """The order is the tie-break of ``select_tags``, so it has to be the text's order."""
    _, textual = tag_candidates(subject_card(), ["billing connector latency"])

    assert list(textual) == ["billing", "connector", "latency"]


def test_a_candidate_already_structural_is_not_counted_again_as_textual():
    """A tool name mentioned in prose is one candidate, and it is the structural one."""
    card = subject_card(pairs=(pair("run_query", "u1"),), tool_names=frozenset({"run_query"}))

    structural, textual = tag_candidates(card, ["please run_query the ledger"])

    assert "run_query" in structural
    assert "run_query" not in textual


def test_a_number_in_the_text_is_a_candidate_in_normalized_form():
    """The identifier an embedding confuses is usually an amount, so an amount is a candidate."""
    _, textual = tag_candidates(subject_card(), ["saldo de R$ 1.200,00 hoje", "e o de 1200?"])

    assert textual["1200"] == 2


def test_common_words_are_candidates_because_rarity_replaces_a_stopword_list():
    """Requirement 5.2: no declared list. ``please`` gets in here and loses in ``select_tags``."""
    _, textual = tag_candidates(subject_card(), ["please review of the connector"])

    assert "please" in textual
    assert "the" in textual  # Three characters, so it gets in — and loses on rarity, not on a list.
    assert "of" not in textual  # Two characters: below the noise floor, which is the only filter.


def test_candidates_in_any_script_are_recognized():
    """A conversation held in Portuguese has its identifiers in Portuguese."""
    _, textual = tag_candidates(subject_card(), ["conciliar as posições do custodiante"])

    assert "posições" in textual


def test_a_card_with_no_text_yields_structural_candidates_only():
    """Requirement 5.8: the extraction is a scan, so no text simply means no textual candidate."""
    card = subject_card(pairs=(pair("run_query", "u1"),), tool_names=frozenset({"run_query"}))

    structural, textual = tag_candidates(card)

    assert structural == ("run_query",)
    assert textual == {}


# --- select_tags ------------------------------------------------------------------------------


UNIFORM_FREQUENCY = {candidate: 2 for candidate in ("connector", "billing", "latency", "release", "refactor")}
"""Every textual candidate equally common, so a test can isolate the repetition term."""


def select(candidates=None, structural=(), frequency=None, total=4, ceiling=5, rarity_weight=0.7):
    """Call ``select_tags`` with the defaults of a small graph, so each test states only its subject."""
    return select_tags(
        candidates=candidates or {},
        structural=structural,
        document_frequency=UNIFORM_FREQUENCY if frequency is None else frequency,
        total_cards=total,
        tags_per_card=ceiling,
        rarity_weight=rarity_weight,
    )


def test_structural_candidates_take_every_slot_before_any_textual_one():
    """Requirement 5.3: a guess about salience never outranks what the turn actually did."""
    tags = select(
        candidates={"connector": 99, "billing": 99},
        structural=("run_query", "read_file", "list_connectors", "fetch_positions", "s3://bucket/a.txt"),
    )

    assert tags == ("run_query", "read_file", "list_connectors", "fetch_positions", "s3://bucket/a.txt")


def test_structural_candidates_beyond_the_ceiling_are_cut():
    """Requirement 5.1: the ceiling holds even when the structural candidates alone exceed it."""
    tags = select(structural=("a1", "b2", "c3", "d4", "e5", "f6", "g7"), ceiling=3)

    assert tags == ("a1", "b2", "c3")


def test_textual_candidates_fill_only_the_slots_structural_ones_left():
    """Requirement 5.3: structural first, and the remainder is what the textual ones compete for."""
    tags = select(candidates={"connector": 3, "billing": 1}, structural=("run_query",), ceiling=3)

    assert tags[0] == "run_query"
    assert len(tags) == 3
    assert set(tags[1:]) == {"connector", "billing"}


def test_no_tags_at_all_when_there_is_nothing_to_choose_from():
    """An empty Card yields an empty tuple rather than a placeholder."""
    assert select() == ()


def test_empty_structural_candidates_do_not_consume_a_slot():
    """A reference that normalizes to nothing is nothing, and never occupies a tag."""
    tags = select(candidates={"connector": 1}, structural=("", "   ", "run_query"), ceiling=2)

    assert tags == ("run_query", "connector")


def test_the_ceiling_is_never_exceeded_by_textual_candidates():
    """Requirement 5.1: at most ``tags_per_card`` tags, whatever the number of candidates."""
    candidates = {candidate: 1 for candidate in ("connector", "billing", "latency", "release", "refactor")}

    assert len(select(candidates=candidates, ceiling=2)) == 2


def test_pure_repetition_orders_by_count_when_rarity_carries_no_weight():
    """Requirement 5.4: ``rarity_weight=0.0`` leaves the repetition term alone in the score."""
    tags = select(
        candidates={"billing": 1, "connector": 5, "latency": 3},
        frequency={"billing": 1, "connector": 9, "latency": 4},
        rarity_weight=0.0,
        ceiling=3,
    )

    assert tags == ("connector", "latency", "billing")


def test_pure_rarity_orders_by_inverse_frequency_when_repetition_carries_no_weight():
    """Requirement 5.4: ``rarity_weight=1.0`` leaves the rarity term alone, and the counts stop mattering."""
    tags = select(
        candidates={"billing": 1, "connector": 5, "latency": 3},
        frequency={"billing": 1, "connector": 9, "latency": 4},
        total=9,
        rarity_weight=1.0,
        ceiling=3,
    )

    assert tags == ("billing", "latency", "connector")


def test_the_two_terms_are_combined_rather_than_one_overriding_the_other():
    """Requirement 5.4: with the default weight, rarity outweighs a threefold repetition advantage."""
    tags = select(
        candidates={"connector": 3, "billing": 1},
        frequency={"connector": 5, "billing": 1},
        total=5,
        ceiling=1,
    )

    assert tags == ("billing",)


def test_a_tie_is_broken_by_order_of_first_appearance():
    """Requirement 5.9: identical scores resolve by the text's order, never by dict iteration luck."""
    candidates = {"latency": 2, "billing": 2, "connector": 2}

    assert select(candidates=candidates, ceiling=2) == ("latency", "billing")


def test_making_a_candidate_rarer_never_lowers_its_position():
    """Requirement 5.4: the rarity term only ever helps — the monotonicity the ranking rests on."""
    candidates = {"connector": 5, "billing": 1}
    common = {"connector": 1, "billing": 6}
    rare = {"connector": 1, "billing": 1}

    before = select(candidates=candidates, frequency=common, total=6, ceiling=2)
    after = select(candidates=candidates, frequency=rare, total=6, ceiling=2)

    assert before.index("billing") >= after.index("billing")


def test_a_candidate_missing_from_the_frequency_map_is_treated_as_rarest():
    """A candidate the graph has not counted belongs to this Card alone, which is as rare as it gets."""
    tags = select(
        candidates={"connector": 5, "unseen": 1},
        frequency={"connector": 8},
        total=8,
        rarity_weight=1.0,
        ceiling=1,
    )

    assert tags == ("unseen",)


def test_rarity_is_flat_in_a_graph_of_one_card():
    """A candidate cannot be common in a graph with nothing to compare against, so repetition decides."""
    tags = select(
        candidates={"billing": 1, "connector": 4},
        frequency={"billing": 1, "connector": 1},
        total=1,
        ceiling=1,
    )

    assert tags == ("connector",)


def test_tag_selection_is_deterministic():
    """Requirement 5.9: two runs over the same graph produce the same tags, Card by Card."""
    candidates = {"connector": 3, "billing": 2, "latency": 2, "release": 1}
    frequency = {"connector": 4, "billing": 1, "latency": 3, "release": 2}

    first = select(candidates=candidates, structural=("run_query",), frequency=frequency)
    second = select(candidates=candidates, structural=("run_query",), frequency=frequency)

    assert first == second


def test_selection_does_not_mutate_what_it_was_given():
    """The candidates belong to the caller: re-tagging on Requirement 5.5 reads them again."""
    candidates = {"connector": 3, "billing": 1}
    structural = ["run_query"]
    frequency = {"connector": 2, "billing": 1}

    select(candidates=candidates, structural=structural, frequency=frequency)

    assert candidates == {"connector": 3, "billing": 1}
    assert structural == ["run_query"]
    assert frequency == {"connector": 2, "billing": 1}
