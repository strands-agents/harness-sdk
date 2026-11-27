"""Tests for OpenAI Live configuration, transport, and event conversion."""

import asyncio
import itertools
import json
from importlib import import_module
from unittest.mock import AsyncMock, MagicMock, call

import pytest
import pytest_asyncio

from strands.bidi.models.model import AudioCapable, ConnectionTimeoutError, Restartable
from strands.bidi.types import (
    AudioDelta,
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiConnectionStartEvent,
    BidiConnectionStopEvent,
    BidiMessage,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTextDeltaEvent,
    BidiTextStartEvent,
    BidiTextStopEvent,
    BidiToolUseBlocksEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
)
from strands.types.content import TextBlock
from strands.types.exceptions import ModelThrottledException
from strands.types.media import AudioBlock, ImageBlock
from strands.types.tools import ToolResultBlock

pytest.importorskip("openai.resources.live.live", exc_type=ImportError)
live = import_module("strands.bidi.models.openai.live")


def server_event(event_type, **fields):
    return live.AsyncLiveConnection.parse_event(
        None, json.dumps({"type": event_type, "event_id": "event_test", **fields})
    )


def response_event(event_type, *, delegation_id="delegation", **fields):
    return server_event("response.event", delegation_id=delegation_id, event={"type": event_type, **fields})


def session_closed(reason="close_requested"):
    return server_event("session.closed", reason=reason, session={"id": "session_test"}, usage={"seconds": 2})


@pytest.fixture
def connection():
    connection = AsyncMock()
    connection.recv.return_value = session_closed()
    return connection


@pytest.fixture
def client(monkeypatch, connection):
    client = MagicMock()
    client.live.connect.return_value.enter = AsyncMock(return_value=connection)
    client.live.forks.connect.return_value.enter = AsyncMock(return_value=connection)
    constructor = MagicMock(return_value=client)
    monkeypatch.setattr(live, "AsyncOpenAI", constructor)
    return client


@pytest.fixture
def model(client, monkeypatch, recwarn):
    identifiers = itertools.count(1)
    monkeypatch.setattr(live, "uuid4", lambda: f"id-{next(identifiers)}")
    return live.OpenAILiveModel(
        model_id="live-model",
        delegation_config={"type": "responses", "model_id": "responses-model"},
        client_args={"api_key": "test"},
    )


@pytest_asyncio.fixture
async def started_model(model, connection, alist):
    await model.start()
    connection.recv.return_value = server_event(
        "session.started", session={"id": "session_test", "model": "live-model"}
    )
    await alist(model._receive())
    connection.recv.return_value = session_closed()
    connection.reset_mock()
    return model


@pytest.fixture
def tool_spec():
    return {
        "name": "calculate",
        "description": "Calculate a result",
        "inputSchema": {"json": {"type": "object", "properties": {"value": {"type": "number"}}}},
    }


def test__init__(model, client, recwarn):
    live.AsyncOpenAI.assert_called_once_with(api_key="test")
    client.live.connect.assert_not_called()
    assert isinstance(model, AudioCapable)
    assert isinstance(model, Restartable)
    warning = recwarn.pop(UserWarning)
    assert str(warning.message) == "OpenAILiveModel is experimental and may change in future versions."
    assert warning.filename == __file__

    tru_config = model.get_config()
    exp_config = {"model_id": "live-model", "connection": {"auto_restart": False}}
    assert tru_config == exp_config


def test_get_config_returns_copy(model):
    config = model.get_config()
    config["connection"]["auto_restart"] = True

    tru_config = model.get_config()
    exp_config = {"model_id": "live-model", "connection": {"auto_restart": False}}
    assert tru_config == exp_config


def test_update_config_merges_nested_settings(model):
    model.update_config(model_id="another-live-model", connection={"restart_after_s": 60})
    model.update_config(connection={"auto_restart": True})

    tru_config = model.get_config()
    exp_config = {
        "model_id": "another-live-model",
        "connection": {"auto_restart": True, "restart_after_s": 60},
    }
    assert tru_config == exp_config


@pytest.mark.asyncio
async def test_update_config_requires_stopped_model(started_model):
    with pytest.raises(RuntimeError, match="Stop OpenAI Live"):
        started_model.update_config(model_id="another-live-model")

    await started_model.stop()
    started_model.update_config(model_id="another-live-model")
    assert started_model.model_id == "another-live-model"


