"""Tests for middleware-initiated interrupts on ExecuteToolStage."""

from dataclasses import replace

import pytest

import strands
from strands import Agent
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.interrupt import Interrupt
from strands.middleware._agent_stream import AgentStreamContext
from strands.middleware.stages import ExecuteToolStage, MiddlewareInterruptResult, _resolve_middleware_interrupt
from strands.types._events import ToolInterruptEvent, ToolResultEvent
from tests.fixtures.mock_hook_provider import MockHookProvider
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def calculator_tool():
    @strands.tool(name="calculator")
    def func(expression: str) -> str:
        """Evaluate a math expression."""
        return str(eval(expression))

    return func


def _tool_use_model(responses_after_tool):
    """Build a model that calls the calculator once, then replays the given responses."""
    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "tool_1", "name": "calculator", "input": {"expression": "2+2"}}}],
    }
    return MockedModelProvider([tool_use_msg, *responses_after_tool])


@pytest.fixture
def model():
    return _tool_use_model([{"role": "assistant", "content": [{"text": "The answer is 4."}]}])


@pytest.fixture
def agent(model, calculator_tool):
    return Agent(model=model, tools=[calculator_tool], callback_handler=None)


def test_middleware_interrupt_halts_agent(agent):
    """Calling context.interrupt() raises InterruptException and halts execution."""

    async def approval_gate(context, next_fn):
        context.interrupt("approve_calc", reason="Confirm calculation?")
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, approval_gate)
    result = agent("what is 2+2?")

    assert result.stop_reason == "interrupt"
    assert len(result.interrupts) == 1
    assert result.interrupts[0].name == "approve_calc"
    assert result.interrupts[0].reason == "Confirm calculation?"


def test_middleware_interrupt_resumes_with_response(calculator_tool):
    """After a response is provided, interrupt() returns it and execution continues."""
    final_msg = {"role": "assistant", "content": [{"text": "The answer is 4."}]}
    model = _tool_use_model([final_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    received_response = None

    async def approval_gate(context, next_fn):
        nonlocal received_response
        interrupt_result = context.interrupt("approve_calc", reason="Confirm?")
        received_response = interrupt_result.response
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, approval_gate)

    result = agent("what is 2+2?")
    assert result.stop_reason == "interrupt"

    result = agent([{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "yes"}}])
    assert received_response == "yes"


def test_middleware_interrupt_returns_middleware_interrupt_result(calculator_tool):
    """interrupt() returns a MiddlewareInterruptResult instance on resume."""
    final_msg = {"role": "assistant", "content": [{"text": "4"}]}
    model = _tool_use_model([final_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    interrupt_result_type = None

    async def gate(context, next_fn):
        nonlocal interrupt_result_type
        interrupt_result = context.interrupt("gate", reason="check")
        interrupt_result_type = type(interrupt_result)
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, gate)

    result = agent("calc")
    assert result.stop_reason == "interrupt"

    result = agent([{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "ok"}}])
    assert interrupt_result_type is MiddlewareInterruptResult


def test_middleware_interrupt_with_preemptive_response(agent):
    """Providing a preemptive response skips the interrupt entirely."""
    skipped_interrupt = False

    async def gate_with_default(context, next_fn):
        nonlocal skipped_interrupt
        interrupt_result = context.interrupt("gate", reason="check", response="pre-approved")
        skipped_interrupt = interrupt_result.response == "pre-approved"
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, gate_with_default)
    result = agent("what is 2+2?")

    assert result.stop_reason == "end_turn"
    assert skipped_interrupt


def test_middleware_interrupt_short_circuits_tool_execution():
    """When middleware interrupts, the tool does NOT execute."""
    tool_executed = False

    @strands.tool(name="tracked_tool")
    def tracked_tool() -> str:
        """A tool that tracks execution."""
        nonlocal tool_executed
        tool_executed = True
        return "done"

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "tracked_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "ok"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[tracked_tool], callback_handler=None)

    async def blocker(context, next_fn):
        context.interrupt("block", reason="nope")
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, blocker)
    result = agent("do it")

    assert result.stop_reason == "interrupt"
    assert not tool_executed


def test_middleware_interrupt_id_is_deterministic(agent):
    """The interrupt ID is namespaced by tool_use_id."""

    async def gate(context, next_fn):
        context.interrupt("my_gate", reason="check")
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, gate)

    result = agent("what is 2+2?")
    assert result.interrupts[0].id.startswith("v1:middleware_execute_tool:tool_1:")


