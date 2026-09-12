from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import ANY, AsyncMock

import pytest

from strands import Agent, ToolContext, tool
from strands._middleware.stages import ExecuteToolStage, InvokeModelStage
from strands.hooks import AfterToolCallEvent, AgentInitializedEvent, BeforeToolCallEvent
from strands.interrupt import Interrupt
from strands.tools.tools import PythonAgentTool
from strands.types._events import ToolResultEvent
from strands.types.content import Messages
from strands.types.tools import ToolResult, ToolSpec, ToolUse
from tests.fixtures.mocked_model_provider import MockedModelProvider

_BACKGROUND_TASKS_STATE_KEY = "strands.background_tasks"
_MANAGE_TOOL_NAME = "strands_manage_background_task"
_RESULT_TOOL_NAME = "strands_background_task_result"


def _assistant_text(text: str) -> dict[str, Any]:
    return {"role": "assistant", "content": [{"text": text}]}


def _assistant_tool_use(tool_name: str, tool_use_id: str, tool_input: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": [{"toolUse": {"name": tool_name, "toolUseId": tool_use_id, "input": tool_input}}],
    }


def _deliveries(messages: Messages) -> list[ToolUse]:
    return [
        block["toolUse"]
        for message in messages
        for block in message["content"]
        if "toolUse" in block and block["toolUse"]["name"] == _RESULT_TOOL_NAME
    ]


def _persisted_tasks(agent: Agent) -> list[dict[str, Any]] | None:
    return agent.state.get(_BACKGROUND_TASKS_STATE_KEY)


async def _wait_for_task_status(agent: Agent, status: str) -> None:
    while True:
        tasks = _persisted_tasks(agent)
        if tasks is not None and tasks[0]["status"] == status:
            return
        await asyncio.sleep(0)


def _schema_properties(spec: ToolSpec) -> dict[str, Any]:
    return spec["inputSchema"]["json"]["properties"]


async def _invoke_management_tool(agent: Agent, tool_input: dict[str, Any]) -> ToolResult:
    # Direct tool calls are refused while the agent is interrupted, so stream the tool itself.
    management_tool = agent.tool_registry.registry[_MANAGE_TOOL_NAME]
    tool_use: ToolUse = {"name": _MANAGE_TOOL_NAME, "toolUseId": "management-use", "input": tool_input}
    result: ToolResult | None = None
    async for event in management_tool.stream(tool_use, {"agent": agent}):
        if isinstance(event, ToolResultEvent):
            result = event.tool_result
    assert result is not None
    return result


def _tool_result(agent: Agent, tool_use_id: str) -> ToolResult:
    return next(
        block["toolResult"]
        for message in agent.messages
        for block in message["content"]
        if "toolResult" in block and block["toolResult"]["toolUseId"] == tool_use_id
    )


def _delivered_result(agent: Agent) -> ToolResult:
    [delivery] = _deliveries(agent.messages)
    return _tool_result(agent, delivery["toolUseId"])


def _unselectable_tool(tool_name: str) -> PythonAgentTool:
    spec: ToolSpec = {
        "name": tool_name,
        "description": "Composite schema cannot take the selection flag.",
        "inputSchema": {"json": {"anyOf": [{"type": "object"}, {"type": "string"}]}},
    }
    return PythonAgentTool(tool_name, spec, lambda tool_use, **kwargs: {"status": "success", "content": []})


def _conflicting_tool(tool_name: str) -> PythonAgentTool:
    spec: ToolSpec = {
        "name": tool_name,
        "description": "Schema already declares the reserved selection flag.",
        "inputSchema": {"json": {"type": "object", "properties": {"_background_execution": {"type": "boolean"}}}},
    }
    return PythonAgentTool(tool_name, spec, lambda tool_use, **kwargs: {"status": "success", "content": []})


def _capture_tool_specs(agent: Agent) -> list[list[ToolSpec]]:
    captured: list[list[ToolSpec]] = []

    async def capture(context: Any, next_fn: Any) -> AsyncGenerator[Any, None]:
        captured.append(context.tool_specs)
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    return captured


