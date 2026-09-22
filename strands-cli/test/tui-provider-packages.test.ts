import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolvePackage } = vi.hoisted(() => ({
  resolvePackage: vi.fn<(name: string) => string>(),
}))

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: resolvePackage }),
}))

import {
  missingProviderPackage,
  refreshProviderPackages,
  rethrowWithProviderHint,
} from '../src/tui/provider/packages.js'

describe('provider packages', () => {
  beforeEach(() => {
    refreshProviderPackages()
    resolvePackage.mockReset().mockImplementation((name) => `/node_modules/${name}`)
  })

  it('treats bedrock as dependency-free', () => {
    expect(missingProviderPackage('bedrock')).toBeUndefined()
  })

  it('reports provider SDKs installed in the workspace as available', () => {
    expect(missingProviderPackage('anthropic')).toBeUndefined()
    expect(missingProviderPackage('openai')).toBeUndefined()
    expect(missingProviderPackage('google')).toBeUndefined()
  })

  it('rechecks a missing provider SDK after refresh', () => {
    resolvePackage.mockImplementation(() => {
      throw new Error('missing')
    })
    expect(missingProviderPackage('bedrock-mantle')).toBe('openai')

    resolvePackage.mockReturnValue('/node_modules/openai')
    expect(missingProviderPackage('bedrock-mantle')).toBe('openai')

    refreshProviderPackages()
    expect(missingProviderPackage('bedrock-mantle')).toBeUndefined()
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
