from __future__ import annotations

import asyncio
from unittest.mock import ANY

import pytest

from strands import Agent, ToolContext, tool
from strands.hooks import AfterModelCallEvent, MessageAddedEvent
from strands.tools.executors import ConcurrentToolExecutor
from tests.fixtures.mocked_model_provider import MockedModelProvider
from tests.strands.background_tasks.test_background_tasks import (
    _assistant_text,
    _assistant_tool_use,
    _deliveries,
    _invoke_management_tool,
)


def _observe_wait(agent, monkeypatch):
    waiting = asyncio.Queue()
    original = agent._background_tasks._await_next_settlement

    async def wait(tasks):
        waiting.put_nowait(None)
        await original(tasks)

    monkeypatch.setattr(agent._background_tasks, "_await_next_settlement", wait)
    return waiting


@pytest.mark.asyncio
async def test_send_during_final_response_stays_queued_without_background_work():
    model = MockedModelProvider([_assistant_text("Final answer")])
    agent = Agent(model=model, background_tasks={"wake_on_input": True}, callback_handler=None)

    def send_before_final_response(event: AfterModelCallEvent) -> None:
        agent.send("Follow-up")

    agent.add_hook(send_before_final_response, AfterModelCallEvent)

    result = await agent.invoke_async("Start")

    assert str(result) == "Final answer\n"
    assert model.index == 1
    assert agent._inbox.has_messages()


@pytest.mark.asyncio
@pytest.mark.parametrize("wake_on_input", [False, True])
async def test_send_during_wait_continues_only_when_enabled(monkeypatch, wake_on_input):
    release = asyncio.Event()
    answered = asyncio.Event()

    @tool
    async def work() -> str:
        """Wait for a result."""
        await release.wait()
        return "finished"

    responses = [_assistant_tool_use(work.tool_name, "work", {}), _assistant_text("Waiting")]
    if wake_on_input:
        responses.append(_assistant_text("Update received"))
    responses.append(_assistant_text("Final answer"))
    agent = Agent(
        model=MockedModelProvider(responses),
        tools=[work],
        callback_handler=None,
        background_tasks={"always": [work], "wake_on_input": wake_on_input},
    )

    def observe(event: MessageAddedEvent):
        if event.message["content"] == [{"text": "Update received"}]:
            answered.set()

    agent.add_hook(observe, MessageAddedEvent)
    waiting = _observe_wait(agent, monkeypatch)
    invocation = asyncio.create_task(agent.invoke_async("Start"))
    try:
        await asyncio.wait_for(waiting.get(), 5)
        await asyncio.to_thread(agent.send, "Use the new constraint")
        if wake_on_input:
            await asyncio.wait_for(answered.wait(), 5)
            await asyncio.wait_for(waiting.get(), 5)
            assert not invocation.done()
            assert not release.is_set()
            assert _deliveries(agent.messages) == []
        else:
            assert not answered.is_set()
            assert agent._inbox.has_messages()
        release.set()
        result = await asyncio.wait_for(invocation, 5)
        assert str(result) == "Final answer\n"
        assert len(_deliveries(agent.messages)) == 1
        assert not agent._inbox.has_messages()
        assert any(message["content"] == [{"text": "Use the new constraint"}] for message in agent.messages)
    finally:
        release.set()
        invocation.cancel()
        await asyncio.gather(invocation, return_exceptions=True)


@pytest.mark.asyncio
async def test_cancellation_wins_over_input_during_wait(monkeypatch):
    release = asyncio.Event()

    @tool
    async def work() -> str:
        """Wait for a result."""
        await release.wait()
        return "finished"

    model = MockedModelProvider([_assistant_tool_use(work.tool_name, "work", {}), _assistant_text("Waiting")])
    agent = Agent(model=model, tools=[work], background_tasks={"always": [work], "wake_on_input": True})
    waiting = _observe_wait(agent, monkeypatch)
    invocation = asyncio.create_task(agent.invoke_async("Start"))
    try:
        await asyncio.wait_for(waiting.get(), 5)
        agent.cancel()
        agent.send("Queued for next time")
        await asyncio.wait_for(invocation, 5)
        assert model.index == 2
        assert agent._inbox.has_messages()
    finally:
        release.set()
        await agent._background_tasks._manager.wait_for_idle(timeout=5)
        invocation.cancel()
        await asyncio.gather(invocation, return_exceptions=True)


