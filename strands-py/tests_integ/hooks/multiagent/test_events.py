import pytest

from strands import Agent
from strands.hooks import (
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BeforeMultiAgentInvocationEvent,
    BeforeNodeCallEvent,
    HookProvider,
    MultiAgentInitializedEvent,
)
from strands.multiagent import GraphBuilder, Swarm


@pytest.fixture
def callback_names():
    return []


@pytest.fixture
def hook_provider(callback_names):
    class TestHook(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(AfterMultiAgentInvocationEvent, self.after_multi_agent_invocation)
            registry.add_callback(AfterMultiAgentInvocationEvent, self.after_multi_agent_invocation_async)
            registry.add_callback(AfterNodeCallEvent, self.after_node_call)
            registry.add_callback(AfterNodeCallEvent, self.after_node_call_async)
            registry.add_callback(BeforeMultiAgentInvocationEvent, self.before_multi_agent_invocation)
            registry.add_callback(BeforeMultiAgentInvocationEvent, self.before_multi_agent_invocation_async)
            registry.add_callback(BeforeNodeCallEvent, self.before_node_call)
            registry.add_callback(BeforeNodeCallEvent, self.before_node_call_async)
            registry.add_callback(MultiAgentInitializedEvent, self.multi_agent_initialized_event)
            registry.add_callback(MultiAgentInitializedEvent, self.multi_agent_initialized_event_async)

        def after_multi_agent_invocation(self, _event):
            callback_names.append("after_multi_agent_invocation")

        async def after_multi_agent_invocation_async(self, _event):
            callback_names.append("after_multi_agent_invocation_async")

        def after_node_call(self, _event):
            callback_names.append("after_node_call")

        async def after_node_call_async(self, _event):
            callback_names.append("after_node_call_async")

        def before_multi_agent_invocation(self, _event):
            callback_names.append("before_multi_agent_invocation")

        async def before_multi_agent_invocation_async(self, _event):
            callback_names.append("before_multi_agent_invocation_async")

        def before_node_call(self, _event):
            callback_names.append("before_node_call")

        async def before_node_call_async(self, _event):
            callback_names.append("before_node_call_async")

        def multi_agent_initialized_event(self, _event):
            callback_names.append("multi_agent_initialized_event")

        async def multi_agent_initialized_event_async(self, _event):
            callback_names.append("multi_agent_initialized_event_async")

    return TestHook()


@pytest.fixture
def agent():
    return Agent()


@pytest.fixture
def graph(agent, hook_provider):
    builder = GraphBuilder()
    builder.add_node(agent, "agent")
    builder.set_entry_point("agent")
    builder.set_hook_providers([hook_provider])
    return builder.build()


@pytest.fixture
def swarm(agent, hook_provider):
    return Swarm([agent], hooks=[hook_provider])


def test_graph_events(graph, callback_names):
    graph("Hello")

    tru_callback_names = callback_names
    exp_callback_names = [
        "multi_agent_initialized_event",
        "multi_agent_initialized_event_async",
        "before_multi_agent_invocation",
        "before_multi_agent_invocation_async",
        "before_node_call",
        "before_node_call_async",
        "after_node_call_async",
        "after_node_call",
        "after_multi_agent_invocation_async",
        "after_multi_agent_invocation",
    ]
    assert tru_callback_names == exp_callback_names


def test_swarm_events(swarm, callback_names):
    swarm("Hello")

    tru_callback_names = callback_names
    exp_callback_names = [
        "multi_agent_initialized_event",
        "multi_agent_initialized_event_async",
        "before_multi_agent_invocation",
        "before_multi_agent_invocation_async",
        "before_node_call",
        "before_node_call_async",
        "after_node_call_async",
        "after_node_call",
        "after_multi_agent_invocation_async",
        "after_multi_agent_invocation",
    ]
    assert tru_callback_names == exp_callback_names
