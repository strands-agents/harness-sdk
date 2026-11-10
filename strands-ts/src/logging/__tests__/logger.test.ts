import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureLogging, logger } from '../logger.js'

describe('configureLogging', () => {
  let originalLogger: typeof logger

  beforeEach(() => {
    // Store original logger
    originalLogger = logger
  })

  afterEach(() => {
    // Restore original logger
    configureLogging(originalLogger)
  })

  it('allows custom logger injection', () => {
    const customLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    configureLogging(customLogger)

    logger.debug('Debug message')
    logger.info('Info message')
    logger.warn('Warn message')
    logger.error('Error message')

    expect(customLogger.debug).toHaveBeenCalledWith('Debug message')
    expect(customLogger.info).toHaveBeenCalledWith('Info message')
    expect(customLogger.warn).toHaveBeenCalledWith('Warn message')
    expect(customLogger.error).toHaveBeenCalledWith('Error message')
  })

  it('passes multiple arguments to logger', () => {
    const customLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    configureLogging(customLogger)

    const obj = { key: 'value' }
    const arr = [1, 2, 3]
    logger.error('Error message', obj, arr, 123, true)

    expect(customLogger.error).toHaveBeenCalledWith('Error message', obj, arr, 123, true)
  })
})

describe('default logger', () => {
  it('logs warnings to console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn')

    logger.warn('Warning message', 'arg1', 'arg2')

    expect(warnSpy).toHaveBeenCalledWith('Warning message', 'arg1', 'arg2')

    warnSpy.mockRestore()
  })

  it('logs errors to console.error', () => {
    const errorSpy = vi.spyOn(console, 'error')

    logger.error('Error message', 'arg1', 'arg2')

    expect(errorSpy).toHaveBeenCalledWith('Error message', 'arg1', 'arg2')

    errorSpy.mockRestore()
  })

  it('does not log debug messages', () => {
    const debugSpy = vi.spyOn(console, 'debug')

    logger.debug('Debug message')

    expect(debugSpy).not.toHaveBeenCalled()

    debugSpy.mockRestore()
  })

  it('does not log info messages', () => {
    const infoSpy = vi.spyOn(console, 'info')

    logger.info('Info message')

    expect(infoSpy).not.toHaveBeenCalled()

    infoSpy.mockRestore()
  })
})
