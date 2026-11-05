import { describe, it, expect, inject } from 'vitest'
import { SshSandbox, type SshSandboxOptions } from '../../../src/sandbox/ssh.js'
import type { StreamChunk } from '../../../src/sandbox/types.js'

const sshEc2 = inject('provider-ssh-ec2')

function makeSandbox(overrides: Partial<SshSandboxOptions> = {}): SshSandbox {
  const options: SshSandboxOptions = {
    host: sshEc2.host!,
    workingDir: sshEc2.workingDir!,
    ...(sshEc2.identityFile !== undefined && { identityFile: sshEc2.identityFile }),
    ...(sshEc2.port !== undefined && { port: sshEc2.port }),
    allowUnknownHosts: true,
    ...overrides,
  }
  return new SshSandbox(options)
}

describe.skipIf(sshEc2.shouldSkip)('SshSandbox (integration)', () => {
  // -------------------------------------------------------------------------
  // Basic execution
  // -------------------------------------------------------------------------

  it('captures stdout, stderr, and exit code', async () => {
    const result = await makeSandbox().execute('echo hello && echo err >&2')
    expect(result).toStrictEqual({
      type: 'executionResult',
      exitCode: 0,
      stdout: 'hello\n',
      stderr: 'err\n',
      outputFiles: [],
    })
  })

  it('returns non-zero exit code', async () => {
    const result = await makeSandbox().execute('exit 42')
    expect(result.exitCode).toBe(42)
  })

  it('handles empty output', async () => {
    const result = await makeSandbox().execute('true')
    expect(result).toStrictEqual({
      type: 'executionResult',
      exitCode: 0,
      stdout: '',
      stderr: '',
      outputFiles: [],
    })
  })

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  it('executeStreaming yields chunks then a final result', async () => {
    const chunks: StreamChunk[] = []
    let exitCode: number | undefined
    for await (const item of makeSandbox().executeStreaming('echo line1 && echo line2')) {
      if (item.type === 'streamChunk') {
        chunks.push(item)
      } else {
        exitCode = item.exitCode
      }
    }
    expect(exitCode).toBe(0)
    const combined = chunks.map((c) => c.data).join('')
    expect(combined).toContain('line1')
    expect(combined).toContain('line2')
  })

  it('streaming separates stdout and stderr', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    for await (const item of makeSandbox().executeStreaming('echo OUT && echo ERR >&2')) {
      if (item.type === 'streamChunk') {
        if (item.streamType === 'stdout') stdout.push(item.data)
        else stderr.push(item.data)
      }
    }
    expect(stdout.join('')).toContain('OUT')
    expect(stderr.join('')).toContain('ERR')
  })

  // -------------------------------------------------------------------------
  // Code execution
  // -------------------------------------------------------------------------

  it('runs code via executeCode', async () => {
    const result = await makeSandbox().executeCode('echo $((6 * 7))', 'sh')
    expect(result).toStrictEqual({
      type: 'executionResult',
      exitCode: 0,
      stdout: '42\n',
      stderr: '',
      outputFiles: [],
    })
  })

  it('executeCode handles multiline scripts', async () => {
    const result = await makeSandbox().executeCode('x=hello\necho $x world', 'sh')
    expect(result).toStrictEqual({
      type: 'executionResult',
      exitCode: 0,
      stdout: 'hello world\n',
      stderr: '',
      outputFiles: [],
    })
  })

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  it('round-trips text files', async () => {
    const sandbox = makeSandbox()
    await sandbox.writeText('greeting.txt', 'hello ssh')
    expect(await sandbox.readText('greeting.txt')).toBe('hello ssh')
  })

  it('round-trips binary files', async () => {
    const sandbox = makeSandbox()
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
    await sandbox.writeFile('binary.bin', bytes)
    expect(Array.from(await sandbox.readFile('binary.bin'))).toStrictEqual(Array.from(bytes))
  })

  it('lists files', async () => {
    const sandbox = makeSandbox()
    await sandbox.writeText('a.txt', 'a')
    await sandbox.writeText('b.txt', 'b')
    const names = (await sandbox.listFiles('.')).map((f) => f.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('b.txt')
  })

  it('removes files', async () => {
    const sandbox = makeSandbox()
    await sandbox.writeText('to_remove.txt', 'bye')
    await sandbox.removeFile('to_remove.txt')
    await expect(sandbox.readFile('to_remove.txt')).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // Working directory and cwd override
  // -------------------------------------------------------------------------

  it('respects workingDir', async () => {
    const result = await makeSandbox().execute('pwd')
    expect(result.stdout.trim()).toBe(sshEc2.workingDir)
  })

  it('respects per-command cwd override', async () => {
    const result = await makeSandbox().execute('pwd', { cwd: '/tmp' })
    expect(result.stdout.trim()).toBe('/tmp')
  })

  // -------------------------------------------------------------------------
  // Environment variables
  // -------------------------------------------------------------------------

  it('passes env vars to the command', async () => {
    const result = await makeSandbox().execute('echo $MY_VAR', { env: { MY_VAR: 'hello-from-env' } })
    expect(result.stdout.trim()).toBe('hello-from-env')
  })

  it('env values with shell metacharacters are passed literally', async () => {
    const value = '$(whoami) $HOME `id`'
    const result = await makeSandbox().execute('printenv MY_VAR', { env: { MY_VAR: value } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(value)
  })

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  it('kills command on timeout', async () => {
    await expect(makeSandbox().execute('sleep 60', { timeout: 1 })).rejects.toThrow('timed out')
  })

  // -------------------------------------------------------------------------
  // Statelessness (each command is a fresh SSH process)
  // -------------------------------------------------------------------------

  it('is stateless between commands', async () => {
    const sandbox = makeSandbox()
    await sandbox.execute('export EPHEMERAL=1234')
    const result = await sandbox.execute('echo ${EPHEMERAL:-unset}')
    expect(result.stdout.trim()).toBe('unset')
  })

  // -------------------------------------------------------------------------
  // getTools()
  // -------------------------------------------------------------------------

  it('getTools returns sandbox_shell and sandbox_file_editor', () => {
    const tools = makeSandbox().getTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('sandbox_shell')
    expect(names).toContain('sandbox_file_editor')
  })

  it('getTools descriptions reference the host', () => {
    const sandbox = makeSandbox()
    for (const tool of sandbox.getTools()) {
      expect(tool.description).toContain(sandbox.host)
    }
  })

  // -------------------------------------------------------------------------
  // SSH options passthrough
  // -------------------------------------------------------------------------

  it('applies custom sshOptions without breaking the connection', async () => {
    const sandbox = makeSandbox({ sshOptions: ['ServerAliveInterval=5'] })
    const result = await sandbox.execute('echo options_ok')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('options_ok')
  })
})
