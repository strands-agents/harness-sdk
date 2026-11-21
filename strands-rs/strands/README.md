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
    Strands Agents - Rust SDK
  </h1>

  <h2>
    A model-driven approach to building AI agents in Rust.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
    <a href="https://crates.io/crates/strands"><img alt="crates.io" src="https://img.shields.io/crates/v/strands"/></a>
    <a href="https://docs.rs/strands"><img alt="docs.rs" src="https://img.shields.io/docsrs/strands"/></a>
    <a href="https://discord.gg/strands"><img alt="Strands Discord" src="https://img.shields.io/badge/Discord-Strands-5865F2?logo=discord&logoColor=white"/></a>
  </div>

  <p>
    <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://docs.rs/strands">API reference</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-cli">CLI</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-mcp">MCP Server</a>
    ◆ <a href="https://discord.gg/strands">Discord</a>
    <br>
    Harness (<a href="https://github.com/strands-agents/harness-sdk/tree/main/harness-py">Python</a>, <a href="https://github.com/strands-agents/harness-sdk/tree/main/harness-ts">TypeScript</a>, <a href="https://github.com/strands-agents/harness-sdk/tree/main/harness-rs">Rust</a>)
    ◆ SDK (<a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-py">Python</a>, <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-ts">TypeScript</a>, <a href="https://github.com/strands-agents/harness-sdk/tree/main/strands-rs">Rust</a>)
    ◆ <a href="https://github.com/strands-agents/box">Box</a>
    ◆ <a href="https://github.com/strands-agents/shell">Shell</a>
    ◆ <a href="https://github.com/strands-agents/evals">Evals</a>
    ◆ <a href="https://github.com/strands-labs">Labs</a>
  </p>
</div>

> Developer preview. The API may change in any 0.x release.

---

## Overview

`strands` is the Rust SDK for [Strands Agents](https://strandsagents.com). You give a model a system prompt and
tools, and the agent loop calls the model, runs the tools it asks for and feeds their results back until the model
answers. The API is async and built on tokio, tools are plain `async fn`s, and typed values go in and out through
`serde` and `schemars`.

The concepts and names match the other Strands SDKs, re-cased to Rust idiom (`systemPrompt` becomes
`system_prompt`), and the crate writes the same JSON for messages, sessions and snapshots, so agents in different
languages can share a session.

### Key features

- **Agent loop**: `invoke` for a result, `stream` for events as they happen, and cooperative cancellation
- **Typed tools**: `#[tool]` turns an `async fn` into a tool and `#[tools]` does the same for the methods of a
  stateful type, with the input schema built from the parameters and their doc comments
- **Model providers**: Amazon Bedrock (the default), Anthropic, OpenAI (Responses and Chat Completions) and Bedrock
  Mantle, each behind a cargo feature, plus the `Model` trait for your own
- **Structured output**: a typed final answer from any `serde` and `schemars` type, validated against its schema
- **MCP**: Model Context Protocol clients over stdio, streamable HTTP and SSE
- **Hooks and interventions**: observe and change every step of the loop, gate tool calls, and ask a human
- **State**: sessions, memory, and conversation and context management that keep history within the context window
- **Telemetry**: `tracing` spans and metrics, with OpenTelemetry export behind a feature

---

## Quick start

### Installation

Add `strands` and tokio to your project:

```bash
cargo add strands
cargo add tokio --features macros,rt-multi-thread
```

For structured output, or tool parameters of your own types, also add `serde` (with `derive`) and `schemars` 1.

The default model is Claude Sonnet 4.6 on Amazon Bedrock (`global.anthropic.claude-sonnet-4-6`). It needs AWS
credentials from the default chain (environment variables, `~/.aws` profiles, SSO or an instance role), access to
the model, and a region (`AWS_REGION`, `us-west-2` when unset).

### Cargo features

| Feature | Default | Adds |
|---|---|---|
| `bedrock` | yes | `BedrockModel` (Amazon Bedrock Converse) and the default model |
| `anthropic` | | `AnthropicModel` (Anthropic Messages API) |
| `openai` | | `OpenAIModel` (Responses and Chat Completions); it does not need `bedrock` |
| `mantle` | | `OpenAIModel::bedrock_mantle`, Amazon Bedrock's OpenAI-compatible Mantle endpoint; turns on `openai` and does not need `bedrock` |
| `mcp` | | `McpClient` over stdio, streamable HTTP and SSE, and the `mcp_router` tool |
| `otel` | | OpenTelemetry export of spans and metrics (OTLP and console) |
| `cedar` | | `CedarAuthorization`, Cedar policy authorization of tool calls |
| `dogwood` | | `DogwoodAuthorization`, Dogwood policy authorization of tool calls, with temporal rules over earlier calls |

To leave out the AWS SDK, turn off the default features and pick a provider:

```toml
[dependencies]
strands = { version = "0.1", default-features = false, features = ["anthropic"] }
```

Without `bedrock`, every agent needs an explicit model.

### Basic usage

An agent with a tool, on the default model:

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

    // The default printer streams the reply to stdout as it arrives.
    let result = agent.invoke("What's the weather in Seattle?").await?;
    println!("\nstop reason: {}", result.stop_reason());
    agent.shutdown().await
}
```

---

## Core concepts

### Agents

`Agent` runs the loop between the user, the model and the tools. Build one with `Agent::builder()`, or from an
`AgentConfig` struct with `Agent::new`. `invoke` takes a prompt and returns an `AgentResult`, which displays as the
reply's text and carries the stop reason, metrics and any structured output. The agent keeps the conversation, so
the next `invoke` continues it.

```rust,no_run
use strands::Agent;

