import { describe, expect, it } from 'vitest'

import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI terminal integration', () => {
  it(TUI_CASE.resize.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.resize.scenario)

    expect(result.returnCode).toBe(0)
    expect(result.resizeScreens.map(({ columns, rows }) => [columns, rows])).toEqual([
      [80, 24],
      [40, 16],
      [22, 10],
      [160, 50],
      [160, 25],
      [100, 30],
      [120, 40],
    ])
    for (const { text } of result.resizeScreens) {
      expect(text.trim()).not.toBe('')
      expect(text).toMatch(/Enter(?: to)? send/)
    }
    expectRestoredTerminal(result)
  })

  it(TUI_CASE.exit.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.exit.scenario)

    expect(result.returnCode).toBe(0)
    expectRestoredTerminal(result)
  })
})
