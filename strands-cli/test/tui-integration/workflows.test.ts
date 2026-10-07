import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI workflow integration', () => {
  it(TUI_CASE.followUp.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.followUp.scenario)
    const clean = sanitizeTerminalText(result.output)
    expect(clean).toContain('Fixture turn 1')
    expect(clean).toContain('Fixture turn 2')
    expectRestoredTerminal(result)
  })

  it(TUI_CASE.approval.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.approval.scenario)
    const clean = sanitizeTerminalText(result.output)
    expect(clean).toContain('Allow once')
    expect(clean).toContain('Approval accepted')
    expectRestoredTerminal(result)
  })

  it(TUI_CASE.setupExport.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.setupExport.scenario)
    expect(result.exportSaved).toBe(true)
    expect(sanitizeTerminalText(result.output)).toContain('Export complete')
    expectRestoredTerminal(result)
  })
})