# async fn example() -> strands::Result<()> {
let mut agent = Agent::builder()
    .system_prompt("You are a helpful assistant.")
    .printer(false)
    .build()?;

let result = agent.invoke("Name three Rust web frameworks.").await?;
println!("{result}");
let result = agent.invoke("Which of them is the oldest?").await?;
println!("{result}");
println!("{} messages in history", agent.messages().len());
agent.shutdown().await?;
# Ok(())
# }
```

`printer(false)` turns off the default printer, which writes the reply to stdout as it streams. Call `shutdown`
when you are done: it runs pending cleanup, cancels unfinished background tasks and flushes the memory manager.
`agent.cancel_handle()` returns a handle that stops a running invocation from another task.

An agent is also a tool: pass one agent to another's `tools` and the outer agent can delegate to it by its `name`,
with its `description` telling the model when to.

### Model providers

Each provider is a type that implements `Model`; pass it to `.model(..)`.

**Amazon Bedrock (default)**

```rust,no_run
# #[cfg(feature = "bedrock")]
# async fn example() -> strands::Result<()> {
use strands::Agent;
use strands::models::bedrock::BedrockModel;

let model = BedrockModel::builder()
    .model_id("global.anthropic.claude-sonnet-4-6")
    .region("us-east-1")
    .max_tokens(4096)
    .temperature(0.7)
    .build();

let mut agent = Agent::builder().model(model).build()?;
# Ok(())
# }
```

**Anthropic** (feature `anthropic`; the key comes from `ANTHROPIC_API_KEY` unless you set `api_key`)

```rust,no_run
# #[cfg(feature = "anthropic")]
# async fn example() -> strands::Result<()> {
use strands::Agent;
use strands::models::anthropic::AnthropicModel;

let model = AnthropicModel::builder()
    .model_id("claude-sonnet-4-6")
    .max_tokens(4096)
    .build()?;

