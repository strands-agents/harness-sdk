import asyncio

import pytest

from strands import Agent, ToolContext, tool
from tests.fixtures.mocked_model_provider import MockedModelProvider
from tests.strands.background_tasks.in_process.test_manager import _create_fixture, _submit
from tests.strands.background_tasks.test_background_tasks import (
    _assistant_text,
    _assistant_tool_use,
    _deliveries,
    _invoke_management_tool,
)


@pytest.mark.asyncio
async def test_get_history_is_opt_in_bounded_incremental_and_not_persisted():
    ready = asyncio.Event()
    release = asyncio.Event()

    @tool(context=True)
    async def work(tool_context: ToolContext) -> str:
        """Report activity while waiting for new instructions."""
        for index in range(110):
            tool_context.report_progress(f"Update {index}")
        ready.set()
        await release.wait()
        return "finished"

    agent = Agent(
        model=MockedModelProvider(
            [
                _assistant_tool_use(work.tool_name, "work-use", {}),
                _assistant_text("Dispatched"),
                _assistant_text("Result received"),
            ]
        ),
        tools=[work],
        background_tasks={"always": [work], "wait_for_completion": False},
        callback_handler=None,
    )
    try:
        await agent.invoke_async("Start")
        await asyncio.wait_for(ready.wait(), 5)
        [task] = await agent._background_tasks._manager.list()
        task_id = task["task_id"]
        compact = await _invoke_management_tool(agent, {"mode": "get", "task_id": task_id})
        assert "activity" not in compact["content"][0]["json"]
        detailed = await _invoke_management_tool(
            agent,
            {
                "mode": "get",
                "task_id": task_id,
                "include_history": True,
            },
        )
        history = detailed["content"][0]["json"]["activity"]
        tru_sequence = [event["sequence"] for event in history["events"]]
        exp_sequence = list(range(13, 113))
        assert tru_sequence == exp_sequence
        assert history["truncated"] is True
        assert history["first_available_sequence"] == 13
        assert history["last_sequence"] == 112
        assert history["events"][-1]["message"] == "Update 109"
        assert all(event["timestamp"].endswith("Z") for event in history["events"])
        incremental = await _invoke_management_tool(
            agent,
            {
                "mode": "get",
                "task_id": task_id,
                "include_history": True,
                "after_sequence": 111,
            },
        )
        tru_history = incremental["content"][0]["json"]["activity"]
        exp_history = {
            "events": [history["events"][-1]],
            "first_available_sequence": 13,
            "last_sequence": 112,
            "truncated": False,
        }
        assert tru_history == exp_history
        empty = await _invoke_management_tool(
            agent,
            {
                "mode": "get",
                "task_id": task_id,
                "include_history": True,
                "after_sequence": 112,
            },
        )
        assert empty["content"][0]["json"]["activity"]["events"] == []
        assert "activity" not in agent.state.get("strands.background_tasks")[0]
        assert "activity" not in agent._background_tasks._task_snapshots()[0]

        restored = Agent(model=MockedModelProvider([]), background_tasks={}, callback_handler=None)
        restored.load_snapshot(agent.take_snapshot(preset="session"))
        restored_get = await _invoke_management_tool(restored, {"mode": "get", "task_id": task_id})
        assert restored_get["status"] == "success"
        unavailable = await _invoke_management_tool(
            restored,
            {
                "mode": "get",
                "task_id": task_id,
                "include_history": True,
            },
        )
        assert unavailable["status"] == "error"
        assert "unavailable" in str(unavailable)

        release.set()
        await agent._background_tasks._manager.wait(task_id)
        terminal = await _invoke_management_tool(
            agent,
            {
                "mode": "get",
                "task_id": task_id,
                "include_history": True,
                "after_sequence": 112,
            },
        )
        [completed] = terminal["content"][0]["json"]["activity"]["events"]
        assert completed["type"] == "lifecycle"
        assert completed["message"] == "completed"
        await agent.invoke_async("Continue")
        assert len(_deliveries(agent.messages)) == 1
        for message in agent.messages:
            for block in message["content"]:
                if "toolResult" in block:
                    assert all("activity" not in content.get("json", {}) for content in block["toolResult"]["content"])
        assert await agent._background_tasks._manager.get(task_id, include_history=True) is None
    finally:
        release.set()
        await agent._background_tasks._manager.wait_for_idle(timeout=5)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options",
    [
        {"mode": "get", "after_sequence": 1},
        {"mode": "list", "include_history": True},
        {"mode": "cancel", "include_history": True},
        {"mode": "message", "after_sequence": 1},
    ],
)
async def test_manage_rejects_history_options_outside_history_get(options):
    agent = Agent(model=MockedModelProvider([]), background_tasks={}, callback_handler=None)
    result = await _invoke_management_tool(agent, options)
    assert result["status"] == "error"
    assert "history" in str(result).lower()


@pytest.mark.asyncio
async def test_threaded_reporters_preserve_sequences_and_snapshot_isolation():
    release = asyncio.Event()
    ready = asyncio.Event()

    async def callback(_, context):
        await asyncio.gather(*[asyncio.to_thread(context.report_progress, f"Worker {index}") for index in range(20)])
        ready.set()
        await release.wait()
        return "done"

    fixture = _create_fixture(callback)
    task = await _submit(fixture.manager, fixture.work, "threaded")
    task_id = task["task_id"]
    try:
        await asyncio.wait_for(ready.wait(), 5)
        snapshot = await fixture.manager.get(task_id, include_history=True)
        history = snapshot["activity"]
        tru_sequence = [event["sequence"] for event in history["events"]]
        exp_sequence = list(range(1, 23))
        assert tru_sequence == exp_sequence
        assert {event["message"] for event in history["events"][2:]} == {f"Worker {index}" for index in range(20)}
        history["events"][0]["message"] = "changed by caller"
        fresh = await fixture.manager.get(task_id, include_history=True)
        assert fresh["activity"]["events"][0]["message"] == "queued"
        assert "activity" not in (await fixture.manager.list())[0]
    finally:
        release.set()
        await fixture.manager.wait_for_idle(timeout=5)
