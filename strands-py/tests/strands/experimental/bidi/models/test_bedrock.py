"""Unit tests for the Bedrock Nova Sonic bidirectional model implementation.

Tests the unified BidirectionalModel interface implementation for Amazon Nova Sonic,
covering connection lifecycle, event conversion, audio streaming, and tool execution.
"""

import sys

if sys.version_info < (3, 12):
    import pytest

    pytest.skip(reason="BedrockNovaSonicModel is only supported for Python 3.12+", allow_module_level=True)

import asyncio
import base64
import concurrent.futures
import json
from dataclasses import asdict
from unittest.mock import ANY, AsyncMock, Mock, patch

import pytest
import pytest_asyncio
from aws_sdk_bedrock_runtime.models import ModelTimeoutException, ValidationException
from awscrt.exceptions import from_code
from smithy_http.aio.crt import AWSCRTHTTPClient

from strands.experimental.bidi.models import (
    BedrockNovaSonicAudioConfig,
    BedrockNovaSonicModel,
    ConnectionTimeoutError,
)
from strands.experimental.bidi.models.bedrock import (
    _BedrockAWSCRTHTTPClient,
    _BedrockAWSCRTHTTPResponse,
    _ResponseState,
    _Transcript,
)
from strands.experimental.bidi.types import (
    AudioDelta,
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiBargeInEvent,
    BidiMessage,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
)
from strands.types.content import TextBlock
from strands.types.media import ImageBlock
from strands.types.tools import ToolResultBlock


# Test fixtures
@pytest.fixture
def model_id():
    """Nova Sonic model identifier."""
    return "amazon.nova-2-sonic-v1:0"


@pytest.fixture
def boto_session():
    return Mock(region_name="us-east-1")


@pytest.fixture
def mock_stream():
    """Mock Nova Sonic bidirectional stream."""
    stream = AsyncMock()
    stream.input_stream = AsyncMock()
    stream.input_stream.send = AsyncMock()
    stream.input_stream.close = AsyncMock()
    stream.await_output = AsyncMock()
    return stream


@pytest.fixture
def mock_client(mock_stream):
    """Mock Bedrock Runtime client."""
    with patch("strands.experimental.bidi.models.bedrock.AsyncBedrockRuntimeClient") as mock_cls:
        mock_instance = AsyncMock()
        mock_instance.invoke_model_with_bidirectional_stream = AsyncMock(return_value=mock_stream)
        mock_cls.return_value = mock_instance

        yield mock_instance


@pytest_asyncio.fixture
def nova_model(model_id, boto_session, mock_client):
    """Create Nova Sonic model instance."""
    _ = mock_client

    model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)
    yield model


# Initialization and Connection Tests


@pytest.mark.asyncio
async def test_model_initialization(model_id, boto_session):
    """Test model initialization with configuration."""
    model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)

    assert model.model_id == model_id
    assert model.region == "us-east-1"
    assert model._connection_id is None


def test_get_config_returns_reference(boto_session):
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session)

    config = model.get_config()
    exp_config = {
        "model_id": "amazon.nova-2-sonic-v1:0",
        "params": {},
        "connection": {"restart_after_s": 420},
    }
    assert config == exp_config

    config["model_id"] = "updated-model"
    exp_config["model_id"] = "updated-model"
    assert model.get_config() == exp_config
    assert model.get_config() is config

    model.update_config()
    assert model.get_config() == exp_config
    assert model.get_config() is config


@pytest.mark.parametrize("model_config", [{}, {"model_id": None}, {"model_id": ""}, {"model_id": 123}])
def test__init__rejects_invalid_model_id(boto_session, model_config):
    with pytest.raises(ValueError, match="model_id"):
        BedrockNovaSonicModel(boto_session=boto_session, **model_config)


@pytest.mark.parametrize("invalid_model_id", [None, "", 123])
def test_update_config_rejects_invalid_model_id(boto_session, invalid_model_id):
    model = BedrockNovaSonicModel(model_id="test-model", boto_session=boto_session)
    config = model.get_config()
    exp_config = dict(config)

    with pytest.raises(ValueError, match="model_id must be a non-empty string"):
        model.update_config(model_id=invalid_model_id, params={"temperature": 0.7}, connection={})

    tru_config = model.get_config()
    assert tru_config == exp_config
    assert tru_config is config


@pytest.mark.parametrize(
    ("model_config", "invalid_key"),
    [
        pytest.param({"model": "test-model"}, "model", id="model"),
        pytest.param({"connection": {"restart_after": 30}}, "restart_after", id="connection"),
    ],
)
def test_update_config_warns_invalid_keys(boto_session, model_config, invalid_key):
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session)

    with pytest.warns(UserWarning, match=invalid_key):
        model.update_config(**model_config)


@pytest.mark.parametrize("connection", [{"restart_after_s": 30}, {"auto_reconnect": False}, {}])
def test_update_config_replaces_connection(boto_session, connection):
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session)

    model.update_config(connection=connection)

    tru_config = model.get_config()
    exp_config = {
        "model_id": "amazon.nova-2-sonic-v1:0",
        "params": {},
        "connection": connection,
    }
    assert tru_config == exp_config
    assert model.get_connection_config() == connection


@pytest.mark.asyncio
async def test_restart_uses_updated_config(nova_model, mock_client, mock_stream):
    """Restart opens a new connection using the updated model ID and params."""
    invoke = mock_client.invoke_model_with_bidirectional_stream
    await nova_model.start()

    updated_params = {"inferenceConfiguration": {"temperature": 0.8}}
    nova_model.update_config(model_id="updated-model", params=updated_params)
    invoke.assert_called_once()

    await nova_model.restart()

    assert invoke.call_count == 2
    restarted_request = invoke.call_args.args[0]
    assert restarted_request.model_id == "updated-model"

    events = [json.loads(call.args[0].value.bytes_)["event"] for call in mock_stream.input_stream.send.call_args_list]
    session_configs = [event["sessionStart"] for event in events if "sessionStart" in event]
    assert session_configs == [{}, updated_params]

    await nova_model.stop()


@pytest.mark.asyncio
async def test_start_sets_strands_user_agent_on_bedrock_runtime_client(model_id, boto_session, mock_stream):
    """Always set the Strands user agent marker on the generated Bedrock Runtime client."""
    with patch("strands.experimental.bidi.models.bedrock.AsyncBedrockRuntimeClient") as mock_cls:
        mock_instance = AsyncMock()
        mock_instance.invoke_model_with_bidirectional_stream = AsyncMock(return_value=mock_stream)
        mock_cls.return_value = mock_instance

        model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)

        await model.start()

        assert mock_cls.call_count == 1
        config = mock_cls.call_args.kwargs["config"]
        assert config.user_agent_extra == "strands-agents"
        assert isinstance(config.transport, _BedrockAWSCRTHTTPClient)


@pytest.mark.asyncio
@pytest.mark.parametrize("region", ["us-east-1", "ap-southeast-1", "us-gov-east-1"])
async def test_valid_region_accepted(model_id, region):
    """A well-formed region resolves successfully and is used for the model."""
    model = BedrockNovaSonicModel(model_id=model_id, region=region)

    assert model.region == region


@pytest.mark.asyncio
@pytest.mark.parametrize("region", ["", "x@attacker.com:443/#", "us-east-1\n"])
async def test_invalid_region_rejected(model_id, region):
    """A malformed region is rejected before it can reach the endpoint URL."""
    with pytest.raises(ValueError, match="invalid AWS region"):
        BedrockNovaSonicModel(model_id=model_id, region=region)


def test___init__rejects_boto_session_and_region(model_id, boto_session):
    with pytest.raises(ValueError, match="Cannot specify both 'boto_session' and 'region'"):
        BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session, region="us-east-1")


@pytest.mark.asyncio
async def test_crt_transport_observes_completed_request_writer():
    """Treat a completed HTTP/2 stream as a terminal request-writer result."""
    exception_contexts = []
    event_loop = asyncio.get_running_loop()
    original_exception_handler = event_loop.get_exception_handler()
    event_loop.set_exception_handler(lambda _loop, context: exception_contexts.append(context))
    transport = object.__new__(_BedrockAWSCRTHTTPClient)

    async def write_request_body():
        raise from_code(2080)

    unexpected_error = RuntimeError("unexpected writer failure")

    async def fail_request_body():
        raise unexpected_error

    try:
        writer_task = asyncio.create_task(write_request_body())
        writer_task.add_done_callback(transport._observe_request_writer)
        failed_writer_task = asyncio.create_task(fail_request_body())
        failed_writer_task.add_done_callback(transport._observe_request_writer)
        await asyncio.gather(
            writer_task,
            failed_writer_task,
            return_exceptions=True,
        )
    finally:
        event_loop.set_exception_handler(original_exception_handler)

    # Guards against an unobserved writer task during normal shutdown (awslabs/aws-crt-python#762).
    assert writer_task.done()
    assert failed_writer_task.done()
    assert exception_contexts == [
        {
            "message": "bedrock HTTP/2 request writer failed",
            "exception": unexpected_error,
            "task": failed_writer_task,
        }
    ]


