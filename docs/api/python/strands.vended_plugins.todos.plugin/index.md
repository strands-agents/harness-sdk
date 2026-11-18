Todos plugin for maintaining a structured task list across a multi-step run.

A single `todo_write` tool writes the current list to agent state; an internal `ContextInjector` re-renders that list before each model call so the agent keeps its plan in view without restating it.

Re-surfacing goes through `ContextInjector` rather than editing `agent.messages` directly. The list is rewritten on every `todo_write` call, so what matters is that the model sees one current copy rather than a pile of superseded ones. Injection gives that: each rendered list is stored as an `injected` block, and only the latest user message’s injected blocks are sent as text — older ones are dropped from the request. The lists stay readable in `agent.messages` for anything inspecting history, and callers that do not want them can skip any block where `"injected" in block`.

The injector fires on `everyTurn`, not `userTurn`: the agent updates the list mid-loop via `todo_write`, so it should see the refreshed list on the next model call within the same invocation, not only at the start of the next user turn.

## TodoItem

```python
class TodoItem(TypedDict)
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L39)

One entry in the task list.

**Attributes**:

-   `content` - The task, imperative: “Run tests”.
-   `activeForm` - Present continuous, shown while the item is in progress: “Running tests”.
-   `status` - Where the item stands.

## Todos

```python
class Todos(Plugin)
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:63](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L63)

Gives the agent a `todo_write` tool and keeps the current list in view.

The tool persists the list to `agent.state` under `state_key`; before each model call the plugin re-renders it as a `<system-reminder>`. Sharing one instance across agents is safe: the list lives in per-agent state, not on the plugin.

One agent takes one `Todos`. The tool is always named `todo_write`, so a second instance raises no matter how `name` and `state_key` are set.

Because the list is re-rendered on every model call, it changes the tail of the request each turn. On a provider without explicit cache points that moves the cached prefix boundary, so weigh it against the task tracking it buys.

**Example**:

```python
from strands import Agent
from strands.vended_plugins.todos import Todos

agent = Agent(plugins=[Todos()])
```

**Arguments**:

-   `name` - Plugin name. It also tags the reminder blocks the plugin injects, and that tag keeps a retry or a restored session from injecting a second copy, so keep it stable. Defaults to `"strands:todos"`.
-   `state_key` - Agent-state key the list is stored under. Defaults to `"todos"`.

#### \_\_init\_\_

```python
def __init__(*,
             name: str = _DEFAULT_NAME,
             state_key: str = _STATE_KEY) -> None
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:92](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L92)

Initialize the plugin.

#### name

```python
@property
def name() -> str
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:99](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L99)

Plugin name, also the tag on the reminder blocks the plugin injects.

#### init\_agent

```python
def init_agent(agent: Agent) -> None
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:103](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L103)

Register the re-surfacing injector. The `todo_write` tool is auto-registered.

**Raises**:

-   `ValueError` - If the agent already has a `todo_write` tool. The plugin registry’s duplicate check is on `name`, which a second instance can set freely, so the tool name is checked here instead.

#### todo\_write

```python
@tool(name="todo_write", context="tool_context")
def todo_write(todos: list[TodoItem], tool_context: ToolContext) -> str
```

Defined in: [src/strands/vended\_plugins/todos/plugin.py:131](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py#L131)

Create and maintain a structured task list for the current session.

Use proactively for multi-step work (roughly 3+ distinct steps). Keep exactly one item `in_progress` at a time, and update status as you go rather than batching. The current list is re-surfaced to you before each step, so you do not need to restate it. Pass an empty list to clear it when the work is done.

**Arguments**:

-   `todos` - The full updated list. Each item has `content` (the task, imperative: “Run tests”), `activeForm` (present continuous, shown while in progress: “Running tests”), and `status` (`pending`, `in_progress`, `completed`).
-   `tool_context` - Injected by the framework. Not user-facing.

**Returns**:

The number of items still open, followed by the rendered list.