"""Tests for _AgentAsTool - the agent-as-tool adapter."""

from unittest.mock import MagicMock
from urllib.parse import quote

import pytest

import strands
from strands.agent._agent_as_tool import _INTERRUPTED_TURNS_KEY, _AgentAsTool
from strands.agent.agent import Agent
from strands.agent.agent_result import AgentResult
from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry
from strands.interrupt import Interrupt, _InterruptState
from strands.session.file_session_manager import FileSessionManager
from strands.telemetry.metrics import EventLoopMetrics
from strands.types._events import AgentAsToolStreamEvent, ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from tests.fixtures.mocked_model_provider import MockedModelProvider


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
    return Agent(name="fake_agent", callback_handler=None)


def namespaced_id(tool_use_id, local_id):
    """The parent-visible id of a sub-agent interrupt."""
    return f"v1:agent_as_tool:{quote(tool_use_id, safe='')}:{local_id}"


def interrupt_result_for(interrupt_id):
    """An interrupt result carrying a single sub-agent-local interrupt."""
    return AgentResult(
        stop_reason="interrupt",
        message={"role": "assistant", "content": [{"text": "needs approval"}]},
        metrics=EventLoopMetrics(),
        state={},
        interrupts=[Interrupt(id=interrupt_id, name="approval", reason="need approval")],
    )


@pytest.fixture
def orchestrator():
    """Stand-in orchestrator: agent-as-tool only reads its interrupt state via invocation_state."""
    parent = MagicMock()
    parent._interrupt_state = _InterruptState()
    return parent


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
async def test_stream_interrupt_yields_tool_interrupt_event(tool, mock_agent, tool_use, interrupt_result, orchestrator):
    """A sub-agent interrupt propagates upward with its id namespaced by this tool call."""
    mock_agent.stream_async.return_value = _mock_stream_async(interrupt_result)

    events = [event async for event in tool.stream(tool_use, {"agent": orchestrator})]

    assert len(events) == 1
    assert isinstance(events[0], ToolInterruptEvent)
    assert events[0].tool_use_id == "tool-123"

    tru_interrupts = events[0].interrupts
    exp_interrupts = [Interrupt(id=namespaced_id("tool-123", "interrupt-1"), name="approval", reason="need approval")]
    assert tru_interrupts == exp_interrupts


@pytest.mark.asyncio
async def test_stream_interrupt_no_tool_result_appended(tool, mock_agent, tool_use, interrupt_result, orchestrator):
    """ToolInterruptEvent should not produce a ToolResultEvent."""
    mock_agent.stream_async.return_value = _mock_stream_async(interrupt_result)

    events = [event async for event in tool.stream(tool_use, {"agent": orchestrator})]

    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert result_events == []


@pytest.mark.asyncio
async def test_stream_interrupt_forwards_intermediate_events(
    tool, mock_agent, tool_use, interrupt_result, orchestrator
):
    """Intermediate events should still be yielded before the interrupt."""
    intermediate = [{"data": "partial"}]
    mock_agent.stream_async.return_value = _mock_stream_async(interrupt_result, intermediate)

    events = [event async for event in tool.stream(tool_use, {"agent": orchestrator})]

    stream_events = [e for e in events if isinstance(e, AgentAsToolStreamEvent)]
    interrupt_events = [e for e in events if isinstance(e, ToolInterruptEvent)]
    assert len(stream_events) == 1
    assert len(interrupt_events) == 1


