"""Tests for A2AAgent class."""

import warnings
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from a2a.client import ClientConfig
from a2a.types import AgentCard, Message, Part, Role, TaskState, TextPart

from strands.agent.a2a_agent import A2AAgent
from strands.agent.agent_result import AgentResult


@pytest.fixture
def mock_agent_card():
    """Mock AgentCard for testing."""
    return AgentCard(
        name="test-agent",
        description="Test agent",
        url="http://localhost:8000",
        version="1.0.0",
        capabilities={},
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=[],
    )


@pytest.fixture
def a2a_agent():
    """Create A2AAgent instance for testing."""
    return A2AAgent(endpoint="http://localhost:8000")


@pytest.fixture
def mock_httpx_client():
    """Create a mock httpx.AsyncClient that works as async context manager."""
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    return mock_client


@asynccontextmanager
async def mock_a2a_client_context(send_message_func):
    """Helper to create mock A2A client setup for _send_message tests."""
    mock_client = MagicMock()
    mock_client.send_message = send_message_func
    with patch("strands.agent.a2a_agent.httpx.AsyncClient") as mock_httpx_class:
        mock_httpx = AsyncMock()
        mock_httpx.__aenter__.return_value = mock_httpx
        mock_httpx.__aexit__.return_value = None
        mock_httpx_class.return_value = mock_httpx
        with patch("strands.agent.a2a_agent.ClientFactory") as mock_factory_class:
            mock_factory = MagicMock()
            mock_factory.create.return_value = mock_client
            mock_factory_class.return_value = mock_factory
            yield mock_httpx_class, mock_factory_class


# === Init Tests ===


def test_init_with_defaults():
    """Test initialization with default parameters."""
    agent = A2AAgent(endpoint="http://localhost:8000")
    assert agent.endpoint == "http://localhost:8000"
    assert agent.timeout == 300
    assert agent._agent_card is None
    assert agent.name is None
    assert agent.description is None


def test_init_with_name_and_description():
    """Test initialization with custom name and description."""
    agent = A2AAgent(endpoint="http://localhost:8000", name="my-agent", description="My custom agent")
    assert agent.name == "my-agent"
    assert agent.description == "My custom agent"


def test_init_with_custom_timeout():
    """Test initialization with custom timeout."""
    agent = A2AAgent(endpoint="http://localhost:8000", timeout=600)
    assert agent.timeout == 600


def test_init_with_client_config():
    """Test initialization with client_config."""
    config = ClientConfig()
    agent = A2AAgent(endpoint="http://localhost:8000", client_config=config)
    assert agent._client_config is config


def test_init_with_external_a2a_client_factory():
    """Test initialization with external A2A client factory emits deprecation warning."""
    external_factory = MagicMock()
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        agent = A2AAgent(endpoint="http://localhost:8000", a2a_client_factory=external_factory)
        assert agent._a2a_client_factory is external_factory
        assert len(w) == 1
        assert issubclass(w[0].category, DeprecationWarning)
        assert "a2a_client_factory is deprecated" in str(w[0].message)
        assert "client_config" in str(w[0].message)


def test_init_with_both_client_config_and_factory_raises():
    """Test that providing both client_config and factory raises ValueError."""
    config = ClientConfig()
    factory = MagicMock()
    with pytest.raises(ValueError, match="Cannot provide both client_config and a2a_client_factory"):
        A2AAgent(endpoint="http://localhost:8000", client_config=config, a2a_client_factory=factory)


def test_init_no_asyncio_lock():
    """Test that A2AAgent does not create an asyncio.Lock in __init__."""
    agent = A2AAgent(endpoint="http://localhost:8000")
    assert not hasattr(agent, "_card_lock")


# === Card Resolution Tests ===


@pytest.mark.asyncio
async def test_get_agent_card(a2a_agent, mock_agent_card, mock_httpx_client):
    """Test agent card discovery."""
    with patch("strands.agent.a2a_agent.httpx.AsyncClient", return_value=mock_httpx_client):
        with patch("strands.agent.a2a_agent.A2ACardResolver") as mock_resolver_class:
            mock_resolver = AsyncMock()
            mock_resolver.get_agent_card = AsyncMock(return_value=mock_agent_card)
            mock_resolver_class.return_value = mock_resolver

            card = await a2a_agent.get_agent_card()

            assert card == mock_agent_card
            assert a2a_agent._agent_card == mock_agent_card


