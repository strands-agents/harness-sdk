## What is a Bidirectional Streaming Agent?

A bidirectional streaming agent enables real-time, two-way voice conversations with AI models. Unlike traditional request-response patterns, these agents:

-   **Stream audio in both directions** - Speak naturally while the agent listens and responds with voice
-   **Support interruptions** - Cut in at any time, just like a real conversation
-   **Execute tools in real-time** - The agent can call functions (like calculations or searches) while maintaining the conversation flow
-   **Provide live transcripts** - See what you said and what the agent is saying as it happens

These samples demonstrates how to build voice-enabled AI agents using Strands with models like AWS Nova Sonic, Google Gemini Live, and OpenAI Realtime API.

```python
import operator
from typing import Literal

from strands.experimental.bidi.agent import BidiAgent
from strands import tool
from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel

_OPS = {
    "+": operator.add,
    "-": operator.sub,
    "*": operator.mul,
    "/": operator.truediv,
    "**": operator.pow,
}


@tool
def calculator(a: float, b: float, op: Literal["+", "-", "*", "/", "**"]) -> float:
    """Apply an arithmetic operator to two numbers.

    Args:
        a: Left operand.
        b: Right operand.
        op: One of "+", "-", "*", "/", "**".
    """
    return _OPS[op](a, b)

# Create a voice-enabled agent with tools
agent = BidiAgent(
    model=BidiNovaSonicModel(
        region="us-east-1",
        model_id="amazon.nova-2-sonic-v1:0", # default to v2
        provider_config={
            "audio": {
                "input_sample_rate": 16000,
                "output_sample_rate": 16000,
                "voice": "matthew"
            },
            "turn_detection": {
                "endpointingSensitivity": "HIGH" # HIGH, MEDIUM, LOW
            }
        }
    ),
    tools=[calculator],
    system_prompt="You are a helpful voice assistant."
)

# Start streaming conversation
await agent.run(inputs=[...], outputs=[...])
```

## Architecture

```plaintext
Browser (HTML/JS) ←→ WebSocket ←→ BidiAgent ←→ AI Model
```

-   Browser captures microphone audio and encodes to base64 PCM
-   WebSocket forwards audio events bidirectionally
-   BidiAgent processes audio and executes tools
-   Responses stream back as audio + transcripts

## Installation

### Prerequisites

-   Python 3.12+
-   pip or uv package manager

### Setup

1.  **Create virtual environment**

```bash
python -m venv .venv

# Mac or Linux
source .venv/bin/activate

# On Windows:
.venv\Scripts\activate
```

2.  **Install dependencies**

```bash
pip install -r requirements.txt
```

Or install directly:

```bash
pip install fastapi uvicorn strands-agents[bidi-all]
```

3.  **Set up credentials** (for the models you want to use)

**For AWS Nova Sonic:**

```bash
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
export AWS_SESSION_TOKEN="your-token"  # if using temporary credentials
```

**For Google Gemini Live:**

```bash
export GOOGLE_API_KEY="your-key"
```

**For OpenAI Realtime:**

```bash
export OPENAI_API_KEY="your-key"
```

## Usage

### WebSocket Demo (Recommended)

Start the WebSocket server with automatic browser launch:

```bash
# On default port: 8000
python websocket_example.py
```

Or specify a custom port:

```bash
python websocket_example.py 8080
```

The browser will automatically open to `http://localhost:8000` (or your specified port).

**In the browser:**

1.  Select your preferred AI model from the dropdown
2.  Click ”🚀 Start Session” to connect and start recording
3.  Speak naturally - try “What is 25 times 8?”
4.  The agent will respond with voice and show transcripts
5.  You can interrupt the agent by speaking while it’s talking
6.  Click ”🛑 End Session” to stop

### Command-Line Tests

Test individual models directly from the command line:

> **⚠️ Important:** The command-line tests use PyAudio which does **not** have echo cancellation. You **must** use a headset to prevent audio feedback loops. For the best experience with speakers, use the WebSocket demo which has echo cancellation enabled in the browser.