@pytest.mark.asyncio
async def test_crt_transport_attaches_request_writer_observer():
    """Attach the request-writer observer through the Smithy response hook."""
    writer_task = asyncio.create_task(asyncio.sleep(60))
    stream = Mock(_writer=writer_task)
    base_response = Mock(status=200, fields=Mock())
    observer = Mock()
    transport = object.__new__(_BedrockAWSCRTHTTPClient)

    try:
        with (
            patch.object(
                AWSCRTHTTPClient,
                "_await_response",
                new=AsyncMock(return_value=base_response),
            ) as await_response,
            patch.object(transport, "_observe_request_writer", observer),
        ):
            response = await transport._await_response(stream)

        writer_task.cancel()
        await asyncio.gather(writer_task, return_exceptions=True)
    finally:
        if not writer_task.done():
            writer_task.cancel()
            await asyncio.gather(writer_task, return_exceptions=True)

    await_response.assert_awaited_once_with(stream)
    observer.assert_called_once_with(writer_task)
    assert isinstance(response, _BedrockAWSCRTHTTPResponse)


@pytest.mark.asyncio
async def test_crt_response_streams_chunks_until_end():
    """Yield response chunks until CRT reports end-of-stream."""
    stream = Mock()
    stream.get_next_response_chunk = AsyncMock(side_effect=[b"first", b"second", b""])
    response = _BedrockAWSCRTHTTPResponse(status=200, fields=Mock(), stream=stream)

    chunks = [chunk async for chunk in response.chunks()]

    assert chunks == [b"first", b"second"]
    assert stream.get_next_response_chunk.await_count == 3


@pytest.mark.asyncio
async def test_crt_response_read_survives_reader_cancellation():
    """Keep the CRT chunk future live until stream shutdown resolves it."""
    pending_chunk: concurrent.futures.Future[bytes] = concurrent.futures.Future()
    read_started = asyncio.Event()
    read_finished = asyncio.Event()

    async def get_next_response_chunk():
        read_started.set()
        try:
            return await asyncio.wrap_future(pending_chunk)
        finally:
            read_finished.set()

    stream = Mock()
    stream.get_next_response_chunk = get_next_response_chunk
    response = _BedrockAWSCRTHTTPResponse(status=200, fields=Mock(), stream=stream)
    reader_task = asyncio.create_task(response.chunks().__anext__())

    await read_started.wait()
    reader_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reader_task

    # Guards against CRT resolving a concurrent future that task cancellation already cancelled.
    assert not pending_chunk.cancelled()
    pending_chunk.set_result(b"")
    await asyncio.wait_for(read_finished.wait(), timeout=0.5)


@pytest.mark.asyncio
async def test_crt_response_reports_cancelled_read_failure():
    """Report a background CRT read that fails after its caller is cancelled."""
    pending_chunk: concurrent.futures.Future[bytes] = concurrent.futures.Future()
    read_started = asyncio.Event()
    exception_contexts = []
    exception_reported = asyncio.Event()
    event_loop = asyncio.get_running_loop()
    original_exception_handler = event_loop.get_exception_handler()

    def record_exception(_loop, context):
        exception_contexts.append(context)
        exception_reported.set()

    async def get_next_response_chunk():
        read_started.set()
        return await asyncio.wrap_future(pending_chunk)

    stream = Mock()
    stream.get_next_response_chunk = get_next_response_chunk
    response = _BedrockAWSCRTHTTPResponse(status=200, fields=Mock(), stream=stream)
    reader_task = asyncio.create_task(response.chunks().__anext__())
    read_error = RuntimeError("response read failed")

    event_loop.set_exception_handler(record_exception)
    try:
        await read_started.wait()
        reader_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reader_task

        pending_chunk.set_exception(read_error)
        await asyncio.wait_for(exception_reported.wait(), timeout=0.5)
    finally:
        event_loop.set_exception_handler(original_exception_handler)

    assert exception_contexts == [
        {
            "message": "bedrock HTTP/2 response reader failed after cancellation",
            "exception": read_error,
            "task": ANY,
        }
    ]


# Audio Configuration Tests


@pytest.mark.parametrize(
    ("audio", "input_rate", "output_rate"),
    [
        pytest.param(None, 16000, 16000, id="defaults"),
        pytest.param({}, 16000, 16000, id="empty"),
        pytest.param({"input": {"sample_rate": 8000}}, 8000, 16000, id="input"),
        pytest.param(BedrockNovaSonicAudioConfig(output={"sample_rate": 24000}), 16000, 24000, id="output"),
        pytest.param({"input": {"sample_rate": 24000}, "output": {"sample_rate": 8000}}, 24000, 8000, id="both"),
    ],
)
def test_get_audio_config(boto_session, audio, input_rate, output_rate):
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session, audio=audio)

    tru_config = model.get_audio_config()
    exp_config = {
        "input": {"sample_rate": input_rate, "channels": 1, "format": "pcm"},
        "output": {"sample_rate": output_rate, "channels": 1, "format": "pcm"},
    }
    assert tru_config == exp_config
    assert model.get_audio_config() is tru_config


@pytest.mark.parametrize("direction", ["input", "output"])
def test__init__requires_audio_sample_rate(boto_session, direction):
    with pytest.raises(KeyError, match="sample_rate"):
        BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session, audio={direction: {}})


@pytest.mark.parametrize("direction", ["input", "output"])
def test__init__rejects_unsupported_audio_sample_rate(boto_session, direction):
    with pytest.raises(ValueError, match="Unsupported sample rate"):
        BedrockNovaSonicModel(
            model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session, audio={direction: {"sample_rate": 48000}}
        )


@pytest.mark.parametrize(
    ("audio", "invalid_key"),
    [
        ({"input": {"sample_rate": 16000, "channels": 2}}, "channels"),
        ({"output": {"sample_rate": 16000, "format": "wav"}}, "format"),
        ({"voice": "ruth"}, "voice"),
    ],
)
def test__init__warns_on_unknown_audio_keys(boto_session, audio, invalid_key):
    with pytest.warns(UserWarning, match=invalid_key):
        model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session, audio=audio)

    tru_config = model.get_audio_config()
    exp_config = {
        "input": {"sample_rate": 16000, "channels": 1, "format": "pcm"},
        "output": {"sample_rate": 16000, "channels": 1, "format": "pcm"},
    }
    assert tru_config == exp_config


@pytest.mark.parametrize(
    ("options", "rate", "voice"),
    [
        pytest.param({}, 16000, "matthew", id="defaults"),
        pytest.param({"audio": {"output": {"sample_rate": 24000}}, "voice": "ruth"}, 24000, "ruth", id="custom"),
    ],
)
def test__get_prompt_start_event_audio_output_config(boto_session, options, rate, voice):
    """Prompt start uses the resolved audio output configuration."""
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session, **options)

    prompt_start = json.loads(model._get_prompt_start_event([]))["event"]["promptStart"]
    tru_config = prompt_start["audioOutputConfiguration"]
    exp_config = {
        "mediaType": "audio/lpcm",
        "sampleRateHertz": rate,
        "sampleSizeBits": 16,
        "channelCount": 1,
        "voiceId": voice,
        "encoding": "base64",
        "audioType": "SPEECH",
    }
    assert tru_config == exp_config


@pytest.mark.asyncio
async def test_connection_lifecycle(nova_model, mock_client, mock_stream):
    """Test complete connection lifecycle with various configurations."""

    # Test basic connection
    await nova_model.start(system_prompt="Test system prompt")
    assert nova_model._stream == mock_stream
    assert nova_model._connection_id is not None
    assert mock_client.invoke_model_with_bidirectional_stream.called

    # Test close
    await nova_model.stop()
    assert mock_stream.close.called
    assert mock_client.close.called

    # Test connection with tools
    tools = [
        {
            "name": "get_weather",
            "description": "Get weather information",
            "inputSchema": {"json": json.dumps({"type": "object", "properties": {}})},
        }
    ]
    await nova_model.start(system_prompt="You are helpful", tools=tools)
    # Verify initialization events were sent (connectionStart, promptStart, system prompt)
    assert mock_stream.input_stream.send.call_count >= 3
    await nova_model.stop()