@pytest.mark.asyncio
async def test_get_agent_card_cached(a2a_agent, mock_agent_card):
    """Test that agent card is cached after first discovery."""
    a2a_agent._agent_card = mock_agent_card

    card = await a2a_agent.get_agent_card()

    assert card == mock_agent_card


@pytest.mark.asyncio
async def test_get_agent_card_populates_name_and_description(mock_agent_card, mock_httpx_client):
    """Test that agent card populates name and description if not set."""
    agent = A2AAgent(endpoint="http://localhost:8000")

    with patch("strands.agent.a2a_agent.httpx.AsyncClient", return_value=mock_httpx_client):
        with patch("strands.agent.a2a_agent.A2ACardResolver") as mock_resolver_class:
            mock_resolver = AsyncMock()
            mock_resolver.get_agent_card = AsyncMock(return_value=mock_agent_card)
            mock_resolver_class.return_value = mock_resolver

            await agent.get_agent_card()

            assert agent.name == mock_agent_card.name
            assert agent.description == mock_agent_card.description


@pytest.mark.asyncio
async def test_get_agent_card_preserves_custom_name_and_description(mock_agent_card, mock_httpx_client):
    """Test that custom name and description are not overridden by agent card."""
    agent = A2AAgent(endpoint="http://localhost:8000", name="custom-name", description="Custom description")

    with patch("strands.agent.a2a_agent.httpx.AsyncClient", return_value=mock_httpx_client):
        with patch("strands.agent.a2a_agent.A2ACardResolver") as mock_resolver_class:
            mock_resolver = AsyncMock()
            mock_resolver.get_agent_card = AsyncMock(return_value=mock_agent_card)
            mock_resolver_class.return_value = mock_resolver

            await agent.get_agent_card()

            assert agent.name == "custom-name"
            assert agent.description == "Custom description"


@pytest.mark.asyncio
async def test_get_agent_card_handles_empty_string_name_and_description(mock_httpx_client):
    """Test that empty string name/description from card are preserved (not treated as None)."""
    mock_card = MagicMock(spec=AgentCard)
    mock_card.name = ""
    mock_card.description = ""

    agent = A2AAgent(endpoint="http://localhost:8000")

    with patch("strands.agent.a2a_agent.httpx.AsyncClient", return_value=mock_httpx_client):
        with patch("strands.agent.a2a_agent.A2ACardResolver") as mock_resolver_class:
            mock_resolver = AsyncMock()
            mock_resolver.get_agent_card = AsyncMock(return_value=mock_card)
            mock_resolver_class.return_value = mock_resolver

            await agent.get_agent_card()

            # Empty strings should be set (not treated as falsy/None)
            assert agent.name == ""
            assert agent.description == ""


@pytest.mark.asyncio
async def test_get_agent_card_with_client_config_uses_auth_client():
    """Test that client_config's httpx_client is used for card resolution (fixes auth bug)."""
    mock_auth_client = MagicMock()
    config = ClientConfig(httpx_client=mock_auth_client)

    mock_card = MagicMock(spec=AgentCard)
    mock_card.name = "test"
    mock_card.description = "test"

    agent = A2AAgent(endpoint="http://localhost:8000", client_config=config)

    resolver_httpx_client = None

    def track_resolver_init(*, httpx_client, base_url):
        nonlocal resolver_httpx_client
        resolver_httpx_client = httpx_client
        mock_resolver = AsyncMock()
        mock_resolver.get_agent_card = AsyncMock(return_value=mock_card)
        return mock_resolver

    with patch("strands.agent.a2a_agent.A2ACardResolver", side_effect=track_resolver_init):
        await agent.get_agent_card()

    # CRITICAL: Verify the authenticated client was used for card resolution
    assert resolver_httpx_client is mock_auth_client, (
        "Bug not fixed: authenticated httpx client was not used for card resolution"
    )


