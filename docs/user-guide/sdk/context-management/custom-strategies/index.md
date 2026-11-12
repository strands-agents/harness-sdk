Experimental

The Context Manager strategy API is experimental and may change in future versions.

When the [built-in modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) don’t fit, build a custom strategy pipeline. Define which content to reduce, how to reduce it, and when each strategy fires.

## Strategy pipeline

Strategies run as an ordered pipeline. Each strategy sees the output of the previous one, so order determines priority. If two strategies target the same content, the first one to shrink it below the next strategy’s threshold wins.

The SDK always appends an emergency truncation strategy as the final step. It only fires when the context window is still overflowing after all user strategies have run.

(( tab "Python" ))
```python
from strands import Agent
from strands.experimental.context_manager import Offload

agent = Agent(
    context_manager={
        "strategies": [
            Offload.truncate("tool_results").when(
                threshold=2000,
            ),
            Offload.summarize("*").when(
                utilization=0.8,
                preserve_recent=4,
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
      Offload.truncate('toolResults').when({
        blockThreshold: 2000,
      }),
      Offload.summarize('*').when({
        contextUtilization: '80%',
        preserveRecent: 4,
      }),
    ],
  },
})
```
(( /tab "TypeScript" ))

Note

Both SDKs accept a config object with a `strategies``strategies` key. The SDK constructs the `ContextManager` internally.

## Offload builder

The `Offload` namespace exposes three methods. Each returns a strategy builder that can be chained with `.when()``.when()` to add conditions.

### Truncate

Replaces oversized content with a head/tail preview. The original content is stored in the stash for later retrieval.

(( tab "Python" ))
```python
from strands.experimental.context_manager import Offload

Offload.truncate(
    "tool_results",
    {"preview_tokens": 750},
).when(threshold=1500)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Offload } from '@strands-agents/sdk/experimental'

Offload.truncate('toolResults', {
  previewTokens: 750,
}).when({ blockThreshold: 1500 })
```
(( /tab "TypeScript" ))

**Truncate configuration:**

(( tab "Python" ))
| Parameter | Key | Default |
| --- | --- | --- |
| Preview size | `preview_tokens` | 1,000 |
| Preview mode | `preview` | `"head_tail"` |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Parameter | Key | Default |
| --- | --- | --- |
| Preview size | `previewTokens` | 1,000 |
| Preview mode | `preview` | `"headTail"` |
(( /tab "TypeScript" ))

Preview modes: `"head"`, `"tail"`, `"head_tail"``"headTail"`.

### Summarize

Replaces content with an LLM-generated summary. Uses `agent.aux_model``agent.auxModel` by default.

Note

