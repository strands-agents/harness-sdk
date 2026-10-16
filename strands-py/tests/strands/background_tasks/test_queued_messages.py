from __future__ import annotations

import asyncio
from typing import Any

import pytest

from strands import Agent, ToolContext, tool
from strands.types.content import Messages
from tests.fixtures.mocked_model_provider import MockedModelProvider
from tests.strands.background_tasks.test_background_tasks import (
    _assistant_text,
    _assistant_tool_use,
    _invoke_management_tool,
)

_MAX_PENDING_MESSAGES = 16
_MAX_PENDING_MESSAGE_BYTES = 64 * 1024


async def _wait_for_status(agent: Agent, task_id: str, status: str) -> None:
    while True:
        task = await agent._background_tasks._manager.get(task_id)
        if task is not None and task["status"] == status:
            return
        await asyncio.sleep(0)


async def _wait_for_undelivered_messages(agent: Agent, task_id: str, expected: dict[str, Any]) -> dict[str, Any]:
    while True:
        task = next((task for task in agent._background_tasks._task_snapshots() if task["task_id"] == task_id), None)
        if task is not None and task.get("undelivered_messages") == expected:
            return task
        await asyncio.sleep(0)


async def _dispatch_two(
    first_tool: Any,
    second_tool: Any,
    *,
    max_concurrency: int = 1,
) -> Agent:
    dispatch = _assistant_tool_use(first_tool.tool_name, "first-use", {"label": "first"})
    dispatch["content"].extend(_assistant_tool_use(second_tool.tool_name, "second-use", {"label": "second"})["content"])
    agent = Agent(
        model=MockedModelProvider([dispatch, _assistant_text("Dispatched")]),
        tools=list({tool.tool_name: tool for tool in (first_tool, second_tool)}.values()),
        background_tasks={
            "always": list({tool.tool_name: tool for tool in (first_tool, second_tool)}.values()),
            "wait_for_completion": False,
            "max_concurrency": max_concurrency,
        },
        callback_handler=None,
    )
    await agent.invoke_async("Start")
    return agent


def _task_for_use(agent: Agent, tool_use_id: str) -> dict[str, Any]:
    return next(task for task in agent._background_tasks._task_snapshots() if task["tool_use_id"] == tool_use_id)


@pytest.mark.asyncio
async def test_messages_queue_for_waiting_task_and_replay_before_direct_delivery() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_started = asyncio.Event()
    release_second = asyncio.Event()
    queued_delivered = asyncio.Event()
    received: list[str] = []

    @tool(context=True)
    async def work(tool_context: ToolContext, label: str) -> str:
        """Run one step of work."""
        if label == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        def receive(message: str, **kwargs: Any) -> None:
            received.append(message)
            if len(received) == 2:
                queued_delivered.set()

        unregister = tool_context.on_message(receive)
        second_started.set()
        try:
            await release_second.wait()
            return "second done"
        finally:
            unregister()

    agent = await _dispatch_two(work, work)
    try:
        await asyncio.wait_for(first_started.wait(), 5)
        second_task = _task_for_use(agent, "second-use")
        await asyncio.wait_for(_wait_for_status(agent, second_task["task_id"], "queued"), 5)

        tru_first_queued = await _invoke_management_tool(
            agent, {"mode": "message", "task_id": second_task["task_id"], "message": "first update"}
        )
        exp_first_queued = {
            "toolUseId": "management-use",
            "status": "success",
            "content": [{"json": {"task_id": second_task["task_id"], "message_queued": True, "status": "queued"}}],
        }
        assert tru_first_queued == exp_first_queued

        tru_second_queued = await _invoke_management_tool(
            agent, {"mode": "message", "task_id": second_task["task_id"], "message": "second update"}
        )
        assert tru_second_queued["status"] == "success"
        assert tru_second_queued["content"][0]["json"] == {
            "task_id": second_task["task_id"],
            "message_queued": True,
            "status": "queued",
        }

        release_first.set()
        await asyncio.wait_for(second_started.wait(), 5)
        await asyncio.wait_for(_wait_for_status(agent, second_task["task_id"], "working"), 5)
        await asyncio.wait_for(queued_delivered.wait(), 5)
        assert received == ["first update", "second update"]

        tru_direct = await _invoke_management_tool(
            agent, {"mode": "message", "task_id": second_task["task_id"], "message": "direct update"}
        )
        exp_direct = {
            "toolUseId": "management-use",
            "status": "success",
            "content": [{"json": {"task_id": second_task["task_id"], "message_sent": True}}],
        }
        assert tru_direct == exp_direct
        assert received == ["first update", "second update", "direct update"]
    finally:
        release_first.set()
        release_second.set()
        await agent._background_tasks._manager.wait_for_idle(timeout=5)


