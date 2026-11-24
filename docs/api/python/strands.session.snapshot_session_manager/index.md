Snapshot-based session manager.

Persists an agent as a single versioned :class:`~strands.types._snapshot.Snapshot` blob on each lifecycle event:

-   A mutable `snapshot_latest` is overwritten on each save, for crash/restart resume.
-   Append-only immutable snapshots (time-ordered keys) are written when a `snapshot_trigger` fires, enabling checkpointing — restore to any prior state, not just the latest.

The manager persists snapshots through the unified :class:`~strands.storage.storage.Storage` primitive (`write`/`read`/`delete`/`list` over byte blobs). It owns the key layout, snapshot-id scheme, and serialization; the storage backend only moves bytes, so the same `Storage` instance can back sessions, memory, and other subsystems.

This is distinct from the older message-log session managers (:class:`~strands.session.repository_session_manager.RepositorySessionManager` and its subclasses), which persist each message individually. Snapshots capture the whole agent in one atomic blob and are the recommended path for new agents.

#### SaveLatestStrategy

Controls how often an Agent’s `snapshot_latest` is saved automatically.

-   `"invocation"`: after every agent invocation completes (default; balances durability and I/O).
-   `"message"`: after every message added, plus the invocation save above (most durable, highest I/O).
-   `"trigger"`: only when `snapshot_trigger` fires (or manually via `save_snapshot`).

Guardrail redactions are flushed immediately under every strategy, including `"trigger"`, so pre-redaction content never sits at rest. This diverges from the TypeScript SDK, which does not flush redactions under `"trigger"`; see :meth:`SnapshotSessionManager.redact_latest_message`.

#### BidiAgentSaveLatestStrategy

Controls how often a BidiAgent’s `snapshot_latest` is saved automatically.

-   `"message"`: after every message addition or replacement, plus the stop/restart save below (default; a streaming session has no invocation boundary, so a mid-session crash resumes at the last completed transcript entry instead of losing the connection’s whole history).
-   `"stop"`: after the agent stops and before a connection restart (lower I/O; a crash loses history since the last save).
-   `"trigger"`: only when `snapshot_trigger` fires (or manually via `save_snapshot`).

A response completing is not a save point. Stop/restart saves and `snapshot_trigger` evaluation run on `BidiAgentStopEvent` and `BidiBeforeConnectionRestartEvent`.

#### MultiAgentSaveLatestStrategy

Controls how often an orchestrator’s `snapshot_latest` is saved automatically.

-   `"node"`: after every node completes (default; a mid-run crash resumes at the last node).
-   `"invocation"`: only after the whole orchestrator invocation completes (lower I/O; a crash loses the in-flight run). A large Graph on a remote store can opt down to this.

Orchestrators are latest-only — no immutable history and no `snapshot_trigger`.

## SnapshotTrigger

```python
@runtime_checkable
class SnapshotTrigger(Protocol)
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:204](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L204)

Decides whether to write an immutable checkpoint at a persistence boundary.

#### \_\_call\_\_

```python
def __call__(*, agent_data: LocalAgent, **kwargs: Any) -> bool
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:207](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L207)

Return True to append an immutable snapshot for the given agent.

**Arguments**:

-   `agent_data` - The agent that just completed an invocation, or the BidiAgent that just stopped or is about to restart its connection.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

True to create an immutable checkpoint, False otherwise.

## SnapshotSessionManager

```python
class SnapshotSessionManager(SessionManager[LocalAgent])
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:221](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L221)

Persists agent snapshots to a :class:`~strands.storage.storage.Storage` across invocations.

On agent initialization the latest snapshot is restored automatically. On each qualifying lifecycle event the agent is re-captured and `snapshot_latest` is overwritten. When `snapshot_trigger` returns True after an invocation, an additional immutable snapshot is appended for time-travel restore.

Single agents get immutable time-travel snapshots via `snapshot_trigger`. Graph and Swarm orchestrators are persisted latest-only: state is captured after each node (or each invocation, per `multi_agent_save_latest_on`) and restored lazily on their first invocation. A BidiAgent is restored before its connection starts and captured after each message or stop and before connection restarts (per `bidi_agent_save_latest_on`).

**Example**:

```python
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

session = SnapshotSessionManager("my-session", storage=LocalFileStorage())
agent = Agent(session_manager=session)
```

#### \_\_init\_\_

```python
def __init__(
        session_id: str = "default-session",
        *,
        storage: Storage | None = None,
        save_latest_on: SaveLatestStrategy = "invocation",
        bidi_agent_save_latest_on: BidiAgentSaveLatestStrategy = "message",
        multi_agent_save_latest_on: MultiAgentSaveLatestStrategy = "node",
        snapshot_trigger: SnapshotTrigger | None = None,
        **kwargs: Any) -> None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:246](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L246)

Initialize the snapshot session manager.

**Arguments**:

