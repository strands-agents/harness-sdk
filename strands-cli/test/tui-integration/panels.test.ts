import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI panel integration', () => {
  it(TUI_CASE.panels.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.panels.scenario)
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('Send a message')
    expect(clean).toContain('Search help')
    expect(clean).toContain('Send your message')
    expect(clean).not.toContain('Viewing Help')
    expect(clean).not.toContain('Viewing Send a message')
    expect(clean).toContain('Current')
    expect(clean).toContain('Enter switch')
    expect(clean).toContain('Arrows · Enter')
    expect(clean).not.toContain('Viewing Agents')
    expect(clean).toContain('Server is not accepting connections')
    expect(clean).toContain('→ details')
    expect(clean).toContain('R retry')
    expect(clean).toContain('MCP: fixture-mcp')
    expect(clean).toContain('Check that the server is running')
    expect(clean).toContain('/tmp/fixture-mcp.json')
    expect(clean).toContain('Full error')
    expect(clean).toContain('connect ECONNREFUSED 127.0.0.1:43123')
    expect(clean).toMatch(/fixture-mcp[\s\S]*connected[\s\S]*1 tools/)
    expect(clean).toContain('Fixture Model Alpha')
    expect(clean).toContain('Reasoning effort')
    expect(clean).not.toContain('Viewing Tasks')
    expect(clean).toContain('Auto-Discovery')
    expect(clean).not.toContain('Viewing Voice')
    expectRestoredTerminal(result)
  })
})
