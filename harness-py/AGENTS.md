# Agent Development Guide - Python Package

This document provides context and conventions for AI coding assistants working on the Strands harness Python package (`harness-py/`). For human contributors, see [CONTRIBUTING.md](../CONTRIBUTING.md).

> **Cross-package rules live in the [root AGENTS.md](../AGENTS.md).** Public-surface parity with `harness-ts/`, the shared defaults, the single system-prompt artifact, and the evergreen-comment rule apply to both packages and are stated once there. This file shows only the Python-idiomatic form and the rules unique to Python. When a rule applies to both packages, edit the root, not this file.

## Overview

`strands-harness` (import name `strands_harness`) is a preconfigured Strands agent in one call. It is a thin composition layer over the `strands-agents` SDK: it wires a resolved model, the vended system prompt, built-in tools, context management, and optional session persistence into a plain `strands.Agent`. Every default is overridable and the return value is a regular `Agent`, so consumers can change, extend, or replace anything the harness sets up.

## Directory Structure

```
harness-py/
├── src/strands_harness/
│   ├── agent.py       # create_harness(): the one-call factory
│   ├── models.py      # resolve_model(): "provider/name" -> Model, per-provider effort (reasoning) config
│   ├── prompt.py      # HARNESS_CONTRACT + build_system_prompt()
│   ├── defaults.py    # default model, effort, context manager, tools, session/skills/memory dirs
│   ├── tools/         # harness-authored built-in tools: file_tools.py (read/write/edit), web_fetch.py
│   └── plugins/       # built-in feature plugins: todos.py, environment.py
├── tests/             # pytest suite (mirrors the module layout)
└── pyproject.toml     # build config, dependencies, package-local tool settings
```

This package is **library-only**: no CLI. The `strands` terminal command lives in `strands-cli/` (TypeScript).

## Development

Set up a virtual environment and install with dev dependencies:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

The `[dev]` extra pulls in the optional model providers (OpenAI, Anthropic, Gemini), so the full suite runs without extra setup.

Run the checks before opening a pull request:

```bash
ruff format .        # format
ruff check .         # lint
pytest               # run the test suite
```

## Conventions

- **Imports at the top of the file**, never inline within a function, except where a heavy optional dependency must stay lazy. Model providers are imported inside their builder functions in `models.py` so that installing `strands-harness` without a given provider extra still works; keep that pattern. Core `strands` deps (session manager, offloader, skills plugin) are always available, so they're imported at the top of `agent.py` like everything else.
- **Explicit-wins passthrough.** `create_harness(**agent_kwargs)` forwards any unrecognized keyword straight to `Agent`, and an explicit value always takes precedence over the harness default it corresponds to (e.g. a passed `session_manager`, `memory_manager`, or `system_prompt` wins). Preserve this when adding options.
- **Provider effort config.** `models.py` maps one `effort` level to each provider's own request fields and validates it against that provider's supported levels, so an unsupported level fails in the harness rather than as a downstream request error. Keep the validation local.
- **Ruff** governs style (line length 120; `E`, `F`, `I`, `UP`, `B`). Config is package-local in `pyproject.toml`, with a shared copy at the repo root.
- **Type hints** on public functions; the package ships `py.typed`.
