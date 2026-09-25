A voice agent listens and talks at the same time: audio streams in while the model streams a reply out, the user can cut in mid-sentence, and tools run without pausing the conversation. Bidirectional streaming is the piece that makes this work. Instead of the request-then-response cycle of a standard agent, a `BidiAgent` holds a persistent connection to a realtime model and moves audio, text, and events across it continuously. This section covers building that agent, choosing a model provider that supports it, and handling the live stream.

## Get started

[Build a voice agent](quickstart/index.md)Stand up a listening, talking agent end to end, from install to first conversation.

[BidiAgent](agent/index.md)Configure the persistent-connection agent: model, tools, system prompt, and lifecycle.

## Model providers

[Nova Sonic](models/bedrock/index.md)Amazon's bidirectional streaming model, served through Amazon Bedrock.

[OpenAI Realtime](models/openai/index.md)OpenAI's Realtime API, with a longer connection timeout for extended sessions.

[Gemini Live](models/google/index.md)Google's multimodal Live API for streaming voice and video.

## Handle the live stream

[I/O channels](io/index.md)Wire local audio and text I/O, or implement custom channels for a web server.

[Streaming events](events/index.md)Handle the events the agent emits as audio, transcripts, and tool calls arrive.

[Barge-in](barge-in/index.md)Let a user cut in mid-response and have the agent stop and listen.

## A streaming voice agent

The smallest real thing this section builds: a `BidiAgent` on a realtime model, reading from the microphone and playing back through the speakers. The `run()` loop streams audio both ways until you interrupt it.

```python
import asyncio

from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.io import AudioIO
from strands.experimental.bidi.models import BedrockNovaSonicModel

model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")
agent = BidiAgent(
    model=model,
    system_prompt="You are a helpful voice assistant. Keep replies short and natural.",
)
audio_io = AudioIO()


async def main():
    # Stream microphone audio in and speaker audio out until interrupted
    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


asyncio.run(main())
```

Bidirectional streaming is a Python-only experimental feature; install it with `pip install "strands-agents[bidi-all]"`. The [quickstart](/docs/user-guide/sdk/bidirectional-streaming/quickstart/index.md) covers per-provider installs and credentials.

## Where to go next

New here? Start with the [quickstart](/docs/user-guide/sdk/bidirectional-streaming/quickstart/index.md) to get a voice conversation running, then read [BidiAgent](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md) to configure tools, prompts, and the connection lifecycle. Pick a [model provider](/docs/user-guide/sdk/bidirectional-streaming/models/bedrock/index.md) based on the provider you use and the session length you need.

Building for a server rather than a local machine? Read [I/O channels](/docs/user-guide/sdk/bidirectional-streaming/io/index.md) to replace microphone-and-speaker I/O with your own transport, then [streaming events](/docs/user-guide/sdk/bidirectional-streaming/events/index.md) and [barge-ins](/docs/user-guide/sdk/bidirectional-streaming/barge-in/index.md) to drive the conversation from your own event loop.

## Related pages

- [Barge-in](/docs/user-guide/sdk/bidirectional-streaming/barge-in/index.md) (1 shared tag)
- [BidiAgent](/docs/user-guide/sdk/bidirectional-streaming/agent/index.md) (1 shared tag)
- [Events](/docs/user-guide/sdk/bidirectional-streaming/events/index.md) (1 shared tag)
- [Google Gemini Live](/docs/user-guide/sdk/bidirectional-streaming/models/google/index.md) (1 shared tag)
- [I/O Streams](/docs/user-guide/sdk/bidirectional-streaming/io/index.md) (1 shared tag)
- [OpenAI Realtime](/docs/user-guide/sdk/bidirectional-streaming/models/openai/index.md) (1 shared tag)
- [Bidirectional Streaming Observability](/docs/user-guide/sdk/bidirectional-streaming/observability/index.md) (1 shared tag)
- [Bidirectional Streaming Hooks](/docs/user-guide/sdk/bidirectional-streaming/hooks/index.md) (1 shared tag)
- [Build a voice agent](/docs/user-guide/sdk/bidirectional-streaming/quickstart/index.md) (1 shared tag)
- [Bedrock Nova Sonic](/docs/user-guide/sdk/bidirectional-streaming/models/bedrock/index.md) (1 shared tag)
