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
    <a href="https://www.npmjs.com/package/@strands-agents/harness"><img alt="npm version" src="https://img.shields.io/npm/v/%40strands-agents%2Fharness"/></a>
    <a href="https://discord.gg/strands"><img alt="Strands Discord" src="https://img.shields.io/badge/Discord-Strands-5865F2?logo=discord&logoColor=white"/></a>
  </div>

  <p>
    <a href="https://github.com/strands-agents/harness-sdk">Strands Harness SDK</a>
    ◆ <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://github.com/strands-agents/samples">Samples</a>
    ◆ <a href="https://discord.gg/strands">Discord</a>
  </p>
</div>

The Strands harness gets you a capable, ready-to-work agent in one
call. It's built on the [Strands Harness SDK](https://github.com/strands-agents/harness-sdk) by
the Strands team at Amazon Web Services (AWS). It composes the SDK's building blocks (a model
loop, tools, just-in-time context assembly, sessions, hooks, and more) into one agent with
sensible, tested defaults and a tuned system prompt. Every default is overridable, and what you
get back is a plain Strands `Agent`, so everything stays open: anything the harness sets up, you
can change, extend, or replace.

```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness()
await agent.invoke("Find the slowest test in this repo and explain why it's slow")
```

> **Also available in Python** as [`strands-harness`](https://pypi.org/project/strands-harness/),
> with the same interface.

## The interface

`createHarness()` builds a ready Strands `Agent`. Every option is optional:

```typescript
await createHarness({
  model: 'bedrock/global.anthropic.claude-opus-5', // "provider/name", a bare Bedrock id, or a Model instance
  effort: 'high', // "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  instructions: undefined, // domain text appended to the system prompt
  tools: undefined, // your tools, added alongside the built-ins
  plugins: undefined, // your Strands plugins, added alongside the built-in ones
  mcpServers: undefined, // MCP servers: a mcpServers JSON path or the mapping itself
  builtinTools: undefined, // a list pins the set; a mapping edits the defaults (see below)
  backgroundTasks: undefined, // SDK Background Tasks policy; false to disable
  builtinPlugins: ['todos', 'environment'], // built-in feature plugins by name; [] for none
  caching: 'auto', // cache system prompt, tools & history where supported; null/false off
  contextManager: 'auto', // "auto" | "agentic" | a ContextManager instance | off (null/false)
  session: true, // true | { id?, dir? } | a SessionManager instance | off (null/false)
  skills: true, // true | dir(s)/URL(s) | an AgentSkills instance | off (null/false)
  memory: true, // true | { dir?, stores? } | a MemoryManager instance | off (null/false)
  interventions: undefined, // gate tool calls: 'ask' | 'smart' | a policy string | a .cedar file
  // ...any other AgentConfig field is passed straight through to Agent
})
```

Resolution is asynchronous because model providers are loaded on demand. You only need the
peer dependency for the provider you actually use.

For a JSON-compatible definition, use `defineHarnessAgentConfig()` and pass the result through
`harnessAgentOptionsFromConfig()`. Executable values such as custom tools, models, intervention
handlers, sandboxes, and other live `AgentConfig` fields are represented by module references;
malformed or wrong-language references fail instead of being ignored.

> **Want a terminal command instead of code?** The [`strands` CLI](https://github.com/strands-agents/harness-sdk/tree/main/strands-cli)
> wraps this same agent. Install it with `npm install -g @strands-agents/cli` for a `strands` command.

## Installation

```bash
npm install @strands-agents/harness
```

The default agent runs on Amazon Bedrock, which needs no extra dependency. To use another
provider, install its peer dependency:

```bash
npm install openai              # for openai/*
npm install @anthropic-ai/sdk   # for anthropic/*
npm install @google/genai       # for google/*
```

## What you get by default

Out of the box, `createHarness()` gives you an agent that:

- **Runs on frontier models with reasoning on**, across Amazon Bedrock, Anthropic, OpenAI, and
  Google. The default is Claude Opus 5 on Amazon Bedrock, behind a tuned system prompt: explore
  before changing things, confirm before anything irreversible, verify before calling a task done.
- **Comes with working tools**: a shell, file tools (`read`, `write`, `edit`), web access, and
  `programmatic_tool_caller`, a sandbox where it writes code that chains, loops over, and
  parallelizes its other tools for more complex orchestration.
- **Manages its own context** so long tasks stay coherent and affordable. It summarizes older
  turns and moves bulky tool results out to storage, leaving a short reference to pull them back.
  The reused parts of each request are cached wherever the provider supports it.
- **Remembers.** Every conversation is saved to disk and resumable by session id, and long-term
  memory distills facts across conversations into markdown files it folds back into context.
- **Is just a Strands `Agent`.** Every default is overridable, and because the return value is a
  plain `Agent`, the full SDK is yours: interventions, hooks, MCP tools, and custom session
  backends all plug in.

Everything above is a default, not a constraint. Here's how to adjust each piece.

## Choosing a model

Pass a `provider/model` string, a bare model id, or a ready-made `Model` instance:

```typescript
await createHarness({ model: 'anthropic/claude-opus-5' }) // Anthropic's API directly
await createHarness({ model: 'openai/gpt-5.6-sol' }) // OpenAI
await createHarness({ model: 'google/gemini-3.5-flash' }) // Google
await createHarness({ model: 'bedrock/global.anthropic.claude-opus-5' }) // the default, spelled out
await createHarness({ model: 'bedrock-mantle/openai.gpt-5.6-sol' }) // Bedrock's OpenAI-compatible endpoint

import { OpenAIModel } from '@strands-agents/sdk/models/openai'
await createHarness({ model: new OpenAIModel({ modelId: 'gpt-5.6-sol' }) }) // full control
```

The `provider/model` string is a shorthand with aliases for `bedrock`, `bedrock-mantle`, `anthropic`,
`openai`, `google`, `ollama`, and `litellm`. For any other provider, pass a `Model` instance (as above)
and it's used as-is. Reasoning effort is mapped to whatever each provider expects, so you set it once
for every provider:

```typescript
await createHarness({ effort: 'high' }) // the default; minimal | low | medium | high | xhigh | max, as the provider offers them
await createHarness({ effort: 'auto' }) // the provider's recommended level (high where supported)
await createHarness({ effort: 'off' }) // reasoning off (the provider's `none` level where it has one)
```

## Giving it your own instructions and tools

`instructions` adds a domain block after the built-in contract. Use it to give the agent its
identity, scope, and any rules you want it to follow. `tools` adds your own tools alongside
the built-in ones:

```typescript
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

const getTicket = tool({
  name: 'get_ticket',
  description: 'Fetch a support ticket by id.',
  inputSchema: z.object({ ticketId: z.string() }),
  callback: ({ ticketId }) => db.tickets.get(ticketId),
})

const agent = await createHarness({
  instructions: "You are a support assistant. Always link the ticket you're working on.",
  tools: [getTicket],
})
```

Prefer a leaner or different tool set? `builtinTools` takes either a **list** (a pin: exactly
these names) or a **mapping** of edits to the default set (`shell`, `read`, `write`, `edit`,
`web_fetch`, `web_search`, `programmatic_tool_caller`, `subagent`). In a mapping, `false` disables a tool, `true`
enables one, and a config object enables and configures it; the `"*"` key (default `true`) is the
baseline, so `"*": false` starts from nothing:

```typescript
await createHarness({ builtinTools: ['read'] }) // just read (pin)
await createHarness({ builtinTools: [] }) // bring your own via `tools`
await createHarness({ builtinTools: { subagent: false } }) // the defaults minus subagent
await createHarness({ builtinTools: { web_search: true } }) // require web_search (throws if unsupported)
await createHarness({ builtinTools: { web_fetch: { model: 'openai/gpt-5-mini' } } }) // configure one
await createHarness({ builtinTools: { '*': false, read: true } }) // start empty, add read
```

Four tools take a config object, each key an option of the tool's factory: `shell`
(`{ description }`), `web_fetch` (`{ model, transport }`, its summarizer as a `"provider/name"` string or a
`Model`/`ModelRouter`), `programmatic_tool_caller` (`{ allowedTools, timeout }`, the tools its
sandboxed code may call and the run's time budget in seconds; `null` lifts each bound) and
`subagent` (`{ maxDepth }`, how deep delegation may nest). The rest are on/off only. The same shape
works in a JSON profile, so a configured `builtinTools` mapping ports between the Python and
TypeScript libraries unchanged (JSON keys are camelCase in both; only Python keyword arguments use
`allowed_tools` and `max_depth`):

```typescript
await createHarness({
  builtinTools: {
    shell: { description: 'Run a command in the project sandbox.' },
    programmatic_tool_caller: { allowedTools: ['read', 'shell'], timeout: 120 },
    subagent: { maxDepth: 1 },
  },
})
```

Unknown names throw, as do unknown config keys and a config object on a tool that takes none. A
consumer tool in `tools` whose name collides with an enabled built-in throws too, so nothing is
silently shadowed.

`subagent` always runs in the background. By default, the model may also select background
execution for any other compatible tool. The harness waits for the work to finish and continues the
parent model with its result. Pass `backgroundTasks: false` to disable this behavior, or provide
an SDK `BackgroundTasksConfig` to control policy, concurrency, completion, and timeouts. Set
`waitForCompletion: false` only when the application will reinvoke the agent after a result is
ready.

## Delegating work to subagents

The agent can hand a subtask to another agent, exposed to it as a tool. Every call runs in its own
fresh conversation and returns only its final answer, so work that would otherwise flood the main
context (searching many files, a multi-step change, open-ended exploration) is kept out of the way.

There are two kinds of delegation, and they coexist. The built-in **`subagent`** tool is a
general-purpose delegate, enabled by default (it is just a name in `builtinTools`, like `shell` or
`read`). The parent model calls it with a self-contained `task`; the harness builds a fresh child agent
that inherits this agent's configuration (its model, plugins, and interventions, so the gate
reaches the delegate too), runs it in its own context, and returns a single final report. The
child's tools are restricted to a subset of this agent's own (it can never gain a capability the
parent lacks), and delegation depth is bounded so a delegate cannot recurse without limit. Drop
`subagent` from `builtinTools` to turn it off:

```typescript
await createHarness() // subagent enabled (default)
await createHarness({ builtinTools: { subagent: false } }) // subagent disabled
```

The tool's model-facing parameters are derived from configuration. For a fully configured tool
(custom roles, model tiers, fixed prompts), build one with `makeSubagent` and pass it via `tools`
with `subagent` dropped from `builtinTools`. You supply the `builder`, a function that turns a
resolved `AgentSpec` into the child agent (typically calling `createHarness`); this is the seam
that makes the child a harness member. Delegation depth is bounded at two levels by default; pass
`maxDepth` to change it. Each axis (`instructions`, `tools`, `mcpServers`, `model`, `context`) becomes a
parameter, or not, depending on whether it is `Fixed`, `Inherit`, `Open`, or `Choice`:

```typescript
import { createHarness, makeSubagent, Fixed, Inherit, Preset, type AgentSpec } from '@strands-agents/harness'

const NO_SUBAGENT = { subagent: false } // the defaults minus delegation; web_search stays provider-dependent

const reviewer = makeSubagent({
  builder: (spec: AgentSpec) => createHarness({ instructions: spec.instructions ?? undefined, builtinTools: NO_SUBAGENT }),
  presets: { reviewer: new Preset({ instructions: 'You review diffs.', description: 'reviews diffs' }) },
  instructions: new Fixed(null), // the role owns the prompt; parameter removed
  model: new Inherit(),
})

const agent = await createHarness({ tools: [reviewer], builtinTools: NO_SUBAGENT })
```

For focused expertise, wrap your own `Agent` instances with `Agent.asTool()` and pass them in
`tools`; each becomes a tool the main agent can call, named after the agent's `name`. Every call
runs the specialist from a fresh conversation, so it's a clean, focused delegate rather than a
shared session. Give each a clear `name` and `description` so the model knows when to reach for it:

```typescript
import { Agent } from '@strands-agents/sdk'

const researcher = new Agent({
  name: 'researcher',
  description: 'Researches a topic and summarizes findings.',
  systemPrompt: 'You research a topic and return a concise, sourced summary of what you found.',
})
const reviewer = new Agent({
  name: 'reviewer',
  description: 'Reviews code for correctness and style.',
  systemPrompt: 'You review a diff for correctness and style, and list concrete issues with fixes.',
})

const agent = await createHarness({ tools: [researcher.asTool(), reviewer.asTool()] })
```

Each specialist is a full `Agent`, so it carries its own model, prompt, and tools. Build them with
`createHarness` too if you want them to share the harness's defaults.

## Connecting MCP servers

Point `mcpServers` at a standard `mcpServers` config (a JSON file path, or the mapping inline)
and the harness connects each server, discovers its tools, and adds them to the tool list:

```typescript
await createHarness({ mcpServers: '.mcp.json' })

await createHarness({
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'] },
  },
})
```

A server that fails to start contributes no tools rather than taking the agent down; set
`continueOnError: false` on a server to make its failure fatal. Each server's tools are namespaced
as `<server>_<tool>` (characters outside `[A-Za-z0-9_-]` in the server name become `_`) so two servers
exposing the same tool don't clash; set a server's `prefix` to choose the namespace, or `prefix: ''` to
opt out.

## Reaching the web

Two of the built-ins put the web in reach. `web_fetch` is always on: it fetches a URL,
reduces it to text, and asks a small fast model to answer your prompt over the content, returning
the answer rather than the raw page so a long article never floods the conversation. The
summarizer runs on the small model for your main provider by default (so credentials line up);
override it with the tool's own config in `builtinTools`:

```typescript
await createHarness({ builtinTools: { web_fetch: { model: 'anthropic/claude-haiku-4-5-20251001' } } })
```

`web_search` is the other one: it lets the agent look things up on the web mid-answer. Where the
model provider has its own search (OpenAI, Google, GPT-5/GPT-6 models on `bedrock-mantle` via
Bedrock Web Search, and Anthropic in Python; TypeScript Anthropic support follows in a coming
`@strands-agents/sdk` release) the harness turns that on and there is no extra service involved. Elsewhere (Amazon Bedrock
Converse, other Mantle models, a `Model` instance) `web_search` is off by default with a logged
warning, and naming it explicitly throws. To search there anyway, opt into the Exa fallback with
`{ web_search: 'exa' }`: the model gets a `web_search` tool backed by Exa's hosted search. It is
keyless to start; `EXA_API_KEY` in the environment lifts the rate limit. On a model with native
search the same setting keeps using the provider's search. Bedrock Web Search also needs the
`bedrock-websearch` IAM actions (in `AmazonBedrockFullAccess`); without them the request succeeds but
each search fails.

> [!WARNING]
> Web search through Exa sends every search query the model writes to Exa (exa.ai), a third-party
> service. Queries leave your environment and are subject to
> [Exa's privacy policy](https://exa.ai/privacy-policy).

```typescript
await createHarness({ model: 'openai/gpt-5.6-sol' }) // native search on, it's in the defaults
await createHarness({ builtinTools: { web_search: 'exa' } }) // Bedrock: search through Exa (third party)
```

## Caching reused context

`caching` is on by default. The stable parts of a conversation (system prompt, tool definitions,
earlier turns) are cached where the provider supports it, so you're not billed to reprocess them
on every turn. The harness configures Amazon Bedrock and Anthropic direct with automatic cache points covering
messages and tools; OpenAI, Google, Bedrock Mantle, and LiteLLM cache server-side on their own, so
there's nothing to configure or turn off. The only targets that can't cache are `ollama` and a
pre-built `Model` instance (its provider is unknown): there the default is a no-op with a logged
warning, but asking for caching explicitly (`caching: 'auto'` / `true`) throws for an unsupported
provider, so a deliberate request never passes silently (a `Model` instance only warns). Turn off
what the harness configures with `caching: false`:

```typescript
await createHarness({ caching: false }) // don't configure caching
```

The harness warns through its logger; route it into your own with `configureLogging`:

```typescript
import { configureLogging } from '@strands-agents/harness'

configureLogging(myLogger) // any { debug, info, warn, error } logger
```

## Remembering conversations

By default the harness persists every conversation to disk under `./.agent/sessions`. It does not
auto-resume, though: with no id it mints a fresh one each run, so a new run starts a new session.
To continue a conversation, read the minted id off the returned agent (`agent.sessionId`) and
pass it back as `session: { id }`, or supply your own stable id up front. Build a fresh agent per
request, keyed on the id:

```typescript
const agent = await createHarness({ session: { id: 'user-42' } })
await agent.invoke('Where did we leave off?')
```

`session` takes `true` (the default), a `{ id?, dir? }` config, a `SessionManager` instance, or
`false`. Set `dir` to choose where state lives (default `./.agent/sessions`). For multi-host
setups, pass your own `SessionManager` (for example an S3-backed one) and it takes over. Turn
persistence off with `session: false` for a throwaway run.

The default manager saves after each completed message, including tool results, so an interrupted
turn retains its saved progress. Text still streaming and unfinished tool calls are not yet saved.

## Long-term memory

Separate from sessions, the harness builds up long-term memory. It remembers facts that it learns about your
preferences and the project, saved in markdown files under `./.agent/memory` and folded back into context on
later turns. The agent also has a `search_memory` tool for on-demand recall. Long-term memory works across
conversations and sessions. Fact extraction from your conversation history runs every few turns on a small,
cheap model. A `subagent` delegate shares this memory read-only, so it recalls what you've told
the agent but its subtasks never write back into your store.

`memory` takes `true` (the default), a `{ dir?, stores? }` config, a `MemoryManager` instance, or
`false`. Set `dir` to choose where the files live, or turn memory off with `memory: false`. To swap the
backend while keeping the harness's behavior, pass `stores` (one or more SDK `MemoryStore`s); the harness manages them
under the same policy, and a `subagent` delegate still shares them read-only. To replace the policy
itself, pass your own `MemoryManager`.

Extraction runs in the background between turns, so a short run can end before the latest turns are saved.
If you own the agent's lifecycle, flush at shutdown to persist what's pending (the harness's CLI does this for you):

```typescript
await agent.memoryManager?.flush()
```

```typescript
await createHarness({ memory: false }) // no memory
await createHarness({ memory: { dir: './my-memory' } }) // custom location
await createHarness({ memory: { stores: [myStore] } }) // swap the backend, keep the harness's policy
await createHarness({ memory: myMemoryManager }) // your own policy
```

## Teaching it skills

Drop [Agent Skills](https://agentskills.io) into `./.agent/skills` and the harness
loads them automatically. Each skill is a subdirectory with a `SKILL.md` (YAML frontmatter with
`name` and `description`, then markdown instructions); the model sees the metadata up front and
loads the full instructions on demand via a `skills` tool. A skill can bundle supporting files
alongside `SKILL.md` (scripts, templates, references) that its instructions tell the agent to
run or read:

```
./.agent/skills/
├── release-notes/
│   └── SKILL.md
└── changelog/
    ├── SKILL.md
    └── scripts/
        └── collect_commits.py
```

Point elsewhere with `skills` (a directory or `https://` source, or an array of them), pass your
own `AgentSkills` instance to take over, or pass `skills: false` to disable. The default location
is best-effort (a missing directory is skipped); explicit sources pass straight through to the SDK.

## Built-in plugins

The harness ships two built-in feature plugins, both on by default:

- **`todos`** lets the agent keep a structured task list and re-surfaces it before each step so it
  stays on plan through longer tasks. The list lives in agent state, never in durable history.
- **`environment`** injects a short context block before each turn: the platform, current date,
  working directory, the project's `AGENTS.md` contents, and links to other `AGENTS.md`/`README.md`
  files a couple of levels down (links, not contents, so the block stays small). Everything is read
  through the agent's sandbox, so it works whether the agent runs locally, in Docker, or over SSH.

`builtinPlugins` selects these by name, the same way `builtinTools` does: pass a subset, or `[]`
to turn them off:

```typescript
await createHarness({ builtinPlugins: [] }) // no built-in plugins
```

## Tracing

The SDK instruments the agent: the model loop, tool calls, and subagent delegation all emit
OpenTelemetry spans. The harness wires up the exporter for you when you turn tracing on with the standard
`OTEL_TRACES_EXPORTER`; there's nothing to pass in code:

```bash
export OTEL_TRACES_EXPORTER=otlp                          # or "console" for span JSON to stdout
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # where your collector is listening
```

Set headers, protocol, and the rest through the other `OTEL_EXPORTER_OTLP_*` variables. With
`OTEL_TRACES_EXPORTER` unset, the harness touches telemetry not at all: no exporter, no cost. If your
process already configures a tracer, the harness uses it. Disable with `OTEL_SDK_DISABLED=true`.

## Requiring approval for tool calls

By default the agent runs every tool call without asking. Pass `interventions` to gate them with a
preset, a policy, an SDK handler, or a list of these:

```typescript
createHarness({ interventions: 'ask' }) // approve every tool call
createHarness({ interventions: 'smart' }) // an LLM risk classifier flags risky calls for approval

// a natural-language policy becomes the classifier's rubric
createHarness({ interventions: 'Read-only, but writes under ./out are fine' })

// a Cedar policy file (needs the @cedar-policy/cedar-wasm dependency)
createHarness({ interventions: './agent.cedar' })

// full control: your own handler (Slack approval, custom trust, a Cedar principal resolver)
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
createHarness({ interventions: new HumanInTheLoop({ ask: mySlackAsk, enableTrust: true }) })

// layer a policy engine under a human gate
createHarness({ interventions: ['./agent.cedar', 'ask'] })
```

Presets pause via the SDK's interrupt/resume, so a service can collect approval asynchronously; with
a session id the pending approval survives a process restart. A `subagent` delegate inherits the policy,
so it can't be used to bypass it, and the tool calls `programmatic_tool_caller` makes from inside its
sandbox are gated too (a denied call raises in the code; one that needs interactive approval is refused).
One caveat: those inner calls fire the agent's hooks but not tool middleware or guards, so a control
implemented as middleware/guard rather than as an intervention or `beforeToolCall` hook applies to
direct model calls only. This is sugar over the SDK's `HumanInTheLoop` and
`CedarAuthorization`; pass those directly for anything the presets don't cover. (The `strands` CLI
exposes the same via `--interventions`, prompting inline in the terminal.)

## It's just a Strands Agent

The return value is a regular `Agent`, so the full SDK is available to you. Any `AgentConfig`
field the harness doesn't name is passed straight through to `Agent`, and your explicit value
always wins over the harness default. That's the seam for SDK-native features: pass your own
`plugins`, `interventions`, or any other `AgentConfig` field alongside the harness's, and they compose.

```typescript
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'

const agent = await createHarness({
  plugins: [new MyMetricsPlugin()], // your Strands plugin, added to the harness's built-ins
  interventions: [new HumanInTheLoop()], // an SDK feature, wired straight through
  contextManager: 'agentic', // model-driven context instead of "auto"
})

// And you can keep customizing after construction:
agent.systemPrompt += '\n\nAlways cite file paths as file:line.'
```

## Chat from the terminal

Prefer a terminal command to writing code? The **`strands` CLI** wraps this same agent, with a
flag for every option above. It streams the reply as it arrives, shows the agent's reasoning
and tool calls, and pipes cleanly in scripts:

```bash
npm install -g @strands-agents/cli   # gives you the `strands` command
strands "summarize what this repo does"
git diff | strands -p "write a commit message"
```

The CLI is a separate npm package. See
[strands-cli](https://github.com/strands-agents/harness-sdk/tree/main/strands-cli) for the full command
reference. For anything beyond its flags (custom plugins, interventions, a bring-your-own model
instance), reach for the TypeScript API. That's what it's there for.

## The vended prompt

The system prompt is also available on its own, in case you want to build on it directly (for
example, a serving layer that injects a timestamp or request context each turn):

```typescript
import { HARNESS_CONTRACT, buildSystemPrompt } from '@strands-agents/harness'

const prompt = buildSystemPrompt('You are a data-migration assistant.', [`Current time: ${now}`])
```

## Contributing ❤️

Contributions are welcome: bug reports, features, docs, or a well-scoped PR. See the
[Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md) for
development setup, how we work, and the pull-request flow. Please also review our
[Code of Conduct](https://github.com/strands-agents/harness-sdk/blob/main/CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](https://github.com/strands-agents/harness-sdk/blob/main/SECURITY.md) for how to
report a vulnerability. Please do not open a public issue for security concerns.

## License

Apache-2.0. See [LICENSE](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/LICENSE).
