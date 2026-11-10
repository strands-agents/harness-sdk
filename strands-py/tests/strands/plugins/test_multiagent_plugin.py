"""Tests for the MultiAgentPlugin base class and registry."""

import gc
import unittest.mock

import pytest

from strands.hooks import AfterNodeCallEvent, BeforeNodeCallEvent, HookRegistry
from strands.plugins import Plugin, hook
from strands.plugins.multiagent_plugin import MultiAgentPlugin
from strands.plugins.multiagent_registry import _MultiAgentPluginRegistry
from strands.plugins.registry import _PluginRegistry

# --- Fixtures ---


@pytest.fixture
def mock_orchestrator():
    """Create a mock orchestrator with a working hook registry."""
    orch = unittest.mock.MagicMock()
    orch.hooks = HookRegistry()
    orch.add_hook = unittest.mock.Mock(
        side_effect=lambda callback, event_type=None: orch.hooks.add_callback(event_type, callback)
    )
    return orch


@pytest.fixture
def registry(mock_orchestrator):
    """Create a _MultiAgentPluginRegistry backed by the mock orchestrator."""
    return _MultiAgentPluginRegistry(mock_orchestrator)


@pytest.fixture
def mock_agent():
    """Create a mock agent with a working hook registry for dual-plugin tests."""
    agent = unittest.mock.MagicMock()
    agent.hooks = HookRegistry()
    agent.add_hook = unittest.mock.Mock(
        side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback)
    )
    agent.tool_registry = unittest.mock.MagicMock()
    return agent


# --- MultiAgentPlugin base class tests ---


def test_multiagent_plugin_is_class_not_protocol():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    assert isinstance(MyPlugin(), MultiAgentPlugin)


def test_multiagent_plugin_requires_name_attribute():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    assert MyPlugin().name == "my-plugin"


def test_multiagent_plugin_name_as_property():
    class MyPlugin(MultiAgentPlugin):
        @property
        def name(self) -> str:
            return "property-plugin"

    assert MyPlugin().name == "property-plugin"


def test_multiagent_plugin_requires_name():
    with pytest.raises(TypeError, match="Can't instantiate abstract class"):

        class PluginWithoutName(MultiAgentPlugin):
            def init_multi_agent(self, orchestrator):
                pass

        PluginWithoutName()


def test_multiagent_plugin_provides_default_init_multi_agent():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    assert MyPlugin().init_multi_agent(unittest.mock.MagicMock()) is None


# --- Auto-discovery tests ---


def test_discovers_hook_decorated_methods():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    plugin = MyPlugin()
    assert len(plugin.hooks) == 1
    assert plugin.hooks[0].__name__ == "on_before_node"


def test_discovers_multiple_hooks():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def hook1(self, event: BeforeNodeCallEvent):
            pass

        @hook
        def hook2(self, event: AfterNodeCallEvent):
            pass

    plugin = MyPlugin()
    assert len(plugin.hooks) == 2
    assert {h.__name__ for h in plugin.hooks} == {"hook1", "hook2"}


def test_hooks_preserve_definition_order():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def z_last(self, event: BeforeNodeCallEvent):
            pass

        @hook
        def a_first(self, event: BeforeNodeCallEvent):
            pass

    plugin = MyPlugin()
    assert [h.__name__ for h in plugin.hooks] == ["z_last", "a_first"]


def test_ignores_non_decorated_methods():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        def regular_method(self):
            pass

        @hook
        def decorated_hook(self, event: BeforeNodeCallEvent):
            pass

    plugin = MyPlugin()
    assert len(plugin.hooks) == 1
    assert plugin.hooks[0].__name__ == "decorated_hook"


def test_no_tool_support():
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    assert not hasattr(MyPlugin(), "tools")


# --- Registry tests ---


def test_registry_add_and_init_calls_init_multi_agent(registry):
    class TestPlugin(MultiAgentPlugin):
        name = "test-plugin"

        def __init__(self):
            super().__init__()
            self.initialized = False

        def init_multi_agent(self, orchestrator):
            self.initialized = True

    plugin = TestPlugin()
    registry.add_and_init(plugin)
    assert plugin.initialized


def test_registry_add_duplicate_raises_error(registry):
    class TestPlugin(MultiAgentPlugin):
        name = "test-plugin"

    registry.add_and_init(TestPlugin())
    with pytest.raises(ValueError, match="plugin_name=<test-plugin> | plugin already registered"):
        registry.add_and_init(TestPlugin())