let mut agent = Agent::builder().model(model).build()?;
# Ok(())
# }
```

**OpenAI** (feature `openai`; the key comes from `OPENAI_API_KEY` unless you set `api_key`)

`OpenAIModel` uses the Responses API by default; `OpenAIApi::Chat` switches it to Chat Completions.

```rust,no_run
# #[cfg(feature = "openai")]
# async fn example() -> strands::Result<()> {
use strands::Agent;
use strands::models::openai::{OpenAIApi, OpenAIModel};

let responses = OpenAIModel::builder().model_id("gpt-5.4").build()?;
let chat = OpenAIModel::builder()
    .api(OpenAIApi::Chat)
    .model_id("gpt-5.4")
    .build()?;

let mut agent = Agent::builder().model(responses).build()?;
# Ok(())
# }
```

**Bedrock Mantle** (feature `mantle`)

Amazon Bedrock's OpenAI-compatible Mantle endpoint, through `OpenAIModel`. The bearer token is minted from the AWS
default credential chain.

```rust,no_run
# #[cfg(feature = "mantle")]
# async fn example() -> strands::Result<()> {
use strands::Agent;
use strands::models::openai::{BedrockMantleConfig, OpenAIModel, OpenAIModelOptions};

let model = OpenAIModel::bedrock_mantle(
    OpenAIModelOptions::builder().model_id("openai.gpt-oss-120b").build_options(),
    BedrockMantleConfig::builder().region("us-east-1").build(),
)?;

let mut agent = Agent::builder().model(model).build()?;
# Ok(())
# }
```

### Streaming

`agent.stream(..)` yields the same run as a stream of `AgentStreamEvent`s: text deltas as the model writes, the
hook events of the loop, tool calls and the final result.

```rust,no_run
use futures::StreamExt;
use strands::{Agent, AgentStreamEvent};

# async fn example() -> strands::Result<()> {
let mut agent = Agent::builder().printer(false).build()?;
{
    let mut stream = agent.stream("Tell me a story about a brave toaster.");
    while let Some(event) = stream.next().await {
        match event? {
            AgentStreamEvent::ModelStreamUpdate(update) => {
                if let Some(text) = update.text_delta() {
                    print!("{text}");
                }
            }
            AgentStreamEvent::BeforeToolCall(call) => println!("\n[calling {}]", call.tool_use.name),
            AgentStreamEvent::AgentResult(result) => println!("\n[done: {}]", result.stop_reason()),
            _ => {}
        }
    }
}
agent.shutdown().await?;
# Ok(())
# }
```

The stream borrows the agent, so it lives in its own block. `StreamExt` comes from the `futures` crate.

### Tools

`#[tool]` turns an `async fn` into a tool. The function's doc comment is the tool's description, its parameters
form the input schema with their doc comments as property descriptions, and `Option<T>` parameters are optional.
The macro generates a unit struct named after the function in PascalCase (`get_weather` becomes `GetWeather`). The
input is validated against the schema before the call, and an `Err` becomes an error result the model can read.

For tools that share state, put `#[tool]` on the methods of an `impl` block marked `#[tools]`, and pass
`value.tools()` from an `Arc` of the type. A `#[tool(context)]` parameter receives the call's `ToolContext`, with
the calling agent's state.

