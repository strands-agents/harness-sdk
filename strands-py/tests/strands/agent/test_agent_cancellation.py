"""Tests for agent cancellation functionality using agent.cancel() API."""

import asyncio
import threading
import time
from unittest.mock import ANY

import pytest

from strands import Agent, tool
from strands.hooks import AfterModelCallEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent
from tests.fixtures.mocked_model_provider import MockedModelProvider

# Default agent response for simple tests
DEFAULT_RESPONSE = {
    "role": "assistant",
    "content": [{"text": "Hello! How can I help you?"}],
}


@pytest.mark.asyncio
async def test_agent_cancel_before_invocation():
    """Test agent.cancel() before invocation starts.

    Verifies that calling cancel() before invoke_async() results in
    immediate cancellation without any model calls.
    """
    agent = Agent(model=MockedModelProvider([DEFAULT_RESPONSE]))

    # Cancel before invocation
    agent.cancel()

    result = await agent.invoke_async("Hello")

    assert result.stop_reason == "cancelled"
    assert result.message == {
        "role": "assistant",
        "content": [{"text": "Cancelled by user"}],
        "metadata": ANY,
        "tracking_id": ANY,
    }


@pytest.mark.asyncio
async def test_agent_cancel_during_execution():
    """Test agent.cancel() during execution.

    Verifies that calling cancel() while the agent is running
    stops execution at the next checkpoint.
    """
    streaming_started = asyncio.Event()
    cancel_ready = asyncio.Event()

    class DelayedModelProvider(MockedModelProvider):
        async def stream(self, *args, **kwargs):
            streaming_started.set()
            # Block until cancel has been called
            await cancel_ready.wait()
            async for event in super().stream(*args, **kwargs):
                yield event

    agent = Agent(model=DelayedModelProvider([DEFAULT_RESPONSE]))

    async def cancel_when_ready():
        await streaming_started.wait()
        agent.cancel()
        cancel_ready.set()

    cancel_task = asyncio.create_task(cancel_when_ready())
    result = await agent.invoke_async("Hello")
    await cancel_task

    assert result.stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_agent_cancel_with_tools():
    """Test agent.cancel() during tool execution.

    Verifies that cancellation works correctly when tools are being executed.
    Uses AfterModelCallEvent hook to cancel deterministically after model returns tool_use.
    """
    tool_executed = []

    @tool
    def slow_tool(x: int) -> int:
        """A tool for testing."""
        tool_executed.append(x)
        return x * 2

    tool_use_response = {
        "role": "assistant",
        "content": [
            {
                "toolUse": {
                    "toolUseId": "tool_1",
                    "name": "slow_tool",
                    "input": {"x": 5},
                }
            }
        ],
    }

    agent = Agent(
        model=MockedModelProvider([tool_use_response, DEFAULT_RESPONSE]),
        tools=[slow_tool],
    )

    # Cancel deterministically after model returns tool_use
    async def cancel_after_model(event: AfterModelCallEvent):
        if event.stop_response and event.stop_response.stop_reason == "tool_use":
            agent.cancel()

    agent.add_hook(cancel_after_model, AfterModelCallEvent)

    result = await agent.invoke_async("Use the tool")

    assert result.stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_agent_cancel_idempotent():
    """Test that calling cancel() multiple times is safe.

    Verifies that multiple cancel() calls are idempotent and don't
    cause any issues.
    """
    agent = Agent(model=MockedModelProvider([DEFAULT_RESPONSE]))

    # Cancel multiple times
    agent.cancel()
    agent.cancel()
    agent.cancel()

    result = await agent.invoke_async("Hello")

    assert result.stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_agent_cancel_from_thread():
    """Test agent.cancel() from another thread.

    Verifies thread-safety of the cancel() method when called
    from a background thread.
    """
    streaming_started = asyncio.Event()
    cancel_ready = asyncio.Event()
    loop = asyncio.get_running_loop()

    class DelayedModelProvider(MockedModelProvider):
        async def stream(self, *args, **kwargs):
            streaming_started.set()
            await cancel_ready.wait()
            async for event in super().stream(*args, **kwargs):
                yield event

    agent = Agent(model=DelayedModelProvider([DEFAULT_RESPONSE]))

    def cancel_from_thread():
        # Wait for streaming to start before cancelling
        asyncio.run_coroutine_threadsafe(streaming_started.wait(), loop).result()
        agent.cancel()
        loop.call_soon_threadsafe(cancel_ready.set)

    thread = threading.Thread(target=cancel_from_thread)
    thread.start()

    result = await agent.invoke_async("Hello")
    thread.join()

    assert result.stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_agent_cancel_streaming():
    """Test cancellation during streaming response.

    Verifies that cancellation works correctly when using
    the streaming API (stream_async).
    """
    chunks_yielded = asyncio.Event()
    cancel_done = asyncio.Event()

    class SlowStreamingModelProvider(MockedModelProvider):
        async def stream(self, *args, **kwargs):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}

            for i in range(10):
                yield {"contentBlockDelta": {"delta": {"text": f"chunk {i} "}}}
                if i == 2:
                    # Signal after a few chunks so cancel can fire
                    chunks_yielded.set()
                    # Wait for cancel to complete before continuing
                    await cancel_done.wait()

            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}

    agent = Agent(model=SlowStreamingModelProvider([DEFAULT_RESPONSE]))

    async def cancel_after_chunks():
        await chunks_yielded.wait()
        agent.cancel()
        cancel_done.set()

    cancel_task = asyncio.create_task(cancel_after_chunks())

    events = []
    async for event in agent.stream_async("Hello"):
        events.append(event)
        if event.get("result"):
            break

    await cancel_task

    result_event = next((e for e in events if e.get("result")), None)
    assert result_event is not None
    assert result_event["result"].stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_agent_cancel_before_tool_execution_adds_tool_results():
    """Test that cancelling before tool execution adds tool_result messages.

    Verifies that when cancellation occurs after model returns tool_use but before
    tools execute, proper tool_result messages are added to maintain valid conversation state.
    This prevents the "tool_use without tool_result" error on next invocation.
    """

    @tool
    def calculator(x: int, y: int) -> int:
        """Add two numbers."""
        return x + y

    tool_use_response = {
        "role": "assistant",
        "content": [
            {
                "toolUse": {
                    "toolUseId": "tool_1",
                    "name": "calculator",
                    "input": {"x": 5, "y": 3},
                }
            }
        ],
    }

    agent = Agent(
        model=MockedModelProvider([tool_use_response, DEFAULT_RESPONSE]),
        tools=[calculator],
    )

    async def cancel_after_model(event: AfterModelCallEvent):
        if event.stop_response and event.stop_response.stop_reason == "tool_use":
            agent.cancel()

    agent.add_hook(cancel_after_model, AfterModelCallEvent)

    result = await agent.invoke_async("Calculate 5 + 3")

    assert result.stop_reason == "cancelled"

    # Should have: user message, assistant message with tool_use, user message with tool_result
    assert len(agent.messages) == 3
    assert agent.messages[0]["role"] == "user"
    assert agent.messages[1]["role"] == "assistant"
    assert agent.messages[2]["role"] == "user"

    tool_result_content = agent.messages[2]["content"]
    assert len(tool_result_content) == 1
    assert "toolResult" in tool_result_content[0]

    tool_result = tool_result_content[0]["toolResult"]
    assert tool_result["toolUseId"] == "tool_1"
    assert tool_result["status"] == "error"
    assert "cancelled" in tool_result["content"][0]["text"].lower()


