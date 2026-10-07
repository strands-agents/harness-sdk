import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI conversation integration', () => {
  it('submits a prompt, renders the streamed response, and exits cleanly', async () => {
    const result = await runTuiScenario('chat')
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('hello from integration')
    expect(clean).toContain('Fixture reply')
    expectRestoredTerminal(result)
  })
})