@pytest.mark.asyncio
async def test_stream_interrupt_resume_forwards_responses(fake_agent, orchestrator):
    """Resume maps the orchestrator's interrupt responses back to sub-agent-local ids."""
    fake_agent._interrupt_state.interrupts["interrupt-1"] = Interrupt(id="interrupt-1", name="approval", reason="r")
    fake_agent._interrupt_state.activate()

    parent_id = namespaced_id("tool-123", "interrupt-1")
    orchestrator._interrupt_state.interrupts[parent_id] = Interrupt(id=parent_id, name="approval", reason="r")
    orchestrator._interrupt_state.context["responses"] = [
        {"interruptResponse": {"interruptId": parent_id, "response": "APPROVE"}}
    ]
    orchestrator._interrupt_state.activate()

    normal_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "approved"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(normal_result))

    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "do something"}}

    events = [event async for event in tool.stream(tool_use, {"agent": orchestrator})]

    tru_prompt = fake_agent.stream_async.call_args[0][0]
    exp_prompt = [{"interruptResponse": {"interruptId": "interrupt-1", "response": "APPROVE"}}]
    assert tru_prompt == exp_prompt

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(result_events) == 1
    assert result_events[0]["tool_result"]["status"] == "success"


@pytest.mark.asyncio
async def test_stream_interrupt_resume_skips_state_reset(fake_agent, orchestrator):
    """Resuming an interrupt keeps the sub-agent's interrupted turn instead of resetting it."""
    # Built while the sub-agent has no messages, so its reset baseline is empty and a reset would show.
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    fake_agent.messages = [
        {"role": "user", "content": [{"text": "initial"}]},
        {"role": "assistant", "content": [{"text": "working on it"}]},
    ]
    fake_agent._interrupt_state.interrupts["interrupt-1"] = Interrupt(id="interrupt-1", name="approval", reason="r")
    fake_agent._interrupt_state.activate()

    parent_id = namespaced_id("tool-123", "interrupt-1")
    orchestrator._interrupt_state.interrupts[parent_id] = Interrupt(id=parent_id, name="approval", reason="r")
    orchestrator._interrupt_state.context["responses"] = [
        {"interruptResponse": {"interruptId": parent_id, "response": "APPROVE"}}
    ]
    orchestrator._interrupt_state.activate()

    normal_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "done"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(normal_result))

    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "do something"}}
    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    tru_messages = fake_agent.messages
    exp_messages = [
        {"role": "user", "content": [{"text": "initial"}]},
        {"role": "assistant", "content": [{"text": "working on it"}]},
    ]
    assert tru_messages == exp_messages

    tru_prompt = fake_agent.stream_async.call_args[0][0]
    exp_prompt = [{"interruptResponse": {"interruptId": "interrupt-1", "response": "APPROVE"}}]
    assert tru_prompt == exp_prompt


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


@pytest.mark.asyncio
async def test_stream_interrupt_stores_interrupted_turn_for_ephemeral_sub_agent(
    fake_agent, orchestrator, interrupt_result
):
    """An ephemeral sub-agent's interrupted turn is stored in the orchestrator's interrupt context."""
    fake_agent.messages = [{"role": "user", "content": [{"text": "go"}]}]
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(interrupt_result))
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    stored_turns = orchestrator._interrupt_state.context[_INTERRUPTED_TURNS_KEY]
    assert list(stored_turns) == ["tool-123"]

    tru_messages = stored_turns["tool-123"]["data"]["messages"]
    exp_messages = [{"role": "user", "content": [{"text": "go"}]}]
    assert tru_messages == exp_messages


@pytest.mark.asyncio
async def test_stream_interrupt_stores_no_turn_when_context_is_preserved(fake_agent, orchestrator, interrupt_result):
    """A context-preserving sub-agent owns its state, so the orchestrator stores nothing for it."""
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(interrupt_result))
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    tru_context = orchestrator._interrupt_state.context
    exp_context = {}
    assert tru_context == exp_context