@pytest.mark.asyncio
async def test_get_agent_card_without_client_config_uses_default_httpx(mock_httpx_client):
    """Test that card resolution uses bare httpx when no client_config is provided."""
    mock_card = MagicMock(spec=AgentCard)
    mock_card.name = "test"
    mock_card.description = "test"

    agent = A2AAgent(endpoint="http://localhost:8000")

    with patch("strands.agent.a2a_agent.httpx.AsyncClient", return_value=mock_httpx_client) as mock_httpx_class:
        with patch("strands.agent.a2a_agent.A2ACardResolver") as mock_resolver_class:
            mock_resolver = AsyncMock()
            mock_resolver.get_agent_card = AsyncMock(return_value=mock_card)
            mock_resolver_class.return_value = mock_resolver

            await agent.get_agent_card()

            # Should use bare httpx with timeout
            mock_httpx_class.assert_called_once_with(timeout=300)


@pytest.mark.asyncio
async def test_get_agent_card_factory_only_uses_default_httpx(mock_httpx_client):
    """Test that deprecated factory without client_config still uses bare httpx for card resolution."""
    mock_card = MagicMock(spec=AgentCard)
    mock_card.name = "test"
    mock_card.description = "test"

    mock_factory = MagicMock()

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        agent = A2AAgent(endpoint="http://localhost:8000", a2a_client_factory=mock_factory)

    with patch("strands.agent.a2a_agent.httpx.AsyncClient", return_value=mock_httpx_client) as mock_httpx_class:
        with patch("strands.agent.a2a_agent.A2ACardResolver") as mock_resolver_class:
            mock_resolver = AsyncMock()
            mock_resolver.get_agent_card = AsyncMock(return_value=mock_card)
            mock_resolver_class.return_value = mock_resolver

            await agent.get_agent_card()

            # Factory alone does NOT provide auth for card resolution — uses bare httpx
            mock_httpx_class.assert_called_once_with(timeout=300)


@pytest.mark.asyncio
async def test_get_agent_card_client_config_without_httpx_uses_default(mock_httpx_client):
    """Test that client_config without httpx_client falls through to managed httpx (same as no config)."""
    mock_card = MagicMock(spec=AgentCard)
    mock_card.name = "test"
    mock_card.description = "test"

    config = ClientConfig(polling=True)  # No httpx_client
    agent = A2AAgent(endpoint="http://localhost:8000", client_config=config)

    with patch("strands.agent.a2a_agent.httpx.AsyncClient", return_value=mock_httpx_client) as mock_httpx_class:
        with patch("strands.agent.a2a_agent.A2ACardResolver") as mock_resolver_class:
            mock_resolver = AsyncMock()
            mock_resolver.get_agent_card = AsyncMock(return_value=mock_card)
            mock_resolver_class.return_value = mock_resolver

            await agent.get_agent_card()

            # Should use managed httpx with timeout (same as no config path)
            mock_httpx_class.assert_called_once_with(timeout=300)


# === Client Creation Tests ===


@pytest.mark.asyncio
async def test_get_a2a_client_with_client_config_preserves_user_settings(mock_agent_card):
    """Test that _get_a2a_client preserves all user ClientConfig settings via dataclasses.replace."""
    mock_auth_client = MagicMock()
    config = ClientConfig(
        httpx_client=mock_auth_client,
        streaming=False,  # user set this to False
        polling=True,
        supported_transports=["jsonrpc"],
    )

    agent = A2AAgent(endpoint="http://localhost:8000", client_config=config)

    with patch.object(agent, "get_agent_card", return_value=mock_agent_card):
        with patch("strands.agent.a2a_agent.ClientFactory") as mock_factory_class:
            mock_factory = MagicMock()
            mock_factory.create.return_value = MagicMock()
            mock_factory_class.return_value = mock_factory

            async with agent._get_a2a_client():
                pass

            # Verify factory was created with a config that preserves user settings
            mock_factory_class.assert_called_once()
            created_config = mock_factory_class.call_args[0][0]
            assert created_config.httpx_client is mock_auth_client
            assert created_config.streaming is True  # overridden to True
            assert created_config.polling is True  # preserved
            assert created_config.supported_transports == ["jsonrpc"]  # preserved


