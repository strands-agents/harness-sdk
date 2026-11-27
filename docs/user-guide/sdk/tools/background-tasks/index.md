Use background tasks when a tool takes time and the agent has other work it can do. The tool runs in the background, the agent receives a task ID, and its loop continues.

Background tasks are disabled by default in the SDK. Enable them with the `background_tasks``backgroundTasks` option on `Agent`. [Strands harness](/docs/user-guide/harness/configure/background-tasks/index.md) enables them by default and always runs its `subagent` tool in the background.

## How it works

The model decides whether to call a tool. An `always` policy controls how a tool call executes; it does not cause the call itself.

> **Diagram:** Background task dispatch and delivery, as a sequence between the model, the agent, and a background task. Dispatch: the model requests a tool call, the agent queues the tool as a background task, and returns a receipt with the task ID to the model. Continue: the agent makes its next model call while the tool runs in the background. Delivery: the task reports that its result is ready, and the agent delivers the result to the model before the next model call.

[Tool executors](/docs/user-guide/sdk/tools/executors/index.md) order the foreground tool calls in one model response. Background tasks use a separate queue, so the loop continues before those calls finish. Direct calls through `agent.tool` always execute in the foreground, even for a tool with an `always` policy.

## Run a tool in the background

This example simulates a slow report query. It always runs `build_report` in the background and keeps other tools in the foreground. Configure a [model provider](/docs/user-guide/sdk/model-providers/index.md) before running it; these examples use the default Amazon Bedrock provider.

(( tab "Python" ))
```python
import asyncio

from strands import Agent, tool


@tool
async def build_report(region: str) -> str:
    """Build an example sales report for a region."""
    await asyncio.sleep(1)
    return f"Example report for {region}: revenue grew 12%."


async def main() -> None:
    agent = Agent(
        tools=[build_report],
        background_tasks={
            "always": [build_report],
            "never": ["*"],
            "max_concurrency": 2,
            "timeout": 30,
        },
    )
    result = await agent.invoke_async(
        "Build the north region report. While it runs, outline three "
        "questions to ask about sales growth. Then summarize the report."
    )
    print(result)


asyncio.run(main())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const buildReport = tool({
  name: 'build_report',
  description: 'Build an example sales report for a region.',
  inputSchema: z.object({ region: z.string() }),
  callback: async ({ region }) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return `Example report for ${region}: revenue grew 12%.`
  },
})

const agent = new Agent({
  tools: [buildReport],
  backgroundTasks: {
    always: [buildReport],
    never: ['*'],
    maxConcurrency: 2,
    timeout: 30_000,
  },
})
const result = await agent.invoke(
  'Build the north region report. While it runs, outline three ' +
    'questions to ask about sales growth. Then summarize the report.'
)
console.log(result.toString())
```
(( /tab "TypeScript" ))

## Configure background tasks

Set `background_tasks=True``backgroundTasks: true` to let the model choose background execution for all compatible tools. Pass a `BackgroundTasksConfig` object to choose tools, limits, and delivery behavior. Every option is optional; the defaults apply when you pass `True``true` or an empty object.

