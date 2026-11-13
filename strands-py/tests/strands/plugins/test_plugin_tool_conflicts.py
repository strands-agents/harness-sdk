"""Tests for plugin tool registration conflicts."""

import pytest

from strands.plugins import Plugin
from strands.plugins.registry import _PluginRegistry
from strands.tools import tool
from strands.tools.registry import ToolRegistry


class _FakeAgent:
    """Minimal agent stand-in exposing the attributes _PluginRegistry uses."""

    def __init__(self) -> None:
        self.tool_registry = ToolRegistry()

    def add_hook(self, *args, **kwargs) -> None:
        pass


class _PingPlugin(Plugin):
    """Plugin exposing a single tool named 'ping'."""

    def __init__(self, name: str) -> None:
        self._name = name
        super().__init__()

    @property
    def name(self) -> str:
        return self._name

    @tool
    def ping(self) -> str:
        """Ping.

        Returns:
            The plugin name.
        """
        return self._name


def test_second_plugin_with_same_tool_name_raises():
    """A second plugin exposing the same tool name must not silently replace the first."""
    agent = _FakeAgent()
    registry = _PluginRegistry(agent)

    registry.add_and_init(_PingPlugin("a"))

    with pytest.raises(ValueError, match="tool_name=<ping>"):
        registry.add_and_init(_PingPlugin("b"))

    # The first plugin's tool is the one that stays registered.
    assert agent.tool_registry.registry["ping"].tool_name == "ping"


def test_plugin_tool_conflicting_with_existing_agent_tool_raises():
    """A plugin tool that collides with an already registered tool is rejected."""
    agent = _FakeAgent()
    registry = _PluginRegistry(agent)

    agent.tool_registry.register_tool(_PingPlugin("a").ping)

    with pytest.raises(ValueError, match="tool_name=<ping>"):
        registry.add_and_init(_PingPlugin("b"))


def test_same_plugin_reregistering_its_tool_is_allowed():
    """Re-registering a plugin's own tool is allowed (hot reload path)."""
    agent = _FakeAgent()
    registry = _PluginRegistry(agent)
    plugin = _PingPlugin("a")

    registry.add_and_init(plugin)
    registry._register_tools(plugin)

    assert agent.tool_registry.registry["ping"].tool_name == "ping"
