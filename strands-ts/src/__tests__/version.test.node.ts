import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SDK_VERSION } from '../version.js'

describe('SDK_VERSION', () => {
  it('matches the package.json version', () => {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(SDK_VERSION).toBe(version)
  })
})
