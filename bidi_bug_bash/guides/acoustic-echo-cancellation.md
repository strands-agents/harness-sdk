# Acoustic echo cancellation

Test whether microphone processing prevents speaker output from returning to the
model as user speech.

Docs:

- [I/O channels](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/io.mdx)

Template: [acoustic-echo-cancellation.py](../templates/acoustic-echo-cancellation.py)

---

## Baseline

Confirm the environment contains the release with expanded sample-rate support:

```bash
python -c \
  'from importlib.metadata import version; print(version("pywebrtc-audio"))'
```

The version should be `0.2.0` or later within the supported `0.2.x` range.

Run the template through laptop speakers, not headphones:

```bash
python templates/acoustic-echo-cancellation.py
```

Ask the model for a long response, remain silent, and listen for false interruptions
or signs that the model transcribed its own voice.

The template places three `BidiAudioIO` configurations next to each other. Run it
with echo cancellation on, then comment that line and uncomment the echo-cancellation
off line. A third line disables all microphone processing.

The enabled run should reduce speaker feedback reaching the model. Room acoustics,
device drivers, volume, and physical microphone placement affect the result.

The template starts with Amazon Nova Sonic. To repeat the test with Gemini Live or
OpenAI Realtime, keep only that provider's `model = ...` line uncommented.

## What to test

- Compare echo cancellation on, echo cancellation off, and all microphone
  processing off.
- Laptop speakers at low, medium, and high volume.
- External speakers.
- Quiet and noisy rooms.
- Remain silent during a long model response and check for false interruptions.
- Speak while the model is responding and confirm that real user speech still
  interrupts it.
- Repeat several interruptions in one session.
- Restart the template and repeat the test.

Audio processing also enables noise suppression and automatic gain control. Set
`echo_cancellation` to `False` to test those two features without a far-end speaker
reference.

## Watch for

- Model speech triggers `BidiInterruptionEvent`.
- Echo cancellation suppresses the real user.
- Audio becomes clipped, distorted, delayed, or unstable.
- Input and output drift apart during a long response.
- Restarting audio I/O keeps stale processing state.
- The process crashes or deadlocks in the native audio processor.