@pytest.mark.parametrize(("audio_config", "sample_rate"), [(None, 24000), ({"sample_rate": 16000}, 16000)])
def test_get_audio_config(client, audio_config, sample_rate):
    model = live.OpenAILiveModel(
        model_id="live-model",
        delegation_config={"type": "responses", "model_id": "responses-model"},
        audio_config=audio_config,
    )

    tru_config = model.get_audio_config()
    exp_config = {
        "input": {"format": "pcm", "sample_rate": sample_rate, "channels": 1},
        "output": {"format": "pcm", "sample_rate": sample_rate, "channels": 1},
    }
    assert tru_config == exp_config


@pytest.mark.asyncio
async def test_start_uses_defaults_and_ignores_params(model, client, connection):
    model.update_config(params={"model": "ignored", "store": False, "instructions": "ignored"})
    await model.start()

    client.live.connect.assert_called_once_with(max_retries=0)
    client.live.connect.return_value.enter.assert_awaited_once()
    connection.recv.assert_not_awaited()
    connection.session.start.assert_awaited_once_with(
        session={
            "model": "live-model",
            "store": True,
            "audio": {"format": {"type": "audio/pcm", "rate": 24000}},
            "input": [],
            "delegation": {"type": "responses", "responses": {"model": "responses-model", "tools": []}},
        }
    )
    assert model._started
    assert not model._state.send_gate.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("voice", ["marin", {"id": "custom_voice"}])
@pytest.mark.parametrize("delegation_prompt", [None, "Backend instructions"])
async def test_start_configures_audio_delegation_and_history(client, connection, tool_spec, voice, delegation_prompt):
    model = live.OpenAILiveModel(
        model_id="live-model",
        voice=voice,
        audio_config={"sample_rate": 16000},
        delegation_config={
            "type": "responses",
            "model_id": "responses-model",
            "max_output_tokens": 512,
            "reasoning": {"effort": "low"},
            "text": {"verbosity": "low"},
            "service_tier": "auto",
            **({"system_prompt": delegation_prompt} if delegation_prompt else {}),
        },
    )
    await model.start(
        system_prompt="Voice instructions",
        tools=[tool_spec],
        messages=[
            {"role": "user", "content": [{"text": "First fragment"}, {"text": "Second fragment"}]},
            {"role": "assistant", "content": [{"text": "Answer"}, {"toolUse": {"toolUseId": "old"}}]},
            {"role": "user", "content": [{"image": {"format": "png", "source": {"bytes": b"image"}}}]},
        ],
    )

    connection.session.start.assert_awaited_once_with(
        session={
            "model": "live-model",
            "store": True,
            "instructions": "Voice instructions",
            "audio": {"format": {"type": "audio/pcm", "rate": 16000}, "output": {"voice": voice}},
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "First fragment\nSecond fragment"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "Answer"}]},
            ],
            "delegation": {
                "type": "responses",
                "responses": {
                    "model": "responses-model",
                    "instructions": delegation_prompt or "Voice instructions",
                    "max_output_tokens": 512,
                    "reasoning": {"effort": "low"},
                    "text": {"verbosity": "low"},
                    "service_tier": "auto",
                    "tools": [
                        {
                            "type": "function",
                            "name": tool_spec["name"],
                            "description": tool_spec["description"],
                            "parameters": tool_spec["inputSchema"]["json"],
                            "strict": False,
                        }
                    ],
                },
            },
        }
    )


@pytest.mark.asyncio
async def test_start_failure_leaves_cleanup_to_caller(model, connection):
    connection.session.start.side_effect = RuntimeError("start failed")

    with pytest.raises(RuntimeError, match="start failed"):
        await model.start()

    connection.close.assert_not_awaited()
    assert not model._started
    await model.stop()
    connection.close.assert_awaited_once()
    connection.session.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_restart_forks_saved_session(started_model, client, connection):
    fork = AsyncMock()
    client.live.forks.connect.return_value.enter.return_value = fork
    await started_model.restart(system_prompt="Ignored", messages=[{"role": "user", "content": [{"text": "Ignored"}]}])

    connection.session.close.assert_awaited_once()
    connection.close.assert_awaited_once()
    client.live.forks.connect.assert_called_once_with(session_id="session_test", max_retries=0)
    fork.session.start.assert_awaited_once_with(session={"audio": {"format": {"type": "audio/pcm", "rate": 24000}}})
    fork.recv.assert_not_awaited()
    assert started_model._started
    assert not started_model._state.send_gate.is_set()
    assert started_model._state.connection_id == ""


