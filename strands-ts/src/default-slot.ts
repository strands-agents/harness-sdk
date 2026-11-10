import { DefaultNotConfiguredError } from './errors.js'

export interface DefaultSlot<T> {
  set(value: T): void
  get(): T
}

export function createDefaultSlot<T>(errorMessage: string): DefaultSlot<T> {
  // A unique sentinel for "unset" so any value of T -- including undefined or
  // null -- can be stored and read back without colliding with the empty state.
  const EMPTY = Symbol('empty')
  let value: T | typeof EMPTY = EMPTY
  return {
    set(v): void {
      value = v
    },
    get(): T {
      if (value === EMPTY) throw new DefaultNotConfiguredError(errorMessage)
      return value
    },
  }
}
