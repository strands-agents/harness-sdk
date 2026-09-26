"""TypeSafe System One decision model provider (Jev, and self-hosted servers such as Kev).

- Docs: https://docs.typesafe.ai/
- API: https://docs.typesafe.ai/api
- Kev (open, self-hosted, same API): https://github.com/jaredpalmer/kev
"""

from __future__ import annotations

import json
import logging
import math
import os
from collections.abc import Mapping
from typing import Any, TypedDict

from typing_extensions import Unpack, override

from ..experimental.decisions import (
    Answer,
    Choice,
    ChoiceAnswer,
    DecisionModel,
    DecisionResponse,
    DecisionState,
    Question,
    Score,
    ScoreAnswer,
    YesNoAnswer,
    yes_no_confidence,
)
from ..types.event_loop import Usage
from ..types.exceptions import ContextWindowOverflowException, ModelThrottledException
from ._validation import validate_config_keys

try:
    import typesafe_sdk
except ImportError as import_error:  # pragma: no cover - exercised only without the optional extra
    raise ImportError(
        "TypeSafeDecisionModel requires the typesafe SDK: pip install 'strands-agents[typesafe]'"
    ) from import_error

logger = logging.getLogger(__name__)

API_KEY_ENV = "TYPESAFE_API_KEY"
BASE_URL_ENV = "TYPESAFE_BASE_URL"
DEFAULT_BASE_URL = "https://api.typesafe.ai"
DEFAULT_MODEL_ID = "jev-latest"
MAX_REQUEST_TOKENS = 64_000
MAX_STATE_PLUS_QUESTION_TOKENS = 32_000
# Kev serves one row of state plus one question in 8,192 tokens and batches questions itself, so it has no
# per-request cap. Past the row limit it truncates the state or rejects the question, so check before sending.
KEV_MAX_STATE_PLUS_QUESTION_TOKENS = 8_192
# TypeSafe API limits, checked before sending. They are provider limits, not part of the Choice/Score contract.
MAX_CHOICE_OPTIONS = 255
MAX_SCORE_LEVELS = 10
# Sent to a self-hosted server when no key is given; Kev is open unless its operator sets KEV_API_KEY.
_LOCAL_API_KEY = "local"
_OVERLOADED_STATUS = 529