@pytest.mark.asyncio
async def test_restart_sends_pending_tool_results_to_fork(started_model, client, connection, alist):
    started_model._state.pending_tools.update({"call_a", "call_b", "call_c"})
    await started_model.send(BidiMessage([ToolResultBlock("call_a", "success", [{"text": "call_a"}])]))
    previous_state = started_model._state

    fork = AsyncMock()
    client.live.forks.connect.return_value.enter.return_value = fork
    await started_model.restart()
    fork.recv.return_value = server_event("session.started", session={"id": "session_fork", "model": "live-model"})
    await alist(started_model._receive())

    for call_id in ("call_b", "call_c"):
        fork.response.create.assert_not_awaited()
        await started_model.send(BidiMessage([ToolResultBlock(call_id, "success", [{"text": call_id}])]))

    tru_calls = fork.response.mock_calls
    exp_calls = [
        call.item.create(
            item={
                "type": "function_call_output",
                "call_id": call_id,
                "output": [
                    {"type": "input_text", "text": '{"status": "success"}'},
                    {"type": "input_text", "text": call_id},
                ],
            }
        )
        for call_id in ("call_b", "call_c")
    ]
    exp_calls.append(call.create())
    assert tru_calls == exp_calls
    assert not started_model._state.pending_tools

    tru_pending = previous_state.pending_tools
    exp_pending = {"call_b", "call_c"}
    assert tru_pending == exp_pending
    connection.response.item.create.assert_awaited_once()
    connection.response.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_restart_requires_session_id(model, client):
    with pytest.raises(RuntimeError, match="session ID"):
        await model.restart()

    client.live.forks.connect.assert_not_called()


@pytest.mark.asyncio
async def test_restart_failure_does_not_replay_history(started_model, client, connection):
    client.live.forks.connect.return_value.enter.side_effect = ConnectionError("fork failed")

    with pytest.raises(ConnectionError, match="fork failed"):
        await started_model.restart()

    connection.close.assert_awaited_once()
    client.live.connect.assert_called_once()
    assert not started_model._started


@pytest.mark.asyncio
async def test_stop_before_start_is_idempotent(model, connection):
    await model.stop()
    await model.stop()

    connection.close.assert_not_awaited()
    assert not model._started


@pytest.mark.asyncio
async def test_stop_drains_acknowledgement_and_is_idempotent(started_model, connection):
    connection.recv.side_effect = [
        server_event("session.usage.updated", usage={"seconds": 2}),
        session_closed(),
    ]
    await started_model.stop()
    await started_model.stop()

    tru_calls = connection.mock_calls
    exp_calls = [call.session.close(), call.recv(), call.recv(), call.close()]
    assert tru_calls == exp_calls
    assert started_model._connection is None
    assert started_model._state.closed
    assert not started_model._started


@pytest.mark.asyncio
async def test_stop_cancels_receiver_before_reading_acknowledgement(started_model, connection, alist):
    receiving = asyncio.Event()

    async def recv():
        if not connection.session.close.await_count:
            receiving.set()
            await asyncio.Future()
        return session_closed()

    connection.recv.side_effect = recv
    receiver = asyncio.create_task(alist(started_model.receive()))
    await receiving.wait()
    await started_model.stop()

    assert receiver.cancelled()
    assert started_model._state.receive_task is None
    connection.session.close.assert_awaited_once()
    connection.close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["session.close", "recv", "close"])
async def test_stop_attempts_connection_cleanup_after_error(started_model, connection, operation):
    operation_mock = connection
    for attribute in operation.split("."):
        operation_mock = getattr(operation_mock, attribute)
    operation_mock.side_effect = RuntimeError("cleanup failed")

    with pytest.raises(RuntimeError, match="cleanup failed"):
        await started_model.stop()

    connection.close.assert_awaited_once()
    assert started_model._connection is None
    assert started_model._state.closed
    assert not started_model._started