@pytest.mark.asyncio
async def test_model_stop_alone(nova_model):
    await nova_model.stop()  # Should not raise


@pytest.mark.asyncio
async def test_stop_is_idempotent(nova_model, mock_stream):
    """Calling stop() twice on a started model does not re-close the stream or raise."""
    await nova_model.start()
    await nova_model.stop()
    assert mock_stream.close.call_count == 1

    # Second stop must be a no-op: the stream reference is cleared on first stop, so
    # close() is not called again and no AttributeError is raised.
    await nova_model.stop()
    assert mock_stream.close.call_count == 1


@pytest.mark.parametrize("user_transcript", [False, True])
def test_response_boundaries_across_content_blocks(nova_model, user_transcript):
    """User transcription and assistant output share one response boundary."""
    response_state = _ResponseState()
    user_events = [
        {"contentStart": {"role": "USER", "type": "TEXT", "contentId": "user"}},
        {"textOutput": {"role": "USER", "contentId": "user", "content": "Hi."}},
        {"contentEnd": {"type": "TEXT", "contentId": "user", "stopReason": "PARTIAL_TURN"}},
    ]
    native_events = [
        *(user_events if user_transcript else []),
        {
            "contentStart": {
                "role": "ASSISTANT",
                "type": "TEXT",
                "contentId": "speculative",
                "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
            }
        },
        {"textOutput": {"role": "ASSISTANT", "contentId": "speculative", "content": "Hello."}},
        {"contentEnd": {"type": "TEXT", "contentId": "speculative", "stopReason": "PARTIAL_TURN"}},
        {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": "audio"}},
        {"audioOutput": {"contentId": "audio", "content": "YQ=="}},
        {"audioOutput": {"contentId": "audio", "content": "Yg=="}},
        {"contentEnd": {"type": "AUDIO", "contentId": "audio", "stopReason": "END_TURN"}},
        {
            "contentStart": {
                "role": "ASSISTANT",
                "type": "TEXT",
                "contentId": "final",
                "additionalModelFields": '{"generationStage":"FINAL"}',
            }
        },
        {"textOutput": {"role": "ASSISTANT", "contentId": "final", "content": "Different final text."}},
        {"contentEnd": {"type": "TEXT", "contentId": "final", "stopReason": "END_TURN"}},
    ]
    response_ids = []
    for _ in range(2):
        tru_events = []
        for native_event in native_events:
            events = nova_model._convert_nova_event(native_event, response_state)
            if native_event.get("contentEnd", {}).get("contentId") == "audio":
                assert events == [
                    BidiAudioStopEvent(),
                    BidiTranscriptStopEvent("Hello.", "assistant", "speculative"),
                    BidiResponseStopEvent(tru_events[0].response_id),
                ]
            tru_events.extend(events)
        response_id = tru_events[0].response_id
        response_ids.append(response_id)
        exp_events = [
            BidiResponseStartEvent(response_id),
            *(
                [
                    BidiTranscriptStartEvent("user", "user"),
                    BidiTranscriptDeltaEvent("Hi.", "user", "user"),
                    BidiTranscriptStopEvent("Hi.", "user", "user"),
                ]
                if user_transcript
                else []
            ),
            BidiTranscriptStartEvent("assistant", content_id="speculative"),
            BidiTranscriptDeltaEvent("Hello.", "assistant", content_id="speculative"),
            BidiAudioStartEvent(),
            BidiAudioDeltaEvent("YQ==", format="pcm", sample_rate=16000, channels=1),
            BidiAudioDeltaEvent("Yg==", format="pcm", sample_rate=16000, channels=1),
            BidiAudioStopEvent(),
            BidiTranscriptStopEvent("Hello.", "assistant", content_id="speculative"),
            BidiResponseStopEvent(response_id),
        ]
        assert tru_events == exp_events
    assert response_ids[0] != response_ids[1]


def test_accumulates_speculative_assistant_transcript_blocks(nova_model):
    response_state = _ResponseState(response_id="r1", transcript=_Transcript("t1", "assistant"))
    tru_events = []
    for content_id, text, stop_reason in [
        ("first", "Dragons appear in myths worldwide.", "PARTIAL_TURN"),
        ("second", "Would you like to hear more?", "END_TURN"),
    ]:
        native_events = [
            {
                "contentStart": {
                    "role": "ASSISTANT",
                    "type": "TEXT",
                    "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
                    "contentId": content_id,
                }
            },
            {"textOutput": {"role": "ASSISTANT", "contentId": content_id, "content": text}},
            {"contentEnd": {"type": "TEXT", "contentId": content_id, "stopReason": "PARTIAL_TURN"}},
            {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": f"{content_id}-audio"}},
            {"audioOutput": {"contentId": f"{content_id}-audio", "content": "YQ=="}},
            {"contentEnd": {"type": "AUDIO", "contentId": f"{content_id}-audio", "stopReason": stop_reason}},
        ]
        tru_events.extend(
            event
            for native_event in native_events
            for event in nova_model._convert_nova_event(native_event, response_state)
        )
    exp_events = [
        BidiTranscriptDeltaEvent("Dragons appear in myths worldwide.", "assistant", "t1"),
        BidiAudioStartEvent(),
        BidiAudioDeltaEvent("YQ==", format="pcm", sample_rate=16000, channels=1),
        BidiTranscriptDeltaEvent(" Would you like to hear more?", "assistant", "t1"),
        BidiAudioDeltaEvent("YQ==", format="pcm", sample_rate=16000, channels=1),
        BidiAudioStopEvent(),
        BidiTranscriptStopEvent("Dragons appear in myths worldwide. Would you like to hear more?", "assistant", "t1"),
        BidiResponseStopEvent("r1"),
    ]
    assert tru_events == exp_events
    assert response_state == _ResponseState()


@pytest.mark.parametrize("role", ["user", "assistant"])
def test_barge_in_closes_response_before_next_turn(nova_model, role):
    state = _ResponseState(
        response_id="r1", generation_stage="FINAL", transcript=_Transcript("t1", role, "Partial answer.")
    )

    tru_events = nova_model._convert_nova_event({"contentEnd": {"type": "TEXT", "stopReason": "INTERRUPTED"}}, state)
    exp_events = [
        BidiBargeInEvent("user_speech"),
        BidiTranscriptStopEvent("Partial answer.", role, "t1"),
        BidiResponseStopEvent("r1"),
    ]
    assert tru_events == exp_events
    assert state == _ResponseState()

    tru_events = nova_model._convert_nova_event(
        {
            "contentStart": {
                "role": "ASSISTANT",
                "type": "TEXT",
                "contentId": "next-speculative",
                "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
            }
        },
        state,
    )
    exp_events = [
        BidiResponseStartEvent(state.response_id),
        BidiTranscriptStartEvent("assistant", "next-speculative"),
    ]
    assert tru_events == exp_events
    assert state.response_id != "r1"


@pytest.mark.parametrize(
    "final_fragments",
    [[], ["Spoken answer."], ["Spoken answer.", "More words."]],
    ids=["no-final-text", "one-final-chunk", "multiple-final-chunks"],
)
def test_response_after_barge_in_finishes_before_next_user_transcript(nova_model, final_fragments):
    response_state = _ResponseState(response_id="r1", transcript=_Transcript("t1", "assistant", "Planned answer."))
    native_events = []
    if final_fragments:
        native_events.extend(
            [
                {"contentStart": {"role": "ASSISTANT", "type": "AUDIO"}},
                {"contentEnd": {"type": "AUDIO", "stopReason": "PARTIAL_TURN"}},
            ]
        )
    native_events.extend(
        [
            {
                "contentStart": {
                    "role": "ASSISTANT",
                    "type": "TEXT",
                    "contentId": "control",
                    "additionalModelFields": '{"generationStage":"FINAL"}',
                }
            },
            {"textOutput": {"role": "ASSISTANT", "contentId": "control", "content": '{ "interrupted" : true }'}},
            {"contentEnd": {"type": "TEXT", "contentId": "control", "stopReason": "INTERRUPTED"}},
        ]
    )
    if final_fragments:
        native_events.append(
            {
                "contentStart": {
                    "role": "ASSISTANT",
                    "type": "TEXT",
                    "contentId": "final",
                    "additionalModelFields": '{"generationStage":"FINAL"}',
                }
            }
        )
        native_events.extend(
            {"textOutput": {"role": "ASSISTANT", "contentId": "final", "content": text}} for text in final_fragments
        )
        native_events.append({"contentEnd": {"type": "TEXT", "contentId": "final", "stopReason": "PARTIAL_TURN"}})
    native_events.extend(
        [
            {
                "contentStart": {
                    "role": "USER",
                    "type": "TEXT",
                    "contentId": "user",
                    "additionalModelFields": '{"generationStage":"FINAL"}',
                }
            },
            {"textOutput": {"role": "USER", "contentId": "user", "content": "Next question."}},
            {"contentEnd": {"type": "TEXT", "contentId": "user", "stopReason": "PARTIAL_TURN"}},
            {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": "next-audio"}},
        ]
    )
    tru_events = []
    for native_event in native_events:
        events = nova_model._convert_nova_event(native_event, response_state)
        tru_events.extend(events)
        if native_event.get("textOutput", {}).get("contentId") == "control":
            assert events == []
            assert response_state.generation_stage == "FINAL"
        elif native_event.get("contentEnd", {}).get("contentId") == "control":
            assert events == [
                BidiBargeInEvent("user_speech"),
                *([BidiAudioStopEvent()] if final_fragments else []),
                BidiTranscriptStopEvent("Planned answer.", "assistant", content_id="t1"),
                BidiResponseStopEvent("r1"),
            ]
        elif native_event.get("textOutput", {}).get("contentId") == "final":
            assert events == []
        elif native_event.get("contentEnd", {}).get("contentId") == "final":
            assert events == []
    exp_events = [
        *([BidiAudioStartEvent()] if final_fragments else []),
        BidiBargeInEvent("user_speech"),
        *([BidiAudioStopEvent()] if final_fragments else []),
        BidiTranscriptStopEvent("Planned answer.", "assistant", content_id="t1"),
        BidiResponseStopEvent("r1"),
        BidiResponseStartEvent(response_state.response_id),
        BidiTranscriptStartEvent("user", content_id="user"),
        BidiTranscriptDeltaEvent("Next question.", "user", content_id="user"),
        BidiTranscriptStopEvent("Next question.", "user", content_id="user"),
        BidiAudioStartEvent(),
    ]
    assert tru_events == exp_events
    assert response_state.response_id != "r1"


def test_barge_in_after_response_stop_only_stops_playback(nova_model):
    response_state = _ResponseState()
    tru_events = nova_model._convert_nova_event(
        {"contentEnd": {"type": "TEXT", "stopReason": "INTERRUPTED"}}, response_state
    )
    exp_events = [BidiBargeInEvent("user_speech")]
    assert tru_events == exp_events
    assert response_state == _ResponseState()


def test_user_content_without_transcript_text_completes(nova_model):
    state = _ResponseState()
    native_events = [
        {"contentStart": {"role": "USER", "type": "TEXT", "contentId": "user"}},
        {"contentEnd": {"type": "TEXT", "contentId": "user", "stopReason": "PARTIAL_TURN"}},
        {
            "contentStart": {
                "role": "ASSISTANT",
                "type": "TEXT",
                "contentId": "assistant",
                "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
            }
        },
    ]
    tru_events = [
        event for native_event in native_events for event in nova_model._convert_nova_event(native_event, state)
    ]
    exp_events = [
        BidiResponseStartEvent(state.response_id),
        BidiTranscriptStartEvent("user", content_id="user"),
        BidiTranscriptStopEvent("", "user", content_id="user"),
        BidiTranscriptStartEvent("assistant", content_id="assistant"),
    ]
    assert tru_events == exp_events


@pytest.mark.parametrize("role", [None, "user", "assistant"])
def test_final_assistant_blocks_do_not_change_pending_transcript(nova_model, role):
    response_state = _ResponseState(
        transcript=_Transcript("pending", role, "Pending text.") if role else None,
        response_id="r1" if role else None,
    )
    exp_state = asdict(response_state)
    tru_events = []
    for content_id, stop_reason in [("early-final", "END_TURN"), ("late-final", "PARTIAL_TURN")]:
        native_events = [
            {
                "contentStart": {
                    "role": "ASSISTANT",
                    "type": "TEXT",
                    "additionalModelFields": '{"generationStage":"FINAL"}',
                    "contentId": content_id,
                }
            },
            {"textOutput": {"role": "ASSISTANT", "contentId": content_id, "content": "Ignored final text."}},
            {"contentEnd": {"type": "TEXT", "contentId": content_id, "stopReason": stop_reason}},
        ]
        tru_events.extend(
            event
            for native_event in native_events
            for event in nova_model._convert_nova_event(native_event, response_state)
        )
    assert tru_events == []
    assert asdict(response_state) == exp_state


def test_completes_accumulated_user_transcript_before_assistant_audio(nova_model):
    response_state = _ResponseState()

    def start_user_text(content_id: str) -> None:
        events = nova_model._convert_nova_event(
            {
                "contentStart": {
                    "role": "USER",
                    "type": "TEXT",
                    "additionalModelFields": '{"generationStage":"FINAL"}',
                    "contentId": content_id,
                }
            },
            response_state,
        )
        assert events == (
            [
                BidiResponseStartEvent(response_state.response_id),
                BidiTranscriptStartEvent("user", content_id=content_id),
            ]
            if content_id == "user-content-1"
            else []
        )

    start_user_text("user-content-1")
    nova_model._convert_nova_event(
        {"textOutput": {"content": "Let me think for a", "role": "USER", "contentId": "user-content-1"}},
        response_state,
    )
    nova_model._convert_nova_event(
        {
            "contentEnd": {
                "contentId": "user-content-1",
                "type": "TEXT",
                "stopReason": "PARTIAL_TURN",
            }
        },
        response_state,
    )
    start_user_text("user-content-2")
    second = nova_model._convert_nova_event(
        {"textOutput": {"content": "second", "role": "USER", "contentId": "user-content-2"}},
        response_state,
    )[0]

    assert isinstance(second, BidiTranscriptDeltaEvent)
    assert second.delta == " second"

    completed = nova_model._convert_nova_event(
        {
            "contentEnd": {
                "contentId": "user-content-2",
                "type": "TEXT",
                "stopReason": "PARTIAL_TURN",
            }
        },
        response_state,
    )
    assert completed == []

    response_start = {
        "contentStart": {
            "role": "ASSISTANT",
            "type": "AUDIO",
            "contentId": "assistant-audio",
        }
    }
    completed.extend(
        nova_model._convert_nova_event(
            response_start,
            response_state,
        )
    )

    assert completed == [
        BidiTranscriptStopEvent("Let me think for a second", "user", content_id="user-content-1"),
        BidiAudioStartEvent(),
    ]


@pytest.mark.asyncio
async def test_completion_end_is_not_a_turn_boundary(nova_model):
    """completionEnd brackets the whole session, so it is not a per-turn response-complete."""
    nova_model._current_completion_id = "c1"
    response_state = _ResponseState()
    result = nova_model._convert_nova_event(
        {"completionEnd": {"stopReason": "END_TURN"}},
        response_state,
    )
    assert result == []
    assert nova_model._current_completion_id is None


@pytest.mark.asyncio
async def test_connection_config_declared(nova_model):
    """Nova declares its reconnect deadline and cumulative usage semantics."""
    assert nova_model.get_connection_config()["restart_after_s"] == 420
    assert nova_model.usage_is_cumulative is True


@pytest.mark.asyncio
async def test_connection_config_overrides_merge_over_defaults(model_id, boto_session):
    """Connection config tunes individual fields without dropping the defaults."""
    model = BedrockNovaSonicModel(
        model_id=model_id,
        boto_session=boto_session,
        connection={"auto_reconnect": False},
    )

    # Overridden field takes the caller's value.
    assert model.get_connection_config()["auto_reconnect"] is False
    # Untouched default is preserved.
    assert model.get_connection_config()["restart_after_s"] == 420
    # usage_is_cumulative is a separate provider trait, unaffected by connection overrides.
    assert model.usage_is_cumulative is True


@pytest.mark.asyncio
async def test_restart_replays_history_through_start_path(nova_model, mock_stream):
    """restart() stops the old connection and re-initializes with the same context."""
    tools = [
        {
            "name": "get_weather",
            "description": "Get weather information",
            "inputSchema": {"json": json.dumps({"type": "object", "properties": {}})},
        }
    ]
    messages = [
        {"role": "user", "content": [{"text": "What's the weather?"}]},
        {"role": "assistant", "content": [{"text": "It's sunny and 72 degrees."}]},
    ]

    await nova_model.start(system_prompt="You are helpful", tools=tools, messages=messages)
    first_connection_id = nova_model._connection_id
    mock_stream.input_stream.send.reset_mock()

    await nova_model.restart(system_prompt="You are helpful", tools=tools, messages=messages)

    # Old stream was closed and a fresh connection established with a new id.
    assert mock_stream.close.called
    assert nova_model._connection_id is not None
    assert nova_model._connection_id != first_connection_id

    # History was replayed through the same initialization path start() uses:
    # sessionStart + promptStart + system prompt (3) + 2 text messages (3 events each).
    sent_events = [call.args[0].value.bytes_.decode("utf-8") for call in mock_stream.input_stream.send.call_args_list]
    user_events = [e for e in sent_events if '"role": "USER"' in e]
    assistant_events = [e for e in sent_events if '"role": "ASSISTANT"' in e]
    assert len(user_events) >= 1
    assert len(assistant_events) >= 1

    await nova_model.stop()


@pytest.mark.asyncio
async def test_restart_twice_does_not_raise(nova_model):
    """Two restarts in succession are safe because stop() is idempotent."""
    await nova_model.start(system_prompt="You are helpful")
    await nova_model.restart(system_prompt="You are helpful")
    await nova_model.restart(system_prompt="You are helpful")
    assert nova_model._connection_id is not None
    await nova_model.stop()


@pytest.mark.asyncio
async def test_proactive_reconnect_end_to_end_through_agent(model_id, boto_session, mock_client, mock_stream):
    """End-to-end: BidiAgent + real Nova model proactively reconnects before the deadline.

    Drives the full chain against the real BedrockNovaSonicModel (mocked Bedrock transport):
    the loop reads Nova's connection config, arms the proactive timer, emits a warning,
    and restarts through Nova's own restart() before the session deadline, replaying
    history via Nova's initialization path. No live AWS calls are made.
    """
    from strands.experimental.bidi.agent import BidiAgent
    from strands.experimental.bidi.types import BidiConnectionWarningEvent

    # Nova never emits events on its own here; await_output blocks so the model task idles
    # while the proactive timer drives the reconnect.
    output = AsyncMock()
    never = asyncio.Event()

    async def blocking_receive():
        await never.wait()

    output.receive = AsyncMock(side_effect=blocking_receive)
    mock_stream.await_output = AsyncMock(return_value=(None, output))

    model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)
    # A small deadline; the injected clock below fires it without wall time.
    model.update_config(connection={"restart_after_s": 1})
    assert model.get_connection_config() == {"restart_after_s": 1}

    agent = BidiAgent(model=model, system_prompt="You are helpful")

    # Drive the timer without wall time: the first cycle's sleeps return immediately, the re-armed
    # cycle after the swap parks, so exactly one proactive reconnect fires.
    sleep_count = 0

    async def fake_sleep(_seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count > 2:
            await asyncio.Event().wait()
        await asyncio.sleep(0)

    agent._loop._reconnect_timer._sleep = fake_sleep

    await agent.start()

    first_connection_id = model._connection_id

    warning_seen = False
    async for event in agent.receive():
        if isinstance(event, BidiConnectionWarningEvent):
            warning_seen = True
        # Once a reconnect has produced a new connection id, the proactive cycle completed.
        if model._connection_id is not None and model._connection_id != first_connection_id:
            break

    assert warning_seen
    assert model._connection_id != first_connection_id
    assert mock_stream.close.called  # old connection was torn down by restart()

    await agent.stop()


@pytest.mark.asyncio
async def test_model_stop_after_start_failure(model_id, boto_session):
    with patch("strands.experimental.bidi.models.bedrock.AsyncBedrockRuntimeClient") as mock_cls:
        mock_instance = AsyncMock()
        mock_instance.invoke_model_with_bidirectional_stream.side_effect = RuntimeError("connection failed")
        mock_cls.return_value = mock_instance

        model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)

        with pytest.raises(RuntimeError, match="connection failed"):
            await model.start()

        await model.stop()

        mock_instance.close.assert_awaited_once()
        assert model._connection_id is None


@pytest.mark.asyncio
async def test_connection_with_message_history(nova_model, mock_client, mock_stream):
    """Test connection initialization with conversation history."""

    # Create message history
    messages = [
        {"role": "user", "content": [{"text": "What's the weather?"}]},
        {"role": "assistant", "content": [{"text": "I'll check the weather for you."}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "tool-123", "name": "get_weather", "input": {}}}],
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "tool-123", "content": [{"text": "Sunny, 72°F"}]}}],
        },
        {"role": "assistant", "content": [{"text": "It's sunny and 72 degrees."}]},
    ]

    # Start connection with message history
    await nova_model.start(system_prompt="You are a helpful assistant", messages=messages)

    # Verify initialization events were sent
    # Should include: sessionStart, promptStart, system prompt (3 events),
    # and message history (only text messages: 3 messages * 3 events each = 9 events)
    # Tool use/result messages are now skipped in history
    # Total: 1 + 1 + 3 + 9 = 14 events minimum
    assert mock_stream.input_stream.send.call_count >= 14

    # Verify the events contain proper role information
    sent_events = [call.args[0].value.bytes_.decode("utf-8") for call in mock_stream.input_stream.send.call_args_list]

    # Check that USER and ASSISTANT roles are present in contentStart events
    user_events = [e for e in sent_events if '"role": "USER"' in e]
    assistant_events = [e for e in sent_events if '"role": "ASSISTANT"' in e]

    # Only text messages are sent, so we expect 1 user message and 2 assistant messages
    assert len(user_events) >= 1
    assert len(assistant_events) >= 2

    await nova_model.stop()


