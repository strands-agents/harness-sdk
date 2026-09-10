"""Unit tests for bidirectional streaming telemetry instrumentation.

Tests that spans are created, closed, and attributed correctly for:
- Session lifecycle (start/stop)
- Connection establishment (model.start)
- Response lifecycle (ResponseStart/ResponseComplete)
- Tool call execution
- Connection restart on timeout
- Interruption events
- Usage accumulation
"""

import unittest.mock

import pytest
import pytest_asyncio
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import StatusCode

from strands import tool
from strands.experimental.bidi import BidiAgent, _telemetry
from strands.experimental.bidi.models import BidiModel, BidiModelTimeoutError
from strands.experimental.bidi.types.events import (
    BidiAudioStreamEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiUsageEvent,
)
from strands.experimental.hooks.events import (
    BidiAfterConnectionRestartEvent,
    BidiBeforeConnectionRestartEvent,
)
from strands.telemetry.tracer import Tracer
from strands.types._events import ToolResultMessageEvent, ToolUseStreamEvent


class _InMemoryExporter(SpanExporter):
    """Collects finished spans in a list for test assertions."""

    def __init__(self):
        self.spans = []

    def export(self, spans):
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self):
        pass

    def get_finished_spans(self):
        return list(self.spans)


@tool(name="mock_tool")
async def mock_tool_func() -> str:
    """A mock tool.

    Returns:
        Result.
    """
    return "tool result"


@pytest.fixture(autouse=True)
def otel_setup():
    """Patch the tracer singleton to use an in-memory provider."""
    exporter = _InMemoryExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    import strands.telemetry.tracer as tracer_module

    # Get or create the tracer singleton, then swap its internal tracer
    tracer = tracer_module.get_tracer()
    original_tracer = tracer.tracer
    tracer.tracer = provider.get_tracer(tracer.service_name)

    yield exporter

    tracer.tracer = original_tracer


@pytest.fixture
def agent():
    model = unittest.mock.AsyncMock(spec=BidiModel)
    model.get_connection_config.return_value = {}
    model.restart = unittest.mock.AsyncMock()
    return BidiAgent(model=model, tools=[mock_tool_func])


@pytest_asyncio.fixture
async def loop(agent):
    return agent._loop


@pytest.mark.asyncio
async def test_session_span_created_on_start(loop, agent, agenerator, otel_setup):
    """Session span is created after model.start() succeeds."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()

    assert loop._session_span is not None

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    session_spans = [s for s in spans if "bidi_session" in s.name]
    assert len(session_spans) == 1
    assert session_spans[0].attributes["gen_ai.operation.name"] == "bidi_session"


@pytest.mark.asyncio
async def test_session_span_closed_on_stop(loop, agent, agenerator):
    """Session span is ended when stop() is called."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()
    session_span = loop._session_span

    await loop.stop()

    assert loop._session_span is None
    assert not session_span.is_recording()


@pytest.mark.asyncio
async def test_session_span_records_error_on_start_failure(loop, agent, otel_setup):
    """Session and connection spans record error when model.start() fails."""
    agent.model.start = unittest.mock.AsyncMock(side_effect=ConnectionError("bad credentials"))

    with pytest.raises(ConnectionError, match="bad credentials"):
        await loop.start()

    assert loop._session_span is None

    spans = otel_setup.get_finished_spans()
    session_spans = [s for s in spans if "bidi_session" in s.name]
    connect_spans = [s for s in spans if "bidi_connect" in s.name]

    assert len(session_spans) == 1
    assert session_spans[0].status.status_code == StatusCode.ERROR

    assert len(connect_spans) == 1
    assert connect_spans[0].status.status_code == StatusCode.ERROR