@pytest.mark.asyncio
async def test_send_waits_for_session_acknowledgement(model, connection, alist):
    await model.start()
    sender = asyncio.create_task(model.send(BidiMessage([TextBlock("Hello")])))
    try:
        await asyncio.sleep(0)
        connection.response.item.create.assert_not_awaited()
        connection.recv.return_value = server_event(
            "session.started", session={"id": "session_test", "model": "live-model"}
        )

        tru_events = await alist(model._receive())
        exp_events = [BidiConnectionStartEvent(connection_id="session_test", model="live-model")]
        assert tru_events == exp_events
        await sender
        connection.response.create.assert_awaited_once()
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)


@pytest.mark.asyncio
async def test_send_text_images_and_audio(started_model, connection):
    await started_model.send(
        BidiMessage([TextBlock("Look"), ImageBlock("png", {"bytes": b"image"}), TextBlock("Describe")])
    )
    await started_model.send(AudioDelta("pcm", {"bytes": b"\x00\x01"}))

    tru_calls = connection.mock_calls
    exp_calls = [
        call.response.item.create(
            item={
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Look"},
                    {"type": "input_image", "image_url": "data:image/png;base64,aW1hZ2U=", "detail": "auto"},
                    {"type": "input_text", "text": "Describe"},
                ],
            }
        ),
        call.response.create(),
        call.session.input_audio.append(audio="AAE="),
    ]
    assert tru_calls == exp_calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content", "message"),
    [
        (AudioDelta("mp3", {"bytes": b"audio"}), "raw PCM16 bytes"),
        (AudioDelta("pcm", {"uri": "file:///audio.pcm"}), "raw PCM16 bytes"),
        (BidiMessage([]), "must not be empty"),
        (BidiMessage([AudioBlock("mp3", {"bytes": b"audio"})]), "received AudioBlock"),
        (BidiMessage([ImageBlock("png", {"url": "https://example.com/image.png"})]), "received ImageBlock"),
    ],
)
async def test_send_rejects_unsupported_content(started_model, connection, content, message):
    with pytest.raises(ValueError, match=message):
        await started_model.send(content)

    connection.response.item.create.assert_not_awaited()
    connection.response.create.assert_not_awaited()
    connection.session.input_audio.append.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["success", "error"])
async def test_send_tool_result_media_and_user_content(started_model, connection, status):
    started_model._state.pending_tools.add("call_test")
    result = ToolResultBlock(
        "call_test",
        status,
        [
            {"text": "Answer"},
            {"json": {"value": 4}},
            {"image": {"format": "png", "source": {"bytes": b"image"}}},
            {"document": {"name": "report", "format": "pdf", "source": {"bytes": b"document"}}},
        ],
    )
    await started_model.send(BidiMessage([TextBlock("Follow up"), result]))

    tru_calls = connection.mock_calls
    exp_calls = [
        call.response.item.create(
            item={
                "type": "function_call_output",
                "call_id": "call_test",
                "output": [
                    {"type": "input_text", "text": json.dumps({"status": status})},
                    {"type": "input_text", "text": "Answer"},
                    {"type": "input_text", "text": '{"value": 4}'},
                    {"type": "input_image", "image_url": "data:image/png;base64,aW1hZ2U="},
                    {
                        "type": "input_file",
                        "filename": "report.pdf",
                        "file_data": "data:application/pdf;base64,ZG9jdW1lbnQ=",
                    },
                ],
            }
        ),
        call.response.item.create(
            item={"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Follow up"}]}
        ),
        call.response.create(),
    ]
    assert tru_calls == exp_calls
    assert not started_model._state.pending_tools


@pytest.mark.asyncio
async def test_send_waits_for_all_pending_tool_results(started_model, connection):
    started_model._state.pending_tools.update({"call_a", "call_b"})
    await started_model.send(BidiMessage([ToolResultBlock("call_b", "success", [{"text": "Second result"}])]))
    await started_model.send(BidiMessage([TextBlock("Also explain the answer")]))
    connection.response.create.assert_not_awaited()

    await started_model.send(BidiMessage([ToolResultBlock("call_a", "success", [{"text": "First result"}])]))
    connection.response.create.assert_awaited_once()
    assert not started_model._state.pending_tools

    with pytest.raises(ValueError, match="match pending"):
        await started_model.send(BidiMessage([ToolResultBlock("unknown", "success", [])]))

    assert connection.response.item.create.await_count == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "part",
    [
        {"video": {"format": "mp4", "source": {"bytes": b"video"}}},
        {"image": {"format": "png", "source": {"url": "https://example.com/image.png"}}},
        {"document": {"format": "pdf", "source": {"s3Location": {"uri": "s3://bucket/file.pdf"}}}},
    ],
)
async def test_send_rejects_unsupported_tool_result(started_model, connection, part):
    started_model._state.pending_tools.add("call_test")
    with pytest.raises(ValueError, match="only accepts text, JSON, images, and documents"):
        await started_model.send(BidiMessage([ToolResultBlock("call_test", "success", [part])]))

    connection.response.item.create.assert_not_awaited()
    assert started_model._state.pending_tools == {"call_test"}


