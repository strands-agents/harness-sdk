As conversations grow, your agent’s context window fills with messages, tool results, and system prompts. Without management, this leads to token limit errors, degraded performance, and loss of relevant information.

The SDK ships context management that works out of the box. Pick a mode and the SDK wires up an ordered strategy pipeline with tuned defaults.

You can continue using [conversation managers](/docs/user-guide/sdk/agents/conversation-management/index.md) and [ContextOffloader](/docs/user-guide/sdk/plugins/context-offloader/index.md) while evaluating the experimental `ContextManager` strategy API. See [Migrating to the strategy API](#migrating-to-the-strategy-api) for optional migration examples.

## Quickstart

Pass `context_manager="auto"``contextManager: "auto"` and the SDK manages context in the background:

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

## How it works

The `context_manager``contextManager` parameter is a first-class agent parameter, not a plugin. It creates a `ContextManager` that owns all context reduction for the agent.

The ContextManager runs strategies as an ordered pipeline. Each strategy sees the output of the previous one. The SDK always appends an emergency truncation strategy as the final step, which only fires when the window is still overflowing after all other strategies have run.

A stash stores all message content on arrival as JSON, before any strategy acts. Truncated or summarized content is preserved and retrievable on demand through the `retrieve_context` tool, registered by default.

When `context_manager``contextManager` is set, any co-provided `conversation_manager``conversationManager` is ignored. The ContextManager owns overflow recovery and proactive compression internally.

## Choosing a mode

| Value | Behavior |
| --- | --- |
| `"auto"` | Background compression with tuned defaults. No model involvement. |
| `"agentic"` | Model-driven: the model manages its own context. |
| Custom config | Full control over the strategy pipeline, targets, and conditions. |
| `false` | No context management. Overflow errors propagate directly. |

See [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) for details on `"auto"` and `"agentic"`. See [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) to build your own pipeline. See [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md) for named shorthand configurations.

## Storage backends

The `ContextManager` uses in-memory stash storage by default. Content does not persist across process restarts. Provide a durable storage backend when the stash needs to survive restarts:

(( tab "Python" ))
```python
from strands.storage import LocalFileStorage, S3Storage

# Local filesystem
stash = {"storage": LocalFileStorage("./artifacts/")}

# S3, using ambient AWS credentials
stash = {
    "storage": S3Storage(
        "my-bucket", prefix="agent-stash/",
    ),
}
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { LocalFileStorage, S3Storage } from '@strands-agents/sdk/storage'

// Local filesystem
const stashLocal = { storage: new LocalFileStorage('./artifacts/') }

// S3, using ambient AWS credentials
const stashS3 = { storage: new S3Storage('my-bucket', { prefix: 'agent-stash/' }) }
```
(( /tab "TypeScript" ))

Pass one of these `stash``stash` values in your context manager configuration. See [Storage](/docs/user-guide/sdk/storage/index.md) for the full storage backend reference.

## Limitations

**Stateful models.** Stateful models manage conversation state server-side. Setting `context_manager``contextManager` with a stateful model raises an error.

## Migrating to the strategy API

If you currently use `SummarizingConversationManager`, `ContextOffloader`, or `conversation_manager`, use these examples as starting points. Review the strategy conditions and preservation settings for your workload because the strategy API does not map one-to-one to every existing option.

(( tab "Python" ))
| Before | After |
| --- | --- |
| `SummarizingConversationManager(...)` | `Offload.summarize("*").when(utilization=0.85, preserve_recent=4)` |
| `ContextOffloader(max_result_tokens=2500, preview_tokens=500)` | `Offload.truncate("tool_results", {"preview_tokens": 500}).when(threshold=2500)` |
| `SlidingWindowConversationManager(...)` | No exact equivalent. Use `Offload.drop` or `Offload.truncate` with utilization and preservation conditions. |
| `context_manager="auto"` | Unchanged |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Before | After |
| --- | --- |
| `new SummarizingConversationManager(...)` | `Offload.summarize("*").when({ contextUtilization: "85%", preserveRecent: 4 })` |
| `new ContextOffloader({ maxResultTokens: 2500, previewTokens: 500 })` | `Offload.truncate("toolResults", { previewTokens: 500 }).when({ blockThreshold: 2500 })` |
| `new SlidingWindowConversationManager(...)` | No exact equivalent. Use `Offload.drop` or `Offload.truncate` with utilization and preservation conditions. |
| `contextManager: "auto"` | Unchanged |
(( /tab "TypeScript" ))

## Related pages

- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (2 shared tags)
- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (2 shared tags)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (2 shared tags)
- [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md) (2 shared tags)
- [Context Offloader](/docs/user-guide/sdk/plugins/context-offloader/index.md) (2 shared tags)
- [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md) (2 shared tags)
- [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) (1 shared tag)
- [Coherence evaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) (1 shared tag)
- [Conciseness evaluator](/docs/user-guide/evals-sdk/evaluators/conciseness_evaluator/index.md) (1 shared tag)
- [Goal success rate evaluator](/docs/user-guide/evals-sdk/evaluators/goal_success_rate_evaluator/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/_context_manager/context_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/_context_manager/context_manager.py)

### TypeScript

- [harness-sdk/strands-ts/src/context-manager/context-manager.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts)
