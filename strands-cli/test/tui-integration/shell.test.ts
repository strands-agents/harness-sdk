import { describe, expect, it } from 'vitest'

import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI shell integration', () => {
  it(TUI_CASE.shellCommand.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.shellCommand.scenario)
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('__SHELL_LINE_1__')
    expect(clean).toContain('__SHELL_LINE_4__')
    expectRestoredTerminal(result)
  })

  it(TUI_CASE.shellInterrupt.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.shellInterrupt.scenario)
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('Cancelled')
    expectRestoredTerminal(result)
  })
})