def _background_agent(
    *tools: Any, responses: list[dict[str, Any]], callback_handler: Any = None, **config: Any
) -> Agent:
    """Build an agent whose model dispatches ``tools[0]`` to the background, then replies with ``responses``."""
    dispatch = _assistant_tool_use(tools[0].tool_name, "work-use", {"_background_execution": True})
    return Agent(
        model=MockedModelProvider([dispatch, *responses]),
        tools=list(tools),
        background_tasks=config,
        callback_handler=callback_handler,
    )


@tool(name="work")
def work() -> str:
    """Perform work."""
    return "done"


@pytest.mark.parametrize(("background_tasks", "enabled"), [(None, False), (True, True), ({}, True)])
def test__init__registers_management_tool_only_when_enabled(background_tasks: Any, enabled: bool) -> None:
    agent = Agent(model=MockedModelProvider([]), background_tasks=background_tasks, callback_handler=None)
    assert (_MANAGE_TOOL_NAME in agent.tool_registry.registry) is enabled


@pytest.mark.parametrize(
    ("tools", "config", "message"),
    [
        ([work], {"always": [work], "never": [work]}, "Tool 'work' cannot be configured as both 'always' and 'never'"),
        (
            [tool(name="summarize_context")(lambda: None)],
            {"always": ["summarize_context"]},
            "Tool 'summarize_context' cannot run in the background",
        ),
        (
            [_unselectable_tool("custom")],
            {"agentic": ["custom"]},
            "Tool 'custom' cannot use agentic background selection",
        ),
        (
            [_conflicting_tool("custom")],
            {},
            "Tool 'custom' declares reserved parameter '_background_execution'",
        ),
        (
            [_conflicting_tool("custom")],
            {"never": ["custom"]},
            "Tool 'custom' declares reserved parameter '_background_execution'",
        ),
        (
            [tool(name="summarize_context")(lambda: None), _unselectable_tool("custom")],
            {"always": ["summarize_context"], "agentic": ["custom"]},
            "^Tool 'summarize_context' cannot run in the background; "
            "Tool 'custom' cannot use agentic background selection$",
        ),
    ],
)
def test__init__rejects_invalid_policies(tools: list[Any], config: dict[str, Any], message: str) -> None:
    with pytest.raises(TypeError, match=message):
        Agent(model=MockedModelProvider([]), tools=tools, background_tasks=config, callback_handler=None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("policy", "late_tool"),
    [
        ("summarize_context", tool(name="summarize_context")(lambda: None)),
        ("custom", _unselectable_tool("custom")),
    ],
)
async def test_rejects_exact_agentic_policy_on_tool_registered_after_init(policy: str, late_tool: Any) -> None:
    agent = Agent(model=MockedModelProvider([]), background_tasks={"agentic": [policy]}, callback_handler=None)
    agent.tool_registry.register_tool(late_tool)

    with pytest.raises(TypeError, match=f"Tool '{policy}' cannot use agentic background selection"):
        await agent.invoke_async("Run.")


