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
    Strands harness
  </h1>

  <h2>
    A batteries-included agent, built on the Strands Harness SDK.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/strands-agents/harness-sdk"/></a>
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
    <a href="https://crates.io/crates/strands-harness"><img alt="crates.io version" src="https://img.shields.io/crates/v/strands-harness"/></a>
    <a href="https://docs.rs/strands-harness"><img alt="docs.rs" src="https://img.shields.io/docsrs/strands-harness"/></a>
    <a href="https://discord.gg/strands"><img alt="Strands Discord" src="https://img.shields.io/badge/Discord-Strands-5865F2?logo=discord&logoColor=white"/></a>
  </div>

  <p>
    <a href="https://github.com/strands-agents/harness-sdk">Strands Harness SDK</a>
    ◆ <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://docs.rs/strands-harness">API reference</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://discord.gg/strands">Discord</a>
  </p>
</div>

> Developer preview. The API may change in any 0.x release.

The Strands harness gets you a capable, ready-to-work agent in one call. It's built on the
[Strands Harness SDK](https://github.com/strands-agents/harness-sdk) by the Strands team at Amazon Web Services (AWS).
It composes the SDK's building blocks (a model loop, tools, just-in-time context assembly, sessions, hooks, and more)
into one agent with sensible, tested defaults and a tuned system prompt. Every default is overridable, and what you
get back is a plain `strands::Agent`, so anything the harness sets up, you can change, extend, or replace.

```rust,no_run
use strands_harness::{HarnessAgentOptions, create_harness};

#[tokio::main]
async fn main() -> strands::Result<()> {
    let mut agent = create_harness(HarnessAgentOptions::default()).await?;
    let result = agent.invoke("Find the slowest test in this repo and explain why it's slow").await?;
    println!("{result}");
    agent.shutdown().await
}
```

The Rust harness matches the Python ([`strands-harness`](https://pypi.org/project/strands-harness/)) and TypeScript
([`@strands-agents/harness`](https://www.npmjs.com/package/@strands-agents/harness)) harnesses in behaviour, defaults
and portable config, re-cased to Rust idiom. The places where it differs are listed in
[DIVERGENCES.md](https://github.com/strands-agents/harness-sdk/blob/main/harness-rs/docs/DIVERGENCES.md).

## The interface

`create_harness(options).await` builds a ready `strands::Agent`. Every field of `HarnessAgentOptions` is optional;
these are the defaults, with the options that have no default value commented out:

```rust
use strands_harness::{BuiltinPluginName, ContextManagerOption, Effort, HarnessAgentOptions};

let options = HarnessAgentOptions::builder()
    .model("bedrock/global.anthropic.claude-opus-5") // "provider/name", a bare Bedrock id, a model or a router
    .effort(Effort::Auto) // Auto | Off | Minimal | Low | Medium | High | Xhigh | Max
    // .instructions("...")        domain text appended to the system prompt
    // .tools([..])                your tools, added alongside the built-ins
    // .plugins([..])              your Strands plugins, added alongside the built-in ones
    // .mcp_servers(".mcp.json")   MCP servers: a mcpServers JSON path or the map itself
    // .builtin_tools(..)          a list pins the set; a BuiltinToolsConfig edits the defaults (see below)
    // .background_tasks(false)    SDK Background Tasks policy; false to disable
    .builtin_plugins([BuiltinPluginName::Todos, BuiltinPluginName::Environment]) // [] for none
    // .caching(false)             cache system prompt, tools and history where supported; false turns it off
    .context_manager(ContextManagerOption::Auto) // Auto | Agentic | a config or instance | Disabled
    .session(true) // true | a SessionConfig | a SessionManager | false
    .skills(true) // true (./.agent/skills) | path(s) or URL(s) | an AgentSkills plugin | false
    .memory(true) // true (./.agent/memory) | a MemoryConfig | a MemoryManager | false
    // .interventions("ask")       gate tool calls: "ask" | "smart" | a policy | a .cedar file | a handler
    // ...plus the AgentConfig fields the harness doesn't own, such as name, aux_model or sandbox
    .build();
```

The fields are public, so struct update syntax works too:
`HarnessAgentOptions { effort: Effort::High, ..Default::default() }`. The sections below walk through each option in
turn.

For a JSON-compatible definition, parse a `HarnessAgentConfig` with `serde_json` (or validate one built in code with
`define_harness_agent_config`) and pass it through `harness_agent_options_from_config`. It's the same portable format
the Python and TypeScript harnesses read. Executable values such as custom tools, models and intervention handlers are
module references there; Rust parses and round-trips them, but fails on the first one when converting to options,
since it can't load modules yet.

## Installation

```toml
[dependencies]
strands-harness = "0.1"
strands = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

`strands` is the SDK the harness builds on. You need it alongside the harness for its types: the returned `Agent`,
the `#[tool]` macro, hooks, and interventions. The minimum supported Rust version is 1.96.

Cargo features select the providers and integrations. Everything except `otel` is on by default:

| Feature | Adds |
|---|---|
| `bedrock` | `bedrock/` model strings and the default model |
| `anthropic` | `anthropic/` model strings |
| `openai` | `openai/` model strings |
| `mantle` | `bedrock-mantle/` model strings; turns on `openai` |
| `mcp` | `mcp_servers` and the Exa-backed `web_search` |
| `cedar` | `.cedar` interventions |
| `monty-pool` | runs `programmatic_tool_caller` code in a `monty` worker subprocess |
| `otel` | span export selected by `OTEL_TRACES_EXPORTER` |

To leave out the AWS SDK, turn off the defaults and pick a provider. A model string whose provider feature is off
fails with an error naming the feature, so set `model` to a provider you enabled:

```toml
strands-harness = { version = "0.1", default-features = false, features = ["anthropic", "mcp"] }
strands = { version = "0.1", default-features = false }
```

The default agent runs on Amazon Bedrock, with credentials from the AWS default chain and the region from
`AWS_REGION` (or `AWS_DEFAULT_REGION`). The other providers read `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.

`programmatic_tool_caller` runs the model's code in a `monty` worker process when it finds one, so a crash or runaway
allocation ends only the worker. Install the worker with:

```bash
cargo install monty-runtime --version 1.5.0 --locked
```

The harness looks for it through `MONTY_BIN`, then `monty` on `PATH`, then a `target/{debug,release}` build in the
running executable's cargo workspace. Without one, the interpreter runs in-process and logs a warning that it has no
crash isolation and no cap on its total memory.

## What you get by default

Out of the box, `create_harness` gives you an agent that:

- **Runs on frontier models with reasoning on**, across Amazon Bedrock, Bedrock Mantle, Anthropic, and OpenAI. The
  default is Claude Opus 5 on Amazon Bedrock, behind a tuned system prompt: explore before changing things, confirm
  before anything irreversible, verify before calling a task done.
- **Comes with working tools**: a shell, file tools (`read`, `write`, `edit`), web access, `subagent` for delegation,
  and `programmatic_tool_caller`, a sandboxed Python interpreter where it writes code that chains, loops over, and
  parallelizes its other tools for more complex orchestration.
- **Manages its own context** so long tasks stay coherent and affordable. It truncates bulky tool results into
  storage, leaving a short reference to pull them back, and summarizes older turns as the context window fills. The
  reused parts of each request are cached wherever the provider supports it.
- **Remembers.** Every conversation is saved to disk and resumable by session id, and long-term memory distills facts
  across conversations into markdown files it folds back into context.
- **Is just a `strands::Agent`.** Every default is overridable, and because the return value is a plain `Agent`, the
  full SDK is yours: interventions, hooks, MCP tools, and custom session backends all plug in.

Everything above is a default, not a constraint. Here's how to adjust each piece.

## Choosing a model

Pass a `provider/model` string, a bare Bedrock model id, or a ready-made model or `ModelRouter`:

```rust,no_run
use strands_harness::HarnessAgentOptions;

HarnessAgentOptions::builder().model("anthropic/claude-opus-5").build(); // Anthropic's API directly
HarnessAgentOptions::builder().model("openai/gpt-5.6-sol").build(); // OpenAI
HarnessAgentOptions::builder().model("bedrock/global.anthropic.claude-opus-5").build(); // the default, spelled out
HarnessAgentOptions::builder().model("bedrock-mantle/openai.gpt-5.6-sol").build(); // Bedrock's OpenAI-compatible API

# #[cfg(feature = "openai")]
fn full_control() -> strands::Result<HarnessAgentOptions> {
    use strands::models::openai::OpenAIModel;

    let model = OpenAIModel::builder().model_id("gpt-5.6-sol").build()?;
    Ok(HarnessAgentOptions::builder().model(model).build())
}
```

The `provider/model` string is a shorthand for `bedrock`, `bedrock-mantle`, `anthropic`, and `openai`. For any other
provider, pass a model instance and it's used as is. Reasoning effort is mapped to whatever each provider expects, so
you set it once for every provider:

```rust
use strands_harness::{Effort, HarnessAgentOptions};

HarnessAgentOptions::builder().effort(Effort::High).build(); // Minimal | Low | Medium | High | Xhigh | Max, as offered
HarnessAgentOptions::builder().effort(Effort::Auto).build(); // the provider's recommended level (High), the default
HarnessAgentOptions::builder().effort(Effort::Off).build(); // reasoning off (the provider's `none` level if it has one)
```

A level the provider doesn't offer fails `create_harness`, so a typo or an unsupported request never passes silently.
`Effort` also parses from its config spelling (`"xhigh".parse::<Effort>()`). When you pass a model instance, a
non-default `effort` (like an explicit `caching`) is not applied and a warning is logged: configure reasoning on the
instance itself. `supports_thinking` and `supports_web_search` answer what a model string supports before you build
anything.

## Giving it your own instructions and tools

`instructions` adds a domain block after the built-in contract. Use it to give the agent its identity, scope, and any
rules you want it to follow. `tools` adds your own tools alongside the built-in ones:

```rust,no_run
use strands::{ToolError, tool};
use strands_harness::{HarnessAgentOptions, create_harness};

/// Fetch a support ticket by id.
#[tool]
async fn get_ticket(
    /// The ticket id, such as "T-1042".
    ticket_id: String,
) -> Result<String, ToolError> {
    Ok(format!("Ticket {ticket_id}: printer on fire"))
}

async fn support_agent() -> strands::Result<strands::Agent> {
    create_harness(
        HarnessAgentOptions::builder()
            .instructions("You are a support assistant. Always link the ticket you're working on.")
            .tools([GetTicket])
            .build(),
    )
    .await
}
```

Prefer a leaner or different tool set? `builtin_tools` takes two shapes. A **list pins** exactly the tools named (an
empty list turns them all off); a **`BuiltinToolsConfig` edits** the default set, where `false` removes a tool, `true`
adds one, and a per-tool config enables *and* configures it. Five tools take a config: `shell` (`ShellConfig`:
`description`), `read` (`ReadConfig`: `media`, whether images and documents come back as viewable media), `web_fetch`
(`WebFetchConfig`: `model`, `transport`), `programmatic_tool_caller` (`ProgrammaticToolCallerConfig`:
`allowed_tools`, `timeout`) and `subagent` (`SubagentConfig`: `max_depth`); `write` and `edit` are on or off only.
`all` is the baseline (the portable config's `"*"` key, `true` when unset); set it to `false` to start from nothing
and name what you want:

```rust
use strands_harness::{
    BuiltinToolName, BuiltinToolsConfig, HarnessAgentOptions, ProgrammaticToolCallerConfig, SubagentConfig,
    WebFetchConfig,
};

HarnessAgentOptions::builder().builtin_tools([BuiltinToolName::Read]).build(); // just read
HarnessAgentOptions::builder().builtin_tools(Vec::<BuiltinToolName>::new()).build(); // bring your own via `tools`
HarnessAgentOptions::builder()
    .builtin_tools(BuiltinToolsConfig::builder().subagent(false).build())
    .build(); // the defaults minus one
HarnessAgentOptions::builder()
    .builtin_tools(
        BuiltinToolsConfig::builder()
            .web_fetch(WebFetchConfig::builder().model("openai/gpt-5.6-luna").build())
            .subagent(SubagentConfig::builder().max_depth(1).build())
            .programmatic_tool_caller(ProgrammaticToolCallerConfig::builder().timeout(Some(60.0)).build())
            .build(),
    )
    .build(); // the defaults, three of them configured
HarnessAgentOptions::builder()
    .builtin_tools(BuiltinToolsConfig::builder().all(false).read(true).web_fetch(true).build())
    .build(); // start empty, add two
```

`BUILTIN_TOOL_NAMES` is the full list, and `BuiltinToolName` parses from a tool name (`"web_fetch".parse()`). Prefer
the config form for "the defaults minus X"; a list pins every name it contains, so listing `web_search` on a model
without native search fails instead of quietly staying off (opt into the Exa fallback with
`.web_search(WebSearchSetting::Exa)`). A tool in `tools` whose name collides with an enabled built-in (or a plugin's
tool) fails `create_harness` too, so nothing is silently shadowed; drop the built-in first to replace it.

`subagent` always runs in the background. By default, the model may also select background execution for any other
compatible tool. The harness waits for the work to finish and continues the parent model with its result. Pass
`.background_tasks(false)` to disable this behaviour, or an SDK `BackgroundTasksConfig` to control the policy,
concurrency, completion, and timeouts. Set `wait_for_completion: Some(false)` only when the application will invoke
the agent again after a result is ready.

## Delegating work to subagents

The agent can hand a subtask to another agent, exposed to it as a tool. Every call runs in its own fresh conversation
and returns only its final answer, so work that would otherwise flood the main context (searching many files, a
multi-step change, open-ended exploration) is kept out of the way.

There are two kinds of delegation, and they coexist. The built-in **`subagent`** tool is enabled by default (it's
just a name in `builtin_tools`, like `shell` or `read`). The parent model calls it with a self-contained `task`; the
harness builds a fresh child through `create_harness` that inherits this agent's configuration (its model, effort,
built-in tools and plugins, skills, interventions, sandbox, and the `plugins` you passed, so your approval gate
reaches the delegate too) and returns a single final report. Your consumer `tools` and MCP servers are forwarded so
the delegate can be granted them. The model picks the `generalist` role, may write an ad-hoc role prompt, may narrow
the tool set (never widen it), and chooses how much of the conversation the child sees. Delegation depth is bounded
(two levels by default, `SubagentConfig::max_depth` to change it), so a delegate can't recurse without limit. Drop it
from `builtin_tools` to turn it off:

```rust
use strands_harness::{BuiltinToolName, HarnessAgentOptions};

HarnessAgentOptions::builder()
    .builtin_tools([BuiltinToolName::Shell, BuiltinToolName::Read, BuiltinToolName::Write, BuiltinToolName::Edit])
    .build(); // no subagent
```

The tool's model-facing parameters are derived from configuration. For a fully configured tool (custom roles, model
tiers, fixed prompts), build one with `make_subagent` and pass it in `tools` with `subagent` dropped from
`builtin_tools`. You supply an `AgentBuilder`, an async function that turns a resolved `AgentSpec` into the child agent
(typically by calling `create_harness`); this is the seam that makes the child a harness member. Each axis
(`instructions`, `tools`, `mcp_servers`, `model`, `context`) becomes a parameter, or not, depending on whether it is
`Fixed`, `Inherit`, `Open`, or `Choice`:

```rust,no_run
use strands_harness::{
    AgentBuilder, AgentSpec, BuiltinToolsConfig, Fixed, HarnessAgentOptions, Inherit, MakeSubagentOptions, Preset,
    create_harness, make_subagent,
};

// The defaults minus delegation; web_search stays provider-dependent.
fn no_subagent() -> BuiltinToolsConfig {
    BuiltinToolsConfig::builder().subagent(false).build()
}

async fn build_reviewer(spec: AgentSpec) -> strands::Result<strands::Agent> {
    let options = HarnessAgentOptions::builder()
        .maybe_instructions(spec.instructions)
        .builtin_tools(no_subagent())
        .build();
    create_harness(options).await
}

async fn agent_with_reviewer() -> strands::Result<strands::Agent> {
    let preset = Preset::builder().instructions("You review diffs.").description("reviews diffs").build();
    let reviewer = make_subagent(
        MakeSubagentOptions::builder()
            .builder(AgentBuilder::new(build_reviewer))
            .presets([("reviewer", preset)])
            .instructions(Fixed::none()) // the role owns the prompt; parameter removed
            .model(Inherit::new())
            .build(),
    )?;
    create_harness(HarnessAgentOptions::builder().tools([reviewer]).builtin_tools(no_subagent()).build()).await
}
```

For focused expertise, pass your own `Agent`s in `tools`; each becomes a tool the main agent can call, named after
the agent's `name`. Every call runs the specialist from the state it had when it became a tool, so it's a clean,
focused delegate rather than a shared session. Give each a clear `name` and `description` so the model knows when to
reach for it:

```rust,no_run
use strands::Agent;
use strands_harness::{HarnessAgentOptions, create_harness};

async fn agent_with_specialists() -> strands::Result<Agent> {
    let researcher = Agent::builder()
        .name("researcher")
        .description("Researches a topic and summarizes findings.")
        .system_prompt("You research a topic and return a concise, sourced summary of what you found.")
        .build()?;
    let reviewer = Agent::builder()
        .name("reviewer")
        .description("Reviews code for correctness and style.")
        .system_prompt("You review a diff for correctness and style, and list concrete issues with fixes.")
        .build()?;
    create_harness(HarnessAgentOptions::builder().tools([researcher, reviewer]).build()).await
}
```

Each specialist is a full `Agent`, so it carries its own model, prompt, and tools. Use `Agent::as_tool` with
`AgentAsToolOptions` to rename one or keep its conversation across calls, or build them with `create_harness` too if
you want them to share the harness's defaults.

## Connecting MCP servers

Point `mcp_servers` at a standard `mcpServers` config (a JSON file path, or the map inline) and the harness connects
each server, discovers its tools, and adds them to the tool list:

```rust,no_run
use serde_json::json;
use strands::types::JsonObject;
use strands_harness::HarnessAgentOptions;

HarnessAgentOptions::builder().mcp_servers(".mcp.json").build();

fn inline_servers() -> Result<HarnessAgentOptions, serde_json::Error> {
    let servers: JsonObject = serde_json::from_value(json!({
        "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },
    }))?;
    Ok(HarnessAgentOptions::builder().mcp_servers(servers).build())
}
```

Servers are connected inside `create_harness`, which is why it's async. A server that fails to start contributes no
tools rather than taking the agent down; set `"continueOnError": false` on a server to make its failure fatal. Each
server's tools are namespaced as `<server>_<tool>` (characters outside `[A-Za-z0-9_-]` in the server name become `_`)
so two servers exposing the same tool don't clash; set a server's `"prefix"` to choose the namespace, or `"prefix": ""`
to opt out. An SDK `McpServersSource` works too, for typed server configs. This needs the `mcp` feature; without it,
setting `mcp_servers` fails `create_harness`.

## Reaching the web

Two of the built-ins put the web in reach. `web_fetch` is on by default: it fetches a URL, reduces it to text, and asks
a small fast model to answer your prompt over the content, returning the answer rather than the raw page so a long
article never floods the conversation. Pages are cached for 15 minutes. The summarizer runs on the small model for
your main provider by default (so credentials line up); override it through the tool's config. The request runs as
`curl` inside the agent's sandbox, so a sandbox's network rules cover it; `WebFetchTransport::Direct` fetches from the
harness process instead:

```rust
use strands_harness::{BuiltinToolsConfig, HarnessAgentOptions, WebFetchConfig, WebFetchTransport};

let web_fetch = WebFetchConfig::builder()
    .model("anthropic/claude-haiku-4-5-20251001")
    .transport(WebFetchTransport::Direct)
    .build();
HarnessAgentOptions::builder().builtin_tools(BuiltinToolsConfig::builder().web_fetch(web_fetch).build()).build();
```

`web_search` is the other one: it lets the agent look things up on the web mid-answer. Where the model provider has
its own search (OpenAI, Anthropic, and GPT-5, GPT-6, and Daybreak models on `bedrock-mantle` via Bedrock Web Search)
the harness turns that on by default. With no native search (Amazon Bedrock Converse, other Mantle models, a model
instance) `web_search` is off by default. To enable web search for these providers, you can opt into Exa with
`WebSearchSetting::Exa`. The model then gets a `web_search` tool backed by Exa's hosted search (this needs the `mcp`
feature). It works keyless, but setting `EXA_API_KEY` in the environment lifts the rate limit. You can override a
provider's native web search by choosing Exa explicitly on any model. If you are using Bedrock Web Search, you'll need
the `bedrock-websearch` IAM action (in `AmazonBedrockFullAccess`) to avoid failing search.

> [!WARNING]
> Web search through Exa sends every search query the model writes to Exa (exa.ai), a third-party service. Queries
> leave your environment and are subject to [Exa's privacy policy](https://exa.ai/privacy-policy).

```rust
use strands_harness::{BuiltinToolsConfig, HarnessAgentOptions, WebSearchSetting};

HarnessAgentOptions::builder().model("openai/gpt-5.6-sol").build(); // native search on, it's in the defaults
HarnessAgentOptions::builder()
    .builtin_tools(BuiltinToolsConfig::builder().web_search(WebSearchSetting::Exa).build())
    .build(); // Bedrock: search through Exa (third party)
```

## Caching reused context

`caching` is on by default. The stable parts of a conversation (system prompt, tool definitions, earlier turns) are
cached where the provider supports it, so you're not billed to reprocess them on every turn. The harness configures
the SDK's automatic cache strategy on every provider a model string can name: Amazon Bedrock, Anthropic, OpenAI, and
Bedrock Mantle. The exceptions are Bedrock models that can't cache (Claude 3 Haiku) and a pre-built model instance,
whose provider the harness can't configure. With the default, those log a warning and run without caching; asking
for caching explicitly (`.caching(true)`) fails `create_harness` for a model that can't cache, so a deliberate request
never passes silently (a model instance only warns). Turn off what the harness configures with `.caching(false)`:

```rust
use strands_harness::HarnessAgentOptions;

HarnessAgentOptions::builder().caching(false).build(); // don't configure caching
```

The harness logs its warnings and notices through [`tracing`](https://docs.rs/tracing), so install a subscriber (for
example `tracing_subscriber::fmt::init()`) to see them.

## Remembering conversations

By default the harness persists every conversation to disk under `./.agent/sessions`, saving after each completed
message. It does not auto-resume, though: with no id it mints a fresh one each run, so a new run starts a new session.
To continue a conversation, read the minted id off the returned agent (`agent.session_id()`) and pass it back in a
`SessionConfig`, or supply your own stable id up front. Build a fresh agent per request, keyed on the id:

```rust,no_run
use strands_harness::{HarnessAgentOptions, SessionConfig, create_harness};

async fn resume(user_id: &str) -> strands::Result<()> {
    let session = SessionConfig::builder().id(user_id).build();
    let mut agent = create_harness(HarnessAgentOptions::builder().session(session).build()).await?;
    println!("{}", agent.invoke("Where did we leave off?").await?);
    agent.shutdown().await
}
```

Set `SessionConfig::dir` to choose where state lives (default `./.agent/sessions`); bulky tool results the context
manager moves out of the conversation are kept in the session's folder too. Ids are sanitized to `[a-z0-9_-]`. The
on-disk layout matches the TypeScript harness, so either one can resume a session the other wrote. For multi-host
setups, pass your own SDK `SessionManager` as `session` and it takes over; pass `storage` with it, or offloaded tool
results are embedded in its snapshots. Turn persistence off with `.session(false)` for a throwaway run.

## Long-term memory

Separate from sessions, the harness builds up long-term memory. It remembers facts that it learns about your
preferences and the project, saved in markdown files under `./.agent/memory` and folded back into context before each
user turn. The agent also has a `search_memory` tool for on-demand recall. Long-term memory works across conversations
and sessions. Fact extraction from your conversation history runs every few turns on the same small model as the
`web_fetch` summarizer. A `subagent` delegate shares this memory read-only, so it recalls what you've told the agent
but its subtasks never write back into your store.

`memory` takes `true` (the default), a `MemoryConfig`, a `MemoryManager`, or `false`. Set `MemoryConfig::dir` to
choose where the files live, or turn memory off with `.memory(false)`. To swap the backend while keeping the harness's
behaviour, set `MemoryConfig::stores` (one or more SDK `MemoryStore`s); the harness manages them under the same
policy, and a `subagent` delegate still shares them read-only. To replace the policy itself, pass your own
`MemoryManager`.

Extraction runs in the background between turns, so a short run can end before the latest turns are saved.
`Agent::shutdown` flushes what's pending; call it at your shutdown boundary:

```rust,no_run
async fn finish(mut agent: strands::Agent) -> strands::Result<()> {
    agent.shutdown().await
}
```

```rust
use std::sync::Arc;

use strands::memory::MemoryStore;
use strands_harness::{HarnessAgentOptions, MemoryConfig};

fn options(my_store: Arc<dyn MemoryStore>) {
    HarnessAgentOptions::builder().memory(false).build(); // no memory
    HarnessAgentOptions::builder().memory(MemoryConfig::builder().dir("./my-memory").build()).build(); // custom location

    // swap the backend, keep the harness's policy
    HarnessAgentOptions::builder().memory(MemoryConfig::builder().stores(vec![my_store]).build()).build();
}
```

## Teaching it skills

Drop [Agent Skills](https://agentskills.io) into `./.agent/skills` and the harness loads them automatically. Each
skill is a subdirectory with a `SKILL.md` (YAML frontmatter with `name` and `description`, then markdown
instructions); the model sees the metadata up front and loads the full instructions on demand via a `skills` tool. A
skill can bundle supporting files alongside `SKILL.md` (scripts, templates, references) that its instructions tell
the agent to run or read:

```text
./.agent/skills/
├── release-notes/
│   └── SKILL.md
└── changelog/
    ├── SKILL.md
    └── scripts/
        └── collect_commits.py
```

Point elsewhere with `skills` (a directory, an `https://` URL of raw `SKILL.md` content, or a list of them), pass a
configured SDK `AgentSkills` plugin to take over, or pass `.skills(false)` to disable. The default location is
best-effort (a missing directory is skipped); explicit sources pass straight through to the SDK, which reads them
through the agent's sandbox and warns on a missing one.

```rust
use strands_harness::HarnessAgentOptions;

HarnessAgentOptions::builder().skills("./team-skills").build();
HarnessAgentOptions::builder().skills(["./team-skills", "https://example.com/skills/review/SKILL.md"]).build();
HarnessAgentOptions::builder().skills(false).build(); // no skills
```

## Built-in plugins

The harness ships two built-in feature plugins, both on by default:

- **`todos`** lets the agent keep a structured task list through a `todo_write` tool and re-surfaces it before each
  model call so it stays on plan through longer tasks. The list lives in agent state, never in durable history.
- **`environment`** injects a short context block before each user turn: the platform, current date, working
  directory, the project's `AGENTS.md` contents, and links to other `AGENTS.md`/`README.md` files a couple of levels
  down (links, not contents, so the block stays small). Everything is read through the agent's sandbox, so it works
  whether the agent runs locally, in Docker, or over SSH.

`builtin_plugins` selects these by name, the same way `builtin_tools` does: pass a subset, or an empty list to turn
them off. Both are public (`Todos` and `EnvironmentContext`, each with a config), and a plugin you pass in `plugins`
under the same name replaces the built-in:

```rust
use strands_harness::{BuiltinPluginName, HarnessAgentOptions};

HarnessAgentOptions::builder().builtin_plugins([BuiltinPluginName::Todos]).build(); // todos only
HarnessAgentOptions::builder().builtin_plugins(Vec::<BuiltinPluginName>::new()).build(); // no built-in plugins
```

## Tracing

The SDK instruments the agent: every invocation, agent loop cycle, model call, and tool call is a
[`tracing`](https://docs.rs/tracing) span with OpenTelemetry `gen_ai.*` attributes. With the `otel` feature, the
harness wires up the exporter for you when you turn tracing on with the standard `OTEL_TRACES_EXPORTER`; there's
nothing to pass in code:

```bash
export OTEL_TRACES_EXPORTER=otlp                          # or "console" for span JSON to stdout, or both
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # where your collector is listening
```

Set headers, protocol, and the rest through the other `OTEL_EXPORTER_OTLP_*` variables. With `OTEL_TRACES_EXPORTER`
unset (or `none`), the harness touches telemetry not at all: no exporter, no cost. Without the `otel` feature, a set
selector logs a warning and tracing stays off. Setup runs once per process, and a tracer provider the program already
registered through `strands::telemetry::setup_tracer` is reused.

The spans reach the exporter only through a `tracing` subscriber that carries the SDK's OpenTelemetry layer, and the
harness doesn't install a subscriber. A program with no subscriber of its own can register the provider and that
subscriber before building agents (one that has its own adds `TracerGuard::layer` to it instead):

```rust,no_run
# #[cfg(feature = "otel")]
fn init_tracing() -> strands::Result<strands::telemetry::TracerGuard> {
    use strands::telemetry::{TelemetryExporters, TracerConfig, setup_tracer};

    let telemetry = setup_tracer(TracerConfig {
        exporters: TelemetryExporters { otlp: true, console: false },
        ..Default::default()
    })?;
    telemetry.try_init_subscriber()?;
    Ok(telemetry) // keep the guard for the life of the program; dropping it flushes the spans
}
```

## Requiring approval for tool calls

By default the agent runs every tool call without asking. Pass `interventions` to gate them with a preset, a policy,
an SDK handler, or a list of these:

```rust
use strands::vended_interventions::hitl::{HumanInTheLoop, HumanInTheLoopAsk, HumanInTheLoopConfig};
use strands_harness::HarnessAgentOptions;

HarnessAgentOptions::builder().interventions("ask").build(); // approve every tool call
HarnessAgentOptions::builder().interventions("smart").build(); // an LLM risk classifier flags risky calls for approval

// a natural-language policy becomes the classifier's rubric
HarnessAgentOptions::builder().interventions("Read-only, but writes under ./out are fine").build();

// a Cedar policy file (the `cedar` feature)
HarnessAgentOptions::builder().interventions("./agent.cedar").build();

// full control: your own handler (terminal or custom approval, trust, a Cedar principal resolver)
let ask = HumanInTheLoopConfig::builder().ask(HumanInTheLoopAsk::Stdio).enable_trust(true).build();
HarnessAgentOptions::builder().interventions(HumanInTheLoop::new(ask)).build();

// layer a policy engine under a human gate
HarnessAgentOptions::builder().interventions(["./agent.cedar", "ask"]).build();
```

Presets pause the agent through the SDK's interrupts, so a service can collect approval asynchronously: the
invocation stops with `StopReason::Interrupt`, and invoking the agent again with the answers resumes it:

```rust,no_run
use strands::{Interrupt, InterruptResponse, StopReason};
use strands_harness::{HarnessAgentOptions, create_harness};

fn ask_user(interrupt: &Interrupt) -> InterruptResponse {
    println!("approve {:?}?", interrupt.reason);
    InterruptResponse::new(interrupt.id.clone(), "yes")
}

async fn run() -> strands::Result<()> {
    let mut agent = create_harness(HarnessAgentOptions::builder().interventions("ask").build()).await?;
    let mut result = agent.invoke("Clean up the build directory").await?;
    while result.stop_reason() == StopReason::Interrupt {
        let answers: Vec<InterruptResponse> = result.interrupts().iter().map(ask_user).collect();
        result = agent.invoke(answers).await?;
    }
    agent.shutdown().await
}
```

A `subagent` delegate inherits the policy, so it can't be used to bypass it, and the tool calls
`programmatic_tool_caller` makes from inside its sandbox run through the agent's full tool pipeline (hooks,
interventions, middleware), so they are gated too (a denied call raises in the code; one that needs interactive
approval is refused). This is sugar over the SDK's `HumanInTheLoop` and `CedarAuthorization`; pass those directly for
anything the presets don't cover. Inline Cedar policy text isn't detected (it reads like prose), so pass a
`CedarAuthorization` handler for that.

## It's just a Strands Agent

The return value is a regular `strands::Agent`, so the full SDK is available to you. `HarnessAgentOptions` also
carries the SDK `AgentConfig` fields the harness doesn't own (`name`, `description`, `aux_model`, `system_prompt`,
`messages`, `app_state`, `conversation_manager`, `retry_strategy`, `structured_output_schema`, `sandbox`, `storage`,
`session_manager`, `memory_manager`, trace attributes, and more), forwarded verbatim, and your explicit value always
wins over the harness default. That's the seam for SDK-native features: pass your own `plugins`, `interventions`, or
any other field alongside the harness's, and they compose.

```rust,no_run
use strands::hooks::BeforeToolCallEvent;
use strands::vended_interventions::hitl::{HumanInTheLoop, HumanInTheLoopConfig};
use strands_harness::{ContextManagerOption, HarnessAgentOptions, create_harness};

async fn build() -> strands::Result<strands::Agent> {
    let agent = create_harness(
        HarnessAgentOptions::builder()
            .name("migrator")
            .aux_model("bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0") // side calls on a smaller model
            .interventions(HumanInTheLoop::new(HumanInTheLoopConfig::default())) // an SDK handler, passed through
            .context_manager(ContextManagerOption::Agentic) // model-driven context instead of Auto
            .build(),
    )
    .await?;

    // And you can keep customizing after construction:
    let _hook = agent.add_hook(|event: &mut BeforeToolCallEvent| {
        println!("calling {}", event.tool_use().name);
    });
    Ok(agent)
}
```

## The vended prompt

The system prompt is also available on its own, in case you want to build on it directly (for example, a serving
layer that injects a timestamp or request context each turn):

```rust
use strands_harness::build_system_prompt;

fn system_prompt(now: &str) -> String {
    build_system_prompt(Some("You are a data-migration assistant."), &[&format!("Current time: {now}")])
}
```

`HARNESS_CONTRACT` is the contract on its own, the first part of every harness prompt.

## Versioning

Strands harness is 0.x, in developer preview. In the Rust crate, a minor release (0.1 to 0.2) may break the API and a
patch release does not, though patch releases still carry new features, including new built-in tools. Cargo's default
requirement (`strands-harness = "0.1"`) stays on one minor, so it picks up fixes and features without breaking
changes. See [Versioning and Support](https://strandsagents.com/docs/user-guide/harness/versioning/) for what the
harness counts as breaking.

## Contributing ❤️

Contributions are welcome: bug reports, features, docs, or a well-scoped PR. See the
[Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md) for development setup,
how we work, and the pull-request flow. Please also review our
[Code of Conduct](https://github.com/strands-agents/harness-sdk/blob/main/CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](https://github.com/strands-agents/harness-sdk/blob/main/SECURITY.md) for how to report a
vulnerability. Please do not open a public issue for security concerns.

## License

Apache-2.0. See [LICENSE](https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE).