@pytest.mark.asyncio
async def test_get_a2a_client_with_client_config_does_not_mutate_original(mock_agent_card):
    """Test that _get_a2a_client does not mutate the original client_config."""
    config = ClientConfig(streaming=False)
    agent = A2AAgent(endpoint="http://localhost:8000", client_config=config)

    with patch.object(agent, "get_agent_card", return_value=mock_agent_card):
        with patch("strands.agent.a2a_agent.ClientFactory") as mock_factory_class:
            mock_factory = MagicMock()
            mock_factory.create.return_value = MagicMock()
            mock_factory_class.return_value = mock_factory

            async with agent._get_a2a_client():
                pass

    # Original config should NOT be mutated
    assert config.streaming is False


@pytest.mark.asyncio
async def test_get_a2a_client_config_without_httpx_delegates_to_factory(mock_agent_card):
    """Test that _get_a2a_client delegates to ClientFactory when config has no httpx_client.

    ClientFactory handles creating a default httpx client internally. We just pass
    the config with streaming=True and let the factory do its job.
    """
    config = ClientConfig(polling=True, supported_transports=["jsonrpc"])
    agent = A2AAgent(endpoint="http://localhost:8000", client_config=config, timeout=600)

    with patch.object(agent, "get_agent_card", return_value=mock_agent_card):
        with patch("strands.agent.a2a_agent.ClientFactory") as mock_factory_class:
            mock_factory = MagicMock()
            mock_factory.create.return_value = MagicMock()
            mock_factory_class.return_value = mock_factory

            async with agent._get_a2a_client():
                pass

            # Should pass config directly to ClientFactory — factory handles httpx defaults
            created_config = mock_factory_class.call_args[0][0]
            assert created_config.streaming is True
            assert created_config.polling is True
            assert created_config.supported_transports == ["jsonrpc"]
            assert created_config.httpx_client is None  # factory handles default


@pytest.mark.asyncio
async def test_send_message_uses_provided_factory(mock_agent_card):
    """Test _send_message uses provided factory instead of creating per-call client."""
    external_factory = MagicMock()
    mock_a2a_client = MagicMock()

    async def mock_send_message(*args, **kwargs):
        yield MagicMock()

    mock_a2a_client.send_message = mock_send_message
    external_factory.create.return_value = mock_a2a_client

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        agent = A2AAgent(endpoint="http://localhost:8000", a2a_client_factory=external_factory)

    with patch.object(agent, "get_agent_card", return_value=mock_agent_card):
        # Consume the async iterator
        async for _ in agent._send_message("Hello"):
            pass

        external_factory.create.assert_called_once_with(mock_agent_card)


@pytest.mark.asyncio
async def test_send_message_uses_client_config_httpx_client(mock_agent_card):
    """Test _send_message uses client_config's httpx_client for client creation."""
    mock_auth_client = MagicMock()
    config = ClientConfig(httpx_client=mock_auth_client)

    agent = A2AAgent(endpoint="http://localhost:8000", client_config=config)

    mock_a2a_client = MagicMock()

    async def mock_send(*args, **kwargs):
        yield MagicMock()

    mock_a2a_client.send_message = mock_send

    with patch.object(agent, "get_agent_card", return_value=mock_agent_card):
        with patch("strands.agent.a2a_agent.ClientFactory") as mock_factory_class:
            mock_factory = MagicMock()
            mock_factory.create.return_value = mock_a2a_client
            mock_factory_class.return_value = mock_factory

            async for _ in agent._send_message("Hello"):
                pass

            # Verify ClientFactory was created with config containing the auth client
            mock_factory_class.assert_called_once()
            call_args = mock_factory_class.call_args
            created_config = call_args[0][0]
            assert created_config.httpx_client is mock_auth_client


@pytest.mark.asyncio
async def test_send_message_creates_per_call_client(a2a_agent, mock_agent_card):
    """Test _send_message creates a fresh httpx client for each call when no factory provided."""
    mock_response = Message(
        message_id=uuid4().hex,
        role=Role.agent,
        parts=[Part(TextPart(kind="text", text="Response"))],
    )

    async def mock_send_message(*args, **kwargs):
        yield mock_response

    with patch.object(a2a_agent, "get_agent_card", return_value=mock_agent_card):
        async with mock_a2a_client_context(mock_send_message) as (mock_httpx_class, _):
            # Consume the async iterator
            async for _ in a2a_agent._send_message("Hello"):
                pass

            # Verify httpx client was created with timeout
            mock_httpx_class.assert_called_once_with(timeout=300)


