import asyncio
import base64
import json
import logging
import struct
import types
import unittest.mock

import pytest
import pytest_asyncio
from websockets.exceptions import ConnectionClosedError as WebSocketClosedError
from websockets.exceptions import InvalidStatus

from strands import tool
from strands.bidi import BidiAgent
from strands.bidi.models import ConnectionTimeoutError
from strands.bidi.types import (
    AudioDelta,
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiBargeInEvent,
    BidiConnectionStartEvent,
    BidiMessage,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiToolUseBlocksEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
)
from strands.experimental.bidi.models import openai_live
from strands.experimental.bidi.models.openai_live import (
    _RESTART_INSTRUCTION,
    ConnectionClosedError,
    OpenAILiveModel,
    _format_history,
)
from strands.types._events import ToolResultMessageEvent
from strands.types.content import TextBlock
from strands.types.exceptions import ModelThrottledException
from strands.types.media import ImageBlock
from strands.types.tools import ToolResultBlock

SPEECH = base64.b64encode(struct.pack("<4h", 1200, -900, 800, -1100)).decode()
SILENCE = base64.b64encode(bytes(8)).decode()

# Frozen from the openai==3.29.0 wheel (openai/types/live). Update together with the provider when
# the Live protocol changes.
LIVE_SERVER_EVENTS = frozenset(
    {
        "session.started",
        "session.updated",
        "session.input_audio.muted",
        "session.input_audio.unmuted",
        "session.instructions.appended",
        "session.thinking.appended",
        "session.commentary.appended",
        "session.input_audio.append",
        "session.output_audio.delta",
        "session.input_transcript.delta",
        "session.output_transcript.delta",
        "session.delegation.created",
        "response.event",
        "session.usage.updated",
        "session.closed",
        "error",
        "info",
        "transport.dtmf.received",
        "transport.dtmf.send",
        "transport.ringing",
        "transport.answered",
        "transport.failed",
    }
)
LIVE_CLIENT_EVENTS = frozenset(
    {
        "session.start",
        "session.update",
        "session.input_audio.append",
        "session.input_audio.mute",
        "session.input_audio.unmute",
        "session.instructions.append",
        "session.thinking.append",
        "session.commentary.append",
        "response.item.create",
        "response.create",
        "session.close",
    }
)


class FakeWebSocket:
    """Scripted Live socket. Pushed events are returned by recv in order."""

    def __init__(self, *, close_reason="close_requested"):
        self.sent = []
        self.incoming = asyncio.Queue()
        self.closed = False
        self.close_reason = close_reason

    def push(self, event):
        self.incoming.put_nowait(json.dumps(event))

    def drop(self):
        self.incoming.put_nowait(WebSocketClosedError(None, None))

    async def send(self, data):
        payload = json.loads(data)
        assert payload["type"] in LIVE_CLIENT_EVENTS, payload["type"]
        self.sent.append(payload)
        if payload["type"] == "session.close" and self.close_reason is not None:
            self.push({"type": "session.closed", "reason": self.close_reason, "usage": {"seconds": 42.5}})

    async def recv(self):
        item = await self.incoming.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self):
        self.closed = True

    def sent_types(self):
        return [payload["type"] for payload in self.sent]

    def sent_of(self, event_type):
        return [payload for payload in self.sent if payload["type"] == event_type]


def started_event(session_id="sess_1", expires_at=None):
    return {"type": "session.started", "session": {"id": session_id, "expires_at": expires_at}}


def backend(event, delegation_id="del_1"):
    return {"type": "response.event", "delegation_id": delegation_id, "event": event}


def function_call(call_id, name="lookup", arguments='{"id": "A1"}'):
    return backend(
        {
            "type": "response.output_item.done",
            "item": {"type": "function_call", "call_id": call_id, "name": name, "arguments": arguments},
        }
    )


def completed(response_id="resp_1", usage=None):
    response = {"id": response_id, "output": []}
    if usage is not None:
        response["usage"] = usage
    return backend({"type": "response.completed", "response": response})


def created(response_id="resp_1"):
    return backend({"type": "response.created", "response": {"id": response_id}})


def tool_result(call_id, text="done", status="success"):
    return ToolResultBlock(tool_use_id=call_id, status=status, content=[{"text": text}])


@pytest.fixture
def sockets():
    return []


@pytest.fixture
def mock_connect(sockets):
    async def connect(*args, **kwargs):
        websocket = FakeWebSocket()
        websocket.push(started_event(session_id=f"sess_{len(sockets) + 1}"))
        sockets.append(websocket)
        return websocket

    with unittest.mock.patch.object(openai_live.websockets, "connect", side_effect=connect) as mocked:
        yield mocked


@pytest.fixture
def model(mock_connect):
    return OpenAILiveModel(model_id="gpt-live-1", backend_model_id="gpt-6-luna", api_key="sk-secret-key")


@pytest.fixture
def tool_spec():
    return {
        "name": "lookup",
        "description": "Look up an order",
        "inputSchema": {"json": {"type": "object", "properties": {"id": {"type": "string"}}}},
    }


