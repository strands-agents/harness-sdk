import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { HarnessPicker } from '../../src/dev/picker.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const harness = {
  name: 'Project harness',
  entrypoint: '/project/agent.py',
  root: '/project',
  language: 'python' as const,
}

describe('HarnessPicker', () => {
  it('shouldKeepEveryChoiceReachableWhenTheTerminalIsSmall', async () => {
    const input = ttyInput()
    const output = ttyOutput(60, 20)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cliName: 'Saved profile',
        cliPath: '/home/test/.strands/cli.toml',
        harnesses: [harness],
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Base CLI'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Project harness'))
    expect(frame().join('\n')).toContain('/project/agent.py')
    input.write('\r')
    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }))
  })

  it('shouldSelectTheBaseCliWhenTheFirstChoiceIsAccepted', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cliName: 'Saved profile',
        cliPath: '/home/test/.strands/cli.toml',
        harnesses: [harness],
        onSelect: selected,
      }),
      {
        stdin: input,
        stdout: output,
      }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))

    const text = frame().join('\n')
    expect(text.indexOf('Base CLI')).toBeLessThan(text.indexOf('Project harness'))
    expect(text).toContain('Source: /home/test/.strands/cli.toml')
    expect(text).toContain('Manual import applies these changes globally')
    expect(text).toContain('development changes stay in this local workspace')
    expect(text).toContain('CLI DEFAULT')
    expect(text).toContain('LOCAL PROJECTS (1)')
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }))
  })

  it('shouldOfferCreationWhenOnlyTheBaseCliExists', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cliName: 'Saved profile',
        cliPath: '/home/test/.strands/cli.toml',
        harnesses: [],
        onSelect: selected,
      }),
      {
        stdin: input,
        stdout: output,
      }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Create a new harness'))

    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Language: typescript'))
    input.write('\t')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Language: python'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'python' })
    )
  })
})
