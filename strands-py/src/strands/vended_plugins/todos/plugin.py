"""Todos plugin for maintaining a structured task list across a multi-step run.

A single ``todo_write`` tool writes the current list to agent state; an internal
``ContextInjector`` re-renders that list before each model call so the agent keeps its plan in
view without restating it.

Re-surfacing goes through ``ContextInjector`` rather than editing ``agent.messages`` directly.
The list is rewritten on every ``todo_write`` call, so what matters is that the model sees one
current copy rather than a pile of superseded ones. Injection gives that: each rendered list is
stored as an ``injected`` block, and only the latest user message's injected blocks are sent as
text — older ones are dropped from the request. The lists stay readable in ``agent.messages``
for anything inspecting history, and callers that do not want them can skip any block where
``"injected" in block``.

The injector fires on ``everyTurn``, not ``userTurn``: the agent updates the list mid-loop via
``todo_write``, so it should see the refreshed list on the next model call within the same
invocation, not only at the start of the next user turn.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from typing_extensions import TypedDict

from ...injection.types import InjectionContext
from ...plugins import Plugin
from ...tools.decorator import tool
from ...types.tools import ToolContext
from ..context_injector import ContextInjector

if TYPE_CHECKING:
    from ...agent.agent import Agent

_STATE_KEY = "todos"
_DEFAULT_NAME = "strands:todos"


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

    The tool persists the list to ``agent.state`` under ``state_key``; before each model call the
    plugin re-renders it as a ``<system-reminder>``. Sharing one instance across agents is safe:
    the list lives in per-agent state, not on the plugin.

    Because the list is re-rendered on every model call, it changes the tail of the request each
    turn. On a provider without explicit cache points that moves the cached prefix boundary, so
    weigh it against the task tracking it buys.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.todos import Todos

        agent = Agent(plugins=[Todos()])
        ```

    Args:
        name: Plugin name, for logging and duplicate detection. Defaults to ``"strands:todos"``.
        state_key: Agent-state key the list is stored under. Defaults to ``"todos"``.
    """

    def __init__(self, *, name: str = _DEFAULT_NAME, state_key: str = _STATE_KEY) -> None:
        """Initialize the plugin."""
        self._name = name
        self._state_key = state_key
        super().__init__()

    @property
    def name(self) -> str:
        """Plugin name, for logging and duplicate detection."""
        return self._name

    def init_agent(self, agent: Agent) -> None:
        """Register the re-surfacing injector. The ``todo_write`` tool is auto-registered."""
        ContextInjector(
            self._render_reminder,
            name=f"{self._name}:injector",
            trigger="everyTurn",
        ).init_agent(agent)

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
        list is re-surfaced to you before each step, so you do not need to restate it. Pass an
        empty list to clear it when the work is done.

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