def test_registry_registers_discovered_hooks(mock_orchestrator, registry):
    class TestPlugin(MultiAgentPlugin):
        name = "test-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    registry.add_and_init(TestPlugin())
    assert len(mock_orchestrator.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_registry_registers_multiple_hooks(mock_orchestrator, registry):
    class TestPlugin(MultiAgentPlugin):
        name = "test-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

        @hook
        def on_after_node(self, event: AfterNodeCallEvent):
            pass

    registry.add_and_init(TestPlugin())
    assert len(mock_orchestrator.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1
    assert len(mock_orchestrator.hooks._registered_callbacks.get(AfterNodeCallEvent, [])) == 1


def test_registry_async_init_multi_agent_supported(registry):
    async_init_called = False

    class AsyncPlugin(MultiAgentPlugin):
        name = "async-plugin"

        async def init_multi_agent(self, orchestrator):
            nonlocal async_init_called
            async_init_called = True

    registry.add_and_init(AsyncPlugin())
    assert async_init_called


def test_registry_hooks_are_bound_to_instance(mock_orchestrator, registry):
    class TestPlugin(MultiAgentPlugin):
        name = "test-plugin"

        def __init__(self):
            super().__init__()
            self.events_received = []

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            self.events_received.append(event)

    plugin = TestPlugin()
    registry.add_and_init(plugin)

    mock_event = unittest.mock.MagicMock(spec=BeforeNodeCallEvent)
    mock_orchestrator.hooks._registered_callbacks[BeforeNodeCallEvent][0].callback(mock_event)

    assert plugin.events_received == [mock_event]


def test_registry_raises_reference_error_after_orchestrator_collected():
    orch = unittest.mock.MagicMock()
    orch.hooks = HookRegistry()
    reg = _MultiAgentPluginRegistry(orch)
    del orch
    gc.collect()

    with pytest.raises(ReferenceError, match="Orchestrator has been garbage collected"):
        _ = reg._orchestrator


def test_registry_init_multi_agent_called_before_hook_registration(mock_orchestrator):
    call_order = []

    class TestPlugin(MultiAgentPlugin):
        name = "test-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

        def init_multi_agent(self, orchestrator):
            call_order.append("init")

    original = mock_orchestrator.hooks.add_callback

    def tracking(event_type, callback):
        call_order.append("hook")
        return original(event_type, callback)

    mock_orchestrator.hooks.add_callback = tracking

    registry = _MultiAgentPluginRegistry(mock_orchestrator)
    registry.add_and_init(TestPlugin())

    assert call_order == ["init", "hook"]


# --- Union type tests ---


def test_registers_hook_for_union_types(mock_orchestrator, registry):
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def on_node_events(self, event: BeforeNodeCallEvent | AfterNodeCallEvent):
            pass

    registry.add_and_init(MyPlugin())
    assert len(mock_orchestrator.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1
    assert len(mock_orchestrator.hooks._registered_callbacks.get(AfterNodeCallEvent, [])) == 1


# --- Subclass override tests ---


def test_subclass_can_override_init_multi_agent(mock_orchestrator, registry):
    custom_init_called = False

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

        def init_multi_agent(self, orchestrator):
            nonlocal custom_init_called
            custom_init_called = True

    registry.add_and_init(MyPlugin())
    assert custom_init_called
    assert len(mock_orchestrator.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_subclass_can_add_manual_hooks_in_init(mock_orchestrator, registry):
    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def auto_hook(self, event: BeforeNodeCallEvent):
            pass

        def manual_hook(self, event: AfterNodeCallEvent):
            pass

        def init_multi_agent(self, orchestrator):
            orchestrator.hooks.add_callback(AfterNodeCallEvent, self.manual_hook)

    registry.add_and_init(MyPlugin())
    assert len(mock_orchestrator.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1
    assert len(mock_orchestrator.hooks._registered_callbacks.get(AfterNodeCallEvent, [])) == 1


# --- Inheritance tests ---


def test_child_inherits_parent_hooks():
    class ParentPlugin(MultiAgentPlugin):
        name = "parent-plugin"

        @hook
        def parent_hook(self, event: BeforeNodeCallEvent):
            pass

    class ChildPlugin(ParentPlugin):
        name = "child-plugin"

        @hook
        def child_hook(self, event: AfterNodeCallEvent):
            pass

    plugin = ChildPlugin()
    assert len(plugin.hooks) == 2
    assert {h.__name__ for h in plugin.hooks} == {"parent_hook", "child_hook"}


def test_child_can_override_parent_hook():
    class ParentPlugin(MultiAgentPlugin):
        name = "parent-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    class ChildPlugin(ParentPlugin):
        name = "child-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    assert len(ChildPlugin().hooks) == 1


# --- Dual plugin tests ---


def test_dual_plugin_isinstance_checks():
    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

    plugin = DualPlugin()
    assert isinstance(plugin, Plugin)
    assert isinstance(plugin, MultiAgentPlugin)


def test_dual_plugin_discovers_hooks_once():
    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    assert len(DualPlugin().hooks) == 1


def test_dual_plugin_discover_hooks_called_once(monkeypatch):
    """Verify the hasattr guard prevents discover_hooks from running twice in dual inheritance."""
    import strands.plugins.plugin as plugin_mod

    call_count = 0
    original = plugin_mod.discover_hooks

    def counting_discover_hooks(instance, plugin_name):
        nonlocal call_count
        call_count += 1
        return original(instance, plugin_name)

    monkeypatch.setattr(plugin_mod, "discover_hooks", counting_discover_hooks)

    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    DualPlugin()
    # Plugin.__init__ calls discover_hooks once; MultiAgentPlugin.__init__ skips due to hasattr guard
    assert call_count == 1


def test_dual_plugin_has_both_init_methods(mock_agent, mock_orchestrator):
    agent_init_called = False
    multi_agent_init_called = False

    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

        def init_agent(self, agent):
            nonlocal agent_init_called
            agent_init_called = True

        def init_multi_agent(self, orchestrator):
            nonlocal multi_agent_init_called
            multi_agent_init_called = True

    _PluginRegistry(mock_agent).add_and_init(DualPlugin())
    assert agent_init_called

    _MultiAgentPluginRegistry(mock_orchestrator).add_and_init(DualPlugin())
    assert multi_agent_init_called


def test_dual_plugin_registers_hooks_in_both_contexts(mock_agent, mock_orchestrator):
    from strands.hooks import BeforeModelCallEvent

    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

        @hook
        def on_model_call(self, event: BeforeModelCallEvent):
            pass

        @hook
        def on_node_call(self, event: BeforeNodeCallEvent):
            pass

    _PluginRegistry(mock_agent).add_and_init(DualPlugin())
    assert len(mock_agent.hooks._registered_callbacks.get(BeforeModelCallEvent, [])) == 1
    assert len(mock_agent.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1

    _MultiAgentPluginRegistry(mock_orchestrator).add_and_init(DualPlugin())
    assert len(mock_orchestrator.hooks._registered_callbacks.get(BeforeModelCallEvent, [])) == 1
    assert len(mock_orchestrator.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_dual_plugin_shared_state(mock_agent, mock_orchestrator):
    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

        def __init__(self):
            super().__init__()
            self.call_count = 0

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            self.call_count += 1

        def init_agent(self, agent):
            self.call_count += 10

        def init_multi_agent(self, orchestrator):
            self.call_count += 100

    plugin = DualPlugin()
    _PluginRegistry(mock_agent).add_and_init(plugin)
    assert plugin.call_count == 10

    _MultiAgentPluginRegistry(mock_orchestrator).add_and_init(plugin)
    assert plugin.call_count == 110


def test_dual_plugin_tools_only_for_agent(mock_agent, mock_orchestrator):
    from strands.tools.decorator import tool

    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

        @tool
        def my_tool(self, param: str) -> str:
            """A test tool."""
            return param

    _PluginRegistry(mock_agent).add_and_init(DualPlugin())
    mock_agent.tool_registry.process_tools.assert_called_once()

    # Orchestrator has no tool registration
    _MultiAgentPluginRegistry(mock_orchestrator).add_and_init(DualPlugin())


# --- Double-discovery guard tests ---


def test_dual_plugin_hasattr_guard_prevents_double_discovery():
    """Test that the hasattr guard in __init__ prevents hooks from being discovered twice."""

    class DualPlugin(Plugin, MultiAgentPlugin):
        name = "dual-plugin"

        @hook
        def shared_hook(self, event: BeforeNodeCallEvent):
            pass

    plugin = DualPlugin()
    # If double-discovery occurred, we'd see 2 hooks instead of 1
    assert len(plugin.hooks) == 1
    assert plugin.hooks[0].__name__ == "shared_hook"


def test_multiagent_plugin_hasattr_guard_with_pre_set_hooks():
    """Test that MultiAgentPlugin.__init__ skips discovery if _hooks already set."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        def __init__(self):
            # Pre-set _hooks before super().__init__
            self._hooks = []
            super().__init__()

        @hook
        def should_not_be_discovered(self, event: BeforeNodeCallEvent):
            pass

    plugin = MyPlugin()
    # The guard should have skipped discovery since _hooks was already set
    assert len(plugin.hooks) == 0
