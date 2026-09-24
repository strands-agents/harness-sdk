"""Unit tests for OpenAI Realtime bidirectional streaming model.

Tests the unified OpenAIRealtimeModel interface including:
- Model initialization and configuration
- Connection establishment with WebSocket
- Unified send() method with different content types
- Event receiving and conversion
- Connection lifecycle management
"""

import asyncio
import base64
import itertools
import json
import unittest.mock

import pytest

from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.models import ConnectionTimeoutError, OpenAIRealtimeModel
from strands.experimental.bidi.models.openai import (
    _RESTART_INSTRUCTION,
    OPENAI_MAX_TIMEOUT_S,
    OPENAI_PROACTIVE_RECONNECT_MARGIN_S,
)
from strands.experimental.bidi.types import (
    AudioDelta,
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiConnectionStartEvent,
    BidiResponseInterruptEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
)
from strands.types.content import TextBlock
from strands.types.media import ImageBlock
from strands.types.tools import ToolResultBlock


@pytest.fixture
def mock_websocket():
    """Mock WebSocket connection."""
    mock_ws = unittest.mock.AsyncMock()
    mock_ws.send = unittest.mock.AsyncMock()
    mock_ws.close = unittest.mock.AsyncMock()
    return mock_ws


@pytest.fixture
def mock_websockets_connect(mock_websocket):
    """Mock websockets.connect function."""

    async def async_connect(*args, **kwargs):
        return mock_websocket

    with unittest.mock.patch("strands.experimental.bidi.models.openai.websockets.connect") as mock_connect:
        mock_connect.side_effect = async_connect
        yield mock_connect, mock_websocket


@pytest.fixture
def model_id():
    return "gpt-realtime-2.1"


@pytest.fixture
def api_key():
    return "test-api-key"


@pytest.fixture
def model(mock_websockets_connect, api_key, model_id):
    """Create an OpenAIRealtimeModel instance."""
    return OpenAIRealtimeModel(transcription_model_id="gpt-4o-transcribe", model_id=model_id, api_key=api_key)


@pytest.fixture
def tool_spec():
    return {
        "description": "Calculate mathematical expressions",
        "name": "calculator",
        "inputSchema": {"json": {"type": "object", "properties": {"expression": {"type": "string"}}}},
    }


@pytest.fixture
def system_prompt():
    return "You are a helpful assistant"


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "Hello"}]}]


@pytest.mark.asyncio
async def test_receive_preserves_native_order_with_late_transcription(model, mock_websocket, model_id):
    native_events = [
        {"type": "input_audio_buffer.committed", "item_id": "user-1"},
        {"type": "response.created", "response": {"id": "r1"}},
        {"type": "response.created", "response": {"id": "r1"}},
        {"type": "response.cancelled", "response": {"id": "r1"}},
        {"type": "response.done", "response": {"id": "r1", "status": "cancelled"}},
        {"type": "response.done", "response": {"id": "r1", "status": "cancelled"}},
        {"type": "response.created", "response": {"id": "r1"}},
        {"type": "conversation.item.input_audio_transcription.delta", "item_id": "user-1", "delta": "Earlier input."},
        {"type": "response.created", "response": {"id": "r2"}},
        {"type": "response.done", "response": {"id": "r2", "status": "completed"}},
        {"type": "input_audio_buffer.committed", "item_id": "user-2"},
        {"type": "conversation.item.input_audio_transcription.delta", "item_id": "user-2", "delta": "Hi"},
        {"type": "conversation.item.input_audio_transcription.completed", "item_id": "user-2", "transcript": "Hi"},
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "user-1",
            "transcript": "Earlier input.",
        },
    ]
    mock_websocket.recv.side_effect = [json.dumps(event) for event in native_events]
    exp_events = [
        BidiConnectionStartEvent(connection_id=unittest.mock.ANY, model=model_id),
        BidiTranscriptStartEvent("user", content_id="user-1"),
        BidiResponseStartEvent("r1"),
        BidiResponseStopEvent("r1", "interrupt"),
        BidiTranscriptDeltaEvent("Earlier input.", "user", content_id="user-1"),
        BidiResponseStartEvent("r2"),
        BidiResponseStopEvent("r2", "end_turn"),
        BidiTranscriptStartEvent("user", content_id="user-2"),
        BidiTranscriptDeltaEvent("Hi", "user", content_id="user-2"),
        BidiTranscriptStopEvent("Hi", "user", content_id="user-2"),
        BidiTranscriptStopEvent("Earlier input.", "user", content_id="user-1"),
    ]

    await model.start()
    reader = model.receive()
    try:
        tru_events = [await anext(reader) for _ in exp_events]
        assert tru_events == exp_events
    finally:
        await reader.aclose()
        await model.stop()


# Initialization Tests


def test_model_initialization(api_key, model_id, monkeypatch):
    """Test model initialization with various configurations."""
    model_default = OpenAIRealtimeModel(
        model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key="test-key"
    )
    assert model_default.model_id == model_id
    assert model_default.api_key == "test-key"
    tru_config = model_default.get_config()
    exp_config = {
        "model_id": model_id,
        "params": {},
        "connection": {"restart_after_s": OPENAI_MAX_TIMEOUT_S - OPENAI_PROACTIVE_RECONNECT_MARGIN_S},
    }
    assert tru_config == exp_config
    tru_config["model_id"] = "updated-model"
    exp_config["model_id"] = "updated-model"
    assert model_default.get_config() == exp_config
    assert model_default.get_config() is tru_config

    model_default.update_config()
    assert model_default.get_config() == exp_config
    assert model_default.get_config() is tru_config

    model_custom = OpenAIRealtimeModel(
        transcription_model_id="gpt-4o-transcribe",
        model_id=model_id,
        api_key=api_key,
        organization="org-explicit",
        project="proj-explicit",
    )
    assert model_custom.model_id == model_id
    assert model_custom.api_key == api_key
    assert model_custom.organization == "org-explicit"
    assert model_custom.project == "proj-explicit"

    monkeypatch.setenv("OPENAI_ORGANIZATION", "org-123")
    monkeypatch.setenv("OPENAI_PROJECT", "proj-456")
    model_env = OpenAIRealtimeModel(transcription_model_id="gpt-4o-transcribe", model_id=model_id, api_key=api_key)
    assert model_env.organization == "org-123"
    assert model_env.project == "proj-456"

    # Test with env API key
    monkeypatch.setenv("OPENAI_API_KEY", "env-key")
    model_env = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe")
    assert model_env.api_key == "env-key"


@pytest.mark.parametrize("model_config", [{}, {"model_id": None}, {"model_id": ""}, {"model_id": 123}])
def test__init__rejects_invalid_model_id(api_key, model_config):
    with pytest.raises(ValueError, match="model_id"):
        OpenAIRealtimeModel(transcription_model_id="gpt-4o-transcribe", api_key=api_key, **model_config)


@pytest.mark.parametrize("invalid_model_id", [None, "", 123])
def test_update_config_rejects_invalid_model_id(model, invalid_model_id):
    config = model.get_config()
    exp_config = dict(config)
    audio_config = model.get_audio_config()

    with pytest.raises(ValueError, match="model_id must be a non-empty string"):
        model.update_config(model_id=invalid_model_id, params={"max_output_tokens": 2048}, connection={})

    tru_config = model.get_config()
    assert tru_config == exp_config
    assert tru_config is config
    assert model.get_audio_config() is audio_config


