"""Todos plugin for maintaining a structured task list across a multi-step run.

A single ``todo_write`` tool writes the current list to agent state; an internal
``ContextInjector`` re-renders that list at intervals, so the agent keeps its plan in view without
restating it.

Re-surfacing goes through ``ContextInjector`` rather than editing ``agent.messages`` directly.
The list is rewritten on every ``todo_write`` call, so what matters is that the model sees one
current copy rather than a pile of superseded ones. Injection gives that: each rendered list is
stored as an ``injected`` block, and only the latest user message's injected blocks are sent as
text — older ones are dropped from the request. The lists stay readable in ``agent.messages``
for anything inspecting history, and callers that do not want them can skip any block where
``"injected" in block``.

The reminder is paced in model calls, not user turns, so a long single invocation gets it
mid-loop. The model last saw the list on the call after a ``todo_write`` or in a reminder; the
next reminder waits ``reminder_interval`` model calls after that, since repeating a list the model
has just read only costs tokens.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from typing_extensions import TypedDict

from ...injection.types import InjectionContext
from ...plugins import Plugin
from ...tools.decorator import tool
from ...types.content import ContentBlock
from ...types.tools import ToolContext
from ..context_injector import ContextInjector

if TYPE_CHECKING:
    from ...agent.agent import Agent

_STATE_KEY = "todos"
_DEFAULT_NAME = "strands:todos"
_DEFAULT_REMINDER_INTERVAL = 10


class TodoItem(TypedDict):
    """One entry in the task list.

    Attributes:
        content: The task, imperative: "Run tests".
        activeForm: Present continuous, shown while the item is in progress: "Running tests".
        status: Where the item stands.
    """

    content: str
    activeForm: str
    status: Literal["pending", "in_progress", "completed"]


def _todo_line(todo: TodoItem) -> str:
    status = todo.get("status", "pending")
    label = todo["activeForm"] if status == "in_progress" and todo.get("activeForm") else todo.get("content", "")
    return f"  [{status}] {label}"


def _render_list(todos: list[TodoItem]) -> str:
    return "\n".join(_todo_line(todo) for todo in todos)


class Todos(Plugin):
    """Gives the agent a ``todo_write`` tool and keeps the current list in view.

    The tool persists the list to ``agent.state`` under ``state_key``; every ``reminder_interval``
    model calls, counted from the call that last showed the list, the plugin re-renders it as a
    ``<system-reminder>``. Sharing one instance across agents is safe: the list lives in per-agent
    state, not on the plugin.

    One agent takes one ``Todos``. The tool is always named ``todo_write``, so a second instance
    raises no matter how ``name`` and ``state_key`` are set.

    A reminder changes the tail of the request it is sent with. On a provider without explicit
    cache points that moves the cached prefix boundary, so a lower ``reminder_interval`` trades
    cache hits and tokens for a fresher list.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.todos import Todos

        agent = Agent(plugins=[Todos()])
        ```

    Args:
        name: Plugin name. It also tags the reminder blocks the plugin injects, and that tag keeps
            a retry or a restored session from injecting a second copy, so keep it stable.
            Defaults to ``"strands:todos"``.
        state_key: Agent-state key the list is stored under. Defaults to ``"todos"``.
        reminder_interval: Re-render the list every this many model calls, counted from the call
            that last showed it: the one after a ``todo_write`` call, or a reminder. ``1``
            re-renders it on every call that does not already carry a ``todo_write`` result.
            Defaults to ``10``.

    Raises:
        ValueError: If ``reminder_interval`` is not a positive integer.
    """

    def __init__(
        self,
        *,
        name: str = _DEFAULT_NAME,
        state_key: str = _STATE_KEY,
        reminder_interval: int = _DEFAULT_REMINDER_INTERVAL,
    ) -> None:
        """Initialize the plugin."""
        if not isinstance(reminder_interval, int) or isinstance(reminder_interval, bool) or reminder_interval < 1:
            raise ValueError(f"reminder_interval=<{reminder_interval}> | must be a positive integer")
        self._name = name
        self._state_key = state_key
        self._reminder_interval = reminder_interval
        self._injector_name = f"{name}:injector"
        super().__init__()

    @property
    def name(self) -> str:
        """Plugin name, also the tag on the reminder blocks the plugin injects."""
        return self._name

    def init_agent(self, agent: Agent) -> None:
        """Register the re-surfacing injector. The ``todo_write`` tool is auto-registered.

        Raises:
            ValueError: If the agent already has a ``todo_write`` tool. The plugin registry's
                duplicate check is on ``name``, which a second instance can set freely, so the
                tool name is checked here instead.
        """
        if self.todo_write.tool_name in agent.tool_registry.registry:
            raise ValueError(f"tool_name=<{self.todo_write.tool_name}> | tool already registered")

        ContextInjector(
            self._render_reminder,
            name=self._injector_name,
            trigger=self._reminder_due,
        ).init_agent(agent)

    def _reminder_due(self, context: InjectionContext) -> bool:
        """Whether there is a list and ``reminder_interval`` model calls have passed since one showed it.

        Read from the messages rather than a counter, so there is no state to restore, and a list
        the conversation does not show is re-rendered at once.
        """
        if not context.state.get(self._state_key):
            return False
        calls_since_shown = 0
        for message in reversed(context.messages):
            if any(self._shows_list(block) for block in message["content"]):
                return calls_since_shown >= self._reminder_interval
            if message["role"] == "assistant":
                calls_since_shown += 1
        return True

    def _shows_list(self, block: ContentBlock) -> bool:
        if "injected" in block:
            return block["injected"]["source"] == self._injector_name
        return "toolUse" in block and block["toolUse"]["name"] == self.todo_write.tool_name

    def _render_reminder(self, context: InjectionContext) -> str | None:
        todos = context.state.get(self._state_key)
        if not todos:
            return None
        return (
            "<system-reminder>\nYour current todo list:\n"
            f"{_render_list(todos)}\n"
            "Keep it up to date with todo_write as you work.\n</system-reminder>"
        )

    @tool(name="todo_write", context="tool_context")
    def todo_write(self, todos: list[TodoItem], tool_context: ToolContext) -> str:
        """Create and maintain a structured task list for the current session.

        Use proactively for multi-step work (roughly 3+ distinct steps). Keep exactly one item
        ``in_progress`` at a time, and update status as you go rather than batching. The current
        list is re-surfaced to you periodically, so you do not need to restate it. Pass an empty
        list to clear it when the work is done.

        Args:
            todos: The full updated list. Each item has ``content`` (the task, imperative:
                "Run tests"), ``activeForm`` (present continuous, shown while in progress:
                "Running tests"), and ``status`` (``pending``, ``in_progress``, ``completed``).
            tool_context: Injected by the framework. Not user-facing.

        Returns:
            The number of items still open, followed by the rendered list.
        """
        if not todos:
            tool_context.agent.state.delete(self._state_key)
            return "Todo list cleared"
        tool_context.agent.state.set(self._state_key, todos)
        remaining = sum(1 for todo in todos if todo.get("status") != "completed")
        return f"{remaining} todos remaining\n{_render_list(todos)}"