@pytest.mark.asyncio
async def test_send_serializes_messages_without_blocking_audio(started_model, connection):
    item_started = asyncio.Event()
    release_item = asyncio.Event()

    async def create_item(**kwargs):
        item_started.set()
        await release_item.wait()

    connection.response.item.create.side_effect = create_item
    first = asyncio.create_task(started_model.send(BidiMessage([TextBlock("First")])))
    await item_started.wait()
    second = asyncio.create_task(started_model.send(BidiMessage([TextBlock("Second")])))
    try:
        await started_model.send(AudioDelta("pcm", {"bytes": b"\x00\x00"}))
        assert connection.response.item.create.await_count == 1
        connection.response.create.assert_not_awaited()
        connection.session.input_audio.append.assert_awaited_once_with(audio="AAA=")
        release_item.set()
        await asyncio.gather(first, second)
    finally:
        first.cancel()
        second.cancel()
        await asyncio.gather(first, second, return_exceptions=True)

    tru_calls = [entry[0] for entry in connection.mock_calls]
    exp_calls = [
        "response.item.create",
        "session.input_audio.append",
        "response.create",
        "response.item.create",
        "response.create",
    ]
    assert tru_calls == exp_calls


@pytest.mark.asyncio
async def test_receive_streams_events_until_cancelled(started_model, connection):
    connection.recv.return_value = server_event("session.input_transcript.delta", delta="Hello", start_ms=0, end_ms=100)
    receiver = started_model.receive()
    try:
        tru_events = [await anext(receiver) for _ in range(3)]
        exp_events = [
            BidiTranscriptStartEvent(role="user", content_id="id-1"),
            BidiTranscriptDeltaEvent(delta="Hello", role="user", content_id="id-1"),
            BidiTranscriptStopEvent(role="user", content_id="id-1"),
        ]
        assert tru_events == exp_events
        connection.recv.assert_awaited_once()
    finally:
        await receiver.aclose()

    assert started_model._state.receive_task is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("code", "error_type"),
    [("rate_limit_exceeded", ModelThrottledException), ("invalid_request", RuntimeError)],
)
async def test_receive_session_error(started_model, connection, alist, code, error_type):
    connection.recv.return_value = server_event("error", error={"code": code, "message": "Request rejected"})

    with pytest.raises(error_type, match="Request rejected"):
        await alist(started_model.receive())

    assert started_model._state.receive_task is None


@pytest.mark.asyncio
async def test_receive_preserves_client_exception(started_model, connection, alist):
    error = ConnectionError("Disconnected")
    connection.recv.side_effect = error

    with pytest.raises(ConnectionError) as caught:
        await alist(started_model.receive())

    assert caught.value is error
    assert started_model._state.receive_task is None


@pytest.mark.parametrize(("reason", "error_type"), [("expired", ConnectionTimeoutError), ("failed", ConnectionError)])
def test__to_strands_connection_stop_event_unexpected_reason(model, reason, error_type):
    with pytest.raises(error_type):
        list(model._to_strands_events(session_closed(reason)))

    assert model._state.closed


@pytest.mark.parametrize(
    "event",
    [
        server_event("session.usage.updated", usage={"seconds": 2}),
        server_event("session.delegation.created", delegation={"id": "delegation", "target": "responses"}),
        response_event("response.output_text.delta", item_id="unknown", content_index=0, delta="Ignored"),
    ],
)
def test__to_strands_events_ignores_unhandled_events(model, event):
    tru_events = list(model._to_strands_events(event))
    exp_events = []
    assert tru_events == exp_events


