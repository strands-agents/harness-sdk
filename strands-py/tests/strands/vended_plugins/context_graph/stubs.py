"""Deterministic doubles for the context graph test suite.

Zero network calls, in every test. ``StubMatcher`` answers from a mapping, and ``FakeBedrockEmbedder``
records the ``(purpose, text)`` pair of every call — which is the only way the asymmetric purpose of
Requirement 7.8 becomes verifiable, because in production it is silent: passing ``"clustering"`` where
``"query"`` was meant returns a worse vector without any error.

Neither double inherits from anything, and neither imports the graph implementation. The plugin checks
``matcher`` by member and not by ``isinstance``, so a double never needs a base class.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field


class StubMatcher:
    """Deterministic similarity matcher. Scores by membership in a mapping.

    Args:
        scores: Similarity per description. Descriptions absent from the mapping score ``0.0``.
        fail: Raised instead of answering, to exercise the failure path.
        answer: Returned verbatim instead of scoring, to exercise a malformed answer — an empty
            sequence, a length that does not match, or something not iterable at all.
    """

    def __init__(
        self,
        scores: Mapping[str, float] | None = None,
        *,
        fail: BaseException | None = None,
        answer: object | None = None,
    ) -> None:
        self._scores = scores or {}
        self._fail = fail
        self._answer = answer
        self.calls: list[tuple[str, tuple[str, ...]]] = []

    @property
    def call_count(self) -> int:
        """How many times the double was invoked."""
        return len(self.calls)

    def score(self, question: str, descriptions: Sequence[str]) -> Sequence[float]:
        """Record the call and answer from canned data, or raise the configured error."""
        self.calls.append((question, tuple(descriptions)))
        if self._fail is not None:
            raise self._fail
        if self._answer is not None:
            return self._answer  # type: ignore[return-value] - deliberately malformed answers
        return [float(self._scores.get(description, 0.0)) for description in descriptions]


@dataclass(frozen=True)
class EmbedCall:
    """One recorded invocation of :class:`FakeBedrockEmbedder`, one entry per text."""

    purpose: str
    text: str


@dataclass
class FakeBedrockEmbedder:
    """Embedder double shaped like ``BedrockEmbedder``, without a boto client.

    Every call appends one :class:`EmbedCall` per text, so a test can assert both the purpose each
    text was embedded under and that an unchanged description was not embedded twice. Vectors are
    derived from the text itself, which keeps similarity deterministic without a model.

    Args:
        error: Raised instead of answering, to exercise ``EmbeddingError`` handling.
        dimensions: Length of every vector returned.
    """

    error: BaseException | None = None
    dimensions: int = 4
    calls: list[EmbedCall] = field(default_factory=list)
    batches: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)

    @property
    def call_count(self) -> int:
        """How many batches were submitted, which is the per-turn embedding cost."""
        return len(self.batches)

    def purposes_for(self, text: str) -> list[str]:
        """Every purpose ``text`` was embedded under, in call order."""
        return [call.purpose for call in self.calls if call.text == text]

    def embed(self, texts: Sequence[str], *, purpose: str | None = None) -> list[list[float]]:
        """Record the batch and return one deterministic vector per text."""
        resolved = purpose or "clustering"
        self.batches.append((resolved, tuple(texts)))
        self.calls.extend(EmbedCall(resolved, text) for text in texts)
        if self.error is not None:
            raise self.error
        return [self._vector(text) for text in texts]

    async def embed_async(self, texts: Sequence[str], *, purpose: str | None = None) -> list[list[float]]:
        """Async mirror of :meth:`embed`, with no thread and no I/O."""
        return self.embed(texts, purpose=purpose)

    def _vector(self, text: str) -> list[float]:
        """Derive a stable unit-ish vector from the text, so equal texts score identically."""
        vector = [0.0] * self.dimensions
        for index, character in enumerate(text):
            vector[index % self.dimensions] += (ord(character) % 17) / 17.0
        norm = sum(value * value for value in vector) ** 0.5
        return [value / norm for value in vector] if norm else [1.0] + [0.0] * (self.dimensions - 1)


def matcher_returning(scores: Mapping[str, float]) -> StubMatcher:
    """Build a matcher double that scores by membership in ``scores``."""
    return StubMatcher(scores)


def matcher_raising(error: BaseException | None = None) -> StubMatcher:
    """Build a matcher double that always fails."""
    return StubMatcher(fail=error or RuntimeError("matcher unavailable"))
