"""Search protocol over the full text of tool specifications.

The projection decides *what* goes in a model call; this module decides *which tools answer a need*.
Keeping the two apart is what lets the search be swapped — lexical scoring today, a reranker or an
embedding index tomorrow — and what lets every projection test run against a deterministic double
with no network involved.

``ToolIndex`` is a ``Protocol``, not a base class: an implementation only has to expose ``build`` and
``search``, and both may be synchronous or awaitable, so an implementation that has to call out over
the network is not forced to block.

Two sibling plugins score text against text as well, and the three protocols are deliberately not one:

- ``ToolIndex`` here is the only one with a *build* phase, because tool specifications are static and
  the work is worth doing once per registry fingerprint. It is also the only one whose scores carry no
  absolute meaning — selection is ``top_k``, so no threshold reads them.
- :class:`~strands.vended_plugins.context_offloader.reranker.Reranker` is stateless, scores chunks of a
  single tool result, and must return a true ``[0.0, 1.0]`` because ``relevance_threshold`` compares
  against it. It must raise rather than return a short list, since a missing score would be read as
  "irrelevant" and silently drop the passage the question needed.

Folding them into one protocol would mean either giving up the build phase or making the other carry
a no-op one, and picking a single failure rule where the cost of being wrong differs at each site. What
they share — the embedding round trip and its cache — lives in
:mod:`strands.vended_plugins._embedding`, which is what an ``EmbeddingToolIndex`` should be built on:
embed the need as ``"query"`` and the specification texts as ``"document"``.
"""

import re
from collections import Counter
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass
from typing import Protocol

from ...types.tools import ToolSpec


@dataclass(frozen=True)
class ToolMatch:
    """One tool the index considers relevant to a need.

    Attributes:
        name: Name of the matched tool, verbatim as it appeared in the indexed specification.
        score: Relevance score. Comparable only against other scores from the same index; the scale
            is an implementation detail and carries no absolute meaning.
    """

    name: str
    score: float


class ToolIndex(Protocol):
    """Searchable index over tool specifications.

    Contract every implementation must honor:

    - ``search`` returns at most ``top_k`` matches, ordered by descending score.
    - Every returned name belongs to the set of names received in the most recent ``build`` call.
    - ``build`` leaves the sequence it receives untouched — same elements, same order, same length —
      and does not mutate the specifications in it.

    Either operation may return its result directly or return an awaitable; the caller handles both.
    """

    def build(self, specs: Sequence[ToolSpec]) -> None | Awaitable[None]:
        """Index the full text of each specification.

        Called once per registry fingerprint, so an implementation is free to do the expensive work
        here. The full text means name, description and the parameter descriptions of the
        ``inputSchema``: the parameters are what separates two tools whose one-line descriptions read
        alike.

        Args:
            specs: Specifications to index. Must not be mutated, reordered or resized.

        Returns:
            Nothing, or an awaitable that completes when the index is ready.
        """
        ...

    def search(self, need: str, top_k: int) -> Sequence[ToolMatch] | Awaitable[Sequence[ToolMatch]]:
        """Return the tools that best answer a need described in natural language.

        Args:
            need: Natural-language description of what the caller needs to do.
            top_k: Maximum number of matches to return.

        Returns:
            At most ``top_k`` matches ordered by descending score, drawn from the names of the last
            ``build``, or an awaitable of the same.
        """
        ...


_MAX_SCHEMA_DEPTH = 4
"""How deep the parameter walk goes into nested schemas.

Deep nesting adds little discriminating text and a recursive schema would otherwise not terminate.
"""


def _schema_parts(node: object, depth: int) -> list[str]:
    """Collect the indexable text of a JSON Schema node, in declaration order.

    Args:
        node: Schema node to walk. Anything that is not a mapping contributes nothing.
        depth: Remaining nesting levels to walk. Zero stops the descent.

    Returns:
        Descriptions and parameter names found at this node and below, in the order they are
        declared.
    """
    if depth <= 0 or not isinstance(node, dict):
        return []

    parts: list[str] = []

    description = node.get("description")
    if isinstance(description, str) and description:
        parts.append(description)

    properties = node.get("properties")
    if isinstance(properties, dict):
        for name, child in properties.items():
            if isinstance(name, str) and name:
                parts.append(name)
            parts.extend(_schema_parts(child, depth - 1))

    parts.extend(_schema_parts(node.get("items"), depth - 1))

    return parts


