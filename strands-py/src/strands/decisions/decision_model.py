"""Base interface for making structured "decisions" from inside the SDK."""

import abc
import json
import math
from typing import Any

import opentelemetry.trace as trace_api
from opentelemetry.trace import SpanKind, StatusCode

from ..agent.invocation_context import InvocationContext, _unwrap_invocation_context
from .types import DecisionInput, DecisionResult, Question, Uncertain


class DecisionModel(abc.ABC):
    """Abstract base for anything that can answer closed questions.

    The public ``ask`` opens a ``decision`` span, validates the question map, delegates to the
    subclass ``_ask``, records usage and the answer set as span attributes/events, and closes the
    span. Every implementation is traced identically. Given an ``invocation_context``, ``ask``
    also adds the reported usage to that request once ``_ask`` returns.
    """

    async def ask(
        self,
        state: DecisionInput,
        questions: dict[str, Question],
        *,
        invocation_context: InvocationContext | None = None,
        **kwargs: Any,
    ) -> DecisionResult:
        """Ask one or more closed questions over the given state.

        Args:
            state: A plain string, a one-shot content list, or a message history.
            questions: Map of identifier to question. The returned ``answers`` dict is keyed off
                this same map.
            invocation_context: Request to add this decision's token usage to. The request's limits
                do not apply to the decision.
            **kwargs: Additional keyword arguments forwarded to the implementation for future
                extensibility.

        Returns:
            A ``DecisionResult`` whose answers are keyed by the question identifiers.

        Raises:
            ValueError: If ``questions`` is empty or a question violates its semantic constraints.
            TypeError: If ``invocation_context`` was not created by the SDK.
            StructuredOutputException: If the model declines to produce a valid answer set, omits
                an answer, or returns a value outside a question's allowed choices.
        """
        _validate_questions(questions)
        invocation_context = _unwrap_invocation_context(invocation_context)

        span = trace_api.get_tracer(__name__).start_span(
            "decision", kind=SpanKind.INTERNAL, attributes={"gen_ai.operation.name": "decision"}
        )
        span.add_event("gen_ai.decision.questions", {"ids": list(questions.keys())})

        try:
            with trace_api.use_span(
                span,
                end_on_exit=False,
                record_exception=False,
                set_status_on_exception=False,
            ):
                result = await self._ask(state, questions, **kwargs)

            attributes: dict[str, Any] = {"gen_ai.decision.latency_ms": result.metadata.latency_ms}
            if result.usage is not None:
                if invocation_context is not None:
                    invocation_context._record_usage(result.usage)
                attributes["gen_ai.usage.input_tokens"] = result.usage["inputTokens"]
                attributes["gen_ai.usage.output_tokens"] = result.usage["outputTokens"]
            span.set_attributes(attributes)

            span.add_event("gen_ai.decision.answers", {"answers": _serialize_answers(result.answers)})
            span.set_status(StatusCode.OK)

            return result
        except Exception as error:
            span.set_status(StatusCode.ERROR, str(error))
            span.record_exception(error)
            raise
        finally:
            span.end()

    @abc.abstractmethod
    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        """Implementation-specific decision logic.

        Additional keyword arguments support implementation-specific options and future interface
        extensions. Must return a complete ``DecisionResult``, including ``metadata.latency_ms``
        sourced from the underlying model provider.
        """
        ...


def _validate_questions(questions: dict[str, Question]) -> None:
    if not questions:
        raise ValueError("ask requires at least one question")

    for question_id, question in questions.items():
        _validate_question_text(question_id, question)
        _validate_choices(question_id, question)
        _validate_uncertainty(question_id, question)


def _validate_question_text(question_id: str, question: Question) -> None:
    if not question["question"].strip():
        raise ValueError(f"question id=<{question_id}> | question must be a non-empty string")


def _validate_choices(question_id: str, question: Question) -> None:
    choices = question["choices"]
    if choices == "boolean":
        return
    if not choices:
        raise ValueError(f"question id=<{question_id}> | choices must be a non-empty list of strings")
    if any(not choice for choice in choices):
        raise ValueError(f"question id=<{question_id}> | choices must be non-empty strings")
    if len(set(choices)) != len(choices):
        raise ValueError(f"question id=<{question_id}> | choices must be unique")
    if "uncertain" in choices:
        raise ValueError(f"question id=<{question_id}> | choice 'uncertain' is reserved for the Uncertain answer")


def _validate_uncertainty(question_id: str, question: Question) -> None:
    uncertainty = question.get("uncertainty")
    if not isinstance(uncertainty, dict) or "min_confidence" not in uncertainty:
        return

    min_confidence = uncertainty["min_confidence"]
    if not math.isfinite(min_confidence) or not 0 <= min_confidence <= 1:
        raise ValueError(f"question id=<{question_id}> | uncertainty.min_confidence must be in [0.0, 1.0]")


def _serialize_answers(answers: dict[str, bool | str | Uncertain]) -> str:
    """Serialize an answer map to JSON for a span event, rendering ``Uncertain`` as a tagged object."""

    def encode(value: bool | str | Uncertain) -> Any:
        if isinstance(value, Uncertain):
            return {"uncertain": True} if value.reason is None else {"uncertain": True, "reason": value.reason}
        return value

    return json.dumps({key: encode(value) for key, value in answers.items()})
