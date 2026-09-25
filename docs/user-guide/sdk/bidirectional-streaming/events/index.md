You process audio, text, and tool activity as it happens by consuming bidirectional streaming events. Standard streaming uses async iterators or callbacks in a one-shot request-response pattern; bidirectional streaming uses `send()` and `receive()` for explicit control over a persistent, two-way conversation.

## Event Model

Bidirectional streaming uses a different event model than [standard streaming](/docs/user-guide/sdk/streaming/index.md):

**Standard Streaming:**

-   Uses `stream_async()` or callback handlers
-   Request-response pattern (one invocation per call)
-   Events flow in one direction (model → application)

**Bidirectional Streaming:**

-   Uses `send()` and `receive()` methods
-   Persistent connection (multiple turns per connection)
-   Events flow in both directions (application ↔ model)
-   Supports real-time audio and barge-ins

```python
import asyncio
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BedrockNovaSonicModel

async def main():
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")

    async with BidiAgent(model=model) as agent:
        # Send input to model
        await agent.send("What is 2+2?")

        # Receive events from model
        async for event in agent.receive():
            print(f"Event: {event['type']}")

asyncio.run(main())
```

## Input Types

Send text, streaming audio, or images with `agent.send()`. It accepts a string, a `TextBlock`, `AudioDelta`, or `ImageBlock`, or a dictionary containing exactly one `text`, `audio_delta`, or `image` key.

Text blocks contain complete text input, and image blocks contain complete images. Audio deltas add samples to the live input stream without explicitly ending the user’s turn.

### Text

Send text input to the model.

```python
from strands.types.content import TextBlock

await agent.send(TextBlock("What is the weather?"))

# Strings and dictionaries are also accepted:
await agent.send("What is the weather?")
await agent.send({"text": "What is the weather?"})
```

### Audio

Send each chunk of audio samples with `AudioDelta`. The model configuration determines the sample rate and channel count for real-time PCM audio.

```python
from pathlib import Path

from strands.experimental.bidi.types import AudioDelta

audio_bytes = Path("audio-chunk.pcm").read_bytes()

await agent.send(AudioDelta(format="pcm", source={"bytes": audio_bytes}))

# Or use a dictionary:
await agent.send({
    "audio_delta": {
        "format": "pcm",
        "source": {"bytes": audio_bytes},
    }
})
```

### Image

Send image bytes using an image content block.

```python
from strands.types.media import ImageBlock

with open("image.jpg", "rb") as f:
    image_bytes = f.read()

await agent.send(ImageBlock(format="jpeg", source={"bytes": image_bytes}))

# Or use a dictionary:
await agent.send({
    "image": {
        "format": "jpeg",
        "source": {"bytes": image_bytes},
    }
})
```

## Output Event Types

Events received from the model via `agent.receive()`.

### Connection Lifecycle Events

Events that track the connection state throughout the conversation.

#### BidiConnectionStartEvent

Emitted when the streaming connection is established and ready for interaction.

```python
{
    "type": "bidi_connection_start",
    "connection_id": "conn_abc123",
    "model": "amazon.nova-2-sonic-v1:0"
}
```

**Properties:**

-   `connection_id`: Unique identifier for this streaming connection
-   `model`: Model identifier (e.g., “amazon.nova-2-sonic-v1:0”, “gemini-3.8-live”)

#### BidiConnectionRestartEvent

Emitted when the agent restarts the model connection, on either reconnect path. The agent preserves the conversation history and resumes automatically. A scheduled restart fires proactively when the reconnect timer reaches the provider’s limit; a timeout restart fires reactively after the model reports a timeout.

```python
{
    "type": "bidi_connection_restart",
    "reason": "scheduled",
    "timeout_error": None,
    "turn_interrupted": False
}
```

**Properties:**

-   `reason`: What triggered the restart
    -   `"scheduled"`: The reconnect timer fired ahead of the provider’s limit (the normal path)
    -   `"timeout"`: The connection timed out and the model reported it
-   `timeout_error`: The timeout error on the reactive path; `None` when the reason is `"scheduled"`
-   `turn_interrupted`: `True` when the restart cut an in-progress or owed turn. The provider replays history as context, so that turn is not answered on its own: re-prompt or notify the user when this is set.

**Usage:**

```python
async for event in agent.receive():
    if event["type"] == "bidi_connection_restart":
        print(f"Connection restarting (reason={event['reason']})")
        if event["turn_interrupted"]:
            # This turn was not answered; re-prompt or notify the user.
            pass
        # Connection resumes automatically with full history.
```

