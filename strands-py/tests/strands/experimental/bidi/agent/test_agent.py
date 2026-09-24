"""Unit tests for BidiAgent."""

import asyncio
import sys
import unittest.mock
from uuid import uuid4

import pytest

from strands import LocalAgent, ToolContext, tool
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BidiModel
from strands.experimental.bidi.types import (
    AudioDelta,
    BidiAudioDeltaEvent,
    BidiConnectionStartEvent,
    BidiConnectionStopEvent,
    BidiTranscriptDeltaEvent,
)
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, MessageUpdatedEvent
from strands.types.content import SystemContentBlock, TextBlock
from strands.types.media import AudioBlock, ImageBlock
from strands.types.tools import ToolResultBlock
from tests.fixtures.mock_hook_provider import MockHookProvider


class MockBidiModel(BidiModel):
    """Mock bidirectional model for testing."""

    def __init__(self, config=None, model_id="mock-model"):
        self._config = config or {"audio": {"input_rate": 16000, "output_rate": 24000, "channels": 1}}
        self.usage_is_cumulative = False
        self._config["model_id"] = model_id
        self._connection_id = None
        self._started = False
        self._events_to_yield = []

    def update_config(self, **model_config):
        self._config.update(model_config)

    def get_config(self):
        return self._config.copy()

    async def start(self, system_prompt=None, tools=None, messages=None, **kwargs):
        if self._started:
            raise RuntimeError("model already started | call stop before starting again")
        self._connection_id = str(uuid4())
        self._started = True

    async def stop(self):
        if self._started:
            self._started = False
            self._connection_id = None

    async def restart(self, system_prompt=None, tools=None, messages=None, **restart_kwargs):
        await self.stop()
        await self.start(system_prompt, tools, messages, **restart_kwargs)

    async def send(self, content):
        if not self._started:
            raise RuntimeError("model not started | call start before sending")
        # Mock implementation - in real tests, this would trigger events

    async def receive(self):
        """Async generator yielding mock events."""
        if not self._started:
            raise RuntimeError("model not started | call start before receiving")

        # Yield connection start event
        yield BidiConnectionStartEvent(connection_id=self._connection_id, model=self.model_id)

        # Yield any configured events
        for event in self._events_to_yield:
            yield event

        # Yield connection end event
        yield BidiConnectionStopEvent(connection_id=self._connection_id, reason="complete")

    def set_events(self, events):
        """Helper to set events this mock model will yield."""
        self._events_to_yield = events


@pytest.fixture
def mock_model():
    """Create a mock BidiModel instance."""
    return MockBidiModel()


