"""Tests for the context_manager parameter on Agent."""

from unittest.mock import MagicMock

import pytest

from strands import Agent, Plugin
from strands._context_manager.context_manager import ContextManager
from strands.agent.conversation_manager import (
    NullConversationManager,
    SlidingWindowConversationManager,
)


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

    def test_no_context_manager_plugin_by_default(self, mock_model):
        agent = Agent(model=mock_model)
        assert "strands:context-manager" not in agent._plugin_registry._plugins


class TestContextManagerAuto:
    def test_uses_null_conversation_manager(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert isinstance(agent.conversation_manager, NullConversationManager)

    def test_registers_context_manager_plugin(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert "strands:context-manager" in agent._plugin_registry._plugins

    def test_context_manager_instance_created(self, mock_model):
        agent = Agent(model=mock_model, context_manager="auto")
        assert agent._context_manager_instance is not None
        assert isinstance(agent._context_manager_instance, ContextManager)


class TestContextManagerCoexistence:
    def test_user_conversation_manager_ignored_with_warning(self, mock_model):
        user_conversation_manager = SlidingWindowConversationManager(window_size=20)
        with pytest.warns(UserWarning, match="context_manager is set, ignoring co-provided conversation_manager"):
            agent = Agent(model=mock_model, context_manager="auto", conversation_manager=user_conversation_manager)
        assert isinstance(agent.conversation_manager, NullConversationManager)

    def test_user_plugins_preserved(self, mock_model):
        class MyPlugin(Plugin):
            name = "my_plugin"

        plugin = MyPlugin()
        agent = Agent(model=mock_model, context_manager="auto", plugins=[plugin])
        assert "my_plugin" in agent._plugin_registry._plugins
        assert "strands:context-manager" in agent._plugin_registry._plugins


class TestContextManagerFalse:
    def test_false_disables_context_management(self, mock_model):
        agent = Agent(model=mock_model, context_manager=False)
        assert isinstance(agent.conversation_manager, NullConversationManager)
        assert "strands:context-manager" not in agent._plugin_registry._plugins

    def test_false_with_user_conversation_manager(self, mock_model):
        user_cm = SlidingWindowConversationManager(window_size=20)
        agent = Agent(model=mock_model, context_manager=False, conversation_manager=user_cm)
        assert agent.conversation_manager is user_cm


class TestContextManagerErrors:
    def test_raises_with_stateful_model(self):
        stateful_model = MagicMock()
        stateful_model.stateful = True
        with pytest.raises(ValueError, match="stateful model"):
            Agent(model=stateful_model, context_manager="auto")

    def test_raises_with_unsupported_value(self, mock_model):
        with pytest.raises(ValueError, match="Unknown context_manager preset"):
            Agent(model=mock_model, context_manager="manual")