@pytest.mark.asyncio
async def test_agent_cancel_continue_after():
    """Test that agent is reusable after cancellation.

    Verifies that the cancel signal is cleared after an invocation completes,
    allowing subsequent invocations to run normally.
    """
    agent = Agent(model=MockedModelProvider([DEFAULT_RESPONSE, DEFAULT_RESPONSE]))

    agent.cancel()
    result1 = await agent.invoke_async("Hello")
    assert result1.stop_reason == "cancelled"

    # Second invocation should work normally
    result2 = await agent.invoke_async("Hello again")
    assert result2.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_cancel_during_tool_interrupt_resume_preserves_interrupt_state():
    """Cancelling a resumed tool interrupt preserves the pending interrupt state for a later resume."""

    @tool(context=True)
    def approver(tool_context) -> str:
        """Require approval before returning."""
        return tool_context.interrupt("approve", reason="proceed?")

    tool_use_response = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "tool_1", "name": "approver", "input": {}}}],
    }
    agent = Agent(
        model=MockedModelProvider([tool_use_response, DEFAULT_RESPONSE]),
        tools=[approver],
    )

    interrupt_result = await agent.invoke_async("go")
    assert interrupt_result.stop_reason == "interrupt"
    assert agent._interrupt_state.activated
    assert agent._interrupt_state.pending_tool_execution is not None

    # Cancel the resume before the tool runs.
    agent.cancel()
    cancelled_result = await agent.invoke_async(
        [{"interruptResponse": {"interruptId": interrupt_result.interrupts[0].id, "response": "go"}}]
    )

    assert cancelled_result.stop_reason == "cancelled"
    # The pending tool interrupt state survives the cancelled pass.
    assert agent._interrupt_state.activated
    assert agent._interrupt_state.pending_tool_execution is not None