```rust,no_run
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use strands::{tool, tool_list, tools, Agent, ToolContext, ToolError};

/// Get the current weather for a city.
#[tool]
async fn get_weather(
    /// City name, for example "Seattle".
    city: String,
    /// Days to forecast; 1 when absent.
    days: Option<u32>,
) -> Result<String, ToolError> {
    Ok(format!("Sunny in {city} for {} days", days.unwrap_or(1)))
}

struct Inventory {
    stock: Mutex<HashMap<String, u32>>,
}

#[tools]
impl Inventory {
    /// Look up how many units of a product are in stock.
    #[tool]
    async fn check_stock(
        &self,
        #[tool(context)] context: &ToolContext,
        /// The product's SKU, for example "kb-01".
        sku: String,
    ) -> Result<u32, ToolError> {
        let _region = context.agent().app_state().get::<String>("region")?;
        let stock = self.stock.lock().map_err(|_| ToolError::msg("inventory is unavailable"))?;
        stock.get(&sku).copied().ok_or_else(|| ToolError::msg(format!("unknown SKU {sku}")))
    }
}

# async fn example() -> strands::Result<()> {
let inventory = Arc::new(Inventory {
    stock: Mutex::new(HashMap::from([("kb-01".to_owned(), 3)])),
});
let mut agent = Agent::builder()
    .tools(tool_list![GetWeather, inventory.tools()])
    .build()?;

agent.invoke("What's the weather in Lisbon, and are kb-01 keyboards in stock?").await?;

// Tools can also be called directly, without the model.
let stock = agent.tool("check_stock").invoke(serde_json::json!({"sku": "kb-01"})).await?;
println!("{:?}", stock.content);
# Ok(())
# }
```

`.tools(..)` takes any iterator of tools; `tool_list!` mixes tools of different types. Implement the `Tool` trait,
or build a `FunctionTool` from a closure and a JSON schema, for tools defined at run time.

### Vended tools

The crate ships ready-made tools for common agent tasks under `strands::vended_tools`, one module per tool:

```rust,no_run
use strands::Agent;
use strands::vended_tools::shell::{make_shell, MakeShellOptions};
use strands::vended_tools::{edit::edit, http_request::http_request, read::read, write::write};

# async fn example() -> strands::Result<()> {
let mut agent = Agent::builder()
    .tools([read(), write(), edit(), http_request(), make_shell(MakeShellOptions::default())?])
    .build()?;

agent.invoke("Fetch https://strandsagents.com and save a one-paragraph summary to /tmp/summary.md").await?;
# Ok(())
# }
```

| Tool | Functions | Description |
| --- | --- | --- |
| Shell | `shell::make_shell` | Run shell commands |
| Bash | `bash::bash` | Run commands in a persistent bash process on the host |
| Read | `read::read`, `read::make_read` | Read a file as numbered text, or an image or document as a media block |
| Write | `write::write`, `write::make_write` | Create or overwrite a text file with the full provided content |
| Edit | `edit::edit`, `edit::make_edit` | Replace an exact, unique string in a text file |
| File editor *(deprecated)* | `file_editor::file_editor`, `file_editor::make_file_editor` | View, create and edit files. Use `edit` instead |
| HTTP request | `http_request::http_request` | Make HTTP requests to external APIs |
| Web fetch | `web_fetch::web_fetch`, `web_fetch::make_web_fetch` | Fetch a web page for the model to read |
| Notebook | `notebook::notebook`, `notebook::make_notebook` | Keep persistent text notes |
| Python REPL | `python_repl::python_repl`, `python_repl::make_python_repl` | Run Python code |
| Sleep | `sleep::sleep`, `sleep::make_sleep` | Pause for a bounded, cancellable duration |
| Handoff to user | `handoff_to_user::handoff_to_user`, `handoff_to_user::make_handoff_to_user` | Pause the agent loop and ask the user for input |
| Stop | `stop::stop`, `stop::make_stop` | End the agent loop when the task is done |
| Subagent | `subagent::subagent`, `subagent::make_subagent` | Delegate a self-contained task to a child agent |
| MCP router | `mcp_router::make_mcp_router` | Connect to MCP servers on an allowlist you set (feature `mcp`) |

The `make_*` factories take options, for example to bind a sandbox or change a tool's name. Shell, read, write,
edit, file editor and Python REPL run through a `Sandbox`; without one on the agent (`.sandbox(..)`) they run on the
host with no isolation.

### Structured output

Give an invocation a type that derives `serde::Deserialize` and `schemars::JsonSchema`, and the agent returns its
final answer as that type. The answer is validated against the type's schema, and an invalid one goes back to the
model with the violations so it can retry.