| Option | Default | Meaning |
| --- | --- | --- |
| `agentic` | `["*"]` (see note below) | The model chooses foreground or background execution for matching tools. |
| `always` | `[]` | Matching tools run in the background. |
| `never` | `[]` | Matching tools run in the foreground. |
| `wait_for_completion``waitForCompletion` | `True``true` | Wait for outstanding tasks before returning. |
| `max_concurrency``maxConcurrency` | `4` | Maximum simultaneous executions; a positive integer. |
| `timeout` | No limit | Per-execution limit: seconds in Python, milliseconds in TypeScript. |
| `manage_tool_name``manageToolName` | `strands_manage_background_task` | [Management tool](#inspect-and-manage-tasks) name. |

Omitted and empty lists behave differently

-   **Omit `agentic`:** the model can choose for all compatible tools (`["*"]`). If `always` or `never` contains `"*"`, `agentic` defaults to `[]` instead.
-   **Set `agentic` to a non-empty list:** only matching tools can use model-selected background execution.
-   **Set `agentic` to `[]`:** disables model-selected background execution.

`always` and `never` still apply. Tools that no policy matches run in the foreground.

Each policy accepts tool instances, registered tool names, or the wildcard `"*"`. Exact matches take precedence over a wildcard. For example, `always` containing `build_report` plus `never` containing `"*"` backgrounds only the report tool. Putting the same selector in two policies is an error.

### Tools eligible for model-selected execution

For an `agentic` tool, the SDK adds an optional `_background_execution` boolean to the schema shown to the model. For example, the model might request `build_report` with these arguments:

```json
{ "region": "north", "_background_execution": true }
```

The SDK queues the call and removes the flag. Your tool receives:

```json
{ "region": "north" }
```

Don’t declare `_background_execution` on your own tools.

Adding the flag requires an object input schema without a top-level `$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, or `else`. Naming an incompatible tool in `agentic` is an error; a wildcard match leaves it in the foreground.

Some tools always stay in the foreground: the background-task management tool, structured-output tools, context-management tools, and agents configured with `delegate=True``delegate: true`. Don’t name them in `agentic` or `always`. The SDK rejects that configuration, or returns an error result for the call.

### Concurrency and timeouts

Tasks beyond the concurrency limit wait in submission order. With two execution slots and a four-second timeout:

> **Diagram:** Illustrative timeline with two execution slots and a four-second timeout. Tasks A and B start at zero seconds. Task C is queued while both slots are occupied. A completes at two seconds, so C starts then with its own four-second timeout. B times out at four seconds and fails. C completes at five seconds, after three seconds of execution; its two seconds in the queue did not count toward the timeout.

A timeout produces `failed` with a `timeout` error. Python accepts any positive number of seconds; TypeScript requires a whole number of milliseconds no larger than `2_147_483_647`.

These limits apply to one agent’s background work. Tools still share the host process and its resources. Use asynchronous I/O for waiting operations; CPU-bound JavaScript still blocks the event loop.

## Task states

A task waits for a slot, runs, and reaches an outcome. An interrupt pauses it without holding a slot; supplying all responses queues a new attempt.

> **Diagram:** Background task states during execution. An unfinished task starts queued, waiting for a slot, then becomes working when a slot opens. Working tasks can complete successfully or fail with an error or timeout. An interrupt changes working to input_required and releases the slot. Supplying all interrupt responses queues another attempt, which starts the tool again with a fresh timeout. Any queued, working, or input_required task can be cancelled. Completed, failed, and cancelled are terminal states; their outcomes remain tracked until delivery.

`completed`, `failed`, and `cancelled` are terminal states. Their outcomes stay listed until [delivery](#receive-and-inspect-results).

## Inspect and manage tasks

The default management tool, `strands_manage_background_task`, lets the model or your application list, inspect, and cancel tasks.

| `mode` | `task_id``taskId` | Response content |
| --- | --- | --- |
| `list` | Not required. | A `tasks` array of task IDs, tool names, and statuses. |
| `get` | Required. | Task metadata followed by available tool output. |
| `cancel` | Required. | The task ID and resulting status. |

Use the ID from the dispatch receipt or `list`. A `get` does not consume automatic delivery. After delivery, `get` or `cancel` for that ID returns an error result.

Task metadata includes `task_id``taskId`, `tool_use_id``toolUseId`, `tool_name``toolName`, `status`, and creation and update timestamps. The task ID identifies the background work and differs from the original tool-use ID.

## Receive and inspect results

The SDK delivers ready results before model calls; the model does not need to poll.

| Stage | What you receive |
| --- | --- |
| Dispatch | A receipt with the task ID, tool name, and current status. |
| Delivery | A management-tool call with `mode: "get"`, then a result with a metadata block first and the tool’s original output blocks after it, including images. |
| After delivery | The task leaves the management tool’s list. Its result remains in conversation history, subject to normal context management. |

By default, an invocation waits for outstanding tasks after the agent finishes its turn, then delivers their results and continues.

The management tool’s name must be unique on the agent and remain stable for the life of a saved session: it is written into conversation history.

Failed tasks include an `error` with a `type` and `message`:

| Error type | Cause |
| --- | --- |
| `tool_error``toolError` | A tool error result, including an exception raised by the tool. |
| `execution_error``executionError` | An exception escaping the tool executor, such as a middleware failure. |
| `timeout` | The execution exceeded its time limit. |

Check the task’s `status` and `error`: a successful management-tool `get` can describe a failed task.

### Return while tasks are still running

Set `wait_for_completion``waitForCompletion` to `False``false` for detached execution. The invocation returns when the agent finishes its turn, even with work outstanding. Ready results are still delivered during the invocation.

Task completion does not start another invocation. Invoke the same agent again, either with a new user request or with `await agent.invoke_async([])``await agent.invoke([])`. An empty invocation adds no user message. It delivers any ready results, then calls the model, whether or not a result was ready. Wait for the previous invocation to finish before starting another.

Keep the process alive while tasks run. In an asynchronous Python application, also keep the event loop the tool started on: closing that loop cancels the task.

### List, inspect, and cancel from your application

This example starts a slow tool, inspects the tracked tasks, and cancels unfinished work. Direct management calls do not invoke the model. Setting

`record_direct_tool_call=False``recordDirectToolCall: false`

also keeps those calls out of the conversation.

(( tab "Python" ))
```python
import asyncio

from strands import Agent, tool


@tool
async def build_report(region: str) -> str:
    """Build an example report after a simulated slow query."""
    await asyncio.sleep(10)
    return f"Example report for {region}: revenue grew 12%."


async def main() -> None:
    agent = Agent(
        tools=[build_report],
        system_prompt="Report cancelled tasks without retrying them.",
        background_tasks={
            "always": [build_report],
            "never": ["*"],
            "wait_for_completion": False,
        },
    )
    await agent.invoke_async(
        "Start the north region report and tell me it has started."
    )

    manage = agent.tool.strands_manage_background_task
    listing = manage(mode="list", record_direct_tool_call=False)
    tasks = listing["content"][0]["json"]["tasks"]
    for task in tasks:
        print(manage(
            mode="get",
            task_id=task["task_id"],
            record_direct_tool_call=False,
        ))
        if task["status"] in {"queued", "working", "input_required"}:
            manage(
                mode="cancel",
                task_id=task["task_id"],
                record_direct_tool_call=False,
            )

    # Deliver any recorded outcomes to the agent.
    print(await agent.invoke_async([]))


asyncio.run(main())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, JsonBlock, tool } from '@strands-agents/sdk'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'

