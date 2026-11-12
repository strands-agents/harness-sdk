Experimental

The Context Manager strategy API is experimental and may change in future versions.

The SDK ships two built-in context management modes that work out of the box. Both create a `ContextManager` with tuned `Offload` strategies internally, so you don’t have to assemble strategies, thresholds, and storage by hand.

For full control over the strategy pipeline, see [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md). For named shorthand configurations, see [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md).

## Automatic context management

Pass `context_manager="auto"``contextManager: "auto"` and the SDK manages context in the background with no model involvement:

(( tab "Python" ))
```python
from strands import Agent

agent = Agent(context_manager="auto")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  contextManager: 'auto',
})
```
(( /tab "TypeScript" ))

### What it sets up

Two strategies whose defaults scored highest across [ContextBench](https://arxiv.org/abs/2602.05892) evaluations:

-   **Truncate tool results** (threshold: 1,500 tokens, preview: 750 tokens): intercepts large tool results at execution time, stores them in the stash, and keeps a truncated preview in context. Registers a retrieval tool so the agent can fetch full content on demand.
-   **Summarize on pressure** (utilization: 85%): when the context window reaches 85% capacity, summarizes the oldest messages to free space, preserving the 4 most recent messages verbatim.

On Claude models that preserve thinking, the truncation keeps thinking blocks valid, and so does the summary when both the agent’s model and `agent.aux_model``agent.auxModel` support server-side summary. See [Models that preserve thinking](/docs/user-guide/sdk/context-management/custom-strategies/index.md#models-that-preserve-thinking).

## Agentic context management

Experimental

Agentic context management is experimental and may change in future versions.

Auto mode compresses on a fixed threshold the SDK controls. Agentic mode hands that control to the model. Pass `context_manager="agentic"``contextManager: "agentic"` and the model manages its own working memory: it sees how full the context window is and chooses when to compress, what to compress, and what to protect.

(( tab "Python" ))
```python
from strands import Agent

agent = Agent(context_manager="agentic")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  contextManager: 'agentic',
})
```
(( /tab "TypeScript" ))

The model is better positioned than a threshold to know which messages still matter. A coding agent can drop a stale file it already edited while pinning the failing test it is working toward. A threshold cannot tell the difference; it compresses by age. Agentic mode trades tokens for that judgment.

### What it sets up

Two things give the model the information and the levers to manage context.

**Token-usage telemetry.** Before each model call, the SDK appends a status block to the latest message reporting how much of the window is in use:

```plaintext
<context-status>
<used>50,000 / 200,000 tokens (25.0%)</used>
<remaining>~150,000 tokens</remaining>
</context-status>
```

This is the signal the model acts on. It decides whether the window is full enough to compress, instead of waiting for a fixed cutoff.

**Three tools the model can call**, each a different lever with its own choices:

-   `summarize_context` folds older messages into a model-written summary. The model chooses how many recent messages to keep verbatim, how aggressively to summarize, and whether to target tool results, discussion, or both.
-   `truncate_context` drops older messages outright when they no longer need preserving. The model again chooses how much recent history to keep and what kind of messages to target.
-   `pin_context` marks messages that must survive compression: a user constraint, a key fact, the current task. Pinned messages are never evicted by either tool. The model can pin the current exchange, the last few messages, or specific ones.

Recent messages stay verbatim regardless, and the first user message is always preserved so the conversation stays valid. New tools may be added to agentic mode in future releases.

Behind the tools, agentic mode also configures a `ContextManager` with truncation and summarization strategies. The truncation threshold is higher than auto mode (8,000 tokens versus 1,500), since the model is already managing context and benefits from seeing more tool output inline. Summarization only triggers on overflow (100% utilization), acting as a safety net if the model lets the window fill.

On Claude models that preserve thinking, `summarize_context` and `truncate_context` rewrite earlier history, so the thinking blocks after it are dropped. See [Models that preserve thinking](/docs/user-guide/sdk/context-management/custom-strategies/index.md#models-that-preserve-thinking).

### Choosing between auto and agentic

Use `"auto"` for most agents. It manages context in the background, with no model involvement and no extra tool calls. Reach for `"agentic"` when you want the model itself to decide what stays in context: it judges relevance per message rather than compressing on a fixed threshold. The tradeoff is the tokens the model spends reading telemetry and calling the tools.

## Disabling context management

To turn off all context management (no compression, no offloading), pass `false`:

(( tab "Python" ))
```python
from strands import Agent

agent = Agent(context_manager=False)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  contextManager: false,
})
```
(( /tab "TypeScript" ))

The agent runs without any context reduction. Overflow errors propagate directly. This is useful for short conversations or when you handle context externally.

## Related pages

- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (2 shared tags)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (2 shared tags)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (2 shared tags)
- [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md) (2 shared tags)
- [Context Offloader](/docs/user-guide/sdk/plugins/context-offloader/index.md) (2 shared tags)
- [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md) (2 shared tags)
- [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) (1 shared tag)
- [Coherence evaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) (1 shared tag)
- [Conciseness evaluator](/docs/user-guide/evals-sdk/evaluators/conciseness_evaluator/index.md) (1 shared tag)
- [Goal success rate evaluator](/docs/user-guide/evals-sdk/evaluators/goal_success_rate_evaluator/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/agent/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts)
- [harness-sdk/strands-ts/src/context-manager/context-manager.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts)

### Python

- [harness-sdk/strands-py/src/strands/_context_manager/modes/agentic/agentic_context.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/_context_manager/modes/agentic/agentic_context.py)
