import { describe, it, expect } from 'vitest'
import { resolveLanguage, languageLabel, sourceLinkUrl } from '../src/util/source-links'

describe('resolveLanguage', () => {
  it('infers python from a .py extension', () => {
    expect(resolveLanguage({ path: 'strands-py/src/strands/agent/agent.py', repo: 'harness-sdk' })).toBe('python')
  })

  it('infers typescript from .ts and .tsx extensions', () => {
    expect(resolveLanguage({ path: 'strands-ts/src/agent/agent.ts', repo: 'harness-sdk' })).toBe('typescript')
    expect(resolveLanguage({ path: 'strands-ts/src/component.tsx', repo: 'harness-sdk' })).toBe('typescript')
  })

  it('prefers an explicit language over the inferred extension', () => {
    expect(resolveLanguage({ path: 'configs/agent.toml', language: 'python', repo: 'harness-sdk' })).toBe('python')
    // Even when the extension is known, the override wins.
    expect(resolveLanguage({ path: 'snippet.ts', language: 'python', repo: 'harness-sdk' })).toBe('python')
  })

  it('throws for an unmapped extension with no explicit language', () => {
    expect(() => resolveLanguage({ path: 'configs/agent.toml', repo: 'harness-sdk' })).toThrow(
      /unrecognized file extension/
    )
  })

  it('throws for a path with no extension and no explicit language', () => {
    expect(() => resolveLanguage({ path: 'Makefile', repo: 'harness-sdk' })).toThrow(/unrecognized file extension/)
  })
})

describe('languageLabel', () => {
  it('maps known codes to their display label', () => {
    expect(languageLabel('python')).toBe('Python')
    expect(languageLabel('typescript')).toBe('TypeScript')
  })

  it('capitalizes unknown codes as a fallback', () => {
    expect(languageLabel('rust')).toBe('Rust')
  })
})

describe('sourceLinkUrl', () => {
  it('builds a GitHub blob URL from repo and path', () => {
    expect(sourceLinkUrl({ path: 'strands-py/src/strands/agent/agent.py', repo: 'harness-sdk' })).toBe(
      'https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py'
    )
  })

  it('respects a custom repo override', () => {
    expect(sourceLinkUrl({ path: 'src/tool.py', repo: 'tools' })).toBe(
      'https://github.com/strands-agents/tools/blob/main/src/tool.py'
    )
  })
})
