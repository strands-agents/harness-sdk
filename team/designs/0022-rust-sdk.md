# Rust SDK and harness

**Date**: 2026-11-19

**Issue**: [#1202](https://github.com/strands-agents/harness-sdk/issues/1202)

**Scope**: Rust (new `strands-rs` SDK and `harness-rs` harness). No changes to Python or TypeScript.

**TypeScript baseline**: strands-ts and harness-ts at commit `d6c5fae7c`

## Overview

We propose an official Rust SDK (`strands`) and harness (`strands-harness`) in this monorepo, next to the Python and TypeScript packages. They use the same concepts, abstractions and names as the other SDKs, re-cased to Rust idiom (`systemPrompt` becomes `system_prompt`, `BeforeToolCallEvent` stays `BeforeToolCallEvent`). Where Rust has a better-fitting idiom we use it, the way Python has `@tool` and TypeScript does not. TypeScript is the reference for behaviour, and parity is measured against commit `d6c5fae7c`.

The first release, v0.1.0, is a developer preview. It covers the agent loop; Bedrock, Bedrock Mantle, Anthropic and OpenAI models; tools, hooks, plugins, middleware and interrupts; MCP, sessions, memory, context management and the sandbox seam; and a harness with the same defaults as harness-ts. Multi-agent orchestration, A2A and bidirectional streaming come in later releases.

## Problem

Developers building agents in Rust have no official Strands option. Today they use unofficial ports, wrap the Python SDK, or pick a different framework. Rust suits workloads where Python and TypeScript are a weaker fit: long-running services that need predictable memory and real parallelism, edge, embedded and robotics hosts, single static binaries, and codebases where coding agents write most of the code and the compiler acts as a strict, deterministic reviewer.

### Current state

[#1202](https://github.com/strands-agents/harness-sdk/issues/1202) asks for a Rust SDK, and [strands-agents/shell#151](https://github.com/strands-agents/shell/issues/151) asks for the Shell crate on crates.io so Rust agents can link it. Go ([#616](https://github.com/strands-agents/harness-sdk/issues/616)) and Java ([#240](https://github.com/strands-agents/harness-sdk/issues/240)) get more requests, but Rust is already part of the Strands ecosystem: Strands Box and Strands Shell are written in it.

An unofficial `strands-agents` crate on crates.io ports part of an older Python SDK layout and links to the Strands homepage, so users looking for an official crate can take it for one. Another unofficial port that users mentioned in #1202 has since been deleted.

Python and TypeScript are kept in parity by convention, porting and review. That has worked, but small divergences add up, and bug fixes sometimes land in one SDK only. A third language raises that cost unless it is designed for mechanical parity from the start.

## Proposal

### Recommended: an idiomatic Rust SDK and harness with TypeScript-canonical concepts

**Principles**

1. **Same concepts and names.** Every public type, function, parameter, hook event and config key that exists in TS exists in Rust under the same words, cased for Rust. A name changes only when it clashes with the Rust prelude; the one case is the harness subagent `Option` class, which becomes `ChoiceOption`.

   | Construct | TS | Rust |
   |---|---|---|
   | Types | `PascalCase` | same `PascalCase` |
   | Functions, fields, parameters | `camelCase` | `snake_case` |
   | Enum-like literals | `'endTurn'` | `StopReason::EndTurn` |
   | Modules | `kebab-case` | `snake_case`, same stem |
   | Context manager entry point | `@strands-agents/sdk/context-manager` | `strands::context_manager` |

2. **Idiomatic where Rust differs.** Builders instead of optional-field object literals, `Result` instead of exceptions, `#[tool]` instead of `tool({...})`, cargo features instead of optional peer dependencies, `Stream` instead of async generators, and an explicit `shutdown().await` instead of `await using`.
3. **TS behaviour, byte-identical only where it is observable across SDKs.** Wire formats, persisted data, prompts and the error text that cross-SDK tests check match TS exactly. Everything else is Rust-native, for example slicing strings by `char` rather than by UTF-16 code unit ([decision](#decision-observable-parity)).
4. **No Rust-only behaviour.** v0.1.0 adds no features that TS lacks and leaves out TS APIs marked `@deprecated`. Small idiomatic accessors, such as `text_delta()` on a stream update, are allowed. Where TS reaches into private agent internals, Rust exposes the narrowest public API that does the same job.
5. **Conservative public API.** No `Any`, `TypeId` or downcasting in public APIs, and no `unwrap`, `expect`, `panic` or `unsafe` in library code. Plain config and option structs have public fields, `Default` and a builder; everything else public is `#[non_exhaustive]` ([decision](#decision-exhaustive-config-structs)). Dependencies are popular, well-maintained crates.

**Layout and features**

```
strands-rs/                  # SDK, mirrors strands-ts/
  strands/                   #   crate `strands`
  strands-macros/            #   crate `strands-macros` (#[tool], #[tools])
harness-rs/                  # harness, mirrors harness-ts/
  strands-harness/           #   crate `strands-harness`
Cargo.toml                   # root virtual workspace, one Cargo.lock
```

Providers, MCP, OpenTelemetry and Cedar are cargo features of `strands` rather than separate crates: `bedrock` (the default), `anthropic`, `openai`, `mantle`, `mcp`, `otel`, `cedar` and `dogwood`. A disabled feature skips its dependencies entirely, so an Anthropic-only build compiles no AWS crates. `mantle` enables `openai` plus the small AWS signing and credential crates, and Mantle is built with `OpenAIModel::bedrock_mantle(options, BedrockMantleConfig)`. That differs from TS, which puts `bedrockMantleConfig` in the OpenAI options: cargo features must be additive, and a feature-gated field on an exhaustive options struct breaks that ([decision](#decision-mantle-feature)). `strands-harness` turns on every provider, `mantle`, `mcp` and `cedar` by default. The crate names `strands`, `strands-macros` and `strands-harness` are reserved on crates.io. There is no Rust CLI; `strands-cli` stays TypeScript.

**Scope**

v0.1.0 ports the single-agent SDK and the harness: types and wire formats, the `Model` trait and four providers, tools and the `#[tool]` macros, the agent loop, hooks, plugins, middleware and interrupts, interventions (`HumanInTheLoop`, `CedarAuthorization`), conversation managers and the `ContextManager`, storage, sessions and memory, the `Sandbox` trait with a local sandbox and the vended tools, MCP, telemetry, and `create_harness` with every harness-ts option and built-in tool. Graph, Swarm, A2A, steering, checkpointing, more sandboxes, more stores and more providers follow in later v0.x releases. The full list is in Additional Details.

**Core API**

1. **`Agent` is owned and takes `&mut self`.** Calling the agent while an invocation runs is a compile error, so TS's `ConcurrentInvocationError` cannot happen. Callers that share an agent wrap it in `Arc<Mutex<Agent>>`. Messages, system prompt and configuration are plain fields; app state, model state, invocation state and models are cheap-clone shared handles ([decision](#decision-owned-agent)).
2. **One loop.** `stream()` returns `AgentStream<'_>`, a named `Unpin` stream that runs the loop as it is polled, and `invoke()` drains it. Stream items are owned, serializable records in the TS `toJSON` shape. Dropping the stream cancels: tool tasks are aborted, history is repaired synchronously in the TS cancel shape, and async cleanup runs at the start of the next call ([decision](#decision-one-loop), [decision](#decision-drop-guard)).
3. **Two agent views.** Sequential hook events lend a mutable `LocalAgent` (TS's name) with everything TS hooks mutate. Per-tool events and `ToolContext::agent()` run inside spawned tool tasks and get a `'static` `ToolAgent`: shared state, models, sandbox, cancel, a messages snapshot, a read-only registry and `call_tool`, which runs a registry tool through the full per-tool pipeline ([decision](#decision-two-agent-views)).
4. **Tools are values-only and spawned.** A tool's stream ends in a `ToolOutcome`, a result or an interrupt. A failing tool returns an error-status result, never an `Err`. The default concurrent executor spawns each tool on its own task and turns a panicking tool into an error result ([decision](#decision-tools-return-values)).
5. **Hooks are typed, fallible and have controlled mutability.** Event fields are private with getters, and setters exist only for the fields TS lets hooks write:

   | Event | Settable fields |
   |---|---|
   | `BeforeInvocationEvent` | `messages`, `cancel` |
   | `AfterInvocationEvent` | `resume` |
   | `BeforeToolCallEvent` | `tool_use`, `cancel`, `selected_tool` |
   | `AfterToolCallEvent` | `result`, `retry` |
   | `BeforeModelCallEvent` | `cancel` |
   | `AfterModelCallEvent` | `retry` |
   | `BeforeToolsEvent` | `cancel` |
   | `AfterToolsEvent` | `end_turn` |

   `BeforeToolCallEvent` and `BeforeToolsEvent` also have `interrupt()`. Hooks run by `HookOrder`, lowest first, and callbacks with the same order run in reverse registration order on `After*` events. A callback may return `()` or a `Result`; an error fails the invocation as a TS throw does ([decision](#decision-fallible-hooks)). There are three registration forms, `add_hook`, `add_async_hook::<E>` and `add_hook_impl`, each returning a `HookCleanup` ([decision](#decision-hook-registration)).
6. **Middleware.** `add_middleware` registers Input, Output and Wrap handlers per stage (`InvokeModelStage`, `ExecuteToolStage`). A Wrap handler returns a stream of stage events ending in the stage result, the same shape as `Tool::stream`, and middleware contexts have `interrupt()`.
7. **Errors are `thiserror` enums mirroring the TS error classes**, with typed variants wherever callers branch and source chains ([decision](#decision-typed-errors)).
8. **Extension traits are object-safe.** `Model`, `Tool`, `Plugin`, `Storage`, `Sandbox`, `MemoryStore`, `ConversationManager` and `InterventionHandler` use `async-trait`, so `Arc<dyn Trait>` works. Tokio is the runtime, but no tokio types appear in public signatures ([decision](#decision-object-safe-traits)).
9. **The model request is owned.** `Model::stream(ModelRequest)` takes one owned struct, so model calls can be spawned ([decision](#decision-owned-model-request)). `Model::get_config()` returns TS's `BaseModelConfig`, and each provider adds a typed `config()` for its full configuration ([decision](#decision-model-config)).
10. **State.** App state and model state are a JSON `StateStore` with typed `get`/`set` helpers, because snapshots persist them. `InvocationState` is a typed extensions map, so callers can pass live clients and pools to tools without downcasting ([decision](#decision-typed-invocation-state)).
11. **Cancellation.** `agent.cancel_handle()` returns a cloneable `CancelHandle` whose `cancel()` takes TS's `CancelOptions` (`message`, `after_current_tools`). External signals use a Strands-owned `CancelSignal` ([decision](#decision-cancellation)).
12. **`#[tool]`.** On a function, the macro keeps the function and generates a unit struct (`get_weather` becomes `GetWeather`). `#[tools]` on an `impl` block turns its `#[tool]` methods into tools that share `Arc<Self>`. Doc comments describe parameters and input is validated against the schemars schema ([decision](#decision-tool-macro)).
13. **Defaults and lifecycle match TS.** Bedrock is the default model, resolved lazily so `build()` stays synchronous. Concurrent tools, a 40-message sliding window, the default retry strategy and the stdout printer are on by default. `Agent::shutdown().await` flushes memory and deferred cleanup ([decision](#decision-defaults-match-ts), [decision](#decision-explicit-shutdown)).

**Wire compatibility.** Messages and content blocks use the Bedrock Converse JSON shape, as both SDKs do today. Strands-owned persisted data uses TS's keys, values and storage layout: snapshots, sessions, the context archive, interrupt state, and metric and attribute names. TS and Rust agents can therefore share sessions and dashboards. TS-produced fixtures are round-tripped in Rust CI ([decision](#decision-wire-compatibility)). Event JSON uses TS's keys as well, so the same fixtures can check it, but it is not a format shared across SDKs; where Rust differs there, as with redacted reasoning bytes, it still reads what TS writes ([decision](#decision-redacted-bytes-base64)).

**Pros:**

- One mental model across Python, TypeScript and Rust, with the same names, hooks, events, sessions and telemetry.
- Rust developers get a crate that reads like Rust: builders, `Result`, traits and `#[tool]`.
- The compiler rules out bug classes that Python and TS handle at runtime: concurrent invocation, interrupts swallowed by a catch-all, and unchecked state access.
- TS-compatible persisted data lets teams mix TS and Rust agents on the same sessions.

**Cons:**

- A third SDK to keep in parity. TS-canonical names, shared fixtures and a pinned baseline make this mechanical, and parity automation is follow-up work.
- Some TS freedoms are deliberately narrower. Per-tool hooks and tools see a shared view of the agent rather than the live agent, and cannot rewrite history mid-batch.
- We own the Anthropic, OpenAI and legacy MCP SSE clients, including their retry and streaming edge cases.
- `rmcp` and the OpenTelemetry crates appear in the public API, so their semver-incompatible releases are breaking `strands` releases ([decision](#decision-mcp-rmcp-types), [decision](#decision-otel-public-versions)).

### Alternative: a literal translation of the TypeScript API

Port the TS structure as it is: subsystems compiled in unconditionally, mutable public event fields, interrupts as errors, string-typed errors, a type-erased state bag, and an `Agent` that is a cloneable handle with every field behind a lock.

- **Pros:**
  - The fastest path to a working port, with tests that map one to one onto TS.
  - The closest match to TS semantics.
- **Cons:**
  - The public API reads like TypeScript rather than Rust, and needs downcasting for state.
  - Interrupts as errors can be swallowed by a `?` or a catch-all, which the compiler cannot catch.
  - Fixing these after release is a breaking change to nearly every public type.

### Alternative: `Agent` as a cloneable shared handle

Keep the rest of the proposal but make `Agent` an `Arc<Inner>` with `&self` methods. Tools and plugins get the full agent and can mutate any part of it during a run.

- **Pros:**
  - The closest to TS semantics for tools and hooks.
  - Easy to share across tasks.
- **Cons:**
  - Every field sits behind a lock, including fields that only the loop writes.
  - Concurrent invocation is caught at runtime instead of at compile time.
  - Mid-batch mutation of messages from concurrent tools has no defined semantics in any SDK.

### Alternative: a separate repository, a shared core, or endorsing a community crate

- **Separate repository** (like Box and Shell): independent CI, but it loses side-by-side porting with TS and Python, which our parity process depends on.
- **Shared Rust or WASM core** under the Python and TS SDKs: an earlier experiment compiling the TS SDK to WASM for Python was removed in [#2838](https://github.com/strands-agents/harness-sdk/pull/2838). Keeping public types free of tokio types and fully serializable keeps a later option open.
- **Endorsing a community crate:** none matches Strands concepts or has a stability policy.

## Developer Experience

**Agent, tool and streaming**

```rust
use futures::StreamExt;
use strands::{tool, Agent, AgentStreamEvent};

/// Get the current weather for a city.
#[tool]
async fn get_weather(
    /// City name, for example "Seattle".
    city: String,
) -> Result<String, strands::ToolError> {
    Ok(format!("Sunny in {city}"))
}

#[tokio::main]
async fn main() -> Result<(), strands::Error> {
    let mut agent = Agent::builder()            // default model: Bedrock
        .system_prompt("You are a concise assistant.")
        .tools([GetWeather])
        .build()?;

    let result = agent.invoke("What's the weather in Seattle?").await?;
    println!("{result}");

    {
        let mut stream = agent.stream("And in Lisbon?");
        while let Some(event) = stream.next().await {
            if let AgentStreamEvent::ModelStreamUpdate(update) = event? {
                if let Some(text) = update.text_delta() {
                    print!("{text}");
                }
            }
        }
    }
    agent.shutdown().await
}
```

**Config struct, which mirrors TS `AgentConfig` field for field**

```rust
use strands::{Agent, AgentConfig, models::AnthropicModel};

let agent = Agent::new(AgentConfig {
    model: Some(AnthropicModel::builder().model_id("claude-sonnet-5-5").build()?.into()),
    system_prompt: Some("You are a concise assistant.".into()),
    ..Default::default()
})?;
```

**Bedrock Mantle without the Bedrock runtime SDK**

```toml
strands = { version = "0.1", default-features = false, features = ["mantle"] }
```

```rust
use strands::models::{BedrockMantleConfig, OpenAIModel, OpenAIModelOptions};

let model = OpenAIModel::bedrock_mantle(
    OpenAIModelOptions { model_id: Some("openai.gpt-oss-120b".into()), ..Default::default() },
    BedrockMantleConfig::builder().region("us-east-1").build(),
)?;
```

**Tools with state**

```rust
use std::sync::Arc;
use strands::{tools, ToolContext};

struct Inventory { db: Pool }

#[tools]
impl Inventory {
    /// Look up stock for a product.
    #[tool]
    async fn check_stock(&self, #[tool(context)] ctx: &ToolContext, sku: String) -> Result<u32, strands::ToolError> {
        let _ = ctx.agent().app_state().get::<String>("region");
        Ok(self.db.stock(&sku).await?)
    }
}

let inventory = Arc::new(Inventory { db });
let agent = Agent::builder().tools(inventory.tools()).build()?;
```

**Hooks, structured output and cancellation**

```rust
use strands::hooks::{BeforeToolCallEvent, HookCallbackOptions, HookOrder};
use strands::{CancelOptions, InvokeOptions};

agent.add_hook_with(
    |event: &mut BeforeToolCallEvent| {
        if event.tool_use().name == "shell" {
            event.set_cancel("shell is disabled");
        }
    },
    HookCallbackOptions { order: HookOrder::SDK_FIRST },
);

agent.add_async_hook::<BeforeToolCallEvent>(|event| Box::pin(async move {
    audit_log(event.tool_use()).await;
}));

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct Summary { title: String, points: Vec<String> }

let summary: Summary = agent
    .invoke_with("Summarize this thread", InvokeOptions::default().structured_output_schema::<Summary>())
    .await?
    .structured_output()?;

let cancel = agent.cancel_handle();
tokio::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    cancel.cancel(CancelOptions::default());
});
```

**Harness**

```rust
use strands::{InterruptResponse, StopReason};
use strands_harness::{create_harness, Effort, HarnessAgentOptions};

let mut agent = create_harness(
    HarnessAgentOptions::builder()
        .model("anthropic/claude-opus-5")
        .effort(Effort::High)
        .mcp_servers("./mcp.json")
        .interventions("ask")
        .build(),
)
.await?;

let mut result = agent.invoke("Fix the failing test in src/lib.rs").await?;
while result.stop_reason() == StopReason::Interrupt {
    let answers: Vec<InterruptResponse> = result.interrupts().iter().map(ask_user).collect();
    result = agent.invoke(answers).await?;
}
agent.shutdown().await?;
```

**Errors and edge cases**

- A provider whose cargo feature is disabled: `model 'anthropic/...' requires the strands-harness feature "anthropic"`.
- A model string for a provider that TS supports and this release does not (`google`, `ollama`, `litellm`): `model provider "google" is not supported in Rust yet`. An unknown provider gets the TS text, `Unknown model provider "x" in "x/y". Supported providers: ...`.
- A portable config with a module reference: `module references are not supported in Rust yet`, with `(language "typescript")` added when the reference names a language.
- A tool that panics: the model sees an error tool result and the loop continues.
- Context overflow: the conversation or context manager reduces history and retries, as in TS. Otherwise the call fails with `Error::ContextWindowOverflow`.
- Dropping a stream mid-turn: history ends with the TS cancel message, and deferred cleanup runs on the next call.

## Additional Details

<details>
<summary>TS to Rust construct mapping</summary>

| TS | Rust |
|---|---|
| `new Agent({...})` | `Agent::builder()...build()?` or `Agent::new(AgentConfig {..})?` |
| `agent.invoke(args, options?)` | `agent.invoke(args)` / `agent.invoke_with(args, options)` |
| `async *stream()` | `fn stream(&mut self, ..) -> AgentStream<'_>` (items: `Result<AgentStreamEvent>`) |
| `agent.cancel(options?)` | `agent.cancel_handle().cancel(options)` or `InvokeOptions::cancel_signal` |
| `event.agent` (`LocalAgent`) | `event.agent()` / `event.agent_mut()` on sequential events, `ToolAgent` on per-tool events |
| `addHook(Event, cb, { order })` | `add_hook` / `add_async_hook::<E>` / `add_hook_impl`, or the `*_with(.., HookCallbackOptions { order })` forms, returning `HookCleanup` |
| `tool({ name, inputSchema: z.object(..), callback })` | `#[tool]` on an `async fn`, `#[tools]` on an `impl`, or `FunctionTool::builder(..)` |
| `Tool.stream()` async generator | `Tool::stream()` returning a `Stream` that ends in `ToolOutcome` |
| `context.interrupt(params)` | `ctx.interrupt(params)?`, which returns the response on resume |
| `agent.tool.<name>.invoke()` | `agent.tool("name").invoke(input).await` |
| `AbortSignal` | `strands::CancelSignal` |
| Zod schemas | `serde` + `schemars` types |
| `Record<string, JSONValue>` state | `StateStore`, a JSON map with typed `get::<T>` / `set` helpers |
| `Record<string, unknown>` invocation state | `InvocationState`, a typed extensions map |
| `new OpenAIModel({ bedrockMantleConfig })` | `OpenAIModel::bedrock_mantle(options, mantle_config)` (feature `mantle`) |
| Optional peer dependencies | cargo features |
| `@strands-agents/sdk/context-manager` | `strands::context_manager` |
| `index.ts` barrel, `@internal` | crate root exports, `pub(crate)` / `#[doc(hidden)]` |
| `await using` / `Symbol.asyncDispose` | `shutdown().await` |

</details>

<details>
<summary>v0.1.0 scope in full</summary>

| Group | Contents |
|---|---|
| Types and wire | `Message`, the 14 content blocks (the 11 Bedrock-shaped blocks plus `InjectedBlock`, `SummaryBlock` and `UnknownBlock`, which preserves unknown blocks through a save and restore) plus `JsonBlock` in tool results, `ToolSpec`, `ToolUse`, `ToolResultBlock`, `ToolChoice`, `StopReason` (the 16 TS values plus `Other`), `Usage`, `Metrics`. Serde matches TS JSON |
| Models | `Model` trait: `stream`, `stream_aggregated`, `summarize` (client-side by default; Anthropic overrides it with server-side compaction), `get_config`/`update_config`, `model_id`, `stateful`, `model_info`, `count_tokens`, `estimate_utilization`. Providers: `BedrockModel`, `AnthropicModel`, `OpenAIModel` (Responses by default, plus Chat Completions) and Bedrock Mantle through `OpenAIModel::bedrock_mantle`. Also prompt caching (`CacheConfig`), `ModelRetryStrategy`, `DefaultModelRetryStrategy` and the backoff strategies, and `ModelRouter` with `FallbackStrategy` and `ClassifierStrategy` |
| Tools | `Tool` trait, `ToolContext`, `#[tool]` on functions and `#[tools]` on impl blocks, `FunctionTool`, `ToolRegistry`, `ConcurrentToolExecutor` (default) and `SequentialToolExecutor`, structured output, direct tool calls, `as_tool` |
| Agent | `Agent`, builder and `AgentConfig` (every TS key except experimental `checkpointing`), `invoke`/`stream`, `InvokeOptions`, `InvokeLimits`, `InvocationContext`, cancellation, `app_state`, `model_state`, `aux_model`, snapshots, background tasks, `AgentResult` with `AgentMetrics` and `AgentTrace` |
| Extension | `add_hook` with the 17 TS hook events, ordering via `HookOrder` and removal, `Plugin`, middleware (`InvokeModelStage`, `ExecuteToolStage`), interrupts, `InterventionHandler`, `HumanInTheLoop` (boolean, LLM and function classifiers), `CedarAuthorization` (feature `cedar`) |
| Context | `ConversationManager` (with proactive compression), `NullConversationManager`, `SlidingWindowConversationManager`, `SummarizingConversationManager`. In `strands::context_manager`: `ContextManager` with the `auto` and `agentic` presets, the `Offload` strategies and presets, the archive, `retrieve_context` and message pinning. Also `ContextInjector`, `AgentSkills` and `Skill` |
| Persistence and memory | Unified `Storage` (`InMemoryStorage`, `LocalFileStorage`, namespaces, `KeywordSearchStrategy`), the snapshot-based `SessionManager`, `MemoryManager` (search, add, injection, extraction triggers, `ModelExtractor`), `MemoryStore`, `FileMemoryStore` |
| Environment | `Sandbox` trait with a default local sandbox. Vended tools, all routed through the sandbox: `shell`, `read`, `write`, `edit`, `bash`, `python_repl`, `notebook`, `http_request`, `sleep`, `stop`, `handoff_to_user`, `web_fetch`, `subagent`, `mcp_router` |
| MCP | `McpClient` over stdio, streamable HTTP and SSE. Tool filters and prefixes, auth, elicitation, `load_servers`, prompts and resources, list-changed notifications, progress, logging, trace-context propagation |
| Telemetry | `tracing` spans and metrics with TS names and `gen_ai.*` attributes, including the semantic-convention opt-in modes. OTLP and console export behind the `otel` feature |
| Harness | `create_harness` and `HarnessAgentOptions` (every TS field), the harness-ts defaults, `build_system_prompt` and `HARNESS_CONTRACT`. Model strings `bedrock/`, `bedrock-mantle/`, `anthropic/` and `openai/`, plus `effort` and `caching`. Built-in tools `shell`, `read`, `write`, `edit`, `web_fetch`, `web_search` (native and Exa), `programmatic_tool_caller` (on Monty) and `subagent` (with presets). Plugins `Todos` and `EnvironmentContext`. Also the interventions grammar, `mcp_servers` (a path or an inline map), sessions, skills and memory, and portable `HarnessAgentConfig` parsing |

Later v0.x releases add multi-agent (Graph, Swarm, A2A and their vended tools); the `ContextOffloader` plugin, GoalLoop, steering and checkpointing; decision models and the decision-model HITL classifier; Docker and SSH sandboxes and OS-level sandboxing; S3 storage, vector search and embeddings, and the Bedrock Knowledge Base memory store; MCP tasks; the Google, Ollama, LiteLLM and Vercel providers; and module references in portable config. `MessageUpdatedEvent` follows when TS adds it.

Not ported: bidirectional streaming, until TS has it; TS APIs marked `@deprecated`; `configureLogging`, which `tracing` subscribers replace; and Python-only constructs (sync facades, dict events, module and directory tool loading, legacy session managers, and the `EventLoopThrottleEvent`, `ForceStopEvent` and `StructuredOutputEvent` events).

</details>

<details>
<summary>Behaviour contracts an implementation must preserve</summary>

The normative spec is strands-ts and harness-ts at `d6c5fae7c`, plus their tests. These are the items that are easiest to miss.

- **Loop.** The assistant tool-use message is appended only after its tools finish, so history is always re-invokable. The retry strategy sleeps inside an `AfterModelCallEvent` hook, and `attempt_count` resets when the router switches models. Limits are checked in the order turns, total tokens, output tokens, structured-output attempts. `AfterInvocationEvent.resume` re-enters the loop and is ignored on error or when a limit is hit.
- **Plugins.** Registration order is fixed: router, conversation manager, retry strategies, user plugins, background tasks, delegation, memory, context manager, session manager, then the model plugin.
- **Stateful models.** These force `NullConversationManager`, discard restored messages, and reject explicit conversation or context managers.
- **Tool schemas.** schemars output is normalized: subschemas are inlined unless the type is recursive; `$schema` and `title` are dropped; non-JSON-Schema formats such as `uint32` and `double` are dropped; property order is kept; names must match `^[a-zA-Z0-9_-]{1,64}$`.
- **Interrupt IDs** follow TS (`tool:<toolUseId>:<name>`, `hook:beforeToolCall:<toolUseId>:<name>`, and so on). On resume, completed sibling results come from `pendingToolExecution`.
- **Persisted layout.** Snapshot keys are `<sessionId>/scopes/<scope>/<scopeId>/snapshots/{snapshot_latest.json,manifest.json,immutable_history/snapshot_<uuidv7>.json}`. IDs match `^[a-z0-9_-]+$`. The archive's `storageType` uses the TS class names (`LocalFileStorage`, `InMemoryStorage`).
- **Telemetry.** Span names are `invoke_agent <name>`, `execute_agent_loop_cycle`, `chat` and `execute_tool <tool>`. Metric names are `gen_ai.agent.*`, `gen_ai.server.time_to_first_token`, and so on. The `OTEL_SEMCONV_STABILITY_OPT_IN` modes apply, and the legacy usage keys are duplicated.
- **Harness.** The byte-observable parts follow harness-ts: system prompt assembly; tool-name collision rules, where `-` and `_` count as equal; `read`, `edit` and `todos` text; `EnvironmentContext` discovery limits; programmatic tool caller limits; `web_fetch` caps and its URL cache; and session id sanitization.

</details>

<details>
<summary>Dependencies and quality bar</summary>

| Concern | Crates |
|---|---|
| Async | `tokio`, `futures`, `async-stream`, `async-trait`, `tokio-util` (internal only) |
| Data | `serde`, `serde_json`, `schemars`, `jsonschema`, `http` (extensions), `uuid` (v7), `base64`, `jiff` |
| Errors and builders | `thiserror`, `bon` |
| Bedrock and Mantle | `aws-sdk-bedrockruntime` (`bedrock` only), `aws-config`, `aws-sigv4` |
| HTTP providers and tools | `reqwest`, `eventsource-stream`, `htmd` |
| MCP | `rmcp` |
| Telemetry | `tracing`, `opentelemetry`, `opentelemetry_sdk`, `tracing-opentelemetry`, `opentelemetry-otlp` |
| Policy and scripting | `cedar-policy`, `dogwood-ops`, `monty` |
| Macros | `syn`, `quote`, `darling` |

Anthropic and OpenAI publish no official Rust SDKs, so their providers are thin clients on `reqwest` and `eventsource-stream`, with the transport behaviour of the official TS SDKs that strands-ts uses ([decision](#decision-own-http-providers)). The MCP legacy SSE transport is a small custom transport on `rmcp`'s `Transport` trait, because `rmcp` ships no legacy SSE client. The Mantle bearer token is a SigV4-presigned `CallWithBearerToken` URL, minted the same way as AWS's TS token generator. `cargo-deny` allows the BlueOak-1.0.0 licence for `minicbor` and `minicbor-serde` and ignores the unmaintained-crate advisory RUSTSEC-2023-0089 (`atomic-polyfill`); both reach `strands-harness` only through Monty.

The crates use edition 2024 with MSRV 1.96 ([decision](#decision-msrv)). CI runs `cargo fmt`, clippy with selective pedantic denies, tests with all and with no default features, `cargo doc -D warnings`, an MSRV job, `cargo-deny`, and `cargo-semver-checks` once the first version is published. Every documentation snippet is a compiled doctest. Tests mirror the TS specs they port and name them. A scripted mock model ships in a public `strands::testing` module. Live provider tests are `#[ignore]` and gated on environment variables.

</details>

<details>
<summary>Implementation status</summary>

The implementation of this design is in the same PR, with its commits grouped by area. At the TypeScript baseline:

- 5,203 tests pass with all features, doctests included.
- Of the 5,032 test cases in the in-scope strands-ts spec files, 4,326 are ported. Each remaining case has a recorded reason: a compile-time guarantee, a JS-only mechanism, a deprecated API, or a feature outside v0.1.0. For harness-ts, 430 of 502 cases are ported.
- TS-generated fixtures round-trip byte for byte. They cover messages, model and agent stream events, hook events, snapshots, session files, interrupt state, the archive, metrics, the vended and harness tool specs, and the harness system prompt.
- A TS-written session is restored by Rust and a Rust-written one by TS, for both the SDK and the harness.
- Live tests pass against Bedrock, Bedrock Mantle, Anthropic and OpenAI, including the harness on each provider.
- The implementation keeps a divergences list for the places where Rust intentionally differs from TS, and the TS bugs it found will be reported as separate issues.

Windows-specific paths (PowerShell execution, process handling, drive-prefix checks) are type-checked and get their first full run in CI.

</details>

## Decisions

The decisions that shape the public API, each with its reason and the main alternative considered. Code and docs link to these headings, so the headings are stable.

### Scope and parity

#### Decision: monorepo layout

**Decision.** The Rust SDK and harness live in this monorepo as `strands-rs/` and `harness-rs/`, under a root virtual cargo workspace with one `Cargo.lock`. There are three crates: `strands` (with providers, MCP, OpenTelemetry and Cedar as cargo features), `strands-macros` and `strands-harness`.

**Reason.** Side-by-side porting with TS and Python is how the SDKs stay in parity, and cargo needs a single workspace root above every member crate. Features instead of per-provider crates keep one version to depend on, and a disabled feature drops its dependencies.

**Alternative considered.** A separate repository, like Box and Shell, with independent CI; or one crate per provider. The first loses side-by-side porting, and the second adds versions to align with no benefit while every provider ships with the core.

#### Decision: TS canonical names

**Decision.** TypeScript is canonical for concepts and names. Every public type, function, parameter, hook event and config key that exists in TS exists in Rust under the same words, re-cased for Rust. Idiomatic extras are allowed, as Python has `@tool`.

**Reason.** Users and coding agents get one mental model across SDKs, and docs and parity checks can map names mechanically.

**Alternative considered.** Rust-first names where they read better. Every renamed concept is a lookup for users moving between SDKs.

#### Decision: prelude clash renames

**Decision.** A TS name changes only when it clashes with the Rust prelude. The only case is the harness subagent `Option` class, which becomes `ChoiceOption`.

**Reason.** `Option` would shadow `std::option::Option` in every module that imports it.

**Alternative considered.** Keeping `Option` and relying on paths, which is error-prone in user code that also uses `Option<T>`.

#### Decision: observable parity

**Decision.** Rust matches TS byte for byte only where the result is observable across SDKs: wire formats, persisted data, prompts and the error text that cross-SDK tests check. Everything else is Rust-native, for example slicing strings by `char` rather than by UTF-16 code unit.

**Reason.** Byte identity where data crosses SDKs is what lets sessions and dashboards interoperate. Copying JS internals elsewhere would make the Rust API worse with no user benefit.

**Alternative considered.** Byte identity everywhere, including log text and JS string semantics.

#### Decision: no deprecated or Rust-only APIs

**Decision.** Rust adds no features that TS lacks and leaves out TS APIs marked `@deprecated`. Small idiomatic accessors, such as `text_delta()` on a stream update, are allowed.

**Reason.** A new SDK has no users to migrate, and a Rust-only feature would make Rust the reference for it.

**Alternative considered.** Porting deprecated APIs for completeness, which would ship them deprecated on arrival.

#### Decision: TS baseline

**Decision.** The spec is strands-ts and harness-ts at commit `d6c5fae7c`, plus their tests. Parity is measured against that commit, and later TS changes are follow-up work. Nothing lands in TS only to make the Rust port easier.

**Reason.** A fixed baseline makes parity checkable, and this proposal leaves Python and TypeScript unchanged.

**Alternative considered.** Tracking TS `main` during the initial port, which moves the target faster than parity can be checked.

#### Decision: TS bugs fixed in Rust

**Decision.** When porting finds a TS bug, Rust implements the intended behaviour, records the divergence in the crate's divergences list, and the bug is reported against TS. Cross-SDK wire and persisted formats stay interoperable.

**Reason.** Shipping a known bug in a new SDK only to match TS creates work to undo later.

**Alternative considered.** Reproducing TS bugs for strict parity.

#### Decision: v0.1 scope

**Decision.** v0.1.0 includes the harness but no Rust CLI; `strands-cli` stays TypeScript. It includes `CedarAuthorization`, `HumanInTheLoop` with its classifiers, `web_search` in native and Exa modes, the MCP SSE transport, prompts, resources and notifications, background tasks, memory extraction, middleware, `HookOrder` and the vended tools. Graph, Swarm, A2A, MCP tasks, checkpointing, decision models, and the S3, vector and Bedrock Knowledge Base stores follow in later v0.x releases. Bidirectional streaming waits for TS. `MessageUpdatedEvent` arrives when TS adds it, and the Python-only `EventLoopThrottleEvent`, `ForceStopEvent` and `StructuredOutputEvent` are not ported.

**Reason.** The first release covers what a single agent and the harness need, at TS parity, before adding multi-agent features.

**Alternative considered.** Holding the first release until multi-agent is ported.

#### Decision: context manager

**Decision.** `ContextManager` with the `auto` and `agentic` presets, the `Offload` strategies, the archive and `retrieve_context` ship in v0.1.0 in `strands::context_manager`, as TS exports them from its `context-manager` entry point. The `agentic` mode and deferred tool loading are marked experimental in their docs, as in TS. The harness defaults to `auto`. The `ContextOffloader` plugin comes later.

**Reason.** The harness-ts default depends on it.

**Alternative considered.** Deferring context management, which would make the Rust harness defaults differ from harness-ts.

#### Decision: sandbox seam

**Decision.** v0.1.0 ships the `Sandbox` trait and a local sandbox, and routes every vended and built-in tool through it. Docker, SSH and OS-level sandboxes come later.

**Reason.** Later sandboxes plug into the seam without changing any tool.

**Alternative considered.** Tools that call the OS directly in v0.1.0, which would make adding sandboxes a breaking change.

### Packaging and dependencies

#### Decision: v0.1 providers

**Decision.** The v0.1.0 providers are Bedrock, Bedrock Mantle (through `OpenAIModel`), Anthropic and OpenAI. Harness model strings are `bedrock/`, `bedrock-mantle/`, `anthropic/` and `openai/`. Google, Ollama, LiteLLM and Vercel come later, and their model strings return a "not supported in Rust yet" error.

**Reason.** Each provider is a dedicated client in Rust, so v0.1.0 starts with the default provider and three widely used APIs, and adds others behind the same `Model` trait.

**Alternative considered.** Every TS provider in the first release.

#### Decision: Mantle feature

**Decision.** Bedrock Mantle has its own cargo feature, `mantle`, which enables `openai` plus the AWS signing and credential crates (not the Bedrock runtime SDK). Mantle is built with `OpenAIModel::bedrock_mantle(options, BedrockMantleConfig)`, and `OpenAIModelOptions` has no Mantle field. `openai` alone pulls in no AWS crates. `strands-harness` enables `mantle` by default.

**Reason.** Cargo features must be additive: turning a feature on anywhere in the dependency graph must not break code that compiled without it. A feature-gated field on an exhaustive options struct breaks that, because a struct literal or pattern naming every field stops compiling once another crate turns the feature on. A constructor keeps `OpenAIModelOptions` identical under every feature set. TS can put `bedrockMantleConfig` in the options because an optional peer dependency doesn't change the type. A separate feature also keeps the AWS stack, about 80 extra crates, out of OpenAI-only builds.

**Alternative considered.** Mantle inside `openai` with the field always present, so every OpenAI user compiles the AWS crates; or the field gated on a feature, which makes features non-additive.

#### Decision: own HTTP providers

**Decision.** The Anthropic and OpenAI providers are thin clients on `reqwest` and `eventsource-stream`. Their transport matches the official TS SDKs that strands-ts uses: 2 retries on connection errors, 408, 409, 429 and 5xx; the `x-should-retry` and `retry-after` headers are honoured; exponential backoff from 0.5 s to 8 s; a 10-minute timeout. Above that layer, errors map as in strands-ts: only 429 and rate-limit codes become `ModelThrottledError`, context-overflow messages become `ContextWindowOverflowError`, and transport failures become `ModelNetworkError`.

**Reason.** Neither vendor publishes an official Rust SDK, and matching the TS SDKs' transport keeps retry behaviour the same across SDKs. We would switch to an official SDK behind the same provider type if one appears.

**Alternative considered.** A community client crate per vendor, whose retry, streaming and error behaviour we wouldn't control.

#### Decision: Bedrock Converse JSON body

**Decision.** `BedrockModel` builds the request as Converse JSON, the same object strands-ts hands its AWS SDK, and sends it through the AWS SDK for Rust with only `modelId` typed, replacing the body before signing so SigV4 signs it and every retry resends it. Responses stay typed in the SDK for event-stream decoding and are converted back to Converse JSON, so the TS event and error mapping applies unchanged.

**Reason.** The AWS SDK for Rust models JSON documents (tool schemas, tool inputs, JSON tool results, `additionalModelRequestFields`) as hash maps, so a request rebuilt on each call serializes object keys in a different order every time. Anthropic models on Bedrock normalize key order before the model sees it, but other model families (Nova Lite, measured) see the order as sent, so the same input would produce a different prompt on every call.

**Alternative considered.** Typed SDK requests, with non-deterministic key order; or calling Bedrock over raw HTTP with SigV4, which loses the SDK's retries, endpoint resolution and event-stream decoding.

#### Decision: dependency features

**Decision.** Dependencies are popular, well-maintained crates. `reqwest` and `htmd` are non-optional dependencies of `strands`, because the vended `http_request` and `web_fetch` tools are always present, as in TS. Cedar (`cedar-policy`, `cedar-policy-mcp-schema-generator`, `mcp-tools-sdk`) is behind the non-default `cedar` feature, mirroring TS's optional Cedar peer dependencies, and `strands-harness` enables it for its Cedar intervention grammar. `monty` is a dependency of `strands-harness` only. The workspace uses cargo's MSRV-aware resolver.

**Reason.** Features follow TS: optional where TS has optional peer dependencies, always on where TS always ships the code.

**Alternative considered.** A feature per vended tool, which multiplies the feature combinations to test for a small dependency saving.

#### Decision: public dependencies

**Decision.** `strands` depends on `strands-macros` at an exact version, and the two crates release in lockstep. `strands-harness` uses a caret requirement on `strands`, because it uses only the public API. The crate docs list the crates whose types appear in the public API: `serde_json`, `schemars`, `futures` and `async-trait` always; the AWS credential and config types with `bedrock` or `mantle`; `regex` and `rmcp` with `mcp`; and the OpenTelemetry crates with `otel`. A semver-incompatible bump of any of them is a breaking `strands` release. The `monty` crates are pinned exactly, because the worker binary must speak the same protocol release, and none of their types is public.

**Reason.** Macro expansions call a private, non-semver module of `strands`, so mismatched versions would fail to compile. Listing the coupled crates makes the semver contract explicit.

**Alternative considered.** A caret requirement on `strands-macros` with a stable expansion API, which adds surface to keep stable with no user benefit.

#### Decision: Cedar engine

**Decision.** `CedarAuthorization` uses `cedar-policy` pinned to `=4.14.0`, the engine version TS runs, through its JSON `ffi` interface fed the same JSON TS builds, so decisions, deny details and error messages match TS byte for byte. Tool schema generation uses `cedar-policy-mcp-schema-generator` 0.7 and `mcp-tools-sdk` 0.5, which produce the same schemas as TS. The pin moves whenever the generator does.

**Reason.** The generator pins `cedar-policy-core` exactly, and only `cedar-policy` 4.14.0 uses that core; any other version compiles a second core whose policy types don't match the generator's.

**Alternative considered.** The native `cedar-policy` API, whose error texts differ from TS; or leaving out schema generation, which TS supports.

#### Decision: MCP rmcp types

**Decision.** The MCP escape hatches return `rmcp` types, as TS returns the vendor SDK's: raw prompt and resource results, and the live client from `client()`. `call_tool` returns the raw result as `JsonValue`. `strands::mcp::rmcp` re-exports the crate, and an `rmcp` major bump is a breaking `strands` release. Server logs reach the log handler as the Strands-owned `McpLogMessage`.

**Reason.** This is the same coupling TS has, and wrapping every MCP type would duplicate the protocol model.

**Alternative considered.** Strands-owned wrappers for every MCP result type.

#### Decision: MSRV

**Decision.** Edition 2024 and MSRV 1.96. The MSRV never drops below what required dependencies declare (`monty` requires 1.96, the current AWS SDK 1.94.1), and it moves only in minor releases.

**Reason.** Required dependencies set the floor, and tying MSRV moves to minor releases makes them predictable.

**Alternative considered.** A lower MSRV with older dependency versions.

#### Decision: conservative code

**Decision.** Public APIs never require `Any`, `TypeId` or downcasting. Library code has no `unwrap`, `expect`, `panic` or `unsafe`, and CI runs clippy with selective pedantic denies.

**Reason.** Services that embed the SDK need it never to abort their process, and typed APIs without downcasting catch misuse at compile time.

**Alternative considered.** Allowing `expect` on internal invariants, where a mistake takes down the host process.

### Construction and types

#### Decision: exhaustive config structs

**Decision.** Plain config and option structs (`AgentConfig`, `InvokeOptions`, `HarnessAgentOptions`, provider configs) have public fields, `Default` and a builder whose methods match the TS keys in snake_case. The builder is the primary API. Enums, events, errors, results and wire structs are `#[non_exhaustive]`, and wire structs get constructors.

**Reason.** `#[non_exhaustive]` on a struct forbids `..Default::default()` construction from other crates (E0639), which is the natural Rust spelling of a TS options object. Types users only read can then grow without breaking them.

**Alternative considered.** `#[non_exhaustive]` everywhere, with builders as the only construction path.

#### Decision: interrupt params construction

**Decision.** `InterruptParams` and other caller-input structs with a required field are `#[non_exhaustive]` and have one construction path: `InterruptParams::new(name)`, `with_reason` and `with_response`, and `From<&str>` and `From<String>`. They have no `Default`. This is a documented exception to the exhaustive config-struct rule.

**Reason.** An empty name is not valid, so `Default` would build an invalid value. A single constructor lets fields be added without breaking callers.

**Alternative considered.** An exhaustive struct with public fields and a builder.

#### Decision: typed errors

**Decision.** Errors are `thiserror` types mirroring the TS error classes, wrapped by a `#[non_exhaustive]` `strands::Error` with one variant per class and `strands::Result<T>`. They have typed variants wherever callers branch, source chains, and `Error::name()` returning the TS `error.name`. `ConcurrentInvocationError` has no Rust equivalent because it cannot happen.

**Reason.** Callers branch on the same error kinds in every SDK, such as context overflow and throttling.

**Alternative considered.** A single string-carrying error type, or `anyhow` in public signatures.

#### Decision: object-safe traits

**Decision.** Extension traits (`Model`, `Tool`, `Plugin`, `Storage`, `Sandbox`, `MemoryStore`, `ConversationManager`, `InterventionHandler`) use `async-trait`, so `Arc<dyn Trait>` works. Streams are `futures::Stream`. Tokio is the runtime, but no tokio or tokio-util types appear in public signatures. `SessionManager` is a concrete type, as in TS.

**Reason.** Stable Rust cannot yet call native `async fn` in traits through `dyn`. Keeping tokio out of signatures keeps runtime and shared-core options open.

**Alternative considered.** Native async traits with generics, which rule out mixed tool lists and models chosen at runtime.

#### Decision: typed invocation state

**Decision.** `InvocationState` is a typed extensions map, following the `http::Extensions` pattern. App state and model state stay a JSON `StateStore` with typed `get` and `set` helpers.

**Reason.** TS users pass live values such as clients and pools through `Record<string, unknown>`, and a typed map carries them without downcasting in user code. App state must stay JSON because snapshots persist it.

**Alternative considered.** A JSON-only invocation state, which cannot carry live values.

#### Decision: owned model request

**Decision.** `Model::stream(ModelRequest)` takes one owned struct holding messages, system prompt, tool specs, tool choice, the structured-output schema, the model state, agent metadata and the cancel signal. Providers write to a copy of the model state, for example the OpenAI Responses `responseId`, and the agent commits it only when the call succeeds, as TS does.

**Reason.** An owned request lets model calls be spawned and streamed without borrowing the agent.

**Alternative considered.** Borrowed arguments, which tie the model stream's lifetime to the agent.

#### Decision: model config

**Decision.** `Model::get_config()` returns `BaseModelConfig` (`model_id`, `max_tokens`, `temperature`, `top_p`, `context_window_limit`, `model_info`), and `update_config(&self, BaseModelConfig) -> Result<()>` shallow-merges through an internal lock. A provider can reject an invalid update, such as a base URL on a Mantle model, and then leaves its config unchanged. Each provider also has a typed `config()` and `update_config()` for its full configuration.

**Reason.** The agent, the aux model and routers share models, so updates go through `&self`.

**Alternative considered.** `get_config() -> serde_json::Value`, which loses typing for the shared fields; or a config type parameter on `Model` like TS's `Model<T>`, which rules out `dyn Model`.

#### Decision: model helpers public

**Decision.** The default bodies of `Model` methods are public functions in `strands::models`: `base_model_info`, `estimate_tokens`, `summarize_client_side`, `ModelInfo::merge` and `BaseModelConfig::merge`. Helpers that TS marks `@internal`, such as the model info lookups, stay crate-internal.

**Reason.** A TS provider subclass reaches the defaults through `super`. Rust has no `super`, so a provider outside the crate that overrides a method needs the default as a function it can call.

**Alternative considered.** Keeping the helpers private, so custom providers reimplement them, or putting them behind an unstable feature.

### Agent and loop

#### Decision: owned agent

**Decision.** `Agent` is owned and its methods take `&mut self`. It has no `Clone` handle. Calling the agent while an invocation runs is a compile error. Callers that share an agent wrap it in `Arc<Mutex<Agent>>`.

**Reason.** The borrow checker enforces one invocation at a time, with no locks on fields only the loop writes.

**Alternative considered.** A cloneable `Arc<Inner>` handle with `&self` methods (see the main alternatives).

#### Decision: one loop

**Decision.** `stream()` returns `AgentStream<'_>`, a named `Unpin` stream that runs the loop as it is polled, and `invoke()` drains it. Stream items are owned, serializable event records in the TS `toJSON` shape; hook callbacks receive the live event instead.

**Reason.** Two loops drift. Serializable items let services forward events the same way TS services do.

**Alternative considered.** Separate loops for `invoke` and `stream`, or a callback-only event API.

#### Decision: drop guard

**Decision.** Dropping the stream cancels the invocation. Tool tasks are aborted, and a guard inside the loop repairs history synchronously in the TS cancel shape, so history stays re-invokable. Async cleanup (`AfterInvocationEvent`, unfinished `MessageAddedEvent`s, session saves) is recorded and runs at the start of the next `invoke`, `stream` or `shutdown`, resuming at the callback the drop interrupted.

**Reason.** Rust has no async `Drop`, and the stream borrows the agent, so cleanup cannot be spawned. TS closes the turn only on its cancel path, so a consumer that stops iterating without cancelling leaves a trailing user turn there; the Rust guard closes it in both cases.

**Alternative considered.** Requiring an explicit cancel before dropping a stream, which leaves the abandoned request open after a forgotten cancel, so the next call answers it along with the new one.

#### Decision: explicit shutdown

**Decision.** `Agent::shutdown().await` flushes memory and runs any deferred cleanup, as TS's dispose does, and does not disconnect MCP clients. `McpClient::disconnect().await`, or dropping the client, ends its transport. Dropping an agent that still has pending shutdown work logs a warning.

**Reason.** Rust has no `await using` or async `Drop`. Warning only when work is pending catches a forgotten flush without noise.

**Alternative considered.** Warning on every drop without `shutdown()`, or blocking inside `Drop`.

#### Decision: two agent views

**Decision.** Sequential hook events (`InitializedEvent`, invocation, model, `BeforeToolsEvent` and `AfterToolsEvent`, message, result and interrupt events) lend a mutable `LocalAgent` with messages, system prompt, model, aux model, tool registry, app state and model state. Per-tool events (`BeforeToolCallEvent`, `AfterToolCallEvent`, `ToolStreamUpdateEvent`, `ToolResultEvent`) and `ToolContext::agent()` get a `'static`, cloneable `ToolAgent` with id, name, session id, sandbox, app state, model state, model and aux model, cancel, a messages snapshot, a read-only tool registry, and `call_tool`, which runs a registry tool through the full per-tool pipeline (hooks, interventions, middleware).

**Reason.** Per-tool code runs on spawned tasks alongside its siblings, so it cannot borrow the agent mutably, and mid-batch history mutation from concurrent tools has no defined semantics in any SDK. Durable writes from tools go through the shared state store. `call_tool` replaces the private-registry access that the TS programmatic tool caller uses.

**Alternative considered.** Giving tools the live agent behind a lock, as in the cloneable-handle alternative.

#### Decision: inner call interrupts

**Decision.** Inside a tool call, `ToolAgent::call_tool` gives each inner call a stable id, `<outerToolUseId>:call:<n>`, counted from 0 for each run of the outer tool and nested for nested calls, and returns `Result<ToolResultBlock, InterruptError>`. An inner interrupt is also recorded on the outer call, which ends as an interrupt even if the tool ignores the error. On resume the outer tool runs again, and its inner calls find their stored responses. A direct tool call (`agent.tool(..)`) still turns an interrupt into an error result.

**Reason.** Without stable ids, an approval asked for on an inner call, such as a human-in-the-loop confirmation, could never be answered.

**Alternative considered.** Always refusing inner approvals, as the TS programmatic tool caller does. Rust keeps that behaviour as a separate method for the callers that need it.

#### Decision: call tool without interrupts

**Decision.** `ToolAgent::call_tool_without_interrupts(name, input, refusal)` runs the per-tool pipeline on a detached interrupt state, so any interrupt comes back in a `RefusedCall` error without being recorded on the calling tool or registered with the agent. Saved responses don't answer it, and a preemptive `InterruptParams::with_response` still does. When a before-call hook or intervention asks for approval, the call ends with an error result carrying the caller's `refusal` text, and `AfterToolCallEvent` fires with it, as TS `gateInnerCall` does; the `RefusedCall` carries the result the after hooks left. The harness `programmatic_tool_caller` uses it and passes the TS refusal text.

**Reason.** The programmatic tool caller runs model-written code with side effects, and rerunning it on resume would repeat them, so it refuses inner approvals as TS does.

**Alternative considered.** A `CallToolOptions` struct on `call_tool`; a separately named method makes the refusal behaviour visible at the call site.

#### Decision: agentic context working copy

**Decision.** The agentic context tools (`summarize_context`, `truncate_context`, `pin_context`) edit a shared working copy of history under an async lock, so concurrent agentic tools see each other's edits, as TS runs them against one array. An `AfterToolsEvent` hook at `HookOrder::SDK_FIRST` installs the copy, before an interrupt can stop the turn, so edits are in the history a session saves. The install checks that history still ends with the message the copy started from, and otherwise drops the edit with a warning.

**Reason.** Tools see a snapshot rather than live history. A working copy keeps the TS editing semantics (the same messages counted, the same pin positions) without letting tools mutate the agent.

**Alternative considered.** Letting these tools mutate history directly, which breaks the two-view model, or leaving them out.

#### Decision: tools return values

**Decision.** A tool's stream ends in a `ToolOutcome`: a completed `ToolResultBlock` or an interrupt. A failing tool returns an error-status result, never an `Err`. Tool futures are `'static`. The default `ConcurrentToolExecutor` spawns each tool on its own task, keeps per-tool event order, lets siblings finish before an interrupt propagates, and turns a panicking tool into an error result. `SequentialToolExecutor` is opt-in.

**Reason.** Values make interrupts explicit where TS uses an exception. Spawning gives real parallelism for blocking or CPU-heavy tools, which polling every tool on one task does not.

**Alternative considered.** `Result<ToolResultBlock, ToolError>` with interrupts as an error variant, which is easy to swallow by accident; or polling every tool on one task.

#### Decision: tool macro

**Decision.** `#[tool]` on an `async fn` keeps the function and generates a unit struct (`get_weather` becomes `GetWeather`). The model-facing name is the function name, and `#[tool(name = "..")]` overrides it. Doc comments describe parameters, `#[tool(context)]` marks the `&ToolContext` parameter, and input is validated against the schemars schema before the call. `#[tools]` on an `impl` block generates `X::<method>_tool(self: &Arc<Self>)` for each `#[tool]` method and `X::tools(self: &Arc<Self>)` for all of them. `.tools(..)` takes anything convertible to `ToolSource` (a tool, an `McpClient`, an `Agent` or a list), with `tool_list![..]` for mixed lists. `ToolError` works like `anyhow::Error`, and `ctx.interrupt(..)?` is the only place an interrupt converts into a tool outcome.

**Reason.** A unit struct reads as a value (`[GetWeather]`) with no constructor call. A single conversion point means a tool can't swallow an interrupt by accident.

**Alternative considered.** A generated constructor function (`get_weather_tool()`), which adds a call and a second naming convention. Methods do get constructors, because they need the receiver.

#### Decision: hook event mutability

**Decision.** Hook events keep the TS names, are `#[non_exhaustive]`, and have private fields with getters. Setters exist only for the fields TS lets hooks write (see the table in Core API). Middleware stays alongside hooks.

**Reason.** Setters document exactly what a hook can affect, and the loop re-reads only those fields.

**Alternative considered.** Public mutable fields as in TS, where a hook can change a field the loop never reads back.

#### Decision: hook registration

**Decision.** Three registration forms ship: `add_hook` takes a plain closure, `add_async_hook::<E>` takes a closure returning `Box::pin(async move {..})`, and `add_hook_impl` takes a `Hook<E>` trait implementation for reusable or stateful hooks. Each has a `*_with(.., HookCallbackOptions { order })` form, and `HookOrder` holds the order constants. Registration returns a `HookCleanup` whose `remove()` is idempotent; dropping it keeps the hook.

**Reason.** Plain async closures can't be proven `Send` on stable Rust, and a closure returning an `async move` block can't borrow the event. These three forms compile on stable, run on a multi-threaded runtime, and can mutate the event. `add_async_hook` can move to plain async closures later without a breaking change.

**Alternative considered.** A `hook!` macro that hides the three-way split, left for a later release so it can be designed against real usage; and inferring the async hook's event type from the closure argument, which fails because the returned future's lifetime can't be inferred.

#### Decision: fallible hooks

**Decision.** Hook closures may return `()` or `Result<(), E>` for any error convertible to `BoxError`, and `Hook::handle` returns `Result<(), BoxError>`. An error fails the invocation at once and skips the remaining callbacks, as a TS throw does. Interrupts are not failures: `event.interrupt(..)` returns `Result<JsonValue, InterruptError>`, interrupts are collected across every callback and deduplicated by id, and the agent stops for them after all callbacks ran. A hook panic propagates.

**Reason.** TS hooks signal both failure and interrupts by throwing. Rust needs a typed channel for each, and keeping them apart preserves the TS rule that every callback sees the event before the agent stops for an interrupt.

**Alternative considered.** Infallible hooks, with failures reported through a panic or a side channel on the event. That loses `?` in hooks and makes a failing hook look like a bug.

#### Decision: cancellation

**Decision.** `agent.cancel_handle()` returns a cloneable `CancelHandle` whose `cancel()` takes TS's `CancelOptions` (`message`, `after_current_tools`). External signals use the Strands-owned `CancelSignal`, passed as `InvokeOptions::cancel_signal`. Cancellation follows TS: checkpoints, synthetic cancelled tool results, and the final assistant message.

**Reason.** The running stream mutably borrows the agent, so cancellation needs a separate handle. A Strands-owned signal keeps tokio-util types out of the public API.

**Alternative considered.** Exposing `tokio_util::sync::CancellationToken` directly.

#### Decision: defaults match TS

**Decision.** Defaults match TS. Bedrock is the default model, resolved lazily so `build()` stays synchronous. Concurrent tool execution, sliding-window conversation management at 40 messages, `DefaultModelRetryStrategy` and the stdout printer are on by default, and services turn the printer off with `.printer(false)`. The null and summarizing conversation managers also ship.

**Reason.** The same configuration behaves the same in every SDK.

**Alternative considered.** Turning the printer off by default for Rust, which would give Rust a different first-run experience from Python and TS.

### Wire data and telemetry

#### Decision: wire compatibility

**Decision.** Strands-owned persisted data uses TS's keys, values and storage layout: snapshots, sessions, the context archive, interrupt state, and metric and attribute names. Event JSON uses TS's keys too, so TS-produced fixtures can check it. Messages and content blocks use the Bedrock Converse JSON shape. Key order is part of the format, so `serde_json` and `schemars` use `preserve_order`. JavaScript moves integer-like keys to the front of an object, so a freshly built object with such keys can order them differently in Rust; stored data round-trips unchanged. Shared TS-produced fixtures round-trip in Rust CI.

**Reason.** TS and Rust agents can share sessions and dashboards.

**Alternative considered.** Rust-native snake_case serialization, which would need a conversion layer to interoperate.

#### Decision: redacted bytes base64

**Decision.** In stream-event JSON, redacted reasoning bytes are written as base64, the encoding Rust and TS both use for the same bytes in messages and content blocks. Rust also reads a byte array and the index-keyed object TS writes today ([#6422](https://github.com/strands-agents/harness-sdk/issues/6422)).

**Reason.** One encoding per field within the SDK. TS `ModelStreamUpdateEvent.toJSON()` passes a `Uint8Array` to `JSON.stringify`, which writes `{"0":1,"1":2,...}`, while its later events in the same run write the same bytes as base64. This affects stream-event JSON only, not persisted data.

**Alternative considered.** Reproducing the index-keyed object for byte identity.

#### Decision: telemetry tracing

**Decision.** Telemetry uses `tracing` spans and metrics with the TS span names, metric names and `gen_ai.*` attributes, including the semantic-convention opt-in modes. OTLP and console export are behind the `otel` feature.

**Reason.** `tracing` is what Rust applications already use, and the shared names keep dashboards working across SDKs.

**Alternative considered.** Emitting OpenTelemetry directly, which doesn't compose with an application's existing `tracing` subscriber.

#### Decision: setup tracer

**Decision.** With `otel`, `setup_tracer` registers the global tracer provider (and the W3C trace-context and baggage propagators when it built the provider) and returns a `TracerGuard`. It does not install a global `tracing` subscriber: `TracerGuard::layer()` returns the layer to add to the application's subscriber, and `try_init_subscriber()` installs one in a single call. `setup_meter` returns a `MeterGuard`. Dropping a guard flushes, and a second call logs the TS warning and returns a guard for the registered provider.

**Reason.** In Rust the application owns the global subscriber, and a library that takes it conflicts with the application's own logging.

**Alternative considered.** Installing the subscriber, the way TS registers its providers.

#### Decision: OTel public versions

**Decision.** OpenTelemetry types appear directly in the `otel` API with no Strands-owned wrappers, and `strands::telemetry` re-exports `opentelemetry`, `opentelemetry_sdk`, `tracing_opentelemetry` and `tracing_subscriber`. A release that moves any of the OpenTelemetry crates to a semver-incompatible version is a breaking `strands` release; patch updates are not.

**Reason.** Users pass these types to and from their own OpenTelemetry setup, which wrappers would block. The re-exports keep versions matched.

**Alternative considered.** Wrapping every OpenTelemetry type.

### Harness

#### Decision: harness session layout

**Decision.** The harness writes its default sessions through `LocalFileStorage::new("./.agent").namespace("sessions")`, which gives the same paths as harness-ts's default (the deprecated `FileStorage` layout) without porting a deprecated type. Rust writes compact JSON where TS pretty-prints, which doesn't affect parsing.

**Reason.** harness-ts and Rust harness sessions can resume each other.

**Alternative considered.** Porting the deprecated `FileStorage`.

#### Decision: portable config

**Decision.** The harness parses portable `HarnessAgentConfig`, with validation messages that match TS. Module references return `module references are not supported in Rust yet`.

**Reason.** The same config file works in both harnesses. Loading TS or Python modules has no Rust equivalent yet.

**Alternative considered.** Leaving portable config out of v0.1.0.

#### Decision: programmatic tool caller isolation

**Decision.** `programmatic_tool_caller` runs Python on Monty. It runs code in an external `monty` worker process when it finds one, using the same lookup order as `@pydantic/monty`: an explicit `Isolation::Subprocess` path (TS `binaryPath`), then `MONTY_BIN`, then `PATH`, then a `target/debug` or `target/release` build in the running executable's cargo workspace. The worker installs with `cargo install monty-runtime --version 1.5.0 --locked`. Without a worker it runs in-process and logs a warning; each interpreter step runs on a large-stack thread, value conversion stops at 128 levels of nesting, and the memory limit bounds single allocations rather than the process total.

**Reason.** A worker process gives crash and memory isolation, as TS's native addon does. The in-process fallback matches TS's WebAssembly fallback, so the tool works without extra setup. TS gets the worker automatically through npm platform packages and falls back only when the native addon fails to load, while Rust users install the worker once.

**Alternative considered.** Requiring the worker with no fallback; a worker binary built from `strands-harness`, which would pull Monty's type checker into the library's dependency graph; or re-executing the host binary, which a library cannot do.
