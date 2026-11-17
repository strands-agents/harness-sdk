"""Shared transport for System One decision providers (Jev, decisionapi.net).

Builds the ``POST /v1/systemone`` request from a question map, validates the response, and
normalizes answers back into the SDK's ``DecisionResult`` shape. Internal: concrete providers own
their endpoints, credentials, defaults, and limits and delegate the wire work here.
"""

import json
import math
import os
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, NoReturn, TypeGuard

import httpx

from ..types.content import ContentBlock, Messages
from ..types.event_loop import Usage
from ..types.exceptions import (
    ContextWindowOverflowException,
    ModelThrottledException,
    StructuredOutputException,
)
from .types import DecisionInput, DecisionMetadata, DecisionResult, Question, Uncertain

_MAX_CHOICE_COUNT = 255
_PROBABILITY_TOLERANCE = 1e-6
# System One servers such as strands-decider round each probability to 4 decimals,
# so a distribution over N choices may sum to 1 within N * 5e-5.
_PROBABILITY_ROUNDING_TOLERANCE = 5e-5
_BINARY_MEDIA_KEYS = ("audio", "image", "video", "document")

# Sends a serialized System One request and resolves to the parsed JSON response payload. Raises a
# model-error exception when the request fails.
_SystemOneTransport = Callable[[str], Awaitable[Any]]


@dataclass(kw_only=True)
class _SystemOneRequestConfig:
    """Request mapping and limits shared by every System One transport."""

    provider_name: str
    default_min_confidence: float
    # Sent as the request's ``model``; omitted when None so the server uses its own.
    model_id: str | None = None
    max_questions: int | None = None


@dataclass(kw_only=True)
class _SystemOneProviderConfig(_SystemOneRequestConfig):
    """Resolved configuration for an HTTP-backed System One provider."""

    endpoint: str
    api_key: str = field(repr=False)
    http_client: httpx.AsyncClient | None = None


def _resolve_system_one_provider_config(
    *,
    class_name: str,
    provider_name: str,
    endpoint: str,
    api_key_environment_variable: str,
    max_questions: int | None = None,
    api_key: str | None,
    model_id: str,
    min_confidence: float,
    http_client: httpx.AsyncClient | None,
) -> _SystemOneProviderConfig:
    resolved_api_key = (api_key or "").strip() or os.environ.get(api_key_environment_variable, "").strip()
    if not resolved_api_key:
        raise ValueError(f"{class_name} requires an API key: pass api_key or set {api_key_environment_variable}")

    resolved_model_id = model_id.strip()
    if not resolved_model_id:
        raise ValueError(f"{class_name} model_id must be a non-empty string")

    if http_client is not None and not isinstance(http_client, httpx.AsyncClient):
        raise TypeError(f"{class_name} http_client must be an httpx.AsyncClient")

    return _SystemOneProviderConfig(
        provider_name=provider_name,
        endpoint=endpoint,
        api_key=resolved_api_key,
        model_id=resolved_model_id,
        default_min_confidence=_resolve_default_min_confidence(min_confidence, class_name),
        http_client=http_client,
        max_questions=max_questions,
    )


def _resolve_default_min_confidence(value: float, class_name: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
        or not 0 <= value <= 1
    ):
        raise ValueError(f"{class_name} default_min_confidence must be in [0.0, 1.0]")
    return value


@dataclass
class _ParsedAnswer:
    answer: bool | str
    probabilities: dict[str, float]
    confidence: float


@dataclass
class _ParsedResult:
    model_id: str
    answers: dict[str, bool | str | Uncertain]
    probabilities: dict[str, dict[str, float]]
    confidence: dict[str, float]
    usage: Usage | None


async def _ask_system_one(
    config: _SystemOneRequestConfig,
    transport: _SystemOneTransport,
    state: DecisionInput,
    questions: dict[str, Question],
) -> DecisionResult:
    if config.max_questions is not None and len(questions) > config.max_questions:
        raise ValueError(f"{config.provider_name} accepts at most {config.max_questions} questions per request")

    request: dict[str, Any] = {"state": _to_wire_state(state)}
    if config.model_id is not None:
        request["model"] = config.model_id
    request["questions"] = _to_wire_questions(questions)
    body = json.dumps(
        request,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
        default=_reject_non_serializable,
    )

    started_at = time.perf_counter()
    payload = await transport(body)

    parsed = _parse_result(payload, questions, config.default_min_confidence)
    latency_ms = round((time.perf_counter() - started_at) * 1000)
    return DecisionResult(
        answers=parsed.answers,
        usage=parsed.usage,
        metadata=DecisionMetadata(
            latency_ms=latency_ms,
            provider_name=config.provider_name,
            model_id=parsed.model_id,
            probabilities=parsed.probabilities,
            confidence=parsed.confidence,
        ),
    )


