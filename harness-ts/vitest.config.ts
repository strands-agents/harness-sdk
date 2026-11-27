import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests hit a live model; they run via `test:integ`, never the default unit run.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
})