@pytest.mark.asyncio
async def test_rejects_reserved_parameter_on_tool_registered_after_init() -> None:
    agent = Agent(model=MockedModelProvider([]), background_tasks=True, callback_handler=None)
    agent.tool_registry.register_tool(_conflicting_tool("custom"))

    with pytest.raises(TypeError, match="Tool 'custom' declares reserved parameter '_background_execution'"):
        await agent.invoke_async("Run.")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_input", "message"),
    [
        ({"mode": "get"}, "Task ID is required for mode 'get'"),
        ({"mode": "cancel", "task_id": "missing"}, "Background task 'missing' was not found"),
    ],
)
async def test_management_tool_rejects_missing_or_unknown_task(tool_input: dict[str, Any], message: str) -> None:
    agent = Agent(model=MockedModelProvider([]), background_tasks={}, callback_handler=None)

    tru_result = await _invoke_management_tool(agent, tool_input)
    exp_result = {"toolUseId": "management-use", "status": "error", "content": [{"text": ANY}]}
    assert tru_result == exp_result
    assert message in tru_result["content"][0]["text"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "tool_input", "message"),
    [
        ("work", {"_background_execution": "yes"}, "'_background_execution' must be a boolean"),
        ("missing", {"_background_execution": True}, "Unknown tool: missing"),
    ],
)
async def test_runs_rejected_selection_in_the_foreground(
    tool_name: str, tool_input: dict[str, Any], message: str
) -> None:
    agent = Agent(
        model=MockedModelProvider([_assistant_tool_use(tool_name, "use", tool_input), _assistant_text("Done.")]),
        tools=[work],
        background_tasks={},
        callback_handler=None,
    )

    await agent.invoke_async("Run.")

    tru_result = _tool_result(agent, "use")
    exp_result = {"toolUseId": "use", "status": "error", "content": [{"text": message}]}
    assert tru_result == exp_result
    assert _persisted_tasks(agent) is None


@pytest.mark.asyncio
async def test_reports_admission_failure_as_tool_error() -> None:
    agent = _background_agent(work, responses=[_assistant_text("Failed.")])
    agent._background_tasks._manager.submit = AsyncMock(side_effect=RuntimeError("runtime unavailable"))

    await agent.invoke_async("Run work.")

    tru_result = _tool_result(agent, "work-use")
    exp_result = {"toolUseId": "work-use", "status": "error", "content": [{"text": "Background task admission failed"}]}
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_fails_task_when_middleware_substitutes_foreground_only_tool() -> None:
    @tool(name="foreground")
    def foreground() -> str:
        """Never runs in the background."""
        return "foreground"

    agent = _background_agent(
        work,
        foreground,
        responses=[_assistant_text("Task admitted."), _assistant_text("Result received.")],
        never=[foreground],
    )

    async def substitute(context: Any, next_fn: Any) -> AsyncGenerator[Any, None]:
        context.tool = foreground
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, substitute)

    await agent.invoke_async("Run work.")

    tru_result = _delivered_result(agent)
    exp_result = {"toolUseId": ANY, "status": "error", "content": [{"text": "Tool cannot run in the background"}]}
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_fails_task_when_middleware_drops_tool_result() -> None:
    agent = _background_agent(work, responses=[_assistant_text("Task admitted."), _assistant_text("Result received.")])

    async def swallow(context: Any, next_fn: Any) -> AsyncGenerator[Any, None]:
        async for _ in next_fn(context):
            pass
        return
        yield

    agent._middleware_registry.add_middleware(ExecuteToolStage, swallow)

    await agent.invoke_async("Run work.")

    tru_result = _delivered_result(agent)
    exp_result = {"toolUseId": ANY, "status": "error", "content": [{"text": ANY}]}
    assert tru_result == exp_result
    assert "did not yield a ToolResultEvent" in tru_result["content"][0]["text"]


@pytest.mark.asyncio
async def test_streams_background_tool_events_to_callback_handler() -> None:
    @tool(name="progress")
    async def progress() -> AsyncGenerator[str, None]:
        """Report progress, then finish."""
        yield "halfway"
        yield "done"

    callbacks: list[dict[str, Any]] = []
    agent = _background_agent(
        progress,
        responses=[_assistant_text("Task admitted."), _assistant_text("Result received.")],
        callback_handler=lambda **kwargs: callbacks.append(kwargs),
    )

    await agent.invoke_async("Run progress.")

    tru_stream_data = [
        callback["tool_stream_event"]["data"] for callback in callbacks if "tool_stream_event" in callback
    ]
    exp_stream_data = ["halfway", "done"]
    assert tru_stream_data == exp_stream_data


