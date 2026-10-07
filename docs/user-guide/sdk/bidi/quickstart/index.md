In this guide you build a voice agent that listens through your microphone, speaks through your speakers, and calls tools while you talk. You’ll ask it for the time, talk over one of its replies, and end the conversation by saying goodbye.

The example uses Amazon Nova Sonic, which requires Python 3.12 or later. You’ll also need a microphone and speakers or headphones.

## Install the SDK

Microphone and speaker access goes through PyAudio, which needs the PortAudio system library:

(( tab "macOS" ))
```bash
brew install portaudio
```
(( /tab "macOS" ))

(( tab "Linux (Debian/Ubuntu)" ))
```bash
sudo apt-get install portaudio19-dev
```
(( /tab "Linux (Debian/Ubuntu)" ))

(( tab "Windows" ))
PyAudio’s Windows wheels include PortAudio, so there’s nothing to install here.
(( /tab "Windows" ))

Then install the SDK with Nova Sonic, local audio, and echo cancellation support:

```bash
pip install "strands-agents[bidi,bidi-io,bidi-pyaudio,bidi-aec]"
```

## Configure credentials

Set up [AWS credentials](/docs/user-guide/sdk/bidi/models/bedrock/index.md#credentials) with permission to invoke Nova Sonic, then set the region:

```bash
export AWS_DEFAULT_REGION=us-east-1
```

## Run the agent

Save this as `voice_agent.py`. It gives the agent two tools: `get_current_time` reads your computer’s clock, and `end_conversation` lets the agent hang up when you’re done.

```python
import asyncio
from datetime import datetime

from strands import ToolContext, tool
from strands.bidi import BidiAgent
from strands.bidi.io import AudioIO
from strands.bidi.models import BedrockNovaSonicModel


@tool
def get_current_time() -> str:
    """Get the current date and time in the computer's local time zone."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


@tool(context=True)
def end_conversation(tool_context: ToolContext[BidiAgent]) -> str:
    """End the conversation when the user says goodbye or asks to stop."""
    tool_context.agent.cancel()
    return "Ending the conversation."


async def main() -> None:
    agent = BidiAgent(
        model=BedrockNovaSonicModel(model_id="amazon.nova-2-5-sonic"),
        tools=[get_current_time, end_conversation],
        system_prompt="You are a friendly voice assistant. Keep replies short.",
    )
    # One AudioIO drives both the microphone and the speakers
    audio_io = AudioIO()
    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


asyncio.run(main())
```

Start it:

```bash
python voice_agent.py
```

The terminal shows a `Speak…` prompt. `AudioIO` streams your microphone to the agent, plays the agent’s replies, and prints transcripts and tool calls as they happen.

## Try a conversation

### Ask for the time

Say **“What time is it?”** The agent can call `get_current_time` and read the result back to you. You’ll see the tool call appear in the terminal.

### Talk over the agent

Say **“Tell me three things to do in Lisbon.”** While the agent is answering, say **“Actually, make that Paris.”**

The agent should stop mid-sentence and switch to Paris. This is called barge-in: the model hears you speaking over its reply and stops, and `AudioIO` throws away any audio still queued for the speakers so playback stops right away. See [Barge-in](/docs/user-guide/sdk/bidi/events/index.md#barge-in-1) to react when it happens.

### End the conversation by voice

Say **“Goodbye.”** The agent calls `end_conversation`, closes the connection, and `run()` returns. You can also press `Ctrl+C` at any time. Python prints a `KeyboardInterrupt` traceback when you do; that’s expected.

## Cancel echo on open speakers

Without headphones, the agent may cut itself off a few words into every reply. The microphone picks up the agent’s voice from the speakers, and the model hears that as you talking over it.

Turn on audio processing to fix it:

```python
audio_io = AudioIO(audio_processor=True)
```

`AudioIO` now subtracts the audio it plays from the microphone signal before the model hears it. For other audio settings, see [Audio processing](/docs/user-guide/sdk/bidi/io/index.md#audio-processing).

## Use a different provider

Install the provider’s extra and set its API key. Then, in `voice_agent.py`, replace the `BedrockNovaSonicModel` import with the provider’s import and pass the new model to `BidiAgent` as `model=`:

(( tab "Google" ))
```bash
pip install "strands-agents[bidi-io,bidi-pyaudio,bidi-aec,bidi-google]"
export GOOGLE_API_KEY=your_api_key
```

```python
from strands.bidi.models import GoogleGeminiLiveModel

model = GoogleGeminiLiveModel(model_id="gemini-3.8-live")
```
(( /tab "Google" ))

(( tab "OpenAI" ))
```bash
pip install "strands-agents[bidi-io,bidi-pyaudio,bidi-aec,bidi-openai]"
export OPENAI_API_KEY=your_api_key
```

```python
from strands.bidi.models import OpenAIRealtimeModel

# OpenAI transcribes your speech with a separate model; pass None to skip it
model = OpenAIRealtimeModel(
    model_id="gpt-realtime-2.1",
    transcription_model_id="gpt-transcribe",
)
```
(( /tab "OpenAI" ))

## Next steps

-   [BidiAgent](/docs/user-guide/sdk/bidi/agent/index.md): configure the agent and control its lifecycle.
-   [I/O Streams](/docs/user-guide/sdk/bidi/io/index.md): tune `AudioIO`, type to the agent with `ConsoleIO`, or connect a browser.
-   [Stream Events](/docs/user-guide/sdk/bidi/events/index.md): handle transcripts, tool results, and barge-ins yourself.

## Related pages

- [Choosing an Agent Foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md) (1 shared tag)
- [Get started](/docs/user-guide/sdk/quickstart/overview/index.md) (1 shared tag)
- [Get started with Strands Box](/docs/user-guide/box/getting-started/index.md) (1 shared tag)
- [Python Quickstart](/docs/user-guide/sdk/quickstart/python/index.md) (1 shared tag)
- [Strands evaluation quickstart](/docs/user-guide/evals-sdk/quickstart/index.md) (1 shared tag)
- [Strands Shell quickstart](/docs/user-guide/shell/quickstart/index.md) (1 shared tag)
- [TypeScript Quickstart](/docs/user-guide/sdk/quickstart/typescript/index.md) (1 shared tag)
- [BidiAgent](/docs/user-guide/sdk/bidi/agent/index.md) (1 shared tag)
- [Bidirectional Streaming](/docs/user-guide/sdk/bidi/index.md) (1 shared tag)
- [Bidirectional Streaming Models](/docs/user-guide/sdk/bidi/models/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/bidi/agent/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py)
- [harness-sdk/strands-py/src/strands/bidi/io/audio.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/io/audio.py)
- [harness-sdk/strands-py/src/strands/bidi/models/bedrock.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/models/bedrock.py)
- [harness-sdk/strands-py/src/strands/tools/decorator.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/decorator.py)
