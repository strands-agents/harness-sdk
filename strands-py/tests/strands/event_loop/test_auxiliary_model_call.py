"""Tests for the shared auxiliary model call instrumentation helper."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from strands import Agent
from strands.agent.agent_result import AgentResult
from strands.event_loop._auxiliary_model_call import instrument_auxiliary_agent_call, instrument_auxiliary_model_call
from strands.hooks import AfterAuxiliaryModelCallEvent, BeforeAuxiliaryModelCallEvent
from strands.telemetry.metrics import EventLoopMetrics
from strands.types.content import Message, Messages
from strands.types.event_loop import Metrics, Usage
from tests.fixtures.mock_hook_provider import MockHookProvider
from tests.fixtures.mocked_model_provider import MockedModelProvider

STOP_MESSAGE: Message = {"role": "assistant", "content": [{"text": "response"}]}
STOP_USAGE = Usage(inputTokens=10, outputTokens=5, totalTokens=15)
STOP_METRICS = Metrics(latencyMs=7)

PROMPT_MESSAGES: Messages = [{"role": "user", "content": [{"text": "summarize"}]}]


async def _stream_with_stop():
    yield {"contentBlockDelta": {"delta": {"text": "response"}}}
    yield {"stop": ("end_turn", STOP_MESSAGE, STOP_USAGE, STOP_METRICS)}


async def _stream_without_stop():
    yield {"output": "structured"}


async def _stream_with_malformed_stop():
    yield {"stop": ("end_turn", STOP_MESSAGE)}


async def _stream_with_malformed_usage():
    yield {"stop": ("end_turn", STOP_MESSAGE, None, STOP_METRICS)}


async def _stream_that_raises(error):
    yield {"contentBlockDelta": {"delta": {"text": "partial"}}}
    raise error


@pytest.fixture
def hook_provider():
    return MockHookProvider([BeforeAuxiliaryModelCallEvent, AfterAuxiliaryModelCallEvent])


@pytest.fixture
def agent(hook_provider):
    return Agent(model=MockedModelProvider([]), hooks=[hook_provider])


@pytest.mark.asyncio
async def test_fires_hook_pair_and_records_usage(agent, hook_provider):
    invocation_state = {"key": "value"}

    tru_events = [
        event
        async for event in instrument_auxiliary_model_call(
            _stream_with_stop(),
            source="summarization",
            agent=agent,
            messages=PROMPT_MESSAGES,
            invocation_state=invocation_state,
            system_prompt="summarize this",
        )
    ]

    exp_events = [
        {"contentBlockDelta": {"delta": {"text": "response"}}},
        {"stop": ("end_turn", STOP_MESSAGE, STOP_USAGE, STOP_METRICS)},
    ]
    assert tru_events == exp_events

    before_event, after_event = hook_provider.events_received
    assert isinstance(before_event, BeforeAuxiliaryModelCallEvent)
    assert before_event.source == "summarization"
    assert before_event.messages == PROMPT_MESSAGES
    assert before_event.system_prompt == "summarize this"
    assert before_event.invocation_state == invocation_state

    assert isinstance(after_event, AfterAuxiliaryModelCallEvent)
    assert after_event.source == "summarization"
    assert after_event.exception is None
    assert after_event.stop_response == AfterAuxiliaryModelCallEvent.ModelStopResponse(
        message=STOP_MESSAGE, stop_reason="end_turn", usage=STOP_USAGE
    )

    assert agent.event_loop_metrics.accumulated_usage == STOP_USAGE
    assert agent.event_loop_metrics.accumulated_usage_by_source == {"summarization": STOP_USAGE}


@pytest.mark.asyncio
async def test_before_event_fires_before_stream_body_starts(agent):
    """The wrapped stream (the model call) must not start until after the Before event.

    Every in-tree stream that reaches this helper is an async generator, whose body runs
    only on first iteration (PEP 525) — so the model request goes out inside this
    wrapper's ``async for``, after the Before hook, not when the call site creates the
    generator.
    """
    order: list[str] = []

    async def stream():
        order.append("model_call")
        yield {"stop": ("end_turn", STOP_MESSAGE, STOP_USAGE, STOP_METRICS)}

    agent.hooks.add_callback(BeforeAuxiliaryModelCallEvent, lambda _: order.append("before_hook"))

    events = instrument_auxiliary_model_call(stream(), source="summarization", agent=agent, messages=PROMPT_MESSAGES)
    assert order == []  # creating the wrapper runs nothing

    async for _ in events:
        pass

    assert order == ["before_hook", "model_call"]


@pytest.mark.asyncio
async def test_agent_none_still_emits_span_but_skips_hooks_and_metrics():
    """Without an owning agent, hooks/metrics are skipped but the call remains traceable."""
    tracer = MagicMock()
    with patch("strands.event_loop._auxiliary_model_call.get_tracer", return_value=tracer):
        tru_events = [
            event
            async for event in instrument_auxiliary_model_call(
                _stream_with_stop(), source="summarization", agent=None, messages=PROMPT_MESSAGES, model_id="m-1"
            )
        ]

    assert len(tru_events) == 2
    tracer.start_model_invoke_span.assert_called_once_with(messages=PROMPT_MESSAGES, model_id="m-1", system_prompt=None)
    tracer.end_model_invoke_span.assert_called_once()


@pytest.mark.asyncio
async def test_emits_model_invoke_span_tagged_with_source(agent):
    """The auxiliary call opens a model-invoke span, tags it with source, and ends it with usage."""
    tracer = MagicMock()
    with patch("strands.event_loop._auxiliary_model_call.get_tracer", return_value=tracer):
        async for _ in instrument_auxiliary_model_call(
            _stream_with_stop(),
            source="summarization",
            agent=agent,
            messages=PROMPT_MESSAGES,
            model_id="m-1",
            system_prompt="sys",
        ):
            pass

    tracer.start_model_invoke_span.assert_called_once_with(
        messages=PROMPT_MESSAGES, model_id="m-1", system_prompt="sys"
    )
    span = tracer.start_model_invoke_span.return_value
    span.set_attribute.assert_called_once_with("strands.source", "summarization")
    end_call = tracer.end_model_invoke_span.call_args
    assert end_call.args[0] is span
    assert "inputTokens" in end_call.args[2]
    tracer.end_span_with_error.assert_not_called()


@pytest.mark.asyncio
async def test_span_ended_with_error_on_stream_failure(agent):
    tracer = MagicMock()
    error = RuntimeError("model failed")
    with patch("strands.event_loop._auxiliary_model_call.get_tracer", return_value=tracer):
        with pytest.raises(RuntimeError, match="model failed"):
            async for _ in instrument_auxiliary_model_call(
                _stream_that_raises(error), source="summarization", agent=agent, messages=PROMPT_MESSAGES
            ):
                pass

    tracer.end_span_with_error.assert_called_once()
    tracer.end_model_invoke_span.assert_not_called()


@pytest.mark.asyncio
async def test_span_ended_with_cancellation_on_mid_stream_cancel(agent):
    """A cancelled stream ends the span via end_span_with_cancellation, not as an ERROR."""
    tracer = MagicMock()
    error = asyncio.CancelledError()
    with patch("strands.event_loop._auxiliary_model_call.get_tracer", return_value=tracer):
        with pytest.raises(asyncio.CancelledError):
            async for _ in instrument_auxiliary_model_call(
                _stream_that_raises(error), source="routing", agent=agent, messages=PROMPT_MESSAGES
            ):
                pass

    tracer.end_span_with_cancellation.assert_called_once()
    tracer.end_span_with_error.assert_not_called()
    tracer.end_model_invoke_span.assert_not_called()


@pytest.mark.asyncio
async def test_span_ended_without_usage_when_no_stop(agent):
    tracer = MagicMock()
    with patch("strands.event_loop._auxiliary_model_call.get_tracer", return_value=tracer):
        async for _ in instrument_auxiliary_model_call(
            _stream_without_stop(), source="routing", agent=agent, messages=PROMPT_MESSAGES
        ):
            pass

    tracer.start_model_invoke_span.return_value.end.assert_called_once()
    tracer.end_model_invoke_span.assert_not_called()


@pytest.mark.asyncio
async def test_stream_error_fires_after_event_with_exception(agent, hook_provider):
    error = RuntimeError("model failed")

    with pytest.raises(RuntimeError, match="model failed"):
        async for _ in instrument_auxiliary_model_call(
            _stream_that_raises(error), source="summarization", agent=agent, messages=PROMPT_MESSAGES
        ):
            pass

    before_event, after_event = hook_provider.events_received
    assert isinstance(before_event, BeforeAuxiliaryModelCallEvent)
    assert isinstance(after_event, AfterAuxiliaryModelCallEvent)
    assert after_event.exception is error
    assert after_event.stop_response is None
    assert agent.event_loop_metrics.accumulated_usage_by_source == {}


@pytest.mark.asyncio
async def test_cancellation_mid_stream_fires_after_event(agent, hook_provider):
    """CancelledError is a BaseException; the After event must still fire (e.g. wait_for timeouts)."""
    error = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        async for _ in instrument_auxiliary_model_call(
            _stream_that_raises(error), source="routing", agent=agent, messages=PROMPT_MESSAGES
        ):
            pass

    before_event, after_event = hook_provider.events_received
    assert isinstance(before_event, BeforeAuxiliaryModelCallEvent)
    assert isinstance(after_event, AfterAuxiliaryModelCallEvent)
    assert after_event.exception is error
    assert after_event.stop_response is None


@pytest.mark.asyncio
async def test_stream_without_stop_event_fires_hooks_without_usage(agent, hook_provider):
    tru_events = [
        event
        async for event in instrument_auxiliary_model_call(
            _stream_without_stop(), source="routing", agent=agent, messages=PROMPT_MESSAGES
        )
    ]

    assert tru_events == [{"output": "structured"}]

    before_event, after_event = hook_provider.events_received
    assert before_event.source == "routing"
    assert after_event.stop_response is None
    assert after_event.exception is None
    assert agent.event_loop_metrics.accumulated_usage_by_source == {}


@pytest.mark.asyncio
async def test_malformed_stop_event_is_skipped_without_error(agent, hook_provider):
    """A third-party stream's malformed stop payload must not crash the call or lose the After event."""
    tru_events = [
        event
        async for event in instrument_auxiliary_model_call(
            _stream_with_malformed_stop(), source="routing", agent=agent, messages=PROMPT_MESSAGES
        )
    ]

    assert tru_events == [{"stop": ("end_turn", STOP_MESSAGE)}]

    before_event, after_event = hook_provider.events_received
    assert isinstance(before_event, BeforeAuxiliaryModelCallEvent)
    assert after_event.stop_response is None
    assert after_event.exception is None
    assert agent.event_loop_metrics.accumulated_usage_by_source == {}


