Repository session manager implementation.

## RepositorySessionManager

```python
class RepositorySessionManager(SessionManager[LocalAgent])
```

Defined in: [src/strands/session/repository\_session\_manager.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L28)

Session manager for persisting agents in a SessionRepository.

This manager uses a :class:`SessionRepository` (a structured per-message CRUD interface), not the unified :class:`~strands.storage.storage.Storage` protocol. It does not resolve from the agent-level `storage` parameter. For snapshot-based persistence that integrates with agent-level storage, use :class:`~strands.session.snapshot_session_manager.SnapshotSessionManager`.

This manager does not support an agent `context_manager`. Each message is persisted once, so the edits a context manager makes to history (truncated tool results, in-place summaries) and its stash of offloaded content are not saved, and a restore reloads the unreduced history. Use :class:`~strands.session.snapshot_session_manager.SnapshotSessionManager` with a context manager.

#### \_\_init\_\_

```python
def __init__(session_id: str, session_repository: SessionRepository,
             **kwargs: Any)
```

Defined in: [src/strands/session/repository\_session\_manager.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L42)

Initialize the RepositorySessionManager.

If no session with the specified session\_id exists yet, it will be created in the session\_repository.

**Arguments**:

-   `session_id` - ID to use for the session. A new session with this id will be created if it does not exist in the repository yet
-   `session_repository` - Underlying session repository to use to store the sessions state.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### append\_message

```python
def append_message(message: Message, agent: "LocalAgent",
                   **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:83](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L83)

Append a message to the agent’s session.

**Arguments**:

-   `message` - Message to add to the agent in the session
-   `agent` - Agent to append the message to
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### redact\_latest\_message

```python
def redact_latest_message(redact_message: Message, agent: "LocalAgent",
                          **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:103](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L103)

Redact the stored message that holds `redact_message`.

A stored message holds it when it is the same object or has the same tracking id. When none does, the latest message appended to the session is redacted if it has the same role.

**Arguments**:

-   `redact_message` - New message to use that contains the redact content
-   `agent` - Agent to apply the message redaction to
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### sync\_agent

```python
def sync_agent(agent: "LocalAgent", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:139](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L139)

Serialize and update the agent into the session repository.

For Agent, only updates if state or internal state has changed. Other LocalAgent implementations are written on every sync.

**Arguments**:

-   `agent` - Agent to sync to the session.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### initialize

```python
def initialize(agent: "LocalAgent", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:230](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L230)

Initialize an agent with a session.

**Arguments**:

-   `agent` - Agent to initialize from the session
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### sync\_multi\_agent

```python
def sync_multi_agent(source: "MultiAgentBase", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:406](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L406)

Serialize and update the multi-agent state into the session repository.

**Arguments**:

-   `source` - Multi-agent source object to sync to the session.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### initialize\_multi\_agent

```python
def initialize_multi_agent(source: "MultiAgentBase", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:415](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L415)

Initialize multi-agent state from the session repository.

**Arguments**:

-   `source` - Multi-agent source object to restore state into
-   `**kwargs` - Additional keyword arguments for future extensibility.