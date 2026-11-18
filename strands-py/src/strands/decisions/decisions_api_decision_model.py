"""Decision model backed by decisionapi.net."""

from typing import Any

import httpx

from ..types.exceptions import StructuredOutputException
from ._system_one_http_adapter import (
    _ask_system_one,
    _http_transport,
    _require_record,
    _resolve_system_one_provider_config,
)
from .decision_model import DecisionModel
from .types import DecisionInput, DecisionResult, Question

_DECISIONS_API_ENDPOINT = "https://decisionapi.net/v1/systemone"
_DECISIONS_API_DEFAULT_MODEL_ID = "~typesafe/jev-latest"
_DECISIONS_API_DEFAULT_MIN_CONFIDENCE = 0.5
_DECISIONS_API_MAX_QUESTIONS = 8


class DecisionsAPIDecisionModel(DecisionModel):
    """Decision model backed by decisionapi.net.

    ``ask`` raises ``ModelThrottledException`` on provider throttling (HTTP 429/503/529, with the
    ``httpx.HTTPStatusError`` as ``__cause__``), ``ContextWindowOverflowException`` when the request
    exceeds the provider's size limit (HTTP 413), ``ValueError`` for
    request-level violations (more than eight questions, too many choices, binary content, state
    that is not JSON-serializable or contains NaN/infinity), ``httpx.HTTPStatusError`` for any other
    non-2xx response, and ``StructuredOutputException`` for a malformed provider response
    or an HTTP 200 body that carries a non-zero error ``code``.
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
            max_questions=_DECISIONS_API_MAX_QUESTIONS,
            api_key=api_key,
            model_id=model_id,
            min_confidence=default_min_confidence,
            http_client=http_client,
        )

    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        transport = _http_transport(self._provider_config)

        async def unwrapping_transport(body: str) -> Any:
            return self._unwrap_envelope(await transport(body))

        return await _ask_system_one(self._provider_config, unwrapping_transport, state, questions)

    def _unwrap_envelope(self, payload: Any) -> Any:
        """Return the System One result from decisionapi.net's ``{code, message, data: {result}}`` envelope.

        The envelope does not carry the model, so the result reports the requested one unless it
        names its own. A payload that is not enveloped is returned unchanged.
        """
        if not isinstance(payload, dict) or ("code" not in payload and "data" not in payload):
            return payload

        code = payload.get("code")
        if isinstance(code, bool) or code != 0:
            message = payload.get("message")
            detail = f": {message}" if isinstance(message, str) else ""
            raise StructuredOutputException(f"decision provider returned error code {code}{detail}")

        data = _require_record(payload.get("data"), "decision provider data")
        result = _require_record(data.get("result"), "decision provider result")
        return {"model": self._provider_config.model_id, **result}
