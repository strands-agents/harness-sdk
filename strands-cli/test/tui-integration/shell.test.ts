import { describe, expect, it } from 'vitest'

import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI shell integration', () => {
  it('runs a bang command and renders its complete output', async () => {
    const result = await runTuiScenario('shell-command')
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('__SHELL_LINE_1__')
    expect(clean).toContain('__SHELL_LINE_4__')
    expectRestoredTerminal(result)
  })

  it('delivers Ctrl-C to the active bang command without exiting', async () => {
    const result = await runTuiScenario('shell-interrupt')
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('Cancelled')
    expectRestoredTerminal(result)
  })
})
