"""Tests for _AgentAsTool - the agent-as-tool adapter."""

from unittest.mock import MagicMock

import pytest

from strands.agent._agent_as_tool import _AgentAsTool
from strands.agent.agent_result import AgentResult
from strands.interrupt import Interrupt, _InterruptState
from strands.telemetry.metrics import EventLoopMetrics
from strands.types._events import AgentAsToolStreamEvent, ToolInterruptEvent, ToolResultEvent, ToolStreamEvent


async def _mock_stream_async(result, intermediate_events=None):
    """Helper that yields intermediate events then the final result event."""
    for event in intermediate_events or []:
        yield event
    yield {"result": result}


@pytest.fixture
def mock_agent():
    agent = MagicMock()
    agent.name = "test_agent"
    agent.description = "A test agent"
    agent._interrupt_state = _InterruptState()
    return agent


@pytest.fixture
def fake_agent():
    """A real Agent instance for tests that need Agent-specific features."""
    from strands.agent.agent import Agent

    return Agent(name="fake_agent", callback_handler=None)


@pytest.fixture
def tool(mock_agent):
    return _AgentAsTool(mock_agent, name="test_agent", description="A test agent", preserve_context=True)


@pytest.fixture
def tool_use():
    return {
        "toolUseId": "tool-123",
        "name": "test_agent",
        "input": {"input": "hello"},
    }


@pytest.fixture
def agent_result():
    return AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "response text"}]},
        metrics=EventLoopMetrics(),
        state={},
    )


# --- init ---


def test_init(mock_agent):
    tool = _AgentAsTool(mock_agent, name="my_tool", description="custom desc", preserve_context=True)
    assert tool.tool_name == "my_tool"
    assert tool._description == "custom desc"
    assert tool.agent is mock_agent


def test_init_description_defaults_to_agent_description(fake_agent):
    fake_agent.description = "Agent that researches topics"
    tool = _AgentAsTool(fake_agent, name="researcher", preserve_context=True)
    assert tool._description == "Agent that researches topics"


def test_init_description_defaults_to_generic_when_agent_has_none(fake_agent):
    tool = _AgentAsTool(fake_agent, name="researcher", preserve_context=True)
    assert tool._description == "Use the researcher agent as a tool by providing a natural language input"


def test_init_description_explicit_overrides_agent_description(fake_agent):
    fake_agent.description = "Agent that researches topics"
    tool = _AgentAsTool(fake_agent, name="researcher", description="custom", preserve_context=True)
    assert tool._description == "custom"


def test_init_preserve_context_defaults_false(fake_agent):
    tool = _AgentAsTool(fake_agent, name="t", description="d")
    assert tool._preserve_context is False


def test_init_preserve_context_true(mock_agent):
    tool = _AgentAsTool(mock_agent, name="t", description="d", preserve_context=True)
    assert tool._preserve_context is True


# --- properties ---


def test_tool_properties(tool):
    assert tool.tool_name == "test_agent"
    assert tool.tool_type == "agent"

    spec = tool.tool_spec
    assert spec["name"] == "test_agent"
    assert spec["description"] == "A test agent"

    schema = spec["inputSchema"]["json"]
    assert schema["type"] == "object"
    assert "input" in schema["properties"]
    assert schema["properties"]["input"]["type"] == "string"
    assert schema["required"] == ["input"]

    props = tool.get_display_properties()
    assert props["Agent"] == "test_agent"
    assert props["Type"] == "agent"


# --- stream ---


@pytest.mark.asyncio
async def test_stream_success(tool, mock_agent, tool_use, agent_result):
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)

    events = [event async for event in tool.stream(tool_use, {})]

    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(result_events) == 1
    assert result_events[0]["tool_result"]["status"] == "success"
    assert result_events[0]["tool_result"]["content"][0]["text"] == "response text\n"


@pytest.mark.asyncio
async def test_stream_passes_input_to_agent(tool, mock_agent, tool_use, agent_result):
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)

    async for _ in tool.stream(tool_use, {}):
        pass

    mock_agent.stream_async.assert_called_once_with("hello", cancel_signal=None)


