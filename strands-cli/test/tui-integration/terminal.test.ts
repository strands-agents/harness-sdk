import { describe, expect, it } from 'vitest'

import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI terminal integration', () => {
  it(TUI_CASE.resize.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.resize.scenario)

    expect(result.returnCode).toBe(0)
    expect(result.resizeOutput.split('\u001b[1;1H')).toHaveLength(7)
    expect(result.resizeBurstOutput.split('\u001b[1;1H')).toHaveLength(2)
    expect(result.resizeNoopOutput).toBe('')
    for (const code of ['2J', '3J', '2K']) {
      expect(result.resizeOutput + result.resizeBurstOutput).not.toContain(`\u001b[${code}`)
    }
    expectRestoredTerminal(result)
  })

  it(TUI_CASE.exit.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.exit.scenario)

    expect(result.returnCode).toBe(0)
    expectRestoredTerminal(result)
  })
})