const buildReport = tool({
  name: 'build_report',
  description: 'Build an example report after a simulated slow query.',
  inputSchema: z.object({ region: z.string() }),
  callback: async ({ region }, context) => {
    await sleep(10_000, undefined, { signal: context?.cancelSignal })
    return `Example report for ${region}: revenue grew 12%.`
  },
})

const agent = new Agent({
  tools: [buildReport],
  systemPrompt: 'Report cancelled tasks without retrying them.',
  backgroundTasks: {
    always: [buildReport],
    never: ['*'],
    waitForCompletion: false,
  },
})
await agent.invoke('Start the north region report and tell me it has started.')

const manage = agent.tool.strands_manage_background_task!
const listing = await manage.invoke({ mode: 'list' }, { recordDirectToolCall: false })
const block = listing.content[0]
if (!(block instanceof JsonBlock)) throw new Error('Expected a task list')
const { tasks } = z
  .object({
    tasks: z.array(z.object({ taskId: z.string(), status: z.string() })),
  })
  .parse(block.json)

for (const task of tasks) {
  console.log(
    await manage.invoke(
      { mode: 'get', taskId: task.taskId },
      { recordDirectToolCall: false }
    )
  )
  if (['queued', 'working', 'input_required'].includes(task.status)) {
    await manage.invoke(
      { mode: 'cancel', taskId: task.taskId },
      { recordDirectToolCall: false }
    )
  }
}

