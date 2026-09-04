"""Unit tests for the Google Gemini Live bidirectional streaming model.

Tests the unified GoogleGeminiLiveModel interface including:
- Model initialization and configuration
- Connection establishment and lifecycle
- Unified send() method with different content types
- Event receiving and conversion
"""

import asyncio
import base64
import json
import unittest.mock

import pytest
from google.genai import types as genai_types

from strands.experimental.bidi.agent import loop as loop_module
from strands.experimental.bidi.models.google import GoogleGeminiLiveModel, _TurnState
from strands.experimental.bidi.models.model import BidiModelTimeoutError
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionStartEvent,
    BidiImageInputEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
)
from strands.types._events import ToolResultEvent
from strands.types.tools import ToolResult


@pytest.fixture
def mock_genai_client():
    """Mock the Google GenAI client."""
    with unittest.mock.patch("strands.experimental.bidi.models.google.genai.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value
        mock_client.aio = unittest.mock.MagicMock()

        # Mock the live session
        mock_live_session = unittest.mock.AsyncMock()

        # Mock the context manager
        mock_live_session_cm = unittest.mock.MagicMock()
        mock_live_session_cm.__aenter__ = unittest.mock.AsyncMock(return_value=mock_live_session)
        mock_live_session_cm.__aexit__ = unittest.mock.AsyncMock(return_value=None)

        # Make connect return the context manager
        mock_client.aio.live.connect = unittest.mock.MagicMock(return_value=mock_live_session_cm)

        yield mock_client, mock_live_session, mock_live_session_cm


@pytest.fixture
def live_message():
    """Build a LiveServerMessage-shaped mock with every field defaulted to None.

    Bare Mocks auto-create truthy attributes, so unset fields would be misread as present.
    """

    def _build(**overrides):
        message = unittest.mock.Mock()
        message.data = None
        message.go_away = None
        message.session_resumption_update = None
        message.tool_call = None
        message.server_content = None
        message.usage_metadata = None

        for name, value in overrides.items():
            setattr(message, name, value)

        return message

    return _build


@pytest.fixture
def server_content():
    """Build a LiveServerContent-shaped mock with every field defaulted to None."""

    def _build(**overrides):
        content = unittest.mock.Mock()
        content.interrupted = None
        content.input_transcription = None
        content.output_transcription = None
        content.model_turn = None
        content.turn_complete = None
        content.generation_complete = None

        for name, value in overrides.items():
            setattr(content, name, value)

        return content

    return _build


@pytest.fixture
def usage_metadata():
    """Build a UsageMetadata-shaped mock with token counts and no modality details."""

    def _build(**overrides):
        usage = unittest.mock.Mock()
        usage.prompt_token_count = 10
        usage.response_token_count = 20
        usage.total_token_count = 30
        usage.cached_content_token_count = None
        usage.prompt_tokens_details = None
        usage.response_tokens_details = None

        for name, value in overrides.items():
            setattr(usage, name, value)

        return usage

    return _build


@pytest.fixture
def text_part():
    """Build a Part-shaped mock carrying text."""

    def _build(text):
        part = unittest.mock.Mock()
        part.text = text
        return part

    return _build


@pytest.fixture
def model_id():
    return "models/gemini-2.0-flash-live-preview-04-09"


@pytest.fixture
def api_key():
    return "test-api-key"


@pytest.fixture
def model(mock_genai_client, model_id, api_key):
    """Create a GoogleGeminiLiveModel instance."""
    _ = mock_genai_client
    return GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})


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


def test_model_initialization(mock_genai_client, model_id, api_key):
    """Test model initialization with various configurations."""
    _ = mock_genai_client

    model_default = GoogleGeminiLiveModel()
    assert model_default.model_id == "gemini-2.5-flash-native-audio-preview-09-2025"
    assert model_default.client_args == {}
    assert model_default._live_session is None
    assert model_default.config["params"] == {}

    model_with_key = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    assert model_with_key.model_id == model_id
    assert model_with_key.client_args == {"api_key": api_key}

    model_custom = GoogleGeminiLiveModel(model_id=model_id, params={"temperature": 0.7, "top_p": 0.9})
    assert model_custom.config["params"] == {"temperature": 0.7, "top_p": 0.9}
    assert model_custom._build_live_config()["response_modalities"] == ["AUDIO"]


# Connection Tests


@pytest.mark.asyncio
async def test_connection_lifecycle(mock_genai_client, model, system_prompt, tool_spec, messages):
    """Test complete connection lifecycle with various configurations."""
    mock_client, mock_live_session, mock_live_session_cm = mock_genai_client

    # Test basic connection
    await model.start()
    assert model._connection_id is not None
    assert model._live_session == mock_live_session
    mock_client.aio.live.connect.assert_called_once()

    # Test close
    await model.stop()
    mock_live_session_cm.__aexit__.assert_called_once()

    # Test connection with system prompt
    await model.start(system_prompt=system_prompt)
    call_args = mock_client.aio.live.connect.call_args
    config = call_args.kwargs.get("config", {})
    assert config.get("system_instruction") == system_prompt
    await model.stop()

    # Test connection with tools
    await model.start(tools=[tool_spec])
    call_args = mock_client.aio.live.connect.call_args
    config = call_args.kwargs.get("config", {})
    assert "tools" in config
    assert len(config["tools"]) > 0
    await model.stop()

    # Test connection with messages
    await model.start(messages=messages)
    mock_live_session.send_client_content.assert_called()
    await model.stop()


