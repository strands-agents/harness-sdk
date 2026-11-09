import { describe, expect, it } from 'vitest'
import { sanitizeTerminalText } from '../src/terminal/text.js'
import { expectRestoredTerminal, runTuiScenario } from './fixtures/terminal-harness.js'

describe('TUI panel integration', () => {
  it('opens slash panels and tabs across every multi-section layout', async () => {
    const result = await runTuiScenario('panels')
    const clean = result.screens.join('\n')

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

describe('TUI shell integration', () => {
  it('runs a bang command and renders its complete output', async () => {
    const result = await runTuiScenario('shell-command')
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('__SHELL_LINE_1__')
    expect(clean).toContain('__SHELL_LINE_4__')
    expectRestoredTerminal(result)
  })

  it('delivers Ctrl-C to the active bang command without exiting', async () => {
    const result = await runTuiScenario('shell-interrupt')
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('Cancelled')
    expectRestoredTerminal(result)
  })
})

const STRANDS_WORDMARK = /STRANDS|╚════╝|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

describe('TUI startup integration', () => {
  it('bypasses the intro when the full frog does not fit', async () => {
    const result = await runTuiScenario('startup')
    const beforePrompt = result.output.slice(0, result.output.indexOf('Enter to send'))

    expect(result.returnCode).toBe(0)
    expect(sanitizeTerminalText(beforePrompt)).toMatch(STRANDS_WORDMARK)
    expect(sanitizeTerminalText(beforePrompt)).not.toContain('[ space to skip ]')
    expect(result.screens.join('\n')).toContain('Enter to send')
    expectRestoredTerminal(result)
  })

  it('accepts spaced text immediately after startup', async () => {
    const result = await runTuiScenario('startup-typing')
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toMatch(STRANDS_WORDMARK)
    expect(clean).not.toContain('[ space to skip ]')
    expect(clean).toContain('Enter to send')
    expect(result.screens.join('\n')).toContain('startup draft')
    expectRestoredTerminal(result)
  })
})

describe('TUI terminal integration', () => {
  it('keeps the terminal usable across sequential and burst resizes', async () => {
    const result = await runTuiScenario('resize')

    expect(result.returnCode).toBe(0)
    expect(result.resizeScreens.map(({ columns, rows }) => [columns, rows])).toEqual([
      [80, 24],
      [40, 16],
      [22, 10],
      [160, 50],
      [160, 25],
      [100, 30],
      [120, 40],
    ])
    for (const { text } of result.resizeScreens) {
      expect(text.trim()).not.toBe('')
      expect(text).toMatch(/Enter(?: to)? send/)
    }
    expectRestoredTerminal(result)
  })

  it('accepts typed edits and restores the terminal after /exit', async () => {
    const result = await runTuiScenario('exit')

    expect(result.returnCode).toBe(0)
    expectRestoredTerminal(result)
  })

  it.each([
    ['exit-direct', 23, undefined],
    ['exit-exception', 1, 'Error: Fixture uncaught exception'],
    ['exit-rejection', 1, 'Error: Fixture unhandled rejection'],
  ] as const)('restores the terminal after %s without hiding the failure', async (scenario, code, error) => {
    // https://github.com/strands-agents/harness-sdk/issues/4961
    const result = await runTuiScenario(scenario)
    expect(result.returnCode).toBe(code)
    expectRestoredTerminal(result)
    if (error) {
      expect(result.output).toContain(error)
      expect(result.output.indexOf('\u001b[?1049l')).toBeLessThan(result.output.indexOf(error))
    }
  })

  // Sending these signals on Windows uses TerminateProcess, bypassing Node handlers.
  it.skipIf(process.platform === 'win32').each([
    ['exit-sigterm', 143],
    ['exit-sigint', 130],
    ['exit-sighup', 129],
  ] as const)('restores the terminal on %s', async (scenario, code) => {
    const result = await runTuiScenario(scenario)
    expect(result.returnCode).toBe(code)
    expectRestoredTerminal(result)
  })
})

describe('TUI workflow integration', () => {
  it('hands the terminal to a configured editor and resumes the CLI afterward', async () => {
    const result = await runTuiScenario('editor')
    expect(result.returnCode).toBe(0)
    expect(result.output).toContain('EDITOR_INPUT_OK')
    expectRestoredTerminal(result)
  })

  it('edits, steers, deletes, and reorders queued messages through the keyboard', async () => {
    const result = await runTuiScenario('queue')
    expect(result.returnCode).toBe(0)
    expect(result.screens.join('\n')).toContain('Executed: edited keep')
    expectRestoredTerminal(result)
  })

  it('keeps the voice panel open after enabling voice until dismissed', async () => {
    const result = await runTuiScenario('voice')
    expect(result.returnCode).toBe(0)
    expect(result.screens.join('\n')).toContain('Voice muted')
    expectRestoredTerminal(result)
  })

  it('submits a follow-up turn before exiting', async () => {
    const result = await runTuiScenario('follow-up')
    const clean = result.screens.join('\n')
    expect(clean).toContain('Fixture turn 1')
    expect(clean).toContain('Fixture turn 2')
    expectRestoredTerminal(result)
  })

  it('approves a pending tool request and resumes the turn', async () => {
    const result = await runTuiScenario('approval')
    const clean = result.screens.join('\n')
    expect(clean).toContain('Choose an action')
    expect(clean).toContain('Allow tool call?')
    expect(clean).toMatch(/Tool\s+write/u)
    expect(clean).toContain('approved.txt')
    expect(clean).toContain('Allow once')
    expect(clean).not.toContain('Permission required')
    expect(clean).toContain('Approval accepted')
    expectRestoredTerminal(result)
  })

  it('opens setup and saves an export to an explicit path', async () => {
    const result = await runTuiScenario('setup-export')
    expect(result.exportSaved).toBe(true)
    expect(result.screens.join('\n')).toContain('Export complete')
    expectRestoredTerminal(result)
  })
})
