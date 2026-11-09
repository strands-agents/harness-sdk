import { defineConfig } from 'vitest/config'

// End-to-end tests that drive the built `strands` binary against a live model: slow, need AWS
// credentials and a prior build, and non-deterministic — hence the long timeout and a couple of
// retries. Excluded from the default unit run (see vitest.config.ts); invoked via `test:integ`.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    retry: 2,
  },
})
