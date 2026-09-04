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

from strands.experimental.bidi.models.model import BidiModelTimeoutError
from strands.experimental.bidi.models.openai import (
    _RESTART_INSTRUCTION,
    OPENAI_MAX_TIMEOUT_S,
    OPENAI_PROACTIVE_RECONNECT_MARGIN_S,
    OpenAIRealtimeModel,
)
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionStartEvent,
    BidiImageInputEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
)
from strands.types._events import ToolResultEvent
from strands.types.tools import ToolResult


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
def model_name():
    return "gpt-realtime"


@pytest.fixture
def api_key():
    return "test-api-key"


@pytest.fixture
def model(mock_websockets_connect, api_key, model_name):
    """Create an OpenAIRealtimeModel instance."""
    return OpenAIRealtimeModel(model_id=model_name, api_key=api_key)


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


# Initialization Tests


def test_model_initialization(api_key, model_name, monkeypatch):
    """Test model initialization with various configurations."""
    model_default = OpenAIRealtimeModel(api_key="test-key")
    assert model_default.model_id == "gpt-realtime"
    assert model_default.api_key == "test-key"

    model_custom = OpenAIRealtimeModel(
        model_id=model_name,
        api_key=api_key,
        organization="org-explicit",
        project="proj-explicit",
    )
    assert model_custom.model_id == model_name
    assert model_custom.api_key == api_key
    assert model_custom.organization == "org-explicit"
    assert model_custom.project == "proj-explicit"

    monkeypatch.setenv("OPENAI_ORGANIZATION", "org-123")
    monkeypatch.setenv("OPENAI_PROJECT", "proj-456")
    model_env = OpenAIRealtimeModel(model_id=model_name, api_key=api_key)
    assert model_env.organization == "org-123"
    assert model_env.project == "proj-456"

    # Test with env API key
    monkeypatch.setenv("OPENAI_API_KEY", "env-key")
    model_env = OpenAIRealtimeModel()
    assert model_env.api_key == "env-key"


# Audio Configuration Tests


def test_audio_config_defaults(api_key, model_name):
    """Test default audio configuration."""
    model = OpenAIRealtimeModel(model_id=model_name, api_key=api_key)

    assert model.audio_config == {
        "input_rate": 24000,
        "output_rate": 24000,
        "channels": 1,
        "format": "pcm",
        "voice": "alloy",
    }


def test_audio_config_partial_override(api_key, model_name):
    """Test partial audio configuration override."""
    model = OpenAIRealtimeModel(
        model_id=model_name,
        api_key=api_key,
        audio={"output_rate": 48000, "voice": "echo"},
    )

    assert model.audio_config == {
        "input_rate": 24000,
        "output_rate": 48000,
        "channels": 1,
        "format": "pcm",
        "voice": "echo",
    }


def test_audio_config_full_override(api_key, model_name):
    """Test full audio configuration override."""
    model = OpenAIRealtimeModel(
        model_id=model_name,
        api_key=api_key,
        audio={
            "input_rate": 48000,
            "output_rate": 48000,
            "channels": 2,
            "format": "pcm",
            "voice": "shimmer",
        },
    )

    assert model.audio_config == {
        "input_rate": 48000,
        "output_rate": 48000,
        "channels": 2,
        "format": "pcm",
        "voice": "shimmer",
    }


def test_audio_config_voice_override(api_key, model_name):
    """Test that voice can be configured independently."""
    model = OpenAIRealtimeModel(model_id=model_name, api_key=api_key, audio={"voice": "fable"})

    assert model.audio_config["voice"] == "fable"


