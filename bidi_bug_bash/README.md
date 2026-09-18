# Bidi Bug Bash

This bug bash exercises the Python bidirectional streaming implementation across
Amazon Nova Sonic, Google Gemini Live, and OpenAI Realtime.

## How it works

Each feature area has a guide with setup instructions, test ideas, expected behavior,
provider differences, and a starter template.

Your goal: follow the guide, run the template, vary the inputs, and report behavior
that is incorrect, inconsistent, confusing, or difficult to diagnose.

## Sign up

Claim a feature area by adding your name to the Assignee column. If you finish early,
repeat the feature with another model provider or take an unclaimed area.

| Feature area | Guide | Assignee |
|---|---|---|
| Interruption | [Guide](guides/interruption.md) | |
| Tool calling | [Guide](guides/tool-calling.md) | |
| Models: Amazon Nova Sonic | [Guide](guides/models-nova-sonic.md) | |
| Models: Google Gemini Live | [Guide](guides/models-gemini-live.md) | |
| Models: OpenAI Realtime | [Guide](guides/models-openai-realtime.md) | |
| Acoustic echo cancellation | [Guide](guides/acoustic-echo-cancellation.md) | |
| Proactive restart | [Guide](guides/proactive-restart.md) | |

## Setup

### Install PortAudio

Install PortAudio before the Python dependencies. Local microphone and speaker access
requires it.

macOS:

```bash
brew install portaudio
```

Ubuntu or Debian:

```bash
sudo apt-get install portaudio19-dev
```

### Create an environment

Run these commands from the repository root:

```bash
cd bidi_bug_bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e "../strands-py[bidi-all,bidi-pyaudio]"
```

Use Python 3.12 or later because Amazon Nova Sonic requires it.

### Configure credentials

Amazon Nova Sonic uses the standard AWS credential chain. For example:

```bash
export AWS_PROFILE=my-profile
export AWS_REGION=us-east-1
```

Google Gemini Live:

```bash
export GOOGLE_API_KEY=your-key
```

OpenAI Realtime:

```bash
export OPENAI_API_KEY=your-key
```

Do not commit credentials or paste them into bug reports.

### Run a template

Cross-provider templates start with Amazon Nova Sonic. To switch providers, open the
template and keep only the desired `model = ...` line uncommented:

```bash
python templates/test_all_features.py
python templates/interruption.py
python templates/tool-calling.py
python templates/proactive-restart.py
python templates/acoustic-echo-cancellation.py
```

Provider guides have dedicated templates:

```bash
python templates/models-nova-sonic.py
python templates/models-gemini-live.py
python templates/models-openai-realtime.py
```

Wear headphones for every template except acoustic echo cancellation. Use speakers
for that test so the microphone can pick up model audio.

Press `Ctrl+C` to end a template.

## What to record

Include these details in every report:

- Feature area
- Echo cancellation setting
- Exact steps to reproduce
- Expected and actual behavior
- Relevant event order or debug logs
- Whether the issue reproduces after repeated tries

## Submit a report

Submit each finding as a top-level comment on the bug-bash pull request. Start the
comment with the name of the template you tested, then include the details from
[What to record](#what-to-record).

Use a separate comment for each finding. If the same finding affects multiple
templates, list every affected template in the comment.

Enable bidi debug logs when event ordering or reconnect behavior is unclear:

```python
import logging

logging.basicConfig(level=logging.DEBUG)
logging.getLogger("strands.experimental.bidi").setLevel(logging.DEBUG)
```

Remove credentials, audio content, and sensitive transcript data before sharing logs.

## What counts as a finding

Report more than crashes. Useful findings include:

- Lost or duplicated speech
- Incorrect transcript roles or ordering
- A response that never completes
- Playback that continues after interruption
- Lost context after restart
- Duplicate reconnects
- Resource leaks or a process that will not exit
- Configuration that behaves differently from the documentation
- Errors that do not explain how to recover
