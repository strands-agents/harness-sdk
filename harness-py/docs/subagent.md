# The `subagent` tool

`subagent` is the harness's built-in **delegation** tool. It lets the parent model hand a
self-contained subtask to a freshly built child agent that runs in its own context and returns a
single final report — so intermediate work (searching many files, a multi-step edit, open-ended
exploration) never piles up in the parent's conversation.

What makes it unusual is that **its model-facing schema is derived from configuration**. The same
code produces a three-line schema for a locked-down harness and a five-parameter schema for an
open research harness, with no forking. This doc explains the model and shows the exact tool specs
each configuration generates (every spec below is copied verbatim from
`make_subagent(...).tool_spec`).

---

## Enabling and disabling

`subagent` is just a name in `builtin_tools`, exactly like `shell` / `read` / `write` / `edit` /
`web_fetch` / `programmatic_tool_caller`. It is on by default:

```python
from strands_harness import create_harness

create_harness()                                             # subagent enabled (default)
create_harness(builtin_tools=["shell", "read", "write"])     # subagent disabled (name dropped)
```

To ship a **custom** delegation tool instead of the default one, drop `subagent` from
`builtin_tools` and pass your own `make_subagent(...)` result via `tools`.

---

## The authority-mode model

The child's configuration has four axes. Each axis takes an **authority mode** that decides whether
it becomes a model-facing parameter, and how it is validated:

| Mode | Meaning | Adds a parameter? |
|------|---------|-------------------|
| `Fixed(value)` | The developer pins the value. | No |
| `Inherit()` | The child takes the parent's value. | No |
| `Open()` | The model writes the value freely. | Yes — a `string` |
| `Choice(options, multiple=False)` | The model picks from a developer-supplied set **by name**. Each entry in `options` is a bare name (a string) or an `Option(name, value=name, description="")`; the picked name maps back to the option's `value`, and any descriptions render into the parameter's `description`. With `multiple=True` the model may pick several. | Yes — an `enum`, or an `array` of `enum` when `multiple=True` (for `tools`, **re-validated at call time**) |

The four axes: **`instructions`** (the child's system prompt), **`tools`** (which tools the child
may use), **`model`** (which model it runs on), **`context`** (how much of the parent's conversation
it sees — `"none"` (fresh), `"all"` (full history, tool calls and results included), or
`"no_tools"` (text turns only — tool calls and their results removed), optionally capped to the last N messages via a
companion `last_messages` parameter).