def _spec_text(spec: ToolSpec) -> str:
    """Serialize a specification into the single text an index scores against.

    Name, description and the parameter descriptions of the ``inputSchema`` all go in: the
    parameters are what tell apart two tools whose one-line descriptions read alike. The result is a
    function of the specification alone — no I/O, no mutation of the specification received, and the
    same input always yields the same text.

    Args:
        spec: Specification to serialize.

    Returns:
        The specification's indexable text. Empty when the specification carries no text at all.
    """
    parts = [spec.get("name") or "", spec.get("description") or ""]

    input_schema = spec.get("inputSchema")
    if isinstance(input_schema, dict):
        # inputSchema arrives wrapped as {"json": {...}}; tolerate an unwrapped schema as well.
        root = input_schema.get("json", input_schema)
        parts.extend(_schema_parts(root, _MAX_SCHEMA_DEPTH))

    return " ".join(part for part in parts if part)


_TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
"""Word characters, lowercased. Punctuation and underscores are separators, so ``list_accounts``
indexes as ``list`` plus ``accounts`` and a need phrased as "list the accounts" reaches it."""


def _tokenize(text: str) -> list[str]:
    """Split text into comparable terms.

    Args:
        text: Text to split.

    Returns:
        The lowercased alphanumeric runs of ``text``, in the order they appear.
    """
    return _TOKEN_PATTERN.findall(text.lower())


class LexicalToolIndex:
    """Default :class:`ToolIndex`: term frequency over the serialized specification text.

    Standard library only — no network, no disk, no model call. Tools are static, so ``build`` does
    the counting once per registry fingerprint and every search is a lookup over the counts.

    Scoring sums, over the *distinct* terms of the need, how often each term occurs in the
    specification text. Distinct terms keep a need that repeats a word from turning that word into
    the whole ranking. Ties are broken by indexing order, which makes repeated searches over the
    same indexed sequence return the same matches in the same order.

    Specifications whose score is zero are not returned: a need that shares no term with any
    specification yields no matches, which the search tool reports as such instead of offering
    something arbitrary.
    """

    def __init__(self) -> None:
        """Create an empty index, queryable right away with zero matches."""
        self._entries: list[tuple[str, Counter[str]]] = []

    def build(self, specs: Sequence[ToolSpec]) -> None:
        """Count the terms of each specification's full text, preserving indexing order.

        Args:
            specs: Specifications to index. Read only — neither the sequence nor its elements are
                mutated. Specifications without a name are skipped, since a match could not be
                resolved back to a registry entry.
        """
        entries: list[tuple[str, Counter[str]]] = []
        for spec in specs:
            name = spec.get("name") or ""
            if not name:
                continue
            entries.append((name, Counter(_tokenize(_spec_text(spec)))))

        self._entries = entries

    def search(self, need: str, top_k: int) -> Sequence[ToolMatch]:
        """Rank the indexed specifications against a need.

        Args:
            need: Natural-language description of what the caller needs to do.
            top_k: Maximum number of matches to return.

        Returns:
            At most ``top_k`` matches with a non-zero score, ordered by descending score and, on a
            tie, by indexing order.
        """
        if top_k <= 0:
            return []

        terms = set(_tokenize(need))
        if not terms:
            return []

        scored: list[tuple[float, int, str]] = []
        for position, (name, counts) in enumerate(self._entries):
            score = float(sum(counts[term] for term in terms))
            if score > 0:
                scored.append((score, position, name))

        # Descending score; indexing order breaks the tie, so the ranking is deterministic.
        scored.sort(key=lambda entry: (-entry[0], entry[1]))

        return [ToolMatch(name=name, score=score) for score, _, name in scored[:top_k]]
