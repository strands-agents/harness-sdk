# Strands Agents SDK for Rust

The Rust SDK for [Strands Agents](https://strandsagents.com). Install, features, a quick start and the examples are in the [`strands` crate README](strands/README.md).

| Directory | Contents |
|---|---|
| [`strands/`](strands) | The `strands` crate: the agent loop, model providers, tools, hooks, sessions, MCP and telemetry |
| [`strands-macros/`](strands-macros) | The `strands-macros` crate: the `#[tool]` and `#[tools]` attribute macros, re-exported by `strands` |
| [`conformance/`](conformance) | Wire fixtures written by the TypeScript SDK, which the Rust tests read back byte for byte |
| [`docs/`](docs) | Testing guide, the TypeScript parity map and the documented divergences |

The harness built on this SDK is in [`harness-rs/`](../harness-rs).
