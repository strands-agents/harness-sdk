# Models: Google Gemini Live

Test Gemini Live's multimodal input, inferred turn boundaries, usage events, and
server-side session resumption.

Docs:

- [Google Gemini Live](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/models/google.mdx)

Template: [models-gemini-live.py](../templates/models-gemini-live.py)

---

## What to test

- Default and custom voices.
- Tool calling with text and JSON results.
- User interruption.
- Several turns on one connection.
- Proactive restart using the latest session-resumption handle.

Test:

- Audio and assistant text in the same server message.
- `turn_complete` with and without an open response.
- Interruption while a response is open.
- User transcription fragments completed at the turn boundary.
- Empty server messages.

Watch for duplicate transcripts when a message contains both audio and model text.

