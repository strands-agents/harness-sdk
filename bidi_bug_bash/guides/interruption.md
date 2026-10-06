# Interruption

Interrupt the model while it is speaking and confirm that playback stops, the event
stream remains coherent, and the next user turn succeeds.

Docs:

- [Interruptions](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/interruption.mdx)
- [Bidi events](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/events.mdx)

Template: [interruption.py](../templates/interruption.py)

---

## Baseline

1. Start the template with one provider.
2. Ask for a response long enough to interrupt, such as a detailed five-minute travel
   plan.
3. Begin speaking while model audio is playing.
4. Ask a new, unrelated question.

Expected result:

- A `BidiInterruptionEvent` arrives.
- `BidiAudioIO` clears queued playback promptly.
- The new user speech is transcribed.
- The model answers the new turn.
- The session remains usable.

## What to test

- Interrupt at the beginning, middle, and end of a model response.
- Interrupt with quiet speech, loud speech, and speech from different distances.
- Interrupt several responses in succession.
- Speak again before the first interruption has settled.
- Interrupt during an assistant transcript but before audio playback begins.
- Compare speakers with a headset.
- Repeat with acoustic echo cancellation enabled and disabled.


## Watch for

- Model audio continues after the interruption event.
- Old buffered audio plays during the next turn.
- The model responds to its own speaker output.
- User speech is clipped or never transcribed.
- The event loop hangs after repeated interruptions.


