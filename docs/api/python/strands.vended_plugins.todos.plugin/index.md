Todos plugin for maintaining a structured task list across a multi-step run.

A single `todo_write` tool writes the current list to agent state; an internal `ContextInjector` re-renders that list at intervals, so the agent keeps its plan in view without restating it.

Re-surfacing goes through `ContextInjector` rather than editing `agent.messages` directly. The list is rewritten on every `todo_write` call, so what matters is that the model sees one current copy rather than a pile of superseded ones. Injection gives that: each rendered list is stored as an `injected` block, and only the latest user message’s injected blocks are sent as text — older ones are dropped from the request. The lists stay readable in `agent.messages` for anything inspecting history, and callers that do not want them can skip any block where `"injected" in block`.

The reminder is paced in model calls, not user turns, so a long single invocation gets it mid-loop. The model last saw the list on the call after a `todo_write` or in a reminder; the next reminder waits `reminder_interval` model calls after that, since repeating a list the model has just read only costs tokens.

## TodoItem

```python
class TodoItem(TypedDict)
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L42)

One entry in the task list.

**Attributes**:

-   `content` - The task, imperative: “Run tests”.
-   `activeForm` - Present continuous, shown while the item is in progress: “Running tests”.
-   `status` - Where the item stands.

## Todos

```python
class Todos(Plugin)
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L66)

Gives the agent a `todo_write` tool and keeps the current list in view.

The tool persists the list to `agent.state` under `state_key`; every `reminder_interval` model calls, counted from the call that last showed the list, the plugin re-renders it as a `<system-reminder>`. Sharing one instance across agents is safe: the list lives in per-agent state, not on the plugin.

One agent takes one `Todos`. The tool is always named `todo_write`, so a second instance raises no matter how `name` and `state_key` are set.

A reminder changes the tail of the request it is sent with. On a provider without explicit cache points that moves the cached prefix boundary, so a lower `reminder_interval` trades cache hits and tokens for a fresher list.

**Example**:

```python
from strands import Agent
from strands.vended_plugins.todos import Todos

agent = Agent(plugins=[Todos()])
```

**Arguments**:

-   `name` - Plugin name. It also tags the reminder blocks the plugin injects, and that tag keeps a retry or a restored session from injecting a second copy, so keep it stable. Defaults to `"strands:todos"`.
-   `state_key` - Agent-state key the list is stored under. Defaults to `"todos"`.
-   `reminder_interval` - Re-render the list every this many model calls, counted from the call that last showed it: the one after a `todo_write` call, or a reminder. `1` re-renders it on every call that does not already carry a `todo_write` result. Defaults to `10`.

**Raises**:

-   `ValueError` - If `reminder_interval` is not a positive integer.

#### \_\_init\_\_

```python
def __init__(*,
             name: str = _DEFAULT_NAME,
             state_key: str = _STATE_KEY,
             reminder_interval: int = _DEFAULT_REMINDER_INTERVAL) -> None
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:103](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L103)

Initialize the plugin.

#### name

```python
@property
def name() -> str
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:120](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L120)

Plugin name, also the tag on the reminder blocks the plugin injects.

#### init\_agent

```python
def init_agent(agent: Agent) -> None
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:124](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L124)

Register the re-surfacing injector. The `todo_write` tool is auto-registered.

**Raises**:

-   `ValueError` - If the agent already has a `todo_write` tool. The plugin registry’s duplicate check is on `name`, which a second instance can set freely, so the tool name is checked here instead.

#### todo\_write

```python
@tool(name="todo_write", context="tool_context")
def todo_write(todos: list[TodoItem], tool_context: ToolContext) -> str
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:173](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L173)

Create and maintain a structured task list for the current session.

Use proactively for multi-step work (roughly 3+ distinct steps). Keep exactly one item `in_progress` at a time, and update status as you go rather than batching. The current list is re-surfaced to you periodically, so you do not need to restate it. Pass an empty list to clear it when the work is done.

**Arguments**:

-   `todos` - The full updated list. Each item has `content` (the task, imperative: “Run tests”), `activeForm` (present continuous, shown while in progress: “Running tests”), and `status` (`pending`, `in_progress`, `completed`).
-   `tool_context` - Injected by the framework. Not user-facing.

**Returns**:

The number of items still open, followed by the rendered list.