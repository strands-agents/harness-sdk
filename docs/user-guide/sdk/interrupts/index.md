When your agent needs human approval or input before it continues, raise an interrupt. The agent stops its loop and hands control back to you along with the pending interrupt. You provide a response, and the agent resumes from the point where it stopped. You can raise interrupts from hook callbacks or from tool definitions. The general flow looks as follows:

> **Diagram:** Interrupt and resume. Your application sends a request to the agent, where a hook or tool runs. If it raises interrupts, the agent stops and returns them to your application, which collects a response for each one and resumes the agent with them. The hook or tool runs again with those responses; if it raises new interrupts, the cycle repeats. When no interrupts are raised, the agent loop continues.

## Hooks

Raise interrupts inside your [hook callbacks](/docs/user-guide/sdk/agents/hooks/index.md) to pause the agent at specific lifecycle events in the [agent loop](/docs/user-guide/sdk/agents/agent-loop/index.md).

(( tab "Python" ))
Both `BeforeToolCallEvent` and `BeforeToolsEvent` are interruptible. Interrupting on a `BeforeToolCallEvent` intercepts an individual tool call before execution, while interrupting on `BeforeToolsEvent` pauses the entire batch of tool calls before any of them execute, which is useful for approving a whole set of tool calls at once.

#### BeforeToolCallEvent

```python
import json
from typing import Any

from strands import Agent, tool
from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry


@tool
def delete_files(paths: list[str]) -> bool:
    # Implementation here
    pass


@tool
def inspect_files(paths: list[str]) -> dict[str, Any]:
    # Implementation here
    pass


class ApprovalHook(HookProvider):
    def __init__(self, app_name: str) -> None:
        self.app_name = app_name

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self.approve)

    def approve(self, event: BeforeToolCallEvent) -> None:
        if event.tool_use["name"] != "delete_files":
            return

        approval = event.interrupt(f"{self.app_name}-approval", reason={"paths": event.tool_use["input"]["paths"]})
        if approval.lower() != "y":
            event.cancel_tool = "User denied permission to delete files"


agent = Agent(
    hooks=[ApprovalHook("myapp")],
    system_prompt="You delete files older than 5 days",
    tools=[delete_files, inspect_files],
    callback_handler=None,
)

paths = ["a/b/c.txt", "d/e/f.txt"]
result = agent(f"paths=<{paths}>")

while True:
    if result.stop_reason != "interrupt":
        break

    responses = []
    for interrupt in result.interrupts:
        if interrupt.name == "myapp-approval":
            user_input = input(f"Do you want to delete {interrupt.reason['paths']} (y/N): ")
            responses.append({
                "interruptResponse": {
                    "interruptId": interrupt.id,
                    "response": user_input
                }
            })

    result = agent(responses)

print(f"MESSAGE: {json.dumps(result.message)}")
```

#### BeforeToolsEvent

```python
from typing import Any

from strands import Agent, tool
from strands.hooks import BeforeToolsEvent, HookProvider, HookRegistry


@tool
def delete_files(paths: list[str]) -> bool:
    # Implementation here
    pass


class BatchApprovalHook(HookProvider):
    def __init__(self, app_name: str) -> None:
        self.app_name = app_name

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolsEvent, self.approve)

    def approve(self, event: BeforeToolsEvent) -> None:
        dangerous_tools = [
            content["toolUse"]["name"]
            for content in event.message["content"]
            if "toolUse" in content and content["toolUse"]["name"] == "delete_files"
        ]
        if not dangerous_tools:
            return

        approval = event.interrupt(f"{self.app_name}-batch-approval", reason={"tools": dangerous_tools})
        if approval.lower() != "y":
            event.cancel = "Batch cancelled by user"


agent = Agent(
    hooks=[BatchApprovalHook("myapp")],
    system_prompt="You delete files older than 5 days",
    tools=[delete_files],
    callback_handler=None,
)

result = agent("Delete a/b/c.txt and d/e/f.txt")

while result.stop_reason == "interrupt":
    responses = []
    for interrupt in result.interrupts:
        if interrupt.name == "myapp-batch-approval":
            user_input = input(f"Approve running {interrupt.reason['tools']}? (y/N): ")
            responses.append({"interruptResponse": {"interruptId": interrupt.id, "response": user_input}})

    result = agent(responses)
```

