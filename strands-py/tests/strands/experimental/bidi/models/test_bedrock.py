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
import json
from unittest.mock import AsyncMock, Mock, patch

import pytest
import pytest_asyncio
from aws_sdk_bedrock_runtime.models import ModelTimeoutException, ValidationException

from strands.experimental.bidi.models.bedrock import (
    NOVA_SONIC_V1_MODEL_ID,
    NOVA_SONIC_V2_MODEL_ID,
    BedrockNovaSonicModel,
    _ResponseState,
)
from strands.experimental.bidi.models.model import BidiModelTimeoutError
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiImageInputEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
)
from strands.types._events import ToolResultEvent
from strands.types.tools import ToolResult


# Test fixtures
@pytest.fixture
def model_id():
    """Nova Sonic model identifier."""
    return "amazon.nova-sonic-v1:0"


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


def test_get_config_returns_copy(boto_session):
    model = BedrockNovaSonicModel(boto_session=boto_session)

    config = model.get_config()
    exp_config = {
        "model_id": NOVA_SONIC_V2_MODEL_ID,
        "params": {},
        "connection": {"restart_after_s": 420},
    }
    assert config == exp_config

    config["model_id"] = NOVA_SONIC_V1_MODEL_ID
    assert model.get_config() == exp_config


@pytest.mark.parametrize(
    ("model_config", "invalid_key"),
    [
        pytest.param({"model": "test-model"}, "model", id="model"),
        pytest.param({"connection": {"restart_after": 30}}, "restart_after", id="connection"),
    ],
)
def test_update_config_warns_invalid_keys(boto_session, model_config, invalid_key):
    model = BedrockNovaSonicModel(boto_session=boto_session)

    with pytest.warns(UserWarning, match=invalid_key):
        model.update_config(**model_config)


@pytest.mark.parametrize("connection", [{"restart_after_s": 30}, {"auto_reconnect": False}, {}])
def test_update_config_replaces_connection(boto_session, connection):
    model = BedrockNovaSonicModel(boto_session=boto_session)

    model.update_config(connection=connection)

    tru_config = model.get_config()
    exp_config = {
        "model_id": NOVA_SONIC_V2_MODEL_ID,
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
    nova_model.update_config(model_id=NOVA_SONIC_V2_MODEL_ID, params=updated_params)
    invoke.assert_called_once()

    await nova_model.restart()

    assert invoke.call_count == 2
    restarted_request = invoke.call_args.args[0]
    assert restarted_request.model_id == NOVA_SONIC_V2_MODEL_ID

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


# Audio Configuration Tests


@pytest.mark.asyncio
async def test_audio_config_defaults(model_id, boto_session):
    """Test default audio configuration."""
    model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)

    assert model.get_audio_config() == {
        "input_rate": 16000,
        "output_rate": 16000,
        "channels": 1,
        "format": "pcm",
    }


@pytest.mark.asyncio
async def test_audio_config_partial_override(model_id, boto_session):
    """Test partial audio configuration override."""
    model = BedrockNovaSonicModel(
        model_id=model_id,
        boto_session=boto_session,
        audio={"output_rate": 24000, "voice": "ruth"},
    )

    assert model.get_audio_config() == {
        "input_rate": 16000,
        "output_rate": 24000,
        "channels": 1,
        "format": "pcm",
        "voice": "ruth",
    }


@pytest.mark.asyncio
async def test_audio_config_full_override(model_id, boto_session):
    """Test full audio configuration override."""
    audio_config = {
        "input_rate": 48000,
        "output_rate": 48000,
        "channels": 2,
        "format": "pcm",
        "voice": "stephen",
    }
    model = BedrockNovaSonicModel(
        model_id=model_id,
        boto_session=boto_session,
        audio=audio_config,
    )

    assert model.get_audio_config() == audio_config