@pytest_asyncio.fixture
async def started(model, sockets, tool_spec):
    await model.start(tools=[tool_spec])
    yield model._connection, sockets[-1]
    await model.stop()


async def handle(model, connection, events, now=0.0):
    output = []
    for event in events:
        output.extend(await model._handle(connection, event, now))
    return output


def test_init_requires_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="API key is required"):
        OpenAILiveModel(model_id="gpt-live-1", backend_model_id="gpt-6-luna")


def test_init_requires_backend_model():
    with pytest.raises(ValueError, match="backend_model_id"):
        OpenAILiveModel(model_id="gpt-live-1", backend_model_id="", api_key="k")


@pytest.mark.parametrize(
    "params",
    [
        {"model": "other"},
        {"instructions": "x"},
        {"input": []},
        {"delegation": {"type": "client"}},
        {"delegation": {"responses": {"model": "other"}}},
        {"delegation": {"responses": {"instructions": "x"}}},
        {"delegation": {"responses": {"tools": [{"type": "mcp", "server_label": "s"}]}}},
        {"delegation": {"responses": {"tools": [{"type": "function", "name": "f"}]}}},
    ],
)
def test_init_rejects_provider_owned_params(params):
    with pytest.raises(ValueError):
        OpenAILiveModel(model_id="gpt-live-1", backend_model_id="b", api_key="k", params=params)


@pytest.mark.parametrize(
    "audio_format",
    [{"type": "audio/pcm", "rate": 8000}, {"type": "audio/pcmu", "rate": 8000}],
)
def test_init_rejects_unsupported_audio(audio_format):
    with pytest.raises(ValueError, match="unsupported"):
        OpenAILiveModel(
            model_id="gpt-live-1", backend_model_id="b", api_key="k", params={"audio": {"format": audio_format}}
        )


@pytest.mark.parametrize("rate", [16000, 24000])
def test_get_audio_config(rate):
    model = OpenAILiveModel(
        model_id="gpt-live-1",
        backend_model_id="b",
        api_key="k",
        params={"audio": {"format": {"type": "audio/pcm", "rate": rate}}},
    )
    tru_config = model.get_audio_config()
    exp_config = {
        "input": {"sample_rate": rate, "channels": 1, "format": "pcm"},
        "output": {"sample_rate": rate, "channels": 1, "format": "pcm"},
    }
    assert tru_config == exp_config


def test_update_config_validates_params(model):
    with pytest.raises(ValueError):
        model.update_config(params={"model": "other"})

    model.update_config(params={"audio": {"format": {"type": "audio/pcm", "rate": 16000}}})
    assert model.get_audio_config()["input"]["sample_rate"] == 16000


@pytest.mark.asyncio
async def test_start_sends_session_start(model, mock_connect, sockets, tool_spec):
    params = {
        "store": True,
        "delegation": {"responses": {"reasoning": {"effort": "low"}, "tools": [{"type": "web_search"}]}},
    }
    model = OpenAILiveModel(
        model_id="gpt-live-1",
        backend_model_id="gpt-6-luna",
        backend_instructions="Backend prompt",
        api_key="k",
        organization="org",
        project="proj",
        voice="quartz",
        params=params,
    )
    messages = [
        {"role": "user", "content": [{"text": "Hi"}]},
        {"role": "assistant", "content": [{"text": "Hello"}]},
    ]

    await model.start(system_prompt="Voice prompt", tools=[tool_spec], messages=messages)
    try:
        tru_start = sockets[0].sent[0]
        exp_start = {
            "type": "session.start",
            "event_id": unittest.mock.ANY,
            "session": {
                "model": "gpt-live-1",
                "instructions": "Voice prompt",
                "audio": {"format": {"type": "audio/pcm", "rate": 24000}, "output": {"voice": "quartz"}},
                "store": True,
                "input": [
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hi"}]},
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hello"}]},
                ],
                "delegation": {
                    "type": "responses",
                    "responses": {
                        "model": "gpt-6-luna",
                        "instructions": "Backend prompt",
                        "parallel_tool_calls": True,
                        "reasoning": {"effort": "low"},
                        "tools": [
                            {"type": "web_search"},
                            {
                                "type": "function",
                                "name": "lookup",
                                "description": "Look up an order",
                                "parameters": {"type": "object", "properties": {"id": {"type": "string"}}},
                            },
                        ],
                    },
                },
            },
        }
        assert tru_start == exp_start
        assert params["delegation"]["responses"]["tools"] == [{"type": "web_search"}]

        url = mock_connect.call_args.args[0]
        headers = mock_connect.call_args.kwargs["additional_headers"]
        assert url == "wss://api.openai.com/v1/live/sessions"
        assert headers == [("Authorization", "Bearer k"), ("OpenAI-Organization", "org"), ("OpenAI-Project", "proj")]
        assert model._connection_id == "sess_1"
    finally:
        await model.stop()


@pytest.mark.asyncio
async def test_start_rejects_invalid_tool_before_connecting(model, mock_connect):
    bad_tool = {"name": "bad name", "description": "", "inputSchema": {"json": {"type": "object"}}}
    with pytest.raises(ValueError, match="tool names"):
        await model.start(tools=[bad_tool])
    mock_connect.assert_not_called()