@pytest.mark.asyncio
async def test_get_a2a_client_no_config_creates_managed_httpx():
    """Test that _get_a2a_client creates a managed httpx client when no config provided."""
    mock_card = MagicMock(spec=AgentCard)
    agent = A2AAgent(endpoint="http://localhost:8000", timeout=600)

    with patch.object(agent, "get_agent_card", return_value=mock_card):
        with patch("strands.agent.a2a_agent.httpx.AsyncClient") as mock_httpx_class:
            mock_httpx = AsyncMock()
            mock_httpx.__aenter__.return_value = mock_httpx
            mock_httpx.__aexit__.return_value = None
            mock_httpx_class.return_value = mock_httpx

            with patch("strands.agent.a2a_agent.ClientFactory") as mock_factory_class:
                mock_factory = MagicMock()
                mock_factory.create.return_value = MagicMock()
                mock_factory_class.return_value = mock_factory

                async with agent._get_a2a_client():
                    pass

                # Verify httpx client was created with agent timeout
                mock_httpx_class.assert_called_once_with(timeout=600)
                # Verify ClientFactory was called with streaming=True
                created_config = mock_factory_class.call_args[0][0]
                assert created_config.streaming is True


# === Invoke/Stream Tests ===


@pytest.mark.asyncio
async def test_invoke_async_success(a2a_agent, mock_agent_card):
    """Test successful async invocation."""
    mock_response = Message(
        message_id=uuid4().hex,
        role=Role.agent,
        parts=[Part(TextPart(kind="text", text="Response"))],
    )

    async def mock_send_message(*args, **kwargs):
        yield mock_response

    with patch.object(a2a_agent, "get_agent_card", return_value=mock_agent_card):
        async with mock_a2a_client_context(mock_send_message):
            result = await a2a_agent.invoke_async("Hello")

            assert isinstance(result, AgentResult)
            assert result.message["content"][0]["text"] == "Response"


@pytest.mark.asyncio
async def test_invoke_async_no_prompt(a2a_agent):
    """Test that invoke_async raises ValueError when prompt is None."""
    with pytest.raises(ValueError, match="prompt is required"):
        await a2a_agent.invoke_async(None)


@pytest.mark.asyncio
async def test_invoke_async_no_response(a2a_agent, mock_agent_card):
    """Test that invoke_async raises RuntimeError when no response received."""

    async def mock_send_message(*args, **kwargs):
        return
        yield  # Make it an async generator

    with patch.object(a2a_agent, "get_agent_card", return_value=mock_agent_card):
        async with mock_a2a_client_context(mock_send_message):
            with pytest.raises(RuntimeError, match="No response received"):
                await a2a_agent.invoke_async("Hello")


def test_call_sync(a2a_agent):
    """Test synchronous call method."""
    mock_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "Response"}]},
        metrics=MagicMock(),
        state={},
    )

    with patch("strands.agent.a2a_agent.run_async") as mock_run_async:
        mock_run_async.return_value = mock_result

        result = a2a_agent("Hello")

        assert result == mock_result
        mock_run_async.assert_called_once()


@pytest.mark.asyncio
async def test_stream_async_success(a2a_agent, mock_agent_card):
    """Test successful async streaming."""
    mock_response = Message(
        message_id=uuid4().hex,
        role=Role.agent,
        parts=[Part(TextPart(kind="text", text="Response"))],
    )

    async def mock_send_message(*args, **kwargs):
        yield mock_response

    with patch.object(a2a_agent, "get_agent_card", return_value=mock_agent_card):
        async with mock_a2a_client_context(mock_send_message):
            events = []
            async for event in a2a_agent.stream_async("Hello"):
                events.append(event)

            assert len(events) == 2
            # First event is A2A stream event
            assert events[0]["type"] == "a2a_stream"
            assert events[0]["event"] == mock_response
            # Final event is AgentResult
            assert "result" in events[1]
            assert isinstance(events[1]["result"], AgentResult)
            assert events[1]["result"].message["content"][0]["text"] == "Response"