@pytest.fixture
def mock_tool_registry():
    """Mock tool registry with some basic tools."""
    registry = unittest.mock.Mock()
    registry.get_all_tool_specs.return_value = [
        {
            "name": "calculator",
            "description": "Perform calculations",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    ]
    registry.get_all_tools_config.return_value = {"calculator": {}}
    return registry


@pytest.fixture
def mock_tool_caller():
    """Mock tool caller for testing tool execution."""
    caller = unittest.mock.AsyncMock()
    caller.call_tool = unittest.mock.AsyncMock()
    return caller


@pytest.fixture
def agent(mock_model, mock_tool_registry, mock_tool_caller):
    """Create a BidiAgent instance for testing."""
    with unittest.mock.patch("strands.experimental.bidi.agent.agent.ToolRegistry") as mock_registry_class:
        mock_registry_class.return_value = mock_tool_registry

        with unittest.mock.patch("strands.experimental.bidi.agent.agent._ToolCaller") as mock_caller_class:
            mock_caller_class.return_value = mock_tool_caller

            # Don't pass tools to avoid real tool loading
            agent = BidiAgent(model=mock_model)
            return agent


def test_bidi_agent_init_with_various_configurations():
    """Test agent initialization with various configurations."""
    # Test default initialization
    mock_model = MockBidiModel()
    agent = BidiAgent(model=mock_model)

    assert agent.model == mock_model
    assert agent.system_prompt is None
    assert agent.system_prompt_content is None
    assert not agent._started
    assert agent.model._connection_id is None

    # Test with configuration
    system_prompt = "You are a helpful assistant."
    agent_with_config = BidiAgent(model=mock_model, system_prompt=system_prompt, agent_id="test_agent")

    assert agent_with_config.system_prompt == system_prompt
    assert agent_with_config.system_prompt_content == [{"text": system_prompt}]
    assert agent_with_config.agent_id == "test_agent"

    # Test model config access
    config = agent.model.get_config()
    assert config["audio"]["input_rate"] == 16000
    assert config["audio"]["output_rate"] == 24000
    assert config["audio"]["channels"] == 1


def test_bidi_agent_system_prompt_setter(mock_model):
    """Test setting the system prompt updates its content blocks."""
    agent = BidiAgent(model=mock_model, system_prompt="initial prompt")
    content_blocks: list[SystemContentBlock] = [
        {"text": "updated prompt"},
        {"cachePoint": {"type": "default"}},
        {"text": "additional instructions"},
    ]

    agent.system_prompt = content_blocks

    assert agent.system_prompt == "updated prompt\nadditional instructions"
    assert agent.system_prompt_content == content_blocks


@pytest.mark.parametrize("use_setter", [False, True])
def test_system_prompt_tracks_content_changes(mock_model, use_setter):
    """The string prompt reflects edits to shared content blocks."""
    content_blocks = [{"text": "initial prompt"}, {"cachePoint": {"type": "default"}}]
    agent = BidiAgent(model=mock_model, system_prompt=None if use_setter else content_blocks)
    if use_setter:
        agent.system_prompt = content_blocks

    content_blocks[0]["text"] = "updated prompt"
    assert agent.system_prompt == "updated prompt"

    agent.system_prompt_content[0]["text"] = "another update"
    assert agent.system_prompt == "another update"

    content_blocks.pop(0)
    assert agent.system_prompt is None


@pytest.mark.asyncio
@pytest.mark.parametrize("messages", [[], [{"role": "user", "content": [{"text": "Earlier message"}]}]])
async def test_messages_preserve_caller_list(mock_model, messages):
    """Messages sent by the agent are appended to the caller's history list."""
    agent = BidiAgent(model=mock_model, messages=messages)
    await agent.start()
    try:
        await agent.send("New message")
    finally:
        await agent.stop()

    assert agent.messages is messages
    tru_message = messages[-1]
    exp_message = {
        "role": "user",
        "content": [{"text": "New message"}],
        "tracking_id": unittest.mock.ANY,
    }
    assert tru_message == exp_message


def test_bidi_agent_tool_emits_shared_hook_events_and_retries(mock_model):
    """Test BidiAgent emits shared tool hook events and honors retry requests."""
    call_count = 0
    hook_events: list[BeforeToolCallEvent[LocalAgent] | AfterToolCallEvent[LocalAgent]] = []

    @tool
    def counting_tool() -> str:
        nonlocal call_count
        call_count += 1
        return f"attempt_{call_count}"

    agent = BidiAgent(model=mock_model, tools=[counting_tool])

    def record_before(event: BeforeToolCallEvent[LocalAgent]) -> None:
        hook_events.append(event)

    def retry_once(event: AfterToolCallEvent[LocalAgent]) -> None:
        hook_events.append(event)
        event.retry = call_count == 1

    agent.add_hook(record_before)
    agent.add_hook(retry_once)

    result = agent.tool.counting_tool(record_direct_tool_call=False)

    assert call_count == 2
    assert [type(event) for event in hook_events] == [
        BeforeToolCallEvent,
        AfterToolCallEvent,
        BeforeToolCallEvent,
        AfterToolCallEvent,
    ]
    assert all(event.agent is agent for event in hook_events)
    assert result["content"] == [{"text": "attempt_2"}]


def test_bidi_agent_tool_injects_local_agent(mock_model):
    """Test context-aware tools receive BidiAgent through LocalAgent."""

    @tool(context=True)
    def context_tool(tool_context: ToolContext[LocalAgent]) -> str:
        assert tool_context.agent is agent
        return tool_context.agent.name

    agent = BidiAgent(model=mock_model, tools=[context_tool], name="test_agent")

    result = agent.tool.context_tool(record_direct_tool_call=False)

    assert result["content"] == [{"text": "test_agent"}]


def test_bidi_agent_init_with_unsupported_model():
    """Test agent initialization rejects unsupported model types."""
    with pytest.raises(TypeError, match="model must be a BidiModel, string, or None"):
        BidiAgent(model=object())


def test_bidi_agent_session_id_without_session_manager(mock_model):
    """Test the generated session identifier remains stable."""
    agent = BidiAgent(model=mock_model)

    first = agent.session_id
    second = agent.session_id

    assert first == second
    assert len(first) == 8


def test_bidi_agent_session_id_delegates_to_session_manager(mock_model):
    """Test the session manager's persistent identifier is exposed."""
    session_manager = unittest.mock.Mock()
    session_manager.session_id = "test-session"

    agent = BidiAgent(model=mock_model, session_manager=session_manager)

    assert agent.session_id == "test-session"


@pytest.mark.skipif(sys.version_info < (3, 12), reason="BedrockNovaSonicModel is only supported for Python 3.12+")
def test_bidi_agent_init_with_default_model():
    from strands.experimental.bidi.models import BedrockNovaSonicModel

    agent = BidiAgent(model=None)

    assert isinstance(agent.model, BedrockNovaSonicModel)


@pytest.mark.skipif(sys.version_info < (3, 12), reason="BedrockNovaSonicModel is only supported for Python 3.12+")
def test_bidi_agent_init_with_model_id():
    from strands.experimental.bidi.models import BedrockNovaSonicModel

    model_id = "amazon.nova-sonic-v1:0"
    agent = BidiAgent(model=model_id)

    assert isinstance(agent.model, BedrockNovaSonicModel)
    assert agent.model.model_id == model_id


@pytest.mark.asyncio
async def test_bidi_agent_start_stop_lifecycle(agent):
    """Test agent start/stop lifecycle and state management."""
    # Initial state
    assert not agent._started
    assert agent.model._connection_id is None

    # Start agent
    await agent.start()
    assert agent._started
    assert agent.model._connection_id is not None
    connection_id = agent.model._connection_id

    # Double start should error
    with pytest.raises(RuntimeError, match="agent already started"):
        await agent.start()

    # Stop agent
    await agent.stop()
    assert not agent._started
    assert agent.model._connection_id is None

    # Multiple stops should be safe
    await agent.stop()
    await agent.stop()

    # Restart should work with new connection ID
    await agent.start()
    assert agent._started
    assert agent.model._connection_id != connection_id


@pytest.mark.asyncio
@pytest.mark.parametrize("input_data", ["Hello", {"text": "Hello"}], ids=["string", "dictionary"])
async def test_send_normalizes_text(agent, input_data):
    """Text inputs become text blocks and user messages."""
    await agent.start()
    agent.model.send = unittest.mock.AsyncMock()

    await agent.send(input_data)

    agent.model.send.assert_awaited_once_with(TextBlock("Hello"))
    tru_messages = agent.messages
    exp_messages = [{"role": "user", "content": [{"text": "Hello"}], "tracking_id": unittest.mock.ANY}]
    assert tru_messages == exp_messages


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content_key", "content_type", "media_format"),
    [("audio_delta", AudioDelta, "pcm"), ("image", ImageBlock, "jpeg")],
    ids=["audio", "image"],
)
async def test_send_normalizes_media(agent, content_key, content_type, media_format):
    """Media dictionaries retain their source, and complete blocks enter history."""
    await agent.start()
    agent.model.send = unittest.mock.AsyncMock()
    source = {"bytes": b"\x00\xff"}

    content_data = {content_key: {"format": media_format, "source": source}}
    exp_content = content_type(format=media_format, source=source)
    assert exp_content.to_dict() == content_data

    await agent.send(exp_content.to_dict())

    agent.model.send.assert_awaited_once_with(exp_content)
    assert agent.model.send.await_args.args[0].source is source
    exp_messages = (
        [{"role": "user", "content": [content_data], "tracking_id": unittest.mock.ANY}]
        if content_key == "image"
        else []
    )
    assert agent.messages == exp_messages


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content",
    [
        TextBlock("Hello"),
        AudioDelta(format="pcm", source={"bytes": b"audio"}),
        ImageBlock(format="jpeg", source={"bytes": b"image"}),
    ],
    ids=["text", "audio", "image"],
)
async def test_send_preserves_input_identity(agent, content):
    """Input objects are passed through by reference."""
    await agent.start()
    agent.model.send = unittest.mock.AsyncMock()

    await agent.send(content)

    agent.model.send.assert_awaited_once_with(content)
    assert agent.model.send.await_args.args[0] is content