Setting `event.cancel` (to `True` for a default message, or a string for a custom one) produces an error tool result for every tool in the batch and skips execution entirely, so no per-tool `BeforeToolCallEvent` fires.
(( /tab "Python" ))

(( tab "TypeScript" ))
Both `BeforeToolCallEvent` and `BeforeToolsEvent` are interruptible. Interrupting on a `BeforeToolCallEvent` intercepts individual tool calls before execution, while `BeforeToolsEvent` intercepts the entire batch of tool calls before any execute.

#### BeforeToolCallEvent

```typescript
import { Agent, tool, BeforeToolCallEvent } from '@strands-agents/sdk'
import { z } from 'zod'

const deleteFiles = tool({
  name: 'delete_files',
  description: 'Delete files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input) => {
    // Implementation here
    return true
  },
})

const inspectFiles = tool({
  name: 'inspect_files',
  description: 'Inspect files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input) => {
    // Implementation here
    return {}
  },
})

const agent = new Agent({
  systemPrompt: 'You delete files older than 5 days',
  tools: [deleteFiles, inspectFiles],
})

agent.addHook(BeforeToolCallEvent, (event) => {
  if (event.toolUse.name !== 'delete_files') return

  const approval = event.interrupt<string>({
    name: 'myapp-approval',
    reason: { paths: (event.toolUse.input as { paths: string[] }).paths },
  })
  if (approval.toLowerCase() !== 'y') {
    event.cancel = 'User denied permission to delete files'
  }
})

const paths = ['a/b/c.txt', 'd/e/f.txt']
let result = await agent.invoke(`paths=<${JSON.stringify(paths)}>`)

while (result.stopReason === 'interrupt') {
  const responses = result.interrupts!.map((interrupt) => ({
    interruptResponse: {
      interruptId: interrupt.id,
      // In a real app, collect user input here
      response: 'y',
    },
  }))

  result = await agent.invoke(responses)
}

console.log('MESSAGE:', JSON.stringify(result.lastMessage))
```

#### BeforeToolsEvent

```typescript
import { Agent, BeforeToolsEvent } from '@strands-agents/sdk'

const agent = new Agent({
  tools: [/* ... */],
})

agent.addHook(BeforeToolsEvent, (event) => {
  const dangerousTools = event.message.content
    .filter((block) => block.type === 'toolUseBlock')
    .filter((block) => ['delete_files'].includes(block.name))

  if (dangerousTools.length > 0) {
    const response = event.interrupt<{ approved: boolean }>({
      name: 'batch_approval',
      reason: `Approve ${dangerousTools.length} dangerous tool calls?`,
    })
    if (!response.approved) {
      event.cancel = 'Batch cancelled by user'
    }
  }
})
```
(( /tab "TypeScript" ))

### Components

Interrupts in Strands are comprised of the following components:

(( tab "Python" ))
-   `event.interrupt` - Raises an interrupt with a unique name and optional reason
    -   The `name` must be unique across all interrupt calls configured on the same event (`BeforeToolCallEvent` or `BeforeToolsEvent`). In the example above, we demonstrate using `app_name` to namespace the interrupt call. This is particularly helpful if you plan to vend your hooks to other users.
    -   You can assign additional context for raising the interrupt to the `reason` field. Note, the `reason` must be JSON-serializable.
-   `result.stop_reason` - Check if agent stopped due to “interrupt”
-   `result.interrupts` - List of interrupts that were raised
    -   Each `interrupt` contains the user provided name and reason, along with an instance id.