@pytest.mark.asyncio
async def test_stream_async_no_prompt(a2a_agent):
    """Test that stream_async raises ValueError when prompt is None."""
    with pytest.raises(ValueError, match="prompt is required"):
        async for _ in a2a_agent.stream_async(None):
            pass


# === Complete Event Tests ===


def test_is_complete_event_message(a2a_agent):
    """Test _is_complete_event returns True for Message."""
    mock_message = MagicMock(spec=Message)

    assert a2a_agent._is_complete_event(mock_message) is True


def test_is_complete_event_tuple_with_none_update(a2a_agent):
    """Test _is_complete_event returns True for tuple with None update event."""
    mock_task = MagicMock()

    assert a2a_agent._is_complete_event((mock_task, None)) is True


def test_is_complete_event_artifact_last_chunk(a2a_agent):
    """Test _is_complete_event handles TaskArtifactUpdateEvent last_chunk flag."""
    from a2a.types import TaskArtifactUpdateEvent

    mock_task = MagicMock()

    # last_chunk=True -> complete
    event_complete = MagicMock(spec=TaskArtifactUpdateEvent)
    event_complete.last_chunk = True
    assert a2a_agent._is_complete_event((mock_task, event_complete)) is True

    # last_chunk=False -> not complete
    event_incomplete = MagicMock(spec=TaskArtifactUpdateEvent)
    event_incomplete.last_chunk = False
    assert a2a_agent._is_complete_event((mock_task, event_incomplete)) is False

    # last_chunk=None -> not complete
    event_none = MagicMock(spec=TaskArtifactUpdateEvent)
    event_none.last_chunk = None
    assert a2a_agent._is_complete_event((mock_task, event_none)) is False


def test_is_complete_event_status_update(a2a_agent):
    """Test _is_complete_event handles TaskStatusUpdateEvent state."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    mock_task = MagicMock()

    # completed state -> complete
    event_completed = MagicMock(spec=TaskStatusUpdateEvent)
    event_completed.status = MagicMock()
    event_completed.status.state = TaskState.completed
    assert a2a_agent._is_complete_event((mock_task, event_completed)) is True

    # working state -> not complete
    event_working = MagicMock(spec=TaskStatusUpdateEvent)
    event_working.status = MagicMock()
    event_working.status.state = TaskState.working
    assert a2a_agent._is_complete_event((mock_task, event_working)) is False

    # no status -> not complete
    event_no_status = MagicMock(spec=TaskStatusUpdateEvent)
    event_no_status.status = None
    assert a2a_agent._is_complete_event((mock_task, event_no_status)) is False


def test_is_complete_event_unknown_type(a2a_agent):
    """Test _is_complete_event returns False for unknown event types."""
    assert a2a_agent._is_complete_event("unknown") is False


@pytest.mark.asyncio
async def test_stream_async_tracks_complete_events(a2a_agent, mock_agent_card):
    """Test stream_async uses last complete event for final result."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    mock_task = MagicMock()
    mock_task.artifacts = None

    # First event: incomplete
    incomplete_event = MagicMock(spec=TaskStatusUpdateEvent)
    incomplete_event.status = MagicMock()
    incomplete_event.status.state = TaskState.working
    incomplete_event.status.message = None

    # Second event: complete
    complete_event = MagicMock(spec=TaskStatusUpdateEvent)
    complete_event.status = MagicMock()
    complete_event.status.state = TaskState.completed
    complete_event.status.message = MagicMock()
    complete_event.status.message.parts = []

    async def mock_send_message(*args, **kwargs):
        yield (mock_task, incomplete_event)
        yield (mock_task, complete_event)

    with patch.object(a2a_agent, "get_agent_card", return_value=mock_agent_card):
        async with mock_a2a_client_context(mock_send_message):
            events = []
            async for event in a2a_agent.stream_async("Hello"):
                events.append(event)

            # Should have 2 stream events + 1 result event
            assert len(events) == 3
            assert "result" in events[2]