On models that preserve thinking, some summaries drop thinking blocks. See [Models that preserve thinking](#models-that-preserve-thinking) for which ones keep them, including [server-side summarization](/docs/user-guide/sdk/model-providers/anthropic/index.md#server-side-summarization).

(( tab "Python" ))
```python
from strands.experimental.context_manager import Offload

Offload.summarize("*").when(
    utilization=0.85,
    preserve_recent=4,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Offload } from '@strands-agents/sdk/experimental'

Offload.summarize('*').when({
  contextUtilization: '85%',
  preserveRecent: 4,
})
```
(( /tab "TypeScript" ))

**Summarize configuration:**

(( tab "Python" ))
| Parameter | Key | Default |
| --- | --- | --- |
| Model | `model` | `agent.aux_model` |
| Summarization instructions | `system_prompt` | Built-in |

A batched summary resends the conversation with the agent’s system prompt and tools, followed by the summarization instructions. When it runs on the agent’s model, it can reuse the agent’s prompt cache. If the summary leaves out messages it keeps, such as a pinned message or one under the `threshold`, it sends only the first message and the messages it replaces. Custom instructions replace the default guidance, but the client-side request always tells the model not to act on the conversation or call tools.
(( /tab "Python" ))

(( tab "TypeScript" ))
| Parameter | Key | Default |
| --- | --- | --- |
| Model | `model` | `agent.auxModel` |
| Summarization instructions | `systemPrompt` | Built-in |

A batched summary resends the conversation with the agent’s system prompt and tools, followed by the summarization instructions. When it runs on the agent’s model, it can reuse the agent’s prompt cache. If the summary leaves out messages it keeps, such as a pinned message or one under the `threshold`, it sends only the first message and the messages it replaces. Custom instructions replace the default guidance, but the client-side request always tells the model not to act on the conversation or call tools.
(( /tab "TypeScript" ))

### Drop

Removes matching content entirely. No preview, no stash entry.

(( tab "Python" ))
```python
from strands.experimental.context_manager import Offload

Offload.drop("tool_results").when(preserve_recent=5)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Offload } from '@strands-agents/sdk/experimental'

Offload.drop('toolResults').when({
  preserveRecent: 5,
})
```
(( /tab "TypeScript" ))

## Conditions

Chain `.when()``.when()` to control when a strategy fires.

| Condition | Behavior |
| --- | --- |
| `threshold``blockThreshold` | Minimum size to act on |
| `utilization``contextUtilization` | Context usage that triggers it |
| `preserve_recent``preserveRecent` | Newest matches to skip |

Granularity — whether a strategy acts on whole messages or on individual blocks — is decided differently in each SDK.

(( tab "Python" ))
Conditions decide granularity. `threshold` alone acts on each block above that size as messages arrive. `utilization` alone removes or summarizes the oldest messages once usage is exceeded. Both together target messages holding blocks over the threshold, firing at the utilization level.

`preserve_recent` accepts an integer (absolute count) or a float between 0 and 1 (ratio of matching messages, e.g., `0.7` keeps 70%).
(( /tab "Python" ))

(( tab "TypeScript" ))
The target decides granularity, not the conditions. `'*'` always means whole messages; every other target means individual blocks. `contextUtilization` only controls when a strategy fires, and `preserveRecent` only controls what is protected.

Each value is a whole number in the condition’s own unit (tokens, or messages for `preserveRecent`), or an `'N%'` share: of the context window for `blockThreshold` and `contextUtilization`, of the matching messages for `preserveRecent`. Decimals throw, so write `'85%'` rather than `0.85`.
(( /tab "TypeScript" ))

### Per-block example

Fire eagerly on individual blocks over 2,000 tokens:

(( tab "Python" ))
```python
from strands.experimental.context_manager import Offload

Offload.truncate("tool_results").when(threshold=2000)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Offload } from '@strands-agents/sdk/experimental'

Offload.truncate('toolResults').when({
  blockThreshold: 2000,
})
```
(( /tab "TypeScript" ))

### Message-level example

Summarize oldest messages when the window reaches 85%:

(( tab "Python" ))
```python
from strands.experimental.context_manager import Offload

Offload.summarize("*").when(
    utilization=0.85,
    preserve_recent=4,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Offload } from '@strands-agents/sdk/experimental'

Offload.summarize('*').when({
  contextUtilization: '85%',
  preserveRecent: 4,
})
```
(( /tab "TypeScript" ))

### Combined example

Target tool results over 1,500 tokens, but only fire when the window reaches 90%:

(( tab "Python" ))
```python
from strands.experimental.context_manager import Offload

Offload.truncate("tool_results").when(
    threshold=1500,
    utilization=0.9,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Offload } from '@strands-agents/sdk/experimental'

Offload.truncate('toolResults').when({
  blockThreshold: 1500,
  contextUtilization: '90%',
})
```
(( /tab "TypeScript" ))

## Targets

Targets specify which content a strategy applies to.

(( tab "Python" ))
| Target | Value |
| --- | --- |
| All content | `"*"` |
| Tool results | `"tool_results"` |
| Failed tool results | `"tool_result_errors"` |
| Assistant text | `"assistant_text"` |
| User text | `"user_text"` |
| Specific tools | `["tool::bash", "tool::read_file"]` |
| Exclude tools | `["!tool::bash"]` |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Target | Value |
| --- | --- |
| All content | `"*"` |
| Tool results | `"toolResults"` |
| Failed tool results | `"toolResultErrors"` |
| Assistant text | `"assistantText"` |
| User text | `"userText"` |
| Specific tools | `["tool::bash", "tool::readFile"]` |
| Exclude tools | `["!tool::bash"]` |
(( /tab "TypeScript" ))

Tool name lists use the `tool::` prefix. Prefix a name with `!` to exclude it (apply to all tools *except* the listed ones).

## Stash

The stash stores all message content on arrival as JSON, before any strategy runs. Truncated or summarized content can be retrieved on demand through the `retrieve_context` tool, which the SDK registers by default.

Stash uses in-memory storage by default. Configure it through the `stash``stash` key:

-   Omit or pass `true` for defaults (in-memory storage)
-   Pass a config with a custom storage backend
-   Pass `false` to disable stash entirely

(( tab "Python" ))
```python
from strands import Agent

# Disable stash and retrieval tool
agent = Agent(
    context_manager={
        "stash": False,
    },
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  contextManager: {
    stash: false,
  },
})
```
(( /tab "TypeScript" ))

## Emergency truncation

Every strategy pipeline ends with an emergency truncation strategy, appended automatically. It fires only when the context window is still overflowing after all user strategies have run. When it fires, it drops the oldest 20% of non-head messages.

Emergency truncation intentionally ignores pinned messages so an all-pinned overflow is still recoverable. Regular strategies respect pins.

## Models that preserve thinking

Claude models that preserve thinking bind each thinking block to the prefix that produced it: the system prompt, the tools, and the past messages the model saw when it generated the thinking block. A strategy that rewrites content before a thinking block leaves that block stale. Content after a thinking block, including the text in the same message, is not part of its prefix. When the model provider replays a stale block, it retries the request with `drop_block`, Claude skips the stale blocks, and the prompt cache restarts at the edited message. See [Thinking block is bound to a different conversation](/docs/user-guide/sdk/model-providers/anthropic/index.md#thinking-block-is-bound-to-a-different-conversation) for how the provider handles this.

Whether a strategy keeps thinking valid depends on its granularity:

-   **Message-level summaries keep thinking when they run server-side.** When the summarizing model (`agent.aux_model``agent.auxModel` by default) and the agent’s model both support `server_side_summary``serverSideSummary`, a message-level summary goes through the model provider’s summarization API instead of a client-side summarization request. The provider returns the summary as a single block that stands in for the start of the conversation, so the thinking after it stays valid. The [Anthropic model provider](/docs/user-guide/sdk/model-providers/anthropic/index.md#server-side-summarization) supports server-side summary. The [Amazon Bedrock model provider](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md) (`BedrockModel`) does not, so its message-level summaries are always client-side.
-   **Eager per-block strategies keep thinking.** A per-block strategy with only a `threshold``blockThreshold` acts on each message as it is added, for any per-block [target](#targets). It rewrites a tool result or user message before the model sees it, and an assistant message before any later thinking exists, so no thinking block’s prefix changes.
-   **Other strategies drop thinking.** A per-block strategy with `preserve_recent``preserveRecent`, or a message-level truncate or drop strategy, rewrites older content that later thinking blocks are bound to. Claude skips those thinking blocks, and the prompt cache restarts at the rewrite.
-   **Emergency truncation drops thinking.** It removes the oldest messages when the context still overflows, so the thinking after them goes stale.

To keep thinking blocks on these models, summarize or truncate tool results eagerly and leave message-level summaries to models that support server-side summary. See [Server-side summarization](/docs/user-guide/sdk/model-providers/anthropic/index.md#server-side-summarization) for an example.

A message-level summary runs client-side, which drops thinking, when either model lacks server-side support or a [pinned message](/docs/user-guide/sdk/context-management/built-in-modes/index.md#agentic-context-management) falls inside the summarized range. A pin logs `server-side summary does not support pinned messages | falling back to client-side summary`. If the server-side request fails or returns no summary, the strategy falls back to a client-side summary and logs a warning ending in `the client-side summary rewrites history, so thinking blocks kept after it will be dropped`.

## Related pages

- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (2 shared tags)
- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (2 shared tags)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (2 shared tags)
- [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md) (2 shared tags)
- [Context Offloader](/docs/user-guide/sdk/plugins/context-offloader/index.md) (2 shared tags)
- [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md) (2 shared tags)
- [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) (1 shared tag)
- [Coherence evaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) (1 shared tag)
- [Conciseness evaluator](/docs/user-guide/evals-sdk/evaluators/conciseness_evaluator/index.md) (1 shared tag)
- [Goal success rate evaluator](/docs/user-guide/evals-sdk/evaluators/goal_success_rate_evaluator/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/_context_manager/strategies/offload/base.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/_context_manager/strategies/offload/base.py)
- [harness-sdk/strands-py/src/strands/_context_manager/strategies/offload/truncate.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/_context_manager/strategies/offload/truncate.py)
- [harness-sdk/strands-py/src/strands/_context_manager/strategies/offload/summarize.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/_context_manager/strategies/offload/summarize.py)
- [harness-sdk/strands-py/src/strands/models/_summarize.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/_summarize.py)

### TypeScript

- [harness-sdk/strands-ts/src/context-manager/strategies/offload/base.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts)
- [harness-sdk/strands-ts/src/context-manager/strategies/offload/index.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/index.ts)
- [harness-sdk/strands-ts/src/context-manager/strategies/offload/conditions.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/conditions.ts)
- [harness-sdk/strands-ts/src/context-manager/strategies/offload/target.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/target.ts)
- [harness-sdk/strands-ts/src/context-manager/strategies/offload/summarize.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/summarize.ts)