@pytest.mark.parametrize("role", ["user", "assistant"])
def test__to_strands_transcript_delta_event_closes_each_fragment(model, role):
    event_type = "session.input_transcript.delta" if role == "user" else "session.output_transcript.delta"
    events = [server_event(event_type, delta=delta, start_ms=0, end_ms=100) for delta in ("Hello", " there")]

    tru_events = [output for event in events for output in model._to_strands_events(event)]
    second_id = "id-2" if role == "user" else "id-3"
    exp_events = [
        *([BidiResponseStartEvent("id-2")] if role == "assistant" else []),
        BidiTranscriptStartEvent(role=role, content_id="id-1"),
        BidiTranscriptDeltaEvent(delta="Hello", role=role, content_id="id-1"),
        BidiTranscriptStopEvent(role=role, content_id="id-1"),
        BidiTranscriptStartEvent(role=role, content_id=second_id),
        BidiTranscriptDeltaEvent(delta=" there", role=role, content_id=second_id),
        BidiTranscriptStopEvent(role=role, content_id=second_id),
    ]
    assert tru_events == exp_events


def test__to_strands_events_orders_audio_and_backend_boundaries(model):
    events = [
        server_event("session.started", session={"id": "session_test", "model": "live-model"}),
        server_event("session.output_audio.delta", delta="AAA="),
        response_event("response.created", response={"id": "response_test"}),
        response_event("response.output_text.delta", item_id="text", content_index=0, delta="Answer"),
        server_event("session.output_audio.delta", delta="AAE="),
        response_event("response.completed", response={"id": "response_test"}),
        server_event("session.output_audio.delta", delta="AAI="),
        session_closed(),
    ]

    tru_events = [output for event in events for output in model._to_strands_events(event)]
    exp_events = [
        BidiConnectionStartEvent(connection_id="session_test", model="live-model"),
        BidiResponseStartEvent("id-1"),
        BidiAudioStartEvent("id-2"),
        BidiAudioDeltaEvent(audio="AAA=", format="pcm", sample_rate=24000, channels=1, content_id="id-2"),
        BidiAudioStopEvent("id-2"),
        BidiResponseStopEvent("id-1"),
        BidiResponseStartEvent("id-3"),
        BidiTextStartEvent("id-4"),
        BidiTextDeltaEvent(delta="Answer", content_id="id-4"),
        BidiAudioStartEvent("id-5"),
        BidiAudioDeltaEvent(audio="AAE=", format="pcm", sample_rate=24000, channels=1, content_id="id-5"),
        BidiTextStopEvent("id-4"),
        BidiAudioDeltaEvent(audio="AAI=", format="pcm", sample_rate=24000, channels=1, content_id="id-5"),
        BidiAudioStopEvent("id-5"),
        BidiResponseStopEvent("id-3"),
        BidiConnectionStopEvent(connection_id="session_test", reason="user_request"),
    ]
    assert tru_events == exp_events
    assert not model._state.delegations


def test__to_strands_response_events_preserves_interleaved_text(model):
    events = [
        response_event("response.created", delegation_id="a", response={"id": "response_a"}),
        response_event("response.created", delegation_id="b", response={"id": "response_b"}),
        response_event(
            "response.output_text.delta", delegation_id="a", item_id="text_a", content_index=0, delta="First"
        ),
        response_event(
            "response.output_text.delta", delegation_id="b", item_id="text_b", content_index=0, delta="Second"
        ),
        response_event(
            "response.output_text.delta", delegation_id="a", item_id="text_a", content_index=0, delta=" again"
        ),
        response_event("response.completed", delegation_id="a", response={"id": "response_a"}),
        response_event("response.completed", delegation_id="b", response={"id": "response_b"}),
    ]

    tru_events = [output for event in events for output in model._to_strands_events(event)]
    exp_events = [
        BidiResponseStartEvent("id-1"),
        BidiTextStartEvent("id-2"),
        BidiTextDeltaEvent(delta="First", content_id="id-2"),
        BidiTextStopEvent("id-2"),
        BidiResponseStopEvent("id-1"),
        BidiResponseStartEvent("id-3"),
        BidiTextStartEvent("id-4"),
        BidiTextDeltaEvent(delta="Second", content_id="id-4"),
        BidiTextStartEvent("id-5"),
        BidiTextDeltaEvent(delta=" again", content_id="id-5"),
        BidiTextStopEvent("id-5"),
        BidiTextStopEvent("id-4"),
    ]
    assert tru_events == exp_events
    assert not model._state.delegations


