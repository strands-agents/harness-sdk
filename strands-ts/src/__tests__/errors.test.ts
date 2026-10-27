import { describe, it, expect } from 'vitest'
import {
  ModelError,
  ContextWindowOverflowError,
  MaxTokensError,
  ModelThrottledError,
  normalizeError,
} from '../errors.js'
import { Message, TextBlock } from '../types/messages.js'

describe('ModelError', () => {
  describe('when instantiated with a message', () => {
    it('creates an error with the correct message', () => {
      const message = 'Model error occurred'
      const error = new ModelError(message)

      expect(error.message).toBe(message)
    })

    it('has the correct error name', () => {
      const error = new ModelError('test')

      expect(error.name).toBe('ModelError')
    })

    it('is an instance of Error', () => {
      const error = new ModelError('test')

      expect(error).toBeInstanceOf(Error)
    })
  })

  describe('when instantiated with a cause', () => {
    it('stores the cause error', () => {
      const cause = new Error('original error')
      const error = new ModelError('wrapped error', { cause })

      expect(error.message).toBe('wrapped error')
      expect(error.cause).toBe(cause)
    })
  })
})

describe('ContextWindowOverflowError', () => {
  describe('when instantiated with a message', () => {
    it('creates an error with the correct message', () => {
      const message = 'Context window overflow occurred'
      const error = new ContextWindowOverflowError(message)

      expect(error.message).toBe(message)
    })

    it('has the correct error name', () => {
      const error = new ContextWindowOverflowError('test')

      expect(error.name).toBe('ContextWindowOverflowError')
    })

    it('is an instance of Error', () => {
      const error = new ContextWindowOverflowError('test')

      expect(error).toBeInstanceOf(Error)
    })

    it('is an instance of ModelError', () => {
      const error = new ContextWindowOverflowError('test')

      expect(error).toBeInstanceOf(ModelError)
    })
  })

  describe('when instantiated with a cause', () => {
    it('stores the cause event', () => {
      const cause = { type: 'message_delta' }
      const error = new ContextWindowOverflowError('context window overflow occurred', { cause })

      expect(error.cause).toBe(cause)
    })
  })
})

describe('MaxTokensError', () => {
  describe('when instantiated with a message and partial message', () => {
    it('creates an error with the correct message', () => {
      const partialMessage = new Message({
        role: 'assistant',
        content: [new TextBlock('partial response')],
      })
      const error = new MaxTokensError('Max tokens reached', partialMessage)

      expect(error.message).toBe('Max tokens reached')
    })

    it('has the correct error name', () => {
      const partialMessage = new Message({
        role: 'assistant',
        content: [new TextBlock('partial response')],
      })
      const error = new MaxTokensError('test', partialMessage)

      expect(error.name).toBe('MaxTokensError')
    })

    it('stores the partial message', () => {
      const partialMessage = new Message({
        role: 'assistant',
        content: [new TextBlock('partial response')],
      })
      const error = new MaxTokensError('Max tokens reached', partialMessage)

      expect(error.partialMessage).toBe(partialMessage)
    })

    it('is an instance of Error', () => {
      const partialMessage = new Message({
        role: 'assistant',
        content: [new TextBlock('partial response')],
      })
      const error = new MaxTokensError('test', partialMessage)

      expect(error).toBeInstanceOf(Error)
    })

    it('is an instance of ModelError', () => {
      const partialMessage = new Message({
        role: 'assistant',
        content: [new TextBlock('partial response')],
      })
      const error = new MaxTokensError('test', partialMessage)

      expect(error).toBeInstanceOf(ModelError)
    })
  })
})

describe('ModelThrottledError', () => {
  describe('when instantiated with a message', () => {
    it('creates an error with the correct message', () => {
      const message = 'Rate limit exceeded'
      const error = new ModelThrottledError(message)

      expect(error.message).toBe(message)
    })

    it('has the correct error name', () => {
      const error = new ModelThrottledError('test')

      expect(error.name).toBe('ModelThrottledError')
    })

    it('is an instance of Error', () => {
      const error = new ModelThrottledError('test')

      expect(error).toBeInstanceOf(Error)
    })

    it('is an instance of ModelError', () => {
      const error = new ModelThrottledError('test')

      expect(error).toBeInstanceOf(ModelError)
    })
  })

  describe('when instantiated with a cause', () => {
    it('preserves the original error as cause', () => {
      const originalError = new Error('Original rate limit error')
      const error = new ModelThrottledError('Rate limit exceeded', { cause: originalError })

      expect(error.cause).toBe(originalError)
    })

    it('has undefined cause when not provided', () => {
      const error = new ModelThrottledError('Rate limit exceeded')

      expect(error.cause).toBeUndefined()
    })
  })
})

describe('normalizeError', () => {
  describe('when given an Error instance', () => {
    it('returns the same Error instance', () => {
      const error = new Error('test error')
      const result = normalizeError(error)

      expect(result).toBe(error)
    })
  })

  describe('when given a string', () => {
    it('wraps it in an Error', () => {
      const result = normalizeError('test error')

      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('test error')
    })
  })

  describe('when given a number', () => {
    it('converts it to string and wraps in Error', () => {
      const result = normalizeError(42)

      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('42')
    })
  })

  describe('when given an object', () => {
    it('converts it to string and wraps in Error', () => {
      const result = normalizeError({ code: 'ERR_TEST' })

      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('[object Object]')
    })
  })

  describe('when given null', () => {
    it('converts it to string and wraps in Error', () => {
      const result = normalizeError(null)

      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('null')
    })
  })

  describe('when given undefined', () => {
    it('converts it to string and wraps in Error', () => {
      const result = normalizeError(undefined)

      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('undefined')
    })
  })
})