// Deliver any recorded outcomes to the agent.
console.log((await agent.invoke([])).toString())
```
(( /tab "TypeScript" ))

The task may finish before inspection, so an empty list is valid. Direct management calls with recording disabled are also allowed while an invocation is running. In Python, they are not allowed while the agent is paused on an interrupt; respond to the interrupt first.

## Cancel background work

Choose whether to stop one task, all background work, or just the current invocation:

| Action | What stops |
| --- | --- |
| Management tool with `mode: "cancel"` and a task ID | That task. |
| `agent.cancel()` | The current invocation; background tasks keep running. |
| `agent.cancel(cancel_background_tasks=True)``agent.cancel({ cancelBackgroundTasks: true })` | The current invocation and all queued, working, or input-required tasks. |

Cancellation records `cancelled` and signals the tool to stop. A blocking function or external operation may still continue. Tools must check `tool_context.cancel_signal``context.cancelSignal` or pass it to libraries that support cancellation. The signal is a `threading.Event``AbortSignal`.

On an idle agent, plain `agent.cancel()` cancels the next invocation in Python and has no effect in TypeScript. Cancelling background tasks leaves the next invocation alone. If an invocation was only waiting for background tasks, cancellation returns its existing turn result; outstanding results arrive on the next invocation. See [cancellation](/docs/user-guide/sdk/agents/agent-loop/index.md#cancellation) for the full contract.

## Handle interrupts

A background tool can request input through `tool_context.interrupt()``context.interrupt()`; execution middleware can also interrupt. Follow the [interrupt and resume flow](/docs/user-guide/sdk/interrupts/index.md) to supply a response for each interrupt.

The [state diagram](#task-states) shows the pause and retry. The tool runs again from the beginning with earlier responses available. Put irreversible side effects after approval, or make them safe to repeat.

| Where the interrupt originates | Behavior |
| --- | --- |
| A before-tool hook | Approval happens in the foreground, before the task is submitted. |
| A child agent wrapped with `Agent.as_tool()``Agent.asTool()`, or the [`subagent`](/docs/user-guide/sdk/tools/vended-tools/subagent/index.md) tool | The interrupt does not reach the parent. The task fails with an `execution_error``executionError` naming the interrupt. Keep the agent tool in the foreground if its child needs approval. |

## Observe execution

Background tools use tool execution [middleware](/docs/user-guide/sdk/agents/middleware/index.md) and lifecycle [hooks](/docs/user-guide/sdk/agents/hooks/index.md):

| What to observe | Where |
| --- | --- |
| Dispatch | The before-tool hook. |
| Tool completion | The after-tool hook, with the actual result rather than the dispatch receipt. |
| Task status and finished results | The management tool. It cannot stream progress or send messages to running tasks. |

Progress events are separate from the invocation’s event stream. In Python they go to the agent’s [callback handler](/docs/user-guide/sdk/streaming/callback-handlers/index.md); in TypeScript they fire `ToolStreamUpdateEvent` hooks. These callbacks can overlap, so account for concurrent updates to shared application state.

## Persist state and recover after a restart

A [session manager](/docs/user-guide/sdk/agents/session-management/index.md) or [snapshot](/docs/user-guide/sdk/agents/snapshots/index.md) saves task metadata and undelivered results as part of agent state. A task update does not itself trigger a durable write.

| Saved task state | After restoration |
| --- | --- |
| `completed`, `failed`, or `cancelled` | The saved outcome remains available for delivery. |
| `queued`, `working`, or `input_required` | The task becomes `failed`. The SDK does not resume its function or restart an external job. |

For work that must survive a process restart, have your tool submit to a durable service and return that service’s job ID.

Loading a snapshot is rejected while the agent tracks any background tasks, including terminal but undelivered tasks. Finish or cancel the work and deliver its outcomes before loading another snapshot.

## Related pages

- [Creating a Custom Model Provider](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) (1 shared tag)
- [Tools](/docs/user-guide/sdk/bidi/tools/index.md) (1 shared tag)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (1 shared tag)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (1 shared tag)
- [Approve before your agent acts](/docs/user-guide/sdk/agents/approve-before-acting/index.md) (1 shared tag)
- [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) (1 shared tag)
- [Available Sandboxes](/docs/user-guide/sdk/sandbox/available-sandboxes/index.md) (1 shared tag)
- [Building a Custom Sandbox](/docs/user-guide/sdk/sandbox/custom-sandbox/index.md) (1 shared tag)
- [Sandbox](/docs/user-guide/sdk/sandbox/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/background_tasks/_background_tasks.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/background_tasks/_background_tasks.py)
- [harness-sdk/strands-py/src/strands/background_tasks/_types.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/background_tasks/_types.py)
- [harness-sdk/strands-py/src/strands/background_tasks/in_process/_manager.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/background_tasks/in_process/_manager.py)

### TypeScript

- [harness-sdk/strands-ts/src/background-tasks/background-tasks.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/background-tasks.ts)
- [harness-sdk/strands-ts/src/background-tasks/types.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts)
- [harness-sdk/strands-ts/src/background-tasks/in-process/manager.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/in-process/manager.ts)