@pytest.mark.parametrize(
    ("audio", "expected"),
    [
        (
            None,
            {
                "mediaType": "audio/lpcm",
                "sampleRateHertz": 16000,
                "sampleSizeBits": 16,
                "channelCount": 1,
                "voiceId": "matthew",
                "encoding": "base64",
                "audioType": "SPEECH",
            },
        ),
        (
            {"output_rate": 24000, "channels": 2, "voice": "ruth"},
            {
                "mediaType": "audio/lpcm",
                "sampleRateHertz": 24000,
                "sampleSizeBits": 16,
                "channelCount": 2,
                "voiceId": "ruth",
                "encoding": "base64",
                "audioType": "SPEECH",
            },
        ),
    ],
)
def test_prompt_start_event_audio_output_config(boto_session, audio, expected):
    """Prompt start uses the resolved audio output configuration."""
    model = BedrockNovaSonicModel(boto_session=boto_session, audio=audio)

    prompt_start = json.loads(model._get_prompt_start_event([]))["event"]["promptStart"]

    assert prompt_start["audioOutputConfiguration"] == expected


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


@pytest.mark.asyncio
async def test_content_end_end_turn_emits_response_complete(nova_model):
    """A per-turn boundary (contentEnd END_TURN) emits a response-complete event."""
    nova_model._current_completion_id = "c1"
    response_state = _ResponseState()

    # Intermediate blocks are not a turn boundary.
    assert (
        nova_model._convert_nova_event(
            {"contentEnd": {"type": "TEXT", "stopReason": "PARTIAL_TURN"}},
            response_state,
        )
        == []
    )

    # The audio boundary is not the response lifecycle boundary; Nova sends a later
    # FINAL transcript block for the same turn.
    assert (
        nova_model._convert_nova_event(
            {"contentEnd": {"type": "AUDIO", "stopReason": "END_TURN"}},
            response_state,
        )
        == []
    )

    response_state.generation_stage = "FINAL"
    end = nova_model._convert_nova_event(
        {
            "contentEnd": {
                "contentId": "assistant-final",
                "type": "TEXT",
                "stopReason": "END_TURN",
            }
        },
        response_state,
    )[0]
    assert isinstance(end, BidiResponseCompleteEvent)
    assert end.stop_reason == "complete"

    # A barge-in ends the turn regardless of block/stage.
    interrupted = nova_model._convert_nova_event(
        {"contentEnd": {"type": "AUDIO", "stopReason": "INTERRUPTED"}},
        response_state,
    )[0]
    assert isinstance(interrupted, BidiResponseCompleteEvent)
    assert interrupted.stop_reason == "interrupted"