On top of the axes, **`presets`** define named roles. A preset (`agent_type`) can pin
`instructions`, `tools`, `model`, and `context` for that role; a model-supplied axis argument
overrides the preset's value for that axis, and the axes govern any fields a preset leaves unset.
Presets always add an `agent_type` enum parameter. Two rules at the edges: writing ad-hoc
`instructions` selects **no** preset (it's an explicit "not this role"), and a provided `agent_type`
must be an exact preset name — an unknown value is rejected, never guessed or dropped.

### How the schema is derived

- `task` (string) is **always** present and always required.
- `agent_type` enum is added iff `presets` is non-empty.
- `instructions` param is added iff its mode is `Open` (free string) or `Choice` (enum).
- `tools` param is added iff its mode is `Choice` (an array of enum when `multiple=True`, which is
  the default; a single enum otherwise).
- `model` param is added iff its mode is `Choice` (enum).
- `context` param is added iff its mode is `Choice` (enum). When the offered modes include a
  history-bearing one (anything but `none`), a companion `last_messages` integer is also added, so
  the model can cap the shared context to the last N messages.

`Fixed` and `Inherit` never add a parameter — they are resolved entirely on the developer/parent
side.

### `make_subagent` defaults

```python
make_subagent(
    builder,                       # required: turns a resolved AgentSpec into a child Agent
    presets=None,                  # dict[str, Preset]; adds the agent_type enum
    default_preset=None,           # falls back to the first preset if omitted
    instructions=Open(),           # default
    tools=None,                    # default becomes Choice(inherited_tools, multiple=True)
    model=Inherit(),               # default
    context=Fixed("none"),         # default (fresh conversation)
    inherited_tools=(),            # the set the default tools Choice offers
    max_depth=DEFAULT_SUBAGENT_MAX_DEPTH,   # = 2
    name="subagent",
)
```

So a bare `make_subagent(builder=...)` exposes `task`, `instructions` (Open), and `tools` (a
multiple `Choice` over `inherited_tools`), inherits the model, and starts the child from a fresh
conversation.

---

## Worked examples

Each example shows the configuration, the generated `description`, and the generated `inputSchema`.

### 1. Default wiring (what ships)

`build_default_subagent(build_agent, parent_config)` — the `generalist` preset, `instructions`
`Open`, `tools` a multiple `Choice` over the parent's built-ins **plus** the parent's consumer tools
(only `web_search`, resolved per model rather than selected, is excluded — `subagent` stays in, so a delegate can
sub-delegate, bounded by the depth guard), `model` `Inherit`, and `context`
`Choice(["none", "all", "no_tools"])` so the model can opt into sharing parent context (the
`generalist` preset keeps `"none"` as the default, so a bare call stays isolated).

Here the parent holds the default built-ins plus one consumer tool, `deploy_service`:

**description**

```
Delegate a self-contained task to a subagent that runs in its own context and returns a final report. Reach for this when a subtask would otherwise flood your context with intermediate work and you only need its conclusion. Do not poll for progress or redo its work.

Available subagents (agent_type):
- generalist: a general-purpose agent for a focused subtask that runs in its own context
```

**inputSchema**

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "The self-contained task, including all context the subagent needs. It starts from a blank conversation and cannot ask follow-up questions."
    },
    "agent_type": {
      "type": "string",
      "enum": ["generalist"],
      "description": "Which subagent role to use. Omit to use the default."
    },
    "instructions": {
      "type": "string",
      "description": "A system prompt defining the subagent's role."
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["shell", "read", "write", "edit", "web_fetch", "programmatic_tool_caller", "subagent", "deploy_service"]
      },
      "description": "Subset of tools to grant the subagent. Fewer is safer; it cannot exceed your own."
    },
    "context": {
      "type": "string",
      "enum": ["none", "all", "no_tools"],
      "description": "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full history including tool calls and their results — can be large), 'no_tools' (text turns only — tool calls and their results removed). More context costs more tokens."
    },
    "last_messages": {
      "type": "integer",
      "description": "Optional: limit the shared context to the last N messages. Omit to share all of the selected context."
    }
  },
  "required": ["task"]
}
```

Note `web_search` is **absent** from the `tools` enum (it follows the parent's setting, resolved
for the delegate's own model), while `subagent` **is** offered (a delegate may sub-delegate; runaway recursion
is bounded by the depth guard, not by withholding the tool) — as is the consumer tool
`deploy_service`. `context` defaults to `"none"` (isolated) via the
`generalist` preset; the model opts into sharing by setting it, optionally with `last_messages`.

**Example calls the model might emit**

```jsonc
// Bare delegation — default generalist role, inherits everything, isolated (context "none").
{ "task": "Find every call site of `resolve_model` in harness-py and list the files and line numbers." }

// Share the last 5 messages of the conversation, minus tool calls, with the delegate.
{ "task": "Continue the refactor we were just discussing.", "context": "no_tools", "last_messages": 5 }

// Ad-hoc role prompt + restricted to read-only tools.
{
  "task": "Audit harness-py/src for TODO/FIXME comments and summarize them by file.",
  "instructions": "You are a read-only code auditor. Do not modify anything.",
  "tools": ["read", "shell"]
}
```

### 2. Minimal — `make_subagent(builder=...)`, all defaults, no presets

```python
make_subagent(builder=my_builder)
```

No presets ⇒ no `agent_type`. `instructions` is `Open`, `tools` is a multiple `Choice` over an empty
`inherited_tools` (so the enum is empty here — supply `inherited_tools=[...]` to populate it).

**inputSchema**

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "The self-contained task, including all context the subagent needs. It starts from a blank conversation and cannot ask follow-up questions."
    },
    "instructions": {
      "type": "string",
      "description": "A system prompt defining the subagent's role."
    },
    "tools": {
      "type": "array",
      "items": { "type": "string", "enum": [] },
      "description": "Subset of tools to grant the subagent. Fewer is safer; it cannot exceed your own."
    }
  },
  "required": ["task"]
}
```

### 3. Multiple named presets (a coding harness)