class TypeSafeDecisionModel(DecisionModel):
    """System One decisions from any server that speaks TypeSafe's ``/v1/systemone`` API.

    By default this calls TypeSafe's hosted Jev models. Pass ``base_url`` to call a self-hosted server with the
    same API, such as Kev::

        TypeSafeDecisionModel(
            base_url="http://127.0.0.1:8009",
            model_id="kev-latest",
            max_state_plus_question_tokens=KEV_MAX_STATE_PLUS_QUESTION_TOKENS,
            max_request_tokens=None,
        )

    Calibrated: Jev's probabilities are trained for calibration, and each Kev checkpoint ships with a temperature
    fitted on held-out data (a Kev server started with ``KEV_TEMPERATURE=1.0`` returns raw probabilities instead;
    re-check thresholds if you run it that way). Aliases such as ``jev-latest`` can move to a new release; pin a
    versioned id (for example ``jev-1.13.0``) once you have tuned thresholds against it. The id the server reports
    is recorded on every response and decision span. Kev echoes the requested name, so read its ``/v1/models`` for
    the checkpoint behind it.
    """

    class TypeSafeConfig(TypedDict, total=False):
        """Configuration for TypeSafe decision models.

        Attributes:
            model_id: Model name or alias sent in the request's ``model`` field.
            max_state_plus_question_tokens: Estimated-token budget for the state plus the longest question,
                checked before sending. Defaults to Jev's 32,000; use ``KEV_MAX_STATE_PLUS_QUESTION_TOKENS``
                (8,192) for Kev.
            max_request_tokens: Estimated-token budget for the whole request, or ``None`` for no cap. Defaults to
                Jev's 64,000; Kev has no per-request cap.
        """

        model_id: str
        max_state_plus_question_tokens: int
        max_request_tokens: int | None

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        client: Any | None = None,
        client_args: dict[str, Any] | None = None,
        **model_config: Unpack[TypeSafeConfig],
    ) -> None:
        """Initialize the provider.

        Args:
            api_key: API key sent as a bearer token. For TypeSafe's server it defaults to the ``TYPESAFE_API_KEY``
                environment variable. For any other ``base_url`` it is never read from ``TYPESAFE_API_KEY``, so a
                TypeSafe key is not sent to a third-party server; without one a placeholder is sent, which an open
                Kev server accepts.
            base_url: Server root. Defaults to the ``TYPESAFE_BASE_URL`` environment variable, else
                ``https://api.typesafe.ai``.
            client: A preconfigured ``typesafe_sdk.AsyncTypeSafeClient``; when given, ``api_key``, ``base_url`` and
                ``client_args`` are ignored and the caller owns its lifecycle (it must be used from one event loop).
                Without it, a client is created per request, so the model is safe to share across event loops
                (for example between ``agent()`` sync calls).
            client_args: Extra keyword arguments for ``AsyncTypeSafeClient`` (for example ``timeout`` or ``retry``).
            **model_config: Model configuration; see ``TypeSafeConfig``.

        Raises:
            ValueError: If no client is given, the server is TypeSafe's, and no API key is found.
        """
        validate_config_keys(model_config, self.TypeSafeConfig)
        self.config = TypeSafeDecisionModel.TypeSafeConfig(
            model_id=DEFAULT_MODEL_ID,
            max_state_plus_question_tokens=MAX_STATE_PLUS_QUESTION_TOKENS,
            max_request_tokens=MAX_REQUEST_TOKENS,
        )
        self.config.update(model_config)
        self._client = client
        self._client_args = dict(client_args or {})
        self.base_url = (base_url or os.environ.get(BASE_URL_ENV, "").strip() or DEFAULT_BASE_URL).rstrip("/")
        self._api_key = api_key or self._default_api_key()
        if client is None and not self._api_key:
            raise ValueError(f"TypeSafeDecisionModel needs an API key: pass api_key= or set {API_KEY_ENV}")

    def _default_api_key(self) -> str:
        if self.base_url != DEFAULT_BASE_URL:
            return _LOCAL_API_KEY
        return os.environ.get(API_KEY_ENV, "").strip()

    @property
    @override
    def calibrated(self) -> bool:
        """Jev and Kev both return calibrated probabilities."""
        return True

    @override
    def update_config(self, **model_config: Unpack[TypeSafeConfig]) -> None:  # type: ignore[override]
        """Update the model configuration.

        Args:
            **model_config: Configuration overrides; see ``TypeSafeConfig``.
        """
        validate_config_keys(model_config, self.TypeSafeConfig)
        self.config.update(model_config)

    @override
    def get_config(self) -> TypeSafeConfig:
        """Return the model configuration."""
        return self.config

    @override
    async def _ask(self, state: DecisionState, questions: Mapping[str, Question], **kwargs: Any) -> DecisionResponse:
        """Answer every question in one ``/v1/systemone`` request.

        Raises:
            ContextWindowOverflowException: If the request exceeds the configured context budgets; raised before
                sending.
            ModelThrottledException: On rate limiting (429) or overload (529).
            ValueError: If a question exceeds the API's option or level limits (raised before sending), or the
                API rejects the request as invalid (400/422).
        """
        _check_limits(questions)
        _check_budget(
            state,
            questions,
            max_row=self.config["max_state_plus_question_tokens"],
            max_request=self.config.get("max_request_tokens"),
        )
        vendor_questions = {question_id: _to_vendor(question) for question_id, question in questions.items()}
        try:
            response = await self._system_one(state, vendor_questions)
        except typesafe_sdk.TypeSafeRateLimitError as error:
            raise ModelThrottledException(str(error)) from error
        except (typesafe_sdk.TypeSafeUnprocessableEntityError, typesafe_sdk.TypeSafeBadRequestError) as error:
            raise ValueError(f"TypeSafe rejected the decision request: {error}") from error
        except typesafe_sdk.TypeSafeAPIError as error:
            if error.status == _OVERLOADED_STATUS:
                raise ModelThrottledException(str(error)) from error
            raise

        input_tokens = response.usage.input_tokens or 0
        output_tokens = response.usage.output_tokens or 0
        logger.debug(
            "model=<%s>, questions=<%d>, input_tokens=<%d> | typesafe decision answered",
            response.model,
            len(questions),
            input_tokens,
        )
        return DecisionResponse(
            answers={question_id: _from_vendor(answer) for question_id, answer in response.answers.items()},
            model_id=response.model,
            usage=Usage(inputTokens=input_tokens, outputTokens=output_tokens, totalTokens=input_tokens + output_tokens),
        )

    async def _system_one(self, state: DecisionState, questions: Mapping[str, Any]) -> Any:
        if self._client is not None:
            return await self._client.system_one(state=state, questions=questions, model=self.config["model_id"])
        async with typesafe_sdk.AsyncTypeSafeClient(
            api_key=self._api_key, base_url=self.base_url, **self._client_args
        ) as client:
            return await client.system_one(state=state, questions=questions, model=self.config["model_id"])