def test_accumulates_final_assistant_transcript_blocks(nova_model):
    response_state = _ResponseState()

    def start_final_text(content_id: str) -> None:
        nova_model._convert_nova_event(
            {
                "contentStart": {
                    "role": "ASSISTANT",
                    "type": "TEXT",
                    "additionalModelFields": '{"generationStage":"FINAL"}',
                    "contentId": content_id,
                }
            },
            response_state,
        )

    nova_model._convert_nova_event(
        {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": "assistant-audio"}},
        response_state,
    )
    nova_model._convert_nova_event(
        {"contentEnd": {"contentId": "assistant-audio", "type": "AUDIO", "stopReason": "END_TURN"}},
        response_state,
    )

    start_final_text("assistant-final-1")
    first = nova_model._convert_nova_event(
        {
            "textOutput": {
                "content": "Dragons appear in myths worldwide.",
                "role": "ASSISTANT",
                "contentId": "assistant-final-1",
            }
        },
        response_state,
    )
    assert first == []

    nova_model._convert_nova_event(
        {
            "contentEnd": {
                "contentId": "assistant-final-1",
                "type": "TEXT",
                "stopReason": "PARTIAL_TURN",
            }
        },
        response_state,
    )
    assert response_state.transcript == "Dragons appear in myths worldwide."

    start_final_text("assistant-final-2")
    second = nova_model._convert_nova_event(
        {
            "textOutput": {
                "content": " Would you like to hear more?",
                "role": "ASSISTANT",
                "contentId": "assistant-final-2",
            }
        },
        response_state,
    )
    assert second == []

    completed = nova_model._convert_nova_event(
        {
            "contentEnd": {
                "contentId": "assistant-final-2",
                "type": "TEXT",
                "stopReason": "END_TURN",
            }
        },
        response_state,
    )
    assert isinstance(completed, list)
    assert completed[0] == BidiTranscriptCompleteEvent(
        "Dragons appear in myths worldwide. Would you like to hear more?", "assistant"
    )
    assert isinstance(completed[1], BidiResponseCompleteEvent)
    assert completed[1].stop_reason == "complete"

    assert response_state.transcript == ""


def test_streams_speculative_text_and_completes_with_final_transcript(nova_model):
    response_state = _ResponseState()

    def start_text(generation_stage: str) -> None:
        nova_model._convert_nova_event(
            {
                "contentStart": {
                    "role": "ASSISTANT",
                    "type": "TEXT",
                    "additionalModelFields": json.dumps({"generationStage": generation_stage}),
                    "contentId": f"assistant-{generation_stage.lower()}",
                }
            },
            response_state,
        )

    start_text("SPECULATIVE")
    preview = nova_model._convert_nova_event(
        {
            "textOutput": {
                "content": "A garden began to grow.",
                "role": "ASSISTANT",
                "contentId": "assistant-speculative",
            }
        },
        response_state,
    )[0]
    assert isinstance(preview, BidiTranscriptStreamEvent)

    start_text("FINAL")
    final = nova_model._convert_nova_event(
        {
            "textOutput": {
                "content": "A garden began to grow.",
                "role": "ASSISTANT",
                "contentId": "assistant-final",
            }
        },
        response_state,
    )
    assert final == []
    completed = nova_model._convert_nova_event(
        {
            "contentEnd": {
                "contentId": "assistant-final",
                "type": "TEXT",
                "stopReason": "END_TURN",
            }
        },
        response_state,
    )
    assert isinstance(completed, list)
    assert completed[0] == BidiTranscriptCompleteEvent("A garden began to grow.", "assistant")


def test_completes_accumulated_user_transcript_when_response_starts(nova_model):
    response_state = _ResponseState()

    def start_user_text(content_id: str) -> None:
        nova_model._convert_nova_event(
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

    assert isinstance(second, BidiTranscriptStreamEvent)
    assert second.delta == " second"

    nova_model._convert_nova_event(
        {
            "contentEnd": {
                "contentId": "user-content-2",
                "type": "TEXT",
                "stopReason": "PARTIAL_TURN",
            }
        },
        response_state,
    )

    response_start = {
        "contentStart": {
            "role": "ASSISTANT",
            "type": "AUDIO",
            "contentId": "assistant-audio",
        }
    }
    completed = nova_model._convert_nova_event(
        response_start,
        response_state,
    )

    assert isinstance(completed, list)
    assert completed[0] == BidiTranscriptCompleteEvent("Let me think for a second", "user")
    assert isinstance(completed[1], BidiResponseStartEvent)


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
    from strands.experimental.bidi.agent.agent import BidiAgent
    from strands.experimental.bidi.types.events import BidiConnectionWarningEvent

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
async def test_send_all_content_types(nova_model, mock_stream):
    """Test sending all content types through unified send() method."""
    await nova_model.start()

    # Test text content
    text_event = BidiTextInputEvent(text="Hello, Nova!", role="user")
    await nova_model.send(text_event)
    # Should send contentStart, textInput, and contentEnd
    assert mock_stream.input_stream.send.call_count >= 3

    # Test audio content (base64 encoded)
    audio_b64 = base64.b64encode(b"audio data").decode("utf-8")
    audio_event = BidiAudioInputEvent(audio=audio_b64, format="pcm", sample_rate=16000, channels=1)
    await nova_model.send(audio_event)
    # Should start audio connection and send audio
    assert nova_model._audio_content_name
    assert mock_stream.input_stream.send.called

    # Test tool result with single content item (should be unwrapped)
    tool_result_single: ToolResult = {
        "toolUseId": "tool-123",
        "status": "success",
        "content": [{"text": "Weather is sunny"}],
    }
    await nova_model.send(ToolResultEvent(tool_result_single))
    # Should send contentStart, toolResult, and contentEnd
    assert mock_stream.input_stream.send.called

    # Test tool result with multiple content items (should send as array)
    tool_result_multi: ToolResult = {
        "toolUseId": "tool-456",
        "status": "success",
        "content": [{"text": "Part 1"}, {"json": {"data": "value"}}],
    }
    await nova_model.send(ToolResultEvent(tool_result_multi))
    assert mock_stream.input_stream.send.called

    await nova_model.stop()


@pytest.mark.asyncio
async def test_send_edge_cases(nova_model):
    """Test send() edge cases and error handling."""

    # Test image content (not supported, base64 encoded, no encoding parameter)
    await nova_model.start()
    image_b64 = base64.b64encode(b"image data").decode("utf-8")
    image_event = BidiImageInputEvent(
        image=image_b64,
        mime_type="image/jpeg",
    )

    with pytest.raises(ValueError, match=r"content not supported"):
        await nova_model.send(image_event)

    await nova_model.stop()


# Receive and Event Conversion Tests


@pytest.mark.asyncio
async def test_event_conversion(nova_model):
    """Test conversion of all Nova Sonic event types to standard format."""
    response_state = _ResponseState()

    # Test audio output (now returns BidiAudioStreamEvent)
    audio_bytes = b"test audio data"
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    nova_event = {"audioOutput": {"content": audio_base64}}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiAudioStreamEvent)
    assert result.get("type") == "bidi_audio_stream"
    # Audio is kept as base64 string
    assert result.get("audio") == audio_base64
    assert result.get("format") == "pcm"
    assert result.get("sample_rate") == 16000

    # Test text output (now returns BidiTranscriptStreamEvent)
    nova_event = {"textOutput": {"content": "Hello, world!", "role": "ASSISTANT"}}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiTranscriptStreamEvent)
    assert result.get("type") == "bidi_transcript_stream"
    assert result.get("delta") == "Hello, world!"
    assert result.get("role") == "assistant"
    assert result.delta == "Hello, world!"

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

    # Test interruption (now returns BidiInterruptionEvent)
    nova_event = {"stopReason": "INTERRUPTED"}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiInterruptionEvent)
    assert result.get("type") == "bidi_interruption"
    assert result.get("reason") == "user_speech"

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
            "additionalModelFields": '{"generationStage":"FINAL"}',
            "contentId": "content-123",
        }
    }
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiResponseStartEvent)
    assert result.get("type") == "bidi_response_start"
    assert response_state.generation_stage == "FINAL"

    # Test AUDIO type contentStart (no additionalModelFields)
    nova_event = {"contentStart": {"role": "ASSISTANT", "type": "AUDIO", "contentId": "content-456"}}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiResponseStartEvent)

    # Test TOOL type contentStart
    nova_event = {"contentStart": {"role": "TOOL", "type": "TOOL", "contentId": "content-789"}}
    result = nova_model._convert_nova_event(
        nova_event,
        response_state,
    )[0]
    assert isinstance(result, BidiResponseStartEvent)


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