@pytest.mark.asyncio
async def test_connection_edge_cases(mock_genai_client, api_key, model_id):
    """Test connection error handling and edge cases."""
    mock_client, _, mock_live_session_cm = mock_genai_client

    # Test connection error
    model1 = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    mock_client.aio.live.connect.side_effect = Exception("Connection failed")
    with pytest.raises(Exception, match=r"Connection failed"):
        await model1.start()

    # Reset mock for next tests
    mock_client.aio.live.connect.side_effect = None

    # Test double connection
    model2 = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    await model2.start()
    with pytest.raises(RuntimeError, match="call stop before starting again"):
        await model2.start()
    await model2.stop()

    # Test close when not connected
    model3 = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    await model3.stop()  # Should not raise

    # Test close error handling
    model4 = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    await model4.start()
    mock_live_session_cm.__aexit__.side_effect = Exception("Close failed")
    with pytest.raises(Exception, match=r"failed stop sequence"):
        await model4.stop()


@pytest.mark.asyncio
async def test_stop_is_idempotent(mock_genai_client, model):
    """Calling stop() twice on a started model does not re-exit the context manager or raise."""
    _, _, mock_live_session_cm = mock_genai_client

    await model.start()
    await model.stop()
    assert mock_live_session_cm.__aexit__.call_count == 1

    # Second stop must be a no-op: the context manager is cleared on first stop, so it is
    # not re-exited and no error is raised (restart() relies on this).
    await model.stop()
    assert mock_live_session_cm.__aexit__.call_count == 1


# Restart / Connection Config Tests


def test_connection_config_declared(model):
    """Gemini declares a proactive reconnect deadline and per-response (non-cumulative) usage."""
    assert model.connection_config["restart_after_s"] == 540
    assert model.usage_is_cumulative is False


def test_context_window_compression_enabled_by_default(model):
    """Sliding-window compression is on by default so a resumed session survives past the cap."""
    compression = model._build_live_config()["context_window_compression"]
    assert isinstance(compression, genai_types.ContextWindowCompressionConfig)
    assert isinstance(compression.sliding_window, genai_types.SlidingWindow)
    # It flows into the live connect config.
    assert "context_window_compression" in model._build_live_config()


def test_context_window_compression_overridable(mock_genai_client, model_id, api_key):
    """A caller can override the compression default through model params."""
    _ = mock_genai_client
    model = GoogleGeminiLiveModel(
        model_id=model_id,
        client_args={"api_key": api_key},
        params={"context_window_compression": None},
    )
    assert model.config["params"]["context_window_compression"] is None


def test_connection_config_override(mock_genai_client, model_id, api_key):
    """Connection config tunes reconnect timing over the provider default."""
    _ = mock_genai_client
    model = GoogleGeminiLiveModel(
        model_id=model_id,
        client_args={"api_key": api_key},
        connection={"restart_after_s": 30},
    )
    assert model.connection_config["restart_after_s"] == 30


@pytest.mark.asyncio
async def test_restart_resumes_via_session_handle(mock_genai_client, model):
    """restart() tears down the old connection and resumes the session via the tracked handle."""
    mock_client, _, mock_live_session_cm = mock_genai_client
    await model.start()
    model._live_session_handle = "handle-abc"

    await model.restart(system_prompt="hi")

    assert mock_live_session_cm.__aexit__.called  # old connection torn down
    assert model._connection_id is not None  # new connection established

    # The resumed connection carries the tracked handle, and history is not replayed.
    config = mock_client.aio.live.connect.call_args.kwargs["config"]
    assert config["session_resumption"].handle == "handle-abc"

    await model.stop()


@pytest.mark.asyncio
async def test_restart_prefers_explicit_handle_from_restart_kwargs(mock_genai_client, model):
    """The reactive path's handle (passed via restart_kwargs) wins over the tracked one."""
    mock_client, _, _ = mock_genai_client
    await model.start()
    model._live_session_handle = "tracked"

    await model.restart(system_prompt="hi", live_session_handle="from-error")

    config = mock_client.aio.live.connect.call_args.kwargs["config"]
    assert config["session_resumption"].handle == "from-error"

    await model.stop()


@pytest.mark.asyncio
async def test_fresh_start_clears_tracked_handle(mock_genai_client, model):
    """A fresh start() (no handle) drops a handle tracked from a previous session.

    Without this, a reused model instance would resume the previous conversation into a new one,
    silently discarding the new conversation's context.
    """
    mock_client, _, _ = mock_genai_client
    await model.start()
    model._live_session_handle = "old-session"
    await model.stop()

    # A brand-new conversation: start with no handle.
    await model.start()

    assert model._live_session_handle is None
    config = mock_client.aio.live.connect.call_args.kwargs["config"]
    assert config["session_resumption"].handle is None

    await model.stop()


@pytest.mark.asyncio
async def test_restart_without_handle_starts_fresh_and_replays_history(mock_genai_client, model, messages):
    """With no tracked handle, restart() starts a fresh session and replays history."""
    mock_client, mock_live_session, _ = mock_genai_client
    await model.start()
    assert model._live_session_handle is None

    await model.restart(system_prompt="hi", messages=messages)

    # Fresh session (no resumption handle), with history replayed via send_client_content.
    config = mock_client.aio.live.connect.call_args.kwargs["config"]
    assert config["session_resumption"].handle is None
    mock_live_session.send_client_content.assert_called()

    await model.stop()


