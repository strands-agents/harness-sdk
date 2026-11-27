import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/fixtures/isolated-home.ts'],
    // Avoid competing subprocess teardown and temporary-directory locks on Windows.
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
    // Slower integration suites have dedicated configs and scripts.
    exclude: [...configDefaults.exclude, 'test/*.integration.test.ts', 'test/*.live.test.ts'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.ts'],
    },
  },
})
