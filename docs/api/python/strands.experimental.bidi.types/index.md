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

Defined in: [src/strands/experimental/bidi/types/content.py:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/content.py#L33)

An input message containing ordered content blocks.

Callers must supply at least one block when sending and must not mix tool results with user text or images. Send streaming deltas individually.

**Attributes**:

-   `content` - Ordered list of complete content blocks.

Agent-related type definitions for bidirectional streaming.

This module defines the types used for BidiAgent.

#### BidiAgentInput

A single user input or list of user content blocks.

Media input types for bidirectional streaming.

## AudioDelta

```python
@dataclass
class AudioDelta()
```

Defined in: [src/strands/experimental/bidi/types/media.py:15](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/media.py#L15)

Audio samples to append to the live input stream.

Sending a delta does not explicitly end the user’s turn.

**Attributes**:

-   `format` - Audio format.
-   `source` - Source containing the audio samples.

#### to\_dict

```python
def to_dict() -> _AudioDeltaData
```

Defined in: [src/strands/experimental/bidi/types/media.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/media.py#L28)

Return the dictionary form of this delta.

Protocols for bidirectional input and output streams.

The protocols separate input and output concerns into independent callables with lifecycle methods managed by `BidiAgent`.

## InputStream

```python
@runtime_checkable
class InputStream(Protocol)
```

Defined in: [src/strands/experimental/bidi/types/io.py:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L18)

Callable input stream managed by a bidirectional agent.

An input stream reads one value from a source each time the agent calls it.

#### start

```python
async def start(agent: "BidiAgent") -> None
```

Defined in: [src/strands/experimental/bidi/types/io.py:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L24)

Start input.

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/experimental/bidi/types/io.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L28)

Stop input.

#### \_\_call\_\_

```python
def __call__() -> Awaitable[BidiAgentInput]
```

Defined in: [src/strands/experimental/bidi/types/io.py:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L32)

Read input data from the source.

**Returns**:

Awaitable that resolves to input content (audio, text, image, etc.)

## OutputStream

```python
@runtime_checkable
class OutputStream(Protocol)
```

Defined in: [src/strands/experimental/bidi/types/io.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L42)

Callable output stream managed by a bidirectional agent.

An output stream handles one event each time the agent calls it.

#### start

```python
async def start(agent: "BidiAgent") -> None
```

Defined in: [src/strands/experimental/bidi/types/io.py:48](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L48)

Start output.

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/experimental/bidi/types/io.py:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L52)

Stop output.

#### \_\_call\_\_

```python
def __call__(event: BidiOutputEvent) -> Awaitable[None]
```

Defined in: [src/strands/experimental/bidi/types/io.py:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/io.py#L56)

Process output events from the agent.

**Arguments**:

-   `event` - Output event from the agent (audio, text, tool calls, etc.)

Bidirectional streaming types for real-time audio/text conversations.

Type definitions for bidirectional streaming that extends Strands’ existing streaming capabilities with real-time audio and persistent connection support.

Key features:

-   Audio output events with standardized formats
-   Barge-in detection and handling
-   Connection lifecycle management
-   Provider-agnostic event types
-   Type-safe discriminated unions with TypedEvent
-   JSON-serializable output events (audio stored as base64 strings)

Audio format normalization:

-   Supports PCM, WAV, Opus, and MP3 formats
-   Describes sample rates in Hz
-   Normalizes channel configurations (mono/stereo)
-   Abstracts provider-specific encodings
-   Audio output stored as base64-encoded strings for JSON compatibility

#### AudioChannel

Number of audio channels.

-   Mono: 1
-   Stereo: 2

#### AudioFormat

Audio encoding format.

#### Role

Role of a message sender.

-   “user”: Messages from the user to the assistant.
-   “assistant”: Messages from the assistant to the user.

## BidiConnectionStartEvent

```python
class BidiConnectionStartEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:80](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L80)

Streaming connection established and ready for interaction.

**Arguments**:

-   `connection_id` - Unique identifier for this streaming connection.
-   `model` - Model identifier (e.g., “gpt-realtime-2.1”, “gemini-3.8-live”).

#### \_\_init\_\_

```python
def __init__(connection_id: str, model: str)
```

Defined in: [src/strands/experimental/bidi/types/events.py:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L88)

Initialize connection start event.

#### connection\_id

```python
@property
def connection_id() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:99](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L99)

Unique identifier for this streaming connection.

#### model

```python
@property
def model() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:104](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L104)

Model identifier (e.g., ‘gpt-realtime-2.1’, ‘gemini-3.8-live’).

## BidiConnectionRestartEvent

```python
class BidiConnectionRestartEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:109](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L109)