# Send Method Tests


@pytest.mark.asyncio
async def test_send_message_creates_one_text_input(nova_model, mock_stream):
    await nova_model.start()
    mock_stream.input_stream.send.reset_mock()
    try:
        await nova_model.send(BidiMessage(content=[TextBlock("First"), TextBlock("Second")]))

        tru_events = [json.loads(call.args[0].value.bytes_) for call in mock_stream.input_stream.send.await_args_list]
        content_name = tru_events[0]["event"]["contentStart"]["contentName"]
        exp_events = [
            {
                "event": {
                    "contentStart": {
                        "promptName": nova_model._connection_id,
                        "contentName": content_name,
                        "type": "TEXT",
                        "role": "USER",
                        "interactive": True,
                        "textInputConfiguration": {"mediaType": "text/plain"},
                    }
                }
            },
            {
                "event": {
                    "textInput": {
                        "promptName": nova_model._connection_id,
                        "contentName": content_name,
                        "content": "First\nSecond",
                    }
                }
            },
            {"event": {"contentEnd": {"promptName": nova_model._connection_id, "contentName": content_name}}},
        ]
        assert tru_events == exp_events
    finally:
        await nova_model.stop()


@pytest.mark.asyncio
async def test_send_message_rejects_images_before_sending(nova_model, mock_stream):
    await nova_model.start()
    mock_stream.input_stream.send.reset_mock()
    try:
        with pytest.raises(ValueError, match="content not supported"):
            await nova_model.send(
                BidiMessage(content=[TextBlock("Hello"), ImageBlock(format="jpeg", source={"bytes": b"image"})])
            )
        mock_stream.input_stream.send.assert_not_awaited()
    finally:
        await nova_model.stop()


