import os
import subprocess
import time

import httpx
import pytest
from a2a.client import ClientConfig, ClientFactory

from strands import Agent
from strands.agent.a2a_agent import A2AAgent
from strands.multiagent.graph import GraphBuilder, Status


@pytest.fixture
def a2a_server():
    """Start A2A server as subprocess fixture."""
    server_path = os.path.join(os.path.dirname(__file__), "a2a_server.py")
    process = subprocess.Popen(["python", server_path])
    time.sleep(5)  # Wait for A2A server to start

    yield "http://localhost:9000"

    # Cleanup
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def test_a2a_agent_invoke_sync(a2a_server):
    """Test synchronous invocation via __call__."""
    a2a_agent = A2AAgent(endpoint=a2a_server)
    result = a2a_agent("Hello there!")
    assert result.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_a2a_agent_invoke_async(a2a_server):
    """Test async invocation."""
    a2a_agent = A2AAgent(endpoint=a2a_server)
    result = await a2a_agent.invoke_async("Hello there!")
    assert result.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_a2a_agent_stream_async(a2a_server):
    """Test async streaming."""
    a2a_agent = A2AAgent(endpoint=a2a_server)

    events = []
    async for event in a2a_agent.stream_async("Hello there!"):
        events.append(event)

    # Should have at least one A2A stream event and one final result event
    assert len(events) >= 2
    assert events[0]["type"] == "a2a_stream"
    assert "result" in events[-1]
    assert events[-1]["result"].stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_a2a_agent_with_non_streaming_client_config(a2a_server):
    """Test with streaming=False client configuration (non-default)."""
    httpx_client = httpx.AsyncClient(timeout=300)
    config = ClientConfig(httpx_client=httpx_client, streaming=False)
    factory = ClientFactory(config)

    try:
        a2a_agent = A2AAgent(endpoint=a2a_server, a2a_client_factory=factory)
        result = await a2a_agent.invoke_async("Hello there!")
        assert result.stop_reason == "end_turn"
    finally:
        await httpx_client.aclose()


@pytest.mark.asyncio
async def test_graph_with_a2a_agent_and_regular_agent(a2a_server):
    """Test Graph execution with both A2AAgent and regular Agent nodes."""
    # Create A2AAgent pointing to the test server
    a2a_agent = A2AAgent(endpoint=a2a_server, name="remote_agent")

    # Create a regular Agent
    regular_agent = Agent(
        model="us.amazon.nova-lite-v1:0",
        system_prompt="You are a summarizer. Summarize the input briefly.",
        name="summarizer",
    )

    # Build graph with both agent types
    builder = GraphBuilder()
    builder.add_node(a2a_agent, "remote")
    builder.add_node(regular_agent, "summarizer")
    builder.add_edge("remote", "summarizer")
    builder.set_entry_point("remote")
    graph = builder.build()

    # Execute the graph
    result = await graph.invoke_async("Say hello in one sentence")

    assert result.status == Status.COMPLETED
    assert result.completed_nodes == 2
    assert "remote" in result.results
    assert "summarizer" in result.results