@pytest.mark.asyncio
async def test_start_rejects_non_object_schema(model, mock_connect):
    bad_tool = {"name": "bad", "description": "", "inputSchema": {"json": {"type": "string"}}}
    with pytest.raises(ValueError, match="JSON object schema"):
        await model.start(tools=[bad_tool])


@pytest.mark.asyncio
async def test_start_derives_restart_deadline(model, sockets):
    async def connect(*args, **kwargs):
        websocket = FakeWebSocket()
        websocket.push(started_event(expires_at=10_000))
        sockets.append(websocket)
        return websocket

    with (
        unittest.mock.patch.object(openai_live.websockets, "connect", side_effect=connect),
        unittest.mock.patch.object(openai_live.time, "time", return_value=7_000),
    ):
        await model.start()
    try:
        assert model.get_connection_config() == {"restart_after_s": 2940}
    finally:
        await model.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("params", "expires_at", "exp_restart_after_s"),
    [
        ({"store": True}, 10_000, 2910),
        (None, 7_030, 1),
    ],
)
async def test_start_restart_deadline_margin(sockets, params, expires_at, exp_restart_after_s):
    async def connect(*args, **kwargs):
        websocket = FakeWebSocket()
        websocket.push(started_event(expires_at=expires_at))
        sockets.append(websocket)
        return websocket

    model = OpenAILiveModel(model_id="gpt-live-1", backend_model_id="b", api_key="k", params=params)
    with (
        unittest.mock.patch.object(openai_live.websockets, "connect", side_effect=connect),
        unittest.mock.patch.object(openai_live.time, "time", return_value=7_000),
    ):
        await model.start()
    try:
        assert model.get_connection_config() == {"restart_after_s": exp_restart_after_s}
    finally:
        await model.stop()


@pytest.mark.asyncio
async def test_start_keeps_explicit_restart_deadline(sockets):
    async def connect(*args, **kwargs):
        websocket = FakeWebSocket()
        websocket.push(started_event(expires_at=10_000))
        sockets.append(websocket)
        return websocket

    model = OpenAILiveModel(
        model_id="gpt-live-1", backend_model_id="b", api_key="k", connection={"restart_after_s": 20}
    )
    with unittest.mock.patch.object(openai_live.websockets, "connect", side_effect=connect):
        await model.start()
    try:
        assert model.get_connection_config() == {"restart_after_s": 20}
    finally:
        await model.stop()


@pytest.mark.asyncio
async def test_start_error_before_started(model):
    websocket = FakeWebSocket()
    websocket.push({"type": "error", "error": {"code": "invalid_value", "param": "session.audio", "message": "bad"}})
    with unittest.mock.patch.object(
        openai_live.websockets, "connect", new=unittest.mock.AsyncMock(return_value=websocket)
    ):
        with pytest.raises(ValueError, match=r"code=<invalid_value>, param=<session.audio> \| bad"):
            await model.start()
    assert websocket.closed
    assert model._connection_id is None


@pytest.mark.asyncio
async def test_start_socket_closed_before_started(model):
    websocket = FakeWebSocket()
    websocket.drop()
    with unittest.mock.patch.object(
        openai_live.websockets, "connect", new=unittest.mock.AsyncMock(return_value=websocket)
    ):
        with pytest.raises(ConnectionTimeoutError, match="before session.started"):
            await model.start()


@pytest.mark.asyncio
async def test_start_timeout(monkeypatch):
    monkeypatch.setattr(openai_live, "_STARTUP_TIMEOUT_S", 0.05)
    model = OpenAILiveModel(model_id="gpt-live-1", backend_model_id="b", api_key="k")
    websocket = FakeWebSocket()
    with unittest.mock.patch.object(
        openai_live.websockets, "connect", new=unittest.mock.AsyncMock(return_value=websocket)
    ):
        with pytest.raises(TimeoutError, match="session did not start"):
            await model.start()
    assert websocket.closed


@pytest.mark.asyncio
async def test_start_throttled(model):
    error = InvalidStatus(types.SimpleNamespace(status_code=429))
    with unittest.mock.patch.object(openai_live.websockets, "connect", side_effect=error):
        with pytest.raises(ModelThrottledException):
            await model.start()


@pytest.mark.asyncio
async def test_start_twice(started, model):
    with pytest.raises(RuntimeError, match="already started"):
        await model.start()