# Audio Configuration Tests


@pytest.mark.parametrize(
    ("options", "voice"),
    [
        pytest.param({}, "alloy", id="defaults"),
        pytest.param({"voice": "echo"}, "echo", id="custom-voice"),
    ],
)
def test_get_audio_config(model_id, api_key, options, voice):
    model = OpenAIRealtimeModel(
        model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key, **options
    )

    tru_config = model.get_audio_config()
    exp_config = {
        "input": {"sample_rate": 24000, "channels": 1, "format": "pcm"},
        "output": {"sample_rate": 24000, "channels": 1, "format": "pcm"},
    }
    assert tru_config == exp_config
    assert model.get_audio_config() is tru_config

    tru_output = model._build_session_config(None, None)["audio"]["output"]
    exp_output = {"format": {"type": "audio/pcm", "rate": 24000}, "voice": voice}
    assert tru_output == exp_output


@pytest.mark.parametrize("direction", ["input", "output"])
@pytest.mark.parametrize(
    "audio_format",
    [
        {"rate": 48000},
        {"rate": None},
        {"type": "audio/pcmu"},
        {"type": "audio/pcma"},
        {"type": "audio/mp3"},
    ],
)
def test__init__rejects_unsupported_audio_format(model_id, api_key, direction, audio_format):
    with pytest.raises(ValueError, match="Unsupported"):
        OpenAIRealtimeModel(
            model_id=model_id,
            transcription_model_id="gpt-4o-transcribe",
            api_key=api_key,
            params={"audio": {direction: {"format": audio_format}}},
        )


@pytest.mark.parametrize("direction", ["input", "output"])
@pytest.mark.parametrize(
    "audio_format",
    [
        {"type": "audio/pcmu"},
        {"rate": 16000},
    ],
)
def test_update_config_rejects_unsupported_audio_format(model_id, api_key, direction, audio_format):
    model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id="gpt-4o-transcribe",
        api_key=api_key,
        params={"max_output_tokens": 2048},
    )
    audio_config = model.get_audio_config()

    with pytest.raises(ValueError, match="Unsupported"):
        model.update_config(model_id="updated-model", params={"audio": {direction: {"format": audio_format}}})

    tru_config = model.get_config()
    exp_config = {
        "model_id": "gpt-realtime-2.1",
        "params": {"max_output_tokens": 2048},
        "connection": {"restart_after_s": OPENAI_MAX_TIMEOUT_S - OPENAI_PROACTIVE_RECONNECT_MARGIN_S},
    }
    assert tru_config == exp_config
    assert model.get_audio_config() is audio_config


