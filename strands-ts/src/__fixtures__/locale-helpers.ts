/**
 * Test helpers for asserting that model-facing text does not depend on the host locale.
 */

import { vi } from 'vitest'

/**
 * Runs `fn` as if the host's default locale were `locale`, so a `toLocaleString()` call that omits
 * an explicit locale formats with it (e.g. `'en-IN'` groups 100000 as `1,00,000`).
 */
export async function withDefaultLocale<T>(locale: string, fn: () => T | Promise<T>): Promise<T> {
  const original = Number.prototype.toLocaleString
  const spy = vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions
  ) {
    return original.call(this, locales ?? locale, options)
  })
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}