def _check_limits(questions: Mapping[str, Question]) -> None:
    for question_id, question in questions.items():
        if isinstance(question, Choice) and len(question.options) > MAX_CHOICE_OPTIONS:
            count = len(question.options)
            raise ValueError(f"{question_id}: TypeSafe allows at most {MAX_CHOICE_OPTIONS} Choice options, got {count}")
        if isinstance(question, Score) and len(question.levels) > MAX_SCORE_LEVELS:
            count = len(question.levels)
            raise ValueError(f"{question_id}: TypeSafe allows at most {MAX_SCORE_LEVELS} Score levels, got {count}")


def _estimate_tokens(value: Any) -> int:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return math.ceil(len(text) / 4)


def _check_budget(
    state: DecisionState, questions: Mapping[str, Question], *, max_row: int, max_request: int | None
) -> None:
    state_tokens = _estimate_tokens(state)
    question_tokens = [_estimate_tokens(_to_wire(question)) for question in questions.values()]
    longest = max(question_tokens)
    if state_tokens + longest > max_row:
        raise ContextWindowOverflowException(
            f"decision state plus the longest question is ~{state_tokens + longest} tokens; this model allows "
            f"{max_row}. Trim the state or split the question."
        )
    total = state_tokens + sum(question_tokens)
    if max_request is not None and total > max_request:
        raise ContextWindowOverflowException(
            f"decision request is ~{total} tokens; this model allows {max_request} per request. "
            "Split the questions across requests."
        )


def _to_wire(question: Question) -> dict[str, Any]:
    if isinstance(question, Choice):
        return {"type": "choice", "instructions": question.instructions, "criteria": dict(question.options)}
    if isinstance(question, Score):
        return {"type": "score", "instructions": question.instructions, "criteria": list(question.levels)}
    criteria = {key: value for key, value in (("true", question.true), ("false", question.false)) if value is not None}
    return {"type": "noul", "instructions": question.instructions, **({"criteria": criteria} if criteria else {})}


def _to_vendor(question: Question) -> Any:
    if isinstance(question, Choice):
        return typesafe_sdk.Choice(instructions=question.instructions, criteria=dict(question.options))
    if isinstance(question, Score):
        return typesafe_sdk.Score(instructions=question.instructions, criteria=list(question.levels))
    return typesafe_sdk.Noul(instructions=question.instructions, criteria=_to_wire(question).get("criteria"))


def _from_vendor(answer: Any) -> Answer:
    if isinstance(answer, typesafe_sdk.NoulAnswer):
        return YesNoAnswer(probability=answer.noul, confidence=yes_no_confidence(answer.noul))
    if isinstance(answer, typesafe_sdk.ChoiceAnswer):
        return ChoiceAnswer(
            choice=answer.choice, probabilities=dict(answer.probabilities), confidence=answer.confidence
        )
    if isinstance(answer, typesafe_sdk.ScoreAnswer):
        return ScoreAnswer(
            score=answer.score,
            probabilities={int(level): value for level, value in answer.probabilities.items()},
            confidence=answer.confidence,
        )
    raise ValueError(f"unsupported TypeSafe answer type {type(answer).__name__}")