# Error Handling Tests


@pytest.mark.asyncio
async def test_custom_audio_rates_in_events(model_id, boto_session):
    """Test that audio events use configured sample rates."""
    response_state = _ResponseState()

    # Create model with custom audio configuration
    model = BedrockNovaSonicModel(
        model_id=model_id,
        boto_session=boto_session,
        audio={"output_rate": 48000, "channels": 2},
    )

    # Test audio output event uses custom configuration
    audio_bytes = b"test audio data"
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    nova_event = {"audioOutput": {"content": audio_base64}}
    result = model._convert_nova_event(
        nova_event,
        response_state,
    )[0]

    assert isinstance(result, BidiAudioStreamEvent)
    # Should use configured rates, not constants
    assert result.sample_rate == 48000  # Custom config
    assert result.channels == 2  # Custom config
    assert result.format == "pcm"


@pytest.mark.asyncio
async def test_default_audio_rates_in_events(model_id, boto_session):
    """Test that audio events use default sample rates when no custom config."""
    response_state = _ResponseState()

    # Create model without custom audio configuration
    model = BedrockNovaSonicModel(model_id=model_id, boto_session=boto_session)

    # Test audio output event uses defaults
    audio_bytes = b"test audio data"
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    nova_event = {"audioOutput": {"content": audio_base64}}
    result = model._convert_nova_event(
        nova_event,
        response_state,
    )[0]

    assert isinstance(result, BidiAudioStreamEvent)
    # Should use default rates
    assert result.sample_rate == 16000  # Default output rate
    assert result.channels == 1  # Default channels
    assert result.format == "pcm"


