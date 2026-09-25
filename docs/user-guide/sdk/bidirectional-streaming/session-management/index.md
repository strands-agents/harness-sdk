Session management for `BidiAgent` provides a mechanism for persisting conversation history and agent state across bidirectional streaming sessions. This enables voice assistants and interactive applications to maintain context and continuity even when connections are restarted or the application is redeployed.

## Overview

A bidirectional streaming session represents all stateful information needed by the agent to function, including:

-   Conversation history (messages with audio transcripts)
-   Agent state (key-value storage)
-   Connection state and configuration
-   Tool execution history

Built-in session persistence captures and restores this information automatically, so `BidiAgent` continues conversations where they left off, even after connection restarts or application restarts.

For an introduction to session management concepts and general patterns, see the [Session Management documentation](/docs/user-guide/sdk/agents/session-management/index.md). This guide focuses on considerations specific to bidirectional streaming.

## Basic Usage

Create a `BidiAgent` with a session manager and use it:

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import AudioIO
from strands.experimental.bidi.models import BedrockNovaSonicModel
from strands.session.file_session_manager import FileSessionManager

# Create a session manager with a unique session ID
session_manager = FileSessionManager(session_id="user_123_voice_session")

# Create the agent with session management
model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")
agent = BidiAgent(
    model=model,
    session_manager=session_manager
)

# Use the agent - all messages are automatically persisted
audio_io = AudioIO()
await agent.run(
    inputs=[audio_io.input()],
    outputs=[audio_io.output()]
)
```

The conversation history is automatically persisted and will be restored on the next session.

## Provider-Specific Considerations

### Bedrock Nova Sonic

Conversation History Limits

When restoring a session, Nova Sonic caps the conversation history sent at connection start to 50KB per message and 200KB total. Messages exceeding the per-message limit are truncated, and if the total exceeds 200KB, the oldest messages are dropped until it fits. Long-running or transcript-heavy sessions restored after this limit is hit will silently lose earlier context.

### Google Gemini Live

Limited Session Management Support

Gemini Live does not yet have full session management support due to message history recording limitations in the current implementation. For connection restarts, Gemini Live uses Google’s [session handlers](https://ai.google.dev/gemini-api/docs/live-session) to maintain conversation continuity within a single session, but conversation history is not persisted across application restarts.

When using Gemini Live with connection restarts, the model leverages Google’s built-in session handler mechanism to maintain context during reconnections within the same session lifecycle.

## Built-in Session Managers

Strands offers two built-in session managers for persisting bidirectional streaming sessions:

1.  **FileSessionManager**: Stores sessions in the local filesystem
2.  **S3SessionManager**: Stores sessions in Amazon S3 buckets

Both inherit the shared `RepositorySessionManager` implementation. For a custom backend, implement a [session repository](/docs/user-guide/sdk/agents/session-management/index.md#custom-session-repositories). `SnapshotSessionManager` does not support `BidiAgent`.

### FileSessionManager

The `FileSessionManager` provides a simple way to persist sessions to the local filesystem:

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.session.file_session_manager import FileSessionManager

# Create a session manager
session_manager = FileSessionManager(
    session_id="user_123_session",
    storage_dir="/path/to/sessions"  # Optional, defaults to temp directory
)

agent = BidiAgent(
    model=model,
    session_manager=session_manager
)
```

**Use cases:**

-   Development and testing
-   Single-server deployments
-   Local voice assistants
-   Prototyping

### S3SessionManager

The `S3SessionManager` stores sessions in Amazon S3 for distributed deployments:

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.session.s3_session_manager import S3SessionManager

# Create an S3 session manager
session_manager = S3SessionManager(
    session_id="user_123_session",
    bucket="my-voice-sessions",
    prefix="sessions/"  # Optional prefix for organization
)

agent = BidiAgent(
    model=model,
    session_manager=session_manager
)
```

**Use cases:**

-   Production deployments
-   Multi-server environments
-   Serverless applications
-   High availability requirements

## Session Lifecycle

### Session Creation

Create the session by constructing a session manager. Passing it to `BidiAgent` initializes the agent’s session data during construction:

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BedrockNovaSonicModel
from strands.session import FileSessionManager

session_manager = FileSessionManager(session_id="user_123", storage_dir="./sessions/")
agent = BidiAgent(
    model=BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0"),
    agent_id="voice-assistant",
    session_manager=session_manager,
)
```

### Session Restoration

To reload saved messages and application state, construct a new session manager over the same storage and pass it to `BidiAgent` with the same session ID and agent ID. Restoration happens during construction, before `await agent.start()` opens the model connection.

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BedrockNovaSonicModel
from strands.session import FileSessionManager

