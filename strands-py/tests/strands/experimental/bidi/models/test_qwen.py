"""Unit tests for the Qwen Realtime bidirectional streaming model."""

import base64
import json
import unittest.mock

import pytest

from strands.experimental.bidi.models.qwen import (
    DEFAULT_MODEL,
    QWEN_REALTIME_URL,
    QWEN_RESTART_AFTER_S,
    QwenRealtimeModel,
)
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiImageInputEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
)
from strands.types._events import ToolResultEvent, ToolUseStreamEvent
from strands.types.tools import ToolResult


@pytest.fixture
def mock_websocket():
    """Create a mock WebSocket connection."""
    websocket = unittest.mock.AsyncMock()
    websocket.send = unittest.mock.AsyncMock()
    websocket.close = unittest.mock.AsyncMock()
    return websocket


@pytest.fixture
def mock_websockets_connect(mock_websocket):
    """Mock websockets.connect."""

    async def connect(*args, **kwargs):
        return mock_websocket

    with unittest.mock.patch("strands.experimental.bidi.models.qwen.websockets.connect") as mock_connect:
        mock_connect.side_effect = connect
        yield mock_connect, mock_websocket


@pytest.fixture
def model(mock_websockets_connect):
    """Create a Qwen realtime model."""
    return QwenRealtimeModel(client_config={"api_key": "test-key"})


@pytest.fixture
def tool_spec():
    """Create a calculator tool specification."""
    return {
        "description": "Calculate mathematical expressions",
        "name": "calculator",
        "inputSchema": {"json": {"type": "object", "properties": {"expression": {"type": "string"}}}},
    }


def _sent_events(websocket) -> list[dict]:
    """Decode all events sent through a mock WebSocket."""
    return [json.loads(call.args[0]) for call in websocket.send.call_args_list]


def test_model_initialization_and_authentication(monkeypatch):
    """Test defaults, explicit API key precedence, and environment fallback."""
    configured = QwenRealtimeModel(client_config={"api_key": "configured-key"})
    assert configured.model_id == DEFAULT_MODEL
    assert configured.api_key == "configured-key"
    assert configured.audio_config == {
        "input_rate": 16000,
        "output_rate": 24000,
        "channels": 1,
        "format": "pcm",
        "voice": "Tina",
    }
    assert configured.connection_config["restart_after_s"] == QWEN_RESTART_AFTER_S

    monkeypatch.setenv("DASHSCOPE_API_KEY", "env-key")
    from_environment = QwenRealtimeModel()
    assert from_environment.api_key == "env-key"

    monkeypatch.delenv("DASHSCOPE_API_KEY")
    with pytest.raises(ValueError, match="DashScope API key is required"):
        QwenRealtimeModel()


def test_url_resolution_and_vad_validation():
    """Test endpoint overrides, regional workspace URLs, and required VAD."""
    custom = QwenRealtimeModel(
        model_id="qwen3.5-omni-plus-realtime",
        client_config={"api_key": "test-key", "url": "wss://example.test/realtime?tenant=one"},
    )
    assert custom.url == "wss://example.test/realtime?tenant=one&model=qwen3.5-omni-plus-realtime"

    regional = QwenRealtimeModel(
        client_config={
            "api_key": "test-key",
            "workspace_id": "workspace-123",
            "region": "ap-southeast-1",
        }
    )
    assert regional.url == (
        f"wss://workspace-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model={DEFAULT_MODEL}"
    )

    with pytest.raises(ValueError, match="turn_detection cannot be disabled"):
        QwenRealtimeModel(
            client_config={"api_key": "test-key"},
            provider_config={"inference": {"turn_detection": None}},
        )

    partial_vad = QwenRealtimeModel(
        client_config={"api_key": "test-key"},
        provider_config={"inference": {"turn_detection": {"threshold": 0.8}}},
    )
    assert partial_vad.config["inference"]["turn_detection"] == {
        "type": "server_vad",
        "threshold": 0.8,
        "silence_duration_ms": 800,
    }