@pytest.mark.asyncio
async def test_send_concurrent_text(agent):
    """Concurrent sends each reach the model and add one user message."""
    await agent.start()
    agent.model.send = unittest.mock.AsyncMock()
    texts = ["Hello", "World", "Again"]

    await asyncio.gather(*(agent.send({"text": text}) for text in texts))

    tru_calls = agent.model.send.await_args_list
    exp_calls = [unittest.mock.call(TextBlock(text)) for text in texts]
    assert tru_calls == exp_calls
    tru_messages = agent.messages
    exp_messages = [{"role": "user", "content": [{"text": text}], "tracking_id": unittest.mock.ANY} for text in texts]
    assert tru_messages == exp_messages


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("input_data", "error_type"),
    [
        (None, TypeError),
        (123, TypeError),
        ([], TypeError),
        ([{"text": "Hello"}], TypeError),
        (ToolResultBlock(tool_use_id="call-1", status="success", content=[{"text": "Done"}]), TypeError),
        (AudioBlock(format="pcm", source={"bytes": b"audio"}), TypeError),
        ({"audio": {"format": "pcm", "source": {"bytes": b"audio"}}}, ValueError),
        ({"format": "pcm", "source": {"bytes": b"audio"}}, ValueError),
        ({"format": "jpeg", "source": {"bytes": b"image"}}, ValueError),
        ({"audio_delta": None}, TypeError),
        ({"image": b"image"}, TypeError),
        ({}, ValueError),
        ({"document": {"format": "txt", "name": "test", "source": {"bytes": b"test"}}}, ValueError),
        ({"text": "Hello", "image": {"format": "jpeg", "source": {"bytes": b"image"}}}, ValueError),
        ({"toolResult": {"toolUseId": "call-1", "status": "success", "content": [{"text": "Done"}]}}, ValueError),
        ({"audio_delta": {"format": "pcm"}}, TypeError),
        ({"audio_delta": {"format": "pcm", "source": {"bytes": b"audio"}, "extra": True}}, TypeError),
        ({"image": {"format": "jpeg"}}, TypeError),
        ({"image": {"format": "jpeg", "source": {"bytes": b"image"}, "extra": True}}, TypeError),
    ],
)
async def test_send_rejects_invalid_input(agent, input_data, error_type):
    """Invalid input types and malformed content fail before reaching the model."""
    await agent.start()
    agent.model.send = unittest.mock.AsyncMock()

    with pytest.raises(error_type):
        await agent.send(input_data)

    agent.model.send.assert_not_awaited()
    assert agent.messages == []