@pytest.mark.asyncio
async def test_surfaces_and_resumes_interrupts_raised_by_background_tools() -> None:
    responses: list[str] = []

    @tool(name="approval", context=True)
    def approval(tool_context: ToolContext) -> str:
        """Ask before finishing."""
        responses.append(tool_context.interrupt("approve", reason="Approve work?"))
        return "approved"

    agent = _background_agent(
        approval,
        responses=[
            _assistant_text("Task admitted."),
            _assistant_text("Task resumed."),
            _assistant_text("Result received."),
        ],
    )

    interrupted = await agent.invoke_async("Run approval.")
    tru_stop_reason = interrupted.stop_reason
    exp_stop_reason = "interrupt"
    assert tru_stop_reason == exp_stop_reason

    await agent.invoke_async([{"interruptResponse": {"interruptId": interrupted.interrupts[0].id, "response": "yes"}}])

    tru_responses = responses
    exp_responses = ["yes"]
    assert tru_responses == exp_responses
    tru_result = _delivered_result(agent)
    exp_result = {"toolUseId": ANY, "status": "success", "content": [{"text": "approved"}]}
    assert tru_result == exp_result


@pytest.mark.asyncio
async def test_dispatches_selected_calls_through_tool_pipeline_and_delivers_results() -> None:
    @tool(name="work")
    def work(value: str) -> str:
        """Perform work."""
        return f"done:{value}"

    model = MockedModelProvider(
        [
            _assistant_tool_use("work", "work-use", {"value": "background", "_background_execution": True}),
            _assistant_text("Task admitted."),
            _assistant_text("Result received."),
        ]
    )
    agent = Agent(model=model, tools=[work], background_tasks={"agentic": [work]}, callback_handler=None)
    tool_specs = _capture_tool_specs(agent)
    middleware_calls = 0
    retried = False

    def retry_once(event: AfterToolCallEvent) -> None:
        nonlocal retried
        if not retried:
            retried = True
            event.retry = True

    async def count_execution(context: Any, next_fn: Any) -> AsyncGenerator[Any, None]:
        nonlocal middleware_calls
        middleware_calls += 1
        async for event in next_fn(context):
            yield event

    agent.add_hook(retry_once, AfterToolCallEvent)
    agent._middleware_registry.add_middleware(ExecuteToolStage, count_execution)

    result = await agent.invoke_async("Run work.")

    tru_middleware_calls = middleware_calls
    exp_middleware_calls = 2
    assert tru_middleware_calls == exp_middleware_calls

    tru_metrics = (result.metrics.tool_metrics["work"].call_count, result.metrics.tool_metrics["work"].success_count)
    exp_metrics = (2, 2)
    assert tru_metrics == exp_metrics

    work_spec = next(spec for spec in tool_specs[0] if spec["name"] == "work")
    assert "_background_execution" in _schema_properties(work_spec)

    tru_requested_input = agent.messages[1]["content"][0]["toolUse"]["input"]
    exp_requested_input = {"value": "background", "_background_execution": True}
    assert tru_requested_input == exp_requested_input

    tru_deliveries = _deliveries(agent.messages)
    exp_deliveries = [{"name": _RESULT_TOOL_NAME, "toolUseId": ANY, "input": {"tool_name": "work"}}]
    assert tru_deliveries == exp_deliveries

    tru_result = _delivered_result(agent)
    exp_result = {"toolUseId": ANY, "status": "success", "content": [{"text": "done:background"}]}
    assert tru_result == exp_result
    assert _persisted_tasks(agent) is None


