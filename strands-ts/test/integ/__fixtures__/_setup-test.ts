/**
 * Test setup that runs once before all integration tests, but in the *child* process.
 *
 * _setup-global on the other hand runs in the *parent* process.
 */

import { beforeAll } from 'vitest'
import { configureLogging } from '$/sdk/logging/index.js'
import { isCI } from './test-helpers.js'

beforeAll(() => {
  // When running under CI/CD, preserve all logs including debug
  if (isCI()) {
    configureLogging({
      debug: (...args: unknown[]) => console.debug(...args),
      info: (...args: unknown[]) => console.info(...args),
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => console.error(...args),
    })
  }
})