@pytest.mark.asyncio
async def test_stream_resume_restores_ephemeral_sub_agent_from_a_stored_turn(orchestrator):
    """An ephemeral sub-agent rebuilt from scratch resumes from the stored turn."""
    interrupted = Agent(name="fake_agent", callback_handler=None)
    interrupted.messages = [{"role": "user", "content": [{"text": "go"}]}]
    interrupted._interrupt_state.interrupts["interrupt-1"] = Interrupt(id="interrupt-1", name="approval", reason="r")
    interrupted._interrupt_state.activate()

    parent_id = namespaced_id("tool-123", "interrupt-1")
    orchestrator._interrupt_state.interrupts[parent_id] = Interrupt(id=parent_id, name="approval", reason="r")
    orchestrator._interrupt_state.context.update(
        {
            "responses": [{"interruptResponse": {"interruptId": parent_id, "response": "APPROVE"}}],
            _INTERRUPTED_TURNS_KEY: {"tool-123": interrupted.take_snapshot(preset="session").to_dict()},
        }
    )
    orchestrator._interrupt_state.activate()

    rebuilt = Agent(name="fake_agent", callback_handler=None)
    normal_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "done"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    rebuilt.stream_async = MagicMock(return_value=_mock_stream_async(normal_result))

    tool = _AgentAsTool(rebuilt, name="fake_agent", description="desc", preserve_context=False)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    tru_messages = rebuilt.messages
    exp_messages = [{"role": "user", "content": [{"text": "go"}]}]
    assert tru_messages == exp_messages
    assert list(rebuilt._interrupt_state.interrupts) == ["interrupt-1"]

    tru_prompt = rebuilt.stream_async.call_args[0][0]
    exp_prompt = [{"interruptResponse": {"interruptId": "interrupt-1", "response": "APPROVE"}}]
    assert tru_prompt == exp_prompt

    # The stored turn is consumed; a sub-agent that interrupts again stores a fresh one.
    tru_stored_turns = orchestrator._interrupt_state.context[_INTERRUPTED_TURNS_KEY]
    exp_stored_turns = {}
    assert tru_stored_turns == exp_stored_turns


@pytest.mark.asyncio
async def test_stream_ignores_interrupt_belonging_to_another_call(fake_agent, orchestrator, agent_result):
    """An interrupt the orchestrator holds for a different tool call is not adopted by this one."""
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    # The sub-agent still carries another caller's stored turn, e.g. after restoring a shared session.
    fake_agent.messages = [{"role": "user", "content": [{"text": "another caller's turn"}]}]
    fake_agent._interrupt_state.interrupts["interrupt-1"] = Interrupt(id="interrupt-1", name="approval", reason="r")
    fake_agent._interrupt_state.activate()

    other_call_id = namespaced_id("tool-999", "interrupt-1")
    orchestrator._interrupt_state.interrupts[other_call_id] = Interrupt(id=other_call_id, name="approval", reason="r")
    orchestrator._interrupt_state.activate()

    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(agent_result))
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    tru_prompt = fake_agent.stream_async.call_args[0][0]
    exp_prompt = "go"
    assert tru_prompt == exp_prompt

    tru_messages = fake_agent.messages
    exp_messages = []
    assert tru_messages == exp_messages


@pytest.mark.asyncio
async def test_stream_resume_without_restorable_turn_reports_an_error(fake_agent, orchestrator, caplog):
    """A context-preserving sub-agent that lost its interrupted turn fails loudly instead of silently."""
    parent_id = namespaced_id("tool-123", "interrupt-1")
    orchestrator._interrupt_state.interrupts[parent_id] = Interrupt(id=parent_id, name="approval", reason="r")
    orchestrator._interrupt_state.context["responses"] = [
        {"interruptResponse": {"interruptId": parent_id, "response": "APPROVE"}}
    ]
    orchestrator._interrupt_state.activate()

    fake_agent.stream_async = MagicMock()
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    with caplog.at_level("ERROR"):
        events = [event async for event in tool.stream(tool_use, {"agent": orchestrator})]

    fake_agent.stream_async.assert_not_called()
    assert len(events) == 1
    assert events[0]["tool_result"]["status"] == "error"
    assert "NOT applied" in events[0]["tool_result"]["content"][0]["text"]
    assert "cannot resume" in caplog.text


