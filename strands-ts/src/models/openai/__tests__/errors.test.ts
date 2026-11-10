import { describe, it, expect } from 'vitest'
import { classifyOpenAIError } from '../errors.js'

describe('classifyOpenAIError', () => {
  it.each([
    'maximum context length exceeded',
    'context_length_exceeded',
    'too many tokens',
    'context length',
    'Input is too long for requested model',
    'input length and `max_tokens` exceed context limit',
    'too many total text bytes',
    'prompt tokens (320666) exceed customer model maximum (278528) for model-id',
  ])('classifies overflow phrase %p as contextOverflow', (phrase) => {
    expect(classifyOpenAIError(new Error(phrase))).toBe('contextOverflow')
  })

  it('matches overflow phrases case-insensitively', () => {
    expect(classifyOpenAIError(new Error('MAXIMUM CONTEXT LENGTH EXCEEDED'))).toBe('contextOverflow')
  })

  it('classifies a structured context_length_exceeded code as contextOverflow', () => {
    const err = Object.assign(new Error('something opaque'), { code: 'context_length_exceeded' })
    expect(classifyOpenAIError(err)).toBe('contextOverflow')
  })

  it('matches structured codes case-insensitively', () => {
    const err = Object.assign(new Error('something opaque'), { code: 'Context_Length_Exceeded' })
    expect(classifyOpenAIError(err)).toBe('contextOverflow')
  })

  it('returns undefined for unrelated errors', () => {
    expect(classifyOpenAIError(new Error('a totally unrelated failure'))).toBeUndefined()
  })

  it('handles numeric error codes without throwing', () => {
    const err = Object.assign(new Error('some error'), { code: 400 })
    expect(() => classifyOpenAIError(err as any)).not.toThrow()
    expect(classifyOpenAIError(err as any)).toBeUndefined()
  })

  it('handles null error code without throwing', () => {
    const err = Object.assign(new Error('some error'), { code: null })
    expect(() => classifyOpenAIError(err as any)).not.toThrow()
  })
})
