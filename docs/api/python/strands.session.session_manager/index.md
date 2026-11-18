Session manager interface for agent session management.

## SessionManager

```python
class SessionManager(HookProvider, ABC, Generic[_SessionAgentT])
```

Defined in: [src/strands/session/session\_manager.py:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L31)

Abstract interface for managing sessions.

A session manager is in charge of persisting the conversation and state of an agent across its interaction. Changes made to the agents conversation, state, or other attributes should be persisted immediately after they are changed. The different methods introduced in this class are called at important lifecycle events for an agent, and should be persisted in the session.

The agent type defaults to Agent.

#### session\_id

The unique session identifier for this session manager.

#### register\_hooks

```python
def register_hooks(registry: HookRegistry, **kwargs: Any) -> None
```

Defined in: [src/strands/session/session\_manager.py:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L45)

Register hooks for persisting the agent to the session.

#### redact\_latest\_message

```python
@abstractmethod
def redact_latest_message(redact_message: Message, agent: _SessionAgentT,
                          **kwargs: Any) -> None
```

Defined in: [src/strands/session/session\_manager.py:64](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L64)

Redact the agent’s last user message in the session.

The message is not necessarily the one most recently appended to the session, so implementations should locate the stored record by `redact_message`’s identity or `tracking_id`. When no stored record matches, they should not overwrite a record with a different role: `RepositorySessionManager` falls back to the newest record only if its role matches, and otherwise stores nothing.

**Arguments**:

-   `redact_message` - New message to use that contains the redact content
-   `agent` - Agent to apply the message redaction to
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### append\_message

```python
@abstractmethod
def append_message(message: Message, agent: _SessionAgentT,
                   **kwargs: Any) -> None
```

Defined in: [src/strands/session/session\_manager.py:79](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L79)

Append a message to the agent’s session.

**Arguments**:

-   `message` - Message to add to the agent in the session
-   `agent` - Agent to append the message to
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### sync\_agent

```python
@abstractmethod
def sync_agent(agent: _SessionAgentT, **kwargs: Any) -> None
```

Defined in: [src/strands/session/session\_manager.py:89](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L89)

Serialize and sync the agent with the session storage.

**Arguments**:

-   `agent` - Agent who should be synchronized with the session storage
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### initialize

```python
@abstractmethod
def initialize(agent: _SessionAgentT, **kwargs: Any) -> None
```

Defined in: [src/strands/session/session\_manager.py:98](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L98)

Initialize an agent with a session.

**Arguments**:

-   `agent` - Agent to initialize
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### sync\_multi\_agent

```python
def sync_multi_agent(source: "MultiAgentBase", **kwargs: Any) -> None
```

Defined in: [src/strands/session/session\_manager.py:106](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L106)

Serialize and sync multi-agent with the session storage.

**Arguments**:

-   `source` - Multi-agent source object to persist
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### initialize\_multi\_agent

```python
def initialize_multi_agent(source: "MultiAgentBase", **kwargs: Any) -> None
```

Defined in: [src/strands/session/session\_manager.py:119](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py#L119)

Read multi-agent state from persistent storage.

**Arguments**:

-   `**kwargs` - Additional keyword arguments for future extensibility.
-   `source` - Multi-agent state to initialize.

**Returns**:

Multi-agent state dictionary or empty dict if not found.