def tool_use_message(tool_use_id, name, tool_input):
    """An assistant message calling one tool."""
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": tool_input}}],
    }


def text_message(text):
    """An assistant message carrying plain text."""
    return {"role": "assistant", "content": [{"text": text}]}


@pytest.fixture
def confirmable_action():
    """A tool guarded by a confirmation interrupt, plus the record of what it actually ran."""
    executions = []

    @strands.tool
    def dangerous_action(target: str) -> str:
        """Perform an action that requires confirmation."""
        executions.append(target)
        return f"done: {target}"

    class ConfirmHook(HookProvider):
        def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
            registry.add_callback(BeforeToolCallEvent, self._confirm)

        def _confirm(self, event: BeforeToolCallEvent) -> None:
            if event.tool_use["name"] != "dangerous_action":
                return
            if event.interrupt("confirm_dangerous", reason="confirm?") != "APPROVE":
                event.cancel_tool = "not approved"

    return dangerous_action, ConfirmHook(), executions


def test_nested_interrupt_resumes_after_rehydration(tmp_path, confirmable_action):
    """Regression test for https://github.com/strands-agents/harness-sdk/issues/3076."""
    dangerous_action, confirm_hook, executions = confirmable_action

    def build_orchestrator(sub_agent_responses, orchestrator_responses):
        sub_agent = Agent(
            name="worker",
            agent_id="worker",
            model=MockedModelProvider(sub_agent_responses),
            tools=[dangerous_action],
            hooks=[confirm_hook],
            callback_handler=None,
        )
        return Agent(
            name="orchestrator",
            agent_id="orchestrator",
            model=MockedModelProvider(orchestrator_responses),
            tools=[sub_agent.as_tool()],
            callback_handler=None,
            session_manager=FileSessionManager("session-3076", storage_dir=str(tmp_path)),
        )

    orchestrator = build_orchestrator(
        [tool_use_message("sub-1", "dangerous_action", {"target": "prod-db"}), text_message("done")],
        [tool_use_message("orch-1", "worker", {"input": "go"}), text_message("all done")],
    )
    interrupted_result = orchestrator("do the thing that needs confirmation")

    assert interrupted_result.stop_reason == "interrupt"
    assert executions == []
    interrupt_id = interrupted_result.interrupts[0].id

    # Process boundary: every agent is rebuilt and only the session survives.
    resumed_orchestrator = build_orchestrator([text_message("done")], [text_message("all done")])
    tru_result = resumed_orchestrator([{"interruptResponse": {"interruptId": interrupt_id, "response": "APPROVE"}}])

    assert tru_result.stop_reason == "end_turn"

    tru_executions = executions
    exp_executions = ["prod-db"]
    assert tru_executions == exp_executions


def test_nested_interrupt_resumes_after_rehydration_with_a_sub_agent_session_manager(tmp_path, confirmable_action):
    """A context-preserving sub-agent that owns a session manager resumes across a process boundary."""
    dangerous_action, confirm_hook, executions = confirmable_action

    def build_orchestrator(sub_agent_responses, orchestrator_responses):
        sub_agent = Agent(
            name="worker",
            agent_id="worker",
            model=MockedModelProvider(sub_agent_responses),
            tools=[dangerous_action],
            hooks=[confirm_hook],
            callback_handler=None,
            session_manager=FileSessionManager("session-sub", storage_dir=str(tmp_path)),
        )
        return Agent(
            name="orchestrator",
            agent_id="orchestrator",
            model=MockedModelProvider(orchestrator_responses),
            tools=[sub_agent.as_tool(preserve_context=True)],
            callback_handler=None,
            session_manager=FileSessionManager("session-orch", storage_dir=str(tmp_path)),
        )

    orchestrator = build_orchestrator(
        [tool_use_message("sub-1", "dangerous_action", {"target": "prod-db"}), text_message("done")],
        [tool_use_message("orch-1", "worker", {"input": "go"}), text_message("all done")],
    )
    interrupted_result = orchestrator("do the thing that needs confirmation")

    assert interrupted_result.stop_reason == "interrupt"
    assert executions == []
    interrupt_id = interrupted_result.interrupts[0].id

    resumed_orchestrator = build_orchestrator([text_message("done")], [text_message("all done")])
    tru_result = resumed_orchestrator([{"interruptResponse": {"interruptId": interrupt_id, "response": "APPROVE"}}])

    assert tru_result.stop_reason == "end_turn"

    tru_executions = executions
    exp_executions = ["prod-db"]
    assert tru_executions == exp_executions