@pytest.mark.asyncio
async def test_send_preserves_model_type_error(agent):
    """Model errors pass through without being reclassified as invalid input."""
    await agent.start()
    error = TypeError("model failure")
    agent.model.send = unittest.mock.AsyncMock(side_effect=error)

    with pytest.raises(TypeError) as exc_info:
        await agent.send({"audio_delta": {"format": "pcm", "source": {"bytes": b"audio"}}})

    assert exc_info.value is error


@pytest.mark.asyncio
async def test_bidi_agent_receive_events_from_model(agent):
    """Test receiving events from model."""
    # Configure mock model to yield events
    events = [
        BidiAudioDeltaEvent(audio="dGVzdA==", format="pcm", sample_rate=24000, channels=1),
        BidiTranscriptDeltaEvent(delta="Hello world", role="assistant", content_id="assistant-transcript"),
    ]
    agent.model.set_events(events)

    await agent.start()

    received_events = []
    async for event in agent.receive():
        received_events.append(event)
        if len(received_events) >= 4:  # Stop after getting expected events
            break

    # Verify event types and order
    assert len(received_events) >= 3
    assert isinstance(received_events[0], BidiConnectionStartEvent)
    assert isinstance(received_events[1], BidiAudioDeltaEvent)
    assert isinstance(received_events[2], BidiTranscriptDeltaEvent)

    # Test empty events
    agent.model.set_events([])
    await agent.stop()
    await agent.start()

    empty_events = []
    async for event in agent.receive():
        empty_events.append(event)
        if len(empty_events) >= 2:
            break

    assert len(empty_events) >= 1
    assert isinstance(empty_events[0], BidiConnectionStartEvent)


