"""Tests for agent-level default storage."""

import logging
from unittest.mock import MagicMock

import pytest

from strands import Agent
from strands.session.repository_session_manager import RepositorySessionManager
from strands.session.snapshot_session_manager import SnapshotSessionManager
from strands.storage.in_memory_storage import InMemoryStorage as UnifiedInMemoryStorage
from strands.storage.storage import _NAMESPACED, _NamespacedStorage
from strands.vended_plugins.context_offloader import ContextOffloader
from strands.vended_plugins.context_offloader.storage import InMemoryStorage as OffloaderInMemoryStorage
from tests.fixtures.mocked_model_provider import MockedModelProvider

SIMPLE_RESPONSE = [{"role": "assistant", "content": [{"text": "ok"}]}]


@pytest.fixture
def mock_agent_for_session():
    """Return a mock agent suitable for SnapshotSessionManager.initialize."""

    def _make(storage=None):
        agent = MagicMock()
        agent.storage = storage
        agent.agent_id = "agent-1"
        agent.messages = []
        agent.model = MagicMock()
        agent.model.stateful = False
        agent.take_snapshot = MagicMock(return_value=MagicMock())
        agent.load_snapshot = MagicMock()
        return agent

    return _make


# --- Agent.storage property ---


def test_storage_defaults_to_none():
    agent = Agent(model=MockedModelProvider(SIMPLE_RESPONSE))
    assert agent.storage is None


def test_storage_returns_configured_value():
    storage = MagicMock()
    agent = Agent(model=MockedModelProvider(SIMPLE_RESPONSE), storage=storage)
    assert agent.storage is storage


# --- ContextOffloader resolves agent-level storage ---


def test_offloader_uses_agent_storage_when_no_explicit_storage():
    storage = UnifiedInMemoryStorage()
    offloader = ContextOffloader(include_retrieval_tool=False)
    agent = MagicMock()
    agent.storage = storage

    offloader.init_agent(agent)

    assert offloader._storage is not None
    assert isinstance(offloader._storage, _NamespacedStorage)
    assert offloader._storage._namespaced is _NAMESPACED


def test_offloader_falls_back_to_in_memory_when_no_agent_storage():
    offloader = ContextOffloader(include_retrieval_tool=False)
    agent = MagicMock()
    agent.storage = None

    offloader.init_agent(agent)

    assert offloader._storage is not None
    assert isinstance(offloader._storage, OffloaderInMemoryStorage)


def test_explicit_offloader_storage_overrides_agent_storage():
    agent_storage = UnifiedInMemoryStorage()
    explicit_storage = OffloaderInMemoryStorage()
    offloader = ContextOffloader(storage=explicit_storage, include_retrieval_tool=False)
    agent = MagicMock()
    agent.storage = agent_storage

    offloader.init_agent(agent)

    assert offloader._storage is explicit_storage


def test_explicit_unified_storage_overrides_agent_storage():
    agent_storage = UnifiedInMemoryStorage()
    explicit_storage = UnifiedInMemoryStorage()
    offloader = ContextOffloader(storage=explicit_storage, include_retrieval_tool=False)
    agent = MagicMock()
    agent.storage = agent_storage

    offloader.init_agent(agent)

    assert offloader._storage is not agent_storage
    assert isinstance(offloader._storage, _NamespacedStorage)


def test_offloader_namespaces_agent_storage_under_offloader():
    storage = UnifiedInMemoryStorage()
    offloader = ContextOffloader(include_retrieval_tool=False)
    agent = MagicMock()
    agent.storage = storage

    offloader.init_agent(agent)

    assert isinstance(offloader._storage, _NamespacedStorage)
    assert offloader._storage._prefix == "offloader/"


# --- context_manager="auto" integration ---


def test_auto_context_manager_offloader_resolves_agent_storage():
    storage = UnifiedInMemoryStorage()
    agent = Agent(model=MockedModelProvider(SIMPLE_RESPONSE), storage=storage, context_manager="auto")

    offloader = None
    for plugin in agent._plugin_registry._plugins.values():
        if isinstance(plugin, ContextOffloader):
            offloader = plugin
            break

    assert offloader is not None
    assert isinstance(offloader._storage, _NamespacedStorage)
    assert offloader._storage._prefix == "offloader/"