```python
make_subagent(
    builder=my_builder,
    presets={
        "generalist": Preset(instructions="General-purpose delegate.",
                             description="a general-purpose subagent"),
        "researcher": Preset(instructions="You research and synthesize; you do not edit files.",
                             tools=["read", "web_fetch"],
                             description="read-only research over the codebase and the web"),
        "reviewer":   Preset(instructions="You review a diff and report risks.",
                             tools=["read", "shell"],
                             description="a code reviewer that inspects but never writes"),
    },
    instructions=Fixed(None),   # each preset owns its prompt; no ad-hoc instructions param
    tools=Inherit(),            # non-preset roles inherit the parent's tools; no tools param
)
```

The preset descriptions are rendered into the tool description so the model knows when to pick each
role. Because `instructions` is `Fixed` and `tools` is `Inherit`, neither adds a parameter — the
only knobs are `task` and `agent_type`.

**description**

```
Delegate a self-contained task to a subagent that runs in its own context and returns a final report. Reach for this when a subtask would otherwise flood your context with intermediate work and you only need its conclusion. Do not poll for progress or redo its work.

Available subagents (agent_type):
- generalist: a general-purpose subagent
- researcher: read-only research over the codebase and the web
- reviewer: a code reviewer that inspects but never writes
```

**inputSchema**

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "The self-contained task, including all context the subagent needs. It starts from a blank conversation and cannot ask follow-up questions."
    },
    "agent_type": {
      "type": "string",
      "enum": ["generalist", "researcher", "reviewer"],
      "description": "Which subagent role to use. Omit to use the default."
    }
  },
  "required": ["task"]
}
```

**Example call**

```jsonc
{ "agent_type": "researcher", "task": "Compare our retry logic in http_client.py against the SDK's and note divergences." }
```

### 4. Regulated harness — everything pinned, the model only picks a role

```python
make_subagent(
    builder=my_builder,
    presets={"triager": Preset(instructions="Classify the ticket.",
                               tools=["read"], description="ticket triage")},
    instructions=Fixed(None),
    tools=Fixed(["read"]),
    model=Fixed("bedrock/global.anthropic.claude-haiku-4-8"),
)
```

Every axis is `Fixed`, so the schema collapses to just `task` + `agent_type`. The model cannot write
a prompt, change the tool set, or pick a model — the developer decided all of it.

**inputSchema**

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "The self-contained task, including all context the subagent needs. It starts from a blank conversation and cannot ask follow-up questions."
    },
    "agent_type": {
      "type": "string",
      "enum": ["triager"],
      "description": "Which subagent role to use. Omit to use the default."
    }
  },
  "required": ["task"]
}
```

### 5. Model tiers + selectable context (`Choice` on two axes)

```python
make_subagent(
    builder=my_builder,
    model=Choice(
        [
            Option("haiku", "bedrock/anthropic.haiku", "cheap/fast"),
            Option("opus", "bedrock/anthropic.opus", "best quality"),
        ],
    ),
    context=Choice(["none", "all", "no_tools"]),
    tools=Fixed(None),   # no tools param; instructions stays Open (the default)
)
```

`Choice` on `model` and `context` adds an enum for each; because the `context` enum offers a
history-bearing mode, a companion `last_messages` integer is added too. This is the "let the model
route cheap work to Haiku and hard work to Opus, and decide how much conversation to carry"
configuration. The model picks a short **name** (`"haiku"`), which maps back to that option's
**value** (the `"bedrock/anthropic.haiku"` string) — so the enum stays readable and the value can be
anything, including a pre-built `Model` instance. Each `Option`'s description is rendered into that
parameter's description.