@pytest.mark.asyncio
async def test_applies_always_and_never_policies_per_tool() -> None:
    executions: list[str] = []
    seen_inputs: list[dict[str, Any]] = []

    @tool(name="background", context=True)
    def background(tool_context: ToolContext) -> None:
        """Run in the background."""
        seen_inputs.append(tool_context.tool_use["input"])
        executions.append("background")

    @tool(name="foreground", context=True)
    def foreground(tool_context: ToolContext) -> None:
        """Run in the foreground."""
        seen_inputs.append(tool_context.tool_use["input"])
        executions.append("foreground")

    @tool(name="summarize_context")
    def incompatible() -> None:
        """Cannot run in the background."""
        executions.append("incompatible")

    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "name": "foreground",
                            "toolUseId": "background-use",
                            "input": {"_background_execution": False},
                        }
                    },
                    {
                        "toolUse": {
                            "name": "foreground",
                            "toolUseId": "foreground-use",
                            "input": {"_background_execution": True},
                        }
                    },
                    {"toolUse": {"name": "foreground", "toolUseId": "incompatible-use", "input": {}}},
                ],
            },
            _assistant_text("Task admitted."),
            _assistant_text("Result received."),
        ]
    )
    agent = Agent(
        model=model,
        tools=[background, foreground],
        background_tasks={"always": [background, incompatible], "never": ["*"]},
        callback_handler=None,
    )
    tool_specs = _capture_tool_specs(agent)

    def swap_tools(event: BeforeToolCallEvent) -> None:
        if event.tool_use["toolUseId"] == "background-use":
            event.tool_use["name"] = "background"
        if event.tool_use["toolUseId"] == "incompatible-use":
            event.selected_tool = incompatible

    agent.add_hook(swap_tools, BeforeToolCallEvent)

    await agent.invoke_async("Run both.")

    tru_executions = sorted(executions)
    exp_executions = ["background", "foreground"]
    assert tru_executions == exp_executions

    tru_inputs = seen_inputs
    exp_inputs = [{}, {}]
    assert tru_inputs == exp_inputs

    tru_deliveries = _deliveries(agent.messages)
    exp_deliveries = [{"name": _RESULT_TOOL_NAME, "toolUseId": ANY, "input": {"tool_name": "background"}}]
    assert tru_deliveries == exp_deliveries

    tru_incompatible_result = _tool_result(agent, "incompatible-use")
    exp_incompatible_result = {
        "toolUseId": "incompatible-use",
        "status": "error",
        "content": [{"text": "Tool 'foreground' cannot run in the background"}],
    }
    assert tru_incompatible_result == exp_incompatible_result

    for tool_name in ("background", "foreground"):
        tool_spec = next(spec for spec in tool_specs[0] if spec["name"] == tool_name)
        assert "_background_execution" not in _schema_properties(tool_spec)


@pytest.mark.asyncio
async def test_delivers_work_that_finishes_between_invocations() -> None:
    released = asyncio.Event()

    @tool(name="work")
    async def work() -> str:
        """Perform deferred work."""
        await released.wait()
        return "done"

    agent = Agent(
        model=MockedModelProvider(
            [
                _assistant_tool_use("work", "work-use", {"_background_execution": True}),
                _assistant_text("Task admitted."),
            ]
        ),
        tools=[work],
        background_tasks={"wait_for_completion": False, "max_concurrency": 1, "timeout": 5},
        callback_handler=None,
    )

    await agent.invoke_async("Run work.")
    tru_deliveries = _deliveries(agent.messages)
    exp_deliveries: list[ToolUse] = []
    assert tru_deliveries == exp_deliveries
    with pytest.raises(RuntimeError, match="Cannot load a snapshot while background tasks are still tracked"):
        agent.load_snapshot(agent.take_snapshot(include=["state"]))

    released.set()
    await asyncio.wait_for(_wait_for_task_status(agent, "completed"), timeout=1)

    tru_tasks = _persisted_tasks(agent)
    exp_tasks = [
        {
            "task_id": ANY,
            "tool_use_id": "work-use",
            "tool_name": "work",
            "status": "completed",
            "created_at": ANY,
            "last_updated_at": ANY,
            "result": {"content": [{"text": "done"}]},
        }
    ]
    assert tru_tasks == exp_tasks

    snapshot = agent.take_snapshot(preset="session")
    restored = Agent(
        model=MockedModelProvider([_assistant_text("Result received.")]),
        background_tasks={},
        callback_handler=None,
    )
    restored.load_snapshot(snapshot)
    await restored.invoke_async("Continue.")

    tru_delivery_count = len(_deliveries(restored.messages))
    exp_delivery_count = 1
    assert tru_delivery_count == exp_delivery_count
    assert _persisted_tasks(restored) is None