@pytest.mark.asyncio
async def test_restart_falls_back_to_fresh_session_when_resume_rejected(mock_genai_client, model, messages):
    """A rejected resume handle is dropped and the restart retries with a fresh session and replay.

    Guards against the connection going permanently silent when the server refuses the handle:
    the fallback the restart() docstring promises.
    """
    mock_client, mock_live_session, mock_live_session_cm = mock_genai_client
    await model.start()
    model._live_session_handle = "stale-handle"

    # The resume attempt (handle present) fails; the fresh retry (no handle) succeeds.
    async def aenter_rejects_resume(*_args, **_kwargs):
        config = mock_client.aio.live.connect.call_args.kwargs["config"]
        if config["session_resumption"].handle is not None:
            raise RuntimeError("resume handle rejected")
        return mock_live_session

    mock_live_session_cm.__aenter__.side_effect = aenter_rejects_resume

    await model.restart(system_prompt="hi", messages=messages)

    # Handle dropped, a fresh session established, and history replayed.
    assert model._live_session_handle is None
    assert model._connection_id is not None
    final_config = mock_client.aio.live.connect.call_args.kwargs["config"]
    assert final_config["session_resumption"].handle is None
    mock_live_session.send_client_content.assert_called()

    await model.stop()


@pytest.mark.asyncio
async def test_turn_state_is_per_reader(mock_genai_client, model, live_message):
    """Turn bracketing is isolated per reader, so a superseded reader draining its closing session
    cannot corrupt the turn state of the connection that replaced it.
    """
    _, _, _ = mock_genai_client
    await model.start()

    old_reader = _TurnState()
    new_reader = _TurnState()

    # The superseded reader drains a model output from its closing session, opening its own turn.
    model._convert_gemini_live_event(live_message(data=b"stale_audio"), old_reader)
    assert old_reader.response_open is True

    # The new reader's state is untouched, so its first output still opens a response.
    events = model._convert_gemini_live_event(live_message(data=b"fresh_audio"), new_reader)
    assert [type(event) for event in events] == [BidiResponseStartEvent, BidiAudioStreamEvent]
    assert new_reader.response_open is True

    await model.stop()


@pytest.mark.asyncio
async def test_proactive_reconnect_end_to_end_through_agent(mock_genai_client, model_id, api_key, monkeypatch):
    """End-to-end: BidiAgent + real Gemini model proactively reconnects before the deadline.

    Drives the full chain against the real GoogleGeminiLiveModel (mocked genai transport): the loop
    reads Gemini's connection_config, arms the proactive timer, emits a warning, and reconnects
    through Gemini's own restart() before the deadline, resuming the session via its handle. No
    live network calls are made.
    """
    from strands.experimental.bidi.agent.agent import BidiAgent
    from strands.experimental.bidi.types.events import BidiConnectionWarningEvent

    mock_client, mock_live_session, _ = mock_genai_client

    # The session never emits on its own; receive() blocks so the model task idles while the
    # proactive timer drives the reconnect.
    never = asyncio.Event()

    def blocking_receive():
        async def _gen():
            await never.wait()
            yield  # pragma: no cover

        return _gen()

    mock_live_session.receive = unittest.mock.Mock(side_effect=blocking_receive)
    # Reap the parked superseded reader promptly instead of waiting the full backstop.
    monkeypatch.setattr(loop_module, "_MODEL_RESTART_STOP_TIMEOUT_S", 0.05)

    model = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    # A small deadline; the injected clock below fires it without wall time.
    model.connection_config = {"restart_after_s": 1}

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
    # A resumable handle captured mid-session (as a real session_resumption_update would set it);
    # the proactive reconnect must resume with it. Set after start(), since a fresh start clears
    # any pre-existing handle.
    model._live_session_handle = "resume-handle"

    warning_seen = False
    async for event in agent.receive():
        if isinstance(event, BidiConnectionWarningEvent):
            warning_seen = True
        # Once a reconnect has produced a new connection id, the proactive cycle completed.
        if model._connection_id is not None and model._connection_id != first_connection_id:
            break

    assert warning_seen
    assert model._connection_id != first_connection_id

    # The reconnect resumed the session via the tracked handle rather than starting fresh.
    resumed_config = mock_client.aio.live.connect.call_args.kwargs["config"]
    assert resumed_config["session_resumption"].handle == "resume-handle"

    await agent.stop()


# History Seeding Tests


@pytest.mark.asyncio
async def test_history_config_with_text_messages(mock_genai_client, api_key, model_id):
    """Test that text messages enable history_config and send history."""
    mock_client, mock_live_session, _ = mock_genai_client

    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    model = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    await model.start(messages=messages)

    # history_config should be in the connect config
    call_args = mock_client.aio.live.connect.call_args
    config = call_args.kwargs.get("config", {})
    assert "history_config" in config

    # send_client_content should be called with the history
    mock_live_session.send_client_content.assert_called_once()
    call_args = mock_live_session.send_client_content.call_args
    assert call_args.kwargs.get("turn_complete") is True

    await model.stop()