@pytest.mark.asyncio
async def test_stream_empty_input(tool, mock_agent, agent_result):
    empty_tool_use = {
        "toolUseId": "tool-123",
        "name": "test_agent",
        "input": {},
    }
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)

    async for _ in tool.stream(empty_tool_use, {}):
        pass

    mock_agent.stream_async.assert_called_once_with("", cancel_signal=None)


@pytest.mark.asyncio
async def test_stream_string_input(tool, mock_agent, agent_result):
    tool_use = {
        "toolUseId": "tool-123",
        "name": "test_agent",
        "input": "direct string",
    }
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)

    async for _ in tool.stream(tool_use, {}):
        pass

    mock_agent.stream_async.assert_called_once_with("direct string", cancel_signal=None)


@pytest.mark.asyncio
async def test_stream_error(tool, mock_agent, tool_use):
    mock_agent.stream_async.side_effect = RuntimeError("boom")

    events = [event async for event in tool.stream(tool_use, {})]

    assert len(events) == 1
    assert events[0]["tool_result"]["status"] == "error"
    assert "boom" in events[0]["tool_result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_stream_propagates_tool_use_id(tool, mock_agent, tool_use, agent_result):
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)

    events = [event async for event in tool.stream(tool_use, {})]

    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert result_events[0]["tool_result"]["toolUseId"] == "tool-123"


@pytest.mark.asyncio
async def test_stream_forwards_intermediate_events(tool, mock_agent, tool_use, agent_result):
    intermediate = [{"data": "partial"}, {"data": "more"}]
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result, intermediate)

    events = [event async for event in tool.stream(tool_use, {})]

    stream_events = [e for e in events if isinstance(e, AgentAsToolStreamEvent)]
    assert len(stream_events) == 2
    assert stream_events[0]["tool_stream_event"]["data"]["data"] == "partial"
    assert stream_events[1]["tool_stream_event"]["data"]["data"] == "more"
    assert stream_events[0].agent_as_tool is tool
    assert stream_events[0].tool_use_id == "tool-123"


@pytest.mark.asyncio
async def test_stream_events_not_double_wrapped_by_executor(tool, mock_agent, tool_use, agent_result):
    """AgentAsToolStreamEvent is a ToolStreamEvent subclass, so the executor should pass it through directly."""
    intermediate = [{"data": "chunk"}]
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result, intermediate)

    events = [event async for event in tool.stream(tool_use, {})]

    stream_events = [e for e in events if isinstance(e, AgentAsToolStreamEvent)]
    assert len(stream_events) == 1

    event = stream_events[0]
    # It's a ToolStreamEvent (so the executor yields it directly)
    assert isinstance(event, ToolStreamEvent)
    # But it's specifically an AgentAsToolStreamEvent (not re-wrapped)
    assert type(event) is AgentAsToolStreamEvent
    # And it references the originating _AgentAsTool
    assert event.agent_as_tool is tool


@pytest.mark.asyncio
async def test_stream_no_result_yields_error(tool, mock_agent, tool_use):
    async def _empty_stream():
        return
        yield  # noqa: RET504 - make it an async generator

    mock_agent.stream_async.return_value = _empty_stream()

    events = [event async for event in tool.stream(tool_use, {})]

    assert len(events) == 1
    assert events[0]["tool_result"]["status"] == "error"
    assert "did not produce a result" in events[0]["tool_result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_stream_structured_output(tool, mock_agent, tool_use):
    from pydantic import BaseModel

    class MyOutput(BaseModel):
        answer: str

    structured = MyOutput(answer="42")
    result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "ignored"}]},
        metrics=EventLoopMetrics(),
        state={},
        structured_output=structured,
    )
    mock_agent.stream_async.return_value = _mock_stream_async(result)

    events = [event async for event in tool.stream(tool_use, {})]

    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert result_events[0]["tool_result"]["status"] == "success"
    assert result_events[0]["tool_result"]["content"][0]["json"] == {"answer": "42"}


# --- preserve_context ---


