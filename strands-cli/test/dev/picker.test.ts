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
  it('shouldSelectTheBaseCliWhenTheFirstChoiceIsAccepted', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 25)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(createElement(HarnessPicker, { cliName: 'Saved profile', harnesses: [harness], onSelect: selected }), {
      stdin: input,
      stdout: output,
    })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))

    const text = frame().join('\n')
    expect(text.indexOf('Strands CLI')).toBeLessThan(text.indexOf('Project harness'))
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }))
  })

  it('shouldOfferCreationWhenOnlyTheBaseCliExists', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 25)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(createElement(HarnessPicker, { cliName: 'Saved profile', harnesses: [], onSelect: selected }), {
      stdin: input,
      stdout: output,
    })
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