@pytest.mark.asyncio
async def test_start_sends_session_config_and_unique_event_ids(mock_websockets_connect, tool_spec):
    """Test connection headers and the initial session.update payload."""
    mock_connect, websocket = mock_websockets_connect
    model = QwenRealtimeModel(
        client_config={"api_key": "test-key"},
        provider_config={"audio": {"voice": "Ethan"}, "inference": {"temperature": 0.4}},
    )

    await model.start(system_prompt="Be concise", tools=[tool_spec])

    mock_connect.assert_called_once_with(
        f"{QWEN_REALTIME_URL}?model={DEFAULT_MODEL}",
        additional_headers=[("Authorization", "Bearer test-key")],
    )
    session_update = _sent_events(websocket)[0]
    assert session_update["type"] == "session.update"
    assert session_update["event_id"].startswith("event_")
    assert session_update["session"] == {
        "model": DEFAULT_MODEL,
        "modalities": ["text", "audio"],
        "voice": "Ethan",
        "audio": {
            "input": {"format": {"type": "pcm", "sample_rate": 16000}},
            "output": {"format": {"type": "pcm", "sample_rate": 24000}},
        },
        "turn_detection": {"type": "server_vad", "threshold": 0.5, "silence_duration_ms": 800},
        "input_audio_transcription": {"model": "qwen3-asr-flash-realtime"},
        "temperature": 0.4,
        "instructions": "Be concise",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "calculator",
                    "description": "Calculate mathematical expressions",
                    "parameters": {
                        "type": "object",
                        "properties": {"expression": {"type": "string"}},
                    },
                },
            }
        ],
    }

    await model.send(BidiTextInputEvent(text="hello"))
    event_ids = [event["event_id"] for event in _sent_events(websocket)]
    assert len(event_ids) == len(set(event_ids))


@pytest.mark.asyncio
async def test_start_rejects_search_with_tools(mock_websockets_connect, tool_spec):
    """Test that Qwen's mutually exclusive search and tools options fail explicitly."""
    model = QwenRealtimeModel(
        client_config={"api_key": "test-key"},
        provider_config={"inference": {"enable_search": True}},
    )

    with pytest.raises(ValueError, match="enable_search and tools"):
        await model.start(tools=[tool_spec])


@pytest.mark.asyncio
async def test_send_text_audio_image_and_tool_result(mock_websockets_connect, model):
    """Test all supported client input event conversions."""
    _, websocket = mock_websockets_connect
    await model.start()
    websocket.send.reset_mock()

    await model.send(BidiTextInputEvent(text="hello"))
    await model.send(
        BidiAudioInputEvent(
            audio=base64.b64encode(b"audio").decode(),
            format="pcm",
            sample_rate=16000,
            channels=1,
        )
    )
    await model.send(BidiImageInputEvent(image=base64.b64encode(b"image").decode(), mime_type="image/jpeg"))
    tool_result: ToolResult = {
        "toolUseId": "call-123",
        "status": "success",
        "content": [{"json": {"answer": 42}}],
    }
    await model.send(ToolResultEvent(tool_result))

    events = _sent_events(websocket)
    assert [event["type"] for event in events] == [
        "conversation.item.create",
        "response.create",
        "input_audio_buffer.append",
        "input_image_buffer.append",
        "conversation.item.create",
        "response.create",
    ]
    assert events[0]["item"]["content"] == [{"type": "input_text", "text": "hello"}]
    assert events[3]["image"] == base64.b64encode(b"image").decode()
    assert events[4]["item"]["type"] == "function_call_output"
    assert json.loads(events[4]["item"]["output"]) == [{"json": {"answer": 42}}]


@pytest.mark.asyncio
async def test_image_requires_audio_in_current_turn(mock_websockets_connect, model):
    """Test Qwen's image buffer ordering constraint."""
    await model.start()
    image = BidiImageInputEvent(image="image-data", mime_type="image/jpeg")

    with pytest.raises(ValueError, match="audio input must be sent before image input"):
        await model.send(image)

    await model.send(BidiAudioInputEvent(audio="audio-data", format="pcm", sample_rate=16000, channels=1))
    await model.send(image)
    model._convert_qwen_event({"type": "input_audio_buffer.committed"})
    with pytest.raises(ValueError, match="audio input must be sent before image input"):
        await model.send(image)