def test_sync_background_work_survives_between_invocations() -> None:
    released = threading.Event()

    @tool(name="work")
    async def work() -> str:
        """Perform deferred work."""
        while not released.is_set():
            await asyncio.sleep(0)
        return "done"

    agent = Agent(
        model=MockedModelProvider(
            [
                _assistant_tool_use("work", "work-use", {"_background_execution": True}),
                _assistant_text("Task admitted."),
                _assistant_text("Result received."),
            ]
        ),
        tools=[work],
        background_tasks={"wait_for_completion": False},
        callback_handler=None,
    )

    agent("Run work.")
    assert _deliveries(agent.messages) == []

    released.set()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        tasks = _persisted_tasks(agent)
        if tasks is not None and tasks[0]["status"] == "completed":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("Background task did not complete")

    agent("Continue.")
    tru_delivery_count = len(_deliveries(agent.messages))
    exp_delivery_count = 1
    assert tru_delivery_count == exp_delivery_count
    assert _persisted_tasks(agent) is None


@pytest.mark.asyncio
async def test_load_state_fails_restored_non_terminal_work() -> None:
    created_at = "2026-08-27T12:00:00Z"
    source = Agent(model=MockedModelProvider([]), callback_handler=None)
    interrupt = Interrupt(id="v1:tool_call:working-use:approve", name="approve", reason="Approve restored work?")
    source.state.set(
        _BACKGROUND_TASKS_STATE_KEY,
        [
            {
                "task_id": "working",
                "tool_use_id": "working-use",
                "tool_name": "working-work",
                "status": "input_required",
                "created_at": created_at,
                "last_updated_at": created_at,
                "interrupts": [
                    {"id": interrupt.id, "name": interrupt.name, "reason": interrupt.reason, "source": "tool"}
                ],
            }
        ],
    )
    source._interrupt_state.interrupts[interrupt.id] = interrupt
    source._interrupt_state.activate()
    snapshot = source.take_snapshot(preset="session")

    def load_snapshot(event: AgentInitializedEvent) -> None:
        event.agent.load_snapshot(snapshot)

    agent = Agent(
        model=MockedModelProvider([_assistant_text("Results received.")]),
        background_tasks={},
        hooks=[load_snapshot],
        callback_handler=None,
    )

    tru_task = next(task for task in _persisted_tasks(agent) or [] if task["task_id"] == "working")
    exp_task = {
        "task_id": "working",
        "tool_use_id": "working-use",
        "tool_name": "working-work",
        "status": "failed",
        "created_at": created_at,
        "last_updated_at": ANY,
        "error": {"type": "execution_error", "message": ANY},
    }
    assert tru_task == exp_task
    assert not agent._interrupt_state.activated

    tru_cancelled = await _invoke_management_tool(agent, {"mode": "cancel", "task_id": "working"})
    exp_cancelled = {
        "toolUseId": "management-use",
        "status": "success",
        "content": [{"json": {"task_id": "working", "status": "failed"}}],
    }
    assert tru_cancelled == exp_cancelled

    await agent.invoke_async("Continue.")

    tru_deliveries = _deliveries(agent.messages)
    exp_deliveries = [{"name": _RESULT_TOOL_NAME, "toolUseId": "working", "input": {"tool_name": "working-work"}}]
    assert tru_deliveries == exp_deliveries