@pytest.mark.parametrize("include_delta", [False, True])
def test__to_strands_text_stop_event_preserves_text_once(model, include_delta):
    events = [response_event("response.created", response={"id": "response_test"})]
    if include_delta:
        events.append(response_event("response.output_text.delta", item_id="text", content_index=0, delta="Answer"))
    events.append(response_event("response.output_text.done", item_id="text", content_index=0, text="Answer"))

    tru_events = [output for event in events for output in model._to_strands_events(event)]
    exp_events = [
        BidiResponseStartEvent("id-1"),
        BidiTextStartEvent("id-2"),
        BidiTextDeltaEvent(delta="Answer", content_id="id-2"),
        BidiTextStopEvent("id-2"),
    ]
    assert tru_events == exp_events


def test__to_strands_response_events_groups_tool_calls(model):
    events = [
        server_event("session.output_audio.delta", delta="AAA="),
        response_event("response.created", response={"id": "response_test"}),
        *[
            response_event(
                "response.output_item.done",
                item={"type": "function_call", "call_id": call_id, "name": "calculate", "arguments": '{"value": 2}'},
            )
            for call_id in ("call_a", "call_b")
        ],
        response_event("response.completed", response={"id": "response_test", "output": []}),
    ]

    tru_events = [output for event in events for output in model._to_strands_events(event)]
    exp_events = [
        BidiResponseStartEvent("id-1"),
        BidiAudioStartEvent("id-2"),
        BidiAudioDeltaEvent(audio="AAA=", format="pcm", sample_rate=24000, channels=1, content_id="id-2"),
        BidiAudioStopEvent("id-2"),
        BidiResponseStopEvent("id-1"),
        BidiResponseStartEvent("id-3"),
        BidiToolUseBlocksEvent(
            [
                {"toolUseId": "call_a", "name": "calculate", "input": {"value": 2}},
                {"toolUseId": "call_b", "name": "calculate", "input": {"value": 2}},
            ]
        ),
    ]
    assert tru_events == exp_events
    assert model._state.pending_tools == {"call_a", "call_b"}


@pytest.mark.parametrize("include_details", [False, True])
def test__to_strands_response_events_reports_backend_usage(model, include_details):
    usage = {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13}
    if include_details:
        usage.update(input_tokens_details={"cached_tokens": 5}, output_tokens_details={"reasoning_tokens": 1})
    events = [
        response_event("response.created", response={"id": "response_test"}),
        response_event("response.completed", response={"id": "response_test", "usage": usage}),
    ]

    tru_events = [output for event in events for output in model._to_strands_events(event)]
    exp_events = [
        BidiUsageEvent(
            input_tokens=10,
            output_tokens=3,
            total_tokens=13,
            input_token_details={"cache_read": 5 if include_details else 0},
            output_token_details={"reasoning": 1 if include_details else 0},
        )
    ]
    assert tru_events == exp_events


@pytest.mark.parametrize("event_type", ["response.failed", "response.incomplete", "error"])
@pytest.mark.parametrize(
    ("code", "error_type"),
    [("rate_limit_exceeded", ModelThrottledException), ("invalid_request", RuntimeError)],
)
def test__to_strands_response_events_reports_backend_errors(model, event_type, code, error_type):
    error = {"code": code, "message": "Backend rejected request"}
    if event_type == "error":
        fields = error
    else:
        key = "incomplete_details" if event_type == "response.incomplete" else "error"
        fields = {"response": {key: error}}

    with pytest.raises(error_type, match="Backend rejected request"):
        list(model._to_strands_events(response_event(event_type, **fields)))


def test__to_strands_response_events_rejects_mismatched_completion(model):
    list(model._to_strands_events(response_event("response.created", response={"id": "response_test"})))

    with pytest.raises(ValueError, match="unexpected backend response"):
        list(model._to_strands_events(response_event("response.completed", response={"id": "other_response"})))


def test__to_strands_response_events_rejects_invalid_tool_arguments(model):
    list(model._to_strands_events(response_event("response.created", response={"id": "response_test"})))
    event = response_event(
        "response.output_item.done",
        item={"type": "function_call", "call_id": "call_test", "name": "calculate", "arguments": "invalid JSON"},
    )

    with pytest.raises(json.JSONDecodeError):
        list(model._to_strands_events(event))