# --- SnapshotSessionManager resolves agent-level storage ---


def test_session_manager_uses_agent_storage_when_no_explicit_storage(mock_agent_for_session):
    storage = UnifiedInMemoryStorage()
    session_mgr = SnapshotSessionManager("test-session")

    session_mgr.initialize(mock_agent_for_session(storage=storage))

    assert session_mgr._storage is not None
    assert isinstance(session_mgr._storage, _NamespacedStorage)


def test_session_manager_falls_back_to_local_file_when_no_agent_storage(mock_agent_for_session):
    session_mgr = SnapshotSessionManager("test-session")

    session_mgr.initialize(mock_agent_for_session(storage=None))

    assert session_mgr._storage is not None
    assert isinstance(session_mgr._storage, _NamespacedStorage)


def test_explicit_session_storage_overrides_agent_storage(mock_agent_for_session):
    agent_storage = UnifiedInMemoryStorage()
    explicit_storage = UnifiedInMemoryStorage()
    session_mgr = SnapshotSessionManager("test-session", storage=explicit_storage)

    session_mgr.initialize(mock_agent_for_session(storage=agent_storage))

    assert isinstance(session_mgr._storage, _NamespacedStorage)
    assert session_mgr._storage._storage is explicit_storage


# --- Guard path coverage ---


def test_resolved_storage_raises_when_not_initialized():
    session_mgr = SnapshotSessionManager("test-session")

    with pytest.raises(RuntimeError, match="SnapshotSessionManager requires a storage backend"):
        _ = session_mgr._resolved_storage


def test_storage_for_agent_raises_when_not_initialized():
    offloader = ContextOffloader(include_retrieval_tool=False)
    agent = MagicMock()

    with pytest.raises(RuntimeError, match="ContextOffloader storage not initialized"):
        offloader._storage_for_agent(agent)


@pytest.mark.asyncio
async def test_on_before_model_call_returns_early_when_storage_is_none():
    offloader = ContextOffloader(include_retrieval_tool=False)
    event = MagicMock()
    event.agent = MagicMock()
    event.agent.event_loop_metrics = MagicMock()
    event.agent.event_loop_metrics.cycle_count = 1

    await offloader._on_before_model_call(event)

    assert offloader._storage is None


# --- RepositorySessionManager warn-once ---


class TestRepositorySessionManagerWarnOnce:
    """Uses setup_method to reset the process-global flag between tests."""

    def setup_method(self):
        RepositorySessionManager._warned_storage_ignored = False

    def test_warns_when_agent_has_storage(self, caplog):
        repository = MagicMock()
        repository.read_session = MagicMock(return_value=None)
        repository.create_session = MagicMock()
        session_mgr = RepositorySessionManager("test-session", session_repository=repository)

        agent = Agent(model=MockedModelProvider(SIMPLE_RESPONSE), agent_id="agent-1", storage=UnifiedInMemoryStorage())

        with caplog.at_level(logging.WARNING):
            session_mgr.initialize(agent)

        assert "agent-level storage is set but RepositorySessionManager does not use it" in caplog.text

    def test_warns_only_once(self, caplog):
        repository = MagicMock()
        repository.read_session = MagicMock(return_value=None)
        repository.create_session = MagicMock()
        session_mgr = RepositorySessionManager("test-session", session_repository=repository)

        agent = Agent(model=MockedModelProvider(SIMPLE_RESPONSE), agent_id="agent-1", storage=UnifiedInMemoryStorage())

        with caplog.at_level(logging.WARNING):
            session_mgr.initialize(agent)

        assert "agent-level storage is set but RepositorySessionManager does not use it" in caplog.text
        caplog.clear()

        session_mgr2 = RepositorySessionManager("test-session-2", session_repository=repository)
        agent2 = Agent(model=MockedModelProvider(SIMPLE_RESPONSE), agent_id="agent-2", storage=UnifiedInMemoryStorage())

        with caplog.at_level(logging.WARNING):
            session_mgr2.initialize(agent2)

        assert "agent-level storage is set but RepositorySessionManager does not use it" not in caplog.text