@pytest.mark.asyncio
async def test_stream_resets_to_initial_state_when_preserve_context_false(fake_agent):
    fake_agent.messages = [{"role": "user", "content": [{"text": "initial"}]}]
    fake_agent.state.set("counter", 0)

    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    # Mutate agent state as if a previous invocation happened
    fake_agent.messages.append({"role": "assistant", "content": [{"text": "reply"}]})
    fake_agent.state.set("counter", 5)

    # Mock stream_async so we don't need a real model
    fake_agent.stream_async = lambda prompt, **kw: _mock_stream_async(
        AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "ok"}]},
            metrics=EventLoopMetrics(),
            state={},
        )
    )

    tool_use = {
        "toolUseId": "tool-123",
        "name": "fake_agent",
        "input": {"input": "hello"},
    }

    async for _ in tool.stream(tool_use, {}):
        pass

    assert fake_agent.messages == [{"role": "user", "content": [{"text": "initial"}]}]
    assert fake_agent.state.get("counter") == 0


@pytest.mark.asyncio
async def test_stream_resets_on_every_invocation(fake_agent):
    """Each call should reset to the same initial snapshot, not to the previous call's state."""
    fake_agent.messages = [{"role": "user", "content": [{"text": "seed"}]}]
    fake_agent.state.set("count", 1)

    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    fake_agent.stream_async = lambda prompt, **kw: _mock_stream_async(
        AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "ok"}]},
            metrics=EventLoopMetrics(),
            state={},
        )
    )

    tool_use = {
        "toolUseId": "tool-1",
        "name": "fake_agent",
        "input": {"input": "first"},
    }

    async for _ in tool.stream(tool_use, {}):
        pass
    fake_agent.messages.append({"role": "assistant", "content": [{"text": "added"}]})
    fake_agent.state.set("count", 99)

    tool_use["toolUseId"] = "tool-2"
    async for _ in tool.stream(tool_use, {}):
        pass

    assert fake_agent.messages == [{"role": "user", "content": [{"text": "seed"}]}]
    assert fake_agent.state.get("count") == 1


@pytest.mark.asyncio
async def test_stream_initial_snapshot_is_deep_copy(fake_agent):
    """Mutating the agent's messages after construction should not affect the snapshot."""
    fake_agent.messages = [{"role": "user", "content": [{"text": "original"}]}]

    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    fake_agent.messages[0]["content"][0]["text"] = "mutated"
    fake_agent.messages.append({"role": "assistant", "content": [{"text": "extra"}]})

    fake_agent.stream_async = lambda prompt, **kw: _mock_stream_async(
        AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "ok"}]},
            metrics=EventLoopMetrics(),
            state={},
        )
    )

    tool_use = {
        "toolUseId": "tool-123",
        "name": "fake_agent",
        "input": {"input": "hello"},
    }

    async for _ in tool.stream(tool_use, {}):
        pass

    assert fake_agent.messages == [{"role": "user", "content": [{"text": "original"}]}]


@pytest.mark.asyncio
async def test_stream_resets_empty_initial_state_when_preserve_context_false(fake_agent):
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    fake_agent.messages = [{"role": "user", "content": [{"text": "old"}]}]
    fake_agent.state.set("key", "value")

    fake_agent.stream_async = lambda prompt, **kw: _mock_stream_async(
        AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "ok"}]},
            metrics=EventLoopMetrics(),
            state={},
        )
    )

    tool_use = {
        "toolUseId": "tool-123",
        "name": "fake_agent",
        "input": {"input": "hello"},
    }

    async for _ in tool.stream(tool_use, {}):
        pass

    assert fake_agent.messages == []
    assert fake_agent.state.get() == {}


@pytest.mark.asyncio
async def test_stream_resets_context_by_default(fake_agent):
    """Default preserve_context=False means each invocation starts fresh."""
    fake_agent.messages = [{"role": "user", "content": [{"text": "old"}]}]
    fake_agent.state.set("key", "value")
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc")

    # Mutate after construction
    fake_agent.messages.append({"role": "assistant", "content": [{"text": "extra"}]})
    fake_agent.state.set("key", "changed")

    fake_agent.stream_async = lambda prompt, **kw: _mock_stream_async(
        AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "ok"}]},
            metrics=EventLoopMetrics(),
            state={},
        )
    )

    tool_use = {
        "toolUseId": "tool-123",
        "name": "fake_agent",
        "input": {"input": "hello"},
    }

    async for _ in tool.stream(tool_use, {}):
        pass

    # Should reset to construction-time snapshot
    assert fake_agent.messages == [{"role": "user", "content": [{"text": "old"}]}]
    assert fake_agent.state.get("key") == "value"


