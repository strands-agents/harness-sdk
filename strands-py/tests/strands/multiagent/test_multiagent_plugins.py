"""Tests for MultiAgentPlugin integration with Swarm and Graph."""

from unittest.mock import MagicMock, patch

import pytest

from strands.hooks import BeforeNodeCallEvent
from strands.hooks.registry import HookProvider
from strands.multiagent import GraphBuilder, Swarm
from strands.multiagent.graph import Graph, GraphNode
from strands.plugins import MultiAgentPlugin, hook

# --- Fixtures ---


@pytest.fixture
def mock_swarm_agent():
    """Create a mock agent suitable for Swarm construction."""
    agent = MagicMock()
    agent.name = "agent1"
    agent.description = "Test agent"
    agent.messages = []
    agent.state = MagicMock()
    agent.state.get.return_value = {}
    agent._model_state = {}
    agent._session_manager = None
    agent.tool_registry = MagicMock()
    agent.tool_registry.get_all_tools_config.return_value = {}
    return agent


@pytest.fixture
def mock_graph_agent():
    """Create a mock agent suitable for Graph construction."""
    agent = MagicMock()
    agent.name = "agent1"
    agent.messages = []
    agent.state = MagicMock()
    agent.state.get.return_value = {}
    agent._model_state = {}
    agent._session_manager = None
    return agent


def _make_swarm(agent, **kwargs):
    """Helper to construct a Swarm with tracer patched out."""
    with patch("strands.multiagent.swarm.get_tracer"):
        return Swarm(nodes=[agent], **kwargs)


def _make_graph(agent, **kwargs):
    """Helper to construct a Graph with tracer patched out."""
    with patch("strands.multiagent.graph.get_tracer"):
        node = GraphNode(node_id="agent1", executor=agent)
        return Graph(nodes={"agent1": node}, edges=set(), entry_points={node}, **kwargs)


# --- Swarm plugin integration tests ---


def test_swarm_accepts_plugins_parameter(mock_swarm_agent):
    """Test that Swarm constructor accepts a plugins parameter."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    swarm = _make_swarm(mock_swarm_agent, plugins=[MyPlugin()])
    assert swarm._plugin_registry is not None


def test_swarm_initializes_plugins(mock_swarm_agent):
    """Test that Swarm calls init_multi_agent on plugins during construction."""
    init_called = False

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        def init_multi_agent(self, orchestrator):
            nonlocal init_called
            init_called = True

    _make_swarm(mock_swarm_agent, plugins=[MyPlugin()])
    assert init_called


def test_swarm_registers_plugin_hooks(mock_swarm_agent):
    """Test that Swarm registers plugin hooks with its hook registry."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    swarm = _make_swarm(mock_swarm_agent, plugins=[MyPlugin()])
    assert len(swarm.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_swarm_plugins_coexist_with_hooks(mock_swarm_agent):
    """Test that plugins and legacy hooks parameter work together."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    class MyHookProvider(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(BeforeNodeCallEvent, self.on_before_node)

        def on_before_node(self, event):
            pass

    swarm = _make_swarm(mock_swarm_agent, plugins=[MyPlugin()], hooks=[MyHookProvider()])
    assert len(swarm.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 2


def test_swarm_duplicate_plugin_raises_error(mock_swarm_agent):
    """Test that duplicate plugin names raise an error in Swarm."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    with pytest.raises(ValueError, match="plugin already registered"):
        _make_swarm(mock_swarm_agent, plugins=[MyPlugin(), MyPlugin()])


def test_swarm_no_plugins_parameter(mock_swarm_agent):
    """Test that Swarm works without plugins parameter (backward compat)."""
    swarm = _make_swarm(mock_swarm_agent)
    assert swarm._plugin_registry is not None


# --- Graph plugin integration tests ---


def test_graph_builder_accepts_plugins():
    """Test that GraphBuilder has a set_plugins method."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    builder = GraphBuilder()
    result = builder.set_plugins([MyPlugin()])
    assert result is builder


def test_graph_accepts_plugins_parameter(mock_graph_agent):
    """Test that Graph constructor accepts a plugins parameter."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

    graph = _make_graph(mock_graph_agent, plugins=[MyPlugin()])
    assert graph._plugin_registry is not None


def test_graph_initializes_plugins(mock_graph_agent):
    """Test that Graph calls init_multi_agent on plugins during construction."""
    init_called = False

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        def init_multi_agent(self, orchestrator):
            nonlocal init_called
            init_called = True

    _make_graph(mock_graph_agent, plugins=[MyPlugin()])
    assert init_called


def test_graph_registers_plugin_hooks(mock_graph_agent):
    """Test that Graph registers plugin hooks with its hook registry."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    graph = _make_graph(mock_graph_agent, plugins=[MyPlugin()])
    assert len(graph.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_graph_plugins_coexist_with_hooks(mock_graph_agent):
    """Test that plugins and legacy hooks parameter work together in Graph."""

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        @hook
        def on_before_node(self, event: BeforeNodeCallEvent):
            pass

    class MyHookProvider(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(BeforeNodeCallEvent, self.on_before_node)

        def on_before_node(self, event):
            pass

    graph = _make_graph(mock_graph_agent, plugins=[MyPlugin()], hooks=[MyHookProvider()])
    assert len(graph.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 2


def test_graph_builder_passes_plugins_to_graph(mock_graph_agent):
    """Test that GraphBuilder.build() passes plugins to the Graph constructor."""
    init_called = False

    class MyPlugin(MultiAgentPlugin):
        name = "my-plugin"

        def init_multi_agent(self, orchestrator):
            nonlocal init_called
            init_called = True

    with patch("strands.multiagent.graph.get_tracer"):
        builder = GraphBuilder()
        builder.add_node(mock_graph_agent, node_id="agent1")
        builder.set_entry_point("agent1")
        builder.set_plugins([MyPlugin()])
        graph = builder.build()

    assert init_called
    assert graph._plugin_registry is not None


# --- add_hook method tests ---


def test_swarm_add_hook_registers_callback(mock_swarm_agent):
    """Test that Swarm.add_hook registers a callback directly."""
    events_received = []

    def on_before_node(event: BeforeNodeCallEvent):
        events_received.append(event)

    swarm = _make_swarm(mock_swarm_agent)
    swarm.add_hook(on_before_node, BeforeNodeCallEvent)

    assert len(swarm.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_graph_add_hook_registers_callback(mock_graph_agent):
    """Test that Graph.add_hook registers a callback directly."""
    events_received = []

    def on_before_node(event: BeforeNodeCallEvent):
        events_received.append(event)

    graph = _make_graph(mock_graph_agent)
    graph.add_hook(on_before_node, BeforeNodeCallEvent)

    assert len(graph.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_swarm_add_hook_infers_event_type(mock_swarm_agent):
    """Test that Swarm.add_hook can infer event type from type hint."""

    def on_before_node(event: BeforeNodeCallEvent):
        pass

    swarm = _make_swarm(mock_swarm_agent)
    swarm.add_hook(on_before_node)

    assert len(swarm.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1


def test_graph_add_hook_infers_event_type(mock_graph_agent):
    """Test that Graph.add_hook can infer event type from type hint."""

    def on_before_node(event: BeforeNodeCallEvent):
        pass

    graph = _make_graph(mock_graph_agent)
    graph.add_hook(on_before_node)

    assert len(graph.hooks._registered_callbacks.get(BeforeNodeCallEvent, [])) == 1
