Configuration types and helpers for bidirectional model providers.

## AudioStreamConfig

```python
class AudioStreamConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:13](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L13)

Resolved format of an audio stream.

**Attributes**:

-   `sample_rate` - Sample rate in Hz.
-   `channels` - Number of audio channels.
-   `format` - Audio encoding.

## AudioConfig

```python
class AudioConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:27](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L27)

Resolved input and output formats consumed by audio I/O.

Pass provider-specific audio options to the model constructor and use `get_audio_config()` to obtain the resulting stream formats.

**Attributes**:

-   `input` - Audio format configured for model input.
-   `output` - Audio format produced by the model.

## BedrockNovaSonicAudioStreamConfig

```python
class BedrockNovaSonicAudioStreamConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L42)

Nova Sonic stream options. Audio uses mono PCM.

**Attributes**:

-   `sample_rate` - Sample rate in Hz.

## BedrockNovaSonicAudioConfig

```python
class BedrockNovaSonicAudioConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L52)

Nova Sonic input and output audio options.

Omitted streams use a sample rate of 16000 Hz.

**Attributes**:

-   `input` - Input stream options.
-   `output` - Output stream options.

## GoogleGeminiLiveAudioStreamConfig

```python
class GoogleGeminiLiveAudioStreamConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L66)

Gemini Live input stream options. Audio uses mono PCM.

**Attributes**:

-   `sample_rate` - Input sample rate in Hz.

## GoogleGeminiLiveAudioConfig

```python
class GoogleGeminiLiveAudioConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L76)

Gemini Live audio options. Output is mono PCM at 24000 Hz.

Omitting the input stream uses a sample rate of 16000 Hz.

**Attributes**:

-   `input` - Input stream options.

## ConnectionConfig

```python
class ConnectionConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L88)

Declared reconnect timing for a bidirectional model.

Providers declare this so the agent loop can reconnect proactively, before the provider terminates the connection on its own limit. A provider that declares nothing (empty config) keeps reactive-only behavior: no proactive timer, reconnect only after the provider reports a timeout.

All fields are optional. The proactive timer arms only when `restart_after_s` is declared.

**Attributes**:

-   `restart_after_s` - Seconds after a connection is established at which to proactively reconnect. Set it at least ~10s below the provider’s own connection limit: the reconnect may wait briefly for the current turn to finish (aligning the swap to a turn boundary), and that wait plus the swap must complete before the provider’s limit.
-   `auto_reconnect` - Whether the loop reconnects automatically (default True).

## ModelConfig

```python
class ModelConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:110](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L110)

Configuration shared by bidirectional model providers.

**Attributes**:

-   `model_id` - Provider model identifier.
-   `params` - Provider-specific keyword arguments passed to the model request or session.
-   `connection` - Reconnect timing overrides.

## ModelUpdateConfig

```python
class ModelUpdateConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/models/configs.py:124](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/configs.py#L124)

Partial configuration update shared by bidirectional model providers.

**Attributes**:

-   `model_id` - Provider model identifier.
-   `params` - Provider-specific keyword arguments passed to the model request or session.
-   `connection` - Reconnect timing overrides.

Amazon Bedrock Nova Sonic provider for real-time streaming conversations.

Implements the BidiModel interface for Amazon’s Nova Sonic, handling the complex event sequencing and audio processing required by Nova Sonic’s InvokeModelWithBidirectionalStream protocol.

Nova Sonic specifics:

-   Hierarchical event sequences: connectionStart → promptStart → content streaming
-   Base64-encoded audio format with hex encoding
-   Tool execution with content containers and identifier tracking
-   8-minute connection limits with proper cleanup sequences
-   Barge-in detection through stopReason events

Note, BedrockNovaSonicModel is only supported for Python 3.12+

## BedrockNovaSonicModel

```python
class BedrockNovaSonicModel(BidiModel, AudioCapable)
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:212](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L212)

Amazon Bedrock Nova Sonic implementation for bidirectional streaming.

Combines model configuration and connection state in a single class. Manages Nova Sonic’s complex event sequencing, audio format conversion, and tool execution patterns while providing the standard BidiModel interface.

Note, BedrockNovaSonicModel is only supported for Python 3.12+.

**Attributes**:

-   `_stream` - open bedrock stream to nova sonic.

#### \_\_init\_\_

