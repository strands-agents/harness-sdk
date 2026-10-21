import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI easter egg integration', () => {
  it(TUI_CASE.frog.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.frog.scenario)
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('▗▄▄▖')
    expectRestoredTerminal(result)
  })
})
