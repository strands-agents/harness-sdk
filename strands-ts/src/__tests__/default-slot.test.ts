import { describe, expect, it } from 'vitest'
import { createDefaultSlot } from '../default-slot.js'
import { DefaultNotConfiguredError } from '../errors.js'

describe('createDefaultSlot', () => {
  it('throws DefaultNotConfiguredError when read before configured', () => {
    const slot = createDefaultSlot<string>('not set')
    expect(() => slot.get()).toThrow(DefaultNotConfiguredError)
    expect(() => slot.get()).toThrow('not set')
  })

  it('returns the configured value after set', () => {
    const slot = createDefaultSlot<string>('not set')
    slot.set('value')
    expect(slot.get()).toBe('value')
  })

  it('stores falsy values that the sentinel must not confuse with unset', () => {
    const numbers = createDefaultSlot<number>('no number')
    numbers.set(0)
    expect(numbers.get()).toBe(0)

    const nullable = createDefaultSlot<string | null>('no value')
    nullable.set(null)
    expect(nullable.get()).toBeNull()

    const maybe = createDefaultSlot<string | undefined>('no value')
    maybe.set(undefined)
    expect(maybe.get()).toBeUndefined()
  })

  it('overwrites on a subsequent set', () => {
    const slot = createDefaultSlot<string>('not set')
    slot.set('first')
    slot.set('second')
    expect(slot.get()).toBe('second')
  })
})