# Nova Sonic v2 Support Tests


def test_nova_sonic_model_constants():
    """Test that Nova Sonic model ID constants are correctly defined."""
    assert NOVA_SONIC_V1_MODEL_ID == "amazon.nova-sonic-v1:0"
    assert NOVA_SONIC_V2_MODEL_ID == "amazon.nova-2-sonic-v1:0"


@pytest.mark.asyncio
async def test_nova_sonic_v1_instantiation(boto_session, mock_client):
    """Test direct instantiation with Nova Sonic v1 model ID."""
    _ = mock_client  # Ensure mock is active

    # Test default creation
    model = BedrockNovaSonicModel(model_id=NOVA_SONIC_V1_MODEL_ID, boto_session=boto_session)
    assert model.model_id == NOVA_SONIC_V1_MODEL_ID
    assert model.region == "us-east-1"

    # Test with custom config
    model_custom = BedrockNovaSonicModel(
        model_id=NOVA_SONIC_V1_MODEL_ID,
        boto_session=boto_session,
        audio={"output_rate": 24000, "voice": "joanna"},
    )

    assert model_custom.model_id == NOVA_SONIC_V1_MODEL_ID
    assert model_custom.get_audio_config()["output_rate"] == 24000
    assert model_custom.get_audio_config()["voice"] == "joanna"


@pytest.mark.asyncio
async def test_nova_sonic_v2_instantiation(boto_session, mock_client):
    """Test direct instantiation with Nova Sonic v2 model ID."""
    _ = mock_client  # Ensure mock is active

    # Test default creation
    model = BedrockNovaSonicModel(model_id=NOVA_SONIC_V2_MODEL_ID, boto_session=boto_session)
    assert model.model_id == NOVA_SONIC_V2_MODEL_ID
    assert model.region == "us-east-1"

    # Test with custom config
    model_custom = BedrockNovaSonicModel(
        model_id=NOVA_SONIC_V2_MODEL_ID,
        boto_session=boto_session,
        audio={"input_rate": 48000, "voice": "ruth"},
        params={"inferenceConfiguration": {"temperature": 0.8}},
    )

    assert model_custom.model_id == NOVA_SONIC_V2_MODEL_ID
    assert model_custom.get_audio_config()["input_rate"] == 48000
    assert (
        json.loads(model_custom._get_connection_start_event())["event"]["sessionStart"]["inferenceConfiguration"][
            "temperature"
        ]
        == 0.8
    )


@pytest.mark.asyncio
async def test_nova_sonic_v1_v2_compatibility(boto_session, mock_client):
    """Test that v1 and v2 models have the same config structure and behavior."""
    _ = mock_client  # Ensure mock is active

    # Create both models with same config
    model_v1 = BedrockNovaSonicModel(
        model_id=NOVA_SONIC_V1_MODEL_ID,
        boto_session=boto_session,
        audio={"voice": "matthew"},
    )
    model_v2 = BedrockNovaSonicModel(
        model_id=NOVA_SONIC_V2_MODEL_ID,
        boto_session=boto_session,
        audio={"voice": "matthew"},
    )

    assert model_v1.get_audio_config() == model_v2.get_audio_config()
    assert model_v1.region == model_v2.region

    # Only model_id should differ
    assert model_v1.model_id != model_v2.model_id
    assert model_v1.model_id == NOVA_SONIC_V1_MODEL_ID
    assert model_v2.model_id == NOVA_SONIC_V2_MODEL_ID


