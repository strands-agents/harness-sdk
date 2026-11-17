# Agent Development Guide - CLI Package

This document provides context and conventions for AI coding assistants working on the Strands CLI (`strands-cli/`). For human contributors, see [CONTRIBUTING.md](../CONTRIBUTING.md).

> **Cross-package rules live in the [root AGENTS.md](../AGENTS.md).** This package is the terminal shell over the `harness-ts` library. The library parity rules apply to `harness-ts`/`harness-py`, not here. This file covers only what's specific to the CLI.

## Overview

`@strands-agents/cli` provides the `strands` terminal command, a quick way to chat with a harness agent without writing code. It is a thin shell over the `@strands-agents/harness` library: it translates flags into `createHarness` options, then drives `agent.stream()` and renders the events. All the agent behavior (defaults, model resolution, tools, sessions) comes from the library; this package owns only the terminal experience.

The CLI is TypeScript-only. There is no Python CLI: a terminal command has one home, and Node distributes a global binary cleanly (and runs zero-install via `npx`).

## Directory Structure

```
strands-cli/
├── src/
│   ├── cli/           # arguments, run modes, console rendering, ACP, updates
│   ├── agent/         # agent runtime, tools, permissions, MCP, voice
│   ├── config/        # configuration storage, settings, workspace trust
│   ├── model/         # provider discovery, credentials, model selection
│   ├── project/       # authored agents, workers, import/export
│   ├── session/       # saved sessions and restoration
│   ├── terminal/      # text input, terminal I/O, native actions
│   ├── ui/            # shared rendering, with chat/, panels/, and setup/
│   ├── logging.ts     # logging initialization and opt-in dev file logging
│   ├── main.ts        # thin entrypoint delegating to cli/run.ts
│   ├── usage.ts       # foreground and background usage tracking
│   └── tsconfig.json  # build project config (emits to ../dist)
├── test/              # feature suites, fixtures, integration/live entrypoints
├── package.json       # bin: { strands }
└── vitest.config.ts
```

## Development

Install from the repo root:

```bash
npm run setup        # install and link the source-aware `strands-dev` command
strands-dev          # builds on first run and whenever source changes
```

Run the checks (from `strands-cli/`, or via `-w strands-cli` from the root):

```bash
npm run build        # tsc build
npm run type-check   # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run check        # lint + format:check + type-check + test:coverage
```

## Conventions

- **`cli/run.ts` orchestrates runs; `cli/console.ts` renders them.** Keep `main.ts` a thin entry wrapper. `cli/arguments.ts` owns flags and config overrides; `cli/invocation.ts` prepares agents from saved profiles and imported projects. `TurnRenderer`, `runTurn`, and `runPlainChat` live in `cli/console.ts` and remain re-exported by `cli/run.ts` for callers.
- **Disable the SDK's own printer.** `invocationAgentForRun` in `cli/invocation.ts` sets `printer: false`. The SDK's `Agent` renders the stream to stdout by default, which would double up with the CLI's own renderer. This is easy to regress; the end-to-end run is what catches it, not the unit tests.
- **Flags mirror the config keys.** Agent-config flags name scalar `HarnessAgentConfig` keys people type every day (`--effort`, `--context-manager`, `--session on|off`, `--skills`, `--memory on|off`); object-shaped keys go through `--set`. `off` maps to the library's disable value (`'off'` / `false`), and `--builtin-tools ""` means none. CLI-owned launch controls (`--bypass-permissions`, `--append-instructions`, `--state-dir`) stay separate from saved agent configuration. When the library gains a scalar option, consider a matching flag here.
- **TTY-aware output.** Styling and the spinner are on only when stdout is a TTY, so piped/redirected output is clean text (the point of `-p`). Preserve this: it's what makes `git diff | strands -p "…"` usable.
- **Dev file logging is opt-in, and TUI only.** `initLogging` in `logging.ts` writes debug-level logs to `<tmpdir>/strands/cli.log` in interactive (ink) mode, which has no console to log to, but only when `STRANDS_CLI_LOG` is set to something other than an off-value (`off`/`0`/`false`/`none`/`no`/`disable`/`disabled`); unset means no log file at all. Every other run mode (`print`/`plain`/`acp`) keeps the SDK's console logger, so warnings and errors still reach stderr without corrupting the stdout stream `--print`/ACP rely on. `STRANDS_CLI_LOG_FILE` overrides the path (it never enables logging on its own) and `STRANDS_CLI_LOG_LEVEL` sets the level. The log can hold prompts and tool output and lives in the shared temp dir, so its directory is created `0o700` and the file opened `0o600`.
- **One anonymous usage ping per TUI launch, built-in profile only.** `cli/telemetry.ts` builds the enum-only payload and `cli/run.ts` fires it after the interactive chat is created; authored agents and the `print`/`plain`/`acp` modes never send it. It is CLI-private state like `mcpDiscovery` (setting + `STRANDS_CLI_TELEMETRY=off` / `DO_NOT_TRACK=1`), not a `createHarness` option, so it has no flag. Keep the payload in step with the collector's schema (`strands-telemetry` repo) — it drops anything it does not recognize.
- **Renderer reads the typed event union.** `TurnRenderer` switches on `AgentStreamEvent.type` (`modelStreamUpdateEvent` deltas, `beforeToolCallEvent`, `toolResultEvent`, and the returned `AgentResult` for usage). Prefer `beforeToolCallEvent` over the streaming `toolUseStart` for tool calls: it carries the fully-assembled input.
- **Verify against a real model.** Unit tests mock the agent; before shipping a rendering or run-mode change, run the built binary against Bedrock end to end, including a tool-using turn.
- **Style**: eslint + prettier (no semicolons, single quotes, width 120), matching `harness-ts`.