@pytest.mark.asyncio
async def test_history_config_skipped_for_tool_only_messages(mock_genai_client, api_key, model_id):
    """Test that tool-only messages do not enable history_config (avoids stuck connection)."""
    mock_client, mock_live_session, _ = mock_genai_client

    messages = [
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "calc", "input": {}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "t1", "status": "success", "content": []}}]},
    ]
    model = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    await model.start(messages=messages)

    # history_config should NOT be in the connect config
    call_args = mock_client.aio.live.connect.call_args
    config = call_args.kwargs.get("config", {})
    assert "history_config" not in config

    # send_client_content should NOT be called (no text to send)
    mock_live_session.send_client_content.assert_not_called()

    await model.stop()


@pytest.mark.asyncio
async def test_history_skipped_when_session_handle_provided(mock_genai_client, api_key, model_id):
    """Test that history is not re-sent when resuming via session handle."""
    mock_client, mock_live_session, _ = mock_genai_client

    messages = [{"role": "user", "content": [{"text": "Hello"}]}]
    model = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    await model.start(messages=messages, live_session_handle="existing-handle")

    # history_config should NOT be set (session resumption handles context)
    call_args = mock_client.aio.live.connect.call_args
    config = call_args.kwargs.get("config", {})
    assert "history_config" not in config

    # send_client_content should NOT be called
    mock_live_session.send_client_content.assert_not_called()

    await model.stop()


# Send Method Tests


@pytest.mark.asyncio
async def test_send_all_content_types(mock_genai_client, model):
    """Test sending all content types through unified send() method."""
    _, mock_live_session, _ = mock_genai_client
    await model.start()

    # Test text input — uses send_realtime_input for mid-session text
    text_input = BidiTextInputEvent(text="Hello", role="user")
    await model.send(text_input)
    mock_live_session.send_realtime_input.assert_called_once()
    call_args = mock_live_session.send_realtime_input.call_args
    assert call_args.kwargs.get("text") == "Hello"

    # Test audio input (base64 encoded)
    mock_live_session.send_realtime_input.reset_mock()
    audio_b64 = base64.b64encode(b"audio_bytes").decode("utf-8")
    audio_input = BidiAudioInputEvent(
        audio=audio_b64,
        format="pcm",
        sample_rate=16000,
        channels=1,
    )
    await model.send(audio_input)
    mock_live_session.send_realtime_input.assert_called_once()

    # Test image input (base64 encoded, no encoding parameter)
    image_b64 = base64.b64encode(b"image_bytes").decode("utf-8")
    image_input = BidiImageInputEvent(
        image=image_b64,
        mime_type="image/jpeg",
    )
    await model.send(image_input)
    mock_live_session.send.assert_called_once()

    # Test tool result
    tool_result: ToolResult = {
        "toolUseId": "tool-123",
        "status": "success",
        "content": [{"text": "Result: 42"}],
    }
    await model.send(ToolResultEvent(tool_result))
    mock_live_session.send_tool_response.assert_called_once()

    await model.stop()


@pytest.mark.asyncio
async def test_send_edge_cases(mock_genai_client, model):
    """Test send() edge cases and error handling."""
    _, mock_live_session, _ = mock_genai_client

    # Test send when inactive
    text_input = BidiTextInputEvent(text="Hello", role="user")
    with pytest.raises(RuntimeError, match=r"call start before sending"):
        await model.send(text_input)
    mock_live_session.send_realtime_input.assert_not_called()

    # Test unknown content type
    await model.start()
    unknown_content = {"unknown_field": "value"}
    with pytest.raises(ValueError, match=r"content not supported"):
        await model.send(unknown_content)

    await model.stop()


# Receive Method Tests


@pytest.mark.asyncio
async def test_receive_lifecycle_events(mock_genai_client, model, agenerator):
    """Test that receive() emits connection start and end events."""
    _, mock_live_session, _ = mock_genai_client
    mock_live_session.receive.return_value = agenerator([])

    await model.start()

    async for event in model.receive():
        _ = event
        break

    # Verify connection start and end
    assert isinstance(event, BidiConnectionStartEvent)
    assert event.get("type") == "bidi_connection_start"
    assert event.connection_id == model._connection_id


@pytest.mark.asyncio
async def test_receive_timeout(mock_genai_client, model, agenerator, live_message):
    mock_resumption_update = unittest.mock.Mock()
    mock_resumption_update.resumable = True
    mock_resumption_update.new_handle = "h1"
    mock_resumption_response = live_message(session_resumption_update=mock_resumption_update)

    mock_go_away = unittest.mock.Mock()
    mock_go_away.model_dump_json.return_value = "test timeout"
    mock_timeout_response = live_message(go_away=mock_go_away)

    _, mock_live_session, _ = mock_genai_client
    mock_live_session.receive = unittest.mock.Mock(
        return_value=agenerator([mock_resumption_response, mock_timeout_response])
    )

    await model.start()

    with pytest.raises(BidiModelTimeoutError, match=r"test timeout"):
        async for _ in model.receive():
            pass

    tru_handle = model._live_session_handle
    exp_handle = "h1"
    assert tru_handle == exp_handle


