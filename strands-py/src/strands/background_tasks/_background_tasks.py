"""Background task policy, routing, persistence, and result delivery for one Agent."""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, TypeGuard

from .._middleware.stages import InvokeModelContext, InvokeModelStage
from ..agent import _continuation
from ..agent._agent_as_tool import _AgentAsTool
from ..agent.agent import _CANCEL_POLL_INTERVAL
from ..hooks import AfterInvocationEvent, AgentInitializedEvent, BeforeModelCallEvent, HookOrder
from ..interrupt import Interrupt, InterruptException
from ..models._validation import validate_config_keys
from ..plugins import Plugin
from ..tools.decorator import tool
from ..tools.executors._executor import _lookup_tool
from ..types.agent import LocalAgent
from ..types.content import Messages
from ..types.tools import AgentTool, ToolContext, ToolResult, ToolResultContent, ToolSpec, ToolUse
from ._errors import BackgroundTaskNotFoundError
from ._types import BackgroundTask, BackgroundTasksConfig, is_task_status_terminal
from .in_process._engine import _timestamp
from .in_process._manager import InProcessTaskManager, _MiddlewareInterrupt

if TYPE_CHECKING:
    from ..agent import Agent

logger = logging.getLogger(__name__)

_BACKGROUND_TASKS_STATE_KEY = "strands.background_tasks"
_BACKGROUND_PROPERTY = "_background_execution"
_MANAGE_TOOL_NAME = "strands_manage_background_task"
_RESULT_TOOL_NAME = "strands_background_task_result"
_COMPOSITE_SCHEMA_KEYS = {"$ref", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"}
_FOREGROUND_TOOL_NAMES = {
    _MANAGE_TOOL_NAME,
    "summarize_context",
    "truncate_context",
    "pin_context",
}
_BackgroundMode = Literal["never", "agentic", "always"]


@dataclass(frozen=True)
class _Policy:
    mode: _BackgroundMode
    # Whether the tool was named explicitly rather than matched by the "*" wildcard.
    exact: bool


class _BackgroundTasks(Plugin):
    """Connect background task policy and lifecycle to one Agent."""

    name = "strands:background-tasks"

    def __init__(self, config: BackgroundTasksConfig) -> None:
        """Initialize the plugin.

        Args:
            config: Background tool execution configuration.

        Raises:
            TypeError: If a tool is assigned conflicting execution modes.
        """
        validate_config_keys(config, BackgroundTasksConfig)
        self._config = config
        self._policy = _resolve_policy(config)
        self._agent: Agent
        self._manager: InProcessTaskManager
        # Snapshots are written from the background runtime thread and read from the agent loop.
        self._tasks: dict[str, BackgroundTask] = {}
        self._tasks_lock = threading.Lock()
        super().__init__()

    def init_agent(self, agent: Agent) -> None:
        """Validate exact policies, then attach the task manager, middleware, and lifecycle hooks.

        Raises:
            TypeError: If a tool declares the reserved ``_background_execution`` parameter or an explicitly
                configured tool cannot honor its execution mode. Every violation is reported in the one message.
        """
        self._agent = agent
        errors: list[str] = []
        for tool_instance in agent.tool_registry.registry.values():
            if _declares_background_property(tool_instance.tool_spec):
                errors.append(f"Tool '{tool_instance.tool_name}' declares reserved parameter '{_BACKGROUND_PROPERTY}'")
                continue
            policy = self._policy_for(tool_instance)
            if policy is None or not policy.exact or policy.mode == "never":
                continue
            rejection = self._rejection_reason(tool_instance, policy.mode)
            if rejection is not None:
                errors.append(f"Tool '{tool_instance.tool_name}' {rejection}")
        if errors:
            raise TypeError("; ".join(errors))

        async def execute_tool(
            selected_tool: AgentTool,
            context: ToolContext[LocalAgent],
            middleware_interrupt: _MiddlewareInterrupt,
        ) -> ToolResult:
            return await agent.tool_executor._execute_background(
                agent, selected_tool, context, middleware_interrupt, self.assert_tool_can_run
            )

        manager_options: dict[str, Any] = {}
        if "max_concurrency" in self._config:
            manager_options["max_concurrency"] = self._config["max_concurrency"]
        if "timeout" in self._config:
            manager_options["timeout"] = self._config["timeout"]
        self._manager = InProcessTaskManager(agent, execute_tool, on_task_updated=self._store_task, **manager_options)

        agent._middleware_registry.add_middleware(InvokeModelStage.Input, self._transform_tool_specs)
        agent.add_hook(self._before_model_call, BeforeModelCallEvent)
        agent.add_hook(self._after_invocation, AfterInvocationEvent)
        agent.add_hook(lambda event: self.load_state(), AgentInitializedEvent, order=HookOrder.SDK_LAST)

    @tool(
        name=_MANAGE_TOOL_NAME,
        description=(
            "List, inspect, or cancel background tasks. Completed results are delivered automatically; "
            "do not poll with this tool."
        ),
    )
    async def _manage_background_task(
        self, mode: Literal["list", "get", "cancel"], task_id: str | None = None
    ) -> dict[str, Any]:
        """Manage tracked background tasks.

        Args:
            mode: Whether to list, inspect, or cancel background tasks.
            task_id: The background task ID returned when the task was dispatched. Required for get and cancel.
        """
        if mode == "list":
            listing = [
                {"task_id": task["task_id"], "tool_name": task["tool_name"], "status": task["status"]}
                for task in self._task_snapshots()
            ]
            return _json_tool_result({"tasks": listing})
        if not task_id:
            raise TypeError(f"Task ID is required for mode '{mode}'")
        with self._tasks_lock:
            task = self._tasks.get(task_id)
        if task is None:
            raise BackgroundTaskNotFoundError(task_id)
        if mode == "get":
            return _json_tool_result(task)
        cancelled = task if is_task_status_terminal(task["status"]) else await self._manager.cancel(task_id)
        return _json_tool_result({"task_id": cancelled["task_id"], "status": cancelled["status"]})

    def route_tool_call(
        self,
        tool_use: ToolUse,
        requested_tool: AgentTool | None,
        effective_tool: AgentTool | None,
    ) -> Literal[True] | ToolResult | None:
        """Decide foreground versus background execution for one tool call.

        Strips ``_background_execution`` from ``tool_use["input"]`` so the tool never sees the
        selection flag.

        Returns:
            ``True`` to submit as a background task, an error ``ToolResult`` when admission is
            rejected, or ``None`` to run in the foreground.
        """
        selected = False
        tool_input = tool_use.get("input")
        if isinstance(tool_input, dict) and _BACKGROUND_PROPERTY in tool_input:
            stripped_input = dict(tool_input)
            value = stripped_input.pop(_BACKGROUND_PROPERTY)
            if not isinstance(value, bool):
                return _tool_error(tool_use, f"'{_BACKGROUND_PROPERTY}' must be a boolean")
            requested_policy = self._policy_for(requested_tool)
            if requested_policy is not None and requested_policy.mode == "agentic":
                selected = value
            tool_use["input"] = stripped_input

        policy = self._policy_for(effective_tool)
        if policy is None or policy.mode == "never":
            return None
        rejection = self._rejection_reason(effective_tool, policy.mode)
        if rejection is not None:
            return _tool_error(tool_use, f"Tool '{tool_use['name']}' {rejection}") if policy.exact else None
        return True if policy.mode == "always" or selected else None

    async def submit_tool_call(
        self,
        tool_use: ToolUse,
        invocation_state: dict[str, Any],
        pass_id: str,
        tool_instance: AgentTool,
    ) -> ToolResult:
        """Admit one background tool call and return its dispatch acknowledgement."""
        if self._agent.cancel_signal.is_set():
            return _tool_error(tool_use, "Tool execution cancelled")
        try:
            task = await self._manager.submit(tool_use, invocation_state, pass_id, tool_instance)
        except Exception as error:
            logger.warning("error=<%s> | background task admission failed", error)
            return _tool_error(tool_use, "Background task admission failed")
        acknowledgement = "\n".join(
            [
                "Background task dispatched.",
                "",
                f"Task ID: {task['task_id']}",
                f"Tool: {task['tool_name']}",
                f"Status: {task['status']}",
                "",
                "The task is running in the background. Continue without waiting or polling.",
                "The final result will be delivered automatically when the task completes.",
            ]
        )
        return {"toolUseId": tool_use["toolUseId"], "status": "success", "content": [{"text": acknowledgement}]}

    def assert_tool_can_run(self, tool_instance: AgentTool | None) -> None:
        """Reject a middleware-substituted tool that cannot run in the background.

        Raises:
            RuntimeError: If the tool is unknown, foreground-only, or configured as ``never``.
        """
        if not self._supports_background_execution(tool_instance):
            raise RuntimeError("Tool cannot run in the background")

    def assert_can_load_snapshot(self) -> None:
        """Reject state replacement while the manager still tracks tasks.

        Raises:
            RuntimeError: If any background task is still tracked.
        """
        if self._manager.has_tasks():
            raise RuntimeError("Cannot load a snapshot while background tasks are still tracked")

    def load_state(self) -> None:
        """Rebuild task snapshots from agent state after it was replaced.

        Persisted work cannot resume in a new process, so non-terminal tasks are recorded as
        failed and their interrupts are dropped from the agent's interrupt state.
        """
        stored: list[BackgroundTask] = self._agent.state.get(_BACKGROUND_TASKS_STATE_KEY) or []
        recovered_interrupt_ids: set[str] = set()
        tasks: dict[str, BackgroundTask] = {}
        for task in stored:
            if not is_task_status_terminal(task["status"]):
                recovered_interrupt_ids.update(interrupt["id"] for interrupt in task.pop("interrupts", []))
                task["status"] = "failed"
                task["last_updated_at"] = _timestamp()
                task["error"] = {
                    "type": "execution_error",
                    "message": "Background task cannot resume after restoring persisted state",
                }
            tasks[task["task_id"]] = task
        with self._tasks_lock:
            self._tasks = tasks
        interrupt_state = self._agent._interrupt_state
        for interrupt_id in recovered_interrupt_ids:
            interrupt_state.interrupts.pop(interrupt_id, None)
        if interrupt_state.activated and not interrupt_state.interrupts:
            interrupt_state.deactivate()
        self._persist_tasks()

    async def _transform_tool_specs(self, context: InvokeModelContext) -> InvokeModelContext:
        transformed: list[ToolSpec] = []
        for spec in context.tool_specs:
            if _declares_background_property(spec):
                raise TypeError(f"Tool '{spec['name']}' declares reserved parameter '{_BACKGROUND_PROPERTY}'")
            tool_instance = _lookup_tool(context.agent, spec["name"])
            policy = self._policy_for(tool_instance)
            if policy is None or policy.mode != "agentic":
                transformed.append(spec)
                continue
            selectable = _add_background_selection(spec) if self._supports_background_execution(tool_instance) else None
            if selectable is None and policy.exact:
                raise TypeError(f"Tool '{spec['name']}' cannot use agentic background selection")
            transformed.append(selectable or spec)
        return dataclasses.replace(context, tool_specs=transformed)

    async def _before_model_call(self, event: BeforeModelCallEvent) -> None:
        """Resume tasks from interrupt responses, halt while any task awaits input, then deliver results."""
        interrupt_state = self._agent._interrupt_state
        responses = interrupt_state.context.get("responses")
        if responses:
            await self._resume_interrupted_tasks(responses)

        tasks = self._task_snapshots()
        pending_interrupts = [
            interrupt
            for task in tasks
            if task["status"] == "input_required"
            for interrupt in task.get("interrupts", [])
        ]
        if pending_interrupts:
            # The agent surfaces every unanswered interrupt registered in its state, and resume()
            # rejects responses for unregistered ids, so register them all before raising one.
            for interrupt_data in pending_interrupts:
                interrupt_state.interrupts.setdefault(
                    interrupt_data["id"],
                    Interrupt(id=interrupt_data["id"], name=interrupt_data["name"], reason=interrupt_data["reason"]),
                )
            raise InterruptException(interrupt_state.interrupts[pending_interrupts[0]["id"]])
        self._deliver_ready(event, tasks)

    async def _resume_interrupted_tasks(self, responses: list[dict[str, Any]]) -> None:
        """Route interrupt responses to the tasks that raised them and clear the agent interrupt if none remain."""
        interrupt_state = self._agent._interrupt_state
        input_tasks = [task for task in await self._manager.list() if task["status"] == "input_required"]
        task_interrupt_ids = {interrupt["id"] for task in input_tasks for interrupt in task.get("interrupts", [])}
        for task in input_tasks:
            interrupt_ids = {interrupt["id"] for interrupt in task.get("interrupts", [])}
            task_responses = [
                content["interruptResponse"]
                for content in responses
                if content["interruptResponse"]["interruptId"] in interrupt_ids
            ]
            if task_responses:
                await self._manager.resume(task["task_id"], task_responses)
        if all(interrupt_id in task_interrupt_ids for interrupt_id in interrupt_state.interrupts):
            interrupt_state.deactivate()

    async def _after_invocation(self, event: AfterInvocationEvent) -> None:
        if self._agent._interrupt_state.activated:
            return
        tasks = self._task_snapshots()
        while (
            self._config.get("wait_for_completion", True)
            and not self._agent.cancel_signal.is_set()
            and not any(task["status"] == "input_required" for task in tasks)
            and any(not is_task_status_terminal(task["status"]) for task in tasks)
        ):
            await self._await_next_settlement(tasks)
            tasks = self._task_snapshots()
        if any(task["status"] == "input_required" for task in tasks):
            if event.resume is None:
                event.resume = []
            return
        self._deliver_ready(event, tasks)

    async def _await_next_settlement(self, tasks: Sequence[BackgroundTask]) -> None:
        """Wait until one pending task settles or the invocation is cancelled."""
        waiters = [
            asyncio.ensure_future(self._manager.wait(task["task_id"]))
            for task in tasks
            if not is_task_status_terminal(task["status"])
        ]
        try:
            while waiters and not self._agent.cancel_signal.is_set():
                settled, _ = await asyncio.wait(
                    waiters, timeout=_CANCEL_POLL_INTERVAL, return_when=asyncio.FIRST_COMPLETED
                )
                if settled:
                    return
        finally:
            for waiter in waiters:
                waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)

    def _deliver_ready(
        self,
        event: BeforeModelCallEvent | AfterInvocationEvent,
        tasks: Sequence[BackgroundTask],
    ) -> None:
        """Queue terminal task results as a continuation of synthetic tool-use/tool-result pairs."""
        terminal_tasks = [task for task in tasks if is_task_status_terminal(task["status"])]
        if not terminal_tasks:
            return
        task_ids = [task["task_id"] for task in terminal_tasks]
        messages: Messages = []
        for task in terminal_tasks:
            result = task.get("result")
            content: list[ToolResultContent] = (
                result["content"]
                if result is not None
                else [{"text": task.get("error", {}).get("message", "Background task cancelled")}]
            )
            messages.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "toolUse": {
                                "name": _RESULT_TOOL_NAME,
                                "toolUseId": task["task_id"],
                                "input": {"tool_name": task["tool_name"]},
                            }
                        }
                    ],
                }
            )
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "toolResult": {
                                "toolUseId": task["task_id"],
                                "status": "success" if task["status"] == "completed" else "error",
                                "content": content,
                            }
                        }
                    ],
                }
            )

        async def on_appended() -> None:
            live_task_ids = {task["task_id"] for task in await self._manager.list()}
            await self._manager.remove([task_id for task_id in task_ids if task_id in live_task_ids])
            with self._tasks_lock:
                for task_id in task_ids:
                    self._tasks.pop(task_id, None)
            self._persist_tasks()

        _continuation.add_input(event, _continuation._ContinuationInput(args=messages, on_appended=on_appended))

    def _policy_for(self, tool_instance: AgentTool | None) -> _Policy | None:
        if tool_instance is None:
            return None
        exact = self._policy.get(tool_instance.tool_name)
        if exact is not None:
            return _Policy(mode=exact, exact=True)
        wildcard = self._policy.get("*")
        return _Policy(mode=wildcard, exact=False) if wildcard is not None else None

    def _rejection_reason(self, tool_instance: AgentTool | None, mode: _BackgroundMode) -> str | None:
        """Return why the tool cannot honor ``mode``, or None if it can."""
        if not self._supports_background_execution(tool_instance):
            return "cannot run in the background"
        if mode == "agentic" and _add_background_selection(tool_instance.tool_spec) is None:
            return "cannot use agentic background selection"
        return None

    def _supports_background_execution(self, tool_instance: AgentTool | None) -> TypeGuard[AgentTool]:
        policy = self._policy_for(tool_instance)
        return (
            tool_instance is not None
            and policy is not None
            and policy.mode != "never"
            and tool_instance.tool_name not in _FOREGROUND_TOOL_NAMES
            and tool_instance.tool_type != "structured_output"
            and not (isinstance(tool_instance, _AgentAsTool) and tool_instance.delegate)
        )

    def _store_task(self, task: BackgroundTask) -> None:
        with self._tasks_lock:
            self._tasks[task["task_id"]] = task
        self._persist_tasks()

    def _task_snapshots(self) -> list[BackgroundTask]:
        with self._tasks_lock:
            return list(self._tasks.values())

    def _persist_tasks(self) -> None:
        # Snapshot and write under one lock so a concurrent remove cannot be overwritten by a stale snapshot.
        with self._tasks_lock:
            tasks = list(self._tasks.values())
            if tasks:
                self._agent.state.set(_BACKGROUND_TASKS_STATE_KEY, tasks)
            else:
                self._agent.state.delete(_BACKGROUND_TASKS_STATE_KEY)