@pytest.mark.asyncio
async def test_backward_compatibility(boto_session, mock_client):
    """Test that existing code continues to work (backward compatibility)."""
    _ = mock_client  # Ensure mock is active

    # Test that default behavior now uses v2 (updated default)
    model_default = BedrockNovaSonicModel(boto_session=boto_session)
    assert model_default.model_id == NOVA_SONIC_V2_MODEL_ID

    # Test that existing explicit v1 usage still works
    model_explicit_v1 = BedrockNovaSonicModel(model_id=NOVA_SONIC_V1_MODEL_ID, boto_session=boto_session)
    assert model_explicit_v1.model_id == NOVA_SONIC_V1_MODEL_ID

    # Test that explicit v2 usage works
    model_explicit_v2 = BedrockNovaSonicModel(model_id=NOVA_SONIC_V2_MODEL_ID, boto_session=boto_session)
    assert model_explicit_v2.model_id == NOVA_SONIC_V2_MODEL_ID


def test_params_passed_to_session_start(boto_session):
    """Provider parameters are passed directly to the Nova session start event."""
    params = {
        "inferenceConfiguration": {"temperature": 0.8},
        "turnDetectionConfiguration": {"endpointingSensitivity": "MEDIUM"},
    }
    model = BedrockNovaSonicModel(
        model_id=NOVA_SONIC_V1_MODEL_ID,
        params=params,
        boto_session=boto_session,
    )

    session_start = json.loads(model._get_connection_start_event())["event"]["sessionStart"]

    assert session_start == params


@pytest.mark.parametrize("params", [{"inferenceConfiguration": {"topP": 0.9}}, {}, None])
def test_update_config_replaces_params(boto_session, params):
    model = BedrockNovaSonicModel(
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

    with pytest.raises(BidiModelTimeoutError, match=r"Connection timeout"):
        async for _ in nova_model.receive():
            pass


@pytest.mark.asyncio
async def test_bidi_nova_sonic_model_receive_timeout_validation(nova_model, mock_stream):
    mock_output = AsyncMock()
    mock_output.receive.side_effect = ValidationException("InternalErrorCode=531: Request timeout")
    mock_stream.await_output.return_value = (None, mock_output)

    await nova_model.start()

    with pytest.raises(BidiModelTimeoutError, match=r"InternalErrorCode=531"):
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

    nova_model.update_config(model_id=NOVA_SONIC_V2_MODEL_ID)
    await nova_model.start()

    # Bounded so a regression (busy-loop) fails fast instead of hanging the suite.
    events = await asyncio.wait_for(alist(nova_model.receive()), timeout=5.0)

    # Only the initial connection-start event precedes the end-of-stream.
    assert [type(event).__name__ for event in events] == ["BidiConnectionStartEvent"]
    assert events[0].model == NOVA_SONIC_V2_MODEL_ID
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

    tool_result: ToolResult = {
        "toolUseId": "tool-123",
        "status": "success",
        "content": [{"text": "Single result"}],
    }

    await nova_model.send(ToolResultEvent(tool_result))

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

    tool_result: ToolResult = {
        "toolUseId": "tool-456",
        "status": "success",
        "content": [{"text": "Part 1"}, {"json": {"data": "value"}}],
    }

    await nova_model.send(ToolResultEvent(tool_result))

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

    tool_result: ToolResult = {
        "toolUseId": "tool-789",
        "status": "success",
        "content": [],
    }

    await nova_model.send(ToolResultEvent(tool_result))

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
    tool_result_image: ToolResult = {
        "toolUseId": "tool-999",
        "status": "success",
        "content": [{"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by Nova Sonic"):
        await nova_model.send(ToolResultEvent(tool_result_image))

    # Test with document content (unsupported)
    tool_result_doc: ToolResult = {
        "toolUseId": "tool-888",
        "status": "success",
        "content": [{"document": {"format": "pdf", "source": {"bytes": b"doc_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by Nova Sonic"):
        await nova_model.send(ToolResultEvent(tool_result_doc))

    # Test with mixed content (one unsupported)
    tool_result_mixed: ToolResult = {
        "toolUseId": "tool-777",
        "status": "success",
        "content": [{"text": "Valid text"}, {"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by Nova Sonic"):
        await nova_model.send(ToolResultEvent(tool_result_mixed))

    await nova_model.stop()
