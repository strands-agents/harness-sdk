The [Gemini Live API](https://ai.google.dev/gemini-api/docs/live) lets developers create natural conversations by enabling a two-way WebSocket connection with the Gemini models. The Live API processes data streams in real time. Users can barge in with new input while the model is responding, similar to a real conversation. Key features include:

-   **Multimodal Streaming**: The API supports streaming of text, audio, and video data.
-   **Bidirectional Interaction**: The user and the model can provide input and output at the same time.
-   **Barge-in**: Users can speak during the model’s response, and the model adjusts its response.
-   **Tool Use and Function Calling**: The API can use external tools to perform actions and get context while maintaining a real-time connection.
-   **Session Management**: Supports managing long conversations through sessions, providing context and continuity.
-   **Secure Authentication**: Uses tokens for secure client-side authentication.

## Installation

The Google Gemini Live provider is configured as an optional dependency in Strands Agents.

To install it, run:

```bash
pip install 'strands-agents[bidi-google,bidi-io,bidi-pyaudio]'
```

Or to install all bidirectional streaming providers at once:

```bash
pip install 'strands-agents[bidi-all,bidi-pyaudio]'
```

## Usage

After installing the Gemini Live and local audio extras, create a voice agent:

```python
import asyncio

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import AudioIO
from strands.experimental.bidi.models import GoogleGeminiLiveModel
from strands.experimental.tools import stop
from strands.vended_tools import notebook


async def main() -> None:
    model = GoogleGeminiLiveModel(
        model_id="gemini-3.8-live",
        voice="Kore",
        client_args={"api_key": "<GOOGLE_API_KEY>"},
    )
    # stop tool allows user to verbally stop agent execution.
    agent = BidiAgent(model=model, tools=[notebook, stop])

    audio_io = AudioIO()
    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


if __name__ == "__main__":
    asyncio.run(main())
```

## Configuration

### Client Options

Pass Google GenAI client options through `client_args`. For the supported fields, see the [Google GenAI client reference](https://googleapis.github.io/python-genai/genai.html#genai.client.Client).

### Model Config

| Parameter | Description | Example | Options |
| --- | --- | --- | --- |
| `model_id` | Gemini Live model identifier. | `"gemini-3.8-live"` | [Gemini models](https://ai.google.dev/gemini-api/docs/models) |
| `audio` | Input audio options. | `{"input": {"sample_rate": 48000}}` | [reference](/docs/api/python/strands.experimental.bidi.models#GoogleGeminiLiveAudioConfig) |
| `voice` | Prebuilt output voice name. Uses the provider default when omitted. | `"Kore"` | [Voices and languages](https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types) |
| `params` | Gemini Live session parameters. | `{"temperature": 0.7}` | [`LiveConnectConfig`](https://googleapis.github.io/python-genai/genai.html#genai.types.LiveConnectConfig) |
| `connection` | Reconnect timing overrides. | `{"auto_reconnect": False}` | [reference](/docs/api/python/strands.experimental.bidi.models#ConnectionConfig) |

### Additional Provider Options

Use direct options such as `voice` for common settings. For additional Google GenAI options, pass `params` using snake\_case field names.

```python
from strands.experimental.bidi.models import GoogleGeminiLiveModel

model = GoogleGeminiLiveModel(
    model_id="gemini-3.8-live",
    client_args={"api_key": "<GOOGLE_API_KEY>"},
    voice="Kore",
    params={"temperature": 0.7, "speech_config": {"language_code": "en-US"}},
)
```

Nested dictionaries in `params` merge with the existing configuration, preserving unspecified fields. If a setting overlaps with a default or direct option, `params` takes precedence.

Calling `update_config(params=...)` replaces the entire `params` dictionary. The new values take effect on the next `start()` or `restart()`.

## Session Management

`GoogleGeminiLiveModel` does not produce a message history, so it has limited compatibility with the Strands [session manager](/docs/user-guide/sdk/bidirectional-streaming/session-management/index.md). For [connection restarts](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md#connection-restart), the provider resumes the same server-side session through Gemini’s [session resumption](https://ai.google.dev/gemini-api/docs/live-session) handle, carrying context across the restart without replaying history. Resumed sessions persist up to 24 hours; after that, create a new `GoogleGeminiLiveModel` instance to continue the conversation.

## Troubleshooting

### Module Not Found

If you encounter the error `ModuleNotFoundError: No module named 'google.genai'`, this means the `google-genai` dependency hasn’t been properly installed in your environment. To fix this, run `pip install 'strands-agents[bidi-google]'`.

### API Key Issues

Set your Google AI API key through `client_args` or the `GOOGLE_API_KEY` environment variable. You can obtain an API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

## References

-   [Gemini Live API](https://ai.google.dev/gemini-api/docs/live)
-   [Gemini API Reference](https://googleapis.github.io/python-genai/genai.html#)
-   [Python API Reference](/docs/api/python/strands.experimental.bidi.models#GoogleGeminiLiveModel)

## Related pages

- [Barge-in](/docs/user-guide/sdk/bidirectional-streaming/barge-in/index.md) (1 shared tag)
- [BidiAgent](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md) (1 shared tag)
- [Build a realtime voice agent](/docs/user-guide/sdk/bidirectional-streaming/index.md) (1 shared tag)
- [Events](/docs/user-guide/sdk/bidirectional-streaming/events/index.md) (1 shared tag)
- [I/O Streams](/docs/user-guide/sdk/bidirectional-streaming/io/index.md) (1 shared tag)
- [OpenAI Realtime](/docs/user-guide/sdk/bidirectional-streaming/models/openai/index.md) (1 shared tag)
- [Bidirectional Streaming Observability](/docs/user-guide/sdk/bidirectional-streaming/observability/index.md) (1 shared tag)
- [Bidirectional Streaming Hooks](/docs/user-guide/sdk/bidirectional-streaming/hooks/index.md) (1 shared tag)
- [Build a voice agent](/docs/user-guide/sdk/bidirectional-streaming/quickstart/index.md) (1 shared tag)
- [Bedrock Nova Sonic](/docs/user-guide/sdk/bidirectional-streaming/models/bedrock/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/experimental/bidi/models/google.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/models/google.py)
