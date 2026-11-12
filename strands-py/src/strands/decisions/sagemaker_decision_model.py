"""Decision model backed by a System One model on a SageMaker AI real-time endpoint."""

import asyncio
import json
import re
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config as BotocoreConfig

from ..types.exceptions import (
    ContextWindowOverflowException,
    ModelThrottledException,
    StructuredOutputException,
)
from ._system_one_http_adapter import _ask_system_one, _resolve_default_min_confidence, _SystemOneRequestConfig
from .decision_model import DecisionModel
from .types import DecisionInput, DecisionResult, Question

if TYPE_CHECKING:
    from mypy_boto3_sagemaker_runtime import SageMakerRuntimeClient

_SAGEMAKER_PROVIDER_NAME = "sagemaker"
_SAGEMAKER_DEFAULT_MIN_CONFIDENCE = 0.5
# Seconds. The boto3 call runs in a worker thread that a cancelled ``ask`` cannot interrupt, so this
# bounds how long an abandoned call keeps running.
_DEFAULT_READ_TIMEOUT = 120


class SageMakerDecisionModel(DecisionModel):
    """Decision model backed by a System One model on a SageMaker AI real-time endpoint.

    The endpoint, such as a strands-decider model, is invoked through the boto3
    ``sagemaker-runtime`` client: requests are signed with AWS Signature Version 4 using the
    standard credential chain, so callers need ``sagemaker:InvokeEndpoint`` on the endpoint and no
    API key.

    ``ask`` raises ``ModelThrottledException`` on SageMaker throttling (``ThrottlingException``,
    ``ModelNotReadyException``, ``ServiceUnavailable``) and on a container or proxy 429/503/529,
    ``ContextWindowOverflowException`` when the request exceeds the context window or payload limit
    (HTTP 413, or a container 422 whose message names the context window), ``ValueError`` for
    request-level violations (too many choices, binary content, state that is not JSON-serializable
    or contains NaN/infinity), and ``StructuredOutputException`` for a malformed provider response.
    Any other SageMaker runtime error (e.g. ``botocore.exceptions.ClientError``) propagates
    unchanged.

    The blocking boto3 call runs in a worker thread, so cancelling ``ask`` (for example on a caller
    timeout) stops waiting for it but cannot stop the in-flight request; the client's read timeout
    bounds how long it keeps running.

    Example:
        ```python
        decisions = SageMakerDecisionModel("my-decider-endpoint", region_name="us-east-1")
        result = await decisions.ask(
            "A customer needs a refund today.",
            {"urgent": {"question": "Is this urgent?", "choices": "boolean"}},
        )
        ```
    """

    def __init__(
        self,
        endpoint_name: str,
        *,
        region_name: str | None = None,
        boto_client_config: BotocoreConfig | None = None,
        client: "SageMakerRuntimeClient | None" = None,
        default_min_confidence: float = _SAGEMAKER_DEFAULT_MIN_CONFIDENCE,
    ) -> None:
        """Create a SageMaker-backed decision model.

        Args:
            endpoint_name: Name of the SageMaker AI real-time endpoint serving the System One model.
            region_name: AWS region of the endpoint. Takes precedence over ``boto_client_config``'s
                region. Cannot be combined with ``client``.
            boto_client_config: ``botocore`` configuration for the ``sagemaker-runtime`` client.
                Defaults to a 120-second read timeout. Cannot be combined with ``client``.
            client: Pre-built ``sagemaker-runtime`` client, for example one shared with other
                components or configured with custom credentials or an endpoint override. Used as
                is. Cannot be combined with ``region_name`` or ``boto_client_config``.
            default_min_confidence: Default minimum confidence in ``[0.0, 1.0]``. Defaults to ``0.5``.

        Raises:
            ValueError: If the endpoint name is empty, the confidence threshold is out of range, or
                ``client`` is combined with ``region_name`` or ``boto_client_config``.
        """
        super().__init__()
        resolved_endpoint_name = (endpoint_name or "").strip()
        if not resolved_endpoint_name:
            raise ValueError("SageMakerDecisionModel requires an endpoint_name")
        if client is not None and (region_name is not None or boto_client_config is not None):
            raise ValueError(
                "Cannot specify both client and region_name/boto_client_config. "
                "Configure them on the sagemaker-runtime client instead."
            )

        self._endpoint_name = resolved_endpoint_name
        self._client = client if client is not None else _build_client(region_name, boto_client_config)
        self._request_config = _SystemOneRequestConfig(
            provider_name=_SAGEMAKER_PROVIDER_NAME,
            default_min_confidence=_resolve_default_min_confidence(default_min_confidence, "SageMakerDecisionModel"),
        )

    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        return await _ask_system_one(self._request_config, self._invoke, state, questions)

    async def _invoke(self, body: str) -> Any:
        # The boto3 client is synchronous, so run the blocking call off the event loop thread.
        return await asyncio.to_thread(self._invoke_sync, body)

    def _invoke_sync(self, body: str) -> Any:
        try:
            response = self._client.invoke_endpoint(
                EndpointName=self._endpoint_name,
                ContentType="application/json",
                Accept="application/json",
                Body=body.encode("utf-8"),
            )
        except Exception as error:
            mapped = _translate_sagemaker_error(error)
            if mapped is not None:
                raise mapped from error
            raise

        # Lenient decode (like the TS TextDecoder): invalid bytes surface as a non-JSON response,
        # never a raw UnicodeDecodeError.
        text = response["Body"].read().decode("utf-8", errors="replace")
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError as error:
            raise StructuredOutputException("decision provider returned a non-JSON response") from error