@pytest.mark.asyncio
async def test_assistant_burst_lifecycle(model, started):
    connection, _ = started
    events = await handle(
        model,
        connection,
        [
            {"type": "session.output_audio.delta", "delta": SPEECH},
            {"type": "session.output_transcript.delta", "delta": "Hi ", "start_ms": 100, "end_ms": 200},
            {"type": "session.output_transcript.delta", "delta": " there", "start_ms": 200, "end_ms": 300},
        ],
    )
    burst = connection.burst
    events.extend(model._tick(connection, now=0.5))
    events.extend(model._tick(connection, now=0.71))

    exp_events = [
        BidiResponseStartEvent(burst.response_id),
        BidiAudioStartEvent(burst.audio_content_id),
        BidiAudioDeltaEvent(
            audio=SPEECH, content_id=burst.audio_content_id, format="pcm", sample_rate=24000, channels=1
        ),
        BidiTranscriptStartEvent("assistant", burst.response_id),
        BidiTranscriptDeltaEvent("Hi ", "assistant", burst.response_id),
        BidiTranscriptDeltaEvent(" there", "assistant", burst.response_id),
        BidiAudioStopEvent(burst.audio_content_id),
        BidiTranscriptStopEvent("assistant", burst.response_id),
        BidiResponseStopEvent(burst.response_id),
    ]
    assert events == exp_events
    assert connection.burst is None


@pytest.mark.asyncio
async def test_silent_audio_opens_no_burst(model, started):
    connection, _ = started
    events = await handle(model, connection, [{"type": "session.output_audio.delta", "delta": SILENCE}])

    assert events == []
    assert connection.burst is None


@pytest.mark.asyncio
async def test_silent_audio_inside_burst_does_not_extend_it(model, started):
    connection, _ = started
    await handle(model, connection, [{"type": "session.output_audio.delta", "delta": SPEECH}], now=0.0)
    burst = connection.burst
    events = await handle(model, connection, [{"type": "session.output_audio.delta", "delta": SILENCE}], now=0.5)

    assert events == [
        BidiAudioDeltaEvent(
            audio=SILENCE, content_id=burst.audio_content_id, format="pcm", sample_rate=24000, channels=1
        )
    ]
    assert model._tick(connection, now=0.86)[-1] == BidiResponseStopEvent(burst.response_id)


@pytest.mark.asyncio
async def test_none_params_are_omitted(mock_connect, sockets):
    model = OpenAILiveModel(
        model_id="gpt-live-1",
        backend_model_id="b",
        api_key="k",
        params={"store": None, "delegation": {"responses": {"parallel_tool_calls": None, "tools": None}}},
    )
    await model.start()
    try:
        session = sockets[0].sent[0]["session"]
        assert "store" not in session
        assert "parallel_tool_calls" not in session["delegation"]["responses"]
        assert session["delegation"]["responses"]["tools"] == []
    finally:
        await model.stop()


@pytest.mark.asyncio
async def test_assistant_burst_waits_for_caption_after_audio(model, started):
    connection, _ = started
    await handle(model, connection, [{"type": "session.output_audio.delta", "delta": SPEECH}])

    assert model._tick(connection, now=0.75) == []
    assert model._tick(connection, now=0.86)[-1] == BidiResponseStopEvent(unittest.mock.ANY)


@pytest.mark.asyncio
async def test_assistant_burst_splits_on_timeline_gap(model, started):
    connection, _ = started
    await handle(
        model, connection, [{"type": "session.output_transcript.delta", "delta": "A", "start_ms": 0, "end_ms": 100}]
    )
    first_id = connection.burst.response_id
    events = await handle(
        model,
        connection,
        [{"type": "session.output_transcript.delta", "delta": "B", "start_ms": 1500, "end_ms": 1600}],
    )
    second_id = connection.burst.response_id

    exp_events = [
        BidiTranscriptStopEvent("assistant", first_id),
        BidiResponseStopEvent(first_id),
        BidiResponseStartEvent(second_id),
        BidiTranscriptStartEvent("assistant", second_id),
        BidiTranscriptDeltaEvent("B", "assistant", second_id),
    ]
    assert events == exp_events


@pytest.mark.asyncio
async def test_user_segment_survives_assistant_overlap(model, started):
    connection, _ = started
    events = await handle(
        model,
        connection,
        [
            {"type": "session.input_transcript.delta", "delta": "I'd like", "start_ms": 0, "end_ms": 400},
            {"type": "session.output_transcript.delta", "delta": "Mm-hmm", "start_ms": 450, "end_ms": 600},
            {"type": "session.input_transcript.delta", "delta": "  to  change", "start_ms": 500, "end_ms": 900},
        ],
    )
    user_id = connection.user.content_id
    user_events = [event for event in events if getattr(event, "role", None) == "user"]
    exp_user_events = [
        BidiTranscriptStartEvent("user", user_id),
        BidiTranscriptDeltaEvent("I'd like", "user", user_id),
        BidiTranscriptDeltaEvent("  to  change", "user", user_id),
    ]
    assert user_events == exp_user_events

    assert model._tick(connection, now=1.1)[-1] != BidiTranscriptStopEvent("user", user_id)
    assert BidiTranscriptStopEvent("user", user_id) in model._tick(connection, now=1.2)