def test_init_without_api_key_raises(monkeypatch):
    """Test that initialization without API key raises error."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="OpenAI API key is required"):
        OpenAIRealtimeModel()


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
    await model.start(system_prompt=system_prompt)
    calls = mock_ws.send.call_args_list
    session_update = next(
        (json.loads(call[0][0]) for call in calls if json.loads(call[0][0]).get("type") == "session.update"), None
    )
    assert session_update is not None
    assert system_prompt in session_update["session"]["instructions"]
    await model.stop()

    # Test connection with tools
    await model.start(tools=[tool_spec])
    calls = mock_ws.send.call_args_list
    # Tools are sent in a separate session.update after initial connection
    session_updates = [
        json.loads(call[0][0]) for call in calls if json.loads(call[0][0]).get("type") == "session.update"
    ]
    assert len(session_updates) > 0
    # Check if any session update has tools
    has_tools = any("tools" in update.get("session", {}) for update in session_updates)
    assert has_tools
    await model.stop()

    # Test connection with messages
    await model.start(messages=messages)
    calls = mock_ws.send.call_args_list
    item_creates = [
        json.loads(call[0][0]) for call in calls if json.loads(call[0][0]).get("type") == "conversation.item.create"
    ]
    assert len(item_creates) > 0
    await model.stop()

    # Test connection with organization header (via environment)
    # Note: This test needs to be in a separate test function to use monkeypatch properly
    # Skipping inline environment test here - see test_connection_with_org_header


@pytest.mark.asyncio
async def test_connection_with_org_header(mock_websockets_connect, monkeypatch):
    """Test connection with organization header from environment."""
    mock_connect, mock_ws = mock_websockets_connect

    monkeypatch.setenv("OPENAI_ORGANIZATION", "org-123")
    model_org = OpenAIRealtimeModel(api_key="test-key")
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
async def test_connection_edge_cases(mock_websockets_connect, api_key, model_name):
    """Test connection error handling and edge cases."""
    mock_connect, mock_ws = mock_websockets_connect

    # Test connection error
    model1 = OpenAIRealtimeModel(model_id=model_name, api_key=api_key)
    mock_connect.side_effect = Exception("Connection failed")
    with pytest.raises(Exception, match="Connection failed"):
        await model1.start()

    # Reset mock
    async def async_connect(*args, **kwargs):
        return mock_ws

    mock_connect.side_effect = async_connect

    # Test double connection
    model2 = OpenAIRealtimeModel(model_id=model_name, api_key=api_key)
    await model2.start()
    with pytest.raises(RuntimeError, match=r"call stop before starting again"):
        await model2.start()
    await model2.stop()

    # Test close when not connected
    model3 = OpenAIRealtimeModel(model_id=model_name, api_key=api_key)
    await model3.stop()  # Should not raise

    # Test close error
    model4 = OpenAIRealtimeModel(model_id=model_name, api_key=api_key)
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
    text_input = BidiTextInputEvent(text="Hello", role="user")
    await model.send(text_input)
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    item_create = [m for m in messages if m.get("type") == "conversation.item.create"]
    response_create = [m for m in messages if m.get("type") == "response.create"]
    assert len(item_create) > 0
    assert len(response_create) > 0

    # Test audio input (base64 encoded)
    audio_b64 = base64.b64encode(b"audio_bytes").decode("utf-8")
    audio_input = BidiAudioInputEvent(
        audio=audio_b64,
        format="pcm",
        sample_rate=24000,
        channels=1,
    )
    await model.send(audio_input)
    calls = mock_ws.send.call_args_list
    messages = [json.loads(call[0][0]) for call in calls]
    audio_append = [m for m in messages if m.get("type") == "input_audio_buffer.append"]
    assert len(audio_append) > 0
    assert "audio" in audio_append[0]
    # Audio should be passed through as base64
    assert audio_append[0]["audio"] == audio_b64

    # Test tool result with text content
    tool_result: ToolResult = {
        "toolUseId": "tool-123",
        "status": "success",
        "content": [{"text": "Result: 42"}],
    }
    await model.send(ToolResultEvent(tool_result))
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
    tool_result_json: ToolResult = {
        "toolUseId": "tool-456",
        "status": "success",
        "content": [{"json": {"result": 42, "status": "ok"}}],
    }
    await model.send(ToolResultEvent(tool_result_json))
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
    tool_result_multi: ToolResult = {
        "toolUseId": "tool-789",
        "status": "success",
        "content": [{"text": "Part 1"}, {"json": {"data": "value"}}, {"text": "Part 2"}],
    }
    await model.send(ToolResultEvent(tool_result_multi))
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
    tool_result_image: ToolResult = {
        "toolUseId": "tool-999",
        "status": "success",
        "content": [{"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    }
    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(ToolResultEvent(tool_result_image))

    # Test tool result with document content (should raise error)
    tool_result_doc: ToolResult = {
        "toolUseId": "tool-888",
        "status": "success",
        "content": [{"document": {"format": "pdf", "source": {"bytes": b"doc_data"}}}],
    }
    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(ToolResultEvent(tool_result_doc))

    await model.stop()


@pytest.mark.asyncio
async def test_send_edge_cases(mock_websockets_connect, model):
    """Test send() edge cases and error handling."""
    _, mock_ws = mock_websockets_connect

    # Test send when inactive
    text_input = BidiTextInputEvent(text="Hello", role="user")
    with pytest.raises(RuntimeError, match=r"call start before sending"):
        await model.send(text_input)
    mock_ws.send.assert_not_called()

    # Test image input (sent as input_image content block on user message)
    await model.start()
    mock_ws.send.reset_mock()
    image_b64 = base64.b64encode(b"image_bytes").decode("utf-8")
    image_input = BidiImageInputEvent(
        image=image_b64,
        mime_type="image/jpeg",
    )
    await model.send(image_input)

    # Verify exactly one event was sent: a conversation.item.create with input_image
    image_calls = [json.loads(call[0][0]) for call in mock_ws.send.call_args_list]
    image_creates = [m for m in image_calls if m.get("type") == "conversation.item.create"]
    assert len(image_creates) == 1, "expected exactly one conversation.item.create for image"
    image_item = image_creates[0].get("item", {})
    assert image_item.get("type") == "message"
    assert image_item.get("role") == "user"
    assert image_item.get("content") == [{"type": "input_image", "image_url": f"data:image/jpeg;base64,{image_b64}"}]
    # Image input must NOT auto-trigger a response — caller decides when to commit.
    assert not any(m.get("type") == "response.create" for m in image_calls)

    await model.stop()


# Receive Method Tests


@pytest.mark.asyncio
async def test_receive_lifecycle_events(mock_websocket, model):
    audio_message = '{"type": "response.output_audio.delta", "delta": ""}'
    mock_websocket.recv.return_value = audio_message

    await model.start()
    model._connection_id = "c1"

    tru_events = []
    async for event in model.receive():
        tru_events.append(event)
        if len(tru_events) >= 2:
            break

    exp_events = [
        BidiConnectionStartEvent(connection_id="c1", model="gpt-realtime"),
        BidiAudioStreamEvent(
            audio="",
            format="pcm",
            sample_rate=24000,
            channels=1,
        ),
    ]
    assert tru_events == exp_events


@unittest.mock.patch("strands.experimental.bidi.models.openai.time.time")
@pytest.mark.asyncio
async def test_receive_timeout(mock_time, model):
    mock_time.side_effect = itertools.count()
    model.timeout_s = 1

    await model.start()

    with pytest.raises(BidiModelTimeoutError, match=r"timeout_s=<1>"):
        async for _ in model.receive():
            pass


@pytest.mark.asyncio
async def test_event_conversion(model):
    """Test conversion of all OpenAI event types to standard format."""
    await model.start()

    # Test audio output (now returns list with BidiAudioStreamEvent)
    audio_event = {"type": "response.output_audio.delta", "delta": base64.b64encode(b"audio_data").decode()}
    converted = model._convert_openai_event(audio_event)
    assert isinstance(converted, list)
    assert len(converted) == 1
    assert isinstance(converted[0], BidiAudioStreamEvent)
    assert converted[0].get("type") == "bidi_audio_stream"
    assert converted[0].get("audio") == base64.b64encode(b"audio_data").decode()
    assert converted[0].get("format") == "pcm"

    # Test text output (now returns list with BidiTranscriptStreamEvent)
    text_event = {"type": "response.output_text.delta", "delta": "Hello from OpenAI"}
    converted = model._convert_openai_event(text_event)
    assert isinstance(converted, list)
    assert len(converted) == 1
    assert isinstance(converted[0], BidiTranscriptStreamEvent)
    assert converted[0].get("type") == "bidi_transcript_stream"
    assert converted[0].get("text") == "Hello from OpenAI"
    assert converted[0].get("role") == "assistant"
    assert converted[0].delta == {"text": "Hello from OpenAI"}
    assert converted[0].is_final is False  # Delta events are not final

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

    # Test voice activity (now returns list with BidiInterruptionEvent for speech_started)
    speech_started = {"type": "input_audio_buffer.speech_started"}
    converted = model._convert_openai_event(speech_started)
    assert isinstance(converted, list)
    assert len(converted) == 1
    assert isinstance(converted[0], BidiInterruptionEvent)
    assert converted[0].get("type") == "bidi_interruption"
    assert converted[0].get("reason") == "user_speech"

    # Test response.cancelled event (should return ResponseCompleteEvent with interrupted reason)
    response_cancelled = {"type": "response.cancelled", "response": {"id": "resp_123"}}
    converted = model._convert_openai_event(response_cancelled)
    assert isinstance(converted, list)
    assert len(converted) == 1
    assert isinstance(converted[0], BidiResponseCompleteEvent)
    assert converted[0].get("type") == "bidi_response_complete"
    assert converted[0].get("response_id") == "resp_123"
    assert converted[0].get("stop_reason") == "interrupted"

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


# Helper Method Tests


def test_config_building(model, system_prompt, tool_spec):
    """Test building session config with various options."""
    # Test basic config
    config_basic = model._build_session_config(None, None)
    assert isinstance(config_basic, dict)
    assert "instructions" in config_basic
    assert "audio" in config_basic

    # Test with system prompt
    config_prompt = model._build_session_config(system_prompt, None)
    assert config_prompt["instructions"] == system_prompt

    # Test with tools
    config_tools = model._build_session_config(None, [tool_spec])
    assert "tools" in config_tools
    assert len(config_tools["tools"]) > 0


def test__build_session_config_passes_through_params(api_key):
    """Test model params are passed through to the session."""
    model = OpenAIRealtimeModel(
        api_key=api_key,
        params={"max_output_tokens": 2048, "tracing": "auto"},
    )

    config = model._build_session_config(None, None)

    assert config["max_output_tokens"] == 2048
    assert config["tracing"] == "auto"


def test__build_session_config_merges_audio_params(api_key):
    """Test nested audio params preserve unspecified defaults."""
    model = OpenAIRealtimeModel(
        api_key=api_key,
        params={"audio": {"input": {"turn_detection": {"threshold": 0.3}}}},
    )

    config = model._build_session_config(None, None)

    assert config["audio"]["input"] == {
        "format": {"type": "audio/pcm", "rate": 24000},
        "transcription": {"model": "gpt-4o-transcribe"},
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.3,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
        },
    }
    assert config["audio"]["output"] == {
        "format": {"type": "audio/pcm", "rate": 24000},
        "voice": "alloy",
    }


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


def test_helper_methods(model):
    """Test various helper methods."""
    # Test _create_text_event (now returns BidiTranscriptStreamEvent)
    text_event = model._create_text_event("Hello", "user")
    assert isinstance(text_event, BidiTranscriptStreamEvent)
    assert text_event.get("type") == "bidi_transcript_stream"
    assert text_event.get("text") == "Hello"
    assert text_event.get("role") == "user"
    assert text_event.delta == {"text": "Hello"}
    assert text_event.is_final is True  # Done events are final
    assert text_event.current_transcript == "Hello"

    # Test _create_voice_activity_event (now returns BidiInterruptionEvent for speech_started)
    voice_event = model._create_voice_activity_event("speech_started")
    assert isinstance(voice_event, BidiInterruptionEvent)
    assert voice_event.get("type") == "bidi_interruption"
    assert voice_event.get("reason") == "user_speech"

    # Other voice activities return None
    assert model._create_voice_activity_event("speech_stopped") is None


@pytest.mark.parametrize("raw_role,expected", [("USER", "user"), ("Assistant", "assistant"), ("system", "user")])
def test_create_text_event_normalizes_role(model, raw_role, expected):
    """The raw provider role passes through; the event constructor is the single normalization point."""
    text_event = model._create_text_event("Hello", raw_role)

    assert text_event.role == expected


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


@pytest.mark.asyncio
async def test_custom_audio_sample_rate(mock_websockets_connect, api_key):
    """Test that a custom audio sample rate is used in audio events."""
    _, mock_ws = mock_websockets_connect

    custom_sample_rate = 48000
    model = OpenAIRealtimeModel(api_key=api_key, audio={"output_rate": custom_sample_rate})

    await model.start()

    # Simulate receiving an audio delta event from OpenAI
    openai_audio_event = {"type": "response.output_audio.delta", "delta": "base64audiodata"}

    # Convert the event
    converted_events = model._convert_openai_event(openai_audio_event)

    # Verify the audio event uses the custom sample rate
    assert converted_events is not None
    assert len(converted_events) == 1
    audio_event = converted_events[0]
    assert isinstance(audio_event, BidiAudioStreamEvent)
    assert audio_event.sample_rate == custom_sample_rate
    assert audio_event.format == "pcm"
    assert audio_event.channels == 1

    await model.stop()


@pytest.mark.asyncio
async def test_default_audio_sample_rate(mock_websockets_connect, api_key):
    """Test that default audio sample rate is used when no custom config is provided."""
    _, mock_ws = mock_websockets_connect

    # Create model without custom audio config
    model = OpenAIRealtimeModel(api_key=api_key)

    await model.start()

    # Simulate receiving an audio delta event from OpenAI
    openai_audio_event = {"type": "response.output_audio.delta", "delta": "base64audiodata"}

    # Convert the event
    converted_events = model._convert_openai_event(openai_audio_event)

    # Verify the audio event uses the default sample rate (24000)
    assert converted_events is not None
    assert len(converted_events) == 1
    audio_event = converted_events[0]
    assert isinstance(audio_event, BidiAudioStreamEvent)
    assert audio_event.sample_rate == 24000  # Default from DEFAULT_SAMPLE_RATE
    assert audio_event.format == "pcm"
    assert audio_event.channels == 1

    await model.stop()


@pytest.mark.asyncio
async def test_partial_audio_config(mock_websockets_connect, api_key):
    """Test that partial audio config doesn't break and falls back to defaults."""
    _, mock_ws = mock_websockets_connect

    model = OpenAIRealtimeModel(api_key=api_key, audio={"voice": "alloy"})

    await model.start()

    # Simulate receiving an audio delta event from OpenAI
    openai_audio_event = {"type": "response.output_audio.delta", "delta": "base64audiodata"}

    # Convert the event
    converted_events = model._convert_openai_event(openai_audio_event)

    # Verify the audio event uses the default sample rate
    assert converted_events is not None
    assert len(converted_events) == 1
    audio_event = converted_events[0]
    assert isinstance(audio_event, BidiAudioStreamEvent)
    assert audio_event.sample_rate == 24000  # Falls back to default
    assert audio_event.format == "pcm"
    assert audio_event.channels == 1

    await model.stop()


