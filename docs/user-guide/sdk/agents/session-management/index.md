Keep an agent’s state and conversation history across restarts and requests. A session persists what the agent knows, so it can pick up where it left off even when your application restarts or runs across several machines.

## What a session contains

A session holds the stateful information agents and multi-agent systems need to function, including:

**Single Agent Sessions**:

-   Conversation history (messages)
-   Agent state (key-value storage)
-   Other stateful information (like [Conversation Manager](/docs/user-guide/sdk/agents/state/index.md#conversation-manager))

**Multi-Agent Sessions**:

-   Orchestrator state and configuration
-   Individual agent states and result within the orchestrator
-   Cross-agent shared state and context
-   Execution flow and node transition history

Built-in session persistence captures and restores this information automatically, so an agent continues a conversation where it left off.

Beyond the built-in options, [third-party session managers](#third-party-session-managers) provide additional storage and memory capabilities.

## Basic usage

### Single agent sessions

Create an agent with a session manager and use it:

(( tab "Python" ))
```python
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

# Create a snapshot session manager with a unique session ID
session_manager = SnapshotSessionManager(
    session_id="test-session",
    storage=LocalFileStorage("./sessions/"),
)

# Create an agent with the session manager
agent = Agent(session_manager=session_manager)

# Use the agent - all messages and state are automatically persisted
agent("Hello!")  # This conversation is persisted
```
(( /tab "Python" ))

(( tab "TypeScript" ))
`SessionManager` implements both [Plugin](/docs/user-guide/sdk/plugins/index.md) (for agents) and `MultiAgentPlugin` (for orchestrators). The `sessionManager` constructor field is a convenience shorthand: you can also pass it directly in the `plugins` array:

```typescript
const session = new SessionManager({
  sessionId: 'test-session',
  storage: new LocalFileStorage('./sessions/'),
})

const agent = new Agent({ sessionManager: session })

// Use the agent - all messages and state are automatically persisted
await agent.invoke('Hello!') // This conversation is persisted
```

```typescript
const session = new SessionManager({
  sessionId: 'test-session',
  storage: new LocalFileStorage('./sessions/'),
})

// Equivalent to passing via sessionManager field
const agent = new Agent({ plugins: [session] })
await agent.invoke('Hello!')
```
(( /tab "TypeScript" ))

Strands persists the conversation and its state to the underlying storage backend.

In Python, `SnapshotSessionManager` is the recommended manager for new single-agent sessions. `FileSessionManager` and `S3SessionManager` remain supported as the [compatibility path](#storage-backends) for Graph, Swarm, and existing repository-format sessions. TypeScript uses a single `SessionManager` for both.

`FileSessionManager` and `S3SessionManager` remain supported in Python, but use `SnapshotSessionManager` for new single-agent sessions.

### Multi-agent sessions

Multi-agent systems (Graph/Swarm) can also use session management to persist their state.

(( tab "Python" ))
Caution

Only the orchestrator should have a session manager. Agents inside a graph or swarm must not have their own session manager — Python raises a `ValueError` if you add an agent that has one to a Graph or Swarm.

Pass an explicit storage backend to [`SnapshotSessionManager`](/docs/api/python/strands.session.snapshot_session_manager):

```python
from strands import Agent
from strands.multiagent import GraphBuilder
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

researcher = Agent(name="researcher")
writer = Agent(name="writer")

session_manager = SnapshotSessionManager(
    session_id="multi-agent-session",
    storage=LocalFileStorage("./sessions/"),
    multi_agent_save_latest_on="node",
)

builder = GraphBuilder()
builder.add_node(researcher, "researcher")
builder.add_node(writer, "writer")
builder.add_edge("researcher", "writer")
builder.set_session_manager(session_manager)
graph = builder.build()

result = graph("Research and write about AI")
```

The default `"node"` strategy saves after every node and when the invocation ends. Use `"invocation"` to reduce storage writes and save only when the invocation ends. See the [API reference](/docs/api/python/strands.session.snapshot_session_manager) for `MultiAgentSaveLatestStrategy` and its accepted values.
(( /tab "Python" ))

(( tab "TypeScript" ))
Caution

Agents inside a multi-agent system must not have their own session manager: only the orchestrator should have one. The orchestrator captures and restores each agent node’s state on every execution, so an agent-level session manager would conflict with the orchestrator’s persistence.

```typescript
const session = new SessionManager({
  sessionId: 'graph-session',
  storage: new LocalFileStorage('./sessions/'),
})

const researcher = new Agent({
  id: 'researcher',
  systemPrompt: 'You are a research specialist.',
})
const writer = new Agent({
  id: 'writer',
  systemPrompt: 'You are a writing specialist.',
})

const graph = new Graph({
  nodes: [researcher, writer],
  edges: [['researcher', 'writer']],
  sessionManager: session,
})

// Orchestrator state is automatically persisted after each node completes
const result = await graph.invoke('Research and write about AI')
```

Swarm works the same way:

```typescript
const session = new SessionManager({
  sessionId: 'swarm-session',
  storage: new LocalFileStorage('./sessions/'),
})

const researcher = new Agent({
  id: 'researcher',
  description: 'Researches a topic and gathers key facts.',
  systemPrompt: 'Research the answer, then hand off to the writer.',
})

const writer = new Agent({
  id: 'writer',
  description: 'Writes a polished final answer.',
  systemPrompt: 'Write the final answer. Do not hand off.',
})

const swarm = new Swarm({
  nodes: [researcher, writer],
  start: 'researcher',
  sessionManager: session,
})

const result = await swarm.invoke('Explain quantum computing')
```
(( /tab "TypeScript" ))

Multi-agent session managers only track the current state of the Graph/Swarm execution and do not persist individual agent conversation histories.

## Reading the session ID

An agent exposes its session identifier through a readable `agent.session_id``agent.sessionId` property. When a session manager is attached, the property returns the manager’s `session_id``sessionId` (also readable directly on the session manager). Without a session manager, it returns a random 8-character hex string generated at construction, unique per agent instance but not persisted across restarts.

Snapshot-based session managers accept any [Storage](/docs/user-guide/sdk/storage/index.md) backend, including `InMemoryStorage`, `LocalFileStorage`, `S3Storage`, and custom implementations. See [Storage](/docs/user-guide/sdk/storage/index.md) for backend configuration, tradeoffs, custom backends, and required S3 permissions.

(( tab "Python" ))
```python
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

session_manager = SnapshotSessionManager(
    session_id="user-123",
    storage=LocalFileStorage("./sessions/"),
)
agent = Agent(session_manager=session_manager)

print(agent.session_id)            # "user-123"
print(session_manager.session_id)  # "user-123"

# Without a session manager, the id is a generated, non-persisted handle
print(Agent().session_id)          # e.g. "a1b2c3d4"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const session = new SessionManager({
  sessionId: 'user-123',
  storage: new LocalFileStorage('./sessions/'),
})
const agent = new Agent({ sessionManager: session })

console.log(agent.sessionId) // "user-123"
console.log(session.sessionId) // "user-123"

// Without a session manager, the id is a generated, non-persisted handle
console.log(new Agent().sessionId) // e.g. "a1b2c3d4"
```
(( /tab "TypeScript" ))

## Storage backends

[Storage](/docs/user-guide/sdk/storage/index.md) is the single place persistence backends are documented. How session management reaches a backend depends on the manager:

-   **`SnapshotSessionManager` (Python) and `SessionManager` (TypeScript)** compose the shared `Storage` abstraction: you pass any `Storage` backend and the manager persists snapshots through it. Manager-level storage takes precedence over an agent-level `storage`. If neither provides storage, Python falls back to `LocalFileStorage("./.strands/")` and TypeScript fails during initialization.
-   **`FileSessionManager` and `S3SessionManager` (Python, compatibility path)** configure storage directly with a storage directory or an S3 bucket. They do not take a `Storage` backend.

The examples below show each form.

(( tab "Python" ))
The recommended `SnapshotSessionManager` accepts any [Storage](/docs/user-guide/sdk/storage/index.md) backend, so you choose durability the same way the offloader and memory subsystems do:

```python
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage, S3Storage

# File-based persistence (development, single-machine)
session_manager = SnapshotSessionManager(
    session_id="user-123",
    storage=LocalFileStorage("./sessions/"),
)

# S3-based persistence (production, distributed)
session_manager = SnapshotSessionManager(
    session_id="user-123",
    storage=S3Storage(bucket="my-agent-sessions", prefix="production/"),
)

agent = Agent(session_manager=session_manager)
```

The repository-based managers cover Graph, Swarm, and existing repository-format sessions. They configure storage directly rather than through a `Storage` backend:

| Session Manager | Persistence | Best for |
| --- | --- | --- |
| [`FileSessionManager`](/docs/api/python/strands.session.file_session_manager#FileSessionManager) | Local disk | Development, single-machine |
| [`S3SessionManager`](/docs/api/python/strands.session.s3_session_manager#S3SessionManager) | Amazon S3 | Production, distributed |

```python
from strands import Agent
from strands.session import FileSessionManager, S3SessionManager

# File-based persistence
session_manager = FileSessionManager(
    session_id="user-123",
    storage_dir="/path/to/sessions",
)

# S3-based persistence
session_manager = S3SessionManager(
    session_id="user-123",
    bucket="my-agent-sessions",
    prefix="production/",
)

agent = Agent(session_manager=session_manager)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Pass storage to `SessionManager` or to the agent. Manager-level storage takes precedence over agent-level storage. If neither provides storage, initialization fails.
(( /tab "TypeScript" ))

## How session management works

### Snapshot-based session managers

`SnapshotSessionManager` in Python and `SessionManager` in TypeScript persist a complete point-in-time snapshot. For single agents, both restore `snapshot_latest` during initialization and support immutable checkpoints. For graph and swarm, both restore the latest orchestrator snapshot before the first invocation.

**Single Agent Events**

(( tab "Python" ))
-   **Agent Initialization**: When an agent is created with a session manager, it automatically restores any existing state and messages from the session.
-   **Message Addition**: When a new message is added to the conversation, it’s automatically persisted to the session (`SnapshotSessionManager` does this under `save_latest_on="message"`).
-   **Agent Invocation**: After each agent invocation, the agent state is synchronized with the session to capture any updates (`SnapshotSessionManager` default, `save_latest_on="invocation"`).
-   **Message Redaction**: When sensitive information needs to be redacted, the session manager replaces the original message with a redacted version while maintaining conversation flow. `SnapshotSessionManager` flushes the redacted content to the latest snapshot under every strategy.
-   **Snapshot Trigger** (`SnapshotSessionManager`): Creates an immutable checkpoint when the `snapshot_trigger` callback returns `True`.
(( /tab "Python" ))

(( tab "TypeScript" ))
-   **Agent Initialization**: Restores state from `snapshot_latest` if it exists.
-   **Message Addition** (`saveLatestOn: 'message'`): Saves after each message and again when the invocation ends.
-   **Agent Invocation** (`saveLatestOn: 'invocation'`, default): Saves when the invocation ends.
-   **Snapshot Trigger**: Creates an immutable checkpoint when `snapshotTrigger` returns `true`.
-   **Message Redaction**: Saves redacted content for the `message` and `invocation` strategies, but not for `trigger`.

See [Basic Usage](#basic-usage) for configuration examples.
(( /tab "TypeScript" ))

**Multi-Agent Events**

(( tab "Python" ))
-   **Before Multi-Agent Invocation**: Restores orchestrator state from `snapshot_latest` on the first invocation.
-   **After Node Call** (`multi_agent_save_latest_on="node"`, default): Saves after each node and again when the invocation ends.
-   **After Multi-Agent Invocation** (`multi_agent_save_latest_on="invocation"`): Saves only when the full invocation ends.
(( /tab "Python" ))

(( tab "TypeScript" ))
-   **Before Multi-Agent Invocation**: Restores orchestrator state from `snapshot_latest` on the first invocation.
-   **After Node Call** (`multiAgentSaveLatestOn: 'node'`, default): Saves after each node and again when the invocation ends.
-   **After Multi-Agent Invocation** (`multiAgentSaveLatestOn: 'invocation'`): Saves only when the full invocation ends.

```typescript
const session = new SessionManager({
  sessionId: 'my-session',
  storage: new LocalFileStorage('./sessions/'),
  // Save orchestrator state after each node completes (default)
  multiAgentSaveLatestOn: 'node',
  // Or save only after the full orchestrator invocation completes:
  // multiAgentSaveLatestOn: 'invocation',
})
```
(( /tab "TypeScript" ))

### Repository-based session managers

Python only

Repository-based session managers are available in the Python SDK only.

## Immutable snapshots

A [snapshot](/docs/user-guide/sdk/agents/snapshots/index.md) captures agent state at a point in time. Snapshot-based session managers persist them for you: alongside `snapshot_latest`, `SnapshotSessionManager` (Python) and `SessionManager` (TypeScript) keep **immutable snapshots**, append-only checkpoints identified by UUID v7. These enable time-travel restore: you can restore the agent to any prior checkpoint, not just the latest state.

### Creating immutable snapshots

Use the snapshot-trigger callback to control when an immutable snapshot is created. The callback receives the current agent data and returns a boolean:

(( tab "Python" ))
```python
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

session_manager = SnapshotSessionManager(
    session_id="my-session",
    storage=LocalFileStorage("./sessions/"),
    snapshot_trigger=lambda *, agent_data, **_: len(agent_data.messages) % 4 == 0,
)

agent = Agent(session_manager=session_manager)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const session = new SessionManager({
  sessionId: 'my-session',
  storage: new LocalFileStorage('./sessions/'),
  // Create an immutable snapshot after every 4 messages
  snapshotTrigger: ({ agentData }) => agentData.messages.length % 4 === 0,
})

const agent = new Agent({ sessionManager: session })
await agent.invoke('First message') // 2 messages, no snapshot
await agent.invoke('Second message') // 4 messages, immutable snapshot created
```
(( /tab "TypeScript" ))

### Listing and restoring snapshots

Snapshot IDs are UUID v7, so they sort lexicographically in chronological order. Use `list_snapshot_ids``listSnapshotIds` on the session manager to retrieve them, then pass a `snapshot_id``snapshotId` to `restore_snapshot``restoreSnapshot`:

(( tab "Python" ))
```python
import asyncio

from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

session_manager = SnapshotSessionManager(
    session_id="my-session",
    storage=LocalFileStorage("./sessions/"),
)
agent = Agent(session_manager=session_manager)


async def restore() -> None:
    # Force an immutable checkpoint and read it back later
    snapshot_id = await session_manager.save_snapshot(agent, is_latest=False)
    snapshot_ids = await session_manager.list_snapshot_ids(agent)
    assert snapshot_id in snapshot_ids
    await session_manager.restore_snapshot(agent, snapshot_id=snapshot_id)


asyncio.run(restore())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const storage = new LocalFileStorage('./sessions/')

const session = new SessionManager({
  sessionId: 'my-session',
  storage,
})
const agent = new Agent({ sessionManager: session })
await agent.initialize()

// List all immutable snapshot IDs (chronological order)
const snapshotIds = await session.listSnapshotIds({
  target: agent,
})

// Restore agent to a specific checkpoint
await session.restoreSnapshot({
  target: agent,
  snapshotId: snapshotIds[0]!,
})
```
(( /tab "TypeScript" ))

## Deleting sessions

To remove all snapshots for a session, call the session manager’s delete method. This removes the entire session root directory (filesystem) or all objects under the session prefix (S3):

(( tab "Python" ))
```python
import asyncio

from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

session_manager = SnapshotSessionManager(
    session_id="my-session",
    storage=LocalFileStorage("./sessions/"),
)
asyncio.run(session_manager.delete_session())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const session = new SessionManager({
  sessionId: 'my-session',
  storage: new LocalFileStorage('./sessions/'),
})

// Remove all snapshots and manifests for this session
await session.deleteSession()
```
(( /tab "TypeScript" ))

## Data models

(( tab "Python" ))
`SnapshotSessionManager` stores a single versioned [`Snapshot`](/docs/user-guide/sdk/agents/snapshots/index.md) JSON blob whose `data` field carries the messages, agent state, conversation manager state, interrupt state, model state, and system prompt.

The record-based models below apply to `FileSessionManager`, `S3SessionManager`, and `RepositorySessionManager`, which persist each message individually:

**Session**

The [`Session`](/docs/api/python/strands.types.session#Session) model is the top-level container for session data:

-   **Purpose**: Provides a namespace for organizing multiple agents and their interactions
-   **Key Fields**:
    -   `session_id`: Unique identifier for the session
    -   `session_type`: Type of session (currently `"AGENT"` for both agent & multiagent in order to keep backward compatibility)
    -   `created_at`: ISO format timestamp of when the session was created
    -   `updated_at`: ISO format timestamp of when the session was last updated

**SessionAgent**

The [`SessionAgent`](/docs/api/python/strands.types.session#SessionAgent) model stores agent-specific data:

-   **Purpose**: Maintains the state and configuration of a specific agent within a session
-   **Key Fields**:
    -   `agent_id`: Unique identifier for the agent within the session
    -   `state`: Dictionary containing the agent’s state data (key-value pairs)
    -   `conversation_manager_state`: Dictionary containing the state of the conversation manager
    -   `created_at`: ISO format timestamp of when the agent was created
    -   `updated_at`: ISO format timestamp of when the agent was last updated

**SessionMessage**

The [`SessionMessage`](/docs/api/python/strands.types.session#SessionMessage) model stores individual messages in the conversation:

-   **Purpose**: Preserves the conversation history with support for message redaction
-   **Key Fields**:
    -   `message`: The original message content (role, content blocks)
    -   `redact_message`: Optional redacted version of the message (used when sensitive information is detected)
    -   `message_id`: Index of the message in the agent’s messages array
    -   `created_at`: ISO format timestamp of when the message was created
    -   `updated_at`: ISO format timestamp of when the message was last updated

These data models work together to provide a complete representation of an agent’s state and conversation history. The session management system handles serialization and deserialization of these models, including special handling for binary data using base64 encoding.

**Multi-Agent State**

Multi-agent systems serialize their state as JSON objects containing:

-   **Orchestrator Configuration**: Settings, parameters, and execution preferences
-   **Node State**: Current execution state and node transition history
-   **Shared Context**: Cross-agent shared state and variables
(( /tab "Python" ))

(( tab "TypeScript" ))
The TypeScript SDK stores session state as a `Snapshot` object written to JSON. Each snapshot contains:

-   `data.messages`: The full conversation history
-   `data.state`: Agent key-value state
-   `data.systemPrompt`: The agent’s system prompt
-   `schemaVersion`: Schema version for forward compatibility
-   `createdAt`: ISO 8601 timestamp

There are two kinds of snapshots:

-   **`snapshot_latest.json`**: A single mutable file overwritten on each save. Used to resume the most recent state after a restart.
-   **Immutable snapshots** (`immutable_history/snapshot_<uuid7>.json`): Append-only checkpoints created when `snapshotTrigger` fires. Used for time-travel restore.
(( /tab "TypeScript" ))

## Third-party session managers

The following third-party session managers extend Strands with additional storage and memory capabilities:

| Session Manager | Provider | Description | Documentation |
| --- | --- | --- | --- |
| AgentCoreMemorySessionManager | Amazon | Advanced memory with intelligent retrieval using Amazon Bedrock AgentCore Memory. Supports both short-term memory (STM) and long-term memory (LTM) with strategies for user preferences, facts, and session summaries. | [View Documentation](/docs/integrations/session-managers/agentcore-memory/index.md) |
| **Contribute Your Own** | Community | Have you built a session manager? Share it with the community! | [Learn How](/integrations/index.md) |

## Custom session repositories

For advanced use cases, you can implement your own session storage backend.

(( tab "Python" ))
For new single-agent sessions, implement a [custom `Storage` backend](/docs/user-guide/sdk/storage/index.md#custom-backends) and pass it to `SnapshotSessionManager`: the manager owns the session layout, so the backend only moves bytes.

To customize a repository-based session, implement the `SessionRepository` interface:

```python
from typing import Optional
from strands import Agent
from strands.session.repository_session_manager import RepositorySessionManager
from strands.session.session_repository import SessionRepository
from strands.types.session import Session, SessionAgent, SessionMessage

class CustomSessionRepository(SessionRepository):
    """Custom session repository implementation."""

    def __init__(self):
        """Initialize with your custom storage backend."""
        # Initialize your storage backend (e.g., database connection)
        self.db = YourDatabaseClient()

    def create_session(self, session: Session) -> Session:
        """Create a new session."""
        self.db.sessions.insert(asdict(session))
        return session

    def read_session(self, session_id: str) -> Optional[Session]:
        """Read a session by ID."""
        data = self.db.sessions.find_one({"session_id": session_id})
        if data:
            return Session.from_dict(data)
        return None

    # Implement other required methods...
    # create_agent, read_agent, update_agent
    # create_message, read_message, update_message, list_messages

# Use your custom repository with RepositorySessionManager
custom_repo = CustomSessionRepository()
session_manager = RepositorySessionManager(
    session_id="user-789",
    session_repository=custom_repo
)

agent = Agent(session_manager=session_manager)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
The simplest approach is to pass any [Storage](/docs/user-guide/sdk/storage/index.md) backend directly: the `SessionManager` wraps it automatically. For full control, implement the `SnapshotStorage` interface:

```typescript
// Implement SnapshotStorage to plug in any backend
class MyStorage implements SnapshotStorage {
  async saveSnapshot({
    location,
    snapshotId,
    snapshot,
  }: {
    location: SnapshotLocation
    snapshotId: string
    isLatest: boolean
    snapshot: Snapshot
  }) {
    // Store the snapshot JSON keyed by location + snapshotId
  }

  async loadSnapshot({
    location,
    snapshotId,
  }: {
    location: SnapshotLocation
    snapshotId?: string
  }) {
    // Return the snapshot, or null if not found
    return null
  }

  async listSnapshotIds({
    location,
  }: {
    location: SnapshotLocation
    limit?: number
    startAfter?: string
  }) {
    // Return immutable snapshot IDs sorted chronologically
    return []
  }

  async deleteSession({ sessionId }: { sessionId: string }) {
    // Remove all stored data for this session
  }

  async loadManifest({
    location,
  }: {
    location: SnapshotLocation
  }): Promise<SnapshotManifest> {
    return {
      schemaVersion: '1',
      updatedAt: new Date().toISOString(),
    }
  }

  async saveManifest({
    location,
    manifest,
  }: {
    location: SnapshotLocation
    manifest: SnapshotManifest
  }) {
    // Persist the manifest
  }
}

const agent = new Agent({
  sessionManager: new SessionManager({
    sessionId: 'user-789',
    storage: { snapshot: new MyStorage() },
  }),
})
```
(( /tab "TypeScript" ))

This lets you store session data in any backend while reusing the built-in session management logic.

## Data layout

Both file and S3 backends use the same key structure:

(( tab "Python" ))
`SnapshotSessionManager` layout (recommended for new single-agent sessions). The `Storage` backend prepends a `session/` namespace, so the layout is byte-identical to the TypeScript SDK:

```plaintext
<root>/
└── session/
    └── <session_id>/
        └── scopes/
            └── agent/
                └── <agent_id>/
                    └── snapshots/
                        ├── snapshot_latest.json
                        └── immutable_history/
                            └── snapshot_<uuid7>.json
```

Repository-based layout (`FileSessionManager`, `S3SessionManager`):

```plaintext
<root>/
└── session_<session_id>/
    ├── session.json
    ├── agents/
    │   └── agent_<agent_id>/
    │       ├── agent.json
    │       └── messages/
    │           ├── message_0.json
    │           └── message_1.json
    └── multi_agents/
        └── multi_agent_<orchestrator_id>/
            └── multi_agent.json
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```plaintext
<root>/
└── <sessionId>/
    └── scopes/
        ├── agent/
        │   └── <agentId>/
        │       └── snapshots/
        │           ├── snapshot_latest.json
        │           └── immutable_history/
        │               └── snapshot_<uuid7>.json
        └── multiAgent/
            └── <orchestratorId>/
                └── snapshots/
                    └── snapshot_latest.json
```
(( /tab "TypeScript" ))

Using the same session ID and storage location does not migrate repository-based Python data to `SnapshotSessionManager`. Existing sessions can continue using their current manager, or applications can migrate the required state explicitly.

## Sessions, agents, and concurrency

Session management is designed around a single live writer per conversation: the session ID plus the agent ID (`agent_id``id`), or the orchestrator ID for a Graph or Swarm, address one conversation thread in storage.

### One conversation per session

Give each conversation its own session ID. Several agents can share one session ID as long as their agent IDs differ: the session acts as a namespace, and each agent keeps its own messages and state inside it. A single agent instance processes one invocation at a time by default and rejects overlap, as described in [Concurrent Invocations](/docs/user-guide/sdk/agents/agent-loop/index.md#concurrent-invocations).

### Create an agent per conversation

Constructing an agent is cheap: it wires up tools, hooks, and plugins locally and makes no model call. Build one per request, invoke it, and let it go out of scope. The model provider is the part worth reusing: providers such as `BedrockModel` build their client in the constructor, so create the provider once per process and pass the same instance to every agent.

### Common failure modes

The built-in session managers take no distributed lock, and the single-instance invocation guard is in-process, so neither can detect a second writer running elsewhere. Two patterns result:

-   **Two live agents addressing the same session ID and agent ID.** The default IDs (`agent_id="default"``id: 'agent'`) make this easy to do by accident, including across separate executions that each build their own agent. Overlapping invocations overwrite each other’s turns, sequential ones merge two conversations into one history, and neither call errors.
-   **Two callers creating the same session at the same time.** Session creation is a check followed by a write, not an atomic operation, so simultaneous cold starts on a new session ID can both succeed, with the later write winning.

## Session persistence best practices

When implementing session persistence in your applications, consider these best practices:

-   **Use Unique Session IDs**: Generate unique session IDs for each user or conversation context to prevent data overlap.
-   **Session Cleanup**: Implement a strategy for cleaning up old or inactive sessions. Consider adding TTL (Time To Live) for sessions in production environments.
-   **Understand Persistence Triggers**: Remember that changes to agent state or messages are only persisted during specific lifecycle events.
-   **Concurrent Access**: Session managers are not thread-safe and take no distributed lock. See [Sessions, Agents, and Concurrency](#sessions-agents-and-concurrency).
-   **Secure Storage Directories**: The session storage directory is a trusted data store. Session state is trusted input, so do not load sessions from untrusted sources, such as session files inside a cloned repository. Restrict filesystem permissions so that only the agent process can read and write to it. In shared or multi-tenant environments (shared volumes, containers), be aware that the SDK does not block symlinks in the session storage directory. If an attacker with write access to the storage directory creates a symlink (e.g., `message_0.json` pointing to an arbitrary file), the SDK will follow it, which could cause sensitive file contents to be loaded into the agent’s conversation history.

## Related pages

- [State Management](/docs/user-guide/sdk/agents/state/index.md) (3 shared tags)
- [Session Management](/docs/user-guide/sdk/bidi/session-management/index.md) (2 shared tags)
- [Search Strategies](/docs/user-guide/sdk/storage/search-strategies/index.md) (1 shared tag)
- [Storage](/docs/user-guide/sdk/storage/index.md) (1 shared tag)
- [OpenAI Responses API](/docs/user-guide/sdk/model-providers/openai-responses/index.md) (1 shared tag)
- [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/session/session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py)
- [harness-sdk/strands-py/src/strands/session/snapshot_session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py)
- [harness-sdk/strands-py/src/strands/session/file_session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py)
- [harness-sdk/strands-py/src/strands/session/s3_session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/s3_session_manager.py)
- [harness-sdk/strands-py/src/strands/storage/storage.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/storage.py)

### TypeScript

- [harness-sdk/strands-ts/src/session/session-manager.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/session/session-manager.ts)