See [Connection Lifecycle](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md#connection-restart) for more on reconnect timing.

#### BidiConnectionWarningEvent

Emitted by the proactive reconnect timer shortly before a scheduled restart. Informational only: use it to surface a “reconnecting shortly” hint in a UI.

```python
{
    "type": "bidi_connection_warning",
    "time_left_s": 8.0
}
```

**Properties:**

-   `time_left_s`: Approximate seconds until the scheduled reconnect

**Usage:**

```python
async for event in agent.receive():
    if event["type"] == "bidi_connection_warning":
        print(f"Reconnecting in ~{event['time_left_s']:.0f}s")
```

#### BidiConnectionStopEvent

Emitted when the streaming connection is closed.

```python
{
    "type": "bidi_connection_stop",
    "connection_id": "conn_abc123",
    "reason": "user_request"
}
```

**Properties:**

-   `connection_id`: Unique identifier for this streaming connection
-   `reason`: Why the connection closed
    -   `"client_disconnect"`: Client disconnected
    -   `"timeout"`: Connection timed out
    -   `"error"`: Error occurred
    -   `"complete"`: Conversation completed normally
    -   `"user_request"`: User requested closure (via the SDK’s experimental `stop` tool or any tool that sets `request_state["stop_event_loop"]`)

### Response Lifecycle Events

Response start and stop events bracket the assistant’s audio, transcript, and tool requests. User transcription is independent and may arrive outside these boundaries.

#### BidiResponseStartEvent

Emitted before a response’s assistant audio, transcript, and tool-use events.

```python
{
    "type": "bidi_response_start",
    "response_id": "resp_xyz789"
}
```

**Properties:**

-   `response_id`: Unique identifier for this response (matches `BidiResponseStopEvent`)

#### BidiResponseStopEvent

Emitted when response output ends.

```python
{
    "type": "bidi_response_stop",
    "response_id": "resp_xyz789"
}
```

**Properties:**

-   `response_id`: Unique identifier for this response

### Audio Events

Assistant audio follows start, delta, and stop events. A response can contain multiple audio streams. Each stream stops before the next starts.

#### BidiAudioStartEvent

Marks the beginning of an audio stream before chunks arrive.

```python
{
    "type": "bidi_audio_start"
}
```

#### BidiAudioDeltaEvent

Emitted for each chunk of audio output. Audio is base64-encoded for JSON compatibility.

```python
{
    "type": "bidi_audio_delta",
    "audio": "base64_encoded_audio_data...",
    "format": "pcm",
    "sample_rate": 16000,
    "channels": 1
}
```

**Properties:**

-   `audio`: Base64-encoded audio chunk
-   `format`: Audio encoding format (`"pcm"`, `"wav"`, `"opus"`, `"mp3"`)
-   `sample_rate`: Sample rate in Hz (`16000`, `24000`, `48000`)
-   `channels`: Number of audio channels (`1` = mono, `2` = stereo)

**Usage:**

```python
import base64

async for event in agent.receive():
    if event["type"] == "bidi_audio_delta":
        # Decode and play audio
        audio_bytes = base64.b64decode(event["audio"])
        play_audio(audio_bytes, sample_rate=event["sample_rate"])
```

#### BidiAudioStopEvent

Emitted when the audio stream ends, including when stopped due to barge-in. Buffered audio may still be playing. This event carries no audio and does not end the response or its transcript.

```python
{
    "type": "bidi_audio_stop"
}
```

### Transcript Events

Each user or assistant transcript has start and stop events, with zero or more text deltas between them. Match events by `content_id`, since transcripts can overlap even for the same role.

#### BidiTranscriptStartEvent

Identifies a transcript and reserves its message in conversation history. It contains no text and may arrive after speech has begun.

```python
{
    "type": "bidi_transcript_start",
    "role": "user",
    "content_id": "content_123"
}
```

**Properties:**

-   `role`: Who is speaking (`"user"` or `"assistant"`)
-   `content_id`: Identifier for this transcript

#### BidiTranscriptDeltaEvent

Emitted for each incremental transcript update.

```python
{
    "type": "bidi_transcript_delta",
    "delta": "Hello",
    "role": "user",
    "content_id": "content_123"
}
```

**Properties:**

-   `delta`: The incremental transcript text
-   `role`: Who is speaking (`"user"` or `"assistant"`)
-   `content_id`: Identifier for this transcript

#### BidiTranscriptStopEvent

Emitted once when a user or assistant transcript finishes successfully.

```python
{
    "type": "bidi_transcript_stop",
    "transcript": "Hello world",
    "role": "user",
    "content_id": "content_123"
}
```

**Properties:**

-   `transcript`: The final transcript text
-   `role`: Who spoke (`"user"` or `"assistant"`)
-   `content_id`: Identifier for this transcript

**Usage:**

```python
async for event in agent.receive():
    if event["type"] == "bidi_transcript_stop":
        print(f"{event['role']}: {event['transcript']}")
```

### Barge-in Events

Events for handling barge-in, when the user starts speaking during a model response.

#### BidiBargeInEvent

Signals a barge-in that stops response generation or playback, typically when the user starts speaking. The bidirectional session continues.

```python
{
    "type": "bidi_barge_in",
    "reason": "user_speech"
}
```

**Properties:**

-   `reason`: Why response output should stop
    -   `"user_speech"`: User started speaking (most common)
    -   `"error"`: Error stopped output

**Usage:**

```python
async for event in agent.receive():
    if event["type"] == "bidi_barge_in":
        print(f"Barge-in: {event['reason']}")
        # Audio output automatically cleared
        # Model ready for new input
```

Barge-in and tool interrupts

`BidiBargeInEvent` applies to the current response or its playback. New input typically starts another response. Agent’s [human-in-the-loop interrupts](/docs/user-guide/sdk/interrupts/index.md) pause an invocation to await input before resuming tool execution. BidiAgent does not yet support tool interrupts.

### Tool Events

Events for tool execution during conversations. Bidirectional streaming reuses the standard `ToolUseStreamEvent` from Strands.

#### ToolUseStreamEvent

Emitted when the model requests tool execution. See [Tools Overview](/docs/user-guide/sdk/tools/index.md) for details.

```python
{
    "type": "tool_use_stream",
    "current_tool_use": {
        "toolUseId": "tool_123",
        "name": "notebook",
        "input": {"expression": "2+2"}
    }
}
```

**Properties:**

-   `current_tool_use`: Information about the tool being used
    -   `toolUseId`: Unique ID for this tool use
    -   `name`: Name of the tool
    -   `input`: Tool input parameters

Tools execute in the background. `ToolResultEvent` carries the actual result, and `ToolResultMessageEvent` carries its history message. Both retain the original tool-use ID. Dispatch acknowledgements emit `MessageAddedEvent` hooks when appended to history.

### Usage Events

Events for tracking token consumption across different modalities.

#### BidiUsageEvent

Emitted periodically to report token usage with modality breakdown.

```python
{
    "type": "bidi_usage",
    "inputTokens": 150,
    "outputTokens": 75,
    "totalTokens": 225,
    "modality_details": [
        {"modality": "text", "input_tokens": 100, "output_tokens": 50},
        {"modality": "audio", "input_tokens": 50, "output_tokens": 25}
    ]
}
```

**Properties:**

-   `inputTokens`: Total tokens used for all input modalities
-   `outputTokens`: Total tokens used for all output modalities
-   `totalTokens`: Sum of input and output tokens
-   `modality_details`: Optional list of token usage per modality
-   `cacheReadInputTokens`: Optional tokens read from cache
-   `cacheWriteInputTokens`: Optional tokens written to cache

## Event Flow Examples

### Basic Audio Conversation

```python
import asyncio
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import AudioIO
from strands.experimental.bidi.models import BedrockNovaSonicModel

async def main():
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")
    agent = BidiAgent(model=model)
    audio_io = AudioIO()

    await agent.start()

    # Process events from audio conversation
    async for event in agent.receive():
        if event["type"] == "bidi_connection_start":
            print(f"Connected to {event['model']}")

        elif event["type"] == "bidi_response_start":
            print(f"Response starting: {event['response_id']}")

        elif event["type"] == "bidi_audio_delta":
            print(f"Audio chunk: {len(event['audio'])} bytes")

        elif event["type"] == "bidi_transcript_stop":
            print(f"{event['role']}: {event['transcript']}")

        elif event["type"] == "bidi_response_stop":
            print(f"Response complete: {event['response_id']}")

    await agent.stop()

asyncio.run(main())
```

### Tracking Transcript State

```python
import asyncio
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BedrockNovaSonicModel

async def main():
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")

    async with BidiAgent(model=model) as agent:
        await agent.send("Tell me about Python")

        async for event in agent.receive():
            if event["type"] == "bidi_transcript_stop":
                print(f"{event['role']}: {event['transcript']}")

asyncio.run(main())
```

### Tool Execution During Conversation

```python
import asyncio
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BedrockNovaSonicModel
from strands.vended_tools import notebook

async def main():
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")
    agent = BidiAgent(model=model, tools=[notebook])

    async with agent as agent:
        await agent.send('Create a notebook named "ideas" and add three project ideas.')

        async for event in agent.receive():
            event_type = event["type"]

            if event_type == "bidi_transcript_stop":
                print(f"{event['role']}: {event['transcript']}")

            elif event_type == "tool_use_stream":
                tool_use = event["current_tool_use"]
                print(f"Using tool: {tool_use['name']}")
                print(f"   Input: {tool_use['input']}")

asyncio.run(main())
```

### Handling Barge-in

```python
import asyncio
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BedrockNovaSonicModel

async def main():
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")

    async with BidiAgent(model=model) as agent:
        await agent.send("Tell me a long story about space exploration")

        barge_in_count = 0

        async for event in agent.receive():
            if event["type"] == "bidi_transcript_stop":
                print(f"{event['role']}: {event['transcript']}")

            elif event["type"] == "bidi_barge_in":
                barge_in_count += 1
                print(f"\nBarge-in (#{barge_in_count})")

asyncio.run(main())
```

### Connection Restart Handling

```python
import asyncio
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BedrockNovaSonicModel

async def main():
    model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")  # 8-minute timeout

    async with BidiAgent(model=model) as agent:
        # Continuous conversation that handles restarts
        async for event in agent.receive():
            if event["type"] == "bidi_connection_warning":
                print(f"Reconnecting in ~{event['time_left_s']:.0f}s")

            elif event["type"] == "bidi_connection_restart":
                print(f"Connection restarting (reason={event['reason']})")
                if event["turn_interrupted"]:
                    print("   Last turn was not answered; re-prompt if needed")
                # History is preserved and the connection resumes automatically.

            elif event["type"] == "bidi_connection_start":
                print(f"Connected to {event['model']}")

            elif event["type"] == "bidi_transcript_stop":
                print(f"{event['role']}: {event['transcript']}")

asyncio.run(main())
```

## Hook Events

Hook events are a separate concept from streaming events. While streaming events flow through `agent.receive()` during conversations, hook events are callbacks that trigger at specific lifecycle points (like initialization, message added, or barge-in). Hook events allow you to inject custom logic for cross-cutting concerns like logging, analytics, and session persistence without processing the event stream directly.

For details on hook events and usage patterns, see the [Hooks](/docs/user-guide/sdk/bidirectional-streaming/hooks/index.md) documentation.

## Related pages

- [Barge-in](/docs/user-guide/sdk/bidirectional-streaming/barge-in/index.md) (1 shared tag)
- [BidiAgent](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md) (1 shared tag)
- [Build a realtime voice agent](/docs/user-guide/sdk/bidirectional-streaming/index.md) (1 shared tag)
- [Google Gemini Live](/docs/user-guide/sdk/bidirectional-streaming/models/google/index.md) (1 shared tag)
- [I/O Streams](/docs/user-guide/sdk/bidirectional-streaming/io/index.md) (1 shared tag)
- [OpenAI Realtime](/docs/user-guide/sdk/bidirectional-streaming/models/openai/index.md) (1 shared tag)
- [Bidirectional Streaming Observability](/docs/user-guide/sdk/bidirectional-streaming/observability/index.md) (1 shared tag)
- [Bidirectional Streaming Hooks](/docs/user-guide/sdk/bidirectional-streaming/hooks/index.md) (1 shared tag)
- [Build a voice agent](/docs/user-guide/sdk/bidirectional-streaming/quickstart/index.md) (1 shared tag)
- [Bedrock Nova Sonic](/docs/user-guide/sdk/bidirectional-streaming/models/bedrock/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/experimental/bidi/types/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/agent.py)
- [harness-sdk/strands-py/src/strands/experimental/bidi/types/content.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/content.py)
- [harness-sdk/strands-py/src/strands/experimental/bidi/types/media.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/media.py)
- [harness-sdk/strands-py/src/strands/types/content.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/content.py)
- [harness-sdk/strands-py/src/strands/experimental/bidi/types/events.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py)
- [harness-sdk/strands-py/src/strands/experimental/bidi/types/io.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py)
- [harness-sdk/strands-py/src/strands/types/media.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/media.py)