@pytest.mark.asyncio
async def test_user_segment_splits_on_gap_and_size(model, started, monkeypatch):
    connection, _ = started
    await handle(
        model, connection, [{"type": "session.input_transcript.delta", "delta": "one", "start_ms": 0, "end_ms": 100}]
    )
    first_id = connection.user.content_id
    events = await handle(
        model,
        connection,
        [{"type": "session.input_transcript.delta", "delta": "two", "start_ms": 1200, "end_ms": 1300}],
    )
    assert events[0] == BidiTranscriptStopEvent("user", first_id)
    assert connection.user.content_id != first_id

    monkeypatch.setattr(openai_live, "_USER_SEGMENT_MAX_CHARS", 5)
    events = await handle(
        model,
        connection,
        [{"type": "session.input_transcript.delta", "delta": "three", "start_ms": 1300, "end_ms": 1400}],
    )
    assert events[-1] == BidiTranscriptStopEvent("user", unittest.mock.ANY)
    assert connection.user is None


@pytest.mark.asyncio
async def test_user_speech_over_assistant_emits_no_barge_in(model, started):
    connection, _ = started
    await handle(
        model,
        connection,
        [
            {"type": "session.output_transcript.delta", "delta": "Long answer", "start_ms": 0, "end_ms": 2000},
            {"type": "session.input_transcript.delta", "delta": "wait", "start_ms": 500, "end_ms": 700},
        ],
    )
    assert BidiBargeInEvent() not in model._tick(connection, now=0.5)


@pytest.mark.asyncio
async def test_uncorrelated_error_is_logged_and_non_fatal(model, started, caplog):
    connection, _ = started
    await handle(model, connection, [{"type": "session.output_audio.delta", "delta": SPEECH}])
    burst = connection.burst
    with caplog.at_level(logging.WARNING, logger=openai_live.__name__):
        events = await handle(
            model, connection, [{"type": "error", "error": {"type": "server_error", "code": "speech_cut_off"}}]
        )

    assert events == []
    assert connection.burst is burst
    assert connection.fatal is None
    assert "code=<speech_cut_off>" in caplog.text


@pytest.mark.asyncio
async def test_tool_group_emitted_at_completion(model, started):
    connection, _ = started
    usage = {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "input_tokens_details": {"cached_tokens": 4},
        "output_tokens_details": {"reasoning_tokens": 2},
    }
    events = await handle(
        model,
        connection,
        [
            created(),
            function_call("call_1"),
            function_call("call_2", name="other", arguments="{}"),
            completed(usage=usage),
        ],
    )
    exp_events = [
        BidiToolUseBlocksEvent(
            [
                {"toolUseId": "call_1", "name": "lookup", "input": {"id": "A1"}},
                {"toolUseId": "call_2", "name": "other", "input": {}},
            ]
        ),
        BidiUsageEvent(
            input_tokens=10,
            output_tokens=5,
            total_tokens=15,
            input_token_details={"cache_read": 4},
            output_token_details={"reasoning": 2},
        ),
    ]
    assert events == exp_events


@pytest.mark.asyncio
async def test_tool_group_without_delegation_id(model, started):
    connection, _ = started
    call = {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{}"}
    events = await handle(
        model,
        connection,
        [
            backend({"type": "response.created", "response": {"id": "resp_1"}}, delegation_id=None),
            backend({"type": "response.output_item.done", "item": call}, delegation_id=None),
            backend({"type": "response.completed", "response": {"id": "resp_1", "output": []}}, delegation_id=None),
        ],
    )
    assert events == [BidiToolUseBlocksEvent([{"toolUseId": "call_1", "name": "lookup", "input": {}}])]


@pytest.mark.asyncio
async def test_tool_results_send_one_continuation(model, started):
    connection, websocket = started
    await handle(model, connection, [created(), function_call("call_1"), function_call("call_2"), completed()])
    websocket.sent.clear()

    await model.send(BidiMessage(content=[tool_result("call_1", "first"), tool_result("call_2", "second")]))
    with pytest.raises(ValueError, match="unknown calls"):
        await model.send(BidiMessage(content=[tool_result("call_1", "first")]))

    tru_sent = [(payload["type"], payload.get("item")) for payload in websocket.sent]
    exp_sent = [
        ("response.item.create", {"type": "function_call_output", "call_id": "call_1", "output": "first"}),
        ("response.item.create", {"type": "function_call_output", "call_id": "call_2", "output": "second"}),
        ("response.create", None),
    ]
    assert tru_sent == exp_sent


@pytest.mark.asyncio
async def test_unknown_tool_result_raises_without_sending(model, started):
    _, websocket = started
    websocket.sent.clear()
    with pytest.raises(ValueError, match="unknown calls"):
        await model.send(BidiMessage(content=[tool_result("call_never_issued")]))
    assert websocket.sent == []


@pytest.mark.asyncio
async def test_malformed_arguments_get_error_output(model, started):
    connection, websocket = started
    events = await handle(
        model,
        connection,
        [created(), function_call("call_bad", arguments="{not json"), function_call("call_ok"), completed()],
    )
    assert events == [BidiToolUseBlocksEvent([{"toolUseId": "call_ok", "name": "lookup", "input": {"id": "A1"}}])]
    websocket.sent.clear()

    await model.send(BidiMessage(content=[tool_result("call_ok")]))

    tru_sent = [(payload["type"], (payload.get("item") or {}).get("call_id")) for payload in websocket.sent]
    exp_sent = [
        ("response.item.create", "call_ok"),
        ("response.item.create", "call_bad"),
        ("response.create", None),
    ]
    assert tru_sent == exp_sent


@pytest.mark.asyncio
async def test_only_malformed_arguments_continue_directly(model, started):
    connection, websocket = started
    websocket.sent.clear()
    events = await handle(model, connection, [created(), function_call("call_bad", arguments="[1]"), completed()])

    assert events == []
    assert websocket.sent_types() == ["response.item.create", "response.create"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        {"type": "response.failed", "response": {"id": "resp_1", "error": {"code": "server_error"}}},
        {"type": "response.incomplete", "response": {"id": "resp_1"}},
        {"type": "error", "code": "server_error", "message": "x"},
    ],
)
async def test_failed_backend_response_delivers_result_as_commentary(model, started, failure):
    connection, websocket = started
    await handle(model, connection, [created(), function_call("call_1"), completed()])
    await handle(model, connection, [backend(failure)])
    websocket.sent.clear()

    await model.send(BidiMessage(content=[tool_result("call_1", "Order shipped")]))
    assert websocket.sent == []

    await model._flush_late_results(connection, now=0.0)
    tru_sent = websocket.sent
    exp_sent = [
        {
            "type": "session.commentary.append",
            "event_id": unittest.mock.ANY,
            "delegation_id": None,
            "content": "Result of lookup (already completed; do not call it again): Order shipped",
        }
    ]
    assert tru_sent == exp_sent
    assert model._groups == {}


