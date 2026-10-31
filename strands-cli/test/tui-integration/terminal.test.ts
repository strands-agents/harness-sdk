import { describe, expect, it } from 'vitest'

import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI terminal integration', () => {
  it('keeps the terminal usable across sequential and burst resizes', async () => {
    const result = await runTuiScenario('resize')

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

  it('accepts typed edits and restores the terminal after /exit', async () => {
    const result = await runTuiScenario('exit')

    expect(result.returnCode).toBe(0)
    expectRestoredTerminal(result)
  })
})