def test_init_without_api_key_raises(model_id, monkeypatch):
    """Test that initialization without API key raises error."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="OpenAI API key is required"):
        OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe")


# Connection Tests


@pytest.mark.asyncio
async def test_connection_lifecycle(mock_websockets_connect, model, system_prompt, tool_spec, messages):
    """Test complete connection lifecycle with various configurations."""
    mock_connect, mock_ws = mock_websockets_connect

    # Test basic connection
    await model.start()
    assert model._connection_id is not None
    assert model._websocket == mock_ws
    mock_connect.assert_called_once()

    # Test close
    await model.stop()

    mock_ws.close.assert_called_once()

    # Test connection with system prompt
    mock_ws.send.reset_mock()
    await model.start(system_prompt=system_prompt)
    session_update = json.loads(mock_ws.send.call_args.args[0])
    assert session_update["type"] == "session.update"
    assert session_update["session"]["instructions"] == system_prompt
    await model.stop()

    # Test connection with tools
    mock_ws.send.reset_mock()
    await model.start(tools=[tool_spec])
    session_update = json.loads(mock_ws.send.call_args.args[0])
    assert session_update["session"]["tools"][0]["name"] == tool_spec["name"]
    await model.stop()

    # Test connection with messages
    mock_ws.send.reset_mock()
    await model.start(messages=messages)
    events = [json.loads(call.args[0]) for call in mock_ws.send.call_args_list]
    item_creates = [event for event in events if event["type"] == "conversation.item.create"]
    assert len(item_creates) > 0
    await model.stop()


@pytest.mark.asyncio
async def test_connection_with_org_header(model_id, mock_websockets_connect, monkeypatch):
    """Test connection with organization header from environment."""
    mock_connect, mock_ws = mock_websockets_connect

    monkeypatch.setenv("OPENAI_ORGANIZATION", "org-123")
    model_org = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key="test-key")
    await model_org.start()
    call_kwargs = mock_connect.call_args.kwargs
    headers = call_kwargs.get("additional_headers", [])
    org_header = [h for h in headers if h[0] == "OpenAI-Organization"]
    assert len(org_header) == 1
    assert org_header[0][1] == "org-123"
    await model_org.stop()


@pytest.mark.asyncio
async def test_connection_with_message_history(mock_websockets_connect, model):
    """Test connection initialization with conversation history including tool calls."""
    _, mock_ws = mock_websockets_connect

    # Create message history with various content types
    messages = [
        {"role": "user", "content": [{"text": "What's the weather?"}]},
        {"role": "assistant", "content": [{"text": "I'll check the weather for you."}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "call-123", "name": "get_weather", "input": {"location": "Seattle"}}}
            ],
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "call-123", "content": [{"text": "Sunny, 72°F"}]}}],
        },
        {"role": "assistant", "content": [{"text": "It's sunny and 72 degrees."}]},
    ]

    # Start connection with message history
    await model.start(messages=messages)

    # Get all sent events
    calls = mock_ws.send.call_args_list
    sent_events = [json.loads(call[0][0]) for call in calls]

    # Filter conversation.item.create events
    item_creates = [e for e in sent_events if e.get("type") == "conversation.item.create"]

    # Should have 5 items: 2 messages, 1 function_call, 1 function_call_output, 1 message
    assert len(item_creates) >= 5

    # Verify message items
    message_items = [e for e in item_creates if e.get("item", {}).get("type") == "message"]
    assert len(message_items) >= 3

    # Verify first user message
    user_msg = message_items[0]
    assert user_msg["item"]["role"] == "user"
    assert user_msg["item"]["content"][0]["text"] == "What's the weather?"

    # Verify function call item
    function_call_items = [e for e in item_creates if e.get("item", {}).get("type") == "function_call"]
    assert len(function_call_items) >= 1
    func_call = function_call_items[0]
    assert func_call["item"]["call_id"] == "call-123"
    assert func_call["item"]["name"] == "get_weather"
    assert json.loads(func_call["item"]["arguments"]) == {"location": "Seattle"}

    # Verify function call output item
    function_output_items = [e for e in item_creates if e.get("item", {}).get("type") == "function_call_output"]
    assert len(function_output_items) >= 1
    func_output = function_output_items[0]
    assert func_output["item"]["call_id"] == "call-123"
    # Content is now preserved as JSON array
    output = json.loads(func_output["item"]["output"])
    assert output == [{"text": "Sunny, 72°F"}]

    await model.stop()


@pytest.mark.asyncio
async def test_connection_edge_cases(mock_websockets_connect, api_key, model_id):
    """Test connection error handling and edge cases."""
    mock_connect, mock_ws = mock_websockets_connect

    # Test connection error
    model1 = OpenAIRealtimeModel(transcription_model_id="gpt-4o-transcribe", model_id=model_id, api_key=api_key)
    mock_connect.side_effect = Exception("Connection failed")
    with pytest.raises(Exception, match="Connection failed"):
        await model1.start()

    # Reset mock
    async def async_connect(*args, **kwargs):
        return mock_ws

    mock_connect.side_effect = async_connect

    # Test double connection
    model2 = OpenAIRealtimeModel(transcription_model_id="gpt-4o-transcribe", model_id=model_id, api_key=api_key)
    await model2.start()
    with pytest.raises(RuntimeError, match=r"call stop before starting again"):
        await model2.start()
    await model2.stop()

    # Test close when not connected
    model3 = OpenAIRealtimeModel(transcription_model_id="gpt-4o-transcribe", model_id=model_id, api_key=api_key)
    await model3.stop()  # Should not raise

    # Test close error
    model4 = OpenAIRealtimeModel(transcription_model_id="gpt-4o-transcribe", model_id=model_id, api_key=api_key)
    await model4.start()
    mock_ws.close.side_effect = Exception("Close failed")
    with pytest.raises(Exception, match=r"failed stop sequence"):
        await model4.stop()


# Send Method Tests


@pytest.mark.asyncio
async def test_send_all_content_types(mock_websockets_connect, model):
    """Test sending all content types through unified send() method."""
    _, mock_ws = mock_websockets_connect
    await model.start()

    # Test text input
    assert await model.send(TextBlock("Hello")) is None
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]
    response_create = [m for m in messages if m.get("type") == "response.create"]
    assert len(item_create) > 0
    assert len(response_create) > 0
    assert item_create[-1] == {
        "type": "conversation.item.create",
        "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
    }

    # Test audio input
    audio_b64 = base64.b64encode(b"audio_bytes").decode("utf-8")
    assert await model.send(AudioDelta(format="pcm", source={"bytes": b"audio_bytes"})) is None
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    audio_append = [m for m in messages if m.get("type") == "input_audio_buffer.append"]
    assert len(audio_append) > 0
    assert "audio" in audio_append[0]
    # Audio should be passed through as base64
    assert audio_append[0]["audio"] == audio_b64

    # Test tool result with text content
    tool_result = ToolResultBlock(tool_use_id="tool-123", status="success", content=[{"text": "Result: 42"}])
    await model.send(tool_result)
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]
    assert len(item_create) > 0
    item = item_create[-1].get("item", {})
    assert item.get("type") == "function_call_output"
    assert item.get("call_id") == "tool-123"
    # Content is now preserved as JSON array
    output = json.loads(item.get("output"))
    assert output == [{"text": "Result: 42"}]

    # Test tool result with JSON content
    tool_result_json = ToolResultBlock(
        tool_use_id="tool-456", status="success", content=[{"json": {"result": 42, "status": "ok"}}]
    )
    await model.send(tool_result_json)
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]
    item = item_create[-1].get("item", {})
    assert item.get("type") == "function_call_output"
    assert item.get("call_id") == "tool-456"
    # Content is now preserved as JSON array
    output = json.loads(item.get("output"))
    assert output == [{"json": {"result": 42, "status": "ok"}}]

    # Test tool result with multiple content blocks
    tool_result_multi = ToolResultBlock(
        tool_use_id="tool-789",
        status="success",
        content=[{"text": "Part 1"}, {"json": {"data": "value"}}, {"text": "Part 2"}],
    )
    await model.send(tool_result_multi)
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]
    item = item_create[-1].get("item", {})
    assert item.get("type") == "function_call_output"
    assert item.get("call_id") == "tool-789"
    # Content is now preserved as JSON array
    output = json.loads(item.get("output"))
    assert output == [{"text": "Part 1"}, {"json": {"data": "value"}}, {"text": "Part 2"}]

    # Test tool result with image content (should raise error)
    tool_result_image = ToolResultBlock(
        tool_use_id="tool-999",
        status="success",
        content=[{"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    )
    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(tool_result_image)

    # Test tool result with document content (should raise error)
    tool_result_doc = ToolResultBlock(
        tool_use_id="tool-888",
        status="success",
        content=[{"document": {"format": "pdf", "source": {"bytes": b"doc_data"}}}],
    )
    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(tool_result_doc)

    await model.stop()


@pytest.mark.asyncio
async def test_send_edge_cases(mock_websockets_connect, model):
    """Test send() edge cases and error handling."""
    _, mock_ws = mock_websockets_connect

    # Test send when inactive
    with pytest.raises(RuntimeError, match=r"call start before sending"):
        await model.send(TextBlock("Hello"))
    mock_ws.send.assert_not_called()

    # Test image input (sent as input_image content block on user message)
    await model.start()
    mock_ws.send.reset_mock()
    image_b64 = base64.b64encode(b"image_bytes").decode("utf-8")
    assert await model.send(ImageBlock(format="jpeg", source={"bytes": b"image_bytes"})) is None

    # Verify exactly one event was sent: a conversation.item.create with input_image
    image_calls = [json.loads(call[0][0]) for call in mock_ws.send.call_args_list]
    image_creates = [m for m in image_calls if m.get("type") == "conversation.item.create"]
    assert len(image_creates) == 1, "expected exactly one conversation.item.create for image"
    image_item = image_creates[0].get("item", {})
    assert image_item == {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_image", "image_url": f"data:image/jpeg;base64,{image_b64}"}],
    }
    # Image input must NOT auto-trigger a response — caller decides when to commit.
    assert not any(m.get("type") == "response.create" for m in image_calls)

    await model.stop()


# Receive Method Tests


@pytest.mark.asyncio
async def test_receive_lifecycle_events(mock_websocket, model):
    audio_message = '{"type": "response.output_audio.delta", "delta": ""}'
    mock_websocket.recv.return_value = audio_message
    model.update_config(model_id="updated-model")

    await model.start()

    receiver = model.receive()
    tru_events = [await anext(receiver) for _ in range(3)]
    exp_events = [
        BidiConnectionStartEvent(connection_id=model._connection_id, model="updated-model"),
        BidiAudioStartEvent(),
        BidiAudioDeltaEvent(
            audio="",
            format="pcm",
            sample_rate=24000,
            channels=1,
        ),
    ]
    assert tru_events == exp_events

    await receiver.aclose()
    await model.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("committed", [False, True])
async def test_receive_transcription_failure(mock_websocket, model, committed):
    await model.start()
    assistant_identity = {"response_id": "response-a", "item_id": "assistant-a", "content_index": 0}
    native_events = ([{"type": "input_audio_buffer.committed", "item_id": "speech-a"}] if committed else []) + [
        {
            "type": "conversation.item.input_audio_transcription.failed",
            "item_id": "speech-a",
            "error": {"message": "The audio could not be transcribed."},
        },
        {"type": "response.created", "response": {"id": "response-a"}},
        {"type": "response.output_audio_transcript.delta", **assistant_identity, "delta": "Hello."},
        {"type": "response.output_audio_transcript.done", **assistant_identity, "transcript": "Hello."},
        {
            "type": "response.done",
            "response": {
                "id": "response-a",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_audio", "transcript": "Hello."}],
                    }
                ],
            },
        },
    ]
    mock_websocket.recv.side_effect = [json.dumps(event) for event in native_events]
    exp_events = [
        BidiConnectionStartEvent(model._connection_id, model.get_config()["model_id"]),
        BidiTranscriptStartEvent("user", "speech-a"),
        BidiTranscriptStopEvent("", "user", "speech-a", error=RuntimeError("The audio could not be transcribed.")),
        BidiResponseStartEvent("response-a"),
        BidiTranscriptStartEvent("assistant", "response-a"),
        BidiTranscriptDeltaEvent("Hello.", "assistant", "response-a"),
        BidiTranscriptStopEvent("Hello.", "assistant", "response-a"),
        BidiResponseStopEvent("response-a", "end_turn"),
    ]
    receiver = model.receive()
    try:
        tru_events = [await anext(receiver) for _ in exp_events]
        assert tru_events == exp_events
    finally:
        await receiver.aclose()
        await model.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("second_item_id,second_content_index", [("item-2", 0), ("item-1", 1)])
@pytest.mark.parametrize(
    "status,stop_reason", [("completed", "end_turn"), ("cancelled", "interrupt"), ("failed", "error")]
)
async def test_receive_combines_assistant_content_in_one_transcript(
    model, mock_websocket, second_item_id, second_content_index, status, stop_reason
):
    """Native content parts stream immediately and complete one assistant transcript."""
    native_events = [{"type": "response.created", "response": {"id": "r1"}}]
    contents = [("item-1", 0, "Let me explain."), (second_item_id, second_content_index, "Here is the answer.")]
    output_items = {}
    for item_id, content_index, text in contents:
        identity = {"response_id": "r1", "item_id": item_id, "content_index": content_index}
        native_events.extend(
            [
                {"type": "response.output_audio_transcript.delta", **identity, "delta": text},
                {"type": "response.output_audio_transcript.done", **identity, "transcript": text},
            ]
        )
        item = output_items.setdefault(item_id, {"id": item_id, "type": "message", "role": "assistant", "content": []})
        item["content"].append({"type": "output_audio", "transcript": text})
    native_events.append(
        {"type": "response.done", "response": {"id": "r1", "status": status, "output": list(output_items.values())}}
    )
    exp_events = [
        BidiConnectionStartEvent(unittest.mock.ANY, model.model_id),
        BidiResponseStartEvent("r1"),
        BidiTranscriptStartEvent("assistant", "r1"),
        BidiTranscriptDeltaEvent("Let me explain.", "assistant", "r1"),
        BidiTranscriptDeltaEvent("\n\nHere is the answer.", "assistant", "r1"),
        BidiTranscriptStopEvent("Let me explain.\n\nHere is the answer.", "assistant", "r1"),
        BidiResponseStopEvent("r1", stop_reason),
    ]
    incoming = asyncio.Queue()
    for event in native_events:
        incoming.put_nowait(json.dumps(event))
    mock_websocket.recv.side_effect = incoming.get

    agent = BidiAgent(model=model)
    await agent.start()
    try:
        tru_events = []
        async with asyncio.timeout(2):
            async for event in agent.receive():
                tru_events.append(event)
                if isinstance(event, BidiResponseStopEvent):
                    break
        assert tru_events == exp_events
        assert [message["content"] for message in agent.messages] == [
            [{"text": "Let me explain.\n\nHere is the answer."}]
        ]
    finally:
        await agent.stop()


@unittest.mock.patch("strands.experimental.bidi.models.openai.time.time")
@pytest.mark.asyncio
async def test_receive_timeout(mock_time, model):
    mock_time.side_effect = itertools.count()
    model.timeout_s = 1

    await model.start()

    with pytest.raises(ConnectionTimeoutError, match=r"timeout_s=<1>"):
        async for _ in model.receive():
            pass


@pytest.mark.asyncio
async def test_event_conversion(model):
    """Test conversion of all OpenAI event types to standard format."""
    await model.start()

    # Audio starts before its first chunk.
    audio_event = {"type": "response.output_audio.delta", "delta": base64.b64encode(b"audio_data").decode()}
    converted = model._convert_openai_event(audio_event)
    assert converted == [
        BidiAudioStartEvent(),
        BidiAudioDeltaEvent(base64.b64encode(b"audio_data").decode(), format="pcm", sample_rate=24000, channels=1),
    ]

    # Test function call sequence
    item_added = {
        "type": "response.output_item.added",
        "item": {"type": "function_call", "call_id": "call-123", "name": "calculator"},
    }
    model._convert_openai_event(item_added)

    args_delta = {
        "type": "response.function_call_arguments.delta",
        "call_id": "call-123",
        "delta": '{"expression": "2+2"}',
    }
    model._convert_openai_event(args_delta)

    args_done = {"type": "response.function_call_arguments.done", "call_id": "call-123"}
    converted = model._convert_openai_event(args_done)
    # Now returns list with ToolUseStreamEvent
    assert isinstance(converted, list)
    assert len(converted) == 1
    # ToolUseStreamEvent has delta and current_tool_use, not a "type" field
    assert "delta" in converted[0]
    assert "toolUse" in converted[0]["delta"]
    tool_use = converted[0]["delta"]["toolUse"]
    assert tool_use["toolUseId"] == "call-123"
    assert tool_use["name"] == "calculator"
    assert json.loads(tool_use["input"]) == {"expression": "2+2"}
    assert converted[0]["current_tool_use"]["input"] == {"expression": "2+2"}

    speech_started = {"type": "input_audio_buffer.speech_started", "item_id": "speech"}
    tru_events = model._convert_openai_event(speech_started)
    exp_events = [
        BidiResponseInterruptEvent("user_speech"),
        BidiTranscriptStartEvent("user", "speech"),
    ]
    assert tru_events == exp_events

    response_cancelled = {"type": "response.done", "response": {"id": "resp_123", "status": "cancelled"}}
    converted = model._convert_openai_event(response_cancelled)
    assert converted == [BidiResponseStopEvent("resp_123", "interrupt")]

    # Test error handling - response_cancel_not_active should be suppressed
    error_cancel_not_active = {
        "type": "error",
        "error": {"code": "response_cancel_not_active", "message": "No active response to cancel"},
    }
    converted = model._convert_openai_event(error_cancel_not_active)
    assert converted is None  # Should be suppressed

    # Test error handling - other errors should be logged but return None
    error_other = {"type": "error", "error": {"code": "some_other_error", "message": "Something went wrong"}}
    converted = model._convert_openai_event(error_other)
    assert converted is None

    await model.stop()


@pytest.mark.parametrize(
    ("event", "expected"),
    [
        pytest.param(
            {"type": "response.output_text.delta", "delta": "Hello from OpenAI", "response_id": "response-1"},
            BidiTranscriptDeltaEvent("Hello from OpenAI", "assistant", content_id="response-1"),
            id="output_text_delta",
        ),
        pytest.param(
            {"type": "response.output_audio_transcript.delta", "delta": "Spoken response", "response_id": "response-1"},
            BidiTranscriptDeltaEvent("Spoken response", "assistant", content_id="response-1"),
            id="output_audio_transcript_delta",
        ),
        pytest.param(
            {"type": "response.output_text.delta", "delta": " ", "response_id": "response-1"},
            BidiTranscriptDeltaEvent(" ", "assistant", content_id="response-1"),
            id="whitespace_output_text_delta",
        ),
        pytest.param(
            {
                "type": "response.output_audio_transcript.done",
                "transcript": "Spoken response",
                "response_id": "response-1",
            },
            None,
            id="output_audio_transcript_done",
        ),
        pytest.param(
            {"type": "response.output_text.done", "text": "Hello from OpenAI", "response_id": "response-1"},
            None,
            id="output_text_done",
        ),
        pytest.param(
            {"type": "response.output_text.done", "text": "", "response_id": "response-1"},
            None,
            id="empty_output_text_done",
        ),
        pytest.param(
            {
                "type": "conversation.item.input_audio_transcription.delta",
                "delta": "User question",
                "item_id": "input-1",
            },
            BidiTranscriptDeltaEvent("User question", "user", content_id="input-1"),
            id="input_audio_transcription_delta",
        ),
        pytest.param(
            {"type": "conversation.item.input_audio_transcription.delta", "delta": " ", "item_id": "input-1"},
            BidiTranscriptDeltaEvent(" ", "user", content_id="input-1"),
            id="whitespace_input_audio_transcription_delta",
        ),
        pytest.param(
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "User question",
                "item_id": "input-1",
            },
            BidiTranscriptStopEvent("User question", "user", content_id="input-1"),
            id="input_audio_transcription_completed",
        ),
        pytest.param(
            {"type": "conversation.item.input_audio_transcription.completed", "transcript": "", "item_id": "input-1"},
            BidiTranscriptStopEvent("", "user", content_id="input-1"),
            id="empty_input_audio_transcription_completed",
        ),
        pytest.param(
            {
                "type": "conversation.item.input_audio_transcription.segment",
                "segment": {"text": "User question", "role": "user"},
                "item_id": "input-1",
            },
            BidiTranscriptDeltaEvent("User question", "user", content_id="input-1"),
            id="input_audio_transcription_segment",
        ),
        pytest.param(
            {
                "type": "conversation.item.input_audio_transcription.segment",
                "segment": {"text": " ", "role": "user"},
                "item_id": "input-1",
            },
            BidiTranscriptDeltaEvent(" ", "user", content_id="input-1"),
            id="whitespace_input_audio_transcription_segment",
        ),
    ],
)
def test_convert_openai_event_transcript(model, event, expected):
    if event["type"].startswith("response."):
        event = {**event, "item_id": "item-1", "content_index": 0}
    tru_events = model._convert_openai_event(event)
    exp_events = (
        [BidiTranscriptStartEvent(expected.role, content_id=expected.content_id), expected] if expected else None
    )
    assert tru_events == exp_events


# Helper Method Tests


@pytest.mark.parametrize("transcription_model_id", ["custom-transcription-model", None])
def test__build_session_config_direct_options(model_id, api_key, system_prompt, tool_spec, transcription_model_id):
    model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id=transcription_model_id,
        api_key=api_key,
        voice="coral",
    )

    config = model._build_session_config(system_prompt, [tool_spec])
    assert config["instructions"] == system_prompt
    assert config["tools"] == [
        {
            "type": "function",
            "name": tool_spec["name"],
            "description": tool_spec["description"],
            "parameters": tool_spec["inputSchema"]["json"],
        }
    ]
    assert config["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
    tru_transcription = config["audio"]["input"]["transcription"]
    exp_transcription = {"model": transcription_model_id} if transcription_model_id is not None else None
    assert tru_transcription == exp_transcription
    assert config["audio"]["output"] == {"format": {"type": "audio/pcm", "rate": 24000}, "voice": "coral"}


def test__build_session_config_passes_through_params(model_id, api_key):
    """Test model params are passed through to the session."""
    model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id="gpt-4o-transcribe",
        api_key=api_key,
        params={"max_output_tokens": 2048, "tracing": "auto", "future_option": {"enabled": True}},
    )

    config = model._build_session_config(None, None)

    assert config["max_output_tokens"] == 2048
    assert config["tracing"] == "auto"
    assert config["future_option"] == {"enabled": True}


@pytest.mark.parametrize(
    "transcription_model_id,transcription_override,exp_transcription",
    [
        ("direct-model", {"language": "en"}, {"model": "direct-model", "language": "en"}),
        ("direct-model", {"model": "params-model"}, {"model": "params-model"}),
        ("direct-model", None, None),
        (None, {"model": "params-model"}, {"model": "params-model"}),
    ],
)
def test__build_session_config_merges_params_last(
    model_id, api_key, system_prompt, tool_spec, transcription_model_id, transcription_override, exp_transcription
):
    """Params override direct options while preserving unspecified nested defaults."""
    model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id=transcription_model_id,
        api_key=api_key,
        voice="echo",
        params={
            "instructions": "",
            "tools": [],
            "audio": {
                "input": {
                    "format": {"rate": 24000},
                    "transcription": transcription_override,
                    "turn_detection": {"threshold": 0.3, "prefix_padding_ms": 0, "create_response": False},
                },
                "output": {"format": {"rate": 24000}, "voice": "coral"},
            },
        },
    )

    tru_config = model._build_session_config(system_prompt, [tool_spec])
    exp_config = {
        "type": "realtime",
        "instructions": "",
        "output_modalities": ["audio"],
        "tools": [],
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": exp_transcription,
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.3,
                    "prefix_padding_ms": 0,
                    "silence_duration_ms": 500,
                    "create_response": False,
                },
            },
            "output": {"format": {"type": "audio/pcm", "rate": 24000}, "voice": "coral"},
        },
    }
    assert tru_config == exp_config


def test__build_session_config_preserves_defaults(model_id, model, api_key, system_prompt, tool_spec):
    exp_config = model._build_session_config(None, None)
    custom_model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id="gpt-4o-transcribe",
        api_key=api_key,
        voice="coral",
        params={"output_modalities": ["text"]},
    )

    config = custom_model._build_session_config(system_prompt, [tool_spec])
    config["audio"]["input"]["turn_detection"]["threshold"] = 0.9

    tru_config = model._build_session_config(None, None)
    assert tru_config == exp_config


@pytest.mark.asyncio
async def test_start_preserves_explicit_nulls(model_id, api_key, mock_websockets_connect):
    """Session updates preserve explicit null overrides."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id="gpt-4o-transcribe",
        api_key=api_key,
        params={"audio": {"input": {"turn_detection": None, "transcription": None}}, "tracing": None},
    )

    await model.start(system_prompt="Test instructions")

    tru_event = json.loads(mock_ws.send.call_args.args[0])
    exp_event = {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": "Test instructions",
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "transcription": None,
                    "turn_detection": None,
                },
                "output": {"format": {"type": "audio/pcm", "rate": 24000}, "voice": "alloy"},
            },
            "tracing": None,
        },
    }
    assert tru_event == exp_event
    assert not model._session_state.transcription_enabled
    await model.stop()