@pytest.mark.asyncio
async def test_send_all_content_types(nova_model, mock_stream):
    """Test sending all content types through unified send() method."""
    await nova_model.start()

    # Test text content
    assert await nova_model.send(BidiMessage(content=[TextBlock("Hello, Nova!")])) is None
    # Should send contentStart, textInput, and contentEnd
    assert mock_stream.input_stream.send.call_count >= 3

    # Test audio content
    assert await nova_model.send(AudioDelta(format="pcm", source={"bytes": b"audio data"})) is None
    # Should start audio connection and send audio
    assert nova_model._audio_content_name
    assert mock_stream.input_stream.send.called

    # Test tool result with single content item (should be unwrapped)
    tool_result_single = ToolResultBlock(
        tool_use_id="tool-123", status="success", content=[{"text": "Weather is sunny"}]
    )
    await nova_model.send(BidiMessage(content=[tool_result_single]))
    # Should send contentStart, toolResult, and contentEnd
    assert mock_stream.input_stream.send.called

    # Test tool result with multiple content items (should send as array)
    tool_result_multi = ToolResultBlock(
        tool_use_id="tool-456", status="success", content=[{"text": "Part 1"}, {"json": {"data": "value"}}]
    )
    await nova_model.send(BidiMessage(content=[tool_result_multi]))
    assert mock_stream.input_stream.send.called

    await nova_model.stop()


