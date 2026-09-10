"""Shared instrumentation for SDK-internal (auxiliary) model calls.

Auxiliary model calls — summarization, routing classification, memory extraction, the web
fetch analyst, the HITL risk classifier, the goal judge, the steering handler — happen
outside the agent's main event loop, so they bypass its hooks, metrics, and traces.
:func:`instrument_auxiliary_model_call` wraps an auxiliary call's event stream to fire the
``Before/AfterAuxiliaryModelCallEvent`` hook pair, roll token usage into the owning agent's
:class:`~strands.telemetry.metrics.EventLoopMetrics` (tagged by source), and emit a
model-invoke span (tagged with ``strands.source``) parented under the active trace.
:func:`auxiliary_structured_output` is the convenience form for the common
"one structured answer from the model" shape.

Auxiliary features call the model directly — never a throwaway inner ``Agent`` — so every
source presents one contract to hook subscribers and metrics consumers.
"""

import logging
from collections.abc import AsyncGenerator, AsyncIterable, Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from opentelemetry import trace as trace_api
from opentelemetry.trace import Span
from pydantic import BaseModel

from ..hooks import AfterAuxiliaryModelCallEvent, BeforeAuxiliaryModelCallEvent
from ..telemetry.tracer import get_tracer
from ..types.content import Messages
from ..types.event_loop import AuxiliaryModelCallSource

if TYPE_CHECKING:
    from ..agent import Agent
    from ..models.model import Model
    from ..telemetry.tracer import Tracer

logger = logging.getLogger(__name__)

TEvent = TypeVar("TEvent")
TOutput = TypeVar("TOutput", bound=BaseModel)


async def instrument_auxiliary_model_call(
    events: AsyncIterable[TEvent],
    *,
    source: AuxiliaryModelCallSource,
    agent: "Agent | None",
    messages: Messages,
    invocation_state: dict[str, Any] | None = None,
    model_id: str | None = None,
    system_prompt: str | None = None,
) -> AsyncGenerator[TEvent, None]:
    """Wrap an auxiliary model call's event stream with hooks, metrics, and a span.

    Fires ``BeforeAuxiliaryModelCallEvent`` before consuming the stream and
    ``AfterAuxiliaryModelCallEvent`` when it completes (successfully or not), adds the
    usage from the stream's terminal ``{"stop": (stop_reason, message, usage, metrics)}``
    event to ``agent.event_loop_metrics`` under ``source``, and emits a model-invoke span
    tagged with ``strands.source``. Events are yielded through unchanged. When ``agent`` is
    None (no owning agent is reachable from the call site), hooks and metrics are skipped
    but the span is still emitted so the call remains traceable.

    Args:
        events: The auxiliary call's event stream (e.g. from ``process_stream``,
            ``stream_messages``, or ``Model.structured_output``). Pass the stream
            *unstarted*: the hook-before-model-call guarantee holds because async
            generator bodies run only on first iteration, which happens here after
            the Before event — not because this helper defers anything itself.
            Streams without a
            ``"stop"`` event are passed through; hooks still fire, but no usage is
            recorded and ``stop_response`` is None. Note: only providers whose
            ``structured_output`` forwards stream events (e.g. Bedrock, Anthropic) emit
            the ``"stop"`` event on structured-output calls; for others the classifier's
            usage is not recorded today.
        source: The auxiliary feature making the call, e.g. ``"summarization"``.
        agent: The agent this call is made on behalf of, or None.
        messages: The messages sent to the model, exposed on the Before event and the span.
        invocation_state: Invocation state to expose on the hook events, when the call
            site has access to it.
        model_id: The model identifier, recorded on the span's ``gen_ai.request.model``.
        system_prompt: The system prompt sent to the model, exposed on the Before event
            and recorded on the span.

    Yields:
        The events from the wrapped stream, unchanged.
    """
    resolved_invocation_state = invocation_state if invocation_state is not None else {}

    if agent is not None:
        await agent.hooks.invoke_callbacks_async(
            BeforeAuxiliaryModelCallEvent(
                agent=agent,
                source=source,
                messages=messages,
                system_prompt=system_prompt,
                invocation_state=resolved_invocation_state,
            )
        )

    tracer = get_tracer()
    span = tracer.start_model_invoke_span(messages=messages, model_id=model_id, system_prompt=system_prompt)
    if span.is_recording():
        span.set_attribute("strands.source", source)

    stop: Any = None
    # BaseException, not Exception: the After event must also fire when the stream is
    # cancelled or the generator is closed (e.g. the routing classifier's asyncio.wait_for
    # timeout), or paired setup/teardown hooks would leak on every timeout.
    try:
        with trace_api.use_span(span, end_on_exit=False):
            async for event in events:
                if isinstance(event, Mapping) and event.get("stop") is not None:
                    stop = event["stop"]
                yield event
    except BaseException as error:
        if isinstance(error, Exception):
            tracer.end_span_with_error(span, str(error), error)
        else:
            # Cancellation (e.g. the routing classifier's wait_for timeout) is not a failure.
            tracer.end_span_with_cancellation(span, error)
        if agent is not None:
            await agent.hooks.invoke_callbacks_async(
                AfterAuxiliaryModelCallEvent(
                    agent=agent,
                    source=source,
                    invocation_state=resolved_invocation_state,
                    exception=error,
                )
            )
        raise

    stop_response = _end_span_and_record_usage(tracer, span, stop, source, agent)

    if agent is not None:
        await agent.hooks.invoke_callbacks_async(
            AfterAuxiliaryModelCallEvent(
                agent=agent,
                source=source,
                invocation_state=resolved_invocation_state,
                stop_response=stop_response,
            )
        )