@pytest.mark.asyncio
async def test_disabled_transcription_does_not_associate_audio_with_missing_transcript(
    model_id, api_key, mock_websockets_connect
):
    model = OpenAIRealtimeModel(model_id=model_id, api_key=api_key, transcription_model_id=None)
    await model.start()
    native_events = [
        {"type": "input_audio_buffer.speech_started", "item_id": "speech"},
        {"type": "input_audio_buffer.committed", "item_id": "speech"},
        {
            "type": "conversation.item.added",
            "item": {"id": "speech", "role": "user", "content": [{"type": "input_audio"}]},
        },
        {"type": "response.created", "response": {"id": "a"}},
        {
            "type": "conversation.item.added",
            "item": {"id": "text", "role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
        },
        {"type": "response.created", "response": {"id": "b"}},
    ]
    tru_events = [event for native in native_events for event in model._convert_openai_event(native) or []]
    exp_events = [
        BidiResponseInterruptEvent("user_speech"),
        BidiResponseStartEvent("a"),
        BidiResponseStartEvent("b"),
    ]
    assert tru_events == exp_events
    await model.stop()


@pytest.mark.parametrize(
    ("params", "exp_voice"),
    [
        pytest.param({}, "coral", id="empty"),
        pytest.param(None, "coral", id="none"),
        pytest.param({"audio": {"output": {"voice": "shimmer"}}}, "shimmer", id="replacement"),
    ],
)
def test_update_config_replaces_params(model_id, api_key, params, exp_voice):
    model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id="gpt-4o-transcribe",
        api_key=api_key,
        voice="coral",
        params={"instructions": "Params instructions", "audio": {"output": {"voice": "echo"}}},
    )

    model.update_config(params=params)

    config = model._build_session_config("Direct instructions", None)
    assert model.get_config()["params"] == params
    assert config["instructions"] == "Direct instructions"
    tru_output = config["audio"]["output"]
    exp_output = {"format": {"type": "audio/pcm", "rate": 24000}, "voice": exp_voice}
    assert tru_output == exp_output


