import type { TestScenario } from '../reporting/status-table-reporter.js'

export const PLATFORM_CASE = {
  lifecycle: {
    id: 'Agent lifecycle',
    description: 'Talk -> export -> import -> talk -> re-export -> talk',
    testName: 'uses an agent across repeated export and import boundaries',
  },
  pythonLifecycle: {
    id: 'Python lifecycle',
    description: 'Python export -> import -> use -> re-export -> use',
    testName: 'uses an exported Python agent across repeated import boundaries',
  },
  setupImport: {
    id: 'Setup import',
    description: 'Setup UI imports, uses, saves, and relaunches an agent',
    testName: 'imports an agent through setup before using and re-exporting it',
  },
  failures: {
    id: 'Failure paths',
    description: 'Invalid saves and corrupt archives fail without false success',
    testName: 'reports save and archive failures without leaving artifacts',
  },
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