def test_bidi_agent_tool_integration(agent, mock_tool_registry):
    """Test agent tool integration and properties."""
    # Test tool property access
    assert hasattr(agent, "tool")
    assert agent.tool is not None
    assert agent.tool == agent._tool_caller

    # Test tool names property
    mock_tool_registry.get_all_tools_config.return_value = {"calculator": {}, "weather": {}}

    tool_names = agent.tool_names
    assert isinstance(tool_names, list)
    assert len(tool_names) == 2
    assert "calculator" in tool_names
    assert "weather" in tool_names


@pytest.mark.asyncio
async def test_bidi_agent_send_receive_error_before_start(agent):
    """Test error handling in various scenarios."""
    # Test send before start
    with pytest.raises(RuntimeError, match="call start before"):
        await agent.send({"text": "Hello"})

    # Test receive before start
    with pytest.raises(RuntimeError, match="call start before"):
        async for _ in agent.receive():
            pass

    # Test send after stop
    await agent.start()
    await agent.stop()
    with pytest.raises(RuntimeError, match="call start before"):
        await agent.send({"text": "Hello"})

    # Test receive after stop
    with pytest.raises(RuntimeError, match="call start before"):
        async for _ in agent.receive():
            pass


@pytest.mark.asyncio
async def test_bidi_agent_start_receive_propagates_model_errors():
    """Test that model errors are properly propagated."""
    # Test model start error
    mock_model = MockBidiModel()
    mock_model.start = unittest.mock.AsyncMock(side_effect=Exception("Connection failed"))
    error_agent = BidiAgent(model=mock_model)

    with pytest.raises(Exception, match="Connection failed"):
        await error_agent.start()

    # Test model receive error
    mock_model2 = MockBidiModel()
    agent2 = BidiAgent(model=mock_model2)
    await agent2.start()

    async def failing_receive():
        yield BidiConnectionStartEvent(connection_id="test", model="test-model")
        raise Exception("Receive failed")

    agent2.model.receive = failing_receive
    with pytest.raises(Exception, match="Receive failed"):
        async for _ in agent2.receive():
            pass


@pytest.mark.asyncio
async def test_bidi_agent_state_consistency(agent):
    """Test that agent state remains consistent across operations."""
    # Initial state
    assert not agent._started
    assert agent.model._connection_id is None

    # Start
    await agent.start()
    assert agent._started
    assert agent.model._connection_id is not None
    connection_id = agent.model._connection_id

    # Send operations shouldn't change connection state
    await agent.send({"text": "Hello"})
    assert agent._started
    assert agent.model._connection_id == connection_id

    # Stop
    await agent.stop()
    assert not agent._started
    assert agent.model._connection_id is None


@pytest.mark.asyncio
async def test_update_message_finds_copied_message_after_history_edit(agent):
    hooks = MockHookProvider([MessageUpdatedEvent])
    agent.hooks.add_hook(hooks)
    first = {"role": "user", "content": [{"text": "Earlier"}]}
    reserved = {"role": "assistant", "content": []}
    await agent._append_messages(first, reserved)
    tracking_id = reserved["tracking_id"]
    replacement = {**reserved, "content": [{"text": "Answer"}]}
    agent.messages[:] = [reserved.copy()]

    await agent._update_message(replacement)

    assert agent.messages == [replacement]
    assert hooks.events_received == [MessageUpdatedEvent(agent, tracking_id, replacement)]