```rust,no_run
use schemars::JsonSchema;
use serde::Deserialize;
use strands::{Agent, InvokeOptions};

/// A person mentioned in the text.
#[derive(Deserialize, JsonSchema)]
struct Person {
    /// Name of the person.
    name: String,
    /// Age of the person.
    age: u32,
    /// Occupation of the person.
    occupation: String,
}

# async fn example() -> strands::Result<()> {
let mut agent = Agent::builder().printer(false).build()?;

let person: Person = agent
    .invoke_with(
        "John Smith is a 30 year-old software engineer",
        InvokeOptions::default().structured_output_schema::<Person>(),
    )
    .await?
    .structured_output()?;

println!("{} ({}), {}", person.name, person.age, person.occupation);
# Ok(())
# }
```

`Agent::builder().structured_output_schema::<T>()` sets a schema for every invocation instead. When the model does
not produce structured output, the call fails with `strands::Error::StructuredOutput`.

### MCP

With the `mcp` feature, an `McpClient` connects to a Model Context Protocol server. Pass it to an agent's tools and
the agent lists the server's tools when it initializes.

```rust,no_run
# #[cfg(feature = "mcp")]
# async fn example() -> strands::Result<()> {
use strands::Agent;
use strands::mcp::{McpClient, McpClientConfig, McpTransport, StdioServerParameters};

let docs = McpClient::with_transport(McpTransport::stdio(StdioServerParameters::new(
    "uvx",
    ["awslabs.aws-documentation-mcp-server@latest"],
)));
let remote = McpClient::new(McpClientConfig {
    url: Some("https://example.com/mcp".to_owned()),
    ..McpClientConfig::default()
})?;

let mut agent = Agent::builder()
    .system_prompt("You are a helpful assistant using MCP tools.")
    .tools([docs.clone(), remote.clone()])
    .build()?;
agent.invoke("How do I enable versioning on an S3 bucket?").await?;

agent.shutdown().await?;
docs.disconnect().await?;
remote.disconnect().await?;
# Ok(())
# }
```

A URL uses streamable HTTP; `McpTransport::sse` reaches servers on the legacy HTTP+SSE protocol. `McpClientOptions`
sets a tool name prefix and tool filters, and `McpClient::load_servers` builds clients from an `mcp.json`-style
config. The raw MCP types come from `rmcp`, re-exported as `strands::mcp::rmcp`.

### Hooks and interventions

Hooks run at each step of the loop: before and after an invocation, each model call and each tool call, when a
message is added, and more. A hook is a closure over the event type it handles, and it can change the event, for
example to cancel a tool call. `add_async_hook` takes an async closure, and the `Hook` trait suits hooks with state
of their own.

```rust,no_run
use strands::Agent;
use strands::hooks::{AfterInvocationEvent, BeforeToolCallEvent};

# async fn example() -> strands::Result<()> {
let mut agent = Agent::builder().build()?;

agent.add_hook(|event: &mut BeforeToolCallEvent| {
    if event.tool_use().name == "delete_file" {
        event.set_cancel("deleting files is disabled");
    }
});
agent.add_async_hook::<BeforeToolCallEvent>(|event| {
    Box::pin(async move {
        println!("[audit] {} {}", event.tool_use().name, event.tool_use().input);
    })
});
agent.add_hook(|event: &mut AfterInvocationEvent<'_>| {
    println!("[done] {} messages", event.agent().messages().len());
});
# Ok(())
# }
```

An `InterventionHandler` is a policy over the same lifecycle points. Each method it overrides returns an action:
proceed, deny, guide the model with feedback, confirm with a human, or transform the event.

