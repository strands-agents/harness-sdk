"""Unit tests for BidiAgent."""

import asyncio
import sys
import unittest.mock
from types import ModuleType
from uuid import uuid4

import pytest

from strands import LocalAgent, ToolContext, tool
from strands.experimental.bidi.agent.agent import BidiAgent
from strands.experimental.bidi.models.model import BidiModel
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionCloseEvent,
    BidiConnectionStartEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
)
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.types.content import SystemContentBlock


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
        yield BidiConnectionCloseEvent(connection_id=self._connection_id, reason="complete")

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
    from strands.experimental.bidi.models.bedrock import BedrockNovaSonicModel

    agent = BidiAgent(model=None)

    assert isinstance(agent.model, BedrockNovaSonicModel)


@pytest.mark.skipif(sys.version_info < (3, 12), reason="BedrockNovaSonicModel is only supported for Python 3.12+")
def test_bidi_agent_init_with_model_id():
    from strands.experimental.bidi.models.bedrock import BedrockNovaSonicModel

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
async def test_bidi_agent_send_with_input_types(agent):
    """Test sending various input types through agent.send()."""
    await agent.start()

    # Test text input with TypedEvent
    text_input = BidiTextInputEvent(text="Hello", role="user")
    await agent.send(text_input)
    assert len(agent.messages) == 1
    assert agent.messages[0]["content"][0]["text"] == "Hello"

    # Test string input (shorthand)
    await agent.send("World")
    assert len(agent.messages) == 2
    assert agent.messages[1]["content"][0]["text"] == "World"

    # Test audio input (doesn't add to messages)
    audio_input = BidiAudioInputEvent(
        audio="dGVzdA==",  # base64 "test"
        format="pcm",
        sample_rate=16000,
        channels=1,
    )
    await agent.send(audio_input)
    assert len(agent.messages) == 2  # Still 2, audio doesn't add

    # Test concurrent sends
    sends = [agent.send(BidiTextInputEvent(text=f"Message {i}", role="user")) for i in range(3)]
    await asyncio.gather(*sends)
    assert len(agent.messages) == 5  # 2 + 3 new messages


@pytest.mark.asyncio
async def test_bidi_agent_receive_events_from_model(agent):
    """Test receiving events from model."""
    # Configure mock model to yield events
    events = [
        BidiAudioStreamEvent(audio="dGVzdA==", format="pcm", sample_rate=24000, channels=1),
        BidiTranscriptStreamEvent(delta="Hello world", role="assistant"),
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
    assert isinstance(received_events[1], BidiAudioStreamEvent)
    assert isinstance(received_events[2], BidiTranscriptStreamEvent)

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
        await agent.send(BidiTextInputEvent(text="Hello", role="user"))

    # Test receive before start
    with pytest.raises(RuntimeError, match="call start before"):
        async for _ in agent.receive():
            pass

    # Test send after stop
    await agent.start()
    await agent.stop()
    with pytest.raises(RuntimeError, match="call start before"):
        await agent.send(BidiTextInputEvent(text="Hello", role="user"))

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
    await agent.send(BidiTextInputEvent(text="Hello", role="user"))
    assert agent._started
    assert agent.model._connection_id == connection_id

    # Stop
    await agent.stop()
    assert not agent._started
    assert agent.model._connection_id is None


@pytest.mark.asyncio
async def test_bidi_agent_run_audio_delegates_to_run(agent, monkeypatch):
    audio_io = unittest.mock.Mock()
    audio_io_class = unittest.mock.Mock(return_value=audio_io)
    audio_module = ModuleType("strands.experimental.bidi.io.audio")
    audio_module.BidiAudioIO = audio_io_class
    monkeypatch.setitem(sys.modules, "strands.experimental.bidi.io.audio", audio_module)
    agent.run = unittest.mock.AsyncMock()
    invocation_state = {"user_id": "user_123"}

    await agent.run_audio(
        audio_processor=True,
        input_device_index=1,
        invocation_state=invocation_state,
    )

    audio_io_class.assert_called_once_with(audio_processor=True, input_device_index=1)
    agent.run.assert_awaited_once_with(
        inputs=[audio_io.input.return_value],
        outputs=[audio_io.output.return_value],
        invocation_state=invocation_state,
    )