@pytest.mark.asyncio
async def test_malformed_usage_payload_is_skipped_without_error(agent, hook_provider):
    """A 4-tuple stop whose usage is not a Usage dict must not raise out of the wrapper."""
    async for _ in instrument_auxiliary_model_call(
        _stream_with_malformed_usage(), source="routing", agent=agent, messages=PROMPT_MESSAGES
    ):
        pass

    before_event, after_event = hook_provider.events_received
    assert after_event.stop_response is None
    assert after_event.exception is None
    assert agent.event_loop_metrics.accumulated_usage_by_source == {}


def test_before_event_is_not_writable(agent):
    event = BeforeAuxiliaryModelCallEvent(agent=agent, source="summarization", messages=PROMPT_MESSAGES)

    with pytest.raises(AttributeError, match="Property source is not writable"):
        event.source = "routing"


def test_after_event_is_not_writable(agent):
    event = AfterAuxiliaryModelCallEvent(agent=agent, source="summarization")

    with pytest.raises(AttributeError, match="Property exception is not writable"):
        event.exception = RuntimeError("nope")


# --- instrument_auxiliary_agent_call (inner-Agent auxiliary calls) ---


def _agent_result(usage=STOP_USAGE):
    metrics = EventLoopMetrics()
    metrics.accumulated_usage = Usage(**usage)
    return AgentResult(stop_reason="end_turn", message=STOP_MESSAGE, metrics=metrics, state={})


