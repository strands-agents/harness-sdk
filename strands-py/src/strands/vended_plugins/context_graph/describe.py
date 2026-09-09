"""Title, Description and Tags derived by rule — no model call, ever.

The whole module rests on one decision: the Description is a *selection of lines*, never a summary.
A small model asked to summarize a table of balances paraphrases numbers, and a paraphrased number
is wrong in silence — the answer reads well and the value is off. So the graph never rewrites text.
It copies the lines where being wrong is expensive, and cuts the rest at a boundary.

That gives every function here the same shape of contract, verifiable by substring:

- ``title_for`` returns a literal prefix: ``user_text.startswith(title_for(user_text))``. It is the
  same contract as ``_truncate_description`` in ``progressive_tool_disclosure``, minus the ellipse —
  an ellipse would read better and break the prefix property, and the prefix property is what makes
  the Title checkable against the message it came from.
- ``numeric_lines`` returns lines copied character for character, so every selected line appears as
  an exact substring of the text it was drawn from.
- ``compose_description`` assembles a header out of addresses and appends the selected lines
  verbatim, so the Description minus its last line is a literal prefix of the complete Description.

Selection is deliberately generous. A line that carries a number joins the selection even when the
number turns out to be incidental, because the cost of keeping a line is tokens and the cost of
dropping one is a wrong answer nobody notices.

``select_tags`` and ``normalize`` sit here for the same reason: they share the module's patterns and
its cutting helpers, and a tag is derived from the same scan that derives the Description. They add one
promise of their own — no embedding call either (Requirement 5.8) — because a tag exists precisely to
catch the identifier an embedding confuses, and deriving it from an embedding would defeat the purpose.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping, Sequence

from .state import Card

_CHARS_PER_TOKEN = 4
"""Characters per token, the same coarse estimate ``progressive_tool_disclosure`` uses.

Deliberately provider-agnostic: the budget exists to bound growth, and a tokenizer per provider would
buy precision the decision does not need.
"""

_TITLE_TOKENS = 12
"""Token ceiling of a Title.

A Title is an address, not content: it has to be long enough for the model to tell two turns apart
and to name in ``expand_card``, and short enough that every Card's Title fits in every call
(Requirement 4.2). Twelve tokens is roughly a clause.
"""

_DIGIT_SEPARATORS = ".,\u00a0\u202f\u2009"
"""Characters that may sit between digit groups: decimal point, comma, and the three unicode spaces
used as thousands separators. Copy-pasted spreadsheet output carries the unicode ones far more often
than anyone expects, and a pattern that only knows ``.`` and ``,`` skips exactly those lines."""

_NUMERIC = re.compile(
    r"(?<![A-Za-z0-9.,])[-+]?\d+(?:[" + _DIGIT_SEPARATORS + r"]\d+)*(?:[eE][-+]?\d+)?(?![A-Za-z])",
)
"""A standalone number: optional sign, digit groups separated by decimal/thousands marks, optional
exponent.

The two boundary guards are what keep the pattern from firing on prose. The lookbehind rejects a
number glued to a word or to another digit group (``abc123``, the ``2`` of ``v1.2``), and the
lookahead rejects one glued to a suffix (``1,2mi``) — that case is left to ``_MONETARY``, which only
accepts it next to a currency marker.
"""

_CURRENCY = r"R\$|US\$|[$\u20ac\u00a3\u00a5\u20b9]|\b(?:BRL|USD|EUR|GBP|JPY)"
"""Currency markers, symbol or ISO code.

Not exhaustive by design: an unmatched currency still gets its line selected through ``_NUMERIC``,
because the amount itself is a number. The ISO codes carry a leading word boundary and no trailing
one, which is what lets ``BRL1.2mi`` match — a glued code followed by a magnitude suffix is the one
shape ``_NUMERIC`` refuses on both ends.
"""

_MONETARY = re.compile(
    r"(?:(?:" + _CURRENCY + r")[\s\u00a0]*\d|\d[\s\u00a0]*(?:" + _CURRENCY + r"))",
)
"""A digit adjacent to a currency marker, in either order.

