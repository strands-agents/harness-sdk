# Agent Development Guide - Rust harness

This document guides AI agents working on the Strands Rust harness (`harness-rs/`). The Rust SDK rules in [strands-rs/AGENTS.md](../strands-rs/AGENTS.md) apply here unchanged (gates, code rules, wire compatibility, tests); this file covers only what is specific to the harness.

## Overview

`strands-harness` is a preconfigured Strands agent in one call. It is a thin composition layer over the `strands` crate: `create_harness(options).await` wires a resolved model, the vended system prompt, built-in tools, context management and optional session persistence into a plain `strands::Agent`. harness-ts (`harness-ts/`) is canonical for behaviour, defaults and byte-observable text.

## Layout

```
harness-rs/
├── strands-harness/
│   ├── src/
│   │   ├── agent.rs            # create_harness(), HarnessAgentOptions
│   │   ├── models.rs           # model strings "provider/name" -> Model, per-provider effort and caching
│   │   ├── model_info.rs       # the shared model info fields the harness reads (output ceiling, defaultEffort)
│   │   ├── prompt.rs           # HARNESS_CONTRACT, build_system_prompt()
│   │   ├── defaults.rs         # default model, effort, context manager, tools, session dir
│   │   ├── config.rs           # portable HarnessAgentConfig parsing and options bridge
│   │   ├── builtin_tools.rs    # list (pin) or mapping (edits) -> one resolved record
│   │   ├── interventions.rs    # off / ask / smart / *.cedar / free text grammar
│   │   ├── memory.rs           # default FileMemoryStore manager, read-only views for delegates
│   │   ├── sandbox.rs          # shell dialect probe shared by tools and plugins
│   │   ├── telemetry.rs        # OTEL_TRACES_EXPORTER -> strands::telemetry::setup_tracer
│   │   ├── factory.rs          # constructor table for the built-in tools and plugins
│   │   ├── tools/              # file_tools, web_fetch, web_search, programmatic_tool_caller
│   │   └── plugins/            # environment
│   └── tests/
└── docs/DIVERGENCES.md
```

## Conventions

- `create_harness` is async; the returned value is a regular `Agent`, so callers can change or extend anything the harness sets up.
- `HarnessAgentOptions` carries every harness-ts field plus `AgentConfig` passthrough. An explicit value wins over the harness default it corresponds to.
- Model strings: `bedrock/`, `bedrock-mantle/`, `anthropic/`, `openai/`, and a bare id means Bedrock. A provider whose cargo feature is disabled, or that Rust does not support yet, fails with a clear error. `bedrock-mantle/` needs the `mantle` feature, which turns on `openai`.
- `build.rs` embeds `shared/model-info.json` (the output-token ceiling and `defaultEffort` the harness reads), as `strands/build.rs` does; copy it to `harness-rs/strands-harness/model-info.json` before packaging.
- Default sessions are written through `LocalFileStorage::new("./.agent").namespace("sessions")` so the on-disk paths match harness-ts.
- Byte-observable strings (system prompt, tool descriptions and results, collision rules, limits) follow harness-ts exactly. Port the harness-ts test that pins them.
- `programmatic_tool_caller` runs its interpreter in a `monty` 1.5.0 worker (`cargo install monty-runtime --version 1.5.0 --locked`, found through `MONTY_BIN`, `PATH`, then a `target/{debug,release}` build in the executable's cargo workspace, as `@pydantic/monty` does) and falls back to in-process. Unit tests pin `Isolation::InProcess`; the worker cases in `tools/programmatic_tool_caller/tests/isolation.rs` run with `--ignored` and `MONTY_BIN` set. Keep the `monty`, `monty-types` and `monty-pool` pins equal.
