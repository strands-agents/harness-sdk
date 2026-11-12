**Strands harness** is a state-of-the-art, fully assembled harness you can use in one import. It comes with benchmarked defaults for tools, context management, sessions, memory, and hooks, plus a tuned system prompt, so you start with an optimized agent instead of assembling an agent harness yourself piece by piece.

## Get one running

You do not have to pass anything. Import it, instantiate it, then give the agent a task:

(( tab "Python" ))
```python
# pip install strands-harness
from strands_harness import create_harness

agent = create_harness()
agent("Research the top three vector databases, compare pricing and limits, and write it up in comparison.md")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// npm install @strands-agents/harness
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness()
await agent.invoke("Research the top three vector databases, compare pricing and limits, and write it up in comparison.md")
```
(( /tab "TypeScript" ))

Amazon Bedrock is the default. See [choose a model](/docs/user-guide/harness/configure/model/index.md) to run on Anthropic, OpenAI, Google, or Ollama.

Strands harness is open source — browse the source on GitHub:

(( tab "Python" ))
[`harness-py`](https://github.com/strands-agents/harness-sdk/tree/main/harness-py) — the Python package.
(( /tab "Python" ))

(( tab "TypeScript" ))
[`harness-ts`](https://github.com/strands-agents/harness-sdk/tree/main/harness-ts) — the TypeScript package.
(( /tab "TypeScript" ))

## Make it yours

Strands harness is a powerful general-purpose harness that you can customize. It is opinionated in its implementation but not restrictive: every default is overridable, and what you get back is a standard Strands `Agent` with no wrapper or hidden abstraction. As your use case gets more specific, override the defaults that matter for it and keep the rest.

Strands harness is built on the [Strands Harness SDK](/docs/user-guide/sdk/index.md). If you want to build your own harness from the ground up, you can always use the Strands Harness SDK directly, with the same configuration you already have on Strands harness.

## What the default harness does

Without any customization, Strands harness hands you back a fully functional agent. Every default below can be narrowed, swapped, or turned off; the linked page shows how:

-   Runs on the [model of your choice](/docs/user-guide/harness/configure/model/index.md), with providers across Amazon Bedrock, Anthropic, OpenAI, and Google, plus Ollama for running locally, and reasoning turned on.
-   Follows a [tuned system prompt](/docs/user-guide/harness/configure/tools-and-instructions/index.md): explore first, then act, confirm before anything irreversible, and verify before finishing.
-   Has a [shell and file tools](/docs/user-guide/harness/tools/shell-and-files/index.md) (`read`, `write`, `edit`) and [web access](/docs/user-guide/harness/tools/web-access/index.md).
-   [Manages its own context window](/docs/user-guide/harness/configure/context-and-caching/index.md) (the limited span of text the model reads at once), setting bulky tool results aside as a task grows, and caches the reused parts of each request to save time and cost.
-   Keeps [long-term memory](/docs/user-guide/harness/configure/memory/index.md) across runs, and can pick up an earlier [conversation](/docs/user-guide/harness/configure/sessions/index.md) when you give it a session id.
-   Hands open-ended subtasks to a [built-in helper agent](/docs/user-guide/harness/configure/subagents/index.md), and can track multi-step work with an opt-in [checklist](/docs/user-guide/harness/tools/todos-and-environment/index.md).
-   Loads [Agent Skills](/docs/user-guide/harness/configure/skills/index.md) when present, and lets the model [orchestrate its own tools in code](/docs/user-guide/harness/tools/programmatic-tool-calling/index.md).

## Explore Strands harness

[Quickstart](./quickstart/index.md)Install the library or the CLI and run your first Strands harness agent.

[Configure the agent](./configure/model/index.md)Point Strands harness at the model of your choice. Add tools and override defaults as needed.

[Compose with the Strands Harness SDK](./composing-with-sdk/index.md)How Strands harness builds on the Strands Harness SDK.

[Configuration reference](./reference/configuration/index.md)Every factory option in one table: name, default, and purpose.

## Where Strands harness fits

Strands is an open source toolkit for agent builders. Strands harness is the fastest way to get an optimized, pre-configured agent that you can customize to your use case. It is built on top of the Strands Harness SDK, and the rest of the toolkit works alongside it:

[Strands Harness SDK](../sdk/index.md)Build your own agent harness from the ground up when you need full control.

[Strands Shell](../shell/index.md)A virtual shell designed for AI agents to use safely.

[Strands Evals](../evals-sdk/index.md)Validate your agent before you ship.

## Where to go next

New to Strands harness? Start with the [quickstart](/docs/user-guide/harness/quickstart/index.md) and have an agent running in a few minutes. [What the default harness does](#what-the-default-harness-does) above tours everything it ships with before you change anything. When you are ready to tune it, [configure the agent](/docs/user-guide/harness/configure/model/index.md) walks each option, the [configuration reference](/docs/user-guide/harness/reference/configuration/index.md) lists them all, and [composing with the Strands Harness SDK](/docs/user-guide/harness/composing-with-sdk/index.md) shows how to reach past the defaults into the full Strands Harness SDK.

## Implementation

### Python

- [harness-sdk/harness-py/src/strands_harness/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/agent.py)
- [harness-sdk/harness-py/src/strands_harness/prompt.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/prompt.py)

### TypeScript

- [harness-sdk/harness-ts/src/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/src/agent.ts)
