import { describe, expect, it } from 'vitest'

import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI terminal integration', () => {
  it('resizes without blanking and coalesces resize bursts', async () => {
    const result = await runTuiScenario('resize')

    expect(result.returnCode).toBe(0)
    expect(result.resizeOutput.split('\u001b[1;1H')).toHaveLength(7)
    expect(result.resizeBurstOutput.split('\u001b[1;1H')).toHaveLength(2)
    expect(result.resizeNoopOutput).toBe('')
    for (const code of ['2J', '3J', '2K']) {
      expect(result.resizeOutput + result.resizeBurstOutput).not.toContain(`\u001b[${code}`)
    }
    expectRestoredTerminal(result)
  })

  it('accepts typed edits and restores the terminal after /exit', async () => {
    const result = await runTuiScenario('exit')

    expect(result.returnCode).toBe(0)
    expectRestoredTerminal(result)
  })
})