@pytest.mark.asyncio
async def test_event_conversion(mock_genai_client, model, live_message, server_content, text_part):
    """Test conversion of all Gemini Live event types to standard format."""
    _, _, _ = mock_genai_client
    await model.start()
    # Simulate a response already in flight so these cases assert pure content conversion,
    # not the response-start that a turn's first model output would otherwise prepend.
    turn_state = _TurnState(response_open=True)

    # Test text output (converted to transcript via model_turn.parts)
    mock_model_turn = unittest.mock.Mock()
    mock_model_turn.parts = [text_part("Hello from Gemini")]
    mock_text = live_message(server_content=server_content(model_turn=mock_model_turn))

    text_events = model._convert_gemini_live_event(mock_text, turn_state)
    assert isinstance(text_events, list)
    assert len(text_events) == 1
    text_event = text_events[0]
    assert isinstance(text_event, BidiTranscriptStreamEvent)
    assert text_event.get("type") == "bidi_transcript_stream"
    assert text_event.text == "Hello from Gemini"
    assert text_event.role == "assistant"
    assert text_event.is_final is True
    assert text_event.delta == {"text": "Hello from Gemini"}
    assert text_event.current_transcript == "Hello from Gemini"

    # Test multiple text parts (should concatenate)
    mock_model_turn_multi = unittest.mock.Mock()
    mock_model_turn_multi.parts = [text_part("Hello"), text_part("from Gemini")]
    mock_multi_text = live_message(server_content=server_content(model_turn=mock_model_turn_multi))

    multi_text_events = model._convert_gemini_live_event(mock_multi_text, turn_state)
    assert isinstance(multi_text_events, list)
    assert len(multi_text_events) == 1
    multi_text_event = multi_text_events[0]
    assert isinstance(multi_text_event, BidiTranscriptStreamEvent)
    assert multi_text_event.text == "Hello from Gemini"  # Concatenated with space

    # Test audio output (base64 encoded)
    mock_audio = live_message(data=b"audio_data")

    audio_events = model._convert_gemini_live_event(mock_audio, turn_state)
    assert isinstance(audio_events, list)
    assert len(audio_events) == 1
    audio_event = audio_events[0]
    assert isinstance(audio_event, BidiAudioStreamEvent)
    assert audio_event.get("type") == "bidi_audio_stream"
    # Audio is now base64 encoded
    expected_b64 = base64.b64encode(b"audio_data").decode("utf-8")
    assert audio_event.audio == expected_b64
    assert audio_event.format == "pcm"

    # Test single tool call (returns list with one event)
    mock_func_call = unittest.mock.Mock()
    mock_func_call.id = "tool-123"
    mock_func_call.name = "calculator"
    mock_func_call.args = {"expression": "2+2"}

    mock_tool_call = unittest.mock.Mock()
    mock_tool_call.function_calls = [mock_func_call]

    mock_tool = live_message(tool_call=mock_tool_call)

    tool_events = model._convert_gemini_live_event(mock_tool, turn_state)
    # Should return a list of ToolUseStreamEvent
    assert isinstance(tool_events, list)
    assert len(tool_events) == 1
    tool_event = tool_events[0]
    # ToolUseStreamEvent has delta and current_tool_use, not a "type" field
    assert "delta" in tool_event
    assert "toolUse" in tool_event["delta"]
    assert tool_event["delta"]["toolUse"]["toolUseId"] == "tool-123"
    assert tool_event["delta"]["toolUse"]["name"] == "calculator"
    assert tool_event["delta"]["toolUse"]["input"] == json.dumps({"expression": "2+2"})
    assert tool_event["current_tool_use"]["input"] == {"expression": "2+2"}

    # Test multiple tool calls (returns list with multiple events)
    mock_func_call_1 = unittest.mock.Mock()
    mock_func_call_1.id = "tool-123"
    mock_func_call_1.name = "calculator"
    mock_func_call_1.args = {"expression": "2+2"}

    mock_func_call_2 = unittest.mock.Mock()
    mock_func_call_2.id = "tool-456"
    mock_func_call_2.name = "weather"
    mock_func_call_2.args = {"location": "Seattle"}

    mock_tool_call_multi = unittest.mock.Mock()
    mock_tool_call_multi.function_calls = [mock_func_call_1, mock_func_call_2]

    mock_tool_multi = live_message(tool_call=mock_tool_call_multi)

    tool_events_multi = model._convert_gemini_live_event(mock_tool_multi, turn_state)
    # Should return a list with two ToolUseStreamEvent
    assert isinstance(tool_events_multi, list)
    assert len(tool_events_multi) == 2

    # Verify first tool call
    assert tool_events_multi[0]["delta"]["toolUse"]["toolUseId"] == "tool-123"
    assert tool_events_multi[0]["delta"]["toolUse"]["name"] == "calculator"
    assert tool_events_multi[0]["delta"]["toolUse"]["input"] == json.dumps({"expression": "2+2"})
    assert tool_events_multi[0]["current_tool_use"]["input"] == {"expression": "2+2"}

    # Verify second tool call
    assert tool_events_multi[1]["delta"]["toolUse"]["toolUseId"] == "tool-456"
    assert tool_events_multi[1]["delta"]["toolUse"]["name"] == "weather"
    assert tool_events_multi[1]["delta"]["toolUse"]["input"] == json.dumps({"location": "Seattle"})
    assert tool_events_multi[1]["current_tool_use"]["input"] == {"location": "Seattle"}

    # Test interruption
    mock_interrupt = live_message(server_content=server_content(interrupted=True))

    interrupt_events = model._convert_gemini_live_event(mock_interrupt, turn_state)
    assert isinstance(interrupt_events, list)
    assert len(interrupt_events) == 1
    interrupt_event = interrupt_events[0]
    assert isinstance(interrupt_event, BidiInterruptionEvent)
    assert interrupt_event.get("type") == "bidi_interruption"
    assert interrupt_event.reason == "user_speech"

    await model.stop()


