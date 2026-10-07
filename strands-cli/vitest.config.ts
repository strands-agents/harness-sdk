import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Slower integration suites have dedicated configs and scripts.
    exclude: [...configDefaults.exclude, 'test/integration/**', 'test/tui-integration/**'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.ts'],
    },
  },
})