def test_tool_conversion(model, tool_spec):
    """Test tool conversion to OpenAI format."""
    # Test with tools
    openai_tools = model._convert_tools_to_openai_format([tool_spec])
    assert len(openai_tools) == 1
    assert openai_tools[0]["type"] == "function"
    assert openai_tools[0]["name"] == "calculator"
    assert openai_tools[0]["description"] == "Calculate mathematical expressions"

    # Test empty list
    openai_empty = model._convert_tools_to_openai_format([])
    assert openai_empty == []


@pytest.mark.asyncio
async def test_send_event_helper(mock_websockets_connect, model):
    """Test _send_event helper method."""
    _, mock_ws = mock_websockets_connect
    await model.start()

    test_event = {"type": "test.event", "data": "test"}
    await model._send_event(test_event)

    calls = mock_ws.send.call_args_list
    last_call = calls[-1]
    sent_message = json.loads(last_call[0][0])
    assert sent_message == test_event

    await model.stop()


@pytest.mark.parametrize("voice", ["alloy", "echo"])
def test__convert_openai_event_audio_format(model_id, api_key, voice):
    model = OpenAIRealtimeModel(
        model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key, voice=voice
    )
    audio_base64 = base64.b64encode(b"audio data").decode()

    tru_events = model._convert_openai_event({"type": "response.output_audio.delta", "delta": audio_base64})
    exp_events = [
        BidiAudioStartEvent(),
        BidiAudioDeltaEvent(audio=audio_base64, format="pcm", sample_rate=24000, channels=1),
    ]
    assert tru_events == exp_events