# Usage Metadata Tests


@pytest.mark.asyncio
async def test_usage_metadata_emitted_alongside_audio(mock_genai_client, model, live_message, usage_metadata):
    """Usage metadata accompanying content is emitted, not dropped.

    Guards https://github.com/strands-agents/harness-sdk/issues/3745 — usageMetadata sits outside the
    messageType union, so it can ride along with any content field.
    """
    _, _, _ = mock_genai_client
    await model.start()
    turn_state = _TurnState(response_open=True)  # mid-response, so no response-start is prepended

    message = live_message(data=b"audio_data", usage_metadata=usage_metadata())

    events = model._convert_gemini_live_event(message, turn_state)

    assert [type(event) for event in events] == [BidiAudioStreamEvent, BidiUsageEvent]
    assert events[1] == BidiUsageEvent(
        input_tokens=10,
        output_tokens=20,
        total_tokens=30,
        modality_details=None,
        cache_read_input_tokens=None,
    )

    await model.stop()


@pytest.mark.asyncio
async def test_usage_metadata_emitted_alongside_session_resumption(
    mock_genai_client, model, live_message, usage_metadata
):
    """Session resumption tracks the handle and still emits co-attached usage metadata.

    Guards https://github.com/strands-agents/harness-sdk/issues/3745 — this branch previously
    returned early, discarding usage outright.
    """
    _, _, _ = mock_genai_client
    await model.start()

    mock_resumption_update = unittest.mock.Mock()
    mock_resumption_update.resumable = True
    mock_resumption_update.new_handle = "handle-1"
    message = live_message(session_resumption_update=mock_resumption_update, usage_metadata=usage_metadata())

    events = model._convert_gemini_live_event(message, _TurnState())

    assert model._live_session_handle == "handle-1"
    assert events == [
        BidiUsageEvent(
            input_tokens=10,
            output_tokens=20,
            total_tokens=30,
            modality_details=None,
            cache_read_input_tokens=None,
        )
    ]

    await model.stop()


@pytest.mark.asyncio
async def test_usage_metadata_modality_details(mock_genai_client, model, live_message, usage_metadata):
    """Prompt and response token details merge into per-modality usage."""
    _, _, _ = mock_genai_client
    await model.start()

    prompt_detail = unittest.mock.Mock()
    prompt_detail.modality = "AUDIO"
    prompt_detail.token_count = 7

    response_detail = unittest.mock.Mock()
    response_detail.modality = "AUDIO"
    response_detail.token_count = 9

    message = live_message(
        usage_metadata=usage_metadata(
            prompt_tokens_details=[prompt_detail],
            response_tokens_details=[response_detail],
            cached_content_token_count=4,
        )
    )

    events = model._convert_gemini_live_event(message, _TurnState())

    assert events == [
        BidiUsageEvent(
            input_tokens=10,
            output_tokens=20,
            total_tokens=30,
            modality_details=[{"modality": "audio", "input_tokens": 7, "output_tokens": 9}],
            cache_read_input_tokens=4,
        )
    ]

    await model.stop()


@pytest.mark.asyncio
async def test_interruption_emitted_alongside_other_server_content(
    mock_genai_client, model, live_message, server_content
):
    """An interruption is emitted even when other server content fields are set.

    Guards https://github.com/strands-agents/harness-sdk/issues/3745 — interrupted may co-occur with
    other serverContent fields and must not swallow them.
    """
    _, _, _ = mock_genai_client
    await model.start()

    mock_output_transcript = unittest.mock.Mock()
    mock_output_transcript.text = "partial reply"
    mock_output_transcript.finished = False

    message = live_message(server_content=server_content(interrupted=True, output_transcription=mock_output_transcript))

    events = model._convert_gemini_live_event(message, _TurnState())

    assert [type(event) for event in events] == [BidiInterruptionEvent, BidiTranscriptStreamEvent]

    await model.stop()


@pytest.mark.asyncio
async def test_audio_takes_precedence_over_model_turn_text(
    mock_genai_client, model, live_message, server_content, text_part
):
    """Audio output suppresses model_turn text, avoiding a duplicate event for one response."""
    _, _, _ = mock_genai_client
    await model.start()
    turn_state = _TurnState(response_open=True)  # mid-response, so no response-start is prepended

    mock_model_turn = unittest.mock.Mock()
    mock_model_turn.parts = [text_part("Hello from Gemini")]
    message = live_message(data=b"audio_data", server_content=server_content(model_turn=mock_model_turn))

    events = model._convert_gemini_live_event(message, turn_state)

    assert [type(event) for event in events] == [BidiAudioStreamEvent]

    await model.stop()


@pytest.mark.asyncio
async def test_empty_message_emits_nothing(mock_genai_client, model, live_message):
    """A message carrying no content and no usage yields no events."""
    _, _, _ = mock_genai_client
    await model.start()

    assert model._convert_gemini_live_event(live_message(), _TurnState()) == []

    await model.stop()


# Turn-Boundary Tests


@pytest.mark.asyncio
async def test_first_model_output_opens_response(mock_genai_client, model, live_message):
    """The first model output of a turn is bracketed by a response-start event."""
    _, _, _ = mock_genai_client
    await model.start()
    turn_state = _TurnState()

    events = model._convert_gemini_live_event(live_message(data=b"audio_data"), turn_state)
    assert [type(event) for event in events] == [BidiResponseStartEvent, BidiAudioStreamEvent]
    assert turn_state.response_open is True

    # A later output in the same turn does not re-open the response.
    more = model._convert_gemini_live_event(live_message(data=b"more_audio"), turn_state)
    assert [type(event) for event in more] == [BidiAudioStreamEvent]

    await model.stop()


