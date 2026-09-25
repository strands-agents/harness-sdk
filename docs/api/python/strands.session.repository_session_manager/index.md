Repository session manager implementation.

## RepositorySessionManager

```python
class RepositorySessionManager(SessionManager[LocalAgent])
```

Defined in: [src/strands/session/repository\_session\_manager.py:27](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L27)

Session manager for persisting agents in a SessionRepository.

This manager uses a :class:`SessionRepository` (a structured per-message CRUD interface), not the unified :class:`~strands.storage.storage.Storage` protocol. It does not resolve from the agent-level `storage` parameter. For snapshot-based persistence that integrates with agent-level storage, use :class:`~strands.session.snapshot_session_manager.SnapshotSessionManager`.

#### \_\_init\_\_

```python
def __init__(session_id: str, session_repository: SessionRepository,
             **kwargs: Any)
```

Defined in: [src/strands/session/repository\_session\_manager.py:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L39)

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

Defined in: [src/strands/session/repository\_session\_manager.py:80](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L80)

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

Defined in: [src/strands/session/repository\_session\_manager.py:100](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L100)

Redact the latest message appended to the session.

**Arguments**:

-   `redact_message` - New message to use that contains the redact content
-   `agent` - Agent to apply the message redaction to
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### sync\_agent

```python
def sync_agent(agent: "LocalAgent", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:119](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L119)

Serialize and update the agent into the session repository.

For Agent, only updates if state or internal state has changed. BidiAgent is written on every sync, preserving its existing persistence behavior.

**Arguments**:

-   `agent` - Agent to sync to the session.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### initialize

```python
def initialize(agent: "LocalAgent", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:210](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L210)

Initialize an agent with a session.

**Arguments**:

-   `agent` - Agent to initialize from the session
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### sync\_multi\_agent

```python
def sync_multi_agent(source: "MultiAgentBase", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:390](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L390)

Serialize and update the multi-agent state into the session repository.

**Arguments**:

-   `source` - Multi-agent source object to sync to the session.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### initialize\_multi\_agent

```python
def initialize_multi_agent(source: "MultiAgentBase", **kwargs: Any) -> None
```

Defined in: [src/strands/session/repository\_session\_manager.py:399](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py#L399)

Initialize multi-agent state from the session repository.

**Arguments**:

-   `source` - Multi-agent source object to restore state into
-   `**kwargs` - Additional keyword arguments for future extensibility.