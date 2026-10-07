import { defineConfig } from 'vitest/config'

import StatusTableReporter from './test/reporting/status-table-reporter.js'
import { TUI_CASES } from './test/tui-integration/catalog.js'

export default defineConfig({
  test: {
    include: ['test/tui-integration/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
    reporters: [
      new StatusTableReporter({
        suite: 'TUI integration',
        scenarios: TUI_CASES,
        target: () => (process.env.STRANDS_CLI_TEST_DIST === 'true' ? 'compiled' : 'source'),
      }),
    ],
  },
})