@pytest.mark.asyncio
async def test_turn_complete_closes_response(mock_genai_client, model, live_message, server_content):
    """turn_complete closes an open response with a response-complete event."""
    _, _, _ = mock_genai_client
    await model.start()
    turn_state = _TurnState(response_open=True, response_id="r1")

    events = model._convert_gemini_live_event(
        live_message(server_content=server_content(turn_complete=True)), turn_state
    )

    assert [type(event) for event in events] == [BidiResponseCompleteEvent]
    assert events[0].stop_reason == "complete"
    assert turn_state.response_open is False


@pytest.mark.asyncio
async def test_turn_complete_without_open_response_emits_nothing(
    mock_genai_client, model, live_message, server_content
):
    """turn_complete with no response in flight does not emit a spurious complete event."""
    _, _, _ = mock_genai_client
    await model.start()

    events = model._convert_gemini_live_event(
        live_message(server_content=server_content(turn_complete=True)), _TurnState()
    )
    assert events == []


@pytest.mark.asyncio
async def test_interruption_closes_response_without_complete(mock_genai_client, model, live_message, server_content):
    """An interruption ends the turn without emitting a response-complete."""
    _, _, _ = mock_genai_client
    await model.start()
    turn_state = _TurnState(response_open=True)

    events = model._convert_gemini_live_event(live_message(server_content=server_content(interrupted=True)), turn_state)

    assert [type(event) for event in events] == [BidiInterruptionEvent]
    assert turn_state.response_open is False


# Audio Configuration Tests


def test_audio_config_defaults(mock_genai_client, model_id, api_key):
    """Test default audio configuration."""
    _ = mock_genai_client

    model = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})

    assert model.audio_config == {
        "input_rate": 16000,
        "output_rate": 24000,
        "channels": 1,
        "format": "pcm",
    }


def test_audio_config_partial_override(mock_genai_client, model_id, api_key):
    """Test partial audio configuration override."""
    _ = mock_genai_client

    model = GoogleGeminiLiveModel(
        model_id=model_id,
        client_args={"api_key": api_key},
        audio={"output_rate": 48000, "voice": "Puck"},
    )

    assert model.audio_config == {
        "input_rate": 16000,
        "output_rate": 48000,
        "channels": 1,
        "format": "pcm",
        "voice": "Puck",
    }


def test_audio_config_full_override(mock_genai_client, model_id, api_key):
    """Test full audio configuration override."""
    _ = mock_genai_client

    model = GoogleGeminiLiveModel(
        model_id=model_id,
        client_args={"api_key": api_key},
        audio={
            "input_rate": 48000,
            "output_rate": 48000,
            "channels": 2,
            "format": "pcm",
            "voice": "Aoede",
        },
    )

    assert model.audio_config == {
        "input_rate": 48000,
        "output_rate": 48000,
        "channels": 2,
        "format": "pcm",
        "voice": "Aoede",
    }


# Helper Method Tests


def test_config_building(model, system_prompt, tool_spec):
    """Test building live config with various options."""
    # Test basic config
    config_basic = model._build_live_config()
    assert isinstance(config_basic, dict)

    # Test with system prompt
    config_prompt = model._build_live_config(system_prompt=system_prompt)
    assert config_prompt["system_instruction"] == system_prompt

    # Test with tools
    config_tools = model._build_live_config(tools=[tool_spec])
    assert "tools" in config_tools
    assert len(config_tools["tools"]) > 0

    # Test session_resumption — always present, uses SessionResumptionConfig
    config_no_handle = model._build_live_config()
    assert "session_resumption" in config_no_handle
    assert isinstance(config_no_handle["session_resumption"], genai_types.SessionResumptionConfig)
    assert config_no_handle["session_resumption"].handle is None

    config_with_handle = model._build_live_config(live_session_handle="test-handle-123")
    assert config_with_handle["session_resumption"].handle == "test-handle-123"

    # Test history_config — only set when has_messages=True
    config_no_messages = model._build_live_config(has_messages=False)
    assert "history_config" not in config_no_messages

    config_with_messages = model._build_live_config(has_messages=True)
    assert isinstance(config_with_messages["history_config"], genai_types.HistoryConfig)
    assert config_with_messages["history_config"].initial_history_in_client_content is True


def test__build_live_config_passes_through_params(mock_genai_client, api_key):
    """Test model params are passed through to the live session."""
    _ = mock_genai_client
    model = GoogleGeminiLiveModel(
        client_args={"api_key": api_key},
        params={"temperature": 0.7, "proactivity": {"proactive_audio": True}},
    )

    config = model._build_live_config()

    assert config["temperature"] == 0.7
    assert config["proactivity"] == {"proactive_audio": True}


def test_tool_formatting(model, tool_spec):
    """Test tool formatting for Gemini Live API."""
    # Test with tools
    formatted_tools = model._format_tools_for_live_api([tool_spec])
    assert len(formatted_tools) == 1
    assert isinstance(formatted_tools[0], genai_types.Tool)

    # Test empty list
    formatted_empty = model._format_tools_for_live_api([])
    assert formatted_empty == []


