# Strands Agents SDK for Rust

> Developer preview. The API may change in any 0.x release.

`strands` is the Rust SDK for [Strands Agents](https://strandsagents.com), a model-driven approach to building AI agents. It uses the same concepts and names as the Python and TypeScript SDKs, re-cased to Rust idiom (`systemPrompt` becomes `system_prompt`), and writes the same JSON for messages, sessions and snapshots, so Rust and TypeScript agents can share a session.

## Install

```toml
[dependencies]
strands = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The default model is Amazon Bedrock, which needs AWS credentials and a region from the AWS default chain (environment variables, `~/.aws` profiles, SSO or an instance role).

## Features

| Feature | Default | Adds |
|---|---|---|
| `bedrock` | yes | `BedrockModel` (Amazon Bedrock Converse) and the default model |
| `anthropic` | | `AnthropicModel` (Anthropic Messages API) |
| `openai` | | `OpenAIModel` (Responses and Chat Completions); it does not need `bedrock` |
| `mantle` | | `OpenAIModel::bedrock_mantle`, Amazon Bedrock's OpenAI-compatible Mantle endpoint; turns on `openai` and does not need `bedrock` |
| `mcp` | | `McpClient` over stdio, streamable HTTP and SSE, and the `mcp_router` tool |
| `otel` | | OpenTelemetry export of spans and metrics (OTLP and console) |
| `cedar` | | `CedarAuthorization`, Cedar policy authorization of tool calls |

To leave out the AWS SDK, turn off the default features and pick a provider:

```toml
strands = { version = "0.1", default-features = false, features = ["anthropic"] }
```

## Quick start

An agent with a tool, on the default Bedrock model:

```rust,no_run
use strands::{tool, Agent, ToolError};

/// Get the current weather for a city.
#[tool]
async fn get_weather(
    /// City name, for example "Seattle".
    city: String,
) -> Result<String, ToolError> {
    Ok(format!("Sunny in {city}"))
}

#[tokio::main]
async fn main() -> strands::Result<()> {
    let mut agent = Agent::builder()
        .system_prompt("You are a concise assistant.")
        .tools([GetWeather])
        .build()?;

    let result = agent.invoke("What's the weather in Seattle?").await?;
    println!("{result}");
    agent.shutdown().await
}
```

The same agent on Anthropic (feature `anthropic`, key from `ANTHROPIC_API_KEY`):

```rust,ignore
use strands::models::anthropic::AnthropicModel;

let model = AnthropicModel::builder().model_id("claude-sonnet-4-6").build()?;
let mut agent = Agent::builder().model(model).tools([GetWeather]).build()?;
```

`agent.stream(..)` yields the same run as events (text deltas, tool calls, the result), and `#[tools]` turns the methods of a stateful type into tools. The crate documentation covers hooks, structured output, cancellation, sessions, memory, MCP and telemetry.

## Examples

[`strands/examples/`](https://github.com/strands-agents/harness-sdk/tree/main/strands-rs/strands/examples) has a runnable program for each area. Run one with `cargo run -p strands --example <name>` (add `--features <feature>` where noted):

| Example | Shows | Features |
|---|---|---|
| `basic` | An agent on the default model | `bedrock` |
| `tools` | `#[tool]` functions and `#[tools]` methods with shared state, and direct tool calls | `bedrock` |
| `streaming` | Text deltas, tool calls and the result from `agent.stream(..)` | `bedrock` |
| `hooks` | Sync and async hooks, and a `Hook` implementation | `bedrock` |
| `structured_output` | A typed final answer through `serde` and `schemars` | `bedrock` |
| `mcp` | An MCP client over stdio, tool filters and direct calls; needs no model | `mcp` |
| `sessions` | `SessionManager` with `LocalFileStorage`, restored by a second agent | `bedrock` |
| `bedrock` | `BedrockModel` with an explicit model, region and settings | `bedrock` |
| `anthropic` | `AnthropicModel` | `anthropic` |
| `openai` | `OpenAIModel` on the Responses API and Chat Completions | `openai` |
| `bedrock_mantle` | `OpenAIModel` through Bedrock Mantle | `mantle` |
| `interventions` | Human-in-the-loop approval on the terminal | `bedrock` |
| `telemetry` | OpenTelemetry spans to the console and OTLP | `otel`, `bedrock` |

Provider examples read credentials from the environment and say what to set when they are missing.

## Status and versioning

This is a developer preview. It covers the agent loop; Bedrock, Bedrock Mantle, Anthropic and OpenAI models; tools, hooks, plugins, middleware and interrupts; MCP, sessions, memory, context management and the sandbox seam. Multi-agent orchestration (Graph, Swarm, A2A) and bidirectional streaming are not included yet.

- **Versions.** strands follows semver for 0.x crates: a minor release (0.1 to 0.2) may break the API, and a patch release does not.
- **MSRV.** Rust 1.96. The MSRV never drops below what required dependencies declare, and it moves only in minor releases.
- **OpenTelemetry.** With `otel`, the `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp`, `opentelemetry-stdout`, `tracing-opentelemetry` and `tracing-subscriber` types are part of the public API. Moving any of them to a semver-incompatible version is a breaking strands release; use the re-exports in `strands::telemetry` so the versions always match.
- **MCP.** With `mcp`, raw MCP results and the live client are `rmcp` types, re-exported as `strands::mcp::rmcp`. An `rmcp` major version bump is a breaking strands release.

## License

Apache-2.0