@pytest.mark.asyncio
async def test_late_result_waits_for_idle(model, started):
    connection, websocket = started
    await handle(model, connection, [created(), function_call("call_1"), completed()])
    await handle(model, connection, [backend({"type": "response.failed", "response": {"id": "resp_1"}})])
    await model.send(BidiMessage(content=[tool_result("call_1")]))
    await handle(model, connection, [{"type": "session.output_audio.delta", "delta": SPEECH}])
    websocket.sent.clear()
    queued_at = model._late_results[0].queued_at

    await model._flush_late_results(connection, now=queued_at + 1)
    assert websocket.sent == []

    await model._flush_late_results(connection, now=queued_at + 30)
    assert websocket.sent_types() == ["session.commentary.append"]


@pytest.mark.asyncio
async def test_rejected_tool_result_command_delivers_commentary(model, started):
    connection, websocket = started
    await handle(model, connection, [created(), function_call("call_1"), completed()])
    await model.send(BidiMessage(content=[tool_result("call_1", "ok")]))
    item_event_id = websocket.sent_of("response.item.create")[0]["event_id"]

    await handle(
        model,
        connection,
        [{"type": "error", "error": {"code": "invalid_value", "client_event_id": item_event_id, "message": "x"}}],
    )
    websocket.sent.clear()
    await model._flush_late_results(connection, now=0.0)

    assert websocket.sent_types() == ["session.commentary.append"]


@pytest.mark.asyncio
async def test_user_message_routes_to_backend(model, started):
    _, websocket = started
    websocket.sent.clear()

    await model.send(
        BidiMessage(content=[TextBlock("What is this?"), ImageBlock(format="png", source={"bytes": b"img"})])
    )

    tru_sent = websocket.sent
    exp_sent = [
        {
            "type": "response.item.create",
            "event_id": unittest.mock.ANY,
            "item": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "What is this?"},
                    {"type": "input_image", "image_url": f"data:image/png;base64,{base64.b64encode(b'img').decode()}"},
                ],
            },
        },
        {"type": "response.create", "event_id": unittest.mock.ANY},
    ]
    assert tru_sent == exp_sent


@pytest.mark.asyncio
async def test_user_message_waits_for_pending_tools(model, started):
    connection, websocket = started
    await handle(model, connection, [created(), function_call("call_1"), completed()])
    websocket.sent.clear()

    await model.send(BidiMessage(content=[TextBlock("Order A0042")]))
    assert websocket.sent_types() == ["response.item.create"]

    await model.send(BidiMessage(content=[tool_result("call_1")]))
    assert websocket.sent_types() == ["response.item.create", "response.item.create", "response.create"]


@pytest.mark.asyncio
async def test_send_audio(model, started):
    _, websocket = started
    websocket.sent.clear()
    await model.send(AudioDelta(format="pcm", source={"bytes": b"\x00\x01"}))
    assert websocket.sent == [{"type": "session.input_audio.append", "audio": base64.b64encode(b"\x00\x01").decode()}]


@pytest.mark.asyncio
async def test_send_rejects_unsupported_content(model, started):
    with pytest.raises(ValueError, match="not supported"):
        await model.send(BidiMessage(content=[object()]))


@pytest.mark.asyncio
async def test_send_before_start(model):
    with pytest.raises(RuntimeError, match="not started"):
        await model.send(AudioDelta(format="pcm", source={"bytes": b"\x00"}))


