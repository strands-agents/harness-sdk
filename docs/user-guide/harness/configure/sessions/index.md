Session management persists a conversation so a long-running task survives a restart. Strands harness keeps sessions on by default: without a session id, each agent starts fresh under a new random id.

## Persist and resume by id

Pass `session={"id": ...}` and Strands harness persists the conversation to disk, then rehydrates it the next time you build an agent with the same id. Reuse the id to resume; use a new id to start clean.

(( tab "Strands harness" ))
(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(session={"id": "refactor-parser"})
agent("Let's refactor the parser. Where should we start?")
# ...later, in a new process...
resumed = create_harness(session={"id": "refactor-parser"})
resumed("Where did we leave off?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ session: { id: 'refactor-parser' } })
await agent.invoke("Let's refactor the parser. Where should we start?")
// ...later, in a new process...
const resumed = await createHarness({ session: { id: 'refactor-parser' } })
await resumed.invoke('Where did we leave off?')
```
(( /tab "TypeScript" ))
(( /tab "Strands harness" ))

(( tab "SDK" ))
(( tab "Python" ))
```python
# pip install strands-agents
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

session = SnapshotSessionManager(session_id="refactor-parser",
    storage=LocalFileStorage("./sessions/"))
agent = Agent(session_manager=session)
agent("Let's refactor the parser. Where should we start?")
# ...later, in a new process...
resumed = Agent(session_manager=SnapshotSessionManager(
    session_id="refactor-parser", storage=LocalFileStorage("./sessions/")))
resumed("Where did we leave off?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// npm install @strands-agents/sdk
import { Agent, SessionManager, FileStorage } from '@strands-agents/sdk'

const session = new SessionManager({ sessionId: 'refactor-parser',
  storage: { snapshot: new FileStorage('./sessions') } })
const agent = new Agent({ sessionManager: session })
await agent.invoke("Let's refactor the parser. Where should we start?")
// ...later, in a new process...
const resumed = new Agent({
  sessionManager: new SessionManager({ sessionId: 'refactor-parser',
    storage: { snapshot: new FileStorage('./sessions') } }),
})
await resumed.invoke('Where did we leave off?')
```
(( /tab "TypeScript" ))
(( /tab "SDK" ))

The id is sanitized to lowercase alphanumerics, hyphens, and underscores, so `"Refactor Parser"` and `"refactor-parser"` resolve to the same session.

## Choose where session state lives

By default session state is written under `./.agent/sessions`. Set `session={"dir": ...}` to put it elsewhere:

(( tab "Strands harness" ))
(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(session={"id": "refactor-parser",
                                "dir": "/var/lib/agent/sessions"})
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({
  session: { id: 'refactor-parser', dir: '/var/lib/agent/sessions' },
})
```
(( /tab "TypeScript" ))
(( /tab "Strands harness" ))

(( tab "SDK" ))
(( tab "Python" ))
```python
# pip install strands-agents
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

session = SnapshotSessionManager(session_id="refactor-parser",
    storage=LocalFileStorage("/var/lib/agent/sessions"))
agent = Agent(session_manager=session)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// npm install @strands-agents/sdk
import { Agent, SessionManager, FileStorage } from '@strands-agents/sdk'

const session = new SessionManager({ sessionId: 'refactor-parser',
  storage: { snapshot: new FileStorage('/var/lib/agent/sessions') } })
const agent = new Agent({ sessionManager: session })
```
(( /tab "TypeScript" ))
(( /tab "SDK" ))

When a session is active, offloaded tool results (from context management) are kept under the session directory too, so they stay durable across restarts alongside the conversation. Without a session, they stay in memory and do not outlive the process.

### Protect the session directory

Session files are trusted input. Resuming a session loads everything stored in it as-is: the messages, with their tool calls and tool results, and the stored system prompt, which replaces the one you configured. Resume only sessions that you or your own tooling wrote, not ones that came with a cloned repository. A fixed id resumes whatever is already stored under it, without a warning. Before you use a fixed id in a fresh checkout, check that no session directory came with it. Strands harness creates the directory with the process’s default permissions, so on a shared machine restrict it to the user the agent runs as.

To keep conversations and offloaded tool results out of the repository, add `.agent/sessions/` to the `.gitignore` in the directory that contains `.agent`. Ignoring all of `.agent/` covers [long-term memory](/docs/user-guide/harness/configure/memory/index.md) files too, but it also ignores `.agent/skills`. To ignore everything except the [skills](/docs/user-guide/harness/configure/skills/index.md) you commit there, use this pattern instead:

```text
.agent/*
!.agent/skills/
```

For how the SDK treats session storage, see its [session persistence best practices](/docs/user-guide/sdk/agents/session-management/index.md#session-persistence-best-practices).

## Sessions are not memory

Sessions and [long-term memory](/docs/user-guide/harness/configure/memory/index.md) are separate. A session persists one conversation, replayed only when you resume that id. Memory distills durable facts that the agent recalls across every conversation, with or without a session. Use a session to continue a specific task; rely on memory to carry knowledge between unrelated runs.

## How the two SDKs store sessions

Both SDKs write session snapshots to local files, but through different classes. The Python SDK uses a `SnapshotSessionManager` backed by `LocalFileStorage`. The TypeScript SDK composes the shared `Storage` abstraction, using a `SessionManager` whose snapshot storage is a file storage under the session directory. Either way the on-disk result is a local session store rooted at the session directory.

To supply your own session manager (for example an S3-backed one), pass it through to the `Agent`; your explicit manager wins over the one Strands harness would build from `session`. Pass `storage` along with it too: without it, offloaded tool results are embedded in every snapshot the manager writes instead of being stored once. For the storage backends, see [storage](/docs/user-guide/sdk/storage/index.md). For the full option list, see the [configuration reference](/docs/user-guide/harness/reference/configuration/index.md).

## Implementation

### Python

- [harness-sdk/harness-py/src/strands_harness/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/agent.py)

### TypeScript

- [harness-sdk/harness-ts/src/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/src/agent.ts)