@pytest.mark.asyncio
async def test_agent_call_fires_hook_pair_and_records_usage(agent, hook_provider):
    result = await instrument_auxiliary_agent_call(
        lambda: _async_return(_agent_result()),
        source="web_fetch",
        agent=agent,
        messages=PROMPT_MESSAGES,
        system_prompt="analyst prompt",
        invocation_state={"key": "value"},
    )

    assert result.message == STOP_MESSAGE

    before_event, after_event = hook_provider.events_received
    assert isinstance(before_event, BeforeAuxiliaryModelCallEvent)
    assert before_event.source == "web_fetch"
    assert before_event.messages == PROMPT_MESSAGES
    assert before_event.system_prompt == "analyst prompt"
    assert before_event.invocation_state == {"key": "value"}

    assert isinstance(after_event, AfterAuxiliaryModelCallEvent)
    assert after_event.exception is None
    assert after_event.stop_response == AfterAuxiliaryModelCallEvent.ModelStopResponse(
        message=STOP_MESSAGE, stop_reason="end_turn", usage=STOP_USAGE
    )

    assert agent.event_loop_metrics.accumulated_usage == STOP_USAGE
    assert agent.event_loop_metrics.accumulated_usage_by_source == {"web_fetch": STOP_USAGE}


@pytest.mark.asyncio
async def test_agent_call_does_not_rerecord_otel_histograms(agent):
    """The inner agent's loop already records its tokens to OTel; the rollup must not."""
    with patch.object(type(agent.event_loop_metrics), "_metrics_client", create=True, new=MagicMock()) as client:
        await instrument_auxiliary_agent_call(
            lambda: _async_return(_agent_result()),
            source="web_fetch",
            agent=agent,
            messages=PROMPT_MESSAGES,
        )
        client.event_loop_input_tokens.record.assert_not_called()
        client.event_loop_output_tokens.record.assert_not_called()

    assert agent.event_loop_metrics.accumulated_usage_by_source == {"web_fetch": STOP_USAGE}


