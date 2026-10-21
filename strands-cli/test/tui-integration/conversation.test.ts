import { describe, expect, it } from 'vitest'

import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI conversation integration', () => {
  it(TUI_CASE.conversation.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.conversation.scenario)
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('hello from integration')
    expect(clean).toContain('Fixture reply')
    expectRestoredTerminal(result)
  })
})