Agent is restarting the model connection.

Emitted on both reconnect paths: reactively after the model reports a timeout, and proactively when the reconnect timer fires ahead of the provider’s limit.

**Arguments**:

-   `reason` - What triggered the restart (“timeout” reactively, “scheduled” proactively).
-   `timeout_error` - The model’s timeout error on the reactive path; None when scheduled.
-   `turn_interrupted` - True if the restart cut an in-progress or owed turn (the alignment wait could not complete it before the deadline, or a timeout struck mid-turn). The provider replays history as context, so that turn will not be answered on its own — an app can re-prompt or notify the user when this is set.

#### \_\_init\_\_

```python
def __init__(reason: Literal["timeout", "scheduled"],
             timeout_error: "ConnectionTimeoutError | None" = None,
             turn_interrupted: bool = False)
```

Defined in: [src/strands/experimental/bidi/types/events.py:124](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L124)

Initialize connection restart event.

#### reason

```python
@property
def reason() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:141](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L141)

What triggered the restart (“timeout” or “scheduled”).

#### timeout\_error

```python
@property
def timeout_error() -> "ConnectionTimeoutError | None"
```

Defined in: [src/strands/experimental/bidi/types/events.py:146](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L146)

Connection timeout error on the reactive path; None when scheduled.

#### turn\_interrupted

```python
@property
def turn_interrupted() -> bool
```

Defined in: [src/strands/experimental/bidi/types/events.py:151](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L151)

True if the restart cut an in-progress or owed turn that will not be answered.

## BidiConnectionWarningEvent

```python
class BidiConnectionWarningEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:156](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L156)

Agent is approaching a proactive reconnect.

Emitted by the proactive reconnect timer before a reconnect; informational only.

**Arguments**:

-   `time_left_s` - Approximate seconds until the scheduled reconnect.

#### \_\_init\_\_

```python
def __init__(time_left_s: float)
```

Defined in: [src/strands/experimental/bidi/types/events.py:165](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L165)

Initialize connection warning event.

#### time\_left\_s

```python
@property
def time_left_s() -> float
```

Defined in: [src/strands/experimental/bidi/types/events.py:175](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L175)

Approximate seconds until the scheduled reconnect.

## BidiResponseStartEvent

```python
class BidiResponseStartEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:180](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L180)

Start of a model response.

**Arguments**:

-   `response_id` - Unique identifier for this response (used in BidiResponseStopEvent).

#### \_\_init\_\_

```python
def __init__(response_id: str)
```

Defined in: [src/strands/experimental/bidi/types/events.py:187](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L187)

Initialize response start event.

#### response\_id

```python
@property
def response_id() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:192](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L192)

Unique identifier for this response.

## BidiAudioStartEvent

```python
class BidiAudioStartEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:197](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L197)

Beginning of an assistant audio stream, before its chunks arrive.

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/experimental/bidi/types/events.py:200](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L200)

Initialize audio start event.

## BidiAudioDeltaEvent

```python
class BidiAudioDeltaEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:205](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L205)

Incremental audio output from the model.

**Arguments**:

-   `audio` - Base64-encoded audio chunk.
-   `format` - Audio encoding format.
-   `sample_rate` - Number of audio samples per second in Hz.
-   `channels` - Number of audio channels (1=mono, 2=stereo).

#### \_\_init\_\_

