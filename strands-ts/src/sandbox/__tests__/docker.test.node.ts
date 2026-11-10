import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DockerSandbox } from '../docker.js'
import { streamProcess } from '../stream-process.js'
import type { ExecutionResult } from '../types.js'
import { SANDBOX_SHELL_DESCRIPTION } from '../../vended-tools/shell/types.js'

const OK: ExecutionResult = { type: 'executionResult', exitCode: 0, stdout: '', stderr: '', outputFiles: [] }

vi.mock('../stream-process.js', () => ({
  streamProcess: vi.fn(async function* () {
    yield OK
  }),
}))

describe('DockerSandbox', () => {
  beforeEach(() => {
    vi.mocked(streamProcess).mockClear()
  })

  describe('executeStreaming', () => {
    it('terminates flags with -- so a dash-prefixed container is not parsed as a flag', async () => {
      const sandbox = new DockerSandbox({ container: '--privileged' })
      await sandbox.execute('echo hi')

      const args = vi.mocked(streamProcess).mock.calls[0]![1]
      expect(args.slice(-5)).toStrictEqual(['--', '--privileged', 'sh', '-c', 'echo hi'])
    })

    it('omits --user and -w when user and workingDir are unset', async () => {
      const sandbox = new DockerSandbox({ container: 'my-container' })
      await sandbox.execute('echo hi')

      expect(streamProcess).toHaveBeenCalledWith('docker', ['exec', '--', 'my-container', 'sh', '-c', 'echo hi'], {
        timeout: undefined,
        signal: undefined,
        enoentMessage: 'docker is not installed or not on PATH',
      })
    })

    it('uses custom user and workingDir', async () => {
      const sandbox = new DockerSandbox({ container: 'my-container', user: 'root', workingDir: '/app' })
      await sandbox.execute('ls')

      const args = vi.mocked(streamProcess).mock.calls[0]![1]
      expect(args).toStrictEqual(['exec', '--user', 'root', '-w', '/app', '--', 'my-container', 'sh', '-c', 'ls'])
    })

    it('cwd option overrides workingDir', async () => {
      const sandbox = new DockerSandbox({ container: 'my-container', workingDir: '/app' })
      await sandbox.execute('pwd', { cwd: '/override' })

      const args = vi.mocked(streamProcess).mock.calls[0]![1]
      expect(args).toStrictEqual(['exec', '-w', '/override', '--', 'my-container', 'sh', '-c', 'pwd'])
    })

    it('forwards timeout and signal to streamProcess', async () => {
      const sandbox = new DockerSandbox({ container: 'my-container' })
      const controller = new AbortController()
      await sandbox.execute('sleep 10', { timeout: 5, signal: controller.signal })

      const opts = vi.mocked(streamProcess).mock.calls[0]![2]
      expect(opts).toStrictEqual({
        timeout: 5,
        signal: controller.signal,
        enoentMessage: 'docker is not installed or not on PATH',
      })
    })

    it('passes env vars as -e flags before container ID', async () => {
      const sandbox = new DockerSandbox({ container: 'my-container' })
      await sandbox.execute('echo $FOO', { env: { FOO: 'bar', BAZ: 'qux' } })

      const args = vi.mocked(streamProcess).mock.calls[0]![1]
      expect(args).toStrictEqual([
        'exec',
        '-e',
        'FOO=bar',
        '-e',
        'BAZ=qux',
        '--',
        'my-container',
        'sh',
        '-c',
        'echo $FOO',
      ])
    })

    it('rejects invalid env var names', async () => {
      const sandbox = new DockerSandbox({ container: 'my-container' })

      await expect(sandbox.execute('cmd', { env: { 'FOO=bar BAZ': 'val' } })).rejects.toThrow(
        'Invalid environment variable name'
      )
    })
  })

  describe('getTools', () => {
    it('vends the sandbox-routed fileEditor and bash tools', () => {
      const tools = new DockerSandbox({ container: 'my-container' }).getTools()
      expect(tools.map((t) => t.name)).toStrictEqual(['sandbox_file_editor', 'sandbox_shell'])
    })

    it('vends bash with the sandbox description', () => {
      const tools = new DockerSandbox({ container: 'my-container' }).getTools()
      const shellTool = tools.find((t) => t.name === 'sandbox_shell')!
      expect(shellTool.description).toContain(SANDBOX_SHELL_DESCRIPTION)
      expect(shellTool.description).toContain('my-container')
    })
  })
})