@pytest.mark.asyncio
async def test_stream_async_pre_set_cancel_signal_cancels_immediately(alist):
    """An external signal that is already set cancels the invocation at the first checkpoint."""
    agent = Agent(model=MockedModelProvider([DEFAULT_RESPONSE]))
    cancel_signal = threading.Event()
    cancel_signal.set()

    events = await alist(agent.stream_async("Hello", cancel_signal=cancel_signal))

    result = events[-1]["result"]
    assert result.stop_reason == "cancelled"
    assert result.message["content"] == [{"text": "Cancelled by user"}]
    # The agent never touches the caller's event, and clears its own for reuse.
    assert cancel_signal.is_set()
    assert not agent.cancel_signal.is_set()


@pytest.mark.asyncio
async def test_invoke_async_cancel_signal_set_during_model_streaming():
    """An external signal set while the model streams cancels at the next checkpoint."""
    streaming_started = asyncio.Event()
    cancel_ready = asyncio.Event()

    class DelayedModelProvider(MockedModelProvider):
        async def stream(self, *args, **kwargs):
            streaming_started.set()
            await cancel_ready.wait()
            async for event in super().stream(*args, **kwargs):
                yield event

    agent = Agent(model=DelayedModelProvider([DEFAULT_RESPONSE]))
    cancel_signal = threading.Event()

    async def cancel_when_ready():
        await streaming_started.wait()
        cancel_signal.set()
        deadline = asyncio.get_running_loop().time() + 5
        while not agent.cancel_signal.is_set():
            assert asyncio.get_running_loop().time() < deadline, "signal was not linked before the deadline"
            await asyncio.sleep(0.01)
        cancel_ready.set()

    cancel_task = asyncio.create_task(cancel_when_ready())
    result = await agent.invoke_async("Hello", cancel_signal=cancel_signal)
    await cancel_task

    assert result.stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_stream_async_cancel_signal_cancels_mid_invocation(alist):
    """A signal set from a hook mid-invocation reaches the agent's own cancellation signal."""
    agent = Agent(model=MockedModelProvider([DEFAULT_RESPONSE]))
    cancel_signal = threading.Event()

    async def cancel_before_model(event: BeforeModelCallEvent):
        cancel_signal.set()
        deadline = asyncio.get_running_loop().time() + 5
        while not event.agent.cancel_signal.is_set():
            assert asyncio.get_running_loop().time() < deadline, "signal was not linked before the deadline"
            await asyncio.sleep(0.01)

    agent.add_hook(cancel_before_model, BeforeModelCallEvent)

    events = await alist(agent.stream_async("Hello", cancel_signal=cancel_signal))

    assert events[-1]["result"].stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_cancel_signal_observed_synchronously_at_checkpoints():
    """An external signal set by a hook cancels at the next checkpoint, without waiting for the watcher poll."""
    cancel_signal = threading.Event()

    async def set_external_signal(event: BeforeModelCallEvent):
        cancel_signal.set()

    agent = Agent(model=MockedModelProvider([DEFAULT_RESPONSE]))
    agent.add_hook(set_external_signal, BeforeModelCallEvent)

    result = await agent.invoke_async("Hello", cancel_signal=cancel_signal)

    assert result.stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_cancel_signal_aborts_in_flight_model_stream():
    """The model receives the agent's composed signal, not the caller's event, and sees it set."""
    signals_seen = []
    stream_started = asyncio.Event()

    class SignalCapturingModelProvider(MockedModelProvider):
        async def stream(self, *args, cancel_signal=None, **kwargs):
            signals_seen.append(cancel_signal)
            yield {"messageStart": {"role": "assistant"}}
            stream_started.set()

            deadline = asyncio.get_running_loop().time() + 5
            while not cancel_signal.is_set():
                assert asyncio.get_running_loop().time() < deadline, "signal was not set before the deadline"
                await asyncio.sleep(0.01)

            yield {"contentBlockDelta": {"delta": {"text": "arrives after cancellation"}}}

    agent = Agent(model=SignalCapturingModelProvider([DEFAULT_RESPONSE]))
    cancel_signal = threading.Event()

    async def cancel_once_streaming():
        await stream_started.wait()
        cancel_signal.set()

    cancel_task = asyncio.create_task(cancel_once_streaming())
    result = await agent.invoke_async("Hello", cancel_signal=cancel_signal)
    await cancel_task

    assert result.stop_reason == "cancelled"
    assert signals_seen[0] is agent.cancel_signal
    assert signals_seen[0] is not cancel_signal