@pytest.mark.asyncio
async def test_send_edge_cases(nova_model):
    """Test send() edge cases and error handling."""

    # Test image content (not supported)
    await nova_model.start()

    with pytest.raises(ValueError, match=r"content not supported"):
        await nova_model.send(BidiMessage(content=[ImageBlock(format="jpeg", source={"bytes": b"image data"})]))

    await nova_model.stop()


# Receive and Event Conversion Tests


@pytest.mark.asyncio
async def test_event_conversion(nova_model):
    """Test conversion of all Nova Sonic event types to standard format."""
    response_state = _ResponseState()

    # Audio chunks become deltas.
    audio_bytes = b"test audio data"
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    nova_event = {"audioOutput": {"content": audio_base64}}
    tru_events = nova_model._convert_nova_event(nova_event, response_state)
    exp_events = [
        BidiAudioDeltaEvent(audio_base64, format="pcm", sample_rate=16000, channels=1),
    ]
    assert tru_events == exp_events

    # Text chunks become deltas for the transcript opened by contentStart.
    nova_event = {"textOutput": {"content": "Hello, world!", "role": "ASSISTANT"}}
    tru_events = nova_model._convert_nova_event(nova_event, _ResponseState(transcript=_Transcript("t1", "assistant")))
    exp_events = [
        BidiTranscriptDeltaEvent("Hello, world!", "assistant", content_id="t1"),
    ]
    assert tru_events == exp_events

    # Test tool use (now returns ToolUseStreamEvent from core strands)
    tool_input = {"location": "Seattle"}
    nova_event = {"toolUse": {"toolUseId": "tool-123", "toolName": "get_weather", "content": json.dumps(tool_input)}}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    # ToolUseStreamEvent has delta and current_tool_use, not a "type" field
    assert "delta" in result
    assert "toolUse" in result["delta"]
    tool_use = result["delta"]["toolUse"]
    assert tool_use["toolUseId"] == "tool-123"
    assert tool_use["name"] == "get_weather"
    assert tool_use["input"] == json.dumps(tool_input)
    assert result["current_tool_use"]["input"] == tool_input

    # Test usage metrics (now returns BidiUsageEvent)
    nova_event = {
        "usageEvent": {
            "totalTokens": 100,
            "totalInputTokens": 40,
            "totalOutputTokens": 60,
            "details": {"total": {"output": {"speechTokens": 30}}},
        }
    }
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiUsageEvent)
    assert result.get("type") == "bidi_usage"
    assert result.get("totalTokens") == 100
    assert result.get("inputTokens") == 40
    assert result.get("outputTokens") == 60

    # Test content start tracks role and emits BidiResponseStartEvent
    # TEXT type contentStart (matches API spec)
    nova_event = {
        "contentStart": {
            "role": "ASSISTANT",
            "type": "TEXT",
            "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
            "contentId": "content-123",
        }
    }
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiResponseStartEvent)
    assert result.get("type") == "bidi_response_start"
    assert response_state.generation_stage == "SPECULATIVE"

    # Test AUDIO type contentStart (no additionalModelFields)
    nova_event = {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": "content-456"}}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )
    assert result == [BidiAudioStartEvent()]

    # Test TOOL type contentStart
    nova_event = {"contentStart": {"role": "TOOL", "type": "TOOL", "contentId": "content-789"}}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )
    assert result == []


# Audio Streaming Tests


@pytest.mark.asyncio
async def test_audio_connection_lifecycle(nova_model):
    """Test audio connection start and end lifecycle."""

    await nova_model.start()

    # Start audio connection
    await nova_model._start_audio_connection()
    assert nova_model._audio_content_name

    # End audio connection
    await nova_model._end_audio_input()
    assert not nova_model._audio_content_name

    await nova_model.stop()


# Helper Method Tests


@pytest.mark.asyncio
async def test_tool_configuration(nova_model):
    """Test building tool configuration from tool specs."""
    tools = [
        {
            "name": "get_weather",
            "description": "Get weather information",
            "inputSchema": {"json": json.dumps({"type": "object", "properties": {"location": {"type": "string"}}})},
        }
    ]

    tool_config = nova_model._build_tool_configuration(tools)

    assert len(tool_config) == 1
    assert tool_config[0]["toolSpec"]["name"] == "get_weather"
    assert tool_config[0]["toolSpec"]["description"] == "Get weather information"
    assert "inputSchema" in tool_config[0]["toolSpec"]


@pytest.mark.asyncio
async def test_event_templates(nova_model):
    """Test event template generation."""
    # Test connection start event
    event_json = nova_model._get_connection_start_event()
    event = json.loads(event_json)
    assert "event" in event
    assert "sessionStart" in event["event"]
    assert event["event"]["sessionStart"] == {}

    # Test prompt start event
    nova_model._connection_id = "test-connection"
    event_json = nova_model._get_prompt_start_event([])
    event = json.loads(event_json)
    assert "event" in event
    assert "promptStart" in event["event"]
    assert event["event"]["promptStart"]["promptName"] == "test-connection"

    # Test text input event
    content_name = "test-content"
    event_json = nova_model._get_text_input_event(content_name, "Hello")
    event = json.loads(event_json)
    assert "event" in event
    assert "textInput" in event["event"]
    assert event["event"]["textInput"]["content"] == "Hello"

    # Test tool result event
    result = {"result": "Success"}
    event_json = nova_model._get_tool_result_event(content_name, result)
    event = json.loads(event_json)
    assert "event" in event
    assert "toolResult" in event["event"]
    assert json.loads(event["event"]["toolResult"]["content"]) == result


@pytest.mark.asyncio
async def test_message_history_conversion(nova_model):
    """Test conversion of agent messages to Nova Sonic history events."""
    nova_model.connection_id = "test-connection"

    # Test with various message types
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there!"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "tool-1", "name": "calculator", "input": {"expr": "2+2"}}}],
        },
        {"role": "user", "content": [{"toolResult": {"toolUseId": "tool-1", "content": [{"text": "4"}]}}]},
        {"role": "assistant", "content": [{"text": "The answer is 4"}]},
    ]

    events = nova_model._get_message_history_events(messages)

    # Only text messages generate events (3 messages * 3 events each = 9 events)
    # Tool use/result messages are now skipped in history
    assert len(events) == 9

    # Parse and verify events
    parsed_events = [json.loads(e) for e in events]

    # Check first message (user)
    assert "contentStart" in parsed_events[0]["event"]
    assert parsed_events[0]["event"]["contentStart"]["role"] == "USER"
    assert "textInput" in parsed_events[1]["event"]
    assert parsed_events[1]["event"]["textInput"]["content"] == "Hello"
    assert "contentEnd" in parsed_events[2]["event"]

    # Check second message (assistant)
    assert "contentStart" in parsed_events[3]["event"]
    assert parsed_events[3]["event"]["contentStart"]["role"] == "ASSISTANT"
    assert "textInput" in parsed_events[4]["event"]
    assert parsed_events[4]["event"]["textInput"]["content"] == "Hi there!"

    # Check third message (assistant - last text message)
    assert "contentStart" in parsed_events[6]["event"]
    assert parsed_events[6]["event"]["contentStart"]["role"] == "ASSISTANT"
    assert "textInput" in parsed_events[7]["event"]
    assert parsed_events[7]["event"]["textInput"]["content"] == "The answer is 4"


