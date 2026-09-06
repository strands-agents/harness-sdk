"""Model-backed :class:`Extractor` that distills messages into discrete facts.

A :class:`ModelExtractor` calls a language model with a fact-extraction system
prompt and parses the response into :class:`ExtractionResult` entries. Backends
that extract server-side should omit the extractor entirely.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from opentelemetry import trace as trace_api

from ...models.model import Model, _get_model_id
from ...telemetry.tracer import get_tracer
from ...types.content import Message
from .types import ExtractionResult, ExtractorContext

logger = logging.getLogger(__name__)

# Default instruction guiding the model to emit discrete, durable facts as a JSON array.
DEFAULT_SYSTEM_PROMPT = (
    "You extract durable facts worth remembering across future conversations from a transcript.\n"
    "\n"
    'Return ONLY a JSON array of objects, each: {"content": string}. Each object is one discrete, '
    "self-contained fact (a preference, decision, or stable detail about the user or task). Do not "
    "include transient chit-chat, questions, or anything already obvious. If there is nothing worth "
    "remembering, return []."
)


class ModelExtractor:
    """An :class:`Extractor` that calls a language model to distill messages into discrete facts.

    Use for self-managed stores that hold plain text and want automatic
    distillation.

    Example:
        ```python
        ExtractionConfig(
            trigger=[InvocationTrigger()],
            extractor=ModelExtractor(model=cheap_model, system_prompt="Extract user preferences."),
        )
        ```
    """

    def __init__(self, model: Model | None = None, system_prompt: str | None = None) -> None:
        """Initialize the extractor.

        Args:
            model: Model used to extract facts. Defaults to the agent's own model
                (via :attr:`ExtractorContext.default_model`); set a cheaper one to
                cut cost.
            system_prompt: System prompt steering what counts as a fact. Defaults
                to a general fact-extraction prompt.
        """
        self._model = model
        self._system_prompt = system_prompt or DEFAULT_SYSTEM_PROMPT

    async def extract(self, messages: list[Message], context: ExtractorContext | None = None) -> list[ExtractionResult]:
        """Extract entries from a batch of messages.

        Raises:
            ValueError: If no model is configured and no default is available.
            RuntimeError: If the model returns no response.
        """
        model = self._model or (context.default_model if context else None)
        if model is None:
            raise ValueError("ModelExtractor: no model configured and no default model available")
        if not messages:
            return []

        # Present the transcript as a single user turn so the system prompt governs extraction.
        transcript = "\n".join(_render_message(message) for message in messages)
        prompt: Message = {
            "role": "user",
            "content": [{"text": f"Extract facts from the following transcript:\n\n{transcript}"}],
        }

        # Lazy import to avoid a circular import with ``event_loop.streaming``.
        from ...event_loop.streaming import stream_messages

        tracer = get_tracer()
        model_id = _get_model_id(model)
        span = tracer.start_model_invoke_span(messages=[prompt], model_id=model_id, system_prompt=self._system_prompt)

        final_message: Message | None = None
        stop: Any = None
        try:
            with trace_api.use_span(span, end_on_exit=False):
                async for event in stream_messages(model, self._system_prompt, [prompt], tool_specs=[]):
                    # The terminal ``ModelStopReason`` event carries
                    # ``{"stop": (stop_reason, message, usage, metrics)}``.
                    candidate = event.get("stop")
                    if candidate is not None:
                        stop = candidate
                        final_message = stop[1]
        except Exception as error:
            tracer.end_span_with_error(span, str(error), error)
            raise

        if final_message is None:
            no_response_error = RuntimeError("ModelExtractor: model returned no response")
            tracer.end_span_with_error(span, str(no_response_error), no_response_error)
            raise no_response_error

        stop_reason, message, usage, metrics = stop
        tracer.end_model_invoke_span(span, message, usage, metrics, stop_reason)

        text = "".join(block.get("text", "") for block in final_message["content"]).strip()

        return _parse_entries(text, type(model).__name__)


def _render_message(message: Message) -> str:
    """Render one message as ``role: text``, joining its non-empty text blocks."""
    text = "\n".join(part for block in message["content"] if (part := block.get("text", "")) and len(part) > 0)
    return f"{message['role']}: {text}"


def _extract_json_array(text: str) -> str | None:
    """Extract the substring from the first ``[`` to the last ``]``, or None if absent."""
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end < start:
        return None
    return text[start : end + 1]


def _parse_entries(text: str, model_name: str) -> list[ExtractionResult]:
    """Parse the model's response into entries.

    Tolerates the array being wrapped in prose or a code fence. Malformed output
    yields no entries (logged) rather than throwing.
    """
    json_text = _extract_json_array(text)
    if json_text is None:
        logger.warning("model=<%s> | ModelExtractor: no JSON array in model output, skipping", model_name)
        return []

    try:
        parsed: Any = json.loads(json_text)
    except ValueError as err:
        logger.warning("model=<%s>, error=<%s> | ModelExtractor: failed to parse output", model_name, str(err))
        return []

    if not isinstance(parsed, list):
        return []

    entries: list[ExtractionResult] = []
    for item in parsed:
        if isinstance(item, dict) and isinstance(item.get("content"), str):
            content = item["content"].strip()
            if len(content) > 0:
                metadata = item.get("metadata")
                entries.append(ExtractionResult(content=content, metadata=metadata if metadata is not None else None))
    return entries