@pytest.mark.parametrize("native_start", [False, True])
@pytest.mark.parametrize("native_stop", [False, True])
@pytest.mark.parametrize(
    "status,stop_reason", [("completed", "end_turn"), ("cancelled", "interrupt"), ("failed", "error")]
)
def test_audio_boundaries(model, native_start, native_stop, status, stop_reason):
    """Each audio stream stops once, including cancelled responses and missing native boundaries."""
    native_events = [{"type": "response.created", "response": {"id": "r1"}}]
    if native_start:
        native_events.append({"type": "response.content_part.added", "response_id": "r1", "part": {"type": "audio"}})
    native_events.extend(
        [
            {"type": "response.output_audio.delta", "response_id": "r1", "delta": "YQ=="},
            {"type": "response.output_audio.delta", "response_id": "r1", "delta": "Yg=="},
        ]
    )
    if native_stop:
        native_events.append({"type": "response.output_audio.done", "response_id": "r1"})
    native_events.append({"type": "response.done", "response": {"id": "r1", "status": status}})

    tru_events = [event for native in native_events for event in model._convert_openai_event(native) or []]
    exp_events = [
        BidiResponseStartEvent("r1"),
        BidiAudioStartEvent(),
        BidiAudioDeltaEvent("YQ==", format="pcm", sample_rate=24000, channels=1),
        BidiAudioDeltaEvent("Yg==", format="pcm", sample_rate=24000, channels=1),
        BidiAudioStopEvent(),
        BidiResponseStopEvent("r1", stop_reason),
    ]
    assert tru_events == exp_events
    assert model._convert_openai_event({"type": "response.output_audio.done", "response_id": "r1"}) is None


@pytest.mark.parametrize("pending_tools", [set(), {"other-call"}])
@pytest.mark.parametrize(
    "output_types,status,stop_reason",
    [
        ([], "completed", "end_turn"),
        (["message"], "completed", "end_turn"),
        (["function_call_output"], "completed", "end_turn"),
        (["function_call"], "completed", "tool_use"),
        (["message", "function_call", "function_call"], "completed", "tool_use"),
        (["function_call"], "cancelled", "interrupt"),
        (["function_call"], "incomplete", "interrupt"),
        (["function_call"], "failed", "error"),
    ],
)
def test_response_stop_reason_uses_response_output(model, pending_tools, output_types, status, stop_reason):
    """Classify the finished response independently of outstanding tool executions."""
    model._session_state.pending_tools.update(pending_tools)
    native_event = {
        "type": "response.done",
        "response": {"id": "r1", "status": status, "output": [{"type": item_type} for item_type in output_types]},
    }

    tru_events = model._convert_openai_event(native_event)
    exp_events = [BidiResponseStopEvent("r1", stop_reason)]
    assert tru_events == exp_events


# Tool Result Content Tests


@pytest.mark.asyncio
async def test_tool_result_single_text_content(model_id, mock_websockets_connect, api_key):
    """Test tool result with single text content block."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key)
    await model.start()

    tool_result = ToolResultBlock(tool_use_id="call-123", status="success", content=[{"text": "Simple text result"}])

    await model.send(tool_result)

    # Verify the sent event
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]

    assert len(item_create) > 0
    item = item_create[-1].get("item", {})
    assert item.get("type") == "function_call_output"
    assert item.get("call_id") == "call-123"
    # Content is now preserved as JSON array
    output = json.loads(item.get("output"))
    assert output == [{"text": "Simple text result"}]

    await model.stop()


@pytest.mark.asyncio
async def test_tool_result_single_json_content(model_id, mock_websockets_connect, api_key):
    """Test tool result with single JSON content block."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key)
    await model.start()

    tool_result = ToolResultBlock(
        tool_use_id="call-456", status="success", content=[{"json": {"temperature": 72, "condition": "sunny"}}]
    )

    await model.send(tool_result)

    # Verify the sent event
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]

    item = item_create[-1].get("item", {})
    assert item.get("type") == "function_call_output"
    assert item.get("call_id") == "call-456"
    # Content is now preserved as JSON array
    output = json.loads(item.get("output"))
    assert output == [{"json": {"temperature": 72, "condition": "sunny"}}]

    await model.stop()