@pytest.mark.asyncio
async def test_cancel_signal_truncated_stream_returns_cancelled():
    """A provider that aborts mid-stream (no messageStop) surfaces cancellation, not a truncated end_turn."""

    class TruncatingModelProvider(MockedModelProvider):
        async def stream(self, *args, cancel_signal=None, **kwargs):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockDelta": {"delta": {"text": "partial"}}}
            cancel_signal.set()
            # Abort: end the stream without contentBlockStop or messageStop, as a provider
            # closing the HTTP response mid-body does.

    agent = Agent(model=TruncatingModelProvider([DEFAULT_RESPONSE]))

    result = await agent.invoke_async("Hello")

    assert result.stop_reason == "cancelled"
    assert result.message["content"] == [{"text": "Cancelled by user"}]
    # The truncated assistant turn is discarded, not persisted.
    assert not any("partial" in str(message) for message in agent.messages)


@pytest.mark.asyncio
async def test_agent_reuse_after_external_cancel_signal():
    """A caller event that stays set re-cancels; a fresh event lets the agent run again."""
    agent = Agent(model=MockedModelProvider([DEFAULT_RESPONSE, DEFAULT_RESPONSE]))
    cancel_signal = threading.Event()
    cancel_signal.set()

    first = await agent.invoke_async("Hello", cancel_signal=cancel_signal)
    assert first.stop_reason == "cancelled"

    second = await agent.invoke_async("Hello again", cancel_signal=cancel_signal)
    assert second.stop_reason == "cancelled"

    third = await agent.invoke_async("Hello once more", cancel_signal=threading.Event())
    assert third.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_tool_context_cancel_signal_set_by_external_signal():
    """An external cancellation signal reaches a running tool through its context."""
    signal_states = []
    cancel_signal = threading.Event()

    @tool(context=True)
    def probe(tool_context) -> str:
        """Set the caller's event, then read the context signal back."""
        cancel_signal.set()
        deadline = time.time() + 5
        while not tool_context.cancel_signal.is_set() and time.time() < deadline:
            time.sleep(0.01)

        signal_states.append(tool_context.cancel_signal.is_set())
        return "done"

    tool_use_response = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "tool_1", "name": "probe", "input": {}}}],
    }
    agent = Agent(model=MockedModelProvider([tool_use_response, DEFAULT_RESPONSE]), tools=[probe])

    result = await agent.invoke_async("Use the tool", cancel_signal=cancel_signal)

    assert signal_states == [True]
    assert result.stop_reason == "cancelled"