-   `interruptResponse` - Content block type for configuring the interrupt responses.
    -   Each `response` is uniquely identified by their interrupt’s id and will be returned from the associated interrupt call when invoked the second time around. Note, the `response` must be JSON-serializable.
-   `event.cancel_tool` (`BeforeToolCallEvent`) - Cancel a single tool call based on the interrupt response
    -   You can either set `cancel_tool` to `True` or provide a custom cancellation message.
-   `event.cancel` (`BeforeToolsEvent`) - Cancel every tool call in the batch based on the interrupt response
    -   You can either set `cancel` to `True` or provide a custom cancellation message.

For additional details on each of these components, refer to the [Python API Reference](/docs/api/python/strands.types.interrupt).
(( /tab "Python" ))

(( tab "TypeScript" ))
-   [`BeforeToolCallEvent`](/docs/api/typescript/BeforeToolCallEvent/index.md) / [`BeforeToolsEvent`](/docs/api/typescript/BeforeToolsEvent/index.md): hook events that expose the ability to interrupt via the `interrupt` method
    -   `event.interrupt({ name, reason? })`: halts the agent loop. `name` is a string identifier and `reason` is an optional JSON-serializable value providing context for why the interrupt was raised.
    -   The `name` must be unique across all interrupt calls configured on the same event. In the example above, we demonstrate using a namespace prefix for the interrupt call. This is particularly helpful if you plan to vend your hooks to other users.
    -   `event.cancel`: cancel tool execution based on the interrupt response. Set to `true` for a default message or provide a custom cancellation message string.
-   [`AgentResult`](/docs/api/typescript/AgentResult/index.md): returned by `invoke()` / `stream()`, contains interrupt information when the agent pauses
    -   `result.stopReason`: check if agent stopped due to `'interrupt'`
    -   `result.interrupts`: array of `Interrupt` objects, each containing the user-provided `name` and `reason`, along with a unique `id`
-   `InterruptResponseContent`: content block type for resuming from an interrupt
    -   Pass an array of these to `agent.invoke()` to resume. Each response is keyed by the interrupt’s `id` and will be returned from the associated `interrupt()` call when the tool/hook re-executes. The `response` must be JSON-serializable.
(( /tab "TypeScript" ))

### Rules

Strands enforces the following rules for interrupts:

(( tab "Python" ))
-   All hooks configured on the interrupted event will execute
-   All hooks configured on the interrupted event are allowed to raise an interrupt
-   A single hook can raise multiple interrupts but only one at a time
    -   In other words, within a single hook, you can interrupt, respond to that interrupt, and then proceed to interrupt again.
-   All tools running concurrently are interruptible
-   All tools running concurrently that are not interrupted will execute
-   When an interrupt fires from `BeforeToolCallEvent`, `AfterToolCallEvent` does not fire for that tool, but `AfterToolsEvent` still fires
-   `AfterToolsEvent` fires once per event-loop cycle rather than once per logical batch. A per-tool interrupt splits a batch across cycles, so it fires on the interrupt cycle (carrying only the results collected so far) and again on resume (carrying the results produced that cycle): a hook with side effects there can run more than once for one assistant message
-   When an interrupt fires from `BeforeToolsEvent`, no tool in the batch executes (and no `BeforeToolCallEvent` fires) until the interrupt is answered; on resume the batch hook re-runs and, if not interrupted again, the tools execute
(( /tab "Python" ))

(( tab "TypeScript" ))
-   All hooks configured on the interrupted event will execute
-   All hooks configured on the interrupted event are allowed to raise an interrupt
-   A single hook can raise multiple interrupts but only one at a time
    -   In other words, within a single hook, you can interrupt, respond to that interrupt, and then proceed to interrupt again.