# Tool Result Content Tests


@pytest.mark.asyncio
async def test_tool_result_single_text_content(mock_websockets_connect, api_key):
    """Test tool result with single text content block."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(api_key=api_key)
    await model.start()

    tool_result: ToolResult = {
        "toolUseId": "call-123",
        "status": "success",
        "content": [{"text": "Simple text result"}],
    }

    await model.send(ToolResultEvent(tool_result))

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
async def test_tool_result_single_json_content(mock_websockets_connect, api_key):
    """Test tool result with single JSON content block."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(api_key=api_key)
    await model.start()

    tool_result: ToolResult = {
        "toolUseId": "call-456",
        "status": "success",
        "content": [{"json": {"temperature": 72, "condition": "sunny"}}],
    }

    await model.send(ToolResultEvent(tool_result))

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
async def test_tool_result_multiple_content_blocks(mock_websockets_connect, api_key):
    """Test tool result with multiple content blocks (text and json)."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(api_key=api_key)
    await model.start()

    tool_result: ToolResult = {
        "toolUseId": "call-789",
        "status": "success",
        "content": [
            {"text": "Weather data:"},
            {"json": {"temp": 72, "humidity": 65}},
            {"text": "Forecast: sunny"},
        ],
    }

    await model.send(ToolResultEvent(tool_result))

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
async def test_tool_result_image_content_raises_error(mock_websockets_connect, api_key):
    """Test that tool result with image content raises ValueError."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(api_key=api_key)
    await model.start()

    tool_result: ToolResult = {
        "toolUseId": "call-999",
        "status": "success",
        "content": [{"image": {"format": "jpeg", "source": {"bytes": b"fake_image_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(ToolResultEvent(tool_result))

    await model.stop()


@pytest.mark.asyncio
async def test_tool_result_document_content_raises_error(mock_websockets_connect, api_key):
    """Test that tool result with document content raises ValueError."""
    _, mock_ws = mock_websockets_connect
    model = OpenAIRealtimeModel(api_key=api_key)
    await model.start()

    tool_result: ToolResult = {
        "toolUseId": "call-888",
        "status": "success",
        "content": [{"document": {"format": "pdf", "source": {"bytes": b"fake_pdf_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by OpenAI Realtime API"):
        await model.send(ToolResultEvent(tool_result))

    await model.stop()


# Restart Tests


def test_connection_config_defaults_and_override(api_key, mock_websockets_connect):
    """Proactive reconnect fires a margin below the reactive timeout, and is overridable."""
    default_model = OpenAIRealtimeModel(api_key=api_key)
    # Deadline sits below the reactive timeout so a mid-turn swap is not preempted by it.
    assert default_model.connection_config == {
        "restart_after_s": OPENAI_MAX_TIMEOUT_S - OPENAI_PROACTIVE_RECONNECT_MARGIN_S
    }
    assert default_model.connection_config["restart_after_s"] < default_model.timeout_s
    # OpenAI reports per-response usage, so it must not be treated as cumulative.
    assert default_model.usage_is_cumulative is False

    # Lowering timeout_s keeps the headroom rather than recreating the tie.
    lowered_model = OpenAIRealtimeModel(api_key=api_key, timeout_s=1000)
    assert lowered_model.connection_config["restart_after_s"] == 1000 - OPENAI_PROACTIVE_RECONNECT_MARGIN_S

    tuned_model = OpenAIRealtimeModel(api_key=api_key, connection={"restart_after_s": 25})
    assert tuned_model.connection_config["restart_after_s"] == 25


@pytest.mark.asyncio
async def test_restart_reestablishes_and_replays_history(mock_websockets_connect, model, system_prompt, messages):
    """restart() closes the old socket, opens a new one, and replays conversation history."""
    mock_connect, mock_ws = mock_websockets_connect

    await model.start()
    first_connection_id = model._connection_id
    mock_ws.send.reset_mock()

    await model.restart(system_prompt=system_prompt, messages=messages)

    # Old socket closed, a new connection opened, and the connection identity advanced.
    mock_ws.close.assert_called_once()
    assert mock_connect.call_count == 2
    assert model._connection_id is not None
    assert model._connection_id != first_connection_id

    # Real history replay: the user turn is recreated on the new connection. Filtering on the user
    # role ensures the re-anchor system message (also an item.create) cannot satisfy this alone.
    user_items = [
        json.loads(call[0][0])["item"]
        for call in mock_ws.send.call_args_list
        if json.loads(call[0][0]).get("type") == "conversation.item.create"
        and json.loads(call[0][0])["item"].get("role") == "user"
    ]
    assert user_items == [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello"}]}]

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
    first = await reader.__anext__()  # binds to ws1, reads its message
    assert isinstance(first, BidiAudioStreamEvent)
    assert first.audio == "FROM_WS1"

    # Swap in a replacement socket, as a reconnect would.
    ws2 = unittest.mock.AsyncMock()
    ws2.recv = unittest.mock.AsyncMock(
        return_value=json.dumps({"type": "response.output_audio.delta", "delta": "FROM_WS2"})
    )
    model._websocket = ws2

    # The bound reader stays parked on ws1 and never touches the replacement socket.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(reader.__anext__(), timeout=0.2)
    ws2.recv.assert_not_called()

    blocker.set()
    await reader.aclose()