@pytest.mark.asyncio
async def test_stream_preserves_context_when_explicitly_true(fake_agent):
    fake_agent.messages = [{"role": "user", "content": [{"text": "old"}]}]
    fake_agent.state.set("key", "value")
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)

    fake_agent.stream_async = lambda prompt, **kw: _mock_stream_async(
        AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "ok"}]},
            metrics=EventLoopMetrics(),
            state={},
        )
    )

    tool_use = {
        "toolUseId": "tool-123",
        "name": "fake_agent",
        "input": {"input": "hello"},
    }

    async for _ in tool.stream(tool_use, {}):
        pass

    assert len(fake_agent.messages) >= 1
    assert fake_agent.state.get("key") == "value"


def test_preserve_context_false_rejects_session_manager(fake_agent):
    """preserve_context=False should raise ValueError when agent has a session manager."""
    fake_agent._session_manager = MagicMock()

    with pytest.raises(ValueError, match="cannot be used with an agent that has a session manager"):
        _AgentAsTool(fake_agent, name="t", description="d", preserve_context=False)


# --- interrupt propagation ---


@pytest.fixture
def interrupt_result():
    interrupt = Interrupt(id="interrupt-1", name="approval", reason="need approval")
    return AgentResult(
        stop_reason="interrupt",
        message={"role": "assistant", "content": [{"text": "pending"}]},
        metrics=EventLoopMetrics(),
        state={},
        interrupts=[interrupt],
    )


@pytest.mark.asyncio
async def test_stream_interrupt_yields_tool_interrupt_event(tool, mock_agent, tool_use, interrupt_result):
    """When the sub-agent returns an interrupt result, _AgentAsTool should yield ToolInterruptEvent."""
    mock_agent.stream_async.return_value = _mock_stream_async(interrupt_result)

    events = [event async for event in tool.stream(tool_use, {})]

    assert len(events) == 1
    assert isinstance(events[0], ToolInterruptEvent)
    assert events[0].interrupts == interrupt_result.interrupts
    assert events[0].tool_use_id == "tool-123"


@pytest.mark.asyncio
async def test_stream_interrupt_no_tool_result_appended(tool, mock_agent, tool_use, interrupt_result):
    """ToolInterruptEvent should not produce a ToolResultEvent."""
    mock_agent.stream_async.return_value = _mock_stream_async(interrupt_result)

    events = [event async for event in tool.stream(tool_use, {})]

    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert result_events == []


@pytest.mark.asyncio
async def test_stream_interrupt_forwards_intermediate_events(tool, mock_agent, tool_use, interrupt_result):
    """Intermediate events should still be yielded before the interrupt."""
    intermediate = [{"data": "partial"}]
    mock_agent.stream_async.return_value = _mock_stream_async(interrupt_result, intermediate)

    events = [event async for event in tool.stream(tool_use, {})]

    stream_events = [e for e in events if isinstance(e, AgentAsToolStreamEvent)]
    interrupt_events = [e for e in events if isinstance(e, ToolInterruptEvent)]
    assert len(stream_events) == 1
    assert len(interrupt_events) == 1


@pytest.mark.asyncio
async def test_stream_interrupt_resume_forwards_responses(fake_agent):
    """On resume, _AgentAsTool should forward interrupt responses to the sub-agent."""
    interrupt = Interrupt(id="interrupt-1", name="approval", reason="need approval", response="APPROVE")

    # Put the sub-agent in an activated interrupt state with the response already set
    fake_agent._interrupt_state.interrupts["interrupt-1"] = interrupt
    fake_agent._interrupt_state.activate()

    normal_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "approved"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(normal_result))

    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "do something"}}

    events = [event async for event in tool.stream(tool_use, {})]

    # Should have called stream_async with interrupt responses, not the original prompt
    call_args = fake_agent.stream_async.call_args
    agent_input = call_args[0][0]
    assert isinstance(agent_input, list)
    assert len(agent_input) == 1
    assert agent_input[0]["interruptResponse"]["interruptId"] == "interrupt-1"
    assert agent_input[0]["interruptResponse"]["response"] == "APPROVE"

    # Should produce a normal result
    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(result_events) == 1
    assert result_events[0]["tool_result"]["status"] == "success"