@pytest.mark.asyncio
async def test_surfaces_and_resumes_interrupts_from_background_tools() -> None:
    blocked_started = asyncio.Event()

    @tool(name="approval")
    def approval() -> str:
        """Wait for approval."""
        return "approved"

    @tool(name="blocked", context=True)
    async def blocked(tool_context: ToolContext) -> str:
        """Wait for cancellation."""
        blocked_started.set()
        while not tool_context.cancel_signal.is_set():
            await asyncio.sleep(0)
        return "cancelled"

    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "name": "approval",
                            "toolUseId": "approval-use",
                            "input": {"_background_execution": True},
                        }
                    },
                    {
                        "toolUse": {
                            "name": "blocked",
                            "toolUseId": "blocked-use",
                            "input": {"_background_execution": True},
                        }
                    },
                ],
            },
            _assistant_text("Task admitted."),
            _assistant_text("Task resumed."),
            _assistant_text("Result received."),
        ]
    )
    agent = Agent(model=model, tools=[approval, blocked], background_tasks={}, callback_handler=None)
    tool_specs = _capture_tool_specs(agent)
    response: str | None = None

    async def interrupt_approval(context: Any, next_fn: Any) -> AsyncGenerator[Any, None]:
        nonlocal response
        if context.tool_use["name"] == "approval":
            response = context.interrupt("approve", reason="Approve work?").response
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, interrupt_approval)

    interrupted = await agent.invoke_async("Run approval.")
    tru_stop_reason = interrupted.stop_reason
    exp_stop_reason = "interrupt"
    assert tru_stop_reason == exp_stop_reason
    tru_interrupts = [
        {"id": interrupt.id, "name": interrupt.name, "reason": interrupt.reason} for interrupt in interrupted.interrupts
    ]
    exp_interrupts = [{"id": ANY, "name": "approve", "reason": "Approve work?"}]
    assert tru_interrupts == exp_interrupts

    await blocked_started.wait()
    management_spec = next(spec for spec in tool_specs[0] if spec["name"] == _MANAGE_TOOL_NAME)
    assert "_background_execution" not in _schema_properties(management_spec)

    blocked_task = next(task for task in _persisted_tasks(agent) or [] if task["tool_name"] == "blocked")
    tru_blocked = await _invoke_management_tool(agent, {"mode": "get", "task_id": blocked_task["task_id"]})
    exp_blocked = {
        "toolUseId": "management-use",
        "status": "success",
        "content": [
            {
                "json": {
                    "task_id": blocked_task["task_id"],
                    "tool_use_id": "blocked-use",
                    "tool_name": "blocked",
                    "status": "working",
                    "created_at": ANY,
                    "last_updated_at": ANY,
                }
            }
        ],
    }
    assert tru_blocked == exp_blocked

    tru_listing = await _invoke_management_tool(agent, {"mode": "list"})
    exp_listing = {
        "toolUseId": "management-use",
        "status": "success",
        "content": [
            {
                "json": {
                    "tasks": [
                        {"task_id": ANY, "tool_name": "approval", "status": "input_required"},
                        {"task_id": blocked_task["task_id"], "tool_name": "blocked", "status": "working"},
                    ]
                }
            }
        ],
    }
    assert tru_listing == exp_listing

    tru_cancelled = await _invoke_management_tool(agent, {"mode": "cancel", "task_id": blocked_task["task_id"]})
    exp_cancelled = {
        "toolUseId": "management-use",
        "status": "success",
        "content": [{"json": {"task_id": blocked_task["task_id"], "status": "cancelled"}}],
    }
    assert tru_cancelled == exp_cancelled

    await agent.invoke_async([{"interruptResponse": {"interruptId": interrupted.interrupts[0].id, "response": "yes"}}])

    tru_response = response
    exp_response = "yes"
    assert tru_response == exp_response
    tru_delivery_count = len(_deliveries(agent.messages))
    exp_delivery_count = 2
    assert tru_delivery_count == exp_delivery_count
    assert _persisted_tasks(agent) is None


def test_direct_tool_calls_run_in_the_foreground() -> None:
    agent = Agent(
        model=MockedModelProvider([]), tools=[work], background_tasks={"always": [work]}, callback_handler=None
    )

    tru_result = agent.tool.work(record_direct_tool_call=False)
    exp_result = {"toolUseId": ANY, "status": "success", "content": [{"text": "done"}]}
    assert tru_result == exp_result
    assert _persisted_tasks(agent) is None