Money is the one place where being generous is unambiguously right: an amount glued to its currency
code and carrying a suffix, ``BRL1.2mi``, is a number to every reader and to no digit pattern.
"""

_CURRENCY_MARKER = re.compile(_CURRENCY)
"""The currency markers again, on their own, for stripping them off a candidate before normalizing it.

Shares its alternation with ``_MONETARY`` rather than restating it: a marker that one pattern knows and
the other does not is a line selected as monetary whose amount then fails to collapse onto the bare
number, and the two would drift apart silently.
"""

_NUMERIC_VALUE = re.compile(
    r"(?P<sign>[-+]?)(?P<digits>\d+(?:[" + _DIGIT_SEPARATORS + r"]\d+)*)",
)
"""A whole candidate that is nothing but a number, for :func:`normalize`.

Matched with ``fullmatch``, which is the difference from ``_NUMERIC``: that one finds a number *inside*
a line and needs boundary guards to stay out of prose, while this one asks whether the candidate *is* a
number and gets the same guarantee from anchoring at both ends.
"""

_THOUSANDS_GROUP = 3
"""Digits in a group of thousands. Three trailing digits after a lone separator reads as ``1.200``,
not as a fraction."""

_TAG_TOKEN = re.compile(
    r"[^\W\d_][\w\-]{2,}|\d+(?:[" + _DIGIT_SEPARATORS + r"]\d+)*",
    re.UNICODE,
)
"""A textual tag candidate: a word of at least three characters starting with a letter, or a number.

The three-character floor is the only filter, and it is about noise rather than about meaning: ``at``
and ``of`` are too short to identify anything, while a two-letter ticket prefix would be recognized
through the structural path anyway. Everything longer is a candidate, including the words that appear in
every turn — those lose to the rarity term in :func:`select_tags`, which is the mechanism that replaces
a stopword list.

``[^\\W\\d_]`` is "a letter in any script": accented and non-Latin words are candidates on the same
footing, because a conversation held in Portuguese has its identifiers in Portuguese.
"""

_TAG_EDGE_PUNCTUATION = " \t\u00a0\"'`.,;:!?()[]{}<>*_"
"""Punctuation stripped from both ends of a candidate before normalizing it.

Only the ends. Punctuation inside a candidate is part of it — ``get_balance``, ``v1.2``, ``2024-03`` all
lose their identity if the marks in the middle go.
"""

_TABULAR_SEPARATORS = 2
"""How many cell separators make a line a table row. Two, because a single ``|`` is as likely to be a
piece of prose or a code fragment as a row."""

_SENTENCE_ENDINGS = ".!?"
"""Terminators that end a sentence, for the preferred cut position of a Description."""

_OMISSION = "(+{count} numeric lines omitted)"
"""What the Description records when the selected lines do not fit the budget (Requirement 4.6).

The count is the point of the line. A Description that silently keeps the first three of eleven
balances reads complete and is not, which is the same failure mode a paraphrased number has; stating
the number of lines left out is what turns that into a visible gap the model can close with
``expand_artifact``.
"""

_TEXTUAL_CONTENT_TYPES = frozenset(
    {
        "application/json",
        "application/xml",
        "application/yaml",
        "application/x-yaml",
        "application/csv",
        "application/javascript",
        "application/sql",
    }
)
"""Content types that are text without saying ``text/``.