```rust,no_run
use strands::Agent;
use strands::hooks::BeforeToolCallEvent;
use strands::interventions::{InterventionAction, InterventionHandler, InterventionResult};

struct NoShell;

#[strands::async_trait]
impl InterventionHandler for NoShell {
    fn name(&self) -> &str {
        "no-shell"
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        if event.tool_use().name == "shell" {
            return Ok(InterventionAction::deny("shell is disabled"));
        }
        Ok(InterventionAction::proceed())
    }
}

# async fn example() -> strands::Result<()> {
let mut agent = Agent::builder().intervention(NoShell).build()?;
# Ok(())
# }
```

`strands::vended_interventions` has ready-made handlers: `HumanInTheLoop` asks for approval before tools that are
not on its allow list, on the terminal or through your own callback, `CedarAuthorization` (feature `cedar`)
authorizes tool calls with Cedar policies, and `DogwoodAuthorization` (feature `dogwood`) with Dogwood policies, whose
temporal rules can depend on earlier calls ("delete only after a search"). A `Plugin` extends an agent with hooks, tools and setup in one value, and
`strands::middleware` wraps the model call and each tool execution.

### Sessions

A `SessionManager` saves the agent's conversation and state to a `Storage` after each invocation, and an agent
built with the same session id restores it when it initializes. The layout is the one the other Strands SDKs use.

```rust,no_run
use strands::storage::LocalFileStorage;
use strands::{Agent, SessionManager};

# async fn example() -> strands::Result<()> {
let session_manager = SessionManager::builder()
    .session_id("user-123")
    .storage(LocalFileStorage::new("./sessions"))
    .build()?;

let mut agent = Agent::builder().session_manager(session_manager).build()?;
agent.invoke("My favourite colour is teal.").await?;
agent.shutdown().await?;
# Ok(())
# }
```

`InMemoryStorage` keeps sessions in memory, and the `Storage` trait is the seam for other backends. For memory that
spans sessions, the `MemoryManager` plugin extracts memories from the conversation into a `MemoryStore`.

### Conversation and context management

A conversation manager keeps the history within the model's context window. The default is a
`SlidingWindowConversationManager` of 40 messages; `SummarizingConversationManager` replaces older messages with a
summary instead, and `NullConversationManager` leaves the history alone.

```rust,no_run
use strands::Agent;
use strands::conversation_manager::{SlidingWindowConversationManager, SlidingWindowConversationManagerConfig};
use strands::conversation_manager::{SummarizingConversationManager, SummarizingConversationManagerConfig};

# async fn example() -> strands::Result<()> {
let window = SlidingWindowConversationManager::new(SlidingWindowConversationManagerConfig {
    window_size: Some(20),
    ..Default::default()
})?;
let agent = Agent::builder().conversation_manager(window).build()?;

let summarizing = SummarizingConversationManager::new(SummarizingConversationManagerConfig {
    preserve_recent_messages: Some(10),
    ..Default::default()
})?;
let agent = Agent::builder().conversation_manager(summarizing).build()?;
# Ok(())
# }
```

The experimental context manager in `strands::experimental` replaces the conversation manager when set.
`ContextManagerStrategy::Auto` truncates tool results and summarizes at 85% utilization, `Agentic` lets the model
manage its context through the `summarize_context`, `truncate_context` and `pin_context` tools, and a
`ContextManagerConfig` sets a custom pipeline and stash.

```rust,no_run
use strands::Agent;
use strands::experimental::ContextManagerStrategy;

# async fn example() -> strands::Result<()> {
let agent = Agent::builder().context_manager(ContextManagerStrategy::Auto).build()?;
# Ok(())
# }
```

### Telemetry

The agent records `tracing` spans for each invocation, loop cycle, model call and tool call, so any `tracing`
subscriber sees them. Every `AgentResult` also carries metrics: token usage, cycle count, tool metrics and
duration.

```rust,no_run
use strands::Agent;

# async fn example() -> strands::Result<()> {
let mut agent = Agent::builder().printer(false).build()?;
let result = agent.invoke("Hello").await?;
if let Some(metrics) = result.metrics() {
    let usage = &metrics.accumulated_usage;
    println!("{} cycles, {} tokens in, {} out", metrics.cycle_count, usage.input_tokens, usage.output_tokens);
}
# Ok(())
# }
```