_CHARGE_TOOL_USE = {
    "role": "assistant",
    "content": [{"toolUse": {"toolUseId": "t1", "name": "charge_card", "input": {"amount": "$100"}}}],
}
_CHARGE_DONE = {"role": "assistant", "content": [{"text": "done"}]}


def _charge_agent(model_messages, ran, deny):
    """An agent whose tool interrupts for approval, with a hook that can cancel the batch."""

    @tool(name="charge_card")
    def charge_card(amount: str) -> str:
        """Charge the customer's card."""
        ran.append(amount)
        return f"charged {amount}"

    agent = Agent(model=MockedModelProvider(model_messages), tools=[charge_card], callback_handler=None)
    agent.hooks.add_callback(BeforeToolCallEvent, lambda event: event.interrupt("approve_tool", reason="run it?"))

    def maybe_cancel(event):
        if deny[0]:
            event.cancel = "policy denied"

    agent.hooks.add_callback(BeforeToolsEvent, maybe_cancel)
    return agent


def _approve_all(result):
    return [{"interruptResponse": {"interruptId": interrupt.id, "response": "yes"}} for interrupt in result.interrupts]


@pytest.mark.asyncio
async def test_hook_cancelled_tool_batch_does_not_replay_the_stored_tool_use():
    """A hook that cancels the tool batch prevents the tool from running on a resumed pass."""
    ran: list[str] = []
    deny = [False]
    agent = _charge_agent([_CHARGE_TOOL_USE, _CHARGE_DONE], ran, deny)

    first = await agent.invoke_async("charge $100")
    assert first.stop_reason == "interrupt"

    deny[0] = True
    resumed = await agent.invoke_async(_approve_all(first))

    assert resumed.stop_reason == "end_turn"
    assert ran == []
    assert [message["role"] for message in agent.messages] == ["user", "assistant", "user", "assistant"]
    # The completed invocation leaves no interrupt state behind.
    assert not agent._interrupt_state.activated
    assert not agent._interrupt_state.context
    assert not agent._interrupt_state.interrupts
    assert agent._interrupt_state.pending_tool_execution is None


def _approver_agent(ran, cancel_on_first_run=False):
    @tool(context=True)
    def approver(tool_context) -> str:
        """Require approval before doing the work."""
        tool_context.interrupt("approve", reason="proceed?")
        ran.append("executed")
        if cancel_on_first_run and len(ran) == 1:
            tool_context.agent.cancel()
        return "done"

    tool_use_response = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "tool_1", "name": "approver", "input": {}}}],
    }

    return Agent(
        model=MockedModelProvider([tool_use_response, DEFAULT_RESPONSE] * 3),
        tools=[approver],
        callback_handler=None,
    )


@pytest.mark.asyncio
async def test_cancel_before_tool_runs_still_executes_the_approved_tool():
    """A cancel that lands before the tool runs must not consume the approval."""
    ran: list[str] = []
    agent = _approver_agent(ran)

    interrupted = await agent.invoke_async("go")
    response = [{"interruptResponse": {"interruptId": interrupted.interrupts[0].id, "response": "go"}}]

    agent.cancel()
    cancelled = await agent.invoke_async(response)
    assert cancelled.stop_reason == "cancelled"
    assert ran == []

    agent._cancel_signal.clear()
    await agent.invoke_async(response)
    assert ran == ["executed"]


@pytest.mark.asyncio
async def test_cancel_while_tool_runs_does_not_re_execute_the_tool():
    """A cancel that lands while the tool runs must not replay the completed tool."""
    ran: list[str] = []
    agent = _approver_agent(ran, cancel_on_first_run=True)

    interrupted = await agent.invoke_async("go")
    response = [{"interruptResponse": {"interruptId": interrupted.interrupts[0].id, "response": "go"}}]

    cancelled = await agent.invoke_async(response)
    assert cancelled.stop_reason == "cancelled"
    assert ran == ["executed"]

    agent._cancel_signal.clear()
    await agent.invoke_async(response)
    assert ran == ["executed"]
