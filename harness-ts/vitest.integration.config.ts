import { defineConfig } from 'vitest/config'

// End-to-end tests that hit a live model (Bedrock by default): slow, need AWS credentials, and
// non-deterministic — hence the long timeout, serial execution (tests chdir the process), and a
// couple of retries so an occasional model miss doesn't flake CI. The heaviest test forces six
// tool calls in strict sequence, one of which is a `subagent` delegation (a full nested agent
// loop), so the per-test budget has to cover more than a single model round-trip.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    retry: 2,
  },
})