@pytest.mark.asyncio
async def test_agent_call_invoke_runs_after_before_event(agent):
    order = []

    agent.hooks.add_callback(BeforeAuxiliaryModelCallEvent, lambda _: order.append("before_hook"))

    async def invoke():
        order.append("agent_call")
        return _agent_result()

    await instrument_auxiliary_agent_call(invoke, source="web_fetch", agent=agent, messages=PROMPT_MESSAGES)

    assert order == ["before_hook", "agent_call"]


@pytest.mark.asyncio
async def test_agent_call_error_fires_after_event_with_exception(agent, hook_provider):
    error = RuntimeError("analyst failed")

    async def invoke():
        raise error

    with pytest.raises(RuntimeError, match="analyst failed"):
        await instrument_auxiliary_agent_call(invoke, source="web_fetch", agent=agent, messages=PROMPT_MESSAGES)

    before_event, after_event = hook_provider.events_received
    assert isinstance(before_event, BeforeAuxiliaryModelCallEvent)
    assert after_event.exception is error
    assert after_event.stop_response is None
    assert agent.event_loop_metrics.accumulated_usage_by_source == {}


@pytest.mark.asyncio
async def test_agent_call_agent_none_is_uninstrumented():
    result = await instrument_auxiliary_agent_call(
        lambda: _async_return(_agent_result()), source="web_fetch", agent=None, messages=PROMPT_MESSAGES
    )

    assert result.message == STOP_MESSAGE


@pytest.mark.asyncio
async def test_agent_call_zeroed_usage_still_fires_hooks_without_stop_response(agent, hook_provider):
    """An inner result whose metrics carry no usable usage skips the rollup, not the hooks."""
    result = _agent_result()
    result.metrics.accumulated_usage = None  # type: ignore[assignment]

    await instrument_auxiliary_agent_call(
        lambda: _async_return(result), source="web_fetch", agent=agent, messages=PROMPT_MESSAGES
    )

    _, after_event = hook_provider.events_received
    assert after_event.stop_response is None
    assert after_event.exception is None
    assert agent.event_loop_metrics.accumulated_usage_by_source == {}


async def _async_return(value):
    return value
