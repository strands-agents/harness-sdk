"""Shared transport for System One decision providers (Jev, decisionapi.net).

Builds the ``POST /v1/systemone`` request from a question map, validates the response, and
normalizes answers back into the SDK's ``DecisionResult`` shape. Internal: concrete providers own
their endpoints, credentials, defaults, and limits and delegate the wire work here.
"""

import json
import math
import os
import time
from dataclasses import dataclass
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
_BINARY_MEDIA_KEYS = ("audio", "image", "video", "document")


@dataclass
class _SystemOneProviderConfig:
    """Resolved per-provider transport configuration."""

    provider_name: str
    endpoint: str
    api_key: str
    model_id: str
    default_min_confidence: float
    max_body_bytes: int
    http_client: httpx.AsyncClient | None = None
    max_questions: int | None = None


class _SystemOneHttpError(Exception):
    """Internal HTTP failure retained as the cause of translated provider errors."""

    def __init__(self, status: int, body: Any, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _resolve_system_one_provider_config(
    *,
    class_name: str,
    provider_name: str,
    endpoint: str,
    api_key_environment_variable: str,
    default_model_id: str,
    default_min_confidence: float,
    max_body_bytes: int,
    max_questions: int | None = None,
    api_key: str | None,
    model_id: str | None,
    min_confidence: float | None,
    http_client: httpx.AsyncClient | None,
) -> _SystemOneProviderConfig:
    resolved_api_key = (api_key or "").strip() or os.environ.get(api_key_environment_variable, "").strip()
    if not resolved_api_key:
        raise ValueError(f"{class_name} requires an API key: pass api_key or set {api_key_environment_variable}")

    resolved_model_id = (model_id or "").strip() or default_model_id

    if http_client is not None and not isinstance(http_client, httpx.AsyncClient):
        raise TypeError(f"{class_name} http_client must be an httpx.AsyncClient")

    resolved_min_confidence = default_min_confidence if min_confidence is None else min_confidence
    if (
        not isinstance(resolved_min_confidence, (int, float))
        or isinstance(resolved_min_confidence, bool)
        or not math.isfinite(resolved_min_confidence)
        or not 0 <= resolved_min_confidence <= 1
    ):
        raise ValueError(f"{class_name} default_min_confidence must be in [0.0, 1.0]")

    return _SystemOneProviderConfig(
        provider_name=provider_name,
        endpoint=endpoint,
        api_key=resolved_api_key,
        model_id=resolved_model_id,
        default_min_confidence=resolved_min_confidence,
        max_body_bytes=max_body_bytes,
        http_client=http_client,
        max_questions=max_questions,
    )


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
    config: _SystemOneProviderConfig,
    state: DecisionInput,
    questions: dict[str, Question],
) -> DecisionResult:
    if config.max_questions is not None and len(questions) > config.max_questions:
        raise ValueError(f"{config.provider_name} accepts at most {config.max_questions} questions per request")

    body = json.dumps(
        {
            "state": _to_wire_state(state),
            "model": config.model_id,
            "questions": _to_wire_questions(questions),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
        default=_reject_non_serializable,
    )
    body_bytes = len(body.encode("utf-8"))
    if body_bytes > config.max_body_bytes:
        raise ContextWindowOverflowException(
            f"{config.provider_name} decision request is {body_bytes} bytes; "
            f"the provider limit is {config.max_body_bytes}"
        )

    started_at = time.perf_counter()
    try:
        response = await _post(config, body)
    except Exception as error:
        # Mirror the TypeScript adapter, which wraps any throw from fetch (network error, closed
        # client, etc.) rather than only typed transport failures.
        raise StructuredOutputException(f"{config.provider_name} decision request failed: {error}") from error

    payload = _read_payload(response)
    if not response.is_success:
        _raise_http_error(config.provider_name, response.status_code, payload)

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


async def _post(config: _SystemOneProviderConfig, body: str) -> httpx.Response:
    headers = {"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}
    if config.http_client is not None:
        return await config.http_client.post(config.endpoint, headers=headers, content=body)
    # No timeout, mirroring the TypeScript adapter's reliance on the default fetch (no deadline).
    async with httpx.AsyncClient(timeout=None) as client:
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
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


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


def _raise_http_error(provider_name: str, status: int, body: Any) -> NoReturn:
    detail = _error_detail(body)
    message = f"{provider_name} decision request failed with HTTP {status}" + (f": {detail}" if detail else "")
    if status == 413:
        raise ContextWindowOverflowException(message)

    cause = _SystemOneHttpError(status, body, message)
    if status in (429, 529):
        raise ModelThrottledException(message) from cause
    raise StructuredOutputException(message) from cause


def _error_detail(body: Any) -> str | None:
    if isinstance(body, str):
        return body
    if not isinstance(body, dict):
        return None
    for field in ("error", "message", "detail"):
        value = body.get(field)
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
    if abs(sum(probabilities.values()) - 1) > _PROBABILITY_TOLERANCE:
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
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


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
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
        raise StructuredOutputException(f"{name} must be a non-negative finite number")
    return value