def _end_span_and_record_usage(
    tracer: "Tracer",
    span: Span,
    stop: Any,
    source: AuxiliaryModelCallSource,
    agent: "Agent | None",
) -> "AfterAuxiliaryModelCallEvent.ModelStopResponse | None":
    """End the model-invoke span, roll usage into metrics, and build the stop response.

    Returns None (and ends the span without usage) when the stream produced no usable
    terminal ``stop`` event.
    """
    # Shape-check: in-tree streams always yield (stop_reason, message, usage, metrics),
    # but a third-party ``structured_output`` may emit anything under "stop".
    if not (isinstance(stop, tuple) and len(stop) == 4 and _is_usable_usage(stop[2])):
        span.end()
        logger.debug("source=<%s> | auxiliary model call reported no usable stop event, skipping usage", source)
        return None

    stop_reason, message, usage, metrics = stop
    tracer.end_model_invoke_span(span, message, usage, metrics, stop_reason)
    if agent is None:
        return None

    agent.event_loop_metrics.update_usage(usage, source=source)
    return AfterAuxiliaryModelCallEvent.ModelStopResponse(
        message=message,
        stop_reason=stop_reason,
        usage=usage,
    )


def _is_usable_usage(usage: Any) -> bool:
    """Return True if the stop event's usage payload has the required ``Usage`` keys."""
    required_keys = {"inputTokens", "outputTokens", "totalTokens"}
    return isinstance(usage, dict) and required_keys <= usage.keys()


class NoStructuredOutputError(ValueError):
    """The model finished an auxiliary structured-output call without producing the requested type."""


async def auxiliary_structured_output(
    model: "Model",
    output_model: type[TOutput],
    prompt: str,
    *,
    source: AuxiliaryModelCallSource,
    agent: "Agent | None",
    system_prompt: str | None = None,
    invocation_state: dict[str, Any] | None = None,
) -> TOutput:
    """Ask the model for one structured answer, instrumented as an auxiliary call.

    Sends ``prompt`` as a single user message through ``model.structured_output`` wrapped
    by :func:`instrument_auxiliary_model_call`, and returns the parsed ``output_model``.

    Raises:
        NoStructuredOutputError: If the model produced no ``output_model`` instance.
    """
    messages: Messages = [{"role": "user", "content": [{"text": prompt}]}]
    events = instrument_auxiliary_model_call(
        model.structured_output(output_model, messages, system_prompt=system_prompt),
        source=source,
        agent=agent,
        messages=messages,
        invocation_state=invocation_state,
        model_id=model.config.get("model_id") if hasattr(model, "config") else None,
        system_prompt=system_prompt,
    )

    output: object | None = None
    async for event in events:
        if isinstance(event, Mapping) and "output" in event:
            output = event["output"]
    if not isinstance(output, output_model):
        raise NoStructuredOutputError(f"source=<{source}> | auxiliary model call produced no {output_model.__name__}")
    return output