@pytest.mark.asyncio
async def test_usage_seconds_replaced_not_summed(model, started):
    connection, _ = started
    await handle(
        model,
        connection,
        [
            {"type": "session.usage.updated", "usage": {"seconds": 12}, "context_window": {"usage_ratio": 0.6}},
            {"type": "session.usage.updated", "usage": {"seconds": 15}, "context_window": {"usage_ratio": 0.2}},
        ],
    )
    assert model.usage_seconds == 15


@pytest.mark.asyncio
async def test_usage_seconds_accumulates_across_restarts(model, sockets):
    await model.start()
    await handle(model, model._connection, [{"type": "session.usage.updated", "usage": {"seconds": 10}}])

    await model.restart()
    try:
        await handle(model, model._connection, [{"type": "session.usage.updated", "usage": {"seconds": 4}}])
        assert model.usage_seconds == 42.5 + 4
    finally:
        await model.stop()
    assert model.usage_seconds == 42.5 + 42.5

    await model.start()
    try:
        assert model.usage_seconds == 0
    finally:
        await model.stop()


@pytest.mark.asyncio
async def test_receive_yields_connection_start(model, started):
    receiver = model.receive()
    assert await anext(receiver) == BidiConnectionStartEvent(connection_id="sess_1", model="gpt-live-1")
    await receiver.aclose()


@pytest.mark.parametrize(
    ("reason", "exp_error"),
    [
        ("expired", ConnectionTimeoutError),
        ("connection_lost", ConnectionTimeoutError),
        ("content", ConnectionClosedError),
        ("remote_hangup", ConnectionClosedError),
        ("close_requested", ConnectionClosedError),
    ],
)
@pytest.mark.asyncio
async def test_receive_close_reasons(model, started, reason, exp_error):
    connection, websocket = started
    websocket.push({"type": "session.output_audio.delta", "delta": SPEECH})
    websocket.push({"type": "session.closed", "reason": reason, "usage": {"seconds": 3}})

    events = []
    with pytest.raises(exp_error, match=reason):
        async for event in model.receive():
            events.append(event)

    assert isinstance(events[-1], BidiResponseStopEvent)
    assert model.usage_seconds == 3


@pytest.mark.asyncio
async def test_receive_socket_loss_is_restartable(model, started):
    _, websocket = started
    websocket.drop()
    with pytest.raises(ConnectionTimeoutError, match="socket_closed"):
        async for _ in model.receive():
            pass


@pytest.mark.asyncio
async def test_receive_malformed_frame(model, started):
    _, websocket = started
    websocket.incoming.put_nowait("{not json")
    with pytest.raises(ValueError, match="malformed"):
        async for _ in model.receive():
            pass


@pytest.mark.asyncio
async def test_receive_backend_validation_failure_is_fatal(model, started):
    _, websocket = started
    websocket.push(
        {"type": "error", "error": {"code": "responses_validation_failed", "param": "tools", "message": "bad tool"}}
    )
    with pytest.raises(ValueError, match=r"code=<responses_validation_failed>, param=<tools>"):
        async for _ in model.receive():
            pass
    assert "session.close" in websocket.sent_types()


@pytest.mark.asyncio
async def test_receive_session_rate_limit(model, started):
    _, websocket = started
    websocket.push({"type": "error", "error": {"code": "rate_limit_exceeded", "message": "slow down"}})
    with pytest.raises(ModelThrottledException):
        async for _ in model.receive():
            pass


@pytest.mark.asyncio
async def test_stop_waits_for_session_closed(model, sockets):
    await model.start()
    websocket = sockets[0]

    await model.stop()
    await model.stop()

    assert websocket.sent_types().count("session.close") == 1
    assert websocket.closed
    assert model.usage_seconds == 42.5
    assert model._connection_id is None


@pytest.mark.asyncio
async def test_stop_timeout_marks_finalization_unconfirmed(caplog, monkeypatch):
    monkeypatch.setattr(openai_live, "_CLOSE_TIMEOUT_S", 0.05)
    websocket = FakeWebSocket(close_reason=None)
    websocket.push(started_event())
    model = OpenAILiveModel(model_id="gpt-live-1", backend_model_id="b", api_key="k")
    with unittest.mock.patch.object(
        openai_live.websockets, "connect", new=unittest.mock.AsyncMock(return_value=websocket)
    ):
        await model.start()

    with caplog.at_level(logging.WARNING, logger=openai_live.__name__):
        await model.stop()

    assert "finalization unconfirmed" in caplog.text
    assert websocket.closed


@pytest.mark.asyncio
async def test_stop_while_reader_active(model, started):
    connection, _ = started
    receiver = model.receive()
    await anext(receiver)
    reader = asyncio.create_task(anext(receiver))
    await asyncio.sleep(0.05)

    await model.stop()

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(reader, timeout=1)
    assert connection.close_reason == "close_requested"


