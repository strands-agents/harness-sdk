[Background tasks](/docs/user-guide/sdk/tools/background-tasks/index.md) let a tool run while the agent keeps working, instead of blocking the agent loop until it finishes. Strands harness enables them by default. Configure them through `background_tasks``backgroundTasks` when you create the harness.

This is a Strands Harness SDK capability. For the full walkthrough, including the execution diagram, configuration options, and examples, see the [SDK guide to background tasks](/docs/user-guide/sdk/tools/background-tasks/index.md#how-it-works).

## What runs in the background by default

-   The built-in [`subagent` tool](/docs/user-guide/harness/configure/subagents/index.md), which runs the `generalist` delegate, always runs in the background, so the main agent continues while the delegate works.
-   For any other compatible tool, the model chooses foreground or background execution.
-   Invocations follow the SDK’s [waiting and result delivery behavior](/docs/user-guide/sdk/tools/background-tasks/index.md#receive-and-inspect-results).

The default policy is `agentic: ["*"]`, to which the harness adds `subagent` as an `always` tool.

## Tune the policy

Pass a policy object to choose which tools run in the background. The [full configuration](/docs/user-guide/sdk/tools/background-tasks/index.md#configure-background-tasks) covers `agentic`, `always`, and `never`, plus concurrency, timeouts, and whether invocations wait.

This example keeps other tools in the foreground and lets two delegates run at once:

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(
    background_tasks={
        "never": ["*"],
        "max_concurrency": 2,
    },
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({
  backgroundTasks: {
    never: ['*'],
    maxConcurrency: 2,
  },
})
```
(( /tab "TypeScript" ))

With any policy, `subagent` still runs in the background. The harness adds it to `always` and removes it from your `agentic` and `never` lists. A wildcard such as `never: ["*"]` stays in place, and the exact `subagent` rule takes precedence over it.

An interrupt raised inside a backgrounded delegate fails that task instead of pausing the agent. That includes an [interventions](/docs/user-guide/harness/configure/interventions/index.md) approval for one of the delegate’s tool calls; approval for the `subagent` call itself still pauses the agent. If your delegates need to ask for approval, disable background tasks.

## Disable background tasks

Pass `False``false` to run every tool in the foreground, including `subagent`:

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(background_tasks=False)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ backgroundTasks: false })
```
(( /tab "TypeScript" ))

## Cancel background work

`agent.cancel()` stops the current invocation but leaves background tasks running. On an idle agent, it cancels the next invocation in Python and has no effect in TypeScript.

To stop background tasks too, call `agent.cancel(cancel_background_tasks=True)``agent.cancel({ cancelBackgroundTasks: true })`.

If the invocation had already finished its turn and was only waiting for background tasks, it returns that turn’s result, and the cancelled task results are delivered on the next invocation.

## Choose the management tool name

To keep a stable management tool name across harness upgrades, set

`background_tasks.manage_tool_name``backgroundTasks.manageToolName`

explicitly. For example, set it to `manage_background_task` to use that name for listing, inspecting, and cancelling tasks.

The selected name also appears in completion messages and conversation history. Use the same name in hooks and tool-choice settings. When resuming a saved session, keep the name used in its messages: set it to `strands_manage_background_task` for sessions saved under that name.

## The CLI

The Strands harness CLI runs on the TypeScript library, so `subagent` runs in the background there too. Its interactive terminal goes one step further and doesn’t wait for background work: a turn can finish while tasks run, you can enter another prompt, and the CLI starts a new turn to deliver ready results. `/tasks` shows your todos and background tasks.

Print and plain modes wait for background work before returning by default. To turn background tasks off, use the setup wizard (`strands --setup`) or pass `--set agentConfig.backgroundTasks=false` for one run. The generic `--set key=value` flag also overrides individual options, such as `--set agentConfig.backgroundTasks.maxConcurrency=2`.

For the full option list, see the [configuration reference](/docs/user-guide/harness/reference/configuration/index.md).

## Implementation

### Python

- [harness-sdk/harness-py/src/strands_harness/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/agent.py)

### TypeScript

- [harness-sdk/harness-ts/src/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/src/agent.ts)
- [harness-sdk/strands-cli/src/agent/background.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-cli/src/agent/background.ts)
