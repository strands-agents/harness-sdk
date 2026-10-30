Media input types for bidirectional streaming.

## AudioDelta

```python
@dataclass
class AudioDelta()
```

Defined in: [src/strands/bidi/types/media.py:15](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/media.py#L15)

Audio samples to append to the live input stream.

Sending a delta does not explicitly end the user’s turn.

**Attributes**:

-   `format` - Audio format.
-   `source` - Source containing the audio samples.

#### to\_dict

```python
def to_dict() -> _AudioDeltaData
```

Defined in: [src/strands/bidi/types/media.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/media.py#L28)

Return the dictionary form of this delta.

Protocols for bidirectional input and output streams.

The protocols separate input and output concerns into independent callables with lifecycle methods managed by `BidiAgent.run()`.

## InputStream

```python
@runtime_checkable
class InputStream(Protocol)
```

Defined in: [src/strands/bidi/types/io.py:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L18)

Callable input stream managed by a bidirectional agent.

An input stream reads one value from a source each time the agent calls it.

#### start

```python
async def start(agent: "BidiAgent") -> None
```

Defined in: [src/strands/bidi/types/io.py:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L24)

Start input.

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/bidi/types/io.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L28)

Stop input.

#### \_\_call\_\_

```python
def __call__() -> Awaitable[BidiAgentInput]
```

Defined in: [src/strands/bidi/types/io.py:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L32)

Read input data from the source.

**Returns**:

Awaitable that resolves to input content (audio, text, image, etc.)

## OutputStream

```python
@runtime_checkable
class OutputStream(Protocol)
```

Defined in: [src/strands/bidi/types/io.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L42)

Callable output stream managed by a bidirectional agent.

An output stream handles one event each time the agent calls it.

#### start

```python
async def start(agent: "BidiAgent") -> None
```

Defined in: [src/strands/bidi/types/io.py:48](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L48)

Start output.

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/bidi/types/io.py:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L52)

Stop output.

#### \_\_call\_\_

```python
def __call__(event: BidiOutputEvent) -> Awaitable[None]
```

