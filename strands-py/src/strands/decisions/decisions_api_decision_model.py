"""Decision model backed by decisionapi.net."""

from typing import Any

import httpx

from ._system_one_http_adapter import _ask_system_one, _resolve_system_one_provider_config
from .decision_model import DecisionModel
from .types import DecisionInput, DecisionResult, Question

_DECISIONS_API_ENDPOINT = "https://decisionapi.net/v1/systemone"
_DECISIONS_API_DEFAULT_MODEL_ID = "~typesafe/jev-latest"
_DECISIONS_API_DEFAULT_MIN_CONFIDENCE = 0.5
_DECISIONS_API_MAX_QUESTIONS = 8
_DECISIONS_API_MAX_BODY_BYTES = 32 * 1024


class DecisionsAPIDecisionModel(DecisionModel):
    """Decision model backed by decisionapi.net.

    ``ask`` raises ``ModelThrottledException`` on provider throttling (HTTP 429/503/529, with the
    ``httpx.HTTPStatusError`` as ``__cause__``), ``ContextWindowOverflowException`` when the request
    exceeds the provider's size limit (HTTP 413 or the pre-send body-byte check), ``ValueError`` for
    request-level violations (more than eight questions, too many choices, binary content, state
    that is not JSON-serializable or contains NaN/infinity), ``httpx.HTTPStatusError`` for any other
    non-2xx response, and ``StructuredOutputException`` for a malformed provider response.
    Transport errors from the HTTP client (e.g. ``httpx.TimeoutException``, ``httpx.ConnectError``)
    propagate unchanged.

    Example:
        ```python
        decisions = DecisionsAPIDecisionModel()  # reads JEV_API_KEY from the environment
        result = await decisions.ask(
            "A customer needs a refund today.",
            {"department": {"question": "Which team should handle this?", "choices": ["billing", "support"]}},
        )
        ```
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model_id: str = _DECISIONS_API_DEFAULT_MODEL_ID,
        default_min_confidence: float = _DECISIONS_API_DEFAULT_MIN_CONFIDENCE,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """Create a decisionapi.net-backed decision model.

        Args:
            api_key: Decisions API key. Defaults to the ``JEV_API_KEY`` environment variable.
            model_id: Decisions API model identifier. Defaults to ``~typesafe/jev-latest``.
            default_min_confidence: Default minimum confidence in ``[0.0, 1.0]``. Defaults to ``0.5``.
            http_client: ``httpx.AsyncClient`` used for the request. The caller owns and closes it;
                pass one to reuse connections across decisions, set a timeout, or add headers. When
                omitted, a client with a 30-second timeout is created per request.

        Raises:
            ValueError: If the API key is missing, ``model_id`` is empty, or the confidence threshold
                is out of range.
            TypeError: If ``http_client`` is not an ``httpx.AsyncClient``.
        """
        super().__init__()
        self._provider_config = _resolve_system_one_provider_config(
            class_name="DecisionsAPIDecisionModel",
            provider_name="decisions_api",
            endpoint=_DECISIONS_API_ENDPOINT,
            api_key_environment_variable="JEV_API_KEY",
            max_body_bytes=_DECISIONS_API_MAX_BODY_BYTES,
            max_questions=_DECISIONS_API_MAX_QUESTIONS,
            api_key=api_key,
            model_id=model_id,
            min_confidence=default_min_confidence,
            http_client=http_client,
        )

    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        return await _ask_system_one(self._provider_config, state, questions)