**Nova Sonic:**

```bash
python test_simple_novasonic.py
```

**Gemini Live:**

```bash
python test_simple_gemini.py
```

**OpenAI Realtime:**

```bash
python test_simple_openai.py
```

## Project Structure

```plaintext
.
├── websocket_example.py      # FastAPI WebSocket server
├── websocket_client.html     # Modern web UI client
├── test_simple_novasonic.py  # Nova Sonic CLI test
├── test_simple_gemini.py     # Gemini Live CLI test
├── test_simple_openai.py     # OpenAI Realtime CLI test
├── requirements.txt          # Python dependencies
└── README.md                 # This file
```

## WebSocket Events

### Client → Server

-   `bidi_audio_input` - PCM audio chunks from microphone
    -   Format: base64-encoded PCM
    -   Sample rate: Model-specific (16kHz or 24kHz)
    -   Channels: 1 (mono)

### Server → Client

-   `bidi_audio_stream` - PCM audio response from agent
-   `bidi_transcript_stream` - Real-time transcription (user/assistant)
-   `bidi_interruption` - Notification when user interrupts
-   `tool_use_stream` - Tool execution started
-   `tool_result` - Tool execution result

## Event Formats

### Client → Server Events

**bidi\_audio\_input**

```json
{
  "type": "bidi_audio_input",
  "audio": "base64-encoded-pcm-data..."
}
```

Send audio chunks from the microphone as base64-encoded PCM. The sample rate should match the model’s requirements (16kHz for Nova Sonic, 24kHz for Gemini/OpenAI).

### Server → Client Events

**bidi\_audio\_stream**

```json
{
  "type": "bidi_audio_stream",
  "audio": "base64-encoded-pcm-data..."
}
```

Receive audio response from the agent. Decode and play through speakers.

**bidi\_transcript\_stream**

```json
{
  "type": "bidi_transcript_stream",
  "role": "user",  // or "assistant"
  "text": "What is 25 times 8?"
}
```

Real-time transcription of both user speech and assistant responses.

**bidi\_interruption**

```json
{
  "type": "bidi_interruption"
}
```

Sent when the user interrupts the agent. Stop playing current audio and clear buffers.

**tool\_use\_stream**

```json
{
  "type": "tool_use_stream",
  "delta": {"toolUse": {"input": "{\"a\": 25"}},
  "current_tool_use": {"toolUseId": "tooluse_abc123", "name": "calculator", "input": {"a": 25, "b": 8, "op": "*"}}
}
```

Notification that the agent is executing a tool.

**tool\_result**

```json
{
  "type": "tool_result",
  "tool_result": {"toolUseId": "tooluse_abc123", "status": "success", "content": [{"text": "200.0"}]}
}
```

The result returned from tool execution.

## Transcript Buffering

-   **Nova Sonic**: Displays transcripts immediately (works well as-is)
-   **Gemini & OpenAI**: Buffers short transcript chunks for 1 second before displaying
    -   Groups multiple small updates into coherent messages
    -   Updates in real-time as chunks arrive
    -   Creates cleaner, more readable conversation flow

## Development

### Adding New Tools

Tools can be added to the `tools` parameter in `websocket_example.py`. The agent is already configured with the calculator tool:

```python
import operator
from typing import Literal

from strands import tool

_OPS = {
    "+": operator.add,
    "-": operator.sub,
    "*": operator.mul,
    "/": operator.truediv,
    "**": operator.pow,
}


@tool
def calculator(a: float, b: float, op: Literal["+", "-", "*", "/", "**"]) -> float:
    """Apply an arithmetic operator to two numbers.

    Args:
        a: Left operand.
        b: Right operand.
        op: One of "+", "-", "*", "/", "**".
    """
    return _OPS[op](a, b)


agent = BidiAgent(
    model=model,
    tools=[calculator],
    system_prompt="You are a helpful assistant with access to a calculator tool.",
)
```