def test_event_conversion(model):
    """Test response, transcript, audio, interruption, and usage conversion."""
    started = model._convert_qwen_event({"type": "response.created", "response": {"id": "resp-1"}})
    assert started == [BidiResponseStartEvent(response_id="resp-1")]

    text_delta = model._convert_qwen_event({"type": "response.text.delta", "delta": "Hello"})
    assert isinstance(text_delta[0], BidiTranscriptStreamEvent)
    assert text_delta[0].text == "Hello"
    assert text_delta[0].role == "assistant"
    assert not text_delta[0].is_final

    audio = model._convert_qwen_event({"type": "response.audio.delta", "delta": "audio-data"})
    assert audio == [BidiAudioStreamEvent(audio="audio-data", format="pcm", sample_rate=24000, channels=1)]

    preview = model._convert_qwen_event(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "text": "今天天气",
            "stash": "怎么样？",
        }
    )
    assert preview[0].text == "今天天气怎么样？"
    assert preview[0].role == "user"
    assert not preview[0].is_final

    completed = model._convert_qwen_event(
        {"type": "conversation.item.input_audio_transcription.completed", "transcript": "你好"}
    )
    assert completed[0].text == "你好"
    assert completed[0].is_final

    interruption = model._convert_qwen_event({"type": "input_audio_buffer.speech_started"})
    assert interruption == [BidiInterruptionEvent(reason="user_speech")]

    done = model._convert_qwen_event(
        {
            "type": "response.done",
            "response": {
                "id": "resp-1",
                "status": "completed",
                "usage": {
                    "input_tokens": 7,
                    "output_tokens": 5,
                    "total_tokens": 12,
                    "input_tokens_details": {"text_tokens": 4, "audio_tokens": 3},
                    "output_tokens_details": {"text_tokens": 2, "audio_tokens": 3},
                },
            },
        }
    )
    assert done[0] == BidiResponseCompleteEvent(response_id="resp-1", stop_reason="complete")
    assert isinstance(done[1], BidiUsageEvent)
    assert done[1].input_tokens == 7
    assert done[1].output_tokens == 5
    assert done[1].modality_details == [
        {"modality": "text", "input_tokens": 4, "output_tokens": 2},
        {"modality": "audio", "input_tokens": 3, "output_tokens": 3},
    ]


def test_function_call_argument_accumulation(model, caplog):
    """Test streamed function arguments and malformed JSON handling."""
    model._convert_qwen_event(
        {
            "type": "response.output_item.added",
            "item": {"type": "function_call", "call_id": "call-1", "name": "calculator", "arguments": ""},
        }
    )
    model._convert_qwen_event(
        {"type": "response.function_call_arguments.delta", "call_id": "call-1", "delta": '{"expression":'}
    )
    model._convert_qwen_event(
        {"type": "response.function_call_arguments.delta", "call_id": "call-1", "delta": '"2+2"}'}
    )
    completed = model._convert_qwen_event(
        {"type": "response.function_call_arguments.done", "call_id": "call-1", "name": "calculator"}
    )

    assert isinstance(completed[0], ToolUseStreamEvent)
    assert completed[0]["current_tool_use"] == {
        "toolUseId": "call-1",
        "name": "calculator",
        "input": {"expression": "2+2"},
    }

    malformed = model._convert_qwen_event(
        {
            "type": "response.function_call_arguments.done",
            "call_id": "call-2",
            "name": "calculator",
            "arguments": "{broken",
        }
    )
    assert malformed is None
    assert "error parsing qwen function arguments" in caplog.text


@pytest.mark.asyncio
async def test_stop_is_idempotent_and_restart_replays_history(mock_websockets_connect, model):
    """Test clean shutdown and reconnect history replay."""
    mock_connect, websocket = mock_websockets_connect
    messages = [
        {"role": "user", "content": [{"text": "question"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "call-1", "name": "lookup", "input": {"id": 1}}}],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "call-1",
                        "status": "success",
                        "content": [{"text": "found"}],
                    }
                }
            ],
        },
    ]

    await model.start()
    await model.restart(messages=messages)
    assert mock_connect.call_count == 2
    assert websocket.close.await_count == 1

    events = _sent_events(websocket)
    replay_items = [event["item"] for event in events if event["type"] == "conversation.item.create"]
    assert [item["type"] for item in replay_items] == ["message", "function_call", "function_call_output"]

    await model.stop()
    await model.stop()
    assert websocket.close.await_count == 2
    assert _sent_events(websocket)[-1]["type"] == "session.finish"
