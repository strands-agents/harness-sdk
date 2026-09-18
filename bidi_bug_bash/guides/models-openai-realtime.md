# Models: OpenAI Realtime

Test OpenAI Realtime's WebSocket lifecycle, VAD, conversation replay, image input,
tool calling, and per-response usage.

Docs:

- [OpenAI Realtime](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/models/openai.mdx)

Template: [models-openai-realtime.py](../templates/models-openai-realtime.py)

---

## What to test

- Voice selection.
- Default server VAD and custom sensitivity.
- Response cancellation and interruption.
- Per-response token usage and modality details.

OpenAI Realtime audio is mono PCM at 24 kHz in the current implementation. Unsupported
formats or rates should fail during model configuration.

