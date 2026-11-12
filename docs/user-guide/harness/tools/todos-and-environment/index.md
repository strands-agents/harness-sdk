Two of Strands harness’s built-ins are plugins rather than tools: `environment` and `todos`. Both are selected through `builtin_plugins` and shape how the agent works without being things the model calls the way it calls `shell` or `read`. `environment` is on by default; `todos` is opt-in.

## todos

The `todos` plugin gives the agent a `todo_write` tool and keeps the current task list in view. When the agent writes a list, the plugin re-surfaces it to the model before each step, so on a longer task the agent keeps its plan in front of it without restating it.

The list lives in agent state, not durable history: it is injected fresh before each step and never written into the conversation, so a constantly-changing plan does not stack stale copies in the transcript. Each item has a `content` (the task, imperative), an `activeForm` (shown while it is in progress), and a `status` of `pending`, `in_progress`, or `completed`. The agent is guided to keep one item in progress at a time and clear the list when the work is done.

`todos` is opt-in. Because it re-injects the list on every turn, it costs tokens and breaks the cached prefix on providers without explicit cache points, so enable it where the task tracking earns that.

## environment

The `environment` plugin injects a small block of working-environment context before each user turn:

-   The platform and the current date.
-   The working directory.
-   The project’s `AGENTS.md`, included in full up to a cap (about 16 KB); a longer file is truncated with a marker, and the agent can read the rest on demand.
-   Links (not contents) to other `AGENTS.md` and `README.md` files found a couple of levels down, so the block stays small and the agent reads them only as needed.

Everything is read through the agent’s [sandbox](/docs/user-guide/sdk/sandbox/index.md), so the platform, directory, and files describe where the agent actually runs. The date is injected each turn (rather than baked into the system prompt) precisely so it does not change the cached prompt prefix; the rest is discovered once and reused.

## Select or disable them

`builtin_plugins` selects these by name, defaulting to `["environment"]`. Name both to add todos, or pass an empty list to turn both off:

(( tab "Strands harness" ))
(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(builtin_plugins=["todos", "environment"])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ builtinPlugins: ['todos', 'environment'] })
```
(( /tab "TypeScript" ))
(( /tab "Strands harness" ))

(( tab "SDK" ))
(( tab "Python" ))
```python
# pip install strands-agents
from strands import Agent
from strands.vended_tools import file_editor

# No notebook tool; use file_editor for a plan file
agent = Agent(
    tools=[file_editor],
    system_prompt="Track the task in a plan file and update it as you work.",
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// npm install @strands-agents/sdk
import { Agent } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [notebook],
  systemPrompt: 'Create a notebook checklist and update it as you work.',
})
```
(( /tab "TypeScript" ))
(( /tab "SDK" ))

For the plugin system these build on, see the Strands Harness SDK’s [plugins](/docs/user-guide/sdk/plugins/index.md) documentation.

## Implementation

### Python

- [harness-sdk/harness-py/src/strands_harness/plugins/todos.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/plugins/todos.py)
- [harness-sdk/harness-py/src/strands_harness/plugins/environment.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/plugins/environment.py)

### TypeScript

- [harness-sdk/harness-ts/src/plugins/todos.ts](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/src/plugins/todos.ts)
