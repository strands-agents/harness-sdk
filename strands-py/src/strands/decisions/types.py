"""Public types for the decision model primitive.

See ``team/designs/0020-decision-models.md`` for the design rationale.
"""

from dataclasses import dataclass
from typing import Literal

from typing_extensions import NotRequired, TypedDict

from ..types.content import ContentBlock, Messages
from ..types.event_loop import Usage

DecisionInput = str | list[ContentBlock] | Messages
"""Input state passed to a decision model invocation.

A plain string question, a single-turn content list (multimodal), or a full message history.
"""


class UncertaintyOptions(TypedDict, total=False):
    """Fine-grained uncertainty configuration for a question.

    Attributes:
        min_confidence: Minimum confidence in ``[0.0, 1.0]`` below which the answer is reported as
            uncertain. Read only by implementations that return per-answer confidence (e.g. System
            One models); ignored by ``LLMDecisionModel``.
    """

    min_confidence: float


class Question(TypedDict):
    """A single question posed to a decision model.

    Attributes:
        question: The question posed to the model, in natural language.
        choices: Answer shape: ``"boolean"`` or a non-empty list of string literals.
        uncertainty: Uncertainty configuration for this question. Omitted or ``True`` permits an
            uncertain answer (the default); ``False`` disables it, forcing a commitment to one of
            ``choices``; an ``UncertaintyOptions`` mapping permits it with a custom minimum
            confidence.
    """

    question: str
    choices: Literal["boolean"] | list[str]
    uncertainty: NotRequired[bool | UncertaintyOptions]


@dataclass(frozen=True)
class Uncertain:
    """Sentinel returned in place of an answer when the decision model declined to commit.

    Carries an optional free-form reason supplied by the implementation. Note that an ``Uncertain``
    instance is truthy: always narrow an answer with ``isinstance(value, Uncertain)`` before using
    it, rather than relying on its truthiness.

    Attributes:
        reason: Optional free-form explanation for the uncertainty.
    """

    reason: str | None = None

    def __str__(self) -> str:
        """Render as ``Uncertain(reason)`` or ``Uncertain`` when no reason is set."""
        return f"Uncertain({self.reason})" if self.reason is not None else "Uncertain"


@dataclass
class DecisionMetadata:
    """Per-call metadata recorded by a decision model implementation.

    Attributes:
        latency_ms: Time spent in the underlying model call, in milliseconds.
    """

    latency_ms: int


@dataclass
class DecisionResult:
    """Result returned by ``DecisionModel.ask``, keyed by the same identifiers as the question map.

    Attributes:
        answers: Per-question answer, keyed by question id. Each value is a ``bool`` (boolean
            question), one of the question's ``choices``, or ``Uncertain``. Narrow with
            ``isinstance(value, Uncertain)`` before using an answer.
        metadata: Per-call metadata recorded by the implementation.
        usage: Aggregate token usage for the underlying model call, when the provider reports it.
    """

    answers: dict[str, bool | str | Uncertain]
    metadata: DecisionMetadata
    usage: Usage | None = None