With the `otel` feature, `setup_tracer` and `setup_meter` export spans and metrics over OTLP or to the console.
Spans then also carry message content and custom `trace_attributes`. The OpenTelemetry crates are re-exported from
`strands::telemetry`, so their versions always match.

```rust,no_run
# #[cfg(feature = "otel")]
# async fn example() -> strands::Result<()> {
use strands::Agent;
use strands::telemetry::{setup_meter, setup_tracer, MeterConfig, TelemetryExporters, TracerConfig};

let exporters = TelemetryExporters { otlp: true, console: false };
let tracer = setup_tracer(TracerConfig { exporters, ..Default::default() })?;
let _meter = setup_meter(MeterConfig { exporters, ..Default::default() })?;
tracer.try_init_subscriber()?;

let mut agent = Agent::builder()
    .name("clock")
    .trace_attributes([("team", "platform")])
    .build()?;
agent.invoke("What time is it in Tokyo?").await?;
agent.shutdown().await?;
// The tracer and meter guards flush their exporters when they drop.
# Ok(())
# }
```

The OTLP exporters read the standard `OTEL_EXPORTER_OTLP_*` environment variables, such as
`OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## Examples

[`strands/examples/`](https://github.com/strands-agents/harness-sdk/tree/main/strands-rs/strands/examples) has a
runnable program for each area. Run one from the repository root with `cargo run -p strands --example <name>`, and
add `--features <feature>` where the table lists a feature other than `bedrock`:

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

Provider examples read credentials from the environment and say what to set when they are missing. For complete
applications, see the [samples](https://github.com/strands-agents/samples) repository.

---

## Status and versioning

This is a developer preview. It covers the agent loop; Bedrock, Bedrock Mantle, Anthropic and OpenAI models; tools,
vended tools, hooks, interventions, plugins, middleware and interrupts; agents as tools and the subagent tool; MCP,
sessions, memory, conversation and context management, the sandbox seam and telemetry. Multi-agent orchestration
(Graph, Swarm, A2A), bidirectional streaming, and the Google, Ollama and LiteLLM providers are not included in this
version.

**Versions.** `strands` follows semver for 0.x crates: a minor release (0.1 to 0.2) may break the API, and a patch
release does not.

**MSRV.** Rust 1.96. The MSRV never drops below what required dependencies declare, and it moves only in minor
releases.

**Public dependencies.** With `otel`, the `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp`,
`opentelemetry-stdout`, `tracing-opentelemetry` and `tracing-subscriber` types are part of the public API; with
`mcp`, the raw MCP results and the live client are `rmcp` types. Moving any of them to a semver-incompatible version
is a breaking `strands` release. Use the re-exports in `strands::telemetry` and `strands::mcp::rmcp` so the versions
always match.

---

## Documentation

- **[API reference](https://docs.rs/strands)**: the crate documentation on docs.rs, with a guide in each module
- **[Strands Agents documentation](https://strandsagents.com/)**: concepts, guides and tutorials shared by the
  Strands SDKs
- **[Examples](https://github.com/strands-agents/harness-sdk/tree/main/strands-rs/strands/examples)**: a runnable
  program for each area
- **[Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md)**: development
  setup and guidelines

---

## Contributing ❤️

We welcome contributions! See our
[Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md) for details on:

- Development setup and environment
- Testing and code quality standards
- Pull request process
- Code of Conduct
- Security issue reporting

---

## Stay in touch with the team

Come meet the Strands team and other users on [**Discord**](https://discord.com/invite/strands)

---

## License

This project is licensed under the Apache License 2.0 - see the
[LICENSE](https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE) file for details.

---

## Security

See [CONTRIBUTING](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md#security-issue-notifications)
for more information on reporting security issues.
