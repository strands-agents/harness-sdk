Strands provides two built-in Sandbox backends: `DockerSandbox` for containers on the local host, and `SshSandbox` for remote machines. Both automatically register `sandbox_shell` and `sandbox_file_editor` tools on the agent. This page covers their configuration, plus how to drive a sandbox directly from your own code.

## DockerSandbox

Executes operations inside a Docker container on the host via `docker exec`. The container must already be running; Strands does not create it.

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'

const sandbox = new DockerSandbox({
  container: 'agent-workspace',
  workingDir: '/workspace',
  user: '1000:1000',
})
const agent = new Agent({ sandbox })
void agent.invoke('Run the test suite and summarize any failures')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.sandbox.docker import DockerSandbox

sandbox = DockerSandbox(
    "agent-workspace",
    working_dir="/workspace",
    user="1000:1000",
)
agent = Agent(sandbox=sandbox)
agent("Run the test suite and summarize any failures")
```
(( /tab "Python" ))

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `container``container` | `str``string` | (required) | ID or name of a running container |
| `working_dir``workingDir` | `str \| None``string` | `None``container default` | Working directory for executed commands. If omitted, runs in the container’s configured working directory. |
| `user``user` | `str \| None``string` | `None``container default` | User to run commands as (`"uid"`, `"uid:gid"`, or name). If omitted, runs as the container’s configured user. |

## SshSandbox

Executes operations on a remote host via SSH. Each command spawns a fresh `ssh` process. There is no persistent connection. The host must be reachable with key-based authentication; `BatchMode` is enforced, so password prompts fail rather than block.

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { SshSandbox } from '@strands-agents/sdk/sandbox/ssh'

const sandbox = new SshSandbox({
  host: 'ubuntu@10.0.1.5',
  workingDir: '/home/ubuntu/workspace',
  identityFile: '~/.ssh/agent_key',
})
const agent = new Agent({ sandbox })
void agent.invoke('Check disk usage and list running processes')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.sandbox.ssh import SshSandbox

sandbox = SshSandbox(
    "ubuntu@10.0.1.5",
    working_dir="/home/ubuntu/workspace",
    identity_file="~/.ssh/agent_key",
)
agent = Agent(sandbox=sandbox)
agent("Check disk usage and list running processes")
```
(( /tab "Python" ))

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host``host` | `str``string` | (required) | SSH destination (e.g., `"user@host"`, `"192.168.1.10"`) |
| `working_dir``workingDir` | `str``string` | (required) | Working directory on the remote host |
| `identity_file``identityFile` | `str \| None``string` | `None``undefined` | Path to SSH private key file |
| `port``port` | `int``number` | `22` | SSH port |
| `allow_unknown_hosts``allowUnknownHosts` | `bool``boolean` | `False``false` | When false, uses `StrictHostKeyChecking=accept-new`. When true, disables host key verification. |
| `ssh_options``sshOptions` | `list[str] \| None``string[]` | `None``[]` | Additional SSH options passed as `-o` flags |
| `allow_unsafe_ssh_options``allowUnsafeSshOptions` | `bool``boolean` | `False``false` | Bypass the SSH option allowlist. When false, unknown options throw at construction time. |

### SSH Option Allowlist

By default, `SshSandbox` only permits known-safe SSH options (connection tuning, crypto, authentication). Unknown options throw an error at construction time. This prevents model-generated or user-provided options from executing commands on the host via directives like `ProxyCommand` or `LocalCommand`.

Security Warning

Setting `allowUnsafeSshOptions: true` bypasses this allowlist and lets any SSH option through, including directives that run commands on the local host. Only enable it with options you control, never with model-generated or untrusted input.

Neither backend sets environment variables at construction time. Pass them per-command via the `env` option on `execute()``execute()` / `execute_code()``executeCode()`.

## Working with a sandbox directly

You can drive a sandbox directly from your own code. This is useful for setup and verification around an agent run: seed input files, invoke the agent, then read results back.

| Method | Description |
| --- | --- |
| `execute``execute` | Run a shell command, return the result |
| `execute_code``executeCode` | Run code via an interpreter, return the result |
| `read_text``readText` | Read a file as a UTF-8 string |
| `write_text``writeText` | Write a string as UTF-8 |

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'

const agent = new Agent({
  sandbox: new DockerSandbox({ container: 'my-container-id' }),
})

// Seed an input file, let the agent work, then read the result back
await agent.sandbox.writeText('/workspace/input.csv', 'id,value\n1,42\n')

await agent.invoke(
  'Summarize /workspace/input.csv and write the summary to /workspace/out.txt'
)

const result = await agent.sandbox.execute('cat /workspace/out.txt')
console.log(result.exitCode, result.stdout)
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
async def main():
    agent = Agent(sandbox=DockerSandbox("my-container-id"))

    # Seed an input file, let the agent work, then read the result back
    await agent.sandbox.write_text("/workspace/input.csv", "id,value\n1,42\n")

    agent("Summarize /workspace/input.csv and write the summary to /workspace/out.txt")

    result = await agent.sandbox.execute("cat /workspace/out.txt")
    print(result.exit_code, result.stdout)


asyncio.run(main())
```
(( /tab "Python" ))

### Streaming output

`execute` waits for the command to finish. When you need output as it arrives, use the streaming form. It yields chunks as they are produced, then a final result with the exit code:

(( tab "TypeScript" ))
```typescript
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'

const sandbox = new DockerSandbox({ container: 'my-container-id' })

for await (const chunk of sandbox.executeStreaming('npm run build')) {
  if (chunk.type === 'streamChunk') {
    process.stdout.write(chunk.data)
  } else {
    console.log(`\nexit code: ${chunk.exitCode}`)
  }
}
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands.sandbox import ExecutionResult, StreamChunk


async def stream_example():
    sandbox = DockerSandbox("my-container-id")

    async for chunk in sandbox.execute_streaming("npm run build"):
        if isinstance(chunk, StreamChunk):
            print(chunk.data, end="")
        elif isinstance(chunk, ExecutionResult):
            print(f"\nexit code: {chunk.exit_code}")


asyncio.run(stream_example())
```
(( /tab "Python" ))

## Next steps

For more on configuring tools and plugins that work with sandboxes, see the overview. To target an environment the built-ins don’t cover, build a custom sandbox.

-   [Sandbox Overview](/docs/user-guide/sdk/sandbox/index.md): what a sandbox is, the tools it vends, and plugin compatibility
-   [Building a Custom Sandbox](/docs/user-guide/sdk/sandbox/custom-sandbox/index.md): target a backend the built-ins do not cover

## Related pages

- [Building a Custom Sandbox](/docs/user-guide/sdk/sandbox/custom-sandbox/index.md) (2 shared tags)
- [Sandbox](/docs/user-guide/sdk/sandbox/index.md) (2 shared tags)
- [Creating a Custom Model Provider](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) (1 shared tag)
- [Tools](/docs/user-guide/sdk/bidi/tools/index.md) (1 shared tag)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (1 shared tag)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (1 shared tag)
- [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (1 shared tag)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (1 shared tag)
