import type { TestScenario } from '../reporting/status-table-reporter.js'

export const E2E_CASE = {
  exportedAgent: {
    id: 'Exported agent',
    description: 'A generated archive answers through a live provider',
    testName: 'runs an exported agent against a live model',
  },
  toolTurn: {
    id: 'Tool turn',
    description: 'Built CLI asks a live model to create an artifact',
    testName: 'runs a one-shot turn that creates a file via a tool',
  },
  selfBuildingTypescript: {
    id: 'Self-building TypeScript',
    description: 'Live chat adds MCP, uses two fresh TypeScript imports, and matches /config to every export',
    testName: 'adds an MCP server through chat and preserves it across repeated TypeScript export and import',
  },
  selfBuildingPython: {
    id: 'Self-building Python',
    description: 'Live chat adds MCP, uses two fresh Python imports, and matches /config to every export',
    testName: 'adds an MCP server through chat and preserves it across repeated Python export and import',
  },
} as const satisfies Record<string, TestScenario>

export const E2E_CASES: readonly TestScenario[] = Object.values(E2E_CASE)
