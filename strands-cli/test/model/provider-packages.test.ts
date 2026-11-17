import { describe, expect, it } from 'vitest'

import { rethrowWithProviderHint } from '../../src/model/packages.js'

describe('provider packages', () => {
  it('rewrites a missing provider package error into a CLI reinstall hint', () => {
    const original = new Error("Cannot find package '@anthropic-ai/sdk' imported from /app/node_modules")
    expect(() => rethrowWithProviderHint(original)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Reinstall @strands-agents/cli'),
        cause: original,
      })
    )
  })

  it('rethrows unrelated errors untouched', () => {
    const original = new Error("Cannot find module './missing-local-file.js'")
    expect(() => rethrowWithProviderHint(original)).toThrow(original)
  })
})