def test_middleware_interrupt_registered_in_state(calculator_tool):
    """When middleware interrupts, the interrupt is registered in the agent's state."""
    model = _tool_use_model([{"role": "assistant", "content": [{"text": "4"}]}])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def blocker(context, next_fn):
        context.interrupt("gate", reason="confirm")
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, blocker)

    result = agent("calc")
    assert result.stop_reason == "interrupt"
    assert len(agent._interrupt_state.interrupts) == 1


def test_context_replace_preserves_interrupt(calculator_tool):
    """dataclasses.replace() on ExecuteToolContext preserves interrupt functionality."""
    final_msg = {"role": "assistant", "content": [{"text": "4"}]}
    model = _tool_use_model([final_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    interrupt_worked = False

    async def replace_then_interrupt(context, next_fn):
        nonlocal interrupt_worked
        new_context = replace(context, tool_use={**context.tool_use, "input": {"expression": "3+3"}})
        # interrupt() must still work on the replaced context (it carries _interrupt_state).
        new_context.interrupt("gate", reason="check")
        interrupt_worked = True
        async for event in next_fn(new_context):
            yield event

    agent.add_middleware(ExecuteToolStage, replace_then_interrupt)

    result = agent("calc")
    assert result.stop_reason == "interrupt"
    assert not interrupt_worked

    result = agent([{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "yes"}}])
    assert interrupt_worked


def test_middleware_interrupt_denial_returns_error_result(calculator_tool):
    """Middleware can deny execution based on the interrupt response."""
    final_msg = {"role": "assistant", "content": [{"text": "denied"}]}
    model = _tool_use_model([final_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    tool_executed = False

    async def approval_gate(context, next_fn):
        nonlocal tool_executed
        interrupt_result = context.interrupt("approve", reason="Allow?")
        if interrupt_result.response != "yes":
            yield ToolResultEvent(
                {
                    "toolUseId": context.tool_use["toolUseId"],
                    "status": "error",
                    "content": [{"text": "Denied by middleware"}],
                }
            )
            return
        tool_executed = True
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, approval_gate)

    result = agent("calc")
    assert result.stop_reason == "interrupt"

    result = agent([{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "no"}}])
    assert not tool_executed


def test_middleware_interrupt_approval_executes_tool(calculator_tool):
    """When middleware receives approval, the tool actually executes."""
    final_msg = {"role": "assistant", "content": [{"text": "4"}]}
    model = _tool_use_model([final_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    tool_executed = False
    original_stream = calculator_tool.stream

    async def tracking_stream(*args, **kwargs):
        nonlocal tool_executed
        tool_executed = True
        async for event in original_stream(*args, **kwargs):
            yield event

    calculator_tool.stream = tracking_stream

    async def approval_gate(context, next_fn):
        interrupt_result = context.interrupt("approve", reason="Allow?")
        if interrupt_result.response != "yes":
            yield ToolResultEvent(
                {
                    "toolUseId": context.tool_use["toolUseId"],
                    "status": "error",
                    "content": [{"text": "Denied"}],
                }
            )
            return
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, approval_gate)

    result = agent("calc")
    assert result.stop_reason == "interrupt"

    result = agent([{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "yes"}}])
    assert tool_executed


@pytest.mark.asyncio
async def test_middleware_interrupt_yields_interrupt_event_on_stream(calculator_tool):
    """The stream surfaces the interrupt as a named ToolInterruptEvent, then a terminal interrupt stop.

    Mirrors the TS "yields InterruptEvent on the stream" test: the interrupt is observable
    mid-stream by name, not only as the terminal result's stop_reason.
    """
    model = _tool_use_model([{"role": "assistant", "content": [{"text": "4"}]}])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def gate(context, next_fn):
        context.interrupt("gate", reason="check")
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, gate)

    events = []
    async for event in agent.stream_async("calc"):
        events.append(event)

    # A ToolInterruptEvent carrying the named interrupt is surfaced mid-stream.
    interrupt_events = [event for event in events if "tool_interrupt_event" in event]
    assert len(interrupt_events) == 1
    surfaced = interrupt_events[0]["tool_interrupt_event"]["interrupts"]
    assert [interrupt.name for interrupt in surfaced] == ["gate"]

    # And the invocation terminates with an interrupt stop.
    result_events = [event for event in events if "result" in event and hasattr(event.get("result"), "stop_reason")]
    assert any(event["result"].stop_reason == "interrupt" for event in result_events)


# --- tool-originated interrupts through the middleware chain ---