```python
def __init__(audio: str, format: AudioFormat, sample_rate: int,
             channels: AudioChannel)
```

Defined in: [src/strands/experimental/bidi/types/events.py:215](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L215)

Initialize audio delta event.

#### audio

```python
@property
def audio() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:234](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L234)

Base64-encoded audio chunk.

#### format

```python
@property
def format() -> AudioFormat
```

Defined in: [src/strands/experimental/bidi/types/events.py:239](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L239)

Audio encoding format.

#### sample\_rate

```python
@property
def sample_rate() -> int
```

Defined in: [src/strands/experimental/bidi/types/events.py:244](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L244)

Number of audio samples per second in Hz.

#### channels

```python
@property
def channels() -> AudioChannel
```

Defined in: [src/strands/experimental/bidi/types/events.py:249](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L249)

Number of audio channels (1=mono, 2=stereo).

## BidiAudioStopEvent

```python
class BidiAudioStopEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:254](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L254)

End of an assistant audio stream, which may still be playing.

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/experimental/bidi/types/events.py:257](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L257)

Initialize audio stop event.

## BidiTranscriptStartEvent

```python
class BidiTranscriptStartEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:262](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L262)

Beginning of a user or assistant transcript, before its text arrives.

**Arguments**:

-   `role` - Who is speaking (“user” or “assistant”).
-   `content_id` - Unique identifier shared by this transcript’s events.

#### \_\_init\_\_

```python
def __init__(role: Role, content_id: str)
```

Defined in: [src/strands/experimental/bidi/types/events.py:270](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L270)

Initialize transcript start event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:281](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L281)

Identifier shared by this transcript’s events.

#### role

```python
@property
def role() -> Role
```

Defined in: [src/strands/experimental/bidi/types/events.py:286](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L286)

The role of the speaker.

## BidiTranscriptDeltaEvent

```python
class BidiTranscriptDeltaEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:291](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L291)

Incremental transcription of user or assistant speech.

**Arguments**:

-   `delta` - The incremental transcript text.
-   `role` - Who is speaking (“user” or “assistant”).
-   `content_id` - Unique identifier shared by this transcript’s events.

#### \_\_init\_\_

```python
def __init__(delta: str, role: Role, content_id: str)
```

Defined in: [src/strands/experimental/bidi/types/events.py:300](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L300)

Initialize transcript delta event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:312](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L312)

Identifier shared by this transcript’s events.

#### delta

```python
@property
def delta() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:317](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L317)

The incremental transcript text.

#### role

```python
@property
def role() -> Role
```

Defined in: [src/strands/experimental/bidi/types/events.py:322](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L322)

The role of the message sender.

## BidiTranscriptStopEvent

```python
class BidiTranscriptStopEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:327](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L327)

End of a user or assistant transcript, carrying its final text.

**Arguments**:

-   `transcript` - The final transcript text.
-   `role` - Who spoke (“user” or “assistant”).
-   `content_id` - Unique identifier shared by this transcript’s events.

#### \_\_init\_\_

```python
def __init__(transcript: str, role: Role, content_id: str)
```

Defined in: [src/strands/experimental/bidi/types/events.py:336](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L336)

Initialize transcript stop event.

#### content\_id

```python
@property
def content_id() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:348](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L348)

Identifier shared by this transcript’s events.

#### transcript

```python
@property
def transcript() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:353](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L353)

The final transcript text.

#### role

```python
@property
def role() -> Role
```

Defined in: [src/strands/experimental/bidi/types/events.py:358](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L358)

The role of the speaker.

## BidiBargeInEvent

```python
class BidiBargeInEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:363](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L363)

Stop current response generation or playback while the session continues.

**Arguments**:

-   `reason` - Why response output should stop.

#### \_\_init\_\_

```python
def __init__(reason: Literal["user_speech", "error"])
```

Defined in: [src/strands/experimental/bidi/types/events.py:370](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L370)

Initialize barge-in event.

#### reason

```python
@property
def reason() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:380](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L380)

Why response output should stop.

## BidiResponseStopEvent

