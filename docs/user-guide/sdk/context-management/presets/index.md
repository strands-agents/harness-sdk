Named strategy presets are shorthand for preconfigured `Offload` strategies. Pass a preset name string in the strategies array instead of building the strategy by hand.

Preset expansions are internal defaults and may change between releases as tuning improves. The preset *name* is the stable contract. Use raw `Offload.*` strategies when you need a pinned configuration.

## Available presets

(( tab "Python" ))
| Preset | Name | Description |
| --- | --- | --- |
| Proactive summarization | `"proactive_summarization"` | Summarizes the oldest 30% of messages when the context window reaches 70% capacity. |
| Large tool offloading | `"large_tool_offloading"` | Truncates individual tool results over 2,500 tokens to a 1,000-token preview, eagerly on message arrival. |
| Overflow protection | `"overflow_protection"` | Truncates the oldest messages when the context window is full, keeping the 4 most recent. |
| Stale tool cleanup | `"stale_tool_cleanup"` | Drops tool results more than 5 messages old. |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Preset | Name | Description |
| --- | --- | --- |
| Proactive summarization | `"proactiveSummarization"` | Summarizes the oldest 30% of messages when the context window reaches 70% capacity. |
| Large tool offloading | `"largeToolOffloading"` | Truncates individual tool results over 2,500 tokens to a 1,000-token preview, eagerly on message arrival. |
| Overflow protection | `"overflowProtection"` | Drops the oldest messages when the context window is full, keeping the 4 most recent. |
| Stale tool cleanup | `"staleToolCleanup"` | Drops tool results more than 5 messages old. |
(( /tab "TypeScript" ))

On Claude models that preserve thinking, large tool offloading keeps thinking blocks valid, and so does proactive summarization when it runs server-side. Overflow protection and stale tool cleanup drop them. See [Models that preserve thinking](/docs/user-guide/sdk/context-management/custom-strategies/index.md#models-that-preserve-thinking).

## Using presets

Pass preset name strings in the `strategies``strategies` array:

(( tab "Python" ))
```python
from strands import Agent

agent = Agent(
    context_manager={
        "strategies": [
            "proactive_summarization",
            "large_tool_offloading",
        ],
    },
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  contextManager: {
    strategies: ['proactiveSummarization', 'largeToolOffloading'],
  },
})
```
(( /tab "TypeScript" ))

## Mixing presets and custom strategies

Combine named presets with raw `Offload` strategies in the same array. Order matters: strategies run as a pipeline, and each sees the output of the previous.

(( tab "Python" ))
```python
from strands import Agent
from strands.experimental.context_manager import Offload

agent = Agent(
    context_manager={
        "strategies": [
            "large_tool_offloading",
            Offload.summarize("*").when(
                utilization=0.9,
                preserve_recent=2,
            ),
        ],
    },
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { Offload } from '@strands-agents/sdk/experimental'

const agent = new Agent({
  contextManager: {
    strategies: [
      'largeToolOffloading',
      Offload.summarize('*').when({
        contextUtilization: '90%',
        preserveRecent: 2,
      }),
    ],
  },
})
```
(( /tab "TypeScript" ))

The preset handles large tool results eagerly, and the custom summarization strategy compresses remaining content at 90% utilization.

## Related pages

- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (2 shared tags)
- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (2 shared tags)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (2 shared tags)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (2 shared tags)
- [Context Offloader](/docs/user-guide/sdk/plugins/context-offloader/index.md) (2 shared tags)
- [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md) (2 shared tags)
- [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) (1 shared tag)
- [Coherence evaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) (1 shared tag)
- [Conciseness evaluator](/docs/user-guide/evals-sdk/evaluators/conciseness_evaluator/index.md) (1 shared tag)
- [Goal success rate evaluator](/docs/user-guide/evals-sdk/evaluators/goal_success_rate_evaluator/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/_context_manager/presets.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/_context_manager/presets.py)

### TypeScript

- [harness-sdk/strands-ts/src/context-manager/presets.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/presets.ts)
