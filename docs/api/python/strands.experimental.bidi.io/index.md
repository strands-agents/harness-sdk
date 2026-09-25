Configuration types for bidirectional I/O.

## AudioProcessorConfig

```python
class AudioProcessorConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/io/configs.py:6](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/configs.py#L6)

Configure microphone audio processing.

**Attributes**:

-   `echo_cancellation` - Cancel the agent’s own speaker audio from the mic input.
-   `stream_delay_ms` - Playback-to-capture delay hint in milliseconds for AEC.

## AudioIOConfig

```python
class AudioIOConfig(TypedDict)
```

Defined in: [src/strands/experimental/bidi/io/configs.py:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/configs.py#L18)

Configure bidirectional audio input and output.

Send and receive audio data from devices.

Reads user audio from input device and sends agent audio to output device using PyAudio. If a user barges in, the output buffer is cleared to stop playback.

Audio configuration is provided by models that implement `AudioCapable`.

Optional microphone audio processing (acoustic echo cancellation, noise suppression, and automatic gain control) is enabled by passing `audio_processor=True` or an `AudioProcessorConfig` to `AudioIO`. It requires pywebrtc-audio (pip install strands-agents\[bidi-aec\]).

## AudioIO

```python
class AudioIO()
```

Defined in: [src/strands/experimental/bidi/io/audio.py:304](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/audio.py#L304)

Send and receive audio data from devices using PyAudio.

Reads microphone audio via `input()`, plays agent audio via `output()`, and displays user and assistant transcripts. Barge-ins clear the playback buffer to stop the agent mid-response.

When `audio_processor=True` or an `AudioProcessorConfig` is passed, the microphone signal gets audio processing and, when echo cancellation is enabled, the agent’s speaker output is used as a reference to cancel echo from the mic input. A shared processor coordinates the input and output channels, so echo cancellation only works when both come from the *same* `AudioIO` instance.

Audio processing requires pywebrtc-audio (`pip install strands-agents[bidi-aec]`) and a microphone sample rate of 16000, 32000, or 48000 Hz (set via the model’s audio config).

Device audio requires PyAudio. Install the PortAudio system library, then install `strands-agents[bidi-pyaudio]`.

**Example**:

```python
from strands.experimental.bidi.io import AudioIO, AudioProcessorConfig

# Plain mic/speaker, no processing (a headset is recommended to avoid echo):
audio_io = AudioIO()
await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])

# Full processing with defaults: echo cancellation, noise suppression, and auto gain control:
audio_io = AudioIO(audio_processor=True)
await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])

# Noise suppression and auto gain control without echo cancellation (e.g. headset users):
audio_io = AudioIO(audio_processor=AudioProcessorConfig(echo_cancellation=False))
await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])

# Processing on a specific input device:
audio_io = AudioIO(audio_processor=AudioProcessorConfig(), input_device_index=1)
await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])
```

#### \_\_init\_\_

```python
def __init__(**config: Unpack[AudioIOConfig]) -> None
```

Defined in: [src/strands/experimental/bidi/io/audio.py:346](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/audio.py#L346)

Initialize audio devices.

**Arguments**:

-   `**config` - Optional configuration:
    
    -   audio\_processor (bool | AudioProcessorConfig): Set to True to enable microphone audio processing with defaults, or supply a configuration for custom options. False and None disable processing.
    -   input\_buffer\_size (int): Maximum input buffer size (default: None). Must be between 1 and 100 when echo cancellation is on; defaults to 100 so the mic and reference buffers remain aligned.
    -   input\_device\_index (int): Specific input device (default: None = system default)
    -   input\_frames\_per\_buffer (int): Input buffer size (default: 512). Must not be provided when echo cancellation is on because it is calculated from the model’s input rate.
    -   output\_buffer\_size (int): Maximum output buffer size (default: None)
    -   output\_device\_index (int): Specific output device (default: None = system default)
    -   output\_frames\_per\_buffer (int): Output buffer size (default: 512). Must not be provided when echo cancellation is on because it is calculated from the model’s output rate.

**Raises**:

-   `ImportError` - If audio processing is configured but its optional dependencies are unavailable.
-   `ValueError` - If the configuration is invalid.

#### input

```python
def input() -> _AudioInputStream
```

Defined in: [src/strands/experimental/bidi/io/audio.py:442](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/audio.py#L442)

Return the microphone input stream.

#### output

```python
def output() -> _AudioOutputStream
```

Defined in: [src/strands/experimental/bidi/io/audio.py:449](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/audio.py#L449)

Return the speaker and transcript output stream.

Handle text input and output to and from bidi agent.

## ConsoleIO

```python
class ConsoleIO()
```

Defined in: [src/strands/experimental/bidi/io/text.py:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/text.py#L56)

Handle text input and output to and from bidi agent.

Accepts input from stdin and outputs to stdout.

#### \_\_init\_\_

```python
def __init__(**config: Any) -> None
```

Defined in: [src/strands/experimental/bidi/io/text.py:62](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/text.py#L62)

Initialize I/O.

**Arguments**:

-   `**config` - Optional I/O configurations.
    
    -   input\_prompt (str): Input prompt to display on screen (default: blank)

#### input

```python
def input() -> _ConsoleInputStream
```

Defined in: [src/strands/experimental/bidi/io/text.py:72](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/text.py#L72)

Return the standard-input stream.

#### output

```python
def output() -> _ConsoleOutputStream
```

Defined in: [src/strands/experimental/bidi/io/text.py:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/io/text.py#L76)

Return the standard-output stream.