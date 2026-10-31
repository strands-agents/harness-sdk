import { describe, expect, it } from 'vitest'

import { expectRestoredTerminal, runTuiScenario } from './harness.js'

describe('TUI workflow integration', () => {
  it('submits a prompt, renders the streamed response, and exits cleanly', async () => {
    const result = await runTuiScenario('chat')
    const clean = result.screens.join('\n')

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('hello from integration')
    expect(clean).toContain('Fixture reply')
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
