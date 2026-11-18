File-based session manager for local filesystem storage.

## FileSessionManager

```python
class FileSessionManager(RepositorySessionManager, SessionRepository)
```

Defined in: [src/strands/session/file\_session\_manager.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L36)

File-based session manager for local filesystem storage.

Creates the following filesystem structure for the session storage:

```bash
/<sessions_dir>/
└── session_<session_id>/
    ├── session.json                # Session metadata
    └── agents/
        └── agent_<agent_id>/
            ├── agent.json          # Agent metadata
            └── messages/
                ├── message_<id1>.json
                └── message_<id2>.json
```

#### \_\_init\_\_

```python
def __init__(session_id: str, storage_dir: str | None = None, **kwargs: Any)
```

Defined in: [src/strands/session/file\_session\_manager.py:53](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L53)

Initialize FileSession with filesystem storage.

**Arguments**:

-   `session_id` - ID for the session. ID is not allowed to contain path separators (e.g., a/b).
-   `storage_dir` - Directory for local filesystem storage. Defaults to a user-private `~/.strands/sessions/` directory. A new directory is created with mode `0o700`. An existing directory keeps its permissions; on POSIX a `UserWarning` is emitted if it is accessible by group or others.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### create\_session

```python
def create_session(session: Session, **kwargs: Any) -> Session
```

Defined in: [src/strands/session/file\_session\_manager.py:186](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L186)

Create a new session.

#### read\_session

```python
def read_session(session_id: str, **kwargs: Any) -> Session | None
```

Defined in: [src/strands/session/file\_session\_manager.py:204](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L204)

Read session data.

#### delete\_session

```python
def delete_session(session_id: str, **kwargs: Any) -> None
```

Defined in: [src/strands/session/file\_session\_manager.py:213](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L213)

Delete session and all associated data.

#### create\_agent

```python
def create_agent(session_id: str, session_agent: SessionAgent,
                 **kwargs: Any) -> None
```

Defined in: [src/strands/session/file\_session\_manager.py:221](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L221)

Create a new agent in the session.

#### read\_agent

```python
def read_agent(session_id: str, agent_id: str,
               **kwargs: Any) -> SessionAgent | None
```

Defined in: [src/strands/session/file\_session\_manager.py:233](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L233)

Read agent data.

#### update\_agent

```python
def update_agent(session_id: str, session_agent: SessionAgent,
                 **kwargs: Any) -> None
```

Defined in: [src/strands/session/file\_session\_manager.py:242](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L242)

Update agent data.

#### create\_message

```python
def create_message(session_id: str, agent_id: str,
                   session_message: SessionMessage, **kwargs: Any) -> None
```

Defined in: [src/strands/session/file\_session\_manager.py:253](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L253)

Create a new message for the agent.

#### read\_message

```python
def read_message(session_id: str, agent_id: str, message_id: int,
                 **kwargs: Any) -> SessionMessage | None
```

Defined in: [src/strands/session/file\_session\_manager.py:263](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L263)

Read message data.

#### update\_message

```python
def update_message(session_id: str, agent_id: str,
                   session_message: SessionMessage, **kwargs: Any) -> None
```

Defined in: [src/strands/session/file\_session\_manager.py:271](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L271)

Update message data.

#### list\_messages

```python
def list_messages(session_id: str,
                  agent_id: str,
                  limit: int | None = None,
                  offset: int = 0,
                  **kwargs: Any) -> list[SessionMessage]
```

Defined in: [src/strands/session/file\_session\_manager.py:283](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L283)

List messages for an agent with pagination.

#### create\_multi\_agent

```python
def create_multi_agent(session_id: str, multi_agent: "MultiAgentBase",
                       **kwargs: Any) -> None
```

Defined in: [src/strands/session/file\_session\_manager.py:323](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L323)

Create a new multiagent state in the session.

#### read\_multi\_agent

```python
def read_multi_agent(session_id: str, multi_agent_id: str,
                     **kwargs: Any) -> dict[str, Any] | None
```

Defined in: [src/strands/session/file\_session\_manager.py:333](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L333)

Read multi-agent state from filesystem.

#### update\_multi\_agent

```python
def update_multi_agent(session_id: str, multi_agent: "MultiAgentBase",
                       **kwargs: Any) -> None
```

Defined in: [src/strands/session/file\_session\_manager.py:340](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py#L340)

Update multi-agent state from filesystem.