```python
def __init__(*,
             boto_session: Session | None = None,
             region: str | None = None,
             audio: BedrockNovaSonicAudioConfig | None = None,
             voice: str = "matthew",
             **model_config: Unpack[ModelConfig]) -> None
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:227](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L227)

Initialize Nova Sonic bidirectional model.

**Arguments**:

-   `boto_session` - Boto3 session used to resolve credentials and region.
-   `region` - AWS region. Cannot be combined with `boto_session`.
-   `audio` - Audio configuration.
-   `voice` - Output voice identifier. Defaults to `matthew`.
-   `**model_config` - Model configuration.

**Raises**:

-   `ValueError` - If any of the following conditions apply:
    
    -   Required model configuration fields are missing.
    -   `model_id` is not a non-empty string.
    -   Audio options or the resolved region are invalid.
    -   Both `boto_session` and `region` are provided.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[ModelUpdateConfig]) -> None
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:283](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L283)

Update the model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

**Raises**:

-   `ValueError` - If any of the following conditions apply:
    
    -   The resulting configuration is missing required fields.
    -   `model_id` is not a non-empty string.

#### get\_config

```python
@override
def get_config() -> ModelConfig
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:299](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L299)

Return the model configuration by reference.

#### get\_audio\_config

```python
@override
def get_audio_config() -> AudioConfig
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:304](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L304)

Get the resolved audio configuration.

#### start

```python
async def start(system_prompt: str | None = None,
                tools: list[ToolSpec] | None = None,
                messages: Messages | None = None,
                **kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:327](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L327)

Establish bidirectional connection to Nova Sonic.

**Arguments**:

-   `system_prompt` - System instructions for the model.
-   `tools` - List of tools available to the model.
-   `messages` - Conversation history to initialize with.
-   `**kwargs` - Additional configuration options.

**Raises**:

-   `RuntimeError` - If user calls start again without first stopping.

#### receive

```python
async def receive() -> AsyncGenerator[BidiOutputEvent, None]
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:464](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L464)

Receive Nova Sonic events and convert to provider-agnostic format.

**Raises**:

-   `RuntimeError` - If start has not been called.

#### send

```python
async def send(content: BidiMessage | BidiContentDelta) -> None
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:513](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L513)

Unified send method for all content types. Sends the given content to Nova Sonic.

Dispatches to appropriate internal handler based on content type.

**Arguments**:

-   `content` - A complete BidiMessage or an individual AudioDelta.

**Raises**:

-   `ValueError` - If content type not supported (e.g., image content).

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:668](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L668)

Close Nova Sonic connection with proper cleanup sequence.

#### restart

```python
async def restart(system_prompt: str | None = None,
                  tools: list[ToolSpec] | None = None,
                  messages: Messages | None = None,
                  **restart_kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/bedrock.py:705](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/bedrock.py#L705)

Restart by closing the connection and starting a new one, replaying messages.

**Arguments**:

-   `system_prompt` - System instructions for the new connection.
-   `tools` - Tool specifications for the new connection.
-   `messages` - Conversation history to replay into the new connection.
-   `**restart_kwargs` - Reserved for provider-specific restart options.

Google Gemini Live model provider using the Gemini Live API and official Google GenAI SDK.

Implements the BidiModel interface for Google’s Gemini Live API using the official Google GenAI SDK for simplified and robust WebSocket communication.

Key improvements over custom WebSocket implementation:

-   Uses official google-genai SDK with native Live API support
-   Simplified session management with client.aio.live.connect()
-   Built-in tool integration and event handling
-   Automatic WebSocket connection management and error handling
-   Native support for audio/text streaming and barge-in

## GoogleGeminiLiveModel

```python
class GoogleGeminiLiveModel(BidiModel, AudioCapable)
```

Defined in: [src/strands/experimental/bidi/models/google.py:101](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L101)

Google Gemini Live implementation using the official Google GenAI SDK.

Combines model configuration and connection state in a single class. Provides a clean interface to Gemini Live API using the official SDK, eliminating custom WebSocket handling and providing robust error handling.

#### \_\_init\_\_

```python
def __init__(*,
             client_args: dict[str, Any] | None = None,
             audio: GoogleGeminiLiveAudioConfig | None = None,
             voice: str | None = None,
             **model_config: Unpack[ModelConfig]) -> None
```

Defined in: [src/strands/experimental/bidi/models/google.py:109](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L109)

Initialize the Google Gemini Live bidirectional model.

**Arguments**:

-   `client_args` - Arguments for the underlying Google GenAI client.
-   `audio` - Audio configuration.
-   `voice` - Prebuilt output voice name. Omit to use the provider’s default.
-   `**model_config` - Model configuration.

**Raises**:

-   `ValueError` - If any of the following conditions apply:
    
    -   Required model configuration fields are missing.
    -   `model_id` is not a non-empty string.
    -   The input sample rate is not positive.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[ModelUpdateConfig]) -> None
```

