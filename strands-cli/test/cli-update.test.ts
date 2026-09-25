import { describe, expect, it, vi } from 'vitest'

import { updateCli, type UpdateRunner } from '../src/cli/update.js'
import { availableCliUpdate, compareVersions, isNewerVersion } from '../src/tui/update-check.js'

function memoryOutput(): { stream: Pick<NodeJS.WriteStream, 'write'>; text: () => string } {
  let value = ''
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        value += chunk.toString()
        return true
      },
    },
    text: () => value,
  }
}

function runner(latest = '"1.2.0"\n', exitCode = 0): UpdateRunner {
  return {
    capture: vi.fn(async () => latest),
    inherit: vi.fn(async () => exitCode),
  }
}

describe('updateCli', () => {
  it('does not update a development checkout', async () => {
    const commands = runner()
    const errors = memoryOutput()

    expect(await updateCli({ currentVersion: '0.0.1-development', runner: commands, errorOutput: errors.stream })).toBe(
      1
    )
    expect(commands.capture).not.toHaveBeenCalled()
    expect(errors.text()).toContain('development checkout')
  })

  it('reports an already-current global installation', async () => {
    const commands = runner()
    const output = memoryOutput()

    expect(await updateCli({ currentVersion: '1.2.0', runner: commands, output: output.stream })).toBe(0)
    expect(commands.capture).toHaveBeenCalledWith('npm', ['view', '@strands-agents/cli@latest', 'version', '--json'])
    expect(commands.inherit).not.toHaveBeenCalled()
    expect(output.text()).toBe('Strands CLI 1.2.0 is already up to date.\n')
  })

  it('installs the latest global package', async () => {
    const commands = runner()
    const output = memoryOutput()

    expect(await updateCli({ currentVersion: '1.1.0', runner: commands, output: output.stream })).toBe(0)
    expect(commands.inherit).toHaveBeenCalledWith('npm', ['install', '--global', '@strands-agents/cli@1.2.0'])
    expect(output.text()).toContain('Updating Strands CLI from 1.1.0 to 1.2.0')
    expect(output.text()).toContain('Updated Strands CLI to 1.2.0')
  })

  it('uses npm.cmd on Windows and preserves an install failure', async () => {
    const commands = runner('"1.2.0"', 7)
    const output = memoryOutput()
    const errors = memoryOutput()

    expect(
      await updateCli({
        currentVersion: '1.1.0',
        runner: commands,
        output: output.stream,
        errorOutput: errors.stream,
        platform: 'win32',
      })
    ).toBe(7)
    expect(commands.capture).toHaveBeenCalledWith('cmd.exe', [
      '/d',
      '/s',
      '/c',
      'npm.cmd view @strands-agents/cli@latest version --json',
    ])
    expect(commands.inherit).toHaveBeenCalledWith('cmd.exe', [
      '/d',
      '/s',
      '/c',
      'npm.cmd install --global @strands-agents/cli@1.2.0',
    ])
    expect(errors.text()).toContain('exit code 7')
  })

  it('does not downgrade a version newer than npm latest', async () => {
    const commands = runner('"1.2.0"')
    const output = memoryOutput()

    expect(await updateCli({ currentVersion: '2.0.0-beta.1', runner: commands, output: output.stream })).toBe(0)
    expect(commands.inherit).not.toHaveBeenCalled()
    expect(output.text()).toContain('newer than npm latest 1.2.0')
  })

  it('treats build metadata variants as the same version', async () => {
    const commands = runner('"1.2.0"')
    const output = memoryOutput()

    expect(await updateCli({ currentVersion: '1.2.0+local', runner: commands, output: output.stream })).toBe(0)
    expect(commands.inherit).not.toHaveBeenCalled()
    expect(output.text()).toContain('already up to date')
  })

  it('reports invalid npm registry output', async () => {
    const errors = memoryOutput()

    expect(
      await updateCli({
        currentVersion: '1.1.0',
        runner: runner('{}'),
        errorOutput: errors.stream,
      })
    ).toBe(1)
    expect(errors.text()).toContain('npm returned an invalid package version')
  })
})

describe('availableCliUpdate', () => {
  it('reports a newer published version', async () => {
    const resolveLatest = vi.fn(async () => '1.2.0')

    expect(await availableCliUpdate({ currentVersion: '1.1.0', resolveLatest })).toBe('1.2.0')
    expect(resolveLatest).toHaveBeenCalledOnce()
  })

  it('stays quiet when current, newer, offline, or running from a development checkout', async () => {
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })
    const current = vi.fn(async () => '1.2.0')

    expect(await availableCliUpdate({ currentVersion: '1.2.0', resolveLatest: current })).toBeUndefined()
    expect(await availableCliUpdate({ currentVersion: '2.0.0-beta.1', resolveLatest: current })).toBeUndefined()
    expect(await availableCliUpdate({ currentVersion: '1.1.0', resolveLatest: offline })).toBeUndefined()
    expect(await availableCliUpdate({ currentVersion: '0.0.1-development', resolveLatest: current })).toBeUndefined()
    expect(current).toHaveBeenCalledTimes(2)
  })
})

describe('isNewerVersion', () => {
  it.each([
    ['1.2.0', '1.1.9', true],
    ['2.0.0', '1.99.99', true],
    ['1.2.0', '1.2.0-beta.2', true],
    ['1.2.0-beta.10', '1.2.0-beta.2', true],
    ['1.2.0-beta.2', '1.2.0', false],
    ['1.2.0', '2.0.0-beta.1', false],
    ['invalid', '1.2.0', false],
  ])('compares %s against %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected)
  })

  it('ignores build metadata and rejects malformed versions', () => {
    expect(compareVersions('1.2.0+published', '1.2.0+local')).toBe(0)
    expect(compareVersions('invalid', '1.2.0')).toBeUndefined()
  })
})
