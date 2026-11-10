"""Tests for the plugin system."""

import gc
import unittest.mock

import pytest

from strands import Agent
from strands.hooks import HookRegistry
from strands.plugins import Plugin
from strands.plugins.registry import _PluginRegistry

# Plugin Base Class Tests


def test_plugin_base_class_isinstance_check():
    """Test that Plugin subclass passes isinstance check."""

    class MyPlugin(Plugin):
        name = "my-plugin"

    plugin = MyPlugin()
    assert isinstance(plugin, Plugin)


def test_plugin_base_class_sync_implementation():
    """Test Plugin base class works with synchronous init_agent."""

    class SyncPlugin(Plugin):
        name = "sync-plugin"

        def init_agent(self, agent):
            # No super() needed - registry handles auto-registration
            agent.custom_attribute = "initialized by plugin"

    plugin = SyncPlugin()
    mock_agent = unittest.mock.Mock()
    mock_agent.hooks = HookRegistry()
    mock_agent.tool_registry = unittest.mock.MagicMock()

    # Verify the plugin is an instance
    assert isinstance(plugin, Plugin)
    assert plugin.name == "sync-plugin"

    # Execute init_agent synchronously
    plugin.init_agent(mock_agent)
    assert mock_agent.custom_attribute == "initialized by plugin"


@pytest.mark.asyncio
async def test_plugin_base_class_async_implementation():
    """Test Plugin base class works with asynchronous init_agent."""

    class AsyncPlugin(Plugin):
        name = "async-plugin"

        async def init_agent(self, agent):
            # No super() needed - registry handles auto-registration
            agent.custom_attribute = "initialized by async plugin"

    plugin = AsyncPlugin()
    mock_agent = unittest.mock.Mock()
    mock_agent.hooks = HookRegistry()
    mock_agent.tool_registry = unittest.mock.MagicMock()

    # Verify the plugin is an instance
    assert isinstance(plugin, Plugin)
    assert plugin.name == "async-plugin"

    # Execute init_agent asynchronously
    await plugin.init_agent(mock_agent)
    assert mock_agent.custom_attribute == "initialized by async plugin"


def test_plugin_class_requires_name():
    """Test that Plugin class requires a name property."""

    with pytest.raises(TypeError, match="Can't instantiate abstract class"):

        class PluginWithoutName(Plugin):
            def init_agent(self, agent):
                pass

        PluginWithoutName()


def test_plugin_base_class_requires_init_agent_method():
    """Test that Plugin base class provides default init_agent."""

    class PluginWithoutOverride(Plugin):
        name = "no-override-plugin"

    plugin = PluginWithoutOverride()
    # Plugin base class provides default init_agent
    assert hasattr(plugin, "init_agent")
    assert callable(plugin.init_agent)


def test_plugin_base_class_with_class_attribute_name():
    """Test Plugin base class works when name is a class attribute."""

    class PluginWithClassAttribute(Plugin):
        name: str = "class-attr-plugin"

    plugin = PluginWithClassAttribute()
    assert isinstance(plugin, Plugin)
    assert plugin.name == "class-attr-plugin"


def test_plugin_base_class_with_property_name():
    """Test Plugin base class works when name is a property."""

    class PluginWithProperty(Plugin):
        @property
        def name(self) -> str:
            return "property-plugin"

    plugin = PluginWithProperty()
    assert isinstance(plugin, Plugin)
    assert plugin.name == "property-plugin"


# _PluginRegistry Tests


@pytest.fixture
def mock_agent():
    """Create a mock agent for testing."""
    agent = unittest.mock.Mock()
    agent.hooks = HookRegistry()
    agent.tool_registry = unittest.mock.MagicMock()
    agent.add_hook = unittest.mock.Mock()
    return agent


@pytest.fixture
def registry(mock_agent):
    """Create a fresh _PluginRegistry for each test."""
    return _PluginRegistry(mock_agent)


def test_plugin_registry_add_and_init_calls_init_agent(registry, mock_agent):
    """Test adding a plugin calls its init_agent method."""

    class TestPlugin(Plugin):
        name = "test-plugin"

        def __init__(self):
            super().__init__()
            self.initialized = False

        def init_agent(self, agent):
            # No super() needed - registry handles auto-registration
            self.initialized = True
            agent.plugin_initialized = True

    plugin = TestPlugin()
    registry.add_and_init(plugin)

    assert plugin.initialized
    assert mock_agent.plugin_initialized


def test_plugin_registry_add_duplicate_raises_error(registry, mock_agent):
    """Test that adding a duplicate plugin raises an error."""

    class TestPlugin(Plugin):
        name = "test-plugin"

    plugin1 = TestPlugin()
    plugin2 = TestPlugin()

    registry.add_and_init(plugin1)

    with pytest.raises(ValueError, match="plugin_name=<test-plugin> | plugin already registered"):
        registry.add_and_init(plugin2)


def test_plugin_registry_add_and_init_with_async_plugin(registry, mock_agent):
    """Test that add_and_init handles async plugins using run_async."""

    class AsyncPlugin(Plugin):
        name = "async-plugin"

        def __init__(self):
            super().__init__()
            self.initialized = False

        async def init_agent(self, agent):
            # No super() needed - registry handles auto-registration
            self.initialized = True
            agent.async_plugin_initialized = True

    plugin = AsyncPlugin()
    registry.add_and_init(plugin)

    assert plugin.initialized
    assert mock_agent.async_plugin_initialized


def test_plugin_registry_raises_reference_error_after_agent_collected():
    """Verify _PluginRegistry raises ReferenceError when the Agent has been garbage collected."""
    agent = Agent()
    registry = agent._plugin_registry
    del agent
    gc.collect()

    with pytest.raises(ReferenceError, match="Agent has been garbage collected"):
        _ = registry._agent