@pytest.mark.asyncio
async def test_tool_result_multiple_content_blocks(model_id, mock_websockets_connect, api_key):
    """Test tool result with multiple content blocks (text and json)."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key)
    await model.start()

    tool_result = ToolResultBlock(
        tool_use_id="call-789",
        status="success",
        content=[
            {"text": "Weather data:"},
            {"json": {"temp": 72, "humidity": 65}},
            {"text": "Forecast: sunny"},
        ],
    )

    await model.send(tool_result)

    # Verify the sent event
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]

    item = item_create[-1].get("item", {})
    assert item.get("type") == "function_call_output"
    assert item.get("call_id") == "call-789"
    # Content is now preserved as JSON array
    output = json.loads(item.get("output"))
    assert output == [
        {"text": "Weather data:"},
        {"json": {"temp": 72, "humidity": 65}},
        {"text": "Forecast: sunny"},
    ]

    await model.stop()


@pytest.mark.asyncio
async def test_tool_result_image_content_raises_error(model_id, mock_websockets_connect, api_key):
    """Test that tool result with image content raises ValueError."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key)
    await model.start()

    tool_result = ToolResultBlock(
        tool_use_id="call-999",
        status="success",
        content=[{"image": {"format": "jpeg", "source": {"bytes": b"fake_image_data"}}}],
    )

    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(tool_result)

    await model.stop()