@pytest.mark.asyncio
async def test_manage_custom_message_progress_and_ephemeral_persistence():
    registered = asyncio.Event()
    release = asyncio.Event()
    received = []

    @tool(context=True)
    async def work(tool_context: ToolContext) -> str:
        """Accept updated instructions."""

        def receive(message, **kwargs):
            received.append(message)

        unregister = tool_context.on_message(receive)
        tool_context.report_progress("x" * 1000)
        registered.set()
        try:
            await release.wait()
            return "finished"
        finally:
            unregister()

    agent = Agent(
        model=MockedModelProvider([_assistant_tool_use(work.tool_name, "work", {}), _assistant_text("Dispatched")]),
        tools=[work],
        background_tasks={"always": [work], "wait_for_completion": False},
        callback_handler=None,
    )
    try:
        await agent.invoke_async("Start")
        await asyncio.wait_for(registered.wait(), 5)
        [task] = await agent._background_tasks._manager.list()
        task_id = task["task_id"]
        while "progress" not in agent._background_tasks._task_snapshots()[0]:
            await asyncio.sleep(0)
        result = await _invoke_management_tool(agent, {"mode": "get", "task_id": task_id})
        assert result["content"][0]["json"]["progress"] == {
            "message": "x" * 512,
            "update_count": 1,
            "updated_at": ANY,
        }
        assert "progress" not in agent.state.get("strands.background_tasks")[0]
        result = await _invoke_management_tool(
            agent, {"mode": "message", "task_id": task_id, "message": "New constraint"}
        )
        assert result == {
            "toolUseId": "management-use",
            "status": "success",
            "content": [{"json": {"task_id": task_id, "message_sent": True}}],
        }
        assert received == ["New constraint"]
        release.set()
        await agent._background_tasks._manager.wait(task_id)
        result = await _invoke_management_tool(agent, {"mode": "message", "task_id": task_id, "message": "Too late"})
        assert result["status"] == "error"
        assert "terminal" in str(result).lower() or "completed" in str(result).lower()
    finally:
        release.set()
        await agent._background_tasks._manager.wait_for_idle(timeout=5)


@pytest.mark.asyncio
async def test_simultaneous_results_precede_input_with_concurrent_executor(monkeypatch):
    release = asyncio.Event()
    waiting = asyncio.Event()
    continue_wait = asyncio.Event()

    @tool
    async def work() -> str:
        """Return a concurrent result."""
        await release.wait()
        return "finished"

    dispatch = _assistant_tool_use(work.tool_name, "first", {})
    dispatch["content"].extend(_assistant_tool_use(work.tool_name, "second", {})["content"])
    agent = Agent(
        model=MockedModelProvider([dispatch, _assistant_text("Waiting"), _assistant_text("Final")]),
        tools=[work],
        tool_executor=ConcurrentToolExecutor(),
        background_tasks={"always": [work], "wake_on_input": True},
        callback_handler=None,
    )
    original = agent._background_tasks._await_next_settlement

    async def gated_wait(tasks):
        waiting.set()
        await continue_wait.wait()
        await original(tasks)

    monkeypatch.setattr(agent._background_tasks, "_await_next_settlement", gated_wait)
    invocation = asyncio.create_task(agent.invoke_async("Start"))
    try:
        await asyncio.wait_for(waiting.wait(), 5)
        release.set()
        await agent._background_tasks._manager.wait_for_idle(timeout=5)
        agent.send("Update")
        continue_wait.set()
        await asyncio.wait_for(invocation, 5)
        assert len(_deliveries(agent.messages)) == 2
        user_text = [message["content"] for message in agent.messages if message["role"] == "user"]
        assert user_text[-1] == [{"text": "Update"}]
    finally:
        release.set()
        continue_wait.set()
        invocation.cancel()
        await asyncio.gather(invocation, return_exceptions=True)


@pytest.mark.asyncio
async def test_background_interrupt_preserves_queued_input(monkeypatch):
    release = asyncio.Event()
    waiting = asyncio.Event()
    continue_wait = asyncio.Event()

    @tool(context=True)
    async def work(tool_context: ToolContext) -> str:
        """Request approval."""
        await release.wait()
        return tool_context.interrupt("approval", reason="Continue?")

    agent = Agent(
        model=MockedModelProvider(
            [
                _assistant_tool_use(work.tool_name, "work", {}),
                _assistant_text("Waiting"),
                _assistant_text("Resumed"),
                _assistant_text("Finished"),
            ]
        ),
        tools=[work],
        background_tasks={"always": [work], "wake_on_input": True},
        callback_handler=None,
    )
    original = agent._background_tasks._await_next_settlement

    async def gated_wait(tasks):
        waiting.set()
        await continue_wait.wait()
        await original(tasks)

    monkeypatch.setattr(agent._background_tasks, "_await_next_settlement", gated_wait)
    invocation = asyncio.create_task(agent.invoke_async("Start"))
    try:
        await asyncio.wait_for(waiting.wait(), 5)
        release.set()
        [task] = await agent._background_tasks._manager.list()
        await agent._background_tasks._manager.wait(task["task_id"])
        agent.send("Additional constraint")
        continue_wait.set()
        result = await asyncio.wait_for(invocation, 5)
        assert result.stop_reason == "interrupt"
        assert agent._inbox.has_messages()
        result = await agent.invoke_async(
            [
                {"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "approved"}},
            ]
        )
        assert result.stop_reason == "end_turn"
        assert not agent._inbox.has_messages()
        assert len(_deliveries(agent.messages)) == 1
    finally:
        release.set()
        continue_wait.set()
        invocation.cancel()
        await asyncio.gather(invocation, return_exceptions=True)