@pytest.mark.asyncio
async def test_pending_message_limits_and_completed_task_metadata() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_started = asyncio.Event()
    release_second = asyncio.Event()

    @tool(context=True)
    async def work(tool_context: ToolContext, label: str) -> str:
        """Wait for a deterministic test gate."""
        if label == "first":
            first_started.set()
            await release_first.wait()
        else:
            second_started.set()
            await release_second.wait()
        return "done"

    agent = await _dispatch_two(work, work)
    try:
        await asyncio.wait_for(first_started.wait(), 5)
        second_task = _task_for_use(agent, "second-use")
        await asyncio.wait_for(_wait_for_status(agent, second_task["task_id"], "queued"), 5)

        accepted = [
            await agent._background_tasks._manager.message(second_task["task_id"], f"update {index}")
            for index in range(_MAX_PENDING_MESSAGES)
        ]
        assert accepted == [True] * _MAX_PENDING_MESSAGES
        with pytest.raises(RuntimeError, match="message"):
            await agent._background_tasks._manager.message(second_task["task_id"], "over limit")

        release_first.set()
        await asyncio.wait_for(second_started.wait(), 5)
        release_second.set()
        await agent._background_tasks._manager.wait(second_task["task_id"])

        exp_undelivered = {"count": _MAX_PENDING_MESSAGES, "reason": "completed"}
        tru_snapshot = await asyncio.wait_for(
            _wait_for_undelivered_messages(agent, second_task["task_id"], exp_undelivered), 5
        )
        assert tru_snapshot["undelivered_messages"] == exp_undelivered

        tru_get = await _invoke_management_tool(agent, {"mode": "get", "task_id": second_task["task_id"]})
        assert tru_get["status"] == "success"
        assert tru_get["content"][0]["json"]["undelivered_messages"] == exp_undelivered

        tru_late_message = await _invoke_management_tool(
            agent, {"mode": "message", "task_id": second_task["task_id"], "message": "too late"}
        )
        assert tru_late_message["status"] == "error"
    finally:
        release_first.set()
        release_second.set()
        await agent._background_tasks._manager.wait_for_idle(timeout=5)


@pytest.mark.asyncio
async def test_pending_message_byte_limit_and_cancel_metadata() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_started = asyncio.Event()
    release_second = asyncio.Event()

    @tool(context=True)
    async def work(tool_context: ToolContext, label: str) -> str:
        """Wait for a deterministic test gate."""
        if label == "first":
            first_started.set()
            await release_first.wait()
        else:
            second_started.set()
            await release_second.wait()
        return "done"

    agent = await _dispatch_two(work, work)
    try:
        await asyncio.wait_for(first_started.wait(), 5)
        second_task = _task_for_use(agent, "second-use")
        await asyncio.wait_for(_wait_for_status(agent, second_task["task_id"], "queued"), 5)
        assert (
            await agent._background_tasks._manager.message(second_task["task_id"], "x" * _MAX_PENDING_MESSAGE_BYTES)
        ) is True
        with pytest.raises(RuntimeError, match="size|bytes|limit"):
            await agent._background_tasks._manager.message(second_task["task_id"], "y")

        tru_cancel = await _invoke_management_tool(agent, {"mode": "cancel", "task_id": second_task["task_id"]})
        assert tru_cancel["status"] == "success"
        await asyncio.wait_for(_wait_for_status(agent, second_task["task_id"], "cancelled"), 5)
        exp_undelivered = {"count": 1, "reason": "cancelled"}
        tru_snapshot = await asyncio.wait_for(
            _wait_for_undelivered_messages(agent, second_task["task_id"], exp_undelivered), 5
        )
        assert tru_snapshot["undelivered_messages"] == exp_undelivered
        tru_get = await _invoke_management_tool(agent, {"mode": "get", "task_id": second_task["task_id"]})
        assert tru_get["content"][0]["json"]["undelivered_messages"] == exp_undelivered

        release_first.set()
        assert not second_started.is_set()
    finally:
        release_first.set()
        release_second.set()
        await agent._background_tasks._manager.wait_for_idle(timeout=5)


@pytest.mark.asyncio
async def test_agent_as_tool_includes_pending_messages_in_first_model_input() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    first_child_call: list[Messages] = []
    child_model = MockedModelProvider([_assistant_text("child answer")])
    original_stream = child_model.stream

    async def record_first_input(messages: Messages, *args: Any, **kwargs: Any):
        if not first_child_call:
            first_child_call.append(messages)
        async for event in original_stream(messages, *args, **kwargs):
            yield event

    child_model.stream = record_first_input
    child = Agent(model=child_model, callback_handler=None)
    child_tool = child.as_tool(name="child")

    @tool
    async def blocker(label: str) -> str:
        """Hold the only background execution slot."""
        first_started.set()
        await release_first.wait()
        return "released"

    dispatch = _assistant_tool_use(blocker.tool_name, "blocker-use", {"label": "first"})
    dispatch["content"].extend(
        _assistant_tool_use(child_tool.tool_name, "child-use", {"input": "initial request"})["content"]
    )
    parent = Agent(
        model=MockedModelProvider([dispatch, _assistant_text("Dispatched")]),
        tools=[blocker, child_tool],
        background_tasks={"always": [blocker, child_tool], "wait_for_completion": False, "max_concurrency": 1},
        callback_handler=None,
    )

    try:
        await parent.invoke_async("Start")
        await asyncio.wait_for(first_started.wait(), 5)
        child_task = _task_for_use(parent, "child-use")
        await asyncio.wait_for(_wait_for_status(parent, child_task["task_id"], "queued"), 5)
        tru_queued = await _invoke_management_tool(
            parent, {"mode": "message", "task_id": child_task["task_id"], "message": "queued instruction"}
        )
        assert tru_queued["content"][0]["json"] == {
            "task_id": child_task["task_id"],
            "message_queued": True,
            "status": "queued",
        }

        release_first.set()
        await asyncio.wait_for(child_model_called(first_child_call), 5)
        assert len(first_child_call) == 1
        tru_user_text = [
            block["text"]
            for message in first_child_call[0]
            if message["role"] == "user"
            for block in message["content"]
            if "text" in block
        ]
        assert tru_user_text == ["initial request", "queued instruction"]
    finally:
        release_first.set()
        await parent._background_tasks._manager.wait_for_idle(timeout=5)


async def child_model_called(first_child_call: list[Messages]) -> bool:
    while not first_child_call:
        await asyncio.sleep(0)
    return True
