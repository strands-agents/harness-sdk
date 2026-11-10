# Bash Tool

A robust tool for executing bash shell commands in Node.js environments with persistent session support.

> **`bash` vs `makeShell`**: these are two different tools. `bash` spawns a
> persistent `bash` process directly on the host, so it requires bash and keeps
> state across calls -- that is what this document describes. `makeShell`, which
> lives in [`../shell`](../shell/), builds a stateless tool that routes commands
> through a [Sandbox](../../sandbox/base.ts), which runs `sh` locally and in
> Docker or the remote login shell over SSH; commands passed to it must not rely
> on bash-specific syntax.

## ⚠️ Security Warning

**This tool executes arbitrary bash commands without sandboxing or restrictions.**

- Only use with trusted input
- Commands execute with the permissions of the Node.js process
- Environment variables are inherited from the parent process
- For production deployments, consider running in a sandboxed environment (containers, VMs, etc.)
- Review all commands before execution
- Never expose this tool to untrusted users without additional security measures

## Requirements

**Node.js Only**: This tool requires Node.js and uses the `child_process` module. It will not work in browser environments.

**Unix/Linux/macOS Only**: This tool uses the `bash` shell and is designed for Unix-like systems. It does not currently support Windows environments.

## Features

- **Persistent Sessions**: Commands execute in a persistent bash session, maintaining state (variables, working directory, etc.) across multiple invocations
- **Separate Output Streams**: Captures stdout and stderr independently
- **Configurable Timeouts**: Prevent commands from hanging indefinitely (default: 120 seconds)
- **Session Management**: Restart sessions to clear state when needed
- **Isolated Sessions**: Each agent instance gets its own isolated bash session
- **Working Directory**: Inherits the working directory from `process.cwd()`

## Installation

```typescript
import { bash } from '@strands-agents/sdk/vended-tools/bash'
```

## Usage

### With an Agent

```typescript
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

const agent = new Agent({
  model: new BedrockModel({
    region: 'us-east-1',
  }),
  tools: [bash],
})

// The agent can now use the bash tool
await agent.invoke('List all files in the current directory')
await agent.invoke('Create a new file called notes.txt with "Hello World"')
```

### Session Persistence

Variables, functions, and working directory persist across commands in the same session:

```typescript
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

const model = new BedrockModel({
  region: 'us-east-1',
})

const agent = new Agent({
  model,
  tools: [bash],
})

let res
res = await agent.invoke('run export "MY_VAR=hello"')
console.log(res.lastMessage)

res = await agent.invoke('run "echo $MY_VAR"')
console.log(res.lastMessage) // Will show "hello"
```

### Restart Session

Clear all session state and start fresh:

```typescript
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

const model = new BedrockModel({
  region: 'us-east-1',
})

const agent = new Agent({
  model,
  tools: [bash],
})

// Set a variable
let res = await agent.invoke('run export "TEMP_VAR=exists"')

// Restart the session
res = await agent.invoke('restart the bash session')

// Variable is now gone
res = await agent.invoke('run "echo $TEMP_VAR"')
console.log(res.lastMessage) // Variable will be empty/undefined
```

## API Reference

### Input Schema

#### Execute Mode

```typescript
interface ExecuteInput {
  mode: 'execute'
  command: string
  timeout?: number // Optional timeout in seconds (default: 120)
}
```

#### Restart Mode

```typescript
interface RestartInput {
  mode: 'restart'
}
```

### Return Value

#### Execute Mode

Returns an object with separate stdout and stderr:

```typescript
interface BashOutput {
  output: string // Standard output (stdout)
  error: string // Standard error (stderr) - empty string if no errors
}
```

### Error Handling

The tool throws custom errors for specific failure scenarios:

- **`BashTimeoutError`**: Thrown when a command exceeds its timeout
- **`BashSessionError`**: Thrown when the bash process encounters an error

The sandbox-routed tool from `makeShell` throws `ShellTimeoutError` and
`ShellExecutionError` instead. Both extend the `Bash*` types above, so existing
`catch` clauses keep matching.

```typescript
import { BashTimeoutError, BashSessionError } from '@strands-agents/sdk/vended-tools/bash'

try {
  await bash.invoke({ mode: 'execute', command: 'sleep 1000', timeout: 1 }, context)
} catch (error) {
  if (error instanceof BashTimeoutError) {
    console.log('Command timed out')
  } else if (error instanceof BashSessionError) {
    console.log('Session error occurred')
  }
}
```

## Implementation Details

### Session Management

- Each agent instance gets its own isolated bash session
- Sessions are stored in a WeakMap keyed by agent instance
- Sessions automatically clean up when the agent is garbage collected

### Working Directory

- The bash process starts in the directory returned by `process.cwd()`
- You can change directories using `cd` commands
- Directory changes persist within the session

### Timeout Behavior

- Default timeout is 120 seconds
- Timeout can be configured per-command
- On timeout, the bash process is killed immediately
- A `BashTimeoutError` is thrown

## Limitations

- **No browser support**: Cannot run in browser environments
- **Process permissions**: Commands run with the same permissions as the Node.js process
- **No sandboxing**: Commands execute without isolation or restrictions

## Best Practices

1. **Always validate input**: Never pass untrusted input directly to commands
2. **Use timeouts**: Set appropriate timeouts for long-running commands
3. **Check stderr**: Always check the `error` field in the return value
4. **Handle errors**: Wrap tool invocations in try-catch blocks
5. **Quote arguments**: Use proper shell quoting for arguments containing spaces or special characters
