import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI panel integration', () => {
  it('opens and dismisses help, model, effort, and settings panels', async () => {
    const result = await runTuiScenario('panels')
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('Send a message')
    expect(clean).toContain('Fixture Model Alpha')
    expect(clean).toContain('Reasoning effort')
    expect(clean).toContain('Auto-Discovery')
    expectRestoredTerminal(result)
  })
})
