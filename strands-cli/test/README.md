# CLI tests

Ordinary tests are grouped by feature in `cli`, `agent`, `config`, `model`, `project`, `session`, `terminal`, and `ui`.
Shared support and executable child processes live in `fixtures`. Tests cover pure functions, mounted UI,
filesystem operations, local transports, SDK loops, and authored-agent processes.

Run commands from `strands-cli/`:

| Command                             | Coverage                                                                                          | Requirements                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm test`                          | Feature suites, excluding the dedicated integration/live entrypoints                              | Installed dependencies; Python cases may skip if no interpreter is available |
| `npm run test:tui-integration`      | `terminal.integration.test.ts`: real Ink in PTY/ConPTY with a deterministic backend               | Python 3; ConPTY on Windows                                                  |
| `npm run test:platform-integration` | `platform.integration.test.ts`: compiled CLI and exported TypeScript/Python agents                | Prior build; Python for Python exports                                       |
| `npm run test:integ`                | `*.live.test.ts`: real provider, voice delegation, and self-building workflows                    | Prior build and provider credentials                                         |
| `npm run test:voice`                | `voice.test.py`: offline Python voice adapters                                                    | `uv`, Python 3.13, and PortAudio                                             |
| `npm run test:package-install`      | Installed CLI in print and terminal modes: real file, shell, and web-fetch tools; bundled sidecar | npm, Python 3; ConPTY on Windows                                             |

`npm run check` runs lint, formatting, source/test types, and default test coverage. It does not run the five
dedicated commands below `npm test` in the table.

## Terminal and platform checks

The terminal suite exercises keyboard input, streamed conversation output, slash-command panels, queued-message
deletion, voice-panel controls, shell commands, resizing, and cleanup. Vitest reports each scenario. The drivers feed output through `@xterm/headless` and assert
visible labels and state transitions rather than exact escape sequences or complete screen snapshots.
Exit cases check terminal restoration after direct process exit, uncaught exceptions, rejected promises, and
POSIX termination signals. Windows signal-kill cases are excluded because `TerminateProcess` cannot run cleanup.

CI runs the source TUI on Linux and the compiled TUI on Linux, macOS, and Windows. This suite starts the TUI
with a deterministic backend. The platform and live suites exercise the full compiled CLI startup path.

The package-install test packs and installs the CLI outside the checkout. A scripted model calls the installed
Harness's write, edit, read, shell, and web-fetch tools in print and interactive modes. It checks tool results,
file contents, and requests to a local HTTP server. Only model responses are scripted; the Harness, tools,
sandbox, filesystem, network, and terminal run normally. CI runs this test on Linux, macOS, and Windows.
The voice-panel terminal scenario uses a simulated voice session; live voice coverage is described below.

Python exports require Python 3.10 or newer. The platform suite installs the exported requirements into fresh
environments through the normal CLI import path. Ordinary Python source tests use `harness-py/.venv` when available;
set `STRANDS_TEST_PYTHON` to another interpreter for those tests.

## Live provider checks

```sh
npm run build
npm run test:integ
```

`STRANDS_INTEG_MODEL` overrides the default Bedrock Claude Haiku model. These tests make real provider calls.

To run only the self-building lifecycle:

```sh
npm run test:integ -- test/self-building.live.test.ts
```

The self-building test launches the built CLI in a terminal with its base tools and no MCP servers. It asks the
agent to add and apply a local MCP server through chat, then calls the new tool. It opens `/config`, exports,
and repeats use → `/config` → export after two fresh imports, for both TypeScript and Python archives.
Each launch has a separate CLI home and workspace; the original server source is deleted before importing.

Every round checks a server-recorded challenge and fresh receipt against the agent's tool result, verifies the
server is packaged, and compares the `/config` document byte for byte with the archived entrypoint. A read-only
observer captures controller snapshots from the real TUI; it does not replace the model or command handlers.
Failures retain snapshots and terminal diagnostics in the printed temporary directory.

## Voice checks

To run only the Bedrock voice handoff:

```sh
npm run test:voice
npm run test:integ -- test/cli.live.test.ts -t 'delegates a spoken Bedrock request'
```

Voice requires `uv`, Python 3.13, and PortAudio. On Ubuntu, install `portaudio19-dev`.
`test:voice` prepares the sidecar's pinned Python dependencies and runs its offline tests.
AWS credentials must allow `polly:SynthesizeSpeech`, `bedrock:InvokeModel` for Nova 2.5 Sonic,
and `bedrock:InvokeModelWithResponseStream` for the harness model. Set `AWS_REGION` to a region supporting both
Polly's Matthew neural voice and Nova 2.5 Sonic.

The live voice test generates speech with Polly and sends its PCM through the real sidecar, conversation manager,
and Bedrock harness. `fixtures/voice-sidecar-live.py` replaces microphone input, speaker output, and device
enumeration, so no physical audio devices are needed. It copies protocol events and captures output audio
to verify one delegation, one file-reading tool call, spoken file contents, and a clean process exit.
Voice failures are not retried. Failures retain audio and events in the printed temporary directory.
This does not verify microphone capture, speaker playback, or acoustic echo cancellation.