@pytest.mark.asyncio
async def test_message_history_empty_and_edge_cases(nova_model):
    """Test message history conversion with empty and edge cases."""
    nova_model.connection_id = "test-connection"

    # Test with empty messages
    events = nova_model._get_message_history_events([])
    assert len(events) == 0

    # Test with message containing no text content
    messages = [{"role": "user", "content": []}]
    events = nova_model._get_message_history_events(messages)
    assert len(events) == 0  # No events generated for empty content

    # Test with multiple text blocks in one message
    messages = [{"role": "user", "content": [{"text": "First part"}, {"text": "Second part"}]}]
    events = nova_model._get_message_history_events(messages)
    assert len(events) == 3  # contentStart, textInput, contentEnd
    parsed = json.loads(events[1])
    content = parsed["event"]["textInput"]["content"]
    assert "First part" in content
    assert "Second part" in content


# Audio Event Tests


@pytest.mark.parametrize(
    ("audio", "rate"),
    [
        pytest.param(None, 16000, id="defaults"),
        pytest.param({"output": {"sample_rate": 24000}}, 24000, id="custom"),
    ],
)
def test__convert_nova_event_audio_format(boto_session, audio, rate):
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session, audio=audio)
    audio_base64 = base64.b64encode(b"audio data").decode()

    tru_events = model._convert_nova_event({"audioOutput": {"content": audio_base64}}, _ResponseState())
    exp_events = [
        BidiAudioDeltaEvent(audio=audio_base64, format="pcm", sample_rate=rate, channels=1),
    ]
    assert tru_events == exp_events


# Nova Sonic v2 Support Tests


@pytest.mark.asyncio
async def test_nova_sonic_v2_instantiation(boto_session, mock_client):
    """Test direct instantiation with Nova Sonic v2 model ID."""
    _ = mock_client  # Ensure mock is active

    # Test default creation
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", boto_session=boto_session)
    assert model.model_id == "amazon.nova-2-sonic-v1:0"
    assert model.region == "us-east-1"

    # Test with custom config
    model_custom = BedrockNovaSonicModel(
        model_id="amazon.nova-2-sonic-v1:0",
        boto_session=boto_session,
        audio={"input": {"sample_rate": 24000}},
        voice="ruth",
        params={"inferenceConfiguration": {"temperature": 0.8}},
    )

    assert model_custom.model_id == "amazon.nova-2-sonic-v1:0"
    assert model_custom.get_audio_config()["input"]["sample_rate"] == 24000
    assert (
        json.loads(model_custom._get_connection_start_event())["event"]["sessionStart"]["inferenceConfiguration"][
            "temperature"
        ]
        == 0.8
    )


@pytest.mark.parametrize("model_id", ["amazon.nova-2-sonic-v1:0", "custom-model"])
def test__init__uses_explicit_model_id(boto_session, model_id):
    model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)

    assert model.model_id == model_id


def test_params_passed_to_session_start(boto_session):
    """Provider parameters are passed directly to the Nova session start event."""
    params = {
        "inferenceConfiguration": {"temperature": 0.8},
        "turnDetectionConfiguration": {"endpointingSensitivity": "MEDIUM"},
    }
    model = BedrockNovaSonicModel(
        model_id="amazon.nova-2-sonic-v1:0",
        params=params,
        boto_session=boto_session,
    )

    session_start = json.loads(model._get_connection_start_event())["event"]["sessionStart"]

    assert session_start == params


@pytest.mark.parametrize("params", [{"inferenceConfiguration": {"topP": 0.9}}, {}, None])
def test_update_config_replaces_params(boto_session, params):
    model = BedrockNovaSonicModel(
        model_id="amazon.nova-2-sonic-v1:0",
        boto_session=boto_session,
        params={"inferenceConfiguration": {"temperature": 0.8}},
    )

    model.update_config(params=params)

    tru_event = json.loads(model._get_connection_start_event())
    exp_event = {"event": {"sessionStart": params or {}}}
    assert tru_event == exp_event


# Error Handling Tests
@pytest.mark.asyncio
async def test_bidi_nova_sonic_model_receive_timeout(nova_model, mock_stream):
    mock_output = AsyncMock()
    mock_output.receive.side_effect = ModelTimeoutException("Connection timeout")
    mock_stream.await_output.return_value = (None, mock_output)

    await nova_model.start()

    with pytest.raises(ConnectionTimeoutError, match=r"Connection timeout"):
        async for _ in nova_model.receive():
            pass


@pytest.mark.asyncio
async def test_bidi_nova_sonic_model_receive_timeout_validation(nova_model, mock_stream):
    mock_output = AsyncMock()
    mock_output.receive.side_effect = ValidationException("InternalErrorCode=531: Request timeout")
    mock_stream.await_output.return_value = (None, mock_output)

    await nova_model.start()

    with pytest.raises(ConnectionTimeoutError, match=r"InternalErrorCode=531"):
        async for _ in nova_model.receive():
            pass


@pytest.mark.asyncio
async def test_receive_ends_when_stream_closed(nova_model, mock_stream, alist):
    """A None from the event receiver marks end-of-stream; the receive loop must terminate.

    Per the smithy EventReceiver contract, receive() returns None only at end-of-stream (e.g.
    the connection closed on reconnect), and a closed receiver returns it without suspending.
    Treating that as a transient empty event and continuing busy-loops the reader, starving the
    event loop and hanging the reconnect swap. The generator must instead finish.
    """
    mock_output = AsyncMock()
    mock_output.receive = AsyncMock(return_value=None)
    mock_stream.await_output.return_value = (None, mock_output)

    nova_model.update_config(model_id="updated-model")
    await nova_model.start()

    # Bounded so a regression (busy-loop) fails fast instead of hanging the suite.
    events = await asyncio.wait_for(alist(nova_model.receive()), timeout=5.0)

    # Only the initial connection-start event precedes the end-of-stream.
    assert [type(event).__name__ for event in events] == ["BidiConnectionStartEvent"]
    assert events[0].model == "updated-model"
    await nova_model.stop()


@pytest.mark.asyncio
async def test_error_handling(nova_model, mock_stream):
    """Test error handling in various scenarios."""

    # Test response processor handles errors gracefully
    async def mock_error(*args, **kwargs):
        raise Exception("Test error")

    mock_stream.await_output.side_effect = mock_error

    await nova_model.start()

    # Wait a bit for response processor to handle error
    await asyncio.sleep(0.1)

    # Should still be able to close cleanly
    await nova_model.stop()


# Tool Result Content Tests


@pytest.mark.asyncio
async def test_tool_result_single_content_unwrapped(nova_model, mock_stream):
    """Test that single content item is unwrapped (optimization)."""
    await nova_model.start()

    tool_result = ToolResultBlock(tool_use_id="tool-123", status="success", content=[{"text": "Single result"}])

    await nova_model.send(BidiMessage(content=[tool_result]))

    # Verify events were sent
    assert mock_stream.input_stream.send.called
    calls = mock_stream.input_stream.send.call_args_list

    # Find the toolResult event
    tool_result_events = []
    for call in calls:
        event_json = call.args[0].value.bytes_.decode("utf-8")
        event = json.loads(event_json)
        if "toolResult" in event.get("event", {}):
            tool_result_events.append(event)

    assert len(tool_result_events) > 0
    tool_result_event = tool_result_events[0]["event"]["toolResult"]

    # Single content should be unwrapped (not in array)
    content = json.loads(tool_result_event["content"])
    assert content == {"text": "Single result"}

    await nova_model.stop()


@pytest.mark.asyncio
async def test_tool_result_multiple_content_as_array(nova_model, mock_stream):
    """Test that multiple content items are sent as array."""
    await nova_model.start()

    tool_result = ToolResultBlock(
        tool_use_id="tool-456", status="success", content=[{"text": "Part 1"}, {"json": {"data": "value"}}]
    )

    await nova_model.send(BidiMessage(content=[tool_result]))

    # Verify events were sent
    assert mock_stream.input_stream.send.called
    calls = mock_stream.input_stream.send.call_args_list

    # Find the toolResult event
    tool_result_events = []
    for call in calls:
        event_json = call.args[0].value.bytes_.decode("utf-8")
        event = json.loads(event_json)
        if "toolResult" in event.get("event", {}):
            tool_result_events.append(event)

    assert len(tool_result_events) > 0
    tool_result_event = tool_result_events[0]["event"]["toolResult"]

    # Multiple content should be in array format
    content = json.loads(tool_result_event["content"])
    assert "content" in content
    assert isinstance(content["content"], list)
    assert len(content["content"]) == 2
    assert content["content"][0] == {"text": "Part 1"}
    assert content["content"][1] == {"json": {"data": "value"}}

    await nova_model.stop()


