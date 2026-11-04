This tutorial introduces the Strands Agents `Plugin` abstraction. A plugin is a single Python class that bundles `@hook`\-decorated lifecycle callbacks, `@tool`\-decorated methods, and any plugin-resident state into one installable unit you attach to an agent via `Agent(plugins=[...])`. By the end you will know how to lift any existing `HookProvider` into a `Plugin`, how to expose hook-collected state as a tool the agent itself can call, how to reason about isolated vs. shared plugin instances, and how registration order drives middleware-style composition.

## Tutorial Details

| Information | Details |
| --- | --- |
| **Strands Features** | `Plugin`, `@hook`, `@tool`, `BeforeToolCallEvent`, `AfterToolCallEvent`, `BeforeModelCallEvent`, `AfterModelCallEvent`, `cancel_tool` |
| **Agent Pattern** | Single agent with one or more attached plugins; multi-agent composition through registration order |
| **Tools** | Two small in-memory tools (`get_weather`, `lookup_user`) defined in Section 0; one `@tool` (`get_audit_metrics`) bundled inside `MetricsPlugin` |
| **Model** | Claude Haiku 4.5 on Amazon Bedrock (any Strands-supported model works) |

## How It Works

-   **Section 1 — Raw hooks → Plugin transition.** The same two-event handler is implemented twice (once as a `HookProvider`, once as a `Plugin`); a captured firing sequence proves the two are observably equivalent.
-   **Section 2 — `@tool` inside a plugin.** `MetricsPlugin` collects per-tool call counts via hooks and exposes them through a `get_audit_metrics` tool the agent can call.
-   **Section 3 — Plugin state and sharing.** Two agents with their own plugin instances stay isolated; two agents sharing one plugin instance accumulate combined state.
-   **Section 4 — Composing multiple plugins.** `SecurityPlugin`, `LoggingPlugin`, and `MetricsPlugin` are stacked in two different orders, demonstrating that registration order drives execution order.

## Prerequisites

-   Python 3.10 or later.
-   An AWS account with [Amazon Bedrock](https://aws.amazon.com/bedrock/) model access (Claude Haiku 4.5 by default; see the notebook for how to swap models).
-   Basic familiarity with Strands Agents ([Quickstart](https://strandsagents.com/latest/documentation/docs/user-guide/quickstart/)). We recommend completing [`13-human-in-the-loop`](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/13-human-in-the-loop/) first for hooks fundamentals.

## Tutorial Structure

```plaintext
14-plugins/
├── README.md
├── requirements.txt
└── plugins-in-strands.ipynb
```

| File | Description |
| --- | --- |
| [plugins-in-strands.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/14-plugins/plugins-in-strands.ipynb) | Single end-to-end notebook covering all four plugin concepts in five sections plus a recap. |

## What You’ll Learn

-   Lift a `HookProvider` into a `Plugin` with `@hook`\-decorated methods.
-   Bundle a `@tool` inside a plugin so the agent can introspect plugin-collected state.
-   Reason about isolated vs. shared plugin instances across multiple agents.
-   Compose multiple plugins and predict execution order from registration order.

## Installation

```bash
pip install -r requirements.txt
```

Then open [plugins-in-strands.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/14-plugins/plugins-in-strands.ipynb) and run cells top-to-bottom.

## Related Tutorials

-   [`13-human-in-the-loop`](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/13-human-in-the-loop/) — hooks fundamentals; this tutorial assumes you have seen `HookProvider`.
-   [`15-skills`](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/15-skills/) — `AgentSkills` is a real plugin you can install today; come back to this tutorial after that one to see how `AgentSkills` is built.
-   [`16-hooks-lifecycle`](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/) — full event catalogue and writable fields.

## Next Steps

-   Build your own plugin that adds a system-prompt fragment plus an audit tool.
-   Explore the multi-agent hook events (`BeforeNodeCallEvent`, `AfterNodeCallEvent`) once you move to `Graph` or `Swarm` orchestration.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/14-plugins)
