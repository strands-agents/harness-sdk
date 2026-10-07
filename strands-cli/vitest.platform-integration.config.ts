import { defineConfig } from 'vitest/config'

import { PLATFORM_CASES } from './test/platform-integration/catalog.js'
import StatusTableReporter from './test/reporting/status-table-reporter.js'

export default defineConfig({
  test: {
    include: ['test/platform-integration/**/*.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
    reporters: [
      new StatusTableReporter({
        suite: 'Platform E2E',
        scenarios: PLATFORM_CASES,
        target: () => 'compiled · deterministic',
      }),
    ],
  },
})