@pytest.mark.asyncio
async def test_stream_resume_reraises_the_interrupt_when_the_stored_turn_cannot_be_loaded(
    fake_agent, orchestrator, caplog
):
    """A stored turn that fails to load raises the interrupt again rather than failing the call."""
    interrupted = Agent(name="fake_agent", callback_handler=None)
    interrupted._interrupt_state.interrupts["interrupt-1"] = Interrupt(id="interrupt-1", name="approval", reason="r")
    interrupted._interrupt_state.activate()
    unloadable = interrupted.take_snapshot(preset="session").to_dict()
    unloadable["schema_version"] = "0.0"

    parent_id = namespaced_id("tool-123", "interrupt-1")
    orchestrator._interrupt_state.interrupts[parent_id] = Interrupt(id=parent_id, name="approval", reason="r")
    orchestrator._interrupt_state.context.update(
        {
            "responses": [{"interruptResponse": {"interruptId": parent_id, "response": "APPROVE"}}],
            _INTERRUPTED_TURNS_KEY: {"tool-123": unloadable},
        }
    )
    orchestrator._interrupt_state.activate()

    fake_agent.stream_async = MagicMock()
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    with caplog.at_level("ERROR"):
        events = [event async for event in tool.stream(tool_use, {"agent": orchestrator})]

    fake_agent.stream_async.assert_not_called()
    assert len(events) == 1

    tru_interrupt_ids = [interrupt.id for interrupt in events[0]["tool_interrupt_event"]["interrupts"]]
    exp_interrupt_ids = [parent_id]
    assert tru_interrupt_ids == exp_interrupt_ids
    assert "failed to restore interrupted sub-agent turn" in caplog.text

    tru_stored_turns = orchestrator._interrupt_state.context[_INTERRUPTED_TURNS_KEY]
    exp_stored_turns = {"tool-123": unloadable}
    assert tru_stored_turns == exp_stored_turns


@pytest.mark.asyncio
async def test_stream_interrupt_warns_when_a_context_preserving_sub_agent_has_no_session_manager(
    fake_agent, orchestrator, interrupt_result, caplog
):
    """A context-preserving sub-agent with nowhere to keep its turn is flagged as the interrupt parks."""
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(interrupt_result))
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    with caplog.at_level("WARNING"):
        async for _ in tool.stream(tool_use, {"agent": orchestrator}):
            pass

    assert "preserve_context=True and no session manager" in caplog.text


@pytest.mark.asyncio
async def test_stream_resume_reraises_only_the_interrupts_the_stored_turn_still_awaits(
    fake_agent, orchestrator, caplog
):
    """Re-raising skips an interrupt the sub-agent has already finished with."""
    interrupted = Agent(name="fake_agent", callback_handler=None)
    interrupted._interrupt_state.interrupts["interrupt-2"] = Interrupt(id="interrupt-2", name="approval", reason="r")
    interrupted._interrupt_state.activate()
    unloadable = interrupted.take_snapshot(preset="session").to_dict()
    unloadable["schema_version"] = "0.0"

    consumed_id = namespaced_id("tool-123", "interrupt-1")
    awaited_id = namespaced_id("tool-123", "interrupt-2")
    orchestrator._interrupt_state.interrupts[consumed_id] = Interrupt(
        id=consumed_id, name="approval", reason="r", response="APPROVE"
    )
    orchestrator._interrupt_state.interrupts[awaited_id] = Interrupt(id=awaited_id, name="approval", reason="r")
    orchestrator._interrupt_state.context.update(
        {
            "responses": [{"interruptResponse": {"interruptId": awaited_id, "response": "APPROVE"}}],
            _INTERRUPTED_TURNS_KEY: {"tool-123": unloadable},
        }
    )
    orchestrator._interrupt_state.activate()

    fake_agent.stream_async = MagicMock()
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    with caplog.at_level("ERROR"):
        events = [event async for event in tool.stream(tool_use, {"agent": orchestrator})]

    fake_agent.stream_async.assert_not_called()

    tru_interrupt_ids = [interrupt.id for interrupt in events[0]["tool_interrupt_event"]["interrupts"]]
    exp_interrupt_ids = [awaited_id]
    assert tru_interrupt_ids == exp_interrupt_ids


