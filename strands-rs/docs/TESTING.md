# Testing guidelines - Strands Rust SDK

The TS test suites (`strands-ts/src/**/__tests__`, `harness-ts/test`) at the pinned baseline are the behavioural spec. Every in-scope TS `it(...)` has a Rust test with the same intent; [PARITY.md](PARITY.md) holds the map.

## Layout

- Unit tests live beside the code in `#[cfg(test)] mod tests`, mirroring TS `__tests__/` next to the module. The test module's doc comment names the TS spec file it ports.
- Each test keeps the snake_case form of the TS `it(...)` title. Where a `describe` nests, prefix with the describe stem only when needed to disambiguate.
- Cross-module behaviour (agent loop with tools, hooks and plugins) goes in `strands/tests/`.
- `strands::testing` (public module) ships the fixtures that integration tests and downstream crates use.
- Compile-fail tests for the macros use `trybuild` under `strands/tests/ui/`.
- Live provider tests are `#[ignore]`, named `live_*`, and skip with a message when their credentials are missing. They live in `tests/live_bedrock.rs`, `live_anthropic.rs`, `live_openai.rs`, `live_bedrock_mantle.rs` and `live_interventions.rs`. Bedrock and Mantle use the default AWS credential chain (for example `AWS_PROFILE` and `AWS_REGION`); Anthropic and OpenAI read `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Set the variables for the providers you want and run:
  `ANTHROPIC_API_KEY=... OPENAI_API_KEY=... cargo test -p strands --all-features -- --ignored live_`
- Tests that need a feature carry `#[cfg(feature = "...")]`: the provider tests (`bedrock`, `anthropic`, `openai`, `mantle`), the MCP client tests (`mcp`, against the in-process and stdio servers in `tests/support/mcp_server.rs`), the exported-span and provider-setup telemetry tests (`otel`, through an in-memory exporter) and the Cedar tests (`cedar`). `--all-features` runs them all; `--no-default-features` checks the crate without any.
- Doc examples are compiled doctests; `no_run` marks those that would call a model, and `ignore` only fragments that need credentials. The README's Rust blocks compile as doctests too (`ReadmeDoctests` in `lib.rs`).
- Every example in `strands/examples/` declares `required-features` and builds in the gates (`cargo build --workspace --examples --all-features`).

## Fixtures

| Fixture | Use |
|---|---|
| `testing::MockModel` | Scripted model: give it assistant turns (text, tool uses, errors, throttles, delays); it emits the stream events |
| `testing::HookRecorder` | Registers for every hook event and records the order they fired |
| `testing::test_agent()` | An `Agent` with a mock model, no printer and empty registries |
| `conformance/fixtures/*.json` | TS-produced wire shapes; round-trip byte-identically |
| `conformance/fixtures/session-tree/` | A TS-written `LocalFileStorage` session tree that `tests/session_interop.rs` restores; `STRANDS_CONFORMANCE_TS=1` also runs `conformance/check-session-tree.ts` on a Rust-written tree |
| `tempfile::tempdir()` | Storage and session tests |
| `tests/support/mcp_server.rs` | A local MCP server (in-memory duplex, stdio through the `mcp_test_server` example, streamable HTTP and legacy SSE) |

## Rules

- Async tests use `#[tokio::test]`. Never `block_on` inside a tokio test.
- Never sleep for real. Retry, backoff and timers take an injectable sleeper or clock, or use `tokio::time::pause`.
- Assert wire shapes with `serde_json::json!` literals, not `Debug` output.
- Assert exact error text wherever TS tests or cross-SDK tests check it (`assert_eq!(err.to_string(), "...")`).
- Unit tests make no network calls. Provider unit tests exercise request formatting and response parsing with constructed inputs or a local mock server.
- Keep tests deterministic: seed RNGs where jitter is involved, or assert ranges.

## Running

```bash
cargo test --workspace --all-features              # everything, doctests included
cargo test --workspace --no-default-features       # without providers
cargo test -p strands --all-features sliding_window # by name filter
cargo test -p strands --all-features --doc         # doctests only
python3 strands-rs/docs/parity-sweep.py --write    # check PARITY.md against the TS specs, refresh its totals
```

## Parity map

[PARITY.md](PARITY.md) has one row per strands-ts spec file at the pin, unit (`src/**/__tests__/`) and integration (`test/integ/`). A row names its specs in backticks and either counts `ported / total` TS cases (an `it.each` table counts once unless the row says otherwise) with the reasons for each case not ported, or says `out of scope` with the reason, linking the RFC decision (`team/designs/0022-rust-sdk.md`) where there is one. `parity-sweep.py` (Python 3, no network, reads a strands-ts tree at the pin, default `/tmp/ts-spec/strands-ts` or `$STRANDS_TS_ROOT`) fails when a spec has no row or two rows, and `--write` refreshes the totals at the top of the file.