Defined in: [src/strands/bidi/types/io.py:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/io.py#L56)

Process output events from the agent.

**Arguments**:

-   `event` - Output event from the agent (audio, text, tool calls, etc.)

Agent-related type definitions for bidirectional streaming.

This module defines the types used for BidiAgent.

#### BidiAgentInput

User input accepted by `BidiAgent.send()` and returned by input streams.

Supported forms:

-   Text: a string, `TextBlock`, or a dictionary with a `text` key.
-   Image: `ImageBlock` or a dictionary with an `image` key.
-   Streaming audio: `AudioDelta` or a dictionary with an `audio_delta` key.
-   Grouped content: a nonempty list of strings, text/image blocks, or their dictionary forms.

A list forms one user message and preserves block order. Send audio deltas individually, outside these lists.

Content-related type definitions for bidirectional streaming.

#### BidiUserContentBlock

A complete text or image block supplied by a user.

#### BidiContentBlock

A complete text, image, or tool result block.

#### BidiContentDelta

An audio delta for the live input stream.

#### BidiUserContentBlockData

Dictionary form of one user content block.

#### BidiContentBlockData

Dictionary form of one text, image, or tool result block.

#### BidiContentDeltaData

Dictionary form of an audio delta.

## BidiMessage

```python
@dataclass
class BidiMessage()
```

Defined in: [src/strands/bidi/types/content.py:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/content.py#L33)

An input message containing ordered content blocks.

Callers must supply at least one block when sending and must not mix tool results with user text or images. Send streaming deltas individually.

**Attributes**:

-   `content` - Ordered list of complete content blocks.

## BidiContentMetadata

```python
class BidiContentMetadata(TypedDict)
```

Defined in: [src/strands/bidi/types/content.py:46](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/content.py#L46)

Streamed content metadata stored under a message’s metadata.custom.bidi.

**Attributes**:

-   `kind` - Identifies the message as text, reasoning, or a transcript.
-   `status` - Whether the content is pending, complete, or incomplete.

Output event types for bidirectional streaming.

Defines the provider-agnostic events produced by bidirectional models and `BidiAgent`: connection lifecycle (start, restart, warning, stop), response start and stop, audio, text, reasoning, and transcript streams (start, delta, stop, and the completed block), barge-in, token usage, and tool-use groups. Also defines the `AudioChannel`, `AudioFormat`, and `Role` literals and the `BidiOutputEvent` union.

#### AudioChannel

Number of audio channels.

-   Mono: 1
-   Stereo: 2

#### AudioFormat

Audio encoding format of model audio output and `AudioStreamConfig`.

Distinct from `strands.types.media.AudioFormat`, the wider set of formats that types `AudioDelta.format` on audio input.

#### Role

Role of a message sender.

-   “user”: Messages from the user to the assistant.
-   “assistant”: Messages from the assistant to the user.

## BidiConnectionStartEvent

```python
class BidiConnectionStartEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L73)

Streaming connection established and ready for interaction.

**Arguments**:

-   `connection_id` - Unique identifier for this streaming connection.
-   `model` - Model identifier (e.g., “gpt-realtime-2.1”, “gemini-3.8-live”).

#### \_\_init\_\_

```python
def __init__(connection_id: str, model: str)
```

Defined in: [src/strands/bidi/types/events.py:81](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L81)

Initialize connection start event.

#### connection\_id

```python
@property
def connection_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:92](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L92)

Unique identifier for this streaming connection.

#### model

```python
@property
def model() -> str
```

Defined in: [src/strands/bidi/types/events.py:97](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L97)

Model identifier (e.g., ‘gpt-realtime-2.1’, ‘gemini-3.8-live’).

## BidiConnectionRestartEvent

```python
class BidiConnectionRestartEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:102](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L102)

Agent is restarting the model connection.

Emitted on both restart paths: reactively after the model reports a timeout, and proactively when the restart timer fires ahead of the provider’s limit.

**Arguments**:

-   `reason` - What triggered the restart (“timeout” reactively, “scheduled” proactively).
-   `timeout_error` - The model’s timeout error on the reactive path; None when scheduled.
-   `turn_interrupted` - True if the restart cut off an in-progress assistant response or a user turn that had not been answered yet. Recovery depends on the provider’s replay or resumption support; the application may need to re-prompt or notify the user.

#### \_\_init\_\_

```python
def __init__(reason: Literal["timeout", "scheduled"],
             timeout_error: "ConnectionTimeoutError | None" = None,
             turn_interrupted: bool = False)
```

Defined in: [src/strands/bidi/types/events.py:116](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L116)

Initialize connection restart event.

#### reason

```python
@property
def reason() -> Literal["timeout", "scheduled"]
```

Defined in: [src/strands/bidi/types/events.py:133](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L133)

What triggered the restart (“timeout” or “scheduled”).

#### timeout\_error

```python
@property
def timeout_error() -> "ConnectionTimeoutError | None"
```

Defined in: [src/strands/bidi/types/events.py:138](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L138)

Connection timeout error on the reactive path; None when scheduled.

#### turn\_interrupted

```python
@property
def turn_interrupted() -> bool
```

Defined in: [src/strands/bidi/types/events.py:143](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L143)

True if the restart cut off an in-progress response or an unanswered user turn.

## BidiConnectionWarningEvent

```python
class BidiConnectionWarningEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:148](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L148)

Agent is approaching a proactive restart.

Emitted by the proactive restart timer before a restart; informational only.

**Arguments**:

-   `time_left_s` - Approximate seconds until the scheduled restart.

#### \_\_init\_\_

```python
def __init__(time_left_s: float)
```

Defined in: [src/strands/bidi/types/events.py:157](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L157)

Initialize connection warning event.

#### time\_left\_s

```python
@property
def time_left_s() -> float
```

Defined in: [src/strands/bidi/types/events.py:167](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L167)

Approximate seconds until the scheduled restart.

## BidiResponseStartEvent

```python
class BidiResponseStartEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:172](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L172)

Start of a model response.

**Arguments**:

-   `response_id` - Unique identifier for this response (used in BidiResponseStopEvent).

#### \_\_init\_\_

```python
def __init__(response_id: str)
```

Defined in: [src/strands/bidi/types/events.py:179](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L179)

Initialize response start event.

#### response\_id

```python
@property
def response_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:184](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L184)

Unique identifier for this response.

## BidiAudioStartEvent