@pytest.mark.asyncio
async def test_stream_async_falls_back_to_last_event(a2a_agent, mock_agent_card):
    """Test stream_async falls back to last event when no complete event."""
    from a2a.types import TaskState, TaskStatusUpdateEvent

    mock_task = MagicMock()
    mock_task.artifacts = None

    incomplete_event = MagicMock(spec=TaskStatusUpdateEvent)
    incomplete_event.status = MagicMock()
    incomplete_event.status.state = TaskState.working
    incomplete_event.status.message = None

    async def mock_send_message(*args, **kwargs):
        yield (mock_task, incomplete_event)

    with patch.object(a2a_agent, "get_agent_card", return_value=mock_agent_card):
        async with mock_a2a_client_context(mock_send_message):
            events = []
            async for event in a2a_agent.stream_async("Hello"):
                events.append(event)

            # Should have 1 stream event + 1 result event (falls back to last)
            assert len(events) == 2
            assert "result" in events[1]


# =========================================================================
# NEW TESTS: Client-side lifecycle state handling
# =========================================================================


def test_is_complete_event_failed_state(a2a_agent):
    """Test that failed state is recognized as complete."""
    from unittest.mock import MagicMock

    from a2a.types import TaskState, TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = TaskState.failed
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is True


def test_is_complete_event_canceled_state(a2a_agent):
    """Test that canceled state is recognized as complete."""
    from unittest.mock import MagicMock

    from a2a.types import TaskState, TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = TaskState.canceled
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is True


def test_is_complete_event_rejected_state(a2a_agent):
    """Test that rejected state is recognized as complete."""
    from unittest.mock import MagicMock

    from a2a.types import TaskState, TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = TaskState.rejected
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is True


def test_is_complete_event_input_required_state(a2a_agent):
    """Test that input_required state is recognized as complete (pausing)."""
    from unittest.mock import MagicMock

    from a2a.types import TaskState, TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = TaskState.input_required
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is True


def test_is_complete_event_auth_required_state(a2a_agent):
    """Test that auth_required state is recognized as complete (pausing)."""
    from unittest.mock import MagicMock

    from a2a.types import TaskState, TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = TaskState.auth_required
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is True


def test_is_complete_event_working_state_not_complete(a2a_agent):
    """Test that working state is NOT recognized as complete."""
    from unittest.mock import MagicMock

    from a2a.types import TaskState, TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = TaskState.working
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is False


def test_is_complete_event_submitted_state_not_complete(a2a_agent):
    """Test that submitted state is NOT recognized as complete."""
    from unittest.mock import MagicMock

    from a2a.types import TaskState, TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = TaskState.submitted
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is False


# =========================================================================
# DEVIL'S ADVOCATE FINDINGS — Tests addressing review gaps
# =========================================================================


@pytest.mark.parametrize(
    "state,expected_complete",
    [
        (TaskState.completed, True),
        (TaskState.failed, True),
        (TaskState.canceled, True),
        (TaskState.rejected, True),
        (TaskState.input_required, True),
        (TaskState.auth_required, True),
        (TaskState.working, False),
        (TaskState.submitted, False),
        (TaskState.unknown, False),
    ],
    ids=[
        "completed-is-complete",
        "failed-is-complete",
        "canceled-is-complete",
        "rejected-is-complete",
        "input_required-is-complete",
        "auth_required-is-complete",
        "working-not-complete",
        "submitted-not-complete",
        "unknown-not-complete",
    ],
)
def test_is_complete_event_all_states_parametrized(a2a_agent, state, expected_complete):
    """Minor Finding 7: Parametrized test covering ALL TaskState values.

    This replaces verbose individual tests with a single parameterized test that
    covers all 9 TaskState values. When a2a-sdk adds new states, adding a row here
    is trivial.
    """
    from unittest.mock import MagicMock

    from a2a.types import TaskStatusUpdateEvent

    task = MagicMock()
    status = MagicMock()
    status.state = state
    update_event = MagicMock(spec=TaskStatusUpdateEvent)
    update_event.status = status

    assert a2a_agent._is_complete_event((task, update_event)) is expected_complete
