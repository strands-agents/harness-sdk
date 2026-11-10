import { describe, it, expect, vi } from 'vitest'
import type { Logger } from '../types.js'
import { warnOnce } from '../warn-once.js'

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('warnOnce', () => {
  it('emits a warning the first time a message is seen', () => {
    const logger = createLogger()
    warnOnce(logger, 'first-seen-msg')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('first-seen-msg')
  })

  it('does not emit repeated warnings for the same message', () => {
    const logger = createLogger()
    warnOnce(logger, 'repeated-msg')
    warnOnce(logger, 'repeated-msg')
    warnOnce(logger, 'repeated-msg')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('emits distinct messages independently', () => {
    const logger = createLogger()
    warnOnce(logger, 'distinct-alpha-msg')
    warnOnce(logger, 'distinct-beta-msg')
    warnOnce(logger, 'distinct-alpha-msg')
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenNthCalledWith(1, 'distinct-alpha-msg')
    expect(logger.warn).toHaveBeenNthCalledWith(2, 'distinct-beta-msg')
  })
})
