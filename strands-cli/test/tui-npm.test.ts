import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureNpm, npmInvocation } from '../src/tui/npm.js'

const execFile = vi.hoisted(() =>
  vi.fn((_command: string, _args: string[], _options: object, callback: (error: null, result: object) => void) => {
    callback(null, { stdout: '"1.2.0"\n', stderr: '' })
  })
)

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile,
}))

describe('npmInvocation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('runs npm directly outside Windows', () => {
    expect(npmInvocation(['view', '@strands-agents/cli@latest'], { platform: 'darwin' })).toEqual({
      command: 'npm',
      args: ['view', '@strands-agents/cli@latest'],
    })
  })

  it('runs npm.cmd through the Windows command shell', () => {
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')

    expect(npmInvocation(['install', '--global', '@strands-agents/cli@1.2.0'], { platform: 'win32' })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd install --global @strands-agents/cli@1.2.0'],
    })
  })

  it('falls back to cmd.exe when ComSpec is unset', () => {
    vi.stubEnv('ComSpec', undefined)

    expect(npmInvocation(['view'], { platform: 'win32' }).command).toBe('cmd.exe')
  })

  it.each(['1.2.0 & calc', '1.2.0|more', '"1.2.0"', '%PATH%', '1.2.0^', 'a b'])(
    'rejects %j before it reaches cmd.exe',
    (argument) => {
      expect(() => npmInvocation(['install', argument], { platform: 'win32' })).toThrow(/unsafe for cmd.exe/u)
    }
  )
})

describe('captureNpm', () => {
  it('passes the Windows invocation, timeout, and hidden console to execFile', async () => {
    expect(
      await captureNpm(['view', '@strands-agents/cli@latest', 'version', '--json'], {
        platform: 'win32',
        commandShell: 'cmd.exe',
        timeout: 3_000,
      })
    ).toBe('"1.2.0"\n')
    expect(execFile).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', 'npm.cmd view @strands-agents/cli@latest version --json'],
      { encoding: 'utf8', timeout: 3_000, windowsHide: true },
      expect.any(Function)
    )
  })
})
