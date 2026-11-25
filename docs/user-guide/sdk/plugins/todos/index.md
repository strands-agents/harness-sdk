The `Todos` plugin gives the agent a `todo_write` tool and keeps the current list in view. When the agent writes a list, the plugin re-surfaces it at intervals, so on a long task the agent keeps its plan in front of it without restating it.

## How It Works

`Todos` has two halves. The `todo_write` tool writes the whole list to agent state, replacing whatever was there. An internal [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) renders that list back as a `<system-reminder>` every `reminder_interval``reminderInterval` model calls, counted from the call that last showed it.

Re-surfacing goes through injection rather than editing the conversation directly. The list is rewritten on every `todo_write` call, so what matters is that the model sees one current copy rather than a pile of superseded ones. Each rendered list is stored as an `injected` block, and only the latest user message’s injected blocks are sent to the model — older ones are dropped from the request. The lists stay readable in the stored messages for anything inspecting history.

The reminder is paced in model calls, not user turns, so a long single invocation gets it mid-loop. The model last saw the list on the call after a `todo_write`, whose result carries the full list, or in a reminder; the next reminder waits `reminder_interval``reminderInterval` model calls after that. The count is read from the conversation, so a list that context management has removed is re-surfaced on the next model call. A session restored without its injected blocks counts from the last `todo_write` call alone, so it may be reminded on its first model call.

## Getting Started

Pass a `Todos` to your agent’s `plugins` list. There is nothing to configure — the tool and the injector are both registered for you:

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_plugins.todos import Todos

agent = Agent(plugins=[Todos()])
agent("Refactor the auth module, then update its tests and the changelog.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { Todos } from '@strands-agents/sdk/vended-plugins/todos'

const agent = new Agent({ plugins: [new Todos()] })
await agent.invoke('Refactor the auth module, then update its tests and the changelog.')
```
(( /tab "TypeScript" ))

The tool description steers the agent to use the list for multi-step work (roughly three or more distinct steps), keep exactly one item in progress at a time, update status as it goes rather than batching, and clear the list when the work is done.

## What the Agent Writes

Each call to `todo_write` passes the full updated list. An item has three fields:

| Field | Purpose |
| --- | --- |
| `content` | The task, imperative: `"Run tests"`. |
| `activeForm` | Present continuous, shown while the item is in progress: `"Running tests"`. |
| `status` | `pending`, `in_progress`, or `completed`. |

Two forms of the same task sounds redundant, but it is what makes the rendered list readable as a status line: a completed or pending item shows its `content`, and the one item in progress shows its `activeForm`. Passing an empty list clears the state.

## Read the List Yourself

The list lives in agent state under a plain key, so your application can read it to render progress in a UI. It is a list of items in the shape above, or absent if the agent has not written one yet:

(( tab "Python" ))
```python
todos = agent.state.get("todos") or []
for todo in todos:
    print(todo["status"], todo["content"])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import type { TodoItem } from '@strands-agents/sdk/vended-plugins/todos'

const todos = (agent.appState.get('todos') as TodoItem[] | undefined) ?? []
for (const todo of todos) {
  console.log(todo.status, todo.content)
}
```
(( /tab "TypeScript" ))

Because state is per-agent rather than on the plugin, one `Todos` instance is safe to share across agents — each agent keeps its own list.

## Configuration

| Field | Purpose |
| --- | --- |
| `name` | Plugin name. It also tags the reminder blocks the plugin injects, and that tag is what keeps a retry or a restored session from injecting a second copy — so keep it stable. Defaults to `'strands:todos'`. |
| `state_key``stateKey` | Agent-state key the list is stored under. Defaults to `'todos'`. Set it to avoid colliding with another consumer of that key. |
| `reminder_interval``reminderInterval` | Re-surface the list every this many model calls, counted from the call that last showed it: the one after a `todo_write` call, or a reminder. `1` re-surfaces it on every call that does not already carry a `todo_write` result. Must be a positive integer. Defaults to `10`. |

One agent takes one `Todos`. The tool is always named `todo_write`, so adding a second instance to the same agent raises, regardless of what `name` and `state_key``stateKey` are set to.

A reminder costs tokens and moves the cache boundary

Each reminder adds the rendered list to a model call and changes the tail of that request. On a provider without explicit cache points that moves the cached prefix boundary. A lower `reminder_interval``reminderInterval` keeps the list fresher at that cost.

## Related

-   [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) is the engine `Todos` re-surfaces the list with, and the generic surface for any always-present context.
-   [Task tracking and environment](/docs/user-guide/harness/tools/todos-and-environment/index.md) covers the Strands harness built-in this plugin replaces.

## Related pages

- [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) (1 shared tag)
- [GenAI Prices Estimator](/docs/user-guide/sdk/plugins/genai-prices-estimator/index.md) (1 shared tag)
- [Objectives, constraints, and budget](/docs/user-guide/evals-sdk/optimization/objectives/index.md) (1 shared tag)
- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (1 shared tag)
- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (1 shared tag)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (1 shared tag)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (1 shared tag)
- [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md) (1 shared tag)
- [Declaring what can change](/docs/user-guide/evals-sdk/optimization/tunables/index.md) (1 shared tag)
- [Skills](/docs/user-guide/sdk/plugins/skills/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/vended_plugins/todos/plugin.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/todos/plugin.py)

### TypeScript

- [harness-sdk/strands-ts/src/vended-plugins/todos/plugin.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-plugins/todos/plugin.ts)