@pytest.mark.asyncio
async def test_connection_span_created_during_start(loop, agent, agenerator, otel_setup):
    """A bidi_connect span wraps model.start()."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()
    await loop.stop()

    spans = otel_setup.get_finished_spans()
    connect_spans = [s for s in spans if "bidi_connect" in s.name]
    assert len(connect_spans) == 1
    assert connect_spans[0].attributes["gen_ai.operation.name"] == "bidi_connect"


@pytest.mark.asyncio
async def test_response_span_lifecycle(loop, agent, agenerator):
    """Response spans open on ResponseStart and close on ResponseComplete."""
    events = [
        BidiResponseStartEvent(response_id="resp-1"),
        BidiResponseCompleteEvent(response_id="resp-1", stop_reason="complete"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    received = []
    async for event in loop.receive():
        received.append(event)
        if isinstance(event, BidiResponseCompleteEvent):
            break

    assert len(received) == 2

    await loop.stop()


@pytest.mark.asyncio
async def test_response_span_records_stop_reason(loop, agent, agenerator, otel_setup):
    """Response span captures the stop_reason as finish_reason attribute."""
    events = [
        BidiResponseStartEvent(response_id="resp-2"),
        BidiResponseCompleteEvent(response_id="resp-2", stop_reason="interrupted"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    async for event in loop.receive():
        if isinstance(event, BidiResponseCompleteEvent):
            break

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    response_spans = [s for s in spans if "bidi_response" in s.name]
    assert len(response_spans) == 1
    assert response_spans[0].attributes["gen_ai.response.finish_reason"] == "interrupted"


@pytest.mark.asyncio
async def test_response_span_records_time_to_first_audio(loop, agent, agenerator, otel_setup):
    """Response span records time to first audio when audio is emitted."""
    events = [
        BidiResponseStartEvent(response_id="resp-audio"),
        BidiAudioStreamEvent(audio="", format="pcm", sample_rate=24000, channels=1),
        BidiResponseCompleteEvent(response_id="resp-audio", stop_reason="complete"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    async for event in loop.receive():
        if isinstance(event, BidiResponseCompleteEvent):
            break

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    response_spans = [s for s in spans if "bidi_response" in s.name]
    assert len(response_spans) == 1
    assert response_spans[0].attributes["gen_ai.server.time_to_first_audio"] >= 0


@pytest.mark.asyncio
async def test_response_span_omits_time_to_first_audio_when_no_audio(loop, agent, agenerator, otel_setup):
    """Response span omits the time-to-first-audio attribute when no audio is emitted."""
    events = [
        BidiResponseStartEvent(response_id="resp-noaudio"),
        BidiResponseCompleteEvent(response_id="resp-noaudio", stop_reason="complete"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    async for event in loop.receive():
        if isinstance(event, BidiResponseCompleteEvent):
            break

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    response_spans = [s for s in spans if "bidi_response" in s.name]
    assert len(response_spans) == 1
    assert "gen_ai.server.time_to_first_audio" not in response_spans[0].attributes


@pytest.mark.asyncio
async def test_tool_call_span_created(loop, agent, agenerator, otel_setup):
    """Tool call span wraps tool execution."""
    tool_use = {"toolUseId": "t1", "name": "mock_tool", "input": {}}
    events = [ToolUseStreamEvent(current_tool_use=tool_use, delta="")]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    async for event in loop.receive():
        if isinstance(event, ToolResultMessageEvent):
            break

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    tool_spans = [s for s in spans if "execute_tool" in s.name]
    assert len(tool_spans) == 1
    assert tool_spans[0].attributes["gen_ai.tool.name"] == "mock_tool"
    assert tool_spans[0].status.status_code == StatusCode.OK


@pytest.mark.asyncio
async def test_tool_call_span_closed_on_error(loop, agent, agenerator, otel_setup):
    """Tool call span is closed with error status when tool execution raises."""
    tool_use = {"toolUseId": "t1", "name": "mock_tool", "input": {}}
    events = [ToolUseStreamEvent(current_tool_use=tool_use, delta="")]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))
    agent.tool_executor._stream = unittest.mock.Mock(side_effect=RuntimeError("tool boom"))

    await loop.start()

    with pytest.raises(RuntimeError, match="tool boom"):
        async for _ in loop.receive():
            pass

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    tool_spans = [s for s in spans if "execute_tool" in s.name]
    assert len(tool_spans) == 1
    assert tool_spans[0].status.status_code == StatusCode.ERROR


@pytest.mark.asyncio
async def test_connection_restart_span(loop, agent, agenerator, otel_setup):
    """Connection restart creates a span with error message."""
    timeout_error = BidiModelTimeoutError("8 minute timeout")
    text_event = BidiTextInputEvent(text="after restart")

    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([text_event])])

    await loop.start()

    received = []
    async for event in loop.receive():
        received.append(event)
        if len(received) >= 2:
            break

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    restart_spans = [s for s in spans if "bidi_connection_restart" in s.name]
    assert len(restart_spans) == 1
    assert restart_spans[0].attributes["gen_ai.bidi.restart_reason"] == "timeout"
    assert restart_spans[0].attributes["gen_ai.bidi.restart_error_message"] == "8 minute timeout"


@pytest.mark.asyncio
async def test_before_restart_hook_exception_propagates(loop, agent, agenerator):
    """A raising before-restart hook propagates out of receive() and leaves the send gate closed."""
    timeout_error = BidiModelTimeoutError("8 minute timeout")
    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([])])

    def raise_hook(event: BidiBeforeConnectionRestartEvent) -> None:
        raise RuntimeError("hook boom")

    agent.hooks.add_callback(BidiBeforeConnectionRestartEvent, raise_hook)

    await loop.start()

    with pytest.raises(RuntimeError, match="hook boom"):
        async for _ in loop.receive():
            pass

    assert not loop._send_gate.is_set()

    await loop.stop()


@pytest.mark.asyncio
async def test_restart_failure_propagates_and_reports(loop, agent, agenerator):
    """A failed restart surfaces to receive(), keeps the gate closed, and fires the after-restart hook."""
    timeout_error = BidiModelTimeoutError("8 minute timeout")
    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([])])
    agent.model.restart = unittest.mock.AsyncMock(side_effect=ConnectionError("restart failed"))

    after_errors = []
    agent.hooks.add_callback(BidiAfterConnectionRestartEvent, lambda event: after_errors.append(event.exception))

    await loop.start()

    with pytest.raises(ConnectionError, match="restart failed"):
        async for _ in loop.receive():
            pass

    assert not loop._send_gate.is_set()
    assert len(after_errors) == 1
    assert isinstance(after_errors[0], ConnectionError)

    await loop.stop()


@pytest.mark.asyncio
async def test_interruption_event_recorded_on_session_span(loop, agent, agenerator, otel_setup):
    """Interruption events are added to the session span."""
    events = [
        BidiResponseStartEvent(response_id="resp-3"),
        BidiInterruptionEvent(reason="user_speech"),
        BidiResponseCompleteEvent(response_id="resp-3", stop_reason="interrupted"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    async for event in loop.receive():
        if isinstance(event, BidiResponseCompleteEvent):
            break

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    session_spans = [s for s in spans if "bidi_session" in s.name]
    assert len(session_spans) == 1

    span_events = session_spans[0].events
    assert any(ev.name == "bidi_interruption" for ev in span_events)


@pytest.mark.asyncio
async def test_usage_accumulation(loop, agent, agenerator, otel_setup):
    """Usage events accumulate tokens on the loop and session span."""
    events = [
        BidiUsageEvent(input_tokens=100, output_tokens=50, total_tokens=150, cache_read_input_tokens=20),
        BidiUsageEvent(input_tokens=200, output_tokens=75, total_tokens=275),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    received = []
    async for event in loop.receive():
        received.append(event)
        if len(received) >= 2:
            break

    assert loop._accumulated_input_tokens == 300
    assert loop._accumulated_output_tokens == 125
    assert loop._accumulated_total_tokens == 425
    assert loop._accumulated_cache_read_tokens == 20

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    session_spans = [s for s in spans if "bidi_session" in s.name]
    assert session_spans[0].attributes["gen_ai.usage.input_tokens"] == 300
    assert session_spans[0].attributes["gen_ai.usage.output_tokens"] == 125
    assert session_spans[0].attributes["gen_ai.usage.total_tokens"] == 425
    assert session_spans[0].attributes["gen_ai.usage.cache_read.input_tokens"] == 20
    # deprecated alias kept so existing consumers keep resolving, value-identical to the semconv name
    assert (
        session_spans[0].attributes["gen_ai.usage.cache_read_input_tokens"]
        == session_spans[0].attributes["gen_ai.usage.cache_read.input_tokens"]
    )


@pytest.mark.asyncio
async def test_response_span_closed_on_model_error(loop, agent, otel_setup):
    """Open response spans close with error status when model raises."""

    async def failing_receive():
        yield BidiResponseStartEvent(response_id="resp-err")
        raise RuntimeError("model crashed")

    agent.model.receive = unittest.mock.Mock(return_value=failing_receive())

    await loop.start()

    with pytest.raises(RuntimeError, match="model crashed"):
        async for _ in loop.receive():
            pass

    await loop.stop()

    spans = otel_setup.get_finished_spans()
    response_spans = [s for s in spans if "bidi_response" in s.name]
    assert len(response_spans) == 1
    assert response_spans[0].status.status_code == StatusCode.ERROR
    assert response_spans[0].attributes["gen_ai.response.finish_reason"] == "error"


@pytest.mark.asyncio
async def test_no_crash_without_otel_configured(loop, agent, agenerator):
    """Telemetry doesn't crash when OTel is not configured (no-op tracer)."""
    events = [
        BidiResponseStartEvent(response_id="resp-noop"),
        BidiResponseCompleteEvent(response_id="resp-noop", stop_reason="complete"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    async for event in loop.receive():
        if isinstance(event, BidiResponseCompleteEvent):
            break

    await loop.stop()


def test_end_session_span_latest_conventions_suppresses_deprecated_cache_name(monkeypatch):
    """Opting into the latest conventions emits the semconv cache name only, without the deprecated alias."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    tracer = Tracer()
    span = unittest.mock.MagicMock()

    _telemetry.end_session_span(
        tracer, span, input_tokens=300, output_tokens=125, total_tokens=425, cache_read_input_tokens=20
    )

    emitted = span.set_attributes.call_args[0][0]
    assert emitted["gen_ai.usage.cache_read.input_tokens"] == 20
    assert "gen_ai.usage.cache_read_input_tokens" not in emitted
