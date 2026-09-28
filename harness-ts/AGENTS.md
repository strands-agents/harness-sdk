# Agent Development Guide - TypeScript Package

This document provides context and conventions for AI coding assistants working on the Strands harness TypeScript package (`harness-ts/`). For human contributors, see [CONTRIBUTING.md](../CONTRIBUTING.md).

> **Cross-package rules live in the [root AGENTS.md](../AGENTS.md).** Public-surface parity with `harness-py/`, the shared defaults, the single system-prompt artifact, and the evergreen-comment rule apply to both packages and are stated once there. This file shows only the TypeScript-idiomatic form and the rules unique to TypeScript. When a rule applies to both packages, edit the root, not this file.

## Overview

`@strands-agents/harness` is a preconfigured Strands agent in one call. It is a thin composition layer over `@strands-agents/sdk`: it wires a resolved model, the vended system prompt, built-in tools, context management, and optional session persistence into a plain `Agent`. Every option is overridable and the return value is a regular `Agent`, so consumers can change, extend, or replace anything the harness sets up.

This package is **library-only**: no CLI. The `strands` terminal command lives in `strands-cli/`, which depends on this package.

## Directory Structure

```
harness-ts/
├── src/
│   ├── agent.ts       # createHarness(): the one-call factory
│   ├── models.ts      # resolveModel(): "provider/name" -> Model, per-provider effort config
│   ├── prompt.ts      # HARNESS_CONTRACT + buildSystemPrompt()
│   ├── defaults.ts    # default model, effort, context manager, tools, session dir
│   ├── config.ts      # JSON config bridge: normalizeHarnessAgentConfig(), harnessAgentOptionsFromConfig()
│   ├── builtin-tools.ts  # resolveBuiltinTools(): list (pin) or mapping (edits) -> one resolved record
│   ├── tools/         # harness-authored built-in tools: file-tools.ts (read/write/edit), web-fetch.ts
│   ├── plugins/       # built-in feature plugins: todos.ts, environment.ts
│   ├── index.ts       # public barrel export
│   ├── internal.ts    # `@strands-agents/harness/internal`: plumbing for the CLI (resolve*, normalize*)
│   └── tsconfig.json  # build project config (emits to ../dist)
├── test/              # vitest suite
├── package.json
└── vitest.config.ts
```

## Development

Install from the repo root so the npm workspace is linked:

```bash
npm ci               # from the repo root
```

Run the checks before opening a pull request (from `harness-ts/`, or via `npm run <script> -w harness-ts` from the root):

```bash
npm run build        # tsc build
npm run type-check   # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm test             # vitest
npm run check        # lint + format:check + type-check + test:coverage
```

## Conventions

- **`createHarness` and `resolveModel` are async.** The SDK's model-provider entry points (`@strands-agents/sdk/models/*`) require their peer dependency at import time, so they are loaded with dynamic `import()` to keep each provider optional: a consumer only installs the peer for the provider they use, and Bedrock needs none. Loading on demand makes resolution async; preserve that. Import the always-needed pieces (`Agent`, `Model`, types, and the core plugins/session: `ContextOffloader`, `AgentSkills`, `SessionManager`, `FileStorage`) statically at the top of the file. The model providers are dynamic, and so is `@strands-agents/sdk/telemetry` (in `telemetry.ts`): it statically pulls in the OTel trace SDK and exporters, and a run with no collector configured must not pay to load them.
- **Options object, explicit-wins passthrough.** `HarnessAgentOptions` extends `AgentConfig` (minus the keys the harness controls) plus the harness-specific keys. Any `AgentConfig` field the harness doesn't name is spread straight onto `Agent`, and an explicit value wins over the harness default it corresponds to (e.g. a passed `conversationManager` or `systemPrompt`). This mirrors Python's `**agent_kwargs`. Where an SDK object exists, the harness option is `boolean | <Config> | <SDK instance> | null` (`session`, `memory`, `contextManager`, `skills`); an instance passes straight through.
- **Provider effort config.** `models.ts` maps one `effort` level to each provider's own config fields and validates it against that provider's supported levels, so an unsupported level fails in the harness rather than as a downstream request error. Keep the validation local.
- **Built-in tools.** `builtinTools` is a list (exact pin) or a mapping of edits to the defaults; `builtin-tools.ts` normalizes both to one `{ name: true | false | config }` record, which is what the factory selects from and what a `subagent` child inherits — never a list or `"*"`. Per-tool config keys live in one table, `BUILTIN_TOOL_CONFIG_KEYS` (`config.ts`), shared with the JSON validator and mirrored by Python; add a key there, not in `agent.ts`. `web_search` resolves per model — a provider flag where the model has native search, the Exa tool only with `'exa'` (`WebSearchSetting`, the one string-valued setting), see the root AGENTS.md.
- **Style**: eslint + prettier (no semicolons, single quotes, width 120). `explicit-function-return-type` and `no-explicit-any` are errors in `src/`; relaxed in `test/`.
- **Verifying model resolution in tests** needs dummy API keys for the non-Bedrock providers. `test/setup.ts` sets `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` because those SDK constructors read them at construction time.