-   When an interrupt fires from `BeforeToolCallEvent`, `AfterToolCallEvent` does not fire for that tool, but `AfterToolsEvent` still fires
-   `AfterToolsEvent` fires once per event-loop cycle rather than once per logical batch. A per-tool interrupt splits a batch across cycles, so it fires on the interrupt cycle (carrying only the results collected so far) and again on resume (carrying the results produced that cycle): a hook with side effects there can run more than once for one assistant message
-   When an interrupt fires mid-batch, completed tool results are preserved so the agent skips the model call on resume and only executes remaining tools
-   Both assistant and tool result messages are appended only after tool execution completes, preventing dangling `toolUse` blocks without matching results
(( /tab "TypeScript" ))

## Tools

You can also raise interrupts from your tool definitions.

(( tab "Python" ))
```python
from typing import Any

from strands import Agent, tool
from strands.types.tools import ToolContext


class DeleteTool:
    def __init__(self, app_name: str) -> None:
        self.app_name = app_name

    @tool(context=True)
    def delete_files(self, tool_context: ToolContext, paths: list[str]) -> bool:
        approval = tool_context.interrupt(f"{self.app_name}-approval", reason={"paths": paths})
        if approval.lower() != "y":
            return False

        # Implementation here

        return True


@tool
def inspect_files(paths: list[str]) -> dict[str, Any]:
    # Implementation here
    pass


agent = Agent(
    system_prompt="You delete files older than 5 days",
    tools=[DeleteTool("myapp").delete_files, inspect_files],
    callback_handler=None,
)

...
```

Interrupts are not supported in [direct tool calls](/docs/user-guide/sdk/tools/using-tools/index.md#direct-method-calls) (i.e., calls such as `agent.tool.my_tool()`).
(( /tab "Python" ))

(( tab "TypeScript" ))
The tool callback receives a `context` parameter (the second argument) which provides the `interrupt` method.

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const deleteFiles = tool({
  name: 'delete_files',
  description: 'Delete files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input, context) => {
    const approval = context.interrupt<string>({
      name: 'myapp-approval',
      reason: { paths: input.paths },
    })
    if (approval.toLowerCase() !== 'y') return false

    // Implementation here

    return true
  },
})

const inspectFiles = tool({
  name: 'inspect_files',
  description: 'Inspect files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input) => {
    // Implementation here
    return {}
  },
})

const agent = new Agent({
  systemPrompt: 'You delete files older than 5 days',
  tools: [deleteFiles, inspectFiles],
})

// ...
```
(( /tab "TypeScript" ))

### Components

Tool interrupts work like hook interrupts, with two differences: tools receive `context` instead of `event`, and interrupt names need only be unique within a tool definition rather than across all hooks on an event. For more on tool context, see [ToolContext](/docs/user-guide/sdk/tools/custom-tools/index.md#toolcontext).

(( tab "Python" ))
-   `tool_context` - Strands object that defines the interrupt call
-   `tool_context.interrupt` - Raises an interrupt with a unique name and optional reason
    -   The `name` must be unique only among interrupt calls configured in the same tool definition. It is still advisable however to namespace your interrupts so as to more easily distinguish the calls when constructing responses outside the agent.
(( /tab "Python" ))

(( tab "TypeScript" ))
-   [`ToolContext`](/docs/api/typescript/ToolContext/index.md): the second argument passed to the tool callback, providing access to the `interrupt` method
    -   `context.interrupt({ name, reason? })`: halts the agent loop. `name` is a string identifier and `reason` is an optional JSON-serializable value.
    -   The `name` must be unique only among interrupt calls configured in the same tool definition. It is still advisable however to namespace your interrupts so as to more easily distinguish the calls when constructing responses outside the agent.
(( /tab "TypeScript" ))

### Rules

Strands enforces the following rules for tool interrupts:

(( tab "Python" ))
-   All tools running concurrently will execute
-   All tools running concurrently are interruptible
-   A single tool can raise multiple interrupts but only one at a time
    -   In other words, within a single tool, you can interrupt, respond to that interrupt, and then proceed to interrupt again.
(( /tab "Python" ))

(( tab "TypeScript" ))
-   A single tool can raise multiple interrupts but only one at a time
    -   In other words, within a single tool, you can interrupt, respond to that interrupt, and then proceed to interrupt again.
-   When an interrupt fires mid-batch, completed tool results are preserved so the agent skips the model call on resume and only executes remaining tools
-   When no response exists yet, `context.interrupt()` throws an [`InterruptError`](/docs/api/typescript/InterruptError/index.md), which the agent loop catches to pause. If your tool catches errors around the call, re-throw `InterruptError`:

```typescript
import { tool, InterruptError } from '@strands-agents/sdk'
import { z } from 'zod'