```python
class BidiAudioStartEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:189](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L189)

Beginning of an assistant audio stream, identified by `content_id`.

#### \_\_init\_\_

```python
def __init__(content_id: str) -> None
```

Defined in: [src/strands/bidi/types/events.py:192](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L192)

Initialize audio start event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:197](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L197)

Identifier shared by this audio stream’s events.

## BidiAudioDeltaEvent

```python
class BidiAudioDeltaEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:202](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L202)

Incremental audio output from the model.

**Arguments**:

-   `audio` - Base64-encoded audio chunk.
-   `format` - Audio encoding format.
-   `sample_rate` - Number of audio samples per second in Hz.
-   `channels` - Number of audio channels (1=mono, 2=stereo).
-   `content_id` - Unique identifier shared by this audio stream’s events.

#### \_\_init\_\_

```python
def __init__(audio: str, format: AudioFormat, sample_rate: int,
             channels: AudioChannel, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:213](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L213)

Initialize audio delta event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:234](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L234)

Identifier shared by this audio stream’s events.

#### audio

```python
@property
def audio() -> str
```

Defined in: [src/strands/bidi/types/events.py:239](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L239)

Base64-encoded audio chunk.

#### format

```python
@property
def format() -> AudioFormat
```

Defined in: [src/strands/bidi/types/events.py:244](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L244)

Audio encoding format.

#### sample\_rate

```python
@property
def sample_rate() -> int
```

Defined in: [src/strands/bidi/types/events.py:249](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L249)

Number of audio samples per second in Hz.

#### channels

```python
@property
def channels() -> AudioChannel
```

Defined in: [src/strands/bidi/types/events.py:254](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L254)

Number of audio channels (1=mono, 2=stereo).

## BidiAudioStopEvent

```python
class BidiAudioStopEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:259](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L259)

End of an assistant audio stream, which may still be playing.

#### \_\_init\_\_

```python
def __init__(content_id: str) -> None
```

Defined in: [src/strands/bidi/types/events.py:262](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L262)

Initialize audio stop event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:267](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L267)

Identifier shared by this audio stream’s events.

## BidiTextStartEvent

```python
class BidiTextStartEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:272](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L272)

Beginning of assistant text output, identified by `content_id`.

#### \_\_init\_\_

```python
def __init__(content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:275](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L275)

Initialize text start event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:280](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L280)

Identifier shared by this text block’s events.

## BidiTextDeltaEvent

```python
class BidiTextDeltaEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:285](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L285)

Incremental assistant text output, separate from speech transcripts.

#### \_\_init\_\_

```python
def __init__(delta: str, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:288](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L288)

Initialize text delta event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:293](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L293)

Identifier shared by this text block’s events.

#### delta

```python
@property
def delta() -> str
```

Defined in: [src/strands/bidi/types/events.py:298](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L298)

Incremental text.

## BidiTextStopEvent

```python
class BidiTextStopEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:303](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L303)

End of an assistant text stream, before its completed block is emitted.

#### \_\_init\_\_

```python
def __init__(content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:306](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L306)

Initialize text stop event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:311](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L311)

Identifier shared by this text block’s events.

## BidiTextBlockEvent

```python
class BidiTextBlockEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:316](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L316)

Complete assistant text, emitted after its stop event by the agent.

#### \_\_init\_\_

```python
def __init__(text: str, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:319](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L319)

Initialize text block event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:324](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L324)

Identifier shared by this text block’s events.

#### text

```python
@property
def text() -> str
```

Defined in: [src/strands/bidi/types/events.py:329](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L329)

Complete text.

## BidiReasoningStartEvent

```python
class BidiReasoningStartEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:334](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L334)

Beginning of model-provided reasoning text, identified by `content_id`.

#### \_\_init\_\_

```python
def __init__(content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:337](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L337)

Initialize reasoning start event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:342](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L342)

Identifier shared by this reasoning block’s events.

## BidiReasoningDeltaEvent

```python
class BidiReasoningDeltaEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:347](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L347)

Incremental reasoning text or thought summary exposed by the model.

#### \_\_init\_\_

```python
def __init__(delta: str, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:350](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L350)

Initialize reasoning delta event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:355](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L355)

Identifier shared by this reasoning block’s events.

#### delta

```python
@property
def delta() -> str
```

Defined in: [src/strands/bidi/types/events.py:360](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L360)

Incremental reasoning text.

## BidiReasoningStopEvent