# Tool Result Content Tests


@pytest.mark.asyncio
async def test_custom_audio_rates_in_events(mock_genai_client, model_id, api_key, live_message):
    """Test that audio events use configured sample rates and channels."""
    _, _, _ = mock_genai_client

    model = GoogleGeminiLiveModel(
        model_id=model_id,
        client_args={"api_key": api_key},
        audio={"output_rate": 48000, "channels": 2},
    )
    await model.start()
    turn_state = _TurnState(response_open=True)  # mid-response, so no response-start is prepended

    # Test audio output event uses custom configuration
    mock_audio = live_message(data=b"audio_data")

    audio_events = model._convert_gemini_live_event(mock_audio, turn_state)
    assert len(audio_events) == 1
    audio_event = audio_events[0]
    assert isinstance(audio_event, BidiAudioStreamEvent)
    # Should use configured rates, not constants
    assert audio_event.sample_rate == 48000  # Custom config
    assert audio_event.channels == 2  # Custom config
    assert audio_event.format == "pcm"

    await model.stop()


@pytest.mark.asyncio
async def test_default_audio_rates_in_events(mock_genai_client, model_id, api_key, live_message):
    """Test that audio events use default sample rates when no custom config."""
    _, _, _ = mock_genai_client

    # Create model without custom audio configuration
    model = GoogleGeminiLiveModel(model_id=model_id, client_args={"api_key": api_key})
    await model.start()
    turn_state = _TurnState(response_open=True)  # mid-response, so no response-start is prepended

    # Test audio output event uses defaults
    mock_audio = live_message(data=b"audio_data")

    audio_events = model._convert_gemini_live_event(mock_audio, turn_state)
    assert len(audio_events) == 1
    audio_event = audio_events[0]
    assert isinstance(audio_event, BidiAudioStreamEvent)
    # Should use default rates
    assert audio_event.sample_rate == 24000  # Default output rate
    assert audio_event.channels == 1  # Default channels
    assert audio_event.format == "pcm"

    await model.stop()


# Tool Result Content Tests


@pytest.mark.asyncio
async def test_tool_result_single_content_unwrapped(mock_genai_client, model):
    """Test that single content item is unwrapped (optimization)."""
    _, mock_live_session, _ = mock_genai_client
    await model.start()

    tool_result: ToolResult = {
        "toolUseId": "tool-123",
        "status": "success",
        "content": [{"text": "Single result"}],
    }

    await model.send(ToolResultEvent(tool_result))

    # Verify the tool response was sent
    mock_live_session.send_tool_response.assert_called_once()
    call_args = mock_live_session.send_tool_response.call_args
    function_responses = call_args.kwargs.get("function_responses", [])

    assert len(function_responses) == 1
    func_response = function_responses[0]
    assert func_response.id == "tool-123"
    # Single content should be unwrapped (not in array)
    assert func_response.response == {"text": "Single result"}

    await model.stop()


@pytest.mark.asyncio
async def test_tool_result_multiple_content_as_array(mock_genai_client, model):
    """Test that multiple content items are sent as array."""
    _, mock_live_session, _ = mock_genai_client
    await model.start()

    tool_result: ToolResult = {
        "toolUseId": "tool-456",
        "status": "success",
        "content": [{"text": "Part 1"}, {"json": {"data": "value"}}],
    }

    await model.send(ToolResultEvent(tool_result))

    # Verify the tool response was sent
    mock_live_session.send_tool_response.assert_called_once()
    call_args = mock_live_session.send_tool_response.call_args
    function_responses = call_args.kwargs.get("function_responses", [])

    assert len(function_responses) == 1
    func_response = function_responses[0]
    assert func_response.id == "tool-456"
    # Multiple content should be in array format
    assert "result" in func_response.response
    assert isinstance(func_response.response["result"], list)
    assert len(func_response.response["result"]) == 2
    assert func_response.response["result"][0] == {"text": "Part 1"}
    assert func_response.response["result"][1] == {"json": {"data": "value"}}

    await model.stop()


@pytest.mark.asyncio
async def test_tool_result_unsupported_content_type(mock_genai_client, model):
    """Test that unsupported content types raise ValueError."""
    _, _, _ = mock_genai_client
    await model.start()

    # Test with image content (unsupported)
    tool_result_image: ToolResult = {
        "toolUseId": "tool-999",
        "status": "success",
        "content": [{"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by Gemini Live API"):
        await model.send(ToolResultEvent(tool_result_image))

    # Test with document content (unsupported)
    tool_result_doc: ToolResult = {
        "toolUseId": "tool-888",
        "status": "success",
        "content": [{"document": {"format": "pdf", "source": {"bytes": b"doc_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by Gemini Live API"):
        await model.send(ToolResultEvent(tool_result_doc))

    # Test with mixed content (one unsupported)
    tool_result_mixed: ToolResult = {
        "toolUseId": "tool-777",
        "status": "success",
        "content": [{"text": "Valid text"}, {"image": {"format": "jpeg", "source": {"bytes": b"image_data"}}}],
    }

    with pytest.raises(ValueError, match=r"Content type not supported by Gemini Live API"):
        await model.send(ToolResultEvent(tool_result_mixed))

    await model.stop()


# Helper fixture for async generator
@pytest.fixture
def agenerator():
    """Helper to create async generators for testing."""

    async def _agenerator(items):
        for item in items:
            yield item

    return _agenerator
