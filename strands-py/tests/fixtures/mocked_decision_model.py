"""A scripted DecisionModel for unit tests: returns queued answers and records every request."""

from collections.abc import Mapping
from typing import Any

from strands.experimental.decisions import (
    Answer,
    Choice,
    ChoiceAnswer,
    DecisionModel,
    DecisionResponse,
    Question,
    Score,
    ScoreAnswer,
    YesNoAnswer,
)


def choice(
    option: str, probabilities: Mapping[str, float] | None = None, confidence: float | None = 0.9
) -> ChoiceAnswer:
    """Build a ChoiceAnswer; probabilities default to one-hot on ``option``."""
    return ChoiceAnswer(choice=option, probabilities=dict(probabilities or {option: 1.0}), confidence=confidence)


def yes(probability: float) -> YesNoAnswer:
    """Build a YesNoAnswer."""
    return YesNoAnswer(probability=probability)


def score(value: float, levels: int = 3, confidence: float | None = 0.9) -> ScoreAnswer:
    """Build a ScoreAnswer peaked at round(value)."""
    peak = round(value)
    return ScoreAnswer(
        score=value, probabilities={level: float(level == peak) for level in range(levels)}, confidence=confidence
    )


class MockedDecisionModel(DecisionModel):
    """Answers from a queue of per-call answer maps, or raises a queued exception.

    ``requests`` records ``(state, questions)`` for every call so tests can assert what was asked.
    An answer map may omit questions; omitted Choice/Score/YesNo questions get a deterministic default
    (first option, level 0, probability 0.0) so tests only script what they assert on.
    """

    def __init__(
        self, *responses: Mapping[str, Answer] | Exception, calibrated: bool = True, model_id: str = "mock-s1"
    ):
        self._responses = list(responses)
        self._calibrated = calibrated
        self._config = {"model_id": model_id}
        self.requests: list[tuple[Any, dict[str, Question]]] = []

    @property
    def calibrated(self) -> bool:
        return self._calibrated

    def get_config(self) -> dict[str, Any]:
        return self._config

    def update_config(self, **config: Any) -> None:
        self._config.update(config)

    async def _ask(self, state: Any, questions: Mapping[str, Question], **kwargs: Any) -> DecisionResponse:
        self.requests.append((state, dict(questions)))
        scripted = self._responses.pop(0) if self._responses else {}
        if isinstance(scripted, Exception):
            raise scripted
        answers = {qid: scripted.get(qid) or _default(question) for qid, question in questions.items()}
        return DecisionResponse(
            answers=answers,
            model_id=f"{self._config['model_id']}-1.0",
            usage={"inputTokens": 10, "outputTokens": 2, "totalTokens": 12},
        )


def _default(question: Question) -> Answer:
    if isinstance(question, Choice):
        first = next(iter(question.options))
        return choice(first, {option: float(option == first) for option in question.options})
    if isinstance(question, Score):
        return score(0.0, levels=len(question.levels))
    return yes(0.0)