```python
class BidiReasoningStopEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:365](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L365)

End of a reasoning stream, before its completed block is emitted.

#### \_\_init\_\_

```python
def __init__(content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:368](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L368)

Initialize reasoning stop event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:373](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L373)

Identifier shared by this reasoning block’s events.

## BidiReasoningBlockEvent

```python
class BidiReasoningBlockEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:378](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L378)

Complete reasoning text, emitted after its stop event by the agent.

#### \_\_init\_\_

```python
def __init__(text: str, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:381](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L381)

Initialize reasoning block event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:386](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L386)

Identifier shared by this reasoning block’s events.

#### text

```python
@property
def text() -> str
```

Defined in: [src/strands/bidi/types/events.py:391](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L391)

Complete reasoning text or thought summary.

## BidiTranscriptStartEvent

```python
class BidiTranscriptStartEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:396](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L396)

Beginning of a user or assistant transcript, before its text arrives.

**Arguments**:

-   `role` - Who is speaking (“user” or “assistant”).
-   `content_id` - Unique identifier shared by this transcript’s events.

#### \_\_init\_\_

```python
def __init__(role: Role, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:404](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L404)

Initialize transcript start event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:415](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L415)

Identifier shared by this transcript’s events.

#### role

```python
@property
def role() -> Role
```

Defined in: [src/strands/bidi/types/events.py:420](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L420)

The role of the speaker.

## BidiTranscriptDeltaEvent

```python
class BidiTranscriptDeltaEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:425](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L425)

Incremental transcription of user or assistant speech.

**Arguments**:

-   `delta` - The incremental transcript text.
-   `role` - Who is speaking (“user” or “assistant”).
-   `content_id` - Unique identifier shared by this transcript’s events.

#### \_\_init\_\_

```python
def __init__(delta: str, role: Role, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:434](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L434)

Initialize transcript delta event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:446](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L446)

Identifier shared by this transcript’s events.

#### delta

```python
@property
def delta() -> str
```

Defined in: [src/strands/bidi/types/events.py:451](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L451)

The incremental transcript text.

#### role

```python
@property
def role() -> Role
```

Defined in: [src/strands/bidi/types/events.py:456](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L456)

The role of the message sender.

## BidiTranscriptStopEvent

```python
class BidiTranscriptStopEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:461](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L461)

End of a transcript stream, before its completed block is emitted.

**Arguments**:

-   `role` - Who spoke (“user” or “assistant”).
-   `content_id` - Unique identifier shared by this transcript’s events.

#### \_\_init\_\_

```python
def __init__(role: Role, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:469](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L469)

Initialize transcript stop event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:480](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L480)

Identifier shared by this transcript’s events.

#### role

```python
@property
def role() -> Role
```

Defined in: [src/strands/bidi/types/events.py:485](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L485)

The role of the speaker.

## BidiTranscriptBlockEvent

```python
class BidiTranscriptBlockEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:490](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L490)

Complete transcript, emitted after its stop event by the agent.

**Arguments**:

-   `transcript` - The final transcript text.
-   `role` - Who spoke (“user” or “assistant”).
-   `content_id` - Unique identifier shared by this transcript’s events.

#### \_\_init\_\_

```python
def __init__(transcript: str, role: Role, content_id: str)
```

Defined in: [src/strands/bidi/types/events.py:499](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L499)

Initialize transcript block event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:511](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L511)

Identifier shared by this transcript’s events.

#### transcript

```python
@property
def transcript() -> str
```

Defined in: [src/strands/bidi/types/events.py:516](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L516)

The final transcript text.

#### role

```python
@property
def role() -> Role
```

Defined in: [src/strands/bidi/types/events.py:521](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L521)

The role of the speaker.

## BidiBargeInEvent

```python
class BidiBargeInEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:526](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L526)

Stop current response generation or playback while the session continues.

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/bidi/types/events.py:529](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L529)

Initialize barge-in event.

## BidiResponseStopEvent

```python
class BidiResponseStopEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:534](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L534)

Response output ended. User transcription may still be pending.

**Arguments**:

-   `response_id` - ID of the response that ended (matches BidiResponseStartEvent).

#### \_\_init\_\_

```python
def __init__(response_id: str)
```

Defined in: [src/strands/bidi/types/events.py:541](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L541)

Initialize response stop event.

#### response\_id

```python
@property
def response_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:551](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L551)

