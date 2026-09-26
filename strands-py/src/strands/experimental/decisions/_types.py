"""Question, answer, and response types for System One decision models."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, TypeAlias, TypeVar

from ...types.event_loop import Usage

JSONContent: TypeAlias = str | Mapping[str, Any] | Sequence[Any]
"""Text, a JSON object, or a JSON array. Instructions, option descriptions, and levels all accept it."""

DecisionState: TypeAlias = str | Mapping[str, Any] | Sequence[Any]
"""The data a decision is made about. Treated as untrusted content, never as instructions."""

MIN_SCORE_LEVELS = 2

T = TypeVar("T")


def _require_instructions(kind: str, instructions: object) -> None:
    if not isinstance(instructions, (str, Mapping, Sequence)) or (isinstance(instructions, str) and not instructions):
        raise ValueError(f"{kind} instructions must be a non-empty string, JSON object, or JSON array")


@dataclass(frozen=True)
class Choice:
    """Pick one option from a defined set.

    Usable directly in ``DecisionModel.ask`` and as an ``Annotated`` marker on a ``Literal``/``Enum``
    field of a decision schema. On a schema field, ``options`` may be omitted: the options come from
    the field type and ``options`` then only supplies descriptions.

    Args:
        instructions: The decision to make. Reference state fields by backticked path, e.g. `ticket.body`.
        options: Option name to description, or None for an option that needs none. Providers may cap the
            option count (TypeSafe's API allows 255) and raise from ``ask`` before sending.
    """

    instructions: JSONContent
    options: Mapping[str, JSONContent | None] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate the question shape.

        Raises:
            ValueError: If instructions are empty.
        """
        _require_instructions("Choice", self.instructions)


@dataclass(frozen=True)
class Score:
    """Rate state along two or more ordered, self-describing levels.

    Args:
        instructions: What to rate.
        levels: Ordered level descriptions, lowest first. Level ``i`` scores ``i``. Providers may cap the level
            count (TypeSafe's hosted API allows 10) and raise from ``ask`` before sending.
    """

    instructions: JSONContent
    levels: Sequence[JSONContent]

    def __post_init__(self) -> None:
        """Validate the question shape.

        Raises:
            ValueError: If instructions are empty or there are fewer than two levels.
        """
        _require_instructions("Score", self.instructions)
        if isinstance(self.levels, str) or len(self.levels) < MIN_SCORE_LEVELS:
            raise ValueError(f"Score needs at least {MIN_SCORE_LEVELS} levels")


@dataclass(frozen=True)
class YesNo:
    """Ask whether a condition holds; the answer is the probability that it does.

    Args:
        instructions: The yes/no question.
        true: Optional description of what a yes means.
        false: Optional description of what a no means.
        threshold: Probability at or above which a schema's ``bool`` field reads True. The raw
            probability is always kept on the answer.
    """

    instructions: JSONContent
    true: JSONContent | None = None
    false: JSONContent | None = None
    threshold: float = 0.5

    def __post_init__(self) -> None:
        """Validate the question shape.

        Raises:
            ValueError: If instructions are empty or threshold is outside [0, 1].
        """
        _require_instructions("YesNo", self.instructions)
        if not 0.0 <= self.threshold <= 1.0:
            raise ValueError("YesNo threshold must be between 0 and 1")


Question: TypeAlias = Choice | Score | YesNo


def _check_distribution(probabilities: Mapping[Any, float]) -> None:
    if not probabilities or any(not math.isfinite(value) or value < 0 for value in probabilities.values()):
        raise ValueError("answer probabilities must be a non-empty map of finite, non-negative numbers")


@dataclass(frozen=True)
class ChoiceAnswer:
    """The selected option and the distribution over every option.

    ``confidence`` is None when the model is not calibrated (see ``DecisionModel.calibrated``).
    """

    choice: str
    probabilities: Mapping[str, float]
    confidence: float | None = None

    def __post_init__(self) -> None:
        """Validate that the choice is one of the scored options.

        Raises:
            ValueError: If the distribution is malformed or the choice is not in it.
        """
        _check_distribution(self.probabilities)
        if self.choice not in self.probabilities:
            raise ValueError(f"choice {self.choice!r} is not one of the answered options")


@dataclass(frozen=True)
class ScoreAnswer:
    """The probability-weighted level and the distribution over levels.

    ``probabilities`` is keyed by level index, 0 to ``len(levels) - 1``. ``score`` is the probability-weighted
    index, so it lies in ``[0, len(levels) - 1]``: threshold it for "how much". ``confidence`` ("how sure") is
    None when the model is not calibrated.
    """

    score: float
    probabilities: Mapping[int, float]
    confidence: float | None = None

    def __post_init__(self) -> None:
        """Validate the distribution.

        Raises:
            ValueError: If the distribution is malformed.
        """
        _check_distribution(self.probabilities)

    @property
    def level(self) -> int:
        """The most probable level index."""
        return max(self.probabilities, key=lambda level: self.probabilities[level])


@dataclass(frozen=True)
class YesNoAnswer:
    """The probability that the condition holds.

    A yes/no answer's uncertainty is its probability, so policy should threshold ``probability``. ``confidence``
    exists so gates that read confidence (``when_below``) compose over every answer type: calibrated providers
    set it to ``yes_no_confidence(probability)`` (0 at 0.5, 1 at 0 or 1), and it is None when the model is not
    calibrated.
    """

    probability: float
    confidence: float | None = None

    def __post_init__(self) -> None:
        """Validate the probability.

        Raises:
            ValueError: If the probability is outside [0, 1].
        """
        if not math.isfinite(self.probability) or not 0.0 <= self.probability <= 1.0:
            raise ValueError("YesNo probability must be between 0 and 1")


def yes_no_confidence(probability: float) -> float:
    """Confidence of a calibrated yes/no probability: its distance from 0.5, scaled to [0, 1]."""
    return abs(2 * probability - 1)


Answer: TypeAlias = ChoiceAnswer | ScoreAnswer | YesNoAnswer


@dataclass(frozen=True)
class DecisionResponse:
    """Answers keyed like the questions, plus the model that answered and token usage."""

    answers: Mapping[str, Answer]
    model_id: str | None = None
    usage: Usage = field(default_factory=lambda: Usage(inputTokens=0, outputTokens=0, totalTokens=0))

    def __getitem__(self, question_id: str) -> Answer:
        """Return the answer for ``question_id``."""
        return self.answers[question_id]


@dataclass(frozen=True)
class Decision(Generic[T]):
    """A typed decision: the schema instance plus the full answer for every field.

    Attributes:
        output: The validated schema instance (``Literal`` field -> selected option, ``bool`` -> probability
            at or above the field's threshold, ``float`` -> score).
        answers: Every field's full answer, including probabilities and confidence.
        model_id: The model that answered.
        usage: Token usage for the request.
    """

    output: T
    answers: Mapping[str, Answer]
    model_id: str | None = None
    usage: Usage = field(default_factory=lambda: Usage(inputTokens=0, outputTokens=0, totalTokens=0))
