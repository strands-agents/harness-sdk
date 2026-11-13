# The `subagent` tool

`subagent` is the harness's built-in **delegation** tool. It lets the parent model hand a
self-contained subtask to a freshly built child agent that runs in its own context and returns a
single final report, so intermediate work never piles up in the parent's conversation.

The tool is the SDK's vended subagent (`strands.vended_tools.subagent.make_subagent`). The
authority-mode model (`Fixed` / `Inherit` / `Open` / `Choice`), presets, context sharing, interrupts and
the depth guard are documented with the SDK tool; this page covers only what the harness adds.

## Enabling and disabling

`subagent` is a name in `builtin_tools` like any other built-in, and is on by default:

```python
from strands_harness import create_harness

create_harness()                                              # subagent enabled (default)
create_harness(builtin_tools={"subagent": False})             # subagent disabled
create_harness(builtin_tools={"subagent": {"max_depth": 1}})  # one level of delegation
create_harness(builtin_tools={"subagent": {"max_depth": 0}})  # no subagent tool at all
```

## What the default wiring adds

`build_default_subagent` passes the SDK tool a builder that rebuilds the child through
`create_harness` from the parent's own arguments, so a delegate inherits the model, thinking,
caching, plugins, hooks, interventions and sandbox. On top of that:

- **Tools.** `tools` is a multiple `Choice` over the parent's enabled built-ins (minus `web_search`,
  which the child resolves for its own model) and its named consumer tools. `subagent` stays
  selectable, bounded by the depth guard.
- **MCP servers.** The child always gets every MCP client the parent holds (shared, not
  reconnected). Servers are not a model-facing parameter.
- **Memory.** The delegate gets a recall-only view of the parent's store(s): it can search but never
  write. A parent without memory builds delegates without memory.
- **Context manager.** A `ContextManager` instance holds per-agent state, so a delegate gets the default
  strategy instead of sharing the parent's.
- **Context sharing.** `context` is a `Choice` of `none` / `all` / `no_tools`; the `generalist` preset
  defaults to `none`.
- **Background.** The harness always runs `subagent` in the background (see Background Tasks).
- **Sessions** are forced off for children.

## Building a custom `subagent`

Drop `subagent` from `builtin_tools` and pass your own SDK tool via `tools`. The builder may be sync or
async.

```python
from strands_harness import create_harness
from strands_harness.tools import AgentSpec, Choice, Preset, make_subagent

NO_SUBAGENT = {"subagent": False}

def my_builder(spec: AgentSpec):
    return create_harness(instructions=spec.instructions, model=spec.model, builtin_tools=NO_SUBAGENT)

subagent = make_subagent(
    builder=my_builder,
    presets={"reviewer": Preset(instructions="Review a diff.")},
    model=Choice(["bedrock/anthropic.haiku", "bedrock/anthropic.opus"]),
)

agent = create_harness(builtin_tools=NO_SUBAGENT, tools=[subagent])
```

## Migrating from the harness-owned tool

The harness used to ship its own copy of this tool. Moving to the SDK's changes:

- **No `mcp_servers` parameter.** `make_subagent(mcp_servers=, inherited_tools=, inherited_mcp_servers=)`
  are gone; pass `tools=Choice([...], multiple=True)` for a selectable tool set.
- **`AgentSpec`** has `name`, `agent_type`, `instructions`, `tools` and `model`; `task`, `context`,
  `last_messages` and `mcp_servers` are gone. `Preset` no longer takes `context` / `last_messages`.
- **Depth key.** The remaining budget lives at `agent.state.get("strands.subagent_depth")` (was
  `"subagent_depth"`).
- **`max_depth: 0`** removes the tool instead of registering one that always refuses.
- **Content-filtered or refused children** come back as a tool error quoting any partial output (as
  before). A cancelled child is an error only when its own cancel signal fired.
- **Interrupt ids** from a child are namespaced (`v1:subagent:<toolUseId>:<id>`) and survive a session
  restore.
- **Model-facing text.** Parameter descriptions are the SDK's; the tool description is unchanged.