@pytest.mark.asyncio
async def test_tool_result_empty_content(nova_model, mock_stream):
    """Test that empty content is handled gracefully."""
    await nova_model.start()

    tool_result = ToolResultBlock(tool_use_id="tool-789", status="success", content=[])

    await nova_model.send(BidiMessage(content=[tool_result]))

    # Verify events were sent
    assert mock_stream.input_stream.send.called
    calls = mock_stream.input_stream.send.call_args_list

    # Find the toolResult event
    tool_result_events = []
    for call in calls:
        event_json = call.args[0].value.bytes_.decode("utf-8")
        event = json.loads(event_json)
        if "toolResult" in event.get("event", {}):
            tool_result_events.append(event)

    assert len(tool_result_events) > 0
    tool_result_event = tool_result_events[0]["event"]["toolResult"]

    # Empty content should result in empty array wrapped in content key
    content = json.loads(tool_result_event["content"])
    assert content == {"content": []}

    await nova_model.stop()


@pytest.mark.asyncio
async def test_tool_result_unsupported_content_type(nova_model):
    """Test that unsupported content types raise ValueError."""
    await nova_model.start()

    # Test with image content (unsupported)
    tool_result_image = ToolResultBlock(
        tool_use_id="tool-999",
        status="success",
        content=[{"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    )

    with pytest.raises(ValueError, match=r"Content type not supported by Nova Sonic"):
        await nova_model.send(BidiMessage(content=[tool_result_image]))

    # Test with document content (unsupported)
    tool_result_doc = ToolResultBlock(
        tool_use_id="tool-888",
        status="success",
        content=[{"document": {"format": "pdf", "source": {"bytes": b"doc_data"}}}],
    )

    with pytest.raises(ValueError, match=r"Content type not supported by Nova Sonic"):
        await nova_model.send(BidiMessage(content=[tool_result_doc]))

    # Test with mixed content (one unsupported)
    tool_result_mixed = ToolResultBlock(
        tool_use_id="tool-777",
        status="success",
        content=[{"text": "Valid text"}, {"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    )

    with pytest.raises(ValueError, match=r"Content type not supported by Nova Sonic"):
        await nova_model.send(BidiMessage(content=[tool_result_mixed]))

    await nova_model.stop()


@pytest.mark.parametrize("assistant_transcript", [False, True])
@pytest.mark.parametrize("tool_count", [1, 3])
def test_tool_calls_keep_response_open_until_audio_ends(nova_model, assistant_transcript, tool_count):
    from strands.types._events import ToolUseStreamEvent

    state = _ResponseState()
    tool_events = []
    for index in range(tool_count):
        tool_events.extend(
            [
                {"contentStart": {"role": "TOOL", "type": "TOOL", "contentId": f"tool-{index}"}},
                {"toolUse": {"toolUseId": f"call-{index}", "toolName": "time_tool", "content": "{}"}},
                {"contentEnd": {"type": "TOOL", "contentId": f"tool-{index}", "stopReason": "TOOL_USE"}},
            ]
        )
    assistant_events = [
        {
            "contentStart": {
                "role": "ASSISTANT",
                "type": "TEXT",
                "contentId": "assistant",
                "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
            }
        },
        {"textOutput": {"role": "ASSISTANT", "contentId": "assistant", "content": "Let me check."}},
        {"contentEnd": {"type": "TEXT", "contentId": "assistant", "stopReason": "PARTIAL_TURN"}},
    ]
    native_events = [
        {
            "contentStart": {
                "role": "USER",
                "type": "TEXT",
                "contentId": "user",
                "additionalModelFields": '{"generationStage":"FINAL"}',
            }
        },
        {"textOutput": {"role": "USER", "contentId": "user", "content": "What time is it?"}},
        {"contentEnd": {"type": "TEXT", "contentId": "user", "stopReason": "PARTIAL_TURN"}},
        *(assistant_events if assistant_transcript else []),
        *tool_events,
        {
            "contentStart": {
                "role": "ASSISTANT",
                "type": "TEXT",
                "contentId": "answer",
                "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
            }
        },
        {"textOutput": {"role": "ASSISTANT", "contentId": "answer", "content": "It is noon."}},
        {"contentEnd": {"type": "TEXT", "contentId": "answer", "stopReason": "PARTIAL_TURN"}},
        {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": "audio"}},
        {"audioOutput": {"contentId": "audio", "content": "YQ=="}},
        {"contentEnd": {"type": "AUDIO", "contentId": "audio", "stopReason": "END_TURN"}},
    ]
    tru_events = [event for native in native_events for event in nova_model._convert_nova_event(native, state)]
    response_id = tru_events[0].response_id
    content_id = "assistant" if assistant_transcript else "answer"
    exp_events = [
        BidiResponseStartEvent(response_id),
        BidiTranscriptStartEvent("user", content_id="user"),
        BidiTranscriptDeltaEvent("What time is it?", "user", content_id="user"),
        BidiTranscriptStopEvent("What time is it?", "user", content_id="user"),
        *(
            [
                BidiTranscriptStartEvent("assistant", "assistant"),
                BidiTranscriptDeltaEvent("Let me check.", "assistant", "assistant"),
            ]
            if assistant_transcript
            else []
        ),
        *[
            ToolUseStreamEvent(
                delta={"toolUse": {"toolUseId": f"call-{index}", "name": "time_tool", "input": "{}"}},
                current_tool_use={"toolUseId": f"call-{index}", "name": "time_tool", "input": {}},
            )
            for index in range(tool_count)
        ],
        *([] if assistant_transcript else [BidiTranscriptStartEvent("assistant", content_id)]),
        BidiTranscriptDeltaEvent(" It is noon." if assistant_transcript else "It is noon.", "assistant", content_id),
        BidiAudioStartEvent(),
        BidiAudioDeltaEvent("YQ==", format="pcm", sample_rate=16000, channels=1),
        BidiAudioStopEvent(),
        BidiTranscriptStopEvent(
            "Let me check. It is noon." if assistant_transcript else "It is noon.", "assistant", content_id
        ),
        BidiResponseStopEvent(response_id),
    ]
    assert tru_events == exp_events
    assert state == _ResponseState()


@pytest.mark.parametrize("assistant_transcript", [False, True])
@pytest.mark.parametrize("partial_audio", [False, True])
def test_user_transcript_closes_response_after_tool_use(nova_model, assistant_transcript, partial_audio):
    state = _ResponseState(
        response_id="previous",
        transcript=_Transcript("assistant", "assistant", "Let me check.") if assistant_transcript else None,
    )
    native_events = [
        {"contentEnd": {"type": "TOOL", "contentId": "tool", "stopReason": "TOOL_USE"}},
    ]
    if partial_audio:
        native_events.extend(
            [
                {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": "audio"}},
                {"audioOutput": {"contentId": "audio", "content": "YQ=="}},
                {"contentEnd": {"type": "AUDIO", "contentId": "audio", "stopReason": "PARTIAL_TURN"}},
            ]
        )
    tru_events = [event for native in native_events for event in nova_model._convert_nova_event(native, state)]
    for content_id, text in [("user-1", "Next"), ("user-2", "question.")]:
        native_events = [
            {
                "contentStart": {
                    "role": "USER",
                    "type": "TEXT",
                    "contentId": content_id,
                    "additionalModelFields": '{"generationStage":"FINAL"}',
                }
            },
            {"textOutput": {"role": "USER", "contentId": content_id, "content": text}},
            {"contentEnd": {"type": "TEXT", "contentId": content_id, "stopReason": "PARTIAL_TURN"}},
        ]
        tru_events.extend(event for native in native_events for event in nova_model._convert_nova_event(native, state))

    exp_events = [
        *(
            [
                BidiAudioStartEvent(),
                BidiAudioDeltaEvent("YQ==", format="pcm", sample_rate=16000, channels=1),
                BidiAudioStopEvent(),
            ]
            if partial_audio
            else []
        ),
        *([BidiTranscriptStopEvent("Let me check.", "assistant", "assistant")] if assistant_transcript else []),
        BidiResponseStopEvent("previous"),
        BidiResponseStartEvent(state.response_id),
        BidiTranscriptStartEvent("user", "user-1"),
        BidiTranscriptDeltaEvent("Next", "user", "user-1"),
        BidiTranscriptDeltaEvent(" question.", "user", "user-1"),
    ]
    assert tru_events == exp_events
    assert state == _ResponseState(
        response_id=state.response_id, transcript=_Transcript("user-1", "user", "Next question.")
    )
    assert state.response_id != "previous"