-   `session_id` - Unique session identifier. Must not contain path separators.
-   `storage` - Unified storage backend that persists snapshot blobs. When None, resolves from the agent-level `storage` during initialization; if no agent-level storage is available, falls back to :class:`~strands.storage.local_file_storage.LocalFileStorage`.
-   `save_latest_on` - For an Agent, when to overwrite `snapshot_latest`. See :data:`SaveLatestStrategy`.
-   `bidi_agent_save_latest_on` - For a BidiAgent, when to overwrite `snapshot_latest`. See :data:`BidiAgentSaveLatestStrategy`.
-   `multi_agent_save_latest_on` - For Graph/Swarm orchestrators, when to overwrite the orchestrator’s `snapshot_latest`. See :data:`MultiAgentSaveLatestStrategy`.
-   `snapshot_trigger` - Optional callback invoked after each invocation, after a BidiAgent stops, or before its connection restarts. When it returns True an immutable snapshot is appended for checkpointing. An immutable snapshot can also be forced at any point via :meth:`save_snapshot`.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Raises**:

-   `ValueError` - If `session_id` is empty, is a relative-path segment (`.` or `..`), normalizes to empty, or contains a path separator; or if any `*save_latest_on` value is not a recognized strategy.

#### register\_hooks

```python
def register_hooks(registry: HookRegistry, **kwargs: Any) -> None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:325](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L325)

Register lifecycle callbacks for snapshot persistence.

Overrides the base wiring: the message-log callbacks are replaced with snapshot save/restore handlers.

#### initialize

```python
def initialize(agent: LocalAgent, **kwargs: Any) -> None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:416](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L416)

Restore the agent from its latest snapshot, if one exists.

Storage is resolved on the first call and cached; a single manager instance should not be shared across agents with differing storage backends.

**Arguments**:

-   `agent` - Agent to restore.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### sync\_agent

```python
def sync_agent(agent: LocalAgent, **kwargs: Any) -> None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:434](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L434)

Capture the agent and overwrite `snapshot_latest`.

**Arguments**:

-   `agent` - Agent to persist.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### redact\_latest\_message

```python
def redact_latest_message(redact_message: Message, agent: LocalAgent,
                          **kwargs: Any) -> None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:443](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L443)

Persist immediately after a guardrail redaction, under every strategy.

The Agent has already applied the redaction to the last user message before calling this, so re-capturing the agent flushes pre-redaction content out of the persisted latest snapshot. This flush happens regardless of `save_latest_on` (including `"trigger"`) because the Agent invokes this method directly, not through a hook the manager could decline to register — so pre-redaction content never sits at rest. This diverges from the TypeScript SDK, which gates redaction persistence behind an `AfterModelCall` hook it skips under `"trigger"` and therefore does not flush there.

**Arguments**:

-   `redact_message` - The redacted replacement message (already applied by the Agent).
-   `agent` - Agent whose last user message was redacted.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### append\_message

```python
def append_message(message: Message, agent: LocalAgent, **kwargs: Any) -> None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:461](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L461)

No-op — snapshots capture the whole agent.

Per-message persistence under the `"message"` strategy is handled by the `MessageAddedEvent` hook, not by this method.

**Arguments**:

-   `message` - The message that was appended (unused).
-   `agent` - The agent the message was appended to (unused).
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### list\_snapshot\_ids

```python
async def list_snapshot_ids(agent: LocalAgent,
                            *,
                            limit: int | None = None,
                            start_after: str | None = None) -> list[str]
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:475](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L475)

List immutable snapshot ids for an agent, oldest first.

**Arguments**:

-   `agent` - Agent whose snapshots to list.
-   `limit` - Optional cap on the number of ids returned.
-   `start_after` - Exclusive cursor; a snapshot id from a prior page.

**Returns**:

Immutable snapshot ids in chronological order.

**Raises**:

-   `ValueError` - If `start_after` is not a valid snapshot id.

#### restore\_snapshot

```python
async def restore_snapshot(agent: LocalAgent,
                           *,
                           snapshot_id: str | None = None) -> bool
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:509](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L509)

Restore an agent from a stored snapshot.

**Arguments**:

-   `agent` - Agent to restore into. A BidiAgent must be stopped.
-   `snapshot_id` - The immutable snapshot id to restore (time travel). Omit to restore `snapshot_latest`, the same snapshot restore-on-init loads.

**Returns**:

True if the snapshot existed and was restored, False otherwise.

**Raises**:

-   `ValueError` - If `snapshot_id` is given and is not a valid snapshot id.
-   `RuntimeError` - If a BidiAgent is started.

#### save\_snapshot

```python
async def save_snapshot(agent: LocalAgent, *, is_latest: bool) -> str | None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:526](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L526)

Save a snapshot of the agent’s current state on demand.

Use `is_latest=False` to force an immutable checkpoint at an arbitrary point (independent of `snapshot_trigger`), so it can later be restored with :meth:`restore_snapshot`; use `is_latest=True` to overwrite `snapshot_latest`.

**Arguments**:

-   `agent` - Agent whose state to capture.
-   `is_latest` - When True, overwrite `snapshot_latest` (a single mutable snapshot). When False, append a new immutable snapshot under a fresh, time-ordered id.

**Returns**:

The new immutable snapshot id, ready to pass to :meth:`restore_snapshot`, or `None` when `is_latest=True` (`snapshot_latest` is not addressed by id).

#### delete\_session

```python
async def delete_session() -> None
```

Defined in: [src/strands/session/snapshot\_session\_manager.py:550](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/snapshot_session_manager.py#L550)

Delete all snapshots and archive data for this session.