Unique identifier for this response.

## TokenDetails

```python
class TokenDetails(TypedDict)
```

Defined in: [src/strands/bidi/types/events.py:556](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L556)

Token counts by category for the input or output side of a usage event.

All fields are optional. Categories may overlap or be incomplete, so their sum is not necessarily the event’s input or output token count.

**Attributes**:

-   `text` - Text tokens.
-   `audio` - Audio tokens.
-   `image` - Image tokens.
-   `video` - Video tokens.
-   `cache_read` - Input tokens read from cache.
-   `reasoning` - Output reasoning or thought tokens reported by the provider.

## BidiUsageEvent

```python
class BidiUsageEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:579](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L579)

Additional model token usage with optional input and output breakdowns.

Each event contributes new usage to the conversation’s running totals. Its counts may cover part of a response or a complete model generation.

Detail maps use names such as `audio`, `text`, `image`, `cache_read`, and `reasoning`. Providers may omit details or report overlapping counts, so use the reported totals rather than summing the breakdowns.

**Arguments**:

-   `input_tokens` - Input tokens accounted for by this event.
-   `output_tokens` - Output tokens accounted for by this event.
-   `total_tokens` - Total tokens accounted for by this event.
-   `input_token_details` - Optional input token counts by category for this event.
-   `output_token_details` - Optional output token counts by category for this event.

#### \_\_init\_\_

```python
def __init__(input_tokens: int,
             output_tokens: int,
             total_tokens: int,
             input_token_details: TokenDetails | None = None,
             output_token_details: TokenDetails | None = None) -> None
```

Defined in: [src/strands/bidi/types/events.py:597](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L597)

Initialize usage event.

#### input\_tokens

```python
@property
def input_tokens() -> int
```

Defined in: [src/strands/bidi/types/events.py:619](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L619)

Input tokens accounted for by this event.

#### output\_tokens

```python
@property
def output_tokens() -> int
```

Defined in: [src/strands/bidi/types/events.py:624](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L624)

Output tokens accounted for by this event.

#### total\_tokens

```python
@property
def total_tokens() -> int
```

Defined in: [src/strands/bidi/types/events.py:629](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L629)

Total tokens accounted for by this event.

#### input\_token\_details

```python
@property
def input_token_details() -> TokenDetails
```

Defined in: [src/strands/bidi/types/events.py:634](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L634)

Input token counts by category, empty when unreported.

#### output\_token\_details

```python
@property
def output_token_details() -> TokenDetails
```

Defined in: [src/strands/bidi/types/events.py:639](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L639)

Output token counts by category, empty when unreported.

## BidiToolUseBlocksEvent

```python
class BidiToolUseBlocksEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:644](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L644)

A complete group of tool calls requested by the model.

**Arguments**:

-   `tool_uses` - Tool calls to execute together.

#### \_\_init\_\_

```python
def __init__(tool_uses: list[ToolUse])
```

Defined in: [src/strands/bidi/types/events.py:651](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L651)

Initialize a tool-use group.

#### tool\_uses

```python
@property
def tool_uses() -> list[ToolUse]
```

Defined in: [src/strands/bidi/types/events.py:656](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L656)

Tool calls in provider order.

## BidiConnectionStopEvent

```python
class BidiConnectionStopEvent(TypedEvent)
```

Defined in: [src/strands/bidi/types/events.py:661](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L661)

Streaming connection stop notification, which may precede resource cleanup.

**Arguments**:

-   `connection_id` - Unique identifier for this streaming connection (matches BidiConnectionStartEvent).
-   `reason` - Why the connection was closed. `"user_request"` after `agent.cancel()` takes effect.

#### \_\_init\_\_

```python
def __init__(connection_id: str, reason: Literal["user_request"])
```

Defined in: [src/strands/bidi/types/events.py:669](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L669)

Initialize connection stop event.

#### connection\_id

```python
@property
def connection_id() -> str
```

Defined in: [src/strands/bidi/types/events.py:684](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L684)

Unique identifier for this streaming connection.

#### reason

```python
@property
def reason() -> Literal["user_request"]
```

Defined in: [src/strands/bidi/types/events.py:689](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/types/events.py#L689)

Why the connection was closed.

#### BidiOutputEvent

Union of different bidi output event types.