import type { TestScenario } from '../reporting/status-table-reporter.js'

export interface TuiIntegrationCase extends TestScenario {
  scenario: string
}

export const TUI_CASE = {
  conversation: {
    id: 'Conversation',
    scenario: 'chat',
    description: 'Prompt -> streamed reply -> clean exit',
    testName: 'submits a prompt, renders the streamed response, and exits cleanly',
  },
  panels: {
    id: 'Slash panels',
    scenario: 'panels',
    description: 'Help, model, effort, and settings via keyboard',
    testName: 'opens and dismisses help, model, effort, and settings panels',
  },
  shellCommand: {
    id: 'Shell output',
    scenario: 'shell-command',
    description: 'Bang command streams complete stdout',
    testName: 'runs a bang command and renders its complete output',
  },
  shellInterrupt: {
    id: 'Shell Ctrl-C',
    scenario: 'shell-interrupt',
    description: 'Ctrl-C cancels child without closing the TUI',
    testName: 'delivers Ctrl-C to the active bang command without exiting',
  },
  startupFit: {
    id: 'Startup fit',
    scenario: 'startup',
    description: 'Small terminal safely skips a non-fitting intro',
    testName: 'bypasses the intro when the full frog does not fit',
  },
  startupInput: {
    id: 'Startup input',
    scenario: 'startup-typing',
    description: 'Immediate spaced typing survives startup',
    testName: 'accepts spaced text immediately after startup',
  },
  resize: {
    id: 'Resize',
    scenario: 'resize',
    description: 'Frames resize without blank clears or burst churn',
    testName: 'resizes without blanking and coalesces resize bursts',
  },
  exit: {
    id: 'Exit cleanup',
    scenario: 'exit',
    description: 'Editing and /exit restore terminal state',
    testName: 'accepts typed edits and restores the terminal after /exit',
  },
  frog: {
    id: 'Frog',
    scenario: 'frog',
    description: 'Hidden animation renders and exits cleanly',
    testName: 'plays the hidden frog animation and exits cleanly',
  },
} as const satisfies Record<string, TuiIntegrationCase>

export const TUI_CASES: readonly TuiIntegrationCase[] = Object.values(TUI_CASE)
