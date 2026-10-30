A scratchpad the agent can read and write across invocations. The most effective use is giving the agent a notebook at the start of a task and instructing it to plan its work there. It can break the task into steps, check things off as it goes, and always have a clear picture of what’s left. Notebook state is part of the agent’s state, so it persists automatically with [Session Management](/docs/user-guide/sdk/agents/session-management/index.md).

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

**Example - Task Management:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [notebook],
  systemPrompt:
    'Before starting any multi-step task, create a notebook with a checklist of steps. ' +
    'Check off each step as you complete it.',
})

// The agent uses the notebook to plan and track its work
await agent.invoke('Write a project plan for building a personal budget tracker app')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import notebook

agent = Agent(tools=[notebook])
agent('Create a notebook called "tasks" with "# Daily Tasks" and add "- [ ] Review code" to it')
```
(( /tab "Python" ))

**Example - State Persistence:**

(( tab "TypeScript" ))
```typescript
import { Agent, SessionManager, FileStorage } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const session = new SessionManager({
  sessionId: 'my-session',
  storage: { snapshot: new FileStorage('./sessions') },
})

const agent = new Agent({ tools: [notebook], sessionManager: session })

// Notebooks are automatically persisted as part of the session
await agent.invoke('Create a notebook called "ideas" with "# Project Ideas"')
await agent.invoke('Add "- Build a web scraper" to the ideas notebook')

// ...

// Later, a new agent with the same session restores notebooks automatically
const restoredAgent = new Agent({ tools: [notebook], sessionManager: session })
await restoredAgent.invoke('Read the ideas notebook')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import notebook

agent = Agent(tools=[notebook])
agent('Create a notebook called "tasks" with "# Daily Tasks" and add "- [ ] Review code" to it')

# Read the notebook contents directly off agent state.
notebooks = agent.state.get("notebooks") or {}
print(notebooks.get("tasks"))
```
(( /tab "Python" ))

**Example - Custom configuration:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { makeNotebook } from '@strands-agents/sdk/vended-tools/notebook'

const notes = makeNotebook({
  name: 'notes',
  maxNotebookSizeBytes: 64 * 1024, // 64 KiB
})
const agent = new Agent({ tools: [notes] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import make_notebook

notes = make_notebook(
    name="notes",
    max_notebook_size_bytes=64 * 1024,  # 64 KiB
)
agent = Agent(tools=[notes])
```
(( /tab "Python" ))

📖 [Full API Reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/notebook/README.md)

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/notebook/notebook.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/notebook/notebook.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/notebook/notebook.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/notebook/notebook.py)