@pytest.mark.asyncio
async def test_stream_interrupt_resume_skips_state_reset(fake_agent):
    """When resuming from interrupt with preserve_context=False, state reset should be skipped."""
    fake_agent.messages = [{"role": "user", "content": [{"text": "initial"}]}]
    fake_agent.state.set("key", "value")

    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    # Simulate the sub-agent being in interrupt state after a previous invocation
    interrupt = Interrupt(id="interrupt-1", name="approval", reason="need approval", response="APPROVE")
    fake_agent._interrupt_state.interrupts["interrupt-1"] = interrupt
    fake_agent._interrupt_state.activate()

    # Mutate messages to simulate sub-agent progress before interrupt
    fake_agent.messages.append({"role": "assistant", "content": [{"text": "working on it"}]})

    normal_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "done"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(normal_result))

    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "do something"}}
    async for _ in tool.stream(tool_use, {}):
        pass

    # Messages should NOT have been reset — the sub-agent needs its conversation history intact
    assert len(fake_agent.messages) == 2


@pytest.mark.asyncio
async def test_is_sub_agent_interrupted_false_by_default(tool):
    """_is_sub_agent_interrupted returns False when no interrupts are active."""
    assert tool._is_sub_agent_interrupted() is False


@pytest.mark.asyncio
async def test_is_sub_agent_interrupted_true_when_activated(fake_agent):
    """_is_sub_agent_interrupted returns True when the sub-agent's interrupt state is activated."""
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)
    assert tool._is_sub_agent_interrupted() is False

    fake_agent._interrupt_state.activate()
    assert tool._is_sub_agent_interrupted() is True


@pytest.mark.asyncio
async def test_build_interrupt_responses(fake_agent):
    """_build_interrupt_responses packages sub-agent interrupts into response content blocks."""
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)

    interrupt_a = Interrupt(id="id-a", name="a", reason="r", response="yes")
    interrupt_b = Interrupt(id="id-b", name="b", reason="r", response=None)
    fake_agent._interrupt_state.interrupts = {"id-a": interrupt_a, "id-b": interrupt_b}

    responses = tool._build_interrupt_responses()

    # Only interrupt_a has a response
    assert len(responses) == 1
    assert responses[0] == {"interruptResponse": {"interruptId": "id-a", "response": "yes"}}


# --- concurrency ---


@pytest.mark.asyncio
async def test_stream_rejects_concurrent_call(tool, mock_agent, tool_use, agent_result):
    """A second concurrent call should get an error ToolResultEvent."""
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)

    # Simulate the lock already being held by another invocation
    tool._lock.acquire()
    try:
        events = [event async for event in tool.stream(tool_use, {})]

        assert len(events) == 1
        assert isinstance(events[0], ToolResultEvent)
        assert events[0]["tool_result"]["status"] == "error"
        assert "already processing" in events[0]["tool_result"]["content"][0]["text"]
        mock_agent.stream_async.assert_not_called()
    finally:
        tool._lock.release()


@pytest.mark.asyncio
async def test_stream_releases_lock_after_completion(tool, mock_agent, tool_use, agent_result):
    """Lock should be released after stream completes, allowing subsequent calls."""
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)

    async for _ in tool.stream(tool_use, {}):
        pass

    assert not tool._lock.locked()

    # A second call should succeed
    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)
    events = [event async for event in tool.stream(tool_use, {})]

    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(result_events) == 1
    assert result_events[0]["tool_result"]["status"] == "success"


@pytest.mark.asyncio
async def test_stream_releases_lock_after_error(tool, mock_agent, tool_use):
    """Lock should be released even when the agent raises an exception."""
    mock_agent.stream_async.side_effect = RuntimeError("boom")

    async for _ in tool.stream(tool_use, {}):
        pass

    assert not tool._lock.locked()


# --- Agent-as-tool sugar (passing agents directly in tools list) ---


