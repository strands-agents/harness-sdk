<div align="center">
  <div>
    <a href="https://strandsagents.com">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://strandsagents.com/latest/assets/wordmark-github-dark.svg">
        <img src="https://strandsagents.com/latest/assets/wordmark-github-light.svg" alt="Strands" width="320">
      </picture>
    </a>
  </div>

  <h1>
    Strands Agents SDK for Rust
  </h1>

  <h2>
    A model-driven approach to building AI agents in just a few lines of code.
  </h2>

  <div align="center">
    <a href="https://crates.io/crates/strands"><img alt="crates.io" src="https://img.shields.io/crates/v/strands"/></a>
    <a href="https://docs.rs/strands"><img alt="docs.rs" src="https://img.shields.io/docsrs/strands"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
  </div>

  <p>
    <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://docs.rs/strands">API reference</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://discord.gg/strands">Discord</a>
  </p>
</div>

> Developer preview. The API may change in any 0.x release.

The Rust SDK for [Strands Agents](https://strandsagents.com): the agent loop, model providers, tools, hooks, sessions,
MCP and telemetry, with the same concepts and names as the Python and TypeScript SDKs. Install, features, a quick start
and the examples are in the [`strands` crate README](strands/README.md).

```bash
cargo add strands
cargo add tokio --features macros,rt-multi-thread
```

| Directory | Contents |
|---|---|
| [`strands/`](strands) | The `strands` crate: the agent loop, model providers, tools, hooks, sessions, MCP and telemetry |
| [`strands-macros/`](strands-macros) | The `strands-macros` crate: the `#[tool]` and `#[tools]` attribute macros, re-exported by `strands` |
| [`conformance/`](conformance) | Wire fixtures written by the TypeScript SDK, which the Rust tests read back byte for byte |
| [`docs/`](docs) | The [testing guide](docs/TESTING.md), the [parity map](docs/PARITY.md) and the [divergences](docs/DIVERGENCES.md) |

The harness built on this SDK, a preconfigured agent in one call, is in [`harness-rs/`](../harness-rs).

## Contributing

See the [contributing guide](../CONTRIBUTING.md#rust-sdk-and-harness) and [`AGENTS.md`](AGENTS.md) for how the crates are
built, tested and kept in parity.

## License

Apache-2.0. See [LICENSE.APACHE](../LICENSE.APACHE).
