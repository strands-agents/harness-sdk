import { configDefaults, defineConfig } from 'vitest/config'

import StatusTableReporter from './test/reporting/status-table-reporter.js'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Slower integration suites have dedicated configs and scripts.
    exclude: [...configDefaults.exclude, 'test/integration/**', 'test/tui-integration/**'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.ts'],
    },
    reporters: [new StatusTableReporter({ suite: 'Unit tests' })],
  },
})