def test_agent_passed_directly_in_tools_list():
    """Test that an Agent can be passed directly in another Agent's tools list."""
    from strands.agent.agent import Agent

    sub_agent = Agent(name="research_agent", description="Does research", callback_handler=None)

    # This should work without calling .as_tool() explicitly
    parent_agent = Agent(name="orchestrator", tools=[sub_agent], callback_handler=None)

    assert "research_agent" in parent_agent.tool_names


def test_multiple_agents_passed_directly_in_tools_list():
    """Test that multiple Agents can be passed directly in another Agent's tools list."""
    from strands.agent.agent import Agent

    agent_a = Agent(name="agent_a", callback_handler=None)
    agent_b = Agent(name="agent_b", callback_handler=None)

    parent = Agent(name="parent", tools=[agent_a, agent_b], callback_handler=None)

    assert "agent_a" in parent.tool_names
    assert "agent_b" in parent.tool_names


def test_agent_mixed_with_regular_tools_in_tools_list():
    """Test that Agents can be mixed with regular tools in the tools list."""
    from strands import tool as tool_decorator
    from strands.agent.agent import Agent

    @tool_decorator
    def my_tool(x: str) -> str:
        """A regular tool."""
        return x

    sub_agent = Agent(name="helper_agent", callback_handler=None)

    parent = Agent(name="parent", tools=[my_tool, sub_agent], callback_handler=None)

    assert "my_tool" in parent.tool_names
    assert "helper_agent" in parent.tool_names


# --- cancellation ---


@pytest.mark.asyncio
async def test_stream_forwards_parent_cancel_signal_to_sub_agent(tool, mock_agent, tool_use, agent_result):
    """The wrapped agent receives the parent's cancellation signal as its external signal."""
    from strands.agent.agent import Agent

    mock_agent.stream_async.return_value = _mock_stream_async(agent_result)
    parent = Agent(name="parent", callback_handler=None)

    async for _ in tool.stream(tool_use, {"agent": parent}):
        pass

    assert mock_agent.stream_async.call_args.kwargs["cancel_signal"] is parent.cancel_signal


@pytest.mark.asyncio
async def test_stream_cancelled_sub_agent_returns_error(tool, mock_agent, tool_use):
    """A cancelled wrapped agent surfaces as an error tool result."""
    cancelled_result = AgentResult(
        stop_reason="cancelled",
        message={"role": "assistant", "content": [{"text": "Cancelled by user"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    mock_agent.stream_async.return_value = _mock_stream_async(cancelled_result)

    events = [event async for event in tool.stream(tool_use, {})]

    assert events == [
        ToolResultEvent(
            {
                "toolUseId": "tool-123",
                "status": "error",
                "content": [{"text": "Agent 'test_agent' cancelled"}],
            }
        )
    ]


@pytest.mark.asyncio
async def test_stream_pre_set_parent_cancel_signal_returns_error_without_model_response(tool_use):
    """A parent signal that is already set cancels the wrapped agent before it produces a response."""
    from strands.agent.agent import Agent
    from tests.fixtures.mocked_model_provider import MockedModelProvider

    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "sub-agent response"}]}])
    child = Agent(name="child", model=model, callback_handler=None)
    tool = _AgentAsTool(child, name="child", preserve_context=True)

    parent = Agent(name="parent", callback_handler=None)
    parent.cancel()

    events = [event async for event in tool.stream(tool_use, {"agent": parent})]

    assert events[-1] == ToolResultEvent(
        {
            "toolUseId": "tool-123",
            "status": "error",
            "content": [{"text": "Agent 'child' cancelled"}],
        }
    )
    assert not any("sub-agent response" in str(message) for message in child.messages)


@pytest.mark.asyncio
async def test_stream_sub_agent_cancel_does_not_clear_parent_signal(tool_use):
    """The wrapped agent clears only its own signal on completion, never the parent's."""
    from strands.agent.agent import Agent
    from tests.fixtures.mocked_model_provider import MockedModelProvider

    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "sub-agent response"}]}])
    child = Agent(name="child", model=model, callback_handler=None)
    tool = _AgentAsTool(child, name="child", preserve_context=True)

    parent = Agent(name="parent", callback_handler=None)
    parent.cancel()

    async for _ in tool.stream(tool_use, {"agent": parent}):
        pass

    assert parent.cancel_signal.is_set()
    assert not child.cancel_signal.is_set()