You can add additional tools from `strands.vended_tools` or create custom tools following the Strands tools specification.

## Event Format Reference

This section provides detailed specifications for all WebSocket events exchanged between the client and server.

### Client → Server Events

**bidi\_audio\_input**

Sends audio chunks from the microphone to the agent.

```json
{
  "type": "bidi_audio_input",
  "audio": "base64-encoded-pcm-data...",
  "format": "pcm",
  "sample_rate": 16000,
  "channels": 1
}
```

-   `audio`: Base64-encoded PCM audio data
-   `format`: Always “pcm” (16-bit signed integer)
-   `sample_rate`: 16000 for Nova Sonic, 24000 for Gemini/OpenAI
-   `channels`: Always 1 (mono)

### Server → Client Events

**bidi\_audio\_stream**

Streams audio response from the agent back to the client.

```json
{
  "type": "bidi_audio_stream",
  "audio": "base64-encoded-pcm-data...",
  "format": "pcm",
  "sample_rate": 16000,
  "channels": 1
}
```

-   `audio`: Base64-encoded PCM audio data to play through speakers
-   `format`: Always “pcm” (16-bit signed integer)
-   `sample_rate`: 16000 for Nova Sonic, 24000 for Gemini/OpenAI
-   `channels`: Always 1 (mono)

**bidi\_transcript\_stream**

Provides real-time transcription of both user speech and assistant responses.

```json
{
  "type": "bidi_transcript_stream",
  "delta": {
    "text": "partial text..."
  },
  "text": "complete text so far",
  "role": "user",
  "is_final": false
}
```

-   `delta`: Incremental text update (new words added)
-   `text`: Complete transcript text accumulated so far
-   `role`: Either “user” or “assistant”
-   `is_final`: Boolean indicating if this is the final transcript

**bidi\_interruption**

Signals that the user has interrupted the agent’s speech.

```json
{
  "type": "bidi_interruption"
}
```

When received, the client should:

-   Stop playing current audio immediately
-   Clear audio playback buffers
-   Reset the audio context

**bidi\_usage**

Reports token usage statistics for the conversation.

```json
{
  "type": "bidi_usage",
  "inputTokens": 22,
  "outputTokens": 15,
  "totalTokens": 37
}
```

-   `inputTokens`: Number of tokens in user input
-   `outputTokens`: Number of tokens in agent response
-   `totalTokens`: Sum of input and output tokens

**tool\_use\_stream**

Notifies that the agent is executing a tool.

```json
{
  "type": "tool_use_stream",
  "current_tool_use": {
    "name": "calculator",
    "input": {
      "a": 25,
      "b": 8,
      "op": "*"
    }
  }
}
```

-   `current_tool_use.name`: Name of the tool being executed
-   `current_tool_use.input`: Parameters passed to the tool

**tool\_result**

Returns the result from tool execution.

```json
{
  "type": "tool_result",
  "tool_result": {
    "content": [
      {
        "text": "200.0"
      }
    ]
  }
}
```

-   `tool_result.content`: Array of result objects
-   `tool_result.content[].text`: String representation of the result

### Audio Format Details

All audio is transmitted as base64-encoded PCM (Pulse Code Modulation):

-   **Encoding**: 16-bit signed integer, little-endian
-   **Channels**: 1 (mono)
-   **Sample Rate**: Model-dependent
    -   Nova Sonic: 16 kHz
    -   Gemini Live: 24 kHz
    -   OpenAI Realtime: 24 kHz

To decode base64 audio in JavaScript:

```javascript
// Decode base64 to bytes
const binaryString = atob(base64Audio);
const bytes = new Uint8Array(binaryString.length);
for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
}

// Convert to Int16 then Float32 for Web Audio API
const int16Data = new Int16Array(bytes.buffer);
const float32Data = new Float32Array(int16Data.length);
for (let i = 0; i < int16Data.length; i++) {
    float32Data[i] = int16Data[i] / 32768.0;
}
```

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/09-bidi-streaming)
