"""Decision model backed by TypeSafe's hosted Jev API."""

from typing import Any

import httpx

from ._system_one_http_adapter import _ask_system_one, _resolve_system_one_provider_config
from .decision_model import DecisionModel
from .types import DecisionInput, DecisionResult, Question

_TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
_TYPESAFE_DEFAULT_MODEL_ID = "jev-latest"
_TYPESAFE_DEFAULT_MIN_CONFIDENCE = 0.5
_TYPESAFE_MAX_BODY_BYTES = 32 * 1024 * 1024


class TypeSafeDecisionModel(DecisionModel):
    """Decision model backed by TypeSafe's hosted Jev API.

    ``ask`` raises ``ModelThrottledException`` on provider throttling (HTTP 429/529),
    ``ContextWindowOverflowException`` when the request exceeds the provider's size limit (HTTP 413
    or the pre-send body-byte check), ``ValueError`` for request-level violations (too many choices,
    binary content), and ``StructuredOutputException`` for transport failures and any other
    provider error, with the original error available as ``__cause__``.

    Example:
        ```python
        decisions = TypeSafeDecisionModel()  # reads TYPESAFE_API_KEY from the environment
        result = await decisions.ask(
            "A customer needs a refund today.",
            {"urgent": {"question": "Is this urgent?", "choices": "boolean"}},
        )
        ```
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model_id: str | None = None,
        default_min_confidence: float | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """Create a TypeSafe-backed decision model.

        Args:
            api_key: TypeSafe API key. Defaults to the ``TYPESAFE_API_KEY`` environment variable.
            model_id: Jev model identifier. Defaults to ``jev-latest``.
            default_min_confidence: Default minimum confidence in ``[0.0, 1.0]``. Defaults to ``0.5``.
            http_client: ``httpx.AsyncClient`` used for the request. The caller owns and closes it;
                pass one to reuse connections across decisions, set a timeout, or add headers. When
                omitted, a client with no timeout is created per request (mirroring the TypeScript
                port's reliance on ``fetch``).

        Raises:
            ValueError: If the API key is missing or the confidence threshold is out of range.
            TypeError: If ``http_client`` is not an ``httpx.AsyncClient``.
        """
        super().__init__()
        self._provider_config = _resolve_system_one_provider_config(
            class_name="TypeSafeDecisionModel",
            provider_name="typesafe",
            endpoint=_TYPESAFE_ENDPOINT,
            api_key_environment_variable="TYPESAFE_API_KEY",
            default_model_id=_TYPESAFE_DEFAULT_MODEL_ID,
            default_min_confidence=_TYPESAFE_DEFAULT_MIN_CONFIDENCE,
            max_body_bytes=_TYPESAFE_MAX_BODY_BYTES,
            api_key=api_key,
            model_id=model_id,
            min_confidence=default_min_confidence,
            http_client=http_client,
        )

    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        return await _ask_system_one(self._provider_config, state, questions)