def _resolve_policy(config: BackgroundTasksConfig) -> dict[str, _BackgroundMode]:
    explicit_wildcard = "*" in config.get("always", []) or "*" in config.get("never", [])
    assignments: list[tuple[_BackgroundMode, Sequence[AgentTool | str]]] = [
        ("agentic", config.get("agentic", [] if explicit_wildcard else ["*"])),
        ("always", config.get("always", [])),
        ("never", config.get("never", [])),
    ]
    policy: dict[str, _BackgroundMode] = {}
    for mode, selectors in assignments:
        for selector in selectors:
            name = selector if isinstance(selector, str) else selector.tool_name
            existing = policy.get(name)
            if existing is not None and existing != mode:
                raise TypeError(f"Tool '{name}' cannot be configured as both '{existing}' and '{mode}'")
            policy[name] = mode
    return policy


def _declares_background_property(tool_spec: ToolSpec) -> bool:
    """Whether the tool's own schema uses the reserved ``_background_execution`` name."""
    schema = tool_spec.get("inputSchema", {}).get("json", {})
    properties = schema.get("properties")
    return (isinstance(properties, dict) and _BACKGROUND_PROPERTY in properties) or (
        _BACKGROUND_PROPERTY in schema.get("required", [])
    )


def _add_background_selection(tool_spec: ToolSpec) -> ToolSpec | None:
    """Return a copy of the spec with the ``_background_execution`` flag, or None if the schema cannot take it."""
    schema = tool_spec.get("inputSchema", {}).get("json", {})
    properties = schema.get("properties")
    if (
        _COMPOSITE_SCHEMA_KEYS.intersection(schema)
        or schema.get("type") not in (None, "object")
        or (properties is not None and not isinstance(properties, dict))
    ):
        return None
    selectable = copy.deepcopy(tool_spec)
    json_schema = selectable.setdefault("inputSchema", {}).setdefault("json", {})
    json_schema["type"] = "object"
    json_schema["properties"] = {
        **json_schema.get("properties", {}),
        _BACKGROUND_PROPERTY: {
            "type": "boolean",
            "description": "Run this tool in the background and continue without waiting for its result.",
        },
    }
    return selectable


def _tool_error(tool_use: ToolUse, message: str) -> ToolResult:
    return {"toolUseId": tool_use["toolUseId"], "status": "error", "content": [{"text": message}]}


def _json_tool_result(value: Any) -> dict[str, Any]:
    # The decorator fills in toolUseId for a result that already carries status and content.
    return {"status": "success", "content": [{"json": value}]}