const deleteFiles = tool({
  name: 'delete_files',
  description: 'Delete files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input, context) => {
    try {
      const approval = context!.interrupt<string>({
        name: 'myapp-approval',
        reason: { paths: input.paths },
      })
      if (approval.toLowerCase() !== 'y') return false

      // Implementation here

      return true
    } catch (error) {
      // Let the agent pause for the interrupt; handle every other error here.
      if (error instanceof InterruptError) throw error
      return false
    }
  },
})
```
(( /tab "TypeScript" ))

## Session Management

Persist interrupt state with a session manager so a user can answer later, in a new agent session. You can also persist the responses themselves, so a trusted approval does not prompt again on later tool calls.

Session state is trusted input, so do not load sessions from untrusted sources, such as session files inside a cloned repository.

(( tab "Python" ))
```python
##### server.py #####

import json
from typing import Any

from strands import Agent, tool
from strands.agent import AgentResult
from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry
from strands.session import FileSessionManager
from strands.types.agent import AgentInput


@tool
def delete_files(paths: list[str]) -> bool:
    # Implementation here
    pass


@tool
def inspect_files(paths: list[str]) -> dict[str, Any]:
    # Implementation here
    pass


class ApprovalHook(HookProvider):
    def __init__(self, app_name: str) -> None:
        self.app_name = app_name

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self.approve)

    def approve(self, event: BeforeToolCallEvent) -> None:
        if event.tool_use["name"] != "delete_files":
            return

        if event.agent.state.get(f"{self.app_name}-approval") == "t":  # (t)rust
            return

        approval = event.interrupt(f"{self.app_name}-approval", reason={"paths": event.tool_use["input"]["paths"]})
        if approval.lower() not in ["y", "t"]:
            event.cancel_tool = "User denied permission to delete files"

        event.agent.state.set(f"{self.app_name}-approval", approval.lower())


def server(prompt: AgentInput) -> AgentResult:
    agent = Agent(
        hooks=[ApprovalHook("myapp")],
        session_manager=FileSessionManager(session_id="myapp", storage_dir="/path/to/storage"),
        system_prompt="You delete files older than 5 days",
        tools=[delete_files, inspect_files],
        callback_handler=None,
    )
    return agent(prompt)

##### client.py #####

def client(paths: list[str]) -> AgentResult:
    result = server(f"paths=<{paths}>")

    while True:
        if result.stop_reason != "interrupt":
            break

        responses = []
        for interrupt in result.interrupts:
            if interrupt.name == "myapp-approval":
                user_input = input(f"Do you want to delete {interrupt.reason['paths']} (t/y/N): ")
                responses.append({
                    "interruptResponse": {
                        "interruptId": interrupt.id,
                        "response": user_input
                    }
                })

        result = server(responses)

    return result


paths = ["a/b/c.txt", "d/e/f.txt"]
result = client(paths)
print(f"MESSAGE: {json.dumps(result.message)}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  Agent,
  tool,
  SessionManager,
  FileStorage,
  BeforeToolCallEvent,
} from '@strands-agents/sdk'
import { z } from 'zod'

const deleteFiles = tool({
  name: 'delete_files',
  description: 'Delete files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input) => {
    // Implementation here
    return true
  },
})

const inspectFiles = tool({
  name: 'inspect_files',
  description: 'Inspect files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input) => {
    // Implementation here
    return {}
  },
})

