import type { TestScenario } from '../reporting/status-table-reporter.js'

export const E2E_CASE = {
  toolTurn: {
    id: 'Tool turn',
    description: 'Built CLI asks a live model to create an artifact',
    testName: 'runs a one-shot turn that creates a file via a tool',
  },
} as const satisfies Record<string, TestScenario>

export const E2E_CASES: readonly TestScenario[] = Object.values(E2E_CASE)