**inputSchema**

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "The self-contained task, including all context the subagent needs. It starts from a blank conversation and cannot ask follow-up questions."
    },
    "instructions": {
      "type": "string",
      "description": "A system prompt defining the subagent's role."
    },
    "model": {
      "type": "string",
      "enum": ["haiku", "opus"],
      "description": "Which model the subagent runs on.\nOptions:\n- haiku: cheap/fast\n- opus: best quality"
    },
    "context": {
      "type": "string",
      "enum": ["none", "all", "no_tools"],
      "description": "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full history including tool calls and their results — can be large), 'no_tools' (text turns only — tool calls and their results removed). More context costs more tokens."
    },
    "last_messages": {
      "type": "integer",
      "description": "Optional: limit the shared context to the last N messages. Omit to share all of the selected context."
    }
  },
  "required": ["task"]
}
```

**Example call**

```jsonc
{
  "task": "Draft a migration plan for the new session format.",
  "model": "opus",
  "context": "no_tools",
  "last_messages": 8
}
```

### 6. `Choice` with an explicit allowed set

```python
make_subagent(
    builder=my_builder,
    tools=Choice(["read", "write", "edit"], multiple=True),   # explicit set, not the parent's real tools
    instructions=Fixed("You apply a focused edit."),
)
```

`Choice(["read","write","edit"], multiple=True)` fixes the offerable set explicitly (rather than
inheriting the parent's), still clamped to that set at call time. `instructions` is `Fixed`, so it
adds no param.

**inputSchema**

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "The self-contained task, including all context the subagent needs. It starts from a blank conversation and cannot ask follow-up questions."
    },
    "tools": {
      "type": "array",
      "items": { "type": "string", "enum": ["read", "write", "edit"] },
      "description": "Subset of tools to grant the subagent. Fewer is safer; it cannot exceed your own."
    }
  },
  "required": ["task"]
}
```

### 7. `instructions` as `Choice` (canned prompts)

```python
make_subagent(
    builder=my_builder,
    instructions=Choice(
        [
            Option("terse", "Be terse."),
            Option("stepwise", "Explain your reasoning step by step."),
        ],
    ),
    tools=Fixed(None),
)
```

`Choice` turns `instructions` into an enum of developer-authored prompts instead of a free string.
The model picks a short **name** (`"terse"`); the full prompt is that option's **value**, so a long
system prompt never bloats the tool schema or the parent's context — only the names do. (Passing
bare strings instead, `Choice(["Be terse.", …])`, makes each prompt its own name, which *does* put
the full text in the enum.)

