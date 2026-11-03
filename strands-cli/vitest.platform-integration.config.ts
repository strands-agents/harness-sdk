import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/platform.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 45_000,
    fileParallelism: false,
    reporters: ['verbose'],
  },
})