# First conversation
session_manager = FileSessionManager(session_id="user_123", storage_dir="./sessions/")
agent = BidiAgent(
    model=BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0"),
    agent_id="voice-assistant",
    session_manager=session_manager,
)
await agent.start()
await agent.send("My name is Alice")
# ... conversation continues ...
await agent.stop()

# Later: constructing a new agent restores the saved messages and state.
session_manager = FileSessionManager(session_id="user_123", storage_dir="./sessions/")
agent = BidiAgent(
    model=BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0"),
    agent_id="voice-assistant",
    session_manager=session_manager,
)
await agent.start()
await agent.send("What's my name?")
await agent.stop()
```

### Session Updates

Messages are persisted automatically as they’re added:

```python
agent = BidiAgent(model=model, session_manager=session_manager)
await agent.start()

# Each message automatically saved
await agent.send("Hello")  # Saved
# Model response received and saved
# Tool execution saved
# All transcripts saved
```

## Connection Restart Behavior

`BidiAgent` reconnects both proactively (a timer fires ahead of the provider’s connection limit) and reactively (after a timeout). On either path the session manager keeps the conversation intact:

```python
agent = BidiAgent(model=model, session_manager=session_manager)
await agent.start()

async for event in agent.receive():
    if isinstance(event, BidiConnectionRestartEvent):
        # On restart (reason "scheduled" or "timeout") the session manager:
        # 1. Persists every message up to this point
        # 2. Sends the full history into the restarted connection
        # 3. Lets the conversation continue
        print(f"Reconnecting (reason={event.reason}) with full history preserved")
```

For reconnect timing and how to tune it with `ConnectionConfig`, see [Connection Restart](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md#connection-restart).

## Integration with Hooks

Register a message hook after constructing the agent to run it after the session manager’s persistence hooks at the default hook order:

```python
from strands import LocalAgent
from strands.experimental.bidi.agent import BidiAgent
from strands.hooks import MessageAddedEvent
from strands.session import FileSessionManager


agent = BidiAgent(
    session_manager=FileSessionManager(session_id="user_123", storage_dir="./sessions/")
)


async def log_message(event: MessageAddedEvent[LocalAgent]) -> None:
    print(f"Message persisted: {event.message['role']}")


agent.add_hook(log_message)
```

The session manager also syncs state when `BidiAgentStopEvent` fires during shutdown.

For best practices on session ID management, session cleanup, error handling, storage considerations, and troubleshooting, see the [Session Management documentation](/docs/user-guide/sdk/agents/session-management/index.md).

## Next Steps

-   [Agent](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md) - Learn about BidiAgent configuration and lifecycle
-   [Hooks](/docs/user-guide/sdk/bidirectional-streaming/hooks/index.md) - Extend agent functionality with hooks
-   [Events](/docs/user-guide/sdk/bidirectional-streaming/events/index.md) - Complete guide to bidirectional streaming events
-   [Python API Reference](/docs/api/python/strands.experimental.bidi.agent) - Complete API documentation

## Related pages

- [Persist state across sessions](/docs/user-guide/sdk/agents/session-management/index.md) (2 shared tags)
- [State Management](/docs/user-guide/sdk/agents/state/index.md) (2 shared tags)
- [Storage](/docs/user-guide/sdk/storage/index.md) (1 shared tag)
- [Barge-in](/docs/user-guide/sdk/bidirectional-streaming/barge-in/index.md) (1 shared tag)
- [BidiAgent](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md) (1 shared tag)
- [Build a realtime voice agent](/docs/user-guide/sdk/bidirectional-streaming/index.md) (1 shared tag)
- [Events](/docs/user-guide/sdk/bidirectional-streaming/events/index.md) (1 shared tag)
- [Google Gemini Live](/docs/user-guide/sdk/bidirectional-streaming/models/google/index.md) (1 shared tag)
- [I/O Streams](/docs/user-guide/sdk/bidirectional-streaming/io/index.md) (1 shared tag)
- [OpenAI Realtime](/docs/user-guide/sdk/bidirectional-streaming/models/openai/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/experimental/bidi/agent/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/agent/agent.py)
- [harness-sdk/strands-py/src/strands/session/session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/session_manager.py)
- [harness-sdk/strands-py/src/strands/session/repository_session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/repository_session_manager.py)
- [harness-sdk/strands-py/src/strands/types/session.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/session.py)
- [harness-sdk/strands-py/src/strands/session/file_session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/file_session_manager.py)
- [harness-sdk/strands-py/src/strands/session/s3_session_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/session/s3_session_manager.py)
