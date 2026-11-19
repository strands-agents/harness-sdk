# Programmatic Tool Caller

Lets the agent orchestrate its other tools with Python code. The model passes a `code` string; it runs in a [Monty](https://github.com/pydantic/monty) sandbox with every other registered tool exposed as an `async` function, so one call can chain, loop over, filter, and parallelize tool calls. Only text the code sends to `print()` is returned to the model, which keeps large intermediate results out of the conversation.

## ⚠️ Security Warning

**This tool runs model-authored code that can call the agent's other tools.**

- The sandbox is language-level, not OS-level: the code has no filesystem, network, environment, or subprocess access of its own, but it reaches whatever the exposed tools reach
- Narrow the exposed tools with `allowedTools`
- Inner tool calls fire the agent's `beforeToolCall` / `afterToolCall` hooks, so interventions still gate them. A call that needs interactive approval is refused, since a call made from code cannot prompt
- Inner tool calls go through the agent's tool executor, so tool middleware and `AfterToolCallEvent.retry` apply to them too

## Install

Requires the optional `@pydantic/monty` peer dependency and Node.js:

```bash
npm install @pydantic/monty
```

Where the native addon cannot load, for example on Alpine Linux, the tool logs a warning and runs the interpreter as WebAssembly, which is slower.

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { programmaticToolCaller } from '@strands-agents/sdk/vended-tools/programmatic-tool-caller'
import { makeShell } from '@strands-agents/sdk/vended-tools/shell'

const agent = new Agent({ tools: [programmaticToolCaller, makeShell()] })
await agent.invoke('Count the lines in every .ts file under src and report the five largest')
```

Limit the exposed tools and tighten the timeouts:

```typescript
import { makeProgrammaticToolCaller } from '@strands-agents/sdk/vended-tools/programmatic-tool-caller'

const caller = makeProgrammaticToolCaller({
  allowedTools: ['read', 'shell'],
  timeout: 10 * 60_000,
  toolTimeout: 2 * 60_000,
})
```

## API

### `makeProgrammaticToolCaller(options?)`

| Option         | Default                                        | Description                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedTools` | every other registered tool                    | Registry names of the tools to expose to the code. A programmatic tool caller is never exposed                                                                                                                                                  |
| `name`         | `'programmatic_tool_caller'`                   | Tool name                                                                                                                                                                                                                                       |
| `description`  | `DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION` | Tool description shown to the model                                                                                                                                                                                                             |
| `timeout`      | `3_600_000` (60 minutes)                       | Wall-clock ceiling for a run in milliseconds, tool calls included. `Infinity` for no limit                                                                                                                                                      |
| `toolTimeout`  | `1_800_000` (30 minutes)                       | Wall-clock ceiling for one tool call made by the code, in milliseconds. `Infinity` for no limit. A call that exceeds it raises a `RuntimeError` the code can catch; the tool's cancel signal fires, but a tool that ignores it may still finish |

### What the code sees

- Each tool is an `async` function taking keyword arguments: `result = await read(path="/etc/hosts")`. `asyncio.gather(...)` runs calls concurrently, at most 10 at a time
- A result that is structured content or JSON text arrives parsed as a dict or list; anything else arrives as a string
- A failing tool raises `RuntimeError`
- A tool whose name is not a valid Python identifier (`fetch-url`) is also available with those characters replaced by underscores (`fetch_url`)

### Streaming

While the code runs, the tool emits what it prints as tool stream events whose `data` is a `ProgrammaticToolCallerPrintEvent`: `{ type: 'print', text }`. The model still receives the whole output once, as the tool result.

```typescript
import type { ProgrammaticToolCallerPrintEvent } from '@strands-agents/sdk/vended-tools/programmatic-tool-caller'

for await (const event of agent.stream('Count the lines in every .ts file under src')) {
  if (event.type === 'toolStreamUpdateEvent') {
    const data = event.event.data as ProgrammaticToolCallerPrintEvent
    if (data.type === 'print') {
      process.stdout.write(data.text)
    }
  }
}
```

One event can carry several `print()` calls, and streaming stops at the output limit. Stream events from the tools the code calls are not forwarded. On the WebAssembly fallback, events arrive when the code awaits a tool or ends, not while it computes.

### Limits

The sandbox bounds the code's own compute time (60 seconds, not counting time spent waiting on tools), memory (256 MiB), and output (200,000 characters). A run makes roughly 500 to 1,000 tool calls before it reaches the sandbox's limit on host round trips; calls made with `asyncio.gather` cost more than calls awaited one at a time. `time.sleep` and `asyncio.sleep` wait for at most 10 seconds each and do not count as compute, so the run timeout is what bounds code that sleeps in a loop.

A run that times out or is cancelled while the code is computing returns at once, but its interpreter keeps running in the background until the compute limit ends it, and the Node.js process does not exit before then.
