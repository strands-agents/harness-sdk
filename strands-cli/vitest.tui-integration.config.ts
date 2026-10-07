import { defineConfig } from 'vitest/config'

import TuiIntegrationReporter from './test/tui-integration/reporter.js'

export default defineConfig({
  test: {
    include: ['test/tui-integration/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
    reporters: [new TuiIntegrationReporter()],
  },
})