```python
class BidiResponseStopEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:385](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L385)

Response output ended. User transcription may still be pending.

**Arguments**:

-   `response_id` - ID of the response that ended (matches BidiResponseStartEvent).

#### \_\_init\_\_

```python
def __init__(response_id: str)
```

Defined in: [src/strands/experimental/bidi/types/events.py:392](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L392)

Initialize response stop event.

#### response\_id

```python
@property
def response_id() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:402](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L402)

Unique identifier for this response.

## ModalityUsage

```python
class ModalityUsage(dict)
```

Defined in: [src/strands/experimental/bidi/types/events.py:407](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L407)

Token usage for a specific modality.

**Attributes**:

-   `modality` - Type of content.
-   `input_tokens` - Tokens used for this modality’s input.
-   `output_tokens` - Tokens used for this modality’s output.

## BidiUsageEvent

```python
class BidiUsageEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:421](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L421)

Token usage event with modality breakdown for bidirectional streaming.

Tracks token consumption across different modalities (audio, text, images) during bidirectional streaming sessions.

**Arguments**:

-   `input_tokens` - Total tokens used for all input modalities.
-   `output_tokens` - Total tokens used for all output modalities.
-   `total_tokens` - Sum of input and output tokens.
-   `modality_details` - Optional list of token usage per modality.
-   `cache_read_input_tokens` - Optional tokens read from cache.
-   `cache_write_input_tokens` - Optional tokens written to cache.

#### \_\_init\_\_

```python
def __init__(input_tokens: int,
             output_tokens: int,
             total_tokens: int,
             modality_details: list[ModalityUsage] | None = None,
             cache_read_input_tokens: int | None = None,
             cache_write_input_tokens: int | None = None)
```

Defined in: [src/strands/experimental/bidi/types/events.py:436](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L436)

Initialize usage event.

#### input\_tokens

```python
@property
def input_tokens() -> int
```

Defined in: [src/strands/experimental/bidi/types/events.py:461](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L461)

Total tokens used for all input modalities.

#### output\_tokens

```python
@property
def output_tokens() -> int
```

Defined in: [src/strands/experimental/bidi/types/events.py:466](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L466)

Total tokens used for all output modalities.

#### total\_tokens

```python
@property
def total_tokens() -> int
```

Defined in: [src/strands/experimental/bidi/types/events.py:471](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L471)

Sum of input and output tokens.

#### modality\_details

```python
@property
def modality_details() -> list[ModalityUsage]
```

Defined in: [src/strands/experimental/bidi/types/events.py:476](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L476)

Optional list of token usage per modality.

#### cache\_read\_input\_tokens

```python
@property
def cache_read_input_tokens() -> int | None
```

Defined in: [src/strands/experimental/bidi/types/events.py:481](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L481)

Optional tokens read from cache.

#### cache\_write\_input\_tokens

```python
@property
def cache_write_input_tokens() -> int | None
```

Defined in: [src/strands/experimental/bidi/types/events.py:486](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L486)

Optional tokens written to cache.

## BidiConnectionStopEvent

```python
class BidiConnectionStopEvent(TypedEvent)
```

Defined in: [src/strands/experimental/bidi/types/events.py:491](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L491)

Streaming connection closed.

**Arguments**:

-   `connection_id` - Unique identifier for this streaming connection (matches BidiConnectionStartEvent).
-   `reason` - Why the connection was closed.

#### \_\_init\_\_

```python
def __init__(connection_id: str,
             reason: Literal["client_disconnect", "timeout", "error",
                             "complete", "user_request"])
```

Defined in: [src/strands/experimental/bidi/types/events.py:499](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L499)

Initialize connection stop event.

#### connection\_id

```python
@property
def connection_id() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:514](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L514)

Unique identifier for this streaming connection.

#### reason

```python
@property
def reason() -> str
```

Defined in: [src/strands/experimental/bidi/types/events.py:519](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/types/events.py#L519)

Why the connection was closed.

#### BidiOutputEvent

Union of different bidi output event types.