import type { TestScenario } from '../reporting/status-table-reporter.js'

export const PLATFORM_CASE = {
  exportedAgent: {
    id: 'Exported agent',
    description: 'ZIP imports and runs through the compiled CLI',
    testName: 'imports and runs an exported agent through the compiled CLI',
  },
  skills: {
    id: 'Skills',
    description: 'Local and URL skills survive export and load',
    testName: 'loads local and URL skills from the exported agent',
  },
  mcp: {
    id: 'MCP lifecycle',
    description: 'Exported MCP invokes and shuts down cleanly',
    testName: 'discovers, invokes, and disposes an exported MCP server',
  },
  session: {
    id: 'Session resume',
    description: 'A second CLI process restores prior context',
    testName: 'resumes an exported agent session across CLI processes',
  },
} as const satisfies Record<string, TestScenario>

export const PLATFORM_CASES: readonly TestScenario[] = Object.values(PLATFORM_CASE)