@pytest.mark.asyncio
async def test_tool_result_document_content_raises_error(model_id, mock_websockets_connect, api_key):
    """Test that tool result with document content raises ValueError."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key)
    await model.start()

    tool_result = ToolResultBlock(
        tool_use_id="call-888",
        status="success",
        content=[{"document": {"format": "pdf", "source": {"bytes": b"fake_pdf_data"}}}],
    )

    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(tool_result)

    await model.stop()


# Restart Tests


def test_connection_config_defaults_and_override(model_id, api_key, mock_websockets_connect):
    """Proactive reconnect fires a margin below the reactive timeout, and is overridable."""
    default_model = OpenAIRealtimeModel(model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key)
    # Deadline sits below the reactive timeout so a mid-turn swap is not preempted by it.
    assert default_model.get_connection_config() == {
        "restart_after_s": OPENAI_MAX_TIMEOUT_S - OPENAI_PROACTIVE_RECONNECT_MARGIN_S
    }
    assert default_model.get_connection_config()["restart_after_s"] < default_model.timeout_s
    # OpenAI reports per-response usage, so it must not be treated as cumulative.
    assert default_model.usage_is_cumulative is False

    # Lowering timeout_s keeps the headroom rather than recreating the tie.
    lowered_model = OpenAIRealtimeModel(
        model_id=model_id, transcription_model_id="gpt-4o-transcribe", api_key=api_key, timeout_s=1000
    )
    assert lowered_model.get_connection_config()["restart_after_s"] == 1000 - OPENAI_PROACTIVE_RECONNECT_MARGIN_S

    tuned_model = OpenAIRealtimeModel(
        model_id=model_id,
        transcription_model_id="gpt-4o-transcribe",
        api_key=api_key,
        connection={"restart_after_s": 25},
    )
    assert tuned_model.get_connection_config()["restart_after_s"] == 25


@pytest.mark.parametrize("connection", [{"restart_after_s": 30}, {"auto_reconnect": False}, {}])
def test_update_config_replaces_connection(model, connection):
    model.update_config(connection=connection)

    tru_config = model.get_config()
    exp_config = {"model_id": "gpt-realtime-2.1", "params": {}, "connection": connection}
    assert tru_config == exp_config
    assert model.get_connection_config() == connection


@pytest.mark.parametrize(
    ("model_config", "invalid_key"),
    [
        pytest.param({"model": "test-model"}, "model", id="model"),
        pytest.param({"connection": {"restart_after": 30}}, "restart_after", id="connection"),
    ],
)
def test_update_config_warns_invalid_keys(model, model_config, invalid_key):
    with pytest.warns(UserWarning, match=invalid_key):
        model.update_config(**model_config)


@pytest.mark.asyncio
async def test_restart_uses_updated_config(mock_websockets_connect, model):
    """Restart opens a new connection using the updated model ID and params."""
    mock_connect, mock_ws = mock_websockets_connect
    await model.start(system_prompt="Initial instructions")
    model.update_config(
        model_id="updated-model",
        params={"instructions": "Configured instructions", "max_output_tokens": 512},
    )
    mock_connect.assert_called_once()

    await model.restart(system_prompt="Direct instructions")

    assert mock_connect.call_count == 2
    assert mock_connect.call_args.args[0] == "wss://api.openai.com/v1/realtime?model=updated-model"

    events = [json.loads(call.args[0]) for call in mock_ws.send.call_args_list]
    sessions = [event["session"] for event in events if event["type"] == "session.update"]
    assert [session["instructions"] for session in sessions] == ["Initial instructions", "Configured instructions"]
    assert sessions[1]["max_output_tokens"] == 512

    await model.stop()


@pytest.mark.asyncio
async def test_restart_reestablishes_and_replays_history(mock_websockets_connect, model, system_prompt, messages):
    """restart() closes the old socket, opens a new one, and replays conversation history."""
    mock_connect, mock_ws = mock_websockets_connect

    await model.start()
    first_connection_id = model._connection_id
    mock_ws.send.reset_mock()

    await model.restart(system_prompt=system_prompt, messages=messages)

    mock_ws.close.assert_called_once()
    assert mock_connect.call_count == 2
    assert model._connection_id is not None
    assert model._connection_id != first_connection_id

    # Real history replay: the user turn is recreated on the new connection. Filtering on the user
    # role ensures the re-anchor system message (also an item.create) cannot satisfy this alone.
    events = [json.loads(call.args[0]) for call in mock_ws.send.call_args_list]
    user_items = [
        event["item"]
        for event in events
        if event["type"] == "conversation.item.create" and event["item"].get("role") == "user"
    ]
    assert user_items == [
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "Hello"}],
        }
    ]

    await model.stop()


@pytest.mark.asyncio
async def test_restart_forwards_tools(mock_websockets_connect, model, tool_spec):
    """Tools are re-sent on restart so the new session can still call them."""
    _, mock_ws = mock_websockets_connect

    await model.start()
    mock_ws.send.reset_mock()

    await model.restart(tools=[tool_spec])

    tool_names = [
        tool["name"]
        for call in mock_ws.send.call_args_list
        if json.loads(call[0][0]).get("type") == "session.update"
        for tool in json.loads(call[0][0])["session"].get("tools", [])
    ]
    assert tool_spec["name"] in tool_names

    await model.stop()


@pytest.mark.asyncio
async def test_restart_survives_reanchor_send_failure(mock_websockets_connect, model):
    """A failed re-anchor send is logged, not fatal: the reconnected session stays healthy."""
    _, mock_ws = mock_websockets_connect

    await model.start()

    async def fail_on_anchor(message):
        payload = json.loads(message)
        if payload.get("type") == "conversation.item.create" and payload.get("item", {}).get("role") == "system":
            raise RuntimeError("re-anchor send failed")

    mock_ws.send.side_effect = fail_on_anchor

    # Must not raise even though the re-anchor send fails.
    await model.restart()

    assert model._connection_id is not None

    mock_ws.send.side_effect = None
    await model.stop()


@pytest.mark.asyncio
async def test_restart_sends_reanchor_system_message(mock_websockets_connect, model):
    """restart() injects a system message so the fresh session continues rather than drifting."""
    _, mock_ws = mock_websockets_connect

    await model.start()
    mock_ws.send.reset_mock()

    await model.restart()

    system_items = [
        json.loads(call[0][0])["item"]
        for call in mock_ws.send.call_args_list
        if json.loads(call[0][0]).get("type") == "conversation.item.create"
        and json.loads(call[0][0])["item"].get("role") == "system"
    ]
    assert system_items == [
        {"type": "message", "role": "system", "content": [{"type": "input_text", "text": _RESTART_INSTRUCTION}]}
    ]

    await model.stop()


@pytest.mark.asyncio
async def test_receive_binds_websocket_per_reader(mock_websockets_connect, model):
    """A superseded reader keeps reading its own socket after self._websocket is swapped.

    Guards against a still-draining reader stealing messages from the connection that replaced it
    on reconnect.
    """
    _, ws1 = mock_websockets_connect
    await model.start()

    audio_from_ws1 = json.dumps({"type": "response.output_audio.delta", "delta": "FROM_WS1"})
    blocker = asyncio.Event()
    call_count = itertools.count()

    async def ws1_recv(*args, **kwargs):
        # First read yields one audio delta; subsequent reads park so the reader stays on ws1.
        if next(call_count) == 0:
            return audio_from_ws1
        await blocker.wait()
        return audio_from_ws1

    ws1.recv = unittest.mock.AsyncMock(side_effect=ws1_recv)

    reader = model.receive()
    await reader.__anext__()  # BidiConnectionStartEvent (reader not yet bound to a socket)
    assert await anext(reader) == BidiAudioStartEvent()
    first = await anext(reader)
    assert isinstance(first, BidiAudioDeltaEvent)
    assert first.audio == "FROM_WS1"

    # Swap in a replacement socket, as a reconnect would.
    ws2 = unittest.mock.AsyncMock()
    ws2.recv = unittest.mock.AsyncMock(
        return_value=json.dumps({"type": "response.output_audio.delta", "delta": "FROM_WS2"})
    )
    model._websocket = ws2
    blocker.set()
    tru_event = await reader.__anext__()
    exp_event = BidiAudioDeltaEvent(audio="FROM_WS1", format="pcm", sample_rate=24000, channels=1)
    assert tru_event == exp_event
    blocker.clear()

    # The bound reader stays parked on ws1 and never touches the replacement socket.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(reader.__anext__(), timeout=0.2)
    ws2.recv.assert_not_called()

    blocker.set()
    await reader.aclose()


@pytest.mark.asyncio
async def test_tool_results_wait_for_response_and_entire_group(model, mock_websocket):
    """Submit results immediately, then generate one continuation when the group is ready."""
    await model.start()
    mock_websocket.send.reset_mock()
    state = model._session_state
    state.active_responses.add("response-a")
    state.pending_tools.update(("a", "b"))
    result_a = ToolResultBlock(tool_use_id="a", status="success", content=[{"text": "A"}])
    result_b = ToolResultBlock(tool_use_id="b", status="success", content=[{"text": "B"}])
    mock_websocket.recv.side_effect = [
        json.dumps(
            {
                "type": "response.done",
                "response": {
                    "id": "response-a",
                    "status": "completed",
                    "output": [
                        {"type": "function_call", "call_id": "a", "name": "tool_a", "arguments": "{}"},
                        {"type": "function_call", "call_id": "b", "name": "tool_b", "arguments": "{}"},
                    ],
                },
            }
        ),
        json.dumps({"type": "response.created", "response": {"id": "response-b"}}),
        json.dumps({"type": "response.done", "response": {"id": "response-b", "status": "completed", "output": []}}),
    ]
    reader = model.receive()
    await anext(reader)  # Connection start.

    await model.send(result_b)
    assert await anext(reader) == BidiResponseStopEvent("response-a", "tool_use")
    await model._flush_response_request(state)
    assert [json.loads(call.args[0]) for call in mock_websocket.send.call_args_list] == [
        {
            "type": "conversation.item.create",
            "item": {"type": "function_call_output", "call_id": "b", "output": json.dumps([{"text": "B"}])},
        }
    ]
    await model.send(result_a)
    await model._flush_response_request(state)
    assert [json.loads(call.args[0]) for call in mock_websocket.send.call_args_list] == [
        {
            "type": "conversation.item.create",
            "item": {"type": "function_call_output", "call_id": "b", "output": json.dumps([{"text": "B"}])},
        },
        {
            "type": "conversation.item.create",
            "item": {"type": "function_call_output", "call_id": "a", "output": json.dumps([{"text": "A"}])},
        },
        {"type": "response.create"},
    ]
    assert await anext(reader) == BidiResponseStartEvent("response-b")
    assert await anext(reader) == BidiResponseStopEvent("response-b", "end_turn")
    await reader.aclose()
    await model.stop()


@pytest.mark.asyncio
async def test_native_acknowledgments_correlate_inputs_and_late_transcripts(model, mock_websocket):

    native_events = [
        {"type": "input_audio_buffer.speech_started", "item_id": "speech"},
        {"type": "input_audio_buffer.committed", "item_id": "speech"},
        {
            "type": "conversation.item.added",
            "item": {"id": "speech", "role": "user", "content": [{"type": "input_audio"}]},
        },
        {"type": "response.created", "response": {"id": "a"}},
        {"type": "response.done", "response": {"id": "a"}},
        {"type": "conversation.item.added", "item": {"id": "text", "role": "user"}},
        {"type": "response.created", "response": {"id": "b"}},
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "speech",
            "transcript": "Earlier speech",
        },
        {"type": "response.done", "response": {"id": "b"}},
    ]
    mock_websocket.recv.side_effect = [json.dumps(event) for event in native_events]
    await model.start()
    tru_events = []
    async for event in model.receive():
        if not isinstance(event, BidiConnectionStartEvent):
            tru_events.append(event)
        if event == BidiResponseStopEvent("b", "end_turn"):
            break
    assert tru_events == [
        BidiResponseInterruptEvent("user_speech"),
        BidiTranscriptStartEvent("user", content_id="speech"),
        BidiResponseStartEvent("a"),
        BidiResponseStopEvent("a", "end_turn"),
        BidiResponseStartEvent("b"),
        BidiTranscriptStopEvent("Earlier speech", "user", content_id="speech"),
        BidiResponseStopEvent("b", "end_turn"),
    ]
    await model.stop()


@pytest.mark.asyncio
async def test_history_acknowledgment_is_not_new_input(model, mock_websocket):
    await model.start(messages=[{"role": "user", "content": [{"text": "Earlier question"}]}])
    sent = [json.loads(call.args[0]) for call in mock_websocket.send.call_args_list]
    history_item = next(event["item"] for event in sent if event["type"] == "conversation.item.create")
    state = model._session_state
    assert model._convert_openai_event({"type": "conversation.item.added", "item": history_item}, state) is None
    assert model._convert_openai_event({"type": "response.created", "response": {"id": "new"}}, state) == [
        BidiResponseStartEvent("new")
    ]
    await model.stop()
