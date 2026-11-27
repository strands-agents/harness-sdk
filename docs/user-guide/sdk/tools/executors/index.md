Tool executors control whether tools from a single assistant turn run concurrently or sequentially. Both SDKs default to concurrent execution.

## Concurrent Executor

Concurrent execution runs all tool calls from a single turn in parallel. This is the default in both SDKs, so you get it without extra configuration.

(( tab "Python" ))
```python
from strands import Agent
from strands.tools.executors import ConcurrentToolExecutor

agent = Agent(
    tool_executor=ConcurrentToolExecutor(),
    tools=[weather_tool, time_tool]
)
# equivalent to Agent(tools=[weather_tool, time_tool])

agent("What is the weather and time in New York?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  tools: [weatherTool, timeTool],
  toolExecutor: 'concurrent',
})
// Concurrent execution is the default; omit toolExecutor for the same result.

await agent.invoke('What is the weather and time in New York?')
```

The `'concurrent'` string shorthand keeps your imports minimal. Passing `new ConcurrentToolExecutor()` is equivalent if you prefer to be explicit.
(( /tab "TypeScript" ))

Assuming the model returns `weather_tool` and `time_tool` use requests, the concurrent executor runs both at the same time. End-to-end latency scales with the slowest tool rather than their sum.

### Sequential Behavior

Sometimes the model returns one tool use request at a time. Those tools then execute sequentially: concurrency happens only when the model returns multiple tool use requests in a single response. Some models let you influence this. Anthropic, for example, exposes an explicit parallel tool use setting ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)).

## Sequential Executor

Use sequential execution when tool order matters, for example when a later tool depends on a side effect of an earlier one:

(( tab "Python" ))
```python
from strands import Agent
from strands.tools.executors import SequentialToolExecutor

agent = Agent(
    tool_executor=SequentialToolExecutor(),
    tools=[screenshot_tool, email_tool]
)

agent("Please take a screenshot and then email the screenshot to my friend")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent({
  tools: [screenshotTool, emailTool],
  toolExecutor: 'sequential',
})

await agent.invoke('Take a screenshot and email it to my friend')
```

The `'sequential'` string shorthand keeps your imports minimal. Passing `new SequentialToolExecutor()` is equivalent if you prefer to be explicit.
(( /tab "TypeScript" ))

Assuming the model returns `screenshot_tool` and `email_tool` use requests, the sequential executor runs both in the order given.

## Event Ordering

Both modes preserve per-tool event order. In concurrent mode, events from different tools may interleave across that per-tool sequence.

(( tab "Python" ))
Per-tool event order: `BeforeToolCallEvent` → `ToolStreamEvent*` → `AfterToolCallEvent` → `ToolResultEvent`.
(( /tab "Python" ))

(( tab "TypeScript" ))
Per-tool event order: `BeforeToolCallEvent` → `ToolStreamUpdateEvent*` → `AfterToolCallEvent` → `ToolResultEvent`.
(( /tab "TypeScript" ))

## Cancellation

Cancellation works identically in both modes. Call `agent.cancel()` to request cooperative cancellation. In TypeScript, this flips `agent.cancelSignal`.

(( tab "Python" ))
-   **Pre-launch cancel**: set `BeforeToolCallEvent.cancel_tool` on a per-tool hook to produce an error result for that tool, set `BeforeToolsEvent.cancel` on the batch-level hook to produce error results for every tool in the batch before any execute, or call `agent.cancel()` before the batch starts to cancel all pending tools.
-   **Mid-flight cancel** in sequential mode short-circuits not-yet-started tools. In concurrent mode, all tools have already launched, so each in-flight tool must cooperatively check for cancellation to stop early. In either mode, a tool still waiting on its `BeforeToolCallEvent` hooks when the cancel lands is skipped with an error result.
(( /tab "Python" ))

(( tab "TypeScript" ))
-   **Pre-launch cancel**: set `BeforeToolsEvent.cancel` on the batch-level hook, or call `agent.cancel()` before tools start, to produce error results for every tool in the batch.
-   **Mid-flight cancel** in sequential mode short-circuits not-yet-started tools. In concurrent mode, all tools have already launched, so each in-flight tool must cooperatively observe `context.cancelSignal` to stop early. In either mode, a tool still waiting on its `BeforeToolCallEvent` hooks when the cancel lands is skipped with an error result.
(( /tab "TypeScript" ))

## Custom Executors

Custom tool executors are not currently supported but are planned for a future release. You can track progress on this feature at [GitHub Issue #762](https://github.com/strands-agents/harness-sdk/issues/762).

## Related pages

- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (2 shared tags)
- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (2 shared tags)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (2 shared tags)
- [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) (2 shared tags)
- [Interrupts](/docs/user-guide/sdk/interrupts/index.md) (2 shared tags)
- [Creating a Custom Model Provider](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) (1 shared tag)
- [Run tools in the background](/docs/user-guide/sdk/tools/background-tasks/index.md) (1 shared tag)
- [Steering](/docs/user-guide/sdk/agents/interventions/steering/index.md) (2 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (2 shared tags)
- [Production Lifecycle Controls](/docs/user-guide/sdk/agents/lifecycle-controls/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/tools/executors/concurrent.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/executors/concurrent.py)
- [harness-sdk/strands-py/src/strands/tools/executors/sequential.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/executors/sequential.py)

### TypeScript

- [harness-sdk/strands-ts/src/tools/executors/concurrent.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/executors/concurrent.ts)
- [harness-sdk/strands-ts/src/tools/executors/sequential.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/executors/sequential.ts)
