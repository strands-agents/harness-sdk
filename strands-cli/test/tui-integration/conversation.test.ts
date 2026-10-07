import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI conversation integration', () => {
  it(TUI_CASE.conversation.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.conversation.scenario)
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('hello from integration')
    expect(clean).toContain('Fixture reply')
    expectRestoredTerminal(result)
  })
})