def _http_transport(config: _SystemOneProviderConfig) -> _SystemOneTransport:
    """Build the HTTP transport for hosted System One APIs: POSTs the request with the API key."""

    async def transport(body: str) -> Any:
        response = await _post(config, body)
        payload = _read_payload(response)
        if not response.is_success:
            _raise_http_error(config.provider_name, response, payload)
        return payload

    return transport


async def _post(config: _SystemOneProviderConfig, body: str) -> httpx.Response:
    headers = {"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}
    if config.http_client is not None:
        return await config.http_client.post(config.endpoint, headers=headers, content=body)
    # Created per call: a client held across calls breaks when reused over separate event loops.
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        return await client.post(config.endpoint, headers=headers, content=body)


def _to_wire_state(state: DecisionInput) -> Any:
    if isinstance(state, str) or len(state) == 0:
        return state if isinstance(state, str) else []
    if _is_message_list(state):
        messages: Messages = state  # type: ignore[assignment]
        return [
            {"role": message["role"], "content": [_to_wire_content_block(block) for block in message["content"]]}
            for message in messages
        ]
    blocks: list[ContentBlock] = state  # type: ignore[assignment]
    return [_to_wire_content_block(block) for block in blocks]


def _is_message_list(state: list[ContentBlock] | Messages) -> bool:
    first = state[0]
    return isinstance(first, dict) and "role" in first


def _to_wire_content_block(block: ContentBlock) -> ContentBlock:
    for key in _BINARY_MEDIA_KEYS:
        media = block.get(key)
        if isinstance(media, dict) and isinstance(media.get("source"), dict) and "bytes" in media["source"]:
            raise ValueError("System One decision providers do not support binary ContentBlock state")
    return block


def _reject_non_serializable(value: Any) -> Any:
    # json.dumps only reaches here for values it cannot encode natively; byte-backed media nested
    # below the top-level block (e.g. an image inside a toolResult) lands here.
    if isinstance(value, (bytes, bytearray)):
        raise ValueError("System One decision providers do not support binary ContentBlock state")
    raise ValueError(f"Object of type {type(value).__name__} is not JSON serializable")


def _to_wire_questions(questions: dict[str, Question]) -> dict[str, dict[str, Any]]:
    wire: dict[str, dict[str, Any]] = {}
    for question_id, question in questions.items():
        choices = question["choices"]
        if choices == "boolean":
            wire[question_id] = {"type": "noul", "instructions": question["question"]}
            continue
        if len(choices) > _MAX_CHOICE_COUNT:
            raise ValueError(f"question id=<{question_id}> | System One APIs allow at most {_MAX_CHOICE_COUNT} choices")
        wire[question_id] = {
            "type": "choice",
            "instructions": question["question"],
            "criteria": {choice: None for choice in choices},
        }
    return wire


def _read_payload(response: httpx.Response) -> Any:
    text = response.text
    if not text:
        return None
    try:
        return json.loads(text, parse_constant=_reject_json_constant)
    except ValueError as error:
        if response.is_success:
            raise StructuredOutputException("decision provider returned a non-JSON response") from error
        return text


def _reject_json_constant(value: str) -> NoReturn:
    raise ValueError(f"invalid JSON constant: {value}")


def _raise_http_error(provider_name: str, response: httpx.Response, body: Any) -> NoReturn:
    status = response.status_code
    detail = _error_detail(body)
    message = f"{provider_name} decision request failed with HTTP {status}" + (f": {detail}" if detail else "")
    if status == 413:
        raise ContextWindowOverflowException(message)

    error = httpx.HTTPStatusError(message, request=response.request, response=response)
    if status in (429, 503, 529):
        raise ModelThrottledException(message) from error
    raise error


def _error_detail(body: Any) -> str | None:
    if isinstance(body, str):
        return body
    if not isinstance(body, dict):
        return None
    for key in ("error", "message", "detail"):
        value = body.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            nested = value.get("message")
            if isinstance(nested, str):
                return nested
    return None


def _parse_result(payload: Any, questions: dict[str, Question], default_min_confidence: float) -> _ParsedResult:
    response = _require_record(payload, "decision provider response")
    model_id = _require_non_empty_string(response.get("model"), "decision provider model")
    raw_answers = _require_record(response.get("answers"), "decision provider answers")

    answers: dict[str, bool | str | Uncertain] = {}
    probabilities: dict[str, dict[str, float]] = {}
    confidence: dict[str, float] = {}
    for question_id, question in questions.items():
        if question_id not in raw_answers:
            raise StructuredOutputException(f"decision provider omitted answer for question id=<{question_id}>")
        parsed = _parse_answer(raw_answers[question_id], question, question_id)
        min_confidence = _resolve_min_confidence(question, default_min_confidence)
        answers[question_id] = (
            Uncertain() if min_confidence is not None and parsed.confidence < min_confidence else parsed.answer
        )
        probabilities[question_id] = parsed.probabilities
        confidence[question_id] = parsed.confidence

    return _ParsedResult(
        model_id=model_id,
        answers=answers,
        probabilities=probabilities,
        confidence=confidence,
        usage=_parse_usage(response.get("usage")),
    )


def _parse_answer(raw_answer: Any, question: Question, question_id: str) -> _ParsedAnswer:
    answer = _require_record(raw_answer, f"answer for question id=<{question_id}>")
    if question["choices"] == "boolean":
        return _parse_noul_answer(answer, question_id)
    return _parse_choice_answer(answer, question["choices"], question_id)


def _parse_noul_answer(answer: dict[str, Any], question_id: str) -> _ParsedAnswer:
    if answer.get("type") != "noul":
        raise StructuredOutputException(f"answer for boolean question id=<{question_id}> must have type 'noul'")
    probability = _require_probability(answer.get("noul"), f"noul for question id=<{question_id}>")
    return _ParsedAnswer(
        answer=probability >= 0.5,
        probabilities={"true": probability, "false": 1 - probability},
        confidence=abs(2 * probability - 1),
    )


def _parse_choice_answer(answer: dict[str, Any], choices: list[str], question_id: str) -> _ParsedAnswer:
    if answer.get("type") != "choice":
        raise StructuredOutputException(f"answer for choice question id=<{question_id}> must have type 'choice'")
    selected = answer.get("choice")
    if not isinstance(selected, str) or selected not in choices:
        raise StructuredOutputException(f"answer for choice question id=<{question_id}> selected an unknown choice")

    raw_probabilities = _require_record(answer.get("probabilities"), f"probabilities for question id=<{question_id}>")
    if len(raw_probabilities) != len(choices) or any(choice not in raw_probabilities for choice in choices):
        raise StructuredOutputException(
            f"probabilities for question id=<{question_id}> must contain exactly the requested choices"
        )

    probabilities = {
        choice: _require_probability(raw_probabilities[choice], f"probability '{choice}' for id=<{question_id}>")
        for choice in choices
    }
    # A server that rounds each probability to 4 decimals can make a distribution sum to 1 only
    # within len(choices) * 5e-5, so widen the tolerance when every value sits on the 4-decimal grid.
    values = probabilities.values()
    rounded = all(abs(probability * 1e4 - round(probability * 1e4)) < 1e-6 for probability in values)
    tolerance = _PROBABILITY_TOLERANCE
    if rounded:
        tolerance += len(choices) * _PROBABILITY_ROUNDING_TOLERANCE
    if abs(sum(values) - 1) > tolerance:
        raise StructuredOutputException(f"probabilities for question id=<{question_id}> must sum to 1")
    if probabilities[selected] + _PROBABILITY_TOLERANCE < max(probabilities.values()):
        raise StructuredOutputException(f"choice for question id=<{question_id}> must have the highest probability")

    provider_confidence = _require_probability(answer.get("confidence"), f"confidence for question id=<{question_id}>")
    return _ParsedAnswer(answer=selected, probabilities=probabilities, confidence=provider_confidence)


def _resolve_min_confidence(question: Question, provider_default: float) -> float | None:
    uncertainty = question.get("uncertainty")
    if uncertainty is False:
        return None
    if isinstance(uncertainty, dict) and uncertainty.get("min_confidence") is not None:
        return uncertainty["min_confidence"]
    return provider_default


def _parse_usage(value: Any) -> Usage | None:
    if value is None:
        return None
    usage = _require_record(value, "decision provider usage")
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if not _is_token_count(input_tokens) or not _is_token_count(output_tokens):
        return None
    total = int(input_tokens) + int(output_tokens)
    return Usage(inputTokens=int(input_tokens), outputTokens=int(output_tokens), totalTokens=total)


def _is_token_count(value: Any) -> TypeGuard[float]:
    # Int/float comparison is exact, so this rejects inf, nan, and ints too large for a float
    # without the OverflowError math.isfinite raises on them.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= sys.float_info.max


def _require_record(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StructuredOutputException(f"{name} must be an object")
    return value


def _require_non_empty_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StructuredOutputException(f"{name} must be a non-empty string")
    return value


def _require_probability(value: Any, name: str) -> float:
    probability = _require_non_negative_number(value, name)
    if probability > 1:
        raise StructuredOutputException(f"{name} must be in [0.0, 1.0]")
    return probability


def _require_non_negative_number(value: Any, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        raise StructuredOutputException(f"{name} must be a non-negative finite number")
    # Ints are always finite; math.isfinite would overflow converting a huge one to float.
    if isinstance(value, float) and not math.isfinite(value):
        raise StructuredOutputException(f"{name} must be a non-negative finite number")
    return value
