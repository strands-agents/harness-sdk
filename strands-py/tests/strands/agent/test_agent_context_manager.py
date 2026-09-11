"""Tests for the context_manager parameter on Agent."""

from unittest.mock import MagicMock

import pytest

from strands import Agent, Plugin
from strands.agent.conversation_manager import SlidingWindowConversationManager, SummarizingConversationManager
from strands.vended_plugins.context_offloader import ContextOffloader, InMemoryStorage


@pytest.fixture
def mock_model():
    model = MagicMock()
    model.stateful = False
    model.context_window_limit = 200_000
    return model


class TestContextManagerNone:
    def test_default_preserves_sliding_window(self, mock_model):
        agent = Agent(model=mock_model)
        assert isinstance(agent.conversation_manager, SlidingWindowConversationManager)

    def test_explicit_none_preserves_sliding_window(self, mock_model):
        agent = Agent(model=mock_model, context_manager=None)
        assert isinstance(agent.conversation_manager, SlidingWindowConversationManager)

    def test_no_offloader_plugin_by_default(self, mock_model):
        agent = Agent(model=mock_model)
        assert "context_offloader" not in agent._plugin_registry._plugins


class TestContextManagerAuto:
    def test_uses_summarizing_conversation_manager(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert isinstance(agent.conversation_manager, SummarizingConversationManager)

    def test_summary_ratio_is_benchmark_default(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert agent.conversation_manager.summary_ratio == 0.3

    def test_proactive_compression_at_85_percent(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert agent.conversation_manager._compression_threshold == 0.85

    def test_adds_context_offloader_plugin(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert "context_offloader" in agent._plugin_registry._plugins

    def test_offloader_max_result_tokens(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        offloader = agent._plugin_registry._plugins["context_offloader"]
        assert offloader._max_result_tokens == 1500

    def test_offloader_preview_tokens(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        offloader = agent._plugin_registry._plugins["context_offloader"]
        assert offloader._preview_tokens == 750

    def test_offloader_uses_in_memory_storage(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        offloader = agent._plugin_registry._plugins["context_offloader"]
        assert isinstance(offloader._storage, InMemoryStorage)


class TestContextManagerCoexistence:
    def test_user_conversation_manager_is_respected(self, mock_model):
        user_conversation_manager = SlidingWindowConversationManager(window_size=20)
        agent = Agent(model=mock_model, context_manager="auto", conversation_manager=user_conversation_manager)
        assert agent.conversation_manager is user_conversation_manager

    def test_offloader_still_added_with_user_conversation_manager(self, mock_model):
        user_conversation_manager = SlidingWindowConversationManager(window_size=20)
        agent = Agent(model=mock_model, context_manager="auto", conversation_manager=user_conversation_manager)
        assert "context_offloader" in agent._plugin_registry._plugins

    def test_user_offloader_not_overridden(self, mock_model):
        user_offloader = ContextOffloader(storage=MagicMock(), max_result_tokens=3000, preview_tokens=1000)
        agent = Agent(model=mock_model, context_manager="auto", plugins=[user_offloader])
        assert agent._plugin_registry._plugins["context_offloader"]._max_result_tokens == 3000

    def test_user_plugins_preserved(self, mock_model):
        class MyPlugin(Plugin):
            name = "my_plugin"

        plugin = MyPlugin()
        agent = Agent(model=mock_model, context_manager="auto", plugins=[plugin])
        assert "my_plugin" in agent._plugin_registry._plugins
        assert "context_offloader" in agent._plugin_registry._plugins


class TestContextManagerErrors:
    def test_raises_with_stateful_model(self):
        stateful_model = MagicMock()
        stateful_model.stateful = True
        with pytest.raises(ValueError, match="stateful model"):
            Agent(model=stateful_model, context_manager="auto")

    def test_raises_with_unsupported_value(self, mock_model):
        with pytest.raises(ValueError, match="Unsupported context_manager value"):
            Agent(model=mock_model, context_manager="manual")


class TestContextManagerProperty:
    """Tests for the Agent.context_manager property."""

    def test_returns_none_when_no_context_manager(self, mock_model):
        agent = Agent(model=mock_model)
        assert agent.context_manager is None

    def test_returns_context_manager_instance(self, mock_model):
        from strands._context_manager.context_manager import ContextManager

        context_manager = ContextManager()
        agent = Agent(model=mock_model, context_manager=context_manager)
        assert agent.context_manager is context_manager

    def test_returns_none_for_auto_mode(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert agent.context_manager is None

    def test_rejects_context_manager_passed_via_plugins(self, mock_model):
        from strands._context_manager.context_manager import ContextManager

        context_manager = ContextManager()
        with pytest.raises(ValueError, match="passed via plugins"):
            Agent(model=mock_model, plugins=[context_manager])
