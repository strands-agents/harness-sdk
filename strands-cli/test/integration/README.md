# Live CLI integration tests

Run from `strands-cli/` with provider credentials available:

```sh
npm run build
npm run test:integ
```

To run only the self-building lifecycle:

```sh
npm run test:integ -- test/integration/self-building.test.ts
```

`STRANDS_INTEG_MODEL` overrides the default Bedrock Claude Haiku model. These tests make real provider calls.

To run only the Bedrock voice handoff:

```sh
npm run test:voice
npm run test:integ -- test/integration/cli-e2e.test.ts -t 'delegates a spoken Bedrock request'
```

Voice requires `uv`, Python 3.13, and PortAudio. On Ubuntu, install `portaudio19-dev`.
`test:voice` prepares the sidecar's pinned Python dependencies and runs its offline tests.
AWS credentials must allow `polly:SynthesizeSpeech`, `bedrock:InvokeModel` for Nova 2.5 Sonic,
and `bedrock:InvokeModelWithResponseStream` for the harness model. Set `AWS_REGION` to a region that supports both
Polly's Matthew neural voice and Nova 2.5 Sonic.

The voice test generates speech with Polly and sends its PCM through the real sidecar, conversation manager,
and Bedrock harness. `test/fixtures/voice-sidecar-live.py` replaces microphone input, speaker output, and device
enumeration, so the test needs no physical audio devices. It copies protocol events and captures output audio
to verify one delegation, one file-reading tool call, the spoken file contents, and a clean process exit.
Voice failures are not retried. Failures retain audio and events in the printed temporary directory.
This test does not verify microphone capture, speaker playback, or acoustic echo cancellation.

The terminal driver uses Python 3 on macOS/Linux and ConPTY on Windows.
Python exports require Python 3.10 or newer. The test uses `harness-py/.venv` when available; set
`STRANDS_TEST_PYTHON` to another interpreter if needed. Imports install the archive's dependencies into fresh environments.

The self-building test launches the built CLI in a terminal with its base tools and no MCP servers. It asks the
agent to add and apply a local MCP server through chat, then calls the new tool. It opens `/config`, exports,
and repeats use → `/config` → export after two fresh imports, for both TypeScript and Python archives.
Each launch has a separate CLI home and workspace;
the original server source is deleted before importing.

Every round checks a server-recorded challenge and fresh receipt against the agent's tool result, verifies the
server is packaged, and compares the `/config` document byte for byte with the archived entrypoint. A read-only
observer captures the controller snapshots used by the real TUI; it does not replace the model or command handlers.
Failures retain snapshots and terminal diagnostics in the temporary directory printed by the test.