@pytest.mark.asyncio
async def test_stream_interrupt_parks_a_turn_that_is_isolated_from_the_sub_agent(
    fake_agent, orchestrator, interrupt_result
):
    """A stored turn is a copy: later work on the same sub-agent instance cannot alter it."""
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(interrupt_result))
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)
    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}

    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    fake_agent._interrupt_state.context["responses"] = [
        {"interruptResponse": {"interruptId": "later", "response": "DENY"}}
    ]

    tru_stored_context = orchestrator._interrupt_state.context[_INTERRUPTED_TURNS_KEY]["tool-123"]["data"][
        "interrupt_state"
    ]["context"]
    exp_stored_context = {}
    assert tru_stored_context == exp_stored_context


@pytest.mark.asyncio
async def test_stream_resets_stale_interrupt_state_on_a_fresh_call(fake_agent, orchestrator, agent_result):
    """A fresh call clears interrupt state the sub-agent is still carrying from an abandoned turn."""
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=False)

    fake_agent._interrupt_state.interrupts["stale-1"] = Interrupt(id="stale-1", name="approval", reason="r")
    fake_agent._interrupt_state.activate()
    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(agent_result))

    tool_use = {"toolUseId": "tool-123", "name": "fake_agent", "input": {"input": "go"}}
    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    assert fake_agent._interrupt_state.activated is False
    assert fake_agent._interrupt_state.interrupts == {}


@pytest.mark.asyncio
async def test_stream_resume_maps_only_this_calls_responses_when_the_tool_use_id_bears_the_separator(
    fake_agent, orchestrator
):
    """A tool use id containing ':' is escaped, so a longer call's answers are not adopted."""
    fake_agent._interrupt_state.interrupts["interrupt-1"] = Interrupt(id="interrupt-1", name="approval", reason="r")
    fake_agent._interrupt_state.activate()

    mine = namespaced_id("tool:123", "interrupt-1")
    other = namespaced_id("tool:123:extra", "interrupt-1")
    orchestrator._interrupt_state.interrupts[mine] = Interrupt(id=mine, name="approval", reason="r")
    orchestrator._interrupt_state.context["responses"] = [
        {"interruptResponse": {"interruptId": other, "response": "DENY"}},
        {"interruptResponse": {"interruptId": mine, "response": "APPROVE"}},
    ]
    orchestrator._interrupt_state.activate()

    fake_agent.stream_async = MagicMock(return_value=_mock_stream_async(interrupt_result_for("interrupt-1")))
    tool = _AgentAsTool(fake_agent, name="fake_agent", description="desc", preserve_context=True)
    tool_use = {"toolUseId": "tool:123", "name": "fake_agent", "input": {"input": "go"}}

    async for _ in tool.stream(tool_use, {"agent": orchestrator}):
        pass

    tru_prompt = fake_agent.stream_async.call_args[0][0]
    exp_prompt = [{"interruptResponse": {"interruptId": "interrupt-1", "response": "APPROVE"}}]
    assert tru_prompt == exp_prompt
