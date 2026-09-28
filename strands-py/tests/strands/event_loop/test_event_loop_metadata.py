"""Tests for metadata population on assistant messages in the event loop."""

import threading
import unittest.mock

import pytest

import strands
import strands._middleware
import strands.event_loop.event_loop
from strands import Agent
from strands.event_loop._retry import ModelRetryStrategy
from strands.hooks import HookRegistry
from strands.interrupt import _InterruptState
from strands.telemetry.metrics import EventLoopMetrics
from strands.tools.executors import SequentialToolExecutor
from strands.tools.registry import ToolRegistry


@pytest.fixture
def model():
    return unittest.mock.Mock()


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "Hello"}]}]


@pytest.fixture
def hook_registry():
    registry = HookRegistry()
    retry_strategy = ModelRetryStrategy()
    retry_strategy.register_hooks(registry)
    return registry


@pytest.fixture
def tool_registry():
    return ToolRegistry()


@pytest.fixture
def agent(model, messages, tool_registry, hook_registry):
    mock = unittest.mock.Mock(name="agent")
    mock.__class__ = Agent
    mock.config.cache_points = []
    mock.model = model
    mock.system_prompt = "test"
    mock.messages = messages
    mock.tool_registry = tool_registry
    mock.thread_pool = None
    mock.event_loop_metrics = EventLoopMetrics()
    mock.event_loop_metrics.reset_usage_metrics()
    mock.hooks = hook_registry
    mock.tool_executor = SequentialToolExecutor()
    mock._interrupt_state = _InterruptState()
    mock._cancel_signal = threading.Event()
    mock._observe_cancellation = mock._cancel_signal.is_set
    mock._model_state = {}
    mock._system_prompt_content = None
    mock._middleware_registry = strands._middleware.MiddlewareRegistry()
    mock.trace_attributes = {}
    mock.retry_strategy = ModelRetryStrategy()
    # Bind the real _append_messages chokepoint so appends assign tracking ids
    # and fire MessageAddedEvent exactly as production does.
    mock._append_messages = Agent._append_messages.__get__(mock, Agent)
    return mock


@pytest.mark.asyncio
async def test_metadata_populated_on_assistant_message(agent, model, agenerator, alist):
    """After a model response, the assistant message should have metadata with usage and metrics."""
    model.stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "response"}}},
            {"contentBlockStop": {}},
            {
                "metadata": {
                    "usage": {"inputTokens": 42, "outputTokens": 10, "totalTokens": 52},
                    "metrics": {"latencyMs": 200},
                }
            },
        ]
    )

    stream = strands.event_loop.event_loop.event_loop_cycle(agent=agent, invocation_state={})
    await alist(stream)

    # The assistant message should be in agent.messages
    assistant_msg = agent.messages[-1]
    assert assistant_msg["role"] == "assistant"
    assert "metadata" in assistant_msg

    meta = assistant_msg["metadata"]
    assert meta["usage"]["inputTokens"] == 42
    assert meta["usage"]["outputTokens"] == 10
    assert meta["usage"]["totalTokens"] == 52
    assert meta["metrics"]["latencyMs"] == 200


@pytest.mark.asyncio
async def test_metadata_has_default_usage_when_no_metadata_event(agent, model, agenerator, alist):
    """When no metadata event is in the stream, metadata should still be set with defaults."""
    model.stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "response"}}},
            {"contentBlockStop": {}},
        ]
    )

    stream = strands.event_loop.event_loop.event_loop_cycle(agent=agent, invocation_state={})
    await alist(stream)

    assistant_msg = agent.messages[-1]
    assert "metadata" in assistant_msg
    assert assistant_msg["metadata"]["usage"]["inputTokens"] == 0
    assert assistant_msg["metadata"]["usage"]["outputTokens"] == 0
    assert assistant_msg["metadata"]["metrics"]["latencyMs"] == 0


@pytest.mark.asyncio
async def test_metadata_stripped_before_model_call(agent, model, agenerator, alist):
    """Metadata from previous messages should be stripped before sending to the model."""
    # Pre-populate a message with metadata (simulating a previous turn)
    agent.messages.append(
        {
            "role": "assistant",
            "content": [{"text": "previous response"}],
            "metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}},
        }
    )
    agent.messages.append({"role": "user", "content": [{"text": "follow up"}]})

    model.stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "response"}}},
            {"contentBlockStop": {}},
        ]
    )

    stream = strands.event_loop.event_loop.event_loop_cycle(agent=agent, invocation_state={})
    await alist(stream)

    # Verify that messages passed to model.stream() have no metadata key
    call_args = model.stream.call_args
    messages_sent = call_args[0][0]
    for msg in messages_sent:
        assert "metadata" not in msg, f"metadata leaked to model: {msg}"
