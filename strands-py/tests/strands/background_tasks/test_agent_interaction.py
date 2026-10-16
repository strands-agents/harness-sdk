"""Background agent-as-tool progress and messaging behavior."""

import asyncio
import threading

import pytest

from strands import Agent, tool
from strands.types._events import ToolResultEvent
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _tool_call(name: str, tool_use_id: str, tool_input: dict[str, object]) -> dict[str, object]:
    return {
        "role": "assistant",
        "content": [{"toolUse": {"name": name, "toolUseId": tool_use_id, "input": tool_input}}],
    }


def _answer(text: str) -> dict[str, object]:
    return {"role": "assistant", "content": [{"text": text}]}


async def _manage(
    agent: Agent,
    mode: str,
    task_id: str,
    message: str | None = None,
    *,
    include_history: bool = False,
    after_sequence: int | None = None,
) -> ToolResult:
    tool_input: dict[str, object] = {"mode": mode, "task_id": task_id}
    if message is not None:
        tool_input["message"] = message
    if include_history:
        tool_input["include_history"] = True
    if after_sequence is not None:
        tool_input["after_sequence"] = after_sequence
    tool_use: ToolUse = {
        "name": "strands_manage_background_task",
        "toolUseId": f"manage-{mode}",
        "input": tool_input,
    }
    result: ToolResult | None = None
    manage_tool = agent.tool_registry.registry["strands_manage_background_task"]
    async for event in manage_tool.stream(tool_use, {"agent": agent}):
        if isinstance(event, ToolResultEvent):
            result = event.tool_result
    assert result is not None
    return result


@pytest.mark.asyncio
async def test_running_background_child_reports_progress_and_receives_message() -> None:
    started = threading.Event()
    release = threading.Event()

    @tool(name="hold")
    async def hold() -> str:
        """Wait for the parent to send an updated instruction."""
        started.set()
        await asyncio.to_thread(release.wait)
        return "finished"

    child = Agent(
        model=MockedModelProvider([_tool_call("hold", "hold-use", {}), _answer("child finished")]),
        tools=[hold],
        callback_handler=None,
    )
    child_tool = child.as_tool(name="child", preserve_context=True)
    parent = Agent(
        model=MockedModelProvider(
            [
                _tool_call("child", "child-use", {"input": "start", "_background_execution": True}),
                _answer("waiting"),
                _answer("child result received"),
            ]
        ),
        tools=[child_tool],
        background_tasks={"agentic": ["child"]},
        callback_handler=None,
    )

    invocation = asyncio.create_task(parent.invoke_async("begin"))
    try:
        assert await asyncio.to_thread(started.wait, 5)
        task_id = parent.state.get("strands.background_tasks")[0]["task_id"]

        for _ in range(100):
            status = await _manage(parent, "get", task_id, include_history=True)
            if "progress" in status["content"][0]["json"]:
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("Child progress was not published")

        snapshot = status["content"][0]["json"]
        assert "hold" in str(snapshot["progress"])
        activity = snapshot["activity"]
        tool_requests = [event for event in activity["events"] if event["type"] == "tool_request"]
        assert [(event["type"], event["message"]) for event in tool_requests] == [("tool_request", "hold: requested")]
        request_sequence = tool_requests[0]["sequence"]
        later = await _manage(parent, "get", task_id, include_history=True, after_sequence=request_sequence)
        assert later["content"][0]["json"]["activity"]["events"] == []
        sent = await _manage(parent, "message", task_id, "Also check the new constraint")
        assert sent["status"] == "success"
    finally:
        release.set()

    result = await asyncio.wait_for(invocation, 5)
    assert result.stop_reason == "end_turn"
    assert any(
        message["role"] == "user"
        and any(block.get("text") == "Also check the new constraint" for block in message["content"])
        for message in child.messages
    )
