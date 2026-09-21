import { describe, expect, it } from 'vitest'

import { missingProviderPackage, rethrowWithProviderHint } from '../src/tui/provider/packages.js'

describe('provider packages', () => {
  it('treats bedrock as dependency-free', () => {
    expect(missingProviderPackage('bedrock')).toBeUndefined()
  })

  it('reports provider SDKs installed in the workspace as available', () => {
    expect(missingProviderPackage('anthropic')).toBeUndefined()
    expect(missingProviderPackage('openai')).toBeUndefined()
    expect(missingProviderPackage('google')).toBeUndefined()
  })

  it('rewrites a missing provider package error into an install hint', () => {
    const original = new Error("Cannot find package '@anthropic-ai/sdk' imported from /app/node_modules")
    expect(() => rethrowWithProviderHint(original)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('npm install -g @anthropic-ai/sdk'),
        cause: original,
      })
    )
  })

  it('rethrows unrelated errors untouched', () => {
    const original = new Error("Cannot find module './missing-local-file.js'")
    expect(() => rethrowWithProviderHint(original)).toThrow(original)
  })
})