Defined in: [src/strands/experimental/bidi/models/google.py:155](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L155)

Update the model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

**Raises**:

-   `ValueError` - If any of the following conditions apply:
    
    -   The resulting configuration is missing required fields.
    -   `model_id` is not a non-empty string.

#### get\_config

```python
@override
def get_config() -> ModelConfig
```

Defined in: [src/strands/experimental/bidi/models/google.py:171](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L171)

Return the model configuration by reference.

#### get\_audio\_config

```python
@override
def get_audio_config() -> AudioConfig
```

Defined in: [src/strands/experimental/bidi/models/google.py:176](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L176)

Get the resolved audio configuration.

#### start

```python
async def start(system_prompt: str | None = None,
                tools: list[ToolSpec] | None = None,
                messages: Messages | None = None,
                **kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/google.py:197](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L197)

Establish bidirectional connection with Gemini Live API.

**Arguments**:

-   `system_prompt` - System instructions for the model.
-   `tools` - List of tools available to the model.
-   `messages` - Conversation history to initialize with.
-   `**kwargs` - Additional configuration options.

#### receive

```python
async def receive() -> AsyncGenerator[BidiOutputEvent, None]
```

Defined in: [src/strands/experimental/bidi/models/google.py:268](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L268)

Receive Gemini Live API events and convert to provider-agnostic format.

#### send

```python
async def send(content: BidiMessage | BidiContentDelta) -> None
```

Defined in: [src/strands/experimental/bidi/models/google.py:547](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L547)

Unified send method for all content types. Sends the given inputs to the Gemini Live API.

Dispatches to appropriate internal handler based on content type.

**Arguments**:

-   `content` - A complete BidiMessage or an individual AudioDelta.

**Raises**:

-   `ValueError` - If content type not supported.

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/experimental/bidi/models/google.py:642](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L642)

Close Gemini Live API connection.

#### restart

```python
async def restart(system_prompt: str | None = None,
                  tools: list[ToolSpec] | None = None,
                  messages: Messages | None = None,
                  **restart_kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/google.py:662](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py#L662)

Restart by closing the connection and resuming the same session via its handle.

Resumes the Gemini session using the last resumption handle so server-side context carries across the swap without replaying history. The handle is supplied by the reactive (GoAway) path via `restart_kwargs` or read from the tracked handle on the proactive path. When no handle is available yet, falls back to a fresh connection with history replay.

**Arguments**:

-   `system_prompt` - System instructions for the resumed connection.
-   `tools` - Tool specifications for the resumed connection.
-   `messages` - Conversation history, replayed only when resuming without a handle.
-   `**restart_kwargs` - Provider restart options; `live_session_handle` resumes the session.

OpenAI Realtime API provider for Strands bidirectional streaming.

Provides real-time audio and text communication through OpenAI’s Realtime API with WebSocket connections, voice activity detection, and function calling.

## OpenAIRealtimeModel

```python
class OpenAIRealtimeModel(BidiModel, AudioCapable)
```

Defined in: [src/strands/experimental/bidi/models/openai.py:148](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L148)

OpenAI Realtime API implementation for bidirectional streaming.

Combines model configuration and connection state in a single class. Manages WebSocket connection to OpenAI’s Realtime API with automatic VAD, function calling, and event conversion to Strands format.

#### \_\_init\_\_

```python
def __init__(*,
             transcription_model_id: str | None,
             api_key: str | None = None,
             organization: str | None = None,
             project: str | None = None,
             timeout_s: int = OPENAI_MAX_TIMEOUT_S,
             voice: str = "alloy",
             **model_config: Unpack[ModelConfig]) -> None
```

Defined in: [src/strands/experimental/bidi/models/openai.py:159](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L159)

Initialize OpenAI Realtime bidirectional model.

**Arguments**:

-   `transcription_model_id` - Input transcription model identifier. Pass `None` to disable user transcription.
-   `api_key` - OpenAI API key. Defaults to `OPENAI_API_KEY`.
-   `organization` - OpenAI organization. Defaults to `OPENAI_ORGANIZATION`.
-   `project` - OpenAI project. Defaults to `OPENAI_PROJECT`.
-   `timeout_s` - Maximum connection duration in seconds.
-   `voice` - Output voice identifier. Defaults to `alloy`.
-   `**model_config` - Model configuration.

**Raises**:

-   `ValueError` - If any of the following conditions apply:
    
    -   Required model configuration fields are missing.
    -   `model_id` is not a non-empty string.
    -   The API key is missing.
    -   `timeout_s` exceeds the maximum.
    -   The configured audio formats are unsupported.

#### update\_config

```python
@override
def update_config(**model_config: Unpack[ModelUpdateConfig]) -> None
```

Defined in: [src/strands/experimental/bidi/models/openai.py:234](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L234)

Update the model configuration with the provided arguments.

**Arguments**:

-   `**model_config` - Configuration overrides.

**Raises**:

-   `ValueError` - If any of the following conditions apply:
    
    -   The resulting configuration is missing required fields.
    -   `model_id` is not a non-empty string.
    -   The configured audio formats are unsupported.

#### get\_config

```python
@override
def get_config() -> ModelConfig
```

Defined in: [src/strands/experimental/bidi/models/openai.py:253](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L253)

Return the model configuration by reference.

#### get\_audio\_config

```python
@override
def get_audio_config() -> AudioConfig
```

Defined in: [src/strands/experimental/bidi/models/openai.py:258](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L258)

Get the resolved audio configuration.

#### start

```python
async def start(system_prompt: str | None = None,
                tools: list[ToolSpec] | None = None,
                messages: Messages | None = None,
                **kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/openai.py:283](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L283)

Establish bidirectional connection to OpenAI Realtime API.

**Arguments**:

-   `system_prompt` - System instructions for the model.
-   `tools` - List of tools available to the model.
-   `messages` - Conversation history to initialize with.
-   `**kwargs` - Additional configuration options.

#### receive

```python
async def receive() -> AsyncGenerator[BidiOutputEvent, None]
```

Defined in: [src/strands/experimental/bidi/models/openai.py:480](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L480)

Receive OpenAI events and convert to Strands TypedEvent format.

#### send

```python
async def send(content: BidiMessage | BidiContentDelta) -> None
```

Defined in: [src/strands/experimental/bidi/models/openai.py:777](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L777)

Unified send method for all content types. Sends the given content to OpenAI.

Dispatches to appropriate internal handler based on content type.

**Arguments**:

-   `content` - A complete BidiMessage or an individual AudioDelta.

**Raises**:

-   `ValueError` - If content type not supported.

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/experimental/bidi/models/openai.py:874](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L874)

Close session and cleanup resources.

#### restart

```python
async def restart(system_prompt: str | None = None,
                  tools: list[ToolSpec] | None = None,
                  messages: Messages | None = None,
                  **restart_kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/openai.py:891](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/openai.py#L891)

Restart by closing the connection and starting a new one, replaying history.

OpenAI’s Realtime API exposes no server-side resume handle, so a restart re-establishes the session and replays the accumulated conversation history to preserve context across the swap.

**Arguments**:

-   `system_prompt` - System instructions for the new connection.
-   `tools` - Tool specifications for the new connection.
-   `messages` - Conversation history to replay into the new connection.
-   `**restart_kwargs` - Reserved for provider-specific restart options.

Bidirectional streaming model interface.

Defines the abstract interface for models that support real-time bidirectional communication with persistent connections. Unlike traditional request-response models, bidirectional models maintain an open connection for streaming audio, text, and tool interactions.

Features:

-   Persistent connection management with connect/close lifecycle
-   Real-time bidirectional communication (send and receive simultaneously)
-   Provider-agnostic event normalization
-   Support for audio, text, image, and tool result streaming

## Restartable

```python
@runtime_checkable
class Restartable(Protocol)
```

Defined in: [src/strands/experimental/bidi/models/model.py:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L32)

A bidirectional model that can replace its active connection while preserving context.

#### restart

```python
async def restart(system_prompt: str | None = None,
                  tools: list[ToolSpec] | None = None,
                  messages: Messages | None = None,
                  **restart_kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/model.py:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L35)

Replace the active connection while preserving conversation context.

**Arguments**:

-   `system_prompt` - System instructions for the new connection.
-   `tools` - Tool specifications for the new connection.
-   `messages` - Conversation history to replay when required by the provider.
-   `**restart_kwargs` - Provider-specific restart options.

## BidiModel

```python
class BidiModel(Model, abc.ABC)
```

Defined in: [src/strands/experimental/bidi/models/model.py:53](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L53)

Abstract base class for bidirectional streaming models.

This interface defines the contract for models that support persistent streaming connections with real-time audio and text communication. Implementations handle provider-specific protocols while exposing a standardized event-based API.

**Attributes**:

-   `model_id` - Provider model identifier.
-   `usage_is_cumulative` - Whether the provider reports cumulative connection token totals (True) rather than per-response deltas (False, the default when absent). Providers reporting deltas may omit it.

#### model\_id

```python
@property
def model_id() -> str
```

Defined in: [src/strands/experimental/bidi/models/model.py:70](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L70)

Get the configured model identifier.

#### get\_connection\_config

```python
def get_connection_config() -> ConnectionConfig
```

Defined in: [src/strands/experimental/bidi/models/model.py:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L74)

Get the configured reconnect timing, or an empty config if unspecified.

#### structured\_output

```python
def structured_output(*args: Any, **kwargs: Any) -> NoReturn
```

Defined in: [src/strands/experimental/bidi/models/model.py:78](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L78)

Raise because bidirectional models do not support structured output.

#### stream

```python
def stream(*args: Any, **kwargs: Any) -> NoReturn
```

Defined in: [src/strands/experimental/bidi/models/model.py:82](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L82)

Raise because bidirectional models use their persistent streaming API.

#### start

```python
@abc.abstractmethod
async def start(system_prompt: str | None = None,
                tools: list[ToolSpec] | None = None,
                messages: Messages | None = None,
                **kwargs: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/model.py:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L88)

Establish a persistent streaming connection with the model.

Opens a bidirectional connection that remains active for real-time communication. The connection supports concurrent sending and receiving of events until explicitly closed. Must be called before any send() or receive() operations.

**Arguments**:

-   `system_prompt` - System instructions to configure model behavior.
-   `tools` - Tool specifications that the model can invoke during the conversation.
-   `messages` - Initial conversation history to provide context.
-   `**kwargs` - Provider-specific configuration options.

#### stop

```python
@abc.abstractmethod
async def stop() -> None
```

Defined in: [src/strands/experimental/bidi/models/model.py:111](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L111)

Close the streaming connection and release resources.

Terminates the active bidirectional connection and cleans up any associated resources such as network connections, buffers, or background tasks. After calling close(), the model instance cannot be used until start() is called again.

#### receive

```python
@abc.abstractmethod
def receive() -> AsyncIterable[BidiOutputEvent]
```

Defined in: [src/strands/experimental/bidi/models/model.py:122](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L122)

Receive streaming events from the model.

Each transcript has start and stop events, with zero or more deltas between them, sharing a content\_id unique within the connection. Transcript streams may interleave, and user transcripts may arrive outside response boundaries.

The stream continues until the connection is closed or an error occurs.

**Yields**:

-   `BidiOutputEvent` - Standardized event objects containing audio output, transcripts, tool calls, or control signals.

#### send

```python
@abc.abstractmethod
async def send(content: BidiMessage | BidiContentDelta) -> None
```

Defined in: [src/strands/experimental/bidi/models/model.py:139](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L139)

Send a complete message or an individual delta over the active connection.

**Arguments**:

-   `content` - A message of text and image blocks, a message of tool results, or a streaming audio delta. Complete messages preserve block order and request a response after delivery, subject to provider turn and tool scheduling. A message may require several provider events.

**Raises**:

-   `ValueError` - If the content is unsupported by the provider.

**Example**:

```plaintext
from strands.experimental.bidi.types import AudioDelta, BidiMessage
from strands.types.content import TextBlock
from strands.types.media import ImageBlock
from strands.types.tools import ToolResultBlock

await model.send(BidiMessage(content=[
    ImageBlock(format="jpeg", source=\{"bytes": image_bytes}),
    TextBlock("What is in this image?"),
]))
await model.send(AudioDelta(format="pcm", source=\{"bytes": audio_bytes}))
await model.send(BidiMessage(content=[
    ToolResultBlock(tool_use_id="call-1", status="success", content=[\{"text": "Done"}]),
]))
```

## ConnectionTimeoutError

```python
class ConnectionTimeoutError(Exception)
```

Defined in: [src/strands/experimental/bidi/models/model.py:171](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L171)

Persistent model connection timeout.

Bidirectional models are often configured with a connection time limit. Bedrock Nova Sonic, for example, keeps the connection open for 8 minutes max. Upon receiving a timeout, the agent loop is configured to restart the model connection so as to create a seamless, uninterrupted experience for the user.

#### \_\_init\_\_

```python
def __init__(message: str, **restart_config: Any) -> None
```

Defined in: [src/strands/experimental/bidi/models/model.py:179](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L179)

Initialize error.

**Arguments**:

-   `message` - Timeout message from model.
-   `**restart_config` - Configure restart specific behaviors in the call to model start.

## AudioCapable

```python
@runtime_checkable
class AudioCapable(Protocol)
```

Defined in: [src/strands/experimental/bidi/models/model.py:192](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L192)

Protocol for models that support audio input and output.

#### get\_audio\_config

```python
def get_audio_config() -> AudioConfig
```

Defined in: [src/strands/experimental/bidi/models/model.py:195](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/model.py#L195)

Get the resolved audio configuration.