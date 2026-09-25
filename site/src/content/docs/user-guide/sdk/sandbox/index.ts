import { spawn } from 'node:child_process'
import { Agent, tool, type Tool } from '@strands-agents/sdk'
import { makeShell } from '@strands-agents/sdk/vended-tools/shell'
import { makeFileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { PosixShellSandbox } from '@strands-agents/sdk/sandbox'
import type {
  ExecuteOptions,
  StreamChunk,
  ExecutionResult,
} from '@strands-agents/sdk/sandbox'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { SshSandbox } from '@strands-agents/sdk/sandbox/ssh'
import { z } from 'zod'

async function basicUsage() {
  // --8<-- [start:basic_usage]
  const agent = new Agent({
    sandbox: new DockerSandbox({ container: 'my-container-id' }),
  })

  // The agent's sandbox_shell and sandbox_file_editor tools execute inside the container
  await agent.invoke('List all files inside the current directory')
  // --8<-- [end:basic_usage]
}

// --8<-- [start:custom_sandbox]
class FirecrackerSandbox extends PosixShellSandbox {
  constructor(private readonly vmId: string) {
    super()
  }

  async *executeStreaming(
    command: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    const proc = spawn('fc-exec', [this.vmId, 'sh', '-c', command])

    let stdout = ''
    let stderr = ''
    for await (const data of proc.stdout) {
      const text = data.toString()
      stdout += text
      yield { type: 'streamChunk', data: text, streamType: 'stdout' }
    }
    for await (const data of proc.stderr) {
      const text = data.toString()
      stderr += text
      yield { type: 'streamChunk', data: text, streamType: 'stderr' }
    }
    const exitCode: number = await new Promise((resolve) =>
      proc.on('close', (code) => resolve(code ?? 0))
    )
    yield { type: 'executionResult', exitCode, stdout, stderr, outputFiles: [] }
  }
  // --8<-- [end:custom_sandbox]

  // --8<-- [start:vend_tools]
  override getTools(): Tool[] {
    return [
      makeFileEditor(this, { name: 'sandbox_file_editor' }),
      makeShell(this, { name: 'sandbox_shell' }),
    ]
  }
  // --8<-- [end:vend_tools]
}

function dockerConstructor() {
  // --8<-- [start:docker_constructor]
  const sandbox = new DockerSandbox({
    container: 'agent-workspace',
    workingDir: '/workspace',
    user: '1000:1000',
  })
  const agent = new Agent({ sandbox })
  void agent.invoke('Run the test suite and summarize any failures')
  // --8<-- [end:docker_constructor]
}

function sshConstructor() {
  // --8<-- [start:ssh_constructor]
  const sandbox = new SshSandbox({
    host: 'ubuntu@10.0.1.5',
    workingDir: '/home/ubuntu/workspace',
    identityFile: '~/.ssh/agent_key',
  })
  const agent = new Agent({ sandbox })
  void agent.invoke('Check disk usage and list running processes')
  // --8<-- [end:ssh_constructor]
}

function toolOverride() {
  // --8<-- [start:tool_override]
  const sandbox = new DockerSandbox({ container: 'agent-workspace' })

  const lockedShell = makeShell(sandbox, {
    name: 'sandbox_shell',
    description: 'Run read-only shell commands. Do not modify files.',
  })

  // The agent keeps lockedShell; the sandbox's own sandbox_shell is skipped
  const agent = new Agent({ sandbox, tools: [lockedShell] })
  // --8<-- [end:tool_override]
  return agent
}

// --8<-- [start:custom_tool]
const lint = tool({
  name: 'lint',
  description: 'Lint a file and return structured errors',
  inputSchema: z.object({
    path: z.string().describe('File path to lint'),
  }),
  callback: async (input, context) => {
    const result = await context!.agent.sandbox.execute(
      `eslint --format json ${input.path}`
    )
    const issues = JSON.parse(result.stdout)
    return issues.flatMap((f: any) => f.messages)
  },
})

const agent = new Agent({
  sandbox: new DockerSandbox({ container: 'my-dev-env' }),
  tools: [lint],
})
// Agent now has: sandbox_shell, sandbox_file_editor (vended) + lint (yours)
// --8<-- [end:custom_tool]

async function programmaticAccess() {
  // --8<-- [start:programmatic_access]
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
  // --8<-- [end:programmatic_access]
}

async function streaming() {
  // --8<-- [start:streaming]
  const sandbox = new DockerSandbox({ container: 'my-container-id' })

  for await (const chunk of sandbox.executeStreaming('npm run build')) {
    if (chunk.type === 'streamChunk') {
      process.stdout.write(chunk.data)
    } else {
      console.log(`\nexit code: ${chunk.exitCode}`)
    }
  }
  // --8<-- [end:streaming]
}

export {
  basicUsage,
  dockerConstructor,
  sshConstructor,
  programmaticAccess,
  FirecrackerSandbox,
  lint,
}