**inputSchema**

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "The self-contained task, including all context the subagent needs. It starts from a blank conversation and cannot ask follow-up questions."
    },
    "instructions": {
      "type": "string",
      "enum": ["terse", "stepwise"],
      "description": "A system prompt defining the subagent's role."
    }
  },
  "required": ["task"]
}
```

---

## What happens at call time (not just in the schema)

The schema is only half the story — several guarantees are enforced when the tool actually runs, so
they hold even if a model sends something the schema didn't intend:

- **The tools `Choice` is clamped, not just advertised.** `_resolve_spec` intersects the model's
  requested `tools` with the allowed set, so an out-of-set name is silently dropped, never granted. A
  child can never gain a capability the parent lacks. (A `Choice` model value is likewise mapped back
  to the real model object.)
- **Delegation depth is bounded.** `max_depth` (default `2`) is tracked on `agent.state["subagent_depth"]`.
  A parent that has never delegated starts at `max_depth`; each child is built with one less; at `0`
  the tool refuses with an error result instead of building another child. So parent → child →
  grandchild(refuses) is exactly two levels; `create_harness(builtin_tools={"subagent": {"max_depth": 1}})`
  sets the bound on the default tool. The parent's connected MCP clients are forwarded (shared,
  not reconnected), narrowable per server through the `mcp_servers` axis.
- **Interrupts propagate for human-in-the-loop.** If a child hits an interventions gate, the tool
  surfaces a `ToolInterruptEvent` to the parent and resumes the same child on the parent's response —
  the approval isn't swallowed as a bogus success. The child inherits the parent's `interventions`, so
  a delegate can't be used to bypass an approval policy.
- **Cancellation propagates to the child.** While the child streams, the tool watches the surrounding
  tool-execution's cooperative cancel signal (mirroring the SDK's `_AgentAsTool`); when it fires, the
  child is cancelled too, so a long delegation doesn't run on after the parent has been told to stop.
  A cancelled child stops with `stop_reason == "cancelled"` and is reported as an **error** result
  (cancellation is data, not a success), and the watcher is always torn down when the child finishes.
- **`all` forks the parent's messages; `no_tools` renders a text block.** `context="none"` starts
  fresh (the default). `"all"` hands the child the parent's actual messages — every text turn, tool
  call with its input, and tool result with its content (images and documents included) as real
  content blocks — so the child has the parent's evidence and never redoes its reads. They travel as
  the child's prompt (a `Messages` list the SDK appends to its history) followed by the task, which
  a short preamble frames: *the conversation so far is the parent agent's; you are the subagent it
  delegated to at this point*. Two edits keep that history valid: tool calls still in flight — the
  parent's own delegating `subagent` call (the task *is* that call) and any parallel siblings, none
  of which has a result yet — are dropped, and when the history then ends on a user turn (tool
  results) the task joins that message instead of following it as a second user turn. The parent's
  `reasoningContent` blocks are dropped too: they are its model's own signed state, and a child on
  another model rejects them (Bedrock: *User messages cannot contain reasoning content*); Claude
  children still work — and still think — without them (verified live, both history shapes). Two things the fork can't fix: a tool result the parent's
  offloader already replaced with a preview arrives as that preview (the reference points at the
  parent's offload dir, which the child can't read — re-run the tool in the child), and models
  without streaming tool use on Bedrock (Llama, Mistral) can't take a tool-bearing history at all.
  `last_messages=N` keeps the last N messages, widened back to the nearest boundary the SDK's
  sliding-window manager cuts at (a user turn that is not a tool result — the SDK's
  `find_valid_trim_point` rule, duplicated in the harness until the SDK exports it) so
  a `toolResult` is never split from its `toolUse` — it can share a few more than N, never fewer.
  Size is not the fork's job. The child is a full harness agent with the SDK's context management
  (`context_manager="auto"`): before its first model call the SDK estimates the projected input
  tokens against the *child's* `model.context_window_limit` and, over the threshold, summarizes the
  oldest turns at a valid tool-pair boundary — so the same forked history fits a child pinned to a
  smaller model than the parent's, without a byte cap here. (A child built with
  `context_manager=False` gets no such safety net: cap with `last_messages` or use `no_tools`.)
  The child's system prompt and tool set differ from the parent's, so this is a copy of the
  history, not a prompt-cache hit. A history carrying tool blocks needs a tool
  config on the request (Bedrock rejects it otherwise), so a toolless child (`tools=Fixed([])` with
  no tool-bearing plugins) can't take `all`; the failure surfaces as a `Subagent error` result.
  `"no_tools"` strips tool calls and results, which leaves a history that could not be replayed
  faithfully, so it is rendered instead: a `<parent_context>…</parent_context>` block of `role:
  text` entries prepended to the child's **first user message**, with continuation lines indented
  and a literal `<parent_context>` / `</parent_context>` inside content escaped to
  `<\parent_context>` / `<\/parent_context>` (quoted text can neither pose as a turn nor close the
  block), followed by a one-line preamble framing the child. `last_messages` counts rendered entries
  there (tool-only messages render empty and don't spend a slot), and a parent that was itself
  delegated to with `no_tools` has its own framed block stripped before re-rendering, so a
  grandchild sees its parent's task rather than nested ancestor transcripts.
- **The child is a full harness member.** It's built through the injected `builder` (the
  `create_harness` factory) with the parent's config, so it inherits the model, built-in tools, built-in
  plugins, skills, interventions, the consumer `plugins`/`hooks`, and the consumer `tools` (narrowable —
  the delegate may be granted a subset), plus the parent's MCP clients (narrowable per server).

---

## Building a custom `subagent` and wiring it in

```python
from strands_harness import create_harness
from strands_harness.tools import make_subagent, Preset, Fixed, Choice

def my_builder(spec):
    # spec is an AgentSpec: task, agent_type, instructions, tools, model, context (already clamped).
    # Turn it into a child Agent however your harness builds agents.
    ...

subagent = make_subagent(
    builder=my_builder,
    presets={"reviewer": Preset(instructions="Review a diff.", tools=["read", "shell"])},
    model=Choice(["bedrock/anthropic.haiku", "bedrock/anthropic.opus"]),
    tools=None,               # default: a multiple Choice over inherited_tools
    inherited_tools=["read", "shell", "edit"],
)

agent = create_harness(
    builtin_tools=["shell", "read", "write", "edit"],   # note: no "subagent" here
    tools=[subagent],                                   # supply the custom one instead
)
```

> Reference: this tool is the first cut of design *0017-subagents*. It lives in
> `harness-py/src/strands_harness/tools/subagent.py` (`make_subagent` / `build_default_subagent`), with a
> parity port in `harness-ts/src/tools/subagent.ts` (`makeSubagent` / `buildDefaultSubagent`). Both wire
> `subagent` as a config-derived built-in tool, and both hand the delegate a recall-only memory view;
> the one seam that differs is where the SDKs do — interrupts propagate by throwing in TS rather than
> by yielding an event. See the root `AGENTS.md` for the full parity notes.