def test_tool_originated_interrupt_flows_through_chain(calculator_tool):
    """A ToolInterruptEvent from tool.stream() halts the agent even with middleware present."""

    @strands.tool(name="interrupting_tool", context=True)
    def interrupting_tool(tool_context) -> str:
        """Interrupts on first call."""
        return tool_context.interrupt("confirm", reason="approve?")

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "interrupting_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[interrupting_tool], callback_handler=None)

    saw_interrupt_event = False

    async def observer(context, next_fn):
        nonlocal saw_interrupt_event
        async for event in next_fn(context):
            if isinstance(event, ToolInterruptEvent):
                saw_interrupt_event = True
            yield event

    agent.add_middleware(ExecuteToolStage, observer)
    result = agent("go")

    assert result.stop_reason == "interrupt"
    assert saw_interrupt_event
    assert len(result.interrupts) == 1
    assert result.interrupts[0].name == "confirm"


def test_tool_originated_multiple_interrupts_all_registered():
    """A single ToolInterruptEvent carrying multiple interrupts registers and surfaces all of them.

    Mirrors the sub-agent (_AgentAsTool) path, which propagates several interrupts in one event.
    """

    @strands.tool(name="multi_tool")
    def multi_tool() -> str:
        """Placeholder; real behavior is in the custom stream below."""
        return "unused"

    interrupts = [
        Interrupt(id="v1:sub:a", name="first", reason="r1"),
        Interrupt(id="v1:sub:b", name="second", reason="r2"),
    ]

    async def multi_stream(tool_use, _invocation_state, **_kwargs):
        yield ToolInterruptEvent(tool_use, interrupts)

    multi_tool.stream = multi_stream

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "multi_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[multi_tool], callback_handler=None)

    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, passthrough)
    result = agent("go")

    assert result.stop_reason == "interrupt"
    assert {interrupt.name for interrupt in result.interrupts} == {"first", "second"}
    assert {"v1:sub:a", "v1:sub:b"} <= set(agent._interrupt_state.interrupts.keys())


# --- hook interaction on interrupt ---


def test_before_hook_fires_but_after_hook_skipped_on_interrupt(calculator_tool):
    """On a middleware interrupt, BeforeToolCallEvent fires but AfterToolCallEvent does not.

    An interrupted tool never produces a result, so the after-hook (which reports a result)
    is intentionally skipped — unlike short-circuit, where a result exists and the after-hook
    fires. This locks in that boundary so it can't regress silently.
    """
    hook_provider = MockHookProvider(event_types="all")
    model = _tool_use_model([{"role": "assistant", "content": [{"text": "4"}]}])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None, hooks=[hook_provider])

    async def gate(context, next_fn):
        context.interrupt("gate", reason="check")
        async for event in next_fn(context):
            yield event

    agent.add_middleware(ExecuteToolStage, gate)
    result = agent("calc")

    assert result.stop_reason == "interrupt"
    _, events = hook_provider.get_events()
    event_types = [type(event) for event in events]
    assert BeforeToolCallEvent in event_types
    assert AfterToolCallEvent not in event_types


# --- interrupt resolution precedence ---


def test_stored_human_response_takes_precedence_over_preemptive(calculator_tool):
    """A stored human response must win over a middleware's preemptive response=.

    Guards against accidentally swapping the two checks in _resolve_middleware_interrupt,
    which would let a middleware default silently override a human decision.
    """
    interrupt_id = "v1:middleware_execute_tool:tool_1:test-gate"
    interrupts = {interrupt_id: Interrupt(id=interrupt_id, name="gate", response="DENIED")}

    result = _resolve_middleware_interrupt(interrupts, interrupt_id, "gate", None, "auto-approve")

    assert result == MiddlewareInterruptResult(response="DENIED")


# --- AgentStreamContext interrupt coverage ---


def test_agent_stream_context_interrupt_id_and_resolution():
    """AgentStreamContext.interrupt raises, resolves, and produces a stable namespaced id."""
    from strands.interrupt import InterruptException

    ctx = AgentStreamContext(agent=None, messages=[], invocation_state={}, _interrupts={})

    interrupt_id = ctx._interrupt_id("gate")
    assert interrupt_id.startswith("v1:middleware_agent_stream:")
    assert interrupt_id == ctx._interrupt_id("gate")

    with pytest.raises(InterruptException):
        ctx.interrupt("gate")

    resumed = AgentStreamContext(
        agent=None,
        messages=[],
        invocation_state={},
        _interrupts={interrupt_id: Interrupt(id=interrupt_id, name="gate", response="ok")},
    )
    assert resumed.interrupt("gate") == MiddlewareInterruptResult(response="ok")
