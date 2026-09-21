<div align="center">
  <div>
    <a href="https://strandsagents.com">
      <img src="https://strandsagents.com/latest/assets/logo-github.svg" alt="Strands Agents" width="55px" height="105px">
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
    <a href="https://pypi.org/project/strands-harness/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/strands-harness"/></a>
    <a href="https://python.org"><img alt="Python versions" src="https://img.shields.io/pypi/pyversions/strands-harness"/></a>
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
get back is a plain `strands.Agent`, so everything stays open: anything the harness sets up, you
can change, extend, or replace.

```python
from strands_harness import create_harness

agent = create_harness()
agent("Find the slowest test in this repo and explain why it's slow")
```

> **Also available in TypeScript** as [`@strands-agents/harness`](https://www.npmjs.com/package/@strands-agents/harness),
> with the same interface.

## The interface

`create_harness()` builds a ready `strands.Agent`. Every argument is optional:

```python
create_harness(
    model="bedrock/global.anthropic.claude-opus-5",  # "provider/name", a bare Bedrock id, or a Model instance
    effort="high",                          # "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    instructions=None,                      # domain text appended to the system prompt
    tools=None,                             # your tools, added alongside the built-ins
    mcp_servers=None,                       # MCP servers: a mcpServers JSON path or the mapping itself
    plugins=None,                           # your Strands plugins, added alongside the built-in ones
    builtin_tools=None,                     # None = the harness's defaults; a list pins names; a mapping edits (see below)
    background_tasks=None,                  # SDK Background Tasks policy; False to disable
    builtin_plugins=["todos", "environment"],  # built-in feature plugins by name; [] for none
    caching="auto",                         # cache system prompt, tools & history where supported; False off
    context_manager="auto",                 # "auto" | "agentic" | a ContextManager config/instance | False
    session=True,                           # True | {"id": ..., "dir": ...} | a SessionManager | False
    skills=True,                            # True (./.agent/skills) | path(s) or git URLs | an AgentSkills | False
    memory=True,                            # True (./.agent/memory) | {"dir": ..., "stores": [...]} | a MemoryManager | False
    interventions=None,                     # gate tool calls: "ask" | "smart" | a policy string | a .cedar file
    **agent_kwargs,                         # anything else goes straight to strands.Agent
)
```

The sections below walk through each of these in turn.

For a JSON-compatible definition, use `define_harness_agent_config()` and pass the result through
`harness_agent_kwargs_from_config()`. Executable values such as custom tools, models, intervention
handlers, sandboxes, and other live `Agent` fields are represented by module references; malformed
or wrong-language references fail instead of being ignored.

> **Want a terminal command instead of code?** The [`strands` CLI](https://github.com/strands-agents/harness-sdk/tree/main/strands-cli)
> wraps this same agent. Install it with `npm install -g @strands-agents/cli` for a `strands` command.

## Installation

```bash
pip install strands-harness
```

The default agent runs on Amazon Bedrock. To use another provider, grab the matching extra:

```bash
pip install "strands-harness[openai]"      # or [anthropic], [gemini] (the `google` provider), [ollama], [litellm]
```

## What you get by default

Out of the box, `create_harness()` gives you an agent that:

- **Runs on frontier models with reasoning on**, across Amazon Bedrock, Anthropic, OpenAI, and
  Google. The default is Claude Opus 4.8 on Amazon Bedrock, behind a tuned system prompt: explore
  before changing things, confirm before anything irreversible, verify before calling a task done.
- **Comes with working tools**: a shell, file tools (`read`, `write`, `edit`), web access, and
  `programmatic_tool_caller`, a sandbox where it writes code that chains, loops over, and
  parallelizes its other tools for more complex orchestration.
- **Manages its own context** so long tasks stay coherent and affordable. It summarizes older
  turns and moves bulky tool results out to storage, leaving a short reference to pull them back.
  The reused parts of each request are cached wherever the provider supports it.
- **Remembers.** Every conversation is saved to disk and resumable by session id, and long-term
  memory distills facts across conversations into markdown files it folds back into context.
- **Is just a `strands.Agent`.** Every default is overridable, and because the return value is a
  plain `Agent`, the full SDK is yours: interventions, hooks, MCP tools, and custom session
  backends all plug in.

Everything above is a default, not a constraint. Here's how to adjust each piece.

## Choosing a model

Pass a `provider/model` string, a bare model id, or a ready-made `Model` instance:

```python
create_harness(model="anthropic/claude-opus-5")  # Anthropic's API directly
create_harness(model="openai/gpt-5.6-sol")         # OpenAI
create_harness(model="google/gemini-3.5-flash")    # Google
create_harness(model="bedrock/global.anthropic.claude-opus-5")  # the default, spelled out
create_harness(model="bedrock-mantle/openai.gpt-5.6-sol")  # Bedrock's OpenAI-compatible endpoint

from strands.models.openai import OpenAIModel
create_harness(model=OpenAIModel(model_id="gpt-5.6-sol"))   # full control
```

The `provider/model` string is a shorthand with aliases for `bedrock`, `bedrock-mantle`, `anthropic`,
`openai`, `google`, `ollama`, and `litellm`. For any other provider, pass a `Model` instance (as above)
and it's used as-is. Reasoning effort is mapped to whatever each provider expects, so you set it once
for every provider:

```python
create_harness(effort="high")     # the default; minimal | low | medium | high | xhigh | max, as the provider offers them
create_harness(effort="auto")     # the provider's recommended level (high where supported)
create_harness(effort="off")      # no reasoning
```

A level the provider doesn't offer raises, so a typo or an unsupported request never passes
silently. When you pass a `Model` instance, `effort` (like `caching`) is ignored with a logged
warning: configure reasoning on the instance itself.

## Giving it your own instructions and tools

`instructions` adds a domain block after the built-in contract. Use it to give the agent its
identity, scope, and any rules you want it to follow. `tools` adds your own tools alongside
the built-in ones:

```python
from strands import tool

@tool
def get_ticket(ticket_id: str) -> str:
    """Fetch a support ticket by id."""
    return db.tickets.get(ticket_id)

agent = create_harness(
    instructions="You are a support assistant. Always link the ticket you're working on.",
    tools=[get_ticket],
)
```

Prefer a leaner or different tool set? `builtin_tools` takes two shapes. A **list pins** exactly
the tools named (`[]` turns them all off); a **mapping edits** the harness's default set, where `False`
removes a tool, `True` adds one, and a config dict enables *and* configures it. Four tools take a
config (each key is a keyword argument of the tool's factory): `shell` (`description`), `web_fetch`
(`model`, `transport`), `programmatic_tool_caller` (`allowed_tools`, `timeout`) and `subagent` (`max_depth`);
the rest are bool-only. `"*"` in a mapping is the base set (default `True`); write `"*": False` to
start from nothing and name what you want:

```python
create_harness(builtin_tools=["read"])                                   # just read
create_harness(builtin_tools=[])                                         # bring your own via `tools`
create_harness(builtin_tools={"subagent": False})                        # the defaults minus one
create_harness(builtin_tools={"web_fetch": {"model": "openai/gpt-5-mini"}})  # defaults, web_fetch configured
create_harness(builtin_tools={"subagent": {"max_depth": 1}, "programmatic_tool_caller": {"timeout": 60}})
create_harness(builtin_tools={"*": False, "read": True, "web_fetch": {}})   # pinned and configured in one literal
```

`BUILTIN_TOOL_NAMES` (exported from the package root) is the full list. Prefer the mapping form
for "the defaults minus X" (`{"subagent": False}`); a list pins every name it contains, so listing
`web_search` on a model without native search raises instead of quietly staying off (opt into the
Exa fallback with `{"web_search": "exa"}`).

`subagent` always runs in the background. By default, the model may also select background
execution for any other compatible tool. The harness waits for the work to finish and continues the
parent model with its result. Pass `background_tasks=False` to disable this behavior, or provide
an SDK `BackgroundTasksConfig` to control policy, concurrency, completion, and timeouts. Set
`wait_for_completion=False` only when the application will reinvoke the agent after a result is
ready.

## Delegating work to subagents

The agent can hand a subtask to another agent, exposed to it as a tool. Every call runs in its own
fresh conversation and returns only its final answer, so work that would otherwise flood the main
context (searching many files, a multi-step change, open-ended exploration) is kept out of the way.

There are two kinds of delegation, and they coexist. The built-in `subagent` tool is enabled by
default (via `builtin_tools`): the model delegates a task to a child built through this same
factory, so the child is a full harness member: it inherits the model, built-in tools and plugins,
skills, interventions, and the `plugins` and `hooks` you passed, so your approval gate and policy
plugins/hooks reach the delegate too, and your consumer `tools` are forwarded so the delegate can
be granted them (narrowable: it may use a subset, never more than you hold). A
propagated plugin/hook that keeps per-agent state should keep it in `agent.state`, not on `self`,
since the instance is shared with the child. By default the model picks the `generalist` role, may
write an ad-hoc role prompt, and may narrow the tool set (never widen it). Delegation depth is
bounded, so a child eventually can't delegate further. Drop it from `builtin_tools` to turn it off,
like any other built-in:

```python
create_harness(builtin_tools=["shell", "read", "write", "edit"])   # no subagent
```

The tool's model-facing parameters are derived from configuration. For a fully configured tool
(custom roles, model tiers, fixed prompts), build one with `make_subagent` and pass it via `tools`
with `subagent` dropped from `builtin_tools`. You supply the `builder`, a function that turns a
resolved `AgentSpec` into the child agent (typically calling `create_harness`); this is the seam
that makes the child a harness member. Delegation depth is bounded at two levels by default; pass
`max_depth` to change it. Each axis (`instructions`, `tools`, `mcp_servers`, `model`, `context`)
becomes a parameter, or not, depending on whether it is `Fixed`, `Inherit`, `Open`, or `Choice`:

```python
from strands_harness import create_harness
from strands_harness.tools import make_subagent, AgentSpec, Preset, Fixed, Inherit

NO_SUBAGENT = {"subagent": False}  # the defaults minus delegation; web_search stays provider-dependent

def build_reviewer(spec: AgentSpec):
    return create_harness(instructions=spec.instructions, builtin_tools=NO_SUBAGENT)

reviewer = make_subagent(
    builder=build_reviewer,
    presets={"reviewer": Preset(instructions="You review diffs.", description="reviews diffs")},
    instructions=Fixed(None),                     # the role owns the prompt; parameter removed
    model=Inherit(),
)

agent = create_harness(tools=[reviewer], builtin_tools=NO_SUBAGENT)
```

For focused expertise, wrap your own `Agent` instances with `Agent.as_tool()` and pass them in
`tools`; each becomes a tool the main agent can call, named after the agent's `name`. Every call
runs the specialist from a fresh conversation, so it's a clean, focused delegate rather than a
shared session. Give each a clear `name` and `description` so the model knows when to reach for it:

```python
from strands import Agent

researcher = Agent(
    name="researcher",
    description="Researches a topic and summarizes findings.",
    system_prompt="You research a topic and return a concise, sourced summary of what you found.",
)
reviewer = Agent(
    name="reviewer",
    description="Reviews code for correctness and style.",
    system_prompt="You review a diff for correctness and style, and list concrete issues with fixes.",
)

agent = create_harness(tools=[researcher.as_tool(), reviewer.as_tool()])
```

Each specialist is a full `Agent`, so it carries its own model, prompt, and tools. Build them
with `create_harness` too if you want them to share the harness's defaults.

## Connecting MCP servers

Point `mcp_servers` at a standard `mcpServers` config (a JSON file path, or the mapping inline)
and the harness connects each server, discovers its tools, and adds them to the tool list:

```python
create_harness(mcp_servers=".mcp.json")

create_harness(mcp_servers={
    "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]},
})
```

A server that fails to start contributes no tools rather than taking the agent down; set
`"continue_on_error": false` on a server to make its failure fatal. Each server's tools are namespaced
as `<server>_<tool>` (characters outside `[A-Za-z0-9_-]` in the server name become `_`) so two servers
exposing the same tool don't clash; set a server's `"prefix"` to choose the namespace, or
`"prefix": ""` to opt out.

## Reaching the web

Two of the built-ins put the web in reach. `web_fetch` is always on: it fetches a URL,
reduces it to text, and asks a small fast model to answer your prompt over the content, returning
the answer rather than the raw page so a long article never floods the conversation. The
summarizer runs on the small model for your main provider by default (so credentials line up);
override it through the tool's config in `builtin_tools`:

```python
create_harness(builtin_tools={"web_fetch": {"model": "anthropic/claude-haiku-4-5-20251001"}})
```

`web_search` is the other one: it lets the agent look things up on the web mid-answer. Where the
model provider has its own search (OpenAI, Google, GPT-5/GPT-6 models on `bedrock-mantle` via
Bedrock Web Search, and Anthropic in Python; TypeScript Anthropic support follows in a coming
`@strands-agents/sdk` release) the harness turns that on and there is no extra service involved. Elsewhere (Amazon Bedrock
Converse, other Mantle models, a `Model` instance) `web_search` is off by default with a logged
warning, and naming it explicitly raises. To search there anyway, opt into the Exa fallback with
`{"web_search": "exa"}`: the model gets a `web_search` tool backed by Exa's hosted search. It is
keyless to start; `EXA_API_KEY` in the environment lifts the rate limit. On a model with native
search the same setting keeps using the provider's search. Bedrock Web Search also needs the
`bedrock-websearch` IAM actions (in `AmazonBedrockFullAccess`); without them the request succeeds but
each search fails.

> [!WARNING]
> Web search through Exa sends every search query the model writes to Exa (exa.ai), a third-party
> service. Queries leave your environment and are subject to
> [Exa's privacy policy](https://exa.ai/privacy-policy).

```python
create_harness(model="openai/gpt-5.6-sol")                 # native search on, it's in the defaults
create_harness(builtin_tools={"web_search": "exa"})  # Bedrock: search through Exa (third party)
```

## Caching reused context

`caching` is on by default. The stable parts of a conversation (system prompt, tool definitions,
earlier turns) are cached where the provider supports it, so you're not billed to reprocess them
on every turn. The harness configures Amazon Bedrock and Anthropic direct with automatic cache points and cached
tool definitions; OpenAI, Gemini, Bedrock Mantle, and LiteLLM cache server-side on their own, so
there's nothing to configure or turn off. The only targets that can't cache are `ollama` and a
pre-built `Model` instance (its provider is unknown): there the default is a no-op with a warning
logged through Python's `logging`, but asking for caching explicitly (`caching=True`) raises for
an unsupported provider, so a deliberate request never passes silently (a `Model` instance only
warns). Turn off what the harness configures with `caching=False`:

```python
create_harness(caching=False)            # don't configure caching
```

## Remembering conversations

By default the harness persists every conversation to disk under `./.agent/sessions`. It does not
auto-resume, though: with no id it mints a fresh one each run, so a new run starts a new session.
To continue a conversation, read the minted id off the returned agent (`agent.session_id`) and
pass it back as `session={"id": ...}`, or supply your own stable id up front. Build a fresh agent
per request, keyed on the id:

```python
agent = create_harness(session={"id": "user-42"})
agent("Where did we leave off?")
```

Set `session={"dir": ...}` to choose where state lives (default `./.agent/sessions`). For
multi-host setups, pass your own `SessionManager` instance (for example `S3SessionManager`) as `session`
and it takes over. Turn persistence off with `session=False` for a throwaway run.

The default manager saves after each completed message, including tool results, so an interrupted
turn retains its saved progress. Text still streaming and unfinished tool calls are not yet saved.

## Long-term memory

Separate from sessions, the harness builds up long-term memory. It remembers facts that it learns about your
preferences and the project, saved in markdown files under `./.agent/memory` and folded back into context on
later turns. The agent also has a `search_memory` tool for on-demand recall. Long-term memory works across
conversations and sessions. Fact extraction from your conversation history runs every few turns on a small,
cheap model. The `generalist` subagent shares this memory read-only, so a delegate recalls what you've told
the agent but its subtasks never write back into your store.

Set `memory={"dir": ...}` to choose where the files live, or turn memory off with `memory=False`. To swap the
backend while keeping the harness's behavior, pass `memory={"stores": [...]}` (one or more SDK `MemoryStore`s); the harness
manages them under the same policy, and the `generalist` still shares them read-only. To replace the policy
itself, pass your own `MemoryManager` instance as `memory`.

Extraction runs in the background between turns, so a short run can end before the latest turns are saved.
If you own the agent's lifecycle, flush at shutdown to persist what's pending (the harness's CLI does this for you):

```python
if agent.memory_manager:
    await agent.memory_manager.flush()
```

```python
create_harness(memory=False)                    # no memory
create_harness(memory={"dir": "./my-memory"})   # custom location
create_harness(memory={"stores": [my_store]})   # swap the backend, keep the harness's policy
create_harness(memory=my_memory_manager)        # your own policy, used verbatim
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

Point elsewhere with `skills=` (a path, a git URL, or a list of them: the SDK's `SkillSources`), pass
a configured `AgentSkills` plugin to take over entirely, or pass `skills=False` to disable. Missing
directories are skipped.

## Built-in plugins

The harness ships two built-in feature plugins, both on by default:

- **`todos`** lets the agent keep a structured task list and re-surfaces it before each step so it
  stays on plan through longer tasks. The list lives in agent state, never in durable history.
- **`environment`** injects a short context block before each turn: the platform, current date,
  working directory, the project's `AGENTS.md` contents, and links to other `AGENTS.md`/`README.md`
  files a couple of levels down (links, not contents, so the block stays small). Everything is read
  through the agent's sandbox, so it works whether the agent runs locally, in Docker, or over SSH.

`builtin_plugins` selects these by name, the same way `builtin_tools` does: pass a subset, or
`[]` to turn them off:

```python
create_harness(builtin_plugins=[])              # no built-in plugins
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

```python
create_harness(interventions="ask")     # approve every tool call
create_harness(interventions="smart")   # an LLM risk classifier flags risky calls for approval

# a natural-language policy becomes the classifier's rubric
create_harness(interventions="Read-only, but writes under ./out are fine")

# a Cedar policy file (needs `pip install 'strands-agents[cedar]'`)
create_harness(interventions="./agent.cedar")

# full control: your own handler (Slack approval, custom trust, a Cedar principal resolver)
from strands.vended_interventions.hitl import HumanInTheLoop
create_harness(interventions=HumanInTheLoop(ask=my_slack_ask, enable_trust=True))

# layer a policy engine under a human gate
create_harness(interventions=["./agent.cedar", "ask"])
```

Presets pause via the SDK's interrupt/resume, so a service can collect approval asynchronously; with
a `session_id` the pending approval survives a process restart. A `subagent` child inherits the
policy, so a delegate can't be used to bypass it, and the tool calls `programmatic_tool_caller` makes
from inside its sandbox run through the same executor, so they are gated too (a denied call raises in
the code; one that needs interactive approval is refused). This is sugar over the SDK's `HumanInTheLoop` and
`CedarAuthorization`; pass those directly for anything the presets don't cover. (The `strands` CLI
exposes the same via `--interventions`, prompting inline in the terminal.)

## It's just a Strands Agent

The return value is a regular `strands.Agent`, so the full SDK is available to you. Any
keyword the harness doesn't name is passed straight through to `Agent`, and your explicit
value always wins over the harness default. That's the seam for SDK-native features: pass your
own `plugins`, `interventions`, or any other `Agent` keyword alongside the harness's, and they compose.

```python
from strands.vended_interventions.hitl import HumanInTheLoop

agent = create_harness(
    checkpointing=True,
    plugins=[MyMetricsPlugin()],            # your Strands plugin, added to the harness's built-ins
    interventions=[HumanInTheLoop()],       # an SDK feature, wired straight through
    context_manager="agentic",              # model-driven context instead of "auto"
)

# And you can keep customizing after construction:
agent.system_prompt += "\n\nAlways cite file paths as file:line."
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
instance), reach for the Python API. That's what it's there for.

## The vended prompt

The system prompt is also available on its own, in case you want to build on it directly (for
example, a serving layer that injects a timestamp or request context each turn):

```python
from strands_harness import HARNESS_CONTRACT, build_system_prompt

prompt = build_system_prompt(
    instructions="You are a data-migration assistant.",
    context_parts=[f"Current time: {now}"],
)
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

Apache-2.0. See [LICENSE](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/LICENSE).
