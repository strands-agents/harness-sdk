import pytest

from strands import Agent
from strands.hooks import BeforeNodeCallEvent, HookProvider
from strands.multiagent import GraphBuilder, Swarm
from strands.multiagent.base import Status
from strands.types._events import MultiAgentNodeCancelEvent


@pytest.fixture
def cancel_hook():
    class Hook(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(BeforeNodeCallEvent, self.cancel)

        def cancel(self, event):
            if event.node_id == "weather":
                event.cancel_node = "test cancel"

    return Hook()


@pytest.fixture
def info_agent():
    return Agent(name="info")


@pytest.fixture
def weather_agent():
    return Agent(name="weather")


@pytest.fixture
def swarm(cancel_hook, info_agent, weather_agent):
    return Swarm([info_agent, weather_agent], hooks=[cancel_hook])


@pytest.fixture
def graph(cancel_hook, info_agent, weather_agent):
    builder = GraphBuilder()
    builder.add_node(info_agent, "info")
    builder.add_node(weather_agent, "weather")
    builder.add_edge("info", "weather")
    builder.set_entry_point("info")
    builder.set_hook_providers([cancel_hook])

    return builder.build()


@pytest.mark.asyncio
async def test_swarm_cancel_node(swarm):
    tru_cancel_event = None
    async for event in swarm.stream_async("What is the weather"):
        if event.get("type") == "multiagent_node_cancel":
            tru_cancel_event = event

    multiagent_result = event["result"]

    exp_cancel_event = MultiAgentNodeCancelEvent(node_id="weather", message="test cancel")
    assert tru_cancel_event == exp_cancel_event

    tru_status = multiagent_result.status
    exp_status = Status.FAILED
    assert tru_status == exp_status

    assert len(multiagent_result.node_history) == 1
    tru_node_id = multiagent_result.node_history[0].node_id
    exp_node_id = "info"
    assert tru_node_id == exp_node_id


@pytest.mark.asyncio
async def test_graph_cancel_node(graph):
    tru_cancel_event = None
    with pytest.raises(RuntimeError, match="test cancel"):
        async for event in graph.stream_async("What is the weather"):
            if event.get("type") == "multiagent_node_cancel":
                tru_cancel_event = event

    exp_cancel_event = MultiAgentNodeCancelEvent(node_id="weather", message="test cancel")
    assert tru_cancel_event == exp_cancel_event

    state = graph.state

    tru_status = state.status
    exp_status = Status.FAILED
    assert tru_status == exp_status
