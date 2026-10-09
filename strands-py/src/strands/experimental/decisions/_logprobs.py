"""Read per-answer label logits from the token logprobs of an ``LLMDecisionModel`` tool call.

A Bedrock Converse model served on the OpenAI-schema stack (Qwen3, Ministral, Nemotron, GLM and others) returns the
logprobs of every generated token when the request carries ``additionalModelRequestFields={"logprobs": True,
"top_logprobs": k}`` and ``additionalModelResponseFieldPaths=["/choices/0/logprobs"]``, and the call is not streamed.
They arrive on the ``messageStop`` event as ``additionalModelResponseFields.choices[0].logprobs.content``.

Each answer field ``q_<id>`` is decided by one token: the first value token after ``"q_<id>":``. Its top-k
alternatives are mapped to labels by first token (an alternative counts for every label it begins), surface variants
(``"A"``, ``" A"``) are combined with logsumexp, and the result is kept as that answer's logits. Nothing here raises:
anything the parser cannot attribute unambiguously is reported as a reason, and the caller answers one-hot.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ._types import Choice, Question, Score

_FORBIDDEN = -9999.0  # vLLM reports grammar-forbidden tokens at exactly this logprob
_STRUCTURAL = ' \t\r\n":'
_ALNUM = re.compile(r"[A-Za-z0-9]*")


@dataclass(frozen=True)
class LabelLogits:
    """One answer's label logits (log-probabilities over the top-k) and the label mass they cover."""

    logits: dict[Any, float]
    label_mass: float


def logprob_tokens(event: Mapping[str, Any]) -> list[Mapping[str, Any]] | None:
    """Return the generated tokens' logprobs carried on a Converse ``messageStop`` stream event, if any."""
    chunk = event.get("event")
    stop = chunk.get("messageStop") if isinstance(chunk, Mapping) else None
    fields = stop.get("additionalModelResponseFields") if isinstance(stop, Mapping) else None
    choices = fields.get("choices") if isinstance(fields, Mapping) else None
    first = choices[0] if isinstance(choices, Sequence) and choices else None
    logprobs = first.get("logprobs") if isinstance(first, Mapping) else None
    content = logprobs.get("content") if isinstance(logprobs, Mapping) else None
    if not isinstance(content, list) or not content:
        return None
    if not all(isinstance(token, Mapping) and isinstance(token.get("token"), str) for token in content):
        return None
    return content


def label_logits(tokens: Sequence[Mapping[str, Any]], field: str, question: Question, value: Any) -> LabelLogits | str:
    """Logits for ``question`` from the value token of ``field``, or a short reason they cannot be read.

    Args:
        tokens: The generated tokens' logprobs, in order.
        field: The answer field name, ``q_<id>``.
        question: The question the field answers.
        value: The parsed value of the field, used to check the token was located correctly.

    Returns:
        The label logits, or one of ``field_not_found``, ``value_mismatch``, ``shared_first_token`` or
        ``label_outside_top_k``.
    """
    labels = _labels(question)
    numeric = not isinstance(question, Choice)
    position = _value_position(tokens, field, numeric)
    if position is None:
        return "field_not_found"
    index, chosen = position
    owners = _owners(chosen, labels)
    if len(owners) > 1:
        return "shared_first_token"
    if owners != [value_key(question, value)]:
        return "value_mismatch"
    return _aggregate(_alternatives(tokens[index]), labels, numeric)


def _labels(question: Question) -> dict[str, Any]:
    """Label text as generated in JSON, mapped to the answer key it stands for."""
    if isinstance(question, Choice):
        return {option: option for option in question.options}
    if isinstance(question, Score):
        return {str(level): level for level in range(len(question.levels))}
    return {"true": True, "false": False}


def value_key(question: Question, value: Any) -> Any:
    """The answer key (option, level index, or bool) a parsed field value stands for."""
    if isinstance(question, Choice):
        return value
    if isinstance(question, Score):
        return int(value)
    return bool(value)


def _normalize(text: str, numeric: bool) -> str:
    """The label prefix a token spells: structural JSON stripped, cut at the closing quote (or non-alphanumeric)."""
    stripped = text.lstrip(_STRUCTURAL).split('"', 1)[0]
    if numeric:
        match = _ALNUM.match(stripped)
        return match.group(0).lower() if match else ""
    return stripped


def _value_position(tokens: Sequence[Mapping[str, Any]], field: str, numeric: bool) -> tuple[int, str] | None:
    """Index and normalized text of the first value token after the last ``"<field>":`` in the generated text."""
    text = "".join(str(token["token"]) for token in tokens)
    matches = list(re.finditer(rf'"{re.escape(field)}"\s*:', text))
    if not matches:
        return None
    start = matches[-1].end()
    offset = 0
    for index, token in enumerate(tokens):
        piece = str(token["token"])
        offset += len(piece)
        if offset <= start:
            continue
        tail = piece[max(0, len(piece) - (offset - start)) :]
        normalized = _normalize(tail, numeric)
        if normalized:
            return index, normalized
    return None


def _alternatives(token: Mapping[str, Any]) -> list[tuple[str, float]]:
    """``(text, logprob)`` for every usable top-k alternative of a token."""
    top = token.get("top_logprobs")
    candidates = top if isinstance(top, list) and top else [token]
    return [
        (candidate["token"], float(candidate["logprob"]))
        for candidate in candidates
        if isinstance(candidate, Mapping)
        and isinstance(candidate.get("token"), str)
        and _usable(candidate.get("logprob"))
    ]


def _usable(logprob: Any) -> bool:
    if isinstance(logprob, bool) or not isinstance(logprob, (int, float)):
        return False
    return math.isfinite(logprob) and logprob > _FORBIDDEN


def _owners(prefix: str, labels: Mapping[str, Any]) -> list[Any]:
    return [key for label, key in labels.items() if prefix and label.startswith(prefix)]


def _aggregate(
    alternatives: Sequence[tuple[str, float]], labels: Mapping[str, Any], numeric: bool
) -> LabelLogits | str:
    """Logsumexp each label's alternatives; refuse an alternative that begins two labels, or a label with none."""
    grouped: dict[Any, list[float]] = {}
    for text, logprob in alternatives:
        owners = _owners(_normalize(text, numeric), labels)
        if len(owners) > 1:
            return "shared_first_token"
        if owners:
            grouped.setdefault(owners[0], []).append(logprob)
    if len(grouped) < len(labels):
        return "label_outside_top_k"
    logits = {key: _logsumexp(grouped[key]) for key in labels.values()}
    return LabelLogits(logits=logits, label_mass=sum(math.exp(value) for value in logits.values()))


def _logsumexp(values: Sequence[float]) -> float:
    top = max(values)
    return top + math.log(sum(math.exp(value - top) for value in values))
