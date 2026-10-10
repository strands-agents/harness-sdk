# Python REPL Tool

Runs model-generated Python through a [Sandbox](../../sandbox/base.ts) by calling `sandbox.executeCode(code, 'python3')`.

Each call runs in a fresh interpreter, so variables, imports, and definitions do not persist across calls. Files written to the sandbox filesystem persist for as long as the sandbox does, so the model can checkpoint intermediate results to disk and load them in a later call. stdin is not available, so `input()` fails.

> **Security warning**: this tool executes arbitrary Python code. Without an isolating sandbox (the default `NotASandboxLocalEnvironment`), code runs with the full permissions of the process.

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { pythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'

const agent = new Agent({ tools: [pythonRepl] })
await agent.invoke('Use python_repl to compute the first 10 Fibonacci numbers and print them.')
```

With a bound sandbox or a custom interpreter:

```typescript
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { makePythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'

const pythonTool = makePythonRepl(new DockerSandbox({ container: 'my-container' }), { language: 'python3.12' })
```

Without a bound sandbox, the tool reads `context.agent.sandbox` at call time.

## API

### `makePythonRepl(options?)` / `makePythonRepl(sandbox, options?)`

| Option        | Type     | Default       | Description                                                                                |
| ------------- | -------- | ------------- | ------------------------------------------------------------------------------------------ |
| `name`        | `string` | `python_repl` | Tool name. Must be non-empty.                                                              |
| `description` | `string` | (built-in)    | Description shown to the model.                                                            |
| `language`    | `string` | `python3`     | Interpreter on the sandbox's `PATH`. Validated against `LANGUAGE_PATTERN` at construction. |

### Input

```typescript
{
  code: string      // Python source to execute
  timeout?: number  // Timeout in seconds (default: 120). Must be positive.
}
```

### Return Value

```typescript
interface PythonReplOutput {
  output: string // Standard output (stdout)
  error: string // Standard error (stderr), including tracebacks - empty string if none
  exit_code: number // Exit code of the interpreter - non-zero means the code failed
}
```

### Error Handling

- Errors in the Python code itself are reported through `error` and a non-zero `exit_code`, not thrown.
- `SandboxTimeoutError`: execution exceeded `timeout`. The message carries the partial output as JSON with the success field names and `exit_code: 124`.
- `SandboxAbortError`: the agent cancelled the call (`context.cancelSignal`); the sandbox is told to stop the interpreter and the error propagates unwrapped.
- `PythonReplError`: the sandbox failed to run the code (for example, an unreachable container). The original error is available as `cause`.
