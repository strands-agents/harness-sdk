import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/tui-integration/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