@pytest.mark.asyncio
async def test_restart_delivers_old_result_as_commentary(model, sockets, tool_spec):
    await model.start(tools=[tool_spec])
    await handle(model, model._connection, [created(), function_call("call_1"), completed()])
    messages = [{"role": "user", "content": [{"text": "Where is my order?"}]}]

    await model.restart(tools=[tool_spec], messages=messages)
    try:
        new_socket = sockets[-1]
        tru_input = new_socket.sent[0]["session"]["input"]
        exp_input = [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Where is my order?"}]},
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": _RESTART_INSTRUCTION}]},
        ]
        assert tru_input == exp_input
        assert sockets[0].closed

        await model.send(BidiMessage(content=[tool_result("call_1", "Shipped")]))
        await model._flush_late_results(model._connection, now=0.0)
        assert new_socket.sent_types() == ["session.start", "session.commentary.append"]
    finally:
        await model.stop()


def test_format_history():
    messages = [
        {"role": "user", "content": [{"text": "Book Friday"}]},
        {"role": "user", "content": [{"text": "at 2pm"}]},
        {
            "role": "assistant",
            "content": [{"reasoningContent": {"reasoningText": {"text": "thinking"}}}],
            "metadata": {"custom": {"bidi": {"kind": "reasoning", "status": "complete"}}},
        },
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "c1", "name": "book", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "c1", "status": "success", "content": [{"text": "started"}]}}],
            "metadata": {"custom": {"bidi": {"kind": "tool_dispatch"}}},
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "c1", "status": "success", "content": [{"json": {"ok": 1}}]}}],
            "metadata": {"custom": {"bidi": {"kind": "tool_result"}}},
        },
        {
            "role": "assistant",
            "content": [{"text": "[Transcript unavailable.]"}],
            "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "incomplete"}}},
        },
        {
            "role": "assistant",
            "content": [{"text": "You're booked."}],
            "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "complete"}}},
        },
        {"role": "user", "content": [{"image": {"format": "png", "source": {"bytes": b""}}}]},
    ]

    tru_input = _format_history(messages, restart=False)
    exp_input = [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Book Friday\nat 2pm"}]},
        {
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": 'Backend result for book: {"ok": 1}'}],
        },
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "You're booked."}]},
    ]
    assert tru_input == exp_input


def test_format_history_budget_keeps_newest(monkeypatch):
    monkeypatch.setattr(openai_live, "_HISTORY_MAX_MESSAGES", 2)
    messages = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": [{"text": f"m{index}"}]} for index in range(5)
    ]
    tru_texts = [item["content"][0]["text"] for item in _format_history(messages, restart=True)]
    assert tru_texts == ["m3", "m4", _RESTART_INSTRUCTION]

    monkeypatch.setattr(openai_live, "_HISTORY_MAX_MESSAGES", 127)
    monkeypatch.setattr(openai_live, "_HISTORY_MAX_TOKENS", 1)
    assert _format_history(messages, restart=False) == [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "m4"}]}
    ]


def test_handled_events_exist_in_openai_live_types(model):
    assert set(model._server_handlers) <= LIVE_SERVER_EVENTS


@pytest.mark.asyncio
async def test_logs_exclude_sensitive_content(model, started, caplog):
    connection, _ = started
    with caplog.at_level(logging.DEBUG, logger=openai_live.__name__):
        await handle(
            model,
            connection,
            [
                {"type": "session.input_transcript.delta", "delta": "my card is 4111", "start_ms": 0, "end_ms": 9},
                created(),
                function_call("call_1", arguments='{"ssn": "123-45-6789"}'),
                function_call("call_2", arguments="{secret-broken"),
                completed(),
            ],
        )
        await model.send(BidiMessage(content=[tool_result("call_1", "balance 900")]))

    for secret in ("sk-secret-key", "4111", "123-45-6789", "secret-broken", "balance 900"):
        assert secret not in caplog.text


@pytest.mark.asyncio
async def test_agent_runs_delegated_tool(sockets, mock_connect):
    @tool
    def lookup(id: str) -> str:
        """Look up an order.

        Args:
            id: Order ID.
        """
        return f"order {id} shipped"

    model = OpenAILiveModel(model_id="gpt-live-1", backend_model_id="gpt-6-luna", api_key="k")
    agent = BidiAgent(model=model, tools=[lookup], system_prompt="Voice prompt")
    await agent.start()
    try:
        websocket = sockets[0]
        for event in (created(), function_call("call_1", arguments='{"id": "A1"}'), completed()):
            websocket.push(event)

        async def run_until_continued():
            async for event in agent.receive():
                if isinstance(event, ToolResultMessageEvent):
                    break
            while "response.create" not in websocket.sent_types():
                await asyncio.sleep(0.01)

        await asyncio.wait_for(run_until_continued(), timeout=5)

        outputs = websocket.sent_of("response.item.create")
        assert outputs[0]["item"] == {"type": "function_call_output", "call_id": "call_1", "output": "order A1 shipped"}
        assert websocket.sent[0]["session"]["instructions"] == "Voice prompt"
    finally:
        await agent.stop()


def test_exported_from_experimental_package_only():
    import strands.bidi.models as stable_models
    import strands.experimental.bidi.models as experimental_models

    assert experimental_models.OpenAILiveModel is OpenAILiveModel
    assert experimental_models.ConnectionClosedError is ConnectionClosedError
    assert not hasattr(stable_models, "OpenAILiveModel")
    assert not hasattr(stable_models, "ConnectionClosedError")