def _build_client(region_name: str | None, boto_client_config: BotocoreConfig | None) -> "SageMakerRuntimeClient":
    config = boto_client_config or BotocoreConfig(read_timeout=_DEFAULT_READ_TIMEOUT)
    existing_user_agent = getattr(config, "user_agent_extra", None)
    user_agent = f"{existing_user_agent} strands-agents" if existing_user_agent else "strands-agents"
    config = config.merge(BotocoreConfig(user_agent_extra=user_agent))
    return boto3.client("sagemaker-runtime", region_name=region_name, config=config)


def _translate_sagemaker_error(error: Exception) -> Exception | None:
    """Map a SageMaker runtime error to an SDK exception, or None to re-raise it unchanged.

    A container's own HTTP error arrives as a SageMaker ``ModelError`` carrying the container's
    status in ``OriginalStatusCode``; any other failure carries the HTTP status of the SageMaker
    response in ``ResponseMetadata.HTTPStatusCode``.
    """
    response = getattr(error, "response", None)
    code = original_status = original_message = http_status = None
    if isinstance(response, dict):
        error_field = response.get("Error")
        if isinstance(error_field, dict):
            code = error_field.get("Code")
        original_status = response.get("OriginalStatusCode")
        original_message = response.get("OriginalMessage")
        metadata = response.get("ResponseMetadata")
        if isinstance(metadata, dict):
            http_status = metadata.get("HTTPStatusCode")
    status = _to_status(original_status if original_status is not None else http_status)

    message = f"{_SAGEMAKER_PROVIDER_NAME} decision request failed: {error}"
    # Retryable SageMaker errors (InvokeEndpoint API reference and AWS common errors).
    if code in ("ThrottlingException", "ModelNotReadyException", "ServiceUnavailable"):
        return ModelThrottledException(message)
    # Throttling by the container or a proxy.
    if status in (429, 503, 529):
        return ModelThrottledException(message)
    if status == 413:
        return ContextWindowOverflowException(message)
    # Validation errors share strands-decider's 422, so only the message tells a context overflow apart.
    if status == 422 and _is_context_overflow_message(original_message):
        return ContextWindowOverflowException(message)
    return None


def _to_status(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _is_context_overflow_message(original_message: Any) -> bool:
    """Whether a container's 422 body reports a prompt longer than the model's context window.

    strands-decider sends 422 ``{"detail": "... exceeds the context window ..."}`` when deployed
    with ``--strict-window``. Validation errors also use 422, but their ``detail`` is a list that
    echoes the request, so only a string ``detail`` is matched.
    """
    if not isinstance(original_message, str):
        return False
    try:
        parsed = json.loads(original_message)
    except ValueError:
        return False
    detail = parsed.get("detail") if isinstance(parsed, dict) else None
    return isinstance(detail, str) and re.search(r"context window", detail, re.IGNORECASE) is not None
