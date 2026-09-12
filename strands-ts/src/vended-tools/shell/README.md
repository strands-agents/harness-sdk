# Shell Tool

A stateless shell tool that routes commands through a [Sandbox](../../sandbox/base.ts).

Each call runs in a fresh shell, so state such as variables and the working directory does not persist across calls. The sandbox decides which shell runs the command: `sh` locally and in Docker, the remote login shell over SSH. Commands must not rely on bash-specific syntax.

> **`makeShell` vs `bash`**: these are two different tools. The persistent, host-spawned `bash` tool lives in [`../bash`](../bash/); it requires bash on the host and keeps state across calls. `makeShell` is the sandbox-routed tool the built-in Docker and SSH sandboxes vend from `getTools()`.

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { makeShell } from '@strands-agents/sdk/vended-tools/shell'

const agent = new Agent({ tools: [makeShell()] })
await agent.invoke('List all files in the working directory')
```

With a sandbox bound at creation time (how the built-in sandboxes vend it):

```typescript
import { DockerSandbox } from '@strands-agents/sdk/sandbox'
import { makeShell } from '@strands-agents/sdk/vended-tools/shell'

const sandbox = new DockerSandbox({ container: 'my-container' })
const shellTool = makeShell(sandbox)
```

Without a bound sandbox, the tool reads `context.agent.sandbox` at call time.

## API

### `makeShell(options?)` / `makeShell(sandbox, options?)`

| Option        | Type        | Default    | Description                     |
| ------------- | ----------- | ---------- | ------------------------------- |
| `name`        | `string`    | `shell`    | Tool name.                      |
| `description` | `string`    | (built-in) | Description shown to the model. |
| `inputSchema` | `z.ZodType` | (built-in) | Override the input schema.      |

### Input

```typescript
{
  command: string   // The shell command to execute
  timeout?: number  // Timeout in seconds (default: 120)
}
```

### Return Value

```typescript
interface ShellOutput {
  output: string // Standard output (stdout)
  error: string // Standard error (stderr) - empty string if no errors
  exit_code: number // Exit code of the command - non-zero means it failed
}
```

### Error Handling

- **`ShellTimeoutError`**: thrown when a command exceeds its timeout
- **`ShellExecutionError`**: thrown when the sandbox fails to execute the command

Both extend the `Bash*` error types from [`../bash`](../bash/), so `catch` clauses written before the rename keep matching.

### Deprecated aliases

`makeBash` builds the same tool with the pre-rename default name `bash`; it will be removed in v2.0.0. Prefer `makeShell`.