// Server function: creates a fresh agent with session management each call
async function server(
  prompt: string | { interruptResponse: { interruptId: string; response: unknown } }[]
) {
  const agent = new Agent({
    systemPrompt: 'You delete files older than 5 days',
    tools: [deleteFiles, inspectFiles],
    sessionManager: new SessionManager({
      sessionId: 'myapp',
      storage: { snapshot: new FileStorage('/path/to/storage') },
    }),
  })

  agent.addHook(BeforeToolCallEvent, (event) => {
    if (event.toolUse.name !== 'delete_files') return

    // Check if user already trusted this approval
    if (event.agent.appState.get('myapp-approval') === 't') return

    const approval = event.interrupt<string>({
      name: 'myapp-approval',
      reason: { paths: (event.toolUse.input as { paths: string[] }).paths },
    })
    if (!['y', 't'].includes(approval.toLowerCase())) {
      event.cancel = 'User denied permission to delete files'
    }

    event.agent.appState.set('myapp-approval', approval.toLowerCase())
  })

  return agent.invoke(prompt)
}

// Client function
async function client(paths: string[]) {
  let result = await server(`paths=<${JSON.stringify(paths)}>`)

  while (result.stopReason === 'interrupt') {
    const responses = result.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        // In a real app, collect user input here
        response: 'y',
      },
    }))

    result = await server(responses)
  }

  return result
}

const paths = ['a/b/c.txt', 'd/e/f.txt']
const result = await client(paths)
console.log('MESSAGE:', JSON.stringify(result.lastMessage))
```
(( /tab "TypeScript" ))

### Components

Session managing interrupts involves the following key components:

(( tab "Python" ))
-   `session_manager` - Automatically persists the agent interrupt state between tear down and start up
    -   See [Session Management](/docs/user-guide/sdk/agents/session-management/index.md) for more.
-   `agent.state` - General purpose key-value store that can be used to persist interrupt responses
    -   On subsequent tool calls, you can reference the responses stored in `agent.state` to decide whether another interrupt is necessary. See [Agent State](/docs/user-guide/sdk/agents/state/index.md#agent-state) for more.
(( /tab "Python" ))

(( tab "TypeScript" ))
-   `sessionManager` - Automatically persists the agent interrupt state between tear down and start up
    -   See [Session Management](/docs/user-guide/sdk/agents/session-management/index.md) for more.
-   `agent.appState` - General purpose key-value store that can be used to persist interrupt responses
    -   On subsequent tool calls, you can reference the responses stored in `appState` to decide whether another interrupt is necessary. See [Agent State](/docs/user-guide/sdk/agents/state/index.md#agent-state) for more.
(( /tab "TypeScript" ))

## MCP Elicitation

To collect additional information from a user during an MCP tool call, use elicitation. An MCP server sends an elicitation request to the connecting client, which is handled by an elicitation callback. See [MCP Elicitation](/docs/user-guide/sdk/tools/mcp-tools/index.md#elicitation) for details.

## Multi-Agent Systems

Interrupts work across swarm and graph orchestration too, using the same interfaces shown here. You raise them from a `BeforeNodeCallEvent` hook or from within a node. See [Interrupts in multi-agent systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) for the swarm and graph examples.

## Related pages

- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (3 shared tags)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (3 shared tags)
- [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) (3 shared tags)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (3 shared tags)
- [Steering](/docs/user-guide/sdk/agents/interventions/steering/index.md) (3 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (3 shared tags)
- [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) (2 shared tags)
- [Plugins](/docs/user-guide/sdk/plugins/index.md) (2 shared tags)
- [Production Lifecycle Controls](/docs/user-guide/sdk/agents/lifecycle-controls/index.md) (2 shared tags)
- [Retry Strategies](/docs/user-guide/sdk/agents/retry-strategies/index.md) (2 shared tags)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/interrupt.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py)
- [harness-sdk/strands-py/src/strands/types/interrupt.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/interrupt.py)

### TypeScript

- [harness-sdk/strands-ts/src/interrupt.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts)
- [harness-sdk/strands-ts/src/types/interrupt.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/interrupt.ts)
