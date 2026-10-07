import { describe, expect, it } from 'vitest'

import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { TUI_CASE } from './catalog.js'
import { expectRestoredTerminal, runTuiScenario } from './harness.js'

const STRANDS_WORDMARK = /STRANDS|╔════╝|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

describe('TUI startup integration', () => {
  it(TUI_CASE.startupFit.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.startupFit.scenario)
    const beforePrompt = result.output.slice(0, result.output.indexOf('Enter to send'))

    expect(result.returnCode).toBe(0)
    expect(sanitizeTerminalText(beforePrompt)).toMatch(STRANDS_WORDMARK)
    expect(sanitizeTerminalText(beforePrompt)).not.toContain('[ space to skip ]')
    expect(result.output).toContain('Enter to send')
    expect(beforePrompt.split('\u001b[2J').length - 1).toBe(1)
    expectRestoredTerminal(result)
  })

  it(TUI_CASE.startupInput.testName, async () => {
    const result = await runTuiScenario(TUI_CASE.startupInput.scenario)
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toMatch(STRANDS_WORDMARK)
    expect(clean).not.toContain('[ space to skip ]')
    expect(clean).toContain('Enter to send')
    expect(clean).toContain('startup draft')
    expectRestoredTerminal(result)
  })
})
