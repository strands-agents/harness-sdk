# Agent Development Guide - Rust SDK

This document guides AI agents working on the Strands Rust SDK (`strands-rs/`). Cross-SDK rules (construct naming, parity, public/internal marking, structured logging, evergreen comments) live in the [root AGENTS.md](../AGENTS.md); this file shows only the Rust form and the Rust-only rules.

## Overview

`strands` is the Rust port of the Strands Agents SDK. TypeScript (`strands-ts/`) is canonical for concepts, names and behaviour. Every public type, function, parameter, hook event and config key that exists in TS exists in Rust under the same words, re-cased for Rust (`systemPrompt` becomes `system_prompt`, `'endTurn'` becomes `StopReason::EndTurn`). A name changes only when it clashes with the Rust prelude.

## Layout

```
Cargo.toml                 # repo-root virtual workspace (resolver 3, MSRV, lints, shared deps)
strands-rs/
├── README.md              # directory overview: the crates and where things are
├── strands/               # crate `strands`
│   ├── README.md          # crate README (crates.io and doctests): install, features, quick start, examples, versioning
│   ├── src/               # module stems mirror strands-ts/src directories in snake_case
│   ├── tests/             # cross-module tests (agent loop + tools + hooks), live tests (`live_*`), `ui/` compile-fail tests, `support/` fixtures
│   └── examples/          # one runnable program per area, each with `required-features`
├── strands-macros/        # crate `strands-macros`: #[tool], #[tools]
├── conformance/           # TS-produced wire fixtures and their generator
└── docs/                  # TESTING.md, PARITY.md (+ parity-sweep.py), DIVERGENCES.md
```

Features of `strands`:

| Feature | Adds |
|---|---|
| `bedrock` (default) | `BedrockModel` and the default model |
| `anthropic` | `AnthropicModel` |
| `openai` | `OpenAIModel`; independent of `bedrock` |
| `mantle` | `OpenAIModel::bedrock_mantle` and `BedrockMantleConfig`; turns on `openai` and the AWS signing crates |
| `mcp` | `McpClient` and the `mcp_router` tool |
| `otel` | OpenTelemetry export (`telemetry::setup_tracer`, `setup_meter`); its OpenTelemetry crate versions are public API |
| `cedar` | `CedarAuthorization` |
| `dogwood` | `DogwoodAuthorization`; shares `cedar-policy` 4.14.0 with `cedar` |

Code behind a feature carries `#[cfg(feature = "...")]` and, for public items, shows on docs.rs through `doc_cfg`. Every combination the gates run (all features, no default features) must build and pass.

## Gates

Run from the repo root before every commit:

```bash
cargo +1.100.0 fmt --check                      # lint toolchain, pinned in CI
cargo +1.100.0 clippy --workspace --all-targets --all-features -- -D warnings
cargo build --workspace --examples --all-features
cargo test --workspace --all-features          # includes the doctests and the README's code blocks
cargo test --workspace --no-default-features
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --all-features --no-deps
RUSTDOCFLAGS="-D warnings" cargo doc -p strands --no-deps                         # default features
RUSTDOCFLAGS="-D warnings" cargo doc -p strands --no-deps --no-default-features
cargo +1.96.0 check --workspace --all-features   # MSRV
cargo deny check
python3 strands-rs/docs/parity-sweep.py          # every TS spec has a PARITY row
```

Redirect long output to a file and read the tail. Run the gates one after another: two cargo commands sharing a target directory can replace each other's artifacts and fail doctests with E0463.

## Code rules

- Edition 2024, MSRV 1.96. The MSRV never drops below what required dependencies declare and moves only in minor releases.
- Library code has no `unwrap`, `expect`, `panic!`, `todo!` or `unsafe` (clippy and `forbid(unsafe_code)` enforce it). Tests may use them.
- The public API never requires `Any`, `TypeId` or downcasting.
- Config and option structs (`AgentConfig`, `InvokeOptions`, provider configs) are exhaustive with public fields, `Default` and a builder. Enums, events, errors, results and wire structs are `#[non_exhaustive]`; wire structs get constructors.
- Extension traits (`Model`, `Tool`, `Plugin`, `Storage`, `Sandbox`, ...) use `async-trait` so `Arc<dyn Trait>` works. No tokio or tokio-util types in public signatures.
- Errors are `thiserror` enums mirroring the TS error classes, with typed variants where callers branch and source chains. Providers translate vendor errors and keep the original as `source`.
- Imports at the top of the file. Flat control flow: guard clauses, `let ... else`, helpers, lookup tables.
- No comments that narrate the code. Comments state only a constraint, invariant or non-obvious why.
- Public items need rustdoc. Code snippets in docs are compiled doctests.
- Logging uses `tracing` with the cross-SDK format: `tracing::warn!("tool_name=<{name}> | tool not found")`.
- `InvocationState` belongs to the user; SDK code never stores internal state in it.

## Model info

`strands/build.rs` embeds `shared/model-info.json`, the model data every Strands SDK reads; edit that file, never a copy. A packaged crate cannot reach `shared/`, so copy it in before packaging or publishing (the copy is git-ignored, and packaging fails without it):

```bash
cp shared/model-info.json strands-rs/strands/model-info.json
cargo package -p strands-macros -p strands
```

## Wire compatibility

- Messages and content blocks use the Bedrock Converse JSON shape, as in TS.
- Strands-owned persisted data (snapshots, sessions, archive, interrupt state, event JSON, metric and span names) uses the TS keys, values and layout byte for byte.
- `serde_json` and `schemars` use `preserve_order`: key order is part of the wire format.
- Fixtures in `conformance/fixtures/` are produced by TS (`conformance/generate.ts`) and must round-trip byte-identically. Regenerate with `npx tsx strands-rs/conformance/generate.ts` from the repo root, after `npm ci`, `npm ci --prefix harness-ts --legacy-peer-deps --ignore-scripts` (so harness-ts resolves the repo's strands-ts, not a published copy) and `npm run build -w strands-ts`.
- Sessions interoperate both ways: `conformance/fixtures/session-tree/` is a `LocalFileStorage` tree a TS `SessionManager` wrote (also from `generate.ts`), which `tests/session_interop.rs` restores; with `STRANDS_CONFORMANCE_TS=1` the same test writes a tree from Rust and restores it in TS through `npx tsx strands-rs/conformance/check-session-tree.ts` (needs the repo's `node_modules`).
- A fix for a TS bug never changes a cross-SDK wire or persisted format. Record user-visible differences in `docs/DIVERGENCES.md`.

## Tests

Follow [docs/TESTING.md](docs/TESTING.md). Port the TS spec that covers the code, keep the snake_case form of each TS `it(...)` name, and record the mapping in [docs/PARITY.md](docs/PARITY.md); `docs/parity-sweep.py --write` checks that every TS spec has exactly one row and refreshes the totals.