Not exhaustive, and it does not need to be: an unrecognized type falls to the non-textual branch,
which is the conservative side of the mistake — the Description then carries the artifact's address
and size instead of lines drawn from bytes that were never text.
"""

_TEXTUAL_SUFFIXES = ("+json", "+xml", "+yaml")
"""Structured-syntax suffixes, the registered way a media type declares it is one of the above."""


def title_for(user_text: str) -> str:
    """Cut ``user_text`` to a literal prefix at a word boundary, for use as a Card Title.

    The cut lands at the last word boundary that fits the budget, and by character count only when no
    word boundary fits — a single token longer than the whole budget, where a boundary-based cut would
    return nothing at all. There is no ellipse: ``user_text.startswith(title_for(user_text))`` is the
    contract, and an ellipse would break it for cosmetics.

    Args:
        user_text: The turn's user message, as written. Left unmodified.

    Returns:
        A literal prefix of ``user_text``, never longer than ``_TITLE_TOKENS`` tokens. Returns
        ``user_text`` unchanged when it already fits, which covers the empty message.
    """
    max_chars = _TITLE_TOKENS * _CHARS_PER_TOKEN
    if len(user_text) <= max_chars:
        return user_text

    cut = _last_word_end(user_text, max_chars)
    if cut > 0:
        return user_text[:cut]

    return user_text[:max_chars]


def numeric_lines(texts: Sequence[str]) -> tuple[str, ...]:
    """Select every line of ``texts`` matching a numeric, monetary or tabular pattern, copied literally.

    No paraphrase and no character reordering: each selected line is an exact substring of the text it
    came from, leading whitespace included. Indentation is part of the line because a stripped row no
    longer lines up with the row above it, and a table that no longer lines up is a table the model
    reads wrong.

    A line is selected when it carries a standalone number, a digit next to a currency marker, or at
    least two cell separators alongside a digit. The three patterns overlap on purpose — a tabular row
    of amounts matches all three — and a line matching any of them is selected once.

    Order follows the order of ``texts`` and, within each text, the order of its lines, so two runs
    over the same messages produce the same tuple character for character (Requirement 4.10). Exact
    duplicates are dropped: the same balance repeated across three tool results is one line of signal
    and two lines of budget.

    Args:
        texts: Texts of the Card's messages, in message order. Not mutated.

    Returns:
        The selected lines, in order of first appearance, without duplicates.
    """
    selected: list[str] = []
    seen: set[str] = set()

    for text in texts:
        for line in text.splitlines():
            if not line.strip() or line in seen:
                continue
            if _carries_numbers(line):
                seen.add(line)
                selected.append(line)

    return tuple(selected)


def compose_description(card: Card, description_tokens: int) -> str:
    """Assemble ``card``'s Description by rule, within ``description_tokens`` tokens.

    No model call, for any kind of Card (Requirement 4.9). The Description is a header of addresses
    followed by the Card's numeric lines copied verbatim, and what the budget decides is how many of
    those lines get in — never how they are worded.

    Three shapes, one for each kind of thing a Card stands for:

    - **Subject** (Requirement 4.3): the subject name, the tools used with their call counts, the
      cited references, then the numeric lines.
    - **Textual artifact** (Requirement 4.7): the reference, the tool that produced the content, the
      turn ordinal, then the numeric lines.
    - **Non-textual artifact** (Requirement 4.8): exclusively the file name, the ``content_type``, the
      size, the tool, the turn ordinal and the reference. No lines: bytes that were never text have no
      lines to copy, and a Description assembled from them would be an invention.

    The budget is spent at line granularity first, because a line is the unit of meaning here: the
    first lines that fit get in, and a final ``(+N numeric lines omitted)`` records the rest. Only
    when the header alone overruns the budget does the cut fall back to the ``_truncate_description``
    mold — sentence boundary first, word boundary second, character count only when neither fits — and
    there is no ellipse, because the ellipse would cost the prefix property for cosmetics.

    So the contract, verifiable by ``startswith``: strip the trailing omission line and what remains
    is a literal prefix of the Description this same Card yields with an unbounded budget
    (Requirement 4.5). Every field it draws on is ordered, and tool names are ordered by first
    appearance among the pairs rather than by set iteration, so two runs agree character for character
    (Requirement 4.10).

    Args:
        card: The Card to describe. Only read, never mutated.
        description_tokens: Token ceiling of the Description. Must be at least ``1``.

    Returns:
        The Description, estimated at no more than ``description_tokens`` tokens.
    """
    textual = card.kind != "artifact" or _is_textual(card.content_type)
    header = _subject_header(card) if card.kind != "artifact" else _artifact_header(card, textual)
    lines = card.numeric_lines if textual else ()

    complete = "\n".join((header, *lines))
    max_chars = description_tokens * _CHARS_PER_TOKEN
    if len(complete) <= max_chars:
        return complete

    if lines:
        # Reserved against the worst case: the omission count can only be smaller than the total, and a
        # smaller count is never a longer line, so the reservation can over-reserve but never under.
        reserved = max_chars - len(_OMISSION.format(count=len(lines))) - 1
        if reserved >= len(header):
            kept = _lines_that_fit(lines, reserved - len(header))
            omitted = _OMISSION.format(count=len(lines) - len(kept))
            return "\n".join((header, *kept, omitted))

    return _cut(complete, max_chars)


def _lines_that_fit(lines: Sequence[str], budget: int) -> tuple[str, ...]:
    """Take lines from the front of ``lines`` while their joined length fits ``budget`` characters.

    Stops at the first line that does not fit instead of skipping it: the lines are in the order they
    were read, and keeping a later short line over an earlier long one would make the kept portion
    stop being a prefix of the complete selection.

    Args:
        lines: Selected numeric lines, in order. Not mutated.
        budget: Characters available for the lines, each one's leading newline included.

    Returns:
        The leading run of lines that fits, possibly empty.
    """
    kept: list[str] = []
    used = 0

    for line in lines:
        needed = len(line) + 1  # The newline that joins this line to what precedes it.
        if used + needed > budget:
            break
        used += needed
        kept.append(line)

    return tuple(kept)


def _subject_header(card: Card) -> str:
    """Assemble the address part of a subject Card's Description (Requirement 4.3).

    Args:
        card: A subject Card. Only read.

    Returns:
        The subject name, plus a tools line and a references line when there are any of either. An
        absent line is left out rather than rendered empty: ``tools:`` with nothing after it spends
        budget to say nothing.
    """
    parts = [card.title]

    tools = _tool_counts(card)
    if tools:
        parts.append("tools: " + ", ".join(f"{name} ({count})" for name, count in tools))

    references = _unique(card.references)
    if references:
        parts.append("references: " + ", ".join(references))

    return "\n".join(parts)


def _artifact_header(card: Card, textual: bool) -> str:
    """Assemble the address part of an artifact Card's Description (Requirements 4.7, 4.8).

    The two field orders are the ones the requirements list, and they differ because the emphasis
    differs: textual content leads with the reference because the lines that follow came from it,
    while non-textual content leads with the file name because the name is the only part of a binary
    artifact a reader can reason about.

    Args:
        card: An artifact Card. Only read.
        textual: Whether the artifact's content is text.

    Returns:
        The assembled header. Fields that are ``None`` are left out.
    """
    tool = ", ".join(name for name, _ in _tool_counts(card))
    reference = card.reference or ""

    fields: tuple[tuple[str, str], ...]
    if textual:
        fields = (
            ("reference", reference),
            ("tool", tool),
            ("turn", str(card.turn)),
        )
    else:
        fields = (
            ("file", _file_name(reference)),
            ("content_type", card.content_type or ""),
            ("size", "" if card.size_bytes is None else f"{card.size_bytes} bytes"),
            ("tool", tool),
            ("turn", str(card.turn)),
            ("reference", reference),
        )

    return "\n".join(f"{label}: {value}" for label, value in fields if value)


def _tool_counts(card: Card) -> tuple[tuple[str, int], ...]:
    """Count ``card``'s tool calls per tool, in a reproducible order.

    Ordered by first appearance among ``card.pairs``, then by name for any tool named in
    ``tool_names`` without a pair of its own. Never by iteration over ``tool_names``: that is a
    ``frozenset`` of strings, and string hashing is seeded per process, so a set-ordered Description
    would differ between two runs over the same messages and break Requirement 4.10.

    A tool named without a pair is counted once. It is a ``toolUse`` block whose result has not been
    paired — a call that happened, with no way to tell whether it happened twice.

    Args:
        card: The Card whose tool calls to count. Only read.

    Returns:
        ``(tool name, call count)`` pairs.
    """
    counts: dict[str, int] = {}
    for pair in card.pairs:
        counts[pair.tool_name] = counts.get(pair.tool_name, 0) + 1

    for name in sorted(card.tool_names):
        counts.setdefault(name, 1)

    return tuple(counts.items())


def _is_textual(content_type: str | None) -> bool:
    """Report whether ``content_type`` names text.

    An absent or unrecognized type is not text. That is the conservative side of the mistake: the
    Description then carries the artifact's address and size, where the other direction would have it
    carry lines pattern-matched out of bytes that were never text.

    Args:
        content_type: A media type, possibly with parameters, or ``None``.

    Returns:
        ``True`` when the content can be read as text.
    """
    if not content_type:
        return False

    base = content_type.split(";")[0].strip().lower()
    return base.startswith("text/") or base in _TEXTUAL_CONTENT_TYPES or base.endswith(_TEXTUAL_SUFFIXES)


def _file_name(reference: str) -> str:
    """Take the file name out of an artifact reference.

    Args:
        reference: The artifact reference, in any shape.

    Returns:
        The last path segment, or the whole reference when it has no separator.
    """
    return reference.rsplit("/", 1)[-1]


def _unique(values: Iterable[str]) -> tuple[str, ...]:
    """Drop duplicates from ``values``, keeping the first appearance of each.

    Args:
        values: Values to deduplicate, in order.

    Returns:
        The distinct values, in order of first appearance.
    """
    seen: dict[str, None] = {}
    for value in values:
        seen.setdefault(value, None)
    return tuple(seen)


def _cut(text: str, max_chars: int) -> str:
    """Cut ``text`` to a literal prefix of at most ``max_chars`` characters.

    The ``_truncate_description`` rule, minus the ellipse: the last sentence boundary that fits, then
    the last word boundary, and the character ceiling only when neither fits — a single token longer
    than the whole budget, where a boundary-based cut would return nothing at all.

    Args:
        text: Text to cut.
        max_chars: Character ceiling.

    Returns:
        A literal prefix of ``text``.
    """
    cut = _last_sentence_end(text, max_chars)
    if cut > 0:
        return text[:cut]

    cut = _last_word_end(text, max_chars)
    if cut > 0:
        return text[:cut]

    return text[:max_chars]


def _last_sentence_end(text: str, budget: int) -> int:
    """Find the end of the last sentence of ``text`` that fits ``budget`` characters.

    A sentence ends at a terminator followed by whitespace or by the end of ``text``, so a period
    inside ``v1.2`` or ``R$ 1.200,00`` is not mistaken for one.

    Args:
        text: Text to scan.
        budget: Maximum number of characters the result may span.

    Returns:
        Number of characters to keep, terminator included, or ``-1`` when no sentence ends within the
        budget.
    """
    for index in range(min(budget, len(text)) - 1, -1, -1):
        if text[index] in _SENTENCE_ENDINGS and (index + 1 >= len(text) or text[index + 1].isspace()):
            return index + 1
    return -1


def _carries_numbers(line: str) -> bool:
    """Report whether ``line`` matches the numeric, monetary or tabular pattern.

    Args:
        line: A single line, without its terminator.

    Returns:
        ``True`` when the line is worth copying literally.
    """
    return bool(_NUMERIC.search(line)) or bool(_MONETARY.search(line)) or _is_tabular(line)


def _is_tabular(line: str) -> bool:
    """Report whether ``line`` reads as a table row carrying at least one digit.

    Counted in Python rather than matched by regex: the rule is "enough separators, and a digit
    somewhere", and spelling that as a single expression buys nothing but a pattern nobody can read.

    Args:
        line: A single line, without its terminator.

    Returns:
        ``True`` when the line has at least ``_TABULAR_SEPARATORS`` cell separators and a digit.
    """
    separators = line.count("|") + line.count("\t")
    return separators >= _TABULAR_SEPARATORS and any(character.isdigit() for character in line)


def _estimate_tokens(text: str) -> int:
    """Estimate the token count of ``text`` by character count.

    Args:
        text: Text to measure.

    Returns:
        The estimated number of tokens, rounded up.
    """
    return math.ceil(len(text) / _CHARS_PER_TOKEN)


def _last_word_end(text: str, budget: int) -> int:
    """Find the end of the last whole word of ``text`` that fits ``budget`` characters.

    Args:
        text: Text to scan.
        budget: Maximum number of characters the result may span.

    Returns:
        Number of characters to keep, or ``-1`` when no word ends within the budget.
    """
    # A word may end exactly at the budget: the character just past it decides, not the budget.
    for index in range(min(budget, len(text) - 1), -1, -1):
        if text[index].isspace():
            return index
    return -1


def tag_candidates(card: Card, texts: Sequence[str] = ()) -> tuple[tuple[str, ...], dict[str, int]]:
    """Extract the tag candidates of ``card``, split into structural and textual.

    Three sources and nothing else (Requirement 5.2): the name of a ``toolUse`` block, an artifact
    reference, and a regex over the Card's text. No declared list and no type schema — the vocabulary
    of a conversation is not known in advance, and a curated list would only ever recognize the words
    someone thought of before the conversation happened.

    The absence of a stopword list is the same decision seen from the other side. ``the`` and
    ``please`` are candidates here, and they lose in :func:`select_tags` because they appear in every
    Card, which is exactly what the rarity term measures. A hand-kept list would do the same job for
    the words it happens to contain, and nothing for the ones specific to a deployment — ``ticket``,
    ``sprint``, ``connector`` — that distinguish nothing in that deployment and are in no dictionary
    of stopwords.

    Args:
        card: The Card whose candidates to extract. Only read, never mutated.
        texts: Texts of the Card's messages, in message order, for the regex pass. Not mutated.
            Defaults to no text at all, which yields structural candidates only.

    Returns:
        ``(structural, textual)``. ``structural`` holds the normalized tool names and references in a
        reproducible order, without duplicates. ``textual`` maps each normalized textual candidate to
        how many times it occurs, in order of first appearance — which is what makes the tie-break in
        :func:`select_tags` deterministic, because a ``dict`` preserves insertion order.
    """
    structural = [normalize(name) for name, _ in _tool_counts(card)]
    structural.extend(normalize(reference) for reference in _unique((*_artifact_reference(card), *card.references)))

    counts: dict[str, int] = {}
    for text in texts:
        for match in _TAG_TOKEN.finditer(text):
            token = normalize(match.group())
            if token:
                counts[token] = counts.get(token, 0) + 1

    taken = set(structural)
    textual = {token: count for token, count in counts.items() if token not in taken}

    return tuple(value for value in _unique(structural) if value.strip()), textual


def select_tags(
    candidates: Mapping[str, int],
    structural: Sequence[str],
    document_frequency: Mapping[str, int],
    total_cards: int,
    tags_per_card: int,
    rarity_weight: float,
) -> tuple[str, ...]:
    """Choose at most ``tags_per_card`` tags for one Card, deterministically.

    Structural candidates come first, and no textual candidate enters while a structural one still
    lacks a slot (Requirement 5.3). A tool name and an artifact reference *define* the Card: they are
    what the turn did, not what the turn talked about. A textual candidate is a guess about salience
    drawn from a frequency count, and a guess never outranks a fact — which also means that a Card
    with five tool calls gets five structural tags and no textual ones, and that is the right answer
    rather than a degenerate one.

    Textual candidates are then ordered by
    ``(1 - rarity_weight) * normalized_repetition + rarity_weight * rarity`` (Requirement 5.4). The two
    terms measure different things and neither works alone. Repetition alone promotes whatever the
    conversation says often, which across a session is the vocabulary of the domain itself and
    distinguishes no two turns. Rarity alone promotes the typo that occurred once. The rarity term is
    inverse frequency counted over the graph's Cards, so what defines a Card depends on what it is
    being compared against — which is why Requirement 5.5 has the graph re-tag existing Cards when it
    gains one.

    Ties break by order of first appearance in ``candidates``, so two runs over the same graph with the
    same configuration produce the same tags, Card by Card (Requirement 5.9). No model call and no
    embedding call takes part (Requirement 5.8): everything here is counting and arithmetic.

    Args:
        candidates: Textual candidate to how many times it occurs in this Card, in order of first
            appearance. Not mutated.
        structural: Normalized tool names and references of this Card, in a reproducible order. Not
            mutated.
        document_frequency: Candidate to how many Cards of the graph carry it. A candidate missing
            from the mapping is treated as belonging to this Card alone, which is the rarest it can
            be.
        total_cards: How many Cards the rarity is counted over.
        tags_per_card: Ceiling on the number of tags. Must be at least ``1``.
        rarity_weight: Weight of the rarity term, in ``[0.0, 1.0]``. Its complement weights the
            repetition term.

    Returns:
        At most ``tags_per_card`` tags: the structural ones in the order received, then the textual
        ones by descending score.
    """
    # ``value.strip()`` and not ``value``: a reference that normalizes to whitespace is truthy and is
    # still nothing to match a question against, and letting it through would spend a slot on a tag no
    # question can ever mention.
    tags = list(_unique(value for value in structural if value.strip()))[:tags_per_card]

    slots = tags_per_card - len(tags)
    if slots <= 0 or not candidates:
        return tuple(tags)

    peak = max(candidates.values())
    ranked = sorted(
        enumerate(candidates.items()),
        key=lambda entry: (
            -(
                (1.0 - rarity_weight) * (entry[1][1] / peak if peak else 0.0)
                + rarity_weight * _rarity(document_frequency.get(entry[1][0], 1), total_cards)
            ),
            entry[0],
        ),
    )

    taken = set(tags)
    for _, (token, _count) in ranked:
        if len(tags) >= tags_per_card:
            break
        if token not in taken:
            taken.add(token)
            tags.append(token)

    return tuple(tags)


def normalize(token: str) -> str:
    """Reduce ``token`` to the canonical form used to compare a tag against the turn's question.

    A monetary amount and a separator-bearing number collapse onto the same form (Requirement 5.6):
    ``R$ 1.200,00``, ``1.200,00``, ``1,200.00`` and ``1200`` all normalize to ``"1200"``. That single
    collapse covers the case that matters, because an amount is what the model asks about again — "and
    the 1200 one?" — and it is the case where the literal strings agree on none of their characters.

    Which separator is the decimal one is decided by shape, not by locale. When both marks appear, the
    last one is the decimal separator. When only one appears, it is a thousands separator if it repeats
    or if it is followed by exactly three digits, and a decimal separator otherwise — with the
    exception of a leading ``0``, where ``0.500`` is a fraction and not a group of thousands.

    Anything that is not a number is casefolded and stripped of surrounding punctuation, and nothing
    more. The cases left over — a plural, a hyphenation, a synonym — fall to the similarity comparison,
    and that is the correct behavior rather than a gap: the tag is a shortcut for the identifier an
    embedding confuses, not the only route to a Card.

    Args:
        token: A candidate, tag, or word drawn from the question. Left unmodified.

    Returns:
        The canonical form, possibly empty when ``token`` carries nothing but punctuation.
    """
    stripped = token.strip().strip(_TAG_EDGE_PUNCTUATION)
    if not stripped:
        return ""

    number = _NUMERIC_VALUE.fullmatch(_CURRENCY_MARKER.sub("", stripped).strip())
    if number:
        return _canonical_number(number.group("sign"), number.group("digits"))

    return stripped.casefold()


def _artifact_reference(card: Card) -> tuple[str, ...]:
    """Take the artifact reference of ``card``, when it has one.

    Args:
        card: The Card to read.

    Returns:
        A one-element tuple with the reference, or an empty tuple.
    """
    return (card.reference,) if card.reference else ()


def _rarity(document_frequency: int, total_cards: int) -> float:
    """Score how rare a candidate is across the graph, in ``(0.0, 1.0]``.

    Strictly decreasing in ``document_frequency``, which is the property Requirement 5.4 rests on and
    the one the metamorphic test checks: making a candidate rarer can never lower its position in the
    ranking. A frequency of one — the candidate belongs to this Card alone — scores exactly ``1.0``,
    and a candidate present in every Card scores the floor.

    Args:
        document_frequency: How many Cards carry the candidate. Clamped to at least ``1``.
        total_cards: How many Cards the rarity is counted over.

    Returns:
        The rarity score. ``1.0`` when there is nothing to compare against, because a candidate cannot
        be common in a graph of one.
    """
    frequency = max(1, document_frequency)
    if total_cards <= 1:
        return 1.0

    return math.log1p(total_cards / frequency) / math.log1p(total_cards)


def _canonical_number(sign: str, digits: str) -> str:
    """Reduce a separator-bearing number to its canonical digits.

    Args:
        sign: The leading sign, possibly empty.
        digits: The digit groups with their separators, without sign or currency.

    Returns:
        The canonical form: integer part without leading zeros, decimal part without trailing zeros,
        joined by ``"."`` only when a decimal part survives.
    """
    plain = digits
    for separator in _DIGIT_SEPARATORS:
        if separator not in ".,":
            plain = plain.replace(separator, "")

    integer, _, fraction = _split_decimal(plain)
    integer = integer.lstrip("0") or "0"
    fraction = fraction.rstrip("0")
    normalized = f"{integer}.{fraction}" if fraction else integer

    return f"-{normalized}" if sign == "-" else normalized


def _split_decimal(digits: str) -> tuple[str, str, str]:
    """Split ``digits`` into integer and decimal parts, deciding which mark is the decimal one.

    Args:
        digits: Digit groups separated by ``"."`` and ``","``, without sign or currency.

    Returns:
        ``(integer part, separator used, decimal part)``, both parts holding digits only.
    """
    marks = [character for character in digits if character in ".,"]
    if not marks:
        return digits, "", ""

    decimal = _decimal_mark(digits, marks)
    if decimal is None:
        return digits.replace(".", "").replace(",", ""), "", ""

    head, _, tail = digits.rpartition(decimal)
    return head.replace(".", "").replace(",", ""), decimal, tail


def _decimal_mark(digits: str, marks: Sequence[str]) -> str | None:
    """Decide which of ``digits``' separators is the decimal one, by shape rather than by locale.

    Args:
        digits: Digit groups separated by ``"."`` and ``","``.
        marks: The separators present, in order of appearance.

    Returns:
        The decimal separator, or ``None`` when every separator groups thousands.
    """
    if "." in marks and "," in marks:
        # Both marks present: the last one is the decimal separator, whichever it is.
        return marks[-1]

    mark = marks[0]
    if len(marks) > 1:
        return None

    head, _, tail = digits.partition(mark)
    # Exactly three trailing digits is a group of thousands — unless the integer part is a bare zero,
    # where ``0.500`` is a fraction and reading it as thousands would turn it into ``500``.
    if len(tail) == _THOUSANDS_GROUP and head.lstrip("-") != "0":
        return None

    return mark
