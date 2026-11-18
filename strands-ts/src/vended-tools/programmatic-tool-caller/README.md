# Programmatic Tool Caller

Lets the agent orchestrate its other tools with Python code. The model passes a `code` string; it runs in a [Monty](https://github.com/pydantic/monty) sandbox with every other registered tool exposed as an `async` function, so one call can chain, loop over, filter, and parallelize tool calls. Only text the code sends to `print()` is returned to the model, which keeps large intermediate results out of the conversation.

## ⚠️ Security Warning

**This tool runs model-authored code that can call the agent's other tools.**

- The sandbox is language-level, not OS-level: the code has no filesystem, network, environment, or subprocess access of its own, but it reaches whatever the exposed tools reach
- Narrow the exposed tools with `allowedTools`
- Inner tool calls fire the agent's `beforeToolCall` / `afterToolCall` hooks, so interventions still gate them. A call that needs interactive approval is refused, since a call made from code cannot prompt
- Inner tool calls do not run tool middleware, `AfterToolCallEvent.retry`, tool spans, or stream-update events

## Install

Requires the optional `@pydantic/monty` peer dependency and Node.js:

```bash
npm install @pydantic/monty@0.0.23
```

The native addon of that version needs glibc 2.39 or newer on Linux. Where it cannot load, the tool logs a warning and runs the interpreter in-process as WebAssembly (see [Limits](#limits)).

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

### Limits

The sandbox bounds the code's own compute time (60 seconds, not counting time spent waiting on tools), memory (256 MiB), and output (200,000 characters). Where the native Monty addon cannot load, the interpreter falls back to an in-process WebAssembly build that cannot be interrupted while the code computes, so compute time is capped at 5 seconds there.
