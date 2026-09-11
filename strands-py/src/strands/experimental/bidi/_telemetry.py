"""Telemetry helpers for bidirectional streaming agent.

Wraps the shared Tracer primitives with bidi-specific span creation and attribute names.
Uses Tracer._start_span/_end_span directly rather than adding bidi-specific public methods
to the shared Tracer class, keeping experimental bidi telemetry self-contained.
"""

from opentelemetry.trace import Span

from ...telemetry.tracer import Tracer, serialize
from ...types.traces import AttributeValue


def start_session_span(
    tracer: Tracer,
    agent_name: str,
    model_id: str | None = None,
    tools: list[str] | None = None,
    system_prompt: str | None = None,
) -> Span:
    """Start a span for the bidi session lifecycle.

    Args:
        tracer: Tracer instance.
        agent_name: Name of the bidi agent.
        model_id: Model identifier.
        tools: List of tool names available to the agent.
        system_prompt: System prompt configured on the agent.

    Returns:
        The session span.
    """
    attributes: dict[str, AttributeValue] = tracer._get_common_attributes(operation_name="bidi_session")
    attributes["gen_ai.agent.name"] = agent_name

    if model_id:
        attributes["gen_ai.request.model"] = model_id

    if tools:
        attributes["gen_ai.agent.tools"] = serialize(tools)

    if system_prompt:
        attributes["gen_ai.system_instructions"] = tracer._redact("gen_ai.system_instructions", system_prompt)

    return tracer._start_span(f"bidi_session {agent_name}", attributes=attributes)


def end_session_span(
    tracer: Tracer,
    span: Span,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    error: Exception | None = None,
) -> None:
    """End the bidi session span.

    Args:
        tracer: Tracer instance.
        span: The session span to end.
        input_tokens: Accumulated input tokens for the session.
        output_tokens: Accumulated output tokens for the session.
        total_tokens: Accumulated total tokens for the session.
        cache_read_input_tokens: Accumulated tokens read from cache for the session.
        error: Exception if the session ended with an error.
    """
    token_attributes = {
        "gen_ai.usage.input_tokens": input_tokens,
        "gen_ai.usage.output_tokens": output_tokens,
        "gen_ai.usage.total_tokens": total_tokens,
        "gen_ai.usage.cache_read.input_tokens": cache_read_input_tokens,
    }
    if not tracer.use_latest_genai_conventions:
        # Deprecated pre-semconv name, dual-emitted unless opted into the latest conventions
        token_attributes["gen_ai.usage.cache_read_input_tokens"] = cache_read_input_tokens
    attributes: dict[str, AttributeValue] = {name: value for name, value in token_attributes.items() if value > 0}

    tracer._end_span(span, attributes=attributes, error=error)


def start_response_span(tracer: Tracer, response_id: str, parent_span: Span | None = None) -> Span:
    """Start a span for a model response.

    Args:
        tracer: Tracer instance.
        response_id: Unique identifier for the response.
        parent_span: Parent session span.

    Returns:
        The response span.
    """
    attributes: dict[str, AttributeValue] = tracer._get_common_attributes(operation_name="bidi_response")
    attributes["gen_ai.response.id"] = response_id

    # Static span name (response_id is recorded as an attribute) to avoid high-cardinality names.
    return tracer._start_span("bidi_response", parent_span, attributes=attributes)


def end_response_span(
    tracer: Tracer,
    span: Span,
    stop_reason: str | None = None,
    time_to_first_audio_ms: int | None = None,
    error: Exception | None = None,
) -> None:
    """End a model response span.

    Args:
        tracer: Tracer instance.
        span: The response span to end.
        stop_reason: Why the response ended (complete, interrupted, tool_use, error).
        time_to_first_audio_ms: Milliseconds from response start to the first audio chunk, if any
            audio was emitted for this response.
        error: Exception if the response ended with an error.
    """
    attributes: dict[str, AttributeValue] = {}

    if stop_reason:
        attributes["gen_ai.response.finish_reason"] = stop_reason

    if time_to_first_audio_ms is not None:
        attributes["gen_ai.server.time_to_first_audio"] = time_to_first_audio_ms

    tracer._end_span(span, attributes=attributes, error=error)


def start_restart_span(
    tracer: Tracer,
    parent_span: Span | None = None,
    reason: str = "timeout",
    error_message: str | None = None,
) -> Span:
    """Start a span for a connection restart.

    Args:
        tracer: Tracer instance.
        parent_span: Parent session span.
        reason: What triggered the restart ("timeout" reactively, "scheduled" proactively).
        error_message: The timeout error message that triggered a reactive restart, if any.

    Returns:
        The restart span.
    """
    attributes: dict[str, AttributeValue] = tracer._get_common_attributes(operation_name="bidi_connection_restart")
    attributes["gen_ai.bidi.restart_reason"] = reason

    # The message of the timeout that triggered a reactive restart. Namespaced under
    # gen_ai.bidi.* (not gen_ai.error.*) so it does not read as a failure of this span,
    # which may end successfully; a failed restart is recorded via end_restart_span.
    if error_message:
        attributes["gen_ai.bidi.restart_error_message"] = error_message

    return tracer._start_span("bidi_connection_restart", parent_span, attributes=attributes)


def end_restart_span(tracer: Tracer, span: Span, error: Exception | None = None) -> None:
    """End a connection restart span.

    Args:
        tracer: Tracer instance.
        span: The restart span to end.
        error: Exception if the restart failed.
    """
    tracer._end_span(span, error=error)


def start_connection_span(tracer: Tracer, parent_span: Span | None = None, model_id: str | None = None) -> Span:
    """Start a span for the model connection establishment.

    Args:
        tracer: Tracer instance.
        parent_span: Parent session span.
        model_id: Model identifier being connected to.

    Returns:
        The connection span.
    """
    attributes: dict[str, AttributeValue] = tracer._get_common_attributes(operation_name="bidi_connect")

    if model_id:
        attributes["gen_ai.request.model"] = model_id

    return tracer._start_span("bidi_connect", parent_span, attributes=attributes)


def end_connection_span(tracer: Tracer, span: Span, error: Exception | None = None) -> None:
    """End the model connection span.

    Args:
        tracer: Tracer instance.
        span: The connection span to end.
        error: Exception if the connection failed.
    """
    tracer._end_span(span, error=error)


def add_interruption_event(span: Span, reason: str) -> None:
    """Record an interruption as a span event on the session span.

    Args:
        span: The session span to add the event to.
        reason: Reason for the interruption.
    """
    if span and span.is_recording():
        span.add_event("bidi_interruption", attributes={"interruption.reason": reason})
