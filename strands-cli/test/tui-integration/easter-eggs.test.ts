import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI easter egg integration', () => {
  it('plays the hidden frog animation and exits cleanly', async () => {
    const result = await runTuiScenario('frog')
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('▗▄▄▖')
    expectRestoredTerminal(result)
  })
})
