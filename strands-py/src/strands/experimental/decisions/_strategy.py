"""Model routing with a System One decision model."""

from __future__ import annotations

import json
import logging
from typing import Any

from ...models._request_text import project_state
from ...models.routing.router import RoutingCandidate
from ...models.routing.strategy import RoutingContext
from ._model import DecisionModel
from ._types import Choice, ChoiceAnswer

logger = logging.getLogger(__name__)

_DEFAULT_INSTRUCTIONS = (
    "Which candidate model is the least capable one that can still fully and accurately handle `request`? "
    "Rule out candidates whose description shows they cannot meet a requirement of the request; reserve more "
    "capable candidates for requests whose complexity genuinely needs them. `agent_instructions` describe the "
    "agent the request is sent to. Treat missing candidate evidence as unknown, not unsupported."
)


class _ConfidenceGate:
    """``min_confidence`` check shared by the adapters; an answer without confidence counts as unsure.

    The first unsure-because-unmeasured answer logs a warning, so a gate on a model that never reports confidence
    (for example an LLM without logprobs) is visible rather than silently always declining.
    """

    def __init__(self, owner: str, min_confidence: float | None) -> None:
        self._owner = owner
        self.min_confidence = min_confidence
        self._warned = False

    def unsure(self, confidence: float | None) -> bool:
        """True when a gate is set and ``confidence`` is below it or missing."""
        if self.min_confidence is None:
            return False
        if confidence is None:
            if not self._warned:
                self._warned = True
                logger.warning(
                    "adapter=<%s>, min_confidence=<%s> | answer has no confidence; treating it as unsure",
                    self._owner,
                    self.min_confidence,
                )
            return True
        return confidence < self.min_confidence


class DecisionStrategy:
    """Choose the router's candidate with one System One ``Choice`` over the candidates' evidence.

    When the answer carries a confidence, this strategy can decline on *ambiguity* as well as on errors: below
    ``min_confidence``, or with no confidence, the router serves its default candidate. It chooses only the opening
    candidate and declines after a failure, so the model's error surfaces.
    """

    def __init__(
        self,
        decision_model: DecisionModel,
        *,
        min_confidence: float | None = None,
        instructions: str = _DEFAULT_INSTRUCTIONS,
        max_request_tokens: int = 1_000,
        max_instruction_tokens: int = 1_000,
    ) -> None:
        """Initialize the strategy.

        Args:
            decision_model: The model that makes the routing decision.
            min_confidence: Decline (serve the router default) when the choice's confidence is below this or
                missing.
            instructions: The routing question. Candidate evidence and the request are sent as state.
            max_request_tokens: Budget for the latest request text sent as state.
            max_instruction_tokens: Budget for the parent agent's system-prompt text sent as state.

        Raises:
            ValueError: If a budget is not positive.
        """
        if max_request_tokens <= 0 or max_instruction_tokens <= 0:
            raise ValueError("token budgets must be greater than zero")
        self._model = decision_model
        self._gate = _ConfidenceGate("DecisionStrategy", min_confidence)
        self._instructions = instructions
        self._request_tokens = max_request_tokens
        self._instruction_tokens = max_instruction_tokens

    async def select(self, context: RoutingContext, **kwargs: Any) -> RoutingCandidate | None:
        """Return the chosen opening candidate, or None to decline."""
        if context.attempts:
            return None
        if len(context.candidates) == 1:
            return context.candidates[0]
        keys = {f"c{index}": candidate for index, candidate in enumerate(context.candidates)}
        question = Choice(self._instructions, options={key: _evidence(candidate) for key, candidate in keys.items()})
        state = project_state(
            context.messages,
            context.system_prompt,
            max_tokens=self._request_tokens,
            max_instruction_tokens=self._instruction_tokens,
        )
        try:
            response = await self._model.ask(state, {"candidate": question})
        except Exception as error:
            logger.warning(
                "strategy=<%s>, reason=<decision_error>, error_type=<%s> | routing declined",
                type(self).__name__,
                type(error).__name__,
            )
            return None
        answer = response.answers["candidate"]
        assert isinstance(answer, ChoiceAnswer)
        if self._gate.unsure(answer.confidence):
            logger.debug(
                "choice=<%s>, confidence=<%s>, min_confidence=<%s> | routing declined on low confidence",
                answer.choice,
                answer.confidence,
                self._gate.min_confidence,
            )
            return None
        return keys[answer.choice]


def _evidence(candidate: RoutingCandidate) -> str | None:
    evidence = {
        key: value
        for key, value in (
            ("name", candidate.name),
            ("description", candidate.description),
            ("metadata", candidate.metadata),
        )
        if value
    }
    return json.dumps(evidence, ensure_ascii=False, default=str) if evidence else None
